-- 0336_r128_security_fixes.sql - CANONICAL forward-only. R128 (owner: "start PR 2"): the open items from the security list.
-- REQUIRES 0154 (crew link limiter), 0156 (client contact guard, a156 consent), 0297 (auth_rate_hits_purge), 0298 (_r57_trusted_ip),
--          0334 (_r125_uuid, trial_preview_bundle)
--
-- In plain words:
--   1  The crew link limit by address read the FIRST x-forwarded-for value, which the caller can type. It now reads the address
--      the platform saw (_r57_trusted_ip, the helper the other limits already use). The limit per link is unchanged.
--   2  The crew link counter table was never cleaned. The daily rate-limit purge now also removes its expired counters (windows
--      are one minute, so a row older than two days can change no limit).
--   3  Live updates: Postgres cannot apply studio rules to a delete event, so it told every subscriber the id of a deleted row in
--      any studio. Delete events are no longer published. Effect: a lead deleted by a teammate leaves an open Leads page at the
--      next change or refresh. Inserts and updates are unchanged.
--   4  Changing the client's phone or e-mail while an unapproved approval link is live now also cancels that link, because the
--      approval code goes to the contact on the quote: staff could otherwise point the code at themselves and approve. It does
--      what the Revoke action does. Sending for approval again makes a new link. A quote already approved or paid is left alone (the same token opens the portal).
--   5  New approval_check_shown(token, total): the approval page asks whether the total on screen is still the quote's total just
--      before approving. A staff edit after that moment cancels the open code (0156), so the check cannot be raced.
--   6  trial_preview_bundle: a member reaching a crew or vendor preview without quotes access no longer gets the client's name,
--      e-mail, phone or total in the preview hint.
--   7  booklet_snapshot_path: a trial studio's booklet token now answers like a token that does not exist, as every other link
--      does since 0334 (this path was missed; the edge function is off unless HELM_BOOKLET_SNAPSHOT_ENABLED is set).
-- ZERO DATA LOSS: no table, column or policy is added or dropped. The only rows ever deleted are expired rate-limit counters.
-- Old bodies kept once as *__pre0336 with NO app privilege. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): for F in auth_rate_hits_purge(integer), trial_preview_bundle(text,uuid,jsonb),
--   booklet_snapshot_path(uuid,text): drop function public.F(args); alter function public.F__pre0336(args) rename to F; + re-grant;
--   drop function public.approval_check_shown(uuid,numeric);
--   alter publication supabase_realtime set (publish = 'insert, update, delete, truncate');
--   item 1 and 4: re-issue the body from 0154 / 0156.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r57_trusted_ip()') is null then raise exception 'STOP 0336: 0298 (_r57_trusted_ip) is not applied'; end if;
  if to_regprocedure('public.auth_rate_hits_purge(integer)') is null then raise exception 'STOP 0336: 0297 (auth_rate_hits_purge) is not applied'; end if;
  if to_regprocedure('public.tg_a156_client_contact_guard()') is null or to_regprocedure('public._a42_expire_open_otps(uuid)') is null then
    raise exception 'STOP 0336: 0156 (client contact guard) is not applied'; end if;
  if to_regprocedure('public._r125_uuid(text,uuid)') is null or to_regprocedure('public.trial_preview_bundle(text,uuid,jsonb)') is null then
    raise exception 'STOP 0336: 0334 (R125) is not applied'; end if;
  if to_regprocedure('public.booklet_snapshot_path(uuid,text)') is null then raise exception 'STOP 0336: 0069 / 0260 (booklet_snapshot_path) is not applied'; end if;
  if to_regclass('public.a154_link_hits') is null then raise exception 'STOP 0336: 0154 (a154_link_hits) is not applied'; end if;
end $$;

