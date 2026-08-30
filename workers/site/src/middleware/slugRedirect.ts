import type { MiddlewareHandler } from "hono";
import type { Env } from "../../worker-configuration";
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
// The 57-row map lives in DATA KV as one JSON value, memoised in module
// scope for 300s. D1 remains the editable source of truth; the ingest path
// that writes SlugRedirect rows is responsible for refreshing the KV copy.

const KV_KEY = "slug_redirects";
const MEMO_TTL_MS = 300_000;

let memo: { at: number; map: Record<string, string> } | null = null;

async function getSlugRedirects(env: Env): Promise<Record<string, string>> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.map;

  const raw = await env.DATA.get(KV_KEY, "json");
  const map = (raw as Record<string, string> | null) ?? {};
  memo = { at: Date.now(), map };
  return map;
}

const PREFIX_PATTERN = [...PREFIXES].join("|");
// e.g. ^(/(pl|cy|bn|...|tlh))?/needs/at/([-\w]+)(/[-\w]+)?/?$
const SLUG_PATTERN = new RegExp(`^(/(?:${PREFIX_PATTERN}))?/needs/at/([-\\w]+)(/[-\\w]+)?/?$`);

export const slugRedirect: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  const match = url.pathname.match(SLUG_PATTERN);

  if (match) {
    const [, langPrefix = "", oldSlug, subpath] = match;
    const redirects = await getSlugRedirects(c.env);
    const newSlug = oldSlug ? redirects[oldSlug] : undefined;

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
