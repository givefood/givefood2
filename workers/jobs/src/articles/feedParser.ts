import { XMLParser } from "fast-xml-parser";

// Ports the exact three fields Python's `feedparser` output feeds into
// `foodbank_article_crawl` (crawlers.py:25-67) -- item.title, item.link,
// item.published_parsed -- not a general feedparser port. feedparser
// itself normalises RSS 2.0/1.0(RDF)/0.9x and Atom 0.3/1.0 into one
// uniform shape; this does the same narrow normalisation using
// fast-xml-parser (pure JS, zero Node-API dependencies, Workers-safe)
// as the underlying XML parser, rather than feedparser's own SGML-ish
// tag-soup parser (which has no JS/Workers equivalent).
export interface FeedItem {
  title: string;
  link: string;
  publishedDate: Date | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  textNodeName: "#text",
  removeNSPrefix: true, // dc:date/atom:link/content:encoded -> date/link/encoded; RSS mixes namespaced and bare tags for the same concept (pubDate vs dc:date) and we only read a handful of fields by bare name
  trimValues: true,
  parseTagValue: false, // keep every text value a string -- a numeric-looking title ("2026") must not become a JS number
  // Without this, fast-xml-parser decodes only XML's five predefined
  // entities (&amp; &lt; &gt; &quot; &apos;) and leaves named/numeric HTML
  // entities ("&#8211;", "&#038;", "&rsquo;") literal in the output --
  // confirmed directly: WordPress (most food banks' CMS) emits numeric
  // character references for punctuation in titles ("&#8217;" for a
  // right single quote), and 243/469 real feeds had at least one title
  // affected before this flag was set, verified against feedparser's own
  // (fully HTML-entity-decoding) output for the same feeds.
  htmlEntities: true,
});

// A parsed node's text is a plain string, a {__cdata} wrapper (an
// all-CDATA element with no sibling markup), or a {"#text", ...attrs}
// wrapper (element text alongside attributes, e.g. <guid isPermaLink="…">)
// -- verified directly against fast-xml-parser's real output for each
// shape. Nested markup inside the field (a rare, technically-invalid-
// unless-escaped case) falls through to `undefined`, matching how
// unrecoverable malformed XML is already handled by the caller (§ below).
function textOf(node: unknown): string | undefined {
  // `trimValues` (the parser option above) only trims plain text nodes,
  // not CDATA content -- confirmed directly: real feeds carry titles like
  // "<![CDATA[Our Newsletter : December Voice ]]>", trailing space and
  // all, inside the CDATA itself. feedparser's own output has no such
  // trailing whitespace, so trim unconditionally here rather than only
  // for the plain-string branch.
  if (typeof node === "string") return node.trim();
  if (typeof node === "number") return String(node);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.__cdata === "string") return obj.__cdata.trim();
    if (typeof obj["#text"] === "string") return obj["#text"].trim();
  }
  return undefined;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// Atom's <link> has no fixed text content -- the URL is the `href`
// attribute -- and an entry can carry several (rel=self, rel=alternate,
// rel=enclosure, …). A link with no `rel` defaults to "alternate" per the
// Atom spec; feedparser's own selection prefers rel=alternate, falling
// back to the first link present. Mirrored here rather than guessing.
function pickAtomLink(node: unknown): string | undefined {
  const links = asArray(node as Record<string, unknown> | Record<string, unknown>[]);
  if (links.length === 0) return undefined;
  const alternate = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate");
  const chosen = alternate ?? links[0];
  const href = chosen?.["@_href"];
  if (typeof href === "string") return href;
  // NO href: FALL BACK TO THE ELEMENT'S TEXT (github #26). A feed that
  // declares itself Atom but writes RSS-style text links -- <link>URL</link>
  // rather than <link href="URL"/> -- used to lose EVERY entry, on every
  // crawl, silently: pickAtomLink returned undefined, atomEntryToFeedItem
  // coerced it to "", and isUsable dropped the item. queues/articles.ts logs
  // nothing on an empty parse and closes the CrawlItem with a null
  // discrepancy, so the food bank's news page just stayed empty and the crawl
  // looked healthy.
  //
  // feedparser keeps them, and structurally rather than by accident: its
  // _start_link (namespaces/_base.py:337-361) is SHARED between RSS and Atom
  // and ends `else: self.push("link", expecting_text)`, capturing element
  // text whenever href is absent. It is the same handler that makes ordinary
  // RSS <link>text</link> work. PLAN.md Task 8.6-a makes feedparser the
  // parity target in as many words -- "any feed the JS parser handles
  // differently is a bug to fix, not a feed to skip" -- so spec-invalidity
  // (Atom 1.0 requires href) is not a defence here.
  //
  // textOf, not a bespoke read, so this covers all three shapes
  // fast-xml-parser produces for a text link at once: a bare string, the
  // {"#text", …attrs} wrapper from <link type="text/html">URL</link>, and
  // CDATA. The result flows through resolveLink() unchanged, so a relative
  // text link is resolved against the feed URL exactly as an RSS one is.
  //
  // STRICTLY MORE TOLERANT: this branch only runs where href is absent, and
  // an entry with no href is one the old code discarded outright, so no
  // currently-kept entry can change. Verified against all 470 live feeds --
  // see the note in feedParser.test.ts.
  return textOf(chosen);
}

