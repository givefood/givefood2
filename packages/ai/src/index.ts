// @givefood/ai -- the Gemini REST client and the things built on it.
//
// Extracted from workers/jobs (github #38): the food bank check now runs
// inline in workers/site's admin route, and the order-lines parse still runs
// as a queue job in workers/jobs, so the two Workers share a caller each. The
// alternative was two copies of a 300-line comparison algorithm in two
// separately deployed Workers, which is the drift this repo goes out of its
// way to avoid.
export { geminiJsonCall } from "./gemini";
export { buildCheckPrompt, FOODBANK_CHECK_RESPONSE_SCHEMA, CHECK_USE_AI_FIELDS, type FoodbankCheckAiResponse } from "./checkPrompt";
export { runFoodbankCheck, type FoodbankCheckResult } from "./foodbankCheck";
