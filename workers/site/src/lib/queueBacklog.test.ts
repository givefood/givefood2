import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import type { QueueBacklog, QueueBacklogRow } from "./queueBacklog";
import { getQueueBacklog } from "./queueBacklog";

// This module is the ONLY thing in the port that can see a dead letter
// queue. wrangler.jsonc calls a DLQ "NON-NEGOTIABLE" precisely because a
// message that exhausts its retries lands in a *-dlq and then stops moving
// with nothing else to announce it -- no D1 row, no crawlset, no admin_job.
// So the failure this file guards against is not "the panel looks wrong",
// it is "a queue silently stopped being consumed and /admin/jobs/ showed a
// reassuring 0" (or showed nothing at all, which is the same lie).
//
// There is NO Django ancestor to port against: gfadmin/views.py:75-80 read
// tasks_24h/tasks_outstanding out of django-tasks' DBTaskResult history
// table, and packages/db/src/adminDashboardStats.ts:5-9 documents why that
// could not come across (Cloudflare Queues keeps no such table). This
// module is the deliberate replacement, sourced from Cloudflare's API
// rather than from the database, so every assertion below is against the
// module's own stated contract instead of against Python.
//
// The other half of the contract lives in the caller. routes/admin/jobs.ts
// puts getQueueBacklog() inside a Promise.all with three D1 queries and
// says "getQueueBacklog resolves rather than rejects on failure, so one
// dead API cannot take the page down with it". Everything here about
// degradation is testing that promise on behalf of the page.

const ACCOUNT = "acct-1";
const KEY = "cf-token";
const QUEUES_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/queues`;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

// A fixed clock, so the 15-minute window the GraphQL query asks for is a
// value this file can assert rather than a moving target. getQueueBacklog
// takes `now` as a parameter for exactly this reason.
const NOW = Date.parse("2026-09-06T12:34:56.789Z");

// Only the two bindings this module reads. Env has dozens of other members
// (D1, KV, queue producers); handing it a real one would say nothing extra
// and would break the day someone adds a binding.
function envWith(overrides: Partial<Record<"CF_ACCOUNT_ID" | "CF_API_KEY", string>> = {}): AppEnv["Bindings"] {
  return { CF_ACCOUNT_ID: ACCOUNT, CF_API_KEY: KEY, ...overrides } as unknown as AppEnv["Bindings"];
}

type Reply = (init: RequestInit) => Promise<Response>;

// A REAL Response rather than an object literal with a hand-computed `ok`.
// fetchJson's whole guard is `if (!res.ok)`, and a stub that decides for
// itself which statuses are "ok" is asserting the test's opinion of HTTP,
// not the runtime's. It also means res.json() genuinely parses, which is
// what the non-JSON-body case below depends on.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ok = (body: unknown): Reply => async () => jsonResponse(body);
const status = (code: number): Reply => async () => jsonResponse({ errors: [] }, code);
const rejects = (err: unknown): Reply => async () => { throw err; };

/** A 200 whose body is not JSON at all. Cloudflare's edge answers an HTML
 *  error page often enough that this is a real shape, and it is the one
 *  failure that happens INSIDE res.json(), after the ok check has passed. */
const rawBody = (body: string, code = 200): Reply => async () => new Response(body, { status: code });

/** Never settles until the caller's AbortSignal fires. Models a Cloudflare
 *  API that has simply gone quiet -- the case TIMEOUT_MS exists for. */
const hangs = (): Reply => (init) =>
  new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new Error("The operation was aborted")));
  });

/** Answers the two endpoints the module documents and throws on anything
 *  else, so a third outbound call (an "improvement" that quietly adds a
 *  request to a page render) fails loudly here instead of in production. */
function stubFetch(replies: { queues?: Reply; graphql?: Reply }) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (url === QUEUES_URL && replies.queues) return replies.queues(init);
    if (url === GRAPHQL_URL && replies.graphql) return replies.graphql(init);
    throw new Error(`unmodelled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The shape of the Queues REST list, `success` envelope included. */
function queueList(...pairs: [id: string, name: string][]) {
  return { success: true, result: pairs.map(([queue_id, queue_name]) => ({ queue_id, queue_name })) };
}

/** The shape of queueBacklogAdaptiveGroups, nested exactly as deeply as
 *  the real GraphQL response -- viewer > accounts[0] > groups. */
function backlog(...samples: [id: string, messages: number, minute: string][]) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            queueBacklogAdaptiveGroups: samples.map(([queueId, messages, datetimeMinute]) => ({
              avg: { messages },
              dimensions: { queueId, datetimeMinute },
            })),
          },
        ],
      },
    },
  };
}

