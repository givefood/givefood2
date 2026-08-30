import { coerceBooleans, type Session } from "./types";
import { normalizeUuid } from "./uuid";

const BOOLEAN_COLUMNS = ["published", "nonpertinent", "is_categorised"] as const;

export interface FoodbankChangeRow {
  id: number;
  need_id: string; // 32-char dashless; need_id_str is computed at read time, not stored (0001_core.sql)
  foodbank_id: number | null;
  foodbank_name: string | null;
  distill_id: string | null;
  name: string | null;
  uri: string | null;
  change_text: string; // sentinels 'Nothing' / 'Unknown' / 'Facebook' are contract, see PLAN.md §7
  change_text_original: string | null;
  excess_change_text: string | null;
  excess_change_text_original: string | null;
  published: boolean;
  nonpertinent: boolean | null; // NULLABLE: NULL is not the same as false, see PLAN.md §4.4
  is_categorised: boolean | null;
  notified: string | null;
  input_method: string;
  created: string;
  modified: string;
}

function mapNeedRow(raw: Record<string, unknown>): FoodbankChangeRow {
  return coerceBooleans<FoodbankChangeRow>(raw, BOOLEAN_COLUMNS);
}

// gfapi1 `api_needs` (caller-supplied limit, validated by the handler --
// see frozen bug B4, PLAN.md §7.3: `?limit=abc` is a 500 there, not a 400)
// and gfapi2 `needs` (hardcoded limit=100).
export async function getPublishedNeeds(session: Session, limit: number): Promise<FoodbankChangeRow[]> {
  const result = await session
    .prepare("SELECT * FROM foodbankchange WHERE published = 1 ORDER BY created DESC LIMIT ?")
    .bind(limit)
    .all();
  return result.results.map(mapNeedRow);
}

// gfapi1 `api_need` / gfapi2 `need` -- both look up by the `need_id` UUID,
// accepting either dashed or dashless input.
export async function getNeedByUuid(session: Session, needId: string): Promise<FoodbankChangeRow | null> {
  const row = await session
    .prepare("SELECT * FROM foodbankchange WHERE need_id = ?")
    .bind(normalizeUuid(needId))
    .first();
  return row ? mapNeedRow(row as Record<string, unknown>) : null;
}

// Internal: used by foodbank.ts to resolve `foodbank.latest_need_id` --
// two small PK/indexed lookups instead of a ~95-column JOIN alias list.
// D1 meters rows scanned, not returned (PLAN.md §4.3); a PK lookup scans
// exactly one row either way, so this costs nothing extra over a JOIN.
export async function getNeedById(session: Session, id: number): Promise<FoodbankChangeRow | null> {
  const row = await session.prepare("SELECT * FROM foodbankchange WHERE id = ?").bind(id).first();
  return row ? mapNeedRow(row as Record<string, unknown>) : null;
}
