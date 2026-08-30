import { Absent, parse as buildXml } from "js2xmlparser";
import { isDatetimeValue, isFloatValue, isPlainObject, type SerialisableValue } from "./types";

// WP 2.3, PLAN.md §7.4.3. Structural, not byte, parity -- js2xmlparser (one
// dependency, xmlcreate) builds the actual XML string; this module's only
// job is reshaping the value tree into what it expects, and supplying the
// one piece of domain logic no library can know: which singular element
// name wraps each list's items (donationpoints deliberately has none,
// reproducing frozen bug B1's `<None>` tag, see PLAN.md §7.3).
//
// js2xmlparser quirks worth knowing, checked directly against its real
// output rather than assumed from the docs:
//   - A `null` value renders as literal text "null" unless replaced with
//     `Absent.instance`, which self-closes the element instead.
//   - An array renders as one repeated sibling element per item, using the
//     PARENT key as every item's tag -- there's no per-array item-name
//     option. Pre-wrapping as `{ [itemName]: [...items] }` produces the
//     nested container + singular-item-tag shape instead (verified:
//     `{ foodbanks: { foodbank: [...] } }` -> `<foodbanks><foodbank>...`).
//   - An empty array is dropped from the output entirely (not even a
//     self-closing tag); an empty object still self-closes. Recoded as
//     `{}` here so the key still appears.

const SINGULAR: Record<string, string | undefined> = {
  foodbanks: "foodbank",
  nearby_foodbanks: "foodbank",
  locations: "location",
  needs: "need",
  constituencies: "constituency",
  // donationpoints is DELIBERATELY absent -> element name "None" (frozen bug B1)
};
export const xmlItemName = (parentKey: string): string => SINGULAR[parentKey] ?? "None";

function transformValue(v: SerialisableValue, itemName: (parentKey: string) => string): unknown {
  if (v === null) return Absent.instance;
  if (typeof v === "boolean" || typeof v === "string" || typeof v === "number") return v;
  if (isFloatValue(v)) return v.__float;
  if (isDatetimeValue(v)) return v.__datetime;
  if (Array.isArray(v)) return v.map((item) => transformValue(item, itemName)); // top-level array; see transformObject for the keyed case
  if (isPlainObject(v)) return transformObject(v, itemName);
  return v;
}

function transformObject(
  obj: { [key: string]: SerialisableValue },
  itemName: (parentKey: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key] as SerialisableValue;
    if (Array.isArray(val)) {
      out[key] = val.length === 0 ? {} : { [itemName(key)]: val.map((item) => transformValue(item, itemName)) };
    } else {
      out[key] = transformValue(val, itemName);
    }
  }
  return out;
}

export function formatXml(
  rootTag: string,
  data: { [key: string]: SerialisableValue },
  itemName: (parentKey: string) => string = xmlItemName,
): string {
  return buildXml(rootTag, transformObject(data, itemName));
}
