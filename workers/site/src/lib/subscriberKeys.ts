// FoodbankSubscriber.save() (givefood/models/subscribers.py:44-57) --
// sub_key/unsub_key are each the first 16 hex chars of a SHA-256 hash of
// "sub-<now>-<salt>" / "unsub-<now>-<salt>". Extracted from
// routes/wfbn/updates.ts:26-43 so that the admin's bulk-add page
// (routes/admin/foodbankAddSub.ts, porting gfadmin/views.py:1594-1612) mints
// keys through the same implementation rather than a second one that drifts.
//
// THE EXTRACTION IS NOW COMPLETE. This header used to say updates.ts "had
// the only copy", which was false the moment the extraction landed: the copy
// stayed behind and the public subscribe form -- the highest-traffic minting
// path on the site -- went on calling it, nonce-free, until github #27.
// Both call sites reach this module now, and it is the only implementation.
//
// WHY THE NONCE. Django's helper is safe in a loop only because
// timezone.now() is microsecond-resolution AND each .save() is its own
// round trip. Date#toISOString() is MILLISECOND-resolution, so minting
// several pairs inside one request -- which is exactly what pasting twenty
// addresses into the admin's textarea does -- very often produces the same
// timestamp for several rows and therefore IDENTICAL sub_key values. Both
// sub_key and unsub_key are UNIQUE in D1 (0004_subscribers.sql:27-28), so
// that is not a subtle collision: the whole batch insert fails. A per-row
// nonce widens the hash input so each call is distinct regardless of clock
// resolution.
//
// The "sub-"/"unsub-" prefixes and the [:16] slice are kept exactly, so a
// key minted here is indistinguishable in shape from a Django-minted one.
// PLAN.md's risk register (N1) confirms the salt only affects newly-minted
// keys' format-consistency, never lookups -- a missing SUBSCRIBER_SALT
// degrades to "" rather than throwing.

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function generateSubUnsubKeys(
  salt: string,
  nonce: string = crypto.randomUUID(),
): Promise<{ subKey: string; unsubKey: string }> {
  const subHash = await sha256Hex(`sub-${new Date().toISOString()}-${nonce}-${salt}`);
  const unsubHash = await sha256Hex(`unsub-${new Date().toISOString()}-${nonce}-${salt}`);
  return { subKey: subHash.slice(0, 16), unsubKey: unsubHash.slice(0, 16) };
}
