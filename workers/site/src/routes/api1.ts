import { Hono } from "hono";
import {
  getAllFoodbanks,
  getFoodbankBySlug,
  getFoodbanksByIds,
  getLocationsByFoodbankIdNarrow,
  getNeedByUuid,
  getOpenFoodbankCoordinates,
  getPublishedNeeds,
  toDashedUuid,
} from "@givefood/db";
import { miles, nearest, parseLatLngLikePython, R_PYTHON } from "@givefood/geo";
import { formatCsvRow, formatDjangoJsonDatetime, formatPyStrDatetime, round2 } from "@givefood/serialise";
import type { AppEnv } from "../types";
import { dbSession } from "../lib/session";
import { geocode } from "../lib/geocode";
import { charityRegisterUrl, fullAddressUnconditional, noItems } from "@givefood/models";
import { timesince } from "../lib/timesince";

// gfapi1 -- the deprecated v1 API, still live and still consumed (PLAN.md
// §7.9: `Foodbank.save()` reverses `api_foodbanks`/`api_foodbank` to purge
// caches, so it cannot be removed without touching write-side code that is
// out of scope here). Every endpoint is plain JSON only (`api_foodbanks`
// also has a `?format=csv` branch) -- there is no CORS header and no
// Cache-Control anywhere in the real gfapi1/views.py, and nothing here
// should add either. Ported straight from gfapi1/views.py, verbatim,
// frozen bugs and all (B4, B6, B8, B12 -- see each endpoint's comments).
export const api1App = new Hono<AppEnv>();

// Every "self"/"html" URL in gfapi1/views.py is `"%s%s" % (API_DOMAIN,
// reverse(...))` where API_DOMAIN is a literal, not derived from the
// request (see task point 12) -- reproduced as a hardcoded string here.
const API_DOMAIN = "https://www.givefood.org.uk";

function foodbankSelfUrl(slug: string): string {
  return `${API_DOMAIN}/api/1/foodbank/${slug}/`;
}
function needSelfUrl(dashedNeedId: string): string {
  return `${API_DOMAIN}/api/1/need/${dashedNeedId}/`;
}

// Django's slugify(), reproduced only as simply as gfapi1 actually needs
// it (FoodbankChange.foodbank_name_slug() -- see PLAN.md R7: a full
// Unicode-faithful slugify is a much bigger job that matters for the
// *foodbank* slug used as a primary key elsewhere; this is only ever used
// here to reconstruct a URL fragment for `needs`/`need`'s response body).
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Python's int(str): strict, whitespace-trimmed, digits only (optionally
// signed) -- NOT the same as JS's `Number()`, which accepts "", "1e3",
// leading/trailing junk-free numeric literals JS considers valid but
// Python's int() rejects. Throws (uncaught -> a 500) on anything else,
// reproducing frozen bug B4 (`/api/1/needs/?limit=abc` is a 500 in the
// real API, not a 400 -- `int(limit)` runs before the allow-list check).
function pythonInt(s: string): number {
  const trimmed = s.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`invalid literal for int() with base 10: '${s}'`);
  }
  return Number(trimmed);
}

function coordinateLatLng(row: { latitude: number; longitude: number }): [number, number] {
  return [row.latitude, row.longitude];
}

