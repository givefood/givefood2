import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";

// The port of the four lines givefood/context_processors.py:22-29 filled from
// Coolify environment variables, and which this Worker had been rendering as
// two hardcoded strings ("cf-worker" and "dev") on every page of every deploy
// until 2026-09-05.
//
// Everything here is awkward to test for one reason, and it is the same reason
// the module is worth testing at all: the identity is computed ONCE PER
// ISOLATE and cached in a module-scope variable. So:
//
//   * Each test below boots a *fresh module registry* (vi.resetModules) and
//     calls that an isolate. Sharing one import across tests would mean the
//     first test to run decided the identity for all of them -- which is
//     precisely the caching behaviour under test, so it cannot also be the
//     test harness's accident.
//
//   * Nothing is asserted against the middleware's return value, because it
//     has none. Its only output is the object it hands to setRuntimeIdentity()
//     in packages/templates/src/context.ts, so every test reads it back out of
//     a real buildPageContext() -- the same call the ~60 render sites make.
//     A middleware that computed a perfect identity and forgot to publish it
//     would pass any test that stopped short of that.
//
// The four fields are exactly the ones debugcomment.njk prints: "In colo"
// (colo), "By machine" (instance_id), "Using code" (version), and the
// conditional "Code version" GitHub link (commit).

// Hono's fetch() wants an ExecutionContext; nothing under test touches it.
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/** The shape of the `version_metadata` binding declared in wrangler.jsonc. */
type VersionMetadata = { id?: string; tag?: string; timestamp?: string } | undefined;

/** What wrangler actually puts in the binding on an untagged deploy: a UUID and an empty tag. */
const DEFAULT_METADATA: VersionMetadata = {
  id: "3f8a1c2e-9d4b-4c7a-8e21-6b5f0a9d3c11",
  tag: "",
  timestamp: "2026-09-05T19:28:08.853Z",
};

/** The four fields this middleware owns, as a page render sees them. */
interface Identity {
  colo: string;
  instance_id: string;
  version: string;
  commit: string | null;
}

interface ServeOptions {
  /** `request.cf`. Presence-checked, so `{ cf: undefined }` means "no cf at all". */
  cf?: Record<string, unknown>;
  /** `env.CF_VERSION_METADATA`. Presence-checked the same way. */
  metadata?: VersionMetadata;
  /**
   * Leave the binding off `env` entirely rather than setting it to undefined --
   * a Worker deployed before wrangler.jsonc declared `version_metadata`, where
   * `c.env.CF_VERSION_METADATA` is a missing property and not a present one
   * holding undefined.
   */
  bindingAbsent?: boolean;
}

interface Isolate {
  /** One request through a real Hono app with the middleware mounted on "*", as index.ts mounts it. */
  serve(options?: ServeOptions): Promise<Response>;
  /** The identity a page rendered in this isolate right now would print. */
  identity(): Identity;
  /**
   * The identity each request's page render actually saw, captured INSIDE the
   * downstream handler instead of after the response resolved. Every other
   * reader in this file looks once the request is over, which is precisely
   * when a middleware that published its identity too late still looks
   * correct -- see "publishes the identity before the page renders".
   */
  renders: Identity[];
  /** The downstream route handler, so "did the request get through?" is answerable. */
  handler: ReturnType<typeof vi.fn>;
}

// crypto.getRandomValues is generically typed (<T extends TypedArray>(b: T) => T),
// which vitest's mockImplementation signature will not accept directly. The cast
// is confined to this one helper rather than repeated at each call site.
function stubRandomBytes(bytes: number[]): void {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((buffer: Uint8Array) => {
    buffer.set(bytes);
    return buffer;
  }) as (...args: never[]) => unknown as typeof crypto.getRandomValues);
}

// A fresh module registry is the only way to get an un-minted `identity`
// back: it is a module-scope `let` with no reset hook, deliberately (see the
// module comment on why that is safe rather than a leak). Importing the
// templates package in the SAME generation matters -- resetModules gives
// runtimeIdentity.ts a new copy of context.ts too, and reading the identity
// out of the old copy would report whatever the previous test left there.
async function bootIsolate(): Promise<Isolate> {
  vi.resetModules();
  const { runtimeIdentity } = await import("./runtimeIdentity");
  const { buildPageContext } = await import("@givefood/templates");

  const handler = vi.fn();
  const renders: Identity[] = [];
  const app = new Hono<AppEnv>();
  app.use("*", runtimeIdentity);
  app.all("*", (c) => {
    // The route handlers this middleware exists to serve all call
    // buildPageContext() while the request is still open, so the test's
    // "page" does too. Reading it only after app.fetch() resolves would
    // accept an identity published on the way back out.
    const { colo, instance_id, version, commit } = buildPageContext({ path: "/" });
    renders.push({ colo, instance_id, version, commit });
    handler();
    return c.text("the page body");
  });

  return {
    async serve(options: ServeOptions = {}) {
      const cf = "cf" in options ? options.cf : { colo: "LHR" };
      const metadata = "metadata" in options ? options.metadata : DEFAULT_METADATA;
      const request = new Request("https://www.givefood.org.uk/");
      // Node's Request has no `cf`; workerd's does. Defined rather than
      // faked wholesale so the middleware still reads it off c.req.raw the
      // way it does in production.
      if (cf !== undefined) Object.defineProperty(request, "cf", { value: cf, enumerable: true });
      const env = (options.bindingAbsent ? {} : { CF_VERSION_METADATA: metadata }) as unknown as AppEnv["Bindings"];
      return app.fetch(request, env, execCtx);
    },
    identity() {
      const { colo, instance_id, version, commit } = buildPageContext({ path: "/" });
      return { colo, instance_id, version, commit };
    },
    renders,
    handler,
  };
}

