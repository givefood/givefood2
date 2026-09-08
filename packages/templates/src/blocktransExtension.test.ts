import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import nunjucksSlim from "nunjucks/browser/nunjucks-slim.js";
import { describe, expect, it } from "vitest";
import { BlocktransExtension } from "./blocktransExtension";
import { parsePoFile } from "./poParser";

// {% blocktrans %} is the only reason the Welsh, Irish and Gaelic pages have
// any translated sentences at all: `{% trans %}`/`_()` covers single words,
// and everything with a variable or a link in it -- "Food banks in Wales",
// `Part of <a href="...">Borehamwood</a>` -- goes through this extension.
//
// Its failure mode is silence. If parse() builds a msgid that differs from
// the one gettext extracted into locale/*/django.po by so much as a space,
// the lookup misses, run() falls back to the English msgid, and a Welsh page
// renders correct-looking English. Nothing throws, nothing logs, and no test
// that asserts a status code or "the page contains a <div>" would notice. So
// the tests below assert the exact msgid string and the exact translated
// output, against the real .po catalogue, not shapes.
//
// EVERYTHING REAL. The parser driving parse() is the real full nunjucks
// (3.2.4) wired exactly as scripts/precompile.ts wires it; the runtime
// driving run() is the real nunjucks-slim that ships to the Worker; the
// catalogue is locale/cy/django.po read through the real parsePoFile that
// precompile.ts uses to build it; the templates are the real .njk files.
// Nothing here needs a mock, because nothing here leaves the machine. The
// only two hand-built objects are a Proxy that records which key the real
// run() looked up, and a two-line stand-in for nunjucks' runtime Context in
// the tests that call run() directly.
//
// Django parity claims below were checked by RUNNING Django, not by reading
// it: Django 6.1 from /Users/jasoncartwright/Sites/foodcharity/.venv,
// rendering the equivalent {% blocktranslate %} through
// django.template.Engine with a spy on translation.gettext to capture the
// msgid it actually looks up. Where the port diverges, the test asserts what
// the port does and the comment records the Django result.

// `.href`, not the URL object -- @cloudflare/workers-types and @types/node
// each declare a global URL and they differ, so node:url's signature rejects
// the one `new URL(...)` produces here. Same clash and same one-word fix as
// templateBalance.test.ts in this directory.
const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url).href);
const LOCALE_DIR = fileURLToPath(new URL("../locale/", import.meta.url).href);

// The real Welsh catalogue, built the way the shipped one is built: the same
// .po file, through the same parser precompile.ts calls. Reading the .po
// rather than src/generated/locales/cy.json on purpose -- generated/ is
// gitignored and only exists after `pnpm precompile`, and `pnpm test` does
// not run precompile, so a test that imported the JSON would fail on a clean
// checkout for a reason that has nothing to do with this module.
const CY = parsePoFile(readFileSync(join(LOCALE_DIR, "cy", "django.po"), "utf8"));

// The two shapes this file feeds the constructor. The union is not exported
// (the interfaces are file-private), so the parameter type is recovered from
// the constructor rather than by exporting anything to reach it.
type BlocktransLib = ConstructorParameters<typeof BlocktransExtension>[0];

// Full nunjucks exports both `nodes` and `runtime`; a parse-only lib in the
// shape the module comment describes has only `nodes`. Built from the real
// nodes module so the object is the genuine article minus the one property
// the constructor branches on.
const parseOnlyLib = { nodes: (nunjucks as unknown as { nodes: unknown }).nodes } as unknown as BlocktransLib;

// Wired exactly as scripts/precompile.ts wires it: full nunjucks, autoescape
// on, extension registered under the name the compiled output looks up.
function compileEnvironment(): nunjucks.Environment {
  const env = new nunjucks.Environment(null, { autoescape: true });
  env.addExtension("blocktrans", new BlocktransExtension(nunjucks));
  return env;
}

const COMPILE_ENV = compileEnvironment();

function render(source: string, context: Record<string, unknown> = {}): string {
  return COMPILE_ENV.renderString(source, context);
}

