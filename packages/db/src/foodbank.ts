import { coerceBooleans, mapCoordinateRows, queryCoordinates, type CoordinateRow, type Session } from "./types";
import { normalizeUuid } from "./uuid";
import { getNeedsByIds, getNeedsByFoodbankIds, mapNeedRow, type FoodbankChangeRow } from "./needs";

const BOOLEAN_COLUMNS = [
  "charity_just_foodbank",
  "place_has_photo",
  "address_is_administrative",
  "is_closed",
  "is_school",
] as const;

export interface FoodbankRow {
  id: number;
  uuid: string; // 32-char dashless
  name: string;
  alt_name: string | null;
  slug: string;
  address: string;
  postcode: string;
  country: string;
  lat_lng: string; // "lat,lng" -- the API emits this verbatim, do not reformat
  latitude: number | null;
  longitude: number | null;
  delivery_address: string | null;
  delivery_lat_lng: string | null;
  network: string | null;
  network_id: string | null;
  notes: string | null;
  charity_number: string | null;
  charity_just_foodbank: boolean;
  charity_id: string | null;
  charity_name: string | null;
  charity_type: string | null;
  charity_reg_date: string | null;
  charity_postcode: string | null;
  charity_website: string | null;
  charity_objectives: string | null;
  charity_purpose: string | null;
  facebook_page: string | null;
  bankuet_slug: string | null;
  fsa_id: string | null;
  contact_email: string;
  notification_email: string | null;
  phone_number: string | null;
  secondary_phone_number: string | null;
  delivery_phone_number: string | null;
  url: string;
  shopping_list_url: string;
  rss_url: string | null;
  news_url: string | null;
  donation_points_url: string | null;
  locations_url: string | null;
  contacts_url: string | null;
  place_id: string | null;
  plus_code_compound: string | null;
  plus_code_global: string | null;
  place_has_photo: boolean | null;
  county: string | null;
  district: string | null;
  ward: string | null;
  lsoa: string | null;
  msoa: string | null;
  parliamentary_constituency_id: number | null;
  parliamentary_constituency_name: string | null;
  parliamentary_constituency_slug: string | null;
  mp: string | null;
  mp_party: string | null;
  mp_parl_id: number | null;
  address_is_administrative: boolean;
  is_closed: boolean;
  is_school: boolean | null;
  no_locations: number;
  no_donation_points: number | null;
  days_between_needs: number;
  footprint: number | null;
  bounds_north: number | null;
  bounds_south: number | null;
  bounds_east: number | null;
  bounds_west: number | null;
  latest_need_id: number | null;
  last_order: string | null;
  last_need: string | null;
  last_rfi: string | null;
  last_crawl: string | null;
  last_social_media_check: string | null;
  last_discrepancy_check: string | null;
  last_need_check: string | null;
  last_charity_check: string | null;
  created: string;
  modified: string;
  edited: string | null;
}

export interface FoodbankWithLatestNeed extends FoodbankRow {
  latestNeed: FoodbankChangeRow | null;
}

export function mapFoodbankRow(raw: Record<string, unknown>): FoodbankRow {
  return coerceBooleans<FoodbankRow>(raw, BOOLEAN_COLUMNS);
}

// gfapi1 `api_foodbanks` -- every row, open or closed (frozen bug B8,
// PLAN.md §7.3: v1 includes closed food banks, v2 does not -- do not
// "harmonise" the two).
export async function getAllFoodbanks(session: Session): Promise<FoodbankRow[]> {
  const result = await session.prepare("SELECT * FROM foodbank").all();
  return result.results.map(mapFoodbankRow);
}

// gfapi2 `foodbanks`, and the candidate set for every nearest-food-bank
// search (gfapi1 `api_foodbank_search`, gfapi2 `foodbank_search`,
// `Foodbank.nearby()`) -- ranking and top-N selection is WP 2.5's job, this
// just returns the full open set the way `get_all_open_foodbanks()` does.
export async function getAllOpenFoodbanks(session: Session): Promise<FoodbankRow[]> {
  const result = await session.prepare("SELECT * FROM foodbank WHERE is_closed = 0").all();
  return result.results.map(mapFoodbankRow);
}

