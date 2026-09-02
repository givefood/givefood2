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

// gfadmin/views.py:1753-1831 need() -- the detail page. `id` is the
// public need_id UUID (dashed or dashless, getNeedByUuid normalises).
export async function adminNeedDetail(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const need = await getNeedByUuid(db, c.req.param("id")!);
  if (!need) return c.notFound();

  const foodbankSlug = need.foodbank_id !== null ? await getFoodbankSlugById(db, need.foodbank_id) : null;
  const [prevPublished, prevNonpert, subscriberCounts, crawlSet, translationCount] = await Promise.all([
    need.foodbank_id !== null ? getPrevPublishedNeed(db, need.foodbank_id, need.created) : Promise.resolve(null),
    need.foodbank_id !== null ? getPrevNonpertinentNeed(db, need.foodbank_id, need.created) : Promise.resolve(null),
    need.foodbank_id !== null ? getNeedSubscriberCounts(db, need.foodbank_id) : Promise.resolve({ email: 0, webpush: 0, mobile: 0, whatsapp: 0 }),
    getCrawlSetForNeed(db, need.id),
    need.published ? getTranslationCountForNeed(db, need.id) : Promise.resolve(0),
  ]);

  const changeList = need.change_text.split("\n");
  const excessList = need.excess_change_text ? need.excess_change_text.split("\n") : [];

  // gfadmin/views.py:258-264's `"facebook.com" not in need.uri and
  // "bankthefood.org" not in need.uri` gate -- neither source can be
  // framed/isn't worth proxying.
  const showProxy = !!foodbankSlug && !!need.uri && !need.uri.includes("facebook.com") && !need.uri.includes("bankthefood.org");
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
    show_proxy: showProxy,
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
export async function adminNeedNonpertinent(c: Context<AppEnv>): Promise<Response> {
  if (!(await requireCsrf(c))) return c.text("Forbidden", 403);
  const needId = c.req.param("id")!;
  const result = await setNeedNonpertinent(dbSession(c), needId);
  if (!result) return c.notFound();
  return c.redirect(`/admin/need/${needId}/`, 302);
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

    for (let i = 0; ; i++) {
      const item = body[`item_${i}`];
      if (item === undefined) break;
      const type = body[`type_${i}`];
      const category = body[`category_${i}`];
      if (typeof item !== "string" || typeof type !== "string" || typeof category !== "string" || !category) continue;
      if (type !== "need" && type !== "excess") continue;
      await upsertNeedLine(db, { needId: need.id, foodbankId: need.foodbank_id, needCreated: need.created, item, type, category });
    }
    await setNeedCategorised(db, need.need_id);
    return c.redirect(`/admin/need/${need.need_id}/`, 302);
  }

  const lines = await buildCategoriseLines(db, need.id, need.change_text, need.excess_change_text);
  const html = await render("admin/need_categorise.njk", {
    ...(await adminPageContext(c, "needs")),
    need,
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
// every food bank, open or closed).
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
    const foodbankSlug = typeof body.foodbank_slug === "string" ? body.foodbank_slug.trim() : "";

    let foodbankId: number | null = null;
    let foodbankName: string | null = need.foodbank_name;
    if (foodbankSlug) {
      const foodbank = await getFoodbankBySlug(db, foodbankSlug);
      if (!foodbank) return c.text(`No food bank with slug "${foodbankSlug}"`, 400);
      foodbankId = foodbank.id;
      foodbankName = foodbank.name;
    } else {
      foodbankName = null;
    }

    const updated = await updateNeedRawFields(db, need.need_id, { changeText, excessChangeText, published, foodbankId, foodbankName });
    if (!updated) return c.notFound();
    return c.redirect(`/admin/need/${need.need_id}/`, 302);
  }

  const foodbankSlug = need.foodbank_id !== null ? await getFoodbankSlugById(db, need.foodbank_id) : null;
  const html = await render("admin/need_form.njk", {
    ...(await adminPageContext(c, "needs")),
    need,
    foodbank_slug: foodbankSlug,
  });
  return c.html(html);
}
