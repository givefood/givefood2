import type { Session } from "./types";
import { mapNeedRow, type FoodbankChangeRow } from "./needs";
import { pyNow } from "@givefood/models";

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
// Admin-only enrichment over the shared FoodbankChangeRow shape -- the
// dashboard links a need's foodbank name to its admin detail page (WP 6.7),
// which needs a slug the public-API-shared needs.ts queries don't select.
export interface AdminNeedRow extends FoodbankChangeRow {
  foodbank_slug: string | null;
}

function mapAdminNeedRow(raw: Record<string, unknown>): AdminNeedRow {
  return mapNeedRow(raw) as AdminNeedRow; // coerceBooleans spreads unknown columns through untouched
}

export async function getUnpublishedNeeds(session: Session): Promise<AdminNeedRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankchange_full WHERE published = 0 AND nonpertinent = 0 ORDER BY created DESC")
    .all();
  return result.results.map((r) => mapAdminNeedRow(r as Record<string, unknown>));
}

// gfadmin/views.py:50's `published_needs` panel -- the shared needs.ts
// getPublishedNeeds() (gfapi1/gfapi2's own read path) has no slug to spare
// for an admin-only nav link, so this is a separate query rather than
// widening a function three other callers share.
export async function getPublishedNeedsForAdmin(session: Session, limit: number): Promise<AdminNeedRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?")
    .bind(limit)
    .all();
  return result.results.map((r) => mapAdminNeedRow(r as Record<string, unknown>));
}

export interface DiscrepancyRow {
  id: number;
  foodbank_id: number | null;
  foodbank_name: string | null;
  foodbank_slug: string | null;
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
// second panel. foodbankdiscrepancy only denormalises foodbank_name at
// write time (0008_needcheck.sql), not slug -- joined here so the dashboard
// can link straight to the admin foodbank page (WP 6.7), same reasoning as
// getUnpublishedNeeds/getPublishedNeedsForAdmin above.
export async function getOpenDiscrepancies(session: Session, limit: number): Promise<DiscrepancyRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankdiscrepancy_full WHERE status = 'New' ORDER BY created DESC LIMIT ?")
    .bind(limit)
    .all<DiscrepancyRow>();
  return result.results;
}

export async function getDiscrepancyById(session: Session, id: number): Promise<DiscrepancyRow | null> {
  return session.prepare("SELECT * FROM foodbankdiscrepancy_full WHERE id = ?").bind(id).first<DiscrepancyRow>();
}

// gfadmin/views.py:2206-2217 discrepancy_action -- "invalid" (dismiss) or
// "done" (resolve). Unlike Django, POST-only (WP 6.3's carried-forward
// requirement: every mutating admin route is POST-only from the day it's
// written, not ported to GET and fixed up after).
export async function setDiscrepancyStatus(session: Session, id: number, status: "Done" | "Invalid"): Promise<void> {
  await session.prepare("UPDATE foodbankdiscrepancy SET status = ?, modified = ? WHERE id = ?").bind(status, pyNow(), id).run();
}

// gfadmin/views.py:431-442 needs_csv() -- frozen column order: id,
// created, foodbank, needs, excess, input_method. ALL needs regardless of
// published/nonpertinent status, unlike the review queue (WP 6.4) or the
// unfiltered-but-200-capped /needs/ list -- this export is unbounded.
export async function getAllNeedsForCsv(session: Session): Promise<FoodbankChangeRow[]> {
  const result = await session.prepare("SELECT * FROM foodbankchange_full ORDER BY created DESC").all();
  return result.results.map((r) => mapNeedRow(r as Record<string, unknown>));
}

// gfadmin/views.py:1774-1791 need()'s prev_published/prev_nonpert lookups
// -- the latest PRIOR need (created strictly before the one being viewed),
// not simply "the latest" (getLastPublishedNeed in needcheck.ts answers a
// different question: the pipeline's own "what did we last publish" check,
// unbounded by any particular need's created time).
export async function getPrevPublishedNeed(session: Session, foodbankId: number, beforeCreated: string): Promise<FoodbankChangeRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbankchange_full WHERE foodbank_id = ? AND published = 1 AND created < ? ORDER BY created DESC LIMIT 1")
    .bind(foodbankId, beforeCreated)
    .first();
  return row ? mapNeedRow(row as Record<string, unknown>) : null;
}

