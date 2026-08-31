# givefood2

Cloudflare Workers port of [givefood.org.uk](https://www.givefood.org.uk) — an in-progress migration off Django/Postgres, run on the same domain's data but built from scratch on Workers, Hono, D1, and R2.

This repo is the migration target. The original Django app lives in a separate, untouched repo that this one is ported from and continuously checked against.

**Full architecture, decisions, and delivery plan: [`PLAN.md`](PLAN.md).** It is the single source of truth for *why* things are built the way they are — this README only covers *how to work in the repo day to day*.

## Status

Under active migration, phase by phase (see `PLAN.md` §10 for the full breakdown). Each phase copies whatever Postgres tables its own routes need into D1 (read-only against the source), then builds and proves that slice on Workers before moving on. Postgres remains authoritative until the final cutover phase — nothing here writes back to it.

Anything not yet ported returns `501` with a message naming the gap, rather than a silent 404, so unported surface is obvious during development.

## Layout

```
packages/
  db/          D1 query layer + migrations (packages/db/migrations)
  geo/         Haversine distance + nearest-neighbour ranking
  serialise/   Byte-exact-parity serialisers (CSV/XML/YAML/GeoJSON) and Python-repr float formatting
  templates/   Nunjucks templates, i18n catalogues, precompilation build step
workers/
  site/        The public-facing Worker (Hono) — all HTTP routes
  jobs/        Queue consumers / scheduled tasks
tools/
  pg-to-d1/    One-off Postgres -> D1 data extraction script
```

A few `packages/*` directories (`i18n`, `models`, `shared`, `urls`) are reserved/empty scaffolding, not yet built out — the code that would live there today lives inline in `packages/templates/src/`.

## Local development

Requires Node 24 (see `.nvmrc`) and pnpm, plus `wrangler login` done once on your machine (D1/R2 access uses your own Cloudflare OAuth token, not a stored API key).

```bash
pnpm install
pnpm dev:site      # wrangler dev for workers/site, http://localhost:8787
pnpm dev:jobs      # wrangler dev for workers/jobs
pnpm typecheck     # tsc --noEmit across every package (also precompiles templates)
```

D1 migrations live in `packages/db/migrations/` and are applied with wrangler from `workers/site/`:

```bash
cd workers/site
npx wrangler d1 migrations apply givefood --local   # local dev database
npx wrangler d1 migrations apply givefood --remote  # production D1 — apply both, they don't sync automatically
```

## Deployment

Pushes to `main` trigger Cloudflare Workers Builds automatically (a plain `wrangler deploy`, via `wrangler.jsonc`'s own `build.command` hook for the Nunjucks precompile step) — there is no separate CI/CD pipeline to run by hand.
