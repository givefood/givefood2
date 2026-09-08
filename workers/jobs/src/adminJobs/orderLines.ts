import type { Env } from "../../worker-configuration";
import {
  getOrderForLineParse,
  deleteOrderLines,
  insertOrderLines,
  setOrderAggregates,
  getOrderItemCalories,
  getLatestOrderLineCategory,
  recomputeFoodbankLastOrder,
  markAdminJobRunning,
  markAdminJobDone,
  markAdminJobFailed,
  type NewOrderLine,
} from "@givefood/db";
import { geminiJsonCall } from "@givefood/ai";

// The second half of givefood/models/orders.py:71-215 Order.save(). The
// admin's order form (workers/site/src/routes/admin/orderForm.ts) writes the
// order row itself and enqueues this; everything below the ORM's
// `super().save()` -- delete the old lines, ask Gemini to parse items_text,
// write new lines, recompute the five aggregates, restamp the food bank's
// last_order -- happens here.
//
// WHY A QUEUE, when Django does it inline: that inline path is a Gemini call
// in the middle of a form POST. WP 6.8 already moved the equivalent
// foodbank-check call off the request for the same reason, and this file
// follows that WP's shape exactly (admin_job row + JOBS_Q message + a page
// that polls). A Worker request has a CPU budget; a model call does not fit
// in it.
//
// Errors are recorded on the admin_job row rather than thrown, so the queue
// does NOT retry: a retry re-runs the same paid Gemini call against the same
// input and fails the same way. Identical reasoning to
// adminJobs/foodbankCheck.ts's own comment.

// gfadmin/templates/admin/prompts/orderline_prompt.txt, verbatim (the file is
// four short paragraphs plus `{{ items_text }}`; inlined here rather than
// added to packages/templates because workers/jobs renders no templates at
// all and this is the only prompt it would need).
function buildOrderLinePrompt(itemsText: string): string {
  return [
    "This is a list of items, the SKU name, quantity, individual weight in grams (one litre is 1000g), and unit price in pence. The weight is part of the name too.",
    "",
    'E.g. name of "Fray Bentos Meatballs In Tomato Sauce 380g" is "Fray Bentos Meatballs In Tomato Sauce 380g" and the weight is 380',
    "",
    "Here is the order text...",
    "",
    itemsText,
  ].join("\n");
}

// models/orders.py:118-134's response_schema, field for field.
const ORDER_LINE_RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      quantity: { type: "integer" },
      item_cost: { type: "integer" },
      weight: { type: "integer" },
    },
    required: ["name", "quantity", "item_cost", "weight"],
  },
};

interface AiOrderLine {
  name: string;
  quantity: number;
  item_cost: number;
  weight: number;
}

// Django calls html.unescape() on the AI's name (orders.py:175) -- shopping
// sites routinely return "Sainsbury&#39;s", and that string is what the
// calories/category lookups join on, so it has to be decoded before it is
// used as a key. Only the five entities html.unescape resolves in practice
// here; a full entity table would be ceremony for a product name.
function htmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last: an &amp;lt; must not become "<"
}

function isAiOrderLine(value: unknown): value is AiOrderLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && Number.isFinite(v.quantity) && Number.isFinite(v.item_cost) && Number.isFinite(v.weight);
}

export async function handleOrderLinesJob(env: Env, jobId: string, orderRowId: number): Promise<void> {
  // Same Sessions-API entry point as adminJobs/foodbankCheck.ts:62 -- this
  // D1 database has read replication enabled, so every read must go through
  // withSession() rather than env.DB.prepare() directly.
  const db = env.DB.withSession("first-unconstrained");
  try {
    await markAdminJobRunning(db, jobId);

    const order = await getOrderForLineParse(db, orderRowId);
    if (!order) {
      await markAdminJobFailed(db, jobId, `Order row ${orderRowId} no longer exists`);
      return;
    }

    if (!env.GEMINI_API_KEY) {
      // Explicit, not a crash: the key is not set on the account yet (the
      // same disclosed gap WP 6.8 carries). The order row survives with its
      // aggregates zeroed and no lines -- exactly the state it is in right
      // now -- and the admin sees why on the order page rather than an order
      // that silently looks empty.
      await markAdminJobFailed(db, jobId, "GEMINI_API_KEY is not configured, so the items text could not be parsed into order lines.");
      return;
    }

    const raw = await geminiJsonCall({
      apiKey: env.GEMINI_API_KEY,
      model: "gemini-2.0-flash",
      prompt: buildOrderLinePrompt(order.items_text),
      temperature: 1, // orders.py:117
      responseSchema: ORDER_LINE_RESPONSE_SCHEMA,
    });

    if (!Array.isArray(raw)) {
      await markAdminJobFailed(db, jobId, "The model did not return a list of order lines.");
      return;
    }
    const aiLines = raw.filter(isAiOrderLine);

    // orders.py:136-196. weight and line_cost are LINE totals (per-item value
    // x quantity); item_cost stays the per-item value the AI returned.
    // Calories come from the OrderItem table keyed on the exact name, per
    // 100g (utils/text.py:118-130), with a missing item scoring 0 rather than
    // raising -- Django swallows OrderItem.DoesNotExist there.
    let totalWeight = 0;
    let totalCalories = 0;
    let totalCost = 0;
    let totalItems = 0;
    const lines: NewOrderLine[] = [];

    for (const aiLine of aiLines) {
      const name = htmlUnescape(aiLine.name);
      const quantity = Math.trunc(aiLine.quantity);
      const itemCost = Math.trunc(aiLine.item_cost);
      const unitWeight = Math.trunc(aiLine.weight);

      const lineWeight = unitWeight * quantity;
      const lineCost = itemCost * quantity;

      const per100g = await getOrderItemCalories(db, name);
      // Django's get_calories returns a float here and OrderLine.calories is
      // a PositiveIntegerField, so the ORM truncates on save; doing it here
      // keeps the stored value identical.
      const calories = per100g === null ? 0 : Math.trunc(per100g * (unitWeight / 100) * quantity);

      // OrderLine.save()'s category backfill (orders.py:255) -- the most
      // recent non-empty category any line with this exact name has had.
      const category = (await getLatestOrderLineCategory(db, name)) ?? "";

      totalWeight += lineWeight;
      totalCost += lineCost;
      totalItems += quantity;
      totalCalories += calories;

      lines.push({ name, quantity, itemCost, lineCost, weight: lineWeight, calories, category, group: "" });
    }

    // Delete-then-insert, matching orders.py:107's
    // `OrderLine.objects.filter(order=self).delete()`. Done here rather than
    // at save time so a failed parse leaves the PREVIOUS lines in place
    // instead of destroying them -- Django deletes before it calls Gemini and
    // loses the lot if the call raises.
    await deleteOrderLines(db, order.id);
    await insertOrderLines(db, order.id, order.delivery_date, lines);
    await setOrderAggregates(db, order.id, {
      weight: totalWeight,
      calories: totalCalories,
      cost: totalCost,
      noLines: lines.length,
      noItems: totalItems,
    });

    // orders.py:213-215 -- the food bank's last_order is the delivery date of
    // its most recent order, recomputed rather than assumed to be this one.
    if (order.foodbank_id !== null) await recomputeFoodbankLastOrder(db, order.foodbank_id);

    await markAdminJobDone(db, jobId, { order_id: order.order_id, no_lines: lines.length, no_items: totalItems });
  } catch (err) {
    await markAdminJobFailed(db, jobId, err instanceof Error ? err.message : String(err));
  }
}
