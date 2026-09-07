import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { getAllTranslationsForNeed, getNeedTranslation, getNeedTranslationsByIds, replaceNeedTranslation } from "./needTranslations";
import type { Session } from "./types";

// needTranslations.ts is the whole of the non-English site's "items needed"
// text. Every failure it can have is SILENT: get the language predicate
// wrong and a Welsh page shows Irish; get the need_id predicate wrong and it
// shows another food bank's list; lose the row entirely and resolveNeedText()
// (@givefood/models:235-239, `translatedText ? translatedText : rawText`)
// quietly falls back to English, which is exactly what the whole of migration
// 0006 exists to stop and looks identical to a page with no translation yet.
// Nothing 500s, nothing logs, and the only people who can see it are the
// readers who do not speak English.
//
// So this file runs the REAL SQL against a REAL SQLite database seeded from
// the REAL DDL. `foodbankchangetranslation` is created by
// migrations/0006_need_translations.sql and by nothing else -- a grep across
// all 23 migrations finds only that CREATE TABLE and its one index, no later
// ALTER and no DROP -- so the schema below is that file's DDL verbatim,
// copied the way frag.test.ts copies 0001/0003. Retyping a schema from
// NeedTranslationRow instead would make every assertion circular: the
// question these tests answer is whether the SQL in the module agrees with
// the schema in the migrations, and a fixture derived from the TypeScript
// cannot answer it.
//
// The scar this guards is on record in TESTING.md and in
// 0019_drop_foodbank_cache.sql: migration 0019 silently broke four queries
// and nobody noticed until someone measured /dashboard/beautybanks/.

// Verbatim from packages/db/migrations/0006_need_translations.sql:21-27. The
// index comes along because it is how SQLite actually ANSWERS both read
// queries -- (language, need_id) is a perfect cover for the WHERE clause of
// getNeedTranslation and the IN-scan of getNeedTranslationsByIds -- and
// because index order is what decides which row wins when a (need, language)
// pair has been written twice, pinned in the duplicate test below.
//
// NOTE THE NULLABILITY, because two of it diverge from Django and the
// divergence is only visible here: `foodbank_id` and `change_text` are both
// nullable in D1, where FoodbankChangeTranslation (needs.py:345-357) declares
// `foodbank = models.ForeignKey(...)` and `change_text = models.TextField()`
// -- neither with null=True, so Postgres refuses a NULL in either. D1 accepts
// both, which replaceNeedTranslation's tests below pin as real behaviour.
const SCHEMA = `
CREATE TABLE foodbankchangetranslation (
  id INTEGER PRIMARY KEY,
  need_id INTEGER NOT NULL, foodbank_id INTEGER,
  language TEXT NOT NULL,
  change_text TEXT, excess_change_text TEXT
);
CREATE INDEX fct_lang_need_idx ON foodbankchangetranslation(language, need_id);
`;

type Bindable = null | number | bigint | string | Uint8Array;

interface Recorded {
  sql: string;
  params: unknown[];
}

