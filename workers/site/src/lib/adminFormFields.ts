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
// givefood/const/general.py:73-99 DONATION_POINT_COMPANIES, in the source
// order -- general.py:100 builds DONATION_POINT_COMPANIES_CHOICES straight
// from this list, so it is also the dropdown's order. Not free text:
// `company` is slugified into `company_slug` on save
// (donationPointsAdmin.ts:68), which keys the public
// /donationpoints/company/<slug>/ grouping and the shipped per-company
// logo set (static/img/co/<slug>.png), so an off-list spelling silently
// mints a new company with a broken icon.
const DONATION_POINT_COMPANIES = [
  "Aldi",
  "Asda",
  "Best-One",
  "Booths",
  "Budgens",
  "Co-op",
  "Costcutter",
  "Eurospar",
  "Farmfoods",
  "Iceland",
  "Lidl",
  "Londis",
  "Mace",
  "Marks & Spencer",
  "McColl's",
  "Morrisons",
  "Nisa",
  "One Stop",
  "Poundland",
  "Premier",
  "Sainsbury's",
  "Scotmid",
  "Spar",
  "Tesco",
  "Waitrose",
] as const;

// Labels below are Django's OWN default, for every one of these fields
// that declares no explicit `verbose_name`: `fields_for_model()` builds
// `field.name.replace('_', ' ')` then applies `capfirst()` -- which
// capitalises only the very first character, not every word (confirmed
// against the real `django.utils.text.capfirst`: capfirst("alt_name"
// .replace("_"," ")) == "Alt name", not "Alt Name"). Several of these were
// Title-Cased here instead, which is a real rendered-text mismatch, not a
// style choice -- fields that DO carry an explicit verbose_name in
// foodbank.py (URL, Place ID, Latitude/Longitude, the FSA one, the two
// boolean questions) are left as their exact verbose_name text, unaffected
// by this rule.
export const FOODBANK_FIELDS: readonly AdminFieldSpec[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "alt_name", label: "Alt name", kind: "text", required: false, helpText: "E.g. Welsh version of the name" },
  { name: "address", label: "Address", kind: "textarea", required: true },
  { name: "postcode", label: "Postcode", kind: "text", required: true },
  { name: "country", label: "Country", kind: "select", required: true, options: COUNTRIES },
  { name: "lat_lng", label: "Latitude, Longitude", kind: "text", required: true },
  { name: "place_id", label: "Place ID", kind: "text", required: false },
  { name: "delivery_address", label: "Delivery address", kind: "textarea", required: false },
  { name: "network", label: "Network", kind: "select", required: false, options: FOODBANK_NETWORKS },
  { name: "network_id", label: "Network id", kind: "text", required: false },
  { name: "notes", label: "Notes", kind: "textarea", required: false },
  { name: "charity_number", label: "Charity number", kind: "text", required: false },
  {
    name: "charity_just_foodbank",
    label: "Charity just foodbank",
    kind: "checkbox",
    required: false,
    helpText: "Tick this if the charity is purely used for the foodbank, rather than other uses such as a church",
  },
  { name: "facebook_page", label: "Facebook page", kind: "text", required: false },
  { name: "bankuet_slug", label: "Bankuet slug", kind: "text", required: false },
  { name: "fsa_id", label: "Food Standards Agency Business ID", kind: "text", required: false },
  { name: "contact_email", label: "Contact email", kind: "email", required: true },
  { name: "notification_email", label: "Notification email", kind: "email", required: false },
  { name: "phone_number", label: "Phone number", kind: "text", required: false },
  { name: "secondary_phone_number", label: "Secondary phone number", kind: "text", required: false },
  { name: "delivery_phone_number", label: "Delivery phone number", kind: "text", required: false },
  { name: "url", label: "URL", kind: "url", required: true },
  { name: "shopping_list_url", label: "Shopping list URL", kind: "url", required: true },
  { name: "rss_url", label: "RSS feed URL", kind: "url", required: false },
  { name: "news_url", label: "News URL", kind: "url", required: false },
  { name: "donation_points_url", label: "Donation points URL", kind: "url", required: false },
  { name: "locations_url", label: "Locations URL", kind: "url", required: false },
  { name: "contacts_url", label: "Contacts URL", kind: "url", required: false },
  { name: "address_is_administrative", label: "Is the main address just used for administrative purposes?", kind: "checkbox", required: false },
  { name: "is_closed", label: "Is closed", kind: "checkbox", required: false },
  { name: "is_school", label: "Is school", kind: "checkbox", required: false },
] as const;

