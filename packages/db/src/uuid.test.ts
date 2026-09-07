import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "./schema.testkit";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeUuid, toDashedUuid } from "./uuid";

// uuid.ts is nineteen lines of string manipulation and it decides whether
// four public URL contracts resolve or 404. Both directions of it are load
// bearing:
//
//   * normalizeUuid is on the INPUT side of every lookup by UUID in this
//     package -- foodbank.ts:182 and :233 (`WHERE uuid = ?`),
//     donationpoints.ts:94, needs.ts:81 (`WHERE need_id = ?`). The column
//     holds the 32-char dashless lowercase form (0001_core.sql:6, :111 and
//     PLAN.md §4.4); every URL Django ever emitted carries the dashed form.
//     Without the normalisation those two never meet and the lookup returns
//     no row, which every caller turns into a 404. No exception, no log line
//     -- PLAN.md §5.4.4 files this under "silent-404 class of bug" for
//     exactly that reason.
//
//   * toDashedUuid is on the OUTPUT side: it is what api1, api2, api3,
//     apiDocs, the wfbn RSS feed and schemaOrg put in front of the public as
//     `id`, `need_id`, `self` and `sameAs`. Django got that form for free --
//     `need_id` was a native Postgres `uuid`, so it arrived in the view as a
//     `uuid.UUID` object and `JsonResponse`'s default DjangoJSONEncoder
//     serialised it as `str(o)` (gfapi1/views.py:246-259 hands the raw model
//     attribute straight to `JsonResponse`). Here the column is TEXT and
//     dashless, so the dashes have to be put back by hand or every published
//     `id` silently changes shape for every consumer.
//
// WHY A REAL DATABASE APPEARS IN A TEST FOR TWO PURE FUNCTIONS. The pure
// assertions below can only prove these functions produce a particular
// string. They cannot prove that string is the one the column actually
// holds, and THAT is the entire claim uuid.ts makes. So the last describe
// block applies the real migrations to real SQLite, seeds real rows, and
// runs the module's own verbatim SQL against them -- including the round
// trip a third party actually makes: read `need_id`, emit it through
// toDashedUuid, and hand that value back through normalizeUuid expecting the
// same row. Neither half of that loop is checked by needs.test.ts or
// foodbank.test.ts, which each exercise one side only.
//
// PARITY CLAIMS IN THIS FILE WERE CHECKED BY RUNNING PYTHON (TESTING.md's
// rule), against the same CPython 3.13 / Django 5.2.6 the original runs:
//   str(uuid.UUID("1cb6ac03e58f4bcfbe2d8f8e2b64ca38"))
//     -> "1cb6ac03-e58f-4bcf-be2d-8f8e2b64ca38"
//   uuid.UUID() ACCEPTS misplaced dashes, a trailing dash, braces, a
//     "urn:uuid:" prefix and uppercase; it REJECTS leading whitespace and a
//     non-hex character with ValueError.
//   django.urls.converters.UUIDConverter.regex is
//     "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
//     -- strict, lowercase, dashed. That is what Django's `<uuid:id>` routes
//     matched, and nothing else ever reached a Django view.
//
// MUTATION-TESTED, twice. A copy of uuid.ts was broken in a scratchpad and
// this file re-run against each break. 44 plausible wrong implementations
// across two rounds; 43 are killed and the 44th is provably equivalent.
//
// Killed, among others: `/-/` without the `g` flag, `toLowerCase()` removed
// or replaced by `toUpperCase()`, the identity function, a "helpful"
// `.trim()`, a hex-only "sanitiser", truncation to 32 characters, a
// positional five-group regex instead of a blanket strip, toDashedUuid
// skipping its normalizeUuid call, the grouping written 8-4-4-12-4, any two
// groups transposed, any group boundary off by one, a missing or extra dash,
// the final group taken as `slice(20, 32)` or `slice(-12)`, output
// uppercased, and toDashedUuid reduced to the passthrough its own header
// comment warns against.
//
// THE SECOND ROUND FOUND TWO SURVIVORS, and they are why the "removes U+002D
// and nothing else" test below exists: widening the regex to `/[-_]/` or
// `/[-+]/` passed all 23 tests, because the file enumerated separators
// (colon, brace, en-dash) instead of stating the rule. Enumeration only ever
// catches the characters someone thought of.
//
// THE ONE SURVIVOR THAT REMAINS IS EQUIVALENT, not a hole:
// `toLocaleLowerCase()` in place of `toLowerCase()`. It differs only under a
// Turkish locale, and only for `I`/`İ` -- neither of which is a hex digit.
// Checked rather than assumed: across U+0000-U+2100 no character's
// `toLowerCase()` differs from its `toLocaleLowerCase()` under this runner's
// en-US default, so no assertion placed in this file can distinguish them.
// Killing it would need the runner's locale changed, which is a vitest.config
// concern and not this file's. Recorded so the next person to mutation-test
// this module does not spend the afternoon chasing it.

