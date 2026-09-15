import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Environment as CompilerEnvironment, precompileString } from "nunjucks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "./env";
import { precompiledTemplates } from "./generated/precompiled";

// env.ts is the ONE Nunjucks Environment the whole site renders through, and
// its entire content is wiring: an autoescape flag, an undefined-variable
// flag, one global, two extensions and fourteen filter registrations. Nothing
// in it computes anything -- which is exactly why it is worth pinning. Every
// mistake this file can make is a mistake that happens at RENDER time, in a
// Worker, on a page nobody is watching:
//
//   * a filter registered under the wrong name is "filter not found: ..." --
//     a 500, not a wrong character. The module's own comment records that
//     this already happened once: the file originally registered camelCase
//     names (friendlyPhone) and the first real template to use one
//     (wfbn/index.njk) would have 500'd.
//   * autoescape off, or a filter wrapped in SafeString that should not be,
//     is stored-XSS on a page that looks perfect.
//   * `_` or `url` registered as an Environment GLOBAL instead of injected
//     per render would serve one visitor's language to the next visitor on
//     the same isolate, intermittently.
//
// WHAT THIS FILE USES INSTEAD OF MOCKS
//
// The real render(), the real precompiled template map, the real .po
// catalogues and the real @givefood/urls tables. Two kinds of template are
// rendered through it:
//
//  1. REAL TEMPLATES from packages/templates/templates/, by name. Four small
//     ones carry the whole surface end to end: wfbn/rss.njk (the now()
//     global and the |date spelling of the same format),
//     includes/serviceareadisclaimer.njk and
//     wfbn/foodbank/includes/charitynetwork.njk ({% blocktrans %}, with and
//     without vars), emails/need_notification_txt.njk
//     ({% autoescape false %}).
//
//  2. ONE-LINE TEMPLATES compiled here and injected into the same
//     precompiled map -- the only way to assert a filter's exact output
//     without dragging in a 300-line page template's whole context. This is
//     not a hand-built copy of the renderer: it is scripts/precompile.ts's
//     own mechanism (nunjucks.precompileString through a
//     `new nunjucks.Environment(null, { autoescape: true })`, the compiled
//     props object stored under a template name), pointed at a string
//     instead of a directory, and the resulting template is then rendered by
//     the REAL render() through the REAL Environment. Importing the full
//     "nunjucks" package here is what precompile.ts does at build time; the
//     ban on it is a WORKERS ban (no eval/new Function), and this is Node.
//
// Injected names are prefixed so they can never shadow a real template, and
// inject() refuses to overwrite an existing key.
//
// Overlap with workers/site/src/renderErrorPage.test.ts is deliberate but
// small: that file proves the 404/403/500 pages render and that the locale
// does not leak between requests, from the caller's side. This one is about
// env.ts's own registration table.
//
// MUTATION-TESTED. env.ts was copied into a scratch clone of the repo
// outside it, broken one way at a time, and this file re-run. Killed:
// autoescape flipped to false (8 tests), a filter re-registered under its
// old camelCase name (4), djslice registered as `slice` (3), django_title
// registered as `title` (5), the SafeString wrap dropped from linebreaks
// (2), a SafeString wrap ADDED to django_title (4), the cachedEnv memo
// removed (1), linebreaksbr pointed at linebreaks (2), either extension
// registration deleted (2 and 1), `now` evaluated once at build time
// instead of per call (4), `...args` dropped from the url() closure (2),
// the RFC 2822 format string altered (4), the context spread moved after
// the i18n keys (1), the default locale changed (4), `_`/`url` moved to
// Environment globals (8), the catalogue hardcoded to English (7), and two
// filters pointed at the wrong function (1 each).
//
// One deliberate SURVIVOR: deleting env.ts's `throwOnUndefined: false`
// changes nothing, and the test named for it explains why.

// `.href`, not the URL object -- @cloudflare/workers-types and @types/node
// each declare a global URL and they differ. Same one-word fix as
// templateBalance.test.ts in this directory and packages/db's
// schema.testkit.ts.
const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url).href);

// Mirrors scripts/precompile.ts's compileEnv exactly, and the "exactly"
// matters more than it looks: nunjucks bakes throwOnUndefined into the
// GENERATED CODE at compile time (compiler.js:1012 passes
// `opts.throwOnUndefined` into the Compiler; compiler.js:946 emits
// `runtime.ensureDefined(...)` only when it is set), so a compile
// environment that differed from the build script's would give these
// injected templates undefined-handling the real templates do not have.
// autoescape is the opposite -- read from the RENDERING environment at
// runtime -- and both halves of that are pinned below.
//
// No extensions registered here on purpose: {% blocktrans %} and
// {% autoescape %} are covered by real templates that genuinely use them,
// so no injected template needs the parser half of either class.
const COMPILE_ENV = new CompilerEnvironment(null, { autoescape: true });

const INJECTED_PREFIX = "__env_test__/";
let injectedCount = 0;

interface PrecompileWindow {
  nunjucksPrecompiled?: Record<string, unknown>;
}

