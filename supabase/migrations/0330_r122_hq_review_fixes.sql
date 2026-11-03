-- 0330_r122_hq_review_fixes.sql - CANONICAL forward-only. R122 (HQ code review: suspend / reactivate of a studio with no
-- subscription, "change by hand" guard rails, no raw PII in the HQ log, consent only from the studio, read pages that
-- do not write, studio-day billing, gates before look-ups, payment replay + currency checks).
-- REQUIRES 0329 (R121), 0045 (HQ subscriptions), 0058 (_billing_refresh wrapper / _trial_refresh), 0159
--          (studio_payment_gate, _studio_payment_pending), 0257 (hq_set_studio_identity), 0277 (HQ staff gates),
--          0283 (hq_studio_owner_recover), 0287 (studio_today, hq_overview, hq_billing, hq_audit), 0298 (masking
--          helpers, hq_reveal, hq_users / hq_studios / hq_studio_detail wrappers, hq_mfa_reset).
--
-- In plain words:
--   1  Suspend + reactivate of a studio that had NO subscription row (an older studio, or a studio created directly
--      and still waiting for its first payment) no longer turns it into a free trial that never ends. Suspend now
--      records prev_status 'none' ("had no subscription"; the prev_status check is widened to a superset). Reactivate
--      gives it back the same effect as having no row: status 'active' with no plan period and prev_status 'none' kept
--      as the marker. Such a row: never a trial, never past due (no period end), shown in HQ as "No plan", and a
--      directly-created studio still waiting for its first payment stays behind the payment gate
--      (_studio_payment_pending sees the marker row like no row). A suspended row from before this file with
--      prev_status 'trial' and no trial date anywhere (the old bug) is reactivated the same way. Existing rows are
--      NOT changed by this file (the APPLY file reports how many are affected).
--   2  HQ "Change plan or status by hand" (hq_set_subscription) now needs a reason (5+ characters, kept in the HQ log),
--      refuses status 'trial' and any trial end date ("use Extend trial"), refuses to create a new subscription with
--      no status, and refuses status 'active' without a period end. The function gains one argument (p_reason); the
--      7-argument version is kept once as hq_set_subscription__pre0330 with no app privilege.
--   3  The HQ log no longer stores raw personal data for: business details (field names + masked values only; no
--      address / contact names), two-step reset (masked e-mail + user id), studio owner recovery (masked e-mail +
--      user id). hq_audit masks e-mails / phones / PAN / GSTIN / tax ids / mandate references in every row it shows
--      (older rows too - masked on read, nothing rewritten), and e-mail-looking search terms of hq.view rows.
--   4  hq_set_studio_account returns the saved business details MASKED (like hq_studio_detail).
--   5  hq_set_studio_account refuses terms_version_accepted / consent_version / marketing_opt_in - only the studio
--      itself gives consent (the studio-side paths that use _studio_account_apply are unchanged).
--   6  hq_overview and hq_billing (read pages) no longer run the billing refresh (past-due flips, reminder e-mails).
--      The scheduled job and the HQ "Refresh past-due" button still run it.
--   7  The paid-plan part of the billing refresh uses each studio's own calendar day (studio_today) for "period ended"
--      and "due within 7 days", like the trial part.
--   8  hq_studio_owner_recover checks the HQ role (Owner) and a fresh two-step code BEFORE it looks anything up.
--   9  hq_set_studio_identity checks the HQ role (studios.edit) BEFORE it locks / looks up the studio or the link.
--  10  hq_reveal('member', ...) only shows the e-mail of a studio member; Helm HQ team people and people with no
--      studio are refused.
--  11  HQ people / studio search: matching on e-mail addresses needs 3+ characters (studio name / link search is
--      unchanged). The search term was and is kept (shortened) in the hq.view log row.
--  12  hq_set_staff_settings: leaving the IP allow-list switch out keeps it as it is (it no longer turns it off).
--  13  hq_record_payment refuses the same payment twice (same studio, amount, currency and reference within one day)
--      and a currency different from the studio's billing currency (when one is set).
--  14  hq_mfa_reset writes its HQ log row also when there was nothing to reset.
--   B  "Paid to Helm": _hq_studio_rows.total_paid is now the INR equivalent (stored rate of each payment);
--      hq_studio_detail also returns paid_by_currency [{currency, amount}] and total_paid_inr.
-- ZERO DATA LOSS: no table, column, row or policy is dropped; no row is changed by this file. One check constraint is
-- replaced by a superset (prev_status + 'none'). Every re-issued function keeps its old body once as *__pre0330 with
-- NO app privilege. Additive + idempotent: safe to run twice. ASCII only. Goes after 0329.
-- ROLLBACK (manual, only if ever needed - SQL editor), per re-issued function F(args):
--   drop function public.F(args); alter function public.F__pre0330(args) rename to F; + re-grant as before
--   (hq_set_subscription: drop the 8-argument version, rename the 7-argument __pre0330 back)

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r329_pause_text(uuid)') is null or to_regprocedure('public.accept_invitation__pre0329(text)') is null then
    raise exception 'STOP 0330: 0329 (R121) is not applied - run APPLY-0329.sql first'; end if;
  if to_regprocedure('public._r57_mask_obj(jsonb,text[],text[],text[])') is null or to_regprocedure('public._r57_mask_email(text)') is null
     or to_regprocedure('public.hq_studio_detail__pre0298(uuid)') is null or to_regprocedure('public.hq_users__pre0298(text,integer,integer)') is null then
    raise exception 'STOP 0330: 0298 (R57 masking) is not applied'; end if;
  if to_regprocedure('public.studio_today(uuid,timestamp with time zone)') is null then raise exception 'STOP 0330: 0287 (studio_today) is not applied'; end if;
  if to_regprocedure('public._trial_refresh()') is null or to_regprocedure('public._billing_refresh()') is null then
    raise exception 'STOP 0330: 0045 / 0058 (billing refresh) are not applied'; end if;
  if to_regclass('public.studio_payment_gate') is null or to_regprocedure('public._studio_payment_pending(uuid)') is null then
    raise exception 'STOP 0330: 0159 (payment gate) is not applied'; end if;
  if to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null or to_regprocedure('public._hq27_require(text,boolean)') is null then
    raise exception 'STOP 0330: 0277 (HQ staff gates) is not applied'; end if;
  if to_regprocedure('public.hq_studio_owner_recover(uuid,text,text)') is null or to_regprocedure('public._r283_owner(uuid)') is null then
    raise exception 'STOP 0330: 0283 (owner recovery) is not applied'; end if;
