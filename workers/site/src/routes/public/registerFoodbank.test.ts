import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import { hmacSha256Hex } from "../../lib/hmac";
import type { Env } from "../../../worker-configuration";

// routes/public/publicRegisterFoodbank -- the one public form on this site
// that can put a new food bank into the database, by way of an email to
// mail@givefood.org.uk. Nothing here writes a row, so there is no row to read
// back: the OUTPUT of this route is a Postmark payload and a rendered page,
// and both are asserted here as exact values rather than as "an email was
// sent" or "a 200 came back".
//
// REAL APP, REAL MIDDLEWARE, REAL TEMPLATES -- same harness as the
// neighbouring flag.test.ts, and for the same reason. The app under test is
// the default export of workers/site/src/index.ts, so every request runs the
// real registration order (serverTiming, cacheTag, runtimeIdentity,
// slugRedirect, resolveLanguage, geoJsonPreload, pageCacheControl, then the
// noStore mounts) and renders public/register_foodbank.njk through the real
// nunjucks environment with the real .po catalogues. That matters more than
// usual here: this route is registered TWICE per locale (index.ts:446-453,
// one GET and one POST at the same path into the same handler), so a test
// against a hand-built router would not be testing the thing that decides
// whether a GET can send an email. Nothing on this route touches D1, KV, R2
// or a queue, so no binding is faked. Only global fetch is stubbed, because
// Turnstile siteverify and Postmark are the two real network calls.
//
// The Django original is givefood/views.py:451-480 (register_foodbank) with
// FoodbankRegistrationForm at givefood/forms.py:38-49 and the email body at
// givefood/templates/public/registration_email.txt. Every parity claim below
// was checked by reading those files in /Users/jasoncartwright/Sites/foodcharity;
// no Python was run, so nothing here claims a measured CPython result.

const CSRF_SECRET = "test-csrf-secret";

const env = {
  CSRF_SECRET,
  TURNSTILE_SECRET: "test-turnstile-secret",
  POSTMARK_TOKEN: "test-postmark-token",
} as unknown as Env;

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const POSTMARK = "https://api.postmarkapp.com/email";

interface Outbound {
  url: string;
  body: string;
}

let outbound: Outbound[] = [];

/**
 * Stubs the route's two real network calls and records them, so a test can
 * assert on what was SENT and on how many subrequests a rejected submission
 * cost. `turnstile` decides what siteverify answers for a NON-EMPTY token; an
 * empty one is always rejected, because that is what the real endpoint does
 * (`missing-input-response`) and a stub that waved it through would let
 * "the Turnstile check was deleted" pass as a green run.
 */
function stubFetch({ turnstile = true, postmarkOk = true, postmarkStatus }: { turnstile?: boolean; postmarkOk?: boolean; postmarkStatus?: number } = {}) {
  outbound = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    outbound.push({ url, body });
    if (url === SITEVERIFY) {
      const submitted = new URLSearchParams(body).get("response") ?? "";
      return new Response(JSON.stringify({ success: turnstile && submitted.length > 0 }), { status: 200 });
    }
    if (url === POSTMARK) return new Response("{}", { status: postmarkStatus ?? (postmarkOk ? 200 : 422) });
    throw new Error(`unexpected fetch to ${url}`);
  });
}

// A matching cookie/field pair: the raw token, plus the `__Host-csrf` cookie
// whose HMAC over it actually verifies. This is what a real submission
// carries -- the browser's cookie from the GET, and the hidden field the
// template rendered from the same token -- so every POST helper below sends
// both unless a test is specifically about one being wrong.
const RAW = "a".repeat(64);
async function csrfCookie(): Promise<string> {
  return `__Host-csrf=${RAW}.${await hmacSha256Hex(CSRF_SECRET, RAW)}`;
}

function get(path: string, headers: Record<string, string> = {}, useEnv: Env = env) {
  return app.request(`https://www.givefood.org.uk${path}`, { headers }, useEnv);
}

async function post(
  path: string,
  fields: Record<string, string>,
  { csrf = true, headers = {}, useEnv = env }: { csrf?: boolean; headers?: Record<string, string>; useEnv?: Env } = {},
) {
  return app.request(
    `https://www.givefood.org.uk${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(csrf ? { Cookie: await csrfCookie() } : {}),
        ...headers,
      },
      body: new URLSearchParams({ ...(csrf ? { csrf_token: RAW } : {}), "cf-turnstile-response": "turnstile-token", ...fields }).toString(),
    },
    useEnv,
  );
}

/** The `value="..."` of a named `<input>` in the rendered form, decoded far enough to compare. */
function inputValue(html: string, name: string): string | undefined {
  const m = new RegExp(`<input[^>]*\\sname="${name}"[^>]*\\svalue="([^"]*)"`).exec(html);
  return m?.[1];
}

/** The body of the `address` `<textarea>` -- the one genuinely multi-line field. */
function textareaValue(html: string): string | undefined {
  return /<textarea name="address"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1];
}

