// Ported from givefood/context_processors.py's context() -- the variables
// every page render needs, regardless of which app's view is rendering.
//
// Field names are snake_case, matching Django's context dict exactly (and
// therefore every ported .njk template's variable references) rather than
// TS convention -- this object's only job is to be handed straight to
// nunjucks, and a camelCase/snake_case translation layer would just be
// something to get out of sync across the 68 templates still to port.
import type { Locale } from "./i18n";

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

// §2.7.1: 4 languages, not Django's 21 -- none of the 4 are RTL (ur/ar,
// the two RTL entries in Django's original LANGUAGES list, are among the
// 17 dropped), so language_direction is always "ltr" for this app.
const LANGUAGE_NAMES: Record<Locale, string> = {
  en: "English",
  cy: "Cymraeg",
  ga: "Gaeilge",
  gd: "Gàidhlig",
};

export interface PageContextOptions {
  path: string;
  querystring?: string;
  appName: string;
  version?: string;
  instanceId?: string;
  pageTranslatable?: boolean;
  headless?: boolean;
  isFlagPage?: boolean;
  // The current page's resolved language (resolveLanguage.ts) and its
  // UNPREFIXED path (Hono's `pathAfterPrefix` context var) -- together
  // enough to build language_code/name and the `languages` alternate-URL
  // list (translate_url's job: swap the leading /<lang> segment) without
  // needing the full generated reverse-URL table PLAN.md specifies as the
  // eventual mechanism. Omit both for an English-only, non-i18n-patterns
  // route (the API docs pages) -- defaults to plain English, no
  // alternates, same as before this parameter existed.
  locale?: Locale;
  unprefixedPath?: string;
}

export function buildPageContext(options: PageContextOptions): PageContext {
  const canonicalPath = `${SITE_DOMAIN}${options.path}`;
  const flagPath = options.querystring ? `${canonicalPath}?${options.querystring}` : canonicalPath;
  const locale = options.locale ?? "en";
  const unprefixedPath = options.unprefixedPath ?? options.path;

  const languages = options.locale
    ? (Object.keys(LANGUAGE_NAMES) as Locale[]).map((code) => ({
        code,
        name: LANGUAGE_NAMES[code],
        url: code === "en" ? unprefixedPath : `/${code}${unprefixedPath}`,
      }))
    : [];

  return {
    canonical_path: canonicalPath,
    flag_path: flagPath,
    instance_id: options.instanceId ?? "cf-worker",
    version: options.version ?? "dev",
    app_name: options.appName,
    domain: SITE_DOMAIN,
    page_translatable: options.pageTranslatable ?? false,
    languages,
    language_code: locale,
    language_name: LANGUAGE_NAMES[locale],
    language_direction: "ltr",
    headless: options.headless ?? false,
    is_flag_page: options.isFlagPage ?? false,
  };
}