// The two lines of scripts/precompile.ts that matter, inlined. nunjucks'
// default precompile wrapper emits `window.nunjucksPrecompiled[name] = ...`;
// the build script swaps that wrapper for an ES-module one, but here it is
// simpler to hand it a `window` object of our own and read the key back.
// The value is the compiled props object ({ root, b_<block>... }) that
// nunjucks' Template constructor expects for a `src.type === "code"` source
// -- byte-identical in shape to what precompiled.js holds for a real
// template.
function inject(source: string, compileEnv: CompilerEnvironment = COMPILE_ENV): string {
  const name = `${INJECTED_PREFIX}${injectedCount++}.njk`;
  // A collision with a real template would silently replace a page of the
  // live site for the rest of this file's run.
  if (name in precompiledTemplates) throw new Error(`injected name ${name} already exists in the precompiled map`);
  const generated = precompileString(source, { name, env: compileEnv });
  const win: PrecompileWindow = {};
  const load = new Function("window", generated) as (w: PrecompileWindow) => void;
  load(win);
  const compiled = win.nunjucksPrecompiled?.[name];
  if (compiled === undefined) throw new Error(`precompileString produced no template for ${name}`);
  precompiledTemplates[name] = compiled;
  return name;
}

// Every call gets a FRESH name because the Environment's loader caches a
// compiled template per name for the isolate's lifetime (see the "builds the
// Environment once" test below, which is built on exactly that) -- reusing a
// name would silently render the previous test's source.
async function renderSource(source: string, context: Record<string, unknown> = {}, locale?: "en" | "cy" | "ga" | "gd"): Promise<string> {
  return locale === undefined ? render(inject(source), context) : render(inject(source), context, locale);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the precompiled loader", () => {
  it("renders a real template from the generated map, not a template it compiled itself", async () => {
    // The whole reason env.ts exists in the shape it does: Workers ban
    // eval()/new Function(), so the Environment is built over a
    // PrecompiledLoader rather than a FileSystemLoader. If someone
    // "simplified" this back to nunjucks' normal loader it would work in
    // every Node test and fail on the first request in production with
    // "Code generation from strings disallowed for this context".
    //
    // wfbn/rss.njk is picked because it is small AND because it is the
    // template env.ts's own header comment cites for the RFC 2822 date
    // format.
    const xml = await render("wfbn/rss.njk", {
      SITE_DOMAIN: "https://www.givefood.org.uk",
      self_url: "https://www.givefood.org.uk/needs/rss.xml",
      items: [],
    });

    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
    expect(xml).toContain("<title>Give Food</title>");
    expect(xml).toContain("<description>News &amp; donation requests from UK food banks</description>");
    expect(xml).toContain("<link>https://www.givefood.org.uk</link>");
    expect(xml.trimEnd().endsWith("</rss>")).toBe(true);
  });

  it("holds all 149 templates the build script emitted, so a real name is never a typo away from missing", async () => {
    // Guards the assumption every other test in this file makes. If
    // precompile.ts ever stopped walking a subdirectory, the tests below
    // that render by name would fail with "template not found" and the ones
    // that inject would keep passing -- so this states the real count once,
    // where it is obvious what changed.
    const realNames = Object.keys(precompiledTemplates).filter((name) => !name.startsWith(INJECTED_PREFIX));
    expect(realNames).toHaveLength(149);
    expect(realNames).toContain("wfbn/rss.njk");
    expect(realNames).toContain("emails/need_notification_txt.njk");
    // Nested include paths are keyed by their path relative to templates/,
    // which is what `{% include "includes/debugcomment.njk" %}` resolves
    // against.
    expect(realNames).toContain("includes/debugcomment.njk");
  });

  it("rejects on a name the build script never emitted", async () => {
    // nunjucks-slim's PrecompiledLoader message. renderErrorPage.test.ts
    // pins the consequence (a 404 route that throws reaches app.onError and
    // the visitor gets a 500); this pins that render() is where it comes
    // from, and that it REJECTS rather than returning an empty page.
    await expect(render("does/not/exist.njk")).rejects.toThrow("template not found: does/not/exist.njk");
  });
});

describe("autoescape", () => {
  it("escapes every context value, and does so because the RENDERING environment says so", async () => {
    // env.ts:44 is the only `autoescape: true` that matters at request time:
    // nunjucks emits `runtime.suppressValue(x, env.opts.autoescape)`, read
    // from the environment doing the rendering (compiler.js's compileOutput)
    // -- NOT from the one that compiled the template. So this test compiles
    // its template with autoescape switched OFF and still expects escaped
    // output; if env.ts's flag were flipped, this is the test that goes red
    // rather than a silent XSS on every page that echoes a query string.
    const compiledWithoutEscaping = new CompilerEnvironment(null, { autoescape: false });
    const html = await render(inject("[{{ v }}]", compiledWithoutEscaping), { v: `<script>alert("x")&'` });

    expect(html).toBe("[&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;]");
  });

  it("escapes values reached through a filter too, not just bare ones", async () => {
    // django_title returns a plain string, so its output goes through
    // suppressValue like any other value. Pinned separately because the
    // SafeString-wrapped filters below are the exception, and "which filters
    // are exempt from escaping" is the single most security-relevant line in
    // env.ts.
    expect(await renderSource("{{ v|django_title }}", { v: "bill'S 3rd o'neill" })).toBe("Bill&#39;s 3rd O&#39;Neill");
  });
});

