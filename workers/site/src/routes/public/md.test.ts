import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/public/md.ts's two sitemap handlers -- /md/sitemap.xml
// (Django's `md_sitemap()`, givefood/views.py:736-774) and /md/sitemap.md
// (`md_sitemap_md()`, :777-815). mdIndex, the third handler in that file, is
// untouched by this work and is not covered here.
//
// WHY THIS FILE EXISTS. Both handlers used to fetch every column of every
// open food bank and donation point to read one and two short strings off
// each -- 14.2 MB of D1 result payload per render (measured on production;
// see packages/db's own comments for the per-query figures). Narrowing the
// queries is invisible when it works and equally invisible when it does not:
// lose `name` from the donation-point projection and /md/sitemap.md renders
// 5,700 EMPTY link labels, still with a 200 and still with the right number
// of lines.
//
// So both tests assert the WHOLE BODY. For the .md one that also pins the
// four `{% for %}` sections' order and the template's own quirk -- food
// banks, locations and donation points are linked with a BARE path while
// constituencies get the absolute `{{ domain }}{{ url(...) }}` -- which is
// verbatim from the Django template and is not something this work changed.
//
// REAL EVERYTHING (real app, real router, real Nunjucks, real migrations),
// same harness as routes/public/sitemaps.test.ts and routes/admin/map.test.ts.
// These routes live OUTSIDE i18n_patterns (givefood/urls.py's "Markdown
// versions" block), so unlike /sitemap.xml there is no locale variant to test.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

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
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds -- deliberately smaller than sitemaps.test.ts's, because these two
// handlers have no per-food-bank branching at all: every open food bank gets
// exactly one entry. What matters here is the NAMES (the link text on the .md
// page, and the only reason the ...WithNames variants exist), the three
// `is_closed = 0` filters, and the row ORDER.
// ---------------------------------------------------------------------------

function seedFoodbank(id: number, slug: string, name: string, isClosed: 0 | 1 = 0): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng,
       network, charity_just_foodbank, contact_email, url, shopping_list_url,
       address_is_administrative, is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79',
       'Trussell Trust', 0, ?, ?, ?, 0, ?, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(id, String(id).padStart(32, "a"), name, slug, `info@${slug}.invalid`, `https://${slug}.invalid/`, `https://${slug}.invalid/list/`, isClosed);
}

function seedLocation(id: number, foodbankId: number, slug: string, name: string, isClosed: 0 | 1 = 0): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, modified)
     VALUES (?, ?, ?, ?, ?, '2 Low Street', 'SP2 2BB', 'England', '51.08,-1.80', 51.08, -1.80, ?,
       '2020-01-01 00:00:00.000000')`,
  ).run(id, String(id).padStart(32, "e"), foodbankId, name, slug, isClosed);
}

function seedDonationPoint(id: number, foodbankId: number, slug: string, name: string, isClosed: 0 | 1 = 0): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, in_store_only, modified)
     VALUES (?, ?, ?, ?, ?, '3 Retail Park', 'SP3 3CC', 'England', '51.06,-1.78', 51.06, -1.78, ?, 0,
       '2020-01-01 00:00:00.000000')`,
  ).run(id, String(id).padStart(32, "d"), foodbankId, name, slug, isClosed);
}

function seedConstituency(id: number, slug: string, name: string): void {
  db.prepare(
    "INSERT INTO parliamentaryconstituency (id, name, slug, country, mp_parl_id, centroid) VALUES (?, ?, ?, 'England', ?, '52.0,-0.4')",
  ).run(id, name, slug, 5000 + id);
}

