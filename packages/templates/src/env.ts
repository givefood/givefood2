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
import { commaSeparated, friendlyPhone, friendlyUrl, fullPhone } from "./filters";
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
  // English-only passthrough for Django's `{% trans %}`/`{% blocktrans %}`.
  // WP 3.2 (i18n) replaces this with a real lookup; every ported template
  // already calls through `_()` so that swap won't touch template source.
  env.addGlobal("_", (text: string) => text);

  env.addFilter("friendlyPhone", friendlyPhone);
  env.addFilter("fullPhone", fullPhone);
  env.addFilter("friendlyUrl", friendlyUrl);
  env.addFilter("commaSeparated", commaSeparated);

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

// Django's RenderTime middleware timed the whole request (view + DB queries
// + template render) and did a global response.content.replace() for it --
// deliberately NOT ported that way (see middleware/serverTiming.ts): doing
// that on every response, including streamed R2 bodies, forces full
// buffering. An HTML page string is never streamed in the first place, so
// substituting here is free -- it just can only account for the template
// render itself, not the view/DB work before it. If a future page route
// wants the full request duration in this comment, time from the route
// handler and pass the elapsed ms in through context instead.
const RENDER_TIME_PLACEHOLDER = "PUTTHERENDERTIMEHERE";

export function render(name: string, context: Record<string, unknown> = {}): string {
  const t0 = performance.now();
  const html = getEnvironment().render(name, context);
  const durationMs = performance.now() - t0;
  return html.includes(RENDER_TIME_PLACEHOLDER)
    ? html.replace(RENDER_TIME_PLACEHOLDER, durationMs.toFixed(3))
    : html;
}
