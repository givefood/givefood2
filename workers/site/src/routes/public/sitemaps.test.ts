import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/public/sitemaps.ts -- /sitemap.xml (and its /cy/, /ga/, /gd/
// registrations), Django's `sitemap()` at givefood/views.py:643-696.
//
// WHY THIS FILE EXISTS. The handler was changed to stop four `SELECT *`
// queries dragging 14.2 MB of D1 result payload per render out to emit a
// ~590 KB body (measured on production: the food-bank query 3,590,727 ->
// 279,644 bytes and the donation-point one 10,643,022 -> 554,510, rows_read
// unchanged on both). A column projection is exactly the kind of change that
// looks free and is not: EVERY branch in the loop below reads one of the
// seven columns the food-bank query now names, and a column left out of that
// list does not throw, does not log, and does not change the status code --
// it silently deletes a class of <url> from the sitemap. Google notices
// months later; nobody else ever does.
//
// So these tests assert the WHOLE BODY, byte for byte, over a fixture that
// exercises every branch at least once and its negation at least once:
//
//   days_between_needs  -> <changefreq> (all four bands)
//   no_locations        -> whether the /locations/ url exists
//   no_donation_points  -> whether the /donationpoints/ url exists, with the
//                          NULL case distinguished from 0 (the column is
//                          nullable in production, unlike no_locations)
//   rss_url / news_url  -> whether the /news/ url exists, either one alone
//   charity_name        -> whether the /charity/ url exists
//   is_closed           -> whether the food bank appears at all
//
// If the projection loses a column, the emitted body changes and the
// whole-body assertion fails with a readable diff. If a future migration
// renames one, packages/db's own drift tests fail first.
//
// REAL EVERYTHING, the way routes/admin/map.test.ts does it: the real
// production app (workers/site/src/index.ts's default export), the real
// router and middleware, and real in-memory SQLite built from the real
// migrations -- so the four locale registrations, the LEFT JOINs in
// foodbanklocation_full / foodbankdonationpoint_full, and the `is_closed`
// filters are all the genuine article rather than a mock's opinion of them.
// Mocked: only the two KV namespaces, which are Maps.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite --
// the same shim routes/admin/map.test.ts uses. `prepared` records the SQL
// that actually reached the engine, which is load-bearing here: "the sitemap
// still renders" is true of the wide queries too, so the only way to pin the
// projection itself is to look at the statements.
function d1Session(db: DatabaseSync, prepared: string[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: string[];
let kv: Map<string, string>;

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, prepared) },
    SESSIONS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    DATA: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  isClosed?: 0 | 1;
  daysBetweenNeeds?: number;
  noLocations?: number;
  noDonationPoints?: number | null;
  rssUrl?: string | null;
  newsUrl?: string | null;
  charityName?: string | null;
}

// Every NOT NULL column the real migration declares, so a seeded row is one
// production would have accepted. Only the seven the sitemap loop reads are
// parameterised -- that set IS the projection under test.
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng,
       network, charity_just_foodbank, charity_name, contact_email, url, shopping_list_url,
       rss_url, news_url, address_is_administrative, is_closed, no_locations, no_donation_points,
       days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79',
       'Trussell Trust', 0, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    `${s.slug} Foodbank`,
    s.slug,
    s.charityName ?? null,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.rssUrl ?? null,
    s.newsUrl ?? null,
    s.isClosed ?? 0,
    s.noLocations ?? 0,
    s.noDonationPoints === undefined ? null : s.noDonationPoints,
    s.daysBetweenNeeds ?? 14,
  );
}

