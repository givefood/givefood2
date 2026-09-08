import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../../index";
import type { AppEnv } from "../../../types";

// routes/wfbn/md/donationpoints.ts -- the two markdown handlers a food bank's
// donation points are served by:
//
//   mdFoodbankDonationpoints  GET /md/needs/at/<slug>/donationpoints/
//   mdFoodbankDonationpoint   GET /md/needs/at/<slug>/donationpoint/<dpslug>/
//
// Ported from gfwfbn/views.py's `md_foodbank_donationpoints` (737-751) and
// `md_foodbank_donationpoint` (754-775), both read in full alongside this
// file, together with the two templates they render
// (gfwfbn/templates/wfbn/foodbank/md/donationpoints.md and donationpoint.md)
// and gfwfbn/urls/md.py, which registers the pair OUTSIDE i18n_patterns.
//
// WHY THIS FILE EXISTS. /md/ is the machine-readable mirror, and it is what
// this site hands to language models: /llms.txt links /md/sitemap.md
// (routes/public/textFiles.ts:61), which links every donation point page
// below. Its readers are therefore the ones least able to notice that a page
// is wrong. There is no layout to look
// broken, no map pin in the Atlantic -- a lost row, an extra row or a
// mis-scoped lookup is just a plain-text list that reads perfectly and says
// the wrong thing. Four ways of getting that wrong are each pinned below:
//
//   * THE GATE AND THE LIST READ DIFFERENT THINGS. Whether the page exists
//     at all is decided by `foodbank.no_donation_points`, a stored COUNTER;
//     what it lists comes from a query over the table. The fixture makes the
//     two DISAGREE in both directions -- a food bank whose counter is 0 while
//     it really has a donation point (404, row hidden), and one whose counter
//     is 2 while it has none (200, empty list) -- so neither can be mistaken
//     for the other.
//
//   * THE COUNTER IS NULLABLE, and the module's own comment says so.
//     `no_donation_points` is `INTEGER` with no NOT NULL (0001_core.sql)
//     unlike its `no_locations` sibling, so Django's literal
//     `if foodbank.no_donation_points == 0:` renders a page for a NULL, and
//     the port's `if (!...)` 404s instead. Both halves are asserted, because
//     the "faithful" strict-equality port is exactly the tidy-up this guard
//     invites -- and the same bug class was already fixed twice (../updates.ts,
//     ../../public/sitemaps.ts).
//
//   * THE PAIR IS THE IDENTITY on the detail leg. A donation point is
//     addressed by (food bank slug, donation point slug); there is no unique
//     index on the child slug alone (dp_foodbank_slug_idx is the composite).
//     Two food banks here own a donation point called "tesco-extra", asserted
//     from both sides, so a lookup that dropped its foodbank_slug bind cannot
//     pass.
//
//   * THE NEED TEXT HAS THREE SENTINELS AND ONE NON-SENTINEL EMPTY STATE.
//     "Unknown"/"Nothing"/"Facebook" each get a food bank of their own (one
//     is not enough: the check is a chain of three !== and a dropped link is
//     invisible unless that sentinel has a donation point to render), and the
//     "" a food bank with no need record resolves to is pinned separately
//     because it is a real divergence from Django rather than a port of one.
//
// REAL EVERYTHING, the same harness as ../locationDetail.test.ts and
// ../../public/md.test.ts: the REAL production app (index.ts's default
// export), so the route order that makes /md/needs/at/x/donationpoints/ a
// list page rather than a location called "donationpoints" is the genuine
// one, and so are cacheTag, slugRedirect, resolveLanguage and
// pageCacheControl; the REAL Nunjucks templates; and real in-memory SQLite
// built by schemaFor() from the real migrations -- which matters because both
// donation-point queries read foodbankdonationpoint_full, the VIEW that
// supplies foodbank_slug by join since 0019_drop_foodbank_cache.sql. Mocked:
// only the two KV namespaces, which have no local double and which neither
// handler touches.
//
// Bodies are asserted WHOLE where the page is short enough to be worth it,
// following ../../public/md.test.ts's reasoning: this is markdown, every
// blank line is content, and "contains the name" passes for a page that has
// lost its address block, its ordering or its links.
//
// MUTATION-TESTED (TESTING.md's convention). The repo was copied to a
// scratchpad OUTSIDE it -- never edited in place -- and 27 mutations were
// applied one at a time, with this file re-run against each: 15 to this
// module, 4 to packages/db's donationpoints.ts, and 8 to index.ts's route
// order, middleware/cacheTag.ts, middleware/pageCacheControl.ts and the two
// .njk templates (those rebuilt through the real precompile step, since the
// renderer reads the generated bundle rather than the .njk file).
//
// ONE SURVIVED THE FIRST VERSION OF THIS FILE and is why the fixture looks
// the way it does: deleting sortByName from getDonationPointsByFoodbankId
// changed nothing. The query is answered from dp_foodbank_slug_idx, so rows
// arrive in SLUG order -- and with a fixture whose slugs are all what their
// names would slugify to, slug order IS the collated order. Adding one
// renamed store (name "Asda Superstore", slug still "wilko-market-place")
// separated the two and killed it. Three others needed a fixture rather than
// an assertion: the counter guard relaxed to Django's literal `== 0` (only
// fb-town, whose counter is NULL, notices), the sentinel check moved from
// the raw need text to the stripped one (only padded-unknown notices), and
// the excess block un-nested from has_need (only closed-town, which has both
// a sentinel need and an excess list, notices).

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: which SESSION opened it, the SQL,
// and the values bound to it. The session id is what proves lib/session.ts's
// one-session-per-request contract -- two sessions against a replicated
// database can see two different snapshots, and the page would still render.
// The bindings are what prove the food bank reaches the child lookup at all.
interface Prepared {
  session: number;
  sql: string;
  params: Bindable[];
}

