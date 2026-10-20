-- 0263_quote_stage_machine.sql - CANONICAL forward-only.
-- REQUIRES 0040 + 0208 (quotes archived_* / deleted_* / link_expired_at), 0052 (lifecycle_stage, consent_stale),
--          0078 (client_link_opens), 0049 / 0198 (event_closure, event_cancellations, lifecycle_stage_overrides),
--          0045 (_hq_wgate), phase29 / phase57 / phase97 (has_area, current_org_id, user_role, app_config (org_id, key)),
--          0184 when installed (trial retention purge list gets the new studio tables).
--
-- In plain words (r23, INDUSTRY-BENCHMARK-PLAN A2 + A3 - the Salesforce / HubSpot deal-stage + Stripe event model):
--   A quote / event's state is split over three columns: status (quote / confirmed = priced and LOCKED / cancelled),
--   approval_status (none / sent / approved / paid / cancelled) and lifecycle_stage (lead .. closed, 11 stages, moved
--   by set_lifecycle_stage). Plus: archived / deleted shelves (0040 / 0141), the closure row (event_closure.closed_at)
--   and the client opening the approval link (client_link_opens kind 'quote'). This migration adds ONE canonical
--   stage on top of them WITHOUT changing a single existing write path:
--
--   1  helm_quote_stage(...) - one pure rule that folds those columns into ONE stage:
--        lead > draft > sent > viewed > approved > advance_paid > confirmed > in_progress > event_day > completed
--        > closed, plus the side stages cancelled, expired, lost. (Exact mapping in section 1 below; the app has a
--        line-for-line copy, BPStore.quoteStage, and a parity test.) View quote_stage_v = every quote + its stage.
--   2  quote_stage_transitions (append-only): from, to, actor, at, reason, source (ui / rpc / client / cron /
--        system / backfill), via (the RPC name). Written ONLY by AFTER ROW triggers on quotes (state columns only),
--        event_closure and client_link_opens - so every existing RPC, webhook, cron and trigger is covered
--        automatically. ONE MOVE PER TRANSACTION: an RPC that changes approval, lifecycle and status one after the
--        other leaves ONE row (its own provisional row is replaced, never a committed one).
--        quote_stage_current keeps the latest stage per quote (the comparison point; self-heals on read).
--   3  quote_stage_moves = the table of allowed moves (seeded once, insert-only); a move that is not in it is an
--        "illegal move". Default mode WARN: the move happens as before and is logged in quote_stage_warnings.
--        ENFORCE (HQ switch, or a studio's own Control Center switch) refuses an illegal move made by a signed-in
--        studio user (error HL423 at COMMIT, the whole change is rolled back; that deferred check is only queued
--        while some studio / HQ has ENFORCE on - in WARN nothing is queued). Client links, payment webhooks, cron jobs and
--        SQL-editor work are NEVER blocked - they are logged. HQ can also switch tracking OFF entirely (kill switch).
--   4  domain_events: every transition adds one row (type 'quote.<to_stage>', e.g. quote.approved) that
--        automations read in order with domain_events_pull(consumer, types, limit) + domain_events_ack(consumer,
--        last_id) (service role; one cursor per consumer in domain_event_cursors). Nothing is sent by this migration.
--   5  Read RPCs for the app: quote_stage_history(quote) (the event workspace / quote flow timeline: "Moved to
--        Approved by client - 20/10/2026 14:05"), quote_stage_list(ids) (stage pills on lists), stage_machine_settings
--        / set_stage_machine_settings (Control Center), hq_stage_machine / hq_set_stage_machine (HQ, counts only - no
--        studio business data).
--   6  BACKFILL (insert-only): one "recorded when tracking began" row per existing quote (source backfill, no
--        domain event - automations do not fire for history).
--   7  quote_stage_sweep(): time-based expiry (a sent link that ran out) is recorded every 30 minutes by pg_cron
--        when it is ALREADY installed (never created here); opening the timeline also self-heals that one quote.
--
-- SAFETY (zero data loss / no behaviour change):
--   * No existing table, column, row, function, trigger or policy is changed or deleted. New tables use the column
--     name quote_ref (NOT quote_id) and have no foreign key to quotes ON PURPOSE: the empty-draft cleanup (0141 /
--     0220) and the tenant guards (0004 / 0136) scan every quote_id column / FK at run time - a stage row must never
--     make an empty draft look "used". Tenancy: org_id is always copied from the quote row by the trigger itself.
--   * Every trigger body runs inside its own exception block: if logging ever fails, the original write still
--     commits (a WARNING is raised). Only ENFORCE mode (off by default) can refuse a write, and only a studio user's.
--   * The quotes trigger fires only when one of the state columns changes (pricing autosaves never run it).
--   * Trial retention (0184, owner switch, off by default) empties the four new studio tables with the rest of an
--     expired trial's events (patched in place, once).
-- Additive + idempotent: safe to run twice (the 2nd run changes nothing). ASCII only.
-- ROLLBACK (manual, only if ever needed - the switch is simpler: HQ -> Stage tracking OFF):
--   drop trigger if exists zz_r23_stage on public.quotes; drop trigger if exists zz_r23_stage_upd on public.quotes;
--   drop trigger if exists zzzzzz_r23_stage_guard on public.quotes; drop trigger if exists zz_r23_stage on public.event_closure;
--   drop trigger if exists zz_r23_stage on public.client_link_opens;  (the new tables can stay, unused)

-- ---- 0) prechecks ---------------------------------------------------------------------------------------------
do $$ declare c text; begin
  foreach c in array array['status', 'approval_status', 'lifecycle_stage', 'archived_at', 'archived_reason', 'deleted_at',
                           'deleted_reason', 'link_expired_at', 'approval_token_expires_at', 'consent_stale', 'org_id'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = c) then
      raise exception 'STOP 0263: quotes.% is missing (apply 0040 / 0052 / 0208 first)', c; end if;
  end loop;
  if to_regclass('public.event_closure') is null or to_regclass('public.client_link_opens') is null then
    raise exception 'STOP 0263: event_closure / client_link_opens missing (apply 0049 + 0078 first)'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.user_role()') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'STOP 0263: has_area / current_org_id / user_role / is_platform_admin missing'; end if;
  if to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null then
    raise exception 'STOP 0263: _hq_wgate missing (apply 0045 first)'; end if;
  if to_regclass('public.app_config') is null then raise exception 'STOP 0263: app_config missing'; end if;
end $$;

-- ---- 1) the ONE stage rule (pure) -----------------------------------------------------------------------------
-- p_shelf: null (in the normal lists) | 'expired' (shelved because the client link ran out) | 'lost' (archived /
-- deleted by hand or as an empty draft). p_viewed: the client opened the approval link. p_token_expired: the
-- approval link's expiry time has passed.
--   cancelled      status = 'cancelled' (cancel_event)                           - always wins
--   closed         lifecycle 'closed' or event_closure.closed_at set
--   completed      lifecycle 'settlement' (the event is over, money being settled)
--   event_day      lifecycle 'event_day'
--   in_progress    lifecycle planning / resources / ready
--   (lifecycle lead .. confirmed from here on)
--   confirmed      approval 'paid' at lifecycle 'confirmed' (approved + advance in = booked), or the studio moved it to
--                  Confirmed without an online approval (lifecycle 'confirmed', no approval, no stale price)
--   advance_paid   approval 'paid' before lifecycle 'confirmed'
--   approved       approval 'approved' (client approved, advance pending)
--   expired/lost   the quote is on a shelf (only while not approved / paid)
--   expired        approval 'sent' and the link's expiry has passed
--   viewed         approval 'sent' and the client opened the link
--   sent           approval 'sent' (or a price change after approval is waiting for the client again)
--   lead           lifecycle lead / discovery, nothing sent
--   draft          everything else (incl. priced + locked but not sent)
create or replace function public.helm_quote_stage(p_status text, p_approval text, p_lifecycle text, p_closed boolean,
                                                  p_viewed boolean, p_stale boolean, p_shelf text, p_token_expired boolean)
