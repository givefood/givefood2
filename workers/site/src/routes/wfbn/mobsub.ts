import type { Context } from "hono";
import {
  deleteMobileSubscriber,
  getDonationPointIdByUuid,
  getFoodbankIdByUuid,
  upsertMobileSubscriber,
} from "@givefood/db";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";

// gfwfbn `mobsub`/`delete_mobsub` (gfwfbn/views.py:1354-1414). The shipped
// native-app contract -- field names and the foodbank/donationpoint UUID
// keying are read verbatim from the Django source, not paraphrased.

function stringField(value: string | File | undefined): string {
  return typeof value === "string" ? value : "";
}
function optionalStringField(value: string | File | undefined): string | null {
  const s = stringField(value);
  return s ? s : null;
}

// Shared by mobsub and delete_mobsub: resolve the (already-validated
// non-empty) foodbank UUID, and the optional donationpoint UUID scoped to
// it, to their D1 ids. `null` means "the caller should 404" -- an unknown
// foodbank or donationpoint UUID (donationpoint 404 includes one that
// exists but belongs to a DIFFERENT foodbank, since getDonationPointIdByUuid
// is itself foodbank-scoped).
async function resolveFoodbankAndDonationpoint(
  session: ReturnType<typeof dbSession>,
  foodbankUuid: string,
  donationpointUuid: string,
): Promise<{ foodbankId: number; donationpointId: number | null } | null> {
  const foodbankId = await getFoodbankIdByUuid(session, foodbankUuid);
  if (foodbankId === null) return null;

  if (!donationpointUuid) return { foodbankId, donationpointId: null };
  const donationpointId = await getDonationPointIdByUuid(session, donationpointUuid, foodbankId);
  if (donationpointId === null) return null;
  return { foodbankId, donationpointId };
}

// `mobsub` (POST /needs/mobsub/, no i18n prefix -- wfbn-generic namespace).
// Django decorates this `@require_POST` (a real method restriction at
// dispatch time, unlike webpush_subscribe/unsubscribe below, which have
// no such decorator and so check the method by hand) -- no internal check
// here either, matching every other single-method view ported so far:
// the route registration (index.ts registering this at app.post(), not
// app.all()) is what enforces POST-only.
export async function wfbnMobsub(c: Context<AppEnv>): Promise<Response> {
  const body = await c.req.parseBody();
  const deviceId = stringField(body.device_id);
  const platform = stringField(body.platform);
  const foodbankUuid = stringField(body.foodbank);

  if (!deviceId || !platform || !foodbankUuid) return new Response("", { status: 400 });

  const session = dbSession(c);
  const resolved = await resolveFoodbankAndDonationpoint(session, foodbankUuid, stringField(body.donationpoint));
  if (resolved === null) return c.notFound();

  await upsertMobileSubscriber(session, {
    deviceId,
    foodbankId: resolved.foodbankId,
    donationpointId: resolved.donationpointId,
    platform,
    timezone: optionalStringField(body.timezone),
    locale: optionalStringField(body.locale),
    appVersion: optionalStringField(body.app_version),
    osVersion: optionalStringField(body.os_version),
    deviceModel: optionalStringField(body.device_model),
    subType: optionalStringField(body.sub_type),
  });

  return c.json({ success: true });
}

// `delete_mobsub` (POST /needs/mobsub/delete/, no i18n prefix). Django has
// NO method-restriction decorator on this view at all (unlike mobsub
// above) -- implemented here as accepting POST, since that's the real-
// world usage, but deliberately without an internal method re-check to
// match the source exactly; the route registration is what makes it
// POST-only.
export async function wfbnDeleteMobsub(c: Context<AppEnv>): Promise<Response> {
  const body = await c.req.parseBody();
  const deviceId = stringField(body.device_id);
  const foodbankUuid = stringField(body.foodbank);

  if (!deviceId || !foodbankUuid) return new Response("", { status: 400 });

  const session = dbSession(c);
  const resolved = await resolveFoodbankAndDonationpoint(session, foodbankUuid, stringField(body.donationpoint));
  if (resolved === null) return c.notFound();

  // Not a 404 for "nothing to delete" -- Django's own test coverage
  // asserts a 200 with `deleted: false` for a no-op delete (task brief),
  // matching `deleted_count > 0` straight through to the response.
  const deleted = await deleteMobileSubscriber(session, {
    deviceId,
    foodbankId: resolved.foodbankId,
    donationpointId: resolved.donationpointId,
  });
  return c.json({ deleted });
}
