// `foodbank.uuid` and `foodbankchange.need_id` are stored 32-char dashless
// (PLAN.md §4.4) -- Postgres dumped them dashed, Django's own SQLite
// backend stores them dashless, and the migration normalised to match. A
// caller passing either form should still find the row, so every lookup
// by UUID goes through this first.
export function normalizeUuid(input: string): string {
  return input.replace(/-/g, "").toLowerCase();
}