returns text language sql immutable set search_path = '' as $$
  -- helm-0263-stage-rule (mirrored line for line by BPStore.quoteStage in store-api.js)
  select case
    when coalesce(p_status, '') = 'cancelled' then 'cancelled'
    when coalesce(nullif(p_lifecycle, ''), 'quote') = 'closed' or coalesce(p_closed, false) then 'closed'
    when p_lifecycle = 'settlement' then 'completed'
    when p_lifecycle = 'event_day' then 'event_day'
    when p_lifecycle in ('planning', 'resources', 'ready') then 'in_progress'
    when coalesce(p_approval, '') = 'paid' and p_lifecycle = 'confirmed' then 'confirmed'
    when coalesce(p_approval, '') = 'paid' then 'advance_paid'
    when coalesce(p_approval, '') = 'approved' and not coalesce(p_stale, false) then 'approved'
    when p_lifecycle = 'confirmed' and not (coalesce(p_stale, false) and coalesce(p_approval, '') in ('sent', 'approved')) then 'confirmed'
    when p_shelf in ('expired', 'lost') then p_shelf
    when coalesce(p_approval, '') in ('sent', 'approved') and coalesce(p_token_expired, false) then 'expired'
    when coalesce(p_approval, '') in ('sent', 'approved') and coalesce(p_viewed, false) then 'viewed'
    when coalesce(p_approval, '') in ('sent', 'approved') then 'sent'
    when p_lifecycle in ('lead', 'discovery') then 'lead'
    else 'draft'
  end
$$;

create or replace function public.helm_quote_stage_label(p_stage text)
returns text language sql immutable set search_path = '' as $$
  -- helm-0263-stage-rule
  select case p_stage
    when 'lead' then 'Lead' when 'draft' then 'Draft' when 'sent' then 'Sent' when 'viewed' then 'Viewed by client'
    when 'approved' then 'Approved' when 'advance_paid' then 'Advance paid' when 'confirmed' then 'Confirmed'
    when 'in_progress' then 'In progress' when 'event_day' then 'Event day' when 'completed' then 'Completed'
    when 'closed' then 'Closed' when 'cancelled' then 'Cancelled' when 'expired' then 'Expired' when 'lost' then 'Lost'
    else coalesce(p_stage, '') end
$$;

-- position on the path (side stages sit next to where they branch off); used for ordering + the HQ view
create or replace function public.helm_quote_stage_order(p_stage text)
returns integer language sql immutable set search_path = '' as $$
  -- helm-0263-stage-rule
  select case p_stage
    when 'lead' then 10 when 'draft' then 20 when 'sent' then 30 when 'viewed' then 40 when 'expired' then 45
    when 'lost' then 46 when 'approved' then 50 when 'advance_paid' then 60 when 'confirmed' then 70
    when 'in_progress' then 80 when 'event_day' then 90 when 'completed' then 100 when 'closed' then 110
    when 'cancelled' then 120 else null end
$$;

-- ---- 2) tables --------------------------------------------------------------------------------------------------
-- NOTE: quote_ref, not quote_id, and no FK to quotes - see SAFETY above (0141 / 0220 / 0004 / 0136 scans).
create table if not exists public.quote_stage_transitions (
  id          bigserial primary key,
  org_id      uuid not null,
  quote_ref   uuid not null,
  from_stage  text,
  to_stage    text not null,
  actor       uuid,
  actor_email text,
  actor_role  text,
  source      text not null check (source in ('ui', 'rpc', 'client', 'cron', 'system', 'backfill')),
  via         text,
  reason      text,
  legal       boolean not null default true,
  detail      jsonb not null default '{}'::jsonb,
  xact        bigint not null default txid_current(),   -- the writing transaction (one move per transaction, see 5)
  at          timestamptz not null default now()
);
create index if not exists quote_stage_transitions_quote_idx on public.quote_stage_transitions(org_id, quote_ref, at desc, id desc);
create index if not exists quote_stage_transitions_at_idx on public.quote_stage_transitions(at desc);

create table if not exists public.quote_stage_current (
  quote_ref          uuid primary key,
  org_id             uuid not null,
  stage              text not null,
  since              timestamptz not null default now(),
  last_transition_id bigint,
  updated_at         timestamptz not null default now()
);
create index if not exists quote_stage_current_org_idx on public.quote_stage_current(org_id, stage);

create table if not exists public.quote_stage_warnings (
  id         bigserial primary key,
  org_id     uuid not null,
  quote_ref  uuid not null,
  from_stage text,
  to_stage   text not null,
  mode       text not null default 'warn',
  source     text,
  via        text,
  actor      uuid,
  xact       bigint not null default txid_current(),
  at         timestamptz not null default now()
);
create index if not exists quote_stage_warnings_at_idx on public.quote_stage_warnings(at desc);
create index if not exists quote_stage_warnings_org_idx on public.quote_stage_warnings(org_id, at desc);

