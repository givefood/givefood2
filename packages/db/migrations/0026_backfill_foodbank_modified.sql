-- ================= 0026_backfill_foodbank_modified.sql ====================
-- Repairs foodbank.modified for the needs published before commit 550e091.
--
-- The site-wide "Last updated" footer is MAX(foodbank.modified)
-- (packages/db/src/frag.ts). On Django, publishing a need ran
-- foodbank.save(), whose auto_now bumped modified. Until 550e091 the port's
-- publish path never did, so every need published since the cutover left
-- its food bank's modified behind, and the footer read "6 days, 3 hours ago"
-- while needs were going live daily. The write sites are fixed in code
-- (needAdmin.ts's recomputeFoodbankNeedFields); this migration repairs what
-- they already missed.
--
-- A published need's own `modified` is stamped by the publish itself
-- (setNeedPublished), and afterwards only by edits to it, so it is the best
-- record of when that food bank's public needs last changed.
--
-- IDEMPOTENT and forward-only. It only ever moves modified LATER, never
-- earlier, so re-running matches nothing and a food bank edited after its
-- latest need keeps its own, newer timestamp. Both columns are in Django's
-- `YYYY-MM-DD HH:MM:SS.ffffff` form (0022), so `>` compares them correctly.

UPDATE "foodbank"
   SET "modified" = (
         SELECT MAX(c."modified") FROM "foodbankchange" c
          WHERE c."foodbank_id" = "foodbank"."id" AND c."published" = 1
       )
 WHERE (
         SELECT MAX(c."modified") FROM "foodbankchange" c
          WHERE c."foodbank_id" = "foodbank"."id" AND c."published" = 1
       ) > "modified";