// sitemap.xml's food-bank loop, and only that -- the seven columns it
// reads. Django narrows the same queryset the same way
// (`Foodbank.objects.all().exclude(is_closed=True).only('slug',
// 'days_between_needs', 'no_locations', 'no_donation_points', 'rss_url',
// 'news_url', 'charity_name', 'facebook_page')`, givefood/views.py:660-669);
// `facebook_page` is in Django's list but read by nothing in either the
// Python template or ours, so it is not fetched here.
//
// Same narrow-column reasoning as locations.ts's getAllOpenLocationSlugs.
// Measured against production D1: `SELECT *` over the 1,023 open food banks
// serialises 3,590,727 bytes in a median 94 ms (80-112, n=5) where these
// seven columns are 279,644 bytes in a median 8 ms (7-12). rows_read is
// UNCHANGED at 1,024, so this is wire bytes and latency, not D1 billing.
export interface FoodbankSitemapRow {
  slug: string;
  days_between_needs: number;
  no_locations: number;
  no_donation_points: number | null; // nullable in production, unlike no_locations -- see sitemaps.ts's own comment
  rss_url: string | null;
  news_url: string | null;
  charity_name: string | null;
}
export async function getAllOpenFoodbanksForSitemap(session: Session): Promise<FoodbankSitemapRow[]> {
  const result = await session
    .prepare(
      "SELECT slug, days_between_needs, no_locations, no_donation_points, rss_url, news_url, charity_name " +
        "FROM foodbank WHERE is_closed = 0",
    )
    .all();
  return result.results as unknown as FoodbankSitemapRow[];
}

// md_sitemap()'s food-bank loop reads only .slug, so this is narrower still
// than Django's own `.only('slug', 'name')` (givefood/views.py:752) -- the
// same choice locations.ts already makes between getAllOpenLocationSlugs
// and ...WithNames for this exact pair of views. Returns bare strings,
// matching getAllConstituencySlugs in constituencies.ts.
export async function getAllOpenFoodbankSlugs(session: Session): Promise<string[]> {
  const result = await session.prepare("SELECT slug FROM foodbank WHERE is_closed = 0").all();
  return result.results.map((r) => (r as { slug: string }).slug);
}

// md_sitemap_md()'s variant -- `name` for the link text, matching Django's
// `.only('slug', 'name')` (givefood/views.py:793) exactly.
export async function getAllOpenFoodbankSlugsWithNames(session: Session): Promise<Array<{ slug: string; name: string }>> {
  const result = await session.prepare("SELECT slug, name FROM foodbank WHERE is_closed = 0").all();
  return result.results as unknown as Array<{ slug: string; name: string }>;
}

// WP 2.5 perf: the id+coordinate candidate set for ranking a nearest-N
// food bank search (gfapi1 `api_foodbank_search`, gfapi2 `foodbank_search`,
// `Foodbank.nearby()`) -- see queryCoordinates's own comment in types.ts.
// Covered entirely by `foodbank_open_latlng_idx`.
//
// The SQL is a named constant because getFoodbankBySlugWithOpenCoordinates
// below sends this same statement inside a batch. One string, so the two
// cannot drift into ranking against different candidate sets.
const OPEN_FOODBANK_COORDINATES_SQL = "SELECT id, latitude, longitude FROM foodbank WHERE is_closed = 0";

export async function getOpenFoodbankCoordinates(session: Session): Promise<CoordinateRow[]> {
  return queryCoordinates(session, OPEN_FOODBANK_COORDINATES_SQL);
}

