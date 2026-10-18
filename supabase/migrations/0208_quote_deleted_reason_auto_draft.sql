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
