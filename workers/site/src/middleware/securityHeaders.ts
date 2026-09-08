import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

// django.middleware.security.SecurityMiddleware's three always-on defaults --
// the headers it emits with no SECURE_* setting configured at all, on every
// response, secure or not:
//
//   X-Content-Type-Options: nosniff   (SECURE_CONTENT_TYPE_NOSNIFF, default True)
//   Referrer-Policy: same-origin      (SECURE_REFERRER_POLICY, default "same-origin")
//   Cross-Origin-Opener-Policy: same-origin
//                                     (SECURE_CROSS_ORIGIN_OPENER_POLICY, default "same-origin")
//
// The first two were found 2026-09-05 by diffing response headers between beta
// and production. Neither is dramatic on its own, but both are regressions a
// security scanner will flag on launch day, and nosniff in particular is what
// stops a browser executing a user-uploaded file served with a permissive
// content type as script.
//
// COOP was NOT in that diff, and this comment used to claim SecurityMiddleware
// had "two always-on defaults" -- which is simply false, and is the false
// premise that kept the omission unexamined. Running the real middleware
// against the real settings module prints three headers, not two: django 6.1,
// SECURE_CROSS_ORIGIN_OPENER_POLICY == "same-origin" (never overridden --
// settings.py sets no SECURE_* at all), and SecurityMiddleware is MIDDLEWARE[0]
// so its process_response runs LAST on the way out and nothing downstream can
// strip what it sets. Added 2026-09-08 for parity with that source.
//
// The source is the reference here because the wire is no longer available:
// www.givefood.org.uk has been this Worker since 2026-09-05, and the Django
// origin is decommissioned, so whether pre-cutover production sent COOP on the
// wire is not recoverable. Adding it is safe either way -- COOP: same-origin
// severs window.opener between a document and a CROSS-ORIGIN popup, and this
// site has no such pair. Google sign-in is a full-page redirect, not a popup
// (an <a href="/auth/start/">, a 302 to accounts.google.com from
// lib/adminAuth.ts, and Google's own redirect back to /auth/receiver/). The
// Facebook page box (wfbn/includes/facebook_embed.njk) is an SDK-rendered
// iframe, and COOP governs top-level browsing contexts, not frames; nothing
// calls FB.login or FB.ui, which are the SDK entry points that do use popups.
// And the only window.open calls in anything we ship are two inside the
// vendored echarts bundle: its link/target helper, which assigns
// `n.opener = null` itself, and the saveAsImage fallback, whose about:blank
// popup inherits this document's origin AND its COOP and so is not severed.
// Neither is reachable in any case -- no template configures `link:` or a
// `toolbox`. (Checked by grep over packages/templates/templates and
// workers/site/dist/static, not assumed.)
//
// ONLY these three. settings.py sets none of the SECURE_* options explicitly,
// XFrameOptionsMiddleware is not in MIDDLEWARE, and production sends no HSTS or
// CSP -- confirmed against live headers, not assumed from Django's defaults
// list. Adding headers Django does not send would be a behaviour change, not a
// port.
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "same-origin");
  c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
};
