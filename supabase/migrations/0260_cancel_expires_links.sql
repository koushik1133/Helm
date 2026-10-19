-- 0260_cancel_expires_links.sql - CANONICAL forward-only.
-- REQUIRES 0022 (event sites / client link windows), 0042 (shelf gates), 0065 + 0069 + 0083 (client booklet),
--          0154 (_work_token_live), 0198 (cancel_event), 0241 (delivery links), 0151 (wa_proposal_prepare).
--
-- In plain words (r23 live bug, owner): after cancelling "Kapoor Family Sangeet" (SMP-1004), its invitation site
-- /<studio>/invite/<slug> still opened, although the Cancel event dialog said the client links would stop working.
-- cancel_event (0198) only revoked the quote's approval token. Every OTHER link kept working: invitation site +
-- its photos, client booklet (packages, pay terms, OTP, choose, pictures), proposal link, crew task links (tasks,
-- replies, proofs, equipment check-in), vendor delivery-status links, and the client portal.
--
-- What changes:
--   1. ONE rule, checked every time a link is used (so it is also right for events cancelled BEFORE this runs):
--      when the event (quote) is cancelled, every public / tokenized link refuses with
--      "This event has been cancelled. This link is no longer active." (hint event_cancelled) and shows no event
--      details. Covered entry points (each wrapped once, *__pre0260 keeps the previous body, no app grants):
--        approval link : public_get_quote, public_get_portal, public_portal_extras, public_quote_paid_status,
--                        request_otp, verify_and_consent, create_payment, wa_request_otp, wa_verify_and_consent,
--                        trial_test_approve, + the edge-function steps otp_send_authorize, wa_otp_begin,
--                        trial_email_otp_begin, payment_link_begin (no edge-function change needed)
--        client booklet: public_get_booklet, public_booklet_choose, public_booklet_otp_request,
--                        public_booklet_packages, public_booklet_pay_terms, public_get_booklet_image,
--                        booklet_snapshot_path (edge)
--        proposal link : public_get_proposal
--        invitation    : public_event_site (+ its photos: invite_media_on_published_site, invite_media_guest_read_ok)
--        crew links    : _work_token_live (every worker_* RPC goes through it) + task_proof_upload_ok (proof uploads)
--        vendor status : delivery_link_get ({ok:false, reason:'cancelled'}), delivery_link_update
--        staff send    : wa_proposal_prepare (no new WhatsApp proposal for a cancelled event)
--   2. cancel_event also UNPUBLISHES the event's invitation site (status 'unpublished', new column
--      event_sites.cancel_unpublished_at says it was the cancellation). The site's content is kept untouched.
--      A cancelled event's site cannot be published again (trigger ac_a260_site_publish_guard). There is no
--      "un-cancel" in Helm today; if one is added, the stamp shows which sites to offer to re-publish.
--   3. RESTORE (un-cancel): restore_event(quote, reason) - admin / manager / coordinator with quotes edit, reason
--      5-1000 chars, logged in NEW public.event_restorations + audit_log, team bell row. The event gets back the status
--      it had before it was cancelled (stage / payments / reservations were never changed). Its links do NOT come
--      back by themselves: NEW quotes.client_links_paused_at keeps every client / crew / vendor link answering
--      "This link has expired" until resume_client_links(quote) ("Re-share links" on the event page; it also
--      re-enables the approval link the cancellation revoked). The invitation site stays unpublished until someone
--      publishes it again. event_link_state(quote) tells the event page what to show.
--   Money already received is never refused: razorpay-webhook / razorpay_settle are not touched.
--
-- ZERO DATA LOSS: 2 new nullable columns, 1 new log table, 13 new functions, 3 new triggers, 28 entry points wrapped once
-- (rename to *__pre0260 + same-signature wrapper with the same grants), 3 storage read/upload checks replaced
-- in place with one extra condition, cancel_event wrapped. No table, row, column, policy or grant to the app is
-- dropped or deleted; no existing row is updated by this script. Additive + idempotent: safe to run twice. ASCII only.

do $$ begin
  if to_regclass('public.event_sites') is null or to_regclass('public.client_booklets') is null
     or to_regclass('public.event_proposal') is null or to_regclass('public.work_tokens') is null
     or to_regclass('public.delivery_links') is null or to_regclass('public.delivery_commitments') is null
     or to_regclass('public.task_evidence_grants') is null then
    raise exception 'STOP: apply 0022 + 0038 + 0065 + 0241 first (event sites, crew proofs, booklets, delivery links)'; end if;
  if coalesce(to_regprocedure('public.cancel_event__pre0260(uuid,text)'), to_regprocedure('public.cancel_event(uuid,text)')) is null then
    raise exception 'STOP: apply 0198 (cancel_event) first'; end if;
  if coalesce(to_regprocedure('public._work_token_live__pre0260(uuid)'), to_regprocedure('public._work_token_live(uuid)')) is null
     or to_regprocedure('public.task_proof_upload_ok__pre0042(text)') is null
     or to_regprocedure('public._a42_quote_shelved(uuid)') is null
     or to_regprocedure('public.request_site_slug()') is null
     or to_regprocedure('public.event_site_live_until(uuid)') is null then
    raise exception 'STOP: apply 0022 + 0042 + 0048 + 0154 first (link gates)'; end if;
end $$;

-- ---- 0) helpers (internal: no app grants) -------------------------------------------------
-- set when a cancelled event is RESTORED: its links stay off until the studio clicks "Re-share links"
alter table public.quotes add column if not exists client_links_paused_at timestamptz;
comment on column public.quotes.client_links_paused_at is
  'r23-0260: set by restore_event; client / crew / vendor links refuse until resume_client_links clears it.';

