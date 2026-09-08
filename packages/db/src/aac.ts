import type { Session } from "./types";

// givefood/views.py:1522-1580 address_autocomplete() -- PLAN.md §4.8.6/§4.8.7.
// Response shape is frozen/contract: bare array, terse keys, "p"laces
// before "c"odes, max 20 total.
export interface AacResult {
  n: string;
  l: string | null;
  t: "p" | "c";
  c: string | null;
}

const MAX_QUERY_LENGTH = 40; // §4.8.6's 50-byte D1 LIKE/GLOB cap guard
const PLACE_LIMIT = 10;
const POSTCODE_LIMIT = 10;

function mapPlaceRow(raw: Record<string, unknown>): AacResult {
  return { n: raw.name as string, l: raw.lat_lng as string | null, t: "p", c: raw.county as string | null };
}

function mapPostcodeRow(raw: Record<string, unknown>): AacResult {
  return { n: raw.postcode as string, l: raw.lat_lng as string | null, t: "c", c: raw.county as string | null };
}

// Exclusive upper bound for a prefix range scan ('HACKNEY' -> 'HACKNEZ'),
// replacing Postgres's `LIKE 'HACKNEY%'` (§4.8.6/§4.8.7 -- both place and
// postcode prefix matching use this same range-scan shape, not LIKE, so
// neither needs _like_escape()). Works on code points, not UTF-16 code
// units, so it increments the whole trailing character even when that
// character is outside the BMP.
function incrementLastChar(s: string): string {
  const chars = Array.from(s);
  const lastChar = chars.at(-1);
  if (lastChar === undefined) return s;
  const incremented = String.fromCodePoint(lastChar.codePointAt(0)! + 1);
  return chars.slice(0, -1).join("") + incremented;
}

// Bound parameters don't escape FTS5 query-expression syntax (C3):
// `q=king's` is a syntax error, `q=-yn-` reads as a column reference.
// Wrapping the whole query as a quoted FTS5 phrase restores exact
// LIKE-equivalence -- verified against the probe database, §4.8.6(c).
function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

// `, id ASC` IS THE TIE-BREAK THIS ORDERING ALWAYS HAD AND NEVER SAID.
// Django's own `order_by` (views.py:1522-1580) ends at `name`, and on a
// 253,584-row gazetteer that is not a total order. Not because of the NULLs
// the first sort key is about -- production has none, `population` is
// non-NULL in all 253,584 rows -- but because duplicate names carrying the
// same population are everywhere: 18,966 (name, population) pairs occur more
// than once, covering 81,645 rows, a third of the table. Nine places called
// "Yr Allt" in Powys and Ceredigion, four "Kames", seven "D Plantation".
// `population IS NULL, population DESC, name ASC` cannot separate any of
// them -- they are equal on every key the sort can see. Something
// still has to order them, and until 0025_place_prefix_cover.sql that
// something was the access path: the scan walked place_name_upper_idx and
// fetched by rowid, so ties came out in `id` order. The covering index this
// query now uses is ordered (name_upper, population, name, lat_lng, county,
// rowid), so ties would come out in lat_lng order instead -- verified, on a
// fixture of thirty identically-named, identically-populated rows, at both
// LIMIT 10 and LIMIT 400. Naming `id` freezes the answer at what the table
// has been returning all along (also verified: identical rows, before and
// after, on the pre-migration schema) and makes it independent of whichever
// index the planner picks next. `id INTEGER PRIMARY KEY` is the rowid and is
// therefore in every index, so this costs no lookup and the plan stays
// `SEARCH place USING COVERING INDEX place_prefix_cover`.
async function searchPlacePrefix(session: Session, upperQuery: string, limit: number): Promise<AacResult[]> {
  const result = await session
    .prepare(
      "SELECT name, lat_lng, county FROM place " +
        "WHERE name_upper >= ?1 AND name_upper < ?2 " +
        "ORDER BY population IS NULL, population DESC, name ASC, id ASC " +
        "LIMIT ?3",
    )
    .bind(upperQuery, incrementLastChar(upperQuery), limit)
    .all();
  return result.results.map(mapPlaceRow);
}

