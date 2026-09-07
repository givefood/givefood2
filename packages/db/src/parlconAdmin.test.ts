// @ts-ignore -- no @types/node under this package's tsconfig; vitest runs in node, where this module is real
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
// @ts-ignore -- ditto; the migration files are read off disk so the fixture cannot drift from production
import { beforeEach, describe, expect, it } from "vitest";
import { upsertParliamentaryConstituency } from "./parlconAdmin";
import type { Session } from "./types";

// The single write path behind /admin/parlcon/ and /admin/parlcon/<slug>/
// (routes/admin/parlcon.ts, itself gfadmin/views.py:2555-2576's
// `parlcon_form`). One exported function, two statements, and every way it
// can be wrong is a wrong ROW rather than an exception.
//
// WHY A REAL DATABASE, AND NOT A MOCK. This module contains no logic worth
// testing except the SQL and the slug -- a session handing back canned rows
// would agree with any mutant of either. The failures that matter here are
// all silent:
//
//   * the INSERT's column list and its VALUES tuple drifting apart by one,
//     so `mp` lands in `mp_party` and every constituency page shows the MP's
//     name where the party belongs. SQLite only complains when the COUNTS
//     differ, never when the order does;
//   * the UPDATE growing a column it has no business setting -- `pcon24cd`
//     is the one that would hurt, because /write/'s map looks constituencies
//     up by ONS code (getConstituencySlugByPcon24cd) and nothing else in the
//     codebase ever rewrites it. Wiping it on an MP-name edit breaks the map
//     for that constituency and raises nothing anywhere;
//   * `WHERE id = ?` losing its predicate, which rewrites all 650 rows.
//
// This package already carries exactly that scar: migration 0019 dropped
// columns off six tables, four queries went on naming them, and
// /dashboard/beautybanks/ was a live 500 that nobody noticed until it was
// measured. So the fixture below is THE MIGRATION FILES THEMSELVES, applied
// in order -- a CREATE TABLE transcribed into this file is a second copy of
// the truth and drifts the same way 0019's dropped columns did. The
// `parliamentaryconstituency` table this exercises is built by
// 0001_core.sql:129-137 and extended by 0011_constituency_pcon24cd.sql.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT TEST, so their absence is not
// mistaken for an oversight:
//
//   * D1's 100-bound-parameter statement limit. The INSERT binds exactly 9
//     values and the UPDATE exactly 10, both fixed-width -- no chunking, no
//     variable-length IN list, nothing that can approach the boundary. The
//     "binds nine / binds ten" cases below pin those counts, so if a future
//     change makes either variable, that is the moment to add at-and-over-100
//     cases.
//   * Timestamp ordering. `parliamentaryconstituency` has no created/modified
//     columns (unlike almost every other table in this schema), so there is no
//     TEXT datetime here to compare lexicographically and no Django
//     "2026-09-05 19:28:08.853000" format to get wrong.
//
// MUTATION-TESTED TWICE (TESTING.md's convention -- the evidence that a test
// is load-bearing rather than decoration). The module was copied out of the
// repo and broken in place, once when this file was written and again under
// adversarial review of it; sixty mutants have now been run, each in its own
// throwaway tree because reusing one directory let vite serve a cached
// transform of the previous mutant and report kills that had not happened.
//
// CAUGHT (fifty-seven): country/email, name/slug, country/mp, mp/mp_party,
// email/centroid, centroid/boundary_geojson, name/centroid and slug/email each
// swapped in the bind list, of the INSERT and of the UPDATE separately;
// country/email swapped in the INSERT's column list and in the UPDATE's SET
// list, and mp/mp_party swapped in the SET list -- the statements' own text
// rather than the values fed to it; the slug binding replaced with the name
// on both paths; the return value changed to the name
// and to the lowercased name; the UPDATE's WHERE made always-true, inverted to
// `IS NOT`, weakened to `!=` and to `>=`, and re-pointed at `slug`; the row id
// bound first instead of last; `pcon24cd`, `mp_display_name` and then
// latitude/longitude added to the SET list as NULL; `existingId === undefined`
// rewritten to `!existingId`, `== null`, `=== null`, `!== undefined` and to a
// typeof test; boundary_geojson dropped from the INSERT's column list, and
// separately from its bind list; and in slugify -- normalize deleted, changed
// to NFKC and to NFD; the ASCII strip deleted and widened; toLowerCase
// deleted; the hyphen dropped from the punctuation class; `\s` and then the
// hyphen dropped from the separator class; the collapse joined with "_"; the
// edge strip deleted, narrowed to each end alone, widened to eat interior
// underscores, and stopped from stripping "_"; and the ASCII, punctuation,
// separator and edge-strip regexes each stripped of their /g flag.
//
// THREE SURVIVED THE FIRST WRITING and are closed by tests added on review,
// each of which names the mutant it exists for:
//
//   * the UPDATE's `country` and `email` bindings swapped. Nine tests covered
//     the INSERT's column mapping and not one read either column back after an
//     edit -- see "rewrites all nine columns it names";
//   * `.replace(/[^\x00-\x7F]/g, "")` stripped of its /g. Every non-ASCII
//     whitespace case held exactly ONE such character, and one is all a
//     non-global replace removes -- see the doubled U+2028/U+2029 rows;
//   * the separator class narrowed from `[-\s]+` to `[\s]+`. No name under
//     test had a hyphen beside a space or another hyphen, so nothing needed
//     collapsing -- see "Mid Bedfordshire - Ampthill" and "Ynys--Mon".
//
// THREE MORE SURVIVE AND ARE EQUIVALENT MUTANTS rather than gaps -- recorded
// here because "a test should catch this" is the wrong conclusion for any of
// them. The first two were settled by running the mutant against the original
// over every code point in the BMP, not by reasoning about them:
//
//   * deleting `COMBINING_MARKS_RE` (parlconAdmin.ts:12), or narrowing its
//     range, changes no output for any input, because every code point it
//     removes is above U+007F and the ASCII strip on the next line removes
//     them anyway. It is dead code. See the composed/decomposed case below;
//   * widening that ASCII strip to `[^\x00-\xFF]` likewise changes nothing:
//     every Latin-1 character it would newly admit is either folded by NFKD
//     first (U+00A0 becomes a plain space) or dropped by `[^\w\s-]` a line
//     later, because JS's `\w` is ASCII-only;
//   * wrapping the `mp_parl_id` binding in String() changes no output either,
//     because SQLite's INTEGER affinity converts "5122" back to 5122 on the
//     way in. See that test's own note.


