import type { MiddlewareHandler } from "hono";
import { LOCALES } from "@givefood/templates";
import type { AppEnv } from "../types";

// PLAN.md §3.5 "Language resolution — reproduce exactly, do not improve".
// Verified live against production. There are exactly two rules:
//   1. The URL path prefix wins, and is the only thing that ever wins.
//   2. No prefix => hard-coded "en". Session, cookie and Accept-Language are
//      all computed by Django and then discarded.
// Do not add content negotiation: it would fragment the edge cache,
// directly undermining the caching strategy goal 1 depends on.
//
// PLAN.md §2.7.1 (revised 2026-08-30): this Worker serves 4 languages, not
// Django's 21 -- en (implicit, no prefix) plus cy/ga/gd. A request for any
// of the other 17 (`/pl/...`, `/de/...`, `/zh-hans/...`, etc.) has no
// matching prefix here, so it falls through to the same "no prefix ⇒ en"
// path production's own `/de/` (an unconfigured language) already takes --
// not a new code path, just a larger set of inputs landing on the existing
// one.
//
// Derived from @givefood/templates' LOCALES, not a second hardcoded list --
// that's the single place the 4-language decision lives; adding a 5th
// language means editing i18n.ts's LOCALES and having every consumer
// (this router, slugRedirect.ts's regex, the .po-driven catalogues) pick
// it up, not remembering to update N independent copies.
export const PREFIXES: ReadonlySet<string> = new Set(LOCALES.filter((locale) => locale !== "en")); // "en" is NOT here, and /en/ must 404 (it 404s today)

export const resolveLanguage: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  const first = url.pathname.split("/")[1] ?? "";
  const prefixed = PREFIXES.has(first);

  c.set("lang", prefixed ? first : "en");
  c.set("pathAfterPrefix", prefixed ? url.pathname.slice(first.length + 1) : url.pathname);

  await next();

  // Reproduce Django's header contract -- with one deliberate, measured
  // divergence, spelled out below because it replaces a line that carried its
  // own justification.
  c.header("Content-Language", c.get("lang"));

  // NO `Vary: Accept-Language`, EVER. Removed 2026-09-07 (issue #39).
  //
  // Django patches that header on whenever get_language_from_request() ran --
  // i.e. whenever the first path segment was neither a registered prefix nor
  // "en", because get_language_from_path('/en/') recognises "en" as a real
  // LANGUAGES entry that merely never gets a URL prefix
  // (prefix_default_language=False). That is why /en/ and /de/ 404 with
  // identical bodies and identical Content-Language yet different Vary
  // headers in production, and this middleware used to reproduce it:
  //   if (!prefixed && first !== "en") c.header("Vary", "Accept-Language", { append: true });
  //
  // IT IS SAFE TO DROP. Rules 1 and 2 at the top of this file mean the
  // response is a pure function of the URL path: Accept-Language is computed
  // by nothing here and read by nothing downstream, so one URL has exactly
  // one representation. Verified against production 2026-09-07 -- md5-identical
  // /needs/geo.json for `en-GB`, `cy` and `zz-ZZ`, and a foodbank page
  // differing only in the debug comment's render timer.
  //
  // IT WAS EXPENSIVE TO KEEP. The zone honours Vary, so each distinct
  // Accept-Language string minted its own edge object for identical bytes:
  // on the live /needs/geo.json at LHR, `en-GB,en-US;q=0.9,en;q=0.8` HIT with
  // age=814 while `en-US,en;q=0.9` MISSed seconds later at the same colo --
  // two 2,037,055-byte copies of one JSON document. A miss there is ~963ms
  // TTFB against ~40ms for a hit, plus a full-table D1 read and a 2 MB
  // JSON.stringify. And it fired on essentially the whole public site: the
  // first segment of every unprefixed URL ("needs", "api", "frag", "static")
  // is neither a prefix nor "en", so HTML, the JSON APIs and the resized
  // photos all carried it. The top-of-file rule "do not add content
  // negotiation: it would fragment the edge cache" was being broken by the
  // header that documented the rule.
  //
  // A knock-on worth knowing: media.ts's `h.set("vary", "accept-encoding")`
  // -- and the long comment justifying it -- was defeated from this end,
  // producing `vary: accept-encoding, Accept-Language` on every photo. That
  // fix now stands as written.
  //
  // The cost is Django parity on one documented header, not on any behaviour:
  // the /en/-vs-/de/ split in PLAN.md §6.1.2's table is gone, along with the
  // /cy-gb/ and /en-gb/ rows that already recorded divergences in the same
  // column. Content-Language is untouched. Record this as a deliberate
  // divergence, in the same class as pageCacheControl.ts's BROWSER_MAX_AGE.
  //
  // AND STILL: DO NOT ADD Accept-Language NEGOTIATION. The rule is stated at
  // the top of this file, in resolveLanguage.test.ts and in PLAN.md §3.5, and
  // it is restated *here* because this line was its last automatic safety
  // net. The edge has now been told these responses do not depend on
  // Accept-Language; a middleware that started reading it would have one
  // visitor's language served to everyone from cache. Negotiation and this
  // header come back together or not at all.
};
