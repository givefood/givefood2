// Django's `{% url 'name' args %}` reverses a named route via the full
// urls.py graph (401 uses across the public surface, PLAN.md §6.2.1).
// This is a hand-written subset -- just the names actually used by the
// templates and handlers ported so far -- not the full generated reverse
// table PLAN.md specifies as the eventual mechanism ("regex + codegen"
// against urls.py). Grow this table as more of Phase 3 gets built, or
// replace it with the real generator; do not let it silently drift from
// givefood/urls.py in the meantime.
//
// This table lived in packages/templates/src/urls.ts until the DRY pass
// (audit finding D7) moved it here. It had grown four independent copies
// by then: this table, buildGeojson.ts's own localePrefix()/foodbankUrl()
// family, 15 inline `locale === "en" ? path : `/${locale}${path}``
// ternaries across the route handlers, and index.ts's route-registration
// strings. Two of the handlers carried comments saying the route name
// they needed "isn't in urls.ts's PARAMETERISED map yet (out of this
// task's scope to add)" -- WP 3.6's instruction not to import a templates
// module into plain route/lib code was the reason, and a standalone
// package is what resolves that layering objection rather than working
// around it. Both of those names are now in the table below.
//
// Anything that needs a givefood.org.uk path imports from here. Nothing
// else should hardcode one.
export const ROUTES: Record<string, string> = {
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
  // WP 4.5. gfdash/urls.py -- entirely outside i18n_patterns (the
  // "Untranslated apps" block, givefood/urls.py), so none of these go in
  // I18N_SCOPED.
  "dash:weekly_itemcount": "/dashboard/items-requested-weekly/",
  "dash:weekly_itemcount_year": "/dashboard/items-requested-weekly/by-year/",
  "dash:most_requested_items": "/dashboard/most-requested-items/",
  "dash:most_excess_items": "/dashboard/most-excess-items/",
  "dash:item_categories": "/dashboard/item-categories/",
  "dash:item_groups": "/dashboard/item-groups/",
  "dash:tt_old_data": "/dashboard/trusselltrust/old-data/",
  "dash:tt_most_requested_items": "/dashboard/trusselltrust/most-requested-items/",
  "dash:articles": "/dashboard/articles/",
  "dash:beautybanks": "/dashboard/beautybanks/",
  "dash:excess": "/dashboard/excess/",
  "dash:foodbanks_found": "/dashboard/foodbanks-found/",
  "dash:bean_pasta_index": "/dashboard/bean-pasta-index/",
  "dash:supermarkets": "/dashboard/donationpoints/supermarkets/",
  "dash:charity_income_expenditure": "/dashboard/charity-income-expenditure/",
  "dash:price_per_kg": "/dashboard/price-per/kg/",
  "dash:heatmap": "/dashboard/heatmap/",
  "dash:price_per_calorie": "/dashboard/price-per/calorie/",
  "dash:price_per_item_category": "/dashboard/price-per/item-category/",
  "api2:index": "/api/2/",
  "api2:docs": "/api/2/docs/",
  "dumps:dump_index": "/dumps/",
  "wfbn:index": "/needs/",
  "wfbn:constituencies": "/needs/in/constituencies/",
  "wfbn:rss": "/needs/rss.xml",
  "wfbn:geojson": "/needs/geo.json",
  "wfbn:get_location": "/needs/getlocation/",
  "wfbn-generic:webpush_config": "/needs/webpush/config/",
  human: "/human/",
  "write:index": "/write/",
  services: "/services/",
  news: "/news/",
  md_index: "/md/",
  bot: "/bot/",
  register_foodbank: "/register-foodbank/",
  sitemap: "/sitemap.xml",
  md_sitemap: "/md/sitemap.xml",
};