interface PostmarkPayload {
  From: string;
  To: string;
  Cc: string | null;
  Bcc: string | null;
  Subject: string;
  TextBody: string;
  HtmlBody: string | null;
  ReplyTo: string | null;
  MessageStream: string;
}

function sentEmail(): PostmarkPayload | undefined {
  const mail = outbound.find((o) => o.url === POSTMARK);
  return mail ? (JSON.parse(mail.body) as PostmarkPayload) : undefined;
}

// A submission that satisfies every rule in validateRegistration(): both
// optional URL fields deliberately blank, and a genuinely multi-line address,
// because those are the two shapes most likely to be broken by a careless
// tightening of the validator.
const VALID = {
  name: "Sid Valley",
  address: "1 High St\nSidmouth",
  postcode: "EX10 8LS",
  country: "England",
  network: "Trussell",
  email: "hello@sidvalleyfoodbank.org.uk",
  phone_number: "01395 000000",
  charity_number: "1188192",
  website: "https://www.sidvalleyfoodbank.org.uk",
  shopping_list_link: "",
  facebook: "",
};

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /register-foodbank/ renders the registration form", () => {
  it("posts through the /human/ relay, not straight back at itself", async () => {
    // The whole Turnstile arrangement depends on these three hidden fields.
    // register_foodbank.njk's form action is /human/ (routes/human.ts), which
    // re-emits every field as a hidden input on a page carrying the invisible
    // widget and auto-submits to `target`. If `target` or `action` went
    // missing, humanRelay() answers 403 and the form silently stops working
    // for every visitor; if the action pointed back here directly, the widget
    // would never render and every submission would fail the gate instead.
    const html = await (await get("/register-foodbank/")).text();

    expect(html).toContain('<form method="post" action="/human/">');
    expect(html).toContain('<input type="hidden" name="target" value="/register-foodbank/">');
    expect(html).toContain('<input type="hidden" name="action" value="register-foodbank">');
  });

  it("starts every field blank, with nothing carried over from the query string", async () => {
    // emptyFormValues() is what the GET branch renders. Asserted per field
    // rather than by counting empty attributes, so a handler that started
    // populating form_values from c.req.query() -- an easy "helpful" change,
    // and a reflected-content foothold -- fails here. The query string below
    // names every field precisely so that mistake would show up.
    const html = await (await get(`/register-foodbank/?${new URLSearchParams(VALID).toString()}`)).text();

    for (const field of ["name", "postcode", "email", "phone_number", "charity_number", "website", "shopping_list_link", "facebook"]) {
      expect(inputValue(html, field), field).toBe("");
    }
    expect(textareaValue(html)).toBe("");
    // No option pre-selected either: the two ChoiceFields start on the
    // "---------" placeholder, exactly as Django's unbound form renders them.
    expect(html).not.toContain("selected>");
  });

  it("offers exactly Django's COUNTRIES and FOODBANK_NETWORKS, in Django's order", async () => {
    // givefood/const/general.py:4-13 and :37-42 -- the port's
    // packages/models COUNTRIES/FOODBANK_NETWORKS are the same seven and
    // three strings in the same order, and this route is what feeds them to
    // the template. Pinned as the full ordered list rather than as
    // "contains England", because a submission whose country is not in this
    // list is rejected by validateRegistration(): dropping an option here
    // and dropping the ability to register a Jersey food bank are the same
    // bug, and it would be invisible in a status-code test.
    const html = await (await get("/register-foodbank/")).text();

    expect(html.match(/<option value="([^"]*)"[^>]*>/g)).toEqual([
      '<option value="">',
      '<option value="England">',
      '<option value="Wales">',
      '<option value="Scotland">',
      '<option value="Northern Ireland">',
      '<option value="Isle of Man">',
      '<option value="Jersey">',
      '<option value="Guernsey">',
      '<option value="">',
      '<option value="Trussell">',
      '<option value="IFAN">',
      '<option value="Independent">',
    ]);
  });

  it("mints a CSRF token and the headers that keep the page out of a shared cache", async () => {
    // UNLIKE ITS NEIGHBOUR /flag/, which deliberately gave this up (issue
    // #40, flag.test.ts). This route kept both halves: issueCsrfToken() puts
    // a per-visitor token in the HTML, and index.ts:203 mounts noStore on
    // this exact path so the token-bearing page can never be served to a
    // second visitor. Removing either alone is a live incident this repo has
    // already had -- a cached token means every other visitor's POST fails
    // verifyCsrf and loses what they typed.
    const res = await get("/register-foodbank/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-csrf=[0-9a-f]{64}\.[0-9a-f]{64}; Secure; HttpOnly; SameSite=Lax; Path=\/$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store, max-age=0, must-revalidate");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");

    // The token in the cookie is the token in the form -- that equality is
    // the whole double-submit check, so it is asserted rather than assumed.
    const cookieRaw = /__Host-csrf=([0-9a-f]{64})\./.exec(res.headers.get("Set-Cookie") ?? "")?.[1];
    expect(cookieRaw).toBeDefined();
    expect(html).toContain(`<input type="hidden" name="csrf_token" value="${cookieRaw}">`);
  });

  it("reuses a returning visitor's cookie rather than replacing it", async () => {
    // lib/csrf.ts's reuse path, exercised through this route because this is
    // one of the pages that made it necessary. Minting unconditionally
    // replaced the cookie on every render, so only the most recently rendered
    // tab could submit -- open the form twice and the first tab 403s. Here
    // that would silently redirect to ?turnstilefail=true and discard a
    // whole registration.
    const res = await get("/register-foodbank/", { Cookie: await csrfCookie() });

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain(`<input type="hidden" name="csrf_token" value="${RAW}">`);
  });

  it("shows the confirmation and removes the form on ?thanks=1", async () => {
    const html = await (await get("/register-foodbank/?thanks=1")).text();

    // Raw apostrophe, not &#39;: `{% blocktrans %}` blocks emit their
    // translated text unescaped, where the `{{ _("...") }}` help texts on the
    // same page come back escaped. Asserted as it actually renders.
    expect(html).toContain("Thanks! We'll try and get back to you within a couple days.");
    // register_foodbank.njk's `{% if done %}` swaps out the entire form, so
    // there is no field to refill and no token on the page at all. Asserted
    // because a template edit that moved the confirmation ABOVE the form
    // instead of replacing it would leave a POST target on a page reachable
    // straight from a redirect.
    expect(html).not.toContain('name="csrf_token"');
    expect(html).not.toContain('name="name"');
  });

  it("treats only the literal string \"1\" as thanks -- narrower than Django", async () => {
    // DELIBERATE DIVERGENCE, pinned so it is a decision rather than a drift.
    // Django's views.py:457 is `done = request.GET.get("thanks", False)`,
    // which is truthy for ANY non-empty value, so ?thanks=yes shows the
    // confirmation there. The port compares to "1" exactly -- the only value
    // its own redirect ever produces -- so every other spelling falls through
    // to the form. Read from views.py; no Python run.
    for (const q of ["?thanks=", "?thanks=yes", "?thanks=true", "?thanks=0"]) {
      const html = await (await get(`/register-foodbank/${q}`)).text();
      expect(html, q).not.toContain("Thanks! We'll try");
      expect(html, q).toContain('name="csrf_token"');
    }
    // ...and an unrelated extra parameter does not disturb the real one.
    expect(await (await get("/register-foodbank/?thanks=1&utm_source=x")).text()).toContain("Thanks! We'll try");
  });

  it("shows the security-check notice on ?turnstilefail=true, above a still-usable form", async () => {
    // Where the POST gate's rejection lands. The visitor must get a form back
    // -- with a fresh token -- or the page is a dead end; that is the failure
    // mode the ?turnstilefail= convention exists to avoid.
    const html = await (await get("/register-foodbank/?turnstilefail=true")).text();

    expect(html).toContain("Sorry, the security check failed. Please try again.");
    expect(html).toMatch(/<input type="hidden" name="csrf_token" value="[0-9a-f]{64}">/);
    // Only the one notice: a turnstile failure is not also a form error.
    expect(html).not.toContain("Sorry, please check the details below");
    expect(html).not.toContain("Sorry, something went wrong sending your registration");
  });

  it("matches ?turnstilefail= on the literal \"true\" only", async () => {
    for (const q of ["?turnstilefail=1", "?turnstilefail=TRUE", "?turnstilefail="]) {
      expect(await (await get(`/register-foodbank/${q}`)).text(), q).not.toContain("Sorry, the security check failed");
    }
  });

  it("renders without a single subrequest, and a GET can never send an email", async () => {
    // index.ts registers GET and POST at this path into the SAME handler, so
    // "does the GET branch do POST work" is a real question rather than a
    // theoretical one -- this repo has previously shipped a GET route able to
    // run an UPDATE. The query string here is a complete, valid registration:
    // if the method check at the top of publicRegisterFoodbank ever softened,
    // this would put a real email on the wire and the assertion catches it.
    await get(`/register-foodbank/?${new URLSearchParams(VALID).toString()}`);

    expect(outbound).toEqual([]);
  });

  it("fails closed with no CSRF_SECRET: empty field, no cookie, nothing pretending to work", async () => {
    // lib/csrf.ts's unset-secret path, reached through this route. The point
    // is that the page still renders (visitors see the form) while every
    // submission it produces will be rejected -- an operator misconfiguration
    // that is loud in the logs rather than a page that silently half-works.
    const noSecret = { TURNSTILE_SECRET: "test-turnstile-secret", POSTMARK_TOKEN: "test-postmark-token" } as unknown as Env;
    const res = await get("/register-foodbank/", {}, noSecret);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(html).toContain('<input type="hidden" name="csrf_token" value="">');
    expect(html).not.toMatch(/\b[0-9a-f]{64}\b/);
  });
});

