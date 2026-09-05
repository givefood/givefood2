import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";

// The three simplest root-app pages -- no DB queries, no query-string or
// method sensitivity beyond a bare GET -- so @cache_page's value on each
// Django view (SECONDS_IN_WEEK for about_us/bot, SECONDS_IN_DAY for apps;
// see givefood/views.py) has no Workers-side equivalent to port: Cloudflare's
// edge cache sits in front of every response automatically, and none of
// these views vary their output by header/cookie/method the way a manual
// cache-key would need to account for. Grouped in one file rather than
// three, per PLAN.md's "group small handlers together" allowance -- none of
// these is more than a static render call.

// givefood/views.py:594-598 about_us() -- givefood/urls.py:23,
// "about-us/", inside i18n_patterns.
export async function publicAboutUs(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/about_us.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
    },
    locale,
  );
  return c.html(html);
}

// givefood/views.py:1022-1024 apps() -- givefood/urls.py:26, "apps/",
// inside i18n_patterns.
export async function publicApps(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/apps.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
    },
    locale,
  );
  return c.html(html);
}

// givefood/const/general.py:210 -- the crawler's literal User-Agent
// string. Also embedded (via BOT_USER_AGENT) in the request headers every
// GiveFoodBot crawl request actually sends, which is how a food bank's own
// admin allowlists it: the /bot/ page's job is to document, verbatim, the
// same string the crawler already presents on the wire, not to invent a
// fresh one.
const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

// givefood/views.py:1012-1019 bot() -- givefood/urls.py:25, "bot/", inside
// i18n_patterns.
export async function publicBot(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/bot.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      BOT_USER_AGENT,
    },
    locale,
  );
  return c.html(html);
}