// The migration files themselves, applied in order -- the convention
// needs.test.ts and adminDashboardStats.test.ts set. Transcribing a CREATE
// TABLE into this file would make the last block circular: the question it
// answers is whether the string normalizeUuid produces matches the column
// the shipped schema declares, and a schema retyped from memory cannot
// answer it. (Migration 0019 is the standing proof -- it dropped
// `foodbankchange.foodbank_name` and broke four queries with nothing to show
// for it until someone measured /dashboard/beautybanks/.)

// One real UUID in all four spellings a caller can plausibly arrive with.
// DASHED is `str(uuid.UUID(DASHLESS))` under CPython -- verified, not
// hand-typed -- because that is precisely the value Django's API published
// and third parties stored.
const DASHLESS = "1cb6ac03e58f4bcfbe2d8f8e2b64ca38";
const DASHED = "1cb6ac03-e58f-4bcf-be2d-8f8e2b64ca38";

// A second, unrelated id. Every "found the row" assertion below needs a row
// it must NOT have found, or a function that returned the only seeded row
// for any input would pass.
const OTHER_DASHLESS = "8c1e9a3f4b7d4e2fa1c05d6b8e9f0a12";
const OTHER_DASHED = "8c1e9a3f-4b7d-4e2f-a1c0-5d6b8e9f0a12";

// -------------------------------------------------------------------------
// normalizeUuid -- the input side
// -------------------------------------------------------------------------

