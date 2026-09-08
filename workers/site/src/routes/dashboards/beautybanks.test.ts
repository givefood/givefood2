import { DatabaseSync } from "node:sqlite";
import { BEAUTYBANKS_PRODUCTS } from "@givefood/db";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { serverTiming } from "../../middleware/serverTiming";
import type { AppEnv } from "../../types";
import { gfdashBeautybanks } from "./beautybanks";
import LONDON_POSTCODES from "../../data/london-postcodes.json";

// routes/dashboards/beautybanks.ts -- gfdashBeautybanks, the ONE exported
// symbol, serving GET /dashboard/beautybanks/. Ported from gfdash
// `beautybanks` (gfdash/views.py:245-335) with its template
// gfdash/templates/dash/beautybanks.html, both read alongside this file, plus
// givefood/utils/text.py:138-148's filter_change_text() which the module's own
// comment cites.
//
// WHY THIS FILE EXISTS. This page has no failure mode that looks like a
// failure. Every one of the four things it computes is a filter or a slice,
// and a filter that silently does nothing renders a perfectly good-looking
// dashboard with a 200 and the wrong rows on it:
//
//   * THE LONDON TAB IS A PREFIX MATCH AGAINST A 255-ENTRY FILE. A London
//     filter that matched everything, or nothing, produces a page that still
//     has a London tab with food banks in it (or an empty tab, which reads as
//     "no beauty needs in London this week" -- a plausible sentence). The
//     tests below therefore seed food banks that MUST be excluded -- a
//     Salisbury one, and a Westminster SW1A one, which is genuinely central
//     London and genuinely not in the file -- and assert their absence.
//   * THE 28-DAY MAP WINDOW is only visible as the number of markers on a
//     map. A need from 29 days ago sitting on it is indistinguishable from a
//     need from yesterday.
//   * THE TWO 50-ROW SLICES apply to different populations: all_needs is the
//     newest 50 overall, london_needs the newest 50 LONDON rows -- which are
//     not a subset of the first 50. A handler that filtered the already-sliced
//     array would show an empty London tab on any day when London's most
//     recent beauty need is the 51st newest, which is most days.
//   * ORDER BY reads a TEXT column lexicographically, so a row whose `created`
//     was written by the port ("...T12:00:00.000Z") sorts above every
//     Django-written row on the same date ("... 23:00:00.000000") regardless
//     of the actual time -- 'T' (0x54) beats ' ' (0x20).
//
// So the assertions read VALUES out of the rendered body -- names, hrefs,
// postcodes, need lines, timesince strings, and the parsed map payload -- and
// out of the SQL that actually reached the engine. Never a status code alone.
//
// REAL EVERYTHING, the same harness as routes/public/news.test.ts (its
// d1Session shim and env() are copied rather than re-invented): the real
// production app from workers/site/src/index.ts, so route registration,
// pageCacheControl, cacheTag and serverTiming are the genuine articles; the
// real Nunjucks templates via the real render(); and real in-memory SQLite
// built by schemaFor() from the real migrations, so `foodbankchange`'s NOT
// NULL columns and `foodbank`'s unique indexes are the ones production has.
// Mocked: only the two KV namespaces (Maps -- there is no local double).
//
// PARITY WORK ACTUALLY DONE, not asserted from memory:
//   * BEAUTYBANKS_PRODUCTS was compared element-by-element with the list
//     literal in gfdash/views.py:247-288 by script -- identical, same order,
//     40 items. The port's prose says "39" six times across beautybanks.ts and
//     packages/db/src/dashboards.ts; the code is right and the comments are
//     off by one, which is why the count is asserted below rather than trusted.
//   * data/london-postcodes.json was compared with
//     givefood/data/london_postcodes.txt read the way Django reads it
//     (.read().splitlines()) -- identical, 255 entries. The file has 254
//     newlines and no trailing one, which is where the port's three "254"
//     comments come from; splitlines() yields 255, and so does the JSON.
//   * SQLite's LIKE was checked directly (node:sqlite, `'50 tins of soap' LIKE
//     '%Soap%'` -> matches) because a case-insensitive keyword match is the
//     source of the empty-Needs-cell rows pinned below.
//   * NOT verified: Postgres's behaviour for Django's `__contains` /
//     `__startswith`. Django documents both as case-SENSITIVE (the `i`
//     variants are the insensitive ones); no Postgres was run here.
//
// MUTATION-TESTED in an rsync'd copy of the repo in a scratch directory
// outside it -- never by editing a source file in place -- with 24 deliberate
// breakages, all 24 caught:
//   beautybanks.ts  ALL_NEEDS_LIMIT and LONDON_NEEDS_LIMIT 50 -> 49;
//                   TIME_SINCE_DAYS 28 -> 35; the 28-day `>` flipped to `<`
//                   and the whole filter removed; isLondonPostcode inverted,
//                   turned into `includes`, and made case-insensitive; the
//                   London filter moved onto the already-sliced 50; each of
//                   the two slices removed; filteredChangeLines' dedupe
//                   removed, its `some` turned into `every`, and the call
//                   replaced by a raw split; the joined slug replaced by a
//                   slugify() of the name; the postcode column swapped for the
//                   name; `now` replaced by the epoch; the map payload's
//                   lat/lng transposed and its lines joined with a space.
//   dashboards.ts   `published = 1` dropped; ORDER BY reversed; a LIMIT 50 put
//                   back into the SQL (Django's own shape); the JOIN widened to
//                   LEFT JOIN; one product keyword deleted from the list.

const ORIGIN = "https://www.givefood.org.uk";

// Tuesday 8 September 2026, 09:30 UTC. Frozen because THREE separate outputs
// are computed from the clock -- the 28-day map window, and the "N days ago"
// column in each of the two tables -- so an unfrozen Date would make every
// expectation below either time-varying or vacuous. Date only: elapsedMs()
// uses performance.now() and has to stay real for the "Took Nms" test.
const NOW = new Date("2026-09-08T09:30:00.000Z");

