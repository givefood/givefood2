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

async function searchPlacePrefix(session: Session, upperQuery: string, limit: number): Promise<AacResult[]> {
  const result = await session
    .prepare(
      "SELECT name, lat_lng, county FROM place " +
        "WHERE name_upper >= ?1 AND name_upper < ?2 " +
        "ORDER BY population IS NULL, population DESC, name ASC " +
        "LIMIT ?3",
    )
    .bind(upperQuery, incrementLastChar(upperQuery), limit)
    .all();
  return result.results.map(mapPlaceRow);
}

// Only called when query.length >= 3 -- below that there's nothing for the
// trigram tokenizer to match on (§4.8.6). NOT LIKE excludes pass-1's own
// prefix hits so the two passes never duplicate a result.
async function searchPlaceSubstring(session: Session, upperQuery: string, limit: number): Promise<AacResult[]> {
  const result = await session
    .prepare(
      "SELECT p.name, p.lat_lng, p.county FROM place_fts f JOIN place p ON p.id = f.rowid " +
        "WHERE f.name_upper MATCH ?1 AND p.name_upper NOT LIKE ?2 " +
        "ORDER BY p.population IS NULL, p.population DESC, p.name ASC " +
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
