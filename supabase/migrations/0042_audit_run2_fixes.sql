-- ============================================================================
-- 0042_audit_run2_fixes.sql — CANONICAL forward-only. REQUIRES 0041.
-- Security audit run 2, Phase H "safe now" fixes (REMEDIATION-PLAN.md):
--   RC-1  OTP: a NULL / non-6-digit code is a wrong code (counts an attempt, never
--         approves); dev-echo codes only where the service-role-only setting
--         helm_env_settings.allow_otp_dev_echo = true (staging); echo consents are
--         stored verified_via_otp = false; open OTPs expire on revoke / new link / shelf.
--   RC-2  bell_feed never returns token / url keys; new notifications rows are stored
--         without them (no backfill of old rows — owner decision D4).
--   RC-3  client links die while the quote is on the Archive / Deleted shelf (and work
--         again on restore); crew links die when that staff member is deactivated or
--         their number changes; admin_revoke_work_links(); proof-upload grants obey
--         the 0039 link age.
--   RC-4  STRICTER-ONLY role checks (has_area AND the existing checks); a payment that
--         doesn't cover a milestone no longer marks it paid; set_lifecycle_stage can't
--         jump to 'closed'; quotes: hard delete only from the Deleted shelf by
--         can_delete() roles, insert only by can_create() roles (RESTRICTIVE policies).
--   RC-5  approved / processed refunds are frozen for API callers (event_refunds only).
--   RC-7  a self-typed mobile no longer takes over an existing unlinked staff row;
--         platform operator e-mails can't join / be created / be invited (create_studio
--         is already refused for operators by 0037); invitations
--         need a confirmed e-mail; a re-invite at another role changes the role and
--         rotates the token; invitation rows (tokens) readable only with users-edit.
--   RC-8  audit_log / notifications / quote_otps rows carry the ROW's studio, not the
--         caller's; hq.* audit rows have no studio. Forward only — no backfill.
--   RC-9  event_site_live_until answers only the caller's own studio (or a published
--         site); work_token_expiry_for / client_link_deadline and trigger functions are
--         no longer callable by anon / authenticated.
--   RC-10 the per-link OTP limit (5 / 10 min, 10 / day) is checked BEFORE the shared
--         studio SMS counter.
--
-- DRIFT-SAFE (production differs from canonical): each changed public entry point is
-- renamed ONCE to <fn>__pre0042 (only if that name is still free) and replaced by a
-- wrapper that runs the new guards and then calls this database's own body. Functions
-- referenced by policies / triggers keep their OID: task_proof_upload_ok is CLONED to
-- __pre0042 from this database's own definition; tg_audit is replaced only when its
-- body is the known canonical one (else a NOTICE and it is left alone). New helpers are
-- _a42_*. Policies are only ADDED as RESTRICTIVE (they can only narrow access).
-- No DROP TABLE / column, no DELETE, no TRUNCATE, no backfill. Safe to re-run.
--
-- FOLLOW-UP (not here): RC-6 DB-enforced MFA (D3), D2 matrix-as-sole-authority,
-- D4 backfills, D6 freeze for expense_claims / change_requests / event_costs, NV-*.
-- Other can_edit()-only definers to review in a follow-up: assign_tasks, reassign_task,
-- mgr_notify, generate_approval_token (has has_area), publish_proposal.
-- ============================================================================

-- ---- 0) helpers -------------------------------------------------------------
create table if not exists public.helm_env_settings (
  key        text primary key,
  value      jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.helm_env_settings enable row level security;
revoke all on public.helm_env_settings from public, anon, authenticated;
grant all on public.helm_env_settings to service_role;
comment on table public.helm_env_settings is
  'Per-environment switches (0042). No API access: only the service role / database owner can write. '
  'allow_otp_dev_echo = true only on staging.';

create or replace function public._a42_dev_echo_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value in ('true'::jsonb, '"true"'::jsonb)
                     from public.helm_env_settings s where s.key = 'allow_otp_dev_echo'), false);
$$;

create or replace function public._a42_redact_detail(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) = 'object'
              then p - array['token', 'url', 'link', 'approval_url', 'work_url', 'work_link',
                             'portal_url', 'payment_url', 'link_url', 'approval_token', 'work_token']
              else p end;
$$;

create or replace function public._a42_quote_shelved(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select q.deleted_at is not null or q.archived_at is not null
                     from public.quotes q where q.id = p_quote), false);
$$;

create or replace function public._a42_is_operator_email(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(coalesce(p_email, '')), '') is not null
                  and exists (select 1 from public.platform_admins pa
                               where lower(pa.email) = lower(btrim(p_email))), false);
$$;

create or replace function public._a42_expire_open_otps(p_quote uuid)
returns void language sql volatile security definer set search_path = '' as $$
  update public.quote_otps o set expires_at = now()
   where o.quote_id = p_quote and o.verified_at is null and o.expires_at > now();
$$;