describe("POST /register-foodbank/ -- the human gate runs first, and short-circuits", () => {
  it("accepts a submission with a matching cookie and a good Turnstile token", async () => {
    const res = await post("/register-foodbank/", VALID);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?thanks=1");
  });

  it("rejects a submission with no cookie WITHOUT paying for siteverify", async () => {
    // verifyHumanGate()'s documented ordering: verifyCsrf() is local HMAC
    // work, validateTurnstile() is a network round-trip, so a request that
    // already fails CSRF -- a stale tab, a replay, a bot posting straight at
    // this path without going through /human/ -- must cost zero subrequests.
    // The empty `outbound` is the assertion that carries that; the redirect
    // alone would pass even if siteverify were called first.
    const res = await post("/register-foodbank/", VALID, { csrf: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    expect(outbound).toEqual([]);
  });

  it("rejects a token that does not match the cookie", async () => {
    // The double-submit half. A cookie alone is not enough -- that is the
    // difference between this and a plain session check, and it is what an
    // attacker who can set a cookie from a sibling subdomain cannot beat.
    const res = await app.request(
      "https://www.givefood.org.uk/register-foodbank/",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: await csrfCookie() },
        body: new URLSearchParams({ ...VALID, csrf_token: "b".repeat(64), "cf-turnstile-response": "turnstile-token" }).toString(),
      },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    expect(outbound).toEqual([]);
  });

  it("rejects a cross-origin submission even with a valid cookie and token", async () => {
    const res = await post("/register-foodbank/", VALID, { headers: { Origin: "https://evil.example" } });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    expect(outbound).toEqual([]);
  });

  it("calls siteverify with the configured secret once CSRF passes, and refuses on a no", async () => {
    stubFetch({ turnstile: false });
    const res = await post("/register-foodbank/", VALID);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY]);
    expect(new URLSearchParams(outbound[0]!.body).get("secret")).toBe("test-turnstile-secret");
    expect(new URLSearchParams(outbound[0]!.body).get("response")).toBe("turnstile-token");
  });

  it("refuses a submission carrying no Turnstile response at all", async () => {
    const { "cf-turnstile-response": _omitted, ...noToken } = { ...VALID, "cf-turnstile-response": "" };
    const res = await post("/register-foodbank/", { ...noToken, "cf-turnstile-response": "" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY]);
  });

  it("runs the gate BEFORE validation, so a bot's garbage never reaches the validator", async () => {
    // A failed gate redirects; a failed validation re-renders in place. If
    // the two were the other way round, a bot posting nonsense with no token
    // would get a 200 with a fresh CSRF token in it -- handing out exactly
    // the credential the gate exists to withhold.
    const res = await post("/register-foodbank/", { name: "", website: "not-a-url" }, { csrf: false });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/register-foodbank/?turnstilefail=true");
    expect(outbound).toEqual([]);
  });

  it("redirects a rejected submission back to its own locale's page", async () => {
    // urlForLocale(locale, "register_foodbank") -- register_foodbank is in
    // packages/urls I18N_SCOPED, matching givefood/urls.py:22's placement
    // inside i18n_patterns. A bare "/register-foodbank/" here would throw a
    // Welsh visitor onto the English page and lose their language.
    for (const locale of ["cy", "ga", "gd"]) {
      const res = await post(`/${locale}/register-foodbank/`, VALID, { csrf: false });
      expect(res.headers.get("Location"), locale).toBe(`/${locale}/register-foodbank/?turnstilefail=true`);
    }
  });
});

