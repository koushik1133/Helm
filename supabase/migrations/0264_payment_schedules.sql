-- 0264_payment_schedules.sql - CANONICAL forward-only.
-- REQUIRES 0003 + 0027 + 0042 + 0110 + 0125 (milestones + money guards, helm_invoice_total, record_payment chain),
--          0036 / 0078 / 0250 (notification catalog chain), 0078 + 0092 + 0155 + 0195 + 0200 + 0212 (comms automation:
--          comms_settings, _comms_queue_pay, comms_tick, comms_outbox_claim), 0156 (record_payment wrappers),
--          0045 (tg_studio_read_only), 0004 (tg_quote_org_match), 0097 (quotes.is_demo), 0184 (trial retention lists).
--
-- In plain words (r23 owner, INDUSTRY-BENCHMARK-PLAN F4 #7 - the HoneyBook / Dubsado / Stripe invoicing model):
--   1  PAYMENT SCHEDULE TEMPLATES (Control Center -> Payment schedules). A template is 1-10 payments; each payment
--      has a name, an amount (a % of the quote total, a fixed amount, or "Balance" = whatever is left) and a due
--      rule (N days after approval, or N days before / after the event day). Built in (always there, never stored):
--        "30 / 50 / 20"  : 30% on approval, 50% 15 days before the event, 20% on the event day  (the default)
--        "50 / 50"       : 50% on approval, 50% 7 days before the event
--        "100% upfront"  : 100% on approval
--      A studio can add its own (custom), pick the default, or archive one (never deleted).
--   2  APPLIED AUTOMATICALLY when a quote is approved (approval_status -> approved / paid) or confirmed, only when
--      the event has NO milestones yet (an existing schedule is never overwritten or added to), only for real events
--      (not sample / demo, not cancelled / archived / deleted) and only while the studio switch "apply automatically"
--      is on (default on). Amounts are worked out from the invoice total (quote total incl. GST + approved change
--      orders - the same figure the overpayment guards use); whole rupees, the last / Balance payment takes the
--      rounding so the schedule always adds up to the total exactly. A due date before the approval day becomes the
--      approval day. A staff member can also apply a template by hand on an event without a schedule (with preview).
--      The automatic step never blocks an approval: any problem is logged as a warning and skipped.
--   3  REMINDERS ON BY DEFAULT. The 0078 payment reminders (e-mail / WhatsApp to the client, queued in comms_outbox;
--      sent only by the dormant comms-dispatch) now default ON for a studio that never saved its automatic-messages
--      settings, with the cadence 3 days before the due date, on the due date and 3 days after (overdue) - all still
--      editable in Control Center (Automatic client messages). A studio that already saved a choice keeps it (no
--      stored row is changed). Per event: "Pause automatic reminders" (Logistics -> Payments / the schedule card)
--      stops new automatic reminders for that event and skips any still waiting; "Send reminder now" still works.
--      Reminders now carry the studio's pay details: the live online payment link when one is open (never a
--      simulated one), the studio UPI ID and a short payment note (Control Center -> Payment schedules).
--   4  STUDIO BELL on overdue: once per payment, the day after its due date (within 30 days), while it is not fully
--      paid - kind 'payment_overdue', a money notice (admins + roles with Finance view by default; 0036 rules).
--   5  RECORDING A PAYMENT marks milestones paid: after record_payment / record_settlement_payment, every milestone
--      the money received now FULLY covers is marked paid, in schedule order (due date, then order); a part payment
--      leaves the milestone open and shows as "part paid". The 15-minute comms_tick does the same for money that came
--      in another way (online payment). The receipt (quote_payments, receipt number) is unchanged; the 0003 / 0110 /
--      0125 money guards still cap everything.
--   6  READ RPCs: payment_schedule_for_quote (staff, Finance view: rows with paid / part paid / due / overdue, receipts,
--      pause state, templates) and public_payment_schedule (client page by its approval token: the schedule with
--      paid / due / overdue and how to pay).
-- Changes: 4 new tables (RLS on; reads through RPCs or same-studio policies; no API-role write privilege), new
-- functions, 1 AFTER trigger on quotes (inserts milestones only when there are none), wrappers (renamed ONCE to
-- *__pre0264, bodies kept, not callable by the app): record_payment, record_settlement_payment, comms_tick,
-- comms_outbox_claim, _comms_queue_pay, notification_catalog, notification_type_of; _comms_cfg re-issued (defaults
-- only); comms_settings column DEFAULTS pay_enabled -> true and pay_max_overdue -> 1 (existing rows untouched);
-- trial retention lists patched in place. No existing row is updated or deleted by this file, no table / column /
-- policy dropped. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): update public.payment_schedule_settings set auto_apply =
--   false, overdue_bell = false (per studio), or fully: drop trigger zzz_pst_auto_schedule on public.quotes; for each
--   wrapped f: drop function public.f(...); alter function public.f__pre0264(...) rename to f; restore its grants;
--   alter table public.comms_settings alter column pay_enabled set default false, alter column pay_max_overdue set
--   default 3; re-run the 0078 _comms_cfg body. The new tables can stay (unused).

do $$ begin
  if to_regclass('public.payment_milestones') is null or to_regclass('public.quote_payments') is null then
    raise exception 'STOP 0264: payment_milestones / quote_payments are missing'; end if;
  if to_regprocedure('public.helm_invoice_total(uuid)') is null then raise exception 'STOP 0264: apply 0110 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0264: has_area / current_org_id are missing'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null or to_regprocedure('public.tg_quote_org_match()') is null then
    raise exception 'STOP 0264: apply 0004 + 0045 first'; end if;
  if to_regclass('public.comms_settings') is null or to_regclass('public.comms_outbox') is null
     or to_regprocedure('public._comms_cfg(uuid)') is null then raise exception 'STOP 0264: apply 0078 first'; end if;
  if to_regprocedure('public._comms_money(numeric,text)') is null or to_regprocedure('public._comms_date(date,uuid)') is null
     or to_regprocedure('public._comms_client_to(jsonb,text,uuid)') is null or to_regprocedure('public._comms_quote_cur(uuid)') is null then
    raise exception 'STOP 0264: apply 0092 first'; end if;
  if to_regprocedure('public.comms_outbox_claim(integer)') is null or to_regprocedure('public.comms_tick()') is null then
    raise exception 'STOP 0264: comms_outbox_claim / comms_tick are missing'; end if;
  if to_regprocedure('public.record_payment__pre0156(uuid,numeric,text,text,uuid,text,text)') is null then
    raise exception 'STOP 0264: apply 0156 first'; end if;
  if to_regprocedure('public.notification_catalog__pre0250()') is null then raise exception 'STOP 0264: apply 0250 first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'is_demo') then
    raise exception 'STOP 0264: apply 0097 first (quotes.is_demo)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_payments' and column_name = 'link_expires_at') then
    raise exception 'STOP 0264: apply 0027 first (quote_payments.link_expires_at)'; end if;
end $$;

-- ---- 1) tables -----------------------------------------------------------------------------------------------------
create table if not exists public.payment_schedule_settings (
  org_id              uuid primary key references public.organizations(id) on delete cascade,
  auto_apply          boolean not null default true,
  default_template_id uuid,
  default_builtin     text not null default '30-50-20' check (default_builtin in ('30-50-20', '50-50', '100-upfront')),
  overdue_bell        boolean not null default true,
  upi_id              text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$'),
  pay_note            text check (pay_note is null or (char_length(pay_note) <= 300 and pay_note !~ '[<>]')),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);

create table if not exists public.payment_schedule_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 80 and name !~ '[<>]'),
  lines       jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 10),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create unique index if not exists payment_schedule_templates_name_uq
  on public.payment_schedule_templates(org_id, lower(btrim(name))) where archived_at is null;
