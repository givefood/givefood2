// The reverse half of Django's `{% url %}` / `reverse()`. The route
// tables it reads are in ./routes.ts -- see that file's header for why
// this is a standalone package rather than part of @givefood/templates.
//
// `locale` is a plain string, not @givefood/templates' `Locale` union, on
// purpose: templates imports this package (env.ts binds urlForLocale into
// every render), so a type dependency the other way would be a cycle.
// Behaviour is unchanged from the pre-D7 version -- anything other than
// "en" is treated as a prefixable locale, exactly as before.
import { I18N_SCOPED, PARAMETERISED, ROUTES } from "./routes";

export { I18N_SCOPED, PARAMETERISED, ROUTES } from "./routes";

function build(name: string, args: string[]): string {
  if (args.length > 0) {
    const parameterised = PARAMETERISED[name];
    if (parameterised) return parameterised(...args);
  }
  const path = ROUTES[name];
  if (path === undefined) throw new Error(`url(): no route named "${name}" in packages/urls/src/routes.ts`);
  return path;
}

export function url(name: string, ...args: string[]): string {
  return build(name, args);
}

// Locale-aware form -- see routes.ts's I18N_SCOPED. env.ts injects a
// closure over this as the `url` template global, bound to the current
// render's locale, so ported templates just call `{{ url('wfbn:index') }}`
// unchanged and get the right prefix for whichever page they're on.
// Worker route handlers that need a path outside a template render (map
// configs, redirect targets, Link headers, sitemap/robots output) call it
// directly with the request's resolved locale.
export function urlForLocale(locale: string, name: string, ...args: string[]): string {
  const path = build(name, args);
  if (locale === "en" || !I18N_SCOPED.has(name)) return path;
  return `/${locale}${path}`;
}
