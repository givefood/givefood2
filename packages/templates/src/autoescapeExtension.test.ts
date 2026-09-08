import nunjucks, { type Environment } from "nunjucks";
import nunjucksSlim from "nunjucks/browser/nunjucks-slim.js";
import { describe, expect, it } from "vitest";
import { AutoescapeExtension } from "./autoescapeExtension";
import { render } from "./env";

// autoescapeExtension.ts -- its ONE export, `AutoescapeExtension`, covering
// all three of its members: `tags`, `parse()` (compile time, full nunjucks)
// and `run()` (request time, nunjucks-slim).
//
// WHY THIS FILE EXISTS. This extension is the only thing standing between
// 14 templates and corrupted output, and every way it can break is silent:
//
//   * IT IS THE WHOLE /md/ MIRROR AND BOTH TEXT EMAILS. All 14 uses are
//     `{% autoescape false %}` (grep: 13 plain plus order_text.njk's
//     whitespace-controlled `{%- autoescape false -%}`; not one `true`).
//     Those are markdown and text/plain documents, where escaping is not a
//     safety net but active corruption -- "Tea & Toast Foodbank" ships as
//     "Tea &amp; Toast Foodbank" to the LLMs and scrapers that read /md/,
//     and into a subscriber's plain-text need-notification email. Nothing
//     500s, nothing logs, the status code stays 200.
//
//   * THE FLAG IT TOGGLES IS SHARED PROCESS STATE. `run()` mutates the
//     Environment's own `opts.autoescape` and restores it in a `finally`.
//     The Environment is built once per isolate (env.ts's cachedEnv) and
//     reused for every request that isolate ever serves, so a restore that
//     is skipped -- on a throw, or on a nested block -- does not spoil one
//     page, it spoils every page rendered afterwards by that isolate.
//
//   * THE SafeString WRAP IS LOAD-BEARING AND CROSS-LIBRARY. nunjucks'
//     `suppressValue` re-escapes anything that is not `instanceof
//     SafeString`, and the full package's SafeString is a DIFFERENT class
//     from nunjucks-slim's (asserted below). That is why env.ts constructs
//     a second instance from the slim lib instead of sharing precompile.ts's
//     -- "simplify" that to one instance and every /md/ page is escaped
//     again, which is exactly the bug this whole extension exists to avoid.
//
// So the tests below use the REAL nunjucks (both builds) throughout: the
// real parser for `parse()`, the real code generator, the real slim runtime
// loading a real precompiled template, and one pass through the shipping
// `render()` itself. Nothing here hand-builds an AST or a fake environment
// where a real one was available.
//
// PARITY. Django's `{% autoescape on|off %}` (django/template/defaulttags.py)
// is the thing being ported; the Django-side behaviour quoted in comments
// below was produced by running Django 5.2.6 out of
// /Users/jasoncartwright/Sites/foodcharity on this machine, not recalled.
//
// MUTATION-TESTED. The repo was copied outside itself and the module broken
// 13 ways -- SafeString wrap dropped, constructor's runtime capture dropped,
// restore moved out of the `finally`, restore hard-coded to `true`, `prev`
// captured after the flip instead of before, `Boolean()` coercion removed,
// the body dropped as a content arg, the value expression dropped from the
// args, `parseExpression()` swapped for `nextToken()`, either
// `advanceAfterBlockEnd` call weakened or removed, `renderBody()` called
// twice, and the tag renamed. All 13 were caught. Two of them are caught by
// a single test each, so neither the throw test nor the call-count test is
// decoration: delete one and a real mutant lives.

// A value that is wrong in both directions if escaping goes the wrong way:
// the `&` and the `<b>` both change under nunjucks' escape, so a test can
// assert the raw form is present AND the escaped form is absent.
const RISKY = "Tea & <b>Coffee</b>";
const RISKY_ESCAPED = "Tea &amp; &lt;b&gt;Coffee&lt;/b&gt;";

