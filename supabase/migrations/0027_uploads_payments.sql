-- ============================================================================
-- 0027_uploads_payments.sql — CANONICAL forward-only. Security audit Phase 8
-- (risky functionality: file uploads, card payments, outbound messaging).
-- Every ATTACK below was reproduced on the disposable test DB before this fix
-- (tests/db/uploads-payments.sql):
--   uploads  — invite-media write/replace/delete only checked the org folder, so the
--              lowest-privilege member (crew) could replace or delete the photos on a
--              client's PUBLISHED invitation; no per-event / per-user upload caps;
--              object keys of any shape (org/x/evil.html.png, 10k-char names).
--   payments — finance editors could set a payment milestone to 'paid' (or edit /
--              delete a paid one) by a direct API write, skipping the receipt ledger,
--              the overpayment lock and the audit trail.
--   messaging/payment Edge Functions — need small server-side helpers: a per-studio
--              rate counter, a "who may be messaged for this event" check, a
--              serialized payment-link reservation, and a reconciliation record for
--              money that arrives after a quote is already paid.
--
-- Limits chosen (documented in supabase/functions/README.md as well):
--   invite-media  8 MB/file, png/jpeg/webp/gif, <=120 stored objects per event
--                 (60 shown on the site — event_sites.data.photos <= 60 — plus head-room
--                 for replaced/removed photos that are still in storage)
--   event-docs   10 MB/file, pdf/png/jpeg/webp, <=200 objects per event
--   chat-media   16 MB/file, images + voice notes (unchanged), no per-chat cap
--   every bucket <=100 uploads per user per 10 minutes
--   WhatsApp     <=100 messages per studio per hour (send-whatsapp)
--   OTP SMS      <=200 per studio per day (send-otp), on top of admin_store_otp's
--                5 per quote per 10 minutes
-- Anti-virus: FLAG-ONLY (agreed). Recommendation: a post-upload scan (ClamAV in a
-- container or a scanning API) for event-docs PDFs that marks event_files clean before
-- signed URLs are issued. Not built here. Storage still checks only the client-declared
-- Content-Type against allowed_mime_types; the browser re-sniffs magic bytes, and files
-- are served from the separate *.supabase.co origin under the declared type.
--
-- Rules followed: additive + idempotent; constraints on existing data are NOT VALID;
-- no row is changed or deleted; no bucket is ever made public. Caller-checking guard
-- triggers are plain (not definer) and test current_user in ('anon','authenticated')
-- like 0021/0025, so SECURITY DEFINER functions (owner) and the service role pass.
-- No existing function body is rewritten (prod-drift safe): new helpers + policies +
-- triggers only.
-- ============================================================================

-- =============================================================================
-- 1) BUCKETS: private, strict MIME allowlist + size cap (re-pinned; never public)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('invite-media','invite-media', false, 8388608,
          array['image/png','image/jpeg','image/webp','image/gif'])
  on conflict (id) do update set public = false, file_size_limit = 8388608,
          allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif'];
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('event-docs','event-docs', false, 10485760,
          array['application/pdf','image/png','image/jpeg','image/webp'])
  on conflict (id) do update set public = false, file_size_limit = 10485760,
          allowed_mime_types = array['application/pdf','image/png','image/jpeg','image/webp'];
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('chat-media','chat-media', false, 16777216,
          array['image/png','image/jpeg','image/webp','image/gif',
                'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a'])
  on conflict (id) do update set public = false, file_size_limit = 16777216,
          allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif',
                'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a'];

