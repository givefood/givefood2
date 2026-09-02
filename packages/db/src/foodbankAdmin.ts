import type { Session } from "./types";

// WP 6.5: the admin's Foodbank edit forms' own write path -- separate
// from foodbank.ts (the public API read path). `fields` keys are always
// built by the caller from a fixed AdminFieldSpec list
// (lib/adminFormFields.ts), never raw request-body keys, so the column
// names interpolated into the SET clause are never attacker-controlled --
// the assertion below is a cheap backstop against a future caller
// forgetting that, not the actual safety boundary.
const COLUMN_NAME_RE = /^[a-z_]+$/;

// `stampEdited` mirrors forms.py's inconsistency exactly (WP 6.5
// research + maintainer decision): the full FoodbankForm and all 4
// collapsed partials stamp `edited`, FoodbankPoliticsForm deliberately
// does not -- preserved verbatim rather than "fixed", since the
// maintainer chose to match Django's behaviour here, not WP 6.3/6.4's
// usual "fix the defect" default. `modified` (TimestampedModel's
// auto_now) always updates regardless -- that one was never form-gated
// in Django either.
export async function updateFoodbankFields(session: Session, id: number, fields: Record<string, string | number | null>, stampEdited: boolean): Promise<void> {
  const entries = Object.entries(fields);
  for (const [name] of entries) {
    if (!COLUMN_NAME_RE.test(name)) throw new Error(`refusing to update unexpected column: ${name}`);
  }
  const now = new Date().toISOString();
  const setSql = entries.map(([name]) => `${name} = ?`).join(", ");
  const values = entries.map(([, v]) => v);
  const tailSql = stampEdited ? "modified = ?, edited = ?" : "modified = ?";
  const tailValues = stampEdited ? [now, now] : [now];
  await session
    .prepare(`UPDATE foodbank SET ${setSql}, ${tailSql} WHERE id = ?`)
    .bind(...values, ...tailValues, id)
    .run();
}
