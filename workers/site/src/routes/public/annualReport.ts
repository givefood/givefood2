import type { Context } from "hono";
import { buildPageContext, render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { elapsedMs } from "../../middleware/serverTiming";

// givefood `annual_report_index` / `annual_report` (givefood/urls.py:43-44,
// inside i18n_patterns -- namespace-less, root-app names "annual_report_index"
// and "annual_report"). Ported from givefood/views.py:431-443.
//
// annual_report(request, year) is a single Django view that selects a
// DIFFERENT, hand-authored template per year -- render(request,
// "public/ar/%s.html" % (year)) -- with no validation of `year` in the view
// itself. The urls.py re_path's fixed alternation,
// `(?P<year>(2019|2020|2021|2022|2023|2024|2025))`, is the ONLY guard
// against template-path injection in the original app. index.ts's own
// route registration reproduces that same regex constraint at the routing
// layer (Hono's `:year{2019|2020|...|2025}` param, mirroring the existing
// `:action{subscribe|confirm|unsubscribe}` precedent in wfbn/updates.ts).
//
// This handler adds a second, belt-and-braces version of that same
// guarantee: YEAR_TEMPLATES is an exact-lookup allowlist, never a
// `public/ar/${year}.njk` string interpolation, so even a future routing
// change can't turn `year` into an arbitrary template path.
const YEAR_TEMPLATES: Record<string, string> = {
  "2019": "public/ar/2019.njk",
  "2020": "public/ar/2020.njk",
  "2021": "public/ar/2021.njk",
  "2022": "public/ar/2022.njk",
  "2023": "public/ar/2023.njk",
  "2024": "public/ar/2024.njk",
  "2025": "public/ar/2025.njk",
};

export async function annualReportIndex(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const context = buildPageContext({
    path: c.req.path,
    appName: "givefood",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "public/ar/index.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
    },
    locale,
  );
  return c.html(html);
}

export async function annualReport(c: Context<AppEnv>): Promise<Response> {
  // Non-null assertion trusted the same way wfbn/updates.ts trusts its own
  // regex-constrained :action param -- index.ts's route registration is
  // the only way to reach this handler, and it only ever hands over one of
  // YEAR_TEMPLATES' 7 keys.
  const year = c.req.param("year")!;
  const templateName = YEAR_TEMPLATES[year];
  if (!templateName) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const context = buildPageContext({
    path: c.req.path,
    appName: "givefood",
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    templateName,
    {
      ...context,
      render_time_ms: elapsedMs(c),
    },
    locale,
  );
  return c.html(html);
}