function seedLocation(id: number, foodbankId: number, slug: string, isClosed: 0 | 1 = 0): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, modified)
     VALUES (?, ?, ?, ?, ?, '2 Low Street', 'SP2 2BB', 'England', '51.08,-1.80', 51.08, -1.80, ?,
       '2020-01-01 00:00:00.000000')`,
  ).run(id, String(id).padStart(32, "e"), foodbankId, `${slug} Centre`, slug, isClosed);
}

function seedDonationPoint(id: number, foodbankId: number, slug: string, isClosed: 0 | 1 = 0): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, in_store_only, modified)
     VALUES (?, ?, ?, ?, ?, '3 Retail Park', 'SP3 3CC', 'England', '51.06,-1.78', 51.06, -1.78, ?, 0,
       '2020-01-01 00:00:00.000000')`,
  ).run(id, String(id).padStart(32, "d"), foodbankId, `${slug} Store`, slug, isClosed);
}

function seedConstituency(id: number, slug: string): void {
  db.prepare(
    "INSERT INTO parliamentaryconstituency (id, name, slug, country, mp_parl_id, centroid) VALUES (?, ?, ?, 'England', ?, '52.0,-0.4')",
  ).run(id, slug.replace(/-/g, " "), slug, 5000 + id);
}

// THE FIXTURE IS THE TEST. Each food bank turns exactly one branch on or off
// relative to its neighbour, so the expected body below reads as a truth
// table rather than as a blob:
//
//   id 1 salisbury  everything on: 4 locations, 12 donation points, both
//                   feed urls, a charity, days_between_needs 3 -> daily
//   id 3 bath       everything off: no locations, no_donation_points NULL,
//                   no feeds, no charity, days_between_needs 30 -> monthly
//   id 4 truro      no_donation_points = 0 -- the OTHER falsy value, which
//                   must behave exactly like NULL; news_url only (no rss);
//                   days_between_needs 91 -> yearly
//   id 5 wells      rss_url only (no news); days_between_needs 7 -> weekly
//   id 2 closed     is_closed = 1: absent entirely, and seeded in the MIDDLE
//                   of the id range so its removal is visible in the order
//
// Ids are deliberately not in slug order, so "the sitemap's order is the
// query's order" cannot be satisfied by an accidental sort.
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    daysBetweenNeeds: 3,
    noLocations: 4,
    noDonationPoints: 12,
    rssUrl: "https://salisbury.invalid/feed/",
    newsUrl: "https://salisbury.invalid/news/",
    charityName: "Salisbury Foodbank Trust",
  });
  seedFoodbank({ id: 2, slug: "closed-town", isClosed: 1, noLocations: 9, noDonationPoints: 9, charityName: "Gone" });
  seedFoodbank({ id: 3, slug: "bath", daysBetweenNeeds: 30, noLocations: 0, noDonationPoints: null });
  seedFoodbank({ id: 4, slug: "truro", daysBetweenNeeds: 91, noLocations: 0, noDonationPoints: 0, newsUrl: "https://truro.invalid/news/" });
  seedFoodbank({ id: 5, slug: "wells", daysBetweenNeeds: 7, noLocations: 1, noDonationPoints: null, rssUrl: "https://wells.invalid/feed/" });

  // A closed location and a closed donation point, so the two `is_closed = 0`
  // filters in the projected queries are testable at all -- a fixture of only
  // open rows passes whether the WHERE clause survived the rewrite or not.
  seedLocation(11, 1, "amesbury");
  seedLocation(12, 1, "wilton", 1);
  seedLocation(13, 5, "glastonbury");
  seedDonationPoint(21, 1, "tesco-extra");
  seedDonationPoint(22, 1, "boarded-up", 1);
  seedDonationPoint(23, 3, "waitrose-bath");

  seedConstituency(31, "salisbury");
  seedConstituency(32, "bath-and-north-east-somerset");
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed();
  prepared = [];
  kv = new Map();
});

