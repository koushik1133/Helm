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

-- base-v1 lacks work_tokens.expires_at (SEC-07 assumed prod-rollout added it)
alter table public.work_tokens add column if not exists expires_at timestamptz;

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
