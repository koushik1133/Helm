-- =====================================================================
-- SEC-05 — SQL audit fixes (definer grants, tenant isolation, storage)
-- =====================================================================
-- Source: an audit of the EFFECTIVE (last CREATE OR REPLACE in apply order)
-- definition of every SECURITY DEFINER function, RLS policy, storage policy and
-- view. Only confirmed issues that no later file already fixes are addressed
-- here. Every change is additive, idempotent and reversible (see ROLLBACK).
--
-- FINDINGS FIXED HERE
--  F1 (HIGH, cross-tenant) Channel flags are read from ANY org.
--     phase74 made _flag()/_notify() org-scoped, but WAVE-05-UPGRADE.sql (applied
--     later) re-created _flag(text) as "newest 'channels' row of ANY org" and
--     _notify() on top of it. The effective request_otp (PROD-01-APPLY.sql, from
--     W15B-05) and create_payment (WAVE-05) call that 1-arg _flag(). The prod
--     extraction (HELM-STAGING-SCHEMA.sql) confirms the global body is live.
--     Any studio admin (any self-signup is admin of its own studio) can UPDATE
--     its own app_config 'channels' row ("cfg write" RLS) and flip, for EVERY
--     tenant: otp_dev_echo=true (request_otp returns the OTP to the caller, so
--     phone verification is bypassed), sms_live/pay_live (OTP and payment flows
--     break for all studios). create_studio also copies app_config with
--     updated_at=now(), so the newest studio's copy silently becomes global.
--     FIX: re-apply phase74's org-scoped _flag/_notify; request_otp and
--     create_payment read the flag of the QUOTE's org (q.org_id). Bodies are
--     the latest definitions, changed only on the _flag(...) lines.
--  F2 (MED, cross-tenant) Proposal share link can expose another tenant's quote.
--     event_proposal's PK is quote_id and phase57 "ra ins" only checks
--     org_id = caller's org, so a tenant can insert a published proposal row,
--     with a share_token it chooses, for ANOTHER tenant's quote_id.
--     public_get_proposal then returns that quote's code/title/client
--     name/pricing, and public_get_portal shows the injected proposal on the
--     victim's client portal. FIX: both functions require the proposal row's
--     org_id to equal the quote's org_id. Legitimate rows always match: they are
--     written only by set_proposal/publish_proposal after assert_quote_org.
--  F3 (MED, cross-tenant) design_advance() had no assert_quote_org: a designer
--     in org A could create the (unique per quote) design_stages row for org B's
--     quote, which blocks B's designer workflow and writes into B's
--     notification feed. FIX: add assert_quote_org (the latest body is otherwise
--     unchanged).
--  F4 (MED, cross-tenant info) helm_total_paid(uuid,uuid,uuid) is SECURITY
--     DEFINER with no auth check and was never revoked, so anyone (incl. anon)
--     can read the paid total of any quote. It is only called by the
--     overpayment triggers, which run as the definer owner. FIX: revoke from
--     public/anon/authenticated. Same for the internal _flag() overloads
--     (phase74 granted them to anon).
--  F5 (LOW, defence-in-depth) "revoke ... from anon" does NOT remove EXECUTE:
--     Postgres grants EXECUTE to PUBLIC on creation, so anon still inherits it.
--     Most authenticated-only RPCs only ever revoked anon, so anon can still
--     call them (each one fails closed through its own can_edit/has_area/org
--     check). FIX: revoke from PUBLIC+anon and grant to authenticated on the
--     RPCs the app calls only from a signed-in session. The anon-facing token
--     RPCs and the helpers that RLS policies evaluate are deliberately NOT in
--     the list.
--  F6 (MED, public storage) invite-media bucket (phase88):
--     (a) "invite_media_public_read" gives SELECT on storage.objects to everyone,
--         so anon can LIST the whole bucket and enumerate every tenant's
--         <org_id>/<quote_id>/ paths. Those quote ids feed F2. Public URLs of a
--         public bucket do not need an RLS policy.
--     (b) there is no MIME or size allow-list, so org members can publish
--         HTML/SVG from the project's storage origin.
--     FIX: replace the public SELECT with an own-org SELECT for authenticated,
--     and allow raster images only, up to 10 MB. The app uploads only
--     <input accept="image/*"> photos with upsert:false and renders them with
--     getPublicUrl(). Music is a URL field and is never uploaded.
--  F7 (LOW-MED, role escalation) invitations "inv ins/upd/del" RLS only needs
--     has_area('users','edit'), so a NON-admin given that area can insert an
--     invitation with role='admin' for an address they own, accept it, and
--     become admin. This bypasses create_invitation's is_admin() check. FIX:
--     writes require is_admin(). The app creates invites through the
--     create_invitation RPC (definer, bypasses RLS) and revokes them only from
--     the admin-only Users pane.
--  F8 (LOW, within-org) organizations "org self write" lets ANY member (crew,
--     client, ...) rewrite studio settings, including business_email, which
--     receives payment notifications. FIX: require is_admin() or
--     has_area('controls','edit'). These are the same people who can save the
--     other Control Center config.
--  F9 (LOW, view) inventory_availability must run as the invoker. phase7 creates
--     it WITH (security_invoker=true), but the prod extraction re-creates it
--     without that option. FIX: force security_invoker (no-op if already set)
--     and revoke anon. The app does not read this view.
--  F10 (MED, within-org) Quote-editing RPCs (generate_approval_token,
--     save_quotation_version, record_payment, set_discovery, set_event_plan,
--     set_proposal) check only the fixed can_edit() role list. A role the
--     role_access matrix makes read-only on quotes can still write through them
--     from flow.html. By default that is `operations`, plus any customised
--     view-only role. FIX: also require edit on the calling page's area.
--  F11 (MED, within-org) mark_paid: any can_edit() role could mark a quote paid.
--     FIX: admin/manager only.
--  F12 (MED, within-org) QC pass/reject: verify_task() is role-checked, but
--     direct PATCH of event_tasks.verify_status by any staff-area editor
--     bypassed it. FIX: BEFORE trigger guarding the verify_* columns for direct
--     API writes only.
--
--  ALREADY ENFORCED SERVER-SIDE (no change): admin_set_role / admin_delete_user /
--  admin_create_user (is_admin + org, phase73 L442/L454/L466),
--  admin_create_user_temp (phase100 L31), role_access matrix writes
--  (admin_set_role_access is_admin at phase57 L81; role_access RLS has only the
--  "ra read" SELECT policy at phase57 L198, so direct writes are denied), and
--  direct writes to quote/event tables (phase57 L159-161 "ra ins/upd/del" require
--  has_area(area,'edit') + org). nurture_automation `.eq("id",1)` is org-scoped
--  by phase57 RLS + phase59 PK (org_id,id).
--
-- Run each section as its own statement(s): Supabase shows only the last result.
-- Apply on STAGING first (see README), then PRODUCTION.
-- =====================================================================


