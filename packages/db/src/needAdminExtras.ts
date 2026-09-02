import type { Session } from "./types";
import { recomputeFoodbankNeedFields } from "./needAdmin";

// WP 6.8 "need-extras" (PLAN.md §10.2.7): the two need endpoints WP 6.4/6.5
// left out of the admin --
//   * gfadmin/views.py:1916-1946 need_form's CREATE branch (`id = None`),
//     reached from gfadmin/urls/needs.py:10's `need/new`; and
//   * gfadmin/views.py:2023-2038 need_email, the subscriber-notification
//     preview, whose HTML body needs Foodbank.articles_month().
//
// Deliberately its own file rather than appended to needAdmin.ts: this
// landed in parallel with other work packages editing that file, and
// packages/db/src/index.ts re-exports per file, so one `export * from
// "./needAdminExtras"` line wires the whole thing up.

// ---------------------------------------------------------------------------
// /admin/need/new/  --  gfadmin/views.py:1916-1946 need_form, create branch
// ---------------------------------------------------------------------------

export interface InsertAdminNeedParams {
  foodbankId: number | null;
  foodbankName: string | null;
  changeText: string;
  excessChangeText: string | null;
  published: boolean;
}

export interface InsertedAdminNeed {
  /** The numeric rowid -- what TranslateNeedMessage (workers/jobs/src/queues/translateNeed.ts) is keyed on. */
  id: number;
  /** The public 32-char dashless need_id -- what every /admin/need/... URL uses. */
  needId: string;
}

// A hand-created FoodbankChange, following givefood/models/needs.py:285-317
// FoodbankChange.save()'s insert path in order:
//
//  1. need_id = uuid4 (field default, needs.py:54). Stored dashless here, the
//     same shape needcheck.ts's insertFoodbankChange writes and getNeedByUuid
//     normalises to (0001_core.sql:107). need_id_str is not a column -- it is
//     computed at read time.
//  2. input_method = set_input_method() (needs.py:108-112), which returns
//     "scrape" only when distill_id is set. distill_id is one of NeedForm's
//     excludes (givefood/forms.py:231-236), so a need created through this
//     form is ALWAYS "typed" -- hardcoded rather than parameterised.
//  3. foodbank_name denormalised from the chosen food bank (needs.py:292-293).
//  4. change_text/excess_change_text cleaned -- NOT done here, see the
//     UNCLEANED TEXT note on the route handler
//     (workers/site/src/routes/admin/needNew.ts). This matches the port's
//     existing edit path (updateNeedRawFields), which does not clean either.
//  5. INSERT.
//  6. foodbank resave -> last_need/latest_need recompute.
//
// change_text_original / excess_change_text_original are left NULL:
// NeedForm excludes both, and Django's save() never populates them on a
// typed need either. Only needcheck.ts:166's `VALUES (..?5, ?5..)` does,
// for the AI extraction path where the "original" genuinely differs.
//
// nonpertinent and is_categorised are written as explicit 0, not left NULL
// -- `nonpertinent = 0` in SQL excludes NULL, so an explicit 0 is what
// actually puts a new row in the review queue (same reasoning, and the same
// literal values, as needcheck.ts's insertFoodbankChange).
//
// DIVERGENCE, deliberate: Django recomputes the food bank's cached need
// fields only when the new need is published (`if self.foodbank and
// self.published and do_foodbank_save`, needs.py:301-302), which leaves
// `last_need` (a plain "when did we last see ANY need" timestamp) stale
// after an unpublished insert. Recomputed unconditionally here whenever a
// food bank is set -- the same fix needAdmin.ts's recomputeFoodbankNeedFields
// comment already documents for the unpublish path.
export async function insertAdminNeed(session: Session, params: InsertAdminNeedParams): Promise<InsertedAdminNeed> {
  const now = new Date().toISOString();
  const needId = crypto.randomUUID().replace(/-/g, "");
  const result = await session
    .prepare(
      `INSERT INTO foodbankchange
         (need_id, foodbank_id, foodbank_name, change_text, excess_change_text,
          input_method, published, nonpertinent, is_categorised, created, modified)
       VALUES (?1, ?2, ?3, ?4, ?5, 'typed', ?6, 0, 0, ?7, ?7)`,
    )
    .bind(needId, params.foodbankId, params.foodbankName, params.changeText, params.excessChangeText, params.published ? 1 : 0, now)
    .run();

  if (params.foodbankId !== null) await recomputeFoodbankNeedFields(session, params.foodbankId);
  return { id: result.meta.last_row_id, needId };
}