// U+00A0, spelled out in a constant because it is invisible in a diff: a
// plain space here would fail every "N days ago" expectation below for a
// reason nobody could see. lib/timesince.ts puts it inside each unit
// deliberately -- it is Django's avoid_wrapping(), so "2 days" cannot break
// across a line.
const NBSP = " ";

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: the SQL text AND the values bound to
// it. Both halves matter here -- the text is the only place `published = 1`,
// the JOIN and the missing LIMIT are visible, and the bindings are the only
// place the 40 product keywords are.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite.
function d1Session(db: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  return {
    prepare: (sql: string) => {
      const entry: Prepared = { sql, params: [] };
      prepared.push(entry);
      const statement = (params: Bindable[]): unknown => ({
        bind: (...next: unknown[]) => {
          entry.params = next as Bindable[];
          return statement(next as Bindable[]);
        },
        first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
        run: async () => {
          db.prepare(sql).run(...params);
          return { success: true, meta: {} };
        },
      });
      return statement([]);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let sessionModes: unknown[];
let kv: Map<string, string>;

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: (mode: unknown) => {
        sessionModes.push(mode);
        return d1Session(db, prepared);
      },
    },
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
// Seeds. Only the columns this page reads are parameterised; every other NOT
// NULL column is filled with what the real migration insists on, so a seeded
// row is one production would have accepted.
// ---------------------------------------------------------------------------

function seedFoodbank(id: number, slug: string, name: string, postcode: string, latLng: string): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', ?, 'England', ?, 'Trussell',
       0, ?, ?, ?, 0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(
    id,
    String(id).padStart(32, "a"),
    name,
    slug,
    postcode,
    latLng,
    `info@${slug}.invalid`,
    `https://${slug}.invalid/`,
    `https://${slug}.invalid/list/`,
  );
}

// `created` is TEXT and both the ORDER BY and the 28-day window read it, so
// every fixture timestamp is written in Django's own spelling --
// "2026-09-05 19:28:08.853000", a space and six digits of microseconds, the
// form migrations/0022_normalise_timestamps.sql rewrote the stragglers into.
// One test deliberately writes the other spelling.
function seedNeed(o: { id: number; foodbankId: number; created: string; changeText: string; published?: 0 | 1 }): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, ?, ?, 'user', ?, ?)`,
  ).run(o.id, String(o.id).padStart(32, "f"), o.foodbankId, o.changeText, o.published ?? 1, o.created, o.created);
}

// THE FIXTURE IS THE TEST: each row turns exactly one rule on or off relative
// to its neighbour.
//
// Food banks -- postcodes chosen against the real london-postcodes.json:
//   1 salisbury-foodbank    SP1 1AA   plainly not London
//   2 vineyard              N1 7GU    London, and its slug is deliberately
//                                     NOTHING like its name, which is what
//                                     makes "the link uses the JOINED slug,
//                                     not a slugify() of the name" provable
//   3 westminster-foodbank  SW1A 1AA  NOT London by this file: it lists SW2
//                                     -SW20 but no SW1 at all, so Westminster
//                                     is excluded. Django excluded it too --
//                                     same file, same startswith -- and this
//                                     row is here so the day someone "fixes"
//                                     the match into a two-letter-area test,
//                                     a test fails rather than the tab
//                                     quietly doubling in size
//   4 hackney-foodbank      E1 6AN    London, but its need is 29 days old
//   5 bath-foodbank         BA1 1AA   not London, lowercase "soap" need
//
// Needs, listed by id rather than by date, each one carrying its own reason
// (the ordering they actually render in is asserted in the Everywhere block):
//   10 fb 2  07 Sep  CRLF line endings + London + apostrophe/ampersand name
//   11 fb 3  06 Sep  a duplicate line, a line matching two products at once,
//                    a substring match ("Razors"), and a non-product line
//   12 fb 1  05 Sep  the plain case, Django-shaped microsecond timestamp
//   13 fb 5  04 Sep  "soap" lowercase -- SQL LIKE matches, the JS filter does
//                    not, so this row renders with an EMPTY Needs cell
//   14 fb 4  10 Aug  29 days old: in both tables, out of the map payload
//   15 fb 1  03 Sep  no product keyword at all -- MUST NOT appear
//   16 fb 2  02 Sep  published = 0 -- MUST NOT appear
//   17 fb 999 06 Sep a need whose food bank row no longer exists -- MUST NOT
//                    appear: the query is an INNER JOIN, and widening it to a
//                    LEFT JOIN would put a row on the page with no name, no
//                    postcode and a link to /needs/at//
//
// The three rows that must not appear are stamped in the MIDDLE of the
// ordering rather than at the end, so a dropped WHERE clause or a widened JOIN
// shows up as a row in the body of the table where it is easy to see, not
// appended after it.
function seed(): void {
  seedFoodbank(1, "salisbury-foodbank", "Salisbury Foodbank", "SP1 1AA", "51.07,-1.79");
  seedFoodbank(2, "vineyard", "St. Mary's Foodbank & Pantry", "N1 7GU", "51.53,-0.10");
  seedFoodbank(3, "westminster-foodbank", "Westminster Foodbank", "SW1A 1AA", "51.50,-0.14");
  seedFoodbank(4, "hackney-foodbank", "Hackney Foodbank", "E1 6AN", "51.51,-0.07");
  seedFoodbank(5, "bath-foodbank", "Bath Foodbank", "BA1 1AA", "51.38,-2.36");

  seedNeed({ id: 10, foodbankId: 2, created: "2026-09-07 09:00:00.000000", changeText: "Soap\r\nBeans\r\nToothpaste\r\n" });
  seedNeed({ id: 11, foodbankId: 3, created: "2026-09-06 12:00:00.000000", changeText: "Shampoo\nShampoo\nMakeup and Make Up\nRazors\nPasta" });
  seedNeed({ id: 12, foodbankId: 1, created: "2026-09-05 19:28:08.853000", changeText: "Soap\nBeans\nToothpaste" });
  seedNeed({ id: 13, foodbankId: 5, created: "2026-09-04 09:00:00.000000", changeText: "50 tins of soap please" });
  seedNeed({ id: 14, foodbankId: 4, created: "2026-08-10 09:00:00.000000", changeText: "Toiletries" });
  seedNeed({ id: 15, foodbankId: 1, created: "2026-09-03 09:00:00.000000", changeText: "Beans\nPasta\nTinned tomatoes" });
  seedNeed({ id: 16, foodbankId: 2, created: "2026-09-02 09:00:00.000000", changeText: "Soap", published: 0 });
  seedNeed({ id: 17, foodbankId: 999, created: "2026-09-06 18:00:00.000000", changeText: "Soap for a deleted food bank" });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // schemaFor rather than hand-written DDL: the query JOINs foodbank to
  // foodbankchange, and foodbank_name_uniq / foodbank_slug_uniq / need_need_id_uniq
  // are real constraints this fixture has to keep satisfying.
  db.exec(schemaFor("foodbank", "foodbankchange"));
  seed();
  prepared = [];
  sessionModes = [];
  kv = new Map();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);
const getBody = async (path: string): Promise<string> => (await get(path)).text();
const dashboard = (): Promise<string> => getBody("/dashboard/beautybanks/");

// ---------------------------------------------------------------------------
// Reading the rendered page. Both tables are the same three columns, so the
// assertions can talk in food bank names, postcodes and need lines rather than
// in HTML.
// ---------------------------------------------------------------------------

interface NeedRow {
  href: string;
  name: string;
  postcode: string;
  needs: string[];
  found: string;
}

function tableRows(body: string, panel: "everywhere" | "london"): NeedRow[] {
  const start = body.indexOf(`id="${panel}-panel"`);
  if (start === -1) throw new Error(`no ${panel} panel in the rendered page`);
  const html = body.slice(start, body.indexOf("</table>", start));
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1] as string)
    // The header row is the one with <th> in it.
    .filter((tr) => !tr.includes("<th>"))
    .map((tr) => {
      const cells = [...tr.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1] as string);
      const first = cells[0] ?? "";
      return {
        href: /<a href="([^"]*)"/.exec(first)?.[1] ?? "",
        name: /<a [^>]*>([\s\S]*?)<\/a>/.exec(first)?.[1] ?? "",
        postcode: /<span class="is-size-7">([\s\S]*?)<\/span>/.exec(first)?.[1] ?? "",
        // The Needs cell is "line<br>line<br>", so the split leaves a trailing
        // empty string. Only genuinely empty pieces are dropped -- a line that
        // is nothing but a stray "\r" survives, which one test depends on.
        needs: (cells[1] ?? "").split("<br>").filter((line) => line !== ""),
        found: (cells[2] ?? "").trim(),
      };
    });
}

const names = (body: string, panel: "everywhere" | "london"): string[] => tableRows(body, panel).map((r) => r.name);

// The map payload, read back the way the browser reads it: the literal that
// `const foodbanks = {{ time_since_json|safe }};` puts in the page.
interface MapMarker {
  foodbank: string | null;
  slug: string;
  lat: number | null;
  lng: number | null;
  change_text: string;
}

function mapMarkers(body: string): MapMarker[] {
  const line = /const foodbanks = (.*);/.exec(body);
  if (!line) throw new Error("no `const foodbanks = ...` in the rendered page");
  return JSON.parse(line[1] as string) as MapMarker[];
}

// The Settings tab is two <h2>s each followed by a prose <p> and a
// comma-separated <p>: products first, London postcodes second.
function settingsLists(body: string): { products: string[]; postcodes: string[] } {
  const settings = body.slice(body.indexOf('id="settings-panel"'));
  const paragraphs = [...settings.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => (m[1] as string).trim());
  return { products: (paragraphs[1] ?? "").split(", "), postcodes: (paragraphs[3] ?? "").split(", ") };
}

describe("gfdashBeautybanks -- the response envelope", () => {
  it("serves the page as HTML with the food banks and their needs on it", async () => {
    const res = await get("/dashboard/beautybanks/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toContain("<h1>Beauty Banks Needs</h1>");
  });

  // A DELIBERATE PIN, AND A DIVERGENCE. Django's beautybanks() carried
  // @cache_page(SECONDS_IN_HOUR) (gfdash/views.py:244). middleware/
  // pageCacheControl.ts has no rule for /dashboard/, so this page falls
  // through to its SECONDS_IN_DAY default: the edge may hold a beauty-needs
  // dashboard for 24 hours where Django held it for one. Not this module's
  // decision -- pageCacheControl owns the rule table -- but this is the page
  // where the staleness is seen, so it is recorded here rather than nowhere.
  it("is cached for a DAY at the edge, not Django's hour (pinned divergence)", async () => {
    expect((await get("/dashboard/beautybanks/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
  });

  // ...and with no cache tag, cachePurge.ts cannot shorten that day. A new
  // beauty need published this morning is invisible here until the entry
  // expires. Same reasoning as routes/public/news.test.ts's equivalent pin:
  // suspect, not wrong, and owned by middleware/cacheTag.ts's AGGREGATE_PATHS.
  it("carries no cache tag, so a new need cannot purge it (suspect, pinned)", async () => {
    expect((await get("/dashboard/beautybanks/")).headers.get("Cache-Tag")).toBeNull();
  });

  // GET only. The route is registered with app.get; a stray app.all would let
  // a POST through to a handler whose response pageCacheControl then stamps
  // public for a day.
  it("does not answer a POST", async () => {
    expect((await get("/dashboard/beautybanks/", { method: "POST" })).status).toBe(404);
  });

  // lib/appendSlash.ts, matching Django's APPEND_SLASH.
  it("redirects the slashless spelling", async () => {
    const res = await get("/dashboard/beautybanks");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/dashboard/beautybanks/`);
  });

  // NOT TRANSLATED, and that matches Django exactly: givefood/urls.py:98
  // includes gfdash under a block the file itself labels "# Untranslated
  // apps", outside i18n_patterns, so /cy/dashboard/... never existed there
  // either. Asserted because the LOCALES loop in index.ts registers a prefixed
  // twin for most public pages, and this is one of the places it deliberately
  // does not.
  it("has no locale-prefixed twin", async () => {
    expect((await get("/cy/dashboard/beautybanks/")).status).toBe(404);
  });

  // A D1 outage must produce the 500 page, NOT a beauty-banks dashboard with
  // three empty tabs -- and above all must not be cached: pageCacheControl
  // only stamps 200s, so the s-maxage=86400 above cannot attach to this. A day
  // of edge-cached emptiness is the failure this guards.
  it("500s, uncached, when the database is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...env(),
      DB: {
        withSession: () => {
          throw new Error("D1_ERROR: network");
        },
      },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`${ORIGIN}/dashboard/beautybanks/`), broken, execCtx);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).not.toContain("Beauty Banks Needs");
  });

  // elapsedMs() reports WHOLE milliseconds, deliberately unlike Django's three
  // decimal places (see middleware/serverTiming.ts). A revert to toFixed(3)
  // would show up here as "Took 0.000ms".
  it("stamps the debug comment with a whole-millisecond render time", async () => {
    expect(/⏱️ Took (\S+)/.exec(await dashboard())?.[1]).toMatch(/^\d+ms$/);
  });

  // THE WIRING ITSELF. Every other test in this file goes through the real
  // app, which is the point -- but "the real app answers /dashboard/beautybanks/"
  // does not by itself prove the answer comes from THIS module: index.ts
  // imports 20 dashboard handlers with near-identical names and registers them
  // as 20 adjacent one-line calls, which is exactly the shape a copy-paste
  // slips through. Mounting the imported symbol on a bare Hono app (with the
  // real serverTiming, which elapsedMs reads) and comparing bodies is the
  // cheapest proof that the two are the same handler.
  it("is the handler the real app serves at /dashboard/beautybanks/", async () => {
    const direct = new Hono<AppEnv>();
    direct.use("*", serverTiming);
    direct.get("/dashboard/beautybanks/", gfdashBeautybanks);

    const viaApp = await dashboard();
    const viaExport = await (await direct.fetch(new Request(`${ORIGIN}/dashboard/beautybanks/`), env(), execCtx)).text();

    // Only the render-time comment can differ between two runs.
    const stripTiming = (html: string) => html.replace(/Took \d+ms/, "Took Nms");
    expect(stripTiming(viaExport)).toBe(stripTiming(viaApp));
    expect(viaExport).toContain("<h1>Beauty Banks Needs</h1>");
  });
});

