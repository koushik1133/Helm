-- =========================================================================
-- Phase 34 — Cluster D2: quote codes based on the EVENT date, not creation date
--
-- Meeting: "quotation numbers should incorporate the event date (e.g. the wedding
-- date / Dec 4) rather than the initial creation date."
--
--   • create_quote() gains an optional p_event_date → the code's MMDDYYYY stamp
--     comes from the event date when known (else today), and the date is stored.
--   • convert_lead_to_quote() stamps the code from the lead's event_date.
--   • rebrand_quote_code() re-issues a quote's code from its event_date once the
--     date is set later (idempotent: if the code already matches, it's left alone).
--
-- Format stays MMDDYYYY-NN so the existing sequence logic keeps working.
-- RUN AFTER phase29 + phase28. Idempotent.
-- =========================================================================

-- drop the old 5-arg version so the new 6-arg one is unambiguous to PostgREST
drop function if exists public.create_quote(text,text,text,jsonb,int);

create or replace function public.create_quote(
  p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count int, p_event_date date default null
) returns public.quotes language plpgsql security definer set search_path = public as $$
declare q public.quotes;
  v_stamp text := to_char(coalesce(p_event_date, now()), 'MMDDYYYY');   -- event date if known, else today
  v_next int; v_code text; v_try int := 0;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%';
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, event_date)
        values (v_code, coalesce(p_title,'Untitled event'), p_event_type, 1, p_event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid());
  return q;
end; $$;
revoke all on function public.create_quote(text,text,text,jsonb,int,date) from public, anon;
grant execute on function public.create_quote(text,text,text,jsonb,int,date) to authenticated;

-- lead → quote: stamp from the lead's event date when present
create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads; q public.quotes;
  v_stamp text; v_next int; v_code text; v_title text; v_try int := 0;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id;
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id; return q; end if;
  v_stamp := to_char(coalesce(l.event_date, now()), 'MMDDYYYY');
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

-- re-brand an existing quote's code to match its event date (idempotent)
create or replace function public.rebrand_quote_code(p_quote_id uuid)
  returns text language plpgsql security definer set search_path = public as $$
declare q public.quotes; v_stamp text; v_next int; v_code text; v_try int := 0;
begin
  if not public.has_area('quotes','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes where id = p_quote_id;
  if not found then raise exception 'quote not found'; end if;
  if q.event_date is null then return q.code; end if;                 -- no date → nothing to do
  v_stamp := to_char(q.event_date, 'MMDDYYYY');
  if q.code like v_stamp || '-%' then return q.code; end if;          -- already matches → leave it
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%';
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      update public.quotes set code = v_code where id = p_quote_id;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  return v_code;
end; $$;
revoke all on function public.rebrand_quote_code(uuid) from public, anon;
grant execute on function public.rebrand_quote_code(uuid) to authenticated;

notify pgrst, 'reload schema';
