import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../types";
import { elapsedMs } from "../middleware/serverTiming";

// givefood `human` (POST /human/, i18n-patterned -- givefood/urls.py:28,
// inside i18n_patterns). Ported from givefood/views.py:1073-1095: a
// Turnstile honeypot relay every public POST form (subscribe.njk included)
// posts through FIRST rather than directly at its real target. Renders
// public/human.njk with an invisible Turnstile widget (headless=True, no
// header/footer chrome -- see page.njk's `{% if not headless %}` guard)
// that auto-submits a SECOND POST, carrying every other field through
// unchanged, straight at `target` once the widget's callback fires.
//
// Method restriction is the caller's job (index.ts registers this as
// POST-only, same as Django's own @require_POST) -- this handler doesn't
// re-check it.
export async function humanRelay(c: Context<AppEnv>): Promise<Response> {
  const body = await c.req.parseBody();

  const target = typeof body.target === "string" ? body.target : "";
  if (!target) return new Response("", { status: 403 });

  const action = typeof body.action === "string" ? body.action : "";
  if (!action) return new Response("", { status: 403 });

  // post_vars.dict() minus target/action (givefood/views.py:1078-1087's
  // pop() calls) -- everything else the original form posted gets
  // re-emitted as hidden fields on the relay form.
  const postVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "target" || key === "action") continue;
    if (typeof value === "string") postVars[key] = value;
  }

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  // context_processors.py's `page_translatable` computes True for any
  // i18n_patterns-scoped path (translate_url() actually changes it) --
  // /human/ is one, so this matches every other i18n-scoped page's own
  // `pageTranslatable: true` even though nothing links to this page
  // directly (it's a same-request auto-submit relay, not browsed to).
  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    headless: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/human.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      target,
      action,
      post_vars: postVars,
      turnstile_sitekey: c.env.TURNSTILE_SITEKEY,
    },
    locale,
  );
  return c.html(html);
}