do $$ declare f text; begin
  foreach f in array array['_a42_dev_echo_allowed()', '_a42_redact_detail(jsonb)', '_a42_quote_shelved(uuid)',
      '_a42_is_operator_email(text)', '_a42_expire_open_otps(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- 1) keep this database's own bodies (rename once) --------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['verify_and_consent',        'uuid, text, text, boolean, text, text, text, text'],
    ['request_otp',               'uuid, text'],
    ['otp_send_authorize',        'uuid, text'],
    ['public_get_quote',          'uuid'],
    ['public_get_portal',         'uuid'],
    ['public_get_proposal',       'uuid'],
    ['create_payment',            'uuid'],
    ['payment_link_begin',        'uuid, integer'],
    ['_work_token_live',          'uuid'],
    ['revoke_approval_token',     'uuid'],
    ['generate_approval_token',   'uuid'],
    ['move_quote_to_shelf',       'uuid, text'],
    ['bell_feed',                 'integer'],
    ['record_settlement_payment', 'uuid, numeric, text, text, uuid, text, text'],
    ['record_payment',            'uuid, numeric, text, text, uuid, text, text'],
    ['close_event',               'uuid, boolean'],
    ['set_closure',               'uuid, integer, text, text, boolean, text'],
    ['set_lifecycle_stage',       'uuid, text'],
    ['mark_paid',                 'uuid, text'],
    ['_mp_sync_staff',            'uuid, jsonb'],
    ['accept_invitation',         'text'],
    ['admin_create_user',         'text, text, text'],
    ['_admin_create_user_core',   'text, text, text'],
    ['create_invitation',         'text, text'],
    ['create_studio',             'text, text, text, text'],
    ['event_site_live_until',     'uuid']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0042', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        if f[1] = '_work_token_live' then                     -- optional on drifted databases
          raise notice '0042: public._work_token_live(uuid) not on this database — crew-link gate skipped'; continue;
        end if;
        raise exception '0042: public.%(%) is missing on this database', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0042');
    end if;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0042', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1] || '__pre0042', f[2]);
  end loop;
end $$;

-- task_proof_upload_ok is used by a storage policy (by OID): clone, don't rename
do $$ declare d text; begin
  if to_regprocedure('public.task_proof_upload_ok__pre0042(text)') is null then
    d := pg_get_functiondef('public.task_proof_upload_ok(text)'::regprocedure);
    d := replace(d, 'FUNCTION public.task_proof_upload_ok(', 'FUNCTION public.task_proof_upload_ok__pre0042(');
    execute d;
  end if;
  revoke all on function public.task_proof_upload_ok__pre0042(text) from public, anon, authenticated;
  grant execute on function public.task_proof_upload_ok__pre0042(text) to service_role;
end $$;

-- ---- 1b) owner decision D2: the role_access matrix is the single authority ------------
-- The kept bodies of the money / closure / lifecycle RPCs check a hardcoded role list
-- (can_edit(): admin, planner, sales, operations; mark_paid: admin, manager). That list is
-- neutralised IN THIS DATABASE'S OWN BODY (textual, so drifted logic is kept) and the
-- wrappers below check has_area(area, 'edit') instead (admin always passes has_area).
-- Patterns not found (already changed on this database) are left alone with a NOTICE.
do $$ declare f text; d text; d2 text; begin
  foreach f in array array['revoke_approval_token__pre0042(uuid)', 'generate_approval_token__pre0039(uuid)',
      'record_settlement_payment__pre0042(uuid, numeric, text, text, uuid, text, text)',
      'record_payment__pre0042(uuid, numeric, text, text, uuid, text, text)',
      'close_event__pre0042(uuid, boolean)', 'set_closure__pre0042(uuid, integer, text, text, boolean, text)',
      'set_lifecycle_stage__pre0042(uuid, text)', 'mark_paid__pre0042(uuid, text)', 'mark_paid__base(uuid, text)'] loop
    if to_regprocedure('public.' || f) is null then raise notice '0042 D2: % not on this database — skipped', f; continue; end if;
    d := pg_get_functiondef(('public.' || f)::regprocedure);
    d2 := replace(d, 'not public.can_edit()', 'not (true /* a42-d2: matrix */)');
    d2 := replace(d2, $q$coalesce(public.user_role(), '') not in ('admin', 'manager')$q$, '(false /* a42-d2: matrix */)');
    d2 := replace(d2, $q$public.user_role() not in ('admin','manager')$q$, '(false /* a42-d2: matrix */)');
    if d2 <> d then execute d2;
    elsif position('a42-d2' in d) = 0 then raise notice '0042 D2: no hardcoded role check found in % — left unchanged', f; end if;
  end loop;
end $$;

-- nobody loses access on rollout: the roles the hardcoded lists let in get the matching
-- matrix row WHERE THE STUDIO HAS NO ROW YET (an explicit row, e.g. edit = false, is the
-- studio's own choice and is kept). Insert-only; admin needs no row.
create or replace function public._a42_seed_matrix_defaults()
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
  select o.id, x.role, x.area, true, true, now()
    from public.organizations o
    cross join (values ('planner','settlement'), ('sales','settlement'), ('operations','settlement'),
                       ('planner','closure'),    ('sales','closure'),    ('operations','closure'),
                       ('planner','quotes'),     ('sales','quotes'),     ('operations','quotes'),
                       ('manager','finance')) x(role, area)
   where not exists (select 1 from public.role_access ra where ra.org_id = o.id and ra.role = x.role and ra.area = x.area)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._a42_seed_matrix_defaults() from public, anon, authenticated;
grant execute on function public._a42_seed_matrix_defaults() to service_role;
select public._a42_seed_matrix_defaults();

-- ---- 2) RC-1 / RC-3 / RC-10: approval-link entry points -------------------------
create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean,
                                                     p_terms_version text, p_consent_text text,
                                                     p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042: a NULL / malformed code is a wrong code (C-01); shelf gate; echo consents
