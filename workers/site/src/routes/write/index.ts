import type { Context } from "hono";
import { getConstituencyBySlugNarrow, getConstituencySlugByPcon24cd, getFoodbanksForConstituency, insertConstituencySubscriber } from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { url } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { EMAIL_RE } from "@givefood/models";
import { validateTurnstile } from "../../lib/turnstile";
import { sendEmail } from "../../lib/email";
import { issueCsrfToken, verifyCsrf } from "../../lib/csrf";
import { constituencySlugFromPostcode, mpPhotoUrl } from "../wfbn/constituencies";

// gfwrite (WP 4.6, PLAN.md §6.9) -- entirely outside i18n_patterns
// (givefood/urls.py's "Untranslated apps" block, same as gfdash), so no
// locale loop, matching gfwrite/urls.py exactly. Five routes, ported from
// gfwrite/views.py -- see this file's own per-handler comments for the
// per-route source line ranges.
//
// Security work added during the port, not carried over -- gfwrite's real
// Django views have NONE of this today (PLAN.md's own callout: "Today
// POST /write/to/<slug>/email/send/ has no CSRF, no Turnstile and no rate
// limit, and it relays an attacker-controlled subject and body from
// mail@givefood.org.uk to a sitting MP... It is a defect to fix, not
// behaviour to preserve"):
//   - CSRF (lib/csrf.ts): a fresh signed double-submit token is issued on
//     every GET/POST that renders a mutating form, and verified on the
//     next POST in the chain.
//   - Turnstile (lib/turnstile.ts, same check gfwfbn's subscribe action
//     uses): on both the constituency-details form (verified in
//     writeEmail) and the compose form (verified in writeSend).
//   - The WAF rate-limit PLAN.md's R4 calls for
//     (`http.request.uri.path matches "^/write/to/[^/]+/email/send/$"`,
//     ~3 req/hour/IP) is Cloudflare dashboard configuration, not code --
//     not applied here; needs configuring before this route carries real
//     traffic.
//
// A CSRF/Turnstile failure on writeEmail (still GET-renderable at
// write:constituency) redirects there with `?turnstilefail=true`, matching
// the established site convention (routes/wfbn/updates.ts). A failure on
// writeSend re-renders the compose page in place instead -- write:email is
// POST-only with no GET fallback (R5 preserves that 404), so there's
// nothing to redirect back to that would still have the user's edited
// text.

function pageContext(c: Context<AppEnv>, path: string) {
  return { ...buildPageContext({ path }), render_time_ms: elapsedMs(c) };
}

// ParliamentaryConstituency.foodbank_names() (political.py:139-146) --
// deduped food-bank-entry names, where "entry" is Foodbank.name for an
// organisation row and FoodbankLocation.name (NOT its parent's name) for a
// location row -- verified directly against foodbanks() (political.py:
// 100-134), which builds `{"name": location.name, ...}` for location
// entries. A JS Set (insertion order) stands in for Django's plain
// `set()` (arbitrary hash order) -- this only ever feeds a
// human-readable, editable email draft, not a byte-exact contract.
function constituencyFoodbankNames(foodbanks: { name: string }[], locations: { name: string }[]): string[] {
  return Array.from(new Set([...foodbanks.map((fb) => fb.name), ...locations.map((loc) => loc.name)]));
}

// write/email.txt, rendered verbatim (the letter body the constituent can
// then edit). `{% now "jS F Y" %}` -- Django's ordinal-day date filter;
// ordinalSuffix() below reproduces just the "jS" part, the rest is a fixed
// format.
function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function todayFormatted(now: Date): string {
  const day = now.getUTCDate();
  return `${day}${ordinalSuffix(day)} ${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
}

function draftEmailBody(params: { address: string; name: string; constituencyName: string; mpDisplayName: string; foodbankNames: string[]; now: Date }): string {
  // "{% for foodbank in foodbanks %}...{% endfor %}" -- Django's
  // Oxford-comma-free "A, B and C" join (no comma before "and", and a
  // single name gets no conjunction at all), reproduced verbatim from the
  // template's forloop.first/forloop.last conditionals.
  const names = params.foodbankNames;
  let foodbankList = "";
  names.forEach((name, i) => {
    if (i > 0) {
      if (i < names.length - 1) foodbankList += ", ";
      else foodbankList += names.length > 1 ? " and " : "";
    }
    foodbankList += `${name} Food Bank`;
  });

  return (
    `${params.address}\n` +
    `${todayFormatted(params.now)}\n\n` +
    `Dear ${params.mpDisplayName},\n\n` +
    `My name is ${params.name} and I am a constituent of ${params.constituencyName}. I am writing to you today because I am concerned about the increasing number of people being forced to use food banks in our country. \n\n` +
    `Food banks in our ${params.constituencyName} constituency include ${foodbankList}.\n\n` +
    `Over three million emergency food parcels were given out by the UK's largest food bank network, The Trussell Trust, in the past 12 months. This is more than double the number compared to five years ago.\n\n` +
    `People are driven to using emergency food supplies from charities because of the cost of living increasing, a lack of income, benefit delays & cuts, and inadequate support during challenging life experiences.\n\n` +
    `I'd be interested in hearing what you propose doing to support our local food banks, especially preventing my fellow constituents from having to use them in the first place.\n\n` +
    `I look forward to hearing from you.  \n\n` +
    `Yours faithfully,  \n${params.name}\n\n\n\n` +
    `Email is sent via Give Food, a registered charity in England & Wales 1188192\n` +
    `https://www.givefood.org.uk`
  );
}

