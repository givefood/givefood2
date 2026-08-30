import { formatJson, formatXml, formatYaml, type SerialisableValue } from "@givefood/serialise";

// Port of gfapi2/func.py's ApiResponse() + its ALLOWED_FORMATS table,
// read verbatim from source. json/geojson both render through the same
// JSON encoder (geojson is just a GeoJSON-shaped dict, not a distinct
// wire format -- func.py routes both to the same JsonResponse branch).
// CORS is 2xx-only by construction here: the 400 branch returns before
// the header would be set, matching the real asymmetry PLAN.md's §7.7.2
// documents (a malformed request gets an opaque CORS failure, not a
// clean 400, in any browser client -- reproduce it, don't fix it).
const STD_FORMATS = ["json", "xml", "yaml"];
const STD_FORMATS_GEOJSON = ["json", "xml", "yaml", "geojson"];

const ALLOWED_FORMATS: Record<string, string[]> = {
  foodbank: STD_FORMATS_GEOJSON,
  foodbanks: STD_FORMATS_GEOJSON,
  location: STD_FORMATS,
  locations: STD_FORMATS_GEOJSON,
  donationpoints: STD_FORMATS_GEOJSON,
  need: STD_FORMATS,
  needs: STD_FORMATS,
  constituency: STD_FORMATS_GEOJSON,
  constituencies: STD_FORMATS,
};

export const SECONDS_IN_HOUR = 3600;
export const SECONDS_IN_DAY = 86400;
export const SECONDS_IN_WEEK = 604800;
export const SECONDS_IN_MONTH = 2419200;

export function apiResponse(
  data: SerialisableValue,
  objName: keyof typeof ALLOWED_FORMATS,
  format: string,
  maxAgeSeconds: number,
): Response {
  const allowed = ALLOWED_FORMATS[objName] as string[]; // objName's type guarantees a hit; noUncheckedIndexedAccess doesn't know that
  if (!allowed.includes(format)) {
    return new Response("", { status: 400 }); // HttpResponseBadRequest() -- empty body, no CORS header
  }

  let body: string;
  let contentType: string;
  if (format === "json" || format === "geojson") {
    body = formatJson(data, 2);
    contentType = "application/json";
  } else if (format === "xml") {
    // formatXml/formatYaml take an array or a keyed object -- a `need`/
    // `foodbank` detail endpoint passes an object, a list endpoint passes
    // response_list (a bare array) straight through, matching the Python
    // source exactly either way (see formatXml's own header comment).
    body = formatXml(objName, data as SerialisableValue[] | { [key: string]: SerialisableValue });
    contentType = "text/xml";
  } else {
    body = formatYaml(data as SerialisableValue[] | { [key: string]: SerialisableValue });
    contentType = "text/yaml";
  }

  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`,
    },
  });
}