-- the allowed moves (from -> to). Seeded once below; rows are never deleted by Helm. A move that is not here is an
-- "illegal move" (logged in WARN mode, refused for studio users in ENFORCE mode).
create table if not exists public.quote_stage_moves (
  from_stage text not null,
  to_stage   text not null,
  note       text,
  created_at timestamptz not null default now(),
  primary key (from_stage, to_stage)
);

-- domain events: one row per business event, read in order by automations (see domain_events_pull)
create table if not exists public.domain_events (
  id          bigserial primary key,
  org_id      uuid not null,
  type        text not null check (type ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type text not null default 'quote',
  entity_ref  uuid,
  actor       uuid,
  source      text,
  payload     jsonb not null default '{}'::jsonb,
  xact        bigint not null default txid_current(),
  created_at  timestamptz not null default now()
);
create index if not exists domain_events_org_idx on public.domain_events(org_id, id desc);
create index if not exists domain_events_type_idx on public.domain_events(type, id);
create index if not exists domain_events_entity_idx on public.domain_events(entity_type, entity_ref, id desc);

create table if not exists public.domain_event_cursors (
  consumer   text primary key check (consumer ~ '^[a-z0-9_.-]{2,60}$'),
  last_id    bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- HQ switches (one row). tracking_enabled = the kill switch; guard_mode off / warn / enforce; emit_events.
create table if not exists public.helm_stage_settings (
  id               boolean primary key default true check (id),
  tracking_enabled boolean not null default true,
  guard_mode       text not null default 'warn' check (guard_mode in ('off', 'warn', 'enforce')),
  emit_events      boolean not null default true,
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);
insert into public.helm_stage_settings(id) values (true) on conflict (id) do nothing;

-- RLS + grants: the app only READS (own studio, quotes view); every write goes through the definer functions.
do $$ declare t text; begin
  foreach t in array array['quote_stage_transitions', 'quote_stage_current', 'quote_stage_warnings', 'quote_stage_moves',
                           'domain_events', 'domain_event_cursors', 'helm_stage_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant all on public.%I to service_role', t); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.quote_stage_transitions, public.quote_stage_current, public.quote_stage_moves, public.domain_events to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage, select on sequence public.quote_stage_transitions_id_seq, public.quote_stage_warnings_id_seq, public.domain_events_id_seq to service_role';
  end if;
end $$;

drop policy if exists "r23 stage transitions read" on public.quote_stage_transitions;
create policy "r23 stage transitions read" on public.quote_stage_transitions for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));
drop policy if exists "r23 stage current read" on public.quote_stage_current;
create policy "r23 stage current read" on public.quote_stage_current for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));
drop policy if exists "r23 stage moves read" on public.quote_stage_moves;
create policy "r23 stage moves read" on public.quote_stage_moves for select to authenticated using (true);
drop policy if exists "r23 domain events read" on public.domain_events;
create policy "r23 domain events read" on public.domain_events for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));

-- append-only: a transition / domain event row is never rewritten (deleting stays possible ONLY for the owner-run
-- trial retention purge, which runs without API grants)
create or replace function public.tg_r23_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
revoke all on function public.tg_r23_append_only() from public;
drop trigger if exists zz_r23_append_only on public.quote_stage_transitions;
create trigger zz_r23_append_only before update on public.quote_stage_transitions
  for each row execute function public.tg_r23_append_only();
drop trigger if exists zz_r23_append_only on public.domain_events;
create trigger zz_r23_append_only before update on public.domain_events
  for each row execute function public.tg_r23_append_only();

-- ---- 3) allowed moves (seed, insert-only) --------------------------------------------------------------------
do $$ declare
  v_path text[] := array['lead', 'draft', 'sent', 'viewed', 'approved', 'advance_paid', 'confirmed', 'in_progress',
                         'event_day', 'completed', 'closed'];
  v_booked text[] := array['approved', 'advance_paid', 'confirmed', 'in_progress', 'event_day', 'completed'];
  i int; j int; a text; b text;
begin
  -- every forward move along the path (skipping stages is fine, like a CRM pipeline)
  for i in 1 .. array_length(v_path, 1) loop
    for j in i + 1 .. array_length(v_path, 1) loop
      insert into public.quote_stage_moves(from_stage, to_stage, note) values (v_path[i], v_path[j], 'forward')
        on conflict do nothing;
    end loop;
  end loop;
  -- once booked, the stage can move back and forth (set_lifecycle_stage allows backward moves from Confirmed on)
  foreach a in array v_booked loop
    foreach b in array v_booked loop
      if a <> b then insert into public.quote_stage_moves(from_stage, to_stage, note) values (a, b, 'booked: back / forth')
        on conflict do nothing; end if;
    end loop;
  end loop;
  -- before the client approves: edit again, re-send, re-approval after a price change, offline approval
  insert into public.quote_stage_moves(from_stage, to_stage, note) values
    ('draft', 'lead', 'back to enquiry'), ('sent', 'draft', 'link withdrawn / edited'), ('sent', 'lead', 'link withdrawn'),
    ('viewed', 'sent', 'link re-issued'), ('viewed', 'draft', 'link withdrawn / edited'), ('viewed', 'lead', 'link withdrawn'),
    ('approved', 'sent', 'price changed - client must approve again'), ('approved', 'viewed', 'price changed - client must approve again'),
    ('approved', 'draft', 'approval withdrawn'),
    ('confirmed', 'sent', 'price changed - client must approve again'), ('confirmed', 'viewed', 'price changed - client must approve again'),
    ('in_progress', 'sent', 'price changed - client must approve again'),
    -- link ran out (0039 / 0040) / shelved / restored
    ('sent', 'expired', 'client link ran out'), ('viewed', 'expired', 'client link ran out'), ('approved', 'expired', 'client link ran out'),
    ('expired', 'sent', 'link re-issued'), ('expired', 'viewed', 'link re-issued'), ('expired', 'draft', 'restored'),
    ('expired', 'lead', 'restored'), ('expired', 'approved', 'link re-issued and approved'), ('expired', 'lost', 'shelved'),
    ('expired', 'advance_paid', 'paid after re-issue'), ('expired', 'confirmed', 'confirmed by the studio'),
    ('lead', 'lost', 'archived / deleted'), ('draft', 'lost', 'archived / deleted'), ('sent', 'lost', 'archived / deleted'),
    ('viewed', 'lost', 'archived / deleted'), ('lead', 'expired', 'shelved: link ran out'), ('draft', 'expired', 'shelved: link ran out'),
    ('lost', 'lead', 'restored'), ('lost', 'draft', 'restored'), ('lost', 'sent', 'restored'), ('lost', 'viewed', 'restored'),
    ('lost', 'expired', 'restored'), ('lost', 'approved', 'restored'), ('lost', 'confirmed', 'restored'),
    -- closing / re-opening / cancelling (0049 / 0084 / 0152 / 0198)
    ('closed', 'completed', 're-opened (reopen_event)'), ('cancelled', 'closed', 'a cancelled event settled and closed'),
    ('expired', 'cancelled', 'cancelled'), ('lost', 'cancelled', 'cancelled'),
    ('expired', 'closed', 'closed'), ('lost', 'closed', 'closed')
  on conflict do nothing;
  foreach a in array array['lead', 'draft', 'sent', 'viewed', 'approved', 'advance_paid', 'confirmed', 'in_progress', 'event_day', 'completed'] loop
    insert into public.quote_stage_moves(from_stage, to_stage, note) values (a, 'cancelled', 'cancelled') on conflict do nothing;
  end loop;