-- =============================================================================
-- 2) UPLOAD HELPERS used by the storage.objects policies
--    storage_key_ok        — object key = <caller org>/<folder uuid>/<random>.<ext>
--                            (folder = one of the caller's events for invite-media /
--                            event-docs); extension on the bucket's allowlist.
--    storage_upload_allowed — storage_key_ok + per-event object cap + per-user rate.
-- =============================================================================
create or replace function public.storage_key_ok(p_bucket text, p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts  text[] := string_to_array(coalesce(p_name, ''), '/');
  v_org    uuid   := public.current_org_id();
  v_folder uuid;
begin
  if v_org is null or auth.uid() is null then return false; end if;
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] is distinct from v_org::text then
    return false;
  end if;
  begin v_folder := v_parts[2]::uuid; exception when others then return false; end;
  -- canonical lower-case uuid text only (uppercase / brace / no-dash forms would
  -- otherwise dodge the per-folder cap below)
  if v_parts[2] is distinct from v_folder::text then return false; end if;

  if p_bucket = 'invite-media' then
    if v_parts[3] !~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\.(png|jpg|webp|gif)$' then
      return false;
    end if;
  elsif p_bucket = 'event-docs' then
    if v_parts[3] !~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\.(pdf|png|jpg|webp)$' then
      return false;
    end if;
  elsif p_bucket = 'chat-media' then
    if v_parts[3] !~ '^[A-Za-z0-9-]{1,64}\.(png|jpg|webp|gif|webm|ogg|m4a|mp3)$' then
      return false;
    end if;
    return true;                         -- conversation membership: chat_media_visible()
  else
    return false;
  end if;

  -- invite-media / event-docs: the folder must be one of the caller's own events
  return exists (select 1 from public.quotes q where q.id = v_folder and q.org_id = v_org);
end $$;
revoke all on function public.storage_key_ok(text, text) from public, anon;
grant execute on function public.storage_key_ok(text, text) to authenticated;

create or replace function public.storage_upload_allowed(p_bucket text, p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_cap   int;
  n       int;
begin
  if not public.storage_key_ok(p_bucket, p_name) then return false; end if;
  v_cap := case p_bucket when 'invite-media' then 120 when 'event-docs' then 200 else null end;
  -- per-event object cap (the row being inserted is not counted yet)
  if v_cap is not null then
    select count(*) into n from storage.objects o
     where o.bucket_id = p_bucket and o.name like v_parts[1] || '/' || v_parts[2] || '/%';
    if n >= v_cap then return false; end if;
  end if;
  -- per-user upload frequency, all buckets
  select count(*) into n from storage.objects o
   where o.owner = auth.uid() and o.created_at > now() - interval '10 minutes';
  if n >= 100 then return false; end if;
  return true;
end $$;
revoke all on function public.storage_upload_allowed(text, text) from public, anon;
grant execute on function public.storage_upload_allowed(text, text) to authenticated;

-- =============================================================================
-- 3) invite-media: write / replace / delete need Invite Studio edit rights
--    (event_sites RLS = has_area('quotes','edit')); was: any member of the org.
--    Reads are unchanged (0013 org read + 0019 published-site read).
-- =============================================================================
-- legacy phase88 name for the same ungated insert (may still exist on prod/staging;
-- permissive policies are OR'd, so it would re-open the hole)
drop policy if exists "invite_media_org_insert" on storage.objects;
drop policy if exists "invite_media_org_write" on storage.objects;
create policy "invite_media_org_write" on storage.objects for insert to authenticated
  with check ( bucket_id = 'invite-media'
               and (storage.foldername(name))[1] = (select public.current_org_id())::text
               and public.has_area('quotes', 'edit')
               and public.storage_upload_allowed(bucket_id, name) );
drop policy if exists "invite_media_org_update" on storage.objects;
create policy "invite_media_org_update" on storage.objects for update to authenticated
  using ( bucket_id = 'invite-media'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text
          and public.has_area('quotes', 'edit') )
  with check ( bucket_id = 'invite-media'
               and (storage.foldername(name))[1] = (select public.current_org_id())::text
               and public.has_area('quotes', 'edit')
               and public.storage_key_ok(bucket_id, name) );
drop policy if exists "invite_media_org_delete" on storage.objects;
create policy "invite_media_org_delete" on storage.objects for delete to authenticated
  using ( bucket_id = 'invite-media'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text
          and public.has_area('quotes', 'edit') );

-- =============================================================================
-- 4) event-docs: keep the 0009 area gate, add key shape + caps on write
-- =============================================================================
drop policy if exists event_docs_insert on storage.objects;
create policy event_docs_insert on storage.objects for insert to authenticated
  with check ( bucket_id = 'event-docs'
               and (storage.foldername(name))[1] = (select public.current_org_id())::text
               and (public.has_area('quotes', 'edit') or public.has_area('media', 'edit'))
               and public.storage_upload_allowed(bucket_id, name) );