// gfapi1 `api_foodbank` / gfapi2 `foodbank` detail endpoints -- both use
// `select_related("latest_need")` and neither filters `is_closed` (a
// closed food bank is still servable by slug). Also every WFBN food bank
// page, its /md/ twin, the RSS feeds, the GeoJSON scope builder and most
// of /admin/: 53 call sites across 36 files, 25 of them (in 16 files) on
// the public site.
//
// ONE ROUND TRIP, NOT TWO. The need row is a function of the slug alone,
// so the two statements are independent and `session.batch()` sends them
// together -- the same fix, for the same reason, as
// foodbankDetail.ts's getLocationsDonationPointsAndNearbyFoodbanks. Measured
// against production with cache-busted, interleaved requests reading
// Server-Timing `render;dur` (which on these pages IS the D1 wait, because
// Workers' performance.now() only advances at I/O boundaries -- see
// middleware/serverTiming.ts): a D1 round trip costs ~19-22 ms, and
// /md/needs/at/<slug>/ -- which calls this function and does nothing else
// -- ran a median 37 ms across 8 samples. `latest_need_id` is non-NULL on
// all 1,070 production rows, so there was no branch where the second trip
// was skipped in practice. It matters because these pages mostly miss the
// edge cache (11.9% HTML hit rate, 1.3% md -- ~1,070 food banks x 4
// locales x 36 colos never warms), so ~88% of food bank page views paid
// it.
//
// STILL TWO STATEMENTS, NOT A JOIN. `foodbank` and `foodbankchange_full`
// collide on id, name, created and modified, so folding them into one
// SELECT needs a ~95-column alias list. batch() buys the round trip
// without that. See needs.ts's comment above getNeedById.
//
// The scalar subquery re-probes `foodbank_slug_uniq` (EXPLAIN QUERY PLAN
// on production: `SCALAR SUBQUERY 1` -> `SEARCH foodbank USING INDEX
// foodbank_slug_uniq (slug=?)`, then `SEARCH c USING INTEGER PRIMARY KEY`),
// costing one extra rows_read per call and no scan. A NULL
// `latest_need_id` makes `id = NULL` NULL and returns zero rows, which is
// the same `latestNeed: null` the old `latest_need_id === null` guard gave;
// an unknown slug leaves both statements empty and is still caught by the
// `if (!row)` below. Batching also closes a small read race: the two rows
// now come from one snapshot rather than two instants, so a need published
// between them can no longer serve a mismatched pair.
//
// The two statements and their mapping are factored out (rather than written
// inline here) so that getFoodbankBySlugWithOpenCoordinates below sends the
// SAME pair, mapped by the SAME code. A second copy of either would be a
// second thing to keep in step with `foodbankchange_full`.
function foodbankBySlugStatements(session: Session, slug: string): D1PreparedStatement[] {
  return [
    session.prepare("SELECT * FROM foodbank WHERE slug = ?").bind(slug),
    session
      .prepare("SELECT * FROM foodbankchange_full WHERE id = (SELECT latest_need_id FROM foodbank WHERE slug = ?)")
      .bind(slug),
  ];
}

function mapFoodbankBySlugResults(foodbankRows: readonly unknown[], needRows: readonly unknown[]): FoodbankWithLatestNeed | null {
  const row = foodbankRows[0];
  if (!row) return null;
  const needRow = needRows[0];
  return {
    ...mapFoodbankRow(row as Record<string, unknown>),
    latestNeed: needRow ? mapNeedRow(needRow as Record<string, unknown>) : null,
  };
}

export async function getFoodbankBySlug(session: Session, slug: string): Promise<FoodbankWithLatestNeed | null> {
  const results = await session.batch(foodbankBySlugStatements(session, slug));
  // batch() always returns one result per input statement, in the same
  // order -- exactly 2 here, so these indexes are never actually out of
  // range despite noUncheckedIndexedAccess flagging them as possibly so.
  return mapFoodbankBySlugResults(results[0]!.results, results[1]!.results);
}

