-- 0138_demo_staff_phones.sql - CANONICAL forward-only. REQUIRES 0122 (trial demo seed, crew_members.is_demo).
--
-- In plain words:
--   The trial demo seed gives the three sample staff placeholder phones "+91 00000 001xx".
--   Those are not valid Indian mobile numbers, so a fresh trial's Staff page showed a red
--   "Invalid phone - please fix" on every demo row. This rewrites ONLY demo sample rows
--   (is_demo = true, not linked to an account, phone starting "+91 00000") to the
--   valid-looking dummy "+91 90000 001xx" (same last digits). Real staff rows are never
--   touched. No table, column or row is created or deleted.
--   (The app also hides the warning for demo rows, so trials seeded later look right too.)
-- Idempotent: a second run matches no rows (the new numbers no longer start "+91 00000").

update public.crew_members
   set phone = '+91 9' || substr(phone, 6)
 where is_demo is true
   and profile_id is null
   and phone like '+91 00000 %'
   and length(phone) = 15;