drop policy if exists event_docs_update on storage.objects;
create policy event_docs_update on storage.objects for update to authenticated
  using ( bucket_id = 'event-docs'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text
          and (public.has_area('quotes', 'edit') or public.has_area('media', 'edit')) )
  with check ( bucket_id = 'event-docs'
               and (storage.foldername(name))[1] = (select public.current_org_id())::text
               and (public.has_area('quotes', 'edit') or public.has_area('media', 'edit'))
               and public.storage_key_ok(bucket_id, name) );
-- event_docs_select / event_docs_delete (0009) already require the area: unchanged.

-- =============================================================================
-- 5) chat-media: keep 0025 membership check, add key shape + per-user rate
-- =============================================================================
drop policy if exists chat_media_ins on storage.objects;
create policy chat_media_ins on storage.objects for insert to authenticated
  with check ( bucket_id = 'chat-media' and public.chat_media_visible(name)
               and public.storage_upload_allowed(bucket_id, name) );

-- =============================================================================
-- 6) metadata caps (NOT VALID: existing rows are never re-checked or touched)
-- =============================================================================
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_sites_photos_max'
                  and conrelid = 'public.event_sites'::regclass) then
    alter table public.event_sites add constraint event_sites_photos_max
      check (jsonb_typeof(data -> 'photos') is distinct from 'array'
             or jsonb_array_length(data -> 'photos') <= 60) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_files_filename_safe'
                  and conrelid = 'public.event_files'::regclass) then
    alter table public.event_files add constraint event_files_filename_safe
      check (char_length(filename) between 1 and 255 and filename !~ '[[:cntrl:]]') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_files_path_in_event'
                  and conrelid = 'public.event_files'::regclass) then
    alter table public.event_files add constraint event_files_path_in_event
      check (storage_path like org_id::text || '/' || quote_id::text || '/%') not valid;
  end if;
end $$;

-- =============================================================================
-- 7) PAYMENT MILESTONES: the paid transition is a money event — server functions only
--    (record_payment / record_settlement_payment / settle_milestone / mark_paid run as
--    their owner and pass). Non-paid schedule edits keep working for finance editors.
-- =============================================================================
create or replace function public.payment_milestones_paid_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.status = 'paid' then
      raise exception 'a milestone can only be marked paid by recording the payment' using errcode = '42501';
    elsif tg_op = 'UPDATE' and (old.status = 'paid' or new.status = 'paid') then
      raise exception 'a paid milestone can only change through the payment functions' using errcode = '42501';
    elsif tg_op = 'DELETE' and old.status = 'paid' then
      raise exception 'a paid milestone cannot be deleted' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;
revoke all on function public.payment_milestones_paid_guard() from public, anon, authenticated;
drop trigger if exists aa_milestone_paid_guard on public.payment_milestones;
create trigger aa_milestone_paid_guard before insert or update or delete on public.payment_milestones
  for each row execute function public.payment_milestones_paid_guard();

