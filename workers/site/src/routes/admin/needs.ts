import type { Context } from "hono";
import {
  getNeedByUuid,
  getPrevPublishedNeed,
  getPrevNonpertinentNeed,
  getNeedSubscriberCounts,
  getCrawlSetForNeed,
  getTranslationCountForNeed,
  setNeedPublished,
  setNeedNonpertinent,
  setNeedCategorised,
  deleteNeedByUuid,
  deleteNeedsByUuids,
  getFoodbankSlugById,
  getChangeLinesForNeed,
  getLatestLineForItem,
  upsertNeedLine,
  ITEM_CATEGORIES,
  getAllTranslationsForNeed,
  updateNeedRawFields,
  getFoodbankBySlug,
  getOpenFoodbankOptions,
  type FoodbankWithLatestNeed,
  type FoodbankChangeRow,
} from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { diffHtml } from "../../lib/needDiff";
import { inputMethodHuman, inputMethodEmoji } from "../../lib/needAdminDisplay";
import { timesince } from "../../lib/timesince";
import { adminPageContext } from "./pageContext";

const TRANSLATE_LANGUAGES = ["cy", "ga", "gd"] as const;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// The food bank URL fields a need's `uri` could plausibly have been
// captured from, most likely first. Both crawlers set `uri =
// foodbank.shopping_list_url` at creation (givefood/utils/crawlers.py:541-548,
// workers/jobs/src/queues/needcheckRender.ts:214), so the fresh-need case
// matches on the first entry.
const NEED_URI_PROXY_FIELDS = ["shopping_list_url", "url"] as const;

// gfadmin/templates/admin/need.html:258-264 AND admin/form.html:23-29 --
// Django renders this exact same `{% if need.uri %}` preview (minus
// facebook.com/bankthefood.org, neither of which can be framed) from BOTH
// the need detail page and the need edit form, off the same `need`
// template var either view sets. Shared here for the same reason: one
// place to resolve which food bank field's origin the need's `uri` came
// from, not two copies that could drift.
//
// Django previews the need's OWN `uri` (`?url={{ need.uri|urlencode }}`),
// i.e. the page the shopping list was extracted from -- not whatever
// `shopping_list_url` holds now. That distinction matters: `uri` is a
// snapshot taken at crawl time and the food bank's URL fields are edited
// in the admin, so an older need previewed against the current field
// silently compares the extraction to a different page.
//
// WP 6.3's proxy can't take a raw URL (that was Django's SSRF). So name
// the field whose origin matches and pin the exact page with `target=`,
// which proxy.ts:35-60 only honours when its origin matches the resolved
// field URL's origin -- the same mechanism discrepancies.ts:41-50 uses.
// If no field's origin matches (a legacy Distill-era uri, or an edited
// shopping_list_url), show no preview rather than a wrong one -- the
// policy discrepancies.ts:32-40 already states.
//
// Consequence of the field-based proxy, disclosed rather than worked
// around: a need with no food bank cannot be previewed at all, where
// Django's `{% if need.uri %}` alone would still show one.
function computeNeedProxySrc(foodbank: FoodbankWithLatestNeed | null, foodbankSlug: string | null, needUri: string | null): string | null {
  if (!foodbank || !foodbankSlug || !needUri || needUri.includes("facebook.com") || needUri.includes("bankthefood.org")) return null;
  for (const field of NEED_URI_PROXY_FIELDS) {
    if (sameOrigin(foodbank[field], needUri)) {
      return `/admin/proxy/?foodbank=${encodeURIComponent(foodbankSlug)}&field=${field}&target=${encodeURIComponent(needUri)}`;
    }
  }
  return null;
}

