import type { Session } from "./types";
import type { PageResult } from "./adminLists";
import { pyNow } from "@givefood/models";

// WP: slug redirects. The read/write paths behind gfadmin/views.py:2276-2308
// (slug_redirects() and slug_redirect_form()), the model at
// givefood/models/operations.py:44-53 (SlugRedirect, a TimestampedModel),
// and the old->new map that givefood/utils/cache.py:12-32
// get_slug_redirects() builds for SlugRedirectMiddleware.
//
// D1 is the editable source of truth here; the middleware's own read path
// is a DATA-KV blob (workers/site/src/middleware/slugRedirect.ts), rebuilt
// from getSlugRedirectMap() below on every admin write -- see
// workers/site/src/lib/slugRedirectKv.ts.

export interface SlugRedirectRow {
  id: number;
  old_slug: string;
  new_slug: string;
  created: string;
  modified: string;
}

const COLUMNS = "id, old_slug, new_slug, created, modified";

// gfadmin/views.py:2278 -- SlugRedirect.objects.all().order_by("-created").
// Django's own view is unpaginated (57 rows today); paginated here to match
// the WP 6.6 convention (see adminLists.ts's header) that no admin list is
// ever unbounded, since D1 meters rows scanned -- not because 57 rows are a
// problem.
export async function getSlugRedirectsPage(session: Session, page: number, pageSize: number): Promise<PageResult<SlugRedirectRow>> {
  const offset = (page - 1) * pageSize;
  const [countRow, result] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM slugredirect").first<{ n: number }>(),
    session
      .prepare(`SELECT ${COLUMNS} FROM slugredirect ORDER BY created DESC LIMIT ? OFFSET ?`)
      .bind(pageSize, offset)
      .all(),
  ]);
  const total = countRow?.n ?? 0;
  return {
    rows: result.results as unknown as SlugRedirectRow[],
    total,
    page,
    pageSize,
    hasNext: offset + pageSize < total,
  };
}

// gfadmin/views.py:2290 get_object_or_404(SlugRedirect, id=id).
export async function getSlugRedirectById(session: Session, id: number): Promise<SlugRedirectRow | null> {
  const row = await session.prepare(`SELECT ${COLUMNS} FROM slugredirect WHERE id = ?`).bind(id).first<SlugRedirectRow>();
  return row ?? null;
}

// The unique=True check Django's ModelForm does for us
// (givefood/models/operations.py:46). Excludes the row being edited so
// re-saving an otherwise-unchanged form isn't reported as a clash.
// `id IS NOT ?` rather than `id != ?`: SQLite's `!=` against NULL yields
// NULL (never true), which on a create -- where there is no row to exclude
// -- would filter out every row and make the check always pass.
export async function slugRedirectOldSlugTaken(session: Session, oldSlug: string, exceptId: number | undefined): Promise<boolean> {
  const row = await session
    .prepare("SELECT id FROM slugredirect WHERE old_slug = ? AND id IS NOT ?")
    .bind(oldSlug, exceptId ?? null)
    .first<{ id: number }>();
  return !!row;
}

export interface UpsertSlugRedirectParams {
  oldSlug: string;
  newSlug: string;
}

// gfadmin/views.py:2299 form.save() -- create when existingId is undefined,
// update otherwise. `created` is auto_now_add on TimestampedModel
// (givefood/models/base.py:12-19): set once, never touched on update.
// `modified` is auto_now: stamped on every save.
export async function upsertSlugRedirect(session: Session, params: UpsertSlugRedirectParams, existingId: number | undefined): Promise<void> {
  const now = pyNow();
  if (existingId === undefined) {
    await session
      .prepare("INSERT INTO slugredirect (old_slug, new_slug, created, modified) VALUES (?, ?, ?, ?)")
      .bind(params.oldSlug, params.newSlug, now, now)
      .run();
  } else {
    await session
      .prepare("UPDATE slugredirect SET old_slug = ?, new_slug = ?, modified = ? WHERE id = ?")
      .bind(params.oldSlug, params.newSlug, now, existingId)
      .run();
  }
}

// givefood/utils/cache.py:25-26's
// `dict(SlugRedirect.objects.all().values_list("old_slug","new_slug"))` --
// the exact shape workers/site/src/middleware/slugRedirect.ts expects to
// read back out of DATA KV.
export async function getSlugRedirectMap(session: Session): Promise<Record<string, string>> {
  const result = await session.prepare("SELECT old_slug, new_slug FROM slugredirect").all();
  const map: Record<string, string> = {};
  for (const row of result.results as unknown as { old_slug: string; new_slug: string }[]) {
    map[row.old_slug] = row.new_slug;
  }
  return map;
}