/** The overwhelmingly common case: one cold request into a new isolate. */
async function firstRequest(options: ServeOptions = {}): Promise<Identity> {
  const isolate = await bootIsolate();
  await isolate.serve(options);
  return isolate.identity();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtimeIdentity", () => {
  it("publishes all four debug-comment fields to the template context", async () => {
    // The end-to-end path, and the one that makes every other test here mean
    // something: request.cf and the version binding go in, and the variables
    // debugcomment.njk interpolates come out of buildPageContext(). Before
    // this middleware existed those four were "cf-worker"/"dev" constants, so
    // this is the assertion that the wiring exists at all.
    const isolate = await bootIsolate();

    // Nothing has run yet: context.ts's UNKNOWN_IDENTITY is deliberately
    // distinguishable, so a page rendered outside a request says "unknown"
    // rather than claiming a colo that never saw it.
    expect(isolate.identity()).toEqual({ colo: "unknown", instance_id: "unknown", version: "unknown", commit: null });

    await isolate.serve({ cf: { colo: "MAN" }, metadata: { id: "9be3f0d1-aaaa-bbbb-cccc-ddddeeeeffff", tag: "" } });

    expect(isolate.identity()).toEqual({
      colo: "MAN",
      instance_id: expect.stringMatching(/^[0-9a-f]{7}$/),
      version: "9be3f0d1",
      commit: null,
    });
  });

  it("lets the request through and returns the handler's own response", async () => {
    // It is an identity recorder, not a gate. A regression that threw (a
    // missing binding, an odd `cf`) would take down every page on the site,
    // since index.ts mounts it on "*" above all routing.
    const isolate = await bootIsolate();
    const res = await isolate.serve();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the page body");
    expect(isolate.handler).toHaveBeenCalledTimes(1);
  });

  it("records the identity even when nothing routes, so the 404 page's debug comment is real", async () => {
    // Every other test here hits a matching route. Django rendered
    // debugcomment.njk on its 404 page too, and index.ts mounts this with
    // app.use("*") -- above routing rather than on a route -- so the identity
    // must already be published by the time Hono gives up and falls through to
    // notFound(). Move the registration onto a router, or anywhere that only
    // runs on a match, and the pages that lose their colo and version are
    // exactly the ones people paste into a bug report.
    vi.resetModules();
    const { runtimeIdentity } = await import("./runtimeIdentity");
    const { buildPageContext } = await import("@givefood/templates");
    const app = new Hono<AppEnv>();
    app.use("*", runtimeIdentity);
    app.get("/needs/", (c) => c.text("a real route"));
    app.notFound((c) => {
      // Read inside the handler, while the request is still open, for the same
      // reason the isolate helper does: a late publish looks fine from outside.
      const { colo, version } = buildPageContext({ path: c.req.path });
      return c.text(`404 ${colo} ${version}`, 404);
    });

    const request = new Request("https://www.givefood.org.uk/no-such-page/");
    Object.defineProperty(request, "cf", { value: { colo: "MAN" }, enumerable: true });
    const res = await app.fetch(request, { CF_VERSION_METADATA: DEFAULT_METADATA } as unknown as AppEnv["Bindings"], execCtx);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 MAN 3f8a1c2e");
  });

  it("publishes the identity before the page renders, not on the way back out", async () => {
    // setRuntimeIdentity() is called BEFORE `await next()`, and that ordering
    // is the whole point of the middleware: the page being rendered
    // downstream is the one that interpolates these four values.
    //
    // Move the publish (or the whole `if` block) below `await next()` and
    // every other test in this file still passes -- they all read the
    // identity once the response has resolved, by which time a late publish
    // has landed. What actually breaks in production is narrower and much
    // harder to spot: the FIRST page each new isolate serves renders "In colo
    // unknown / By machine unknown / Using code unknown", so the debug
    // comment is wrong exactly on the cold requests where "which isolate and
    // which deploy served this?" is the question being asked.
    const isolate = await bootIsolate();
    await isolate.serve({ cf: { colo: "MAN" }, metadata: { id: "9be3f0d1-aaaa-bbbb", tag: "" } });

    expect(isolate.renders).toHaveLength(1);
    expect(isolate.renders[0]).toEqual({
      colo: "MAN",
      instance_id: expect.stringMatching(/^[0-9a-f]{7}$/),
      version: "9be3f0d1",
      commit: null,
    });
    // ...and it is the same identity the post-response reader sees, so the
    // two views of it cannot drift apart.
    expect(isolate.renders[0]).toEqual(isolate.identity());

    // The cached branch has to keep it visible too: a `setRuntimeIdentity`
    // that only ran inside `if (!identity)` would be fine, but one that
    // cleared or re-published a partial identity would show up here.
    await isolate.serve({ cf: { colo: "MAN" } });
    expect(isolate.renders[1]).toEqual(isolate.renders[0]);
  });

  it("does not swallow a downstream failure", async () => {
    // There is no try/catch around next(), and there must not be: this sits
    // above all routing in index.ts, so a middleware that caught a broken
    // route and returned its own response would turn every 500 on the site
    // into a silent success and hide it from index.ts's onError handler.
    vi.resetModules();
    const { runtimeIdentity } = await import("./runtimeIdentity");
    const { buildPageContext } = await import("@givefood/templates");
    const app = new Hono<AppEnv>();
    app.use("*", runtimeIdentity);
    app.get("*", () => {
      throw new Error("D1 said no");
    });
    app.onError((err, c) => c.text(`caught: ${err.message}`, 500));

    const res = await app.fetch(
      new Request("https://www.givefood.org.uk/"),
      { CF_VERSION_METADATA: DEFAULT_METADATA } as unknown as AppEnv["Bindings"],
      execCtx,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("caught: D1 said no");
    // The identity was still recorded on the way in, so the error page this
    // isolate renders next carries a real version rather than "unknown".
    expect(buildPageContext({ path: "/" }).version).toBe("3f8a1c2e");
  });

  it("mints exactly one identity for two cold requests that arrive together", async () => {
    // A brand-new isolate very often takes several requests at once, and both
    // of these find `identity` null. Nothing between the `if (!identity)` test
    // and the assignment may yield: insert an await there (a hash of the
    // colo, a KV read for a build number) and the two requests each mint their
    // own id, so two pages served by ONE isolate report two different
    // machines -- which is the single question instance_id exists to answer.
    const isolate = await bootIsolate();
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");

    const responses = await Promise.all([isolate.serve({ cf: { colo: "LHR" } }), isolate.serve({ cf: { colo: "SYD" } })]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    // Whichever request won the race, both rendered the same answer -- the
    // assertion deliberately does not care which colo won, only that one did.
    expect(isolate.renders).toHaveLength(2);
    expect(isolate.renders[0]).toEqual(isolate.renders[1]);
    expect(["LHR", "SYD"]).toContain(isolate.renders[0]?.colo);
  });

  it("awaits next(), so an async page render is not lost", async () => {
    // `await next()` rather than a bare `next()`. Everything downstream is
    // async (D1 reads, a nunjucks render); an un-awaited continuation would
    // drop the response the handler eventually built and serve an empty 404.
    vi.resetModules();
    const { runtimeIdentity } = await import("./runtimeIdentity");
    const app = new Hono<AppEnv>();
    app.use("*", runtimeIdentity);
    app.get("*", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return c.text("rendered after an await", 201);
    });
    const res = await app.fetch(
      new Request("https://www.givefood.org.uk/"),
      { CF_VERSION_METADATA: DEFAULT_METADATA } as unknown as AppEnv["Bindings"],
      execCtx,
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("rendered after an await");
  });
});

describe("runtimeIdentity: colo", () => {
  it("reports the data centre the request arrived at", async () => {
    // Real three-letter IATA codes, because this is the one value here that
    // is read off the request rather than invented, and it is what makes
    // "which edge served this?" answerable from a page's source.
    for (const colo of ["LHR", "MAN", "CDG", "IAD"]) {
      expect((await firstRequest({ cf: { colo } })).colo).toBe(colo);
    }
  });

  it("says 'unknown' rather than throwing when there is no cf at all", async () => {
    // `wrangler dev`, `vitest`, and any synthetic request have no cf object.
    // The middleware runs on "*" before routing, so an unguarded `cf.colo`
    // here would be a 500 on every page in local development.
    const identity = await firstRequest({ cf: undefined });
    expect(identity.colo).toBe("unknown");
    // "unknown" is also the pre-request default, so on its own the assertion
    // above would pass against a middleware that never ran. The minted
    // instance id proves it did run and chose the fallback deliberately.
    expect(identity.instance_id).toMatch(/^[0-9a-f]{7}$/);

    // The other shape a synthetic request takes: `cf` present, holding null.
    // `?.` covers both; `c.req.raw.cf.colo` and a `"colo" in cf` guard each
    // throw on this one while passing the case above, so the two are not
    // interchangeable and both belong here.
    const nullCf = await firstRequest({ cf: null as unknown as Record<string, unknown> });
    expect(nullCf.colo).toBe("unknown");
    expect(nullCf.instance_id).toMatch(/^[0-9a-f]{7}$/);
  });

  it("says 'unknown' when cf is present but carries no colo", async () => {
    // cf is a bag of optional properties; nothing guarantees colo is in it.
    const identity = await firstRequest({ cf: { country: "GB", asn: 12345 } });
    expect(identity.colo).toBe("unknown");
    expect(identity.instance_id).toMatch(/^[0-9a-f]{7}$/);
  });

  it("only falls back for null and undefined, not for an empty colo", async () => {
    // Documents the `??`: an empty-string colo is passed through as "", which
    // renders debugcomment.njk's line as "In colo " with nothing after it.
    // Cloudflare never sends that, so this pins the operator rather than
    // arguing for `||` -- a change to `||` would also swallow a legitimate
    // falsy value if colo ever stopped being a string.
    expect((await firstRequest({ cf: { colo: "" } })).colo).toBe("");
    expect((await firstRequest({ cf: { colo: null } })).colo).toBe("unknown");
    expect((await firstRequest({ cf: {} })).colo).toBe("unknown");
  });

  it("passes a non-string colo through unconverted, cast and all", async () => {
    // `cf?.colo as string` is an unchecked assertion over a bag of `unknown`s,
    // so whatever cf carries reaches the template as-is: these three arrive at
    // nunjucks as a number, a boolean and NaN in a field typed `string`.
    //
    // Pinned as current behaviour, not endorsed -- Cloudflare has only ever
    // sent a three-letter string. It is here because it is what separates `??`
    // from `||` for real (`||` would map 0 and false to "unknown" and this
    // test would fail), and because it says out loud that nothing in the
    // middleware validates or String()s the value on the way through.
    expect((await firstRequest({ cf: { colo: 0 } })).colo as unknown).toBe(0);
    expect((await firstRequest({ cf: { colo: false } })).colo as unknown).toBe(false);
    expect((await firstRequest({ cf: { colo: Number.NaN } })).colo as unknown).toBeNaN();
  });
});

describe("runtimeIdentity: instance id", () => {
  it("mints seven hex characters, matching Django's HASH_CHARS", async () => {
    // context_processors.py truncated COOLIFY_CONTAINER_NAME to
    // HASH_CHARS = 7. Workers exposes no isolate identifier, so this invents
    // one at the same width -- the line in debugcomment.njk keeps the shape
    // an existing reader recognises.
    const identity = await firstRequest();
    expect(identity.instance_id).toMatch(/^[0-9a-f]{7}$/);
    expect(identity.instance_id).toHaveLength(7);
  });

  it("zero-pads every byte, so the id is never short", async () => {
    // The failure this prevents: without padStart, bytes below 0x10 render
    // as one character each and the id comes out 4-7 characters long
    // depending on the random draw. Two isolates could then differ only in
    // length, and a fixed-width debug line would silently mislead.
    // 00 0a ff 01 -> "000aff01" -> first seven. Unpadded it would be "0aff1".
    stubRandomBytes([0x00, 0x0a, 0xff, 0x01]);
    expect((await firstRequest()).instance_id).toBe("000aff0");

    // The same draw with the low bytes at the other end, so the test cannot
    // pass by accident on a leading zero alone. It also pins byte ORDER and
    // the contribution of every byte: reversed this would be "9c000fd", and
    // the final "9" is the high nibble of byte 3, so an id built from three
    // bytes could not produce it either.
    stubRandomBytes([0xde, 0x0f, 0x00, 0x9c]);
    expect((await firstRequest()).instance_id).toBe("de0f009");

    // The two extremes of the draw, which a "combine the bytes into one number
    // and toString(16) it" implementation gets wrong in opposite directions:
    // an all-zero draw must still be seven characters rather than "0", and an
    // all-ones draw must not spill into an eighth.
    stubRandomBytes([0x00, 0x00, 0x00, 0x00]);
    expect((await firstRequest()).instance_id).toBe("0000000");
    stubRandomBytes([0xff, 0xff, 0xff, 0xff]);
    expect((await firstRequest()).instance_id).toBe("fffffff");
  });

  it("asks for four random BYTES, exactly once", async () => {
    // Four bytes is eight hex characters, one more than needed -- the slice
    // is what makes it seven. Asking for three would silently cap the id at
    // six and halve the space the "same isolate?" comparison relies on.
    //
    // The element type is asserted as well as the length because a
    // Uint32Array(4) would satisfy `.length === 4` while asking the runtime
    // for sixteen bytes and then deriving the id from the first element
    // alone. That still renders as seven plausible hex characters, so no
    // assertion about the id's *shape* can catch it.
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");
    await firstRequest();
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    const buffer = getRandomValues.mock.calls[0]?.[0];
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect((buffer as Uint8Array).length).toBe(4);
    expect((buffer as Uint8Array).byteLength).toBe(4);
  });

  it("gives every isolate a different id", async () => {
    // The entire point of the field, per the module comment: it means nothing
    // on its own, but it tells you whether two page loads came from the same
    // isolate. An id derived from anything constant (a build id, a hash of
    // the env) would answer that question wrongly and look fine in a diff.
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await firstRequest()).instance_id);
    expect(ids.size).toBe(5);
  });
});

