import { sortByName, type Session } from "./types";

// gfadmin/views.py:111-231 search_results() -- the cross-model admin search
// box, reachable from the navbar on every admin page (gfadmin/templates/
// admin/page.html:45-50, ported to admin/page.njk:54-56). Eight substring
// searches over six result groups, run as one D1 batch.
//
// Django's `__icontains` compiles, on its Postgres backend, to
// `UPPER(col::text) LIKE UPPER(%s)` with the parameter escaped by
// BaseDatabaseOperations.prep_for_like_query (`\` -> `\\`, `%` -> `\%`,
// `_` -> `\_`), relying on Postgres's DEFAULT backslash LIKE escape
// character. SQLite has NO default escape character, so every LIKE below
// spells out `ESCAPE '\'` explicitly -- without it the `\%` and `\_` this
// module produces would be matched literally and a query containing `%`
// would still behave as a wildcard.
//
// No FTS5 here, deliberately, unlike aac.ts: FTS5's unicode61 tokenizer is
// word matching, not substring matching, so it would silently change the
// result set in both directions, and the substring-equivalent `trigram`
// tokenizer carries a 3-character floor plus the query-expression escaping
// hazards PLAN.md §4.8.6 documents. Five of the six groups scan tiny tables
// (foodbank 1,071 rows, parliamentaryconstituency 650, foodbanklocation
// 1,972, foodbankdonationpoint 5,744, and the three subscriber tables);
// only foodbankchange (33,931 rows) is large, and this is an admin-only
// page used by one or two signed-in people at human frequency, not /aac/,
// which is public and hit on every keystroke.

const RESULT_LIMIT = 100; // Django's per-group [:100] slice, verbatim

// F3: a minimum query length Django doesn't have. A single-character query
// scans every one of these tables -- including the 29.4 MB foodbankchange
// (PLAN.md §7.1) -- to return 600 rows of noise. Same floor aac.ts:96 uses.
// Exported so the route can tell the "too short" guard state apart from the
// over-length one without restating the number.
export const ADMIN_SEARCH_MIN_QUERY_LENGTH = 2;

// F4: D1 caps LIKE/GLOB patterns at 50 BYTES, with no Postgres equivalent;
// PLAN.md line 10198 names "the admin search box" by name as needing this
// guard, and a 51-character query throws without it. Measured on the FINAL
// ESCAPED pattern in UTF-8 bytes, not on the raw character count: escaping
// can nearly double the string (`%%%%` -> `\%\%\%\%`) and a multi-byte
// character is several bytes on its own.
const MAX_PATTERN_BYTES = 50;

// The cap is real; REFUSING the search over it was not the right answer to
// it. Django puts no length limit on `q` at all, and seven of the twelve
// columns views.py:117-129 searches are URLs -- plus
// WebPushSubscription.endpoint at views.py:206-207 -- i.e. fields whose
// values are long BY CONSTRUCTION. Pasting a food bank's shopping-list URL
// (55 characters) or a push endpoint (always well past the 48-character
// ceiling the two `%` wrappers leave) is an ordinary thing to do on this
// page, and it used to answer "That search is too long, try something
// shorter" for a query Django searches fine.
//
// So an over-cap query switches from LIKE to instr(), which has NO pattern
// length limit and is exactly equivalent here: SQLite's LIKE folds ASCII
// case on both sides, which is precisely what instr() over lower() does,
// and instr() takes its needle literally so `%`/`_`/`\` need no escaping.
// LIKE is kept for the common short query rather than replaced outright,
// because instr(lower(col), ...) materialises a lower() copy of every value
// it scans and foodbankchange is 29.4 MB over 33,931 rows (PLAN.md §7.1).
type MatchMode = "like" | "instr";

// Nothing in D1 needs this -- instr() has no pattern limit. It exists so a
// pathological paste (a whole document into the search box) still lands on
// the page's existing "too long" message instead of being scanned for, and
// it sits far beyond any real value: the longest thing anyone legitimately
// searches here is a push endpoint, ~190 characters.
const MAX_QUERY_LENGTH = 500;

