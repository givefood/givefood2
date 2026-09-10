import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { render } from "@givefood/templates";
import { FOODBANK_DONATION_POINT_FIELDS } from "../../lib/adminFormFields";

// The company auto-select on the donation point form (github #57).
//
// Three things have to line up for it to work, and each has broken once:
// the shipped script's event, the form's class, and the two field ids. None
// of them is exercised by any other test -- static/js/admin.js is a shipped
// asset with no build step and no import, so nothing type-checks it and
// nothing runs it. This file reads the bytes actually served and the markup
// actually rendered, and checks they still agree.
const ADMIN_JS: string = readFileSync(
  fileURLToPath(new URL("../../../dist/static/static/js/admin.js", import.meta.url)),
  "utf8",
);

async function donationPointForm(title: string): Promise<string> {
  return render("admin/generic_form.njk", {
    title,
    subtitle: "Alfreton Foodbank",
    fields: FOODBANK_DONATION_POINT_FIELDS,
    data: {},
    delete_url: null,
    error: null,
    csrf_token: "x",
  });
}

// Runs THE SHIPPED SCRIPT, rather than a re-implementation of its loop. A
// hand-rolled copy of the algorithm here would agree with any change made to
// admin.js, including one that broke it -- which is the whole failure mode
// this file exists to catch. So admin.js is evaluated against a DOM small
// enough to describe: the two controls it needs, plus the stubs its other
// five initialisers touch on their way to returning early.
function runShippedAutoSelect(name: string, optionValues: string[]): string {
  const options = optionValues.map((value) => ({ value, _sel: false }));
  for (const o of options) {
    Object.defineProperty(o, "selected", {
      get: () => o._sel,
      // Single-select semantics: selecting one deselects the rest, which is
      // what makes "last match wins" the real behaviour.
      set: (v: boolean) => { if (v) options.forEach((x) => (x._sel = false)); o._sel = !!v; },
    });
  }
  const companyField = { options, get value() { return options.filter((o) => o._sel).pop()?.value ?? ""; } };

  const listeners: Record<string, Array<() => void>> = {};
  const nameField = {
    value: "",
    parentNode: { insertBefore: () => {} },
    nextSibling: null,
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); },
  };

  const el = () => ({ innerHTML: "", addEventListener: () => {}, style: {}, classList: { toggle: () => {} } });
  const document = {
    querySelector: (sel: string) =>
      sel.includes("#id_company") ? companyField : sel.includes("#id_name") && sel.includes("donation-point") ? nameField : null,
    querySelectorAll: () => [],
    createElement: el,
  };

  new Function("document", "gmap_geocode_key", "gmap_places_key", "gmap_static_key", ADMIN_JS)(document, "", "", "");

  nameField.value = name;
  // `input`, deliberately: this is the event the fix switched to, so a revert
  // to keyup leaves these listeners unfired and every expectation below fails.
  for (const fn of listeners.input ?? []) fn();
  return companyField.value;
}

function companyOptions(html: string): string[] {
  const select = html.slice(html.indexOf('<select id="id_company"'));
  return [...select.slice(0, select.indexOf("</select>")).matchAll(/<option value="([^"]*)"/g)].map((m) =>
    m[1]!.replace(/&amp;/g, "&").replace(/&#39;/g, "'"),
  );
}

describe("the shipped admin.js", () => {
  // THE #57 FIX, pinned because it is the one line where this file
  // deliberately differs from givefood/static/js/admin.js. A future "restore
  // parity, diff against Django" pass would otherwise revert it silently and
  // the bug would come back exactly as reported: a pasted or autofilled
  // donation point name fires no keystroke, so a keyup listener never runs
  // and the company is left unset.
  it("auto-selects the company on input, not keyup", () => {
    const fn = ADMIN_JS.slice(ADMIN_JS.indexOf("function initCompanyAutoSelect"));
    const body = fn.slice(0, fn.indexOf("\n}"));

    expect(body).toContain('addEventListener("input"');
    expect(body).not.toContain('addEventListener("keyup"');
  });

  // The selectors the feature is gated on. admin.js:106 and :110.
  it("still selects the fields the donation point form renders", async () => {
    for (const title of ["New Donation Point", "Edit Donation Point"]) {
      const html = await donationPointForm(title);
      const slug = title.toLowerCase().replace(/ /g, "-");

      // The class comes from `form-{{ title|slugify }}`; interpolating the
      // food bank name into the title once broke exactly this (3b31087).
      expect(html, title).toContain(`class="form-${slug}"`);
      const form = html.slice(html.indexOf(`class="form-${slug}"`));
      const inner = form.slice(0, form.indexOf("</form>"));
      expect(inner, title).toContain('id="id_name"');
      expect(inner, title).toContain('id="id_company"');
      // And the script really is looking for those exact names.
      expect(ADMIN_JS).toContain(`.form-${slug} #id_name`);
    }
    expect(ADMIN_JS).toContain('document.querySelector("#id_company")');
  });
});

describe("the company auto-select, against the form's own options", () => {
  it("picks the company out of a donation point name", async () => {
    const options = companyOptions(await donationPointForm("New Donation Point"));

    // The name from the report.
    expect(runShippedAutoSelect("Aldi Alfreton", options)).toBe("Aldi");
    expect(runShippedAutoSelect("Tesco Extra Derby", options)).toBe("Tesco");
    expect(runShippedAutoSelect("Co-op Matlock", options)).toBe("Co-op");
    // An ampersand survives the round trip through the rendered markup.
    expect(runShippedAutoSelect("Marks & Spencer Ripley", options)).toBe("Marks & Spencer");
  });

  it("leaves the company unset for a name that matches nothing", async () => {
    const options = companyOptions(await donationPointForm("New Donation Point"));

    // The blank first option matches EVERY name (`includes("")` is always
    // true), so this only comes out blank because the loop keeps going and
    // the last match wins. Pinned because dropping the blank option, or
    // adding a `break`, would change it.
    expect(runShippedAutoSelect("St Marys Church Hall", options)).toBe("");
    expect(options[0]).toBe("");
  });
});
