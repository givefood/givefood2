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

export async function getConstituencyBySlug(session: Session, slug: string): Promise<ConstituencyRow | null> {
  const row = await session.prepare("SELECT * FROM parliamentaryconstituency WHERE slug = ?").bind(slug).first();
  return row ? mapConstituencyRow(row as Record<string, unknown>) : null;
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
