// Ports of computed Foodbank/FoodbankLocation/FoodbankDonationPoint/
// FoodbankChange model methods the API views read, taken verbatim from
// givefood/models/foodbank.py and needs.py (read directly, not
// paraphrased) and givefood/const/general.py for the two constant lists.
// full_name()/full_name_en() are ported English-only: the JSON API has no
// language prefix and always serves English (see resolveLanguage.ts) --
// the cy-locale branch in the Django source is unreachable here.

const DONT_APPEND_FOOD_BANK = [
  "Salvation Army",
  "Oxford Food Hub",
  "Staffordshire Food and Furniture Bank",
  "The Shack Food Project",
  "Family Food Bank",
  "Adat Yeshua Foodbank",
  "New Hope Food Bank",
  "Felix Multibank",
  "Soar Valley Community Food Project",
];

const QUERYSTRING_RUBBISH = ["utm_source", "utm_medium", "utm_campaign", "y_source", "sc_cmp", "extcam", "utm_content"];

// Countries whose charity register wfbn/foodbank/includes/charitynetwork.njk
// can link to (has_charity_details) -- shared by every route that includes
// that same partial (foodbank.ts, nearby.ts, updates.ts) rather than each
// keeping its own copy.
export const CHARITY_DETAIL_COUNTRIES = new Set(["England", "Wales", "Scotland", "Northern Ireland"]);

export function fullNameFoodbank(name: string): string {
  if (DONT_APPEND_FOOD_BANK.includes(name)) return name;
  return `${name} Foodbank`;
}

export function fullNameLocation(locationName: string, foodbankName: string): string {
  return `${locationName}, ${fullNameFoodbank(foodbankName)}`;
}

// "Foodbank" translated, matching the cy/gd .po catalogues' own msgstr for
// this exact msgid -- hardcoded rather than threading async catalogue
// access into what's otherwise a synchronous helper (only 2 of the 4
// supported locales need this word at all; en/ga both use the English
// suffix form below).
const FOODBANK_WORD: Record<"cy" | "gd", string> = { cy: "Banc Bwyd", gd: "Banca-bìdh" };

// Foodbank.full_name()/full_name_en() -- locale-aware, unlike
// fullNameFoodbank() above (which is the JSON API's English-only version).
// cy with a set alt_name returns alt_name verbatim, no suffix/prefix at
// all; cy/gd otherwise prefix the translated word; every other locale
// (including cy without an alt_name) appends "Foodbank" in English.
export function fullNameLocaleAware(name: string, altName: string | null, locale: "en" | "cy" | "ga" | "gd"): string {
  if (locale === "cy" && altName) return altName;
  if (DONT_APPEND_FOOD_BANK.includes(name)) return name;
  if (locale === "cy" || locale === "gd") return `${FOODBANK_WORD[locale]} ${name}`;
  return `${name} Foodbank`;
}

// Foodbank.full_address() / FoodbankDonationPoint.full_address() -- both
// unconditional, no null-guard (their address/postcode columns are
// effectively always present).
export function fullAddressUnconditional(address: string, postcode: string): string {
  return `${address}\r\n${postcode}`;
}

// FoodbankLocation.full_address() -- nullable address/postcode, so it
// branches instead of assuming both are present.
export function fullAddressNullable(address: string | null, postcode: string | null): string {
  if (address && postcode) return `${address}\r\n${postcode}`;
  if (address) return address;
  if (postcode) return postcode;
  return "";
}

export function phoneOrFoodbankPhone(ownPhone: string | null, foodbankPhone: string | null): string | null {
  return ownPhone || foodbankPhone;
}

export function emailOrFoodbankEmail(ownEmail: string | null, foodbankEmail: string): string {
  return ownEmail || foodbankEmail;
}

