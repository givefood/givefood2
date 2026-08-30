// Ported from givefood/context_processors.py's context() -- the variables
// every page render needs, regardless of which app's view is rendering.
// Scoped down from the full Django version for what's actually reachable
// right now (English-only routes, outside i18n_patterns): `languages`,
// full CLDR language names, and locale-aware `translate_url` are stubbed
// or simplified rather than fully ported -- WP 3.2 (i18n) is where those
// grow into the real thing. Every field can still be overridden per call,
// so a future /needs/ page render can supply the real values once that
// infrastructure exists, without this shape changing.
//
// Field names are snake_case, matching Django's context dict exactly (and
// therefore every ported .njk template's variable references) rather than
// TS convention -- this object's only job is to be handed straight to
// nunjucks, and a camelCase/snake_case translation layer would just be
// something to get out of sync across the 68 templates still to port.
export interface PageContext {
  canonical_path: string;
  flag_path: string;
  instance_id: string;
  version: string;
  app_name: string;
  domain: string;
  page_translatable: boolean;
  languages: Array<{ code: string; name: string; url: string }>;
  language_code: string;
  language_name: string;
  language_direction: "ltr" | "rtl";
  headless: boolean;
  is_flag_page: boolean;
}

const SITE_DOMAIN = "https://www.givefood.org.uk";

export interface PageContextOptions {
  path: string;
  querystring?: string;
  appName: string;
  version?: string;
  instanceId?: string;
  pageTranslatable?: boolean;
  headless?: boolean;
  isFlagPage?: boolean;
}

export function buildPageContext(options: PageContextOptions): PageContext {
  const canonicalPath = `${SITE_DOMAIN}${options.path}`;
  const flagPath = options.querystring ? `${canonicalPath}?${options.querystring}` : canonicalPath;

  return {
    canonical_path: canonicalPath,
    flag_path: flagPath,
    instance_id: options.instanceId ?? "cf-worker",
    version: options.version ?? "dev",
    app_name: options.appName,
    domain: SITE_DOMAIN,
    // Every route rendering through this package so far is outside
    // i18n_patterns (the API docs), so this is correctly false for all
    // current callers -- a /needs/ page (WP 3.2+) will need to pass true
    // and a real `languages` array.
    page_translatable: options.pageTranslatable ?? false,
    languages: [],
    language_code: "en",
    language_name: "English",
    language_direction: "ltr",
    headless: options.headless ?? false,
    is_flag_page: options.isFlagPage ?? false,
  };
}
