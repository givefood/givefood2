import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import { getMostViewed } from "./homepage";
import { HIT_ROLLUP_FIRST_DAY, upsertFoodbankHitsForDay } from "./hits";
import type { Session } from "./types";

// upsertFoodbankHitsForDay -- the D1 half of the Analytics Engine rollup.
//
// REAL SQLITE, against the real migrations, because every interesting
// property of this statement belongs to the engine rather than the module:
// json_each resolving an object's keys, the slug join dropping unknown food
// banks, the upsert parsing at all (it needs its `WHERE true`), and
// foodbankhit's (foodbank_id, day) primary key being what makes a re-run an
// update instead of a duplicate row. A canned session could agree with all
// of that and still ship a statement D1 rejects.

type Bindable = null | number | bigint | string | Uint8Array;

// Forwards `changes` from the engine, because the module returns it and a
// caller logs it as the number of food banks written.
function d1Session(db: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

function seedFoodbank(db: DatabaseSync, id: number, name: string, slug: string): void {
  db.prepare(
    `INSERT INTO foodbank (
       id, uuid, name, slug, address, postcode, country, lat_lng,
       charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs,
       created, modified
     ) VALUES (?, ?, ?, ?, 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
       0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
       0, 0, 0, 7,
       '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(id, `uuid-${id}`, name, slug);
}

function hitRows(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT foodbank_id, day, hits FROM foodbankhit ORDER BY day, foodbank_id").all();
}

let db: DatabaseSync;
let session: Session;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  session = d1Session(db);
  seedFoodbank(db, 1, "Salisbury", "salisbury");
  seedFoodbank(db, 2, "Brixton", "brixton");
});

describe("upsertFoodbankHitsForDay", () => {
  it("writes one row per food bank, resolved from slug to id", async () => {
    const written = await upsertFoodbankHitsForDay(session, "2026-09-14", { salisbury: 12, brixton: 3 });
    expect(written).toBe(2);
    expect(hitRows(db)).toEqual([
      { foodbank_id: 1, day: "2026-09-14", hits: 12 },
      { foodbank_id: 2, day: "2026-09-14", hits: 3 },
    ]);
  });

  it("drops slugs with no food bank, and does not count them as written", async () => {
    const written = await upsertFoodbankHitsForDay(session, "2026-09-14", { salisbury: 5, "renamed-since": 9 });
    expect(written).toBe(1);
    expect(hitRows(db)).toEqual([{ foodbank_id: 1, day: "2026-09-14", hits: 5 }]);
  });

  // The cron re-reads a whole day each hour. ADD instead of SET would turn
  // the 5 seen at 10:07 plus the 8 seen at 11:07 into 13.
  it("replaces a day's count on a re-run rather than adding to it", async () => {
    await upsertFoodbankHitsForDay(session, "2026-09-14", { salisbury: 5 });
    await upsertFoodbankHitsForDay(session, "2026-09-14", { salisbury: 8, brixton: 1 });
    expect(hitRows(db)).toEqual([
      { foodbank_id: 1, day: "2026-09-14", hits: 8 },
      { foodbank_id: 2, day: "2026-09-14", hits: 1 },
    ]);
  });

  it("leaves other days alone", async () => {
    db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (1, '2026-09-13', 40)").run();
    await upsertFoodbankHitsForDay(session, "2026-09-14", { salisbury: 2 });
    expect(hitRows(db)).toEqual([
      { foodbank_id: 1, day: "2026-09-13", hits: 40 },
      { foodbank_id: 1, day: "2026-09-14", hits: 2 },
    ]);
  });

  it("is a no-op for a day with no hits", async () => {
    expect(await upsertFoodbankHitsForDay(session, "2026-09-14", {})).toBe(0);
    expect(hitRows(db)).toEqual([]);
  });

  // Slugs are interpolated by nobody -- they travel inside a bound JSON
  // string -- but they arrive from a public POST path, so prove a hostile
  // one is just an unknown key.
  it("treats a slug containing quotes as data", async () => {
    const written = await upsertFoodbankHitsForDay(session, "2026-09-14", { "x'); DROP TABLE foodbankhit; --": 1 });
    expect(written).toBe(0);
    expect(hitRows(db)).toEqual([]);
  });

  // 2026-09-05 holds Django's partial count. An upsert from AE would
  // replace 872,477 hits with 923.
  it("refuses to overwrite Django's days", async () => {
    db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (1, '2026-09-05', 872477)").run();
    await expect(upsertFoodbankHitsForDay(session, "2026-09-05", { salisbury: 923 })).rejects.toThrow(HIT_ROLLUP_FIRST_DAY);
    expect(hitRows(db)).toEqual([{ foodbank_id: 1, day: "2026-09-05", hits: 872477 }]);
  });

  // The symptom this module exists to fix, end to end on the reader side.
  it("is what makes getMostViewed return rows again", async () => {
    expect(await getMostViewed(session, "2026-09-08", "2026-09-15", 8)).toEqual([]);
    await upsertFoodbankHitsForDay(session, "2026-09-14", { salisbury: 2, brixton: 7 });
    expect(await getMostViewed(session, "2026-09-08", "2026-09-15", 8)).toEqual([
      { name: "Brixton", slug: "brixton" },
      { name: "Salisbury", slug: "salisbury" },
    ]);
  });
});
