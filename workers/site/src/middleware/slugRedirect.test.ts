import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import realApp from "../index";
import { slugRedirect } from "./slugRedirect";
import { PREFIXES } from "./resolveLanguage";
import type { AppEnv } from "../types";
import type { Env } from "../../worker-configuration";

// The port of givefood/middleware.py:157-199 SlugRedirectMiddleware -- the one
// thing standing between a food bank that has been renamed in the admin and
// every inbound link, bookmark, QR code and search result that still names its
// old slug.
//
// WHY THIS FILE IS WORTH ITS LENGTH. Every way this middleware can be wrong is
// invisible from the outside:
//
//   * It fails OPEN by design (a D1 error means "no redirect"), so a broken
//     read path looks exactly like a food bank that was never renamed -- a
//     404, at a URL that used to work, with nothing in the response saying
//     why. The module's own header records the last time that happened: 57
//     rows were loaded into the table on 2026-09-05 and every one of them
//     404'd, because the KV blob the middleware actually read had not been
//     rewritten. Loading the table was not the same as writing the blob.
//   * It succeeds LOUDLY in the wrong direction: the response is a 301, the
//     one status a browser and a CDN are both entitled to remember. A wrong
//     Location here is not a bad page load, it is a bad page load that
//     persists after the row is fixed.
//   * The lookup is memoised in module state for five minutes, so "does it
//     read the database" and "does it read the CURRENT database" are separate
//     questions with separate answers, and only one of them is what a single
//     assertion about a single request measures.
//
// So nothing here stops at a status code. Every redirect assertion names the
// exact Location; every fall-through assertion proves the terminal handler ran
// (the middleware's own claim that a miss costs the request nothing); and the
// prepared-SQL recorder below is what turns "it did not redirect" into either
// "it looked and found nothing" or "it never looked", which are different
// bugs.
//
// REAL EVERYTHING. The database is node:sqlite over the real
// migrations/0016_slugredirect.sql (via schemaFor, so a column added tomorrow
// arrives here), the query is packages/db's real getSlugRedirectMap, the
// prefix set is the real PREFIXES derived from the real LOCALES, and the last
// describe block drives index.ts's own default export so the middleware's
// position in the chain -- above resolveLanguage, above every route -- is
// asserted rather than assumed.

// ============================ the Django original ============================
//
// givefood/middleware.py:177:
//     pattern = r'^(/[a-z]{2})?/needs/at/([-\w]+)(/[-\w]+)?/?$'
// and this module's line 46:
//     `^(/(?:${PREFIX_PATTERN}))?/needs/at/([-\\w]+)(/[-\\w]+)?/?$`
//
// The bodies are otherwise the same shape, deliberately: same three capture
// groups, same "strip the slashes off the subpath", same
// `f"{lang_prefix}/needs/at/{new_slug}/"`, same 301
// (middleware.py:197's `redirect(new_path, permanent=True)`).
//
// The prefix half is a DECLARED behaviour change, not a slip, and the tests
// that cover it say so where they sit. Regex semantics below were checked by
// running CPython 3.13.0 on this machine on 2026-09-08 -- not against a
// running Django instance, so nothing here claims a live-verified response:
//
//     re.match(pattern, '/de/needs/at/durham/')  -> ('/de', 'durham', None)
//     re.match(pattern, '/zh-hans/needs/at/durham/') -> None
//     re.match(pattern, '/tlh/needs/at/durham/') -> None
//     re.match(pattern, '/needs/at/café/') -> (None, 'café', None)
//     '/news'.strip('/') -> 'news'
//
// i.e. Django matches ANY two lowercase letters (so /de/ and /es/ redirect
// there and not here) and CANNOT match its own multi-character locales
// (/zh-hans/, /tlh/), which is the bug the module header names. Python's `\w`
// is Unicode-aware, so an accented old_slug matches there; JavaScript's is
// ASCII-only and `url.pathname` is percent-encoded besides, so it cannot.

const ORIGIN = "https://www.givefood.org.uk";
const url = (path: string) => `${ORIGIN}${path}`;

// slugRedirect.ts:40's MEMO_TTL_MS, restated rather than imported (it is
// module-private, and it should have to be changed twice, on purpose, in a
// diff that shows both). The module's header forbids shortening it -- "it
// would put a D1 query on the hot path of the site's highest-traffic page
// family" -- so the number itself is part of the contract, not an
// implementation detail.
const MEMO_TTL_MS = 300_000;

// The whole real DDL for the one table this reads: three objects (the table
// and both indexes), taken from the migrations by the engine rather than
// pasted. Pasted DDL is how eight suites came to lack an object a shared query
// had started reading (schema.testkit.ts's own header, github #51).
const SCHEMA = schemaFor("slugredirect");

// Django's `str(datetime)` -- "YYYY-MM-DD HH:MM:SS.ffffff", what the ETL wrote
// into these 57 rows and what pyNow() writes on every admin save. Not
// load-bearing for THIS module (getSlugRedirectMap has no ORDER BY and reads
// every row), but seeding a shape the real table cannot contain is how a
// fixture stops being evidence, and a `toISOString()` value here would sort
// above every Django-format value from the same day if a future read ever did
// order (packages/models/src/pyDatetime.ts, ticket #9).
const CREATED = "2026-09-05 19:28:08.853000";

type Bindable = null | number | bigint | string | Uint8Array;

let db: DatabaseSync;

// Every SQL string this middleware has asked D1 to prepare, and every
// consistency mode it has asked withSession() for, since the current test
// began. A passthrough recorder, not a stand-in: the statement still runs
// against the real engine.
//
// These two arrays carry assertions nothing else in the file can make. The
// module's central performance claim is a NEGATIVE -- "the lookup is NOT on
// every request despite the '*' mount ... one query per isolate per 5 minutes,
// not one per request" -- and a negative about work not done is invisible in
// the response. A middleware that read D1 on every single request would pass
// every redirect test in this file.
const prepared: string[] = [];
const sessionModes: string[] = [];

