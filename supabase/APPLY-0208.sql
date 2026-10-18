-- APPLY-0208.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Empty draft quotes can be cleaned up again: the clean-up of EMPTY drafts (0141, Quotes page open + daily) moved
-- nothing, because the quotes check quotes_deleted_reason_chk (0040) did not allow its reason 'auto_empty_draft'.
-- This widens that check to every value it allows today + 'auto_empty_draft' (drop + add NOT VALID + VALIDATE in
-- one transaction). No row is written or deleted here; no other table, column, function or policy changes.
-- Safe to run twice (the 2nd run changes nothing). ASCII only. No edge function to redeploy.
begin;
-- 0208_quote_deleted_reason_auto_draft.sql - CANONICAL forward-only.
-- REQUIRES 0040 (quotes.deleted_reason + check quotes_deleted_reason_chk) and 0141 (empty-draft clean-up).
--
-- In plain words: the daily / on-open clean-up of EMPTY draft quotes (0141) has never moved anything to the
-- Deleted shelf, because it stamps deleted_reason = 'auto_empty_draft' and the 0040 check
-- quotes_deleted_reason_chk only allowed 'manual' and 'link_expired' (the update failed with 23514).
-- This widens that check to the SUPERSET: every value the live check allows today (read from the database,
-- so a value added there by hand is kept too) + 'auto_empty_draft'.
--   * Only runs when the live check does not allow 'auto_empty_draft' yet (the 2nd run changes nothing).
--   * Drop + re-add inside ONE transaction (no moment without the check), added NOT VALID and then
--     VALIDATEd: every existing row met the narrower check, so it meets the wider one.
--   * No row is read for change, written or deleted; no other table, column, function or policy changed.
-- Additive + idempotent. ASCII only.

do $$
declare v_def text; v_vals text[]; v_list text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'quotes_deleted_reason_chk' and c.conrelid = 'public.quotes'::regclass;
  if v_def is not null and v_def like '%''auto_empty_draft''%' then
    return;                                                    -- already widened
  end if;
  -- every quoted value the live check allows today (none when the check is missing)
  select coalesce(array_agg(distinct m[1]), '{}') into v_vals
    from regexp_matches(coalesce(v_def, ''), '''([^'']*)''', 'g') m;
  v_vals := array(select distinct x from unnest(v_vals || array['manual', 'link_expired', 'auto_empty_draft']) x order by x);
  select string_agg(quote_literal(x), ', ' order by x) into v_list from unnest(v_vals) x;
  alter table public.quotes drop constraint if exists quotes_deleted_reason_chk;
  execute format('alter table public.quotes add constraint quotes_deleted_reason_chk'
                 ' check (deleted_reason is null or deleted_reason in (%s)) not valid', v_list);
end $$;
alter table public.quotes validate constraint quotes_deleted_reason_chk;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 quotes_deleted_reason_chk allows manual, link_expired and auto_empty_draft (and empty)',
     exists (select 1 from pg_constraint c where c.conname = 'quotes_deleted_reason_chk' and c.conrelid = 'public.quotes'::regclass
              and pg_get_constraintdef(c.oid) like '%''auto_empty_draft''%' and pg_get_constraintdef(c.oid) like '%''manual''%'
              and pg_get_constraintdef(c.oid) like '%''link_expired''%' and pg_get_constraintdef(c.oid) ilike '%deleted_reason IS NULL%')),
  ('02 the check is validated and there is exactly one',
     (select count(*) from pg_constraint c where c.conname = 'quotes_deleted_reason_chk' and c.conrelid = 'public.quotes'::regclass
       and c.convalidated) = 1),
  ('03 the empty-draft clean-up (0141) is installed and still stamps auto_empty_draft',
     to_regprocedure('public._discard_empty_drafts_for(uuid, integer)') is not null
     and position('auto_empty_draft' in pg_get_functiondef('public._discard_empty_drafts_for(uuid, integer)'::regprocedure)) > 0),
  ('04 the other shelf checks are unchanged (archived reason, one shelf)',
     exists (select 1 from pg_constraint where conname = 'quotes_archived_reason_chk' and conrelid = 'public.quotes'::regclass)
     and exists (select 1 from pg_constraint where conname = 'quotes_shelf_one_chk' and conrelid = 'public.quotes'::regclass))
) v(item, ok) order by item;