-- settle_milestone: the app's "mark this milestone paid" — writes the receipt to the
-- quote_payments ledger AND flips the milestone, under the per-quote money lock.
-- Same right as the old direct write (has_area finance edit), but the amount comes
-- from the milestone row (server), not the browser. The milestone flips BEFORE the
-- ledger row so the 0003 milestone guard does not count the same money twice.
create or replace function public.settle_milestone(
  p_milestone uuid, p_method text default 'cash', p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.payment_milestones; q public.quotes; existing public.quote_payments;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_method text := lower(coalesce(nullif(btrim(coalesce(p_method, '')), ''), 'cash'));
  rno text; seqn int; tries int := 0;
begin
  if not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into m from public.payment_milestones where id = p_milestone and org_id = public.current_org_id();
  if m.id is null then raise exception 'no such milestone' using errcode = '42501'; end if;
  perform public.assert_quote_org(m.quote_id);
  if v_method !~ '^[a-z_]{2,20}$' then raise exception 'unknown payment method' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || m.quote_id::text, 0));
  select * into q from public.quotes where id = m.quote_id and org_id = public.current_org_id() for update;
  select * into m from public.payment_milestones where id = p_milestone for update;   -- re-read under the lock

  if v_key is not null then
    select * into existing from public.quote_payments where quote_id = m.quote_id and idempotency_key = v_key limit 1;
    if existing.id is not null then
      return jsonb_build_object('receipt_no', existing.receipt_no, 'amount', existing.amount,
        'method', existing.method, 'milestone', m.id, 'idempotent_replay', true);
    end if;
  end if;
  if m.status = 'paid'   then raise exception 'this milestone is already paid' using errcode = '23514'; end if;
  if m.status = 'waived' then raise exception 'this milestone was waived — change it back to due first' using errcode = '23514'; end if;
  if not (coalesce(m.amount, 0) > 0) then raise exception 'amount must be greater than zero' using errcode = '23514'; end if;

  update public.payment_milestones set status = 'paid', paid_at = now() where id = m.id;

  loop
    tries := tries + 1;
    select count(*) + 1 into seqn from public.quote_payments where quote_id = m.quote_id and status = 'paid';
    rno := 'RCP-' || q.code || '-' || lpad(seqn::text, 2, '0') || case when tries > 1 then '-' || tries::text else '' end;
    begin
      insert into public.quote_payments(quote_id, org_id, provider, amount, status, provider_ref, receipt_no, method,
                                        simulated, paid_at, note, idempotency_key)
        values (m.quote_id, q.org_id, v_method, m.amount, 'paid', rno, rno, v_method,
                (v_method <> 'cash'), now(), left('Milestone: ' || coalesce(m.label, ''), 200), v_key);
      exit;
    exception when unique_violation then
      if tries >= 5 then raise; end if;
    end;
  end loop;
  update public.quotes set updated_at = now() where id = m.quote_id and org_id = public.current_org_id();

  return jsonb_build_object('receipt_no', rno, 'amount', m.amount, 'method', v_method, 'milestone', m.id);
end $$;
revoke all on function public.settle_milestone(uuid, text, text) from public, anon;
grant execute on function public.settle_milestone(uuid, text, text) to authenticated;

