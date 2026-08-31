import { coerceBooleans, type Session } from "./types";

// WP 3.7. Query functions for the three D1 tables 0004_subscribers.sql
// creates: foodbanksubscriber, webpushsubscription, mobilesubscriber --
// email subscribe/confirm/unsubscribe (gfwfbn/views.py's `updates`), web
// push (webpush_config/webpush_subscribe/webpush_unsubscribe) and the
// shipped-native-app contract (mobsub/delete_mobsub). See
// workers/site/src/routes/wfbn/{updates,webpush,mobsub}.ts for the
// callers.
//
// This is the first WRITE-side file in packages/db -- every other file in
// this package is read-only (the D1 tables they query are populated by a
// one-off batch copy from Postgres, never written at request time). D1's
// read-replication caveat that motivates the Sessions API everywhere else
// (PLAN.md §3.3) applies just as much to a write immediately followed by a
// read in the SAME request -- every function below still takes an
// already-created `Session`, propagated by the caller exactly like every
// read-only query in this package, never a bare `env.DB.prepare()`.
//
// `created` columns are stamped here with `new Date().toISOString()` (a
// "T"-separated, millisecond-precision UTC string), not the
// space-separated "YYYY-MM-DD HH:MM:SS.ffffff" format
// tools/pg-to-d1/extract_core.py used for the one-off Postgres copy --
// lib/timesince.ts's own parser already tolerates both forms (see its
// module comment), and every row these functions insert is new, not
// migrated, so there is no existing-row format to stay byte-consistent
// with.

const SUBSCRIBER_BOOLEAN_COLUMNS = ["confirmed"] as const;

export interface FoodbankSubscriberRow {
  id: number;
  created: string;
  last_contacted: string | null;
  foodbank_id: number;
  foodbank_name: string | null;
  email: string;
  confirmed: boolean;
  sub_key: string;
  unsub_key: string;
}

function mapSubscriberRow(raw: Record<string, unknown>): FoodbankSubscriberRow {
  return coerceBooleans<FoodbankSubscriberRow>(raw, SUBSCRIBER_BOOLEAN_COLUMNS);
}

// `updates`'s subscribe action -- the explicit pre-check that replaces
// Django's IntegrityError-on-save() catch (`sub_email_fb_uniq` is the same
// unique_together('email', 'foodbank') constraint, just enforced in D1
// rather than Postgres). Callers must pass an already-lowercased email --
// FoodbankSubscriber.save() lowercases before the uniqueness constraint
// ever sees it (givefood/models/subscribers.py:41), so a caller comparing
// against a mixed-case address would miss a real dupe.
export async function getSubscriberByEmailAndFoodbank(
  session: Session,
  email: string,
  foodbankId: number,
): Promise<FoodbankSubscriberRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbanksubscriber WHERE email = ? AND foodbank_id = ?")
    .bind(email, foodbankId)
    .first();
  return row ? mapSubscriberRow(row as Record<string, unknown>) : null;
}

export interface InsertSubscriberParams {
  foodbankId: number;
  foodbankName: string | null;
  email: string;
  subKey: string;
  unsubKey: string;
}