describe("gfdashBeautybanks -- the one query", () => {
  // ONE SESSION, ONE STATEMENT, and the whole SQL text. Django ran THREE
  // queries here (all_needs, time_since_needs, london_needs) plus a fourth for
  // the London food bank list, and this port collapses them into one -- so
  // "how many statements" is the load-bearing fact, not an implementation
  // detail. The text is asserted whole because `published = 1`, the INNER JOIN
  // and the ORDER BY direction are each invisible in any other shape.
  //
  // f.name, NOT fc.foodbank_name: migration 0019 dropped the cached copy from
  // foodbankchange, and reading it is what 500'd this page on 2026-09-05
  // (packages/db/src/dashboards.ts records the incident).
  it("reads everything from a single prepared statement in one D1 session", async () => {
    await dashboard();

    expect(sessionModes).toEqual(["first-unconstrained"]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.sql).toBe(
      "SELECT fc.foodbank_id AS foodbank_id, f.name AS foodbank_name, f.slug AS foodbank_slug, " +
        "f.postcode AS postcode, f.lat_lng AS lat_lng, fc.change_text AS change_text, fc.created AS created " +
        "FROM foodbankchange fc JOIN foodbank f ON f.id = fc.foodbank_id " +
        "WHERE fc.published = 1 AND (" +
        Array(40).fill("fc.change_text LIKE ?").join(" OR ") +
        ") ORDER BY fc.created DESC",
    );
  });

  // THE 40 KEYWORDS, as they actually reach the engine. They appear nowhere in
  // the SQL text (40 anonymous `?`s) and only 5 of them appear on the fixture's
  // pages, so the bindings are the only place the list is checkable at all.
  //
  // "39" appears six times in this port's prose; the list is 40 long in both
  // the port and gfdash/views.py:247-288, compared element-by-element by
  // script. Pinning 40 keeps a future "tidy-up" from deleting one to match the
  // prose -- a deleted keyword is a whole class of need silently missing from
  // a dashboard nobody audits.
  it("binds all 40 product keywords as %contains% patterns, Django's list verbatim", async () => {
    await dashboard();

    expect(prepared[0]?.params).toHaveLength(40);
    expect(prepared[0]?.params).toEqual(BEAUTYBANKS_PRODUCTS.map((p) => `%${p}%`));
    expect(prepared[0]?.params.slice(0, 3)).toEqual(["%Soap%", "%Shampoo%", "%Shower Gel%"]);
    expect(prepared[0]?.params.at(-1)).toBe("%Makeup%");
  });

  // NO LIMIT IN THE SQL, deliberately and at a cost. Django's all_needs query
  // ended in [:50]; this one cannot, because the same result set also feeds
  // the London slice (whose rows may be far down the list) and the 28-day map
  // payload (which Django never limited either). So the Worker fetches EVERY
  // published need mentioning any of the 40 keywords and slices in JS.
  // Pinned rather than "fixed": it is the design packages/db/src/dashboards.ts
  // argues for, and it is also the reason this page's row count grows without
  // bound -- see the row-count test in the slices block.
  it("fetches the whole matching set, unlimited, newest first", async () => {
    await dashboard();

    expect(prepared[0]?.sql).not.toContain("LIMIT");
    expect(prepared[0]?.sql).toContain("ORDER BY fc.created DESC");
  });

  // The three rules that live in SQL rather than in JS, proved by their
  // victims: need 16 is published = 0, need 15 mentions no keyword, and need
  // 17's food bank does not exist. All three are dated in the MIDDLE of the
  // fixture, so any one of them leaking appears between visible rows rather
  // than after them, where the row count alone would have caught it.
  it("excludes unpublished needs, needs with no beauty product, and needs whose food bank is gone", async () => {
    const body = await dashboard();
    const rows = tableRows(body, "everywhere");

    // Need 15 is Salisbury's "Beans/Pasta/Tinned tomatoes" -- Salisbury still
    // appears once, for need 12, so this asserts the COUNT, not the absence of
    // the name.
    expect(rows.filter((r) => r.name === "Salisbury Foodbank")).toHaveLength(1);
    expect(body).not.toContain("Tinned tomatoes");
    // Need 16 is the vineyard's unpublished "Soap"; the vineyard appears once,
    // for need 10, whose lines are Soap and Toothpaste.
    expect(rows.filter((r) => r.name.startsWith("St. Mary"))).toHaveLength(1);
    // Need 17 points at a foodbank row that does not exist. The INNER JOIN is
    // what drops it -- foodbankchange.foodbank_id has no FK declared and is
    // nullable, so orphans are a real possibility rather than a hypothetical
    // one, and a LEFT JOIN would render this as a nameless row linking to
    // /needs/at//.
    expect(body).not.toContain("deleted food bank");
    expect(rows).toHaveLength(5);
  });
});

