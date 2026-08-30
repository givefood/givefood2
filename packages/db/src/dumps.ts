import type { Session } from "./types";

export interface DumpRow {
  id: number;
  dump_type: string;
  dump_format: string;
  row_count: number | null;
  size: number | null;
  r2_key: string;
  created: string;
}

function mapDumpRow(raw: Record<string, unknown>): DumpRow {
  return raw as unknown as DumpRow;
}

// gfapi2 `index` -- was `.order_by('dump_type','dump_format','-created')
// .distinct('dump_type','dump_format')`, a Postgres-only DISTINCT ON.
// SQLite/D1 has no equivalent, so this is the window-function rewrite
// already worked out in PLAN.md §7.6.
export async function getLatestDumps(session: Session): Promise<DumpRow[]> {
  const result = await session
    .prepare(
      `SELECT id, dump_type, dump_format, row_count, size, r2_key, created FROM (
         SELECT d.*,
                row_number() OVER (PARTITION BY dump_type, dump_format ORDER BY created DESC) AS rn
         FROM dump d
       ) WHERE rn = 1
       ORDER BY dump_type, dump_format`,
    )
    .all();
  return result.results.map((r) => mapDumpRow(r as Record<string, unknown>));
}
