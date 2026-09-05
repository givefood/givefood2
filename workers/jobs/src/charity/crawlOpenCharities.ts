import { patchFoodbankCharity, replaceCharityYears, type CharityCrawlFoodbankRow, type Session } from "@givefood/db";
import type { Env } from "../../worker-configuration";
import { pyNow } from "@givefood/models";

// ONE crawler for all three UK charity regulators, via opencharities.uk.
// Replaces crawlEw.ts / crawlScotland.ts / crawlNi.ts, which called
// api.charitycommission.gov.uk (3 GETs, keyed), oscrapi.azurewebsites.net
// (2 GETs, keyed) and charitycommissionni.org.uk (1 GET, CSV) respectively
// -- crawlers.py:79-278's structure. givefood/givefood2#1, maintainer
// decision 2026-09-05.
//
// The endpoint is `https://opencharities.uk/{ew|sc|ni}/{number}.json`.
// One GET, no API key, one response shape for all three registers. Daily
// call volume across 831 food banks with a charity number goes from ~2,354
// requests over three hosts to 831 over one.
//
// TWO SECRETS GO WITH THE OLD CRAWLERS: EW_CHARITY_KEY and
// SCOT_CHARITY_KEY are no longer referenced anywhere and are dropped from
// wrangler.jsonc's secrets.required.
//
// IT IS A MIRROR, NOT THE REGISTER. opencharities.uk says so itself --
// "not affiliated with any regulator", official registers remain
// authoritative. That is the real cost here: one small independent site is
// now a single point of failure for every country's charity data, where an
// OSCR outage used to cost Scotland alone. Accepted because this is a daily
// cron writing fields that are already days old, and because of what it
// fixes -- see NORTHERN IRELAND below.
//
// VERIFIED BEFORE SWITCHING. 80 real food banks, 20 per country, every
// field this function writes computed exactly as below and diffed against
// what the live regulator APIs had already put in D1. 78 fetched, 2 404'd.
//
// NOT ONE FIELD THAT HAS A VALUE TODAY COMES BACK EMPTY. Every difference
// is a match, a wording update, or a field we did not have at all:
//
//   England/Wales  name, postcode, reg_date, type, purpose match 40/40;
//                  website 34/40 with the rest empty both sides;
//                  objectives 31/40, the remainder reworded not blanked.
//   Scotland       name, postcode, website match. reg_date and type were
//                  EMPTY in D1 for 19/20 and are populated here.
//                  purpose/objectives differ in FORMAT only -- OSCR's
//                  arrays arrive comma-joined, see toLines().
//   N. Ireland     postcode empty in D1 for 19/20, populated here.
//                  financial_years for 19/20 where Django produced none.
//                  reg_date differs because ours carries a
//                  "00:00:00.000000" suffix and theirs is clean ISO.
//
// The 2 misses are the same shape the old crawlers had -- a charity number
// that has moved or been removed -- and are handled the same way: log,
// patch nothing, do not throw.
//
// NORTHERN IRELAND IS WHY THIS IS WORTH DOING AT ALL, beyond tidiness.
// crawlNi.ts recorded that the regulator's CSV endpoint returns 404 for a
// real NI food bank's charity number -- verified live 2026-09-02 -- and
// that Django's own `if response.status_code == 200:` guard means
// production has been silently getting nothing from it too. So NI charity
// data has been quietly stale in both systems. It works here.
//
// NI ALSO GAINS FINANCIAL HISTORY. _crawl_charity_ni never touched
// CharityYear, because the regulator's export carries no financial rows.
// `financial_years` is uniform across all three registers, so CharityYear
// handling stops being per-country.

const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

// crawlers.py:89-99's country branch. Isle of Man (1 food bank) matches no
// branch there and gets nothing; opencharities has no Manx register either,
// so it is unchanged rather than newly broken.
const COUNTRY_CODE: Record<string, "ew" | "sc" | "ni"> = {
  England: "ew",
  Wales: "ew",
  Scotland: "sc",
  "Northern Ireland": "ni",
};

interface FinancialYear {
  end?: string | null;
  income?: number | null;
  expenditure?: number | null;
}

interface OpenCharity {
  name?: string | null;
  legal_form?: string | null;
  date_registered?: string | null;
  postcode?: string | null;
  website?: string | null;
  activities?: string | null;
  objectives?: string | null;
  purposes?: string | null;
  what_charity_does?: string | null;
  classifications?: { type?: string; description?: string }[] | null;
  financial_years?: FinancialYear[] | null;
}

// The NI register lets a charity file the literal string "n/a" as its
// website, and opencharities passes it through faithfully. Django never saw
// it, because crawlNi.ts's endpoint has been 404ing. Writing it into
// charity_website would render a link to https://n/a on the food bank page,
// so it is treated as absent -- along with the other placeholders that turn
// up in free-text register fields.
const WEBSITE_PLACEHOLDERS = new Set(["n/a", "na", "none", "-", "tbc", "no website"]);

function websiteOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || WEBSITE_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

