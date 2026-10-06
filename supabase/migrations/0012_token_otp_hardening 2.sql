-- ============================================================================
-- 0012_token_otp_hardening.sql — CANONICAL forward-only (SEC-07 G1/G2/G3).
-- Extracted from security-fix/SEC-07 (not blind-replayed; preconditions removed,
-- and the base column SEC-07 assumed from prod-rollout is created here).
--   G1 approval-token expiry: auto-stamp + never silently revive (trigger).
--   G2 worker-token expiry + renewal (adds work_tokens.expires_at, which base-v1 lacks).
--   G3 OTP serialized rate limit: 3/phone/hour + 10/quote/day via per-phone and
--      per-quote transaction advisory locks (deterministic order) — blocks
--      concurrent OTP floods.
-- Idempotent. Forward-only.
-- ============================================================================

-- base-v1 lacks work_tokens.expires_at / revoked_at (SEC-07 assumed prod-rollout
-- added them). Both are created here, additively, so the renewal trigger and the
-- worker-RPC liveness guard below have the columns they reference.
alter table public.work_tokens add column if not exists expires_at timestamptz;
alter table public.work_tokens add column if not exists revoked_at timestamptz;

create or replace function public.tg_approval_token_expiry()
returns trigger language plpgsql set search_path = public as $$
declare v_floor timestamptz;
begin
  if new.approval_token is null or new.approval_token_revoked_at is not null then return new; end if;
  -- usable 30 days from issue, and until 30 days after the event (client portal)
  v_floor := greatest(now() + interval '30 days',
                      coalesce(new.event_date::timestamptz + interval '30 days', '-infinity'));
  if tg_op = 'INSERT' or new.approval_token is distinct from old.approval_token then
    if new.approval_token_expires_at is null then new.approval_token_expires_at := v_floor; end if;
  elsif new.approval_token_expires_at is null then
    new.approval_token_expires_at := old.approval_token_expires_at;      -- an expiry is never silently cleared
  elsif new.approval_token_expires_at > now()                             -- only a LIVE link is extended
    and ((new.approval_status is distinct from old.approval_status and new.approval_status in ('approved','paid'))
         or new.event_date is distinct from old.event_date) then
    new.approval_token_expires_at := greatest(new.approval_token_expires_at, v_floor);
  end if;
  return new;
end; $$;
drop trigger if exists zz_approval_token_expiry on public.quotes;
create trigger zz_approval_token_expiry
  before insert or update of approval_token, approval_token_expires_at, approval_status, event_date
  on public.quotes for each row execute function public.tg_approval_token_expiry();
alter table public.work_tokens alter column expires_at drop default;   -- v1 set now()+60d; the trigger decides now
create or replace function public.tg_work_token_expiry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.expires_at is null then
    new.expires_at := greatest(now() + interval '60 days',
      coalesce((select event_date::timestamptz + interval '14 days' from public.quotes where id = new.quote_id), '-infinity'));
  end if;
  return new;
end; $$;
revoke all on function public.tg_work_token_expiry() from public, anon, authenticated;
drop trigger if exists zz_work_token_expiry on public.work_tokens;
create trigger zz_work_token_expiry before insert on public.work_tokens
  for each row execute function public.tg_work_token_expiry();

-- a new task assigned to a worker renews that worker's link (never a revoked one)
create or replace function public.tg_work_token_renew()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_phone is null then return new; end if;
  update public.work_tokens w
     set expires_at = greatest(w.expires_at, now() + interval '60 days',
           coalesce((select event_date::timestamptz + interval '14 days' from public.quotes where id = new.quote_id), '-infinity'))
   where w.quote_id = new.quote_id and w.phone = new.assignee_phone and w.revoked_at is null;
  return new;
end; $$;
revoke all on function public.tg_work_token_renew() from public, anon, authenticated;
drop trigger if exists zz_work_token_renew on public.event_tasks;
create trigger zz_work_token_renew after insert on public.event_tasks
  for each row execute function public.tg_work_token_renew();

-- G2: shared worker-token liveness guard. Rejects an invalid, revoked, or expired
-- link. The four anon-facing worker_* RPCs route their token lookup through this so
-- an expired/revoked worker link can no longer read or mutate (base-v1 checked only
-- that the token existed). Owner-only; the SECURITY DEFINER worker_* fns call it.
create or replace function public._work_token_live(p_token uuid)
returns public.work_tokens language plpgsql security definer set search_path = public as $$
declare w public.work_tokens;
begin
  select * into w from public.work_tokens where token = p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null then raise exception 'link revoked' using errcode='42501'; end if;
  if w.expires_at is not null and w.expires_at <= now() then raise exception 'link expired' using errcode='42501'; end if;
  return w;
