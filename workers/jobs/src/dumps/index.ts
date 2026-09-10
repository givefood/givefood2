import {
  dumpArticles, dumpDonationPointLocations, dumpDonationPoints, dumpFoodbanks, dumpItems,
  locationsForFoodbanks, type Session,
} from "@givefood/db";
import { formatCsvRow } from "@givefood/serialise";
import { ARTICLE_FIELDS, DONATIONPOINT_FIELDS, FOODBANK_FIELDS, ITEM_FIELDS } from "./fields";
import { articleRow, donationPointLocationRow, donationPointRow, foodbankLocationRow, foodbankRow, itemRow } from "./rows";
import { R2CsvStream, type DumpTarget } from "./r2Stream";

// gfdumps' generation cron (github #59), CSV only.
//
// Django wrote 4 types x 3 formats into a Postgres text column and served
// them from /dumps/. This writes 4 CSVs straight to R2 -- no `dump` metadata
// table, by maintainer decision: the bucket's own listing is the index.
// (0002_dump.sql created that table and 0012_drop_dump_table.sql removed it;
// neither comes back.)
//
// KEY FORMAT IS NOT A CHOICE. givefood-dumps already holds a full set of
// Django-generated dumps from 2026-08-30 under
// `<type>/<format>/<type>-<YYYYMMDD>.<ext>` -- e.g.
// `items/csv/items-20260830.csv` -- where the filename half reproduces
// Django's own Dump.file_name(). Writing to any other shape would leave two
// naming schemes in one bucket and orphan the archive that is already there,
// so this matches it exactly. The objects are stored uncompressed, and so are
// these: the sizes in the bucket are the raw byte counts.

const CONTENT_TYPE = "text/csv; charset=utf-8";

/** `<type>/csv/<type>-<YYYYMMDD>.csv`, matching the 2026-08-30 objects already in the bucket. */
export function dumpKey(type: string, date: string): string {
  return `${type}/csv/${type}-${date.replace(/-/g, "")}.csv`;
}

/** Django's Dump.file_name(), which the existing objects carry as their filename. */
function metadataFor(type: string, date: string): Record<string, string> {
  return {
    contentType: CONTENT_TYPE,
    contentDisposition: `attachment; filename="${type}-${date.replace(/-/g, "")}.csv"`,
    // Dated objects never change once written.
    cacheControl: "public, max-age=31536000, immutable",
  };
}

/** dump.py's header row, then the data rows, through Python's QUOTE_ALL dialect. */
function csvHeader(fields: readonly string[]): string {
  return formatCsvRow(fields as unknown[], true);
}

export interface DumpResult {
  key: string;
  rows: number;
  bytes: number;
}

async function writeDump(
  bucket: DumpTarget,
  key: string,
  metadata: Record<string, string>,
  fields: readonly string[],
  rows: AsyncGenerator<unknown[][]>,
): Promise<DumpResult> {
  const stream = new R2CsvStream(bucket, key, metadata);
  let count = 0;
  try {
    await stream.write(csvHeader(fields));
    for await (const page of rows) {
      // One string per page, not per row: ~1,000 small writes per page would
      // each re-encode to measure themselves, and the buffer only cares
      // about totals.
      let chunk = "";
      for (const row of page) {
        chunk += formatCsvRow(row, true);
        count++;
      }
      await stream.write(chunk);
    }
    const bytes = await stream.close();
    return { key, rows: count, bytes };
  } catch (err) {
    await stream.abort();
    throw err;
  }
}

/** The foodbanks dump: each food bank, then each of its locations. */
async function* foodbankRows(session: Session): AsyncGenerator<unknown[][]> {
  for await (const page of dumpFoodbanks(session)) {
    const locations = await locationsForFoodbanks(session, page.map((f) => f.id));
    const out: unknown[][] = [];
    for (const f of page) {
      out.push(foodbankRow(f));
      for (const l of locations.get(f.id) ?? []) out.push(foodbankLocationRow(f, l));
    }
    yield out;
  }
}

/** The donation points dump: the donation points, then the locations flagged as one. */
async function* donationPointRows(session: Session): AsyncGenerator<unknown[][]> {
  for await (const page of dumpDonationPoints(session)) yield page.map(donationPointRow);
  for await (const page of dumpDonationPointLocations(session)) yield page.map(donationPointLocationRow);
}

export async function generateDumps(session: Session, bucket: DumpTarget, date: string): Promise<DumpResult[]> {
  const results: DumpResult[] = [];

  results.push(await writeDump(bucket, dumpKey("foodbanks", date), metadataFor("foodbanks", date), FOODBANK_FIELDS, foodbankRows(session)));

  results.push(
    await writeDump(bucket, dumpKey("items", date), metadataFor("items", date), ITEM_FIELDS, (async function* () {
      for await (const page of dumpItems(session)) yield page.map(itemRow);
    })()),
  );

  results.push(await writeDump(bucket, dumpKey("donationpoints", date), metadataFor("donationpoints", date), DONATIONPOINT_FIELDS, donationPointRows(session)));

  results.push(
    await writeDump(bucket, dumpKey("articles", date), metadataFor("articles", date), ARTICLE_FIELDS, (async function* () {
      for await (const page of dumpArticles(session)) yield page.map(articleRow);
    })()),
  );

  return results;
}

/**
 * dump.py:634-642's retention, moved to R2 keys.
 *
 * "Older than 14 days EXCEPT the 1st of the month" -- Django read
 * `created__day`; the date is in the key here, so the rule is a string test
 * and needs no metadata. Keeping the 1st is what makes the archive a monthly
 * series going back indefinitely rather than a rolling fortnight.
 */
export function shouldKeep(key: string, today: string): boolean {
  // `<type>/csv/<type>-YYYYMMDD.csv`
  const match = /-(\d{4})(\d{2})(\d{2})\.csv$/.exec(key);
  if (!match) return true; // not one of ours: never delete what we do not recognise
  const [, y, m, d] = match;
  if (d === "01") return true; // the 1st of the month is kept forever
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 14);
  return `${y}-${m}-${d}` >= cutoff.toISOString().slice(0, 10);
}

export async function pruneDumps(
  bucket: { list(options?: unknown): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>; delete(keys: string[]): Promise<void> },
  today: string,
): Promise<string[]> {
  const doomed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: 1000, cursor });
    for (const o of page.objects) if (!shouldKeep(o.key, today)) doomed.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // delete() takes up to 1,000 keys per call.
  for (let i = 0; i < doomed.length; i += 1000) await bucket.delete(doomed.slice(i, i + 1000));
  return doomed;
}
