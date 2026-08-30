// `foodbank.uuid` and `foodbankchange.need_id` are stored 32-char dashless
// (PLAN.md §4.4) -- Postgres dumped them dashed, Django's own SQLite
// backend stores them dashless, and the migration normalised to match. A
// caller passing either form should still find the row, so every lookup
// by UUID goes through this first.
export function normalizeUuid(input: string): string {
  return input.replace(/-/g, "").toLowerCase();
}

// Django's JSON encoder serialises a UUID field as its dashed str() form
// (str(uuid.UUID(...))), and gfapi1/2 re-emit need_id that way in JSON
// responses -- confirmed by reading gfapi1/views.py's api_foodbank /
// api_need, which pass the model's raw need_id (a UUID object under
// Django, dashless TEXT here) straight into the response dict. Output
// needs the inverse of normalizeUuid, not just a passthrough.
export function toDashedUuid(dashless: string): string {
  const s = normalizeUuid(dashless);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