end; $$;
revoke all on function public._work_token_live(uuid) from public, anon, authenticated;

-- Recreate the four worker RPCs to gate on liveness (bodies otherwise identical to
-- base-v1). CREATE OR REPLACE preserves the anon EXECUTE grants from 0005.
create or replace function public.worker_get_tasks(p_token uuid)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare w public.work_tokens; q public.quotes; tasks jsonb;
begin
  w := public._work_token_live(p_token);
  select * into q from public.quotes where id=w.quote_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'title',title,'status',status
           ) order by category, seq), '[]'::jsonb) into tasks
    from public.event_tasks where quote_id=w.quote_id and assignee_phone=w.phone;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_date',q.event_date,'event_time',q.event_time),
    'worker', jsonb_build_object('name',w.name,'phone',w.phone),
    'tasks', tasks);
end; $function$;

create or replace function public.worker_respond(p_token uuid, p_task_id uuid, p_action text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare w public.work_tokens; tsk public.event_tasks; newst text;
begin
  w := public._work_token_live(p_token);
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
end; $function$;

create or replace function public.worker_get_equipment(p_token uuid)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare w public.work_tokens; items jsonb; digits text;
begin
  w := public._work_token_live(p_token);
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
end; $function$;

create or replace function public.worker_checkin_equipment(p_token uuid, p_id uuid, p_qty_in numeric)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare w public.work_tokens; row public.inventory_checkouts; digits text; ok boolean;
begin
  w := public._work_token_live(p_token);
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
end; $function$;

update public.work_tokens w
   set expires_at = greatest(w.created_at + interval '60 days',
                             coalesce((select q.event_date::timestamptz + interval '14 days' from public.quotes q where q.id = w.quote_id), '-infinity'))
 where w.expires_at is null;

-- G3 OTP send limits (serialized) -------------------------------------------
create or replace function public.tg_otp_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_digits text := regexp_replace(coalesce(new.phone,''), '[^0-9]', '', 'g'); n int;
begin
  -- Serialize per phone number, then per quote (fixed order → no deadlock).
  -- The lock is held to COMMIT, and each count below runs as a new statement,
  -- so under READ COMMITTED it sees every row committed by the previous holder.
  perform pg_advisory_xact_lock(hashtextextended('helm:otp:phone:' || v_digits, 0));
  perform pg_advisory_xact_lock(hashtextextended('helm:otp:quote:' || new.quote_id::text, 0));
  select count(*) into n from public.quote_otps
   where regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') = v_digits and created_at > now() - interval '1 hour';
  if n >= 3 then raise exception 'too many codes sent to this number — try again in an hour' using errcode = 'P0001'; end if;
  select count(*) into n from public.quote_otps where quote_id = new.quote_id and created_at > now() - interval '1 day';
  if n >= 10 then raise exception 'too many codes requested for this quote today' using errcode = 'P0001'; end if;
  return new;
end; $$;
revoke all on function public.tg_otp_rate_limit() from public, anon, authenticated;
drop trigger if exists zz_otp_rate_limit on public.quote_otps;
create trigger zz_otp_rate_limit before insert on public.quote_otps
  for each row execute function public.tg_otp_rate_limit();

-- G1 enforcement: public token-readers reject expired approval tokens
CREATE OR REPLACE FUNCTION public.public_get_portal(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; prop public.event_proposal; ms jsonb; gal jsonb; outstanding numeric; studio jsonb;
begin
  select * into q from public.quotes where approval_token = p_token and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select * into prop from public.event_proposal where quote_id = q.id and org_id = q.org_id;
  select jsonb_build_object('name', o.name, 'brand', o.brand) into studio
    from public.organizations o where o.id = q.org_id;
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
    'studio', studio,
    'client_name', coalesce(q.client->>'name',''),
    'approval_status', q.approval_status,
    'total', coalesce((q.pricing->>'total')::numeric, 0),
    'proposal', case when prop.quote_id is not null and prop.published
                  then jsonb_build_object('concept',prop.concept,'theme',prop.theme,
                                          'palette',prop.palette,'images',prop.images,'scope',prop.scope)
                  else null end,
    'payment', jsonb_build_object('milestones', ms, 'outstanding', outstanding),
    'gallery', gal);
end; $function$

;
CREATE OR REPLACE FUNCTION public.public_get_quote(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes;
begin
  select * into q from public.quotes where approval_token = p_token and (approval_token_expires_at is null or approval_token_expires_at > now())
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  return jsonb_build_object(
    'code', q.code, 'title', q.title, 'event_type', q.event_type,
    'status', q.status, 'approval_status', q.approval_status,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing);
end; $function$

;