export const PARAMETERISED: Record<string, (...args: string[]) => string> = {
  frag: (slug) => `/frag/${slug}/`,
  "dumps:dump_latest": (dumpType, dumpFormat) => `/dumps/${dumpType}/${dumpFormat}/latest/`,
  "wfbn:foodbank": (slug) => `/needs/at/${slug}/`,
  "wfbn:foodbank_location": (slug, locslug) => `/needs/at/${slug}/${locslug}/`,
  "wfbn:foodbank_donationpoint": (slug, dpslug) => `/needs/at/${slug}/donationpoint/${dpslug}/`,
  // Added by the D7 consolidation. Both were previously built as inline
  // template literals in routes/wfbn/locationDetail.ts, each with a
  // comment noting the name was missing from this table -- the Link
  // preload header and the page's own data-include src for the opening
  // hours fragment, and the location map's og:image target.
  "wfbn:foodbank_location_map": (slug, locslug) => `/needs/at/${slug}/${locslug}/map.png`,
  "wfbn:foodbank_donationpoint_openinghours": (slug, dpslug) =>
    `/needs/at/${slug}/donationpoint/${dpslug}/openinghours/`,
  "wfbn-generic:foodbank_hit": (slug) => `/needs/at/${slug}/hit/`,
  "wfbn-generic:foodbank_location_photo": (slug, locslug) => `/needs/at/${slug}/${locslug}/photo.jpg`,
  "wfbn-generic:foodbank_donationpoint_photo": (slug, dpslug) => `/needs/at/${slug}/donationpoint/${dpslug}/photo.jpg`,
  "wfbn-generic:foodbank_photo": (slug) => `/needs/at/${slug}/photo.jpg`,
  "wfbn:foodbank_rss": (slug) => `/needs/at/${slug}/rss.xml`,
  "wfbn:foodbank_map": (slug) => `/needs/at/${slug}/map.png`,
  "wfbn:foodbank_locations": (slug) => `/needs/at/${slug}/locations/`,
  "wfbn:foodbank_donationpoints": (slug) => `/needs/at/${slug}/donationpoints/`,
  "wfbn:foodbank_news": (slug) => `/needs/at/${slug}/news/`,
  "wfbn:foodbank_charity": (slug) => `/needs/at/${slug}/charity/`,
  "wfbn:foodbank_nearby": (slug) => `/needs/at/${slug}/nearby/`,
  "wfbn:updates": (slug, action) => `/needs/at/${slug}/updates/${action}/`,
  "wfbn-md:md_foodbank": (slug) => `/md/needs/at/${slug}/`,
  "api2:foodbank": (slug) => `/api/2/foodbank/${slug}/`,
  "wfbn-generic:foodbank_favicon": (slug) => `/needs/at/${slug}/favicon.png`,
  country: (countrySlug) => `/${countrySlug}/`,
  country_geojson: (countrySlug) => `/${countrySlug}/geo.json`,
  annual_report: (year) => `/${year}/`,
  "wfbn:foodbank_geojson": (slug) => `/needs/at/${slug}/geo.json`,
  "wfbn:foodbank_location_geojson": (slug, locslug) => `/needs/at/${slug}/${locslug}/geo.json`,
  "wfbn:constituency_geojson": (parlconSlug) => `/needs/in/constituency/${parlconSlug}/geo.json`,
  "wfbn:constituency": (parlconSlug) => `/needs/in/constituency/${parlconSlug}/`,
  "api2:constituency": (slug) => `/api/2/constituency/${slug}/`,
  "wfbn-generic:webpush_subscribe": (slug) => `/needs/webpush/subscribe/${slug}/`,
  "wfbn-generic:webpush_unsubscribe": (slug) => `/needs/webpush/unsubscribe/${slug}/`,
  // WP 4.3 (/md/ mirror) -- gfwfbn/urls/md.py's "wfbn-md" namespace, all
  // outside i18n_patterns (givefood/urls.py's "Markdown versions" block is
  // in the untranslated section), so none of these need I18N_SCOPED.
  "wfbn-md:md_foodbank_locations": (slug) => `/md/needs/at/${slug}/locations/`,
  "wfbn-md:md_foodbank_location": (slug, locslug) => `/md/needs/at/${slug}/${locslug}/`,
  "wfbn-md:md_foodbank_donationpoints": (slug) => `/md/needs/at/${slug}/donationpoints/`,
  "wfbn-md:md_foodbank_donationpoint": (slug, dpslug) => `/md/needs/at/${slug}/donationpoint/${dpslug}/`,
  "wfbn-md:md_foodbank_news": (slug) => `/md/needs/at/${slug}/news/`,
  "wfbn-md:md_foodbank_charity": (slug) => `/md/needs/at/${slug}/charity/`,
  "wfbn-md:md_foodbank_nearby": (slug) => `/md/needs/at/${slug}/nearby/`,
  // WP 4.5. gfdash/urls.py's `re_path(r'^deliveries/(count|items|weight|calories)/$', ...)`.
  "dash:deliveries": (metric) => `/dashboard/deliveries/${metric}/`,
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
export const I18N_SCOPED = new Set([
  "wfbn:index",
  "wfbn:rss",
  "wfbn:geojson",
  "wfbn:get_location",
  "wfbn:foodbank",
  "wfbn:foodbank_location",
  "wfbn:foodbank_donationpoint",
  "wfbn:foodbank_rss",
  "wfbn:foodbank_map",
  "wfbn:foodbank_locations",
  "wfbn:foodbank_donationpoints",
  "wfbn:foodbank_news",
  "wfbn:foodbank_charity",
  "wfbn:foodbank_nearby",
  "wfbn:updates",
  "wfbn:foodbank_geojson",
  "wfbn:foodbank_location_geojson",
  "wfbn:constituency_geojson",
  // Newly exercised by the root homepage (the first non-wfbn,
  // language-prefixed page built) -- all inside givefood/urls.py's
  // i18n_patterns block, same as the wfbn:* names above.
  "index",
  "about_us",
  "donate",
  "news",
  "country",
  "annual_report",
  "frag",
  // page.njk's shared head/footer calls these on EVERY page, including
  // the wfbn pages already live on /cy//ga//gd/ -- also inside
  // i18n_patterns, so also unprefixed-and-wrong there until now. Not
  // introduced by today's homepage work, just first noticed while
  // classifying the names it needs.
  "manifest",
  "flag",
  "apps",
  "colophon",
  "annual_report_index",
  // Pre-existing latent bug, found while wiring up WP 3.7: `human/` sits
  // inside i18n_patterns too (givefood/urls.py:28, page_translatable=True
  // in its own context), but wasn't classified here even though
  // wfbn/foodbank/includes/subscribe.njk has called url('human') since
  // that template was first ported -- silently dropping the locale prefix
  // on every cy/ga/gd foodbank page's subscribe form action.
  "human",
  // WP 4.1 (content pages): all three inside the same i18n_patterns block.
  "bot",
  "register_foodbank",
  "country_geojson",
  // WP 4.2. wfbn:constituency (the constituency detail PAGE, not the
  // geojson feed) is registered here even though gfwfbn's constituency
  // page itself isn't built yet -- sitemap.xml needs to emit its URL
  // regardless, same "route name exists ahead of its real handler"
  // pattern already used for write:index/register_foodbank.
  "sitemap",
  "wfbn:constituency",
  "wfbn:constituencies",
  // D7. Both are registered under every locale prefix in the Worker's own
  // index.ts (inside its `for (const locale of LOCALES)` block), and both
  // call sites in routes/wfbn/locationDetail.ts already applied the prefix
  // by hand before this table owned them -- classified here so that stays
  // true now the ternaries are gone.
  "wfbn:foodbank_location_map",
  "wfbn:foodbank_donationpoint_openinghours",
]);

// url()/urlForLocale() -- the two reverse functions that read these
// tables -- live in ./index.ts.