end $$;

create or replace function public.quote_stage_allowed(p_from text, p_to text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0263-stage-machine: a first stage (no from) and staying put are always allowed
  select p_from is null or p_from = p_to
      or exists (select 1 from public.quote_stage_moves m where m.from_stage = p_from and m.to_stage = p_to);
$$;

-- ---- 4) live stage of one quote + who / how / why ------------------------------------------------------------------
create or replace function public._r23_quote_stage_now(p_quote uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare q record; v_closed boolean; v_viewed boolean; v_shelf text;
begin
  select x.status, x.approval_status, x.lifecycle_stage, x.consent_stale, x.archived_at, x.archived_reason,
         x.deleted_at, x.deleted_reason, x.link_expired_at, x.approval_token_expires_at
    into q from public.quotes x where x.id = p_quote;
  if not found then return null; end if;
  v_closed := exists (select 1 from public.event_closure c where c.quote_id = p_quote and c.closed_at is not null);
  v_viewed := exists (select 1 from public.client_link_opens o where o.quote_id = p_quote and o.kind = 'quote');
  if q.archived_at is not null or q.deleted_at is not null then
    v_shelf := case when coalesce(q.deleted_reason, q.archived_reason) = 'link_expired' or q.link_expired_at is not null
                    then 'expired' else 'lost' end;
  end if;
  return public.helm_quote_stage(q.status, q.approval_status, q.lifecycle_stage, v_closed, v_viewed, q.consent_stale,
                                 v_shelf, q.approval_token_expires_at is not null and q.approval_token_expires_at <= now());
end $$;

-- how the change reached the database: client link (anon / client portal), a studio user's RPC or direct save,
-- a service-role edge function / webhook, pg_cron, or SQL run by hand. An RPC may name itself with
-- set_config('helm.stage_source', 'rpc', true) / set_config('helm.stage_reason', '...', true).
create or replace function public._r23_source()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare v_claims jsonb; v_role text; v_path text; v_via text; v_src text; v_prole text;
begin
  begin v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then v_claims := null; end;
  v_role := coalesce(v_claims ->> 'role', '');
  v_path := nullif(current_setting('request.path', true), '');
  if v_path like '/rpc/%' then v_via := left(substr(v_path, 6), 80); end if;
  v_src := nullif(current_setting('helm.stage_source', true), '');
  if v_src is not null and v_src not in ('ui', 'rpc', 'client', 'cron', 'system') then v_src := null; end if;
  if v_role = 'authenticated' and (v_claims ->> 'sub') ~* '^[0-9a-f-]{36}$' then
    select p.role into v_prole from public.profiles p where p.id = (v_claims ->> 'sub')::uuid;
  end if;
  if v_src is null then
    v_src := case
      when v_role = 'anon' then 'client'
      when v_role = 'authenticated' and v_prole = 'client' then 'client'
      when v_role = 'authenticated' then case when v_via is not null then 'rpc' else 'ui' end
      when v_role = 'service_role' then 'system'
      when coalesce(current_setting('application_name', true), '') ilike 'pg_cron%' then 'cron'
      else 'system' end;
  end if;
  return jsonb_build_object('source', v_src, 'via', v_via, 'role', nullif(v_role, ''), 'profile_role', v_prole,
    'actor', case when v_role in ('authenticated', 'service_role') and (v_claims ->> 'sub') ~* '^[0-9a-f-]{36}$'
                  then v_claims ->> 'sub' end);
end $$;

-- the reason given in the same transaction as a move (cancel / stage override / close override / reopen ...), if any.
-- p_at = that transaction's time (now() while it runs; a stored move's "at" later - rows written in one transaction
-- all carry the same now(), so a reason saved AFTER the stage changed is still found when the history is read).
create or replace function public._r23_reason(p_quote uuid, p_at timestamptz default now())
returns text language plpgsql stable security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare v text;
begin
  if p_quote is null or p_at is null then return null; end if;
  if p_at = now() then
    v := nullif(btrim(coalesce(current_setting('helm.stage_reason', true), '')), '');
    if v is not null then return left(v, 1000); end if;
  end if;
  begin
    select c.reason into v from public.event_cancellations c where c.quote_id = p_quote and c.created_at = p_at
     order by c.created_at desc limit 1;
    if v is null then
      select o.reason into v from public.lifecycle_stage_overrides o where o.quote_id = p_quote and o.created_at = p_at
       order by o.created_at desc limit 1;
    end if;
    if v is null then
      select o.reason into v from public.event_close_overrides o where o.quote_id = p_quote and o.created_at = p_at
       order by o.created_at desc limit 1;
    end if;
    if v is null then
      select a.changed ->> 'reason' into v from public.audit_log a
       where a.quote_id = p_quote and a.at = p_at and jsonb_typeof(a.changed -> 'reason') = 'string'
       order by a.id desc limit 1;
    end if;
  exception when others then v := null;   -- an older database without one of those tables
  end;
  return left(nullif(btrim(coalesce(v, '')), ''), 1000);
end $$;

