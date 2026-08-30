import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

// PLAN.md §3.5 "Language resolution — reproduce exactly, do not improve".
// Verified live against production. There are exactly two rules:
//   1. The URL path prefix wins, and is the only thing that ever wins.
//   2. No prefix => hard-coded "en". Session, cookie and Accept-Language are
//      all computed by Django and then discarded.
// Do not add content negotiation: it would fragment the edge cache 21-fold,
// directly undermining the caching strategy goal 1 depends on.
export const PREFIXES = new Set([
  "pl", "cy", "bn", "ro", "pa", "ur", "ar", "gu", "es", "pt", "gd",
  "ga", "it", "ta", "fr", "lt", "zh-hans", "tr", "bg", "tlh",
]); // 20 -- "en" is NOT here, and /en/ must 404 (it 404s today)

export const resolveLanguage: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  const first = url.pathname.split("/")[1] ?? "";
  const prefixed = PREFIXES.has(first);

  c.set("lang", prefixed ? first : "en");
  c.set("pathAfterPrefix", prefixed ? url.pathname.slice(first.length + 1) : url.pathname);

  await next();

  // Reproduce Django's header contract exactly.
  c.header("Content-Language", c.get("lang"));
  // Vary: Accept-Language appears ONLY when no prefix matched. This is why
  // /de/ (404) carries it and /en/ (404) does not. Cosmetic today, but it is
  // in the wire contract and third parties may read it.
  if (!prefixed) c.header("Vary", "Accept-Language", { append: true });
};
