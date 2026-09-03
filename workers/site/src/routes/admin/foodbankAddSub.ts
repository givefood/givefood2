import type { Context } from "hono";
import { getFoodbankBySlug, insertConfirmedSubscribers, type AdminSubscriberInsert } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { EMAIL_RE } from "../../lib/fields";
import { generateSubUnsubKeys } from "../../lib/subscriberKeys";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:1594-1612 foodbank_addsub, registered
// gfadmin/urls/foodbanks.py:37. Bulk-add email subscribers to one food bank
// by pasting newline-separated addresses.
//
// Django's mutation branch is a bare `if request.POST:` at views.py:1599 --
// not @require_POST, and with Django's CSRF middleware commented out in
// production (settings.py:97) the {% csrf_token %} in addsub.html is
// decorative. Here the mutation is POST-only and CSRF-verified, the same
// correction every other ported admin mutation gets (PLAN.md §6.9 R3).
//
// ENTRY POINT: Django links this page from NOWHERE -- a repo-wide grep for
// "addsub" across foodcharity hits only views.py:1594, views.py:1612 and
// urls/foodbanks.py:37. It is a type-the-URL-only page there. The port
// should not inherit an unreachable page, so the subscribers tab gains an
// "Add Subscribers" button (see this WP's wiring notes).
const RESULTS_INVALID_DISPLAY_LIMIT = 50;

interface AddSubResults {
  added: number;
  already: number;
  /**
   * Lines dropped because the same address appeared earlier in the SAME
   * paste. Counted separately so that added + already + duplicates +
   * invalid_total equals the number of non-blank lines submitted -- these
   * rows never reach the insert, so they belong to none of the other three
   * buckets and would otherwise vanish from the report without explanation.
   */
  duplicates: number;
  invalid: string[];
  invalid_total: number;
}

export async function adminFoodbankAddSub(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const db = dbSession(c);

  const foodbank = await getFoodbankBySlug(db, slug); // views.py:1596 get_object_or_404
  if (!foodbank) return c.notFound();

  // views.py:1597 computes this page_title and then throws it away
  // (`template_vars = {}` at :1611), so Django's own page never names the
  // food bank and renders `class="form-"`. Passed through here.
  const title = `Add Subscriber to ${foodbank.name} Food Bank`;

  let results: AddSubResults | null = null;

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    // views.py:1600-1601 is `request.POST.get("emails").splitlines()` -- a
    // POST without the field makes that None.splitlines(), an unhandled
    // AttributeError -> 500. Defaulting to "" removes that.
    const raw = typeof body.emails === "string" ? body.emails : "";

    // str.splitlines() splits on \n, \r\n and \r, so CRLF is already handled
    // in Django. What is NOT handled there: it never strips, so "  a@b.com "
    // is stored with its spaces, and a blank line becomes email="" which a
    // bare .save() writes happily (EmailField validation only runs through a
    // ModelForm, and this view builds the model directly). Both fixed here.
    const lines = raw
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const valid: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const line of lines) {
      // givefood/models/subscribers.py:41 lowercases in save(), before the
      // unique_together constraint ever sees the value -- so the dedupe
      // below and the ON CONFLICT in the DB layer must both compare the
      // lowercased form or they would miss a real duplicate.
      const email = line.toLowerCase();
      // Django validates nothing at all here: "not an email" is accepted
      // and stored. PLAN.md:9724 prescribes the fix ("validate each
      // address, dedupe against (email, foodbank), report per-line
      // results"). EMAIL_RE is lib/fields.ts's shared validator, the same
      // one the public subscribe path (routes/wfbn/updates.ts) uses.
      if (!EMAIL_RE.test(email)) {
        invalid.push(line);
        continue;
      }
      if (seen.has(email)) {
        // The same address twice in one paste. Reported rather than silently
        // dropped: it is neither "added" nor "already subscribed", and the
        // banner's numbers have to account for every line pasted.
        duplicates++;
        continue;
      }
      seen.add(email);
      valid.push(email);
    }

    const rows: AdminSubscriberInsert[] = await Promise.all(
      valid.map(async (email) => ({ email, ...(await generateSubUnsubKeys(c.env.SUBSCRIBER_SALT ?? "")) })),
    );

    // confirmed = 1 is deliberate, not an oversight: views.py:1606 sets
    // confirmed=True, which is the documented manual escape hatch out of
    // the double opt-in the public /needs/at/<slug>/updates/subscribe/ flow
    // enforces. The page says so in as many words, so an operator knows
    // what they are doing rather than discovering it later.
    const added = await insertConfirmedSubscribers(db, foodbank.id, foodbank.name, rows);

    results = {
      added,
      // `valid` has already had the intra-paste repeats removed, so this is
      // strictly "was in the DB before this submission" -- the rows the
      // ON CONFLICT above swallowed. The repeats are reported as their own
      // number, not folded in here, because they are a different fact.
      already: valid.length - added,
      duplicates,
      invalid: invalid.slice(0, RESULTS_INVALID_DISPLAY_LIMIT),
      invalid_total: invalid.length,
    };
    // Django redirects to admin:foodbank here (views.py:1609), which is
    // precisely what makes its "no feedback at all" defect unfixable --
    // a bare 302 can't say "3 added, 1 already subscribed, 2 rejected".
    // Rendering the report instead is PLAN.md:9724's "report per-line
    // results"; the page carries a Back link to the same destination.
  }

  const html = await render("admin/addsub.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    title,
    foodbank,
    results,
  });
  return c.html(html);
}
