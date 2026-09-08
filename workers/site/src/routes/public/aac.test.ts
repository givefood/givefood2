import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/public/aac.ts -- /aac/ and /aac/next/, the address autocomplete
// endpoints. Django's `address_autocomplete()` at givefood/views.py:1519-1580
// (the @cache_page(SECONDS_IN_DAY) decorator is on line 1519); /aac/next/ is
// Ticket #8 and has no Django ancestor.
//
// WHAT THIS FILE IS FOR, AND WHAT IT IS NOT FOR. The SQL underneath -- the
// range scans, the FTS5 trigram pass, the bucketing -- is exhaustively covered
// by packages/db/src/aac.test.ts against the same real engine, and none of it
// is repeated here. What is left is the part only the HTTP layer can get
// wrong, and every item of it is silent:
//
//   * the two response ENVELOPES differ (a bare array at /aac/, an object with
//     a "next" key at /aac/next/) and both are frozen client contract;
//   * three response headers ARE the feature -- without
//     Access-Control-Allow-Origin the endpoint is unusable from anywhere but
//     this origin, and without Cache-Control every keystroke on the site's
//     busiest control is an origin request. Neither absence is a 500, a log
//     line, or anything a smoke test notices;
//   * the day/week split between the two routes is a deliberate design
//     decision (see the handler's comment: the small hot response and the
//     large speculative one must cache independently), so a copy-paste that
//     gave them the same TTL would look completely fine;
//   * `?q=` is read through Hono, not through Django's request.GET, and the
//     decoding rules are Hono's. A postcode typed with a space arrives as
//     "sw1a+1aa" on the wire, and if that `+` stopped being a space every
//     spaced postcode search would return an empty list with a 200;
//   * the route is registered ONCE, unprefixed, because Django has it in
//     urls.py's "Untranslated pages" block (urls.py:72) rather than inside
//     i18n_patterns. /cy/aac/ 404s, and that is parity, not an oversight.
//
// REAL EVERYTHING, the same harness as routes/public/sitemaps.test.ts and
// routes/public/md.test.ts: the real production app (workers/site/src/index.ts's
// default export), so the real router, the real middleware stack in its real
// registration order, and the real 404/500 renders; and real in-memory SQLite
// built from the real migrations, so `place_fts` is a genuine external-content
// FTS5 table and `postcode.postcode` a genuine generated column. Mocked: only
// the two KV namespaces (Maps), which nothing on this path reads.
//
// MUTATION-TESTED (TESTING.md's convention): 36 mutants, all 36 caught, each
// applied to a COPY of the repo in a scratchpad with this file left untouched.
// Both handlers' `?? ""` deleted and their `q` forced empty; the first repeated
// `?q=` swapped for the last; every one of the six response headers deleted,
// renamed, narrowed (ACAO to this origin), or given the wrong TTL; `public`
// dropped and swapped for `private`; a charset appended to the content type; a
// Vary and a Set-Cookie added; both envelopes unwrapped and re-wrapped; the two
// db functions swapped into each other's handler; dbSession() called per query
// and bypassed entirely; and, in index.ts, app.get relaxed to app.all, the
// routes added to the locale loop, /aac/next/ unregistered and misspelled, and
// the wrong handler mounted on /aac/. Two neighbours were mutated as well, to
// check that assertions which look like they belong to another file are really
// load-bearing here: lib/appendSlash.ts dropping the query string from its
// redirect, and packages/db/src/aac.ts losing each range predicate or emitting
// codes before places.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

