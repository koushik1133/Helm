-- 0156_audit_p2_db_low.sql - CANONICAL forward-only.
-- REQUIRES 0042 (shelf helpers, OTP expiry) + 0049 (close gate) + 0069 (package flow) + 0078 (comms)
--          + 0083/0095 (booklet images) + 0084 (reopen_event) + 0088 (smart import) + 0097 (demo guard)
--          + 0101 (booklet pay terms) + 0124 (vendor bills) + 0131 (invite mailer) + 0132 + 0151 + 0152 + 0154.
--
-- In plain words - security audit run 3, the LOW database findings (P2):
--   1. Opening an old invitation link no longer changes the role of someone who is already a
--      member of that studio (they keep the role the admin gave them).
--   2. Only an admin can invite, and the "this address is a Helm operator" answer is no longer
--      given to anyone else. (The per-studio invitation caps live in 0155 only: trial 20 a day /
--      50 open, paid 200 a day / 500 open. 0156 adds no second set.)
--   APPLY ORDER: 0155 first, then 0156 (MANIFEST + APPLY-0155-0158.sql). 0156 wraps the 0155
--   accept_invitation / create_invitation layers; the same-studio early return below only fires
--   when the account is ALREADY in the inviting studio, so 0155's cross-studio move is untouched.
--   3. A studio member with the 'client' role can no longer read or post in the staff chat or the
--      studio-wide announcement, and no longer reads coupons, pricing config, rate cards,
--      notification defaults or other roles' access rows.
--   4. Client booklet links and published invitation sites stop working while the event sits on
--      the Archive or Deleted shelf (they work again when it is restored - nothing is revoked).
--   5. Re-opening a closed event is admin-only for real: close_event(id, false) is refused unless
--      it comes from reopen_event (which needs an admin and a reason, and is audited).
--   6. The 0152 refund / vendor-bill checks now also run when an existing row is edited (amount,
--      kind, status or event), a vendor payment can't be recorded on a closed event, and the
--      vendor_bills edit rule checks that the booking / vendor / file belong to the studio.
--   7. lead_archive (lead history) can no longer be edited or deleted from the app; only the
--      archive / restore functions write it. Reading is unchanged.
--   8. Razorpay payment-link ids can't be typed in as a receipt / reference, and the Razorpay
--      webhook only matches payment rows that Helm itself attached a link to.
--   9. notify_default (reads any studio's role settings) is no longer callable by anon or signed-in
--      users; the notification catalog helpers are no longer callable by anon.
--  10. Booklet package code: after 15 wrong codes in 24 hours no more codes or guesses that day.
--  11. Changing the client's phone or e-mail while an approval link is live cancels open codes,
--      is written to the audit log, and the consent row records when the contact last changed.
--  12. Smart Import obeys the same linked-staff and demo-data rules as the normal screens.
--  13. The client's approval is refused (code not used up) when the price changed after the page
--      was opened; open codes are cancelled when the quote total changes.
--  14. Fewer permanent rows from anonymous calls: the WhatsApp/e-mail approval writes at most one
--      failed-code audit row per quote per minute, and a random link token no longer creates a
--      rate-limit row in public_link_opened.
--  15. worker_assignment_updates is VOLATILE so the 0154 crew-link limiter always counts it; a
--      read-only call to a crew-link function is refused instead of silently skipping the limit.
--  16. storage_quota_ok gives usage figures only to members of that studio (others get a generic
--      refusal).
--  17. Chat reactions leave the realtime publication (their delete events reached every studio);
--      a reaction now bumps its message instead, so open chats still refresh live.
--  18. The studio data export leaves out quotes / guests unless the caller is an admin or can view
--      quotes.
--  19. Defence in depth for the legacy-bundle risk: the base OTP compare treats a missing code as
--      wrong (it already is, one layer up).
--
-- ZERO DATA LOSS: new tables (counters / snapshots only), new nullable columns, new triggers,
-- CREATE OR REPLACE / rename-and-wrap of functions (old bodies kept as *__pre0156), drop-and-
-- recreate of five read policies and the vendor_bills update policy, drop of three lead_archive
-- write policies, privilege revokes. No table or column is dropped, no row is deleted. Rows are
-- only ever updated to expire one-time codes (expires_at = now()) or to stamp a new column.
-- ASCII only. Safe to run twice.

do $$ begin
  if to_regprocedure('public._a42_quote_shelved(uuid)') is null then raise exception 'STOP: apply 0042 first'; end if;
  if to_regprocedure('public._a42_expire_open_otps(uuid)') is null then raise exception 'STOP: apply 0042 first'; end if;
  if to_regprocedure('public.reopen_event(uuid,text)') is null then raise exception 'STOP: apply 0084 first'; end if;
  if to_regprocedure('public._pkg_booklet(uuid,text,integer)') is null then raise exception 'STOP: apply 0069 first'; end if;
  if to_regprocedure('public.public_booklet_pay_terms(uuid)') is null then raise exception 'STOP: apply 0101 first'; end if;
  if to_regprocedure('public.smart_import_batch(text,jsonb,jsonb)') is null then raise exception 'STOP: apply 0088 first'; end if;
  if to_regprocedure('public.record_vendor_payout(uuid,numeric,date,text,text,text)') is null then raise exception 'STOP: apply 0124 first'; end if;
  if to_regprocedure('public.wa_verify_and_consent(uuid,text,text,boolean,text,text,text,text)') is null then raise exception 'STOP: apply 0151 first'; end if;
  if to_regprocedure('public.tg_a152_money_create_guard()') is null then raise exception 'STOP: apply 0152 first'; end if;
  if to_regprocedure('public._a154_hit(text,integer)') is null then raise exception 'STOP: apply 0154 first'; end if;
end $$;

-- ---- 0) helper: replace one exact piece of a live function body ---------------------------
-- Reads the CURRENT definition (so a later layer added by another migration is kept), and only
-- changes it when the expected text is there exactly once. Already patched -> no-op.
create or replace function public._a156_patch(p_fn regprocedure, p_old text, p_new text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare d text; n integer;
begin
  d := pg_get_functiondef(p_fn);
  if position(p_new in d) > 0 then return 'already'; end if;
  n := (length(d) - length(replace(d, p_old, ''))) / greatest(length(p_old), 1);
  if n <> 1 then
    -- fail LOUDLY: a skipped patch would leave a hole that only a VERIFY row might catch
    raise exception 'a156: % not patched (expected text found % times) - the live body differs from the repo; nothing was applied', p_fn, n
      using errcode = 'P0001';
  end if;
  execute replace(d, p_old, p_new);
  return 'patched';
end $$;
revoke all on function public._a156_patch(regprocedure, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a156_patch(regprocedure, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._a156_patch(regprocedure, text, text) from authenticated'; end if;
end $$;

-- ---- 1) accept_invitation: a member of the same studio keeps their role --------------------
do $$ begin
  if to_regprocedure('public.accept_invitation__pre0156(text)') is null then
    alter function public.accept_invitation(text) rename to accept_invitation__pre0156;
  end if;
end $$;
create or replace function public.accept_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: an old pending invitation never rewrites an existing member's role
declare v_uid uuid := auth.uid(); v_inv public.invitations; v_org uuid; v_role text; v_email text;
begin
  if v_uid is not null then
    select * into v_inv from public.invitations i where i.token = p_token;
    if v_inv.id is not null and v_inv.status = 'pending' then
      select pr.org_id, pr.role into v_org, v_role from public.profiles pr where pr.id = v_uid;
      select lower(u.email) into v_email from auth.users u where u.id = v_uid;
      if v_org is not null and v_org = v_inv.org_id and v_email is not distinct from lower(v_inv.email) then
        -- close the stale invitation so it stops counting toward the open-invitation cap (0155)
        update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = v_uid
         where id = v_inv.id and status = 'pending';
        return jsonb_build_object('ok', true, 'org_id', v_org, 'role', v_role, 'already', true);
      end if;
    end if;
  end if;
  return public.accept_invitation__pre0156(p_token);
end $$;
revoke all on function public.accept_invitation(text) from public;
revoke all on function public.accept_invitation__pre0156(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.accept_invitation(text) from anon';
    execute 'revoke all on function public.accept_invitation__pre0156(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.accept_invitation__pre0156(text) from authenticated';
    execute 'grant execute on function public.accept_invitation(text) to authenticated'; end if;
end $$;

-- ---- 2) create_invitation: admin first (no operator oracle) + per-studio caps --------------
do $$ begin
  if to_regprocedure('public.create_invitation__pre0156(text,text)') is null then
    alter function public.create_invitation(text, text) rename to create_invitation__pre0156;
  end if;
end $$;
create or replace function public.create_invitation(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: authorize before any address check (admin_first). The caps are 0155's (one set).
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if public._a42_is_operator_email(p_email) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return public.create_invitation__pre0156(p_email, p_role);
end $$;
revoke all on function public.create_invitation(text, text) from public;
revoke all on function public.create_invitation__pre0156(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.create_invitation(text, text) from anon';
    execute 'revoke all on function public.create_invitation__pre0156(text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.create_invitation__pre0156(text, text) from authenticated';
    execute 'grant execute on function public.create_invitation(text, text) to authenticated'; end if;
end $$;

-- ---- 3) client role: no staff chat, no studio config reads ------------------------------
select public._a156_patch('public.chat_can_see(uuid)'::regprocedure,
  $o$and c.org_id = public.current_org_id()$o$,
  $n$and c.org_id = public.current_org_id() and coalesce(public.user_role(), '') <> 'client' /* a156 */$n$);
select public._a156_patch('public.chat_directory__base()'::regprocedure,
  $o$where auth.uid() is not null$o$,
  $n$where auth.uid() is not null and coalesce(public.user_role(), '') <> 'client' /* a156 */$n$);
select public._a156_patch('public.chat_start_dm(uuid)'::regprocedure,
  $o$if p_other is null or p_other = v_me then$o$,
  $n$if coalesce(public.user_role(), '') = 'client' then raise exception 'not authorized' using errcode = '42501'; end if; /* a156 */
  if p_other is null or p_other = v_me then$n$);
select public._a156_patch('public.chat_create_group(text,uuid[])'::regprocedure,
  $o$if coalesce(btrim(p_title),'') = '' then$o$,
  $n$if coalesce(public.user_role(), '') = 'client' then raise exception 'not authorized' using errcode = '42501'; end if; /* a156 */
  if coalesce(btrim(p_title),'') = '' then$n$);
select public._a156_patch('public.chat_add_members(uuid,uuid[])'::regprocedure,
  $o$if not public.chat_is_member(p_conversation) then$o$,
  $n$if coalesce(public.user_role(), '') = 'client' then raise exception 'not authorized' using errcode = '42501'; end if; /* a156 */
  if not public.chat_is_member(p_conversation) then$n$);
select public._a156_patch('public.chat_ensure_broadcast()'::regprocedure,
  $o$select id into v_id from public.chat_conversations where org_id = v_org and kind = 'broadcast';$o$,
  $n$if coalesce(public.user_role(), '') = 'client' then return null; end if; /* a156 */
  select id into v_id from public.chat_conversations where org_id = v_org and kind = 'broadcast';$n$);

drop policy if exists coupons_select on public.coupons;
create policy coupons_select on public.coupons for select
  using (org_id = public.current_org_id() and coalesce(public.user_role(), '') <> 'client');
drop policy if exists "cfg read" on public.app_config;
create policy "cfg read" on public.app_config for select to authenticated
  using (org_id = (select public.current_org_id()) and coalesce((select public.user_role()), '') <> 'client');
drop policy if exists item_rate_cards_read_own_org on public.item_rate_cards;
create policy item_rate_cards_read_own_org on public.item_rate_cards for select to authenticated
  using (org_id = public.current_org_id() and coalesce(public.user_role(), '') <> 'client');
drop policy if exists "np read own studio" on public.notification_prefs;
create policy "np read own studio" on public.notification_prefs for select to authenticated
  using (org_id = (select public.current_org_id()) and coalesce((select public.user_role()), '') <> 'client');
-- role_access: a client still reads its own role's rows (the app builds its menu from them)
drop policy if exists "ra read" on public.role_access;
create policy "ra read" on public.role_access for select to authenticated
  using (org_id = (select public.current_org_id())
         and (coalesce((select public.user_role()), '') <> 'client' or role = 'client'));

-- ---- 4) shelf kill-switch on client booklets + invitation sites -------------------------
select public._a156_patch('public._pkg_booklet(uuid,text,integer)'::regprocedure,
  $o$q.org_id = b.org_id and q.deleted_at is null)$o$,
  $n$q.org_id = b.org_id and q.deleted_at is null and q.archived_at is null /* a156 */)$n$);
