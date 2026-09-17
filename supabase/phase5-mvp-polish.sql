-- =========================================================================
-- PHASE 5 — MVP checkpoint polish (no new tables)
-- Idempotent. Depends on: phase1-workspace.sql, phase2-leads.sql.
-- Change: a converted lead now opens its event at the 'discovery' stage,
-- so the planner flows Discovery → Proposal → Quote → Confirm naturally.
-- =========================================================================
create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads; q public.quotes;
  v_stamp text := to_char(now(), 'MMDDYYYY'); v_next int; v_code text; v_title text;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id;
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id; return q; end if;
  select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
    into v_next from public.quotes where code like v_stamp || '-%';
  v_code  := v_stamp || '-' || lpad(v_next::text, 2, '0');
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;
  insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage)
    values (v_code, v_title, l.event_type, 1,
            jsonb_strip_nulls(jsonb_build_object('name', l.name, 'phone', l.phone, 'email', l.email)),
            'discovery')
    returning * into q;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());
  update public.leads set status = 'quoted', quote_id = q.id, updated_at = now() where id = p_lead_id;
  return q;
end; $$;
revoke all on function public.convert_lead_to_quote(uuid) from public, anon;
grant execute on function public.convert_lead_to_quote(uuid) to authenticated;