-- =============================================================================
-- 8) PAYMENT LINKS (create-payment-link Edge Function, service role only)
--    One open live link per quote: begin() reserves a 'created' row under the
--    per-quote money lock (a second caller gets 'busy' or the reusable link), the
--    function then calls Razorpay and attach()es the plink id + URL; on failure it
--    fail()s the reservation. A changed total supersedes (cancels) the old links and
--    returns their plink ids so the function can cancel them at Razorpay too.
-- =============================================================================
alter table public.quote_payments add column if not exists link_expires_at timestamptz;
-- the Razorpay payment id (pay_…) that settled a row: webhook replay detection
alter table public.quote_payments add column if not exists provider_payment_ref text;
create unique index if not exists quote_payments_provider_payment_uk
  on public.quote_payments (provider, provider_payment_ref) where provider_payment_ref is not null;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes int default 4320)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes; open_row public.quote_payments; v_total numeric; v_super jsonb;
  v_id uuid; v_exp timestamptz;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null or q.approval_token_revoked_at is not null
     or (q.approval_token_expires_at is not null and q.approval_token_expires_at <= now()) then
    return jsonb_build_object('action', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || q.id::text, 0));
  select * into q from public.quotes where id = q.id for update;
  if q.approval_status = 'paid' then return jsonb_build_object('action', 'paid'); end if;
  if q.approval_status is distinct from 'approved' then return jsonb_build_object('action', 'not_approved'); end if;
  begin v_total := round((q.pricing ->> 'total')::numeric, 2); exception when others then v_total := null; end;
  if v_total is null or v_total = 'NaN'::numeric or v_total <= 0 or v_total > 100000000 then
    return jsonb_build_object('action', 'nothing_due');
  end if;

  select * into open_row from public.quote_payments
   where quote_id = q.id and provider = 'razorpay' and status = 'created' and simulated = false
   order by created_at desc limit 1;
  if open_row.id is not null then
    if open_row.provider_ref is null and open_row.created_at > now() - interval '2 minutes' then
      return jsonb_build_object('action', 'busy');          -- another request is creating it right now
    end if;
    if open_row.amount = v_total
       and coalesce(open_row.provider_ref, '') ~ '^plink_[A-Za-z0-9]+$'
       and coalesce(open_row.link_url, '') ~ '^https://rzp\.io/[A-Za-z0-9/_-]+$'
       and (open_row.link_expires_at is null or open_row.link_expires_at > now() + interval '15 minutes') then
      return jsonb_build_object('action', 'reuse', 'link_url', open_row.link_url, 'amount', v_total);
    end if;
  end if;

  -- supersede every other open link of this quote (stale amount / expired / stuck)
  with c as (
    update public.quote_payments set status = 'cancelled'
     where quote_id = q.id and status = 'created'
    returning provider, provider_ref
  )
  select coalesce(jsonb_agg(provider_ref) filter (where provider = 'razorpay'
                  and coalesce(provider_ref, '') ~ '^plink_[A-Za-z0-9]+$'), '[]'::jsonb)
    into v_super from c;

  v_exp := now() + make_interval(mins => greatest(20, least(coalesce(p_ttl_minutes, 4320), 43200)));
  if q.approval_token_expires_at is not null and q.approval_token_expires_at < v_exp then
    v_exp := greatest(q.approval_token_expires_at, now() + interval '20 minutes');
  end if;
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated, link_expires_at)
    values (q.id, q.org_id, 'razorpay', v_total, 'created', false, v_exp)
    returning id into v_id;
  return jsonb_build_object('action', 'create', 'payment_id', v_id, 'quote_id', q.id, 'org_id', q.org_id,
    'code', q.code, 'amount', v_total, 'expire_by', floor(extract(epoch from v_exp))::bigint,
    'client', coalesce(q.client, '{}'::jsonb), 'supersede', v_super);
end $$;

create or replace function public.payment_link_attach(p_payment uuid, p_provider_ref text, p_link_url text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if coalesce(p_provider_ref, '') !~ '^plink_[A-Za-z0-9]+$'
     or coalesce(p_link_url, '') !~ '^https://rzp\.io/[A-Za-z0-9/_-]+$' then
    return false;
  end if;
  update public.quote_payments set provider_ref = p_provider_ref, link_url = p_link_url
   where id = p_payment and status = 'created' and provider = 'razorpay' and provider_ref is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.payment_link_fail(p_payment uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.quote_payments set status = 'failed'
   where id = p_payment and status = 'created' and provider = 'razorpay' and provider_ref is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function public.payment_link_begin(uuid, int)        from public, anon, authenticated;
revoke all on function public.payment_link_attach(uuid, text, text) from public, anon, authenticated;
revoke all on function public.payment_link_fail(uuid)              from public, anon, authenticated;
grant execute on function public.payment_link_begin(uuid, int)        to service_role;
grant execute on function public.payment_link_attach(uuid, text, text) to service_role;
grant execute on function public.payment_link_fail(uuid)              to service_role;

-- =============================================================================
-- 9) PAYMENT RECONCILIATION — money the webhook could not apply (quote already paid,
--    amount short of the total, paid link superseded). Written by razorpay-webhook
--    (service role); finance viewers of the studio can read it; refunds are manual.
-- =============================================================================
create table if not exists public.payment_reconciliation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  quote_id uuid references public.quotes(id) on delete set null,
  provider text not null default 'razorpay',
  provider_event text,
  provider_link_ref text,
  provider_payment_ref text,
  amount_paise bigint,
  expected_paise bigint,
  reason text not null,
  status text not null default 'open',
  note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  constraint payment_reconciliation_reason_check
    check (reason in ('already_paid', 'amount_mismatch', 'superseded_link', 'overpayment', 'unmatched')),
  constraint payment_reconciliation_status_check check (status in ('open', 'refunded', 'resolved'))
);
create unique index if not exists payment_reconciliation_payment_uk
  on public.payment_reconciliation (provider, provider_payment_ref) where provider_payment_ref is not null;