end $$;

-- ---- 1) keep the current bodies once (__pre0330, no app privilege) -----------------------------------------------------
do $$
declare
  f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values
      ('hq_suspend_studio', 'uuid,text'),
      ('hq_reactivate_studio', 'uuid'),
      ('hq_set_subscription', 'uuid,text,text,date,date,date,text'),
      ('hq_set_studio_account', 'uuid,jsonb'),
      ('hq_mfa_reset', 'text,text'),
      ('hq_studio_owner_recover', 'uuid,text,text'),
      ('hq_audit', 'date,date'),
      ('hq_overview', ''),
      ('hq_billing', 'date,date'),
      ('_billing_refresh', ''),
      ('hq_set_studio_identity', 'uuid,text,text,text'),
      ('hq_reveal', 'text,text,text'),
      ('hq_users', 'text,integer,integer'),
      ('hq_studios', 'text,text,integer,integer'),
      ('hq_set_staff_settings', 'integer,integer,integer,boolean,text[]'),
      ('hq_record_payment', 'uuid,numeric,date,text,text,date,date,text,numeric'),
      ('_hq_studio_rows', ''),
      ('hq_studio_detail', 'uuid'),
      ('_studio_payment_pending', 'uuid')) x(n, a)
  loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0330(' || f.a || ')');
    if v_pub is not null and v_pre is null
       and position('r122-0330' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0330');
    end if;
    v_pre := to_regprocedure('public.' || f.n || '__pre0330(' || f.a || ')');
    if v_pre is not null then
      execute 'revoke all on function ' || v_pre::text || ' from public';
      if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
    end if;
  end loop;
end $$;

-- ---- 2) item 1: prev_status 'none' = "had no subscription row" (superset of the old check) ------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint c where c.conrelid = 'public.studio_subscriptions'::regclass
                  and c.conname = 'studio_subscriptions_prev_status_check' and pg_get_constraintdef(c.oid) like '%none%') then
    alter table public.studio_subscriptions drop constraint if exists studio_subscriptions_prev_status_check;
    alter table public.studio_subscriptions add constraint studio_subscriptions_prev_status_check
      check (prev_status is null or prev_status in ('trial', 'active', 'past_due', 'cancelled', 'none'));
  end if;
end $$;

-- a row restored from "no subscription": active, no plan period, marker prev_status 'none'
create or replace function public._r330_no_sub(p_status text, p_prev text, p_period_end date)
returns boolean language sql immutable set search_path = '' as $$
  -- r122-0330
  select coalesce(p_status = 'active' and p_prev = 'none' and p_period_end is null, false);
$$;

