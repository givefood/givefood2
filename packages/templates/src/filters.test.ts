import { describe, expect, it } from "vitest";
import {
  commaSeparated,
  djangoDate,
  djangoSlice,
  djangoTitle,
  floatformat,
  formatDjangoDateTokens,
  friendlyPhone,
  friendlyUrl,
  fullPhone,
  intcomma,
  linebreaks,
  linebreaksbr,
  slugify,
  truncatechars,
  truncatewords,
} from "./filters";

// HOW THE "Django gives X" CLAIMS IN THIS FILE WERE CHECKED.
//
// Unlike packages/models/src/textClean.test.ts -- which had to reconstruct
// its reference in python3 because the Django tree is not in this repo --
// every expected value below marked "Django 6.1" was produced by RUNNING the
// reference tree's own interpreter:
//
//   /Users/jasoncartwright/Sites/foodcharity/.venv/bin/python
//   Django 6.1, CPython 3.12.3, furl 2.1.4
//
// through django.template.Template(...).render(Context(...)) for the filter
// forms, django.utils.dateformat.format() for the date tokens, and a copy of
// givefood/utils/text.py:make_url_friendly for friendly_url. Nothing here is
// reasoned about from memory; where I could not check something, the comment
// says "not verified" rather than inventing a citation.
//
// WHY THIS MODULE IS WORTH THIS MUCH TEST. These fifteen functions are the
// whole template-filter surface. They are not called by any TypeScript that a
// typechecker can police -- env.ts hands each one to nunjucks under a Django
// filter NAME, and from then on the only caller is a .njk file. A wrong
// output here does not throw, does not log, and does not fail a route test
// that asserts a status code: it renders a plausible-looking page with the
// wrong phone number, the wrong date, or someone's tracking parameters
// intact. The two functions that CAN throw (friendlyUrl, commaSeparated) 500
// the whole page when they do, because a nunjucks filter exception aborts the
// render, and both are reachable from an unguarded template expression.
//
// SEVERAL DIVERGENCES FROM DJANGO ARE PINNED HERE AS-IS. Per TESTING.md,
// tests pin what the port DOES; each one carries the Django output it differs
// from so a future reader can tell a known gap from a regression.

// ---------------------------------------------------------------------------
// friendlyPhone -- givefood/utils/text.py:make_friendly_phone
// ---------------------------------------------------------------------------
describe("friendlyPhone", () => {
  // The whole point of the filter: wfbn/index.njk renders
  // `{{ location.phone_number|friendly_phone }}` next to a
  // `tel:{{ ...|full_phone }}` href, so this is the string a visitor reads
  // off a food bank page. Django 6.1: '01234 567 890'.
  it("groups a stored 11-digit UK number as 5 + 3 + 3", () => {
    expect(friendlyPhone("01234567890")).toBe("01234 567 890");
  });

  // Python's make_friendly_phone returns `phone` itself on a falsy value, not
  // "" -- so a null column stays null and nunjucks renders it as "" via its
  // own undefined handling. Asserting toBeNull() rather than toBeFalsy()
  // because a "fix" that returned "" here would change what a caller holding
  // the value (rather than rendering it) sees.
  it("passes null straight through rather than formatting it", () => {
    expect(friendlyPhone(null)).toBeNull();
  });

  it("passes the empty string through untouched", () => {
    expect(friendlyPhone("")).toBe("");
  });

  // Django 6.1: '0123  ' -- two trailing spaces, because Python's phone[5:8]
  // and phone[8:] on a 4-character string are both "". This is pinned rather
  // than tidied up: the live site has rendered it this way for years, and a
  // length guard added here would be a silent behaviour change on exactly the
  // malformed rows that produced it. JS .slice() past the end agrees with
  // Python's slice, which is why the port needs no special case.
  it("still emits both separators when the number is too short to split", () => {
    expect(friendlyPhone("0123")).toBe("0123  ");
  });

  // Everything after position 8 goes in the last group -- there is no
  // fixed-width final segment. A mutant using phone.slice(8, 11) would pass
  // the 11-digit test above and fail here.
  it("puts every remaining digit in the final group, however long", () => {
    expect(friendlyPhone("1234567890123")).toBe("12345 678 90123");
  });

  // Same column, no validation: foodbank_detail.njk pipes phone_number
  // through friendly_phone whatever it contains. Pinned so the garbage-in
  // shape is documented rather than discovered on a page.
  it("blindly groups an already-international number too", () => {
    expect(friendlyPhone("+441234567890")).toBe("+4412 345 67890");
  });
});

