-- WP 5.5 (PLAN.md §8.6): getarticles' idempotency depends on this. 0003
-- (WP 4.x, read-path only at the time) never added it. `INSERT OR IGNORE`
-- against foodbank_id/url would silently insert a genuine duplicate on
-- every Cloudflare Queues redelivery without a real UNIQUE constraint to
-- collide against -- this is what makes a redelivered message a no-op
-- rather than a duplicate row. Verified against remote D1's current
-- 17,196 rows: zero URL collisions, so this applies cleanly.
CREATE UNIQUE INDEX article_url_uniq ON foodbankarticle(url);