export async function getPrevNonpertinentNeed(session: Session, foodbankId: number, beforeCreated: string): Promise<FoodbankChangeRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbankchange_full WHERE foodbank_id = ? AND nonpertinent = 1 AND created < ? ORDER BY created DESC LIMIT 1")
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
  const [email, webpush, mobile, whatsapp] = await Promise.all([
    session.prepare("SELECT COUNT(*) AS n FROM foodbanksubscriber WHERE foodbank_id = ? AND confirmed = 1").bind(foodbankId).first<{ n: number }>(),
    session.prepare("SELECT COUNT(*) AS n FROM webpushsubscription WHERE foodbank_id = ?").bind(foodbankId).first<{ n: number }>(),
    session.prepare("SELECT COUNT(*) AS n FROM mobilesubscriber WHERE foodbank_id = ?").bind(foodbankId).first<{ n: number }>(),
    // Was hardcoded to 0 while the whatsappsubscriber table did not exist
    // (migration 0020 creates it). The admin's Notify confirmation shows
    // these counts, so a hardcoded 0 was not merely cosmetic -- it said
    // "nobody is subscribed" about 51 people who are.
    session.prepare("SELECT COUNT(*) AS n FROM whatsappsubscriber WHERE foodbank_id = ?").bind(foodbankId).first<{ n: number }>(),
  ]);
  return { email: email?.n ?? 0, webpush: webpush?.n ?? 0, mobile: mobile?.n ?? 0, whatsapp: whatsapp?.n ?? 0 };
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
//
// `publicChange` also stamps the food bank's `modified`, and callers pass it
// whenever a PUBLISHED need was involved (published, unpublished, edited or
// deleted). Django got this for free: a published need's save() ran the full
// `foodbank.save()`, whose TimestampedModel auto_now bumped `modified`. That
// column is what the site-wide "Last updated" footer reads (frag.ts's
// getLastModifiedFoodbank), so without it publishing needs every day left the
// footer showing the last food bank form edit, days old. Rejecting or
// deleting an unpublished need changes nothing the public can see, so those
// leave `modified` alone.
export async function recomputeFoodbankNeedFields(session: Session, foodbankId: number, publicChange = false): Promise<void> {
  const [lastNeed, latestPublished] = await Promise.all([
    session.prepare("SELECT created FROM foodbankchange WHERE foodbank_id = ? ORDER BY created DESC LIMIT 1").bind(foodbankId).first<{ created: string }>(),
    session
      .prepare("SELECT id, created FROM foodbankchange WHERE foodbank_id = ? AND published = 1 ORDER BY created DESC LIMIT 1")
      .bind(foodbankId)
      .first<{ id: number; created: string }>(),
  ]);
  const values = [lastNeed?.created ?? null, latestPublished?.id ?? null];
  if (publicChange) values.push(pyNow());
  await session
    .prepare(`UPDATE foodbank SET last_need = ?, latest_need_id = ?${publicChange ? ", modified = ?" : ""} WHERE id = ?`)
    .bind(...values, foodbankId)
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
  const need = await session.prepare("SELECT * FROM foodbankchange_full WHERE need_id = ?").bind(needId).first();
  if (!need) return null;
  const row = mapNeedRow(need as Record<string, unknown>);
  if (publish && row.foodbank_id === null) return "needs-foodbank";

  const now = pyNow();
  await session.prepare("UPDATE foodbankchange SET published = ?, modified = ? WHERE need_id = ?").bind(publish ? 1 : 0, now, needId).run();
  if (row.foodbank_id !== null) await recomputeFoodbankNeedFields(session, row.foodbank_id, publish || row.published);

  return { ...row, published: publish, modified: now };
}

// gfadmin/views.py:1949-1955 need_nonpertinent -- the de-facto "reject".
// Doesn't exclude an already-published need (neither does Django); if the
// need happens to be published, foodbank fields are recomputed too, same
// as any other write that could change which need is "latest".
export async function setNeedNonpertinent(session: Session, needId: string): Promise<FoodbankChangeRow | null> {
  const need = await session.prepare("SELECT * FROM foodbankchange_full WHERE need_id = ?").bind(needId).first();
  if (!need) return null;
  const row = mapNeedRow(need as Record<string, unknown>);

  const now = pyNow();
  await session.prepare("UPDATE foodbankchange SET nonpertinent = 1, modified = ? WHERE need_id = ?").bind(now, needId).run();
  if (row.foodbank_id !== null) await recomputeFoodbankNeedFields(session, row.foodbank_id, row.published);

  return { ...row, nonpertinent: true, modified: now };
}

// The statement, not the round trip: needLines.ts's upsertNeedLines puts
// this in the same batch as the lines it flags as categorised, so the two
// cannot disagree about which columns that means.
export function needCategorisedStatement(session: Session, needId: string, modified: string) {
  return session.prepare("UPDATE foodbankchange SET is_categorised = 1, modified = ? WHERE need_id = ?").bind(modified, needId);
}

export async function setNeedCategorised(session: Session, needId: string): Promise<void> {
  await needCategorisedStatement(session, needId, pyNow()).run();
}

export async function setNeedNotified(session: Session, needId: string): Promise<void> {
  const now = pyNow();
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
  const need = await session
    .prepare("SELECT foodbank_id, published FROM foodbankchange WHERE need_id = ?")
    .bind(needId)
    .first<{ foodbank_id: number | null; published: number }>();
  if (!need) return false;
  await session.prepare("DELETE FROM foodbankchange WHERE need_id = ?").bind(needId).run();
  if (need.foodbank_id !== null) await recomputeFoodbankNeedFields(session, need.foodbank_id, need.published === 1);
  return true;
}

