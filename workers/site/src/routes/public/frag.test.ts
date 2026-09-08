import { DatabaseSync } from "node:sqlite";
import { FRAG_KV_KEY_LAST_UPDATED, FRAG_KV_KEY_NEED_HITS } from "@givefood/db";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/public/frag.ts -- the four client-side-include fragments. Django's
// `frag()` at givefood/views.py:1026-1069 (read alongside this file: the
// four-value whitelist, the `if not frag_text: HttpResponseForbidden()` and
// the featured-articles queryset below are all from it).
//
// WHY THIS FILE EXISTS. Every one of the four branches fails INVISIBLY.
//
//   * ip-address is the one response on this site that is genuinely
//     per-visitor, and it has ALREADY leaked once: the module's own comment
//     records `cf-cache-status: HIT, age: 1427` on production 2026-09-07 with
//     a stranger's IPv6 address in the body. The four headers that stop that
//     are the only thing standing between "correct-looking 200" and handing
//     one visitor's IP to the next 13,000 askers, and nothing about the body
//     changes when they go missing.
//   * last-updated and need-hits are served out of KV, written by a cron in a
//     SEPARATE, INDEPENDENTLY DEPLOYABLE WORKER (workers/jobs'
//     fragRefresh). The two halves agree only on the exact bytes stored under
//     two key names, and a disagreement is a 403 on the busiest widget on the
//     homepage -- see "the KV cache contract" block at the bottom, which is
//     the reason this file imports the key constants rather than retyping
//     them.
//   * need-hits' whole job is a number. A window boundary off by one day
//     changes it by an order of magnitude and still renders a plausible
//     figure with a 200.
//   * news is raw HTML dropped into innerHTML by csi.js -- no page chrome to
//     look wrong, so a lost `featured = 1` filter or a lost limit just shows
//     different articles.
//
// So every test below reads the BODY (or the row, or the KV value), never
// merely the status.
//
// REAL EVERYTHING, the same harness as routes/public.test.ts and
// routes/public/aac.test.ts: the real production app (workers/site/src/index.ts's
// default export), so the whitelist really is enforced by index.ts's path
// constraint, resolveLanguage really picks the locale, pageCacheControl and
// cacheTag really run on the way out; real Nunjucks templates; and real
// in-memory SQLite built by schemaFor() from the real migrations, so the
// three queries run against the columns production has. Mocked: only the KV
// namespace (no local double) and the D1 Sessions wrapper over node:sqlite.
//
// MUTATION-TESTED, in a copy of the repo outside it: 26 deliberate breakages
// of frag.ts -- each of the four ip-address headers, the X-Forwarded-For
// fallback re-added, the ip-address branch skipped, FRAG_TTL, the seven-day
// window, the five-article limit, the featured filter, intcomma dropped, the
// KV write-back removed, a formatted value cached instead of a raw one, the
// two KV keys swapped, a null cached, `cached !== null` weakened to `cached`,
// the read try/catch removed, parseInt for Number, `!cachedOrComputed` for
// `!total`, the 403 guard disabled, mapArticleRow dropped, show_time passed,
// the news Content-Type and Cache-Control, the locale hardcoded, a D1 session
// opened on the ip-address path, and `new Date()` frozen. All 26 were caught.
// That is the evidence these assertions are load-bearing rather than
// decorative.

const ORIGIN = "https://www.givefood.org.uk";

// U+00A0. timesince()'s avoid_wrapping port puts a non-breaking space between
// the count and the unit, so "1 hour ago" as typed by a human is NOT what this
// endpoint serves. Spelled as a constant because a test written with an ASCII
// space here fails for a reason nobody can see in the diff -- and because that
// exact confusion is the live bug pinned in lib/timesince.test.ts.
const NB = " ";

// Tuesday 8 September 2026, 09:30 UTC.
//
// FROZEN, because two of the four branches are functions of "now": need-hits
// computes its window as `isoDate(Date.now() - 7 days)` -> "2026-09-01", and
// last-updated renders a duration. vitest.config.mts pins TZ=UTC, so
// toISOString()'s date and a Worker's date are the same day here, as they are
// in production.
const NOW = new Date("2026-09-08T09:30:00.000Z");

type Bindable = null | number | bigint | string | Uint8Array;

// One statement as it reached the engine: SQL text plus the values bound to
// it. The bindings matter as much as the text here -- the seven-day window
// and the five-article limit are computed in frag.ts and never appear in the
// SQL, so they are only visible as parameters.
interface Prepared {
  sql: string;
  params: Bindable[];
}

// The slice of the D1 Sessions API packages/db uses, over node:sqlite --
// copied from routes/public.test.ts rather than reinvented.
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

// Every KV call this request made, in order. "Did it read KV at all" and "did
// it write back" are the two claims the module's header makes about the fast
// path, and neither is visible in the response body.
interface KvOp {
  op: "get" | "put";
  key: string;
  value?: string;
}

let db: DatabaseSync;
let prepared: Prepared[];
let sessions: number;
let kv: Map<string, string>;
let kvOps: KvOp[];
// KV failing is treated as a cache miss by design ("should be fast", not
// "must be present"), and that branch is only reachable by making the binding
// throw -- there is no local KV double that can be induced to fail.
let kvFail: { get?: boolean; put?: boolean };
let errors: unknown[][];

