// TEMPORARY hand-written stub -- see workers/site/worker-configuration.d.ts
// for why. Regenerate with `pnpm --filter @givefood/jobs types` once
// wrangler.jsonc holds real resource ids.

export interface Env {
  DB: D1Database;
  DATA: KVNamespace;
  MEDIA: R2Bucket;
  GEO: R2Bucket;
  OPS: R2Bucket;
  BROWSER: Fetcher;
  HITS: AnalyticsEngineDataset;
  CRAWLS: AnalyticsEngineDataset;
  RENDER_Q: Queue<unknown>;
  PURGE_Q: Queue<unknown>;
  JOBS_Q: Queue<unknown>;
  ARTICLES_Q: Queue<unknown>;
  CHARITY_EW_Q: Queue<unknown>;
  CHARITY_SCOTLAND_Q: Queue<unknown>;
  CHARITY_NI_Q: Queue<unknown>;

  OPENROUTER_KEY: string;
  CF_BROWSER_TOKEN: string;
  CF_ACCOUNT_ID: string;
  GCP_TRANSLATE_KEY: string;
  EW_CHARITY_KEY: string;
  SCOT_CHARITY_KEY: string;
  POSTMARK_TOKEN: string;
  WHATSAPP_TOKEN: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_ADMIN_EMAIL: string;
  GMAP_STATIC_KEY: string;
  GMAP_PLACES_KEY: string;
  GMAP_GEOCODE_KEY: string;
  CF_API_KEY: string;
  CF_ZONE_ID: string;
}