// ---------------------------------------------------------------------------
// fullPhone -- givefood/utils/text.py:make_full_phone
// ---------------------------------------------------------------------------
describe("fullPhone", () => {
  // This one is not cosmetic: it builds the `tel:` href. Getting it wrong
  // means a visitor's phone dials a number that does not exist.
  it("swaps a leading 0 for the +44 country code", () => {
    expect(fullPhone("01234567890")).toBe("+441234567890");
  });

  // The trunk 0 is REPLACED, not prefixed -- "+4401234..." would be a
  // non-dialable number. Kills a mutant using `+44${phone}`.
  it("drops the trunk zero rather than keeping it after +44", () => {
    expect(fullPhone("0800000000")).toBe("+44800000000");
    expect(fullPhone("0800000000")).not.toContain("+440");
  });

  it("leaves a number that does not start with 0 alone", () => {
    expect(fullPhone("441234567890")).toBe("441234567890");
    expect(fullPhone("+441234567890")).toBe("+441234567890");
  });

  // Only a LEADING zero counts. A mutant testing .includes("0") would rewrite
  // this into nonsense.
  it("ignores zeros that are not the first character", () => {
    expect(fullPhone("1023456789")).toBe("1023456789");
  });

  it("passes null and empty through unchanged, like Python's falsy branch", () => {
    expect(fullPhone(null)).toBeNull();
    expect(fullPhone("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// friendlyUrl -- givefood/utils/text.py:make_url_friendly (furl-based)
// ---------------------------------------------------------------------------
describe("friendlyUrl", () => {
  it("strips the scheme and the trailing slash", () => {
    // Django 6.1 + furl 2.1.4, all three: 'example.com', 'example.com',
    // 'example.com/path'.
    expect(friendlyUrl("https://example.com/")).toBe("example.com");
    expect(friendlyUrl("https://example.com")).toBe("example.com");
    expect(friendlyUrl("http://example.com/path/")).toBe("example.com/path");
  });

  // Only a TRAILING slash goes; interior ones stay. Kills a mutant using a
  // global replace of "/".
  it("keeps interior slashes", () => {
    expect(friendlyUrl("https://example.com/a/b/c")).toBe("example.com/a/b/c");
  });

  it("keeps a non-default port", () => {
    // furl agrees: 'example.com:8080/x'.
    expect(friendlyUrl("https://example.com:8080/x")).toBe("example.com:8080/x");
  });

  // The actual job of the filter. Every key in QUERYSTRING_RUBBISH
  // (givefood/const/general.py:178) gets its own case, because a table with
  // one name misspelled would still pass a test that only checked
  // utm_source -- and the visible symptom would be a food bank's own
  // tracking parameters showing up in the link text on its public page.
  // The `keep` parameter is here to be EXCLUDED from the removal: a mutant
  // that drops the query string entirely passes every "utm is gone" check.
  it.each([
    ["utm_source", "example.com/p?keep=1"],
    ["utm_medium", "example.com/p?keep=1"],
    ["utm_campaign", "example.com/p?keep=1"],
    ["y_source", "example.com/p?keep=1"],
    ["sc_cmp", "example.com/p?keep=1"],
    ["extcam", "example.com/p?keep=1"],
    ["utm_content", "example.com/p?keep=1"],
  ])("removes the %s tracking parameter and keeps the rest", (key, expected) => {
    expect(friendlyUrl(`https://example.com/p?${key}=x&keep=1`)).toBe(expected);
  });

  it("removes every rubbish parameter at once, leaving no empty query", () => {
    const url = "https://example.com/p?y_source=1&sc_cmp=2&extcam=3&utm_content=4&utm_campaign=5&utm_medium=6&utm_source=7";
    // Not "example.com/p?" -- URL.search is "" once the last parameter goes,
    // so no stray question mark reaches the page. furl agrees: 'example.com/p'.
    expect(friendlyUrl(url)).toBe("example.com/p");
  });

  it("preserves the order of the parameters it keeps", () => {
    // furl 2.1.4 agrees: 'example.com/p?b=2&a=1'. Order matters because the
    // result is displayed as link TEXT next to the real href -- a reordered
    // query would make the two look like different URLs.
    expect(friendlyUrl("https://example.com/p?b=2&a=1&utm_source=z")).toBe("example.com/p?b=2&a=1");
  });

  it("removes a repeated rubbish parameter completely", () => {
    expect(friendlyUrl("https://example.com/p?utm_source=1&utm_source=2&k=3")).toBe("example.com/p?k=3");
  });

  it("re-encodes a percent-escaped space as + when it rewrites the query", () => {
    // Surprising but CORRECT: furl 2.1.4 produces 'example.com/p?q=a+b' for
    // this input too, because both libraries re-serialise the query through
    // an application/x-www-form-urlencoded encoder. Pinned so nobody
    // "restores" %20 and diverges from the live site.
    expect(friendlyUrl("https://example.com/p?q=a%20b&utm_source=x")).toBe("example.com/p?q=a+b");
  });

  it("percent-encodes a literal space in the path", () => {
    // furl 2.1.4: 'example.com/a%20b'.
    expect(friendlyUrl("https://example.com/a b")).toBe("example.com/a%20b");
  });

  // ---- Divergences from furl, pinned as-is ----

  // SUSPECT. furl 2.1.4 returns 'EXAMPLE.com/Path'; WHATWG URL lowercases the
  // host at parse time. Cosmetic (the href beside it is untouched), and the
  // lowercase form is arguably better, but it IS a difference in what a
  // visitor reads, so it is recorded here rather than left to be rediscovered.
  it("lowercases the host, where furl preserved its case", () => {
    expect(friendlyUrl("https://EXAMPLE.com/Path")).toBe("example.com/Path");
  });

  // SUSPECT. furl 2.1.4 returns 'example.com/#frag'. The port rebuilds the
  // output as host + pathname + search with no `.hash`, so the fragment is
  // silently dropped -- and here the trailing "/" left behind is then stripped
  // too, so the whole "/#frag" disappears. A food bank whose URL points at an
  // anchor renders as the bare domain.
  it("drops the fragment entirely, unlike furl", () => {
    expect(friendlyUrl("https://example.com/#frag")).toBe("example.com");
    expect(friendlyUrl("https://example.com/page#section")).toBe("example.com/page");
  });

  // SUSPECT. furl 2.1.4 returns 'user:pw@example.com/x'.
  it("drops userinfo, unlike furl", () => {
    expect(friendlyUrl("https://user:pw@example.com/x")).toBe("example.com/x");
  });

  // SUSPECT. Python's str.replace() removes EVERY "https://", so Django turns
  // this into 'example.com/r?u=foo'. The port's ^-anchored regex removes only
  // the leading one, and the survivor makes the remainder unparseable as a
  // URL -- so a food bank whose stored URL is a redirect wrapper does not
  // render differently, it throws, and a thrown filter aborts the whole
  // nunjucks render (a 500 on the food bank page, not a cosmetic glitch).
  it("throws on an embedded scheme that Django would have stripped", () => {
    expect(() => friendlyUrl("http://example.com/r?u=https://foo")).toThrow(TypeError);
  });

  // SUSPECT, and the most reachable of these. Django's own filter guards
  // `if url:` and returns "" (givefood/templatetags/custom_tags.py:15-18);
  // the port registers friendlyUrl raw in env.ts, with no guard. Every other
  // *_url in admin/foodbank_detail.njk sits behind an `{% if %}`, but line 73
  // pipes `foodbank.shopping_list_url` through unguarded, and that column is
  // TEXT NOT NULL (packages/db/migrations/0001_core.sql:27) -- NOT NULL does
  // not mean non-empty. An empty one 500s the admin food bank page.
  it("throws on an empty string, where Django's filter returned an empty string", () => {
    expect(() => friendlyUrl("")).toThrow(TypeError);
  });

  it("throws on a value that is not a URL at all", () => {
    expect(() => friendlyUrl("not a url at all")).toThrow(TypeError);
  });

  // Scheme-relative and uppercase-scheme inputs also part company with furl
  // ('//example.com/x' and 'https://example.com' respectively). Both are
  // pinned because a stored URL is free text typed into an admin form.
  it("normalises inputs whose scheme furl did not recognise", () => {
    expect(friendlyUrl("//example.com/x")).toBe("example.com/x");
    expect(friendlyUrl("HTTPS://example.com/")).toBe("example.com");
  });

  it("accepts a schemeless host, as furl did", () => {
    expect(friendlyUrl("example.com/x")).toBe("example.com/x");
  });
});

// ---------------------------------------------------------------------------
// commaSeparated -- custom_tags.py:comma_separated (", ".join(splitlines()))
// ---------------------------------------------------------------------------
describe("commaSeparated", () => {
  it("joins newline-separated lines with a comma and a space", () => {
    expect(commaSeparated("Tinned tomatoes\nUHT milk\nPasta")).toBe("Tinned tomatoes, UHT milk, Pasta");
  });

  it("returns a single line unchanged", () => {
    expect(commaSeparated("Tinned tomatoes")).toBe("Tinned tomatoes");
  });

  it("does not touch spaces inside a line", () => {
    expect(commaSeparated("Tinned tomatoes")).not.toContain(",");
  });

  it("returns the empty string for the empty string", () => {
    expect(commaSeparated("")).toBe("");
  });

  // Django 6.1 agrees here: ", ".join("a\n\nb".splitlines()) == 'a, , b'.
  // The blank line is a real element, not skipped. Pinned because it looks
  // like a bug and is not.
  it("keeps a blank line as an empty element, exactly as splitlines does", () => {
    expect(commaSeparated("a\n\nb")).toBe("a, , b");
  });

  // ---- Divergences from CPython's str.splitlines(), pinned as-is ----

  // SUSPECT. Python's splitlines() splits on \r\n, a lone \r, \v, \f,
  // and more; the port splits on "\n" alone. Verified on CPython 3.12.3:
  //   ", ".join("a\r\nb".splitlines()) == 'a, b'
  //   ", ".join("a\rb".splitlines())   == 'a, b'
  // A carriage return survives into the port's output instead. Windows line
  // endings are exactly what a pasted address block from an admin form
  // contains, so this is reachable, not theoretical.
  it("leaves a carriage return attached instead of splitting on it", () => {
    expect(commaSeparated("a\r\nb")).toBe("a\r, b");
    expect(commaSeparated("a\rb")).toBe("a\rb");
  });

  // SUSPECT. CPython: ", ".join("a\nb\n".splitlines()) == 'a, b' -- a
  // trailing newline produces no trailing element. The port's split() does,
  // so the output ends with a dangling ", ". A trailing newline in a stored
  // textarea column is the norm, not the exception.
  it("emits a trailing separator for a trailing newline, where Django emitted none", () => {
    expect(commaSeparated("a\nb\n")).toBe("a, b, ");
  });

  // SUSPECT. Django's filter guards `if value:` and returns "". The port has
  // no guard, so a nullable column reaching this filter throws, and a throw
  // inside a nunjucks filter aborts the entire render.
  it("throws on null rather than rendering an empty string", () => {
    expect(() => commaSeparated(null as unknown as string)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// slugify -- django.utils.text.slugify(allow_unicode=False)
// ---------------------------------------------------------------------------
describe("slugify", () => {
  // Used for `class="form-{{ title|slugify }}"` in five admin form templates;
  // static/js/admin.js selects on those class names, so a changed slug
  // silently unhooks the JS from the form.
  it("lowercases, drops punctuation and joins on hyphens", () => {
    // Django 6.1 slugify('Hello, World!') == 'hello-world'.
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  // The NFKD step is load-bearing and easy to delete by accident: without it
  // the accented letters are simply removed and "Café Crème" becomes
  // "caf-crme". Django 6.1 gives 'cafe-creme' and so does the port -- this is
  // the test that proves the normalize() call actually runs. (The
  // combining-mark strip on the next line of the module cannot be tested
  // separately, and nothing here claims to: every mark in U+0300-U+036F is
  // above U+007F, so the non-ASCII strip immediately after would remove them
  // anyway. Deleting that line changes no output at all -- verified by
  // deleting it and re-running this file.)
  it("folds accents to their base letters rather than deleting them", () => {
    expect(slugify("  Café Crème  ")).toBe("cafe-creme");
  });

  // The other half of the ASCII fold: a character with no ASCII decomposition
  // is dropped outright. Django 6.1: 'eta' and '' respectively (its
  // .encode("ascii", "ignore") and the port's non-ASCII strip agree).
  it("drops characters that do not decompose to ASCII", () => {
    expect(slugify("ßeta")).toBe("eta");
    expect(slugify("中文")).toBe("");
  });

  it("collapses runs of spaces and hyphens into one hyphen", () => {
    // Django 6.1: 'a-b-c'.
    expect(slugify("a---b   c")).toBe("a-b-c");
  });

  // Underscore is a \w character, so it survives in the MIDDLE but is
  // stripped from the ENDS by Python's .strip("-_"). Both halves in one test
  // because a mutant that strips only "-" passes if you check either alone.
  it("keeps interior underscores but strips them from the ends", () => {
    // Django 6.1: '2026-report_v2' and 'abc'.
    expect(slugify("2026 Report_v2")).toBe("2026-report_v2");
    expect(slugify("-_-abc-_-")).toBe("abc");
  });

  it("removes apostrophes and ampersands entirely", () => {
    // Django 6.1: 'mr-obrien-sons' -- note "O'Brien" becomes "obrien", the
    // apostrophe vanishing without leaving a hyphen.
    expect(slugify("Mr. O'Brien & Sons")).toBe("mr-obrien-sons");
  });

  it("returns the empty string for the empty string", () => {
    expect(slugify("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// intcomma -- django.contrib.humanize.templatetags.humanize.intcomma
// ---------------------------------------------------------------------------
describe("intcomma", () => {
  it("leaves anything under a thousand alone", () => {
    expect(intcomma(0)).toBe("0");
    expect(intcomma(1)).toBe("1");
    expect(intcomma(999)).toBe("999");
  });

  it("inserts a separator at the first thousand", () => {
    expect(intcomma(1000)).toBe("1,000");
  });

  // The regex only ever inserts ONE separator per pass; the do/while is what
  // makes the rest appear. A mutant that replaces the loop with a single
  // .replace() returns "1234,567" here and "1234567,890" below, so these two
  // are the load-bearing cases for the whole function.
  it("loops until every group of three is separated", () => {
    expect(intcomma(1234567)).toBe("1,234,567");
    expect(intcomma(1234567890)).toBe("1,234,567,890");
    expect(intcomma(1000000000000)).toBe("1,000,000,000,000");
  });

  it("keeps the minus sign outside the first group", () => {
    // Django 6.1: '-1,234,567' -- the -? in the regex is why "-1,234" and not
    // "-,1234". Both the number and the string form are exercised because
    // dashboard rows arrive from D1 as either.
    expect(intcomma(-1234567)).toBe("-1,234,567");
    expect(intcomma(-999)).toBe("-999");
    expect(intcomma("-1000")).toBe("-1,000");
  });

  // The ^ anchor means only the INTEGER part is grouped -- the fractional
  // digits after the point are left alone however many there are. Django 6.1
  // gives '1,234.5678' for the same input.
  it("groups only the digits before the decimal point", () => {
    expect(intcomma("1234.5678")).toBe("1,234.5678");
    expect(intcomma(1234.5)).toBe("1,234.5");
  });

  // Django's intcomma is "fail quietly" -- it stringifies whatever it gets
  // and returns the un-matched string unchanged. Verified on Django 6.1:
  // intcomma('abc') == 'abc', intcomma('1234abc') == '1,234abc'.
  it("passes non-numeric text through, grouping any leading digits", () => {
    expect(intcomma("abc")).toBe("abc");
    expect(intcomma("1234abc")).toBe("1,234abc");
  });

  // Both sides stringify the same way, so both leave exponential notation
  // ungrouped. Django 6.1: intcomma(1e21) == '1e+21'.
  it("leaves a number big enough to stringify in exponential form ungrouped", () => {
    expect(intcomma(1e21)).toBe("1e+21");
  });
});

// ---------------------------------------------------------------------------
// formatDjangoDateTokens -- django.utils.dateformat.DateFormat
// ---------------------------------------------------------------------------
describe("formatDjangoDateTokens", () => {
  // 2026-09-05T19:28:08Z is a Saturday. Every expected string in this block
  // was produced by django.utils.dateformat.format() on the equivalent
  // timezone-aware datetime under Django 6.1.
  const SATURDAY_EVENING = new Date("2026-09-05T19:28:08Z");

  it("renders Django's default DATE_FORMAT/DATETIME_FORMAT", () => {
    // Django 6.1: 'Sept. 5, 2026' and 'Sept. 5, 2026, 7:28 p.m.' -- the exact
    // strings a Django-rendered admin page showed, which is what makes the
    // ported admin pages look unchanged.
    expect(formatDjangoDateTokens(SATURDAY_EVENING, "N j, Y")).toBe("Sept. 5, 2026");
    expect(formatDjangoDateTokens(SATURDAY_EVENING, "N j, Y, P")).toBe("Sept. 5, 2026, 7:28 p.m.");
  });

  it("renders the RFC 2822 form used by the RSS feed and {% now 'r' %}", () => {
    // Django 6.1: 'Sat, 05 Sep 2026 19:28:08 +0000'. wfbn/rss.xml spells this
    // format out as `|date:"D, d M Y H:i:s O"`; an RSS date in any other
    // shape is silently ignored by readers rather than reported.
    expect(formatDjangoDateTokens(SATURDAY_EVENING, "D, d M Y H:i:s O")).toBe("Sat, 05 Sep 2026 19:28:08 +0000");
  });

  it("zero-pads m, d, H, i and s but not j", () => {
    const early = new Date("2026-01-02T03:04:05Z");
    // Django 6.1: '2026-01-02' / '03:04:05' / '2'.
    expect(formatDjangoDateTokens(early, "Y-m-d")).toBe("2026-01-02");
    expect(formatDjangoDateTokens(early, "H:i:s")).toBe("03:04:05");
    expect(formatDjangoDateTokens(early, "j")).toBe("2");
  });

  // Django's `N` is NOT "first three letters plus a full stop": March, April,
  // May, June and July are spelled out and September is "Sept." -- the
  // Associated Press style table, django.utils.dates.MONTHS_AP. The list
  // below is what Django 6.1 actually printed for the 1st of each month of
  // 2026, so it cross-checks the module's MONTHS_AP constant rather than
  // restating it.
  it("uses AP-style month names for N, not simple abbreviations", () => {
    const N = Array.from({ length: 12 }, (_, m) => formatDjangoDateTokens(new Date(Date.UTC(2026, m, 1)), "N"));
    expect(N).toEqual(["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."]);
  });

  // ...and `M` is the plain three-letter abbreviation, with no full stop.
  // Two separate tables, easy to conflate; admin/need.njk uses M and
  // admin/index.njk uses N, so conflating them would misdate both.
  it("uses plain three-letter abbreviations for M", () => {
    const M = Array.from({ length: 12 }, (_, m) => formatDjangoDateTokens(new Date(Date.UTC(2026, m, 1)), "M"));
    expect(M).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  });

  // 2026-09-06 is a Sunday, and getUTCDay() numbers Sunday 0 -- the same
  // off-by-one that the jobs Worker's weekly cron got wrong for Cloudflare
  // (commit 9b11b27). Django 6.1 printed exactly this sequence.
  it("indexes weekday names from Sunday for D", () => {
    const D = Array.from({ length: 7 }, (_, i) => formatDjangoDateTokens(new Date(Date.UTC(2026, 8, 6 + i)), "D"));
    expect(D).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  // Django's `P` has three separate special cases and drops ":00" minutes.
  // Every expected value here came from Django 6.1's dateformat.
  it.each([
    [0, 0, "midnight"],
    [12, 0, "noon"],
    [0, 30, "12:30 a.m."],
    [12, 30, "12:30 p.m."],
    [9, 0, "9 a.m."],
    [13, 5, "1:05 p.m."],
    [23, 59, "11:59 p.m."],
  ])("formats %i:%i as %s with P", (h, m, expected) => {
    expect(formatDjangoDateTokens(new Date(Date.UTC(2026, 8, 5, h, m)), "P")).toBe(expected);
  });

  // "midnight"/"noon" apply only on the exact hour -- 00:01 is not midnight.
  // Kills a mutant that tests the hour without the minute.
  it("does not call 00:01 midnight or 12:01 noon", () => {
    expect(formatDjangoDateTokens(new Date(Date.UTC(2026, 8, 5, 0, 1)), "P")).toBe("12:01 a.m.");
    expect(formatDjangoDateTokens(new Date(Date.UTC(2026, 8, 5, 12, 1)), "P")).toBe("12:01 p.m.");
  });

  // The 11th/12th/13th exception is the whole reason ordinalSuffix exists.
  // Values from Django 6.1's `S` token for January 2026.
  it.each([
    [1, "st"],
    [2, "nd"],
    [3, "rd"],
    [4, "th"],
    [11, "th"],
    [12, "th"],
    [13, "th"],
    [21, "st"],
    [22, "nd"],
    [23, "rd"],
    [30, "th"],
    [31, "st"],
  ])("gives the %ith the suffix %s", (day, suffix) => {
    expect(formatDjangoDateTokens(new Date(Date.UTC(2026, 0, day)), "S")).toBe(suffix);
  });

  // admin/index.njk:124 renders `{{ article.published_date|date("D jS H:i") }}`
  // -- the one place S is used with real data, so it gets an end-to-end case.
  it("renders the article-list format used by the admin dashboard", () => {
    expect(formatDjangoDateTokens(new Date("2026-09-05T19:28:08Z"), "D jS H:i")).toBe("Sat 5th 19:28");
  });

  // EVERY token is read in UTC. vitest.config.mts pins TZ=UTC, which means a
  // mutant swapping getUTCHours() for getHours() would pass every other test
  // in this file -- so this one moves the process clock to UTC+12 and checks
  // the output does not follow it. That is not hypothetical: the Workers
  // runtime is UTC, Django ran with TZ pinned to UTC, and a local-time read
  // here would misdate every admin timestamp by up to a day for anyone
  // running the suite outside the config.
  it("reads the date in UTC, not in the process timezone", () => {
    const original = process.env.TZ;
    try {
      // 19:28 UTC on the 5th is 07:28 on the 6th in Auckland (UTC+12).
      process.env.TZ = "Pacific/Auckland";
      expect(formatDjangoDateTokens(SATURDAY_EVENING, "Y-m-d H:i")).toBe("2026-09-05 19:28");
      expect(formatDjangoDateTokens(SATURDAY_EVENING, "D")).toBe("Sat");
      expect(formatDjangoDateTokens(SATURDAY_EVENING, "P")).toBe("7:28 p.m.");
    } finally {
      process.env.TZ = original;
    }
  });

  it("always reports a +0000 offset for O", () => {
    // Not read off the Date at all -- Workers and Django are both UTC, so the
    // token is the fixed string. Pinned so a future "improvement" that
    // computed it from getTimezoneOffset() is caught.
    expect(formatDjangoDateTokens(new Date("2026-01-15T00:00:00Z"), "O")).toBe("+0000");
    expect(formatDjangoDateTokens(new Date("2026-07-15T00:00:00Z"), "O")).toBe("+0000");
  });

  // ---- Known limits of the token substitution, pinned as-is ----

  // SUSPECT, though flagged by the module itself ("only the tokens actually
  // used by a ported template are supported"). Django 6.1 renders "jS F" as
  // '5th September'; the port leaves F literal. Harmless only for as long as
  // no template uses an unported token -- and there is nothing that warns.
  it("leaves an unsupported format token in the output as a literal", () => {
    expect(formatDjangoDateTokens(SATURDAY_EVENING, "jS F")).toBe("5th F");
  });

  // SUSPECT. Django escapes a literal character with a backslash, so
  // dateformat.format(d, "\\Y") is 'Y' on Django 6.1. The port has no escape
  // handling: the backslash survives and the Y is still substituted. Any
  // literal text in a format string is corrupted the same way -- "Days"
  // becomes "Satay08" -- so a future template that puts a word in its date
  // format gets garbage, not an error.
  it("has no escape syntax, so literal text in a format string is substituted", () => {
    expect(formatDjangoDateTokens(SATURDAY_EVENING, "\\Y")).toBe("\\2026");
    expect(formatDjangoDateTokens(SATURDAY_EVENING, "Days")).toBe("Satay08");
  });

  it("leaves characters that are not tokens untouched", () => {
    expect(formatDjangoDateTokens(SATURDAY_EVENING, "-/:, ")).toBe("-/:, ");
  });
});

// ---------------------------------------------------------------------------
// djangoDate -- the `|date` filter over a D1 TEXT timestamp
// ---------------------------------------------------------------------------
describe("djangoDate", () => {
  // The exact shape Django wrote into these columns: space-separated, six
  // digits of microseconds. If the parse of THIS string ever breaks, every
  // timestamp on every admin page goes blank at once, silently, because the
  // failure path renders "" rather than throwing.
  it("parses the Django timestamp format D1 actually stores", () => {
    expect(djangoDate("2026-09-05 19:28:08.853000", "N j, Y, P")).toBe("Sept. 5, 2026, 7:28 p.m.");
    expect(djangoDate("2026-09-05 19:28:08.853000", "Y-m-d")).toBe("2026-09-05");
    expect(djangoDate("2026-09-05 19:28:08.853000", "D, d M Y H:i:s O")).toBe("Sat, 05 Sep 2026 19:28:08 +0000");
  });

  it("parses a timestamp with no fractional seconds", () => {
    expect(djangoDate("2026-09-05 19:28:08", "N j, Y, P")).toBe("Sept. 5, 2026, 7:28 p.m.");
  });

  // The date-only case the module's comment attributes to production
  // (workers/site/src/lib/timesince.ts's parseUtc). Midnight is Django's own
  // rendering of a bare date under DATETIME_FORMAT.
  it("treats a date with no time part as UTC midnight", () => {
    expect(djangoDate("2026-09-05", "N j, Y, P")).toBe("Sept. 5, 2026, midnight");
  });

  // Appending "Z" to a string that already ends in "Z" produces "...:08ZZ",
  // which is not a valid instant -- so the strip is what keeps an
  // already-ISO value from silently rendering blank.
  it("does not corrupt a value that already carries a Z suffix", () => {
    expect(djangoDate("2026-09-05T19:28:08Z", "N j, Y, P")).toBe("Sept. 5, 2026, 7:28 p.m.");
  });

  it("reads a T-separated value with no suffix as UTC", () => {
    expect(djangoDate("2026-09-05T19:28:08", "N j, Y, P")).toBe("Sept. 5, 2026, 7:28 p.m.");
  });

  // The bug the module's comment describes: admin/index.njk pipes
  // stats.oldest_edit.edited through `|date` unguarded, SQLite sorts NULLs
  // first on ORDER BY edited ASC, so the null lands there whenever any food
  // bank has never been edited -- and a throw would 500 the whole dashboard.
  // Django 6.1 agrees: `{{ None|date:'N j, Y' }}` renders ''.
  it("renders an empty string for a null, undefined or empty timestamp", () => {
    expect(djangoDate(null, "N j, Y, P")).toBe("");
    expect(djangoDate(undefined, "N j, Y, P")).toBe("");
    expect(djangoDate("", "N j, Y, P")).toBe("");
  });

  // The other half of the same guard: an unparseable value must render blank
  // rather than the literal "NaN NaN, NaN" the token substitution would
  // otherwise emit onto the page.
  it("renders an empty string rather than NaN for unparseable text", () => {
    expect(djangoDate("not a date", "N j, Y, P")).toBe("");
    expect(djangoDate("2026-13-45", "N j, Y, P")).toBe("");
    expect(djangoDate("0", "N j, Y, P")).toBe("");
    expect(djangoDate(" ", "N j, Y, P")).toBe("");
  });

  // ---- Divergences, pinned as-is ----

  // SUSPECT, and the sharpest one in this file. A stored value carrying an
  // explicit UTC offset gets a "Z" appended to it -- "...+00:00Z" -- which is
  // not a valid instant, so the value renders as NOTHING. The comment on the
  // function anticipates only a trailing "Z", not an offset. Anything that
  // ever writes an offset-bearing timestamp into one of these columns (a
  // Python .isoformat() with tzinfo produces exactly this shape) blanks the
  // column on every page, with no error anywhere.
  it("silently renders an empty string for a timestamp carrying a +00:00 offset", () => {
    expect(djangoDate("2026-09-05T19:28:08.853000+00:00", "N j, Y, P")).toBe("");
    expect(djangoDate("2026-09-05 19:28:08+00:00", "N j, Y, P")).toBe("");
  });

  // SUSPECT. JS Date rolls an out-of-range day forward instead of rejecting
  // it, so a nonsense stored date renders as a real, wrong date -- worse than
  // the blank the unparseable branch gives, because nothing looks amiss.
  it("rolls an impossible day forward instead of rejecting it", () => {
    expect(djangoDate("2026-02-30", "N j, Y, P")).toBe("March 2, 2026, midnight");
  });
});

// ---------------------------------------------------------------------------
// floatformat -- django's |floatformat:N (the explicit-positive-arg form)
// ---------------------------------------------------------------------------
describe("floatformat", () => {
  it("pads to exactly N decimal places", () => {
    expect(floatformat(1, 2)).toBe("1.00");
    expect(floatformat(0, 0)).toBe("0");
    expect(floatformat(2.5, 1)).toBe("2.5");
  });

  it("rounds down to N places when there are more", () => {
    // Django 6.1: floatformat(34.23234, 3) == '34.232'.
    expect(floatformat(34.23234, 3)).toBe("34.232");
    expect(floatformat(1234.5678, 1)).toBe("1234.6");
  });

  // No thousands separator -- admin/order_group.njk chains floatformat and
  // intcomma separately, so floatformat must not do intcomma's job.
  it("does not group thousands", () => {
    expect(floatformat(1234567.891, 2)).toBe("1234567.89");
  });

  // ---- Divergences from Django's Decimal rounding, pinned as-is ----

  // SUSPECT. Django quantises Decimal(repr(value)) with ROUND_HALF_UP, so it
  // rounds the DECIMAL the user typed; toFixed() rounds the BINARY double,
  // which for these values is a hair below the halfway point. Verified on
  // Django 6.1: floatformat(2.675, 2) == '2.68' and floatformat(1.005, 2) ==
  // '1.01', against '2.67' and '1.00' here. It is a penny either way on a
  // price dashboard -- not visible, and not detectable without this test.
  it("rounds the binary double where Django rounded the decimal literal", () => {
    expect(floatformat(2.675, 2)).toBe("2.67");
    expect(floatformat(1.005, 2)).toBe("1.00");
  });

  // SUSPECT. Django 6.1: floatformat(-0.004, 2) == '0.00'. toFixed() keeps
  // the sign, so a rounded-away negative renders as "-0.00" -- a minus sign
  // in front of a zero on a dashboard, which reads as a data error.
  it("keeps the minus sign on a value that rounds to zero", () => {
    expect(floatformat(-0.004, 2)).toBe("-0.00");
  });

  // Ties: toFixed() rounds half away from zero for these, which happens to
  // match Django's ROUND_HALF_UP on the positive side (verified: 0.5 -> '1',
  // 1.5 -> '2', 2.5 -> '3' on Django 6.1). Pinned because it is the one place
  // the two rounding modes agree and it would be easy to assume they never do.
  it("rounds exact halves away from zero, agreeing with Django there", () => {
    expect(floatformat(0.5, 0)).toBe("1");
    expect(floatformat(1.5, 0)).toBe("2");
    expect(floatformat(2.5, 0)).toBe("3");
  });
});

// ---------------------------------------------------------------------------
// djangoTitle -- django's |title (Python str.title() plus two touch-ups)
// ---------------------------------------------------------------------------
describe("djangoTitle", () => {
  // Registered as django_title because nunjucks' builtin `title` splits on
  // spaces only. These are the cases where the two differ, and where the
  // Django behaviour is the one admin/search.njk expects.
  it("capitalises after a hyphen and a parenthesis, not just a space", () => {
    // Django 6.1: "St. Mary's (West)" and "O'Brien-Smith".
    expect(djangoTitle("st. mary's (west)")).toBe("St. Mary's (West)");
    expect(djangoTitle("o'brien-smith")).toBe("O'Brien-Smith");
  });

  // The first touch-up regex. Python's str.title() alone gives "Bill'S"
  // because an apostrophe is a word boundary; Django lowers the capital
  // back. Without the touch-up every possessive in the admin would read
  // "Bill'S Kitchen".
  it("lowers a capital that str.title() put after an apostrophe", () => {
    expect(djangoTitle("bill's kitchen")).toBe("Bill's Kitchen");
  });

  // The second touch-up. Python's str.title() gives "3Rd"; Django lowers it.
  it("lowers a capital that str.title() put after a digit", () => {
    // Django 6.1: '3rd Avenue' and 'A1b2c3'.
    expect(djangoTitle("3rd avenue")).toBe("3rd Avenue");
    expect(djangoTitle("a1b2c3")).toBe("A1b2c3");
  });

  // str.title() is not "capitalise the first letter" -- it also LOWERS the
  // rest of each word. A shouty name from an admin form comes back readable.
  it("lowers the tail of an all-caps word", () => {
    // Django 6.1: 'Mcdonald'.
    expect(djangoTitle("MCDONALD")).toBe("Mcdonald");
  });

  it("preserves the original spacing", () => {
    // Django 6.1: 'Hello  World' -- the double space survives.
    expect(djangoTitle("hello  world")).toBe("Hello  World");
  });

  it("returns the empty string unchanged", () => {
    expect(djangoTitle("")).toBe("");
  });

  // The documented ASCII-only simplification, pinned so it is a known gap
  // rather than a surprise. Django 6.1 renders "l'été" as "L'Été"; the port
  // treats é as a non-letter, which both leaves it lowercase AND makes the
  // following "t" look like a word start. Accepted because the data is
  // English charity names -- but subscription types and article titles pass
  // through django_title too, so it is not unreachable.
  it("does not title-case non-ASCII letters, and mis-cases the letter after one", () => {
    expect(djangoTitle("l'été")).toBe("L'éTé");
    // A leading ASCII letter still works, which is why the gap is easy to miss.
    expect(djangoTitle("café")).toBe("Café");
  });
});

// ---------------------------------------------------------------------------
// djangoSlice -- django's |slice:"N" (the "first N" form)
// ---------------------------------------------------------------------------
describe("djangoSlice", () => {
  it("returns the first N elements", () => {
    // Django 6.1: {{ [1,2,3,4]|slice:'2' }} renders '[1, 2]'.
    expect(djangoSlice([1, 2, 3, 4], 2)).toEqual([1, 2]);
  });

  it("returns everything when N exceeds the length, rather than padding", () => {
    expect(djangoSlice([1, 2], 5)).toEqual([1, 2]);
  });

  it("returns nothing for zero", () => {
    // Django 6.1: {{ [1,2,3]|slice:'0' }} renders '[]'.
    expect(djangoSlice([1, 2, 3], 0)).toEqual([]);
  });

  // Python's [:-1] drops from the END, and JS .slice() agrees. Pinned because
  // it is the one case where "first N" is the wrong mental model.
  it("drops from the end for a negative count, as Python's slice does", () => {
    expect(djangoSlice([1, 2, 3], -1)).toEqual([1, 2]);
  });

  // A template usually slices a list it ALSO iterates in full elsewhere on
  // the page, so returning the caller's own array (or mutating it) would show
  // up as a truncated list somewhere far from here.
  it("returns a new array rather than the caller's", () => {
    const source = [1, 2, 3];
    const sliced = djangoSlice(source, 3);
    expect(sliced).not.toBe(source);
    expect(source).toEqual([1, 2, 3]);
  });

  it("handles an empty list", () => {
    expect(djangoSlice([], 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// linebreaks -- django.utils.html.linebreaks with autoescape on
// ---------------------------------------------------------------------------
describe("linebreaks", () => {
  // emails/need_notification.njk:23 pipes the need change text through this.
  // The output goes into an email, where a broken tag is not something a
  // reader can refresh past.
  it("splits blank-line-separated text into paragraphs", () => {
    // Django 6.1 renders exactly this, including the "\n\n" between the tags.
    expect(linebreaks("a\n\nb")).toBe("<p>a</p>\n\n<p>b</p>");
  });

  it("turns a single newline inside a paragraph into a br", () => {
    expect(linebreaks("a\nb")).toBe("<p>a<br>b</p>");
  });

  it("collapses three or more newlines into one paragraph break", () => {
    // Django 6.1: '<p>a</p>\n\n<p>b</p>' -- the {2,} is greedy on both sides.
    expect(linebreaks("a\n\n\n\nb")).toBe("<p>a</p>\n\n<p>b</p>");
  });

  it("wraps a single line in one paragraph", () => {
    expect(linebreaks("just one line")).toBe("<p>just one line</p>");
  });

  // The escaping is the security-relevant half: this text comes from a
  // scraped food bank page. A mutant that dropped the escape would put
  // scraped markup straight into a notification email, and the SafeString
  // wrap in env.ts means autoescape will not catch it downstream.
  it("escapes markup before wrapping it", () => {
    expect(linebreaks("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  // The ampersand must be escaped FIRST or the escapes escape each other.
  // If the order were reversed, "<" would come out as "&amp;lt;".
  it("escapes the ampersand before the other entities", () => {
    expect(linebreaks("<")).toBe("<p>&lt;</p>");
    expect(linebreaks("&lt;")).toBe("<p>&amp;lt;</p>");
    expect(linebreaks("AT&T")).toBe("<p>AT&amp;T</p>");
  });

  it("escapes both quote characters", () => {
    // NOTE the apostrophe: this port emits &#39; where Django 6.1 emits
    // &#x27; (django.utils.html.escape's translation table). Semantically
    // identical, byte-for-byte different -- pinned so a future diff against a
    // Django-rendered fixture is not mistaken for a bug.
    expect(linebreaks("\"'")).toBe("<p>&quot;&#39;</p>");
  });

  // SUSPECT. Django calls normalize_newlines() BEFORE splitting, so
  // '<p>a</p>\n\n<p>b</p>' is what Django 6.1 returns for both of these.
  // The port never normalises in linebreaks (it does in linebreaksbr), so
  // CRLF text stays one paragraph AND keeps a literal \r in the output. Any
  // scraped page with Windows line endings loses its paragraph structure in
  // the notification email.
  it("does not normalise CRLF, so Windows text loses its paragraphs", () => {
    expect(linebreaks("a\r\n\r\nb")).toBe("<p>a\r<br>\r<br>b</p>");
    expect(linebreaks("a\r\rb")).toBe("<p>a\r\rb</p>");
    expect(linebreaks("a\r\nb")).toBe("<p>a\r<br>b</p>");
  });

  // SUSPECT-BY-DESIGN. Django 6.1 renders `{{ None|linebreaks }}` as
  // '<p>None</p>' and `{{ ''|linebreaks }}` as '<p></p>' -- its @stringfilter
  // coerces None with str(), which yields the WORD "None", not "". The
  // module's own comment says Django "treats None as ''", and that is not
  // what Django 6.1 does; the port's behaviour is better, but the citation is
  // wrong. Pinned as the port's behaviour, with the real Django output named.
  it("renders nothing at all for null, undefined or empty input", () => {
    expect(linebreaks(null)).toBe("");
    expect(linebreaks(undefined)).toBe("");
    expect(linebreaks("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// linebreaksbr -- django's |linebreaksbr
// ---------------------------------------------------------------------------
describe("linebreaksbr", () => {
  it("replaces every newline with a br and wraps nothing", () => {
    expect(linebreaksbr("a\nb")).toBe("a<br>b");
    expect(linebreaksbr("a\nb\nc")).toBe("a<br>b<br>c");
  });

  // The contrast with linebreaks above is the entire reason both exist, and
  // is exactly the mistake a "tidy these two up" refactor would make: no <p>,
  // and consecutive newlines become consecutive <br>s rather than a paragraph
  // break. Django 6.1: 'a<br><br>b'.
  it("does not group paragraphs -- a blank line is just two brs", () => {
    expect(linebreaksbr("a\n\nb")).toBe("a<br><br>b");
    expect(linebreaksbr("a\n\nb")).not.toContain("<p>");
  });

  // Unlike linebreaks, this one DOES normalise first, so all three line
  // ending conventions produce one <br>. admin/need.njk:167 renders
  // need.change_text this way, and that text comes off a scraped page --
  // which is precisely where CRLF comes from.
  it("normalises CRLF and lone CR to a single br", () => {
    expect(linebreaksbr("a\r\nb")).toBe("a<br>b");
    expect(linebreaksbr("a\rb")).toBe("a<br>b");
    expect(linebreaksbr("a\r\n\r\nb")).toBe("a<br><br>b");
  });

  // Stated directly rather than inferred from the <br> count: no carriage
  // return may reach the page. (The ORDER of the normalise and the escape is
  // not what this pins -- escapeHtml touches neither \r nor \n, so swapping
  // them changes nothing, verified by swapping them and re-running. What it
  // pins is that the normalisation happens at all.)
  it("leaves no carriage return in the output", () => {
    expect(linebreaksbr("a\r\nb\rc")).not.toContain("\r");
  });

  it("escapes markup", () => {
    // env.ts wraps this filter's return in a SafeString, so nothing
    // downstream will escape it -- if the escape here goes, scraped markup
    // reaches the admin page unescaped.
    expect(linebreaksbr("<b>&\"'</b>")).toBe("&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;");
  });

  // Same divergence as linebreaks: Django 6.1 renders `{{ None|linebreaksbr }}`
  // as the word 'None'. WP 6.4's need.excess_change_text (nullable) is the
  // caller the module's comment names, and admin/need.njk:171 pipes it
  // through unguarded -- so this guard is what keeps "None" off that page.
  it("renders nothing for null, undefined or empty input", () => {
    expect(linebreaksbr(null)).toBe("");
    expect(linebreaksbr(undefined)).toBe("");
    expect(linebreaksbr("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// truncatechars -- django.utils.text.Truncator(...).chars(N)
// ---------------------------------------------------------------------------
describe("truncatechars", () => {
  // Used as `{{ foodbank.url|friendly_url|truncatechars(40) }}` on every
  // public food bank page, where the whole point is that the link text fits
  // the column -- so the total length, ellipsis included, is the contract.
  it("cuts so the text plus the ellipsis is exactly N characters", () => {
    // Django 6.1: truncatechars('abcdefghij', 5) == 'abcd…'.
    expect(truncatechars("abcdefghij", 5)).toBe("abcd…");
    expect(truncatechars("abcdefghij", 5)).toHaveLength(5);
  });

  it("uses a single ellipsis character, with no space before it", () => {
    // U+2026, not three dots -- three would make the result N+2 long.
    expect(truncatechars("abcdefghij", 5).slice(-1)).toBe("…");
    expect(truncatechars("abcdefghij", 5)).not.toContain(" ");
  });

  // The boundary is <=, so a string of exactly N is left alone. A mutant
  // using < returns 'abcd…' for a 5-char string of length 5.
  it("returns a string of exactly N unchanged", () => {
    expect(truncatechars("abcde", 5)).toBe("abcde");
    expect(truncatechars("abcd", 5)).toBe("abcd");
    expect(truncatechars("", 5)).toBe("");
  });

  it("returns just the ellipsis at N of 1", () => {
    // Django 6.1 agrees: '…'.
    expect(truncatechars("abcdefghij", 1)).toBe("…");
  });

  // SUSPECT. Django 6.1 returns '' for both of these (its loop returns before
  // any text is taken). The port's slice(0, count - 1) with a non-positive
  // count slices from the END, so it returns nearly the WHOLE string with an
  // ellipsis glued on -- the opposite of truncating. Not reachable from any
  // current template (every call site passes a literal 30/35/40), which is
  // why it is pinned rather than fixed.
  it("returns almost the whole string for a count of zero or less", () => {
    expect(truncatechars("abcdefghij", 0)).toBe("abcdefghi…");
    expect(truncatechars("abcdefghij", -1)).toBe("abcdefgh…");
  });

  // SUSPECT. JS .length counts UTF-16 code units; Django counts code points,
  // so Django 6.1 gives 'a😀b…' where the port gives 'a😀…'. An emoji in a
  // food bank name costs two characters of the budget. Cosmetic, and the
  // port never splits a surrogate pair here (slice(0, 3) happens to keep the
  // pair whole), so no mojibake -- just a slightly shorter result.
  it("counts an astral character as two, where Python counted one", () => {
    expect(truncatechars("a\u{1F600}bcdef", 4)).toBe("a\u{1F600}…");
  });
});

// ---------------------------------------------------------------------------
// truncatewords -- Truncator(...).words(N, truncate=" …")
// ---------------------------------------------------------------------------
describe("truncatewords", () => {
  // admin/index.njk:123 renders article titles with truncatewords(10).
  it("keeps the first N words and appends a space then an ellipsis", () => {
    // Django 6.1: 'one two …'. The SPACE before the ellipsis is deliberate --
    // django.template.defaultfilters.truncatewords passes truncate=" …"
    // explicitly, unlike truncatechars which uses the default "…".
    expect(truncatewords("one two three four", 2)).toBe("one two …");
  });

  // The boundary is <=: exactly N words gets no ellipsis at all.
  it("does not append an ellipsis when there are N words or fewer", () => {
    expect(truncatewords("one two", 2)).toBe("one two");
    expect(truncatewords("one two", 5)).toBe("one two");
    expect(truncatewords("one", 1)).toBe("one");
  });

  // Python's no-arg str.split() collapses runs of any whitespace and drops
  // leading/trailing empties, and Django rejoins on single spaces -- so this
  // filter NORMALISES whitespace even when it does not truncate. Django 6.1
  // returns 'one two …' for the padded input below and 'a b' for the second.
  it("normalises runs of whitespace, including when nothing is truncated", () => {
    expect(truncatewords("  one   two\nthree  ", 2)).toBe("one two …");
    expect(truncatewords("a  \n b", 5)).toBe("a b");
  });

  it("returns the empty string for empty or whitespace-only input", () => {
    expect(truncatewords("", 3)).toBe("");
    expect(truncatewords("   ", 3)).toBe("");
  });

  // "".split(/\s+/) is [""], not [] -- a one-element list holding an empty
  // string -- so without the .filter(Boolean) an empty input would count as
  // ONE word. Every other input hides that: filter(Boolean) and .trim() each
  // make the other redundant, and at any count above zero a phantom word
  // still joins to "". Zero is the only count that separates them, so this is
  // the single assertion in the file that holds .filter(Boolean) in place.
  it("counts an empty string as no words at all, not one empty word", () => {
    expect(truncatewords("", 0)).toBe("");
  });

  // SUSPECT. Django 6.1 renders `{{ 'a b c'|truncatewords:0 }}` as ''. The
  // port joins an empty slice and then appends " …", so the result is a
  // LEADING space and an ellipsis. Not reachable from a template today (every
  // call site passes 10), pinned rather than fixed.
  it("returns a stray space and ellipsis for a count of zero", () => {
    expect(truncatewords("one two three", 0)).toBe(" …");
  });
});