// The D1 Sessions-API surface packages/db actually uses, over node:sqlite.
// Copied from routes/admin/slugRedirect.test.ts rather than reinvented, so the
// two suites that exercise the same table agree about what D1 does.
function d1Session(database: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (database.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      database.prepare(sql).run(...params);
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

let env: Env;

// The binding missing altogether -- `c.env.DB.withSession` on undefined. Not a
// contrived input: it is exactly what index.test.ts's requests see, and what a
// Worker deployed with a wrangler.jsonc missing the d1_databases entry would
// see on its first request in production.
const NO_DB_ENV = {} as unknown as Env;

/** A binding whose session is fine to create but whose query rejects -- a D1 outage, mid-request. */
function brokenQueryEnv(message: string): Env {
  return {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return {
          prepare: (sql: string) => {
            prepared.push(sql);
            return {
              bind: () => ({ all: async () => Promise.reject(new Error(message)) }),
              all: async () => Promise.reject(new Error(message)),
            };
          },
        } as unknown as D1DatabaseSession;
      },
    },
  } as unknown as Env;
}

// The middleware with nothing else in the way, over a terminal handler that
// echoes the path it was reached with. Echoing rather than returning a
// constant matters: "the request fell through" and "the request fell through
// unmodified" are different claims, and this middleware's contract is that a
// non-matching or non-redirecting request reaches the router exactly as it
// arrived.
const rigApp = new Hono<AppEnv>();
rigApp.use("*", slugRedirect);
rigApp.all("*", (c) => c.text(`handler:${new URL(c.req.url).pathname}`));

async function req(path: string, method = "GET", bindings: Env = env) {
  const res = await rigApp.request(url(path), { method }, bindings);
  return {
    status: res.status,
    location: res.headers.get("Location"),
    body: await res.text(),
  };
}

/** Seeds one row exactly as the admin's upsertSlugRedirect would. */
function seed(oldSlug: string, newSlug: string) {
  db.prepare("INSERT INTO slugredirect (old_slug, new_slug, created, modified) VALUES (?, ?, ?, ?)").run(
    oldSlug,
    newSlug,
    CREATED,
    CREATED,
  );
}

