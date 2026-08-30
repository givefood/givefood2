import { haversineMeters } from "./haversine";

export interface Ranked<T> {
  item: T;
  distanceM: number;
}

// Every nearest-N search endpoint in the API uses skip_first=False (only
// the HTML /needs/at/<slug>/nearby/ pages -- Phase 3, not this work
// package -- use skip_first=True). PLAN.md §7.5.2 proves a single global
// sort+slice is contract-exact for the skip_first=False case even though
// find_locations()/find_donationpoints() independently cap two source
// querysets at `quantity` before merging in Django: "any member of the
// true global top-20 can have at most 19 items closer than it -- and
// therefore is always present in its own leg's 20." So there's no need to
// reproduce the two-independently-capped-then-merged dance here -- rank
// the full candidate set (locations()+donation points already `chain`d by
// the caller, if searching more than one type) and slice once.
//
// `skipFirst` is kept for foodbank.nearby() (gfapi2's `foodbank` detail
// endpoint reads `nearby_foodbanks` this way, dropping the food bank
// itself, which is always index 0 at distance 0).
export function nearest<T>(
  items: readonly T[],
  lat: number,
  lng: number,
  getLatLng: (item: T) => readonly [number, number],
  quantity: number,
  R: number,
  skipFirst = false,
): Ranked<T>[] {
  const ranked = items
    .map((item) => {
      const [itemLat, itemLng] = getLatLng(item);
      return { item, distanceM: haversineMeters(lat, lng, itemLat, itemLng, R) };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
  const start = skipFirst ? 1 : 0;
  const end = start + quantity;
  return ranked.slice(start, end);
}
