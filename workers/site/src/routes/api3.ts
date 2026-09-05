import { Hono } from "hono";
import { companyDonationPointsExist, getDonationPointsByCompanySlug, getFoodbankSlugByUuid, toDashedUuid } from "@givefood/db";
import type { AppEnv } from "../types";
import { dbSession } from "../lib/session";
import { changeList, charityRegisterUrl, excessList } from "@givefood/models";

// gfapi3 -- predates gfapi2/func.py's ALLOWED_FORMATS/apiResponse()
// machinery entirely: every endpoint here is JSON-only, with no CORS
// header and no Cache-Control, ported straight from gfapi3/views.py's
// plain JsonResponse/HttpResponse calls.
export const api3App = new Hono<AppEnv>();

// gfapi3 `index`
api3App.get("/", (c) => c.text("Give Food API 3"));

// gfapi3 `company` -- givefood/urls.py: /donationpoints/company/<slug:slug>/
api3App.get("/donationpoints/company/:slug/", async (c) => {
  const session = dbSession(c);
  const slug = c.req.param("slug");

  const exists = await companyDonationPointsExist(session, slug);
  if (!exists) {
    return c.json({ error: "Company not found" }, 404);
  }

  const donationpoints = await getDonationPointsByCompanySlug(session, slug);

  const EMPTY_NEEDS = ["Facebook", "Unknown", "Nothing"];

  const responseList = donationpoints.map((dp) => {
    // Django's view accesses dp.foodbank.latest_need.change_text with no
    // null guard -- if a row's join found no latest need, the source
    // crashes here. The `!` reproduces that: it throws at runtime on a
    // null latestNeed rather than silently substituting a fallback.
    const latestNeed = dp.foodbank.latestNeed!;

    let needsList: string[];
    let excessListValue: string[];
    if (EMPTY_NEEDS.includes(latestNeed.change_text)) {
      needsList = [];
      excessListValue = [];
    } else {
      needsList = changeList(latestNeed.change_text);
      excessListValue = excessList(latestNeed.excess_change_text);
    }

    return {
      id: toDashedUuid(dp.uuid),
      name: dp.name,
      foodbank: {
        id: toDashedUuid(dp.foodbank.uuid),
        name: dp.foodbank.name,
        alt_name: dp.foodbank.alt_name,
        slug: dp.foodbank.slug,
        url: dp.foodbank.url,
        shopping_list_url: dp.foodbank.shopping_list_url,
        phone_number: dp.foodbank.phone_number,
        secondary_phone_number: dp.foodbank.secondary_phone_number,
        email: dp.foodbank.contact_email,
        address: dp.foodbank.address,
        postcode: dp.foodbank.postcode,
        country: dp.foodbank.country,
        lat_lng: dp.foodbank.lat_lng,
        charity_number: dp.foodbank.charity_number,
        charity_register_url: charityRegisterUrl(dp.foodbank.charity_number, dp.foodbank.country),
        network: dp.foodbank.network,
        need: {
          id: toDashedUuid(latestNeed.need_id),
          items: needsList,
          excess: excessListValue,
          found: latestNeed.created,
        },
      },
      address: dp.address,
      postcode: dp.postcode,
      country: dp.country,
      lat_lng: dp.lat_lng,
      place_id: dp.place_id,
      store_id: dp.store_id,
    };
  });

  return c.json(responseList);
});

// gfapi3 `slugfromid` -- givefood/urls.py: /slugfromid/<uuid:uuid>/
api3App.get("/slugfromid/:uuid/", async (c) => {
  const session = dbSession(c);
  const uuid = c.req.param("uuid");

  const slug = await getFoodbankSlugByUuid(session, uuid);
  if (slug === null) {
    return c.text("Not found", 404);
  }
  return c.text(slug);
});
