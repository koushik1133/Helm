-- APPLY-0254.sql - paste into the Supabase SQL editor (STAGING first; production only when the owner says go).
-- Run AFTER APPLY-0246 and APPLY-0250 (both already applied). Order-independent of 0252 / 0253.
-- Closure page, EVENT-MONEY-CLOSURE-PLAN.md Phase 3 (first slice):
--   * a live "Before you close" checklist (event day, booking, client balance, equipment per item, expense claims,
--     refunds, vendor bills vs bookings, crew attendance, vendor payouts = warning) - read-only, nothing copied;
--   * "Request to close anyway": a reason (10+ characters) creates a PENDING close request (who / when / reason /
--     failed checks). The admins, coordinators and managers get a bell row and a Helm post in the event's team chat;
--     an admin - or a coordinator / manager whose role can edit Closure - approves (the event closes, recorded as
--     "Closed with override approved by X; requested by Y") or declines with a note (the requester is told).
--     Only an admin can approve past a client balance / equipment still checked out / unconfirmed / no date.
--     Nothing is ever closed before the event day. The requester can't approve their own request unless admin.
--   * a normal close (everything ticked) works exactly as before; close_event is not changed.
-- New: 1 table (event_close_requests), functions, bell_feed + event_activity wrapped once. Nothing deleted or
-- overwritten. Safe to run twice (the 2nd run changes nothing). ASCII only.
--   * e-mail: the request / decision is also queued in the existing Helm notice outbox (0244) - the approvers get
--     an e-mail, the requester gets the decision. Nothing is sent until comms-dispatch is deployed with e-mail on
--     (never for a free-trial studio or an unsubscribed address). The outbox's kind list is widened once (superset).
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the bottom must say ok = true.
--   2  Deploy the site (closure.html / closure-checklist.js / closure-polish.css / store-api.js) and, when e-mail is
--      switched on, redeploy comms-dispatch (helm-notices.mjs has the two new e-mails).
--   3  Check on a past event with something open (e.g. an expense claim waiting): Closure shows the dashboard + the
--      checklist; "Request to close anyway" asks for a reason; the admin's bell shows the request; the admin opens
--      Closure and Approves (event closes) or Declines with a note.
begin;
-- 0254_closure_checklist_override.sql - CANONICAL forward-only.
-- REQUIRES 0049 + 0110 + 0148 + 0152 + 0198 (close gate: close_event, _a49_close_blockers, event_close_overrides),
--          0036 + 0153 + 0250 (bell_feed chain), 0144 + 0250 (event_activity), 0246 (event_day arrivals, vendor bills
--          + payouts, expense claims, refunds), 0016 + 0035 (chat_conversations.quote_id, chat_messages.meta),
--          phase29 / phase57 (has_area, current_org_id, user_role), 0045 (tg_studio_read_only), 0004 (tg_quote_org_match).
--
-- In plain words (owner, r22 - EVENT-MONEY-CLOSURE-PLAN.md Phase 3, first slice: "closure checklist + sign-off"):
--   1  ONE live "Before you close" checklist per event, computed on the server from rows that already exist
--      (read-only, nothing is copied): event day over (studio time zone, 0198), booking confirmed + priced, client
--      balance on the ledger = 0, every piece of equipment back (per item: reserved, checked out, checked in, missing,
--      written off, still out), no expense claim waiting, no refund waiting, a vendor bill for every priced vendor
--      booking, crew arrivals marked for everyone on the event, vendor bills paid (warning only). Each failing check
--      says who may approve closing past it:
--        none  - the event day is not over (no override, unchanged 0198 rule)
--        admin - the 0049 server gate items (balance owed, equipment still checked out, never confirmed / unpriced,
--                no event date): unchanged - only an admin can close past them
--        any   - the new checks (claims, refunds, bills, attendance, reservations not marked returned): any approver
--      event_closure_review(quote) returns the checklist + the per-item inventory table + small event counts (tasks,
--      issues, vendors, crew) + the close requests. Closure VIEW, same studio; amounts only with Finance / Settlement view.
--   2  "REQUEST TO CLOSE ANYWAY" (owner: a request + approval, never a direct close):
--        request_event_close(quote, reason, checks)  - Closure EDIT, reason 10..1000 characters, only while a check
--          fails and the event day is over. Stores a PENDING row in event_close_requests: who / when / reason / the
--          failed checks at that moment (re-computed on the server; the page's copy is kept as client_checks only).
--          One pending request per event. Bell row (kind event_close_request) + a Helm system message in the event's
--          team chat group (0241 pattern) when the event has one, and an e-mail to the approvers queued in the 0244
--          Helm notice outbox (sent by comms-dispatch once deployed; never for a free-trial studio / unsubscribed).
--        decide_event_close(request, approve, note)  - an APPROVER: admin always; otherwise a coordinator or manager
--          whose role has Closure EDIT in the studio's role matrix. The requester can not decide their own request
--          unless they are an admin. Approve re-computes the checklist and closes through the existing close_event, so
--          every 0049 / 0198 rule still runs (HL425 before the event day; past a server blocker only an admin can
--          approve - 0049 then writes its own event_close_overrides + audit row). Decline needs a note (3..1000).
--          The requester is told (bell + chat + queued e-mail).
--        withdraw_event_close_request(request)        - the requester (or an approver) withdraws a pending request.
--      Nothing is ever deleted: a request moves pending -> approved / declined / withdrawn, stamped with who / when.
--      close_event itself is NOT changed: a normal close (all checks pass) works exactly as before.
--   3  event_activity (the event's activity trail) lists "Close requested by Y", "Closed with override approved by X;
--      requested by Y: <reason>", "Close request declined by X" (Closure viewers) and leaves out the raw bell rows.
--      bell_feed shows the request / decision rows only to admins, managers, coordinators and Closure viewers.
-- DRIFT-SAFE: bell_feed and event_activity are renamed ONCE to *__pre0254 (the database's own bodies are kept) and
-- wrapped; each wrapper carries the marker 'r22-closure-0254'.
-- E-MAIL: helm_notice_outbox (0244) kind check is widened ONCE to a superset (+ close_request, close_decision; every
-- existing row still passes) and helm_notice_outbox_claim gets one added branch in place (marker 'r22-closure-0254').
-- ZERO DATA LOSS: 1 new table, new functions, 2 wrappers. No table, column, row, trigger or policy is dropped or
-- deleted; no existing row is updated. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved):
--   drop function public.bell_feed(integer); alter function public.bell_feed__pre0254(integer) rename to bell_feed;
--   drop function public.event_activity(uuid); alter function public.event_activity__pre0254(uuid) rename to event_activity;
--   grant execute on function public.bell_feed(integer), public.event_activity(uuid) to authenticated;
--   revoke execute on function public.request_event_close(uuid, text, jsonb), public.decide_event_close(uuid, boolean, text),
--     public.withdraw_event_close_request(uuid), public.event_closure_review(uuid) from authenticated;
--   re-run the 0244 helm_notice_outbox_claim body (drops the close branch; queued close rows are then skipped);
--   (event_close_requests and the widened kind check can stay - nothing reads them then)

do $$ begin
  if to_regprocedure('public.close_event(uuid,boolean)') is null or to_regprocedure('public.close_event(uuid,boolean,text)') is null
     or to_regprocedure('public._a49_close_blockers(uuid)') is null or to_regclass('public.event_close_overrides') is null
     or to_regprocedure('public._a198_org_today(uuid)') is null then
    raise exception 'STOP 0254: apply 0049 + 0110 + 0148 + 0152 + 0198 (close gate) first'; end if;
  if to_regprocedure('public.bell_feed(integer)') is null or to_regprocedure('public.event_activity(uuid)') is null then
    raise exception 'STOP 0254: apply 0036 + 0144 + 0153 + 0250 (bell_feed / event_activity) first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.user_role()') is null then
    raise exception 'STOP 0254: has_area / current_org_id / user_role missing'; end if;
  if to_regclass('public.event_day') is null or to_regclass('public.vendor_bills') is null or to_regclass('public.vendor_payouts') is null
     or to_regclass('public.expense_claims') is null or to_regclass('public.event_refunds') is null
     or to_regclass('public.inventory_checkouts') is null or to_regclass('public.inventory_reservations') is null
     or to_regclass('public.event_resources') is null or to_regclass('public.event_tasks') is null
     or to_regclass('public.event_issues') is null or to_regclass('public.notifications') is null then
    raise exception 'STOP 0254: event_day / vendor bills / claims / refunds / inventory / tasks / issues / notifications missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_checkouts' and column_name = 'written_off') then
    raise exception 'STOP 0254: apply 0072 (inventory_checkouts.written_off) first'; end if;
