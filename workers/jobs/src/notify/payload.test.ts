import { describe, expect, it } from "vitest";
import type { FoodbankNotifyTarget } from "@givefood/db";
import { buildFirebasePayload, buildWebPushPayload, NOTIFICATION_ICON, type NeedNotificationPayload } from "./payload";

// This module writes the words a phone actually shows on its lock screen when
// a food bank publishes a need. Nothing downstream reviews them: needFirebase
// posts the title/body straight to FCM and needWebPush encrypts them into an
// RFC 8291 envelope, so a wrong count or a body truncated mid-word ships to
// every subscribed device with no human in the loop and no error anywhere.
// That is the failure class these tests exist for -- the send path is silent
// on success AND on nonsense.
//
// Every expectation below was checked against the Django ancestor the module
// cites, givefood/utils/notifications.py -- send_firebase_notification()
// (lines 189-236, title at 206, `max_body_bytes = 4000` at 215) and
// _build_webpush_payload() (302-343, title at 313, `max_body_chars = 200` at
// 319). The two truncation loops there were transcribed verbatim into a
// scratch script and RUN under the CPython on this machine (3.13.0) for every
// fixture used here, rather than reasoned about: the ", ".join()-and-remeasure
// shape has two edge cases (a leading blank item, and code points above the
// BMP) where reading the code and running it give different answers. Both are
// pinned below as DIVERGENCES, with the port's actual output asserted.
//
// The citations were re-grepped during an adversarial review pass and two were
// off by a line or three (the web push length check is at :329, not :328; the
// icon constants at :252-253 and :340, not :249-250 and :337, which is what
// the module's own header says). They are corrected where they appear. The
// loops were re-run in CPython 3.13.0 for the fixtures that review added --
// the 40- and 200-item lists, the lone over-budget item, the lower-case
// sentinel and the newline-only need text -- and a THIRD divergence surfaced,
// pinned with the other two.
//
// That review also mutation-tested the module in a copy of the repo outside
// the working tree: 93 mutants, 92 killed. The one survivor is
// `encodeURIComponent(foodbank.slug)` in the link, which is an equivalent
// mutant -- Foodbank.slug is `slugify(self.name)`
// (givefood/models/foodbank.py:634) and encodeURIComponent is the identity on
// everything Django's slugify() can emit. Eight OTHER mutants survived the
// original suite and are named in the tests written to kill them, so a later
// reader can see which failure each assertion is standing in front of.

const DOMAIN = "https://www.givefood.org.uk";

// The three fields getFoodbankNotifyTarget() selects, and nothing else --
// this builder is deliberately given a narrow row, not a whole food bank.
const SALISBURY: FoodbankNotifyTarget = {
  uuid: "11112222333344445555666677778888",
  slug: "salisbury",
  name: "Salisbury",
};

// ===========================================================================
// The common path: what both channels build for a normal published need
// ===========================================================================

describe("both builders, on an ordinary need", () => {
  const NEED = "Tinned fish\nUHT milk\nNappies (size 5)\nWashing up liquid";

  it("builds the exact title, body and link a subscriber sees", () => {
    // The whole message, asserted as one literal rather than field-by-field
    // shape checks, because every part of it is load-bearing: the count in the
    // title, the ", " separator (NOT ",", NOT " / "), the item order, and an
    // absolute link that must survive being handed to FCM's fcm_options.link
    // and to a service worker's notificationclick handler. CPython on this
    // machine returns exactly this body for both loops.
    expect(buildFirebasePayload(SALISBURY, NEED, DOMAIN)).toEqual({
      title: "Salisbury needs 4 items",
      body: "Tinned fish, UHT milk, Nappies (size 5), Washing up liquid",
      url: "https://www.givefood.org.uk/needs/at/salisbury/",
    });
  });

  it("gives web push the identical payload when nothing needs truncating", () => {
    // 57 characters, far inside both budgets. The two channels are ONE builder
    // with one differing limit, and that is only defensible while they agree
    // below the limits -- if they ever stop agreeing, subscribers to the same
    // food bank on two transports get two different shopping lists.
    expect(buildWebPushPayload(SALISBURY, NEED, DOMAIN)).toEqual(buildFirebasePayload(SALISBURY, NEED, DOMAIN));
  });

  it("returns those three keys and no others", () => {
    // needWebPush spreads this into django-webpush's own dict shape (`head`,
    // not `title`) and needFirebase into FCM's. A stray extra key here would
    // be silently dropped by one and silently forwarded by the other.
    const payload: NeedNotificationPayload = buildFirebasePayload(SALISBURY, NEED, DOMAIN);
    expect(Object.keys(payload).sort()).toEqual(["body", "title", "url"]);
  });
});

