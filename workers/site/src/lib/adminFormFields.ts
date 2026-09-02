// givefood/forms.py:17-24 FOODBANK_FIELD_ORDER -- the 30 editable Foodbank
// fields, in the order the admin has always shown them (Foodbank's real
// Django model-declaration order puts inherited PhysicalPlace fields like
// `address`/`postcode` ahead of `name`; this pins the field order users
// actually see). Every OTHER field on the model is editable=False --
// system/computed state (charity registry sync, geocoding, decache
// counters, `latest_need`) that no admin form is meant to touch, and
// verified (WP 6.5 research) to be exactly this list: nothing in
// FOODBANK_FIELD_ORDER is missing from the model's editable set, and
// nothing editable is missing from this list.
//
// A shared descriptor, not per-form field lists, because FoodbankForm and
// FoodbankPoliticsForm both render every one of these 30 (see routes/admin
// /foodbank.ts's own comment for why "politics" is a second full-Foodbank
// edit form, not a scoped-down one) and the 4 collapsed partial forms
// (Address/Phone/Email/FsaId) each just filter this same list down to
// their own field subset (foodbankPartialForms.ts) -- one place to get a
// label, input type or choice list right, not five.
// "tristate" is a NULLABLE boolean (Django's own default widget for
// `BooleanField(null=True)` is a 3-option Unknown/Yes/No select, not a
// checkbox) -- e.g. FoodbankDonationPoint.wheelchair_accessible, whose D1
// column comment warns "TRI-STATE: NULL/0/1, do not coalesce". A plain
// checkbox can only express 2 states and would silently turn every
// "unknown" into "no".
export type AdminFieldKind = "text" | "textarea" | "email" | "url" | "checkbox" | "select" | "tristate";

export interface AdminFieldSpec {
  name: string;
  label: string;
  kind: AdminFieldKind;
  required: boolean;
  options?: readonly string[]; // only for kind: "select"
  helpText?: string;
}

// givefood/const/general.py:4-13.
const COUNTRIES = ["England", "Wales", "Scotland", "Northern Ireland", "Isle of Man", "Jersey", "Guernsey"] as const;
// givefood/const/general.py:37-42.
const FOODBANK_NETWORKS = ["Trussell", "IFAN", "Independent"] as const;

export const FOODBANK_FIELDS: readonly AdminFieldSpec[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "alt_name", label: "Alt Name", kind: "text", required: false, helpText: "E.g. Welsh version of the name" },
  { name: "address", label: "Address", kind: "textarea", required: true },
  { name: "postcode", label: "Postcode", kind: "text", required: true },
  { name: "country", label: "Country", kind: "select", required: true, options: COUNTRIES },
  { name: "lat_lng", label: "Latitude, Longitude", kind: "text", required: true },
  { name: "place_id", label: "Place ID", kind: "text", required: false },
  { name: "delivery_address", label: "Delivery Address", kind: "textarea", required: false },
  { name: "network", label: "Network", kind: "select", required: false, options: FOODBANK_NETWORKS },
  { name: "network_id", label: "Network ID", kind: "text", required: false },
  { name: "notes", label: "Notes", kind: "textarea", required: false },
  { name: "charity_number", label: "Charity Number", kind: "text", required: false },
  {
    name: "charity_just_foodbank",
    label: "Charity just foodbank",
    kind: "checkbox",
    required: false,
    helpText: "Tick this if the charity is purely used for the foodbank, rather than other uses such as a church",
  },
  { name: "facebook_page", label: "Facebook Page", kind: "text", required: false },
  { name: "bankuet_slug", label: "Bankuet Slug", kind: "text", required: false },
  { name: "fsa_id", label: "Food Standards Agency Business ID", kind: "text", required: false },
  { name: "contact_email", label: "Contact Email", kind: "email", required: true },
  { name: "notification_email", label: "Notification Email", kind: "email", required: false },
  { name: "phone_number", label: "Phone Number", kind: "text", required: false },
  { name: "secondary_phone_number", label: "Secondary Phone Number", kind: "text", required: false },
  { name: "delivery_phone_number", label: "Delivery Phone Number", kind: "text", required: false },
  { name: "url", label: "URL", kind: "url", required: true },
  { name: "shopping_list_url", label: "Shopping list URL", kind: "url", required: true },
  { name: "rss_url", label: "RSS feed URL", kind: "url", required: false },
  { name: "news_url", label: "News URL", kind: "url", required: false },
  { name: "donation_points_url", label: "Donation points URL", kind: "url", required: false },
  { name: "locations_url", label: "Locations URL", kind: "url", required: false },
  { name: "contacts_url", label: "Contacts URL", kind: "url", required: false },
  { name: "address_is_administrative", label: "Is the main address just used for administrative purposes?", kind: "checkbox", required: false },
  { name: "is_closed", label: "Is Closed", kind: "checkbox", required: false },
  { name: "is_school", label: "Is School", kind: "checkbox", required: false },
] as const;