// Only called when query.length >= 3 -- below that there's nothing for the
// trigram tokenizer to match on (§4.8.6). NOT LIKE excludes pass-1's own
// prefix hits so the two passes never duplicate a result.
//
// `, p.id ASC` for the same reason as searchPlacePrefix above, and NOT
// because this query needs it today. 0025_place_prefix_cover.sql does not
// touch this plan -- the FTS match drives it and `place` is still reached by
// rowid, so the index cannot be chosen here and the rows are measurably
// unmoved by it. But the tie is the same tie, the two passes are
// concatenated into one list, and pinning half of an ordering is worse than
// pinning none of it: the half that was left implicit is the one that moves
// unnoticed. Adding it changes nothing measurable now (verified: byte-
// identical results with and without, at LIMIT 10 and LIMIT 400) -- rowid is
// already the order this join produces.
async function searchPlaceSubstring(session: Session, upperQuery: string, limit: number): Promise<AacResult[]> {
  const result = await session
    .prepare(
      "SELECT p.name, p.lat_lng, p.county FROM place_fts f JOIN place p ON p.id = f.rowid " +
        "WHERE f.name_upper MATCH ?1 AND p.name_upper NOT LIKE ?2 " +
        "ORDER BY p.population IS NULL, p.population DESC, p.name ASC, p.id ASC " +
        "LIMIT ?3",
    )
    .bind(ftsPhrase(upperQuery), `${upperQuery}%`, limit)
    .all();
  return result.results.map(mapPlaceRow);
}

async function searchPostcodes(session: Session, normalizedQuery: string, limit: number): Promise<AacResult[]> {
  const result = await session
    .prepare("SELECT postcode, lat_lng, county FROM postcode WHERE pcn >= ?1 AND pcn < ?2 ORDER BY pcn LIMIT ?3")
    .bind(normalizedQuery, incrementLastChar(normalizedQuery), limit)
    .all();
  return result.results.map(mapPostcodeRow);
}

// Django runs these three queries sequentially, each guarded by
// `if len(results) < N` -- an artifact of one synchronous DB connection
// per request, not a real dependency between them. Tracing the guards:
// place results never exceed PLACE_LIMIT (pass 1 is capped at 10, pass 2
// fills only to `10 - len(results)`), so the postcode guard
// `len(results) < 20` is always true and its own limit,
// `min(10, 20 - len(results))`, is always exactly 10 regardless of how
// many place results came back. All three queries are therefore
// independent in practice, not just in principle, and can run concurrently
// with no wasted work and no change to the combined, truncated result.
export async function searchAddressAutocomplete(session: Session, rawQuery: string): Promise<AacResult[]> {
  const query = rawQuery.trim();
  if (query.length < 2 || query.length > MAX_QUERY_LENGTH) return [];

  const upperQuery = query.toUpperCase();
  const normalizedPostcode = upperQuery.replace(/ /g, "");

  const [prefixRows, substringRows, postcodeRows] = await Promise.all([
    searchPlacePrefix(session, upperQuery, PLACE_LIMIT),
    query.length >= 3 ? searchPlaceSubstring(session, upperQuery, PLACE_LIMIT) : Promise.resolve<AacResult[]>([]),
    searchPostcodes(session, normalizedPostcode, POSTCODE_LIMIT),
  ]);

  const places = [...prefixRows, ...substringRows].slice(0, PLACE_LIMIT);
  return [...places, ...postcodeRows.slice(0, POSTCODE_LIMIT)];
}

// ===================== speculative next-character results =================
// Ticket #8, the technique from ruurtjan.com's "p99 0ms autocomplete for 240
// million domain names": as well as the results for what has been typed,
// fetch the results for that prefix PLUS each character that might be typed
// next, so the next keystroke renders from memory instead of waiting for a
// round trip -- measured at 110-550ms against the live endpoint, which is
// essentially the whole perceived latency of this control.
//
// DELIBERATELY A SEPARATE REQUEST from searchAddressAutocomplete(), not a
// richer version of it. The first shape tried returned results and buckets
// together, which is worse in exactly the place it matters: the buckets are
// speculative and perhaps 10 KB, so bundling them puts a deep read and a
// large serialisation IN FRONT of the answer the user is actually waiting
// for. Split, the critical path keeps its ten-row limits and its ~750-byte
// payload untouched, the two responses cache independently, and this one's
// latency stops mattering because nothing is blocked on it.
//
// COMPUTED FROM ONE DEEPER READ, NOT ONE QUERY PER CHARACTER. Every result
// for "LOND" is by definition already in the result set for "LON", so the
// same three queries run once with a much larger LIMIT and the rows are
// bucketed in JS by whichever character follows the prefix. Thirty-odd
// candidate next characters therefore cost no extra round trips to D1.
//
// THE BUCKETS ARE A HINT, NOT AN ANSWER. The client still issues the real
// request and replaces what it drew. Two known ways a bucket can be thinner
// than the real response, both harmless because of that:
//
//   1. At a 2-character prefix the substring pass has not run (the trigram
//      index cannot be consulted below 3 characters -- see
//      searchPlaceSubstring), so those buckets carry prefix and postcode
//      matches only.
//   2. A bucket whose rows all sat beyond DEEP_LIMIT is empty rather than
//      wrong; the client then just waits for the real response, which is the
//      behaviour it had before this existed.
const DEEP_LIMIT = 400;
const NEXT_BUCKET_LIMIT = 8;
const MAX_NEXT_BUCKETS = 40;