// `Foodbank.has_service_area()`'s COUNT(*), KEYED BY SLUG so that it can ride
// in the batch above instead of waiting for the id that batch is fetching
// (github #52 item 3).
//
// locations.ts's hasServiceArea() takes a foodbank_id, which is exactly why
// the three page handlers that use it could not stop paying a round trip for
// it: /needs/at/<slug>/, /<locslug>/ and /donationpoint/<dpslug>/ fetch no
// location rows of their own, so they cannot derive the flag the way
// wfbn/locations.ts now does -- and they cannot batch an id-keyed count either,
// because the id arrives in the result of the very batch it would have to
// travel in. Re-keying it on the slug the caller already holds breaks that
// circularity: the count becomes independent of the other two statements and
// all three go out together.
//
// THE PLAN IS CLEAN, verified against production D1 (read-only) rather than
// taken from the issue:
//   SEARCH l USING INDEX loc_foodbank_slug_idx (foodbank_id=?)
//   SCALAR SUBQUERY 1
//     SEARCH foodbank USING COVERING INDEX foodbank_slug_uniq (slug=?)
// 0.74 ms of SQL for /needs/at/salisbury/, against a ~16-22 ms round trip. The
// re-probe of the slug costs exactly ONE extra rows_read over the id-keyed
// spelling -- 10 rather than 9, measured on the same food bank -- because
// `foodbank_slug_uniq` covers it and the table row is never touched. That is
// the whole price of the change, and it buys a serialised network wait on the
// busiest page family on the site.
//
// AND IT IS THE SAME COUNT. `foodbank.slug` is UNIQUE (foodbank_slug_uniq), so
// the scalar subquery yields at most one id and `foodbank_id = (that id)` is
// the same predicate as `foodbank_id = ?` bound to it. Checked against
// production data rather than argued: running both spellings for all 1,070
// food banks and comparing them pairwise returns 0 disagreements.
const SERVICE_AREA_COUNT_BY_SLUG_SQL =
  "SELECT COUNT(*) AS n FROM foodbanklocation l " +
  "WHERE l.foodbank_id = (SELECT id FROM foodbank WHERE slug = ?) " +
  "AND l.boundary_geojson IS NOT NULL AND l.boundary_geojson != ''";

export interface FoodbankBySlugWithServiceArea {
  foodbank: FoodbankWithLatestNeed | null;
  hasServiceArea: boolean;
}

// getFoodbankBySlug plus `has_service_area`, in the SAME round trip.
//
// A SEPARATE FUNCTION, AND NOT A FIELD ON getFoodbankBySlug'S RESULT. That
// function has ~50 call sites -- gfapi1, gfapi2, gfapi3, every /md/ twin, the
// RSS feeds, the GeoJSON scope builder and most of /admin/ -- and exactly
// three of them (wfbn/foodbank.ts and wfbn/locationDetail.ts's two handlers)
// render this flag. Putting the count into foodbankBySlugStatements would make
// every one of the other ~47 pay for it: no extra round trip, but a third
// statement, ~1 + N rows_read and ~0.7 ms of SQL each, on paths that then
// throw the answer away. D1 bills rows read. So the count is pushed onto a
// COPY of the shared statement list, by the callers who want it -- the same
// shape, for the same reason, as getFoodbankBySlugWithOpenCoordinates above.
// foodbankBySlugStatements and mapFoodbankBySlugResults being factored out is
// what makes that a three-line addition rather than a third copy of the pair.
//
// It also stays off the returned object because `has_service_area` is not a
// property of the foodbank row: it is a live count over another table, and
// FoodbankWithLatestNeed is the row shape ~50 sites spread into API response
// bodies. A key that appeared there would leak into serialised output.
//
// THE GUARD, AND IT IS NOT NEGOTIABLE. Django's has_service_area()
// (givefood/models/foodbank.py:296-302) is:
//
//     def has_service_area(self):
//         if self.no_locations == 0:
//             return False
//         locations = FoodbankLocation.objects.filter(foodbank = self)...count()
//         if locations == 0:
//             return False
//         return True
//
// The cached counter is checked FIRST and the query is not issued at all. The
// count now always travels (it has to -- no_locations is a column of the very
// row this batch is fetching, so nothing can be decided before it lands), but
// the ANSWER still short-circuits on it, which is the half that is observable.
// A food bank whose no_locations is a stale 0 while it owns a location with a
// boundary must render WITHOUT a service area, exactly as Django's does.
// Deleting `foodbank.no_locations !== 0` below would diverge from the Python
// on that state, and would also split this port against itself: wfbn/
// locations.ts:174 applies the same guard to the same flag on the sibling page.
//
// There is no such food bank in production today -- 0 of 1,070 rows have
// no_locations = 0 while owning any location -- so this is parity insurance
// against a state the admin can create, not a live rendering difference. That
// is precisely why it needs a test rather than an eyeball.
export async function getFoodbankBySlugWithServiceArea(
  session: Session,
  slug: string,
): Promise<FoodbankBySlugWithServiceArea> {
  const statements = foodbankBySlugStatements(session, slug);
  statements.push(session.prepare(SERVICE_AREA_COUNT_BY_SLUG_SQL).bind(slug));
  const results = await session.batch(statements);
  const foodbank = mapFoodbankBySlugResults(results[0]!.results, results[1]!.results);
  // COUNT(*) always returns exactly one row, even for an unknown slug (the
  // subquery is NULL, `foodbank_id = NULL` matches nothing, the count is 0),
  // so this cannot be undefined in practice -- `?? 0` is for the type checker
  // and for a caller that 404s a moment later anyway.
  const count = (results[2]!.results[0] as { n: number } | undefined)?.n ?? 0;
  return {
    foodbank,
    hasServiceArea: foodbank !== null && foodbank.no_locations !== 0 && count > 0,
  };
}