// givefood/forms.py:26-29 FOODBANK_LOCATION_FIELD_ORDER, minus `foodbank`
// (a HiddenInput in Django, fixed by the URL's :slug rather than rendered
// as a field here -- routes/admin/foodbankLocation.ts sets it directly).
export const FOODBANK_LOCATION_FIELDS: readonly AdminFieldSpec[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "address", label: "Address", kind: "textarea", required: false },
  { name: "postcode", label: "Postcode", kind: "text", required: false },
  { name: "is_donation_point", label: "Is Donation Point", kind: "checkbox", required: false },
  { name: "is_mobile", label: "Is Mobile", kind: "checkbox", required: false },
  { name: "lat_lng", label: "Latitude, Longitude", kind: "text", required: true },
  { name: "boundary_geojson", label: "Boundary GeoJSON", kind: "textarea", required: false },
  { name: "place_id", label: "Place ID", kind: "text", required: false },
  { name: "phone_number", label: "Phone Number", kind: "text", required: false, helpText: "If different to the main location" },
  { name: "email", label: "Email", kind: "email", required: false, helpText: "If different to the main location" },
] as const;

// givefood/forms.py:31-35 FOODBANK_DONATION_POINT_FIELD_ORDER, minus
// `foodbank` (same HiddenInput reasoning as the location fields above).
export const FOODBANK_DONATION_POINT_FIELDS: readonly AdminFieldSpec[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "address", label: "Address", kind: "textarea", required: true },
  { name: "postcode", label: "Postcode", kind: "text", required: true },
  { name: "phone_number", label: "Phone Number", kind: "text", required: false },
  { name: "opening_hours", label: "Opening Hours", kind: "textarea", required: false },
  { name: "wheelchair_accessible", label: "Wheelchair Accessible", kind: "tristate", required: false },
  { name: "url", label: "URL", kind: "url", required: false },
  { name: "in_store_only", label: "In Store Only", kind: "checkbox", required: false },
  { name: "company", label: "Company", kind: "text", required: false },
  { name: "store_id", label: "Store ID", kind: "text", required: false },
  { name: "notes", label: "Notes", kind: "textarea", required: false },
  { name: "lat_lng", label: "Latitude, Longitude", kind: "text", required: true },
  { name: "place_id", label: "Place ID", kind: "text", required: false },
] as const;

// givefood/forms.py:249-252 ParliamentaryConstituencyForm -- `fields =
// "__all__"`, no custom field_order, minus editable=False fields
// (slug, mp_display_name, latitude, longitude).
export const PARLCON_FIELDS: readonly AdminFieldSpec[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "country", label: "Country", kind: "select", required: false, options: COUNTRIES },
  { name: "mp", label: "MP", kind: "text", required: false },
  { name: "mp_party", label: "MP's party", kind: "text", required: false },
  { name: "mp_parl_id", label: "MP's ID", kind: "text", required: true },
  { name: "email", label: "Email", kind: "email", required: false },
  { name: "centroid", label: "Centroid (lat,lng)", kind: "text", required: true },
  { name: "boundary_geojson", label: "Boundary GeoJSON", kind: "textarea", required: false },
] as const;

export function fieldsByName(names: readonly string[]): AdminFieldSpec[] {
  const byName = new Map(FOODBANK_FIELDS.map((f) => [f.name, f]));
  return names.map((name) => {
    const spec = byName.get(name);
    if (!spec) throw new Error(`unknown Foodbank field: ${name}`);
    return spec;
  });
}

// givefood/forms.py's 4 collapsed partial forms (WP 6.5, maintainer
// decision: Address/Phone/Email/FsaId are genuinely interchangeable
// boilerplate -- same 6-line save(), differ only in field list -- so they
// share one generic route+handler+template keyed by this config, rather
// than 4 near-duplicate files. FoodbankUrlsForm stays separate: its GET
// request runs a live site scrape + a Gemini suggestion call that has
// nothing in common with these four (routes/admin/foodbankUrls.ts).
export interface FoodbankPartialFormConfig {
  slug: string; // URL segment: /admin/foodbank/<slug>/edit/<slug>/
  title: string;
  fieldNames: readonly string[];
}

export const FOODBANK_PARTIAL_FORMS: readonly FoodbankPartialFormConfig[] = [
  { slug: "address", title: "Address", fieldNames: ["address", "postcode", "lat_lng", "place_id"] },
  { slug: "phone", title: "Phone", fieldNames: ["phone_number", "secondary_phone_number", "delivery_phone_number"] },
  { slug: "email", title: "Email", fieldNames: ["contact_email", "notification_email"] },
  { slug: "fsa-id", title: "FSA ID", fieldNames: ["fsa_id"] },
] as const;

export type AdminFieldValue = string | number | null;

// Shared by every admin*Form POST handler: reads exactly the named specs'
// values out of a parsed form body (a checkbox's HTML absence-when-
// unchecked means "not in body" IS its false state, not a missing-field
// error), trims free text to null-when-empty, and refuses to proceed if a
// required field came back empty -- matching Django's own required-field
// validation, just without a ModelForm to do it for us.
export function parseAdminFields(specs: readonly AdminFieldSpec[], body: Record<string, unknown>): { ok: true; values: Record<string, AdminFieldValue> } | { ok: false; error: string } {
  const values: Record<string, AdminFieldValue> = {};
  for (const spec of specs) {
    if (spec.kind === "checkbox") {
      values[spec.name] = body[spec.name] ? 1 : 0;
      continue;
    }
    if (spec.kind === "tristate") {
      const raw = body[spec.name];
      values[spec.name] = raw === "1" ? 1 : raw === "0" ? 0 : null;
      continue;
    }
    const raw = body[spec.name];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (spec.required && !trimmed) return { ok: false, error: `${spec.label} is required` };
    values[spec.name] = trimmed === "" ? null : trimmed;
  }
  return { ok: true, values };
}
