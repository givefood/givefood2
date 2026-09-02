import type { Session } from "./types";

// WP 6.4: FoodbankChangeLine (givefood/models/needs.py:362-380) -- the
// per-item categorisation the admin's need_categorise page manually
// assigns. givefood/const/item_types.py's ITEM_CATEGORY_GROUPS verbatim:
// an app-level allowlist (not a DB constraint, matching every other
// choices field in this schema, §4.5) mapping each of the 49 categories to
// one of 8 groups.
export const ITEM_CATEGORY_GROUPS: Record<string, string> = {
  "Tinned Tomatoes": "Meal Food",
  "Tinned Meat": "Meal Food",
  "Tinned Vegetarian": "Meal Food",
  "Tinned Pasta": "Meal Food",
  Confectionery: "Snack Food",
  Cereal: "Meal Food",
  "Tinned Fruit": "Meal Food",
  Milk: "Drink",
  "Fruit Juice": "Drink",
  Squash: "Drink",
  Condiment: "Cooking",
  Noodles: "Meal Food",
  "Cooking Oil": "Cooking",
  "Tinned Fish": "Meal Food",
  Soup: "Meal Food",
  Crisps: "Snack Food",
  Biscuits: "Snack Food",
  "Baked Beans": "Meal Food",
  "Tinned Vegetables": "Meal Food",
  "Pasta Sauce": "Cooking",
  Pasta: "Meal Food",
  Rice: "Meal Food",
  Tea: "Drink",
  Coffee: "Drink",
  Sugar: "Cooking",
  Spread: "Meal Food",
  Vegetable: "Meal Food",
  "Instant Mash": "Meal Food",
  Dessert: "Meal Food",
  "Washing Up Liquid": "Cleaning",
  "Toilet Roll": "Toiletries",
  "Shower Gel": "Toiletries",
  Shampoo: "Toiletries",
  Soap: "Toiletries",
  Dental: "Toiletries",
  Deodorant: "Toiletries",
  Laundry: "Cleaning",
  "Sanitary Products": "Toiletries",
  "Baby Food": "Baby Supplies",
  "Baby Milk": "Baby Supplies",
  Nappies: "Baby Supplies",
  Wipes: "Baby Supplies",
  "Kitchen Roll": "Cleaning",
  "Household Supplies": "Cleaning",
  "Pet Food": "Other",
  "Carrier Bags": "Other",
  Sauce: "Cooking",
  Other: "Other",
  Toiletries: "Toiletries",
  "Hot Chocolate": "Drink",
};

export const ITEM_CATEGORIES = Object.keys(ITEM_CATEGORY_GROUPS).sort();

export type NeedLineType = "need" | "excess";

export interface NeedLineRow {
  id: number;
  need_id: number;
  foodbank_id: number;
  item: string;
  type: NeedLineType;
  category: string;
  group_name: string;
  created: string;
}

// gfadmin/views.py:2046-2050's `existing_need_lines` prefetch -- every line
// already categorised for THIS need, keyed by item text.
export async function getChangeLinesForNeed(session: Session, needId: number): Promise<Map<string, NeedLineRow>> {
  const result = await session.prepare("SELECT * FROM foodbankchangeline WHERE need_id = ?").bind(needId).all<NeedLineRow>();
  return new Map(result.results.map((row) => [row.item, row]));
}

// gfadmin/views.py:2057-2070's `latest_lines_by_item` -- the most recently
// created line ANYWHERE with this exact item text, used to suggest a
// category for an item this need hasn't been categorised for yet but a
// past need already was ("we've seen 'Tinned Tomatoes' before"). One query
// per item rather than Django's MAX(id)-then-refetch two-step -- D1 has no
// per-request round-trip budget concern here (this runs once per distinct
// item on a category-suggestion page, not a hot path).
export async function getLatestLineForItem(session: Session, item: string): Promise<NeedLineRow | null> {
  const row = await session.prepare("SELECT * FROM foodbankchangeline WHERE item = ? ORDER BY id DESC LIMIT 1").bind(item).first<NeedLineRow>();
  return row ?? null;
}

export interface UpsertNeedLineParams {
  needId: number;
  foodbankId: number;
  needCreated: string; // FoodbankChangeLine.created is copied from need.created, not now() -- needs.py:374
  item: string;
  type: NeedLineType;
  category: string;
}

// FoodbankChangeLine.save() (needs.py:372-376): foodbank/group/created are
// always derived, never caller-supplied. Upsert-by-(need_id, item) --
// there's no unique index enforcing this (matching Django, which dedupes
// purely via the existing_need_lines prefetch-then-form-instance pattern,
// not a DB constraint), so this does the same check-then-write instead of
// relying on ON CONFLICT.
export async function upsertNeedLine(session: Session, params: UpsertNeedLineParams): Promise<void> {
  const group = ITEM_CATEGORY_GROUPS[params.category];
  if (!group) throw new Error(`unknown item category: ${params.category}`);

  const existing = await session
    .prepare("SELECT id FROM foodbankchangeline WHERE need_id = ? AND item = ?")
    .bind(params.needId, params.item)
    .first<{ id: number }>();

  if (existing) {
    await session
      .prepare("UPDATE foodbankchangeline SET category = ?, group_name = ? WHERE id = ?")
      .bind(params.category, group, existing.id)
      .run();
  } else {
    await session
      .prepare("INSERT INTO foodbankchangeline (need_id, foodbank_id, item, type, category, group_name, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(params.needId, params.foodbankId, params.item, params.type, params.category, group, params.needCreated)
      .run();
  }
}
