// Regression tests for workers/site/src/middleware/pageCacheControl.ts.
//
// Same shape as tools/webpush-vector/verify.ts: `pnpm run verify:cache-headers`,
// but living under workers/site because it imports Hono, which only
// resolves inside that package.
// no test framework, exits non-zero on failure.
//
// THIS FILE EXISTS BECAUSE THE FIRST VERSION OF THAT MIDDLEWARE WAS WRONG.
// The locale prefix was written as the character class "(?:[a-z-]{2,7}/)?",
// which matches /cy/ and /gd/ as intended and also matches "privacy",
// "rss" and "md" -- so /privacy/ was read as a locale home page and given
// Django's one hour instead of Django's one week. Nothing about the page
// would have looked wrong; it would just have been re-fetched 168 times
// more often than intended, forever. A header regression is invisible
// exactly the way a cache bug is, so it gets tests.
//
// Expected s-maxage values are Django's own @cache_page arguments, read
// from gfwfbn/views.py and givefood/views.py.
import { Hono } from "hono";
import { pageCacheControl } from "../../src/middleware/pageCacheControl";

const app = new Hono();
app.use("*", pageCacheControl as never);
app.get("/nostore/", (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  return c.html("x");
});
app.get("/cookie/", (c) => { c.header("Set-Cookie", "s=1; Path=/"); return c.html("x"); });
app.get("/json/", (c) => c.json({ a: 1 }));
app.get("/needs/at/x/rss/", () => new Response("<rss/>", { headers: { "Content-Type": "application/rss+xml" } }));
app.get("/needs/at/x/md/", () => new Response("# hi", { headers: { "Content-Type": "text/markdown; charset=UTF-8" } }));
app.get("/404/", (c) => c.html("nope", 404));
app.post("/post/", (c) => c.html("x"));
app.get("*", (c) => c.html("<p>page</p>"));

const DAY = "public, max-age=300, s-maxage=86400";
const HOUR = "public, max-age=300, s-maxage=3600";
const WEEK = "public, max-age=300, s-maxage=604800";

const CASES: [string, string, string][] = [
  // The bulk of the site: a food bank's pages, @cache_page(SECONDS_IN_DAY).
  ["GET", "/needs/at/salvation-army/", DAY],
  ["GET", "/needs/at/salvation-army/news/", DAY],
  // A slug that STARTS with a word used elsewhere in the table -- the
  // regression that motivated this file, from the other direction.
  ["GET", "/needs/at/privacy-foodbank/", DAY],
  ["GET", "/needs/at/x/rss/", DAY],
  ["GET", "/needs/at/x/md/", DAY],
  // index / news / country, @cache_page(SECONDS_IN_HOUR), with and without
  // a locale prefix.
  ["GET", "/", HOUR],
  ["GET", "/cy/", HOUR],
  ["GET", "/news/", HOUR],
  ["GET", "/gd/news/", HOUR],
  ["GET", "/scotland/", HOUR],
  ["GET", "/cy/scotland/", HOUR],
  // @cache_page(SECONDS_IN_WEEK).
  ["GET", "/needs/at/x/nearby/", WEEK],
  ["GET", "/privacy/", WEEK],
  ["GET", "/about-us/", WEEK],
  ["GET", "/cy/about-us/", WEEK],
  ["GET", "/donate/", WEEK],
  ["GET", "/constituencies/", WEEK],
  ["GET", "/2024/", WEEK],
  // The guards. Each of these must come back EXACTLY as the route left it.
  ["GET", "/nostore/", "private, no-store, max-age=0, must-revalidate"],
  ["GET", "/cookie/", "<none>"],
  ["GET", "/json/", "<none>"],
  ["GET", "/404/", "<none>"],
  ["POST", "/post/", "<none>"],
];

let failures = 0;
for (const [method, path, want] of CASES) {
  const res = await app.request(`http://x${path}`, { method });
  const got = res.headers.get("Cache-Control") ?? "<none>";
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${method} ${path.padEnd(31)} ${got}${ok ? "" : `   WANT ${want}`}`);
}
console.log(failures ? `\n${failures} of ${CASES.length} FAILED` : `\nall ${CASES.length} passed`);
if (failures) process.exit(1);