describe("throwOnUndefined", () => {
  it("renders a missing variable as empty, matching Django", async () => {
    // Django renders an unknown template variable as "" and never raises.
    // Three shapes, because they fail differently in nunjucks: a bare
    // missing name, an attribute of a missing object, and an attribute of a
    // present object. All three appear in the ported templates as normal
    // traffic -- debugcomment.njk alone prints six context variables that a
    // render outside a request does not set.
    expect(await renderSource("[{{ missing }}][{{ missing.deep.deeper }}][{{ present.absent }}]", { present: {} })).toBe("[][][]");
  });

  it("is decided at PRECOMPILE time, so env.ts's own throwOnUndefined: false is inert", async () => {
    // CURRENT BEHAVIOUR AND A DOCUMENTATION MISMATCH, pinned rather than
    // fixed. env.ts:49 sets `throwOnUndefined: false` and explains it as the
    // thing stopping "a Worker throwing 500s on every template typo".
    // It is not: nunjucks reads throwOnUndefined when it COMPILES (the
    // Compiler is constructed with it, compiler.js:1012, and emits
    // `runtime.ensureDefined` calls into the generated code), and a
    // precompiled template is never compiled by env.ts's Environment. The
    // flag that actually protects the site is the absence of the option on
    // scripts/precompile.ts's compileEnv.
    //
    // Demonstrated rather than argued: this template is compiled with
    // throwOnUndefined ON and still throws when rendered through the real
    // render(), whose Environment has it off. Deleting env.ts's line leaves
    // all 70 tests in this file green (checked, by doing it in a copy of the
    // repo); changing precompile.ts's environment 500s the whole site. That
    // asymmetry is the reason this test exists.
    //
    // (The setting is not dead code everywhere -- filters.js:133 and :389
    // read env.opts.throwOnUndefined at runtime for `groupby` and `sort`.
    // No ported template uses either.)
    const strict = new CompilerEnvironment(null, { autoescape: true, throwOnUndefined: true });
    await expect(render(inject("[{{ missing }}]", strict), {})).rejects.toThrow("attempted to output null or undefined value");
  });

  it("still throws on an unknown FILTER, which throwOnUndefined does not cover", async () => {
    // The failure env.ts's filter-registration comment describes, verified
    // here rather than taken on trust: an unregistered filter name is a
    // render-time exception, so a template shipped with a mistyped filter is
    // a 500 and not a blank space. This is what makes the naming test below
    // load-bearing.
    await expect(renderSource("{{ v|no_such_filter }}", { v: "x" })).rejects.toThrow("filter not found: no_such_filter");
  });
});

describe("the now() global", () => {
  it("formats the wall clock as RFC 2822, Django's `{% now \"r\" %}`", async () => {
    // Zero-padded day and hour, three-letter day/month names and the fixed
    // +0000 offset. The date chosen is a Sunday the 4th precisely because a
    // day/month index off by one, or a missing padStart, changes the string
    // and nothing else would notice: this value is only ever read inside an
    // HTML comment (debugcomment.njk) and an RSS <lastBuildDate>.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-04T05:06:07.089Z"));

    expect(await renderSource("{{ now() }}")).toBe("Sun, 04 Jan 2026 05:06:07 +0000");
  });

  it("agrees character for character with the |date spelling of the same format", async () => {
    // env.ts's header comment claims `{% now "r" %}` and wfbn/rss.xml's
    // `item.date|date:"D, d M Y H:i:s O"` "both go through
    // DATE_FORMAT_TOKENS's D/H/i/s/O entries". This is that claim as a test:
    // one instant, two code paths (formatRfc2822's hardcoded format string
    // and the format spelled out in a template), one string. A feed whose
    // <lastBuildDate> and <pubDate> were formatted differently is the kind
    // of thing only a strict aggregator ever complains about.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-05T19:28:08Z"));

    const out = await renderSource('[{{ now() }}][{{ d|date("D, d M Y H:i:s O") }}]', { d: "2026-09-05 19:28:08.853000" });

    expect(out).toBe("[Sat, 05 Sep 2026 19:28:08 +0000][Sat, 05 Sep 2026 19:28:08 +0000]");
  });

  it("re-reads the clock on every render rather than freezing at Environment build time", async () => {
    // env.ts registers `now` as a closure over `new Date()`, not as a
    // precomputed string -- and the Environment holding it is built once per
    // isolate and reused for the isolate's whole life. A registration that
    // evaluated the date eagerly would stamp the first request's timestamp
    // onto every page that isolate ever served, which is both wrong and
    // almost impossible to spot from the outside.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-04T05:06:07Z"));
    const first = await renderSource("{{ now() }}");
    vi.setSystemTime(new Date("2027-06-30T23:59:59Z"));
    const second = await renderSource("{{ now() }}");

    expect(first).toBe("Sun, 04 Jan 2026 05:06:07 +0000");
    expect(second).toBe("Wed, 30 Jun 2027 23:59:59 +0000");
  });

  it("is shadowed, not merged, by a context key of the same name", async () => {
    // A TRAP, pinned as documentation. `_`, `url` and `_i18nCatalogue` are
    // spread into the render context AFTER the caller's own keys, so a
    // caller cannot clobber them (asserted below). `now` is the opposite: it
    // is an Environment GLOBAL, and nunjucks' Context.lookup prefers the
    // context over the globals. So a route that passed `now: <anything>` to
    // render() would break `{{ now() }}` in debugcomment.njk -- which
    // page.njk includes on EVERY public page.
    //
    // Latent today: no call site passes `now` into a render context. The
    // only `now:` object key anywhere in packages/ or workers/ is
    // routes/write/index.ts:299, and it goes to draftEmailBody, not to
    // render() (every other `now` in the repo is a function parameter).
    // Pinned so that stays a deliberate fact rather than a lucky one.
    await expect(renderSource("{{ now() }}", { now: "2026-01-01" })).rejects.toThrow("Unable to call `now`, which is not a function");
  });
});

