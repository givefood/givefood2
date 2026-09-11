import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import type { Session } from "@givefood/db";
import { beforeEach, describe, expect, it } from "vitest";
import { ARTICLE_FIELDS, DONATIONPOINT_FIELDS, FOODBANK_FIELDS, ITEM_FIELDS } from "./fields";
import { dumpKey, generateDumps, pruneDumps, shouldKeep } from "./index";

// The daily CSV dumps (github #59).
//
// WHY THERE ARE FIXTURES. givefood-dumps still holds the last set Django
// itself generated -- 2026-08-30, all twelve artefacts -- so unlike almost
// everything else in this port there is REAL OUTPUT to check against rather
// than a reading of the source. `__fixtures__/django-headers.json` is the
// header line lifted verbatim from `foodbanks/csv/foodbanks-20260830.csv` and
// `articles/csv/articles-20260830.csv`; the row fixture is two real rows, one
// parent and one location, chosen to exercise both branches of
// build_foodbank_row. These are a PUBLIC SCHEMA -- people index these columns
// by position -- so they are pinned as bytes, not as a description.

const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const djangoHeaders: Record<string, string> = JSON.parse(readFileSync(`${FIXTURES}django-headers.json`, "utf8"));
const djangoRows: Record<string, Record<string, string>> = JSON.parse(readFileSync(`${FIXTURES}django-foodbank-rows.json`, "utf8"));

type Bindable = string | number | null;

// D1 allows at most 100 bound parameters per query. node:sqlite allows far
// more, so a harness that just forwards to it is MORE PERMISSIVE THAN
// PRODUCTION -- which is exactly how the first real run died on an IN list of
// 1,000 ids while every test passed. The cap is enforced here, with D1's own
// message, so the harness cannot flatter the code again.
const D1_MAX_BOUND_PARAMS = 100;

function d1Session(db: DatabaseSync): Session {
  const statement = (sql: string, params: Bindable[]) => ({
    bind: (...next: unknown[]) => {
      if (next.length > D1_MAX_BOUND_PARAMS) {
        throw new Error("D1_ERROR: variable number must be between ?1 and ?100: SQLITE_ERROR");
      }
      return statement(sql, next as Bindable[]);
    },
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => ({ success: true, meta: { last_row_id: 0 } }),
  });
  return { prepare: (sql: string) => statement(sql, []), getBookmark: () => null } as unknown as Session;
}

/**
 * An R2 bucket that records what it was asked to store, and ENFORCES R2's own
 * multipart rules.
 *
 * The rules are the point. A permissive fake accepted parts of differing
 * lengths and every test passed, while the real bucket rejected the whole
 * object at completion -- "All non-trailing parts must have the same length.
 * (10048)" -- so the items dump never once appeared in production. Same
 * failure as the D1 parameter cap: a harness looser than the real thing is
 * worse than no harness, because it manufactures confidence.
 */