// The msgid parse() bakes into the compiled template is not otherwise
// observable -- run() reads it back as a plain property lookup on the
// catalogue. This is a recording probe, not a mock of anything: the real
// run() does the real lookup, the Proxy only writes down the key it asked
// for. Every other test here uses a real object catalogue.
function msgidFor(source: string, context: Record<string, unknown> = {}): string {
  const lookedUp: string[] = [];
  const probe = new Proxy({} as Record<string, string>, {
    get(_target, key) {
      if (typeof key === "string") lookedUp.push(key);
      return undefined;
    },
  });
  render(source, { ...context, _i18nCatalogue: probe });
  expect(lookedUp).toHaveLength(1);
  return lookedUp[0] ?? "";
}

// A minimal stand-in for nunjucks' runtime Context, which is what run()
// receives as its first argument. Only `.lookup` is touched.
function contextWith(catalogue: unknown): { lookup: (name: string) => unknown } {
  return { lookup: (name: string) => (name === "_i18nCatalogue" ? catalogue : undefined) };
}

// The full dual-lifecycle round trip the module comment describes, in one
// function: instance A (full nunjucks) parses at "build time", the emitted
// source is loaded like a precompiled template, and instance B (slim) runs it
// at "request time" -- exactly precompile.ts -> env.ts, without needing the
// gitignored generated/ directory to exist.
function precompileThenRenderOnSlim(
  source: string,
  context: Record<string, unknown>,
  runtimeExtension: BlocktransExtension = new BlocktransExtension(nunjucksSlim),
): { emitted: string; output: string } {
  const emitted = nunjucks.precompileString(source, {
    name: "blocktrans-test.njk",
    env: COMPILE_ENV,
    // @types/nunjucks types `wrapper` as taking one template; nunjucks
    // actually passes the array. Same cast, same reason, as precompile.ts.
    wrapper: ((templates: Array<{ template: string }>) => templates[0]?.template ?? "") as unknown as never,
  });
  const compiledTemplate: unknown = new Function(emitted)();
  const runtimeEnv = new nunjucksSlim.Environment(
    new nunjucksSlim.PrecompiledLoader({ "blocktrans-test.njk": compiledTemplate }),
    { autoescape: true },
  );
  runtimeEnv.addExtension("blocktrans", runtimeExtension);
  return { emitted, output: runtimeEnv.render("blocktrans-test.njk", context) };
}

