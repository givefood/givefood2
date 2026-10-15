// THE FOOD BANK CHECK, as a plain function over a D1 session -- no queue, no
// admin_job row, no Worker of its own. github #38: it used to run as a
// "foodbank-check" queue message and the admin's tab polled an admin_job row
// until it finished. Measured on production, that took 37-40 s wall clock for
// six of the seven checks ever run, and about 30 s of it was the `jobs`
// queue's own `max_batch_timeout: 30` -- an admin presses Check once, the
// batch never fills, and the message waits out the full timeout before the
// consumer is even invoked. The work itself is ~7-10 s.
//
// So the queue was costing four times what the work cost, to buy an
// architecture whose whole point was not making the reviewer wait. The
// maintainer's call (github #38) is to go back to Django's shape: do it
// inline, render the answer, no job row and nothing to poll.
//
// IT LIVES IN A PACKAGE BECAUSE TWO WORKERS COULD OTHERWISE HOLD TWO COPIES.
// workers/site now runs it on the check page; workers/jobs still owns
// geminiJsonCall for the order-lines parse. A 300-line comparison algorithm
// duplicated across two deployed Workers is the drift this repo avoids
// everywhere else (see schema.testkit.ts's header for the same argument about
// fixture schemas), so the algorithm moved here and both Workers import it.
//
// Ported from gfadmin/views.py:861-1011 _build_foodbank_check_data +
// views.py:1138-1215 foodbank_check.
import type { Session } from "@givefood/db";
import { getFoodbankBySlug, getLocationsByFoodbankIdNarrow, getDonationPointsByFoodbankId } from "@givefood/db";
import { geminiJsonCall } from "./gemini";
import { buildCheckPrompt, FOODBANK_CHECK_RESPONSE_SCHEMA, CHECK_USE_AI_FIELDS, type FoodbankCheckAiResponse } from "./checkPrompt";
import { pyNow } from "@givefood/models";

const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

// gfadmin/views.py:861-1011 _build_foodbank_check_data's htmlbodytext() --
// BeautifulSoup decomposing svg/style/script/iframe/canvas and returning
// soup.body.get_text(). Same HTMLRewriter pattern as needcheck/scrape.ts's
// scrapeFacebook(), kept as its own small copy rather than a shared
// import -- this WP's fetches are plain GETs with no retry/anti-bot logic,
// a materially simpler case than that pipeline's.
// Same headers and one-shot retry as routes/admin/proxy.ts's fetchPreview, for
// the same reason: several food bank sites sit behind bot protection that
// intermittently 403s a bot-UA request with no Accept header coming from
// Cloudflare's network. It matters more here than on the preview, because a
// blocked fetch here does not surface as an error -- it returns null, the page
// is reported to the model and the admin as "not found", and the AI comparison
// is then made against a page we simply failed to read.
const PAGE_HEADERS: Record<string, string> = {
  "User-Agent": BOT_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

// One retry after 750ms on a 403 or 429, each attempt with its own 20s
// timeout. Shared by the page GETs and the donation point finder's POST below,
// which goes to the same foodbank.org.uk hosts and meets the same protection.
async function fetchWithOneRetry(url: string, init: RequestInit): Promise<Response> {
  let res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (res.status === 403 || res.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  }
  return res;
}

async function fetchPageBodyText(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchWithOneRetry(url, { headers: PAGE_HEADERS });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    // Logged rather than swallowed: "the site blocked us" and "this page does
    // not exist" reach the check page as the same empty result, and only the
    // log distinguishes them.
    console.log(`foodbank-check: ${url} returned ${res.status}, treating the page as not found`);
    return null;
  }

  let text = "";
  const rewriter = new HTMLRewriter()
    .on("svg, style, script, iframe, canvas", {
      element(el) {
        el.remove();
      },
    })
    .on("body", {
      text(chunk) {
        text += chunk.text;
      },
    });
  await rewriter.transform(res).text();
  return text;
}