// gfapi2 `foodbank`'s FIRST WAVE (github #49): the detail endpoint needs this
// food bank, its latest need, AND -- for `nearby_foodbanks` -- the whole open
// candidate set to rank against. The third query depends on nothing at all,
// so awaiting it after the first two bought a wholly avoidable round trip.
// One batch, three statements, one wait.
//
// `wantOpenCoordinates` IS NOT AN OPTIMISATION FLAG, IT IS THE POINT. The
// ?format=geojson branch of that endpoint has no nearby_foodbanks and never
// reads this list, so hoisting the scan unconditionally would ADD a 1,024-row
// scan to every geojson request in order to save nothing. The format is known
// before the first query is issued, so the caller passes it in.
//
// The 404 path now speculates: an unknown slug pays one wasted candidate scan.
// Measured against production, running the three statements a bad slug now
// sends: the slug lookup reads 0 rows (a miss on foodbank_slug_uniq reads
// none), the need subquery 0, and the scan 1,024 in 5.3 ms of D1 SQL -- so
// rows_read on a 404 goes from 0 to 1,024. That is a real if tiny D1 billing
// regression on bad slugs, accepted deliberately -- it buys a round trip on
// every good one.
export async function getFoodbankBySlugWithOpenCoordinates(
  session: Session,
  slug: string,
  wantOpenCoordinates: boolean,
): Promise<{ foodbank: FoodbankWithLatestNeed | null; openCoordinates: CoordinateRow[] }> {
  const statements = foodbankBySlugStatements(session, slug);
  if (wantOpenCoordinates) statements.push(session.prepare(OPEN_FOODBANK_COORDINATES_SQL));
  const results = await session.batch(statements);
  return {
    foodbank: mapFoodbankBySlugResults(results[0]!.results, results[1]!.results),
    openCoordinates: wantOpenCoordinates ? mapCoordinateRows(results[2]!.results) : [],
  };
}

// For enriching a small, already-ranked set of ids with `latest_need` --
// e.g. the top 10/20 results of a nearest-food-bank search, mirroring the
// per-row `foodbank.latest_need` access the Django views do only *after*
// slicing (see PLAN.md §7.2's N+1 note on `foodbank_search`: this is
// deliberate existing behaviour, not something to "fix" into a single join
// over the full open set). `WHERE id IN (...)` gives no ordering guarantee,
// so the result is re-sorted back into the caller's `ids` order -- a caller
// ranking by distance must see that ranking preserved, not D1's rowid order.
//
// The `latest_need` fetch batches all distinct latest_need_ids into ONE
// `WHERE id IN (...)` query rather than one getNeedById() call per row --
// found via real timing comparisons against production (a follow-up to WP
// 2.5): every list/search endpoint calling this with N results was making
// N+1 D1 round trips, and was the slowest thing in the whole API for it.
//
// SPLIT IN TWO, statement and mapping, for github #49: gfapi2 `foodbank`'s
// second wave already has a batch in flight (its locations and its donation
// points), so the SELECT below rides along in it instead of paying a round
// trip of its own -- see foodbankDetail.ts's
// getLocationsDonationPointsAndNearbyFoodbanks. The halves are exported
// rather than duplicated there BECAUSE of the id-order re-sort: a caller that
// re-implemented "rows by id" would silently serve nearby_foodbanks in D1's
// rowid order instead of by distance, which no response-shape test would see.
export function foodbanksByIdsStatement(session: Session, ids: readonly number[]): D1PreparedStatement {
  const placeholders = ids.map(() => "?").join(", ");
  return session.prepare(`SELECT * FROM foodbank WHERE id IN (${placeholders})`).bind(...ids);
}

