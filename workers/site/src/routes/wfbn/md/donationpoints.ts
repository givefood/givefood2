import type { Context } from "hono";
import { getDonationPointBySlugs, getDonationPointsByFoodbankId, getFoodbankBySlug } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../../types";
import { dbSession } from "../../../lib/session";
import { fullNameFoodbank, nonEmptyLines } from "@givefood/models";

// gfwfbn-md `md_foodbank_donationpoints` (GET
// /md/needs/at/<slug>/donationpoints/, untranslated -- see
// ./foodbank.ts's identical module note on the "Markdown versions" block).
export async function mdFoodbankDonationpoints(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();

  // no_donation_points is nullable in production (unlike its no_locations
  // sibling) -- a truthy check treats null the same as 0, matching
  // Django's own `if foodbank.no_donation_points == 0:`. Same bug class
  // already fixed in ../updates.ts and ../../public/sitemaps.ts.
  if (!foodbank.no_donation_points) return c.notFound();

  const donationPoints = await getDonationPointsByFoodbankId(session, foodbank.id);

  const html = await render("wfbn/foodbank/md/donationpoints.njk", {
    foodbank,
    full_name: fullNameFoodbank(foodbank.name),
    donationPoints,
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

// gfwfbn-md `md_foodbank_donationpoint` (GET
// /md/needs/at/<slug>/donationpoint/<dpslug>/, untranslated).
export async function mdFoodbankDonationpoint(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const dpslug = c.req.param("dpslug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  const donationpoint = await getDonationPointBySlugs(session, slug, dpslug);
  if (!donationpoint) return c.notFound();

  // "" (not a "Nothing" sentinel) when there's no latest_need at all --
  // see ../foodbank.ts's mdFoodbank for why.
  const latestNeedChangeText = foodbank.latestNeed?.change_text ?? "";
  const hasNeed = latestNeedChangeText !== "Unknown" && latestNeedChangeText !== "Nothing" && latestNeedChangeText !== "Facebook";
  const latestNeedExcessText = foodbank.latestNeed?.excess_change_text ?? null;
  // FoodbankChange.get_change_text()/get_excess_text_list() -- non-empty
  // lines only; no translation-table lookup, this md surface is
  // English-only throughout.
  const changeText = nonEmptyLines(latestNeedChangeText).join("\n");
  const excessTextList = latestNeedExcessText ? nonEmptyLines(latestNeedExcessText) : [];

  const html = await render("wfbn/foodbank/md/donationpoint.njk", {
    foodbank,
    full_name: fullNameFoodbank(foodbank.name),
    donationpoint,
    has_need: hasNeed,
    change_text: changeText,
    excess_change_text: latestNeedExcessText,
    excess_text_list: excessTextList,
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
