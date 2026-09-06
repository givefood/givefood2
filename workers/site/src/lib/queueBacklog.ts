import type { AppEnv } from "../types";

// The half of "what is running" that D1 cannot answer.
//
// PLAN.md's own note on this (packages/db/src/adminDashboardStats.ts:5-9) is
// why Django's tasks_24h/tasks_outstanding were dropped from the admin index:
// django-tasks kept a Postgres history table for every background task, and
// "Cloudflare Queues has no equivalent (no queryable log of recent/outstanding
// tasks)". That is true of the DATABASE and false of the PLATFORM -- the
// backlog is real, it is just held by Cloudflare rather than by us, and the
// GraphQL analytics API will hand it over. This module is that retrieval.
//
// It is the most valuable thing on the jobs page, because it is the only
// place a DEAD LETTER QUEUE becomes visible. A message that fails its
// retries lands in a *-dlq and stops moving; wrangler.jsonc calls a DLQ
// "NON-NEGOTIABLE" for exactly that reason. Until now nothing in the admin
// could tell you one had anything in it.

// Backlog samples land roughly once a minute, but not on a guaranteed
// cadence and not for a queue that has been idle. Fifteen minutes is wide
// enough to find a recent sample for anything live, and narrow enough that
// "0 messages" still means now rather than an hour ago.
const BACKLOG_WINDOW_MS = 15 * 60_000;
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const QUEUES_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

// A page render must not hang on someone else's API. Both calls run in
// parallel under one budget, and a timeout degrades the panel rather than
// the page (see QueueBacklog's `error`).
const TIMEOUT_MS = 5_000;

export interface QueueBacklogRow {
  name: string;
  /** Null when depths could not be fetched -- unknown, not empty. */
  messages: number | null;
  is_dlq: boolean;
  /** Null when the queue produced no sample in the window -- idle, not zero. */
  sampled_at: string | null;
}

export interface QueueBacklog {
  queues: QueueBacklogRow[];
  /** Non-null when the panel is degraded; the page renders the reason. */
  error: string | null;
}

// The two calls need DIFFERENT token permissions, so a combined "HTTP 403"
// is unactionable -- it was the first thing this panel actually said in
// production, and it did not say which permission to add. Each call carries
// the permission its failure implies, and they are reported separately.
const NEEDS_QUEUES_READ = "Queues:Read";
const NEEDS_ACCOUNT_ANALYTICS = "Account Analytics:Read";

function describe(err: unknown, permission: string, timeoutMs: number): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw === "The operation was aborted") return `no response within ${timeoutMs / 1000}s`;
  // 403 and 401 are always the token, never the request -- say so, and name
  // the permission rather than making someone map a status code to it.
  if (/\b(401|403)\b/.test(raw)) return `${raw} -- CF_API_KEY is missing ${permission}`;
  return raw;
}

const BACKLOG_QUERY = `query($a:String!,$since:Time!,$until:Time!){
  viewer{accounts(filter:{accountTag:$a}){
    queueBacklogAdaptiveGroups(limit:1000,orderBy:[datetimeMinute_DESC],
      filter:{datetime_geq:$since,datetime_leq:$until}){
      avg{messages}
      dimensions{queueId datetimeMinute}
    }
  }}
}`;

interface BacklogSample {
  avg: { messages: number };
  dimensions: { queueId: string; datetimeMinute: string };
}

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// queueBacklogAdaptiveGroups reports queueId and nothing else -- there is no
// queueName dimension (checked against the schema, not assumed) -- so the
// names have to come from the Queues REST list and be joined here. That is
// the only reason this module makes two calls instead of one.
async function fetchQueueNames(accountId: string, apiKey: string, signal: AbortSignal): Promise<Map<string, string>> {
  const body = (await fetchJson(`${QUEUES_ENDPOINT}/${accountId}/queues`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, signal)) as { success?: boolean; result?: { queue_id: string; queue_name: string }[] };

  if (!body.success || !body.result) throw new Error("queue list unavailable");
  return new Map(body.result.map((q) => [q.queue_id, q.queue_name]));
}