function fakeBucket() {
  const objects = new Map<string, { body: string; metadata: unknown }>();
  const multiparts: string[] = [];
  const decoder = new TextDecoder();
  const asText = (v: string | Uint8Array) => (typeof v === "string" ? v : decoder.decode(v));
  return {
    objects,
    multiparts,
    async put(key: string, value: string | Uint8Array, options: { httpMetadata?: unknown }) {
      objects.set(key, { body: asText(value), metadata: options?.httpMetadata });
      return {};
    },
    async createMultipartUpload(key: string, options: { httpMetadata?: unknown }) {
      multiparts.push(key);
      const parts: Array<string | Uint8Array> = [];
      return {
        uploadPart: async (n: number, body: string | Uint8Array) => {
          parts[n - 1] = body;
          return { partNumber: n, etag: `e${n}` };
        },
        complete: async () => {
          const sizes = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p).byteLength : p.byteLength));
          const nonTrailing = sizes.slice(0, -1);
          if (new Set(nonTrailing).size > 1) {
            throw new Error("completeMultipartUpload: All non-trailing parts must have the same length. (10048)");
          }
          // R2's other rule: 5 MiB floor on every part but the last.
          if (nonTrailing.some((n) => n < 5 * 1024 * 1024)) {
            throw new Error("completeMultipartUpload: part smaller than the 5 MiB minimum (10048)");
          }
          // CONCATENATE BYTES, then decode once -- R2 stores the octet stream
          // and a reader decodes the whole object. Decoding each part on its
          // own instead reports a character that spans a boundary as U+FFFD
          // and blames the writer for the harness's mistake.
          const encoded = parts.map((pt) => (typeof pt === "string" ? new TextEncoder().encode(pt) : pt));
          const joined = new Uint8Array(encoded.reduce((n, e) => n + e.byteLength, 0));
          let at = 0;
          for (const e of encoded) { joined.set(e, at); at += e.byteLength; }
          objects.set(key, { body: new TextDecoder().decode(joined), metadata: options?.httpMetadata });
          return {};
        },
        abort: async () => {},
      } as unknown as R2MultipartUpload;
    },
    async list({ cursor }: { cursor?: string } = {}) {
      if (cursor) return { objects: [], truncated: false as const };
      return { objects: [...objects.keys()].map((key) => ({ key })), truncated: false as const };
    },
    async delete(keys: string[]) {
      for (const k of keys) objects.delete(k);
    },
  };
}

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

const NOW = "2026-09-10 04:30:00.000000";