// Foodbank.charity_register_url() -- None if no charity_number; else
// branches on country. Falls through to undefined for a country not
// listed (e.g. any value other than the five handled), matching Python's
// implicit `return None` -- verbatim, not "fixed" into an else clause.
export function charityRegisterUrl(charityNumber: string | null, country: string): string | null {
  if (!charityNumber) return null;
  if (country === "Scotland") {
    return `https://www.oscr.org.uk/about-charities/search-the-register/charity-details?number=${charityNumber}`;
  }
  if (country === "Northern Ireland") {
    return `https://www.charitycommissionni.org.uk/charity-details/?regId=${charityNumber.replace(/NIC/g, "")}`;
  }
  if (country === "Wales" || country === "England") {
    return `https://register-of-charities.charitycommission.gov.uk/charity-details/?regid=${charityNumber}&subid=0`;
  }
  if (country === "Isle of Man") {
    return "https://www.gov.im/about-the-government/offices/attorney-generals-chambers/crown-office/charities/index-of-charities-registered-in-the-isle-of-man/";
  }
  return null;
}

// Foodbank.fsa_url()
export function fsaUrl(fsaId: string | null): string | null {
  return fsaId ? `https://ratings.food.gov.uk/business/${fsaId}` : null;
}

// Foodbank.network_url() -- `False` (not null/undefined) for anything
// other than the two known networks, matching Python's `return False`
// verbatim (same reasoning as urlWithRefDonationPoint below).
export function networkUrl(network: string | null): string | false {
  if (network === "Trussell") return "https://www.trussell.org.uk/";
  if (network === "IFAN") return "https://www.foodaidnetwork.org.uk/";
  return false;
}

// Foodbank.bankuet_url()
export function bankuetUrl(bankuetSlug: string | null): string | null {
  return bankuetSlug ? `https://www.bankuet.co.uk/${bankuetSlug}/?ref=givefood.org.uk` : null;
}

// Foodbank.url_with_ref() -- merges `ref=givefood.org.uk` into the
// existing querystring (PreparedRequest.prepare_url's merge semantics),
// never strips anything first.
export function urlWithRefFoodbank(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("ref", "givefood.org.uk");
  return parsed.toString();
}

// FoodbankDonationPoint.url_with_ref() -- strips the known tracking
// params first, THEN adds ref. Returns false (not null) when there's no
// url, matching Python's `return False` verbatim (PLAN.md flags this as
// worth preserving exactly since `False`/`None` differ if ever
// JSON-serialised directly).
export function urlWithRefDonationPoint(url: string | null): string | false {
  if (!url) return false;
  const parsed = new URL(url);
  for (const key of QUERYSTRING_RUBBISH) parsed.searchParams.delete(key);
  parsed.searchParams.set("ref", "givefood.org.uk");
  return parsed.toString();
}

// Foodbank.changefreq() -- givefood/models/foodbank.py:168-176, for
// sitemap.xml's per-foodbank <changefreq> value.
export function changefreq(daysBetweenNeeds: number): string {
  if (daysBetweenNeeds === 0) return "yearly";
  if (daysBetweenNeeds > 90) return "yearly";
  if (daysBetweenNeeds > 25) return "monthly";
  if (daysBetweenNeeds > 6) return "weekly";
  return "daily";
}

// FoodbankChange.no_items() -- 0 for the two "no items" sentinels
// (deliberately excludes "Facebook", unlike has_needs()'s three-sentinel
// check -- verified against needs.py directly, not assumed symmetric).
export function noItems(changeText: string): number {
  if (changeText === "Unknown" || changeText === "Nothing") return 0;
  return changeText.split("\n").length;
}

// FoodbankChange.change_list() / excess_list() -- raw split, no sentinel
// handling (unlike no_items()), no blank-line filtering.
export function changeList(changeText: string): string[] {
  return changeText.split("\n");
}
export function excessList(excessChangeText: string | null): string[] {
  return excessChangeText ? excessChangeText.split("\n") : [];
}

