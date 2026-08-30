// Nunjucks has no equivalent of Django's `{% blocktrans %}`, and PLAN.md
// §10.2.4's WP 3.2 calls for a real tag extension (not a manual per-call
// rewrite at every template) so the existing .po catalogues' msgids --
// literal text with `{{ var }}` spans replaced by `%(var)s`, exactly
// gettext's own xgettext extraction format -- keep working unmodified.
//
// One class, two lives: `.parse()` needs the FULL nunjucks package's
// parser/AST (nunjucks-slim strips both to nothing -- verified empirically,
// `nunjucks-slim.nodes.CallExtension` is undefined) and only ever runs at
// build time, inside scripts/precompile.ts. `.run()` needs only
// `runtime.SafeString`, which nunjucks-slim does still ship, and only ever
// runs at request time, inside env.ts. Two instances of this same class get
// constructed -- one per lib -- registered under the same extension name so
// the code precompile.ts's Environment emits (`env.getExtension("blocktrans")
// ["run"](...)`) finds a real "run" method on whichever Environment
// actually executes it.
//
// The nunjucks parser/nodes/runtime modules have no public TS types (they
// are undocumented internals, not part of nunjucks' typed surface even in
// the full package) -- these are the minimal shapes this file actually
// touches, verified against the installed nunjucks@3.2.4 source directly.
interface PoNode {
  typename: string;
}
interface PoOutputNode extends PoNode {
  typename: "Output";
  children: PoNode[];
}
interface PoTemplateDataNode extends PoNode {
  typename: "TemplateData";
  value: string;
}
interface PoSymbolNode extends PoNode {
  typename: "Symbol";
  value: string;
}
interface PoToken {
  type: string;
  value: string;
  lineno: number;
  colno: number;
}
interface PoNodeList {
  children: PoNode[];
  addChild(node: PoNode): void;
}
interface PoNodesModule {
  Output: new (...args: never[]) => PoOutputNode;
  TemplateData: new (...args: never[]) => PoTemplateDataNode;
  Symbol: new (...args: never[]) => PoSymbolNode;
  NodeList: new (lineno: number, colno: number, children: PoNode[]) => PoNodeList;
  Literal: new (lineno: number, colno: number, value: unknown) => PoNode;
  CallExtension: new (ext: unknown, prop: string, args: PoNodeList, contentArgs: unknown[]) => PoNode;
}
interface PoParser {
  nextToken(): PoToken;
  peekToken(): PoToken;
  skipSymbol(name: string): boolean;
  skipValue(type: string, value: string): boolean;
  parseExpression(): PoNode;
  parseUntilBlocks(...blockNames: string[]): PoNodeList;
  advanceAfterBlockEnd(name?: string): PoToken;
  fail(msg: string, lineno?: number, colno?: number): never;
}
interface PoRuntimeContext {
  lookup(name: string): unknown;
}
interface NunjucksLibForParse {
  nodes: PoNodesModule;
}
interface NunjucksLibForRun {
  runtime: { SafeString: new (value: string) => unknown };
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/%\(([a-zA-Z0-9_]+)\)s/g, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : "",
  );
}

export class BlocktransExtension {
  tags = ["blocktrans"];
  private safeString?: new (value: string) => unknown;

  constructor(nunjucksLib: NunjucksLibForParse | NunjucksLibForRun) {
    if ("runtime" in nunjucksLib) {
      this.safeString = nunjucksLib.runtime.SafeString;
    }
  }

  // Compile-time only -- see the module comment. `{% blocktrans [with
  // name=expr ...] %}...{% endblocktrans %}`; the body may contain only
  // literal text and bare `{{ name }}` references to `with`-bound names
  // (matching Django's own blocktrans restriction -- no filters, no nested
  // tags, in the body itself).
  parse(parser: PoParser, nodes: PoNodesModule): PoNode {
    const tok = parser.nextToken(); // consumes 'blocktrans'
    const withVars: Array<{ name: string; expr: PoNode }> = [];

    if (parser.skipSymbol("with")) {
      for (;;) {
        const nameTok = parser.peekToken();
        if (nameTok.type !== "symbol") break;
        const name = parser.nextToken().value;
        if (!parser.skipValue("operator", "=")) {
          parser.fail(`blocktrans: expected = after '${name}'`, tok.lineno, tok.colno);
        }
        const expr = parser.parseExpression();
        withVars.push({ name, expr });
      }
    }

    parser.advanceAfterBlockEnd(tok.value);

    const body = parser.parseUntilBlocks("endblocktrans");
    parser.advanceAfterBlockEnd();

    const boundNames = new Set(withVars.map((v) => v.name));
    let msgidTemplate = "";
    for (const child of body.children) {
      if (child.typename !== "Output") {
        parser.fail(`blocktrans: unexpected node ${child.typename} in body`, tok.lineno, tok.colno);
      }
      for (const outChild of (child as PoOutputNode).children) {
        if (outChild.typename === "TemplateData") {
          msgidTemplate += (outChild as PoTemplateDataNode).value;
        } else if (outChild.typename === "Symbol" && boundNames.has((outChild as PoSymbolNode).value)) {
          msgidTemplate += `%(${(outChild as PoSymbolNode).value})s`;
        } else {
          parser.fail(
            `blocktrans: only literal text and bound {{ name }} references are allowed in the body (found ${outChild.typename})`,
            tok.lineno,
            tok.colno,
          );
        }
      }
    }

    const args = new nodes.NodeList(tok.lineno, tok.colno, [new nodes.Literal(tok.lineno, tok.colno, msgidTemplate)]);
    for (const { name, expr } of withVars) {
      args.addChild(new nodes.Literal(tok.lineno, tok.colno, name));
      args.addChild(expr);
    }

    return new nodes.CallExtension(this, "run", args, []);
  }

  // Runtime only -- see the module comment. `rest` is a flat
  // [name, value, name, value, ...] list (compileCallExtension passes tag
  // args positionally, not as an object).
  run(context: PoRuntimeContext, msgidTemplate: string, ...rest: unknown[]): unknown {
    const vars: Record<string, unknown> = {};
    for (let i = 0; i < rest.length; i += 2) {
      vars[rest[i] as string] = rest[i + 1];
    }
    const catalogue = (context.lookup("_i18nCatalogue") as Record<string, string> | undefined) ?? {};
    const msgstr = catalogue[msgidTemplate];
    const template = msgstr && msgstr.length > 0 ? msgstr : msgidTemplate;
    const interpolated = interpolate(template, vars);
    // Autoescape must not double-escape a msgstr's embedded HTML (e.g.
    // `Part of <a href="%(url)s">%(name)s</a>`) -- SafeString is nunjucks'
    // own marker for "already safe, don't autoescape", same as `|safe`.
    return this.safeString ? new this.safeString(interpolated) : interpolated;
  }
}
