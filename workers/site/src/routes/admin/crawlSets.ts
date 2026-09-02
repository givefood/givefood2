import type { Context } from "hono";
import { getCrawlSets, getOrphanedCrawlItems, getCrawlSetJson, crawlTypeIcon, isCrawlTypeOption, CRAWL_TYPE_OPTIONS, type CrawlTypeOption } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { adminPageContext } from "./pageContext";

// gfadmin/views.py:3228-3267 crawl_sets() -- both lists are capped at 50 in
// Django and stay capped here: this is a "what ran recently" screen, not an
// archive, and the crawl-set detail page is where a single run gets read.
const CRAWL_SET_LIMIT = 50;
const ORPHANED_LIMIT = 50;

// Django returns HttpResponseForbidden for an unrecognised ?type=/?adhoc_type=
// rather than ignoring it. Kept: silently showing every type when the caller
// asked for one is a wrong answer, not a fallback (see crawlSets.ts).
function parseTypeFilter(raw: string | undefined): CrawlTypeOption | null | "invalid" {
  if (!raw) return null;
  return isCrawlTypeOption(raw) ? raw : "invalid";
}

export async function adminCrawlSetsList(c: Context<AppEnv>): Promise<Response> {
  const typeFilter = parseTypeFilter(c.req.query("type"));
  const adhocFilter = parseTypeFilter(c.req.query("adhoc_type"));
  if (typeFilter === "invalid") return c.text("Invalid crawl type filter", 403);
  if (adhocFilter === "invalid") return c.text("Invalid adhoc type filter", 403);

  const db = dbSession(c);
  const [crawlSets, orphaned] = await Promise.all([
    getCrawlSets(db, typeFilter, CRAWL_SET_LIMIT),
    getOrphanedCrawlItems(db, adhocFilter, ORPHANED_LIMIT),
  ]);

  const html = await render("admin/crawl_sets.njk", {
    ...(await adminPageContext(c, "crawl_sets")),
    crawl_sets: crawlSets.map((cs) => ({
      ...cs,
      crawl_type_icon: crawlTypeIcon(cs.crawl_type),
      // CrawlSet.time_taken() renders a timedelta's str(); seconds is the
      // honest equivalent and matches the JSON endpoint's own `time_taken`.
      time_taken: cs.time_taken_seconds === null ? null : `${cs.time_taken_seconds} s`,
    })),
    orphaned_crawl_items: orphaned.map((i) => ({ ...i, crawl_type_icon: crawlTypeIcon(i.crawl_type) })),
    crawl_type_options: CRAWL_TYPE_OPTIONS,
    crawl_type_filter: typeFilter ?? "",
    adhoc_type_filter: adhocFilter ?? "",
  });
  return c.html(html);
}

// gfadmin/views.py:3270-3280 crawl_set() -- reuses getCrawlSetJson (WP 6.7)
// for the initial server render as well as the poll, so the page and its own
// polling refresh can never disagree about shape. Django runs two near-
// identical querysets for the same reason and they have drifted before.
export async function adminCrawlSetDetail(c: Context<AppEnv>): Promise<Response> {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.notFound();

  const data = await getCrawlSetJson(dbSession(c), id);
  if (!data) return c.notFound();

  const html = await render("admin/crawl_set.njk", {
    ...(await adminPageContext(c, "crawl_sets")),
    crawl_set: {
      id,
      crawl_type: data.crawl_type,
      crawl_type_icon: crawlTypeIcon(data.crawl_type),
      start: data.start,
      finish: data.finish,
      time_taken: data.time_taken === null ? null : `${data.time_taken} s`,
      item_count: data.item_count,
      object_count: data.object_count,
    },
    crawl_items: data.items,
  });
  return c.html(html);
}