// ===========================================================================
// Title
// ===========================================================================

describe("title", () => {
  it("uses foodbank.name, not the slug and not the uuid", () => {
    // notifications.py:206 and :313 both interpolate `need.foodbank.name`,
    // while send_need_email's subject (notifications.py:47) uses full_name()
    // -- which is `"%s %s" % (self.name, _("Foodbank"))` at
    // givefood/models/foodbank.py:269. So a food bank named "King's Lynn
    // Foodbank" emails as "... Foodbank Foodbank" and pushes as plain
    // "King's Lynn Foodbank". The asymmetry is Django's; a well-meaning
    // harmonisation would change the text on every subscribed device.
    //
    // The row here deliberately has a name, a slug and a uuid that share no
    // characters. MUTANT "title: `${foodbank.slug} needs ...`" survives any
    // fixture whose name equals its slug, and against the shared SALISBURY
    // row it dies only on the capital S of "Salisbury" vs "salisbury" --
    // one keystroke of margin. The link is asserted from the same call so
    // the two fields cannot be quietly transposed either way.
    const kingsLynn: FoodbankNotifyTarget = {
      uuid: "aaaabbbbccccddddeeeeffff00001111",
      slug: "kings-lynn",
      name: "King's Lynn Foodbank",
    };
    const payload = buildFirebasePayload(kingsLynn, "Beans", DOMAIN);
    expect(payload.title).toBe("King's Lynn Foodbank needs 1 items");
    expect(payload.url).toBe("https://www.givefood.org.uk/needs/at/kings-lynn/");
    // Same row through the other channel: the two builders share one title
    // expression, and this is what proves it rather than assuming it.
    expect(buildWebPushPayload(kingsLynn, "Beans", DOMAIN).title).toBe("King's Lynn Foodbank needs 1 items");
  });

  it("reports the RAW count, where the email subject spells one-to-nine as words", () => {
    // needEmail.ts runs no_items() through apnumber() ("four items"); these
    // two channels do not ("4 items"). Django's own inconsistency, checked at
    // all three call sites. Note "1 items" -- never "1 item"; Django has no
    // pluralisation here and neither does the port.
    expect(buildWebPushPayload(SALISBURY, "Beans", DOMAIN).title).toBe("Salisbury needs 1 items");
    expect(buildWebPushPayload(SALISBURY, "Beans\nRice\nPasta", DOMAIN).title).toBe("Salisbury needs 3 items");
  });

  it("counts blank lines as items, exactly as no_items() does", () => {
    // no_items() is `len(change_text.split("\n"))` with no filtering, so a
    // need text with a stray blank line claims one more item than a human
    // would count -- and the body below shows the empty item as ", ,". Both
    // halves are asserted together because they come from the same raw split:
    // a "tidy-up" that filtered blanks in one and not the other would produce
    // a notification whose count contradicts its own body.
    const payload = buildFirebasePayload(SALISBURY, "Beans\n\nRice", DOMAIN);
    expect(payload.title).toBe("Salisbury needs 3 items");
    expect(payload.body).toBe("Beans, , Rice");
  });

  it('says "0 items" for the Unknown/Nothing sentinels while showing the sentinel as the body', () => {
    // The module's own header flags this and it is real: no_items()
    // special-cases the two sentinels to 0, change_list() does not special-case
    // anything, so the notification reads "Salisbury needs 0 items" with the
    // word "Nothing" underneath it. Django sends exactly this today (verified
    // by running the transcribed loop), and the admin only offers Notify on a
    // need a human has published, so it is pinned rather than papered over.
    expect(buildFirebasePayload(SALISBURY, "Nothing", DOMAIN)).toMatchObject({
      title: "Salisbury needs 0 items",
      body: "Nothing",
    });
    expect(buildWebPushPayload(SALISBURY, "Unknown", DOMAIN)).toMatchObject({
      title: "Salisbury needs 0 items",
      body: "Unknown",
    });

    // ...and the sentinel test is CASE-SENSITIVE, in Django and here:
    // `change_text in ["Unknown", "Nothing"]` is an equality check, not a
    // casefold. A need text of "nothing" typed in lower case by an admin is
    // an ordinary one-item need. Confirmed by running no_items() in CPython
    // 3.13.0 on this machine: 1, not 0. This kills MUTANT
    // "noItems(changeText.toLowerCase())", which would otherwise only be
    // caught incidentally by the two capitalised cases above.
    expect(buildFirebasePayload(SALISBURY, "nothing", DOMAIN)).toMatchObject({
      title: "Salisbury needs 1 items",
      body: "nothing",
    });

    // "Facebook" is the THIRD sentinel -- and no_items() does not know about
    // it. givefood/models/needs.py:93-97 tests only "Unknown" and "Nothing",
    // while the three-sentinel form `in ["Facebook", "Unknown", "Nothing"]`
    // appears at needs.py:219 and foodbank.py:184/405. So a food bank whose
    // needs live on Facebook pushes as "Salisbury needs 1 items" over the
    // literal body "Facebook".
    //
    // This kills MUTANT `changeText === "Facebook" ? 0 : noItems(changeText)`
    // -- a harmonisation any reader might make on noticing the two sentinel
    // lists side by side, and one that passed all 34 other tests here. It is
    // pinned, not fixed: the count is Django's and the fix belongs in
    // @givefood/models with its own parity argument, not in the send path.
    expect(buildWebPushPayload(SALISBURY, "Facebook", DOMAIN)).toMatchObject({
      title: "Salisbury needs 1 items",
      body: "Facebook",
    });
  });

  it('says "1 items" with an empty body for empty need text', () => {
    // "".split("\n") is [""] in BOTH languages -- confirmed in CPython 3.13.0
    // on this machine, not assumed -- so an empty need text counts as one
    // item and renders as nothing. It is a wart, but it is a SHARED wart, and
    // a port that "fixed" it to 0 would diverge from the live site.
    expect(buildFirebasePayload(SALISBURY, "", DOMAIN)).toMatchObject({
      title: "Salisbury needs 1 items",
      body: "",
    });
  });

  it("puts the name in verbatim, including the apostrophes real food banks have", () => {
    // No escaping, no HTML entity encoding: this string is JSON-serialised
    // into an FCM message and into an encrypted push body, never into markup.
    // A helpful `escape()` added here would show "St Paul&#39;s" on the lock
    // screen of every subscriber.
    const stPauls: FoodbankNotifyTarget = { ...SALISBURY, name: "St Paul's & St George's" };
    expect(buildFirebasePayload(stPauls, "Beans", DOMAIN).title).toBe("St Paul's & St George's needs 1 items");
  });
});

