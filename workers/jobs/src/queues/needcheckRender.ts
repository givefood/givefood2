import type { Env } from "../../worker-configuration";
import {
  decrementCrawlSetRemaining,
  finishCrawlItem,
  getFoodbankForNeedCheck,
  getLastPublishedNeed,
  getLastUnpublishedNeeds,
  insertCrawlItem,
  insertFoodbankChange,
  insertFoodbankDiscrepancy,
  updateFoodbankLastNeedCheck,
} from "@givefood/db";
import { buildNeedPrompt, type NeedPromptLastNeed } from "../needcheck/prompt";
import { getMarkdown, scrapeBankTheFood, scrapeFacebook, scrapeTypeFor } from "../needcheck/scrape";
import { extractNeed } from "../needcheck/openrouter";
import { cleanFoodbankNeedText } from "@givefood/models";
import { decideNeedChange } from "../needcheck/decision";

// PLAN.md §8.5.3: the needcheck RENDER_Q consumer, ported stage-for-stage
// from givefood/utils/crawlers.py:281-575 (do_foodbank_need_check). This
// is "the single highest-stakes piece of the jobs Worker" (routes/
// scheduled/index.ts's own comment) -- every safeguard (S1, S5, S6, S7)
// is reproduced verbatim, not simplified, per §8.5.6's own warning that
// the June 2026 incident was a silent-corruption failure a naive port
// would not have caught either.

export interface NeedcheckRenderMessage {
  crawlSetId: number;
  foodbankId: number;
  slug: string;
  name: string;
  url: string;
  shoppingListUrl: string;
  facebookPage: string | null;
}

const NONPERTINENT_WINDOW = 10; // crawlers.py:484's [:10]

