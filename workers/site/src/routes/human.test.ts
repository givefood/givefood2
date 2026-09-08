import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import app from "../index";
import { humanRelay } from "./human";
import type { AppEnv } from "../types";
import type { Env } from "../../worker-configuration";

// routes/human.ts -- the Turnstile honeypot relay. Every public POST form on
// the site (subscribe.njk, flag.njk, register_foodbank.njk) posts HERE first,
// and this handler answers with a page whose only job is to re-post the same
// fields at their real destination once a Turnstile widget's callback fires.
//
// WHY IT IS WORTH THIS MUCH TEST, given it is one short function that touches
// no database: it is the ONLY thing standing between a visitor pressing "Get
// updates" and their submission arriving, and every one of its failure modes
// is silent. A dropped field is not an error, it is a subscribe request that
// arrives without an email address. A `target` that stops being emitted is a
// form that posts to the relay page itself. An empty `data-sitekey` renders a
// perfectly normal-looking page whose widget never fires, so the auto-submit
// never runs and NOTHING is submitted, by anybody, until someone notices the
// subscriber count has stopped moving. That last one is the same shape as the
// Browser Rendering credential that broke unattended for a day.
//
// REAL APP, REAL TEMPLATES, REAL i18n. `app` is the default export of
// workers/site/src/index.ts, so every request below unwinds through the real
// middleware chain (serverTiming, securityHeaders, cacheTag, runtimeIdentity,
// slugRedirect, resolveLanguage, geoJsonPreload, pageCacheControl) and the
// real method gate index.ts wraps this handler in, and renders
// public/human.njk through the real Nunjucks environment with the real .po
// catalogues. That matters more here than usual: THREE of the values this
// handler computes are only observable in the rendered HTML (`post_vars` is
// iterated by the template, `target` becomes a form action, `action` becomes
// a data attribute), and half of what it does depends on context variables
// two different middlewares set. A hand-built router with a stub template
// could not see any of it.
//
// DJANGO SOURCE, read at /Users/jasoncartwright/Sites/foodcharity:
// givefood/views.py:1072-1095 (`@require_POST def human`) and
// givefood/templates/public/human.html. The parity claims below about
// QueryDict were checked by RUNNING Django 5.2.6 on this machine, not by
// reasoning -- the exact program and its output are quoted at the test that
// depends on it.
//
// MUTATION TESTED, not assumed. The repo was copied outside the tree, and
// routes/human.ts broken one edit at a time in the COPY: 29 mutants, all 29
// now caught. Deleting either 403 gate, weakening `!target` to an undefined
// check, changing the 403's status or giving it a body, dropping the
// `continue` (or applying it to only one name, or case-insensitively),
// dropping the `typeof value === "string"` filter, reversing the post_vars
// order, building post_vars with Object.create(null), renaming the post_vars
// key, swapping target and action, headless: false, pageTranslatable: false,
// withholding `locale` from buildPageContext or from render(), c.req.url for
// c.req.path, hardcoding or dropping render_time_ms, hardcoding or dropping
// the sitekey, c.text() for c.html(), not awaiting parseBody, adding a D1
// query, trimming the target, and stamping the response Cache-Control.
//
// ONE OF THOSE SURVIVED THE FIRST ROUND and is why the file is shaped the way
// it is: passing `c.req.path` where `unprefixedPath` is wanted is invisible on
// /human/, where the prefixed and unprefixed paths are the same string. It is
// only wrong on /cy/human/, where it turns the alternates into /cy/cy/human/.
// The hreflang assertions therefore live in the LOCALE test, not only in the
// English one -- an assertion in the place where the two spellings still agree
// is not an assertion.

const ORIGIN = "https://www.givefood.org.uk";
// Deliberately NOT the production sitekey Django's template hardcoded: an
// assertion has to be able to tell "the binding came through" apart from "some
// plausible-looking key came through", and the hardcode-it-back mutant is one
// of the ones this file has to kill.
const SITEKEY = "0x0000TESTSITEKEYNOTREAL";

const FORM = "application/x-www-form-urlencoded";

type Bindable = null | number | bigint | string | Uint8Array;

// The D1 surface packages/db uses, over a real in-memory SQLite built from
// the real migrations. It exists here to be NOT USED (see "side effects"
// below): every prepare() is recorded, and the database genuinely works, so
// "no queries" is a claim about restraint rather than about a binding that
// would have thrown anyway.
function countingD1(db: DatabaseSync, prepares: string[]): D1Database {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  const prepare = (sql: string) => {
    prepares.push(sql);
    return statement(sql, []);
  };
  return { prepare, withSession: () => ({ prepare, getBookmark: () => null }) } as unknown as D1Database;
}