describe("gfdashBeautybanks -- the Everywhere tab", () => {
  // EVERY FIELD mapNeedRow() PRODUCES, ON ONE ROW, in one assertion:
  //   href      url('wfbn:foodbank', foodbank_slug) -- the REAL joined slug.
  //             "vineyard" is nothing like slugify("St. Mary's Foodbank &
  //             Pantry"), so a port that followed Django's own
  //             need.foodbank_name_slug guess would emit
  //             /needs/at/st-marys-foodbank-pantry/ here and 404 the visitor.
  //   name      the JOINED foodbank.name, autoescaped by nunjucks
  //   postcode  the JOINED foodbank.postcode
  //   needs     filteredChangeLines -- Soap and Toothpaste kept, Beans dropped
  //   found     timesince(parseD1Timestamp(created), now) with U+00A0 inside
  //             each unit, Django's avoid_wrapping
  it("renders a need with the real joined slug, the food bank's postcode and its filtered lines", async () => {
    const rows = tableRows(await dashboard(), "everywhere");

    expect(rows[2]).toEqual({
      href: "/needs/at/salisbury-foodbank/",
      name: "Salisbury Foodbank",
      postcode: "SP1 1AA",
      needs: ["Soap", "Toothpaste"],
      found: `2${NBSP}days, 14${NBSP}hours ago`,
    });
    // The row above it is the one whose slug cannot be guessed from its name.
    expect(rows[0]?.href).toBe("/needs/at/vineyard/");
    expect(rows[0]?.name).toBe("St. Mary&#39;s Foodbank &amp; Pantry");
  });

  // NEWEST FIRST, straight from the SQL, and the ONLY place the fixture's full
  // eligible set is listed in order. Need 14 is 29 days old and still here:
  // the 28-day window applies to the MAP, not to this table (Django's
  // all_needs had no date filter either), so a handler that filtered the table
  // by it would silently shorten this list.
  it("lists every eligible need newest first, with no date window", async () => {
    expect(names(await dashboard(), "everywhere")).toEqual([
      "St. Mary&#39;s Foodbank &amp; Pantry", // 07 Sep
      "Westminster Foodbank", //                06 Sep
      "Salisbury Foodbank", //                  05 Sep
      "Bath Foodbank", //                       04 Sep
      "Hackney Foodbank", //                    10 Aug -- 29 days, still listed
    ]);
  });

  // The "ago" is in the TEMPLATE, not in created_timesince, so the column
  // reads "2 days, 14 hours ago". Asserted once, on the cell as rendered,
  // because a template that dropped it would leave a bare duration that reads
  // like a countdown.
  it("labels the Found column as elapsed time", async () => {
    const body = await dashboard();
    expect(body).toContain(`<td>2${NBSP}days, 14${NBSP}hours ago</td>`);
    expect(body).toContain(`<td>4${NBSP}weeks, 1${NBSP}day ago</td>`);
  });
});

