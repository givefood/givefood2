import type { Context } from "hono";
import {
  confirmSubscriber,
  deleteSubscriberById,
  getFoodbankBySlug,
  getSubscriberByEmailAndFoodbank,
  getSubscriberBySubKey,
  getSubscriberByUnsubKey,
  insertSubscriber,
} from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { url, urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { CHARITY_DETAIL_COUNTRIES, fullNameLocaleAware } from "../../lib/fields";

// gfwfbn `updates` (re_path /needs/at/<slug>/updates/(subscribe|confirm|
// unsubscribe)/, i18n-patterned, namespace wfbn, route name "updates").
// Ported from gfwfbn/views.py:1100-1200 -- ONE handler for all three
// actions via the :action route param, matching Django's single regex +
// kwarg dispatch rather than three separate Hono routes.

// A simple, not-Django's-exact-EmailValidator check -- good enough to
// reject obviously malformed input with a 403, same spirit as the task
// brief's own framing of `validate_email`'s job here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// FoodbankSubscriber.save() (givefood/models/subscribers.py:44-57) --
// sub_key/unsub_key are each the first 16 hex chars of a SHA-256 hash of
// "sub-<now>-<salt>" / "unsub-<now>-<salt>". PLAN.md's risk register (N1)
// confirms the salt only affects *newly-minted* keys' format-consistency,
// never lookups -- SUBSCRIBER_SALT missing degrades to "" rather than
// throwing.
async function generateSubUnsubKeys(salt: string): Promise<{ subKey: string; unsubKey: string }> {
  const subHash = await sha256Hex(`sub-${new Date().toISOString()}-${salt}`);
  const unsubHash = await sha256Hex(`unsub-${new Date().toISOString()}-${salt}`);
  return { subKey: subHash.slice(0, 16), unsubKey: unsubHash.slice(0, 16) };
}

// givefood/utils/general.py's validate_turnstile() -- POSTs to
// Cloudflare's siteverify endpoint and returns whether it succeeded.
async function validateTurnstile(secret: string | undefined, token: string): Promise<boolean> {
  if (!secret) {
    // Fails closed (correctly -- validation can't pass without a secret),
    // but logged same as sendEmail()'s own missing-token case below:
    // without this, an unset TURNSTILE_SECRET is indistinguishable in the
    // Workers logs from a real visitor submitting a bad token, and every
    // subscribe attempt silently fails until someone thinks to check this
    // specific secret.
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

// givefood/utils/notifications.py's send_email() -- POSTs to Postmark's
// REST API. Never throws: a failed send (missing token, non-200, network
// error) is logged and swallowed, exactly like the Python original's own
// `if result.status_code == 200: return True else: logging.error(...);
// return False` -- no exception ever reaches the view either side.
async function sendEmail(
  c: Context<AppEnv>,
  params: { to: string; subject: string; textBody: string; htmlBody: string },
): Promise<void> {
  const token = c.env.POSTMARK_TOKEN;
  if (!token) {
    console.log(`POSTMARK_TOKEN not set -- skipping email to ${params.to}: ${params.subject}`);
    return;
  }
  try {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        From: "mail@givefood.org.uk",
        To: params.to,
        Subject: params.subject,
        TextBody: params.textBody,
        HtmlBody: params.htmlBody,
      }),
    });
    if (!response.ok) {
      console.error(`Failed to send email to ${params.to}: ${response.status} - ${await response.text()}`);
    }
  } catch (err) {
    console.error(`Failed to send email to ${params.to}: ${String(err)}`);
  }
}

// wfbn/emails/confirm.txt / confirm.html, ported verbatim (copy and
// links) -- the admin/emails/page.html chrome those two extend isn't
// ported (out of scope, not built yet), so this emits the body content
// on its own rather than inside that shell.
function confirmEmailBodies(siteDomain: string, foodbankName: string, foodbankSlug: string, subKey: string): { text: string; html: string } {
  const confirmUrl = `${siteDomain}${url("wfbn:updates", foodbankSlug, "confirm")}?key=${subKey}`;
  const text =
    `Please link the button below to confirm your email address and get updates from ${foodbankName} food bank.\n\n` +
    `${confirmUrl}\n\n` +
    `If you're not expecting this email then please ignore it.`;
  const html =
    `<p>Please click the button below to confirm your email address and get updates from ${foodbankName} food bank.</p>` +
    `<p><a href="${confirmUrl}">Confirm my email address</a></p>` +
    `<p>If you're not expecting this email then please ignore it.</p>`;
  return { text, html };
}