// The `memo` this module keeps is MODULE state: one copy shared by every test
// in this file that imports the same module instance, exactly as one warm
// isolate shares it across every request it serves. That is the thing being
// tested, so it must not also be an accident between tests -- a map memoised
// by test A would otherwise answer test B's requests out of a database B never
// wrote.
//
// Faking Date (only Date -- setTimeout and friends stay real, so nothing in
// the render path can hang) and jumping the clock an hour before each test
// makes every test start with a memo that is provably stale, which is both the
// isolation this file needs and the honest model of a cold isolate. The TTL
// tests below move the clock deliberately inside their own test.
let now = Date.parse("2026-09-05T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  now += 3_600_000;
  vi.setSystemTime(now);

  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepared.length = 0;
  sessionModes.length = 0;

  env = {
    DB: {
      withSession: (mode: string) => {
        sessionModes.push(mode);
        return d1Session(db);
      },
    },
    // Not read by this middleware; present because the real app's
    // /register-foodbank/ logs a line without it, and the real-app block
    // below shares this object.
    CSRF_SECRET: "test-csrf-secret",
  } as unknown as Env;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

// ===================== what actually gets redirected =====================

describe("slugRedirect: the redirect itself", () => {
  it("301s a renamed food bank's page to the new slug", async () => {
    // The whole point of the module, and the one case a reviewer would check
    // by hand. 301 and not 302: middleware.py:197 passes permanent=True, and
    // the difference is whether search engines transfer the old URL's standing
    // to the new one -- a food bank that has been renamed wants them to.
    seed("durham", "county-durham");

    expect(await req("/needs/at/durham/")).toEqual({
      status: 301,
      location: "/needs/at/county-durham/",
      // A redirect has no body. Asserted because c.redirect() builds the
      // response itself and a handler that also ran would be the symptom of
      // the middleware forgetting to return.
      body: "",
    });
  });

  it("keeps the subpage, and normalises it to a trailing slash", async () => {
    // Django: `subpage = subpath.strip('/')` then
    // `f"{lang_prefix}/needs/at/{new_slug}/{subpage}/"` (middleware.py:184,
    // 193-194). Both spellings of the incoming URL -- with and without the
    // trailing slash -- come out slashed, because the slash is written by the
    // template, not carried over from the request. That is what keeps the
    // redirect target on APPEND_SLASH's good side: sending a browser to
    // "/needs/at/county-durham/news" would earn it a second redirect from
    // index.ts's notFound handler.
    seed("durham", "county-durham");

    expect(await req("/needs/at/durham/news/")).toMatchObject({
      status: 301,
      location: "/needs/at/county-durham/news/",
    });
    expect(await req("/needs/at/durham/news")).toMatchObject({
      status: 301,
      location: "/needs/at/county-durham/news/",
    });
  });

  it("adds the trailing slash to a slug-only URL too", async () => {
    // "/needs/at/durham" (no slash) is a real inbound shape -- hand-typed
    // links and some link shorteners drop it -- and the regex's `/?$` accepts
    // it. One redirect, straight to the canonical slashed form, rather than a
    // 301 to an unslashed URL that then 301s again.
    seed("durham", "county-durham");

    expect(await req("/needs/at/durham")).toMatchObject({
      status: 301,
      location: "/needs/at/county-durham/",
    });
  });

  it("preserves the language prefix, for every locale the site serves", async () => {
    // Driven off PREFIXES, never a literal ["cy","ga","gd"]: the module builds
    // its regex from that same set, so a fourth language must be redirected
    // here without this file being edited. A Welsh visitor following an old
    // link must land on the Welsh page, not be dumped into English -- which is
    // what dropping match group 1 would do, silently, on a page nobody
    // reviewing English URLs would look at.
    seed("durham", "county-durham");

    for (const prefix of PREFIXES) {
      expect(await req(`/${prefix}/needs/at/durham/`), prefix).toMatchObject({
        status: 301,
        location: `/${prefix}/needs/at/county-durham/`,
      });
      expect(await req(`/${prefix}/needs/at/durham/news/`), prefix).toMatchObject({
        status: 301,
        location: `/${prefix}/needs/at/county-durham/news/`,
      });
    }
  });

  it("has at least one prefix to test", () => {
    // The loop above passes vacuously over an empty set, and PREFIXES is
    // derived from LOCALES at import time -- so a refactor that emptied it
    // would turn the most important half of this file green and meaningless.
    expect([...PREFIXES].length).toBeGreaterThan(0);
  });

  it("redirects a POST as well as a GET", async () => {
    // app.use("*") is method-agnostic in Hono, and Django middleware runs on
    // every method too, so this is parity rather than a choice. Worth pinning
    // because a 301 answer to a POST is how a browser is told to re-request
    // with GET and no body: /needs/at/<slug>/hit/ and the updates POST both
    // live under a food bank's path, and if either ever moved up to a
    // single-segment URL it would start silently losing its payload here.
    seed("durham", "county-durham");

    expect(await req("/needs/at/durham/", "POST")).toMatchObject({
      status: 301,
      location: "/needs/at/county-durham/",
    });
    expect(await req("/needs/at/durham/", "HEAD")).toMatchObject({
      status: 301,
      location: "/needs/at/county-durham/",
    });
  });

  it("drops the query string, exactly as Django's redirect() does", async () => {
    // middleware.py:191-197 builds new_path from the three capture groups and
    // nothing else, so `?utm_source=...` is lost there too. This is therefore
    // pinned as PARITY, not endorsed: it means every campaign parameter on an
    // old-slug link is discarded at the redirect, and a visitor arriving from
    // an email with a tracking query is counted as direct traffic. Preserving
    // it would be a deliberate improvement over Django, and would need to be
    // decided rather than slipped in -- this test is what makes that a
    // decision.
    seed("durham", "county-durham");

    expect(await req("/needs/at/durham/?utm_source=newsletter&x=1")).toMatchObject({
      status: 301,
      location: "/needs/at/county-durham/",
    });
  });

  it("sends one hop only, and will happily send it back again", async () => {
    // SUSPECT, PINNED AS-IS -- and pinned from the middleware end, where the
    // damage happens. routes/admin/slugRedirect.ts refuses a row whose old
    // slug equals its new one ("an infinite 301 loop the moment the blob
    // reaches the middleware") but nothing looks for a two-row cycle, and
    // routes/admin/slugRedirect.test.ts already pins that BOTH saves are
    // accepted. This is the consequence: each request is resolved with a
    // single map lookup, so the pair below is a redirect ping-pong that ends
    // at the browser's ERR_TOO_MANY_REDIRECTS.
    //
    // Reachable by ordinary means -- a food bank renamed and renamed back, or
    // an admin adding the reverse of a redirect instead of editing it.
    // Recorded, not fixed: resolving chains here would be a behaviour change
    // Django does not make either.
    seed("durham", "county-durham");
    seed("county-durham", "durham");

    expect(await req("/needs/at/durham/")).toMatchObject({ location: "/needs/at/county-durham/" });
    expect(await req("/needs/at/county-durham/")).toMatchObject({ location: "/needs/at/durham/" });
  });

  it("interpolates a stored new_slug verbatim, however malformed", async () => {
    // SUSPECT, PINNED AS-IS. The admin validates neither slug for shape
    // (routes/admin/slugRedirect.test.ts: "accepts a slug the redirect
    // middleware can never match"), and this is the half that DOES take
    // effect: whatever is in new_slug goes straight into the Location header.
    // A space survives (Hono only percent-encodes when the string leaves
    // Latin-1), so an admin typo becomes a 301 to a URL with a space in it --
    // a permanent one, remembered by every browser that follows it.
    seed("durham", "county durham");
    seed("epsom", "../../etc");

    expect(await req("/needs/at/durham/")).toMatchObject({
      status: 301,
      location: "/needs/at/county durham/",
    });
    // Dot segments too: the browser resolves this against the origin, so the
    // visitor is sent to "/etc/" rather than to any food bank page. Nothing
    // here validates it, and nothing downstream sees it.
    expect(await req("/needs/at/epsom/")).toMatchObject({
      status: 301,
      location: "/needs/at/../../etc/",
    });
  });
});

// ===================== what must NOT be redirected =====================

describe("slugRedirect: rows that must not fire", () => {
  it("leaves a slug that is nobody's old_slug alone", async () => {
    // The filter test that matters: three rows in the table, none of them for
    // this food bank. A lookup that returned the first row, or any row, would
    // 301 the site's most-requested page family to somebody else's page.
    seed("durham", "county-durham");
    seed("epsom", "epsom-and-ewell-borough");
    seed("ewell", "epsom-and-ewell-borough");

    expect(await req("/needs/at/sid-valley/")).toEqual({
      status: 200,
      location: null,
      body: "handler:/needs/at/sid-valley/",
    });
  });

  it("never redirects a NEW slug -- only old ones are keys", async () => {
    // getSlugRedirectMap builds `map[old_slug] = new_slug`, so the
    // destination of every live redirect is also a value in the same object.
    // An implementation that searched values as well as keys (or built the
    // map the other way round) would send every visitor to the CURRENT page
    // straight back to the old one, i.e. would break the exact URLs the
    // feature exists to make work. Seeded and asserted absent, because a
    // lookup that only ever sees matching rows cannot notice this.
    seed("durham", "county-durham");

    expect(await req("/needs/at/county-durham/")).toEqual({
      status: 200,
      location: null,
      body: "handler:/needs/at/county-durham/",
    });
  });

  it("matches the slug exactly: case, prefix and suffix all count", async () => {
    // Plain object indexing, so matching is exact. Each of these is a wrong
    // implementation someone might reach for -- lowercasing "for
    // robustness", a startsWith/includes scan over the keys -- and each would
    // mint a second URL for a page that already has one, or redirect a
    // different food bank entirely. "county-durham-north" is the dangerous
    // one: a real slug that has a real redirect's key as its prefix.
    seed("durham", "county-durham");

    for (const path of [
      "/needs/at/DURHAM/",
      "/needs/at/Durham/",
      "/needs/at/durham-north/",
      "/needs/at/north-durham/",
      "/needs/at/durhamx/",
    ]) {
      expect(await req(path), path).toMatchObject({ status: 200, location: null });
    }
  });

  it("treats a row with an empty new_slug as no redirect", async () => {
    // The column is NOT NULL but not non-empty, so "" is storable. `if
    // (newSlug)` is what keeps that row inert: without the truthiness check --
    // an `!== undefined`, say, which reads as the more precise version of the
    // same test -- this would 301 to "/needs/at//", a URL no route matches and
    // one the browser would remember.
    seed("durham", "");

    expect(await req("/needs/at/durham/")).toEqual({
      status: 200,
      location: null,
      body: "handler:/needs/at/durham/",
    });
  });

  it("does nothing at all when the table is empty", async () => {
    // The state the table was in before the 57 rows were loaded, and the state
    // a fresh database is in. An empty map must be an ordinary "no redirect",
    // not an error and not a 301 to "/needs/at/undefined/".
    expect(await req("/needs/at/durham/")).toEqual({
      status: 200,
      location: null,
      body: "handler:/needs/at/durham/",
    });
  });
});

// ===================== which URLs are even looked at =====================

describe("slugRedirect: the path pattern", () => {
  // The module's load-bearing performance claim, from its own header: "The
  // lookup is NOT on every request despite the '*' mount: it runs only when
  // the path matches SLUG_PATTERN below (a /needs/at/ URL)". Every path here
  // asserts BOTH that nothing was redirected AND that D1 was never asked --
  // the second is the half that a wrong regex quietly loses, and it is a D1
  // read on the front page.
  it("never touches D1 for a path that is not a /needs/at/ page", async () => {
    seed("durham", "county-durham");

    for (const path of [
      "/",
      "/needs/",
      "/needs/at/",
      "/needs/geo.json",
      "/api/2/foodbanks/",
      "/admin/slug-redirects/",
      "/static/img/logo.png",
      "/cy/",
      "/md/needs/at/durham/",
    ]) {
      expect(await req(path), path).toMatchObject({ status: 200, location: null });
    }

    expect(prepared).toEqual([]);
  });

  it("never touches D1 for a food bank page deeper than one subsegment", async () => {
    // `(/[-\w]+)?` is ONE optional segment, in Django too (middleware.py:177),
    // so a renamed food bank's donation point pages, location pages and
    // subscription URLs are NOT redirected -- they 404 instead. Pinned as
    // parity with the original rather than as a good outcome; the fix, if it
    // is ever wanted, is a change both codebases would need.
    //
    // The dotted ones are a second, separate reason: `[-\w]` excludes ".", so
    // rss.xml and geo.json miss the pattern even though they are a single
    // segment.
    seed("durham", "county-durham");

    for (const path of [
      "/needs/at/durham/donationpoint/asda/",
      "/needs/at/durham/donationpoint/asda/openinghours/",
      "/needs/at/durham/updates/subscribe/",
      "/needs/at/durham/rss.xml",
      "/needs/at/durham/geo.json",
      "/needs/at/durham/favicon.png",
      "/cy/needs/at/durham/donationpoint/asda/",
    ]) {
      expect(await req(path), path).toMatchObject({ status: 200, location: null });
    }

    expect(prepared).toEqual([]);
  });

  it("is anchored at both ends", async () => {
    // `^` and `$` are what keep this from matching a food bank path that
    // appears in the middle of some other URL -- /frag/ takes paths as
    // arguments, and the admin's own URLs contain slugs. A dropped anchor
    // would turn any URL merely CONTAINING an old slug into a 301 to a
    // completely different page.
    seed("durham", "county-durham");

    for (const path of [
      "/frag/needs/at/durham/",
      "/admin/foodbank/needs/at/durham/",
      "/needs/at/durham/extra/segments/here/",
      "/xx/needs/at/durham/",
    ]) {
      expect(await req(path), path).toMatchObject({ status: 200, location: null });
    }

    expect(prepared).toEqual([]);
  });

  it("requires a non-empty slug", async () => {
    // "/needs/at//" cannot match `([-\w]+)`, so the module's
    // `oldSlug ? map[oldSlug] : undefined` guard is belt-and-braces for an
    // input the regex already refuses. Pinned so that a future loosening of
    // the group to `*` has to notice that the guard is the only thing between
    // it and `map[""]`.
    seed("durham", "county-durham");

    expect(await req("/needs/at//")).toMatchObject({ status: 200, location: null });
    expect(prepared).toEqual([]);
  });

  it("does not see a prefix behind a doubled slash", async () => {
    // "//needs/at/durham/" -- the leading empty segment defeats the pattern
    // entirely with today's non-empty prefix set. Documented because it does
    // NOT hold when that set is empty; see the LOCALES block at the foot of
    // this file, where the same URL becomes a scheme-relative Location.
    seed("durham", "county-durham");

    expect(await req("//needs/at/durham/")).toMatchObject({ status: 200, location: null });
    expect(prepared).toEqual([]);
  });

  it("cannot match a percent-encoded or non-ASCII slug (a divergence from Django)", async () => {
    // `url.pathname` does not decode, and JavaScript's `\w` is ASCII-only, so
    // "%" and "é" both miss the pattern. CPython's `\w` IS Unicode-aware and
    // Django hands the middleware an already-decoded `request.path`, so
    // re.match(pattern, '/needs/at/café/') matches there (checked on this
    // machine, 3.13.0, 2026-09-08).
    //
    // Inert today -- Django's slugify strips non-ASCII, so no old_slug in the
    // table can contain any -- but pinned as the reason not to "fix" the
    // encoding by decoding the path here: decoding would also make
    // "/needs/at/durham%2Fnews/" look like a two-segment path and hand the
    // lookup a slug the router will never see.
    seed("café", "cafe");
    seed("durham", "county-durham");

    expect(await req("/needs/at/café/")).toMatchObject({ status: 200, location: null });
    expect(await req("/needs/at/durham%2Fnews/")).toMatchObject({ status: 200, location: null });
    expect(prepared).toEqual([]);
  });

  it("accepts every character class the slug group allows", async () => {
    // `[-\w]+` is hyphen, letters, digits and underscore. Real slugs are
    // hyphenated lowercase, but the group is wider than that and the table
    // will hold whatever the admin typed, so the pattern and the map have to
    // agree about what a slug may contain.
    seed("st_helens-2", "st-helens");
    seed("123", "one-two-three");

    expect(await req("/needs/at/st_helens-2/")).toMatchObject({
      status: 301,
      location: "/needs/at/st-helens/",
    });
    expect(await req("/needs/at/123/")).toMatchObject({
      status: 301,
      location: "/needs/at/one-two-three/",
    });
  });
});

// ================= the prefix set: the declared divergence =================

describe("slugRedirect: language prefixes, and where Django differs", () => {
  it("ignores a two-letter code this site does not serve", async () => {
    // THE DIVERGENCE, in the direction nobody expects. Django's
    // `(/[a-z]{2})?` matches any two lowercase letters, so /de/, /es/ and /pl/
    // all take the redirect branch there (verified as regex semantics on
    // CPython 3.13.0, 2026-09-08; not verified against a running instance).
    // Here they miss the pattern, so no lookup happens and the request falls
    // through to a 404 -- which is where those URLs end up anyway, since
    // §2.7.1 dropped 17 of Django's 21 languages and no route is registered
    // under them.
    //
    // The narrower match is what makes the module's stated fix possible: a
    // set of known prefixes can contain "zh-hans", a `[a-z]{2}` cannot.
    seed("durham", "county-durham");

    for (const code of ["de", "es", "pl", "fr", "en"]) {
      expect(await req(`/${code}/needs/at/durham/`), code).toMatchObject({ status: 200, location: null });
    }
    expect(prepared).toEqual([]);
  });

  it("ignores /en/, which is never a prefix here", async () => {
    // Included in the loop above and called out separately because it is the
    // one code in it that IS a language this app knows: LOCALES has "en" and
    // PREFIXES deliberately does not (prefix_default_language=False), so
    // /en/needs/at/durham/ is an unrecognised path both before and after this
    // middleware. If "en" ever entered PREFIXES, this would start 301ing to a
    // URL that 404s.
    seed("durham", "county-durham");

    expect(PREFIXES.has("en")).toBe(false);
    expect(await req("/en/needs/at/durham/")).toMatchObject({ status: 200, location: null });
  });

  it("matches a multi-character locale, which Django's [a-z]{2} could not", async () => {
    // The module header's headline claim: "[a-z]{2} cannot match 'zh-hans' or
    // 'tlh', so renamed food banks silently fail to redirect in exactly those
    // two languages today. This is a deliberate fix, matching against the
    // known prefix set instead".
    //
    // It is UNTESTABLE against today's LOCALES -- cy, ga and gd are all two
    // letters, so a hardcoded `[a-z]{2}` here would pass every other test in
    // this file. The only way to tell the fix from the bug is to give LOCALES
    // a locale Django's pattern could not have matched and re-import the
    // module. If someone ever "simplifies" the regex back to a character
    // class, this is the test that fails and the only one that can.
    await withLocales(["en", "cy", "ga", "gd", "zh-hans"], async (fresh) => {
      seed("durham", "county-durham");

      expect(await reqWith(fresh, "/zh-hans/needs/at/durham/")).toMatchObject({
        status: 301,
        location: "/zh-hans/needs/at/county-durham/",
      });
      // And the subpage form, where the prefix and the subpath are captured
      // by different groups -- a regex that matched the prefix but mis-sized
      // the groups would still 301, to the wrong place.
      expect(await reqWith(fresh, "/zh-hans/needs/at/durham/news/")).toMatchObject({
        status: 301,
        location: "/zh-hans/needs/at/county-durham/news/",
      });
    });
  });

  it("stops matching a locale that LOCALES no longer lists", async () => {
    // The other direction, and the one a hardcoded list kept "for safety"
    // alongside the derived one would survive: adding still works, so only
    // REMOVAL exposes it. §2.7.1 was itself a removal (17 catalogues dropped),
    // so this is the realistic edit.
    await withLocales(["en", "cy"], async (fresh) => {
      seed("durham", "county-durham");

      expect(await reqWith(fresh, "/cy/needs/at/durham/")).toMatchObject({
        status: 301,
        location: "/cy/needs/at/county-durham/",
      });
      // /gd/ is now indistinguishable from /de/: no prefix, no match, no
      // lookup, no redirect.
      expect(await reqWith(fresh, "/gd/needs/at/durham/")).toMatchObject({ status: 200, location: null });
    });
  });

  it("turns a doubled slash into a scheme-relative Location when LOCALES is English-only (suspect)", async () => {
    // SUSPECT, PINNED AS-IS, AND CONTINGENT. With no non-English locales the
    // prefix alternation is EMPTY, and `^(/(?:))?...` still matches a bare
    // "/" -- so "//needs/at/durham/" matches with lang_prefix "/", and the
    // Location built from it is "//needs/at/county-durham/". A browser reads
    // that as scheme-relative and goes to the host "needs".
    //
    // Unreachable today (PREFIXES is cy/ga/gd, and the test above pins that
    // the same URL does not match while it is non-empty), which is why this is
    // recorded rather than fixed. It is here because "drop the other three
    // catalogues" is a plausible future edit -- §2.7.1 already dropped 17 --
    // and it would silently turn a doubled slash on the busiest page family
    // into an off-site redirect. Django cannot reach this: its group is
    // `(/[a-z]{2})`, which requires two letters.
    await withLocales(["en"], async (fresh) => {
      seed("durham", "county-durham");

      expect(await reqWith(fresh, "//needs/at/durham/")).toMatchObject({
        status: 301,
        location: "//needs/at/county-durham/",
      });
      // The ordinary form is unaffected, so the empty set is not simply
      // broken -- it is broken for one input.
      expect(await reqWith(fresh, "/needs/at/durham/")).toMatchObject({
        status: 301,
        location: "/needs/at/county-durham/",
      });
    });
  });
});

// ===================== the memo =====================

describe("slugRedirect: the five-minute memo", () => {
  it("reads D1 once per isolate, not once per request", async () => {
    // The module's own claim, and the reason it is allowed to be mounted on
    // "*" over the site's busiest page family: "a D1 read here costs one query
    // per isolate per 5 minutes, not one per request". A memo that never hit
    // would be invisible in every response and would show up only as a D1 bill
    // and a slower TTFB on every food bank page.
    seed("durham", "county-durham");

    expect(await req("/needs/at/durham/")).toMatchObject({ status: 301 });
    expect(prepared).toEqual(["SELECT old_slug, new_slug FROM slugredirect"]);

    // 20 further requests across matching, redirecting and non-redirecting
    // paths -- all served from the memo.
    for (let i = 0; i < 20; i++) {
      await req("/needs/at/durham/");
      await req("/cy/needs/at/durham/news/");
      await req("/needs/at/sid-valley/");
    }
    expect(prepared.length).toBe(1);
  });

  it("asks for the cheapest consistency mode D1 offers", async () => {
    // `withSession("first-unconstrained")` -- any replica, no read-your-writes
    // guarantee. Deliberate for this data: the map is already up to five
    // minutes stale by design, so paying for a primary read would buy
    // nothing and put the latency of a cross-region hop on the front of every
    // food bank page. Pinned because "first-primary" is the mode that looks
    // safer in review.
    seed("durham", "county-durham");
    await req("/needs/at/durham/");

    expect(sessionModes).toEqual(["first-unconstrained"]);
  });

  it("does not see a row added after the read, until the TTL elapses", async () => {
    // The propagation delay the module documents ("~5 minutes worst case"),
    // asserted as behaviour rather than left as a comment. An admin who adds a
    // redirect and immediately tests it may see a 404; that is expected, and
    // it is the cost of not putting a query on the hot path.
    seed("durham", "county-durham");
    await req("/needs/at/durham/");
    expect(prepared.length).toBe(1);

    seed("epsom", "epsom-and-ewell-borough");

    // One millisecond short of the TTL: still the old map, still no second
    // read. This is the assertion that fails if MEMO_TTL_MS is quietly
    // shortened -- which the module's header explicitly forbids.
    vi.setSystemTime(now + MEMO_TTL_MS - 1);
    expect(await req("/needs/at/epsom/")).toMatchObject({ status: 200, location: null });
    expect(prepared.length).toBe(1);

    // Exactly at the TTL the comparison `Date.now() - memo.at < MEMO_TTL_MS`
    // is false, so the map is re-read and the new row takes effect.
    vi.setSystemTime(now + MEMO_TTL_MS);
    expect(await req("/needs/at/epsom/")).toMatchObject({
      status: 301,
      location: "/needs/at/epsom-and-ewell-borough/",
    });
    expect(prepared.length).toBe(2);
  });

  it("keeps redirecting for a row that has been deleted, for up to the TTL", async () => {
    // The same staleness in the direction that hurts: an admin deletes a
    // redirect that was pointing at the wrong food bank, and the middleware
    // goes on issuing it -- as a 301, which browsers cache on their own
    // account -- for up to five minutes afterwards.
    seed("durham", "county-durham");
    await req("/needs/at/durham/");

    db.prepare("DELETE FROM slugredirect WHERE old_slug = ?").run("durham");

    vi.setSystemTime(now + MEMO_TTL_MS - 1);
    expect(await req("/needs/at/durham/")).toMatchObject({ status: 301 });

    vi.setSystemTime(now + MEMO_TTL_MS);
    expect(await req("/needs/at/durham/")).toMatchObject({ status: 200, location: null });
  });

  it("memoises the miss as well as the hit", async () => {
    // A request for a slug with no redirect must not re-read D1 either --
    // otherwise the memo would protect exactly the pages that DO redirect
    // (rare) and not the ones that do not (every food bank page on the site),
    // which is the wrong way round.
    seed("durham", "county-durham");

    await req("/needs/at/sid-valley/");
    expect(prepared.length).toBe(1);
    await req("/needs/at/another-one/");
    expect(prepared.length).toBe(1);
  });
});

// ===================== when D1 is not there =====================

describe("slugRedirect: failing open", () => {
  it("falls through and logs when the binding is missing", async () => {
    // A missing d1_databases entry, or a preview deployment without one. The
    // module's contract is that "a failed read must not take the page down
    // with it": the request continues to the router, so every URL that is not
    // a renamed slug -- which is almost all of them -- keeps working.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await req("/needs/at/durham/", "GET", NO_DB_ENV)).toEqual({
      status: 200,
      location: null,
      body: "handler:/needs/at/durham/",
    });
    // The exact message, and the error object alongside it. This log line is
    // the ONLY external evidence that redirects have stopped working -- the
    // responses look like ordinary 404s -- so its wording is what an alert
    // would have to match.
    expect(consoleError).toHaveBeenCalledWith(
      "slugRedirect: D1 read failed, continuing without redirects",
      expect.any(TypeError),
    );
  });

  it("falls through and logs when the query itself fails", async () => {
    // The other shape: the binding exists, the statement is prepared, and D1
    // rejects. Covered separately because it is the shape a real outage takes
    // and because it proves the try block wraps the AWAIT, not just the
    // synchronous withSession() call -- an unhandled rejection here would be a
    // 500 on every food bank page rather than a silent loss of redirects.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = brokenQueryEnv("D1_ERROR: network error");

    expect(await req("/needs/at/durham/", "GET", broken)).toMatchObject({
      status: 200,
      location: null,
    });
    expect(prepared).toEqual(["SELECT old_slug, new_slug FROM slugredirect"]);
    expect(consoleError).toHaveBeenCalledWith(
      "slugRedirect: D1 read failed, continuing without redirects",
      expect.objectContaining({ message: "D1_ERROR: network error" }),
    );
  });

  it("does not memoise the failure: the next request retries", async () => {
    // The comment at slugRedirect.ts:61-63 -- "Not memoised on failure, so the
    // next request through this isolate retries rather than serving an empty
    // map for the full 5 minutes". Without this, one transient D1 blip during
    // a deploy would take every renamed food bank's URL down for five minutes
    // per isolate, with nothing but a single log line to say so.
    //
    // Same isolate, same millisecond on the clock: the only thing that changes
    // is that the binding works.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    seed("durham", "county-durham");

    expect(await req("/needs/at/durham/", "GET", brokenQueryEnv("D1_ERROR: boom"))).toMatchObject({ status: 200 });
    expect(await req("/needs/at/durham/")).toMatchObject({
      status: 301,
      location: "/needs/at/county-durham/",
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("logs every failure, not just the first", async () => {
    // The corollary of not memoising: a sustained outage produces a line per
    // matching request rather than one and then silence. Noisy, and that is
    // the point -- the incident this module's header describes went unnoticed
    // for a day because nothing was written down.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = brokenQueryEnv("D1_ERROR: still down");

    await req("/needs/at/durham/", "GET", broken);
    await req("/needs/at/epsom/", "GET", broken);
    await req("/needs/at/sid-valley/", "GET", broken);

    expect(consoleError).toHaveBeenCalledTimes(3);
  });

  it("does not reach D1 at all for a non-matching path, even with no binding", async () => {
    // The performance claim and the failure path together: if the lookup ran
    // on every request, an environment with no DB binding would log an error
    // for every asset, every API call and the front page. It logs nothing,
    // because the regex is checked first.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const path of ["/", "/needs/", "/api/2/foodbanks/", "/needs/at/durham/rss.xml"]) {
      expect(await req(path, "GET", NO_DB_ENV), path).toMatchObject({ status: 200 });
    }
    expect(consoleError).not.toHaveBeenCalled();
  });
});

// ===================== the prototype-key hole =====================

describe("slugRedirect: slugs that are Object.prototype members (suspect)", () => {
  // SUSPECT, PINNED AS-IS. getSlugRedirectMap builds a plain `{}`, so
  // `map[oldSlug]` reaches Object.prototype for a handful of slugs -- and
  // every one of those inherited values is truthy, so the `if (newSlug)`
  // branch fires with a FUNCTION where a string is expected. TypeScript says
  // the value is `string | undefined` and is wrong at runtime.
  //
  // The result is a 301 to a URL built by stringifying a native function. It
  // is not an information leak (the body is empty and the function source is
  // "[native code]") and it is not reachable for any real food bank, but it
  // is a permanent redirect served for a URL that should 404 -- and a 301 is
  // the one status browsers and CDNs are entitled to remember.
  //
  // The fix would be one character, `Object.create(null)` in
  // packages/db/src/slugRedirects.ts, or an Object.hasOwn() guard here.
  // NOT APPLIED: this file pins behaviour and does not change it. Reported in
  // suspectedBugs.
  it("301s /needs/at/constructor/ to a stringified function, with an empty table", async () => {
    expect(await req("/needs/at/constructor/")).toMatchObject({
      status: 301,
      location: "/needs/at/function Object() { [native code] }/",
    });
  });

  it("does the same for the other inherited members, including __proto__", async () => {
    expect(await req("/needs/at/__proto__/")).toMatchObject({
      status: 301,
      location: "/needs/at/[object Object]/",
    });
    for (const key of ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]) {
      const r = await req(`/needs/at/${key}/`);
      expect(r.status, key).toBe(301);
      expect(r.location, key).toBe(`/needs/at/function ${key}() { [native code] }/`);
    }
  });

  it("still lets a real row win over the inherited member", async () => {
    // The one saving grace: an own property shadows the prototype, so a food
    // bank genuinely called "constructor" would redirect correctly. Asserted
    // so that a future fix (Object.create(null), or a hasOwn guard) is not
    // written in a way that breaks the ordinary case as well.
    seed("constructor", "county-durham");

    expect(await req("/needs/at/constructor/")).toMatchObject({
      status: 301,
      location: "/needs/at/county-durham/",
    });
  });
});

// ===================== mounted in the real app =====================

describe("slugRedirect: as index.ts actually mounts it", () => {
  // REAL APP, REAL MIDDLEWARE ORDER -- index.ts's own default export, not a
  // copy of the chain transcribed into this file. The tests above prove what
  // the middleware does; these prove WHERE it does it, which is a property of
  // index.ts:112-125 and of nothing else. A suite that only ever mounted the
  // middleware by itself would pass unchanged if the registration were dropped
  // altogether.

  async function realReq(path: string, bindings: Env = env) {
    const res = await realApp.request(url(path), {}, bindings);
    return res;
  }

  it("redirects an old slug end to end, through the whole chain", async () => {
    seed("durham", "county-durham");

    const res = await realReq("/needs/at/durham/");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/needs/at/county-durham/");
    expect(await res.text()).toBe("");
  });

  it("runs before the router, so the redirect needs no other table", async () => {
    // The ordering claim that matters most. index.ts:116 registers this above
    // every route, so a renamed food bank's URL is answered without the
    // handler -- and therefore without the `foodbank` table, which this
    // fixture does not have. The control below is the same URL for a slug
    // with no redirect: it reaches wfbnFoodbank, which asks for a table that
    // does not exist, and app.onError renders the 500 page.
    //
    // If the middleware were ever mounted below the routes, the 301 would
    // become this 500 -- a renamed food bank's old URL answering with an error
    // page instead of a redirect.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    seed("durham", "county-durham");

    expect((await realReq("/needs/at/durham/")).status).toBe(301);
    expect(consoleError).not.toHaveBeenCalled();

    expect((await realReq("/needs/at/sid-valley/")).status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
  });

  it("redirects the locale-prefixed form too, in the real app", async () => {
    seed("durham", "county-durham");

    for (const prefix of PREFIXES) {
      const res = await realReq(`/${prefix}/needs/at/durham/news/`);
      expect(res.status, prefix).toBe(301);
      expect(res.headers.get("Location"), prefix).toBe(`/${prefix}/needs/at/county-durham/news/`);
    }
  });

  it("carries the security headers, which are registered above it", async () => {
    // index.ts:113's securityHeaders runs before this middleware on the way in
    // and stamps c.res on the way out, so it reaches even a response that
    // short-circuits the rest of the chain. Worth pinning: a redirect that
    // skipped them would be the one response on the site without nosniff.
    seed("durham", "county-durham");

    const res = await realReq("/needs/at/durham/");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=/);
  });

  it("emits no Content-Language, because resolveLanguage never runs", async () => {
    // index.ts:116-117 puts this middleware ABOVE resolveLanguage, and a
    // redirect returns without calling next() -- so the language middleware's
    // post-next() header is never written, even for a /cy/ URL. Observable,
    // and the cheapest available proof of the registration order; if the two
    // lines were ever swapped, this header would appear.
    seed("durham", "county-durham");

    const res = await realReq("/cy/needs/at/durham/");
    expect(res.status).toBe(301);
    expect(res.headers.get("Content-Language")).toBeNull();
  });

  it("emits no Cache-Control and no Cache-Tag on the 301", async () => {
    // middleware/pageCacheControl.ts:127 bails on any status but 200 and
    // middleware/cacheTag.ts skips non-2xx, so this response reaches the edge
    // with neither. Recorded, not endorsed: it means a 301 the edge decides to
    // keep under its own rules cannot be purged by tag when the admin fixes
    // the row -- and the row is exactly the kind of thing that gets fixed.
    // Whether Cloudflare stores it at all is a zone-configuration question
    // this test cannot answer and does not claim to.
    seed("durham", "county-durham");

    const res = await realReq("/needs/at/durham/");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  it("leaves an unrelated page untouched", async () => {
    // The control for the whole block: with the same seeded table and the same
    // real app, a page that is nobody's old slug is served normally. /about-us/
    // needs no database, so a 200 here also proves the middleware did not
    // swallow the request on its way past.
    seed("durham", "county-durham");

    const res = await realReq("/about-us/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
  });
});

// ===================== helpers used by the LOCALES block =====================

/**
 * Re-import the middleware with a substituted LOCALES.
 *
 * SLUG_PATTERN is built ONCE, at module load, from resolveLanguage's PREFIXES
 * -- which is itself derived from @givefood/templates' LOCALES. Today's
 * LOCALES are en/cy/ga/gd, all two-letter, so the derivation is
 * indistinguishable from a hardcoded `[a-z]{2}` on every input that exists:
 * the module's entire stated reason for existing in this form cannot be
 * observed without changing LOCALES and loading the module again.
 *
 * Copied in shape from resolveLanguage.test.ts's helper of the same name, so
 * the two files agree about how this is done.
 */
async function withLocales<T>(locales: string[], fn: (fresh: typeof import("./slugRedirect")) => Promise<T>): Promise<T> {
  vi.resetModules();
  vi.doMock("@givefood/templates", async () => {
    const actual = await vi.importActual<typeof import("@givefood/templates")>("@givefood/templates");
    return { ...actual, LOCALES: locales as unknown as typeof actual.LOCALES };
  });
  try {
    return await fn(await import("./slugRedirect"));
  } finally {
    // Leave the registry as it was found: every other test in this file uses
    // the module instance imported at the top.
    vi.doUnmock("@givefood/templates");
    vi.resetModules();
  }
}

/** req(), but against a specific (re-imported) copy of the middleware, which has its own memo. */
async function reqWith(mod: typeof import("./slugRedirect"), path: string) {
  const app = new Hono<AppEnv>();
  app.use("*", mod.slugRedirect);
  app.all("*", (c) => c.text(`handler:${new URL(c.req.url).pathname}`));
  const res = await app.request(url(path), {}, env);
  return { status: res.status, location: res.headers.get("Location"), body: await res.text() };
}