// ===========================================================================
// url
// ===========================================================================

describe("url", () => {
  it("is the food bank's public needs page, built from the slug", () => {
    // `f"{SITE_DOMAIN}{reverse('wfbn:foodbank', kwargs={'slug': ...})}"`.
    // SITE_DOMAIN is "https://www.givefood.org.uk" in both trees
    // (givefood/const/general.py:149 and workers/jobs/wrangler.jsonc).
    expect(buildFirebasePayload({ ...SALISBURY, slug: "devizes" }, "Beans", DOMAIN).url).toBe(
      "https://www.givefood.org.uk/needs/at/devizes/",
    );
  });

  it("builds from the SLUG, never the uuid", () => {
    // The uuid on this row is for the Firebase TOPIC (`foodbank-{uuid}`, in
    // needFirebase.ts), not the link. Two fields of the same narrow row, one
    // character apart in the type -- a mutant that reached for the wrong one
    // would still produce a plausible-looking absolute URL that 404s on every
    // tap.
    const payload = buildWebPushPayload(SALISBURY, "Beans", DOMAIN);
    expect(payload.url).toBe("https://www.givefood.org.uk/needs/at/salisbury/");
    expect(payload.url).not.toContain(SALISBURY.uuid);
  });

  it("uses the un-prefixed English path, not a locale-prefixed one", () => {
    // url() rather than urlForLocale(): a push notification has no request and
    // no active language, exactly as Django's reverse() here runs outside any
    // i18n context. "/cy/needs/at/..." would be wrong for the majority of
    // subscribers and is what an over-eager i18n pass would introduce.
    expect(buildFirebasePayload(SALISBURY, "Beans", DOMAIN).url).toBe(`${DOMAIN}/needs/at/salisbury/`);
  });

  it("concatenates the domain verbatim -- a trailing slash makes a double slash", () => {
    // SUSPECT, pinned as-is: nothing normalises the join, so misconfiguring
    // SITE_DOMAIN with a trailing slash yields ".../\/needs/at/...". Django
    // has the identical f-string and the identical exposure; the real defence
    // is that both trees hard-code the value. Asserted so that if anyone adds
    // normalisation, they do it knowing this was the previous behaviour.
    expect(buildFirebasePayload(SALISBURY, "Beans", "https://www.givefood.org.uk/").url).toBe(
      "https://www.givefood.org.uk//needs/at/salisbury/",
    );
  });
});

// ===========================================================================
// Firebase body: a 4,000 BYTE budget
// ===========================================================================