create index if not exists payment_reconciliation_org_idx on public.payment_reconciliation (org_id, status);
alter table public.payment_reconciliation enable row level security;
revoke all on public.payment_reconciliation from anon, authenticated;
grant select on public.payment_reconciliation to authenticated;
grant all on public.payment_reconciliation to service_role;
drop policy if exists payment_reconciliation_read on public.payment_reconciliation;
create policy payment_reconciliation_read on public.payment_reconciliation for select to authenticated
  using ( public.has_area('finance', 'view') and org_id = (select public.current_org_id()) );
drop trigger if exists zz_quote_org_match on public.payment_reconciliation;
create trigger zz_quote_org_match before insert or update on public.payment_reconciliation
  for each row execute function public.tg_quote_org_match();

-- finance editors close an item once the refund / reconciliation is done (no deletes)
create or replace function public.resolve_payment_reconciliation(p_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_status not in ('refunded', 'resolved') then raise exception 'status must be refunded or resolved' using errcode = '22023'; end if;
  update public.payment_reconciliation
     set status = p_status, resolved_at = now(), resolved_by = auth.uid(), note = left(nullif(btrim(coalesce(p_note, '')), ''), 500)
   where id = p_id and org_id = public.current_org_id() and status = 'open';
  if not found then raise exception 'no such open item' using errcode = '42501'; end if;
end $$;
revoke all on function public.resolve_payment_reconciliation(uuid, text, text) from public, anon;
grant execute on function public.resolve_payment_reconciliation(uuid, text, text) to authenticated;

-- razorpay_settle — the webhook's whole decision in ONE transaction under the per-quote
-- money lock (service role only). Returns {result: settled | replay | reconcile |
-- unmatched}. Money is never dropped: a payment that cannot settle the quote (already
-- paid, short of the total, on a superseded link, or over the balance) is recorded in
-- payment_reconciliation for a refund / manual match. The quote is resolved from the
-- link's provider_ref first; notes.quote_id is only a fallback.
create or replace function public.razorpay_settle(
  p_quote uuid, p_link_ref text, p_payment_ref text, p_paid_paise bigint, p_event text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes; v_quote uuid := p_quote; v_map public.quote_payments; v_row uuid;
  v_exp bigint; v_reason text;
  v_pay text := nullif(btrim(coalesce(p_payment_ref, '')), '');
  v_link text := nullif(btrim(coalesce(p_link_ref, '')), '');
begin
  if v_link is not null then
    select * into v_map from public.quote_payments
     where provider = 'razorpay' and provider_ref = v_link order by created_at desc limit 1;
    if v_map.id is not null then v_quote := v_map.quote_id; end if;
  end if;
  if v_quote is null then return jsonb_build_object('result', 'unmatched'); end if;

  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || v_quote::text, 0));
  select * into q from public.quotes where id = v_quote for update;
  if q.id is null then return jsonb_build_object('result', 'unmatched'); end if;

  -- at-least-once delivery: the same payment id is applied exactly once
  if v_pay is not null and (
       exists (select 1 from public.quote_payments where provider = 'razorpay' and provider_payment_ref = v_pay)
    or exists (select 1 from public.payment_reconciliation where provider = 'razorpay' and provider_payment_ref = v_pay)) then
    return jsonb_build_object('result', 'replay', 'quote_id', q.id, 'org_id', q.org_id);
  end if;

  begin v_exp := round(coalesce((q.pricing ->> 'total')::numeric, 0) * 100); exception when others then v_exp := null; end;
  if q.approval_status = 'paid' then v_reason := 'already_paid';
  elsif v_map.id is not null and v_map.status is distinct from 'created' then v_reason := 'superseded_link';
  elsif p_paid_paise is null or v_exp is null or v_exp <= 0 or p_paid_paise < v_exp then v_reason := 'amount_mismatch';
  end if;

  if v_reason is null then
    if v_map.id is not null then
      v_row := v_map.id;
    else
      select id into v_row from public.quote_payments
       where quote_id = q.id and provider = 'razorpay' and status = 'created' and simulated = false
       order by created_at desc limit 1;
    end if;
    begin
      if v_row is not null then
        update public.quote_payments set status = 'paid', paid_at = now(), provider_payment_ref = v_pay where id = v_row;
      else
        insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated, paid_at, provider_payment_ref)
          values (q.id, q.org_id, 'razorpay', round(v_exp / 100.0, 2), 'paid', false, now(), v_pay);
      end if;
    exception when check_violation then
      v_reason := 'overpayment';            -- 23514 from the 0003 overpayment guard
    end;
  end if;

  if v_reason is not null then
    insert into public.payment_reconciliation(org_id, quote_id, provider, provider_event, provider_link_ref,
                                              provider_payment_ref, amount_paise, expected_paise, reason)
      values (q.org_id, q.id, 'razorpay', left(p_event, 60), v_link, v_pay, p_paid_paise, v_exp, v_reason)
      on conflict do nothing;
    return jsonb_build_object('result', 'reconcile', 'reason', v_reason, 'quote_id', q.id, 'org_id', q.org_id);
  end if;

  -- the paid link wins; every other open link of the quote is cancelled
  update public.quote_payments set status = 'cancelled' where quote_id = q.id and status = 'created';
  update public.quotes set approval_status = 'paid', updated_at = now() where id = q.id;
  return jsonb_build_object('result', 'settled', 'quote_id', q.id, 'org_id', q.org_id);