-- =====================================================================
-- ---- PRECHECK (read-only) ----
-- =====================================================================

-- P1: is _flag(text) still the global (cross-org) body? Expect 'GLOBAL (needs SEC-05)'.
select case when pg_get_functiondef('public._flag(text)'::regprocedure) like '%order by updated_at desc%'
            then 'GLOBAL (needs SEC-05)' else 'org-scoped' end as flag_body;

-- P2: IMPACT of F1. Per org, its OWN channel flags vs the flags every org gets today.
--     Orgs whose own row differs (or is missing) will change behaviour after APPLY.
--     Review before production: make each studio's own 'channels' row correct.
with glob as (
  select value from public.app_config where key='channels' order by updated_at desc limit 1)
select o.id as org_id, o.name,
       c.value as own_channels,
       (select value from glob) as currently_effective_for_everyone,
       (c.value is distinct from (select value from glob)) as will_change
from public.organizations o
left join public.app_config c on c.org_id = o.id and c.key = 'channels'
order by will_change desc, o.name;

-- P3: F2. Proposal rows whose org differs from their quote's org (expect 0; any
--     row here is an anomaly or an injection attempt, so investigate it).
select pr.quote_id, pr.org_id as proposal_org, q.org_id as quote_org, pr.published
from public.event_proposal pr join public.quotes q on q.id = pr.quote_id
where pr.org_id is distinct from q.org_id;

-- P0: prerequisites. Every row must read true, otherwise apply the named file first.
select 'quotes.approval_token_expires_at (wave10)' as needs, exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='approval_token_expires_at') as present
union all select 'event_proposal.share_token_expires_at (prod-rollout/PROD-01-APPLY.sql)', exists (select 1 from information_schema.columns where table_schema='public' and table_name='event_proposal' and column_name='share_token_expires_at')
union all select 'design_stages (completion/PROD-BUNDLE-net-new-builds.sql)', to_regclass('public.design_stages') is not null
union all select 'helm_quote_total(jsonb) (wave15b)', to_regprocedure('public.helm_quote_total(jsonb)') is not null;
-- P0b: F10 requires matrix edit rights. Studios listed here have NO role_access
-- rows, so their non-admin staff are already read-only in the app and stay so
-- via RPC too. Expect 0 rows; for any listed, re-seed its access matrix in the
-- Control Center (Users & access) before applying.
select o.id, o.name from public.organizations o
 where not exists (select 1 from public.role_access ra where ra.org_id = o.id);

-- P4: F3. design_stages rows whose org differs from their quote's org (expect 0).
-- (skipped automatically when design_stages does not exist yet — see P0)
do $$ declare n bigint; begin
  if to_regclass('public.design_stages') is null then raise notice 'P4 skipped: design_stages missing'; return; end if;
  execute 'select count(*) from public.design_stages d join public.quotes q on q.id = d.quote_id where d.org_id is distinct from q.org_id' into n;
  raise notice 'P4 design_stages cross-org rows: %', n;
end $$;

-- P5: F4/F5. Who can execute what today.
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by anon_exec desc, p.proname;

-- P6: F6/F7/F8/F9 current state.
select id, public, allowed_mime_types, file_size_limit from storage.buckets where id = 'invite-media';
select policyname, cmd, roles, qual from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and policyname like 'invite_media%';
select tablename, policyname, cmd, qual, with_check from pg_policies
 where schemaname = 'public' and tablename in ('invitations','organizations') order by tablename, cmd;
select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'inventory_availability';

-- P7 (diagnostic only, not changed by SEC-05): any public-table policy that is
--     unconditionally TRUE. Canonically phase57 replaced all of these; a row here
--     means a legacy base file (otp-payments.sql, phase7, phase33, ...) was re-run.
select tablename, policyname, cmd, roles, qual, with_check from pg_policies
 where schemaname = 'public' and (btrim(qual) = 'true' or btrim(with_check) = 'true');