// Django's BaseDatabaseOperations.prep_for_like_query, which is what
// `__icontains` runs its parameter through before handing it to the
// database. Sibling of aac.ts's ftsPhrase(). LIKE mode only: instr() has no
// pattern syntax to escape.
function escapeLike(q: string): string {
  return q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// SQLite's lower() is ASCII-only, and so is the case folding its LIKE does.
// A JS toLowerCase() needle would fold "Ä" to "ä" and then fail to find the
// "Ä" that LIKE would have matched, so instr mode folds the same ASCII
// range the database does and nothing else.
function asciiLower(q: string): string {
  return q.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

// `?1` is the substring test in both modes: a `%...%` pattern for LIKE, the
// bare needle for instr.
function containsSql(column: string, mode: MatchMode): string {
  return mode === "like" ? `${column} LIKE ?1 ESCAPE '\\'` : `instr(lower(${column}), ?1) > 0`;
}

// One test per column, OR'd -- the shape a Django
// `Q(a__icontains=q) | Q(b__icontains=q)` chain produces.
function containsAnyOf(columns: readonly string[], mode: MatchMode): string {
  return columns.map((column) => containsSql(column, mode)).join(" OR ");
}

// `?3`, the food bank ranking's prefix test. Same two modes.
function startsWithSql(column: string, mode: MatchMode): string {
  return mode === "like" ? `${column} LIKE ?3 ESCAPE '\\'` : `instr(lower(${column}), ?3) = 1`;
}

// gfadmin/views.py:118-129's twelve fields, in source order, plus alt_name.
//
// F10, the one place this page's result set intentionally differs from
// production: `alt_name` (the Welsh/alternative name, 0001_core.sql:13) is
// stored and displayed throughout the site but is NOT searchable in Django,
// so a Welsh-language name currently finds nothing on a site that serves
// Welsh as a first-class language. Added as a deliberate 13th field. Every
// other field list below is byte-for-byte Django's -- notably still absent
// here, because Django doesn't search them either: network, network_id,
// charity_number, contact_email, phone_number, notes, facebook_page, fsa_id.
const FOODBANK_SEARCH_COLUMNS = [
  "slug",
  "name",
  "alt_name",
  "address",
  "postcode",
  "url",
  "shopping_list_url",
  "rss_url",
  "news_url",
  "donation_points_url",
  "locations_url",
  "contacts_url",
  "charity_name",
] as const;

const LOCATION_SEARCH_COLUMNS = ["slug", "name", "address", "postcode"] as const;

// NO slug clause: Django searches slug on locations but not on donation
// points (views.py:132-143). The asymmetry is real and preserved.
const DONATION_POINT_SEARCH_COLUMNS = ["name", "address", "postcode"] as const;

const CONSTITUENCY_SEARCH_COLUMNS = ["name", "mp"] as const;

const NEED_SEARCH_COLUMNS = ["change_text", "excess_change_text"] as const;

export interface SearchFoodbankResult {
  name: string;
  slug: string;
  is_closed: number;
}

export interface SearchChildResult {
  name: string;
  slug: string;
  foodbank_name: string;
  foodbank_slug: string;
  is_closed: number;
}

export interface SearchConstituencyResult {
  name: string | null;
  slug: string;
}

export interface SearchNeedResult {
  need_id: string;
  need_id_short: string;
  foodbank_name: string | null;
  modified: string;
}

export interface SearchSubscriptionResult {
  type: "email" | "mobile" | "webpush";
  // The mdi icon NAME, not markup. Django puts raw HTML in the context dict
  // (views.py:167) and the template renders it through `|safe`; passing a
  // whitelisted name and letting the template build the <span> keeps
  // autoescaping on for every field on the page (F8).
  icon: string;
  identifier: string;
  foodbank_name: string;
  foodbank_slug: string;
}

export interface AdminSearchResults {
  foodbanks: SearchFoodbankResult[];
  locations: SearchChildResult[];
  donationpoints: SearchChildResult[];
  constituencies: SearchConstituencyResult[];
  needs: SearchNeedResult[];
  subscriptions: SearchSubscriptionResult[];
  total: number;
}

// `match_rank` exists only to order the food bank group; it never reaches
// the template.
interface FoodbankSearchRow extends SearchFoodbankResult {
  match_rank: number;
}

interface SubscriptionSearchRow {
  identifier: string;
  foodbank_name: string;
  foodbank_slug: string;
}

interface NeedSearchRow {
  need_id: string;
  foodbank_name: string | null;
  modified: string;
}

function rowsOf<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as unknown as T[];
}

// F6: D1's byte-wise ORDER BY reorders mixed-case names against
// production's en_US.utf8 -- types.ts:28-37 is explicit that JS collator
// sorting is this codebase's answer. The SQL ORDER BY still does real work:
// it decides WHICH 100 rows survive the LIMIT, deterministically. These
// re-sorts only fix the display order of those 100.
//
// Array.prototype.sort is stable, so sorting by name first and then by the
// numeric keys leaves names in collator order within each band, without
// needing a second Intl.Collator instance here.
function sortFoodbanks(rows: FoodbankSearchRow[]): SearchFoodbankResult[] {
  return sortByName(rows)
    .sort((a, b) => a.match_rank - b.match_rank || a.is_closed - b.is_closed)
    .map(({ name, slug, is_closed }) => ({ name, slug, is_closed }));
}

function sortChildren(rows: SearchChildResult[]): SearchChildResult[] {
  return sortByName(rows).sort((a, b) => a.is_closed - b.is_closed);
}

// sortByName needs a non-null `name`; parliamentaryconstituency.name is
// nullable (0001_core.sql:131), so sort a projection and unwrap it rather
// than coalescing the value that gets displayed.
function sortConstituencies(rows: SearchConstituencyResult[]): SearchConstituencyResult[] {
  return sortByName(rows.map((row) => ({ name: row.name ?? row.slug, row }))).map((wrapper) => wrapper.row);
}

function mapSubscriptions(
  rows: SubscriptionSearchRow[],
  type: SearchSubscriptionResult["type"],
  icon: string,
): SearchSubscriptionResult[] {
  return rows.map((row) => ({ type, icon, identifier: row.identifier, foodbank_name: row.foodbank_name, foodbank_slug: row.foodbank_slug }));
}

// Returns null when the query is unusable -- shorter than MIN_QUERY_LENGTH,
// or past MAX_QUERY_LENGTH -- so the route can render the guard state
// without touching D1 at all. An over-50-byte pattern is NOT unusable: it
// runs in instr mode.
export async function searchAdmin(session: Session, rawQuery: string): Promise<AdminSearchResults | null> {
  const query = rawQuery.trim();
  if (query.length < ADMIN_SEARCH_MIN_QUERY_LENGTH) return null;
  if (query.length > MAX_QUERY_LENGTH) return null;

  const likePattern = `%${escapeLike(query)}%`;
  const mode: MatchMode = new TextEncoder().encode(likePattern).length > MAX_PATTERN_BYTES ? "instr" : "like";
  const needle = asciiLower(query);

  // ?2/?3 feed the food bank relevance ranking only. slug is lowercase by
  // construction (Foodbank.slug is slugify(name), foodbank.py:634), and
  // SQLite's lower() is ASCII-only, which is the same folding its LIKE
  // already does. ?3's LIKE pattern is one byte SHORTER than ?1's, so it
  // can never overflow the cap on its own.
  const contains = mode === "like" ? likePattern : needle;
  const exact = query.toLowerCase();
  const prefix = mode === "like" ? `${escapeLike(query)}%` : needle;

  // One round trip for all eight statements -- the established read pattern
  // (foodbankDetail.ts:18-26). Every one of these is a full table scan by
  // construction: a leading-wildcard LIKE cannot use an index, which is
  // equally true of the Postgres original, so no index would help here.
  const results = await session.batch([
    // 1. FOOD BANKS -- gfadmin/views.py:117-130.
    // F5: Django has NO order_by, so which 100 of 1,071 rows its [:100]
    // slice returns is plan-dependent and can change between runs. Ranked
    // here instead: exact slug/name match, then prefix match, then the
    // rest, open before closed within each band.
    session
      .prepare(
        `SELECT name, slug, is_closed,
                CASE WHEN slug = ?2 OR lower(name) = ?2 THEN 0
                     WHEN ${startsWithSql("slug", mode)} OR ${startsWithSql("name", mode)} THEN 1
                     ELSE 2 END AS match_rank
         FROM foodbank
         WHERE ${containsAnyOf(FOODBANK_SEARCH_COLUMNS, mode)}
         ORDER BY match_rank, is_closed, name
         LIMIT ${RESULT_LIMIT}`,
      )
      .bind(contains, exact, prefix),

    // 2. LOCATIONS -- gfadmin/views.py:132-137. No is_closed filter (closed
    // rows DO appear, same as Django); the denormalised foodbank_name/
    // foodbank_slug columns mean no join and no N+1.
    session
      .prepare(
        `SELECT name, slug, foodbank_name, foodbank_slug, is_closed
         FROM foodbanklocation_full
         WHERE ${containsAnyOf(LOCATION_SEARCH_COLUMNS, mode)}
         ORDER BY is_closed, foodbank_name, name
         LIMIT ${RESULT_LIMIT}`,
      )
      .bind(contains),

    // 3. DONATION POINTS -- gfadmin/views.py:139-143.
    session
      .prepare(
        `SELECT name, slug, foodbank_name, foodbank_slug, is_closed
         FROM foodbankdonationpoint_full
         WHERE ${containsAnyOf(DONATION_POINT_SEARCH_COLUMNS, mode)}
         ORDER BY is_closed, foodbank_name, name
         LIMIT ${RESULT_LIMIT}`,
      )
      .bind(contains),

    // 4. CONSTITUENCIES -- gfadmin/views.py:145-148. F9: explicit column
    // list, never SELECT * -- boundary_geojson runs to 1,568 kB per row
    // (PLAN.md §4.6), the same reason adminLists.ts:149-152 names its
    // columns on this table. `mp` is searched but never displayed, exactly
    // as in Django. `name` is nullable, hence the NULLs-last guard.
    session
      .prepare(
        `SELECT name, slug
         FROM parliamentaryconstituency
         WHERE ${containsAnyOf(CONSTITUENCY_SEARCH_COLUMNS, mode)}
         ORDER BY (name IS NULL), name
         LIMIT ${RESULT_LIMIT}`,
      )
      .bind(contains),

    // 5. NEEDS -- gfadmin/views.py:150-153. The only group Django orders,
    // and it orders by -created while the template displays `modified`;
    // both kept. No published/nonpertinent filter, so unpublished and
    // non-pertinent needs are returned, same as Django. F9 again: the four
    // large text columns are what make this table 29.4 MB across 33,931
    // rows (PLAN.md §7.1) and nothing on the page renders them.
    session
      .prepare(
        `SELECT need_id, foodbank_name, modified
         FROM foodbankchange
         WHERE ${containsAnyOf(NEED_SEARCH_COLUMNS, mode)}
         ORDER BY created DESC
         LIMIT ${RESULT_LIMIT}`,
      )
      .bind(contains),

    // 6. EMAIL SUBSCRIPTIONS -- gfadmin/views.py:159-172, confirmed only.
    // F7: the food bank slug comes from a JOIN, not from
    // FoodbankSubscriber.foodbank_slug(), which is slugify() over a
    // denormalised name column (subscribers.py:34-35) and so only agrees
    // with the real slug while that copy is current. adminLists.ts:347-348
    // already joins for the same reason.
    session
      .prepare(
        `SELECT s.email AS identifier, f.name AS foodbank_name, f.slug AS foodbank_slug
         FROM foodbanksubscriber s JOIN foodbank f ON f.id = s.foodbank_id
         WHERE s.confirmed = 1 AND ${containsSql("s.email", mode)}
         ORDER BY s.created DESC
         LIMIT ${RESULT_LIMIT}`,
      )
      .bind(contains),

    // 7. MOBILE SUBSCRIPTIONS -- gfadmin/views.py:190-203. SQLite's
    // length()/substr() count CHARACTERS, matching Python's len()/[:20] at
    // views.py:195; the "..." suffix and the >20 conditional are both
    // Django's. (adminLists.ts:353's own substr() drops the ellipsis -- a
    // pre-existing cosmetic divergence on a different page; Django is
    // matched here.) MobileSubscriber has no denormalised name column, so
    // the join is Django's select_related, not a fix.
    session
      .prepare(
        `SELECT (s.platform || ' - ' ||
                 CASE WHEN length(s.device_id) > 20 THEN substr(s.device_id, 1, 20) || '...' ELSE s.device_id END) AS identifier,
                f.name AS foodbank_name, f.slug AS foodbank_slug
         FROM mobilesubscriber s JOIN foodbank f ON f.id = s.foodbank_id
         WHERE ${containsSql("s.device_id", mode)}
         ORDER BY s.created DESC
         LIMIT ${RESULT_LIMIT}`,
      )
      .bind(contains),

    // 8. WEBPUSH SUBSCRIPTIONS -- gfadmin/views.py:206-219. `sub.browser or
    // 'Unknown'` (views.py:215) is Python truthiness, so an EMPTY STRING is
    // also 'Unknown' -- a bare COALESCE would not be, hence the CASE.
    session
      .prepare(
        `SELECT (CASE WHEN s.browser IS NULL OR s.browser = '' THEN 'Unknown' ELSE s.browser END || ' - ' ||
                 CASE WHEN length(s.endpoint) > 30 THEN substr(s.endpoint, 1, 30) || '...' ELSE s.endpoint END) AS identifier,
                f.name AS foodbank_name, f.slug AS foodbank_slug
         FROM webpushsubscription s JOIN foodbank f ON f.id = s.foodbank_id
         WHERE ${containsSql("s.endpoint", mode)}
         ORDER BY s.created DESC
         LIMIT ${RESULT_LIMIT}`,
      )
      .bind(contains),

    // gfadmin/views.py:175-187's WhatsappSubscriber branch is NOT built: no
    // `whatsappsubscriber` table exists in D1 -- the same gap
    // adminLists.ts:328 already discloses for getSubscriptionsPage. If that
    // table ever lands, add
    //   SELECT s.phone_number AS identifier, f.name AS foodbank_name, f.slug AS foodbank_slug
    //   FROM whatsappsubscriber s JOIN foodbank f ON f.id = s.foodbank_id
    //   WHERE ${containsSql("s.phone_number", mode)} ORDER BY s.created DESC LIMIT 100
    // and splice it into `subscriptions` between email and mobile, matching
    // Django's own append order.
  ]);

  const foodbanks = sortFoodbanks(rowsOf<FoodbankSearchRow>(results[0]));
  const locations = sortChildren(rowsOf<SearchChildResult>(results[1]));
  const donationpoints = sortChildren(rowsOf<SearchChildResult>(results[2]));
  const constituencies = sortConstituencies(rowsOf<SearchConstituencyResult>(results[3]));
  const needs = rowsOf<NeedSearchRow>(results[4]).map((row) => ({
    ...row,
    // FoodbankChange.need_id_short() = str(need_id)[:7] (needs.py:81-82) --
    // the first 7 hex characters, identical on this schema's dashless
    // storage. needs.ts:63 already does the same slice.
    need_id_short: row.need_id.slice(0, 7),
  }));

  // Django appends the subscriber types in a fixed order and never re-sorts
  // across them (views.py:155-219), so neither does this. The mdi icon names
  // are Django's own, from views.py:167/198/214.
  const subscriptions = [
    ...mapSubscriptions(rowsOf<SubscriptionSearchRow>(results[5]), "email", "email"),
    ...mapSubscriptions(rowsOf<SubscriptionSearchRow>(results[6]), "mobile", "cellphone"),
    ...mapSubscriptions(rowsOf<SubscriptionSearchRow>(results[7]), "webpush", "bell"),
  ];

  return {
    foodbanks,
    locations,
    donationpoints,
    constituencies,
    needs,
    subscriptions,
    total: foodbanks.length + locations.length + donationpoints.length + constituencies.length + needs.length + subscriptions.length,
  };
}
