import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { LOCALES } from "@givefood/templates";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";
import { llmsTxt, securityTxt } from "./textFiles";

// routes/public/textFiles.ts -- the two hand-built plain-text documents:
// /.well-known/security.txt (Django's securitytxt(), givefood/views.py:921)
// and /llms.txt (llmstxt(), givefood/views.py:904, whose template is
// givefood/templates/public/llms.txt). Both Django sources were read in full
// alongside this file; the reference document below is TRANSCRIBED FROM THE
// DJANGO TEMPLATE, not from the port.
//
// WHY THIS FILE EXISTS. Neither document is ever looked at by a human on this
// site, and both are read by machines that will not complain.
//
//   * security.txt is fetched by researchers and scanners. Its whole content
//     is two lines and a mailto:, so the only failure available is a
//     transcription slip -- and a security.txt with a wrong contact address
//     still returns 200, still parses, and simply routes vulnerability
//     reports into a void.
//   * llms.txt is a MAP OF THE SITE HANDED TO CRAWLERS. Its failure mode is a
//     bullet pointing at a URL this Worker does not serve: the page 404s for
//     the crawler, nothing is logged here, and nobody finds out. That is not
//     hypothetical -- the port removed two such bullets already (/dumps/,
//     which is never coming, and /colophon/, deleted 2026-09-05), and fixed a
//     third URL that was wrong in Django itself. So the block at the bottom
//     REQUESTS EVERY STATIC URL THE DOCUMENT ADVERTISES through the real
//     router and pins what comes back.
//   * Its two dynamic values come from site_stats. A handler that read
//     stats.items instead of stats.donationpoints would still render a
//     plausible document with a 200, which is why the fixture gives all four
//     stats columns different values and the tests assert that exactly two of
//     them appear.
//   * Both set their own Cache-Control for a WEEK. A week-long TTL on a
//     document that is wrong is a week of being wrong, so the header values
//     are pinned as values, not as "has a Cache-Control".
//
// REAL EVERYTHING, the same harness as routes/public/sitemaps.test.ts and
// routes/public/frag.test.ts: the real production app (workers/site/src/index.ts's
// default export), so the route registrations, resolveLanguage, securityHeaders,
// cacheTag and pageCacheControl are the genuine articles, real Nunjucks
// templates for the pages the link crawl visits, and real in-memory SQLite
// built from the real migrations. MIGRATIONS_SQL rather than schemaFor(...)
// deliberately: the link crawl at the bottom renders the dashboards, the API
// list endpoints and the country pages, which between them read most of the
// schema, and naming those tables here would be a list that rots.
// Mocked: only the two KV namespaces (Maps) and the D1 Sessions wrapper.
//
// MUTATION-TESTED in a clone of the repo under the scratchpad, never in the
// working tree: 20 deliberate breakages of textFiles.ts plus one of index.ts's
// route registration, all 21 caught. The tests below name the mutants they
// killed. (A 22nd attempt landed inside textFiles.ts's own header comment and
// correctly changed nothing.)

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite --
// copied from routes/public/sitemaps.test.ts rather than reinvented.
// `prepared` records what actually reached the engine, which is the only way
// to see that /llms.txt costs ONE query: the body looks identical whether the
// handler ran one statement or twenty.
function d1Session(db: DatabaseSync, prepared: string[]): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      return statement(sql, []);
    },
    getBookmark: () => null,
  } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;
let prepared: string[];
let sessions: number;
let kv: Map<string, string>;