-- =====================================================================
-- ---- APPLY (idempotent) ----
-- =====================================================================
begin;

-- PREREQUISITES — abort (nothing changed) if the database is missing an earlier
-- migration these function bodies depend on. The production snapshot in
-- HELM-STAGING-SCHEMA.sql is from 2026-09-25; the items below arrived later.
do $$
declare missing text[] := '{}';
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='approval_token_expires_at')
    then missing := array_append(missing, 'quotes.approval_token_expires_at (wave10 / W15B-04)'::text); end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='event_proposal' and column_name='share_token_expires_at')
    then missing := array_append(missing, 'event_proposal.share_token_expires_at (prod-rollout/PROD-01-APPLY.sql or wave15b/W15B-05)'::text); end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='design_stages' and column_name='revision')
    then missing := array_append(missing, 'design_stages (completion/PROD-BUNDLE-net-new-builds.sql)'::text); end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='event_tasks' and column_name='verify_status')
    then missing := array_append(missing, 'event_tasks.verify_status (phase35)'::text); end if;
  if to_regprocedure('public.helm_quote_total(jsonb)') is null then missing := array_append(missing, 'helm_quote_total(jsonb) (wave15b)'::text); end if;
  if to_regprocedure('public.assert_quote_org(uuid)') is null then missing := array_append(missing, 'assert_quote_org(uuid) (phase73)'::text); end if;
  if to_regprocedure('public.has_area(text,text)') is null then missing := array_append(missing, 'has_area(text,text) (phase57)'::text); end if;
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null then missing := array_append(missing, 'extensions.gen_random_bytes (pgcrypto)'::text); end if;
  if array_length(missing,1) > 0 then
    raise exception 'SEC-05 not applied — apply these first: %', array_to_string(missing, '; ');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- F1  org-scoped channel flags (re-applies phase74, fixes WAVE-05 regression)
-- ---------------------------------------------------------------------
create or replace function public._flag(p text, p_org uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select (value->>p)::boolean from public.app_config
                   where key='channels' and org_id = p_org), false);
$$;

-- 1-arg form kept for compatibility, now scoped to the CALLER's org (phase74 body).
create or replace function public._flag(p text) returns boolean
  language sql stable security definer set search_path = public as $$
  select public._flag(p, public.current_org_id());
$$;

-- _notify: live/simulated decided by the QUOTE's org (phase74 body).
create or replace function public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare live boolean; v_org uuid;
begin
  v_org := (select org_id from public.quotes where id = p_quote);   -- quote's org, not the caller's
  live := case p_channel when 'sms' then public._flag('sms_live', v_org)
                         when 'email' then public._flag('email_live', v_org) else false end;
  insert into public.notifications(quote_id,channel,recipient,kind,status,detail)
    values (p_quote,p_channel,p_to,p_kind, case when live then 'sent' else 'simulated' end, coalesce(p_detail,'{}'::jsonb));
end; $$;

-- request_otp: latest body (PROD-01-APPLY.sql / W15B-05, CSPRNG); ONLY change is
-- _flag(..) -> _flag(.., q.org_id) on the two flag reads.
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
  live := public._flag('sms_live', q.org_id);                              -- SEC-05: quote's org
  if live then
    return jsonb_build_object('sent', true, 'live', true, 'delivery', 'sms', 'dev_code', null);
  elsif public._flag('otp_dev_echo', q.org_id) then                        -- SEC-05: quote's org
    return jsonb_build_object('sent', true, 'live', false, 'delivery', 'dev_echo', 'dev_code', code);
  else
    return jsonb_build_object('sent', false, 'live', false, 'delivery', 'unavailable', 'dev_code', null,
      'message', 'OTP delivery is not configured. Enable a live SMS provider (sms_live=true) or, for local development only, set channels.otp_dev_echo=true in app_config.');
  end if;
end; $$;

-- create_payment: latest body (WAVE-05-UPGRADE.sql, identical to the prod
-- extraction); ONLY change is _flag('pay_live') -> _flag('pay_live', q.org_id).
create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; amt numeric; pid uuid; link text; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  if q.approval_status not in ('approved','paid') then raise exception 'approve the terms first'; end if;
  amt := coalesce((q.pricing->>'total')::numeric, 0);
  live := public._flag('pay_live', q.org_id);                              -- SEC-05: quote's org
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

-- anon-facing token RPCs keep their existing grants (CREATE OR REPLACE preserves
-- them); re-assert so a fresh install matches.
grant execute on function public.request_otp(uuid,text)  to anon, authenticated;
grant execute on function public.create_payment(uuid)    to anon, authenticated;

-- ---------------------------------------------------------------------
-- F2  proposal/portal: proposal row must belong to the quote's org
-- ---------------------------------------------------------------------
-- public_get_proposal: latest body (PROD-01-APPLY.sql, W15B-05 expiry guard);
-- ONLY change: the quote is read with "and org_id = pr.org_id" and a mismatch is
-- treated as an invalid link.
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal
    where share_token = p_token and published = true
      and (share_token_expires_at is null or share_token_expires_at > now());       -- CF: honour expiry
  if pr.quote_id is null then raise exception 'invalid or unpublished link'; end if;
  select * into q from public.quotes where id = pr.quote_id and org_id = pr.org_id;   -- SEC-05: same tenant
  if q.id is null then raise exception 'invalid or unpublished link'; end if;         -- SEC-05
  return jsonb_build_object(
    'concept', pr.concept, 'theme', pr.theme, 'palette', pr.palette,
    'images', pr.images, 'scope', pr.scope,
    'event_code', q.code, 'event_title', q.title, 'event_type', q.event_type,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing,
    'total', coalesce((q.pricing->>'total')::numeric, 0));
