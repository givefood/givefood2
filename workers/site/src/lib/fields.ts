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

export function fullNameFoodbank(name: string): string {
  if (DONT_APPEND_FOOD_BANK.includes(name)) return name;
  return `${name} Foodbank`;
}

export function fullNameLocation(locationName: string, foodbankName: string): string {
  return `${locationName}, ${fullNameFoodbank(foodbankName)}`;
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
