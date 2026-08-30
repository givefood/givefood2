// @types/nunjucks only covers the main "nunjucks" entrypoint (which pulls in
// the compiler -- banned on Workers, see env.ts). This is the minimal
// surface this package actually uses from the browser/slim runtime build.
declare module "nunjucks/browser/nunjucks-slim.js" {
  export interface TemplateSource {
    getSource(name: string): { src: unknown; path: string; noCache: boolean } | null;
  }

  export class PrecompiledLoader implements TemplateSource {
    constructor(compiledTemplates: Record<string, unknown>);
    getSource(name: string): { src: unknown; path: string; noCache: boolean } | null;
  }

  export interface EnvironmentOptions {
    autoescape?: boolean;
    throwOnUndefined?: boolean;
    trimBlocks?: boolean;
    lstripBlocks?: boolean;
  }

  export class Environment {
    constructor(loader?: TemplateSource | TemplateSource[] | null, opts?: EnvironmentOptions);
    addGlobal(name: string, value: unknown): this;
    addFilter(name: string, fn: (...args: never[]) => unknown): this;
    addExtension(name: string, extension: unknown): this;
    render(name: string, context?: Record<string, unknown>): string;
  }

  const nunjucksSlim: {
    Environment: typeof Environment;
    PrecompiledLoader: typeof PrecompiledLoader;
    runtime: { SafeString: new (value: string) => unknown };
  };
  export default nunjucksSlim;
}
