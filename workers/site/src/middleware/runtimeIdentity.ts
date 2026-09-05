import type { MiddlewareHandler } from "hono";
import { setRuntimeIdentity } from "@givefood/templates";
import type { AppEnv } from "../types";

// Fills in debugcomment.njk's "By machine" and "Using code" lines, which
// until 2026-09-05 read "cf-worker" and "dev" on every page of every
// deploy -- see packages/templates/src/context.ts for what Django put
// there and why it stopped meaning anything on Workers.
//
// Runs as middleware ONCE PER ISOLATE, not once per request: everything it
// records is a property of the isolate rather than of the request, so the
// `identity` module variable below cannot be a cross-request data leak the
// way a cached per-request value would be.
//   - colo: an isolate lives in exactly one Cloudflare data centre, so
//     every request it ever serves reports the same one.
//   - version: an isolate runs exactly one Worker version. A deploy starts
//     new isolates rather than swapping the code under an existing one.
// The env.ts Environment cache is the same pattern for the same reason.
//
// It is a middleware and not a top-level side effect because both values
// need a request (cf.colo) or a binding (env), and neither is reachable at
// module scope -- Workers disallows I/O and crypto in the global scope.

let identity: { colo: string; instanceId: string; version: string; commit: string | null } | null = null;

// Django used COOLIFY_CONTAINER_NAME[:7], which answered "which of the
// running containers served this?" -- useful when one instance is
// misbehaving and the others are fine. Workers exposes no isolate
// identifier at all, so this makes one up: 7 hex characters (matching
// Django's HASH_CHARS) minted the first time an isolate serves a request
// and stable for the rest of its life. It means nothing on its own, but it
// tells you whether two page loads came from the same isolate, which is
// the actual question Django's container name was answering.
//
// The colo it ran in is a separate line in debugcomment.njk rather than a
// prefix on this one: it answers "where", not "which", and unlike the
// isolate id it is a real value read off the request rather than an
// invented one.
function mintInstanceId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 7);
}

// SOURCE_COMMIT[:7] in Django -- the git commit the running code was built
// from, which is also what debugcomment.njk's GitHub link is built out of.
//
// A Worker version has no inherent connection to a commit: CF_VERSION_METADATA
// gives an `id` (a UUID, unique per upload) and a `tag` (free text, set only
// if the deploy set one). So:
//   - `commit` is the tag, but ONLY when it actually looks like a git SHA --
//     otherwise the template would render a GitHub URL that 404s. Nothing
//     currently sets the tag, so this is normally null and the template
//     drops the link line rather than showing a broken one.
//   - `version` falls back to the version id's first 8 characters, which is
//     enough to identify a deploy and to look one up:
//     `wrangler versions view <id>` / the dashboard's version list.
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function readVersion(meta: { id?: string; tag?: string } | undefined): { version: string; commit: string | null } {
  const tag = meta?.tag?.trim();
  const commit = tag && SHA_PATTERN.test(tag) ? tag.slice(0, 7) : null;
  if (commit) return { version: commit, commit };
  if (tag) return { version: tag, commit: null };
  const id = meta?.id;
  return { version: id ? id.slice(0, 8) : "unknown", commit: null };
}

export const runtimeIdentity: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!identity) {
    const { version, commit } = readVersion(c.env.CF_VERSION_METADATA);
    const colo = (c.req.raw.cf?.colo as string | undefined) ?? "unknown";
    identity = { colo, instanceId: mintInstanceId(), version, commit };
    setRuntimeIdentity(identity);
  }
  await next();
};