-- the guard mode for one studio: HQ off / enforce win; HQ warn -> the studio's own Control Center choice
create or replace function public._r23_guard_mode(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare v_hq text; v_st text;
begin
  select s.guard_mode into v_hq from public.helm_stage_settings s where s.id;
  v_hq := coalesce(v_hq, 'warn');
  if v_hq in ('off', 'enforce') then return v_hq; end if;
  select c.value ->> 'guardMode' into v_st from public.app_config c where c.org_id = p_org and c.key = 'stage_machine';
  return case when v_st = 'enforce' then 'enforce' else 'warn' end;
end $$;

-- ---- 5) record a move (the ONE writer) -----------------------------------------------------------------------------
-- p_mode: 'trigger' (a write changed the quote / its closure / the client opened the link), 'heal' (a read found the
-- stored stage behind - e.g. a link that ran out), 'sweep' (the 30-minute job). Returns the new stage or null.
-- ONE MOVE PER TRANSACTION: when the same transaction already recorded a move for this quote (an RPC that sets
-- approval, then lifecycle, then status one after the other), that provisional row is replaced, so the history shows
-- "viewed -> approved", never the in-between steps. The rows replaced are only this transaction's own, never a
-- committed one.
create or replace function public._r23_stage_sync(p_quote uuid, p_mode text default 'trigger')
returns text language plpgsql volatile security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare
  v_set record; v_org uuid; v_new text; v_cur record; v_own record; v_prev record; v_from text; v_src jsonb; v_source text;
  v_actor uuid; v_email text; v_legal boolean; v_gmode text; v_tid bigint; v_reason text; v_detail jsonb; q record;
  v_x bigint := txid_current(); v_mine boolean := false; v_had boolean;
begin
  if p_quote is null then return null; end if;
  select s.tracking_enabled, s.emit_events, s.guard_mode into v_set from public.helm_stage_settings s where s.id;
  if found and not v_set.tracking_enabled then return null; end if;
  select x.org_id, x.status, x.approval_status, x.lifecycle_stage into q from public.quotes x where x.id = p_quote;
  if not found or q.org_id is null then return null; end if;
  v_org := q.org_id;
  v_new := public._r23_quote_stage_now(p_quote);
  if v_new is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:stage:' || p_quote::text, 0));
  select c.stage, c.since, c.last_transition_id into v_cur from public.quote_stage_current c where c.quote_ref = p_quote for update;
  v_had := found;
  if v_had and v_cur.stage = v_new then return null; end if;
  v_from := v_cur.stage;
  if v_had and v_cur.last_transition_id is not null then
    select t.id, t.from_stage, t.xact into v_own from public.quote_stage_transitions t where t.id = v_cur.last_transition_id;
    v_mine := found and v_own.xact = v_x;
  end if;
  if v_mine then
    -- this transaction's own provisional move: drop it (and its warning / event), keep the stage it started from
    delete from public.domain_events e where e.xact = v_x and e.entity_ref = p_quote;
    delete from public.quote_stage_warnings w where w.xact = v_x and w.quote_ref = p_quote;
    delete from public.quote_stage_transitions t where t.id = v_own.id and t.xact = v_x;
    v_from := v_own.from_stage;
    if v_from is not distinct from v_new then                      -- back where the transaction started: no move
      select t.id, t.at into v_prev from public.quote_stage_transitions t where t.quote_ref = p_quote order by t.id desc limit 1;
      update public.quote_stage_current c set stage = v_new, since = coalesce(v_prev.at, c.since),
             last_transition_id = v_prev.id, updated_at = now() where c.quote_ref = p_quote;
      return null;
    end if;
  end if;

  v_src := public._r23_source();
  v_source := case when p_mode = 'sweep' then 'cron' when p_mode = 'heal' then 'system' else v_src ->> 'source' end;
  if (v_src ->> 'actor') is not null then v_actor := (v_src ->> 'actor')::uuid; end if;
  v_legal := public.quote_stage_allowed(v_from, v_new);
  if not v_legal then
    v_gmode := public._r23_guard_mode(v_org);
    if v_gmode <> 'off' then
      insert into public.quote_stage_warnings(org_id, quote_ref, from_stage, to_stage, mode, source, via, actor)
        values (v_org, p_quote, v_from, v_new, v_gmode, v_source, v_src ->> 'via', v_actor);
    end if;
  end if;
  if v_actor is not null then select u.email into v_email from auth.users u where u.id = v_actor; end if;
  v_reason := public._r23_reason(p_quote);
  v_detail := jsonb_strip_nulls(jsonb_build_object('status', q.status, 'approval_status', q.approval_status,
                'lifecycle_stage', q.lifecycle_stage, 'mode', nullif(p_mode, 'trigger')));
  insert into public.quote_stage_transitions(org_id, quote_ref, from_stage, to_stage, actor, actor_email, actor_role,
                                             source, via, reason, legal, detail)
    values (v_org, p_quote, v_from, v_new, v_actor, v_email, v_src ->> 'profile_role', v_source, v_src ->> 'via',
            v_reason, v_legal, v_detail)
    returning id into v_tid;
  insert into public.quote_stage_current(quote_ref, org_id, stage, since, last_transition_id, updated_at)
    values (p_quote, v_org, v_new, now(), v_tid, now())
  on conflict (quote_ref) do update set org_id = excluded.org_id, stage = excluded.stage, since = excluded.since,
    last_transition_id = excluded.last_transition_id, updated_at = excluded.updated_at;
  if coalesce(v_set.emit_events, true) then
    insert into public.domain_events(org_id, type, entity_type, entity_ref, actor, source, payload)
      values (v_org, 'quote.' || v_new, 'quote', p_quote, v_actor, v_source,
              jsonb_strip_nulls(jsonb_build_object('from', v_from, 'to', v_new, 'transition_id', v_tid,
                'legal', v_legal, 'via', v_src ->> 'via')));
  end if;
  return v_new;
end $$;

-- ---- 6) the triggers --------------------------------------------------------------------------------------------------------
-- (a) RECORD: plain AFTER ROW triggers (fire at the end of each statement - nothing is left pending, so a later
--     ALTER TABLE in the same transaction is never blocked). The body runs in its own exception block: if logging ever
--     fails the original write still goes through (a WARNING is raised) and the next read heals the stage.
create or replace function public.tg_r23_stage()
returns trigger language plpgsql security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare v_q uuid;
begin
  begin
    if tg_table_name = 'quotes' then v_q := new.id; else v_q := new.quote_id; end if;   -- separate statements: each row type has its own column
    perform public._r23_stage_sync(v_q, 'trigger');
  exception when others then
    raise warning 'helm 0263: stage not recorded for % (%)', v_q, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.tg_r23_stage() from public;