-- ---- 1) the crew link limit reads the address the platform saw --------------------------------------------------------
-- The 0154 body now lives under a kept name (it has been wrapped since), so it is found by its text, not its name.
do $$
declare r record; v_old constant text := $o$v_ip := split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1);$o$;
        v_new constant text := $n$v_ip := coalesce(public._r57_trusted_ip(), '');   -- r128-0336: never the first x-forwarded-for value$n$;
        v_def text; v_done int := 0;
begin
  for r in select p.oid from pg_catalog.pg_proc p
            where p.pronamespace = 'public'::regnamespace and position(v_old in p.prosrc) > 0 loop
    v_def := pg_catalog.pg_get_functiondef(r.oid);
    execute replace(v_def, v_old, v_new);
    v_done := v_done + 1;
  end loop;
  if v_done = 0 and not exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace
                                 and position('r128-0336: never the first x-forwarded-for value' in p.prosrc) > 0) then
    raise exception 'STOP 0336: the 0154 crew link limiter was not found'; end if;
end $$;

-- ---- 2) the daily purge also clears expired crew link counters --------------------------------------------------------
do $$ begin
  if to_regprocedure('public.auth_rate_hits_purge__pre0336(integer)') is null then
    alter function public.auth_rate_hits_purge(integer) rename to auth_rate_hits_purge__pre0336;
  end if;
end $$;
create or replace function public.auth_rate_hits_purge(p_max integer default 50000)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r128-0336
declare v_n integer; v_m integer;
begin
  v_n := public.auth_rate_hits_purge__pre0336(p_max);
  delete from public.a154_link_hits h
   where h.k in (select x.k from public.a154_link_hits x
                  where x.window_start < now() - interval '2 days'
                  limit greatest(1, least(coalesce(p_max, 50000), 500000)));
  get diagnostics v_m = row_count;
  return coalesce(v_n, 0) + v_m;
end $$;

-- ---- 3) delete events are not published -------------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise notice '0336: no supabase_realtime publication here (plain Postgres test harness) - nothing to do'; return; end if;
  execute 'alter publication supabase_realtime set (publish = ''insert, update'')';
end $$;

-- ---- 4) a contact change cancels an unapproved link -------------------------------------------------------------------
create or replace function public.tg_a156_client_contact_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: the OTP goes to quotes.client; a change during a live link cancels open codes
-- r128-0336: the audit row says whether the link is cancelled (zzzzz_r128_contact_cancels_link does it, after the save)
declare v_ph boolean; v_em boolean; v_cancel boolean;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  v_ph := regexp_replace(coalesce(old.client ->> 'phone', ''), '[^0-9]', '', 'g')
          is distinct from regexp_replace(coalesce(new.client ->> 'phone', ''), '[^0-9]', '', 'g');
  v_em := lower(btrim(coalesce(old.client ->> 'email', ''))) is distinct from lower(btrim(coalesce(new.client ->> 'email', '')));
  if not (v_ph or v_em) then return new; end if;
  if new.approval_token is not null and new.approval_token_revoked_at is null
     and (new.approval_token_expires_at is null or new.approval_token_expires_at > now()) then
    v_cancel := coalesce(new.approval_status, '') not in ('approved', 'paid');
    new.client_contact_changed_at := now();
    perform public._a42_expire_open_otps(new.id);
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (auth.uid(), 'client_contact_change', 'quotes', new.id::text, new.id,
              jsonb_build_object('phone_changed', v_ph, 'email_changed', v_em, 'approval_link_live', true,
                                 'approval_status', new.approval_status, 'link_cancelled', v_cancel), new.org_id);
  end if;
  return new;
end $$;

-- quotes_api_state_guard refuses a link change made as an app user, so the cancel runs after the save, as the function owner,
-- exactly like zzzzz_a156_price_change_otps. Staff saving a contact never touches the link columns themselves.
create or replace function public.tg_r128_contact_cancels_link()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r128-0336
begin
  if new.client_contact_changed_at is distinct from old.client_contact_changed_at
     and new.client_contact_changed_at is not null
     and new.approval_token_revoked_at is null
     and coalesce(new.approval_status, '') not in ('approved', 'paid') then
    -- the same three columns as the app's own Revoke (revoke_approval_token), so the staff page and the next send need nothing new
    update public.quotes q
       set approval_token = null, approval_token_revoked_at = now(),
           approval_status = case when q.approval_status in ('sent', 'none') then 'cancelled' else q.approval_status end
     where q.id = new.id and q.approval_token_revoked_at is null;
  end if;
  return null;
