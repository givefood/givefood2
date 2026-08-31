// Ported verbatim from givefood/const/item_types.py's ITEM_CATEGORIES_CHOICES
// (the 50 keys of ITEM_CATEGORY_GROUPS, `.sort()`ed) -- the "by item"
// category dropdown on /needs/ (gfwfbn `index`, routes/wfbn/index.ts) and
// the validated `item` query param it accepts.
//
// Django's own view filters "Other" out before handing the choice list to
// the template -- gfwfbn/views.py:112, `item_categories_filtered =
// [cat for cat in ITEM_CATEGORIES_CHOICES if cat[0] != "Other"]` -- so this
// list is pre-filtered the same way: 49 entries, not the source's 50.
// `find_locations_by_category` itself has no such restriction, but nothing
// ever calls it with category="Other" because nothing in the UI can select
// it.
export const ITEM_CATEGORIES: readonly string[] = [
  "Baby Food",
  "Baby Milk",
  "Baked Beans",
  "Biscuits",
  "Carrier Bags",
  "Cereal",
  "Coffee",
  "Condiment",
  "Confectionery",
  "Cooking Oil",
  "Crisps",
  "Dental",
  "Deodorant",
  "Dessert",
  "Fruit Juice",
  "Hot Chocolate",
  "Household Supplies",
  "Instant Mash",
  "Kitchen Roll",
  "Laundry",
  "Milk",
  "Nappies",
  "Noodles",
  "Pasta",
  "Pasta Sauce",
  "Pet Food",
  "Rice",
  "Sanitary Products",
  "Sauce",
  "Shampoo",
  "Shower Gel",
  "Soap",
  "Soup",
  "Spread",
  "Squash",
  "Sugar",
  "Tea",
  "Tinned Fish",
  "Tinned Fruit",
  "Tinned Meat",
  "Tinned Pasta",
  "Tinned Tomatoes",
  "Tinned Vegetables",
  "Tinned Vegetarian",
  "Toilet Roll",
  "Toiletries",
  "Vegetable",
  "Washing Up Liquid",
  "Wipes",
];