export async function handleNeedcheckRenderQueue(batch: MessageBatch<NeedcheckRenderMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOne(env, message.body);
      message.ack();
    } catch (err) {
      if (err instanceof PermanentOpenRouterFailure) {
        // WP 5.4: ack rather than retry -- a 402 (insufficient balance)
        // fails identically on every retry and on every other food
        // bank's message today, so retrying just multiplies the same
        // failure ~1,024x instead of surfacing it once. Record it as a
        // discrepancy so it lands in the queue a human reads every
        // morning, same as any other needcheck failure does.
        console.error(`needcheck-render: permanent OpenRouter failure for foodbank ${message.body.foodbankId} (${message.body.slug})`, err.message);
        const session = env.DB.withSession("first-unconstrained");
        await insertFoodbankDiscrepancy(session, {
          foodbankId: message.body.foodbankId,
          url: message.body.url,
          discrepancyType: "website",
          discrepancyText: `Need check failed: ${err.message}`,
        }).catch((discErr) => console.error("needcheck-render: also failed to write the permanent-failure discrepancy", discErr));
        message.ack();
        continue;
      }
      console.error(`needcheck-render: message failed for foodbank ${message.body.foodbankId} (${message.body.slug})`, err);
      // crawlers.py:451-474 sleeps 60s between its own two attempts; a
      // Worker can't block wall clock, so that backoff moves here, to the
      // one retry that's actually a fresh Cloudflare Queues delivery
      // rather than an in-process loop. Without a delay, a genuine
      // provider outage gets hit at full concurrency on every retry too.
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function processOne(env: Env, msg: NeedcheckRenderMessage): Promise<void> {
  const session = env.DB.withSession("first-unconstrained");

  // crawlers.py:579-590 does Foodbank.objects.get(slug=...) fresh
  // immediately before scraping, every time -- re-fetch by id here rather
  // than trusting the cron's enqueue-time snapshot (msg.*), which can go
  // stale during the enqueue-to-dequeue window (realistically multi-minute
  // at max_concurrency 25 over ~1,024 messages) if an admin fixes a URL or
  // migrates web->Facebook in the meantime.
  const foodbank = await getFoodbankForNeedCheck(session, msg.foodbankId);
  if (!foodbank) {
    // Deleted between enqueue and dequeue -- matches Django's
    // Foodbank.DoesNotExist there, which is likewise uncaught.
    throw new Error(`needcheck-render: foodbank ${msg.foodbankId} (${msg.slug}) no longer exists`);
  }

  // Stage 1 -- open the CrawlItem immediately (crawlers.py:285-291), so a
  // crash between here and the close below leaves a row with finish IS
  // NULL -- exactly how a stall is detected. insertCrawlItem is an upsert
  // keyed on (crawl_set_id, foodbank_id) -- a Cloudflare Queues redelivery
  // of this same message reopens this same row rather than orphaning a
  // second one (see its own comment in packages/db/src/needcheck.ts).
  const crawlItemId = await insertCrawlItem(session, {
    crawlSetId: msg.crawlSetId,
    crawlType: "need",
    foodbankId: msg.foodbankId,
    url: foodbank.shopping_list_url,
  });

  const finish = async (needId: number | null) => {
    // finishCrawlItem reports false when a prior delivery of this same
    // message already closed this row (its `finish IS NULL` guard) --
    // skip the rest so a post-commit redelivery can't decrement
    // crawlset.remaining a second time for one logical food bank.
    const closed = await finishCrawlItem(session, crawlItemId, needId);
    if (!closed) return;
    await updateFoodbankLastNeedCheck(session, msg.foodbankId, new Date().toISOString());
    await decrementCrawlSetRemaining(session, msg.crawlSetId);
  };

  const writeDiscrepancy = (text: string) =>
    insertFoodbankDiscrepancy(session, {
      foodbankId: msg.foodbankId,
      url: foodbank.url,
      discrepancyType: "website",
      discrepancyText: text,
    });

  // Stage 2 -- scrape_type branch (crawlers.py:297-301).
  const scrapeType = scrapeTypeFor(foodbank.shopping_list_url);

  let foodbankPage: string | null = null;
  if (scrapeType === "web") {
    // Stage 3a (crawlers.py:306-333, general.py:114-164).
    foodbankPage = await getMarkdown(env, foodbank.shopping_list_url);
    if (foodbankPage === null) {
      // S1: render failure -> discrepancy, published need untouched.
      await writeDiscrepancy(`Website ${foodbank.url} render failed`);
      await finish(null);
      return;
    }
  } else if (scrapeType === "facebook") {
    // Stage 3b (crawlers.py:334-342).
    foodbankPage = foodbank.facebook_page ? await scrapeFacebook(foodbank.facebook_page) : null;
    // Django has no equivalent render-failure guard for facebook/
    // bankthefood (crawlers.py:334-376 just leaves foodbank_shoppinglist_page
    // as None and falls through to the prompt render + empty-extraction
    // guard at stage 8) -- reproduced as-is: a null page here becomes an
    // empty foodbank_page substituted into the prompt, not an early return.
    foodbankPage = foodbankPage ?? "";
  } else {
    // Stage 3c (crawlers.py:344-376).
    foodbankPage = (await scrapeBankTheFood(foodbank.shopping_list_url)) ?? "";
  }

  // Stage 4 -- prompt priming (crawlers.py:404-423).
  const lastPublished = await getLastPublishedNeed(session, msg.foodbankId);
  // Don't prime with placeholder records (crawlers.py:409-411).
  const primingNeed = lastPublished && !["Facebook", "Unknown", "Nothing"].includes(lastPublished.change_text) ? lastPublished : null;
  const lastNeedForPrompt: NeedPromptLastNeed | null = primingNeed
    ? { changeText: primingNeed.change_text, excessChangeText: primingNeed.excess_change_text }
    : null;

  const prompt = buildNeedPrompt({ scrapeType, foodbankPage, lastNeed: lastNeedForPrompt });

  // Stage 5-6 -- the extraction call, two attempts (ai.py:86-151, crawlers.py:451-474).
  const outcome = await extractNeed(env, prompt);
  if (outcome.kind === "permanent") {
    // WP 5.4: OpenRouter 402 etc. -- ack (not retry) so the whole day's
    // ~1,024 messages don't each independently burn a retry budget on
    // the identical failure; the discrepancy is written by the catch
    // branch in handleNeedcheckRenderQueue below. finish(null) still runs
    // here, same as every other exit from this function -- this branch
    // used to skip it entirely, which on an account-wide 402 left every
    // affected crawlitem row permanently finish IS NULL and
    // crawlset.remaining never reaching 0, reproducing via this path the
    // exact bug CrawlSet.expected/remaining exists to fix.
    await finish(null);
    throw new PermanentOpenRouterFailure(outcome.reason);
  }
  if (outcome.kind === "retryable") {
    // S5: an unparseable/failed reply is a retryable failure, never read
    // as "this food bank needs nothing".
    throw new Error("OpenRouter need extraction failed or returned unusable content");
  }

  // Stage 7 -- clean (text.py:91-115).
  const needText = await cleanFoodbankNeedText(outcome.need.needed.join("\n"));
  const excessText = await cleanFoodbankNeedText(outcome.need.excess.join("\n"));

  const lastUnpublished = await getLastUnpublishedNeeds(session, msg.foodbankId, NONPERTINENT_WINDOW);

  // Stages 8-9 -- the change decision (crawlers.py:486-538), a pure
  // function independent of I/O so it's unit-testable on its own.
  const decision = decideNeedChange({
    needText,
    excessText,
    lastPublished: lastPublished ? { changeText: lastPublished.change_text, excessChangeText: lastPublished.excess_change_text } : null,
    lastUnpublished: lastUnpublished.map((n) => ({ changeText: n.change_text, excessChangeText: n.excess_change_text })),
  });

  if (decision.kind === "empty_extraction_skip") {
    // S6, the single most important safeguard in this pipeline: a
    // completely empty extraction when a published need already exists
    // is almost always a failed/blocked render, not a genuine change.
    // Never wipe the published need on that basis.
    await writeDiscrepancy(`Empty needs extracted for ${foodbank.url} despite an existing published need; skipped to avoid wiping it`);
    await finish(null);
    return;
  }

  // Stage 10 -- feed the review queue, only when the decision is a real,
  // pertinent change.
  let newNeedId: number | null = null;
  if (decision.kind === "change") {
    newNeedId = await insertFoodbankChange(session, {
      foodbankId: msg.foodbankId,
      uri: foodbank.shopping_list_url,
      changeText: decision.needText,
      excessChangeText: decision.excessText,
    });
  }

  // Stage 11 -- always: stamp last_need_check, close the CrawlItem, and
  // decrement the CrawlSet counter (finish() does all three).
  await finish(newNeedId);
}

// Distinguishes the WP 5.4 "don't retry storm" case from every other
// failure in processOne's catch block in handleNeedcheckRenderQueue --
// caught there just like any other error, but the queue consumer above
// acks a message whose failure is this specific class rather than
// retrying it, since a 402 will fail identically on every retry and on
// every other food bank's message today.
export class PermanentOpenRouterFailure extends Error {}