end $$;
revoke all on function public.razorpay_settle(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.razorpay_settle(uuid, text, text, bigint, text) to service_role;

-- =============================================================================
-- 10) MESSAGING: channel log, per-studio rate counter, recipient + sender checks
-- =============================================================================
-- WhatsApp sends were logged with channel 'whatsapp', which the CHECK rejected (the
-- insert failed silently). Widen the set additively; existing rows already satisfy it.
alter table public.notifications drop constraint if exists notifications_channel_check;
alter table public.notifications add constraint notifications_channel_check
  check (channel = any (array['sms', 'email', 'in_app', 'whatsapp'])) not valid;

create table if not exists public.messaging_rate (
  org_id uuid not null,
  channel text not null,
  window_secs int not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (org_id, channel, window_secs, window_start)
);
alter table public.messaging_rate enable row level security;   -- no policy: server only
revoke all on public.messaging_rate from anon, authenticated;
grant all on public.messaging_rate to service_role;

-- counts one send for (org, channel) in the current fixed window; true while under the limit
create or replace function public.messaging_rate_hit(p_org uuid, p_channel text, p_limit int, p_window_secs int default 3600)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_start timestamptz; v_hits int; v_win int := greatest(60, coalesce(p_window_secs, 3600));
begin
  if p_org is null or coalesce(p_channel, '') = '' or coalesce(p_limit, 0) <= 0 then return false; end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / v_win) * v_win);
  insert into public.messaging_rate as r (org_id, channel, window_secs, window_start, hits)
    values (p_org, p_channel, v_win, v_start, 1)
    on conflict (org_id, channel, window_secs, window_start) do update set hits = r.hits + 1
    returning hits into v_hits;
  return v_hits <= p_limit;
end $$;
revoke all on function public.messaging_rate_hit(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.messaging_rate_hit(uuid, text, int, int) to service_role;

-- phone → digits with country code (Indian 10-digit / 0-prefixed → 91…; 00… → …)
create or replace function public.helm_norm_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when d ~ '^[0-9]{10}$'      then '91' || d
           when d ~ '^0[0-9]{10}$'     then '91' || substr(d, 2)
           when d ~ '^00[0-9]{8,15}$'  then substr(d, 3)
           else d
         end
    from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) s;
