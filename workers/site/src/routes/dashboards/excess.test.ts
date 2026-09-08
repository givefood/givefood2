import { DatabaseSync } from "node:sqlite";
import { schemaFor } from "@givefood/db/src/schema.testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/dashboards/excess.ts -- /dashboard/excess/, gfdash's `excess`
// (gfdash/views.py:338-344 in the Django original), the one exported symbol
// `gfdashExcess`.
//
// WHAT THIS PAGE IS. Django's whole view is four lines:
//
//     excesses = FoodbankChange.objects.filter(published = True).order_by("-created")[:200]
//
// and dash/excess.html renders one <tr> per row THAT HAS excess text. Every
// interesting behaviour on this page therefore lives in places a status-code
// test cannot see: which of the 200 rows the SQL picked, which of those the
// template then dropped, what slug the link was built from, and what the
// "Found" column says. All four are wrong-data-on-a-correct-looking-page
// failures -- the page still returns 200 and still looks like a table.
//
// SO THESE TESTS READ THE RENDERED TABLE, never the status alone. The full
// request goes through the REAL app (workers/site/src/index.ts's default
// export), so the route registration at index.ts:556, appendSlash, the
// security/cache middleware, the real `dbSession`, the real
// `getRecentPublishedChanges` and the real Nunjucks render of
// dash/excess.njk are all the genuine article. Real in-memory SQLite built
// by schemaFor() from the real migrations -- which matters more here than
// usual, because the query reads the VIEW `foodbankchange_full` rather than
// the `foodbankchange` table (migration 0019 dropped the denormalised
// foodbank_name column and moved it into that view; reading the base table
// is exactly what 500ed /dashboard/beautybanks/ on 2026-09-05).
//
// Faked: only the two KV namespaces, which nothing on this page touches.
//
// THE CLOCK IS FROZEN in most tests. The "Found" column is
// timesince(row.created, new Date()) -- with a real clock the expected
// string changes as the suite runs, so every test that asserts it pins the
// system time first.

const ORIGIN = "https://www.givefood.org.uk";

type Bindable = null | number | bigint | string | Uint8Array;

// Every statement that actually reached the engine, with its bound
// parameters. Load-bearing twice over: it is the only way to assert LIMIT is
// really 200 rather than "more rows than the fixture has", and the only way
// to prove a GET of this page issues no write at all.
const statements: { sql: string; params: Bindable[] }[] = [];

// The slice of the D1 Sessions API packages/db uses, over node:sqlite --
// the same shim routes/public/sitemaps.test.ts and routes/admin/map.test.ts
// use. D1 is async and node:sqlite is synchronous; the SQL text, the
// parameter binding and the NULL semantics are SQLite's in both.
function d1Session(db: DatabaseSync): D1DatabaseSession {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      statements.push({ sql, params });
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      statements.push({ sql, params });
      return { results: db.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      statements.push({ sql, params });
      db.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as D1DatabaseSession;
}

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

let db: DatabaseSync;

function env(): AppEnv["Bindings"] {
  return {
    DB: { withSession: () => d1Session(db) },
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    DATA: { get: async () => null, put: async () => {}, delete: async () => {} },
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    SITE_DOMAIN: ORIGIN,
  } as unknown as AppEnv["Bindings"];
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // `foodbank` as well as the change table and its view: the view LEFT JOINs
  // to it for foodbank_name, and SQLite will happily create a view over a
  // missing table and only fail at SELECT time.
  db.exec(schemaFor("foodbank", "foodbankchange", "foodbankchange_full"));
  statements.length = 0;
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

const get = async (path: string, init?: RequestInit): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, init), env(), execCtx);

// Every NOT NULL column the real migration declares, so a seeded row is one
// production would have accepted. Only name and slug vary: the page reads the
// name (through the view) and, as the tests below establish, pointedly does
// NOT read the slug.
function seedFoodbank(id: number, name: string, slug: string): void {
  db.prepare(
    `INSERT INTO foodbank (id, uuid, name, slug, address, postcode, country, lat_lng, charity_just_foodbank,
       contact_email, url, shopping_list_url, address_is_administrative, is_closed, no_locations,
       days_between_needs, created, modified)
     VALUES (?, ?, ?, ?, '1 High Street', 'SP1 1AA', 'England', '51.07,-1.79', 0,
       'info@example.invalid', 'https://example.invalid/', 'https://example.invalid/list/',
       0, 0, 0, 14, '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000')`,
  ).run(id, String(id).padStart(32, "a"), name, slug);
}