// The filter table. Each row is a name env.ts registers, the value it is
// given and the exact string that comes out of a real render -- so a
// renamed registration, a filter pointed at the wrong function, or a change
// to filters.ts itself all land here. The expected values are Django's:
// friendlyPhone/fullPhone/friendlyUrl/commaSeparated are ports of
// givefood/utils/text.py, the rest of django.contrib.humanize and
// django.template.defaultfilters (see filters.ts's per-function comments).
const REGISTERED_FILTERS: Array<{ name: string; template: string; value: unknown; expected: string }> = [
  { name: "friendly_phone", template: "{{ v|friendly_phone }}", value: "01722413384", expected: "01722 413 384" },
  { name: "full_phone", template: "{{ v|full_phone }}", value: "01722413384", expected: "+441722413384" },
  {
    name: "friendly_url",
    template: "{{ v|friendly_url }}",
    // A real shape: the scheme goes, the tracking parameter goes, the
    // genuine query parameter and the trailing slash before it stay.
    value: "https://www.trussell.org.uk/salisbury/?utm_source=givefood&x=1",
    expected: "www.trussell.org.uk/salisbury/?x=1",
  },
  { name: "comma_separated", template: "{{ v|comma_separated }}", value: "Beans\nPasta\nRice", expected: "Beans, Pasta, Rice" },
  { name: "slugify", template: "{{ v|slugify }}", value: "Sid Valley Food Bank!", expected: "sid-valley-food-bank" },
  { name: "intcomma", template: "{{ v|intcomma }}", value: 1234567, expected: "1,234,567" },
  // "N j, Y, P" is Django's DATETIME_FORMAT: AP-style month, no leading
  // zero on the day, and the 12-hour "P" time. Sept., not Sep.
  { name: "date", template: '{{ v|date("N j, Y, P") }}', value: "2026-09-05 19:28:08.853000", expected: "Sept. 5, 2026, 7:28 p.m." },
  { name: "djslice", template: '{{ v|djslice(2)|join("/") }}', value: ["a", "b", "c"], expected: "a/b" },
  // The two touch-up regexes in one string: "bill'S" -> "Bill's" and
  // "3rd" -> "3rd" (not "3Rd"), with "o'neill" -> "O'Neill" showing the
  // apostrophe rule does NOT fire after a capital.
  { name: "django_title", template: "{{ v|django_title }}", value: "bill'S 3rd o'neill", expected: "Bill&#39;s 3rd O&#39;Neill" },
  // Truncator.chars(5): text plus the ellipsis total exactly 5.
  { name: "truncatechars", template: "{{ v|truncatechars(5) }}", value: "abcdefghij", expected: "abcd…" },
  { name: "truncatewords", template: "{{ v|truncatewords(2) }}", value: "one two three four", expected: "one two …" },
  { name: "floatformat", template: "{{ v|floatformat(2) }}", value: 1.239, expected: "1.24" },
  { name: "linebreaks", template: "{{ v|linebreaks }}", value: "a<b\n\nc", expected: "<p>a&lt;b</p>\n\n<p>c</p>" },
  { name: "linebreaksbr", template: "{{ v|linebreaksbr }}", value: "a<b\nc", expected: "a&lt;b<br>c" },
];

describe("the filter registration table", () => {
  it.each(REGISTERED_FILTERS)("registers $name and gives Django's answer", async ({ template, value, expected }) => {
    expect(await renderSource(template, { v: value })).toBe(expected);
  });

  it("covers all fourteen names env.ts registers, with no duplicates", async () => {
    // env.ts makes fourteen addFilter calls under fourteen distinct names --
    // no name is registered twice, so nothing here is shadowed by a later
    // line. Stated here so that a filter added to env.ts without a row above
    // is visible as a count mismatch rather than as silence.
    const names = REGISTERED_FILTERS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(14);
  });

  it("does NOT register the camelCase names the file originally used", async () => {
    // The regression env.ts's comment records: "Registered under Django's
    // own filter names ... snake_case -- not camelCase, which is what this
    // file originally registered before any real template (wfbn/index.njk)
    // exercised them." Asserting only the snake_case half would pass just as
    // well against a file that registered BOTH spellings, which is the
    // tempting "safe" fix and the one that lets a template keep using a name
    // Django never had.
    for (const camel of ["friendlyPhone", "fullPhone", "friendlyUrl", "commaSeparated", "djangoTitle", "djangoSlice", "djangoDate"]) {
      await expect(renderSource(`{{ v|${camel} }}`, { v: "01722413384" })).rejects.toThrow(`filter not found: ${camel}`);
    }
  });

  it("leaves nunjucks' own `slice` and `title` builtins alone", async () => {
    // filters.ts names djangoSlice/djangoTitle "djslice"/"django_title"
    // specifically so these two builtins keep their Jinja2 meanings, and
    // says shadowing them "would silently break that meaning for any future
    // template that wants it". Both differ observably from the Django
    // versions, so this test dies the moment either registration is
    // renamed to the obvious short name.
    //
    // nunjucks' slice CHUNKS a list into N pieces; Django's takes the first
    // N items (asserted in the table above as "a/b").
    expect(await renderSource("{{ v|slice(2)|dump }}", { v: [1, 2, 3, 4] })).toBe("[[1,2],[3,4]]");
    // nunjucks' title splits on spaces only, so the letter after the
    // apostrophe stays lowercase; django_title uppercases after ANY
    // non-letter.
    expect(await renderSource("{{ v|title }}", { v: "o'neill mcdonald" })).toBe("O&#39;neill Mcdonald");
    expect(await renderSource("{{ v|django_title }}", { v: "o'neill mcdonald" })).toBe("O&#39;Neill Mcdonald");
  });

  it("passes a null column through the filters that guard for it, without a 500", async () => {
    // Nullable columns reaching a filter is normal traffic, not an edge
    // case: filters.ts's djangoDate comment records the admin dashboard
    // 500ing on `stats.oldest_edit.edited` being null. These four are the
    // filters that carry an explicit null guard, exercised through the
    // registration rather than directly, because a registration that wrapped
    // one of them (as linebreaks/linebreaksbr are wrapped) could reintroduce
    // the throw at this layer.
    const out = await renderSource(
      '[{{ v|friendly_phone }}][{{ v|full_phone }}][{{ v|date("N j, Y") }}][{{ v|linebreaks }}][{{ v|linebreaksbr }}]',
      { v: null },
    );

    expect(out).toBe("[][][][][]");
  });
});

