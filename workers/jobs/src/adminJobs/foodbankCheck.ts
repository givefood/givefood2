import type { Env } from "../../worker-configuration";
import { getFoodbankBySlug, getLocationsByFoodbankId, getDonationPointsByFoodbankId, markAdminJobRunning, markAdminJobDone, markAdminJobFailed } from "@givefood/db";
import { geminiJsonCall } from "../lib/gemini";
import { buildCheckPrompt, FOODBANK_CHECK_RESPONSE_SCHEMA, CHECK_USE_AI_FIELDS, type FoodbankCheckAiResponse } from "./checkPrompt";

const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

// gfadmin/views.py:861-1011 _build_foodbank_check_data's htmlbodytext() --
// BeautifulSoup decomposing svg/style/script/iframe/canvas and returning
// soup.body.get_text(). Same HTMLRewriter pattern as needcheck/scrape.ts's
// scrapeFacebook(), kept as its own small copy rather than a shared
// import -- this WP's fetches are plain GETs with no retry/anti-bot logic,
// a materially simpler case than that pipeline's.
async function fetchPageBodyText(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": BOT_USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;

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

export interface FoodbankCheckResult {
  prompt: string;
  aiResponse: FoodbankCheckAiResponse;
  fetchedPages: { name: string; url: string; found: boolean; proxyField: string }[];
  detailChanges: Record<string, boolean>;
  ourLocations: { slug: string; name: string; address: string | null; postcode: string | null; discrepancy: boolean }[];
  foundLocations: { name: string; address: string; postcode: string; discrepancy: boolean }[];
  ourDonationPoints: { slug: string; name: string; address: string | null; postcode: string; discrepancy: boolean }[];
  foundDonationPoints: { name: string; address: string; postcode: string; discrepancy: boolean }[];
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

export async function handleFoodbankCheckJob(env: Env, jobId: string, foodbankSlug: string): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");
  await markAdminJobRunning(session, jobId);

  try {
    const foodbank = await getFoodbankBySlug(session, foodbankSlug);
    if (!foodbank) throw new Error(`no such foodbank: ${foodbankSlug}`);

    const [locations, donationPoints] = await Promise.all([getLocationsByFoodbankId(session, foodbank.id), getDonationPointsByFoodbankId(session, foodbank.id)]);

    // WP 6.8 (disclosed simplification, not a fix): Django also has a 6th
    // fetch -- a POST to a donation-points finder specific to food banks
    // using the shared "foodbank.org.uk donate-food" white-label platform
    // (views.py:955-987), plus a network_id auto-backfill regex-scrape.
    // Narrow to one third-party platform and adding real complexity for
    // an unknown (possibly small) subset of food banks -- not built here.
    // Food banks on that platform get an incomplete donation-points
    // section in their check result until this is picked up.
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

    const fetchedPages: FoodbankCheckResult["fetchedPages"] = [];
    const pageTexts: { name: string; text: string | null }[] = [];
    for (const page of candidatePages) {
      if (!page.url) {
        pageTexts.push({ name: page.name, text: null });
        continue;
      }
      const start = new Date().toISOString();
      const text = await fetchPageBodyText(page.url);
      const finish = new Date().toISOString();
      // gfadmin/views.py's CrawlItem bookkeeping -- crawl_type "check",
      // no crawl_set (matches Django: these check-crawls are never
      // grouped into a CrawlSet).
      await session
        .prepare("INSERT INTO crawlitem (crawl_type, start, finish, foodbank_id, url) VALUES ('check', ?, ?, ?, ?)")
        .bind(start, finish, foodbank.id, page.url)
        .run();
      pageTexts.push({ name: page.name, text });
      fetchedPages.push({ name: page.name, url: page.url, found: text !== null, proxyField: page.proxyField });
    }

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

    const aiResponse = (await geminiJsonCall({
      apiKey: env.GEMINI_API_KEY,
      model: "gemini-2.5-flash",
      prompt,
      temperature: 0,
      responseSchema: FOODBANK_CHECK_RESPONSE_SCHEMA,
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
    };

    await markAdminJobDone(session, jobId, result);
  } catch (err) {
    await markAdminJobFailed(session, jobId, err instanceof Error ? err.message : String(err));
  }
}