// --- api_foodbanks (GET /foodbanks/) ---------------------------------
// B8: ALL food banks, open or closed -- getAllFoodbanks has no is_closed
// filter, and v1 must not "harmonise" with v2's open-only behaviour.
api1App.get("/foodbanks/", async (c) => {
  const format = c.req.query("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return new Response("", { status: 400 });
  }

  const session = dbSession(c);
  const foodbanks = await getAllFoodbanks(session);

  const responseList = foodbanks.map((foodbank) => ({
    name: foodbank.name,
    slug: foodbank.slug,
    url: foodbank.url,
    shopping_list_url: foodbank.shopping_list_url,
    phone: foodbank.phone_number,
    email: foodbank.contact_email,
    address: fullAddressUnconditional(foodbank.address, foodbank.postcode),
    postcode: foodbank.postcode,
    parliamentary_constituency: foodbank.parliamentary_constituency_name,
    mp: foodbank.mp,
    mp_party: foodbank.mp_party,
    ward: foodbank.ward,
    district: foodbank.district,
    country: foodbank.country,
    charity_number: foodbank.charity_number,
    charity_register_url: charityRegisterUrl(foodbank.charity_number, foodbank.country),
    closed: foodbank.is_closed,
    latt_long: foodbank.lat_lng,
    network: foodbank.network,
    self: foodbankSelfUrl(foodbank.slug),
  }));

  if (format === "json") {
    return c.json(responseList);
  }

  // format === "csv" -- unicodecsv.writer, default QUOTE_MINIMAL dialect,
  // \r\n line endings (formatCsvRow already reproduces this). Header is
  // the 19 keys above minus "self", in the same order (PLAN.md §7.4.5).
  const header = [
    "name",
    "slug",
    "url",
    "shopping_list_url",
    "phone",
    "email",
    "address",
    "postcode",
    "parliamentary_constituency",
    "mp",
    "mp_party",
    "ward",
    "district",
    "country",
    "charity_number",
    "charity_register_url",
    "closed",
    "latt_long",
    "network",
  ];
  let body = formatCsvRow(header);
  for (const row of responseList) {
    body += formatCsvRow([
      row.name,
      row.slug,
      row.url,
      row.shopping_list_url,
      row.phone,
      row.email,
      row.address,
      row.postcode,
      row.parliamentary_constituency,
      row.mp,
      row.mp_party,
      row.ward,
      row.district,
      row.country,
      row.charity_number,
      row.charity_register_url,
      row.closed,
      row.latt_long,
      row.network,
    ]);
  }
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="foodbanks.csv"',
    },
  });
});