create index if not exists payment_schedule_templates_org_idx on public.payment_schedule_templates(org_id);

create table if not exists public.payment_schedule_quote_prefs (
  quote_id         uuid primary key references public.quotes(id) on delete cascade,
  org_id           uuid not null references public.organizations(id) on delete cascade,
  reminders_paused boolean not null default false,
  paused_at        timestamptz,
  paused_by        uuid,
  applied_at       timestamptz,
  applied_by       uuid,
  applied_source   text check (applied_source is null or applied_source in ('auto', 'manual')),
  applied_template text check (applied_template is null or char_length(applied_template) <= 80),
  updated_at       timestamptz not null default now()
);
create index if not exists payment_schedule_quote_prefs_org_idx on public.payment_schedule_quote_prefs(org_id);

create table if not exists public.payment_overdue_alerts (
  milestone_id uuid primary key,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  due_date     date,
  notified_at  timestamptz not null default now()
);
create index if not exists payment_overdue_alerts_org_idx on public.payment_overdue_alerts(org_id, notified_at desc);

alter table public.payment_schedule_settings enable row level security;
alter table public.payment_schedule_templates enable row level security;
alter table public.payment_schedule_quote_prefs enable row level security;
alter table public.payment_overdue_alerts enable row level security;
do $$ declare t text; begin
  foreach t in array array['payment_schedule_settings', 'payment_schedule_templates', 'payment_schedule_quote_prefs', 'payment_overdue_alerts'] loop
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    -- suspended / ended-trial studios are read-only for signed-in callers (0045 guard; cron + service role pass)
    execute format('drop trigger if exists zzz_studio_read_only on public.%I', t);
    execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
  end loop;
  foreach t in array array['payment_schedule_quote_prefs', 'payment_overdue_alerts'] loop
    execute format('drop trigger if exists zz_quote_org_match on public.%I', t);
    execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on table public.payment_schedule_settings to authenticated';
    execute 'grant select on table public.payment_schedule_templates to authenticated';
    execute 'grant select on table public.payment_schedule_quote_prefs to authenticated';
  end if;
end $$;
drop policy if exists pst_settings_read on public.payment_schedule_settings;
create policy pst_settings_read on public.payment_schedule_settings for select to authenticated
  using (org_id = (select public.current_org_id()) and (public.has_area('controls', 'view') or public.has_area('finance', 'view')));
drop policy if exists pst_templates_read on public.payment_schedule_templates;
create policy pst_templates_read on public.payment_schedule_templates for select to authenticated
  using (org_id = (select public.current_org_id()) and (public.has_area('controls', 'view') or public.has_area('finance', 'view')));
drop policy if exists pst_prefs_read on public.payment_schedule_quote_prefs;
create policy pst_prefs_read on public.payment_schedule_quote_prefs for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('finance', 'view'));

-- trial retention (0184): templates + per-event prefs + bell bookkeeping are studio records (purged with the trial's
-- data, before quotes); the studio settings row is kept like comms_settings
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''payment_schedule_quote_prefs''' in v_def) > 0 then return; end if;
  if position('''quote_payments'', ''payment_milestones'',' in v_def) = 0 then
    raise notice '0264: _tr184_purge_tables has an unexpected body - left unchanged'; return; end if;
  execute replace(v_def, '''quote_payments'', ''payment_milestones'',',
    '''quote_payments'', ''payment_milestones'', ''payment_overdue_alerts'', ''payment_schedule_quote_prefs'', ''payment_schedule_templates'',');
end $$;
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''payment_schedule_settings''' in v_def) > 0 then return; end if;
  if position('''comms_settings'', ' in v_def) = 0 then
    raise notice '0264: _tr184_keep_tables has an unexpected body - left unchanged'; return; end if;
  execute replace(v_def, '''comms_settings'', ', '''comms_settings'', ''payment_schedule_settings'', ');
end $$;

-- ---- 2) templates: built-ins, validation, the arithmetic (internal) ------------------------------------------------
create or replace function public._pst_builtins()
returns jsonb language sql immutable set search_path = '' as $$
  -- pay-schedule-0264: the three built-in templates (always available, never stored)
  select $b$[
    {"key":"builtin:30-50-20","name":"30 / 50 / 20","builtin":true,"lines":[
      {"label":"Advance (30%)","kind":"percent","value":30,"anchor":"approval","offset_days":0},
      {"label":"Second payment (50%)","kind":"percent","value":50,"anchor":"event","offset_days":-15},
      {"label":"Final balance (20%)","kind":"percent","value":20,"anchor":"event","offset_days":0}]},
    {"key":"builtin:50-50","name":"50 / 50","builtin":true,"lines":[
      {"label":"Advance (50%)","kind":"percent","value":50,"anchor":"approval","offset_days":0},
      {"label":"Balance (50%)","kind":"percent","value":50,"anchor":"event","offset_days":-7}]},
    {"key":"builtin:100-upfront","name":"100% upfront","builtin":true,"lines":[
      {"label":"Full payment (100%)","kind":"percent","value":100,"anchor":"approval","offset_days":0}]}
  ]$b$::jsonb;
$$;

-- one template's payments, checked + normalised; raises 22023 in plain words
create or replace function public._pst_lines_clean(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare e jsonb; i integer := 0; v_out jsonb := '[]'::jsonb; v_pct numeric := 0; v_bal integer := 0; v_fixed integer := 0;
  v_label text; v_kind text; v_val numeric; v_anchor text; v_off integer; v_raw text;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 then
    raise exception 'Add at least one payment to the schedule.' using errcode = '22023'; end if;
  if jsonb_array_length(p) > 10 then raise exception 'A schedule can have at most 10 payments.' using errcode = '22023'; end if;
  for e in select x from jsonb_array_elements(p) with ordinality t(x, n) order by n loop
    i := i + 1;
    if jsonb_typeof(e) <> 'object' then raise exception 'Payment %: not a valid payment.', i using errcode = '22023'; end if;
    v_label := btrim(coalesce(e ->> 'label', ''));
    if char_length(v_label) not between 1 and 80 or v_label ~ '[<>[:cntrl:]]' then
      raise exception 'Payment %: enter a name of up to 80 characters (no < or >).', i using errcode = '22023'; end if;
    v_kind := coalesce(nullif(btrim(coalesce(e ->> 'kind', '')), ''), 'percent');
    if v_kind not in ('percent', 'fixed', 'balance') then
      raise exception 'Payment %: choose percent, fixed amount or balance.', i using errcode = '22023'; end if;
    v_val := null;
    if v_kind <> 'balance' then
      v_raw := btrim(coalesce(e ->> 'value', ''));
      if v_raw !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then
        raise exception 'Payment %: enter the amount as a number (up to 2 decimals).', i using errcode = '22023'; end if;
      v_val := v_raw::numeric;
      if v_kind = 'percent' and (v_val <= 0 or v_val > 100) then
        raise exception 'Payment %: the percentage must be more than 0 and at most 100.', i using errcode = '22023'; end if;
      if v_kind = 'fixed' and v_val <= 0 then
        raise exception 'Payment %: the amount must be more than 0.', i using errcode = '22023'; end if;
    end if;
    v_anchor := coalesce(nullif(btrim(coalesce(e ->> 'anchor', '')), ''), 'approval');
    if v_anchor not in ('approval', 'event') then
      raise exception 'Payment %: the due date counts from the approval or from the event day.', i using errcode = '22023'; end if;
    v_raw := btrim(coalesce(e ->> 'offset_days', '0'));
    if v_raw !~ '^-?[0-9]{1,3}$' or abs(v_raw::integer) > 365 then
      raise exception 'Payment %: days must be a whole number from -365 to 365.', i using errcode = '22023'; end if;
    v_off := v_raw::integer;
    if v_anchor = 'approval' and v_off < 0 then
      raise exception 'Payment %: a payment can''t be due before the approval.', i using errcode = '22023'; end if;
    if v_kind = 'percent' then v_pct := v_pct + v_val; elsif v_kind = 'fixed' then v_fixed := v_fixed + 1; else v_bal := v_bal + 1; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('label', v_label, 'kind', v_kind, 'value', v_val,
                                                           'anchor', v_anchor, 'offset_days', v_off));
  end loop;
  if v_bal > 1 then raise exception 'Use at most one "Balance" payment.' using errcode = '22023'; end if;
  if v_pct > 100.001 then raise exception 'The percentages add up to more than 100%%.' using errcode = '22023'; end if;
  if v_bal = 0 and (v_fixed > 0 or abs(v_pct - 100) > 0.001) then
    raise exception 'The payments must add up to 100%% - or add a "Balance" payment that takes whatever is left.' using errcode = '22023'; end if;
  return v_out;
end $$;

-- the schedule for a total: [{seq, label, amount, due_date}] (zero rows dropped). Whole units; the Balance line (or,
-- without one, the last line) takes the remainder so the rows add up to the total exactly. Never more than the total.
create or replace function public._pst_compute(p_lines jsonb, p_total numeric, p_from date, p_event date)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare e jsonb; n bigint; v_rows jsonb := '[]'::jsonb; v_run numeric := 0; v_amt numeric; v_due date; v_bal integer; v_last integer := -1;
  v_left numeric;
begin
  if p_total is null or p_total <= 0 or p_lines is null or jsonb_typeof(p_lines) <> 'array' then return '[]'::jsonb; end if;
  for e, n in select x, t.n from jsonb_array_elements(p_lines) with ordinality t(x, n) order by t.n loop
    v_due := case when e ->> 'anchor' = 'event' then case when p_event is null then null else p_event + coalesce((e ->> 'offset_days')::integer, 0) end
                  else p_from + coalesce((e ->> 'offset_days')::integer, 0) end;
    if v_due is not null and p_from is not null and v_due < p_from then v_due := p_from; end if;
    v_left := greatest(p_total - v_run, 0);
    v_amt := case e ->> 'kind'
      when 'balance' then null
      when 'fixed' then least(round((e ->> 'value')::numeric, 2), v_left)
      else least(round(p_total * (e ->> 'value')::numeric / 100), v_left) end;
    if e ->> 'kind' = 'balance' then v_bal := (n - 1)::integer; end if;
    v_run := v_run + coalesce(v_amt, 0);
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('seq', n, 'label', e ->> 'label', 'amount', v_amt, 'due_date', v_due));
    v_last := (n - 1)::integer;
  end loop;
  if v_last < 0 then return '[]'::jsonb; end if;
  if v_bal is not null then
    v_rows := jsonb_set(v_rows, array[v_bal::text, 'amount'], to_jsonb(round(greatest(p_total - v_run, 0), 2)));
  elsif abs(p_total - v_run) > 0 then
    v_rows := jsonb_set(v_rows, array[v_last::text, 'amount'],
                        to_jsonb(round(greatest(coalesce((v_rows -> v_last ->> 'amount')::numeric, 0) + (p_total - v_run), 0), 2)));
  end if;
  return coalesce((select jsonb_agg(r order by (r ->> 'seq')::integer) from jsonb_array_elements(v_rows) r
                    where coalesce((r ->> 'amount')::numeric, 0) > 0), '[]'::jsonb);