let db: DatabaseSync;
let prepared: Prepared[];
let sessions: number;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite --
// ../locationDetail.test.ts's shim verbatim, including batch(), which
// getFoodbankBySlug needs (it sends the food bank row and its latest need as
// one round trip). Deliberately dumb otherwise: it never inspects or rewrites
// SQL, it hands every statement to real SQLite.
function d1Session(): D1DatabaseSession {
  sessions += 1;
  const id = sessions;
  const statement = (sql: string, params: Bindable[], entry: Prepared) => ({
    sql,
    params,
    bind: (...next: unknown[]) => {
      entry.params = next as Bindable[];
      return statement(sql, next as Bindable[], entry);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { session: id, sql, params: [] };
      prepared.push(entry);
      return statement(sql, [], entry);
    },
    batch: async (statements: Array<{ sql: string; params: Bindable[] }>) =>
      statements.map((s) => ({ results: db.prepare(s.sql).all(...s.params), success: true, meta: {} })),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session() },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns these handlers and their templates read are
// parameterised; every other NOT NULL column is filled with whatever the real
// migration insists on, so a seeded row is one production would have accepted.
// ---------------------------------------------------------------------------

interface FoodbankSeed {
  id: number;
  slug: string;
  name: string;
  altName?: string | null;
  country?: string;
  address?: string;
  postcode?: string;
  addressIsAdministrative?: 0 | 1;
  deliveryAddress?: string | null;
  noDonationPoints?: number | null;
  noLocations?: number;
  isClosed?: 0 | 1;
  latestNeedId?: number | null;
}

// `name` is stored BARE ("Salisbury"): fullNameFoodbank() is what appends
// " Foodbank", and a fixture already carrying the suffix would hide that
// helper behind "Salisbury Foodbank Foodbank".
//
// `delivery_address` defaults to "" rather than NULL because that is what
// production holds for a food bank with no delivery address -- foodbank.ts's
// getFoodbanksWithDeliveryAddress filters on `!= ''`, not on NULL.
function seedFoodbank(s: FoodbankSeed): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, alt_name, slug, address, postcode, country, lat_lng,
       latitude, longitude, delivery_address, delivery_lat_lng, network, charity_just_foodbank,
       contact_email, url, shopping_list_url, address_is_administrative, is_closed, no_locations,
       no_donation_points, days_between_needs, latest_need_id, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '51.07,-1.79',
       51.07, -1.79, ?, '51.5,-1.5', 'Trussell', 0,
       ?, ?, ?, ?, ?, ?,
       ?, 14, ?, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "a"),
    s.name,
    s.altName ?? null,
    s.slug,
    s.address ?? "1 High Street",
    s.postcode ?? "SP1 1AA",
    s.country ?? "England",
    s.deliveryAddress === undefined ? "" : s.deliveryAddress,
    `info@${s.slug}.invalid`,
    `https://${s.slug}.invalid/`,
    `https://${s.slug}.invalid/list/`,
    s.addressIsAdministrative ?? 0,
    s.isClosed ?? 0,
    s.noLocations ?? 1,
    s.noDonationPoints === undefined ? 1 : s.noDonationPoints,
    s.latestNeedId ?? null,
  );
}