describe("the two lives of one class", () => {
  it("registers itself for {% blocktrans %} and nothing else", () => {
    // nunjucks keys its tag dispatch off this array, so a rename here stops
    // every {% blocktrans %} in templates/ from compiling. Loud, but this is
    // also the one line that decides which tag the extension is for, and it
    // has to agree with 28 Django templates' worth of ported markup.
    expect(new BlocktransExtension(nunjucksSlim).tags).toEqual(["blocktrans"]);
  });

  it("confirms the empirical claim the class split rests on: slim has no nodes.CallExtension", () => {
    // The module comment says nunjucks-slim strips the parser and AST "to
    // nothing -- verified empirically, nunjucks-slim.nodes.CallExtension is
    // undefined". If a nunjucks upgrade ever made slim ship nodes again, the
    // whole two-instance dance (and precompile.ts's dependency on the full
    // package) would be dead weight -- this test is where that would surface.
    const slimNodes = (nunjucksSlim as unknown as { nodes?: { CallExtension?: unknown } }).nodes;
    expect(slimNodes?.CallExtension).toBeUndefined();
    expect((nunjucks as unknown as { nodes: { CallExtension?: unknown } }).nodes.CallExtension).toBeTypeOf("function");
  });

  it("takes SafeString from any lib that has a runtime -- including the full package", () => {
    // The constructor discriminates on `"runtime" in lib`, and full nunjucks
    // has BOTH nodes and runtime. So precompile.ts's supposedly parse-only
    // instance also ends up holding a SafeString. Harmless (it never runs),
    // but it means the plain-string fallback below is unreachable in
    // production, and anyone reading the module comment as "the compile-time
    // instance has no SafeString" is reading it wrong.
    const fromFullPackage = new BlocktransExtension(nunjucks);
    expect(fromFullPackage.run(contextWith({}), "Hi")).toBeInstanceOf(nunjucks.runtime.SafeString);
  });

  it("wraps output in SafeString when built from the slim runtime", () => {
    const result = new BlocktransExtension(nunjucksSlim).run(contextWith({}), "Hi %(name)s", "name", "Wales");
    expect(result).toBeInstanceOf(nunjucksSlim.runtime.SafeString);
    expect(String(result)).toBe("Hi Wales");
  });

  it("returns a bare string when built from a lib with no runtime", () => {
    const result = new BlocktransExtension(parseOnlyLib).run(contextWith({}), "Hi %(name)s", "name", "Wales");
    expect(typeof result).toBe("string");
    expect(result).toBe("Hi Wales");
  });

  it("shows what the SafeString is actually buying: without it, autoescape eats the markup", () => {
    // Not a hypothetical. Every translated string in the catalogue with a
    // link in it -- `Part of <a href="...">...</a>` -- renders as visible
    // &lt;a href= source text the moment run() stops returning SafeString.
    const source = `{% blocktrans %}Part of{% endblocktrans %}`;
    const context = { _i18nCatalogue: { "Part of": '<a href="/x/">Rhan o</a>' } };

    expect(precompileThenRenderOnSlim(source, context).output).toBe('<a href="/x/">Rhan o</a>');
    expect(precompileThenRenderOnSlim(source, context, new BlocktransExtension(parseOnlyLib)).output).toBe(
      "&lt;a href=&quot;/x/&quot;&gt;Rhan o&lt;/a&gt;",
    );
  });
});