async function fetchBacklogSamples(accountId: string, apiKey: string, now: number, signal: AbortSignal): Promise<BacklogSample[]> {
  const body = (await fetchJson(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: BACKLOG_QUERY,
      variables: {
        a: accountId,
        since: new Date(now - BACKLOG_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
        until: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    }),
  }, signal)) as {
    errors?: { message: string }[] | null;
    data?: { viewer?: { accounts?: { queueBacklogAdaptiveGroups?: BacklogSample[] }[] } };
  };

  // GraphQL answers 200 with an `errors` array, so a bad token or a missing
  // permission arrives here rather than as a rejected fetch.
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  return body.data?.viewer?.accounts?.[0]?.queueBacklogAdaptiveGroups ?? [];
}

export async function getQueueBacklog(env: AppEnv["Bindings"], now: number = Date.now()): Promise<QueueBacklog> {
  const accountId = env.CF_ACCOUNT_ID;
  const apiKey = env.CF_API_KEY;
  // Same degradation shape as routes/admin/clearCache.ts: an unset or
  // revoked credential disables one panel with a stated reason, and never
  // 500s a page that is otherwise perfectly renderable from D1.
  if (!accountId || !apiKey) {
    return { queues: [], error: "CF_ACCOUNT_ID/CF_API_KEY not set -- queue depths unavailable." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // allSettled, not all: the two calls fail independently and either one
    // alone is still worth rendering. Names without depths still tells you
    // which queues exist; depths without names still tells you something is
    // backed up, which is the alarm this panel exists to raise.
    const [namesResult, samplesResult] = await Promise.allSettled([
      fetchQueueNames(accountId, apiKey, controller.signal),
      fetchBacklogSamples(accountId, apiKey, now, controller.signal),
    ]);

    const problems: string[] = [];
    if (namesResult.status === "rejected") problems.push(`queue names (${describe(namesResult.reason, NEEDS_QUEUES_READ, TIMEOUT_MS)})`);
    if (samplesResult.status === "rejected") problems.push(`queue depths (${describe(samplesResult.reason, NEEDS_ACCOUNT_ANALYTICS, TIMEOUT_MS)})`);
    if (problems.length) console.error("admin/jobs: queue backlog degraded --", problems.join("; "));

    const names = namesResult.status === "fulfilled" ? namesResult.value : new Map<string, string>();
    const samples = samplesResult.status === "fulfilled" ? samplesResult.value : [];
    const haveDepths = samplesResult.status === "fulfilled";

    // Newest sample wins. The query is already ordered datetimeMinute_DESC,
    // so the first sighting of a queueId is its latest sample and every
    // later one is history.
    const latest = new Map<string, BacklogSample>();
    for (const s of samples) if (!latest.has(s.dimensions.queueId)) latest.set(s.dimensions.queueId, s);

    // Driven by the queue LIST where we have one: a queue with no sample in
    // the window is idle and must still appear, or the page would silently
    // omit exactly the queue that has stopped being consumed. Without the
    // list, fall back to whatever the samples themselves name -- an id is a
    // poor label but a backed-up queue with an ugly name still beats a blank
    // panel.
    const ids = names.size ? [...names.keys()] : [...latest.keys()];
    const queues: QueueBacklogRow[] = ids
      .map((id) => {
        const name = names.get(id) ?? `queue ${id.slice(0, 8)}`;
        const sample = latest.get(id);
        return {
          name,
          // avg over a one-minute bucket of an integer depth; round rather
          // than truncate so a queue that held one message for part of a
          // minute does not display as empty. Null when depths are missing
          // entirely -- an unknown depth must not render as a reassuring 0.
          messages: haveDepths ? (sample ? Math.round(sample.avg.messages) : 0) : null,
          is_dlq: name.endsWith("-dlq"),
          sampled_at: sample ? sample.dimensions.datetimeMinute : null,
        };
      })
      // Anything with messages first (DLQs ahead of live queues at equal
      // depth, since a non-empty DLQ is the one that needs a human), then
      // alphabetical so the idle majority is scannable.
      .sort((a, b) =>
        (b.messages ?? -1) - (a.messages ?? -1) ||
        Number(b.is_dlq) - Number(a.is_dlq) ||
        a.name.localeCompare(b.name));

    return { queues, error: problems.length ? `Cloudflare API: ${problems.join("; ")}.` : null };
  } finally {
    clearTimeout(timer);
  }
}
