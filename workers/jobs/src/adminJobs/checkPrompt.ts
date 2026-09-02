// gfadmin/templates/admin/prompts/check.txt, transcribed from WP 6.8's
// research read of the rendered template. Hand-written template string,
// not run through @givefood/templates -- same reasoning as needcheck/
// prompt.ts's own comment (a plain-text, non-i18n prompt for one Worker
// doesn't need the page-rendering pipeline).
export interface CheckPromptParams {
  foodbankFullName: string;
  foodbankJson: string; // JSON.stringify(details/locations/donation_points, null, 2)
  pages: { name: string; text: string | null }[]; // homepage/shopping_list/locations/contacts/donation_points, in that order
}

export function buildCheckPrompt(params: CheckPromptParams): string {
  const pagesSection = params.pages.map((p) => `${p.name}...\n${p.text ?? "None"}\n\n`).join("");

  return `You are a data entry clerk for a food bank charity that carefully aggregates information about food banks for people to donate food to.

You are checking the address, contact details, charity number, locations and donation points for ${params.foodbankFullName}. Order the locations and donation points alphabetically. Don't include the main food bank address in locations or donation points. Lay out addresses with line breaks. Only include the charity number if it is explicitly stated on the provided pages. The charity number is typically a number prefixed with "SC" for Scottish charities, "NIC" for Northern Irish charities, or just a number for English and Welsh charities.

Also look for:
- Facebook page (extract just the page slug from URLs like facebook.com/GiveFoodOrgUK - return "GiveFoodOrgUK", not the full URL)
- Bankuet slug (if they use Bankuet for donations, extract the slug from URLs like bankuet.co.uk/SLUG)
- RSS feed URL (look for RSS or Atom feed links)
- News URL (a page listing news or blog posts)
- Donation Points URL (a page listing where people can drop off donations)
- Locations URL (a page listing food bank locations or distribution centres)
- Contacts URL (a dedicated contact page)

${params.foodbankJson}

Using these webpages downloaded from the food bank's website...

${pagesSection}`;
}

// views.py:1015-1135 FOODBANK_CHECK_RESPONSE_SCHEMA, transcribed verbatim.
export const FOODBANK_CHECK_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    details: {
      type: "object",
      properties: {
        name: { type: "string" },
        address: { type: "string" },
        postcode: { type: "string" },
        country: { type: "string" },
        phone_number: { type: "string" },
        contact_email: { type: "string" },
        network: { type: "string" },
        charity_number: { type: "string" },
        facebook_page: { type: "string" },
        bankuet_slug: { type: "string" },
        rss_url: { type: "string" },
        news_url: { type: "string" },
        donation_points_url: { type: "string" },
        locations_url: { type: "string" },
        contacts_url: { type: "string" },
      },
      required: [
        "name",
        "address",
        "postcode",
        "country",
        "phone_number",
        "contact_email",
        "network",
        "charity_number",
        "facebook_page",
        "bankuet_slug",
        "rss_url",
        "news_url",
        "donation_points_url",
        "locations_url",
        "contacts_url",
      ],
    },
    locations: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, address: { type: "string" }, postcode: { type: "string" } },
        required: ["name", "address", "postcode"],
      },
    },
    donation_points: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, address: { type: "string" }, postcode: { type: "string" } },
        required: ["name", "address", "postcode"],
      },
    },
  },
  required: ["details", "locations", "donation_points"],
} as const;

export interface FoodbankCheckDetails {
  name: string;
  address: string;
  postcode: string;
  country: string;
  phone_number: string;
  contact_email: string;
  network: string;
  charity_number: string;
  facebook_page: string;
  bankuet_slug: string;
  rss_url: string;
  news_url: string;
  donation_points_url: string;
  locations_url: string;
  contacts_url: string;
}

export interface FoodbankCheckPlace {
  name: string;
  address: string;
  postcode: string;
}

export interface FoodbankCheckAiResponse {
  details: FoodbankCheckDetails;
  locations: FoodbankCheckPlace[];
  donation_points: FoodbankCheckPlace[];
}

// The 10 use-ai-able fields (WP 6.7's foodbank_use_ai_detail ALLOWED_FIELDS)
// -- `details` also carries name/address/postcode/country/network, which
// are display-only comparisons on the check page (no "Use" button), so
// this list is the SUBSET the page offers a one-click commit for.
export const CHECK_USE_AI_FIELDS = [
  "phone_number",
  "contact_email",
  "charity_number",
  "facebook_page",
  "bankuet_slug",
  "rss_url",
  "news_url",
  "donation_points_url",
  "locations_url",
  "contacts_url",
] as const;