// The slice of the D1 Sessions API this package is handed, backed by
// node:sqlite. Copied from frag.test.ts (itself copied from
// workers/site/src/routes/admin/foodbankLocation.test.ts) so every tier drives
// the real code through one adapter, WITH ONE ADDITION: every prepared
// statement is recorded, SQL and bound parameters both, because the two things
// this module can get wrong that no row can show are the ROUND TRIP COUNT (its
// header claims "one D1 round trip regardless of how many need_ids") and the
// PARAMETER COUNT (D1 caps a statement at 100 bound parameters; node:sqlite's
// cap is 32,766, so the engine under the test will happily run a statement
// production rejects). Neither is observable from the rows that come back.
//
// It interprets nothing. It must not: a recorder that understood the SQL would
// be a second implementation of the thing under test, and the tests would then
// only prove the two agree.
//
// `first()` normalises undefined to null because that is what D1 answers for
// no row; node:sqlite's get() answers undefined.
function d1Session(db: DatabaseSync, calls: Recorded[]): Session {
  const statement = (record: Recorded) => ({
    bind: (...next: unknown[]) => {
      record.params = next;
      return statement(record);
    },
    first: async <T>() => (db.prepare(record.sql).get(...(record.params as Bindable[])) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(record.sql).all(...(record.params as Bindable[])), success: true, meta: {} }),
    run: async () => {
      db.prepare(record.sql).run(...(record.params as Bindable[]));
      return { success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => {
      const record: Recorded = { sql, params: [] };
      calls.push(record);
      return statement(record);
    },
    getBookmark: () => null,
  } as unknown as Session;
}

let db: DatabaseSync;
let session: Session;
let calls: Recorded[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  calls = [];
  session = d1Session(db, calls);
});

// Ids are explicit everywhere rather than autoincremented, because id order is
// insertion order is the order SQLite hands rows back within one index key --
// which is precisely what the duplicate-row tests below turn on. A test that
// let the engine pick the ids could not say which row it expected.
function seedTranslation(row: {
  id: number;
  needId: number;
  language: string;
  changeText?: string | null;
  excessChangeText?: string | null;
  foodbankId?: number | null;
}): void {
  db.prepare("INSERT INTO foodbankchangetranslation (id, need_id, foodbank_id, language, change_text, excess_change_text) VALUES (?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.needId,
    row.foodbankId ?? 7,
    row.language,
    row.changeText === undefined ? `change ${row.language} ${row.needId}` : row.changeText,
    row.excessChangeText === undefined ? `excess ${row.language} ${row.needId}` : row.excessChangeText,
  );
}

// Reads the table back with the module's queries deliberately NOT involved --
// a write test that verified itself through getAllTranslationsForNeed would
// pass just as happily if both the writer and the reader were wrong in the
// same direction.
function allRows(): Record<string, unknown>[] {
  return db.prepare("SELECT id, need_id, foodbank_id, language, change_text, excess_change_text FROM foodbankchangetranslation ORDER BY id").all() as Record<
    string,
    unknown
  >[];
}

// ===========================================================================
// getNeedTranslation -- the per-request, one-need lookup behind every
// cy/ga/gd food bank, location and donation point page
// (workers/site/src/lib/needDisplay.ts:38).
// ===========================================================================

describe("getNeedTranslation", () => {
  it("returns the change and excess text of the row for that need in that language", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy", changeText: "Ffa pob", excessChangeText: "Dim angen pasta" });

    // Object equality, not property spot-checks: change_text and
    // excess_change_text are two adjacent TEXT columns holding text of the
    // same shape, so a transposed projection reads perfectly and puts the
    // "they have too much of this" list under "items needed".
    expect(await getNeedTranslation(session, 42, "cy")).toEqual({ change_text: "Ffa pob", excess_change_text: "Dim angen pasta" });
  });

  // THE MUTANT: drop the `language = ?` predicate. Every test that seeds one
  // language passes, the page still renders text, and a Welsh reader gets
  // Irish -- the two rows here are the same need, so nothing about the
  // returned row looks wrong except the language nobody checks.
  it("is scoped by language: the same need's row in another locale is never returned", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy", changeText: "Welsh text" });
    seedTranslation({ id: 2, needId: 42, language: "ga", changeText: "Irish text" });
    seedTranslation({ id: 3, needId: 42, language: "gd", changeText: "Gaelic text" });

    expect((await getNeedTranslation(session, 42, "ga"))?.change_text).toBe("Irish text");
    expect((await getNeedTranslation(session, 42, "gd"))?.change_text).toBe("Gaelic text");
    expect((await getNeedTranslation(session, 42, "cy"))?.change_text).toBe("Welsh text");
  });

  // THE OTHER MUTANT: drop the `need_id = ?` predicate, and every food bank
  // on the site shows whichever need happens to sort first in the index.
  // Seeded lowest-id-first so a missing predicate returns need 41's row, not
  // a plausible-looking accident.
  it("is scoped by need: another need's row in the same locale is invisible", async () => {
    seedTranslation({ id: 1, needId: 41, language: "cy", changeText: "Some other food bank" });
    seedTranslation({ id: 2, needId: 42, language: "cy", changeText: "This food bank" });

    expect((await getNeedTranslation(session, 42, "cy"))?.change_text).toBe("This food bank");
  });

  // The binds are (language, needId) -- that order, because the WHERE clause
  // is `language = ? AND need_id = ?` and 0006's index is (language, need_id)
  // for the same reason. Transposing them binds a locale code to an INTEGER
  // column and a need id to a TEXT one, which SQLite does not error on: it
  // applies column affinity, matches nothing, and every non-English page
  // falls silently back to English. The row tests above would catch it too;
  // this asserts it directly so the failure names the cause.
  it("binds the language first and the need id second", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy" });

    await getNeedTranslation(session, 42, "cy");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual(["cy", 42]);
  });

  it("returns null when this need has no row in this locale", async () => {
    // A need translated into Welsh but not Irish is the ordinary state of the
    // database for weeks after a publish (three queue messages, three
    // independent Google Translate calls, any of which can fail), so this is
    // the common path, not the edge case.
    seedTranslation({ id: 1, needId: 42, language: "cy" });

    expect(await getNeedTranslation(session, 42, "ga")).toBeNull();
    expect(await getNeedTranslation(session, 99, "cy")).toBeNull();
  });

  // THE ONE STUBBED SESSION IN THIS FILE, and it is here because a
  // D1-faithful adapter cannot reach the branch. D1's `.first()` answers null
  // for no row, so `row ?? null` is dead code against real D1 -- but the
  // adapters in this package are the only other thing that ever calls it, and
  // node:sqlite's get() answers UNDEFINED. The `?? null` is what stops that
  // difference leaking into the return type, so the contract is "null, never
  // undefined" and it is pinned rather than assumed.
  it("normalises an undefined answer to null", async () => {
    const undefinedSession = {
      prepare: () => ({ bind: () => ({ first: async () => undefined }) }),
    } as unknown as Session;

    expect(await getNeedTranslation(undefinedSession, 42, "cy")).toBeNull();
  });

  it("preserves a NULL excess translation as null rather than an empty string", async () => {
    // translate_need() (general.py:203-221) only calls the API for excess text
    // when the need HAS excess text, and stores None otherwise -- so a null
    // here is the normal case, not corruption. It matters that it stays null
    // because resolveNeedText() branches on truthiness to decide whether to
    // fall back to the English text, and "" and null must behave alike; if a
    // future projection COALESCEd it to "" the fallback would still work but
    // the interface would be lying about the column.
    seedTranslation({ id: 1, needId: 42, language: "cy", changeText: "Ffa pob", excessChangeText: null });

    expect(await getNeedTranslation(session, 42, "cy")).toEqual({ change_text: "Ffa pob", excess_change_text: null });
  });

  it("projects exactly the two text columns, never the whole row", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy" });

    // NeedTranslationRow promises two fields. A `SELECT *` regression would
    // satisfy every other test in this describe while handing callers an
    // `id`/`language`/`foodbank_id` they did not ask for -- harmless today,
    // and exactly the kind of thing a later `{...translation}` spread turns
    // into a bug at a distance.
    expect(Object.keys((await getNeedTranslation(session, 42, "cy"))!).sort()).toEqual(["change_text", "excess_change_text"]);
  });

  // DUPLICATES ARE POSSIBLE AND THIS IS WHICH ONE WINS. There is no unique
  // constraint on (need_id, language) in D1 and none in Django either -- the
  // module's own header says so, and the dedup is purely "the write path
  // always clears first". But replaceNeedTranslation's DELETE and INSERT are
  // two separate statements with no transaction around them (pinned below),
  // so two translate-need queue messages for the same need and language --
  // an ordinary retry after a partial failure -- can interleave into two
  // surviving rows.
  //
  // When that happens this query has no ORDER BY and no LIMIT, so `.first()`
  // takes whatever the engine hands back first: scanning fct_lang_need_idx in
  // (language, need_id, rowid) order, that is the LOWEST id -- the OLDEST,
  // stalest row, which is the worse of the two to pick. Pinned as observed
  // behaviour, not as a guarantee the SQL makes; if a future engine or index
  // change flips it, this test failing is the notification.
  it("returns the OLDEST of two duplicate rows for the same need and language", async () => {
    seedTranslation({ id: 10, needId: 42, language: "cy", changeText: "stale translation" });
    seedTranslation({ id: 20, needId: 42, language: "cy", changeText: "fresh translation" });

    expect((await getNeedTranslation(session, 42, "cy"))?.change_text).toBe("stale translation");
  });
});

