import type { Context } from "hono";
import { getFoodbankIdBySlug } from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// gfwfbn `foodbank_hit` (POST /needs/at/<slug>/hit/, no i18n prefix -- see
// gfwfbn/urls/generic.py -- 204 no body, 404 on unknown slug). Ported from
// gfwfbn/views.py:1203-1228, with one deliberate architecture change: the
// Django view does a single atomic upsert against `foodbankhit`
// (INSERT ... ON CONFLICT DO UPDATE SET hits = hits + 1), keyed on
// (foodbank_id, day); the Workers port writes one Analytics Engine data
// point per hit instead and never touches D1 for this endpoint at all.
// See PLAN.md §10.7.3 for the full reasoning -- not something to
// re-litigate here.
//
// The foodbank is still resolved by slug first, purely for 404 parity
// (wfbn/includes/hit.njk fires this from every foodbank page, so an
// unknown slug should behave the same as it does everywhere else) --
// nothing else about the row is read, and the id itself is discarded once
// the existence check passes.
export async function wfbnFoodbankHit(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbankId = await getFoodbankIdBySlug(session, slug);
  if (foodbankId === null) return c.notFound();

  // `cf` is typed `any` by @cloudflare/workers-types (it varies by
  // product/plan), hence the narrow local shape -- `country` is the only
  // field this endpoint reads. Absent on non-Cloudflare-proxied requests
  // (e.g. local `wrangler dev`), hence the "" fallback.
  const cf = c.req.raw.cf as { country?: string } | undefined;
  const country = cf?.country ?? "";

  c.env.HITS.writeDataPoint({
    indexes: [slug],
    blobs: [slug, country],
    doubles: [1],
  });

  return c.body(null, 204);
}
