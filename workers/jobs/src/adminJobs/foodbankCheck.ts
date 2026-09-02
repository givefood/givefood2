import type { Env } from "../../worker-configuration";
import { getFoodbankBySlug, getLocationsByFoodbankId, getDonationPointsByFoodbankId, markAdminJobRunning, markAdminJobDone, markAdminJobFailed } from "@givefood/db";
import { geminiJsonCall } from "../lib/gemini";
import { buildCheckPrompt, FOODBANK_CHECK_RESPONSE_SCHEMA, type FoodbankCheckAiResponse } from "./checkPrompt";

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
  ourLocations: { slug: string; name: string; postcode: string | null; discrepancy: boolean }[];
  foundLocations: { name: string; address: string; postcode: string; discrepancy: boolean }[];
  ourDonationPoints: { slug: string; name: string; postcode: string; discrepancy: boolean }[];
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

    const detailChanges: Record<string, boolean> = {};
    for (const [field, foundValue] of Object.entries(aiResponse.details)) {
      if (field === "name" || field === "address" || field === "country") continue;
      const ours = field === "postcode" ? foodbank.postcode : (foodbank as unknown as Record<string, string | null>)[field];
      detailChanges[field] = normaliseAiString(foundValue as string) !== (ours ?? "").trim() && normaliseAiString(foundValue as string) !== "";
    }

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
      ourLocations: locations.map((l) => ({ slug: l.slug, name: l.name, postcode: l.postcode, discrepancy: !foundLocationPostcodes.has(normalisePostcode(l.postcode)) })),
      foundLocations: aiResponse.locations.map((l) => ({
        ...l,
        discrepancy: !ourLocationPostcodes.has(normalisePostcode(l.postcode)) && !ourAddressPostcodes.has(normalisePostcode(l.postcode)),
      })),
      ourDonationPoints: donationPoints.map((d) => ({ slug: d.slug, name: d.name, postcode: d.postcode, discrepancy: !foundDonationPointPostcodes.has(normalisePostcode(d.postcode)) })),
      foundDonationPoints: aiResponse.donation_points.map((d) => ({
        ...d,
        discrepancy: !ourDonationPointPostcodes.has(normalisePostcode(d.postcode)) && !ourAddressPostcodes.has(normalisePostcode(d.postcode)),
      })),
    };

    await markAdminJobDone(session, jobId, result);
  } catch (err) {
    await markAdminJobFailed(session, jobId, err instanceof Error ? err.message : String(err));
  }
}
