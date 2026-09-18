import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The food bank page's Needs & Orders tab had no New Order button. Django
// heads each of the tab's two columns with one (foodbank.html:461 New Need,
// :509 New Order); the port's handler passed foodbank_slug for them
// (foodbankDetail.ts) but the template never rendered either. The detail
// page's own New Order shortcut only shows while a food bank has NO orders,
// so for every food bank that already had one there was no way into
// /admin/order/new/ at all.
//
// Source-level, like needNotifyButton.test.ts and for the same reason: the
// route suites mock render() and assert context, never markup.

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url).href);
const SOURCE = readFileSync(join(TEMPLATES_DIR, "admin/foodbank_tabs/needsorders.njk"), "utf8").replace(/\{#[\s\S]*?#\}/g, "");

describe("admin/foodbank_tabs/needsorders.njk", () => {
  it.each([
    ["New Need", "/admin/need/new/"],
    ["New Order", "/admin/order/new/"],
  ])("renders a %s button preselecting the food bank", (label, path) => {
    expect(SOURCE).toContain(`<a href="${path}?foodbank={{ foodbank_slug }}" class="button is-link is-light">${label}</a>`);
  });

  // Unlike the detail page's shortcut, these must not hide behind a count.
  it("renders the New Order button outside the orders.length branch", () => {
    expect(SOURCE.indexOf(">New Order</a>")).toBeLessThan(SOURCE.indexOf("{% if orders.length %}"));
  });
});
