import type { Context } from "hono";
import { FRAG_KV_KEY_LAST_UPDATED, FRAG_KV_KEY_NEED_HITS, getFeaturedArticles, getLastModifiedFoodbank, getRecentHitsTotal } from "@givefood/db";
import { intcomma, loadCatalogue, render, type Locale } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { isoDate, mapArticleRow } from "@givefood/models";
import { timesinceAgo } from "../../lib/timesince";

// givefood/views.py:1028-1071 frag() -- givefood/urls.py:27, inside
// i18n_patterns (frag.njk-equivalent content needs the requesting page's
// locale, both for translate()'s catalogue and for news's foodbank
// links). The 4-value whitelist is enforced by the route's own path
// constraint (index.ts registers this at
// /frag/:frag{ip-address|last-updated|need-hits|news}/), which 404s any
// other value the same way Django's `if frag not in allowed_frags: raise
// Http404()` does -- no separate check needed here.
//
// last-updated/need-hits: PLAN.md's whole point for this work package is
// "zero database work per request" via a KV cache refreshed by a 5-minute
// cron (workers/jobs/src/scheduled/index.ts's fragRefresh). The KV read
// is the fast path; a miss (cold start, before the first cron tick) falls
// back to computing it live -- same query the cron itself runs -- and
// writes the result back to KV so the NEXT request is fast too, rather
// than serving a 403 site-wide for up to 5 minutes after every fresh
// deploy. KV itself failing (get OR put) is treated the same as a miss --
// fall through to a live answer -- rather than failing the whole request
// over a cache that's explicitly a "should be fast," not "must be
// present," optimisation.

// FIVE MINUTES, matching the cron that refreshes the KV key behind it
// (workers/jobs/src/scheduled/index.ts, "*/5 * * * *"). Django had no
// @cache_page on this view at all, so an explicit short TTL is already
// more caching than the original; the number that matters is that it is
// not pageCacheControl's 24-hour default, which would have made a value
// deliberately recomputed every five minutes up to 288 refreshes stale.
const FRAG_TTL = "public, max-age=300";

const SEVEN_DAYS_SECONDS = 60 * 60 * 24 * 7;

async function readOrCompute(kv: KVNamespace, key: string, compute: () => Promise<string | null>): Promise<string | null> {
  let cached: string | null = null;
  try {
    cached = await kv.get(key);
  } catch (err) {
    console.error(`frag: KV read of ${key} failed, falling back to a live query`, err);
  }
  if (cached !== null) return cached;

  const computed = await compute();
  if (computed !== null) {
    try {
      await kv.put(key, computed);
    } catch (err) {
      // Non-fatal: the caller still gets a correct, freshly computed
      // answer this request; only the "next request is fast too" benefit
      // is lost until the next cron tick.
      console.error(`frag: KV write of ${key} failed`, err);
    }
  }
  return computed;
}

export async function frag(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("frag")!;
  const locale = c.get("lang") as Locale;

  // ip-address -- returns early in Django too, uncached (per-user), no
  // fallback/403 branch: get_user_ip() can legitimately return "" (a
  // non-Cloudflare-proxied request) and Django just returns that empty
  // body, it never 403s here. X-Forwarded-For/REMOTE_ADDR fallbacks are
  // deliberately NOT ported: Cloudflare always sets CF-Connecting-IP on a
  // proxied request, so there's no equivalent fallback chain to
  // reproduce, and X-Forwarded-For is attacker-suppliable in a way
  // CF-Connecting-IP isn't.
  // PER-VISITOR. THIS RESPONSE MUST NEVER ENTER A SHARED CACHE, and saying
  // so explicitly is not belt-and-braces -- it was a live leak. Django left
  // this uncached by simply having no @cache_page, and this branch inherited
  // that by returning early with only a Content-Type. Then two things filled
  // the silence: the zone Cache Rule gives HTML/text an edge TTL of its own,
  // and middleware/pageCacheControl.ts (added 2026-09-06) counts text/plain
  // as cacheable and stamped `public, max-age=300, s-maxage=86400` on
  // anything that set no Cache-Control of its own.
  //
  // Result, observed on production 2026-09-07: GET /frag/ip-address/ came
  // back `cf-cache-status: HIT, age: 1427` with ANOTHER VISITOR'S IPv6
  // address in the body. A visitor's IP address is personal data, and it was
  // being handed to whoever asked next for up to 24 hours.
  //
  // CDN-Cache-Control as well as Cache-Control, for the same reason /flag/
  // needed it: withholding or privatising Cache-Control does not stop the
  // zone Cache Rule, and only `CDN-Cache-Control: no-store` does.
  if (slug === "ip-address") {
    return new Response(c.req.header("CF-Connecting-IP") ?? "", {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "private, no-store, max-age=0, must-revalidate",
        "CDN-Cache-Control": "no-store",
        Vary: "CF-Connecting-IP",
      },
    });
  }

  const session = dbSession(c);

  if (slug === "last-updated") {
    const modified = await readOrCompute(c.env.DATA, FRAG_KV_KEY_LAST_UPDATED, () => getLastModifiedFoodbank(session));
    if (!modified) return new Response("", { status: 403 });
    const catalogue = await loadCatalogue(locale);
    return new Response(timesinceAgo(modified, new Date(), catalogue), {
      headers: { "Content-Type": "text/plain", "Cache-Control": FRAG_TTL },
    });
  }

  if (slug === "need-hits") {
    const cachedOrComputed = await readOrCompute(c.env.DATA, FRAG_KV_KEY_NEED_HITS, async () => {
      const since = isoDate(new Date(Date.now() - SEVEN_DAYS_SECONDS * 1000));
      const total = await getRecentHitsTotal(session, since);
      return total === null ? null : String(total);
    });
    // Number(...) rather than parseInt: rejects a garbled/partial KV
    // value as NaN (falsy check below) instead of silently truncating it
    // to whatever digits happen to lead the string.
    const total = cachedOrComputed === null ? NaN : Number(cachedOrComputed);
    if (!cachedOrComputed || Number.isNaN(total)) return new Response("", { status: 403 });
    return new Response(intcomma(total), {
      headers: { "Content-Type": "text/plain", "Cache-Control": FRAG_TTL },
    });
  }

  // news -- a raw HTML fragment (public/frags/news.njk, already built and
  // shared with the homepage/news page), not a full page: no
  // buildPageContext()/page.njk involved, csi.js drops the response body
  // straight into an element's innerHTML. show_time is deliberately
  // omitted (undefined -> falsy), matching Django's own frag() never
  // passing it either -- dates render "j M", no time component.
  const articles = (await getFeaturedArticles(session, 5)).map(mapArticleRow);
  const html = await render("public/frags/news.njk", { articles }, locale);
  return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "max-age=3600" } });
}