describe("POST /register-foodbank/ -- what validateRegistration() refuses", () => {
  // Each case is VALID with one field spoilt, so a rejection can only be
  // caused by that field. A validator that stopped checking anything at all
  // would still pass a suite that only ever posted VALID, which is why every
  // rule gets its own counter-example here.
  const rejected: [string, Partial<Record<keyof typeof VALID, string>>][] = [
    ["name blank", { name: "" }],
    ["name whitespace only", { name: "   " }],
    ["name 101 characters", { name: "n".repeat(101) }],
    ["name with an embedded newline", { name: "Sid\nValley" }],
    ["name with an embedded carriage return", { name: "Sid\rValley" }],
    ["address blank", { address: "" }],
    ["address whitespace only", { address: " \n  " }],
    ["postcode blank", { postcode: "" }],
    ["postcode 11 characters", { postcode: "12345678901" }],
    ["country blank", { country: "" }],
    ["country in the wrong case", { country: "england" }],
    ["country padded with a space", { country: " England" }],
    ["country not on the list", { country: "France" }],
    ["network blank", { network: "" }],
    ["network misspelt", { network: "Trussel" }],
    ["email with no dot in the domain", { email: "hello@example" }],
    ["email with no @", { email: "hello.example.com" }],
    ["email over 320 characters", { email: `${"e".repeat(316)}@b.co` }],
    ["phone_number blank", { phone_number: "" }],
    ["charity_number with an embedded newline", { charity_number: "1188192\nCc: someone@example.com" }],
    ["website blank", { website: "" }],
    ["website with no scheme", { website: "www.example.org" }],
    ["website on a non-http scheme", { website: "ftp://example.org" }],
    ["website as a javascript: URL", { website: "javascript:alert(1)" }],
    ["shopping_list_link present but not a URL", { shopping_list_link: "coming soon" }],
    ["shopping_list_link on a non-http scheme", { shopping_list_link: "ftp://example.org/list" }],
    ["facebook present but not a URL", { facebook: "@SidValleyFoodBank" }],
  ];

  for (const [label, patch] of rejected) {
    it(`refuses ${label}`, async () => {
      const res = await post("/register-foodbank/", { ...VALID, ...patch });

      // 200, not a redirect: the visitor keeps everything they typed.
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Sorry, please check the details below and try again.");
      // AND NO EMAIL WENT. The status alone would pass under a validator that
      // rejected the form after already mailing it.
      expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY]);
    });
  }

  it("refuses a submission with the form fields missing entirely", async () => {
    // What a bot that got past the gate but posted nothing sends. parseBody
    // yields undefined for each name, the `typeof === "string"` guards turn
    // them into "", and validation rejects on the first required field.
    const res = await post("/register-foodbank/", {});

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sorry, please check the details below and try again.");
    expect(sentEmail()).toBeUndefined();
  });

  it("treats an uploaded file in a text field as empty rather than stringifying it", async () => {
    // The reason every field is read through `typeof body.x === "string"`.
    // A multipart submission can make parseBody hand back a File; without the
    // guard that object would be concatenated into the notification email as
    // "[object File]", and here it would sail past a truthiness check.
    const fd = new FormData();
    for (const [k, v] of Object.entries(VALID)) fd.set(k, v);
    fd.set("csrf_token", RAW);
    fd.set("cf-turnstile-response", "turnstile-token");
    fd.set("name", new File(["x"], "name.txt", { type: "text/plain" }));

    const res = await app.request("https://www.givefood.org.uk/register-foodbank/", { method: "POST", headers: { Cookie: await csrfCookie() }, body: fd }, env);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(inputValue(html, "name")).toBe("");
    expect(html).not.toContain("object File");
    expect(sentEmail()).toBeUndefined();
  });
});