// THE FOODBANK.ORG.UK DONATION POINT FINDER, github #63. Every food bank on
// the white-label platform (53 open ones when this was written) points
// donation_points_url at its own /support-us/donate-food, and that page lists
// no donation points at all -- it is a postcode box. The list arrives only
// after a search, from a Next.js Server Action the page's own JS POSTs to. So
// the page text the model reads holds nothing to find, and every check on
// these food banks came back with no found donation points, flagging every
// one we hold as a discrepancy with a Delete button beside it.
//
// Django made this call (gfadmin/views.py:955-987) and appended the reply to
// the donation_points page text; WP 6.8 left it out as a disclosed
// simplification. Restored here the same way, except that the reply is parsed
// and laid out as name and address blocks rather than handed to the model as
// raw RSC wire format with opening hours and phone numbers in it.
//
// THE ACTION ID IS THE PLATFORM'S BUILD ARTEFACT, NOT AN API. Next.js derives
// it from the action's source file and export, so it changes whenever the
// platform moves or upgrades that code. Django's
// (b8d1dab7508947f9e5f96fd1d7ebdbeb402a31ac) had already gone stale and
// answers "400 Invalid Server Action request." -- and Django never noticed,
// because it pasted that sentence into the prompt and the model found nothing
// in it. So a reply that is not a result list is an ERROR here, carried on
// the result and shown on the check page, never quietly an empty list.
//
// When that notification appears, the new ID is in one of the JS chunks the
// donate-food page loads: the `createServerReference)("<id>", ...)` whose
// variable is called as `await x(<foodBank>.id, lat, lng, page)`. The ID was
// discovered that way for this fix; doing it on every check instead would
// mean downloading the page's ~2.8 MB of chunks and pattern-matching minified
// code that changes as freely as the ID does.
const DONATION_POINT_FINDER_ACTION = "781623cbf05ebf81aee85060224b1bdafb59f142a5";

// views.py:955's test, verbatim.
const DONATION_POINT_FINDER_PAGE = "foodbank.org.uk/support-us/donate-food";

export interface DonationPointFinderOutcome {
  // The page URL the action was POSTed to, with the query string the site's
  // own search puts there -- opened in a browser it shows the same list. Null
  // when the call was never made.
  url: string | null;
  count: number | null;
  error: string | null;
}

interface FinderPoint {
  title?: string | null;
  address?: { addressLine1?: string | null; addressLine2?: string | null; locality?: string | null; postalCode?: string | null } | null;
}

// The reply is React Server Components wire format: one `<row id>:<json>`
// per line, the first row pointing at the second, which holds
// `{"results": [...], "pageInfo": ...}`. Called without the fourth `page`
// argument -- as the page's map view calls it -- the action answers every
// point at once rather than a page of them.
function parseFinderReply(body: string): FinderPoint[] | null {
  for (const line of body.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    try {
      const row = JSON.parse(line.slice(colon + 1)) as { results?: unknown };
      if (row && Array.isArray(row.results)) return row.results as FinderPoint[];
    } catch {
      // Not every row is JSON (RSC text rows are `T<length>,<text>`).
    }
  }
  return null;
}

function finderPointText(point: FinderPoint): string {
  const a = point.address ?? {};
  return [point.title, a.addressLine1, a.addressLine2, a.locality, a.postalCode]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join("\n");
}

