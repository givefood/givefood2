import type { Session } from "./types";
import { needCategorisedStatement } from "./needAdmin";

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
  // ORDER BY id DESC, matching Django's `.annotate(latest_id=Max('id'))`
  // (gfadmin/views.py:2062-2067) -- NOT `created`, which is copied from the
  // need and so ties across every line of one need.
  //
  // Served by foodbankchangeline_item_id_idx (migration 0021). Before that
  // index the only (item, ...) index was on `(item, created DESC)`, which
  // this query's ORDER BY cannot use: SQLite matched `item` from the index
  // then sorted the matches by id, reading EVERY row for that item --
  // measured at 5,735 rows read for a single lookup of "Tinned Soup", and
  // the categorise page issues one lookup per line. A 13-item need read
  // ~75,000 rows to render.
  const row = await session.prepare("SELECT * FROM foodbankchangeline WHERE item = ? ORDER BY id DESC LIMIT 1").bind(item).first<NeedLineRow>();
  return row ?? null;
}

// One line as the categorise form submits it. `item` is post-edit text --
// what the reviewer wants stored, not necessarily what change_text says.
export interface NeedLineInput {
  item: string;
  type: NeedLineType;
  category: string;
}

// D1 documents no cap on statements per batch, only the per-statement limits
// (100 bound parameters, 100KB of SQL) that each of these is far inside.
// Chunked anyway, because the POST body decides how many statements there
// are: 50 keeps every real need a single batch -- the mean is 13.4 lines and
// the largest in production is 102 -- while bounding what a hand-crafted POST
// with thousands of item_N fields can build.
const BATCH_SIZE = 50;

// RECONCILES this need's lines against the set the form submitted: update
// what is still there, insert what is new, delete what is gone, set
// is_categorised -- one prefetch and one batch.
//
// TWO THINGS ARE WRONG WITH THE PER-LINE upsertNeedLine THIS REPLACES.
//
// 1. SPEED. The route awaited it in a loop, and each call was a SELECT and
//    then a write, sequentially: 2N+1 D1 round trips per save. Needs average
//    13.4 lines and run to 102 (measured across the 24,968 categorised needs
//    in production, 2026-09-11), so that is 28 typically and 205 at the tail.
//    Now it is 2, flat, whatever the line count.
//
// 2. DUPLICATES. It matched an existing row on `item`, so saving the same
//    need twice could write its lines twice:
//
//      a. Reviewer corrects "Tinned tomatos" to "Tinned tomatoes" and saves.
//         A row is written under the CORRECTED text.
//      b. They reload. buildCategoriseLines renders from change_text, always
//         -- the correction is not persisted back to change_text and cannot
//         be -- so the box shows "Tinned tomatos" again.
//      c. They save. Nothing matched, so a SECOND row was inserted. One line
//         of one need, two categorised rows, both counted by every dashboard
//         query that groups on category.
//
//    Keying on `orig_item` instead -- Django's own key, views.py:2071-2074 --
//    does not fix it: after (a) the row's `item` has drifted away from the
//    change_text line, so nothing derived from change_text can find it again.
//    Deleting what the form did not submit is what closes it, and it closes
//    the same way round: at (c) the stale "Tinned tomatoes" row is gone
//    because it is not in the submitted set.
//
// UPDATE RATHER THAN DELETE-AND-REINSERT for a line that is still there, so
// row ids survive a re-save. getLatestLineForItem ranks category suggestions
// by `id DESC`, so reinserting every line would make whichever need was
// edited most recently outrank genuinely newer categorisations of the same
// item text.
export async function replaceNeedLines(
  session: Session,
  params: { needId: number; foodbankId: number; needCreated: string; needUuid: string; modified: string },
  lines: readonly NeedLineInput[],
): Promise<void> {
  // EVERY category resolved before anything is written. The per-line version
  // threw from inside the loop, so an unknown category committed the lines
  // before it and left the need unflagged -- a half-categorised need that
  // looked untouched in the admin.
  const groups = lines.map((line) => {
    const group = ITEM_CATEGORY_GROUPS[line.category];
    if (!group) throw new Error(`unknown item category: ${line.category}`);
    return group;
  });

  // Two lines can carry the SAME item text -- duplicate lines in the food
  // bank's own change_text, or a reviewer editing two boxes to match. Django
  // inserted the first and then UPDATED it from the second, and its UPDATE
  // touches category/group only, so the surviving row keeps the FIRST
  // occurrence's type and the LAST occurrence's category. Collapsing here
  // reproduces that; emitting both would leave two rows where Django left
  // one, which is the duplication this function exists to stop.
  const collapsed = new Map<string, { type: NeedLineType; category: string; group: string }>();
  for (const [i, line] of lines.entries()) {
    const first = collapsed.get(line.item);
    collapsed.set(line.item, { type: first?.type ?? line.type, category: line.category, group: groups[i]! });
  }

  const existing = await getChangeLinesForNeed(session, params.needId);

  const statements = [...collapsed].map(([item, line]) => {
    const already = existing.get(item);
    return already
      ? session
          .prepare("UPDATE foodbankchangeline SET category = ?, group_name = ? WHERE id = ?")
          .bind(line.category, line.group, already.id)
      : session
          .prepare(
            "INSERT INTO foodbankchangeline (need_id, foodbank_id, item, type, category, group_name, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(params.needId, params.foodbankId, item, line.type, line.category, line.group, params.needCreated);
  });

  // Rows the form did not submit: a line whose text was corrected on an
  // earlier save, or one whose category the reviewer has now cleared. Deleted
  // BY ID, one statement each, rather than with a `WHERE item NOT IN (...)`
  // -- D1 caps a statement at 100 bound parameters and a need can carry more
  // lines than that. Normally there are none.
  for (const [item, row] of existing) {
    if (!collapsed.has(item)) statements.push(session.prepare("DELETE FROM foodbankchangeline WHERE id = ?").bind(row.id));
  }

  statements.push(needCategorisedStatement(session, params.needUuid, params.modified));

  // Atomic per chunk rather than across all of them. A need long enough to
  // split that fails between chunks is left unflagged, so it shows as
  // uncategorised and re-saving it converges -- which is safe precisely
  // because reconciling is idempotent.
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await session.batch(statements.slice(i, i + BATCH_SIZE));
  }
}
