import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../worker-configuration";
import { hitRollup, readDayFromAnalyticsEngine } from "./index";

// hitRollup -- Analytics Engine -> D1 foodbankhit. Real SQLite for the write
// (the upsert's own properties are pinned in packages/db/src/hits.test.ts);
// fetch is stubbed with the AE SQL API's real response shape, UInt64 counts
// as strings included, captured from production 2026-09-15.

type Bindable = null | number | bigint | string | Uint8Array;

function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  const session = { prepare: (sql: string) => statement(sql, []), getBookmark: () => null };
  return { withSession: () => session } as unknown as D1Database;
}

function seedFoodbank(db: DatabaseSync, id: number, slug: string): void {
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
  ).run(id, `uuid-${id}`, slug, slug);
}

function aeResponse(rows: { slug: string; hits: string }[]): Response {
  return new Response(
    JSON.stringify({
      meta: [
        { name: "slug", type: "String" },
        { name: "hits", type: "UInt64" },
      ],
      data: rows,
      rows: rows.length,
    }),
    { status: 200 },
  );
}

let db: DatabaseSync;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedFoodbank(db, 1, "salvation-army");
  seedFoodbank(db, 2, "black-country");
  env = { DB: d1(db), CF_ACCOUNT_ID: "acct", CF_API_KEY: "token" } as unknown as Env;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rows = () => db.prepare("SELECT foodbank_id, day, hits FROM foodbankhit ORDER BY day, foodbank_id").all();
const queriedDay = (call: number) => String(fetchMock.mock.calls[call]![1].body).match(/toDateTime\('(\d{4}-\d{2}-\d{2})/)?.[1];

describe("readDayFromAnalyticsEngine", () => {
  it("sums the sample interval, keyed by slug, over one UTC day", async () => {
    fetchMock.mockResolvedValueOnce(aeResponse([{ slug: "salvation-army", hits: "790" }]));
    expect(await readDayFromAnalyticsEngine(env, "2026-09-14")).toEqual({ "salvation-army": 790 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql");
    expect(init.headers.Authorization).toBe("Bearer token");
    expect(init.body).toContain("SUM(_sample_interval)");
    expect(init.body).not.toContain("COUNT(");
    expect(init.body).toContain("toDateTime('2026-09-14 00:00:00')");
  });

  it("names the missing permission on a 403", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(readDayFromAnalyticsEngine(env, "2026-09-14")).rejects.toThrow("Account Analytics: Read");
  });

  it("throws rather than returning an empty day when the body has no data", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: ["boom"] }), { status: 200 }));
    await expect(readDayFromAnalyticsEngine(env, "2026-09-14")).rejects.toThrow("no data array");
  });
});

describe("hitRollup", () => {
  it("rolls up yesterday and today into foodbankhit", async () => {
    fetchMock
      .mockResolvedValueOnce(aeResponse([{ slug: "salvation-army", hits: "790" }, { slug: "black-country", hits: "132" }]))
      .mockResolvedValueOnce(aeResponse([{ slug: "black-country", hits: "4" }]));
    await hitRollup(env, Date.parse("2026-09-15T10:07:00Z"));
    expect([queriedDay(0), queriedDay(1)]).toEqual(["2026-09-14", "2026-09-15"]);
    expect(rows()).toEqual([
      { foodbank_id: 1, day: "2026-09-14", hits: 790 },
      { foodbank_id: 2, day: "2026-09-14", hits: 132 },
      { foodbank_id: 2, day: "2026-09-15", hits: 4 },
    ]);
  });

  // An AE error written through as an empty SET would be harmless (an empty
  // object writes nothing), but a thrown day must not stop the other.
  it("still rolls up today when yesterday's read fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 })).mockResolvedValueOnce(aeResponse([{ slug: "salvation-army", hits: "9" }]));
    await hitRollup(env, Date.parse("2026-09-15T10:07:00Z"));
    expect(rows()).toEqual([{ foodbank_id: 1, day: "2026-09-15", hits: 9 }]);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("never reads or writes the cutover day or earlier", async () => {
    fetchMock.mockResolvedValue(aeResponse([{ slug: "salvation-army", hits: "1" }]));
    await hitRollup(env, Date.parse("2026-09-06T00:07:00Z"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(queriedDay(0)).toBe("2026-09-06");
  });
});