describe("parse(): the msgid it extracts", () => {
  it("turns a bound {{ name }} into gettext's %(name)s", () => {
    expect(msgidFor(`{% blocktrans with country=name %}Food banks in {{ country }}{% endblocktrans %}`, { name: "Wales" })).toBe(
      "Food banks in %(country)s",
    );
  });

  it("keeps several placeholders in source order, with the literal text between them", () => {
    expect(msgidFor(`{% blocktrans with a=x b=y %}A {{ a }} and {{ b }}!{% endblocktrans %}`, { x: 1, y: 2 })).toBe(
      "A %(a)s and %(b)s!",
    );
  });

  it("uses the bound name, not the expression it came from", () => {
    // `with foodbank_name=location.foodbank_name` -- the msgid must carry the
    // left-hand name, because that is what the translator saw. Emitting
    // `%(location.foodbank_name)s` would miss every catalogue entry.
    expect(msgidFor(`{% blocktrans with n=location.foodbank_name %}Hi {{ n }}{% endblocktrans %}`, { location: { foodbank_name: "B" } })).toBe(
      "Hi %(n)s",
    );
  });

  it("ignores whitespace inside the braces", () => {
    expect(msgidFor(`{% blocktrans with name=x %}Hi {{   name   }}!{% endblocktrans %}`, { x: 1 })).toBe("Hi %(name)s!");
  });

  it("repeats a placeholder as many times as the body does", () => {
    expect(msgidFor(`{% blocktrans with n=x %}{{ n }}/{{ n }}{% endblocktrans %}`, { x: 1 })).toBe("%(n)s/%(n)s");
  });

  it("drops {# comments #} without leaving a gap", () => {
    // Comments are lexer-level, so they never reach the body's node list.
    // Worth pinning: a comment inside a blocktrans that leaked into the msgid
    // would break the lookup for that string only.
    expect(msgidFor(`{% blocktrans %}Hi{# translators: greeting #} there{% endblocktrans %}`)).toBe("Hi there");
  });

  it("preserves newlines and indentation exactly -- there is no `trimmed`", () => {
    expect(msgidFor(`{% blocktrans %}\n  hello\n  world\n{% endblocktrans %}`)).toBe("\n  hello\n  world\n");
  });

  it("handles a tag with no `with` clause, and an empty `with` clause", () => {
    expect(msgidFor(`{% blocktrans %}Use my location{% endblocktrans %}`)).toBe("Use my location");
    // `with` followed straight by %} -- the loop breaks on the first
    // non-symbol token rather than failing, so this is accepted.
    expect(msgidFor(`{% blocktrans with %}Use my location{% endblocktrans %}`)).toBe("Use my location");
  });

  it("produces an empty msgid for an empty body, and does not resolve it to anything", () => {
    // parsePoFile drops the .po header entry (msgid ""), so an empty
    // blocktrans falls back to "" rather than rendering "Project-Id-Version:
    // ..." into the page. Cheap to assert, expensive to discover.
    expect(msgidFor(`{% blocktrans %}{% endblocktrans %}`)).toBe("");
    expect("" in CY).toBe(false);
    expect(render(`{% blocktrans %}{% endblocktrans %}`, { _i18nCatalogue: CY })).toBe("");
  });

  it("does NOT double a literal % the way Django does -- divergence", () => {
    // Django 6.1, run: the same tag looks up "100%% of %(a)s", because
    // BlockTranslateNode.render_token_list does contents.replace("%", "%%")
    // (templatetags/i18n.py:139) and makemessages doubles it identically when
    // extracting (utils/translation/template.py:151), so the .po msgid is
    // doubled too. This port looks up a single %.
    //
    // Nothing breaks today: no msgid in any of the three catalogues contains
    // "%%" (checked across cy, ga and gd). It breaks the first time a
    // translated string containing a literal % is added, and it breaks
    // silently -- the page just stays English. Reported, not fixed.
    expect(msgidFor(`{% blocktrans with a=x %}100% of {{ a }}{% endblocktrans %}`, { x: "q" })).toBe("100% of %(a)s");
    const doubledInEveryCatalogue = ["cy", "ga", "gd"].flatMap((locale) =>
      Object.keys(parsePoFile(readFileSync(join(LOCALE_DIR, locale, "django.po"), "utf8"))).filter((msgid) => msgid.includes("%%")),
    );
    expect(doubledInEveryCatalogue).toEqual([]);
  });
});