interface NeedSeed {
  id: number;
  fb: number | null;
  excess: string | null;
  published: 0 | 1;
  created: string;
}

function seedNeed(o: NeedSeed): void {
  db.prepare(
    `INSERT INTO foodbankchange (id, need_id, foodbank_id, change_text, excess_change_text, published, input_method, created, modified)
     VALUES (?, ?, ?, 'Beans', ?, ?, 'scrape', ?, ?)`,
  ).run(o.id, `need-${o.id}`, o.fb, o.excess, o.published, o.created, o.created);
}

// Django's naive-datetime text format, the one D1 actually holds
// ("2026-09-05 19:28:08.853000"). Spelled out as a helper so a test that
// deliberately uses the OTHER format (toISOString's "T"/"Z") is visibly
// doing something unusual rather than looking like a typo.
const django = (iso: string) => `${iso.replace("T", " ").replace("Z", "")}.000000`;

const NOW = "2026-09-05T10:00:00.000Z";
function freezeClock(at: string = NOW): void {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(at));
}

const table = (html: string): string => html.slice(html.indexOf("<table"), html.indexOf("</table>") + 8);

// The three <td>s of every rendered row, in template order: the linked food
// bank, the excess text, the "Found" text. Asserting on these rather than on
// the whole document keeps the expectations about THIS page rather than about
// the site footer, the debug comment, or the render time (which is a live
// number and would make every assertion time-dependent).
interface RenderedRow {
  link: string;
  excess: string;
  found: string;
}

function rows(html: string): RenderedRow[] {
  const tds = [...table(html).matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1] as string);
  const out: RenderedRow[] = [];
  for (let i = 0; i < tds.length; i += 3) {
    out.push({ link: tds[i] as string, excess: tds[i + 1] as string, found: tds[i + 2] as string });
  }
  return out;
}

const page = async (): Promise<string> => (await get("/dashboard/excess/")).text();

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

