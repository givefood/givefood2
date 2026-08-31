/// <reference path="./nunjucks-slim.d.ts" />
// Workers bans eval()/new Function(), and every JS template engine --
// nunjucks included -- compiles templates via new Function(). Importing
// plain "nunjucks" here would throw at runtime the moment a template
// rendered ("Code generation from strings disallowed for this context").
// nunjucks/browser/nunjucks-slim ships the renderer only, no compiler, and
// loads templates precompiled ahead of time by scripts/precompile.ts via
// PrecompiledLoader -- see that script for how templates/*.njk gets there.
import nunjucksSlim, { type Environment } from "nunjucks/browser/nunjucks-slim.js";
import { precompiledTemplates } from "./generated/precompiled";
import { AutoescapeExtension } from "./autoescapeExtension";
import { BlocktransExtension } from "./blocktransExtension";
import { loadCatalogue, translate, type Locale } from "./i18n";
import {
  commaSeparated,
  djangoDate,
  djangoSlice,
  djangoTitle,
  filesizeformat,
  floatformat,
  formatDjangoDateTokens,
  friendlyPhone,
  friendlyUrl,
  fullPhone,
  intcomma,
  linebreaks,
  linebreaksbr,
  slugify,
  truncatechars,
} from "./filters";
import { urlForLocale } from "@givefood/urls";

// Django's `{% now "r" %}` -- Python's "r" date format, RFC 2822 (also
// used directly by wfbn/rss.xml's `item.date|date:"D, d M Y H:i:s O"`,
// the same format spelled out instead of the "r" shortcut -- both go
// through DATE_FORMAT_TOKENS's D/H/i/s/O entries).
function formatRfc2822(date: Date): string {
  return formatDjangoDateTokens(date, "D, d M Y H:i:s O");
}

function buildEnvironment(): Environment {
  const loader = new nunjucksSlim.PrecompiledLoader(precompiledTemplates);
  const env = new nunjucksSlim.Environment(loader, {
    autoescape: true,
    // Matches Django, which renders a missing template variable as "" --
    // nunjucks does this too once throwOnUndefined is off (its default is
    // already false; set explicitly here since a Worker throwing 500s on
    // every template typo would be a bad way to discover that).
    throwOnUndefined: false,
  });

  env.addGlobal("now", () => formatRfc2822(new Date()));
  // `.run()` reads the current request's catalogue from the render
  // context (`_i18nCatalogue`, set by render() below) rather than from
  // this instance, so one Environment-level registration covers every
  // locale -- see blocktransExtension.ts's module comment for why this is
  // a *different* instance of the same class from precompile.ts's.
  env.addExtension("blocktrans", new BlocktransExtension(nunjucksSlim));
  env.addExtension("autoescape", new AutoescapeExtension(nunjucksSlim));

  // Registered under Django's own filter names (custom_tags.py's
  // @register.filter def names), snake_case -- not camelCase, which is
  // what this file originally registered before any real template
  // (wfbn/index.njk) exercised them. An unknown filter throws
  // ("filter not found: ...") at render time, throwOnUndefined
  // notwithstanding -- verified directly, not assumed -- so this would
  // have been a 500, not a silent wrong-output bug.
  env.addFilter("friendly_phone", friendlyPhone);
  env.addFilter("full_phone", fullPhone);
  env.addFilter("friendly_url", friendlyUrl);
  env.addFilter("comma_separated", commaSeparated);
  env.addFilter("slugify", slugify);
  env.addFilter("filesizeformat", filesizeformat);
  env.addFilter("intcomma", intcomma);
  env.addFilter("date", djangoDate);
  env.addFilter("djslice", djangoSlice);
  env.addFilter("django_title", djangoTitle);
  env.addFilter("truncatechars", truncatechars);
  env.addFilter("linebreaksbr", (value: string) => new nunjucksSlim.runtime.SafeString(linebreaksbr(value)));
  env.addFilter("floatformat", floatformat);
  // Django's `linebreaks` is `is_safe = True` -- its <p>/<br> output must
  // not be re-escaped by autoescape, same reasoning as blocktrans's
  // SafeString wrap.
  env.addFilter("linebreaks", (value: string) => new nunjucksSlim.runtime.SafeString(linebreaks(value)));

  return env;
}

// Built once per isolate and reused across requests, not per-render --
// re-parsing the precompiled template map on every call would throw away
// the whole point of precompiling it at build time.
let cachedEnv: Environment | null = null;

function getEnvironment(): Environment {
  if (!cachedEnv) {
    cachedEnv = buildEnvironment();
  }
  return cachedEnv;
}

// `_` and `url` are injected per render() call, not registered as
// Environment-level globals like `now` above -- both are locale-dependent
// (url() so `{% url 'wfbn:index' %}` carries the right language prefix on
// a non-English page -- see urls.ts's I18N_SCOPED), and locale varies per
// request while the Environment is shared across the isolate's whole
// lifetime.
export async function render(name: string, context: Record<string, unknown> = {}, locale: Locale = "en"): Promise<string> {
  const catalogue = await loadCatalogue(locale);
  const renderContext = {
    ...context,
    _i18nCatalogue: catalogue,
    _: (msgid: string, vars?: Record<string, unknown>) => translate(catalogue, msgid, vars),
    url: (name: string, ...args: string[]) => urlForLocale(locale, name, ...args),
  };
  return getEnvironment().render(name, renderContext);
}