// Ids ascend while names descend, so rowid order and name order are two
// different sequences: an ORDER BY quietly added to any of the six projected
// queries reorders the page, and the whole-body assertions below catch it.
// The closed rows sit in the middle of each id range so a lost `is_closed = 0`
// is visible as an inserted line rather than an appended one.
//
// The apostrophe in "St John's Hall" is deliberate: it is the character a
// Nunjucks autoescape regression turns into &#39; in a plain-text/markdown
// response, which is what the template's `{% autoescape false %}` exists to
// prevent -- and a projection that stopped fetching `name` at all would hide
// that half of the contract behind an empty string.
function seed(): void {
  seedFoodbank(1, "salisbury", "Salisbury Foodbank");
  seedFoodbank(2, "closed-town", "Closed Town Foodbank", 1);
  seedFoodbank(3, "bath", "Bath Foodbank");

  seedLocation(11, 1, "amesbury", "Amesbury Centre");
  seedLocation(12, 1, "wilton", "Wilton Centre", 1);
  seedLocation(13, 3, "st-johns", "St John's Hall");

  seedDonationPoint(21, 1, "tesco-extra", "Tesco Extra");
  seedDonationPoint(22, 1, "boarded-up", "Boarded Up Wilko", 1);
  seedDonationPoint(23, 3, "waitrose-bath", "Waitrose Bath");

  seedConstituency(31, "salisbury", "Salisbury");
  seedConstituency(32, "bath-and-north-east-somerset", "Bath and North East Somerset");
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

const dataQueries = (): string[] =>
  prepared.filter((sql) => /FROM (foodbank|foodbanklocation|foodbankdonationpoint|parliamentary)/.test(sql));

describe("mdSitemapXml -- /md/sitemap.xml", () => {
  it("emits every url the fixture implies, and no others, in query order", async () => {
    const res = await get("/md/sitemap.xml");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml");
    expect(await res.text()).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
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
  <url><loc>${ORIGIN}/md/needs/at/salisbury/</loc></url>
  <url><loc>${ORIGIN}/md/needs/at/bath/</loc></url>
  <url><loc>${ORIGIN}/md/needs/at/salisbury/amesbury/</loc></url>
  <url><loc>${ORIGIN}/md/needs/at/bath/st-johns/</loc></url>
  <url><loc>${ORIGIN}/md/needs/at/salisbury/donationpoint/tesco-extra/</loc></url>
  <url><loc>${ORIGIN}/md/needs/at/bath/donationpoint/waitrose-bath/</loc></url>
  <url><loc>${ORIGIN}/needs/in/constituency/bath-and-north-east-somerset/</loc></url>
  <url><loc>${ORIGIN}/needs/in/constituency/salisbury/</loc></url>
</urlset>
`,
    );
  });

  // The three `is_closed = 0` filters, called out so a failure names the rule.
  it("omits the closed food bank, location and donation point", async () => {
    const body = await (await get("/md/sitemap.xml")).text();

    expect(body).not.toContain("closed-town");
    expect(body).not.toContain("wilton");
    expect(body).not.toContain("boarded-up");
  });

  // THE PROJECTION. Everything above is equally true of the `SELECT *`
  // queries these replaced, so a revert would be invisible without this.
  // The food-bank query is slug-only here (this handler reads nothing else),
  // which is narrower than Django's own `.only('slug', 'name')` at
  // views.py:752 -- the same choice locations.ts already makes between
  // getAllOpenLocationSlugs and ...WithNames for this pair of views.
  it("issues four column-projected queries, none of them SELECT *", async () => {
    await get("/md/sitemap.xml");

    expect(dataQueries()).toEqual([
      "SELECT slug FROM foodbank WHERE is_closed = 0",
      "SELECT foodbank_slug, slug FROM foodbanklocation_full WHERE is_closed = 0",
      "SELECT foodbank_slug, slug FROM foodbankdonationpoint_full WHERE is_closed = 0",
      "SELECT slug FROM parliamentaryconstituency",
    ]);
  });
});

describe("mdSitemapMd -- /md/sitemap.md", () => {
  // THE WHOLE BODY, including every link LABEL. The labels are the entire
  // reason the three ...WithNames variants exist: drop `name` from any of
  // them and this page still returns 200 with the right number of lines and
  // every label empty.
  //
  // Note the constituencies come out in a DIFFERENT order here than in
  // /md/sitemap.xml above, and neither of those two queries was touched by
  // this work. `SELECT slug` is answered from a covering index and
  // `SELECT slug, name` is a table scan -- confirmed on production D1, whose
  // EXPLAIN QUERY PLAN gives "SCAN parliamentaryconstituency USING COVERING
  // INDEX parlcon_slug_idx" for the first and a bare "SCAN
  // parliamentaryconstituency" for the second -- so the two arrive in index
  // order and rowid order respectively. That is a live demonstration of why
  // a projection can move row order at all, and why every new narrow query
  // in this change is pinned against the wide one it replaced rather than
  // assumed equivalent. It is also why each body here is asserted in full
  // rather than one being derived from the other.
  it("renders every section with its link text, in query order", async () => {
    const res = await get("/md/sitemap.md");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe(
      `# Sitemap

## Pages

- [index](${ORIGIN}/)
- [about_us](${ORIGIN}/about-us/)
- [donate](${ORIGIN}/donate/)
- [annual_report_index](${ORIGIN}/annual-reports/)
- [privacy](${ORIGIN}/privacy/)


## Countries

- [scotland](${ORIGIN}/scotland/)
- [england](${ORIGIN}/england/)
- [wales](${ORIGIN}/wales/)
- [northern-ireland](${ORIGIN}/northern-ireland/)


## Food Banks

- [Salisbury Foodbank](/md/needs/at/salisbury/)
- [Bath Foodbank](/md/needs/at/bath/)


## Locations

- [Amesbury Centre](/md/needs/at/salisbury/amesbury/)
- [St John's Hall](/md/needs/at/bath/st-johns/)


## Donation Points

- [Tesco Extra](/md/needs/at/salisbury/donationpoint/tesco-extra/)
- [Waitrose Bath](/md/needs/at/bath/donationpoint/waitrose-bath/)


## Constituencies

- [Salisbury](${ORIGIN}/needs/in/constituency/salisbury/)
- [Bath and North East Somerset](${ORIGIN}/needs/in/constituency/bath-and-north-east-somerset/)


`,
    );
  });

  // `{% autoescape false %}` on the template, pinned. This is a markdown
  // response, not HTML: an apostrophe escaped to &#39; would render literally
  // in every markdown reader, and the food-bank/location names on the real
  // page are full of them.
  it("leaves an apostrophe in a name literal rather than escaping it", async () => {
    const body = await (await get("/md/sitemap.md")).text();

    expect(body).toContain("[St John's Hall]");
    expect(body).not.toContain("&#39;");
  });

  it("omits the closed food bank, location and donation point", async () => {
    const body = await (await get("/md/sitemap.md")).text();

    expect(body).not.toContain("Closed Town");
    expect(body).not.toContain("Wilton");
    expect(body).not.toContain("Boarded Up");
  });

  it("issues four column-projected queries, none of them SELECT *", async () => {
    await get("/md/sitemap.md");

    expect(dataQueries()).toEqual([
      "SELECT slug, name FROM foodbank WHERE is_closed = 0",
      "SELECT foodbank_slug, slug, name FROM foodbanklocation_full WHERE is_closed = 0",
      "SELECT foodbank_slug, slug, name FROM foodbankdonationpoint_full WHERE is_closed = 0",
      "SELECT slug, name FROM parliamentaryconstituency",
    ]);
  });
});