// `created`/`modified` are TEXT compared lexicographically, so every fixture
// timestamp is written in Django's own spelling -- "2026-09-05 19:28:08.853000",
// a space and six digits of microseconds, never toISOString()'s.
function seedNeed(o: { id: number; foodbankId: number; changeText: string; excess?: string | null }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published,
       input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 1, 'scrape', '2026-09-05 19:28:08.853000', '2026-09-05 19:28:08.853000')`,
  ).run(o.id, String(o.id).padStart(32, "c"), o.foodbankId, o.changeText, o.excess ?? null);
}

interface DonationPointSeed {
  id: number;
  foodbankId: number;
  name: string;
  slug: string;
  address?: string;
  postcode?: string;
  country?: string | null;
  url?: string | null;
  phone?: string | null;
  openingHours?: string | null;
  notes?: string | null;
  isClosed?: 0 | 1;
}

function seedDonationPoint(s: DonationPointSeed): void {
  db.prepare(
    `INSERT INTO foodbankdonationpoint (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, in_store_only, phone_number, url, opening_hours, notes,
       modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '51.38,-2.35', 51.38, -2.35, ?, 0, ?, ?, ?, ?,
       '2020-01-01 00:00:00.000000')`,
  ).run(
    s.id,
    String(s.id).padStart(32, "d"),
    s.foodbankId,
    s.name,
    s.slug,
    s.address ?? "5 Retail Park",
    s.postcode ?? "SP4 4DD",
    s.country === undefined ? "England" : s.country,
    s.isClosed ?? 0,
    s.phone ?? null,
    s.url ?? null,
    s.openingHours ?? null,
    s.notes ?? null,
  );
}

// Locations exist here only for the route-order trap: /md/needs/at/:slug/:locslug/
// is a catch-all registered AFTER this pair, and a location can be called
// "donationpoints".
function seedLocation(o: { id: number; foodbankId: number; name: string; slug: string }): void {
  db.prepare(
    `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
       lat_lng, latitude, longitude, is_closed, modified)
     VALUES (?, ?, ?, ?, ?, '2 Low Street', 'SP2 2BB', 'England', '51.08,-1.80', 51.08, -1.80, 0,
       '2020-01-01 00:00:00.000000')`,
  ).run(o.id, String(o.id).padStart(32, "e"), o.foodbankId, o.name, o.slug);
}

const HOURS = "Monday: 9:00 AM - 5:00 PM\nTuesday: Closed";

// THE FIXTURE IS THE TEST, so each row turns exactly one rule on or off
// relative to its neighbour.
//
// Food banks:
//   1 salisbury       counter 3, own address printed, delivery address set,
//                     a real need list with a blank line inside it
//   2 cardiff         alt_name set (which this English-only surface must
//                     IGNORE), address_is_administrative = 1, delivery ""
//                     -> neither address block; NO latest need at all
//   3 closed-town     counter 0 WHILE OWNING A DONATION POINT; need "Unknown"
//                     with an excess list (the excess block is nested inside
//                     has_need and must vanish with it)
//   4 fb-town         counter NULL -- the nullable column the module's comment
//                     is about; need "Facebook"
//   5 nothing-town    need "Nothing"
//   6 salvation-army  a DONT_APPEND_FOOD_BANK name (no " Foodbank" suffix),
//                     delivery_address NULL rather than "", and a need whose
//                     text uses CRLF line endings
//   7 phantom-points  counter 2 with NO donation point rows at all
//   8 blank-excess    excess_change_text is WHITESPACE ONLY
//   9 padded-unknown  change_text is "\nUnknown\n" -- a sentinel that is only
//                     a sentinel after stripping, which the code does NOT do
//
// Donation points (slug "tesco-extra" deliberately collides across parents):
//   20 salisbury/wilko-market-place  a renamed store: its NAME is "Asda
//                              Superstore" and its slug still says Wilko, so
//                              name order and slug order disagree (see the
//                              ordering test)
//   21 salisbury/tesco-extra   url, phone, opening hours, notes, apostrophe
//   22 salisbury/aldi-express  country NULL, no url/phone/hours/notes
//   23 salisbury/zebra-stores  is_closed = 1 -- must still be listed
//   24 cardiff/tesco-extra     SAME slug, different parent
//   25 closed-town/corner-shop the row its parent's counter hides
//   26 fb-town/fb-store        }
//   27 nothing-town/no-need-shop } one per sentinel
//   28 salvation-army/army-store
//   29 blank-excess/spar-store
//   30 padded-unknown/padded-store
function seed(): void {
  seedFoodbank({
    id: 1,
    slug: "salisbury",
    name: "Salisbury",
    noDonationPoints: 4,
    noLocations: 2,
    deliveryAddress: "9 Depot Way",
    latestNeedId: 1,
  });
  seedFoodbank({
    id: 2,
    slug: "cardiff",
    name: "Cardiff",
    altName: "Banc Bwyd Caerdydd",
    country: "Wales",
    address: "2 Ffordd Fawr",
    postcode: "CF10 1AA",
    addressIsAdministrative: 1,
    latestNeedId: null,
  });
  seedFoodbank({ id: 3, slug: "closed-town", name: "Closed Town", noDonationPoints: 0, isClosed: 1, latestNeedId: 3 });
  seedFoodbank({ id: 4, slug: "fb-town", name: "FB Town", noDonationPoints: null, latestNeedId: 4 });
  seedFoodbank({ id: 5, slug: "nothing-town", name: "Nothing Town", latestNeedId: 5 });
  seedFoodbank({ id: 6, slug: "salvation-army", name: "Salvation Army", deliveryAddress: null, latestNeedId: 6 });
  seedFoodbank({ id: 7, slug: "phantom-points", name: "Phantom Points", noDonationPoints: 2, latestNeedId: null });
  seedFoodbank({ id: 8, slug: "blank-excess", name: "Blank Excess", latestNeedId: 8 });
  seedFoodbank({ id: 9, slug: "padded-unknown", name: "Padded Unknown", latestNeedId: 9 });

  // The blank line inside change_text is load-bearing: get_change_text()'s
  // nonEmptyLines strips it, and a handler that passed the raw column through
  // would print an empty bullet nobody would ever look at twice.
  seedNeed({ id: 1, foodbankId: 1, changeText: "Tinned Meat\n\nPasta\nRice", excess: "Baked Beans\n\nSoup" });
  seedNeed({ id: 3, foodbankId: 3, changeText: "Unknown", excess: "Rice" });
  seedNeed({ id: 4, foodbankId: 4, changeText: "Facebook" });
  seedNeed({ id: 5, foodbankId: 5, changeText: "Nothing" });
  seedNeed({ id: 6, foodbankId: 6, changeText: "Custard\r\n\r\nFlour", excess: "Beans\r\nSoup" });
  seedNeed({ id: 8, foodbankId: 8, changeText: "Tea", excess: "   " });
  seedNeed({ id: 9, foodbankId: 9, changeText: "\nUnknown\n" });

  // A store that was renamed in the admin and kept its URL -- the one shape
  // that makes slug order and name order disagree. Everything else in this
  // table has the slug its name would slugify to, and with such a fixture the
  // sort under test is indistinguishable from no sort at all: the query is
  // answered from dp_foodbank_slug_idx, which returns rows in SLUG order.
  seedDonationPoint({
    id: 20,
    foodbankId: 1,
    name: "Asda Superstore",
    slug: "wilko-market-place",
    address: "9 Market Place",
    postcode: "SP7 7GG",
  });
  seedDonationPoint({
    id: 21,
    foodbankId: 1,
    name: "Tesco Extra",
    slug: "tesco-extra",
    url: "https://tesco.invalid/store/1?utm_source=newsletter",
    phone: "01722 999888",
    openingHours: HOURS,
    notes: "Ask at St John's kiosk",
  });
  seedDonationPoint({
    id: 22,
    foodbankId: 1,
    name: "aldi Express",
    slug: "aldi-express",
    address: "7 St Mary's Way",
    postcode: "SP5 5EE",
    country: null,
  });
  seedDonationPoint({
    id: 23,
    foodbankId: 1,
    name: "Zebra Stores",
    slug: "zebra-stores",
    address: "8 Zoo Road",
    postcode: "SP6 6FF",
    isClosed: 1,
  });
  seedDonationPoint({
    id: 24,
    foodbankId: 2,
    name: "Cardiff Co-op",
    slug: "tesco-extra",
    country: "Wales",
    address: "3 Heol Y Bont",
    postcode: "CF11 2BB",
  });
  seedDonationPoint({ id: 25, foodbankId: 3, name: "Corner Shop", slug: "corner-shop" });
  seedDonationPoint({ id: 26, foodbankId: 4, name: "FB Store", slug: "fb-store" });
  seedDonationPoint({ id: 27, foodbankId: 5, name: "No Need Shop", slug: "no-need-shop" });
  seedDonationPoint({ id: 28, foodbankId: 6, name: "Army Store", slug: "army-store" });
  seedDonationPoint({ id: 29, foodbankId: 8, name: "Spar Store", slug: "spar-store" });
  seedDonationPoint({ id: 30, foodbankId: 9, name: "Padded Store", slug: "padded-store" });

  // Two locations whose slug is "donationpoints", under a food bank whose list
  // page renders and one whose list page 404s -- the route-order trap, from
  // both sides. Location 33 is the control for the catch-all being live at all.
  seedLocation({ id: 31, foodbankId: 1, name: "Trap Centre", slug: "donationpoints" });
  seedLocation({ id: 32, foodbankId: 3, name: "Shadowed Centre", slug: "donationpoints" });
  seedLocation({ id: 33, foodbankId: 1, name: "Amesbury Centre", slug: "amesbury" });

  // One row that must never fire. middleware/slugRedirect.ts reads this table
  // on /needs/at/<slug>/<one more segment>/ paths -- and its pattern is
  // anchored at ^, so no /md/ URL can ever match it. Seeded so that "the md
  // mirror does not redirect" is a fact about a redirect that really exists,
  // not about an empty table.
  db.prepare(
    `INSERT INTO slugredirect (id, old_slug, new_slug, created, modified)
     VALUES (1, 'old-name', 'salisbury', '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run();
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor rather than hand-written DDL: both donation-point queries read
  // foodbankdonationpoint_full and getFoodbankBySlug reads foodbankchange_full,
  // and a hand-built fixture that lacked either would fail with "no such
  // table" somewhere else entirely.
  db.exec(
    schemaFor(
      "foodbank",
      "foodbankchange",
      "foodbankchange_full",
      "foodbanklocation",
      "foodbanklocation_full",
      "foodbankdonationpoint",
      "foodbankdonationpoint_full",
      "slugredirect",
    ),
  );
  seed();
  prepared = [];
  sessions = 0;
});

