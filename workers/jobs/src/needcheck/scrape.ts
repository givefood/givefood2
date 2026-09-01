import type { Env } from "../../worker-configuration";

export type ScrapeType = "web" | "facebook" | "bankthefood";

export function scrapeTypeFor(shoppingListUrl: string): ScrapeType {
  if (shoppingListUrl.includes("facebook.com")) return "facebook";
  if (shoppingListUrl.includes("bankthefood.org")) return "bankthefood";
  return "web";
}

// givefood/utils/general.py:63-77 MARKDOWN_CHALLENGE_MARKERS/_is_markdown_challenge --
// anti-bot interstitials render as a 200 with non-empty markdown, so they
// must be detected explicitly and retried (PLAN.md §8.5.3 stage 3a / S2).
const CHALLENGE_MARKERS = [
  "verify you're not a robot",
  "verify you are not a robot",
  "just a moment",
  "checking your browser",
  "enable javascript and cookies to continue",
  "please wait while we verify",
];

// general.py:82-88 MARKDOWN_WAIT_UNTILS -- networkidle0 gives JS-heavy
// platforms the longest to settle; a site that never reaches idle (an
// open analytics/chat connection) times out on every attempt, so the last
// attempt relaxes to networkidle2.
const WAIT_UNTILS = ["networkidle0", "networkidle0", "networkidle2"] as const;

// general.py:90-107 MARKDOWN_DATA_URI_RES / _strip_data_uris -- Cardiff's
// header carries its logo twice as a base64 SVG data: URI, 162,212
// characters on one line; unstripped, that took the need prompt to
// 110,107 tokens against a 131,072 context to find a two-item list.
// Newline-excluded character classes are deliberate (S3): an unbounded
// [^<>]* spans from the first image to the last and swallows everything
// between.
const DATA_URI_RES = [/\(<data:[^<>\n]*>\)/g, /\(data:[^\s)\n]*\)/g];

function stripDataUris(markdown: string): string {
  return DATA_URI_RES.reduce((s, re) => s.replace(re, "()"), markdown);
}

// general.py:114-164 get_markdown() -- ported as the REST endpoint (POST
// /accounts/{id}/browser-rendering/markdown), not the BROWSER Workers
// Binding: the binding's exact request shape for /markdown was never
// verified against a live account in this build (PLAN.md §8.5.3's own
// flag), where the REST call is confirmed working in production today.
export async function getMarkdown(env: Env, url: string): Promise<string | null> {
  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const waitUntil = WAIT_UNTILS[Math.min(attempt, WAIT_UNTILS.length - 1)];
    let res: Response;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CF_BROWSER_TOKEN}` },
        body: JSON.stringify({
          url,
          rejectResourceTypes: ["image"],
          rejectRequestPattern: ["/^.*\\.(css)/"],
          gotoOptions: { waitUntil, timeout: 45000 },
        }),
        signal: AbortSignal.timeout(65_000),
      });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    let json: { success?: boolean; result?: string };
    try {
      json = await res.json();
    } catch {
      continue;
    }
    if (!json.success) continue;
    const result = json.result;
    if (!result) continue;
    const low = result.toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => low.includes(m))) continue; // checked BEFORE stripping, matching general.py
    return stripDataUris(result);
  }
  return null;
}

// crawlers.py:334-342's scrape_type == "facebook" branch. A GET to the
// v16.0 embed URL, then htmlbodytext() -- BeautifulSoup decomposing
// svg/style/script/iframe/canvas and returning soup.body.get_text().
// HTMLRewriter is the native Workers equivalent: streaming, removes the
// same tag set, and concatenates the remaining text nodes.
export async function scrapeFacebook(facebookPage: string): Promise<string | null> {
  const url =
    `https://www.facebook.com/v16.0/plugins/page.php?adapt_container_width=true&app_id=224169065968597&container_width=538` +
    `&height=1000&hide_cover=false&href=${encodeURIComponent(`https://www.facebook.com/${facebookPage}`)}` +
    `&lazy=true&locale=en_GB&sdk=joey&show_facepile=true&show_posts=true&small_header=false&width=`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": BOT_USER_AGENT }, signal: AbortSignal.timeout(10_000) });
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
  const transformed = rewriter.transform(res);
  await transformed.text();
  return text;
}

const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

// crawlers.py:344-376's scrape_type == "bankthefood" branch -- two or
// three POSTs: auth/hello/ (retried once on Status == "EXPIRED"), then
// GetWidgetFoodbank/ with the resulting bearer token. The food bank key
// is scraped from the shopping_list_url with /(\d+)/.
export async function scrapeBankTheFood(shoppingListUrl: string): Promise<string | null> {
  const headers = { "User-Agent": BOT_USER_AGENT, "Content-Type": "application/json" };
  const helloPayload = {
    Key1: '{"DeviceID":"widget_c678503d-fdfa-47d9-a1f3-7ea60fc477b2","Token":"","RefreshToken":"","AffiliateID":0,"Code":"widget"}',
    HTMLVersion: "1.0.6",
    AppVersion: "1",
    MainVersion: "1",
    Platform: 2,
    AffiliateID: 0,
    Language: "EN",
    Country: "GB",
    Currency: "GBP",
    TimeZone: "Europe/London",
  };

  async function hello(): Promise<{ Status: string; Data?: { Tokens?: { Token?: string } } } | null> {
    try {
      const res = await fetch("https://api.bankthefood.org/api/auth/hello/", {
        method: "POST",
        headers,
        body: JSON.stringify(helloPayload),
        signal: AbortSignal.timeout(10_000),
      });
      return await res.json();
    } catch {
      return null;
    }
  }

  let helloResult = await hello();
  if (helloResult?.Status === "EXPIRED") helloResult = await hello();
  const token = helloResult?.Data?.Tokens?.Token;
  if (!token) return null;

  const keyMatch = shoppingListUrl.match(/\/(\d+)\//);
  if (!keyMatch) return null;
  const foodbankKey = keyMatch[1];

  try {
    const res = await fetch("https://api.bankthefood.org/api/foodbank/GetWidgetFoodbank/", {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        Key1: foodbankKey,
        HTMLVersion: "1.0.6",
        AppVersion: "1",
        MainVersion: "1",
        Platform: 2,
        AffiliateID: 0,
        Language: "EN",
        Country: "GB",
        Currency: "GBP",
        TimeZone: "Europe/London",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) return null;
    return await res.text();
  } catch {
    return null;
  }
}