create or replace function public._a260_quote_cancelled(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r23-cancel-0260
  select coalesce((select q.status = 'cancelled' from public.quotes q where q.id = p_quote), false);
$$;
revoke all on function public._a260_quote_cancelled(uuid) from public, anon, authenticated, service_role;

-- the event (quote) a link points at; null when the link is unknown (the wrapped function then answers as before)
create or replace function public._a260_link_quote(p_kind text, p_ref text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r23-cancel-0260
declare v_id uuid; v_uuid uuid;
begin
  if p_ref is null then return null; end if;
  if p_kind in ('approval', 'booklet', 'proposal', 'work', 'quote', 'staff') then
    if p_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    v_uuid := p_ref::uuid;
  end if;
  if p_kind = 'approval' then
    select q.id into v_id from public.quotes q where q.approval_token = v_uuid limit 1;
  elsif p_kind = 'booklet' then
    select b.quote_id into v_id from public.client_booklets b where b.token = v_uuid limit 1;
  elsif p_kind = 'proposal' then
    select pr.quote_id into v_id from public.event_proposal pr where pr.share_token = v_uuid limit 1;
  elsif p_kind = 'work' then
    select w.quote_id into v_id from public.work_tokens w where w.token = v_uuid limit 1;
  elsif p_kind in ('quote', 'staff') then
    v_id := v_uuid;
  elsif p_kind = 'site' then
    select s.quote_id into v_id from public.event_sites s where s.slug = p_ref limit 1;
  elsif p_kind = 'vendor' then                                   -- 0256 vendor request links (only when 0256 is applied)
    if p_ref !~ '^[0-9a-f]{64}$' or to_regclass('public.vendor_request_links') is null then return null; end if;
    execute 'select r.quote_id from public.vendor_request_links l join public.vendor_requests r on r.id = l.request_id and r.org_id = l.org_id
              where l.token_hash = encode(pg_catalog.sha256(convert_to($1, ''UTF8'')), ''hex'') limit 1' into v_id using p_ref;
  elsif p_kind = 'delivery' then
    if p_ref !~ '^[0-9a-f]{64}$' then return null; end if;
    select d.quote_id into v_id
      from public.delivery_links l join public.delivery_commitments d on d.id = l.commitment_id and d.org_id = l.org_id
     where l.token_hash = encode(pg_catalog.sha256(convert_to(p_ref, 'UTF8')), 'hex') limit 1;
  end if;
  return v_id;
end $$;
revoke all on function public._a260_link_quote(text, text) from public, anon, authenticated, service_role;

create or replace function public._a260_link_cancelled(p_kind text, p_ref text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r23-cancel-0260
  select public._a260_quote_cancelled(public._a260_link_quote(p_kind, p_ref));
$$;
revoke all on function public._a260_link_cancelled(text, text) from public, anon, authenticated, service_role;

-- 'cancelled' | 'paused' (restored, links not re-shared yet) | null (live)
create or replace function public._a260_quote_state(p_quote uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r23-cancel-0260
  select case when q.status = 'cancelled' then 'cancelled'
              when q.client_links_paused_at is not null then 'paused' end
    from public.quotes q where q.id = p_quote;
$$;
revoke all on function public._a260_quote_state(uuid) from public, anon, authenticated, service_role;

-- the invitation site follows only "cancelled": after a restore it stays unpublished until someone publishes it
create or replace function public._a260_link_state(p_kind text, p_ref text)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r23-cancel-0260
declare v text := public._a260_quote_state(public._a260_link_quote(p_kind, p_ref));
begin
  if p_kind = 'site' and v = 'paused' then return null; end if;
  return v;
end $$;
revoke all on function public._a260_link_state(text, text) from public, anon, authenticated, service_role;

-- the one refusal every link shows (no event details)
create or replace function public._a260_refuse()
returns void language plpgsql volatile set search_path = '' as $$
-- r23-cancel-0260
begin
  raise exception 'This event has been cancelled. This link is no longer active.'
    using errcode = 'P0001', hint = 'event_cancelled';
end $$;
revoke all on function public._a260_refuse() from public, anon, authenticated, service_role;

-- the gate every wrapper calls: cancelled -> the cancelled message; paused -> "expired" (the pages' existing card)
create or replace function public._a260_gate(p_kind text, p_ref text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260
declare v text := public._a260_link_state(p_kind, p_ref);
begin
  if v = 'cancelled' then perform public._a260_refuse(); end if;
  if v = 'paused' then
    if p_kind = 'staff' then
      raise exception 'This event was restored and its client links are paused - click "Re-share links" on the event first.'
        using errcode = '22023', hint = 'link_paused';
    end if;
    raise exception 'This link has expired. Please ask your event planner to share it again.'
      using errcode = 'P0001', hint = 'link_paused';
  end if;
end $$;
revoke all on function public._a260_gate(text, text) from public, anon, authenticated, service_role;

-- ---- 1) every public / tokenized entry point refuses for a cancelled event ----------------
-- public_get_quote  (approval link)
do $$ begin
  if to_regprocedure('public.public_get_quote__pre0260(uuid)') is null and to_regprocedure('public.public_get_quote(uuid)') is not null then
    alter function public.public_get_quote(uuid) rename to public_get_quote__pre0260;
  end if;
end $$;
revoke all on function public.public_get_quote__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.public_get_quote__pre0260(p_token);
end $$;
revoke all on function public.public_get_quote(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_get_quote(uuid) to anon, authenticated, service_role;

-- public_get_portal  (approval link)
do $$ begin
  if to_regprocedure('public.public_get_portal__pre0260(uuid)') is null and to_regprocedure('public.public_get_portal(uuid)') is not null then
    alter function public.public_get_portal(uuid) rename to public_get_portal__pre0260;
  end if;
end $$;
revoke all on function public.public_get_portal__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.public_get_portal__pre0260(p_token);
end $$;
revoke all on function public.public_get_portal(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_get_portal(uuid) to anon, authenticated, service_role;

-- public_portal_extras  (approval link)
do $$ begin
  if to_regprocedure('public.public_portal_extras__pre0260(uuid)') is null and to_regprocedure('public.public_portal_extras(uuid)') is not null then
    alter function public.public_portal_extras(uuid) rename to public_portal_extras__pre0260;
  end if;
end $$;
revoke all on function public.public_portal_extras__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_portal_extras(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.public_portal_extras__pre0260(p_token);
end $$;
revoke all on function public.public_portal_extras(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_portal_extras(uuid) to anon, authenticated, service_role;

-- public_quote_paid_status  (approval link)
do $$ begin
  if to_regprocedure('public.public_quote_paid_status__pre0260(uuid)') is null and to_regprocedure('public.public_quote_paid_status(uuid)') is not null then
    alter function public.public_quote_paid_status(uuid) rename to public_quote_paid_status__pre0260;
  end if;
end $$;
revoke all on function public.public_quote_paid_status__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_quote_paid_status(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.public_quote_paid_status__pre0260(p_token);
end $$;
revoke all on function public.public_quote_paid_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_quote_paid_status(uuid) to anon, authenticated, service_role;

-- request_otp  (approval link)
do $$ begin
  if to_regprocedure('public.request_otp__pre0260(uuid, text)') is null and to_regprocedure('public.request_otp(uuid, text)') is not null then
    alter function public.request_otp(uuid, text) rename to request_otp__pre0260;
  end if;
end $$;
revoke all on function public.request_otp__pre0260(uuid, text) from public, anon, authenticated, service_role;
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.request_otp__pre0260(p_token, p_phone);
end $$;
revoke all on function public.request_otp(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.request_otp(uuid, text) to anon, authenticated, service_role;

-- verify_and_consent  (approval link)
do $$ begin
  if to_regprocedure('public.verify_and_consent__pre0260(uuid, text, text, boolean, text, text, text, text)') is null and to_regprocedure('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)') is not null then
    alter function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) rename to verify_and_consent__pre0260;
  end if;
end $$;
revoke all on function public.verify_and_consent__pre0260(uuid, text, text, boolean, text, text, text, text) from public, anon, authenticated, service_role;
create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  -- C-01 unchanged: a NULL code is never an approval (the 0093 layer already counts it as a wrong code)
  if p_code is null then p_agreed := false; end if;
  return public.verify_and_consent__pre0260(p_token, p_phone, p_code, p_agreed, p_terms_version, p_consent_text, p_client_name, p_user_agent);
end $$;
revoke all on function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) to anon, authenticated, service_role;

-- create_payment  (approval link)
do $$ begin
  if to_regprocedure('public.create_payment__pre0260(uuid)') is null and to_regprocedure('public.create_payment(uuid)') is not null then
    alter function public.create_payment(uuid) rename to create_payment__pre0260;
  end if;
end $$;
revoke all on function public.create_payment__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.create_payment__pre0260(p_token);
end $$;
revoke all on function public.create_payment(uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_payment(uuid) to anon, authenticated, service_role;

-- wa_request_otp  (approval link)
do $$ begin
  if to_regprocedure('public.wa_request_otp__pre0260(uuid, text, text)') is null and to_regprocedure('public.wa_request_otp(uuid, text, text)') is not null then
    alter function public.wa_request_otp(uuid, text, text) rename to wa_request_otp__pre0260;
  end if;
end $$;
revoke all on function public.wa_request_otp__pre0260(uuid, text, text) from public, anon, authenticated, service_role;
create or replace function public.wa_request_otp(p_token uuid, p_channel text, p_user_agent text DEFAULT NULL::text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.wa_request_otp__pre0260(p_token, p_channel, p_user_agent);
end $$;
revoke all on function public.wa_request_otp(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.wa_request_otp(uuid, text, text) to anon, authenticated, service_role;

-- wa_verify_and_consent  (approval link)
do $$ begin
  if to_regprocedure('public.wa_verify_and_consent__pre0260(uuid, text, text, boolean, text, text, text, text)') is null and to_regprocedure('public.wa_verify_and_consent(uuid, text, text, boolean, text, text, text, text)') is not null then
    alter function public.wa_verify_and_consent(uuid, text, text, boolean, text, text, text, text) rename to wa_verify_and_consent__pre0260;
  end if;
end $$;
revoke all on function public.wa_verify_and_consent__pre0260(uuid, text, text, boolean, text, text, text, text) from public, anon, authenticated, service_role;
create or replace function public.wa_verify_and_consent(p_token uuid, p_channel text, p_code text, p_agreed boolean, p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.wa_verify_and_consent__pre0260(p_token, p_channel, p_code, p_agreed, p_terms_version, p_consent_text, p_client_name, p_user_agent);
end $$;
revoke all on function public.wa_verify_and_consent(uuid, text, text, boolean, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.wa_verify_and_consent(uuid, text, text, boolean, text, text, text, text) to anon, authenticated, service_role;

-- trial_test_approve  (approval link)
do $$ begin
  if to_regprocedure('public.trial_test_approve__pre0260(uuid, text, text, text, text, text)') is null and to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)') is not null then
    alter function public.trial_test_approve(uuid, text, text, text, text, text) rename to trial_test_approve__pre0260;
  end if;
end $$;
revoke all on function public.trial_test_approve__pre0260(uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
create or replace function public.trial_test_approve(p_token uuid, p_phone text, p_client_name text, p_terms_version text, p_consent_text text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.trial_test_approve__pre0260(p_token, p_phone, p_client_name, p_terms_version, p_consent_text, p_user_agent);
end $$;
revoke all on function public.trial_test_approve(uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.trial_test_approve(uuid, text, text, text, text, text) to anon, authenticated, service_role;

-- otp_send_authorize  (approval link)
do $$ begin
  if to_regprocedure('public.otp_send_authorize__pre0260(uuid, text)') is null and to_regprocedure('public.otp_send_authorize(uuid, text)') is not null then
    alter function public.otp_send_authorize(uuid, text) rename to otp_send_authorize__pre0260;
  end if;
end $$;
revoke all on function public.otp_send_authorize__pre0260(uuid, text) from public, anon, authenticated, service_role;
create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.otp_send_authorize__pre0260(p_token, p_phone);
end $$;
revoke all on function public.otp_send_authorize(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.otp_send_authorize(uuid, text) to service_role;

-- payment_link_begin  (approval link)
do $$ begin
  if to_regprocedure('public.payment_link_begin__pre0260(uuid, integer)') is null and to_regprocedure('public.payment_link_begin(uuid, integer)') is not null then
    alter function public.payment_link_begin(uuid, integer) rename to payment_link_begin__pre0260;
  end if;
end $$;
revoke all on function public.payment_link_begin__pre0260(uuid, integer) from public, anon, authenticated, service_role;
create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer DEFAULT 4320)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.payment_link_begin__pre0260(p_token, p_ttl_minutes);
end $$;
revoke all on function public.payment_link_begin(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.payment_link_begin(uuid, integer) to service_role;

-- wa_otp_begin  (approval link)
do $$ begin
  if to_regprocedure('public.wa_otp_begin__pre0260(uuid, text, text)') is null and to_regprocedure('public.wa_otp_begin(uuid, text, text)') is not null then
    alter function public.wa_otp_begin(uuid, text, text) rename to wa_otp_begin__pre0260;
  end if;
end $$;
revoke all on function public.wa_otp_begin__pre0260(uuid, text, text) from public, anon, authenticated, service_role;
create or replace function public.wa_otp_begin(p_token uuid, p_channel text, p_user_agent text DEFAULT NULL::text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.wa_otp_begin__pre0260(p_token, p_channel, p_user_agent);
end $$;
revoke all on function public.wa_otp_begin(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.wa_otp_begin(uuid, text, text) to service_role;

-- trial_email_otp_begin  (approval link)
do $$ begin
  if to_regprocedure('public.trial_email_otp_begin__pre0260(uuid, text)') is null and to_regprocedure('public.trial_email_otp_begin(uuid, text)') is not null then
    alter function public.trial_email_otp_begin(uuid, text) rename to trial_email_otp_begin__pre0260;
  end if;
end $$;
revoke all on function public.trial_email_otp_begin__pre0260(uuid, text) from public, anon, authenticated, service_role;
create or replace function public.trial_email_otp_begin(p_token uuid, p_user_agent text DEFAULT NULL::text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('approval', p_token::text);
  return public.trial_email_otp_begin__pre0260(p_token, p_user_agent);
end $$;
revoke all on function public.trial_email_otp_begin(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.trial_email_otp_begin(uuid, text) to service_role;

-- public_get_booklet  (booklet link)
do $$ begin
  if to_regprocedure('public.public_get_booklet__pre0260(uuid)') is null and to_regprocedure('public.public_get_booklet(uuid)') is not null then
    alter function public.public_get_booklet(uuid) rename to public_get_booklet__pre0260;
  end if;
end $$;
revoke all on function public.public_get_booklet__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('booklet', p_token::text);
  return public.public_get_booklet__pre0260(p_token);
end $$;
revoke all on function public.public_get_booklet(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_get_booklet(uuid) to anon, authenticated, service_role;

-- public_booklet_choose  (booklet link)
do $$ begin
  if to_regprocedure('public.public_booklet_choose__pre0260(uuid, uuid, integer, text, text)') is null and to_regprocedure('public.public_booklet_choose(uuid, uuid, integer, text, text)') is not null then
    alter function public.public_booklet_choose(uuid, uuid, integer, text, text) rename to public_booklet_choose__pre0260;
  end if;
end $$;
revoke all on function public.public_booklet_choose__pre0260(uuid, uuid, integer, text, text) from public, anon, authenticated, service_role;
create or replace function public.public_booklet_choose(p_token uuid, p_package uuid, p_guests integer, p_note text, p_otp text DEFAULT NULL::text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('booklet', p_token::text);
  return public.public_booklet_choose__pre0260(p_token, p_package, p_guests, p_note, p_otp);
end $$;
revoke all on function public.public_booklet_choose(uuid, uuid, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.public_booklet_choose(uuid, uuid, integer, text, text) to anon, authenticated, service_role;

-- public_booklet_otp_request  (booklet link)
do $$ begin
  if to_regprocedure('public.public_booklet_otp_request__pre0260(uuid)') is null and to_regprocedure('public.public_booklet_otp_request(uuid)') is not null then
    alter function public.public_booklet_otp_request(uuid) rename to public_booklet_otp_request__pre0260;
  end if;
end $$;
revoke all on function public.public_booklet_otp_request__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_booklet_otp_request(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('booklet', p_token::text);
  return public.public_booklet_otp_request__pre0260(p_token);
end $$;
revoke all on function public.public_booklet_otp_request(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_booklet_otp_request(uuid) to anon, authenticated, service_role;

-- public_booklet_packages  (booklet link)
do $$ begin
  if to_regprocedure('public.public_booklet_packages__pre0260(uuid)') is null and to_regprocedure('public.public_booklet_packages(uuid)') is not null then
    alter function public.public_booklet_packages(uuid) rename to public_booklet_packages__pre0260;
  end if;
end $$;
revoke all on function public.public_booklet_packages__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_booklet_packages(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('booklet', p_token::text);
  return public.public_booklet_packages__pre0260(p_token);
end $$;
revoke all on function public.public_booklet_packages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_booklet_packages(uuid) to anon, authenticated, service_role;

-- public_booklet_pay_terms  (booklet link)
do $$ begin
  if to_regprocedure('public.public_booklet_pay_terms__pre0260(uuid)') is null and to_regprocedure('public.public_booklet_pay_terms(uuid)') is not null then
    alter function public.public_booklet_pay_terms(uuid) rename to public_booklet_pay_terms__pre0260;
  end if;
end $$;
revoke all on function public.public_booklet_pay_terms__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_booklet_pay_terms(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('booklet', p_token::text);
  return public.public_booklet_pay_terms__pre0260(p_token);
end $$;
revoke all on function public.public_booklet_pay_terms(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_booklet_pay_terms(uuid) to anon, authenticated, service_role;

-- public_get_booklet_image  (booklet link)
do $$ begin
  if to_regprocedure('public.public_get_booklet_image__pre0260(uuid, text, text)') is null and to_regprocedure('public.public_get_booklet_image(uuid, text, text)') is not null then
    alter function public.public_get_booklet_image(uuid, text, text) rename to public_get_booklet_image__pre0260;
  end if;
end $$;
revoke all on function public.public_get_booklet_image__pre0260(uuid, text, text) from public, anon, authenticated, service_role;
create or replace function public.public_get_booklet_image(p_token uuid, p_kind text, p_variant text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('booklet', p_token::text);
  return public.public_get_booklet_image__pre0260(p_token, p_kind, p_variant);
end $$;
revoke all on function public.public_get_booklet_image(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.public_get_booklet_image(uuid, text, text) to anon, authenticated, service_role;

-- booklet_snapshot_path  (booklet link)
do $$ begin
  if to_regprocedure('public.booklet_snapshot_path__pre0260(uuid, text)') is null and to_regprocedure('public.booklet_snapshot_path(uuid, text)') is not null then
    alter function public.booklet_snapshot_path(uuid, text) rename to booklet_snapshot_path__pre0260;
  end if;
end $$;
revoke all on function public.booklet_snapshot_path__pre0260(uuid, text) from public, anon, authenticated, service_role;
create or replace function public.booklet_snapshot_path(p_token uuid, p_kind text)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('booklet', p_token::text);
  return public.booklet_snapshot_path__pre0260(p_token, p_kind);
end $$;
revoke all on function public.booklet_snapshot_path(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.booklet_snapshot_path(uuid, text) to service_role;

-- public_get_proposal  (proposal link)
do $$ begin
  if to_regprocedure('public.public_get_proposal__pre0260(uuid)') is null and to_regprocedure('public.public_get_proposal(uuid)') is not null then
    alter function public.public_get_proposal(uuid) rename to public_get_proposal__pre0260;
  end if;
end $$;
revoke all on function public.public_get_proposal__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('proposal', p_token::text);
  return public.public_get_proposal__pre0260(p_token);
end $$;
revoke all on function public.public_get_proposal(uuid) from public, anon, authenticated, service_role;
grant execute on function public.public_get_proposal(uuid) to anon, authenticated, service_role;

-- public_event_site  (site link)
do $$ begin
  if to_regprocedure('public.public_event_site__pre0260(text)') is null and to_regprocedure('public.public_event_site(text)') is not null then
    alter function public.public_event_site(text) rename to public_event_site__pre0260;
  end if;
end $$;
revoke all on function public.public_event_site__pre0260(text) from public, anon, authenticated, service_role;
create or replace function public.public_event_site(p_slug text)
returns table(event_type text, template text, title text, data jsonb) language plpgsql stable security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('site', p_slug);
  return query select * from public.public_event_site__pre0260(p_slug);
end $$;
revoke all on function public.public_event_site(text) from public, anon, authenticated, service_role;
grant execute on function public.public_event_site(text) to anon, authenticated, service_role;

-- delivery_link_get  (delivery link)
do $$ begin
  if to_regprocedure('public.delivery_link_get__pre0260(text)') is null and to_regprocedure('public.delivery_link_get(text)') is not null then
    alter function public.delivery_link_get(text) rename to delivery_link_get__pre0260;
  end if;
end $$;
revoke all on function public.delivery_link_get__pre0260(text) from public, anon, authenticated, service_role;
create or replace function public.delivery_link_get(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  if public._a260_link_state('delivery', p_token) is not null then
    return jsonb_build_object('ok', false, 'reason', public._a260_link_state('delivery', p_token));   -- cancelled | paused
  end if;
  return public.delivery_link_get__pre0260(p_token);
end $$;
revoke all on function public.delivery_link_get(text) from public, anon, authenticated, service_role;
grant execute on function public.delivery_link_get(text) to anon, authenticated, service_role;

-- delivery_link_update  (delivery link)
do $$ begin
  if to_regprocedure('public.delivery_link_update__pre0260(text, text, text, timestamp with time zone)') is null and to_regprocedure('public.delivery_link_update(text, text, text, timestamp with time zone)') is not null then
    alter function public.delivery_link_update(text, text, text, timestamp with time zone) rename to delivery_link_update__pre0260;
  end if;
end $$;
revoke all on function public.delivery_link_update__pre0260(text, text, text, timestamp with time zone) from public, anon, authenticated, service_role;
create or replace function public.delivery_link_update(p_token text, p_status text, p_note text DEFAULT NULL::text, p_eta timestamp with time zone DEFAULT NULL::timestamp with time zone)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('delivery', p_token);
  return public.delivery_link_update__pre0260(p_token, p_status, p_note, p_eta);
end $$;
revoke all on function public.delivery_link_update(text, text, text, timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.delivery_link_update(text, text, text, timestamp with time zone) to anon, authenticated, service_role;

-- wa_proposal_prepare  (quote link)
do $$ begin
  if to_regprocedure('public.wa_proposal_prepare__pre0260(uuid, text, text, boolean, text, boolean)') is null and to_regprocedure('public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean)') is not null then
    alter function public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean) rename to wa_proposal_prepare__pre0260;
  end if;
end $$;
revoke all on function public.wa_proposal_prepare__pre0260(uuid, text, text, boolean, text, boolean) from public, anon, authenticated, service_role;
create or replace function public.wa_proposal_prepare(p_quote uuid, p_kind text, p_phone text, p_opt_in boolean, p_consent_text text, p_simulate boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's links stop working (checked every time the link is used)
begin
  perform public._a260_gate('staff', p_quote::text);
  return public.wa_proposal_prepare__pre0260(p_quote, p_kind, p_phone, p_opt_in, p_consent_text, p_simulate);
end $$;
revoke all on function public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean) to authenticated, service_role;

-- vendor request links (0256: accept / decline / invoice from one link) - wrapped only where 0256 is applied
do $do$
declare f text; sig text; args text; call text; r record;
begin
  for r in select * from (values
      ('vendor_link_get',        'text',          'p_token text',                                   'p_token'),
      ('vendor_link_respond',    'text, text, text', 'p_token text, p_action text, p_comment text default null', 'p_token, p_action, p_comment'),
      ('vendor_invoice_upload',  'text, text',    'p_token text, p_mime text',                      'p_token, p_mime'),
      ('vendor_invoice_submit',  'text, jsonb',   'p_token text, p jsonb',                          'p_token, p')) v(fn, types, args, call)
  loop
    if to_regprocedure('public.' || r.fn || '__pre0260(' || r.types || ')') is null then
      if to_regprocedure('public.' || r.fn || '(' || r.types || ')') is null then continue; end if;
      execute format('alter function public.%s(%s) rename to %s__pre0260', r.fn, r.types, r.fn);
    end if;
    execute format('revoke all on function public.%s__pre0260(%s) from public, anon, authenticated, service_role', r.fn, r.types);
    execute format($f$create or replace function public.%1$s(%2$s)
returns jsonb language plpgsql volatile security definer set search_path = '' as $b$
-- r23-cancel-0260: a cancelled event's vendor links stop working (also while paused after a restore)
declare v text := public._a260_link_state('vendor', p_token);
begin
  if v is not null then return jsonb_build_object('ok', false, 'reason', v); end if;   -- cancelled | paused
  return public.%3$s__pre0260(%4$s);
end $b$;$f$, r.fn, r.args, r.fn, r.call);
    execute format('revoke all on function public.%s(%s) from public, anon, authenticated, service_role', r.fn, r.types);
    execute format('grant execute on function public.%s(%s) to anon, authenticated, service_role', r.fn, r.types);
  end loop;
end $do$;

-- crew links: every worker_* RPC (tasks, replies, proofs, equipment, updates) opens the link through this
do $$ begin
  if to_regprocedure('public._work_token_live__pre0260(uuid)') is null and to_regprocedure('public._work_token_live(uuid)') is not null then
    alter function public._work_token_live(uuid) rename to _work_token_live__pre0260;
  end if;
end $$;
revoke all on function public._work_token_live__pre0260(uuid) from public, anon, authenticated, service_role;
create or replace function public._work_token_live(p_token uuid)
returns public.work_tokens language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: a cancelled event's crew links stop working (also while paused after a restore)
declare w public.work_tokens;
begin
  w := public._work_token_live__pre0260(p_token);
  perform public._a260_gate('quote', w.quote_id::text);
  return w;
end $$;
revoke all on function public._work_token_live(uuid) from public, anon, authenticated, service_role;
grant execute on function public._work_token_live(uuid) to service_role;

-- ---- 2) storage checks (used by storage policies, so replaced IN PLACE - same function) ---
create or replace function public.invite_media_on_published_site(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- 0022 body + r23-cancel-0260: not for a cancelled event
  select exists (
    select 1
      from public.event_sites s
     where s.status = 'published'
       and s.org_id::text   = split_part(p_name, '/', 1)
       and s.quote_id::text = split_part(p_name, '/', 2)
       and now() < coalesce(public.event_site_live_until(s.id), 'infinity'::timestamptz)
       and not public._a260_quote_cancelled(s.quote_id)
       and exists (
         select 1
           from jsonb_array_elements_text(
                  case when jsonb_typeof(s.data->'photos') = 'array' then s.data->'photos' else '[]'::jsonb end
                ) u(url)
          where right(u.url, length(p_name) + 14) = '/invite-media/' || p_name
       )
  );
$$;
revoke all on function public.invite_media_on_published_site(text) from public, anon, authenticated, service_role;
grant execute on function public.invite_media_on_published_site(text) to anon, authenticated, service_role;

create or replace function public.invite_media_guest_read_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- 0048 + a156 body + r23-cancel-0260: not for a cancelled event
declare v_slug text := public.request_site_slug();
begin
  if v_slug is null or p_name is null or public.storage_op_is_listing() then return false; end if;
  return exists (
    select 1
      from public.event_sites s
     where s.slug = v_slug
       and s.status = 'published'
       and s.org_id::text   = split_part(p_name, '/', 1)
       and s.quote_id::text = split_part(p_name, '/', 2)
       and now() < coalesce(public.event_site_live_until(s.id), 'infinity'::timestamptz)
       and not public._a42_quote_shelved(s.quote_id) /* a156 */
       and not public._a260_quote_cancelled(s.quote_id)
       and exists (
         select 1
           from jsonb_array_elements_text(
                  case when jsonb_typeof(s.data->'photos') = 'array' then s.data->'photos' else '[]'::jsonb end
                ) u(url)
          where right(u.url, length(p_name) + 14) = '/invite-media/' || p_name));
end $$;
revoke all on function public.invite_media_guest_read_ok(text) from public, anon, authenticated, service_role;
grant execute on function public.invite_media_guest_read_ok(text) to anon, authenticated, service_role;

create or replace function public.task_proof_upload_ok(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- audit-run2-0042: + the 0039 link age and the shelf gate for the grant's crew link
  -- r23-cancel-0260: + not for a cancelled event, nor while its links are paused after a restore
  select public.task_proof_upload_ok__pre0042(p_name)
     and exists (select 1 from public.task_evidence_grants g
                  where g.path = p_name and g.used_at is null and g.expires_at > now()
                    and not public.link_age_expired(public.work_link_age_until(g.work_token))
                    and not public._a42_quote_shelved(g.quote_id)
                    and public._a260_quote_state(g.quote_id) is null);
$$;
revoke all on function public.task_proof_upload_ok(text) from public, anon, authenticated, service_role;
grant execute on function public.task_proof_upload_ok(text) to anon, authenticated, service_role;

-- ---- 3) invitation site: unpublished on cancel, cannot be re-published while cancelled ----
alter table public.event_sites add column if not exists cancel_unpublished_at timestamptz;
comment on column public.event_sites.cancel_unpublished_at is
  'r23-0260: set when cancelling the event unpublished this site (status was published). Content is kept.';

create or replace function public.tg_a260_site_publish_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r23-cancel-0260
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published')
     and public._a260_quote_cancelled(new.quote_id) then
    raise exception 'This event is cancelled - its invitation site cannot be published.' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.tg_a260_site_publish_guard() from public, anon, authenticated, service_role;
drop trigger if exists ac_a260_site_publish_guard on public.event_sites;
create trigger ac_a260_site_publish_guard before insert or update on public.event_sites
  for each row execute function public.tg_a260_site_publish_guard();

do $$ begin
  if to_regprocedure('public.cancel_event__pre0260(uuid,text)') is null and to_regprocedure('public.cancel_event(uuid,text)') is not null then
    alter function public.cancel_event(uuid, text) rename to cancel_event__pre0260;
  end if;
end $$;
revoke all on function public.cancel_event__pre0260(uuid, text) from public, anon, authenticated, service_role;
create or replace function public.cancel_event(p_quote_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: 0198 cancel (checks, reason, audit, approval link revoked) + the invitation site is unpublished
declare v jsonb; v_org uuid := public.current_org_id(); n int := 0;
begin
  v := public.cancel_event__pre0260(p_quote_id, p_reason);        -- refuses (raises) exactly as before
  if exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = v_org and q.status = 'cancelled') then
    update public.event_sites s
       set status = 'unpublished', cancel_unpublished_at = now()
     where s.quote_id = p_quote_id and s.org_id = v_org and s.status = 'published';
    get diagnostics n = row_count;
  end if;
  return coalesce(v, '{}'::jsonb) || jsonb_build_object('links_expired', true, 'invitation_unpublished', n > 0);
end $$;
revoke all on function public.cancel_event(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.cancel_event(uuid, text) to authenticated, service_role;

-- ---- 4) RESTORE a cancelled event; client links come back only when the studio re-shares them ------------
create table if not exists public.event_restorations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete restrict,
  quote_id        uuid not null,
  cancellation_id uuid,
  actor           uuid,
  actor_email     text,
  reason          text not null check (length(btrim(reason)) between 5 and 1000),
  restored_status text,
  restored_stage  text,
  created_at      timestamptz not null default now()
);
create index if not exists event_restorations_quote_idx on public.event_restorations(org_id, quote_id);
alter table public.event_restorations enable row level security;
revoke all on table public.event_restorations from public, anon, authenticated;
grant select on table public.event_restorations to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'event_restorations' and policyname = 'a260 restorations read') then
    create policy "a260 restorations read" on public.event_restorations for select to authenticated
      using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));
  end if;
end $$;
drop trigger if exists zz_quote_org_match on public.event_restorations;
create trigger zz_quote_org_match before insert or update on public.event_restorations
  for each row execute function public.tg_quote_org_match();
drop trigger if exists zzz_studio_read_only on public.event_restorations;
create trigger zzz_studio_read_only before insert or update or delete on public.event_restorations
  for each row execute function public.tg_studio_read_only('org_id');

-- trial retention (0184, owner switch, off by default): the restore log is part of a studio's event records
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''event_restorations''' in v_def) > 0 then return; end if;
  if position('''event_cancellations'',' in v_def) = 0 then
    raise notice '0260: _tr184_purge_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''event_cancellations'',', '''event_cancellations'', ''event_restorations'',');
end $$;

-- who may restore / re-share: admin, manager or coordinator with quotes edit
create or replace function public._a260_can_restore()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r23-cancel-0260
  select public.has_area('quotes', 'edit') and coalesce(public.user_role(), '') in ('admin', 'manager', 'coordinator');
$$;
revoke all on function public._a260_can_restore() from public, anon, authenticated, service_role;

-- bell row for the studio team; never blocks the caller
create or replace function public._a260_bell(p_org uuid, p_quote uuid, p_kind text, p_text text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260
declare v_code text;
begin
  select q.code into v_code from public.quotes q where q.id = p_quote;
  begin
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (p_quote, 'in_app', p_kind, 'simulated', jsonb_build_object('label', p_text, 'source', '0260', 'event_code', v_code), p_org);
  exception when others then raise warning 'r23-cancel-0260: bell row skipped (%)', sqlstate;
  end;
end $$;
revoke all on function public._a260_bell(uuid, uuid, text, text) from public, anon, authenticated, service_role;

create or replace function public.restore_event(p_quote_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260: undo a cancellation - the status it had before, every stage / payment / reservation as it was;
-- its client / crew / vendor links stay OFF (client_links_paused_at) until resume_client_links; the invitation
-- site stays unpublished until someone publishes it again.
declare v_org uuid := public.current_org_id(); v_reason text := btrim(coalesce(p_reason, ''));
        q record; c record; v_status text; v_email text; v_id uuid;
begin
  if not public._a260_can_restore() then
    raise exception 'Only an admin, a manager or a coordinator can restore a cancelled event.' using errcode = '42501';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 1000 then
    raise exception 'Give a reason of 5 to 1000 characters for restoring.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || coalesce(p_quote_id::text, ''), 0));
  select q2.id, q2.status, q2.code, coalesce(q2.lifecycle_stage, 'quote') as stage, q2.deleted_at
    into q from public.quotes q2 where q2.id = p_quote_id and q2.org_id = v_org for update;
  if not found then raise exception 'not authorized for this event' using errcode = '42501'; end if;
  if q.status <> 'cancelled' then return jsonb_build_object('status', q.status, 'unchanged', true); end if;
  if q.deleted_at is not null then
    raise exception 'This event is in Deleted - restore it from Deleted first.' using errcode = '22023';
  end if;
  if q.stage = 'closed' or exists (select 1 from public.event_closure x where x.quote_id = p_quote_id and x.closed_at is not null) then
    raise exception 'This event was closed after it was cancelled - an admin can reopen it first.' using errcode = '22023';
  end if;
  select ec.id, ec.prev_status into c from public.event_cancellations ec
   where ec.quote_id = p_quote_id and ec.org_id = v_org order by ec.created_at desc limit 1;
  v_status := case when c.prev_status in ('quote', 'confirmed') then c.prev_status else 'quote' end;
  select u.email into v_email from auth.users u where u.id = auth.uid();
  update public.quotes qq set status = v_status, client_links_paused_at = now(), updated_at = now() where qq.id = p_quote_id;
  insert into public.event_restorations(org_id, quote_id, cancellation_id, actor, actor_email, reason, restored_status, restored_stage)
    values (v_org, p_quote_id, c.id, auth.uid(), v_email, v_reason, v_status, q.stage) returning id into v_id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), v_email, 'event_restored', 'quotes', p_quote_id::text, p_quote_id,
            jsonb_build_object('reason', v_reason, 'status', v_status, 'stage', q.stage, 'links_paused', true), v_org);
  perform public._a260_bell(v_org, p_quote_id, 'event_restored',
    coalesce(q.code, 'Event') || ' was restored by ' || coalesce(v_email, 'a teammate') || ' - client links stay off until someone clicks Re-share links.');
  return jsonb_build_object('status', v_status, 'stage', q.stage, 'restored', true, 'links_paused', true, 'restoration_id', v_id);
end $$;
revoke all on function public.restore_event(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.restore_event(uuid, text) to authenticated;

-- "Re-share links": the studio decides when the restored event's links work again
create or replace function public.resume_client_links(p_quote_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-cancel-0260
declare v_org uuid := public.current_org_id(); q record; v_email text; v_cancel_at timestamptz; v_tok boolean := false;
begin
  if not public._a260_can_restore() then
    raise exception 'Only an admin, a manager or a coordinator can re-share the client links.' using errcode = '42501';
  end if;
  select q2.id, q2.status, q2.code, q2.client_links_paused_at, q2.approval_token_revoked_at
    into q from public.quotes q2 where q2.id = p_quote_id and q2.org_id = v_org for update;
  if not found then raise exception 'not authorized for this event' using errcode = '42501'; end if;
  if q.status = 'cancelled' then raise exception 'This event is cancelled - restore it first.' using errcode = '22023'; end if;
  if q.client_links_paused_at is null then return jsonb_build_object('links_paused', false, 'unchanged', true); end if;
  select max(ec.created_at) into v_cancel_at from public.event_cancellations ec where ec.quote_id = p_quote_id and ec.org_id = v_org;
  -- the approval link the cancellation revoked works again (a link revoked for another reason stays revoked)
  v_tok := q.approval_token_revoked_at is not null and v_cancel_at is not null and q.approval_token_revoked_at >= v_cancel_at;
  update public.quotes qq
     set client_links_paused_at = null,
         approval_token_revoked_at = case when v_tok then null else qq.approval_token_revoked_at end,
         updated_at = now()
   where qq.id = p_quote_id;
  select u.email into v_email from auth.users u where u.id = auth.uid();
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), v_email, 'client_links_resumed', 'quotes', p_quote_id::text, p_quote_id,
            jsonb_build_object('approval_link_restored', v_tok), v_org);
  perform public._a260_bell(v_org, p_quote_id, 'client_links_resumed',
    coalesce(q.code, 'Event') || ': client, crew and vendor links work again (re-shared by ' || coalesce(v_email, 'a teammate') || ').');
  return jsonb_build_object('links_paused', false, 'approval_link_restored', v_tok);
end $$;
revoke all on function public.resume_client_links(uuid) from public, anon, authenticated, service_role;
grant execute on function public.resume_client_links(uuid) to authenticated;

-- what the event page needs to show Restore / Re-share (signed-in studio members only)
create or replace function public.event_link_state(p_quote_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-cancel-0260
  select case when public.has_area('quotes', 'view') then (
    select jsonb_build_object('status', q.status, 'links_paused', q.client_links_paused_at is not null,
             'paused_at', q.client_links_paused_at, 'can_restore', public._a260_can_restore(),
             'site_unpublished_by_cancel', exists (select 1 from public.event_sites s where s.quote_id = q.id
                                                     and s.status = 'unpublished' and s.cancel_unpublished_at is not null))
      from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) end;
$$;
revoke all on function public.event_link_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.event_link_state(uuid) to authenticated;

-- ---- VERIFY (read-only): every row must say ok = true ------------------------------------
select item, ok from (values
  ('01 helpers are 0260 and private', position('r23-cancel-0260' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._a260_link_quote(text,text)')), '')) > 0
       and not has_function_privilege('anon', 'public._a260_link_quote(text,text)', 'execute')
       and not has_function_privilege('anon', 'public._a260_quote_cancelled(uuid)', 'execute')),
  ('02 every client link entry point is wrapped (28)', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any(array['public_get_quote','public_get_portal','public_portal_extras',
         'public_quote_paid_status','request_otp','verify_and_consent','create_payment','wa_request_otp','wa_verify_and_consent',
         'trial_test_approve','otp_send_authorize','payment_link_begin','wa_otp_begin','trial_email_otp_begin','public_get_booklet',
         'public_booklet_choose','public_booklet_otp_request','public_booklet_packages','public_booklet_pay_terms',
         'public_get_booklet_image','booklet_snapshot_path','public_get_proposal','public_event_site','delivery_link_get',
         'delivery_link_update','wa_proposal_prepare','_work_token_live','cancel_event'])
       and position('r23-cancel-0260' in p.prosrc) > 0) = 28),
  ('03 previous bodies kept, closed to the app (28, +4 vendor links with 0256)', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like '%\_\_pre0260'
         and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
       = 28 + case when to_regclass('public.vendor_request_links') is null then 0 else 4 end),
  ('04 public links still open to visitors', has_function_privilege('anon', 'public.public_event_site(text)', 'execute')
       and has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
       and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')
       and has_function_privilege('anon', 'public.delivery_link_get(text)', 'execute')
       and has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'execute')),
  ('05 cancel_event signed-in only', has_function_privilege('authenticated', 'public.cancel_event(uuid,text)', 'execute')
       and not has_function_privilege('anon', 'public.cancel_event(uuid,text)', 'execute')),
  ('06 storage checks know cancelled', position('r23-cancel-0260' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.invite_media_guest_read_ok(text)'))) > 0
       and position('r23-cancel-0260' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.invite_media_on_published_site(text)'))) > 0
       and position('r23-cancel-0260' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.task_proof_upload_ok(text)'))) > 0),
  ('07 invitation: unpublish stamp + publish guard', exists (select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'event_sites' and column_name = 'cancel_unpublished_at')
       and exists (select 1 from pg_trigger where tgname = 'ac_a260_site_publish_guard' and tgrelid = 'public.event_sites'::regclass)),
  ('08 restore + re-share: signed-in only, log private to the studio', has_function_privilege('authenticated', 'public.restore_event(uuid,text)', 'execute')
       and not has_function_privilege('anon', 'public.restore_event(uuid,text)', 'execute')
       and has_function_privilege('authenticated', 'public.resume_client_links(uuid)', 'execute')
       and not has_function_privilege('anon', 'public.resume_client_links(uuid)', 'execute')
       and not has_function_privilege('anon', 'public.event_link_state(uuid)', 'execute')
       and (select c.relrowsecurity from pg_class c where c.oid = 'public.event_restorations'::regclass)
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'client_links_paused_at'))
) v(item, ok) order by item;
