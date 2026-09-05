import type { Session } from "./types";

// gfadmin/views.py:340-358 foodbanks_dupe_postcodes -- postcodes shared by
// more than one food bank or location. A data-quality screen; the only
// inbound link is the "Geo" block of gfadmin/templates/admin/settings.html:53
// (already ported as settings.njk's own /admin/foodbanks/dupe_postcodes/
// link).
//
// get_all_foodbanks() / get_all_locations() (givefood/utils/cache.py:37,:59)
// are the UNFILTERED querysets -- `Foodbank.objects.all()` and
// `FoodbankLocation.objects.all()`, not their get_all_open_* siblings -- so
// CLOSED rows are included here too, matching Django exactly.
// FoodbankDonationPoint is NOT consulted: the Django view never looks at it
// and including it would change the answer.
//
// Django computes this with `postcodes.count(x)` inside a comprehension
// (views.py:353) -- a full list scan per element, so O(n^2) over ~3,043
// entries (~1,071 food banks + ~1,972 locations), which is the only reason
// that view leans on cache.py's 1-hour memcache at all. GROUP BY ... HAVING
// does it in one pass. PLAN.md:10763 deferred this page saying it "needs a
// full-table 1-hour-cache utility not built" -- that reason does not apply:
// no cache utility is required here and none should be built for it.
//
// Deliberately NOT adding an index on either postcode column. This page is
// reached rarely, from one settings link; the two scans below are ~6k rows
// total, while an index would cost write time on every food bank and every
// location save forever.

export interface DupePostcodePlace {
  postcode: string;
  kind: "foodbank" | "location";
  name: string;
  foodbank_name: string;
  foodbank_slug: string;
  loc_slug: string | null;
  is_closed: number;
}

export interface DupePostcodeGroup {
  postcode: string;
  places: DupePostcodePlace[];
}

export interface DupePostcodeResult {
  groups: DupePostcodeGroup[];
  // True when more duplicated postcodes exist than `limit`. Django renders
  // every one into a single unbounded <ul>; D1 meters rows scanned
  // (PLAN.md §4.3), and this page's row count is driven entirely by data
  // quality, so it gets a ceiling rather than an unbounded render. In
  // practice the real figure is far below the default limit -- the flag
  // exists so a pathological import can never silently blow the page up.
  truncated: boolean;
  limit: number;
}

const DEFAULT_DUPE_POSTCODE_LIMIT = 500;

export async function getDuplicatePostcodes(
  session: Session,
  limit: number = DEFAULT_DUPE_POSTCODE_LIMIT,
): Promise<DupePostcodeResult> {
  // Fetch one postcode more than asked for, purely to learn whether there
  // are more -- cheaper than a second full scan just to COUNT them.
  const probeLimit = limit + 1;

  // Two deliberate fixes over Django, neither changing which postcodes are
  // considered duplicates of each other:
  //
  //  - NULL and empty postcodes are excluded. foodbanklocation.postcode is
  //    nullable (0001_core.sql:63) and in Python `None` satisfies
  //    `postcodes.count(None) > 1`, so two location rows with no postcode
  //    put a literal "None" entry in Django's list, linking to `?q=None`.
  //  - Deterministic ordering. Django renders a `set()`, so identical data
  //    comes out in a different order between requests (views.py:353).
  //
  // The comparison itself stays an exact raw-string match exactly like
  // Django's: no upper-casing, no space-stripping, so "SW1A 1AA" and
  // "SW1A1AA" remain two different postcodes. Normalising would be a
  // behaviour change, not a bug fix -- and this page exists precisely to
  // surface data entered inconsistently.
  //
  // ORDER BY here is SQLite's byte-wise collation rather than the JS
  // collator sortByName() uses elsewhere in this package (see types.ts's
  // note): the outer sort key is a postcode (uppercase alphanumerics, where
  // the two orders agree), and the inner name sort only ever orders the two
  // or three rows that share one postcode.
  const sql = `
    WITH places AS (
      SELECT postcode, 'foodbank' AS kind, name, name AS foodbank_name,
             slug AS foodbank_slug, NULL AS loc_slug, is_closed
        FROM foodbank
       WHERE postcode IS NOT NULL AND TRIM(postcode) <> ''
      UNION ALL
      SELECT postcode, 'location' AS kind, name, foodbank_name,
             foodbank_slug, slug AS loc_slug, is_closed
        FROM foodbanklocation_full
       WHERE postcode IS NOT NULL AND TRIM(postcode) <> ''
    ),
    dupes AS (
      SELECT postcode FROM places GROUP BY postcode HAVING COUNT(*) > 1
       ORDER BY postcode LIMIT ?
    )
    SELECT p.postcode, p.kind, p.name, p.foodbank_name, p.foodbank_slug, p.loc_slug, p.is_closed
      FROM places p JOIN dupes d ON d.postcode = p.postcode
     ORDER BY p.postcode, p.kind, p.name
  `;

  const { results } = await session.prepare(sql).bind(probeLimit).all<DupePostcodePlace>();

  const groups: DupePostcodeGroup[] = [];
  for (const row of results) {
    const last = groups[groups.length - 1];
    if (last && last.postcode === row.postcode) last.places.push(row);
    else groups.push({ postcode: row.postcode, places: [row] });
  }

  const truncated = groups.length > limit;
  if (truncated) groups.length = limit;

  return { groups, truncated, limit };
}