-- a new quote records its first stage; an UPDATE runs the trigger only when a state column changed
drop trigger if exists zz_r23_stage on public.quotes;
create trigger zz_r23_stage after insert on public.quotes for each row execute function public.tg_r23_stage();
drop trigger if exists zz_r23_stage_upd on public.quotes;
create trigger zz_r23_stage_upd after update on public.quotes for each row
  when (old.status is distinct from new.status or old.approval_status is distinct from new.approval_status
        or old.lifecycle_stage is distinct from new.lifecycle_stage or old.consent_stale is distinct from new.consent_stale
        or old.archived_at is distinct from new.archived_at or old.deleted_at is distinct from new.deleted_at
        or old.archived_reason is distinct from new.archived_reason or old.deleted_reason is distinct from new.deleted_reason
        or old.link_expired_at is distinct from new.link_expired_at
        or old.approval_token_expires_at is distinct from new.approval_token_expires_at
        or old.org_id is distinct from new.org_id)
  execute function public.tg_r23_stage();
drop trigger if exists zz_r23_stage on public.event_closure;
create trigger zz_r23_stage after insert or update on public.event_closure for each row execute function public.tg_r23_stage();
drop trigger if exists zz_r23_stage on public.client_link_opens;
create trigger zz_r23_stage after insert on public.client_link_opens for each row when (new.kind = 'quote')
  execute function public.tg_r23_stage();

-- (b) ENFORCE: a DEFERRED check at COMMIT (so it judges the transaction's final move, not an in-between step).
--     Queued ONLY while some studio (or HQ) has ENFORCE on - in the default WARN mode nothing is queued at all.
--     Refuses (HL423) only a move recorded as 'ui' / 'rpc' (a signed-in studio user); client links, service-role
--     webhooks, cron and SQL-editor work are never refused (they are logged as warnings).
create or replace function public._r23_enforcing()
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0263-stage-machine: is ENFORCE on anywhere? (cheap: one settings row + the few 'stage_machine' config rows)
  select coalesce((select s.tracking_enabled and s.guard_mode <> 'off'
                          and (s.guard_mode = 'enforce'
                               or exists (select 1 from public.app_config c where c.key = 'stage_machine' and c.value ->> 'guardMode' = 'enforce'))
                     from public.helm_stage_settings s where s.id), false);
$$;
revoke all on function public._r23_enforcing() from public;
-- the trigger's WHEN runs as whoever writes the quote (a studio user's save, a client link, a webhook), so every API
-- role may call it; it only answers "is ENFORCE on anywhere" (true / false), nothing else
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('grant execute on function public._r23_enforcing() to %I', r); end if;
  end loop;
end $$;

create or replace function public.tg_r23_stage_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare t record;
begin
  select x.from_stage, x.to_stage, x.source, x.legal, x.org_id into t
    from public.quote_stage_current c join public.quote_stage_transitions x on x.id = c.last_transition_id
   where c.quote_ref = new.id and x.xact = txid_current();
  if not found or t.legal or t.source not in ('ui', 'rpc') then return null; end if;
  if public._r23_guard_mode(t.org_id) <> 'enforce' then return null; end if;
  raise exception 'This move is not allowed: % -> %.', public.helm_quote_stage_label(t.from_stage), public.helm_quote_stage_label(t.to_stage)
    using errcode = 'HL423', hint = 'Stage rules are enforced for this studio. Ask an admin, or use the event''s own actions.';
end $$;
revoke all on function public.tg_r23_stage_guard() from public;
drop trigger if exists zzzzzz_r23_stage_guard on public.quotes;
create constraint trigger zzzzzz_r23_stage_guard after update on public.quotes
  deferrable initially deferred for each row
  when ((old.status is distinct from new.status or old.approval_status is distinct from new.approval_status
         or old.lifecycle_stage is distinct from new.lifecycle_stage or old.archived_at is distinct from new.archived_at
         or old.deleted_at is distinct from new.deleted_at or old.consent_stale is distinct from new.consent_stale)
        and public._r23_enforcing())
  execute function public.tg_r23_stage_guard();

-- ---- 7) the canonical stage view (RLS of quotes + the stage table applies: security_invoker) --------------------------
create or replace view public.quote_stage_v with (security_invoker = true) as
  select q.id as quote_ref, q.org_id, c.stage, public.helm_quote_stage_label(c.stage) as stage_label,
         public.helm_quote_stage_order(c.stage) as stage_order, c.since
    from public.quotes q join public.quote_stage_current c on c.quote_ref = q.id;
revoke all on public.quote_stage_v from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.quote_stage_v from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant select on public.quote_stage_v to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on public.quote_stage_v to service_role'; end if;
end $$;

-- ---- 8) read RPCs for the app ----------------------------------------------------------------------------------------
-- the event workspace / quote flow timeline. Same studio + quotes view; never for a client portal user.
create or replace function public.quote_stage_history(p_quote uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare v_org uuid := public.current_org_id(); c record; v_rows jsonb; v_show boolean := true; v_cfg jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501'; end if;
  begin perform public._r23_stage_sync(p_quote, 'heal'); exception when others then null; end;   -- self-heal, never fails the read
  select x.stage, x.since into c from public.quote_stage_current x where x.quote_ref = p_quote and x.org_id = v_org;
  select a.value into v_cfg from public.app_config a where a.org_id = v_org and a.key = 'stage_machine';
  if jsonb_typeof(v_cfg -> 'showHistory') = 'boolean' then v_show := (v_cfg ->> 'showHistory')::boolean; end if;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', t.id, 'from', t.from_stage, 'to', t.to_stage,
           'from_label', public.helm_quote_stage_label(t.from_stage), 'to_label', public.helm_quote_stage_label(t.to_stage),
           'at', t.at, 'source', t.source, 'via', t.via, 'legal', t.legal,
           'reason', coalesce(t.reason, case when t.source <> 'backfill' then public._r23_reason(t.quote_ref, t.at) end),
           'actor_name', case when t.source = 'client' then null
                              else coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(t.actor_email, p.email, ''), '@', 1), '')) end,
           'actor_role', t.actor_role)) order by t.at desc, t.id desc), '[]'::jsonb)
    into v_rows
    from (select * from public.quote_stage_transitions t2 where t2.org_id = v_org and t2.quote_ref = p_quote
           order by t2.at desc, t2.id desc limit 200) t
    left join public.profiles p on p.id = t.actor and p.org_id = v_org;
  return jsonb_build_object('quote_id', p_quote, 'stage', c.stage, 'label', public.helm_quote_stage_label(c.stage),
    'since', c.since, 'show_history', v_show, 'history', v_rows);
