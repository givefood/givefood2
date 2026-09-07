import { describe, expect, it } from "vitest";
import type { AdminFieldKind, AdminFieldSpec, AdminFieldValue, FoodbankPartialFormConfig } from "./adminFormFields";
import {
  FOODBANK_DONATION_POINT_FIELDS,
  FOODBANK_FIELDS,
  FOODBANK_LOCATION_FIELDS,
  FOODBANK_PARTIAL_FORMS,
  PARLCON_FIELDS,
  fieldsByName,
  isValidEmail,
  parseAdminFields,
} from "./adminFormFields";

// This module is a DESCRIPTOR of Django forms that no longer run. Nothing at
// runtime will notice if a field is dropped, a label drifts to Title Case or
// a `required` flag stops matching the model's `blank=` -- the admin will
// just quietly render a different form, or start writing NULL into a NOT NULL
// column. So the bulk of what follows re-states the Django source (field
// orders from givefood/forms.py:17-35, `blank=`/`verbose_name` from
// givefood/models/foodbank.py, base.py and political.py, choice lists from
// givefood/const/general.py) as literals, so a drift on either side fails
// here rather than in production.

// Django's own label rule, reimplemented so the label tests below are a real
// derivation rather than a copy of the strings under test:
// Field.set_attributes_from_name() sets verbose_name = name.replace("_"," ")
// and Field.formfield() then uses capfirst(verbose_name). capfirst uppercases
// ONLY the first character (django.utils.text.capfirst), so "alt_name"
// becomes "Alt name" -- never "Alt Name". This is exactly the check the
// module's own comment (adminFormFields.ts:76-86) says it applied.
function djangoDefaultLabel(fieldName: string): string {
  const pretty = fieldName.replace(/_/g, " ");
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

const ALL_FIELD_LISTS: ReadonlyArray<readonly [string, readonly AdminFieldSpec[]]> = [
  ["FOODBANK_FIELDS", FOODBANK_FIELDS],
  ["FOODBANK_LOCATION_FIELDS", FOODBANK_LOCATION_FIELDS],
  ["FOODBANK_DONATION_POINT_FIELDS", FOODBANK_DONATION_POINT_FIELDS],
  ["PARLCON_FIELDS", PARLCON_FIELDS],
];

const KINDS: readonly AdminFieldKind[] = ["text", "textarea", "email", "url", "checkbox", "select", "tristate"];

function specFor(list: readonly AdminFieldSpec[], name: string): AdminFieldSpec {
  const spec = list.find((f) => f.name === name);
  if (!spec) throw new Error(`test setup: no field named ${name}`);
  return spec;
}

// Every label test in this file is only as good as djangoDefaultLabel. If that
// helper ever drifted into Title Case -- a plausible "tidy-up", since several
// real labels here genuinely are Title-ish ("Place ID", "RSS feed URL") -- the
// label tests would start blessing exactly the drift adminFormFields.ts:76-86
// says it audited for, and they would still all pass. Pinning the helper turns
// that into one obvious failure instead of thirty confusing ones.
describe("the capfirst derivation the label tests rest on", () => {
  it("capitalises only the first character, like django.utils.text.capfirst", () => {
    expect(djangoDefaultLabel("is_donation_point")).toBe("Is donation point");
    expect(djangoDefaultLabel("alt_name")).toBe("Alt name");
    expect(djangoDefaultLabel("name")).toBe("Name");
    expect(djangoDefaultLabel("address_is_administrative")).toBe("Address is administrative");
    // The two shapes it must never produce, spelled out so the intent
    // survives even if someone rewrites the helper's body.
    expect(djangoDefaultLabel("is_donation_point")).not.toBe("Is Donation Point");
    expect(djangoDefaultLabel("place_id")).not.toBe("Place ID");
    // capfirst() only touches the FIRST character; it never lowercases the
    // rest, so an already-capitalised tail survives.
    expect(djangoDefaultLabel("mp_ID")).toBe("Mp ID");
  });
});

describe("FOODBANK_FIELDS", () => {
  // givefood/forms.py:17-24 FOODBANK_FIELD_ORDER, verbatim. The order is not
  // cosmetic: it is the only thing keeping the admin form looking like the
  // one maintainers have used for years (a `fields = "__all__"` ModelForm
  // would otherwise lead with the inherited PhysicalPlace address block and
  // bury `name` in the middle).
  const DJANGO_FOODBANK_FIELD_ORDER = [
    "name", "alt_name", "address", "postcode", "country", "lat_lng", "place_id",
    "delivery_address", "network", "network_id", "notes", "charity_number",
    "charity_just_foodbank", "facebook_page", "bankuet_slug", "fsa_id", "contact_email",
    "notification_email", "phone_number", "secondary_phone_number", "delivery_phone_number",
    "url", "shopping_list_url", "rss_url", "news_url", "donation_points_url", "locations_url",
    "contacts_url", "address_is_administrative", "is_closed", "is_school",
  ];

  it("is Django's FOODBANK_FIELD_ORDER, same fields and same order", () => {
    expect(FOODBANK_FIELDS.map((f) => f.name)).toEqual(DJANGO_FOODBANK_FIELD_ORDER);
  });

  it("carries 31 fields, not the 30 the module's own header claims", () => {
    // Pinned deliberately. Django's FOODBANK_FIELD_ORDER really does list 31
    // names; adminFormFields.ts:1-2 says "the 30 editable Foodbank fields".
    // The LIST is right and the comment's count is off by one, so this test
    // sides with Django -- if someone ever "fixes" the mismatch by deleting a
    // field to reach 30, the previous test catches which one and this one
    // says why the number matters.
    expect(FOODBANK_FIELDS).toHaveLength(31);
  });

  it("marks exactly the model's non-blank fields required", () => {
    // Django derives `required` from the model: a field is required unless it
    // declares blank=True. These eight are the ones foodbank.py leaves
    // non-blank (name, contact_email, url, shopping_list_url) or inherits
    // non-blank from PhysicalPlace (address, postcode, lat_lng) plus the
    // country override at foodbank.py:66. Getting this wrong in either
    // direction is a production failure: too few and a NOT NULL column takes
    // an empty write, too many and an admin cannot clear a field Django
    // always let them clear.
    const required = FOODBANK_FIELDS.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(["name", "address", "postcode", "country", "lat_lng", "contact_email", "url", "shopping_list_url"]);
  });

  it("uses Django's rendered label for every field", () => {
    // The twelve below are the Foodbank fields that set an explicit
    // verbose_name (base.py:73,76 for the two inherited ones; foodbank.py:82,
    // 96, 106-112, 116). Every OTHER field must equal capfirst() of its name
    // -- this is the test that fails the moment someone Title-Cases "Alt
    // name" into "Alt Name", which the module comment calls out as a real
    // rendered-text mismatch rather than a style choice.
    const explicitVerboseNames: Record<string, string> = {
      lat_lng: "Latitude, Longitude",
      place_id: "Place ID",
      charity_just_foodbank: "Charity just foodbank",
      fsa_id: "Food Standards Agency Business ID",
      url: "URL",
      shopping_list_url: "Shopping list URL",
      rss_url: "RSS feed URL",
      news_url: "News URL",
      donation_points_url: "Donation points URL",
      locations_url: "Locations URL",
      contacts_url: "Contacts URL",
      address_is_administrative: "Is the main address just used for administrative purposes?",
    };
    for (const spec of FOODBANK_FIELDS) {
      const expected = explicitVerboseNames[spec.name] ?? djangoDefaultLabel(spec.name);
      expect(spec.label, `label for ${spec.name}`).toBe(expected);
    }
    // Stated as a set as well as field-by-field, because the map above is a
    // copy of foodbank.py's strings and a copy can be padded. This says how
    // many labels are allowed to depart from capfirst at all: eleven. Note
    // charity_just_foodbank is IN the map yet absent here -- its explicit
    // verbose_name happens to be identical to capfirst's output, so it is not
    // a divergence, and a future Title-Casing of it fails both assertions.
    const diverging = FOODBANK_FIELDS.filter((f) => f.label !== djangoDefaultLabel(f.name)).map((f) => f.name);
    expect(diverging).toEqual([
      "lat_lng", "place_id", "fsa_id", "url", "shopping_list_url", "rss_url", "news_url",
      "donation_points_url", "locations_url", "contacts_url", "address_is_administrative",
    ]);
  });

  it("offers the seven countries from const/general.py:4-13, in source order", () => {
    // Order is the dropdown order (general.py:14 builds COUNTRIES_CHOICES
    // straight off this list), and the values are stored verbatim in the
    // `country` column, so a re-spelling here silently orphans existing rows.
    expect(specFor(FOODBANK_FIELDS, "country").options).toEqual([
      "England", "Wales", "Scotland", "Northern Ireland", "Isle of Man", "Jersey", "Guernsey",
    ]);
  });

  it("offers the three networks from const/general.py:37-42", () => {
    expect(specFor(FOODBANK_FIELDS, "network").options).toEqual(["Trussell", "IFAN", "Independent"]);
  });

  it("keeps Django's help_text verbatim where the model sets one", () => {
    // foodbank.py:62 and :78. These strings are the only guidance an admin
    // gets on two fields whose purpose is not obvious from the label.
    expect(specFor(FOODBANK_FIELDS, "alt_name").helpText).toBe("E.g. Welsh version of the name");
    expect(specFor(FOODBANK_FIELDS, "charity_just_foodbank").helpText).toBe(
      "Tick this if the charity is purely used for the foodbank, rather than other uses such as a church",
    );
    // Foodbank.notes (foodbank.py:73) has NO help_text -- unlike the donation
    // point's notes field, which is published publicly and says so. Asserting
    // the absence keeps that distinction from being "helpfully" flattened.
    expect(specFor(FOODBANK_FIELDS, "notes").helpText).toBeUndefined();
  });

  it("gives every field the kind its Django widget renders", () => {
    // Pinned for the WHOLE list, not just the interesting few, because `kind`
    // is load-bearing twice over: it picks the rendered <input type> AND it
    // is what makes parseAdminFields validate a value at all (kind "email" is
    // the only trigger for the address check). A field quietly demoted from
    // email to text keeps working, keeps looking right, and silently stops
    // being validated -- and contact_email/notification_email are the `to:`
    // of a real outbound message (routes/admin/orderActions.ts:113). A
    // textarea demoted to text makes a multi-line postal address unenterable;
    // a url demoted to text loses the browser's own check.
    const kinds: Record<string, AdminFieldKind> = {
      name: "text",
      alt_name: "text",
      address: "textarea",
      postcode: "text",
      country: "select",
      lat_lng: "text",
      place_id: "text",
      delivery_address: "textarea",
      network: "select",
      network_id: "text",
      notes: "textarea",
      charity_number: "text",
      charity_just_foodbank: "checkbox",
      facebook_page: "text",
      bankuet_slug: "text",
      fsa_id: "text",
      contact_email: "email",
      notification_email: "email",
      phone_number: "text",
      secondary_phone_number: "text",
      delivery_phone_number: "text",
      url: "url",
      shopping_list_url: "url",
      rss_url: "url",
      news_url: "url",
      donation_points_url: "url",
      locations_url: "url",
      contacts_url: "url",
      address_is_administrative: "checkbox",
      is_closed: "checkbox",
      is_school: "checkbox",
    };
    for (const spec of FOODBANK_FIELDS) expect(spec.kind, `kind for ${spec.name}`).toBe(kinds[spec.name]);
  });

  it("carries help text on exactly two fields, and nowhere else", () => {
    // The absence half matters as much as the presence half: help text is
    // rendered as a hint under the input, so an accidental one on (say)
    // `notes` would put private-scratch guidance next to a field whose
    // donation-point namesake IS public. Asserting the exact set is what
    // catches an addition; the per-field tests above catch a rewording.
    const withHelp = FOODBANK_FIELDS.filter((f) => f.helpText !== undefined).map((f) => f.name);
    expect(withHelp).toEqual(["alt_name", "charity_just_foodbank"]);
  });
});

describe("FOODBANK_LOCATION_FIELDS", () => {
  it("is Django's FOODBANK_LOCATION_FIELD_ORDER minus the hidden foodbank FK", () => {
    // forms.py:26-29, with `foodbank` dropped: Django renders it as a
    // HiddenInput (forms.py:154) while the Worker route fixes it from the
    // URL's :slug instead, so it is not a form field here at all.
    expect(FOODBANK_LOCATION_FIELDS.map((f) => f.name)).toEqual([
      "name", "address", "postcode", "is_donation_point", "is_mobile", "lat_lng",
      "boundary_geojson", "place_id", "phone_number", "email",
    ]);
  });

  it("omits is_closed, which FoodbankLocationForm explicitly excludes", () => {
    // forms.py:156 `exclude = ('is_closed',)`. The model field IS editable,
    // so a naive "__all__" port would have rendered it -- and a location's
    // is_closed is copied from its parent food bank on save
    // (foodbank.py:954), so letting an admin set it by hand would be
    // overwritten anyway.
    expect(FOODBANK_LOCATION_FIELDS.map((f) => f.name)).not.toContain("is_closed");
  });

  it("leaves address and postcode optional, unlike on Foodbank", () => {
    // foodbank.py:774-782 overrides the inherited PhysicalPlace fields to
    // null=True, blank=True precisely because mobile locations have no fixed
    // address. Requiring them here would block adding one.
    expect(specFor(FOODBANK_LOCATION_FIELDS, "address").required).toBe(false);
    expect(specFor(FOODBANK_LOCATION_FIELDS, "postcode").required).toBe(false);
    // name and lat_lng stay non-blank on the model, so they stay required.
    expect(specFor(FOODBANK_LOCATION_FIELDS, "name").required).toBe(true);
    expect(specFor(FOODBANK_LOCATION_FIELDS, "lat_lng").required).toBe(true);
    // And the whole set, so a NEW required flag on any of the remaining six
    // cannot slip in: making `email` or `boundary_geojson` required would
    // block saving a location that legitimately has neither.
    expect(FOODBANK_LOCATION_FIELDS.filter((f) => f.required).map((f) => f.name)).toEqual(["name", "lat_lng"]);
  });

  it("gives every field the kind its Django widget renders", () => {
    // Same reasoning as FOODBANK_FIELDS': `kind` is what makes
    // parseAdminFields validate at all. `email` here is the location's own
    // override address (foodbank.py:790) -- demote it to "text" and a typo'd
    // address saves silently. `boundary_geojson` holds a whole GeoJSON
    // polygon, so a one-line <input> would make it uneditable in practice.
    const kinds: Record<string, AdminFieldKind> = {
      name: "text",
      address: "textarea",
      postcode: "text",
      is_donation_point: "checkbox",
      is_mobile: "checkbox",
      lat_lng: "text",
      boundary_geojson: "textarea",
      place_id: "text",
      phone_number: "text",
      email: "email",
    };
    for (const spec of FOODBANK_LOCATION_FIELDS) expect(spec.kind, `kind for ${spec.name}`).toBe(kinds[spec.name]);
  });

  it("uses capfirst labels except for the two inherited verbose_name fields", () => {
    // The module comment names lat_lng and place_id as the only exceptions on
    // this model (base.py:73,76). "is_donation_point" must therefore render
    // as "Is donation point", not "Is Donation Point".
    const explicit: Record<string, string> = { lat_lng: "Latitude, Longitude", place_id: "Place ID" };
    for (const spec of FOODBANK_LOCATION_FIELDS) {
      expect(spec.label, `label for ${spec.name}`).toBe(explicit[spec.name] ?? djangoDefaultLabel(spec.name));
    }
  });

  it("keeps the 'If different to the main location' help on the override fields", () => {
    // foodbank.py:789-790. Without it an admin cannot tell whether leaving
    // these blank means "no phone" or "same as the food bank's".
    expect(specFor(FOODBANK_LOCATION_FIELDS, "phone_number").helpText).toBe("If different to the main location");
    expect(specFor(FOODBANK_LOCATION_FIELDS, "email").helpText).toBe("If different to the main location");
    // And on nothing else: those two are the only fields foodbank.py gives a
    // help_text, so a third hint here would be invented guidance.
    expect(FOODBANK_LOCATION_FIELDS.filter((f) => f.helpText !== undefined).map((f) => f.name)).toEqual(["phone_number", "email"]);
  });
});

describe("FOODBANK_DONATION_POINT_FIELDS", () => {
  it("is Django's FOODBANK_DONATION_POINT_FIELD_ORDER minus the hidden foodbank FK", () => {
    // forms.py:31-35, same HiddenInput reasoning as the location fields.
    expect(FOODBANK_DONATION_POINT_FIELDS.map((f) => f.name)).toEqual([
      "name", "address", "postcode", "phone_number", "opening_hours", "wheelchair_accessible",
      "url", "in_store_only", "company", "store_id", "notes", "lat_lng", "place_id",
    ]);
  });

  it("keeps address and postcode required, unlike FoodbankLocation", () => {
    // FoodbankDonationPoint does NOT override the PhysicalPlace declarations
    // (only FoodbankLocation does), so these inherit as non-blank. A donation
    // point with no address is unusable on the public map.
    expect(specFor(FOODBANK_DONATION_POINT_FIELDS, "address").required).toBe(true);
    expect(specFor(FOODBANK_DONATION_POINT_FIELDS, "postcode").required).toBe(true);
    // The full set, for the same reason as on FoodbankLocation. `company` in
    // particular must stay optional: independent (non-chain) donation points
    // have no company at all, and a required <select> with no blank choice
    // would force one of the 25 onto them.
    expect(FOODBANK_DONATION_POINT_FIELDS.filter((f) => f.required).map((f) => f.name)).toEqual([
      "name", "address", "postcode", "lat_lng",
    ]);
  });

  it("gives every field the kind its Django widget renders", () => {
    // The tristate and the select are asserted again below with their own
    // reasons; this table is what stops one of the OTHER eleven changing
    // unnoticed -- `opening_hours` in particular is a multi-line block that a
    // single-line input would silently truncate the usefulness of.
    const kinds: Record<string, AdminFieldKind> = {
      name: "text",
      address: "textarea",
      postcode: "text",
      phone_number: "text",
      opening_hours: "textarea",
      wheelchair_accessible: "tristate",
      url: "url",
      in_store_only: "checkbox",
      company: "select",
      store_id: "text",
      notes: "textarea",
      lat_lng: "text",
      place_id: "text",
    };
    for (const spec of FOODBANK_DONATION_POINT_FIELDS) expect(spec.kind, `kind for ${spec.name}`).toBe(kinds[spec.name]);
  });

  it("renders wheelchair_accessible as a tristate, never a checkbox", () => {
    // foodbank.py:1017 `BooleanField(null=True)`. The D1 column comment warns
    // "TRI-STATE: NULL/0/1, do not coalesce". A checkbox can only express two
    // states, so demoting this kind would silently rewrite every "we don't
    // know" as "no" the first time anyone saved the form.
    expect(specFor(FOODBANK_DONATION_POINT_FIELDS, "wheelchair_accessible").kind).toBe("tristate");
    // in_store_only is a plain `BooleanField(default=False)` (foodbank.py:
    // 1019) with no null, so it stays a real checkbox.
    expect(specFor(FOODBANK_DONATION_POINT_FIELDS, "in_store_only").kind).toBe("checkbox");
  });

  it("offers the 25 companies from const/general.py:73-99, in source order", () => {
    // Order matters (general.py:100 builds the choices straight off it) and
    // so does the exact spelling: `company` is slugified into `company_slug`,
    // which keys /donationpoints/company/<slug>/ and the shipped
    // static/img/co/<slug>.png logo, so an off-list spelling mints a new
    // company with a broken icon.
    expect(specFor(FOODBANK_DONATION_POINT_FIELDS, "company").options).toEqual([
      "Aldi", "Asda", "Best-One", "Booths", "Budgens", "Co-op", "Costcutter", "Eurospar",
      "Farmfoods", "Iceland", "Lidl", "Londis", "Mace", "Marks & Spencer", "McColl's",
      "Morrisons", "Nisa", "One Stop", "Poundland", "Premier", "Sainsbury's", "Scotmid",
      "Spar", "Tesco", "Waitrose",
    ]);
  });

  it("keeps company a select, which admin.js's auto-select depends on", () => {
    // admin.js:210-219 initCompanyAutoSelect() iterates `#id_company`'s
    // `.options` to guess the company out of a typed store name. A text
    // input has no `.options`, so switching the kind breaks that silently.
    expect(specFor(FOODBANK_DONATION_POINT_FIELDS, "company").kind).toBe("select");
  });

  it("keeps the two help_text strings from foodbank.py:1023 and :1025", () => {
    expect(specFor(FOODBANK_DONATION_POINT_FIELDS, "store_id").helpText).toBe("The company's store ID");
    // The important one: unlike Foodbank.notes (private scratch), THIS notes
    // field is published on the public donation point page, and this line is
    // the only thing telling the admin so before they type.
    expect(specFor(FOODBANK_DONATION_POINT_FIELDS, "notes").helpText).toBe("These notes are public");
    // Exactly those two. In particular `opening_hours` and `company` carry
    // none, so a helpful-looking addition here would be text Django never
    // showed -- and the "These notes are public" line has to stay the ONLY
    // publicity warning, so it cannot be diluted by neighbours.
    expect(FOODBANK_DONATION_POINT_FIELDS.filter((f) => f.helpText !== undefined).map((f) => f.name)).toEqual(["store_id", "notes"]);
  });

  it("uses capfirst labels except url, lat_lng and place_id", () => {
    // foodbank.py:1018 sets verbose_name="URL" on this model's url field;
    // base.py:73,76 supply the other two.
    const explicit: Record<string, string> = { url: "URL", lat_lng: "Latitude, Longitude", place_id: "Place ID" };
    for (const spec of FOODBANK_DONATION_POINT_FIELDS) {
      expect(spec.label, `label for ${spec.name}`).toBe(explicit[spec.name] ?? djangoDefaultLabel(spec.name));
    }
  });
});

describe("PARLCON_FIELDS", () => {
  it("is political.py's declaration order minus every editable=False field", () => {
    // forms.py:249-252 ParliamentaryConstituencyForm is `fields = "__all__"`
    // with no field_order, so the model's own declaration order IS the form
    // order. slug, mp_display_name, latitude and longitude are editable=False
    // (all four are computed on save) and must not appear.
    expect(PARLCON_FIELDS.map((f) => f.name)).toEqual([
      "name", "country", "mp", "mp_party", "mp_parl_id", "email", "centroid", "boundary_geojson",
    ]);
  });

  it("requires name even though Django does not -- the documented divergence", () => {
    // political.py:16 declares name as null=True, blank=True, so real Django
    // accepts a nameless constituency. The module deliberately diverges
    // because `name` is the sole input to the slug the row is addressed by
    // (parlconAdmin.ts:37), and a blank name yields a blank slug that
    // collides with every other blank one. Pinned so the divergence stays a
    // decision rather than something a future "match Django" pass reverts.
    expect(specFor(PARLCON_FIELDS, "name").required).toBe(true);
  });

  it("requires exactly the fields political.py leaves non-null", () => {
    // mp_parl_id is `IntegerField(verbose_name="MP's ID")` and centroid is
    // `CharField(max_length=50)` -- neither takes null/blank, so both are
    // required; every other field on the model is null=True, blank=True.
    const required = PARLCON_FIELDS.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(["name", "mp_parl_id", "centroid"]);
  });

  it("gives every field a kind, including the two Django would not render as text", () => {
    // `email` must be kind "email" or parseAdminFields skips its shape check
    // entirely -- this is the address the constituency's MP is contacted on.
    // `mp_parl_id` is an IntegerField in political.py but is deliberately
    // plain text here: routes/admin/parlcon.ts:48 does the
    // Number.parseInt() itself, because this module has no numeric kind.
    // Pinned so the coercion stays somebody's job rather than nobody's.
    const kinds: Record<string, AdminFieldKind> = {
      name: "text",
      country: "select",
      mp: "text",
      mp_party: "text",
      mp_parl_id: "text",
      email: "email",
      centroid: "text",
      boundary_geojson: "textarea",
    };
    for (const spec of PARLCON_FIELDS) expect(spec.kind, `kind for ${spec.name}`).toBe(kinds[spec.name]);
  });

  it("attaches no help text at all", () => {
    // political.py sets none, and the admin renders whatever is here, so an
    // invented hint would read as if Django had shipped it.
    expect(PARLCON_FIELDS.filter((f) => f.helpText !== undefined)).toEqual([]);
  });

  it("keeps the three MP verbose_names exactly as political.py spells them", () => {
    // political.py:20-22. The apostrophes and the all-caps MP are literal:
    // "MP's party", not "Mp's Party".
    expect(specFor(PARLCON_FIELDS, "mp").label).toBe("MP");
    expect(specFor(PARLCON_FIELDS, "mp_party").label).toBe("MP's party");
    expect(specFor(PARLCON_FIELDS, "mp_parl_id").label).toBe("MP's ID");
  });

  it("labels centroid and boundary_geojson its own way, NOT Django's capfirst default", () => {
    // Pinning current behaviour, not endorsing it. Neither field sets a
    // verbose_name in political.py, so the capfirst rule the other three
    // lists follow would render "Centroid" and "Boundary geojson". This list
    // hand-writes richer labels instead -- and note FOODBANK_LOCATION_FIELDS
    // spells the very same field name "Boundary geojson", so the two admin
    // pages disagree about one field's label. Reported rather than fixed.
    expect(specFor(PARLCON_FIELDS, "centroid").label).toBe("Centroid (lat,lng)");
    expect(specFor(PARLCON_FIELDS, "boundary_geojson").label).toBe("Boundary GeoJSON");
    expect(specFor(PARLCON_FIELDS, "centroid").label).not.toBe(djangoDefaultLabel("centroid"));
    expect(specFor(FOODBANK_LOCATION_FIELDS, "boundary_geojson").label).toBe("Boundary geojson");
  });

  it("shares one COUNTRIES list with the Foodbank form rather than forking it", () => {
    // The module's stated reason for being a shared descriptor: "one place to
    // get a label, input type or choice list right, not five". Reference
    // identity is the check that catches a copy-pasted second country list,
    // which would drift the moment one is edited.
    expect(specFor(PARLCON_FIELDS, "country").options).toBe(specFor(FOODBANK_FIELDS, "country").options);
  });
});

describe("field list invariants shared by all four lists", () => {
  it.each(ALL_FIELD_LISTS)("%s has no duplicate field names", (_name, list) => {
    // A duplicate would make parseAdminFields write the same column twice and
    // render the same input twice, with the second silently winning.
    expect(new Set(list.map((f) => f.name)).size).toBe(list.length);
  });

  it.each(ALL_FIELD_LISTS)("%s only ever declares a known kind", (_name, list) => {
    // AdminFieldKind is a compile-time union; this is the runtime half, so a
    // typo introduced through a cast or a JSON import still fails.
    for (const spec of list) expect(KINDS, spec.name).toContain(spec.kind);
  });

  it.each(ALL_FIELD_LISTS)("%s attaches options to select fields and to nothing else", (_name, list) => {
    // The AdminFieldSpec comment says options are "only for kind: select".
    // A select with no options renders an empty dropdown that cannot satisfy
    // its own required flag; options on a text field are silently dropped.
    for (const spec of list) {
      if (spec.kind === "select") {
        expect(spec.options, `${spec.name} options`).toBeDefined();
        expect(spec.options!.length, `${spec.name} options`).toBeGreaterThan(0);
      } else {
        expect(spec.options, `${spec.name} options`).toBeUndefined();
      }
    }
  });

  it.each(ALL_FIELD_LISTS)("%s gives every field a non-empty name and label", (_name, list) => {
    for (const spec of list) {
      expect(spec.name.length, "name").toBeGreaterThan(0);
      expect(spec.label.length, `label for ${spec.name}`).toBeGreaterThan(0);
      // A name is also a D1 column name and a POST body key: whitespace or
      // punctuation in one would be rejected by packages/db's COLUMN_NAME_RE
      // guard at save time rather than here.
      expect(spec.name, spec.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it.each(ALL_FIELD_LISTS)("%s declares no duplicate or whitespace-padded select option", (_name, list) => {
    // Options are stored verbatim in the column, and `company` is slugified
    // from the stored string into the URL and the shipped logo filename. A
    // duplicate renders the same <option> twice and makes one unselectable;
    // a stray leading/trailing space stores a value that no longer equals the
    // one already in every existing row, silently orphaning them.
    for (const spec of list) {
      if (!spec.options) continue;
      expect(new Set(spec.options).size, `${spec.name} options`).toBe(spec.options.length);
      for (const option of spec.options) {
        expect(option, `${spec.name} option ${JSON.stringify(option)}`).toBe(option.trim());
        expect(option.length, `${spec.name} option`).toBeGreaterThan(0);
      }
    }
  });

  it.each(ALL_FIELD_LISTS)("%s never marks a checkbox or tristate required", (_name, list) => {
    // parseAdminFields short-circuits both kinds BEFORE the required check
    // (an absent checkbox is its own false state), so `required: true` on one
    // would be a flag the form renders -- browsers enforce `required` on a
    // checkbox by refusing to submit -- that the server never enforces. The
    // two halves disagreeing is worse than either rule alone.
    for (const spec of list) {
      if (spec.kind === "checkbox" || spec.kind === "tristate") expect(spec.required, spec.name).toBe(false);
    }
  });

  it("uses tristate for exactly one field across the whole admin", () => {
    // wheelchair_accessible is the only BooleanField(null=True) in the ported
    // models. If a second one appears the D1 column comment's "do not
    // coalesce" warning needs to appear with it, so surface the change here.
    const tristates = ALL_FIELD_LISTS.flatMap(([, list]) => list.filter((f) => f.kind === "tristate").map((f) => f.name));
    expect(tristates).toEqual(["wheelchair_accessible"]);
  });
});

describe("FOODBANK_PARTIAL_FORMS", () => {
  it("matches the four collapsed ModelForms in forms.py, field for field", () => {
    // FoodbankAddressForm (forms.py:87-90), FoodbankPhoneForm (:100-103),
    // FoodbankEmailForm (:114-117) and FoodbankFsaIdForm (:129-132). These
    // four share one generic Worker route keyed by this config, so the config
    // IS the port -- there is no other place the field lists survive.
    expect(FOODBANK_PARTIAL_FORMS.map((f) => [f.slug, f.title, [...f.fieldNames]])).toEqual([
      ["address", "Address", ["address", "postcode", "lat_lng", "place_id"]],
      ["phone", "Phone", ["phone_number", "secondary_phone_number", "delivery_phone_number"]],
      ["email", "Email", ["contact_email", "notification_email"]],
      ["fsa-id", "FSA ID", ["fsa_id"]],
    ]);
  });

  it("excludes FoodbankUrlsForm, which is a separate route", () => {
    // forms.py:73-84 FoodbankUrlsForm is deliberately NOT one of the four:
    // its GET branch runs a live site scrape plus a Gemini suggestion call
    // (routes/admin/foodbankUrls.ts), which the generic handler cannot do.
    expect(FOODBANK_PARTIAL_FORMS.map((f) => f.slug)).not.toContain("urls");
    // The real invariant behind that, since a slug can be renamed: NONE of
    // the seven URL fields may appear in any of the four. If one did, the
    // generic handler would save it without ever running the scrape-and-
    // suggest GET branch the URLs page exists for.
    const urlFieldNames = FOODBANK_FIELDS.filter((f) => f.kind === "url").map((f) => f.name);
    const partialFieldNames = FOODBANK_PARTIAL_FORMS.flatMap((f) => [...f.fieldNames]);
    expect(urlFieldNames.length).toBe(7);
    for (const name of urlFieldNames) expect(partialFieldNames, name).not.toContain(name);
  });

  it("is a FILTER of FOODBANK_FIELDS: every name exists, in FOODBANK_FIELDS order", () => {
    // The module's own description -- the partial forms "each just filter
    // this same list down to their own field subset". A filter preserves
    // relative order, and the four really are ascending slices of
    // FOODBANK_FIELDS today. Order is what the admin sees: the Address form
    // must read address, postcode, lat_lng, place_id top to bottom, the same
    // block as on the full form, not a reshuffled version of it.
    const order = FOODBANK_FIELDS.map((f) => f.name);
    for (const config of FOODBANK_PARTIAL_FORMS) {
      const positions = config.fieldNames.map((n) => order.indexOf(n));
      expect(positions, `${config.slug} names all exist`).not.toContain(-1);
      expect(positions, `${config.slug} keeps FOODBANK_FIELDS order`).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("gives each form a distinct, non-empty title and at least one field", () => {
    // The title is the page's <h1> and the only thing distinguishing the four
    // otherwise-identical generic pages; a config with an empty fieldNames
    // would render a form whose Save button writes nothing at all.
    const titles = FOODBANK_PARTIAL_FORMS.map((f) => f.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const config of FOODBANK_PARTIAL_FORMS) {
      expect(config.title.trim(), config.slug).toBe(config.title);
      expect(config.title.length, config.slug).toBeGreaterThan(0);
      expect(config.fieldNames.length, config.slug).toBeGreaterThan(0);
      expect(new Set(config.fieldNames).size, `${config.slug} has no repeated field`).toBe(config.fieldNames.length);
    }
  });

  it("has slugs that are unique and URL-safe", () => {
    // The slug is a path segment: /admin/foodbank/<slug>/edit/<slug>/. A
    // duplicate would make one of the two forms unreachable.
    const slugs = FOODBANK_PARTIAL_FORMS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug, slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("names only fields that exist on FOODBANK_FIELDS", () => {
    // The generic route resolves these through fieldsByName(), which THROWS
    // on an unknown name -- so a typo here is a 500 on a live admin page, not
    // a missing input. This is the test that catches it at build time.
    for (const config of FOODBANK_PARTIAL_FORMS) {
      expect(() => fieldsByName(config.fieldNames), config.slug).not.toThrow();
    }
  });

  it("carries no keys beyond the three FoodbankPartialFormConfig declares", () => {
    // The config is read by templates, which get no type checking, so an
    // extra key added here (say a `required` or a `helpText`) would be
    // invisible at compile time AND silently ignored at render time -- the
    // worst combination. `satisfies` covers the compile-time half; this
    // covers the half a Nunjucks template lives in.
    for (const config of FOODBANK_PARTIAL_FORMS satisfies readonly FoodbankPartialFormConfig[]) {
      expect(Object.keys(config).sort(), config.slug).toEqual(["fieldNames", "slug", "title"]);
      expect(Array.isArray(config.fieldNames), config.slug).toBe(true);
      for (const name of config.fieldNames) expect(typeof name, config.slug).toBe("string");
    }
  });
});

describe("fieldsByName", () => {
  it("returns specs in the ORDER ASKED FOR, not FOODBANK_FIELDS order", () => {
    // This is the whole point of the helper for foodbankUrls.ts and the
    // partial forms: they render a subset in their own order. Returning
    // FOODBANK_FIELDS order instead would reshuffle every partial form.
    expect(fieldsByName(["is_school", "name", "postcode"]).map((f) => f.name)).toEqual(["is_school", "name", "postcode"]);
  });

  it("returns the shared spec objects, not copies", () => {
    // Identity, not deep equality: the module exists so a label lives in ONE
    // place. If this ever returned clones, a template mutating a spec (or a
    // reader comparing by reference) would quietly diverge per form.
    const [spec] = fieldsByName(["contact_email"]);
    expect(spec).toBe(specFor(FOODBANK_FIELDS, "contact_email"));
  });

  it("throws with the offending name for an unknown field", () => {
    expect(() => fieldsByName(["not_a_field"])).toThrow("unknown Foodbank field: not_a_field");
  });

  it("throws for a field that exists on a DIFFERENT model", () => {
    // The likeliest real mistake: reaching for a FoodbankLocation or donation
    // point field. fieldsByName only ever looks at FOODBANK_FIELDS, and the
    // loud failure is better than rendering a form missing an input.
    expect(() => fieldsByName(["is_donation_point"])).toThrow("unknown Foodbank field: is_donation_point");
    expect(() => fieldsByName(["company"])).toThrow("unknown Foodbank field: company");
  });

  it("reports the first unknown name when several are wrong", () => {
    expect(() => fieldsByName(["name", "nope", "also_nope"])).toThrow("unknown Foodbank field: nope");
  });

  it("throws for Object.prototype keys instead of returning something from the prototype", () => {
    // The lookup is a Map, and this is the test that says it has to stay one.
    // The obvious refactor -- Object.fromEntries(...) and `byName[name]` --
    // passes every other test in this file while making
    // fieldsByName(["constructor"]) return Object's constructor as if it were
    // a field spec. The caller then reads `.name`/`.label`/`.kind` off a
    // function and renders an input named "Object" into a live admin form.
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(() => fieldsByName([key]), key).toThrow(`unknown Foodbank field: ${key}`);
    }
  });

  it("accepts an empty list", () => {
    // Not hypothetical: a partial form config with no fields would otherwise
    // need a special case in the caller.
    expect(fieldsByName([])).toEqual([]);
  });

  it("returns a duplicate name twice rather than de-duplicating", () => {
    // Pinning current behaviour. No caller does this today, but silently
    // collapsing duplicates would hide a config typo instead of showing it as
    // a doubled input on the page.
    const result = fieldsByName(["name", "name"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(result[1]);
  });

  it("returns a fresh array each call, leaving FOODBANK_FIELDS untouched", () => {
    const before = FOODBANK_FIELDS.map((f) => f.name);
    const a = fieldsByName(["name"]);
    const b = fieldsByName(["name"]);
    expect(a).not.toBe(b);
    expect(FOODBANK_FIELDS.map((f) => f.name)).toEqual(before);
  });

  it("resolves the exact URL field list foodbankUrls.ts asks for", () => {
    // forms.py:73-84 FoodbankUrlsForm's Meta.fields, in its order. The route
    // hard-codes these names; this is where the two are kept honest.
    const names = ["url", "shopping_list_url", "rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"];
    const specs = fieldsByName(names);
    expect(specs.map((f) => f.name)).toEqual(names);
    // All seven must be url-kind, because the URLs page's whole job is URLs.
    expect(specs.every((f) => f.kind === "url")).toBe(true);
  });
});

describe("isValidEmail", () => {
  it("accepts ordinary addresses", () => {
    expect(isValidEmail("info@sidvalleyfoodbank.org.uk")).toBe(true);
    expect(isValidEmail("a@b.c")).toBe(true);
    expect(isValidEmail("first.last+tag@sub.domain.example")).toBe(true);
    expect(isValidEmail("MiXeD@CaSe.Org")).toBe(true);
  });

  it("rejects the shapes an admin actually mistypes", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("info")).toBe(false);
    expect(isValidEmail("info@localhost")).toBe(false); // no dot in the domain
    expect(isValidEmail("@example.org")).toBe(false); // no local part
    expect(isValidEmail("info@")).toBe(false);
    expect(isValidEmail("info@.org")).toBe(false); // nothing before the dot
    expect(isValidEmail("info@example.")).toBe(false); // nothing after it
    expect(isValidEmail("two@at@example.org")).toBe(false);
    expect(isValidEmail("has space@example.org")).toBe(false);
    expect(isValidEmail(" info@example.org")).toBe(false);
    expect(isValidEmail("info@example.org ")).toBe(false);
  });

  it("is anchored, so a trailing newline cannot smuggle a value past it", () => {
    // Worth stating because this is a place a Python port genuinely differs:
    // Python's `$` also matches just before a trailing newline, so Django's
    // re-based validators historically accepted "a@b.c\n". JavaScript's `$`
    // without the m flag matches only at the very end of the string, so this
    // is stricter than the original -- in the safe direction.
    expect(isValidEmail("info@example.org\n")).toBe(false);
    expect(isValidEmail("info@example.org\nevil@example.org")).toBe(false);
    // The shape that actually matters: this value ends up as the `to:` of a
    // real outbound order notification (routes/admin/orderActions.ts:113).
    // A CRLF here is the classic header-injection payload, and `\s` in the
    // character classes is the only thing stopping it.
    expect(isValidEmail("info@example.org\r\nBcc: evil@example.org")).toBe(false);
    expect(isValidEmail("info@example.org\r")).toBe(false);
  });

  it("rejects every other whitespace character too, not just the space bar", () => {
    // `[^\s@]` is the whole guard, so it has to hold for tab, vertical tab,
    // form feed and the non-breaking space a Word/Outlook paste supplies --
    // NBSP especially, because it is invisible in the input box and .trim()
    // strips it only at the ends, never from the middle.
    expect(isValidEmail("a\tb@example.org")).toBe(false);
    expect(isValidEmail("info@exa\tmple.org")).toBe(false);
    // Written as escapes on purpose: an NBSP typed literally into this file
    // would be as invisible to the next reader as it is in the input box.
    expect(isValidEmail("info\u00A0@example.org")).toBe(false);
    expect(isValidEmail("info@example\u00A0.org")).toBe(false);
    expect(isValidEmail("info@example.org\u000B")).toBe(false);
    expect(isValidEmail("info@example.org")).toBe(false);
  });

  it("accepts non-ASCII local parts and domains", () => {
    // Deliberate: the class is `[^\s@]`, not `[a-z0-9]`. Real stored
    // addresses include accented names, and an "obviously safer" ASCII-only
    // rewrite would start rejecting food banks that have been saving fine for
    // years -- and would reject them at the point of an unrelated edit, since
    // parseAdminFields re-validates every field on every save.
    expect(isValidEmail("josé@example.org")).toBe(true);
    expect(isValidEmail("info@exämple.org")).toBe(true);
    expect(isValidEmail("日本@例え.jp")).toBe(true);
  });

  it("holds up on the boundaries either side of a one-character address", () => {
    // "a@b.c" is the shortest string the pattern can accept (1+1+1 with the
    // @ and the dot). Everything one character shorter must fail, which is
    // what pins each `+` as a `+` rather than a `*`.
    expect(isValidEmail("a@b.c")).toBe(true);
    expect(isValidEmail("@b.c")).toBe(false);
    expect(isValidEmail("a@.c")).toBe(false);
    expect(isValidEmail("a@b.")).toBe(false);
    expect(isValidEmail("a@bc")).toBe(false);
    // And it does not care how long the value is -- no length rule was
    // ported, so a 500-character address is the route's problem, not this
    // function's.
    expect(isValidEmail(`${"a".repeat(500)}@${"b".repeat(500)}.org`)).toBe(true);
  });

  it("is a coarse shape check, not RFC 5322 -- deliberately", () => {
    // The module says so explicitly, and useAi.ts reuses it precisely so the
    // two code paths cannot diverge. Pinned so nobody "upgrades" it into a
    // strict validator and starts rejecting real, already-stored addresses.
    expect(isValidEmail("a..b@c..d")).toBe(true);
    expect(isValidEmail("!#$%@example.org")).toBe(true);
    expect(isValidEmail("info@-.-")).toBe(true);
  });
});

describe("parseAdminFields", () => {
  const textSpec: AdminFieldSpec = { name: "name", label: "Name", kind: "text", required: true };
  const optionalSpec: AdminFieldSpec = { name: "notes", label: "Notes", kind: "textarea", required: false };

  it("reads a full valid body and returns ok with every value", () => {
    const parsed = parseAdminFields(fieldsByName(["name", "postcode", "contact_email", "is_closed"]), {
      name: "Sid Valley Foodbank",
      postcode: "EX10 8LZ",
      contact_email: "info@example.org",
      is_closed: "on",
    });
    expect(parsed).toEqual({
      ok: true,
      values: { name: "Sid Valley Foodbank", postcode: "EX10 8LZ", contact_email: "info@example.org", is_closed: 1 },
    });
  });

  it("returns {} for an empty spec list without touching the body", () => {
    // The FSA ID partial form is a single field; a future one-field-removed
    // config must not blow up.
    expect(parseAdminFields([], { anything: "ignored" })).toEqual({ ok: true, values: {} });
  });

  it("only reads the named specs, ignoring every other body key", () => {
    // The admin POST body also carries csrf_token and whatever else the
    // template added. packages/db writes these values as columns
    // (foodbankAdmin.ts:170 relies on "never raw request-body keys"), so a
    // stray key leaking through would become an invalid SQL column.
    const parsed = parseAdminFields([textSpec], { name: "Brixton", csrf_token: "abc", is_school: "on" });
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.values)).toEqual(["name"]);
  });

  describe("checkboxes", () => {
    const closed = specFor(FOODBANK_FIELDS, "is_closed");

    it("treats an absent key as false, because that is how HTML posts an unchecked box", () => {
      // The single most important behaviour here: a browser omits an
      // unchecked checkbox entirely. Treating "missing" as an error (or as
      // null) would make it impossible to ever UN-tick is_closed.
      expect(parseAdminFields([closed], {}).values.is_closed).toBe(0);
    });

    it("treats a checked box as 1", () => {
      expect(parseAdminFields([closed], { is_closed: "on" }).values.is_closed).toBe(1);
    });

    it("writes 0/1 integers, not booleans, for D1", () => {
      // SQLite has no boolean type and these values go straight into a bind
      // parameter. A `true` here would be rejected by D1's parameter binding.
      const off = parseAdminFields([closed], {}).values.is_closed;
      const on = parseAdminFields([closed], { is_closed: "on" }).values.is_closed;
      expect(typeof off).toBe("number");
      expect(typeof on).toBe("number");
    });

    it("treats an empty string as false but ANY other string as true", () => {
      // Pinning a plain-truthiness check. "0" and "false" are truthy strings
      // in JavaScript, so a hidden-input pattern that posts is_closed=0 (or
      // =false) would tick the box. Django's CheckboxInput specifically maps
      // the string "false" to False, so that case is a divergence -- pinned,
      // not fixed, and reported.
      expect(parseAdminFields([closed], { is_closed: "" }).values.is_closed).toBe(0);
      expect(parseAdminFields([closed], { is_closed: "0" }).values.is_closed).toBe(1);
      expect(parseAdminFields([closed], { is_closed: "false" }).values.is_closed).toBe(1);
      expect(parseAdminFields([closed], { is_closed: "off" }).values.is_closed).toBe(1);
    });

    it("applies plain JavaScript truthiness to non-string body values too", () => {
      // c.req.parseBody() can hand back a File, or an array when a key
      // repeats. Neither is a string, and the checkbox branch does not check:
      // an EMPTY array is still an object, so `[]` ticks the box while the
      // number 0 does not. Pinned in both directions because a "tidy-up" to
      // `raw === "on"` would break the real HTML case (browsers post whatever
      // the input's `value` attribute says, not necessarily "on"), while a
      // tidy-up to `raw != null` would flip the empty-string case.
      const falsey: unknown[] = [0, -0, NaN, false, null, undefined, ""];
      for (const raw of falsey) {
        expect(parseAdminFields([closed], { is_closed: raw }).values.is_closed, String(raw)).toBe(0);
      }
      const truthy: unknown[] = [1, -1, true, [], {}, ["a"], "on", "0"];
      for (const raw of truthy) {
        expect(parseAdminFields([closed], { is_closed: raw }).values.is_closed, JSON.stringify(raw)).toBe(1);
      }
    });

    it("never reports a required error for a checkbox", () => {
      // Even were a checkbox ever marked required, absence is its false
      // state, so it short-circuits before the required check.
      const requiredBox: AdminFieldSpec = { name: "is_closed", label: "Is closed", kind: "checkbox", required: true };
      expect(parseAdminFields([requiredBox], {}).ok).toBe(true);
    });
  });

  describe("tristates", () => {
    const wheelchair = specFor(FOODBANK_DONATION_POINT_FIELDS, "wheelchair_accessible");

    it("maps the three posted states to 1, 0 and null", () => {
      // The whole reason this kind exists: "unknown" must reach D1 as NULL,
      // not as 0. The column comment says "TRI-STATE: NULL/0/1, do not
      // coalesce" -- collapsing null to 0 would claim every unsurveyed
      // donation point is NOT wheelchair accessible.
      expect(parseAdminFields([wheelchair], { wheelchair_accessible: "1" }).values.wheelchair_accessible).toBe(1);
      expect(parseAdminFields([wheelchair], { wheelchair_accessible: "0" }).values.wheelchair_accessible).toBe(0);
      expect(parseAdminFields([wheelchair], { wheelchair_accessible: "" }).values.wheelchair_accessible).toBeNull();
      expect(parseAdminFields([wheelchair], {}).values.wheelchair_accessible).toBeNull();
    });

    it("falls back to null for anything that is not the exact string 1 or 0", () => {
      // Strict === against strings, so a numeric or boolean body value (which
      // a JSON body, rather than a form POST, would produce) reads as
      // "unknown". Pinned: it fails safe, but it means a JSON caller cannot
      // set this field at all.
      for (const raw of [1, 0, true, false, "yes", "true", "01", " 1", null, undefined]) {
        expect(parseAdminFields([wheelchair], { wheelchair_accessible: raw }).values.wheelchair_accessible, String(raw)).toBeNull();
      }
    });

    it("never reports a required error for a tristate", () => {
      const requiredTri: AdminFieldSpec = { name: "wheelchair_accessible", label: "Wheelchair accessible", kind: "tristate", required: true };
      expect(parseAdminFields([requiredTri], {}).ok).toBe(true);
    });
  });

  describe("text normalisation", () => {
    it("trims surrounding whitespace", () => {
      expect(parseAdminFields([textSpec], { name: "  Brixton Foodbank \n" }).values.name).toBe("Brixton Foodbank");
    });

    it("stores an omitted or blank optional field as null, never as an empty string", () => {
      // D1 columns for these are nullable, and the templates and public API
      // test them with `if not value`. An empty string would render as an
      // empty <p> and serialise as "" in the JSON API instead of being
      // omitted.
      expect(parseAdminFields([optionalSpec], {}).values.notes).toBeNull();
      expect(parseAdminFields([optionalSpec], { notes: "" }).values.notes).toBeNull();
      expect(parseAdminFields([optionalSpec], { notes: "   \t\n " }).values.notes).toBeNull();
    });

    it("reads any non-string body value as absent", () => {
      // c.req.parseBody() yields a File for a file input and an array for a
      // repeated key. Neither is meaningful here, so both read as empty --
      // which for a required field surfaces as "is required" rather than as
      // "[object File]" being written to the column.
      for (const raw of [42, true, null, undefined, ["a", "b"], { toString: () => "x" }]) {
        expect(parseAdminFields([optionalSpec], { notes: raw }).values.notes, String(raw)).toBeNull();
      }
      const parsed = parseAdminFields([textSpec], { name: ["a", "b"] });
      expect(parsed).toMatchObject({ ok: false, error: "Name is required" });
    });

    it("trims the invisible whitespace a paste brings with it, not just spaces", () => {
      // String.prototype.trim strips the full Unicode whitespace set, so a
      // non-breaking space or a BOM pasted from Word or a spreadsheet cannot
      // masquerade as a filled-in required field. This is the case a
      // hand-rolled `value !== ""` check would miss.
      expect(parseAdminFields([textSpec], { name: "\u00A0\u00A0" })).toMatchObject({ ok: false, error: "Name is required" });
      expect(parseAdminFields([textSpec], { name: "\uFEFF Brixton \u00A0" }).values.name).toBe("Brixton");
    });

    it("keeps interior whitespace, accents and emoji exactly as typed", () => {
      // Only the ENDS are trimmed. Food bank names really do carry accents
      // and non-Latin script (Welsh alt_name, for one), and normalising or
      // stripping them here would rewrite the row's slug on the next save.
      expect(parseAdminFields([textSpec], { name: "  Banc Bwyd Pen-y-bont ar Ogwr  " }).values.name).toBe("Banc Bwyd Pen-y-bont ar Ogwr");
      expect(parseAdminFields([textSpec], { name: "Café  du   Marché" }).values.name).toBe("Café  du   Marché");
      expect(parseAdminFields([optionalSpec], { notes: "line one\nline two" }).values.notes).toBe("line one\nline two");
      expect(parseAdminFields([optionalSpec], { notes: "🥫 tins" }).values.notes).toBe("🥫 tins");
    });

    it("passes a very long value straight through", () => {
      // No max_length was ported (routes/admin/slugRedirect.ts:44 says so in
      // as many words). Pinned so the absence stays a known gap rather than
      // an assumed check: a 20k-character note reaches D1 intact.
      const long = "x".repeat(20000);
      expect(parseAdminFields([optionalSpec], { notes: `  ${long}  ` }).values.notes).toBe(long);
    });

    it("does not mutate the body it was handed", () => {
      // The routes pass c.req.parseBody()'s object straight in and then go on
      // to read csrf_token and other keys out of it (foodbankUrls.ts:33-37).
      // Normalising in place -- trimming or space-stripping the caller's
      // object -- would work perfectly here and corrupt them.
      const body: Record<string, unknown> = { name: "  Brixton  ", phone_number: "01234 567 890", csrf_token: "  abc  " };
      const snapshot = { ...body };
      parseAdminFields(fieldsByName(["name", "phone_number"]), body);
      expect(body).toEqual(snapshot);
    });
  });

  describe("required fields", () => {
    it("reports '<label> is required' using the label, not the field name", () => {
      // The error is rendered to the admin, so it must read like the form:
      // "Latitude, Longitude is required", not "lat_lng is required".
      const parsed = parseAdminFields(fieldsByName(["lat_lng"]), {});
      expect(parsed).toMatchObject({ ok: false, error: "Latitude, Longitude is required" });
    });

    it("treats whitespace-only input as empty", () => {
      // Trim happens BEFORE the required test, so a space bar keypress cannot
      // satisfy a required field and write " " into a NOT NULL column.
      expect(parseAdminFields([textSpec], { name: "   " })).toMatchObject({ ok: false, error: "Name is required" });
    });

    it("reports only the FIRST failure, in spec order", () => {
      // Django surfaces the first error on a field and the route renders a
      // single message. Later failures must not overwrite the first, or the
      // admin is told about field 30 while field 1 is the one they skipped.
      const parsed = parseAdminFields(fieldsByName(["name", "address", "postcode"]), {});
      expect(parsed).toMatchObject({ ok: false, error: "Name is required" });
    });

    it("skips a leading valid field and reports the first field that actually failed", () => {
      const parsed = parseAdminFields(fieldsByName(["name", "address", "postcode"]), { name: "Brixton" });
      expect(parsed).toMatchObject({ ok: false, error: "Address is required" });
    });

    it("orders missing-value and bad-format errors purely by spec position", () => {
      // The sharper version of the test above: "first" must mean first in the
      // spec list, not "required errors before format errors". An
      // implementation that ran a required pass and then a validation pass
      // would pass every other test here and still tell the admin their name
      // is missing when the thing they got wrong is the postcode two fields
      // above it. Both directions asserted, since only one ordering can be
      // right and each half alone is satisfiable by the wrong rule.
      const postcodeFirst = parseAdminFields(fieldsByName(["postcode", "name"]), { postcode: "rubbish" });
      expect(postcodeFirst).toMatchObject({ ok: false, error: "Postcode is not a valid postcode" });
      const nameFirst = parseAdminFields(fieldsByName(["name", "postcode"]), { postcode: "rubbish" });
      expect(nameFirst).toMatchObject({ ok: false, error: "Name is required" });
      // Same again with an email format error, so the rule is not accidental
      // to the postcode branch.
      const emailFirst = parseAdminFields(fieldsByName(["contact_email", "name"]), { contact_email: "nope" });
      expect(emailFirst).toMatchObject({ ok: false, error: "Contact email is not a valid email address" });
    });

    it("reports a required select by its label like any other field", () => {
      // `country` is the only required select on a full form, and the routes
      // define more ad-hoc spec lists of their own (slugRedirect.ts,
      // orderGroup.ts). The required check runs off `spec.required` alone, so
      // it must not be quietly limited to the text-ish kinds.
      const country = specFor(FOODBANK_FIELDS, "country");
      expect(parseAdminFields([country], {})).toMatchObject({ ok: false, error: "Country is required" });
      expect(parseAdminFields([country], { country: "   " })).toMatchObject({ ok: false, error: "Country is required" });
      expect(parseAdminFields([country], { country: "  England  " })).toEqual({ ok: true, values: { country: "England" } });
    });

    it("still returns every parsed value alongside the error", () => {
      // gfadmin/views.py:825-856's `if request.POST:` has no else, so an
      // invalid submission re-renders the BOUND form with the admin's typing
      // intact. Parsing therefore runs to completion past the first failure:
      // dropping out early would hand the route an empty form to re-render
      // and lose everything the admin typed.
      const parsed = parseAdminFields(fieldsByName(["name", "address", "notes", "is_closed"]), {
        address: "12 High Street",
        notes: "  kept  ",
        is_closed: "on",
      });
      expect(parsed.ok).toBe(false);
      expect(parsed.values).toEqual({ name: null, address: "12 High Street", notes: "kept", is_closed: 1 });
    });
  });

  describe("postcode validation", () => {
    const postcode = specFor(FOODBANK_FIELDS, "postcode");

    it("accepts the formats const/general.py:176's regex allows", () => {
      // Ported as the literal source string, so these are the real Royal Mail
      // and overseas-territory forms Django accepted: normal, unspaced, the
      // GIR 0AA special case, BFPO and the Caribbean territories.
      for (const value of ["EX10 8LZ", "SW1A 1AA", "SW1A1AA", "M1 1AE", "GIR 0AA", "BFPO 1234", "AI-2640", "KY1-1104"]) {
        expect(parseAdminFields([postcode], { postcode: value }).ok, value).toBe(true);
      }
    });

    it("covers every branch of the ported regex, including the overseas ones", () => {
      // The module says the pattern was ported "as the literal source string,
      // not paraphrased, so it stays byte-comparable against the original".
      // That claim is only worth anything if the alternations are exercised:
      // the eight territory prefixes (ASCN/STHL/TDCU/BBND/[BFS]IQQ/PCRN/TKCA)
      // and the GE CX / SAN TA1 specials are single-postcode branches that a
      // careless retyping of the regex would drop without any normal UK
      // postcode noticing.
      const valid = [
        "ASCN 1ZZ", "STHL 1ZZ", "TDCU 1ZZ", "BBND 1ZZ",
        "BIQQ 1ZZ", "FIQQ 1ZZ", "SIQQ 1ZZ",
        "PCRN 1ZZ", "TKCA 1ZZ",
        "GE CX", "GECX", "SAN TA1", "SANTA1",
        "MSR 1110", "MSR-1110", "VG1110", "VG 1110", "AI 2640",
        "W1A 0AX", "EC1A 1BB", "B33 8TH", "DN55 1PT",
      ];
      for (const value of valid) expect(parseAdminFields([postcode], { postcode: value }).ok, value).toBe(true);
    });

    it("holds the numeric boundaries the regex spells out", () => {
      // BFPO takes one to four digits, GIR takes 0AA and nothing else, and
      // the Caribbean codes take exactly four. These are the off-by-one edges
      // that survive a "simplification" of the pattern into `\d+`.
      expect(parseAdminFields([postcode], { postcode: "BFPO 1" }).ok).toBe(true);
      expect(parseAdminFields([postcode], { postcode: "BFPO 1234" }).ok).toBe(true);
      expect(parseAdminFields([postcode], { postcode: "BFPO 12345" }).ok).toBe(false);
      expect(parseAdminFields([postcode], { postcode: "GIR 0AA" }).ok).toBe(true);
      expect(parseAdminFields([postcode], { postcode: "GIR 0AB" }).ok).toBe(false);
      expect(parseAdminFields([postcode], { postcode: "GIR 0AAA" }).ok).toBe(false);
      expect(parseAdminFields([postcode], { postcode: "KY1-1104" }).ok).toBe(true);
      expect(parseAdminFields([postcode], { postcode: "KY1-11045" }).ok).toBe(false);
    });

    it("accepts a bare outward code, because Django's own regex does", () => {
      // Pinning a genuine looseness rather than endorsing it. The
      // `[A-Z]{2} ?[0-9]{2}` alternation (there for the two-letter overseas
      // codes) also matches "EX10" and "EX 10" -- a half-typed postcode that
      // no geocoder will resolve. It is Django's regex verbatim, so it is
      // parity, not a porting mistake; a future tightening here would start
      // rejecting values already sitting in the postcode column.
      expect(parseAdminFields([postcode], { postcode: "EX10" }).ok).toBe(true);
      expect(parseAdminFields([postcode], { postcode: "EX 10" }).ok).toBe(true);
    });

    it("uppercases locale-independently, so a Turkish locale cannot break it", () => {
      // `.toUpperCase()`, NOT `.toLocaleUpperCase()`. Under tr-TR the latter
      // maps "i" to a dotted capital İ, which the ASCII-only regex rejects --
      // so a swap to the locale-aware call would reject "biqq 1zz" on a box
      // whose locale happened to be Turkish and nowhere else, which is about
      // the worst failure mode available. The i-bearing postcodes are the
      // ones that catch it.
      expect(parseAdminFields([postcode], { postcode: "biqq 1zz" }).ok).toBe(true);
      expect(parseAdminFields([postcode], { postcode: "gir 0aa" }).ok).toBe(true);
    });

    it("cannot be satisfied by hiding rubbish after a newline", () => {
      // trim() only strips the ends, and the regex is anchored with no `m`
      // flag, so an interior newline fails outright rather than validating
      // the first line and storing both. In Python `$` would have matched
      // before a TRAILING newline -- this port is stricter, in the safe
      // direction, and the value is trimmed before it is tested anyway.
      expect(parseAdminFields([postcode], { postcode: "EX10 8LZ\nrubbish" }).ok).toBe(false);
      expect(parseAdminFields([postcode], { postcode: "rubbish\nEX10 8LZ" }).ok).toBe(false);
      expect(parseAdminFields([postcode], { postcode: "\nEX10 8LZ\n" })).toEqual({ ok: true, values: { postcode: "EX10 8LZ" } });
    });

    it("rejects malformed postcodes with '<label> is not a valid postcode'", () => {
      for (const value of ["NOT A POSTCODE", "EX10  8LZ", "12345", "EX10 8L", "EX10-8LZ", "EX10 8LZ extra"]) {
        expect(parseAdminFields([postcode], { postcode: value }), value).toMatchObject({
          ok: false,
          error: "Postcode is not a valid postcode",
        });
      }
    });

    it("accepts a lowercase postcode, the module's stated divergence from Django", () => {
      // Django's regex is upper-case-only with no clean_postcode(), so real
      // Django genuinely 400s on "ex10 8lz". The port uppercases before
      // testing on purpose -- rejecting a case difference the admin plainly
      // did not intend serves no one.
      expect(parseAdminFields([postcode], { postcode: "ex10 8lz" }).ok).toBe(true);
    });

    it("stores the postcode exactly as typed, including that lowercase", () => {
      // The other half of the divergence, pinned because it has a downstream
      // consequence: only the COMPARISON is uppercased, the stored value is
      // not, so "ex10 8lz" reaches D1 lowercase. dupePostcodes.ts groups on
      // the raw string and its comment assumes "uppercase alphanumerics".
      // Reported rather than fixed.
      expect(parseAdminFields([postcode], { postcode: "  ex10 8lz  " }).values.postcode).toBe("ex10 8lz");
    });

    it("skips validation entirely when an optional postcode is blank", () => {
      // FoodbankLocation's postcode is optional (mobile locations have none).
      // Running the regex on "" would reject every mobile location.
      const locationPostcode = specFor(FOODBANK_LOCATION_FIELDS, "postcode");
      expect(parseAdminFields([locationPostcode], { postcode: "" })).toEqual({ ok: true, values: { postcode: null } });
      expect(parseAdminFields([locationPostcode], {})).toEqual({ ok: true, values: { postcode: null } });
    });

    it("validates by field NAME, so every model's postcode gets the same check", () => {
      // base.py:63-69 attaches the RegexValidator on PhysicalPlace, which
      // Foodbank, FoodbankLocation and FoodbankDonationPoint all inherit.
      // The port keys off the name rather than the kind, so all three lists
      // are covered by one rule.
      for (const list of [FOODBANK_FIELDS, FOODBANK_LOCATION_FIELDS, FOODBANK_DONATION_POINT_FIELDS]) {
        expect(parseAdminFields([specFor(list, "postcode")], { postcode: "rubbish" }).ok).toBe(false);
      }
      // The other half of "by name": it is an exact match, so it is the NAME
      // and not the kind doing the work. A text field that merely holds a
      // postcode-shaped value is untouched...
      expect(parseAdminFields([{ name: "delivery_address", label: "Delivery address", kind: "text", required: false }], {
        delivery_address: "rubbish",
      }).ok).toBe(true);
      // ...and so is any differently-named postcode field an ad-hoc spec list
      // might introduce (the routes build their own -- slugRedirect.ts,
      // orderGroup.ts). Pinned so the limitation is known rather than
      // assumed away.
      expect(parseAdminFields([{ name: "delivery_postcode", label: "Delivery postcode", kind: "text", required: false }], {
        delivery_postcode: "rubbish",
      })).toEqual({ ok: true, values: { delivery_postcode: "rubbish" } });
      // The check does not care about the kind either: a postcode declared as
      // a textarea is still validated.
      expect(parseAdminFields([{ name: "postcode", label: "Postcode", kind: "textarea", required: false }], {
        postcode: "rubbish",
      }).ok).toBe(false);
    });

    it("reports 'is required' rather than 'not a valid postcode' when it is empty", () => {
      expect(parseAdminFields([postcode], { postcode: "" })).toMatchObject({ ok: false, error: "Postcode is required" });
    });
  });

  describe("email validation", () => {
    it("rejects a malformed value on an email-kind field", () => {
      const parsed = parseAdminFields(fieldsByName(["contact_email"]), { contact_email: "not-an-email" });
      expect(parsed).toMatchObject({ ok: false, error: "Contact email is not a valid email address" });
    });

    it("uses the field's own label in the message", () => {
      const parsed = parseAdminFields(fieldsByName(["notification_email"]), { notification_email: "nope@" });
      expect(parsed).toMatchObject({ ok: false, error: "Notification email is not a valid email address" });
    });

    it("leaves a blank optional email alone", () => {
      // notification_email is blank=True on the model; validating "" would
      // make it impossible to clear.
      expect(parseAdminFields(fieldsByName(["notification_email"]), { notification_email: "  " })).toEqual({
        ok: true,
        values: { notification_email: null },
      });
    });

    it("validates after trimming, so a pasted address with spaces still passes", () => {
      expect(parseAdminFields(fieldsByName(["contact_email"]), { contact_email: " info@example.org " })).toEqual({
        ok: true,
        values: { contact_email: "info@example.org" },
      });
    });

    it("says 'is required', not 'is not valid', for a missing required email", () => {
      // contact_email is the only required email on a full form. The format
      // check is gated on the trimmed value being non-empty, so the two
      // messages can never both fire -- and the one the admin sees has to be
      // the actionable one.
      expect(parseAdminFields(fieldsByName(["contact_email"]), {})).toMatchObject({ ok: false, error: "Contact email is required" });
      expect(parseAdminFields(fieldsByName(["contact_email"]), { contact_email: "  " })).toMatchObject({
        ok: false,
        error: "Contact email is required",
      });
    });

    it("refuses an address carrying a newline, which would become a mail header", () => {
      // notification_email is used verbatim as the `to:` of an outbound order
      // notification (routes/admin/orderActions.ts:113). trim() strips only
      // the ends, so an interior CRLF is exactly the header-injection payload
      // this shape check has to stop -- and it is the only thing standing
      // between the admin form and the mail API.
      expect(parseAdminFields(fieldsByName(["notification_email"]), { notification_email: "info@example.org\nBcc: evil@example.org" })).toMatchObject({
        ok: false,
        error: "Notification email is not a valid email address",
      });
      expect(parseAdminFields(fieldsByName(["notification_email"]), { notification_email: "info@example.org\r\nSubject: x" })).toMatchObject({
        ok: false,
        error: "Notification email is not a valid email address",
      });
      // A trailing newline alone is fine, because trim() removes it before
      // the check ever runs, and the stored value has no newline in it.
      expect(parseAdminFields(fieldsByName(["notification_email"]), { notification_email: "info@example.org\n" })).toEqual({
        ok: true,
        values: { notification_email: "info@example.org" },
      });
    });

    it("validates only email-kind fields, so a text field may hold anything", () => {
      // The trigger is `spec.kind === "email"` alone. `contact_email` and
      // `notification_email` are the two on Foodbank; `name` sitting next to
      // them must not inherit the rule, or no food bank could be called
      // anything without an @ in it.
      expect(parseAdminFields(fieldsByName(["name"]), { name: "not-an-email" }).ok).toBe(true);
      expect(specFor(FOODBANK_FIELDS, "contact_email").kind).toBe("email");
      const emailKinded = FOODBANK_FIELDS.filter((f) => f.kind === "email").map((f) => f.name);
      expect(emailKinded).toEqual(["contact_email", "notification_email"]);
    });

    it("agrees with isValidEmail rather than keeping a second copy of the rule", () => {
      // useAi.ts imports isValidEmail for exactly this reason. If the two ever
      // diverged, a value the AI-suggestion route accepted would be rejected
      // by the form that shows it, and vice versa.
      for (const value of ["a@b.c", "bad", "a@b", "x y@z.com", "josé@example.org", "a..b@c..d", "info@localhost", "!#$%@example.org"]) {
        const viaForm = parseAdminFields(fieldsByName(["contact_email"]), { contact_email: value }).ok;
        expect(viaForm, value).toBe(isValidEmail(value));
      }
    });
  });

  describe("phone number normalisation", () => {
    it("strips spaces from phone_number and secondary_phone_number", () => {
      // foodbank.py:648-652 does `.replace(" ","")` in save(). This is not
      // cosmetic: friendly_phone/full_phone re-space the number BY CHARACTER
      // POSITION, so an unstripped "01234 567 890" renders back mangled on
      // every public and admin page, with a broken tel: href.
      const parsed = parseAdminFields(fieldsByName(["phone_number", "secondary_phone_number"]), {
        phone_number: " 01234 567 890 ",
        secondary_phone_number: "020 7946 0000",
      });
      expect(parsed.values).toEqual({ phone_number: "01234567890", secondary_phone_number: "02079460000" });
    });

    it("leaves delivery_phone_number's spaces alone, matching Django exactly", () => {
      // foodbank.py:103 declares delivery_phone_number and save() never
      // touches it. Stripping it here would be a FRESH divergence from Django
      // rather than a fix, so the omission is deliberate.
      const parsed = parseAdminFields(fieldsByName(["delivery_phone_number"]), { delivery_phone_number: "01234 567 890" });
      expect(parsed.values.delivery_phone_number).toBe("01234 567 890");
    });

    it("strips literal single spaces only, not all whitespace", () => {
      // `.split(" ").join("")` mirrors Python's str.replace(" ", ""), not a
      // /\s+/g sweep. A tab therefore survives -- pinned because useAi.ts's
      // own strip DOES use /\s+/g, so the two paths differ on exotic input.
      expect(parseAdminFields(fieldsByName(["phone_number"]), { phone_number: "01234\t567" }).values.phone_number).toBe("01234\t567");
      // The NBSP written as an escape rather than typed: a literal one here
      // is invisible in the diff, which is the whole reason it survives the
      // strip in production too.
      expect(parseAdminFields(fieldsByName(["phone_number"]), { phone_number: "01234\u00A0567" }).values.phone_number).toBe("01234\u00A0567");
    });

    it("turns an all-spaces phone number into null, not an empty string", () => {
      // Trim runs first, so this is already "" before the strip; the null
      // conversion then applies as it does to any other empty text field.
      expect(parseAdminFields(fieldsByName(["phone_number"]), { phone_number: "   " }).values.phone_number).toBeNull();
    });

    it("does not strip spaces from other fields that happen to hold digits", () => {
      // Only the two named fields are in SPACE_STRIPPED_FIELDS. A charity
      // number or a lat_lng pair must keep its spacing.
      const parsed = parseAdminFields(fieldsByName(["charity_number", "lat_lng"]), {
        charity_number: "SC 041954",
        lat_lng: "50.6906, -3.2400",
      });
      expect(parsed.values).toEqual({ charity_number: "SC 041954", lat_lng: "50.6906, -3.2400" });
    });

    it("strips by field NAME, so a location's or donation point's phone is stripped too", () => {
      // SPACE_STRIPPED_FIELDS is keyed on the name, and foodbank.py:956-958
      // (FoodbankLocation) and :1288-1290 (FoodbankDonationPoint) run the
      // same `.replace(" ","")` in their own save(). The re-spacing filter
      // that mangles an unstripped number renders location and donation point
      // numbers too, so all three models have to agree.
      expect(parseAdminFields([specFor(FOODBANK_LOCATION_FIELDS, "phone_number")], { phone_number: "020 7946 0000" }).values.phone_number).toBe(
        "02079460000",
      );
      expect(
        parseAdminFields([specFor(FOODBANK_DONATION_POINT_FIELDS, "phone_number")], { phone_number: "020 7946 0000" }).values.phone_number,
      ).toBe("02079460000");
    });

    it("trims a non-breaking space off the ends even though it cannot strip one inside", () => {
      // The asymmetry is worth stating because a paste from a web page is
      // exactly where NBSPs come from: trim() knows the whole Unicode
      // whitespace set, `.split(" ")` knows only U+0020. So an NBSP at the
      // ends disappears and one in the middle survives -- which is also what
      // Python's strip()/replace(" ","") pair does, so it is parity rather
      // than a gap. Written as an escape because the character is invisible.
      expect(parseAdminFields(fieldsByName(["phone_number"]), { phone_number: "\u00A001234 567 890\u00A0" }).values.phone_number).toBe(
        "01234567890",
      );
    });
  });

  describe("what it deliberately does NOT validate", () => {
    it("accepts a select value that is not one of the field's options", () => {
      // Pinning current behaviour. Django's ChoiceField would reject this;
      // here the <select> is the only thing constraining the value, so a
      // hand-crafted POST can store an off-list country or company. The
      // module comment warns that an off-list company "silently mints a new
      // company with a broken icon" -- that warning is about the UI, and this
      // is the hole it does not cover. Reported rather than fixed.
      const parsed = parseAdminFields(fieldsByName(["country"]), { country: "Narnia" });
      expect(parsed).toEqual({ ok: true, values: { country: "Narnia" } });
      // The company case is the one with a visible consequence, so assert it
      // rather than assume it generalises: "Tescos" is not in the 25, and
      // nothing here stops it becoming a company_slug with no logo behind it.
      const company = specFor(FOODBANK_DONATION_POINT_FIELDS, "company");
      expect(company.options).not.toContain("Tescos");
      expect(parseAdminFields([company], { company: "Tescos" })).toEqual({ ok: true, values: { company: "Tescos" } });
      // Case matters as much as spelling, and is not corrected either.
      expect(parseAdminFields([company], { company: "tesco" }).values.company).toBe("tesco");
    });

    it("accepts anything at all in a url-kind field", () => {
      // Deliberate per the module comment: only the postcode regex and the
      // email shape are ported. URL checking lives in the route that needs it
      // (useAi.ts's isValidUrl), because Django's URLField validation was not
      // what stopped bad URLs here.
      const parsed = parseAdminFields(fieldsByName(["url"]), { url: "definitely not a url" });
      expect(parsed).toEqual({ ok: true, values: { url: "definitely not a url" } });
    });

    it("does no cross-field checking", () => {
      // Model.clean() rules need sibling fields or the parent row, so they
      // live with their routes (foodbank.ts's phoneClashError,
      // donationPoint.ts's co-location check). Two identical phone numbers
      // are fine as far as this function is concerned.
      const parsed = parseAdminFields(fieldsByName(["phone_number", "secondary_phone_number"]), {
        phone_number: "01234567890",
        secondary_phone_number: "01234567890",
      });
      expect(parsed.ok).toBe(true);
    });
  });

  it("only ever produces string, number or null values", () => {
    // AdminFieldValue's runtime guarantee. These go straight into D1 bind
    // parameters, which reject anything else, so a stray boolean or object
    // would be a 500 at save time rather than a type error at build time.
    const parsed = parseAdminFields(FOODBANK_FIELDS, {
      name: "Sid Valley Foodbank",
      address: "12 High Street",
      postcode: "EX10 8LZ",
      country: "England",
      lat_lng: "50.6906,-3.2400",
      contact_email: "info@example.org",
      url: "https://example.org/",
      shopping_list_url: "https://example.org/list/",
      is_closed: "on",
      phone_number: "01234 567 890",
    });
    expect(parsed.ok).toBe(true);
    const values: Record<string, AdminFieldValue> = parsed.values;
    // Every one of the 31 fields must be present -- a partially populated
    // object would leave columns out of the UPDATE and silently keep stale
    // values for anything the admin cleared. Asserted in SPEC ORDER, not
    // sorted: packages/db/src/foodbankAdmin.ts:190-196 builds the SET clause
    // straight off Object.entries(), so the key order is what the generated
    // SQL looks like, and a sorted comparison would pass for an
    // implementation that iterated the body instead of the specs.
    expect(Object.keys(values)).toEqual(FOODBANK_FIELDS.map((f) => f.name));
    for (const [name, value] of Object.entries(values)) {
      expect(["string", "number", "object"], name).toContain(typeof value);
      if (typeof value === "object") expect(value, name).toBeNull();
    }
  });

  it("handles every partial form's real spec list end to end", () => {
    // The four collapsed forms share one handler, so one broken config takes
    // down whichever form owns it. Drive each with a plausible body.
    const bodies: Record<string, Record<string, unknown>> = {
      address: { address: "12 High Street", postcode: "EX10 8LZ", lat_lng: "50.6906,-3.2400", place_id: "" },
      phone: { phone_number: "01234 567 890", secondary_phone_number: "", delivery_phone_number: "01234 000 111" },
      email: { contact_email: "info@example.org", notification_email: "" },
      "fsa-id": { fsa_id: "12345" },
    };
    for (const config of FOODBANK_PARTIAL_FORMS) {
      const parsed = parseAdminFields(fieldsByName(config.fieldNames), bodies[config.slug]!);
      expect(parsed.ok, config.slug).toBe(true);
      expect(Object.keys(parsed.values), config.slug).toEqual([...config.fieldNames]);
    }
    // And the phone form's normalisation, since that is the one with a
    // save()-time rewrite behind it.
    const phone = parseAdminFields(fieldsByName(FOODBANK_PARTIAL_FORMS[1]!.fieldNames), bodies.phone!);
    expect(phone.values).toEqual({
      phone_number: "01234567890",
      secondary_phone_number: null,
      delivery_phone_number: "01234 000 111",
    });
  });
});