describe("POST /register-foodbank/ -- what validateRegistration() lets through", () => {
  // The other half of the filter. A validator tightened by accident -- say
  // requiring charity_number, or rejecting a multi-line address -- would pass
  // every rejection test above while quietly refusing real registrations, and
  // nobody would hear about it because the failure is a re-rendered form on
  // someone else's screen.
  const accepted: [string, Partial<Record<keyof typeof VALID, string>>][] = [
    ["both optional URL fields blank", { shopping_list_link: "", facebook: "" }],
    ["charity_number blank -- required=False in forms.py:46", { charity_number: "" }],
    ["a Scottish charity number", { charity_number: "SC041954" }],
    ["both optional URL fields filled", { shopping_list_link: "https://example.org/list/", facebook: "https://www.facebook.com/SidValleyFoodBank" }],
    ["a plain http:// website", { website: "http://www.sidvalleyfoodbank.org.uk" }],
    ["a multi-line address -- a genuine Textarea in both ports", { address: "The Old Chapel\n1 High Street\nSidmouth\nDevon" }],
    ["name at exactly 100 characters", { name: "n".repeat(100) }],
    ["postcode at exactly 10 characters", { postcode: "1234567890" }],
    ["email at exactly 320 characters", { email: `${"e".repeat(315)}@b.co` }],
    ["every country on the list", { country: "Guernsey" }],
    ["every network on the list", { network: "Independent" }],
    ["padding that trims away", { name: "  Sid Valley  ", website: "  https://www.sidvalleyfoodbank.org.uk  " }],
  ];

  for (const [label, patch] of accepted) {
    it(`accepts ${label}`, async () => {
      const res = await post("/register-foodbank/", { ...VALID, ...patch });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/register-foodbank/?thanks=1");
      expect(sentEmail()).toBeDefined();
    });
  }
});