describe("buildFirebasePayload -- the 4,000 byte budget", () => {
  it("keeps a list that is over 200 characters but far under 4,000 bytes", () => {
    // 304 characters. This is the test that fails if someone gives Firebase
    // the web push limit: 300-odd bytes of items is an ordinary long need
    // list, and truncating it to one item would quietly halve what most
    // subscribers see without erroring anywhere.
    const need = `${"a".repeat(100)}\n${"b".repeat(100)}\n${"c".repeat(100)}`;
    const body = buildFirebasePayload(SALISBURY, need, DOMAIN).body;
    expect(body.length).toBe(304);
    expect(body).toBe(`${"a".repeat(100)}, ${"b".repeat(100)}, ${"c".repeat(100)}`);
  });

  it("accepts a body of exactly 4,000 bytes", () => {
    // The comparison is `len(...) <= max_body_bytes` at notifications.py:227
    // and `> budget` -> break here: both admit exactly 4,000. An off-by-one to
    // `>=` would silently drop the last item of any list that lands on the
    // boundary. CPython 3.13.0 returns a 4,000-character body for this input.
    //
    // The CONTENT is asserted, not just the length: a length-only assertion
    // passes for any 4,000-character string, so MUTANT "separator ', '
    // becomes ' ,'" -- a plausible typo that preserves length exactly -- would
    // have walked straight through this test.
    const need = `${"a".repeat(3997)}\nb`;
    const body = buildFirebasePayload(SALISBURY, need, DOMAIN).body;
    expect(body).toBe(`${"a".repeat(3997)}, b`);
    expect(body.length).toBe(4000);
  });

  it("drops the whole item that would take it to 4,001 bytes", () => {
    // One byte over. The dropped item goes entirely -- the body is the 3,998
    // 'a's alone, with no dangling ", " and no partial item. CPython: 3,998.
    const need = `${"a".repeat(3998)}\nb`;
    const body = buildFirebasePayload(SALISBURY, need, DOMAIN).body;
    expect(body).toBe("a".repeat(3998));
    expect(body.endsWith(", ")).toBe(false);
  });

  it("measures UTF-8 BYTES, not characters", () => {
    // 3,991 ASCII + ", " + four '£' = 3,997 CHARACTERS but 4,001 BYTES, so
    // the '£' item is dropped. This is the mutant-killer for byteLength ->
    // charLength on the Firebase side: FCM rejects an oversized payload
    // outright, so a body measured in characters would produce a 400 from
    // Google for exactly the food banks with accented or currency-marked
    // items, and needFirebase logs that failure to a console nobody reads.
    // CPython on this machine returns the bare 3,991 'a's for this input.
    const need = `${"a".repeat(3991)}\n${"£".repeat(4)}`;
    expect(buildFirebasePayload(SALISBURY, need, DOMAIN).body).toBe("a".repeat(3991));

    // One character earlier the same item fits exactly: 3,990 + 2 + 8 = 4,000
    // bytes. Both sides of the boundary, so the test cannot pass by simply
    // rejecting everything multi-byte.
    const fits = `${"a".repeat(3990)}\n${"£".repeat(4)}`;
    expect(buildFirebasePayload(SALISBURY, fits, DOMAIN).body).toBe(`${"a".repeat(3990)}, ${"£".repeat(4)}`);
    expect(new TextEncoder().encode(buildFirebasePayload(SALISBURY, fits, DOMAIN).body).length).toBe(4000);
  });
});

// ===========================================================================
// Web push body: a 200 CHARACTER budget
// ===========================================================================

