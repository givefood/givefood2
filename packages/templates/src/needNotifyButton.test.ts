import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// GitHub issue #37, "Remove confirmation from notification sending button."
//
// The Notify button on /admin/need/<id>/ fires all four channels -- email,
// Firebase, web push, WhatsApp -- and kicks off an article crawl. It had a
// confirm() dialog naming the per-channel counts; #37 removed it, restoring
// Django, whose need.html:124 has no confirmation either.
//
// WHY THIS FILE EXISTS RATHER THAN A LINE IN A ROUTE TEST. The route suites
// mock render() -- packages/templates/src/generated/ is a gitignored build
// artefact, so importing the real renderer would make them depend on a build
// step -- and they assert the CONTEXT handed to the template, never its
// markup. The confirm() and the guard that replaced it live only in the
// markup, so nothing in this repo could see either of them.
//
// Source-level, like templateBalance.test.ts, and for the same reason:
// rendering admin/need.njk needs a bespoke context, and this only has to read
// two attributes.
//
// THE HALF THAT IS NOT IN THE TICKET IS THE HALF THIS FILE IS REALLY FOR.
// adminNeedNotify() (routes/admin/needs.ts) is deliberately NOT idempotent --
// it does not check `notified` before sending, because re-notifying is a
// legitimate thing to do -- so a double press enqueues all four channels
// twice and starts a second crawl. Until #37 the confirm() was the only thing
// between a stray double-click and a second send to every subscribed mailbox.
// Removing it therefore had to put Django's own guard back:
// `onclick="this.form.submit();this.disabled = true;"`, which is
// admin/form.html:14, carried on every other submit button in this port, and
// present on this very button in need.html:124. A future edit that deletes
// the guard "because the confirm is gone" is the regression this catches.
//
// The counts assertion at the bottom is the other half of the same argument:
// the reviewer used to read the audience off the dialog, and now reads it off
// the page. If the "Food Bank Subs" row goes, the Notify button becomes a
// send with no disclosure at all, and needs.test.ts's count assertions would
// still pass -- they check the context, which would still be built.

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url).href);

// Nunjucks comments stripped: the template's own note about #37 quotes both
// `confirm(` and the guard in prose, and matching on that would make every
// assertion below pass on documentation instead of on markup.
const SOURCE = readFileSync(join(TEMPLATES_DIR, "admin/need.njk"), "utf8").replace(/\{#[\s\S]*?#\}/g, "");

const NOTIFY_FORM = /<form[^>]*action="\/admin\/need\/\{\{ need\.need_id \}\}\/notify\/"[\s\S]*?<\/form>/.exec(SOURCE)?.[0];

describe("the Notify button on admin/need.njk", () => {
  // Without this every case below passes vacuously the day the action URL,
  // the filename or the comment syntax changes.
  it("is found in the template at all", () => {
    expect(NOTIFY_FORM).toBeDefined();
    expect(NOTIFY_FORM).toContain("Notify");
    expect(NOTIFY_FORM).toContain('name="csrf_token"');
  });

  // #37 itself.
  it("asks for no confirmation, in either spelling this codebase uses", () => {
    expect(NOTIFY_FORM).not.toContain("confirm(");
    expect(NOTIFY_FORM).not.toContain("hx-confirm");
  });

  // The half #37 did not ask for and could not do without.
  it("carries Django's double-submit guard instead", () => {
    expect(NOTIFY_FORM).toContain("this.form.submit();this.disabled = true;");
  });

  // Not a style check: with the dialog gone this row is the only thing that
  // tells the reviewer how many people the press reaches.
  it("leaves the per-channel subscriber counts on the page that lost the dialog", () => {
    expect(SOURCE).toContain("Food Bank Subs");
    for (const channel of ["email", "whatsapp", "webpush", "mobile"]) {
      // `{{ ... }}`, NOT a bare mention of the name. Every one of these
      // appears twice in the row -- once in the `{% if %}` that hides a zero
      // and once as the number itself -- so a substring match on
      // `subscriber_counts.webpush` stays true after the number is deleted
      // and only the condition is left. Measured: that mutant survived the
      // first version of this assertion.
      expect(SOURCE, channel).toContain(`{{ subscriber_counts.${channel} }}`);
    }
  });
});