// Django stored both of these as newline-separated lists. opencharities
// returns the same items comma-separated -- Scotland as `'a','b','c'`
// (OSCR's own array, quoted), Northern Ireland as bare `a,b,c`. Splitting
// on the comma that follows a closing quote, or on a bare comma when there
// are no quotes, reproduces the stored shape.
//
// One deliberate loss: OSCR labels each purpose with a letter ("A - the
// prevention or relief of poverty") and opencharities drops the prefix, so
// Scottish charity_purpose keeps the text and loses the code. Nothing
// renders the code.
function toLines(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const quoted = trimmed.startsWith("'") && trimmed.includes("','");
  const parts = quoted ? trimmed.split("','") : trimmed.split(",");
  return parts.map((p) => p.replace(/^'|'$/g, "").trim()).filter(Boolean).join("\n");
}

// WHICH FIELD HOLDS WHAT DIFFERS BY REGISTER, because the registers
// themselves publish different things and opencharities passes that
// through rather than flattening it. These two maps are what each old
// crawler took from its own regulator, pointed at where opencharities puts
// it:
//
//   purpose     EW  the "What" classifications  (crawlers.py:136-138)
//               SC  OSCR's purposes array       (crawlers.py:201-203)
//               NI  the CSV's purposes text     (crawlers.py:270)
//   objectives  EW  charityoverview.activities  (crawlers.py:145)
//               SC  OSCR's objectives           (crawlers.py:204)
//               NI  the CSV's "Charitable purposes" (crawlers.py:266)
//
// A single fallback chain would be shorter and wrong: Scotland and NI both
// populate `purposes`, but it means the categorised list in one and the
// objects text in the other.
function purposeFor(cc: "ew" | "sc" | "ni", data: OpenCharity): string | null {
  if (cc === "ew") {
    const lines = (data.classifications ?? [])
      .filter((c) => c.type === "What")
      .map((c) => c.description ?? "")
      .filter(Boolean);
    // Django appended a trailing newline per item; keep the shape.
    return lines.length ? `${lines.join("\n")}\n` : "";
  }
  return toLines(cc === "sc" ? data.purposes : data.what_charity_does);
}

function objectivesFor(cc: "ew" | "sc" | "ni", data: OpenCharity): string | null {
  if (cc === "ew") return data.activities ?? null;
  if (cc === "sc") return data.objectives ?? null;
  return data.purposes ?? null;
}

export async function crawlOpenCharities(env: Env, session: Session, foodbank: CharityCrawlFoodbankRow): Promise<void> {
  const cc = COUNTRY_CODE[foodbank.country ?? ""];
  if (!cc) {
    console.log(`charity: no register for country ${foodbank.country} (${foodbank.slug})`);
    return;
  }

  // Foodbank.open_charities_url() (givefood/models/foodbank.py:339-347)
  // strips the "NIC" prefix for Northern Ireland; the register's own
  // numbers have no prefix.
  const number = cc === "ni" ? (foodbank.charity_number ?? "").replace("NIC", "") : foodbank.charity_number;

  let data: OpenCharity | null = null;
  try {
    const res = await fetch(`https://opencharities.uk/${cc}/${encodeURIComponent(number ?? "")}.json`, {
      headers: { "User-Agent": BOT_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    // Same as every old crawler's `if response.status_code == 200:` guard:
    // anything else patches nothing rather than nulling fields. Never
    // throws for an external failure -- queues/charity.ts's own comment
    // depends on that, and a 404 for a charity number that has moved is
    // not a retryable condition.
    if (res.ok) data = (await res.json()) as OpenCharity;
    else console.log(`charity: opencharities ${res.status} for ${foodbank.slug} (${cc}/${number})`);
  } catch (err) {
    console.error(`charity: opencharities fetch failed for ${foodbank.slug}`, err);
  }

  if (!data) return;

  // charity_id is DELIBERATELY NOT PATCHED. It used to hold E&W's
  // `organisation_number` and OSCR's `id` -- two different registers' own
  // internal identifiers, whose only real job was building the second OSCR
  // request. There is no second request now, and opencharities publishes
  // neither. Writing the charity number into it would silently change what
  // the column means; leaving it alone keeps whatever the last regulator
  // crawl put there.
  const patch: Record<string, string | null> = {
    charity_name: data.name ?? null,
    charity_type: data.legal_form ?? null,
    charity_reg_date: data.date_registered ?? null,
    charity_postcode: data.postcode ?? null,
    charity_website: websiteOrNull(data.website),
    charity_purpose: purposeFor(cc, data),
    charity_objectives: objectivesFor(cc, data),
  };

  await patchFoodbankCharity(session, foodbank.id, patch, pyNow());

  // PLAN.md §8.7.1's fix, unchanged: the rows are in hand before the old
  // ones are replaced, so a failed fetch never empties the table (Django's
  // crawlers.py:147/207 delete first).
  const years = (data.financial_years ?? [])
    .filter((y) => y.end)
    .map((y) => ({ date: y.end!, income: y.income ?? 0, expenditure: y.expenditure ?? 0 }));
  if (years.length) await replaceCharityYears(session, foodbank.id, years);
}