// gfadmin/views.py:1753-1831 need() -- the detail page. `id` is the
// public need_id UUID (dashed or dashless, getNeedByUuid normalises).
export async function adminNeedDetail(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const need = await getNeedByUuid(db, c.req.param("id")!);
  if (!need) return c.notFound();

  const foodbankSlug = need.foodbank_id !== null ? await getFoodbankSlugById(db, need.foodbank_id) : null;
  const [prevPublished, prevNonpert, subscriberCounts, crawlSet, translationCount, foodbank] = await Promise.all([
    need.foodbank_id !== null ? getPrevPublishedNeed(db, need.foodbank_id, need.created) : Promise.resolve(null),
    need.foodbank_id !== null ? getPrevNonpertinentNeed(db, need.foodbank_id, need.created) : Promise.resolve(null),
    need.foodbank_id !== null ? getNeedSubscriberCounts(db, need.foodbank_id) : Promise.resolve({ email: 0, webpush: 0, mobile: 0, whatsapp: 0 }),
    getCrawlSetForNeed(db, need.id),
    need.published ? getTranslationCountForNeed(db, need.id) : Promise.resolve(0),
    foodbankSlug ? getFoodbankBySlug(db, foodbankSlug) : Promise.resolve(null),
  ]);

  const changeList = need.change_text.split("\n");
  const excessList = need.excess_change_text ? need.excess_change_text.split("\n") : [];

  const proxySrc = computeNeedProxySrc(foodbank, foodbankSlug, need.uri);
  const now = new Date();

  const html = await render("admin/need.njk", {
    ...(await adminPageContext(c, "needs")),
    need: {
      ...need,
      need_id_short: need.need_id.slice(0, 7),
      input_method_human: inputMethodHuman(need.input_method),
      input_method_emoji: inputMethodEmoji(need.input_method),
      created_timesince: `${timesince(need.created, now)} ago`,
      modified_timesince: `${timesince(need.modified, now)} ago`,
    },
    foodbank_slug: foodbankSlug,
    prev_published: prevPublished ? { ...prevPublished, need_id_short: prevPublished.need_id.slice(0, 7), created_timesince: `${timesince(prevPublished.created, now)} ago` } : null,
    prev_nonpert: prevNonpert ? { ...prevNonpert, need_id_short: prevNonpert.need_id.slice(0, 7), created_timesince: `${timesince(prevNonpert.created, now)} ago` } : null,
    diff_from_pub: prevPublished ? diffHtml(prevPublished.change_text.split("\n"), changeList) : "",
    diff_from_pub_excess: prevPublished ? diffHtml(prevPublished.excess_change_text ? prevPublished.excess_change_text.split("\n") : [], excessList) : "",
    diff_from_nonpert: prevNonpert ? diffHtml(prevNonpert.change_text.split("\n"), changeList) : "",
    diff_from_nonpert_excess: prevNonpert ? diffHtml(prevNonpert.excess_change_text ? prevNonpert.excess_change_text.split("\n") : [], excessList) : "",
    subscriber_counts: subscriberCounts,
    subscriber_count: subscriberCounts.email + subscriberCounts.webpush + subscriberCounts.mobile + subscriberCounts.whatsapp,
    crawl_set: crawlSet ? { ...crawlSet, start_timesince: `${timesince(crawlSet.start, now)} ago` } : null,
    translation_count: translationCount,
    show_proxy: !!proxySrc,
    proxy_src: proxySrc,
  });
  return c.html(html);
}

async function requireCsrf(c: Context<AppEnv>): Promise<Record<string, string | undefined> | null> {
  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  const ok = await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken);
  return ok ? (body as Record<string, string | undefined>) : null;
}

// gfadmin/views.py:1966-1976 need_publish, split into two explicit routes
// (publish/unpublish) rather than ported as one route with an
// open-ended `<slug:action>` -- see lib/adminAuth.ts-adjacent WP 6.4
// commit note: Django's version silently no-ops any action value other
// than the two literal strings it checks, while still running every side
// effect. Also fixes the double-`.save()` bug (WP 6.4 research): exactly
// one write, one translate enqueue per publish, not two of each.
export async function adminNeedPublish(c: Context<AppEnv>): Promise<Response> {
  return handlePublishTransition(c, true);
}
export async function adminNeedUnpublish(c: Context<AppEnv>): Promise<Response> {
  return handlePublishTransition(c, false);
}