// Every character that follows `prefix` in `haystack`, at any position. A
// place name can contain the prefix more than once ("Weston super Weston"),
// and the substring pass would match it for either continuation, so all of
// them are collected rather than just the first.
function nextCharsAfter(haystack: string, prefix: string): string[] {
  const chars: string[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(prefix, from);
    if (at === -1) break;
    const nextChar = haystack[at + prefix.length];
    if (nextChar) chars.push(nextChar);
    from = at + 1;
  }
  return chars;
}

function addToBucket(buckets: Map<string, AacResult[]>, key: string, row: AacResult): void {
  const bucket = buckets.get(key);
  if (bucket) {
    if (bucket.length < NEXT_BUCKET_LIMIT && !bucket.includes(row)) bucket.push(row);
    return;
  }
  if (buckets.size >= MAX_NEXT_BUCKETS) return;
  buckets.set(key, [row]);
}

export async function searchAddressAutocompleteNext(
  session: Session,
  rawQuery: string,
): Promise<Record<string, AacResult[]>> {
  const query = rawQuery.trim();
  if (query.length < 2 || query.length > MAX_QUERY_LENGTH) return {};

  const upperQuery = query.toUpperCase();
  const normalizedPostcode = upperQuery.replace(/ /g, "");

  const [prefixRows, substringRows, postcodeRows] = await Promise.all([
    searchPlacePrefix(session, upperQuery, DEEP_LIMIT),
    query.length >= 3 ? searchPlaceSubstring(session, upperQuery, DEEP_LIMIT) : Promise.resolve<AacResult[]>([]),
    searchPostcodes(session, normalizedPostcode, DEEP_LIMIT),
  ]);

  // Keyed on the UPPERCASED character the user would type next, because
  // that is what the client has to look it up with; place rows are matched
  // against the upper-cased name for the same reason.
  const placeBuckets = new Map<string, AacResult[]>();
  for (const row of prefixRows) {
    const nextChar = row.n.toUpperCase()[upperQuery.length];
    if (nextChar) addToBucket(placeBuckets, nextChar, row);
  }
  for (const row of substringRows) {
    for (const nextChar of nextCharsAfter(row.n.toUpperCase(), upperQuery)) {
      addToBucket(placeBuckets, nextChar, row);
    }
  }

  // Postcode buckets are skipped when the query contains a space: the
  // postcode index is searched on the space-stripped form, so the character
  // following the prefix THERE is not the character the user types next.
  // Rather than guess, the postcode half of those buckets is omitted and the
  // real request supplies it.
  const postcodeBuckets = new Map<string, AacResult[]>();
  if (upperQuery === normalizedPostcode) {
    for (const row of postcodeRows) {
      const nextChar = row.n.replace(/ /g, "")[normalizedPostcode.length];
      if (nextChar) addToBucket(postcodeBuckets, nextChar, row);
    }
  }

  // Same ordering contract as the real response: places first, then codes.
  const next: Record<string, AacResult[]> = {};
  for (const key of new Set([...placeBuckets.keys(), ...postcodeBuckets.keys()])) {
    const merged = [...(placeBuckets.get(key) ?? []), ...(postcodeBuckets.get(key) ?? [])];
    if (merged.length) next[key] = merged.slice(0, NEXT_BUCKET_LIMIT);
  }
  return next;
}
