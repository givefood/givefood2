// givefood/utils/general.py's validate_turnstile() -- POSTs to Cloudflare's
// siteverify endpoint and returns whether it succeeded. Extracted from
// routes/wfbn/updates.ts (its original home) so gfwrite's routes can share
// the exact same check rather than a second copy.
export async function validateTurnstile(secret: string | undefined, token: string): Promise<boolean> {
  if (!secret) {
    // Fails closed (correctly -- validation can't pass without a secret),
    // but logged: without this, an unset TURNSTILE_SECRET is
    // indistinguishable in the Workers logs from a real visitor submitting
    // a bad token, and every submission silently fails until someone
    // thinks to check this specific secret.
    console.log("TURNSTILE_SECRET not set -- failing validation closed");
    return false;
  }
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token }),
    });
    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