end $$;
drop trigger if exists zzzzz_r128_contact_cancels_link on public.quotes;
create trigger zzzzz_r128_contact_cancels_link after update of client on public.quotes
  for each row execute function public.tg_r128_contact_cancels_link();

-- ---- 5) is the total on the client's screen still the quote's total? --------------------------------------------------
create or replace function public.approval_check_shown(p_token uuid, p_total numeric)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r128-0336: reads one number for the holder of the link, writes nothing. A link that does not exist says ok: the approval
-- itself refuses it, so this cannot be used to test whether a link exists.
declare v_total numeric;
begin
  if p_token is null or p_total is null then return jsonb_build_object('ok', true); end if;
  select public.helm_pricing_num(q.pricing -> 'total') into v_total from public.quotes q where q.approval_token = p_token;
  if v_total is null or abs(v_total - p_total) < 0.005 then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', false, 'error', 'price_changed',
    'message', 'The price on this quote was updated after you opened it. Please reload the page to see the new total, then approve.');
end $$;

-- ---- 6) a crew or vendor preview without quotes access gets no client details -----------------------------------------
do $$ begin
  if to_regprocedure('public.trial_preview_bundle__pre0336(text,uuid,jsonb)') is null then
    alter function public.trial_preview_bundle(text, uuid, jsonb) rename to trial_preview_bundle__pre0336;
  end if;
end $$;
create or replace function public.trial_preview_bundle(p_kind text, p_quote uuid default null, p_opts jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r128-0336: every check is in the kept body; this only removes what the member's role cannot read
declare v jsonb := public.trial_preview_bundle__pre0336(p_kind, p_quote, p_opts);
begin
  if jsonb_typeof(v -> 'hint') = 'object'
     and not public.has_area('quotes', 'view')
     and not (p_kind = 'proposal' and public.has_area('proposal', 'view')) then
    v := jsonb_set(v, '{hint}', (v -> 'hint') - array['client_name', 'client_email', 'client_phone', 'total']::text[]);
  end if;
  return v;
end $$;

-- ---- 7) a trial studio's booklet token: no snapshot --------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.booklet_snapshot_path__pre0336(uuid,text)') is null then
    alter function public.booklet_snapshot_path(uuid, text) rename to booklet_snapshot_path__pre0336;
  end if;
end $$;
create or replace function public.booklet_snapshot_path(p_token uuid, p_kind text)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- r128-0336
begin
  return public.booklet_snapshot_path__pre0336(public._r125_uuid('booklet', p_token), p_kind);
end $$;

-- ---- 8) privileges ----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public.auth_rate_hits_purge__pre0336(integer)', 'public.trial_preview_bundle__pre0336(text, uuid, jsonb)',
                           'public.booklet_snapshot_path__pre0336(uuid, text)', 'public.auth_rate_hits_purge(integer)',
                           'public.booklet_snapshot_path(uuid, text)', 'public.trial_preview_bundle(text, uuid, jsonb)',
                           'public.approval_check_shown(uuid, numeric)', 'public.tg_a156_client_contact_guard()',
                           'public.tg_r128_contact_cancels_link()'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || f || ' from service_role'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.approval_check_shown(uuid, numeric) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.approval_check_shown(uuid, numeric) to authenticated';
    execute 'grant execute on function public.trial_preview_bundle(text, uuid, jsonb) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.approval_check_shown(uuid, numeric) to service_role';
    execute 'grant execute on function public.auth_rate_hits_purge(integer) to service_role';
    execute 'grant execute on function public.booklet_snapshot_path(uuid, text) to service_role'; end if;
end $$;
