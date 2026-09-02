import type { Session } from "./types";
import { mapNeedRow, type FoodbankChangeRow } from "./needs";

// WP 6.4 (PLAN.md §10.2.7): the admin need-review queue's own D1 access --
// distinct from needs.ts (the public API read path) and needcheck.ts (the
// pipeline's own writes). This is the reviewer-facing read/write surface:
// the queue itself, a single need's review context, and the publish/
// unpublish/nonpertinent/delete transitions.

// gfadmin/views.py:46-53 index() -- the REAL queue (not `/needs/`, which is
// an unfiltered 200-row audit list, see gfadmin/urls/needs.py:6). Every
// unreviewed, non-rejected need, no limit/pagination -- matches Django's
// own `FoodbankChange.objects.filter(published=False,
// nonpertinent=False)...order_by("-created")` verbatim, including its
// NULL-excluding behaviour on `nonpertinent = 0` (PLAN.md §10.2.8's own
// warning about this column's historical NULLs -- intentional parity, not
// a bug: a never-triaged legacy row with nonpertinent IS NULL stays out of
// the queue in both Django and here, alongside every row this app's own
// writers explicitly stamp 0 for, see needcheck.ts's insertFoodbankChange).
export async function getUnpublishedNeeds(session: Session): Promise<FoodbankChangeRow[]> {
  const result = await session.prepare("SELECT * FROM foodbankchange WHERE published = 0 AND nonpertinent = 0 ORDER BY created DESC").all();
  return result.results.map((r) => mapNeedRow(r as Record<string, unknown>));
}

export interface DiscrepancyRow {
  id: number;
  foodbank_id: number | null;
  foodbank_name: string | null;
  need_id: number | null;
  url: string | null;
  discrepancy_type: string;
  discrepancy_text: string;
  status: string;
  created: string;
  modified: string;
}

// gfadmin/views.py:52's `FoodbankDiscrepancy.objects.filter(status='New')
// .select_related('foodbank').order_by("-created")[:20]` -- the dashboard's
// third panel.
export async function getOpenDiscrepancies(session: Session, limit: number): Promise<DiscrepancyRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankdiscrepancy WHERE status = 'New' ORDER BY created DESC LIMIT ?")
    .bind(limit)
    .all<DiscrepancyRow>();
  return result.results;
}

export async function getDiscrepancyById(session: Session, id: number): Promise<DiscrepancyRow | null> {
  return session.prepare("SELECT * FROM foodbankdiscrepancy WHERE id = ?").bind(id).first<DiscrepancyRow>();
}

// gfadmin/views.py:2206-2217 discrepancy_action -- "invalid" (dismiss) or
// "done" (resolve). Unlike Django, POST-only (WP 6.3's carried-forward
// requirement: every mutating admin route is POST-only from the day it's
// written, not ported to GET and fixed up after).
export async function setDiscrepancyStatus(session: Session, id: number, status: "Done" | "Invalid"): Promise<void> {
  await session.prepare("UPDATE foodbankdiscrepancy SET status = ?, modified = ? WHERE id = ?").bind(status, new Date().toISOString(), id).run();
}

// gfadmin/views.py:1774-1791 need()'s prev_published/prev_nonpert lookups
// -- the latest PRIOR need (created strictly before the one being viewed),
// not simply "the latest" (getLastPublishedNeed in needcheck.ts answers a
// different question: the pipeline's own "what did we last publish" check,
// unbounded by any particular need's created time).
export async function getPrevPublishedNeed(session: Session, foodbankId: number, beforeCreated: string): Promise<FoodbankChangeRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbankchange WHERE foodbank_id = ? AND published = 1 AND created < ? ORDER BY created DESC LIMIT 1")
    .bind(foodbankId, beforeCreated)
    .first();
  return row ? mapNeedRow(row as Record<string, unknown>) : null;
}

export async function getPrevNonpertinentNeed(session: Session, foodbankId: number, beforeCreated: string): Promise<FoodbankChangeRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbankchange WHERE foodbank_id = ? AND nonpertinent = 1 AND created < ? ORDER BY created DESC LIMIT 1")
    .bind(foodbankId, beforeCreated)
    .first();
  return row ? mapNeedRow(row as Record<string, unknown>) : null;
}

export interface NeedSubscriberCounts {
  email: number;
  webpush: number;
  mobile: number;
  whatsapp: number;
}

