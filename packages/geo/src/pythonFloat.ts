// Python's `float(str)`, for the two public search endpoints that reach
// Django's coordinate parsing with NO validation in front of them.
//
// WHY THIS EXISTS AT ALL (github #15, #16). JS's `Number()` and `parseFloat()`
// never throw: they answer NaN, and NaN then travels. In both search
// endpoints it travelled all the way to a 200 -- haversineMeters returns NaN,
// `nearest()`'s `a.distanceM - b.distanceM` comparator is NaN for every pair,
// ECMA-262 coerces a NaN comparator result to +0 so the stable sort is a
// no-op, and the caller receives the first ten rows of an unordered
// `SELECT ... WHERE is_closed = 0` with `distance_m: null`. Ten real food
// banks, real addresses, real phone numbers, in rowid order, presented as
// somebody's nearest. `?lattlong=51.5` -- a truncated coordinate, not
// deliberate garbage -- was enough to trigger it, live on www.givefood.org.uk.
//
// Django raises instead, and this reproduces the raise. It is NOT a
// validator: it must not return a clean 400 Django does not send. The throw
// is deliberately left uncaught so app.onError renders the same 500 Django's
// uncaught ValueError does -- the same technique api1.ts's pythonInt() already
// uses for frozen bug B4.
//
// SEMANTICS ESTABLISHED BY RUNNING CPython AGAINST THE REAL SOURCE, not from
// memory. Every row below was executed:
//
//   float("banana")   ValueError      float("0x10")     ValueError
//   float("")         ValueError      float("0b11")     ValueError
//   float(".")        ValueError      float("-")        ValueError
//   float(" 51.5 ")   51.5            float("51.5\n")   51.5
//   float("+51.5")    51.5            float("5e1")      50.0
//   float("51.")      51.0            float(".5")       0.5
//   float("1_0")      10.0            float("inf")      inf
//
// The underscore case is the one that looks like a typo and is not: PEP 515
// numeric literals are accepted by float() since Python 3.6, and rejecting
// them here would 500 an input Django answers 200 for -- the same class of
// divergence this file exists to close, pointing the other way.
//
// TWO DELIBERATE DIVERGENCES, both narrower than the bug they replace:
//
//   1. `inf` / `nan` are REJECTED here, where float() accepts them. Django
//      does not survive them either -- gfapi1/views.py:132 and
//      gfapi2/views.py:414 both do `int(foodbank.distance)`, and CPython's
//      `int(float("nan"))` raises ValueError while `int(float("inf"))` raises
//      OverflowError -- so Django reaches a 500 too, a few lines later and by
//      a different exception. Same status for the caller, and it keeps NaN
//      from re-entering the distance maths this whole fix is about.
//
//   2. NON-ASCII DECIMAL DIGITS are rejected. CPython accepts them --
//      `float("１２")` really is 12.0, fullwidth digits and all -- because
//      float() takes any Unicode Nd character. Matching that would mean
//      normalising the whole Unicode decimal-digit category for an input no
//      HTTP client has ever sent. Recorded rather than silently missed.
//
// Whitespace: Python strips a slightly different set from JS's trim() (it
// uses str.strip()'s definition). Both cover the space, tab and newline a
// real request could carry.
const PYTHON_FLOAT = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;

export function pythonFloat(raw: string): number {
  const trimmed = raw.trim();
  if (!PYTHON_FLOAT.test(trimmed)) {
    // The message is Python's, so a Worker log line reads the way the Django
    // traceback it replaces did.
    throw new Error(`could not convert string to float: '${raw}'`);
  }
  return Number(trimmed.replace(/_/g, ""));
}

// Django's coordinate read, INDEXED AND NOT UNPACKED -- which is the whole
// reason this is not the `parseQueryLatLng()` already sitting in
// api2/locations.ts. Both `is_uk()` (givefood/utils/geo.py:193-194) and
// `find_foodbanks()` (:213-214) are
//
//     float(lat_lng.split(",")[0])
//     float(lat_lng.split(",")[1])
//
// so a THIRD comma-separated part is ignored, not an error: CPython answers
// 51.5,-0.12 for both "51.5,-0.12,junk" and "51.5,-0.12,". A `parts.length
// !== 2` check -- which reads like the obvious way to write this, and which
// the sibling helper does use -- would 500 those, turning one divergence into
// another. The only unpacking `lat, lng = lat_lng.split(",")` in that file is
// in pluscode() (:548), a different function behind a try/except.
//
// A missing index 1 is Python's IndexError rather than ValueError. Different
// exception, identical outcome: uncaught, so a 500.
export function parseLatLngLikePython(raw: string): [number, number] {
  const parts = raw.split(",");
  if (parts.length < 2) throw new Error(`list index out of range: '${raw}'`);
  return [pythonFloat(parts[0] as string), pythonFloat(parts[1] as string)];
}