describe("buildWebPushPayload -- the 200 character budget", () => {
  it("truncates at 200 characters where Firebase would keep everything", () => {
    // Same 304-character need as the Firebase test above: web push keeps only
    // the first item, because adding the second would make 202. The pair of
    // tests is what pins the two budgets to the right builders -- either one
    // alone would survive a swap.
    const need = `${"a".repeat(100)}\n${"b".repeat(100)}\n${"c".repeat(100)}`;
    expect(buildWebPushPayload(SALISBURY, need, DOMAIN).body).toBe("a".repeat(100));
    // Content on the contrasting side too, not just its length: the whole
    // value of this test is that the SAME input produces two different bodies,
    // and ".length is 304" is satisfied by any 304 characters at all.
    expect(buildFirebasePayload(SALISBURY, need, DOMAIN).body).toBe(
      `${"a".repeat(100)}, ${"b".repeat(100)}, ${"c".repeat(100)}`,
    );
  });

  it("accepts a body of exactly 200 characters and drops the item that makes 201", () => {
    // Django's `len(test_body) <= max_body_chars` at notifications.py:329.
    // CPython 3.13.0 returns 200 and 198 for these two inputs respectively.
    // Content, not just length, for the same reason as the 4,000-byte
    // boundary above: a length-only assertion cannot see a separator typo.
    const onTheLine = buildWebPushPayload(SALISBURY, `${"a".repeat(197)}\nb`, DOMAIN).body;
    expect(onTheLine).toBe(`${"a".repeat(197)}, b`);
    expect(onTheLine.length).toBe(200);
    expect(buildWebPushPayload(SALISBURY, `${"a".repeat(198)}\nb`, DOMAIN).body).toBe("a".repeat(198));
  });

  it("measures CHARACTERS, not bytes", () => {
    // 150 '£' is 150 characters but 300 bytes; the item after it still fits,
    // giving a 153-character body that a byte-measuring implementation would
    // have refused outright. Confirmed at 153 in CPython. Together with the
    // Firebase byte test this makes measure() unswappable between the two
    // builders -- and the web push limit is about what a notification shade
    // can SHOW, so measuring it in bytes would visibly shorten notifications
    // for every non-ASCII item.
    const body = buildWebPushPayload(SALISBURY, `${"£".repeat(150)}\nb`, DOMAIN).body;
    expect(body).toBe(`${"£".repeat(150)}, b`);
    expect(body.length).toBe(153);
    expect(new TextEncoder().encode(body).length).toBe(303);
  });
});

// ===========================================================================
// MANY items, rather than a few enormous ones
//
// Every budget test above reaches its limit with two or three multi-kilobyte
// items, which is the shape a fixture takes when you are writing a boundary
// test -- and it is not the shape real need text takes. A published need is
// twenty to forty short lines. That gap let a whole family of mutants through
// a 29-test suite untouched:
//
//   changeList(changeText).slice(0, 10)                   -- a per-item cap
//   changeList(changeText).slice(0, 8) / .slice(0, 25)    -- ditto, any N
//   `if (n++ >= 10) break;` inside joinWithinBudget       -- an iteration cap
//   changeList(changeText).filter((_, i) => i % 10 !== 9) -- an index filter
//   `length > 10 ? [...new Set(items)] : items`           -- a "long list" case
//   `length > 10 ? items.slice(0, -1) : items`            -- ditto
//
// All six passed 29/29, because no assertion anywhere kept more than three
// items in a Firebase body. The failure they model is the quiet one: the
// notification still arrives, still looks right, and is missing items the
// food bank asked for. The two fixtures below run the real loop over 40 and
// 200 short items, which is what makes those mutants die.
// ===========================================================================