// write/email_header.txt, rendered verbatim -- including its own trailing
// two blank lines (verified byte-for-byte: the real file ends
// "*****************************\n\n\n"), which `${header}${emailBody}`
// depends on for a blank line between the notice and the constituent's
// letter (views.py's send() concatenates the two with no separator of its
// own: `body = body_header + form.data["body"]`).
function emailHeader(name: string, email: string): string {
  return (
    `*****************************\n` +
    `This email has been sent on behalf of ${name} by Give Food.\n` +
    `Please reply them directly using the email address ${email}.\n` +
    `*****************************\n\n\n`
  );
}

// gfwrite `index` (GET /write/). Ported from views.py:13-39.
export async function writeIndex(c: Context<AppEnv>): Promise<Response> {
  const postcode = c.req.query("postcode") ?? null;

  if (postcode) {
    const slug = await constituencySlugFromPostcode(postcode);
    if (slug) {
      return c.redirect(`${url("write:constituency", slug)}?postcode=${encodeURIComponent(postcode)}`, 302);
    }
  }

  const mapConfig = JSON.stringify({ geojson: "/static/geojson/parlcon.json", onClick: "navigate" });

  const html = await render("write/index.njk", {
    ...pageContext(c, c.req.path),
    postcode,
    map_config: mapConfig,
  });
  return c.html(html);
}

// Has no Django equivalent -- new in this port. PLAN.md §6.9 R7: the
// /write/ constituency map (wfbn.js) used to build this redirect's target
// by slugifying the clicked polygon's PCON24NM name client-side, which is
// exactly the risk R7 names ("A JS slugify with different Unicode
// handling silently 404s constituencies with apostrophes, accents or
// ampersands") -- confirmed concretely: the map's own transliteration
// table has no entry for ŵ, so "Montgomeryshire and Glyndŵr" built the
// wrong slug even though the correct one already exists. Looked up by the
// ONS PCON24CD code instead (0011_constituency_pcon24cd.sql,
// getConstituencySlugByPcon24cd) -- a stable identifier already carried on
// every parlcon.json feature, so there is no name/Unicode handling to get
// wrong here at all.
export async function writeConstituencyByCode(c: Context<AppEnv>): Promise<Response> {
  const pcon24cd = c.req.param("pcon24cd")!;
  const session = dbSession(c);
  const slug = await getConstituencySlugByPcon24cd(session, pcon24cd);
  if (!slug) return c.notFound();
  return c.redirect(url("write:constituency", slug), 302);
}

// gfwrite `constituency` (GET /write/to/<slug>/). Ported from
// views.py:42-62. Issues the CSRF token the ConstituentDetailsForm below
// carries forward to writeEmail.
export async function writeConstituency(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const constituency = await getConstituencyBySlugNarrow(session, slug);
  if (!constituency) return c.notFound();

  const postcode = c.req.query("postcode") ?? null;
  const turnstilefail = c.req.query("turnstilefail") === "true";
  const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);

  const mapConfig = JSON.stringify({
    geojson: url("wfbn:constituency_geojson", constituency.slug),
    max_zoom: 14,
  });

  const html = await render("write/constituency.njk", {
    ...pageContext(c, c.req.path),
    constituency: { ...constituency, mp_photo_url: mpPhotoUrl(constituency.mp_parl_id) },
    postcode,
    turnstilefail,
    csrf_token: csrfToken,
    turnstile_sitekey: c.env.TURNSTILE_SITEKEY,
    map_config: mapConfig,
  });
  return c.html(html);
}