end $$;

-- the studio's calendar day (IST unless the studio says otherwise)
create or replace function public._pst_today(p_org uuid)
returns date language plpgsql stable security definer set search_path = '' as $$
declare v_tz text;
begin
  select coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = p_org;
  return (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;
exception when others then return (now() at time zone 'Asia/Kolkata')::date;
end $$;

-- a template by key ('builtin:<k>' or a studio template id); null key = the studio default. -> {key, name, lines} | null
create or replace function public._pst_resolve(p_org uuid, p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.payment_schedule_settings; t public.payment_schedule_templates; v_key text := nullif(btrim(coalesce(p_key, '')), '');
begin
  if v_key is null then
    select * into s from public.payment_schedule_settings x where x.org_id = p_org;
    if s.default_template_id is not null then
      select * into t from public.payment_schedule_templates x where x.id = s.default_template_id and x.org_id = p_org and x.archived_at is null;
      if t.id is not null then return jsonb_build_object('key', t.id::text, 'name', t.name, 'lines', t.lines); end if;
    end if;
    v_key := 'builtin:' || coalesce(s.default_builtin, '30-50-20');
  end if;
  if v_key like 'builtin:%' then
    return (select b - 'builtin' from jsonb_array_elements(public._pst_builtins()) b where b ->> 'key' = v_key limit 1);
  end if;
  if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  select * into t from public.payment_schedule_templates x where x.id = v_key::uuid and x.org_id = p_org and x.archived_at is null;
  if t.id is null then return null; end if;
  return jsonb_build_object('key', t.id::text, 'name', t.name, 'lines', t.lines);
end $$;

-- write the schedule for an event that has none. -> {applied, reason?, rows, template}. Never touches existing rows.
create or replace function public._pst_apply(p_quote uuid, p_key text, p_source text, p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare q public.quotes; v_t jsonb; v_rows jsonb; r jsonb; v_total numeric; v_n integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  select * into q from public.quotes x where x.id = p_quote;
  if q.id is null then return jsonb_build_object('applied', false, 'reason', 'no_event'); end if;
  if exists (select 1 from public.payment_milestones m where m.quote_id = q.id) then
    return jsonb_build_object('applied', false, 'reason', 'has_schedule'); end if;
  v_total := public.helm_invoice_total(q.id);
  if v_total is null or v_total <= 0 then return jsonb_build_object('applied', false, 'reason', 'no_total'); end if;
  v_t := public._pst_resolve(q.org_id, p_key);
  if v_t is null then return jsonb_build_object('applied', false, 'reason', 'no_template'); end if;
  v_rows := public._pst_compute(v_t -> 'lines', v_total, public._pst_today(q.org_id), q.event_date);
  if jsonb_array_length(v_rows) = 0 then return jsonb_build_object('applied', false, 'reason', 'no_rows'); end if;
  for r in select x from jsonb_array_elements(v_rows) x loop
    insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, seq, note, created_by)
      values (q.id, q.org_id, r ->> 'label', (r ->> 'due_date')::date, (r ->> 'amount')::numeric, 'due', (r ->> 'seq')::integer,
              left('Payment schedule: ' || coalesce(v_t ->> 'name', 'template'), 200), p_actor);
    v_n := v_n + 1;
  end loop;
  insert into public.payment_schedule_quote_prefs(quote_id, org_id, applied_at, applied_by, applied_source, applied_template)
    values (q.id, q.org_id, now(), p_actor, p_source, left(v_t ->> 'name', 80))
    on conflict (quote_id) do update set applied_at = excluded.applied_at, applied_by = excluded.applied_by,
      applied_source = excluded.applied_source, applied_template = excluded.applied_template, updated_at = now();
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (p_actor, 'payment_schedule.applied', 'quotes', q.id::text, q.id,
            jsonb_build_object('template', v_t ->> 'name', 'source', p_source, 'rows', v_n, 'total', v_total), q.org_id);
  return jsonb_build_object('applied', true, 'rows', v_n, 'template', v_t ->> 'name', 'schedule', v_rows);
end $$;

-- ---- 3) applied automatically on approval / confirmation -------------------------------------------------------------
create or replace function public._pst_tg_quote_approved()
returns trigger language plpgsql security definer set search_path = '' as $$
-- pay-schedule-0264: never blocks the approval - any problem is a warning and the schedule is skipped
declare v_on boolean;
begin
  begin
    if not ((coalesce(new.approval_status, '') in ('approved', 'paid') and coalesce(old.approval_status, '') not in ('approved', 'paid'))
            or (coalesce(new.status, '') = 'confirmed' and coalesce(old.status, '') <> 'confirmed')) then return null; end if;
    if coalesce(new.is_demo, false) or new.deleted_at is not null or new.archived_at is not null
       or coalesce(new.status, '') = 'cancelled' then return null; end if;
    select coalesce((select s.auto_apply from public.payment_schedule_settings s where s.org_id = new.org_id), true) into v_on;
    if not v_on then return null; end if;
    if exists (select 1 from public.payment_milestones m where m.quote_id = new.id) then return null; end if;
    perform public._pst_apply(new.id, null, 'auto', auth.uid());
  exception when others then raise warning 'pay-schedule-0264: automatic schedule skipped (% %)', sqlstate, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists zzz_pst_auto_schedule on public.quotes;
create trigger zzz_pst_auto_schedule after update of approval_status, status on public.quotes
  for each row execute function public._pst_tg_quote_approved();

-- ---- 4) money received covers milestones (schedule order, fully covered only) ----------------------------------------
create or replace function public._pst_allocate(p_quote uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_credit numeric; m record; v_n integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  select coalesce(sum(qp.amount), 0) into v_credit from public.quote_payments qp where qp.quote_id = p_quote and qp.status = 'paid';
  v_credit := v_credit - coalesce((select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = p_quote and pm.status = 'paid'), 0);
  if v_credit <= 0.005 then return 0; end if;
  for m in select pm.id, pm.amount from public.payment_milestones pm
            where pm.quote_id = p_quote and pm.status in ('due', 'invoiced') and coalesce(pm.amount, 0) > 0
            order by pm.due_date nulls last, pm.seq, pm.created_at, pm.id
  loop
    exit when v_credit + 0.005 < m.amount;          -- in order: the first one not fully covered stays open (part paid)
    update public.payment_milestones set status = 'paid', paid_at = now() where id = m.id;
    v_credit := v_credit - m.amount; v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

do $$ begin
  if to_regprocedure('public.record_payment__pre0264(uuid,numeric,text,text,uuid,text,text)') is null then
    alter function public.record_payment(uuid, numeric, text, text, uuid, text, text) rename to record_payment__pre0264;
  end if;
  if to_regprocedure('public.record_settlement_payment__pre0264(uuid,numeric,text,text,uuid,text,text)') is null then
    alter function public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text) rename to record_settlement_payment__pre0264;
  end if;