async function handlePublishTransition(c: Context<AppEnv>, publish: boolean): Promise<Response> {
  if (!(await requireCsrf(c))) return c.text("Forbidden", 403);
  const needId = c.req.param("id")!;
  const db = dbSession(c);
  const result = await setNeedPublished(db, needId, publish);
  if (result === null) return c.notFound();
  if (result === "needs-foodbank") return c.text("Cannot publish a need with no food bank set", 400);

  // Only on a successful publish -- givefood/models/needs.py:305-317's
  // `do_translate = self.published` resolves to false on unpublish, so
  // Django never (re-)translates there either. cy/ga/gd only -- this app
  // serves 4 languages total (§2.7.1), not Django's 21 (packages/db's
  // migrations/0006_need_translations.sql has the full 19-vs-3 accounting).
  if (publish) {
    await c.env.JOBS_Q.sendBatch(TRANSLATE_LANGUAGES.map((language) => ({ body: { type: "translate-need", needId: result.id, language } })));
  }

  return c.redirect(`/admin/need/${needId}/`, 302);
}

// gfadmin/views.py:1949-1955 need_nonpertinent -- the de-facto "reject".
// Redirects to the dashboard (views.py:1955 `redirect("admin:index")`), not
// back to the need: rejecting is the last thing a reviewer does with a need,
// so this returns them to the queue for the next one. need_delete does the
// same; only need_publish redirects back to the need it acted on.
export async function adminNeedNonpertinent(c: Context<AppEnv>): Promise<Response> {
  if (!(await requireCsrf(c))) return c.text("Forbidden", 403);
  const needId = c.req.param("id")!;
  const result = await setNeedNonpertinent(dbSession(c), needId);
  if (!result) return c.notFound();
  return c.redirect("/admin/", 302);
}

// gfadmin/views.py:1929-1935 need_delete.
export async function adminNeedDelete(c: Context<AppEnv>): Promise<Response> {
  if (!(await requireCsrf(c))) return c.text("Forbidden", 403);
  const needId = c.req.param("id")!;
  const deleted = await deleteNeedByUuid(dbSession(c), needId);
  if (!deleted) return c.notFound();
  return c.redirect("/admin/", 302);
}

// gfadmin/views.py:423-428 needs_deleteall -- the dashboard's bulk-delete
// form, `need_id` submitted once per row (repeated field name, so this
// needs `{ all: true }` to get every value rather than just the last).
export async function adminNeedsDeleteAll(c: Context<AppEnv>): Promise<Response> {
  const body = await c.req.parseBody({ all: true });
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  const raw = body.need_id;
  const needIds = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v): v is string => typeof v === "string");
  await deleteNeedsByUuids(dbSession(c), needIds);
  return c.redirect("/admin/", 302);
}

interface CategoriseLine {
  item: string;
  type: "need" | "excess";
  category: string | null;
}

async function buildCategoriseLines(db: ReturnType<typeof dbSession>, needId: number, changeText: string, excessChangeText: string | null): Promise<CategoriseLine[]> {
  const existing = await getChangeLinesForNeed(db, needId);
  const lines: CategoriseLine[] = [];
  for (const item of changeText.split("\n")) {
    const found = existing.get(item);
    const suggested = found ?? (await getLatestLineForItem(db, item));
    lines.push({ item, type: "need", category: found ? found.category : (suggested?.category ?? null) });
  }
  if (excessChangeText) {
    for (const item of excessChangeText.split("\n")) {
      const found = existing.get(item);
      const suggested = found ?? (await getLatestLineForItem(db, item));
      lines.push({ item, type: "excess", category: found ? found.category : (suggested?.category ?? null) });
    }
  }
  return lines;
}

