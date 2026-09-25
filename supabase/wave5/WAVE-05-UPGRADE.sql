-- ============================================================================
-- WAVE-05-UPGRADE.sql   —  MUTATES SCHEMA / FUNCTIONS / POLICIES / GRANTS.
-- ----------------------------------------------------------------------------
-- Forward-only reconciliation of the Wave 1–4 hardening deltas into an EXISTING
-- Helm Supabase database. This does NOT rebuild the schema and does NOT touch
-- historical migrations. It re-applies only the hardened definitions:
--   • SEC-01  layouts tenant isolation                (was phase89)
--   • MONEY-03/04/05 numbering + idempotency          (was phase90)
--   • TOKEN-01 approval-token expiry + revocation     (from otp-payments.sql)
--   • OTP-01  dev-echo gating, fail-closed request_otp (from otp-payments.sql)
--   • SEC-03  org-scoped generate_approval_token/mark_paid (from otp-payments.sql)
--   • phase91 organizations.location
--   • phase92 quote→CRM lead sync
--   • phase93 public_get_proposal returns pricing/total
--
-- It EXCLUDES data seeds (phase94/95/96) — those are data, not hardening.
--
-- SAFETY: additive & idempotent; ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE;
-- guarded policy reconciliation; unique indexes IF NOT EXISTS. It FAILS LOUD and
-- rolls the whole transaction back if pre-existing duplicate receipt/version rows
-- exist (never silently drops data). No TRUNCATE, no table drops, no tenant-owner
-- guessing (ownerless `layouts` rows are quarantined, not reassigned/deleted).
--
-- PREREQUISITES (verify with WAVE-05-PREFLIGHT.sql → DEP rows all "present"):
--   current_org_id() (phase56), assert_quote_org() (phase71+),
--   quote_payments.receipt_no (phase76), quotation_versions (phase77),
--   leads + archive_lead (phase2/2b), event_proposal (phase4), organizations (phase56).
-- If any DEP is MISSING, STOP and apply that earlier phase first.
--
-- Paste into the Supabase SQL Editor and Run. Then run WAVE-05-VERIFY.sql.
-- ============================================================================

begin;

-- ============================================================================
-- A) OTP-01 base — channel flags + _flag() helper
-- ============================================================================
create table if not exists public.app_config (
  key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
insert into public.app_config(key,value) values
  ('channels', '{"sms_live":false,"email_live":false,"pay_live":false,"otp_dev_echo":false}'::jsonb)
  on conflict (key) do nothing;
update public.app_config set value = value || '{"otp_dev_echo":false}'::jsonb
  where key='channels' and not (value ? 'otp_dev_echo');

create or replace function public._flag(p text) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select (value->>p)::boolean from public.app_config where key='channels'), false); $$;

-- ============================================================================
-- B) TOKEN-01 — approval-token expiry + revocation columns on quotes
-- ============================================================================
alter table public.quotes add column if not exists approval_token             uuid;
alter table public.quotes add column if not exists approval_status            text not null default 'none';
alter table public.quotes add column if not exists approval_token_expires_at  timestamptz;
alter table public.quotes add column if not exists approval_token_revoked_at  timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='quotes_approval_status_chk') then
    alter table public.quotes add constraint quotes_approval_status_chk
      check (approval_status in ('none','sent','approved','paid','cancelled'));
  end if;
end $$;
create unique index if not exists quotes_approval_token_idx on public.quotes(approval_token) where approval_token is not null;

-- ============================================================================
-- C) Token-consuming + privileged functions (TOKEN-01 expiry-if-set, OTP-01
--    dev-echo gating + fail-closed, SEC-03 org scoping). CREATE OR REPLACE.
--    Bodies are the exact hardened definitions from supabase/otp-payments.sql.
-- ============================================================================

create or replace function public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare live boolean;
begin
  live := case p_channel when 'sms' then public._flag('sms_live') when 'email' then public._flag('email_live') else false end;
  insert into public.notifications(quote_id,channel,recipient,kind,status,detail)
    values (p_quote,p_channel,p_to,p_kind, case when live then 'sent' else 'simulated' end, coalesce(p_detail,'{}'::jsonb));