describe("long, ordinary need lists", () => {
  // A real Salisbury-shaped shopping list: 40 short lines, 520 characters
  // joined. Comfortably inside the 4,000-byte Firebase budget and well past
  // the 200-character web push one, so one fixture exercises both sides.
  // None of the items contains ", ", which is what makes splitting the body
  // back on ", " a sound check rather than a lucky one.
  const LONG_LIST = [
    "Tinned fish",
    "UHT milk",
    "Nappies (size 5)",
    "Washing up liquid",
    "Tinned tomatoes",
    "Long life fruit juice",
    "Instant mash",
    "Tinned custard",
    "Rice pudding",
    "Jam",
    "Tinned spaghetti",
    "Sponge pudding",
    "Squash",
    "Coffee",
    "Sugar",
    "Tinned meat",
    "Tinned fruit",
    "Cereal",
    "Pasta sauce",
    "Biscuits",
    "Shampoo",
    "Shower gel",
    "Toothpaste",
    "Deodorant",
    "Washing powder",
    "Toilet roll",
    "Nappies (size 4)",
    "Baby wipes",
    "Baby food",
    "Tinned soup",
    "Tea bags",
    "Peanut butter",
    "Chocolate spread",
    "Dried pasta",
    "Rice",
    "Cooking oil",
    "Tinned potatoes",
    "Tinned carrots",
    "Crisps",
    "Hot chocolate",
  ];
  const LONG_NEED = LONG_LIST.join("\n");

  it("keeps ALL forty items in the Firebase body, in order, with nothing dropped", () => {
    // The whole point of the 4,000-byte budget: an ordinary long list must
    // survive it intact. Asserted as full equality against the join, so any
    // cap, any index filter and any per-item rewrite shows up -- and the
    // split-back assertion names each of the forty individually, so a mutant
    // that dropped, reordered or merged one is reported as which item rather
    // than as a length mismatch.
    const payload = buildFirebasePayload(SALISBURY, LONG_NEED, DOMAIN);
    expect(payload.body).toBe(LONG_LIST.join(", "));
    expect(payload.body.split(", ")).toEqual(LONG_LIST);
    expect(payload.body.length).toBe(520);
    // Well under budget, so nothing here is a boundary accident.
    expect(new TextEncoder().encode(payload.body).length).toBe(520);
    expect(payload.title).toBe("Salisbury needs 40 items");
    // The transcribed Django loop, run in CPython 3.13.0 on this machine,
    // returns this same 520-character body and no_items() returns 40.
  });

  it("cuts the same list at fourteen items for web push", () => {
    // 197 characters: fourteen items and thirteen separators. The fifteenth
    // ("Sugar") would make 204. Same fixture, same order, different budget --
    // which is what pins the ONE builder's two callers apart on realistic
    // input rather than only on 4,000-byte monsters. CPython's
    // _build_webpush_payload loop stops in the same place on this fixture.
    const body = buildWebPushPayload(SALISBURY, LONG_NEED, DOMAIN).body;
    expect(body).toBe(LONG_LIST.slice(0, 14).join(", "));
    expect(body.split(", ")).toEqual(LONG_LIST.slice(0, 14));
    expect(body.length).toBe(197);
    // ...and the title still counts every item the food bank published, not
    // the fourteen that fitted.
    expect(buildWebPushPayload(SALISBURY, LONG_NEED, DOMAIN).title).toBe("Salisbury needs 40 items");
  });

  it("truncates a 200-item list at exactly 125 items for Firebase", () => {
    // 200 items of 30 characters each. 125 items plus 124 separators is
    // 3,998 bytes; a 126th would be 4,030. This is the only test in the file
    // where the Firebase loop iterates more than a handful of times, so it
    // is the one that distinguishes "stops because of the BYTE budget" from
    // "stops because of some count". CPython: 125 items, 3,998 characters.
    const items = Array.from({ length: 200 }, (_, i) => `Item ${String(i).padStart(3, "0")} ${"x".repeat(21)}`);
    const payload = buildFirebasePayload(SALISBURY, items.join("\n"), DOMAIN);
    expect(payload.body).toBe(items.slice(0, 125).join(", "));
    expect(payload.body.split(", ")).toHaveLength(125);
    expect(payload.body.length).toBe(3998);
    // The last kept item is whole -- no partial "Item 124 xxxx" tail.
    expect(payload.body.endsWith("Item 124 xxxxxxxxxxxxxxxxxxxxx")).toBe(true);
    // ...and the first dropped one appears nowhere.
    expect(payload.body).not.toContain("Item 125");
    expect(payload.title).toBe("Salisbury needs 200 items");

    // The same list on web push keeps six -- 190 characters, a seventh would
    // be 220. Both channels walking the same 200 items to different depths is
    // what makes a shared cap impossible to hide.
    const wp = buildWebPushPayload(SALISBURY, items.join("\n"), DOMAIN).body;
    expect(wp).toBe(items.slice(0, 6).join(", "));
    expect(wp.length).toBe(190);
  });

  it("keeps duplicates in a long list, not only in a short one", () => {
    // The dedup test further down uses three items. MUTANT
    // "length > 10 ? [...new Set(items)] : items" -- a cleanup applied only
    // to lists long enough to look messy -- survives that one and every other
    // test in the file, because no long fixture repeats an item. This one
    // does: "Tinned fish" appears twice, twelve items apart.
    const withRepeat = [...LONG_LIST.slice(0, 12), "Tinned fish", "Tea bags"];
    const body = buildFirebasePayload(SALISBURY, withRepeat.join("\n"), DOMAIN).body;
    expect(body).toBe(withRepeat.join(", "));
    expect(body.split(", ").filter((i) => i === "Tinned fish")).toHaveLength(2);
    expect(buildFirebasePayload(SALISBURY, withRepeat.join("\n"), DOMAIN).title).toBe("Salisbury needs 14 items");
  });
});

// ===========================================================================
// The truncation loop itself -- shared by both channels
// ===========================================================================

