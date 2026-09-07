import { describe, expect, it } from "vitest";
import { ITEM_CATEGORIES as DB_ITEM_CATEGORIES, ITEM_CATEGORY_GROUPS } from "@givefood/db";
import { LOCALES, loadCatalogue, translate } from "@givefood/templates";
import type { Locale } from "@givefood/templates";
import { ITEM_CATEGORIES } from "./itemCategories";

// itemCategories.ts is a single frozen-in-amber list, which is exactly why it
// needs tests: every way it can break is silent. Nothing in it throws --
//
//   * a category string that drifts from the value the admin writes into
//     foodbankchangeline.category gives a dropdown option that returns zero
//     results forever, because getFoodbankIdsByCategory (packages/db/src/
//     needs.ts:138-148) is `WHERE foodbankchangeline.category = ?` -- an
//     exact, case-sensitive TEXT match with no fallback;
//   * a category dropped from this list is unselectable on /needs/ AND
//     rejected as a query param, since wfbn/index.ts:73 validates `?item=`
//     against this same array (`ITEM_CATEGORIES.includes(itemCategory)`),
//     so an existing bookmarked link just quietly stops filtering;
//   * a reworded category still renders, just always in English, because
//     wfbn/index.njk:190 uses the string as a translation *key*
//     (`{{ _(cat_label) }}`).
//
// So the tests below assert the cross-file agreements, not the literals in
// isolation. The Django source is duplicated by hand here on purpose -- same
// reasoning as countries.test.ts and apiResponse.test.ts: the module under
// test must not be allowed to supply its own expectations.

// givefood/const/item_types.py:3-54, copied by hand in the Python source's
// own dict order (NOT sorted -- sorting is one of the behaviours under test),
// unwrapped from their `_()` calls: the msgid is the argument, and the msgid
// is what this port stores. All 50 keys, "Other" included.
const DJANGO_ITEM_CATEGORY_KEYS: readonly string[] = [
  "Tinned Tomatoes",
  "Tinned Meat",
  "Tinned Vegetarian",
  "Tinned Pasta",
  "Confectionery",
  "Cereal",
  "Tinned Fruit",
  "Milk",
  "Fruit Juice",
  "Squash",
  "Condiment",
  "Noodles",
  "Cooking Oil",
  "Tinned Fish",
  "Soup",
  "Crisps",
  "Biscuits",
  "Baked Beans",
  "Tinned Vegetables",
  "Pasta Sauce",
  "Pasta",
  "Rice",
  "Tea",
  "Coffee",
  "Sugar",
  "Spread",
  "Vegetable",
  "Instant Mash",
  "Dessert",
  "Washing Up Liquid",
  "Toilet Roll",
  "Shower Gel",
  "Shampoo",
  "Soap",
  "Dental",
  "Deodorant",
  "Laundry",
  "Sanitary Products",
  "Baby Food",
  "Baby Milk",
  "Nappies",
  "Wipes",
  "Kitchen Roll",
  "Household Supplies",
  "Pet Food",
  "Carrier Bags",
  "Sauce",
  "Other",
  "Toiletries",
  "Hot Chocolate",
];

