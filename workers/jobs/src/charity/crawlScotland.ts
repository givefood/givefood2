import type { Env } from "../../worker-configuration";
import { patchFoodbankCharity, replaceCharityYears, type CharityCrawlFoodbankRow, type Session } from "@givefood/db";

// crawlers.py:172-227 _crawl_charity_scotland() -- two sequential GETs
// against OSCR's own API. Structurally ported from source; UNVERIFIED
// against a live authenticated response (SCOT_CHARITY_KEY is a real
// production secret this session has no access to). Note charity_type is
// never set here at all -- Django's own function has no such assignment
// for Scotland, only for England/Wales.
const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

interface AllCharitiesResponse {
  id?: string | number;
  charityName?: string;
  registeredDate?: string;
  postcode?: string;
  website?: string;
  purposes?: string[];
  objectives?: string;
}

interface AnnualReturnEntry {
  AccountingReferenceDate?: string;
  GrossIncome?: number;
  GrossExpenditure?: number;
}

export async function crawlCharityScotland(env: Env, session: Session, foodbank: CharityCrawlFoodbankRow): Promise<void> {
  const headers = { "x-functions-key": env.SCOT_CHARITY_KEY, "User-Agent": BOT_USER_AGENT };
  const patch: Record<string, string | null> = {};
  // crawlers.py:207 builds the second URL from `foodbank.charity_id` --
  // the in-memory attribute, which keeps its EXISTING D1 value if the
  // first fetch below fails to refresh it (not simply "skip the second
  // call"). Starts from the value already on the row for exactly that
  // reason.
  let charityId: string | null = foodbank.charity_id;

  try {
    const res = await fetch(`https://oscrapi.azurewebsites.net/api/all_charities/?charitynumber=${foodbank.charity_number}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const data = (await res.json()) as AllCharitiesResponse;
      if (data) {
        charityId = data.id != null ? String(data.id) : null;
        patch.charity_id = charityId;
        patch.charity_name = data.charityName ?? null;
        patch.charity_reg_date = data.registeredDate ?? null;
        patch.charity_postcode = data.postcode ?? null;
        patch.charity_website = data.website ?? null;
        // crawlers.py:201-203's loop, joining purposes with newlines.
        let purpose = "";
        for (const item of data.purposes ?? []) purpose += `${item}\n`;
        patch.charity_purpose = purpose;
        patch.charity_objectives = data.objectives ?? null;
      }
    }
  } catch (err) {
    console.error(`charity-scotland: all_charities fetch failed for ${foodbank.slug}`, err);
  }

  const now = new Date().toISOString();
  await patchFoodbankCharity(session, foodbank.id, patch, now);

  if (charityId) {
    // Same fetch-first-then-replace-atomically fix as EW (§8.7.1).
    try {
      const res = await fetch(`https://oscrapi.azurewebsites.net/api/annualreturns?charityid=${charityId}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const data = (await res.json()) as AnnualReturnEntry[];
        if (Array.isArray(data)) {
          const years = data.map((y) => ({
            date: y.AccountingReferenceDate ?? "",
            income: y.GrossIncome ?? 0,
            expenditure: y.GrossExpenditure ?? 0,
          }));
          await replaceCharityYears(session, foodbank.id, years);
        }
      }
    } catch (err) {
      console.error(`charity-scotland: annualreturns fetch failed for ${foodbank.slug}`, err);
    }
  }
}
