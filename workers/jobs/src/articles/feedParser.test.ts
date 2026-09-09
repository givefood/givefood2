import { describe, expect, it } from "vitest";
import { type FeedItem, parseFeed } from "./feedParser";

// What this module is for, and therefore what these tests protect:
// foodbank_article_crawl (givefood/utils/crawlers.py:25-67) read exactly three
// things out of Python feedparser -- item.title, item.link and
// item.published_parsed -- and this is the narrow re-implementation of that
// over fast-xml-parser. It runs unattended over ~470 third-party food bank
// feeds, and its output is written straight into FoodbankArticle, whose `url`
// column is the uniqueness key. So the two failure modes worth spending tests
// on are:
//
//   * an item silently DISAPPEARING (a shape the parser doesn't recognise) --
//     the food bank's news never shows up on Give Food, and nothing errors;
//   * an item's link coming out DIFFERENT from what Django's crawler stored --
//     which, on 2026-09-05, meant every glossopdalefoodbank.org.uk article was
//     stored twice and /needs/at/glossopdale/news/ returned a hard 500. That
//     incident is written up in the module comment and is pinned below by name.
//
// Every expected value here was measured against the real fast-xml-parser
// build in this repo, not reasoned about -- several of them contradict what
// looks obvious (see the "documented divergences" block at the bottom).

// RFC 822, the shape WordPress and most RSS 2.0 generators emit.
const PUB = "Thu, 26 Mar 2026 15:52:06 +0000";
const PUB_AS_DATE = new Date("2026-03-26T15:52:06.000Z");

/** An RSS 2.0 document wrapped around whatever <item>s you hand it. */
const rss = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example Foodbank News</title>${items}</channel></rss>`;

/** The ordinary, everything-present item -- the baseline the guards deviate from. */
const goodItem = `<item><title>Volunteers needed</title><link>https://example.org/news/volunteers/</link><pubDate>${PUB}</pubDate></item>`;

/**
 * First item, with "did anything survive the guards at all?" folded in. Most of
 * this file asserts on a single field of a single item, and isUsable() drops
 * whole items silently -- so without this check a test whose fixture stopped
 * producing any item would pass vacuously on `undefined`, which is precisely
 * the failure mode these tests exist to catch.
 */
function first(items: FeedItem[]): FeedItem {
  expect(items.length).toBeGreaterThan(0);
  return items[0] as FeedItem;
}