function seedFoodbank(over: Partial<Record<string, unknown>> = {}): void {
  const f = {
    id: 1, uuid: "11111111111141118111111111111111", name: "Salisbury", slug: "salisbury",
    alt_name: null, address: "1 High St", postcode: "SP2 9DY", country: "England",
    lat_lng: "51.06,-1.79", charity_just_foodbank: 0, contact_email: "info@example.org",
    url: "https://example.org/", shopping_list_url: "https://example.org/list/",
    address_is_administrative: 0, is_closed: 0, no_locations: 1, days_between_needs: 7,
    created: "2020-01-01 00:00:00.000000", modified: NOW, edited: null,
    is_school: 0, footprint: 1234, bounds_north: 51.5, charity_number: "1130136",
    network: "Trussell", latest_need_id: null, ...over,
  } as Record<string, unknown>;
  const cols = Object.keys(f);
  db.prepare(`INSERT INTO foodbank (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
    ...(cols.map((c) => f[c]) as Bindable[]),
  );
}

async function runDumps() {
  const bucket = fakeBucket();
  const results = await generateDumps(d1Session(db), bucket as never, "2026-09-10");
  return { bucket, results };
}

function bodyOf(bucket: ReturnType<typeof fakeBucket>, type: string): string {
  return bucket.objects.get(dumpKey(type, "2026-09-10"))!.body;
}

describe("the field lists are Django's, byte for byte", () => {
  // Not "the same columns" -- the same LINE. Order is as public as the names.
  it("reproduces the header Django wrote to R2 on 2026-08-30", async () => {
    seedFoodbank();
    const { bucket } = await runDumps();

    for (const type of ["foodbanks", "items", "donationpoints", "articles"]) {
      expect(bodyOf(bucket, type).split("\r\n")[0], type).toBe(djangoHeaders[type]);
    }
  });

  it("has the column counts gfdumps/tests.py locks", () => {
    // 60, not the 61 PLAN.md §8.8 claims -- counted from dump.py itself.
    expect(FOODBANK_FIELDS).toHaveLength(60);
    expect(ITEM_FIELDS).toHaveLength(12);
    expect(DONATIONPOINT_FIELDS).toHaveLength(31);
    expect(ARTICLE_FIELDS).toHaveLength(6);
  });
});

describe("value coercion matches Python's csv.writer(QUOTE_ALL)", () => {
  it("writes booleans as True/False and NULLs as empty, like the real rows", async () => {
    seedFoodbank({ is_school: 1 });
    db.prepare(
      `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, address, postcode, country,
        lat_lng, is_closed, is_donation_point, is_mobile, boundary_geojson, modified)
       VALUES (1,'22222222222242228222222222222222',1,'Amesbury','amesbury','2 Low St','SP4 7AA',
        'England','51.17,-1.78',0,1,0,'{"type":"Polygon"}',?)`,
    ).run(NOW);

    const { bucket } = await runDumps();
    const [, parent, location] = bodyOf(bucket, "foodbanks").split("\r\n");
    const cols = (line: string) => line.slice(1, -1).split('","');
    const idx = (f: string) => FOODBANK_FIELDS.indexOf(f as never);

    // The parent: is_mobile/is_area/boundary are None -> empty, exactly as
    // the real 2026-08-30 parent row has them.
    expect(cols(parent!)[idx("is_school")]).toBe("True");
    expect(cols(parent!)[idx("is_mobile")]).toBe("");
    expect(cols(parent!)[idx("is_area")]).toBe("");
    expect(cols(parent!)[idx("bounds_north")]).toBe("51.5");
    // The location: is_area is bool(boundary_geojson).
    expect(cols(location!)[idx("is_mobile")]).toBe("False");
    expect(cols(location!)[idx("is_area")]).toBe("True");
    expect(cols(location!)[idx("bounds_north")]).toBe("");
    expect(cols(location!)[idx("secondary_phone_number")]).toBe("");
  });

  // The shape the real fixture proves: every field quoted, CRLF terminated.
  // THE ONE THE REFERENCE DIFF CAUGHT. D1 stores UUIDs dashless (all 1,070
  // rows) and Django's dumps carry the dashed form, so passing the column
  // through would silently change the primary identifier of a public dataset
  // -- in `id` here, and in `organisation_id` across the other three dumps.
  // The seeds above are dashless on purpose: seeded dashed, this assertion
  // passes even without the conversion and the bug walks straight through.
  it("renders UUIDs dashed, as Django did, from the dashless column", async () => {
    seedFoodbank();
    db.prepare(
      `INSERT INTO foodbankchangeline (id, need_id, foodbank_id, item, type, category, group_name, created)
       VALUES (1, 1, 1, 'Beans', 'need', 'Food', 'Tins', ?)`,
    ).run(NOW);
    const { bucket } = await runDumps();

    const id = bodyOf(bucket, "foodbanks").split("\r\n")[1]!.slice(1, 37);
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
    const orgId = bodyOf(bucket, "items").split("\r\n")[1]!.slice(1, 37);
    expect(orgId).toBe("11111111-1111-4111-8111-111111111111");
  });

  // Django declares charity_reg_date a DateTimeField, so str() always renders
  // a time and drops zero microseconds. D1 holds it three ways -- 801 bare
  // dates, 3 with ".000000", 266 NULL -- and the real 2026-08-30 dump shows
  // the "00:00:00" form. This was the commonest difference when the output
  // was first diffed against it.
  it("renders charity_reg_date as Django's str(datetime)", async () => {
    seedFoodbank({ id: 1, uuid: "a".repeat(32), slug: "a", name: "A", charity_reg_date: "2021-07-14" });
    seedFoodbank({ id: 2, uuid: "b".repeat(32), slug: "b", name: "B", charity_reg_date: "1985-03-28 00:00:00.000000" });
    const { bucket } = await runDumps();
    const rows = bodyOf(bucket, "foodbanks").split("\r\n");
    const at = (line: string) => line.slice(1, -1).split('","')[FOODBANK_FIELDS.indexOf("charity_reg_date" as never)];

    expect(at(rows[1]!)).toBe("2021-07-14 00:00:00"); // bare date gains the time
    expect(at(rows[2]!)).toBe("1985-03-28 00:00:00"); // zero microseconds dropped
  });

  // JavaScript cannot tell 51.0 from 51, so a whole-numbered bound would
  // render "51" where Python's str(51.0) gives "51.0". No production row is
  // whole-numbered today (0 of 1,070), which is exactly why it needs a test:
  // nothing in the real data would ever catch a regression here.
  it("renders a whole-numbered bound as a Python float", async () => {
    seedFoodbank({ bounds_north: 51 });
    const { bucket } = await runDumps();
    const row = bodyOf(bucket, "foodbanks").split("\r\n")[1]!;

    expect(row.slice(1, -1).split('","')[FOODBANK_FIELDS.indexOf("bounds_north" as never)]).toBe("51.0");
  });

  it("quotes every field and terminates with CRLF", async () => {
    seedFoodbank();
    const { bucket } = await runDumps();
    const body = bodyOf(bucket, "foodbanks");

    expect(body.startsWith('"id","organisation_name"')).toBe(true);
    expect(body.endsWith("\r\n")).toBe(true);
    expect(body.includes("\n") && !body.includes("\n\n")).toBe(true);
    for (const [name, row] of Object.entries(djangoRows)) {
      // The fixture rows agree with our own field list, which is what makes
      // them usable as an oracle at all.
      expect(Object.keys(row), name).toEqual([...FOODBANK_FIELDS]);
    }
  });
});

describe("volume", () => {
  // THE ONE THAT REACHED PRODUCTION. locationsForFoodbanks built an IN list
  // from a whole 1,000-row page, and D1 allows at most 100 bound parameters:
  // the first real run died with "D1_ERROR: variable number must be between
  // ?1 and ?100" before writing a single object. Every test above used one
  // food bank, so none of them could see it.
  it("handles more food banks than D1 allows bound parameters", async () => {
    for (let i = 1; i <= 150; i++) {
      seedFoodbank({ id: i, uuid: String(i).padStart(32, "0"), name: `FB ${String(i).padStart(3, "0")}`, slug: `fb-${i}` });
      db.prepare(
        `INSERT INTO foodbanklocation (id, uuid, foodbank_id, name, slug, country, lat_lng, is_closed, modified)
         VALUES (?, ?, ?, ?, ?, 'England', '51,0', 0, ?)`,
      ).run(i, String(i).padStart(32, "1"), i, `Loc ${i}`, `loc-${i}`, NOW);
    }

    const { bucket, results } = await runDumps();

    // 150 parents + 150 locations, so the chunking really did cover them all.
    expect(results[0]!.rows).toBe(300);
    expect(bodyOf(bucket, "foodbanks").split("\r\n").filter(Boolean)).toHaveLength(301);
  });
});

describe("R2 keys and metadata match the objects already in the bucket", () => {
  it("uses <type>/csv/<type>-YYYYMMDD.csv", () => {
    expect(dumpKey("items", "2026-08-30")).toBe("items/csv/items-20260830.csv");
    expect(dumpKey("foodbanks", "2026-09-10")).toBe("foodbanks/csv/foodbanks-20260910.csv");
  });

  it("sets Django's own download filename and an immutable cache", async () => {
    seedFoodbank();
    const { bucket } = await runDumps();

    expect(bucket.objects.get(dumpKey("foodbanks", "2026-09-10"))!.metadata).toEqual({
      contentType: "text/csv; charset=utf-8",
      contentDisposition: 'attachment; filename="foodbanks-20260910.csv"',
      cacheControl: "public, max-age=31536000, immutable",
    });
  });

  it("writes all four dumps", async () => {
    seedFoodbank();
    const { bucket, results } = await runDumps();

    expect([...bucket.objects.keys()].sort()).toEqual([
      "articles/csv/articles-20260910.csv",
      "donationpoints/csv/donationpoints-20260910.csv",
      "foodbanks/csv/foodbanks-20260910.csv",
      "items/csv/items-20260910.csv",
    ]);
    expect(results.map((r) => r.rows)).toEqual([1, 0, 0, 0]);
    // Small dumps take the single-PUT path, never multipart.
    expect(bucket.multiparts).toEqual([]);
  });
});

describe("multipart uploads", () => {
  // THE ONE THAT REACHED PRODUCTION TWICE. Needs >16 MiB so there are TWO
  // non-trailing parts -- with one, "all non-trailing parts are the same
  // length" is true by definition, which is exactly why the 8.4 MB foodbanks
  // dump succeeded while the 63 MB items dump failed at completion.
  it("emits equal-sized parts for a dump larger than one part", async () => {
    seedFoodbank();
    const filler = "x".repeat(5000);
    const insert = db.prepare(
      `INSERT INTO foodbankchangeline (id, need_id, foodbank_id, item, type, category, group_name, created)
       VALUES (?, 1, 1, ?, 'need', 'Food', 'Tins', ?)`,
    );
    for (let i = 1; i <= 4000; i++) insert.run(i, `${filler}-${i}`, NOW);

    const { bucket, results } = await runDumps();

    // It really did go multipart, and really did complete.
    expect(bucket.multiparts).toContain(dumpKey("items", "2026-09-10"));
    const body = bodyOf(bucket, "items");
    expect(results[1]!.rows).toBe(4000);
    // Nothing lost or duplicated at the part boundaries.
    expect(body.split("\r\n").filter(Boolean)).toHaveLength(4001);
    expect(new TextEncoder().encode(body).byteLength).toBe(results[1]!.bytes);
  });

  // Multi-byte text spans part boundaries in the real data (thousands of
  // rows carry it), and a boundary cut in CHARACTERS rather than bytes would
  // split one in half and corrupt the object.
  it("does not corrupt multi-byte text across a part boundary", async () => {
    seedFoodbank();
    const filler = "é£—".repeat(1700); // ~5 KB encoded, every char multi-byte
    const insert = db.prepare(
      `INSERT INTO foodbankchangeline (id, need_id, foodbank_id, item, type, category, group_name, created)
       VALUES (?, 1, 1, ?, 'need', 'Food', 'Tins', ?)`,
    );
    for (let i = 1; i <= 4000; i++) insert.run(i, `${filler}-${i}`, NOW);

    const { bucket } = await runDumps();
    const body = bodyOf(bucket, "items");

    expect(body).not.toContain("\uFFFD"); // no replacement characters
    expect(body.split("\r\n").filter(Boolean)).toHaveLength(4001);
  });
});

describe("retention -- 14 days, except the 1st of the month", () => {
  const today = "2026-09-10";

  it("keeps anything from the last 14 days", () => {
    expect(shouldKeep("items/csv/items-20260910.csv", today)).toBe(true);
    expect(shouldKeep("items/csv/items-20260828.csv", today)).toBe(true); // exactly 13 days
  });

  it("drops older dailies", () => {
    expect(shouldKeep("items/csv/items-20260826.csv", today)).toBe(false);
    expect(shouldKeep("foodbanks/csv/foodbanks-20260715.csv", today)).toBe(false);
  });

  // The rule that turns a rolling fortnight into a permanent monthly archive.
  it("keeps the 1st of the month forever", () => {
    expect(shouldKeep("items/csv/items-20260801.csv", today)).toBe(true);
    expect(shouldKeep("items/csv/items-20200101.csv", today)).toBe(true);
  });

  // The 2026-08-30 set Django left behind is 11 days old today and stays --
  // but this is really about not deleting keys we do not recognise.
  it("never deletes a key that is not one of ours", () => {
    expect(shouldKeep("something/else.txt", today)).toBe(true);
    expect(shouldKeep("items/json/items-20260101.json", today)).toBe(true);
  });

  it("deletes exactly the expired keys", async () => {
    const bucket = fakeBucket();
    for (const k of [
      "items/csv/items-20260910.csv", "items/csv/items-20260801.csv",
      "items/csv/items-20260826.csv", "notes.txt",
    ]) bucket.objects.set(k, { body: "", metadata: null });

    const deleted = await pruneDumps(bucket as never, today);

    expect(deleted).toEqual(["items/csv/items-20260826.csv"]);
    expect([...bucket.objects.keys()].sort()).toEqual([
      "items/csv/items-20260801.csv", "items/csv/items-20260910.csv", "notes.txt",
    ]);
  });
});