// gfadmin/views.py:1795-1801. `whatsapp` is always 0 here -- there is no
// `whatsappsubscriber` D1 table yet (PLAN.md §10.2.6's WP 4.8 note: inbound
// messages already queue, but the subscribe/unsubscribe command flow that
// would populate a table like this is still unbuilt), not a bug in this
// query.
export async function getNeedSubscriberCounts(session: Session, foodbankId: number): Promise<NeedSubscriberCounts> {
  const [email, webpush, mobile] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber WHERE foodbank_id = ? AND confirmed = 1").bind(foodbankId).first<{ n: number }>(),
    session.prepare("SELECT COUNT(*) AS n FROM webpushsubscription WHERE foodbank_id = ?").bind(foodbankId).first<{ n: number }>(),
    session.prepare("SELECT COUNT(*) AS n FROM mobilesubscriber WHERE foodbank_id = ?").bind(foodbankId).first<{ n: number }>(),
  ]);
  return { email: email?.n ?? 0, webpush: webpush?.n ?? 0, mobile: mobile?.n ?? 0, whatsapp: 0 };
}

export interface NeedCrawlSetRow {
  crawl_set_id: number;
  crawl_type: string;
  start: string;
  finish: string | null;
}

// gfadmin/views.py:1805-1810's CrawlItem generic-FK lookup (content_type=
// FoodbankChange, object_id=need.id) -- collapses to crawlitem.need_id
// directly, same simplification packages/db/migrations/0008_needcheck.sql
// already made (see that migration's own comment on the generic FK).
export async function getCrawlSetForNeed(session: Session, needId: number): Promise<NeedCrawlSetRow | null> {
  const row = await session
    .prepare(
      `SELECT cs.id AS crawl_set_id, cs.crawl_type, cs.start, cs.finish
       FROM crawlitem ci JOIN crawlset cs ON cs.id = ci.crawl_set_id
       WHERE ci.need_id = ? LIMIT 1`,
    )
    .bind(needId)
    .first<NeedCrawlSetRow>();
  return row ?? null;
}

export async function getTranslationCountForNeed(session: Session, needId: number): Promise<number> {
  const row = await session.prepare("SELECT COUNT(*) AS n FROM foodbankchangetranslation WHERE need_id = ?").bind(needId).first<{ n: number }>();
  return row?.n ?? 0;
}

// Recomputes Foodbank.last_need/latest_need -- givefood/models/foodbank.py
// :694-712's cache-on-save logic, extracted so every need mutation that
// touches a foodbank's needs (publish, unpublish, nonpertinent, delete)
// can call it directly rather than re-deriving `Foodbank.save()`'s whole
// side-effect surface (geocoding, decache, counts) just for these two
// columns. Deliberately called on EVERY published-flag change including
// unpublish -- Django's need_publish only recomputes on publish (`if
// self.foodbank and self.published and do_foodbank_save`), so unpublishing
// a food bank's current latest_need leaves latest_need/last_need stale
// there. Fixed here, not ported: this is exactly the kind of drift WP 6.3
// already established this phase corrects rather than reproduces.
export async function recomputeFoodbankNeedFields(session: Session, foodbankId: number): Promise<void> {
  const [lastNeed, latestPublished] = await Promise.all([
    session.prepare("SELECT created FROM foodbankchange WHERE foodbank_id = ? ORDER BY created DESC LIMIT 1").bind(foodbankId).first<{ created: string }>(),
    session
      .prepare("SELECT id, created FROM foodbankchange WHERE foodbank_id = ? AND published = 1 ORDER BY created DESC LIMIT 1")
      .bind(foodbankId)
      .first<{ id: number; created: string }>(),
  ]);
  await session
    .prepare("UPDATE foodbank SET last_need = ?, latest_need_id = ? WHERE id = ?")
    .bind(lastNeed?.created ?? null, latestPublished?.id ?? null, foodbankId)
    .run();
}

// gfadmin/views.py:1966-1976 need_publish. Django calls `.save()` TWICE
// back to back (once `do_translate=True` explicitly, once with defaults
// resolving `do_translate` to `self.published`) -- confirmed (WP 6.4
// research) to double every side effect: 38 translate tasks enqueued
// instead of 19, two foodbank saves/decache cycles instead of one. Fixed
// here to a single write. Also newly guards against publishing an orphan
// (no-foodbank) need -- `FoodbankChange.clean()` already declares this
// invalid (needs.py:77-79) but `need_publish` never calls it, so Django's
// own Publish button can silently publish a foodbank-less need; this port
// refuses instead, matching the model's own stated invariant rather than
// the view's oversight.
//
// Returns null if the need doesn't exist, or "needs-foodbank" if
// action="publish" was refused for lacking a foodbank -- the caller (the
// route handler) turns either into the appropriate HTTP response.
export async function setNeedPublished(session: Session, needId: string, publish: boolean): Promise<FoodbankChangeRow | "needs-foodbank" | null> {
  const need = await session.prepare("SELECT * FROM foodbankchange WHERE need_id = ?").bind(needId).first();
  if (!need) return null;
  const row = mapNeedRow(need as Record<string, unknown>);
  if (publish && row.foodbank_id === null) return "needs-foodbank";

  const now = new Date().toISOString();
  await session.prepare("UPDATE foodbankchange SET published = ?, modified = ? WHERE need_id = ?").bind(publish ? 1 : 0, now, needId).run();
  if (row.foodbank_id !== null) await recomputeFoodbankNeedFields(session, row.foodbank_id);

  return { ...row, published: publish, modified: now };
}