// givefood/forms.py:26-29 FOODBANK_LOCATION_FIELD_ORDER, minus `foodbank`
// (a HiddenInput in Django, fixed by the URL's :slug rather than rendered
// as a field here -- routes/admin/foodbankLocation.ts sets it directly).
// Labels below are Django's actual rendered labels, not a style choice:
// FoodbankLocation/FoodbankDonationPoint declare no explicit `verbose_name`
// on most fields, so Django's ModelForm falls back to
// capfirst(pretty_name(field_name)) -- underscores to spaces, then ONLY the
// first character capitalised ("is_donation_point" -> "Is donation point",
// not "Is Donation Point"). `lat_lng`, `place_id` and (on the donation
// point) `url` are the exceptions: those three DO set an explicit
// verbose_name (base.py:73,76; foodbank.py:1018) and keep their Title/
// acronym form here for that reason -- this is the same capfirst check
// already applied to FOODBANK_FIELDS.
export const FOODBANK_LOCATION_FIELDS: readonly AdminFieldSpec[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "address", label: "Address", kind: "textarea", required: false },
  { name: "postcode", label: "Postcode", kind: "text", required: false },
  { name: "is_donation_point", label: "Is donation point", kind: "checkbox", required: false },
  { name: "is_mobile", label: "Is mobile", kind: "checkbox", required: false },
  { name: "lat_lng", label: "Latitude, Longitude", kind: "text", required: true },
  { name: "boundary_geojson", label: "Boundary geojson", kind: "textarea", required: false },
  { name: "place_id", label: "Place ID", kind: "text", required: false },
  { name: "phone_number", label: "Phone number", kind: "text", required: false, helpText: "If different to the main location" },
  { name: "email", label: "Email", kind: "email", required: false, helpText: "If different to the main location" },
] as const;

// givefood/forms.py:31-35 FOODBANK_DONATION_POINT_FIELD_ORDER, minus
// `foodbank` (same HiddenInput reasoning as the location fields above).
// See FOODBANK_LOCATION_FIELDS' comment above for why most labels here are
// sentence case rather than Title Case: it's Django's own capfirst()
// default for fields with no explicit verbose_name. `url` is the one
// exception on this model too (foodbank.py:1018 sets verbose_name="URL").
export const FOODBANK_DONATION_POINT_FIELDS: readonly AdminFieldSpec[] = [
  { name: "name", label: "Name", kind: "text", required: true },
  { name: "address", label: "Address", kind: "textarea", required: true },
  { name: "postcode", label: "Postcode", kind: "text", required: true },
  { name: "phone_number", label: "Phone number", kind: "text", required: false },
  { name: "opening_hours", label: "Opening hours", kind: "textarea", required: false },
  { name: "wheelchair_accessible", label: "Wheelchair accessible", kind: "tristate", required: false },
  { name: "url", label: "URL", kind: "url", required: false },
  { name: "in_store_only", label: "In store only", kind: "checkbox", required: false },
  // foodbank.py:1021 `choices=DONATION_POINT_COMPANIES_CHOICES` -- a
  // Select in Django, and admin.js:210-219's initCompanyAutoSelect()
  // iterates `#id_company`'s `.options` to auto-pick the company out of a
  // typed store name, which only exists on a <select>.
  { name: "company", label: "Company", kind: "select", required: false, options: DONATION_POINT_COMPANIES },
  // help_text verbatim from foodbank.py:1023 and :1025. The Notes one
  // matters: Foodbank.notes (foodbank.py:73) is private scratch with no
  // help_text, while THIS notes field is published on the public donation
  // point page, and that line was the only thing saying so.
  { name: "store_id", label: "Store id", kind: "text", required: false, helpText: "The company's store ID" },
  { name: "notes", label: "Notes", kind: "textarea", required: false, helpText: "These notes are public" },
  { name: "lat_lng", label: "Latitude, Longitude", kind: "text", required: true },
  { name: "place_id", label: "Place ID", kind: "text", required: false },
] as const;

