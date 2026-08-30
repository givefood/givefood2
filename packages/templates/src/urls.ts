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
};

const PARAMETERISED: Record<string, (arg: string) => string> = {
  frag: (slug) => `/frag/${slug}/`,
};

export function url(name: string, arg?: string): string {
  if (arg !== undefined) {
    const build = PARAMETERISED[name];
    if (build) return build(arg);
  }
  const path = ROUTES[name];
  if (path === undefined) throw new Error(`url(): no route named "${name}" in packages/templates/src/urls.ts`);
  return path;
}