describe("gfdashBeautybanks -- the London tab", () => {
  // THE WHOLE POINT OF THE TAB. Three of the five fixture food banks are
  // outside the list and one is inside it twice over:
  //   N1 7GU   matches prefix "N1"   -> in
  //   E1 6AN   matches prefix "E1"   -> in
  //   SP1 1AA  no prefix             -> out
  //   BA1 1AA  no prefix             -> out
  //   SW1A 1AA no prefix: the file has SW2-SW20 but NO SW1 -> out, even though
  //            Westminster is about as central as London gets. Django's file
  //            is the same file and Django's startswith gave the same answer,
  //            so this is parity, not a port bug -- but it is the single most
  //            surprising row on the page and it is pinned so that "fixing" it
  //            has to be a deliberate act.
  it("keeps only food banks whose postcode starts with a listed London prefix", async () => {
    expect(names(await dashboard(), "london")).toEqual([
      "St. Mary&#39;s Foodbank &amp; Pantry", // N1
      "Hackney Foodbank", //                     E1
    ]);
  });

  // The London rows are the SAME mapNeedRow() output as the Everywhere ones --
  // same slug, same filtered lines, same timesince -- not a second, thinner
  // mapping. Worth one assertion because the two tables are separate template
  // blocks that could drift.
  it("renders London rows through the same mapping as the Everywhere tab", async () => {
    const body = await dashboard();
    const london = tableRows(body, "london");
    const everywhere = tableRows(body, "everywhere");

    expect(london[0]).toEqual(everywhere[0]);
    expect(london[1]).toEqual(everywhere[4]);
  });

  // CASE-SENSITIVE, matching Django's `postcode__startswith` (which Postgres
  // implements as a case-sensitive LIKE; `istartswith` is the other one). A
  // lowercased postcode therefore drops out of the London tab while staying in
  // the Everywhere one. Pinned as behaviour rather than reported as a bug: the
  // postcodes this fixture is modelled on are stored uppercase, and matching
  // Django is the contract. It is asserted because `.toUpperCase()` looks like
  // an obvious tidy-up until you notice it changes which rows a dashboard
  // shows.
  it("does not match a lowercased postcode", async () => {
    db.prepare("UPDATE foodbank SET postcode = 'n1 7gu' WHERE id = 2").run();

    const body = await dashboard();
    expect(names(body, "london")).toEqual(["Hackney Foodbank"]);
    expect(names(body, "everywhere")).toContain("St. Mary&#39;s Foodbank &amp; Pantry");
  });

  // A PREFIX, NOT A CONTAINS. "1 High Street, DA14" or a postcode with a
  // London area buried in it must not qualify -- startsWith is the whole rule.
  it("does not match a London prefix that appears later in the postcode", async () => {
    db.prepare("UPDATE foodbank SET postcode = 'XN1 7GU' WHERE id = 2").run();

    expect(names(await dashboard(), "london")).toEqual(["Hackney Foodbank"]);
  });
});