end; $$;

create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  select approval_token into tok from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if tok is null then tok := gen_random_uuid();
    update public.quotes set approval_token = tok, approval_status = 'sent', updated_at = now()
      where id = p_quote_id and org_id = public.current_org_id();
  else
    update public.quotes set approval_status = case when approval_status='none' then 'sent' else approval_status end
      where id = p_quote_id and org_id = public.current_org_id();
  end if;
  return tok;
end; $$;

create or replace function public.revoke_approval_token(p_quote_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  update public.quotes
     set approval_token = null,
         approval_token_revoked_at = now(),
         approval_status = case when approval_status in ('sent','none') then 'cancelled' else approval_status end,
         updated_at = now()
   where id = p_quote_id and org_id = public.current_org_id();
  if not found then raise exception 'no such event' using errcode='42501'; end if;
  return jsonb_build_object('revoked', true);
end; $$;
revoke all on function public.revoke_approval_token(uuid) from anon;
grant execute on function public.revoke_approval_token(uuid) to authenticated;

create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  return jsonb_build_object(
    'code', q.code, 'title', q.title, 'event_type', q.event_type,
    'status', q.status, 'approval_status', q.approval_status,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing);
end; $$;

create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; code text; recent int; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  code := lpad((floor(random() * 1000000))::int::text, 6, '0');
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

create or replace function public.admin_store_otp(p_token uuid, p_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; recent int;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests'; end if;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(p_code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  return jsonb_build_object('stored', true);
end; $$;
revoke all on function public.admin_store_otp(uuid,text,text) from public, anon, authenticated;

create or replace function public.verify_and_consent(
  p_token uuid, p_phone text, p_code text, p_agreed boolean,
  p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; rec public.quote_otps;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select * into rec from public.quote_otps
    where quote_id=q.id and phone=p_phone and verified_at is null and expires_at > now()
    order by created_at desc limit 1;
  if rec.id is null then raise exception 'no active code — request a new OTP'; end if;
  if rec.attempts >= 5 then raise exception 'too many attempts — request a new OTP'; end if;
  if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then
    update public.quote_otps set attempts = attempts+1 where id = rec.id;
    raise exception 'incorrect code';
  end if;
  if p_agreed is not true then raise exception 'you must accept the terms to confirm'; end if;
  update public.quote_otps set verified_at = now() where id = rec.id;
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, user_agent)
    values (q.id, p_phone, p_client_name, p_terms_version, p_consent_text, true, true, p_user_agent);
  update public.quotes set approval_status='approved', updated_at=now() where id=q.id;
  return jsonb_build_object('approved', true);
end; $$;

create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; amt numeric; pid uuid; link text; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  if q.approval_status not in ('approved','paid') then raise exception 'approve the terms first'; end if;
  amt := coalesce((q.pricing->>'total')::numeric, 0);
  live := public._flag('pay_live');
  if live then
    insert into public.quote_payments(quote_id, provider, amount, status, simulated)
      values (q.id,'razorpay',amt,'created',false) returning id into pid;
    return jsonb_build_object('payment_id', pid, 'pending_provider', true, 'amount', amt);
  else
    link := 'sim-pay.html?ref='||q.code||'&amount='||amt::text;
    insert into public.quote_payments(quote_id, provider, amount, status, link_url, simulated)
      values (q.id,'simulated',amt,'created',link,true) returning id into pid;
    perform public._notify(q.id,'sms', q.client->>'phone','payment_link', jsonb_build_object('url',link,'amount',amt));
    return jsonb_build_object('payment_id', pid, 'link_url', link, 'amount', amt, 'live', false);
  end if;
end; $$;

create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  update public.quote_payments set status='paid', paid_at=now(), provider_ref=coalesce(p_provider_ref,provider_ref)
    where quote_id=p_quote_id and status='created';
  update public.quotes set approval_status='paid', updated_at=now()
    where id=p_quote_id and org_id = public.current_org_id() returning * into q;
  perform public._notify(p_quote_id,'email', q.client->>'email','payment_receipt', jsonb_build_object('code',q.code));
  perform public._notify(p_quote_id,'sms',   q.client->>'phone','payment_receipt', jsonb_build_object('code',q.code));
  return jsonb_build_object('paid', true);
end; $$;

-- grants: token-scoped public flow reachable by anon; manager ops authenticated-only
grant execute on function public.public_get_quote(uuid)                               to anon, authenticated;
grant execute on function public.request_otp(uuid,text)                               to anon, authenticated;
grant execute on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) to anon, authenticated;
grant execute on function public.create_payment(uuid)                                 to anon, authenticated;
revoke all on function public.generate_approval_token(uuid) from anon;
revoke all on function public.mark_paid(uuid,text)          from anon;
grant execute on function public.generate_approval_token(uuid) to authenticated;
grant execute on function public.mark_paid(uuid,text)          to authenticated;

-- ============================================================================
-- D) SEC-01 — layouts tenant isolation (was phase89)
-- ============================================================================
alter table public.layouts add column if not exists org_id uuid references public.organizations(id);
alter table public.layouts alter column org_id set default public.current_org_id();