afterEach(() => {
  db.close();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const body = async (path: string): Promise<string> => (await get(path)).text();

const sqlOf = (): string[] => prepared.map((p) => p.sql);
const traffic = (): [string, Bindable[]][] => prepared.map((p) => [p.sql, p.params]);

const FOODBANK_BATCH: [string, Bindable[]][] = [
  ["SELECT * FROM foodbank WHERE slug = ?", ["salisbury"]],
  ["SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)", ["salisbury"]],
];

// ===========================================================================
// mdFoodbankDonationpoints -- GET /md/needs/at/<slug>/donationpoints/
// ===========================================================================

describe("mdFoodbankDonationpoints -- the page, whole", () => {
  // THE WHOLE BODY, because in markdown every blank line is content and the
  // interesting failures are all shaped like "a section quietly disappeared".
  // Three things are pinned at once here that nothing else would catch: the
  // "## Main" block only exists because address_is_administrative is 0, the
  // "## Delivery" block only because delivery_address is set, and the list is
  // in COLLATED order (see the ordering test below for why that is not the
  // order the rows arrive in).
  it("renders the food bank's addresses and its donation points verbatim", async () => {
    const res = await get("/md/needs/at/salisbury/donationpoints/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      `# Donation Points - Salisbury Foodbank

## Main

1 High Street
SP1 1AA

## Delivery

9 Depot Way

- [aldi Express](/md/needs/at/salisbury/donationpoint/aldi-express/) - 7 St Mary's Way, SP5 5EE
- [Asda Superstore](/md/needs/at/salisbury/donationpoint/wilko-market-place/) - 9 Market Place, SP7 7GG
- [Tesco Extra](/md/needs/at/salisbury/donationpoint/tesco-extra/) - 5 Retail Park, SP4 4DD
- [Zebra Stores](/md/needs/at/salisbury/donationpoint/zebra-stores/) - 8 Zoo Road, SP6 6FF


`,
    );
  });

  // The other side of both address gates, and the alt_name rule. Cardiff's
  // address is administrative (a council office, not a place to take food) so
  // Django's template suppresses it; its delivery_address is "", which is
  // falsy in Nunjucks as it is in Django. And `full_name` here comes from
  // fullNameFoodbank(), the ENGLISH-ONLY helper -- the /md/ mirror sits
  // outside i18n_patterns, so the Welsh alt_name must not appear even though
  // the row carries one.
  it("omits both address blocks for an administrative address with no delivery address, and ignores alt_name", async () => {
    expect(await body("/md/needs/at/cardiff/donationpoints/")).toBe(
      `# Donation Points - Cardiff Foodbank


- [Cardiff Co-op](/md/needs/at/cardiff/donationpoint/tesco-extra/) - 3 Heol Y Bont, CF11 2BB


`,
    );
  });

  // delivery_address NULL, not "": both must be falsy, and only one of them is
  // what production actually stores. "Salvation Army" also proves
  // fullNameFoodbank's DONT_APPEND_FOOD_BANK branch reaches this heading -- it
  // is one of the nine names on that list, ported verbatim from Django's
  // givefood/const/general.py:164. Neither source records WHY those nine are
  // exempt, so no reason is claimed here; what matters is that the suffix
  // reaches the page through the same helper for everyone else and must not
  // reach it for them.
  it("treats a NULL delivery address as absent, and appends no suffix to a DONT_APPEND name", async () => {
    expect(await body("/md/needs/at/salvation-army/donationpoints/")).toBe(
      `# Donation Points - Salvation Army

## Main

1 High Street
SP1 1AA

- [Army Store](/md/needs/at/salvation-army/donationpoint/army-store/) - 5 Retail Park, SP4 4DD


`,
    );
  });
});

describe("mdFoodbankDonationpoints -- whether the page exists at all", () => {
  // DJANGO'S GUARD IS `no_donation_points == 0` AND THE COLUMN IS NULLABLE.
  // fb-town's counter is NULL, so Django renders it a page and this port
  // 404s -- a deliberate divergence the module documents, and the reason the
  // guard is a truthiness check. Asserted because "tidying" it back to a
  // strict `=== 0` (which is right for no_locations next door) passes every
  // other test in this file.
  it("404s for a NULL donation-point counter, where Django's literal `== 0` would render a page", async () => {
    expect((await get("/md/needs/at/fb-town/donationpoints/")).status).toBe(404);
  });

  // The counter is the gate and it is a stored, separately-maintained number:
  // closed-town's says 0 while the table really holds Corner Shop. The page is
  // 404 and the row is invisible -- Django behaves identically, so this is
  // pinned as ported behaviour rather than reported as a defect.
  it("404s on a zero counter even though the food bank really owns a donation point", async () => {
    const res = await get("/md/needs/at/closed-town/donationpoints/");

    expect(res.status).toBe(404);
    // ...and the row it hid is genuinely there, reachable by its own URL.
    expect((await get("/md/needs/at/closed-town/donationpoint/corner-shop/")).status).toBe(200);
  });

  // ...and the counter disagreeing the OTHER way renders a page with nothing
  // on it, rather than 404ing. A guard that had been "fixed" to count the rows
  // instead would 404 here, which is the plausible wrong implementation this
  // exists to kill.
  it("serves an empty list when the counter is positive but no donation points exist", async () => {
    expect(await body("/md/needs/at/phantom-points/donationpoints/")).toBe(
      `# Donation Points - Phantom Points Foodbank

## Main

1 High Street
SP1 1AA



`,
    );
  });

  // Django's get_object_or_404 comes first, so an unknown food bank must 404
  // before the donation-point query is issued -- not 500 on a null parent, and
  // not scan a table for a slug that does not exist.
  it("404s on an unknown food bank slug, without looking any donation point up", async () => {
    const res = await get("/md/needs/at/nope/donationpoints/");

    expect(res.status).toBe(404);
    expect(sqlOf().some((sql) => sql.includes("foodbankdonationpoint"))).toBe(false);
  });

  // GET only, matching Django's md_foodbank_donationpoints(). Worth asserting
  // rather than assuming: a stray app.all would hand a POST to a handler whose
  // response pageCacheControl then stamps public for a day.
  it("does not answer a POST", async () => {
    expect((await get("/md/needs/at/salisbury/donationpoints/", { method: "POST" })).status).toBe(404);
  });

  // THE /md/ MIRROR IS OUTSIDE i18n_patterns (givefood/urls.py's "Markdown
  // versions" block), so there is no /cy/md/... URL -- index.ts registers
  // these two routes outside its LOCALES loop. The 404 costs no D1 query at
  // all, because nothing matched.
  it("has no locale-prefixed twin", async () => {
    const res = await get("/cy/md/needs/at/salisbury/donationpoints/");

    expect(res.status).toBe(404);
    expect(prepared).toEqual([]);
  });

  // THE SLUG-REDIRECT MIDDLEWARE CANNOT REACH /md/. Its pattern is
  // `^(/(cy|ga|gd))?/needs/at/...`, anchored, so a renamed food bank's
  // markdown URLs die where its HTML ones 301 -- and Django's own regex
  // (givefood/middleware.py:177, r'^(/[a-z]{2})?/needs/at/([-\w]+)(/[-\w]+)?/?$')
  // has exactly the same blind spot, so this is inherited, not introduced.
  // Pinned in both halves: no redirect, and no read of the table either.
  it("does not follow a slug redirect on the markdown mirror", async () => {
    const res = await get("/md/needs/at/old-name/donationpoints/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
    expect(sqlOf().some((sql) => sql.includes("slugredirect"))).toBe(false);
  });

  // ROUTE ORDER, which is index.ts's decision but is only observable here.
  // /md/needs/at/:slug/:locslug/ is a catch-all registered AFTER this route,
  // and location 31's slug is literally "donationpoints" -- so if the
  // catch-all came first this URL would serve a location page. Nothing else
  // in the suite would fail.
  it("wins over the location catch-all for a location whose slug is 'donationpoints'", async () => {
    const list = await body("/md/needs/at/salisbury/donationpoints/");

    expect(list.startsWith("# Donation Points - Salisbury Foodbank")).toBe(true);
    expect(list).not.toContain("Trap Centre");
    // ...and the catch-all really is live, so "the list won" is not merely
    // "the location page does not exist".
    expect(await body("/md/needs/at/salisbury/amesbury/")).toContain("# Amesbury Centre - Salisbury Foodbank");
  });

  // The same collision under a food bank whose list page 404s: Hono has
  // already chosen this handler, and a handler that answers 404 ends the
  // request rather than falling through to the next matching route. So
  // closed-town's "Shadowed Centre" is unreachable at its own URL -- ported
  // faithfully (Django's URLconf resolves the literal path first for exactly
  // the same reason), and pinned so it is a known cost rather than a surprise.
  it("shadows a same-named location completely, even when it 404s itself", async () => {
    expect((await get("/md/needs/at/closed-town/donationpoints/")).status).toBe(404);
  });
});

describe("mdFoodbankDonationpoints -- which rows, in which order", () => {
  // THE SCOPING. Both food banks own a donation point whose slug is
  // "tesco-extra"; the query filters on foodbank_id, and losing that filter
  // renders every donation point in the database under one food bank's
  // heading with a 200. Asserted from both sides so "returns everything"
  // cannot pass either.
  it("lists only its own food bank's donation points", async () => {
    const salisbury = await body("/md/needs/at/salisbury/donationpoints/");
    const cardiff = await body("/md/needs/at/cardiff/donationpoints/");

    expect(salisbury).not.toContain("Cardiff Co-op");
    expect(salisbury).not.toContain("Corner Shop");
    expect(cardiff).not.toContain("Tesco Extra");
    expect(cardiff).not.toContain("aldi Express");
  });

  // NO is_closed FILTER, deliberately. This template loops
  // `foodbank.donation_points`, and that model method
  // (givefood/models/foodbank.py:551-552) is a bare
  // `FoodbankDonationPoint.objects.filter(foodbank=self).order_by("name")`
  // -- no exclusion, unlike the site-wide feeds and sitemaps, which all carry
  // `is_closed = 0`. Zebra Stores is closed and appears; adding the "obvious"
  // WHERE is_closed = 0 to match its neighbours in packages/db would silently
  // shorten every one of these pages.
  it("includes a closed donation point", async () => {
    expect(await body("/md/needs/at/salisbury/donationpoints/")).toContain(
      "- [Zebra Stores](/md/needs/at/salisbury/donationpoint/zebra-stores/) - 8 Zoo Road, SP6 6FF",
    );
  });

  // FOUR DIFFERENT ORDERS, and only one of them is right. For these four rows:
  //
  //   inserted (rowid)          Asda, Tesco, aldi, Zebra
  //   as the QUERY returns them aldi, Tesco, Asda, Zebra   (slug order: the
  //                             plan is SEARCH d USING INDEX dp_foodbank_slug_idx,
  //                             and Asda's slug still says "wilko")
  //   SQL `ORDER BY name`       Asda, Tesco, Zebra, aldi   (SQLite's byte-wise
  //                             default collation puts every uppercase letter
  //                             before any lowercase one)
  //   sortByName (correct)      aldi, Asda, Tesco, Zebra   (Intl.Collator("en-US"),
  //                             the linguistic collation the source Postgres
  //                             sorted under)
  //
  // Every one of those is a plausible implementation and three of them are
  // wrong. This test caught the sort being dropped only AFTER the renamed
  // store was added: with slugs that all match their names, the index order
  // the query already returns is the collated order, and deleting sortByName
  // changed nothing observable.
  it("orders by name under the en-US collator, not by rowid, slug or SQLite's byte order", async () => {
    const names = [...(await body("/md/needs/at/salisbury/donationpoints/")).matchAll(/^- \[(.+?)\]/gm)].map((m) => m[1]);

    expect(names).toEqual(["aldi Express", "Asda Superstore", "Tesco Extra", "Zebra Stores"]);
  });

  // `{% autoescape false %}` on the template, pinned. This is markdown, not
  // HTML: an apostrophe escaped to &#39; renders literally in every markdown
  // reader, and real donation-point addresses are full of saints.
  it("leaves an apostrophe in an address literal rather than escaping it", async () => {
    const md = await body("/md/needs/at/salisbury/donationpoints/");

    expect(md).toContain("7 St Mary's Way");
    expect(md).not.toContain("&#39;");
  });
});

describe("mdFoodbankDonationpoints -- envelope and D1 traffic", () => {
  // ONE SESSION FOR EVERY QUERY THE HANDLER MAKES. lib/session.ts opens a
  // single withSession("first-unconstrained") per request precisely so the
  // food bank and its donation points come from one consistent snapshot of a
  // replicated database; a handler that opened one per query would render
  // identically and pass every other test in this file.
  //
  // The statements are asserted with their bindings, in order: the food bank
  // and its latest need go out as ONE batch (two statements, one round trip),
  // then the donation points are read by the parent's INTEGER id, not by slug.
  it("reads everything through one session, resolving donation points by food bank id", async () => {
    await get("/md/needs/at/salisbury/donationpoints/");

    expect(new Set(prepared.map((p) => p.session)).size).toBe(1);
    expect(traffic()).toEqual([...FOODBANK_BATCH, ["SELECT * FROM foodbankdonationpoint_full WHERE foodbank_id = ?", [1]]]);
  });

  // The response IS the contract for this route: Django set
  // content_type='text/markdown; charset=utf-8' explicitly on all seven md
  // views, and a page served as text/html would be rendered as markup by
  // every client that reads it. Cache-Control comes from
  // middleware/pageCacheControl.ts (Django's @cache_page(SECONDS_IN_DAY) at
  // the edge, five deliberate minutes in the browser) and the tag from
  // middleware/cacheTag.ts, whose FOODBANK_PATH regex includes the `/md`
  // prefix -- so a donation-point edit purges the markdown mirror too, which
  // Django's hand-maintained URL list never did.
  it("serves markdown, cacheable for a day at the edge and tagged for its food bank", async () => {
    const res = await get("/md/needs/at/salisbury/donationpoints/");

    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
    // The mirror is untranslated, and says so.
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // A 404 is the site's HTML 404 page, not an empty markdown body, and it
  // carries no Cache-Control and no Cache-Tag -- there is nothing in any cache
  // to purge, and cacheTag skips non-2xx for that reason.
  it("answers 404 with the HTML error page and no caching headers", async () => {
    const res = await get("/md/needs/at/fb-town/donationpoints/");

    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});

// ===========================================================================
// mdFoodbankDonationpoint -- GET /md/needs/at/<slug>/donationpoint/<dpslug>/
// ===========================================================================

describe("mdFoodbankDonationpoint -- the page, whole", () => {
  // THE WHOLE BODY of the fullest donation point the fixture has: need list,
  // excess list, opening hours, notes, address and both contact links. Every
  // section below is also asserted individually against a row that lacks it;
  // this is the one place their ORDER and the blank lines between them are
  // pinned.
  //
  // Note "tel:01722 999888" keeps the space -- the template interpolates the
  // stored number into the href unencoded, exactly as Django's donationpoint.md
  // does. Faithful, and ugly, and not this port's decision to change.
  it("renders every section of a fully-populated donation point verbatim", async () => {
    const res = await get("/md/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      `# Tesco Extra - Salisbury Foodbank

Tesco Extra is a donation point for [Salisbury Foodbank](/md/needs/at/salisbury/).

## Items needed

Tinned Meat
Pasta
Rice

## Items not needed

Baked Beans, Soup

## Opening hours

Monday: 9:00 AM - 5:00 PM
Tuesday: Closed

## Notes

Ask at St John's kiosk


## Address

5 Retail Park
SP4 4DD
England

## Contact

- Website: [https://tesco.invalid/store/1?utm_source=newsletter](https://tesco.invalid/store/1?utm_source=newsletter)
- Phone: [01722 999888](tel:01722 999888)


`,
    );
  });

  // The same page for a row with none of the optional columns. The three
  // omitted sections are the point, and so is the BLANK LINE where the
  // country would be: `country` is nullable in production (0001_core.sql notes
  // 1 row of 5,744) and the template prints it unguarded, so an empty line
  // sits in the address block rather than the block collapsing.
  it("omits hours, notes and both contact links when the columns are empty, and prints a blank line for a NULL country", async () => {
    expect(await body("/md/needs/at/salisbury/donationpoint/aldi-express/")).toBe(
      `# aldi Express - Salisbury Foodbank

aldi Express is a donation point for [Salisbury Foodbank](/md/needs/at/salisbury/).

## Items needed

Tinned Meat
Pasta
Rice

## Items not needed

Baked Beans, Soup




## Address

7 St Mary's Way
SP5 5EE


## Contact



`,
    );
  });
});

describe("mdFoodbankDonationpoint -- which row, if any", () => {
  // THE WHOLE POINT OF THE PAIR. Donation points 21 and 24 share the slug
  // "tesco-extra" under two different food banks, a state production really
  // has. getDonationPointBySlugs binds BOTH slugs; drop the foodbank_slug half
  // and SQLite happily returns whichever row it reaches first, serving
  // Salisbury's Tesco under Cardiff's heading with a 200. Asserted from both
  // sides, so "always returns the first row" cannot pass either.
  it("resolves the donation point slug within its own food bank, not globally", async () => {
    const salisbury = await body("/md/needs/at/salisbury/donationpoint/tesco-extra/");
    const cardiff = await body("/md/needs/at/cardiff/donationpoint/tesco-extra/");

    expect(salisbury).toContain("# Tesco Extra - Salisbury Foodbank");
    expect(salisbury).toContain("5 Retail Park\nSP4 4DD\nEngland");
    expect(cardiff).toContain("# Cardiff Co-op - Cardiff Foodbank");
    expect(cardiff).toContain("3 Heol Y Bont\nCF11 2BB\nWales");
  });

  it("404s on an unknown food bank slug, without looking the donation point up", async () => {
    const res = await get("/md/needs/at/nope/donationpoint/tesco-extra/");

    expect(res.status).toBe(404);
    expect(sqlOf().some((sql) => sql.includes("foodbankdonationpoint"))).toBe(false);
  });

  it("404s on an unknown donation point slug under a real food bank", async () => {
    expect((await get("/md/needs/at/salisbury/donationpoint/nope/")).status).toBe(404);
  });

  // The other half of the pair check, stated as a 404 rather than as a
  // different page: "aldi-express" is a real donation point slug, just not
  // Cardiff's.
  it("404s on a donation point slug that belongs to a different food bank", async () => {
    expect((await get("/md/needs/at/cardiff/donationpoint/aldi-express/")).status).toBe(404);
  });

  // NO COUNTER GUARD ON THIS LEG, matching Django: md_foodbank_donationpoint
  // has no `if foodbank.no_donation_points == 0` line, only the two
  // get_object_or_404 calls. So the rows the LIST page hides are still served
  // individually -- by /md/sitemap.md, among other things, which links them
  // straight from the table. The two counters that 404 the list are both
  // asserted here, since a "consistency" fix would naturally copy the guard
  // across and break exactly these two URLs.
  it("serves a donation point whose food bank's counter is zero or NULL", async () => {
    expect((await get("/md/needs/at/closed-town/donationpoint/corner-shop/")).status).toBe(200);
    expect((await get("/md/needs/at/fb-town/donationpoint/fb-store/")).status).toBe(200);
  });

  it("does not answer a POST", async () => {
    expect((await get("/md/needs/at/salisbury/donationpoint/tesco-extra/", { method: "POST" })).status).toBe(404);
  });

  it("has no locale-prefixed twin", async () => {
    expect((await get("/cy/md/needs/at/salisbury/donationpoint/tesco-extra/")).status).toBe(404);
  });
});

describe("mdFoodbankDonationpoint -- the need text", () => {
  // gfwfbn/views.py:763-767 sets has_need False for exactly Unknown, Nothing
  // and Facebook -- so all three are fixtured, each under its own food bank.
  // ONE IS NOT ENOUGH: the check is a chain of three !== comparisons and
  // dropping any single link is invisible unless that particular sentinel has
  // a donation point to render. The introductory sentence stays either way, so
  // the whole difference is two headings.
  it("hides the need sections for every one of the three sentinel need texts", async () => {
    const cases = [
      ["/md/needs/at/closed-town/donationpoint/corner-shop/", "# Corner Shop - Closed Town Foodbank"],
      ["/md/needs/at/fb-town/donationpoint/fb-store/", "# FB Store - FB Town Foodbank"],
      ["/md/needs/at/nothing-town/donationpoint/no-need-shop/", "# No Need Shop - Nothing Town Foodbank"],
    ] as const;

    for (const [path, heading] of cases) {
      const md = await body(path);
      expect(md, path).toContain(heading);
      expect(md, path).not.toContain("## Items needed");
      expect(md, path).not.toContain("## Items not needed");
    }
  });

  // THE EXCESS BLOCK IS NESTED INSIDE has_need in both templates, so a
  // sentinel need suppresses the excess list even when the row has one.
  // closed-town's need is "Unknown" AND carries excess_change_text "Rice";
  // "Rice" must appear nowhere. Un-nesting the two `{% if %}`s -- which looks
  // like a tidy-up, since they are independent fields -- would start
  // publishing "items not needed" for food banks whose needs are unknown.
  it("suppresses the excess list too when the need is a sentinel, even though the column is set", async () => {
    expect(await body("/md/needs/at/closed-town/donationpoint/corner-shop/")).not.toContain("Rice");
  });

  // THE SENTINEL COMPARISON IS AGAINST THE RAW COLUMN, not the blank-line
  // stripped text -- Django compares `foodbank.latest_need.change_text`
  // directly, and this port keeps `latestNeedChangeText` separate from
  // `changeText` for exactly that reason. padded-unknown's change_text is
  // "\nUnknown\n", which is NOT one of the three sentinels, so the page
  // renders a need list containing the word "Unknown". Pinned as current
  // behaviour on both sides of the divide, because comparing the stripped
  // text instead is a one-word edit that no other test here notices.
  it("compares the sentinels against the raw text, so a padded 'Unknown' renders as a need", async () => {
    const md = await body("/md/needs/at/padded-unknown/donationpoint/padded-store/");

    expect(md).toContain("## Items needed\n\nUnknown\n");
  });

  // "" IS NOT ONE OF THE THREE SENTINELS. A food bank with no latest_need row
  // at all resolves to "" here, which passes the has_need gate, so the page
  // announces "## Items needed" above nothing.
  //
  // SUSPECT, PINNED, and a genuine divergence rather than an inherited quirk:
  // Django's view reads `foodbank.latest_need.change_text` on a None
  // latest_need, which raises AttributeError INSIDE THE VIEW -- a 500, not
  // this page. (The `?? ""` reasoning quoted in ../foodbank.ts's mdFoodbank
  // describes Django's TEMPLATE-level invalid-variable default, which this
  // view never reaches.) A 200 with an empty section is friendlier than a 500
  // and is what the code does today; recorded so a future fix is a decision.
  it("announces a need list and prints nothing when the food bank has no need record at all (suspect, pinned)", async () => {
    const md = await body("/md/needs/at/cardiff/donationpoint/tesco-extra/");

    expect(md).toContain("Cardiff Co-op is a donation point for [Cardiff Foodbank](/md/needs/at/cardiff/).\n\n## Items needed\n\n\n");
    expect(md).not.toContain("## Items not needed");
  });

  // FoodbankChange.get_change_text()/get_excess_text_list() -- blank lines
  // stripped from both fields, the change list joined back with newlines and
  // the excess list joined with ", " by the template's own loop. Salisbury's
  // need has a blank line in each column, so a handler that passed the raw
  // strings through would print an empty line in the needed list and an empty
  // item ("Baked Beans, , Soup") in the not-needed one.
  it("strips blank lines from both the need list and the excess list", async () => {
    const md = await body("/md/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(md).toContain("## Items needed\n\nTinned Meat\nPasta\nRice\n");
    expect(md).toContain("## Items not needed\n\nBaked Beans, Soup\n");
  });

  // The excess GATE reads the raw column while the LIST is the stripped one,
  // so a whitespace-only excess_change_text ("   ", truthy) prints the heading
  // with nothing under it. Django lands in the same place by a different
  // route: its `{% if %}` is equally truthy and get_excess_text_list() returns
  // [""], one empty item. Pinned as the harmless inconsistency it is.
  it("prints the not-needed heading with no items for a whitespace-only excess column", async () => {
    expect(await body("/md/needs/at/blank-excess/donationpoint/spar-store/")).toContain("## Items needed\n\nTea\n\n## Items not needed\n\n\n");
  });

  // SUSPECT, PINNED. nonEmptyLines() splits on "\n" ONLY, where Django's
  // get_text() (givefood/models/needs.py:256-257) uses str.splitlines(), which
  // treats "\r\n" as one break. On CRLF-stored text every line but the last
  // therefore keeps a trailing "\r". It is invisible in the multi-line need
  // list (the split and the join are inverses, so "\r\n" is re-emitted intact)
  // and VISIBLE in the excess list, where the items are joined with ", " and
  // the carriage return lands mid-sentence: "Beans\r, Soup" against Django's
  // "Beans, Soup".
  //
  // WHETHER PRODUCTION'S change_text/excess_change_text ACTUALLY CONTAIN CRLF
  // IS NOT VERIFIED HERE -- no production query was run for this. What is
  // known: an HTML textarea submits CRLF per the HTML spec, and this schema
  // already documents one column that holds it (0001_core.sql: foodbank.address
  // is "CRLF-separated; 1,066 of 1,071 rows contain \r\n"). So the input is
  // reachable, and the behaviour on it is pinned as it stands rather than
  // fixed.
  it("keeps a carriage return inside a CRLF excess item (suspect, pinned)", async () => {
    const md = await body("/md/needs/at/salvation-army/donationpoint/army-store/");

    expect(md).toContain("## Items not needed\n\nBeans\r, Soup\n");
    // The change list hides the same defect, because the split and the join
    // are inverses there.
    expect(md).toContain("## Items needed\n\nCustard\r\nFlour\n");
  });
});

describe("mdFoodbankDonationpoint -- envelope and D1 traffic", () => {
  // One session, three statements, in order -- and the child lookup's bindings
  // are (donation point slug, FOOD BANK slug), in that order, which is the
  // pair that makes the row unique. getDonationPointBySlugs takes them the
  // other way round in its signature (session, foodbankSlug, dpSlug) and binds
  // them reversed, so an argument swap at either end is a lookup that finds
  // nothing -- or, with colliding slugs, the wrong row.
  it("reads everything through one session, with the food bank slug bound to the child lookup", async () => {
    await get("/md/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(new Set(prepared.map((p) => p.session)).size).toBe(1);
    expect(traffic()).toEqual([
      ...FOODBANK_BATCH,
      ["SELECT * FROM foodbankdonationpoint_full WHERE slug = ? AND foodbank_slug = ?", ["tesco-extra", "salisbury"]],
    ]);
  });

  it("serves markdown, cacheable for a day at the edge and tagged for its food bank", async () => {
    const res = await get("/md/needs/at/salisbury/donationpoint/tesco-extra/");

    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect(res.headers.get("Cache-Tag")).toBe("fb-salisbury");
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  // The tag follows the food bank in the PATH, not the donation point, which
  // is what makes one purge after a food bank edit clear every page beneath
  // it. Asserted on a second food bank so a hardcoded "fb-salisbury" cannot
  // pass.
  it("tags each page with its own food bank", async () => {
    expect((await get("/md/needs/at/closed-town/donationpoint/corner-shop/")).headers.get("Cache-Tag")).toBe("fb-closed-town");
  });
});
