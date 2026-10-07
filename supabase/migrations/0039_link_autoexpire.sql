-- ============================================================================
-- 0039_link_autoexpire.sql — CANONICAL forward-only. OPTIONAL per-studio rule:
-- "client links stop working N days after they were sent" (calendar days,
-- weekends included). Default OFF; N defaults to 10; allowed 1–365. Set by a studio
-- ADMIN in Control Center (admin_set_link_autoexpire), every change audited.
--
-- What it covers (every link Helm hands to someone outside the studio):
--   client approval link / client portal / payment (same approval token) —
--     public_get_quote, public_get_portal, request_otp, verify_and_consent,
--     create_payment, payment_link_begin (+ the Razorpay link it opens is capped
--     at the same moment), otp_send_authorize ........ counted from when the token
--                                                       was issued
--   proposal link — public_get_proposal ................ from when the link was made
--   crew task link — every worker_* RPC (_work_token_live) from the last time the
--                                                       link was sent (created, or a
--                                                       new task assigned to that person)
--   invitation website + its photos — event_site_live_until ... from publish time
--
-- The rule only ever SHORTENS: a link stops at the EARLIER of this and the existing
-- event-based window (0012/0022/0023). Nothing is rewritten: the age is computed at
-- check time, so switching it on applies to links already out there, and switching it
-- off (or raising N) brings them back. Sending again gives a fresh link: "Send
-- approval link" / publishing a proposal hands out a NEW token when the old one is
-- past the age limit (a revoked or event-expired link keeps today's behaviour), and
-- assigning a crew task re-starts that person's link age.
--
-- Drift-safe: every public entry point gets a thin wrapper and keeps each project's
-- OWN body (renamed *__pre0039; API roles can't call it directly), exactly like 0022.
-- Additive + idempotent: two new tables (settings, link issue times), two AFTER
-- triggers, no column added to an existing table, no existing row changed or deleted.
-- One-time fill of the issue-time table for links already out there: approval tokens
-- from the audit log (when the token was set), else the quote's creation time;
-- proposal tokens from the proposal's last-saved time.
-- ============================================================================

-- ---- 1) the setting (one row per studio; no row = OFF) ----------------------
create table if not exists public.org_link_autoexpire (
  org_id     uuid primary key references public.organizations(id),
  enabled    boolean not null default false,
  days       int not null default 10,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint org_link_autoexpire_days_chk check (days between 1 and 365)
);
alter table public.org_link_autoexpire enable row level security;
revoke all on public.org_link_autoexpire from public, anon, authenticated;   -- RPCs only
grant select on public.org_link_autoexpire to service_role;

-- ---- 2) when each token was issued -------------------------------------------
create table if not exists public.client_link_issued (
  kind      text not null,                     -- 'quote' (approval/portal/payment) | 'proposal'
  token     uuid not null,
  quote_id  uuid,                               -- for tracing only (the quote's own org is read live)
  issued_at timestamptz not null default now(),
  source    text not null default 'trigger',   -- trigger | audit_log | quote_created | proposal_saved
  primary key (kind, token),
  constraint client_link_issued_kind_chk check (kind in ('quote', 'proposal'))
);
alter table public.client_link_issued enable row level security;
revoke all on public.client_link_issued from public, anon, authenticated;     -- internal only
grant select on public.client_link_issued to service_role;

create or replace function public.tg_client_link_issued()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'quotes' then
    if new.approval_token is not null and (tg_op = 'INSERT' or new.approval_token is distinct from old.approval_token) then
      insert into public.client_link_issued(kind, token, quote_id)
        values ('quote', new.approval_token, new.id) on conflict do nothing;
    end if;
  elsif tg_table_name = 'event_proposal' then
    if new.share_token is not null and (tg_op = 'INSERT' or new.share_token is distinct from old.share_token) then
      insert into public.client_link_issued(kind, token, quote_id)
        values ('proposal', new.share_token, new.quote_id) on conflict do nothing;
    end if;
  end if;
  return null;
end $$;
revoke all on function public.tg_client_link_issued() from public, anon, authenticated;
drop trigger if exists zz_client_link_issued on public.quotes;
create trigger zz_client_link_issued after insert or update of approval_token on public.quotes
  for each row execute function public.tg_client_link_issued();
drop trigger if exists zz_client_link_issued on public.event_proposal;
create trigger zz_client_link_issued after insert or update of share_token on public.event_proposal
  for each row execute function public.tg_client_link_issued();

-- links already out there (only fills the NEW table; re-runs add nothing twice)
insert into public.client_link_issued(kind, token, quote_id, issued_at, source)
select 'quote', q.approval_token, q.id,
       coalesce(ev.at, q.created_at), case when ev.at is null then 'quote_created' else 'audit_log' end
  from public.quotes q
  left join lateral (
    select max(a.at) as at from public.audit_log a
     where a.quote_id = q.id and a.entity = 'quotes'
       and ((a.action = 'update' and a.changed -> 'approval_token' ->> 1 = q.approval_token::text)
         or (a.action = 'insert' and a.changed ->> 'approval_token' = q.approval_token::text))
  ) ev on true
 where q.approval_token is not null
on conflict do nothing;
insert into public.client_link_issued(kind, token, quote_id, issued_at, source)
select 'proposal', pr.share_token, pr.quote_id, pr.updated_at, 'proposal_saved'
  from public.event_proposal pr
 where pr.share_token is not null
on conflict do nothing;

-- ---- 3) the rule ---------------------------------------------------------------
-- N when the studio switched it on, else NULL (= no age limit)
create or replace function public.link_autoexpire_days(p_org uuid)
returns int language sql stable security definer set search_path = '' as $$
  select s.days from public.org_link_autoexpire s
   where s.org_id = p_org and s.enabled and s.days between 1 and 365;
