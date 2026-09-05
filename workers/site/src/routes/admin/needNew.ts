import type { Context } from "hono";
import { getFoodbankBySlug, getOpenFoodbankOptions, insertAdminNeed } from "@givefood/db";
import { cleanFoodbankNeedText } from "@givefood/models";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:1916-1946 need_form, CREATE branch -- GET|POST
// /admin/need/new/ (gfadmin/urls/needs.py:10, where the URL uniquely has
// NO trailing slash; register both spellings, see the WP 6.8 wiring note).
//
// CORRECTION to routes/admin/needs.ts:253-262, which claims "Django's 'new'
// branch is dead: `newneed`'s URL exists but nothing links to it". That is
// factually wrong. gfadmin/templates/admin/foodbank.html:394 (the "Last
// need" column) and :461 (the `needsorders` tab partial) BOTH render a
// "New Need" button at `{% url 'admin:newneed' %}?foodbank={{ foodbank.slug }}`.
// The port's own foodbank_detail.njk and foodbank_tabs/needsorders.njk had
// silently dropped both buttons, which is what made the endpoint look
// unreachable. Creating a need by hand is a real part of the maintainer's
// workflow -- it is what happens when a food bank phones or emails a list in.
//
// Django serves create and edit from ONE view. This port keeps them as two
// handlers (adminNeedEditForm in needs.ts is the edit half) because the two
// differ in every way that matters -- INSERT vs UPDATE, a redirect target
// that does not exist yet vs one that does, and a `?foodbank=` seed with no
// edit-side equivalent -- and because merging them would have meant editing
// a file three other work packages were changing at the same time. See the
// WP 6.8 wiring notes for the follow-up that collapses them.
//
// FOUR fields, matching NeedForm (givefood/forms.py:231-236) once its
// `exclude` list and every editable=False field on FoodbankChange are
// accounted for: foodbank, change_text, excess_change_text, published.
// `foodbank` is a slug text input, not Django's completely unscoped
// `Foodbank.objects.filter()` <select> of every food bank open or closed
// (~1,000+ options) -- the same substitution the edit form already made.
// That substitution dropped Django's name-based selection entirely, which
// is the wrong half to lose on the phoned-in/emailed-in case the operator
// has a NAME for and not a slug, so the input now carries a datalist of
// name -> slug pairs (need_new.njk's `foodbank_options`). Open food banks
// only, per getOpenFoodbankOptions; a closed one is still reachable by
// typing its slug, which is why this remains free text.

// needs.ts:33's TRANSLATE_LANGUAGES, duplicated rather than imported: that
// constant is module-private there, and this app serves 4 languages total
// (PLAN.md §2.7.1) against Django's 21 -- see
// packages/db/migrations/0006_need_translations.sql for the 19-vs-3
// accounting. Keep the two lists identical.
const TRANSLATE_LANGUAGES = ["cy", "ga", "gd"] as const;

interface NeedFormValues {
  foodbank_slug: string;
  change_text: string;
  excess_change_text: string;
  published: boolean;
}

async function renderForm(c: Context<AppEnv>, form: NeedFormValues, showPreview: boolean, error: string | null): Promise<Response> {
  const html = await render("admin/need_new.njk", {
    ...(await adminPageContext(c, "needs")),
    page_title: "New Need",
    form,
    // Backs the food-bank datalist -- see the module comment. Fetched here
    // rather than at each call site so an error re-render keeps the list.
    foodbank_options: await getOpenFoodbankOptions(dbSession(c)),
    show_preview: showPreview,
    error,
  });
  // 200 even when `error` is set -- a Django ModelForm that fails
  // validation re-renders the same page with the errors attached, it does
  // not return a 4xx.
  return c.html(html);
}