describe("parse(): what it refuses to compile", () => {
  // Every one of these aborts `pnpm precompile`, so they are loud, not
  // silent. They are pinned because the message and the reported line are
  // what a developer navigates to when a template stops building, and because
  // two of them reject template source that Django itself accepts.

  it("rejects a `with` binding that is missing its =", () => {
    expect(() => render(`{% blocktrans with a %}Hi{% endblocktrans %}`)).toThrow(/blocktrans: expected = after 'a'/);
  });

  it("rejects an unbound {{ var }} in the body -- Django allows it", () => {
    // Django 6.1, run: `{% blocktranslate %}Hi {{ who }}{% endblocktranslate %}`
    // with who="W" in the surrounding context renders "Hi W" and looks up
    // "Hi %(who)s". This port fails the build instead, which is stricter but
    // defensible: it cannot resolve the name at request time because the
    // compiled call only carries the `with` list. Porting a Django template
    // that relies on it needs a `with` clause adding.
    expect(() => render(`{% blocktrans %}Hi {{ who }}{% endblocktrans %}`, { who: "W" })).toThrow(
      /only literal text and bound \{\{ name \}\} references are allowed in the body \(found Symbol\)/,
    );
  });

  it("rejects a filter, a literal and a dotted lookup in the body", () => {
    // Django 6.1, run: a filter is not rejected there either -- it silently
    // extracts the nonsense msgid "Hi %(a|upper)s", which can never match a
    // catalogue. Failing the build is the better of the two.
    expect(() => render(`{% blocktrans with a=x %}Hi {{ a|upper }}{% endblocktrans %}`, { x: "y" })).toThrow(/\(found Filter\)/);
    expect(() => render(`{% blocktrans %}Hi {{ 42 }}{% endblocktrans %}`)).toThrow(/\(found Literal\)/);
    expect(() => render(`{% blocktrans with a=x %}Hi {{ a.b }}{% endblocktrans %}`, { x: { b: 1 } })).toThrow(/\(found LookupVal\)/);
  });

  it("rejects a block tag in the body, including a nested blocktrans", () => {
    expect(() => render(`{% blocktrans %}Hi {% if 1 %}y{% endif %}{% endblocktrans %}`)).toThrow(
      /blocktrans: unexpected node If in body/,
    );
    // The nested tag has already been turned into a CallExtension by the time
    // the body is walked, so it trips the outer-node check, not the inner one.
    expect(() => render(`{% blocktrans %}a {% blocktrans %}b{% endblocktrans %}{% endblocktrans %}`)).toThrow(
      /blocktrans: unexpected node CallExtension in body/,
    );
  });

  it("rejects Django's `trimmed` and `count` forms", () => {
    // Neither is used by any of the 28 Django templates that carry a
    // blocktrans, so nothing needed porting; this pins that adding one would
    // fail the build rather than compile into something subtly wrong. The
    // message comes from nunjucks' own advanceAfterBlockEnd, not from
    // parser.fail, because skipSymbol("with") simply returns false.
    expect(() => render(`{% blocktrans trimmed %}Hi{% endblocktrans %}`)).toThrow(/expected block end in blocktrans statement/);
    expect(() => render(`{% blocktrans count n=x %}one{% plural %}many{% endblocktrans %}`, { x: 2 })).toThrow(
      /expected block end in blocktrans statement/,
    );
  });

  it("reports the position of the blocktrans tag, not of the offending node", () => {
    // parser.fail is always passed tok.lineno/tok.colno -- the opening tag.
    // A build error pointing at line 2 when the bad {{ var }} is on line 4 is
    // confusing enough to be worth stating out loud.
    expect(() => render(`line one\n{% blocktrans %}ok\nstill ok\n{{ unbound }}{% endblocktrans %}`)).toThrow(/\[Line 2, Column 4\]/);
  });

  it("still requires the closing tag", () => {
    expect(() => render(`{% blocktrans %}Hi`)).toThrow(/unexpected end of file/);
  });
});

describe("run(): catalogue lookup", () => {
  const ext = new BlocktransExtension(nunjucksSlim);
  const run = (catalogue: unknown, msgid: string, ...rest: unknown[]): string =>
    String(ext.run(contextWith(catalogue), msgid, ...rest));

  // Real msgid/msgstr pairs out of locale/cy/django.po, so the fixtures are
  // strings this code genuinely handles rather than invented Welsh.
  it("returns the translation when the catalogue has the msgid", () => {
    expect(run(CY, "Use my location")).toBe("Defnyddio fy lleoliad");
  });

  it("falls back to the English msgid on a miss, rather than rendering nothing", () => {
    // A string added to a template but not yet to the .po -- must render as
    // English, not as an empty element.
    expect("Use my Location" in CY).toBe(false);
    expect(run(CY, "Use my Location")).toBe("Use my Location");
  });

  it("falls back to English for an untranslated (empty msgstr) entry", () => {
    // gettext's own convention for an entry nobody has translated yet, and
    // present in these .po files. `msgstr && msgstr.length > 0` is the guard.
    expect(run({ "Use my location": "" }, "Use my location")).toBe("Use my location");
  });

  it("survives a request with no catalogue in context at all", () => {
    // The `en` path: env.ts's loadCatalogue("en") returns {}, and any render
    // that forgets to set _i18nCatalogue lands on undefined. Either way this
    // must not throw, because it would throw on every English page.
    expect(run(undefined, "Use my location")).toBe("Use my location");
    expect(run(null, "Use my location")).toBe("Use my location");
    expect(run({}, "Use my location")).toBe("Use my location");
  });

  it("looks up the msgid, never the interpolated result", () => {
    // The catalogue is keyed on the pre-interpolation msgid. An entry keyed
    // on the finished English sentence must be ignored -- if it ever won,
    // translations would work only for the values that happened to be in the
    // catalogue when it was written.
    const catalogue = {
      "Food banks in %(country)s": "Banciau bwyd yn %(country)s",
      "Food banks in Wales": "MUST NOT BE USED",
    };
    expect(run(catalogue, "Food banks in %(country)s", "country", "Wales")).toBe("Banciau bwyd yn Wales");
  });

  it("does not trim or normalise the msgid before looking it up", () => {
    // Pins the absence of Django's `trimmed`: the multi-line about_us msgid
    // keeps its leading newline and indentation, and an entry keyed on the
    // trimmed text is not a match.
    expect(run({ hello: "MUST NOT BE USED" }, "\n  hello\n")).toBe("\n  hello\n");
  });
});

