import puppeteer from "@cloudflare/puppeteer";
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

// A from-scratch HTML->Markdown pass over page.content(), standing in for
// the /markdown REST endpoint's own (undocumented) converter. Deliberately
// does not attempt readability-style content extraction -- neither does
// the REST endpoint, which converts the whole rendered document -- and
// deliberately has no <img> handling at all, so a data: URI logo can never
// reach the output in the first place (stripDataUris() below is kept as a
// defensive backstop, not because this path is expected to need it).
//
// Every handler below writes DIRECTLY into the shared `out` string from
// its own element()/onEndTag()/text() callback, rather than using
// element.before()/after() and relying on a separately-registered "*"
// text() handler to pick the inserted content up. Tried that first; it
// doesn't work -- confirmed live against a real page, twice. before()/
// after() content from one .on() registration never reached a different
// .on("*", {text}) handler's callback at all (headings and link brackets
// silently vanished), and separately, element.remove() didn't stop that
// same "*" handler from seeing text inside the removed subtree (a
// <style> block's CSS came through as the markdown's first "sentence").
// Both are consequences of the same fact: HTMLRewriter dispatches each
// .on() registration's callbacks independently off the ORIGINAL parse,
// not off one another's edits to the stream. Writing straight into `out`
// sidesteps needing that stream-visibility semantics at all -- it only
// depends on callbacks firing in document order (start tag, then
// children, then end tag), which a streaming HTML parser does guarantee,
// and which the skipDepth counter alone is enough to gate correctly.
async function htmlToMarkdown(html: string): Promise<string> {
  let out = "";
  let skipDepth = 0;
  const rewriter = new HTMLRewriter()
    .on("script, style, svg, iframe, canvas, noscript", {
      element(el) {
        skipDepth++;
        el.onEndTag(() => {
          skipDepth--;
        });
      },
    })
    .on("h1, h2, h3, h4, h5, h6", {
      element(el) {
        if (skipDepth > 0) return;
        out += `\n\n${"#".repeat(Number(el.tagName[1]))} `;
        el.onEndTag(() => {
          out += "\n";
        });
      },
    })
    .on("li", {
      element(el) {
        if (skipDepth > 0) return;
        out += "\n- ";
      },
    })
    .on("br", {
      element(el) {
        if (skipDepth > 0) return;
        out += "\n";
      },
    })
    .on("a[href]", {
      element(el) {
        if (skipDepth > 0) return;
        const href = el.getAttribute("href");
        if (!href) return;
        out += "[";
        el.onEndTag(() => {
          out += `](${href})`;
        });
      },
    })
    .on("p, div, tr, blockquote, ul, ol", {
      element(el) {
        if (skipDepth > 0) return;
        out += "\n";
        el.onEndTag(() => {
          out += "\n";
        });
      },
    })
    .on("*", {
      text(chunk) {
        // Collapsing to a single space, not appending verbatim: real markup
        // is full of whitespace-only text nodes between tags (an <li>'s own
        // indentation before its nested <a>), and appending one of those
        // unchanged put a raw "\n" between "- " and the "[" of the very
        // link the bullet was for -- confirmed live, "- " and its link
        // landed on two separate lines. Every intentional line break in
        // this output comes from the structural handlers above; text()
        // should never contribute one.
        if (skipDepth === 0) out += chunk.text.replace(/\s+/g, " ");
      },
    });
  // .transform() only wires up the stream; none of the handlers above run a
  // single callback until the output is actually read -- draining it via
  // .text() is required to make the parse happen at all, even though this
  // function ignores what that call returns and reads `out` instead (same
  // drain-for-side-effects idiom scrapeFacebook()/fetchPageBodyText() use).
  await rewriter.transform(new Response(html)).text();
  // Real markup runs deeply indented (confirmed live: an MDN page's
  // whitespace-only text nodes between tags carried straight through as
  // blank/space-only lines) -- collapsed per line before the blank-line
  // squeeze below, or the squeeze would never see them as blank.
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// general.py:114-164 get_markdown(), moved off the REST endpoint it still
// uses (see that function's own docstring) onto the `browser` Workers
// Binding, maintainer's call 2026-09-03 despite this being the one path in
// the whole jobs Worker explicitly flagged highest-stakes (needcheckRender.ts's
// own comment) -- Django has no binding to have chosen instead, so this is
// a deliberate divergence from its proven behaviour, not a port of it.
// Same three-attempt retry, same degrading waitUntil ladder, same
// challenge-check-before-strip order as the REST version; the one
// intentional difference is rejecting requests by resourceType()
// ("image", "stylesheet") rather than the REST call's rejectResourceTypes
// + a regex on the request URL -- resourceType() classifies a stylesheet
// correctly even when its URL has no ".css" in it (a query-stringed CDN
// URL, for instance), so it's strictly the more faithful match for "don't
// fetch styling", not a looser one.
export async function getMarkdown(env: Env, url: string): Promise<string | null> {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  try {
    browser = await puppeteer.launch(env.BROWSER);
  } catch {
    return null; // no session available at all -- nothing left to retry
  }

  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "stylesheet") req.abort();
      else req.continue();
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const waitUntil = WAIT_UNTILS[Math.min(attempt, WAIT_UNTILS.length - 1)];
      try {
        await page.goto(url, { waitUntil, timeout: 45_000 });
      } catch {
        continue; // navigation timeout, DNS failure, etc -- try the next attempt
      }

      let html: string;
      try {
        html = await page.content();
      } catch {
        continue; // page navigated away/crashed between goto and content()
      }

      const markdown = await htmlToMarkdown(html);
      if (!markdown) continue;
      const low = markdown.toLowerCase();
      if (CHALLENGE_MARKERS.some((m) => low.includes(m))) continue; // checked BEFORE stripping, matching general.py
      return stripDataUris(markdown);
    }
    return null;
  } finally {
    await browser.close(); // gotchas.md: REST auto-closes, a binding session does not
  }
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