// The constructor's parameter union (`NunjucksLibForParse | NunjucksLibForRun`)
// is deliberately not exported -- rule 6 says don't export a symbol just to
// reach it, so name it through the class instead.
type NunjucksLibArg = ConstructorParameters<typeof AutoescapeExtension>[0];

// `nodes`/`parser` are undocumented nunjucks internals with no entry in
// @types/nunjucks (only `runtime` is typed), which is the same reason
// autoescapeExtension.ts declares its own `Ae*` shapes instead of importing
// them. These are the minimal shapes this file touches, checked against the
// installed nunjucks@3.2.4 source.
interface AstNode {
  typename: string;
  value?: unknown;
  prop?: string;
  children?: AstNode[];
  args?: AstNode;
  contentArgs?: AstNode[];
}
interface ParserModule {
  parse(src: string, extensions: unknown[], opts: Record<string, unknown>): AstNode;
}
const fullInternals = nunjucks as unknown as { nodes: unknown; parser: ParserModule };

// A lib that satisfies ONLY the parse half of the constructor union -- no
// `runtime`, so `safeString` stays undefined. precompile.ts and env.ts both
// happen to pass a lib that has both halves, so this is the only way to
// exercise (and to prove the cost of) the `this.safeString ? ... : ...`
// fallback in `run()`.
const parseOnlyLib = { nodes: fullInternals.nodes } as unknown as NunjucksLibArg;

function fullEnv(autoescape = true, lib: NunjucksLibArg = nunjucks): Environment {
  const env = new nunjucks.Environment(null, { autoescape, throwOnUndefined: false });
  env.addExtension("autoescape", new AutoescapeExtension(lib));
  return env;
}

// The production build pipeline in miniature: nunjucks.precompileString()
// runs `parse()` through the FULL parser and code generator (exactly what
// scripts/precompile.ts does to templates/**/*.njk), and the resulting
// function source is what ships. The wrapper cast mirrors precompile.ts's
// own -- @types/nunjucks types `wrapper` as taking a single template rather
// than the array nunjucks actually passes.
function precompiledSource(source: string, env: Environment): string {
  let body = "";
  const capture = (templates: Array<{ name: string; template: string }>): string => {
    body = templates[0]!.template;
    return "";
  };
  nunjucks.precompileString(source, {
    name: "fixture.njk",
    env,
    wrapper: capture as unknown as (templates: { name: string; template: string }, opts: unknown) => string,
  });
  return body;
}

// ...and the other half: eval the generated source into the plain object
// PrecompiledLoader expects. `new Function` is banned on Workers, which is
// precisely why precompiling happens in Node -- doing it here in Node is the
// same step, not a shortcut around one.
function precompileToTemplate(source: string, env: Environment): unknown {
  return new Function(precompiledSource(source, env))();
}

// The shipping shape from env.ts: nunjucks-slim (no compiler) rendering a
// precompiled template, with a SECOND AutoescapeExtension instance built
// from the slim lib.
function renderPrecompiled(
  source: string,
  context: Record<string, unknown>,
  opts: { runtimeLib?: NunjucksLibArg; autoescape?: boolean; registerAs?: string } = {},
): string {
  const compiled = precompileToTemplate(source, fullEnv(opts.autoescape ?? true));
  const env = new nunjucksSlim.Environment(new nunjucksSlim.PrecompiledLoader({ "fixture.njk": compiled }), {
    autoescape: opts.autoescape ?? true,
    throwOnUndefined: false,
  });
  env.addExtension(opts.registerAs ?? "autoescape", new AutoescapeExtension(opts.runtimeLib ?? nunjucksSlim));
  return env.render("fixture.njk", context);
}

