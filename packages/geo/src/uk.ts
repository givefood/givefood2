// Verified against givefood/utils/geo.py: `miles()` is a plain multiply,
// `is_uk()` a bounding-box check with strict comparisons in this exact
// order (PLAN.md §7.5.4: "a food bank on the boundary is a real edge case
// in Shetland and the Isles of Scilly").
export function miles(meters: number): number {
  return meters * 0.000621371192;
}

const SW_LAT = 49.1;
const SW_LNG = -14.015517;
const NE_LAT = 61.061;
const NE_LNG = 2.0919117;

export function isUk(lat: number, lng: number): boolean {
  if (lat < SW_LAT) return false;
  if (lng < SW_LNG) return false;
  if (lat > NE_LAT) return false;
  if (lng > NE_LNG) return false;
  return true;
}