end; $$;
grant execute on function public.public_get_proposal(uuid) to anon, authenticated;

-- public_get_portal: latest body (wave10/WAVE-10-PROD-UPGRADE.sql: expiry guard +
-- 'studio' branding that portal.html reads); ONLY change: the proposal is read
-- with "and org_id = q.org_id".
create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; prop public.event_proposal; ms jsonb; gal jsonb; outstanding numeric; studio jsonb;
begin
  select * into q from public.quotes
    where approval_token = p_token
      and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select * into prop from public.event_proposal where quote_id = q.id and org_id = q.org_id;   -- SEC-05: same tenant
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
end; $$;
grant execute on function public.public_get_portal(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- F3  design_advance: the quote must be in the caller's org
-- ---------------------------------------------------------------------
-- Latest body (completion/PROD-BUNDLE-net-new-builds.sql); ONLY change: one
-- added "perform public.assert_quote_org(p_quote_id);" before the seed insert.
create or replace function public.design_advance(
  p_quote_id uuid, p_to_state text, p_note text default null, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_uid uuid := auth.uid();
  v_cur text;
  v_rev integer;
  v_upd timestamptz;
  v_allowed boolean := false;
begin
  if not public.has_area('design','edit') then
    raise exception 'not authorized for design' using errcode='42501';
  end if;
  perform public.assert_quote_org(p_quote_id);   -- SEC-05: never seed/advance another tenant's quote

  -- ensure a record exists (first advance seeds draft_2d)
  insert into public.design_stages (quote_id, state, org_id, updated_by)
  values (p_quote_id, 'draft_2d', v_org, v_uid)
  on conflict (quote_id) do nothing;

  select state, revision, updated_at into v_cur, v_rev, v_upd
  from public.design_stages
  where quote_id = p_quote_id and org_id = v_org
  for update;
  if not found then raise exception 'no such event in this org'; end if;

  -- optimistic lock (only when caller supplies the expected timestamp)
  if p_expected_updated_at is not null and v_upd is distinct from p_expected_updated_at then
    raise exception 'design record changed, reload' using errcode='40001';
  end if;

  -- allowed transitions (state machine). 'revise' loops back and bumps revision.
  v_allowed := (v_cur, p_to_state) in (
    ('draft_2d','internal_review'),
    ('internal_review','approved_2d'),
    ('internal_review','revise'),
    ('revise','draft_2d'),
    ('approved_2d','build_3d'),
    ('build_3d','client_review'),
    ('client_review','approved_3d'),
    ('client_review','revise'),
    ('approved_3d','locked'),
    ('approved_3d','client_review')   -- re-open for a further client tweak before lock
  );
  if not v_allowed then
    raise exception 'illegal design transition: % -> %', v_cur, p_to_state using errcode='22023';
  end if;

  update public.design_stages
     set state = p_to_state,
         revision = case when p_to_state = 'revise' then revision + 1 else revision end,
         note = coalesce(p_note, note),
         updated_at = now(),
         updated_by = v_uid
   where quote_id = p_quote_id and org_id = v_org;

  insert into public.audit_log (actor, action, entity, entity_id, quote_id, changed, org_id)
  values (v_uid, 'design.advance', 'design_stages', p_quote_id::text, p_quote_id,
          jsonb_build_object('from', v_cur, 'to', p_to_state, 'note', p_note), v_org);

  insert into public.notifications (quote_id, channel, kind, status, detail)
  values (p_quote_id, 'in_app', 'design_'||p_to_state, 'simulated',
          jsonb_build_object('from', v_cur, 'to', p_to_state));

  return jsonb_build_object('quote_id', p_quote_id, 'state', p_to_state,
    'revision', case when p_to_state='revise' then v_rev+1 else v_rev end, 'as_of', now());
end; $$;
revoke all on function public.design_advance(uuid, text, text, timestamptz) from anon, public;
grant execute on function public.design_advance(uuid, text, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- F4  internal-only definer helpers: nobody but the definer owner calls them
-- ---------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('helm_total_paid','_flag')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- F5  authenticated-only RPCs: remove the implicit PUBLIC (and anon) EXECUTE
-- ---------------------------------------------------------------------
-- NOT in this list on purpose (anon-facing, or evaluated by RLS policies that
-- also apply to anon): public_get_quote, request_otp, verify_and_consent,
-- create_payment, public_get_portal, public_get_proposal, public_event_site,
-- worker_get_tasks, worker_respond, worker_get_equipment,
-- worker_checkin_equipment, invitation_by_token (anon invite-banner lookup:
-- owned by SEC-06, left untouched here),
-- current_org_id, has_area, user_role, is_admin, can_edit, can_create,
-- can_delete, assert_quote_org, password_change_required, get_pricing_config.
do $$
declare fn record;
  names text[] := array[
    'accept_invitation','add_event_dish','add_quote_version','adjust_inventory_total',
    'admin_create_user','admin_create_user_temp','admin_delete_user','admin_get_role_access',
    'admin_set_role','admin_set_role_access','apply_menu_template','assign_tasks',
    'assign_tasks_vendor','bell_feed','bell_mark_seen','checkin_equipment','checkout_equipment',
    'clear_password_change_required','close_event','confirm_quote','convert_lead_to_quote',
    'create_event_site','create_invitation','create_quote','create_studio','delete_quote',
    'design_advance','design_get','design_queue','event_activity','export_org_data',
    'export_tenant_organization_package','generate_approval_token','layouts_quarantined_count',
    'list_event_files','mark_paid','mgr_notify','my_pending','my_tasks','nurture_due',
    'publish_event_site','publish_proposal','queue_nurture_greeting','reassign_task',
    'rebrand_quote_code','record_payment','record_settlement_payment','remove_event_dish',
    'revoke_approval_token','revoke_work_token','run_nurture_auto','run_task_reminders',
    'run_task_triggers','save_quotation_version','set_closure','set_discovery',
    'set_event_dish_qty','set_event_plan','set_lifecycle_stage','set_plan_lock',
    'set_plan_signoff','set_pricing_config','set_proposal','set_task_schedule',
    'set_task_special','task_verify_summary','verify_task'];
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(names)
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- F10  quote-editing RPCs must honour the role_access matrix, not just can_edit()
-- ---------------------------------------------------------------------
-- can_edit() is a fixed ROLE list (admin, planner, sales, operations, manager).
-- The pages that call these RPCs gate on the matrix instead: flow.html and
-- quotes.html use canEditArea("quotes"), discovery.html uses "discovery",
-- plan.html "plan" and proposal.html "proposal". So a role the matrix makes
-- READ-ONLY on quotes can still write through them. By default that is
-- `operations` (quotes view only), and the same holds for any role an admin
-- sets to view-only. Direct table writes are already blocked by phase57 RLS
-- ("ra ins/upd/del" require has_area(area,'edit')). These RPCs are the gap.
-- FIX: keep can_edit() and ALSO require edit on the area of a page that calls
-- the RPC. Bodies are the latest definitions with ONE added line each.
-- generate_approval_token: latest body from supabase/wave5/WAVE-05-UPGRADE.sql
create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit')) then raise exception 'not authorized' using errcode='42501'; end if;   -- SEC-05 F10
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
-- save_quotation_version: latest body from supabase/prod-rollout/PROD-01-APPLY.sql (W15B-01)
create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $sv$
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit')) then raise exception 'not authorized' using errcode='42501'; end if;   -- SEC-05 F10
  perform public.assert_quote_org(p_quote);
  tot := public.helm_quote_total(p_pricing);               -- authoritative
  if p_pricing is not null and jsonb_typeof(p_pricing)='object' then
    p_pricing := jsonb_set(p_pricing, '{total}', to_jsonb(tot));   -- never keep client total
  end if;
  select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
  lbl := 'Q'||n;
  insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
    values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid());
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end $sv$;
-- record_payment: latest body from supabase/wave5/WAVE-05-UPGRADE.sql
create or replace function public.record_payment(
  p_quote uuid, p_amount numeric, p_method text default 'cash',
  p_receipt_no text default null, p_milestone uuid default null, p_note text default null,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; rno text; seqn int; studio_email text; existing public.quote_payments; tries int := 0;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('finance','edit')) then raise exception 'not authorized' using errcode='42501'; end if;   -- SEC-05 F10
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
-- set_discovery: latest body from supabase/phase73-definer-org-isolation-final.sql
create or replace function public.set_discovery(
  p_quote_id uuid, p_meet_date date, p_mode text, p_location text,
  p_attendees text, p_notes text, p_budget_min numeric, p_budget_max numeric
) returns public.event_discovery language plpgsql security definer set search_path = public as $$
declare d public.event_discovery;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('discovery','edit')) then raise exception 'not authorized' using errcode='42501'; end if;   -- SEC-05 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_discovery
    (quote_id, meet_date, mode, location, attendees, notes, budget_min, budget_max, updated_at, updated_by)
  values
    (p_quote_id, p_meet_date, p_mode, p_location, p_attendees, p_notes, p_budget_min, p_budget_max, now(), auth.uid())
  on conflict (quote_id) do update set
    meet_date=excluded.meet_date, mode=excluded.mode, location=excluded.location,
    attendees=excluded.attendees, notes=excluded.notes,
    budget_min=excluded.budget_min, budget_max=excluded.budget_max,
    updated_at=now(), updated_by=auth.uid()
  returning * into d;
  return d;
end; $$;
-- set_event_plan: latest body from supabase/phase73-definer-org-isolation-final.sql
create or replace function public.set_event_plan(
  p_quote_id uuid, p_venue_name text, p_venue_address text, p_venue_contact text,
  p_access_notes text, p_package text, p_menu text
) returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('plan','edit')) then raise exception 'not authorized' using errcode='42501'; end if;   -- SEC-05 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_plan (quote_id, venue_name, venue_address, venue_contact, access_notes, package, menu, updated_at, updated_by)
  values (p_quote_id, p_venue_name, p_venue_address, p_venue_contact, p_access_notes, p_package, p_menu, now(), auth.uid())
  on conflict (quote_id) do update set
    venue_name=excluded.venue_name, venue_address=excluded.venue_address, venue_contact=excluded.venue_contact,
    access_notes=excluded.access_notes, package=excluded.package, menu=excluded.menu,
    updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;
