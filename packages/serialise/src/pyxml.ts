import { pyFloatRepr } from "./pyfloat";
import { isPlainObject, isPyDatetime, isPyFloat, type PyValue } from "./types";

// WP 2.3, PLAN.md §7.4.3. Byte-exact -- see pyjson.ts for why JSON dropped
// that bar (native JSON.stringify's runtime speed) while XML keeps a
// hand-written renderer: there's no native XML builder in the Workers
// runtime to lean on instead, so byte-exactness costs nothing extra here.
// Reproduces
// `parseString(dicttoxml.dicttoxml(data, attr_type=False, custom_root=obj_name,
// item_func=xml_item_name)).toprettyxml()`.
//
// Every structural rule below was checked against the real pinned library
// output (dicttoxml 1.7.16, matching production's uv.lock) with a script
// exercising nested dicts, lists of dicts, an unmapped list key,
// unicode/astral text, and `&`/`<`/`>` in text content -- not transcribed
// from the plan text alone:
//   - Non-ASCII is emitted as raw UTF-8, not \u-escaped.
//   - null, "", an empty list and an empty dict all self-close identically:
//     `<tag/>`, no space before the slash -- the null/empty distinction is
//     already lost here, and that's the existing contract (PLAN.md §7.4.7).
//   - An element with exactly one scalar child renders on one line:
//     `<id>123</id>`, at any depth.
//   - A multiline string's embedded newlines are emitted raw and
//     UN-indented -- minidom's pretty-printer never touches text-node
//     content: `<needs>Beans\nPasta</needs>`.
//   - Indentation is one literal TAB per level.
//   - Only `&`, `<`, `>` are escaped in text content -- not quotes.

const SINGULAR: Record<string, string | undefined> = {
  foodbanks: "foodbank",
  nearby_foodbanks: "foodbank",
  locations: "location",
  needs: "need",
  constituencies: "constituency",
  // donationpoints is DELIBERATELY absent -> element name "None" (frozen bug B1)
};
export const xmlItemName = (parentKey: string): string => SINGULAR[parentKey] ?? "None";

function xmlEscapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isEmpty(v: PyValue): boolean {
  if (v === null) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

// Returns the raw text content if `v` renders as a single-text-child
// element; null if it needs child elements instead (array or non-empty
// object). XML has no null/datetime-precision special casing beyond this:
// datetimes keep all 6 digits, unlike JSON's 3 (PLAN.md §7.4.6).
function scalarText(v: PyValue): string | null {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (isPyFloat(v)) return pyFloatRepr(v.__pyfloat);
  if (isPyDatetime(v)) return v.__pydatetime;
  return null;
}

function renderElement(tag: string, value: PyValue, itemName: (parentKey: string) => string, indent: string): string {
  if (isEmpty(value)) return `${indent}<${tag}/>`;

  const text = scalarText(value);
  if (text !== null) return `${indent}<${tag}>${xmlEscapeText(text)}</${tag}>`;

  if (Array.isArray(value)) {
    const childTag = itemName(tag);
    const children = value.map((item) => renderElement(childTag, item, itemName, indent + "\t")).join("\n");
    return `${indent}<${tag}>\n${children}\n${indent}</${tag}>`;
  }

  const obj = value as Record<string, PyValue>;
  const children = Object.keys(obj)
    .map((k) => renderElement(k, obj[k] as PyValue, itemName, indent + "\t"))
    .join("\n");
  return `${indent}<${tag}>\n${children}\n${indent}</${tag}>`;
}

export function pyXml(
  rootTag: string,
  data: { [key: string]: PyValue },
  itemName: (parentKey: string) => string = xmlItemName,
): string {
  return `<?xml version="1.0" ?>\n${renderElement(rootTag, data, itemName, "")}\n`;
}
