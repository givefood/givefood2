import { Hono } from "hono";
import type { AppEnv } from "./types";
import { serverTiming } from "./middleware/serverTiming";
import { slugRedirect } from "./middleware/slugRedirect";
import { resolveLanguage } from "./middleware/resolveLanguage";
import { geoJsonPreload } from "./middleware/geoJsonPreload";
import { mediaApp } from "./routes/media";
import { staticMediaApp } from "./routes/staticMedia";
import { dumpsApp } from "./routes/dumps";
import { notPortedYet } from "./routes/notPortedYet";
import { render404 } from "./render404";

// PLAN.md §3.5 "Request lifecycle". Hono's onion middleware model maps 1:1
// onto Django's MIDDLEWARE list, in the same order -- see the table in that
// section for which Django middleware became which piece here, and which
// were deleted outright (GZipMiddleware -> Cloudflare edge, automatic;
// OfflineKeyCheck -> /offline/ ceases to be an HTTP surface;
// RedirectToWWW -> a zone Redirect Rule).
const app = new Hono<AppEnv>();

app.use("*", serverTiming); // was RenderTime
app.use("*", slugRedirect); // was SlugRedirectMiddleware
app.use("*", resolveLanguage); // was LocaleMiddleware + i18n_patterns
app.use("*", geoJsonPreload); // was GeoJSONPreload (runs after routing)

// Media routes are registered at givefood/urls.py:14 -> gfwfbn/urls/generic.py,
// OUTSIDE i18n_patterns -- one URL each, never language-prefixed. This is
// the one route group fully built out in this pass; see PLAN.md §3.7.
app.route("/needs", mediaApp);

// img/ar/** and img/appscreenshots/** -- everything else under /static/* is
// served by Workers Static Assets (asset-first, never reaches this Worker);
// only these two excluded families fall through to here. See PLAN.md WP 1.6.
app.route("/static", staticMediaApp);

// The two download URL shapes redirect to dumps.givefood.org.uk (R2 custom
// domain, no Worker in that request path). See PLAN.md WP 1.4/1.5.
app.route("/dumps", dumpsApp);

// Everything below is specified in PLAN.md but not yet built. Each returns
// 501 so the gap is loud during development. Build order follows PLAN.md
// §10's phases: wfbn (translated pages) and the APIs next, admin last.
app.route("/needs", notPortedYet("gfwfbn (translated pages)"));
app.route("/api", notPortedYet("gfapi1/2/3"));
app.route("/dashboard", notPortedYet("gfdash"));
app.route("/write", notPortedYet("gfwrite"));
// The three listing pages (dump_index, dump_type, dump_format) -- unmatched
// by dumpsApp above, so they fall through to here.
app.route("/dumps", notPortedYet("gfdumps listing pages"));
app.route("/auth", notPortedYet("gfauth (Google OAuth)"));
app.route("/admin", notPortedYet("gfadmin"));
app.route("/", notPortedYet("public site"));

// PLAN.md §3.5 "APPEND_SLASH". No platform equivalent -- Workers Static
// Assets' force-trailing-slash only affects ASSET lookups, not the 3,000+
// food bank URLs that actually need this. Reproduce Django's real behaviour
// (a 301 to the slashed URL, not serving content in place) with a bounded
// re-dispatch, restricted to GET/HEAD to avoid re-running a mutating request.
app.notFound(async (c) => {
  const url = new URL(c.req.url);
  const method = c.req.method;

  if ((method === "GET" || method === "HEAD") && !url.pathname.endsWith("/")) {
    const slashed = new URL(url.toString());
    slashed.pathname += "/";
    const probe = await app.fetch(new Request(slashed, { method: "HEAD" }), c.env, c.executionCtx);
    if (probe.status !== 404 && probe.status !== 501) {
      return c.redirect(slashed.toString(), 301); // Django's APPEND_SLASH is a 301
    }
  }

  return c.html(await render404(c), 404);
});

export default app;