// ===========================================================================
// HARNESS
// ===========================================================================

type Bindable = null | number | bigint | string;

interface SqliteStatement {
  run(...params: Bindable[]): { changes: number };
  all(...params: Bindable[]): Array<Record<string, unknown>>;
  get(...params: Bindable[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface Executed {
  sql: string;
  params: Bindable[];
}

// The same adapter as constituencies.test.ts / adminStats.test.ts, so every
// tier drives the real code through one shape rather than three. Deliberately
// dumb -- it never inspects or rewrites the SQL, it hands the statement
// straight to SQLite, which is the entire point of the exercise.
//
// `first`/`all` are wired even though this module only ever calls `run`: if
// the upsert is ever rewritten to use `RETURNING id` (as foodbankAdmin.ts's
// insertFoodbank already does) the harness keeps working instead of failing
// with a confusing undefined-is-not-a-function.
function d1Session(database: SqliteDatabase, executed: Executed[]): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => statement(sql, next as Bindable[]),
    first: async <T>() => {
      executed.push({ sql, params });
      return (database.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async () => {
      executed.push({ sql, params });
      return { results: database.prepare(sql).all(...params), success: true, meta: {} };
    },
    run: async () => {
      executed.push({ sql, params });
      database.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    getBookmark: () => null,
  } as unknown as Session;
}

let db: SqliteDatabase;
let session: Session;
let executed: Executed[];

beforeEach(() => {
  db = new DatabaseSync(":memory:") as SqliteDatabase;
  db.exec(SCHEMA);
  executed = [];
  session = d1Session(db, executed);
});

// ===========================================================================
// SEEDS AND READBACK
// ===========================================================================

interface ExistingRow {
  id: number;
  name?: string | null;
  slug?: string;
  country?: string | null;
  mp?: string | null;
  mpParty?: string | null;
  mpParlId?: number;
  mpDisplayName?: string | null;
  email?: string | null;
  centroid?: string;
  latitude?: number | null;
  longitude?: number | null;
  boundaryGeojson?: string | null;
  pcon24cd?: string | null;
}

// A row as the production table actually holds one, INCLUDING the four
// columns the upsert never names. Those four are the whole point of the
// preservation cases below, so the seed must fill them -- a fixture that left
// mp_display_name/latitude/longitude/pcon24cd NULL would let a widened UPDATE
// pass by writing NULL over NULL.
function seedExisting(row: ExistingRow): void {
  db.prepare(
    `INSERT INTO parliamentaryconstituency
       (id, name, slug, country, mp, mp_party, mp_parl_id, mp_display_name, email,
        centroid, latitude, longitude, boundary_geojson, pcon24cd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name === undefined ? "Mid Bedfordshire" : row.name,
    row.slug ?? "mid-bedfordshire",
    row.country === undefined ? "England" : row.country,
    row.mp === undefined ? "Blake Stephenson" : row.mp,
    row.mpParty === undefined ? "Conservative" : row.mpParty,
    row.mpParlId ?? 5122,
    row.mpDisplayName === undefined ? "Mr Blake Stephenson MP" : row.mpDisplayName,
    row.email === undefined ? "blake.stephenson.mp@parliament.uk" : row.email,
    row.centroid ?? "52.0406,-0.4269",
    row.latitude === undefined ? 52.0406 : row.latitude,
    row.longitude === undefined ? -0.4269 : row.longitude,
    row.boundaryGeojson === undefined ? '{"type":"Feature"}' : row.boundaryGeojson,
    row.pcon24cd === undefined ? "E14001309" : row.pcon24cd,
  );
}

function rowById(id: number): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM parliamentaryconstituency WHERE id = ?").get(id);
}

function allRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM parliamentaryconstituency ORDER BY id").all();
}

function tableColumns(): string[] {
  return db
    .prepare("SELECT name FROM pragma_table_info('parliamentaryconstituency')")
    .all()
    .map((r) => r.name as string);
}

// The columns a statement NAMES, read out of the SQL the module actually
// issued. Reading the row back proves the values landed somewhere right; this
// proves the statement did not quietly acquire a tenth column that happens to
// be written with the value it already had.
function insertColumns(sql: string): string[] {
  const open = sql.indexOf("(");
  return sql
    .slice(open + 1, sql.indexOf(")", open))
    .split(",")
    .map((part) => part.trim());
}

function updateColumns(sql: string): string[] {
  return sql
    .slice(sql.search(/\bSET\b/) + 3, sql.search(/\bWHERE\b/))
    .split(",")
    .map((part) => part.split("=")[0]!.trim())
    .filter(Boolean);
}

const only = (calls: Executed[]): Executed => {
  expect(calls).toHaveLength(1);
  return calls[0]!;
};

// A real 2024 constituency, with every field a DIFFERENT and recognisable
// value. Not decoration: the failure this fixture exists to catch is a column
// list and a VALUES tuple that have drifted apart, and SQLite accepts that
// silently as long as the counts still match. Two fields holding "England"
// and "Conservative" could be swapped without a test noticing; "England" and
// "Reform UK" cannot.
const MID_BEDS = {
  name: "Mid Bedfordshire",
  country: "England",
  mp: "Blake Stephenson",
  mpParty: "Conservative",
  mpParlId: 5122,
  email: "blake.stephenson.mp@parliament.uk",
  centroid: "52.0406,-0.4269",
  boundaryGeojson: '{"type":"Feature","properties":{"PCON24NM":"Mid Bedfordshire"}}',
};

describe("upsertParliamentaryConstituency -- create", () => {
  // Every column, one assertion each, because the mutant that matters is a
  // SHIFT: name `slug` in the column list without adding a matching value to
  // .bind() and the bound array is unchanged while every column from there on
  // moves along by one. Checking only that "the row exists" or that the name
  // is right would pass that happily.
  it("writes each field into its own column", async () => {
    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);

    const rows = allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe("Mid Bedfordshire");
    expect(row.slug).toBe("mid-bedfordshire");
    expect(row.country).toBe("England");
    expect(row.mp).toBe("Blake Stephenson");
    expect(row.mp_party).toBe("Conservative");
    expect(row.mp_parl_id).toBe(5122);
    expect(row.email).toBe("blake.stephenson.mp@parliament.uk");
    expect(row.centroid).toBe("52.0406,-0.4269");
    expect(row.boundary_geojson).toBe(MID_BEDS.boundaryGeojson);
  });

  // `mp_parl_id` is `INTEGER NOT NULL` (0001_core.sql:132) and Django's
  // IntegerField (political.py:22), and it is the ONLY thing the MP photo URL
  // is built from -- `photos.givefood.org.uk/2024-mp/%s.jpg`. So this pins
  // that it arrives back as a JS number rather than as text, which is what
  // every consumer downstream assumes.
  //
  // HONEST LIMIT, because it was measured rather than hoped: wrapping the
  // binding in String() and re-running this file changes nothing. SQLite's
  // INTEGER affinity converts a bound "5122" into the integer 5122 on the way
  // in, so for any value the route can produce (it parseInt's and
  // Number.isInteger-guards first) the two are indistinguishable from the
  // outside. The second assertion is the part that is NOT equivalent, and it
  // is the one worth knowing: affinity only converts what looks numeric, so
  // `INTEGER NOT NULL` accepts "not-an-mp" as TEXT without complaint. The
  // column is not a guard -- routes/admin/parlcon.ts:48-49's Number.isInteger
  // check is the only thing standing between the admin form and an MP id that
  // renders a broken photo on the constituency page.
  it("stores mp_parl_id as an integer -- but the column would take anything", async () => {
    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);
    expect(typeof rowById(1)!.mp_parl_id).toBe("number");
    expect(rowById(1)!.mp_parl_id).toBe(5122);

    await upsertParliamentaryConstituency(
      session,
      { ...MID_BEDS, name: "Ynys Môn", mpParlId: "not-an-mp" as unknown as number },
      undefined,
    );
    expect(rowById(2)!.mp_parl_id).toBe("not-an-mp");
  });

  // The four columns no form field feeds. Each is left alone for its own
  // reason and each would be a different bug if that changed:
  //
  //  * latitude/longitude -- a DELIBERATE divergence from Django, which
  //    derives both from `centroid` on every save (models/political.py:158-163
  //    `self.latitude = self.centroid.split(",")[0]`). The port does not, and
  //    the module header explains why: 0001_core.sql:134 records that 646 of
  //    650 production rows have them NULL, and every reader parses `centroid`
  //    instead (latt()/long(), ConstituencyRow's own column comments). Checked
  //    rather than assumed -- no query in packages/db or workers/site reads
  //    either column for anything, and the gfapi2 `constituencies` endpoint
  //    does not emit them. Pinned here so that if someone "restores parity" by
  //    writing them, the divergence is a decision rather than a surprise.
  //  * mp_display_name -- editable=False in Django too (political.py:23), so
  //    ParliamentaryConstituencyForm never posted it either. Written by the
  //    constituency loader, not by this form.
  //  * pcon24cd -- genuinely new data added by 0011, backfilled from
  //    parlcon.json, and not on the admin form at all. See the create-path
  //    gap noted on the next test.
  it("leaves the four columns no form field feeds as NULL", async () => {
    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);

    const row = rowById(1)!;
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
    expect(row.mp_display_name).toBeNull();
    expect(row.pcon24cd).toBeNull();
  });

  // SUSPECT, pinned rather than fixed. A constituency created through this
  // form has no ONS code, so getConstituencySlugByPcon24cd (constituencies.ts
  // :77) can never resolve it -- which is precisely the lookup PLAN.md §6.9 R7
  // introduced so /write/'s map would stop deriving slugs client-side. The
  // constituency is reachable by slug and invisible to the map. Not a Django
  // parity break (Django never stored pcon24cd), and not reachable for the 650
  // backfilled rows, but a real gap for any 651st.
  it("cannot be given an ONS code -- pcon24cd is not a field this function writes", async () => {
    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);

    expect(insertColumns(only(executed).sql)).not.toContain("pcon24cd");
    expect(
      db.prepare("SELECT slug FROM parliamentaryconstituency WHERE pcon24cd = ?").get("E14001309"),
    ).toBeUndefined();
  });

  // NULL, never "". Django's own model declares country/mp/mp_party/email as
  // `null=True, blank=True` (political.py:18-24) and parseAdminFields already
  // hands every empty optional field to this function as null, so the empty
  // string must not be reintroduced here: `boundary_geojson IS NOT NULL` is
  // how adminLists.ts:200 decides whether a constituency HAS a boundary, and
  // an empty string would pass that filter and claim a boundary that is not
  // there.
  it("stores NULL, not an empty string, for every optional field left blank", async () => {
    await upsertParliamentaryConstituency(
      session,
      { ...MID_BEDS, country: null, mp: null, mpParty: null, email: null, boundaryGeojson: null },
      undefined,
    );

    const row = rowById(1)!;
    expect(row.country).toBeNull();
    expect(row.mp).toBeNull();
    expect(row.mp_party).toBeNull();
    expect(row.email).toBeNull();
    expect(row.boundary_geojson).toBeNull();
    // The required three survive the blanking of everything around them.
    expect(row.name).toBe("Mid Bedfordshire");
    expect(row.centroid).toBe("52.0406,-0.4269");
    expect(row.mp_parl_id).toBe(5122);
  });

  // The return value is the SLUG, not the name and not the id. Nothing in
  // routes/admin/parlcon.ts reads it today (it redirects to the list either
  // way), so a mutant returning `params.name` would be invisible in
  // production until the first caller that trusts the signature -- for
  // instance one wanting to redirect to the constituency it just saved.
  it("returns the slug it stored, not the name it was given", async () => {
    const returned = await upsertParliamentaryConstituency(session, MID_BEDS, undefined);

    expect(returned).toBe("mid-bedfordshire");
    expect(returned).toBe(rowById(1)!.slug);
  });

  // A create must ADD a row, not replace the one already there. INSERT with
  // no explicit id lets SQLite assign max(rowid)+1, so the existing row keeps
  // its id and its data; an INSERT OR REPLACE, or an id bound into the
  // statement, would silently overwrite a constituency.
  it("adds a row and leaves the existing rows untouched", async () => {
    seedExisting({ id: 7, name: "Ynys Môn", slug: "ynys-mon", pcon24cd: "W07000041" });

    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);

    const rows = allRows();
    expect(rows.map((r) => r.slug)).toEqual(["ynys-mon", "mid-bedfordshire"]);
    expect(rows[0]!.id).toBe(7);
    expect(rows[0]!.pcon24cd).toBe("W07000041");
    expect(rows[1]!.id).toBe(8);
  });

  // ONE statement, not two. Every sibling admin upsert in this package is
  // preceded by a uniqueness pre-flight -- foodbankNameTaken/foodbankSlugTaken
  // (foodbankAdmin.ts), locationNameTaken/locationSlugTaken, the donation
  // point pair -- all added for github #12 ("500 adding a location with the
  // same name as an existing location"). This module has none, and it does not
  // need one: `parlcon_slug_idx` is a plain index, not a UNIQUE one, and
  // `parlcon_pcon24cd_uniq` only covers a column this function never writes,
  // so no constraint here can turn into a 500. Asserted so that the asymmetry
  // reads as a decision; the duplicate-slug consequence is pinned below.
  it("issues exactly one statement -- there is no uniqueness pre-flight", async () => {
    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);

    expect(executed).toHaveLength(1);
    expect(executed[0]!.sql).toContain("INSERT INTO parliamentaryconstituency");
    expect(executed[0]!.sql).not.toContain("SELECT");
  });
});

describe("upsertParliamentaryConstituency -- slug derivation", () => {
  const slugFor = async (name: string): Promise<string> =>
    upsertParliamentaryConstituency(session, { ...MID_BEDS, name }, undefined);

  // TESTING.md's rule: parity claims are checked by RUNNING Python, not by
  // reasoning about it. Every expectation in this table was produced by
  // calling `django.template.defaultfilters.slugify` (Django 5.2.6, the
  // version foodcharity runs) on the left-hand string and pasting the result
  // -- the same function models/political.py:158 calls in save(). The port's
  // slugify was then run over the identical list in node and agreed on all of
  // them, including the awkward ones below.
  //
  // The stakes: this slug is the row's ADDRESS. /needs/in/constituency/<slug>/,
  // the constituency geo.json, the MP photo redirect and the admin's own edit
  // URL all resolve through it, so a slugify that diverges from Django's by one
  // character 404s a constituency that exists.
  it.each([
    // Every real 2024 constituency name that stresses a different branch.
    ["Mid Bedfordshire", "mid-bedfordshire"],
    // The only non-ASCII name in the 650: NFKD + drop-non-ASCII, not a
    // transliteration table. PLAN.md §6.9 R7 exists because wfbn.js's
    // browser-side table had no entry for "ŵ" and silently 404'd.
    ["Ynys Môn", "ynys-mon"],
    // Apostrophe deleted outright, not turned into a separator: "queens",
    // never "queen-s".
    ["Queen's Park and Maida Vale", "queens-park-and-maida-vale"],
    // Comma deleted, then the space beside it collapses -- one hyphen, not two.
    ["Harborough, Oadby and Wigston", "harborough-oadby-and-wigston"],
    // Existing hyphens survive as hyphens rather than being doubled or eaten.
    ["Weston-super-Mare", "weston-super-mare"],
    ["Na h-Eileanan an Iar", "na-h-eileanan-an-iar"],
    ["Ashton-under-Lyne", "ashton-under-lyne"],
  ])("slugifies %j to %j exactly as Django's slugify does", async (name, expected) => {
    expect(await slugFor(name)).toBe(expected);
  });

  // The edges Django's slugify has and a naive `.replace(/ /g,"-")` does not.
  // Each was likewise run through CPython before being written down.
  it.each([
    ["  Leading and trailing  ", "leading-and-trailing"],
    ["Double  space", "double-space"],
    ["---dashes---", "dashes"],
    // strip("-_") takes underscores off the ENDS only -- an interior one is a
    // \w character and survives.
    ["_underscore_", "underscore"],
    ["North_East Somerset", "north_east-somerset"],
    // \s is not just the space character.
    ["Tab\there", "tab-here"],
    ["newline\nname", "newline-name"],
    // NFKD is COMPATIBILITY decomposition, so these fold rather than vanish.
    ["ﬁnchley", "finchley"],
    ["Ａｌｄｒｉｄｇｅ", "aldridge"],
    ["Ⅻ Roman", "xii-roman"],
    // ...but only where a decomposition exists. "ß" has none under NFKD and
    // "Æ" is not decomposed either, so both are simply dropped -- "strae" and
    // "thelred", not "strasse" and "aethelred". Ugly, and exactly what Django
    // does.
    ["Straße", "strae"],
    ["Æthelred Ward", "thelred-ward"],
    ["Cities of London & Westminster", "cities-of-london-westminster"],
    ["Mid Bedfordshire (new)", "mid-bedfordshire-new"],
    // KILLS the mutant that narrows the separator class from `[-\s]+` to
    // `[\s]+`. Nothing else in this file puts a hyphen BESIDE a space or
    // beside another hyphen -- "Weston-super-Mare" and "Ashton-under-Lyne"
    // have no adjacency to collapse, and "---dashes---" is rescued by the
    // edge strip -- so that one-character deletion survived the first writing
    // of this file. Without the hyphen in the class the first of these becomes
    // "mid-bedfordshire---ampthill" and the second "ynys--mon": a URL Django
    // never produced, and a 404 at the constituency's own address. Both
    // expectations came out of Django 5.2.6, like every other row here.
    ["Mid Bedfordshire - Ampthill", "mid-bedfordshire-ampthill"],
    ["Ynys--Mon", "ynys-mon"],
  ])("slugifies %j to %j, matching CPython", async (name, expected) => {
    expect(await slugFor(name)).toBe(expected);
  });

  // THE ONLY THING `.replace(/[^\x00-\x7F]/g, "")` ACTUALLY DOES, established
  // by deleting it and re-running this file: everything else it appears to
  // handle is already handled by `[^\w\s-]`, because JS's `\w` is ASCII-only
  // (no `u` flag, no Unicode property escapes) and so drops "ß", "Æ" and "北"
  // on its own. What survives `[^\w\s-]` is non-ASCII WHITESPACE, because JS's
  // `\s` matches nineteen characters beyond the ASCII ones -- and of those,
  // NFKD leaves exactly four undecomposed: U+1680, U+2028, U+2029 and U+FEFF
  // (enumerated in CPython over the whole JS `\s` set, not guessed). Every
  // other one, U+00A0 and U+2000-U+200A included, becomes a plain U+0020 under
  // NFKD, which is why the NBSP case below yields a hyphen and the other three
  // do not.
  //
  // Django reaches the same answers by a different route -- its
  // `.encode("ascii", "ignore")` removes them outright -- so the two agree
  // that the words JOIN rather than being separated. All four expectations
  // were produced by running Django 5.2.6's slugify. Without the ASCII strip
  // the port returns "ynys-mon" for the first of them: a different URL for the
  // same constituency, and a 404.
  //
  // Written as escapes rather than pasted characters: three of the four are
  // invisible, and a source file carrying them literally is one careless
  // editor save away from silently becoming a different test.
  it.each([
    ["U+2028 line separator", "Ynys\u2028Mon", "ynysmon"],
    ["U+1680 ogham space mark", "Ogham\u1680Space", "oghamspace"],
    ["U+FEFF zero-width no-break space", "Feff\uFEFFJoin", "feffjoin"],
    // The contrast case, and the reason the rule is about NFKD rather than
    // about whitespace in general: U+00A0 DOES decompose to a plain U+0020,
    // so it survives as a separator and yields a hyphen. Django agrees.
    ["U+00A0 no-break space", "North\u00A0East", "north-east"],
    // TWO occurrences, and that is the entire reason these last two rows
    // exist. Every row above holds exactly ONE of these characters, and one is
    // all a non-global replace removes -- so deleting the /g from
    // `.replace(/[^\x00-\x7F]/g, "")` passed the whole file when it was first
    // written. With two, the second survives the strip, is still matched by
    // `\s` in the punctuation class below, and comes out as a hyphen:
    // "ynysmo-n" rather than "ynysmon", which is a different constituency URL.
    ["U+2028 twice", "Ynys\u2028Mo\u2028n", "ynysmon"],
    // U+2029 is the fourth member of the set the note above enumerates and the
    // one no single-character row ever exercised.
    ["U+2029 twice", "Para\u2029Break\u2029Here", "parabreakhere"],
  ])("drops %s, joining the words as Django does", async (_label, name, expected) => {
    expect(await slugFor(name)).toBe(expected);
  });

  // DEAD CODE, recorded so nobody re-derives it. `COMBINING_MARKS_RE`
  // (parlconAdmin.ts:12) strips U+0300-U+036F after NFKD -- but every one of
  // those code points is above U+007F, so the ASCII strip on the very next
  // line removes them anyway. Deleting the line changes no output for any
  // input, including the accented ones above; it was tried. Harmless, and it
  // mirrors the shape of the same helper in locationsAdmin.ts /
  // donationPointsAdmin.ts, so it is left alone -- but no test in this file
  // can fail if it goes, and pretending otherwise would be a test that lies.
  it("produces the same slug for the composed and decomposed spellings of Ynys Môn", async () => {
    // U+00F4 against "o" + U+0302 (combining circumflex): two byte sequences
    // for the one real constituency, both of which an admin's copy-paste can
    // produce, and which must not become two rows at two URLs. Escaped rather
    // than pasted, because the two spellings are identical on screen and an
    // editor that normalised this file would quietly delete the test.
    expect(await slugFor("Ynys M\u00F4n")).toBe("ynys-mon");
    expect(await slugFor("Ynys Mo\u0302n")).toBe("ynys-mon");
  });

  // Documented, not endorsed, and identical to the gap locationsAdmin.test.ts
  // pins for locationSlug: a name with no ASCII word characters slugifies to
  // the empty string, which is stored (the column is NOT NULL, and "" is not
  // NULL) and makes the row's every URL unroutable. Django's slugify returns
  // "" for the same input, so this is a faithful port of a real defect rather
  // than a new one. PARLCON_FIELDS marks `name` required, which stops the
  // blank-name route to the same place but not this one.
  it("stores an empty slug for a name with no ASCII word characters", async () => {
    expect(await slugFor("北京")).toBe("");
    expect(rowById(1)!.slug).toBe("");
  });

  // SUSPECT, pinned. Django's `slug` is CharField(max_length=50) over a
  // Postgres varchar(50), so a name whose slug exceeded 50 characters raised
  // on save. SQLite TEXT has no length ceiling, so the port takes it silently.
  // Inert for now -- the longest real 2024 slug is 40 characters
  // ("birmingham-hodge-hill-and-solihull-north"), measured over all 650 names
  // in parlcon.json -- but it means the port accepts rows the source database
  // would have refused, and `name` itself is likewise max_length=50 in Django
  // with no equivalent check anywhere in PARLCON_FIELDS.
  it("stores a slug longer than Django's varchar(50) would have allowed", async () => {
    const slug = await slugFor("A".repeat(80));

    expect(slug).toHaveLength(80);
    expect(rowById(1)!.slug).toHaveLength(80);
  });

  // Two different names, one slug, and no error -- because parlcon_slug_idx
  // (0001_core.sql:137) is a plain index. The consequence is worth stating
  // where someone will find it: getConstituencyBySlug does `WHERE slug = ?`
  // ... `.first()`, so one of these two constituencies becomes unreachable at
  // /needs/in/constituency/queens-park-and-maida-vale/ AND at its own admin
  // edit URL, with no error anywhere. Django is no better -- its slug is not
  // unique either -- so this is an inherited hazard, not a port regression,
  // and it is the reason the "no uniqueness pre-flight" case above is worth
  // reading twice.
  it("accepts a second constituency whose name slugifies to an existing slug", async () => {
    await slugFor("Queen's Park and Maida Vale");
    await slugFor("Queens Park and Maida Vale");

    expect(allRows().map((r) => r.slug)).toEqual(["queens-park-and-maida-vale", "queens-park-and-maida-vale"]);
    // The index really is non-unique -- if it ever becomes UNIQUE this test
    // fails first and explains why, rather than the admin returning a 500.
    const index = db
      .prepare("SELECT name, \"unique\" FROM pragma_index_list('parliamentaryconstituency')")
      .all()
      .find((r) => r.name === "parlcon_slug_idx");
    expect(index!.unique).toBe(0);
  });
});

describe("upsertParliamentaryConstituency -- edit", () => {
  it("updates the addressed row in place, keeping its id", async () => {
    seedExisting({ id: 7 });

    await upsertParliamentaryConstituency(
      session,
      { ...MID_BEDS, mp: "Alistair Strathern", mpParty: "Labour", mpParlId: 5109 },
      7,
    );

    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(7);
    expect(rows[0]!.mp).toBe("Alistair Strathern");
    expect(rows[0]!.mp_party).toBe("Labour");
    expect(rows[0]!.mp_parl_id).toBe(5109);
  });

  // THE EDIT PATH'S OWN COLUMN MAPPING, and the mutant that got past this
  // file's first writing: swap `params.country` and `params.email` in the
  // UPDATE's bind list and every other test here still passed, because not
  // one of them read either column back after an edit. The create path was
  // covered ("writes each field into its own column"); the UPDATE, which is a
  // separately hand-maintained bind list of ten, was not. The result would be
  // a constituency page showing "blake.stephenson.mp@parliament.uk" as the
  // country and "England" as the MP's contact address -- wrong on the page,
  // wrong in the gfapi2 payload, and raising nothing anywhere.
  //
  // So this is the deliberate mirror of the create case: all nine written
  // columns, each handed a value the seeded row does NOT already hold, each
  // read back. A swap or a one-place shift anywhere in the UPDATE's bindings
  // fails here, and the test above stays as it is because an MP correction
  // that touches only the three MP fields is the edit that actually happens.
  it("rewrites all nine columns it names, each into its own column", async () => {
    seedExisting({ id: 7 });

    await upsertParliamentaryConstituency(
      session,
      {
        name: "Ynys Môn",
        country: "Wales",
        mp: "Llinos Medi",
        mpParty: "Plaid Cymru",
        mpParlId: 5326,
        email: "llinos.medi.mp@parliament.uk",
        centroid: "53.2707,-4.3126",
        boundaryGeojson: '{"type":"Feature","properties":{"PCON24NM":"Ynys Môn"}}',
      },
      7,
    );

    const row = rowById(7)!;
    expect(row.name).toBe("Ynys Môn");
    expect(row.slug).toBe("ynys-mon");
    expect(row.country).toBe("Wales");
    expect(row.mp).toBe("Llinos Medi");
    expect(row.mp_party).toBe("Plaid Cymru");
    expect(row.mp_parl_id).toBe(5326);
    expect(row.email).toBe("llinos.medi.mp@parliament.uk");
    expect(row.centroid).toBe("53.2707,-4.3126");
    expect(row.boundary_geojson).toBe('{"type":"Feature","properties":{"PCON24NM":"Ynys Môn"}}');
  });

  // The `WHERE id = ?` predicate itself. Three rows, one edited: a dropped or
  // always-true WHERE clause rewrites all 650 constituencies to whichever one
  // the admin happened to open, and the admin's own screen would look
  // completely normal afterwards. Seeded either side of the target so an
  // off-by-one in the binding is caught too.
  it("touches only the addressed row", async () => {
    seedExisting({ id: 6, name: "Luton North", slug: "luton-north", mp: "Sarah Owen", pcon24cd: "E14001309" });
    seedExisting({ id: 7, name: "Mid Bedfordshire", slug: "mid-bedfordshire", pcon24cd: "E14001343" });
    seedExisting({ id: 8, name: "Ynys Môn", slug: "ynys-mon", mp: "Llinos Medi", pcon24cd: "W07000041" });
    const before = allRows();

    await upsertParliamentaryConstituency(session, { ...MID_BEDS, mp: "Alistair Strathern" }, 7);

    const after = allRows();
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(after[1]!.mp).toBe("Alistair Strathern");
  });

  // THE MIGRATION-0019 CASE, and the most valuable assertion in this file.
  // The UPDATE names nine columns; the table has thirteen besides the id. A
  // tenth assignment added by someone "keeping the statement in sync with the
  // form" would wipe whichever of these four it touched, silently:
  //
  //   pcon24cd  -- /write/'s map resolves constituencies by ONS code
  //                (getConstituencySlugByPcon24cd). Nothing else in either
  //                codebase ever rewrites this column, so once an MP-name edit
  //                clears it, it stays cleared.
  //   mp_display_name -- rendered on the constituency page; the loader's, not
  //                the form's, so an UPDATE that set it would overwrite the
  //                loader's value with a NULL the form never had.
  //   latitude/longitude -- vestigial, but the four production rows that DO
  //                have them are still four rows of real data.
  it("preserves the four columns it does not name", async () => {
    seedExisting({ id: 7, mpDisplayName: "Mr Blake Stephenson MP", latitude: 52.0406, longitude: -0.4269, pcon24cd: "E14001343" });

    await upsertParliamentaryConstituency(session, { ...MID_BEDS, mp: "Alistair Strathern" }, 7);

    const row = rowById(7)!;
    expect(row.pcon24cd).toBe("E14001343");
    expect(row.mp_display_name).toBe("Mr Blake Stephenson MP");
    expect(row.latitude).toBe(52.0406);
    expect(row.longitude).toBe(-0.4269);
    // Belt and braces on the statement as well as the row: the values above
    // could also survive an UPDATE that assigned each of them its own current
    // value, which is a different statement doing the same damage tomorrow.
    expect(updateColumns(only(executed).sql).sort()).toEqual([
      "boundary_geojson",
      "centroid",
      "country",
      "email",
      "mp",
      "mp_parl_id",
      "mp_party",
      "name",
      "slug",
    ]);
  });

  // A SECOND deliberate divergence from Django, and the one most likely to be
  // read as a bug. political.py:158-163's save() recomputes latitude and
  // longitude from centroid on EVERY save; this UPDATE moves the centroid and
  // leaves the two columns holding the old constituency's coordinates. Inert
  // because nothing reads them (see the create-path case above), but pinned so
  // the staleness is on the record: the row genuinely disagrees with itself
  // after this call.
  it("moves the centroid without updating the vestigial latitude/longitude beside it", async () => {
    seedExisting({ id: 7, centroid: "52.0406,-0.4269", latitude: 52.0406, longitude: -0.4269 });

    await upsertParliamentaryConstituency(session, { ...MID_BEDS, centroid: "53.2707,-4.3126" }, 7);

    const row = rowById(7)!;
    expect(row.centroid).toBe("53.2707,-4.3126");
    expect(row.latitude).toBe(52.0406);
    expect(row.longitude).toBe(-0.4269);
  });

  // Renaming a constituency moves its public URL, and NOTHING records the old
  // one. Django behaved identically -- save() recomputes the slug and its
  // SlugRedirect rows are hand-entered through a separate admin
  // (gfadmin/views.py:2276-2308) -- so this is parity, not an omission, and it
  // is asserted rather than assumed because "a rename should leave a redirect"
  // is the obvious wrong instinct for someone reading upsertSlugRedirect next
  // door.
  it("re-slugs on rename and leaves no slug redirect behind", async () => {
    seedExisting({ id: 7, name: "Mid Bedfordshire", slug: "mid-bedfordshire" });

    const slug = await upsertParliamentaryConstituency(session, { ...MID_BEDS, name: "Mid Bedfordshire and Ampthill" }, 7);

    expect(slug).toBe("mid-bedfordshire-and-ampthill");
    expect(rowById(7)!.slug).toBe("mid-bedfordshire-and-ampthill");
    expect(db.prepare("SELECT COUNT(*) AS n FROM slugredirect").get()!.n).toBe(0);
  });

  // Destructive and correct: the UPDATE always writes boundary_geojson, so a
  // null clears the stored boundary. That is what makes the form's textarea
  // able to remove a bad boundary at all, and it is also why PARLCON_FIELDS
  // must keep rendering the field prefilled -- an edit form that omitted it
  // would post an empty textarea and destroy up to ~1.6 MB of boundary on an
  // MP-name change. Pinned because the danger lives in the caller and this is
  // where the mechanism is.
  it("clears boundary_geojson when handed null", async () => {
    seedExisting({ id: 7, boundaryGeojson: '{"type":"Feature","properties":{}}' });

    await upsertParliamentaryConstituency(session, { ...MID_BEDS, boundaryGeojson: null }, 7);

    expect(rowById(7)!.boundary_geojson).toBeNull();
  });

  // Byte-for-byte, no re-encoding and no trimming. packages/serialise's
  // geojsonBoundary.ts is built entirely on what the stored text looks like:
  // it strips exactly one trailing comma (real, confirmed against the stored
  // row for bethnal-green-and-stepney), it splices property spans by string
  // index, and toDjangoJsonFormat re-escapes the literal non-ASCII bytes this
  // column holds (confirmed for Ynys Môn's stored "ô") into \uXXXX the way
  // json.dumps does. A save path that pretty-printed, trimmed or
  // JSON.parse/stringify'd the text would move the ground under all three.
  it("stores boundary_geojson verbatim, trailing comma and raw UTF-8 included", async () => {
    const stored = '{"type":"Feature","properties":{"PCON24NM":"Ynys Môn"},"geometry":{"type":"Polygon"}},';

    await upsertParliamentaryConstituency(session, { ...MID_BEDS, boundaryGeojson: stored }, undefined);

    expect(rowById(1)!.boundary_geojson).toBe(stored);
  });

  // The largest real boundary runs to ~1.6 MB (0001_core.sql:135). Nothing
  // here chunks or truncates, and this is the case that would notice if it
  // started to.
  it("stores a boundary far larger than any wire-format default would allow through", async () => {
    const big = `{"type":"Feature","coordinates":"${"0".repeat(250_000)}"}`;

    await upsertParliamentaryConstituency(session, { ...MID_BEDS, boundaryGeojson: big }, undefined);

    expect(rowById(1)!.boundary_geojson).toBe(big);
    expect((rowById(1)!.boundary_geojson as string).length).toBe(big.length);
  });

  // SUSPECT, pinned rather than fixed. An id that matches nothing updates
  // nothing, inserts nothing and still returns the slug as though the save
  // succeeded -- the caller has no way to tell a saved constituency from a
  // lost one. Unreachable from routes/admin/parlcon.ts today, which only ever
  // passes an id it just read back from getConstituencyBySlug in the same
  // request, but the function's own contract says nothing about that.
  it("silently does nothing when the id does not exist, and still returns a slug", async () => {
    seedExisting({ id: 7 });

    const slug = await upsertParliamentaryConstituency(session, { ...MID_BEDS, name: "Ynys Môn" }, 999);

    expect(slug).toBe("ynys-mon");
    expect(allRows()).toHaveLength(1);
    expect(rowById(7)!.name).toBe("Mid Bedfordshire");
  });

  // SUSPECT, pinned rather than fixed, and the sharpest edge in the module.
  // The branch is `existingId === undefined`, so a caller handing `null`
  // instead -- the shape a D1 `.first()` returns for "no row", and the shape a
  // JSON round trip turns undefined into -- takes the UPDATE path and issues
  // `WHERE id = NULL`. SQLite's `= NULL` is never true, so the statement
  // matches nothing: no update, no insert, no error, and a slug returned as if
  // it had worked. This is the same three-valued-logic trap that
  // slugRedirects.ts:62-69, locationsAdmin.ts:107 and donationPointsAdmin.ts:86
  // all document from the other direction (`id IS NOT ?`), and TypeScript is
  // the only thing standing in front of it -- hence the cast below, which is
  // how a `null` from untyped JSON or a loosened signature would arrive.
  //
  // Confirmed against real SQLite rather than reasoned about: the run below
  // leaves the seeded row unchanged and the table one row long.
  it("treats a null existingId as an edit of nothing, discarding the save", async () => {
    seedExisting({ id: 7 });

    const slug = await upsertParliamentaryConstituency(session, { ...MID_BEDS, name: "Ynys Môn" }, null as unknown as undefined);

    expect(slug).toBe("ynys-mon");
    expect(allRows()).toHaveLength(1);
    expect(rowById(7)!.name).toBe("Mid Bedfordshire");
    expect(only(executed).sql).toContain("UPDATE parliamentaryconstituency");
  });

  // The reason the branch is `=== undefined` and not `!existingId`. SQLite
  // rowids may legitimately be 0, and although no production row has that id
  // today, the falsy form would send an edit of row 0 down the INSERT path and
  // mint a duplicate constituency rather than updating the one on screen. One
  // character of difference, no error either way.
  it("takes the edit path for an existing id of 0", async () => {
    seedExisting({ id: 0, name: "Mid Bedfordshire", slug: "mid-bedfordshire" });

    await upsertParliamentaryConstituency(session, { ...MID_BEDS, name: "Ynys Môn" }, 0);

    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(0);
    expect(rows[0]!.name).toBe("Ynys Môn");
    expect(only(executed).sql).toContain("UPDATE parliamentaryconstituency");
  });
});

describe("upsertParliamentaryConstituency -- statement shape", () => {
  // The two counts D1 cares about. Both statements are fixed-width, so
  // neither can approach the 100-bound-parameter limit -- but if a future
  // change makes either variable (a chunked write, a built IN list), this is
  // the test that notices, and at-and-over-100 boundary cases become
  // necessary. Also the cheapest guard against the column/value drift the
  // create cases test from the row side: SQLite rejects a statement whose
  // bound count does not match its placeholder count, so a mismatch here is a
  // throw, not a wrong row.
  it("binds nine values on create and ten on edit", async () => {
    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);
    expect(only(executed).params).toHaveLength(9);
    expect(insertColumns(only(executed).sql)).toHaveLength(9);

    executed.length = 0;
    seedExisting({ id: 7 });
    await upsertParliamentaryConstituency(session, MID_BEDS, 7);
    const update = only(executed);
    expect(update.params).toHaveLength(10);
    expect(updateColumns(update.sql)).toHaveLength(9);
    // The tenth is the row id, and it is LAST -- a SET list that swallowed it
    // would be a statement writing the primary key.
    expect(update.params[9]).toBe(7);
  });

  // Schema-driven, so migration drift shows up here rather than in production.
  // The table has fourteen columns; this function writes nine of them and
  // deliberately leaves five (id + the four documented above). If migration
  // 0024 adds a column, this test names it and forces a decision about which
  // side of the line it belongs on -- which is exactly the check that would
  // have caught 0019 dropping five columns out from under four live queries.
  it("accounts for every column the real table has", async () => {
    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);
    const written = insertColumns(only(executed).sql);
    const untouched = ["id", "mp_display_name", "latitude", "longitude", "pcon24cd"];

    expect([...written, ...untouched].sort()).toEqual([...tableColumns()].sort());
  });

  // Both statements name the same nine columns in the same order. They are
  // separate SQL strings that have to stay in step by hand, and the failure
  // mode of them drifting is a field that saves on create and is quietly
  // ignored on every subsequent edit -- github #34's exact shape ("Location
  // admin form silently discards the Place ID it just looked up", which was an
  // INSERT and UPDATE that disagreed about one column).
  it("writes the same nine columns on create and on edit", async () => {
    await upsertParliamentaryConstituency(session, MID_BEDS, undefined);
    const created = insertColumns(only(executed).sql);

    executed.length = 0;
    seedExisting({ id: 7 });
    await upsertParliamentaryConstituency(session, MID_BEDS, 7);

    expect(updateColumns(only(executed).sql)).toEqual(created);
  });
});
