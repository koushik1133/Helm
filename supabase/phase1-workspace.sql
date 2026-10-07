-- ════ SUPERSEDED (audit run 2, RC-11) ════════════════════════════════════════
-- This legacy file predates the canonical migrations (supabase/migrations + MANIFEST).
-- Re-running it on a database that already has them would put back old, weaker function
-- bodies, so it refuses to run there. Use scripts/db-migrate.sh / the APPLY-00xx files.
do $a42guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded by 0039+ (canonical migrations) — do not re-run this legacy file';
  end if;
end $a42guard$;
-- ═════════════════════════════════════════════════════════════════════════════
-- =========================================================================
-- Phase 1 — Event Workspace: a lifecycle stage on each event. Idempotent.
-- The "event" is the existing quotes row; we only add a stage + a setter.
-- Stages: lead → discovery → proposal → quote → confirmed → planning →
--         resources → ready → event_day → settlement → closed
-- =========================================================================
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid())
    in ('admin','planner','sales','operations'), false); $$;

alter table public.quotes add column if not exists lifecycle_stage text;

-- backfill from current status, then set a sensible default
update public.quotes set lifecycle_stage = case
    when status='confirmed' then 'confirmed'
    when status='cancelled' then 'closed'
    else 'quote' end
  where lifecycle_stage is null;
alter table public.quotes alter column lifecycle_stage set default 'quote';

do $$ begin
  if not exists (select 1 from pg_constraint where conname='quotes_lifecycle_chk') then
    alter table public.quotes add constraint quotes_lifecycle_chk check (lifecycle_stage in
      ('lead','discovery','proposal','quote','confirmed','planning','resources','ready','event_day','settlement','closed'));
  end if;
end $$;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_stage not in ('lead','discovery','proposal','quote','confirmed','planning','resources','ready','event_day','settlement','closed')
    then raise exception 'invalid stage: %', p_stage; end if;
  update public.quotes set lifecycle_stage = p_stage, updated_at = now() where id = p_quote_id;
  if not found then raise exception 'no such event'; end if;
  return jsonb_build_object('stage', p_stage);
end; $$;
revoke all on function public.set_lifecycle_stage(uuid,text) from anon;
grant execute on function public.set_lifecycle_stage(uuid,text) to authenticated;

-- verify
select lifecycle_stage, count(*) from public.quotes group by lifecycle_stage order by 1;