create or replace function public._layouts_stamp_org() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.org_id := public.current_org_id();
  return new;
end; $$;

drop trigger if exists layouts_stamp_org on public.layouts;
create trigger layouts_stamp_org before insert on public.layouts
  for each row execute function public._layouts_stamp_org();

alter table public.layouts enable row level security;

do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='layouts'
  loop execute format('drop policy if exists %I on public.layouts', p.policyname); end loop;
end $$;

create policy "layouts read"   on public.layouts for select to authenticated
  using ( org_id is not null and org_id = (select public.current_org_id()) );
create policy "layouts insert" on public.layouts for insert to authenticated
  with check ( org_id = (select public.current_org_id()) );
create policy "layouts update" on public.layouts for update to authenticated
  using ( org_id is not null and org_id = (select public.current_org_id()) )
  with check ( org_id = (select public.current_org_id()) );
create policy "layouts delete" on public.layouts for delete to authenticated
  using ( org_id is not null and org_id = (select public.current_org_id()) );

grant select, insert, update, delete on public.layouts to authenticated;
revoke all on public.layouts from anon;

create or replace function public.layouts_quarantined_count() returns bigint
  language sql stable security definer set search_path = public as $$
  select count(*) from public.layouts where org_id is null; $$;
revoke all on function public.layouts_quarantined_count() from anon;
grant execute on function public.layouts_quarantined_count() to authenticated;

-- ============================================================================
-- E) MONEY-03/04/05 — numbering + idempotency (was phase90).
--    FAILS LOUD if pre-existing duplicates exist (no data changed).
-- ============================================================================
do $$ declare dup int; begin
  select count(*) into dup from (
    select quote_id, receipt_no from public.quote_payments
     where receipt_no is not null
     group by quote_id, receipt_no having count(*) > 1) d;
  if dup > 0 then
    raise exception 'WAVE-05: % duplicate (quote_id,receipt_no) group(s) exist — resolve manually before the unique index (no data changed)', dup;
  end if;
end $$;
create unique index if not exists quote_payments_quote_receipt_uk
  on public.quote_payments(quote_id, receipt_no) where receipt_no is not null;

alter table public.quote_payments add column if not exists idempotency_key text;
create unique index if not exists quote_payments_idempotency_uk
  on public.quote_payments(quote_id, idempotency_key) where idempotency_key is not null;

do $$ declare dup int; begin
  select count(*) into dup from (
    select quote_id, label from public.quotation_versions
     group by quote_id, label having count(*) > 1) d;
  if dup > 0 then
    raise exception 'WAVE-05: % duplicate (quote_id,label) version group(s) exist — resolve manually first (no data changed)', dup;
  end if;
end $$;
create unique index if not exists quotation_versions_quote_label_uk
  on public.quotation_versions(quote_id, label);