describe("POST /register-foodbank/ -- the notification email is the route's real output", () => {
  it("sends exactly one Postmark message with the whole submission in it", async () => {
    await post("/register-foodbank/", VALID);

    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY, POSTMARK]);
    const mail = sentEmail()!;
    expect(mail.To).toBe("mail@givefood.org.uk");
    expect(mail.From).toBe("mail@givefood.org.uk");
    // views.py:468 -- "New Food Bank Registration - %s" % request.POST.get("name").
    expect(mail.Subject).toBe("New Food Bank Registration - Sid Valley");
    expect(mail.MessageStream).toBe("outbound");
    expect(mail.HtmlBody).toBeNull();
    expect(mail.ReplyTo).toBeNull();

    // redactedKeyValueLines() over RegistrationFormValues: one "key: value"
    // line per field, in the interface's declaration order. Pinned as the
    // entire body, because this email is the only record a maintainer gets --
    // a field silently dropped from the middle of it is a food bank whose
    // phone number never arrives, and no test asserting "contains name" would
    // notice.
    expect(mail.TextBody).toBe(
      [
        "name: Sid Valley",
        "address: 1 High St",
        "Sidmouth",
        "postcode: EX10 8LS",
        "country: England",
        "network: Trussell",
        "email: hello@sidvalleyfoodbank.org.uk",
        "phone_number: 01395 000000",
        "charity_number: 1188192",
        "website: https://www.sidvalleyfoodbank.org.uk",
        "shopping_list_link: ",
        "facebook: ",
      ].join("\n"),
    );
  });

  it("mails the RAW values, not the trimmed copies validation used", async () => {
    // The validate-trimmed/use-raw split the module header documents, and the
    // shape Django has for a different reason: FoodbankRegistrationForm's
    // CharFields all default strip=True, so form.is_valid() sees trimmed
    // values, but views.py:465 renders registration_email.txt from
    // request.POST.items() -- the raw ones. Both ends are asserted, because
    // "we trim before validating" and "we mail what was typed" only mean
    // something together.
    await post("/register-foodbank/", { ...VALID, name: "  Sid Valley  ", website: "  https://www.sidvalleyfoodbank.org.uk  " });

    const mail = sentEmail()!;
    expect(mail.TextBody).toContain("name:   Sid Valley  ");
    expect(mail.TextBody).toContain("website:   https://www.sidvalleyfoodbank.org.uk  ");
    // The subject too -- it also reads the raw value.
    expect(mail.Subject).toBe("New Food Bank Registration -   Sid Valley  ");
  });

  it("never puts the CSRF or Turnstile token in the email", async () => {
    // WHAT ACTUALLY KEEPS THEM OUT, stated accurately: the handler copies
    // eleven NAMED fields into `values` and mails that, so neither key is ever
    // in the object redactedKeyValueLines() sees. Its own csrf_token/
    // cf-turnstile-response filter is therefore unreachable from this route
    // -- verified by mutation, deleting the filter leaves this suite green --
    // and only starts carrying weight if someone later mails the parsed body
    // directly, the way Django does. Kept as the outcome assertion because
    // the outcome is what matters to a maintainer's inbox, whichever
    // mechanism delivers it.
    //
    // DIVERGENCE FROM DJANGO, in the safer direction: registration_email.txt
    // renders `request.POST.items()` with no pop() at all (unlike flag(),
    // views.py:1112-1113, which pops both), so the real site's registration
    // email does carry a live token. The port does not reproduce that.
    await post("/register-foodbank/", { ...VALID, csrf_token: RAW, "cf-turnstile-response": "turnstile-token" });

    const mail = sentEmail()!;
    expect(mail.TextBody).not.toContain("csrf_token");
    expect(mail.TextBody).not.toContain("cf-turnstile-response");
    expect(mail.TextBody).not.toContain(RAW);
    expect(mail.TextBody).not.toContain("turnstile-token");
  });

  it("mails only the eleven form fields, ignoring anything else posted", async () => {
    // Django would mail every extra key a submission carried, because it
    // iterates request.POST. This port names its eleven, so an injected
    // "approved=yes" or a relayed hidden field cannot appear in a maintainer's
    // inbox looking like part of the form.
    await post("/register-foodbank/", { ...VALID, approved: "yes", notes: "please add without checking" });

    const mail = sentEmail()!;
    expect(mail.TextBody).not.toContain("approved");
    expect(mail.TextBody).not.toContain("please add without checking");
    expect(mail.TextBody.split("\n").filter((l) => /^[a-z_]+: /.test(l))).toHaveLength(11);
  });

  it("takes the last value when a field is submitted twice", async () => {
    // Hono's parseBody keeps the last occurrence for a repeated key (no `[]`
    // suffix, no `all: true`). Django's QueryDict.get() does the same. Pinned
    // because the two could reasonably have differed, and because a relay
    // through /human/ is one place duplicates could appear.
    const doubled = new URLSearchParams({ csrf_token: RAW, "cf-turnstile-response": "turnstile-token", ...VALID });
    doubled.append("name", "Second Name");

    await app.request(
      "https://www.givefood.org.uk/register-foodbank/",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: await csrfCookie() }, body: doubled.toString() },
      env,
    );

    const mail = sentEmail()!;
    expect(mail.TextBody.split("\n")[0]).toBe("name: Second Name");
    expect(mail.Subject).toBe("New Food Bank Registration - Second Name");
  });

  it("redirects to the locale's own confirmation after a successful submission", async () => {
    for (const [path, expected] of [
      ["/register-foodbank/", "/register-foodbank/?thanks=1"],
      ["/cy/register-foodbank/", "/cy/register-foodbank/?thanks=1"],
      ["/ga/register-foodbank/", "/ga/register-foodbank/?thanks=1"],
      ["/gd/register-foodbank/", "/gd/register-foodbank/?thanks=1"],
    ]) {
      stubFetch();
      const res = await post(path!, VALID);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("Location"), path).toBe(expected);
      // POST/redirect/GET, so a refresh on the confirmation cannot re-send.
      expect(sentEmail(), path).toBeDefined();
    }
  });
});