end $$;
create or replace function public.record_payment(p_quote uuid, p_amount numeric, p_method text default 'cash', p_receipt_no text default null,
                                                 p_milestone uuid default null, p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- pay-schedule-0264: the receipt row is written to quote_payments by record_payment__pre0264 (ledger + caps unchanged),
-- then every milestone the money now fully covers is paid
declare v_out jsonb; v_n integer := 0;
begin
  v_out := public.record_payment__pre0264(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
  if not coalesce((v_out ->> 'idempotent_replay')::boolean, false) then
    begin v_n := public._pst_allocate(p_quote);
    exception when others then v_n := 0; raise warning 'pay-schedule-0264: milestone cover skipped (%)', sqlstate;
    end;
    if v_n > 0 then v_out := v_out || jsonb_build_object('milestones_covered', v_n); end if;
  end if;
  return v_out;
end $$;
create or replace function public.record_settlement_payment(p_quote uuid, p_amount numeric, p_method text default 'cash', p_receipt_no text default null,
                                                            p_milestone uuid default null, p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- pay-schedule-0264: the receipt row is written to quote_payments by record_settlement_payment__pre0264 (ledger + caps
-- unchanged), then every milestone the money now fully covers is paid
declare v_out jsonb; v_n integer := 0;
begin
  v_out := public.record_settlement_payment__pre0264(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
  if not coalesce((v_out ->> 'idempotent_replay')::boolean, false) then
    begin v_n := public._pst_allocate(p_quote);
    exception when others then v_n := 0; raise warning 'pay-schedule-0264: milestone cover skipped (%)', sqlstate;
    end;
    if v_n > 0 then v_out := v_out || jsonb_build_object('milestones_covered', v_n); end if;
  end if;
  return v_out;
end $$;

-- ---- 5) reminders: on by default, paused per event, with pay details ------------------------------------------------
-- column DEFAULTS only (a row saved from now on starts with reminders on, -3 / 0 / +3); existing rows are not changed
alter table public.comms_settings alter column pay_enabled set default true;
alter table public.comms_settings alter column pay_max_overdue set default 1;

-- the 0078 body with the new defaults for a studio that never saved its settings (pay reminders on, one overdue step)
create or replace function public._comms_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- pay-schedule-0264: payment reminders default ON (3 days before, on the day, 3 days after)
  select jsonb_build_object(
    'pay_enabled', coalesce(s.pay_enabled, true),
    'pay_channels', to_jsonb(coalesce(s.pay_channels, array['email']::text[])),
    'pay_before_days', coalesce(s.pay_before_days, 3),
    'pay_on_due', coalesce(s.pay_on_due, true),
    'pay_every_days', coalesce(s.pay_every_days, 3),
    'pay_max_overdue', coalesce(s.pay_max_overdue, 1),
    'pay_template', coalesce(s.pay_template, public._comms_default_pay_template()),
    'fu_enabled', coalesce(s.fu_enabled, false),
    'fu_channels', to_jsonb(coalesce(s.fu_channels, array['email']::text[])),
    'fu_delay_days', coalesce(s.fu_delay_days, 3),
    'fu_max', coalesce(s.fu_max, 2),
    'fu_template', coalesce(s.fu_template, public._comms_default_fu_template()),
    'low_stock_enabled', coalesce(s.low_stock_enabled, true),
    'wa_forward_enabled', coalesce(s.wa_forward_enabled, false),
    'wa_forward_roles', coalesce(s.wa_forward_roles, '{}'::jsonb),
    'studio_whatsapp', s.studio_whatsapp,
    'updated_at', s.updated_at)
  from (select 1) one left join public.comms_settings s on s.org_id = p_org;
$$;

-- how the client can pay: the open LIVE online link (never a simulated one), the studio UPI ID and note
create or replace function public._pst_pay_details(p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'link', (select qp.link_url from public.quote_payments qp
              where qp.quote_id = q.id and qp.status = 'created' and not coalesce(qp.simulated, true)
                and coalesce(qp.link_url, '') ~ '^https://[^\s<>"]+$' and char_length(qp.link_url) <= 500
                and (qp.link_expires_at is null or qp.link_expires_at > now())
              order by qp.created_at desc limit 1),
    'upi', s.upi_id, 'note', s.pay_note)
  from public.quotes q left join public.payment_schedule_settings s on s.org_id = q.org_id
  where q.id = p_quote;
$$;
create or replace function public._pst_pay_text(p jsonb)
returns text language sql immutable set search_path = '' as $$
  select nullif(concat_ws(' | ',
    case when nullif(p ->> 'link', '') is not null then 'Pay online: ' || (p ->> 'link') end,
    case when nullif(p ->> 'upi', '') is not null then 'UPI: ' || (p ->> 'upi') end,
    nullif(btrim(coalesce(p ->> 'note', '')), '')), '');
$$;

do $$ begin
  if to_regprocedure('public._comms_queue_pay__pre0264(uuid,text,text,boolean,uuid)') is null then
    alter function public._comms_queue_pay(uuid, text, text, boolean, uuid) rename to _comms_queue_pay__pre0264;
  end if;
end $$;
-- the 0092 body + (a) a paused event gets no AUTOMATIC reminder ("Send reminder now" still works) and (b) the pay
-- details: {pay_link} {upi} {pay_details} placeholders, appended when the template has none of them
create or replace function public._comms_queue_pay(p_milestone uuid, p_stage text, p_status_text text, p_manual boolean, p_actor uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- pay-schedule-0264
declare m public.payment_milestones; q public.quotes; v_cfg jsonb; ch text; v_to text; v_text text; v_n integer := 0; v_rows integer;
  v_studio text; v_key text; v_pay jsonb; v_pay_text text; v_tpl text;
begin
  select * into m from public.payment_milestones x where x.id = p_milestone;
  if m.id is null or m.status not in ('due', 'invoiced') or coalesce(m.amount, 0) <= 0 then return 0; end if;
  select * into q from public.quotes x where x.id = m.quote_id;
  if q.id is null or q.org_id is distinct from m.org_id or not public._comms_quote_live(q.id) then return 0; end if;
  if not coalesce(p_manual, false) and exists (select 1 from public.payment_schedule_quote_prefs p
                                                where p.quote_id = q.id and p.reminders_paused) then return 0; end if;
  v_cfg := public._comms_cfg(q.org_id);
  select o.name into v_studio from public.organizations o where o.id = q.org_id;
  v_pay := public._pst_pay_details(q.id);
  v_pay_text := public._pst_pay_text(v_pay);
  v_tpl := v_cfg ->> 'pay_template';
  if v_pay_text is not null and position('{pay_details}' in v_tpl) = 0 and position('{pay_link}' in v_tpl) = 0
     and position('{upi}' in v_tpl) = 0 then v_tpl := v_tpl || ' {pay_details}'; end if;
  v_text := public._comms_render(v_tpl, jsonb_build_object(
    'client', coalesce(nullif(btrim(q.client ->> 'name'), ''), 'there'), 'studio', coalesce(v_studio, 'your planner'),
    'event', coalesce(nullif(btrim(q.title), ''), 'your event'), 'label', m.label, 'amount', public._comms_money(m.amount, public._comms_quote_cur(q.id)),
    'due', coalesce(public._comms_date(m.due_date, q.org_id), 'soon'), 'status', p_status_text,
    'pay_link', coalesce(v_pay ->> 'link', ''), 'upi', coalesce(v_pay ->> 'upi', ''), 'pay_details', coalesce(v_pay_text, '')));
  foreach ch in array public._comms_channels(v_cfg, 'pay_channels') loop
    v_to := public._comms_client_to(q.client, ch, q.org_id);
    if v_to is null then continue; end if;
    v_key := case when p_manual then 'pay:now:' || m.id || ':' || ch || ':' || floor(extract(epoch from now()) / 600)::bigint
                  else 'pay:' || m.id || ':' || p_stage || ':' || ch end;
    insert into public.comms_outbox(org_id, quote_id, milestone_id, purpose, channel, recipient, payload, dedupe_key, created_by)
      values (q.org_id, q.id, m.id, 'pay_reminder', ch, v_to,
              jsonb_build_object('subject', 'Payment reminder - ' || coalesce(nullif(btrim(q.title), ''), 'your event'),
                                 'text', v_text, 'stage', p_stage, 'manual', p_manual, 'studio', v_studio,
                                 'pay_link', v_pay ->> 'link'),
              v_key, p_actor)
      on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  return v_n;
end $$;

do $$ begin
  if to_regprocedure('public.comms_outbox_claim__pre0264(integer)') is null then
    alter function public.comms_outbox_claim(integer) rename to comms_outbox_claim__pre0264;
  end if;
end $$;
-- a paused event: automatic reminders still waiting are skipped (never sent); then the claim as before
create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- pay-schedule-0264
begin
  update public.comms_outbox c set status = 'skipped', sent_at = now()
   where c.sent_at is null and c.status = 'pending' and c.purpose = 'pay_reminder'
     and not coalesce((c.payload ->> 'manual')::boolean, false)
     and exists (select 1 from public.payment_schedule_quote_prefs p where p.quote_id = c.quote_id and p.reminders_paused);
  return public.comms_outbox_claim__pre0264(p_limit);
end $$;

-- ---- 6) notification type: client payment overdue (money: admins + Finance viewers by default) ---------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[['notification_catalog', ''], ['notification_type_of', 'text, text']] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0264', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0264');
    end if;
  end loop;
end $$;
create or replace function public.notification_catalog()
returns jsonb language sql immutable security definer set search_path = '' as $$
  -- pay-schedule-0264: + payment_overdue (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'payment_overdue') then c
    else c || $cat$[
    {"type":"payment_overdue","group":"Finance","label":"Client payment overdue",
     "description":"A client's scheduled payment is past its due date and not fully paid yet (one notice per payment, the day after it was due).",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":true}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0264() as c) x;
$$;
create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $$
  -- pay-schedule-0264
  select case when lower(btrim(coalesce(p_kind, ''))) = 'payment_overdue' then 'payment_overdue'
              else public.notification_type_of__pre0264(p_kind, p_channel) end;
$$;

-- ---- 7) the scheduler: comms_tick + overdue bell + money-in covers milestones -------------------------------------
create or replace function public._pst_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare o record; v_today date; m record; r record; v_bells integer := 0; v_cov integer := 0; v_rows integer; v_bell boolean;
begin
  for o in select org.id from public.organizations org loop
    begin
      v_today := public._pst_today(o.id);
      -- money that came in another way (online payment, settlement) covers milestones too
      for r in select q.id from public.quotes q
                where q.org_id = o.id and q.deleted_at is null
                  and exists (select 1 from public.payment_milestones pm where pm.quote_id = q.id and pm.status in ('due', 'invoiced') and pm.amount > 0)
                  and coalesce((select sum(qp.amount) from public.quote_payments qp where qp.quote_id = q.id and qp.status = 'paid'), 0)
                      - coalesce((select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = q.id and pm.status = 'paid'), 0) > 0.005
      loop
        begin v_cov := v_cov + public._pst_allocate(r.id);
        exception when others then raise warning 'pay-schedule-0264: cover skipped (%)', sqlstate;
        end;
      end loop;
      select coalesce((select s.overdue_bell from public.payment_schedule_settings s where s.org_id = o.id), true) into v_bell;
      if v_bell then
        for m in select pm.id, pm.quote_id, pm.label, pm.due_date, q.code
                   from public.payment_milestones pm join public.quotes q on q.id = pm.quote_id
                  where pm.org_id = o.id and q.org_id = o.id and pm.status in ('due', 'invoiced') and coalesce(pm.amount, 0) > 0
                    and pm.due_date between v_today - 30 and v_today - 1
                    and not coalesce(q.is_demo, false) and public._comms_quote_live(q.id)
                    and not exists (select 1 from public.payment_overdue_alerts a where a.milestone_id = pm.id)
        loop
          insert into public.payment_overdue_alerts(milestone_id, org_id, quote_id, due_date)
            values (m.id, o.id, m.quote_id, m.due_date) on conflict (milestone_id) do nothing;
          get diagnostics v_rows = row_count;
          if v_rows > 0 then
            insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
              values (m.quote_id, 'in_app', 'payment_overdue', 'simulated',
                      jsonb_build_object('label', left('Payment overdue: ' || coalesce(m.label, 'payment')
                                           || coalesce(' - ' || m.code, ''), 200),
                                         'via', 'comms', 'source', '0264', 'milestone_id', m.id, 'event_code', m.code,
                                         'due_date', m.due_date, 'days', v_today - m.due_date,
                                         'path', 'logistics.html?quote=' || m.quote_id::text || '#payments'), o.id);
            v_bells := v_bells + 1;
          end if;
        end loop;
      end if;
    exception when others then raise warning 'pay-schedule-0264: studio tick skipped (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('overdue_bells', v_bells, 'milestones_covered', v_cov);
end $$;

do $$ begin
  if to_regprocedure('public.comms_tick__pre0264()') is null then
    alter function public.comms_tick() rename to comms_tick__pre0264;
  end if;
end $$;
-- the same pg_cron job (helm_comms_tick, every 15 minutes) runs this: the 0078 / 0092 tick, then the 0264 steps
create or replace function public.comms_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- pay-schedule-0264
declare v jsonb; v2 jsonb;
begin
  v := public.comms_tick__pre0264();
  begin v2 := public._pst_tick();
  exception when others then v2 := jsonb_build_object('pay_schedule_error', sqlstate);
  end;
  return coalesce(v, '{}'::jsonb) || coalesce(v2, '{}'::jsonb);
end $$;

-- ---- 8) RPCs for the app ----------------------------------------------------------------------------------------------
-- Control Center: read (Control Center or Finance VIEW)
create or replace function public.payment_schedule_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.payment_schedule_settings; v_cfg jsonb;
begin
  if auth.uid() is null or v_org is null or not (public.has_area('controls', 'view') or public.has_area('finance', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into s from public.payment_schedule_settings x where x.org_id = v_org;
  v_cfg := public._comms_cfg(v_org);
  return jsonb_build_object(
    'auto_apply', coalesce(s.auto_apply, true),
    'overdue_bell', coalesce(s.overdue_bell, true),
    'default_template', coalesce((select t.id::text from public.payment_schedule_templates t
                                   where t.id = s.default_template_id and t.org_id = v_org and t.archived_at is null),
                                 'builtin:' || coalesce(s.default_builtin, '30-50-20')),
    'upi_id', s.upi_id, 'pay_note', s.pay_note, 'updated_at', s.updated_at,
    'can_edit', public.has_area('controls', 'edit'),
    'builtins', public._pst_builtins(),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('key', t.id::text, 'id', t.id, 'name', t.name, 'lines', t.lines,
                                                               'updated_at', t.updated_at) order by lower(t.name))
                             from public.payment_schedule_templates t where t.org_id = v_org and t.archived_at is null), '[]'::jsonb),
    'reminders', jsonb_build_object('enabled', (v_cfg ->> 'pay_enabled')::boolean, 'channels', v_cfg -> 'pay_channels',
      'before_days', (v_cfg ->> 'pay_before_days')::integer, 'on_due', (v_cfg ->> 'pay_on_due')::boolean,
      'every_days', (v_cfg ->> 'pay_every_days')::integer, 'max_overdue', (v_cfg ->> 'pay_max_overdue')::integer,
      'saved', v_cfg ->> 'updated_at' is not null));
end $$;

-- Control Center: write (Control Center EDIT). Only the keys given change.
create or replace function public.payment_schedule_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); k text; v_def text; v_tid uuid; v_builtin text;
  v_upi text; v_note text;