create or replace function public.hq_suspend_studio(p_org uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0045 body; a studio with no subscription row (or a restored "no subscription" row) keeps
-- prev_status 'none' - never 'trial'
declare v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform public._hq_wgate('hq.studio.suspend', 'studio_subscriptions', p_org::text, jsonb_build_object('reason', left(v_reason, 300)));
  if not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'unknown studio' using errcode = '22023'; end if;
  if length(v_reason) < 3 then raise exception 'a reason is required' using errcode = '22023'; end if;
  insert into public.studio_subscriptions(org_id, status, prev_status, suspended_at, suspend_reason, updated_at, updated_by)
    values (p_org, 'suspended', 'none', now(), left(v_reason, 300), now(), auth.uid())
  on conflict (org_id) do update set
    prev_status = case when studio_subscriptions.status = 'suspended' then studio_subscriptions.prev_status
                       when public._r330_no_sub(studio_subscriptions.status, studio_subscriptions.prev_status,
                                                studio_subscriptions.current_period_end) then 'none'
                       else studio_subscriptions.status end,
    status = 'suspended',
    suspended_at = case when studio_subscriptions.status = 'suspended' then studio_subscriptions.suspended_at else now() end,
    suspend_reason = left(v_reason, 300), updated_at = now(), updated_by = auth.uid();
  return jsonb_build_object('org_id', p_org, 'status', 'suspended');
end $$;

create or replace function public.hq_reactivate_studio(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0045 body; prev_status 'none' (or the old bug: 'trial' with no trial date anywhere) comes back as
-- "no subscription" (active, no period, marker kept) - never an endless trial. Nothing is deleted.
declare s public.studio_subscriptions; v_status text;
begin
  perform public._hq_wgate('hq.studio.reactivate', 'studio_subscriptions', p_org::text);
  select * into s from public.studio_subscriptions x where x.org_id = p_org and x.status = 'suspended' for update;
  if s.org_id is null then raise exception 'this studio is not suspended' using errcode = '22023'; end if;
  if s.prev_status = 'none'
     or (s.prev_status = 'trial' and s.trial_ends_at is null
         and not exists (select 1 from public.organizations o where o.id = p_org and o.trial_ends_at is not null)) then
    update public.studio_subscriptions set status = 'active', prev_status = 'none',
           suspended_at = null, suspend_reason = null, updated_at = now(), updated_by = auth.uid()
     where org_id = p_org and status = 'suspended' and current_period_end is null;
    if found then return jsonb_build_object('org_id', p_org, 'status', 'none', 'restored', 'no_subscription'); end if;
  end if;
  update public.studio_subscriptions set status = coalesce(nullif(prev_status, 'none'), 'active'), prev_status = null, suspended_at = null,
         suspend_reason = null, updated_at = now(), updated_by = auth.uid()
   where org_id = p_org and status = 'suspended'
  returning status into v_status;
  if v_status is null then raise exception 'this studio is not suspended' using errcode = '22023'; end if;
  return jsonb_build_object('org_id', p_org, 'status', v_status);
end $$;

-- the payment gate (0159) sees a restored "no subscription" row exactly like no row
create or replace function public._studio_payment_pending(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r122-0330: _studio_payment_pending__pre0330 (0159) + a restored "no subscription" row counts as no row
  select public._studio_payment_pending__pre0330(p_org)
      or (p_org is not null
          and exists (select 1 from public.studio_payment_gate g join public.organizations o on o.id = g.org_id
                        join public.studio_subscriptions s on s.org_id = o.id
                       where g.org_id = p_org and o.trial_ends_at is null
                         and public._r330_no_sub(s.status, s.prev_status, s.current_period_end))
          and not public._trial_paid(p_org));
$$;

-- ---- 3) item 2: "change by hand" guard rails ---------------------------------------------------------------------------
create or replace function public.hq_set_subscription(p_org uuid, p_plan_code text default null, p_status text default null,
  p_trial_ends_at date default null, p_period_start date default null, p_period_end date default null, p_notes text default null,
  p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0045 body + a reason (in the HQ log), never a trial (use Extend trial), active needs a period end
declare v_plan uuid; cur public.studio_subscriptions; v_found boolean; v_reason text := btrim(coalesce(p_reason, ''));
  v_st text := nullif(lower(btrim(coalesce(p_status, ''))), '');
begin
  perform public._hq_wgate('hq.subscription.set', 'studio_subscriptions', p_org::text,
    jsonb_build_object('plan', p_plan_code, 'status', v_st, 'trial_ends_at', p_trial_ends_at,
                       'period_start', p_period_start, 'period_end', p_period_end, 'reason', left(v_reason, 300)));
  if not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'unknown studio' using errcode = '22023'; end if;
  if char_length(v_reason) < 5 then
    raise exception 'Give a reason of at least 5 characters (it is kept in the HQ log).' using errcode = '22023'; end if;
  if v_st = 'trial' or p_trial_ends_at is not null then
    raise exception 'The free trial is not changed here - use Extend trial (Plan & billing, Free trial).' using errcode = '22023',
      hint = 'use_extend_trial'; end if;
  if v_st is not null and v_st not in ('active', 'past_due', 'cancelled') then
    raise exception 'status must be active, past_due or cancelled (use suspend / reactivate for suspension)' using errcode = '22023'; end if;
  if p_plan_code is not null then
    select id into v_plan from public.helm_plans where code = lower(btrim(p_plan_code));
    if v_plan is null then raise exception 'unknown plan' using errcode = '22023'; end if;
  end if;
  if p_period_start is not null and p_period_end is not null and p_period_end < p_period_start then
    raise exception 'period end is before period start' using errcode = '22023'; end if;
  select * into cur from public.studio_subscriptions where org_id = p_org for update;
  v_found := found;
  if v_found and cur.status = 'suspended' and v_st is not null then
    raise exception 'this studio is suspended - reactivate it first' using errcode = '22023'; end if;
  if not v_found and v_st is null then
    raise exception 'This studio has no subscription yet - choose a status (or use Activate plan).' using errcode = '22023'; end if;
  if v_st = 'active' and coalesce(p_period_end, case when v_found then cur.current_period_end end) is null then
    raise exception 'An active plan needs a period end - fill in Period end.' using errcode = '22023'; end if;
  insert into public.studio_subscriptions(org_id, plan_id, status, current_period_start, current_period_end, notes, updated_at, updated_by)
    -- (a new row always has a status - refused above; the coalesce only satisfies NOT NULL before ON CONFLICT is resolved)
    values (p_org, v_plan, coalesce(v_st, cur.status, 'active'), p_period_start, p_period_end, nullif(left(p_notes, 1000), ''), now(), auth.uid())
  on conflict (org_id) do update set
    plan_id = coalesce(v_plan, studio_subscriptions.plan_id),
    status = coalesce(v_st, studio_subscriptions.status),
    prev_status = case when v_st is not null then null else studio_subscriptions.prev_status end,
    current_period_start = coalesce(p_period_start, studio_subscriptions.current_period_start),
    current_period_end = coalesce(p_period_end, studio_subscriptions.current_period_end),
    notes = coalesce(nullif(left(p_notes, 1000), ''), studio_subscriptions.notes),
    updated_at = now(), updated_by = auth.uid();
  return (select to_jsonb(s) - 'prev_status' from public.studio_subscriptions s where s.org_id = p_org);
end $$;

-- ---- 4) items 3 + 4 + 5: business details from HQ - masked log, masked answer, no consent ------------------------------
create or replace function public._r330_mask_changed(c jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  -- r122-0330: the personal values an HQ log row may carry, masked (anything else untouched)
  select public._r57_mask_obj(c,
    array['email', 'new_owner', 'target_email', 'owner_email', 'member_email', 'primary_contact_email', 'secondary_contact_email',
          'billing_contact_email', 'reply_email', 'contact_email'],
    array['phone', 'contact_phone', 'primary_contact_phone', 'secondary_contact_phone'],
    array['pan', 'tax_id', 'gstin', 'payment_mandate_ref']);
$$;

create or replace function public.hq_set_studio_account(p_org uuid, p_account jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0045 body; the HQ log keeps field names + masked values (no address / contact names), consent fields
-- are refused (only the studio gives consent), the answer is masked like hq_studio_detail
declare v_log jsonb := null; v jsonb;
begin
  if p_account is not null and jsonb_typeof(p_account) = 'object' then
    v_log := jsonb_build_object('fields', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(p_account) k), '[]'::jsonb),
      'values', public._r330_mask_changed(p_account - 'billing_address' - 'primary_contact_name' - 'secondary_contact_name'));
  end if;
  perform public._hq_wgate('hq.studio_account.set', 'studio_account', p_org::text, v_log);
  if not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'unknown studio' using errcode = '22023'; end if;
  if p_account is not null and jsonb_typeof(p_account) = 'object'
     and p_account ?| array['terms_version_accepted', 'consent_version', 'marketing_opt_in'] then
    raise exception 'Terms, data-processing consent and marketing choices are given by the studio itself, not from Helm HQ.'
      using errcode = '22023', hint = 'consent_studio_only';
  end if;
  v := public._studio_account_apply(p_org, p_account);
  return public._r330_mask_changed(v);
end $$;

-- the HQ log as security.read sees it: personal values masked in every row (older rows too - masked on read)
create or replace function public._r330_mask_term(p text)
returns text language sql immutable set search_path = '' as $$
  -- r122-0330: an hq.view search term ("term" or "term|status"): any part with an @ is masked like an e-mail
  select case when p is null or position('@' in p) = 0 then p
              else (select string_agg(case when position('@' in x.t) > 0 then public._r57_mask_email(x.t) else x.t end, '|' order by x.n)
                      from unnest(string_to_array(p, '|')) with ordinality x(t, n)) end;
$$;

create or replace function public.hq_audit(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: hq_audit__pre0330 (0287) with e-mails / phones / ids in "changed" and e-mail search terms masked
declare r jsonb; v jsonb;
begin
  perform public._hq27_require(public._hq27_read_perm('hq_audit'), false);   -- refused here first (the kept body checks + logs again)
  r := public.hq_audit__pre0330(p_from, p_to);
  if r is null or jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'rows') <> 'array' then return r; end if;
  select coalesce(jsonb_agg(
           case when x.e ->> 'action' = 'hq.view' and position('@' in coalesce(x.e ->> 'entity_id', '')) > 0
                then jsonb_set(x.e, '{entity_id}', to_jsonb(public._r330_mask_term(x.e ->> 'entity_id'))) else x.e end
           || case when jsonb_typeof(x.e -> 'changed') = 'object'
                   then jsonb_build_object('changed', public._r330_mask_changed(x.e -> 'changed')) else '{}'::jsonb end
           order by x.n), '[]'::jsonb)
    into v from jsonb_array_elements(r -> 'rows') with ordinality x(e, n);
  return jsonb_set(r, '{rows}', v);
end $$;

-- ---- 5) items 3 + 14: two-step reset - the log row always, never the raw e-mail ---------------------------------------
create or replace function public.hq_mfa_reset(p_email text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0298 body; the HQ log row is written before "nothing to reset" too, with the e-mail masked
declare
  v_me     uuid := auth.uid();
  v_aal    text := coalesce(auth.jwt() ->> 'aal', '');
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_target uuid; v_temail text; v_memail text; v_n int := 0; v_recent int; me public.platform_admins;
begin
  if v_me is null or not public.is_platform_admin() or v_aal <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501',
      hint = 'Only a Helm HQ operator signed in with two-step verification can reset two-step for someone else.';
  end if;
  perform public._hq27_require('security.write', true);
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'Enter the person''s e-mail address.' using errcode = '22023'; end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'Give a reason of 10 to 500 characters (for example how you confirmed who they are).' using errcode = '22023';
  end if;
  select u.id, u.email into v_target, v_temail from auth.users u where lower(u.email) = v_email order by u.created_at limit 1;
  if v_target is null then raise exception 'No Helm account uses that e-mail address.' using errcode = 'P0002'; end if;
  if v_target = v_me then
    raise exception 'You can''t reset your own two-step. Ask another Helm HQ operator to do it.' using errcode = '42501';
  end if;
  select * into me from public._hq27_me();
  if exists (select 1 from public.platform_admins pa
              where (pa.email = lower(v_temail) or pa.user_id = v_target) and coalesce(pa.status, '') <> 'removed')
     and coalesce(me.role, '') <> 'owner' then
    raise exception 'Only the Helm HQ Owner can reset the two-step of a Helm HQ team member.' using errcode = '42501';
  end if;
  select count(*) into v_recent from public.mfa_resets r where r.operator_user_id = v_me and r.at > now() - interval '24 hours';
  if v_recent >= 10 then raise exception 'Too many two-step resets in the last 24 hours. Try again tomorrow.' using errcode = 'P0001'; end if;
  if to_regclass('auth.mfa_factors') is null then raise exception 'Two-step verification is not available on this database.' using errcode = 'P0001'; end if;
  execute 'select count(*) from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'''
    into v_n using v_target;
  -- audited HQ write (refuses again if the caller is not an operator) - also when there is nothing to reset
  perform public._hq_wgate('hq.mfa.reset', 'auth_user', v_target::text,
    jsonb_build_object('email', public._r57_mask_email(v_temail), 'factors', coalesce(v_n, 0), 'reason', v_reason,
                       'result', case when coalesce(v_n, 0) = 0 then 'nothing_to_reset' else 'reset' end));
  if coalesce(v_n, 0) = 0 then
    return jsonb_build_object('ok', true, 'factors_reset', 0, 'message', 'This account has no two-step set up - nothing to reset.');
  end if;
  execute 'update auth.mfa_factors set status = ''unverified'', updated_at = now() where user_id = $1 and status::text = ''verified'''
    using v_target;
  get diagnostics v_n = row_count;
  select u.email into v_memail from auth.users u where u.id = v_me;
  insert into public.mfa_resets(target_user_id, target_email, operator_user_id, operator_email, reason, factors_reset)
    values (v_target, v_temail, v_me, v_memail, v_reason, v_n);
  return jsonb_build_object('ok', true, 'factors_reset', v_n,
    'message', 'Two-step reset. At their next sign-in they use their password (or Google) only and Helm asks them to set two-step up again.');
end $$;

-- ---- 6) items 3 + 8: studio owner recovery - gate first, no raw e-mail in the log --------------------------------------
create or replace function public.hq_studio_owner_recover(p_org uuid, p_email text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0283 body; the HQ role (Owner) + a fresh two-step code are checked BEFORE any look-up, and the HQ log
-- keeps the new owner's user id + masked e-mail
declare v_me uuid := auth.uid(); v_reason text := btrim(coalesce(p_reason, '')); v_email text := lower(btrim(coalesce(p_email, '')));
        v_target uuid; v_prev uuid; v_by text;
begin
  if v_me is null or not public.is_platform_admin() or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501', hint = 'Only a Helm HQ person signed in with two-step can do this.';
  end if;
  perform public._hq27_require(public._hq27_write_perm('hq.studio.owner_recover'), true);
  if length(v_reason) < 20 or length(v_reason) > 1000 then
    raise exception 'Write 20 to 1000 characters: why, and how you checked who is asking (for example a call back on the registered number).' using errcode = '22023';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'no such studio' using errcode = 'P0002'; end if;
  select p.id into v_target from public.profiles p where p.org_id = p_org and lower(p.email) = v_email;
  if v_target is null or not public._r283_active_admin(p_org, v_target) then
    raise exception 'The new owner must be an active admin of this studio. Ask the studio to make them an admin first.' using errcode = '22023';
  end if;
  v_prev := public._r283_owner(p_org);
  if v_prev is not null and v_prev = v_target then raise exception 'This person is already the studio owner.' using errcode = '22023'; end if;
  if (select count(*) from public.team_owner_log l where l.by_user = v_me and l.source = 'hq_recovery' and l.at > now() - interval '24 hours') >= 5 then
    raise exception 'Too many owner recoveries in the last 24 hours. Try again tomorrow.' using errcode = 'P0001';
  end if;
  perform public._hq_wgate('hq.studio.owner_recover', 'organizations', p_org::text,
    jsonb_build_object('new_owner', public._r57_mask_email(v_email), 'new_owner_id', v_target, 'prev_owner', v_prev, 'reason', v_reason));
  select lower(u.email) into v_by from auth.users u where u.id = v_me;
  insert into public.team_owner_log(org_id, user_id, prev_user_id, source, by_user, by_email, reason)
    values (p_org, v_target, v_prev, 'hq_recovery', v_me, v_by, v_reason);
  update public.team_owner_transfers set status = 'void', decided_at = now() where org_id = p_org and status = 'pending';
  update public.team_admin_changes set status = 'void', decided_at = now(), note = 'Studio owner changed by Helm support.'
   where org_id = p_org and status = 'pending' and target_user = v_target;
  perform public._r283_notify(p_org, 'owner_recovered', v_target, jsonb_build_object('to', public._r283_name(v_target), 'by', 'Helm support'), true);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (v_me, v_by, 'team.owner.hq_recovery', 'profiles', v_target::text, jsonb_build_object('prev_owner', v_prev), p_org, now());
  return jsonb_build_object('ok', true, 'owner', v_target, 'previous', v_prev);
end $$;

-- ---- 7) items 6 + 7: read pages do not write; the paid refresh on the studio's own day ----------------------------------
create or replace function public._r330_paid_refresh()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0045 paid-plan refresh (_billing_refresh__pre0058) on each studio's own calendar day (studio_today)
declare n_pd int := 0; n_rem int := 0; n int; rec record;
begin
  for rec in
    select s.org_id, s.current_period_end from public.studio_subscriptions s
     where s.status = 'active' and s.current_period_end is not null and s.current_period_end < public.studio_today(s.org_id)
       and not exists (select 1 from public.subscription_payments sp where sp.org_id = s.org_id and sp.voided_at is null
                        and sp.period_end is not null and sp.period_end >= public.studio_today(s.org_id))
     for update of s
  loop
    update public.studio_subscriptions set status = 'past_due', updated_at = now() where org_id = rec.org_id and status = 'active';
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'hq.billing.auto_past_due', 'studio_subscriptions', rec.org_id::text,
              jsonb_build_object('current_period_end', rec.current_period_end), null, now());
    n_pd := n_pd + 1;
  end loop;
  insert into public.billing_reminders(org_id, kind, period_end)
    select s.org_id, 'past_due', s.current_period_end from public.studio_subscriptions s
     where s.status = 'past_due' and s.current_period_end is not null
  on conflict (org_id, kind, period_end) do nothing;
  get diagnostics n = row_count; n_rem := n_rem + n;
  insert into public.billing_reminders(org_id, kind, period_end)
    select s.org_id, 'due_soon', s.current_period_end from public.studio_subscriptions s
     where s.status in ('active', 'trial') and s.current_period_end between public.studio_today(s.org_id) and public.studio_today(s.org_id) + 7
       and not exists (select 1 from public.subscription_payments sp where sp.org_id = s.org_id and sp.voided_at is null
                        and sp.period_end is not null and sp.period_end > s.current_period_end)
  on conflict (org_id, kind, period_end) do nothing;
  get diagnostics n = row_count; n_rem := n_rem + n;
  return jsonb_build_object('past_due_set', n_pd, 'reminders_queued', n_rem);
