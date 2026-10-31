import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AGGREGATE_TAG, constituencyTag, foodbankTag } from "@givefood/urls";
import { handleCachePurgeQueue, TAGS_PER_PURGE, type CachePurgeMessage } from "./cachePurge";
import worker from "../index";
import type { AppEnv } from "../types";

// queues/cachePurge.ts -- the cache-purge queue consumer, now in the site
// Worker because Workers Caching can only be purged from inside the Worker
// that owns it. Its only effect is a ctx.cache.purge() call and which
// messages it acks or retries, so every test asserts those two things. The
// tag names come from the real @givefood/urls cacheTags module, the same one
// middleware/cacheTag.ts stamps responses with.

interface Disposal {
  acked: boolean;
  retried: { delaySeconds?: number } | null;
}

function makeBatch(bodies: CachePurgeMessage[], queue = "cache-purge") {
  const disposals: Disposal[] = bodies.map(() => ({ acked: false, retried: null }));
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: () => void (disposals[i]!.acked = true),
    retry: (opts?: { delaySeconds?: number }) => void (disposals[i]!.retried = opts ?? {}),
  }));
  const batch = { queue, messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<CachePurgeMessage>;
  return { batch, disposals };
}

let purge: Mock<(options: CachePurgeOptions) => Promise<unknown>>;

function ctx(withCache = true): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    ...(withCache ? { cache: { purge: (o: CachePurgeOptions) => purge(o) } } : {}),
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  purge = vi.fn(async () => ({ success: true, errors: [] }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleCachePurgeQueue -- purging by tag", () => {
  it("purges the union of a batch's tags in one call, and acks every message", async () => {
    const { batch, disposals } = makeBatch([
      { tags: [foodbankTag("salisbury"), AGGREGATE_TAG] },
      { tags: [foodbankTag("brixton"), AGGREGATE_TAG] },
      { tags: [constituencyTag("salisbury")] },
    ]);
    await handleCachePurgeQueue(batch, ctx());

    expect(purge).toHaveBeenCalledTimes(1);
    const { tags } = purge.mock.calls[0]![0] as CachePurgeOptions;
    expect(new Set(tags)).toEqual(new Set([foodbankTag("salisbury"), foodbankTag("brixton"), AGGREGATE_TAG, constituencyTag("salisbury")]));
    // fb-all named twice, purged once.
    expect(tags!.length).toBe(4);
    expect(disposals.every((d) => d.acked && d.retried === null)).toBe(true);
  });

  it("chunks more than 100 tags into several purges, none over the cap", async () => {
    const many = Array.from({ length: TAGS_PER_PURGE * 2 + 5 }, (_, i) => foodbankTag(`fb${i}`));
    const { batch } = makeBatch([{ tags: many }]);
    await handleCachePurgeQueue(batch, ctx());

    expect(TAGS_PER_PURGE).toBe(100);
    expect(purge).toHaveBeenCalledTimes(3);
    const sent = purge.mock.calls.flatMap(([o]) => (o as CachePurgeOptions).tags!);
    expect(purge.mock.calls.every(([o]) => (o as CachePurgeOptions).tags!.length <= 100)).toBe(true);
    expect(new Set(sent)).toEqual(new Set(many));
  });

  it("never purges everything when every message names tags", async () => {
    const { batch } = makeBatch([{ tags: [AGGREGATE_TAG] }]);
    await handleCachePurgeQueue(batch, ctx());
    expect(purge).toHaveBeenCalledWith({ tags: [AGGREGATE_TAG] });
  });
});

describe("handleCachePurgeQueue -- purging everything", () => {
  it.each([[{}], [{ tags: [] }]])("purges everything when a message names no tags (%j)", async (body) => {
    const { batch, disposals } = makeBatch([{ tags: [AGGREGATE_TAG] }, body as CachePurgeMessage]);
    await handleCachePurgeQueue(batch, ctx());

    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith({ purgeEverything: true });
    expect(disposals.every((d) => d.acked)).toBe(true);
  });
});

describe("handleCachePurgeQueue -- failures", () => {
  it("retries the whole batch a minute later when the purge is refused", async () => {
    purge = vi.fn(async () => ({ success: false, errors: [{ code: 1, message: "rate limited" }] }));
    const { batch, disposals } = makeBatch([{ tags: [AGGREGATE_TAG] }, { tags: [foodbankTag("salisbury")] }]);
    await handleCachePurgeQueue(batch, ctx());

    expect(disposals.every((d) => !d.acked && d.retried?.delaySeconds === 60)).toBe(true);
    expect(console.error).toHaveBeenCalledWith("cache-purge: Workers Cache purge failed", [{ code: 1, message: "rate limited" }]);
  });

  it("retries when the purge throws", async () => {
    purge = vi.fn(async () => {
      throw new Error("boom");
    });
    const { batch, disposals } = makeBatch([{ tags: [AGGREGATE_TAG] }]);
    await handleCachePurgeQueue(batch, ctx());
    expect(disposals[0]!.retried).toEqual({ delaySeconds: 60 });
  });

  it("stops at the first refused chunk rather than sending the rest", async () => {
    purge = vi.fn(async () => ({ success: false, errors: [] }));
    const many = Array.from({ length: TAGS_PER_PURGE + 1 }, (_, i) => foodbankTag(`fb${i}`));
    const { batch } = makeBatch([{ tags: many }]);
    await handleCachePurgeQueue(batch, ctx());
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("does not accept a stringly-typed success flag", async () => {
    purge = vi.fn(async () => ({ success: "true" }));
    const { batch, disposals } = makeBatch([{ tags: [AGGREGATE_TAG] }]);
    await handleCachePurgeQueue(batch, ctx());
    expect(disposals[0]!.acked).toBe(false);
  });

  it("acks without purging when there is no Workers Cache to purge", async () => {
    const { batch, disposals } = makeBatch([{ tags: [AGGREGATE_TAG] }]);
    await handleCachePurgeQueue(batch, ctx(false));
    expect(purge).not.toHaveBeenCalled();
    expect(disposals[0]!.acked).toBe(true);
  });
});

describe("the site Worker's queue handler", () => {
  const env = {} as AppEnv["Bindings"];

  it("routes cache-purge to the consumer, purging through the invocation's ctx.cache", async () => {
    const { batch, disposals } = makeBatch([{ tags: [foodbankTag("salisbury")] }]);
    await worker.queue(batch as MessageBatch<unknown>, env, ctx());
    expect(purge).toHaveBeenCalledWith({ tags: [foodbankTag("salisbury")] });
    expect(disposals[0]!.acked).toBe(true);
  });

  it("purges nothing for a queue it does not consume, and says so", async () => {
    const { batch } = makeBatch([{ tags: [AGGREGATE_TAG] }], "jobs");
    await worker.queue(batch as MessageBatch<unknown>, env, ctx());
    expect(purge).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('givefood2: unhandled queue "jobs"');
  });

  it("still serves HTTP: the default export is the Hono app", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.request).toBe("function");
  });
});
