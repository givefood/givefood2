import type { Context } from "hono";
import { getArticlesByFoodbankId, getFoodbankBySlug } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../../types";
import { dbSession } from "../../../lib/session";
import { CHARITY_DETAIL_COUNTRIES, fullNameFoodbank, titleCapitalised } from "../../../lib/fields";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Django's `jS F Y` format (ordinal day, full month, year) -- djangoDate's
// token table (packages/templates/src/filters.ts) only covers Y/m/d/j/M/P,
// not S/F, so this single call site formats it directly rather than
// extending a shared filter for one use.
// Exported so the HTML twin (../newsCharity.ts) can reuse this exact logic
// rather than reimplementing it.
export function formatCharityRegDate(value: string): string {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  const day = date.getUTCDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// Foodbank.charity_purpose_list() (givefood/models/foodbank.py:410-414) --
// Python's str.splitlines(): a single trailing line terminator does NOT
// produce a trailing empty element (unlike JS's plain .split(), which
// would turn "a\nb\n" into ["a","b",""], rendering a spurious empty
// bullet); an internal blank line still does. Only the trailing
// terminator needs stripping first -- charity_purpose is only ever passed
// here when truthy (see the call site), so the empty-string case never
// reaches this function.
export function pythonSplitlines(text: string): string[] {
  return text.replace(/\r\n$|\r$|\n$/, "").split(/\r\n|\r|\n/);
}

// Foodbank.open_charities_url() (givefood/models/foodbank.py:339-348) --
// NOT the same target as fields.ts's charityRegisterUrl (that ports
// charity_register_url(), the official register): opencharities.uk is a
// separate third-party aggregator this one /md/ template links to. No
// Isle of Man branch -- Django's own method has none either, and it's
// moot here since CHARITY_DETAIL_COUNTRIES already excludes that country.
export function openCharitiesUrl(charityNumber: string | null, country: string): string | null {
  if (!charityNumber) return null;
  if (country === "Scotland") return `https://opencharities.uk/sc/${charityNumber}`;
  if (country === "Northern Ireland") return `https://opencharities.uk/ni/${charityNumber.replace(/NIC/g, "")}`;
  if (country === "Wales" || country === "England") return `https://opencharities.uk/ew/${charityNumber}`;
  return null;
}

// gfwfbn `md_foodbank_news` (GET /md/needs/at/<slug>/news/, untranslated --
// outside i18n_patterns). Ported from gfwfbn/views.py's md_foodbank_news.
export async function mdFoodbankNews(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (!foodbank.rss_url && !foodbank.news_url) return c.notFound();

  const rawArticles = await getArticlesByFoodbankId(session, foodbank.id, 20);
  const articles = rawArticles.map((a) => ({ ...a, title_captialised: titleCapitalised(a.title) }));

  const html = await render("wfbn/foodbank/md/news.njk", {
    foodbank,
    full_name: fullNameFoodbank(foodbank.name),
    articles,
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

// gfwfbn `md_foodbank_charity` (GET /md/needs/at/<slug>/charity/,
// untranslated). Ported from gfwfbn/views.py's md_foodbank_charity.
export async function mdFoodbankCharity(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (!foodbank.charity_name || !CHARITY_DETAIL_COUNTRIES.has(foodbank.country)) return c.notFound();

  const charityPurposeList = foodbank.charity_purpose ? pythonSplitlines(foodbank.charity_purpose) : [];

  const html = await render("wfbn/foodbank/md/charity.njk", {
    foodbank,
    full_name: fullNameFoodbank(foodbank.name),
    open_charities_url: openCharitiesUrl(foodbank.charity_number, foodbank.country),
    charity_reg_date: foodbank.charity_reg_date ? formatCharityRegDate(foodbank.charity_reg_date) : null,
    charity_purpose_list: charityPurposeList,
    // No `charityyear` table in D1 yet (packages/db/migrations/*.sql) --
    // the Income & Expenditure section is permanently absent until a
    // future migration adds one; a known, deliberate gap, not a bug.
    charity_years: [],
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
