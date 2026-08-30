// Django's `{% url 'name' args %}` reverses a named route via the full
// urls.py graph (401 uses across the public surface, PLAN.md §6.2.1).
// This is a hand-written subset -- just the names actually used by the
// templates ported so far (page.html + the API docs pages) -- not the
// full generated reverse table PLAN.md specifies as the eventual
// mechanism ("regex + codegen" against urls.py). Grow this table as more
// of Phase 3 gets built, or replace it with the real generator; do not
// let it silently drift from givefood/urls.py in the meantime.
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
};

const PARAMETERISED: Record<string, (...args: string[]) => string> = {
  frag: (slug) => `/frag/${slug}/`,
  "dumps:dump_latest": (dumpType, dumpFormat) => `/dumps/${dumpType}/${dumpFormat}/latest/`,
};

export function url(name: string, ...args: string[]): string {
  if (args.length > 0) {
    const build = PARAMETERISED[name];
    if (build) return build(...args);
  }
  const path = ROUTES[name];
  if (path === undefined) throw new Error(`url(): no route named "${name}" in packages/templates/src/urls.ts`);
  return path;
}