-- set_proposal: latest body from supabase/phase73-definer-org-isolation-final.sql
create or replace function public.set_proposal(
  p_quote_id uuid, p_concept text, p_theme text,
  p_palette jsonb, p_images jsonb, p_scope jsonb
) returns public.event_proposal language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('proposal','edit')) then raise exception 'not authorized' using errcode='42501'; end if;   -- SEC-05 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_proposal (quote_id, concept, theme, palette, images, scope, updated_at, updated_by)
  values (p_quote_id, p_concept, p_theme,
          coalesce(p_palette,'[]'::jsonb), coalesce(p_images,'[]'::jsonb), coalesce(p_scope,'[]'::jsonb),
          now(), auth.uid())
  on conflict (quote_id) do update set
    concept=excluded.concept, theme=excluded.theme, palette=excluded.palette,
    images=excluded.images, scope=excluded.scope, updated_at=now(), updated_by=auth.uid()
  returning * into pr;
  return pr;
end; $$;
-- ---------------------------------------------------------------------
-- F11  mark_paid is a manager/admin action
-- ---------------------------------------------------------------------
-- quotes.html "Mark paid" is the manual/dev override for a payment the Razorpay
-- webhook normally records ("In production this is automatic via the Razorpay
-- webhook"). The server let ANY can_edit() role (planner, sales, operations)
-- flip a quote to paid. FIX: also require role admin or manager. Latest body
-- from supabase/wave5/WAVE-05-UPGRADE.sql with ONE added line.
-- NOTE: quotes.html still shows the button to every quotes editor; for
-- planner/sales it will now return "not authorized" (front-end follow-up).
create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not (coalesce(public.user_role(),'') in ('admin','manager')) then raise exception 'not authorized' using errcode='42501'; end if;   -- SEC-05 F11
  perform public.assert_quote_org(p_quote_id);
  -- one payment settles the quote: mark only the NEWEST open row paid and cancel
  -- the other open rows (marking every open link "paid" over-recorded receipts)
  update public.quote_payments set status='paid', paid_at=now(), provider_ref=coalesce(p_provider_ref,provider_ref)
    where id = (select id from public.quote_payments where quote_id=p_quote_id and status='created'
                order by created_at desc limit 1);
  update public.quote_payments set status='cancelled'
    where quote_id=p_quote_id and status='created';
  update public.quotes set approval_status='paid', updated_at=now()
    where id=p_quote_id and org_id = public.current_org_id() returning * into q;
  perform public._notify(p_quote_id,'email', q.client->>'email','payment_receipt', jsonb_build_object('code',q.code));
  perform public._notify(p_quote_id,'sms',   q.client->>'phone','payment_receipt', jsonb_build_object('code',q.code));
  return jsonb_build_object('paid', true);
end; $$;
revoke all on function public.generate_approval_token(uuid) from public, anon;
grant execute on function public.generate_approval_token(uuid) to authenticated;
revoke all on function public.mark_paid(uuid,text) from public, anon;
grant execute on function public.mark_paid(uuid,text) to authenticated;
revoke all on function public.record_payment(uuid,numeric,text,text,uuid,text,text) from public, anon;
grant execute on function public.record_payment(uuid,numeric,text,text,uuid,text,text) to authenticated;
revoke all on function public.save_quotation_version(uuid,jsonb) from public, anon;
grant execute on function public.save_quotation_version(uuid,jsonb) to authenticated;
revoke all on function public.set_discovery(uuid,date,text,text,text,text,numeric,numeric) from public, anon;
grant execute on function public.set_discovery(uuid,date,text,text,text,text,numeric,numeric) to authenticated;
revoke all on function public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb) from public, anon;
grant execute on function public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb) to authenticated;
revoke all on function public.set_event_plan(uuid,text,text,text,text,text,text) from public, anon;
grant execute on function public.set_event_plan(uuid,text,text,text,text,text,text) to authenticated;

