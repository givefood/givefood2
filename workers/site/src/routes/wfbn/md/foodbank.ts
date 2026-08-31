import type { Context } from "hono";
import { getFoodbankBySlug } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../../types";
import { dbSession } from "../../../lib/session";
import { findLocations } from "../../../lib/findLocations";
import { fullNameFoodbank, networkUrl, nonEmptyLines } from "../../../lib/fields";

// gfwfbn `md_foodbank` (GET /md/needs/at/<slug>/, untranslated -- outside
// i18n_patterns, see givefood/urls.py's "Markdown versions" block). Same
// getFoodbankBySlug() lookup as wfbnFoodbank (../foodbank.ts), rendered to
// the plain-text markdown twin instead of the HTML page.
export async function mdFoodbank(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();

  const fullName = fullNameFoodbank(foodbank.name);
  // "" (not a "Nothing" sentinel) when there's no latest_need at all --
  // Django's `foodbank.latest_need.change_text` on a None latest_need
  // resolves to Django's invalid-variable default (''), which passes the
  // template's Unknown/Nothing/Facebook exclusion check same as any other
  // real, non-sentinel value would.
  const latestNeedChangeText = foodbank.latestNeed?.change_text ?? "";
  const latestNeedExcessText = foodbank.latestNeed?.excess_change_text ?? null;
  // FoodbankChange.get_change_text()/get_excess_text_list() -- non-empty
  // lines only; latest_need_change_text (raw) is kept separately for the
  // template's own Unknown/Nothing/Facebook condition, which Django checks
  // against the raw field, not the stripped one.
  const latestNeedGetChangeText = nonEmptyLines(latestNeedChangeText).join("\n");
  const excessTextList = latestNeedExcessText ? nonEmptyLines(latestNeedExcessText) : [];

  const html = await render("wfbn/foodbank/md/index.njk", {
    foodbank: {
      ...foodbank,
      latest_need_change_text: latestNeedChangeText,
      latest_need_get_change_text: latestNeedGetChangeText,
      latest_need_excess_text: latestNeedExcessText,
    },
    full_name: fullName,
    excess_text_list: excessTextList,
    network_url: networkUrl(foodbank.network),
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

// gfwfbn `md_foodbank_nearby` (GET /md/needs/at/<slug>/nearby/,
// untranslated). Same findLocations(foodbank.lat_lng, 20, True) call as
// wfbnFoodbankNearby (../nearby.ts, including its documented
// skip_first=True divergence note), rendered to markdown.
export async function mdFoodbankNearby(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();

  const fullName = fullNameFoodbank(foodbank.name);
  const [latStr, lngStr] = foodbank.lat_lng.split(",");
  const nearby = await findLocations(session, Number(latStr), Number(lngStr), 20, true);

  const html = await render("wfbn/foodbank/md/nearby.njk", {
    foodbank,
    full_name: fullName,
    nearby,
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