// `updates`'s subscribe action, the success path -- `confirmed` defaults
// to 0/false (FoodbankSubscriber's own model default), sub_key/unsub_key
// are supplied by the caller (routes/wfbn/updates.ts does the SHA-256
// hashing -- Web Crypto is a Worker-runtime concern, not a DB-layer one).
// Returns the new row's id.
export async function insertSubscriber(session: Session, params: InsertSubscriberParams): Promise<number> {
  const created = new Date().toISOString();
  const result = await session
    .prepare(
      "INSERT INTO foodbanksubscriber (created, foodbank_id, foodbank_name, email, confirmed, sub_key, unsub_key) " +
        "VALUES (?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(created, params.foodbankId, params.foodbankName, params.email, params.subKey, params.unsubKey)
    .run();
  return result.meta.last_row_id;
}

// `updates`'s confirm action -- `sub_key_idx` is UNIQUE, so this is a
// single-row lookup with no other predicate needed (see
// 0004_subscribers.sql's own comment on why that index exists).
export async function getSubscriberBySubKey(session: Session, subKey: string): Promise<FoodbankSubscriberRow | null> {
  const row = await session.prepare("SELECT * FROM foodbanksubscriber WHERE sub_key = ?").bind(subKey).first();
  return row ? mapSubscriberRow(row as Record<string, unknown>) : null;
}

// `updates`'s unsubscribe action -- same shape as getSubscriberBySubKey,
// against `unsub_key_idx`.
export async function getSubscriberByUnsubKey(session: Session, unsubKey: string): Promise<FoodbankSubscriberRow | null> {
  const row = await session.prepare("SELECT * FROM foodbanksubscriber WHERE unsub_key = ?").bind(unsubKey).first();
  return row ? mapSubscriberRow(row as Record<string, unknown>) : null;
}

// `updates`'s confirm action -- idempotent at the call site (the route
// only calls this when `!sub.confirmed`), but the UPDATE itself is
// idempotent too either way.
export async function confirmSubscriber(session: Session, id: number): Promise<void> {
  await session.prepare("UPDATE foodbanksubscriber SET confirmed = 1 WHERE id = ?").bind(id).run();
}

// `updates`'s unsubscribe action -- a real hard delete, matching
// `sub.delete()`.
export async function deleteSubscriberById(session: Session, id: number): Promise<void> {
  await session.prepare("DELETE FROM foodbanksubscriber WHERE id = ?").bind(id).run();
}

export interface WebPushSubscriptionRow {
  id: number;
  created: string;
  foodbank_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  browser: string | null;
}

export interface UpsertWebPushSubscriptionParams {
  foodbankId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  browser: string | null;
}

// `webpush_subscribe` -- Django's `WebPushSubscription.objects.update_or_create(
// foodbank=foodbank, endpoint=endpoint, defaults={...})`, reproduced as an
// explicit SELECT-then-INSERT/UPDATE against `webpush_fb_endpoint_uniq`
// (the same (foodbank_id, endpoint) pair Django's lookup kwargs use) so the
// caller can report the same created/not-created distinction
// update_or_create's own return tuple gives Django.
export async function upsertWebpushSubscription(
  session: Session,
  params: UpsertWebPushSubscriptionParams,
): Promise<{ id: number; created: boolean }> {
  const existing = await session
    .prepare("SELECT id FROM webpushsubscription WHERE foodbank_id = ? AND endpoint = ?")
    .bind(params.foodbankId, params.endpoint)
    .first<{ id: number }>();

  if (existing) {
    await session
      .prepare("UPDATE webpushsubscription SET p256dh = ?, auth = ?, browser = ? WHERE id = ?")
      .bind(params.p256dh, params.auth, params.browser, existing.id)
      .run();
    return { id: existing.id, created: false };
  }

  const created = new Date().toISOString();
  const result = await session
    .prepare(
      "INSERT INTO webpushsubscription (created, foodbank_id, endpoint, p256dh, auth, browser) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(created, params.foodbankId, params.endpoint, params.p256dh, params.auth, params.browser)
    .run();
  return { id: result.meta.last_row_id, created: true };
}

// `webpush_unsubscribe` -- Django's `.filter(foodbank=foodbank,
// endpoint=endpoint).delete()`, whose `deleted_count` is what decides
// `deleted` in the JSON response; D1's `meta.changes` is the same count
// for a DELETE.
export async function deleteWebpushSubscription(
  session: Session,
  params: { foodbankId: number; endpoint: string },
): Promise<boolean> {
  const result = await session
    .prepare("DELETE FROM webpushsubscription WHERE foodbank_id = ? AND endpoint = ?")
    .bind(params.foodbankId, params.endpoint)
    .run();
  return result.meta.changes > 0;
}

export interface MobileSubscriberRow {
  id: number;
  created: string;
  device_id: string;
  platform: string;
  timezone: string | null;
  locale: string | null;
  app_version: string | null;
  os_version: string | null;
  device_model: string | null;
  sub_type: string | null;
  foodbank_id: number;
  donationpoint_id: number | null;
}

export interface MobileSubscriberIdentity {
  deviceId: string;
  foodbankId: number;
  donationpointId: number | null;
}

// The three-column match `findMobileSubscriber`/`upsertMobileSubscriber`/
// `deleteMobileSubscriber` all need -- see 0004_subscribers.sql's own
// comment on why there is no unique index to do this at the DB level:
// SQLite treats every NULL as distinct from every other NULL, so a plain
// `donationpoint_id = ?` would never match the (very common) rows where
// it's NULL, and a UNIQUE INDEX over the triple wouldn't dedupe those rows
// against each other either. `IS` is SQLite's null-safe equality operator
// (unlike `=`, `NULL IS NULL` is true) and also compares two non-NULL
// values exactly like `=`, so a single `IS ?` predicate is correct for
// this whole column regardless of whether donationpointId is null.
function mobileSubscriberMatchClause(identity: MobileSubscriberIdentity): { clause: string; params: unknown[] } {
  return {
    clause: "device_id = ? AND foodbank_id = ? AND donationpoint_id IS ?",
    params: [identity.deviceId, identity.foodbankId, identity.donationpointId],
  };
}

// `mobsub`/`delete_mobsub`'s shared lookup -- Django does a real
// read-then-write here (`update_or_create`), never a DB-level upsert; see
// 0004_subscribers.sql's comment. This is that read.
export async function findMobileSubscriber(
  session: Session,
  identity: MobileSubscriberIdentity,
): Promise<MobileSubscriberRow | null> {
  const { clause, params } = mobileSubscriberMatchClause(identity);
  const row = await session
    .prepare(`SELECT * FROM mobilesubscriber WHERE ${clause}`)
    .bind(...params)
    .first();
  return row ? (row as unknown as MobileSubscriberRow) : null;
}

export interface UpsertMobileSubscriberParams extends MobileSubscriberIdentity {
  platform: string;
  timezone: string | null;
  locale: string | null;
  appVersion: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  subType: string | null;
}

// `mobsub` -- Django's `MobileSubscriber.objects.update_or_create(device_id=,
// foodbank=, donationpoint=, defaults={...})`, reproduced verbatim as
// find-then-branch: UPDATE the existing row in place (preserving its id)
// when found, INSERT a new one otherwise. Deliberately NOT `INSERT OR
// REPLACE` -- that would delete-and-reinsert under a new rowid, which is
// observably different from update_or_create()'s real behaviour (it
// updates the existing row) for anything that ever comes to reference
// mobilesubscriber.id.
export async function upsertMobileSubscriber(session: Session, params: UpsertMobileSubscriberParams): Promise<void> {
  const existing = await findMobileSubscriber(session, params);

  if (existing) {
    await session
      .prepare(
        "UPDATE mobilesubscriber SET platform = ?, timezone = ?, locale = ?, app_version = ?, os_version = ?, " +
          "device_model = ?, sub_type = ? WHERE id = ?",
      )
      .bind(
        params.platform,
        params.timezone,
        params.locale,
        params.appVersion,
        params.osVersion,
        params.deviceModel,
        params.subType,
        existing.id,
      )
      .run();
    return;
  }

  const created = new Date().toISOString();
  await session
    .prepare(
      "INSERT INTO mobilesubscriber (created, device_id, platform, timezone, locale, app_version, os_version, " +
        "device_model, sub_type, foodbank_id, donationpoint_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      created,
      params.deviceId,
      params.platform,
      params.timezone,
      params.locale,
      params.appVersion,
      params.osVersion,
      params.deviceModel,
      params.subType,
      params.foodbankId,
      params.donationpointId,
    )
    .run();
}

// `delete_mobsub` -- Django's `.filter(device_id=, foodbank=,
// donationpoint=).delete()`; the view reports `deleted: deleted_count > 0`
// rather than 404ing on a no-op delete (its own test coverage asserts
// this), so the boolean this returns is meant to flow straight into that
// response, not to gate a 404.
export async function deleteMobileSubscriber(session: Session, identity: MobileSubscriberIdentity): Promise<boolean> {
  const { clause, params } = mobileSubscriberMatchClause(identity);
  const result = await session
    .prepare(`DELETE FROM mobilesubscriber WHERE ${clause}`)
    .bind(...params)
    .run();
  return result.meta.changes > 0;
}