describe("AutoescapeExtension", () => {
  describe("tags", () => {
    it("claims exactly the 'autoescape' keyword", () => {
      // The literal string here is the tag every template spells out. A typo
      // or a rename does not fail loudly -- nunjucks just stops recognising
      // `{% autoescape %}` and reports it as an unknown block tag at BUILD
      // time, which is at least visible; what is not visible is the opposite
      // mistake of adding a second tag name nobody registered.
      expect(new AutoescapeExtension(nunjucks).tags).toEqual(["autoescape"]);
    });

    it("is the only reason `{% autoescape %}` parses at all", () => {
      // The module's opening claim -- "Nunjucks core has no `{% autoescape %}`
      // block tag" -- restated as a test. If a future nunjucks upgrade ships
      // its own autoescape tag, this test fails and someone gets to decide
      // which implementation wins, rather than finding out from silently
      // different output.
      const bare = new nunjucks.Environment(null, { autoescape: true });
      expect(() => bare.renderString(`{% autoescape false %}{{ x }}{% endautoescape %}`, { x: RISKY })).toThrow(
        /unknown block tag: autoescape/,
      );
    });
  });

  describe("parse() -- compile time, real nunjucks parser", () => {
    it("emits a CallExtension whose prop is 'run', with the value as an arg and the body as a content arg", () => {
      // Read straight off the real AST rather than through rendered output,
      // because the arg/contentArg split is the whole contract with nunjucks'
      // code generator: an arg is evaluated eagerly, a content arg becomes a
      // deferred closure. Swap them and the body renders BEFORE run() flips
      // the flag -- output that is escaped despite the tag, with no error.
      const ast = fullInternals.parser.parse(
        `{% autoescape false %}hi{% endautoescape %}`,
        [new AutoescapeExtension(nunjucks)],
        {},
      );
      const call = ast.children?.[0];
      expect(call?.typename).toBe("CallExtension");
      expect(call?.prop).toBe("run");
      // NodeList[Literal false] -- one arg, the parsed value expression.
      expect(call?.args?.typename).toBe("NodeList");
      expect(call?.args?.children?.map((c) => c.typename)).toEqual(["Literal"]);
      expect(call?.args?.children?.[0]?.value).toBe(false);
      // Exactly one content arg, holding the body's own nodes.
      expect(call?.contentArgs?.length).toBe(1);
      expect(call?.contentArgs?.[0]?.children?.[0]?.typename).toBe("Output");
    });

    it("bakes the registered extension NAME into the generated code", () => {
      // This is why blocktransExtension.ts's module comment insists both
      // lifecycles register under the same name, and why this extension does
      // too. precompile.ts's Environment name is compiled into the shipped
      // template as a literal `env.getExtension("autoescape")` lookup; env.ts
      // must answer to that exact string months later, from a different
      // library build. Renaming either side alone is a runtime crash on 14
      // templates, discovered in production.
      const generated = precompiledSource(`{% autoescape false %}{{ x }}{% endautoescape %}`, fullEnv());
      expect(generated).toContain(`env.getExtension("autoescape")["run"](context,false,function(cb)`);
    });

    it("throws at build time when the argument is missing", () => {
      // Django raises TemplateSyntaxError "'autoescape' tag requires exactly
      // one argument" (run against Django 5.2.6 in
      // /Users/jasoncartwright/Sites/foodcharity). The port gets there by a
      // different route -- parseExpression() simply finds no expression --
      // but the important half matches: it fails at COMPILE time, so a
      // malformed tag breaks `pnpm precompile` rather than one live page.
      expect(() => precompiledSource(`{% autoescape %}{{ x }}{% endautoescape %}`, fullEnv())).toThrow(
        /unexpected token: %\}/,
      );
    });

    it("throws at build time when {% endautoescape %} is missing", () => {
      // parseUntilBlocks("endautoescape") running off the end of the file.
      // Same reasoning: a template with an unclosed block must never reach a
      // deploy, because the failure at request time is a 500 on that page.
      expect(() => precompiledSource(`{% autoescape false %}{{ x }}`, fullEnv())).toThrow(/unexpected end of file/);
    });

    it("accepts any expression, not just a boolean literal", () => {
      // parseExpression(), not nextToken() -- so a context variable or a
      // comparison works. No shipped template uses this, but a test that only
      // ever passed `false` would let someone "simplify" parse() down to
      // reading a single literal token and never notice.
      expect(fullEnv().renderString(`{% autoescape flag %}{{ x }}{% endautoescape %}`, { x: RISKY, flag: false })).toBe(
        RISKY,
      );
      expect(fullEnv().renderString(`{% autoescape flag %}{{ x }}{% endautoescape %}`, { x: RISKY, flag: true })).toBe(
        RISKY_ESCAPED,
      );
      expect(fullEnv().renderString(`{% autoescape 1 == 2 %}{{ x }}{% endautoescape %}`, { x: RISKY })).toBe(RISKY);
    });

    it("honours whitespace control on both the open and close tags", () => {
      // admin/emails/order_text.njk writes `{%- autoescape false -%}` ...
      // `{%- endautoescape -%}`, and it is a text/plain email where a stray
      // leading newline is visible to the recipient. This works only because
      // parse() hands the trimming back to nunjucks via
      // advanceAfterBlockEnd() instead of consuming tokens itself.
      const out = fullEnv().renderString(`A\n{%- autoescape false -%}\n  B{{ x }}\n{%- endautoescape -%}\nC`, {
        x: "&",
      });
      expect(out).toBe("AB&C");
    });
  });

  describe("run() -- request time, called directly", () => {
    it("flips the flag for the body and restores the previous value", () => {
      const ext = new AutoescapeExtension(nunjucksSlim);
      const env = { opts: { autoescape: true } };
      let duringBody: boolean | null = null;
      const out = ext.run({ env }, false, () => {
        duringBody = env.opts.autoescape;
        return "body";
      });
      expect(duringBody).toBe(false);
      expect(env.opts.autoescape).toBe(true);
      expect(String(out)).toBe("body");
    });

    it("restores the PREVIOUS value, not a hard-coded true", () => {
      // The nesting case in miniature. A `finally` that assigned `true`
      // instead of `prev` passes every single-block test and only shows up
      // where one autoescape block sits inside another -- or inside an
      // Environment built with autoescape: false.
      const ext = new AutoescapeExtension(nunjucksSlim);
      const env = { opts: { autoescape: false } };
      ext.run({ env }, true, () => "body");
      expect(env.opts.autoescape).toBe(false);
    });

    it("restores the flag and rethrows when the body throws", () => {
      // The isolate-poisoning case. env.ts caches one Environment for the
      // life of the isolate, so if a filter throws inside an autoescape block
      // and the flag is left off, EVERY subsequent page that isolate renders
      // loses its escaping -- an XSS hole opened by an unrelated template
      // error. The `finally` is the only thing preventing it.
      const ext = new AutoescapeExtension(nunjucksSlim);
      const env = { opts: { autoescape: true } };
      const boom = new Error("filter blew up");
      expect(() =>
        ext.run({ env }, false, () => {
          throw boom;
        }),
      ).toThrow(boom);
      expect(env.opts.autoescape).toBe(true);
    });

    it("calls renderBody exactly once, with no arguments", () => {
      // Once, because nunjucks' content-arg closure appends to a buffer --
      // calling it twice duplicates the entire block's output. No arguments,
      // because the generated closure is `function(cb) { if (!cb) { ... } }`
      // and takes its synchronous path only when cb is undefined.
      const ext = new AutoescapeExtension(nunjucksSlim);
      const env = { opts: { autoescape: true } };
      const calls: number[] = [];
      ext.run({ env }, false, (...args: unknown[]) => {
        calls.push(args.length);
        return "once";
      });
      expect(calls).toEqual([0]);
    });

    it.each([
      // The annotation says `boolean`, but the value arrives from a template
      // expression and TypeScript is not there at render time -- `Boolean()`
      // in run() is what actually decides. These are the coercions that
      // matter, including the two that read as "on"/"off" to a human and
      // mean the opposite.
      ["false", false, false],
      ["true", true, true],
      ["0", 0, false],
      ["empty string", "", false],
      ["the string 'no'", "no", true],
      ["undefined (an unresolved template symbol)", undefined, false],
      ["null", null, false],
    ])("coerces %s with Boolean()", (_label, value, expected) => {
      const ext = new AutoescapeExtension(nunjucksSlim);
      const env = { opts: { autoescape: !expected } };
      let duringBody: boolean | null = null;
      ext.run({ env }, value as unknown as boolean, () => {
        duringBody = env.opts.autoescape;
        return "";
      });
      expect(duringBody).toBe(expected);
    });

    it("returns a slim SafeString when constructed from a lib that has runtime", () => {
      // Identity, not just "an object": suppressValue tests `instanceof
      // SafeString` against the class of the library doing the rendering.
      const out = new AutoescapeExtension(nunjucksSlim).run({ env: { opts: { autoescape: true } } }, false, () => "b");
      expect(out).toBeInstanceOf(nunjucksSlim.runtime.SafeString);
      expect(String(out)).toBe("b");
    });

    it("returns a bare string when constructed from a parse-only lib", () => {
      // The `this.safeString ? ... : ...` fallback. Harmless-looking, and the
      // next test shows what it actually costs.
      const out = new AutoescapeExtension(parseOnlyLib).run({ env: { opts: { autoescape: true } } }, false, () => "b");
      expect(out).toBe("b");
      expect(typeof out).toBe("string");
    });
  });

  describe("end to end through the real nunjucks Environment", () => {
    it("turns escaping off inside the block and back on outside it", () => {
      // Django 5.2.6, run on this machine, renders
      // `{% autoescape off %}{{ x }}{% endautoescape %}|{{ x }}` as
      // 'Tea & <b>Coffee</b>|Tea &amp; &lt;b&gt;Coffee&lt;/b&gt;'. Identical.
      expect(fullEnv().renderString(`{% autoescape false %}{{ x }}{% endautoescape %}|{{ x }}`, { x: RISKY })).toBe(
        `${RISKY}|${RISKY_ESCAPED}`,
      );
    });

    it("nests, restoring each block to its enclosing block's value", () => {
      // Django 5.2.6 on the equivalent source
      // (`{% autoescape off %}A{{x}}{% autoescape on %}B{{x}}{% endautoescape %}C{{x}}{% endautoescape %}`)
      // renders 'ATea & <b>Coffee</b>BTea &amp; ...C Tea & <b>Coffee</b>' --
      // the "C" segment goes back to OFF, not to the Environment default.
      // Same here, and that is the `prev` variable earning its keep.
      const out = fullEnv().renderString(
        `{% autoescape false %}A{{ x }}{% autoescape true %}B{{ x }}{% endautoescape %}C{{ x }}{% endautoescape %}`,
        { x: RISKY },
      );
      expect(out).toBe(`A${RISKY}B${RISKY_ESCAPED}C${RISKY}`);
    });

    it("turns escaping ON inside an Environment built with autoescape: false", () => {
      // The direction no shipped template uses, and therefore the one a
      // careless rewrite ("just set opts.autoescape = false") would break
      // without any template noticing.
      const out = fullEnv(false).renderString(`{% autoescape true %}{{ x }}{% endautoescape %}|{{ x }}`, { x: RISKY });
      expect(out).toBe(`${RISKY_ESCAPED}|${RISKY}`);
    });

    it("SUSPECT: `{% autoescape on %}` disables escaping -- the opposite of Django", () => {
      // PINNED, NOT ENDORSED. Django's tag takes the literal words `on` and
      // `off` and rejects anything else ("'autoescape' argument should be
      // 'on' or 'off'" -- TemplateSyntaxError, Django 5.2.6, run here). This
      // port takes an expression, so `on` and `off` both parse as bare
      // symbols that resolve to undefined, and Boolean(undefined) is false:
      //   {% autoescape off %} -> escaping off  (accidentally correct)
      //   {% autoescape on  %} -> escaping off  (silently backwards)
      // Nothing is broken today -- all 14 uses in packages/templates/templates
      // spell it `false` -- but a maintainer copying a line out of the Django
      // originals in /Users/jasoncartwright/Sites/foodcharity (which all say
      // `off`) gets working code, which makes `on` look equally safe. It is
      // not: it would ship unescaped HTML into an autoescaped page. Reported
      // in suspectedBugs.
      expect(fullEnv().renderString(`{% autoescape off %}{{ x }}{% endautoescape %}`, { x: RISKY })).toBe(RISKY);
      expect(fullEnv().renderString(`{% autoescape on %}{{ x }}{% endautoescape %}`, { x: RISKY })).toBe(RISKY);
    });

    it("SafeString is what stops the block's output being re-escaped on the way out", () => {
      // The mutant this kills: delete the SafeString wrap (or the constructor
      // branch that captures it) and `run()` returns a plain string, which
      // the CallExtension's own suppressValue -- running AFTER the finally has
      // restored autoescape -- escapes wholesale. Every /md/ page and both
      // text emails would ship escaped, and every other test in this file
      // that renders through a full Environment would still pass, because
      // they assert the flag's effect rather than the return value's type.
      const withSafeString = fullEnv().renderString(`{% autoescape false %}{{ x }}{% endautoescape %}`, { x: RISKY });
      const withoutSafeString = fullEnv(true, parseOnlyLib).renderString(
        `{% autoescape false %}{{ x }}{% endautoescape %}`,
        { x: RISKY },
      );
      expect(withSafeString).toBe(RISKY);
      expect(withoutSafeString).toBe(RISKY_ESCAPED);
    });

    it("escapes with nunjucks' table, not Django's, when the flag is on", () => {
      // Pinned because it is a real divergence and the reason these templates
      // turn escaping off rather than relying on it. Django 5.2.6 renders
      // `a&b<c>d"e'f` as a&amp;b&lt;c&gt;d&quot;e&#x27;f; nunjucks 3.2.4
      // renders the apostrophe as &#39; instead. Both figures were produced
      // by running the two engines here, not recalled. Identical inside the
      // block, where neither escapes anything -- which is the point.
      const raw = `a&b<c>d"e'f`;
      expect(fullEnv().renderString(`{{ x }}`, { x: raw })).toBe(`a&amp;b&lt;c&gt;d&quot;e&#39;f`);
      expect(fullEnv().renderString(`{% autoescape false %}{{ x }}{% endautoescape %}`, { x: raw })).toBe(raw);
    });
  });

  describe("the dual lifecycle: compiled by nunjucks, rendered by nunjucks-slim", () => {
    it("nunjucks-slim really does ship no usable nodes module", () => {
      // The premise of the whole two-instance design, asserted rather than
      // assumed (blocktransExtension.ts's comment says it was verified
      // empirically; this keeps it verified). If a future slim build starts
      // shipping the AST nodes, the two-lifecycle dance could be collapsed --
      // but only deliberately, after this test fails and says so.
      const slimInternals = nunjucksSlim as unknown as { nodes?: Record<string, unknown> };
      expect(slimInternals.nodes?.["CallExtension"]).toBeUndefined();
      expect((fullInternals.nodes as Record<string, unknown>)["CallExtension"]).toBeTypeOf("function");
    });

    it("a precompiled template renders correctly under the slim runtime", () => {
      // The actual production path, end to end: parse() ran in the full
      // parser at build time, run() runs in the slim runtime at request
      // time, and the only thing joining them is the generated
      // `env.getExtension("autoescape")` call.
      const out = renderPrecompiled(`{% autoescape false %}{{ x }}{% endautoescape %}|{{ x }}`, { x: RISKY });
      expect(out).toBe(`${RISKY}|${RISKY_ESCAPED}`);
    });

    it("nesting survives precompilation too", () => {
      const out = renderPrecompiled(
        `{% autoescape false %}A{{ x }}{% autoescape true %}B{{ x }}{% endautoescape %}C{{ x }}{% endautoescape %}|{{ x }}`,
        { x: "&" },
      );
      expect(out).toBe("A&B&amp;C&|&amp;");
    });

    it("the full package's SafeString is NOT the slim runtime's", () => {
      // The trap underneath env.ts:59. These are two separate class objects
      // from two separate builds, so `instanceof` across them is false.
      const fullSafe = new nunjucks.runtime.SafeString("x");
      expect(fullSafe).not.toBeInstanceOf(nunjucksSlim.runtime.SafeString);
    });

    it("registering precompile.ts's full-lib instance on the slim Environment escapes everything", () => {
      // Which is what makes the previous test matter, and why env.ts builds
      // `new AutoescapeExtension(nunjucksSlim)` rather than importing the one
      // scripts/precompile.ts already made. The full lib's SafeString fails
      // slim's `instanceof` check, so slim's suppressValue escapes the block's
      // output as if the tag were not there. No error, no log, just 14
      // templates quietly corrupted -- the single most plausible "cleanup"
      // regression this file can catch.
      const shipping = renderPrecompiled(`{% autoescape false %}{{ x }}{% endautoescape %}`, { x: RISKY });
      const crossLib = renderPrecompiled(`{% autoescape false %}{{ x }}{% endautoescape %}`, { x: RISKY }, {
        runtimeLib: nunjucks,
      });
      expect(shipping).toBe(RISKY);
      expect(crossLib).toBe(RISKY_ESCAPED);
    });

    it("a mismatched registration name is a hard render error, not a silent one", () => {
      // The one failure mode in this file that IS loud. Worth pinning because
      // it establishes the other direction of the name contract: get the name
      // wrong and every affected page 500s immediately, so nobody has to
      // wonder whether a rename half-landed.
      expect(() =>
        renderPrecompiled(`{% autoescape false %}{{ x }}{% endautoescape %}`, { x: RISKY }, {
          registerAs: "autoescape2",
        }),
      ).toThrow();
    });
  });

  describe("through the shipping render()", () => {
    it("keeps an ampersand raw in a real {% autoescape false %} markdown template", async () => {
      // Everything above builds its own Environment. This one goes through
      // env.ts's cached Environment, its registration of this extension, and
      // the real precompiled wfbn/foodbank/md/news.njk -- the same object
      // graph a request for /md/needs/at/<slug>/news/ uses. It is the only
      // test here that would fail if env.ts stopped registering the extension
      // at all, and the assertion is deliberately about the VALUE surviving
      // rather than the exact document, so an edit to the template's layout
      // does not make this file someone else's problem.
      const out = await renderNews();
      expect(out).toContain("# News - Tea & <b>Toast</b> Foodbank");
      expect(out).toContain("[Beans & Bread](https://example.org/?a=1&b=2)");
      expect(out).not.toContain("&amp;");
      expect(out).not.toContain("&lt;");
    });
  });
});

// Separated out only so the `it` above reads as one assertion block; the
// context mirrors what routes/wfbn/md/news.ts passes (a Django-shaped
// "YYYY-MM-DD HH:MM:SS.ffffff" timestamp string, which is what |date expects).
async function renderNews(): Promise<string> {
  return render("wfbn/foodbank/md/news.njk", {
    full_name: "Tea & <b>Toast</b> Foodbank",
    articles: [
      {
        title_captialised: "Beans & Bread",
        url: "https://example.org/?a=1&b=2",
        published_date: "2026-01-02 03:04:05.000000",
      },
    ],
  });
}