// ===========================================================================
// getNeedTranslationsByIds -- the batch lookup that keeps /wfbn/<lat>,<lng>/
// (workers/site/src/routes/wfbn/index.ts:120) to one round trip instead of
// one per row across three result lists.
// ===========================================================================

describe("getNeedTranslationsByIds", () => {
  it("keys the map by need_id, one entry per need it found", async () => {
    seedTranslation({ id: 1, needId: 10, language: "cy", changeText: "beans", excessChangeText: "pasta" });
    seedTranslation({ id: 2, needId: 11, language: "cy", changeText: "soup", excessChangeText: null });

    const map = await getNeedTranslationsByIds(session, [10, 11], "cy");

    expect([...map.keys()].sort((a, b) => a - b)).toEqual([10, 11]);
    expect(map.get(10)).toEqual({ change_text: "beans", excess_change_text: "pasta" });
    expect(map.get(11)).toEqual({ change_text: "soup", excess_change_text: null });
  });

  // THE GUARD THAT STOPS A 500. `IN ()` is a syntax error in SQLite, so
  // without the length check the empty-list case -- a locale page whose three
  // nearby lists are all empty, i.e. anywhere in the sea -- would throw out of
  // the route rather than render an empty page. The assertion that matters is
  // the second one: it must not reach the database at all.
  it("returns an empty map for an empty id list without preparing a statement", async () => {
    const map = await getNeedTranslationsByIds(session, [], "cy");

    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  // THE SILENT ONE. Drop the language predicate and the map is built from
  // rows in every locale -- and because `new Map(entries)` lets a later entry
  // overwrite an earlier one for the same key, the winner is whichever locale
  // the engine returned last. The Welsh page then shows Irish text for some
  // needs and Welsh for others, with nothing to distinguish the two.
  it("is scoped by language: rows for the same needs in other locales cannot leak in", async () => {
    seedTranslation({ id: 1, needId: 10, language: "cy", changeText: "cy ten" });
    seedTranslation({ id: 2, needId: 10, language: "ga", changeText: "ga ten" });
    seedTranslation({ id: 3, needId: 11, language: "gd", changeText: "gd eleven" });
    seedTranslation({ id: 4, needId: 11, language: "cy", changeText: "cy eleven" });

    const welsh = await getNeedTranslationsByIds(session, [10, 11], "cy");

    expect(welsh.get(10)?.change_text).toBe("cy ten");
    expect(welsh.get(11)?.change_text).toBe("cy eleven");

    // ASKED FOR TWO MORE LOCALES OFF THE SAME SEED, because a describe whose
    // every call passes "cy" cannot tell "filters on the language argument"
    // apart from "ignores it and binds the constant 'cy'". A
    // `.bind("cy", ...needIds)` mutant survived every other test in this file
    // for exactly that reason -- it is the shape a copy-paste between these
    // four near-identical functions produces, and it would pin the whole site
    // to Welsh while Irish and Gaelic readers silently got Welsh text.
    //
    // Each of these also asserts an ABSENCE: need 11 has no Irish row and
    // need 10 has no Gaelic one, so the other locale's row for that same need
    // must not be substituted in.
    const irish = await getNeedTranslationsByIds(session, [10, 11], "ga");
    expect(irish.get(10)?.change_text).toBe("ga ten");
    expect(irish.has(11)).toBe(false);

    const gaelic = await getNeedTranslationsByIds(session, [10, 11], "gd");
    expect(gaelic.get(11)?.change_text).toBe("gd eleven");
    expect(gaelic.has(10)).toBe(false);
  });

  it("excludes needs that were not asked for", async () => {
    seedTranslation({ id: 1, needId: 10, language: "cy" });
    seedTranslation({ id: 2, needId: 99, language: "cy" });

    const map = await getNeedTranslationsByIds(session, [10], "cy");

    expect([...map.keys()]).toEqual([10]);
  });

  // The caller reads this with `needTranslations?.get(row.latest_need_id)
  // ?.change_text` and hands the result to resolveNeedText(), whose
  // undefined-means-fall-back-to-English branch is the entire point. An
  // absent id must therefore be ABSENT, not present with a null value: a
  // Map.get() of undefined is what that chain is written against.
  it("omits ids that have no row in this locale rather than mapping them to null", async () => {
    seedTranslation({ id: 1, needId: 10, language: "cy" });

    const map = await getNeedTranslationsByIds(session, [10, 11], "cy");

    expect(map.has(11)).toBe(false);
    expect(map.get(11)).toBeUndefined();
  });

  it("rebuilds each value without the need_id it was keyed by", async () => {
    seedTranslation({ id: 1, needId: 10, language: "cy" });

    const map = await getNeedTranslationsByIds(session, [10], "cy");

    // The SELECT has to fetch need_id to key the map, but the value must not
    // carry it: NeedTranslationRow is the same interface getNeedTranslation
    // returns, and the two are used interchangeably by resolveNeedText's
    // callers. If the raw row were stored, the two shapes would drift apart
    // silently and only the one nobody spreads would keep working.
    expect(Object.keys(map.get(10)!).sort()).toEqual(["change_text", "excess_change_text"]);
  });

  // THE ONE PROJECTION IN THIS MODULE THAT NO RETURNED VALUE CAN POLICE. The
  // other two functions hand their rows out as SQLite built them, so a
  // `SELECT *` regression shows up in Object.keys() of the result and both of
  // their describes catch it. This one rebuilds every value by hand from
  // three named fields, so the test directly above passes just as happily on
  // `SELECT *` -- that mutant survived the entire file.
  //
  // It is not free. This is the batch query, and the whole reason it exists
  // is one bounded round trip for a list page: at the 99 ids the test below
  // pins, `SELECT *` drags a full `id` and `foodbank_id` per row across the
  // wire to be discarded by the very next line. The recorded SQL is the only
  // place that is observable, so it is asserted there.
  it("selects only the three columns it uses, never the whole row", async () => {
    seedTranslation({ id: 1, needId: 10, language: "cy" });

    await getNeedTranslationsByIds(session, [10], "cy");

    expect(calls[0]!.sql).toContain("SELECT need_id, change_text, excess_change_text FROM foodbankchangetranslation");
  });

  // THE DUPLICATE WINNER, AND IT IS THE OPPOSITE OF getNeedTranslation'S.
  // Same table, same two rows, same locale: up there `.first()` takes the
  // row the engine hands back first, which scanning fct_lang_need_idx in
  // (language, need_id, rowid) order is the LOWEST id -- the stale one. Here
  // every row comes back and `new Map(entries)` gives each key to the LAST
  // entry it sees, which is the HIGHEST id -- the fresh one.
  //
  // So a need whose (need, language) pair has been written twice -- reachable
  // because replaceNeedTranslation's DELETE and INSERT are two unwrapped
  // statements, pinned in that describe -- renders the stale text on the
  // detail page (needDisplay.ts:38, getNeedTranslation) and the fresh text on
  // the list page linking to it (wfbn/index.ts:120, this function). Two
  // different translations of one need on two pages, no error on either.
  // Pinned as observed behaviour, not endorsed; reported as a suspected bug.
  //
  // MUTANTS THIS KILLS, both of which survived every other test in this file
  // because neither changes a map size, a key set or a round-trip count:
  // `[...result.results].reverse()` before the map is built, and adding an
  // `ORDER BY id DESC` to the query. Either silently swaps which of two
  // duplicates a Welsh reader is shown.
  it("keeps the NEWEST of two duplicate rows, where the single lookup keeps the oldest", async () => {
    seedTranslation({ id: 10, needId: 42, language: "cy", changeText: "stale translation" });
    seedTranslation({ id: 20, needId: 42, language: "cy", changeText: "fresh translation" });

    const map = await getNeedTranslationsByIds(session, [42], "cy");

    expect(map.size).toBe(1);
    expect(map.get(42)?.change_text).toBe("fresh translation");
    // Asserted side by side, from the same two seeded rows, so the asymmetry
    // is impossible to read past: whichever of the two ever becomes the
    // intended behaviour, this line is where the other one is written down.
    expect((await getNeedTranslation(session, 42, "cy"))?.change_text).toBe("stale translation");
  });

  it("takes one round trip however many ids it is given", async () => {
    for (let needId = 1; needId <= 30; needId += 1) seedTranslation({ id: needId, needId, language: "cy" });

    const map = await getNeedTranslationsByIds(session, Array.from({ length: 30 }, (_, i) => i + 1), "cy");

    // The module's header promises "one D1 round trip regardless of how many
    // need_ids are asked for" -- this is the assertion that keeps the promise
    // honest if someone later rewrites it as a loop, which would still return
    // an identical map while turning one query into thirty.
    expect(map.size).toBe(30);
    expect(calls).toHaveLength(1);
  });

  it("does not dedupe the id list, so a repeated id costs a placeholder", async () => {
    seedTranslation({ id: 1, needId: 10, language: "cy" });
    seedTranslation({ id: 2, needId: 11, language: "cy" });

    const map = await getNeedTranslationsByIds(session, [10, 10, 11], "cy");

    // wfbn/index.ts:114-119 builds its list through `new Set([...])` because
    // one food bank can appear in more than one of its three lists. That Set
    // is the caller's, not this function's -- pinned here so a future caller
    // that skips it knows it is paying for the duplicates in bound
    // parameters, which is the resource this function is actually short of.
    expect(calls[0]!.params).toEqual(["cy", 10, 10, 11]);
    expect(map.size).toBe(2);
  });

  // ---- D1's 100-bound-parameter ceiling -------------------------------
  //
  // This is the sharpest edge in the module, and it is one id earlier than
  // anyone will assume: the statement binds the LANGUAGE as well as the ids,
  // so N ids is N+1 parameters and the last legal call is 99 ids, not 100.
  // Nothing in the signature says so, there is no chunking (needAdmin.ts:307
  // -330 slices its id lists at 90 for exactly this reason), and node:sqlite
  // -- limit 32,766 -- runs the over-cap statement perfectly happily, so no
  // test that only looks at returned rows can see the ceiling at all. Hence
  // the parameter counts.
  //
  // The only live caller tops out at 60 ids (three 20-row lists through a
  // Set, wfbn/index.ts:78-80), so this is a landmine rather than a live bug.
  // Raising those 20s to 34 crosses the line. Pinned as what the code DOES,
  // not as a red test for chunking it does not have.
  it("binds exactly one parameter per id plus one for the language", async () => {
    seedTranslation({ id: 1, needId: 10, language: "cy" });

    await getNeedTranslationsByIds(session, [10, 11, 12], "cy");

    expect(calls[0]!.sql).toContain("IN (?, ?, ?)");
    expect(calls[0]!.params).toHaveLength(4);
  });

  it("sits exactly on D1's cap at 99 ids -- one fewer than the round number", async () => {
    const ids = Array.from({ length: 99 }, (_, i) => i + 1);
    for (const needId of ids) seedTranslation({ id: needId, needId, language: "cy", changeText: `need ${needId}` });

    const map = await getNeedTranslationsByIds(session, ids, "cy");

    expect(calls[0]!.params).toHaveLength(100);
    expect(map.size).toBe(99);
    expect(map.get(99)?.change_text).toBe("need 99");
  });

  it("builds a single over-cap statement at 100 ids instead of chunking", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    for (const needId of ids) seedTranslation({ id: needId, needId, language: "cy", changeText: `need ${needId}` });

    const map = await getNeedTranslationsByIds(session, ids, "cy");

    // 101 parameters in one statement: legal here, rejected by D1.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toHaveLength(101);
    expect(map.size).toBe(100);
    // ...and the mapping still holds at that size, which is what a future
    // chunked implementation is most likely to lose.
    expect(map.get(1)?.change_text).toBe("need 1");
    expect(map.get(100)?.change_text).toBe("need 100");
  });
});

// ===========================================================================
// replaceNeedTranslation -- the write path, driven by the translate-need
// queue consumer (workers/jobs/src/queues/translateNeed.ts:43), one message
// per language per publish.
// ===========================================================================

describe("replaceNeedTranslation", () => {
  it("inserts the row, mapping each parameter to the column of the same name", async () => {
    await replaceNeedTranslation(session, {
      needId: 42,
      foodbankId: 7,
      language: "cy",
      changeText: "Ffa pob",
      excessChangeText: "Dim angen pasta",
    });

    // Every column asserted, with values that cannot be confused for one
    // another. The INSERT names five columns and binds five parameters
    // positionally; need_id/foodbank_id are both INTEGER and
    // change_text/excess_change_text are both TEXT, so either pair could be
    // transposed without SQLite complaining and without any read query
    // noticing. Only a read-back of distinguishable values catches it.
    expect(allRows()).toEqual([
      { id: 1, need_id: 42, foodbank_id: 7, language: "cy", change_text: "Ffa pob", excess_change_text: "Dim angen pasta" },
    ]);
  });

  // THE MUTANT THAT LOSES EVERY TRANSLATION ON THE SITE: swap the two
  // statements. Insert-then-delete leaves ZERO rows -- the DELETE matches the
  // row the INSERT just wrote -- and every non-English page silently falls
  // back to English while the queue reports success. Asserting "exactly one
  // row, and it holds the new text" kills it; asserting only "the new row
  // exists" would not.
  it("replaces an existing translation rather than adding a second one", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy", changeText: "old Welsh text", excessChangeText: "old Welsh excess" });

    await replaceNeedTranslation(session, { needId: 42, foodbankId: 7, language: "cy", changeText: "new Welsh text", excessChangeText: null });

    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.change_text).toBe("new Welsh text");
    expect(rows[0]!.excess_change_text).toBeNull();
  });

  it("deletes before it inserts, in two separate statements", async () => {
    await replaceNeedTranslation(session, { needId: 42, foodbankId: 7, language: "cy", changeText: "text", excessChangeText: null });

    // TWO statements, not a session.batch() and not a transaction -- which is
    // why the duplicate rows getNeedTranslation's last test pins are reachable
    // at all: two retries of the same queue message can interleave as
    // DELETE, DELETE, INSERT, INSERT. Recorded here so that the day someone
    // wraps these in a batch, the test that describes the old hazard is the
    // thing that fails and points at it.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toMatch(/^DELETE FROM foodbankchangetranslation/);
    expect(calls[0]!.params).toEqual([42, "cy"]);
    expect(calls[1]!.sql).toMatch(/^INSERT INTO foodbankchangetranslation/);
    expect(calls[1]!.params).toEqual([42, 7, "cy", "text", null]);
  });

  // The DELETE is scoped to (need_id, language), which is the whole reason
  // translate_need() can be re-run for one language without disturbing the
  // other two. Widen it to `need_id = ?` alone -- an easy simplification to
  // make while reading the code -- and publishing a need would leave it with
  // exactly one translation, the last queue message to land, out of three.
  it("leaves the same need's other locales alone", async () => {
    seedTranslation({ id: 1, needId: 42, language: "ga", changeText: "Irish text" });
    seedTranslation({ id: 2, needId: 42, language: "gd", changeText: "Gaelic text" });

    await replaceNeedTranslation(session, { needId: 42, foodbankId: 7, language: "cy", changeText: "Welsh text", excessChangeText: null });

    expect(allRows().map((row) => [row.language, row.change_text])).toEqual([
      ["ga", "Irish text"],
      ["gd", "Gaelic text"],
      ["cy", "Welsh text"],
    ]);
  });

  // The other half of the same predicate. Drop `need_id = ?` and republishing
  // one food bank's need wipes the Welsh translation of every need in the
  // country -- ~24,000 rows, restorable only from a Postgres re-extract.
  it("leaves other needs' rows in the same locale alone", async () => {
    seedTranslation({ id: 1, needId: 41, language: "cy", changeText: "another food bank" });

    await replaceNeedTranslation(session, { needId: 42, foodbankId: 7, language: "cy", changeText: "this food bank", excessChangeText: null });

    expect(allRows().map((row) => [row.need_id, row.change_text])).toEqual([
      [41, "another food bank"],
      [42, "this food bank"],
    ]);
  });

  it("clears every duplicate for the pair, not just one of them", async () => {
    // The DELETE has no LIMIT, so a pair that has somehow been written twice
    // is repaired by the next publish rather than growing. That self-healing
    // is the only thing standing between the missing unique constraint and a
    // table that accumulates a stale row per retry, so it is worth a test of
    // its own.
    seedTranslation({ id: 1, needId: 42, language: "cy", changeText: "duplicate one" });
    seedTranslation({ id: 2, needId: 42, language: "cy", changeText: "duplicate two" });

    await replaceNeedTranslation(session, { needId: 42, foodbankId: 7, language: "cy", changeText: "the survivor", excessChangeText: null });

    expect(allRows().map((row) => row.change_text)).toEqual(["the survivor"]);
  });

  // DIVERGENCE FROM DJANGO, PINNED BECAUSE IT IS SILENT. Django's
  // FoodbankChangeTranslation.save() (needs.py:355-357) sets
  // `self.foodbank = self.need.foodbank` unconditionally, and the FK is NOT
  // NULL, so Postgres could never hold a translation with no food bank. D1's
  // column is nullable (0006:23) and this function takes `foodbankId: number
  // | null` straight from the need, whose own foodbank_id is nullable -- so a
  // need with no food bank produces a translation row with no food bank, and
  // the write succeeds. Nothing reads foodbank_id off this table today (the
  // only other query on it is needAdmin.ts:171's COUNT by need_id), so this
  // is inert rather than broken; it is pinned so that the first query to add
  // a `foodbank_id = ?` predicate discovers the nulls here rather than in a
  // dashboard total that is quietly short.
  it("stores a null foodbank_id, which Django's NOT NULL FK could not hold", async () => {
    await replaceNeedTranslation(session, { needId: 42, foodbankId: null, language: "cy", changeText: "text", excessChangeText: null });

    expect(allRows()[0]!.foodbank_id).toBeNull();
  });

  // Same shape of divergence, one column over: Django's `change_text =
  // models.TextField()` has no null=True, so Postgres rejects a NULL, but
  // translateNeed.ts passes whatever translateText() returned and that is
  // `null` whenever Google's response is shaped unexpectedly. D1 accepts it.
  // The consequence is not a crash: resolveNeedText() treats a null
  // translation as falsy and shows the English text, so the page is right and
  // the row is a permanently-useless placeholder -- the failure is invisible
  // by construction, which is why it is asserted rather than assumed.
  it("stores a null change_text, which Django's NOT NULL column could not hold", async () => {
    await replaceNeedTranslation(session, { needId: 42, foodbankId: 7, language: "cy", changeText: null, excessChangeText: null });

    expect(allRows()[0]!.change_text).toBeNull();
  });

  // THE WHOLE DESCRIBE WRITES NEED 42 IN cy, which leaves it collectively
  // unable to tell "binds its arguments" from "binds the constants 42 and
  // 'cy'". Three mutants proved that, all three passing every other test in
  // this file:
  //
  //   * `.bind(42, params.language)` on the DELETE and 42 on the INSERT --
  //     every republish writes onto one need forever;
  //   * 42 on the INSERT alone, so the DELETE clears the right row and the
  //     replacement lands on the wrong need -- the translation is DESTROYED
  //     and a bogus one appears elsewhere, the worst of the three;
  //   * `"cy"` on the INSERT, so a Gaelic translation is stored as Welsh,
  //     overwriting the Welsh text on the next read while Gaelic falls back
  //     to English.
  //
  // This writes a DIFFERENT need in a DIFFERENT locale, over a row that
  // already exists for that exact pair, with the 42/cy row every other test
  // uses present and expected to be untouched -- so all three land somewhere
  // the assertion can see.
  it("binds the need and language it was given, not the ones every other test uses", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy", changeText: "the 42/cy row every other test writes" });
    seedTranslation({ id: 2, needId: 8801, language: "gd", changeText: "old Gaelic" });

    await replaceNeedTranslation(session, { needId: 8801, foodbankId: 3, language: "gd", changeText: "new Gaelic", excessChangeText: null });

    expect(allRows().map((row) => [row.need_id, row.language, row.change_text])).toEqual([
      [42, "cy", "the 42/cy row every other test writes"],
      [8801, "gd", "new Gaelic"],
    ]);
  });

  it("lets SQLite assign the id, so repeated writes do not collide", async () => {
    await replaceNeedTranslation(session, { needId: 42, foodbankId: 7, language: "cy", changeText: "first", excessChangeText: null });
    await replaceNeedTranslation(session, { needId: 42, foodbankId: 7, language: "ga", changeText: "second", excessChangeText: null });

    // The INSERT names five columns and leaves `id` out, which is what makes
    // it safe to run once per language per publish. Ported rows keep their
    // Postgres ids (extract_core.py:329-336 carries `id` across), so this
    // matters: new rows have to land above them without being told where.
    expect(allRows().map((row) => row.id)).toEqual([1, 2]);
  });
});

