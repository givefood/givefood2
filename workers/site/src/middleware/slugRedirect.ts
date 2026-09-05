import type { MiddlewareHandler } from "hono";
import { getSlugRedirectMap } from "@givefood/db";
import type { AppEnv } from "../types";
import { PREFIXES } from "./resolveLanguage";

// PLAN.md §3.5 "Slug redirects — and the bug we must decide on".
//
// givefood/middleware.py:171 used r'^(/[a-z]{2})?/needs/at/([-\w]+)(/[-\w]+)?/?$'.
// [a-z]{2} cannot match "zh-hans" or "tlh", so renamed food banks silently
// fail to redirect in exactly those two languages today. This is a
// deliberate fix, matching against the known prefix set instead -- recorded
// here as a behaviour change, not a silent divergence.
//
// READS D1 DIRECTLY. There used to be a JSON blob of the whole map in
// DATA KV, written by a lib/slugRedirectKv.ts on every admin save, with a
// resync button in the admin for when the two drifted. That bought
// nothing the memo below does not already buy, and cost a second source
// of truth that could silently disagree with the table -- which it did:
// the 57 rows loaded on 2026-09-05 all 404'd until someone pressed the
// button, because loading the table is not the same as writing the blob.
// Removed 2026-09-05, maintainer decision.
//
// The lookup is NOT on every request despite the "*" mount: it runs only
// when the path matches SLUG_PATTERN below (a /needs/at/ URL), and only
// once per warm isolate per MEMO_TTL_MS. So a D1 read here costs one
// query per isolate per 5 minutes, not one per request -- the same shape
// the KV read had, one fewer moving part.
//
// Propagation after an admin save is now ~5 minutes worst case (this memo
// alone) rather than the old ~5-6 (KV global convergence, then a 60s
// per-colo cacheTtl, then this memo). Still far better than the Django
// behaviour being replaced: givefood/utils/cache.py:12-32 caches the same
// dict for 3600s with nothing invalidating it on save, so a redirect
// added in the admin there takes up to an hour unless someone remembers
// /admin/clearcache/.
//
// Do NOT shorten MEMO_TTL_MS to make saves appear faster: it would put a
// D1 query on the hot path of the site's highest-traffic page family.

const MEMO_TTL_MS = 300_000;

let memo: { at: number; map: Record<string, string> } | null = null;

const PREFIX_PATTERN = [...PREFIXES].join("|");
// e.g. ^(/(pl|cy|bn|...|tlh))?/needs/at/([-\w]+)(/[-\w]+)?/?$
const SLUG_PATTERN = new RegExp(`^(/(?:${PREFIX_PATTERN}))?/needs/at/([-\\w]+)(/[-\\w]+)?/?$`);

export const slugRedirect: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  const match = url.pathname.match(SLUG_PATTERN);

  if (match) {
    const [, langPrefix = "", oldSlug, subpath] = match;

    let map: Record<string, string>;
    if (memo && Date.now() - memo.at < MEMO_TTL_MS) {
      map = memo.map;
    } else {
      // A failed read must not take the page down with it: an empty map
      // means "no redirect", so the request falls through to whatever the
      // slug resolves to normally. Not memoised on failure, so the next
      // request through this isolate retries rather than serving an empty
      // map for the full 5 minutes.
      try {
        map = await getSlugRedirectMap(c.env.DB.withSession("first-unconstrained"));
        memo = { at: Date.now(), map };
      } catch (err) {
        console.error("slugRedirect: D1 read failed, continuing without redirects", err);
        map = {};
      }
    }

    const newSlug = oldSlug ? map[oldSlug] : undefined;

    if (newSlug) {
      const subpage = subpath ? subpath.replace(/^\/|\/$/g, "") : null;
      const newPath = subpage
        ? `${langPrefix}/needs/at/${newSlug}/${subpage}/`
        : `${langPrefix}/needs/at/${newSlug}/`;
      return c.redirect(newPath, 301);
    }
  }

  await next();
};