describe("the SafeString-wrapped filters", () => {
  it("lets linebreaks and linebreaksbr emit real tags while still escaping their input", async () => {
    // env.ts wraps exactly these two in `new SafeString(...)`, because
    // Django's linebreaks is `is_safe = True`. Both halves matter and only
    // one of them is obvious:
    //   * without the wrap, autoescape turns the filter's own <p>/<br> into
    //     visible &lt;p&gt; on every need description on the site;
    //   * with the wrap, nothing downstream escapes the value, so the
    //     filter's OWN escapeHtml is the only thing between a food bank's
    //     free-text field and script execution. filters.ts escapes first and
    //     inserts tags second; a "simplification" that reordered those two
    //     would still render correctly for ordinary text and would be XSS.
    const out = await renderSource("[{{ v|linebreaks }}][{{ v|linebreaksbr }}]", { v: '<script>alert("x")</script>\n\nsecond' });

    expect(out).toBe(
      "[<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>\n\n<p>second</p>]" +
        "[&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br><br>second]",
    );
    expect(out).not.toContain("<script>");
    // The tags the filters produced are real markup, not escaped text --
    // i.e. the SafeString wrap is present.
    expect(out).not.toContain("&lt;p&gt;");
    expect(out).not.toContain("&lt;br&gt;");
  });

  it("wraps only those two -- no other filter's output is trusted", async () => {
    // The complement of the test above, and the one that fails if someone
    // "helpfully" wraps another registration. A filter that returned HTML
    // unescaped would be a stored-XSS vector on whichever column it is used
    // for; these three are the ones whose output most looks like it might
    // want to be markup.
    const out = await renderSource("[{{ v|django_title }}][{{ v|truncatechars(30) }}][{{ v|comma_separated }}]", { v: "<b>a</b>" });

    // django_title upper-cases after any non-letter, so it mangles the tag
    // names on the way through -- which is beside the point here and is
    // exactly why the assertion is on the ESCAPING, not the casing.
    expect(out).toBe("[&lt;B&gt;A&lt;/B&gt;][&lt;b&gt;a&lt;/b&gt;][&lt;b&gt;a&lt;/b&gt;]");
  });
});