$$;
-- the moment a link sent at p_sent stops working because of its age; NULL = never
create or replace function public.link_autoexpire_at(p_org uuid, p_sent timestamptz)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select p_sent + make_interval(days => public.link_autoexpire_days(p_org));
$$;

create or replace function public.approval_link_age_until(p_token uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select public.link_autoexpire_at(q.org_id, coalesce(i.issued_at, q.created_at))
    from public.quotes q
    left join public.client_link_issued i on i.kind = 'quote' and i.token = q.approval_token
   where q.approval_token = p_token;
$$;
create or replace function public.proposal_link_age_until(p_token uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select public.link_autoexpire_at(q.org_id, coalesce(i.issued_at, q.created_at))
    from public.event_proposal pr
    join public.quotes q on q.id = pr.quote_id
    left join public.client_link_issued i on i.kind = 'proposal' and i.token = pr.share_token
   where pr.share_token = p_token;
$$;
-- crew: last time the link went out = created, or a task newly assigned to that person
create or replace function public.work_link_age_until(p_token uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select public.link_autoexpire_at(w.org_id,
           greatest(w.created_at,
                    (select max(t.created_at) from public.event_tasks t
                      where t.quote_id = w.quote_id and t.assignee_phone = w.phone)))
    from public.work_tokens w where w.token = p_token;
$$;
create or replace function public.link_age_expired(p_until timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select p_until is not null and now() >= p_until;
$$;
do $$ begin
  execute 'revoke all on function public.link_autoexpire_days(uuid) from public, anon, authenticated';
  execute 'revoke all on function public.link_autoexpire_at(uuid, timestamptz) from public, anon, authenticated';
  execute 'revoke all on function public.approval_link_age_until(uuid) from public, anon, authenticated';
  execute 'revoke all on function public.proposal_link_age_until(uuid) from public, anon, authenticated';
  execute 'revoke all on function public.work_link_age_until(uuid) from public, anon, authenticated';
  execute 'revoke all on function public.link_age_expired(timestamptz) from public, anon, authenticated';
end $$;

-- ---- 4) wrap the entry points (keep each project's own body) -------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['public_get_quote',        'uuid'],
    ['public_get_portal',       'uuid'],
    ['create_payment',          'uuid'],
    ['request_otp',             'uuid, text'],
    ['verify_and_consent',      'uuid, text, text, boolean, text, text, text, text'],
    ['payment_link_begin',      'uuid, integer'],
    ['otp_send_authorize',      'uuid, text'],
    ['generate_approval_token', 'uuid'],
    ['public_get_proposal',     'uuid'],
    ['publish_proposal',        'uuid, boolean'],
    ['_work_token_live',        'uuid'],
    ['event_site_live_until',   'uuid']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0039', f[2])) is null
       and to_regprocedure(format('public.%s(%s)', f[1], f[2])) is not null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0039');
    end if;
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0039', f[2])) is not null then
      execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0039', f[2]);
    end if;
  end loop;
end $$;

-- approval token: read the quote / portal ------------------------------------
create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_quote__pre0039(p_token);
end $$;

create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_portal__pre0039(p_token);
end $$;

-- approval token: approve (OTP + consent) and pay ------------------------------
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 0039 age gate. The code is still generated further down (request_otp__base,
-- secure: extensions.gen_random_bytes, see 0026).
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.request_otp__pre0039(p_token, p_phone);
end $$;

create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean,
                                                     p_terms_version text, p_consent_text text,
                                                     p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.verify_and_consent__pre0039(p_token, p_phone, p_code, p_agreed, p_terms_version,
                                            p_consent_text, p_client_name, p_user_agent);
end $$;

create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.create_payment__pre0039(p_token);
end $$;

-- Edge Function (service role) entry points: same answers they give for an expired link
create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'invalid link' using errcode = 'HL404';
  end if;
  return public.otp_send_authorize__pre0039(p_token, p_phone);
end $$;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer default 4320)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_until timestamptz := public.approval_link_age_until(p_token); v_out jsonb; v_exp timestamptz;
begin
  if public.link_age_expired(v_until) then return jsonb_build_object('action', 'invalid'); end if;
  v_out := public.payment_link_begin__pre0039(p_token, p_ttl_minutes);
  -- the Razorpay link it is about to open never outlives the approval link
  -- (Razorpay needs >= 15 minutes, so never less than 20, as the original does)
  if v_until is not null and v_out ->> 'action' = 'create'
     and to_timestamp((v_out ->> 'expire_by')::double precision) > v_until then
    v_exp := greatest(v_until, now() + interval '20 minutes');
    update public.quote_payments set link_expires_at = v_exp
     where id = (v_out ->> 'payment_id')::uuid and status = 'created';
    v_out := v_out || jsonb_build_object('expire_by', floor(extract(epoch from v_exp))::bigint);
  end if;
  return v_out;
end $$;

-- studio side: sending the approval link again after it aged out gives a NEW link
create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare tok uuid; v_new uuid;
begin
  tok := public.generate_approval_token__pre0039(p_quote_id);    -- every permission check, as before
  if tok is not null and public.link_age_expired(public.approval_link_age_until(tok)) then
    update public.quotes q set approval_token = gen_random_uuid(), updated_at = now()
     where q.id = p_quote_id and q.org_id = public.current_org_id() and q.approval_token = tok
       and q.approval_token_revoked_at is null
       and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
    returning q.approval_token into v_new;
    tok := coalesce(v_new, tok);
  end if;
  return tok;
end $$;

-- proposal link -----------------------------------------------------------------
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.proposal_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_proposal__pre0039(p_token);
end $$;

create or replace function public.publish_proposal(p_quote_id uuid, p_published boolean)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare tok uuid; v_new uuid;
begin
  tok := public.publish_proposal__pre0039(p_quote_id, p_published);   -- every permission check, as before
  if coalesce(p_published, false) and tok is not null
     and public.link_age_expired(public.proposal_link_age_until(tok)) then
    update public.event_proposal pr set share_token = gen_random_uuid(), updated_at = now()
     where pr.quote_id = p_quote_id and pr.org_id = public.current_org_id() and pr.share_token = tok
    returning pr.share_token into v_new;
    tok := coalesce(v_new, tok);
  end if;
  return tok;
end $$;

-- crew task link: every worker_* RPC resolves its token through _work_token_live ------
create or replace function public._work_token_live(p_token uuid)
returns public.work_tokens language plpgsql volatile security definer set search_path = '' as $$
declare w public.work_tokens;
begin
  w := public._work_token_live__pre0039(p_token);                 -- invalid / revoked / expired, as before
  if public.link_age_expired(public.work_link_age_until(w.token)) then
    raise exception 'link expired' using errcode = '42501';
  end if;
  return w;
end $$;

-- invitation website (+ photos via invite_media_on_published_site, + the studio's
-- "live until" line): the earlier of the event window and the age limit
create or replace function public.event_site_live_until(p_site_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select least(public.event_site_live_until__pre0039(s.id),
               public.link_autoexpire_at(s.org_id, coalesce(s.published_at, s.created_at)))
    from public.event_sites s where s.id = p_site_id;
$$;

-- grants: exactly what each entry point had before ---------------------------------
do $$ declare f text; begin
  foreach f in array array['public_get_quote(uuid)', 'public_get_portal(uuid)', 'create_payment(uuid)',
      'request_otp(uuid, text)', 'verify_and_consent(uuid, text, text, boolean, text, text, text, text)',
      'public_get_proposal(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    execute 'grant execute on function public.' || f || ' to anon, authenticated, service_role';
  end loop;
  foreach f in array array['generate_approval_token(uuid)', 'publish_proposal(uuid, boolean)',
      'event_site_live_until(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated, service_role';
  end loop;
  foreach f in array array['payment_link_begin(uuid, integer)', 'otp_send_authorize(uuid, text)',
      '_work_token_live(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- 5) admin RPCs (Control Center) --------------------------------------------
create or replace function public.admin_get_link_autoexpire()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.org_link_autoexpire; v_tz text;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into s from public.org_link_autoexpire x where x.org_id = v_org;
  select nullif(btrim(o.timezone), '') into v_tz from public.organizations o where o.id = v_org;
  return jsonb_build_object('enabled', coalesce(s.enabled, false), 'days', coalesce(s.days, 10),
    'min_days', 1, 'max_days', 365, 'updated_at', s.updated_at,
    'timezone', coalesce(v_tz, 'Asia/Kolkata'), 'now', now());
end $$;

create or replace function public.admin_set_link_autoexpire(p_enabled boolean, p_days int)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
        v_old_on boolean; v_old_days int; v_days int; v_email text; v_pending boolean := false;
begin
  if v_me is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v_pending;
    if coalesce(v_pending, false) then raise exception 'set your own password first' using errcode = '42501'; end if;
  end if;
  if p_enabled is null then raise exception 'choose on or off' using errcode = '22023'; end if;
  select x.enabled, x.days into v_old_on, v_old_days
    from public.org_link_autoexpire x where x.org_id = v_org for update;
  v_days := coalesce(p_days, v_old_days, 10);
  if v_days < 1 or v_days > 365 then
    raise exception 'choose between 1 and 365 days' using errcode = '22023';
  end if;
  insert into public.org_link_autoexpire(org_id, enabled, days, updated_by, updated_at)
    values (v_org, p_enabled, v_days, v_me, now())
  on conflict (org_id) do update
    set enabled = excluded.enabled, days = excluded.days, updated_by = excluded.updated_by, updated_at = now();
  if v_old_on is distinct from p_enabled or v_old_days is distinct from v_days then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (v_me, v_email, 'link_autoexpire.set', 'organizations', v_org::text, v_org,
              jsonb_build_object('enabled', jsonb_build_object('old', coalesce(v_old_on, false), 'new', p_enabled),
                                 'days',    jsonb_build_object('old', coalesce(v_old_days, 10), 'new', v_days)));
  end if;
  return public.admin_get_link_autoexpire();
end $$;

do $$ declare f text; begin
  foreach f in array array['admin_get_link_autoexpire()', 'admin_set_link_autoexpire(boolean, integer)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select o.name, s.enabled, s.days from public.org_link_autoexpire s join public.organizations o on o.id = s.org_id;
-- select kind, source, count(*) from public.client_link_issued group by 1, 2;