const SCHEMA = schemaFor("foodbank");

let db: DatabaseSync;
let prepares: string[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  prepares = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function env(overrides: Record<string, unknown> = {}): Env {
  return { TURNSTILE_SITEKEY: SITEKEY, DB: countingD1(db, prepares), ...overrides } as unknown as Env;
}

/** A urlencoded POST, exactly as a browser submits one of the site's forms. */
async function post(path: string, fields: Record<string, string> | string, bindings: Env = env()): Promise<Response> {
  const body = typeof fields === "string" ? fields : new URLSearchParams(fields).toString();
  return await app.request(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": FORM }, body }, bindings);
}

/** The relay's hidden fields, in document order, as [name, value] pairs. */
function hiddenFields(html: string): Array<[string, string]> {
  return [...html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map((m) => [m[1] ?? "", m[2] ?? ""]);
}

/** The `action` attribute of the relay form -- the URL the browser will re-post to. */
function formAction(html: string): string | null {
  return html.match(/<form action="([^"]*)" method="post">/)?.[1] ?? null;
}

// What the subscribe form on every food bank page actually posts (see
// wfbn/foodbank/includes/subscribe.njk:35-47): the visitor's email, plus the
// two control fields. Used as the "normal traffic" case throughout.
const SUBSCRIBE = {
  email: "visitor@example.com",
  target: "/needs/at/salisbury/updates/subscribe/",
  action: "subscribe",
};

describe("the method gate index.ts wraps this handler in", () => {
  it("relays a POST", async () => {
    const res = await post("/human/", SUBSCRIBE);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<form action="/needs/at/salisbury/updates/subscribe/" method="post">');
  });

  it("answers every other method 405 with an empty body, as @require_POST does", async () => {
    // givefood/views.py:1072 is `@require_POST`, which answers 405. index.ts
    // deliberately registers this as app.all + an explicit 405 rather than
    // app.post, because app.post alone would leave Hono answering a GET with
    // the site 404 page -- a different status, a 2KB body, and a page that
    // says the URL does not exist when it does. Asserted for all four verbs a
    // crawler or a preflight-less client might actually send, because the
    // gate is one comparison and getting it backwards is one character.
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      const res = await app.request(`${ORIGIN}/human/`, { method }, env());
      expect(res.status, method).toBe(405);
      expect(await res.text(), method).toBe("");
    }
  });

  it("is mounted under every language prefix the site serves, and NOT under /en/", async () => {
    // givefood/urls.py:28 puts `human` inside i18n_patterns with
    // prefix_default_language=False, so /cy/human/, /ga/human/ and /gd/human/
    // exist and /en/human/ does not. This matters beyond tidiness: the forms
    // that post here use `{{ url('human') }}`, which emits the CURRENT page's
    // prefix -- a visitor on /cy/needs/at/salisbury/ posts to /cy/human/. A
    // missing prefixed mount would 404 the subscribe form for every
    // Welsh-language visitor while English worked perfectly.
    for (const prefix of ["/cy", "/ga", "/gd"]) {
      const res = await post(`${prefix}/human/`, SUBSCRIBE);
      expect(res.status, prefix).toBe(200);
    }
    expect((await post("/en/human/", SUBSCRIBE)).status).toBe(404);
  });

  it("404s a POST to the unslashed /human, rather than 301ing and losing the body", async () => {
    // lib/appendSlash.ts restricts APPEND_SLASH to GET/HEAD -- a deliberate
    // deviation from Django, which redirects a POST too and drops the body on
    // the floor. Pinned HERE because /human/ is the one URL on the site where
    // that redirect would be maximally confusing: the visitor would land on
    // the relay page's target with none of their fields, i.e. a subscribe
    // request with no email address, and the 301 would be cached by the
    // browser for good measure.
    const res = await post("/human", SUBSCRIBE);
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
  });
});

describe("the two 403 gates", () => {
  // givefood/views.py:1078-1087 reads target then action out of
  // post_vars, returning HttpResponseForbidden() if either is falsy, and
  // pop()s both before the dict reaches the template. Both halves are
  // load-bearing: the check stops /human/ being a general-purpose
  // "render an auto-submitting form to anywhere" endpoint for a request that
  // supplies neither, and the pop stops the relay re-posting its own control
  // fields to the real handler.

  it("refuses a request with no target, and renders nothing", async () => {
    const res = await post("/human/", { action: "subscribe", email: "visitor@example.com" });
    expect(res.status).toBe(403);
    // The body must be EMPTY, not the relay page with a blank action -- a
    // form posting to "" re-posts to /human/ itself, which would loop.
    expect(await res.text()).toBe("");
  });

  it("refuses a request with no action, even though nothing downstream reads it", async () => {
    // `action` ends up only in the widget's data-action attribute (a Turnstile
    // analytics label); lib/turnstile.ts's validateTurnstile never checks the
    // action siteverify returns. So this gate protects nothing by itself --
    // it is here because Django's is, and dropping it would silently widen
    // what the endpoint accepts.
    const res = await post("/human/", { target: "/flag/", email: "visitor@example.com" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  it("treats an empty string as absent, matching Django's falsy check", async () => {
    // `if not target` in Python is true for "" as well as None, and the port
    // spells it `if (!target)`. A port written as `if (target === undefined)`
    // would accept `target=` and render a form posting to the relay itself.
    expect((await post("/human/", { target: "", action: "subscribe" })).status).toBe(403);
    expect((await post("/human/", { target: "/flag/", action: "" })).status).toBe(403);
  });

  it("accepts a whitespace-only target, because Python's `not` does too", async () => {
    // NOT an endorsement -- pinned because it is the boundary of the gate
    // above and because "tighten this to .trim()" is a plausible future edit
    // that would be a real behaviour change, not a tidy-up.
    const res = await post("/human/", { target: " ", action: " " });
    expect(res.status).toBe(200);
    expect(formAction(await res.text())).toBe(" ");
  });

  it("refuses a body it cannot parse as a form: JSON, and no Content-Type at all", async () => {
    // Hono's parseBody returns {} for anything that is not urlencoded or
    // multipart (hono/dist/utils/body.js -- it switches on the media type and
    // falls through), so a JSON client gets the same 403 as a request with no
    // target. Worth pinning because the failure is indistinguishable from a
    // deliberate refusal, and someone integrating against this endpoint would
    // otherwise have no way to tell the two apart.
    const json = await app.request(
      `${ORIGIN}/human/`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(SUBSCRIBE) },
      env(),
    );
    expect(json.status).toBe(403);

    const untyped = await app.request(`${ORIGIN}/human/`, { method: "POST", body: new URLSearchParams(SUBSCRIBE).toString() }, env());
    expect(untyped.status).toBe(403);
  });

  it("refuses a multipart request whose target arrives as a file part", async () => {
    // `typeof body.target === "string"` is what makes this a 403: a File is
    // not a string, so target is "". Django lands in the same place by a
    // different route -- MultiPartParser puts file parts in request.FILES,
    // never request.POST, so post_vars.get("target") is None (read in
    // django/http/multipartparser.py; NOT executed, unlike the QueryDict
    // check below). Same outcome, so this is parity, not divergence.
    const form = new FormData();
    form.set("target", new File(["/flag/"], "target.txt", { type: "text/plain" }));
    form.set("action", "flag");
    const res = await app.request(`${ORIGIN}/human/`, { method: "POST", body: form }, env());
    expect(res.status).toBe(403);
  });

  it("returns the 403 as text/plain, where Django returned text/html", async () => {
    // A DIVERGENCE, pinned rather than fixed. `new Response("", {status: 403})`
    // gets Content-Type: text/plain;charset=UTF-8 from the platform;
    // HttpResponseForbidden() is text/html. Nothing consumes either -- the
    // body is empty in both -- but if a future edit puts a message in that
    // body, the header decides whether a browser renders it as markup.
    const res = await post("/human/", { action: "subscribe" });
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=UTF-8");
  });
});

describe("what the relay carries forward", () => {
  it("re-emits every other field as a hidden input, in the order it arrived", async () => {
    // THE WHOLE POINT OF THE PAGE. These hidden inputs are the visitor's
    // submission; if one is dropped, the real handler receives a form with a
    // field missing and there is no error anywhere -- routes/wfbn/updates.ts
    // would simply see no email address. Order is asserted because it is
    // observable (the template iterates post_vars) and because it is the
    // cheapest way to notice the object being rebuilt through something that
    // does not preserve insertion order.
    const res = await post("/human/", {
      our_page: "https://www.givefood.org.uk/needs/at/salisbury/",
      your_email: "visitor@example.com",
      explanation: "The phone number is wrong",
      target: "/flag/",
      action: "flag",
    });
    expect(hiddenFields(await res.text())).toEqual([
      ["our_page", "https://www.givefood.org.uk/needs/at/salisbury/"],
      ["your_email", "visitor@example.com"],
      ["explanation", "The phone number is wrong"],
    ]);
  });

  it("does NOT re-emit target or action -- Django's two pop() calls", async () => {
    // The negative half of the test above, and the one a fixture full of
    // only-should-appear fields cannot make: a handler that skipped the
    // `continue` and copied everything would pass every assertion about
    // `email` being present. It would also post `target` and `action` on to
    // the real handler, where routes/public/flag.ts's form parser would see
    // two fields it never renders.
    const names = hiddenFields(await (await post("/human/", SUBSCRIBE)).text()).map(([name]) => name);
    expect(names).toEqual(["email"]);
    expect(names).not.toContain("target");
    expect(names).not.toContain("action");
  });

  it("is case-sensitive about those two names, exactly as the Python is", async () => {
    // `post_vars.pop("target")` matches one spelling. A field genuinely named
    // "Target" is an ordinary field and must survive the relay -- pinned so a
    // future "normalise the keys" edit is a visible change.
    const names = hiddenFields(await (await post("/human/", { target: "/flag/", action: "flag", Target: "kept", ACTION: "kept" })).text());
    expect(names).toEqual([
      ["Target", "kept"],
      ["ACTION", "kept"],
    ]);
  });

  it("carries a csrf_token through unchanged, or the form it protects 403s on arrival", async () => {
    // register_foodbank.njk and write/*.njk render a csrf_token into a form
    // whose action is /human/. lib/csrf.ts's verifyCsrf compares that field
    // with the visitor's __Host-csrf cookie using timingSafeEqual, so a relay
    // that dropped, trimmed or re-cased the token would fail every one of
    // those submissions -- and fail them the expensive way, by discarding a
    // name, postal address and email the visitor had just typed (the failure
    // middleware/pageCacheControl.ts records reproducing on 2026-09-07).
    const token = "a".repeat(64);
    const res = await post("/human/", { name: "New Food Bank", csrf_token: token, target: "/register-foodbank/", action: "registerfoodbank" });
    expect(hiddenFields(await res.text())).toContainEqual(["csrf_token", token]);
  });

  it("keeps a field whose value is empty, rather than pruning it", async () => {
    // flag.njk's `your_email` and `explanation` are both optional and both
    // submitted empty most of the time. Django's dict() keeps them (verified
    // in the same run quoted below -- 'blank': ''), and so does this: the
    // filter is `typeof value === "string"`, which "" satisfies. A truthiness
    // filter here would turn "no explanation given" into "field absent", which
    // is a different thing to the handler on the other side.
    const res = await post("/human/", { your_email: "", explanation: "", target: "/flag/", action: "flag" });
    expect(hiddenFields(await res.text())).toEqual([
      ["your_email", ""],
      ["explanation", ""],
    ]);
  });

  it("keeps the LAST of a repeated field, which is what Django's QueryDict.dict() does", async () => {
    // PARITY CLAIM, CHECKED BY RUNNING DJANGO 5.2.6 ON THIS MACHINE:
    //
    //   >>> from django.http import QueryDict
    //   >>> QueryDict('target=/a/&target=/b/&email=x%40y.z&email=second'
    //   ...           '&tags[]=1&tags[]=2&blank=').dict()
    //   {'target': '/b/', 'email': 'second', 'tags[]': '2', 'blank': ''}
    //
    // Hono agrees for the plain keys (convertFormDataToBodyData assigns
    // `form[key] = value` on each pass, so the last write wins) and, note,
    // keeps the FIRST occurrence's position in the ordering. Both properties
    // are asserted, because a duplicate here is not exotic: a double-clicked
    // submit button and a browser autofill can each produce one.
    const html = await (await post("/human/", "target=/a/&target=/b/&action=first-action&action=last-action&email=first&note=n&email=last")).text();
    // ...including for the two control fields themselves, which are read out
    // of the same object before it is copied.
    expect(formAction(html)).toBe("/b/");
    expect(html).toContain('data-action="last-action"');
    expect(hiddenFields(html)).toEqual([
      ["email", "last"],
      ["note", "n"],
    ]);
  });

  it("SILENTLY DROPS a field whose name ends in [] -- a real divergence", async () => {
    // SUSPECT, pinned as current behaviour and reported, not fixed.
    //
    // Hono treats a trailing "[]" as "collect all values into an array"
    // regardless of the `all` option (hono/dist/utils/body.js:
    // `const shouldParseAllValues = options.all || key.endsWith("[]")`). The
    // value is then an Array, `typeof value === "string"` is false, and the
    // field vanishes from the relay with no error. Django keeps it verbatim
    // as an ordinary key -- 'tags[]': '2' in the run quoted above.
    //
    // No form on the site posts a []-suffixed field today, which is exactly
    // why this is worth a test: the day someone adds a multi-select to the
    // register-a-food-bank form, it will arrive at the real handler empty and
    // the relay will look completely healthy.
    const res = await post("/human/", "target=/flag/&action=flag&tags[]=1&tags[]=2&kept=yes");
    expect(hiddenFields(await res.text())).toEqual([["kept", "yes"]]);
  });

  it("SILENTLY DROPS a field named __proto__, without polluting anything", async () => {
    // SUSPECT-ish, and the reason is worth writing down. Hono builds its body
    // object with Object.create(null), so "__proto__" arrives as an ordinary
    // own property; the handler copies into a plain `{}`, where assigning a
    // STRING to "__proto__" is specified as a no-op. So the field disappears
    // (Django would have re-emitted it) and, importantly, nothing is
    // polluted: Object.prototype is untouched and the object gains no key.
    // Asserted rather than reasoned about, because the safety here is an
    // accident of the value always being a string.
    const res = await post("/human/", "target=/flag/&action=flag&__proto__=polluted&kept=yes");
    const html = await res.text();
    expect(hiddenFields(html)).toEqual([["kept", "yes"]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, "__proto__")).toBe(false);
  });

  it("accepts a multipart submission and drops only its file parts", async () => {
    // No form on the site posts multipart today, but parseBody accepts it, so
    // it is a reachable path. Files are dropped for the same `typeof` reason
    // as the []-fields -- here that matches Django, whose request.POST never
    // contains uploads either, so the relay's text fields are exactly what
    // Django would have re-emitted.
    const form = new FormData();
    form.set("target", "/flag/");
    form.set("action", "flag");
    form.set("explanation", "see attached");
    form.set("evidence", new File(["a screenshot"], "shot.png", { type: "image/png" }));
    const res = await app.request(`${ORIGIN}/human/`, { method: "POST", body: form }, env());
    expect(res.status).toBe(200);
    expect(hiddenFields(await res.text())).toEqual([["explanation", "see attached"]]);
  });

  it("escapes what it re-emits, so a submitted field cannot inject markup", async () => {
    // EVERY value on this page is attacker-controlled by construction: the
    // endpoint renders whatever was POSTed to it. Nunjucks autoescape (on by
    // default in packages/templates/src/env.ts) is the only thing standing
    // between that and a stored-nothing, reflected-everything XSS on
    // www.givefood.org.uk -- and the payload would be delivered by a form on
    // an attacker's own page, cross-site POSTs being exactly what this
    // endpoint accepts. Names as well as values, since both are interpolated.
    const res = await post("/human/", {
      target: '/x/"><script>alert(1)</script>',
      action: 'a" onload="x',
      'ev"il': '"><img src=x onerror=alert(1)>',
    });
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain('<form action="/x/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" method="post">');
    expect(html).toContain('data-action="a&quot; onload=&quot;x"');
    expect(html).toContain('<input type="hidden" name="ev&quot;il" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">');
  });
});

describe("the page the browser is handed", () => {
  it("posts the form at the RELATIVE target, not at an absolute www URL", async () => {
    // public/human.njk's own long comment: Django hardcoded
    // action="https://www.givefood.org.uk{{ target }}", and the port's first
    // pass generalised that to {{ domain }}{{ target }} -- which meant that
    // submitting the flag or register-a-food-bank form ON BETA rendered a
    // relay that posted at PRODUCTION Django, filing real flags against the
    // live site. The relative form is the fix, and it is invisible in every
    // other test in this file, so it gets its own.
    const html = await (await post("/human/", SUBSCRIBE)).text();
    expect(formAction(html)).toBe("/needs/at/salisbury/updates/subscribe/");
    expect(html).not.toContain('<form action="https://www.givefood.org.uk/needs/');
  });

  it("relays to whatever target it is given, cross-origin included", async () => {
    // SUSPECT, pinned. Nothing validates that `target` is same-origin, so a
    // form on an attacker's site can make www.givefood.org.uk serve a
    // Give-Food-branded page that auto-posts to the attacker's own endpoint.
    // Django's hardcoded prefix made this impossible by accident -- its
    // template would have produced the harmless nonsense
    // action="https://www.givefood.org.ukhttps://evil.example/collect", which
    // a browser resolves back to this origin. The relative action that fixed
    // the beta bug above removed that accidental guard. Low severity (the
    // attacker supplies the data being posted, and there is no session cookie
    // in play), but it is a divergence with a security direction, so it is
    // recorded here rather than left to be discovered.
    expect(formAction(await (await post("/human/", { target: "https://evil.example/collect", action: "subscribe" })).text())).toBe(
      "https://evil.example/collect",
    );
  });

  it("puts the configured Turnstile sitekey in the widget", async () => {
    // Django hardcoded the sitekey in the template (public/human.html:25);
    // the port reads env.TURNSTILE_SITEKEY, which is what makes a beta or
    // preview environment able to use its own widget.
    expect(await (await post("/human/", SUBSCRIBE)).text()).toContain(
      `<div class="cf-turnstile" data-sitekey="${SITEKEY}" data-action="subscribe" data-callback="turnstilecallback"></div>`,
    );
  });

  it("renders a 200 with an EMPTY sitekey when the binding is missing -- the silent failure", async () => {
    // SUSPECT, pinned rather than fixed, and the single most dangerous thing
    // on this page. With TURNSTILE_SITEKEY unset, nunjucks renders "" (the
    // environment sets throwOnUndefined: false, deliberately), the page comes
    // back 200 and looks entirely normal -- but Turnstile never issues a
    // callback for an empty sitekey, so `turnstilecallback` never fires,
    // `form.submit()` never runs, and EVERY subscribe, flag and
    // register-a-food-bank submission on the site silently stops arriving.
    // Nothing logs. Compare lib/turnstile.ts, which faces the same problem
    // from the verification side and chose to console.log the unset secret
    // precisely so it is not "indistinguishable in the Workers logs from a
    // real visitor submitting a bad token".
    const res = await post("/human/", SUBSCRIBE, { DB: countingD1(db, prepares) } as unknown as Env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div class="cf-turnstile" data-sitekey="" data-action="subscribe" data-callback="turnstilecallback"></div>');
  });

  it("ships the auto-submit callback, which is the only reason the page exists", async () => {
    // Without this pair of lines the visitor sees a page with a checkbox and
    // no submit button, and their submission is lost the moment they navigate
    // away. There is no <input type="submit"> anywhere in human.njk -- the
    // callback IS the submit button.
    const html = await (await post("/human/", SUBSCRIBE)).text();
    expect(html).toContain('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>');
    expect(html).toContain('document.querySelector("form").submit();');
  });

  it("renders headless: chrome in the head, no footer", async () => {
    // `headless: true` is what page.njk's `{% if not headless %}` guard reads.
    // The footer is ~40 lines including two `data-include` fragments that each
    // fire a request from the browser -- on a page that exists for a few
    // hundred milliseconds before auto-submitting itself, that is two wasted
    // requests per submission plus a flash of a page the visitor should never
    // really see. Django set headless the same way (views.py:1089).
    const html = await (await post("/human/", SUBSCRIBE)).text();
    expect(html).not.toContain("<footer");
    expect(html).not.toContain("Something wrong in this page?");
    // ...but it IS a whole page, not a fragment: the doctype and title are the
    // half of page.njk headless does not remove.
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Human check - Give Food</title>");
  });

  it("declares itself translatable, with all four hreflang alternates", async () => {
    // The module comment claims this matches Django. It does: context() in
    // givefood/context_processors.py:32 computes page_translatable as
    // `"/cy/" == translate_url(path, "cy")[:4]`, which is true for any
    // i18n_patterns-scoped path, and /human/ is one (givefood/urls.py:28).
    // Read at /Users/jasoncartwright/Sites/foodcharity, not assumed.
    //
    // Worth noting rather than asserting away: those four URLs are POST-only,
    // so a crawler following one gets a 405. Harmless today -- nothing links
    // to /human/ and no crawler POSTs -- and it is what Django emitted too.
    const html = await (await post("/human/", SUBSCRIBE)).text();
    for (const code of ["en", "cy", "ga", "gd"]) {
      expect(html).toContain(`<link rel="alternate" hreflang="${code}" href="${ORIGIN}/${code === "en" ? "" : `${code}/`}human/">`);
    }
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/human/">`);
  });

  it("renders in the locale the URL prefix resolved, in both places it has to arrive", async () => {
    // The locale reaches the template TWICE by two different routes:
    // buildPageContext's `locale` (which becomes language_code, and the html
    // lang attribute) and render()'s third argument (which selects the .po
    // catalogue AND the url() helper's prefix). A mutant that dropped the
    // third argument would still produce lang="cy" and a correct hreflang
    // list, with the page in English and the logo linking back to the English
    // home page -- so all three are asserted together.
    const html = await (await post("/cy/human/", { ...SUBSCRIBE, target: "/cy/needs/at/salisbury/updates/subscribe/" })).text();
    expect(html).toContain('<html lang="cy" dir="ltr"');
    expect(html).toContain("<title>Gwiriad dynol - Give Food</title>");
    expect(html).toContain("<p>Mae'n ddrwg gennym, ond mae'n rhaid i ni wirio eich bod yn ddyn...</p>");
    expect(html).toContain('<a href="/cy/" class="logo">');

    // AND the alternates are still the four /human/ URLs, not /cy/cy/human/.
    // buildPageContext builds them by putting each code in front of
    // `unprefixedPath`, so it must be handed the path WITH the prefix already
    // stripped -- Hono's own c.req.path still carries it. Passing c.req.path
    // here is invisible on the English page (where the two are equal), which
    // is exactly why this assertion lives in the prefixed test: it is the
    // only place that mutant shows up.
    expect(html).toContain(`<link rel="alternate" hreflang="cy" href="${ORIGIN}/cy/human/">`);
    expect(html).toContain(`<link rel="alternate" hreflang="en" href="${ORIGIN}/human/">`);

    const ga = await (await post("/ga/human/", SUBSCRIBE)).text();
    expect(ga).toContain("<p>Tá brón orainn, ach ní mór dúinn a sheiceáil an duine thú...</p>");
  });

  it("joins a .po entry that is split across continuation lines, on /gd/", async () => {
    // locale/gd/django.po:1315-1318 writes this msgstr as the empty string
    // followed by two continuation lines -- the standard gettext wrapping for
    // a long string, and a shape poParser.ts has to concatenate rather than
    // read as `msgstr ""`. If it ever stopped, the fallback in i18n.ts's
    // translate() ("" means untranslated) would quietly serve the ENGLISH
    // sentence on a page labelled lang="gd", with nothing failing. That is
    // why this locale gets a test of its own and not just a mention.
    const html = await (await post("/gd/human/", SUBSCRIBE)).text();
    expect(html).toContain('<html lang="gd" dir="ltr"');
    expect(html).toContain("<p>Duilich, ach feumaidh sinn dèanamh cinnteach gur e duine daonna a th’ annad...</p>");
    expect(html).toContain("<title>Sgrùdadh daonna - Give Food</title>");
  });

  it("reports the whole request's elapsed time in the debug comment", async () => {
    // The handler passes elapsedMs(c), which subtracts serverTiming's
    // requestStartTime -- not a timer this handler started, which would report
    // ~0 and quietly stop measuring the thing the comment claims to measure.
    // Driven from a fixed clock so the NUMBER is the assertion: reading 1 is
    // serverTiming's t0, reading 2 is elapsedMs inside the handler.
    const readings = [1000, 1064.6, 1099];
    let i = 0;
    vi.spyOn(performance, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? 0);

    expect(await (await post("/human/", SUBSCRIBE)).text()).toContain("⏱️ Took 65ms");
  });
});

describe("the response as a cache and a browser see it", () => {
  it("carries no Cache-Control and no Set-Cookie, so nothing can share this page", async () => {
    // THE LEAK THIS PAGE WOULD BE. The body contains the visitor's own email
    // address (or their name, postal address and explanation, on the flag and
    // register forms) in a hidden input. middleware/pageCacheControl.ts is
    // mounted on "*" and fills in `public, max-age=300, s-maxage=86400` for
    // any 200 text/html response that has not spoken for itself -- which is
    // precisely how /frag/ip-address/ came to be served from the edge with a
    // stranger's IPv6 address in it on 2026-09-07.
    //
    // The ONLY thing that saves /human/ is that middleware's first guard,
    // `if (c.req.method !== "GET") return`. index.ts mounts no noStore over
    // this path, so if the relay ever gained a GET arm -- or that guard ever
    // moved -- one visitor's email would be served to the next. This test is
    // the tripwire for that, which is why it asserts the absence rather than
    // a particular header value.
    const res = await post("/human/", SUBSCRIBE);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("is UTF-8 HTML, labelled with the language it rendered in", async () => {
    // Content-Language comes from resolveLanguage on the way out; the charset
    // matters because three of the four catalogues are full of non-ASCII
    // (Tá, ddrwg, Gàidhlig) and a mislabelled charset mojibakes them.
    const en = await post("/human/", SUBSCRIBE);
    expect(en.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(en.headers.get("Content-Language")).toBe("en");
    expect((await post("/ga/human/", SUBSCRIBE)).headers.get("Content-Language")).toBe("ga");
  });
});

describe("side effects", () => {
  it("asks the database nothing", async () => {
    // The relay is pure string-shuffling and must stay that way: it sits in
    // front of EVERY public form submission on the site, so a query added
    // here is a query on the critical path of every subscribe, flag and
    // registration. The binding is a real, working, migration-built SQLite
    // (proved by the control below), so this asserts restraint, not breakage.
    await post("/human/", SUBSCRIBE);
    await post("/human/", { action: "subscribe" }); // the 403 path too
    expect(prepares).toEqual([]);

    // NEGATIVE CONTROL. Without this, an inert recorder -- a countingD1 that
    // stopped pushing, a binding never actually passed to the app -- would
    // make the assertion above pass forever regardless of what the handler
    // did. One real query proves the instrument works.
    const control = countingD1(db, prepares);
    await control.prepare("SELECT COUNT(*) AS n FROM foodbank").first();
    expect(prepares).toEqual(["SELECT COUNT(*) AS n FROM foodbank"]);
  });

  it("gives two identical submissions identical relay forms", async () => {
    // Idempotence, stated as the property that matters: the relay must be a
    // pure function of the POST it was handed. A browser retry, a
    // double-clicked submit or the visitor's back button all replay the same
    // POST, and each must produce a page that posts the same fields to the
    // same place. The debug comment's timestamp and timer legitimately differ
    // between two requests, so the clock is frozen and the whole form element
    // -- action, widget and every hidden field -- is compared, rather than a
    // chosen subset that could not notice a new element appearing.
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const formOf = (html: string) => html.slice(html.indexOf("<form"), html.indexOf("</form>"));

    const first = await (await post("/human/", SUBSCRIBE)).text();
    const second = await (await post("/human/", SUBSCRIBE)).text();
    expect(formOf(second)).toBe(formOf(first));
    expect(formOf(first)).toContain('<input type="hidden" name="email" value="visitor@example.com">');
  });
});

describe("the middlewares it depends on but does not declare", () => {
  // humanRelay reads two context variables it neither sets nor checks for:
  // `lang`/`pathAfterPrefix` (middleware/resolveLanguage.ts) and
  // `requestStartTime` (middleware/serverTiming.ts). index.ts mounts both on
  // "*", so this is not a live bug -- but the coupling is undeclared, and the
  // failure mode if anyone ever mounts this handler elsewhere (a second app, a
  // test, a preview worker) is not a crash. It is a page that renders fine and
  // is subtly wrong. Mounted here on a BARE Hono app -- the real handler, no
  // middleware -- to record exactly what "subtly wrong" is.

  async function bare(path: string): Promise<Response> {
    const solo = new Hono<AppEnv>();
    solo.post("/human/", humanRelay);
    return solo.request(
      `${ORIGIN}${path}`,
      { method: "POST", headers: { "Content-Type": FORM }, body: new URLSearchParams(SUBSCRIBE).toString() },
      env(),
    );
  }

  it("still relays, but with no alternates and a NaN render time", async () => {
    const html = await (await bare("/human/")).text();
    // The relay itself is unaffected -- which is why this goes unnoticed.
    expect(formAction(html)).toBe("/needs/at/salisbury/updates/subscribe/");
    // `lang` is undefined, so buildPageContext takes its `locale ?? "en"`
    // branch and emits NO alternates at all, despite pageTranslatable: true.
    expect(html).not.toContain('rel="alternate"');
    expect(html).toContain('<html lang="en" dir="ltr"');
    // elapsedMs subtracts an unset requestStartTime. debugcomment.njk prints
    // the result verbatim, exactly as routes/admin/pageContext.ts's does.
    expect(html).toContain("⏱️ Took NaNms");
  });

  it("500s on a body it cannot parse, rather than treating it as an empty form", async () => {
    // A malformed multipart body (a Content-Type promising multipart with no
    // boundary) makes parseBody REJECT rather than return {}, so the promise
    // this handler returns rejects and index.ts's app.onError renders the 500
    // page. Pinned as current behaviour and as the honest answer to "what
    // happens on a malformed message": the visitor gets an error page, not a
    // silent 403, and console.error records it -- which is the right side to
    // fail on, since a 403 would look like a deliberate refusal.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      `${ORIGIN}/human/`,
      { method: "POST", headers: { "Content-Type": "multipart/form-data" }, body: "not a multipart body" },
      env(),
    );
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
    expect(prepares).toEqual([]);
  });
});