end $$;

create or replace function public._billing_refresh()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0058 wrapper (_billing_refresh__pre0330) with the paid part on the studio's own day (_r330_paid_refresh)
declare r jsonb; t jsonb;
begin
  r := public._r330_paid_refresh();
  t := public._trial_refresh();
  return coalesce(r, '{}'::jsonb) || jsonb_build_object(
    'past_due_set', coalesce((r ->> 'past_due_set')::int, 0) + (t ->> 'trial_past_due_set')::int,
    'reminders_queued', coalesce((r ->> 'reminders_queued')::int, 0) + (t ->> 'trial_reminders_queued')::int) || t;
end $$;

create or replace function public.hq_overview()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0287 body WITHOUT the billing refresh (a read page writes nothing; the scheduled job + "Refresh
-- past-due" still run it); a restored "no subscription" row counts as none
declare r jsonb; v jsonb; n bigint; m bigint; today date := public.hq_today();
begin
  perform public._hq_gate('hq_overview');
  r := jsonb_build_object(
    'generated_at', now(),
    'studios', jsonb_build_object(
      'total',  (select count(*) from public.organizations),
      'new_7d', (select count(*) from public.organizations where created_at >= now() - interval '7 days'),
      'new_30d',(select count(*) from public.organizations where created_at >= now() - interval '30 days'),
      'by_status', (select jsonb_object_agg(t.st_k, t.st_c) from (
          select case when public._r330_no_sub(ss.status, ss.prev_status, ss.current_period_end) then 'none'
                      else coalesce(ss.status, 'none') end st_k, count(*) st_c
            from public.organizations o left join public.studio_subscriptions ss on ss.org_id = o.id group by 1) t)),
    'users', jsonb_build_object(
      'total',  (select count(*) from auth.users),
      'new_7d', (select count(*) from auth.users where created_at >= now() - interval '7 days'),
      'new_30d',(select count(*) from auth.users where created_at >= now() - interval '30 days'),
      'active_7d', (select count(*) from auth.users where last_sign_in_at >= now() - interval '7 days'),
      'active_30d',(select count(*) from auth.users where last_sign_in_at >= now() - interval '30 days')),
    'billing', jsonb_build_object(
      'mrr', public._hq_mrr(), 'mrr_inr', public._hq_mrr_inr(),
      'paid_this_month', public._hq_money_by_currency(date_trunc('month', public.hq_today())::date, today),
      'past_due_count', (select count(*) from public.studio_subscriptions where status = 'past_due'),
      'suspended_count', (select count(*) from public.studio_subscriptions where status = 'suspended'),
      'reminders_pending', (select count(*) from public.billing_reminders where sent_at is null)));
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'studios', coalesce(s.c, 0), 'users', coalesce(u.c, 0)) order by d), '[]'::jsonb)
    into v
    from generate_series(today - 29, today, interval '1 day') d
    left join (select created_at::date k, count(*) c from public.organizations group by 1) s on s.k = d::date
    left join (select created_at::date k, count(*) c from auth.users group by 1) u on u.k = d::date;
  r := r || jsonb_build_object('signups_30d', v);
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select count(distinct user_id) from auth.mfa_factors where status::text = ''verified''' into n;
    select count(*) into m from auth.users;
    r := r || jsonb_build_object('mfa', jsonb_build_object('users_with_mfa', n, 'users_total', m,
             'pct', case when m > 0 then round(100.0 * n / m, 1) else 0 end));
  end if;
  if to_regclass('auth.audit_log_entries') is not null then
    begin
      execute $q$select count(*) from auth.audit_log_entries
                  where created_at >= now() - interval '7 days'
                    and payload ->> 'action' in ('login','user_signedin','token_refreshed')$q$ into n;
      r := r || jsonb_build_object('auth_logins_7d', n);
    exception when others then null;
    end;
  end if;
  return r;
end $$;

create or replace function public.hq_billing(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0287 body WITHOUT the billing refresh (a read page writes nothing)
declare f date := coalesce(p_from, date_trunc('month', public.hq_today())::date); t date := coalesce(p_to, public.hq_today());
begin
  perform public._hq_gate('hq_billing', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  return jsonb_build_object('from', f, 'to', t,
    'collected', public._hq_money_by_currency(f, t),
    'payments_count', (select count(*) from public.subscription_payments where voided_at is null and paid_on between f and t),
    'voided_count', (select count(*) from public.subscription_payments where voided_at is not null and paid_on between f and t),
    'mrr', public._hq_mrr(), 'mrr_inr', public._hq_mrr_inr(), 'unrealised_exports',
      (select count(*) from public.subscription_payments x where x.voided_at is null and x.realised_on is null
         and x.tax_regime in ('EXPORT_LUT_ZERO','EXPORT_IGST_PAID','REVERSE_CHARGE')),
    'per_studio', coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name,
            'status', case when public._r330_no_sub(s.status, s.prev_status, s.current_period_end) then 'none' else coalesce(s.status, 'none') end,
            'plan_code', hp.code, 'paid', x.paid, 'currency', x.currency, 'payments', x.n) order by o.name)
         from (select sp.org_id, sp.currency, sum(sp.amount) paid, count(*) n from public.subscription_payments sp
                where sp.voided_at is null and sp.paid_on between f and t group by sp.org_id, sp.currency) x
         join public.organizations o on o.id = x.org_id
         left join public.studio_subscriptions s on s.org_id = o.id left join public.helm_plans hp on hp.id = s.plan_id), '[]'::jsonb),
    'past_due', coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'plan_code', hp.code,
            'current_period_end', s.current_period_end, 'days_overdue', public.hq_today() - s.current_period_end) order by s.current_period_end)
         from public.studio_subscriptions s join public.organizations o on o.id = s.org_id
         left join public.helm_plans hp on hp.id = s.plan_id where s.status = 'past_due'), '[]'::jsonb),
    'reminders', coalesce((select jsonb_agg(jsonb_build_object('id', br.id, 'org_id', br.org_id, 'studio', o.name, 'kind', br.kind,
            'period_end', br.period_end, 'created_at', br.created_at, 'sent_at', br.sent_at, 'channel', br.channel) order by br.created_at desc)
         from (select * from public.billing_reminders order by created_at desc limit 100) br
         join public.organizations o on o.id = br.org_id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(public._sub_payment_json(sp) || jsonb_build_object('studio', o.name)
                          order by sp.paid_on desc, sp.recorded_at desc)
       from public.subscription_payments sp join public.organizations o on o.id = sp.org_id
      where sp.paid_on between f and t), '[]'::jsonb));
end $$;

-- ---- 8) item 9: rename / link - the HQ role first ----------------------------------------------------------------------
create or replace function public.hq_set_studio_identity(p_org uuid, p_name text, p_slug text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the HQ role (studios.edit) is checked BEFORE hq_set_studio_identity__pre0330 (0257) locks / looks up anything
begin
  if auth.uid() is null or not public.is_platform_admin() or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501',
      hint = 'Only a Helm HQ operator signed in with two-step verification can change a studio''s name or link.';
  end if;
  perform public._hq27_require(public._hq27_write_perm('hq.studio.identity'), true);
  return public.hq_set_studio_identity__pre0330(p_org, p_name, p_slug, p_reason);
end $$;

-- ---- 9) item 10: "Show" for a member = studio members only -----------------------------------------------------------
create or replace function public.hq_reveal(p_entity text, p_entity_id text, p_field text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: hq_reveal__pre0330 (0298); entity 'member' = a studio member only (not a Helm HQ team person, not someone
-- with no studio). The HQ role is checked first, as before.
declare v_id text := btrim(coalesce(p_entity_id, '')); v_uuid uuid;
begin
  if lower(btrim(coalesce(p_entity, ''))) = 'member' and lower(btrim(coalesce(p_field, ''))) in ('email', 'member_email') then
    perform public._hq27_require('studios.read', false);
    if v_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_uuid := v_id::uuid; end if;
    if v_uuid is null then raise exception 'bad id' using errcode = '22023'; end if;
    if not exists (select 1 from public.profiles p where p.id = v_uuid and p.org_id is not null)
       or exists (select 1 from public.platform_admins pa left join auth.users u on u.id = v_uuid
                   where coalesce(pa.status, '') <> 'removed' and (pa.user_id = v_uuid or pa.email = lower(u.email::text))) then
      raise exception 'This person is not a studio member.' using errcode = '22023';
    end if;
  end if;
  return public.hq_reveal__pre0330(p_entity, p_entity_id, p_field);
end $$;

-- ---- 10) item 11: e-mail matching needs 3+ characters (name / link search unchanged) -------------------------------------
create or replace function public.hq_users(p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns table(user_id uuid, email text, studio text, org_id uuid, role text, created_at timestamptz, last_sign_in_at timestamptz,
              email_confirmed boolean, mfa_enabled boolean, total_count bigint)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
-- r122-0330: the 0298 people list (e-mail masked; the search term kept shortened in the hq.view log row) - an e-mail
-- (carries the r57-0298 masking, so a re-run of 0298 never re-wraps this body)
-- matches only for a search of 3+ characters; a studio name matches as before
declare s text := nullif(btrim(coalesce(p_search, '')), ''); has_mfa boolean := to_regclass('auth.mfa_factors') is not null;
begin
  perform public._hq27_require('people.read', false);
  perform public._hq_gate('hq_users', left(s, 80));
  return query execute format($q$
    select u.id, public._r57_mask_email(u.email::text), o.name, p.org_id, p.role, u.created_at, u.last_sign_in_at,
           u.email_confirmed_at is not null, %s, count(*) over ()
      from auth.users u
      left join public.profiles p on p.id = u.id
      left join public.organizations o on o.id = p.org_id
     where $1 is null
        or (char_length($1) >= 3 and strpos(lower(coalesce(u.email, '')), lower($1)) > 0)
        or strpos(lower(coalesce(o.name, '')), lower($1)) > 0
     order by u.created_at desc, u.id
     limit $2 offset $3$q$,
    case when has_mfa then 'exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status::text = ''verified'')'
         else 'false' end)
  using s, least(greatest(coalesce(p_limit, 25), 1), 200), greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.hq_studios(p_search text default null, p_status text default null, p_limit integer default 25, p_offset integer default 0)
returns table(org_id uuid, name text, slug text, created_at timestamptz, owner_email text, users_count bigint, plan_code text,
              plan_name text, status text, current_period_end date, last_activity timestamptz, total_paid numeric, country text,
              state text, primary_contact_name text, primary_contact_email text, primary_contact_phone text, total_count bigint)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
-- r122-0330: the 0045 / 0298 studio list (e-mails / phones masked) - an e-mail matches only for a search of 3+
-- (carries the r57-0298 masking, so a re-run of 0298 never re-wraps this body)
-- characters; studio name / link search as before
declare s text := nullif(btrim(coalesce(p_search, '')), ''); st text := nullif(btrim(coalesce(p_status, '')), '');
begin
  perform public._hq27_require('studios.read', false);
  perform public._hq_gate('hq_studios', left(coalesce(s, '') || '|' || coalesce(st, ''), 80));
  if st is not null and st not in ('trial','active','past_due','suspended','cancelled','none') then
    raise exception 'unknown status filter' using errcode = '22023'; end if;
  return query
    select r.org_id, r.name, r.slug, r.created_at, public._r57_mask_email(r.owner_email), r.users_count, r.plan_code, r.plan_name, r.status,
           r.current_period_end, r.last_activity, r.total_paid, a.country, a.state, a.primary_contact_name,
           public._r57_mask_email(a.primary_contact_email), public._r57_mask_phone(a.primary_contact_phone), count(*) over ()
      from public._hq_studio_rows() r left join public.studio_account a on a.org_id = r.org_id
     where (st is null or r.status = st)
       and (s is null or strpos(lower(r.name), lower(s)) > 0 or strpos(lower(coalesce(r.slug, '')), lower(s)) > 0
            or (char_length(s) >= 3 and (strpos(lower(coalesce(r.owner_email, '')), lower(s)) > 0
                                        or strpos(lower(coalesce(a.primary_contact_email, '')), lower(s)) > 0)))
     order by r.created_at desc, r.org_id
     limit least(greatest(coalesce(p_limit, 25), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---- 11) item 12: sign-in rules - an omitted allow-list switch keeps its value -----------------------------------------
create or replace function public.hq_set_staff_settings(p_idle_minutes integer, p_max_hours integer, p_reauth_minutes integer,
                                                       p_ip_allowlist_on boolean, p_ip_allowlist text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the 0277 body; p_ip_allowlist_on null = keep the current switch (it was turned off before)
declare v_list text[] := '{}'::text[]; c text; v_ip text := public._hq27_client_ip(); v_old jsonb := public._hq27_settings_json();
  cur public.helm_hq_settings; v_on boolean; v_eff text[];
begin
  perform public._hq_wgate('hq.staff.settings', 'helm_hq_settings', 'staff', jsonb_build_object('idle', p_idle_minutes, 'max_hours', p_max_hours,
    'reauth', p_reauth_minutes, 'ip_on', p_ip_allowlist_on, 'ip_count', coalesce(array_length(p_ip_allowlist, 1), 0)));
  if p_idle_minutes is not null and (p_idle_minutes < 5 or p_idle_minutes > 240) then raise exception 'Idle limit: 5 to 240 minutes.' using errcode = '22023'; end if;
  if p_max_hours is not null and (p_max_hours < 1 or p_max_hours > 24) then raise exception 'Longest sign-in: 1 to 24 hours.' using errcode = '22023'; end if;
  if p_reauth_minutes is not null and (p_reauth_minutes < 5 or p_reauth_minutes > 240) then raise exception 'Fresh code: 5 to 240 minutes.' using errcode = '22023'; end if;
  foreach c in array coalesce(p_ip_allowlist, '{}'::text[]) loop
    c := btrim(c); if c = '' then continue; end if;
    begin perform c::cidr; exception when others then raise exception 'Not an IP address or range: %', left(c, 60) using errcode = '22023'; end;
    v_list := v_list || c;
  end loop;
  if coalesce(array_length(v_list, 1), 0) > 50 then raise exception 'At most 50 IP addresses / ranges.' using errcode = '22023'; end if;
  select * into cur from public.helm_hq_settings x where x.id;
  v_on := coalesce(p_ip_allowlist_on, cur.hq_ip_allowlist_on, false);
  v_eff := case when p_ip_allowlist is null then coalesce(cur.hq_ip_allowlist, '{}'::text[]) else v_list end;
  if v_on and not public._hq27_ip_allowed(v_ip, v_eff) then
    raise exception 'Your current IP address (%) is not in the list - add it first so you are not locked out.', coalesce(v_ip, 'unknown') using errcode = '22023';
  end if;
  update public.helm_hq_settings set hq_idle_minutes = coalesce(p_idle_minutes, hq_idle_minutes), hq_max_hours = coalesce(p_max_hours, hq_max_hours),
         hq_reauth_minutes = coalesce(p_reauth_minutes, hq_reauth_minutes), hq_ip_allowlist_on = coalesce(p_ip_allowlist_on, hq_ip_allowlist_on),
         hq_ip_allowlist = case when p_ip_allowlist is null then hq_ip_allowlist else v_list end
   where id;
  perform public._hq27_event('settings', coalesce((select me.email from public._hq27_me() me), 'hq'), jsonb_build_object('before', v_old - 'my_ip', 'after', public._hq27_settings_json() - 'my_ip'));
  return public._hq27_settings_json();
end $$;

-- ---- 12) item 13: record payment - no replay, the studio's billing currency ---------------------------------------------
create or replace function public.hq_record_payment(p_org uuid, p_amount numeric, p_paid_on date, p_method text, p_currency text default 'INR',
  p_period_start date default null, p_period_end date default null, p_reference text default null, p_fx_rate_to_inr numeric default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: the HQ role first, then: the same payment again within a day is refused (like hq_activate_plan), and a
-- currency other than the studio's billing currency is refused; then hq_record_payment__pre0330 (0045 / 0072)
declare v_cur text := upper(coalesce(nullif(btrim(p_currency), ''), 'INR')); v_bc text; v_ref text := nullif(left(btrim(coalesce(p_reference, '')), 120), '');
  v_inv text;
begin
  perform public._hq27_require(public._hq27_write_perm('hq.payment.record'), true);
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'unknown studio' using errcode = '22023'; end if;
  select upper(btrim(a.billing_currency)) into v_bc from public.studio_account a where a.org_id = p_org;
  if v_bc ~ '^[A-Z]{3}$' and v_cur <> v_bc then
    raise exception 'This studio is billed in % - record the payment in % (or change its billing currency in Business details first).', v_bc, v_bc
      using errcode = '22023', hint = 'billing_currency';
  end if;
  perform pg_advisory_xact_lock(hashtext('helm_record_payment:' || p_org::text));
  select sp.invoice_no into v_inv from public.subscription_payments sp
   where sp.org_id = p_org and sp.voided_at is null and p_amount is not null and sp.amount = round(p_amount, 2) and sp.currency = v_cur
     and sp.reference is not distinct from v_ref and sp.recorded_at > now() - interval '1 day'
   order by sp.recorded_at desc limit 1;
  if found then
    raise exception 'This payment is already recorded (% - same amount, currency and reference in the last day). If it really is a second payment, give it its own reference.', coalesce(v_inv, 'an earlier invoice')
      using errcode = '22023', hint = 'replay';
  end if;
  return public.hq_record_payment__pre0330(p_org, p_amount, p_paid_on, p_method, p_currency, p_period_start, p_period_end, p_reference, p_fx_rate_to_inr);
end $$;

-- ---- 13) item B: "Paid to Helm" = the INR equivalent; per-currency totals in the studio detail ---------------------------
create or replace function public._hq_studio_rows()
returns table(org_id uuid, name text, slug text, created_at timestamptz, owner_email text, users_count bigint, plan_code text,
              plan_name text, status text, current_period_end date, last_activity timestamptz, total_paid numeric)
language sql stable security definer set search_path = '' as $$
  -- r122-0330: the 0045 rows; total_paid = the INR equivalent of the studio's payments (each payment's stored rate),
  -- never a sum of mixed currencies; a restored "no subscription" row shows as 'none'
  select o.id, o.name, o.slug, o.created_at,
         coalesce(cu.email, (select p.email from public.profiles p where p.org_id = o.id and p.role = 'admin'
                              order by p.created_at limit 1)),
         (select count(*) from public.profiles p where p.org_id = o.id),
         hp.code, hp.name,
         case when public._r330_no_sub(s.status, s.prev_status, s.current_period_end) then 'none' else coalesce(s.status, 'none') end,
         s.current_period_end,
         (select max(u.last_sign_in_at) from public.profiles p join auth.users u on u.id = p.id where p.org_id = o.id),
         coalesce((select sum(coalesce(sp.inr_equivalent,
                                       round(sp.amount * case when coalesce(sp.currency, 'INR') = 'INR' then 1 else sp.fx_rate_to_inr end, 2), 0))
                     from public.subscription_payments sp where sp.org_id = o.id and sp.voided_at is null), 0)
    from public.organizations o
    left join auth.users cu on cu.id = o.created_by
    left join public.studio_subscriptions s on s.org_id = o.id
    left join public.helm_plans hp on hp.id = s.plan_id
$$;

create or replace function public.hq_studio_detail(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r122-0330: hq_studio_detail__pre0330 (0298, masked) + paid_by_currency [{currency, amount}] + total_paid_inr; a
-- (carries the r57-0298 masking, so a re-run of 0298 never re-wraps this body)
-- restored "no subscription" row shows subscription.status 'none'
declare r jsonb;
begin
  perform public._hq27_require('studios.read', false);   -- refused here first (the kept body checks + logs again)
  r := public.hq_studio_detail__pre0330(p_org);
  if r is null or jsonb_typeof(r) <> 'object' then return r; end if;
  r := r || jsonb_build_object(
    'paid_by_currency', coalesce((select jsonb_agg(jsonb_build_object('currency', t.currency, 'amount', t.amt) order by t.currency)
                                    from (select coalesce(sp.currency, 'INR') currency, sum(sp.amount) amt from public.subscription_payments sp
                                           where sp.org_id = p_org and sp.voided_at is null group by 1) t), '[]'::jsonb),
    'total_paid_inr', r -> 'total_paid');
  if r ->> 'status' = 'none' and jsonb_typeof(r -> 'subscription') = 'object' and r #>> '{subscription,status}' = 'active' then
    r := jsonb_set(r, '{subscription,status}', '"none"'::jsonb) || jsonb_build_object('no_subscription', true);
  end if;
  return r;
end $$;

-- ---- 14) privileges (each public function keeps exactly the roles it had) -------------------------------------------------
do $$ declare f text; begin
  -- internal helpers: never callable by the API roles
  foreach f in array array['public._r330_no_sub(text, text, date)', 'public._r330_mask_changed(jsonb)', 'public._r330_mask_term(text)',
      'public._r330_paid_refresh()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- internal re-issued functions: service role only (as before)
  foreach f in array array['public._billing_refresh()', 'public._hq_studio_rows()', 'public._studio_payment_pending(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  -- HQ entry points: signed-in (the HQ gates inside decide) + service role, never anon
  foreach f in array array['public.hq_suspend_studio(uuid, text)', 'public.hq_reactivate_studio(uuid)',
      'public.hq_set_subscription(uuid, text, text, date, date, date, text, text)', 'public.hq_set_studio_account(uuid, jsonb)',
      'public.hq_mfa_reset(text, text)', 'public.hq_studio_owner_recover(uuid, text, text)', 'public.hq_audit(date, date)',
      'public.hq_overview()', 'public.hq_billing(date, date)', 'public.hq_set_studio_identity(uuid, text, text, text)',
      'public.hq_reveal(text, text, text)', 'public.hq_users(text, integer, integer)', 'public.hq_studios(text, text, integer, integer)',
      'public.hq_set_staff_settings(integer, integer, integer, boolean, text[])',
      'public.hq_record_payment(uuid, numeric, date, text, text, date, date, text, numeric)', 'public.hq_studio_detail(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