describe("runtimeIdentity: version and commit", () => {
  it("uses the version id's first eight characters when nothing tagged the deploy", async () => {
    // Nothing currently sets a tag, so this is the line that actually renders
    // in production. Eight characters is enough to identify the deploy and to
    // look it up with `wrangler versions view` or in the dashboard -- pinned
    // because a shorter slice would stop being a usable lookup key.
    const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b-4c7a-8e21-6b5f0a9d3c11", tag: "" } });
    expect(identity.version).toBe("3f8a1c2e");
    // ...and no GitHub link, because a version UUID is not a commit. Django
    // built debugcomment's commit URL straight from `version`; doing that here
    // would render a github.com/.../commit/<uuid> that 404s on every page.
    expect(identity.commit).toBeNull();
  });

  it("treats a git-SHA tag as the commit, truncated to Django's seven characters", async () => {
    // The one case that restores Django's behaviour exactly: there, `version`
    // WAS SOURCE_COMMIT[:7] and the GitHub link was built from it. So when a
    // deploy tags a real SHA, version and commit are the same seven characters.
    const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: "9b11b27ad4f8e1c05a7e2d9f3b6c8a1e4d7f0b23" } });
    expect(identity.version).toBe("9b11b27");
    expect(identity.commit).toBe("9b11b27");

    // This branch returns before the version id is read at all, so the same
    // tag with no id present must give the same two values. Every other
    // fixture in this file supplies a realistic-looking UUID, which is exactly
    // what a regression that fell through to `id.slice(0, 8)` could hide
    // behind: "3f8a1c2e" and "9b11b27" are both eight-ish hex characters and
    // neither looks wrong at a glance.
    const noId = await firstRequest({ metadata: { tag: "9b11b27ad4f8e1c05a7e2d9f3b6c8a1e4d7f0b23" } });
    expect(noId).toMatchObject({ version: "9b11b27", commit: "9b11b27" });
  });

  it("accepts a seven-character SHA and rejects a six-character one", async () => {
    // The {7,40} boundary. Seven is the shortest abbreviation git prints and
    // the shortest GitHub will resolve; six would be a link that 404s, so it
    // is treated as an ordinary tag instead.
    const seven = await firstRequest({ metadata: { id: "aaaaaaaabbbb", tag: "9b11b27" } });
    expect(seven).toMatchObject({ version: "9b11b27", commit: "9b11b27" });

    const six = await firstRequest({ metadata: { id: "aaaaaaaabbbb", tag: "9b11b2" } });
    expect(six.commit).toBeNull();
    expect(six.version).toBe("9b11b2");
  });

  it("rejects anything longer than a full 40-character SHA", async () => {
    // The other end of {7,40}: 41 hex characters is not a commit, and the
    // upper bound is what stops a long hex-ish tag being sliced into a
    // plausible-looking but meaningless link.
    const forty = "a".repeat(40);
    expect((await firstRequest({ metadata: { id: "zz", tag: forty } })).commit).toBe("aaaaaaa");
    const fortyOne = "a".repeat(41);
    const identity = await firstRequest({ metadata: { id: "zz", tag: fortyOne } });
    expect(identity.commit).toBeNull();
    expect(identity.version).toBe(fortyOne);
  });

  it("anchors the pattern, so a tag that merely contains a SHA is not one", async () => {
    // `^...$`. Without the anchors, "abc1234-dirty" would be accepted and
    // sliced to "abc1234", inventing a commit link out of a build label.
    //
    // A tag of "9b11b27\n" is deliberately NOT in this list: trim() strips the
    // newline first, so it really is a SHA (see the trim test).
    //
    // It is worth being exact about WHY that works, because the intuition
    // imported from this module's Python ancestor is wrong: Python's `$`
    // matches just before a trailing newline, so an equivalent
    // re.match("^[0-9a-f]{7,40}$", tag) in Django would have accepted
    // "9b11b27\n" with no trim at all. JavaScript's `$` does not -- it matches
    // only at the very end of the string. So on Workers trim() is load-bearing
    // rather than tidying, and removing it would drop the GitHub link for
    // every tag set from a shell variable. The two-line tags below pin the JS
    // half of that from the only side a test can reach: a newline that is not
    // trailing is out of trim()'s reach, and the pattern carries no /m, so
    // neither line is a SHA.
    for (const tag of [
      "9b11b27-dirty",
      "commit 9b11b27",
      "v9b11b27",
      "9b11 b27",
      " 9b11b27 x",
      "9b11b27\nfeedbee",
      "9b11b27\n9b11b27\n",
    ]) {
      const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag } });
      expect(identity.commit).toBeNull();
    }
    // ...and hex means hex: "g" is not a hex digit, so this is a plain tag.
    expect((await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: "9g11b27" } })).commit).toBeNull();
  });

  it("counts ASCII hex only, so a unicode look-alike is a plain tag", async () => {
    // [0-9a-f] is an ASCII range and the pattern has no /u flag, so digits
    // that are digits to a reader but not to the regex -- Bengali, full-width
    // -- fall to the plain-tag branch and no GitHub link is invented for
    // them. The accented tag is the same check from the other side: "café123"
    // is seven characters and looks hex-ish at a glance.
    //
    // The zero-width space is the interesting one: trim() does not strip it
    // (it is a format character, not whitespace), so an otherwise perfect SHA
    // that picked one up from a copy-paste is rejected -- which is the safe
    // direction, a missing link rather than a broken one.
    //
    // Written as \u escapes and never as the characters themselves: three of
    // these five are invisible or near-invisible in an editor, which is the
    // entire reason they are a hazard worth testing -- and a literal one is a
    // character a formatter or a careless paste can silently change out from
    // under the assertion, which would quietly stop testing anything.
    const tags = [
      "\u09e7b11b27", // Bengali digit one, where a reader sees a 1
      "9b11b2\uff10", // full-width digit zero, where a reader sees a 0
      "caf\u00e9123", // precomposed e-acute in seven hex-looking characters
      // ...and the decomposed form of the same word, which renders
      // identically: EIGHT code units, of which c, a, f, e, 1, 2 and 3 really
      // are hex digits. SHA_PATTERN counts code units and not graphemes, so
      // the combining accent alone is what rejects it -- and it is also why
      // adding /u to the pattern would not help.
      "cafe\u0301123",
      "9b11b27\u200b", // a perfect SHA with a zero-width space stuck to it
    ];
    for (const tag of tags) {
      const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag } });
      expect(identity.commit).toBeNull();
      expect(identity.version).toBe(tag);
    }
  });

  it("trims unicode whitespace, not merely the ASCII kind", async () => {
    // trim() is defined over Unicode's WhiteSpace production -- every Zs, plus
    // U+FEFF -- and not over " \t\n". Replacing it with a hand-rolled
    // /^[ \t\n]+|[ \t\n]+$/, an easy "drop the String.prototype dependency"
    // refactor, would stop recognising these as SHAs and silently drop the
    // GitHub link for the entire life of that deploy.
    //
    // Written as \u escapes rather than as the characters themselves, which
    // matters more here than anywhere else in this file: pasted literally,
    // all three are indistinguishable from an ordinary space on screen, and an
    // editor or formatter that "tidied" one into a plain space would leave
    // this test passing while testing nothing -- an ASCII space is trimmed by
    // either implementation. Ordinary spaces are therefore a DIFFERENT
    // assertion, covered on purpose by "trims whitespace around a tag" below.
    //   \u00a0 non-breaking space -- a tag pasted out of a wiki or a spreadsheet
    //   \u2003 em space           -- a tag pasted out of prose
    //   \ufeff byte-order mark    -- a tag read from a UTF-8-with-signature file
    for (const tag of ["\u00a09b11b27", "9b11b27\u2003", "\ufeff9b11b27\u00a0"]) {
      const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag } });
      expect(identity).toMatchObject({ version: "9b11b27", commit: "9b11b27" });
    }
  });

  it("puts no upper bound on a plain tag's length", async () => {
    // Django's SOURCE_COMMIT[:7] could not produce a long version string; the
    // plain-tag branch here has no slice at all, so whatever the deploy set
    // is rendered whole into the "Using code" line. 10,000 characters is not
    // realistic -- the point is that nothing truncates or rejects, so the
    // divergence from Django is unbounded rather than "a bit longer".
    const huge = "beta-".repeat(2000);
    const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: huge } });
    expect(identity.version).toHaveLength(10_000);
    expect(identity.version).toBe(huge);
    expect(identity.commit).toBeNull();

    // A long all-hex tag is the same story and is worth its own case: the
    // {7,40} bound rejects it, so nothing gets sliced into a seven-character
    // link out of a 4,000-character string, and the anchored pattern fails
    // fast rather than backtracking over it.
    const longHex = "f".repeat(4000);
    const hexIdentity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: longHex } });
    expect(hexIdentity.commit).toBeNull();
    expect(hexIdentity.version).toBe(longHex);
  });

  it("treats an all-digit tag as a SHA, because digits are hex digits", async () => {
    // Documents current behaviour rather than endorsing it; reported as a
    // suspected bug alongside this test. The decimal digits are a subset of
    // the hex alphabet, so a CI-style build number or a date stamp of 7-40
    // digits satisfies SHA_PATTERN and gets a GitHub commit link built from
    // its first seven characters -- the 404 the SHA check exists to avoid.
    // Nothing sets a tag today, so nothing renders it; left as-is because
    // "fix" here means choosing a policy (require >= 8 chars? require at
    // least one a-f?) that only a maintainer can pick.
    const buildNumber = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: "20260905" } });
    expect(buildNumber.commit).toBe("2026090");
    expect(buildNumber.version).toBe("2026090");
  });

  it("accepts an uppercase SHA and keeps its case", async () => {
    // SHA_PATTERN carries /i. git and GitHub both resolve an uppercase SHA,
    // so this is accepted rather than rejected -- and it is not lowercased on
    // the way through, which is pinned here so the behaviour is a decision
    // rather than an accident of the next person's refactor.
    const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: "9B11B27AD4F8E1C05A7E2D9F3B6C8A1E4D7F0B23" } });
    expect(identity.version).toBe("9B11B27");
    expect(identity.commit).toBe("9B11B27");
  });

  it("shows a non-SHA tag verbatim, where Django truncated to seven", async () => {
    // A documented divergence, worth naming: context_processors.py did
    // SOURCE_COMMIT[:7] unconditionally, so `version` was never longer than
    // seven characters. Here only the SHA and version-id branches truncate --
    // a human-readable tag renders whole, which is the useful thing to do
    // with "beta-2026-09-05" but does mean the field is no longer fixed width.
    const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: "beta-2026-09-05" } });
    expect(identity.version).toBe("beta-2026-09-05");
    expect(identity.commit).toBeNull();
  });

  it("trims whitespace around a tag before deciding what it is", async () => {
    // A tag set from a shell variable arrives with a trailing newline more
    // often than anyone expects; untrimmed, the anchored pattern would reject
    // a perfectly good SHA and the GitHub link would silently disappear.
    const identity = await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: "  9b11b27ad4f8e1c05a7e2d9f3b6c8a1e4d7f0b23\n" } });
    expect(identity.commit).toBe("9b11b27");
    // The trim applies to the plain-tag branch as well, so no stray padding
    // reaches the rendered page.
    expect((await firstRequest({ metadata: { id: "3f8a1c2e-9d4b", tag: "  beta  " } })).version).toBe("beta");
  });

  it("falls back to the version id for an empty or whitespace-only tag", async () => {
    // Untagged deploys are the norm and wrangler supplies "" rather than
    // omitting the field. A whitespace-only tag must behave the same way,
    // otherwise the "Using code" line would render as blank space.
    for (const tag of ["", "   ", "\n", "\t "]) {
      expect((await firstRequest({ metadata: { id: "3f8a1c2e-9d4b-4c7a", tag } })).version).toBe("3f8a1c2e");
    }
  });

  it("says 'unknown' when there is no usable version metadata at all", async () => {
    // Every one of these is reachable: no binding on an older deploy, an
    // empty object in a test, an id that never got filled in. None of them
    // may throw -- this middleware sits above all routing, so a throw here is
    // a 500 on the whole site rather than a wrong debug comment.
    // `null` earns its place separately from `undefined`: `meta?.tag` is what
    // makes it survivable, and the two obvious "tidier" rewrites -- a
    // destructure with defaults, or a `"tag" in meta` guard -- both throw on a
    // present-but-null binding while passing every other case in this list.
    const shapes = [undefined, null, {}, { tag: "" }, { id: "" }, { id: undefined, tag: undefined }];
    for (const metadata of shapes as VersionMetadata[]) {
      const identity = await firstRequest({ metadata });
      expect(identity.version).toBe("unknown");
      expect(identity.commit).toBeNull();
      // ...and the request itself still succeeded.
      expect(identity.instance_id).toMatch(/^[0-9a-f]{7}$/);
    }
  });

  it("survives the binding being absent from env, not merely undefined", async () => {
    // Distinct from `{ CF_VERSION_METADATA: undefined }` above, and the reason
    // ServeOptions has a `bindingAbsent` flag at all: this is an `env` with no
    // such property. That is what a Worker deployed before wrangler.jsonc
    // declared `version_metadata` has (workers/site/wrangler.jsonc:200), and
    // what a preview or a `wrangler dev` run against an older config hands
    // over. `meta?.` reads both shapes the same way; anything stricter throws,
    // and this middleware is mounted with app.use("*") above all routing
    // (index.ts:115), so a throw here is a 500 on every page rather than a
    // wrong debug comment on one.
    const isolate = await bootIsolate();
    const res = await isolate.serve({ cf: { colo: "LHR" }, bindingAbsent: true });

    expect(res.status).toBe(200);
    expect(isolate.identity()).toEqual({
      colo: "LHR",
      instance_id: expect.stringMatching(/^[0-9a-f]{7}$/),
      version: "unknown",
      commit: null,
    });
  });

  it("500s every page in the isolate, not just one, when the tag is not a string", async () => {
    // Malformed input at the binding boundary. `meta?.tag?.trim()` is an
    // unchecked method call on a value TypeScript only BELIEVES is a string:
    // CF_VERSION_METADATA's type comes from the generated
    // worker-configuration.d.ts, which describes the binding rather than
    // validating it, and nothing in readVersion narrows it.
    //
    // Pinned as current behaviour and reported as a suspected bug rather than
    // fixed, because the failure mode is much worse than a wrong debug
    // comment: the throw happens BEFORE `identity` is assigned, so the
    // module-scope cache stays null and the next request through this isolate
    // takes the identical path. One malformed binding is therefore a permanent
    // 500 on every page the isolate ever serves -- the second assertion below
    // is the one that says so, and it is the reason this is worth a test at
    // all rather than a shrug about an impossible input.
    vi.resetModules();
    const { runtimeIdentity } = await import("./runtimeIdentity");
    const { buildPageContext } = await import("@givefood/templates");
    const app = new Hono<AppEnv>();
    app.use("*", runtimeIdentity);
    app.get("*", (c) => c.text("the page body"));
    app.onError((err, c) => c.text(`caught: ${err.message}`, 500));

    const env = { CF_VERSION_METADATA: { id: "3f8a1c2e-9d4b", tag: 20260905 } } as unknown as AppEnv["Bindings"];
    const first = await app.fetch(new Request("https://www.givefood.org.uk/"), env, execCtx);
    expect(first.status).toBe(500);
    expect(await first.text()).toMatch(/trim is not a function/);

    const second = await app.fetch(new Request("https://www.givefood.org.uk/"), env, execCtx);
    expect(second.status).toBe(500);
    // Nothing was ever published, so a page rendered in this isolate still
    // reports the pre-request default rather than a half-built identity.
    expect(buildPageContext({ path: "/" })).toMatchObject({ colo: "unknown", instance_id: "unknown", version: "unknown" });
  });

  it("uses a short version id whole rather than padding it", async () => {
    // slice(0, 8) on a shorter string is the whole string. Nothing produces
    // an id this short today; pinned so the fallback stays "show what we
    // have" rather than becoming an exception or an "unknown".
    expect((await firstRequest({ metadata: { id: "abc" } })).version).toBe("abc");
  });
});

