import type { Env } from "../../worker-configuration";

// TYPE-ONLY -- see the deferred import in getMarkdownViaBinding() below.
type PuppeteerBrowser = Awaited<
  ReturnType<(typeof import("@cloudflare/puppeteer"))["default"]["launch"]>
>;

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

// general.py:114-164 get_markdown().
//
// BACK ON THE REST ENDPOINT, 2026-09-05, reverting a change made two days
// earlier. It had been moved to the `browser` binding with the
// htmlToMarkdown() above doing the HTML->markdown conversion by hand. That
// is the one path in this Worker its own comment calls highest-stakes, and
// the divergence showed up in the numbers the first day the cron ran:
//
//   date      Django   port
//   09-03         20     20     <- both are ETL copies, identical
//   09-04         31    113     <- port's own cron starts
//   09-05          6     32
//
// 32 needs reached the review queue today against Django's 6, none of them
// suppressed as a repeat. The mechanism is that the model's output only
// stays stable if its INPUT stays stable: the prompt's whole reproducibility
// contract ("the same page must always produce exactly the same lists",
// prompt.ts:26) is graded against the last PUBLISHED need, and every last
// published need in this database was produced by Django from REST-markdown
// text. A different converter -- different whitespace, no image or link
// markdown, different block separation -- yields differently-worded items
// for an unchanged page, decision.ts's keysEqual() then says "change", and
// the same page reappears in the queue every day.
//
// So the fix is not to improve the hand-written converter. It is to feed
// the model the same bytes Django feeds it. htmlToMarkdown() is kept above
// only as the fallback for when the REST credentials are absent.
//
// Same three attempts and the same degrading waitUntil ladder as Django,
// and the same challenge-check-before-strip order.
const MARKDOWN_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

// Set the first time the REST endpoint answers 401/403, and never cleared:
// the credential cannot become valid mid-run, so every later call in this
// isolate skips straight to the binding rather than spending a round trip
// to be rejected again.
//
// WHY FALL BACK AT ALL, given the binding is what caused the false-positive
// flood this file was reverted away from on 2026-09-05? Because the two
// failure modes are not comparable. A noisier extraction costs the reviewer
// time on a queue they read daily; no extraction at all means every food
// bank's shopping list silently goes stale, which is the entire point of
// the site. Verified 2026-09-05, the day this mattered: the binding path's
// own sweep failed to render 30 of 1,023 food banks (2.9%), while the REST
// path failed 2 of 2 -- so degraded is measurably better than nothing.
//
// Module scope, so it lasts an isolate rather than a request; a fresh
// isolate re-tests REST, which is what picks the fix up automatically once
// the token is corrected.
let restAuthFailed = false;

// A FAILURE HERE USED TO BE COMPLETELY SILENT: every branch below was a
// bare `continue`, so three attempts fell through to `return null` with
// nothing written to the log. That is survivable for the ordinary case --
// a food bank whose site is down is the most common outcome in this whole
// pipeline and is not worth a log line each -- but it hides the one
// failure that is NOT ordinary: a CF_API_KEY without the Browser
// Rendering permission answers 403 for EVERY food bank, the sweep finds
// nothing at all, and the only visible symptom is a quiet day in the
// review queue. Which looks exactly like a quiet day.
//
// So the two are separated. A per-URL failure is logged at most once, on
// the final attempt, and says which URL. An AUTH failure (401/403) is
// logged immediately, every time, because it is never about the URL and
// the operator needs to see it on the first food bank rather than infer
// it from an empty queue.
async function getMarkdownViaRest(env: Env, url: string): Promise<string | null> {
  let lastFailure = "no attempt completed";
  for (let attempt = 0; attempt < 3; attempt++) {
    const waitUntil = WAIT_UNTILS[Math.min(attempt, WAIT_UNTILS.length - 1)];
    let res: Response;
    try {
      res = await fetch(`${MARKDOWN_ENDPOINT}/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          // general.py:137 verbatim -- the REST call's own way of saying
          // "don't fetch styling".
          rejectRequestPattern: ["/^.*\\.(css)/"],
          gotoOptions: { waitUntil, timeout: 45_000 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      lastFailure = `fetch threw (${err instanceof Error ? err.message : String(err)})`;
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      // Not retried, and not quiet. Every subsequent food bank in the sweep
      // will fail identically, so the ladder is pointless here -- and the
      // latch below makes the rest of this isolate skip REST entirely.
      console.error(
        `needcheck: Browser Rendering REST returned ${res.status} -- CF_API_KEY is missing the ` +
          `Browser Rendering permission, or is wrong for account ${env.CF_ACCOUNT_ID}. ` +
          `FALLING BACK TO THE BINDING for the rest of this run; extraction will be noisier ` +
          `(see getMarkdown) until the token is fixed. ${await res.text()}`,
      );
      restAuthFailed = true;
      return null;
    }
    if (!res.ok) {
      lastFailure = `HTTP ${res.status}`;
      continue;
    }

    let payload: { success?: boolean; result?: string; errors?: unknown };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      lastFailure = "response body was not JSON";
      continue;
    }
    const markdown = payload.success ? payload.result : undefined;
    if (!markdown) {
      lastFailure = payload.success ? "empty result" : `success=false ${JSON.stringify(payload.errors ?? null)}`;
      continue;
    }

    const low = markdown.toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => low.includes(m))) {
      lastFailure = "anti-bot challenge page"; // BEFORE stripping, matching general.py
      continue;
    }
    return stripDataUris(markdown);
  }
  console.warn(`needcheck: no markdown for ${url} after 3 attempts (last: ${lastFailure})`);
  return null;
}

// The binding path, kept as the fallback for a deployment with no
// CF_ACCOUNT_ID/CF_API_KEY. It works -- it just produces different text,
// which is exactly the problem above, so it is no longer the default.
async function getMarkdownViaBinding(env: Env, url: string): Promise<string | null> {
  let browser: PuppeteerBrowser;
  try {
    // DEFERRED ON PURPOSE. This is the fallback path -- it runs only when
    // CF_ACCOUNT_ID/CF_API_KEY are absent -- and it is the jobs Worker's only
    // importer of @cloudflare/puppeteer, 453 KiB of a 2.7 MiB bundle. A static
    // import evaluates that whole module graph at startup for every cron tick
    // and every queue batch, none of which reach this function. esbuild keeps
    // the bytes in the bundle but behind a lazy initialiser, so what moves is
    // the evaluation. Same change as the site Worker's wfbn/screenshot.ts.
    const { default: puppeteer } = await import("@cloudflare/puppeteer");
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
        continue;
      }

      let html: string;
      try {
        html = await page.content();
      } catch {
        continue;
      }

      const markdown = await htmlToMarkdown(html);
      if (!markdown) continue;
      const low = markdown.toLowerCase();
      if (CHALLENGE_MARKERS.some((m) => low.includes(m))) continue;
      return stripDataUris(markdown);
    }
    return null;
  } finally {
    await browser.close(); // gotchas.md: REST auto-closes, a binding session does not
  }
}

export async function getMarkdown(env: Env, url: string): Promise<string | null> {
  if (env.CF_ACCOUNT_ID && env.CF_API_KEY && !restAuthFailed) {
    const markdown = await getMarkdownViaRest(env, url);
    // A null here is usually just an unreachable site, and must NOT be
    // retried through the binding -- that would double the load on every
    // food bank whose page is genuinely down. Only an auth failure, which
    // sets the latch, falls through.
    if (!restAuthFailed) return markdown;
  }
  return getMarkdownViaBinding(env, url);
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
