import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// GitHub issue #36, "Need form is broken -- doesn't look anything like the
// original, and is barely usable."
//
// The cause was one stray `</div>` in admin/need_form.njk, left behind when
// the food bank field was removed. It closed `<div class="column">`
// immediately after the CSRF input, so every field, the checkbox and the
// submit button rendered OUTSIDE the Bulma column and lost their width and
// padding; the final `</div>` then closed `.columns` instead, leaving one
// unmatched. Browsers recover from that silently, which is exactly why it
// shipped: nothing errored, nothing logged, the page just looked wrong.
//
// A stray div is invisible to every other kind of test in this repo. The
// route tests assert status codes and context values; the render tests
// assert that a string appears in the output. Both pass on markup whose
// containers have collapsed.
//
// SOURCE-LEVEL, not rendered. Rendering each admin template needs a bespoke
// context per file (40 of them, several with required nested objects), and a
// test that skips the awkward ones would miss precisely the complicated
// templates most likely to grow the bug. Counting tokens in the source
// catches the whole directory for the price of reading it.
//
// Nunjucks comments are stripped first: several of these templates discuss
// `</div>` in prose, including need_form.njk's own note about this fix.

// `.href`, not the URL object -- @cloudflare/workers-types and @types/node
// each declare a global URL and they differ, so node:url's signature rejects
// the one `new URL(...)` produces here. Same clash, and same one-word fix, as
// packages/db/src/schema.testkit.ts.
const TEMPLATES = fileURLToPath(new URL("../templates/admin/", import.meta.url).href);

function divBalance(source: string): { depth: number; closedBeforeOpened: number } {
  const body = source.replace(/\{#[\s\S]*?#\}/g, "");
  let depth = 0;
  let closedBeforeOpened = 0;
  for (const token of body.match(/<div\b|<\/div>/g) ?? []) {
    depth += token.startsWith("<div") ? 1 : -1;
    // Reset rather than let it go negative, so one stray close early in a
    // file does not mask a second one later.
    if (depth < 0) {
      closedBeforeOpened += 1;
      depth = 0;
    }
  }
  return { depth, closedBeforeOpened };
}

// Every admin template, found by reading the directory rather than listed
// here -- a list would silently stop covering templates added later, which
// is the same failure mode as the bug itself.
const FILES = readdirSync(TEMPLATES)
  .filter((name) => name.endsWith(".njk"))
  .sort();

describe("admin templates have balanced <div>s", () => {
  it("finds the admin templates at all", () => {
    // If the path or the extension ever changes, every test below would pass
    // vacuously over an empty list. 30 is comfortably under the real count
    // and does not need updating when a template is added.
    expect(FILES.length).toBeGreaterThan(30);
    expect(FILES).toContain("need_form.njk");
  });

  it.each(FILES)("%s opens and closes every div", (name) => {
    const { depth, closedBeforeOpened } = divBalance(readFileSync(join(TEMPLATES, name), "utf8"));
    // Two separate assertions because they catch different mistakes: a
    // surplus OPEN leaves depth positive and swallows the rest of the page
    // into a container, while a surplus CLOSE ends a container early -- which
    // is the #36 shape, and would still show depth 0 if a later stray open
    // happened to compensate.
    expect({ name, closedBeforeOpened }).toEqual({ name, closedBeforeOpened: 0 });
    expect({ name, depth }).toEqual({ name, depth: 0 });
  });
});
