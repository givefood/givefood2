import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";
import { COUNTRIES, EMAIL_RE, FOODBANK_NETWORKS, isSingleLine, isValidHttpUrl } from "@givefood/models";
import { redactedKeyValueLines, sendEmail } from "../../lib/email";
import { issueCsrfToken } from "../../lib/csrf";
import { verifyHumanGate } from "./humanGate";

// givefood `register_foodbank` (GET/POST /register-foodbank/, i18n-patterned
// -- givefood/urls.py:22). Ported from givefood/views.py:451-480. One
// handler for both methods, matching Django's own `if request.POST:` branch
// inside a single view rather than splitting into two Hono routes.
//
// Security work added during the port, not carried over -- Django's real
// view already has real CSRF (@anonymous_csrf) and Turnstile, both ported
// as-is here via lib/csrf.ts + lib/turnstile.ts (verifyHumanGate, shared
// with flag.ts). The widget is never rendered on this page -- the form
// posts through POST /human/ first (routes/human.ts, already built for WP
// 3.7's subscribe form), which renders the widget and relays every other
// field -- including csrf_token -- straight through to this route on
// success.
//
// Failure UX follows the site's established convention (routes/write/
// index.ts's writeEmail), not Django's: a CSRF/Turnstile failure redirects
// back to this same GET page with ?turnstilefail=true (Django's original
// silently re-renders the blank-looking form with no distinct message at
// all -- a real UX gap, not a quirk worth preserving). A plain
// form-validation failure, or a failed Postmark send, re-renders in place
// with the submitted values and a distinct notification, same as writeEmail/
// writeSend's send_failed convention.
function pageContext(c: Context<AppEnv>, path: string, locale: "en" | "cy" | "ga" | "gd") {
  return {
    ...buildPageContext({ path, pageTranslatable: true, locale, unprefixedPath: c.get("pathAfterPrefix") }),
    render_time_ms: elapsedMs(c),
  };
}

interface RegistrationFormValues {
  name: string;
  address: string;
  postcode: string;
  country: string;
  network: string;
  email: string;
  phone_number: string;
  charity_number: string;
  website: string;
  shopping_list_link: string;
  facebook: string;
}

function emptyFormValues(): RegistrationFormValues {
  return { name: "", address: "", postcode: "", country: "", network: "", email: "", phone_number: "", charity_number: "", website: "", shopping_list_link: "", facebook: "" };
}

// FoodbankRegistrationForm (forms.py:38-49). Django's CharField/EmailField/
// URLField all default strip=True, so form.is_valid() validates trimmed
// copies -- but unlike gfwrite's ConstituentDetailsForm, this form's own
// cleaned_data isn't what render_to_string("public/registration_email.txt",
// {"form": request.POST.items()}) reads -- it reads request.POST.items()
// itself, the RAW values (views.py:465) -- so the same validate-trimmed/
// use-raw split applies here for consistency with the site's other ported
// forms, even though this form has no test@example.com-style diversion
// riding on the distinction.
//
// isSingleLine() on the free-text fields (not in Django's own form) closes
// an email-body-injection gap this port's own redactedKeyValueLines()
// introduces: a value containing \n would otherwise forge extra-looking
// "key: value" lines in the internal notification email. address is a
// genuine multi-line Textarea (both here and in Django) and is deliberately
// exempt.
function validateRegistration(v: RegistrationFormValues): boolean {
  const name = v.name.trim();
  const address = v.address.trim();
  const postcode = v.postcode.trim();
  const email = v.email.trim();
  const phone = v.phone_number.trim();
  const charityNumber = v.charity_number.trim();
  const website = v.website.trim();
  const shoppingListLink = v.shopping_list_link.trim();
  const facebook = v.facebook.trim();
  return (
    name.length > 0 &&
    name.length <= 100 &&
    isSingleLine(name) &&
    address.length > 0 &&
    postcode.length > 0 &&
    postcode.length <= 10 &&
    isSingleLine(postcode) &&
    COUNTRIES.includes(v.country) &&
    FOODBANK_NETWORKS.includes(v.network) &&
    EMAIL_RE.test(email) &&
    email.length <= 320 &&
    phone.length > 0 &&
    isSingleLine(phone) &&
    isSingleLine(charityNumber) &&
    isValidHttpUrl(website) &&
    isSingleLine(website) &&
    (shoppingListLink.length === 0 || (isValidHttpUrl(shoppingListLink) && isSingleLine(shoppingListLink))) &&
    (facebook.length === 0 || (isValidHttpUrl(facebook) && isSingleLine(facebook)))
  );
}

export async function publicRegisterFoodbank(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const gateOk = await verifyHumanGate(c, body);

    if (!gateOk) {
      return c.redirect(`${urlForLocale(locale, "register_foodbank")}?turnstilefail=true`, 302);
    }

    const values: RegistrationFormValues = {
      name: typeof body.name === "string" ? body.name : "",
      address: typeof body.address === "string" ? body.address : "",
      postcode: typeof body.postcode === "string" ? body.postcode : "",
      country: typeof body.country === "string" ? body.country : "",
      network: typeof body.network === "string" ? body.network : "",
      email: typeof body.email === "string" ? body.email : "",
      phone_number: typeof body.phone_number === "string" ? body.phone_number : "",
      charity_number: typeof body.charity_number === "string" ? body.charity_number : "",
      website: typeof body.website === "string" ? body.website : "",
      shopping_list_link: typeof body.shopping_list_link === "string" ? body.shopping_list_link : "",
      facebook: typeof body.facebook === "string" ? body.facebook : "",
    };

    if (!validateRegistration(values)) {
      const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);
      const html = await render(
        "public/register_foodbank.njk",
        {
          ...pageContext(c, c.req.path, locale),
          done: false,
          form_error: true,
          send_failed: false,
          form_values: values,
          countries: COUNTRIES,
          networks: FOODBANK_NETWORKS,
          csrf_token: csrfToken,
        },
        locale,
      );
      return c.html(html);
    }

    const emailBody = redactedKeyValueLines({ ...values });
    const sent = await sendEmail(c, {
      to: "mail@givefood.org.uk",
      subject: `New Food Bank Registration - ${values.name}`,
      textBody: emailBody,
    });

    if (!sent) {
      const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);
      const html = await render(
        "public/register_foodbank.njk",
        {
          ...pageContext(c, c.req.path, locale),
          done: false,
          form_error: false,
          send_failed: true,
          form_values: values,
          countries: COUNTRIES,
          networks: FOODBANK_NETWORKS,
          csrf_token: csrfToken,
        },
        locale,
      );
      return c.html(html);
    }

    return c.redirect(`${urlForLocale(locale, "register_foodbank")}?thanks=1`, 302);
  }

  const done = c.req.query("thanks") === "1";
  const turnstilefail = c.req.query("turnstilefail") === "true";
  const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);

  const html = await render(
    "public/register_foodbank.njk",
    {
      ...pageContext(c, c.req.path, locale),
      done,
      turnstilefail,
      form_error: false,
      send_failed: false,
      form_values: emptyFormValues(),
      countries: COUNTRIES,
      networks: FOODBANK_NETWORKS,
      csrf_token: csrfToken,
    },
    locale,
  );
  return c.html(html);
}