describe("ITEM_CATEGORIES", () => {
  it("is checked against a hand copy that is genuinely in Django's unsorted dict order", () => {
    // Every other test here compares the port against
    // DJANGO_ITEM_CATEGORY_KEYS, so that copy is load-bearing and nothing
    // else in the file checks it. Two specific ways it can rot:
    //
    // First, someone "tidies" it into alphabetical order on the assumption
    // that the order was arbitrary. The next test would still pass and still
    // catch a dict-order port (its expected value is the sorted list either
    // way) -- but the repo would have lost its only record of what
    // item_types.py's dict order actually is, and the `.sort()` there would
    // stop being a reproduction of item_types.py:60-62 and become
    // decoration. Assert the copy is genuinely unsorted, so the Python step
    // being modelled is one that demonstrably does something.
    expect(DJANGO_ITEM_CATEGORY_KEYS).toHaveLength(50);
    expect([...DJANGO_ITEM_CATEGORY_KEYS]).not.toEqual([...DJANGO_ITEM_CATEGORY_KEYS].sort());
    // Second, and the real risk: a typo in the transcription itself, which
    // would make every "matches Django" assertion below agree with the wrong
    // answer. packages/db's ITEM_CATEGORY_GROUPS is a SEPARATE hand-port of
    // the same Python dict (needLines.ts:3-9 -- "item_types.py's
    // ITEM_CATEGORY_GROUPS verbatim"), and JS object literals iterate
    // non-integer-like string keys in insertion order, so Object.keys()
    // hands back Python's dict order. Requiring the two copies to agree
    // position-for-position -- not just as sets, which the "assignable
    // categories" test already covers -- is the closest this repo can get to
    // item_types.py, which is not vendored here. It is also what makes the
    // order claim above verifiable rather than folklore.
    expect(Object.keys(ITEM_CATEGORY_GROUPS)).toEqual([...DJANGO_ITEM_CATEGORY_KEYS]);
  });

  it("is Django's ITEM_CATEGORIES_CHOICES, sorted and 'Other'-filtered", () => {
    // Reproduces the two Python steps this port collapsed into one literal:
    // item_types.py:60-62 (`list(ITEM_CATEGORY_GROUPS.keys())` then
    // `.sort()`), and gfwfbn/views.py:112's dropdown filter
    // (`[cat for cat in ITEM_CATEGORIES_CHOICES if cat[0] != "Other"]`).
    // Derived from the hand-copied source above rather than compared against
    // a second copy of the answer, so a category added to Django but not
    // here shows up as a diff on the entry, not on a count.
    const djangoWithoutOther = DJANGO_ITEM_CATEGORY_KEYS.filter((key) => key !== "Other");
    expect(ITEM_CATEGORIES).toEqual([...djangoWithoutOther].sort());
    // ...and NOT Django's dict order, which is the other way this could have
    // been transcribed: a port that pasted the keys straight out of the
    // Python file without the `.sort()` step would ship a dropdown starting
    // at "Tinned Tomatoes". Implied by the line above, but written out so
    // this test states the sort step's effect without depending on a
    // separate `it` block for the premise that makes it visible.
    expect(ITEM_CATEGORIES).not.toEqual(djangoWithoutOther);
  });

  it("ships 49 entries, one fewer than the Python source's 50", () => {
    // The module comment's headline claim. Stated as the set difference so a
    // failure names the category that appeared or vanished, and so that
    // "somebody deleted one and added another" cannot pass a length check.
    expect(new Set(DJANGO_ITEM_CATEGORY_KEYS).size).toBe(50);
    expect(ITEM_CATEGORIES).toHaveLength(49);
    // toHaveLength is happy with a string ("abc" has length 3), and every
    // consumer calls array methods on this -- index.ts:73 includes(),
    // index.ts:163 map() -- so pin that it really is an array.
    expect(Array.isArray(ITEM_CATEGORIES)).toBe(true);
    const removed = DJANGO_ITEM_CATEGORY_KEYS.filter((key) => !ITEM_CATEGORIES.includes(key));
    expect(removed).toEqual(["Other"]);
    // ...and nothing invented on this side either. Without this direction a
    // port that dropped "Other" *and* added a 50th category of its own would
    // still satisfy both the length and the `removed` assertions above.
    const added = ITEM_CATEGORIES.filter((category) => !DJANGO_ITEM_CATEGORY_KEYS.includes(category));
    expect(added).toEqual([]);
  });

  it("omits 'Other', so /needs/?item=Other is ignored here but honoured by Django", () => {
    // A deliberate, documented divergence and the one place this list is not
    // a pure port. Django validates the query param against the UNfiltered
    // tuple (gfwfbn/views.py:89-92, `valid_categories = [cat[0] for cat in
    // ITEM_CATEGORIES_CHOICES]`) and only filters "Other" out of the
    // template's dropdown afterwards (views.py:112). This port validates
    // against the already-filtered list (wfbn/index.ts:73), so a hand-typed
    // or archived `?item=Other` runs find_locations_by_category in Django
    // and silently falls through to the unfiltered page here. Pinning it
    // means the divergence stays a decision rather than becoming a surprise.
    expect(DJANGO_ITEM_CATEGORY_KEYS).toContain("Other");
    expect(ITEM_CATEGORIES).not.toContain("Other");
    // "Other" is a real, assignable category in the admin (need_categorise
    // writes it into foodbankchangeline.category), which is why the rows it
    // would have matched genuinely exist -- see the @givefood/db test below.
    expect(ITEM_CATEGORY_GROUPS["Other"]).toBe("Other");
    // The removal is a filter, not a slice or an off-by-one. In code-unit
    // order "Other" sits between "Noodles" and "Pasta", so those two must
    // now be adjacent: no gap left where it was, and no neighbour taken out
    // with it. A `.splice(index, 2)` or a fencepost slip is invisible to a
    // length check (49 either way) but not to this.
    expect("Noodles" < "Other" && "Other" < "Pasta").toBe(true);
    const noodles = ITEM_CATEGORIES.indexOf("Noodles");
    expect(noodles).toBeGreaterThanOrEqual(0);
    expect(ITEM_CATEGORIES[noodles + 1]).toBe("Pasta");
  });

  it("is a different list from @givefood/db's same-named ITEM_CATEGORIES export", () => {
    // The trap this module sets for its next maintainer. packages/db/src/
    // needLines.ts:62 exports `ITEM_CATEGORIES = Object.keys(
    // ITEM_CATEGORY_GROUPS).sort()` -- 50 entries, "Other" included -- and
    // re-exports it through packages/db/src/index.ts:18's `export * from
    // "./needLines"`. So `import { ITEM_CATEGORIES } from "@givefood/db"`
    // compiles, type-checks, and is WRONG here by exactly one entry.
    // admin/needs.ts:21,377 deliberately uses the db one (the categorise
    // page must be able to assign "Other"); wfbn/index.ts:13 deliberately
    // uses this one. A tidy-up that "de-duplicates the two identical
    // category lists" therefore either leaks "Other" into the public /needs/
    // dropdown or removes it from the admin's, and no type error and no
    // other test in this file would notice -- the Django comparison above
    // compares against the hand-copied Python, which the db list also
    // satisfies once "Other" is filtered. Hence this test, which is the only
    // one that fails if the two exports are collapsed into one.
    expect(ITEM_CATEGORIES).not.toBe(DB_ITEM_CATEGORIES);
    expect(DB_ITEM_CATEGORIES).toHaveLength(50);
    expect(DB_ITEM_CATEGORIES).toContain("Other");
    expect(DB_ITEM_CATEGORIES.filter((category) => category !== "Other")).toEqual([...ITEM_CATEGORIES]);
  });

  it("is in ascending code-unit order, the order Python's list.sort() gives", () => {
    // The list is a dropdown, rendered in array order by wfbn/index.njk:189,
    // so this is user-visible ordering and not just tidiness. JavaScript's
    // default Array#sort compares UTF-16 code units and Python's str
    // comparison compares code points -- identical ONLY while every entry
    // stays inside the BMP's ASCII range, which is the unstated premise that
    // lets the literal be pasted out of a Python sort at all. Assert the
    // premise here rather than leaving it to the shape test further down, so
    // this test stands on its own: an accented category (a Welsh or Irish
    // rewording is the realistic way one arrives) would sort differently in
    // the two languages and this list would stop being reproducible from
    // Django.
    for (const category of ITEM_CATEGORIES) {
      for (const char of category) {
        expect(char.codePointAt(0), `non-ASCII character in ${JSON.stringify(category)}`).toBeLessThan(0x80);
      }
    }
    expect([...ITEM_CATEGORIES].sort()).toEqual([...ITEM_CATEGORIES]);
    // Strictly ascending, not merely non-descending: a duplicate would
    // survive the sort comparison above (it is stable and equal elements
    // compare equal), so pin the strict relation between each adjacent pair.
    for (let i = 1; i < ITEM_CATEGORIES.length; i++) {
      expect(
        ITEM_CATEGORIES[i - 1]! < ITEM_CATEGORIES[i]!,
        `${ITEM_CATEGORIES[i - 1]} should sort strictly before ${ITEM_CATEGORIES[i]}`,
      ).toBe(true);
    }
  });

  it("orders 'Toilet Roll' before 'Toiletries', where the space is load-bearing", () => {
    // The adjacent pair that catches a re-sort done with a collator instead
    // of the default comparator. Under Intl collation with
    // ignorePunctuation (a plausible "sort it properly" edit) the space is
    // skipped, "toiletroll" sorts after "toiletries", and these two swap --
    // the only pair in the list that moves. Byte order, not human order, is
    // what Django produced and what the option list has always shown.
    //
    // Membership first: indexOf returns -1 for a missing entry, and -1 is
    // less than every real index, so `indexOf(a) < indexOf(b)` is satisfied
    // for free by a port that dropped "Toilet Roll" or "Pasta" altogether.
    // Without these four lines this test passes against exactly the broken
    // implementation it is named after.
    for (const category of ["Toilet Roll", "Toiletries", "Pasta", "Pasta Sauce"]) {
      expect(ITEM_CATEGORIES, `${category} is missing entirely`).toContain(category);
    }
    expect(ITEM_CATEGORIES.indexOf("Toilet Roll")).toBeLessThan(ITEM_CATEGORIES.indexOf("Toiletries"));
    expect(ITEM_CATEGORIES.indexOf("Pasta")).toBeLessThan(ITEM_CATEGORIES.indexOf("Pasta Sauce"));
    // Nail the claim that this is the *only* pair a collator would move, so
    // the comment above cannot quietly go stale: sorted with
    // ignorePunctuation the list differs from the shipped order in exactly
    // these two slots. If a future category makes that false, this test says
    // so and the comment gets rewritten instead of being trusted.
    const collator = new Intl.Collator("en", { ignorePunctuation: true, sensitivity: "variant" });
    const collated = [...ITEM_CATEGORIES].sort((a, b) => collator.compare(a, b));
    const moved = ITEM_CATEGORIES.filter((category, i) => collated[i] !== category);
    expect(moved).toEqual(["Toilet Roll", "Toiletries"]);
  });

  it("has no duplicates, case-insensitively either", () => {
    // A duplicated line in a 49-entry hand-maintained literal is invisible in
    // review, and renders as two identical <option>s in the dropdown.
    expect(new Set(ITEM_CATEGORIES).size).toBe(ITEM_CATEGORIES.length);
    // Case-folded too, which the exact Set above cannot see. Two entries
    // differing only in case ("Sauce"/"sauce") would be two distinct
    // dropdown options here, but D1 is free to be handed a column declared
    // COLLATE NOCASE, in which case getFoodbankIdsByCategory's `category =
    // ?` would return the same rows for both -- one option silently
    // shadowing the other's results.
    expect(new Set(ITEM_CATEGORIES.map((category) => category.toLowerCase())).size).toBe(ITEM_CATEGORIES.length);
  });

  it("only offers categories the admin can actually assign", () => {
    // The cross-package agreement that decides whether an option returns
    // results. packages/db's ITEM_CATEGORY_GROUPS is the allowlist the
    // need_categorise page writes from (admin/needs.ts:377), and
    // getFoodbankIdsByCategory matches `category = ?` exactly, so a category
    // offered here but never written there is a permanently empty "by item"
    // result -- which the page reports as "no food banks near you need this",
    // not as an error. Asserted in both directions: the two lists must
    // differ by "Other" and nothing else.
    //
    // The 50 is this module's own opening claim ("the 50 keys of
    // ITEM_CATEGORY_GROUPS"): if packages/db grows a 51st category, the
    // dropdown here is the thing that has to be told about it.
    expect(Object.keys(ITEM_CATEGORY_GROUPS)).toHaveLength(50);
    const assignableExceptOther = Object.keys(ITEM_CATEGORY_GROUPS)
      .filter((category) => category !== "Other")
      .sort();
    expect(ITEM_CATEGORIES).toEqual(assignableExceptOther);
    for (const category of ITEM_CATEGORIES) {
      expect(Object.hasOwn(ITEM_CATEGORY_GROUPS, category), `${category} is not an assignable category`).toBe(true);
      // upsertNeedLine (needLines.ts:123-124) reads the group with a bare
      // bracket lookup and rejects only falsy results, so an entry mapped to
      // "" would pass hasOwn and then be written into
      // foodbankchangeline.group_name as an empty string.
      expect(typeof ITEM_CATEGORY_GROUPS[category], `${category} has no group name`).toBe("string");
      expect(ITEM_CATEGORY_GROUPS[category], `${category} has an empty group name`).not.toBe("");
    }
  });

  it("never shadows an Object.prototype key, which a bare bracket lookup would find", () => {
    // Not hypothetical tidiness: needLines.ts:123 is
    // `const group = ITEM_CATEGORY_GROUPS[params.category]` on an object
    // literal, guarded only by `if (!group) throw`. A category named
    // "constructor" or "toString" would resolve through the prototype to a
    // truthy function, sail past that guard, and be stringified into
    // foodbankchangeline.group_name. Cheap to keep true, catastrophic to
    // discover in production, and the Title Case shape below does not by
    // itself rule out "Constructor" ever being renamed lower-case.
    for (const category of ITEM_CATEGORIES) {
      expect(Object.hasOwn(Object.prototype, category), `${category} collides with Object.prototype`).toBe(false);
      expect(Object.hasOwn(Array.prototype, category), `${category} collides with Array.prototype`).toBe(false);
    }
    expect(ITEM_CATEGORIES).not.toContain("constructor");
    expect(ITEM_CATEGORIES).not.toContain("__proto__");
  });

  it("holds clean Title Case ASCII, safe to round-trip through a query string", () => {
    // Every entry is simultaneously an <option value>, a `?item=` query
    // param and a SQL bind value. A stray trailing space or a smart
    // apostrophe would survive the URL round trip and then fail the exact
    // `category = ?` match, giving an empty result page with no error
    // anywhere. Shape only -- the wording itself is pinned by the Django
    // comparison above.
    for (const category of ITEM_CATEGORIES) {
      expect(category, `malformed category: ${JSON.stringify(category)}`).toMatch(/^[A-Z][a-z]+( [A-Z][a-z]+)*$/);
      expect(category.trim()).toBe(category);
      // Unicode-normalisation-stable. Browsers and OS text fields are free
      // to hand back NFC or NFD, and the two forms of an accented character
      // are different TEXT values to SQLite's `=`. Pure ASCII is the only
      // form that is identical under both, so this is what makes the exact
      // match safe rather than lucky.
      expect(category.normalize("NFC")).toBe(category);
      expect(category.normalize("NFD")).toBe(category);
      // ...and the payoff of those two, at the boundary that actually
      // matters: a value that arrives re-normalised -- a label copied out of
      // the rendered dropdown, or a param a client normalised in transit --
      // is still a hit on index.ts:73's includes(). Asserting the lookup,
      // not just the string identity, is what makes the invariant testable
      // as behaviour rather than as trivia.
      expect(ITEM_CATEGORIES.includes(category.normalize("NFD"))).toBe(true);
      expect(ITEM_CATEGORIES.includes(category.normalize("NFC"))).toBe(true);
      // encodeURIComponent must not have to escape anything but the spaces,
      // or a link built by hand and one built by the form would differ.
      expect(encodeURIComponent(category)).toBe(category.replaceAll(" ", "%20"));
    }
  });

  it("survives both query-string encodings of a space, which is where the two link styles meet", () => {
    // The /needs/ category selector is a GET form, so the browser serialises
    // the chosen option as `item=Baked+Beans`; a link written by hand, or
    // one this codebase builds with encodeURIComponent, says
    // `item=Baked%20Beans`. Hono reads the param via URLSearchParams, which
    // decodes both to the same string -- but only because no category
    // contains a literal "+", "&", "=", "%" or "#".
    //
    // Deliberately asserted on the ENCODED SPELLINGS, not on a decode of
    // whatever the encoder just produced. URLSearchParams is lossless for
    // every possible string, so `encode(x)` then `decode(...)` === x is a
    // tautology that passes for "Rice & Pasta" and "Soap 50%" alike and
    // tests nothing. What is actually falsifiable is that the only
    // difference between the two spellings is the space: the form must
    // serialise to exactly `category` with spaces as "+", and a link a
    // human types with "%20" must parse back to `category`. Add an "&" and
    // the form emits `Rice+%26+Pasta` while the hand-written
    // `item=Rice%20&%20Pasta` splits into two params and yields "Rice " --
    // the "by item" tab filtering on a value nobody chose.
    for (const category of ITEM_CATEGORIES) {
      const formEncoded = new URLSearchParams({ item: category }).toString();
      expect(formEncoded, `${category} does not form-encode as a plain space swap`).toBe(
        `item=${category.replaceAll(" ", "+")}`,
      );
      const handWritten = `item=${category.replaceAll(" ", "%20")}`;
      expect(new URLSearchParams(handWritten).get("item")).toBe(category);
      expect(new URLSearchParams(formEncoded).get("item")).toBe(category);
      // And the decoded value must still be a member -- the round trip is
      // only worth anything if wfbn/index.ts:73's includes() then hits.
      expect(ITEM_CATEGORIES.includes(new URLSearchParams(handWritten).get("item")!)).toBe(true);
    }
  });

  it("matches the `?item=` param exactly, with no case or whitespace forgiveness", () => {
    // wfbn/index.ts:73 is `itemCategory !== "" && ITEM_CATEGORIES.includes(
    // itemCategory)`, and Django's `item_category in valid_categories` is
    // just as literal -- both silently ignore anything unrecognised instead
    // of erroring.
    //
    // Replicated here as a predicate rather than calling includes() bare, so
    // the near-misses below are checked through the guard the route actually
    // applies -- including the `itemCategory !== ""` half, which nothing in
    // this file otherwise reaches. index.ts:44 is `c.req.query("item") ?? ""`,
    // so "" is the real shape of an absent param, not a hypothetical.
    const isValidItemParam = (itemCategory: string): boolean =>
      itemCategory !== "" && ITEM_CATEGORIES.includes(itemCategory);

    // These are the near-misses a real link produces (a lowercased URL, a
    // "+"-decoded trailing space, a plural), and every one of them has to be
    // a miss for the two ports to agree.
    expect(isValidItemParam("Baked Beans")).toBe(true);
    expect(isValidItemParam("baked beans")).toBe(false);
    expect(isValidItemParam("BAKED BEANS")).toBe(false);
    expect(isValidItemParam("Baked Beans ")).toBe(false);
    expect(isValidItemParam(" Baked Beans")).toBe(false);
    expect(isValidItemParam("Baked  Beans")).toBe(false);
    expect(isValidItemParam("Tinned Fishes")).toBe(false);
    // A non-breaking space is what a category pasted out of a rendered page
    // arrives as, and it is visually identical to the real thing in a URL
    // bar and in a failing test's diff -- written as a \u escape, not the
    // character itself, so a later editor cannot silently "fix" it back
    // into a normal space and turn this line into a passing lie.
    expect(isValidItemParam("Baked\u00A0Beans")).toBe(false);
    // A Cyrillic Ve standing in for the leading B -- the other way a
    // copy-pasted label goes wrong, and the one no amount of trimming or
    // case-folding would rescue. Escaped for the same reason.
    expect(isValidItemParam("\u0412aked Beans")).toBe(false);
    // The divergence pinned above, stated through the guard that causes it:
    // Django would accept this param and run find_locations_by_category;
    // here it falls through to the unfiltered page.
    expect(isValidItemParam("Other")).toBe(false);
    // The absent-param case, and the `!== ""` guard doing its job. The empty
    // string is not in the list either, so the guard is belt and braces
    // rather than the thing holding the door shut -- assert both halves so
    // that stays true if the list ever grows a blank entry.
    expect(isValidItemParam("")).toBe(false);
    expect(ITEM_CATEGORIES.includes("")).toBe(false);
    // Hono hands back `undefined` for an absent param before the `?? ""`
    // substitution, and nothing stops a caller passing a number through.
    // includes() uses SameValueZero, so these are genuine misses rather than
    // coercions: no `==`-style comparison anywhere can make 0, -0 or NaN
    // match a string entry.
    expect(ITEM_CATEGORIES.includes(undefined as unknown as string)).toBe(false);
    expect(ITEM_CATEGORIES.includes(null as unknown as string)).toBe(false);
    expect(ITEM_CATEGORIES.includes(NaN as unknown as string)).toBe(false);
    expect(ITEM_CATEGORIES.includes(0 as unknown as string)).toBe(false);
    expect(ITEM_CATEGORIES.includes(-0 as unknown as string)).toBe(false);
    // A query string can carry arbitrary length; nothing here truncates or
    // prefix-matches, so a padded value is still a miss rather than a hit on
    // the entry it starts with.
    expect(isValidItemParam(`Baked Beans${"x".repeat(10_000)}`)).toBe(false);
    // ...and the same in the other direction: a prefix of a real entry is
    // not a match either, which is what rules out any startsWith-style
    // laxity creeping into the guard.
    expect(isValidItemParam("Baked")).toBe(false);
    expect(isValidItemParam("Tinned")).toBe(false);
  });

  it("is only readonly to the type checker, not at runtime", () => {
    // Documenting current behaviour, not endorsing it. `readonly string[]`
    // is erased at build time and there is no Object.freeze here, so this
    // array is mutable module-scope state in an isolate that serves many
    // requests: one consumer calling ITEM_CATEGORIES.sort() or .push()
    // (Array#sort mutates in place) would reorder or grow the dropdown for
    // every later request that isolate handles, until it is recycled.
    // Today's callers all treat it as read-only -- wfbn/index.ts:163 does
    // `.map(...)`, which copies -- so this is a hazard for the next caller,
    // not a live bug.
    //
    // Demonstrated rather than inferred from Object.isFrozen: the point is
    // that the mutation is observable through the shared binding every
    // importer holds, which a frozen-flag probe does not show. Restored in
    // `finally` so the rest of the file still sees the shipped 49.
    expect(Object.isFrozen(ITEM_CATEGORIES)).toBe(false);
    const mutable = ITEM_CATEGORIES as string[];
    try {
      mutable.push("Zzz Poisoned");
      expect(ITEM_CATEGORIES).toHaveLength(50);
      expect(ITEM_CATEGORIES.includes("Zzz Poisoned")).toBe(true);
    } finally {
      mutable.pop();
    }
    expect(ITEM_CATEGORIES).toHaveLength(49);
    expect(ITEM_CATEGORIES.includes("Zzz Poisoned")).toBe(false);
  });

  it("stores msgids that every shipped catalogue can still translate", () => {
    // wfbn/index.njk:190 renders `<option value="{{ cat_value }}">{{
    // _(cat_label) }}</option>` from wfbn/index.ts:163's `[category,
    // category]` pairs -- so the same string is both the value posted back
    // and the label looked up. translate() falls back to the msgid on a
    // miss, so a category reworded here does not break the page: it silently
    // serves an English dropdown to every Welsh, Irish and Gaelic visitor,
    // forever, and nothing anywhere reports it. Assert the catalogue really
    // holds the key rather than that the output differs, because one entry
    // legitimately translates to itself -- see the next test.
    //
    // Locales are derived from @givefood/templates' LOCALES rather than
    // listed here: i18n.ts:5 already warns the four-language set is a
    // maintainer decision that could change, and a hard-coded ["cy","ga",
    // "gd"] would keep passing while a newly shipped fifth catalogue went
    // entirely uncovered. Pin the shape of that derivation too -- if "en"
    // ever left LOCALES, `nonEnglish` would silently become all of them and
    // the English-passthrough test below would be testing a locale nobody
    // serves.
    expect(LOCALES).toContain("en");
    const nonEnglish = LOCALES.filter((locale) => locale !== "en");
    expect(nonEnglish).toHaveLength(LOCALES.length - 1);
    expect(nonEnglish.length).toBeGreaterThan(0);
    return Promise.all(
      nonEnglish.map(async (locale) => {
        const catalogue = await loadCatalogue(locale);
        for (const msgid of ITEM_CATEGORIES) {
          expect(Object.hasOwn(catalogue, msgid), `${locale} has no entry for "${msgid}"`).toBe(true);
          expect(catalogue[msgid], `${locale} has an empty translation for "${msgid}"`).toBeTruthy();
          expect(translate(catalogue, msgid)).toBe(catalogue[msgid]);
          // translate() also runs interpolate(), which deletes any
          // `%(name)s` placeholder it cannot fill (i18n.ts:34-37). A
          // category msgstr has no vars to fill, so a placeholder that crept
          // into a translation would render as a hole in the dropdown label
          // -- and the toBe() above would already have caught it, which is
          // exactly why it is written against catalogue[msgid] and not
          // against a second translate() call.
          expect(catalogue[msgid]).not.toMatch(/%\([a-zA-Z0-9_]+\)s/);
          // Same reasoning as the trim() check on the msgids themselves: a
          // msgstr with a trailing newline from a hand-edited .po survives
          // into the <option> label.
          expect(catalogue[msgid]!.trim(), `${locale}'s "${msgid}" has stray whitespace`).toBe(catalogue[msgid]);
        }
      }),
    );
  });

  it("really is translated, apart from 'Pasta', which is the same word everywhere", () => {
    // The catalogue-key test above passes even for a catalogue regenerated
    // with English stubs, which is the realistic failure: msgstrs copied
    // from msgids, dropdown silently English in all four languages. So also
    // require the strings to actually change -- with the one honest
    // exception, "Pasta", whose Welsh, Irish and Gaelic translations are all
    // the word "Pasta". Documenting it here means a future translator who
    // changes it sees a test to update rather than a mystery.
    const nonEnglish = LOCALES.filter((locale) => locale !== "en");
    return Promise.all(
      nonEnglish.map(async (locale) => {
        const catalogue = await loadCatalogue(locale);
        const untranslated = ITEM_CATEGORIES.filter((msgid) => translate(catalogue, msgid) === msgid);
        expect(untranslated, `${locale} dropdown labels left in English`).toEqual(["Pasta"]);
      }),
    );
  });

  it("passes through untouched on English, where there is no catalogue", () => {
    // loadCatalogue("en") returns {} by design (i18n.ts:25) -- an early
    // return, not a missing-file fallback; i18n.ts's LOADERS map has no "en"
    // key at all. So the English dropdown renders the msgid itself. That is
    // the intended path, not a degradation, and it is why these entries have
    // to stay readable English labels that also happen to be the exact DB
    // column values.
    const english: Locale = "en";
    expect(LOCALES).toContain(english);
    return loadCatalogue(english).then((catalogue) => {
      expect(catalogue).toEqual({});
      for (const msgid of ITEM_CATEGORIES) {
        expect(translate(catalogue, msgid)).toBe(msgid);
        // The value half of the <option> is the untranslated string in every
        // locale -- only the label goes through _(). Both being identical
        // on English is what makes `{% if item_category == cat_value %}`
        // (index.njk:190) select the right option on a round trip.
        expect(ITEM_CATEGORIES.includes(translate(catalogue, msgid))).toBe(true);
      }
    });
  });
});
