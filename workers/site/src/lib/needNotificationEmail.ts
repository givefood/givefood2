import { djangoDate } from "@givefood/templates";
import { getArticlesForNeedEmail, getFoodbankForNeedEmail, type FoodbankChangeRow, type Session } from "@givefood/db";
import { fullNameLocaleAware, slugify, titleCapitalised, urlWithRefFoodbank } from "./fields";

// The precomputed context behind gfwfbn/templates/wfbn/emails/notification.txt
// and .html -- ported here as packages/templates/templates/emails/
// need_notification_txt.njk and need_notification.njk.
//
// Django's templates call model METHODS the template layer invokes for
// free: need.foodbank.full_name(), need.excess_list(),
// need.foodbank_name_slug(), need.foodbank.articles_month(), and per
// article title_captialised()/url_with_ref(). nunjucks cannot call a
// method on a plain D1 row, so every one of them is resolved here instead.
//
// Built as ONE shared builder rather than inline in the preview route
// because the send path (POST /admin/need/:id/notifications/, still
// unbuilt -- see that route's absence and this file's sibling note in the
// WP 6.8 report) must render the SAME body the preview shows. Two
// independently-assembled contexts would drift, and the whole point of
// gfadmin/views.py:2023-2038's preview is that the maintainer can trust it.

export interface NeedEmailArticleContext {
  /** FoodbankArticle.title_captialised() -- articles.py:35-49. */
  title_captialised: string;
  /** FoodbankArticle.url_with_ref() -- articles.py:29-33. */
  url_with_ref: string;
  /**
   * Django renders `{{ article.published_date }}` bare in notification.html.
   * With USE_L10N=True / LANGUAGE_CODE="en" / USE_TZ=False
   * (givefood/settings.py:209-213) that localises through the en
   * DATETIME_FORMAT, i.e. "N j, Y, P" -- this codebase's standing
   * bare-datetime convention. Formatted here rather than in the template so
   * a malformed legacy timestamp can never 500 the preview page.
   */
  published_date: string;
}

export interface NeedEmailContext {
  full_name: string;
  foodbank_slug: string;
  change_text: string;
  /** FoodbankChange.excess_list() -- needs.py:137-141. */
  excess_list: string[];
  has_excess: boolean;
  /** The four utm params every internal link in notification.html carries. Rendered with |safe so the "&" stays a literal "&", as in the Django original. */
  utm: string;
  articles: NeedEmailArticleContext[];
  show_donation_points: boolean;
  subscriber_created_date: string;
  subscriber_created_time: string;
  unsub_key: string;
}

/** The subscriber half of the email context -- null in the preview, see buildNeedEmailContext. */
export interface NeedEmailSubscriber {
  created: string;
  unsub_key: string;
}

const ARTICLES_MONTH_DAYS = 28; // Foodbank.articles_month() -- foodbank.py:573-575

export async function buildNeedEmailContext(
  session: Session,
  need: FoodbankChangeRow,
  subscriber: NeedEmailSubscriber | null,
): Promise<NeedEmailContext | null> {
  if (need.foodbank_id === null) return null;
  const foodbank = await getFoodbankForNeedEmail(session, need.foodbank_id);
  if (!foodbank) return null;

  const cutoff = new Date(Date.now() - ARTICLES_MONTH_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const articleRows = await getArticlesForNeedEmail(session, foodbank.id, cutoff);

  // The emails are English-only: no wfbn/emails/* template loads {% i18n %},
  // and localising them would visibly change mail 5,855 people already
  // receive. fullNameLocaleAware is called with a fixed "en" rather than the
  // request's locale for that reason.
  const fullName = fullNameLocaleAware(foodbank.name, foodbank.alt_name, "en");

  // need.foodbank_name_slug (needs.py:90-91) is slugify() over the
  // DENORMALISED foodbank_name column, not over the live foodbank.name --
  // they can differ after a rename, and the utm_campaign value in every
  // already-sent email used the denormalised one.
  const foodbankNameSlug = slugify(need.foodbank_name ?? "");
  const utm = `utm_source=notificationemail&utm_medium=email&utm_campaign=${foodbankNameSlug}-${djangoDate(need.created, "Y-m-d")}`;

  return {
    full_name: fullName,
    foodbank_slug: foodbank.slug,
    change_text: need.change_text,
    excess_list: need.excess_change_text ? need.excess_change_text.split("\n") : [],
    has_excess: !!need.excess_change_text,
    utm,
    articles: articleRows.map((article) => ({
      title_captialised: titleCapitalised(article.title),
      url_with_ref: safeUrlWithRef(article.url),
      published_date: djangoDate(article.published_date, "N j, Y, P"),
    })),
    // `!= 0` in BOTH templates (notification.txt line 16, notification.html
    // line 25), and in Python `None != 0` is TRUE -- so a food bank whose
    // donation-point count has never been computed still gets the line.
    // Reproduced with an explicit `!== 0` on a nullable column.
    //
    // This deliberately DIFFERS from routes/wfbn/updates.ts's
    // confirmedEmailBodies, which uses plain truthiness for the *confirmed*
    // email (and so hides the line when the count is NULL). Both match their
    // own Django original; do not "harmonise" them.
    show_donation_points: foodbank.no_donation_points !== 0,
    // gfadmin/views.py:2035 passes ONLY {need} -- never {subscriber} -- so
    // the preview genuinely renders "...you subscribed to them at
    // www.givefood.org.uk on  at ." with an empty unsubscribe key.
    // Reproduced, not "fixed": that is what the shipped preview shows, and
    // inventing a fake subscriber would make the preview lie about the one
    // paragraph that is per-recipient in the real mail.
    subscriber_created_date: subscriber ? formatSubscribedDate(subscriber.created) : "",
    subscriber_created_time: subscriber ? formatSubscribedTime(subscriber.created) : "",
    unsub_key: subscriber ? subscriber.unsub_key : "",
  };
}

// FoodbankArticle.url_with_ref() goes through Python's PreparedRequest,
// which tolerates a lot; urlWithRefFoodbank() uses `new URL()`, which
// throws on a malformed stored url. A single bad row in a food bank's RSS
// history must not 500 the preview page it appears on, so the raw url is
// used as-is when it will not parse.
function safeUrlWithRef(url: string): string {
  try {
    return urlWithRefFoodbank(url);
  } catch {
    return url;
  }
}

// `{{ subscriber.created|date:"jS F Y" }}` and `|date:"g:i a"`. Not routed
// through @givefood/templates' djangoDate: its DATE_FORMAT_TOKENS table
// (packages/templates/src/filters.ts:99-124) has no F, g or a token yet,
// and adding three tokens to a filter every ported template shares is a
// change for the work package that actually needs them -- the send path.
// Both functions are unreachable from the preview route, which always
// passes subscriber = null; they exist so the send path has one correct
// implementation waiting rather than inventing a second one.
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parseStoredUtc(value: string): Date {
  const withT = value.includes(" ") ? value.replace(" ", "T") : value;
  const hasTime = withT.includes("T");
  return new Date(`${hasTime ? withT.replace(/Z$/, "") : `${withT}T00:00:00`}Z`);
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  const last = day % 10;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

export function formatSubscribedDate(created: string): string {
  const d = parseStoredUtc(created);
  return `${ordinalSuffix(d.getUTCDate())} ${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatSubscribedTime(created: string): string {
  const d = parseStoredUtc(created);
  const hours24 = d.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hours12}:${minutes} ${hours24 < 12 ? "a.m." : "p.m."}`;
}