end $$;

-- ---- 1) close requests ("request to close anyway" + the approval) -----------------------------------------------
create table if not exists public.event_close_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete restrict,
  quote_id        uuid not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  requested_by    uuid,
  requested_email text,
  requested_name  text,
  requested_role  text,
  reason          text not null check (length(btrim(reason)) between 10 and 1000),
  failed_checks   jsonb not null default '[]'::jsonb,
  checks          jsonb not null default '[]'::jsonb,
  client_checks   jsonb,
  decided_by      uuid,
  decided_email   text,
  decided_name    text,
  decided_role    text,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or length(decision_note) <= 1000),
  decided_checks  jsonb,
  server_override boolean not null default false,
  created_at      timestamptz not null default now()
);
create unique index if not exists event_close_requests_one_pending
  on public.event_close_requests(org_id, quote_id) where status = 'pending';
create index if not exists event_close_requests_quote_idx on public.event_close_requests(org_id, quote_id, created_at);
alter table public.event_close_requests enable row level security;
revoke all on public.event_close_requests from public, anon, authenticated;
grant select on public.event_close_requests to authenticated;
grant all on public.event_close_requests to service_role;
drop policy if exists "r22 close requests read" on public.event_close_requests;
create policy "r22 close requests read" on public.event_close_requests for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('closure', 'view'));
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    drop trigger if exists zz_quote_org_match on public.event_close_requests;
    create trigger zz_quote_org_match before insert or update on public.event_close_requests
      for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    drop trigger if exists zzz_studio_read_only on public.event_close_requests;
    create trigger zzz_studio_read_only before insert or update or delete on public.event_close_requests
      for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;