create or replace function public.record_payment(
  p_quote uuid, p_amount numeric, p_method text default 'cash',
  p_receipt_no text default null, p_milestone uuid default null, p_note text default null,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; rno text; seqn int; studio_email text; existing public.quote_payments; tries int := 0;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select * into q from public.quotes where id = p_quote and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event' using errcode='42501'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'amount must be greater than zero'; end if;

  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is not null then
    select * into existing from public.quote_payments
      where quote_id = p_quote and idempotency_key = p_idempotency_key limit 1;
    if existing.id is not null then
      return jsonb_build_object('receipt_no', existing.receipt_no, 'amount', existing.amount,
        'method', existing.method, 'booking','confirmed', 'idempotent_replay', true);
    end if;
  end if;

  loop
    tries := tries + 1;
    select count(*)+1 into seqn from public.quote_payments where quote_id = p_quote and status = 'paid';
    rno := coalesce(nullif(btrim(coalesce(p_receipt_no,'')),''), 'RCP-'||q.code||'-'||lpad(seqn::text,2,'0'));
    begin
      insert into public.quote_payments(quote_id, provider, amount, status, provider_ref, receipt_no, method, simulated, paid_at, note, idempotency_key)
        values (p_quote, coalesce(p_method,'cash'), p_amount, 'paid', rno, rno, coalesce(p_method,'cash'),
                (coalesce(p_method,'cash') <> 'cash'), now(), nullif(btrim(coalesce(p_note,'')),''),
                nullif(btrim(coalesce(p_idempotency_key,'')),''));
      exit;
    exception
      when unique_violation then
        if nullif(btrim(coalesce(p_receipt_no,'')),'') is not null then
          raise exception 'receipt number % already exists for this event', rno using errcode='23505';
        end if;
        if tries >= 5 then raise; end if;
    end;
  end loop;

  if p_milestone is not null then
    update public.payment_milestones set status='paid', paid_at=now() where id = p_milestone and quote_id = p_quote;
  else
    update public.payment_milestones set status='paid', paid_at=now()
      where id = (select id from public.payment_milestones where quote_id = p_quote and status <> 'paid' order by seq, due_date limit 1);
  end if;

  update public.quotes
     set approval_status = 'paid',
         status = case when status <> 'confirmed' then 'confirmed' else status end,
         lifecycle_stage = case when lifecycle_stage in ('lead','discovery','proposal','quote','confirmed')
                                then 'planning' else lifecycle_stage end,
         updated_at = now()
   where id = p_quote and org_id = public.current_org_id();

  select business_email into studio_email from public.organizations where id = q.org_id;
  perform public._notify(p_quote,'email', q.client->>'email', 'payment_receipt',
    jsonb_build_object('code',q.code,'amount',p_amount,'receipt',rno,'method',coalesce(p_method,'cash'),'booking','confirmed'));
  perform public._notify(p_quote,'email', coalesce(studio_email,''), 'advance_paid',
    jsonb_build_object('code',q.code,'amount',p_amount,'client',q.client->>'name','receipt',rno,'method',coalesce(p_method,'cash')));

  return jsonb_build_object('receipt_no', rno, 'amount', p_amount, 'method', coalesce(p_method,'cash'), 'booking','confirmed');
end; $$;
-- keep ONLY the 7-arg signature (drop the ambiguous 6-arg overload from phase76)
drop function if exists public.record_payment(uuid,numeric,text,text,uuid,text);
revoke all on function public.record_payment(uuid,numeric,text,text,uuid,text,text) from anon;
grant execute on function public.record_payment(uuid,numeric,text,text,uuid,text,text) to authenticated;

create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int; lbl text; tot numeric; tries int := 0;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  tot := coalesce((p_pricing->>'total')::numeric, 0);
  if tot < 0 then raise exception 'quotation total cannot be negative'; end if;
  loop
    tries := tries + 1;
    select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
    lbl := 'Q'||n;
    begin
      insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
        values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid());
      exit;
    exception when unique_violation then
      if tries >= 5 then raise; end if;
    end;
  end loop;
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end; $$;
revoke all on function public.save_quotation_version(uuid,jsonb) from anon;
grant execute on function public.save_quotation_version(uuid,jsonb) to authenticated;