function env(): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: {
      get: async (key: string) => {
        kvOps.push({ op: "get", key });
        if (kvFail.get) throw new Error("KV get failed");
        return kv.get(key) ?? null;
      },
      put: async (key: string, value: string) => {
        kvOps.push({ op: "put", key, value });
        if (kvFail.put) throw new Error("KV put failed");
        kv.set(key, value);
      },
      delete: async (key: string) => void kv.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seeds. Only the columns these three queries read are parameterised; the rest
// are whatever the real migration insists on, so a seeded row is one
// production would have accepted.
// ---------------------------------------------------------------------------

// `modified` is TEXT compared lexicographically by MAX(), and every fixture
// timestamp is written in Django's own spelling -- "2026-09-05 19:28:08.853000",
// a space and six digits of microseconds. The last test in the last-updated
// block is what happens when a row arrives in some other one.
function seedFoodbank(id: number, slug: string, name: string, modified: string): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, network,
       charity_just_foodbank, contact_email, url, shopping_list_url, address_is_administrative,
       is_closed, no_locations, days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', 'Trussell Trust',
       0, ?, ?, ?, 0, 0, 0, 14, '2020-01-01 00:00:00.000000', ?)`,
  ).run(id, String(id).padStart(32, "a"), name, slug, `info@${slug}.invalid`, `https://${slug}.invalid/`, `https://${slug}.invalid/list/`, modified);
}

function seedHit(foodbankId: number, day: string, hits: number): void {
  db.prepare("INSERT INTO foodbankhit (foodbank_id, day, hits) VALUES (?, ?, ?)").run(foodbankId, day, hits);
}

function seedArticle(o: { id: number; foodbankId: number; publishedDate: string; title: string; url: string; featured?: 0 | 1 }): void {
  db.prepare("INSERT INTO foodbankarticle (id, foodbank_id, published_date, title, url, featured) VALUES (?, ?, ?, ?, ?, ?)").run(
    o.id,
    o.foodbankId,
    o.publishedDate,
    o.title,
    o.url,
    o.featured ?? 1,
  );
}