// wfbn/emails/confirmed.txt / confirmed.html, ported verbatim -- the
// "updates them updates them." double-up in confirm.txt's source is a
// real typo in the Django template, preserved rather than "fixed" (the
// .html sibling only says it once, also preserved as-is).
function confirmedEmailBodies(
  siteDomain: string,
  fullName: string,
  foodbankSlug: string,
  hasDonationPoints: boolean,
): { text: string; html: string } {
  const foodbankUrl = `${siteDomain}${url("wfbn:foodbank", foodbankSlug)}`;
  const donationPointsUrl = `${siteDomain}${url("wfbn:foodbank_donationpoints", foodbankSlug)}`;
  const nearbyUrl = `${siteDomain}${url("wfbn:foodbank_nearby", foodbankSlug)}`;
  const writeUrl = `${siteDomain}${url("write:index")}`;

  const text =
    `Thanks for confirming your email address.\n\n` +
    `We'll send you a list of items being requested whenever ${fullName} updates them updates them.  In the meantime, here are some useful links...\n\n` +
    `🔗 You can find more details about the food bank ${foodbankUrl}\n` +
    `🗺️ See other nearby food banks ${nearbyUrl}\n` +
    `🗳️ Explain to your MP that food banks shouldn't exist by taking political action ${writeUrl}`;

  const html =
    `<p>Thanks for confirming your email address.</p>` +
    `<p>We'll send you a list of items being requested whenever ${fullName} updates them. In the meantime, here are some useful links...</p>` +
    `<p>` +
    `🔗 You can find more details <a href="${foodbankUrl}">about the food bank</a><br>` +
    (hasDonationPoints ? `🛒 View the foodbank's <a href="${donationPointsUrl}">donation points</a><br>` : "") +
    `🗺️ See other <a href="${nearbyUrl}">nearby food banks</a><br>` +
    `🗳️ Explain to your MP that food banks shouldn't exist by <a href="${writeUrl}">taking political action</a>` +
    `</p>`;

  return { text, html };
}

