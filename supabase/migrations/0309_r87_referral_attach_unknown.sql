-- 0309_r87_referral_attach_unknown.sql - CANONICAL forward-only. R87 (referral edge cases, Low): code-existence oracle.
-- Bug: while the global switch referral_settings.program_on is OFF (pilot list in use), referral_attach answered
-- "off" / "inactive" for a REAL non-pilot studio code or a partner code, but "unknown" for a code that does not exist,
-- so a signed-in new studio admin could tell which codes exist. 0306 already closed this on referral_lookup.
-- Fix (house "wrap once" pattern, as 0307): the logic lives in NEW public._r309_attach (re-issued on every run); the
-- live referral_attach is renamed ONCE to referral_attach__pre0309 (app privileges taken away) and a thin wrapper with
-- the same signature and the same grants takes its place. The wrapper calls the kept body unchanged and only maps the
-- answer: when the program is not on globally (but some pilot is, so the code was checked), reason "off" / "inactive"
-- becomes "unknown" - the same rule as referral_lookup. Every other answer (ok, rate, code_after, existing, none,
-- duplicate, expired, full, self_referral, ...) and every side effect / rate limit is exactly as before; pilot studio
-- codes still attach; with the switch fully off and no pilot the answer stays "off" for every code (uniform, no oracle).
-- No table / column / row / policy / index / trigger created, changed or deleted. Safe to run twice. ASCII only.
do $$
begin
  if to_regprocedure('public.referral_attach(text,text,timestamptz,boolean,text)') is null then
    raise exception 'STOP 0309: public.referral_attach is missing (needs 0279 + 0306)'; end if;
  if to_regprocedure('public._r29_any_on()') is null or to_regprocedure('public._r29_cfg()') is null then
    raise exception 'STOP 0309: public._r29_any_on / _r29_cfg missing (needs 0279 + 0306)'; end if;
end $$;

-- ---- 1) the logic (re-issued on every run; not callable by the app) ----------------------------------------------
create or replace function public._r309_attach(p_typed text, p_link text, p_link_at timestamptz, p_consent boolean, p_device text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r87-attach-unknown-0309: switch off (pilot mode) -> a refused real code answers "unknown" like a missing code
declare v_out jsonb;
begin
  v_out := public.referral_attach__pre0309(p_typed, p_link, p_link_at, p_consent, p_device);
  if coalesce((v_out ->> 'ok')::boolean, false) = false and v_out ->> 'reason' in ('off', 'inactive')
     and public._r29_any_on() and not coalesce((public._r29_cfg()).program_on, false) then
    v_out := jsonb_set(v_out, '{reason}', to_jsonb('unknown'::text));
  end if;
  return v_out;
end $$;

-- ---- 2) wrap once: a 2nd run (or a run after a LATER wrapper) never replaces what is there ------------------------
do $$ declare v_src text; begin
  if to_regprocedure('public.referral_attach__pre0309(text,text,timestamptz,boolean,text)') is null then
    alter function public.referral_attach(text, text, timestamptz, boolean, text) rename to referral_attach__pre0309;
    create function public.referral_attach(p_typed text default null, p_link text default null, p_link_at timestamptz default null,
                                           p_consent boolean default false, p_device text default null)
      returns jsonb language sql volatile security definer set search_path = ''
      as 'select public._r309_attach(p_typed, p_link, p_link_at, p_consent, p_device) /* r87-attach-unknown-0309 */';
  else
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.referral_attach(text,text,timestamptz,boolean,text)');
    if position('_r309_attach' in coalesce(v_src, '')) = 0 then
      raise notice '0309: referral_attach was re-issued after 0309 - left unchanged (check the chain still reaches _r309_attach)';
    end if;
  end if;
end $$;

-- ---- 3) privileges: the live name keeps the app grant; the kept body and the logic are not callable by the app ----
revoke all on function public.referral_attach(text, text, timestamptz, boolean, text) from public;
revoke all on function public.referral_attach__pre0309(text, text, timestamptz, boolean, text) from public;
revoke all on function public._r309_attach(text, text, timestamptz, boolean, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      if r <> 'anon' then
        execute format('grant execute on function public.referral_attach(text, text, timestamptz, boolean, text) to %I', r);
      else
        execute format('revoke all on function public.referral_attach(text, text, timestamptz, boolean, text) from %I', r);
      end if;
      if r <> 'service_role' then
        execute format('revoke all on function public.referral_attach__pre0309(text, text, timestamptz, boolean, text) from %I', r);
        execute format('revoke all on function public._r309_attach(text, text, timestamptz, boolean, text) from %I', r);
      end if;
    end if;
  end loop;
end $$;