end $$;

-- stage pills for many quotes at once (own studio only; at most 500 ids)
create or replace function public.quote_stage_list(p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(cardinality(p_ids), 0) > 500 then raise exception 'at most 500 quotes at once' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('quote_id', c.quote_ref, 'stage', c.stage,
            'label', public.helm_quote_stage_label(c.stage), 'since', c.since)), '[]'::jsonb)
            from public.quote_stage_current c where c.org_id = v_org and c.quote_ref = any(coalesce(p_ids, '{}'::uuid[])));
end $$;

-- ---- 9) settings: Control Center (studio) + HQ ---------------------------------------------------------------------------
create or replace function public.stage_machine_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare v_org uuid := public.current_org_id(); v jsonb; s record; v_at timestamptz;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not (public.has_area('controls', 'view') or public.has_area('quotes', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select c.value, c.updated_at into v, v_at from public.app_config c where c.org_id = v_org and c.key = 'stage_machine';
  select x.tracking_enabled, x.guard_mode into s from public.helm_stage_settings x where x.id;
  return jsonb_build_object(
    'guard_mode', case when v ->> 'guardMode' = 'enforce' then 'enforce' else 'warn' end,
    'show_history', case when jsonb_typeof(v -> 'showHistory') = 'boolean' then (v ->> 'showHistory')::boolean else true end,
    'hq_guard_mode', coalesce(s.guard_mode, 'warn'), 'tracking', coalesce(s.tracking_enabled, true),
    'effective_mode', public._r23_guard_mode(v_org),
    'warnings_30d', (select count(*) from public.quote_stage_warnings w where w.org_id = v_org and w.at > now() - interval '30 days'),
    'can_edit', public.has_area('controls', 'edit') and coalesce(public.user_role(), '') = 'admin',
    'updated_at', v_at);
end $$;

create or replace function public.set_stage_machine_settings(p_guard_mode text, p_show_history boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0263-stage-machine: studio ADMIN with Control Center edit; merged into the app_config row (other keys kept)
declare v_org uuid := public.current_org_id(); v_patch jsonb := '{}'::jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') <> 'admin' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin can change the stage rules.' using errcode = '42501'; end if;
  if p_guard_mode is not null then
    if p_guard_mode not in ('warn', 'enforce') then raise exception 'Stage rules must be warn or enforce.' using errcode = '22023'; end if;
    v_patch := v_patch || jsonb_build_object('guardMode', p_guard_mode);
  end if;
  if p_show_history is not null then v_patch := v_patch || jsonb_build_object('showHistory', p_show_history); end if;
  insert into public.app_config(org_id, key, value, updated_at) values (v_org, 'stage_machine', v_patch, now())
  on conflict (org_id, key) do update
    set value = (case when jsonb_typeof(public.app_config.value) = 'object' then public.app_config.value else '{}'::jsonb end) || v_patch,
        updated_at = now();
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id)
    values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'stage_machine.settings', 'app_config',
            'stage_machine', v_patch, v_org);
  return public.stage_machine_settings();
end $$;

-- HQ: switches + platform-wide COUNTS only (no studio names, no quote data - 0045 rule)
create or replace function public.hq_stage_machine()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare s record; v_pairs jsonb;
begin
  if not public.is_platform_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select x.* into s from public.helm_stage_settings x where x.id;
  select coalesce(jsonb_agg(jsonb_build_object('from', f, 'to', t, 'count', n) order by n desc), '[]'::jsonb) into v_pairs
    from (select w.from_stage f, w.to_stage t, count(*) n from public.quote_stage_warnings w
           where w.at > now() - interval '30 days' group by 1, 2 order by 3 desc limit 20) z;
  return jsonb_build_object('tracking', coalesce(s.tracking_enabled, true), 'guard_mode', coalesce(s.guard_mode, 'warn'),
    'emit_events', coalesce(s.emit_events, true), 'updated_at', s.updated_at,
    'transitions_30d', (select count(*) from public.quote_stage_transitions t where t.at > now() - interval '30 days' and t.source <> 'backfill'),
    'warnings_30d', (select count(*) from public.quote_stage_warnings w where w.at > now() - interval '30 days'),
    'studios_enforcing', (select count(*) from public.app_config c where c.key = 'stage_machine' and c.value ->> 'guardMode' = 'enforce'),
    'events_pending', (select count(*) from public.domain_events e where e.id > coalesce((select min(k.last_id) from public.domain_event_cursors k), 0)),
    'illegal_moves', v_pairs);
end $$;

create or replace function public.hq_set_stage_machine(p_tracking boolean, p_guard_mode text, p_emit_events boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0263-stage-machine: HQ operator at aal2, audited by _hq_wgate
begin
  if p_guard_mode is not null and p_guard_mode not in ('off', 'warn', 'enforce') then
    raise exception 'guard mode must be off, warn or enforce' using errcode = '22023'; end if;
  perform public._hq_wgate('hq.stage_machine.set', 'helm_stage_settings', 'singleton',
    jsonb_strip_nulls(jsonb_build_object('tracking', p_tracking, 'guard_mode', p_guard_mode, 'emit_events', p_emit_events)));
  insert into public.helm_stage_settings(id) values (true) on conflict (id) do nothing;
  update public.helm_stage_settings s
     set tracking_enabled = coalesce(p_tracking, s.tracking_enabled), guard_mode = coalesce(p_guard_mode, s.guard_mode),
         emit_events = coalesce(p_emit_events, s.emit_events), updated_at = now(), updated_by = auth.uid()
   where s.id;
  return public.hq_stage_machine();
end $$;

-- ---- 10) domain events: how automations subscribe (service role only) ---------------------------------------------------
-- A consumer (an edge function / cron tick, e.g. 'reminders' or 'follow-ups') calls
--   select * from domain_events_pull('reminders', array['quote.viewed','quote.approved'], 100);
-- handles the rows (idempotently - keyed by the event id), then
--   select domain_events_ack('reminders', <the highest id it handled>);
-- The cursor never moves backwards; an unknown consumer starts at the current end (no replay of history) unless it
-- passes p_from_start = true the first time.
create or replace function public.domain_events_pull(p_consumer text, p_types text[] default null, p_limit integer default 100,
                                                    p_from_start boolean default false)
returns setof public.domain_events language plpgsql volatile security definer set search_path = '' as $$
-- helm-0263-domain-events
declare v_last bigint;
begin
  if p_consumer is null or p_consumer !~ '^[a-z0-9_.-]{2,60}$' then raise exception 'bad consumer name' using errcode = '22023'; end if;
  insert into public.domain_event_cursors(consumer, last_id)
    values (p_consumer, case when coalesce(p_from_start, false) then 0 else coalesce((select max(e.id) from public.domain_events e), 0) end)
  on conflict (consumer) do nothing;
  select k.last_id into v_last from public.domain_event_cursors k where k.consumer = p_consumer;
  return query select e.* from public.domain_events e
    where e.id > v_last and (p_types is null or e.type = any(p_types))
    order by e.id limit greatest(1, least(coalesce(p_limit, 100), 1000));
end $$;

create or replace function public.domain_events_ack(p_consumer text, p_last_id bigint)
returns bigint language plpgsql volatile security definer set search_path = '' as $$
-- helm-0263-domain-events
declare v bigint;
begin
  update public.domain_event_cursors k set last_id = greatest(k.last_id, coalesce(p_last_id, 0)), updated_at = now()
   where k.consumer = p_consumer returning k.last_id into v;
  if v is null then raise exception 'unknown consumer %', p_consumer using errcode = 'P0002'; end if;
  return v;
end $$;

-- ---- 11) time-based expiry: record links that ran out (pg_cron every 30 min when installed) ---------------------------
create or replace function public.quote_stage_sweep(p_limit integer default 500)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- helm-0263-stage-machine
declare r record; n int := 0;
begin
  for r in
    select q.id from public.quotes q join public.quote_stage_current c on c.quote_ref = q.id
     where q.approval_status = 'sent' and q.approval_token_expires_at is not null
       and q.approval_token_expires_at <= now() and c.stage in ('sent', 'viewed')
     order by q.approval_token_expires_at limit greatest(1, least(coalesce(p_limit, 500), 5000))
  loop
    begin
      if public._r23_stage_sync(r.id, 'sweep') is not null then n := n + 1; end if;
    exception when others then raise warning 'helm 0263 sweep: % (%)', r.id, sqlerrm;
    end;
  end loop;
  return n;
