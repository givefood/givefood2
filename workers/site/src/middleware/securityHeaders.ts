import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

// django.middleware.security.SecurityMiddleware's two always-on defaults,
// which production sends on every response and this port did not:
//
//   X-Content-Type-Options: nosniff   (SECURE_CONTENT_TYPE_NOSNIFF, default True)
//   Referrer-Policy: same-origin      (SECURE_REFERRER_POLICY, default "same-origin")
//
// Found 2026-09-05 by diffing response headers between beta and
// production. Neither is dramatic on its own, but both are regressions a
// security scanner will flag on launch day, and nosniff in particular is
// what stops a browser executing a user-uploaded file served with a
// permissive content type as script.
//
// ONLY these two. settings.py sets none of the SECURE_* options
// explicitly, XFrameOptionsMiddleware is not in MIDDLEWARE, and
// production sends no HSTS or CSP -- confirmed against live headers, not
// assumed from Django's defaults list. Adding headers Django does not send
// would be a behaviour change, not a port.
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "same-origin");
};
