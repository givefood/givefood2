import type { Context } from "hono";
import { getFoodbankBySlug } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// TYPE-ONLY. `typeof import(...)` is a type expression, erased by tsc, so it
// leaves the deferred import inside screenshot() as the module's only runtime
// reference to puppeteer. Spelled out rather than imported by name because
// the package's public types entry does not re-export `Browser`.
type PuppeteerBrowser = Awaited<
  ReturnType<(typeof import("@cloudflare/puppeteer"))["default"]["launch"]>
>;

// gfwfbn `foodbank_screenshot` (gfwfbn/views.py:528-554), registered at
// gfwfbn/urls/generic.py:14 with the five page names spelled out in the URL
// pattern itself.
//
// LIVE, NOT BACKFILLED. This used to be mounted on routes/media.ts, which
// reads R2 and enqueues a media-backfill on a miss -- and that consumer
// threw "not implemented" for every screenshot key, so the route had never
// returned an image. Moved here 2026-09-05 because Django does not persist
// screenshots either: get_screenshot() (givefood/utils/general.py:27-58)
// calls Browser Rendering on every @cache_page(SECONDS_IN_WEEK) miss and
// returns the bytes inline, with nothing written anywhere.
//
// Same shape as wfbn/favicon.ts, for the same reason: fetch on a cache
// miss, cache the response with the Workers Cache API, so the first request
// for a given food bank gets a real image rather than a 404 that clears up
// only once an async job eventually runs. The R2 media system exists to
// keep billed third-party calls out of the request path; that argument is
// about calls made repeatedly, and a week-cached screenshot is made once.
//
// USES THE BROWSER BINDING, not Django's REST call to
// /accounts/<id>/browser-rendering/screenshot. Same service, but the
// binding needs no CF_ACCOUNT_ID and no browser API key -- two fewer
// secrets on the site Worker. workers/jobs made the same move for
// needcheck's markdown scrape.
//
// A SCREENSHOT IS SLOW: a cold browser plus a networkidle0 page load is
// seconds, not milliseconds, and Browser Rendering limits how many browsers
// an account may run at once. Django accepts exactly this (its own timeout
// is 45 seconds) because the week-long cache means one visitor per food
// bank per week pays it. If that ever stops being acceptable, the fix is to
// pre-render into R2 from the jobs Worker -- not to make the request path
// wait longer.

// views.py:534-544's if-chain, as data. The URL pattern already restricts
// page_name to these five, so an unknown key cannot reach here from the
// router -- the lookup is still explicit so that adding a sixth means
// touching one list rather than discovering the omission in production.
const PAGE_FIELDS: Record<string, "url" | "shopping_list_url" | "donation_points_url" | "contacts_url" | "locations_url"> = {
  homepage: "url",
  shoppinglist: "shopping_list_url",
  donationpoints: "donation_points_url",
  contacts: "contacts_url",
  locations: "locations_url",
};

// get_screenshot(url, width=1280, height=1280) -- general.py:27, and the
// gotoOptions/addStyleTag it posts.
const VIEWPORT = { width: 1280, height: 1280 };
const GOTO_TIMEOUT_MS = 45_000;
const HIDE_CCC_STYLE = "#ccc {display:none};"; // verbatim from general.py:50, typo and all
const CACHE_CONTROL_WEEK = "public, max-age=604800"; // @cache_page(SECONDS_IN_WEEK)

async function screenshot(c: Context<AppEnv>, targetUrl: string): Promise<Uint8Array | null> {
  let browser: PuppeteerBrowser | null = null;
  try {
    // DEFERRED ON PURPOSE. @cloudflare/puppeteer is 453 KiB of the site
    // Worker's 3.2 MiB bundle and this route is its only importer -- one URL
    // out of everything the Worker serves. A static import evaluates the whole
    // puppeteer module graph (rxjs, the device-descriptor table, the US
    // keyboard layout) at startup, on every cold start, for every request
    // path. esbuild keeps a dynamically-imported module in the same bundle but
    // behind a lazy initialiser, so the bytes still ship -- what moves is the
    // evaluation, which now happens only when a screenshot is actually asked
    // for. Bundle size is not the constraint (the limit is 64 MiB and we use
    // 5%); the 400 ms startup-time limit is.
    //
    // Inside the try because a failed import should 404 like a failed launch.
    const { default: puppeteer } = await import("@cloudflare/puppeteer");
    browser = await puppeteer.launch(c.env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: GOTO_TIMEOUT_MS });
    await page.addStyleTag({ content: HIDE_CCC_STYLE });
    // puppeteer types this as a node Buffer; on Workers it is a Uint8Array,
    // which is what Response accepts.
    return (await page.screenshot({ type: "png" })) as unknown as Uint8Array;
  } catch (err) {
    // views.py:551-554 returns 404 when get_screenshot() is falsy, and
    // general.py:55-56 returns False on any non-200. A food bank whose site
    // is down, slow or hostile to a headless browser is the common case,
    // not an exception, so it is logged and 404'd rather than 500'd.
    console.error(`screenshot: failed for ${targetUrl}`, err);
    return null;
  } finally {
    // Sessions are a limited per-account resource; leaking one on an error
    // path starves every later request until it times out on its own.
    if (browser) await browser.close().catch(() => {});
  }
}

export async function wfbnFoodbankScreenshot(c: Context<AppEnv>): Promise<Response> {
  // The route param carries the ".png" -- see index.ts on why the whole
  // segment has to be the param.
  const field = PAGE_FIELDS[c.req.param("page")!.replace(/\.png$/, "")];
  if (!field) return c.notFound();

  const foodbank = await getFoodbankBySlug(dbSession(c), c.req.param("slug")!);
  if (!foodbank) return c.notFound();

  // views.py:546-547 `if not url: return HttpResponseNotFound()` -- most
  // food banks have no shopping_list_url or contacts_url, so this is the
  // ordinary answer for four of the five pages, not an error.
  const targetUrl = foodbank[field];
  if (!targetUrl) return c.notFound();

  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) return cached;

  const png = await screenshot(c, targetUrl);
  if (!png) return c.notFound(); // NOT cached: a site that is down today may work tomorrow

  const response = new Response(png, {
    headers: { "Content-Type": "image/png", "Cache-Control": CACHE_CONTROL_WEEK },
  });
  c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()));
  return response;
}
