import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/api2/needs.ts -- gfapi2's two need endpoints, GET /needs/ and
// GET /need/<uuid:id>/, ported from gfapi2/views.py:778-830.
//
// WHY THIS FILE EXISTS. This is the endpoint pair that publishes what a food
// bank is short of, and every failure mode it has is a 200 with a
// well-formed document in it. An unpublished draft leaking into the list, a
// `found` in the wrong datetime shape, a foodbank URL that 404s, the list
// silently ordering a nine-o'clock need above an eight-o'clock one -- not one
// of those changes the status, the shape or the size of the response, so
// nothing below asserts a status and stops. Every test asserts VALUES, and
// both bodies are asserted whole, field for field, in all three formats the
// endpoints allow.
//
// REAL EVERYTHING. The real root app from src/index.ts (so these run at the
// real mount points, through the real middleware stack, and reach the real
// 404 page), the real migrations via schema.testkit's MIGRATIONS_SQL -- the
// `foodbankchange_full` VIEW included, which is what both queries actually
// read -- real SQLite through node:sqlite behind the real packages/db
// queries, and the real @givefood/serialise formatters. Nothing here is
// mocked: these two handlers reach nothing that leaves the machine.
//
// PARITY CLAIMS BELOW WERE RUN, NOT REASONED. Where a comment says Python
// does X, X came out of a Python process in /Users/jasoncartwright/Sites/foodcharity
// on this machine:
//   - django.utils.text.slugify (Django 5.2.6) for every `slug` claim,
//     including slugify(None) == "none";
//   - DjangoJSONEncoder, datetime.isoformat(), str(datetime) and yaml.dump
//     for the three renderings of `found`;
//   - dicttoxml + minidom.toprettyxml, through gfapi2/func.py's own
//     xml_item_name, for the XML shape.
// Where a comment says the port DIVERGES, the Django side was executed too.
//
// MUTATION-TESTED (TESTING.md's convention), in a copy of the tree OUTSIDE
// the repo -- never by editing a source file in place. The mutants and their
// fates are recorded at the bottom of this file.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// The D1DatabaseSession surface packages/db uses, over node:sqlite -- the
// same shim as routes/api1.test.ts and routes/api2/locations.test.ts, for the
// same reason: D1 is async where node:sqlite is synchronous, and that is the
// only difference that matters, the SQL text, the binding and the NULL
// semantics being SQLite's on both sides.
//
// IT RECORDS PARAMS AS WELL AS SQL, which the sibling shims do not. The whole
// of gfapi2's divergence from gfapi1 here is that the limit is HARDCODED at
// 100 with no querystring override, and a body assertion over a six-row
// fixture cannot see the number at all -- only the bound parameter can. The
// same record is what proves these two GET handlers never reach the engine
// with a write.
interface Executed {
  sql: string;
  params: Bindable[];
}