// gfadmin/views.py:1949-1955 need_nonpertinent -- the de-facto "reject".
// Doesn't exclude an already-published need (neither does Django); if the
// need happens to be published, foodbank fields are recomputed too, same
// as any other write that could change which need is "latest".
export async function setNeedNonpertinent(session: Session, needId: string): Promise<FoodbankChangeRow | null> {
  const need = await session.prepare("SELECT * FROM foodbankchange WHERE need_id = ?").bind(needId).first();
  if (!need) return null;
  const row = mapNeedRow(need as Record<string, unknown>);

  const now = new Date().toISOString();
  await session.prepare("UPDATE foodbankchange SET nonpertinent = 1, modified = ? WHERE need_id = ?").bind(now, needId).run();
  if (row.foodbank_id !== null) await recomputeFoodbankNeedFields(session, row.foodbank_id);

  return { ...row, nonpertinent: true, modified: now };
}

export async function setNeedCategorised(session: Session, needId: string): Promise<void> {
  await session.prepare("UPDATE foodbankchange SET is_categorised = 1, modified = ? WHERE need_id = ?").bind(new Date().toISOString(), needId).run();
}

export async function setNeedNotified(session: Session, needId: string): Promise<void> {
  const now = new Date().toISOString();
  await session.prepare("UPDATE foodbankchange SET notified = ?, modified = ? WHERE need_id = ?").bind(now, now, needId).run();
}

// gfadmin/views.py:1929-1935 need_delete -- `FoodbankChange.delete()`
// (needs.py:319-328) always recomputes the foodbank's fields regardless of
// the deleted need's published state (unlike need_publish's unpublish
// path, this one Django gets right). foodbankchangeline/
// foodbankchangetranslation rows for this need are NOT cascade-deleted
// (Django's model delete() doesn't touch them either -- confirmed no
// on_delete=CASCADE anywhere on these FKs, §4.5's no-FK-constraints
// convention means D1 wouldn't cascade automatically either way) -- an
// orphaned line/translation row pointing at a deleted need_id is existing,
// accepted behaviour, not something this port introduces.
export async function deleteNeedByUuid(session: Session, needId: string): Promise<boolean> {
  const need = await session.prepare("SELECT foodbank_id FROM foodbankchange WHERE need_id = ?").bind(needId).first<{ foodbank_id: number | null }>();
  if (!need) return false;
  await session.prepare("DELETE FROM foodbankchange WHERE need_id = ?").bind(needId).run();
  if (need.foodbank_id !== null) await recomputeFoodbankNeedFields(session, need.foodbank_id);
  return true;
}

// gfadmin/views.py:423-428 needs_deleteall -- the dashboard's bulk-delete-
// backlog form. Django's version is a QuerySet `.delete()`, which bypasses
// the model's delete() override entirely: no foodbank recompute for any
// affected food bank at all (confirmed, WP 6.4 research). Fixed here: every
// distinct foodbank_id among the deleted rows gets recomputed once, not
// once per deleted need -- a queue backlog often holds several stale needs
// for the same food bank, and Set() dedupes that down to one write each.
export async function deleteNeedsByUuids(session: Session, needIds: readonly string[]): Promise<void> {
  if (needIds.length === 0) return;
  const placeholders = needIds.map(() => "?").join(", ");
  const affected = await session
    .prepare(`SELECT DISTINCT foodbank_id FROM foodbankchange WHERE need_id IN (${placeholders}) AND foodbank_id IS NOT NULL`)
    .bind(...needIds)
    .all<{ foodbank_id: number }>();
  await session.prepare(`DELETE FROM foodbankchange WHERE need_id IN (${placeholders})`).bind(...needIds).run();
  for (const { foodbank_id } of affected.results) await recomputeFoodbankNeedFields(session, foodbank_id);
}
