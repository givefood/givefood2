import type { Context } from "hono";
import { getFoodbankBySlug, getFoodbankLocationBySlugs, getLocationsByFoodbankIdNarrow } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../../types";
import { dbSession } from "../../../lib/session";
import { fullNameFoodbank, nonEmptyLines } from "@givefood/models";

// gfwfbn `md_foodbank_locations` (GET /md/needs/at/<slug>/locations/,
// untranslated -- outside i18n_patterns). no_locations === 0 is a bare
// guard, not a lookup failure, but still a 404 (HttpResponseNotFound());
// no_locations is a plain non-nullable number (packages/db/src/foodbank.ts),
// unlike its nullable no_donation_points sibling, so a strict === 0 is safe.
export async function mdFoodbankLocations(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  if (foodbank.no_locations === 0) return c.notFound();

  // NARROW, not the unprojected `SELECT *` (github #52's closing observation,
  // third instalment). locations.njk below prints name/address/postcode and
  // links by slug; it never mentions boundary_geojson, and unlike the HTML twin
  // it does not even ask WHETHER there is a boundary -- no place photos, no
  // service-area map -- so this takes the plain narrow row rather than the
  // flagged one. Measured on canterbury, the largest of the 7 production food
  // banks that own a boundary at all: 2,319,826 -> 19,532 bytes for this
  // statement, -99.2%, same query plan, rows_read unchanged at 43.
  const locations = await getLocationsByFoodbankIdNarrow(session, foodbank.id);

  const html = await render("wfbn/foodbank/md/locations.njk", {
    foodbank,
    full_name: fullNameFoodbank(foodbank.name),
    locations,
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

// gfwfbn `md_foodbank_location` (GET /md/needs/at/<slug>/<locslug>/,
// untranslated). getFoodbankLocationBySlugs scopes by both slugs together,
// so a locslug belonging to a different food bank 404s automatically --
// same as Django's get_object_or_404(FoodbankLocation, slug=locslug,
// foodbank=foodbank).
export async function mdFoodbankLocation(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const locslug = c.req.param("locslug")!;
  const session = dbSession(c);
  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();
  const location = await getFoodbankLocationBySlugs(session, foodbank.slug, locslug);
  if (!location) return c.notFound();

  // "" (not a "Nothing" sentinel) when there's no latest_need at all --
  // see ../foodbank.ts's mdFoodbank for why.
  const changeText = foodbank.latestNeed?.change_text ?? "";
  const excessChangeText = foodbank.latestNeed?.excess_change_text ?? null;

  const html = await render("wfbn/foodbank/md/location.njk", {
    foodbank,
    full_name: fullNameFoodbank(foodbank.name),
    location,
    latest_need_change_text: changeText,
    latest_need_get_change_text: nonEmptyLines(changeText).join("\n"),
    latest_need_excess_change_text: excessChangeText,
    excess_text_list: excessChangeText ? nonEmptyLines(excessChangeText) : [],
  });
  return new Response(html, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