describe("run(): interpolation", () => {
  const ext = new BlocktransExtension(nunjucksSlim);
  const run = (catalogue: unknown, msgid: string, ...rest: unknown[]): string =>
    String(ext.run(contextWith(catalogue), msgid, ...rest));

  it("pairs the flat [name, value, name, value] rest args into variables", () => {
    // compileCallExtension passes tag args positionally, so the shape of
    // `rest` is a contract with nunjucks' code generator, not a choice.
    expect(run({}, "%(a)s-%(b)s-%(c)s", "a", "1", "b", "2", "c", "3")).toBe("1-2-3");
  });

  it("substitutes every occurrence of a placeholder, not just the first", () => {
    expect(run({}, "%(n)s/%(n)s", "n", "X")).toBe("X/X");
  });

  it("walks the rest list strictly two at a time -- a value is never read as a name", () => {
    // Written to kill a `i += 1` stride, which is otherwise invisible: it
    // still binds every real name correctly and only shows up when a value
    // happens to spell another variable's name. Here "country" arrives as
    // the value of `a`; a one-at-a-time loop would additionally bind it as a
    // name and fill %(country)s in with the next value along.
    expect(run({}, "%(a)s [%(country)s]", "a", "country", "b", "Wales")).toBe("country []");
  });

  it("substitutes into the translation, not into the English", () => {
    expect(run({ "Part of %(name)s": "Rhan o %(name)s" }, "Part of %(name)s", "name", "Borehamwood")).toBe("Rhan o Borehamwood");
  });

  it("drops a placeholder the tag never bound", () => {
    // The realistic cause is a translator adding a %(var)s the English string
    // does not have. Django catches the resulting KeyError and re-renders the
    // block with translation disabled, so the reader gets the whole English
    // sentence (templatetags/i18n.py:189-198 -- read, not run: forcing that
    // path needs a real compiled .mo). This port leaves a hole in the
    // translated sentence instead. Divergence, pinned not fixed.
    expect(run({}, "a %(zz)s b", "a", "X")).toBe("a  b");
  });

  it("only recognises %(name)s with [A-Za-z0-9_] names, case-sensitively", () => {
    // Everything else stays literal, which is what stops a stray % in a
    // translated sentence from eating the text after it.
    expect(run({}, "%(a-b)s %(a)d %()s %(A)s %(a)s", "a", "X", "A", "Y")).toBe("%(a-b)s %(a)d %()s Y X");
  });

  it("does not re-scan a substituted value for further placeholders", () => {
    // A food bank name is user-supplied data from the database. If it
    // contained "%(url)s" and the replacement were rescanned, that name could
    // pull another variable's value into the page.
    expect(run({}, "%(a)s %(b)s", "a", "%(b)s", "b", "SECRET")).toBe("%(b)s SECRET");
  });

  it("stringifies non-string values with String(), warts included", () => {
    expect(run({}, "%(a)s", "a", 12.5)).toBe("12.5");
    expect(run({}, "%(a)s", "a", [1, 2])).toBe("1,2");
    // Django 6.1, run: None renders as "None" and a `with` binding whose
    // expression resolves to nothing renders as "" (the engine's
    // string_if_invalid). This port writes the JS spellings into the page
    // instead, so a nullable column reaching a blocktrans variable puts the
    // literal word "undefined" in front of a reader. Divergence, pinned not
    // fixed -- see suspectedBugs.
    expect(run({}, "%(a)s", "a", null)).toBe("null");
    expect(run({}, "%(a)s", "a", undefined)).toBe("undefined");
  });

  it("tolerates a rest list with no values, and one with a trailing name", () => {
    // Not reachable from parse() -- it always emits name/expr pairs -- but
    // run() is a public method and must not throw on the odd shape.
    expect(run({}, "%(a)s")).toBe("");
    expect(run({}, "%(a)s|%(b)s", "a", "A", "b")).toBe("A|undefined");
  });

  it("keeps no state between calls on the shared instance", () => {
    // One extension instance serves every render in the isolate. If `vars`
    // were hoisted out of run(), a variable from one request would leak into
    // the next page -- the sort of bug that only shows under traffic.
    expect(run({}, "%(a)s|%(b)s", "a", "1", "b", "2")).toBe("1|2");
    expect(run({}, "%(a)s|%(b)s", "a", "9")).toBe("9|");
  });
});