// ===========================================================================
// getAllTranslationsForNeed -- gfadmin/views.py:2011-2020's read-only
// "every stored translation for this need" viewer
// (workers/site/src/routes/admin/needs.ts:389).
// ===========================================================================

describe("getAllTranslationsForNeed", () => {
  // ORDER BY language, which Django does NOT have: need_translations() passes
  // `FoodbankChangeTranslation.objects.filter(need=need)` with no ordering and
  // no Meta.ordering on the model, so Postgres returns them in whatever order
  // it likes. The port sorts, which is a deliberate improvement over an
  // unordered queryset rather than a parity break -- and the sort is the one
  // thing here a mutation would silently remove, so it is seeded in reverse
  // (gd, ga, cy by insertion, therefore by rowid) to make sure the expected
  // order is not just insertion order wearing a disguise.
  //
  // Byte-wise vs linguistic collation (types.ts:28-33) makes no difference
  // for two-letter lowercase codes: 'cy' < 'ga' < 'gd' either way.
  //
  // ALL THREE COLUMNS SORT THREE DIFFERENT WAYS ON PURPOSE, so this proves
  // the sort key is `language` and not merely "a column that happens to agree
  // with language". It did not, until mutation testing: the seed helper's
  // default excess text is `excess <language> <need>`, which sorts in
  // language order by construction, so an `ORDER BY excess_change_text`
  // mutant reproduced the expected output exactly and survived the whole
  // file. Now insertion order gives gd/ga/cy, `ORDER BY change_text` gives
  // ga/cy/gd, `ORDER BY excess_change_text` gives cy/gd/ga, and only the real
  // `ORDER BY language` gives cy/ga/gd -- each wrong key fails differently,
  // so the failure names its own cause.
  it("returns every locale for the need, ordered by language, not by insertion", async () => {
    seedTranslation({ id: 1, needId: 42, language: "gd", changeText: "Gamma Gaelic", excessChangeText: "2 Gaelic excess" });
    seedTranslation({ id: 2, needId: 42, language: "ga", changeText: "Alpha Irish", excessChangeText: "3 Irish excess" });
    seedTranslation({ id: 3, needId: 42, language: "cy", changeText: "Beta Welsh", excessChangeText: "1 Welsh excess" });

    expect(await getAllTranslationsForNeed(session, 42)).toEqual([
      { language: "cy", change_text: "Beta Welsh", excess_change_text: "1 Welsh excess" },
      { language: "ga", change_text: "Alpha Irish", excess_change_text: "3 Irish excess" },
      { language: "gd", change_text: "Gamma Gaelic", excess_change_text: "2 Gaelic excess" },
    ]);
  });

  it("is scoped to the one need it was asked about", async () => {
    seedTranslation({ id: 1, needId: 41, language: "cy", changeText: "another need" });
    seedTranslation({ id: 2, needId: 42, language: "cy", changeText: "this need" });
    seedTranslation({ id: 3, needId: 43, language: "cy", changeText: "yet another need" });

    expect((await getAllTranslationsForNeed(session, 42)).map((row) => row.change_text)).toEqual(["this need"]);

    // ASKED FOR ALL THREE IN TURN. Every other test in this describe uses
    // need 42 and nothing else, so between them they cannot tell "binds its
    // argument" from "binds the constant 42": a `.bind(42)` mutant answered
    // "this need" here, satisfied every scoping and ordering assertion in the
    // file, and survived. Three different arguments producing three different
    // answers is the only thing that separates the two.
    expect((await getAllTranslationsForNeed(session, 41)).map((row) => row.change_text)).toEqual(["another need"]);
    expect((await getAllTranslationsForNeed(session, 43)).map((row) => row.change_text)).toEqual(["yet another need"]);
  });

  it("returns an empty array for a need with no translations at all", async () => {
    // The overwhelmingly common case: this admin page is reachable for every
    // need ever created, including the unpublished ones no translate-need
    // message was ever enqueued for. It must render an empty table, not throw.
    expect(await getAllTranslationsForNeed(session, 42)).toEqual([]);
  });

  // NO LANGUAGE FILTER, deliberately -- and the mutant worth killing is
  // someone "tightening" this with `AND language IN ('cy','ga','gd')` because
  // the module's header says only those three exist in D1. Production Postgres
  // carries 16 more languages (0006's own comment; extract_core.py:331 is what
  // filters them out at load time), so the day a row in another language
  // reaches D1 -- a restored dump, a hand-run task, a widened extract -- the
  // admin viewer is the ONLY place it can be seen. A filter here would hide
  // exactly the row someone opened this page to find.
  it("shows a row in a language outside cy/ga/gd, because the query does not filter by language", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy", changeText: "Welsh" });
    seedTranslation({ id: 2, needId: 42, language: "pl", changeText: "Polish" });

    expect((await getAllTranslationsForNeed(session, 42)).map((row) => row.language)).toEqual(["cy", "pl"]);
  });

  // AND NO LIMIT EITHER -- the mutant is `LIMIT 3`, and the module's own
  // header is what invites it: "Only cy/ga/gd rows ever exist ... so this
  // never returns more than 3 rows". A LIMIT 3 costs nothing to type next to
  // that sentence, and both `LIMIT 3` and `LIMIT 4` survived every other test
  // in this describe, because none of them seeds a fourth row for one need.
  //
  // That sentence is an assumption about the LOADER, not a property of the
  // table. extract_core.py's TRANSLATION_TABLES filter is the only thing
  // keeping the other sixteen languages out of D1 and it runs at extract
  // time; production Postgres holds all nineteen (0006's own comment names
  // them, ~60k rows). A restored dump, a widened extract or a hand-run task
  // puts them here, and by the test above this page is the ONLY place they
  // can be seen -- so a LIMIT would silently truncate exactly the evidence
  // someone opened it to find, and the page would look complete.
  //
  // Seeded in reverse-sorted order so that insertion order cannot be mistaken
  // for sorted order at nineteen rows any more than it can at three, and the
  // ordering assertion doubles as the LIMIT assertion.
  it("returns all nineteen production languages, with no LIMIT to truncate a restored dump", async () => {
    // Byte-wise sorted, which for these codes is also alphabetical: every one
    // is lowercase ASCII, and 'zh-hans' is the only one that is not two
    // letters. This is a literal, not a re-sort of the seed list -- a test
    // that sorted its own expectation would agree with any ORDER BY at all.
    const sorted = ["ar", "bg", "bn", "cy", "es", "fr", "ga", "gd", "gu", "it", "lt", "pa", "pl", "pt", "ro", "ta", "tr", "ur", "zh-hans"];
    [...sorted].reverse().forEach((language, index) => seedTranslation({ id: index + 1, needId: 42, language }));

    expect((await getAllTranslationsForNeed(session, 42)).map((row) => row.language)).toEqual(sorted);
  });

  // The counterpart to getNeedTranslation's duplicate test. There is no
  // DISTINCT and no GROUP BY, so if a retry ever did leave two rows for one
  // pair, this page lists both -- which is the only way anyone would ever find
  // out, and therefore a feature. A future de-duplicating rewrite would blind
  // the one view that can see the problem.
  it("lists duplicate rows for a locale rather than collapsing them", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy", changeText: "duplicate one" });
    seedTranslation({ id: 2, needId: 42, language: "cy", changeText: "duplicate two" });

    expect((await getAllTranslationsForNeed(session, 42)).map((row) => row.change_text)).toEqual(["duplicate one", "duplicate two"]);
  });

  it("projects exactly the three columns the template reads", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy" });

    // Unlike the two lookups above, this one returns `result.results`
    // untouched -- whatever the SELECT names is what the Nunjucks context
    // gets. admin/need_translations.njk reads language, change_text and
    // excess_change_text; a `SELECT *` would also hand the template the
    // internal row id and foodbank_id, which is how a "harmless" widening
    // ends up rendered on a page.
    expect(Object.keys((await getAllTranslationsForNeed(session, 42))[0]!).sort()).toEqual(["change_text", "excess_change_text", "language"]);
  });

  it("takes one round trip", async () => {
    seedTranslation({ id: 1, needId: 42, language: "cy" });
    seedTranslation({ id: 2, needId: 42, language: "ga" });

    await getAllTranslationsForNeed(session, 42);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual([42]);
  });
});