describe("the per-render `_` and `url`", () => {
  it("translates through the real .po catalogue for each of the four locales", async () => {
    // The catalogues are built from locale/<lang>/django.po by
    // scripts/precompile.ts, copied verbatim from the Django app. `_` is
    // injected per render() call, so this is also the check that the locale
    // argument reaches translate() at all -- an implementation that ignored
    // it would return the English msgid, which reads as a missing
    // translation rather than as a bug.
    const template = '[{{ _("Homepage") }}][{{ _("Email") }}]';

    expect(await renderSource(template, {}, "en")).toBe("[Homepage][Email]");
    expect(await renderSource(template, {}, "cy")).toBe("[Hafanddalen][E-bost]");
    expect(await renderSource(template, {}, "ga")).toBe("[Leathanach baile][Ríomhphost]");
    expect(await renderSource(template, {}, "gd")).toBe("[Duilleag-dhachaigh][Post-d]");
  });

  it("falls back to the msgid when a catalogue has no entry, rather than rendering empty", async () => {
    // i18n.ts's translate() returns the msgid for a missing OR empty
    // msgstr. A .po file with an untranslated entry (`msgstr ""`) is the
    // normal state of a partially-translated catalogue, and the failure mode
    // this prevents is a Welsh page with blanks where the untranslated
    // strings should be English.
    expect(await renderSource('[{{ _("Give Food is a charity registered in England") }}]', {}, "cy")).toBe(
      "[Give Food is a charity registered in England]",
    );
  });

  it("interpolates %(name)s the gettext way, and escapes what it substitutes", async () => {
    // Two things at once. The %(name)s syntax is what the existing .po
    // msgids use (xgettext's own format), so `_` has to speak it rather than
    // nunjucks' {{ }}. And translate() returns a PLAIN STRING, not a
    // SafeString -- so an interpolated value is escaped on the way out. That
    // is the deliberate difference from {% blocktrans %} below, which does
    // wrap, and it is why i18n.ts's comment says `_` is for "single-word/
    // no-HTML strings".
    expect(await renderSource('{{ _("Part of %(name)s", {"name": v}) }}', { v: "<b>Trussell</b>" })).toBe(
      "Part of &lt;b&gt;Trussell&lt;/b&gt;",
    );
  });

  it("binds url() to the render's locale, prefixing only the i18n_patterns names", async () => {
    // urlForLocale prefixes a name in @givefood/urls' I18N_SCOPED set and
    // leaves everything else alone -- Django's i18n_patterns block versus
    // its "Untranslated apps" block. Both sides are asserted in one render
    // because a bug that prefixed everything and a bug that prefixed nothing
    // are equally plausible and only a mixed template tells them apart:
    // /cy/privacy/ and /dashboard/ under /cy/ are both 404s.
    const template = "[{{ url('wfbn:index') }}][{{ url('privacy') }}][{{ url('dash:index') }}]";

    expect(await renderSource(template, {}, "en")).toBe("[/needs/][/privacy/][/dashboard/]");
    expect(await renderSource(template, {}, "cy")).toBe("[/cy/needs/][/privacy/][/dashboard/]");
  });

  it("passes through the extra arguments a parameterised route needs", async () => {
    // env.ts spreads `...args` into urlForLocale. Dropping them would give
    // every food bank the index URL -- a page that renders perfectly with
    // every link pointing at the same place.
    expect(await renderSource("{{ url('wfbn:foodbank', 'sid-valley') }}", {}, "cy")).toBe("/cy/needs/at/sid-valley/");
    expect(await renderSource("{{ url('wfbn:foodbank_location', 'sid-valley', 'sidmouth') }}")).toBe(
      "/needs/at/sid-valley/sidmouth/",
    );
  });

  it("rejects, loudly, on a route name that is not in the table", async () => {
    // @givefood/urls throws rather than returning "" or "#". Worth pinning
    // at this layer because env.ts is what puts that function in front of
    // every template author: the alternative -- a silent empty href -- is a
    // dead link that ships.
    await expect(renderSource("{{ url('no_such_route') }}")).rejects.toThrow(
      'url(): no route named "no_such_route" in packages/urls/src/routes.ts',
    );
  });

  it("defaults to English when the locale argument is omitted", async () => {
    // render()'s third parameter defaults to "en", which is what lets the
    // English-only call sites in workers/site pass two arguments and stop.
    // renderErrorPage.ts leans on it when no middleware set `lang` --
    // renderErrorPage.test.ts's "falls back to English, silently" is the
    // consequence seen from that side.
    const name = inject('[{{ _("Homepage") }}][{{ url("wfbn:index") }}]');

    expect(await render(name)).toBe("[Homepage][/needs/]");
  });

  it("defaults the context to an empty object, so a template with no variables needs no argument", async () => {
    // The second parameter's `= {}`. A template rendered with nothing at all
    // must not throw -- 404.njk and friends are rendered from an error path
    // where building a context is itself what might have failed.
    expect(await render(inject("[{{ missing }}]"))).toBe("[]");
  });

  it("overrides `_`, `url` and `_i18nCatalogue` even when the caller supplies them", async () => {
    // The spread order in render(): `...context` first, the three i18n keys
    // after. So a context key called `url` -- an entirely natural name for a
    // food bank's website, and one that appears all over this codebase's row
    // objects -- cannot break `{% url %}` in page.njk's shared head.
    //
    // Asserted in the direction that matters: the caller's values are the
    // ones that lose. The catalogue case doubles as a small integrity check,
    // since a template cannot be made to translate against an injected
    // catalogue.
    const out = await renderSource('[{{ url("wfbn:index") }}][{{ _("Homepage") }}][{{ _i18nCatalogue["Homepage"] }}]', {
      url: "https://sidvalleyfoodbank.invalid/",
      _: "not a function",
      _i18nCatalogue: { Homepage: "PWNED" },
    }, "cy");

    expect(out).toBe("[/cy/needs/][Hafanddalen][Hafanddalen]");
  });

  it("does not carry one render's locale into the next through the shared Environment", async () => {
    // env.ts's comment for why `_`/`url` are injected per call rather than
    // registered as globals like `now`. A Workers isolate outlives the
    // request, and the Environment is cached for the isolate's whole life,
    // so a global registration would serve Welsh to English visitors
    // intermittently -- depending only on which isolate they landed on,
    // which is the hardest class of bug to reproduce from a report.
    //
    // renderErrorPage.test.ts asserts this through the router; this asserts
    // it at the layer that actually makes the guarantee, and interleaves the
    // locales so a "sticky last locale" and a "sticky first locale" both
    // fail.
    const template = '[{{ _("Homepage") }}][{{ url("wfbn:index") }}]';
    const welsh = await renderSource(template, {}, "cy");
    const english = await renderSource(template, {}, "en");
    const irish = await renderSource(template, {}, "ga");
    const englishAgain = await renderSource(template, {}, "en");

    expect(welsh).toBe("[Hafanddalen][/cy/needs/]");
    expect(english).toBe("[Homepage][/needs/]");
    expect(irish).toBe("[Leathanach baile][/ga/needs/]");
    expect(englishAgain).toBe("[Homepage][/needs/]");
  });

  it("rejects with a TypeError for a locale outside the four, because there is no fallback", async () => {
    // CURRENT BEHAVIOUR, pinned as documentation. i18n.ts indexes
    // LOADERS[locale] and calls the result, so a fifth locale is
    // "LOADERS[locale] is not a function" rather than an English page.
    // Unreachable through the type system; reachable through any `as Locale`
    // cast, and workers/site does exactly one of those on c.get("lang").
    await expect(render(inject("{{ 1 }}"), {}, "de" as "en")).rejects.toThrow("LOADERS[locale] is not a function");
  });
});

