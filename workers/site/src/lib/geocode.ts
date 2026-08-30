import type { Context } from "hono";
import type { AppEnv } from "../types";

// Ported from givefood/utils/geo.py's geocode() -- never throws. Any HTTP
// failure or malformed response falls back to "0,0", exactly like the
// Python original (its bare `except (KeyError, IndexError, ValueError)`
// around a failed lookup). Every call site already runs the result through
// isUk() (or, for gfapi1, doesn't -- see api1.ts's B6 comment), which
// naturally rejects "0,0" the same way it rejects any other out-of-UK
// coordinate -- no separate "geocoding failed" branch is needed.
export async function geocode(c: Context<AppEnv>, address: string): Promise<string> {
  const key = c.env.GMAP_GEOCODE_KEY;
  const ukAddress = `${address},UK`;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?region=uk&key=${key}&address=${encodeURIComponent(ukAddress)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return "0,0";
    }
    const data = (await response.json()) as {
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    const location = data.results?.[0]?.geometry?.location;
    if (location?.lat === undefined || location?.lng === undefined) {
      return "0,0";
    }
    return `${location.lat},${location.lng}`;
  } catch {
    return "0,0";
  }
}