describe("normalizeUuid", () => {
  // THE reason the function exists. `/api/1/need/<uuid>/`, `/slugfromid/`
  // and the admin's need URLs all carry the dashed form because that is what
  // Django's UUIDConverter required and what its JSON published; the column
  // holds the dashless one. Delete this behaviour and every one of those
  // URLs -- including ones printed in the API docs and saved in other
  // people's code -- stops resolving, with a 404 and no other symptom.
  it("turns the dashed form every public URL carries into the stored form", () => {
    expect(normalizeUuid(DASHED)).toBe(DASHLESS);
  });

  // The other half: the dashless form is also a live URL here (the port
  // deliberately widened what Django's strict regex accepted, PLAN.md §4.4
  // "normalise on input in the router so both forms resolve"), and it must
  // survive untouched rather than being re-dashed or sliced.
  it("leaves the already-stored dashless form alone", () => {
    expect(normalizeUuid(DASHLESS)).toBe(DASHLESS);
  });

  // Idempotence, stated separately because callers chain it: toDashedUuid
  // calls normalizeUuid on input that may already have been normalised by a
  // route, and needs.ts binds the result of a value that may already be
  // stored form. A normalisation that is not a fixed point would corrupt on
  // the second pass.
  //
  // ASSERTED AGAINST THE LITERAL, deliberately. This test used to read
  // `expect(normalizeUuid(normalizeUuid(DASHED))).toBe(normalizeUuid(DASHED))`
  // -- which compares the function against itself and therefore passes for
  // EVERY possible implementation, including `return input`. Mutation
  // testing scored it at zero kills. Naming the expected value is what makes
  // it a test rather than a tautology.
  it("is idempotent, and the fixed point is the stored form", () => {
    expect(normalizeUuid(normalizeUuid(DASHED))).toBe(DASHLESS);
    expect(normalizeUuid(normalizeUuid(DASHED.toUpperCase()))).toBe(DASHLESS);
    // Junk must also be a fixed point: /slugfromid/ re-normalises values that
    // have already been through here, and a second pass that removed more
    // than the first did would make the miss depend on the call count.
    expect(normalizeUuid(normalizeUuid("not-a-uuid"))).toBe("notauuid");
  });

  // Kills the `/-/` mutant. Without the `g` flag only the FIRST dash goes,
  // which produces a 35-char needle that matches nothing -- and every test
  // that only checked "the result has no leading dash" would still pass.
  it("strips every dash, not just the first", () => {
    const once = DASHED.replace("-", "");
    expect(normalizeUuid(DASHED)).not.toBe(once);
    expect(normalizeUuid(DASHED)).not.toContain("-");
    expect(normalizeUuid(DASHED)).toHaveLength(32);
  });

  // Kills the `toLowerCase()`-removed mutant, and matters in the wild: the
  // iOS/Android apps and hand-typed admin URLs both produce uppercase UUIDs,
  // and SQLite's `=` is case-sensitive, so an uppercase needle finds nothing
  // against a lowercased column. CPython's uuid.UUID accepts uppercase too,
  // so this is parity, not invention.
  it("lowercases, in both the dashed and the dashless spelling", () => {
    expect(normalizeUuid(DASHED.toUpperCase())).toBe(DASHLESS);
    expect(normalizeUuid(DASHLESS.toUpperCase())).toBe(DASHLESS);
    expect(normalizeUuid("1Cb6Ac03-E58f-4bCf-Be2d-8F8e2B64cA38")).toBe(DASHLESS);
  });

  // Dashes are removed WHEREVER they fall, not only at the canonical 8/13/
  // 18/23 offsets -- a positional regex or a five-part split would be a
  // plausible rewrite of this function and would reject all three of these.
  // It is also what CPython does: uuid.UUID("1cb6-ac03e58f...") parses fine
  // (verified), because it too strips every dash before length-checking.
  it("strips misplaced, leading and trailing dashes the way CPython's uuid.UUID does", () => {
    expect(normalizeUuid("1cb6-ac03e58f4bcfbe2d8f8e2b64ca38")).toBe(DASHLESS);
    expect(normalizeUuid(`-${DASHLESS}`)).toBe(DASHLESS);
    expect(normalizeUuid(`${DASHLESS}-`)).toBe(DASHLESS);
    expect(normalizeUuid("1cb6ac03--e58f--4bcf--be2d--8f8e2b64ca38")).toBe(DASHLESS);
  });

  // DIVERGENCE FROM CPython, pinned deliberately. uuid.UUID() also accepts
  // braces and a "urn:uuid:" prefix (both verified); normalizeUuid strips
  // neither, so those inputs become a needle that matches nothing. The
  // visible outcome is nevertheless identical to Django's, because Django's
  // UUIDConverter regex never let a braced or urn-prefixed value reach a
  // view at all -- it 404'd at the URL layer. Same 404, different mechanism.
  // Written down so nobody "fixes" this into a full uuid.UUID emulation
  // believing it restores a behaviour the site once had.
  it("does not unwrap braces or a urn:uuid: prefix, unlike uuid.UUID", () => {
    expect(normalizeUuid(`{${DASHED}}`)).toBe(`{${DASHLESS}}`);
    expect(normalizeUuid(`urn:uuid:${DASHED}`)).toBe(`urn:uuid:${DASHLESS}`);
  });

  // THE CHARACTER CLASS, pinned as a whole rather than one character at a
  // time. Every other test in this describe block names a specific character
  // that must survive -- a colon here, a brace there -- and mutation testing
  // showed why that is not enough: widening the regex to /[-_]/ or /[-+]/
  // SURVIVED the entire suite, because no assertion happened to contain an
  // underscore or a plus. Both are ordinary characters in the junk that
  // reaches this function (`/slugfromid/:uuid/` in routes/api3.ts matches any
  // path segment, so the argument is arbitrary text from the open internet).
  //
  // So this asserts the actual contract instead of a sample of it: U+002D is
  // the ONLY character removed, every other character survives verbatim, and
  // the only other transformation is lowercasing. Any future edit that widens
  // the class -- to a character nobody thought to enumerate here -- fails
  // this one test. It subsumes the colon, brace, dot, percent and slash
  // mutants that previously died by a single assertion each.
  it("removes U+002D and nothing else", () => {
    // Every printable ASCII character except the hyphen itself, each planted
    // between two hex digits so a stripped character is visible as a
    // shortened result rather than a changed one.
    for (let code = 0x20; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code);
      if (ch === "-") continue;
      expect(normalizeUuid(`1cb6ac03${ch}e58f`)).toBe(`1cb6ac03${ch.toLowerCase()}e58f`);
    }
    // Named explicitly as well, because these two are the mutants that got
    // through: `_` is what a "be lenient about separators" rewrite reaches
    // for first, and `+` arrives from form-encoded query strings where a
    // space became a plus.
    expect(normalizeUuid("1cb6ac03_e58f_4bcf_be2d_8f8e2b64ca38")).toBe("1cb6ac03_e58f_4bcf_be2d_8f8e2b64ca38");
    expect(normalizeUuid(`${DASHLESS}+`)).toBe(`${DASHLESS}+`);
  });

  // Only U+002D HYPHEN-MINUS counts. A UUID that has been through a word
  // processor, a PDF or a chat client that "smart-dashes" text arrives with
  // U+2013 EN DASH or U+2011 NON-BREAKING HYPHEN and silently misses. That
  // is current behaviour and also CPython's (uuid.UUID rejects the en-dashed
  // form outright, verified), so it is pinned rather than widened.
  it("treats only the ASCII hyphen as a dash", () => {
    const enDashed = "1cb6ac03–e58f–4bcf–be2d–8f8e2b64ca38";
    expect(normalizeUuid(enDashed)).not.toBe(DASHLESS);
    expect(normalizeUuid(enDashed)).toContain("–");
    expect(normalizeUuid(`1cb6ac03‑e58f${DASHLESS.slice(12)}`)).toContain("‑");
  });

  // Whitespace is NOT trimmed -- also CPython's behaviour (uuid.UUID(" 1cb6…")
  // raises ValueError, verified). A trailing "%20" or a newline pasted into
  // the admin's URL bar is therefore a miss, not a hit on the wrong row,
  // which is the safe direction.
  it("does not trim surrounding whitespace", () => {
    expect(normalizeUuid(` ${DASHED} `)).toBe(` ${DASHLESS} `);
    expect(normalizeUuid(`${DASHED}\n`)).toBe(`${DASHLESS}\n`);
  });

  // It validates NOTHING: not length, not hex-ness, not emptiness. That is
  // not an oversight to tidy away -- it is required. The port's routes have
  // no converter (`api3App.get("/slugfromid/:uuid/")` in routes/api3.ts:89
  // matches any segment, where Django's `<uuid:uuid>` matched only a strict
  // lowercase dashed value), so arbitrary junk from the open internet lands
  // here. Throwing would turn a 404 into a 500 on a URL anyone can construct.
  it("passes junk through without throwing, because unvalidated input reaches it", () => {
    expect(normalizeUuid("")).toBe("");
    expect(normalizeUuid("not-a-uuid")).toBe("notauuid");
    expect(normalizeUuid("../../etc/passwd")).toBe("../../etc/passwd");
    expect(normalizeUuid("Z".repeat(40))).toBe("z".repeat(40));
    expect(normalizeUuid("%20")).toBe("%20");
  });
});