describe("real templates against the real Welsh catalogue", () => {
  // Guard: everything below is vacuous if the catalogue failed to load.
  it("loaded locale/cy/django.po", () => {
    expect(Object.keys(CY).length).toBeGreaterThan(200);
    expect(CY["Use my location"]).toBe("Defnyddio fy lleoliad");
    expect(CY["Part of"]).toBe("Rhan o");
  });

  // Slices the {% blocktrans %}...{% endblocktrans %} block containing
  // `marker` out of a real template, so the test renders the shipped source
  // rather than a paraphrase of it. Rendering the whole template is not an
  // option -- these extend page.njk and want a full request context.
  function blocktransBlockContaining(relativePath: string, marker: string): string {
    const source = readFileSync(join(TEMPLATES_DIR, relativePath), "utf8");
    const at = source.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const start = source.lastIndexOf("{% blocktrans", at);
    const end = source.indexOf("{% endblocktrans %}", at) + "{% endblocktrans %}".length;
    const block = source.slice(start, end);
    expect(block.startsWith("{% blocktrans")).toBe(true);
    return block;
  }

  it("wfbn/constituency/constituency.njk's `Part of <a ...>` matches its .po entry byte for byte", () => {
    // This is the parity check the whole extension exists to pass: the msgid
    // built from the template must equal the msgid xgettext put in the .po.
    // Django 6.1, run on the equivalent source, extracts the identical
    // string.
    const block = blocktransBlockContaining("wfbn/constituency/constituency.njk", "Part of <a");
    const context = { foodbank: { foodbank_name_slug: "borehamwood", foodbank_name: "Borehamwood & Elstree" } };

    expect(msgidFor(block, context)).toBe('Part of <a href="/needs/at/%(foodbank_slug)s/">%(foodbank_name)s</a>');
    expect(CY['Part of <a href="/needs/at/%(foodbank_slug)s/">%(foodbank_name)s</a>']).toBe(
      'Rhan o <a href="/needs/at/%(foodbank_slug)s/">%(foodbank_name)s</a>',
    );
    expect(render(block, { ...context, _i18nCatalogue: CY })).toBe(
      'Rhan o <a href="/needs/at/borehamwood/">Borehamwood & Elstree</a>',
    );
  });

  it("public/about_us.njk's multi-line block matches its .po entry, whitespace and all", () => {
    // 2.2KB of HTML across a dozen lines, whose msgid begins with a newline
    // and eight spaces of indentation. It is the single entry in these
    // catalogues with a newline in the key, and the one most likely to stop
    // matching if msgid extraction ever grew a trim() -- at which point the
    // Welsh, Irish and Gaelic About pages would quietly revert to English.
    const block = blocktransBlockContaining("public/about_us.njk", "Give Food is a UK charity");
    const msgid = msgidFor(block);

    expect(msgid.startsWith("\n                <p>Give Food is a UK charity")).toBe(true);
    expect(msgid.endsWith("</p>\n\n            ")).toBe(true);
    expect(Object.keys(CY)).toContain(msgid);

    const rendered = render(block, { _i18nCatalogue: CY });
    expect(rendered).toBe(CY[msgid]);
    expect(rendered).toContain("Mae Give Food yn elusen yn y DU");
    expect(rendered).not.toContain("Give Food is a UK charity");
  });

  it("falls back to the English source text when the locale has no entry", () => {
    // The three catalogues do not cover identical sets of strings, and `en`
    // has no catalogue at all, so the fallback carries most of the site. A
    // 2.2KB block that vanished on a miss would be a blank About page.
    const block = blocktransBlockContaining("public/about_us.njk", "Give Food is a UK charity");
    expect(render(block, { _i18nCatalogue: {} })).toContain("Give Food is a UK charity");
  });
});

