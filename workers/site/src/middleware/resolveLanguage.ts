import type { MiddlewareHandler } from "hono";
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
export const PREFIXES = new Set(["cy", "ga", "gd"]); // "en" is NOT here, and /en/ must 404 (it 404s today)

export const resolveLanguage: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  const first = url.pathname.split("/")[1] ?? "";
  const prefixed = PREFIXES.has(first);
  // "en" is a real language this app knows about, just never a registered
  // prefix (prefix_default_language=False) -- get_language_from_path('/en/')
  // still finds it, so Django's LocaleMiddleware never falls through to
  // get_language_from_request() (the Accept-Language-checking function) for
  // this case, unlike a genuinely unrecognised first segment. That's the
  // entire reason /en/ and /de/ produce different Vary headers below despite
  // an identical 404 -- found by testing this middleware's actual output
  // against PLAN.md's header table, not by reading the code (the comment
  // already said this; the condition below didn't implement it).
  const bareEn = first === "en";

  c.set("lang", prefixed ? first : "en");
  c.set("pathAfterPrefix", prefixed ? url.pathname.slice(first.length + 1) : url.pathname);

  await next();

  // Reproduce Django's header contract exactly.
  c.header("Content-Language", c.get("lang"));
  // Vary: Accept-Language appears only when the request's first segment was
  // neither a registered prefix NOR "en" -- i.e. only when Django's
  // language-negotiation function actually ran. /cy/, /ga/, /gd/ and /en/
  // all skip it (prefix, or "en" found directly in the path); /de/, /pl/,
  // and every other unrecognised segment do not.
  if (!prefixed && !bareEn) c.header("Vary", "Accept-Language", { append: true });
};