async function fetchDonationPointFinder(
  donationPointsUrl: string,
  networkId: string | null,
  latLng: string,
  postcode: string | null,
): Promise<{ outcome: DonationPointFinderOutcome; text: string | null; start: string | null; finish: string | null }> {
  // Every platform food bank has one today. A new one added without it gets
  // told which field to fill rather than a silent gap.
  if (!networkId) {
    return { outcome: { url: null, count: null, error: "No network id on this food bank, so the foodbank.org.uk donation point finder was not asked. Set it on the edit form." }, text: null, start: null, finish: null };
  }
  const [lat, lng] = latLng.split(",").map((part) => part.trim());
  const url = `${donationPointsUrl}?lat=${encodeURIComponent(lat ?? "")}&lng=${encodeURIComponent(lng ?? "")}&address=${encodeURIComponent(postcode ?? "")}`;
  const fail = (error: string) => ({ outcome: { url, count: null, error }, text: null });

  const start = pyNow();
  let res: Response;
  let body: string;
  try {
    // Headers and body as the page's own JS sends them: lat and lng are
    // strings because the browser reads them back out of its query string.
    res = await fetchWithOneRetry(url, {
      method: "POST",
      headers: {
        "User-Agent": BOT_USER_AGENT,
        Accept: "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
        "Next-Action": DONATION_POINT_FINDER_ACTION,
      },
      body: JSON.stringify([networkId, lat, lng]),
    });
    body = await res.text();
  } catch (err) {
    return { ...fail(`The foodbank.org.uk donation point finder could not be reached: ${err instanceof Error ? err.message : String(err)}`), start, finish: pyNow() };
  }
  const finish = pyNow();

  const points = res.status === 200 ? parseFinderReply(body) : null;
  if (points === null) {
    const said = body.trim().slice(0, 200);
    console.log(`foodbank-check: donation point finder ${url} returned ${res.status}: ${said}`);
    return {
      ...fail(`The foodbank.org.uk donation point finder answered ${res.status}${said ? ` (${said})` : ""} instead of a list, so found donation points are missing from this check. If it says the action is invalid, its ID in packages/ai/src/foodbankCheck.ts has changed.`),
      start,
      finish,
    };
  }

  const text = points.length > 0 ? `Donation points listed by the food bank's donation point finder...\n${points.map(finderPointText).join("\n\n")}` : "The food bank's donation point finder lists no donation points.";
  return { outcome: { url, count: points.length, error: null }, text, start, finish };
}

export interface FoodbankCheckResult {
  prompt: string;
  aiResponse: FoodbankCheckAiResponse;
  fetchedPages: { name: string; url: string; found: boolean; proxyField: string }[];
  detailChanges: Record<string, boolean>;
  ourLocations: { slug: string; name: string; address: string | null; postcode: string | null; discrepancy: boolean }[];
  foundLocations: { name: string; address: string; postcode: string; discrepancy: boolean }[];
  ourDonationPoints: { slug: string; name: string; address: string | null; postcode: string; discrepancy: boolean }[];
  foundDonationPoints: { name: string; address: string; postcode: string; discrepancy: boolean }[];
  // Null for a food bank not on the foodbank.org.uk platform.
  donationPointFinder: DonationPointFinderOutcome | null;
}

