import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requireAdminAuth } from "./adminAuth";
import { noStore } from "./noStore";
import type { AppEnv } from "../types";
import type { AdminSessionData } from "../lib/adminAuth";

// The port of givefood/middleware.py's LoginRequiredAccess. It is four lines
// long, which is exactly why it is worth testing properly: it is the ONLY
// thing standing between an anonymous request and every admin page, and there
// is nothing in a four-line diff to draw the eye.
//
// Three properties, and every test below defends one of them.
//
//   1. FAIL CLOSED. There is meant to be one way past this middleware -- a
//      cookie naming a session KV still holds. Every other outcome (no cookie,
//      an empty one, a signed-out session, an unparseable KV record, KV itself
//      failing, the binding missing) must end with the downstream handler NOT
//      RUNNING. So every test that asserts a 302 also asserts the handler was
//      never called: a regression that redirected AND rendered would still
//      look like a redirect from the outside, while leaking the page body
//      underneath it.
//
//      That property has ONE documented hole, pinned rather than fixed in
//      "lets a KV record through if it merely PARSES" below: a KV value that
//      is valid JSON but is not a session object (`{}`, `[]`, `0`, `"x"`)
//      authenticates, with every field undefined. See the suspected-bug note
//      in this work's report. It is written down here because a test file that
//      claimed "fails closed on a corrupt record" while only ever feeding it
//      JSON.parse failures would be worse than no test at all -- it would
//      retire the question.
//
//   2. The bounce back. Django stashes request.get_full_path() in the Django
//      session and redirects to auth:sign_in (gfauth/urls.py -- path '', so
//      `/auth/`); there is no session to stash anything in at this point in
//      the Worker, so the full path -- query string included, same as
//      get_full_path() -- rides in ?next= instead, as the module's own
//      comment explains. Both of this file's recorded production incidents
//      -- the Sign Out button that visibly did nothing, and the /admin/ pages
//      Cloudflare served to anonymous visitors -- were about precisely where
//      and how this one redirect goes, so its target, its status code and its
//      encoding are all pinned individually.
//
//   3. Nothing survives a request. The session is read per request and put on
//      the context, never onto a module-level anything. A Worker isolate
//      serves many requests from many people, so a memoisation "optimisation"
//      here would hand one admin's identity to the next visitor; "serves two
//      admins from two cookies, with nothing shared between requests" below
//      is what stops that landing quietly.

// Hono's fetch() wants an ExecutionContext; nothing under test touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const SESSION_COOKIE = "__Host-gfsession";
const SESSION_ID = "b1QYcO9xEXAMPLEsessionidnotreal";
const KV_KEY = `admin-session:${SESSION_ID}`;
const GATED_PATH = "/admin/foodbank/sid-valley/";

const ADMIN: AdminSessionData = {
  email: "someone@givefood.org.uk",
  name: "Some One",
  givenName: "Some",
  picture: "https://lh3.googleusercontent.com/a/example",
};

const HOUR = 60 * 60 * 1000;

// The record lib/adminAuth.ts's getAdminSession() actually reads out of KV:
// the four session fields plus the `expiresAt` bookkeeping it strips before
// handing anything to this middleware. `writtenMsAgo` back-dates the record --
// expiresAt is stored as "written + 12h", so that is the only handle on its
// age. Default 0, i.e. written a moment ago, which keeps the sliding-refresh
// branch quiet: an incidental KV put() would muddy the "one read per request"
// assertions below. The aged cases opt in explicitly.
function storedSession(overrides: Partial<AdminSessionData> = {}, writtenMsAgo = 0): string {
  return JSON.stringify({ ...ADMIN, ...overrides, expiresAt: Date.now() - writtenMsAgo + 12 * HOUR });
}

interface RunOptions {
  /** Path (and query) of the request; the origin is always the production host. */
  path?: string;
  method?: string;
  /** Raw Cookie header. Omit entirely for an anonymous request. */
  cookie?: string;
  /** KV contents, keyed exactly as lib/adminAuth.ts keys them. */
  kv?: Record<string, string>;
  /** Replaces the whole KV read, for the "KV is broken" case. */
  kvGet?: (key: string) => Promise<string | null>;
  /** Drops the SESSIONS binding entirely, for the "bad deploy" case. */
  noBinding?: boolean;
}

interface RunResult {
  res: Response;
  /** What the gated handler saw, and how often it ran at all. */
  handler: ReturnType<typeof vi.fn>;
  kvGet: ReturnType<typeof vi.fn>;
  /** The sliding-session re-put, which must not fire on a freshly written record. */
  kvPut: ReturnType<typeof vi.fn>;
  /**
   * `adminUser` read from the SAME context after the whole chain unwound --
   * the only way to observe the variable on the redirect path, where the
   * handler never runs to report it.
   */
  adminUserOnContext: AdminSessionData | undefined;
}

// A real Hono app, not a hand-rolled Context: the middleware reads the request
// path and cookie header and writes a redirect through Hono's own APIs, and a
// stub would let a change in how it does any of that pass unnoticed.
//
// Registered on "*" rather than "/admin/*". In production adminApp mounts it
// at the admin prefix (routes/admin/index.ts:85), but the handler itself is
// path-agnostic -- and gating everything lets the tests below hand it the
// hostile paths a router would otherwise refuse to match.
async function run(options: RunOptions = {}): Promise<RunResult> {
  const store = options.kv ?? {};
  const kvGet = vi.fn(options.kvGet ?? (async (key: string) => store[key] ?? null));
  const kvPut = vi.fn(async () => {});
  const env = (options.noBinding ? {} : { SESSIONS: { get: kvGet, put: kvPut } }) as unknown as AppEnv["Bindings"];

  const handler = vi.fn();
  let adminUserOnContext: AdminSessionData | undefined;

  const app = new Hono<AppEnv>();
  // Sits OUTSIDE the gate on the same context, so it can report `adminUser`
  // even when the request was turned away before any handler ran.
  app.use("*", async (c, next) => {
    await next();
    adminUserOnContext = c.get("adminUser");
  });
  app.use("*", requireAdminAuth);
  app.all("*", (c) => {
    handler(c.get("adminUser"));
    return c.text("the admin page body");
  });
  // Nothing here is expected to throw; the cases that DO (a KV outage, a
  // missing binding) are asserted as 500s rather than as unhandled rejections,
  // so the error has to be caught somewhere to be observed at all.
  app.onError((err, c) => c.text(`caught: ${(err as Error).message}`, 500));

  const headers = new Headers();
  if (options.cookie !== undefined) headers.set("Cookie", options.cookie);
  const request = new Request(`https://www.givefood.org.uk${options.path ?? GATED_PATH}`, {
    method: options.method ?? "GET",
    headers,
  });
  const res = await app.fetch(request, env, execCtx);
  return { res, handler, kvGet, kvPut, adminUserOnContext };
}