begin
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('auto_apply', 'overdue_bell', 'default_template', 'upi_id', 'pay_note') then
      raise exception 'unknown setting %', k using errcode = '22023'; end if;
  end loop;
  foreach k in array array['auto_apply', 'overdue_bell'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'boolean' then raise exception '% must be true or false', k using errcode = '22023'; end if;
  end loop;
  if p ? 'default_template' then
    v_def := btrim(coalesce(p ->> 'default_template', ''));
    if v_def like 'builtin:%' then
      v_builtin := substr(v_def, 9);
      if v_builtin not in ('30-50-20', '50-50', '100-upfront') then raise exception 'Choose one of the payment schedules.' using errcode = '22023'; end if;
    elsif v_def ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and exists (select 1 from public.payment_schedule_templates t where t.id = v_def::uuid and t.org_id = v_org and t.archived_at is null) then
      v_tid := v_def::uuid;
    else raise exception 'Choose one of the payment schedules.' using errcode = '22023'; end if;
  end if;
  if p ? 'upi_id' then
    if jsonb_typeof(p -> 'upi_id') not in ('string', 'null') then raise exception 'upi_id must be text' using errcode = '22023'; end if;
    v_upi := nullif(btrim(coalesce(p ->> 'upi_id', '')), '');
    if v_upi is not null and v_upi !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$' then
      raise exception 'Enter a UPI ID like studio@okbank.' using errcode = '22023'; end if;
  end if;
  if p ? 'pay_note' then
    if jsonb_typeof(p -> 'pay_note') not in ('string', 'null') then raise exception 'pay_note must be text' using errcode = '22023'; end if;
    v_note := nullif(btrim(regexp_replace(coalesce(p ->> 'pay_note', ''), '\s+', ' ', 'g')), '');
    if v_note is not null and (char_length(v_note) > 300 or v_note ~ '[<>]') then
      raise exception 'Keep the payment note to 300 characters, without < or >.' using errcode = '22023'; end if;
  end if;
  insert into public.payment_schedule_settings(org_id) values (v_org) on conflict (org_id) do nothing;
  update public.payment_schedule_settings s set
    auto_apply   = case when p ? 'auto_apply' then (p ->> 'auto_apply')::boolean else s.auto_apply end,
    overdue_bell = case when p ? 'overdue_bell' then (p ->> 'overdue_bell')::boolean else s.overdue_bell end,
    default_template_id = case when p ? 'default_template' then v_tid else s.default_template_id end,
    default_builtin = case when p ? 'default_template' and v_builtin is not null then v_builtin else s.default_builtin end,
    upi_id   = case when p ? 'upi_id' then v_upi else s.upi_id end,
    pay_note = case when p ? 'pay_note' then v_note else s.pay_note end,
    updated_at = now(), updated_by = v_me
   where s.org_id = v_org;
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (v_me, 'payment_schedule.settings', 'payment_schedule_settings', v_org::text, p, v_org);
  return public.payment_schedule_settings_get();
end $$;

-- Control Center: add / change a studio template (Control Center EDIT)
create or replace function public.payment_schedule_template_save(p_id uuid, p_name text, p_lines jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_name text := btrim(coalesce(p_name, ''));
  v_lines jsonb; t public.payment_schedule_templates;
begin
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if char_length(v_name) not between 1 and 80 or v_name ~ '[<>[:cntrl:]]' then
    raise exception 'Give the schedule a name of up to 80 characters (no < or >).' using errcode = '22023'; end if;
  v_lines := public._pst_lines_clean(p_lines);
  begin
    if p_id is null then
      if (select count(*) from public.payment_schedule_templates x where x.org_id = v_org and x.archived_at is null) >= 30 then
        raise exception 'A studio can keep up to 30 payment schedules - archive one first.' using errcode = '22023'; end if;
      insert into public.payment_schedule_templates(org_id, name, lines, created_by, updated_by)
        values (v_org, v_name, v_lines, v_me, v_me) returning * into t;
    else
      update public.payment_schedule_templates x set name = v_name, lines = v_lines, updated_at = now(), updated_by = v_me
       where x.id = p_id and x.org_id = v_org and x.archived_at is null returning * into t;
      if t.id is null then raise exception 'payment schedule not found' using errcode = '42501'; end if;
    end if;
  exception when unique_violation then
    raise exception 'There is already a payment schedule called "%".', v_name using errcode = '22023';
  end;
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (v_me, case when p_id is null then 'payment_schedule.template_added' else 'payment_schedule.template_changed' end,
            'payment_schedule_templates', t.id::text, jsonb_build_object('name', t.name, 'lines', t.lines), v_org);
  return jsonb_build_object('key', t.id::text, 'id', t.id, 'name', t.name, 'lines', t.lines, 'updated_at', t.updated_at);
end $$;

-- Control Center: archive (never delete) a studio template; the default falls back to the built-in one
create or replace function public.payment_schedule_template_archive(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_name text;
begin
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  update public.payment_schedule_templates x set archived_at = now(), updated_at = now(), updated_by = v_me
   where x.id = p_id and x.org_id = v_org and x.archived_at is null returning x.name into v_name;
  if v_name is null then raise exception 'payment schedule not found' using errcode = '42501'; end if;
  update public.payment_schedule_settings s set default_template_id = null, updated_at = now(), updated_by = v_me
   where s.org_id = v_org and s.default_template_id = p_id;
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (v_me, 'payment_schedule.template_archived', 'payment_schedule_templates', p_id::text, jsonb_build_object('name', v_name), v_org);
  return jsonb_build_object('archived', true, 'name', v_name);
end $$;

-- one event's schedule (Finance VIEW, own studio): rows with paid / part paid / due / overdue, receipts, pause, templates
create or replace function public.payment_schedule_for_quote(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); q public.quotes; v_today date; v_paid numeric; v_left numeric; v_total numeric;
  m record; v_rows jsonb := '[]'::jsonb; v_take numeric; v_rem numeric; v_state text; pr public.payment_schedule_quote_prefs;
  v_cfg jsonb; v_next jsonb; v_sched numeric := 0;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'event not found' using errcode = '42501'; end if;
  if not public.has_area('finance', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  v_today := public._pst_today(v_org);
  v_total := public.helm_invoice_total(q.id);
  select coalesce(sum(qp.amount), 0) into v_paid from public.quote_payments qp where qp.quote_id = q.id and qp.status = 'paid';
  v_left := greatest(v_paid - coalesce((select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = q.id and pm.status = 'paid'), 0), 0);
  for m in select pm.* from public.payment_milestones pm where pm.quote_id = q.id
            order by pm.due_date nulls last, pm.seq, pm.created_at, pm.id loop
    if m.status <> 'waived' then v_sched := v_sched + coalesce(m.amount, 0); end if;
    if m.status = 'paid' then v_take := coalesce(m.amount, 0); v_rem := 0; v_state := 'paid';
    elsif m.status = 'waived' then v_take := 0; v_rem := 0; v_state := 'waived';
    else
      v_take := least(greatest(coalesce(m.amount, 0), 0), v_left); v_left := v_left - v_take;
      v_rem := round(greatest(coalesce(m.amount, 0), 0) - v_take, 2);
      v_state := case when coalesce(m.amount, 0) > 0 and v_rem <= 0.005 then 'paid'
                      when m.due_date is not null and m.due_date < v_today then 'overdue'
                      when v_take > 0.005 then 'part_paid'
                      else m.status end;
    end if;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('id', m.id, 'seq', m.seq, 'label', m.label, 'due_date', m.due_date,
      'amount', m.amount, 'status', m.status, 'state', v_state, 'paid', round(v_take, 2), 'remaining', v_rem,
      'days', case when m.due_date is not null then m.due_date - v_today end, 'paid_at', m.paid_at));
    if v_next is null and v_state in ('due', 'invoiced', 'overdue', 'part_paid') then
      v_next := jsonb_build_object('id', m.id, 'label', m.label, 'due_date', m.due_date, 'remaining', v_rem, 'state', v_state);
    end if;
  end loop;
  select * into pr from public.payment_schedule_quote_prefs x where x.quote_id = q.id;
  v_cfg := public._comms_cfg(v_org);
  return jsonb_build_object(
    'quote_id', q.id, 'code', q.code, 'currency', coalesce(public._comms_quote_cur(q.id), 'INR'),
    'event_date', q.event_date, 'today', v_today,
    'total', round(v_total, 2), 'paid', round(v_paid, 2), 'scheduled', round(v_sched, 2),
    'outstanding', round(greatest(greatest(v_total, v_sched) - v_paid, 0), 2),
    'rows', v_rows, 'next', v_next,
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('receipt_no', qp.receipt_no, 'amount', qp.amount, 'method', qp.method,
                                                              'paid_at', coalesce(qp.paid_at, qp.created_at)) order by coalesce(qp.paid_at, qp.created_at))
                            from public.quote_payments qp where qp.quote_id = q.id and qp.status = 'paid'), '[]'::jsonb),
    'paused', coalesce(pr.reminders_paused, false), 'paused_at', pr.paused_at,
    'applied', case when pr.applied_at is not null then jsonb_build_object('at', pr.applied_at, 'source', pr.applied_source, 'template', pr.applied_template) end,
    'reminders', jsonb_build_object('enabled', (v_cfg ->> 'pay_enabled')::boolean,
      'before_days', (v_cfg ->> 'pay_before_days')::integer, 'on_due', (v_cfg ->> 'pay_on_due')::boolean,
      'every_days', (v_cfg ->> 'pay_every_days')::integer, 'max_overdue', (v_cfg ->> 'pay_max_overdue')::integer,
      'client_reachable', exists (select 1 from unnest(public._comms_channels(v_cfg, 'pay_channels')) c
                                   where public._comms_client_to(q.client, c, v_org) is not null)),
    'can_edit', public.has_area('finance', 'edit'),
    'can_pause', public.has_area('finance', 'edit') or public.has_area('quotes', 'edit'),
    'default_template', (public._pst_resolve(v_org, null)) ->> 'key',
    'templates', (select coalesce(jsonb_agg(jsonb_build_object('key', b ->> 'key', 'name', b ->> 'name')), '[]'::jsonb)
                    from jsonb_array_elements(public._pst_builtins()) b)
                 || coalesce((select jsonb_agg(jsonb_build_object('key', t.id::text, 'name', t.name) order by lower(t.name))
                                from public.payment_schedule_templates t where t.org_id = v_org and t.archived_at is null), '[]'::jsonb));
