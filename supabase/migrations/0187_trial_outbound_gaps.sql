-- 0187_trial_outbound_gaps.sql - CANONICAL forward-only. REQUIRES 0027 + 0097 (payment_link_begin),
-- 0166 (_sample_outbound_blocked, outbox skip triggers), 0179 (_tb179_no_send), 0183 (_trial_locked,
-- status-based).
--
-- In plain words (trial bundle final review): two ways a free-trial studio could still reach a REAL client.
--   1) QUEUED MESSAGES AFTER THE TRIAL ENDED. The 0166 outbox guard (comms_outbox / pkg_outbox /
--      assign_notify_outbox rows stored as 'skipped') asked only "is the subscription 'trial'?". The
--      billing tick moves an ended, unpaid trial to 'past_due', so from then on the automatic payment
--      reminders and client follow-ups that comms_tick (pg_cron) queues for that studio's own events were
--      stored as 'pending' and comms-dispatch would send them. _sample_outbound_blocked now also says
--      "blocked" for an ended, never-paid trial that is read-only (_trial_locked, 0183: status-based,
--      never trial_ends_at alone) - the same rule 0179 already uses for the direct send routes. This
--      part does not depend on the helm_sample_template.block_trial_outbound switch. Client messages
--      such a studio ALREADY has waiting ('pending', never sent) in comms_outbox / pkg_outbox are set to
--      'skipped' once (the same thing the guard does to a new row; the row itself is kept).
--   2) RAZORPAY PAYMENT LINKS. create-payment-link (live pay) asks payment_link_begin, and Razorpay then
--      texts / e-mails the client the link (notify sms + email) and takes real money. 0097 only refused
--      demo events, so a trial studio's own event could get a real link. payment_link_begin is wrapped
--      (current body kept as payment_link_begin__pre0187): a quote of a studio for which 0179 says
--      "no client messages" (free trial, ended unpaid trial, sample master) is refused 42501 / hint
--      'trial_no_send'. The simulated checkout (create_payment, off production) is unchanged.
--   Paid studios: never matched by either rule - nothing changes for them.
-- Changes: 1 function body re-issued (same signature, same grants), 1 function wrapped (same signature,
-- service role only as before). No table or column is created, changed or dropped; nothing is deleted.
-- The only rows written: waiting client messages of ended, never-paid trials -> status 'skipped' (never
-- a paid studio: _trial_locked is false for any studio that ever paid). Additive + idempotent: safe to
-- run twice (a second run finds nothing to skip). ASCII only.
-- ROLLBACK (manual, only if ever needed): re-run 0166 section 6 (_sample_outbound_blocked); drop function
-- public.payment_link_begin(uuid, integer); alter function public.payment_link_begin__pre0187(uuid, integer)
-- rename to payment_link_begin; grant execute on it to service_role. No data is touched either way.

do $$ begin
  if to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null or to_regprocedure('public._ts166_tg_outbox_skip()') is null then
    raise exception '0187: apply 0166 first'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception '0187: apply 0179 first'; end if;
  if to_regprocedure('public._trial_effective_end(uuid)') is null then raise exception '0187: apply 0183 first'; end if;
  if to_regprocedure('public.payment_link_begin(uuid,integer)') is null then raise exception '0187: apply 0027 + 0097 first'; end if;
end $$;

-- ---- 1) outbox guard: an ended, unpaid (read-only) trial queues nothing either --------------------------
create or replace function public._sample_outbound_blocked(p_org uuid, p_recipient text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-sandbox-0166 trial-outbound-0187
  -- (p_recipient kept for the next phase: per-recipient rules; sample contacts are already
  --  undeliverable @example.com / +91 00000 and demo events are skipped by 0097)
  select (p_org is not null and exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master))
      or (p_org is not null and coalesce((select t.block_trial_outbound from public.helm_sample_template t where t.id), true)
          and public._is_trial_org(p_org))
      -- 0187: an ended, never-paid free trial (read-only, status-based) never messages its clients
      or (p_org is not null and coalesce(public._trial_locked(p_org), false));
$$;
revoke all on function public._sample_outbound_blocked(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._sample_outbound_blocked(uuid, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._sample_outbound_blocked(uuid, text) from authenticated; end if;
end $$;

-- messages an ended, unpaid trial already has waiting: skipped once (kept, never sent)
do $$ declare t text; begin
  foreach t in array array['comms_outbox', 'pkg_outbox'] loop
    if to_regclass('public.' || t) is not null then
      execute format('update public.%I x set status = ''skipped'' where x.status = ''pending'' and x.sent_at is null '
                     'and x.org_id is not null and public._trial_locked(x.org_id)', t);
    end if;
  end loop;
end $$;

-- ---- 2) no real Razorpay payment link for a quote of a studio that sends no client messages ------------
do $$ begin
  if to_regprocedure('public.payment_link_begin__pre0187(uuid,integer)') is null
     and position('trial-outbound-0187' in pg_get_functiondef(to_regprocedure('public.payment_link_begin(uuid,integer)'))) = 0 then
    alter function public.payment_link_begin(uuid, integer) rename to payment_link_begin__pre0187;
  end if;
end $$;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer default 4320)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- trial-outbound-0187: free trial / ended unpaid trial / sample master -> no real payment link (Razorpay
-- would text and e-mail the client and take real money)
begin
  if exists (select 1 from public.quotes q where p_token is not null and q.approval_token = p_token and public._tb179_no_send(q.org_id)) then
    raise exception 'Free trial: online payment links are not sent to clients' using errcode = '42501', hint = 'trial_no_send';
  end if;
  return public.payment_link_begin__pre0187(p_token, p_ttl_minutes);
end $$;

-- grants: both service role only (as payment_link_begin always was)
do $$ declare f text; begin
  foreach f in array array['public.payment_link_begin(uuid, integer)', 'public.payment_link_begin__pre0187(uuid, integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
