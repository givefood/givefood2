import type { Session } from "./types";
import { pyNow } from "@givefood/models";

// gfwrite `email` (views.py:79-85) -- ConstituencySubscriber.save(). Write
// -only: "Written by gfwrite/views.py:80-85, read by nothing, ever. No send
// path, no admin view, no cron. Port the table; do not invent a channel."
// (PLAN.md's data-migration notes on this table). id is omitted so SQLite
// assigns the next rowid itself, same as every other Worker-side insert in
// this codebase.
//
// save() (subscribers.py:72-80) lowercases the email before storing --
// done here (the "model" layer), not by the caller, so the route's own
// `email` value stays exactly as the constituent typed it for the draft
// letter/from_field, same "only the stored row is lowercased, not the
// route-local value" split routes/wfbn/updates.ts's insertSubscriber
// caller already documents for FoodbankSubscriber.
export async function insertConstituencySubscriber(
  session: Session,
  params: { email: string; name: string; parliamentaryConstituencyId: number; parliamentaryConstituencyName: string | null },
): Promise<void> {
  // "T"-separated, millisecond-precision -- see subscribers.ts's own
  // comment on this exact convention for freshly-inserted (not migrated)
  // rows.
  const created = pyNow();
  await session
    .prepare(
      "INSERT INTO constituencysubscriber (created, email, name, parliamentary_constituency_id, parliamentary_constituency_name) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(created, params.email.toLowerCase(), params.name, params.parliamentaryConstituencyId, params.parliamentaryConstituencyName)
    .run();
}