select public._a156_patch('public.public_get_booklet_image(uuid,text,text)'::regprocedure,
  $o$q.org_id = b.org_id and q.deleted_at is null)$o$,
  $n$q.org_id = b.org_id and q.deleted_at is null and q.archived_at is null /* a156 */)$n$);
select public._a156_patch('public.booklet_snapshot_path(uuid,text)'::regprocedure,
  $o$q.org_id = b.org_id and q.deleted_at is null)$o$,
  $n$q.org_id = b.org_id and q.deleted_at is null and q.archived_at is null /* a156 */)$n$);
select public._a156_patch('public.public_booklet_pay_terms(uuid)'::regprocedure,
  $o$x.org_id = b.org_id and x.deleted_at is null;$o$,
  $n$x.org_id = b.org_id and x.deleted_at is null and x.archived_at is null /* a156 */;$n$);
select public._a156_patch('public.public_get_booklet__pre0069(uuid)'::regprocedure,
  $o$x.org_id = b.org_id and x.deleted_at is null;$o$,
  $n$x.org_id = b.org_id and x.deleted_at is null and x.archived_at is null /* a156 */;$n$);
select public._a156_patch('public.public_event_site(text)'::regprocedure,
  $o$if v_until is not null and now() >= v_until then$o$,
  $n$if exists (select 1 from public.event_sites s where s.slug = p_slug and s.status = 'published'
               and public._a42_quote_shelved(s.quote_id)) then          /* a156: event on a shelf */
    raise exception 'this invitation has ended' using errcode = 'P0001';
  end if;
  if v_until is not null and now() >= v_until then$n$);
