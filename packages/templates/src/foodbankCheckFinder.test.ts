import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// GitHub issue #63, "Donation points not found".
//
// On a foodbank.org.uk food bank the found donation points come only from the
// platform's donation point finder (packages/ai/src/foodbankCheck.ts), and
// when it fails -- its action ID is the platform's build artefact and goes
// stale -- every donation point we hold renders with a Delete button beside
// it. The result carries the failure as donationPointFinder.error; this pins
// that the check page shows it.
//
// Source-level, like needNotifyButton.test.ts and for the same reason: the
// route suite mocks render(), and the real renderer reads a gitignored build
// artefact.
//
// Nunjucks comments stripped, so the template's own note about #63 cannot
// satisfy an assertion meant for markup.
const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url).href);
const SOURCE = readFileSync(join(TEMPLATES_DIR, "admin/foodbank_check.njk"), "utf8").replace(/\{#[\s\S]*?#\}/g, "");

const WARNING = /\{% if result\.donationPointFinder and result\.donationPointFinder\.error %\}([\s\S]*?)\{% endif %\}\s*(?=<div class="columns">)/.exec(SOURCE);

describe("the donation point finder warning on admin/foodbank_check.njk", () => {
  it("renders the finder's error, and a link to the finder when there is one", () => {
    expect(WARNING).not.toBeNull();
    expect(WARNING![1]).toContain('class="notification is-warning is-light"');
    expect(WARNING![1]).toContain("{{ result.donationPointFinder.error }}");
    expect(WARNING![1]).toContain('href="{{ result.donationPointFinder.url }}"');
  });

  // The Donation Points rows only render when either side has one, so a
  // warning placed inside them would vanish for a food bank we hold none for
  // -- exactly the one the reviewer most needs told.
  it("sits above the comparison table, outside the donation points gate", () => {
    const warningAt = SOURCE.indexOf("result.donationPointFinder.error");
    expect(warningAt).toBeGreaterThan(-1);
    expect(warningAt).toBeLessThan(SOURCE.indexOf("checktable"));
    expect(warningAt).toBeLessThan(SOURCE.indexOf("{% if result.ourDonationPoints.length or result.foundDonationPoints.length %}"));
  });
});