-- ---------------------------------------------------------------------
-- F12  QC verdict columns on event_tasks can only be set by a QC role
-- ---------------------------------------------------------------------
-- verify_task() (phase72) already restricts pass/reject to admin/manager/
-- planner/quality. But phase57 "ra upd" lets ANY staff-area editor PATCH
-- event_tasks directly (e.g. /rest/v1/event_tasks?id=eq.X {verify_status:
-- 'passed'}), which skips that check. The app never writes event_tasks directly.
-- Every write goes through SECURITY DEFINER RPCs (verify_task, worker_respond,
-- assign_tasks, reassign_task, ...), which run as the function owner. So this
-- guard fires ONLY for direct API writes (current_user = authenticated/anon).
-- It still allows the automatic unverified -> pending hand-off done by
-- tg_task_verify.
create or replace function public.tg_guard_task_verify() returns trigger
  language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated','anon') then return new; end if;   -- definer RPCs / service
  if coalesce(public.user_role(),'') in ('admin','manager','planner','quality') then return new; end if;
  if tg_op = 'INSERT' then
    if coalesce(new.verify_status,'unverified') not in ('unverified','pending')
       or new.verified_by is not null or new.verified_at is not null then
      raise exception 'only a quality engineer or manager can verify tasks' using errcode='42501';
    end if;
    return new;
  end if;
  if (new.verify_status is distinct from old.verify_status
        and not (old.verify_status = 'unverified' and new.verify_status = 'pending'))
     or new.verified_by is distinct from old.verified_by
     or new.verified_at is distinct from old.verified_at
     or new.verify_note is distinct from old.verify_note then
    raise exception 'only a quality engineer or manager can verify tasks' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.tg_guard_task_verify() from public, anon, authenticated;