// gfadmin/views.py:2041-2135 need_categorise -- manual per-line
// categorisation, GET renders the form (pre-filled from an existing line
// for this need, else the most recent line anywhere for that same item
// text, else blank), POST upserts one FoodbankChangeLine per submitted
// row and flags the need `is_categorised`. The automated Gemini path
// (gfoffline's need_categorisation, `is_categorised__isnull=True`) is not
// ported -- WP 6.4 research confirmed that filter can never match (the
// column isn't nullable), so it's dead code with no admin UI ever calling
// it; this manual flow is the only categorisation path that actually
// works in the reference app today.
export async function adminNeedCategorise(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const need = await getNeedByUuid(db, c.req.param("id")!);
  if (!need) return c.notFound();

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);
    if (need.foodbank_id === null) return c.text("Cannot categorise a need with no food bank set", 400);

    // Driven off `orig_item_N` -- the hidden field holding the text the row
    // was RENDERED with. That is Django's lookup key: views.py:2071-2074
    // binds NeedLineForm with `prefix=line` and
    // `instance=existing_need_lines.get(line)`, both keyed on the original
    // change_text line. `item_N` is now the editable box beside it
    // (need_categorise.njk; NeedLineForm leaves `item` a plain TextInput) and
    // may carry a correction. Falling back to `item_N` keeps a page served
    // before `orig_item_N` existed from breaking out at i=0 and categorising
    // nothing.
    for (let i = 0; ; i++) {
      const origItem = body[`orig_item_${i}`] ?? body[`item_${i}`];
      if (origItem === undefined) break;
      const edited = body[`item_${i}`];
      const type = body[`type_${i}`];
      const category = body[`category_${i}`];
      if (typeof origItem !== "string" || typeof type !== "string" || typeof category !== "string" || !category) continue;
      if (type !== "need" && type !== "excess") continue;
      // A cleared box is not a rename -- keep what was rendered.
      const item = typeof edited === "string" && edited !== "" ? edited : origItem;
      // KNOWN GAP until upsertNeedLine takes the original as its lookup key
      // (packages/db/src/needLines.ts, in the WP wiring notes): it matches on
      // `item`, so re-categorising a need AND correcting a line's text inserts
      // a second row rather than renaming the existing one in place, which is
      // what `instance=need_line` does. First-time categorisation -- the
      // common case, and every case where the text is left alone -- is
      // unaffected.
      await upsertNeedLine(db, { needId: need.id, foodbankId: need.foodbank_id, needCreated: need.created, item, type, category });
    }
    await setNeedCategorised(db, need.need_id);
    return c.redirect(`/admin/need/${need.need_id}/`, 302);
  }

  const lines = await buildCategoriseLines(db, need.id, need.change_text, need.excess_change_text);
  const html = await render("admin/need_categorise.njk", {
    ...(await adminPageContext(c, "needs")),
    // need_categorise.html:26 heads the page with {{ need.need_id_short }}
    // (models/needs.py:81-82). Same one-liner adminNeedDetail already does.
    need: { ...need, need_id_short: need.need_id.slice(0, 7) },
    lines,
    categories: ITEM_CATEGORIES,
  });
  return c.html(html);
}

// gfadmin/views.py:2011-2020 need_translations -- read-only viewer.
export async function adminNeedTranslations(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const need = await getNeedByUuid(db, c.req.param("id")!);
  if (!need) return c.notFound();

  const [translations, foodbankSlug] = await Promise.all([
    getAllTranslationsForNeed(db, need.id),
    need.foodbank_id !== null ? getFoodbankSlugById(db, need.foodbank_id) : Promise.resolve(null),
  ]);
  const now = new Date();
  const html = await render("admin/need_translations.njk", {
    ...(await adminPageContext(c, "needs")),
    need: {
      ...need,
      need_id_short: need.need_id.slice(0, 7),
      input_method_human: inputMethodHuman(need.input_method),
      input_method_emoji: inputMethodEmoji(need.input_method),
      created_timesince: `${timesince(need.created, now)} ago`,
      modified_timesince: `${timesince(need.modified, now)} ago`,
    },
    foodbank_slug: foodbankSlug,
    translations,
  });
  return c.html(html);
}