describe("the query behind the page", () => {
  it("asks foodbankchange_full for the 200 newest published needs, and asks it once", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    await page();

    // The literal statement, not a substring match. Three things this pins
    // that nothing else can:
    //
    //  * `foodbankchange_full`, the VIEW. The base table has had no
    //    foodbank_name column since migration 0019, so a "helpful" rewrite
    //    to the table would 500 the page -- the beautybanks failure of
    //    2026-09-05, on the same column, in the neighbouring query.
    //  * `published = 1`. The filter is inside the SQL, not the template;
    //    losing it would leak unpublished needs onto a public page.
    //  * `LIMIT ?` bound to 200, not interpolated. A fixture can never prove
    //    a limit it does not exceed, and the 205-row test below only proves
    //    "at most 200" -- this proves the number itself.
    expect(statements).toEqual([
      {
        sql: "SELECT foodbank_name, excess_change_text, created FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?",
        params: [200],
      },
    ]);
  });

  it("writes nothing: a GET of a read-only dashboard runs no INSERT, UPDATE or DELETE", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    await page();

    // Cheap, and the repo has already shipped a GET route able to run an
    // UPDATE. The row-level version of the same claim is the id/created
    // re-read below.
    expect(statements.every((s) => /^SELECT /.test(s.sql))).toBe(true);
    const untouched = db.prepare("SELECT id, excess_change_text, published, created FROM foodbankchange").all();
    expect(untouched).toEqual([
      { id: 1, excess_change_text: "Rice", published: 1, created: "2026-09-01 10:00:00.000000" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Which rows reach the page
// ---------------------------------------------------------------------------

describe("which needs reach the table", () => {
  it("excludes an unpublished need even when it has excess text", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    // The excluded row is NEWER than the included one and would sort first,
    // so a lost `published = 1` shows up as a changed first row rather than
    // as nothing at all.
    seedNeed({ id: 1, fb: 1, excess: "Published rice", published: 1, created: django("2026-09-01T10:00:00") });
    seedNeed({ id: 2, fb: 1, excess: "Draft pasta", published: 0, created: django("2026-09-02T10:00:00") });
    freezeClock();

    const rendered = rows(await page());
    expect(rendered.map((r) => r.excess)).toEqual(["Published rice"]);
  });

  it("skips a need with no excess text -- most needs have none, and the column is nullable", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: null, published: 1, created: django("2026-09-02T10:00:00") });
    seedNeed({ id: 2, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    expect(rows(await page()).map((r) => r.excess)).toEqual(["Rice"]);
  });

  it("treats an empty string as nothing but whitespace as something", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "", published: 1, created: django("2026-09-02T10:00:00") });
    seedNeed({ id: 2, fb: 1, excess: "   ", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    // `{% if excess.excess_change_text %}` is a plain truthiness test in
    // both engines, so "" is dropped and "   " renders as a row of three
    // spaces. Ugly, and identical to what Django does -- pinned rather than
    // tidied, because tidying it here would be a divergence nobody asked for.
    expect(rows(await page()).map((r) => r.excess)).toEqual(["   "]);
  });

  it("takes 200 rows and no more, dropping the oldest", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    // Microseconds are zero-padded to three digits so the TEXT values sort
    // the way the numbers do -- "...000205" > "...000006". An unpadded "205"
    // would sort BELOW "99" and make this test agree with a broken LIMIT.
    for (let i = 1; i <= 205; i += 1) {
      seedNeed({
        id: i,
        fb: 1,
        excess: `row-${i}`,
        published: 1,
        created: `2026-01-01 00:00:00.000${String(i).padStart(3, "0")}`,
      });
    }
    freezeClock();

    const rendered = rows(await page());
    expect(rendered.length).toBe(200);
    expect(rendered[0]?.excess).toBe("row-205");
    expect(rendered[199]?.excess).toBe("row-6");
    // The five that fell off the end, asserted absent rather than merely
    // not-checked: a LIMIT clause that did nothing would still pass a test
    // that only looked at the first row.
    const body = table(await page());
    for (const i of [1, 2, 3, 4, 5]) expect(body).not.toContain(`row-${i}<`);
  });

  it("a need with no excess text still spends one of the 200 slots, so a busy week can empty this page", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    // 200 newer needs with nothing in excess_change_text, then three older
    // ones that DO have some.
    for (let i = 1; i <= 200; i += 1) {
      seedNeed({ id: i, fb: 1, excess: null, published: 1, created: `2026-05-01 00:00:00.000${String(i).padStart(3, "0")}` });
    }
    for (let i = 201; i <= 203; i += 1) {
      seedNeed({ id: i, fb: 1, excess: `starved-${i}`, published: 1, created: `2026-04-01 00:00:00.00000${i - 200}` });
    }
    freezeClock();

    // The page comes back EMPTY. The LIMIT is applied by SQL over all
    // published needs; the "has excess text" filter is applied afterwards by
    // the template. That is exactly what Django does -- `[:200]` on the
    // queryset, `{% if %}` in the template -- so it is pinned as parity, not
    // as a wish. It is also the single most surprising thing about this
    // page, and a future "optimisation" that pushed the excess filter into
    // the WHERE clause would change what users see while every other test
    // in this file still passed.
    expect(rows(await page())).toEqual([]);
    expect(table(await page())).not.toContain("starved-");
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("ordering", () => {
  it("is newest first", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    // Inserted out of order on purpose: rowid order and created order
    // disagree, so an ORDER BY that silently stopped working would show up.
    seedNeed({ id: 1, fb: 1, excess: "middle", published: 1, created: django("2026-08-15T10:00:00") });
    seedNeed({ id: 2, fb: 1, excess: "oldest", published: 1, created: django("2026-07-01T10:00:00") });
    seedNeed({ id: 3, fb: 1, excess: "newest", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    expect(rows(await page()).map((r) => r.excess)).toEqual(["newest", "middle", "oldest"]);
  });

  it("sorts created as TEXT, so a 'T'-separated timestamp jumps above a genuinely newer Django one", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    // Both rows are 4 September 2026. The first was written by something
    // using toISOString() ("2026-09-04T10:00:00.000Z", 10:00); the second is
    // Django's own naive format at 23:00 -- thirteen hours LATER in real
    // time. `ORDER BY created DESC` is a string comparison: "T" is 0x54 and
    // " " is 0x20, so the T-form wins and the older need is listed first.
    //
    // NOT A WISH: this asserts the wrong-looking order because that is what
    // the page does today. It is here so that if a job ever starts writing
    // toISOString() into foodbankchange.created, the resulting mis-ordering
    // is a failing test with an explanation attached rather than a mystery
    // on a dashboard. See suspectedBugs.
    seedNeed({ id: 1, fb: 1, excess: "iso-T-form 10:00", published: 1, created: "2026-09-04T10:00:00.000Z" });
    seedNeed({ id: 2, fb: 1, excess: "django-form 23:00", published: 1, created: django("2026-09-04T23:00:00") });
    freezeClock();

    const rendered = rows(await page());
    expect(rendered.map((r) => r.excess)).toEqual(["iso-T-form 10:00", "django-form 23:00"]);
    // And the "Found" column proves it really is the older row on top: a day
    // versus eleven hours.
    expect(rendered.map((r) => r.found)).toEqual(["1 day ago", "11 hours ago"]);
  });
});

// ---------------------------------------------------------------------------
// The whole table, once, byte for byte
// ---------------------------------------------------------------------------

describe("the rendered table", () => {
  it("renders one row per need with excess text and nothing at all for the rest", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    seedNeed({ id: 2, fb: 1, excess: null, published: 1, created: django("2026-09-02T10:00:00") });
    freezeClock();

    // The whole <table>, whitespace included. Every other test here reads
    // <td>s out with a regex, which cannot see the STRUCTURE -- that the
    // header row is three <th>s in Django's order, that a skipped need emits
    // only blank lines rather than an empty <tr>, and that the "Found" cell
    // is the timesince text plus a literal " ago" from the template rather
    // than from the handler. One exact assertion covers all of that; the
    // blank-line runs below are the template's own `{% for %}`/`{% if %}`
    // whitespace and are what a browser actually receives.
    expect(table(await page())).toBe(
      '<table class="table is-narrow is-fullwidth">\n' +
        "            <tr>\n" +
        "                <th>Foodbank</th>\n" +
        "                <th>Excess</th>\n" +
        "                <th>Found</th>\n" +
        "            </tr>\n" +
        "            \n" +
        "                \n" +
        "            \n" +
        "                \n" +
        "                    <tr>\n" +
        '                        <td><a href="/needs/at/salisbury-foodbank/">Salisbury Foodbank</a></td>\n' +
        "                        <td>Rice</td>\n" +
        "                        <td>4 days ago</td>\n" +
        "                    </tr>\n" +
        "                \n" +
        "            \n" +
        "        </table>",
    );
  });

  it("renders the header row and no data rows when there are no needs at all", async () => {
    freezeClock();
    // A brand-new database, or a week where nothing was published. The page
    // must be a 200 with an empty table, not a 500 and not a blank body --
    // this is the state a fresh D1 is in, and the state the page reverts to
    // whenever the "spends a slot" behaviour above bites.
    const html = await page();
    expect(table(html)).toBe(
      '<table class="table is-narrow is-fullwidth">\n' +
        "            <tr>\n" +
        "                <th>Foodbank</th>\n" +
        "                <th>Excess</th>\n" +
        "                <th>Found</th>\n" +
        "            </tr>\n" +
        "            \n" +
        "        </table>",
    );
    expect(html).toContain("<h1>Excess</h1>");
    expect(html).toContain("<title>Excess - Give Food</title>");
  });
});

// ---------------------------------------------------------------------------
// The food bank link
// ---------------------------------------------------------------------------

describe("the food bank link", () => {
  it("builds the slug from the NAME, not from the foodbank.slug the view already carries", async () => {
    // A food bank whose real slug and whose slugified name disagree. In
    // production they nearly always agree, which is why this can go wrong
    // unnoticed: the handler calls slugify(row.foodbank_name) and never asks
    // for foodbank_slug, even though foodbankchange_full selects it.
    //
    // This is deliberate parity with Django, whose template calls
    // `{% url 'wfbn:foodbank' excess.foodbank_name_slug %}` and whose
    // FoodbankChange.foodbank_name_slug() (givefood/models/needs.py:90-91)
    // is `return slugify(self.foodbank_name)`. Read, not assumed.
    seedFoodbank(1, "Salisbury Foodbank", "a-completely-different-slug");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    const rendered = rows(await page());
    expect(rendered[0]?.link).toBe('<a href="/needs/at/salisbury-foodbank/">Salisbury Foodbank</a>');
    expect(rendered[0]?.link).not.toContain("a-completely-different-slug");
  });

  it("drops non-ASCII letters from the slug, which Django's slugify would have transliterated", async () => {
    seedFoodbank(1, "Café & Sons Foodbank", "cafe-sons-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    // packages/models slugify() is `[^a-z0-9]+ -> "-"`, so "Café" becomes
    // "caf". Django's slugify NFKD-normalises first and yields
    // "cafe-sons-foodbank" -- run here, on this machine, against the Django
    // 5.2.6 in /Users/jasoncartwright/Sites/foodcharity:
    //
    //     >>> slugify('Café & Sons Foodbank')
    //     'cafe-sons-foodbank'
    //
    // so the port emits a link to a page that does not exist. The slugify
    // header comment acknowledges the ASCII-only scope (PLAN.md R7); this
    // pins the consequence on THIS page rather than leaving it theoretical.
    // Current behaviour, not desired -- see suspectedBugs.
    expect(rows(await page())[0]?.link).toBe('<a href="/needs/at/caf-sons-foodbank/">Café &amp; Sons Foodbank</a>');
  });

  it("renders an empty name and a link to /needs/at// when the food bank row is gone", async () => {
    seedFoodbank(2, "Since Deleted Foodbank", "since-deleted");
    seedNeed({ id: 1, fb: 2, excess: "Orphaned excess", published: 1, created: django("2026-09-01T10:00:00") });
    db.prepare("DELETE FROM foodbank WHERE id = 2").run();
    freezeClock();

    // foodbankchange_full LEFT JOINs, so foodbank_name comes back NULL and
    // slugify("") is "". The row still renders -- it has excess text -- as
    // an empty anchor pointing at /needs/at//.
    //
    // Django did not do this: its foodbank_name is a denormalised CharField
    // that keeps the old name, and slugify(None) is 'none' there (run on
    // this machine against Django 5.2.6: `slugify(None)` -> `'none'`), so
    // the original showed the name and linked to /needs/at/none/. Both are
    // broken links; only the port's is invisible. See suspectedBugs.
    const rendered = rows(await page());
    expect(rendered).toEqual([{ link: '<a href="/needs/at//"></a>', excess: "Orphaned excess", found: "4 days ago" }]);
  });

  it("shows the food bank's CURRENT name, because the name comes through the view's join", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    db.prepare("UPDATE foodbank SET name = 'Salisbury & District Foodbank' WHERE id = 1").run();
    freezeClock();

    // Migration 0019 dropped foodbankchange.foodbank_name and replaced it
    // with the join in foodbankchange_full. The observable difference is
    // precisely this: a renamed food bank's old needs now say the new name.
    // If someone reintroduced a cached column, this row would still say
    // "Salisbury Foodbank" and nothing else here would notice.
    expect(rows(await page())[0]?.link).toBe(
      '<a href="/needs/at/salisbury-district-foodbank/">Salisbury &amp; District Foodbank</a>',
    );
  });

  it("HTML-escapes the food bank name", async () => {
    seedFoodbank(1, 'Ampersand & <script>alert("x")</script> Foodbank', "ampersand");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    // The name is operator-entered free text and reaches an HTML page. The
    // env is built with autoescape: true; this asserts that no SafeString or
    // |safe has crept in between here and the template.
    const link = rows(await page())[0]?.link as string;
    expect(link).not.toContain("<script>");
    expect(link).toBe(
      '<a href="/needs/at/ampersand-script-alert-x-script-foodbank/">Ampersand &amp; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Foodbank</a>',
    );
  });
});

// ---------------------------------------------------------------------------
// The excess text
// ---------------------------------------------------------------------------

describe("the excess column", () => {
  it("turns CRLF, bare CR and LF all into a single <br>", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    // Real scraped need text arrives with all three: the CRLF from the
    // address column's own note in migration 0001 is the same class of data.
    // A CRLF that produced TWO <br>s would double-space every list on the
    // page, which looks like a styling bug and is not one.
    seedNeed({ id: 1, fb: 1, excess: "a\r\nb\rc\nd", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    // Django's linebreaksbr normalises newlines first
    // (re.sub(r"\r\n|\r|\n", "\n", ...)) then replaces; run on this machine
    // against Django 5.2.6, `linebreaksbr('a\r\nb\rc\nd')` returns
    // 'a<br>b<br>c<br>d' -- the same bytes asserted here, <br> and not
    // <br />.
    expect(rows(await page())[0]?.excess).toBe("a<br>b<br>c<br>d");
  });

  it("escapes the text before inserting the <br>s, so markup in a need cannot reach the page", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice & <b>Soup</b>\n\"q\" it's", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    // Excess text is scraped from third-party food bank websites -- the one
    // field on this page an attacker could plausibly influence. The <br> is
    // real markup and the rest is not.
    //
    // NOTE the apostrophe: this port emits &#39; where Django emits &#x27;
    // (run here against Django 5.2.6). Same character, different spelling,
    // no behavioural difference -- pinned so the divergence is recorded
    // rather than rediscovered.
    expect(rows(await page())[0]?.excess).toBe("Rice &amp; &lt;b&gt;Soup&lt;/b&gt;<br>&quot;q&quot; it&#39;s");
  });
});

// ---------------------------------------------------------------------------
// The Found column
// ---------------------------------------------------------------------------

describe("the Found column", () => {
  it("is Django's timesince: at most two adjacent units, joined with a comma, non-breaking inside each", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "two units", published: 1, created: django("2026-09-01T11:00:00") });
    seedNeed({ id: 2, fb: 1, excess: "one unit", published: 1, created: django("2026-09-04T10:00:00") });
    seedNeed({ id: 3, fb: 1, excess: "months", published: 1, created: django("2026-06-20T10:00:00") });
    freezeClock(); // 2026-09-05T10:00:00Z

    // The U+00A0 between number and word is Django's avoid_wrapping(), not a
    // stray character: a "3 days" that wrapped across two lines in the table
    // is exactly what it exists to prevent. Asserting a plain space here
    // would pass against a port that dropped it.
    expect(rows(await page()).map((r) => r.found)).toEqual([
      "1 day ago",
      "3 days, 23 hours ago",
      "2 months, 2 weeks ago",
    ]);
  });

  it("says '0 minutes ago' for a need created exactly now, and for one dated in the future", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "now", published: 1, created: django("2026-09-05T10:00:00") });
    seedNeed({ id: 2, fb: 1, excess: "future", published: 1, created: django("2027-01-01T00:00:00") });
    freezeClock();

    // timesince()'s `sinceSeconds <= 0` branch. A future `created` is not
    // hypothetical: a food bank site with a clock ahead of UTC, or a
    // hand-edited row, produces one, and the alternative to this branch is
    // a negative count rendered as "-4 months ago".
    expect(rows(await page()).map((r) => r.found)).toEqual(["0 minutes ago", "0 minutes ago"]);
  });

  it("renders 'NaN years, NaN months ago' for a created value it cannot parse -- suspect, pinned as-is", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "unparseable", published: 1, created: "not a date" });
    seedNeed({ id: 2, fb: 1, excess: "empty created", published: 1, created: "" });
    freezeClock();

    // created is TEXT with no CHECK constraint, so anything can be in it.
    // timesince()'s parseUtc does arithmetic on Number(undefined) and the
    // NaN propagates all the way onto the page. It does NOT throw, so the
    // page stays a 200 and the damage is one nonsense cell -- which is why
    // this has never been noticed.
    //
    // Asserting the nonsense, deliberately: a test demanding "unknown" here
    // would be red on a codebase that does not do that. See suspectedBugs.
    //
    // The ORDER is a second consequence of lexicographic sorting: "not a
    // date" begins with "n" (0x6e), above every "2" (0x32), so a corrupt row
    // sorts to the TOP of a page of real ones, and "" sorts to the bottom.
    expect(rows(await page())).toEqual([
      { link: '<a href="/needs/at/salisbury-foodbank/">Salisbury Foodbank</a>', excess: "unparseable", found: "NaN years, NaN months ago" },
      { link: '<a href="/needs/at/salisbury-foodbank/">Salisbury Foodbank</a>', excess: "empty created", found: "NaN years, NaN months ago" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

describe("the HTTP surface", () => {
  it("is a 200 HTML page with the site's public page cache headers", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    const res = await get("/dashboard/excess/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    // middleware/pageCacheControl.ts has no /dashboard/ family, so this page
    // falls through to its SECONDS_IN_DAY default. Django's `excess` view
    // was decorated @cache_page(SECONDS_IN_HOUR) -- 3600, read from
    // gfdash/views.py:338 and givefood/const/cache_times.py:4 -- so the edge
    // now holds this page 24x longer than the original did. Pinned as the
    // current value; see suspectedBugs.
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=86400");
  });

  it("answers HEAD with the same headers and an empty body", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    const res = await get("/dashboard/excess/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toBe("");
  });

  it("does not answer POST at all", async () => {
    freezeClock();
    // gfdash/urls.py registers a plain function view, and index.ts registers
    // app.get -- no app.all, no form on the page. A POST must not reach the
    // handler, and must not touch the database.
    const res = await get("/dashboard/excess/", { method: "POST" });
    expect(res.status).toBe(404);
    expect(statements).toEqual([]);
  });

  it("301s the un-slashed path to the canonical trailing-slash one, at the cost of one full render", async () => {
    seedFoodbank(1, "Salisbury Foodbank", "salisbury-foodbank");
    seedNeed({ id: 1, fb: 1, excess: "Rice", published: 1, created: django("2026-09-01T10:00:00") });
    freezeClock();

    // Django's APPEND_SLASH, ported as lib/appendSlash.ts and reached from
    // app.notFound(). Asserted here because gfdash sits outside
    // i18n_patterns and its own routing is easy to get subtly wrong.
    const res = await get("/dashboard/excess");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://www.givefood.org.uk/dashboard/excess/");

    // And the price of that redirect, recorded rather than assumed:
    // tryAppendSlashRedirect decides by re-fetching the slashed URL with a
    // HEAD, which runs this handler for real -- so an un-slashed hit costs a
    // D1 query and a full Nunjucks render whose body is then thrown away. A
    // crawler that never uses trailing slashes doubles this page's read
    // load, invisibly. Current behaviour; see suspectedBugs.
    expect(statements).toEqual([
      {
        sql: "SELECT foodbank_name, excess_change_text, created FROM foodbankchange_full WHERE published = 1 ORDER BY created DESC LIMIT ?",
        params: [200],
      },
    ]);
  });

  it("404s a locale-prefixed path, because gfdash is outside i18n_patterns", async () => {
    freezeClock();
    // givefood/urls.py's "Untranslated apps" block: gfdash is registered
    // outside i18n_patterns, so /cy/dashboard/excess/ was never a URL. The
    // port's route loop deliberately skips the locale prefixes for this app
    // (index.ts:542-544); this is the assertion that it really did.
    expect((await get("/cy/dashboard/excess/")).status).toBe(404);
    expect((await get("/gd/dashboard/excess/")).status).toBe(404);
    expect(statements).toEqual([]);
  });
});