describe("the blocktrans and autoescape extensions", () => {
  it("runs {% blocktrans %} against the render's catalogue", async () => {
    // includes/serviceareadisclaimer.njk, a real template and the smallest
    // blocktrans in the repo. The extension registered on env.ts's
    // Environment is a DIFFERENT INSTANCE of BlocktransExtension from the
    // one scripts/precompile.ts registers -- the precompiled code calls
    // `env.getExtension("blocktrans").run(...)`, so if env.ts ever stopped
    // registering it (or registered it under another name) every one of the
    // 27 templates containing a blocktrans would throw at render time.
    const en = await render("includes/serviceareadisclaimer.njk", { has_service_area: true });
    const cy = await render("includes/serviceareadisclaimer.njk", { has_service_area: true }, "cy");

    expect(en).toContain('<p class="serviceareadisclaimer">Service areas are approximate. You should check with the food bank</p>');
    expect(cy).toContain(
      '<p class="serviceareadisclaimer">Mae\'r ardaloedd gwasanaeth yn fras. Dylech wirio gyda\'r banc bwyd</p>',
    );
    // The `{% if %}` guard, so the assertions above are not passing on a
    // template that always emits its body.
    expect(await render("includes/serviceareadisclaimer.njk", { has_service_area: false })).toBe("\n");
  });

  it("keeps a blocktrans msgstr's own HTML unescaped while its variables come from url()", async () => {
    // wfbn/foodbank/includes/charitynetwork.njk, whose Welsh msgstr is
    // `Cofrestru Elusen <a href="%(charity_url)s" ...>%(charity_number)s</a>`
    // -- an anchor inside the translated string. That is what
    // BlocktransExtension's SafeString wrap is for, and the failure without
    // it is visible &lt;a href&gt; text on every non-English food bank page.
    //
    // The interesting part is the variable: `charity_url` is
    // `url('wfbn:foodbank_charity', ...)`, bound to the render's locale, so
    // this one assertion covers the extension, the catalogue and the
    // per-render url() together.
    const context = {
      foodbank: { charity_number: "1103322", name: "Salisbury Foodbank", slug: "salisbury", network: "Trussell Trust" },
      has_charity_details: true,
      network_url: "https://www.trussell.org.uk",
    };

    expect(await render("wfbn/foodbank/includes/charitynetwork.njk", context)).toContain(
      'Charity Registration <a href="/needs/at/salisbury/charity/" id="charity_link">1103322</a><br>',
    );
    expect(await render("wfbn/foodbank/includes/charitynetwork.njk", context, "cy")).toContain(
      'Cofrestru Elusen <a href="/cy/needs/at/salisbury/charity/" id="charity_link">1103322</a><br>',
    );
    // The bodiless blocktrans in the same template, so both shapes of the
    // tag (with vars and without) are covered.
    expect(await render("wfbn/foodbank/includes/charitynetwork.njk", context, "cy")).toContain("Rhan o");
  });

  it("runs {% autoescape false %} and puts the flag back afterwards", async () => {
    // emails/need_notification_txt.njk is a PLAIN TEXT email body wrapped
    // entirely in {% autoescape false %}, and its own header explains why:
    // without it the Environment's global autoescape ships "Tea &amp;
    // Coffee" into a plain-text body -- one whose exact bytes that header
    // says are already in 5,855 delivered inboxes.
    //
    // The second half is the one that could go wrong quietly. The extension
    // flips `context.env.opts.autoescape` on the SHARED, ISOLATE-LIFETIME
    // Environment and restores it in a `finally`. If that restore were ever
    // dropped, every page rendered after the first notification email in
    // that isolate would come out unescaped -- so this renders an escaping
    // template, then the email, then the escaping template again.
    const escapingContext = { SITE_DOMAIN: "", self_url: "", items: [{ title: "Tea & Coffee", url: "", date: "" }] };
    const before = await render("wfbn/rss.njk", escapingContext);
    const email = await render("emails/need_notification_txt.njk", {
      full_name: "Tea & Coffee Foodbank",
      change_text: "Beans <b>now</b>",
      has_excess: false,
      articles: [],
      foodbank_slug: "salisbury",
      show_donation_points: false,
      subscriber_created_date: "1 January 2026",
      subscriber_created_time: "9 a.m.",
      unsub_key: "abc&123",
    });
    const after = await render("wfbn/rss.njk", escapingContext);

    // Inside the {% autoescape false %} block: nothing escaped, including
    // the ampersand in the unsubscribe key's query string.
    expect(email).toContain("requested by Tea & Coffee Foodbank");
    expect(email).toContain("Beans <b>now</b>");
    expect(email).toContain("unsubscribe/?key=abc&123");
    expect(email).not.toContain("&amp;");
    // Outside it, before and after, escaping is on.
    expect(before).toContain("<title>Tea &amp; Coffee</title>");
    expect(after).toContain("<title>Tea &amp; Coffee</title>");
    expect(after).toBe(before);
  });
});

