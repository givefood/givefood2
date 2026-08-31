import type { Session } from "./types";
import { getFoodbanksByConstituencyId, type FoodbankRow } from "./foodbank";
import { getOpenLocationsByConstituencyId, type FoodbankLocationRow } from "./locations";

export interface ConstituencyRow {
  id: number;
  name: string | null;
  slug: string;
  country: string | null;
  mp: string | null;
  mp_party: string | null;
  mp_parl_id: number;
  mp_display_name: string | null;
  email: string | null;
  centroid: string; // "lat,lng" -- the ACTUAL source of latt()/long(), not the latitude/longitude columns below
  latitude: number | null; // vestigial, 646/650 NULL in production -- do not use for anything read-time
  longitude: number | null; // same
  boundary_geojson: string | null;
}

function mapConstituencyRow(raw: Record<string, unknown>): ConstituencyRow {
  return raw as unknown as ConstituencyRow;
}

// gfapi2 `constituencies` -- deliberately unfiltered and unordered, matching
// `ParliamentaryConstituency.objects.all()` with no `.order_by()` (this view
// bypasses the cached `get_all_constituencies()` helper other call sites
// use; see PLAN.md §7.2). Row order is whatever D1 returns, not guaranteed.
export async function getAllConstituencies(session: Session): Promise<ConstituencyRow[]> {
  const result = await session.prepare("SELECT * FROM parliamentaryconstituency").all();
  return result.results.map((r) => mapConstituencyRow(r as Record<string, unknown>));
}

// sitemap.xml only ever needs the slug -- PLAN.md's hard rule ("nothing in
// the codebase issues SELECT * on parliamentaryconstituency or
// foodbanklocation") exists specifically because boundary_geojson can run
// to ~1.6 MB for the largest constituencies; getAllConstituencies() above
// would pull all 650 of those blobs just to read .slug off each row.
export async function getAllConstituencySlugs(session: Session): Promise<string[]> {
  const result = await session.prepare("SELECT slug FROM parliamentaryconstituency").all();
  return result.results.map((r) => (r as { slug: string }).slug);
}

// sitemap.md's variant of the above -- same narrow-column reasoning, plus
// `name` for the link text (the XML sitemap has no link text, only <loc>).
export async function getAllConstituencySlugsWithNames(session: Session): Promise<Array<{ slug: string; name: string }>> {
  const result = await session.prepare("SELECT slug, name FROM parliamentaryconstituency").all();
  return result.results as unknown as Array<{ slug: string; name: string }>;
}

// `get_all_constituencies()` (givefood/utils/cache.py:138-146) --
// `.defer("boundary_geojson").order_by("name")`. Narrow (see the hard-rule
// comment on getAllConstituencySlugs above): the index page's country
// grouping and the nearby-constituency haversine search (constituency.ts)
// both need every row's name/slug/country/centroid, never boundary_geojson.
export interface ConstituencyListRow {
  name: string | null;
  slug: string;
  country: string | null;
  centroid: string;
}
export async function getAllConstituenciesOrderedByName(session: Session): Promise<ConstituencyListRow[]> {
  const result = await session.prepare("SELECT name, slug, country, centroid FROM parliamentaryconstituency ORDER BY name").all();
  return result.results as unknown as ConstituencyListRow[];
}

export async function getConstituencyBySlug(session: Session, slug: string): Promise<ConstituencyRow | null> {
  const row = await session.prepare("SELECT * FROM parliamentaryconstituency WHERE slug = ?").bind(slug).first();
  return row ? mapConstituencyRow(row as Record<string, unknown>) : null;
}

// The constituency detail page and the MP-photo redirect (wfbn/constituencies.ts)
// use everything on ConstituencyRow EXCEPT boundary_geojson (that page's own
// geojson feed is served by a separate route) -- PLAN.md's hard rule again,
// same reasoning as getAllConstituencySlugs above. Narrower than
// getConstituencyBySlug, which stays as-is for the one caller that
// genuinely needs the blob (the geojson feed).
export type ConstituencyRowNarrow = Omit<ConstituencyRow, "boundary_geojson">;
export async function getConstituencyBySlugNarrow(session: Session, slug: string): Promise<ConstituencyRowNarrow | null> {
  const row = await session
    .prepare("SELECT id, name, slug, country, mp, mp_party, mp_parl_id, mp_display_name, email, centroid, latitude, longitude FROM parliamentaryconstituency WHERE slug = ?")
    .bind(slug)
    .first();
  return row ? (row as unknown as ConstituencyRowNarrow) : null;
}

// `ParliamentaryConstituency.foodbanks()` -- concatenates the food-bank
// list and the location list, in that order, with neither sub-list sorted.
// This is deliberate (frozen bug B3, PLAN.md §7.3): a location entry's
// `slug` gets used to build a `/api/2/foodbank/<slug>/` URL by the handler
// layer without checking it's actually a food bank slug, which 404s. This
// function only returns the two raw lists; reproducing B3 is the caller's
// job, done by not validating which list an entry came from.
export async function getFoodbanksForConstituency(
  session: Session,
  constituencyId: number,
): Promise<{ foodbanks: FoodbankRow[]; locations: FoodbankLocationRow[] }> {
  const [foodbanks, locations] = await Promise.all([
    getFoodbanksByConstituencyId(session, constituencyId),
    getOpenLocationsByConstituencyId(session, constituencyId),
  ]);
  return { foodbanks, locations };
}
