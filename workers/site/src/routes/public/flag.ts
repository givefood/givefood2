import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";
import { EMAIL_RE, isSingleLine, isValidHttpUrl } from "@givefood/models";
import { redactedKeyValueLines, sendEmail } from "../../lib/email";
import { issueCsrfToken } from "../../lib/csrf";
import { verifyHumanGate } from "./humanGate";

// givefood `flag` (GET/POST /flag/, i18n-patterned -- givefood/urls.py:30).
// Ported from givefood/views.py:1099-1131 (flag()), plus human()'s already-
// built POST /human/ relay (routes/human.ts) that this form's action
// attribute posts through first, same as register_foodbank and the wfbn
// subscribe form.
//
// CSRF added during the port, not carried over: Django's real flag() has
// @cache_page only -- no @anonymous_csrf, and flag.html renders no
// {% csrf_token %} tag at all (verified directly against both files).
// Combined with CsrfViewMiddleware being globally disabled
// (givefood/settings.py:97), this view is genuinely CSRF-unprotected in
// production today. Closed here rather than reproduced, consistent with
// WP 4.6's own precedent (gfwrite's real Django view had no CSRF either,
// and PLAN.md's own callout there was explicit that it's "a defect to fix,
// not behaviour to preserve").
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
    const gateOk = await verifyHumanGate(c, body);

    if (!gateOk) {
      return c.redirect(`${urlForLocale(locale, "flag")}?turnstilefail=true`, 302);
    }

    const values: FlagFormValues = {
      our_page: typeof body.our_page === "string" ? body.our_page : "",
      your_email: typeof body.your_email === "string" ? body.your_email : "",
      explanation: typeof body.explanation === "string" ? body.explanation : "",
    };

    if (!validateFlag(values)) {
      const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);
      const html = await render(
        "public/flag.njk",
        {
          ...pageContext(c, c.req.path, locale),
          done: false,
          form_error: true,
          send_failed: false,
          form_values: values,
          csrf_token: csrfToken,
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
      const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);
      const html = await render(
        "public/flag.njk",
        {
          ...pageContext(c, c.req.path, locale),
          done: false,
          form_error: false,
          send_failed: true,
          form_values: values,
          csrf_token: csrfToken,
        },
        locale,
      );
      return c.html(html);
    }

    return c.redirect(`${urlForLocale(locale, "flag")}?thanks=1`, 302);
  }

  const done = c.req.query("thanks") === "1";
  const turnstilefail = c.req.query("turnstilefail") === "true";
  const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);

  const html = await render(
    "public/flag.njk",
    {
      ...pageContext(c, c.req.path, locale),
      done,
      turnstilefail,
      form_error: false,
      send_failed: false,
      form_values: emptyFormValues(),
      csrf_token: csrfToken,
    },
    locale,
  );
  return c.html(html);
}