function env(overrides: Record<string, unknown> = {}): AppEnv["Bindings"] {
  return {
    DB: {
      withSession: () => {
        sessions += 1;
        return d1Session(db, prepared);
      },
    },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    SITE_DOMAIN: ORIGIN,
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

// ---------------------------------------------------------------------------
// Seed
//
// site_stats is a single enforced row (migrations/0003_homepage_data.sql:55,
// `id INTEGER PRIMARY KEY CHECK (id = 1)`), so there is no second row to
// exclude. The exclusion that matters here is between COLUMNS: all four
// counters get values that share no digits, so a handler reading `items` or
// `meals` -- or reading foodbanks where it meant donationpoints -- prints a
// number this file can see. `1234567` is deliberately the seven-digit one, so
// if intcomma were ever applied to the wrong field the two-separator form
// would show up where it does not belong.
// ---------------------------------------------------------------------------
const FOODBANKS = 2937;
const DONATIONPOINTS = 4051;
const ITEMS = 1234567;
const MEALS = 98765432;

function seedSiteStats(foodbanks: number = FOODBANKS, donationpoints: number = DONATIONPOINTS): void {
  db.prepare(
    "INSERT INTO site_stats (id, foodbanks, donationpoints, items, meals, computed_at) VALUES (1, ?, ?, ?, ?, '2026-09-05 19:28:08.853000')",
  ).run(foodbanks, donationpoints, ITEMS, MEALS);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  seedSiteStats();
  prepared = [];
  sessions = 0;
  kv = new Map();
});

afterEach(() => {
  db.close();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
const get = async (path: string, init?: RequestInit, bindings: AppEnv["Bindings"] = env()): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, init), bindings, execCtx);

const body = async (path: string, init?: RequestInit, bindings?: AppEnv["Bindings"]): Promise<string> => (await get(path, init, bindings)).text();

// ===========================================================================
// security.txt
// ===========================================================================

// givefood/views.py:921-930, transcribed from the Python. The view is an
// HttpResponse built from two adjacent string literals -- there is no
// template -- so this is the whole document, and a byte comparison is the
// only assertion that can catch a mistyped mailbox.
//
// NOT givefood/static/root/security.txt, which is a different, stale file
// that urls.py never routed (textFiles.ts's own header records that finding);
// this is the one production actually served.
//
// The Expires field is a fixed date, not a computed one: this document
// declares itself stale on 2030-01-01, after which a consumer following
// RFC 9116 should not trust it (section number not cited: the RFC was not
// read on this machine). That is a diary entry, not a test -- pinning
// "Expires is in the future" would turn the suite red on a date nobody is
// watching for, which is the failure mode TESTING.md's "a failing test is
// always a regression" rule exists to avoid. The literal is asserted as-is.
const DJANGO_SECURITY_TXT = "Contact: mailto:mail@givefood.org.uk\nExpires: 2030-01-01T00:00:00.000Z\n";

describe("securityTxt -- the document", () => {
  it("serves Django's two lines byte for byte, trailing newline included", async () => {
    // THE TEST THIS HALF OF THE FILE EXISTS FOR. RFC 9116 parsers read
    // `Contact` as the address to send a vulnerability report to; one wrong
    // character there is undetectable from the outside and silently discards
    // every report. The trailing "\n" is part of the assertion because the
    // Django source ends its second literal with one, and a field line
    // without a terminating newline is not a well-formed field. Both mutants
    // -- the mailbox changed to security@, and the final newline dropped --
    // die here and nowhere else.
    const res = await get("/.well-known/security.txt");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DJANGO_SECURITY_TXT);
  });

  it("is served as bare text/plain, with no charset, exactly as Django's HttpResponse was", async () => {
    // views.py:929 passes content_type='text/plain' verbatim. The sibling
    // handler in this same file sets "text/plain; charset=utf-8" (Django's
    // llmstxt does too), so the inconsistency is INHERITED, not introduced --
    // pinned here rather than tidied: RFC 9116 asks for a utf-8 charset on
    // this document, but adding one would be a change to what production
    // sends rather than a port of it, and the port's job here is the latter.
    const res = await get("/.well-known/security.txt");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("sets its own week-long Cache-Control rather than inheriting one", async () => {
    // Django's @cache_page(SECONDS_IN_WEEK) (const/cache_times.py:6 --
    // 7 * SECONDS_IN_DAY = 604800). The handler sets this ITSELF because
    // middleware/pageCacheControl.ts took text/plain off CACHEABLE_TYPES
    // after /frag/ip-address/ was found in a shared cache carrying a
    // stranger's IP. So the value below is not a middleware default: delete
    // the header from the handler and this document gets no Cache-Control at
    // all, which is a silent 100% revalidation rate, not an error.
    const res = await get("/.well-known/security.txt");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800");
    // Specifically NOT pageCacheControl's gap-filler shape, which is what
    // would appear if text/plain ever went back on CACHEABLE_TYPES and the
    // handler stopped setting its own. Kills the "header deleted from the
    // handler" mutant, which nothing else in this file notices.
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage");
  });

  it("carries nosniff, which is what stops a browser rendering a text file as HTML", async () => {
    // middleware/securityHeaders.ts's job, asserted HERE because this is a
    // user-facing text/plain document: without nosniff a browser is free to
    // sniff content that begins with markup and execute it in this origin.
    const res = await get("/.well-known/security.txt");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("mints no cookie, no Vary and no Cache-Tag, so one cached copy serves everyone", async () => {
    // A Set-Cookie (Cloudflare refuses to cache those) or a Vary from a
    // future middleware would quietly make a document identical for every
    // visitor per-visitor instead. The absent Cache-Tag is the deliberate
    // half: cacheTag.ts's AGGREGATE_PATHS does not match this path, and it
    // should not -- nothing in the body depends on a row in the database, so
    // there is nothing a purge could need to invalidate.
    const res = await get("/.well-known/security.txt");

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});

describe("securityTxt -- outside the router", () => {
  it("takes no context and touches no binding at all", async () => {
    // The exported signature is `securityTxt(): Promise<Response>` -- no
    // Context parameter -- and that is a contract worth pinning: it is the
    // reason this route cannot 500 when D1 is down, and the reason it is safe
    // to serve from anywhere. Calling it with no arguments and no bindings
    // whatsoever is the only way to demonstrate that; through the router it
    // would be indistinguishable from a handler that reads env and ignores it.
    const res = await securityTxt();

    expect(await res.text()).toBe(DJANGO_SECURITY_TXT);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect(sessions).toBe(0);
  });

  it("returns a fresh Response object each call, not a shared one", async () => {
    // A Response body can be read once. If the handler ever hoisted its
    // Response into a module constant to save an allocation, the SECOND
    // request would throw "Body has already been used" -- in production that
    // is an intermittent 500 on a document that worked when it was tested.
    const first = await securityTxt();
    const second = await securityTxt();

    expect(first).not.toBe(second);
    expect(await first.text()).toBe(DJANGO_SECURITY_TXT);
    expect(await second.text()).toBe(DJANGO_SECURITY_TXT);
  });
});

// ===========================================================================
// llms.txt -- the document, against the Django template it was ported from
// ===========================================================================

// givefood/templates/public/llms.txt, TRANSCRIBED FROM THE DJANGO REPO rather
// than from textFiles.ts -- a copy of the port's own literal would agree with
// any mutation of it, and this is the only reference that makes the parity
// claim in textFiles.ts's header checkable. `{% load humanize %}` renders to
// nothing and is dropped; `{{ domain }}` and the two
// `|floatformat:"0"|intcomma` counters become this function's parameters.
//
// The port's divergences from it are applied separately, below, so that this
// stays a faithful copy of the original and every difference has to be named.
function djangoLlmsTxt(domain: string, foodbanks: string, donationpoints: string): string {
  return `# Give Food

> UK charity providing the largest public database of food banks and their current needs, with data used by governments, councils, NHS, media, and apps to help alleviate food insecurity.

Give Food is a registered charity in England & Wales (1188192) that uses data to highlight local and structural food insecurity. We maintain near-realtime data on ${foodbanks} food bank locations and ${donationpoints}+ donation points across the UK, tracking what items they need donated and providing tools to help connect donors with those in need.

## Sitemap

- [Markdown Sitemap](${domain}/md/sitemap.md)

## About the Charity

- [About Give Food](${domain}/about-us/): Information about the charity, mission, and impact
- [Annual Reports](${domain}/annual-reports/): Yearly reports on activities, innovations, and impact (2019-2025)
- [2025 Annual Report](${domain}/2025/): Latest annual report
- [Donate](${domain}/donate/): Information on how to support Give Food
- [Register a Food Bank](${domain}/register-foodbank/): Form for food banks to join the database
- [Privacy Policy](${domain}/privacy/): How we handle data and user privacy
- [Colophon](${domain}/colophon/): Technical details about the website and infrastructure
- [Bot Documentation](${domain}/bot/): Information about GiveFoodBot web crawler

## Public Tools

- [Find Food Banks Near You](${domain}/needs/): Search by postcode, town, or location to find nearby food banks and what they need
- [Write to Your MP](${domain}/write/): Contact your Member of Parliament about food insecurity issues
- [Dashboard](${domain}/dashboard/): Data visualizations and statistics about food bank usage and trends
- [Android App](https://play.google.com/store/apps/details?id=uk.org.givefood.android): Mobile app to find food banks and their needs

## Country Pages

- [England](${domain}/england/): Food banks in England with regional map
- [Scotland](${domain}/scotland/): Food banks in Scotland with regional map
- [Wales](${domain}/wales/): Food banks in Wales with regional map
- [Northern Ireland](${domain}/northern-ireland/): Food banks in Northern Ireland with regional map

## Dashboard & Analytics

- [Main Dashboard](${domain}/dashboard/): Overview of food bank statistics and trends
- [Items Requested Weekly](${domain}/dashboard/items-requested-weekly/): Chart showing weekly demand trends over time
- [Items Requested Weekly by Year](${domain}/dashboard/items-requested-weekly/by-year/): Year-over-year comparison
- [Bean & Pasta Index](${domain}/dashboard/bean-pasta-index/): Unique index tracking staple item demand as a measure of food insecurity
- [Most Requested Items](${domain}/dashboard/most-requested-items/): Analysis of commonly requested food and hygiene items
- [Most Excess Items](${domain}/dashboard/most-excess-items/): Items food banks have in surplus
- [Item Categories](${domain}/dashboard/item-categories/): Items aggregated by category
- [Charity Income & Expenditure](${domain}/dashboard/charity-income-expenditure/): Financial data for food bank charities
- [Donation Points by Supermarket](${domain}/dashboard/donationpoints/supermarkets/): Distribution of donation points by retailer
- [Food Banks Found](${domain}/dashboard/foodbanks-found/): Cumulative count of food banks discovered over time

## Multi-Language Support

The website is available in 20 languages to serve diverse UK communities:

- English (en), Polish (pl), Welsh (cy), Bengali (bn), Romanian (ro)
- Punjabi (pa), Urdu (ur), Arabic (ar), Gujarati (gu), Spanish (es)
- Portuguese (pt), Italian (it), French (fr), Tamil (ta), Turkish (tr)
- Scottish Gaelic (gd), Chinese Simplified (zh-hans), Lithuanian (lt), Irish (ga), Bulgarian (bg)

Access any language via: ${domain}/{language-code}/

## API Documentation

- [API Overview](${domain}/api/): Introduction to the public API for accessing food bank data
- [API v2 Documentation](${domain}/api/2/docs/): Interactive documentation with all endpoints and examples
- [API Technical Guide](https://github.com/givefood/givefood/blob/main/gfapi2/README.md): Comprehensive technical documentation

## API Endpoints (v2)

### Food Banks
- [List All Food Banks](${domain}/api/2/foodbanks/): All active food banks with basic information
- [Get Food Bank Details](${domain}/api/2/foodbank/{slug}/): Detailed information including needs and nearby locations
- [Search Food Banks](${domain}/api/2/foodbanks/search/?address={location}): Find food banks by postcode or address

### Locations
- [List All Locations](${domain}/api/2/locations/): All food bank distribution points
- [Search Locations](${domain}/api/2/locations/search/?address={location}): Find distribution points near an address

### Donation Points
- [List All Donation Points](${domain}/api/2/donationpoints/): All donation collection points (GeoJSON)

### Needs & Requests
- [List Recent Needs](${domain}/api/2/needs/): Latest 100 food bank need updates
- [Get Specific Need](${domain}/api/2/need/{id}/): Individual need request details

### Political Data
- [List All Constituencies](${domain}/api/2/constituencies/): UK parliamentary constituencies
- [Get Constituency Details](${domain}/api/2/constituency/{slug}/): Food banks in a specific constituency

### Geographic Data (GeoJSON)
- [All Food Banks](${domain}/needs/geo.json): All food banks, locations, and donation points
- [Food Bank](${domain}/needs/at/{slug}/geo.json): Geographic data for a specific food bank
- [Constituency](${domain}/needs/in/constituency/{slug}/geo.json): Food banks in a constituency
- [Country](${domain}/{country-slug}/geo.json): Food banks in England, Scotland, Wales, or Northern Ireland

### Response Formats
API endpoints support multiple formats via \`?format=\` parameter:
- \`json\` (default), \`xml\`, \`yaml\`, \`geojson\`

## Data Resources

- [Open Data Repository](https://github.com/givefood/data): Versioned food bank data on GitHub with daily updates
- [Data Dumps](${domain}/dumps/): Downloadable CSV, JSON, XML, and YAML exports
- [Food Banks CSV](https://github.com/givefood/data/blob/main/foodbanks.csv): Complete list of food banks with metadata
- [API Usage Guidelines](${domain}/api/): Best practices for using Give Food data responsibly

## Notifications & Subscriptions

- **Email Subscriptions**: Subscribe to food bank updates at ${domain}/needs/at/{slug}/subscribe/
- **WhatsApp Notifications**: Subscribe via WhatsApp by sending "subscribe {foodbank-slug}" to our WhatsApp number
- **RSS Feeds**: Site-wide feed at ${domain}/needs/rss.xml or per-food bank at ${domain}/needs/at/{slug}/rss.xml

## Source Code & Documentation

- [Main Repository](https://github.com/givefood/givefood): Complete source code for the Give Food platform
- [Project README](https://github.com/givefood/givefood/blob/main/README.md): Repository overview and architecture
- [Testing Guide](https://github.com/givefood/givefood/blob/main/TESTING.md): How to run tests and contribute
- [Development Guidelines](https://github.com/givefood/givefood/blob/main/.github/copilot-instructions.md): Coding conventions and best practices
- [Languages Documentation](https://github.com/givefood/givefood/blob/main/docs/languages.md): Internationalization and translation info

## Technical Components

- [Public App](https://github.com/givefood/givefood/blob/main/givefood/README.md): Core framework and public-facing pages
- [What Food Banks Need](https://github.com/givefood/givefood/blob/main/gfwfbn/README.md): Food bank search tool
- [Dashboard](https://github.com/givefood/givefood/blob/main/gfdash/README.md): Data visualization components
- [Write to MP](https://github.com/givefood/givefood/blob/main/gfwrite/README.md): MP contact functionality
- [API v2](https://github.com/givefood/givefood/blob/main/gfapi2/README.md): Current production API

## Key Features

- **AI-Enhanced Data**: Automated categorization of food bank needs using Google GenAI
- **Multi-Language Support**: Website available in 20 languages including Welsh, Polish, Arabic, and more
- **Comprehensive Coverage**: ${foodbanks} food banks and ${donationpoints}+ donation points including supermarkets, phone boxes, and cathedrals
- **Real-Time Updates**: Multiple updates per day from web scraping of food bank websites
- **Political Integration**: Parliamentary constituency mapping and direct MP contact tools
- **Open Data**: All data freely available via API and GitHub with no registration required
- **Notification System**: Email, WhatsApp, and RSS subscriptions for food bank updates
- **Trusted by**: Governments (UK, Scottish, Welsh), NHS, BBC, Channel 4, major supermarkets, universities, and hundreds of news organizations

## Contact

- Email: mail@givefood.org.uk
- Twitter: https://twitter.com/GiveFoodCharity
- Facebook: https://www.facebook.com/GiveFoodOrgUK
- Website: ${domain}
- Charity Registration: England & Wales 1188192
`;
}

// Edits that THROW if their target is missing, rather than quietly doing
// nothing. A silent no-op here would be the worst possible failure: the
// expectation would drift back towards Django's text and the equality test
// would then fail somewhere else entirely, pointing at the port.
function withoutLine(text: string, line: string): string {
  if (!text.includes(`${line}\n`)) throw new Error(`reference has no such line to remove: ${line}`);
  return text.replace(`${line}\n`, "");
}

function replacing(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`reference has no such text to replace: ${from}`);
  return text.replace(from, to);
}

// THE PARITY STATEMENT: this port's /llms.txt is Django's document with
// exactly FIVE named edits and nothing else. Each is a deliberate, recorded
// decision, and writing them as transformations rather than as a rewritten
// document means a SIXTH edit -- an accidental one -- fails the equality test
// below with a one-line diff.
function expectedLlmsTxt(domain: string, foodbanks: string, donationpoints: string): string {
  let text = djangoLlmsTxt(domain, foodbanks, donationpoints);

  // 1. /colophon/. The page, its route, its template, its footer nav entry
  //    AND its llms.txt bullet were removed on 2026-09-05 (maintainer
  //    decision, recorded at index.ts:597, which names /llms.txt explicitly).
  //    textFiles.ts's own header lists three content fixes and not this one,
  //    so index.ts is the provenance for this edit, not the module comment.
  //    The path 404s in this port -- asserted in the link-crawl block below.
  text = withoutLine(text, `- [Colophon](${domain}/colophon/): Technical details about the website and infrastructure`);

  // 2. /dumps/. gfdumps was dropped rather than built (PLAN.md §8.8, WP 5.6,
  //    maintainer decision 2026-09-02) and index.ts mounts the whole subtree
  //    as a 404. Advertising downloads that will never exist to a crawler is
  //    worse than the bullet's pre-existing inaccuracy -- there was never a
  //    YAML dump either.
  text = withoutLine(text, `- [Data Dumps](${domain}/dumps/): Downloadable CSV, JSON, XML, and YAML exports`);

  // 3. The languages section. Django's listed 20 language codes -- not even
  //    its own real 21, and omitting Welsh, which is the one language this
  //    charity is statutorily most likely to be asked for. This port serves
  //    four (PLAN.md §2.7.1), and the replacement is checked against LOCALES
  //    itself in its own test below rather than only as text.
  text = replacing(
    text,
    "The website is available in 20 languages to serve diverse UK communities:\n\n" +
      "- English (en), Polish (pl), Welsh (cy), Bengali (bn), Romanian (ro)\n" +
      "- Punjabi (pa), Urdu (ur), Arabic (ar), Gujarati (gu), Spanish (es)\n" +
      "- Portuguese (pt), Italian (it), French (fr), Tamil (ta), Turkish (tr)\n" +
      "- Scottish Gaelic (gd), Chinese Simplified (zh-hans), Lithuanian (lt), Irish (ga), Bulgarian (bg)\n",
    "The website is available in 4 languages to serve UK and Ireland communities:\n\n" + "- English (en), Welsh (cy), Irish (ga), Scottish Gaelic (gd)\n",
  );

  // 4. The same claim again, in Key Features. Two copies of one fact in one
  //    document is exactly the shape where a fix lands on one and not the
  //    other, which is why this is a separate edit and not part of 3.
  text = replacing(
    text,
    "- **Multi-Language Support**: Website available in 20 languages including Welsh, Polish, Arabic, and more",
    "- **Multi-Language Support**: Website available in 4 languages -- English, Welsh, Irish, and Scottish Gaelic",
  );

  // 5. The subscribe URL. Django's own template was wrong here -- it is
  //    missing the /updates/ segment -- and the port corrects it rather than
  //    reproducing the error. The route that proves which one is right is
  //    asserted directly in the link-crawl block below.
  text = replacing(text, `${domain}/needs/at/{slug}/subscribe/`, `${domain}/needs/at/{slug}/updates/subscribe/`);

  return text;
}

describe("GET /llms.txt -- the whole document", () => {
  it("is Django's template with exactly the five recorded edits, byte for byte", async () => {
    // THE TEST THIS HALF OF THE FILE EXISTS FOR, and the one that makes every
    // other assertion here a convenience. 140 lines of hand-maintained text
    // have exactly one failure mode -- someone edits a line -- and no reader,
    // human or machine, will ever report it. Comparing against the Django
    // original (rather than against a copy of this port's own literal) is
    // what turns "the file did not change" into "the port still says what the
    // original said, minus the five things we decided to change".
    //
    // MUTANTS KILLED, all run against a clone of the repo: the /dumps/ and
    // /colophon/ bullets each put back; the subscribe URL reverted to
    // Django's; "4 languages" reverted to "20"; the Bot Documentation bullet
    // deleted; the 2025 annual-report link pointed at /2026/; "## Contact"
    // demoted to "###"; the Contact mailbox misspelt by one character; the
    // Twitter URL altered; and the two counts swapped between their mentions.
    const res = await get("/llms.txt");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expectedLlmsTxt(ORIGIN, "2,937", "4,051"));
  });

  it("ends with a single trailing newline and no template artefacts", async () => {
    // Django rendered this through the template engine, so `{% load %}`,
    // `{{ }}` and `{% %}` are the residue a botched port leaves. The port
    // uses a JS template literal instead, whose equivalent residue is a
    // literal "${" that never got interpolated -- checked for the same
    // reason.
    const text = await body("/llms.txt");

    expect(text.endsWith("Charity Registration: England & Wales 1188192\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("{{");
    expect(text).not.toContain("{%");
    expect(text).not.toContain("${");
  });

  it("keeps the language list in step with LOCALES rather than restating it from memory", async () => {
    // The document's claim and the router's reality are two separate hand-
    // maintained lists of the same fact. They agree TODAY (four locales,
    // "4 languages"), and this test exists so that adding a fifth locale --
    // which is a routing change, nowhere near this file -- fails here instead
    // of leaving a document that tells crawlers a number that is now wrong.
    const text = await body("/llms.txt");

    expect(LOCALES.length).toBe(4);
    expect(text).toContain(`The website is available in ${LOCALES.length} languages`);
    expect(text).toContain(`Website available in ${LOCALES.length} languages`);
    // Every locale the router serves is named with its code, and no other
    // code is claimed: Django's list included pl, ar, bn and 15 more that
    // this port would 404.
    expect(text).toContain("- English (en), Welsh (cy), Irish (ga), Scottish Gaelic (gd)\n");
    for (const locale of LOCALES) expect(text).toContain(`(${locale})`);
    for (const dropped of ["(pl)", "(bn)", "(ar)", "(zh-hans)", "(ur)"]) expect(text).not.toContain(dropped);
  });
});

// ===========================================================================
// The two numbers
// ===========================================================================

describe("the food bank and donation point counts", () => {
  it("reads foodbanks and donationpoints, and neither of the other two stats columns", async () => {
    // site_stats carries four counters. `items` and `meals` are seeded with
    // values that share no digits with the two the document wants, so a
    // handler reading the wrong field prints a number this test can see --
    // and it would look entirely plausible on the page, which is the whole
    // problem. Kills the "stats.items instead of stats.donationpoints"
    // mutant, which no assertion about shape ever could.
    const text = await body("/llms.txt");

    expect(text).toContain("near-realtime data on 2,937 food bank locations and 4,051+ donation points across the UK");
    expect(text).toContain("**Comprehensive Coverage**: 2,937 food banks and 4,051+ donation points including");
    expect(text).not.toContain("1,234,567");
    expect(text).not.toContain("98,765,432");
  });

  it("interpolates each count in BOTH places it appears", async () => {
    // The intro paragraph and the Key Features bullet quote the same two
    // numbers. A port that interpolated one and hardcoded the other would
    // pass every "contains 2,937" check ever written, and would go stale the
    // first time the count changed.
    const text = await body("/llms.txt");

    expect(text.split("2,937")).toHaveLength(3);
    expect(text.split("4,051")).toHaveLength(3);
  });

  it("applies intcomma, including to a seven-digit count with two separators", async () => {
    // Django's template ran the values through |floatformat:"0"|intcomma, so
    // production served "2,937" and never "2937". intcomma's separator loop
    // is the part that breaks silently for large numbers -- a single-pass
    // regex would give "1234,567" -- and the food bank count is four digits
    // today, so nothing else in this document would ever exercise it. Kills
    // the `String(stats?.foodbanks ?? 0)` mutant at a size where the missing
    // separators are unmistakable.
    db.prepare("DELETE FROM site_stats").run();
    seedSiteStats(1234567, 22000);
    const text = await body("/llms.txt");

    expect(text).toContain("data on 1,234,567 food bank locations and 22,000+ donation points");
    expect(text).not.toContain("1234567");
  });

  it("SERVES A DOCUMENT CLAIMING ZERO when the site_stats row is missing", async () => {
    // SUSPECT, pinned rather than fixed. `stats?.foodbanks ?? 0` means an
    // empty site_stats table produces a 200 carrying "0 food bank locations
    // and 0+ donation points" -- with a WEEK of Cache-Control on it, and no
    // Cache-Tag by which to purge it (asserted below). Django's llmstxt()
    // subscripted the dict directly, so the equivalent failure there was a
    // 500: loud, and never cached.
    //
    // site_stats is populated by the extraction tool, so an empty table is
    // not a state production reaches today; this is a latent trap rather
    // than a live bug, and is written down because the failure is a
    // plausible-looking document rather than an error. The `?? 1` mutant --
    // a fallback that reads as "at least one" -- dies here.
    db.prepare("DELETE FROM site_stats").run();
    const res = await get("/llms.txt");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expectedLlmsTxt(ORIGIN, "0", "0"));
  });

  it("costs exactly one D1 session and one statement", async () => {
    // /llms.txt is fetched by crawlers, which is to say repeatedly and by
    // anyone. One SELECT of one row from a one-row table is what makes that
    // harmless; a future edit that reads the food bank table to "get a fresh
    // count" would look identical in the body and turn a static document into
    // a full table scan per crawl.
    await get("/llms.txt");

    expect(sessions).toBe(1);
    expect(prepared).toEqual(["SELECT foodbanks, donationpoints, items, meals, computed_at FROM site_stats WHERE id = 1"]);
  });
});

// ===========================================================================
// SITE_DOMAIN
// ===========================================================================

describe("every internal URL comes from the SITE_DOMAIN binding", () => {
  it("uses whatever the binding says, not a baked-in domain", async () => {
    // wrangler.jsonc sets SITE_DOMAIN to this suite's ORIGIN, so a hardcoded
    // "https://www.givefood.org.uk" in the source would pass every other test
    // in this file. Serving one request with a different value is the only
    // thing that separates the two -- and it matters because a preview
    // deployment whose llms.txt documents production is a document that
    // cannot be told apart from the real one by the crawler reading it.
    // Kills `const domain = "https://www.givefood.org.uk"`, which every other
    // test in this file passes.
    const text = await body("/llms.txt", undefined, env({ SITE_DOMAIN: "https://beta.example.invalid" }));

    expect(text).toContain("- [About Give Food](https://beta.example.invalid/about-us/)");
    expect(text).toContain("- Website: https://beta.example.invalid\n");
    expect(text).not.toContain(ORIGIN);
    // The off-site links are absolute and must NOT move with the binding.
    expect(text).toContain("https://github.com/givefood/data");
    expect(text).toContain("https://play.google.com/store/apps/details?id=uk.org.givefood.android");
  });

  it("WRITES THE WORD undefined INTO EVERY LINK when the binding is missing", async () => {
    // SUSPECT, pinned rather than fixed. A template literal stringifies
    // `undefined` rather than throwing, so a missing SITE_DOMAIN produces a
    // 200 in which all 47 interpolations of the domain read "undefined" --
    // "undefined/about-us/", "undefined/needs/" and so on: a document
    // that looks fine to a header check and is useless to the crawler that
    // reads it. The sibling failure in routes/public/manifest.ts is the
    // opposite shape (JSON.stringify DELETES the key), which is worth knowing
    // when reading both: neither one fails loudly.
    //
    // wrangler.jsonc always sets the var, so this is a latent trap. It is
    // pinned because the alternative -- discovering it from a crawler's
    // complaint a week later -- is the failure mode this whole file is about.
    const text = await body("/llms.txt", undefined, env({ SITE_DOMAIN: undefined }));

    expect(text).toContain("- [About Give Food](undefined/about-us/)");
    expect(text).toContain("- Website: undefined\n");
    // All 47 of them, not just the first: the count is asserted so that a
    // future edit which adds a link built some other way (a hardcoded domain,
    // say) is visible here rather than only in the byte comparison.
    expect(text.split("undefined")).toHaveLength(48);
  });
});

// ===========================================================================
// How llms.txt is served
// ===========================================================================

describe("how llms.txt is served", () => {
  it("is text/plain WITH charset=utf-8, matching Django's render() call", async () => {
    // views.py:917 passes content_type='text/plain; charset=utf-8'. The
    // sibling security.txt in this same module sends bare "text/plain"
    // because ITS Django source did -- see that test. Both are pinned so
    // neither drifts towards the other for the sake of tidiness.
    const res = await get("/llms.txt");
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("sets a week of Cache-Control itself, with no s-maxage from the middleware", async () => {
    // @cache_page(SECONDS_IN_WEEK) again. pageCacheControl.ts is a gap-filler
    // that never overrides an existing Cache-Control AND no longer treats
    // text/plain as cacheable, so this value is entirely the handler's -- two
    // independent reasons the middleware cannot be what produced it. The
    // mutant this kills is max-age=86400 -- a plausible-looking number that
    // silently sextuples the origin load from crawlers.
    const res = await get("/llms.txt");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage");
  });

  it("carries NO Cache-Tag, so the counts inside it cannot be purged", async () => {
    // SUSPECT, pinned rather than fixed. The body embeds the site-wide food
    // bank and donation point counts, which change whenever a food bank is
    // added -- exactly the dependency cacheTag.ts's AGGREGATE_TAG exists to
    // express -- but AGGREGATE_PATHS matches /sitemap*.xml, the home page and
    // the API list endpoints, and not /llms.txt. Combined with the week-long
    // TTL above, a stale count can sit at the edge for seven days with no way
    // for queues/cachePurge.ts to reach it.
    //
    // The practical harm is small (the number is approximate prose, and the
    // "+" on the donation point count says so) which is presumably why it was
    // never tagged. Written down rather than changed.
    const res = await get("/llms.txt");
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  it("mints no cookie and no Vary, so the edge may share one copy", async () => {
    const res = await get("/llms.txt");

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns byte-identical documents to two requests", async () => {
    // No timestamp, no request id, no per-visitor field: the document is a
    // pure function of (SITE_DOMAIN, site_stats). That is what makes a week
    // in a shared cache safe, and it is cheap to lose -- every HTML page on
    // this site carries a render clock in debugcomment.njk for exactly that
    // reason, and this route deliberately renders no template.
    expect(await body("/llms.txt")).toBe(await body("/llms.txt"));
  });

  it("answers HEAD with the same headers and no body", async () => {
    // Not protocol politeness: lib/appendSlash.ts probes with HEAD to decide
    // whether to 301, so HEAD on a real route is load-bearing routing
    // machinery in this app.
    const res = await get("/llms.txt", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect(await res.text()).toBe("");
  });
});

// ===========================================================================
// The URLs that reach these two handlers
// ===========================================================================

describe("routing", () => {
  it("serves both documents at exactly Django's untranslated paths", async () => {
    // givefood/urls.py:64-65, in the "Untranslated pages" block AFTER
    // i18n_patterns closes -- so neither document has, or ever had, a locale
    // variant. index.ts:503-504 registers them the same way, outside the
    // LOCALES loop.
    expect((await get("/llms.txt")).status).toBe(200);
    expect((await get("/.well-known/security.txt")).status).toBe(200);
  });

  it.each(["/cy/llms.txt", "/ga/llms.txt", "/gd/llms.txt", "/cy/.well-known/security.txt"])("404s the locale-prefixed %s", async (path) => {
    // The negative half of the registration above. A locale loop copied from
    // the block a few lines up in index.ts (manifest.json and sitemap.xml ARE
    // registered per locale) would silently add four URLs Django never had --
    // duplicate documents for a crawler to index, which is the exact harm
    // llms.txt exists to avoid. That loop, added to index.ts, is the one
    // mutant in this file's set that lives outside textFiles.ts; it dies
    // here.
    const res = await get(path);

    expect(res.status).toBe(404);
    // The 404 PAGE, not a text/plain body -- i.e. it reached app.notFound()
    // rather than the handler under some other locale.
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
  });

  it("404s /en/llms.txt, because en is never a prefix", async () => {
    // resolveLanguage.ts: "en" is deliberately not in PREFIXES
    // (prefix_default_language=False in Django).
    expect((await get("/en/llms.txt")).status).toBe(404);
  });

  it("404s a POST to either, where Django's path() would have answered it", async () => {
    // A DIVERGENCE, pinned. Django's urls.py puts no method restriction on
    // either view, so a POST rendered the same document with a 200; index.ts
    // registers app.get only, so Hono has no matching route and the request
    // reaches app.notFound(). Nothing posts to a text file, so this is noted
    // rather than mourned.
    expect((await get("/llms.txt", { method: "POST" })).status).toBe(404);
    expect((await get("/.well-known/security.txt", { method: "POST" })).status).toBe(404);
  });

  it("does not answer /llms.txt/ with a slash appended", async () => {
    // PLAN.md §3.5's APPEND_SLASH only ever ADDS a trailing slash to a path
    // that has none; it does not strip one. So the slashed spelling of a file
    // URL is a plain 404 rather than a redirect back to the real document.
    const res = await get("/llms.txt/");

    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
  });
});

// ===========================================================================
// llmsTxt OUTSIDE the router
// ===========================================================================

// index.ts mounts this handler on exactly one path, and unlike its neighbour
// manifestJson it reads NO request state at all -- no `lang`, no path, no
// header -- only c.env. This is not a second copy of the router and asserts
// nothing about routing (every routing assertion above uses the real app); it
// mounts the REAL exported handler somewhere else to demonstrate that
// independence, the same device as routes/public/manifest.test.ts's
// guardHarness.
const harness = new Hono<AppEnv>();
harness.get("/anywhere.txt", llmsTxt);

describe("llmsTxt mounted on a different path", () => {
  it("renders the identical document, with no dependence on the request", async () => {
    // If the handler ever grew a `c.get("lang")` or a `c.req.path`, this is
    // where it would show. It matters because the document's URLs are built
    // from SITE_DOMAIN and are ABSOLUTE and UNPREFIXED -- a locale-aware
    // llms.txt would need its own registrations, and the test above says
    // Django never had them.
    const res = await harness.fetch(new Request(`${ORIGIN}/anywhere.txt`), env(), execCtx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expectedLlmsTxt(ORIGIN, "2,937", "4,051"));
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });
});

// ===========================================================================
// THE LINK CRAWL -- is what llms.txt says about this site actually true?
// ===========================================================================

// Every URL in the document that is (a) on this site and (b) not a
// placeholder like /needs/at/{slug}/, extracted from the SERVED BODY rather
// than listed by hand, so a bullet added tomorrow is crawled too.
function advertisedPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(new RegExp(`${ORIGIN}(/[^\\s)]*)`, "g"))) {
    const path = match[1]!;
    // {slug}, {id}, {location}, {language-code}, {country-slug}: documented
    // URL TEMPLATES, not URLs. Their real shapes are checked individually
    // below, where the substitution is obvious.
    if (!path.includes("{")) paths.add(path);
  }
  return [...paths].sort();
}

// The set the document currently advertises, written out so that ADDING or
// REMOVING a bullet is a visible, deliberate change rather than a silent one
// -- the crawl below would happily pass with half the site missing.
const ADVERTISED = [
  "/2025/",
  "/about-us/",
  "/annual-reports/",
  "/api/",
  "/api/2/constituencies/",
  "/api/2/docs/",
  "/api/2/donationpoints/",
  "/api/2/foodbanks/",
  "/api/2/locations/",
  "/api/2/needs/",
  "/bot/",
  "/dashboard/",
  "/dashboard/bean-pasta-index/",
  "/dashboard/charity-income-expenditure/",
  "/dashboard/donationpoints/supermarkets/",
  "/dashboard/foodbanks-found/",
  "/dashboard/item-categories/",
  "/dashboard/items-requested-weekly/",
  "/dashboard/items-requested-weekly/by-year/",
  "/dashboard/most-excess-items/",
  "/dashboard/most-requested-items/",
  "/donate/",
  "/england/",
  "/md/sitemap.md",
  "/needs/",
  "/needs/geo.json",
  "/needs/rss.xml",
  "/northern-ireland/",
  "/privacy/",
  "/register-foodbank/",
  "/scotland/",
  "/wales/",
  "/write/",
];

describe("the URLs llms.txt advertises", () => {
  it("advertises exactly the 33 on-site URLs listed above", async () => {
    expect(ADVERTISED).toHaveLength(33);
    expect(advertisedPaths(await body("/llms.txt"))).toEqual(ADVERTISED);
  });

  it("REQUESTS EVERY ONE OF THEM through the real router, and none 404s", async () => {
    // THE POINT OF THIS FILE'S SECOND HALF. llms.txt is documentation aimed
    // at machines, and documentation of a URL that does not exist is the one
    // failure it can have that nothing else here would catch: the crawler
    // gets a 404, this Worker logs a routine 404, and the two facts are never
    // put together. Two bullets have ALREADY had to be removed for exactly
    // this reason (/dumps/ and /colophon/), which is the evidence that this
    // is a live failure mode and not a hypothetical one.
    //
    // Fixtures are empty apart from site_stats, so this asserts ROUTING and
    // rendering with no rows, not content. Every path answers 200 on an empty
    // database except /needs/, which 301s (see the next test).
    const statuses: Record<string, number> = {};
    for (const path of ADVERTISED) statuses[path] = (await get(path)).status;

    const notPlainlyOk = Object.entries(statuses).filter(([, status]) => status !== 200);
    expect(notPlainlyOk).toEqual([["/needs/", 301]]);
  });

  it("sends a crawler following /needs/ to the home page, exactly as Django did", async () => {
    // Pinned because it reads like a defect and is not: the bullet describes
    // /needs/ as "Search by postcode, town, or location", and a bare GET with
    // no location signal at all 301s to "/" -- routes/wfbn/index.ts:56,
    // matching Django's own redirect. So the crawler still lands on a real
    // page; it is just not the one the sentence describes.
    const res = await get("/needs/");

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("does not advertise the two paths this port deliberately 404s", async () => {
    // Edits 1 and 2 of expectedLlmsTxt(), checked against the router rather
    // than against the text: these two are gone from the site, so a document
    // that still listed them would be sending crawlers to a 404.
    const text = await body("/llms.txt");

    expect(text).not.toContain("/colophon/");
    expect(text).not.toContain("/dumps/");
    expect((await get("/colophon/")).status).toBe(404);
    expect((await get("/dumps/")).status).toBe(404);
  });

  it("advertises the subscribe URL that this Worker actually routes", async () => {
    // Edit 5, the one textFiles.ts's header says was "verified against the
    // real route". Verified here too, and against the ROUTER rather than
    // against packages/urls: the advertised shape must be a registered path,
    // and Django's shape must not be one.
    const text = await body("/llms.txt");
    const getPaths = app.routes.filter((route) => route.method === "GET").map((route) => route.path);

    expect(text).toContain(`${ORIGIN}/needs/at/{slug}/updates/subscribe/`);
    expect(text).not.toContain(`${ORIGIN}/needs/at/{slug}/subscribe/`);
    expect(getPaths).toContain("/needs/at/:slug/updates/:action{subscribe|confirm|unsubscribe}/");
    // Django's spelling is not merely unrouted, it is WORSE than a 404: it
    // matches the location-detail route, so /needs/at/<slug>/subscribe/ is
    // read as a food bank location called "subscribe". A crawler following
    // Django's llms.txt was being told a location page was a subscribe form.
    expect(getPaths).not.toContain("/needs/at/:slug/subscribe/");
    expect(getPaths).toContain("/needs/at/:slug/:locslug/");
  });

  it("advertises URL templates whose real shapes are routed too", async () => {
    // The five placeholder URLs the crawl above skips, checked by their route
    // patterns instead. They are the ones an LLM reading this document is
    // most likely to construct by hand, so a wrong template here is a wrong
    // URL repeated by every consumer.
    const getPaths = app.routes.filter((route) => route.method === "GET").map((route) => route.path);

    expect(getPaths).toContain("/api/2/foodbank/:slug/");
    expect(getPaths).toContain("/api/2/foodbanks/search/");
    expect(getPaths).toContain("/api/2/need/:id/");
    expect(getPaths).toContain("/api/2/constituency/:slug/");
    expect(getPaths).toContain("/needs/at/:slug/geo.json");
    expect(getPaths).toContain("/needs/at/:slug/rss.xml");
    // `:parlconSlug`, not `:slug` -- the param NAME differs from its siblings
    // (index.ts:282 vs :307) and is asserted as written rather than as
    // expected, because a test that guessed here would be pinning the guess.
    expect(getPaths).toContain("/needs/in/constituency/:parlconSlug/geo.json");
    // "Access any language via: <domain>/{language-code}/" -- true for the
    // three prefixes, and NOT for /en/, which 404s (asserted above).
    for (const locale of LOCALES.filter((l) => l !== "en")) expect(getPaths).toContain(`/${locale}/`);
  });
});
