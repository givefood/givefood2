// WP 3.2 (PLAN.md §10.2.4). Maintainer decision, §2.7.1: 4 languages, not
// Django's 21 -- en, cy, ga, gd (English plus the UK/Ireland's three
// indigenous minority languages). The other 17 catalogues are dropped, not
// ported.
export type Locale = "en" | "cy" | "ga" | "gd";
export const LOCALES: readonly Locale[] = ["en", "cy", "ga", "gd"];

type Catalogue = Record<string, string>;

// Dynamic, not static, import per locale: even at 3 non-English catalogues
// this defers parsing/allocating a locale's JSON blob until a request
// actually needs it, rather than paying that cost on every cold start
// regardless of which language the request resolved to.
const LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: Catalogue }>> = {
  cy: () => import("./generated/locales/cy.json"),
  ga: () => import("./generated/locales/ga.json"),
  gd: () => import("./generated/locales/gd.json"),
};

// Module-scope, not per-request: a Worker isolate serves many requests, and
// a locale's catalogue never changes within one deployed version.
const cache = new Map<Locale, Catalogue>();

export async function loadCatalogue(locale: Locale): Promise<Catalogue> {
  if (locale === "en") return {};
  const cached = cache.get(locale);
  if (cached) return cached;
  const mod = await LOADERS[locale]();
  cache.set(locale, mod.default);
  return mod.default;
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/%\(([a-zA-Z0-9_]+)\)s/g, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : "",
  );
}

// The `{% trans %}`/plain-string half of Django's i18n (the `_()` global --
// see env.ts). `{% blocktrans %}` goes through BlocktransExtension instead,
// which needs HTML-safety (SafeString) that a plain string return here
// doesn't have -- this function is for `{{ _("Go") }}`-style single-word/
// no-HTML strings, which is everything `{% trans %}` (not `{% blocktrans
// %}`) is used for in the source templates.
export function translate(catalogue: Catalogue, msgid: string, vars: Record<string, unknown> = {}): string {
  const msgstr = catalogue[msgid];
  const template = msgstr && msgstr.length > 0 ? msgstr : msgid;
  return interpolate(template, vars);
}