function normalisePostcode(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

// AI string nulls -- views.py:1182-1188 normalizes "none"/"null"/"nothing"
// (case-insensitive) to Python None before comparing.
function normaliseAiString(value: string | undefined): string {
  const v = (value ?? "").trim();
  return ["none", "null", "nothing"].includes(v.toLowerCase()) ? "" : v;
}

// gfadmin/views.py:1195 -- phone_number is the one detail field Django
// normalises before comparing: it strips spaces from BOTH sides (the model's
// save() strips them too, givefood/models/foodbank.py:649-650), so
// "01234 567890" held against "01234567890" found is not a change. Every
// other field in detail_changes is a plain string compare. All whitespace is
// stripped here rather than Django's literal spaces only, so the comparison
// agrees with the port's own write path (routes/admin/useAi.ts:41, which
// strips /\s+/ before storing).
function normaliseForCompare(field: string, value: string): string {
  return field === "phone_number" ? value.replace(/\s+/g, "") : value;
}

// Throws on failure rather than recording it. The caller decides what a
// failure looks like: the check page renders the message in a notification
// and keeps the rest of the page usable.
export async function runFoodbankCheck(session: Session, foodbankSlug: string, geminiApiKey: string): Promise<FoodbankCheckResult> {
  const foodbank = await getFoodbankBySlug(session, foodbankSlug);
  if (!foodbank) throw new Error(`no such foodbank: ${foodbankSlug}`);

  // NARROW, not the unprojected `SELECT *` (github #52's closing observation,
  // fourth and last caller). Every read of these rows names its field --
  // `postcode` for the discrepancy sets, and slug/name/address/postcode for
  // `ourLocations` and the prompt's location list -- so boundary_geojson was
  // pure freight. The `...l` spreads further down are over aiResponse's rows,
  // not these. On canterbury that is 2,319,826 -> 19,532 bytes at unchanged
  // rows_read; this job runs per food bank, so it paid that on every check of
  // the 7 food banks that carry a boundary at all.
  const [locations, donationPoints] = await Promise.all([getLocationsByFoodbankIdNarrow(session, foodbank.id), getDonationPointsByFoodbankId(session, foodbank.id)]);

  // Django's 6th fetch, the foodbank.org.uk donation point finder
  // (views.py:955-987), is fetchDonationPointFinder above -- github #63.
  // Django's network_id auto-backfill, a regex-scrape of the food bank's own
  // pages, is still not built: every open platform food bank already has one.
  // proxyField matches WP 6.3's allowlisted proxy field names exactly
  // (lib/adminFormFields.ts's FOODBANK_FIELDS url-kind fields) -- the
  // check page's preview iframes go through that same proxy.
  const candidatePages: { name: string; url: string | null; proxyField: string }[] = [
    { name: "homepage", url: foodbank.url, proxyField: "url" },
    {
      name: "shopping_list",
      url: foodbank.shopping_list_url.includes("facebook.com") || foodbank.shopping_list_url.includes("bankthefood.org") ? null : foodbank.shopping_list_url,
      proxyField: "shopping_list_url",
    },
    { name: "locations", url: foodbank.locations_url, proxyField: "locations_url" },
    { name: "contacts", url: foodbank.contacts_url, proxyField: "contacts_url" },
    { name: "donation_points", url: foodbank.donation_points_url, proxyField: "donation_points_url" },
  ];

  // CONCURRENT, github #38. These were fetched one after another, each
  // followed by its own awaited INSERT -- so five sites and five D1 round
  // trips in series, on a path a reviewer is now watching. They are five
  // independent GETs to five URLs with nothing shared between them, so the
  // serialisation bought nothing; the timings recorded per page are still
  // that page's own.
  //
  // Five at once is polite enough. It is fewer than the six connections a
  // browser opens to a single host, these are usually spread across more than
  // one host anyway (the shopping list and donation points often sit
  // elsewhere), and it happens once per manual check rather than on a crawl
  // schedule -- unlike needcheck-render, whose max_batch_size of 5 exists
  // precisely to be gentle with food banks' own hosting.
  //
  // The donation point finder is a sixth request alongside them, which is
  // still no more than a browser would open. It needs nothing from the
  // donate-food page itself, so it does not wait for it.
  const [fetched, finder] = await Promise.all([
    Promise.all(
      candidatePages.map(async (page) => {
        if (!page.url) return { page, text: null, start: null, finish: null };
        const start = pyNow();
        const text = await fetchPageBodyText(page.url);
        return { page, text, start, finish: pyNow() };
      }),
    ),
    foodbank.donation_points_url?.includes(DONATION_POINT_FINDER_PAGE)
      ? fetchDonationPointFinder(foodbank.donation_points_url, foodbank.network_id, foodbank.lat_lng, foodbank.postcode)
      : null,
  ]);

  // gfadmin/views.py's CrawlItem bookkeeping -- crawl_type "check", no
  // crawl_set (matches Django: these check-crawls are never grouped into a
  // CrawlSet). ONE batch rather than one awaited INSERT per page: same rows,
  // one round trip. Skipped entirely when no page had a URL, so a food bank
  // with nothing to crawl does not pay for an empty batch. The finder's POST
  // gets a row of its own after the pages', as Django's did.
  const crawls: { start: string | null; finish: string | null; url: string | null }[] = fetched
    .filter((f) => f.start !== null)
    .map((f) => ({ start: f.start, finish: f.finish, url: f.page.url }));
  if (finder?.start) crawls.push({ start: finder.start, finish: finder.finish, url: finder.outcome.url });
  const crawlItems = crawls.map((crawl) =>
    session
      .prepare("INSERT INTO crawlitem (crawl_type, start, finish, foodbank_id, url) VALUES ('check', ?, ?, ?, ?)")
      .bind(crawl.start, crawl.finish, foodbank.id, crawl.url),
  );
  if (crawlItems.length > 0) await session.batch(crawlItems);

  // Promise.all preserves input order, so both of these stay in
  // candidatePages order -- which is the order the prompt lists the pages in
  // and the order the check page's preview tabs appear in.
  //
  // The finder's list goes under the donation_points page, after its text, as
  // views.py:984-986 put it -- and stands alone if the page itself could not
  // be read, since the list does not come from it.
  const pageTexts = fetched.map((f) => {
    if (f.page.name !== "donation_points" || !finder?.text) return { name: f.page.name, text: f.text };
    return { name: f.page.name, text: f.text === null ? finder.text : `${f.text}\n${finder.text}` };
  });
  // `f.start !== null` and NOT `f.page.url !== null`: a food bank whose
  // locations_url is the EMPTY STRING has a url that is falsy but not null,
  // and the fetch above skips it on the same `if (!page.url)` test Django
  // used. Filtering on null here kept those pages in the list as
  // `found: false` with a blank URL, which put a dead preview tab on the
  // check page. Both filters key off the timestamp instead, which exists only
  // when a fetch really happened.
  const fetchedPages: FoodbankCheckResult["fetchedPages"] = fetched
    .filter((f) => f.start !== null)
    .map((f) => ({ name: f.page.name, url: f.page.url!, found: f.text !== null, proxyField: f.page.proxyField }));

  const foodbankJson = JSON.stringify(
    {
      details: {
        name: foodbank.name,
        address: foodbank.address,
        postcode: foodbank.postcode,
        country: foodbank.country,
        phone_number: foodbank.phone_number,
        contact_email: foodbank.contact_email,
        network: foodbank.network,
        charity_number: foodbank.charity_number,
        facebook_page: foodbank.facebook_page,
        bankuet_slug: foodbank.bankuet_slug,
        rss_url: foodbank.rss_url,
        news_url: foodbank.news_url,
        donation_points_url: foodbank.donation_points_url,
        locations_url: foodbank.locations_url,
        contacts_url: foodbank.contacts_url,
      },
      locations: locations.map((l) => ({ name: l.name, address: l.address, postcode: l.postcode })),
      donation_points: donationPoints.map((d) => ({ name: d.name, address: d.address, postcode: d.postcode })),
    },
    null,
    2,
  );

  const prompt = buildCheckPrompt({ foodbankFullName: foodbank.name, foodbankJson, pages: pageTexts });

  // BUDGETS FOR A BROWSER TAB, NOT A QUEUE CONSUMER (github #38). The
  // defaults are ai.py's -- a 60 s sleep before the single retry and a 120 s
  // per-attempt timeout -- which were fine while this ran on a queue and are
  // wrong now that a reviewer is watching. Cloudflare's edge gives up on a
  // response at around 100 s, so the defaults could spend the entire budget
  // sleeping and still hand back nothing. 2 s and 25 s keep the worst case
  // (attempt, sleep, attempt) inside about 52 s, which still fits.
  const aiResponse = (await geminiJsonCall({
    apiKey: geminiApiKey,
    model: "gemini-2.5-flash",
    prompt,
    temperature: 0,
    responseSchema: FOODBANK_CHECK_RESPONSE_SCHEMA,
    retryDelayMs: 2_000,
    timeoutMs: 25_000,
  })) as FoodbankCheckAiResponse;

  // gfadmin/views.py:1186-1188 -- Django rewrites check_result["details"]
  // IN PLACE with the nullish-normalised values, before both the
  // comparison and the render. That matters twice over: a field the model
  // answered "none" for shows as empty in the Found column, and check.html
  // suppresses its "Use" button on the same truthiness test, so the button
  // can never offer to write the literal string "none" into the field.
  for (const key of Object.keys(aiResponse.details) as (keyof typeof aiResponse.details)[]) {
    aiResponse.details[key] = normaliseAiString(aiResponse.details[key]);
  }

  // gfadmin/views.py:1195-1204 -- detail_changes is a plain inequality per
  // field over a FIXED key list, so "we hold a value the AI did not find"
  // IS a change and the row highlights, warning the reviewer that what we
  // hold may now be stale. The "Use" button is gated separately in the
  // template on the found value being non-empty (check.html:80 et seq,
  // `{% if detail_changes.x and check_result.details.x %}`) -- that test
  // belongs there, not folded in here. The key list is Django's dict keys
  // minus "address" (computed below); note Django has no `network` entry,
  // and iterating the AI response instead would silently skip any field
  // the model omitted from its JSON.
  const detailChanges: Record<string, boolean> = {};
  for (const field of CHECK_USE_AI_FIELDS) {
    const ours = ((foodbank as unknown as Record<string, string | null>)[field] ?? "").trim();
    const found = aiResponse.details[field] ?? "";
    detailChanges[field] = normaliseForCompare(field, ours) !== normaliseForCompare(field, found);
  }
  // gfadmin/views.py:1192-1194 -- "address" in Django's detail_changes is
  // address+postcode combined (joined by a newline) and compared as a
  // plain trimmed string, with none of phone_number's space stripping.
  // The nullish normalisation above already applies to both halves
  // (views.py:1186-1188 rewrites every key). Previously skipped here
  // entirely (never computed at all), which is why the Details table's
  // Address row never highlighted on a real change and postcode was
  // silently dropped from the comparison.
  const oursAddress = `${foodbank.address ?? ""}\n${foodbank.postcode ?? ""}`.trim();
  const foundAddress = `${aiResponse.details.address ?? ""}\n${aiResponse.details.postcode ?? ""}`.trim();
  detailChanges.address = oursAddress !== foundAddress;

  // Django also excludes the delivery-address postcode from this set;
  // this D1 schema has no separate `delivery_postcode` column to
  // compare against (only free-text `delivery_address`), so that half
  // is dropped here rather than parsed unreliably out of prose.
  const ourAddressPostcodes = new Set([normalisePostcode(foodbank.postcode)]);
  const ourLocationPostcodes = new Set(locations.map((l) => normalisePostcode(l.postcode)));
  const ourDonationPointPostcodes = new Set(donationPoints.map((d) => normalisePostcode(d.postcode)));
  const foundLocationPostcodes = new Set(aiResponse.locations.map((l) => normalisePostcode(l.postcode)));
  const foundDonationPointPostcodes = new Set(aiResponse.donation_points.map((d) => normalisePostcode(d.postcode)));

  const result: FoodbankCheckResult = {
    prompt,
    aiResponse,
    fetchedPages,
    detailChanges,
    ourLocations: locations.map((l) => ({ slug: l.slug, name: l.name, address: l.address, postcode: l.postcode, discrepancy: !foundLocationPostcodes.has(normalisePostcode(l.postcode)) })),
    foundLocations: aiResponse.locations.map((l) => ({
      ...l,
      discrepancy: !ourLocationPostcodes.has(normalisePostcode(l.postcode)) && !ourAddressPostcodes.has(normalisePostcode(l.postcode)),
    })),
    ourDonationPoints: donationPoints.map((d) => ({ slug: d.slug, name: d.name, address: d.address, postcode: d.postcode, discrepancy: !foundDonationPointPostcodes.has(normalisePostcode(d.postcode)) })),
    // gfadmin/views.py:1176-1180 -- the donation-points loop's second
    // exclusion set is foodbank_json["locations"] (our locations'
    // postcodes), NOT the food bank's own address postcode: that is the
    // locations loop's rule at views.py:1173. Getting these the same way
    // round badges a found donation point sitting at one of our existing
    // locations as "new" with an Add button -- a duplicate waiting to be
    // created -- and suppresses one at the food bank's own postcode.
    foundDonationPoints: aiResponse.donation_points.map((d) => ({
      ...d,
      discrepancy: !ourDonationPointPostcodes.has(normalisePostcode(d.postcode)) && !ourLocationPostcodes.has(normalisePostcode(d.postcode)),
    })),
    donationPointFinder: finder?.outcome ?? null,
  };

  return result;
}
