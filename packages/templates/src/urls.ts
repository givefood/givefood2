// Django's `{% url 'name' args %}` reverses a named route via the full
// urls.py graph (401 uses across the public surface, PLAN.md §6.2.1).
// This is a hand-written subset -- just the names actually used by the
// templates ported so far -- not the full generated reverse table PLAN.md
// specifies as the eventual mechanism ("regex + codegen" against
// urls.py). Grow this table as more of Phase 3 gets built, or replace it
// with the real generator; do not let it silently drift from
// givefood/urls.py in the meantime.
const ROUTES: Record<string, string> = {
  index: "/",
  about_us: "/about-us/",
  colophon: "/colophon/",
  apps: "/apps/",
  flag: "/flag/",
  donate: "/donate/",
  annual_report_index: "/annual-reports/",
  manifest: "/manifest.json",
  privacy: "/privacy/",
  "dash:index": "/dashboard/",
  "api2:index": "/api/2/",
  "api2:docs": "/api/2/docs/",
  "dumps:dump_index": "/dumps/",
  "wfbn:index": "/needs/",
  "wfbn:rss": "/needs/rss.xml",
  "wfbn:get_location": "/needs/getlocation/",
};

const PARAMETERISED: Record<string, (...args: string[]) => string> = {
  frag: (slug) => `/frag/${slug}/`,
  "dumps:dump_latest": (dumpType, dumpFormat) => `/dumps/${dumpType}/${dumpFormat}/latest/`,
  "wfbn:foodbank": (slug) => `/needs/at/${slug}/`,
  "wfbn:foodbank_location": (slug, locslug) => `/needs/at/${slug}/${locslug}/`,
  "wfbn:foodbank_donationpoint": (slug, dpslug) => `/needs/at/${slug}/donationpoint/${dpslug}/`,
  "wfbn-generic:foodbank_hit": (slug) => `/needs/at/${slug}/hit/`,
  "wfbn-generic:foodbank_location_photo": (slug, locslug) => `/needs/at/${slug}/${locslug}/photo.jpg`,
  "wfbn-generic:foodbank_donationpoint_photo": (slug, dpslug) => `/needs/at/${slug}/donationpoint/${dpslug}/photo.jpg`,
};

// Route names reached inside Django's i18n_patterns -- `{% url %}` for one
// of these on a non-English page must carry that page's language prefix
// (`/cy/needs/`, not `/needs/`), matching `translate_url`'s effect on
// every internal link a page emits. `wfbn-generic:*` routes are
// deliberately absent: they're registered BEFORE i18n_patterns in
// givefood/urls.py (§6.1.1), so they never carry a prefix regardless of
// the current page's language.
//
// Only the wfbn:* names actually exercised by a language-prefixed page so
// far (the /needs/ index page) are classified here. The pre-existing
// root-app names (about_us, apps, donate, etc.) are ALSO inside
// i18n_patterns per PLAN.md §2.3.1 (with privacy/ as a confirmed
// exception, outside it) but aren't marked yet -- nothing reachable via a
// language-prefixed URL calls url() with one of those names today (every
// page.njk consumer built so far is English-only), so getting this wrong
// for them isn't yet an observable bug. Classify each before the first
// non-English page that links to one of them ships.
const I18N_SCOPED = new Set([
  "wfbn:index",
  "wfbn:rss",
  "wfbn:get_location",
  "wfbn:foodbank",
  "wfbn:foodbank_location",
  "wfbn:foodbank_donationpoint",
]);

function build(name: string, args: string[]): string {
  if (args.length > 0) {
    const parameterised = PARAMETERISED[name];
    if (parameterised) return parameterised(...args);
  }
  const path = ROUTES[name];
  if (path === undefined) throw new Error(`url(): no route named "${name}" in packages/templates/src/urls.ts`);
  return path;
}

export function url(name: string, ...args: string[]): string {
  return build(name, args);
}

// Locale-aware form -- see I18N_SCOPED above. env.ts injects a closure
// over this as the `url` template global, bound to the current render's
// locale, so ported templates just call `{{ url('wfbn:index') }}`
// unchanged and get the right prefix for whichever page they're on.
export function urlForLocale(locale: string, name: string, ...args: string[]): string {
  const path = build(name, args);
  if (locale === "en" || !I18N_SCOPED.has(name)) return path;
  return `/${locale}${path}`;
}