function graphqlVariables(fetchMock: ReturnType<typeof stubFetch>) {
  const call = fetchMock.mock.calls.find(([url]) => url === GRAPHQL_URL)!;
  return JSON.parse(String(call[1].body)) as { query: string; variables: { a: string; since: string; until: string } };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The module logs every degradation. Silence it by default (a degraded
  // panel is the normal case in half these tests) but keep the spy so the
  // logging itself can be asserted.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getQueueBacklog: missing credentials", () => {
  it("degrades with a stated reason instead of throwing when CF_ACCOUNT_ID is unset", async () => {
    // Same degradation shape the module cites from routes/admin/clearCache.ts.
    // /admin/jobs/ renders four other panels straight out of D1; an unset
    // var must cost the admin one panel, never the whole page.
    const fetchMock = stubFetch({});
    const result = await getQueueBacklog(envWith({ CF_ACCOUNT_ID: "" }), NOW);
    expect(result).toEqual({
      queues: [],
      error: "CF_ACCOUNT_ID/CF_API_KEY not set -- queue depths unavailable.",
    });
    // And it short-circuits: no half-built request goes out unauthenticated.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades identically when CF_API_KEY is the missing half", async () => {
    // CF_ACCOUNT_ID is a plain var in wrangler.jsonc and CF_API_KEY is a
    // secret, so in practice these two go missing for completely different
    // reasons (a bad deploy vs. an unpushed secret). One message covers
    // both on purpose -- assert it does not drift into two.
    const fetchMock = stubFetch({});
    const result = await getQueueBacklog(envWith({ CF_API_KEY: "" }), NOW);
    expect(result.error).toBe("CF_ACCOUNT_ID/CF_API_KEY not set -- queue depths unavailable.");
    expect(result.queues).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an undefined binding the same as an empty one", async () => {
    // Vars deleted from wrangler.jsonc arrive as undefined rather than "",
    // which a `=== ""` check would sail straight past and then send
    // "Bearer undefined" to Cloudflare.
    const fetchMock = stubFetch({});
    const result = await getQueueBacklog({} as unknown as AppEnv["Bindings"], NOW);
    expect(result.error).toBe("CF_ACCOUNT_ID/CF_API_KEY not set -- queue depths unavailable.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getQueueBacklog: the two outbound calls", () => {
  it("makes exactly two requests, both bearer-authed, sharing one abort signal", async () => {
    // The module makes two calls only because queueBacklogAdaptiveGroups
    // has no queueName dimension -- names must come from the REST list.
    // They share ONE AbortController so TIMEOUT_MS is a budget for the
    // pair, not 5s each: a page render cannot afford to serialise them.
    const fetchMock = stubFetch({
      queues: ok(queueList(["q1", "needcheck-render"])),
      graphql: ok(backlog(["q1", 0, "2026-09-06T12:34:00Z"])),
    });
    await getQueueBacklog(envWith(), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [namesUrl, namesInit] = fetchMock.mock.calls.find(([u]) => u === QUEUES_URL)!;
    const [, graphInit] = fetchMock.mock.calls.find(([u]) => u === GRAPHQL_URL)!;

    expect(namesUrl).toBe(QUEUES_URL);
    expect((namesInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(namesInit.method).toBeUndefined(); // REST list is a GET
    expect(graphInit.method).toBe("POST");
    expect((graphInit.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((graphInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);

    expect(namesInit.signal).toBeInstanceOf(AbortSignal);
    expect(namesInit.signal).toBe(graphInit.signal);
  });

  it("issues both requests before either has answered", async () => {
    // Not a style point. Serialising them would double the worst case a
    // page render can spend on someone else's API, and the module's own
    // comment ("Both calls run in parallel under one budget") is the thing
    // TIMEOUT_MS is sized against.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchMock = stubFetch({
      queues: async () => { await gate; return jsonResponse(queueList(["q1", "articles"])); },
      graphql: ok(backlog(["q1", 3, "2026-09-06T12:34:00Z"])),
    });

    const pending = getQueueBacklog(envWith(), NOW);
    await new Promise((r) => setTimeout(r, 0));
    // BOTH urls, not just one. Asserting only that GraphQL went out would
    // be satisfied by a serial `await graphql; await names` -- the names
    // call is the one still gated, so the proof of parallelism is that the
    // other request exists while it hangs. Checked in both directions so
    // neither serialisation order can slip through.
    expect(fetchMock.mock.calls.map(([u]) => u).sort()).toEqual([GRAPHQL_URL, QUEUES_URL].sort());

    release();
    expect((await pending).queues[0]!.messages).toBe(3);
  });

  it("asks for the 15 minutes ending at `now`, in Cloudflare's Time format", async () => {
    // Cloudflare's GraphQL `Time` scalar rejects the millisecond field that
    // toISOString() always emits, which is what the .replace() is for -- a
    // ".789" here is a 200-with-errors response and a blank panel. The
    // 15-minute width is the module's stated compromise: wide enough to
    // catch the roughly-once-a-minute sampling, narrow enough that a
    // reported 0 means now.
    const fetchMock = stubFetch({
      queues: ok(queueList()),
      graphql: ok(backlog()),
    });
    await getQueueBacklog(envWith(), NOW);

    const { variables, query } = graphqlVariables(fetchMock);
    expect(variables.a).toBe(ACCOUNT);
    expect(variables.until).toBe("2026-09-06T12:34:56Z");
    expect(variables.since).toBe("2026-09-06T12:19:56Z");
    expect(Date.parse(variables.until) - Date.parse(variables.since)).toBe(15 * 60_000);
    // The format itself, not just these two values: seconds precision, a
    // literal Z, and no fractional part anywhere. NOW deliberately carries
    // .789 ms so a dropped .replace() cannot pass this.
    for (const t of [variables.since, variables.until]) {
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
    // datetimeMinute_DESC is load-bearing for the "newest sample wins"
    // de-duplication below, which does no timestamp comparison of its own.
    expect(query).toContain("datetimeMinute_DESC");
    // The dataset and filter names are the module's one un-typed contact
    // with Cloudflare's schema ("checked against the schema, not assumed"),
    // and a typo in any of them is a 200-with-errors and a blank panel that
    // no type-checker can catch. Pin the exact spellings.
    expect(query).toContain("queueBacklogAdaptiveGroups");
    expect(query).toContain("accountTag:$a");
    expect(query).toContain("datetime_geq:$since");
    expect(query).toContain("datetime_leq:$until");
    expect(query).toContain("limit:1000");
    // Every variable the query declares is actually supplied, and nothing
    // is supplied that the query never declares -- renaming one end only
    // is a "variable not defined" error rather than anything visible here.
    const declared = [...query.matchAll(/\$(\w+)/g)].map((m) => m[1]!);
    expect(new Set(declared)).toEqual(new Set(Object.keys(variables)));
  });

  it("defaults `now` to the wall clock when the caller does not pass one", async () => {
    // routes/admin/jobs.ts passes its own `now`; anything else calling this
    // gets the current time. A default of 0 would silently ask Cloudflare
    // for a window in 1970 and always render an empty panel.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T09:00:00.000Z"));
    const fetchMock = stubFetch({ queues: ok(queueList()), graphql: ok(backlog()) });

    await getQueueBacklog(envWith());

    expect(graphqlVariables(fetchMock).variables.until).toBe("2026-09-06T09:00:00Z");
  });

  it("degrades rather than throwing when `now` is not a usable time", async () => {
    // new Date(NaN).toISOString() throws RangeError, and the throw happens
    // inside fetchBacklogSamples -- i.e. INSIDE the allSettled net -- so a
    // caller that computed its `now` from a bad Date.parse costs the admin
    // the depths column and nothing more. Worth pinning because the same
    // mistake made one line earlier, in getQueueBacklog itself, would reject
    // and take the whole page with it.
    const fetchMock = stubFetch({ queues: ok(queueList(["a", "articles"])), graphql: ok(backlog()) });
    const result = await getQueueBacklog(envWith(), Number.NaN);

    expect(result.error).toBe("Cloudflare API: queue depths (Invalid time value).");
    // Depths unknown, so null -- and the names call still went out and
    // still populated the panel.
    expect(result.queues).toEqual([{ name: "articles", messages: null, is_dlq: false, sampled_at: null }]);
    // The GraphQL request was never dispatched: the window is built before
    // fetch is reached.
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([QUEUES_URL]);
  });

  it("asks for a window ending at the epoch when handed now = 0", async () => {
    // 0 is falsy, so a `now || Date.now()` default would silently swap it
    // for the wall clock and hide the caller's bug. The parameter default
    // is `= Date.now()`, which only fires for undefined -- an explicit 0
    // really does ask Cloudflare about 1970 and really does come back empty.
    const fetchMock = stubFetch({ queues: ok(queueList()), graphql: ok(backlog()) });
    await getQueueBacklog(envWith(), 0);

    const { variables } = graphqlVariables(fetchMock);
    expect(variables.until).toBe("1970-01-01T00:00:00Z");
    expect(variables.since).toBe("1969-12-31T23:45:00Z");
  });
});

describe("getQueueBacklog: joining names to depths", () => {
  it("joins the REST names onto the GraphQL queueIds", async () => {
    const fetchMock = stubFetch({
      queues: ok(queueList(["id-aaa", "needcheck-render"], ["id-bbb", "needcheck-render-dlq"])),
      graphql: ok(backlog(["id-bbb", 12, "2026-09-06T12:33:00Z"], ["id-aaa", 4, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);

    expect(result.error).toBeNull();
    expect(result.queues).toEqual([
      { name: "needcheck-render-dlq", messages: 12, is_dlq: true, sampled_at: "2026-09-06T12:33:00Z" },
      { name: "needcheck-render", messages: 4, is_dlq: false, sampled_at: "2026-09-06T12:34:00Z" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exposes exactly the four fields admin/jobs.njk and jobs.ts read", async () => {
    // jobs.ts sums `q.messages` and filters on `q.is_dlq` for the two stat
    // tiles; the template prints `name` and `sampled_at`. A renamed field
    // here is a blank column there, with no error anywhere.
    stubFetch({
      queues: ok(queueList(["id-aaa", "articles"])),
      graphql: ok(backlog(["id-aaa", 1, "2026-09-06T12:34:00Z"])),
    });
    const result: QueueBacklog = await getQueueBacklog(envWith(), NOW);
    const row: QueueBacklogRow = result.queues[0]!;
    expect(Object.keys(row).sort()).toEqual(["is_dlq", "messages", "name", "sampled_at"]);
  });

  it("passes Cloudflare's datetimeMinute through verbatim as sampled_at", async () => {
    // Deliberately NOT pyDatetime()-formatted. Everything sampled_at is
    // compared against comes from Cloudflare, never from D1, so reformatting
    // it into Django's "YYYY-MM-DD HH:MM:SS.ffffff" would gain nothing and
    // lose the ability to hand the raw value back to the analytics API.
    stubFetch({
      queues: ok(queueList(["id-aaa", "articles"])),
      graphql: ok(backlog(["id-aaa", 1, "2026-09-06T12:31:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues[0]!.sampled_at).toBe("2026-09-06T12:31:00Z");
  });

  it("rounds the per-minute average rather than truncating it", async () => {
    // avg{messages} is the mean depth over a one-minute bucket of what is
    // really an integer. A queue that held one message for 35 seconds of
    // the minute averages 0.58 -- truncation would print that as 0, i.e.
    // "nothing to see here" for a queue that is actually being worked.
    stubFetch({
      queues: ok(queueList(["a", "q-a"], ["b", "q-b"], ["c", "q-c"], ["d", "q-d"], ["e", "q-e"], ["f", "q-f"])),
      graphql: ok(
        backlog(
          ["a", 0.58, "2026-09-06T12:34:00Z"],
          ["b", 1.4, "2026-09-06T12:34:00Z"],
          ["c", 0.5, "2026-09-06T12:34:00Z"],
          ["d", 0.4, "2026-09-06T12:34:00Z"],
          ["e", 2.5, "2026-09-06T12:34:00Z"],
          ["f", 1234567.5, "2026-09-06T12:34:00Z"],
        ),
      ),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    const byName = new Map(result.queues.map((q) => [q.name, q.messages]));
    expect(byName.get("q-a")).toBe(1); // 0.58 -- truncation would say 0
    expect(byName.get("q-b")).toBe(1); // 1.4
    expect(byName.get("q-c")).toBe(1); // Math.round's half-up tie
    // 2.5 is the case that separates Math.round from every "round to even"
    // implementation (toFixed-and-parse, Intl, most rounding helpers): they
    // answer 2 here and 1 for q-c. Both would still pass the .58/1.4 rows.
    expect(byName.get("q-e")).toBe(3);
    // A queue in real trouble is six or seven figures deep, and the panel
    // must show the number rather than an exponent or a clamped value.
    expect(byName.get("q-f")).toBe(1234568);
    // Below a half-minute of occupancy a queue still reads as empty. Pinned
    // because it is the one case where "round" and "never show 0 for a
    // non-empty queue" pull in different directions.
    expect(byName.get("q-d")).toBe(0);
  });

  it("keeps an empty queue_name empty instead of substituting the id", async () => {
    // `names.get(id) ?? \`queue ...\`` is nullish-coalescing on purpose: the
    // fallback label is for an id the LIST never mentioned, not for a name
    // the list gave as "". Written with `||` this row would silently become
    // "queue a" -- a plausible-looking name for a queue that has none, which
    // is worse than a blank cell because it cannot be matched against
    // `wrangler queues list`. Pinned as current behaviour.
    stubFetch({
      queues: ok(queueList(["a", ""])),
      graphql: ok(backlog(["a", 5, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues).toEqual([{ name: "", messages: 5, is_dlq: false, sampled_at: "2026-09-06T12:34:00Z" }]);
  });

  it("still lists a queue that produced no sample in the window, at 0", async () => {
    // Cloudflare stops sampling an idle queue, so "no sample" is the normal
    // state of a healthy DLQ. Driving the rows off the queue LIST is what
    // keeps that queue on the page -- drive them off the samples and the
    // page silently omits exactly the queue that has stopped moving.
    stubFetch({
      queues: ok(queueList(["a", "busy"], ["b", "needcheck-render-dlq"])),
      graphql: ok(backlog(["a", 7, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);

    expect(result.queues).toEqual([
      { name: "busy", messages: 7, is_dlq: false, sampled_at: "2026-09-06T12:34:00Z" },
      // 0 with a null sampled_at: "idle", not "unknown". The null is how
      // the page can say so rather than inventing a timestamp.
      { name: "needcheck-render-dlq", messages: 0, is_dlq: true, sampled_at: null },
    ]);
  });

  it("drops samples whose queueId is not in the list", async () => {
    // A queue deleted mid-window still has samples in the analytics window
    // for another 15 minutes. The list is the authority on what exists, so
    // the ghost is dropped rather than rendered as "queue 4f2a1c9d".
    stubFetch({
      queues: ok(queueList(["a", "live"])),
      graphql: ok(backlog(["a", 1, "2026-09-06T12:34:00Z"], ["deleted-id", 99, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues.map((q) => q.name)).toEqual(["live"]);
  });

  it("keeps the FIRST sighting of a queueId and ignores every later one", async () => {
    // The de-duplication does no timestamp comparison: it trusts the query's
    // datetimeMinute_DESC ordering, so first-seen == newest. These two rows
    // are deliberately in the wrong order to prove that -- if someone drops
    // the orderBy, this test fails instead of the panel quietly showing a
    // fifteen-minute-old depth.
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok(backlog(["a", 2, "2026-09-06T12:20:00Z"], ["a", 40, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues).toEqual([
      { name: "articles", messages: 2, is_dlq: false, sampled_at: "2026-09-06T12:20:00Z" },
    ]);
  });

  it("flags is_dlq on the -dlq SUFFIX, not on the substring anywhere", async () => {
    // wrangler.jsonc's convention is "<queue>-dlq", and this flag is what
    // puts a row at the top of the panel and turns it red -- the one place
    // on the page that must not cry wolf.
    //
    // "needcheck-dlq-replay" is the fixture that does the work here: it
    // CONTAINS "-dlq" but does not end with it, so it is the only name in
    // this list that an .includes() would get wrong. ("dlq-replay" reads
    // like the obvious counter-example and is not one -- it contains
    // "dlq-", never "-dlq", so it passes either implementation.)
    stubFetch({
      queues: ok(
        queueList(
          ["a", "needcheck-render-dlq"],
          ["b", "needcheck-render"],
          ["c", "dlq-replay"],
          ["d", "-dlq"],
          ["e", "needcheck-dlq-replay"],
          ["f", "needcheck-DLQ"],
        ),
      ),
      graphql: ok(backlog()),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    const byName = new Map(result.queues.map((q) => [q.name, q.is_dlq]));
    expect(byName.get("needcheck-render-dlq")).toBe(true);
    expect(byName.get("needcheck-render")).toBe(false);
    expect(byName.get("dlq-replay")).toBe(false);
    // The suffix alone is still a suffix.
    expect(byName.get("-dlq")).toBe(true);
    // Contains "-dlq" mid-name: false under endsWith, true under includes.
    expect(byName.get("needcheck-dlq-replay")).toBe(false);
    // Case-sensitive. Cloudflare queue names are lowercase, so this is a
    // typo rather than a real queue, and guessing at it would be worse.
    expect(byName.get("needcheck-DLQ")).toBe(false);
  });
});

describe("getQueueBacklog: ordering", () => {
  it("sorts by depth, then DLQ, then name", async () => {
    // The stated priority: anything with messages first, DLQs ahead of live
    // queues at equal depth (a non-empty DLQ is the row that needs a human),
    // then alphabetical so the idle majority stays scannable.
    stubFetch({
      queues: ok(
        queueList(
          ["a", "alpha"],
          ["b", "beta-dlq"],
          ["c", "zulu"],
          ["d", "aaa-dlq"],
        ),
      ),
      graphql: ok(backlog(["c", 5, "2026-09-06T12:34:00Z"], ["d", 5, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues.map((q) => q.name)).toEqual([
      "aaa-dlq", // 5 messages, DLQ -- beats the equally-deep live queue
      "zulu", //    5 messages, live
      "beta-dlq", // empty, but the DLQ tiebreak still applies at depth 0
      "alpha",
    ]);
  });

  it("puts a deep live queue above an empty DLQ", async () => {
    // Depth outranks DLQ-ness. An empty dead letter queue is the healthy
    // state; a live queue at 900 is the thing that is actually on fire.
    stubFetch({
      queues: ok(queueList(["a", "zzz-backed-up"], ["b", "aaa-dlq"])),
      graphql: ok(backlog(["a", 900, "2026-09-06T12:34:00Z"], ["b", 0, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues.map((q) => q.name)).toEqual(["zzz-backed-up", "aaa-dlq"]);
  });

  it("breaks ties with localeCompare, not ASCII order", async () => {
    // localeCompare is human alphabetical: "Articles" sorts before "beta".
    // Plain `<` would put every capitalised name in a block above every
    // lowercase one, which for a scan-the-list panel is just noise.
    stubFetch({
      queues: ok(queueList(["a", "beta"], ["b", "Articles"], ["c", "charity-ni"])),
      graphql: ok(backlog()),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues.map((q) => q.name)).toEqual(["Articles", "beta", "charity-ni"]);
  });

  it("collates an accented name into the alphabet rather than after z", async () => {
    // The sharper half of the same claim, and the one a capitalisation-only
    // test cannot make. "é" is U+00E9, above every ASCII letter, so a plain
    // `<` or a default .sort() files "élan" LAST -- after "zulu" -- while
    // localeCompare files it under e. Given accented food bank and district
    // names elsewhere in this codebase, a queue named for one is not
    // far-fetched. This ordering is the same in every locale ICU is likely
    // to be running under here (é collates as e); it is only the Scandinavian
    // treatment of å/ø that is locale-dependent, so it is deliberately not
    // exercised.
    stubFetch({
      queues: ok(queueList(["a", "zulu"], ["b", "élan"], ["c", "alpha"])),
      graphql: ok(backlog()),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues.map((q) => q.name)).toEqual(["alpha", "élan", "zulu"]);
  });

  it("does not collate digits numerically", async () => {
    // localeCompare is called with no options, so "queue10" precedes
    // "queue9" exactly as a string comparison would. Pinned because adding
    // {numeric: true} looks like a tidy-up and would silently reorder the
    // panel for anyone running numbered queues.
    stubFetch({
      queues: ok(queueList(["a", "shard9"], ["b", "shard10"])),
      graphql: ok(backlog()),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues.map((q) => q.name)).toEqual(["shard10", "shard9"]);
  });

  it("lets a NaN depth sort as a tie, ahead of a genuinely deep queue", async () => {
    // Falls out of the comparator: (NaN - x) is NaN, NaN is falsy, so `||`
    // skips straight past the depth term to the DLQ and name tiebreaks. The
    // row that should have been either first or last instead lands wherever
    // its name puts it -- here "aaa-broken" outranks a queue sitting at 900.
    // Current behaviour, pinned alongside the NaN row below; the ordering
    // consequence is the part that would be invisible in production.
    stubFetch({
      queues: ok(queueList(["a", "aaa-broken"], ["b", "zzz-deep"])),
      graphql: ok({
        data: {
          viewer: {
            accounts: [
              {
                queueBacklogAdaptiveGroups: [
                  { avg: {}, dimensions: { queueId: "a", datetimeMinute: "2026-09-06T12:34:00Z" } },
                  { avg: { messages: 900 }, dimensions: { queueId: "b", datetimeMinute: "2026-09-06T12:34:00Z" } },
                ],
              },
            ],
          },
        },
      }),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues.map((q) => q.name)).toEqual(["aaa-broken", "zzz-deep"]);
    expect(Number.isNaN(result.queues[0]!.messages)).toBe(true);
  });

  it("orders a full account-sized list without losing or duplicating a queue", async () => {
    // The GraphQL query asks for limit:1000 and a busy account really does
    // run dozens of queues plus their DLQs. Everything above sorts three or
    // four rows, where an accidentally-stable-by-luck comparator is
    // indistinguishable from a correct one; at 300 rows it is not.
    const many: [string, string][] = Array.from({ length: 300 }, (_, i) => [
      `id-${i}`,
      `q-${String(i).padStart(3, "0")}${i % 7 === 0 ? "-dlq" : ""}`,
    ]);
    stubFetch({
      queues: ok(queueList(...many)),
      graphql: ok(backlog(["id-250", 4, "2026-09-06T12:34:00Z"], ["id-7", 4, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);

    expect(result.queues).toHaveLength(300);
    expect(new Set(result.queues.map((q) => q.name)).size).toBe(300);
    // The two with depth first, DLQ ahead of the live one at the same depth.
    expect(result.queues.slice(0, 2).map((q) => q.name)).toEqual(["q-007-dlq", "q-250"]);
    // Then the idle 298 in TWO alphabetical runs, not one. "Empty" is a tie
    // at 0, and the DLQ tiebreak applies to ties, so all 42 idle dead letter
    // queues sit above all 256 idle live ones. At three or four rows that
    // reads as a rounding detail; at real account size it is the panel's
    // dominant visual fact, and it works against the module's own stated
    // aim of an alphabetical idle majority -- a healthy, empty DLQ is the
    // normal state, so the top of the idle block is permanently occupied by
    // rows that need no attention. Pinned as current behaviour, spelled out
    // rather than compared against a re-sort (which would just be the
    // implementation again).
    const idle = result.queues.slice(2).map((q) => q.name);
    expect(idle).toHaveLength(298);
    expect(idle.slice(0, 4)).toEqual(["q-000-dlq", "q-014-dlq", "q-021-dlq", "q-028-dlq"]);
    // The seam: last idle DLQ, then the alphabet restarts at the live ones.
    expect(idle.slice(41, 43)).toEqual(["q-294-dlq", "q-001"]);
    expect(idle.at(-1)).toBe("q-299");
  });
});

describe("getQueueBacklog: one call fails", () => {
  it("keeps the depths when the name list fails, labelling rows by id", async () => {
    // "depths without names still tells you something is backed up, which
    // is the alarm this panel exists to raise." The id prefix is 8 chars --
    // enough to match against `wrangler queues list` by hand.
    stubFetch({
      queues: rejects(new Error("HTTP 500")),
      graphql: ok(backlog(["4f2a1c9d8b7e6f5a4b3c2d1e0f9a8b7c", 42, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);

    expect(result.queues).toEqual([
      { name: "queue 4f2a1c9d", messages: 42, is_dlq: false, sampled_at: "2026-09-06T12:34:00Z" },
    ]);
    expect(result.error).toBe("Cloudflare API: queue names (HTTP 500).");
  });

  it("loses the DLQ flag when the name list fails (documented, not endorsed)", async () => {
    // is_dlq is derived from the NAME, and without the list the name is a
    // synthesised "queue 4f2a1c9d" that can never end in -dlq. So the exact
    // scenario this panel was built for -- a backed-up DLQ -- renders as an
    // ordinary queue whenever Queues:Read is the permission that is missing.
    // Pinned as current behaviour; see the suspected-bug note.
    stubFetch({
      queues: rejects(new Error("HTTP 403")),
      graphql: ok(backlog(["dlqid123456", 99, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues[0]!.is_dlq).toBe(false);
    expect(result.queues[0]!.messages).toBe(99);
  });

  it("reports depths as null, never 0, when the analytics call fails", async () => {
    // The single most dangerous confusion this module could produce. A
    // queue whose depth is UNKNOWN must not render as a reassuring 0, and
    // jobs.ts keys its "show a dash instead of a total" logic off exactly
    // this null.
    stubFetch({
      queues: ok(queueList(["a", "articles"], ["b", "articles-dlq"])),
      graphql: rejects(new Error("HTTP 500")),
    });
    const result = await getQueueBacklog(envWith(), NOW);

    // ALL the rows, not just the first: `haveDepths` is one boolean for the
    // whole render, so null depths are all-or-nothing. That invariant is
    // also why the sort's `?? -1` sentinel is untestable from out here --
    // no reachable result mixes a null depth with a numeric one, so -1 and
    // 0 behave identically. Stated rather than left as a silent gap.
    expect(result.queues.every((q) => q.messages === null)).toBe(true);
    expect(result.queues.every((q) => q.sampled_at === null)).toBe(true);
    // Names still arrived, so the panel can still say which queues exist.
    expect(result.queues.map((q) => q.name)).toEqual(["articles-dlq", "articles"]);
    expect(result.error).toBe("Cloudflare API: queue depths (HTTP 500).");
  });

  it("reports both failures in one message when neither call lands", async () => {
    stubFetch({
      queues: rejects(new Error("HTTP 500")),
      graphql: rejects(new Error("boom")),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues).toEqual([]);
    expect(result.error).toBe("Cloudflare API: queue names (HTTP 500); queue depths (boom).");
  });

  it("logs every degradation to console.error, and stays quiet when healthy", async () => {
    // The page shows the reason, but a Worker tail is where anyone actually
    // notices the panel has been broken for a week.
    stubFetch({ queues: rejects(new Error("HTTP 403")), graphql: ok(backlog()) });
    await getQueueBacklog(envWith(), NOW);
    expect(consoleError).toHaveBeenCalledTimes(1);
    // The prefix matters as much as the reason: a Worker tail is one
    // undifferentiated stream, so "admin/jobs" is how anyone greps this out
    // of everything else the Worker logs.
    expect(consoleError.mock.calls[0]).toEqual([
      "admin/jobs: queue backlog degraded --",
      "queue names (HTTP 403 -- CF_API_KEY is missing Queues:Read)",
    ]);

    // Two failures are still ONE log line. A per-failure console.error would
    // double the noise and split a single degraded render across two entries.
    consoleError.mockClear();
    stubFetch({ queues: rejects(new Error("HTTP 500")), graphql: rejects(new Error("boom")) });
    await getQueueBacklog(envWith(), NOW);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]![1])).toBe("queue names (HTTP 500); queue depths (boom)");

    consoleError.mockClear();
    stubFetch({ queues: ok(queueList(["a", "articles"])), graphql: ok(backlog()) });
    await getQueueBacklog(envWith(), NOW);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("getQueueBacklog: how failures are described", () => {
  it("names Queues:Read for a 403 on the list and Account Analytics:Read for a 403 on the depths", async () => {
    // The whole reason describe() takes a permission argument: the first
    // thing this panel said in production was an unactionable combined
    // "HTTP 403" that did not say which of the two scopes to add. The two
    // calls need DIFFERENT token permissions and must be reported apart.
    stubFetch({ queues: rejects(new Error("HTTP 403")), graphql: rejects(new Error("HTTP 403")) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe(
      "Cloudflare API: queue names (HTTP 403 -- CF_API_KEY is missing Queues:Read); " +
        "queue depths (HTTP 403 -- CF_API_KEY is missing Account Analytics:Read).",
    );
  });

  it("treats 401 the same as 403", async () => {
    // A revoked token answers 401 and a scope-less one answers 403; both
    // are "the credential", never "the request".
    stubFetch({ queues: status(401), graphql: ok(backlog()) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue names (HTTP 401 -- CF_API_KEY is missing Queues:Read).");
  });

  it("does not blame the token for other statuses", async () => {
    // A 500 or a 404 is Cloudflare's problem or a wrong URL. Telling an
    // admin to widen a token's scope for either sends them off to edit a
    // production credential for no reason.
    stubFetch({ queues: status(404), graphql: status(500) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue names (HTTP 404); queue depths (HTTP 500).");
    expect(result.error).not.toContain("CF_API_KEY");
  });

  it("matches 401/403 as whole numbers, not as digits inside a longer one", async () => {
    // The \b anchors in the regex. A substring test -- the obvious way to
    // write this -- would read Cloudflare error code 1403 (or a request id
    // that happens to contain 403) as an auth failure and send an admin off
    // to widen a production token's scope for a fault that has nothing to do
    // with permissions.
    stubFetch({
      queues: rejects(new Error("code 1403: queue not found")),
      graphql: rejects(new Error("HTTP 4030")),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue names (code 1403: queue not found); queue depths (HTTP 4030).");
    expect(result.error).not.toContain("missing");
  });

  it("names the permission when 403 is embedded in a longer sentence", async () => {
    // The other side of the same boundary: the digits do not have to be at
    // the end of the message, because Cloudflare's own wording puts them in
    // the middle. Non-digit neighbours on both sides still satisfy \b.
    stubFetch({
      queues: rejects(new Error("got a 403 back from the API")),
      graphql: ok(backlog()),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe(
      "Cloudflare API: queue names (got a 403 back from the API -- CF_API_KEY is missing Queues:Read).",
    );
  });

  it("surfaces GraphQL's first error, because the transport says 200", async () => {
    // Cloudflare's analytics API answers HTTP 200 with an `errors` array,
    // so a bad token arrives as a successful fetch. Without the explicit
    // check the panel would render "0 messages everywhere" on an
    // unauthorised token -- the worst possible failure mode for an alarm.
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({ errors: [{ message: "unauthorized to access this resource" }, { message: "second" }] }),
    });
    const result = await getQueueBacklog(envWith(), NOW);

    expect(result.error).toBe("Cloudflare API: queue depths (unauthorized to access this resource).");
    expect(result.queues[0]!.messages).toBeNull();
  });

  it("still names the permission when the 403 arrives inside a GraphQL error string", async () => {
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({ errors: [{ message: "error code: 403" }] }),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toContain("missing Account Analytics:Read");
  });

  it("ignores an empty GraphQL errors array", async () => {
    // `errors: []` alongside real data is a legal GraphQL response. A
    // truthiness check on the array alone (rather than on its length) would
    // blank the panel on a perfectly good answer.
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({ ...backlog(["a", 6, "2026-09-06T12:34:00Z"]), errors: [] }),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBeNull();
    expect(result.queues[0]!.messages).toBe(6);
  });

  it("rejects a queue list whose envelope says success:false, even with a result array", async () => {
    // Cloudflare's REST envelope can carry success:false under an HTTP 200,
    // so !res.ok is not enough to notice the call failed.
    //
    // The `result` array is populated ON PURPOSE. With `result: null` (the
    // usual error shape) the `!body.success` half of the guard is dead
    // weight -- `!body.result` alone would reject it -- and the test proves
    // nothing about which half is doing the work. A partial or stale result
    // under success:false is exactly the payload where believing the rows
    // means rendering a queue list Cloudflare has just disowned.
    stubFetch({
      queues: ok({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
        result: [{ queue_id: "a", queue_name: "articles" }],
      }),
      graphql: ok(backlog()),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue names (queue list unavailable).");
    expect(result.queues).toEqual([]);
  });

  it("rejects a queue list with no result array", async () => {
    stubFetch({ queues: ok({ success: true }), graphql: ok(backlog()) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue names (queue list unavailable).");
  });

  it("stringifies a non-Error rejection instead of printing [object Object]", async () => {
    stubFetch({ queues: rejects("kaboom"), graphql: ok(backlog()) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue names (kaboom).");
  });

  it("does print [object Object] for a thrown plain object", async () => {
    // The honest limit of `String(err)`. Nothing in this module's own code
    // path throws an object literal, but a library in the fetch chain can,
    // and the panel then says nothing useful. Pinned as current behaviour
    // rather than fixed, so a future JSON.stringify fallback shows up here
    // as a deliberate change.
    stubFetch({ queues: rejects({ code: 10000, message: "Authentication error" }), graphql: ok(backlog()) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue names ([object Object]).");
  });

  it("degrades on a 200 whose body is not JSON at all", async () => {
    // res.ok is true, so fetchJson's guard passes and the failure happens
    // inside res.json(). It has to land in the same allSettled net as an
    // HTTP error or an HTML 502 page from the edge takes /admin/jobs/ down
    // -- the one outcome the caller's Promise.all cannot survive.
    stubFetch({ queues: rawBody("<html>502 Bad Gateway</html>"), graphql: ok(backlog()) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues).toEqual([]);
    // The parser's wording is the runtime's business and changes between
    // Node versions; that it is REPORTED, under the right half, is not.
    expect(result.error).toMatch(/^Cloudflare API: queue names \(.+\)\.$/);
    expect(result.error).not.toContain("queue depths");
  });

  it("reports an empty parenthetical for a GraphQL error with no message", async () => {
    // `new Error(undefined).message` is "", so a malformed errors array
    // yields "queue depths ()" -- unhelpful, but it still blanks the depths
    // rather than rendering the zeros underneath as real. Given the choice,
    // an empty reason on a degraded panel beats a confident 0 on a broken
    // one. Pinned as current behaviour.
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({ errors: [{ code: 10000 }] }),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue depths ().");
    expect(result.queues[0]!.messages).toBeNull();
  });
});

describe("getQueueBacklog: the 5 second budget", () => {
  it("aborts both calls and reports the timeout in seconds", async () => {
    // A page render must not hang on someone else's API. The message is
    // deliberately in seconds ("no response within 5s") rather than a raw
    // abort string, because the abort string tells an admin nothing.
    vi.useFakeTimers();
    const fetchMock = stubFetch({ queues: hangs(), graphql: hangs() });

    const pending = getQueueBacklog(envWith(), NOW);
    let settled = false;
    void pending.then(() => { settled = true; });

    // The budget is FIVE seconds, and the assertion that it is not one or
    // two has to be made from below: without this, a timeout shortened to
    // 500ms passes every other test in this file unchanged while cutting
    // off a Cloudflare API that is merely slow rather than dead.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    expect((fetchMock.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.queues).toEqual([]);
    expect(result.error).toBe(
      "Cloudflare API: queue names (no response within 5s); queue depths (no response within 5s).",
    );
    // Both requests were genuinely in flight and both signals fired.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
  });

  it("keeps the half that answered when only one call hangs", async () => {
    // The timeout is shared, so the naive reading is that a slow analytics
    // API costs you the queue list too. It must not: the names arrived long
    // before the abort fired and allSettled hands them over regardless.
    // This is the difference between a panel that lists every queue with a
    // dash in the depth column and a panel that is simply blank.
    vi.useFakeTimers();
    stubFetch({ queues: ok(queueList(["a", "articles"], ["b", "articles-dlq"])), graphql: hangs() });

    const pending = getQueueBacklog(envWith(), NOW);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.queues).toEqual([
      { name: "articles-dlq", messages: null, is_dlq: true, sampled_at: null },
      { name: "articles", messages: null, is_dlq: false, sampled_at: null },
    ]);
    expect(result.error).toBe("Cloudflare API: queue depths (no response within 5s).");
  });

  it("only rewrites the exact abort wording, passing any other through", async () => {
    // describe() compares the message with === against the Workers runtime's
    // exact phrasing. That makes the friendly "no response within 5s" a
    // string match on someone else's error text: undici, for instance, says
    // "This operation was aborted" (This, not The) and would fall straight
    // through to the raw message. Pinned because the test above uses a mock
    // that produces the matching wording by construction, so nothing else
    // here would notice the coupling.
    stubFetch({ queues: rejects(new Error("This operation was aborted")), graphql: ok(backlog()) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.error).toBe("Cloudflare API: queue names (This operation was aborted).");
  });

  it("does not abort a call that answers inside the budget", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok(backlog(["a", 1, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);

    expect(result.error).toBeNull();
    expect((fetchMock.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(false);
  });

  it("clears the abort timer once the calls have settled", async () => {
    // The `finally` exists so a fast page render does not leave a 5-second
    // timer behind it. In a Worker a leaked timer keeps the request context
    // alive past the response, and one per /admin/jobs/ hit adds up.
    vi.useFakeTimers();
    stubFetch({ queues: ok(queueList(["a", "articles"])), graphql: ok(backlog()) });
    await getQueueBacklog(envWith(), NOW);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer even when the join throws", async () => {
    // The `finally` has to survive the one path that escapes the function
    // by throwing -- see the malformed-sample test below.
    vi.useFakeTimers();
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({ data: { viewer: { accounts: [{ queueBacklogAdaptiveGroups: [{ avg: { messages: 1 } }] }] } } }),
    });
    await expect(getQueueBacklog(envWith(), NOW)).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("getQueueBacklog: empty and malformed payloads", () => {
  it("returns an empty, un-errored panel for an account with no queues", async () => {
    // Not an error state: a fresh account, or one whose queues all live on
    // another account, legitimately has nothing to show.
    stubFetch({ queues: ok(queueList()), graphql: ok(backlog()) });
    expect(await getQueueBacklog(envWith(), NOW)).toEqual({ queues: [], error: null });
  });

  it("falls back to sample ids when the list SUCCEEDS but is empty", async () => {
    // The fallback keys off names.size, not off the call failing, so an
    // empty-but-successful list still yields id-labelled rows for anything
    // the analytics API knows about. Documented here because "the list
    // succeeded" and "we used the list" are not the same condition.
    stubFetch({
      queues: ok(queueList()),
      graphql: ok(backlog(["orphan-id-xyz", 3, "2026-09-06T12:34:00Z"])),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues).toEqual([
      { name: "queue orphan-i", messages: 3, is_dlq: false, sampled_at: "2026-09-06T12:34:00Z" },
    ]);
    // Nothing failed, so nothing is reported as failing.
    expect(result.error).toBeNull();
  });

  it("truncates a synthesised label at 8 characters and does not pad a short id", async () => {
    // slice(8), not substr/fixed width: a real queue id is 32 hex chars, so
    // the label is always "queue " + 8, but nothing guarantees that and an
    // implementation that assumed a length would throw or emit "undefined"
    // on anything shorter. The synthesised name can never end in -dlq, which
    // is the whole limitation the test below documents.
    stubFetch({
      queues: ok(queueList()),
      graphql: ok(
        backlog(
          ["4f2a1c9d8b7e6f5a4b3c2d1e0f9a8b7c", 3, "2026-09-06T12:34:00Z"],
          ["ab", 2, "2026-09-06T12:34:00Z"],
          ["", 1, "2026-09-06T12:34:00Z"],
        ),
      ),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues.map((q) => q.name)).toEqual(["queue 4f2a1c9d", "queue ab", "queue "]);
  });

  it("treats a GraphQL body with no data as zero depths, not as an error", async () => {
    // The `?? []` chain. Cloudflare returns data:null with no errors array
    // for some empty windows; every listed queue then reads 0/idle, which
    // is the honest answer -- messages stays a number because the call
    // itself succeeded.
    stubFetch({ queues: ok(queueList(["a", "articles"])), graphql: ok({}) });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result).toEqual({
      queues: [{ name: "articles", messages: 0, is_dlq: false, sampled_at: null }],
      error: null,
    });
  });

  it("survives an accounts array that is empty", async () => {
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({ data: { viewer: { accounts: [] } } }),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(result.queues[0]!.messages).toBe(0);
    expect(result.error).toBeNull();
  });

  it("REJECTS on a sample with no dimensions, escaping the allSettled net", async () => {
    // Current behaviour, pinned rather than fixed. The de-duplication loop
    // runs AFTER Promise.allSettled, so a malformed sample throws a
    // TypeError that nothing catches -- and routes/admin/jobs.ts awaits
    // this inside a Promise.all on the strength of "getQueueBacklog
    // resolves rather than rejects on failure". See suspectedBugs.
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({ data: { viewer: { accounts: [{ queueBacklogAdaptiveGroups: [{ avg: { messages: 1 } }] }] } } }),
    });
    await expect(getQueueBacklog(envWith(), NOW)).rejects.toThrow(TypeError);
  });

  it("REJECTS on a sample with no avg, for the same reason", async () => {
    // The row-building .map() is outside the allSettled net too, so an
    // absent `avg` object is a second uncaught TypeError. Same suspected
    // bug, different property -- both are pinned so that if someone ever
    // hardens this the change is visible as these tests going green on
    // resolve() instead of rejects().
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({
        data: {
          viewer: {
            accounts: [
              { queueBacklogAdaptiveGroups: [{ dimensions: { queueId: "a", datetimeMinute: "2026-09-06T12:34:00Z" } }] },
            ],
          },
        },
      }),
    });
    await expect(getQueueBacklog(envWith(), NOW)).rejects.toThrow(TypeError);
  });

  it("yields NaN messages when avg is present but empty", async () => {
    // One step less malformed, and it does NOT throw: Math.round(undefined)
    // is NaN, NaN is not nullish, and jobs.ts's `n + (q.messages ?? 0)`
    // total therefore renders as NaN rather than as the dash it shows for a
    // genuinely unknown depth. Current behaviour; see suspectedBugs.
    stubFetch({
      queues: ok(queueList(["a", "articles"])),
      graphql: ok({
        data: {
          viewer: {
            accounts: [
              {
                queueBacklogAdaptiveGroups: [
                  { avg: {}, dimensions: { queueId: "a", datetimeMinute: "2026-09-06T12:34:00Z" } },
                ],
              },
            ],
          },
        },
      }),
    });
    const result = await getQueueBacklog(envWith(), NOW);
    expect(Number.isNaN(result.queues[0]!.messages)).toBe(true);
    expect(result.error).toBeNull();
  });
});
