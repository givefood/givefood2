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
  colo: string;
  instance_id: string;
  version: string;
  commit: string | null;
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

// givefood/context_processors.py:22-29 filled instance_id and version from
// two Coolify environment variables -- COOLIFY_CONTAINER_NAME (which
// container served this) and SOURCE_COMMIT (which commit it was built
// from), both truncated to 7 characters, both falling back to the string
// "LOCALHOST". Neither environment variable exists on Workers, and until
// 2026-09-05 this file just hardcoded "cf-worker" and "dev" in their
// place, which made both debugcomment.njk lines pure noise: the same two
// constants on every page of every deploy.
//
// The Workers equivalents are per-isolate, not per-request, so they are
// set ONCE by middleware/runtimeIdentity.ts rather than threaded through
// the ~60 buildPageContext() call sites. See that file for where each
// value comes from and why caching it at module scope is safe.
interface RuntimeIdentity {
  colo: string;
  instanceId: string;
  version: string;
  commit: string | null;
}

let runtimeIdentity: RuntimeIdentity | null = null;

export function setRuntimeIdentity(identity: RuntimeIdentity): void {
  runtimeIdentity = identity;
}

// Kept deliberately distinguishable from any real value: a page rendered
// outside a request (a unit test, a script) says so rather than claiming
// to have come from a colo that never saw it.
const UNKNOWN_IDENTITY: RuntimeIdentity = { colo: "unknown", instanceId: "unknown", version: "unknown", commit: null };

export interface PageContextOptions {
  path: string;
  querystring?: string;
  appName: string;
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

  const identity = runtimeIdentity ?? UNKNOWN_IDENTITY;

  return {
    canonical_path: canonicalPath,
    flag_path: flagPath,
    colo: identity.colo,
    instance_id: identity.instanceId,
    version: identity.version,
    commit: identity.commit,
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