describe("the precompile.ts -> env.ts round trip", () => {
  const source = readFileSync(join(TEMPLATES_DIR, "wfbn/constituency/constituency.njk"), "utf8");
  const at = source.indexOf("Part of <a");
  const block = source.slice(source.lastIndexOf("{% blocktrans", at), source.indexOf("{% endblocktrans %}", at) + "{% endblocktrans %}".length);
  const context = {
    foodbank: { foodbank_name_slug: "borehamwood", foodbank_name: "Borehamwood & Elstree" },
    _i18nCatalogue: CY,
  };

  it("bakes the msgid into the compiled template as a constant", () => {
    // The msgid is resolved at build time and shipped inside the precompiled
    // function -- the Worker never sees the template source. If parse() ever
    // deferred msgid construction to request time, this is where it would
    // show, because the string would no longer be in the emitted code.
    const { emitted } = precompileThenRenderOnSlim(block, context);
    expect(emitted).toContain('env.getExtension("blocktrans")["run"](context,');
    expect(emitted).toContain('Part of <a href=\\"/needs/at/%(foodbank_slug)s/\\">%(foodbank_name)s</a>');
  });

  it("renders Welsh when the full package parsed it and the slim runtime ran it", () => {
    // Two different instances of this class, in two different nunjucks
    // builds, joined only by the extension name "blocktrans". This is the
    // arrangement the module comment describes, and the one that breaks
    // wholesale (every translated page 500s with "Unable to call ... run")
    // if env.ts's registration name and the compiled lookup ever drift apart.
    expect(precompileThenRenderOnSlim(block, context).output).toBe(
      'Rhan o <a href="/needs/at/borehamwood/">Borehamwood & Elstree</a>',
    );
  });

  it("does NOT escape interpolated values -- divergence from Django, and a live XSS hole", () => {
    // Django 6.1, run: the same tag with name="Borehamwood & Elstree" renders
    // "Borehamwood &amp; Elstree", and with name="<b>x</b>" renders
    // "&lt;b&gt;x&lt;/b&gt;", because BlockTranslateNode calls
    // render_value_in_context on each value (template/base.py:1139) which
    // conditional_escape()s it under autoescape.
    //
    // This port interpolates the raw value into an already-SafeString result,
    // so it is emitted verbatim. The values here are food bank names and URLs
    // straight out of D1. Asserting what the code does, per the rules --
    // reported in suspectedBugs, not fixed here.
    const dangerous = {
      foodbank: { foodbank_name_slug: "x", foodbank_name: '<script>alert(1)</script> & "quoted"' },
      _i18nCatalogue: CY,
    };
    expect(precompileThenRenderOnSlim(block, dangerous).output).toBe(
      'Rhan o <a href="/needs/at/x/"><script>alert(1)</script> & "quoted"</a>',
    );
  });

  it("renders the same output when the same template is rendered twice", () => {
    // Cheap idempotence check: the extension holds no per-render state, so a
    // second render of the same precompiled template must be identical.
    const first = precompileThenRenderOnSlim(block, context).output;
    const second = precompileThenRenderOnSlim(block, context).output;
    expect(second).toBe(first);
  });
});