describe("truncation semantics", () => {
  it("stops at the first item that does not fit, and never resumes", () => {
    // BREAK, not continue -- Django's loop and this one both give up entirely
    // rather than skipping the oversized item and packing later ones. So a
    // single 4,001-byte item silences the ENTIRE body, including the ordinary
    // items behind it. Verified in CPython: current_body is ''.
    //
    // Pinned, not fixed: a "smarter" packer that skipped and continued would
    // reorder what subscribers see relative to the live Django site, and this
    // module's whole contract is parity with it.
    const need = `${"a".repeat(4001)}\nBeans\nRice`;
    expect(buildFirebasePayload(SALISBURY, need, DOMAIN).body).toBe("");
    // ...while the title still counts all three. A notification that says
    // "needs 3 items" with an empty body is what production would send.
    expect(buildFirebasePayload(SALISBURY, need, DOMAIN).title).toBe("Salisbury needs 3 items");
  });

  it("empties the body when the need is a SINGLE item that does not fit", () => {
    // There is no "keep at least one" floor in either language: a need text
    // of one line that busts the budget notifies with a completely empty
    // body. Every other truncation test here has an item before or after the
    // oversized one, so MUTANT "if (items.length === 1) return items[0];" --
    // exactly the special case a reader might add on seeing a blank
    // notification in the wild -- passed the whole suite untouched.
    //
    // CPython 3.13.0, transcribed loop: current_body is '' for both.
    expect(buildFirebasePayload(SALISBURY, "a".repeat(4001), DOMAIN)).toMatchObject({
      title: "Salisbury needs 1 items",
      body: "",
    });
    expect(buildWebPushPayload(SALISBURY, "a".repeat(201), DOMAIN).body).toBe("");

    // ...and the SAME 201-character lone item sails through Firebase, whose
    // budget it is nowhere near. The pair is what stops a "keep at least one
    // item" floor being added to the shared loop rather than to one caller.
    expect(buildFirebasePayload(SALISBURY, "a".repeat(201), DOMAIN).body).toBe("a".repeat(201));
  });

  it("truncates only at item boundaries, never mid-item", () => {
    // The reason the loop re-joins candidates instead of slicing the finished
    // string. Twenty 30-character items against the 200-char web push budget:
    // whatever survives must be a whole number of items, because a body cut
    // mid-word ("...Nappies (siz") is the visible symptom users would report
    // and nobody could reproduce from the logs.
    const items = Array.from({ length: 20 }, (_, i) => `Item ${String(i).padStart(2, "0")} ${"x".repeat(23)}`);
    const body = buildWebPushPayload(SALISBURY, items.join("\n"), DOMAIN).body;
    const kept = body.split(", ");
    // Six 31-character items plus five separators is 196; a seventh would be
    // 229. CPython's loop stops in the same place on the same fixture.
    expect(kept.length).toBe(6);
    expect(body.length).toBe(196);
    for (const piece of kept) expect(items).toContain(piece);
    // ...and they are the FIRST six, in order: nothing sorts or reverses.
    expect(body).toBe(items.slice(0, 6).join(", "));
  });

  it("preserves item order and does not deduplicate", () => {
    // change_list() is a raw split. Duplicates in a need text are a data
    // problem for the admin, not something the send path silently tidies --
    // and a Set-based "cleanup" here would also destroy the ordering that the
    // truncation above depends on.
    expect(buildFirebasePayload(SALISBURY, "Beans\nRice\nBeans", DOMAIN)).toMatchObject({
      title: "Salisbury needs 3 items",
      body: "Beans, Rice, Beans",
    });
  });

  it("does not trim whitespace inside or around items", () => {
    // Neither change_list() nor the join strips anything, so a trailing blank
    // line becomes a trailing ", " on the body. CPython returns
    // 'Beans, Rice, ' for this need text -- the port matches exactly.
    expect(buildWebPushPayload(SALISBURY, "Beans\nRice\n", DOMAIN).body).toBe("Beans, Rice, ");
    expect(buildWebPushPayload(SALISBURY, "  Beans  \nRice", DOMAIN).body).toBe("  Beans  , Rice");
  });

  it("leaves a stray CR attached to its item, exactly as Python's split does", () => {
    // Need text scraped from a Windows-authored page can carry \r\n. Both
    // languages split on "\n" only, so the \r rides along inside the item.
    // Confirmed by running the transcribed loop in CPython: 'Beans\r, Rice'.
    // Asserting it means a future .trim() cannot be added without someone
    // deliberately deciding to diverge from the live site.
    expect(buildFirebasePayload(SALISBURY, "Beans\r\nRice", DOMAIN).body).toBe("Beans\r, Rice");
  });
});

// ===========================================================================
// Known divergences from Django -- asserted as the port behaves, NOT as
// Django behaves. Both were found by running notifications.py's loops, not
// by reading them.
// ===========================================================================