// --- api_foodbank_search (GET /foodbanks/search/) ---------------------
// B6: no is_uk() check, no numeric validation on `lattlong` -- deliberate,
// do not add either. That means no 400 and no allowlist; it does NOT mean
// no error. Django reaches find_foodbanks() with whatever arrived and
// float() raises there (github #16) -- see the parse below.
api1App.get("/foodbanks/search/", async (c) => {
  const latLngParam = c.req.query("lattlong");
  const addressParam = c.req.query("address");

  if (!latLngParam && !addressParam) {
    return new Response("", { status: 400 });
  }

  let latLng = latLngParam;
  if (addressParam && !latLngParam) {
    latLng = await geocode(c, addressParam);
  }

  // THROWS, AND THE THROW IS THE POINT (github #16). This was
  // `Number(latStr)` / `Number(lngStr)`, which never throws -- so
  // `?lattlong=abc`, `?lattlong=banana` and `?lattlong=51.5` (a truncated
  // coordinate, the realistic client bug) each answered 200 with ten real
  // food banks in database order and `distance_m: null`. A third-party
  // widget rendered a Manchester food bank as "your nearest" regardless of
  // where the caller was, with nothing for the client or for monitoring to
  // detect. Django 500s on all three: geo.py:213-214's bare float() raises
  // ValueError, and a comma-less string raises IndexError on `[1]` before
  // that.
  //
  // NOT wrapped in a try/catch, deliberately, exactly like pythonInt() above
  // does for frozen bug B4: the uncaught throw reaches index.ts's
  // app.onError and renders the 500 Django renders. Adding a tidy 400 here
  // would be the divergence this route's B6 comment forbids.
  const [lat, lng] = parseLatLngLikePython(latLng as string);

  const session = dbSession(c);
  // WP 2.5 perf: rank against the cheap id+coordinate candidate set (a
  // covering-index scan), not the full ~1000-row, 79-column open-foodbank
  // set -- full rows for only the 10 survivors come from getFoodbanksByIds.
  const candidates = await getOpenFoodbankCoordinates(session);
  const ranked = nearest(candidates, lat, lng, coordinateLatLng, 10, R_PYTHON, false);
  const enriched = await getFoodbanksByIds(
    session,
    ranked.map((r) => r.item.id),
  );

  // KEYED BY id, NOT BY POSITION (github #48). getFoodbanksByIds preserves
  // the order of the ids it is handed but SILENTLY DROPS any it cannot find
  // (mapFoodbanksByIds' `.filter(row => row !== undefined)`), so `enriched`
  // can be shorter than `ranked` -- and a positional `ranked[i]` then shifts
  // every distance after the gap onto the wrong food bank. Not an exception:
  // a 200 carrying ten real food banks with nine wrong distances.
  //
  // The window is small but it is real. The candidate scan and this
  // hydration are two reads, and a food bank deleted between them
  // (foodbankAdmin.ts's delete path) is missing from the second. Django has
  // no such window -- it ranks and hydrates in one query -- so this is a gap
  // the two-phase port opened, not a behaviour to reproduce.
  //
  // This direction of the lookup is TOTAL: every row in `enriched` was asked
  // for by id, so its id is necessarily a key here. The map can only be
  // short, never wrong.
  const distanceById = new Map(ranked.map((r) => [r.item.id, r.distanceM]));

  const responseList = enriched.map((foodbank) => {
    const distanceM = distanceById.get(foodbank.id)!;
    // B12: `foodbank.latest_need` is dereferenced with no null guard in
    // the real view -- a food bank with no latest_need 500s here. The `!`
    // is compile-time only; it still throws at runtime on a null value,
    // reproducing that crash rather than masking it.
    const latestNeed = foodbank.latestNeed!;
    return {
      name: foodbank.name,
      slug: foodbank.slug,
      distance_m: Math.trunc(distanceM),
      distance_mi: round2(miles(distanceM)),
      url: foodbank.url,
      shopping_list_url: foodbank.shopping_list_url,
      phone: foodbank.phone_number,
      email: foodbank.contact_email,
      address: fullAddressUnconditional(foodbank.address, foodbank.postcode),
      postcode: foodbank.postcode,
      country: foodbank.country,
      parliamentary_constituency: foodbank.parliamentary_constituency_name,
      mp: foodbank.mp,
      mp_party: foodbank.mp_party,
      ward: foodbank.ward,
      district: foodbank.district,
      charity_number: foodbank.charity_number,
      charity_register_url: charityRegisterUrl(foodbank.charity_number, foodbank.country),
      needs: latestNeed.change_text,
      number_needs: noItems(latestNeed.change_text),
      need_id: toDashedUuid(latestNeed.need_id),
      // gfapi1/views.py:151 `str(foodbank.latest_need.created)` -- space
      // separator, six digits (PLAN.md §7.4.6's middle row).
      updated: formatPyStrDatetime(latestNeed.created),
      updated_text: timesince(latestNeed.created),
      latt_long: foodbank.lat_lng,
      self: foodbankSelfUrl(foodbank.slug),
    };
  });

  return c.json(responseList);
});

