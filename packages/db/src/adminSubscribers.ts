import type { Session } from "./types";

// gfadmin/views.py:1594-1612 foodbank_addsub -- the admin's manual "paste a
// list of addresses" bulk add. Kept out of subscribers.ts (which owns the
// PUBLIC subscribe/confirm/unsubscribe path, WP 3.7) because the two have
// opposite requirements on exactly one column: insertSubscriber() hardcodes
// `confirmed` to 0 in its VALUES list (subscribers.ts:84) because the public
// flow REQUIRES double opt-in, and this view sets it to True
// (views.py:1606) because it is the documented escape hatch out of that
// flow. Reusing one function with a boolean flag would make the public
// path's guarantee a parameter; two functions keep it structural.

export interface AdminSubscriberInsert {
  email: string;
  subKey: string;
  unsubKey: string;
}

// Django saves row by row in a bare Python loop with no transaction and no
// dedupe (views.py:1602-1608), so re-adding an address that already
// subscribes violates unique_together('email','foodbank') -> IntegrityError
// -> unhandled 500, with every line BEFORE the duplicate already committed
// and every line after it never attempted. Partial application, a 500, and
// no report of what happened.
//
// `ON CONFLICT(email, foodbank_id) DO NOTHING` against sub_email_fb_uniq
// (0004_subscribers.sql:25, the D1 equivalent of that unique_together) is
// PLAN.md:9724's own prescribed fix -- it dedupes with no read-then-write
// race, and meta.changes tells the caller how many rows were genuinely new
// so the page can report "N added, M already subscribed".
//
// One session.batch() rather than N round trips, same pattern as
// foodbankAdmin.ts:16's cascade delete. Returns the number of rows actually
// inserted.
export async function insertConfirmedSubscribers(
  session: Session,
  foodbankId: number,
  rows: AdminSubscriberInsert[],
): Promise<number> {
  if (rows.length === 0) return 0;

  // Same "T"-separated ISO string every other write-side function in this
  // package stamps -- see subscribers.ts's module comment on why that
  // differs from the migrated rows' Postgres-shaped format and why it does
  // not matter.
  const created = new Date().toISOString();
  const sql =
    "INSERT INTO foodbanksubscriber (created, foodbank_id, email, confirmed, sub_key, unsub_key) " +
    "VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(email, foodbank_id) DO NOTHING";

  const results = await session.batch(
    rows.map((r) => session.prepare(sql).bind(created, foodbankId, r.email, r.subKey, r.unsubKey)),
  );
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}
