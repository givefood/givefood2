// TEMPORARY hand-written stub. PLAN.md §3.4 says explicitly: "Run `wrangler
// types` in each Worker directory and commit the output. Hand-written Env
// interfaces drift from the config." This file exists only so the package
// typechecks before Cloudflare resources are provisioned and `wrangler
// login` is available in this environment -- replace it by running
// `pnpm --filter @givefood/site types` once the ids in wrangler.jsonc are
// real, and delete this comment.

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  GEO: R2Bucket;
  ASSETS: Fetcher;
  SESSIONS: KVNamespace;
  DATA: KVNamespace;
  HITS: AnalyticsEngineDataset;
  PURGE_Q: Queue<unknown>;
  JOBS_Q: Queue<unknown>;

  SITE_DOMAIN: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  TURNSTILE_SITEKEY: string;

  GOOGLE_OAUTH_CLIENT_SECRET: string;
  SESSION_HMAC_KEY: string;
  SUBSCRIBER_SALT: string;
  TURNSTILE_SECRET: string;
  POSTMARK_TOKEN: string;
  GMAP_STATIC_KEY: string;
  GMAP_PLACES_KEY: string;
  GMAP_GEOCODE_KEY: string;
  CF_API_KEY: string;
  CF_ZONE_ID: string;
}