// --- api_foodbank (GET /foodbank/<slug:slug>/) -------------------------
api1App.get("/foodbank/:slug/", async (c) => {
  const slug = c.req.param("slug");
  const session = dbSession(c);

  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();

  // NARROW, not the unprojected `SELECT *` (github #52's closing observation,
  // third instalment). The serialiser below names TEN fields and
  // boundary_geojson is not one of them, so the blob was crossing the wire to
  // be dropped on the floor -- and a v1 field cannot appear by accident here,
  // because these keys are written out one by one. The plain narrow row, not
  // the flagged one: this endpoint does not publish a service-area flag either,
  // so `has_boundary` would be just as unread. Measured on canterbury, the
  // largest of the 7 production food banks that own a boundary at all:
  // 2,319,826 -> 19,532 bytes for this statement, -99.2%, same query plan,
  // rows_read unchanged at 43.
  const locations = await getLocationsByFoodbankIdNarrow(session, foodbank.id);
  const locationsList = locations.map((location) => ({
    name: location.name,
    address: location.address,
    postcode: location.postcode,
    latt_long: location.lat_lng,
    phone: location.phone_number,
    parliamentary_constituency: location.parliamentary_constituency_name,
    mp: location.mp,
    mp_party: location.mp_party,
    ward: location.ward,
    district: location.district,
  }));

  // B12 again: `foodbank.latest_need.change_text` etc. are unguarded in
  // the real view. `updated` is the one field that IS guarded in the
  // source (it goes through `latest_need_date()`, a method that checks
  // for a null latest_need itself) -- keep that field's ternary, and let
  // every other latest_need access below crash on a null value.
  const foodbankResponse = {
    name: foodbank.name,
    slug: foodbank.slug,
    url: foodbank.url,
    shopping_list_url: foodbank.shopping_list_url,
    phone: foodbank.phone_number,
    email: foodbank.contact_email,
    address: foodbank.address,
    postcode: foodbank.postcode,
    country: foodbank.country,
    parliamentary_constituency: foodbank.parliamentary_constituency_name,
    mp: foodbank.mp,
    mp_party: foodbank.mp_party,
    ward: foodbank.ward,
    district: foodbank.district,
    charity_number: foodbank.charity_number,
    charity_register_url: charityRegisterUrl(foodbank.charity_number, foodbank.country),
    closed: foodbank.is_closed,
    latt_long: foodbank.lat_lng,
    network: foodbank.network,
    needs: foodbank.latestNeed!.change_text,
    number_needs: noItems(foodbank.latestNeed!.change_text),
    // views.py:203 passes the raw datetime -> DjangoJSONEncoder (T, three
    // digits); :207 wraps latest_need_date() in str() (space, six). Two
    // renderings of near-identical values two lines apart -- Django's, and
    // reproduced exactly rather than harmonised (§7.4.6's "three different
    // renderings in one API").
    need_found: foodbank.last_need === null ? null : formatDjangoJsonDatetime(foodbank.last_need),
    need_id: toDashedUuid(foodbank.latestNeed!.need_id),
    need_self: needSelfUrl(toDashedUuid(foodbank.latestNeed!.need_id)),
    locations: locationsList,
    updated: formatPyStrDatetime(foodbank.latestNeed ? foodbank.latestNeed.created : foodbank.modified),
    updated_text: timesince(foodbank.latestNeed!.created),
    self: foodbankSelfUrl(foodbank.slug),
  };

  return c.json(foodbankResponse);
});

// --- api_needs (GET /needs/) --------------------------------------------
api1App.get("/needs/", async (c) => {
  const allowedLimits = [100, 1000];
  const limitParam = c.req.query("limit") ?? "100";
  // B4: a non-numeric ?limit= throws here (matching Python's `int(limit)`
  // raising ValueError before the allow-list check below ever runs), and
  // is left to surface as an uncaught 500 -- not gracefully 400ed.
  const limit = pythonInt(limitParam);
  if (!allowedLimits.includes(limit)) {
    return new Response("", { status: 400 });
  }

  const session = dbSession(c);
  const needs = await getPublishedNeeds(session, limit);

  const responseList = needs.map((need) => {
    const foodbankSlug = slugify(need.foodbank_name ?? "");
    return {
      id: toDashedUuid(need.need_id),
      created: formatDjangoJsonDatetime(need.created), // views.py:231, raw datetime -> DjangoJSONEncoder
      foodbank_name: need.foodbank_name,
      foodbank_slug: foodbankSlug,
      foodbank_self: foodbankSelfUrl(foodbankSlug),
      needs: need.change_text,
      url: need.uri,
      self: needSelfUrl(toDashedUuid(need.need_id)),
    };
  });

  return c.json(responseList);
});

// --- api_need (GET /need/<uuid:id>/) ------------------------------------
api1App.get("/need/:id/", async (c) => {
  const id = c.req.param("id");
  const session = dbSession(c);

  const need = await getNeedByUuid(session, id);
  if (!need) return c.notFound();

  const foodbankSlug = slugify(need.foodbank_name ?? "");
  const needResponse = {
    id: toDashedUuid(need.need_id),
    created: formatDjangoJsonDatetime(need.created), // views.py:250, same as the list above
    foodbank_name: need.foodbank_name,
    foodbank_slug: foodbankSlug,
    foodbank_self: foodbankSelfUrl(foodbankSlug),
    needs: need.change_text,
    url: need.uri,
    self: needSelfUrl(toDashedUuid(need.need_id)),
  };

  return c.json(needResponse);
});
