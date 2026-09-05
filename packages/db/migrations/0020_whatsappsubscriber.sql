-- ==================== 0020_whatsappsubscriber.sql ========================
-- The one subscriber table this port never created.
--
-- FOUND 2026-09-05 while building the three unbuilt notification channels
-- (PLAN.md WP 6.4b). Three of the four subscriber tables already existed in
-- D1 -- mobilesubscriber, webpushsubscription, constituencysubscriber -- and
-- ALL FOUR were empty, because none of them is in tools/pg-to-d1/
-- extract_core.py's table lists. Postgres holds 49 / 49 / 51 / 53 rows.
--
-- So launching before this would have silently dropped 202 subscribers: the
-- mobile app users, the browser-push users, the WhatsApp users and the
-- write-to-your-MP constituency list. Nothing would have alerted -- the
-- tables would simply have been empty, and an empty table looks exactly
-- like a channel nobody uses.
--
-- Schema from givefood_whatsappsubscriber (givefood/models/general.py's
-- WhatsappSubscriber), column for column:
--
--   id, phone_number, foodbank_id, foodbank_name, created, last_notified
--
-- foodbank_name is NOT carried over, for the same reason migration 0019
-- dropped it everywhere else: it is a cached copy of the parent's name that
-- goes stale on a rename. Read it through a join. The other five columns are
-- as Postgres has them.
--
-- last_notified is the write WhatsappSubscriber gets on every successful
-- send (notifications.py:652-654), and it is an UPDATE to a row with no
-- watermark -- one of the five tables PLAN.md §10.8.1 flags for full reload
-- rather than delta sync at cutover.

CREATE TABLE whatsappsubscriber (
  id            INTEGER PRIMARY KEY,
  phone_number  TEXT NOT NULL,
  foodbank_id   INTEGER,
  created       TEXT,
  last_notified TEXT
);

-- The send path's only query: every subscriber for one food bank.
CREATE INDEX whatsappsubscriber_foodbank_idx ON whatsappsubscriber(foodbank_id);

-- Django has no unique constraint here, so a number can legitimately appear
-- against several different food banks -- and does: one number is
-- subscribed to 10. Not enforced, deliberately, to match the source.
--
-- CORRECTION 2026-09-05: this comment originally also claimed the same
-- (phone, foodbank) PAIR appears twice in production. Checked against the
-- loaded data while building the inbound subscribe/unsubscribe consumer,
-- and it does not -- there are zero duplicate pairs. The claim was wrong.
-- It matters because Django's _handle_unsubscribe uses `.get()` on that
-- pair and would raise MultipleObjectsReturned if one ever existed; see
-- workers/jobs/src/queues/whatsappHook.ts, which deletes every match
-- rather than one, so a future duplicate cannot take the webhook down.