end $$;

-- ---- 12) grants ------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal: definer helpers / writers - never callable from the API
  foreach f in array array['_r23_quote_stage_now(uuid)', '_r23_source()', '_r23_reason(uuid, timestamptz)', '_r23_guard_mode(uuid)',
                           '_r23_stage_sync(uuid, text)', 'quote_stage_sweep(integer)',
                           'domain_events_pull(text, text[], integer, boolean)', 'domain_events_ack(text, bigint)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
  -- the app (signed-in studio users; every one re-checks studio + access itself)
  foreach f in array array['quote_stage_history(uuid)', 'quote_stage_list(uuid[])', 'stage_machine_settings()',
                           'set_stage_machine_settings(text, boolean)', 'hq_stage_machine()',
                           'hq_set_stage_machine(boolean, text, boolean)', 'quote_stage_allowed(text, text)',
                           'helm_quote_stage(text, text, text, boolean, boolean, boolean, text, boolean)',
                           'helm_quote_stage_label(text)', 'helm_quote_stage_order(text)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.' || f || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
end $$;

-- ---- 12b) trigger functions are never callable from the API; the studio read-only guard (0045 / 0183) on the four
--      studio tables (an ended trial / suspended studio writes nothing new - the stage trigger's own exception block
--      keeps the original write safe either way) ------------------------------------------------------------------------
do $$ declare f text; t text; begin
  foreach f in array array['tg_r23_stage()', 'tg_r23_stage_guard()', 'tg_r23_append_only()'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.' || f || ' from authenticated'; end if;
  end loop;
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    foreach t in array array['quote_stage_transitions', 'quote_stage_current', 'quote_stage_warnings', 'domain_events'] loop
      if not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || t) and g.tgname = 'zzz_studio_read_only') then
        execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
      end if;
    end loop;
  end if;
end $$;

-- ---- 13) trial retention (0184): the four studio tables are this studio's event records ------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''quote_stage_transitions''' in v_def) > 0 then return; end if;
  -- the way 0241 adds its tables: just before 'quotes', only while 'quotes' appears exactly once
  if (length(v_def) - length(replace(v_def, '''quotes''', ''))) / length('''quotes''') <> 1 then
    raise notice '0263: _tr184_purge_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''quotes''',
    '''quote_stage_transitions'', ''quote_stage_current'', ''quote_stage_warnings'', ''domain_events'', ''quotes''');
end $$;

-- ---- 14) BACKFILL (insert-only): the stage every existing quote is at when tracking begins -------------------------------
do $$ declare n int; begin
  with s as (
    select q.id, q.org_id, public._r23_quote_stage_now(q.id) as stage, q.status, q.approval_status, q.lifecycle_stage
      from public.quotes q
     where q.org_id is not null and not exists (select 1 from public.quote_stage_current c where c.quote_ref = q.id)
  ), t as (
    insert into public.quote_stage_transitions(org_id, quote_ref, from_stage, to_stage, source, via, legal, detail)
      select s.org_id, s.id, null, s.stage, 'backfill', '0263', true,
             jsonb_strip_nulls(jsonb_build_object('status', s.status, 'approval_status', s.approval_status,
               'lifecycle_stage', s.lifecycle_stage, 'note', 'recorded when stage tracking began'))
        from s where s.stage is not null
      returning id, org_id, quote_ref, to_stage
  )
  insert into public.quote_stage_current(quote_ref, org_id, stage, since, last_transition_id)
    select t.quote_ref, t.org_id, t.to_stage, now(), t.id from t
  on conflict (quote_ref) do nothing;
  get diagnostics n = row_count;
  raise notice '0263: backfilled % quote stage(s)', n;
end $$;

-- ---- 15) pg_cron, ONLY if it is already installed (never created here) ----------------------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_quote_stage_sweep') then
        perform cron.schedule('helm_quote_stage_sweep', '*/30 * * * *', 'select public.quote_stage_sweep(500)');
      end if;
    exception when others then
      raise notice '0263: pg_cron present but the sweep could not be scheduled (%); opening the timeline self-heals instead', sqlerrm;
    end;
  end if;
end $$;