// givefood/forms.py:249-252 ParliamentaryConstituencyForm -- `fields =
// "__all__"`, no custom field_order, minus editable=False fields
// (slug, mp_display_name, latitude, longitude).
export const PARLCON_FIELDS: readonly AdminFieldSpec[] = [
  // Deliberate divergence, stated rather than left silent:
  // givefood/models/political.py:16 declares `name` as
  // `null=True, blank=True`, so Django's form accepts a nameless
  // constituency. Kept required here because `name` is the sole input to
  // the slug this row is addressed by (parlconAdmin.ts:37), and a blank
  // name yields a blank slug that collides with every other blank one.
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
// givefood/const/general.py:176, applied via base.py:63-69's RegexValidator
// to every model's `postcode` field (Foodbank/FoodbankLocation/
// FoodbankDonationPoint all inherit it) -- the only format validation
// Django has on this field. Ported as the literal source string, not
// paraphrased, so it stays byte-comparable against the original.
const POSTCODE_REGEX = /^(([A-Z]{1,2}[0-9][A-Z0-9]?|ASCN|STHL|TDCU|BBND|[BFS]IQQ|PCRN|TKCA) ?[0-9][A-Z]{2}|BFPO ?[0-9]{1,4}|(KY[0-9]|MSR|VG|AI)[ -]?[0-9]{4}|[A-Z]{2} ?[0-9]{2}|GE ?CX|GIR ?0A{2}|SAN ?TA1)$/;

// Same coarse shape as Django's EmailValidator needs to catch here -- a
// "does this look like an email" guard, not RFC 5322. Exported so
// routes/admin/useAi.ts's own field-level validation uses the same check
// rather than a second, possibly-diverging copy.
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// givefood/models/foodbank.py:648-652 (Foodbank.save()), :956-958
// (FoodbankLocation) and :1288-1290 (FoodbankDonationPoint) all run
// `phone_number.replace(" ","")` before storing, so a hand-typed
// "01234 567 890" reaches the database as "01234567890". That is not
// cosmetic: friendly_phone/full_phone (packages/templates/src/filters.ts:
// 7-15, a port of utils/text.py:166) re-space the number BY CHARACTER
// POSITION, so an unstripped value renders back mangled everywhere it
// appears, admin and public pages alike, with a broken `tel:` href.
// `.split(" ").join("")` rather than /\s+/g, matching Django's literal
// single-space replace. `delivery_phone_number` is deliberately absent:
// foodbank.py:103 declares it and save() never touches it, so stripping
// it would be a fresh divergence rather than a fix.
const SPACE_STRIPPED_FIELDS = new Set(["phone_number", "secondary_phone_number"]);

// The failure branch carries `values` too: gfadmin/views.py:825-856's
// `if request.POST:` has no else, so an invalid form falls through to the
// same render() with the BOUND form and every submitted value still in
// place. Callers re-render with these instead of throwing the admin's
// whole page away for a plain-text 400. Parsing therefore runs to
// completion and reports the FIRST failure, the way Django surfaces the
// first error on a field.
export function parseAdminFields(
  specs: readonly AdminFieldSpec[],
  body: Record<string, unknown>,
): { ok: true; values: Record<string, AdminFieldValue> } | { ok: false; error: string; values: Record<string, AdminFieldValue> } {
  const values: Record<string, AdminFieldValue> = {};
  let error: string | null = null;
  const fail = (message: string) => {
    if (error === null) error = message;
  };

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
    if (spec.required && !trimmed) fail(`${spec.label} is required`);
    if (trimmed) {
      // Format validation Django enforces on every ModelForm save
      // (givefood/models/base.py:63-69's RegexValidator, EmailField). Not
      // the whole of Django's validation -- Model.clean() adds cross-field
      // rules that need the other fields or the parent row to check, so
      // those live with their routes (see foodbank.ts's phoneClashError
      // and donationPoint.ts's co-location check).
      // .toUpperCase() before testing: Django's regex is upper-case-only
      // with no clean_postcode()/normalisation found anywhere, so a
      // hand-typed lowercase postcode would genuinely 400 in real Django
      // too -- deliberately not ported here, since every stored postcode
      // in this schema is already upper-case and rejecting a case
      // difference the user almost certainly didn't intend serves no one.
      //
      // ACCEPTED LENIENTLY, THEN NORMALISED ON STORE (github #24). Only the
      // comparison used to be uppercased, so "ex10 8lz" passed here and was
      // written to D1 verbatim -- publishing a lowercase postcode to the
      // public <address> block and every /api/2/ consumer, and manufacturing
      // a case variant real Django could never produce. The leniency is the
      // point and stays; persisting the typed case was not. See the
      // normalisation below.
      if (spec.name === "postcode" && !POSTCODE_REGEX.test(trimmed.toUpperCase())) fail(`${spec.label} is not a valid postcode`);
      if (spec.kind === "email" && !isValidEmail(trimmed)) fail(`${spec.label} is not a valid email address`);
    }
    // Postcode is stored upper-cased, restoring the invariant the comment
    // above depends on ("every stored postcode in this schema is already
    // upper-case") -- true of all 8,779 rows on production D1 when this
    // landed, and now true by construction rather than by luck.
    //
    // PARITY-NEUTRAL, verified in CPython against Django's own
    // POSTCODE_REGEX (const/general.py:176) as base.py:63-68 builds it,
    // with no re.IGNORECASE: every value Django accepts is already
    // upper-case, so this cannot change one of them. It only normalises the
    // case difference this port accepts and Django rejects outright.
    //
    // NOT space-stripped, unlike the phone fields: dupePostcodes.ts
    // deliberately treats "SW1A 1AA" and "SW1A1AA" as different rows so the
    // maintainer sees inconsistent entry, and collapsing that here would
    // delete the finding rather than report it.
    const normalised = SPACE_STRIPPED_FIELDS.has(spec.name)
      ? trimmed.split(" ").join("")
      : spec.name === "postcode"
        ? trimmed.toUpperCase()
        : trimmed;
    values[spec.name] = normalised === "" ? null : normalised;
  }
  return error === null ? { ok: true, values } : { ok: false, error, values };
}