// gfwrite `email` (POST /write/to/<slug>/email/). Ported from
// views.py:65-122. GET returns 404, matching Django's own `else: return
// HttpResponseNotFound()` -- unlike `send` (R5), this branch was never
// missing in the original.
export async function writeEmail(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const constituency = await getConstituencyBySlugNarrow(session, slug);
  if (!constituency) return c.notFound();

  if (c.req.method !== "POST") return c.notFound();

  const body = await c.req.parseBody();
  const csrfOk = await verifyCsrf(c, c.env.CSRF_SECRET, typeof body.csrf_token === "string" ? body.csrf_token : undefined);
  const turnstileToken = typeof body["cf-turnstile-response"] === "string" ? body["cf-turnstile-response"] : "";
  const turnstileOk = await validateTurnstile(c.env.TURNSTILE_SECRET, turnstileToken);

  // Django's ConstituentDetailsForm fields all have strip=True (CharField/
  // EmailField's own default), so form.is_valid() validates TRIMMED
  // copies -- but email()'s own body reads `request.POST.get("name")` /
  // `.get("email")` directly rather than form.cleaned_data, so the value
  // actually used for the draft letter, from_field, and the stored
  // ConstituencySubscriber row is the RAW, un-trimmed POST value (verified
  // against views.py:76-77,93 and Django's CharField.to_python, which
  // strips only what to_python returns, never mutating request.POST
  // itself). Reproduced exactly: validate trimmed, use raw -- notably this
  // also matters for the test@example.com diversion below (lib/email.ts),
  // which compares the RAW from_email/reply_to, not a trimmed one.
  const name = typeof body.name === "string" ? body.name : "";
  const address = typeof body.address === "string" ? body.address : "";
  const constituentEmail = typeof body.email === "string" ? body.email : "";
  const nameTrimmed = name.trim();
  const addressTrimmed = address.trim();
  const constituentEmailTrimmed = constituentEmail.trim();
  // ConstituentDetailsForm.email = forms.EmailField() declares no
  // max_length override, so Django's real forms.EmailField default
  // applies: 320 (RFC 3696 -- confirmed directly against the installed
  // Django's forms/fields.py, not assumed), not the unrelated 254 that
  // models.EmailField defaults to.
  const formValid =
    nameTrimmed.length > 0 &&
    nameTrimmed.length <= 100 &&
    addressTrimmed.length > 0 &&
    EMAIL_RE.test(constituentEmailTrimmed) &&
    constituentEmailTrimmed.length <= 320;

  if (!csrfOk || !turnstileOk) {
    return c.redirect(`${url("write:constituency", constituency.slug)}?turnstilefail=true`, 302);
  }

  if (!formValid) {
    const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);
    const html = await render("write/constituency.njk", {
      ...pageContext(c, c.req.path),
      constituency: { ...constituency, mp_photo_url: mpPhotoUrl(constituency.mp_parl_id) },
      postcode: null,
      turnstilefail: false,
      form_error: true,
      form_values: { name, address, email: constituentEmail },
      csrf_token: csrfToken,
      turnstile_sitekey: c.env.TURNSTILE_SITEKEY,
      map_config: JSON.stringify({ geojson: url("wfbn:constituency_geojson", constituency.slug), max_zoom: 14 }),
    });
    return c.html(html);
  }

  // typeof guard, same as every other field read from parseBody() -- a
  // multipart part carrying a filename= attribute (however that part got
  // there) comes back as a File, which is always truthy regardless of
  // whether the checkbox was actually checked. Django's equivalent
  // (request.POST.get("subscribe")) would never see a file-typed part at
  // all (Django routes it to request.FILES instead), so an unguarded
  // truthy check here is a real, port-specific divergence.
  if (typeof body.subscribe === "string") {
    await insertConstituencySubscriber(session, {
      email: constituentEmail,
      name,
      parliamentaryConstituencyId: constituency.id,
      parliamentaryConstituencyName: constituency.name,
    });
  }

  const { foodbanks, locations } = await getFoodbanksForConstituency(session, constituency.id);
  const foodbankNames = constituencyFoodbankNames(foodbanks, locations);

  // mp_display_name is nullable (ConstituencyRowNarrow) -- 0/650 production
  // rows are null today, but guard anyway rather than letting a template
  // literal stringify a future null as the literal text "null".
  const toField = `${constituency.mp_display_name ?? ""} <${constituency.email}>`;
  const fromField = `${name} <${constituentEmail}>`;
  const subject = `Food Banks in ${constituency.name}`;
  const draftBody = draftEmailBody({
    address,
    name,
    constituencyName: constituency.name ?? "",
    mpDisplayName: constituency.mp_display_name ?? "",
    foodbankNames,
    now: new Date(),
  });

  const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);
  const html = await render("write/email.njk", {
    ...pageContext(c, c.req.path),
    constituency,
    turnstilefail: false,
    csrf_token: csrfToken,
    turnstile_sitekey: c.env.TURNSTILE_SITEKEY,
    to_field: toField,
    from_field: fromField,
    from_name: name,
    from_email: constituentEmail,
    subject,
    body: draftBody,
  });
  return c.html(html);
}