// RFC 822/1123 (RSS pubDate: "Thu, 26 Mar 2026 15:52:06 +0000") and ISO
// 8601 (Atom published/updated, RSS 1.0 dc:date: "2026-03-26T15:52:06Z")
// both parse correctly via the native Date constructor in V8/workerd --
// verified directly, not assumed. Anything that doesn't parse becomes
// `null`, same as feedparser leaving `published_parsed` unset on a date it
// can't recognise (crawlers.py never reads a null-dated item, since
// FoodbankArticle.published_date is NOT NULL -- see insertFoodbankArticle).
function parseDate(text: string | undefined): Date | null {
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Foodbank.rss_url is uncredentialed, third-party content -- malformed XML
// is a real possibility (a plugin misconfiguration, a CMS migration mid-
// crawl), and fast-xml-parser, unlike feedparser's tag-soup tolerance,
// throws on XML that isn't well-formed. Treated as "no items this crawl" --
// the same outcome Django's `if feed:` guard produces when feedparser's
// own best-effort parse finds nothing usable -- rather than failing the
// whole queue message; see needcheckRender.ts's S1 pattern for the same
// "render failure isn't a retryable error" shape, though article crawl
// carries no discrepancy for it (crawlers.py doesn't either).
// `feedUrl` is REQUIRED, and is not decoration: an item's <link> may be
// relative to the feed, and feedparser resolves those against the feed's
// own URL before Django ever sees them (its _resolveRelativeURIs pass), so
// every article Django has ever stored is absolute.
//
// This parser did not resolve them, so a feed using relative links -- e.g.
// glossopdalefoodbank.org.uk, "/news/new-fire-door-needed/" -- stored the
// path verbatim. Two consequences, both live on 2026-09-05:
//
//   * /needs/at/glossopdale/news/ returned a hard 500 on every request.
//     FoodbankArticle.url_with_ref() calls `new URL(value)`, which THROWS
//     on a relative URL rather than returning null.
//   * Every such article was stored TWICE -- once absolute by Django's
//     crawler, once relative by this one -- because the url uniqueness
//     index saw two different strings for the same article.
export function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const absolute = (item: FeedItem): FeedItem => ({ ...item, link: resolveLink(item.link, feedUrl) });

  const rssChannel = (doc.rss as Record<string, unknown> | undefined)?.channel as Record<string, unknown> | undefined;
  if (rssChannel) return asArray(rssChannel.item as Record<string, unknown> | Record<string, unknown>[]).map(rssItemToFeedItem).map(absolute).filter(isUsable);

  // RSS 1.0 (RDF): <item> is a direct child of the root, not nested under
  // <channel> -- the one structural difference from RSS 2.0 that matters
  // for the three fields read here (fields themselves are the same names,
  // decoded identically by removeNSPrefix).
  const rdfRoot = doc.RDF as Record<string, unknown> | undefined;
  if (rdfRoot) return asArray(rdfRoot.item as Record<string, unknown> | Record<string, unknown>[]).map(rssItemToFeedItem).map(absolute).filter(isUsable);

  const atomFeed = doc.feed as Record<string, unknown> | undefined;
  if (atomFeed) return asArray(atomFeed.entry as Record<string, unknown> | Record<string, unknown>[]).map(atomEntryToFeedItem).map(absolute).filter(isUsable);

  return [];
}

function rssItemToFeedItem(item: Record<string, unknown>): FeedItem {
  return {
    title: textOf(item.title) ?? "",
    link: textOf(item.link) ?? "",
    // pubDate (RSS 2.0/0.9x) takes precedence; dc:date (RSS 1.0/RDF, and
    // sometimes present as a namespaced extra on RSS 2.0 items too) is the
    // fallback -- matching feedparser's own field-priority order.
    publishedDate: parseDate(textOf(item.pubDate) ?? textOf(item.date)),
  };
}

function atomEntryToFeedItem(entry: Record<string, unknown>): FeedItem {
  return {
    title: textOf(entry.title) ?? "",
    link: pickAtomLink(entry.link) ?? "",
    // feedparser prefers <published>, falling back to <updated> when an
    // entry (rarely) omits it.
    publishedDate: parseDate(textOf(entry.published) ?? textOf(entry.updated)),
  };
}

// crawlers.py:43's `if item.title != ""` guard, plus the structural
// requirement (mktime(item.published_parsed)) that a dateless item is
// never insertable -- both checked once, here, rather than at every call
// site.
function isUsable(item: FeedItem): boolean {
  // link !== "" is new alongside the title/date guards: resolveLink()
  // returns "" for anything it cannot make absolute, and an article with no
  // usable URL is not insertable -- the column is the uniqueness key and
  // every reader calls new URL() on it.
  return item.title !== "" && item.publishedDate !== null && item.link !== "";
}

// Resolve an item link against the feed's own URL, the way feedparser does.
// An already-absolute link is returned unchanged (the two-argument URL
// constructor ignores the base when the input is absolute). Anything that
// still will not parse yields "", which isUsable() then drops -- better a
// missing article than a stored value that makes a whole page throw.
function resolveLink(link: string, feedUrl: string): string {
  if (!link) return "";
  try {
    return new URL(link, feedUrl).toString();
  } catch {
    return "";
  }
}