// THE FIXTURE IS THE TEST, so each row exists to turn exactly one rule on or
// off relative to its neighbour.
//
// Food banks -- the newest `modified` is vineyard's, exactly one hour before
// NOW, so last-updated renders "1 hour ago" and any MAX() that picked a
// different row would say "2 days" or "6 years" instead of a value one digit
// away.
//
// Hits -- the window is `day >= 2026-09-01` with NO UPPER BOUND (Django's
// `day__gte` and nothing else), and the four included rows sum to 1234567,
// which intcomma prints with two separators:
//     2026-09-01     1000000   the boundary day itself -- INCLUDED
//     2026-09-08      234000   today
//     2026-09-07          67
//     2026-09-09         500   THE FUTURE -- included, deliberately
//     2026-08-31     9000000   one day too old -- EXCLUDED
// Losing the lower bound gives 10,234,567; excluding the future row gives
// 1,234,067; both are wrong in a way no reader of the page could detect,
// which is why the numbers are chosen to differ in a visible digit.
//
// Articles -- two featured, plus a non-featured one dated two days LATER than
// either, so a lost `featured = 1` filter puts the wrong story first rather
// than last.
function seed(): void {
  seedFoodbank(1, "salisbury-foodbank", "Salisbury Foodbank", "2026-09-05 19:28:08.853000");
  seedFoodbank(2, "vineyard", "St. Mary's Foodbank & Pantry", "2026-09-08 08:30:00.000000");
  seedFoodbank(3, "bath-foodbank", "Bath Foodbank", "2020-01-01 00:00:00.000000");

  seedHit(1, "2026-09-01", 1000000);
  seedHit(2, "2026-09-08", 234000);
  seedHit(3, "2026-09-07", 67);
  seedHit(3, "2026-09-09", 500);
  seedHit(1, "2026-08-31", 9000000);

  seedArticle({ id: 1, foodbankId: 1, publishedDate: "2026-09-06", title: "FOODBANK APPEALS FOR uht MILK.", url: "https://news.invalid/one?utm_source=tw" });
  seedArticle({ id: 2, foodbankId: 2, publishedDate: "2026-09-04", title: "volunteers needed", url: "https://news.invalid/two" });
  seedArticle({ id: 3, foodbankId: 3, publishedDate: "2026-09-08", title: "not featured", url: "https://news.invalid/three", featured: 0 });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(schemaFor("foodbank", "foodbankhit", "foodbankarticle"));
  seed();
  prepared = [];
  sessions = 0;
  kv = new Map();
  kvOps = [];
  kvFail = {};
  // frag.ts logs to console.error on both KV failure paths, and those logs are
  // the only trace a KV outage leaves. Captured rather than silenced so the
  // fallback tests can assert the message actually went somewhere.
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
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
const body = async (path: string, init?: RequestInit): Promise<string> => (await get(path, init)).text();

const puts = (): KvOp[] => kvOps.filter((o) => o.op === "put");

// ---------------------------------------------------------------------------
// The whitelist. Django's frag() opens with `if frag not in allowed_frags:
// raise Http404()`; the port deletes that check and relies on index.ts's
// `:frag{ip-address|last-updated|need-hits|news}` path constraint instead
// (frag.ts's header says so explicitly). That is a load-bearing claim -- the
// handler would happily fall through to the news branch for ANY unrecognised
// value, so if the constraint stopped constraining, /frag/anything/ would
// serve the news fragment with a 200 instead of a 404.
// ---------------------------------------------------------------------------

describe("the four-value whitelist, enforced by the router rather than the handler", () => {
  it("answers all four allowed fragments", async () => {
    for (const slug of ["ip-address", "last-updated", "need-hits", "news"]) {
      expect((await get(`/frag/${slug}/`)).status, slug).toBe(200);
    }
  });

  // Django raised Http404 for anything else. Each of these is a different way
  // the constraint could be loosened: a bare word, a near-miss of a real
  // value, a value that has one of the four as a PREFIX or a SUFFIX (which is
  // what an unanchored regex would let through and would be served as news),
  // and a case variation.
  it("404s an unrelated value, exactly as Django's Http404 did", async () => {
    for (const slug of ["needs", "lastupdated", "NEWS", "ip_address", "newsX", "xip-address", "news-extra", ""]) {
      const res = await get(`/frag/${slug}/`);
      expect(res.status, slug).toBe(404);
      // And it is the 404 PAGE, not a fragment that happens to carry a 404:
      // the handler's fall-through branch is news, so "404 status, news body"
      // is a distinct and reachable wrong answer.
      expect(await res.text(), slug).not.toContain('<ul class="foodbank-news">');
    }
  });

  // SUSPECT, PINNED AS-IS -- and the reason the test above lists the values it
  // does rather than "anything else".
  //
  // frag.ts's header claims index.ts's path constraint "404s any other value
  // the same way Django's `if frag not in allowed_frags: raise Http404()`
  // does". IT DOES NOT. Measured here against the real router: the constraint
  // behaves as an UNANCHORED substring match, and the four values differ in
  // which end is loose --
  //
  //     /frag/ip-addressX/      200, echoes the caller's IP
  //     /frag/zzlast-updated/   200, the duration
  //     /frag/last-updatedX/    200, the duration
  //     /frag/0need-hits/       200, the number
  //     /frag/extra-news/       200, the news fragment
  //
  // while /frag/xip-address/ and /frag/newsX/ (above) do 404. The captured
  // param is the MATCHED SUBSTRING, not the requested segment -- proved by
  // /frag/0need-hits/ serving need-hits: the handler compares `slug ===
  // "need-hits"` exactly, so a param of "0need-hits" would have fallen
  // through to news instead.
  //
  // Consequences, in order of how much they matter: every one of these is a
  // separate edge cache key for identical bytes (unbounded, attacker-chosen,
  // and /frag/news/ is cached for an hour), and Django's 404 for the same URL
  // is now a 200, which is a visible parity divergence for anything crawling
  // or monitoring the site. Not a data leak: /frag/ip-addressX/ inherits the
  // real branch's no-store headers along with its body.
  //
  // Pinned rather than fixed, per this repo's rule. The fix belongs in
  // index.ts (wrap the alternation), not here.
  it("also answers unanchored near-misses with a 200 (suspect, pinned -- the constraint is not the whitelist it claims to be)", async () => {
    expect(await body("/frag/ip-addressX/", { headers: { "CF-Connecting-IP": "203.0.113.42" } })).toBe("203.0.113.42");
    expect(await body("/frag/zzlast-updated/")).toBe(`1${NB}hour ago`);
    expect(await body("/frag/last-updatedX/")).toBe(`1${NB}hour ago`);
    expect(await body("/frag/0need-hits/")).toBe("1,234,567");
    expect(await body("/frag/extra-news/")).toContain('<ul class="foodbank-news">');

    // And under a locale prefix too -- the same registration, looped.
    expect(await body("/cy/frag/0need-hits/")).toBe("1,234,567");
    expect(await body("/cy/frag/xnews/")).toContain('<ul class="foodbank-news">');
  });

  // givefood/urls.py:27 puts frag() inside i18n_patterns, so all three
  // prefixed locales route -- and "en" is never a prefix (Django's
  // prefix_default_language=False, resolveLanguage's PREFIXES set), so /en/
  // is a 404 rather than a second spelling of the same fragment.
  it("routes under cy/ga/gd but not under en", async () => {
    for (const locale of ["cy", "ga", "gd"]) {
      expect((await get(`/${locale}/frag/news/`)).status, locale).toBe(200);
    }
    expect((await get("/en/frag/news/")).status).toBe(404);
  });

  // app.get, not app.all. Worth pinning: the news branch runs a query and the
  // KV branches WRITE, so a stray app.all here would put a cache write on a
  // POST -- and Django's frag() has no @require_POST twin to fall back on.
  it("does not answer a POST", async () => {
    expect((await get("/frag/news/", { method: "POST" })).status).toBe(404);
    expect(puts()).toEqual([]);
  });

  // APPEND_SLASH (lib/appendSlash.ts), reached through app.notFound(). The
  // trailing slash is part of the registered path, so csi.js requesting the
  // unslashed form gets a 301 rather than a 404.
  it("301s the unslashed form to the slashed one", async () => {
    const res = await get("/frag/news");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/frag/news/`);
  });
});

// ---------------------------------------------------------------------------
// ip-address -- the branch with a live incident behind it.
// ---------------------------------------------------------------------------

describe("/frag/ip-address/", () => {
  it("echoes CF-Connecting-IP verbatim as text/plain", async () => {
    const res = await get("/frag/ip-address/", { headers: { "CF-Connecting-IP": "203.0.113.42" } });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("203.0.113.42");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("passes an IPv6 address through unaltered", async () => {
    // The address in the production leak was IPv6, and it is the form most
    // likely to be mangled by a well-meaning normalisation.
    expect(await body("/frag/ip-address/", { headers: { "CF-Connecting-IP": "2a00:23c7:8c04:6f01:4c1:38ff:fe0b:d9a1" } })).toBe(
      "2a00:23c7:8c04:6f01:4c1:38ff:fe0b:d9a1",
    );
  });

  // THE FOUR HEADERS THIS ENDPOINT EXISTS TO CARRY. Observed on production
  // 2026-09-07 (frag.ts's own comment): with no Cache-Control of its own this
  // response was stamped `public, max-age=300, s-maxage=86400` by
  // pageCacheControl and came back a HIT at age 1427 with ANOTHER VISITOR'S
  // IPv6 address in it. CDN-Cache-Control is the load-bearing one -- the zone
  // Cache Rule ignores a private/absent Cache-Control and only `no-store`
  // there stops it -- and Vary is what keeps a per-IP response keyed by IP if
  // anything caches it anyway.
  //
  // Kills the mutant that deletes any one of the four lines.
  it("is nailed shut against every cache, twice over", async () => {
    const res = await get("/frag/ip-address/", { headers: { "CF-Connecting-IP": "203.0.113.42" } });

    expect(res.headers.get("Cache-Control")).toBe("private, no-store, max-age=0, must-revalidate");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toBe("CF-Connecting-IP");
  });

  // The other half of that incident: pageCacheControl's "never override"
  // guard. text/plain came OFF its cacheable list for this exact response, so
  // there are now two independent reasons this cannot be stamped public --
  // asserted together, because either one alone leaves the page one edit from
  // leaking again.
  it("is not restamped public by pageCacheControl", async () => {
    const res = await get("/frag/ip-address/", { headers: { "CF-Connecting-IP": "203.0.113.42" } });
    expect(res.headers.get("Cache-Control")).not.toContain("public");
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage");
  });

  // Django's get_user_ip() can return "" for a non-proxied request and the
  // view returns that empty body -- it never 403s here, unlike the two KV
  // branches. So an absent header is a 200 with nothing in it, NOT the
  // `if not frag_text` path (which this branch returns before ever reaching).
  it("returns an empty 200, not a 403, when Cloudflare set no header", async () => {
    const res = await get("/frag/ip-address/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  // DELIBERATELY NOT PORTED, per frag.ts's own comment: Django's
  // get_user_ip() falls back to X-Forwarded-For/REMOTE_ADDR, and
  // X-Forwarded-For is attacker-suppliable in a way CF-Connecting-IP is not.
  // Pinned as a security property: a request that sets XFF and nothing else
  // gets an empty body, so nobody can make this endpoint echo a value of
  // their choosing to a caching layer.
  it("ignores X-Forwarded-For entirely", async () => {
    expect(await body("/frag/ip-address/", { headers: { "X-Forwarded-For": "198.51.100.9, 203.0.113.1" } })).toBe("");
    // And it does not merely prefer CF-Connecting-IP -- XFF loses even when
    // it is the more specific-looking header.
    expect(await body("/frag/ip-address/", { headers: { "X-Forwarded-For": "198.51.100.9", "CF-Connecting-IP": "203.0.113.42" } })).toBe("203.0.113.42");
  });

  // Django returns early here "not cached, user-specific" and touches no
  // model; the port returns before `dbSession(c)` is even called. Asserted on
  // the bindings rather than inferred, because this is the branch every
  // visitor to every page hits via csi.js -- a query or a KV read added here
  // is a per-pageview cost on the whole site.
  it("opens no D1 session and touches no KV", async () => {
    await get("/frag/ip-address/", { headers: { "CF-Connecting-IP": "203.0.113.42" } });

    expect(sessions).toBe(0);
    expect(prepared).toEqual([]);
    expect(kvOps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// last-updated
// ---------------------------------------------------------------------------

describe("/frag/last-updated/", () => {
  // The cold path: nothing in KV, so it runs the same query the cron runs and
  // renders MAX(foodbank.modified) as a duration. vineyard's row is one hour
  // before NOW; salisbury's is three days before and bath's six years, so a
  // MAX() that picked either would be visibly wrong here.
  it("renders the newest foodbank.modified as a duration when KV is cold", async () => {
    const res = await get("/frag/last-updated/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`1${NB}hour ago`);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(prepared.map((p) => p.sql)).toEqual(["SELECT MAX(modified) AS modified FROM foodbank"]);
  });

  // FIVE MINUTES, matching the cron that refreshes the key behind it. The
  // number that matters is that it is NOT pageCacheControl's 24-hour
  // fallthrough: a value recomputed every five minutes served for a day is up
  // to 288 refreshes stale, and the page would show "3 minutes ago" all
  // afternoon.
  it("carries the five-minute TTL, not pageCacheControl's day", async () => {
    expect((await get("/frag/last-updated/")).headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  // THE FAST PATH THE WHOLE WORK PACKAGE EXISTS FOR (PLAN.md: "zero database
  // work per request"). A warm key must produce the answer with no statement
  // prepared at all -- a handler that read KV and then queried anyway would
  // pass every body assertion in this file.
  //
  // The KV value here is deliberately NOT the one in the database, so a
  // handler that queried anyway would render "1 hour ago" and fail on the
  // body as well as on the statement count. Two adjacent units, because
  // Django's timesince() has depth=2 and 07:00 is 2h30 before NOW.
  it("answers from KV without preparing a single statement", async () => {
    kv.set(FRAG_KV_KEY_LAST_UPDATED, "2026-09-08 07:00:00.000000");

    expect(await body("/frag/last-updated/")).toBe(`2${NB}hours, 30${NB}minutes ago`);
    expect(prepared).toEqual([]);
    expect(kvOps).toEqual([{ op: "get", key: FRAG_KV_KEY_LAST_UPDATED }]);
  });

  // The self-heal in frag.ts's header: a miss computes live AND writes back,
  // "rather than serving a 403 site-wide for up to 5 minutes after every
  // fresh deploy". The value written is the RAW TIMESTAMP, not the rendered
  // duration -- see the KV contract block at the bottom for why that
  // distinction is the difference between working and permanently broken.
  it("writes the computed value back so the next request is free", async () => {
    await get("/frag/last-updated/");

    expect(kv.get(FRAG_KV_KEY_LAST_UPDATED)).toBe("2026-09-08 08:30:00.000000");
    expect(puts()).toEqual([{ op: "put", key: FRAG_KV_KEY_LAST_UPDATED, value: "2026-09-08 08:30:00.000000" }]);

    // Second request through the warm key: same answer, no query.
    prepared = [];
    expect(await body("/frag/last-updated/")).toBe(`1${NB}hour ago`);
    expect(prepared).toEqual([]);
  });

  // THE STALENESS THAT BUYS THE SPEED, pinned so it is a decision rather than
  // a surprise. Once the key is warm this endpoint does not see the database
  // again until the cron overwrites it, so a food bank edited seconds ago
  // still reads as an hour old for up to five minutes. That is the design
  // (workers/jobs' "*/5 * * * *" fragRefresh), not a bug.
  it("keeps serving the cached value after the database moves on", async () => {
    await get("/frag/last-updated/");
    seedFoodbank(4, "truro-foodbank", "Truro Foodbank", "2026-09-08 09:29:00.000000");

    expect(await body("/frag/last-updated/")).toBe(`1${NB}hour ago`);
  });

  // Django: `Foodbank.objects.latest("modified")` raises DoesNotExist on an
  // empty table; the port's MAX() returns NULL and takes the shared
  // `if not frag_text: return HttpResponseForbidden()` path. An empty
  // foodbank table is reachable -- this is an ETL-loaded database
  // (tools/pg-to-d1) and a failed extract leaves it so.
  it("403s with an empty body when there is no foodbank at all", async () => {
    db.prepare("DELETE FROM foodbank").run();
    const res = await get("/frag/last-updated/");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    // And nothing is cached: a null result must not poison the key for the
    // next five minutes.
    expect(puts()).toEqual([]);
    expect(kv.has(FRAG_KV_KEY_LAST_UPDATED)).toBe(false);
  });

  // A 403 is not a 200, so pageCacheControl returns early on status and
  // cacheTag skips a non-ok response. Pinned because the alternative -- an
  // edge-cached 403 -- would keep the widget broken long after the data came
  // back.
  it("leaves the 403 uncacheable", async () => {
    db.prepare("DELETE FROM foodbank").run();
    const res = await get("/frag/last-updated/");

    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  // An empty string in KV is `!== null`, so readOrCompute returns it as a
  // HIT and never recomputes; `if (!modified)` then 403s. Reachable if a
  // writer ever stores "" (the cron guards against it with `if (modified)`,
  // but a truncated/garbled KV value is not something either side controls).
  // SUSPECT, PINNED AS-IS: unlike a miss, this does not self-heal -- the
  // fragment stays 403 until the next cron tick overwrites the key.
  it("403s rather than recomputing when KV holds an empty string (suspect, pinned)", async () => {
    kv.set(FRAG_KV_KEY_LAST_UPDATED, "");
    const res = await get("/frag/last-updated/");

    expect(res.status).toBe(403);
    expect(prepared).toEqual([]);
  });

  // KV DOWN IS NOT THE SITE DOWN. frag.ts treats a throwing get exactly like
  // a miss -- "a cache that's explicitly a 'should be fast,' not 'must be
  // present,' optimisation". The visitor still gets the right answer, from
  // the database, and the failure is logged rather than swallowed.
  it("falls back to a live query when the KV read throws", async () => {
    kvFail.get = true;
    const res = await get("/frag/last-updated/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`1${NB}hour ago`);
    expect(prepared.map((p) => p.sql)).toEqual(["SELECT MAX(modified) AS modified FROM foodbank"]);
    expect(errors[0]?.[0]).toBe(`frag: KV read of ${FRAG_KV_KEY_LAST_UPDATED} failed, falling back to a live query`);
  });

  // And a throwing PUT is non-fatal too: the caller gets a correct answer
  // this request, only the "next request is fast too" benefit is lost.
  it("still answers when the KV write-back throws", async () => {
    kvFail.put = true;
    const res = await get("/frag/last-updated/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`1${NB}hour ago`);
    expect(errors[0]?.[0]).toBe(`frag: KV write of ${FRAG_KV_KEY_LAST_UPDATED} failed`);
  });

  // givefood/views.py wraps timesince() with two _() strings, and this route
  // is inside i18n_patterns precisely so a Welsh page gets the Welsh wrapper.
  // "yn ôl" is the real msgstr from packages/templates' cy catalogue.
  //
  // THE DOCUMENTED TRANSLATION GAP is visible in the same string: the unit
  // word stays English, because Django's timesince() pulls its units from
  // Django's own bundled catalogues, which were never extracted into this
  // app's .po files (lib/timesince.ts says so at length). Asserted rather
  // than left to be rediscovered as a rendering bug.
  it("translates the wrapper word for a prefixed locale, leaving the unit in English", async () => {
    const res = await get("/cy/frag/last-updated/");

    expect(await res.text()).toBe(`1${NB}hour yn ôl`);
    expect(res.headers.get("Content-Language")).toBe("cy");
  });

  // The "Under a minute ago" branch is DEAD in both codebases: timesince()
  // returns "0<U+00A0>minutes" and both compare it against a literal built
  // with an ASCII space (`"0 %s" % _("minutes")` in Django,
  // `raw === "0 minutes"` here). lib/timesince.test.ts pins the unit; this
  // pins what the ENDPOINT therefore serves, because that is the string a
  // visitor actually sees seconds after an edit. Reported, not repaired --
  // fixing it here alone would break parity with the site being replaced.
  it("serves '0 minutes ago' for a just-edited food bank, never 'Under a minute ago' (Django's bug, ported)", async () => {
    kv.set(FRAG_KV_KEY_LAST_UPDATED, "2026-09-08 09:29:30.000000");

    const out = await body("/frag/last-updated/");
    expect(out).toBe(`0${NB}minutes ago`);
    expect(out).not.toBe("Under a minute ago");
    // Same on a locale that HAS the translation, which is what makes it
    // visible as a bug rather than a missing string.
    expect(await body("/cy/frag/last-updated/")).toBe(`0${NB}minutes yn ôl`);
  });

  // MAX() over TEXT is a lexicographic comparison, and "T" (0x54) sorts above
  // " " (0x20). So an ISO-8601 timestamp written by application code for the
  // SAME instant outranks every Django-format row in the table, and one
  // written for an EARLIER instant on the same day still wins.
  //
  // SUSPECT, PINNED AS-IS. D1's rows come from the Django-format ETL
  // (PLAN.md §4.4), so this is latent rather than live, but it is exactly the
  // failure mode TESTING.md warns about: a single toISOString() write into
  // this column would freeze the fragment on that row's timestamp.
  it("lets a 'T'-separated timestamp outrank a later Django-format one (suspect, pinned)", async () => {
    seedFoodbank(4, "truro-foodbank", "Truro Foodbank", "2026-09-08T06:00:00.000Z");

    // 06:00 with a "T" beats 08:30 with a space, so the answer is 3h30, not
    // 1 hour -- and it is not a parse failure: lib/timesince.ts's parseUtc
    // reads the "T" form and its trailing "Z" perfectly well, which is
    // exactly what makes this quiet rather than loud.
    expect(await body("/frag/last-updated/")).toBe(`3${NB}hours, 30${NB}minutes ago`);
  });
});

// ---------------------------------------------------------------------------
// need-hits
// ---------------------------------------------------------------------------

describe("/frag/need-hits/", () => {
  // The number, and the window that produces it. 1,000,000 + 234,000 + 67 +
  // 500 = 1,234,567; the 9,000,000 row one day outside the window is the
  // whole point of the fixture.
  it("sums the trailing seven days and formats with thousands separators", async () => {
    const res = await get("/frag/need-hits/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1,234,567");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  // THE WINDOW BOUND ITSELF, which never appears in the SQL text: the query
  // is `day >= ?` and the date is computed from Date.now() in frag.ts. Seven
  // days back from 2026-09-08 is 2026-09-01 -- the day whose 1,000,000 hits
  // are 81% of the total, so an off-by-one here is an 81% error on the
  // headline number with a perfectly plausible-looking page.
  it("binds exactly seven days back, inclusive", async () => {
    await get("/frag/need-hits/");

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.sql).toBe("SELECT SUM(hits) AS total FROM foodbankhit WHERE day >= ?");
    expect(prepared[0]?.params).toEqual(["2026-09-01"]);
  });

  // NO UPPER BOUND, matching Django's `day__gte` with no `day__lte` -- and
  // deliberately unlike getMostViewed(), whose sibling query DOES bound the
  // top of the window. packages/db/src/frag.ts says so; this is where it is
  // observable: the 2026-09-09 row is dated tomorrow and still counts.
  it("counts a future-dated row, unlike the homepage's most-viewed query", async () => {
    // Remove it and the total drops by exactly that row.
    db.prepare("DELETE FROM foodbankhit WHERE day = '2026-09-09'").run();
    expect(await body("/frag/need-hits/")).toBe("1,234,067");
  });

  // The fast path again, and the format it reads. The KV value is a plain
  // integer string; intcomma() is applied on the way OUT, every request.
  it("answers from KV without preparing a statement", async () => {
    kv.set(FRAG_KV_KEY_NEED_HITS, "4200");

    expect(await body("/frag/need-hits/")).toBe("4,200");
    expect(prepared).toEqual([]);
  });

  // The write-back stores the RAW total. This is the single most important
  // assertion in the file: intcomma()'s output round-trips through
  // Number() as NaN ("1,234,567" -> NaN), so a handler that cached its own
  // formatted answer would serve one correct response and then 403 forever,
  // because a non-null cache hit is never recomputed. Kills exactly that
  // mutant.
  it("caches the unformatted integer, not the formatted string", async () => {
    await get("/frag/need-hits/");

    expect(kv.get(FRAG_KV_KEY_NEED_HITS)).toBe("1234567");
    expect(puts()).toEqual([{ op: "put", key: FRAG_KV_KEY_NEED_HITS, value: "1234567" }]);
  });

  // The other side of that coin, as the failure it actually produces. A KV
  // value Number() cannot read is a hit, not a miss, so there is no live
  // fallback: the widget 403s until the cron overwrites the key.
  //
  // SUSPECT, PINNED AS-IS -- the module comment argues for Number() over
  // parseInt() precisely so a garbled value fails loudly rather than
  // truncating to "12", and it does; but "loudly" here means a 403 with no
  // self-heal, unlike every other failure path in this file.
  it("403s on a garbled KV value rather than truncating it (suspect: no self-heal)", async () => {
    for (const poison of ["1,234,567", "12abc", "not-a-number"]) {
      kv.set(FRAG_KV_KEY_NEED_HITS, poison);
      prepared = [];
      const res = await get("/frag/need-hits/");

      expect(res.status, poison).toBe(403);
      expect(await res.text(), poison).toBe("");
      // No recomputation: parseInt("12abc") would have served "12".
      expect(prepared, poison).toEqual([]);
    }
  });

  // "" is falsy before Number() is consulted, so it takes the same 403 -- and
  // is worth its own case because Number("") is 0, not NaN: the `!cachedOrComputed`
  // half of the guard is the only thing catching it.
  it("403s on an empty KV value", async () => {
    kv.set(FRAG_KV_KEY_NEED_HITS, "");
    expect((await get("/frag/need-hits/")).status).toBe(403);
  });

  // SQLite's SUM() over an empty set is NULL, same as Postgres's, matching
  // Django's aggregate()['hits__sum'] being None -- and Django's own
  // `if not frag_text` then 403s. Reachable on a fresh D1 or after a failed
  // extract.
  it("403s when no hit row falls inside the window", async () => {
    db.prepare("DELETE FROM foodbankhit").run();
    const res = await get("/frag/need-hits/");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(puts()).toEqual([]);
  });

  // A REAL ZERO IS NOT A NULL, and the two must not collapse: SUM() over rows
  // that all hold 0 is 0, String(0) is "0" -- a TRUTHY string -- so this
  // renders "0" with a 200 while the empty-set case above 403s. A guard
  // written as `if (!total)` on the number instead of on the string would
  // turn a real, publishable zero into a forbidden fragment.
  it("serves a genuine zero as '0', not as a 403", async () => {
    db.prepare("DELETE FROM foodbankhit").run();
    seedHit(1, "2026-09-03", 0);
    const res = await get("/frag/need-hits/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0");
    expect(kv.get(FRAG_KV_KEY_NEED_HITS)).toBe("0");
  });

  // And the cached zero survives the round trip, which is the case the
  // truthiness rules make easiest to get wrong: "0" as a KV hit is truthy,
  // Number("0") is 0, not NaN.
  it("serves a cached zero too", async () => {
    kv.set(FRAG_KV_KEY_NEED_HITS, "0");
    const res = await get("/frag/need-hits/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0");
  });

  it("falls back to a live query when the KV read throws", async () => {
    kvFail.get = true;
    const res = await get("/frag/need-hits/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1,234,567");
    expect(errors[0]?.[0]).toBe(`frag: KV read of ${FRAG_KV_KEY_NEED_HITS} failed, falling back to a live query`);
  });

  it("still answers when the KV write-back throws", async () => {
    kvFail.put = true;

    expect(await body("/frag/need-hits/")).toBe("1,234,567");
    expect(errors[0]?.[0]).toBe(`frag: KV write of ${FRAG_KV_KEY_NEED_HITS} failed`);
  });

  // intcomma is a pure number formatter with no locale entry, so the Welsh
  // fragment is the same digits. Pinned because the OTHER KV branch does
  // translate, and "which of the two is localised" is not guessable.
  it("is the same number in every locale", async () => {
    expect(await body("/cy/frag/need-hits/")).toBe("1,234,567");
    expect(await body("/gd/frag/need-hits/")).toBe("1,234,567");
  });
});

// ---------------------------------------------------------------------------
// news
// ---------------------------------------------------------------------------

// public/frags/news.njk emits, per article, a favicon <img>, the outbound link,
// and a second link back to the food bank followed by the date. Same reader as
// routes/public.test.ts's, because it is the same shared fragment -- the
// homepage embeds it server-side and this endpoint serves it to csi.js.
function newsItems(html: string): { favicon: string; href: string; title: string; foodbankHref: string; foodbank: string; date: string }[] {
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => {
    const li = m[1] as string;
    const favicon = /<img src="([^"]*)"/.exec(li)?.[1] ?? "";
    const links = [...li.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((a) => ({ href: a[1] as string, text: (a[2] as string).trim() }));
    const [outbound, backlink] = links;
    return {
      favicon,
      href: outbound?.href ?? "",
      title: outbound?.text ?? "",
      foodbankHref: backlink?.href ?? "",
      foodbank: backlink?.text ?? "",
      date: /<\/a>\s*([^<]*)<\/div>/.exec(li)?.[1]?.trim() ?? "",
    };
  });
}

describe("/frag/news/", () => {
  // A RAW FRAGMENT, not a page: csi.js drops this body straight into an
  // element's innerHTML, so page.njk's chrome appearing here would be visible
  // as a whole second copy of the site inside a homepage panel.
  it("is a bare <ul>, with no page chrome around it", async () => {
    const html = await body("/frag/news/");

    expect(html.trimStart().startsWith('<ul class="foodbank-news">')).toBe(true);
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<body");
    // debugcomment.njk's timestamp rides on buildPageContext()/page.njk, which
    // this branch deliberately does not use.
    expect(html).not.toContain("Generated at");
  });

  // Every field of the first item, from the real template through the real
  // url() helper: the favicon path, the outbound URL with Django's ref
  // parameter appended (and its & escaped), title_captialised's casing rules,
  // the backlink to the food bank's own page, and the "j M" date.
  it("renders each article's favicon, referred link, capitalised title, backlink and date", async () => {
    expect(newsItems(await body("/frag/news/"))[0]).toEqual({
      favicon: "/needs/at/salisbury-foodbank/favicon.png",
      href: "https://news.invalid/one?utm_source=tw&amp;ref=givefood.org.uk",
      title: "Foodbank Appeals For UHT Milk",
      foodbankHref: "/needs/at/salisbury-foodbank/",
      foodbank: "Salisbury Foodbank",
      date: "6 Sep",
    });
  });

  // Django: `FoodbankArticle.objects.filter(featured=True).order_by('-published_date')[:5]`.
  // The non-featured fixture row is dated 2026-09-08, two days AFTER both
  // featured ones, so a lost filter shows up at the TOP of the list.
  it("shows only featured articles, newest first", async () => {
    expect(newsItems(await body("/frag/news/")).map((a) => a.title)).toEqual(["Foodbank Appeals For UHT Milk", "Volunteers Needed"]);
  });

  // The [:5] slice, which is a constant in frag.ts and appears nowhere in the
  // SQL text -- so it is asserted both on the rendered list and on the bound
  // parameter.
  it("stops at five", async () => {
    for (let i = 0; i < 4; i += 1) {
      seedArticle({ id: 70 + i, foodbankId: 1, publishedDate: `2026-09-0${i + 1}`, title: `Story ${i}`, url: `https://news.invalid/x${i}` });
    }

    const titles = newsItems(await body("/frag/news/")).map((a) => a.title);

    expect(titles).toHaveLength(5);
    expect(titles).not.toContain("Story 0"); // 2026-09-01, the oldest of the six
    expect(titles).toContain("Story 3");
    expect(prepared[0]?.params).toEqual([5]);
  });

  // show_time IS DELIBERATELY OMITTED -- Django's frag() never passes it
  // either, so news.njk takes its `{% else %}` branch and renders "j M" with
  // no time component. With a date-only published_date the "j M P" branch
  // would append "midnight", which is both wrong and unmistakable.
  it("renders no time component, because show_time is never passed", async () => {
    const html = await body("/frag/news/");

    expect(html).toContain("6 Sep</div>");
    expect(html).not.toContain("midnight");
    expect(html).not.toContain("a.m.");
    expect(html).not.toContain("p.m.");
  });

  // An empty <ul>, a 200, and no throw. Reachable on a fresh D1 or when every
  // featured flag has been cleared; csi.js writes the body into the panel
  // either way, so an exception here would leave a half-rendered homepage.
  it("renders an empty list rather than failing when nothing is featured", async () => {
    db.prepare("UPDATE foodbankarticle SET featured = 0").run();
    const res = await get("/frag/news/");

    expect(res.status).toBe(200);
    expect(newsItems(await res.text())).toEqual([]);
  });

  // ONE HOUR, and text/html -- both set by the handler itself, so
  // pageCacheControl's "never override" guard is what keeps them. If that
  // guard broke, this fragment would take the middleware's HTML default
  // (`public, max-age=300, s-maxage=86400`) and go 24 times staler than the
  // /news/ page whose articles it duplicates.
  it("sets its own one-hour TTL, which the middleware does not override", async () => {
    const res = await get("/frag/news/");

    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
  });

  // SUSPECT, PINNED AS-IS. middleware/cacheTag.ts has no rule for /frag/, so
  // this response gets no Cache-Tag -- while the homepage, which embeds the
  // SAME fragment, is tagged fb-all and IS purged by queues/cachePurge.ts when
  // a food bank changes. So renaming a food bank updates the article's
  // backlink on the homepage immediately and leaves it stale in this fragment
  // for up to an hour. Cosmetic, but it is a real divergence between two
  // renders of one template.
  it("carries no Cache-Tag, so a food bank rename cannot purge it (suspect, pinned)", async () => {
    expect((await get("/frag/news/")).headers.get("Cache-Tag")).toBeNull();
  });

  // Inside i18n_patterns, so the backlink is locale-prefixed -- that is the
  // reason frag.ts's header gives for the route being registered per locale at
  // all. The favicon URL is NOT prefixed (it is a wfbn-generic route), and the
  // pair only differing in one of the two is exactly the sort of thing a
  // "helpfully" generalised url() would break.
  it("prefixes the food bank backlink for a locale, but not the favicon", async () => {
    const item = newsItems(await body("/cy/frag/news/"))[0];

    expect(item?.foodbankHref).toBe("/cy/needs/at/salisbury-foodbank/");
    expect(item?.favicon).toBe("/needs/at/salisbury-foodbank/favicon.png");
  });

  // Not a KV-backed fragment: news reads D1 on every request, which is why it
  // is the one branch with a longer TTL. Asserted on the bindings so a future
  // "cache this too" cannot arrive silently, and so this test fails loudly if
  // it does (at which point the KV contract block below applies to it as well).
  it("reads the database on every request and never touches KV", async () => {
    await get("/frag/news/");
    await get("/frag/news/");

    expect(kvOps).toEqual([]);
    expect(prepared).toHaveLength(2);
    expect(sessions).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The cross-Worker contract. These two keys are the entire interface between
// this route and workers/jobs' fragRefresh cron, which is a SEPARATE Worker
// with its own deploy. Nothing else connects them.
// ---------------------------------------------------------------------------

describe("the KV cache contract shared with the fragRefresh cron", () => {
  // The key names are a wire format, not an implementation detail: renaming
  // one deploys as "the cron writes A, the site reads B", which presents as
  // every fragment 403ing until someone thinks to look in KV. They live in
  // packages/db so both Workers import the same constant -- and this asserts
  // the literal values, so a rename is a deliberate act with a failing test
  // attached rather than a silent one.
  it("uses the exact key names both Workers import", () => {
    expect(FRAG_KV_KEY_LAST_UPDATED).toBe("frag:last-updated");
    expect(FRAG_KV_KEY_NEED_HITS).toBe("frag:need-hits");
  });

  // What fragRefresh actually writes (workers/jobs/src/scheduled/index.ts:304-310):
  //   env.DATA.put(FRAG_KV_KEY_LAST_UPDATED, modified)      -- the raw D1 timestamp
  //   env.DATA.put(FRAG_KV_KEY_NEED_HITS, String(total))    -- the raw integer
  // Both are reproduced here as literals and fed to the route, so this test
  // fails if either side ever starts storing a rendered value.
  it("reads the exact values the cron writes", async () => {
    kv.set(FRAG_KV_KEY_LAST_UPDATED, "2026-09-08 08:30:00.000000");
    kv.set(FRAG_KV_KEY_NEED_HITS, "1234567");

    expect(await body("/frag/last-updated/")).toBe(`1${NB}hour ago`);
    expect(await body("/frag/need-hits/")).toBe("1,234,567");
    expect(prepared).toEqual([]);
  });

  // AND WRITES BACK IN THE SAME FORMAT. The self-heal path makes this route a
  // WRITER of the same keys, so the two Workers must agree in both
  // directions: a cron tick landing after a self-heal must not read a
  // different dialect, and vice versa. Cheap to assert, and the failure it
  // prevents (formatted value cached, then Number() -> NaN -> permanent 403)
  // is silent, unattended and lasts until someone deletes the key by hand.
  it("writes back in the cron's format, so the two writers cannot diverge", async () => {
    await get("/frag/last-updated/");
    await get("/frag/need-hits/");

    expect(kv.get(FRAG_KV_KEY_LAST_UPDATED)).toBe("2026-09-08 08:30:00.000000");
    expect(kv.get(FRAG_KV_KEY_NEED_HITS)).toBe("1234567");
    // Both round-trip: feeding what was just written back through the reader
    // gives the same rendered answers as the cold path did.
    prepared = [];
    expect(await body("/frag/last-updated/")).toBe(`1${NB}hour ago`);
    expect(await body("/frag/need-hits/")).toBe("1,234,567");
    expect(prepared).toEqual([]);
  });

  // Cloudflare crons and KV writes are both at-least-once, and csi.js fires
  // this fragment on every page view, so the self-heal write races itself
  // constantly. It is idempotent by construction (same key, same computed
  // value) -- pinned because "writes the same bytes every time" is the only
  // reason that is safe.
  it("is idempotent: repeated cold requests write identical values", async () => {
    await get("/frag/need-hits/");
    kv.clear();
    await get("/frag/need-hits/");

    const written = puts().map((o) => o.value);
    expect(written).toEqual(["1234567", "1234567"]);
  });

  // ONE D1 SESSION PER REQUEST, from lib/session.ts's
  // withSession("first-unconstrained") -- this database has read replication
  // enabled (PLAN.md §3.3) and a handler that opened a session per query would
  // still render correctly and still pass every other test here.
  it("opens exactly one D1 session per request on the three database branches", async () => {
    for (const slug of ["last-updated", "need-hits", "news"]) {
      sessions = 0;
      await get(`/frag/${slug}/`);
      expect(sessions, slug).toBe(1);
    }
  });
});
