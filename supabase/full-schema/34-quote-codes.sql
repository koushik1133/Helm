-- =========================================================================
-- DEPRECATED — DO NOT RUN / DO NOT DEPLOY (PR-DEPLOY-01 / DEPLOY-01).
-- HISTORICAL full-schema mirror. Defines a NON-org-scoped create_quote that is
-- superseded by the ordered supabase/phaseNN-name.sql files (phase73). Do not
-- re-run standalone. See ../README.md.
-- =========================================================================
-- =========================================================================
-- Phase 28 — Fix "duplicate key value violates unique constraint quotes_code_key"
--
-- Cause: create_quote inserted the CLIENT-supplied code (p_code). If that number
-- was already taken (a stale dashboard list, or a lead-conversion grabbed it
-- first), the insert hit the unique index on quotes.code.
--
-- Fix: both create_quote and convert_lead_to_quote now generate the code
-- SERVER-SIDE from max(existing) for today's stamp, inside a retry loop that
-- recomputes on a unique_violation — so concurrent creates never collide.
-- p_code is kept in the signature for compatibility but ignored.
-- Idempotent (create or replace).
-- =========================================================================

create or replace function public.create_quote(
  p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count int
) returns public.quotes language plpgsql security definer set search_path = public as $$
declare q public.quotes; v_stamp text := to_char(now(),'MMDDYYYY'); v_next int; v_code text; v_try int := 0;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%';
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version)
        values (v_code, coalesce(p_title,'Untitled event'), p_event_type, 1)
        returning * into q;
      exit;                         -- success
    exception when unique_violation then
      if v_try >= 25 then raise; end if;   -- give up after 25 tries
      -- else loop: recompute the next number and try again
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid());
  return q;
end; $$;

create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads; q public.quotes;
  v_stamp text := to_char(now(),'MMDDYYYY'); v_next int; v_code text; v_title text; v_try int := 0;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id;
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id; return q; end if;
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%';
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage, event_date)
        values (v_code, v_title, l.event_type, 1,
                jsonb_strip_nulls(jsonb_build_object('name', l.name, 'phone', l.phone, 'email', l.email)),
                'discovery', l.event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());
  update public.leads set status = 'quoted', quote_id = q.id, updated_at = now() where id = p_lead_id;
  return q;
end; $$;

revoke all on function public.create_quote(text,text,text,jsonb,int) from public, anon;
grant execute on function public.create_quote(text,text,text,jsonb,int) to authenticated;
revoke all on function public.convert_lead_to_quote(uuid) from public, anon;
grant execute on function public.convert_lead_to_quote(uuid) to authenticated;

notify pgrst, 'reload schema';