describe("runtimeIdentity: once per isolate", () => {
  it("computes the identity on the first request and never again", async () => {
    // The invariant the whole module is built around. The second request here
    // carries a DIFFERENT colo and a different version tag, and both are
    // ignored -- which is correct, not a bug: an isolate lives in exactly one
    // colo and runs exactly one Worker version, so the first request's answer
    // is the isolate's answer. (A deploy starts new isolates rather than
    // swapping code under a running one.)
    const isolate = await bootIsolate();
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");

    await isolate.serve({ cf: { colo: "LHR" }, metadata: { id: "3f8a1c2e-9d4b", tag: "" } });
    const first = isolate.identity();

    await isolate.serve({ cf: { colo: "SYD" }, metadata: { id: "ffffffff-0000", tag: "9b11b27" } });
    expect(isolate.identity()).toEqual(first);
    expect(first.colo).toBe("LHR");
    expect(first.version).toBe("3f8a1c2e");

    // A fresh id per request would make the "same isolate?" comparison
    // meaningless, and would be invisible in any test that only looked at the
    // shape of the string. One mint, ever.
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("keeps serving requests normally once the identity is cached", async () => {
    // The cached branch skips straight to next(). If the `if (!identity)`
    // guard ever wrapped the next() call as well, every request after the
    // first in an isolate -- effectively all of them -- would hang or 404.
    const isolate = await bootIsolate();
    for (let i = 0; i < 3; i++) {
      const res = await isolate.serve();
      expect(res.status).toBe(200);
    }
    expect(isolate.handler).toHaveBeenCalledTimes(3);
  });

  it("carries no per-request data, so the cache cannot leak between visitors", async () => {
    // The module comment's own safety argument: everything cached is a
    // property of the isolate, not of the request, so one visitor's page
    // cannot show another's data. Concretely -- a request carrying an IP,
    // country and ray id contributes nothing to the identity but its colo.
    //
    // The random bytes are stubbed so the id is "deadbee" and not a fresh
    // seven hex characters: an unstubbed id has a real (if small, ~1 in
    // 16,000) chance of containing the digits of the ASN below, which would
    // fail this test on some runs and not others.
    const isolate = await bootIsolate();
    stubRandomBytes([0xde, 0xad, 0xbe, 0xef]);
    await isolate.serve({
      cf: { colo: "LHR", country: "GB", city: "Sidmouth", postalCode: "EX10 8LS", asn: 5089 },
    });
    expect(isolate.identity().instance_id).toBe("deadbee");
    expect(isolate.identity().colo).toBe("LHR");

    // The SECOND request is the one the claim is actually about: a leak needs
    // two visitors, so a test that served one could never have observed the
    // thing it was ruling out. A different person, same isolate, reading the
    // cached identity -- none of their data may appear in it, and none of the
    // first visitor's may have been carried forward into what this person's
    // page renders either.
    await isolate.serve({
      cf: { colo: "LHR", country: "FR", city: "Lyon", postalCode: "69001", asn: 3215 },
    });
    expect(isolate.renders).toHaveLength(2);
    expect(isolate.renders[1]).toEqual(isolate.renders[0]);

    const values = Object.values(isolate.identity()).join(" ");
    for (const personal of ["GB", "Sidmouth", "EX10 8LS", "5089", "FR", "Lyon", "69001", "3215"]) {
      expect(values).not.toContain(personal);
    }
    // Only the colo, which is a property of the isolate and not of either of
    // them -- both requests landed in LHR because the isolate is in LHR.
    expect(isolate.renders[1]?.colo).toBe("LHR");
  });

  it("starts over in a genuinely new isolate", async () => {
    // A check on the harness rather than on the module, and the one every
    // other test here silently depends on: vi.resetModules() has to hand back
    // BOTH an un-minted runtimeIdentity.ts and a fresh copy of context.ts.
    //
    // If it did not, the first test in the file would fix the identity for
    // the whole run and every later assertion would be reading a stale value
    // that happened to match -- and the file's very first assertion ("nothing
    // has run yet") could not tell the difference, because it runs first
    // either way. Asserting it here, after twenty-odd isolates have already
    // minted identities, is what makes it mean something.
    const first = await bootIsolate();
    await first.serve({ cf: { colo: "MAN" }, metadata: { id: "11111111-aaaa", tag: "" } });
    expect(first.identity()).toMatchObject({ colo: "MAN", version: "11111111" });

    const second = await bootIsolate();
    expect(second.identity()).toEqual({ colo: "unknown", instance_id: "unknown", version: "unknown", commit: null });
    await second.serve({ cf: { colo: "SYD" }, metadata: { id: "22222222-bbbb", tag: "" } });
    expect(second.identity()).toMatchObject({ colo: "SYD", version: "22222222" });
    expect(second.identity().instance_id).not.toBe(first.identity().instance_id);

    // ...and the two generations really are separate module copies: the older
    // isolate's reader still reports the older isolate's identity, so no test
    // above can be reading a later test's value.
    expect(first.identity()).toMatchObject({ colo: "MAN", version: "11111111" });
  });
});
