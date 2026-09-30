-- =====================================================================
-- SEC-06 (MEDIUM integrity + LOW functional) — atomic teardown return,
--        anon-safe invitation preview
-- =====================================================================
-- FINDING A (data integrity): teardown.html "Return" does two separate calls —
--   1) PATCH inventory_reservations.status = 'returned'
--   2) rpc adjust_inventory_total(item, -damaged)
-- If (2) fails, the reservation is marked returned but the damaged stock is never
-- written off (and cannot be retried from the UI, because the row is no longer
-- active). The damaged count is also never checked against the reserved qty, so a
-- typo can wipe out an item's whole stock.
--
-- FIX A: public.return_reservation(p_reservation_id uuid, p_damaged numeric)
--   One SECURITY DEFINER transaction: lock the reservation row (FOR UPDATE),
--   require has_area('inventory','edit') (same gate as phase73
--   checkout_equipment / checkin_equipment), scope BOTH the reservation and the
--   item to current_org_id(), reject a repeat return (only 'reserved' /
--   'allocated' rows can be returned), reject p_damaged outside 0..qty, set
--   status = 'returned', and deduct the damaged qty from inventory_items.total_qty
--   (floored at 0, as adjust_inventory_total / checkin_equipment do). Any error
--   rolls back both writes.
--   p_damaged is NUMERIC to match inventory_reservations.qty and
--   inventory_items.total_qty (both numeric; units include m / kg).
--
-- FINDING B (functional): login.html's invite banner calls invitation_by_token,
--   which phase83 grants to `authenticated` only. The banner only runs for
--   signed-out visitors, so it always failed silently.
--
-- FIX B: public.invitation_preview(p_token text) — anon-callable, STABLE, read-only.
--   Returns ONLY { valid, status, role, org_name, expired } — never the invited
--   email, the inviter, the org id or the invitation id. invitation_by_token is
--   left untouched (still authenticated-only).
--   Token guessing: phase83 tokens are encode(gen_random_bytes(24),'hex') =
--   48 hex chars = 192 bits of CSPRNG entropy, unique, expiring in 7 days.
--   Enumeration is infeasible, and a caller who already holds a valid token is
--   the intended invitee, so exposing the org name + role to that holder is
--   acceptable. Malformed tokens are rejected before any table read.
--
-- Additive + idempotent (create or replace; no table/column changes). Front-end
-- ships first and falls back to the old paths while these functions are absent.
-- Apply on STAGING first, run VERIFY, then PRODUCTION.
-- =====================================================================

-- ---- PRECHECK (read-only) ----
-- Expect: both functions absent (0 rows) on first apply; inventory_reservations
-- and inventory_items both have org_id; has_area / current_org_id exist.
select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('return_reservation','invitation_preview');

select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'inventory_reservations' and column_name in ('id','org_id','item_id','qty','status'))
    or (table_name = 'inventory_items'        and column_name in ('id','org_id','total_qty'))
    or (table_name = 'invitations'            and column_name in ('token','status','role','org_id','expires_at')))
order by table_name, column_name;

select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('has_area','current_org_id');

-- ---- APPLY (idempotent) ----

-- A) atomic teardown return --------------------------------------------------
create or replace function public.return_reservation(p_reservation_id uuid, p_damaged numeric default 0)
  returns public.inventory_reservations
  language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_res public.inventory_reservations;
  v_dmg numeric := coalesce(p_damaged, 0);
begin
  if not public.has_area('inventory','edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_org is null then
    raise exception 'no organization context' using errcode = '42501'; end if;

  -- lock the row so two concurrent returns serialize; the second sees 'returned'
  select * into v_res from public.inventory_reservations
   where id = p_reservation_id and org_id = v_org
   for update;
  if not found then raise exception 'reservation not found' using errcode = '42501'; end if;

  if v_res.status not in ('reserved','allocated') then
    raise exception 'reservation is already %', v_res.status using errcode = '22023'; end if;
  if v_dmg < 0 or v_dmg > v_res.qty then
    raise exception 'damaged quantity must be between 0 and %', v_res.qty using errcode = '22023'; end if;

  update public.inventory_reservations
     set status = 'returned'
   where id = v_res.id and org_id = v_org
  returning * into v_res;

  if v_dmg > 0 then
    update public.inventory_items
       set total_qty = greatest(0, coalesce(total_qty,0) - v_dmg)
     where id = v_res.item_id and org_id = v_org;
    if not found then raise exception 'item not found' using errcode = '42501'; end if;  -- rolls back the status change
  end if;

  return v_res;
end; $$;
revoke all on function public.return_reservation(uuid, numeric) from public;
revoke all on function public.return_reservation(uuid, numeric) from anon;
grant execute on function public.return_reservation(uuid, numeric) to authenticated;

-- B) anon-safe invitation preview -------------------------------------------
create or replace function public.invitation_preview(p_token text)
  returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare v_row public.invitations; v_org text;
begin
  -- phase83 tokens are exactly 48 lowercase hex chars; reject anything else early
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    return jsonb_build_object('valid', false, 'status', 'not_found', 'expired', false);
  end if;
  select * into v_row from public.invitations where token = p_token;
  if v_row.id is null then
    return jsonb_build_object('valid', false, 'status', 'not_found', 'expired', false);
  end if;
  select name into v_org from public.organizations where id = v_row.org_id;
  -- ONLY what the login banner shows: no email, no ids, no inviter.
  return jsonb_build_object(
    'valid',    (v_row.status = 'pending' and v_row.expires_at > now()),
    'status',   v_row.status,
    'role',     v_row.role,
    'org_name', v_org,
    'expired',  (v_row.expires_at <= now())
  );
end; $$;
revoke all on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- ---- VERIFY ----
-- Expect: both rows prosecdef = true, search_path set; return_reservation
-- anon=false / authenticated=true; invitation_preview anon=true / authenticated=true;
-- invitation_preview volatility = 's' (stable).
select p.proname,
       pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       p.provolatile as volatility,
       p.proconfig as config,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('return_reservation','invitation_preview');

-- anon preview of a bogus token must return not_found and no email key:
select public.invitation_preview('0000') as bogus_preview,
       (public.invitation_preview(repeat('0',48)) ? 'email') as leaks_email;  -- expect false

-- Functional smoke (as a signed-in inventory editor, in the app): Return a
-- reservation with damaged > qty -> error, nothing changes; damaged within range
-- -> status 'returned' and total_qty reduced; Return again -> 'already returned'.

-- ---- ROLLBACK ----
-- Front-end falls back automatically (PGRST202) once these are dropped.
-- drop function if exists public.return_reservation(uuid, numeric);
-- drop function if exists public.invitation_preview(text);
-- notify pgrst, 'reload schema';