// FoodbankChange.get_text() (givefood/models/needs.py:216-259, backing
// get_change_text()/get_excess_text_list()) -- blank lines stripped, rest
// re-joined. Every /md/ page rendering "Items needed"/"Items not needed"
// needs this filtered form; changeList()/excessList() above are the raw,
// unfiltered siblings used elsewhere.
export function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

// FoodbankChange.get_text()'s locale-aware half (needs.py:216-259) --
// nonEmptyLines() above only ever did the final blank-line-strip step; this
// completes the port: for English, the raw text always wins outright (the
// `current_language == "en"` branch never even queries
// FoodbankChangeTranslation); for cy/ga/gd, a truthy translated value wins,
// otherwise raw English is the fallback. (The Django source's leading
// sentinel-check branch -- `if self.change_text in [...]: the_text = ...`
// -- is unconditionally overwritten by one of the two branches this
// reproduces, on every real code path, so it's dead code not reproduced
// here.) `translatedText` is `getNeedTranslation`/`getNeedTranslationsByIds`
// (@givefood/db)'s change_text or excess_change_text column for the
// current request's locale -- undefined/null when there's no row, or
// locale is "en" and the caller skipped the lookup entirely.
export function resolveNeedText(rawText: string | null, translatedText: string | null | undefined, locale: "en" | "cy" | "ga" | "gd"): string {
  const text = locale !== "en" && translatedText ? translatedText : rawText;
  if (!text) return "";
  return nonEmptyLines(text).join("\n");
}

// Django's slugify(), reproduced only as simply as this codebase actually
// needs it -- same scope note as api1.ts's own copy (PLAN.md R7: a full
// Unicode-faithful slugify is a much bigger job that matters for the
// *foodbank* slug used as a primary key elsewhere). Used by the homepage's
// "recently updated" list, which -- like gfapi1 -- only ever needs to
// reconstruct a URL fragment from a denormalised name, never to assign a
// real slug.
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// FoodbankArticle.title_captialised() -- Python's string.capwords() (split
// on whitespace, capitalize() each word, single-space join) followed by an
// acronym-restoring pass, a trailing-period strip, and whitespace
// collapse. Ported verbatim from articles.py, not paraphrased.
const NO_CAP_WORDS = ["UK", "AGM", "CEO", "NI", "GCK", "BBC", "COVID", "MP", "NHS", "ID", "TV", "UN", "FC", "UHT"];

function capwords(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => (word.length ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

export function titleCapitalised(title: string): string {
  let result = capwords(title);
  for (const word of NO_CAP_WORDS) {
    const capitalized = word[0]! + word.slice(1).toLowerCase();
    result = result.replace(new RegExp(`\\b${capitalized}\\b`, "g"), word);
  }
  result = result.replace(/\.+$/, "");
  while (result.includes("  ")) result = result.replace("  ", " ");
  return result;
}

// "YYYY-MM-DD" -- the "most viewed this week" day-range boundaries every
// hits-based query (public.ts, wfbn/country.ts) needs, shared rather than
// redefined per file.
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// givefood/const/general.py's ENABLE_WRITE -- a hardcoded constant, not an
// env flag (grep confirms no other value is ever assigned to it), so
// there's nothing to read at request time. Shared rather than redefined
// per file that needs the "Write to your MP" link gate.
export const ENABLE_WRITE = true;

export interface ArticleTemplateRow {
  foodbank: { slug: string; name: string | null };
  url_with_ref: string;
  title_captialised: string;
  published_date: string;
}

// FoodbankArticle -> the shape public/frags/news.njk actually reads --
// shared by public.ts's featured-articles section and news.ts's full
// listing, since both feed the same frag template.
export function mapArticleRow(a: { foodbank_slug: string; foodbank_name: string | null; url: string; title: string; published_date: string }): ArticleTemplateRow {
  return {
    foodbank: { slug: a.foodbank_slug, name: a.foodbank_name },
    url_with_ref: urlWithRefFoodbank(a.url),
    title_captialised: titleCapitalised(a.title),
    published_date: a.published_date,
  };
}