select public._a156_patch('public.invite_media_guest_read_ok(text)'::regprocedure,
  $o$and now() < coalesce(public.event_site_live_until(s.id), 'infinity'::timestamptz)$o$,
  $n$and now() < coalesce(public.event_site_live_until(s.id), 'infinity'::timestamptz)
       and not public._a42_quote_shelved(s.quote_id) /* a156 */$n$);

-- ---- 5) close_event(id, false) only through reopen_event ----------------------------------
create or replace function public._a156_reopen_guard(p_quote_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.event_closure c where c.quote_id = p_quote_id and c.closed_at is not null)
     and coalesce(current_setting('helm.a156_reopen', true), '') is distinct from coalesce(p_quote_id::text, '') then
    raise exception 'Only an admin can re-open a closed event (use Re-open and give a reason).' using errcode = '42501';
  end if;
end $$;
revoke all on function public._a156_reopen_guard(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a156_reopen_guard(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._a156_reopen_guard(uuid) from authenticated'; end if;
end $$;
select public._a156_patch('public.close_event(uuid,boolean)'::regprocedure,
  $o$if p_closed then perform public._a49_close_gate(p_quote_id, null); end if;$o$,
  $n$if p_closed then perform public._a49_close_gate(p_quote_id, null); end if;
  if not p_closed then perform public._a156_reopen_guard(p_quote_id); end if;   -- a156$n$);
select public._a156_patch('public.close_event(uuid,boolean,text)'::regprocedure,
  $o$if p_closed then perform public._a49_close_gate(p_quote_id, p_override_reason); end if;$o$,
  $n$if p_closed then perform public._a49_close_gate(p_quote_id, p_override_reason); end if;
  if not p_closed then perform public._a156_reopen_guard(p_quote_id); end if;   -- a156$n$);
select public._a156_patch('public.reopen_event(uuid,text)'::regprocedure,
  $o$r := public.close_event(p_quote_id, false);$o$,
  $n$perform set_config('helm.a156_reopen', p_quote_id::text, true);   -- a156: the one allowed re-open path
  r := public.close_event(p_quote_id, false);
  perform set_config('helm.a156_reopen', '', true);$n$);

-- ---- 6) 0152 money checks on UPDATE too; vendor payouts; vendor_bills update refs ---------
create or replace function public.tg_a156_money_update_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: the 0152 create checks, re-run when an existing row is edited (API callers only)
declare v_paid numeric; v_open numeric; v_moved boolean;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if tg_table_name = 'vendor_bills' then
    if (new.amount is distinct from old.amount or new.status is distinct from old.status or new.quote_id is distinct from old.quote_id)
       and exists (select 1 from public.event_closure c where c.quote_id in (old.quote_id, new.quote_id) and c.closed_at is not null) then
      raise exception 'This event is closed - re-open it before changing a vendor bill.' using errcode = '23514', hint = 'event_closed';
    end if;
    return new;
  end if;
  -- event_refunds
  if new.quote_id is null or coalesce(new.status, 'pending') = 'rejected' then return new; end if;
  v_moved := new.amount is distinct from old.amount or new.kind is distinct from old.kind
             or new.quote_id is distinct from old.quote_id or coalesce(old.status, 'pending') = 'rejected';
  if not v_moved then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  if exists (select 1 from public.event_closure c where c.quote_id in (old.quote_id, new.quote_id) and c.closed_at is not null) then
    raise exception 'This event is closed - re-open it before changing a refund.' using errcode = '23514', hint = 'event_closed';
  end if;
  if coalesce(new.kind, 'refund') = 'refund' then
    v_paid := coalesce(public.helm_total_paid(new.quote_id, null, null), 0);
    select coalesce(sum(r.amount), 0) into v_open from public.event_refunds r
     where r.quote_id = new.quote_id and r.id <> new.id and coalesce(r.kind, 'refund') = 'refund'
       and r.status in ('pending', 'approved', 'processed');
    if coalesce(new.amount, 0) + v_open > v_paid + 0.5 then
      raise exception 'A refund can''t be more than the client has paid (paid %, other refunds %).',
        to_char(v_paid, 'FM999999999990.00'), to_char(v_open, 'FM999999999990.00')
        using errcode = '23514', hint = 'refund_over_paid';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_a156_money_update_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_a156_money_update_guard() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_a156_money_update_guard() from authenticated'; end if;
end $$;
drop trigger if exists ad_a156_refund_update_guard on public.event_refunds;
create trigger ad_a156_refund_update_guard before update of amount, kind, status, quote_id on public.event_refunds
  for each row execute function public.tg_a156_money_update_guard();
drop trigger if exists ad_a156_bill_update_guard on public.vendor_bills;
create trigger ad_a156_bill_update_guard before update of amount, status, quote_id on public.vendor_bills
  for each row execute function public.tg_a156_money_update_guard();

do $$ begin
  if to_regprocedure('public.record_vendor_payout__pre0156(uuid,numeric,date,text,text,text)') is null then
    alter function public.record_vendor_payout(uuid, numeric, date, text, text, text) rename to record_vendor_payout__pre0156;
  end if;
end $$;
create or replace function public.record_vendor_payout(p_bill uuid, p_amount numeric, p_paid_on date, p_method text,
                                                       p_reference text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: no vendor payment on a closed event (re-open it first)
begin
  if exists (select 1 from public.vendor_bills b join public.event_closure c on c.quote_id = b.quote_id
              where b.id = p_bill and b.org_id = public.current_org_id() and c.closed_at is not null) then
    raise exception 'This event is closed - re-open it before recording a vendor payment.' using errcode = '23514', hint = 'event_closed';
  end if;
  return public.record_vendor_payout__pre0156(p_bill, p_amount, p_paid_on, p_method, p_reference, p_idempotency_key);
end $$;
revoke all on function public.record_vendor_payout(uuid, numeric, date, text, text, text) from public;
revoke all on function public.record_vendor_payout__pre0156(uuid, numeric, date, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.record_vendor_payout(uuid, numeric, date, text, text, text) from anon';
    execute 'revoke all on function public.record_vendor_payout__pre0156(uuid, numeric, date, text, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.record_vendor_payout__pre0156(uuid, numeric, date, text, text, text) from authenticated';
    execute 'grant execute on function public.record_vendor_payout(uuid, numeric, date, text, text, text) to authenticated'; end if;
end $$;

create or replace function public._a156_vendor_bill_refs_ok(p_quote uuid, p_booking uuid, p_vendor uuid, p_file uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- audit-p2-0156: the same reference checks the vendor_bills INSERT policy makes
  select exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = public.current_org_id())
     and (p_booking is null or exists (select 1 from public.event_resources b
           where b.id = p_booking and b.org_id = public.current_org_id() and b.quote_id = p_quote))
     and (p_vendor is null or exists (select 1 from public.vendors v
           where v.id = p_vendor and v.org_id = public.current_org_id()))
     and (p_file is null or exists (select 1 from public.event_files f
           where f.id = p_file and f.org_id = public.current_org_id() and f.quote_id = p_quote));
$$;
revoke all on function public._a156_vendor_bill_refs_ok(uuid, uuid, uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a156_vendor_bill_refs_ok(uuid, uuid, uuid, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public._a156_vendor_bill_refs_ok(uuid, uuid, uuid, uuid) to authenticated'; end if;
end $$;
drop policy if exists vendor_bills_update on public.vendor_bills;
create policy vendor_bills_update on public.vendor_bills for update to authenticated
  using (org_id = public.current_org_id() and public.has_area('finance', 'edit'))
  with check (org_id = public.current_org_id() and public.has_area('finance', 'edit')
              and public._a156_vendor_bill_refs_ok(quote_id, booking_id, vendor_id, file_id));

-- ---- 7) lead_archive: read-only from the app ----------------------------------------------
drop policy if exists "ra ins" on public.lead_archive;
drop policy if exists "ra upd" on public.lead_archive;
drop policy if exists "ra del" on public.lead_archive;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke insert, update, delete, truncate on table public.lead_archive from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete, truncate on table public.lead_archive from authenticated'; end if;
end $$;

-- ---- 8) Razorpay link ids: not by hand; the webhook matches only Helm-attached links ----------
do $$ begin
  if to_regprocedure('public.record_payment__pre0156(uuid,numeric,text,text,uuid,text,text)') is null then
    alter function public.record_payment(uuid, numeric, text, text, uuid, text, text) rename to record_payment__pre0156;
  end if;
  if to_regprocedure('public.record_settlement_payment__pre0156(uuid,numeric,text,text,uuid,text,text)') is null then
    alter function public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text) rename to record_settlement_payment__pre0156;
  end if;
  if to_regprocedure('public.mark_paid__pre0156(uuid,text)') is null then
    alter function public.mark_paid(uuid, text) rename to mark_paid__pre0156;
  end if;
end $$;
create or replace function public._a156_no_link_ref(p_ref text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(p_ref, '') ~* '^\s*plink_' then
    raise exception 'A Razorpay payment-link id can''t be entered by hand - online payments are recorded automatically.'
      using errcode = '22023', hint = 'provider_ref';
  end if;
end $$;
create or replace function public.record_payment(p_quote uuid, p_amount numeric, p_method text default 'cash', p_receipt_no text default null,
                                                 p_milestone uuid default null, p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: no hand-typed Razorpay link id as a receipt number
begin
  perform public._a156_no_link_ref(p_receipt_no);
  -- the receipt row is written to quote_payments by record_payment__pre0156 (ledger + caps unchanged)
  return public.record_payment__pre0156(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
end $$;
create or replace function public.record_settlement_payment(p_quote uuid, p_amount numeric, p_method text default 'cash', p_receipt_no text default null,
                                                            p_milestone uuid default null, p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: no hand-typed Razorpay link id as a receipt number
begin
  perform public._a156_no_link_ref(p_receipt_no);
  -- the receipt row is written to quote_payments by record_settlement_payment__pre0156 (ledger + caps unchanged)
  return public.record_settlement_payment__pre0156(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
end $$;
create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: no hand-typed Razorpay link id as the reference
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  perform public._a156_no_link_ref(p_provider_ref);
  -- settles exactly one open quote_payments request, as before (mark_paid__pre0156)
  return public.mark_paid__pre0156(p_quote_id, p_provider_ref);
end $$;
revoke all on function public._a156_no_link_ref(text) from public;
revoke all on function public.record_payment(uuid, numeric, text, text, uuid, text, text) from public;
revoke all on function public.record_payment__pre0156(uuid, numeric, text, text, uuid, text, text) from public;
revoke all on function public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text) from public;
revoke all on function public.record_settlement_payment__pre0156(uuid, numeric, text, text, uuid, text, text) from public;
revoke all on function public.mark_paid(uuid, text) from public;
revoke all on function public.mark_paid__pre0156(uuid, text) from public;
do $$ declare f text; begin
  foreach f in array array['public._a156_no_link_ref(text)',
                           'public.record_payment(uuid, numeric, text, text, uuid, text, text)',
                           'public.record_payment__pre0156(uuid, numeric, text, text, uuid, text, text)',
                           'public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text)',
                           'public.record_settlement_payment__pre0156(uuid, numeric, text, text, uuid, text, text)',
                           'public.mark_paid(uuid, text)', 'public.mark_paid__pre0156(uuid, text)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.record_payment(uuid, numeric, text, text, uuid, text, text) to authenticated';
    execute 'grant execute on function public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text) to authenticated';
    execute 'grant execute on function public.mark_paid(uuid, text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.record_payment(uuid, numeric, text, text, uuid, text, text) to service_role';
    execute 'grant execute on function public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text) to service_role';
    execute 'grant execute on function public.mark_paid(uuid, text) to service_role';
  end if;
end $$;
-- only when this function exists here (0117 Razorpay functions are not installed on every DB)
do $a156rz$ begin
  if to_regprocedure('public.razorpay_settle(uuid,text,text,bigint,text)') is not null then
    perform public._a156_patch('public.razorpay_settle(uuid,text,text,bigint,text)'::regprocedure,
      $o$provider = 'razorpay' and provider_ref = v_link order by$o$,
      $n$provider = 'razorpay' and provider_ref = v_link and link_url is not null /* a156 */ order by$n$);
  end if;
end $a156rz$;
-- only when this function exists here (0117 Razorpay functions are not installed on every DB)
do $a156rz$ begin
  if to_regprocedure('public.razorpay_settle_for_org(uuid,uuid,text,text,bigint,text)') is not null then
    perform public._a156_patch('public.razorpay_settle_for_org(uuid,uuid,text,text,bigint,text)'::regprocedure,
      $o$provider = 'razorpay' and provider_ref = v_link order by$o$,
      $n$provider = 'razorpay' and provider_ref = v_link and link_url is not null /* a156 */ order by$n$);
  end if;
end $a156rz$;
-- only when this function exists here (0117 Razorpay functions are not installed on every DB)
do $a156rz$ begin
  if to_regprocedure('public.razorpay_record_event(text,uuid,text,text,text,text,bigint,text,uuid)') is not null then
    perform public._a156_patch('public.razorpay_record_event(text,uuid,text,text,text,text,bigint,text,uuid)'::regprocedure,
      $o$provider = 'razorpay' and provider_ref = v_link order by$o$,
      $n$provider = 'razorpay' and provider_ref = v_link and link_url is not null /* a156 */ order by$n$);
  end if;
end $a156rz$;
-- one row per Razorpay link id (only when no duplicates exist today; nothing is changed if they do)
do $$ begin
  if to_regclass('public.quote_payments_a156_plink_uq') is null then
    if exists (select 1 from public.quote_payments p where p.provider_ref like 'plink\_%'
                group by p.provider, p.provider_ref having count(*) > 1) then
      raise warning 'a156: duplicate Razorpay link ids exist in quote_payments - unique index NOT created (review them by hand)';
    else
      create unique index quote_payments_a156_plink_uq on public.quote_payments(provider, provider_ref)
        where provider_ref like 'plink\_%';
    end if;
  end if;
end $$;

-- ---- 9) notify_default: not callable by anon / signed-in users ----------------------------
do $$ declare f text; begin
  foreach f in array array['public.notify_default(uuid, text, text, text)', 'public.notify_default__pre0078(uuid, text, text, text)'] loop
    if to_regprocedure(f) is null then continue; end if;
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  foreach f in array array['public.notification_catalog()', 'public.notification_type_of(text, text)',
                           'public.notification_catalog__pre0078()', 'public.notification_type_of__pre0078(text, text)'] loop
    if to_regprocedure(f) is null then continue; end if;
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.booklet_snapshot_upload_ok(text) from anon'; end if;
end $$;

-- ---- 10) booklet package code: 15 wrong codes a day, then locked for the day ---------------
do $$ begin
  if to_regprocedure('public.public_booklet_otp_request__pre0156(uuid)') is null then
    alter function public.public_booklet_otp_request(uuid) rename to public_booklet_otp_request__pre0156;
  end if;
  if to_regprocedure('public.public_booklet_choose__pre0156(uuid,uuid,integer,text,text)') is null then
    alter function public.public_booklet_choose(uuid, uuid, integer, text, text) rename to public_booklet_choose__pre0156;
  end if;
end $$;
create or replace function public._a156_pkg_fails(p_token uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_b uuid; v_q uuid; n integer;
begin
  select x.id, x.quote_id into v_b, v_q from public.client_booklets x where x.token = p_token;
  if v_b is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pkg:quote:' || v_q::text, 0));
  select coalesce(sum(o.attempts), 0) into n from public.pkg_otps o
   where o.booklet_id = v_b and o.verified_at is null and o.created_at > now() - interval '24 hours';
  return n;
end $$;
create or replace function public.public_booklet_otp_request(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: cumulative wrong-code cap across codes
begin
  if p_token is not null and public._a156_pkg_fails(p_token) >= 15 then
    raise exception 'too many wrong codes today - try again tomorrow' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  return public.public_booklet_otp_request__pre0156(p_token);
end $$;
create or replace function public.public_booklet_choose(p_token uuid, p_package uuid, p_guests integer, p_note text, p_otp text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: cumulative wrong-code cap across codes
begin
  if p_token is not null and nullif(btrim(coalesce(p_otp, '')), '') is not null and public._a156_pkg_fails(p_token) >= 15 then
    return jsonb_build_object('ok', false, 'status', 'rate_limited');
  end if;
  return public.public_booklet_choose__pre0156(p_token, p_package, p_guests, p_note, p_otp);
end $$;
revoke all on function public._a156_pkg_fails(uuid) from public;
revoke all on function public.public_booklet_otp_request__pre0156(uuid) from public;
revoke all on function public.public_booklet_choose__pre0156(uuid, uuid, integer, text, text) from public;
revoke all on function public.public_booklet_otp_request(uuid) from public;
revoke all on function public.public_booklet_choose(uuid, uuid, integer, text, text) from public;
do $$ declare f text; begin
  foreach f in array array['public._a156_pkg_fails(uuid)', 'public.public_booklet_otp_request__pre0156(uuid)',
                           'public.public_booklet_choose__pre0156(uuid, uuid, integer, text, text)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
  foreach f in array array['public.public_booklet_otp_request(uuid)', 'public.public_booklet_choose(uuid, uuid, integer, text, text)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function ' || f || ' to anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
end $$;

-- ---- 11) client phone / e-mail change while an approval link is live ------------------------
alter table public.quotes add column if not exists client_contact_changed_at timestamptz;
alter table public.quote_consents add column if not exists client_contact_changed_at timestamptz;
create or replace function public.tg_a156_client_contact_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: the OTP goes to quotes.client; a change during a live link cancels open codes
declare v_ph boolean; v_em boolean;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  v_ph := regexp_replace(coalesce(old.client ->> 'phone', ''), '[^0-9]', '', 'g')
          is distinct from regexp_replace(coalesce(new.client ->> 'phone', ''), '[^0-9]', '', 'g');
  v_em := lower(btrim(coalesce(old.client ->> 'email', ''))) is distinct from lower(btrim(coalesce(new.client ->> 'email', '')));
  if not (v_ph or v_em) then return new; end if;
  if new.approval_token is not null and new.approval_token_revoked_at is null
     and (new.approval_token_expires_at is null or new.approval_token_expires_at > now()) then
    new.client_contact_changed_at := now();
    perform public._a42_expire_open_otps(new.id);
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (auth.uid(), 'client_contact_change', 'quotes', new.id::text, new.id,
              jsonb_build_object('phone_changed', v_ph, 'email_changed', v_em, 'approval_link_live', true,
                                 'approval_status', new.approval_status), new.org_id);
  end if;
  return new;
end $$;
revoke all on function public.tg_a156_client_contact_guard() from public;
drop trigger if exists ac_a156_client_contact_guard on public.quotes;
create trigger ac_a156_client_contact_guard before update of client on public.quotes
  for each row execute function public.tg_a156_client_contact_guard();
create or replace function public.tg_a156_consent_contact()
returns trigger language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: the consent row keeps when the client contact was last changed during a live link
begin
  select q.client_contact_changed_at into new.client_contact_changed_at from public.quotes q where q.id = new.quote_id;
  return new;
end $$;
revoke all on function public.tg_a156_consent_contact() from public;
drop trigger if exists ac_a156_consent_contact on public.quote_consents;
create trigger ac_a156_consent_contact before insert on public.quote_consents
  for each row execute function public.tg_a156_consent_contact();
do $$ declare f text; begin
  foreach f in array array['public.tg_a156_client_contact_guard()', 'public.tg_a156_consent_contact()'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
end $$;

-- ---- 12) Smart Import obeys the linked-staff and demo guards ------------------------------
select public._a156_patch('public.tg_crew_profile_link_guard()'::regprocedure,
  $o$if current_user not in ('anon', 'authenticated') then return new; end if;$o$,
  $n$if current_user not in ('anon', 'authenticated')
     and coalesce(current_setting('helm.a156_api_guard', true), '') <> 'on' then return new; end if;   -- a156$n$);
select public._a156_patch('public._a97_tg_demo_flag_guard()'::regprocedure,
  $o$if current_user in ('anon', 'authenticated') then$o$,
  $n$if current_user in ('anon', 'authenticated') or coalesce(current_setting('helm.a156_api_guard', true), '') = 'on' then   -- a156$n$);
do $$ begin
  if to_regprocedure('public.smart_import_batch__pre0156(text,jsonb,jsonb)') is null then
    alter function public.smart_import_batch(text, jsonb, jsonb) rename to smart_import_batch__pre0156;
  end if;
end $$;
create or replace function public.smart_import_batch(p_entity text, p_rows jsonb, p_defs jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: the import runs with the same row guards as the app screens
declare v jsonb;
begin
  perform set_config('helm.a156_api_guard', 'on', true);
  v := public.smart_import_batch__pre0156(p_entity, p_rows, p_defs);
  perform set_config('helm.a156_api_guard', '', true);
  return v;
end $$;
revoke all on function public.smart_import_batch(text, jsonb, jsonb) from public;
revoke all on function public.smart_import_batch__pre0156(text, jsonb, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.smart_import_batch(text, jsonb, jsonb) from anon';
    execute 'revoke all on function public.smart_import_batch__pre0156(text, jsonb, jsonb) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.smart_import_batch__pre0156(text, jsonb, jsonb) from authenticated';
    execute 'grant execute on function public.smart_import_batch(text, jsonb, jsonb) to authenticated'; end if;
end $$;

-- ---- 13) approval bound to the total the client was shown -------------------------------
create table if not exists public.a156_quote_served (
  quote_id uuid primary key references public.quotes(id) on delete cascade,
  total numeric,
  version integer,
  served_at timestamptz not null default now()
);
alter table public.a156_quote_served enable row level security;
revoke all on table public.a156_quote_served from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.a156_quote_served from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.a156_quote_served from authenticated'; end if;
end $$;
select public._a156_patch('public.public_get_quote(uuid)'::regprocedure,
  $o$v_out := public.public_get_quote__pre0052(p_token);$o$,
  $n$v_out := public.public_get_quote__pre0052(p_token);
  if v_out is not null and jsonb_typeof(v_out) = 'object' then   -- a156: remember the total this page shows
    begin
      insert into public.a156_quote_served as s (quote_id, total, version, served_at)
        select q.id, public.helm_pricing_num(q.pricing -> 'total'), q.current_version, now()
          from public.quotes q where q.approval_token = p_token
      on conflict (quote_id) do update set total = excluded.total, version = excluded.version, served_at = excluded.served_at;
    exception when others then null;
    end;
  end if;$n$);
do $$ begin
  if to_regprocedure('public.verify_and_consent__pre0156(uuid,text,text,boolean,text,text,text,text)') is null then
    alter function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) rename to verify_and_consent__pre0156;
  end if;
end $$;
create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text,
                                                     p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: refuse (code not used up) when the total changed after the page was opened
declare v_q uuid; v_total numeric; v_shown numeric; v_has boolean;
begin
  select q.id, public.helm_pricing_num(q.pricing -> 'total') into v_q, v_total
    from public.quotes q where q.approval_token = p_token for update;
  if v_q is not null then
    select true, s.total into v_has, v_shown from public.a156_quote_served s where s.quote_id = v_q;
    if coalesce(v_has, false) and v_shown is distinct from v_total then
      return jsonb_build_object('approved', false, 'error', 'price_changed',
        'message', 'The price on this quote was updated after you opened it. Please reload the page to see the new total, then approve.');
    end if;
  end if;
  return public.verify_and_consent__pre0156(p_token, p_phone, p_code, p_agreed, p_terms_version, p_consent_text, p_client_name, p_user_agent);
end $$;
revoke all on function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) from public;
revoke all on function public.verify_and_consent__pre0156(uuid, text, text, boolean, text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.verify_and_consent__pre0156(uuid, text, text, boolean, text, text, text, text) from anon';
    execute 'grant execute on function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.verify_and_consent__pre0156(uuid, text, text, boolean, text, text, text, text) from authenticated';
    execute 'grant execute on function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) to service_role'; end if;
end $$;
create or replace function public.tg_a156_price_change_otps()
returns trigger language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: a code sent for the old total dies when the total changes
begin
  if public.helm_pricing_num(old.pricing -> 'total') is distinct from public.helm_pricing_num(new.pricing -> 'total') then
    perform public._a42_expire_open_otps(new.id);
  end if;
  return null;
end $$;
revoke all on function public.tg_a156_price_change_otps() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_a156_price_change_otps() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_a156_price_change_otps() from authenticated'; end if;
end $$;
drop trigger if exists zzzzz_a156_price_change_otps on public.quotes;
create trigger zzzzz_a156_price_change_otps after update of pricing on public.quotes
  for each row execute function public.tg_a156_price_change_otps();

-- ---- 14) fewer permanent rows from anonymous calls ---------------------------------------
select public._a156_patch('public.wa_verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure,
  $o$  perform public._wa151_log(v_q, 'otp_verify', p_channel, null, v_e164, null,
    case when v_ok then 'verified' else left(coalesce(v_out ->> 'error', 'rejected'), 40) end,
    coalesce(v_att, 0) + case when v_ok then 1 else 0 end, p_user_agent, null, '{}'::jsonb);$o$,
  $n$  if v_ok or not exists (select 1 from public.wa_proposal_audit a          -- a156: one failed-code row a minute
                  where a.quote_id = v_q and a.step = 'otp_verify' and a.status <> 'verified'
                    and a.created_at > now() - interval '1 minute') then
    perform public._wa151_log(v_q, 'otp_verify', p_channel, null, v_e164, null,
      case when v_ok then 'verified' else left(coalesce(v_out ->> 'error', 'rejected'), 40) end,
      coalesce(v_att, 0) + case when v_ok then 1 else 0 end, p_user_agent, null, '{}'::jsonb);
  end if;   -- a156 end$n$);
select public._a156_patch('public.public_link_opened(text,uuid)'::regprocedure,
  $o$if public.rate_hit('link_open', p_token::text, 3600, 60) > 60 then return; end if;$o$,
  $n$if not exists (select 1 from public.client_booklets b where b.token = p_token)       -- a156: no row for a random token
     and not exists (select 1 from public.quotes q where q.approval_token = p_token) then return; end if;
  if public.rate_hit('link_open', p_token::text, 3600, 60) > 60 then return; end if;$n$);

-- ---- 15) crew-link limiter always counts ------------------------------------------------
alter function public.worker_assignment_updates(uuid) volatile;
select public._a156_patch('public._a154_hit(text,integer)'::regprocedure,
  $o$exception when read_only_sql_transaction then return false;   -- a read-only call is never blocked$o$,
  $n$exception when read_only_sql_transaction then   -- a156: never skip the limit
    raise exception 'this link needs a normal request - reload the page' using errcode = '25006';$n$);

-- ---- 16) storage_quota_ok: figures only for the studio's own members -----------------------
select public._a156_patch('public.storage_quota_ok(text,text,jsonb)'::regprocedure,
  $o$if v_used + v_new > v_quota then$o$,
  $n$if (v_used + v_new > v_quota or v_n >= v_rate)                                   -- a156
     and not (auth.uid() is not null and v_org = coalesce(public.current_org_id()::text, '')) then
    raise exception 'Upload refused: the storage or upload limit is reached.' using errcode = '53400';
  end if;
  if v_used + v_new > v_quota then$n$);

-- ---- 17) chat reactions: out of realtime; the message is bumped instead -------------------
alter table public.chat_messages add column if not exists reactions_changed_at timestamptz;
create or replace function public.tg_a156_reaction_bump()
returns trigger language plpgsql security definer set search_path = '' as $$
-- audit-p2-0156: an UPDATE of the message reaches only members who can see it (RLS)
begin
  begin
    update public.chat_messages m set reactions_changed_at = now()
     where m.id = case when tg_op = 'DELETE' then old.message_id else new.message_id end;
  exception when others then null;   -- never break the reaction itself
  end;
  return null;
end $$;
revoke all on function public.tg_a156_reaction_bump() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_a156_reaction_bump() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_a156_reaction_bump() from authenticated'; end if;
end $$;
drop trigger if exists zz_a156_reaction_bump on public.chat_reactions;
create trigger zz_a156_reaction_bump after insert or delete on public.chat_reactions
  for each row execute function public.tg_a156_reaction_bump();
do $$ begin
  if exists (select 1 from pg_publication_tables t
              where t.pubname = 'supabase_realtime' and t.schemaname = 'public' and t.tablename = 'chat_reactions') then
    execute 'alter publication supabase_realtime drop table public.chat_reactions';
  end if;
end $$;

-- ---- 18) studio data export: quotes / guests need quotes access ---------------------------
select public._a156_patch('public.export_tenant_organization_package()'::regprocedure,
  $o$v := public.export_tenant_organization_package__base();$o$,
  $n$v := public.export_tenant_organization_package__base();
  if v is not null and jsonb_typeof(v) = 'object' and not public.is_admin() and not public.has_area('quotes', 'view') then
    v := v - 'quotes' - 'event_attendees';   -- a156: per-area export
  end if;$n$);

-- ---- 19) base OTP compare: a missing code is a wrong code ----------------------------------
select public._a156_patch('public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)'::regprocedure,
  $o$if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then$o$,
  $n$if p_code is null or extensions.crypt(p_code, rec.code_hash) is distinct from rec.code_hash then   -- a156$n$);

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 invite: member keeps role', position('audit-p2-0156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.accept_invitation(text)'))) > 0
       and to_regprocedure('public.accept_invitation__pre0156(text)') is not null),
  ('02 invite: admin first, one cap set (0155)', position('admin_first' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.create_invitation(text,text)'))) > 0
       and position('v_cap' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.create_invitation(text,text)'))) = 0
       and position('audit-p1-0155' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.create_invitation__pre0156(text,text)')), '')) > 0),
  ('02b invite: 0155 move under the 0156 wrapper', position('audit-p1-0155' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.accept_invitation__pre0156(text)')), '')) > 0),
  ('03 client: no staff chat', position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.chat_can_see(uuid)'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.chat_directory__base()'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.chat_start_dm(uuid)'))) > 0),
  ('03b client: no chat groups / members / broadcast', position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.chat_create_group(text,uuid[])'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.chat_add_members(uuid,uuid[])'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.chat_ensure_broadcast()'))) > 0),
  ('04 client: no config reads', (select count(*) from pg_policy pol where pol.polname in ('coupons_select', 'cfg read', 'item_rate_cards_read_own_org', 'np read own studio', 'ra read')
                                    and pol.polrelid in ('public.coupons'::regclass, 'public.app_config'::regclass, 'public.item_rate_cards'::regclass,
                                                         'public.notification_prefs'::regclass, 'public.role_access'::regclass)
                                    and pg_get_expr(pol.polqual, pol.polrelid) like '%client%') = 5),
  ('05 shelf: booklets', position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._pkg_booklet(uuid,text,integer)'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.public_get_booklet__pre0069(uuid)'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.public_get_booklet_image(uuid,text,text)'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.public_booklet_pay_terms(uuid)'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.booklet_snapshot_path(uuid,text)'))) > 0),
  ('06 shelf: invitation sites', position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.public_event_site(text)'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.invite_media_guest_read_ok(text)'))) > 0),
  ('07 reopen only via reopen_event', position('_a156_reopen_guard' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.close_event(uuid,boolean)'))) > 0
       and position('_a156_reopen_guard' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.close_event(uuid,boolean,text)'))) > 0
       and position('helm.a156_reopen' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.reopen_event(uuid,text)'))) > 0),
  ('08 money checks on update', exists (select 1 from pg_trigger t where t.tgname = 'ad_a156_refund_update_guard' and t.tgrelid = 'public.event_refunds'::regclass)
       and exists (select 1 from pg_trigger t where t.tgname = 'ad_a156_bill_update_guard' and t.tgrelid = 'public.vendor_bills'::regclass)
       and to_regprocedure('public.record_vendor_payout__pre0156(uuid,numeric,date,text,text,text)') is not null),
  ('09 vendor_bills update refs', (select pg_get_expr(pol.polwithcheck, pol.polrelid) from pg_policy pol
                                    where pol.polname = 'vendor_bills_update' and pol.polrelid = 'public.vendor_bills'::regclass) like '%_a156_vendor_bill_refs_ok%'),
  ('10 lead_archive read-only', not exists (select 1 from pg_policy pol where pol.polrelid = 'public.lead_archive'::regclass and pol.polname in ('ra ins', 'ra upd', 'ra del'))
       and (not exists (select 1 from pg_roles where rolname = 'authenticated')
            or not (has_table_privilege('authenticated', 'public.lead_archive', 'insert') or has_table_privilege('authenticated', 'public.lead_archive', 'update')
                    or has_table_privilege('authenticated', 'public.lead_archive', 'delete')))),
  ('11 razorpay link ids', to_regprocedure('public.mark_paid__pre0156(uuid,text)') is not null
       and to_regprocedure('public.record_payment__pre0156(uuid,numeric,text,text,uuid,text,text)') is not null
       and (to_regprocedure('public.razorpay_settle(uuid,text,text,bigint,text)') is null or position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.razorpay_settle(uuid,text,text,bigint,text)'))) > 0)
       and (to_regprocedure('public.razorpay_settle_for_org(uuid,uuid,text,text,bigint,text)') is null or position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.razorpay_settle_for_org(uuid,uuid,text,text,bigint,text)'))) > 0)
       and (to_regprocedure('public.razorpay_record_event(text,uuid,text,text,text,text,bigint,text,uuid)') is null or position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.razorpay_record_event(text,uuid,text,text,text,text,bigint,text,uuid)'))) > 0)),
  ('12 notify_default closed', not exists (select 1 from pg_roles where rolname = 'anon')
       or (not has_function_privilege('anon', 'public.notify_default(uuid, text, text, text)', 'execute')
           and not has_function_privilege('authenticated', 'public.notify_default(uuid, text, text, text)', 'execute')
           and not has_function_privilege('anon', 'public.notification_catalog()', 'execute'))),
  ('13 booklet code fail cap', to_regprocedure('public.public_booklet_choose__pre0156(uuid,uuid,integer,text,text)') is not null
       and to_regprocedure('public.public_booklet_otp_request__pre0156(uuid)') is not null),
  ('14 client contact change', exists (select 1 from pg_trigger t where t.tgname = 'ac_a156_client_contact_guard' and t.tgrelid = 'public.quotes'::regclass)
       and exists (select 1 from pg_trigger t where t.tgname = 'ac_a156_consent_contact' and t.tgrelid = 'public.quote_consents'::regclass)),
  ('15 smart import guarded', to_regprocedure('public.smart_import_batch__pre0156(text,jsonb,jsonb)') is not null
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.tg_crew_profile_link_guard()'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._a97_tg_demo_flag_guard()'))) > 0),
  ('16 approval bound to shown total', to_regprocedure('public.verify_and_consent__pre0156(uuid,text,text,boolean,text,text,text,text)') is not null
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.public_get_quote(uuid)'))) > 0
       and exists (select 1 from pg_trigger t where t.tgname = 'zzzzz_a156_price_change_otps' and t.tgrelid = 'public.quotes'::regclass)),
  ('17 anon audit rows bounded', position('a156 end' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.wa_verify_and_consent(uuid,text,text,boolean,text,text,text,text)'))) > 0
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.public_link_opened(text,uuid)'))) > 0),
  ('18 crew limiter always counts', (select p.provolatile from pg_proc p where p.oid = to_regprocedure('public.worker_assignment_updates(uuid)')) = 'v'
       and position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._a154_hit(text,integer)'))) > 0),
  ('19 storage figures own studio', position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.storage_quota_ok(text,text,jsonb)'))) > 0),
  ('20 reactions not in realtime', not exists (select 1 from pg_publication_tables t where t.pubname = 'supabase_realtime' and t.tablename = 'chat_reactions')
       and exists (select 1 from pg_trigger t where t.tgname = 'zz_a156_reaction_bump' and t.tgrelid = 'public.chat_reactions'::regclass)),
  ('21 export per area', position('a156' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.export_tenant_organization_package()'))) > 0),
  ('22 base OTP compare null-safe', position('p_code is null or' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)'))) > 0),
  ('23 helpers closed', not exists (select 1 from pg_roles where rolname = 'authenticated')
       or (not has_function_privilege('authenticated', 'public._a156_patch(regprocedure, text, text)', 'execute')
           and not has_function_privilege('authenticated', 'public.verify_and_consent__pre0156(uuid, text, text, boolean, text, text, text, text)', 'execute')
           and not has_function_privilege('anon', 'public.public_booklet_choose__pre0156(uuid, uuid, integer, text, text)', 'execute')
           and not has_table_privilege('anon', 'public.a156_quote_served', 'select')))
) v(item, ok);