describe("gfdashBeautybanks -- filtered change lines", () => {
  // filter_change_text() (givefood/utils/text.py:138-148): keep the lines that
  // mention a product, dedupe them, drop the rest. Four rules in one fixture
  // row (need 11):
  //   "Shampoo" twice        -> ONE line out (Django's set(), the port's Set)
  //   "Makeup and Make Up"   -> ONE line out, not two, though it matches two
  //                             products (the port's `some` short-circuits;
  //                             Django's inner loop adds to a set)
  //   "Razors"               -> kept: a SUBSTRING match, same as Python's `in`
  //   "Pasta"                -> dropped
  // INSERTION ORDER is the port's deliberate divergence: Django joined a
  // plain set() in arbitrary hash order, so line order on that page was
  // unstable. Pinned here because insertion order is the thing a future
  // "just use a Set of a Set" refactor would lose.
  it("keeps one copy of each matching line, in the order they appear", async () => {
    const westminster = tableRows(await dashboard(), "everywhere").find((r) => r.name === "Westminster Foodbank");

    expect(westminster?.needs).toEqual(["Shampoo", "Makeup and Make Up", "Razors"]);
  });

  // THE MOST SUSPECT BEHAVIOUR ON THIS PAGE, pinned exactly as it is.
  //
  // The SQL match and the JS match disagree about case. SQLite's LIKE is
  // ASCII-case-insensitive (verified directly with node:sqlite), so
  // `change_text LIKE '%Soap%'` returns "50 tins of soap please"; then
  // filteredChangeLines uses String.includes, which is case-SENSITIVE, and
  // keeps none of its lines. The row therefore renders with the food bank's
  // name, its postcode, its date -- and a completely EMPTY Needs cell, which
  // looks like a data problem at the food bank rather than a mismatch here.
  //
  // Django could not produce this row at all: its `__contains` is
  // case-sensitive on Postgres, so the row was never selected. This is a real
  // port divergence introduced by the engine, not by the code, which is why
  // it survived review -- and why it is pinned rather than quietly "fixed"
  // here (fixing it means choosing WHICH side to move, and that is not a test's
  // decision).
  it("renders an empty Needs cell for a row SQLite matched case-insensitively (suspect)", async () => {
    const bath = tableRows(await dashboard(), "everywhere").find((r) => r.name === "Bath Foodbank");

    expect(bath).toEqual({
      href: "/needs/at/bath-foodbank/",
      name: "Bath Foodbank",
      postcode: "BA1 1AA",
      needs: [],
      found: `4${NBSP}days ago`,
    });
    // ...and the same row reaches the map with an empty popup.
    expect(mapMarkers(await dashboard()).find((m) => m.slug === "bath-foodbank")?.change_text).toBe("");
  });

  // CRLF, AND A SECOND SUSPECT. Django split with str.splitlines(), which
  // treats "\r\n" (and a lone "\r") as a line break; the port splits on "\n"
  // only, so every line of a CRLF-stored change_text keeps a trailing "\r".
  // Invisible in the table -- HTML collapses it -- but NOT invisible in the
  // map payload, where JSON.stringify writes it out as a literal \r, and not
  // invisible to the dedupe: "Soap\r" and "Soap" are two different Set
  // entries, so the same line stored both ways would render twice.
  //
  // CRLF in this dataset is not hypothetical: 0001_core.sql records that 1,066
  // of 1,071 foodbank.address values contain \r\n.
  it("leaves a trailing carriage return on every line of a CRLF change_text (suspect)", async () => {
    const body = await dashboard();
    const vineyard = tableRows(body, "everywhere")[0];

    expect(vineyard?.needs).toEqual(["Soap\r", "Toothpaste\r"]);
    expect(mapMarkers(body)[0]?.change_text).toBe("Soap\r\nToothpaste\r");
  });

  // A need whose text mentions a product only inside a longer word still
  // counts, both in SQL (%Soap%) and in JS (includes) -- the two agree here,
  // and the page shows the whole line, not the matched word.
  it("keeps the whole line, not the matched keyword", async () => {
    seedNeed({ id: 20, foodbankId: 1, created: "2026-09-08 08:00:00.000000", changeText: "Please bring Soap powder and nappies" });

    expect(tableRows(await dashboard(), "everywhere")[0]?.needs).toEqual(["Please bring Soap powder and nappies"]);
  });
});

