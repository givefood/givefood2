// WP 2.5, PLAN.md §7.5.1. Two different Earth radii, kept deliberately
// distinct -- PLAN.md: "The two radii differ by 0.175%... Keep both
// constants, per endpoint. Do not unify."
export const R_EARTHDISTANCE = 6378168; // api/2/* -- matches Postgres earth_distance() (ll_to_earth's assumed sphere)
export const R_PYTHON = 6367000; // api/1/* -- matches givefood/utils/geo.py's distance_meters(), verified directly against that source

// Verified against givefood/utils/geo.py's distance_meters(): same
// sin/cos/asin(sqrt(a)) form, not the algebraically-equivalent
// 2*R*asin(chord/2R) form -- matching it keeps intermediate float rounding
// identical to the Python path for /api/1/*, per PLAN.md §7.5.1.
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number, R: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a))); // clamp: FP drift can push sqrt(a) fractionally over 1 at distance 0
}