afterEach(() => {
  db.close();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);

// The body the fixture above must produce, in full. Written out rather than
// generated, because a generated expectation would reproduce whatever bug the
// handler has.
const EXPECTED_EN = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${ORIGIN}/</loc></url>
<url><loc>${ORIGIN}/about-us/</loc></url>
<url><loc>${ORIGIN}/donate/</loc></url>
<url><loc>${ORIGIN}/annual-reports/</loc></url>
<url><loc>${ORIGIN}/privacy/</loc></url>
<url><loc>${ORIGIN}/scotland/</loc></url>
<url><loc>${ORIGIN}/england/</loc></url>
<url><loc>${ORIGIN}/wales/</loc></url>
<url><loc>${ORIGIN}/northern-ireland/</loc></url>
<url><loc>${ORIGIN}/needs/at/salisbury/</loc><changefreq>daily</changefreq></url>
<url><loc>${ORIGIN}/needs/at/salisbury/nearby/</loc></url>
<url><loc>${ORIGIN}/needs/at/salisbury/locations/</loc></url>
<url><loc>${ORIGIN}/needs/at/salisbury/donationpoints/</loc></url>
<url><loc>${ORIGIN}/needs/at/salisbury/news/</loc></url>
<url><loc>${ORIGIN}/needs/at/salisbury/charity/</loc></url>
<url><loc>${ORIGIN}/needs/at/bath/</loc><changefreq>monthly</changefreq></url>
<url><loc>${ORIGIN}/needs/at/bath/nearby/</loc></url>
<url><loc>${ORIGIN}/needs/at/truro/</loc><changefreq>yearly</changefreq></url>
<url><loc>${ORIGIN}/needs/at/truro/nearby/</loc></url>
<url><loc>${ORIGIN}/needs/at/truro/news/</loc></url>
<url><loc>${ORIGIN}/needs/at/wells/</loc><changefreq>weekly</changefreq></url>
<url><loc>${ORIGIN}/needs/at/wells/nearby/</loc></url>
<url><loc>${ORIGIN}/needs/at/wells/locations/</loc></url>
<url><loc>${ORIGIN}/needs/at/wells/news/</loc></url>
<url><loc>${ORIGIN}/needs/at/salisbury/amesbury/</loc></url>
<url><loc>${ORIGIN}/needs/at/wells/glastonbury/</loc></url>
<url><loc>${ORIGIN}/needs/at/salisbury/donationpoint/tesco-extra/</loc></url>
<url><loc>${ORIGIN}/needs/at/bath/donationpoint/waitrose-bath/</loc></url>
<url><loc>${ORIGIN}/needs/in/constituency/bath-and-north-east-somerset/</loc></url>
<url><loc>${ORIGIN}/needs/in/constituency/salisbury/</loc></url>
</urlset>
`;

describe("sitemapXml -- /sitemap.xml", () => {
  // THE WHOLE-BODY ASSERTION. Every branch the projected food-bank query
  // feeds is visible in this one string, and so is the row order of all four
  // queries. This is the test that says the projection changed no output.
  it("emits every url the fixture implies, and no others, in query order", async () => {
    const res = await get("/sitemap.xml");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/xml");
    expect(await res.text()).toBe(EXPECTED_EN);
  });

  // The four <changefreq> bands, called out separately from the body above so
  // a failure names the rule rather than handing over a 30-line diff.
  // days_between_needs is one of the seven projected columns and the ONLY
  // thing that produces this element; drop it from the SELECT and every food
  // bank silently becomes "yearly" (changefreq(undefined) falls through every
  // comparison), which is not a diff anyone would spot in passing.
  it("derives changefreq from days_between_needs, all four bands", async () => {
    const body = await (await get("/sitemap.xml")).text();

    expect(body).toContain(`<loc>${ORIGIN}/needs/at/salisbury/</loc><changefreq>daily</changefreq>`);
    expect(body).toContain(`<loc>${ORIGIN}/needs/at/wells/</loc><changefreq>weekly</changefreq>`);
    expect(body).toContain(`<loc>${ORIGIN}/needs/at/bath/</loc><changefreq>monthly</changefreq>`);
    expect(body).toContain(`<loc>${ORIGIN}/needs/at/truro/</loc><changefreq>yearly</changefreq>`);
  });

  // no_donation_points is NULLABLE in production where no_locations is not,
  // and the handler branches on `Boolean(...)` precisely so NULL and 0 behave
  // alike. Both falsy spellings are seeded (bath = NULL, truro = 0) and both
  // must omit the url; salisbury's 12 must emit it.
  it("treats a NULL no_donation_points exactly like 0", async () => {
    const body = await (await get("/sitemap.xml")).text();

    expect(body).toContain(`${ORIGIN}/needs/at/salisbury/donationpoints/`);
    expect(body).not.toContain(`${ORIGIN}/needs/at/bath/donationpoints/`);
    expect(body).not.toContain(`${ORIGIN}/needs/at/truro/donationpoints/`);
  });

  // rss_url OR news_url, either alone. Two separate columns feeding one
  // branch is the shape a projection loses half of without anything failing:
  // drop rss_url and wells' news page vanishes while truro's stays.
  it("emits the news url for a food bank with only rss_url, and for one with only news_url", async () => {
    const body = await (await get("/sitemap.xml")).text();

    expect(body).toContain(`${ORIGIN}/needs/at/wells/news/`);
    expect(body).toContain(`${ORIGIN}/needs/at/truro/news/`);
    expect(body).not.toContain(`${ORIGIN}/needs/at/bath/news/`);
  });

  it("emits the charity url only for a food bank with a charity_name", async () => {
    const body = await (await get("/sitemap.xml")).text();

    expect(body).toContain(`${ORIGIN}/needs/at/salisbury/charity/`);
    expect(body).not.toContain(`${ORIGIN}/needs/at/bath/charity/`);
  });

  // All three `is_closed = 0` filters at once. The closed rows are seeded in
  // the middle of each id range, so a lost filter shows up as three extra
  // urls in the whole-body test above AND here.
  it("omits the closed food bank, location and donation point", async () => {
    const body = await (await get("/sitemap.xml")).text();

    expect(body).not.toContain("closed-town");
    expect(body).not.toContain("wilton");
    expect(body).not.toContain("boarded-up");
  });

  // Locale prefixing: Django resolves {% url %} in the active language, and
  // this route is registered under all four. Only the <loc> paths move; the
  // set of urls and their order do not.
  it("prefixes every url with the locale it was requested under", async () => {
    // Same urls, same order, only the prefix moves. /privacy/ is the one
    // exception, and a pre-existing one: it is the confirmed i18n_patterns
    // hold-out (packages/urls/src/routes.ts:150 and its routes.test.ts:659
    // note), so urlForLocale leaves it unprefixed in every language. Pinned
    // here as current behaviour, not endorsed.
    const expectedCy = EXPECTED_EN.split("\n")
      .map((line) => (line.includes("/privacy/") ? line : line.replace(`${ORIGIN}/`, `${ORIGIN}/cy/`)))
      .join("\n");

    expect(await (await get("/cy/sitemap.xml")).text()).toBe(expectedCy);
  });

  // THE PROJECTION ITSELF. Everything above is equally true of the four
  // `SELECT *` queries this replaced, so without this test a revert would be
  // invisible. Asserted on the statements that actually reached the engine.
  it("issues four column-projected queries and no SELECT * over foodbank rows", async () => {
    await get("/sitemap.xml");

    const queries = prepared.filter((sql) => /FROM (foodbank|foodbanklocation|foodbankdonationpoint|parliamentary)/.test(sql));
    expect(queries).toEqual([
      "SELECT slug, days_between_needs, no_locations, no_donation_points, rss_url, news_url, charity_name FROM foodbank WHERE is_closed = 0",
      "SELECT foodbank_slug, slug FROM foodbanklocation_full WHERE is_closed = 0",
      "SELECT foodbank_slug, slug FROM foodbankdonationpoint_full WHERE is_closed = 0",
      "SELECT slug FROM parliamentaryconstituency",
    ]);
    expect(queries.some((sql) => sql.includes("SELECT *"))).toBe(false);
  });
});