// gfwrite `send` (POST /write/to/<slug>/email/send/). Ported from
// views.py:125-161. R5: GET returns 405 (Django's real handler has no
// `else` branch at all -- falling through to an implicit `None` return is
// a ValueError -> 500 there). Also R5: the Postmark send's success/failure
// is checked (Django discards send_email()'s return value entirely, so a
// failed send there still shows "Email Sent").
export async function writeSend(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const constituency = await getConstituencyBySlugNarrow(session, slug);
  if (!constituency) return c.notFound();

  if (c.req.method !== "POST") return new Response("", { status: 405 });

  const body = await c.req.parseBody();
  const csrfOk = await verifyCsrf(c, c.env.CSRF_SECRET, typeof body.csrf_token === "string" ? body.csrf_token : undefined);
  const turnstileToken = typeof body["cf-turnstile-response"] === "string" ? body["cf-turnstile-response"] : "";
  const turnstileOk = await validateTurnstile(c.env.TURNSTILE_SECRET, turnstileToken);

  const fromName = typeof body.from_name === "string" ? body.from_name : "";
  const fromEmail = typeof body.from_email === "string" ? body.from_email : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  const emailBody = typeof body.body === "string" ? body.body : "";
  // EmailForm's real declared bounds (forms.py): from_name = CharField(
  // max_length=100, required by default), from_email =
  // EmailField(max_length=100, required) -- narrower than
  // ConstituentDetailsForm.email's 320 (writeEmail above), a real
  // two-stage quirk in Django's own code (the same value gets revalidated
  // against a tighter bound here), reproduced rather than harmonised.
  // subject = CharField(max_length=200); body = CharField(Textarea, no
  // max_length -- genuinely unbounded, matching the lack of an upper check
  // here).
  const formValid =
    fromName.length > 0 &&
    fromName.length <= 100 &&
    fromEmail.length <= 100 &&
    EMAIL_RE.test(fromEmail) &&
    subject.length > 0 &&
    subject.length <= 200 &&
    emailBody.length > 0;

  const rerenderCompose = (flags: { turnstilefail: boolean; sendFailed?: boolean }) =>
    (async () => {
      const csrfToken = await issueCsrfToken(c, c.env.CSRF_SECRET);
      const html = await render("write/email.njk", {
        ...pageContext(c, c.req.path),
        constituency,
        turnstilefail: flags.turnstilefail,
        send_failed: flags.sendFailed ?? false,
        csrf_token: csrfToken,
        turnstile_sitekey: c.env.TURNSTILE_SITEKEY,
        to_field: typeof body.to_field === "string" ? body.to_field : "",
        from_field: typeof body.from_field === "string" ? body.from_field : "",
        from_name: fromName,
        from_email: fromEmail,
        subject,
        body: emailBody,
      });
      return c.html(html);
    })();

  if (!csrfOk || !turnstileOk) return rerenderCompose({ turnstilefail: true });
  if (!formValid) return rerenderCompose({ turnstilefail: false });

  // "readonly" to_field is HTML-only (PLAN.md §6.9 R1) -- the real
  // recipient is always constituency.email from the database, never the
  // submitted to_field text.
  const header = emailHeader(fromName, fromEmail);
  const sent = await sendEmail(c, {
    to: constituency.email ?? "",
    subject,
    textBody: `${header}${emailBody}`,
    cc: fromEmail,
    bcc: "write-bcc@givefood.org.uk",
    replyTo: fromEmail,
  });

  if (!sent) return rerenderCompose({ turnstilefail: false, sendFailed: true });

  return c.redirect(`${url("write:done", constituency.slug)}?email=${encodeURIComponent(fromEmail)}`, 302);
}

// gfwrite `done` (GET /write/to/<slug>/email/done/). Ported from
// views.py:164-176.
export async function writeDone(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const constituency = await getConstituencyBySlugNarrow(session, slug);
  if (!constituency) return c.notFound();

  const email = c.req.query("email") ?? null;
  const html = await render("write/done.njk", {
    ...pageContext(c, c.req.path),
    constituency,
    email,
  });
  return c.html(html);
}