// ---------------------------------------------------------------------------
// /admin/need/:id/email/  --  what wfbn/emails/notification.{txt,html} read
// ---------------------------------------------------------------------------

export interface NeedEmailFoodbankRow {
  id: number;
  slug: string;
  name: string;
  alt_name: string | null;
  no_donation_points: number | null;
}

// The notification email templates touch exactly five food bank fields
// (slug, and name/alt_name via full_name(), plus no_donation_points for the
// "Find donation points" line). A narrow SELECT rather than reusing
// getFoodbankBySlug/getFoodbanksByIds, both of which do `SELECT *` and then
// a second query for latest_need -- neither of which this path needs.
export async function getFoodbankForNeedEmail(session: Session, foodbankId: number): Promise<NeedEmailFoodbankRow | null> {
  return session
    .prepare("SELECT id, slug, name, alt_name, no_donation_points FROM foodbank WHERE id = ?")
    .bind(foodbankId)
    .first<NeedEmailFoodbankRow>();
}

export interface NeedEmailArticleRow {
  id: number;
  published_date: string;
  title: string;
  url: string;
}

// Foodbank.articles_month() -- givefood/models/foodbank.py:573-575:
// `FoodbankArticle.objects.filter(foodbank=self,
//  published_date__gte=timezone.now() - timedelta(days=28))
//  .order_by("-published_date")`. Unbounded in Django and unbounded here:
// it is one food bank's own RSS output over 28 days, which is inherently a
// handful of rows, and a LIMIT would silently change what 5,855 subscribers
// see in the "News from..." block.
//
// COMPARED ON THE DATE PREFIX, not the whole timestamp. foodbankarticle
// holds two different timestamp spellings: rows migrated from Postgres are
// "YYYY-MM-DD HH:MM:SS.ffffff" (tools/pg-to-d1/extract_core.py:313's
// strftime) while rows the article crawler inserts are ISO-8601 with a "T"
// and a "Z" (workers/jobs/src/queues/articles.ts:72's toISOString()). A
// plain `>=` between those two spellings mis-sorts on the cutoff day
// itself, because " " (0x20) sorts before "T" (0x54). substr(...,1,10) is
// identical in both spellings, so the comparison is format-agnostic.
// The cost is day granularity instead of Django's exact-instant
// granularity: an article published earlier on the 28-days-ago day is
// included where Django would drop it. Bounded to <24h on a "news from the
// last month" block, and preferable to a silent off-by-a-day on the
// crawler's own rows.
//
// KNOWN DATA-SCOPE GAP (carried forward from
// workers/site/src/routes/wfbn/md/newsCharity.ts): foodbankarticle was
// backfilled in full on 2026-08-31, but any food bank whose RSS has not
// been crawled since will show fewer articles here than production does.
export async function getArticlesForNeedEmail(session: Session, foodbankId: number, cutoffDate: string): Promise<NeedEmailArticleRow[]> {
  const result = await session
    .prepare(
      "SELECT id, published_date, title, url FROM foodbankarticle " +
        "WHERE foodbank_id = ?1 AND substr(published_date, 1, 10) >= ?2 ORDER BY published_date DESC",
    )
    .bind(foodbankId, cutoffDate)
    .all<NeedEmailArticleRow>();
  return result.results;
}
