// Shared by lib/csrf.ts (the double-submit token's signature) and
// routes/whatsappHook.ts (verifying Meta's X-Hub-Signature-256) -- both need
// the same HMAC-SHA256 primitive, hex-encoded, and the same constant-time
// comparison so neither leaks timing information about a secret it's
// checking.
async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function toHex(signature: ArrayBuffer): string {
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// csrf.ts signs a freshly-minted hex token (its own output, always valid
// UTF-8 by construction) -- a string in, string out API is the natural fit
// there.
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(signature);
}

// whatsappHook.ts signs an attacker-reachable request body -- decoding it to
// a string first (even via a correct, spec-compliant c.req.text()) and then
// re-encoding for signing would lose fidelity if the raw bytes ever
// contained an invalid UTF-8 sequence (decode replaces it with U+FFFD, so
// the re-encoded bytes fed to HMAC would differ from what was actually
// signed). Verifying over the exact bytes read via c.req.arrayBuffer()
// avoids that round-trip entirely.
export async function hmacSha256HexBytes(secret: string, message: ArrayBuffer): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, message);
  return toHex(signature);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