drop trigger if exists zz_task_verify_guard on public.event_tasks;   -- "zz_" fires after task_verify_trg
create trigger zz_task_verify_guard before insert or update on public.event_tasks
  for each row execute function public.tg_guard_task_verify();

-- ---------------------------------------------------------------------
-- F7  invitations: only an admin may write invitation rows directly
-- ---------------------------------------------------------------------
drop policy if exists "inv ins" on public.invitations;
drop policy if exists "inv upd" on public.invitations;
drop policy if exists "inv del" on public.invitations;
create policy "inv ins" on public.invitations for insert to authenticated
  with check ( public.is_admin() and org_id = (select public.current_org_id()) );
create policy "inv upd" on public.invitations for update to authenticated
  using ( public.is_admin() and org_id = (select public.current_org_id()) )
  with check ( public.is_admin() and org_id = (select public.current_org_id()) );
create policy "inv del" on public.invitations for delete to authenticated
  using ( public.is_admin() and org_id = (select public.current_org_id()) );

-- ---------------------------------------------------------------------
-- F8  organizations: studio settings writable by admin / controls editors only
-- ---------------------------------------------------------------------
drop policy if exists "org self write" on public.organizations;
create policy "org self write" on public.organizations for update to authenticated
  using ( id = (select public.current_org_id())
          and (public.is_admin() or public.has_area('controls','edit')) )
  with check ( id = (select public.current_org_id())
               and (public.is_admin() or public.has_area('controls','edit')) );

-- ---------------------------------------------------------------------
-- F9  inventory_availability runs with the caller's RLS
-- ---------------------------------------------------------------------
alter view if exists public.inventory_availability set (security_invoker = true);
do $$ begin
  if to_regclass('public.inventory_availability') is not null then
    execute 'revoke all on public.inventory_availability from anon';
  end if;
end $$;

commit;
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- F6  invite-media bucket: no public listing; raster images only, 10 MB
--     Kept OUTSIDE the transaction above: if your SQL-editor role cannot alter
--     storage.* this part fails on its own without undoing F1-F5/F7-F9.
-- ---------------------------------------------------------------------
drop policy if exists "invite_media_public_read" on storage.objects;
drop policy if exists "invite_media_org_read" on storage.objects;
create policy "invite_media_org_read" on storage.objects
  for select to authenticated
  using ( bucket_id = 'invite-media'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text );
-- (public URLs of a PUBLIC bucket are served without consulting RLS, so guests
--  on invite.html keep seeing the photos.)

do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema='storage' and table_name='buckets' and column_name='allowed_mime_types') then
    update storage.buckets
       set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif',
                                      'image/avif','image/heic','image/heif'],
           file_size_limit    = 10485760   -- 10 MB (the UI already skips files over 8 MB)
     where id = 'invite-media';
  end if;
end $$;



-- =====================================================================
-- ---- VERIFY (run last; every row must read PASS) ----
-- =====================================================================
select 'F1 _flag(text) org-scoped' as check,
       case when pg_get_functiondef('public._flag(text)'::regprocedure) like '%current_org_id%'
             and pg_get_functiondef('public._flag(text)'::regprocedure) not like '%order by updated_at%'
            then 'PASS' else 'FAIL' end as status
union all
select 'F1 request_otp/create_payment/_notify use the quote org flag',
       case when pg_get_functiondef('public.request_otp(uuid,text)'::regprocedure) like '%_flag(''otp_dev_echo'', q.org_id)%'
             and pg_get_functiondef('public.create_payment(uuid)'::regprocedure)   like '%_flag(''pay_live'', q.org_id)%'
             and pg_get_functiondef('public._notify(uuid,text,text,text,jsonb)'::regprocedure) like '%v_org%'
            then 'PASS' else 'FAIL' end
union all
select 'F1 anon keeps the approval flow',
       case when has_function_privilege('anon','public.request_otp(uuid,text)','EXECUTE')
             and has_function_privilege('anon','public.create_payment(uuid)','EXECUTE')
             and has_function_privilege('anon','public.public_get_quote(uuid)','EXECUTE')
             and has_function_privilege('anon','public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)','EXECUTE')
            then 'PASS' else 'FAIL' end
union all
select 'F2 proposal/portal tenant match',
       case when pg_get_functiondef('public.public_get_proposal(uuid)'::regprocedure) like '%org_id = pr.org_id%'
             and pg_get_functiondef('public.public_get_portal(uuid)'::regprocedure)   like '%org_id = q.org_id%'
             and has_function_privilege('anon','public.public_get_portal(uuid)','EXECUTE')
             and has_function_privilege('anon','public.public_get_proposal(uuid)','EXECUTE')
            then 'PASS' else 'FAIL' end
union all
select 'F3 design_advance asserts quote org',
       case when pg_get_functiondef('public.design_advance(uuid,text,text,timestamptz)'::regprocedure) like '%assert_quote_org%'
            then 'PASS' else 'FAIL' end
union all
select 'F4 helm_total_paid/_flag not client-callable',
       case when not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname='public' and p.proname in ('helm_total_paid','_flag')
                 and (has_function_privilege('anon', p.oid, 'EXECUTE')
                   or has_function_privilege('authenticated', p.oid, 'EXECUTE')))
            then 'PASS' else 'FAIL' end
