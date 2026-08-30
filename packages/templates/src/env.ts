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
import { BlocktransExtension } from "./blocktransExtension";
import { loadCatalogue, translate, type Locale } from "./i18n";
import {
  commaSeparated,
  djangoDate,
  filesizeformat,
  friendlyPhone,
  friendlyUrl,
  fullPhone,
  intcomma,
  slugify,
} from "./filters";
import { url } from "./urls";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// Django's `{% now "r" %}` -- Python's "r" date format, RFC 2822. Workers
// run in UTC, so the offset is always +0000.
function formatRfc2822(date: Date): string {
  const day = DAY_NAMES[date.getUTCDay()];
  const dd = pad2(date.getUTCDate());
  const month = MONTH_NAMES[date.getUTCMonth()];
  const hh = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  return `${day}, ${dd} ${month} ${date.getUTCFullYear()} ${hh}:${mi}:${ss} +0000`;
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

  env.addGlobal("url", url);
  env.addGlobal("now", () => formatRfc2822(new Date()));
  // `.run()` reads the current request's catalogue from the render
  // context (`_i18nCatalogue`, set by render() below) rather than from
  // this instance, so one Environment-level registration covers every
  // locale -- see blocktransExtension.ts's module comment for why this is
  // a *different* instance of the same class from precompile.ts's.
  env.addExtension("blocktrans", new BlocktransExtension(nunjucksSlim));

  env.addFilter("friendlyPhone", friendlyPhone);
  env.addFilter("fullPhone", fullPhone);
  env.addFilter("friendlyUrl", friendlyUrl);
  env.addFilter("commaSeparated", commaSeparated);
  env.addFilter("slugify", slugify);
  env.addFilter("filesizeformat", filesizeformat);
  env.addFilter("intcomma", intcomma);
  env.addFilter("date", djangoDate);

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

// `_` (Django's `{% trans %}`) is injected per render() call, not
// registered as an Environment-level global like `url`/`now` above --
// unlike those, it's locale-dependent, and locale varies per request while
// the Environment is shared across the isolate's whole lifetime.
export async function render(name: string, context: Record<string, unknown> = {}, locale: Locale = "en"): Promise<string> {
  const catalogue = await loadCatalogue(locale);
  const renderContext = {
    ...context,
    _i18nCatalogue: catalogue,
    _: (msgid: string, vars?: Record<string, unknown>) => translate(catalogue, msgid, vars),
  };
  return getEnvironment().render(name, renderContext);
}
