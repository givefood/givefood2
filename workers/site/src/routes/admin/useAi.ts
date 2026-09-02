import type { Context } from "hono";
import { getFoodbankBySlug, updateFoodbankFields } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";

// gfadmin/views.py:1313-1360 foodbank_use_ai_detail, @require_POST.
// Confirmed (WP 6.8 research): makes no AI call itself, just commits one
// value the check job already found -- its only caller is the check page
// (WP 6.8), which now exists. Not built on WP 6.5's generic
// updateFoodbankFields path (30-field form semantics, required-field
// validation) -- this is a single named field with its own bespoke
// validation, matching Django's own hand-written checks per field.
const ALLOWED_FIELDS = ["phone_number", "contact_email", "charity_number", "facebook_page", "bankuet_slug", "rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"] as const;
const URL_FIELDS = new Set(["rss_url", "news_url", "donation_points_url", "locations_url", "contacts_url"]);

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidEmail(value: string): boolean {
  // Same coarse shape as Django's EmailValidator needs to catch here --
  // this is a "did the AI hallucinate garbage" guard, not RFC 5322.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function adminFoodbankUseAiDetail(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const field = c.req.param("field")!;
  if (!(ALLOWED_FIELDS as readonly string[]).includes(field)) return c.text("Invalid field", 400);

  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, slug);
  if (!foodbank) return c.notFound();

  const body = await c.req.parseBody();
  const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
  if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

  let value = typeof body.value === "string" ? body.value : "";
  if (field === "phone_number" && value) value = value.replace(/\s+/g, "");
  if (field === "contact_email" && value && !isValidEmail(value)) return c.text("Invalid email format", 400);
  if (URL_FIELDS.has(field) && value && !isValidUrl(value)) return c.text("Invalid URL format", 400);

  await updateFoodbankFields(db, foodbank.id, { [field]: value }, true);

  if (c.req.header("HX-Request")) {
    return c.html('<button type="button" class="button is-small is-success is-light" disabled>Used</button>');
  }
  return c.redirect(`/admin/foodbank/${foodbank.slug}/check/`, 302);
}