// Rows back into the caller's `ids` order, dropping any id that matched no
// row. Split out of mapFoodbanksByIds by github #53 so the two callers can
// differ in HOW they get the needs while agreeing exactly on everything
// else.
function orderFoodbankRows(rows: readonly unknown[], ids: readonly number[]): FoodbankRow[] {
  const mapped = rows.map((r) => mapFoodbankRow(r as Record<string, unknown>));
  const byId = new Map(mapped.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is FoodbankRow => row !== undefined);
}

function attachNeeds(ordered: readonly FoodbankRow[], needsById: Map<number, FoodbankChangeRow>): FoodbankWithLatestNeed[] {
  return ordered.map((row) => ({
    ...row,
    latestNeed: row.latest_need_id === null ? null : (needsById.get(row.latest_need_id) ?? null),
  }));
}

// The rest of getFoodbanksByIds, applied to rows the caller has ALREADY got
// back -- foodbankDetail.ts's batch, which fetches the neighbour rows in a
// wave of its own. Here the need query really is dependent: the rows are in
// hand, so their latest_need_ids are the cheapest thing to ask with. The
// self-fetching path below does not have that constraint.
export async function mapFoodbanksByIds(
  session: Session,
  rows: readonly unknown[],
  ids: readonly number[],
): Promise<FoodbankWithLatestNeed[]> {
  const ordered = orderFoodbankRows(rows, ids);
  const needIds = Array.from(
    new Set(ordered.map((row) => row.latest_need_id).filter((id): id is number => id !== null)),
  );
  return attachNeeds(ordered, await getNeedsByIds(session, needIds));
}

// ONE WAVE, NOT TWO (github #53). This used to read the food bank rows, then
// read their needs -- two sequential round trips, because the need ids are
// columns of the first result. Thirteen call sites paid that, and on the
// search pages it was the difference between five serial waves and three:
// findLocations and findDonationpoints each spend one here, and
// wfbn/index.ts runs them in the same Promise.all, so the page floors on
// whichever is deeper.
//
// getNeedsByFoodbankIds removes the dependency by pushing the id lookup into
// a subquery, so both statements can be issued together. The set of needs is
// identical -- see that function's own note -- and the plan is all
// primary-key lookups, verified on production.
//
// Measured at ~15 ms per D1 round trip from the edge (a single-query endpoint
// returning 791 bytes and one returning 71 KB both render in 14-22 ms, so the
// round trip is the whole cost, not serialisation). ~30 ms off /needs/?lat_lng=
// against a 128-328 ms render, and the same off /api/2/locations/search/.
export async function getFoodbanksByIds(session: Session, ids: readonly number[]): Promise<FoodbankWithLatestNeed[]> {
  if (ids.length === 0) return [];
  const [rowResult, needsById] = await Promise.all([foodbanksByIdsStatement(session, ids).all(), getNeedsByFoodbankIds(session, ids)]);
  return attachNeeds(orderFoodbankRows(rowResult.results, ids), needsById);
}

// gfapi3 `slugfromid` -- projected to just `slug`, matching Django's
// `.only("slug")`.
export async function getFoodbankSlugByUuid(session: Session, uuid: string): Promise<string | null> {
  const row = await session
    .prepare("SELECT slug FROM foodbank WHERE uuid = ?")
    .bind(normalizeUuid(uuid))
    .first<{ slug: string }>();
  return row ? row.slug : null;
}

// WP 6.4: the need-review queue's detail page has `foodbank_id` (a plain
// FK on foodbankchange) and needs the food bank's `slug` for its
// WP-6.3-allowlisted proxy preview link -- same `.only("slug")`-style
// projection as getFoodbankSlugByUuid above, just keyed by the numeric id
// instead of the public uuid.
export async function getFoodbankSlugById(session: Session, id: number): Promise<string | null> {
  const row = await session.prepare("SELECT slug FROM foodbank WHERE id = ?").bind(id).first<{ slug: string }>();
  return row ? row.slug : null;
}

