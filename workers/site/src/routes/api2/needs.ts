import { Hono } from "hono";
import { getNeedByUuid, getPublishedNeeds, toDashedUuid, type FoodbankChangeRow } from "@givefood/db";
import type { SerialisableValue } from "@givefood/serialise";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { apiResponse, SECONDS_IN_DAY, SECONDS_IN_HOUR } from "../../lib/apiResponse";

// gfapi2 `needs` / `need` -- givefood/urls.py: /needs/, /need/<uuid:id>/.
// Ported straight from gfapi2/views.py, verbatim.
export const api2NeedsApp = new Hono<AppEnv>();

// Every "self"/"html" URL in gfapi2/views.py is a literal
// "https://www.givefood.org.uk" prefix, not derived from the request (see
// task point 12) -- reproduced as a hardcoded string here.
const SITE_DOMAIN = "https://www.givefood.org.uk";

// Django's slugify(), reduced to only what FoodbankChange.foodbank_name_slug()
// actually needs: lowercase, collapse every run of non a-z0-9 into a single
// "-", trim leading/trailing "-". (Same reduction api1.ts makes for the same
// reason -- this is only ever used to rebuild a URL fragment, not the
// canonical foodbank slug itself.)
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// need.foodbank_name is typed nullable at the row level (packages/db), but
// every real row has one -- FoodbankChange.foodbank_name_slug() slugifies
// it with no null guard in the source. `?? ""` only protects slugify()'s
// argument type here; it is not new validation logic.
function needToResponseDict(need: FoodbankChangeRow): SerialisableValue {
  const needIdStr = toDashedUuid(need.need_id);
  const foodbankSlug = slugify(need.foodbank_name ?? "");
  return {
    id: needIdStr,
    found: { __datetime: need.created },
    foodbank: {
      name: need.foodbank_name,
      slug: foodbankSlug,
      urls: {
        self: `${SITE_DOMAIN}/api/2/foodbank/${foodbankSlug}/`,
        html: `${SITE_DOMAIN}/needs/at/${foodbankSlug}/`,
      },
    },
    needs: need.change_text,
    excess: need.excess_change_text,
    self: `${SITE_DOMAIN}/api/2/need/${needIdStr}/`,
  };
}

// --- needs (GET /needs/) -------------------------------------------------
// Hardcoded limit=100, no querystring override (unlike gfapi1's api_needs).
api2NeedsApp.get("/needs/", async (c) => {
  const format = c.req.query("format") ?? "json";
  const session = dbSession(c);

  const needs = await getPublishedNeeds(session, 100);
  const responseList = needs.map(needToResponseDict);

  return apiResponse(responseList, "needs", format, SECONDS_IN_HOUR);
});

// --- need (GET /need/<uuid:id>/) -----------------------------------------
api2NeedsApp.get("/need/:id/", async (c) => {
  const format = c.req.query("format") ?? "json";
  const idParam = c.req.param("id");
  const session = dbSession(c);

  const need = await getNeedByUuid(session, idParam);
  if (!need) return c.notFound();

  return apiResponse(needToResponseDict(need), "need", format, SECONDS_IN_DAY);
});