describe("gfdashBeautybanks -- the 28-day map payload", () => {
  // WHAT THE MAP ACTUALLY GETS, field by field. lat/lng are Number()s split
  // out of the joined foodbank.lat_lng ("51.53,-0.10"), which is the only
  // place in this handler a string becomes a number -- transpose them and
  // every marker lands in the Indian Ocean, which no assertion on shape would
  // notice. change_text is the JOINED filtered lines (Django's
  // filtered_change_text was a joined string too), not the array the table
  // gets.
  it("emits one marker per recent need, with the coordinates split out of lat_lng", async () => {
    expect(mapMarkers(await dashboard())[0]).toEqual({
      foodbank: "St. Mary's Foodbank & Pantry",
      slug: "vineyard",
      lat: 51.53,
      lng: -0.1,
      change_text: "Soap\r\nToothpaste\r",
    });
  });

  // THE WINDOW ITSELF. Need 14 (10 Aug, 29 days old) is in both tables and
  // must NOT be on the map -- the map's own caption says "in the last 28
  // days". A window that silently stopped filtering would put a month-old need
  // on it, and one marker looks exactly like another.
  it("drops a need older than 28 days that both tables still show", async () => {
    const body = await dashboard();

    expect(names(body, "everywhere")).toContain("Hackney Foodbank");
    expect(mapMarkers(body).map((m) => m.slug)).toEqual(["vineyard", "westminster-foodbank", "salisbury-foodbank", "bath-foodbank"]);
  });

  // THE BOUNDARY IS STRICTLY GREATER THAN. now - 28d is exactly
  // 2026-08-11T09:30:00Z; a need created at that instant is OUT, one a second
  // later is IN. Both rows are seeded at once so an off-by-one in either
  // direction moves exactly one of them.
  it("excludes a need created exactly 28 days ago and includes one a second later", async () => {
    seedNeed({ id: 21, foodbankId: 1, created: "2026-08-11 09:30:00.000000", changeText: "Soap on the boundary" });
    seedNeed({ id: 22, foodbankId: 5, created: "2026-08-11 09:30:01.000000", changeText: "Soap just inside" });

    const changeTexts = mapMarkers(await dashboard()).map((m) => m.change_text);
    expect(changeTexts).toContain("Soap just inside");
    expect(changeTexts).not.toContain("Soap on the boundary");
  });

  // THE MAP IS NOT CAPPED AT 50 while the tables are -- Django's
  // time_since_needs had no slice either. Asserted with 60 recent needs: 50
  // rows in the table, 60 markers on the map. A cap accidentally applied to
  // the payload would quietly hide a third of the country.
  it("is not subject to the tables' 50-row cap", async () => {
    db.exec("DELETE FROM foodbankchange");
    for (let i = 0; i < 60; i += 1) {
      seedNeed({ id: 100 + i, foodbankId: 1, created: `2026-09-01 0${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}:00.000000`, changeText: `Soap batch ${i}` });
    }

    const body = await dashboard();
    expect(tableRows(body, "everywhere")).toHaveLength(50);
    expect(mapMarkers(body)).toHaveLength(60);
  });

  // A BAD lat_lng BECOMES null, null -- NOT an error and NOT a dropped marker.
  // Number("bad") is NaN and JSON.stringify writes NaN as null, so the payload
  // stays valid JSON and maplibre gets a Point with null coordinates. Pinned
  // because it is the difference between one broken marker and a map that
  // throws on load and renders nothing at all; whether maplibre survives it is
  // not something this test can settle (it is not exercised here).
  it("writes null coordinates for an unparseable lat_lng rather than skipping the marker (suspect)", async () => {
    db.prepare("UPDATE foodbank SET lat_lng = 'not,coordinates' WHERE id = 2").run();

    const marker = mapMarkers(await dashboard())[0];
    expect(marker).toEqual({ foodbank: "St. Mary's Foodbank & Pantry", slug: "vineyard", lat: null, lng: null, change_text: "Soap\r\nToothpaste\r" });
  });

  // THE PAYLOAD IS EMITTED THROUGH |safe, so nothing in it is HTML-escaped --
  // and JSON.stringify escapes quotes and backslashes but NOT "<". A need
  // whose text contains "</script>" therefore closes the page's own script
  // block from inside a JS string literal, and everything after it is parsed
  // as HTML. change_text is crawler- and LLM-sourced, so this is reachable
  // without an admin doing anything.
  //
  // Django did exactly the same thing (json.dumps + |safe, gfdash/templates/
  // dash/beautybanks.html:125), so this is INHERITED, not introduced -- which
  // is why the test pins it instead of asserting the escaping one would want.
  // The contrast in the same assertion is the useful part: the identical text
  // IS escaped in the table cell, so the page proves it knows how.
  it("emits change_text into the <script> block unescaped (inherited from Django, suspect)", async () => {
    seedNeed({ id: 23, foodbankId: 1, created: "2026-09-08 08:00:00.000000", changeText: "Soap </script><script>alert(1)</script>" });

    const body = await dashboard();
    expect(body).toContain('{"foodbank":"Salisbury Foodbank","slug":"salisbury-foodbank","lat":51.07,"lng":-1.79,"change_text":"Soap </script><script>alert(1)</script>"}');
    // ...while the table cell for the same need escapes it.
    expect(body).toContain("Soap &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;<br>");
  });
});

describe("gfdashBeautybanks -- the two 50-row slices", () => {
  // THE SLICES ARE OVER DIFFERENT POPULATIONS, and this is the test that
  // proves it. 51 fresh Salisbury needs push the single London need down to
  // 52nd place overall; the Everywhere tab correctly cannot show it, and the
  // London tab MUST. A handler that filtered `needs.slice(0, 50)` for London
  // -- the obvious, wrong simplification, and the one Django's separate query
  // made impossible -- would render an empty London tab here, which reads as
  // "no beauty needs in London" rather than as a bug.
  it("computes London over the whole result set, not over the first 50 rows", async () => {
    db.exec("DELETE FROM foodbankchange");
    seedNeed({ id: 200, foodbankId: 2, created: "2026-09-01 09:00:00.000000", changeText: "Soap for London" });
    for (let i = 0; i < 51; i += 1) {
      seedNeed({ id: 300 + i, foodbankId: 1, created: `2026-09-02 ${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00.000000`, changeText: `Soap ${i}` });
    }

    const body = await dashboard();
    const everywhere = tableRows(body, "everywhere");
    expect(everywhere).toHaveLength(50);
    expect(everywhere.every((r) => r.name === "Salisbury Foodbank")).toBe(true);
    expect(tableRows(body, "london")).toHaveLength(1);
    expect(tableRows(body, "london")[0]?.needs).toEqual(["Soap for London"]);
  });

  // ALL_NEEDS_LIMIT is 50 and drops the OLDEST, not the newest. Seeded 51
  // rows one minute apart, so the row that must survive and the row that must
  // not are adjacent -- an off-by-one shows up as the wrong pair.
  it("keeps the newest 50 and drops the 51st", async () => {
    db.exec("DELETE FROM foodbankchange");
    for (let i = 0; i < 51; i += 1) {
      seedNeed({ id: 400 + i, foodbankId: 1, created: `2026-09-02 12:${String(i).padStart(2, "0")}:00.000000`, changeText: `Soap number ${i}` });
    }

    const rows = tableRows(await dashboard(), "everywhere");
    expect(rows).toHaveLength(50);
    expect(rows[0]?.needs).toEqual(["Soap number 50"]);
    expect(rows[49]?.needs).toEqual(["Soap number 1"]);
    // "Soap number 0" is the 51st and is gone.
    expect(rows.map((r) => r.needs[0])).not.toContain("Soap number 0");
  });

  // LONDON_NEEDS_LIMIT is its own constant with its own 50. They are equal
  // today, so a handler that reused ALL_NEEDS_LIMIT for both would pass every
  // other test in this file; this one at least pins the value London actually
  // gets.
  it("caps the London tab at 50 of its own", async () => {
    db.exec("DELETE FROM foodbankchange");
    for (let i = 0; i < 51; i += 1) {
      seedNeed({ id: 500 + i, foodbankId: 2, created: `2026-09-02 12:${String(i).padStart(2, "0")}:00.000000`, changeText: `Soap london ${i}` });
    }

    const body = await dashboard();
    expect(tableRows(body, "london")).toHaveLength(50);
    expect(tableRows(body, "london")[0]?.needs).toEqual(["Soap london 50"]);
    // Both tables hold the same 50 rows when every need is a London one --
    // which is what makes the previous test's divergence meaningful.
    expect(tableRows(body, "everywhere")).toHaveLength(50);
  });
});