/** The `next` the sign-in page will actually see, decoded by the query parser. */
function nextParam(res: Response): string | null {
  const location = res.headers.get("Location") ?? "";
  return new URL(location, "https://www.givefood.org.uk").searchParams.get("next");
}

// The same value read the way /auth/ really reads it: routes/admin/auth.ts's
// adminSignIn does `safeNextPath(c.req.query("next"))`, and Hono's query
// parser is not URLSearchParams -- it has its own decoding, including the
// `+`-means-space rule. Asserting through it is the difference between
// "encodeURIComponent was called" and "the sign-in page recovers the path".
async function nextAsSignInPageSeesIt(res: Response): Promise<string | undefined> {
  const app = new Hono();
  let seen: string | undefined;
  app.get("/auth/", (c) => {
    seen = c.req.query("next");
    return c.text("ok");
  });
  await app.fetch(new Request(new URL(res.headers.get("Location") ?? "", "https://www.givefood.org.uk")));
  return seen;
}

describe("requireAdminAuth", () => {
  it("lets a live session through and hands the handler its user", async () => {
    // The happy path, and the only one there is. Without this test every
    // other test here could pass with a middleware that redirected
    // unconditionally -- an admin nobody can reach is not a working gate.
    const { res, handler, kvGet, kvPut } = await run({
      cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
      kv: { [KV_KEY]: storedSession() },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the admin page body");
    expect(handler).toHaveBeenCalledTimes(1);
    // The documented reason the middleware sets `adminUser` at all: every
    // downstream handler (and adminPageContext, and every admin*.njk render)
    // reads the signed-in user from here.
    expect(handler.mock.calls[0]?.[0]).toEqual(ADMIN);
    // The WHOLE call list, not just "was called with": the session id is
    // namespaced `admin-session:` before it reaches KV, and a fallback lookup
    // on the bare id would be a real hole -- the SESSIONS namespace would then
    // answer to any key an attacker could get written into it under some other
    // prefix. One call, one key, no second guess.
    expect(kvGet.mock.calls).toEqual([[KV_KEY]]);
    // A record written a moment ago is nowhere near the halfway point, so the
    // sliding refresh must stay silent. KV allows ~1 write/sec/key, and a
    // re-put on every admin page view is the write-per-request cost this
    // design picked KV over D1 to avoid.
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("exposes the four session fields and not KV's expiry bookkeeping", async () => {
    // `expiresAt` is how the sliding-session refresh decides whether to
    // re-put; it is not part of the user. It reaches the templates as
    // `admin_user` if it survives, and a template that started rendering an
    // epoch-milliseconds number would be a visible bug on every admin page.
    const { handler } = await run({
      cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
      kv: { [KV_KEY]: storedSession() },
    });
    expect(Object.keys(handler.mock.calls[0]?.[0] as object).sort()).toEqual(["email", "givenName", "name", "picture"]);
  });

  it("serves two admins from two cookies, with nothing shared between requests", async () => {
    // Property 3. A Worker isolate is reused across requests from different
    // people, so anything this gate remembers between calls is a session leak,
    // not a cache hit. Three requests down one app instance: two different
    // cookies must produce two different admins, and the anonymous request
    // that follows them must still be turned away with `adminUser` unset --
    // which a module-level `let cachedSession` could not manage.
    const kv = {
      "admin-session:sess-one": storedSession({ email: "one@givefood.org.uk", givenName: "One" }),
      "admin-session:sess-two": storedSession({ email: "two@givefood.org.uk", givenName: "Two" }),
    };

    const first = await run({ cookie: `${SESSION_COOKIE}=sess-one`, kv });
    const second = await run({ cookie: `${SESSION_COOKIE}=sess-two`, kv });
    const anonymous = await run({ kv });

    expect((first.handler.mock.calls[0]?.[0] as AdminSessionData).email).toBe("one@givefood.org.uk");
    expect((second.handler.mock.calls[0]?.[0] as AdminSessionData).email).toBe("two@givefood.org.uk");
    expect(anonymous.res.status).toBe(302);
    expect(anonymous.handler).not.toHaveBeenCalled();
    expect(anonymous.adminUserOnContext).toBeUndefined();
  });

  it("turns an anonymous request away without running the handler", async () => {
    // The case the 2026-09-02 beta incident was really about: an anonymous
    // request with no cookie at all must never reach an admin handler. (That
    // incident was Cloudflare answering from cache before the Worker ran, so
    // this middleware was not at fault -- but it is the check that has to
    // hold everywhere the request DOES arrive.)
    const { res, handler, kvGet, adminUserOnContext } = await run();

    expect(res.status).toBe(302);
    expect(handler).not.toHaveBeenCalled();
    // Empty, not merely "does not contain the page body": c.redirect() sends
    // no body at all, and asserting the exact emptiness is what would catch a
    // regression that rendered the page and then redirected over the top of it.
    expect(await res.text()).toBe("");
    // No cookie means no KV read either -- the short-circuit in
    // getAdminSession, and the reason an anonymous flood costs nothing.
    expect(kvGet).not.toHaveBeenCalled();
    // And `adminUser` stays unset, so a downstream that reads it optimistically
    // gets undefined rather than a stale or half-built user.
    expect(adminUserOnContext).toBeUndefined();
  });

  it("redirects to the bare sign-in page, never straight into Google", async () => {
    // Found 2026-09-03: /auth/ used to 302 on to Google whenever ?next= was
    // present -- which is on EVERY redirect this middleware emits. Google's
    // own session is still live after /auth/sign-out/ clears ours, so the next
    // /admin/* visit silently re-authenticated and Sign Out appeared to do
    // nothing. Django never had the problem because LoginRequiredAccess always
    // lands on the sign-in page, which needs a real click first. So: `/auth/`,
    // and specifically NOT `/auth/start/`, which is now the click target that
    // talks to Google.
    const { res } = await run();
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("/auth/?")).toBe(true);
    expect(location).not.toContain("/auth/start");
    expect(location).not.toContain("accounts.google.com");
  });

  it("redirects with a temporary 302, matching Django's redirect()", async () => {
    // Django's redirect() is a temporary 302 and this must be too. A 301 or
    // 308 would be cached by the browser against the admin URL itself, so an
    // admin who signed in afterwards would still be bounced to /auth/ from
    // their own cache, with no request reaching the Worker to correct it.
    const { res } = await run();
    expect(res.status).toBe(302);
  });

  it("carries the blocked path in ?next=, where Django used the session", async () => {
    // The module's documented divergence: Django writes
    // request.session["next_url"] and redirects; there is no session yet at
    // this point here, so the path travels as a query param and is picked up
    // by /auth/ into the signed __Host-oauth cookie.
    const { res } = await run({ path: "/admin/foodbank/sid-valley/subscribers/" });
    expect(nextParam(res)).toBe("/admin/foodbank/sid-valley/subscribers/");
    expect(await nextAsSignInPageSeesIt(res)).toBe("/admin/foodbank/sid-valley/subscribers/");
  });

  it("percent-encodes the path so it cannot split the redirect URL", async () => {
    // Not decoration. A food bank slug (or any admin path segment) containing
    // `&` or `=` would, unencoded, terminate the `next` value early and inject
    // extra query params into the sign-in URL.
    //
    // The expected Location is written out in full rather than recomputed with
    // encodeURIComponent: a test that calls the same function the code calls
    // agrees with the code by construction, including when the code is wrong.
    const hostile = "/admin/foodbank/a&next=/evil/";
    const { res } = await run({ path: hostile });
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fa%26next%3D%2Fevil%2F");
    // The value the sign-in page reads back is the original path, whole.
    expect(nextParam(res)).toBe(hostile);
    expect(await nextAsSignInPageSeesIt(res)).toBe(hostile);
    // ...and no second `next` was smuggled alongside it.
    expect(new URL(res.headers.get("Location") ?? "", "https://www.givefood.org.uk").searchParams.getAll("next")).toHaveLength(1);
  });

  it("survives the round trip for `+`, `%`, spaces and non-ASCII alike", async () => {
    // Four characters that each break a DIFFERENT plausible implementation of
    // this one line, which is why they are worth spelling out:
    //
    //   `+`   encodeURI (or a bare interpolation) leaves it alone, and both
    //         URLSearchParams and Hono's own query parser then read a literal
    //         `+` in a query value as a SPACE. encodeURIComponent writes %2B,
    //         so the admin lands back on the slug they asked for.
    //   `%`   Hono deliberately does NOT decode %25 in c.req.path, so the
    //         value has to be encoded AGAIN on the way into the query string
    //         or the sign-in page's single decode hands back a different path.
    //   ` `   arrives already percent-encoded in the request line; must not
    //         come back as a raw space and truncate the header value.
    //   è/🥕  Hono DOES decode these in c.req.path (unlike %25), so what gets
    //         re-encoded is the character, not the escape -- multi-byte UTF-8
    //         and an astral-plane code point both have to make it back.
    const cases: [path: string, location: string, seen: string][] = [
      ["/admin/foodbank/a+b/", "/auth/?next=%2Fadmin%2Ffoodbank%2Fa%2Bb%2F", "/admin/foodbank/a+b/"],
      ["/admin/foodbank/50%25-off/", "/auth/?next=%2Fadmin%2Ffoodbank%2F50%2525-off%2F", "/admin/foodbank/50%25-off/"],
      ["/admin/foodbank/a b/", "/auth/?next=%2Fadmin%2Ffoodbank%2Fa%20b%2F", "/admin/foodbank/a b/"],
      ["/admin/foodbank/caff%C3%A8/", "/auth/?next=%2Fadmin%2Ffoodbank%2Fcaff%C3%A8%2F", "/admin/foodbank/caffè/"],
      ["/admin/🥕/", "/auth/?next=%2Fadmin%2F%F0%9F%A5%95%2F", "/admin/🥕/"],
    ];
    for (const [path, location, seen] of cases) {
      const { res } = await run({ path });
      expect(res.headers.get("Location")).toBe(location);
      expect(nextParam(res)).toBe(seen);
      expect(await nextAsSignInPageSeesIt(res)).toBe(seen);
    }
  });

  it("cannot carry a `..` back to the sign-in page", async () => {
    // Dot segments are resolved before this middleware ever sees the path --
    // the URL parser normalises `%2e%2e` and `..` out of the request line, so
    // c.req.path is already collapsed. That is worth an assertion rather than
    // an assumption, because the whole point of ?next= is that /auth/ later
    // redirects to it: if a `..` could survive to that redirect, the browser
    // would resolve it somewhere other than where this gate blocked.
    for (const path of ["/admin/foodbank/%2e%2e/", "/admin/foodbank/../../etc/"]) {
      const { res } = await run({ path });
      expect(nextParam(res)).not.toContain("..");
      expect(nextParam(res)?.startsWith("/")).toBe(true);
    }
  });

  it("does not truncate a very long path", async () => {
    // Nothing here caps the length, and a silent truncation would be worse
    // than a long header: the admin would be redirected after sign-in to a
    // PREFIX of the URL they asked for, which for /admin/foodbank/<slug>/...
    // is a different, real page rather than an error.
    const long = `/admin/foodbank/${"a".repeat(8000)}/`;
    const { res } = await run({ path: long });
    expect(nextParam(res)).toBe(long);
    expect(res.headers.get("Location")?.length).toBeGreaterThan(8000);
  });

  it("still redirects for the site root and for a path that is only a slash", async () => {
    // The gate is mounted under /admin/* in production, but it is written to
    // be path-agnostic and must not assume a prefix, a depth or a trailing
    // slash. `/` is the shortest thing c.req.path can ever be; a naive
    // `path.split("/")[2]` style change would fall over exactly here.
    const { res, handler } = await run({ path: "/" });
    expect(res.status).toBe(302);
    expect(handler).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("/auth/?next=%2F");
  });

  it("emits a relative Location that always points back at this site", async () => {
    // The redirect itself must never become an off-site bounce, whatever path
    // an attacker puts in the request line. Note this middleware does NOT
    // filter the `next` VALUE -- a protocol-relative path is copied through
    // faithfully, percent-encoded, and it is safeNextPath() at /auth/ (Django's
    // url_has_allowed_host_and_scheme, ported) that rejects it. Pinned here so
    // that if anyone ever drops that check downstream, this test names what
    // was relying on it.
    for (const path of ["//evil.example/admin/", "/admin/https://evil.example/", "/admin/x"]) {
      const { res } = await run({ path });
      const location = res.headers.get("Location") ?? "";
      expect(location.startsWith("/auth/?next=")).toBe(true);
      // A Location beginning `//` is protocol-relative and IS an off-site
      // redirect, so the leading `/auth/` is load-bearing, not cosmetic.
      expect(location.startsWith("//")).toBe(false);
      // Resolving it against any origin keeps us on that origin.
      expect(new URL(location, "https://www.givefood.org.uk").origin).toBe("https://www.givefood.org.uk");
      expect(new URL(location, "https://evil.example").origin).toBe("https://evil.example");
    }
    // The un-sanitised value really does arrive at /auth/ -- documenting the
    // division of responsibility above rather than implying it.
    const { res } = await run({ path: "//evil.example/admin/" });
    expect(nextParam(res)).toBe("//evil.example/admin/");
    expect(await nextAsSignInPageSeesIt(res)).toBe("//evil.example/admin/");
  });

  it("carries the query string too, as Django's get_full_path() did", async () => {
    // middleware.py stores request.get_full_path() -- path AND query string --
    // so Django returned the admin to the exact URL they asked for. This used
    // to capture c.req.path alone, and the query was simply lost: signing in
    // from /admin/items/?page=4&sort=calories landed back on page 1 in the
    // default order (items.ts:25 parsePage defaults to 1, items.ts:37 sort to
    // "name"). Nineteen admin routes read query params; the one that stung was
    // /admin/need/new/?foodbank=<slug>, which came back as a blank form with
    // the food bank to be re-picked by hand.
    //
    // The expected value is Django's, run rather than remembered -- under
    // Django 5.2.6, the version installed for the reference checkout at
    // /Users/jasoncartwright/Sites/foodcharity, and re-run in the 2026-09-08
    // review of this change:
    //   RequestFactory().get("/admin/items/", QUERY_STRING="page=4&sort=calories")
    //     .get_full_path()  ==  "/admin/items/?page=4&sort=calories"
    const full = "/admin/items/?page=4&sort=calories";
    const { res } = await run({ path: full });
    expect(nextParam(res)).toBe(full);
    expect(await nextAsSignInPageSeesIt(res)).toBe(full);
    // Written out rather than recomputed with encodeURIComponent, for the same
    // reason as the hostile-path test above: the "?", "&" and "="s MUST arrive
    // escaped. Unescaped, the `next` value would end at the "?" and "sort" would
    // become a sibling query param of the sign-in URL.
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitems%2F%3Fpage%3D4%26sort%3Dcalories");
    // Which is to say: still exactly one `next`, even though the value now
    // legitimately contains an encoded "&" and two encoded "="s.
    expect(new URL(res.headers.get("Location") ?? "", "https://www.givefood.org.uk").searchParams.getAll("next")).toHaveLength(1);
  });

  it("adds no `?` when there was no query, so path-only URLs are untouched", async () => {
    // The guard on the obvious wrong shape, `${c.req.path}?${search}`: every
    // path-only admin URL -- which is most of them -- would gain a trailing
    // "?" it never had. Django appends nothing when QUERY_STRING is empty
    // (get_full_path()'s `if self.META.get("QUERY_STRING", "")`), and neither
    // does URL.search, which reports "" for a bare "?" as well as for none at
    // all. Both inputs must therefore give the byte-identical Location this
    // file has pinned all along.
    for (const path of ["/admin/items/", "/admin/items/?"]) {
      const { res } = await run({ path });
      expect(nextParam(res)).toBe("/admin/items/");
      expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitems%2F");
    }
    // A query that is only punctuation is still a query, and is kept verbatim
    // -- "no query" means the empty string, not "nothing useful in it".
    for (const [path, seen] of [
      ["/admin/items/?&", "/admin/items/?&"],
      ["/admin/items/?=", "/admin/items/?="],
    ] as const) {
      const { res } = await run({ path });
      expect(nextParam(res)).toBe(seen);
    }
  });

  it("passes the query through raw, escaping it a second time on the way out", async () => {
    // The asymmetry that makes this one line easy to get wrong, and the reason
    // the fix is `c.req.path + search` rather than `pathname + search`.
    //
    // Hono DECODES c.req.path (decodeURI, once the path contains a "%"), so
    // the path arrives here as characters. URL.search does the opposite: it
    // hands back the query exactly as it was received, still percent-escaped.
    // encodeURIComponent then escapes those "%"s a SECOND time -- %C3%A8 goes
    // out as %25C3%25A8 -- which is precisely what makes the single decode at
    // /auth/ return the original query byte for byte instead of a decoded
    // lookalike. Django does the same thing: get_full_path() appends
    // iri_to_uri(QUERY_STRING), whose safe set contains "%", so an
    // already-escaped query passes through untouched. Checked by running
    // Django 5.2.6, not by reasoning about it:
    //   QUERY_STRING="q=caff%C3%A8"        ->  "/admin/search/?q=caff%C3%A8"
    //   QUERY_STRING="q=50%25"             ->  "/admin/search/?q=50%25"
    //   QUERY_STRING="q=a+b"               ->  "/admin/search/?q=a+b"
    //   QUERY_STRING="q=fish%20%26%20chips" -> "/admin/search/?q=fish%20%26%20chips"
    //
    // Each case kills a different wrong implementation:
    //   %C3%A8  a decodeURIComponent(search) "to match how the path is
    //           handled" would send the admin back to ?q=caffè -- a different
    //           search, and one whose raw non-ASCII cannot sit in a header.
    //   %26     decoded, it would split one search term into two query params.
    //   %25     decoded once too often it stops being a valid escape at all.
    //   +       must reach /auth/ as a literal "+", not as the space that both
    //           URLSearchParams and Hono's query parser read a bare "+" as.
    const cases: [path: string, location: string, seen: string][] = [
      ["/admin/search/?q=caff%C3%A8", "/auth/?next=%2Fadmin%2Fsearch%2F%3Fq%3Dcaff%25C3%25A8", "/admin/search/?q=caff%C3%A8"],
      ["/admin/search/?q=fish%20%26%20chips", "/auth/?next=%2Fadmin%2Fsearch%2F%3Fq%3Dfish%2520%2526%2520chips", "/admin/search/?q=fish%20%26%20chips"],
      ["/admin/search/?q=50%25", "/auth/?next=%2Fadmin%2Fsearch%2F%3Fq%3D50%2525", "/admin/search/?q=50%25"],
      ["/admin/search/?q=a+b", "/auth/?next=%2Fadmin%2Fsearch%2F%3Fq%3Da%2Bb", "/admin/search/?q=a+b"],
    ];
    for (const [path, location, seen] of cases) {
      const { res } = await run({ path });
      expect(res.headers.get("Location")).toBe(location);
      expect(nextParam(res)).toBe(seen);
      expect(await nextAsSignInPageSeesIt(res)).toBe(seen);
    }
  });

  it("escapes a query character the request line did not, so it cannot split the header", async () => {
    // The query's percent-encode set is narrower than the path's: the URL
    // parser escapes a raw space, `"`, `<` and `>` before the Worker sees
    // them, and leaves `&`, `=`, `+` and `%` alone. Worth an assertion rather
    // than an assumption, because a raw space surviving into a Location header
    // would truncate it at the space -- and the truncated value is a real,
    // different admin page, not an error.
    const { res } = await run({ path: '/admin/search/?q=fish & chips&tag=a"b' });
    const location = res.headers.get("Location") ?? "";
    expect(location).toBe("/auth/?next=%2Fadmin%2Fsearch%2F%3Fq%3Dfish%2520%26%2520chips%26tag%3Da%2522b");
    expect(location).not.toMatch(/[\s"<>]/);
    // What comes back out is the request URL as the URL parser normalised it,
    // which is what the admin's browser actually sent -- so re-issuing it
    // after sign-in reaches the same page.
    expect(nextParam(res)).toBe('/admin/search/?q=fish%20&%20chips&tag=a%22b');
  });

  it("still decodes the path while leaving the query escaped", async () => {
    // The two halves are handled differently ON PURPOSE, and this is the test
    // that fails if the fix is written as `new URL(c.req.url).pathname +
    // search`: pathname keeps the path escaped, so caff%C3%A8 would no longer
    // reach /auth/ in the decoded form the "+/%/space/non-ASCII" test above
    // has pinned since this file was written. Asserting both halves of ONE
    // request is what makes the distinction impossible to satisfy by accident.
    //
    // AND THE ONE PLACE PARITY STOPS, so nothing in this file reads as
    // byte-for-byte Django. get_full_path() is escape_uri_path(path) + "?" +
    // iri_to_uri(qs), and escape_uri_path RE-ESCAPES: run under Django 5.2.6,
    // this exact request gives Django "/admin/foodbank/caff%C3%A8/?q=caff%C3%A8"
    // where the port gives "/admin/foodbank/caffè/?q=caff%C3%A8". Only the
    // query half was ever wrong, and the decoded path predates this change and
    // is deliberately left alone -- `pathname + search` is the mutant this
    // test kills. It costs nothing where it lands: the whole flow was walked
    // for both "caffè" and a CJK slug during the review of this change, and
    // the receiver's final Location came out valid either way (the CJK one
    // re-escaped to %E6%97%A5%E6%9C%AC, the Latin-1 one left as characters).
    const { res } = await run({ path: "/admin/foodbank/caff%C3%A8/?q=caff%C3%A8" });
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fcaff%C3%A8%2F%3Fq%3Dcaff%25C3%25A8");
    expect(nextParam(res)).toBe("/admin/foodbank/caffè/?q=caff%C3%A8");
    // %25 is the exception on both sides -- decodeURI leaves it alone in the
    // path, and nothing touches it in the query -- so here the two halves DO
    // agree, and both come out double-escaped. Same output, different route to
    // it, which is why the caffè case above is the load-bearing one.
    const percent = await run({ path: "/admin/foodbank/50%25-off/?d=50%25" });
    expect(percent.res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2F50%2525-off%2F%3Fd%3D50%2525");
    expect(nextParam(percent.res)).toBe("/admin/foodbank/50%25-off/?d=50%25");
  });

  it("cannot be made to smuggle a second `next` through the query string", async () => {
    // The query is attacker-supplied in a way the path is not: an admin can be
    // sent any link at all, and putting `?next=` in the BLOCKED URL is the
    // obvious thing to try. It must land inside the escaped value, never
    // beside it. Both Hono's query parser and URLSearchParams.get return the
    // FIRST occurrence of a repeated key (checked against this repo's Hono),
    // so a `next` smuggled in ahead of ours is the one /auth/ would honour.
    // safeNextPath still refuses "//evil.example/", but it accepts any
    // single-slash path, so an injected /admin/settings/ would go through --
    // which is why the assertion here is the COUNT, not the value.
    for (const hostile of ["/admin/items/?next=//evil.example/&sort=calories", "/admin/items/?next=/admin/settings/"]) {
      const { res } = await run({ path: hostile });
      const location = res.headers.get("Location") ?? "";
      expect(new URL(location, "https://www.givefood.org.uk").searchParams.getAll("next")).toHaveLength(1);
      expect(nextParam(res)).toBe(hostile);
      expect(await nextAsSignInPageSeesIt(res)).toBe(hostile);
      // Still relative, still this site, whatever was in the query.
      expect(location.startsWith("/auth/?next=")).toBe(true);
      expect(new URL(location, "https://evil.example").origin).toBe("https://evil.example");
    }
    expect((await run({ path: "/admin/items/?next=//evil.example/&sort=calories" })).res.headers.get("Location")).toBe(
      "/auth/?next=%2Fadmin%2Fitems%2F%3Fnext%3D%2F%2Fevil.example%2F%26sort%3Dcalories",
    );
  });

  it("leaves a fragment behind, as the browser already would have", async () => {
    // A "#" opens the fragment, and a real browser never sends one to the
    // server -- but c.req.url is a string, and an implementation that reached
    // for it directly (c.req.url.slice(origin.length), or a split on "?")
    // would carry one along. Carrying it would be worse than dropping it:
    // encodeURIComponent escapes "#" to %23, so /auth/'s eventual redirect
    // would send a literal "#" in the URL rather than a fragment -- a URL that
    // matches no admin route. URL.search stops at the "#", which is the
    // behaviour Django's QUERY_STRING has too.
    const { res } = await run({ path: "/admin/items/?page=4#sort=calories&x=1" });
    expect(nextParam(res)).toBe("/admin/items/?page=4");
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitems%2F%3Fpage%3D4");
    expect(res.headers.get("Location")).not.toContain("%23");
    // A "#" that arrives ESCAPED is data, not a delimiter, and does survive --
    // /admin/search/?q=%23trussell is a search for a hashtag.
    const escaped = await run({ path: "/admin/search/?q=%23trussell" });
    expect(escaped.res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fsearch%2F%3Fq%3D%2523trussell");
    expect(nextParam(escaped.res)).toBe("/admin/search/?q=%23trussell");
    // And a fragment on a path with no query is still just gone; appending
    // `.search` did not turn one into the other.
    const noQuery = await run({ path: "/admin/items/#/admin/settings/" });
    expect(noQuery.res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fitems%2F");
  });

  it("does not truncate a very long query either", async () => {
    // The companion to the long-path test above. A ?q= built from a pasted
    // list, or a stats range with a dozen filters, must come back whole: a
    // truncated query is a DIFFERENT query that still parses, so the admin
    // would be returned to a plausible-looking page with some of their
    // filters silently missing.
    const long = `/admin/search/?q=${"a".repeat(8000)}&page=4`;
    const { res } = await run({ path: long });
    expect(nextParam(res)).toBe(long);
    expect(await nextAsSignInPageSeesIt(res)).toBe(long);
  });

  it("refuses a session cookie KV no longer holds", async () => {
    // What /auth/sign-out/ leaves behind on any device whose cookie was not
    // cleared, and what an expired session looks like once KV's TTL fires. The
    // cookie alone must be worth nothing: this is the assertion that makes
    // signing out actually revoke, rather than merely un-set a cookie the
    // browser might still be sending.
    const { res, handler, kvGet, adminUserOnContext } = await run({ cookie: `${SESSION_COOKIE}=${SESSION_ID}`, kv: {} });
    expect(res.status).toBe(302);
    expect(handler).not.toHaveBeenCalled();
    expect(adminUserOnContext).toBeUndefined();
    // It really did ask KV and take no for an answer, rather than never
    // looking: "KV said no" and "we never checked" are the same 302 from
    // outside, and only one of them is the gate working.
    expect(kvGet).toHaveBeenCalledTimes(1);
  });

  it("refuses a cookie for somebody else's session id", async () => {
    // Guesswork must not pay: a cookie value that is not a live session key
    // reads as absent, with no partial or prefix matching anywhere in between.
    // The extended-id case matters as much as the truncated one -- a KV lookup
    // built on a range scan or a startsWith would let either through. Session
    // ids are base64url, so case is significant and an upper-cased one is a
    // different id, not the same one shouted.
    //
    // NOT in this list, deliberately: a value with surrounding whitespace.
    // parseCookie trims, so ` <id> ` IS the same session -- pinned as such in
    // "finds its cookie among everything else a browser sends" below, since
    // that is leniency towards real clients rather than a matching failure.
    for (const id of [SESSION_ID.slice(0, 8), SESSION_ID.slice(1), `${SESSION_ID}x`, `${SESSION_ID}=`, SESSION_ID.toUpperCase()]) {
      const { res, handler } = await run({
        cookie: `${SESSION_COOKIE}=${id}`,
        kv: { [KV_KEY]: storedSession() },
      });
      expect(res.status).toBe(302);
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("redirects rather than 500s on a KV record that does not parse", async () => {
    // A JSON.parse failure has to land on the redirect path. A throw here
    // would 500 every admin page for that one admin until they cleared their
    // cookies, with the cause -- one bad KV row -- invisible in the logs.
    for (const corrupt of ["", "not json at all", "{", '{"email":', "{'email': 'x'}", " "] as const) {
      const { res, handler, adminUserOnContext } = await run({ cookie: `${SESSION_COOKIE}=${SESSION_ID}`, kv: { [KV_KEY]: corrupt } });
      expect(res.status).toBe(302);
      expect(handler).not.toHaveBeenCalled();
      expect(adminUserOnContext).toBeUndefined();
    }
  });

  it("lets a KV record through if it merely PARSES -- the hole in fail-closed", async () => {
    // CURRENT BEHAVIOUR, PINNED, NOT ENDORSED. See the suspected-bug note in
    // this work's report.
    //
    // getAdminSession() guards JSON.parse with try/catch and then trusts the
    // result completely: it reads `.expiresAt` off it (undefined for all of
    // these, so the sliding refresh is skipped, since `Date.now() - NaN > x`
    // is false) and returns `{ email, name, givenName, picture }` built from
    // whatever it got. That object is always TRUTHY, so `if (!session)` never
    // fires and the request is authenticated with every field undefined.
    //
    // Not reachable by an attacker today -- only createSession() writes this
    // namespace, and KV writes are atomic, so there is no half-written value
    // to find. It is pinned because the file's own headline claim is "fail
    // closed on a corrupt record", and that claim is only true of the
    // JSON.parse-failure half tested above. If anyone ever adds a second
    // writer to SESSIONS, or a migration that seeds keys, this is the line
    // that decides whether that is a bug or a breach.
    for (const parseable of ["{}", "[]", "0", "123", '"hello"', "true", "false", '{"email":"a@b.c"}']) {
      const { res, handler } = await run({ cookie: `${SESSION_COOKIE}=${SESSION_ID}`, kv: { [KV_KEY]: parseable } });
      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      const user = handler.mock.calls[0]?.[0] as AdminSessionData;
      // The four keys are always present; their values are whatever the shape
      // happened to have, which for all but the last case is nothing.
      expect(Object.keys(user).sort()).toEqual(["email", "givenName", "name", "picture"]);
      expect(user.name).toBeUndefined();
    }
    // The one member of the family that behaves differently, and the reason
    // this is a hole rather than a policy: `null` parses too, but reading
    // `.expiresAt` off it throws, so THAT one 500s and fails closed. Same
    // class of bad data, opposite outcome.
    const { res, handler } = await run({ cookie: `${SESSION_COOKIE}=${SESSION_ID}`, kv: { [KV_KEY]: "null" } });
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it("treats a malformed or missing cookie header as anonymous, not as an error", async () => {
    // Every one of these is attacker-reachable (anybody can send any Cookie
    // header) and every one must be an ordinary 302, not an exception.
    for (const cookie of [
      "", // Cookie header present but empty
      `${SESSION_COOKIE}=`, // our cookie, no value
      "gfsession=abc123", // similar name, not ours -- must not match on a suffix
      "__Host-gfsession-old=abc123", // ...nor on a prefix
      "__Host-csrf=deadbeef; _ga=GA1.1.99", // other cookies, none of them ours
      "novaluehere", // no `=` anywhere
      ";;;", // separators only
      "=orphanvalue", // an empty name
      `__host-gfsession=${SESSION_ID}`, // cookie names are case-SENSITIVE
      `${SESSION_COOKIE}="${SESSION_ID}"`, // RFC 6265 permits a quoted value; parseCookie does not unquote it, so it simply does not match
    ]) {
      const { res, handler } = await run({ cookie, kv: { [KV_KEY]: storedSession() } });
      expect(res.status).toBe(302);
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("finds its cookie among everything else a browser sends", async () => {
    // Real admin requests carry the CSRF cookie and analytics cookies too, in
    // a `; `-separated header with leading spaces on every part but the first.
    // A parser that only looked at the first cookie would gate the admin out
    // at random, depending on what else the browser happened to send. The
    // trailing `;` and the spaces around `=` are what an intermediary or an
    // older client can leave behind, and must not change the answer either.
    for (const cookie of [
      `__Host-csrf=deadbeef.cafe; ${SESSION_COOKIE}=${SESSION_ID}; _ga=GA1.1.99`,
      `${SESSION_COOKIE}=${SESSION_ID};`,
      ` ${SESSION_COOKIE} = ${SESSION_ID} `,
      `_ga=GA1.1.99;${SESSION_COOKIE}=${SESSION_ID}`, // no space after the separator
    ]) {
      const { res, handler } = await run({ cookie, kv: { [KV_KEY]: storedSession() } });
      expect(res.status).toBe(200);
      expect(handler.mock.calls[0]?.[0]).toEqual(ADMIN);
    }
  });

  it("takes the FIRST __Host-gfsession when the header carries two", async () => {
    // Current behaviour of lib/cookies.ts's parseCookie, pinned because the
    // obvious alternative implementation (build an object, last write wins)
    // gives the opposite answer, and the difference is a cookie-shadowing
    // question: whichever end of the header wins is the end an attacker would
    // aim at. First wins here -- a session appended AFTER the real one is
    // ignored, and a bogus one prepended BEFORE it locks the admin out (an
    // annoyance) rather than logging them in as someone else (a breach).
    const kv = { "admin-session:real": storedSession({ email: "real@givefood.org.uk" }) };

    const appended = await run({ cookie: `${SESSION_COOKIE}=real; ${SESSION_COOKIE}=planted`, kv });
    expect(appended.res.status).toBe(200);
    expect((appended.handler.mock.calls[0]?.[0] as AdminSessionData).email).toBe("real@givefood.org.uk");

    const prepended = await run({ cookie: `${SESSION_COOKIE}=planted; ${SESSION_COOKIE}=real`, kv });
    expect(prepended.res.status).toBe(302);
    expect(prepended.handler).not.toHaveBeenCalled();
  });

  it("gates every method, not just GET", async () => {
    // The destructive admin routes are POSTs (/need/:id/delete/, publish,
    // notify). If the gate only covered GET, the pages would look protected
    // while the actions behind them were not. HEAD is in the list for its own
    // reason: it returns no body, so a HEAD that slipped past would look
    // harmless while still confirming which admin URLs exist and leaking their
    // response headers.
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      const { res, handler } = await run({ method, path: "/admin/need/abc/delete/" });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Fneed%2Fabc%2Fdelete%2F");
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("reads KV once per request, however many handlers want the user", async () => {
    // The stated reason the middleware sets `adminUser` on the context: "so
    // every downstream handler can read it without a second KV lookup". Admin
    // pages compose several middlewares and a handler that all want the signed
    // in user; each doing its own getAdminSession() would multiply KV reads on
    // every admin page view. Asserted as a count, because a refactor that
    // reintroduced the lookups would be invisible otherwise.
    const kvGet = vi.fn(async () => storedSession());
    const env = { SESSIONS: { get: kvGet, put: vi.fn(async () => {}) } } as unknown as AppEnv["Bindings"];

    const seen: (AdminSessionData | undefined)[] = [];
    const app = new Hono<AppEnv>();
    app.use("*", requireAdminAuth);
    app.use("*", async (c, next) => {
      seen.push(c.get("adminUser"));
      await next();
    });
    app.use("*", async (c, next) => {
      seen.push(c.get("adminUser"));
      await next();
    });
    app.get("*", (c) => {
      seen.push(c.get("adminUser"));
      return c.text("ok");
    });

    const res = await app.fetch(
      new Request(`https://www.givefood.org.uk${GATED_PATH}`, { headers: { Cookie: `${SESSION_COOKIE}=${SESSION_ID}` } }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(kvGet).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([ADMIN, ADMIN, ADMIN]);
    // Every reader got the SAME object, not three reconstructions of it --
    // which is what "without a second KV lookup" actually means.
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
  });

  it("keeps an admin signed in past the sliding-refresh threshold", async () => {
    // The other half of the gate's job: not locking people out. A session
    // written 7h ago is past SESSION_REFRESH_THRESHOLD_SECONDS (12h/2), so
    // getAdminSession slides its KV TTL forward -- and the request must still
    // be served in the same breath. If the refresh branch ever started
    // returning early, or awaited a put that failed, an admin would be signed
    // out mid-shift halfway through every working day.
    const { res, handler, kvGet, kvPut } = await run({
      cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
      kv: { [KV_KEY]: storedSession({}, 7 * HOUR) },
    });
    expect(res.status).toBe(200);
    expect(handler.mock.calls[0]?.[0]).toEqual(ADMIN);
    // Exactly one re-put, and still exactly one read: the slide is bounded to
    // roughly one write per 6h of continued use, per the module's own reason
    // for not re-putting on every read.
    expect(kvPut).toHaveBeenCalledTimes(1);
    expect(kvGet).toHaveBeenCalledTimes(1);
    // The refreshed record keeps the user and moves only the expiry forward.
    const written = JSON.parse(kvPut.mock.calls[0]?.[1] as string) as Record<string, unknown>;
    expect(written.email).toBe(ADMIN.email);
    expect(written.expiresAt as number).toBeGreaterThan(Date.now() + 11 * HOUR);
  });

  it("trusts KV's TTL for expiry, and does not re-check expiresAt itself", async () => {
    // CURRENT BEHAVIOUR, PINNED. `expiresAt` is used only to decide whether to
    // slide the TTL forward; nothing compares it to now for the purpose of
    // rejecting the session. So a record whose stored expiry is already in the
    // past still authenticates (and gets renewed), and the ONLY thing actually
    // expiring sessions is the expirationTtl on the KV put. That is a real
    // dependency worth stating out loud: a future put() that forgot
    // expirationTtl would create a session that never expires, and no code
    // here would notice.
    const { res, handler, kvPut } = await run({
      cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
      kv: { [KV_KEY]: storedSession({}, 13 * HOUR) }, // written 13h ago: expiresAt is an hour in the past
    });
    expect(res.status).toBe(200);
    expect(handler.mock.calls[0]?.[0]).toEqual(ADMIN);
    expect(kvPut).toHaveBeenCalledTimes(1);
  });

  it("does not fall open when KV itself fails", async () => {
    // A KV outage must not become "nobody is signed in, so serve the page
    // anyway" -- nor "everybody is signed in". Current behaviour is that the
    // error propagates out of the middleware, so the request 500s and the
    // handler never runs, which is the safe half of the two. Pinned so a
    // well-meaning try/catch around the session lookup cannot quietly turn a
    // KV blip into open admin pages.
    const { res, handler, adminUserOnContext } = await run({
      cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
      kvGet: async () => {
        throw new Error("KV get failed");
      },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("caught: KV get failed");
    expect(handler).not.toHaveBeenCalled();
    expect(adminUserOnContext).toBeUndefined();
  });

  it("does not fall open when the SESSIONS binding is missing entirely", async () => {
    // The bad-deploy case: wrangler.jsonc loses the kv_namespaces entry and
    // c.env.SESSIONS is undefined. With a cookie the property read throws, so
    // the request 500s; with no cookie getAdminSession returns before it ever
    // touches KV, so it is an ordinary redirect. Neither is a served admin
    // page, which is the only thing that matters here -- and a `?.` added to
    // the binding read "to be safe" would turn the first case into a silent
    // sign-out for every admin at once, so it is pinned as a 500 on purpose.
    const withCookie = await run({ cookie: `${SESSION_COOKIE}=${SESSION_ID}`, noBinding: true });
    expect(withCookie.res.status).toBe(500);
    expect(withCookie.handler).not.toHaveBeenCalled();

    const anonymous = await run({ noBinding: true });
    expect(anonymous.res.status).toBe(302);
    expect(anonymous.handler).not.toHaveBeenCalled();
  });

  it("awaits the handler, so an async response is not lost", async () => {
    // `await next()` rather than a bare `next()`. Everything downstream of
    // this gate is async (D1 reads, Nunjucks renders); if the continuation
    // were not awaited, the response the handler eventually built would be
    // dropped and the admin would see an empty 404 instead of their page.
    const app = new Hono<AppEnv>();
    app.use("*", requireAdminAuth);
    app.get("*", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return c.text("rendered after an await", 201);
    });
    const env = {
      SESSIONS: { get: async () => storedSession(), put: vi.fn(async () => {}) },
    } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(
      new Request(`https://www.givefood.org.uk${GATED_PATH}`, { headers: { Cookie: `${SESSION_COOKIE}=${SESSION_ID}` } }),
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("rendered after an await");
  });

  it("lets a downstream failure surface instead of swallowing it", async () => {
    // The companion to the KV-outage test, on the other side of `await next()`.
    // There is no try/catch around the continuation, so an admin handler that
    // throws reaches the app's own error handler and logs. A gate that caught
    // downstream errors would turn every broken admin page into a bare 302
    // back to sign-in -- indistinguishable from "your session expired", which
    // is the single most misleading thing this middleware could report.
    const handler = vi.fn(() => {
      throw new Error("D1 exploded");
    });
    const app = new Hono<AppEnv>();
    app.use("*", requireAdminAuth);
    app.get("*", handler);
    app.onError((err, c) => c.text(`caught: ${(err as Error).message}`, 500));
    const env = {
      SESSIONS: { get: async () => storedSession(), put: vi.fn(async () => {}) },
    } as unknown as AppEnv["Bindings"];

    const thrown = await app.fetch(
      new Request(`https://www.givefood.org.uk${GATED_PATH}`, { headers: { Cookie: `${SESSION_COOKIE}=${SESSION_ID}` } }),
      env,
      execCtx,
    );
    expect(thrown.status).toBe(500);
    expect(await thrown.text()).toBe("caught: D1 exploded");
  });

  it("emits a 302 that noStore can still mark uncacheable", async () => {
    // noStore.ts's own comment names this exact response: the Cache-Control
    // headers have to land on the way out "including on the 302 that
    // requireAdminAuth itself returns (a cached redirect would be its own,
    // milder bug)". Neither middleware can guarantee that alone -- it is a
    // property of the pair -- so it is asserted on the pair, mounted in the
    // order index.ts uses (index.ts:137 noStore outermost, then the gate at
    // routes/admin/index.ts:85). A short-circuit return that skipped the outer
    // middleware's unwind would leave an /admin/* redirect sitting in a shared
    // cache.
    const app = new Hono<AppEnv>();
    app.use("*", noStore);
    app.use("*", requireAdminAuth);
    app.get("*", (c) => c.text("the admin page body"));
    const env = { SESSIONS: { get: async () => null, put: vi.fn(async () => {}) } } as unknown as AppEnv["Bindings"];

    const res = await app.fetch(new Request(`https://www.givefood.org.uk${GATED_PATH}`), env, execCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/?next=%2Fadmin%2Ffoodbank%2Fsid-valley%2F");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("sets no cache headers of its own, which is why noStore is mandatory", async () => {
    // The flip side of the test above, and the reason it is not incidental.
    // This gate emits a plain 302 with NO Cache-Control at all, so on any
    // route where noStore is not also mounted the redirect is cacheable by
    // default. Pinned so that nobody reads the pairing test as evidence that
    // requireAdminAuth protects its own redirect -- it does not, and the
    // 2026-09-02 incident was the edge caching an /admin/* response.
    const { res } = await run();
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("CDN-Cache-Control")).toBeNull();
  });
});