declare v_q uuid; v_org uuid; rec public.quote_otps; v_out jsonb; v_echo boolean := false;
begin
  select q.id, q.org_id into v_q, v_org from public.quotes q
   where q.approval_token = p_token and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is not null then
    if public._a42_quote_shelved(v_q) then raise exception 'this link has expired' using errcode = 'P0001'; end if;
    if (p_code is null or p_code !~ '^[0-9]{6}$')
       and not public.link_age_expired(public.approval_link_age_until(p_token)) then
      select * into rec from public.quote_otps o
       where o.quote_id = v_q and o.phone = p_phone and o.verified_at is null and o.expires_at > now()
       order by o.created_at desc limit 1 for update;
      if rec.id is null then
        return jsonb_build_object('approved', false, 'error', 'no_active_code', 'message', 'no active code — request a new OTP');
      end if;
      if rec.attempts >= 5 then
        return jsonb_build_object('approved', false, 'error', 'locked', 'message', 'too many attempts — request a new OTP');
      end if;
      update public.quote_otps set attempts = attempts + 1 where id = rec.id;
      return jsonb_build_object('approved', false, 'error', 'incorrect_code', 'message', 'incorrect code',
                                'remaining', greatest(0, 5 - (rec.attempts + 1)));
    end if;
    v_echo := public._a42_dev_echo_allowed() and not public._flag('sms_live', v_org)
              and public._flag('otp_dev_echo', v_org);
  end if;
  v_out := public.verify_and_consent__pre0042(p_token, p_phone, p_code, p_agreed, p_terms_version,
                                              p_consent_text, p_client_name, p_user_agent);
  if v_echo and coalesce((v_out ->> 'approved')::boolean, false) then
    -- the code was shown on screen (staging dev echo), not delivered by SMS
    update public.quote_consents c set verified_via_otp = false
     where c.id = (select c2.id from public.quote_consents c2 where c2.quote_id = v_q
                    order by c2.created_at desc, c2.id desc limit 1)
       and c.verified_via_otp;
  end if;
  return v_out;
end $$;

create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042: shelf gate; per-link limit first (C-15); dev echo only where allowed (C-11).
-- The code is still generated by request_otp__base (secure: extensions.gen_random_bytes, see 0026).
declare v_q uuid; v_n10 int; v_n24 int; v_out jsonb;
begin
  select q.id into v_q from public.quotes q
   where q.approval_token = p_token and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is not null then
    if public._a42_quote_shelved(v_q) then raise exception 'this link has expired' using errcode = 'P0001'; end if;
    select count(*) filter (where o.created_at > now() - interval '10 minutes'), count(*)
      into v_n10, v_n24 from public.quote_otps o
     where o.quote_id = v_q and o.created_at > now() - interval '24 hours';
    if v_n10 >= 5 then raise exception 'too many OTP requests — try again in a few minutes' using errcode = 'P0001'; end if;
    if v_n24 >= 10 then raise exception 'too many OTP requests on this link today — try again tomorrow' using errcode = 'P0001'; end if;
  end if;
  v_out := public.request_otp__pre0042(p_token, p_phone);
  if not public._a42_dev_echo_allowed() and v_out ? 'dev_code' then
    if v_out ->> 'delivery' = 'dev_echo' then
      v_out := v_out || jsonb_build_object('sent', false, 'delivery', 'unavailable',
        'message', 'OTP delivery is not configured. Ask the studio to send the code by SMS.');
    end if;
    v_out := v_out || jsonb_build_object('dev_code', null);
  end if;
  return v_out;
end $$;

create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042: shelf gate; a real SMS code needs the client's mobile ON FILE (owner D5);
-- the per-link / per-number limits run BEFORE the shared studio SMS counter (C-15)
declare v_q uuid; v_client jsonb; v_n10 int; v_n24 int; v_nh int;
begin
  select q.id, q.client into v_q, v_client from public.quotes q where q.approval_token = p_token
     and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is not null and not public.link_age_expired(public.approval_link_age_until(p_token)) then   -- else: the earlier answers
    if public._a42_quote_shelved(v_q) then raise exception 'invalid link' using errcode = 'HL404'; end if;
    if coalesce(public.helm_norm_phone(v_client ->> 'phone'), '') = '' then
      raise exception 'The studio has no mobile number on file for you yet — ask them to add it, then request the code again.'
        using errcode = 'HL403';
    end if;
    select count(*) filter (where o.created_at > now() - interval '10 minutes'), count(*),
           count(*) filter (where o.created_at > now() - interval '1 hour'
                              and public.helm_norm_phone(o.phone) = public.helm_norm_phone(p_phone))
      into v_n10, v_n24, v_nh from public.quote_otps o
     where o.quote_id = v_q and o.created_at > now() - interval '24 hours';
    if v_n10 >= 5 or v_n24 >= 10 or v_nh >= 3 then raise exception 'too many OTP requests' using errcode = 'HL429'; end if;
  end if;
  return public.otp_send_authorize__pre0042(p_token, p_phone);
end $$;

