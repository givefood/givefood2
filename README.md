# givefood2

Cloudflare Workers port of [givefood.org.uk](https://www.givefood.org.uk) — migrated off Django/Postgres and rebuilt from scratch on Workers, Hono, D1, and R2. This is what serves the site.

The original Django app lives in a separate, untouched repo. It is no longer running; it remains the reference this port is read against whenever a behaviour is in question, which is often — most of the comments in here cite the file and line they were ported from.

**Full architecture, decisions, and delivery plan: [`PLAN.md`](PLAN.md).** It is the single source of truth for *why* things are built the way they are — this README only covers *how to work in the repo day to day*.

## Status

**Live.** givefood.org.uk is served by `workers/site`, and D1 is the datastore it reads and writes — the daily crons, the admin and every public route all land there. The Django/Postgres original is no longer in the request path; it stays as the read-only reference this port is checked against, and nothing here has ever written to it.

`PLAN.md` §10 still describes the phased migration in the future tense in places. Treat this README as the account of what is running; treat `PLAN.md` as the record of why it is built this way.

**Nothing returns `501`.** It used to: three catch-all mounts answered "not ported" to anything unmatched, and badly overstated the gap. Every URL in Django's own patterns is now either ported or deliberately out of scope, and out-of-scope URLs 404 (`OUT_OF_SCOPE` in `workers/site/src/index.ts`) because 404 is the truthful answer for a page that is never coming. `routes/notPortedYet.ts` still exports `notPortedPath()`/`notPortedSubtree()` for a genuine gap — use those rather than a catch-all.

## Layout

```
packages/
  ai/          Gemini client + the food bank check prompt
  db/          D1 query layer + migrations (packages/db/migrations)
  geo/         Haversine distance + nearest-neighbour ranking, and CPython float parity
  models/      Field/URL helpers ported from the Django models (charity URLs, slugify, Python datetime formatting)
  serialise/   Byte-exact-parity serialisers (CSV/XML/YAML/GeoJSON) and Python-repr float formatting
  templates/   Nunjucks templates, i18n catalogues, precompilation build step
  urls/        The reverse-URL table -- Django's `{% url %}` / `reverse()`, including locale prefixing
workers/
  site/        The public-facing Worker (Hono) — all HTTP routes
  jobs/        Queue consumers / scheduled tasks (crons, the needcheck pipeline, the daily dumps)
tools/
  pg-to-d1/         One-off Postgres -> D1 data extraction
  pg-to-r2/         Postgres blob -> R2 loading
  secrets-file/     Secrets file generation
  webpush-vector/   Web Push crypto verification vectors
  whatsapp-command/ WhatsApp command parser verification
```

Anything that needs a givefood.org.uk path — a template, a route handler, a sitemap, a redirect target — reverses it through `@givefood/urls` rather than writing the path out. It is a standalone package precisely so plain route/lib code can import it without pulling in the template engine.

## Local development

Requires Node 24 (see `.nvmrc`) and pnpm, plus `wrangler login` done once on your machine (D1/R2 access uses your own Cloudflare OAuth token, not a stored API key).

```bash
pnpm install
pnpm dev:site      # wrangler dev for workers/site, http://localhost:8787
pnpm dev:jobs      # wrangler dev for workers/jobs
pnpm typecheck     # tsc --noEmit across every package (also precompiles templates)
pnpm test          # the full suite (~12,000 tests, ~17s) plus the two verification harnesses
pnpm test:unit     # vitest only, without those harnesses
```

The suite is the main safety net for a port whose whole job is matching another
implementation, so it is large and it is expected to stay green. Two conventions
are worth knowing before adding to it:

- **Test doubles model the real service's limits, not just its shape.** D1 caps
  bound parameters at 100 and R2 requires every non-trailing multipart part to be
  the same length; the fakes enforce both, with the real error text, because a
  double looser than production turns a green suite into evidence for a false
  claim.
- **Behaviour that is pinned rather than endorsed says so.** A test titled
  "reported rather than fixed" or "suspect, pinned as-is" is recording a known
  divergence, not blessing it — when you fix one, flip the test and keep the old
  name in a comment rather than deleting it.

D1 migrations live in `packages/db/migrations/` and are applied with wrangler from `workers/site/`:

```bash
cd workers/site
npx wrangler d1 migrations apply givefood --local   # local dev database
npx wrangler d1 migrations apply givefood --remote  # production D1 — apply both, they don't sync automatically
```

## Deployment

`workers/site` deploys automatically: pushes to `main` trigger Cloudflare Workers
Builds (a plain `wrangler deploy`, with the Nunjucks precompile running from
`wrangler.jsonc`'s own `build.command` hook).

**`workers/jobs` has no Workers Builds project and deploys by hand:**

```bash
npx wrangler deploy -c workers/jobs/wrangler.jsonc
```

It must be run with that explicit `-c`, or from `workers/jobs/`. A bare
`wrangler deploy` at the repo root fails — wrangler refuses to guess which of the
two Workers a pnpm workspace means.

## Scheduled work

`workers/jobs` runs seven crons, all times UTC (Cloudflare's scheduler has no
timezone, so 15:00 is 16:00 in British Summer Time). The admin's Jobs page lists
them, and a test pins that list against `workers/jobs/wrangler.jsonc` so the two
cannot drift.

| cron | job |
|---|---|
| `0 15 * * *` | needcheck — sweeps every open food bank's needs page |
| `20 8-22/2 * * *` | getarticles — news/article feeds, every 2 hours |
| `30 5 * * *` | charityinfo — charity register details |
| `30 4 * * *` | dump — the four daily CSVs into the `givefood-dumps` R2 bucket |
| `10 3 * * *` | crawlitem retention prune |
| `30 3 * * SUN` | days_between_needs recompute |
| `*/5 * * * *` | `/frag/` payload refresh into KV |