-- ============================================================================
-- F) phase91 — organizations.location
-- ============================================================================
alter table public.organizations add column if not exists location text;

-- ============================================================================
-- G) phase92 — quote → CRM lead sync (trigger + one-time missing-lead backfill)
-- ============================================================================
create or replace function public.sync_quote_to_lead()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name  text := nullif(btrim(NEW.client->>'name'), '');
  v_email text := nullif(btrim(NEW.client->>'email'), '');
  v_phone text := nullif(btrim(NEW.client->>'phone'), '');
  v_status text;
  v_lead public.leads;
begin
  if v_name is null then return NEW; end if;
  v_status := case
    when NEW.status = 'cancelled'                          then 'lost'
    when NEW.approval_status = 'paid'
      or NEW.status = 'confirmed'
      or NEW.lifecycle_stage in ('planning','event','settlement','closed') then 'won'
    when NEW.lifecycle_stage = 'discovery'                 then 'discovery'
    else 'quoted' end;
  select * into v_lead from public.leads where quote_id = NEW.id and org_id = NEW.org_id limit 1;
  if v_lead.id is null then
    select * into v_lead from public.leads
     where org_id = NEW.org_id and quote_id is null
       and ( (v_email is not null and lower(coalesce(email,'')) = lower(v_email))
          or (v_email is null and lower(coalesce(name,'')) = lower(v_name)) )
     order by updated_at desc limit 1;
  end if;
  if v_lead.id is not null then
    update public.leads set
      name       = v_name,
      email      = coalesce(v_email, email),
      phone      = coalesce(v_phone, phone),
      event_type = coalesce(NEW.event_type, event_type),
      event_date = coalesce(NEW.event_date, event_date),
      status     = case when status in ('won','lost') and v_status in ('quoted','discovery')
                        then status else v_status end,
      quote_id   = NEW.id,
      updated_at = now()
     where id = v_lead.id;
  else
    insert into public.leads (org_id, name, phone, email, source, event_type, event_date, status, quote_id)
      values (NEW.org_id, v_name, v_phone, v_email, 'quote', NEW.event_type, NEW.event_date, v_status, NEW.id);
  end if;
  return NEW;
end; $$;

drop trigger if exists quotes_sync_lead_ins on public.quotes;
create trigger quotes_sync_lead_ins after insert on public.quotes
  for each row execute function public.sync_quote_to_lead();

drop trigger if exists quotes_sync_lead_upd on public.quotes;
create trigger quotes_sync_lead_upd after update on public.quotes
  for each row
  when ( NEW.client          is distinct from OLD.client
      or NEW.status          is distinct from OLD.status
      or NEW.approval_status is distinct from OLD.approval_status
      or NEW.lifecycle_stage is distinct from OLD.lifecycle_stage
      or NEW.event_type      is distinct from OLD.event_type
      or NEW.event_date      is distinct from OLD.event_date )
  execute function public.sync_quote_to_lead();

-- one-time backfill: only quotes with a client but NO linked lead (never touches existing)
insert into public.leads (org_id, name, phone, email, source, event_type, event_date, status, quote_id)
select q.org_id,
       nullif(btrim(q.client->>'name'), ''),
       nullif(btrim(q.client->>'phone'), ''),
       nullif(btrim(q.client->>'email'), ''),
       'quote', q.event_type, q.event_date,
       case when q.status = 'cancelled' then 'lost'
            when q.status = 'confirmed' or q.approval_status = 'paid' then 'won'
            else 'quoted' end,
       q.id
from public.quotes q
where coalesce(btrim(q.client->>'name'), '') <> ''
  and not exists (select 1 from public.leads l where l.quote_id = q.id);

-- ============================================================================
-- H) phase93 — public_get_proposal returns pricing + total
-- ============================================================================
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal where share_token = p_token and published = true;
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
grant execute on function public.public_get_proposal(uuid) to anon, authenticated;

commit;

-- Reload PostgREST's schema cache so the new columns/functions are exposed.
notify pgrst, 'reload schema';

-- Next: run WAVE-05-VERIFY.sql (read-only) to confirm every result.