export async function adminNeedNew(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    // CLEANED, matching Django's FoodbankChange.save(), which runs
    // clean_foodbank_need_text() over change_text and excess_change_text on
    // EVERY write including the form path (givefood/models/needs.py:295-297).
    //
    // This used to be skipped here, with a comment explaining that the
    // function lived in workers/jobs/src and the site Worker may not import
    // it. That was true, and the consequence was worse than the comment
    // predicted: it said a hand-typed list "keeps its blank lines, double
    // spaces and Uht spelling", but the real damage was LINE ENDINGS. A
    // browser submits <textarea> content with CRLF (HTML spec), Django's
    // clean() normalises it away via splitlines()/'\n'.join(), and this
    // didn't -- so a need typed in the admin was stored with \r\n.
    //
    // Every downstream reader splits on "\n", which leaves a trailing \r on
    // every line but the last, and those readers compare item text against
    // `foodbankchangeline.item` (which never contains \r in any of its
    // 333,208 rows). So the categorise page's suggestions silently missed
    // for every item except the last one -- ticket #6, diagnosed 2026-09-05
    // from a need where 12 of 13 items offered no category and the final one
    // did. The function now lives in @givefood/models, importable by both
    // Workers, which is the fix the old comment named.
    const form: NeedFormValues = {
      foodbank_slug: typeof body.foodbank_slug === "string" ? body.foodbank_slug.trim() : "",
      change_text: typeof body.change_text === "string" ? await cleanFoodbankNeedText(body.change_text) : "",
      excess_change_text:
        typeof body.excess_change_text === "string" ? await cleanFoodbankNeedText(body.excess_change_text) : "",
      published: !!body.published,
    };

    let foodbankId: number | null = null;
    let showPreview = false;
    if (form.foodbank_slug) {
      const foodbank = await getFoodbankBySlug(db, form.foodbank_slug);
      // Fixes gfadmin/views.py:1928's unguarded
      // `Foodbank.objects.get(slug=foodbank_slug)`, which raises
      // DoesNotExist -> 500 on a bad slug. Re-rendered with the error here
      // instead, so the reviewer does not lose the shopping list they just
      // typed in.
      if (!foodbank) return renderForm(c, form, false, `No food bank with slug "${form.foodbank_slug}"`);
      foodbankId = foodbank.id;
      showPreview = !!foodbank.url;
    }

    // givefood/models/needs.py:64 -- `change_text = models.TextField(
    // verbose_name="Shopping List")`, with no blank=True, so NeedForm builds
    // a REQUIRED CharField and views.py:1931-1934's `if form.is_valid()`
    // hands the page back with "This field is required." instead of saving.
    // Checked before clean()'s food-bank rule below, matching Django's
    // field-validation-then-clean order. An empty need is not inert: with a
    // food bank set it feeds recomputeFoodbankNeedFields, and if Published
    // is ticked it is translated and reaches /needs/at/<slug>/.
    if (form.change_text.trim() === "") {
      return renderForm(c, form, showPreview, "This field is required.");
    }

    // FoodbankChange.clean() (givefood/models/needs.py:77-79) declares this
    // invalid, and ModelForm.full_clean() DOES enforce it on this path --
    // unlike need_publish, which never calls clean() (already fixed on that
    // route, needAdmin.ts's setNeedPublished).
    if (form.published && foodbankId === null) {
      return renderForm(c, form, showPreview, "Need to set a food bank to publish need");
    }

    const created = await insertAdminNeed(db, {
      foodbankId,
      changeText: form.change_text,
      excessChangeText: form.excess_change_text.trim() !== "" ? form.excess_change_text : null,
      published: form.published,
    });

    // givefood/models/needs.py:305-317's `do_translate = self.published`:
    // Django's save() fans out one translate task per language whenever the
    // saved need is published, from the FORM path as much as from the
    // Publish button. cy/ga/gd only here -- see TRANSLATE_LANGUAGES above.
    if (form.published) {
      await c.env.JOBS_Q.sendBatch(TRANSLATE_LANGUAGES.map((language) => ({ body: { type: "translate-need", needId: created.id, language } })));
    }

    return c.redirect(`/admin/need/${created.needId}/`, 302);
  }

  // GET. `?foodbank=<slug>` pre-selects the food bank (views.py:1926-1937's
  // `initial={"foodbank": foodbank}`), which is how both "New Need" buttons
  // on the food bank page arrive here.
  const slug = c.req.query("foodbank") ?? "";
  const form: NeedFormValues = { foodbank_slug: slug, change_text: "", excess_change_text: "", published: false };
  if (!slug) return renderForm(c, form, false, null);

  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return renderForm(c, form, false, `No food bank with slug "${slug}"`);
  return renderForm(c, form, !!foodbank.url, null);
}
