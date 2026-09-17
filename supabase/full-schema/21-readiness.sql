-- =========================================================================
-- PHASE 15 — Event Ready checkpoint (readiness gate)  [Block C]
-- Idempotent. Depends on: phase13-plan.sql (event_plan).
-- The readiness checklist is COMPUTED in the app by aggregating what earlier
-- phases already store. The only DB change is two sign-off timestamps
-- (dry run + team briefing) on event_plan, plus an RPC to set them.
-- =========================================================================

alter table public.event_plan add column if not exists dry_run_at  timestamptz;
alter table public.event_plan add column if not exists briefing_at timestamptz;

create or replace function public.set_plan_signoff(p_quote_id uuid, p_field text, p_done boolean)
returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_field not in ('dry_run','briefing') then raise exception 'unknown sign-off field %', p_field; end if;
  insert into public.event_plan (quote_id, updated_by) values (p_quote_id, auth.uid())
    on conflict (quote_id) do nothing;
  update public.event_plan set
    dry_run_at  = case when p_field='dry_run'  then (case when p_done then now() else null end) else dry_run_at  end,
    briefing_at = case when p_field='briefing' then (case when p_done then now() else null end) else briefing_at end,
    updated_at  = now(), updated_by = auth.uid()
  where quote_id = p_quote_id
  returning * into r;
  return r;
end; $$;

revoke all on function public.set_plan_signoff(uuid,text,boolean) from public, anon;
grant execute on function public.set_plan_signoff(uuid,text,boolean) to authenticated;
