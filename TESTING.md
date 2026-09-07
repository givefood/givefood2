# Testing

```bash
pnpm test          # everything: vitest + the two byte-vector verifiers
pnpm test:unit     # vitest only
pnpm test:watch    # vitest in watch mode
pnpm typecheck     # tsc --noEmit across every package
```

## What exists

**48 test files, 1,961 vitest tests**, plus two standalone verifiers that
predate the suite (`verify:webpush` checks the RFC 8291 §5 vector byte for
byte; `verify:whatsapp` checks inbound command parsing against
`givefood/views.py:1366-1391`).

Tests are **colocated**: `src/foo.ts` is tested by `src/foo.test.ts`. There is
no `tests/` directory, so a module with no neighbouring test is visible at a
glance in any file listing.

The runner is plain vitest in a **node** environment, not
`@cloudflare/vitest-pool-workers`. Everything currently covered is pure logic
— formatters, parsers, header policy, geo maths, search ranking — and none of
it touches a binding, so node is both sufficient and fast (the whole suite is
under two seconds). `vitest.config.mts` pins `TZ=UTC`, because the Workers
runtime is UTC and Django ran with `TZ` pinned to UTC; without it a developer
in BST would see the timestamp helpers fail for an hour's offset, which is
precisely the class of bug those helpers exist to prevent.

## What is NOT covered

**48 of 246 modules have tests. 198 do not.** That is the honest number, and
it is here so a green run is not mistaken for a covered codebase.

| area | untested modules | why |
|---|---|---|
| `workers/site` routes | 117 | need D1, KV, R2, queue bindings and a session |
| `packages/db` | 42 | every function is a D1 query; needs a seeded database |
| `workers/jobs` | 31 | cron handlers and queue consumers; need bindings + fixtures |
| `packages/templates` | 8 | Nunjucks env, filters, i18n extensions |

Closing this needs `@cloudflare/vitest-pool-workers` with a seeded D1 — a
separate piece of work. Until it exists, **nothing in this repo tests that a
route returns the right HTML, that a query returns the right rows, or that a
cron does what it says.** The suite tests the pieces those things are built
from.

Specific pure-ish modules still excluded, and why: `lib/adminAuth.ts` (OAuth
flow), `lib/session.ts`, `lib/email.ts`, `lib/geocode.ts`, `lib/turnstile.ts`
(thin fetch wrappers), `middleware/slugRedirect.ts` (D1 lookup),
`needcheck/scrape.ts` and `needcheck/openrouter.ts` (Browser Rendering and
LLM calls).

## Conventions

**Tests pin current behaviour, not desired behaviour.** Where the port
knowingly diverges from Django, the test asserts what the code *does* and the
comment says why. A test that fails is therefore always a regression, never a
wishlist item. Two live examples:

- `feedParser.test.ts` asserts that `caf&eacute;` stays literal, because
  fast-xml-parser's `htmlEntities` decodes punctuation entities but not
  accented letters. That is a real defect; asserting the wish would have left
  the suite permanently red and told nobody anything.
- `textClean.test.ts` asserts the entity table holds **173** of HTML4's 252
  names, contradicting the module's own header comment.

**Comments explain why a test exists**, naming the failure it prevents, in the
same register as the rest of the codebase. Where a module documents an exact
Django behaviour, the test asserts that behaviour and says so.

**Parity claims are checked by running Python, not by reasoning.** During the
suite's construction an agent reported a `splitlines()` divergence that turned
out not to exist — `splitlines(True)` keeps a lone `\r` attached to its piece,
so the port already matched. "Fixing" it would have rewritten stored text for
every page with old-Mac line endings. If a test's comment claims CPython does
X, someone ran CPython.

**Several suites were mutation-tested**: the module was transpiled into a
scratchpad, deliberately broken, and the tests re-run to confirm they caught
it. Where a test survived a plausible wrong implementation it was strengthened
or deleted. This is why some files carry a comment naming the specific mutant
a test kills — that is the evidence the test is load-bearing, not decoration.

**No scratch files.** Mutation copies live in the scratchpad, never in `src/`.