describe("the cached Environment", () => {
  it("builds the Environment once and reuses it for every render", async () => {
    // env.ts memoises the Environment in `cachedEnv` because rebuilding it
    // would re-read the whole precompiled map -- 1.2MB of generated code --
    // on every request, "throwing away the whole point of precompiling it at
    // build time".
    //
    // Observable because nunjucks caches a compiled template on the LOADER
    // object (environment.js:250 writes `info.loader.cache[name]`), and the
    // loader is constructed inside buildEnvironment(). So: render a template,
    // replace its entry in the precompiled map, render it again. A cached
    // Environment serves the stale first version; a per-call Environment
    // would build a fresh loader with an empty cache and pick up the
    // replacement. This is the only externally visible consequence of the
    // memo, and without it a regression here would show up only as latency.
    const name = inject("FIRST");
    expect(await render(name)).toBe("FIRST");

    const replacement = inject("SECOND");
    precompiledTemplates[name] = precompiledTemplates[replacement];

    expect(await render(name)).toBe("FIRST");
    // ...and the replacement really was a different template, so the
    // assertion above is not passing because the two compiled identically.
    expect(await render(replacement)).toBe("SECOND");
  });

  it("gives byte-identical output for the same template and context twice", async () => {
    // Nothing in the Environment may accumulate state across renders. The
    // AutoescapeExtension mutating env.opts is the one place that
    // deliberately does, and this is the general-case guard around it: a
    // page whose second render differs from its first is a page whose cached
    // copy at the edge is a coin toss.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-05T19:28:08Z"));
    const context = { colo: "LHR", version: "abc1234", language_code: "cy" };
    const first = await render("includes/debugcomment.njk", context, "cy");
    const second = await render("includes/debugcomment.njk", context, "cy");

    expect(second).toBe(first);
    expect(first).toContain("👋 Helo!");
    expect(first).toContain("🕰️ Generated at Sat, 05 Sep 2026 19:28:08 +0000");
    expect(first).toContain("🌐 In colo LHR");
  });
});

// Every .njk under templates/, found by walking the directory rather than
// listed -- a list stops covering templates added later, which is the exact
// failure this test is about.
function everyTemplateFile(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return everyTemplateFile(path);
    return path.endsWith(".njk") ? [path] : [];
  });
}

// Filter names as they are actually piped, read out of the real template
// sources. Only inside `{{ ... }}` / `{% ... %}` delimiters, so the `||` in
// page.njk's inline JavaScript and any literal pipe in prose cannot be
// mistaken for one. Nunjucks comments are stripped first, same as
// templateBalance.test.ts does, because several templates discuss filters in
// prose.
function pipedFilterNames(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of everyTemplateFile(TEMPLATES_DIR)) {
    const source = readFileSync(file, "utf8").replace(/\{#[\s\S]*?#\}/g, "");
    for (const tag of source.matchAll(/\{[{%]([\s\S]*?)[%}]\}/g)) {
      for (const piped of (tag[1] ?? "").matchAll(/\|\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = piped[1];
        if (name !== undefined && !found.has(name)) found.set(name, file.slice(TEMPLATES_DIR.length));
      }
    }
  }
  return found;
}

describe("every filter the real templates use", () => {
  const PIPED = pipedFilterNames();

  it("finds the templates and their filters at all", () => {
    // Without this, every case below would pass vacuously over an empty map
    // if the directory path or the extension ever changed.
    expect(PIPED.size).toBeGreaterThan(15);
    expect([...PIPED.keys()].sort()).toContain("friendly_phone");
    expect([...PIPED.keys()].sort()).toContain("truncatewords");
  });

  it.each([...PIPED.entries()])("resolves `|%s` (used by %s)", async (name) => {
    // THE TEST THAT CATCHES THE NEXT wfbn/index.njk. env.ts's registration
    // list and the templates' use of it are maintained in different files by
    // different work packages, and nothing connects them: a template can be
    // ported with a filter env.ts never registered, and the only symptom is
    // a 500 the first time that page is requested in production.
    //
    // Passing no argument is deliberate. A filter that needs one (date,
    // truncatechars) throws something else entirely -- a TypeError out of
    // filters.ts -- and that is fine: the ONLY thing asserted is that
    // nunjucks found a function under the name. Asserting more would mean
    // hand-maintaining an argument per filter, which is the list that goes
    // stale.
    const failure = await renderSource(`{{ v|${name} }}`, { v: "1" }).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(failure ?? "").not.toContain("filter not found");
  });

  it("registers comma_separated even though no template pipes it", async () => {
    // A registration with no consumer, noted rather than removed: the
    // filters.ts port of givefood/utils/text.py is deliberately complete
    // ("the entire bespoke template-language surface"), and the Django
    // templates that used comma_separated are among those still to port.
    // Pinned so its removal is a decision rather than a tidy-up that breaks
    // the next template to arrive.
    expect(PIPED.has("comma_separated")).toBe(false);
    expect(await renderSource("{{ v|comma_separated }}", { v: "a\nb" })).toBe("a, b");
  });
});
