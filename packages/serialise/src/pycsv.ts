import { pyFloatRepr } from "./pyfloat";

// WP 2.3, PLAN.md §7.4.5. Two dialects, both real production contracts:
// `unicodecsv.writer(response)` (default `excel`, QUOTE_MINIMAL) for
// `/api/1/foodbanks/?format=csv`, and QUOTE_ALL for the dump exports
// (`gfdumps/management/commands/dump.py`). Verified against the real
// pinned library (unicodecsv 0.14.1) for both dialects: QUOTE_MINIMAL
// leaves None/"" as a bare empty field; QUOTE_ALL quotes everything,
// including `None -> ""` and `True -> "True"`. Neither dialect preserves
// the null/empty-string distinction -- already lost in the real API, not
// something to "improve" here.
export function pyCsvRow(vals: unknown[], quoteAll = false): string {
  return (
    vals
      .map((v) => {
        const s =
          v === null || v === undefined
            ? ""
            : typeof v === "boolean"
              ? v
                ? "True"
                : "False"
              : typeof v === "number"
                ? Number.isInteger(v)
                  ? String(v)
                  : pyFloatRepr(v)
                : String(v);
        const needsQuoting = quoteAll || /[,"\r\n]/.test(s);
        return needsQuoting ? '"' + s.replace(/"/g, '""') + '"' : s;
      })
      .join(",") + "\r\n"
  );
}