end $$;

-- apply a template by hand to an event WITHOUT a schedule (Finance EDIT); p_preview = show the rows, write nothing
create or replace function public.payment_schedule_apply(p_quote uuid, p_template text default null, p_preview boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); q public.quotes; v_t jsonb; v_total numeric; v_r jsonb;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'event not found' using errcode = '42501'; end if;
  if not (case when coalesce(p_preview, false) then public.has_area('finance', 'view') else public.has_area('finance', 'edit') end) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if exists (select 1 from public.payment_milestones m where m.quote_id = q.id) then
    raise exception 'This event already has a payment schedule - change it in Logistics > Payments.' using errcode = '22023'; end if;
  v_total := public.helm_invoice_total(q.id);
  if v_total is null or v_total <= 0 then raise exception 'Price the quote first - the schedule is worked out from its total.' using errcode = '22023'; end if;
  v_t := public._pst_resolve(v_org, p_template);
  if v_t is null then raise exception 'Choose one of the payment schedules.' using errcode = '22023'; end if;
  if coalesce(p_preview, false) then
    return jsonb_build_object('applied', false, 'preview', true, 'template', v_t ->> 'name', 'total', v_total,
      'schedule', public._pst_compute(v_t -> 'lines', v_total, public._pst_today(v_org), q.event_date));
  end if;
  if q.deleted_at is not null or q.archived_at is not null or coalesce(q.status, '') = 'cancelled' then
    raise exception 'This event is cancelled or archived.' using errcode = '22023'; end if;
  v_r := public._pst_apply(q.id, v_t ->> 'key', 'manual', v_me);
  if not coalesce((v_r ->> 'applied')::boolean, false) then
    raise exception 'The payment schedule could not be added (%).', coalesce(v_r ->> 'reason', 'unknown') using errcode = '22023'; end if;
  begin perform public._pst_allocate(q.id);                    -- money already received covers the first payments
  exception when others then raise warning 'pay-schedule-0264: cover skipped (%)', sqlstate;
  end;
  return v_r;
