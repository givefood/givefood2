import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types";

// PLAN.md WP 1.4/1.5: dumps move to R2, served directly from
// dumps.givefood.org.uk via an R2 custom domain (see wrangler r2 bucket
// domain add) -- no Worker code in that request path at all. This file is
// only the compatibility layer for the OLD /dumps/<type>/<format>/... URLs,
// which redirect to the new domain rather than 404ing.
//
// Bucket layout (givefood-dumps), mirroring Dump.file_name() exactly, one
// object per day -- no separate "latest" copy. Duplicating up to ~140 MB
// (items.json/xml) into a second object that needs re-uploading and can go
// stale is exactly the kind of thing "keep it simple" rules out; "latest"
// is resolved by listing the prefix and taking the lexicographically
// greatest key, which works because YYYYMMDD is fixed-width and zero-padded:
//   <type>/<format>/<type>-<YYYYMMDD>.<format>
//
// The three listing pages (dump_index, dump_type, dump_format) are NOT
// covered here -- gfdumps/urls.py keeps those as Django-rendered HTML for
// now; only the two download URL shapes redirect.
export const dumpsApp = new Hono<AppEnv>();

const DUMP_DOMAIN = "https://dumps.givefood.org.uk";

// /<type>/<format>/latest/ -> 302 to whichever dated object is actually
// newest right now (the target changes daily; the redirect itself must not
// be cached as permanent).
dumpsApp.get("/:type/:format/latest/", async (c: Context<AppEnv>) => {
  const { type, format } = c.req.param();
  const prefix = `${type}/${format}/`;

  // One object/day, so this bucket grows by ~365-1000 keys/year per
  // type+format -- comfortably under R2 list()'s 1000-key page before
  // pagination would ever matter. Revisit if that stops being true.
  const listed = await c.env.DUMPS.list({ prefix });
  if (listed.objects.length === 0) {
    return c.notFound();
  }
  const latestKey = listed.objects.map((o) => o.key).sort().at(-1)!;
  return c.redirect(`${DUMP_DOMAIN}/${latestKey}`, 302);
});

// /<type>/<format>/<Y>-<M>-<D>/ -> 301 (permanent; a given day's dump never
// changes). Django's URL uses three separate <int:> converters joined by
// literal dashes in ONE path segment, so non-zero-padded dates are valid
// and live today -- e.g. /foodbanks/csv/2026-8-9/ -- and must resolve here
// exactly as they do now, normalised to the zero-padded R2 key.
dumpsApp.get("/:type/:format/:date{\\d{1,4}-\\d{1,2}-\\d{1,2}}/", (c) => {
  const { type, format, date } = c.req.param();
  const parts = date.split("-");
  const year = parts[0]!;
  const month = parts[1]!;
  const day = parts[2]!;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) {
    return c.notFound();
  }
  const ymd = `${year.padStart(4, "0")}${month.padStart(2, "0")}${day.padStart(2, "0")}`;
  return c.redirect(`${DUMP_DOMAIN}/${type}/${format}/${type}-${ymd}.${format}`, 301);
});