$$;
grant execute on function public.helm_norm_phone(text) to anon, authenticated, service_role;

-- send-whatsapp, called with the CALLER's JWT: may this user message this number for
-- this event? (quotes edit right, own studio's event, number belongs to the event —
-- client, a crew link holder, or a vendor booked on it — and the studio is under its
-- hourly WhatsApp limit). Returns the normalized number to send to.
create or replace function public.whatsapp_authorize(p_quote uuid, p_recipient text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare q public.quotes; v_to text := public.helm_norm_phone(p_recipient);
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.quotes where id = p_quote and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event' using errcode = '42501'; end if;
  if v_to !~ '^[0-9]{10,15}$' then raise exception 'invalid number' using errcode = '22023'; end if;
  if not (
       public.helm_norm_phone(q.client ->> 'phone') = v_to
    or exists (select 1 from public.work_tokens w where w.quote_id = q.id and public.helm_norm_phone(w.phone) = v_to)
    or exists (select 1 from public.event_resources r join public.vendors v on v.id = r.vendor_id
                where r.quote_id = q.id and v.org_id = q.org_id and public.helm_norm_phone(v.phone) = v_to)
  ) then
    raise exception 'that number is not on this event' using errcode = '42501';
  end if;
  if not public.messaging_rate_hit(q.org_id, 'whatsapp', 100, 3600) then
    raise exception 'whatsapp limit reached for this studio — try again later' using errcode = 'HL429';
  end if;
  return jsonb_build_object('ok', true, 'to', v_to, 'org_id', q.org_id, 'quote_id', q.id);
end $$;
revoke all on function public.whatsapp_authorize(uuid, text) from public, anon;
grant execute on function public.whatsapp_authorize(uuid, text) to authenticated;

-- send-otp (service role): the OTP goes to the client phone on file when there is one;
-- otherwise only to an Indian mobile. Per-studio daily SMS cap. Returns where to send.
create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare q public.quotes; v_to text := public.helm_norm_phone(p_phone); v_file text;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null or q.approval_token_revoked_at is not null
     or (q.approval_token_expires_at is not null and q.approval_token_expires_at <= now()) then
    raise exception 'invalid link' using errcode = 'HL404';
  end if;
  v_file := public.helm_norm_phone(q.client ->> 'phone');
  if v_file <> '' then
    if v_to is distinct from v_file then raise exception 'phone not on file' using errcode = 'HL403'; end if;
  elsif v_to !~ '^91[6-9][0-9]{9}$' then
    raise exception 'invalid phone' using errcode = 'HL400';
  end if;
  if not public.messaging_rate_hit(q.org_id, 'sms', 200, 86400) then
    raise exception 'sms limit reached' using errcode = 'HL429';
  end if;
  return jsonb_build_object('quote_id', q.id, 'org_id', q.org_id, 'mobile', v_to);
end $$;
revoke all on function public.otp_send_authorize(uuid, text) from public, anon, authenticated;
grant execute on function public.otp_send_authorize(uuid, text) to service_role;

-- ---- VERIFY -------------------------------------------------------------------
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id;   -- all public=false
-- select policyname, cmd from pg_policies where schemaname='storage' and policyname like 'invite_media%';
--   expect exactly: invite_media_org_read / _published_read (select), _org_write (insert),
--   _org_update, _org_delete. ANY other permissive write policy on storage.objects that
--   mentions invite-media / event-docs (dashboard-made) must be dropped by hand.
-- select tgname from pg_trigger where tgrelid='public.payment_milestones'::regclass and tgname='aa_milestone_paid_guard';
-- select has_function_privilege('authenticated','public.payment_link_begin(uuid,int)','EXECUTE');      -- false
-- select has_function_privilege('authenticated','public.messaging_rate_hit(uuid,text,int,int)','EXECUTE'); -- false