describe("parseFeed: RSS 2.0, the format almost every food bank feed uses", () => {
  it("reads the three fields crawlers.py reads, and nothing else", () => {
    // Deliberately noisy item, matching what a real WordPress feed carries:
    // guid, description, category and content:encoded sit alongside the three
    // fields that are read. Any of them leaking into the output would change
    // what gets stored -- and content:encoded in particular becomes plain
    // `encoded` after removeNSPrefix, so it is one rename away from colliding.
    const items = parseFeed(
      rss(`<item>
        <title>Volunteers needed</title>
        <link>https://example.org/news/volunteers/</link>
        <guid isPermaLink="false">https://example.org/?p=1234</guid>
        <description>We are short-handed this month.</description>
        <category>News</category>
        <content:encoded><![CDATA[<p>Long body text</p>]]></content:encoded>
        <pubDate>${PUB}</pubDate>
      </item>`),
      "https://example.org/feed/",
    );

    expect(items).toEqual([
      { title: "Volunteers needed", link: "https://example.org/news/volunteers/", publishedDate: PUB_AS_DATE },
    ]);
  });

  it("returns a FeedItem whose publishedDate is a real Date, not an ISO string", () => {
    // The caller does `pyDatetime(item.publishedDate!)` (queues/articles.ts:75)
    // and pyDatetime takes a Date. A "helpful" refactor to a pre-formatted
    // string would typecheck at neither end but would sail through a test
    // that only compared JSON.
    const item: FeedItem = first(parseFeed(rss(goodItem), "https://example.org/feed/"));
    expect(item.publishedDate).toBeInstanceOf(Date);
    expect(item.publishedDate?.getTime()).toBe(PUB_AS_DATE.getTime());
    expect(Object.keys(item).sort()).toEqual(["link", "publishedDate", "title"]);
  });

  it("keeps items in DOCUMENT order, not sorted by date or title", () => {
    // crawlers.py iterates feed["items"] in document order and inserts as it
    // goes. Order is not just cosmetic: insertArticleIfNew flips foundNew,
    // which decides whether the food bank's cache gets purged.
    //
    // The three items are deliberately arranged so that document order matches
    // NONE of the orders a well-meaning refactor might impose -- not ascending
    // or descending by date, not alphabetical by title, not reversed. An
    // earlier version of this test used three same-dated "Story 1/2/3" items,
    // which any of those five orderings would have satisfied.
    const items = parseFeed(
      rss(`
        <item><title>Zebra crossing appeal</title><link>https://example.org/z/</link><pubDate>Thu, 01 Jan 2026 00:00:00 +0000</pubDate></item>
        <item><title>Apple harvest</title><link>https://example.org/a/</link><pubDate>Tue, 01 Jun 2027 00:00:00 +0000</pubDate></item>
        <item><title>Mango donations</title><link>https://example.org/m/</link><pubDate>Sat, 01 Mar 2025 00:00:00 +0000</pubDate></item>`),
      "https://example.org/feed/",
    );
    // Asserted whole, not field-by-field: a transposition that paired the right
    // titles with the wrong links would satisfy a `.map((i) => i.title)` check.
    expect(items).toEqual([
      { title: "Zebra crossing appeal", link: "https://example.org/z/", publishedDate: new Date("2026-01-01T00:00:00.000Z") },
      { title: "Apple harvest", link: "https://example.org/a/", publishedDate: new Date("2027-06-01T00:00:00.000Z") },
      { title: "Mango donations", link: "https://example.org/m/", publishedDate: new Date("2025-03-01T00:00:00.000Z") },
    ]);
  });

  it("handles a feed with exactly ONE item, which the XML parser hands back unwrapped", () => {
    // This is the asArray() helper's whole reason for existing: fast-xml-parser
    // gives you an object for a single <item> and an array for two or more. A
    // parser that assumed an array would drop every single-article feed --
    // silently, and only for the quietest food banks.
    expect(parseFeed(rss(goodItem), "https://example.org/feed/")).toEqual([
      { title: "Volunteers needed", link: "https://example.org/news/volunteers/", publishedDate: PUB_AS_DATE },
    ]);
    // The two-item case has to name both links: an implementation that wrapped
    // the FIRST item twice would have the right length and the wrong contents.
    expect(parseFeed(rss(goodItem + goodItem.replace("/volunteers/", "/other/")), "https://example.org/feed/").map((i) => i.link)).toEqual([
      "https://example.org/news/volunteers/",
      "https://example.org/news/other/",
    ]);
  });

  it("keeps a very large feed whole, and does not truncate a long title", () => {
    // Two silent-loss guards in one. Real feeds are usually 10-20 items, but
    // some CMSes publish the entire archive; a parser that capped its output
    // would look correct on every other test here. And truncation is the
    // CALLER's job -- queues/articles.ts does `item.title.slice(0, 250)` to
    // match crawlers.py:50 -- so parseFeed truncating too would double-clip.
    const many = Array.from(
      { length: 500 },
      (_, n) => `<item><title>Story ${n}</title><link>https://example.org/${n}/</link><pubDate>${PUB}</pubDate></item>`,
    ).join("");
    const items = parseFeed(rss(many), "https://example.org/feed/");
    expect(items).toHaveLength(500);
    expect(items[0]?.title).toBe("Story 0");
    expect(items[499]?.link).toBe("https://example.org/499/");

    const long = "x".repeat(1000);
    expect(first(parseFeed(rss(`<item><title>${long}</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).title).toBe(long);
  });

  it("decodes numeric HTML character references in titles", () => {
    // The module comment's headline finding: WordPress (most food banks' CMS)
    // emits "&#8217;" for a right single quote, and 243 of 469 real feeds had
    // at least one title affected before `htmlEntities: true` was set. Without
    // the flag these come through literally and every apostrophe in a stored
    // headline reads "&#8217;".
    const items = parseFeed(
      rss(`<item><title>St Mary&#8217;s Harvest &#038; Food Drive &#8211; 2026</title><link>https://example.org/h/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("St Mary’s Harvest & Food Drive – 2026");
  });

  it("decodes NAMED punctuation entities, but NOT accented letters", () => {
    // The `htmlEntities: true` flag covers both numeric and named entities,
    // and the module comment names both ("&#8211;", "&#038;", "&rsquo;").
    // Only the numeric half was pinned before, so an implementation that
    // hand-rolled numeric decoding and dropped the flag would have passed.
    //
    // BUT THE FLAG IS NOT A FULL HTML ENTITY TABLE, and this test pins the
    // boundary rather than the wish. Probed against fast-xml-parser directly:
    //
    //   decoded  amp lt gt quot apos nbsp rsquo lsquo ldquo rdquo mdash
    //            ndash hellip pound euro copy trade deg frac12
    //   literal  eacute egrave agrave ccedil uuml ouml aacute oacute ntilde
    //
    // Punctuation and symbols yes; ACCENTED LETTERS no. So a WordPress feed
    // writing "Caf&eacute;" stores and renders "Caf&eacute;" verbatim. That
    // is a real defect -- see the note below -- and it is asserted here as
    // what the code DOES, not what it should do, so that fixing it is a
    // deliberate change with a failing test rather than a silent one.
    const items = parseFeed(
      rss(`<item><title>Ben&rsquo;s &ldquo;Big&rdquo; Collection &mdash; caf&eacute;</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("Ben’s “Big” Collection — caf&eacute;");
  });

  // The fix, when someone takes it: @givefood/models already exports
  // decodeHtmlEntities() with the full 106-name legacy table, built for
  // exactly this problem on the needcheck side. feedParser does not use it.
  // Numeric references are unaffected -- "&#233;" decodes correctly today --
  // so only the named accented forms are at risk.
  it("does decode the NUMERIC form of the same accented character", () => {
    const items = parseFeed(
      rss(`<item><title>Caf&#233; Collection</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("Café Collection");
  });

  it("passes through non-ASCII text unchanged -- accents, emoji, a hex reference", () => {
    // Titles reach D1 as TEXT and the food bank's page renders them verbatim.
    // Mojibake here is invisible to every ASCII-only fixture in this file, so
    // it gets its own case. &#x2019; is the hexadecimal spelling of the same
    // right single quote WordPress usually writes as &#8217;.
    const items = parseFeed(
      rss(`<item><title>Café ☕ naïve — Ll&#x2019;anelli</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("Café ☕ naïve — Ll’anelli");
  });

  it("decodes entities in the link too, so a query string is not stored double-escaped", () => {
    // A link stored as "?x=1&amp;y=2" is a different string from the one
    // Django's crawler stored, and `url` is the uniqueness key -- that is
    // exactly the duplicate-row mechanism from the 2026-09-05 incident.
    //
    // BOTH spellings of the ampersand are exercised on purpose. "&amp;" is one
    // of XML's five predefined entities and fast-xml-parser decodes it with or
    // without `htmlEntities`, so a test using only that would have stayed green
    // if the flag were removed -- while "&#38;" (which real feeds do emit)
    // would have started reaching D1 literally.
    const items = parseFeed(
      rss(`<item><title>T</title><link>https://example.org/news/?p=12&amp;preview=true&#38;utm=rss</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).link).toBe("https://example.org/news/?p=12&preview=true&utm=rss");
  });

  it("decodes entities exactly ONCE, leaving a double-escaped reference half-decoded", () => {
    // A decoder that looped until the string stopped changing would be the
    // obvious "more correct" rewrite, and it would be wrong twice over: a
    // headline that legitimately writes ABOUT an entity ("A &amp;amp; B", the
    // escaped form of the literal text "A &amp; B") would come out as "A & B",
    // and a link whose query string carries a double-escaped ampersand would be
    // rewritten into a different string from the one Django stored -- the same
    // duplicate-row mechanism as the 2026-09-05 incident, since `url` is the
    // uniqueness key.
    const items = parseFeed(
      rss(`<item><title>A &amp;amp; B &amp;#8217;s</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("A &amp; B &#8217;s");
  });

  it("leaves an entity it does not recognise literal, rather than throwing", () => {
    // Hand-edited feed templates carry typos and half-written entities, and
    // `htmlEntities: true` covers a fixed table rather than everything. An
    // unknown name has to pass through untouched: a decoder that threw would
    // lose the whole feed, not the one headline, since parseFeed's catch turns
    // any parser throw into "no items this crawl".
    const items = parseFeed(
      rss(`<item><title>a&notarealentity;b</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("a&notarealentity;b");
  });

  it("decodes entities in a link BEFORE resolving it, not after", () => {
    // Ordering, not decoration: "&#47;" is a slash, so decoding first makes it
    // a path separator that new URL() then normalises, while resolving first
    // would percent-encode the ampersand and store "%26#47;" -- a different
    // uniqueness key for the same article.
    const items = parseFeed(
      rss(`<item><title>T</title><link>https://example.org/a&#47;b</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).link).toBe("https://example.org/a/b");
  });

  it("decodes &nbsp; to a real U+00A0, which then makes an nbsp-only title EMPTY", () => {
    // Two consequences of `htmlEntities: true` meeting textOf()'s trim, both
    // worth pinning because each is invisible in a normal ASCII fixture:
    //
    //   * inside a title the entity becomes a genuine non-breaking space, NOT
    //     an ordinary one -- so the stored headline differs, by one codepoint,
    //     from what a naive `.replace("&nbsp;", " ")` would produce;
    //   * a title that is nothing BUT &nbsp; trims to "" (JS String.trim treats
    //     U+00A0 as whitespace) and the item is dropped. Django's feedparser
    //     also decodes it, but crawlers.py's `item.title != ""` compares the
    //     UNtrimmed string, so Django would have STORED a blank headline here.
    const spaced = parseFeed(
      rss(`<item><title>Harvest&nbsp;Festival</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(spaced).title).toBe("Harvest Festival");
    expect([...first(spaced).title].map((c) => c.codePointAt(0))).toContain(0x00a0);

    expect(parseFeed(rss(`<item><title>&nbsp;</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
  });

  it("trims CDATA titles, which the parser's own trimValues option does not touch", () => {
    // Called out explicitly in textOf()'s comment, with this real title as the
    // example: trimValues only trims plain text nodes, so an all-CDATA title
    // keeps its trailing space unless trimmed by hand. feedparser's output has
    // no such whitespace, so an untrimmed value here diverges from every row
    // Django ever wrote.
    const items = parseFeed(
      rss(`<item><title><![CDATA[Our Newsletter : December Voice ]]></title><link>https://example.org/n/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("Our Newsletter : December Voice");
  });

  it("reads text from an element that also carries attributes", () => {
    // The third node shape textOf() documents: {"#text": …, "@_type": …}.
    // Atom-style `type` attributes turn up on RSS titles in the wild; without
    // the "#text" branch the title is undefined and the article is dropped.
    const items = parseFeed(
      rss(`<item><title type="text">Typed title</title><link>https://example.org/t/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("Typed title");
    // Same for <link>, which is the field that actually gets stored.
    expect(
      first(parseFeed(rss(`<item><title>T</title><link type="text/html">https://example.org/attr/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).link,
    ).toBe("https://example.org/attr/");
  });

  it("prefers the CDATA branch over the #text branch when a title carries BOTH", () => {
    // textOf() tries __cdata before "#text". Pinning that ordering needs a node
    // that genuinely has both keys, and the obvious candidate does not: probed
    // against the parser directly, `<title type="html"><![CDATA[…]]></title>`
    // yields {__cdata: "…", "@_type": "html"} with NO "#text" member at all, so
    // reversing the two branches would still return the CDATA. Only text sitting
    // ALONGSIDE a CDATA section produces {__cdata: "Cdata", "#text": "Plain"},
    // and there the order decides the answer -- __cdata first gives "Cdata",
    // "#text" first gives "Plain".
    //
    // Note what that also means: the plain text is silently discarded, the same
    // shape of loss as the nested-markup case in the divergences block below.
    const both = parseFeed(
      rss(`<item><title>Plain <![CDATA[Cdata]]></title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(both).title).toBe("Cdata");

    // The attribute-carrying shape still has to work -- it is exactly what
    // WordPress emits -- it just cannot be the thing that proves the ordering.
    const withAttribute = parseFeed(
      rss(`<item><title type="html"><![CDATA[From the CDATA]]></title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(withAttribute).title).toBe("From the CDATA");
  });

  it("trims the surrounding whitespace off a plain-text title, not just a CDATA one", () => {
    // Feed templates are hand-indented, so `<title>\n  Text\n</title>` is the
    // norm rather than the exception. Here `trimValues` and textOf()'s own
    // .trim() overlap -- pinned so that removing either still leaves the stored
    // headline free of the template's indentation.
    const items = parseFeed(
      rss(`<item><title>\n      Winter appeal\n    </title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("Winter appeal");
    // …and the same for the link, where stray whitespace would otherwise be
    // percent-encoded into the uniqueness key by new URL().
    expect(
      first(parseFeed(rss(`<item><title>T</title><link>  https://example.org/1/  </link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).link,
    ).toBe("https://example.org/1/");
  });

  it("keeps a numeric-looking title a string, digit for digit", () => {
    // `parseTagValue: false` exists for this: a title of "2026" becoming the JS
    // number 2026 would blow up on `.slice(0, 250)` in queues/articles.ts.
    //
    // But "2026" ALONE cannot prove the option is still set -- measured by
    // flipping it: the title comes back as the number 2026, textOf's
    // `String(node)` branch converts it straight back to "2026", and the
    // assertion passes against a parser that has stopped preserving anything.
    // Only a numeric string that does not survive that round trip shows it, so
    // the leading-zero and trailing-zero cases are the real test here: with the
    // option off, a film-night headline "007" stores as "7" and "1.0" as "1".
    const titleOf = (title: string) =>
      first(parseFeed(rss(`<item><title>${title}</title><link>https://example.org/y/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).title;

    expect(titleOf("2026")).toBe("2026");
    expect(typeof titleOf("2026")).toBe("string");
    expect(titleOf("007")).toBe("007");
    expect(titleOf("1.0")).toBe("1.0");
    expect(titleOf("0x1A")).toBe("0x1A");
  });

  it("leaves escaped markup in a title as literal text", () => {
    // &lt;b&gt; is text, not markup, and stays text after entity decoding.
    // (Genuinely nested markup behaves quite differently -- see the
    // divergences block.)
    const items = parseFeed(
      rss(`<item><title>&lt;b&gt;Bold&lt;/b&gt;</title><link>https://example.org/b/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("<b>Bold</b>");
  });

  it("prefers pubDate over dc:date, and falls back to dc:date when pubDate is absent", () => {
    // rssItemToFeedItem's documented field priority, mirroring feedparser's.
    // `removeNSPrefix` is what makes <dc:date> arrive as `date`; if that option
    // were dropped the fallback would silently stop working and RSS 1.0 feeds
    // would lose every article.
    const both = parseFeed(
      rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate><dc:date>2020-01-01T00:00:00Z</dc:date></item>`),
      "https://example.org/feed/",
    );
    expect(first(both).publishedDate).toEqual(PUB_AS_DATE);

    const dcOnly = parseFeed(
      rss(`<item><title>T</title><link>https://example.org/1/</link><dc:date>2026-03-26T15:52:06Z</dc:date></item>`),
      "https://example.org/feed/",
    );
    expect(first(dcOnly).publishedDate).toEqual(PUB_AS_DATE);
  });

  it("falls back to dc:date when pubDate is ABSENT but not when it is EMPTY", () => {
    // The fallback is `??`, and textOf() returns "" -- not undefined -- for an
    // element that is present but empty. So the two ways a pubDate can be
    // useless go in opposite directions, and neither is visible in the source:
    //
    //   <pubDate/> next to a good <dc:date>  ->  "" is not nullish, so dc:date
    //       is never read, the date is null, and the ITEM IS DROPPED;
    //   two <pubDate>s next to a good <dc:date>  ->  the repeated field parses
    //       to an array, textOf gives undefined, and dc:date IS used.
    //
    // This is the one place where `??` and `||` are not interchangeable in this
    // module: written with `||`, the first case would keep the item and date it
    // from dc:date -- which is also what Python feedparser does, so the empty-
    // element case is a silent divergence, not just a curiosity.
    for (const emptyPubDate of ["<pubDate></pubDate>", "<pubDate/>", "<pubDate>   </pubDate>"]) {
      expect(
        parseFeed(
          rss(`<item><title>T</title><link>https://example.org/1/</link>${emptyPubDate}<dc:date>2026-03-26T15:52:06Z</dc:date></item>`),
          "https://example.org/feed/",
        ),
      ).toEqual([]);
    }

    const repeated = parseFeed(
      rss(
        `<item><title>T</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate><pubDate>Fri, 27 Mar 2026 00:00:00 +0000</pubDate><dc:date>2027-01-01T00:00:00Z</dc:date></item>`,
      ),
      "https://example.org/feed/",
    );
    expect(first(repeated).publishedDate).toEqual(new Date("2027-01-01T00:00:00.000Z"));
  });
});

describe("parseFeed: the guards that decide whether an item is insertable", () => {
  it("drops an item with an empty title, the way crawlers.py:43 does", () => {
    // Django's literal guard is `if item.title != ""`. Ported into isUsable()
    // so it is applied once rather than at each call site.
    expect(parseFeed(rss(`<item><title></title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
  });

  it("drops an item with no <title> element at all, not merely an empty one", () => {
    // The `?? ""` in rssItemToFeedItem/atomEntryToFeedItem. An absent title
    // makes textOf return undefined; without the coalesce it would stay
    // undefined, sail past `title !== ""`, and reach D1 as a NULL headline on a
    // NOT NULL column. Asserted on both mappers because each has its own copy.
    expect(parseFeed(rss(`<item><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
    expect(
      parseFeed(`<feed><entry><link href="https://example.org/1/"/><published>2026-03-26T15:52:06Z</published></entry></feed>`, "https://example.org/feed.atom"),
    ).toEqual([]);
  });

  it("drops a whitespace-only title, which Django's exact-comparison guard would have kept", () => {
    // A deliberate difference in outcome from crawlers.py, caused by textOf()
    // trimming: "   " != "" in Python, so Django would have stored a blank
    // headline. Trimming first is the better behaviour; pin it so the trim
    // isn't removed as redundant.
    expect(parseFeed(rss(`<item><title>   </title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
  });

  it("drops an item with no date at all", () => {
    // Structural, not cosmetic: FoodbankArticle.published_date is NOT NULL and
    // Django's insert calls mktime(item.published_parsed) unconditionally. The
    // caller's non-null assertion (`item.publishedDate!`) is only sound because
    // this filter ran.
    expect(parseFeed(rss(`<item><title>Dateless</title><link>https://example.org/1/</link></item>`), "https://example.org/feed/")).toEqual([]);
  });

  it("drops an item whose date cannot be parsed", () => {
    // "26/03/2026" is a plausible hand-rolled UK feed value, and V8's Date
    // rejects it. Better a missing article than an Invalid Date reaching
    // pyDatetime(), which would write the string "NaN-NaN-NaN" into D1.
    expect(parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>26/03/2026</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
    expect(parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>Thu, 32 Mar 2026 15:52:06 +0000</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
  });

  it("drops an item with a missing, empty, whitespace-only or self-closing link", () => {
    // isUsable()'s own comment: the link column is the uniqueness key and
    // every reader calls new URL() on it, so an item without one is not
    // insertable. This guard is new -- Django had no equivalent.
    expect(parseFeed(rss(`<item><title>No link</title><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
    expect(parseFeed(rss(`<item><title>Empty link</title><link></link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
    expect(parseFeed(rss(`<item><title>Self-closed</title><link/><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
    // Whitespace-only is the one that would slip past a bare `link !== ""`
    // check applied before the trim: `new URL("   ", base)` does NOT throw,
    // it resolves to the feed URL itself, so an untrimmed link would store
    // the food bank's own feed as an article.
    expect(parseFeed(rss(`<item><title>Blank link</title><link>   </link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
  });

  it("drops an item whose link cannot be parsed even against a perfectly good feed URL", () => {
    // resolveLink()'s own try/catch, reached without blaming feedUrl: an
    // unbracketed IPv6-looking authority makes `new URL()` throw, resolveLink
    // returns "", and isUsable drops the item. This is also the test that pins
    // the ORDER of parseFeed's pipeline -- resolveLink runs BEFORE the filter,
    // so a refactor that filtered first would keep the item with link "" and
    // hand queues/articles.ts an empty uniqueness key.
    expect(parseFeed(rss(`<item><title>T</title><link>http://[bad</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
  });

  it("drops only the unusable items, keeping the rest of the feed", () => {
    // The whole point: one broken item in a food bank's feed must not cost
    // them the other nine. A guard implemented as an early return rather than
    // a filter would pass every single-item test above and fail this one.
    const items = parseFeed(
      rss(`
        <item><title></title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>
        <item><title>Dateless</title><link>https://example.org/2/</link></item>
        <item><title>Linkless</title><pubDate>${PUB}</pubDate></item>
        <item><title>Keep me</title><link>https://example.org/4/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(items).toEqual([{ title: "Keep me", link: "https://example.org/4/", publishedDate: PUB_AS_DATE }]);
  });
});

describe("parseFeed: RSS 1.0 (RDF)", () => {
  it("finds <item> at the document root, not under <channel>", () => {
    // parseFeed's comment names this as the one structural difference that
    // matters. An RSS 1.0 feed hitting only the RSS 2.0 branch returns zero
    // articles forever, with no error anywhere.
    const items = parseFeed(
      `<?xml version="1.0"?>
       <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
         <channel rdf:about="https://example.org/"><title>Feed</title></channel>
         <item rdf:about="https://example.org/1/">
           <title>RDF story</title><link>https://example.org/1/</link><dc:date>2026-03-26T15:52:06Z</dc:date>
         </item>
         <item rdf:about="https://example.org/2/">
           <title>Second</title><link>https://example.org/2/</link><dc:date>2026-03-27T00:00:00Z</dc:date>
         </item>
       </rdf:RDF>`,
      "https://example.org/feed/",
    );
    expect(items).toEqual([
      { title: "RDF story", link: "https://example.org/1/", publishedDate: PUB_AS_DATE },
      { title: "Second", link: "https://example.org/2/", publishedDate: new Date("2026-03-27T00:00:00.000Z") },
    ]);
  });

  it("applies the same title/date/link guards to RDF items", () => {
    const items = parseFeed(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
         <item><title></title><link>https://example.org/1/</link><dc:date>2026-03-26T15:52:06Z</dc:date></item>
       </rdf:RDF>`,
      "https://example.org/feed/",
    );
    expect(items).toEqual([]);
  });

  it("unwraps a single RDF item and resolves its link, exactly as the RSS 2.0 branch does", () => {
    // The RDF branch is a separate call site of asArray()/rssItemToFeedItem/
    // resolveLink, so the single-item unwrap and the relative-link resolution
    // both have to be proven here too -- an RSS 1.0 food bank with one story
    // and a site-relative link is the case that would otherwise go missing.
    expect(
      parseFeed(
        `<rdf:RDF><item><title>Solo story</title><link>/news/solo/</link><dc:date>2026-03-26T15:52:06Z</dc:date></item></rdf:RDF>`,
        "https://example.org/feed/rss/",
      ),
    ).toEqual([{ title: "Solo story", link: "https://example.org/news/solo/", publishedDate: PUB_AS_DATE }]);
  });

  it("accepts a pubDate on an RDF item, since both branches share rssItemToFeedItem", () => {
    // RSS 1.0 nominally dates items with dc:date, but real RDF feeds emitted by
    // RSS 2.0-shaped templates carry pubDate. Both work, because the RDF branch
    // reuses the RSS mapper rather than having its own.
    expect(
      first(parseFeed(`<rdf:RDF><item><title>T</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item></rdf:RDF>`, "https://example.org/feed/")).publishedDate,
    ).toEqual(PUB_AS_DATE);
  });
});

describe("parseFeed: Atom", () => {
  it("takes the URL from a link's href attribute, preferring rel=alternate", () => {
    // pickAtomLink's documented rule, copied from feedparser's own selection.
    // Getting this wrong stores an enclosure (a PDF, an image) as the article
    // URL -- which looks fine in the database and 404s for readers.
    const items = parseFeed(
      `<?xml version="1.0"?>
       <feed xmlns="http://www.w3.org/2005/Atom">
         <entry>
           <title>Harvest appeal</title>
           <link rel="enclosure" type="application/pdf" href="https://example.org/appeal.pdf"/>
           <link rel="alternate" href="https://example.org/news/harvest/"/>
           <published>2026-03-26T15:52:06Z</published>
         </entry>
       </feed>`,
      "https://example.org/feed.atom",
    );
    expect(items).toEqual([{ title: "Harvest appeal", link: "https://example.org/news/harvest/", publishedDate: PUB_AS_DATE }]);
  });

  it("treats a link with no rel as rel=alternate, per the Atom spec", () => {
    const items = parseFeed(
      `<feed><entry><title>T</title><link href="https://example.org/bare/"/><published>2026-03-26T15:52:06Z</published></entry></feed>`,
      "https://example.org/feed.atom",
    );
    expect(first(items).link).toBe("https://example.org/bare/");
  });

  it("falls back to the FIRST link when no alternate is present", () => {
    // Also feedparser's behaviour, and the reason this is a fallback rather
    // than a drop: an entry whose only links are rel=self still names a real
    // page, and dropping it would lose the article entirely.
    const items = parseFeed(
      `<feed><entry>
         <title>T</title>
         <link rel="self" href="https://example.org/self/"/>
         <link rel="via" href="https://example.org/via/"/>
         <published>2026-03-26T15:52:06Z</published>
       </entry></feed>`,
      "https://example.org/feed.atom",
    );
    expect(first(items).link).toBe("https://example.org/self/");

    // The mirror case, which is what makes the line above a real test of the
    // PREFERENCE rather than of "take links[0]": put rel=self first and
    // rel=alternate second, and alternate must still win. Without this, an
    // implementation that ignored @_rel entirely would pass both link tests.
    const alternateSecond = parseFeed(
      `<feed><entry>
         <title>T</title>
         <link rel="self" href="https://example.org/self/"/>
         <link rel="alternate" href="https://example.org/story/"/>
         <published>2026-03-26T15:52:06Z</published>
       </entry></feed>`,
      "https://example.org/feed.atom",
    );
    expect(first(alternateSecond).link).toBe("https://example.org/story/");
  });

  it("drops an entry when the ALTERNATE link has no href, even though another link does", () => {
    // pickAtomLink is `(alternate ?? links[0])?.["@_href"]`: it commits to the
    // alternate FIRST and only then looks for an href, so an href-less
    // rel=alternate shadows a perfectly usable rel=self and the entry is lost.
    // The plausible rewrite -- "find the first link that HAS an href, preferring
    // alternate" -- would keep this entry, and every other Atom test in this
    // file would still pass, so this is what actually pins the precedence.
    expect(
      parseFeed(
        `<feed><entry>
           <title>T</title>
           <link rel="alternate"/>
           <link rel="self" href="https://example.org/self/"/>
           <published>2026-03-26T15:52:06Z</published>
         </entry></feed>`,
        "https://example.org/feed.atom",
      ),
    ).toEqual([]);
  });

  it("matches rel exactly: an empty rel counts as alternate, a capitalised one does not", () => {
    // `!l["@_rel"] || l["@_rel"] === "alternate"`. rel="" is falsy, so it takes
    // the "no rel means alternate" path; rel="Alternate" satisfies neither test
    // and falls through to the links[0] fallback, which here is the rel=self
    // listed before it. RFC 4287 makes these values case-sensitive, so both
    // outcomes are spec-correct -- pinned so that a .toLowerCase() "tidy-up"
    // has to be a deliberate change with a failing test.
    expect(
      first(
        parseFeed(
          `<feed><entry><title>T</title><link rel="" href="https://example.org/empty-rel/"/><published>2026-03-26T15:52:06Z</published></entry></feed>`,
          "https://example.org/feed.atom",
        ),
      ).link,
    ).toBe("https://example.org/empty-rel/");

    expect(
      first(
        parseFeed(
          `<feed><entry>
             <title>T</title>
             <link rel="self" href="https://example.org/self/"/>
             <link rel="Alternate" href="https://example.org/story/"/>
             <published>2026-03-26T15:52:06Z</published>
           </entry></feed>`,
          "https://example.org/feed.atom",
        ),
      ).link,
    ).toBe("https://example.org/self/");
  });

  it("takes the FIRST alternate when an entry lists several", () => {
    // Entries commonly carry one alternate per representation (text/html plus
    // a JSON or AMP variant). `find` stops at the first, so the HTML page the
    // feed listed first is the one stored -- pinned because a switch to
    // `filter(...).pop()` or a type-aware pick would silently re-point every
    // article on such a feed at its machine-readable twin.
    expect(
      first(
        parseFeed(
          `<feed><entry>
             <title>T</title>
             <link rel="alternate" type="text/html" href="https://example.org/one/"/>
             <link rel="alternate" type="application/json" href="https://example.org/two/"/>
             <published>2026-03-26T15:52:06Z</published>
           </entry></feed>`,
          "https://example.org/feed.atom",
        ),
      ).link,
    ).toBe("https://example.org/one/");
  });

  it("drops an entry whose only link carries no href, and one with no <link> at all", () => {
    expect(
      parseFeed(`<feed><entry><title>T</title><link rel="alternate"/><published>2026-03-26T15:52:06Z</published></entry></feed>`, "https://example.org/feed.atom"),
    ).toEqual([]);
    // The asArray(undefined) path inside pickAtomLink -- an entry with no link
    // element at all must return undefined rather than reading @_href off
    // nothing. Cheap to get wrong (`links[0]["@_href"]` throws on an empty
    // array), and a throw here would fail the WHOLE feed, not one entry.
    expect(parseFeed(`<feed><entry><title>T</title><published>2026-03-26T15:52:06Z</published></entry></feed>`, "https://example.org/feed.atom")).toEqual([]);
  });

  it("keeps multiple Atom entries in document order, resolving each entry's own link", () => {
    // The Atom branch has its own mapper, so "several entries, unwrapped
    // correctly, in the order the feed wrote them" has to be proven separately
    // from the RSS case. Dates deliberately run backwards against document
    // order so a sort would show up, and one link is relative so the shared
    // resolveLink pass is exercised on this branch too.
    const items = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom">
         <entry><title>Older, listed first</title><link href="/news/older/"/><published>2026-01-01T00:00:00Z</published></entry>
         <entry><title>Newer, listed second</title><link href="https://example.org/news/newer/"/><published>2027-01-01T00:00:00Z</published></entry>
       </feed>`,
      "https://example.org/feed/atom.xml",
    );
    expect(items).toEqual([
      { title: "Older, listed first", link: "https://example.org/news/older/", publishedDate: new Date("2026-01-01T00:00:00.000Z") },
      { title: "Newer, listed second", link: "https://example.org/news/newer/", publishedDate: new Date("2027-01-01T00:00:00.000Z") },
    ]);
  });

  it("prefers <published> over <updated>, and falls back to <updated>", () => {
    // atomEntryToFeedItem's documented priority. Reversing it would re-date
    // every article to its last edit, reordering a food bank's news page.
    const both = parseFeed(
      `<feed><entry><title>T</title><link href="https://example.org/1/"/>
         <published>2026-03-26T15:52:06Z</published><updated>2027-01-01T00:00:00Z</updated>
       </entry></feed>`,
      "https://example.org/feed.atom",
    );
    expect(first(both).publishedDate).toEqual(PUB_AS_DATE);

    const updatedOnly = parseFeed(
      `<feed><entry><title>T</title><link href="https://example.org/1/"/><updated>2026-03-26T15:52:06Z</updated></entry></feed>`,
      "https://example.org/feed.atom",
    );
    expect(first(updatedOnly).publishedDate).toEqual(PUB_AS_DATE);

    // …but an EMPTY <published> does not fall back, because textOf returns ""
    // and `??` only steps aside for null/undefined -- so the entry is dropped
    // even though <updated> holds a perfectly good date. Same trap as the
    // RSS pubDate/dc:date pair above, in the other mapper, and the reason both
    // are pinned separately: they are two independent copies of the chain.
    expect(
      parseFeed(
        `<feed><entry><title>T</title><link href="https://example.org/1/"/><published></published><updated>2026-03-26T15:52:06Z</updated></entry></feed>`,
        "https://example.org/feed.atom",
      ),
    ).toEqual([]);
  });

  it("decodes CDATA and trims titles in Atom entries too", () => {
    const items = parseFeed(
      `<feed><entry><title><![CDATA[ Winter appeal ]]></title><link href="https://example.org/w/"/><published>2026-03-26T15:52:06Z</published></entry></feed>`,
      "https://example.org/feed.atom",
    );
    expect(first(items).title).toBe("Winter appeal");
  });

  it("applies the title guard to Atom entries", () => {
    expect(
      parseFeed(`<feed><entry><title></title><link href="https://example.org/1/"/><published>2026-03-26T15:52:06Z</published></entry></feed>`, "https://example.org/feed.atom"),
    ).toEqual([]);
  });
});

describe("parseFeed: relative links -- the 2026-09-05 duplicate/500 incident", () => {
  // The module comment records what an unresolved relative link cost:
  // /needs/at/glossopdale/news/ returned a hard 500 on every request (because
  // FoodbankArticle.url_with_ref() calls `new URL(value)`, which THROWS on a
  // relative URL), and every affected article was stored twice -- once
  // absolute by Django's crawler, once relative by this one. feedparser
  // resolves relative links against the feed URL before Django ever sees them
  // (_resolveRelativeURIs), which is why every pre-existing row is absolute.

  it("resolves a root-relative link against the feed URL -- the exact glossopdale case", () => {
    const items = parseFeed(
      rss(`<item><title>New fire door needed</title><link>/news/new-fire-door-needed/</link><pubDate>${PUB}</pubDate></item>`),
      "https://glossopdalefoodbank.org.uk/feed/rss/",
    );
    expect(first(items).link).toBe("https://glossopdalefoodbank.org.uk/news/new-fire-door-needed/");
  });

  it("resolves a document-relative link against the feed's directory, not its origin", () => {
    // "about.html" next to /feed/rss/ is /feed/rss/about.html -- URL semantics,
    // and the same thing feedparser does. Pinned because "just prepend the
    // origin" is the tempting simplification and it is wrong.
    const items = parseFeed(
      rss(`<item><title>T</title><link>about.html</link><pubDate>${PUB}</pubDate></item>`),
      "https://glossopdalefoodbank.org.uk/feed/rss/",
    );
    expect(first(items).link).toBe("https://glossopdalefoodbank.org.uk/feed/rss/about.html");
  });

  it("resolves a protocol-relative link using the feed's scheme", () => {
    const items = parseFeed(
      rss(`<item><title>T</title><link>//cdn.example.net/story/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).link).toBe("https://cdn.example.net/story/");
  });

  it("leaves an already-absolute link on another host alone", () => {
    // The overwhelmingly common case, and the one that must not regress into
    // being rewritten under the feed's own origin.
    const items = parseFeed(
      rss(`<item><title>T</title><link>https://elsewhere.example/story/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).link).toBe("https://elsewhere.example/story/");
  });

  it("normalises the link the way `new URL()` does, since the caller stores it verbatim", () => {
    // Non-ASCII path characters get percent-encoded on the way through URL.
    // Worth pinning as observable output: this string is the uniqueness key,
    // so if it ever changed shape every affected article would be re-inserted.
    const items = parseFeed(
      rss(`<item><title>T</title><link>https://example.org/café/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).link).toBe("https://example.org/caf%C3%A9/");
  });

  it("turns a fragment-only link into the FEED's own URL plus the fragment", () => {
    // The counterpart to the whitespace-only link in the guards block, which is
    // trimmed to "" and dropped: "#section" is not empty, so it survives to
    // new URL() and resolves to the feed URL itself. The article is KEPT, with
    // a URL that points at the RSS file -- one row per such item, and the
    // reader is sent to an XML document. Recorded, not endorsed; resolveLink
    // has no notion of "resolved to somewhere useless".
    const items = parseFeed(
      rss(`<item><title>T</title><link>#section</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).link).toBe("https://example.org/feed/#section");
  });

  it("resolves a query-only link against the feed FILE, not its directory", () => {
    // "?p=99" replaces the query of the feed URL and keeps its path, so a feed
    // at /feed/index.xml yields /feed/index.xml?p=99 -- different from the
    // directory-relative rule two tests up, and the shape WordPress's
    // "?p=<id>" permalinks take when a template forgets the origin.
    const items = parseFeed(
      rss(`<item><title>T</title><link>?p=99</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/index.xml",
    );
    expect(first(items).link).toBe("https://example.org/feed/index.xml?p=99");
  });

  it("does not filter by scheme -- a mailto: or javascript: link is stored as-is", () => {
    // Nothing here validates the scheme; `new URL()` accepts both. Recorded
    // rather than endorsed: if a scheme allowlist is ever added, this test
    // should be the thing that changes, deliberately.
    const items = parseFeed(
      rss(`<item><title>T</title><link>mailto:news@example.org</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).link).toBe("mailto:news@example.org");
  });
});

describe("parseFeed: malformed and non-feed input", () => {
  // Foodbank.rss_url is uncredentialed third-party content fetched on a cron,
  // so all of this is a Tuesday, not a hypothetical. Every case must come back
  // as "no items this crawl" -- queues/articles.ts turns that into a cleanly
  // closed CrawlItem with foundNew=false, matching Django's `if feed:` guard,
  // whereas a throw would retry the queue message and eventually poison it.

  it("returns [] rather than throwing on XML that the parser genuinely rejects", () => {
    // These three inputs really do make fast-xml-parser throw (verified: it is
    // stricter than feedparser's tag-soup parser, which never throws at all) --
    // so they are what actually exercises parseFeed's try/catch.
    expect(parseFeed(`<rss><channel>${goodItem}</channel></rs`, "https://example.org/feed/")).toEqual([]); // "Closing Tag is not closed"
    expect(parseFeed(`<rss><channel><item><title><![CDATA[x</title></item></channel></rss>`, "https://example.org/feed/")).toEqual([]); // "CDATA is not closed"
    expect(parseFeed("<", "https://example.org/feed/")).toEqual([]); // readTagExp returned undefined
  });

  it("returns [] for tag soup that parses to nonsense instead of throwing", () => {
    // The other half of malformed input, and the more common half: unbalanced
    // tags mostly do NOT throw, they yield a junk tree. Both routes have to end
    // in the same place, so the safety net cannot be the try/catch alone.
    expect(parseFeed("<a><b></c></a>", "https://example.org/feed/")).toEqual([]);
    expect(parseFeed("<rss><channel>< <item/></channel></rss>", "https://example.org/feed/")).toEqual([]);
    expect(parseFeed('<rss version=2.0><channel/></rss>', "https://example.org/feed/")).toEqual([]);
  });

  it("returns [] for an HTML error page served with a 200", () => {
    // A CMS migration mid-crawl serves the site's 404 page at the feed URL with
    // a 200 status, so res.ok is true and this text reaches the parser.
    expect(parseFeed("<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>", "https://example.org/feed/")).toEqual([]);
  });

  it("returns [] for an empty body, JSON, and an unrecognised feed root", () => {
    expect(parseFeed("", "https://example.org/feed/")).toEqual([]);
    expect(parseFeed('{"items":[]}', "https://example.org/feed/")).toEqual([]);
    expect(parseFeed("<opml version=\"2.0\"><body/></opml>", "https://example.org/feed/")).toEqual([]);
  });

  it("returns [] for an <rss> element with no <channel>, and for a <channel> with no items", () => {
    expect(parseFeed("<rss><item><title>Orphan</title></item></rss>", "https://example.org/feed/")).toEqual([]);
    expect(parseFeed("<rss><channel/></rss>", "https://example.org/feed/")).toEqual([]);
    expect(parseFeed("<rss><channel><title>Empty</title></channel></rss>", "https://example.org/feed/")).toEqual([]);
  });

  it("only recognises rss/RDF/feed as the DOCUMENT root, not nested anywhere inside", () => {
    // The three branches index straight off the parsed root object. Pinned so
    // that "make it search the tree" is a conscious change, not a surprise.
    expect(parseFeed(`<wrapper><rss><channel>${goodItem}</channel></rss></wrapper>`, "https://example.org/feed/")).toEqual([]);
  });

  it("survives the incidental junk real feeds carry before the root element", () => {
    // BOMs, stray leading whitespace, doctypes and comments are all common in
    // hand-edited feed templates; none of them may cost a food bank its news.
    //
    // Asserted as full equality rather than a length, because the classic way a
    // BOM goes wrong is not losing the item but riding along INTO the first
    // field -- a title of "﻿Volunteers needed" reads identically in a
    // terminal, stores a different string from the one Django stored, and would
    // satisfy toHaveLength(1) forever.
    for (const prefix of ["﻿", "\n   ", "<!DOCTYPE rss>", "<!-- generated by a plugin -->"]) {
      expect(parseFeed(prefix + rss(goodItem), "https://example.org/feed/")).toEqual([
        { title: "Volunteers needed", link: "https://example.org/news/volunteers/", publishedDate: PUB_AS_DATE },
      ]);
    }
  });

  it("returns [] for a perfectly valid feed of each format that simply has no items", () => {
    // asArray(undefined) on all three branches -- the RSS one is covered above,
    // but RDF and Atom reach it through their own call sites, and a food bank
    // between publications (or one whose CMS emits the wrapper before the first
    // post) is an ordinary Tuesday, not a malformed feed.
    expect(parseFeed(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel rdf:about="https://example.org/"/></rdf:RDF>`, "https://example.org/feed/")).toEqual([]);
    expect(parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Nothing published yet</title></feed>`, "https://example.org/feed.atom")).toEqual([]);
  });

  it("returns [] for a body that is not a string at all", () => {
    // Outside the declared type on purpose. The caller hands over `await
    // res.text()`, and the day that is undefined -- a runtime quirk, a stubbed
    // fetch in some future test of the queue consumer -- the difference between
    // [] and a TypeError is the difference between one quiet crawl and a queue
    // message that retries until it poisons. parser.parse() throws on both of
    // these and the try/catch absorbs it, so the "never throws" contract holds
    // for inputs the types say cannot happen.
    expect(parseFeed(undefined as unknown as string, "https://example.org/feed/")).toEqual([]);
    expect(parseFeed(null as unknown as string, "https://example.org/feed/")).toEqual([]);
  });

  it("returns [] for an <item> that is bare text or self-closing", () => {
    expect(parseFeed("<rss><channel><item/></channel></rss>", "https://example.org/feed/")).toEqual([]);
    expect(parseFeed("<rss><channel><item>just text</item></channel></rss>", "https://example.org/feed/")).toEqual([]);
  });
});

describe("parseFeed: date parsing", () => {
  // parseDate leans entirely on V8's Date constructor, which the module says
  // was verified to handle both feed date formats. These pin that, and pin how
  // lenient it is either side of the happy path.

  it("parses the RFC 822/1123 shapes RSS uses, with an offset or a zone name", () => {
    const at = (pubDate: string) =>
      parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>${pubDate}</pubDate></item>`), "https://example.org/feed/")[0]?.publishedDate;

    expect(at("Thu, 26 Mar 2026 15:52:06 +0000")).toEqual(PUB_AS_DATE);
    expect(at("Thu, 26 Mar 2026 15:52:06 GMT")).toEqual(PUB_AS_DATE);
    // Two-digit years still appear in feeds generated by very old software.
    expect(at("Thu, 26 Mar 26 15:52:06 GMT")).toEqual(PUB_AS_DATE);
  });

  it("parses ISO 8601 and converts a non-UTC offset to the correct instant", () => {
    // The suite runs with TZ=UTC (vitest.config.mts) precisely so that a
    // timezone bug here shows up rather than being papered over. 15:52 at
    // +01:00 is 14:52 UTC, and the caller formats this with pyDatetime, which
    // reads UTC fields.
    const at = (pubDate: string) =>
      parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>${pubDate}</pubDate></item>`), "https://example.org/feed/")[0]?.publishedDate;

    expect(at("2026-03-26T15:52:06Z")).toEqual(PUB_AS_DATE);
    expect(at("2026-03-26T16:52:06+01:00")).toEqual(PUB_AS_DATE);
    expect(at("2026-03-26")).toEqual(new Date("2026-03-26T00:00:00.000Z"));
  });

  it("keeps a date AT and BEFORE the Unix epoch -- the reject test is NaN, not falsiness", () => {
    // parseDate rejects on `Number.isNaN(date.getTime())`. Spelled `if
    // (!date.getTime())` or `> 0` -- both of which read as equivalent -- it
    // would throw away midnight on 1 Jan 1970 and every date before it. That is
    // not hypothetical for this crawler: a CMS with an unset post date emits
    // exactly the epoch, and losing those items would be indistinguishable from
    // the feed being empty.
    const at = (pubDate: string) =>
      parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>${pubDate}</pubDate></item>`), "https://example.org/feed/")[0]?.publishedDate;

    expect(at("Thu, 01 Jan 1970 00:00:00 +0000")).toEqual(new Date(0));
    expect(at("Wed, 31 Dec 1969 23:59:59 +0000")).toEqual(new Date(-1000));
  });

  it("drops a date beyond the range a JS Date can represent", () => {
    // The far end of "anything that doesn't parse becomes null": V8's Date tops
    // out at +275760-09-13, so one day past that is Invalid Date, getTime() is
    // NaN, and the item is dropped rather than reaching pyDatetime() -- which
    // would format it into D1 as "NaN-NaN-NaN NaN:NaN:NaN".
    expect(parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>+275760-09-14T00:00:00Z</pubDate></item>`), "https://example.org/feed/")).toEqual([]);
  });

  it("reads a date with NO timezone offset as local time, not as UTC", () => {
    // Plenty of real feeds omit the offset entirely ("2026-03-26T15:52:06",
    // "Thu, 26 Mar 2026 15:52:06"), and V8 resolves both against the PROCESS's
    // zone. Python feedparser defaults a missing zone to UTC instead. The two
    // crawlers therefore agree only for as long as this side runs in UTC --
    // true today (workerd is UTC, and vitest.config.mts pins TZ=UTC for exactly
    // this class of bug), but a property of the ENVIRONMENT rather than of this
    // code, and nothing else in the suite would notice if it stopped holding.
    const at = (pubDate: string) =>
      parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>${pubDate}</pubDate></item>`), "https://example.org/feed/")[0]?.publishedDate;

    expect(at("2026-03-26T15:52:06")).toEqual(PUB_AS_DATE);
    expect(at("Thu, 26 Mar 2026 15:52:06")).toEqual(PUB_AS_DATE);

    // The same two strings under a non-UTC zone land four hours later, which is
    // what makes the two lines above a statement about the environment rather
    // than about the parser. Compared against Date's own local-time constructor
    // instead of a hard-coded instant, so the assertion still holds on a Node
    // build whose ICU does not carry the zone; and restored in a finally,
    // because leaking TZ would unmoor every test after this one.
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const sameWallClock = new Date(2026, 2, 26, 15, 52, 6);
      expect(at("2026-03-26T15:52:06")?.getTime()).toBe(sameWallClock.getTime());
      expect(at("Thu, 26 Mar 2026 15:52:06")?.getTime()).toBe(sameWallClock.getTime());
    } finally {
      process.env.TZ = original;
    }
    expect(at("2026-03-26T15:52:06")).toEqual(PUB_AS_DATE);
  });

  it("accepts anything V8 accepts, including a bare year -- there is no feed-date validation", () => {
    // Recorded because it is surprising and load-bearing: a pubDate of "2026"
    // does NOT drop the item, it silently dates the article 1 January. Nothing
    // downstream sanity-checks the year, so if that is ever considered a bug,
    // it must be fixed in parseDate and this test changed on purpose.
    const items = parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>2026</pubDate></item>`), "https://example.org/feed/");
    expect(first(items).publishedDate).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });
});

describe("parseFeed: documented divergences from feedparser", () => {
  // Each of these produces a DIFFERENT stored value from the Python crawler
  // that ran until 2026-09-05. They are pinned as current behaviour, not
  // endorsed -- see the structured report accompanying this file. A test that
  // "fixed" one of these would be asserting something the code does not do.

  it("does NOT decode HTML entities inside CDATA, unlike feedparser", () => {
    // XML says CDATA content is literal, so fast-xml-parser leaves it alone and
    // `htmlEntities: true` never applies. feedparser treats an item title as
    // HTML regardless of CDATA and decodes it. The consequence: a WordPress
    // feed that wraps titles in CDATA stores the raw reference, so a headline
    // reads "Ben &#8217;s" on the live site -- the exact mojibake the
    // htmlEntities flag was added to eliminate for the non-CDATA case.
    const items = parseFeed(
      rss(`<item><title><![CDATA[Ben &amp; Jerry&#8217;s]]></title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("Ben &amp; Jerry&#8217;s");
  });

  it("concatenates the text around nested markup in a title, losing the whitespace between", () => {
    // textOf()'s comment predicts that nested markup "falls through to
    // undefined" (which would drop the item). It does not: fast-xml-parser
    // gives {"b": "bold", "#text": "Plaintail"}, the "#text" branch matches,
    // and the inner element's text vanishes while the surrounding words are
    // joined with no space. So the item is KEPT with a mangled title.
    const items = parseFeed(
      rss(`<item><title>Plain <b>bold</b> tail</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`),
      "https://example.org/feed/",
    );
    expect(first(items).title).toBe("Plaintail");
  });

  it("drops an item that repeats a field, because the repeated field parses to an array", () => {
    // Two <title>s (or two <link>s) become an array, which textOf() does not
    // recognise, so the field is "" and the guards drop the whole item. Both
    // fields are exercised: the comment used to claim the <link> case without
    // asserting it, and the two run through different code (title takes
    // textOf's `?? ""`, link takes resolveLink's early `if (!link)`), so
    // neither is evidence for the other.
    expect(
      parseFeed(rss(`<item><title>First</title><title>Second</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/"),
    ).toEqual([]);
    expect(
      parseFeed(rss(`<item><title>T</title><link>https://example.org/1/</link><link>https://example.org/2/</link><pubDate>${PUB}</pubDate></item>`), "https://example.org/feed/"),
    ).toEqual([]);
  });

  it("drops an RSS item that carries an <atom:link> alongside its <link>", () => {
    // `removeNSPrefix` collapses <atom:link> and <link> onto the same key, so
    // the item's link becomes a mixed array and textOf() returns undefined --
    // the article disappears with no error. The same option is what makes
    // <dc:date> work, so the two behaviours cannot be separated cheaply.
    expect(
      parseFeed(
        rss(`<item><title>T</title><atom:link rel="self" href="https://example.org/self/"/><link>https://example.org/real/</link><pubDate>${PUB}</pubDate></item>`),
        "https://example.org/feed/",
      ),
    ).toEqual([]);
  });

  // github #26. This asserted [] -- "correct by the spec; recorded because
  // the failure is total and silent". Atom 1.0 does require href, but PLAN.md
  // Task 8.6-a makes feedparser the parity target, not the spec: "any feed
  // the JS parser handles differently is a bug to fix, not a feed to skip".
  // feedparser keeps these, and structurally: its _start_link handler is
  // shared between RSS and Atom and falls back to element text whenever href
  // is absent.
  //
  // MEASURED BEFORE FIXING, because the ticket could not: all 470 live feeds
  // with an rss_url were fetched and run through this parser. NONE uses this
  // shape, so no food bank was actually losing articles to it -- the low
  // severity was right. The fix went in anyway because it is strictly more
  // tolerant: the fallback only runs where href is absent, which is an entry
  // the old code discarded outright, so no currently-kept entry can change.
  // Re-running the same 470 after the change altered no feed's item count.
  it("reads an Atom <link> that holds the URL as text rather than an href", () => {
    expect(
      parseFeed(`<feed><entry><title>T</title><link>https://example.org/1/</link><published>2026-03-26T15:52:06Z</published></entry></feed>`, "https://example.org/feed.atom"),
    ).toEqual([{ title: "T", link: "https://example.org/1/", publishedDate: new Date("2026-03-26T15:52:06Z") }]);
  });

  it("reads the other two shapes a text link arrives in, and resolves a relative one", () => {
    // textOf(), not a bespoke read, is what makes one branch cover all three:
    // fast-xml-parser gives a bare string for <link>URL</link>, a
    // {"#text", …attrs} wrapper once the element carries an attribute, and
    // the same wrapper for CDATA. Asserted separately because a fix written
    // against only the bare-string shape passes the test above and still
    // loses every entry in a feed whose links carry a type attribute.
    expect(
      parseFeed(
        `<feed><entry><title>T</title><link type="text/html">https://example.org/1/</link><published>2026-03-26T15:52:06Z</published></entry></feed>`,
        "https://example.org/feed.atom",
      ),
    ).toEqual([{ title: "T", link: "https://example.org/1/", publishedDate: new Date("2026-03-26T15:52:06Z") }]);

    // Relative text links go through resolveLink() exactly as RSS ones do.
    expect(
      parseFeed(`<feed><entry><title>T</title><link>/news/1/</link><published>2026-03-26T15:52:06Z</published></entry></feed>`, "https://example.org/feed.atom"),
    ).toEqual([{ title: "T", link: "https://example.org/news/1/", publishedDate: new Date("2026-03-26T15:52:06Z") }]);
  });

  it("still prefers href, and still drops an entry with neither href nor text", () => {
    // The fallback must not outrank a real href, and must not resurrect an
    // entry that genuinely has no link -- both are ways a "more tolerant"
    // change turns into a wrong or a duplicate article.
    expect(
      parseFeed(
        `<feed><entry><title>T</title><link rel="self" href="https://example.org/self/"/><link rel="alternate" href="https://example.org/alt/"/><published>2026-03-26T15:52:06Z</published></entry></feed>`,
        "https://example.org/feed.atom",
      ).map((i) => i.link),
    ).toEqual(["https://example.org/alt/"]);

    expect(
      parseFeed(`<feed><entry><title>T</title><link rel="alternate"/><published>2026-03-26T15:52:06Z</published></entry></feed>`, "https://example.org/feed.atom"),
    ).toEqual([]);

    expect(parseFeed(`<feed><entry><title>T</title><published>2026-03-26T15:52:06Z</published></entry></feed>`, "https://example.org/feed.atom")).toEqual([]);
  });

  it("ignores <dc:date> on an ATOM entry, dropping an entry dated only that way", () => {
    // rssItemToFeedItem reads pubDate then dc:date; atomEntryToFeedItem reads
    // published then updated and stops -- it never consults `date`. feedparser's
    // date handling is format-agnostic and would have read dc:date here, so an
    // Atom feed that dates its entries the RSS 1.0 way (real, if uncommon: it is
    // what several static-site generators emit) yields zero articles on every
    // crawl, with nothing logged. One line in the Atom mapper would fix it; it
    // is asserted as-is so that line is a deliberate change.
    expect(
      parseFeed(
        `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link href="https://example.org/1/"/><dc:date>2026-03-26T15:52:06Z</dc:date></entry></feed>`,
        "https://example.org/feed.atom",
      ),
    ).toEqual([]);
    // The same entry with <published> is kept, which is what makes the line
    // above a fact about dc:date rather than about the fixture.
    expect(
      parseFeed(
        `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link href="https://example.org/1/"/><published>2026-03-26T15:52:06Z</published></entry></feed>`,
        "https://example.org/feed.atom",
      ),
    ).toHaveLength(1);
  });

  it("drops EVERY item, absolute links included, when feedUrl is not a valid URL", () => {
    // resolveLink's comment claims "an already-absolute link is returned
    // unchanged (the two-argument URL constructor ignores the base when the
    // input is absolute)". That is only true for a VALID base: `new URL(abs,
    // bad)` parses the base first and throws, so resolveLink returns "" and
    // isUsable() drops the item. The feedUrl argument is therefore not just
    // decoration for absolute-link feeds -- it can zero them out.
    const absolute = rss(`<item><title>T</title><link>https://example.org/1/</link><pubDate>${PUB}</pubDate></item>`);
    expect(parseFeed(absolute, "not-a-url")).toEqual([]);
    expect(parseFeed(absolute, "")).toEqual([]);
    expect(parseFeed(absolute, "   ")).toEqual([]);
    // But NOT when feedUrl is missing altogether, which is the asymmetry worth
    // knowing: `new URL(abs, undefined)` treats the base as absent rather than
    // as a malformed string and succeeds, so an absent feedUrl is survivable
    // for absolute links while a present-but-invalid one is fatal to them.
    // (Outside the declared type, but it is the shape a `foodbank.rss_url` of
    // NULL would arrive in.) Relative links still go, since there is nothing to
    // resolve them against.
    expect(parseFeed(absolute, undefined as unknown as string)).toHaveLength(1);
    expect(parseFeed(rss(`<item><title>T</title><link>/rel/</link><pubDate>${PUB}</pubDate></item>`), undefined as unknown as string)).toEqual([]);
    // …and the same feed with a valid feedUrl yields the article, which is what
    // makes the line above a property of feedUrl rather than of the feed.
    expect(parseFeed(absolute, "https://example.org/feed/")).toHaveLength(1);
  });
});