union all
select 'F5 authenticated-only RPCs: anon denied, authenticated allowed',
       case when not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname='public'
                 and p.proname in ('admin_set_role','admin_create_user','admin_delete_user','create_quote',
                                   'confirm_quote','generate_approval_token','mark_paid','record_payment',
                                   'save_quotation_version','set_pricing_config','create_studio','accept_invitation')
                 and (has_function_privilege('anon', p.oid, 'EXECUTE')
                   or not has_function_privilege('authenticated', p.oid, 'EXECUTE')))
            then 'PASS' else 'FAIL' end
union all
select 'F5 anon token RPCs still reachable',
       case when has_function_privilege('anon','public.worker_get_tasks(uuid)','EXECUTE')
             and has_function_privilege('anon','public.public_event_site(text)','EXECUTE')
             and has_function_privilege('anon','public.current_org_id()','EXECUTE')
            then 'PASS' else 'FAIL' end
union all
select 'F6 invite-media: no public SELECT policy',
       case when not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
                                and policyname='invite_media_public_read')
             and exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
                                and policyname='invite_media_org_read')
            then 'PASS' else 'FAIL' end
union all
select 'F6 invite-media: MIME allow-list without svg/html',
       case when (select allowed_mime_types is not null
                     and not ('image/svg+xml' = any(allowed_mime_types))
                     and not ('text/html' = any(allowed_mime_types))
                    from storage.buckets where id='invite-media')
            then 'PASS' else 'FAIL' end
union all
select 'F7 invitation writes admin-only',
       case when (select bool_and(coalesce(qual,'')||coalesce(with_check,'') like '%is_admin%')
                    from pg_policies where schemaname='public' and tablename='invitations'
                     and cmd in ('INSERT','UPDATE','DELETE'))
            then 'PASS' else 'FAIL' end
union all
select 'F8 organizations write gated',
       case when (select bool_and(coalesce(qual,'')||coalesce(with_check,'') like '%has_area%')
                    from pg_policies where schemaname='public' and tablename='organizations' and cmd='UPDATE')
            then 'PASS' else 'FAIL' end
union all
select 'F9 inventory_availability security_invoker',
       case when (select coalesce('security_invoker=true' = any(c.reloptions), false)
                    from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and c.relname='inventory_availability')
            then 'PASS' else 'FAIL (or view absent)' end
union all
select 'F10 quote-editing RPCs check the matrix area',
       case when (select bool_and(pg_get_functiondef(p.oid) like '%SEC-05 F10%')
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname='public'
                     and p.proname in ('generate_approval_token','save_quotation_version','record_payment',
                                       'set_discovery','set_event_plan','set_proposal'))
            then 'PASS' else 'FAIL' end
union all
select 'F11 mark_paid admin/manager only',
       case when pg_get_functiondef('public.mark_paid(uuid,text)'::regprocedure) like '%SEC-05 F11%'
            then 'PASS' else 'FAIL' end
union all
select 'F12 event_tasks QC guard trigger',
       case when exists (select 1 from pg_trigger where tgname = 'zz_task_verify_guard'
                            and tgrelid = 'public.event_tasks'::regclass and not tgisinternal)
            then 'PASS' else 'FAIL' end;


-- =====================================================================
-- ---- ROLLBACK (only if a legitimate flow broke; each block independent) ----
-- =====================================================================
-- F1: re-run the previous bodies of _flag(text), _notify, create_payment from
--     supabase/wave5/WAVE-05-UPGRADE.sql and request_otp from
--     supabase/prod-rollout/PROD-01-APPLY.sql (section W15B-05).  NOTE: that
--     restores the cross-tenant flag read. Prefer fixing the org's own
--     app_config 'channels' row (see PRECHECK P2).
-- F2: re-run public_get_proposal from supabase/prod-rollout/PROD-01-APPLY.sql and
--     public_get_portal from supabase/wave10/WAVE-10-PROD-UPGRADE.sql.
-- F3: re-run design_advance from supabase/completion/PROD-BUNDLE-net-new-builds.sql.
-- F4: grant execute on function public.helm_total_paid(uuid,uuid,uuid) to authenticated;
--     grant execute on function public._flag(text) to authenticated;
--     grant execute on function public._flag(text,uuid) to authenticated;
-- F5: grant execute on function public.<name>(<args>) to public;   -- per function, only if needed
-- F6: drop policy if exists "invite_media_org_read" on storage.objects;
--     create policy "invite_media_public_read" on storage.objects for select using ( bucket_id = 'invite-media' );
--     update storage.buckets set allowed_mime_types = null, file_size_limit = null where id = 'invite-media';
-- F7: recreate "inv ins/upd/del" with public.has_area('users','edit') in place of
--     public.is_admin() (original text: supabase/phase83-invitations.sql).
-- F8: drop policy if exists "org self write" on public.organizations;
--     create policy "org self write" on public.organizations for update to authenticated
--       using ( id = (select public.current_org_id()) ) with check ( id = (select public.current_org_id()) );
-- F10: re-run the bodies named in the F10 comments (WAVE-05-UPGRADE.sql,
--      PROD-01-APPLY.sql W15B-01, phase73-definer-org-isolation-final.sql).
-- F11: re-run mark_paid from supabase/wave5/WAVE-05-UPGRADE.sql.
-- F12: drop trigger if exists zz_task_verify_guard on public.event_tasks;
--      drop function if exists public.tg_guard_task_verify();
-- F9: alter view public.inventory_availability reset (security_invoker);
--     grant select on public.inventory_availability to anon;
