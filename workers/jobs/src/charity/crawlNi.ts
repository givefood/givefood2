import type { Env } from "../../worker-configuration";
import { patchFoodbankCharity, type CharityCrawlFoodbankRow, type Session } from "@givefood/db";

// crawlers.py:230-278 _crawl_charity_ni() -- one GET, CSV response, no API
// key. Structurally ported from source. VERIFIED LIVE 2026-09-02: this
// endpoint currently returns 404 for a real NI food bank's charity number
// (both via curl and Python `requests`, so it isn't a client-fingerprint
// block) -- the URL/params this function builds may have drifted from
// what the live API now expects. That is an EXTERNAL, pre-existing
// problem: crawlers.py's own `if response.status_code == 200:` guard means
// production's current Django cron is *already* silently getting nothing
// from this endpoint too, so porting the request exactly (rather than
// guessing at a new shape) is not a regression -- see the opencharities.uk
// ticket (givefood/givefood2#1) for the same "flag, don't silently
// reverse-engineer" treatment.
//
// No CharityYear handling at all -- Django's _crawl_charity_ni doesn't
// touch CharityYear (Northern Ireland's regulator export carries no
// financial-history rows).
const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

// Minimal RFC4180-ish CSV row parser -- quoted fields (embedded commas,
// "" for a literal quote) only, no header inference. Django reads exactly
// two rows (`next(csv_input)` twice: headers, then the first data row) via
// Python's `csv.reader`; this caps at the same two for the same reason.
function parseCsvRows(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length && rows.length < maxRows) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function crawlCharityNi(env: Env, session: Session, foodbank: CharityCrawlFoodbankRow): Promise<void> {
  const regId = foodbank.charity_number.replace("NIC", ""); // crawlers.py:236's literal .replace, not a prefix-strip
  const patch: Record<string, string | null> = {};

  try {
    const res = await fetch(
      `https://www.charitycommissionni.org.uk/umbraco/api/CharityApi/ExportDetailsToCsv?regid=${regId}&subid=0`,
      { headers: { "User-Agent": BOT_USER_AGENT }, signal: AbortSignal.timeout(20_000) },
    );
    if (res.ok) {
      const rows = parseCsvRows(await res.text(), 2);
      const [csvHeaders, dataRow] = rows;
      if (csvHeaders && dataRow) {
        const data: Record<string, string | undefined> = {};
        csvHeaders.forEach((header, i) => (data[header] = dataRow[i]));

        patch.charity_name = data["Charity name"] ?? null;
        patch.charity_reg_date = data["Date registered"] ?? null;
        patch.charity_website = data["Website"] ?? null;
        // crawlers.py:265-266: "Objectives and purposes are reversed in NI"
        // -- charity_objectives comes from the CSV's "Charitable purposes"
        // column, not the other way round. Reproduced exactly, not fixed.
        patch.charity_objectives = data["Charitable purposes"] ?? null;
        const objectives = data["What the charity does"];
        // crawlers.py:269's `re.sub(r",(?!\s)", "\n", objectives)` --
        // a comma NOT followed by whitespace becomes a newline.
        patch.charity_purpose = objectives ? objectives.replace(/,(?!\s)/g, "\n") : null;
      }
    }
  } catch (err) {
    console.error(`charity-ni: CSV fetch failed for ${foodbank.slug}`, err);
  }

  const now = new Date().toISOString();
  await patchFoodbankCharity(session, foodbank.id, patch, now);
}