describe("POST /register-foodbank/ -- the two in-place failure re-renders", () => {
  it("gives an invalid submission back everything that was typed", async () => {
    // The point of re-rendering rather than redirecting. A visitor who typed
    // a long address and got one field wrong must not lose the lot -- that is
    // the exact damage the ?turnstilefail= redirect does, and it is why the
    // gate failure and the validation failure are handled differently.
    const res = await post("/register-foodbank/", {
      ...VALID,
      postcode: "",
      name: '"><script>alert(1)</script>',
      address: "The Old Chapel\n1 High <Street>",
      shopping_list_link: "coming soon",
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    // HTML-escaped on the way back out -- nunjucks autoescaping, asserted
    // because this is the one page that reflects attacker-supplied text.
    expect(inputValue(html, "name")).toBe("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(textareaValue(html)).toBe("The Old Chapel\n1 High &lt;Street&gt;");
    expect(inputValue(html, "shopping_list_link")).toBe("coming soon");
    expect(inputValue(html, "email")).toBe("hello@sidvalleyfoodbank.org.uk");
    expect(inputValue(html, "charity_number")).toBe("1188192");
    // The empty field is empty, not "undefined" or the string it replaced.
    expect(inputValue(html, "postcode")).toBe("");
    // Both selects come back on the visitor's own choices.
    expect(html).toContain('<option value="England" selected>England</option>');
    expect(html).toContain('<option value="Trussell" selected>Trussell</option>');
  });

  it("hands back the SAME csrf token, so a corrected resubmission works", async () => {
    // The re-render is only useful if the visitor can post it again. Because
    // the gate already passed, their cookie is valid, and issueCsrfToken()
    // takes its reuse path -- so no new cookie is set and the field carries
    // the token they already hold. If it minted a fresh one WITHOUT setting
    // the cookie (or set a cookie the /human/ relay never round-trips), the
    // corrected resubmission would fail the gate and the visitor would be
    // bounced to ?turnstilefail=true having fixed their own mistake.
    const res = await post("/register-foodbank/", { ...VALID, postcode: "" });
    const html = await res.text();

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(html).toContain(`<input type="hidden" name="csrf_token" value="${RAW}">`);

    stubFetch();
    const corrected = await post("/register-foodbank/", VALID);
    expect(corrected.status).toBe(302);
    expect(corrected.headers.get("Location")).toBe("/register-foodbank/?thanks=1");
  });

  it("shows only the form_error notice, never the turnstile or send-failure one", async () => {
    // The three notices are separate context flags and the template renders
    // whichever are true. The POST branch never passes `turnstilefail` at
    // all, so even a re-render reached at ?turnstilefail=true shows one
    // message -- pinned so a visitor with a typo is never also told the
    // security check failed.
    const html = await (await post("/register-foodbank/?turnstilefail=true", { ...VALID, postcode: "" })).text();

    expect(html).toContain("Sorry, please check the details below and try again.");
    expect(html).not.toContain("Sorry, the security check failed");
    expect(html).not.toContain("Sorry, something went wrong sending your registration");
    expect(html).not.toContain("Thanks! We'll try");
  });

  it("re-renders with send_failed when Postmark refuses, keeping the submission", async () => {
    // sendEmail() returns false on anything but a 200 (Django's send_email()
    // checks status_code == 200 exactly). A silent redirect to ?thanks=1 here
    // would tell a food bank they had registered when the email never
    // arrived -- and since nothing is written to the database, that
    // submission would be gone for good.
    stubFetch({ postmarkOk: false });
    const res = await post("/register-foodbank/", VALID);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Sorry, something went wrong sending your registration. Please try again.");
    expect(html).not.toContain("Sorry, please check the details below");
    // Their details are still on the page to resubmit.
    expect(inputValue(html, "name")).toBe("Sid Valley");
    expect(inputValue(html, "website")).toBe("https://www.sidvalleyfoodbank.org.uk");
    expect(textareaValue(html)).toBe("1 High St\nSidmouth");
    // The attempt was genuinely made -- both subrequests happened.
    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY, POSTMARK]);
  });

  it("treats a 2xx that is not 200 as a failure, matching Django exactly", async () => {
    // notifications.py's send_email() checks `result.status_code == 200`, not
    // "any 2xx", and lib/email.ts matched that narrowness on purpose rather
    // than "improving" it to response.ok. Asserted through the route because
    // lib/email.ts has no suite of its own: without this case a change to
    // `if (!response.ok)` is invisible, and a 202 (Postmark accepted for
    // later processing) would silently become a confirmation page.
    stubFetch({ postmarkStatus: 202 });
    const res = await post("/register-foodbank/", VALID);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sorry, something went wrong sending your registration.");
  });

  it("reports send_failed when POSTMARK_TOKEN is unset, without a wasted subrequest", async () => {
    // lib/email.ts returns false before fetching when the token is missing.
    // The visitor sees the same honest failure as a Postmark 422 rather than
    // a false confirmation -- the misconfiguration case that would otherwise
    // discard every registration silently.
    const noToken = { CSRF_SECRET, TURNSTILE_SECRET: "test-turnstile-secret" } as unknown as Env;
    const res = await post("/register-foodbank/", VALID, { useEnv: noToken });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sorry, something went wrong sending your registration.");
    expect(outbound.map((o) => o.url)).toEqual([SITEVERIFY]);
  });

  it("never lets a POST response acquire a shared-cache header", async () => {
    // pageCacheControl returns early on method, and noStore covers the path
    // regardless. Both re-render paths carry a CSRF token, so a cacheable one
    // would be the same incident issue #40 describes for /flag/.
    stubFetch({ postmarkOk: false });
    for (const res of [await post("/register-foodbank/", { ...VALID, postcode: "" }), await post("/register-foodbank/", VALID)]) {
      expect(res.headers.get("Cache-Control")).toBe("private, no-store, max-age=0, must-revalidate");
      expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    }
  });
});

describe("the prefixed locales render and behave as their own pages", () => {
  it("renders the Welsh page and posts back through the Welsh relay", async () => {
    // givefood/urls.py:22 puts register_foodbank inside i18n_patterns, so
    // /cy/register-foodbank/ is a real URL rather than a redirect to English.
    // The hidden `target` is what the /human/ relay posts at, so a
    // locale-blind url() here would drop a Welsh visitor onto the English
    // route halfway through the submission.
    const html = await (await get("/cy/register-foodbank/")).text();

    expect(html).toContain("<title>Cofrestru banc bwyd - Give Food</title>");
    expect(html).toContain("<h1>Cofrestru banc bwyd</h1>");
    expect(html).toContain('<form method="post" action="/cy/human/">');
    expect(html).toContain('<input type="hidden" name="target" value="/cy/register-foodbank/">');
  });

  it("translates the security-check notice on the prefixed page", async () => {
    // Proof the notice goes through the real .po catalogue rather than being
    // an English literal that happens to sit on a translated page.
    const html = await (await get("/cy/register-foodbank/?turnstilefail=true")).text();

    expect(html).toContain("Mae'n ddrwg gennym, methodd y gwiriad diogelwch. Rhowch gynnig arall arni.");
  });

  it("is not routed for methods other than GET and POST", async () => {
    // index.ts registers app.get and app.post at this path, not app.all. A
    // PUT reaching the handler would fall into the GET branch and hand out a
    // CSRF token to a request no browser form can make.
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await app.request("https://www.givefood.org.uk/register-foodbank/", { method }, env);
      expect(res.status, method).toBe(404);
    }
  });
});

