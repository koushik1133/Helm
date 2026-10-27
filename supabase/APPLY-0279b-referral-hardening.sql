-- APPLY-0279b-referral-hardening.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- ONLY for a database that ALREADY ran APPLY-0279.sql before this fix. (A database that has not run 0279 yet: just run the
-- updated APPLY-0279.sql - it already contains these changes. Running this file as well is harmless.)
-- R32 review of the referral program (PR #264):
--   REF-02  the sign-up "attach my code" call is limited to 10 tries an hour per person (stops code guessing) -> reason 'rate'.
--   REF-03  the public code look-up no longer has a shared "everyone" counter (one sender could use it up and block the
--           look-up for every visitor); the per-network limit (60 an hour) stays. The daily job now clears its own expired
--           rate-limit counters (referral_rate_buckets older than 2 hours - hour windows, nothing about a person).
-- 3 functions re-issued in place (same names, arguments, answers, grants). No table, column, policy or referral row is
-- changed. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. If it says STOP, run APPLY-0279.sql instead (0279 is not on this database yet).
--   2  Every VERIFY row at the end must say ok = true.
--   3  Nothing to deploy for this file (the page text change ships with the site).
begin;
do $$ begin
  if to_regclass('public.referral_rate_buckets') is null or to_regclass('public.referral_codes') is null
     or to_regprocedure('public._r29_rate(text, integer)') is null
     or to_regprocedure('public._r29_attach(uuid, text, text, boolean, text, timestamptz, uuid)') is null
     or to_regprocedure('public.referral_attach(text, text, timestamptz, boolean, text)') is null
     or to_regprocedure('public.referral_lookup(text)') is null or to_regprocedure('public.referral_tick()') is null then
    raise exception 'STOP 0279b: 0279 (referral program) is not applied here - run APPLY-0279.sql instead (it already has these fixes)';
  end if;
end $$;

create or replace function public.referral_attach(p_typed text default null, p_link text default null, p_link_at timestamptz default null,
  p_consent boolean default false, p_device text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v_org uuid := public.current_org_id(); s public.referral_settings := public._r29_cfg(); v_t text; v_l text; o record;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if public.is_platform_operator() then return jsonb_build_object('ok', false, 'reason', 'existing'); end if;
  if not s.program_on then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  -- r29c REF-02: at most 10 tries an hour per person (a sign-up attaches once; this stops code guessing)
  if not public._r29_rate('at:' || auth.uid()::text, 10) then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  select x.created_at, x.created_by into o from public.organizations x where x.id = v_org;
  -- only the person who created the studio, and only while it is new (team members who join never attach a code)
  if o.created_by is distinct from auth.uid() or o.created_at < now() - make_interval(hours => s.self_attach_hours) then
    return jsonb_build_object('ok', false, 'reason', 'code_after'); end if;
  v_t := upper(btrim(coalesce(p_typed, ''))); v_l := upper(btrim(coalesce(p_link, '')));
  if v_t <> '' and v_t !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then v_t := ''; end if;
  if v_l <> '' and (v_l !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' or p_link_at is null or p_link_at < now() - make_interval(days => s.link_days)
                    or p_link_at > now() + interval '1 hour') then v_l := ''; end if;
  if v_t <> '' and exists (select 1 from public.referral_codes c where c.code = v_t) then
    return public._r29_attach(v_org, v_t, 'typed', p_consent, left(p_device, 64), null, auth.uid());
  end if;
  if v_l <> '' then return public._r29_attach(v_org, v_l, 'link', p_consent, left(p_device, 64), p_link_at, auth.uid()); end if;
  return jsonb_build_object('ok', false, 'reason', case when v_t <> '' or btrim(coalesce(p_typed, '')) <> '' then 'unknown' else 'none' end);
end $$;

create or replace function public.referral_lookup(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v text := upper(btrim(coalesce(p_code, ''))); c public.referral_codes; v_prob text;
  v_net text := coalesce(public._r29_hash('ip', public._hq27_client_ip()), 'none');
begin
  if v !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then return jsonb_build_object('ok', false, 'reason', 'shape'); end if;
  -- r29c REF-03: per network only - a shared "everyone" counter let one sender block the look-up for all visitors
  if not public._r29_rate('lk:' || left(v_net, 32), 60) then
    return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  select * into c from public.referral_codes where code = v;
  v_prob := public._r29_code_problem(c);
  if v_prob <> '' then return jsonb_build_object('ok', false, 'reason', v_prob); end if;
  return jsonb_build_object('ok', true, 'code', c.code, 'kind', case when c.kind = 'studio' then 'referral' else 'partner' end,
    'offer', public._r29_offer(c), 'offer_type', c.offer_type, 'months', c.offer_months, 'percent', c.offer_percent,
    'for_months', c.offer_for_months, 'ends_at', c.ends_at, 'terms', c.terms);
end $$;

create or replace function public.referral_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare s public.referral_settings := public._r29_cfg(); r record; v text; n_q int := 0; n_np int := 0; n_x int := 0; n_a int := 0; n_e int := 0; n int;
  n_rb int := 0;
begin
  -- 0) r29c REF-03: expired rate-limit counters (hour windows, nothing about a person) are cleared after 2 hours
  delete from public.referral_rate_buckets where window_start < now() - interval '2 hours';
  get diagnostics n_rb = row_count;
  -- 1) holds that are over -> confirmed (or refunded / cancelled)
  for r in select x.id from public.referrals x where x.status = 'hold' and x.hold_until <= now() order by x.hold_until limit 2000 loop
    begin v := public._r29_qualify(r.id); if v = 'qualified' then n_q := n_q + 1; end if;
    exception when others then n_e := n_e + 1;
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
        values (null, null, 'referral.error', 'referrals', r.id::text, jsonb_build_object('step', 'qualify', 'error', left(sqlstate || ' ' || sqlerrm, 300)), null, now());
    end;
  end loop;
  -- 2) never paid within the window
  update public.referrals set status = 'not_qualified', reason = 'no_payment', updated_at = now()
   where status in ('signed_up', 'trial', 'first_month', 'review') and first_paid_at is null
     and signed_up_at < now() - make_interval(days => s.pay_within_days);
  get diagnostics n_np = row_count;
  -- 3) a plan started without a payment yet -> "paid plan, free month"
  update public.referrals x set status = 'first_month', plan_started_at = coalesce(x.plan_started_at, now()), updated_at = now()
   where x.status in ('signed_up', 'trial') and x.first_paid_at is null
     and exists (select 1 from public.studio_subscriptions st where st.org_id = x.referred_org and st.status in ('active', 'past_due'));
  -- 4) held: the studio pays now -> scheduled; waited too long -> expired
  for r in select x.id, x.studio_id, x.held_until from public.referral_rewards x where x.state = 'held' loop
    if public._r29_paying(r.studio_id) then perform public._r29_set_state(r.id, 'scheduled', 'the studio started paying');
    elsif r.held_until is not null and r.held_until < now() then perform public._r29_set_state(r.id, 'expired', 'no payment within the held time'); n_x := n_x + 1;
    end if;
  end loop;
  -- 5) frozen too long / unused for 24 months -> expired
  for r in select x.id from public.referral_rewards x where x.state = 'frozen' and x.frozen_at < now() - make_interval(months => s.frozen_months) loop
    perform public._r29_set_state(r.id, 'expired', 'the studio did not come back in time'); n_x := n_x + 1;
  end loop;
  for r in select x.id from public.referral_rewards x where x.state in ('held', 'scheduled', 'frozen') and x.expires_at < now() loop
    perform public._r29_set_state(r.id, 'expired', 'unused for ' || s.expiry_months || ' months'); n_x := n_x + 1;
  end loop;
  -- 6) use free months that are due
  for r in select distinct x.studio_id from public.referral_rewards x where x.state = 'scheduled' and x.kind = 'month' and x.studio_id is not null loop
    begin n := public._r29_apply(r.studio_id); n_a := n_a + n;
    exception when others then n_e := n_e + 1;
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
        values (null, null, 'referral.error', 'studio_subscriptions', r.studio_id::text, jsonb_build_object('step', 'apply', 'error', left(sqlstate || ' ' || sqlerrm, 300)), null, now());
    end;
  end loop;
  return jsonb_build_object('qualified', n_q, 'not_paid', n_np, 'expired', n_x, 'applied', n_a, 'errors', n_e,
                            'rate_buckets_cleared', n_rb, 'at', now());
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 REF-02 referral_attach is rate-limited per person (10 an hour)',
     position('r29c REF-02' in pg_get_functiondef('public.referral_attach(text,text,timestamptz,boolean,text)'::regprocedure)) > 0),
  ('02 REF-03 referral_lookup has no shared everyone counter (the per-network limit is kept)',
     position('lk:all' in pg_get_functiondef('public.referral_lookup(text)'::regprocedure)) = 0
     and position('r29c REF-03: per network only' in pg_get_functiondef('public.referral_lookup(text)'::regprocedure)) > 0),
  ('03 REF-03 the daily job clears expired rate counters',
     position('referral_rate_buckets where window_start' in pg_get_functiondef('public.referral_tick()'::regprocedure)) > 0),
  ('04 grants unchanged: look-up public, attach signed-in, the job service role only',
     has_function_privilege('anon', 'public.referral_lookup(text)', 'execute')
     and has_function_privilege('authenticated', 'public.referral_attach(text,text,timestamptz,boolean,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.referral_tick()', 'execute')),
  ('05 nothing removed: every referral table still there',
     (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
        and c.relname in ('referral_settings', 'referral_codes', 'referral_click_days', 'referral_rate_buckets', 'referrals',
                          'referral_rewards', 'referral_reward_events', 'referral_fingerprints', 'referral_notice_queue')) = 9)
) v(item, ok) order by item;
