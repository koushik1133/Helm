-- ============================================================================
-- W15B-05-FOLLOWUP.sql — closes the remaining audit items after W15B-01/04.
-- STATUS: APPLIED TO STAGING + VERIFIED ON STAGING (2026-09-28). NOT FOR PRODUCTION.
-- Runtime proof: worker_get_tasks -> 401/42501 after revoke_work_token and when
-- expires_at is past; service_role DELETE of a quote with a payment -> 409/23503
-- (FK RESTRICT); OTP/portal/proposal functions re-created cleanly.
-- Faithful CREATE OR REPLACE of the CURRENT deployed bodies (operations.sql +
-- phase52 + phase53 + phase93 + otp-payments.sql) with the minimal guard added,
-- so no later enhancement is reverted. Additive & idempotent. Requires W15B-04
-- (work_tokens.expires_at/revoked_at) applied first.
-- ============================================================================
begin;

-- 1) OTP CSPRNG (STRIX-001): replace random() with pgcrypto gen_random_bytes -----
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; code text; recent int; live boolean; b bytea;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  -- CSPRNG 6-digit code (crypto bytes, not random()); no fixed PIN.
  b := extensions.gen_random_bytes(3);
  code := lpad(((get_byte(b,0)::bigint*65536 + get_byte(b,1)*256 + get_byte(b,2)) % 1000000)::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  perform public._notify(q.id,'sms',p_phone,'otp', jsonb_build_object('purpose','approval'));
  live := public._flag('sms_live');
  if live then
    return jsonb_build_object('sent', true, 'live', true, 'delivery', 'sms', 'dev_code', null);
  elsif public._flag('otp_dev_echo') then
    return jsonb_build_object('sent', true, 'live', false, 'delivery', 'dev_echo', 'dev_code', code);
  else
    return jsonb_build_object('sent', false, 'live', false, 'delivery', 'unavailable', 'dev_code', null,
      'message', 'OTP delivery is not configured. Enable a live SMS provider (sms_live=true) or, for local development only, set channels.otp_dev_echo=true in app_config.');
  end if;
end; $$;

-- 2) Worker RPCs: enforce expires_at/revoked_at (CF worker-token finding) --------
create or replace function public.worker_get_tasks(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; q public.quotes; tasks jsonb;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then raise exception 'link expired or revoked' using errcode='42501'; end if;
  select * into q from public.quotes where id=w.quote_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'title',title,'status',status
           ) order by category, seq), '[]'::jsonb) into tasks
    from public.event_tasks where quote_id=w.quote_id and assignee_phone=w.phone;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_date',q.event_date,'event_time',q.event_time),
    'worker', jsonb_build_object('name',w.name,'phone',w.phone),
    'tasks', tasks);
end; $$;

create or replace function public.worker_respond(p_token uuid, p_task_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; tsk public.event_tasks; newst text;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then raise exception 'link expired or revoked' using errcode='42501'; end if;
  select * into tsk from public.event_tasks where id=p_task_id and quote_id=w.quote_id and assignee_phone=w.phone;
  if tsk.id is null then raise exception 'task not found'; end if;
  newst := case p_action
    when 'accept'   then 'accepted'
    when 'reject'   then 'rejected'
    when 'start'    then 'in_progress'
    when 'complete' then 'completed'
    else null end;
  if newst is null then raise exception 'invalid action'; end if;
  if p_action='start'    and tsk.status not in ('accepted','assigned') then raise exception 'accept the task first'; end if;
  if p_action='complete' and tsk.status not in ('in_progress','accepted') then raise exception 'start the task first'; end if;
  update public.event_tasks set status=newst,
    responded_at = case when p_action in ('accept','reject') then now() else responded_at end,
    started_at   = case when p_action='start'    then now() else started_at end,
    completed_at = case when p_action='complete' then now() else completed_at end
    where id=p_task_id;
  perform public._notify(w.quote_id,'sms',null,'task_'||p_action, jsonb_build_object('task',tsk.title,'worker',w.name));
  return jsonb_build_object('ok',true,'status',newst);
end; $$;

create or replace function public.worker_get_equipment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; items jsonb; digits text;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then raise exception 'link expired or revoked' using errcode='42501'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item', i.name, 'unit', i.unit,
           'qty_out', c.qty_out, 'qty_in', c.qty_in, 'status', c.status
         ) order by i.name), '[]'::jsonb) into items
    from public.inventory_checkouts c
    join public.inventory_items i on i.id = c.item_id
    join public.crew_members cm on cm.id = c.issued_to_id
   where c.quote_id = w.quote_id
     and c.status in ('out','partial')
     and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits;
  return jsonb_build_object('equipment', items);
