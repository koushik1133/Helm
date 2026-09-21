-- ============================================================================
-- Phase 60 — Harden tenant isolation: org_id NOT NULL on core tables
-- ---------------------------------------------------------------------------
-- Final isolation hardening. Every tenant row must belong to a studio. This
-- sets org_id NOT NULL on each base table that has an org_id column AND has zero
-- null rows right now (verify-first: a table with any null org_id is SKIPPED
-- with a notice, never forced). Safe + idempotent — re-running only touches
-- columns still nullable.
--
-- DELIBERATELY EXCLUDED:
--   • profiles — a just-signed-up user (email or Google) has a profile with a
--     NULL org_id until create_studio() runs, so this column MUST stay nullable.
--   • organizations — it has no org_id column (it *is* the org), so it's already
--     out of scope by the column filter.
--
-- Anon insert flows (quote OTP/consents/payments, worker links, portal) are
-- fine: their BEFORE INSERT trigger stamps org_id from the parent row, which
-- runs before the NOT NULL check.
-- ============================================================================

do $$
declare r record; n bigint;
begin
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'org_id'
      and c.is_nullable = 'YES'
      and t.table_type = 'BASE TABLE'
      and c.table_name <> 'profiles'
    order by c.table_name
  loop
    execute format('select count(*) from public.%I where org_id is null', r.table_name) into n;
    if n = 0 then
      execute format('alter table public.%I alter column org_id set not null', r.table_name);
      raise notice 'NOT NULL set on %', r.table_name;
    else
      raise notice 'SKIP % — % row(s) still have null org_id (backfill first)', r.table_name, n;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- verify: which tenant tables still allow null org_id (expect only 'profiles')
select table_name
from information_schema.columns
where table_schema = 'public' and column_name = 'org_id' and is_nullable = 'YES'
order by table_name;
