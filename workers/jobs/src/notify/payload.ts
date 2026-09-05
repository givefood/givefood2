import { changeList, noItems } from "@givefood/models";
import { url } from "@givefood/urls";
import type { FoodbankNotifyTarget } from "@givefood/db";

// The title/body/link the Firebase and web push channels both render, from
// send_firebase_notification() (notifications.py:206-236) and
// _build_webpush_payload() (notifications.py:302-343).
//
// The two are ALMOST the same and are kept as one builder with one
// differing limit, because the only real difference is where the item list
// is truncated: Firebase counts UTF-8 BYTES against a 4,000 budget, web
// push counts JS/Python CHARACTERS against 200. Both then truncate at an
// item boundary, never mid-item.
//
// TITLE USES foodbank.name, not full_name(). The email subject uses
// full_name() and these do not; that asymmetry is Django's, checked
// against all three call sites rather than harmonised.
//
// COUNT IS THE RAW NUMBER here (`{need.no_items()} items`), where the
// email subject spells one-to-nine as words via apnumber(). Also Django's.

export interface NeedNotificationPayload {
  title: string;
  body: string;
  url: string;
}

// Truncate a joined ", " list to fit a budget, dropping whole items.
// Django builds this by re-joining the candidate list on every iteration
// and measuring the result; reproduced as-is rather than optimised,
// because the join's separator is what makes the two measurements
// (bytes vs characters) land where they do.
function joinWithinBudget(items: readonly string[], budget: number, measure: (s: string) => number): string {
  let current = "";
  for (const item of items) {
    const candidate = current ? `${current}, ${item}` : item;
    if (measure(candidate) > budget) break;
    current = candidate;
  }
  return current;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;
const charLength = (s: string) => s.length;

// notifications.py:220 -- "Firebase has a 4KB limit ... we'll be
// conservative", i.e. 4,000 of the 4,096 bytes, leaving room for the rest
// of the message envelope.
const FIREBASE_BODY_BYTES = 4000;
// notifications.py:317's max_body_chars. Far below anything a push
// service enforces; it is about what a notification shade can show.
const WEBPUSH_BODY_CHARS = 200;

function build(
  foodbank: FoodbankNotifyTarget,
  changeText: string,
  siteDomain: string,
  budget: number,
  measure: (s: string) => number,
): NeedNotificationPayload {
  return {
    title: `${foodbank.name} needs ${noItems(changeText)} items`,
    // change_list(), the RAW split -- blank lines included, sentinels
    // ("Nothing"/"Unknown") not special-cased. no_items() above DOES
    // special-case the sentinels, so a "Nothing" need notifies as
    // "... needs 0 items" with the word "Nothing" as its body. That is
    // what Django sends today, and the admin only offers Notify on a need
    // a human has published, so it is a reviewer's decision, not a bug to
    // paper over here.
    body: joinWithinBudget(changeList(changeText), budget, measure),
    url: `${siteDomain}${url("wfbn:foodbank", foodbank.slug)}`,
  };
}

export function buildFirebasePayload(
  foodbank: FoodbankNotifyTarget,
  changeText: string,
  siteDomain: string,
): NeedNotificationPayload {
  return build(foodbank, changeText, siteDomain, FIREBASE_BODY_BYTES, byteLength);
}

export function buildWebPushPayload(
  foodbank: FoodbankNotifyTarget,
  changeText: string,
  siteDomain: string,
): NeedNotificationPayload {
  return build(foodbank, changeText, siteDomain, WEBPUSH_BODY_CHARS, charLength);
}

// Both channels point their icon and badge at the same asset
// (notifications.py:249-250, 337). A ROOT-RELATIVE path, exactly as
// Django has it: the service worker resolves it against the page origin,
// and an absolute URL here would break the moment the site moves domain.
export const NOTIFICATION_ICON = "/static/img/notificationicon.svg";
