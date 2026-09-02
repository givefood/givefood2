import type { Context } from "hono";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

const RESULT_LIMIT = 500;

// WP 6.10 (PLAN.md §8.13.1 Tier 3) -- the direct replacement for
// `manage.py shell` against live data. Genuinely new: there is no Django
// admin page like this to port, PLAN.md specified the shape directly.
// POST-only for the query itself (never accepted via a URL query string,
// so a stray link or an image tag can't trigger one, and raw SQL never
// lands in access logs) -- rejects anything not starting with SELECT or
// EXPLAIN, shows EXPLAIN QUERY PLAN above the results, hard LIMIT 500.
function extractStatement(raw: string): { statement: string; isExplain: boolean } | null {
  const statement = raw.trim().replace(/;+\s*$/, "");
  if (!statement) return null;
  if (statement.includes(";")) return null; // one statement only, no stacking
  if (!/^(SELECT|EXPLAIN)\b/i.test(statement)) return null;
  return { statement, isExplain: /^EXPLAIN\b/i.test(statement) };
}

function rowsToColumns(rows: Record<string, unknown>[]): string[] {
  const first = rows[0];
  return first ? Object.keys(first) : [];
}

export async function adminQueryConsole(c: Context<AppEnv>): Promise<Response> {
  const pageContext = await adminPageContext(c, "settings");
  let query = "";
  let error: string | undefined;
  let planColumns: string[] = [];
  let planRows: Record<string, unknown>[] = [];
  let resultColumns: string[] = [];
  let resultRows: Record<string, unknown>[] = [];
  let truncated = false;
  let ran = false;
  let isExplain = false;

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    query = typeof body.query === "string" ? body.query : "";
    const parsed = extractStatement(query);
    if (!parsed) {
      error = "Only a single SELECT or EXPLAIN statement is allowed.";
    } else {
      const db = dbSession(c);
      isExplain = parsed.isExplain;
      try {
        if (parsed.isExplain) {
          const plan = await db.prepare(parsed.statement).all<Record<string, unknown>>();
          planRows = plan.results;
          planColumns = rowsToColumns(planRows);
        } else {
          const plan = await db.prepare(`EXPLAIN QUERY PLAN ${parsed.statement}`).all<Record<string, unknown>>();
          planRows = plan.results;
          planColumns = rowsToColumns(planRows);

          const results = await db
            .prepare(`SELECT * FROM (${parsed.statement}) LIMIT ?`)
            .bind(RESULT_LIMIT + 1)
            .all<Record<string, unknown>>();
          truncated = results.results.length > RESULT_LIMIT;
          resultRows = truncated ? results.results.slice(0, RESULT_LIMIT) : results.results;
          resultColumns = rowsToColumns(resultRows);
        }
        ran = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const html = await render("admin/query.njk", {
    ...pageContext,
    title: "Query console",
    query,
    error,
    ran,
    show_results: ran && !isExplain,
    plan_columns: planColumns,
    plan_rows: planRows,
    result_columns: resultColumns,
    result_rows: resultRows,
    truncated,
    result_limit: RESULT_LIMIT,
  });
  return c.html(html);
}