create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_quote_shelved((select q.id from public.quotes q where q.approval_token = p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_quote__pre0042(p_token);
end $$;

create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_quote_shelved((select q.id from public.quotes q where q.approval_token = p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_portal__pre0042(p_token);
end $$;

create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.event_proposal pr where pr.share_token = p_token
                and public._a42_quote_shelved(pr.quote_id)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_proposal__pre0042(p_token);
end $$;

create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_quote_shelved((select q.id from public.quotes q where q.approval_token = p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.create_payment__pre0042(p_token);
end $$;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer default 4320)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_quote_shelved((select q.id from public.quotes q where q.approval_token = p_token)) then
    return jsonb_build_object('action', 'invalid');
  end if;
  return public.payment_link_begin__pre0042(p_token, p_ttl_minutes);
end $$;

-- ---- 3) RC-1 / RC-4: studio-side link + quote actions ----------------------------
create or replace function public.revoke_approval_token(p_quote_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_out jsonb;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  v_out := public.revoke_approval_token__pre0042(p_quote_id);          -- can_edit + studio checks, as before
  perform public._a42_expire_open_otps(p_quote_id);
  return v_out;
end $$;

create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_old uuid; tok uuid;
begin
  select q.approval_token into v_old from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id();
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  tok := public.generate_approval_token__pre0042(p_quote_id);          -- studio + age checks, as before
  if tok is distinct from v_old then
    perform public._a42_expire_open_otps(p_quote_id);
    -- a NEW link starts clean (h07): not revoked, and it gets an expiry (NV-05)
    update public.quotes q
       set approval_token_revoked_at = null,
           approval_token_expires_at = greatest(now() + interval '30 days',
                                                public.client_link_deadline(q.event_date, q.org_id, 30))
     where q.id = p_quote_id and q.org_id = public.current_org_id() and q.approval_token = tok;
  end if;
  return tok;
end $$;

create or replace function public.move_quote_to_shelf(p_quote_id uuid, p_shelf text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_out jsonb;
begin
  v_out := public.move_quote_to_shelf__pre0042(p_quote_id, p_shelf);   -- every permission check, as before
  if public._a42_quote_shelved(p_quote_id) then perform public._a42_expire_open_otps(p_quote_id); end if;
  return v_out;
end $$;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_stage = 'closed' then
    raise exception 'Close the event from its Closure page.' using errcode = '22023';
  end if;
  return public.set_lifecycle_stage__pre0042(p_quote_id, p_stage);
end $$;

create or replace function public.close_event(p_quote_id uuid, p_closed boolean)
returns public.event_closure language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('closure', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.close_event__pre0042(p_quote_id, p_closed);
end $$;

create or replace function public.set_closure(p_quote_id uuid, p_rating integer, p_feedback text, p_testimonial text,
                                              p_media_consent boolean, p_lessons text)
returns public.event_closure language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('closure', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.set_closure__pre0042(p_quote_id, p_rating, p_feedback, p_testimonial, p_media_consent, p_lessons);
end $$;

create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  -- settles exactly one open quote_payments request, as before (mark_paid__pre0042)
  return public.mark_paid__pre0042(p_quote_id, p_provider_ref);
end $$;

-- a milestone flipped to paid by THIS call stays paid only if this payment (plus any
-- ledger credit not yet allocated to paid milestones) covers it; otherwise it goes back
create or replace function public._a42_milestone_state(p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'paid_ids', coalesce((select jsonb_object_agg(pm.id::text, true) from public.payment_milestones pm
                           where pm.quote_id = p_quote and pm.status = 'paid'), '{}'::jsonb),
    'status',   coalesce((select jsonb_object_agg(pm.id::text, pm.status) from public.payment_milestones pm
                           where pm.quote_id = p_quote), '{}'::jsonb),
    'credit',   coalesce((select sum(qp.amount) from public.quote_payments qp
                           where qp.quote_id = p_quote and qp.status = 'paid'), 0)
              - coalesce((select sum(pm.amount) from public.payment_milestones pm
                           where pm.quote_id = p_quote and pm.status = 'paid'), 0));
$$;

create or replace function public._a42_milestone_cover(p_quote uuid, p_amount numeric, p_state jsonb)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare m record; v_reverted boolean := false; v_credit numeric := greatest(coalesce((p_state ->> 'credit')::numeric, 0), 0);
begin
  for m in select pm.id, pm.amount from public.payment_milestones pm
            where pm.quote_id = p_quote and pm.status = 'paid' and not ((p_state -> 'paid_ids') ? pm.id::text)
  loop
    if v_credit + coalesce(p_amount, 0) < coalesce(m.amount, 0) - 0.005 then
      update public.payment_milestones
         set status = coalesce(nullif(p_state -> 'status' ->> m.id::text, 'paid'), 'due'), paid_at = null
       where id = m.id;
      v_reverted := true;
    end if;
  end loop;
  return v_reverted;
end $$;

create or replace function public.record_payment(p_quote uuid, p_amount numeric, p_method text default 'cash',
                                                 p_receipt_no text default null, p_milestone uuid default null,
                                                 p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_state jsonb; v_out jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || coalesce(p_quote::text, ''), 0));
  v_state := public._a42_milestone_state(p_quote);
  -- the receipt row is written to quote_payments by record_payment__pre0042 (ledger + caps unchanged)
  v_out := public.record_payment__pre0042(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
  if not coalesce((v_out ->> 'idempotent_replay')::boolean, false)
     and public._a42_milestone_cover(p_quote, p_amount, v_state) then
    v_out := v_out || jsonb_build_object('milestone_paid', false,
      'milestone_note', 'Part payment recorded — the milestone stays open until it is fully covered.');
  end if;
  return v_out;
end $$;

create or replace function public.record_settlement_payment(p_quote uuid, p_amount numeric, p_method text default 'cash',
                                                            p_receipt_no text default null, p_milestone uuid default null,
                                                            p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_state jsonb; v_out jsonb;
begin
  if not public.has_area('settlement', 'edit') then           -- D2: the matrix decides
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || coalesce(p_quote::text, ''), 0));
  v_state := public._a42_milestone_state(p_quote);
  -- the receipt row is written to quote_payments by record_settlement_payment__pre0042
  v_out := public.record_settlement_payment__pre0042(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
  if p_milestone is not null and not coalesce((v_out ->> 'idempotent_replay')::boolean, false)
     and public._a42_milestone_cover(p_quote, p_amount, v_state) then
    v_out := v_out || jsonb_build_object('milestone_paid', false,
      'milestone_note', 'Part payment recorded — the milestone stays open until it is fully covered.');
  end if;
  return v_out;
end $$;

do $$ declare f text; begin
  foreach f in array array['_a42_milestone_state(uuid)', '_a42_milestone_cover(uuid, numeric, jsonb)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- 4) RC-3 crew links -----------------------------------------------------------
do $do$ begin
  if to_regprocedure('public._work_token_live__pre0042(uuid)') is null then
    raise notice '0042: _work_token_live wrapper skipped (no body on this database)'; return;
  end if;
  execute $w$
create or replace function public._work_token_live(p_token uuid)
returns public.work_tokens language plpgsql volatile security definer set search_path = '' as $f$
-- audit-run2-0042: the event is on a shelf, or the staff member with this number was deactivated
declare w public.work_tokens;
begin
  w := public._work_token_live__pre0042(p_token);              -- invalid / revoked / expired / aged, as before
  if public._a42_quote_shelved(w.quote_id) then
    raise exception 'link expired' using errcode = '42501';
  end if;
  if exists (select 1 from public.crew_members c where c.org_id = w.org_id
                and public.helm_norm_phone(c.phone) = public.helm_norm_phone(w.phone))
     and not exists (select 1 from public.crew_members c where c.org_id = w.org_id and coalesce(c.active, true)
                       and public.helm_norm_phone(c.phone) = public.helm_norm_phone(w.phone)) then
    raise exception 'link revoked' using errcode = '42501';
  end if;
  return w;
end $f$;
$w$;
  revoke all on function public._work_token_live(uuid) from public, anon, authenticated;
  grant execute on function public._work_token_live(uuid) to service_role;
end $do$;

create or replace function public._a42_revoke_links_for_phone(p_org uuid, p_phone text, p_reason text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n int := 0;
begin
  if p_org is null or nullif(public.helm_norm_phone(p_phone), '') is null then return 0; end if;
  update public.work_tokens w set revoked_at = now()
   where w.org_id = p_org and w.revoked_at is null
     and public.helm_norm_phone(w.phone) = public.helm_norm_phone(p_phone);
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'work_links.revoked',
              'work_tokens', null, p_org, jsonb_build_object('count', n, 'reason', p_reason));
  end if;
  return n;
end $$;

create or replace function public._a42_tg_crew_revoke_links()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (coalesce(old.active, true) and not coalesce(new.active, true))
     or public.helm_norm_phone(new.phone) is distinct from public.helm_norm_phone(old.phone) then
    -- only when no other ACTIVE staff row in the studio still has the old number
    if not exists (select 1 from public.crew_members c where c.org_id = old.org_id and c.id <> old.id
                      and coalesce(c.active, true)
                      and public.helm_norm_phone(c.phone) = public.helm_norm_phone(old.phone)) then
      perform public._a42_revoke_links_for_phone(old.org_id, old.phone,
        case when coalesce(new.active, true) then 'phone_changed' else 'deactivated' end);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists zz_a42_crew_revoke_links on public.crew_members;
create trigger zz_a42_crew_revoke_links after update of active, phone on public.crew_members
  for each row execute function public._a42_tg_crew_revoke_links();

create or replace function public.admin_revoke_work_links(p_crew_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); c public.crew_members; n int;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into c from public.crew_members x where x.id = p_crew_id and x.org_id = v_org;
  if c.id is null then raise exception 'no such staff member' using errcode = '42501'; end if;
  n := public._a42_revoke_links_for_phone(v_org, c.phone, 'admin');
  return jsonb_build_object('revoked', n);
end $$;

create or replace function public.task_proof_upload_ok(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- audit-run2-0042: + the 0039 link age and the shelf gate for the grant's crew link
  select public.task_proof_upload_ok__pre0042(p_name)
     and exists (select 1 from public.task_evidence_grants g
                  where g.path = p_name and g.used_at is null and g.expires_at > now()
                    and not public.link_age_expired(public.work_link_age_until(g.work_token))
                    and not public._a42_quote_shelved(g.quote_id));
$$;

do $$ declare f text; begin
  foreach f in array array['_a42_revoke_links_for_phone(uuid, text, text)', '_a42_tg_crew_revoke_links()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
  revoke all on function public.admin_revoke_work_links(uuid) from public, anon;
  grant execute on function public.admin_revoke_work_links(uuid) to authenticated, service_role;
end $$;

-- ---- 5) RC-1 C-11: dev echo is fail-closed ----------------------------------------
create or replace function public._a42_tg_cfg_no_dev_echo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.key = 'channels' and jsonb_typeof(new.value) = 'object'
     and coalesce(new.value ->> 'otp_dev_echo', '') = 'true'
     and not (tg_op = 'UPDATE' and coalesce(old.value ->> 'otp_dev_echo', '') = 'true')
     and not public._a42_dev_echo_allowed() then
    raise exception 'Showing OTP codes on screen (otp_dev_echo) is switched off on this server.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists a42_cfg_no_dev_echo on public.app_config;
create trigger a42_cfg_no_dev_echo before insert or update on public.app_config
  for each row execute function public._a42_tg_cfg_no_dev_echo();

-- ---- 6) RC-2 / RC-8: notification detail + row studio -------------------------------
create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- audit-run2-0042: bearer links / tokens never leave in the bell
declare v jsonb;
begin
  v := public.bell_feed__pre0042(p_limit);
  if jsonb_typeof(v -> 'items') = 'array' then
    v := v || jsonb_build_object('items', coalesce((
      select jsonb_agg(case when jsonb_typeof(e.i) = 'object' and e.i ? 'detail'
                            then e.i || jsonb_build_object('detail', public._a42_redact_detail(e.i -> 'detail'))
                            else e.i end order by e.ord)
        from jsonb_array_elements(v -> 'items') with ordinality e(i, ord)), '[]'::jsonb));
  end if;
  return v;
end $$;

create or replace function public._a42_tg_notify_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  new.detail := public._a42_redact_detail(new.detail);
  if new.quote_id is not null then
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    if v_org is not null then new.org_id := v_org; end if;
  end if;
  return new;
end $$;
drop trigger if exists za_a42_notify_row on public.notifications;
create trigger za_a42_notify_row before insert or update on public.notifications
  for each row execute function public._a42_tg_notify_row();

create or replace function public._a42_tg_org_from_quote_force()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if new.quote_id is not null then
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    if v_org is not null then new.org_id := v_org; end if;
  end if;
  return new;
end $$;
drop trigger if exists za_a42_otp_org on public.quote_otps;
create trigger za_a42_otp_org before insert on public.quote_otps
  for each row execute function public._a42_tg_org_from_quote_force();

create or replace function public._a42_tg_audit_org()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if new.action like 'hq.%' then
    new.org_id := null;                                   -- platform-operator views belong to no studio
  elsif new.quote_id is not null then
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    if v_org is not null then new.org_id := v_org; end if;
  end if;
  return new;
end $$;
drop trigger if exists zz_a42_audit_org on public.audit_log;
create trigger zz_a42_audit_org before insert on public.audit_log
  for each row execute function public._a42_tg_audit_org();

-- tg_audit: org from the row itself (keeps its OID — every audit trigger uses it).
-- Replaced only when this database's body is the known canonical one.
do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.tg_audit()'::regprocedure;
  if position('audit-run2-0042' in v_src) > 0
     or (position('insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed)' in v_src) > 0
         and position('key not in (''updated_at'',''confirmed_at'')' in v_src) > 0) then
    execute $fn$
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = 'public' as $body$
-- audit-run2-0042: the audit row carries the changed row's studio (C-09)
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_id text;
  v_quote uuid;
  v_changed jsonb;
  v_org uuid;
  o jsonb; n jsonb;
begin
  if v_actor is not null then select email into v_email from auth.users where id = v_actor; end if;
  if tg_op = 'DELETE' then n := to_jsonb(OLD); else n := to_jsonb(NEW); end if;
  if tg_op = 'UPDATE' then o := to_jsonb(OLD); end if;

  v_id := coalesce(n->>'id', n->>'quote_id');
  if tg_table_name = 'quotes' then v_quote := (n->>'id')::uuid;
  elsif n ? 'quote_id' then v_quote := nullif(n->>'quote_id','')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(o->key, n->key))
      into v_changed
      from jsonb_object_keys(n) as key
      where (o->key) is distinct from (n->key)
        and key not in ('updated_at','confirmed_at');
    if v_changed is null then return null; end if;
  else
    v_changed := n;
  end if;

  if tg_table_name = 'organizations' and coalesce(n->>'id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'id')::uuid;
  elsif coalesce(n->>'org_id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'org_id')::uuid;
  end if;
  if v_org is null and v_quote is not null then
    select q.org_id into v_org from public.quotes q where q.id = v_quote;
  end if;
  v_org := coalesce(v_org, public.current_org_id());

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_actor, v_email, lower(tg_op), tg_table_name, v_id, v_quote, v_changed, v_org);
  return null;
end $body$
$fn$;
  else
    raise notice '0042: tg_audit on this database is not the canonical body — left unchanged (review RC-8 by hand)';
  end if;
end $do$;

-- ---- 7) RC-5 refund freeze ------------------------------------------------------------
create or replace function public._a42_tg_refund_freeze()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'DELETE' then
      if old.status in ('approved', 'processed') then
        raise exception 'An approved or processed refund can''t be deleted — reject it or add a correcting entry.'
          using errcode = '42501';
      end if;
      return old;
    end if;
    if old.status in ('approved', 'processed')
       and (new.amount, new.kind, new.quote_id, new.org_id, new.created_by)
           is distinct from (old.amount, old.kind, old.quote_id, old.org_id, old.created_by) then
      raise exception 'An approved refund can''t be changed — reject it or add a correcting entry.' using errcode = '42501';
    end if;
    if old.status = 'processed' and new.status is distinct from 'processed' then
      raise exception 'A processed refund is final.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ac_a42_refund_freeze on public.event_refunds;
create trigger ac_a42_refund_freeze before update or delete on public.event_refunds
  for each row execute function public._a42_tg_refund_freeze();

-- ---- 8) RC-7 identity binding -----------------------------------------------------------
create or replace function public._mp_sync_staff(p_user uuid, p_admin jsonb)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042 (C-08): a mobile number the member typed is not proof that an existing,
-- unlinked staff row is theirs. Self-service links such a row only when its e-mail is the
-- member's confirmed sign-in e-mail; otherwise a staff-edit user links it from User control.
declare v_org uuid; v_phone text; v_email text; v_row_email text; v_found boolean;
begin
  if auth.uid() is not null and auth.uid() = p_user and not public.has_area('staff', 'edit') then
    select p.org_id into v_org from public.profiles p where p.id = p_user;
    select m.phone into v_phone from public.member_profiles m where m.user_id = p_user;
    if v_org is not null and v_phone is not null
       and not exists (select 1 from public.crew_members c where c.profile_id = p_user and c.org_id = v_org) then
      select true, lower(btrim(coalesce(c.email, ''))) into v_found, v_row_email from public.crew_members c
       where c.org_id = v_org and c.profile_id is null
         and public.helm_norm_phone(c.phone) = public.helm_norm_phone(v_phone)
       order by c.active desc, c.created_at, c.id limit 1;
      if coalesce(v_found, false) then
        select lower(u.email) into v_email from auth.users u where u.id = p_user and u.email_confirmed_at is not null;
        if v_email is null or v_row_email is distinct from v_email then
          return null;                                          -- staff link pending (an admin links it)
        end if;
      end if;
    end if;
  end if;
  return public._mp_sync_staff__pre0042(p_user, p_admin);
end $$;

create or replace function public._a42_tg_profile_no_operator_org()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  if new.org_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.org_id is not distinct from old.org_id then return new; end if;
  select lower(u.email) into v_email from auth.users u where u.id = new.id;
  if public._a42_is_operator_email(coalesce(v_email, new.email)) then
    raise exception 'A Helm platform operator account can''t be a member of a studio.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists a42_profile_no_operator_org on public.profiles;
create trigger a42_profile_no_operator_org before insert or update of org_id on public.profiles
  for each row execute function public._a42_tg_profile_no_operator_org();

create or replace function public.accept_invitation(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042 (C-10): confirmed e-mail, compared with auth.users (not a token claim); no operators
declare v_uid uuid := auth.uid(); v_email text; v_conf timestamptz; v_inv text; v_status text;
begin
  if v_uid is not null then
    select lower(u.email), u.email_confirmed_at into v_email, v_conf from auth.users u where u.id = v_uid;
    if v_conf is null then
      raise exception 'Confirm your e-mail address first, then open the invitation again.' using errcode = '42501';
    end if;
    if public._a42_is_operator_email(v_email) then
      raise exception 'A Helm platform operator account can''t join a studio.' using errcode = '42501';
    end if;
    select lower(i.email), i.status into v_inv, v_status from public.invitations i where i.token = p_token;
    if v_status = 'pending' and v_inv is distinct from v_email then
      raise exception 'this invitation was issued to a different email address' using errcode = '42501';
    end if;
  end if;
  return public.accept_invitation__pre0042(p_token);
end $$;

create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042 wrapper; the auth-hardening-0028 body (password rule, bcrypt 12, no
-- cross-tenant oracle) runs unchanged as admin_create_user__pre0042
begin
  if public.current_org_id() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._a42_is_operator_email(p_email) then
    raise exception 'could not create this user — send them an invitation instead' using errcode = '22023';
  end if;
  return public.admin_create_user__pre0042(p_email, p_password, p_role);
end $$;

create or replace function public._admin_create_user_core(p_email text, p_password text, p_role text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_is_operator_email(p_email) then
    raise exception 'could not create this user — send them an invitation instead' using errcode = '22023';
  end if;
  return public._admin_create_user_core__pre0042(p_email, p_password, p_role);
end $$;

create or replace function public.create_invitation(p_email text, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042: no operator e-mails (NV-09); a re-invite at another role changes the
-- pending invitation's role and gives it a NEW token (f3a) — an update, nothing removed
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  if public._a42_is_operator_email(p_email) then
    raise exception 'this e-mail address can''t be invited' using errcode = '22023';
  end if;
  if public.is_admin() and v_org is not null and public._valid_role(p_role) then
    select i.id into v_id from public.invitations i
     where i.org_id = v_org and lower(i.email) = lower(btrim(coalesce(p_email, '')))
       and i.status = 'pending' and i.expires_at > now()
     order by i.created_at desc limit 1;
    if v_id is not null then
      update public.invitations i
         set role = p_role, token = encode(extensions.gen_random_bytes(24), 'hex')
       where i.id = v_id and i.role is distinct from p_role;
    end if;
  end if;
  return public.create_invitation__pre0042(p_email, p_role);
end $$;

create or replace function public.create_studio(p_name text, p_email text default null,
                                                p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042 (NV-08): a NEW studio never inherits the template studio's channel
-- switches (live SMS / payments / OTP echo) — it starts with every channel off
declare v_had uuid; v_org uuid;
begin
  select p.org_id into v_had from public.profiles p where p.id = auth.uid();
  v_org := public.create_studio__pre0042(p_name, p_email, p_currency, p_timezone);
  if v_had is null and v_org is not null then
    update public.app_config c set value = '{}'::jsonb where c.org_id = v_org and c.key = 'channels' and c.value <> '{}'::jsonb;
  end if;
  return v_org;
end $$;

-- invitation rows (with their tokens): only people who can manage users
drop policy if exists "a42 inv read needs users edit" on public.invitations;
create policy "a42 inv read needs users edit" on public.invitations as restrictive for select to authenticated
  using (public.has_area('users', 'edit'));

-- ---- 9) RC-4 quotes table: stricter delete / insert -----------------------------------
drop policy if exists "a42 quotes delete from shelf" on public.quotes;
create policy "a42 quotes delete from shelf" on public.quotes as restrictive for delete to authenticated
  using (public.can_delete() and deleted_at is not null);
drop policy if exists "a42 quotes insert can_create" on public.quotes;
create policy "a42 quotes insert can_create" on public.quotes as restrictive for insert to authenticated
  with check (public.can_create());

-- ---- 10) RC-9 org binding + EXECUTE revokes ---------------------------------------------
create or replace function public.event_site_live_until(p_site_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  -- audit-run2-0042: another studio's unpublished site gives no answer. Visitors and the
  -- public-site checks (auth.uid() null) and published sites keep the original answer.
  select case when auth.uid() is null or s.org_id = public.current_org_id() or s.status = 'published'
              then public.event_site_live_until__pre0042(s.id) end
    from public.event_sites s where s.id = p_site_id;
$$;

revoke execute on function public.work_token_expiry_for(uuid) from public, anon, authenticated;
revoke execute on function public.client_link_deadline(date, uuid, integer) from public, anon, authenticated;
grant execute on function public.work_token_expiry_for(uuid) to service_role;
grant execute on function public.client_link_deadline(date, uuid, integer) to service_role;

-- trigger functions: never called directly (a trigger fires without EXECUTE)
do $$ declare r record; begin
  for r in select p.oid::regprocedure as f from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype loop
    execute 'revoke execute on function ' || r.f::text || ' from public, anon, authenticated';
  end loop;
end $$;

-- ---- 12) NV-10: platform operators bound to their account id, not only an e-mail ------
alter table public.platform_admins add column if not exists user_id uuid;
update public.platform_admins pa set user_id = u.id
  from auth.users u
 where pa.user_id is null and lower(u.email) = pa.email and u.email_confirmed_at is not null;

do $$ declare f text; d text; begin
  foreach f in array array['is_platform_admin', 'is_platform_operator'] loop
    if to_regprocedure('public.' || f || '__pre0042()') is null then
      d := pg_get_functiondef(('public.' || f || '()')::regprocedure);
      d := replace(d, 'FUNCTION public.' || f || '(', 'FUNCTION public.' || f || '__pre0042(');
      execute d;
    end if;
    execute 'revoke all on function public.' || f || '__pre0042() from public, anon, authenticated';
    execute 'grant execute on function public.' || f || '__pre0042() to service_role';
  end loop;
end $$;

-- a row bound to an account id only answers for THAT account (an e-mail change on another
-- account can't inherit operator rights); unbound rows keep the e-mail rule
create or replace function public._a42_operator_binding_ok()
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.platform_admins pa join auth.users u on u.id = auth.uid()
                      where pa.email = lower(u.email) and pa.user_id is not null and pa.user_id <> auth.uid());
$$;
revoke all on function public._a42_operator_binding_ok() from public, anon, authenticated;
grant execute on function public._a42_operator_binding_ok() to service_role;

create or replace function public.is_platform_admin()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return public.is_platform_admin__pre0042() and public._a42_operator_binding_ok();
end $$;
create or replace function public.is_platform_operator()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return public.is_platform_operator__pre0042() and public._a42_operator_binding_ok();
end $$;

-- ---- 13) owner decision D1: no OTP dev echo outside an allowed environment -------------
-- switch the flag off where it is on and not allowed, and expire any open code that may
-- have been shown on screen (update-only)
do $$ begin
  if not public._a42_dev_echo_allowed() then
    update public.quote_otps o set expires_at = now()
     where o.verified_at is null and o.expires_at > now()
       and o.org_id in (select c.org_id from public.app_config c
                         where c.key = 'channels' and coalesce(c.value ->> 'otp_dev_echo', '') = 'true');
    update public.app_config c set value = c.value || '{"otp_dev_echo":false}'::jsonb
     where c.key = 'channels' and jsonb_typeof(c.value) = 'object' and coalesce(c.value ->> 'otp_dev_echo', '') = 'true';
  end if;
end $$;

-- ---- 14) owner decision D4: backfills (UPDATE only, re-runnable, nothing deleted) ------
-- a) bearer links / tokens out of stored notification details (RC-2)
update public.notifications n set detail = public._a42_redact_detail(n.detail)
 where jsonb_typeof(n.detail) = 'object'
   and n.detail ?| array['token', 'url', 'link', 'approval_url', 'work_url', 'work_link',
                         'portal_url', 'payment_url', 'link_url', 'approval_token', 'work_token'];
-- b) audit rows filed under the caller's studio instead of the event's (RC-8 / NV-02)
update public.audit_log a set org_id = q.org_id
  from public.quotes q
 where a.quote_id = q.id and a.action not like 'hq.%' and a.org_id is distinct from q.org_id;
update public.audit_log a set org_id = null where a.action like 'hq.%' and a.org_id is not null;
-- c) NV-05: approval links that never had an expiry get one (30 days from issue, or the
--    event window, whichever is later). Row by row so one odd legacy row can't stop the rest.
do $$ declare r record; n int := 0; begin
  for r in select q.id from public.quotes q
            where q.approval_token is not null and q.approval_token_expires_at is null loop
    begin
      update public.quotes q
         set approval_token_expires_at = greatest(q.created_at + interval '30 days',
                                                  public.client_link_deadline(q.event_date, q.org_id, 30))
       where q.id = r.id and q.approval_token_expires_at is null;
      n := n + 1;
    exception when others then
      raise notice '0042 NV-05: quote % left unchanged (%)', r.id, sqlerrm;
    end;
  end loop;
  if n > 0 then raise notice '0042 NV-05: % approval link(s) given an expiry', n; end if;
end $$;
-- d) NV-06: invitation slugs with only 24 random bits (…-<6 hex>) get 64 bits (…-<16 hex>).
--    Event sites have no slug-history mechanism (org_slug_history is for studio links),
--    and keeping the guessable slug alive would defeat the fix: studios re-share the link.
do $$ declare r record; v_new text; n int := 0; begin
  alter table public.event_sites disable trigger event_sites_guard_biu;     -- it re-derives org from the session
  for r in select s.id, s.slug from public.event_sites s where s.slug ~ '-[0-9a-f]{6}$' loop
    loop
      v_new := regexp_replace(r.slug, '-[0-9a-f]{6}$', '') || '-' || encode(extensions.gen_random_bytes(8), 'hex');
      exit when not exists (select 1 from public.event_sites x where x.slug = v_new);
    end loop;
    update public.event_sites s set slug = v_new, updated_at = now() where s.id = r.id and s.slug = r.slug;
    insert into public.audit_log(action, entity, entity_id, quote_id, org_id, changed)
      select 'event_site.reslugged', 'event_sites', s.id::text, s.quote_id, s.org_id,
             jsonb_build_object('reason', 'legacy 24-bit slug')
        from public.event_sites s where s.id = r.id;
    n := n + 1;
  end loop;
  alter table public.event_sites enable trigger event_sites_guard_biu;
  if n > 0 then raise notice '0042 NV-06: % invitation slug(s) re-generated — studios must re-share them', n; end if;
end $$;

-- ---- 11) grants: exactly what each entry point had before -----------------------------
do $$ declare f text; begin
  foreach f in array array['public_get_quote(uuid)', 'public_get_portal(uuid)', 'create_payment(uuid)',
      'request_otp(uuid, text)', 'verify_and_consent(uuid, text, text, boolean, text, text, text, text)',
      'public_get_proposal(uuid)', 'task_proof_upload_ok(text)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    execute 'grant execute on function public.' || f || ' to anon, authenticated, service_role';
  end loop;
  foreach f in array array['revoke_approval_token(uuid)', 'generate_approval_token(uuid)', 'move_quote_to_shelf(uuid, text)',
      'bell_feed(integer)', 'record_settlement_payment(uuid, numeric, text, text, uuid, text, text)',
      'record_payment(uuid, numeric, text, text, uuid, text, text)', 'close_event(uuid, boolean)',
      'set_closure(uuid, integer, text, text, boolean, text)', 'set_lifecycle_stage(uuid, text)', 'mark_paid(uuid, text)',
      'accept_invitation(text)', 'admin_create_user(text, text, text)', 'create_invitation(text, text)',
      'create_studio(text, text, text, text)', 'event_site_live_until(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated, service_role';
  end loop;
  foreach f in array array['otp_send_authorize(uuid, text)', 'payment_link_begin(uuid, integer)',
      '_mp_sync_staff(uuid, jsonb)', '_admin_create_user_core(text, text, text)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------------
-- select proname from pg_proc where proname like '%\_\_pre0042' order by 1;
-- select key, value from public.helm_env_settings;   -- staging only: allow_otp_dev_echo = true