interface Prepared {
  sql: string;
  params: unknown[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite.
//
// `prepared` is load-bearing rather than decorative here. Several claims in
// this file are about what NEVER REACHES THE DATABASE -- an absent `q`, a
// 41-character `q`, a POST -- and "the response was []" is a strictly weaker
// statement than "no statement was issued". /aac/ is uncredentialed, CORS-open
// and takes arbitrary input, so the guard that keeps a hostile query away from
// a 253,584-row table is the thing worth pinning, not the empty array it
// happens to produce.
function d1Session(db: DatabaseSync, prepared: Prepared[]): D1DatabaseSession {
  const statement = (record: Prepared, params: Bindable[]) => ({
    bind: (...next: unknown[]) => {
      record.params = next;
      return statement(record, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(record.sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(record.sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(record.sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const record: Prepared = { sql, params: [] };
      prepared.push(record);
      return statement(record, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: Prepared[];
let sessions: number;
let kv: Map<string, string>;

function env(overrides: Partial<AppEnv["Bindings"]> = {}): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
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
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface PlaceSeed {
  name: string;
  population: number | null;
  county: string;
  latLng: string;
}

interface PostcodeSeed {
  pcn: string;
  county: string;
  latLng: string;
}

// `name_upper` is computed in JavaScript, not by SQLite, for the reason
// migrations/0009_aac.sql spells out on the column itself: SQLite's upper() is
// ASCII-only, so a fixture that let the engine derive it would mis-case every
// Welsh and Gaelic name. Production computes it in Postgres at export time; JS
// toUpperCase() is the full-Unicode equivalent.
//
// place_fts is content='place' with no triggers, so it is rebuilt exactly the
// way tools/pg-to-d1/extract_core.py populates it in production -- the index
// is DERIVED from the seeded rows rather than hand-written, so a fixture
// cannot teach the FTS table something `place` does not say.
function seedPlaces(seeds: PlaceSeed[]): void {
  const insert = db.prepare(
    "INSERT INTO place (id, gbpnid, name, name_upper, lat_lng, county, county_slug, name_slug, population) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  seeds.forEach((seed, index) => {
    insert.run(
      index + 1,
      1000 + index,
      seed.name,
      seed.name.toUpperCase(),
      seed.latLng,
      seed.county,
      "county-slug",
      `name-slug-${index}`,
      seed.population,
    );
  });
  db.exec("INSERT INTO place_fts(place_fts) VALUES('rebuild')");
}

function seedPostcodes(seeds: PostcodeSeed[]): void {
  const insert = db.prepare("INSERT INTO postcode (id, pcn, lat_lng, county) VALUES (?, ?, ?, ?)");
  seeds.forEach((seed, index) => insert.run(index + 1, seed.pcn, seed.latLng, seed.county));
}

// A deliberately tiny gazetteer, shaped so that each expected body below can be
// written out in full and read as a sentence rather than a blob:
//
//   Ely / Elgin        both prefix-match "el", and their populations differ so
//                      the ORDER BY has something to do
//   New Ely            matches "ely" only through the FTS substring pass, so a
//                      response containing it proves both passes ran
//   Weston super Mare  the only multi-word name -- the "+ is a space" test
//                      would be untestable without it
//   Zzz Excluded       MUST NOT APPEAR in any "el"/"ely" response. Seeded with
//                      a population two orders of magnitude above everything
//                      else, so if a range bound ever rots it does not merely
//                      leak in, it leaks in AT THE TOP where an exact-body
//                      assertion cannot miss it. It is also the row the
//                      repeated-`?q=` test uses to prove which value won.
//
//   EL1 1AA            the one postcode inside the "el" range
//   SW1A 1AA           reachable only by a query containing a space
//   N1 9DX             in no range any test here searches: the postcode
//                      equivalent of Zzz Excluded
function seed(): void {
  seedPlaces([
    { name: "Ely", population: 20_000, county: "Cambridgeshire", latLng: "52.40,0.26" },
    { name: "Elgin", population: 9_000, county: "Moray", latLng: "57.65,-3.32" },
    { name: "New Ely", population: 500, county: "Cambridgeshire", latLng: "52.41,0.27" },
    { name: "Weston super Mare", population: 82_000, county: "Somerset", latLng: "51.35,-2.98" },
    { name: "Zzz Excluded", population: 9_000_000, county: "Nowhere", latLng: "0.00,0.00" },
  ]);
  seedPostcodes([
    { pcn: "EL11AA", county: "Cambridgeshire", latLng: "52.39,0.25" },
    { pcn: "SW1A1AA", county: "Greater London", latLng: "51.50,-0.14" },
    { pcn: "N19DX", county: "Greater London", latLng: "51.54,-0.11" },
  ]);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seed();
  prepared = [];
  sessions = 0;
  kv = new Map();
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed `Response | Promise<Response>`
// and the await is what narrows it.
const request = async (path: string, init?: RequestInit, bindings = env()): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, init), bindings, execCtx);

const get = (path: string, bindings = env()): Promise<Response> => request(path, undefined, bindings);

// The three rows the fixture can return, spelled once so the expected bodies
// below stay readable. Written as the exact JSON the handler emits -- the key
// ORDER is part of the frozen {n,l,t,c} contract, not an accident of
// formatting, so these are strings and not objects.
const ELY = '{"n":"Ely","l":"52.40,0.26","t":"p","c":"Cambridgeshire"}';
const ELGIN = '{"n":"Elgin","l":"57.65,-3.32","t":"p","c":"Moray"}';
const NEW_ELY = '{"n":"New Ely","l":"52.41,0.27","t":"p","c":"Cambridgeshire"}';
const EL1_1AA = '{"n":"EL1 1AA","l":"52.39,0.25","t":"c","c":"Cambridgeshire"}';

// =========================== /aac/ -- the response ==========================

describe("/aac/ -- the response body", () => {
  // THE WHOLE BODY, byte for byte. The response shape is contract (the
  // handler's own comment calls it "frozen/contract: bare JSON array, terse
  // {n,l,t,c} keys"), and every way of getting it wrong is a 200: an object
  // instead of an array, a renamed key, a stringified null, places and codes
  // the other way round. The client reads `t` to decide how to render a row,
  // so codes arriving before places is a visibly wrong dropdown with no error
  // anywhere.
  //
  // "Zzz Excluded" is the most populous row in the table and is absent, which
  // is the half of this assertion that a `toHaveLength` check would not make.
  it("emits a bare array of {n,l,t,c} rows, places before codes", async () => {
    const res = await get("/aac/?q=el");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`[${ELY},${ELGIN},${EL1_1AA}]`);
  });

  // Both place passes reach the client through this route, not just the cheap
  // one. "New Ely" cannot be prefix-matched by "ely" -- it only exists in the
  // response because the FTS5 substring pass ran and its rows were
  // concatenated after the prefix pass's.
  it("returns prefix and substring place hits, in that order", async () => {
    expect(await (await get("/aac/?q=ely")).text()).toBe(`[${ELY},${NEW_ELY}]`);
  });

  // An empty result is `[]`, not `null`, not `{}`, and not a 404. Django
  // returns `JsonResponse([], safe=False)` for the same case
  // (views.py:1534-1535) and the client renders whatever array it is given, so
  // a 404 here would be a visible error in a dropdown rather than an empty one.
  it("returns [] rather than a 404 when nothing matches", async () => {
    const res = await get("/aac/?q=qqqq");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("[]");
  });
});

describe("/aac/ -- the headers, which are most of the feature", () => {
  // Django sets exactly these two things on the response it hands back:
  // `JsonResponse(...)` (content_type="application/json", with no charset --
  // this port matches that spelling) and, at views.py:1579,
  // `response["Access-Control-Allow-Origin"] = "*"`.
  //
  // ACAO IS NOT DECORATION HERE. This endpoint is called from pages that are
  // not this origin; drop the header and every one of those callers gets a
  // CORS failure in the browser while curl, the tests and the Worker logs all
  // show a perfectly healthy 200.
  it("sets the JSON content type and the open CORS header Django sets", async () => {
    const res = await get("/aac/?q=el");

    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // @cache_page(SECONDS_IN_DAY) in Django (the decorator on views.py:1519)
  // becomes this explicit header, because there is no per-route cache
  // middleware in this port -- see the handler's own comment. A day, spelled
  // exactly, on the response to the busiest input control on the site.
  //
  // Asserted as the WHOLE header value rather than a `toContain("86400")`,
  // because the failure this catches is not "the number changed" but "the
  // header changed shape": `public, max-age=300, s-maxage=86400` is what
  // middleware/pageCacheControl.ts writes, and reading a match on 86400 out of
  // that would call a five-minute browser TTL a day.
  it("caches for a day, exactly as written", async () => {
    expect((await get("/aac/?q=el")).headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  // THE GLOBAL GAP-FILLER MUST NOT FILL THIS GAP. pageCacheControl is mounted
  // on "*" and unwinds after this handler; its "never override" guard is the
  // only reason the day above survives contact with it. That guard has already
  // been the subject of two live incidents (see that file's comments on the
  // /frag/ip-address/ leak and the cached CSRF token), so the interaction is
  // pinned from this side too: if the guard were reordered or dropped, this
  // route's considered TTL would silently become the generic five-minute one.
  //
  // The negative assertion is the one that matters -- s-maxage appearing here
  // at all would mean the middleware wrote over the handler.
  it("keeps its own Cache-Control rather than the global middleware's", async () => {
    const value = (await get("/aac/?q=el")).headers.get("Cache-Control") ?? "";

    expect(value).not.toContain("s-maxage");
    expect(value).not.toContain("max-age=300");
  });

  // WHAT MAKES `public` SAFE. A shared cache may hand one visitor's copy of
  // this response to the next visitor, so the response must be a pure function
  // of the URL. Two things would break that silently, and both have precedent
  // in this repo: a Set-Cookie (pageCacheControl.ts records a CSRF token
  // reaching the shared cache on 2026-09-07) and a Vary
  // (middleware/resolveLanguage.ts records Vary: Accept-Language minting a
  // second copy of every response for every distinct header value).
  //
  // Neither is present, and the same query issued by two different visitors --
  // different cookies, different Accept-Language -- returns identical bytes.
  // That is the invariant, stated as the property rather than as a list of
  // headers that happen to be absent today.
  it("is the same response for every visitor: no cookie, no Vary, byte-identical", async () => {
    const one = await get("/aac/?q=el");
    const two = await request("/aac/?q=el", {
      headers: { Cookie: "csrftoken=someone-elses; sessionid=abc", "Accept-Language": "cy" },
    });

    expect(one.headers.get("Set-Cookie")).toBeNull();
    expect(one.headers.get("Vary")).toBeNull();
    expect(await two.text()).toBe(await one.text());
    expect(two.headers.get("Cache-Control")).toBe(one.headers.get("Cache-Control"));
  });

  // No Cache-Tag, deliberately: middleware/cacheTag.ts derives tags from the
  // path and /aac/ matches none of its patterns, so a cached response here
  // cannot be purged by queues/cachePurge.ts when a place or postcode changes.
  // That is correct and not an oversight -- the gazetteer is a bulk import that
  // changes on the order of never, and the alternative is tagging an unbounded
  // set of ?q= URLs. Pinned so that a future addition to AGGREGATE_PATHS which
  // swept this in would be a visible decision.
  it("carries no Cache-Tag, so these responses are not purgeable by tag", async () => {
    expect((await get("/aac/?q=el")).headers.get("Cache-Tag")).toBeNull();
  });

  // The global middleware still applies to this route -- it is not somehow
  // outside the stack because it builds its Response by hand rather than
  // through c.json(). Cheap, and it is the assertion that says "this really is
  // the production app" rather than the handler called directly.
  it("still carries the site-wide security and language headers", async () => {
    const res = await get("/aac/?q=el");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Server-Timing")).toMatch(/^render;dur=\d/);
  });
});

describe("/aac/ -- reading ?q= through Hono", () => {
  // `c.req.query("q") ?? ""`. Django's `request.GET.get("q", "")` gives the
  // same empty string for a missing parameter, and both then fail the
  // two-character minimum. Without the `?? ""` the value is `undefined`,
  // `rawQuery.trim()` throws, and Hono's onError turns the hottest endpoint on
  // the site into a 500 HTML page.
  //
  // The stronger half of the claim is the second assertion: nothing was
  // prepared, so the guard ran before D1 rather than after it.
  it("treats an absent q as an empty query and never reaches D1", async () => {
    const res = await get("/aac/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("[]");
    expect(prepared).toHaveLength(0);
  });

  it("treats ?q= with an empty value the same way", async () => {
    expect(await (await get("/aac/?q=")).text()).toBe("[]");
    expect(prepared).toHaveLength(0);
  });

  // The parameter name is case-sensitive -- ?Q= is not ?q=. Pinned because it
  // is the kind of thing a reader assumes is normalised, and because the
  // failure is a silent empty dropdown rather than an error.
  it("reads only the lower-case q", async () => {
    expect(await (await get("/aac/?Q=el")).text()).toBe("[]");
    expect(prepared).toHaveLength(0);
  });

  // `+` MEANS SPACE. This is Hono's query decoding, not something aac.ts
  // chooses, and the whole spaced-postcode half of the feature rests on it: a
  // browser form-encodes "sw1a 1aa" as "sw1a+1aa", and if that arrived as a
  // literal plus the postcode range scan would look for "SW1A+1AA" and return
  // nothing at all, with a 200. Both spellings are asserted, because a client
  // using encodeURIComponent sends the %20 form and both must work.
  it("decodes + and %20 alike, so a postcode typed with a space still matches", async () => {
    const expected = '[{"n":"SW1A 1AA","l":"51.50,-0.14","t":"c","c":"Greater London"}]';

    expect(await (await get("/aac/?q=sw1a+1aa")).text()).toBe(expected);
    expect(await (await get("/aac/?q=sw1a%201aa")).text()).toBe(expected);
  });

  // ...and the same decoding on the PLACE side, where the space must NOT be
  // stripped. packages/db's searchAddressAutocomplete hands the place passes
  // the query as typed and only the postcode pass the space-stripped form; the
  // route's job is simply to deliver the space intact. "Weston super Mare" is
  // the fixture's only multi-word name, so this is the only query in the file
  // that can show it arrived.
  it("passes an interior space through to the place search", async () => {
    expect(await (await get("/aac/?q=weston+super")).text()).toBe(
      '[{"n":"Weston super Mare","l":"51.35,-2.98","t":"p","c":"Somerset"}]',
    );
  });

  // An apostrophe reaches the handler decoded, and survives all the way into
  // the FTS5 phrase -- "King's Lynn" and "Bishop's Stortford" are ordinary UK
  // place names, and an unquoted apostrophe is an FTS5 syntax error (a 500 on
  // real traffic, green on every smoke test). packages/db owns the quoting;
  // what this asserts is that the route does not mangle or reject the
  // character on the way in.
  it("passes an encoded apostrophe through without a 500", async () => {
    const res = await get("/aac/?q=king%27s");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("[]");
    expect(prepared.some((p) => p.params.includes("\"KING'S\""))).toBe(true);
  });

  // A MALFORMED PERCENT-ESCAPE IS NOT A 500. `?q=a%zz` is two keystrokes to
  // send at an endpoint that is uncredentialed, CORS-open and the busiest on
  // the site, so it matters that decodeURIComponent's URIError is not what
  // happens: Hono falls back to the raw, undecoded string, which then goes
  // through the ordinary query path and finds nothing. Run against Hono 4.13.7
  // rather than assumed -- `%`, `%00`, `%ff%fe` and a truncated multi-byte
  // sequence all behave the same way. Pinned here because it is Hono's
  // behaviour and not this route's, so a router upgrade that started throwing
  // would show up as this test failing rather than as a 500 in production.
  it("does not 500 on a malformed percent-escape", async () => {
    const res = await get("/aac/?q=a%zz");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("[]");
  });

  // A repeated parameter takes the FIRST value. Hono exposes both -- query()
  // gives the first, queries() the whole array -- so this is a real choice
  // rather than the only option, and "Zzz Excluded" is seeded precisely so the
  // two answers are visibly different. It matters because ?q=a&q=b is trivial
  // to send and the second value must not be able to steer the query.
  it("uses the first q when the parameter is repeated", async () => {
    expect(await (await get("/aac/?q=ely&q=zzz")).text()).toBe(`[${ELY},${NEW_ELY}]`);
  });

  // The 40-character cap (PLAN.md §4.8.6's guard against D1's 50-byte
  // LIKE/GLOB limit) is a deliberate divergence -- Django has no upper bound at
  // all -- and it has to hold at the HTTP boundary, because this endpoint takes
  // arbitrary uncredentialed input from anywhere. 40 characters issues the
  // three statements; 41 issues none, and still answers 200 with the same
  // day-long Cache-Control, so a flood of over-long queries is absorbed by the
  // edge rather than by D1.
  it("refuses a 41-character q before D1, while 40 still queries", async () => {
    await get(`/aac/?q=${"a".repeat(40)}`);
    expect(prepared).toHaveLength(3);

    prepared.length = 0;
    const res = await get(`/aac/?q=${"a".repeat(41)}`);
    expect(prepared).toHaveLength(0);
    expect(await res.text()).toBe("[]");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  // ONE D1 SESSION PER REQUEST, from lib/session.ts's dbSession(). The database
  // has read replication enabled, so a request that opened a session per query
  // could see a partial-write view across its three reads -- a place present in
  // one pass and missing from the next. Both handlers call dbSession() exactly
  // once and hand the same session to every query; the three statements below
  // arriving under a single withSession() is what says so.
  it("opens exactly one D1 session for the three queries", async () => {
    await get("/aac/?q=ely");

    expect(sessions).toBe(1);
    expect(prepared).toHaveLength(3);
  });
});

// ======================== /aac/next/ -- the other half ======================

describe("/aac/next/ -- the speculative endpoint", () => {
  // A DIFFERENT ENVELOPE FROM /aac/. This one is an OBJECT with a single "next"
  // key wrapping the bucket map, where /aac/ is a bare array. Two endpoints
  // built from the same rows in the same file is exactly the shape in which a
  // copy-paste emits the wrong envelope, and the client -- which reads
  // `json.next[char]` -- would get `undefined` for every bucket and silently
  // fall back to the round trip this feature exists to remove. No error, no
  // status change, just the feature quietly not working.
  //
  // The KEY ORDER is asserted as emitted, and it is not the insertion order:
  // the handler inserts places before codes (Ely -> "Y", Elgin -> "G", then the
  // postcode's "1"), but "1" is an array-index-shaped key, so JSON.stringify
  // hoists it in front of the string keys. Harmless -- the client looks buckets
  // up by name -- and pinned because an exact-body assertion has to say what
  // the body actually is rather than what the insertion order suggests.
  it("wraps the buckets in a next key, one bucket per possible next character", async () => {
    const res = await get("/aac/next/?q=el");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`{"next":{"1":[${EL1_1AA}],"Y":[${ELY}],"G":[${ELGIN}]}}`);
  });

  // The empty case keeps the envelope: `{"next":{}}`, not `{}` and not `[]`.
  // packages/db returns an empty OBJECT here (not the empty ARRAY its sibling
  // returns), and the route wraps it either way -- so a client that reads
  // `json.next` never has to handle a missing key.
  it("keeps the envelope when there is nothing to speculate about", async () => {
    expect(await (await get("/aac/next/")).text()).toBe('{"next":{}}');
    expect(prepared).toHaveLength(0);

    // ...and when the query ran but produced no buckets, which is a different
    // path through the handler: "ely" reaches the end of both "Ely" and the
    // occurrence inside "New Ely", so every candidate next character is
    // undefined and no bucket is created.
    expect(await (await get("/aac/next/?q=ely")).text()).toBe('{"next":{}}');
    expect(prepared).toHaveLength(3);
  });

  // CACHED HARDER THAN /aac/, AND THAT IS THE POINT. A week here against a day
  // there, spelled out in the handler's comment: these buckets are only ever a
  // hint that the real request immediately corrects, so a stale one costs
  // nothing. The two values are asserted TOGETHER because the failure mode is
  // not "the number is wrong" but "the two routes were given the same number" --
  // which is what a copy-paste produces and what neither route's own test would
  // notice in isolation.
  it("caches for a week, and independently of the day on /aac/", async () => {
    const next = await get("/aac/next/?q=el");
    const results = await get("/aac/?q=el");

    expect(next.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect(results.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(next.headers.get("Cache-Control")).not.toBe(results.headers.get("Cache-Control"));
  });

  // Same JSON content type and same open CORS as its sibling: it is called by
  // the same widget on the same third-party pages, so a header set on one route
  // and forgotten on the other breaks the speculative half only -- i.e. breaks
  // it in the way nobody reports, because everything still works, just slower.
  it("sets the same JSON and CORS headers as /aac/", async () => {
    const res = await get("/aac/next/?q=el");

    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("also opens exactly one D1 session, and refuses an over-long q", async () => {
    await get("/aac/next/?q=el");
    expect(sessions).toBe(1);

    prepared.length = 0;
    expect(await (await get(`/aac/next/?q=${"a".repeat(41)}`)).text()).toBe('{"next":{}}');
    expect(prepared).toHaveLength(0);
  });
});

// ============================ routing and method ===========================

describe("/aac/ -- what the router will and will not answer", () => {
  // NOT REGISTERED UNDER A LOCALE PREFIX, and that is Django parity rather than
  // an omission: address_autocomplete sits in urls.py's "Untranslated pages"
  // block (givefood/urls.py:72), outside i18n_patterns, so /cy/aac/ has never
  // existed. index.ts's locale loop deliberately skips both routes.
  //
  // The check is "the 404 PAGE rendered", not just the status, and it is made
  // on the content type rather than on the heading text: the three prefixed
  // 404s render in Welsh, Irish and Gaelic through the real i18n pipeline, so
  // a heading match would only be asserting the .po files. `/en/aac/` is
  // included as the fourth case and IS matched on the English heading -- "en"
  // is never a URL prefix here (see resolveLanguage.ts's PREFIXES), so it 404s
  // like any other unknown first segment while still rendering in English.
  it("does not exist under a locale prefix", async () => {
    for (const path of ["/cy/aac/?q=el", "/ga/aac/?q=el", "/gd/aac/next/?q=el"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    }

    const en = await get("/en/aac/?q=el");
    expect(en.status).toBe(404);
    expect(await en.text()).toContain("<h1>404 - Not Found</h1>");

    expect(prepared).toHaveLength(0);
  });

  // GET ONLY. Registered with app.get, so a POST does not reach the handler at
  // all -- it falls through to app.notFound(). Asserted with the database
  // untouched as well as with the status, which is the assertion that would
  // survive someone re-registering this as app.all: a handler that ran and
  // returned [] for a POST would still be a 404-shaped test failure here only
  // because of the `prepared` check.
  it("does not answer POST, and a POST reaches no query at all", async () => {
    const res = await request("/aac/?q=el", { method: "POST" });

    expect(res.status).toBe(404);
    expect(prepared).toHaveLength(0);
  });

  // No OPTIONS handler either, so a preflight 404s. That is fine and is why it
  // is pinned rather than treated as a gap: this endpoint is a simple GET with
  // no custom request headers and no credentials, so no browser ever sends a
  // preflight for it -- the ACAO on the GET response is the whole CORS story.
  // If a caller ever needs a preflight, this test is where the absence is
  // recorded.
  it("answers no CORS preflight, because a simple GET needs none", async () => {
    const res = await request("/aac/?q=el", { method: "OPTIONS" });

    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  // Hono answers HEAD from the GET registration with the headers and no body,
  // which matters twice over: caches and probes use it, and lib/appendSlash.ts
  // decides whether to issue the redirect below by HEADing the slashed URL --
  // so if HEAD stopped being answered here, /aac?q=... would stop redirecting.
  it("answers HEAD with the headers and no body", async () => {
    const res = await request("/aac/?q=el", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // APPEND_SLASH, and specifically THE QUERY STRING SURVIVING IT. Django's
  // APPEND_SLASH redirect is reproduced in lib/appendSlash.ts, which rebuilds
  // the URL from the whole request URL rather than from the path; drop the
  // query on the way and /aac?q=hackney becomes /aac/, which answers 200 with
  // an empty array -- a working-looking endpoint that has silently lost the
  // user's input. A 301 as well, matching Django.
  it("redirects the slash-less URL, carrying ?q= with it", async () => {
    const res = await get("/aac?q=el");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/aac/?q=el`);

    const next = await get("/aac/next?q=el");
    expect(next.status).toBe(301);
    expect(next.headers.get("Location")).toBe(`${ORIGIN}/aac/next/?q=el`);
  });
});

describe("/aac/ -- when D1 is the thing that fails", () => {
  // A DOWNSTREAM FAILURE PRODUCES THE SITE'S HTML 500, NOT JSON. There is no
  // try/catch in the handler, so a rejected D1 read unwinds to index.ts's
  // app.onError, which renders 500.njk. Two consequences worth having written
  // down, because both are surprising from the client's side:
  //
  //   * the response is text/html, so a caller doing `await res.json()` gets a
  //     parse error rather than a status they can branch on;
  //   * the CORS header is gone -- it lives on the handler's own Response --
  //     so a cross-origin caller sees an opaque CORS failure and cannot even
  //     read the 500. That is the correct default (an error page is not a CORS
  //     resource) but it does mean the browser console blames CORS for what is
  //     actually a database outage.
  //
  // Pinned as-is, and the console.error is asserted too: on an unattended
  // endpoint the log line is the only way this becomes visible at all.
  it("renders the HTML 500 page and logs, rather than an empty array", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = env({
      DB: {
        withSession: () => ({
          prepare: () => ({
            bind: () => ({
              all: async () => {
                throw new Error("D1_ERROR: no such table: place");
              },
            }),
          }),
          getBookmark: () => null,
        }),
      } as unknown as D1Database,
    });

    const res = await get("/aac/?q=el", broken);

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await res.text()).toContain("<h1>500 - Internal Server Error</h1>");
    expect(logged).toHaveBeenCalled();
  });
});
