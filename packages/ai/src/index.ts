// @givefood/ai -- the Gemini REST client and the things built on it.
//
// Extracted from workers/jobs (github #38): the food bank check now runs
// inline in workers/site's admin route, and so does the order-lines parse,
// which workers/jobs also still runs for queue messages sent before it moved.
// The alternative was two copies of each in two separately deployed Workers,
// which is the drift this repo goes out of its way to avoid.
export { geminiJsonCall } from "./gemini";
export { buildCheckPrompt, FOODBANK_CHECK_RESPONSE_SCHEMA, CHECK_USE_AI_FIELDS, type FoodbankCheckAiResponse } from "./checkPrompt";
export { runFoodbankCheck, type FoodbankCheckResult } from "./foodbankCheck";
export { runOrderLinesJob, type OrderLinesTiming } from "./orderLines";
