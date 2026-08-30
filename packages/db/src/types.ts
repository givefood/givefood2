// WP 2.2b. Every query below runs through the D1 Sessions API, never a bare
// `env.DB.prepare()` -- this database has read replication enabled, and a
// bare call can silently land on a replica that hasn't caught up with a
// just-completed write. See PLAN.md §3.3. Callers create the session with
// `env.DB.withSession(bookmark ?? "first-unconstrained")` and propagate
// `session.getBookmark()` themselves; this package only ever receives an
// already-created session, never the raw `D1Database` binding.
export type Session = D1DatabaseSession;

// D1/SQLite has no native boolean -- these columns are INTEGER 0/1/NULL.
// Postgres booleans compared this way (`col = true`/`col = false`) already
// exclude NULL under three-valued logic, which is what Django's ORM does
// too, so a plain `= 1`/`= 0` in a WHERE clause needs no special NULL
// handling here. This helper is only for the read-side shape: raw D1 rows
// come back as 0/1/null, but every consumer downstream (packages/serialise,
// the route handlers) expects real booleans -- see PLAN.md §4.4's inverse
// mapping note. `wheelchair_accessible` is documented tri-state (NULL means
// "unknown", not "no") -- this preserves null rather than coalescing it.
export function coerceBooleans<T>(raw: Record<string, unknown>, booleanKeys: readonly string[]): T {
  const row: Record<string, unknown> = { ...raw };
  for (const key of booleanKeys) {
    const value = row[key];
    row[key] = value === null || value === undefined ? null : value === 1;
  }
  return row as T;
}

// D1/SQLite's default text collation is byte-wise (all uppercase before any
// lowercase); the source Postgres database sorts under `en_US.utf8`, a
// linguistic collation. An `ORDER BY name` reproduced verbatim in SQL would
// therefore reorder any list with mixed-case or accented names -- sort in
// JS with a locale-aware collator instead, matching production ordering
// much more closely than a raw SQL ORDER BY on this engine can.
const NAME_COLLATOR = new Intl.Collator("en-US");
export function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
}

// The candidate-set shape for nearest-N ranking (WP 2.5, @givefood/geo's
// `nearest()`). Deliberately just `id` + coordinates, not a full row --
// every open-row table has a partial index on exactly
// `(latitude, longitude) WHERE is_closed = 0` (see 0001_core.sql), so a
// query selecting only these three columns is answered as a covering
// index scan, never touching the underlying table rows. Fetching every
// column of every open row (1000-5700+ rows, 40-80 columns each) just to
// rank by distance and discard everything but the top 10-20 was measured
// as the dominant cost on every uncached search/nearby request -- see the
// WP 2.5 perf note in PLAN.md. Full rows for the surviving winners are
// fetched afterward, by id, same as the existing by-ids functions already
// do for the `latest_need` join.
export interface CoordinateRow {
  id: number;
  latitude: number;
  longitude: number;
}

function mapCoordinateRow(raw: Record<string, unknown>): CoordinateRow {
  return raw as unknown as CoordinateRow;
}

export async function queryCoordinates(session: Session, sql: string): Promise<CoordinateRow[]> {
  const result = await session.prepare(sql).all();
  return result.results.map((r) => mapCoordinateRow(r as Record<string, unknown>));
}