// gfadmin/views.py:1916-1946 need_form (givefood/forms.py:231-236
// NeedForm) -- edit-only (Django's "new" branch is dead: `newneed`'s URL
// exists but nothing links to it, and creating a need outside the
// needcheck pipeline has no real use case). Once `exclude` and every
// editable=False FoodbankChange field are accounted for, the form only
// ever exposes 4 fields: foodbank, change_text, excess_change_text,
// published -- see needAdmin.ts's updateNeedRawFields. `foodbank` is a
// slug text input here rather than Django's 1000+-row `<select>` (its
// ModelChoiceField has no scoping at all, `Foodbank.objects.filter()` --
// every food bank, open or closed) -- the same substitution needNew.ts's
// create half already made, now backed by the same datalist of open food
// banks (needNew.ts:34-42's reasoning applies verbatim here).
//
// Re-render helper, mirroring needNew.ts's renderForm: an invalid submit
// re-shows the typed values plus one error banner rather than the bare
// `c.text(error, 400)` other ported forms return, and 200 even when
// `error` is set -- a Django ModelForm that fails validation re-renders
// the same bound page, it does not return a 4xx.
async function renderNeedEditForm(
  c: Context<AppEnv>,
  db: ReturnType<typeof dbSession>,
  need: FoodbankChangeRow,
  formValues: { change_text: string; excess_change_text: string | null; published: boolean },
  foodbankSlug: string | null,
  error: string | null,
): Promise<Response> {
  const [foodbankOptions, foodbank] = await Promise.all([getOpenFoodbankOptions(db), foodbankSlug ? getFoodbankBySlug(db, foodbankSlug) : Promise.resolve(null)]);
  // admin/form.html:23-29's need.uri preview -- see computeNeedProxySrc's
  // own comment. Uses `need.uri` (the crawl-time snapshot), never
  // whichever food bank is currently typed into the field above.
  const proxySrc = computeNeedProxySrc(foodbank, foodbankSlug, need.uri);
  const html = await render("admin/need_form.njk", {
    ...(await adminPageContext(c, "needs")),
    need: { ...need, change_text: formValues.change_text, excess_change_text: formValues.excess_change_text, published: formValues.published },
    foodbank_slug: foodbankSlug,
    foodbank_options: foodbankOptions,
    show_proxy: !!proxySrc,
    proxy_src: proxySrc,
    error,
  });
  return c.html(html);
}

export async function adminNeedEditForm(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const need = await getNeedByUuid(db, c.req.param("id")!);
  if (!need) return c.notFound();

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    const changeText = typeof body.change_text === "string" ? body.change_text : "";
    const excessChangeText = typeof body.excess_change_text === "string" && body.excess_change_text.trim() !== "" ? body.excess_change_text : null;
    const published = !!body.published;
    const formValues = { change_text: changeText, excess_change_text: excessChangeText, published };

    // THE FOOD BANK IS NOT EDITABLE HERE any more (maintainer decision
    // 2026-09-05, see need_form.njk). Django's NeedForm exposes it and this
    // route used to read `foodbank_slug` back off the body; it now keeps
    // whatever the need already has. Nothing is trusted from the form, so
    // there is no slug to validate and no "no food bank with slug X" path.
    const foodbankId = need.foodbank_id;
    const foodbankName = need.foodbank_name;
    const foodbankSlug = foodbankId !== null ? await getFoodbankSlugById(db, foodbankId) : null;

    // givefood/models/needs.py:64 -- `change_text` has no blank=True, so
    // NeedForm's is_valid() rejects an empty shopping list with "This field
    // is required." instead of saving, matching needNew.ts:127-129's
    // identical check on the create half of this same Django view.
    if (changeText.trim() === "") {
      return renderNeedEditForm(c, db, need, formValues, foodbankSlug, "This field is required.");
    }

    // FoodbankChange.clean() (needs.py:77-79), enforced by
    // ModelForm.full_clean() on this path -- matching needNew.ts:135-137's
    // identical check on the create half.
    if (published && foodbankId === null) {
      return renderNeedEditForm(c, db, need, formValues, foodbankSlug, "Need to set a food bank to publish need");
    }

    const updated = await updateNeedRawFields(db, need.need_id, { changeText, excessChangeText, published, foodbankId, foodbankName });
    if (!updated) return c.notFound();

    // needs.py:305-317's `do_translate = self.published` (default) fires
    // on EVERY save while published=True, not only the first one -- the
    // model's own comment states this explicitly ("translations are
    // triggered whenever a need is published, whether via form save or the
    // publish button"). needNew.ts:151-153 and handlePublishTransition
    // above already cover the create and publish-button paths; this is the
    // third and last place a need's `published` flag can become/stay true.
    if (published) {
      await c.env.JOBS_Q.sendBatch(TRANSLATE_LANGUAGES.map((language) => ({ body: { type: "translate-need", needId: need.id, language } })));
    }

    return c.redirect(`/admin/need/${need.need_id}/`, 302);
  }

  const foodbankSlug = need.foodbank_id !== null ? await getFoodbankSlugById(db, need.foodbank_id) : null;
  return renderNeedEditForm(c, db, need, { change_text: need.change_text, excess_change_text: need.excess_change_text, published: need.published }, foodbankSlug, null);
}
