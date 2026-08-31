// Nunjucks core has no `{% autoescape %}...{% endautoescape %}` block tag
// (parser.js's tag switch has no case for it -- verified directly against
// the installed nunjucks@3.2.4 source, not assumed) -- needed to reproduce
// every Django md/xml mirror template's `{% autoescape off %}...
// {% endautoescape %}` wrapper. Same dual-lifecycle shape as
// BlocktransExtension in this same directory -- see that file's module
// comment for why `.parse()` needs the full nunjucks package's
// parser/nodes and `.run()` needs only nunjucks-slim's runtime, and why
// one class gets constructed twice, once per lib, registered under the
// same extension name.
//
// `run()` toggles the shared Environment's own `opts.autoescape` flag for
// exactly the duration of the body's render, then restores it. Safe
// because a whole render() call runs to completion on one JS call stack
// with no `await` in between -- this codebase never renders async
// (no async filters/extensions are registered) -- so no other in-flight
// request's render can observe the flag mid-flip.
interface AeNode {
  typename: string;
}
interface AeNodeList extends AeNode {
  children: AeNode[];
}
interface AeToken {
  type: string;
  value: string;
  lineno: number;
  colno: number;
}
interface AeNodesModule {
  NodeList: new (lineno: number, colno: number, children: AeNode[]) => AeNodeList;
  CallExtension: new (ext: unknown, prop: string, args: AeNodeList, contentArgs: unknown[]) => AeNode;
}
interface AeParser {
  nextToken(): AeToken;
  parseExpression(): AeNode;
  advanceAfterBlockEnd(name?: string): AeToken;
  parseUntilBlocks(...blockNames: string[]): AeNode;
}
interface AeEnvironment {
  opts: { autoescape: boolean };
}
interface AeRuntimeContext {
  env: AeEnvironment;
}
interface NunjucksLibForParse {
  nodes: AeNodesModule;
}
interface NunjucksLibForRun {
  runtime: { SafeString: new (value: string) => unknown };
}

export class AutoescapeExtension {
  tags = ["autoescape"];
  private safeString?: new (value: string) => unknown;

  constructor(nunjucksLib: NunjucksLibForParse | NunjucksLibForRun) {
    if ("runtime" in nunjucksLib) {
      this.safeString = nunjucksLib.runtime.SafeString;
    }
  }

  // Compile-time only -- see the module comment. `{% autoescape false %}
  // ...{% endautoescape %}` -- the value is a plain boolean literal
  // expression (Django's off/on maps to false/true here), the body may be
  // any normal template content.
  parse(parser: AeParser, nodes: AeNodesModule): AeNode {
    const tok = parser.nextToken(); // consumes 'autoescape'
    const valueExpr = parser.parseExpression();
    parser.advanceAfterBlockEnd(tok.value);
    const body = parser.parseUntilBlocks("endautoescape");
    parser.advanceAfterBlockEnd();
    const args = new nodes.NodeList(tok.lineno, tok.colno, [valueExpr]);
    return new nodes.CallExtension(this, "run", args, [body]);
  }

  // Runtime only -- see the module comment. `renderBody` is nunjucks' own
  // synchronous content-arg callback, returning the body's buffered
  // output as a plain string.
  run(context: AeRuntimeContext, autoescapeValue: boolean, renderBody: () => string): unknown {
    const prev = context.env.opts.autoescape;
    context.env.opts.autoescape = Boolean(autoescapeValue);
    let rendered: string;
    try {
      rendered = renderBody();
    } finally {
      context.env.opts.autoescape = prev;
    }
    // SafeString so the CallExtension's own suppressValue call (which
    // runs after opts.autoescape is restored) doesn't re-escape content
    // already rendered under the flipped flag.
    return this.safeString ? new this.safeString(rendered) : rendered;
  }
}