describe("SUSPECT: isSingleLine() validates the trimmed value but the email carries the raw one", () => {
  it("lets a leading newline forge an extra line in the notification email", async () => {
    // NOT A WISH -- this asserts what the code currently does, so the suite
    // stays green and the defect stays visible.
    //
    // packages/models isSingleLine() exists specifically to stop a submitted
    // value forging "key: value" lines in the plain-text email that
    // redactedKeyValueLines() builds; the module header calls it "an
    // email-body-injection gap this port's own redactedKeyValueLines()
    // introduces". But validateRegistration() applies it to `v.name.trim()`
    // while the email is built from the RAW `values`, and String.trim()
    // removes leading/trailing newlines. So "\nfake: injected" trims to a
    // clean single line, passes every check, and is then mailed verbatim --
    // producing a body whose first line is "name: " and whose second is
    // "fake: injected", indistinguishable from a real field to anyone
    // reading the email.
    //
    // Every single-line field is affected (name, postcode, phone_number,
    // charity_number, website, shopping_list_link, facebook), and flag.ts's
    // validateFlag() has the identical shape. Closing it means checking
    // isSingleLine on the RAW value -- which is a source change, not a test
    // change.
    const res = await post("/register-foodbank/", { ...VALID, name: "\nfake: injected" });

    expect(res.status).toBe(302);
    const mail = sentEmail()!;
    expect(mail.TextBody.split("\n").slice(0, 2)).toEqual(["name: ", "fake: injected"]);
    // The subject takes the raw value too, newline and all.
    expect(mail.Subject).toBe("New Food Bank Registration - \nfake: injected");
  });

  it("rejects the same payload when the newline is in the middle", async () => {
    // The half of the check that does work, kept alongside the failure so the
    // scope of the gap is exact rather than "isSingleLine does nothing".
    const res = await post("/register-foodbank/", { ...VALID, name: "Sid\nfake: injected" });

    expect(res.status).toBe(200);
    expect(sentEmail()).toBeUndefined();
  });
});