function d1Session(db: DatabaseSync, executed: Executed[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      executed.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      executed.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      executed.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let executed: Executed[];

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db, executed) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

const get = (path: string) => app.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
const json = async (path: string): Promise<unknown> => JSON.parse(await (await get(path)).text());

// ===========================================================================
// SEEDS
// ===========================================================================

// Real hex uuids, in both the 32-char dashless form the column holds (PLAN.md
// §4.4) and the dashed form toDashedUuid must emit. Written out as two
// literals rather than one derived from the other: the pair IS the contract,
// and a helper computing one from the other would be the implementation under
// test wearing a false moustache.
const NEED_SALISBURY = { dashless: "0f2fe1cba1f947e9b0e5ec6d1c7f3a01", dashed: "0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01" };
const NEED_PERTH = { dashless: "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6", dashed: "1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6" };
const NEED_ST_MARYS = { dashless: "22222222333344445555666677778888", dashed: "22222222-3333-4444-5555-666677778888" };
const NEED_LATEST = { dashless: "aaaaaaaabbbbccccddddeeeeffff0000", dashed: "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000" };
const NEED_DRAFT = { dashless: "99999999888877776666555544443333", dashed: "99999999-8888-7777-6666-555544443333" };
const NEED_ORPHAN = { dashless: "0123456789abcdef0123456789abcdef", dashed: "01234567-89ab-cdef-0123-456789abcdef" };
const NEED_ISO = { dashless: "fedcba9876543210fedcba9876543210", dashed: "fedcba98-7654-3210-fedc-ba9876543210" };

const SALISBURY_ID = 7;
const PERTH_ID = 12;
const ST_MARYS_ID = 30;

// Django's own shape: six fractional digits, a space separator, no offset.
// The shape every row is meant to hold now -- the ETL wrote it, and
// 0022_normalise_timestamps.sql rewrote the port's ISO-shaped rows into it.
const SALISBURY_CREATED = "2020-01-24 16:30:23.173268";

function seedFoodbank(id: number, slug: string, name: string): void {
  db.prepare(
    `INSERT INTO foodbank
       (id, uuid, name, slug, address, postcode, country, lat_lng, latitude, longitude,
        network, charity_just_foodbank, contact_email, phone_number, url, shopping_list_url,
        address_is_administrative, is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', 51.07, -1.79,
        'Trussell Trust', 0, ?, '01722 411900', ?, ?,
        0, 0, 0, 14, '2019-06-01 09:00:00.000000', '2026-08-14 09:15:00.000000')`,
  ).run(id, `f${String(id).padStart(31, "0")}`, name, slug, `info@${slug}.invalid`, `https://${slug}.invalid/`, `https://${slug}.invalid/list/`);
}

function seedNeed(
  id: number,
  uuid: string,
  foodbankId: number | null,
  changeText: string,
  excess: string | null,
  published: 0 | 1,
  created: string,
): void {
  db.prepare(
    `INSERT INTO foodbankchange
       (id, need_id, foodbank_id, change_text, excess_change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, 'scrape', ?, ?)`,
  ).run(id, uuid, foodbankId, changeText, excess, published, created, created);
}

function seed(): void {
  // THE COMMA IS LOAD-BEARING. `slugify(foodbank_name)` gives
  // "trussell-trust-salisbury" while the row's real slug is "salisbury", so
  // every URL this endpoint builds for it points somewhere that does not
  // exist -- in Django exactly as much as here (verified: Django 5.2.6's
  // slugify returns "trussell-trust-salisbury" for this name).
  seedFoodbank(SALISBURY_ID, "salisbury", "Trussell Trust, Salisbury");
  // THE CONTROL CASE: the one name where Django's slugify, this module's
  // reduced slugify and the real slug column all three agree. Without it,
  // "the slug is wrong" tests below could not tell a broken slugify from a
  // faithful one.
  seedFoodbank(PERTH_ID, "perth-kinross-foodbank", "Perth & Kinross Foodbank");
  // THE DIVERGENT CASE. Django 5.2.6 gives "st-marys-foodbank-andover" (which
  // IS this row's real slug); this module's reduced slugify gives
  // "st-mary-s-foodbank-andover", which is nobody's slug. Run, not assumed.
  //
  // The LEADING SPACE and the TRAILING ")" are both deliberate. Every
  // character in this name that is not [a-z0-9] becomes a "-" before the trim
  // runs, so without `.replace(/^-+|-+$/g, "")` the published slug would be
  // "-st-mary-s-foodbank-andover-". A fixture of tidy names cannot tell the
  // trim from no trim -- mutation-tested, and the first version of this file
  // (whose names all began and ended with a letter) let that mutant live.
  seedFoodbank(ST_MARYS_ID, "st-marys-foodbank-andover", " St. Mary's Foodbank (Andover)");

  // MIXED line endings inside change_text, and an excess list as well --
  // `excess` is the one field gfapi2 publishes that gfapi1 does not, so it has
  // no coverage anywhere else.
  //
  // The CR is deliberate but HISTORIC: cleanFoodbankNeedText()'s step 5 splits
  // on "\n" and re-joins on "\n" (givefood/utils/text.py:107-110, ported
  // verbatim), so nothing written through the scrape or admin path today
  // carries one, and how many older rows still do is not visible from this
  // machine. It is seeded because it is the only input that makes the XML
  // branch's handling of CR observable at all -- see "keeps the CR" below --
  // and because routes/api1.test.ts's fixture uses the same shape.
  seedNeed(500, NEED_SALISBURY.dashless, SALISBURY_ID, "Tinned tomatoes\r\nUHT milk\nCoffee", "Baked beans\r\nPasta", 1, SALISBURY_CREATED);
  // Microsecond zero, which Python renders with NO fractional part at all in
  // every one of the three datetime shapes (pyDatetime.ts's rule).
  seedNeed(501, NEED_PERTH.dashless, PERTH_ID, "Nothing", null, 1, "2026-09-04 10:00:00.000000");
  // excess_change_text = "" rather than NULL. Both occur (the field is
  // null=True, blank=True on models/needs.py:67), and "" must publish as ""
  // and not be coalesced into null by anything on the way out.
  seedNeed(512, NEED_ST_MARYS.dashless, ST_MARYS_ID, "Unknown", "", 1, "2026-08-29 12:00:00.000000");
  seedNeed(530, NEED_LATEST.dashless, SALISBURY_ID, "Pasta\r\nRice", null, 1, "2026-09-05 09:00:00.000000");
  // THE ROW THAT MUST BE EXCLUDED from /needs/ -- and that /need/<id>/ serves
  // anyway, because that view does not filter on published either (Django's
  // is a bare get_object_or_404).
  seedNeed(540, NEED_DRAFT.dashless, SALISBURY_ID, "Draft crisps", null, 0, "2026-09-05 11:59:12.000000");
  // An orphan: foodbank_id NULL, so foodbankchange_full's LEFT JOIN yields a
  // NULL foodbank_name. Reachable in production -- the column is nullable on
  // both sides (givefood/models/needs.py:58) and D1 has no foreign keys.
  seedNeed(550, NEED_ORPHAN.dashless, null, "Soup", null, 1, "2026-08-01 00:00:00.000000");
  // A row in the shape this port used to write, before ticket #9:
  // JavaScript's toISOString(). Its instant is an hour BEFORE need 530's and
  // it still sorts above it -- see "the ISO-shaped row" below.
  seedNeed(560, NEED_ISO.dashless, SALISBURY_ID, "Cereal", null, 1, "2026-09-05T08:00:00.000Z");
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  executed = [];
  seed();
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// GET /api/2/needs/
// ===========================================================================

const SALISBURY_FOODBANK_DICT = {
  name: "Trussell Trust, Salisbury",
  slug: "trussell-trust-salisbury",
  urls: {
    self: `${ORIGIN}/api/2/foodbank/trussell-trust-salisbury/`,
    html: `${ORIGIN}/needs/at/trussell-trust-salisbury/`,
  },
};

// The published needs, newest first -- as this endpoint actually orders them.
// See "the ISO-shaped row" for why 08:00 comes before 09:00.
const NEEDS_IN_ORDER = [
  {
    id: NEED_ISO.dashed,
    found: "2026-09-05T08:00:00",
    foodbank: SALISBURY_FOODBANK_DICT,
    needs: "Cereal",
    excess: null,
    self: `${ORIGIN}/api/2/need/${NEED_ISO.dashed}/`,
  },
  {
    id: NEED_LATEST.dashed,
    found: "2026-09-05T09:00:00",
    foodbank: SALISBURY_FOODBANK_DICT,
    needs: "Pasta\r\nRice",
    excess: null,
    self: `${ORIGIN}/api/2/need/${NEED_LATEST.dashed}/`,
  },
  {
    id: NEED_PERTH.dashed,
    found: "2026-09-04T10:00:00",
    foodbank: {
      name: "Perth & Kinross Foodbank",
      slug: "perth-kinross-foodbank",
      urls: {
        self: `${ORIGIN}/api/2/foodbank/perth-kinross-foodbank/`,
        html: `${ORIGIN}/needs/at/perth-kinross-foodbank/`,
      },
    },
    needs: "Nothing",
    excess: null,
    self: `${ORIGIN}/api/2/need/${NEED_PERTH.dashed}/`,
  },
  {
    id: NEED_ST_MARYS.dashed,
    found: "2026-08-29T12:00:00",
    foodbank: {
      // The name is published RAW, leading space and all -- only the slug is
      // trimmed, and only of hyphens.
      name: " St. Mary's Foodbank (Andover)",
      // Django 5.2.6 says "st-marys-foodbank-andover" for this name, which is
      // this row's real slug. See "slugifies a name differently from Django".
      slug: "st-mary-s-foodbank-andover",
      urls: {
        self: `${ORIGIN}/api/2/foodbank/st-mary-s-foodbank-andover/`,
        html: `${ORIGIN}/needs/at/st-mary-s-foodbank-andover/`,
      },
    },
    needs: "Unknown",
    excess: "", // the empty string, NOT null
    self: `${ORIGIN}/api/2/need/${NEED_ST_MARYS.dashed}/`,
  },
  {
    id: NEED_ORPHAN.dashed,
    found: "2026-08-01T00:00:00",
    foodbank: {
      name: null,
      // Django's slugify(None) is "none" -- str(None) first. Run, not assumed.
      slug: "",
      urls: {
        self: `${ORIGIN}/api/2/foodbank//`,
        html: `${ORIGIN}/needs/at//`,
      },
    },
    needs: "Soup",
    excess: null,
    self: `${ORIGIN}/api/2/need/${NEED_ORPHAN.dashed}/`,
  },
  {
    id: NEED_SALISBURY.dashed,
    // DjangoJSONEncoder: isoformat() truncated (never rounded) to three
    // fractional digits -- .173268 becomes .173.
    found: "2020-01-24T16:30:23.173",
    foodbank: SALISBURY_FOODBANK_DICT,
    needs: "Tinned tomatoes\r\nUHT milk\nCoffee",
    excess: "Baked beans\r\nPasta",
    self: `${ORIGIN}/api/2/need/${NEED_SALISBURY.dashed}/`,
  },
];

describe("GET /api/2/needs/", () => {
  // A GUARD ON THE FIXTURE, not on the module. Every `id` and `self`
  // expectation in this file is a hand-written `dashed` literal checked
  // against a hand-written `dashless` one, and a typo in either half would
  // make those assertions agree with each other and with nothing else. This is
  // the one place the pairing itself is checked, and it is deliberately not
  // done with toDashedUuid -- that is the function under test.
  it("has a self-consistent set of uuid pairs to assert against", () => {
    for (const pair of [NEED_SALISBURY, NEED_PERTH, NEED_ST_MARYS, NEED_LATEST, NEED_DRAFT, NEED_ORPHAN, NEED_ISO]) {
      expect(pair.dashed.replace(/-/g, "")).toBe(pair.dashless);
      expect(pair.dashed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("returns the published needs, newest first, field for field", async () => {
    const res = await get("/api/2/needs/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual(NEEDS_IN_ORDER);
  });

  // THE ROW THAT MUST BE EXCLUDED. An unpublished need is a draft the site has
  // deliberately not shown anyone; publishing it through the API would be the
  // worst failure this endpoint has. A fixture holding only published rows
  // cannot tell `WHERE published = 1` from no filter at all, so the draft is
  // seeded, asserted absent, and then asserted to really be in the table --
  // otherwise this passes because the row was never written.
  it("excludes unpublished needs", async () => {
    const body = await (await get("/api/2/needs/")).text();

    expect(body).not.toContain("Draft crisps");
    expect(body).not.toContain(NEED_DRAFT.dashed);
    expect(JSON.parse(body)).toHaveLength(6);
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbankchange").get()).toEqual({ n: 7 });
  });

  // A REGRESSION GUARD FOR TICKET #9, not a live bug -- and the distinction is
  // worth stating, because the same fixture in routes/api1.test.ts is labelled
  // "SUSPECT (reported, not fixed)" and that label has since been overtaken.
  // `created` is TEXT compared lexicographically; "T" (0x54) sorts above " "
  // (0x20), so a row written as "2026-09-05T08:00:00.000Z" sorts above one
  // written as "2026-09-05 09:00:00.000000" whatever the instants are. That
  // WAS live -- migration 0022_normalise_timestamps.sql records the two
  // measured consequences -- and it was fixed at the write sites
  // (@givefood/models pyNow(), used by insertFoodbankChange and
  // insertAdminNeed) with 0022 repairing the rows already stored.
  //
  // NOTHING ON THIS PATH DEFENDS AGAINST IT COMING BACK. The ORDER BY is still
  // lexicographic, and this endpoint publishes `found` right next to the
  // order, so one `new Date().toISOString()` at a write site would silently
  // put an eight-o'clock need at the top of a list headed by a nine-o'clock
  // one. This test seeds exactly that row and pins what the endpoint does with
  // it, so the day it reappears there is a failing test naming the cause.
  it("sorts the ISO-shaped row above an earlier-in-the-day Django-shaped one", async () => {
    const body = (await json("/api/2/needs/")) as Array<{ id: string; found: string }>;

    expect(body[0]!.id).toBe(NEED_ISO.dashed);
    expect(body[0]!.found).toBe("2026-09-05T08:00:00");
    expect(body[1]!.found).toBe("2026-09-05T09:00:00");
    // Same calendar day, and the one published FIRST is the EARLIER instant.
    // Stated as a comparison so the inversion is unmissable.
    expect(body[0]!.found < body[1]!.found).toBe(true);
    // The raw column is what the ordering actually sees.
    expect(db.prepare("SELECT created FROM foodbankchange WHERE need_id = ?").get(NEED_ISO.dashless)).toEqual({
      created: "2026-09-05T08:00:00.000Z",
    });
  });

  // THE LIMIT IS HARDCODED AT 100 AND THE NUMBER MATTERS. gfapi2's `needs`
  // takes no ?limit= at all (unlike gfapi1's api_needs, whose allow-list and
  // frozen bug B4 are covered in routes/api1.test.ts) -- so every one of these
  // querystrings must be ignored rather than honoured, rejected or 500'd.
  // Floods the table past the cut so the truncation lands inside the filler
  // and the six real needs stay at the head; with six rows in the fixture a
  // limit of 5, 100 or 1000 would be indistinguishable.
  it("cuts the list at a hardcoded 100, ignoring every ?limit= a caller sends", async () => {
    for (let i = 0; i < 100; i += 1) {
      seedNeed(
        700 + i,
        `eeeeeeeeeeeeeeeeeeeeeeeeeeee${String(i).padStart(4, "0")}`,
        SALISBURY_ID,
        `Filler ${i}`,
        null,
        1,
        // Older than every seeded need, and distinct from each other so the
        // ORDER BY is total rather than arbitrary within the filler.
        `2018-01-01 00:00:00.${String(i).padStart(6, "0")}`,
      );
    }

    const dflt = (await json("/api/2/needs/")) as Array<{ id: string; needs: string }>;
    expect(dflt).toHaveLength(100);
    // The six real needs survive the cut, in their own order, and the other 94
    // slots are filler -- so the cut is at the TAIL, not a slice off the front.
    expect(dflt.slice(0, 6).map((n) => n.id)).toEqual(NEEDS_IN_ORDER.map((n) => n.id));
    expect(dflt.filter((n) => n.needs.startsWith("Filler "))).toHaveLength(94);

    // Every ?limit= spelling gfapi1 treats as meaningful -- accepted, rejected
    // with a 400, or crashed into a 500 -- is inert here.
    const expected = JSON.stringify(dflt);
    for (const limit of ["1", "5", "1000", "10000", "abc", "", "-1"]) {
      const res = await get(`/api/2/needs/?limit=${limit}`);
      expect(res.status).toBe(200);
      const rows = JSON.parse(await res.text()) as unknown[];
      expect(rows).toHaveLength(100);
      expect(JSON.stringify(rows)).toBe(expected);
    }
  });

  // ONE STATEMENT, and the 100 reaches SQLite as a BOUND parameter rather than
  // as a JavaScript slice afterwards. The body assertion above is equally
  // happy with `LIMIT 1000` plus `.slice(0, 100)` in the handler, which would
  // read 10x the rows out of D1 for the same answer -- so the statement and
  // its parameter are asserted directly.
  it("issues exactly one query, with the limit bound rather than trimmed in JS", async () => {
    await get("/api/2/needs/");

    expect(executed).toEqual([
      {
        sql: "SELECT * FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?",
        params: [100],
      },
    ]);
  });

  // BOTH HANDLERS ARE PURE READS, and that is the only reason the
  // "answers GET only" test further down is a curiosity rather than a
  // safeguard: Django served these views on any method and nobody minded,
  // because there is nothing to mind. A statement that mutated would be
  // invisible in every body assertion in this file, so it is asserted where it
  // is visible -- in what actually reached the engine.
  it("never sends a write statement, on either endpoint", async () => {
    await get("/api/2/needs/");
    await get(`/api/2/need/${NEED_SALISBURY.dashed}/`);

    expect(executed).toHaveLength(2);
    for (const { sql } of executed) expect(sql).toMatch(/^SELECT /);
  });
});

// ===========================================================================
// GET /api/2/need/<uuid:id>/
// ===========================================================================

describe("GET /api/2/need/<id>/", () => {
  it("returns one need, field for field", async () => {
    const res = await get(`/api/2/need/${NEED_SALISBURY.dashed}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await res.text())).toEqual({
      id: NEED_SALISBURY.dashed,
      found: "2020-01-24T16:30:23.173",
      foodbank: SALISBURY_FOODBANK_DICT,
      needs: "Tinned tomatoes\r\nUHT milk\nCoffee",
      excess: "Baked beans\r\nPasta",
      self: `${ORIGIN}/api/2/need/${NEED_SALISBURY.dashed}/`,
    });
  });

  // The list and the detail build the same six fields from the same columns in
  // two places in the Python source (views.py:788-803 and :814-828) and from
  // one shared helper here. Asserted as an equality so that a change to either
  // fails here rather than in a body assertion someone updates twice.
  it("is identical to the same need's entry in the list", async () => {
    const list = (await json("/api/2/needs/")) as unknown[];

    expect(list).toContainEqual(await json(`/api/2/need/${NEED_SALISBURY.dashed}/`));
  });

  // DIVERGENCE, recorded rather than fixed. Django's `<uuid:id>` path
  // converter matches only the dashed, lower-case 8-4-4-4-12 form, so both of
  // these are 404s there -- the URL never reaches the view. Here
  // normalizeUuid() strips dashes and lower-cases on the way in, so a need has
  // three spellings on this API and one on the real one. Whichever is asked
  // for, `id` and `self` come back dashed and lower-case, so a client cannot
  // end up holding two ids for one need.
  it("also accepts the dashless and upper-case forms Django's URL pattern rejects", async () => {
    const dashed = await (await get(`/api/2/need/${NEED_SALISBURY.dashed}/`)).text();

    expect(await (await get(`/api/2/need/${NEED_SALISBURY.dashless}/`)).text()).toBe(dashed);
    expect(await (await get(`/api/2/need/${NEED_SALISBURY.dashed.toUpperCase()}/`)).text()).toBe(dashed);

    const body = (await json(`/api/2/need/${NEED_SALISBURY.dashed.toUpperCase()}/`)) as { id: string; self: string };
    expect(body.id).toBe(NEED_SALISBURY.dashed);
    expect(body.self).toBe(`${ORIGIN}/api/2/need/${NEED_SALISBURY.dashed}/`);
  });

  // NO published FILTER, on either side -- Django's is a bare
  // get_object_or_404(FoodbankChange, need_id=id). So a draft that /needs/
  // deliberately withholds is served in full to anyone holding its uuid. That
  // is the real API's behaviour and the port keeps it; the uuid is not
  // guessable, which is presumably why nobody has minded.
  it("serves an UNPUBLISHED need that /needs/ withholds", async () => {
    const res = await get(`/api/2/need/${NEED_DRAFT.dashed}/`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { needs: string }).needs).toBe("Draft crisps");
    expect(await (await get("/api/2/needs/")).text()).not.toContain("Draft crisps");
  });

  // An unknown id is `c.notFound()`, which is the SITE's 404 page -- an HTML
  // document, from the real Nunjucks pipeline, with no CORS header on it. An
  // API client asking for a need that has been deleted gets a page of HTML,
  // not a JSON error; that is what Django's get_object_or_404 does too (its
  // 404.html), and it is pinned here so nobody "improves" one API's error
  // shape without noticing it is the whole site's.
  it("404s an unknown, malformed or empty uuid with the site's HTML 404 page", async () => {
    for (const id of ["00000000-0000-0000-0000-000000000000", "not-a-uuid", "0f2fe1cb"]) {
      const res = await get(`/api/2/need/${id}/`);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await res.text()).not.toContain("Tinned tomatoes");
    }
  });

  // The 404 comes from the ROW being missing, not from the id being rejected
  // -- a real uuid that matches nothing gets the same answer as gibberish, and
  // the query really did run with the normalised (dashless) form bound.
  it("looks the id up dashless, and 404s on a miss rather than on a shape", async () => {
    await get(`/api/2/need/${NEED_SALISBURY.dashed.toUpperCase()}/`);

    expect(executed).toEqual([
      { sql: "SELECT * FROM foodbankchange_full WHERE need_id = ?", params: [NEED_SALISBURY.dashless] },
    ]);
  });

  it("publishes a null excess rather than an empty string, when the column is NULL", async () => {
    const body = (await json(`/api/2/need/${NEED_PERTH.dashed}/`)) as { excess: string | null };

    expect(body.excess).toBeNull();
  });
});

// ===========================================================================
// THE FOODBANK SLUG
// ===========================================================================

describe("the foodbank slug both endpoints build their URLs from", () => {
  // NOT a port bug: `foodbank_name_slug()` is Django's own
  // (givefood/models/needs.py:90-91, `slugify(self.foodbank_name)`), and it
  // has never been the food bank's slug. For a name with a comma in it, it is
  // nobody's URL. Reproduced deliberately, and pinned here so that "fixing" it
  // -- by reading foodbankchange_full.foodbank_slug, which the `SELECT *`
  // already returns even though FoodbankChangeRow does not declare it -- is a
  // visible decision about a live API rather than a tidy-up.
  it("derives the slug from the NAME even though the real slug is in the same row", async () => {
    const body = (await json("/api/2/needs/")) as Array<{ foodbank: { slug: string } }>;

    expect(body[0]!.foodbank.slug).toBe("trussell-trust-salisbury");
    // The row the handler read carries the real slug, so the join is not the
    // obstacle -- the behaviour is.
    expect(db.prepare("SELECT foodbank_slug FROM foodbankchange_full WHERE need_id = ?").get(NEED_ISO.dashless)).toEqual({
      foodbank_slug: "salisbury",
    });
    // And nothing in the database answers to the slug that was published.
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank WHERE slug = ?").get("trussell-trust-salisbury")).toEqual({ n: 0 });
  });

  // SUSPECT, and a divergence from Django rather than a frozen bug -- the
  // Django side was RUN (django.utils.text.slugify, 5.2.6, in
  // /Users/jasoncartwright/Sites/foodcharity). This module's slugify is
  // `[^a-z0-9]+ -> "-"`, which is not Django's: Django strips punctuation
  // BEFORE collapsing whitespace, keeps underscores, and ASCII-folds accents.
  //   Django "st-marys-foodbank-andover" <- " St. Mary's Foodbank (Andover)" -> port "st-mary-s-foodbank-andover"
  //   Django "bristol_north"             <- "Bristol_North"                  -> port "bristol-north"
  //   Django "ynys-mon-foodbank"         <- "Ynys Môn Foodbank"              -> port "ynys-m-n-foodbank"
  // The module's own comment acknowledges the simplification; the consequence
  // is concrete, and this fixture has the case where it bites: St Mary's real
  // slug IS Django's answer, so Django published a working URL and the port
  // publishes a 404. The apostrophe is what does it; how many production names
  // carry one is not something this machine can see (the migrations in this
  // repo carry no foodbank rows), so no count is claimed here.
  it("slugifies a name differently from Django, publishing a URL that resolves to nothing", async () => {
    const body = (await json("/api/2/needs/")) as Array<{ foodbank: { name: string | null; slug: string; urls: { self: string; html: string } } }>;
    const stMarys = body.find((n) => n.foodbank.name === " St. Mary's Foodbank (Andover)")!;

    expect(stMarys.foodbank.slug).toBe("st-mary-s-foodbank-andover");
    expect(stMarys.foodbank.urls.self).toBe(`${ORIGIN}/api/2/foodbank/st-mary-s-foodbank-andover/`);
    expect(stMarys.foodbank.urls.html).toBe(`${ORIGIN}/needs/at/st-mary-s-foodbank-andover/`);
    // Django's answer for the same name is this row's real slug ...
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank WHERE slug = ?").get("st-marys-foodbank-andover")).toEqual({ n: 1 });
    // ... and the port's is nobody's.
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank WHERE slug = ?").get("st-mary-s-foodbank-andover")).toEqual({ n: 0 });
  });

  // THE TRIM, stated on its own. Both ends of this name are punctuation, so
  // every character before "st" and after "andover" has already become a "-"
  // by the time the trim runs. Without it the published slug is
  // "-st-mary-s-foodbank-andover-", which is not merely a different slug but a
  // URL with an empty leading path segment's worth of noise in it -- and no
  // other assertion in this file would notice, because the name is still
  // recognisable inside it.
  it("trims the leading and trailing hyphens a punctuated name produces", async () => {
    const one = (await json(`/api/2/need/${NEED_ST_MARYS.dashed}/`)) as { foodbank: { slug: string; urls: { self: string } } };

    expect(one.foodbank.slug).toBe("st-mary-s-foodbank-andover");
    expect(one.foodbank.slug.startsWith("-")).toBe(false);
    expect(one.foodbank.slug.endsWith("-")).toBe(false);
    expect(one.foodbank.urls.self).not.toContain("foodbank/-st-");
  });

  // The control: a name all three agree on. Without this, every assertion
  // above is equally consistent with a slugify that mangles everything.
  it("agrees with Django, and with the real slug, on a name with no punctuation trouble", async () => {
    const body = (await json("/api/2/needs/")) as Array<{ foodbank: { name: string | null; slug: string } }>;
    const perth = body.find((n) => n.foodbank.name === "Perth & Kinross Foodbank")!;

    expect(perth.foodbank.slug).toBe("perth-kinross-foodbank");
    expect(db.prepare("SELECT COUNT(*) AS n FROM foodbank WHERE slug = ?").get("perth-kinross-foodbank")).toEqual({ n: 1 });
  });

  // A need whose food bank row is gone (or was never linked). Django's
  // slugify(None) is "none", so the real API publishes
  // /api/2/foodbank/none/ and /needs/at/none/; this port publishes an EMPTY
  // segment, from `need.foodbank_name ?? ""`. Both are broken URLs; they are
  // differently broken, and the port's are the kind with an empty path segment
  // in them, which is asserted below to really be a 404 rather than assumed to
  // be one.
  it("publishes an empty slug for an orphaned need, where Django says 'none'", async () => {
    const one = (await json(`/api/2/need/${NEED_ORPHAN.dashed}/`)) as {
      foodbank: { name: string | null; slug: string; urls: { self: string; html: string } };
    };

    expect(one.foodbank.name).toBeNull();
    expect(one.foodbank.slug).toBe("");
    expect(one.foodbank.urls.self).toBe(`${ORIGIN}/api/2/foodbank//`);
    expect(one.foodbank.urls.html).toBe(`${ORIGIN}/needs/at//`);
    expect(one.foodbank.urls.self).not.toContain("/foodbank/none/");
    // Both URLs this need publishes for its food bank are dead ends.
    expect((await get(new URL(one.foodbank.urls.self).pathname)).status).toBe(404);
    expect((await get(new URL(one.foodbank.urls.html).pathname)).status).toBe(404);
  });
});

// ===========================================================================
// FORMATS
// ===========================================================================

// Leaves ONE need in the table, so a whole-body assertion for XML and YAML is
// a readable literal rather than ninety lines of it. The ordering, the
// exclusions and the field values are all asserted on the full fixture in
// JSON above; what these need to pin is the SHAPE each serialiser gives one
// row -- the root tag, the singular item tag, the datetime rendering, the null
// and the empty string.
function keepOnlySalisbury(): void {
  db.prepare("DELETE FROM foodbankchange WHERE need_id != ?").run(NEED_SALISBURY.dashless);
}

// gfapi2/func.py's ApiResponse renders `xml` through
// dicttoxml(attr_type=False, custom_root=obj_name, item_func=xml_item_name)
// and then minidom's toprettyxml(). The port's js2xmlparser output differs
// from that in three ways ON PURPOSE (PLAN.md §7.4.3, structural not byte
// parity): a single-quoted declaration, four spaces where minidom uses a tab,
// and no trailing newline. Everything INSIDE is the contract, with one
// unintended exception the "keeps the CR" test below records -- and it was
// checked against the real thing: dicttoxml + minidom, driven through
// gfapi2/func.py's own xml_item_name over this exact payload, produce the
// same tags in the same order, `<need>` items under a `<needs>` root, a
// self-closing `<excess/>` for None, and a six-digit `found`.
const ONE_NEED_XML_BODY =
  "    <id>0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01</id>\n" +
  // isoformat(), six digits -- NOT the JSON encoder's three. Run: Python's
  // datetime(2020,1,24,16,30,23,173268).isoformat().
  "    <found>2020-01-24T16:30:23.173268</found>\n" +
  "    <foodbank>\n" +
  "        <name>Trussell Trust, Salisbury</name>\n" +
  "        <slug>trussell-trust-salisbury</slug>\n" +
  "        <urls>\n" +
  "            <self>https://www.givefood.org.uk/api/2/foodbank/trussell-trust-salisbury/</self>\n" +
  "            <html>https://www.givefood.org.uk/needs/at/trussell-trust-salisbury/</html>\n" +
  "        </urls>\n" +
  "    </foodbank>\n" +
  // Newlines raw and un-indented, CR included -- see the divergence test below.
  "    <needs>Tinned tomatoes\r\nUHT milk\nCoffee</needs>\n" +
  "    <excess>Baked beans\r\nPasta</excess>\n" +
  "    <self>https://www.givefood.org.uk/api/2/need/0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01/</self>\n";

// js-yaml with sortKeys -- so the keys come out alphabetical here where JSON
// and XML keep the dict literal's insertion order, and `found` is a BARE
// timestamp scalar rather than a quoted string (yaml.ts's PyTimestamp tag).
// PyYAML's own rendering of the same datetime is byte-identical:
// yaml.dump({'found': datetime(2020,1,24,16,30,23,173268)}) gives
// "found: 2020-01-24 16:30:23.173268" -- run, not assumed.
const ONE_NEED_YAML_BODY =
  'excess: "Baked beans\\r\\nPasta"\n' +
  "foodbank:\n" +
  "  name: Trussell Trust, Salisbury\n" +
  "  slug: trussell-trust-salisbury\n" +
  "  urls:\n" +
  "    html: https://www.givefood.org.uk/needs/at/trussell-trust-salisbury/\n" +
  "    self: https://www.givefood.org.uk/api/2/foodbank/trussell-trust-salisbury/\n" +
  "found: 2020-01-24 16:30:23.173268\n" +
  "id: 0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01\n" +
  'needs: "Tinned tomatoes\\r\\nUHT milk\\nCoffee"\n' +
  "self: https://www.givefood.org.uk/api/2/need/0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01/\n";

describe("the ?format= parameter", () => {
  // The default is a literal "json" in the handler, not an absent-parameter
  // fallthrough somewhere lower down -- so an explicit ?format=json must give
  // byte-identical output, and both must be JSON.
  it("defaults to json, identically to asking for it", async () => {
    const dflt = await get("/api/2/needs/");
    const explicit = await get("/api/2/needs/?format=json");

    expect(dflt.headers.get("Content-Type")).toBe("application/json");
    expect(explicit.headers.get("Content-Type")).toBe("application/json");
    expect(await dflt.text()).toBe(await explicit.text());
  });

  // THE WHOLE JSON BODY AS A STRING, not through JSON.parse -- which is the
  // only way to see the two things a parse throws away. Both are Django's:
  // json_dumps_params={'indent': 2} in gfapi2/func.py, and the key order of
  // the dict literal in views.py:814-828 (id, found, foodbank, needs, excess,
  // self -- NOT alphabetical, and not the sorted order the YAML branch uses).
  it("renders JSON at indent 2, in the Python dict's key order", async () => {
    const body = await (await get(`/api/2/need/${NEED_PERTH.dashed}/`)).text();

    expect(body).toBe(
      "{\n" +
        '  "id": "1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6",\n' +
        '  "found": "2026-09-04T10:00:00",\n' +
        '  "foodbank": {\n' +
        '    "name": "Perth & Kinross Foodbank",\n' +
        '    "slug": "perth-kinross-foodbank",\n' +
        '    "urls": {\n' +
        '      "self": "https://www.givefood.org.uk/api/2/foodbank/perth-kinross-foodbank/",\n' +
        '      "html": "https://www.givefood.org.uk/needs/at/perth-kinross-foodbank/"\n' +
        "    }\n" +
        "  },\n" +
        '  "needs": "Nothing",\n' +
        '  "excess": null,\n' +
        '  "self": "https://www.givefood.org.uk/api/2/need/1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6/"\n' +
        "}",
    );
  });

  it("renders one need as XML under a <need> root", async () => {
    const res = await get(`/api/2/need/${NEED_SALISBURY.dashed}/?format=xml`);

    expect(res.headers.get("Content-Type")).toBe("text/xml");
    expect(await res.text()).toBe("<?xml version='1.0'?>\n<need>\n" + ONE_NEED_XML_BODY + "</need>");
  });

  // THE ITEM TAG IS THE POINT. A list is `<needs>` wrapping one `<need>` per
  // row, from gfapi2/func.py's `singular` dict -- get it wrong (or lose the
  // pre-wrap that supplies it) and every item is tagged `<needs>`, or `<None>`
  // like the donationpoints endpoint's frozen bug B1, and every consumer's
  // XPath stops matching without a single request failing.
  it("renders the list as <need> items under a <needs> root", async () => {
    keepOnlySalisbury();
    const res = await get("/api/2/needs/?format=xml");

    expect(res.headers.get("Content-Type")).toBe("text/xml");
    // Written out rather than derived from ONE_NEED_XML_BODY by re-indenting
    // it: the two are different documents (one has a wrapper the other does
    // not), and a transform clever enough to turn one into the other is a
    // second implementation to get wrong.
    expect(await res.text()).toBe(
      "<?xml version='1.0'?>\n" +
        "<needs>\n" +
        "    <need>\n" +
        "        <id>0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01</id>\n" +
        "        <found>2020-01-24T16:30:23.173268</found>\n" +
        "        <foodbank>\n" +
        "            <name>Trussell Trust, Salisbury</name>\n" +
        "            <slug>trussell-trust-salisbury</slug>\n" +
        "            <urls>\n" +
        "                <self>https://www.givefood.org.uk/api/2/foodbank/trussell-trust-salisbury/</self>\n" +
        "                <html>https://www.givefood.org.uk/needs/at/trussell-trust-salisbury/</html>\n" +
        "            </urls>\n" +
        "        </foodbank>\n" +
        "        <needs>Tinned tomatoes\r\nUHT milk\nCoffee</needs>\n" +
        "        <excess>Baked beans\r\nPasta</excess>\n" +
        "        <self>https://www.givefood.org.uk/api/2/need/0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01/</self>\n" +
        "    </need>\n" +
        "</needs>",
    );
  });

  it("emits one <need> element per row, over the full fixture", async () => {
    const body = await (await get("/api/2/needs/?format=xml")).text();

    expect(body.match(/<need>/g)).toHaveLength(6);
    expect(body).not.toContain("<None>"); // B1's tag belongs to donationpoints, not here
    expect(body).not.toContain("Draft crisps");
  });

  // A DIVERGENCE ONLY A ROUTE TEST CAN SEE, reported rather than fixed.
  // Django builds its XML with dicttoxml and then RE-PARSES it through minidom
  // to pretty-print it, and an XML parser normalises CRLF to LF (XML 1.0
  // §2.11). So the live API's `<needs>` text has no CR in it and this port's
  // does -- run, not assumed: dicttoxml + parseString + toprettyxml over this
  // exact payload gives "Tinned tomatoes\nUHT milk\nCoffee".
  //
  // It only bites on a stored value that still holds a CR (see the fixture's
  // note), and it is the one place the port is arguably MORE faithful -- the
  // stored value survives -- which is exactly why it is pinned rather than
  // quietly "fixed" in either direction. packages/serialise's own xml.test.ts
  // covers raw "\n" but has no CR case, so this is the only assertion of it.
  it("keeps the CR that Django's XML round-trip strips", async () => {
    const body = await (await get(`/api/2/need/${NEED_SALISBURY.dashed}/?format=xml`)).text();

    expect(body).toContain("<needs>Tinned tomatoes\r\nUHT milk\nCoffee</needs>");
    // The JSON branch keeps it on both sides -- so this is the XML
    // round-trip's doing, not a difference in what was stored.
    expect(((await json(`/api/2/need/${NEED_SALISBURY.dashed}/`)) as { needs: string }).needs).toBe("Tinned tomatoes\r\nUHT milk\nCoffee");
  });

  it("renders one need as YAML, keys sorted, with a bare timestamp scalar", async () => {
    const res = await get(`/api/2/need/${NEED_SALISBURY.dashed}/?format=yaml`);

    expect(res.headers.get("Content-Type")).toBe("text/yaml");
    expect(await res.text()).toBe(ONE_NEED_YAML_BODY);
    // Bare, not quoted: a quoted "2020-01-24 16:30:23.173268" would load as a
    // string where PyYAML's loads as a datetime -- a type change on the wire,
    // which is the one thing structural parity is meant to preserve.
    expect(await (await get(`/api/2/need/${NEED_SALISBURY.dashed}/?format=yaml`)).text()).not.toContain("'2020-01-24");
  });

  it("renders the list as a YAML sequence", async () => {
    keepOnlySalisbury();
    const res = await get("/api/2/needs/?format=yaml");

    expect(res.headers.get("Content-Type")).toBe("text/yaml");
    expect(await res.text()).toBe(
      '- excess: "Baked beans\\r\\nPasta"\n' +
        "  foodbank:\n" +
        "    name: Trussell Trust, Salisbury\n" +
        "    slug: trussell-trust-salisbury\n" +
        "    urls:\n" +
        "      html: https://www.givefood.org.uk/needs/at/trussell-trust-salisbury/\n" +
        "      self: https://www.givefood.org.uk/api/2/foodbank/trussell-trust-salisbury/\n" +
        "  found: 2020-01-24 16:30:23.173268\n" +
        "  id: 0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01\n" +
        '  needs: "Tinned tomatoes\\r\\nUHT milk\\nCoffee"\n' +
        "  self: https://www.givefood.org.uk/api/2/need/0f2fe1cb-a1f9-47e9-b0e5-ec6d1c7f3a01/\n",
    );
  });

  // The null/empty-string distinction, which each serialiser spells
  // differently and any of them could flatten. Django sent None for one and ""
  // for the other, and a consumer that treats "no excess list" and "an empty
  // excess list" alike is making a decision this API should not make for it.
  it("distinguishes a NULL excess from an empty-string one in all three formats", async () => {
    const yaml = await (await get("/api/2/needs/?format=yaml")).text();
    expect(yaml).toContain("- excess: null\n"); // NEED_PERTH and the rest
    expect(yaml).toContain("- excess: ''\n"); // NEED_ST_MARYS

    const xmlNull = await (await get(`/api/2/need/${NEED_PERTH.dashed}/?format=xml`)).text();
    const xmlEmpty = await (await get(`/api/2/need/${NEED_ST_MARYS.dashed}/?format=xml`)).text();
    // js2xmlparser writes the literal text "null" unless Absent.instance is
    // substituted, so this pair is what proves xml.ts's swap still happens.
    expect(xmlNull).toContain("<excess/>");
    expect(xmlNull).not.toContain("<excess>null</excess>");
    expect(xmlEmpty).toContain("<excess/>"); // an empty string self-closes too -- indistinguishable in XML, on both sides

    const jsonNull = (await json(`/api/2/need/${NEED_PERTH.dashed}/`)) as { excess: string | null };
    const jsonEmpty = (await json(`/api/2/need/${NEED_ST_MARYS.dashed}/`)) as { excess: string | null };
    expect(jsonNull.excess).toBeNull();
    expect(jsonEmpty.excess).toBe("");
  });

  // ALLOWED_FORMATS is per object name, and `needs`/`need` are the STD_FORMATS
  // entries -- no geojson, because a need has no geometry. The neighbouring
  // /api/2/locations/ endpoint DOES serve geojson from the same helper, so
  // "the API supports geojson" is not a rule that could be relied on to keep
  // this correct.
  it("400s every format outside json/xml/yaml, on both endpoints", async () => {
    for (const path of ["/api/2/needs/", `/api/2/need/${NEED_SALISBURY.dashed}/`]) {
      for (const format of ["geojson", "csv", "rss", "opml", "JSON", "Yaml", "", "json%20"]) {
        const res = await get(`${path}?format=${format}`);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe(""); // HttpResponseBadRequest() -- empty body
      }
    }
    // ... and geojson really is served elsewhere, so the 400 above is the
    // table talking and not a serialiser that cannot do it.
    expect((await get("/api/2/locations/?format=geojson")).status).toBe(200);
  });

  // An empty ?format= is PRESENT, so `?? "json"` never fires -- exactly as
  // Python's request.GET.get("format", DEFAULT_FORMAT) returns "" rather than
  // the default. Called out separately because "" is the one value a
  // hand-rolled `|| "json"` would silently rescue, turning a 400 into a 200.
  it("400s an empty ?format= rather than defaulting it", async () => {
    expect((await get("/api/2/needs/?format=")).status).toBe(400);
    expect((await get("/api/2/needs/")).status).toBe(200);
  });

  // THE CORS ASYMMETRY, reproduced from gfapi2/func.py rather than fixed: the
  // `return HttpResponseBadRequest()` happens BEFORE the line that sets
  // Access-Control-Allow-Origin, so a browser client asking for a bad format
  // sees an opaque CORS failure and never reads the 400 at all. PLAN.md §7.7.2
  // documents it; a helpful "set the header on every response" edit would be a
  // change to a live API's observable behaviour.
  it("sends no CORS header on the 400, where the 200 has one", async () => {
    const bad = await get("/api/2/needs/?format=geojson");
    const good = await get("/api/2/needs/");

    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(bad.headers.get("Cache-Control")).toBeNull();
    expect(good.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // The first `format` wins, because c.req.query() returns the first value of
  // a repeated parameter -- same as Django's QueryDict.get(), which returns
  // the LAST. DIVERGENCE, pinned: ?format=json&format=xml is JSON here and XML
  // there. Nobody sends this deliberately; it is here because it is the one
  // input on which the two disagree, and because a future switch to
  // queries()[last] would be invisible otherwise.
  it("takes the FIRST repeated format, where Django takes the last", async () => {
    const res = await get("/api/2/needs/?format=json&format=xml");

    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

// ===========================================================================
// HEADERS AND THE MOUNTS
// ===========================================================================

describe("the endpoints as mounted", () => {
  // gfapi2/views.py decorates `needs` with @cache_page(SECONDS_IN_HOUR) and
  // `need` with @cache_page(SECONDS_IN_DAY) -- read from the source. The two
  // numbers differ because the list changes whenever any food bank is scraped
  // while one need changes only if someone edits it in the admin. Both headers
  // are set by the handler itself, so middleware/pageCacheControl.ts's
  // gap-filler must not touch them; it is mounted on "*" and would otherwise
  // stamp its own five-minute browser TTL on top.
  it("sends the hour/day cache TTLs the @cache_page decorators specify", async () => {
    expect((await get("/api/2/needs/")).headers.get("Cache-Control")).toBe("public, max-age=3600, s-maxage=3600");
    expect((await get(`/api/2/need/${NEED_SALISBURY.dashed}/`)).headers.get("Cache-Control")).toBe("public, max-age=86400, s-maxage=86400");
  });

  // PLAN.md §3.6: the edge cache is purged by TAG, so a response with no tag
  // cannot be purged at all and goes stale to its TTL.
  it("tags the list for purging, and leaves the detail endpoint untaggable", async () => {
    expect((await get("/api/2/needs/")).headers.get("Cache-Tag")).toBe("fb-all");
    // SUSPECT (reported, not fixed). cacheTag.ts's AGGREGATE_PATHS matches
    // "/api/2/needs" but no rule in that file matches "/api/2/need/<uuid>/",
    // so one need's API representation carries no tag and cannot be purged --
    // with s-maxage=86400 on it, a need edited in the admin is served stale
    // for up to a day. Django did not purge it either (Foodbank.save()'s
    // decache list names api2:foodbanks, api2:locations, api2:foodbank and
    // api2:constituency, and neither api2:needs nor api2:need), so this is
    // inherited rather than introduced -- but the port DOES tag the list, so
    // the pair is now inconsistent with itself.
    expect((await get(`/api/2/need/${NEED_SALISBURY.dashed}/`)).headers.get("Cache-Tag")).toBeNull();
  });

  // gfapi2 is dual-mounted at /api/2/* AND the bare /api/* -- givefood/urls.py
  // includes the same urlconf twice. Both must answer, with the SAME body:
  // every URL inside is a hardcoded /api/2/ string, so the alias's responses
  // point back at the versioned endpoints rather than at themselves.
  it("answers at the bare /api/ alias with the identical body", async () => {
    const versioned = await (await get("/api/2/needs/")).text();
    const alias = await get("/api/needs/");

    expect(alias.status).toBe(200);
    expect(await alias.text()).toBe(versioned);
    expect((await get(`/api/need/${NEED_SALISBURY.dashed}/`)).status).toBe(200);
    expect(await (await get(`/api/need/${NEED_SALISBURY.dashed}/`)).text()).toBe(await (await get(`/api/2/need/${NEED_SALISBURY.dashed}/`)).text());
  });

  // SUSPECT (reported, not fixed), and index.ts's comment above the /api
  // mounts already says it in prose: "only the /api/2/ forms are in the
  // current purge list, so the /api/ aliases have been going stale to TTL"
  // (quoting PLAN.md §10.2.2). cacheTag.ts's AGGREGATE_PATHS
  // requires the /api/[123]/ prefix, so the alias gets no tag -- an identical
  // body to the versioned URL, cached for an hour, and unpurgeable. Asserted
  // rather than left in a comment so that the day someone widens the regex,
  // this test is what tells them the behaviour changed.
  it("leaves the bare /api/ alias untagged, and therefore unpurgeable", async () => {
    const alias = await get("/api/needs/");

    expect(alias.headers.get("Cache-Tag")).toBeNull();
    expect(alias.headers.get("Cache-Control")).toBe("public, max-age=3600, s-maxage=3600");
  });

  // Every self/html URL in gfapi2/views.py is a literal
  // "https://www.givefood.org.uk/..." -- read from the source, not derived
  // from the request. So a request arriving on beta, or on a preview
  // deployment, still publishes www.givefood.org.uk URLs. Pinned because
  // "use the request's origin" looks like an improvement and would change
  // every URL every non-production environment hands out.
  it("hardcodes www.givefood.org.uk whatever host was asked", async () => {
    const res = await app.fetch(new Request(`https://beta.givefood.invalid/api/2/need/${NEED_SALISBURY.dashed}/`), env(), execCtx);
    const body = (await res.json()) as { self: string; foodbank: { urls: { self: string; html: string } } };

    expect(body.self).toBe(`${ORIGIN}/api/2/need/${NEED_SALISBURY.dashed}/`);
    expect(body.foodbank.urls.self).toBe(`${ORIGIN}/api/2/foodbank/trussell-trust-salisbury/`);
    expect(body.foodbank.urls.html).toBe(`${ORIGIN}/needs/at/trussell-trust-salisbury/`);
  });

  // Django's APPEND_SLASH, reproduced by lib/appendSlash.ts: the unslashed
  // form 301s to the slashed one. It works only because the probe that decides
  // it is a HEAD request and Hono answers HEAD from a GET route -- so this is
  // as much a test of that assumption as of the redirect. An absolute
  // Location, matching Django's own.
  it("301s the unslashed forms onto the slashed ones", async () => {
    for (const path of ["/api/2/needs", "/api/needs", `/api/2/need/${NEED_SALISBURY.dashed}`]) {
      const res = await get(path);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`${ORIGIN}${path}/`);
    }
    // A uuid that resolves to nothing has nothing to redirect TO, so the probe
    // fails and the 404 page is served rather than a redirect into another 404.
    expect((await get("/api/2/need/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  // Django's urlconf restricts no method: POST /api/2/needs/ runs the same
  // view and returns the same JSON there. Hono registers these with .get(), so
  // anything else falls through to the site's 404. Harmless -- both handlers
  // are pure reads, which the executed-statement test above is what actually
  // guarantees -- but pinned, because it is a real difference in what the API
  // answers.
  it("answers GET only, where Django answered any method", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await app.fetch(new Request(`${ORIGIN}/api/2/needs/`, { method }), env(), execCtx);
      expect(res.status).toBe(404);
    }
    // HEAD does work, and is not incidental: lib/appendSlash.ts's probe -- and
    // therefore every APPEND_SLASH redirect above -- depends on it.
    const head = await app.fetch(new Request(`${ORIGIN}/api/2/needs/`, { method: "HEAD" }), env(), execCtx);
    expect(head.status).toBe(200);
  });
});

// ===========================================================================
// MUTATION TESTING
// ===========================================================================
//
// Run in a copy of the tree OUTSIDE the repo -- never by editing a source file
// in place. Each mutant was applied on its own and this file re-run against
// it. Recorded here because a test that survives a plausible wrong
// implementation is decoration, and the only evidence of the difference is
// having tried.
//
// 24 mutants, 24 killed, with the number of failing tests each:
//   needs.ts    SITE_DOMAIN -> the request's origin ..................... 11
//   needs.ts    slug read from the view's real foodbank_slug column ..... 10
//   needs.ts    slugify losing its leading/trailing hyphen trim .........  3
//   needs.ts    slugify keeping case ................................... 12
//   needs.ts    `excess` dropped from the response dict ................  9
//   needs.ts    `found` emitted as the raw column, not { __datetime } ...  8
//   needs.ts    toDashedUuid replaced by the raw dashless need_id ...... 11
//   needs.ts    `needs`/`excess` swapped in the dict's key order .......  3
//   needs.ts    the foodbank html URL losing its trailing slash ........ 10
//   needs.ts    list limit 100 -> 1000 .................................  2
//   needs.ts    ?limit= honoured, gfapi1-style .........................  1
//   needs.ts    the limit applied as a JS .slice() over 1000 rows ......  1
//   needs.ts    SECONDS_IN_HOUR/SECONDS_IN_DAY swapped .................  2
//   needs.ts    "needs"/"need" objName swapped in the apiResponse calls .  2
//   needs.ts    the `if (!need) return c.notFound()` guard deleted ......  2
//   packages/db getPublishedNeeds losing `WHERE published = 1` ..........  7
//   packages/db getPublishedNeeds ordering ASC .........................  4
//   packages/db getPublishedNeeds losing its LIMIT, bind and all .......  2
//   packages/db getNeedByUuid gaining `AND published = 1` ..............  2
//   packages/db normalizeUuid no longer stripping dashes ............... 18
//   serialise   xml.ts's SINGULAR losing `needs: "need"` (-> B1's <None>)  2
//   apiResponse ALLOWED_FORMATS.needs gaining "geojson" ................  2
//   apiResponse the 400 branch moved BELOW the CORS header .............  1
//   apiResponse formatJson's indent 2 -> compact .......................  1
//
// THE HYPHEN-TRIM MUTANT SURVIVED THE FIRST VERSION OF THIS FILE, whose
// fixture names all began and ended with a letter. That is why St Mary's
// carries a leading space and a trailing ")" -- see its seed comment.
//
// One mutant was DISCARDED rather than counted: dropping the LIMIT clause but
// leaving `.bind(limit)` in place makes node:sqlite throw "column index out of
// range", so it kills the suite by crashing rather than by being wrong. The
// realistic version (clause and bind both removed) is the one recorded above.
//
// Mutating packages/* needs the workspace links to resolve INSIDE the copy;
// symlinking node_modules wholesale sends them back to the real tree and every
// packages/* mutant silently does nothing. rsync -a of the whole tree
// (node_modules included, symlinks preserved) is what the numbers above were
// produced with.