// WP 6.4: the discrepancy-review page's preview iframe needs to know
// whether `discrepancy.url` is actually THIS food bank's own `url` field
// (the only one of WP 6.3's 5 proxyable fields a discrepancy is ever
// about, per that WP's research) before it can safely offer a preview
// through the WP-6.3-allowlisted proxy -- same slug/url pair as
// getFoodbankSlugById, both projected in one query rather than two.
export async function getFoodbankSlugAndUrlById(session: Session, id: number): Promise<{ slug: string; url: string } | null> {
  const row = await session.prepare("SELECT slug, url FROM foodbank WHERE id = ?").bind(id).first<{ slug: string; url: string }>();
  return row ?? null;
}

// gfadmin/views.py:1984-1986 -- need_notifications kicks off an article
// crawl before it notifies anyone, guarded on `if foodbank.rss_url`. It
// has a `need`, so it holds a foodbank_id and not a slug; this is the
// same one-row projection as the two above, with the two fields the
// ARTICLES_Q message needs plus the field the guard reads.
export async function getFoodbankRssCrawlTargetById(
  session: Session,
  id: number,
): Promise<{ id: number; slug: string; rss_url: string | null } | null> {
  const row = await session
    .prepare("SELECT id, slug, rss_url FROM foodbank WHERE id = ?")
    .bind(id)
    .first<{ id: number; slug: string; rss_url: string | null }>();
  return row ?? null;
}

// wfbn-generic `mobsub`/`delete_mobsub` -- the mobile app's shipped
// contract identifies a food bank by `Foodbank.uuid`, not by slug (see
// `get_object_or_404(Foodbank, uuid=foodbank_uuid)` in
// gfwfbn/views.py:1367/1402). Projected to just the numeric `id` the
// `mobilesubscriber` foreign key actually needs, same spirit as
// getFoodbankSlugByUuid's `.only("slug")` above.
export async function getFoodbankIdByUuid(session: Session, uuid: string): Promise<number | null> {
  const row = await session
    .prepare("SELECT id FROM foodbank WHERE uuid = ?")
    .bind(normalizeUuid(uuid))
    .first<{ id: number }>();
  return row ? row.id : null;
}

// wfbn-generic `foodbank_hit` -- existence check only (404 on an unknown
// slug, gfwfbn/views.py:1210-1212); the Workers hit beacon writes to
// Analytics Engine, not D1 (PLAN.md §10.7.3, routes/wfbn/hit.ts), so
// nothing else about the row is ever read here.
export async function getFoodbankIdBySlug(session: Session, slug: string): Promise<number | null> {
  const row = await session.prepare("SELECT id FROM foodbank WHERE slug = ?").bind(slug).first<{ id: number }>();
  return row ? row.id : null;
}

// `ParliamentaryConstituency.foodbank_obj()` -- the food-bank half of
// `constituency.foodbanks()`.
export async function getFoodbanksByConstituencyId(session: Session, constituencyId: number): Promise<FoodbankRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbank WHERE parliamentary_constituency_id = ? AND is_closed = 0")
    .bind(constituencyId)
    .all();
  return result.results.map(mapFoodbankRow);
}

// gfapi2 `donationpoints` -- open food banks with a delivery address,
// surfaced as synthetic donation-point-like features. Matches Django's
// `.exclude(delivery_address__exact='')`: both Postgres and SQLite exclude
// NULL here too (`NULL = ''` is NULL, not true, under either engine's
// three-valued WHERE logic), so no separate `IS NOT NULL` guard is needed.
export async function getOpenFoodbanksWithDeliveryAddress(session: Session): Promise<FoodbankRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbank WHERE is_closed = 0 AND delivery_address != ''")
    .all();
  return result.results.map(mapFoodbankRow);
}

// givefood `country_geojson` (givefood/views.py:285-427) -- the food-bank
// half of a country-scoped feed, same shape as
// `getFoodbanksByConstituencyId` above (`Foodbank.objects.filter(country =
// country_name, is_closed=False)`), just filtered by the denormalised
// `country` column instead of a constituency id.
export async function getFoodbanksByCountry(session: Session, countryName: string): Promise<FoodbankRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbank WHERE country = ? AND is_closed = 0")
    .bind(countryName)
    .all();
  return result.results.map(mapFoodbankRow);
}
