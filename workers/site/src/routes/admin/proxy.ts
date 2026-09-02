import type { Context } from "hono";
import { getFoodbankBySlug } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// gfadmin/views.py:3326 proxy() -- WP 6.3 (PLAN.md §10.2.7): Django's
// version is an unrestricted SSRF (any `?url=` is fetched server-side with
// no validation at all) that stayed unfixed only because it's load-bearing
// -- four templates (need.html, form.html, check.html, discrepancy.html)
// iframe it so a reviewer sees the live source page beside the extracted
// shopping list. Fixed here rather than ported: the caller names which
// food bank AND which of that food bank's 5 known URL fields to preview,
// never a raw URL Django would trust blindly. The actual URL value is
// resolved fresh from D1 on every request -- not cached, not trusted from
// the querystring -- so PROXYABLE_FIELDS is the entire attack surface, and
// it only admits the 5 fields PLAN.md's own acceptance criterion names.
const PROXYABLE_FIELDS = ["url", "shopping_list_url", "locations_url", "contacts_url", "donation_points_url"] as const;
type ProxyableField = (typeof PROXYABLE_FIELDS)[number];

function isProxyableField(value: string | undefined): value is ProxyableField {
  return !!value && (PROXYABLE_FIELDS as readonly string[]).includes(value);
}

function safeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

// GET /admin/proxy/?foodbank=<slug>&field=<one of PROXYABLE_FIELDS>&target=<absolute url, optional>
//
// `target` supports Django's original in-iframe-navigation UX (clicking a
// link inside the preview should stay inside the iframe): it's only ever
// honoured when its origin matches the already-resolved field URL's own
// origin, so a food bank's own site can't use a planted link to pivot this
// proxy at a third-party origin -- the allowlist is the field URL's origin,
// not "whatever target the client sends".
export async function adminProxy(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.query("foodbank");
  const field = c.req.query("field");
  if (!slug || !isProxyableField(field)) return c.text("Bad request", 400);

  const foodbank = await getFoodbankBySlug(dbSession(c), slug);
  if (!foodbank) return c.notFound();

  const fieldUrl = foodbank[field];
  const fieldOrigin = fieldUrl ? safeOrigin(fieldUrl) : null;
  if (!fieldUrl || !fieldOrigin) return c.text("No usable URL set for this field", 404);

  const requestedTarget = c.req.query("target");
  let targetUrl = fieldUrl;
  if (requestedTarget) {
    if (safeOrigin(requestedTarget) !== fieldOrigin) return c.text("URL not allowed", 403);
    targetUrl = requestedTarget;
  }

  let res: Response;
  try {
    res = await fetch(targetUrl, { headers: { "User-Agent": BOT_USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  } catch {
    return c.text(`${targetUrl} could not be reached. You should check the URL`, 502);
  }
  if (res.status !== 200) return c.text(`${targetUrl} returned ${res.status}. You should check the URL`, 502);
  if (!(res.headers.get("Content-Type") ?? "").includes("html")) return res; // e.g. a PDF shopping list -- nothing to rewrite

  const proxyOrigin = new URL(c.req.url).origin;
  const rewriter = new HTMLRewriter().on("a[href]", {
    element(el) {
      const href = el.getAttribute("href");
      if (!href) return;
      let absolute: string;
      try {
        absolute = new URL(href, targetUrl).toString();
      } catch {
        return;
      }
      if (safeOrigin(absolute) === fieldOrigin) {
        // Same domain -- rewrite through the proxy so navigation stays inside the iframe, matching Django's own behaviour.
        el.setAttribute(
          "href",
          `${proxyOrigin}/admin/proxy/?foodbank=${encodeURIComponent(slug)}&field=${field}&target=${encodeURIComponent(absolute)}`,
        );
        el.removeAttribute("target");
      } else {
        el.setAttribute("href", absolute);
        el.setAttribute("target", "_blank");
      }
    },
  });
  return rewriter.transform(res);
}
