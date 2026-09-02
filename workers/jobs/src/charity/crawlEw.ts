import type { Env } from "../../worker-configuration";
import { patchFoodbankCharity, replaceCharityYears, type CharityCrawlFoodbankRow, type Session } from "@givefood/db";

// crawlers.py:104-169 _crawl_charity_ew() -- three sequential GETs against
// the Charity Commission's own API. Structurally ported from source;
// UNVERIFIED against a live authenticated response (EW_CHARITY_KEY is a
// real production secret this session has no access to -- .dev.vars only
// carries a placeholder value). Every field assignment below mirrors a
// `foodbank.charity_X = data[...]` line that only runs inside Django's own
// `if response.status_code == 200:` guard -- reproduced as "patch only
// what this fetch actually returned", never nulling a field a failed
// sub-request didn't touch (see patchFoodbankCharity's own comment).
const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

interface AllCharityDetailsV2 {
  organisation_number?: string | number;
  charity_name?: string;
  charity_type?: string;
  date_of_registration?: string;
  address_post_code?: string;
  web?: string;
  who_what_where?: { classification_type?: string; classification_desc?: string }[];
}

interface CharityOverview {
  activities?: string;
}

interface CharityFinancialHistoryEntry {
  financial_period_end_date?: string;
  income?: number;
  expenditure?: number;
}

export async function crawlCharityEw(env: Env, session: Session, foodbank: CharityCrawlFoodbankRow): Promise<void> {
  const headers = {
    "Cache-Control": "no-cache",
    "Ocp-Apim-Subscription-Key": env.EW_CHARITY_KEY,
    "User-Agent": BOT_USER_AGENT,
  };
  const patch: Record<string, string | null> = {};

  try {
    const res = await fetch(`https://api.charitycommission.gov.uk/register/api/allcharitydetailsV2/${foodbank.charity_number}/0`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const data = (await res.json()) as AllCharityDetailsV2;
      if (data) {
        patch.charity_id = data.organisation_number != null ? String(data.organisation_number) : null;
        patch.charity_name = data.charity_name ?? null;
        patch.charity_type = data.charity_type ?? null;
        patch.charity_reg_date = data.date_of_registration ? data.date_of_registration.replace("T00:00:00", "") : null;
        patch.charity_postcode = data.address_post_code ?? null;
        patch.charity_website = data.web ?? null;
        // crawlers.py:136-138's loop, building a newline-joined purpose
        // string from the "What" classification entries.
        let purpose = "";
        for (const item of data.who_what_where ?? []) {
          if (item.classification_type === "What") purpose += `${item.classification_desc}\n`;
        }
        patch.charity_purpose = purpose;
      }
    }
  } catch (err) {
    console.error(`charity-ew: allcharitydetailsV2 fetch failed for ${foodbank.slug}`, err);
  }

  try {
    const res = await fetch(`https://api.charitycommission.gov.uk/register/api/charityoverview/${foodbank.charity_number}/0`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const data = (await res.json()) as CharityOverview;
      if (data) patch.charity_objectives = data.activities ?? null;
    }
  } catch (err) {
    console.error(`charity-ew: charityoverview fetch failed for ${foodbank.slug}`, err);
  }

  const now = new Date().toISOString();
  await patchFoodbankCharity(session, foodbank.id, patch, now);

  // PLAN.md §8.7.1's fix: fetch first, only replace CharityYear rows once
  // the new set is actually in hand -- never delete on a failed fetch
  // (Django's crawlers.py:147 deletes unconditionally, before the fetch,
  // which is the bug this fixes).
  try {
    const res = await fetch(`https://api.charitycommission.gov.uk/register/api/charityfinancialhistory/${foodbank.charity_number}/0`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const data = (await res.json()) as CharityFinancialHistoryEntry[];
      if (Array.isArray(data)) {
        const years = data.map((y) => ({
          date: y.financial_period_end_date ? y.financial_period_end_date.replace("T00:00:00", "") : "",
          income: y.income ?? 0,
          expenditure: y.expenditure ?? 0,
        }));
        await replaceCharityYears(session, foodbank.id, years);
      }
    }
  } catch (err) {
    console.error(`charity-ew: charityfinancialhistory fetch failed for ${foodbank.slug}`, err);
  }
}