describe("divergences from notifications.py (pinned, not fixed)", () => {
  it("DIVERGES: a leading blank line loses its separator here but keeps it in Django", () => {
    // Django tracks `body_items` (a list) to decide whether to prefix the
    // separator; this port tracks the joined string and tests it for
    // TRUTHINESS. After a leading empty item those disagree: Django's list is
    // non-empty while the port's accumulator is still "".
    //
    //   need text "\nBeans\nRice"
    //   Django  (run in CPython 3.13.0 on this machine) -> ", Beans, Rice"
    //   port                                            -> "Beans, Rice"
    //
    // The port's output is the nicer of the two, which is exactly why this is
    // pinned rather than reported as fixed: it is a real behavioural
    // difference from the live site for any need text whose first line is
    // blank, and change_list() does no blank filtering, so such text reaches
    // here. Asserted as the port behaves.
    expect(buildFirebasePayload(SALISBURY, "\nBeans\nRice", DOMAIN).body).toBe("Beans, Rice");
    expect(buildWebPushPayload(SALISBURY, "\nBeans\nRice", DOMAIN).body).toBe("Beans, Rice");
    // The count still includes the blank line, so the title says 3.
    expect(buildFirebasePayload(SALISBURY, "\nBeans\nRice", DOMAIN).title).toBe("Salisbury needs 3 items");

    // A blank line anywhere OTHER than first behaves identically in both --
    // 'Beans, , Rice' in CPython and here -- which is what localises the
    // divergence to the first-item case rather than to blank lines generally.
    expect(buildFirebasePayload(SALISBURY, "Beans\n\nRice", DOMAIN).body).toBe("Beans, , Rice");

    // The degenerate form of the same divergence, and the one most likely to
    // reach production: a need text that is nothing but a newline.
    //
    //   Django (CPython 3.13.0, run here) -> ", "   (two blank items joined)
    //   port                              -> ""     (accumulator never leaves "")
    //
    // Both count 2 items, so the port sends "Salisbury needs 2 items" with an
    // empty body where the live site sends the same title over a body of a
    // comma and a space. Asserted as the port behaves.
    expect(buildFirebasePayload(SALISBURY, "\n", DOMAIN)).toMatchObject({
      title: "Salisbury needs 2 items",
      body: "",
    });
    expect(buildWebPushPayload(SALISBURY, "\n", DOMAIN).body).toBe("");
  });

  it("DIVERGES: web push counts UTF-16 units, where Python counts code points", () => {
    // The module's header calls the web push limit "JS/Python CHARACTERS",
    // and for the BMP that holds. Above it -- emoji, which food banks do put
    // in need lists -- it does not: "🍎" is one code point to Python's len()
    // and TWO to JavaScript's .length.
    //
    //   100 apples then "Beans", against the 200 budget
    //   Django (CPython 3.13.0, run here) -> 100 + 2 + 5 = 107 -> keeps "Beans"
    //   port                              -> 200 + 2 + 5 = 207 -> drops it
    //
    // So the port truncates emoji-heavy lists roughly twice as early as the
    // live site. Pinned as the port behaves; reported as a divergence rather
    // than corrected here, because the fix ([...s].length) is a source change.
    const apples = "🍎".repeat(100);
    expect(apples.length).toBe(200); // UTF-16 units; Python's len() says 100
    expect(buildWebPushPayload(SALISBURY, `${apples}\nBeans`, DOMAIN).body).toBe(apples);

    // Firebase is unaffected: it measures bytes, and TextEncoder and
    // str.encode('utf-8') agree on 4 bytes per apple in both languages.
    expect(buildFirebasePayload(SALISBURY, `${apples}\nBeans`, DOMAIN).body).toBe(`${apples}, Beans`);
    expect(new TextEncoder().encode(apples).length).toBe(400);
  });
});

// ===========================================================================
// NOTIFICATION_ICON
// ===========================================================================

describe("NOTIFICATION_ICON", () => {
  it("is the root-relative asset path both channels share", () => {
    // notifications.py:252-253 (Firebase icon AND badge) and :340 (the web
    // push payload's own "icon" key) -- the module's own header comment says
    // 249-250 and 337, which is three lines out in the tree on this machine;
    // the numbers here are the ones grep actually returns today.
    // Root relative on purpose: the service worker resolves it against the page
    // origin, so this one string works on www.givefood.org.uk, on a preview
    // deployment and on whatever the site is called next. An absolute URL
    // here would pin every already-delivered notification to today's domain.
    expect(NOTIFICATION_ICON).toBe("/static/img/notificationicon.svg");
    expect(NOTIFICATION_ICON.startsWith("/")).toBe(true);
    expect(NOTIFICATION_ICON.startsWith("http")).toBe(false);
  });

  it("is not accidentally folded into the payload", () => {
    // needFirebase puts it in webpush.notification.icon/badge and needWebPush
    // in the payload's own `icon` key; the builder itself must not add it, or
    // FCM's data map would carry a duplicate the service worker never reads.
    const payload = buildFirebasePayload(SALISBURY, "Beans", DOMAIN);
    expect(Object.values(payload)).not.toContain(NOTIFICATION_ICON);
  });
});
