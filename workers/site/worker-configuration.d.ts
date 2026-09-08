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
  STATIC_MEDIA: R2Bucket;
  ASSETS: Fetcher;
  // Cloudflare Images transform binding -- routes/media.ts's ?s= resizing.
  IMAGES: ImagesBinding;
  // Browser Rendering -- routes/wfbn/screenshot.ts.
  BROWSER: Fetcher;
  SESSIONS: KVNamespace;
  DATA: KVNamespace;
  HITS: AnalyticsEngineDataset;
  PURGE_Q: Queue<unknown>;
  JOBS_Q: Queue<unknown>;
  WHATSAPP_Q: Queue<unknown>;
  RENDER_Q: Queue<unknown>;
  ARTICLES_Q: Queue<unknown>;
  CHARITY_EW_Q: Queue<unknown>;
  CHARITY_SCOTLAND_Q: Queue<unknown>;
  CHARITY_NI_Q: Queue<unknown>;

  SITE_DOMAIN: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  TURNSTILE_SITEKEY: string;
  CF_ACCOUNT_ID: string;

  // `version_metadata` binding -- see wrangler.jsonc.
  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };

  GOOGLE_OAUTH_CLIENT_SECRET: string;
  SESSION_HMAC_KEY: string;
  SUBSCRIBER_SALT: string;
  TURNSTILE_SECRET: string;
  POSTMARK_TOKEN: string;
  CSRF_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  GMAP_STATIC_KEY: string;
  GMAP_PLACES_KEY: string;
  GMAP_GEOCODE_KEY: string;
  MAPIT_KEY: string;
  CF_API_KEY: string;
  CF_ZONE_ID: string;
  WHATSAPP_WEBHOOKVERIFYTOKEN: string;
  WHATSAPP_APP_SECRET: string;
}
