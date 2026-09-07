import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";
import { EMAIL_RE, isSingleLine, isValidHttpUrl } from "@givefood/models";
import { redactedKeyValueLines, sendEmail } from "../../lib/email";
import { validateTurnstile } from "../../lib/turnstile";

// givefood `flag` (GET/POST /flag/, i18n-patterned -- givefood/urls.py:30).
// Ported from givefood/views.py:1099-1131 (flag()), plus human()'s already-
// built POST /human/ relay (routes/human.ts) that this form's action
// attribute posts through first, same as register_foodbank and the wfbn
// subscribe form.
//
// NO CSRF ON THIS ROUTE, AND THAT IS DELIBERATE (issue #40). The port
// originally added one -- Django's real flag() has @cache_page only, no
// @anonymous_csrf, flag.html renders no {% csrf_token %} tag at all, and
// CsrfViewMiddleware is commented out at givefood/settings.py:97, so the
// token was genuinely new here rather than carried over. It cost more than
// it bought: a per-visitor hidden field makes every render unshareable, so
// /flag/ -- 16.94% of the zone's 200s, the busiest single page on the site
// -- had to be pinned uncacheable with middleware/noStore.ts, and every one
// of those 13,117 requests/day executed the Worker and served 2,744 brotli
// bytes from origin that the edge could have answered.
//
// What is given up is close to nothing. /flag/ is unauthenticated, holds no
// per-user state, and its only effect is emailing mail@givefood.org.uk; a
// forger gains nothing they could not get by submitting the form themselves,
// beyond borrowing the victim's IP for the email body. Turnstile is what
// actually stops automated abuse here, and it is untouched below.
//
// THE OPT-OUT IS LOCAL, ON PURPOSE. verifyHumanGate() (./humanGate.ts) is
// shared with registerFoodbank.ts, so relaxing IT would silently drop CSRF
// from /register-foodbank/ too. This route therefore calls
// validateTurnstile() directly -- the identical second half of that gate,
// with the same secret and the same field -- and humanGate.ts stays exactly
// as it was for its other caller.
//
// BOTH HALVES OF THIS SHIP TOGETHER OR NEITHER DOES. If the token left the
// HTML while the gate still required it, every legitimate submission would
// fail verifyCsrf, redirect to ?turnstilefail=true and discard what the
// visitor typed -- the exact failure middleware/pageCacheControl.ts records
// reproducing on production on 2026-09-07. The companion edit is the removal
// of the /flag/ noStore mounts in index.ts.
function pageContext(c: Context<AppEnv>, path: string, locale: "en" | "cy" | "ga" | "gd") {
  return {
    ...buildPageContext({ path, pageTranslatable: true, locale, unprefixedPath: c.get("pathAfterPrefix"), isFlagPage: true }),
    render_time_ms: elapsedMs(c),
  };
}

interface FlagFormValues {
  our_page: string;
  your_email: string;
  explanation: string;
}

function emptyFormValues(): FlagFormValues {
  return { our_page: "", your_email: "", explanation: "" };
}

// FlagForm (forms.py:52-55): our_page required URLField, your_email and
// explanation both optional (your_email an EmailField when present).
// isSingleLine(our_page/your_email) closes the same email-body-injection
// gap registerFoodbank.ts's validateRegistration() does -- explanation is a
// genuine multi-line Textarea (both here and in Django) and is exempt.
function validateFlag(v: FlagFormValues): boolean {
  const ourPage = v.our_page.trim();
  const yourEmail = v.your_email.trim();
  return (
    isValidHttpUrl(ourPage) &&
    isSingleLine(ourPage) &&
    (yourEmail.length === 0 || (EMAIL_RE.test(yourEmail) && yourEmail.length <= 320))
  );
}

export async function publicFlag(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    // verifyHumanGate() minus its verifyCsrf() half -- see the header note.
    // The template still emits a `csrf_token` hidden field (empty now, and
    // relayed back through /human/ as empty); nothing reads it.
    const turnstileToken = typeof body["cf-turnstile-response"] === "string" ? body["cf-turnstile-response"] : "";
    const gateOk = await validateTurnstile(c.env.TURNSTILE_SECRET, turnstileToken);

    if (!gateOk) {
      return c.redirect(`${urlForLocale(locale, "flag")}?turnstilefail=true`, 302);
    }

    const values: FlagFormValues = {
      our_page: typeof body.our_page === "string" ? body.our_page : "",
      your_email: typeof body.your_email === "string" ? body.your_email : "",
      explanation: typeof body.explanation === "string" ? body.explanation : "",
    };

    if (!validateFlag(values)) {
      const html = await render(
        "public/flag.njk",
        {
          ...pageContext(c, c.req.path, locale),
          done: false,
          form_error: true,
          send_failed: false,
          form_values: values,
          csrf_token: "",
        },
        locale,
      );
      return c.html(html);
    }

    const userIp = c.req.header("CF-Connecting-IP") ?? "";
    const emailBody = `${redactedKeyValueLines({ ...values })}\n\nIP Address: ${userIp}`;
    const sent = await sendEmail(c, {
      to: "mail@givefood.org.uk",
      subject: "Give Food - Flagged Page",
      textBody: emailBody,
    });

    if (!sent) {
      const html = await render(
        "public/flag.njk",
        {
          ...pageContext(c, c.req.path, locale),
          done: false,
          form_error: false,
          send_failed: true,
          form_values: values,
          csrf_token: "",
        },
        locale,
      );
      return c.html(html);
    }

    return c.redirect(`${urlForLocale(locale, "flag")}?thanks=1`, 302);
  }

  const done = c.req.query("thanks") === "1";
  const turnstilefail = c.req.query("turnstilefail") === "true";

  // NOTHING PER-VISITOR BELOW THIS LINE, which is the whole point: no
  // issueCsrfToken() call means no `csrfIssued` flag and no Set-Cookie, so
  // middleware/pageCacheControl.ts stamps the response
  // `public, max-age=300, s-maxage=86400` -- Django's own
  // @cache_page(SECONDS_IN_DAY) on flag() (givefood/views.py:1098), reached
  // through that middleware's fallthrough with no rule of its own.
  // /frag/ip-address/ is a client-side data-include, not server-rendered
  // here, so the visitor's IP never enters this HTML.
  const html = await render(
    "public/flag.njk",
    {
      ...pageContext(c, c.req.path, locale),
      done,
      turnstilefail,
      form_error: false,
      send_failed: false,
      form_values: emptyFormValues(),
      csrf_token: "",
    },
    locale,
  );
  return c.html(html);
}