describe("gfdashBeautybanks -- timestamps are TEXT", () => {
  // ORDER BY fc.created DESC IS A STRING COMPARISON. 'T' is 0x54 and ' ' is
  // 0x20, so an ISO-spelled row sorts above EVERY Django-spelled row on the
  // same date, whatever the actual times are: the 12:00 ISO row below beats
  // the 23:00 Django row by eleven hours in the wrong direction.
  //
  // Pinned, not fixed. migrations/0022_normalise_timestamps.sql exists exactly
  // to keep ISO-spelled rows out of this column, and this test is what makes
  // the consequence of that migration lapsing visible on this page rather than
  // just in a migration file.
  it("sorts an ISO-spelled created above same-day Django-spelled rows (pinned)", async () => {
    db.exec("DELETE FROM foodbankchange");
    seedNeed({ id: 600, foodbankId: 1, created: "2026-09-06 23:00:00.000000", changeText: "Soap django late" });
    seedNeed({ id: 601, foodbankId: 2, created: "2026-09-06T12:00:00.000Z", changeText: "Soap iso early" });
    seedNeed({ id: 602, foodbankId: 5, created: "2026-09-06 08:00:00.000000", changeText: "Soap django early" });

    expect(tableRows(await dashboard(), "everywhere").map((r) => r.needs[0])).toEqual([
      "Soap iso early", //     12:00, but sorted first by 'T'
      "Soap django late", //   23:00
      "Soap django early", //  08:00
    ]);
  });

  // ...while the 28-day window and the timesince column read the SAME column
  // through parseD1Timestamp, which handles both spellings (and strips a
  // trailing Z rather than appending a second one -- the "...ZZ" -> Invalid
  // Date bug lib/isoWeek.ts's comment records as ticket #7). So the ISO row is
  // mis-SORTED but correctly DATED, which is why the mis-sort is so easy to
  // miss.
  it("still dates an ISO-spelled row correctly in both the table and the map", async () => {
    db.exec("DELETE FROM foodbankchange");
    seedNeed({ id: 610, foodbankId: 1, created: "2026-09-06T12:00:00.000Z", changeText: "Soap iso" });

    const body = await dashboard();
    expect(tableRows(body, "everywhere")[0]?.found).toBe(`1${NBSP}day, 21${NBSP}hours ago`);
    expect(mapMarkers(body)).toHaveLength(1);
  });

  // A DATE WITH NO TIME IS REAL DATA -- lib/timesince.ts's own comment records
  // a production 500 caused by one. Read as UTC midnight by both
  // parseD1Timestamp and timesince's parseUtc, so the row dates and windows
  // correctly rather than becoming an Invalid Date and vanishing from the map.
  it("reads a date-only created as UTC midnight", async () => {
    db.exec("DELETE FROM foodbankchange");
    seedNeed({ id: 620, foodbankId: 1, created: "2026-09-07", changeText: "Soap dateless" });

    const body = await dashboard();
    expect(tableRows(body, "everywhere")[0]?.found).toBe(`1${NBSP}day, 9${NBSP}hours ago`);
    expect(mapMarkers(body)).toHaveLength(1);
  });

  // A FUTURE created (clock skew on an import, or an editor's typo) does not
  // throw and does not render a negative age: Django's timesince returns
  // "0 minutes" for any non-positive interval and so does the port, so the
  // column reads "0 minutes ago".
  it("shows 0 minutes for a need dated in the future", async () => {
    db.exec("DELETE FROM foodbankchange");
    seedNeed({ id: 630, foodbankId: 1, created: "2027-01-01 00:00:00.000000", changeText: "Soap from the future" });

    expect(tableRows(await dashboard(), "everywhere")[0]?.found).toBe(`0${NBSP}minutes ago`);
  });
});

describe("gfdashBeautybanks -- the Settings tab", () => {
  // The Settings tab is the page's own documentation of what it filters on,
  // and it is rendered from the SAME two constants the filtering uses -- so if
  // it says 40 products and 255 postcodes, those are the 40 and the 255 that
  // ran. A settings tab fed from a second, stale copy of either list would be
  // worse than none.
  it("lists the 40 product keywords the query actually bound", async () => {
    const { products } = settingsLists(await dashboard());

    expect(products).toHaveLength(40);
    expect(products).toEqual([...BEAUTYBANKS_PRODUCTS]);
    expect(products[0]).toBe("Soap");
    expect(products.at(-1)).toBe("Makeup");
  });

  // 255, NOT the 254 the module's comment claims: givefood/data/london_
  // postcodes.txt has 254 newlines and no trailing one, so Python's
  // .splitlines() yields 255 -- compared entry-for-entry with the JSON by
  // script, identical and in the same order. The absent "SW1" is asserted
  // explicitly because it is the entry whose absence changes the page (see the
  // Westminster row in the London tab).
  it("lists all 255 London postcode prefixes, SW1 genuinely not among them", async () => {
    const { postcodes } = settingsLists(await dashboard());

    expect(postcodes).toHaveLength(255);
    expect(postcodes).toEqual(LONDON_POSTCODES as string[]);
    expect(postcodes[0]).toBe("BR1");
    expect(postcodes.at(-1)).toBe("WC2H");
    expect(postcodes).toContain("SW2");
    expect(postcodes).not.toContain("SW1");
  });
});