export async function wfbnFoodbankUpdates(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const action = c.req.param("action")!;
  const session = dbSession(c);
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const foodbank = await getFoodbankBySlug(session, slug);
  if (!foodbank) return c.notFound();

  let message = "";

  if (action === "subscribe") {
    // Django reads these off request.POST regardless of method (a GET
    // returns None for both, which fails EMAIL_RE below exactly like an
    // empty/invalid `validate_email(None)` does) -- parseBody() on a
    // bodyless GET resolves to {}, same effect.
    const body: Record<string, string | File> = c.req.method === "POST" ? await c.req.parseBody() : {};
    const emailRaw = typeof body.email === "string" ? body.email : "";
    const turnstileToken = typeof body["cf-turnstile-response"] === "string" ? body["cf-turnstile-response"] : "";

    if (!EMAIL_RE.test(emailRaw)) {
      return new Response("", { status: 403 });
    }

    const turnstileValid = await validateTurnstile(c.env.TURNSTILE_SECRET, turnstileToken);
    if (!turnstileValid) {
      const foodbankPath = urlForLocale(locale, "wfbn:foodbank", foodbank.slug);
      const target = `${foodbankPath}?turnstilefail=true&email=${encodeURIComponent(emailRaw)}`;
      return c.redirect(target, 302);
    }

    // FoodbankSubscriber.save() lowercases before the uniqueness
    // constraint (unique_together('email', 'foodbank')) ever sees it --
    // the pre-check has to do the same or it will miss a real dupe. Note
    // this only mutates the model instance's own `.email` in Django (the
    // view's local `email` name is never reassigned) -- the confirmation
    // email and the success message below both still use the ORIGINAL
    // (possibly mixed-case) `emailRaw`, only the stored row and the dupe
    // check use the lowercased form. Reproduced verbatim, not "fixed".
    const email = emailRaw.toLowerCase();
    const existing = await getSubscriberByEmailAndFoodbank(session, email, foodbank.id);

    if (existing) {
      message = "Sorry! That email address is already subscribed to that food bank.";
    } else {
      const { subKey, unsubKey } = await generateSubUnsubKeys(c.env.SUBSCRIBER_SALT ?? "");

      // The pre-check above narrows the window but doesn't close it -- two
      // near-simultaneous submits for the same (email, foodbank) can both
      // pass getSubscriberByEmailAndFoodbank before either inserts. Django's
      // original catches the equivalent IntegrityError from its
      // unique_together constraint (gfwfbn/views.py); do the same here by
      // catching sub_email_fb_uniq's violation specifically (D1/SQLite
      // raises "UNIQUE constraint failed" for this, not some other error),
      // re-throwing anything else rather than masking an unrelated failure.
      let inserted = true;
      try {
        await insertSubscriber(session, {
          foodbankId: foodbank.id,
          foodbankName: foodbank.name,
          email,
          subKey,
          unsubKey,
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          inserted = false;
        } else {
          throw err;
        }
      }

      if (!inserted) {
        message = "Sorry! That email address is already subscribed to that food bank.";
      } else {
        const { text, html } = confirmEmailBodies(c.env.SITE_DOMAIN, foodbank.name, foodbank.slug, subKey);
        await sendEmail(c, { to: emailRaw, subject: "Confirm your Give Food subscription", textBody: text, htmlBody: html });

        message =
          `Thanks, but we're not quite done yet.\n\n` +
          `We've sent an email to ${emailRaw} with a link to click to confirm your subscription. You might have to look in your spam folder though.`;
      }
    }
  }

  if (action === "confirm") {
    const key = c.req.query("key");
    const sub = key ? await getSubscriberBySubKey(session, key) : null;
    if (!sub) return c.notFound();

    if (!sub.confirmed) {
      await confirmSubscriber(session, sub.id);

      const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);
      // no_donation_points is nullable in production (unlike its
      // no_locations sibling) -- a truthy check treats null the same as
      // 0 ("no/unknown donation points"), matching Django's own `if
      // foodbank.no_donation_points:`. `!== 0` would wrongly treat a null
      // (genuinely unknown count) as "has donation points".
      const { text, html } = confirmedEmailBodies(c.env.SITE_DOMAIN, fullName, foodbank.slug, Boolean(foodbank.no_donation_points));
      await sendEmail(c, {
        to: sub.email,
        subject: `Thank you for confirming your subscription to ${foodbank.name} Food Bank`,
        textBody: text,
        htmlBody: html,
      });
    }

    message = "Great! Thank you for confirming your subscription.";
  }

  if (action === "unsubscribe") {
    const key = c.req.query("key");
    if (!key) return new Response("", { status: 403 });

    const sub = await getSubscriberByUnsubKey(session, key);
    if (!sub) return c.notFound();

    await deleteSubscriberById(session, sub.id);

    // RFC 8058 one-click unsubscribe: email clients POST here with body
    // "List-Unsubscribe=One-Click". Bare 200, empty body, no template
    // render at all -- this exact shape is a named WP 3.7 acceptance
    // criterion.
    if (c.req.method === "POST") {
      return new Response(null, { status: 200 });
    }

    message = "You have been unsubscribed.";
  }

  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, locale);
  const [latStr, lngStr] = foodbank.lat_lng.split(",");

  const context = buildPageContext({
    path: c.req.path,
    appName: "gfwfbn",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/foodbank/updates.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      section: "subscribe",
      foodbank,
      full_name: fullName,
      has_charity_details: CHARITY_DETAIL_COUNTRIES.has(foodbank.country),
      message,
      latt: Number(latStr),
      long: Number(lngStr),
      prefix: null,
    },
    locale,
  );
  return c.html(html);
}