-- trial retention (0184, owner switch, off by default): the new table is part of a studio's event records
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''event_close_requests''' in v_def) > 0 then return; end if;
  if position('''event_close_overrides'', ''lifecycle_stage_overrides'',' in v_def) = 0 then
    raise notice '0254: _tr184_purge_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''event_close_overrides'', ''lifecycle_stage_overrides'',',
                  '''event_close_overrides'', ''event_close_requests'', ''lifecycle_stage_overrides'',');
end $$;

-- ---- 2) the checklist (internal, read-only) ---------------------------------------------------------------------
create or replace function public._r22_check(p_key text, p_label text, p_status text, p_override text,
                                              p_detail text, p_fix text, p_count numeric, p_amount numeric)
returns jsonb language sql immutable set search_path = '' as $$
  -- r22-closure-0254
  select jsonb_build_object('key', p_key, 'label', p_label, 'status', p_status, 'blocking', p_status = 'fail',
                            'override', case when p_status = 'fail' then p_override end,
                            'detail', p_detail, 'fix', p_fix, 'count', p_count, 'amount', p_amount);
$$;

create or replace function public._r22_close_checks(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-closure-0254: read-only; no auth here - callers check
declare
  b jsonb; v_status text; v_inv jsonb; v_checks jsonb := '[]'::jsonb; v_owed numeric; v_nb text;
  n_out numeric; n_res numeric; n_miss numeric; n_wo numeric; n_items int;
  n_claim int; a_claim numeric; n_claim_ok int; a_claim_ok numeric; n_ref int; a_ref numeric;
  n_book int; n_nobill int; v_nobill text; a_due numeric; n_due int;
  n_crew int; n_crew_open int; n_crew_here int;
  n_task int; n_task_done int; n_task_open int; n_iss int; n_iss_open int; n_iss_high int; n_vend int;
begin
  select q.status into v_status from public.quotes q where q.id = p_quote and q.org_id = p_org;
  if not found then return null; end if;
  b := public._a49_close_blockers(p_quote);
  v_owed := coalesce((b ->> 'balance_owed')::numeric, 0); v_nb := b ->> 'not_booked';

  -- equipment, per item: reserved / checked out / checked in / missing / written off / still out
  with r as (select x.item_id, sum(x.qty) filter (where x.status <> 'cancelled') as res,
                    sum(x.qty) filter (where x.status in ('reserved', 'allocated')) as res_open
               from public.inventory_reservations x where x.quote_id = p_quote and x.org_id = p_org group by x.item_id),
       c as (select x.item_id, sum(x.qty_out) filter (where x.status <> 'cancelled') as co,
                    sum(coalesce(x.qty_in, 0)) filter (where x.status in ('returned', 'partial')) as ci,
                    sum(greatest(x.qty_out - coalesce(x.qty_in, 0), 0)) filter (where x.status = 'partial') as miss,
                    sum(coalesce(x.written_off, 0)) filter (where x.status <> 'cancelled') as wo,
                    sum(x.qty_out) filter (where x.status = 'out') as still_out
               from public.inventory_checkouts x where x.quote_id = p_quote and x.org_id = p_org group by x.item_id),
       k as (select item_id from r union select item_id from c),
       t as (select k.item_id, coalesce(nullif(btrim(it.name), ''), 'Item') as name, it.unit,
                    coalesce(r.res, 0) as res, coalesce(r.res_open, 0) as res_open, coalesce(c.co, 0) as co,
                    coalesce(c.ci, 0) as ci, coalesce(c.miss, 0) as miss, coalesce(c.wo, 0) as wo, coalesce(c.still_out, 0) as still_out
               from k left join r on r.item_id = k.item_id left join c on c.item_id = k.item_id
               left join public.inventory_items it on it.id = k.item_id)
  select coalesce(jsonb_agg(jsonb_build_object('item_id', t.item_id, 'item', t.name, 'unit', t.unit,
            'reserved', t.res, 'reserved_open', t.res_open, 'checked_out', t.co, 'checked_in', t.ci,
            'missing', t.miss, 'written_off', t.wo, 'still_out', t.still_out,
            'status', case when t.still_out > 0 or t.res_open > 0 then 'fail' when t.miss > 0 or t.wo > 0 then 'warn' else 'ok' end)
            order by t.name, t.item_id), '[]'::jsonb),
         count(*), coalesce(sum(t.still_out), 0), coalesce(sum(t.res_open), 0), coalesce(sum(t.miss), 0), coalesce(sum(t.wo), 0)
    into v_inv, n_items, n_out, n_res, n_miss, n_wo from t;

  -- 1 event day (0198: no override) / no date (admin)
  v_checks := v_checks || jsonb_build_array(case
    when coalesce(v_status, '') = 'cancelled' then public._r22_check('event_day', 'Event day is over', 'ok', null,
         'Cancelled event - it can be closed once it is settled.', 'event', null, null)
    when coalesce((b ->> 'too_early')::boolean, false) then public._r22_check('event_day', 'Event day is over', 'fail', 'none',
         'You can close this event after ' || coalesce(b ->> 'close_after', '') || ' (event day).', 'event', null, null)
    when coalesce((b ->> 'no_event_date')::boolean, false) then public._r22_check('event_day', 'Event day is over', 'fail', 'admin',
         'The event has no date yet - set it on the event page.', 'event', null, null)
    else public._r22_check('event_day', 'Event day is over', 'ok', null, 'The event day (' || coalesce(b ->> 'close_after', '') || ') is over.', 'event', null, null) end);
  -- 2 booking confirmed + priced (0152, admin)
  if v_nb is not null then
    v_checks := v_checks || jsonb_build_array(public._r22_check('booked', 'Booking confirmed and priced', 'fail', 'admin',
      case when v_nb = 'unpriced' then 'The quote has no price yet - price it first.'
           else 'This is still a quote - the client has not confirmed the booking.' end, 'quote', null, null));
  end if;
  -- 3 client balance on the ledger (0049, admin)
  v_checks := v_checks || jsonb_build_array(case when v_owed > 0
    then public._r22_check('balance', 'Client balance is 0', 'fail', 'admin', 'Balance still due from the client - collect it in Settlement.', 'settlement', null, v_owed)
    else public._r22_check('balance', 'Client balance is 0', 'ok', null, 'Nothing is due from the client.', 'settlement', null, 0) end);
  -- 4 equipment back (still checked out = 0049 server gate, admin; reservations not marked returned = any approver)
  v_checks := v_checks || jsonb_build_array(case
    when n_out > 0 then public._r22_check('inventory', 'All equipment returned', 'fail', 'admin',
         'Still checked out: ' || trim(to_char(n_out, 'FM999999990.##')) || case when n_res > 0 then ' (and ' || trim(to_char(n_res, 'FM999999990.##')) || ' reserved, not marked returned)' else '' end || '.',
         'inventory', n_out + n_res, null)
    when n_res > 0 then public._r22_check('inventory', 'All equipment returned', 'fail', 'any',
         'Reserved for this event and not marked returned: ' || trim(to_char(n_res, 'FM999999990.##')) || ' - return them in Inventory.', 'inventory', n_res, null)
    when n_miss > 0 or n_wo > 0 then public._r22_check('inventory', 'All equipment returned', 'warn', null,
         'Everything is checked in; ' || trim(to_char(greatest(n_miss, n_wo), 'FM999999990.##')) || ' missing or written off (lost / damaged).', 'inventory', greatest(n_miss, n_wo), null)
    when n_items = 0 then public._r22_check('inventory', 'All equipment returned', 'ok', null, 'No equipment was booked for this event.', 'inventory', 0, null)
    else public._r22_check('inventory', 'All equipment returned', 'ok', null, 'Every item is back.', 'inventory', 0, null) end);
  -- 5 expense claims
  select count(*) filter (where e.status = 'pending'), coalesce(sum(e.amount) filter (where e.status = 'pending'), 0),
         count(*) filter (where e.status = 'approved'), coalesce(sum(e.amount) filter (where e.status = 'approved'), 0)
    into n_claim, a_claim, n_claim_ok, a_claim_ok
    from public.expense_claims e where e.quote_id = p_quote and e.org_id = p_org;
  v_checks := v_checks || jsonb_build_array(case
    when n_claim > 0 then public._r22_check('claims', 'No expense claims waiting', 'fail', 'any',
         n_claim || ' staff expense claim(s) waiting for approval.', 'settlement', n_claim, a_claim)
    when n_claim_ok > 0 then public._r22_check('claims', 'No expense claims waiting', 'warn', null,
         n_claim_ok || ' approved claim(s) not paid yet.', 'settlement', n_claim_ok, a_claim_ok)
    else public._r22_check('claims', 'No expense claims waiting', 'ok', null, 'No staff expense claim is waiting.', 'settlement', 0, null) end);
  -- 6 refunds
  select count(*), coalesce(sum(x.amount), 0) into n_ref, a_ref
    from public.event_refunds x where x.quote_id = p_quote and x.org_id = p_org and x.status in ('pending', 'approved');
  v_checks := v_checks || jsonb_build_array(case when n_ref > 0
    then public._r22_check('refunds', 'No refunds waiting', 'fail', 'any', n_ref || ' refund / recovery entry(ies) not processed yet.', 'settlement', n_ref, a_ref)
    else public._r22_check('refunds', 'No refunds waiting', 'ok', null, 'No refund is waiting.', 'settlement', 0, null) end);
  -- 7 a vendor bill for every priced vendor booking
  select count(*), count(*) filter (where not x.billed),
         string_agg(case when not x.billed then x.label end, ', ' order by x.label)
    into n_book, n_nobill, v_nobill
    from (select coalesce(nullif(btrim(r.label), ''), coalesce(v.name, 'booking')) as label,
                 exists (select 1 from public.vendor_bills vb where vb.quote_id = p_quote and vb.org_id = p_org and vb.status = 'open'
                           and (vb.booking_id = r.id or (vb.booking_id is null and vb.vendor_id = r.vendor_id))) as billed
            from public.event_resources r left join public.vendors v on v.id = r.vendor_id
           where r.quote_id = p_quote and r.org_id = p_org and r.vendor_id is not null
             and r.status in ('booked', 'confirmed', 'delivered') and coalesce(r.cost, 0) > 0) x;
  v_checks := v_checks || jsonb_build_array(case
    when n_nobill > 0 then public._r22_check('bills', 'Vendor bills recorded', 'fail', 'any',
         n_nobill || ' of ' || n_book || ' vendor booking(s) have no bill yet: ' || left(v_nobill, 300) || '.', 'settlement', n_nobill, null)
    when n_book = 0 then public._r22_check('bills', 'Vendor bills recorded', 'ok', null, 'No priced vendor bookings.', 'settlement', 0, null)
    else public._r22_check('bills', 'Vendor bills recorded', 'ok', null, 'Every vendor booking has a bill (' || n_book || ').', 'settlement', 0, null) end);
  -- 8 crew arrivals marked (same crew set as the 0246 ledger)
  select count(*), count(*) filter (where not x.marked), count(*) filter (where x.here)
    into n_crew, n_crew_open, n_crew_here
    from (select exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                           and d.ref_id = cm.id and d.status in ('arrived', 'left', 'no_show')) as marked,
                 exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                           and d.ref_id = cm.id and d.status in ('arrived', 'left')) as here
            from public.crew_members cm
           where cm.org_id = p_org
             and (exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org and t.crew_id = cm.id
                            and t.status not in ('rejected', 'cancelled', 'unassigned'))
               or exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival' and d.ref_id = cm.id))) x;
  v_checks := v_checks || jsonb_build_array(case
    when n_crew_open > 0 then public._r22_check('attendance', 'Crew attendance confirmed', 'fail', 'any',
         n_crew_open || ' of ' || n_crew || ' crew member(s) have no arrival marked for the event day.', 'command', n_crew_open, null)
    when n_crew = 0 then public._r22_check('attendance', 'Crew attendance confirmed', 'ok', null, 'No crew assigned to this event.', 'command', 0, null)
    else public._r22_check('attendance', 'Crew attendance confirmed', 'ok', null, 'Arrival marked for all ' || n_crew || ' crew member(s).', 'command', 0, null) end);
  -- 9 vendor payouts (warning only)
  select count(*) filter (where x.due > 0.5), coalesce(sum(x.due) filter (where x.due > 0.5), 0) into n_due, a_due
    from (select vb.amount - coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = vb.id), 0) as due
            from public.vendor_bills vb where vb.quote_id = p_quote and vb.org_id = p_org and vb.status = 'open') x;
  v_checks := v_checks || jsonb_build_array(case when n_due > 0
    then public._r22_check('payouts', 'Vendors paid', 'warn', null, n_due || ' vendor bill(s) not fully paid yet (you can still pay them after closing).', 'settlement', n_due, a_due)
    else public._r22_check('payouts', 'Vendors paid', 'ok', null, 'Every recorded vendor bill is paid.', 'settlement', 0, 0) end);

  -- small counts for the closure dashboard
  select count(*) filter (where t.status <> 'cancelled'), count(*) filter (where t.status = 'completed'),
         count(*) filter (where t.status not in ('completed', 'cancelled'))
    into n_task, n_task_done, n_task_open from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org;
  select count(*), count(*) filter (where i.status <> 'resolved'), count(*) filter (where i.status <> 'resolved' and i.severity = 'high')
    into n_iss, n_iss_open, n_iss_high from public.event_issues i where i.quote_id = p_quote and i.org_id = p_org;
  select count(distinct r.vendor_id) into n_vend from public.event_resources r
   where r.quote_id = p_quote and r.org_id = p_org and r.vendor_id is not null and r.status <> 'cancelled';

  return jsonb_build_object(
    'checks', v_checks,
    'failed', (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(v_checks) c where c ->> 'status' = 'fail'),
    'inventory', v_inv,
    'server_blocked', coalesce((b ->> 'blocked')::boolean, false),
    'too_early', coalesce((b ->> 'too_early')::boolean, false),
    'close_after', b ->> 'close_after',
    'counts', jsonb_build_object(
      'tasks', n_task, 'tasks_done', n_task_done, 'tasks_open', n_task_open,
      'issues', n_iss, 'issues_open', n_iss_open, 'issues_high_open', n_iss_high,
      'vendors', n_vend, 'vendor_bookings', n_book, 'crew', n_crew, 'crew_arrived', n_crew_here,
      'items', n_items, 'still_out', n_out, 'reserved_open', n_res, 'missing', n_miss, 'written_off', n_wo));
end $$;


-- ---- 3) who may approve -----------------------------------------------------------------------------------------
-- admin always; otherwise a coordinator or manager whose role has Closure EDIT in this studio's role matrix
create or replace function public._r22_can_approve()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r22-closure-0254
  select coalesce(public.user_role(), '') = 'admin'
      or (coalesce(public.user_role(), '') in ('coordinator', 'manager') and public.has_area('closure', 'edit'));
$$;

-- bell row + a Helm system message in the event's team chat group; never blocks the caller
create or replace function public._r22_announce(p_org uuid, p_quote uuid, p_req uuid, p_kind text, p_text text, p_notify jsonb, p_extra jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r22-closure-0254
declare v_conv uuid; v_ment jsonb; v_code text;
begin
  select q.code into v_code from public.quotes q where q.id = p_quote;
  begin
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (p_quote, 'in_app', p_kind, 'simulated',
              jsonb_build_object('label', p_text, 'via', 'comms', 'source', '0254', 'request_id', p_req, 'event_code', v_code,
                                 'notify', coalesce(p_notify, '[]'::jsonb)) || coalesce(p_extra, '{}'::jsonb), p_org);
  exception when others then raise warning 'r22-closure-0254: bell row skipped (%)', sqlstate;
  end;
  begin
    select x.id into v_conv from public.chat_conversations x
     where x.quote_id = p_quote and x.org_id = p_org and x.kind = 'group' order by x.created_at limit 1;
    if v_conv is not null then
      select coalesce(jsonb_agg(to_jsonb(m.user_id)), '[]'::jsonb) into v_ment
        from public.chat_members m
       where m.conversation_id = v_conv
         and m.user_id in (select (e #>> '{}')::uuid from jsonb_array_elements(coalesce(p_notify, '[]'::jsonb)) e);
      insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
        values (v_conv, p_org, null, 'system', p_text,
                case when jsonb_array_length(v_ment) > 0 then jsonb_build_object('mentions', v_ment, 'close_request_id', p_req)
                     else jsonb_build_object('close_request_id', p_req) end);
      begin update public.chat_conversations set last_message_at = now() where id = v_conv; exception when others then null; end;
    end if;
  exception when others then raise warning 'r22-closure-0254: chat post skipped (%)', sqlstate;
  end;
end $$;

-- the studio's approvers (bell audience): admins + coordinators + managers
create or replace function public._r22_approver_ids(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r22-closure-0254
  select coalesce(jsonb_agg(to_jsonb(p.id) order by p.id), '[]'::jsonb)
    from public.profiles p where p.org_id = p_org and p.role in ('admin', 'coordinator', 'manager');
$$;

-- ---- 4) read RPC for the Closure page ----------------------------------------------------------------------------
create or replace function public.event_closure_review(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-closure-0254: read-only; Closure VIEW, same studio; amounts only with Finance / Settlement view
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); r jsonb; v_fin boolean; v_reqs jsonb; v_ovr jsonb;
        v_admin boolean := coalesce(public.user_role(), '') = 'admin'; v_appr boolean := public._r22_can_approve();
begin
  if v_uid is null or v_org is null or not public.has_area('closure', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501'; end if;
  r := public._r22_close_checks(p_quote, v_org);
  v_fin := public.has_area('finance', 'view') or public.has_area('settlement', 'view');
  if not v_fin then
    r := r || jsonb_build_object(
      'checks', (select coalesce(jsonb_agg(c - 'amount' order by o), '[]'::jsonb) from jsonb_array_elements(r -> 'checks') with ordinality e(c, o)),
      'failed', (select coalesce(jsonb_agg(c - 'amount' order by o), '[]'::jsonb) from jsonb_array_elements(r -> 'failed') with ordinality e(c, o)));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'status', x.status, 'at', x.created_at, 'requested_name', coalesce(x.requested_name, x.requested_email, 'Someone'),
           'requested_role', x.requested_role, 'mine', x.requested_by = v_uid, 'reason', x.reason,
           'failed', (select coalesce(jsonb_agg(jsonb_build_object('key', f ->> 'key', 'label', f ->> 'label', 'detail', f ->> 'detail',
                                                                   'override', f ->> 'override')), '[]'::jsonb)
                        from jsonb_array_elements(x.failed_checks) f),
           'decided_name', x.decided_name, 'decided_at', x.decided_at, 'decision_note', x.decision_note,
           'server_override', x.server_override,
           'can_decide', x.status = 'pending' and v_appr and (x.requested_by is distinct from v_uid or v_admin),
           'can_withdraw', x.status = 'pending' and (x.requested_by = v_uid or v_appr))
           order by x.created_at desc), '[]'::jsonb)
    into v_reqs from public.event_close_requests x where x.quote_id = p_quote and x.org_id = v_org;
  -- older 0049 admin overrides that did not come from an approved request
  select coalesce(jsonb_agg(jsonb_build_object('at', o.created_at, 'who', coalesce(public._sa54_name(o.actor), o.actor_email, 'An admin'),
           'reason', o.reason) order by o.created_at desc), '[]'::jsonb)
    into v_ovr from public.event_close_overrides o
   where o.quote_id = p_quote and o.org_id = v_org
     and not exists (select 1 from public.event_close_requests x where x.quote_id = o.quote_id and x.org_id = o.org_id
                       and x.status = 'approved' and x.decided_at = o.created_at);
  return r || jsonb_build_object(
    'closed_at', (select c.closed_at from public.event_closure c where c.quote_id = p_quote and c.org_id = v_org),
    'can_close', public.has_area('closure', 'edit'),
    'can_approve', v_appr,
    'is_admin', v_admin,
    'amounts', v_fin,
    'requests', v_reqs,
    'pending', (select e from jsonb_array_elements(v_reqs) e where e ->> 'status' = 'pending' limit 1),
    'overrides', v_ovr);
end $$;

-- ---- 5) request -> approve / decline / withdraw ------------------------------------------------------------------
create or replace function public.request_event_close(p_quote_id uuid, p_reason text, p_checks jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-closure-0254: a PENDING request to close with checks still open; it never closes the event itself
declare
  v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); v_reason text := btrim(coalesce(p_reason, ''));
  r jsonb; v_failed jsonb; v_id uuid; v_email text; v_name text; v_client jsonb; v_list text;
begin
  if v_uid is null or v_org is null or not public.has_area('closure', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501'; end if;
  if length(v_reason) < 10 or length(v_reason) > 1000 then
    raise exception 'Give a reason of 10 to 1000 characters for closing with checks still open.' using errcode = '22023'; end if;
  -- the page's own copy of the checklist is kept for the record only (bounded; never used to decide anything)
  if p_checks is not null and (jsonb_typeof(p_checks) <> 'array' or jsonb_array_length(p_checks) > 40 or length(p_checks::text) > 20000) then
    raise exception 'checks must be a short list' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('key', left(c ->> 'key', 40), 'status', left(c ->> 'status', 10), 'label', left(c ->> 'label', 120))), '[]'::jsonb)
    into v_client from jsonb_array_elements(coalesce(p_checks, '[]'::jsonb)) c where jsonb_typeof(c) = 'object';
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote_id::text, 0));
  perform 1 from public.quotes q where q.id = p_quote_id for update;
  if exists (select 1 from public.event_closure c where c.quote_id = p_quote_id and c.closed_at is not null) then
    raise exception 'This event is already closed.' using errcode = '22023'; end if;
  r := public._r22_close_checks(p_quote_id, v_org);
  if coalesce((r ->> 'too_early')::boolean, false) then
    raise exception 'You can close this event after % (event day).', coalesce(r ->> 'close_after', '')
      using errcode = 'HL425', hint = 'event_not_over'; end if;
  v_failed := coalesce(r -> 'failed', '[]'::jsonb);
  if jsonb_array_length(v_failed) = 0 then
    raise exception 'Nothing is blocking this event - close it normally.' using errcode = '22023'; end if;
  if exists (select 1 from public.event_close_requests x where x.quote_id = p_quote_id and x.org_id = v_org and x.status = 'pending') then
    raise exception 'A close request for this event is already waiting for approval.' using errcode = '23505'; end if;
  select u.email into v_email from auth.users u where u.id = v_uid;
  v_name := coalesce(public._sa54_name(v_uid), v_email, 'Someone');
  insert into public.event_close_requests(org_id, quote_id, requested_by, requested_email, requested_name, requested_role,
                                          reason, failed_checks, checks, client_checks)
    values (v_org, p_quote_id, v_uid, v_email, v_name, public.user_role(), v_reason, v_failed,
            coalesce(r -> 'checks', '[]'::jsonb), v_client)
    returning id into v_id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_uid, v_email, 'close_request', 'event_closure', p_quote_id::text, p_quote_id,
            jsonb_build_object('request_id', v_id, 'reason', v_reason,
                               'failed_checks', (select jsonb_agg(f ->> 'key') from jsonb_array_elements(v_failed) f),
                               'client_checks', v_client), v_org);
  select string_agg(f ->> 'label', ', ') into v_list from jsonb_array_elements(v_failed) f;
  perform public._r22_announce(v_org, p_quote_id, v_id, 'event_close_request',
    left(chr(9888) || ' ' || v_name || ' asked to close this event with checks still open (' || coalesce(v_list, '-') || '): '
         || v_reason || ' - an admin or coordinator can approve it on the Closure page.', 600),
    public._r22_approver_ids(v_org),
    jsonb_build_object('actor_name', v_name, 'reason', left(v_reason, 300),
                       'failed', (select jsonb_agg(f ->> 'label') from jsonb_array_elements(v_failed) f)));
  perform public._r22_mail_enqueue(v_org, v_id, 'close_request');
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'failed_checks', v_failed);
end $$;

create or replace function public.decide_event_close(p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-closure-0254: approve (closes through close_event - every gate still runs) or decline (note required)
declare
  v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); v_admin boolean := coalesce(public.user_role(), '') = 'admin';
  q public.event_close_requests; r jsonb; v_server boolean; v_email text; v_name text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_admin_only text; v_txt text;
begin
  if v_uid is null or v_org is null or not public._r22_can_approve() then
    raise exception 'Only an admin, or a coordinator / manager who can close events, can approve or decline a close request.' using errcode = '42501'; end if;
  select * into q from public.event_close_requests x where x.id = p_request_id and x.org_id = v_org for update;
  if q.id is null then raise exception 'not authorized for this request' using errcode = '42501'; end if;
  if q.status <> 'pending' then raise exception 'This request was already %.', q.status using errcode = '22023'; end if;
  if q.requested_by = v_uid and not v_admin then
    raise exception 'You can''t decide your own close request - ask an admin or a coordinator.' using errcode = '42501'; end if;
  if p_approve is null then raise exception 'approve or decline?' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 1000 then raise exception 'Keep the note under 1000 characters.' using errcode = '22023'; end if;
  select u.email into v_email from auth.users u where u.id = v_uid;
  v_name := coalesce(public._sa54_name(v_uid), v_email, 'Someone');

  if not p_approve then
    if v_note is null or length(v_note) < 3 then
      raise exception 'Say why you are declining (at least 3 characters) - the requester sees it.' using errcode = '22023'; end if;
    update public.event_close_requests set status = 'declined', decided_by = v_uid, decided_email = v_email, decided_name = v_name,
           decided_role = public.user_role(), decided_at = now(), decision_note = v_note
     where id = q.id;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      values (v_uid, v_email, 'close_request_declined', 'event_closure', q.quote_id::text, q.quote_id,
              jsonb_build_object('request_id', q.id, 'note', v_note, 'requested_by', q.requested_by), v_org);
    perform public._r22_announce(v_org, q.quote_id, q.id, 'event_close_decision',
      left(chr(10006) || ' Close request declined by ' || v_name || ': ' || v_note || ' (requested by ' || coalesce(q.requested_name, 'someone') || ')', 600),
      case when q.requested_by is not null then jsonb_build_array(to_jsonb(q.requested_by)) else '[]'::jsonb end,
      jsonb_build_object('decision', 'declined', 'actor_name', v_name));
    perform public._r22_mail_enqueue(v_org, q.id, 'close_decision');
    return jsonb_build_object('request_id', q.id, 'status', 'declined', 'closed', false);
  end if;

  -- approve: the checklist is re-computed now; past a 0049 server blocker only an admin may approve
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || q.quote_id::text, 0));
  perform 1 from public.quotes x where x.id = q.quote_id for update;
  r := public._r22_close_checks(q.quote_id, v_org);
  v_server := coalesce((r ->> 'server_blocked')::boolean, false);
  if v_server and not v_admin then
    select string_agg(f ->> 'label', ', ') into v_admin_only from jsonb_array_elements(r -> 'failed') f where f ->> 'override' in ('admin', 'none');
    raise exception 'Only an admin can approve closing past: %.', coalesce(v_admin_only, 'a server check') using errcode = '42501';
  end if;
  if v_server then perform public.close_event(q.quote_id, true,
      left('Close request approved by ' || v_name || ' (requested by ' || coalesce(q.requested_name, 'someone') || '): ' || q.reason, 1000));
  else perform public.close_event(q.quote_id, true); end if;
  update public.event_close_requests set status = 'approved', decided_by = v_uid, decided_email = v_email, decided_name = v_name,
         decided_role = public.user_role(), decided_at = now(), decision_note = v_note,
         decided_checks = coalesce(r -> 'checks', '[]'::jsonb), server_override = v_server
   where id = q.id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_uid, v_email, 'close_request_approved', 'event_closure', q.quote_id::text, q.quote_id,
            jsonb_build_object('request_id', q.id, 'reason', q.reason, 'note', v_note, 'requested_by', q.requested_by,
                               'server_override', v_server,
                               'failed_checks', (select jsonb_agg(f ->> 'key') from jsonb_array_elements(r -> 'failed') f)), v_org);
  v_txt := left(chr(9989) || ' Closed with override approved by ' || v_name || '; requested by ' || coalesce(q.requested_name, 'someone')
                || ': ' || q.reason || coalesce(' - ' || v_note, ''), 600);
  perform public._r22_announce(v_org, q.quote_id, q.id, 'event_close_decision', v_txt,
    (select coalesce(jsonb_agg(distinct e), '[]'::jsonb) from jsonb_array_elements(public._r22_approver_ids(v_org)
       || case when q.requested_by is not null then jsonb_build_array(to_jsonb(q.requested_by)) else '[]'::jsonb end) e),
    jsonb_build_object('decision', 'approved', 'actor_name', v_name));
  perform public._r22_mail_enqueue(v_org, q.id, 'close_decision');
  return jsonb_build_object('request_id', q.id, 'status', 'approved', 'closed', true, 'server_override', v_server);
end $$;

create or replace function public.withdraw_event_close_request(p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-closure-0254: the requester (or an approver) withdraws a pending request; the row is kept
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); q public.event_close_requests; v_email text;
begin
  if v_uid is null or v_org is null or not public.has_area('closure', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.event_close_requests x where x.id = p_request_id and x.org_id = v_org for update;
  if q.id is null then raise exception 'not authorized for this request' using errcode = '42501'; end if;
  if q.status <> 'pending' then raise exception 'This request was already %.', q.status using errcode = '22023'; end if;
  if q.requested_by is distinct from v_uid and not public._r22_can_approve() then
    raise exception 'Only the person who asked (or an approver) can withdraw this request.' using errcode = '42501'; end if;
  select u.email into v_email from auth.users u where u.id = v_uid;
  update public.event_close_requests set status = 'withdrawn', decided_by = v_uid, decided_email = v_email,
         decided_name = coalesce(public._sa54_name(v_uid), v_email, 'Someone'), decided_role = public.user_role(), decided_at = now()
   where id = q.id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_uid, v_email, 'close_request_withdrawn', 'event_closure', q.quote_id::text, q.quote_id,
            jsonb_build_object('request_id', q.id), v_org);
  return jsonb_build_object('request_id', q.id, 'status', 'withdrawn');
end $$;

-- ---- 5b) e-mail through the existing Helm notice outbox (0244, comms-dispatch) ---------------------------------
-- A request e-mails the studio's admins / coordinators / managers (not the requester); a decision e-mails the
-- requester. Recipients + text are resolved when comms-dispatch claims the row (never taken from the row), only
-- while the request is still in that state, never for a free-trial studio, and never to an address that
-- unsubscribed (0165). Queuing never blocks the request / decision. comms-dispatch is dormant until deployed.
do $$ declare v_def text; begin
  if to_regclass('public.helm_notice_outbox') is null then
    raise notice '0254: helm_notice_outbox (0244) missing - close e-mails stay off (bell + chat still work)'; return; end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  if v_def is not null and position('close_request' in v_def) > 0 then return; end if;
  if v_def is distinct from 'CHECK ((kind = ANY (ARRAY[''sales_request''::text, ''upgrade_ask''::text])))' then
    raise notice '0254: helm_notice_outbox kind check has an unexpected body - left unchanged (close e-mails stay off)'; return; end if;
  -- widened to a superset (every existing row still passes): add the new check first, then retire the narrower one
  alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check_0254
    check (kind in ('sales_request', 'upgrade_ask', 'close_request', 'close_decision'));
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox rename constraint helm_notice_outbox_kind_check_0254 to helm_notice_outbox_kind_check;
end $$;

-- queue (never raises)
create or replace function public._r22_mail_enqueue(p_org uuid, p_req uuid, p_kind text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r22-closure-0254
begin
  if to_regclass('public.helm_notice_outbox') is null or p_kind not in ('close_request', 'close_decision') then return; end if;
  insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
    values (p_kind, p_org, p_req, jsonb_build_object('request_id', p_req), p_kind || ':' || p_req::text)
  on conflict (dedupe_key) do nothing;
exception when others then raise warning 'r22-closure-0254: close e-mail not queued (%)', sqlstate;
end $$;

-- recipients + data for one queued row, resolved at claim time (null = skip)
create or replace function public._r22_close_mail(p_org uuid, p_req uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-closure-0254
declare x public.event_close_requests; v_to jsonb; v_q record; v_data jsonb;
begin
  select * into x from public.event_close_requests r where r.id = p_req and r.org_id = p_org;
  if x.id is null then return null; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is not null and public._is_trial_org(p_org) then return null; end if;
  select q.title, q.code, q.event_date into v_q from public.quotes q where q.id = x.quote_id and q.org_id = p_org;
  if not found then return null; end if;
  if p_kind = 'close_request' then
    if x.status <> 'pending' then return null; end if;
    select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
      from public.profiles p
     where p.org_id = p_org and p.role in ('admin', 'coordinator', 'manager') and p.email is not null
       and p.id is distinct from x.requested_by
       and (to_regprocedure('public.email_is_opted_out(uuid,text)') is null or not public.email_is_opted_out(null, p.email));
  elsif p_kind = 'close_decision' then
    if x.status not in ('approved', 'declined') then return null; end if;
    select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
      from public.profiles p
     where p.id = x.requested_by and p.org_id = p_org and p.email is not null
       and (to_regprocedure('public.email_is_opted_out(uuid,text)') is null or not public.email_is_opted_out(null, p.email));
  else return null; end if;
  v_data := jsonb_build_object(
    'studio', (select o.name from public.organizations o where o.id = p_org),
    'event', coalesce(nullif(btrim(v_q.title), ''), 'Event'), 'code', v_q.code,
    'event_date', case when v_q.event_date is not null then to_char(v_q.event_date, 'DD/MM/YYYY') end,
    'quote_id', x.quote_id, 'status', x.status,
    'requested_name', coalesce(x.requested_name, 'A teammate'), 'reason', x.reason,
    'failed', (select coalesce(jsonb_agg(f ->> 'label'), '[]'::jsonb) from jsonb_array_elements(x.failed_checks) f),
    'decided_name', x.decided_name, 'note', x.decision_note);
  return jsonb_build_object('to', v_to, 'data', v_data);
end $$;

-- the 0244 claim learns the two kinds (one branch added in place; the rest of its body is unchanged)
do $$ declare v_def text; v_old text; v_new text; begin
  if to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then return; end if;
  v_def := pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure);
  if position('r22-closure-0254' in v_def) > 0 then return; end if;
  v_old := E'));\n    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0254: helm_notice_outbox_claim has an unexpected body - left unchanged (close e-mails are skipped)'; return; end if;
  v_new := E'));\n    elsif r.kind in (''close_request'', ''close_decision'') and r.org_id is not null and r.ref_id is not null then\n'
        || E'      -- r22-closure-0254: close request / decision e-mails (recipients resolved here)\n'
        || E'      v_data := public._r22_close_mail(r.org_id, r.ref_id, r.kind);\n'
        || E'      v_to := coalesce(v_data -> ''to'', ''[]''::jsonb); v_data := v_data -> ''data'';\n'
        || E'    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 6) bell: close request / decision rows only for admins, managers, coordinators and Closure viewers ----------
do $$ begin
  if to_regprocedure('public.bell_feed__pre0254(integer)') is null then
    alter function public.bell_feed(integer) rename to bell_feed__pre0254;
  end if;
end $$;
create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-closure-0254: event_close_request / event_close_decision rows only for approvers and Closure viewers
declare v jsonb; v_drop integer;
begin
  v := public.bell_feed__pre0254(p_limit);
  if v is null or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  if coalesce(public.user_role(), '') in ('admin', 'manager', 'coordinator') or public.has_area('closure', 'view') then return v; end if;
  select count(*) into v_drop from jsonb_array_elements(v -> 'items') e(i)
   where coalesce(e.i ->> 'kind', '') in ('event_close_request', 'event_close_decision') and coalesce((e.i ->> 'unread')::boolean, false);
  return v || jsonb_build_object(
    'items', coalesce((select jsonb_agg(e.i order by e.ord) from jsonb_array_elements(v -> 'items') with ordinality e(i, ord)
                        where coalesce(e.i ->> 'kind', '') not in ('event_close_request', 'event_close_decision')), '[]'::jsonb),
    'unread', greatest(coalesce((v ->> 'unread')::integer, 0) - v_drop, 0));
end $$;

-- ---- 7) activity trail ---------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.event_activity__pre0254(uuid)') is null then
    alter function public.event_activity(uuid) rename to event_activity__pre0254;
  end if;
end $$;
create or replace function public.event_activity(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-closure-0254: + close requests / decisions / older admin overrides (Closure viewers); raw bell rows left out
declare v jsonb; v_org uuid := public.current_org_id(); v_add jsonb := '[]'::jsonb;
begin
  v := public.event_activity__pre0254(p_quote);
  if jsonb_typeof(v) <> 'array' then return v; end if;
  v := coalesce((select jsonb_agg(e.i order by e.ord) from jsonb_array_elements(v) with ordinality e(i, ord)
                  where not (coalesce(e.i ->> 'kind', '') = 'notify' and coalesce(e.i ->> 'text', '') like 'event\_close\_%')), '[]'::jsonb);
  if public.has_area('closure', 'view') then
    select coalesce(jsonb_agg(x.a), '[]'::jsonb) into v_add from (
      select jsonb_build_object('at', s.created_at, 'kind', 'close_request',
               'text', left('Close requested by ' || coalesce(s.requested_name, s.requested_email, 'someone') || ': ' || s.reason
                            || coalesce(' (still open: ' || (select string_agg(f ->> 'label', ', ') from jsonb_array_elements(s.failed_checks) f) || ')', '')
                            || case when s.status = 'pending' then ' - waiting for approval' else '' end, 1200)) as a
        from public.event_close_requests s where s.quote_id = p_quote and s.org_id = v_org
      union all
      select jsonb_build_object('at', s.decided_at, 'kind', 'close_override',
               'text', left(case s.status
                 when 'approved' then 'Closed with override approved by ' || coalesce(s.decided_name, 'someone') || '; requested by '
                                      || coalesce(s.requested_name, 'someone') || ': ' || s.reason || coalesce(' - ' || s.decision_note, '')
                 when 'declined' then 'Close request declined by ' || coalesce(s.decided_name, 'someone') || ': ' || coalesce(s.decision_note, '')
                                      || ' (requested by ' || coalesce(s.requested_name, 'someone') || ')'
                 else 'Close request withdrawn by ' || coalesce(s.decided_name, 'someone') end, 1200))
        from public.event_close_requests s where s.quote_id = p_quote and s.org_id = v_org and s.status <> 'pending' and s.decided_at is not null
      union all
      select jsonb_build_object('at', o.created_at, 'kind', 'close_override',
               'text', left('Closed with override by ' || coalesce(public._sa54_name(o.actor), o.actor_email, 'an admin') || ': ' || o.reason, 1200))
        from public.event_close_overrides o
       where o.quote_id = p_quote and o.org_id = v_org
         and not exists (select 1 from public.event_close_requests s where s.quote_id = o.quote_id and s.org_id = o.org_id
                           and s.status = 'approved' and s.decided_at = o.created_at)) x;
  end if;
  if jsonb_array_length(v_add) = 0 then return v; end if;
  return (select jsonb_agg(a order by a ->> 'at' desc) from jsonb_array_elements(v || v_add) a);
end $$;

-- ---- 8) grants -------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['_r22_check(text, text, text, text, text, text, numeric, numeric)', '_r22_close_checks(uuid, uuid)',
                           '_r22_can_approve()', '_r22_announce(uuid, uuid, uuid, text, text, jsonb, jsonb)', '_r22_approver_ids(uuid)',
                           '_r22_mail_enqueue(uuid, uuid, text)', '_r22_close_mail(uuid, uuid, text)',
                           'bell_feed__pre0254(integer)', 'event_activity__pre0254(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
  foreach f in array array['event_closure_review(uuid)', 'request_event_close(uuid, text, jsonb)', 'decide_event_close(uuid, boolean, text)',
                           'withdraw_event_close_request(uuid)', 'bell_feed(integer)', 'event_activity(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.' || f || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
end $$;

commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 event_close_requests exists, RLS on, read-only for the app (no insert / update / delete grant)',
     to_regclass('public.event_close_requests') is not null
     and (select relrowsecurity from pg_class where oid = 'public.event_close_requests'::regclass)
     and has_table_privilege('authenticated', 'public.event_close_requests', 'select')
     and not has_table_privilege('authenticated', 'public.event_close_requests', 'insert')
     and not has_table_privilege('authenticated', 'public.event_close_requests', 'update')
     and not has_table_privilege('authenticated', 'public.event_close_requests', 'delete')
     and not has_table_privilege('anon', 'public.event_close_requests', 'select')),
  ('02 one pending request per event (partial unique index)',
     to_regclass('public.event_close_requests_one_pending') is not null),
  ('03 RPCs callable by signed-in users only',
     has_function_privilege('authenticated', 'public.event_closure_review(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.request_event_close(uuid,text,jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.decide_event_close(uuid,boolean,text)', 'execute')
     and has_function_privilege('authenticated', 'public.withdraw_event_close_request(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.event_closure_review(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.request_event_close(uuid,text,jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.decide_event_close(uuid,boolean,text)', 'execute')),
  ('04 internal helpers are not callable by the app',
     not has_function_privilege('authenticated', 'public._r22_close_checks(uuid,uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r22_announce(uuid,uuid,uuid,text,text,jsonb,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.bell_feed__pre0254(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.event_activity__pre0254(uuid)', 'execute')),
  ('05 bell_feed + event_activity are the 0254 wrappers (old bodies kept as *__pre0254)',
     position('r22-closure-0254' in (select prosrc from pg_proc where oid = to_regprocedure('public.bell_feed(integer)'))) > 0
     and position('r22-closure-0254' in (select prosrc from pg_proc where oid = to_regprocedure('public.event_activity(uuid)'))) > 0
     and to_regprocedure('public.bell_feed__pre0254(integer)') is not null
     and to_regprocedure('public.event_activity__pre0254(uuid)') is not null
     and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute')
     and has_function_privilege('authenticated', 'public.event_activity(uuid)', 'execute')),
  ('06 close_event unchanged (still the 0049 gate, both signatures)',
     position('_a49_close_gate' in (select prosrc from pg_proc where oid = to_regprocedure('public.close_event(uuid,boolean)'))) > 0
     and position('_a49_close_gate' in (select prosrc from pg_proc where oid = to_regprocedure('public.close_event(uuid,boolean,text)'))) > 0),
  ('07 approve goes through close_event; approver rule = admin, or coordinator / manager with closure edit',
     position('public.close_event(' in (select prosrc from pg_proc where oid = to_regprocedure('public.decide_event_close(uuid,boolean,text)'))) > 0
     and position('''coordinator'', ''manager''' in (select prosrc from pg_proc where oid = to_regprocedure('public._r22_can_approve()'))) > 0),
  ('08 e-mail lane: outbox kinds widened (superset) + the 0244 claim knows close_request / close_decision',
     position('close_decision' in (select pg_get_constraintdef(c.oid) from pg_constraint c
                                   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check')) > 0
     and position('upgrade_ask' in (select pg_get_constraintdef(c.oid) from pg_constraint c
                                   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check')) > 0
     and position('r22-closure-0254' in (select prosrc from pg_proc where oid = to_regprocedure('public.helm_notice_outbox_claim(integer)'))) > 0
     and not has_function_privilege('authenticated', 'public._r22_close_mail(uuid,uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.helm_notice_outbox_claim(integer)', 'execute'))
) v(item, ok) order by item;