end $$;

-- pause / resume automatic client reminders for one event (Finance or Quotes EDIT, own studio)
create or replace function public.payment_schedule_pause(p_quote uuid, p_paused boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); q public.quotes;
begin
  if v_me is null or v_org is null or not (public.has_area('finance', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_paused is null then raise exception 'say pause or resume' using errcode = '22023'; end if;
  select * into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'event not found' using errcode = '42501'; end if;
  insert into public.payment_schedule_quote_prefs(quote_id, org_id, reminders_paused, paused_at, paused_by)
    values (q.id, v_org, p_paused, case when p_paused then now() end, case when p_paused then v_me end)
    on conflict (quote_id) do update set reminders_paused = excluded.reminders_paused,
      paused_at = excluded.paused_at, paused_by = excluded.paused_by, updated_at = now();
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (v_me, case when p_paused then 'payment_reminders.paused' else 'payment_reminders.resumed' end,
            'quotes', q.id::text, q.id, jsonb_build_object('paused', p_paused), v_org);
  return jsonb_build_object('paused', p_paused);
end $$;

-- the client page (approval token, signed out): the schedule with paid / due / overdue + how to pay
create or replace function public.public_payment_schedule(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare q public.quotes; v_today date; v_paid numeric; v_left numeric; m record; v_rows jsonb := '[]'::jsonb;
  v_take numeric; v_rem numeric; v_state text; v_pay jsonb;
begin
  perform public.public_get_quote(p_token);   -- raises on an invalid / expired / shelved link
  select * into q from public.quotes x where x.approval_token = p_token;
  if q.id is null then raise exception 'invalid link' using errcode = '42501'; end if;
  v_today := public._pst_today(q.org_id);
  select coalesce(sum(qp.amount), 0) into v_paid from public.quote_payments qp where qp.quote_id = q.id and qp.status = 'paid';
  v_left := greatest(v_paid - coalesce((select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = q.id and pm.status = 'paid'), 0), 0);
  for m in select pm.* from public.payment_milestones pm where pm.quote_id = q.id and pm.status <> 'waived'
            order by pm.due_date nulls last, pm.seq, pm.created_at, pm.id loop
    if m.status = 'paid' then v_take := coalesce(m.amount, 0); v_rem := 0; v_state := 'paid';
    else
      v_take := least(greatest(coalesce(m.amount, 0), 0), v_left); v_left := v_left - v_take;
      v_rem := round(greatest(coalesce(m.amount, 0), 0) - v_take, 2);
      v_state := case when coalesce(m.amount, 0) > 0 and v_rem <= 0.005 then 'paid'
                      when m.due_date is not null and m.due_date < v_today then 'overdue'
                      when v_take > 0.005 then 'part_paid' else 'due' end;
    end if;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('label', m.label, 'due_date', m.due_date, 'amount', m.amount,
      'state', v_state, 'paid', round(v_take, 2), 'remaining', v_rem));
  end loop;
  v_pay := public._pst_pay_details(q.id);
  return jsonb_build_object('currency', coalesce(public._comms_quote_cur(q.id), 'INR'), 'today', v_today,
    'total', round(public.helm_invoice_total(q.id), 2), 'paid', round(v_paid, 2), 'rows', v_rows,
    'pay', case when v_pay ->> 'link' is null and v_pay ->> 'upi' is null and v_pay ->> 'note' is null then null else v_pay end);
end $$;

-- ---- 9) grants ----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array[
    'public._pst_builtins()', 'public._pst_lines_clean(jsonb)', 'public._pst_compute(jsonb, numeric, date, date)',
    'public._pst_today(uuid)', 'public._pst_resolve(uuid, text)', 'public._pst_apply(uuid, text, text, uuid)',
    'public._pst_tg_quote_approved()', 'public._pst_allocate(uuid)', 'public._pst_pay_details(uuid)', 'public._pst_pay_text(jsonb)',
    'public._pst_tick()', 'public._comms_cfg(uuid)', 'public._comms_queue_pay(uuid, text, text, boolean, uuid)',
    'public._comms_queue_pay__pre0264(uuid, text, text, boolean, uuid)', 'public.comms_outbox_claim(integer)',
    'public.comms_outbox_claim__pre0264(integer)', 'public.comms_tick()', 'public.comms_tick__pre0264()',
    'public.record_payment__pre0264(uuid, numeric, text, text, uuid, text, text)',
    'public.record_settlement_payment__pre0264(uuid, numeric, text, text, uuid, text, text)',
    'public.notification_catalog__pre0264()', 'public.notification_type_of__pre0264(text, text)',
    'public.payment_schedule_settings_get()', 'public.payment_schedule_settings_set(jsonb)',
    'public.payment_schedule_template_save(uuid, text, jsonb)', 'public.payment_schedule_template_archive(uuid)',
    'public.payment_schedule_for_quote(uuid)', 'public.payment_schedule_apply(uuid, text, boolean)',
    'public.payment_schedule_pause(uuid, boolean)', 'public.public_payment_schedule(uuid)',
    'public.record_payment(uuid, numeric, text, text, uuid, text, text)',
    'public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text)',
    'public.notification_catalog()', 'public.notification_type_of(text, text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach f in array array['public.payment_schedule_settings_get()', 'public.payment_schedule_settings_set(jsonb)',
      'public.payment_schedule_template_save(uuid, text, jsonb)', 'public.payment_schedule_template_archive(uuid)',
      'public.payment_schedule_for_quote(uuid)', 'public.payment_schedule_apply(uuid, text, boolean)',
      'public.payment_schedule_pause(uuid, boolean)', 'public.public_payment_schedule(uuid)',
      'public.record_payment(uuid, numeric, text, text, uuid, text, text)',
      'public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text)',
      'public.notification_catalog()', 'public.notification_type_of(text, text)'] loop
      execute 'grant execute on function ' || f || ' to authenticated';
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.public_payment_schedule(uuid) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public.comms_tick()', 'public.comms_outbox_claim(integer)', 'public._pst_tick()',
      'public.record_payment(uuid, numeric, text, text, uuid, text, text)',
      'public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text)',
      'public.notification_catalog()', 'public.notification_type_of(text, text)', 'public._comms_cfg(uuid)',
      'public._comms_queue_pay(uuid, text, text, boolean, uuid)'] loop
      execute 'grant execute on function ' || f || ' to service_role';
    end loop;
  end if;
end $$;

-- ---- VERIFY (run by hand; every row ok = true) -----------------------------------------------------------------------
-- select 'tables' as item, to_regclass('public.payment_schedule_templates') is not null and to_regclass('public.payment_schedule_settings') is not null as ok
-- union all select 'auto trigger', exists (select 1 from pg_trigger where tgname = 'zzz_pst_auto_schedule')
-- union all select 'record_payment wrapped', to_regprocedure('public.record_payment__pre0264(uuid,numeric,text,text,uuid,text,text)') is not null
-- union all select 'tick wrapped', position('pay-schedule-0264' in pg_get_functiondef('public.comms_tick()'::regprocedure)) > 0
-- union all select 'reminders on by default', (public._comms_cfg('00000000-0000-0000-0000-000000000000') ->> 'pay_enabled')::boolean;
