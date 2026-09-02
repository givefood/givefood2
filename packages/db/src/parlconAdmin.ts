import type { Session } from "./types";

// WP 6.5: ParliamentaryConstituencyForm's write path (forms.py:249-252,
// no save() override -- plain ModelForm). `slug`/`mp_display_name` are
// editable=False (never reach here from POST data, matching the pattern
// already established in locationsAdmin.ts/donationPointsAdmin.ts) --
// `slug` is generated here the same way, since nothing else does.
// `latitude`/`longitude` are explicitly NOT derived from `centroid`: the
// D1 schema's own comment (migrations/0001_core.sql:134) confirms they're
// vestigial in production -- every real reader (`latt()`/`long()`) parses
// `centroid` directly, so there's nothing to keep in sync.
const COMBINING_MARKS_RE = new RegExp(`[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`, "g");

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(/[^\x00-\x7F]/g, "");
  return ascii
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

export interface UpsertParlconParams {
  name: string;
  country: string | null;
  mp: string | null;
  mpParty: string | null;
  mpParlId: number;
  email: string | null;
  centroid: string;
  boundaryGeojson: string | null;
}

export async function upsertParliamentaryConstituency(session: Session, params: UpsertParlconParams, existingId: number | undefined): Promise<string> {
  const slug = slugify(params.name);

  if (existingId === undefined) {
    await session
      .prepare(
        `INSERT INTO parliamentaryconstituency (name, slug, country, mp, mp_party, mp_parl_id, email, centroid, boundary_geojson)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(params.name, slug, params.country, params.mp, params.mpParty, params.mpParlId, params.email, params.centroid, params.boundaryGeojson)
      .run();
  } else {
    await session
      .prepare(
        `UPDATE parliamentaryconstituency SET name = ?, slug = ?, country = ?, mp = ?, mp_party = ?, mp_parl_id = ?, email = ?, centroid = ?, boundary_geojson = ?
         WHERE id = ?`,
      )
      .bind(params.name, slug, params.country, params.mp, params.mpParty, params.mpParlId, params.email, params.centroid, params.boundaryGeojson, existingId)
      .run();
  }
  return slug;
}
