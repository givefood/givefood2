import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import { getSiteStats, refreshSiteStats } from "./homepage";
import type { Session } from "./types";

// refreshSiteStats -- the hourly writer for site_stats, replacing the
// extraction tool's load_site_stats(). Its own file rather than a block in
// homepage.test.ts because that file runs on a trimmed schema, and this
// statement reads five tables that schema leaves out. The real migrations
// here, so every clause runs against the columns production has.

type Bindable = null | number | bigint | string | Uint8Array;

let db: DatabaseSync;
let session: Session;

function d1Session(sqlite: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => (sqlite.prepare(sql).run(...params), { success: true, meta: {} }),
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  session = d1Session(db);
});

function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...(Object.values(row) as Bindable[]));
}

let counter = 0;
function seedFoodbank(row: Record<string, unknown>): void {
  counter += 1;
  insert("foodbank", {
    uuid: `uuid-${counter}`,
    address: "1 Test Street",
    postcode: "SP1 1AA",
    country: "England",
    lat_lng: "51.0,-1.8",
    charity_just_foodbank: 0,
    contact_email: "info@example.org",
    url: "https://example.org/",
    shopping_list_url: "https://example.org/list/",
    address_is_administrative: 0,
    is_closed: 0,
    no_locations: 0,
    days_between_needs: 7,
    created: "2020-01-01 00:00:00.000000",
    modified: "2020-01-01 00:00:00.000000",
    ...row,
  });
}

describe("refreshSiteStats", () => {
  // Every NOT NULL column without a default, filled, so a seed names only
  // what the clause under test reads (plus `name`, which is UNIQUE per food
  // bank on both location tables). Read from the real schema, so a new
  // NOT NULL column cannot make these seeds silently wrong.
  function seedFilled(table: string, row: Record<string, unknown>): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
    const filled: Record<string, unknown> = {};
    for (const c of columns) {
      if (c.notnull && c.dflt_value === null && !c.pk) filled[c.name] = c.type.toUpperCase().includes("INT") || c.type.toUpperCase() === "REAL" ? 0 : "x";
    }
    insert(table, { ...filled, ...row });
  }

  // Distinct counts per clause (1, 2, 4, 8 ... ), so dropping, duplicating or
  // swapping any one SELECT moves a total to a value no other mistake gives.
  function seedAll(): void {
    // foodbank: 5 rows. Delivery address on 2 (one more is ''), 3 not
    // administrative. One closed -- closed food banks still count, as they
    // did in get_site_stats().
    seedFoodbank({ name: "A", slug: "a", delivery_address: "1 Dock Road", address_is_administrative: 0 });
    seedFoodbank({ name: "B", slug: "b", delivery_address: "2 Dock Road", address_is_administrative: 0 });
    seedFoodbank({ name: "C", slug: "c", delivery_address: "", address_is_administrative: 0 });
    seedFoodbank({ name: "D", slug: "d", delivery_address: null, address_is_administrative: 1 });
    seedFoodbank({ name: "E", slug: "e", delivery_address: null, address_is_administrative: 1, is_closed: 1 });
    // foodbanklocation: 7 rows, 4 of them donation points (NULL is not one).
    for (const [i, dp] of [1, 1, 1, 1, 0, null, null].entries()) seedFilled("foodbanklocation", { id: i + 1, name: `Location ${i}`, is_donation_point: dp });
    // foodbankdonationpoint: 16 rows.
    for (let i = 1; i <= 16; i++) seedFilled("foodbankdonationpoint", { id: i, name: `Point ${i}` });
    // foodbankchangeline: 32 rows.
    for (let i = 1; i <= 32; i++) seedFilled("foodbankchangeline", { id: i });
    // orders: 1,499 + 1,001 = 2,500 calories -> 5 meals; 2,999 would be 5 too.
    seedFilled("orders", { id: 1, calories: 1499 });
    seedFilled("orders", { id: 2, calories: 1001 });
  }

  it("recomputes get_site_stats()'s figures from the live tables", async () => {
    seedAll();
    await refreshSiteStats(session, "2026-09-15 17:37:00.000000");
    expect(await getSiteStats(session)).toEqual({
      foodbanks: 5 + 2 + 7, //                  all + delivery + locations
      donationpoints: 16 + 3 + 2 + 4, //        points + non-admin + delivery + location points
      items: 32,
      meals: 5,
      computed_at: "2026-09-15 17:37:00.000000",
    });
  });

  it("floors meals, as int(calories / 500) did", async () => {
    seedFilled("orders", { id: 1, calories: 999 });
    await refreshSiteStats(session, "2026-09-15 17:37:00.000000");
    expect((await getSiteStats(session))!.meals).toBe(1);
  });

  // The ETL's row is there in production; the refresh must replace it rather
  // than trip the id = 1 CHECK or leave the old figures.
  it("replaces the extraction tool's row", async () => {
    insert("site_stats", { id: 1, foodbanks: 3095, donationpoints: 7718, items: 333208, meals: 173808, computed_at: "2026-09-05 19:58:29.815970" });
    seedAll();
    await refreshSiteStats(session, "2026-09-15 17:37:00.000000");
    expect(await getSiteStats(session)).toMatchObject({ foodbanks: 14, items: 32, computed_at: "2026-09-15 17:37:00.000000" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM site_stats").get()).toEqual({ n: 1 });
  });

  it("writes zeros, not NULLs, for an empty database", async () => {
    await refreshSiteStats(session, "2026-09-15 17:37:00.000000");
    expect(await getSiteStats(session)).toMatchObject({ foodbanks: 0, donationpoints: 0, items: 0, meals: 0 });
  });
});