// -------------------------------------------------------------------------
// toDashedUuid -- the output side
// -------------------------------------------------------------------------

describe("toDashedUuid", () => {
  // The published contract, in the exact grouping Python's str(UUID) uses.
  // All three of these were produced by running CPython, not by counting
  // characters here: a transposed group boundary (8-4-4-4-12 written as
  // 8-4-4-12-4) yields a well-formed-looking id that is a DIFFERENT id, and
  // every downstream consumer would key on it happily.
  it("reproduces str(uuid.UUID(hex)) exactly", () => {
    expect(toDashedUuid("1cb6ac03e58f4bcfbe2d8f8e2b64ca38")).toBe("1cb6ac03-e58f-4bcf-be2d-8f8e2b64ca38");
    expect(toDashedUuid("8c1e9a3f4b7d4e2fa1c05d6b8e9f0a12")).toBe("8c1e9a3f-4b7d-4e2f-a1c0-5d6b8e9f0a12");
    expect(toDashedUuid("a1b2c3d4e5f6478090ab12cd34ef5678")).toBe("a1b2c3d4-e5f6-4780-90ab-12cd34ef5678");
  });

  // The grouping restated as offsets, because it is the thing a refactor
  // would get subtly wrong and the equality test above only fails with an
  // unhelpful diff. 36 characters, dashes at 8, 13, 18 and 23 -- the shape
  // Django's own UUIDConverter regex demands of an incoming URL, which is
  // what makes the emitted value round-trippable through the ORIGINAL site
  // as well as this one.
  it("emits 36 characters with dashes at 8, 13, 18 and 23", () => {
    const out = toDashedUuid(DASHLESS);
    expect(out).toHaveLength(36);
    expect([8, 13, 18, 23].map((i) => out[i])).toEqual(["-", "-", "-", "-"]);
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // It normalises FIRST, which is why an already-dashed value does not come
  // back double-dashed. schemaOrg.test.ts:406-411 depends on this directly:
  // a row read from a pre-migration dump still holds the dashed form, and
  // must still produce the same canonical /<uuid>/ redirect URL as a row
  // holding the dashless one. Drop the normalizeUuid call and that row emits
  // "1cb6ac03-e58f-4bc-f-be2-d-8f8e2b64ca38" into a live API response.
  it("does not double-dash a value that is already dashed", () => {
    expect(toDashedUuid(DASHED)).toBe(DASHED);
  });

  // Django's str(UUID) is always lowercase whatever case the input had
  // (verified: uuid.UUID("1CB6AC03-...") stringifies lowercase). Emitting an
  // uppercase id would break any consumer comparing ids as strings.
  it("lowercases, so an uppercase stored value still publishes as Django would", () => {
    expect(toDashedUuid(DASHLESS.toUpperCase())).toBe(DASHED);
    expect(toDashedUuid(DASHED.toUpperCase())).toBe(DASHED);
  });

  // SUSPECT, pinned as current behaviour rather than fixed (TESTING.md's
  // rule). toDashedUuid validates nothing, so a value that is not 32 hex
  // characters is not rejected -- it is sliced into something that LOOKS
  // like a UUID and is published as one. An empty `uuid` becomes the string
  // "----" in a public API `id` field; a short one loses its last group; a
  // long one dumps the overflow into the final group, exceeding 12
  // characters. It is unreachable today only because all four uuid columns
  // are NOT NULL and the ETL verified 0 NULLs across every row (PLAN.md
  // §5.4.4) -- nothing enforces the LENGTH, and `uuid TEXT NOT NULL` happily
  // accepts ''. These assertions exist so that if someone adds validation,
  // the change is visible and deliberate rather than incidental.
  it("slices whatever length it is given, producing a malformed id instead of an error", () => {
    expect(toDashedUuid("")).toBe("----");
    expect(toDashedUuid(DASHLESS.slice(0, 31))).toBe("1cb6ac03-e58f-4bcf-be2d-8f8e2b64ca3");
    expect(toDashedUuid(`${DASHLESS}ff`)).toBe("1cb6ac03-e58f-4bcf-be2d-8f8e2b64ca38ff");
    // Non-hex is not rejected either -- it is grouped like anything else.
    expect(toDashedUuid("z".repeat(32))).toBe("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz");
  });
});

// -------------------------------------------------------------------------
// The pair, as a round trip
// -------------------------------------------------------------------------

describe("normalizeUuid and toDashedUuid as inverses", () => {
  // What a third party actually does: read `id` out of an API response, then
  // request it back. Both directions must compose to identity or the value
  // the site publishes is not a value the site accepts.
  it("round-trips the stored form out to the public form and back", () => {
    expect(normalizeUuid(toDashedUuid(DASHLESS))).toBe(DASHLESS);
    expect(toDashedUuid(normalizeUuid(DASHED))).toBe(DASHED);
  });

  // And converges from any spelling a caller might hold, since normalizeUuid
  // is the first thing both functions do.
  it("converges on one canonical pair from every accepted spelling", () => {
    for (const input of [DASHED, DASHLESS, DASHED.toUpperCase(), DASHLESS.toUpperCase()]) {
      expect(normalizeUuid(input)).toBe(DASHLESS);
      expect(toDashedUuid(input)).toBe(DASHED);
    }
  });
});

// -------------------------------------------------------------------------
// Against the real schema
//
// The pure tests above prove these functions produce particular strings.
// They cannot prove those strings are the ones the shipped columns hold --
// which is the only claim uuid.ts makes and the only way it can fail in
// production. So: real migrations, real rows, and the module's own SQL
// copied verbatim from its call sites.
// -------------------------------------------------------------------------

describe("against the real columns", () => {
  let db: DatabaseSync;

  // Verbatim from foodbank.ts:181 and needs.ts:80. Copied rather than
  // imported so that a change to either statement shows up here as a
  // difference to reconcile -- these tests are about whether uuid.ts's
  // output form fits THOSE predicates.
  const SLUG_BY_UUID = "SELECT slug FROM foodbank WHERE uuid = ?";
  const NEED_BY_UUID = "SELECT * FROM foodbankchange_full WHERE need_id = ?";

  // The NOT NULL columns nothing here reads, filled the way needs.test.ts
  // fills them. Only `uuid` and `slug` vary.
  function seedFoodbank(id: number, uuid: string, slug: string): void {
    db.prepare(
      `INSERT INTO foodbank (
         id, uuid, name, alt_name, slug, network, address, postcode, country, lat_lng,
         charity_just_foodbank, contact_email, url, shopping_list_url,
         address_is_administrative, is_closed, no_locations, days_between_needs,
         created, modified, latest_need_id
       ) VALUES (?, ?, ?, NULL, ?, 'Trussell Trust', 'Address', 'SP2 9DY', 'England', '51.06,-1.79',
         0, 'info@example.org', 'https://example.org/', 'https://example.org/list/',
         0, 0, 0, 7,
         '2020-01-01 00:00:00.000000', '2020-01-01 00:00:00.000000', NULL)`,
    ).run(id, uuid, `Foodbank ${id}`, slug);
  }

  function seedNeed(id: number, needId: string, foodbankId: number, changeText: string): void {
    db.prepare(
      `INSERT INTO foodbankchange (
         id, need_id, foodbank_id, distill_id, name, uri,
         change_text, change_text_original, excess_change_text, excess_change_text_original,
         published, nonpertinent, is_categorised, notified, input_method, created, modified
       ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, 1, NULL, NULL, NULL, 'user',
         '2026-09-05 19:28:08.853000', '2026-09-05 19:28:08.853000')`,
    ).run(id, needId, foodbankId, changeText);
  }

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    // Two of each, always. A predicate that ignored its bound parameter
    // entirely would return the first row and pass every single-row test.
    seedFoodbank(1, DASHLESS, "salisbury");
    seedFoodbank(2, OTHER_DASHLESS, "trowbridge");
    seedNeed(1, DASHLESS, 1, "Beans, Pasta");
    seedNeed(2, OTHER_DASHLESS, 2, "Nappies, UHT Milk");
  });

  // The silent 404, demonstrated end to end. The URL form and the stored
  // form are different strings; only normalizeUuid makes them meet. The
  // second half of this test is what the site looked like before uuid.ts
  // existed -- a valid, published, still-documented URL returning nothing at
  // all, with no error anywhere to notice it by.
  it("makes a dashed public URL find its dashless row, which the raw value cannot", () => {
    const found = db.prepare(SLUG_BY_UUID).get(normalizeUuid(DASHED)) as { slug: string } | undefined;
    expect(found?.slug).toBe("salisbury");

    // Same statement, same database, unnormalised parameter: no row.
    expect(db.prepare(SLUG_BY_UUID).get(DASHED)).toBeUndefined();
  });

  // Cardinality, against the second seeded row: the normalised needle must
  // select ITS row, not merely A row.
  it("selects the row belonging to the id asked for, not the first one", () => {
    expect((db.prepare(SLUG_BY_UUID).get(normalizeUuid(OTHER_DASHED)) as { slug: string }).slug).toBe("trowbridge");
    expect((db.prepare(SLUG_BY_UUID).get(normalizeUuid(DASHED.toUpperCase())) as { slug: string }).slug).toBe("salisbury");
  });

  // THE PUBLIC LOOP, which is the reason both functions are in one file.
  // Read the stored need_id, publish it the way gfapi1's api_need does
  // (`"id": need.need_id` through DjangoJSONEncoder, which here means
  // toDashedUuid), then take that published value straight back through the
  // lookup and require the SAME row. Break either function and this fails --
  // and in production it fails as an /api/1/need/<id>/ that 404s on an id
  // the API itself handed out one second earlier.
  it("publishes an id that finds its own row again when handed back", () => {
    const stored = (db.prepare("SELECT need_id FROM foodbankchange WHERE id = 2").get() as { need_id: string }).need_id;

    const published = toDashedUuid(stored);
    expect(published).toBe(OTHER_DASHED);

    const round = db.prepare(NEED_BY_UUID).get(normalizeUuid(published)) as { id: number; change_text: string } | undefined;
    expect(round?.id).toBe(2);
    expect(round?.change_text).toBe("Nappies, UHT Milk");
    // Via the view, so the joined parent comes with it -- the same view
    // getNeedByUuid reads. Post-0019 `foodbank_slug` lives only on the
    // parent, so this also proves the fixture is the real post-migration
    // schema and not an 0001-era transcription.
    expect((round as unknown as { foodbank_slug: string }).foodbank_slug).toBe("trowbridge");
  });

  // The same loop again, against the OTHER column. `foodbankchange.need_id`
  // and `foodbank.uuid` are separate declarations in 0001_core.sql (:111 and
  // :6), and the test above only proves the round trip for the first of
  // them. This one is the column behind `id` in api2/foodbanks.ts:60,
  // api3.ts:52 and the `sameAs` URL schemaOrg.ts:79 publishes into structured
  // data that Google reads -- a form change there is invisible on the site
  // and shows up as a search-console error weeks later. Kept as a second
  // assertion rather than folded into the first because the point is that
  // two independently-declared columns both hold the form these functions
  // assume; a shared helper testing one column twice would not say that.
  it("publishes a foodbank uuid that finds its own row again when handed back", () => {
    const stored = (db.prepare("SELECT uuid FROM foodbank WHERE slug = 'trowbridge'").get() as { uuid: string }).uuid;

    const published = toDashedUuid(stored);
    expect(published).toBe(OTHER_DASHED);

    const round = db.prepare(SLUG_BY_UUID).get(normalizeUuid(published)) as { slug: string } | undefined;
    expect(round?.slug).toBe("trowbridge");
  });

  // The normalisation is ONE-WAY and asymmetric, and this is the shape of
  // the asymmetry: it lowercases the NEEDLE only. SQLite's `=` is
  // case-sensitive, so a row whose STORED uuid is uppercase can never be
  // reached, by any spelling of any input. That is safe only because the ETL
  // lowercases on the way in (tools/pg-to-d1/extract_core.py:391-394,
  // `str(value).replace("-", "").lower()`). This test is the record that the
  // ETL's `.lower()` is load-bearing, so nobody drops it as belt-and-braces.
  it("cannot reach a row whose stored uuid is uppercase, whatever the input", () => {
    seedFoodbank(3, DASHLESS.toUpperCase().replace("1CB6", "9CB6"), "shifted");
    const upperStored = DASHLESS.toUpperCase().replace("1CB6", "9CB6");

    for (const input of [upperStored, upperStored.toLowerCase(), toDashedUuid(upperStored)]) {
      expect(db.prepare(SLUG_BY_UUID).get(normalizeUuid(input))).toBeUndefined();
    }
    // The row is genuinely there -- it is only the lookup that cannot see it.
    expect(db.prepare(SLUG_BY_UUID).get(upperStored)).toEqual({ slug: "shifted" });
  });

  // Equally one-way in the other direction: toDashedUuid's output is a
  // PUBLICATION format, never a storage format. Binding it to a column
  // matches nothing. Stated explicitly because the two functions have
  // similar names and sit two lines apart, and swapping them at a call site
  // produces no type error and no exception -- just an endpoint that always
  // 404s (or, on the output side, ids that no longer round-trip).
  it("never matches a column when the dashed form is bound directly", () => {
    expect(db.prepare(NEED_BY_UUID).get(toDashedUuid(DASHLESS))).toBeUndefined();
    expect(db.prepare(SLUG_BY_UUID).get(toDashedUuid(DASHLESS))).toBeUndefined();
  });

  // And the junk case, at the layer that matters: unvalidated input reaches
  // the bind, and SQLite answers "no row" rather than raising. This is what
  // keeps /slugfromid/<anything>/ a 404 instead of a 500 now that the port
  // has no URL-level uuid converter to reject it first.
  it("turns junk input into a miss, not an error", () => {
    for (const junk of ["", "not-a-uuid", "%20", `{${DASHED}}`, `urn:uuid:${DASHED}`, " ".repeat(3) + DASHED]) {
      expect(db.prepare(SLUG_BY_UUID).get(normalizeUuid(junk))).toBeUndefined();
    }
  });
});