end; $$;

create or replace function public.worker_checkin_equipment(p_token uuid, p_id uuid, p_qty_in numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; row public.inventory_checkouts; digits text; ok boolean;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then raise exception 'link expired or revoked' using errcode='42501'; end if;
  select * into row from public.inventory_checkouts where id = p_id;
  if not found then raise exception 'checkout not found'; end if;
  if row.quote_id is distinct from w.quote_id then raise exception 'not your event' using errcode='42501'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select exists(select 1 from public.crew_members cm where cm.id = row.issued_to_id
                and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits) into ok;
  if not ok then raise exception 'not your equipment' using errcode='42501'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = coalesce(nullif(btrim(w.name),''),'crew'),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= qty_out then 'returned' else 'partial' end
   where id = p_id
   returning * into row;
  return jsonb_build_object('ok',true,'status',row.status,'qty_in',row.qty_in,'qty_out',row.qty_out);
end; $$;

-- 3) Portal/proposal: honour token expiry (CF portal-proposal finding) ----------
create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; prop public.event_proposal; ms jsonb; gal jsonb; outstanding numeric;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());   -- CF: honour expiry
  if q.id is null then raise exception 'invalid link'; end if;
  select * into prop from public.event_proposal where quote_id = q.id;
  select coalesce(jsonb_agg(jsonb_build_object('label',label,'due_date',due_date,'amount',amount,'status',status)
                            order by seq, due_date), '[]'::jsonb)
    into ms from public.payment_milestones where quote_id = q.id;
  select coalesce(sum(amount),0) into outstanding
    from public.payment_milestones where quote_id = q.id and status not in ('paid','waived');
  select coalesce(jsonb_agg(jsonb_build_object('url',url,'kind',kind,'caption',caption)
                            order by seq, created_at), '[]'::jsonb)
    into gal from public.event_media where quote_id = q.id and in_gallery = true;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_type',q.event_type,
                                'event_date',q.event_date,'event_time',q.event_time,
                                'status',q.status,'stage',q.lifecycle_stage),
    'client_name', coalesce(q.client->>'name',''),
    'approval_status', q.approval_status,
    'total', coalesce((q.pricing->>'total')::numeric, 0),
    'proposal', case when prop.quote_id is not null and prop.published
                  then jsonb_build_object('concept',prop.concept,'theme',prop.theme,
                                          'palette',prop.palette,'images',prop.images,'scope',prop.scope)
                  else null end,
    'payment', jsonb_build_object('milestones', ms, 'outstanding', outstanding),
    'gallery', gal);
end; $$;

-- add an optional share-token expiry to proposals (nullable = no expiry) + guard
alter table public.event_proposal add column if not exists share_token_expires_at timestamptz;
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal
    where share_token = p_token and published = true
      and (share_token_expires_at is null or share_token_expires_at > now());       -- CF: honour expiry
  if pr.quote_id is null then raise exception 'invalid or unpublished link'; end if;
  select * into q from public.quotes where id = pr.quote_id;
  return jsonb_build_object(
    'concept', pr.concept, 'theme', pr.theme, 'palette', pr.palette,
    'images', pr.images, 'scope', pr.scope,
    'event_code', q.code, 'event_title', q.title, 'event_type', q.event_type,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing,
    'total', coalesce((q.pricing->>'total')::numeric, 0));
end; $$;

-- 4) Protect the financial/consent ledger from cascade delete (HLM-DEL-01) ------
-- Swap ONLY the financial + consent children's FK to quotes from CASCADE to
-- RESTRICT (other children like tasks/plan legitimately still cascade). Dynamic
-- so it works regardless of the constraint's generated name.
do $$
declare r record;
begin
  for r in
    select con.conname, cl.relname as child
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_class pcl on pcl.oid = con.confrelid
     where con.contype='f' and pcl.relname='quotes'
       and cl.relname in ('quote_payments','quote_consents')
       and con.confdeltype='c'   -- currently ON DELETE CASCADE
  loop
    execute format('alter table public.%I drop constraint %I', r.child, r.conname);
    execute format('alter table public.%I add constraint %I foreign key (quote_id) references public.quotes(id) on delete restrict', r.child, r.conname);
    raise notice 'FK % on % -> ON DELETE RESTRICT', r.conname, r.child;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