// gfadmin/views.py:1916-1946 need_form (givefood/forms.py:231-236 NeedForm)
// -- the only fields NeedForm actually exposes once its own `exclude` and
// every editable=False field on FoodbankChange are accounted for (WP 6.5
// research): `foodbank`, `change_text`, `excess_change_text`, `published`.
// Reassigning `foodbank` moves which food bank's `latest_need`/`last_need`
// this need counts toward, so both the old and new food bank (when they
// differ) get recomputed, not just one.
export interface UpdateNeedRawFieldsParams {
  changeText: string;
  excessChangeText: string | null;
  published: boolean;
  foodbankId: number | null;
}

export async function updateNeedRawFields(session: Session, needId: string, params: UpdateNeedRawFieldsParams): Promise<boolean> {
  const need = await session
    .prepare("SELECT foodbank_id, published FROM foodbankchange WHERE need_id = ?")
    .bind(needId)
    .first<{ foodbank_id: number | null; published: number }>();
  if (!need) return false;

  const now = pyNow();
  await session
    .prepare("UPDATE foodbankchange SET change_text = ?, excess_change_text = ?, published = ?, foodbank_id = ?, modified = ? WHERE need_id = ?")
    .bind(params.changeText, params.excessChangeText, params.published ? 1 : 0, params.foodbankId, now, needId)
    .run();

  // Food bank id -> whether its public needs changed: the old one if the
  // need was published there, the new one if it is published now.
  const affected = new Map<number, boolean>();
  if (need.foodbank_id !== null) affected.set(need.foodbank_id, need.published === 1);
  if (params.foodbankId !== null) affected.set(params.foodbankId, (affected.get(params.foodbankId) ?? false) || params.published);
  for (const [foodbankId, publicChange] of affected) await recomputeFoodbankNeedFields(session, foodbankId, publicChange);
  return true;
}

// gfadmin/views.py:423-428 needs_deleteall -- the dashboard's bulk-delete-
// backlog form. Django's version is a QuerySet `.delete()`, which bypasses
// the model's delete() override entirely: no foodbank recompute for any
// affected food bank at all (confirmed, WP 6.4 research). Fixed here: every
// distinct foodbank_id among the deleted rows gets recomputed once, not
// once per deleted need -- a queue backlog often holds several stale needs
// for the same food bank, and the Map dedupes that down to one write each.
// CHUNKED AT 90 IDS, because D1 caps a statement at 100 bound parameters.
// This used to bind the whole list into one `need_id IN (?, ?, ...)`, which
// worked until the review queue grew past 100 and then 500'd -- reported
// 2026-09-05 with 116 unreviewed needs on the dashboard, which is exactly
// the situation the "Delete all" button exists for. The failure mode was
// the worst kind: fine in testing, broken precisely when the queue was big
// enough for anyone to want the button.
//
// 90, not 100, for headroom -- nothing else binds here, but a chunk size
// equal to the hard limit leaves no room for a future extra predicate.
//
// NOT ATOMIC across chunks. A failure partway through leaves the earlier
// chunks deleted; the alternative (one D1 batch) has the same parameter
// cap per statement and would need the same chunking anyway. Deleting
// needs is idempotent -- re-running the action deletes whatever survived --
// so partial progress is recoverable in a way that a stuck 500 is not.
const DELETE_CHUNK = 90;

export async function deleteNeedsByUuids(session: Session, needIds: readonly string[]): Promise<void> {
  if (needIds.length === 0) return;

  // Food bank id -> whether any of its deleted needs was published.
  const affectedFoodbanks = new Map<number, boolean>();
  for (let i = 0; i < needIds.length; i += DELETE_CHUNK) {
    const chunk = needIds.slice(i, i + DELETE_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const affected = await session
      .prepare(
        `SELECT foodbank_id, MAX(published) AS published FROM foodbankchange WHERE need_id IN (${placeholders}) AND foodbank_id IS NOT NULL GROUP BY foodbank_id`,
      )
      .bind(...chunk)
      .all<{ foodbank_id: number; published: number }>();
    for (const { foodbank_id, published } of affected.results) {
      affectedFoodbanks.set(foodbank_id, (affectedFoodbanks.get(foodbank_id) ?? false) || published === 1);
    }
    await session.prepare(`DELETE FROM foodbankchange WHERE need_id IN (${placeholders})`).bind(...chunk).run();
  }

  // Deduped across chunks and recomputed once per food bank: a bulk delete
  // routinely hits the same food bank several times, and this is the
  // expensive half (two queries plus an UPDATE each).
  for (const [foodbankId, publicChange] of affectedFoodbanks) await recomputeFoodbankNeedFields(session, foodbankId, publicChange);
}
