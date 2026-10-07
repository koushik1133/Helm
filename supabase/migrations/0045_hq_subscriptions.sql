-- ============================================================================
-- 0045_hq_subscriptions.sql — CANONICAL forward-only. REQUIRES 0029, 0037, 0042, 0043.
-- Owner decision: Helm HQ (platform operators) sees NO studio business data. HQ sees only
--   (a) the studio list, (b) the people in each studio (name, e-mail, role, active, last
--   sign-in, two-step on/off — never a phone), (c) what each studio paid Helm.
--
-- 1. HQ read RPCs redefined: no event / client / revenue numbers any more. hq_payments now
--    returns Helm SUBSCRIPTION payments. last_activity = latest member sign-in.
-- 2. Subscriptions: helm_plans, studio_subscriptions, subscription_payments (+ invoice
--    numbers, GST split computed here), helm_billing_settings (one row), billing_reminders
--    (queue only — nothing is sent from SQL). RLS on, NO table grants to anon/authenticated.
--    Every HQ write goes through an hq_* RPC that needs an operator at aal2 and writes an
--    'hq.*' audit row (org_id NULL). Payments are never deleted — they are voided with a
--    reason; the invoice number stays.
-- 3. Suspend = READ-ONLY, enforced by the DATABASE: a BEFORE INSERT/UPDATE/DELETE trigger
--    (zzz_studio_read_only) on every studio table refuses writes (SQLSTATE 25006) by signed-in
--    members AND anonymous link visitors (approve / portal / crew / invite) of a suspended
--    studio. A trigger is used instead of RESTRICTIVE policies because most writes go
--    through SECURITY DEFINER RPCs, which bypass RLS; triggers fire for every path.
--    Reads and exports are untouched. service_role / no-JWT maintenance is unaffected.
-- 4. Auto past-due (never auto-suspends) + reminder queue, scheduled with pg_cron if present.
-- 5. Operator management (list / add / remove, aal2, audited, never the last / yourself).
-- 6. Razorpay-ready nullable provider columns (dormant) + a service-role-only idempotent
--    settlement RPC keyed on provider_payment_id.
-- Additive + idempotent + drift-safe. No existing row is changed or deleted. The only
-- objects dropped are the old HQ read functions whose result columns change shape.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.is_platform_admin()') is null or to_regprocedure('public._hq_gate(text,text)') is null then
    raise exception '0045: Helm HQ (0029) is not installed on this database'; end if;
  if to_regprocedure('public._a42_operator_binding_ok()') is null then
    raise exception '0045: 0042 is not installed on this database'; end if;
  if to_regprocedure('public.current_org_id__pre0043()') is null then
    raise exception '0045: 0043 is not installed on this database'; end if;
end $$;

-- ---- 1) tables -----------------------------------------------------------------------
create table if not exists public.helm_plans (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name          text not null check (length(btrim(name)) between 1 and 80),
  price_monthly numeric(12,2) not null default 0 check (price_monthly >= 0),
  currency      text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.studio_subscriptions (
  org_id               uuid primary key references public.organizations(id) on delete restrict,
  plan_id              uuid references public.helm_plans(id) on delete restrict,
  status               text not null default 'trial'
                       check (status in ('trial','active','past_due','suspended','cancelled')),
  trial_ends_at        date,
  current_period_start date,
  current_period_end   date,
  notes                text check (notes is null or length(notes) <= 1000),
  prev_status          text check (prev_status is null or prev_status in ('trial','active','past_due','cancelled')),
  suspended_at         timestamptz,
  suspend_reason       text,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  check (current_period_end is null or current_period_start is null or current_period_end >= current_period_start)
);
alter table public.studio_subscriptions add column if not exists provider text;
alter table public.studio_subscriptions add column if not exists provider_subscription_id text;
alter table public.studio_subscriptions add column if not exists provider_payment_id text;
create index if not exists studio_subscriptions_suspended_idx on public.studio_subscriptions(org_id) where status = 'suspended';

create sequence if not exists public.helm_invoice_seq start 1 minvalue 1 no cycle;

create table if not exists public.subscription_payments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete restrict,
  amount       numeric(12,2) not null check (amount > 0),
  currency     text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  paid_on      date not null,
  period_start date,
  period_end   date,
  method       text not null check (method in ('upi','bank','cash','card','other')),
  reference    text check (reference is null or length(reference) <= 120),
  recorded_by  uuid,
  recorded_at  timestamptz not null default now(),
  voided_at    timestamptz,
  voided_by    uuid,
  void_reason  text,
  check (period_end is null or period_start is null or period_end >= period_start),
  check ((voided_at is null) = (void_reason is null))
);
alter table public.subscription_payments add column if not exists invoice_seq bigint;
alter table public.subscription_payments add column if not exists invoice_no text;
alter table public.subscription_payments add column if not exists gst_rate numeric(5,2);
alter table public.subscription_payments add column if not exists net_amount numeric(12,2);
alter table public.subscription_payments add column if not exists gst_amount numeric(12,2);
alter table public.subscription_payments add column if not exists seller jsonb;
alter table public.subscription_payments add column if not exists plan_code text;
alter table public.subscription_payments add column if not exists provider text;
alter table public.subscription_payments add column if not exists provider_subscription_id text;
alter table public.subscription_payments add column if not exists provider_payment_id text;
create unique index if not exists subscription_payments_invoice_no_uq on public.subscription_payments(invoice_no) where invoice_no is not null;
create unique index if not exists subscription_payments_invoice_seq_uq on public.subscription_payments(invoice_seq) where invoice_seq is not null;
create unique index if not exists subscription_payments_provider_payment_uq on public.subscription_payments(provider_payment_id) where provider_payment_id is not null;
create index if not exists subscription_payments_org_idx on public.subscription_payments(org_id, paid_on);

create table if not exists public.helm_billing_settings (
  id             boolean primary key default true check (id),
  legal_name     text not null default 'Helm',
  gstin          text,
  address        text,
  gst_rate       numeric(5,2) not null default 18 check (gst_rate >= 0 and gst_rate <= 50),
  invoice_prefix text not null default 'HELM-' check (invoice_prefix ~ '^[A-Za-z0-9/_-]{0,16}$'),
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
insert into public.helm_billing_settings(id) values (true) on conflict (id) do nothing;

create table if not exists public.billing_reminders (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete restrict,
  kind       text not null check (kind in ('due_soon','past_due')),
  period_end date not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  channel    text check (channel is null or channel in ('email','whatsapp','sms','manual','skipped')),
  unique (org_id, kind, period_end)
);

do $$ declare t text; begin
  foreach t in array array['helm_plans','studio_subscriptions','subscription_payments','helm_billing_settings','billing_reminders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
  end loop;
  revoke all on sequence public.helm_invoice_seq from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on sequence public.helm_invoice_seq from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on sequence public.helm_invoice_seq from authenticated; end if;
  -- the reminder sender (Edge Function, service role) reads the queue and stamps sent_at/channel
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on table public.billing_reminders to service_role;
    grant update (sent_at, channel) on table public.billing_reminders to service_role;
    grant select on table public.studio_subscriptions to service_role;   -- webhook: org by provider_subscription_id
  end if;
end $$;
-- (no policies on purpose: RLS on + no grants → only definer code reads these tables)

-- payments: never deleted; after insert only the void fields may be set, once
create or replace function public.tg_subscription_payment_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'subscription payments are never deleted — void them with a reason' using errcode = '42501';
  end if;
  if old.voided_at is not null then
    raise exception 'this payment is already void' using errcode = '42501';
  end if;
  if (new.id, new.org_id, new.amount, new.currency, new.paid_on, new.period_start, new.period_end, new.method,
      new.reference, new.recorded_by, new.recorded_at, new.invoice_seq, new.invoice_no, new.gst_rate, new.net_amount,
      new.gst_amount, new.seller, new.plan_code, new.provider, new.provider_subscription_id, new.provider_payment_id)
     is distinct from
     (old.id, old.org_id, old.amount, old.currency, old.paid_on, old.period_start, old.period_end, old.method,
      old.reference, old.recorded_by, old.recorded_at, old.invoice_seq, old.invoice_no, old.gst_rate, old.net_amount,
      old.gst_amount, old.seller, old.plan_code, old.provider, old.provider_subscription_id, old.provider_payment_id) then
    raise exception 'a recorded payment can only be voided, not changed' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.tg_subscription_payment_immutable() from public;
drop trigger if exists subscription_payments_immutable on public.subscription_payments;
create trigger subscription_payments_immutable before update or delete on public.subscription_payments
  for each row execute function public.tg_subscription_payment_immutable();

-- ---- 2) suspend = read-only (database-enforced) --------------------------------------------
create or replace function public._studio_writable(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_org is null
      or not exists (select 1 from public.studio_subscriptions s where s.org_id = p_org and s.status = 'suspended');
$$;

-- TG_ARGV[0] says how a row names its studio: org_id | id (organizations) | user_id | owner | quote_id
create or replace function public.tg_studio_read_only()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_how text := tg_argv[0];
  v_orgs uuid[] := '{}';
  v_key text; r jsonb; o uuid;
begin
  if v_role not in ('authenticated', 'anon') then return coalesce(new, old); end if;      -- service role / maintenance
  if not exists (select 1 from public.studio_subscriptions s where s.status = 'suspended') then
    return coalesce(new, old); end if;                                                      -- fast path
  foreach r in array (case tg_op when 'INSERT' then array[to_jsonb(new)]
                                  when 'DELETE' then array[to_jsonb(old)]
                                  else array[to_jsonb(new), to_jsonb(old)] end) loop
    v_key := r ->> v_how; o := null;
    if v_key is not null and v_key ~* '^[0-9a-f-]{36}$' then
      if v_how in ('org_id', 'id') then o := v_key::uuid;
      elsif v_how in ('user_id', 'owner') then select p.org_id into o from public.profiles p where p.id = v_key::uuid;
      elsif v_how = 'quote_id' then select q.org_id into o from public.quotes q where q.id = v_key::uuid;
      end if;
    end if;
    if o is not null then v_orgs := v_orgs || o; end if;
  end loop;
  foreach o in array v_orgs loop
    if not public._studio_writable(o) and not public.is_platform_admin() then
      raise exception 'Read-only: this studio''s Helm subscription is suspended — contact Helm'
        using errcode = '25006', hint = 'studio_suspended';
    end if;
  end loop;
  return coalesce(new, old);
end $$;
revoke all on function public.tg_studio_read_only() from public;

create or replace function public._a45_attach_read_only_guards()
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare rec record; n int := 0; v_how text;
begin
  for rec in
    select c.oid, c.relname,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) has_org,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped) has_user,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'owner' and not a.attisdropped) has_owner,
           exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'quote_id' and not a.attisdropped) has_quote
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
       and c.relname not in ('audit_log', 'notification_seen', 'platform_admins', 'helm_plans', 'studio_subscriptions',
                             'subscription_payments', 'helm_billing_settings', 'billing_reminders',
                             'helm_schema_migrations', 'helm_env_settings', 'helm_audit_0044_reverted',
                             'member_profile_settings', 'auth_temp_passwords')
  loop
    v_how := case when rec.has_org then 'org_id' when rec.relname = 'organizations' then 'id'
                  when rec.has_user then 'user_id' when rec.has_owner then 'owner'
                  when rec.has_quote then 'quote_id' end;
    if v_how is null then continue; end if;
    execute format('drop trigger if exists zzz_studio_read_only on public.%I', rec.relname);
    execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I '
                   'for each row execute function public.tg_studio_read_only(%L)', rec.relname, v_how);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public._a45_attach_read_only_guards() from public;
select public._a45_attach_read_only_guards();

-- ---- 3) internal helpers ---------------------------------------------------------------------
-- HQ write gate: operator AND a two-step (aal2) session, always; writes the audit row.
create or replace function public._hq_wgate(p_action text, p_entity text, p_entity_id text, p_changed jsonb default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, p_action, p_entity, p_entity_id, p_changed, null, now()
      from auth.users u where u.id = auth.uid();
end $$;

create or replace function public._hq_money_by_currency(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', amt) order by currency), '[]'::jsonb)
    from (select sp.currency, sum(sp.amount) amt from public.subscription_payments sp
           where sp.voided_at is null and sp.paid_on between p_from and p_to group by sp.currency) t;
$$;

create or replace function public._hq_mrr()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amount', amt) order by currency), '[]'::jsonb)
    from (select p.currency, sum(p.price_monthly) amt from public.studio_subscriptions s
            join public.helm_plans p on p.id = s.plan_id
           where s.status in ('active', 'past_due') group by p.currency) t;
$$;

-- the internal billing refresh (no gate: called by the gated RPCs and by pg_cron)
create or replace function public._billing_refresh()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare n_pd int := 0; n_rem int := 0; n int; rec record;
begin
  for rec in
    select s.org_id, s.current_period_end from public.studio_subscriptions s
     where s.status = 'active' and s.current_period_end is not null and s.current_period_end < current_date
       and not exists (select 1 from public.subscription_payments sp where sp.org_id = s.org_id and sp.voided_at is null
                        and sp.period_end is not null and sp.period_end >= current_date)
     for update of s
  loop
    update public.studio_subscriptions set status = 'past_due', updated_at = now() where org_id = rec.org_id and status = 'active';
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'hq.billing.auto_past_due', 'studio_subscriptions', rec.org_id::text,
              jsonb_build_object('current_period_end', rec.current_period_end), null, now());
    n_pd := n_pd + 1;
  end loop;
  insert into public.billing_reminders(org_id, kind, period_end)
    select s.org_id, 'past_due', s.current_period_end from public.studio_subscriptions s
     where s.status = 'past_due' and s.current_period_end is not null
  on conflict (org_id, kind, period_end) do nothing;
  get diagnostics n = row_count; n_rem := n_rem + n;
  insert into public.billing_reminders(org_id, kind, period_end)
    select s.org_id, 'due_soon', s.current_period_end from public.studio_subscriptions s
     where s.status in ('active', 'trial') and s.current_period_end between current_date and current_date + 7
       and not exists (select 1 from public.subscription_payments sp where sp.org_id = s.org_id and sp.voided_at is null
                        and sp.period_end is not null and sp.period_end > s.current_period_end)
  on conflict (org_id, kind, period_end) do nothing;
  get diagnostics n = row_count; n_rem := n_rem + n;
  return jsonb_build_object('past_due_set', n_pd, 'reminders_queued', n_rem);
end $$;

-- record one payment: invoice number from the sequence, GST split computed here (amount is GST-inclusive)
create or replace function public._sub_record_payment(p_org uuid, p_amount numeric, p_currency text, p_paid_on date,
  p_period_start date, p_period_end date, p_method text, p_reference text, p_actor uuid,
  p_provider text default null, p_provider_payment_id text default null, p_provider_subscription_id text default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_seq bigint; b record; v_rate numeric; v_net numeric(12,2); v_plan text;
begin
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown studio' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'amount must be more than 0' using errcode = '22023'; end if;
  if p_paid_on is null or p_paid_on > current_date + 1 or p_paid_on < date '2020-01-01' then
    raise exception 'paid on date is not valid' using errcode = '22023'; end if;
  if coalesce(p_method, '') not in ('upi','bank','cash','card','other') then raise exception 'method must be upi, bank, cash, card or other' using errcode = '22023'; end if;
  if p_period_start is not null and p_period_end is not null and p_period_end < p_period_start then
    raise exception 'period end is before period start' using errcode = '22023'; end if;
  select * into b from public.helm_billing_settings where id;
  v_rate := coalesce(b.gst_rate, 18);
  v_net := round(p_amount / (1 + v_rate / 100), 2);
  select p.code into v_plan from public.studio_subscriptions s join public.helm_plans p on p.id = s.plan_id where s.org_id = p_org;
  v_seq := nextval('public.helm_invoice_seq');
  insert into public.subscription_payments(org_id, amount, currency, paid_on, period_start, period_end, method, reference,
      recorded_by, invoice_seq, invoice_no, gst_rate, net_amount, gst_amount, seller, plan_code,
      provider, provider_payment_id, provider_subscription_id)
    values (p_org, round(p_amount, 2), upper(coalesce(nullif(btrim(p_currency), ''), 'INR')), p_paid_on, p_period_start, p_period_end,
      p_method, nullif(left(btrim(coalesce(p_reference, '')), 120), ''), p_actor, v_seq,
      coalesce(b.invoice_prefix, 'HELM-') || lpad(v_seq::text, 6, '0'), v_rate, v_net, round(p_amount, 2) - v_net,
      jsonb_build_object('legal_name', b.legal_name, 'gstin', b.gstin, 'address', b.address), v_plan,
      p_provider, p_provider_payment_id, p_provider_subscription_id)
    returning id into v_id;
  return v_id;
end $$;

create or replace function public._sub_payment_json(p public.subscription_payments)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'org_id', p.org_id, 'invoice_no', p.invoice_no, 'amount', p.amount,
    'currency', p.currency, 'paid_on', p.paid_on, 'period_start', p.period_start, 'period_end', p.period_end,
    'method', p.method, 'reference', p.reference, 'recorded_at', p.recorded_at, 'net_amount', p.net_amount,
    'gst_amount', p.gst_amount, 'gst_rate', p.gst_rate, 'voided', p.voided_at is not null, 'voided_at', p.voided_at,
    'void_reason', p.void_reason, 'provider', p.provider);
$$;

create or replace function public._sub_invoice_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'invoice_no', p.invoice_no, 'issued_on', p.paid_on, 'paid_on', p.paid_on, 'recorded_at', p.recorded_at,
    'net', p.net_amount, 'amount', p.amount, 'provider_payment_id', p.provider_payment_id,
    'status', case when p.voided_at is null then 'paid' else 'void' end,
    'voided_at', p.voided_at, 'void_reason', p.void_reason,
    'seller', coalesce(p.seller, '{}'::jsonb) || jsonb_build_object('gst_rate', p.gst_rate),
    'buyer', jsonb_build_object('org_id', o.id, 'name', o.name, 'gstin', o.gst_number, 'email', o.business_email, 'address', o.location),
    'plan', jsonb_build_object('code', p.plan_code, 'name', (select hp.name from public.helm_plans hp where hp.code = p.plan_code)),
    'period_start', p.period_start, 'period_end', p.period_end, 'method', p.method, 'reference', p.reference,
    'currency', p.currency, 'gst_rate', p.gst_rate, 'net_amount', p.net_amount, 'gst_amount', p.gst_amount, 'total', p.amount,
    'lines', jsonb_build_array(jsonb_build_object(
       'description', 'Helm subscription' || coalesce(' — ' || (select hp.name from public.helm_plans hp where hp.code = p.plan_code), '')
                      || coalesce(' (' || p.period_start::text || ' to ' || p.period_end::text || ')', ''),
       'amount', p.net_amount)))
  from public.subscription_payments p join public.organizations o on o.id = p.org_id where p.id = p_id;
$$;

-- ---- 4) HQ reads, redefined without any studio business data -----------------------------------
drop function if exists public.hq_studios(text, int, int);
drop function if exists public.hq_studios(text, text, int, int);
drop function if exists public._hq_studio_rows();

create or replace function public._hq_studio_rows()
returns table(org_id uuid, name text, slug text, created_at timestamptz, owner_email text, users_count bigint,
              plan_code text, plan_name text, status text, current_period_end date, last_activity timestamptz, total_paid numeric)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.slug, o.created_at,
         coalesce(cu.email, (select p.email from public.profiles p where p.org_id = o.id and p.role = 'admin'
                              order by p.created_at limit 1)),
         (select count(*) from public.profiles p where p.org_id = o.id),
         hp.code, hp.name, coalesce(s.status, 'none'), s.current_period_end,
         (select max(u.last_sign_in_at) from public.profiles p join auth.users u on u.id = p.id where p.org_id = o.id),
         coalesce((select sum(sp.amount) from public.subscription_payments sp where sp.org_id = o.id and sp.voided_at is null), 0)
    from public.organizations o
    left join auth.users cu on cu.id = o.created_by
    left join public.studio_subscriptions s on s.org_id = o.id
    left join public.helm_plans hp on hp.id = s.plan_id
$$;

create or replace function public.hq_studios(p_search text default null, p_status text default null,
                                             p_limit int default 25, p_offset int default 0)
returns table(org_id uuid, name text, slug text, created_at timestamptz, owner_email text, users_count bigint,
              plan_code text, plan_name text, status text, current_period_end date, last_activity timestamptz,
              total_paid numeric, total_count bigint)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare s text := nullif(btrim(coalesce(p_search, '')), ''); st text := nullif(btrim(coalesce(p_status, '')), '');
begin
  perform public._hq_gate('hq_studios', left(coalesce(s, '') || '|' || coalesce(st, ''), 80));
  if st is not null and st not in ('trial','active','past_due','suspended','cancelled','none') then
    raise exception 'unknown status filter' using errcode = '22023'; end if;
  return query
    select r.org_id, r.name, r.slug, r.created_at, r.owner_email, r.users_count, r.plan_code, r.plan_name, r.status,
           r.current_period_end, r.last_activity, r.total_paid, count(*) over ()
      from public._hq_studio_rows() r
     where (st is null or r.status = st)
       and (s is null or strpos(lower(r.name), lower(s)) > 0 or strpos(lower(coalesce(r.slug, '')), lower(s)) > 0
            or strpos(lower(coalesce(r.owner_email, '')), lower(s)) > 0)
     order by r.created_at desc, r.org_id
     limit least(greatest(coalesce(p_limit, 25), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.hq_overview()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb; v jsonb; n bigint; m bigint; today date := current_date;
begin
  perform public._hq_gate('hq_overview');
  perform public._billing_refresh();
  r := jsonb_build_object(
    'generated_at', now(),
    'studios', jsonb_build_object(
      'total',  (select count(*) from public.organizations),
      'new_7d', (select count(*) from public.organizations where created_at >= now() - interval '7 days'),
      'new_30d',(select count(*) from public.organizations where created_at >= now() - interval '30 days'),
      'by_status', (select jsonb_object_agg(t.st_k, t.st_c) from (
          select coalesce(ss.status, 'none') st_k, count(*) st_c from public.organizations o
            left join public.studio_subscriptions ss on ss.org_id = o.id group by 1) t)),
    'users', jsonb_build_object(
      'total',  (select count(*) from auth.users),
      'new_7d', (select count(*) from auth.users where created_at >= now() - interval '7 days'),
      'new_30d',(select count(*) from auth.users where created_at >= now() - interval '30 days'),
      'active_7d', (select count(*) from auth.users where last_sign_in_at >= now() - interval '7 days'),
      'active_30d',(select count(*) from auth.users where last_sign_in_at >= now() - interval '30 days')),
    'billing', jsonb_build_object(
      'mrr', public._hq_mrr(),
      'paid_this_month', public._hq_money_by_currency(date_trunc('month', now())::date, today),
      'past_due_count', (select count(*) from public.studio_subscriptions where status = 'past_due'),
      'suspended_count', (select count(*) from public.studio_subscriptions where status = 'suspended'),
      'reminders_pending', (select count(*) from public.billing_reminders where sent_at is null)));
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'studios', coalesce(s.c, 0), 'users', coalesce(u.c, 0)) order by d), '[]'::jsonb)
    into v
    from generate_series(today - 29, today, interval '1 day') d
    left join (select created_at::date k, count(*) c from public.organizations group by 1) s on s.k = d::date
    left join (select created_at::date k, count(*) c from auth.users group by 1) u on u.k = d::date;
  r := r || jsonb_build_object('signups_30d', v);
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select count(distinct user_id) from auth.mfa_factors where status::text = ''verified''' into n;
    select count(*) into m from auth.users;
    r := r || jsonb_build_object('mfa', jsonb_build_object('users_with_mfa', n, 'users_total', m,
             'pct', case when m > 0 then round(100.0 * n / m, 1) else 0 end));
  end if;
  if to_regclass('auth.audit_log_entries') is not null then
    begin
      execute $q$select count(*) from auth.audit_log_entries
                  where created_at >= now() - interval '7 days'
                    and payload ->> 'action' in ('login','user_signedin','token_refreshed')$q$ into n;
      r := r || jsonb_build_object('auth_logins_7d', n);
    exception when others then null;
    end;
  end if;
  return r;
end $$;

create or replace function public.hq_studio_detail(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb; v_members jsonb; v_ban boolean; v_mfa boolean := to_regclass('auth.mfa_factors') is not null;
begin
  perform public._hq_gate('hq_studio_detail', p_org::text);
  select jsonb_build_object('org_id', s.org_id, 'name', s.name, 'slug', s.slug, 'created_at', s.created_at,
           'owner_email', s.owner_email, 'users_count', s.users_count, 'last_activity', s.last_activity,
           'status', s.status, 'total_paid', s.total_paid)
    into r from public._hq_studio_rows() s where s.org_id = p_org;
  if r is null then return null; end if;
  v_ban := exists (select 1 from pg_attribute a where a.attrelid = 'auth.users'::regclass and a.attname = 'banned_until' and not a.attisdropped);
  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object('display_name', p.full_name, 'email', coalesce(u.email, p.email), 'role', p.role,
             'active', %s, 'last_sign_in_at', u.last_sign_in_at, 'mfa_enabled', %s) order by p.created_at), '[]'::jsonb)
      from public.profiles p left join auth.users u on u.id = p.id where p.org_id = $1$q$,
    case when v_ban then '(u.id is not null and (u.banned_until is null or u.banned_until < now()))' else '(u.id is not null)' end,
    case when v_mfa then 'exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status::text = ''verified'')' else 'false' end)
    into v_members using p_org;
  r := r || jsonb_build_object('members', v_members,
    'subscription', (select jsonb_build_object('plan_code', hp.code, 'plan_name', hp.name, 'price_monthly', hp.price_monthly,
         'currency', hp.currency, 'status', s.status, 'trial_ends_at', s.trial_ends_at,
         'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end, 'notes', s.notes,
         'suspended_at', s.suspended_at, 'suspend_reason', s.suspend_reason, 'updated_at', s.updated_at,
         'provider', s.provider)
       from public.studio_subscriptions s left join public.helm_plans hp on hp.id = s.plan_id where s.org_id = p_org),
    'payments', coalesce((select jsonb_agg(public._sub_payment_json(sp) order by sp.paid_on desc, sp.recorded_at desc)
       from public.subscription_payments sp where sp.org_id = p_org), '[]'::jsonb));
  return r;
end $$;

create or replace function public.hq_payments(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare f date := coalesce(p_from, current_date - 30); t date := coalesce(p_to, current_date);
begin
  perform public._hq_gate('hq_payments', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  return jsonb_build_object('from', f, 'to', t,
    'payments', coalesce((select jsonb_agg(public._sub_payment_json(sp) || jsonb_build_object('studio', o.name)
                          order by sp.paid_on desc, sp.recorded_at desc)
       from public.subscription_payments sp join public.organizations o on o.id = sp.org_id
      where sp.paid_on between f and t), '[]'::jsonb));
end $$;

-- ---- 5) HQ billing ---------------------------------------------------------------------------------
create or replace function public.hq_refresh_billing_status()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public._hq_wgate('hq.billing.refresh', 'studio_subscriptions', null);
  r := public._billing_refresh();
  return r;
end $$;

create or replace function public.hq_billing(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare f date := coalesce(p_from, date_trunc('month', now())::date); t date := coalesce(p_to, current_date);
begin
  perform public._hq_gate('hq_billing', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  perform public._billing_refresh();
  return jsonb_build_object('from', f, 'to', t,
    'collected', public._hq_money_by_currency(f, t),
    'payments_count', (select count(*) from public.subscription_payments where voided_at is null and paid_on between f and t),
    'voided_count', (select count(*) from public.subscription_payments where voided_at is not null and paid_on between f and t),
    'mrr', public._hq_mrr(),
    'per_studio', coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'status', coalesce(s.status, 'none'),
            'plan_code', hp.code, 'paid', x.paid, 'currency', x.currency, 'payments', x.n) order by o.name)
         from (select sp.org_id, sp.currency, sum(sp.amount) paid, count(*) n from public.subscription_payments sp
                where sp.voided_at is null and sp.paid_on between f and t group by sp.org_id, sp.currency) x
         join public.organizations o on o.id = x.org_id
         left join public.studio_subscriptions s on s.org_id = o.id left join public.helm_plans hp on hp.id = s.plan_id), '[]'::jsonb),
    'past_due', coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'plan_code', hp.code,
            'current_period_end', s.current_period_end, 'days_overdue', current_date - s.current_period_end) order by s.current_period_end)
         from public.studio_subscriptions s join public.organizations o on o.id = s.org_id
         left join public.helm_plans hp on hp.id = s.plan_id where s.status = 'past_due'), '[]'::jsonb),
    'reminders', coalesce((select jsonb_agg(jsonb_build_object('id', br.id, 'org_id', br.org_id, 'studio', o.name, 'kind', br.kind,
            'period_end', br.period_end, 'created_at', br.created_at, 'sent_at', br.sent_at, 'channel', br.channel) order by br.created_at desc)
         from (select * from public.billing_reminders order by created_at desc limit 100) br
         join public.organizations o on o.id = br.org_id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(public._sub_payment_json(sp) || jsonb_build_object('studio', o.name)
                          order by sp.paid_on desc, sp.recorded_at desc)
       from public.subscription_payments sp join public.organizations o on o.id = sp.org_id
      where sp.paid_on between f and t), '[]'::jsonb));
end $$;

create or replace function public.hq_plans()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._hq_gate('hq_plans');
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'price_monthly', p.price_monthly,
           'currency', p.currency, 'active', p.active, 'studios', (select count(*) from public.studio_subscriptions s where s.plan_id = p.id))
           order by p.active desc, p.price_monthly, p.code) from public.helm_plans p), '[]'::jsonb);
end $$;

create or replace function public.hq_upsert_plan(p_code text, p_name text, p_price_monthly numeric,
                                                 p_currency text default 'INR', p_active boolean default true)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_code text := lower(btrim(coalesce(p_code, '')));
begin
  perform public._hq_wgate('hq.plan.upsert', 'helm_plans', v_code,
    jsonb_build_object('name', p_name, 'price_monthly', p_price_monthly, 'currency', p_currency, 'active', p_active));
  if v_code !~ '^[a-z0-9][a-z0-9_-]{1,39}$' then raise exception 'plan code: 2-40 lowercase letters, numbers, - or _' using errcode = '22023'; end if;
  if p_price_monthly is null or p_price_monthly < 0 then raise exception 'price must be 0 or more' using errcode = '22023'; end if;
  insert into public.helm_plans(code, name, price_monthly, currency, active)
    values (v_code, btrim(p_name), round(p_price_monthly, 2), upper(coalesce(nullif(btrim(p_currency), ''), 'INR')), coalesce(p_active, true))
  on conflict (code) do update set name = excluded.name, price_monthly = excluded.price_monthly,
    currency = excluded.currency, active = excluded.active, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.hq_set_subscription(p_org uuid, p_plan_code text default null, p_status text default null,
  p_trial_ends_at date default null, p_period_start date default null, p_period_end date default null, p_notes text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_plan uuid; cur public.studio_subscriptions;
begin
  perform public._hq_wgate('hq.subscription.set', 'studio_subscriptions', p_org::text,
    jsonb_build_object('plan', p_plan_code, 'status', p_status, 'trial_ends_at', p_trial_ends_at,
                       'period_start', p_period_start, 'period_end', p_period_end));
  if not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'unknown studio' using errcode = '22023'; end if;
  if p_status is not null and p_status not in ('trial','active','past_due','cancelled') then
    raise exception 'status must be trial, active, past_due or cancelled (use suspend / reactivate for suspension)' using errcode = '22023'; end if;
  if p_plan_code is not null then
    select id into v_plan from public.helm_plans where code = lower(btrim(p_plan_code));
    if v_plan is null then raise exception 'unknown plan' using errcode = '22023'; end if;
  end if;
  if p_period_start is not null and p_period_end is not null and p_period_end < p_period_start then
    raise exception 'period end is before period start' using errcode = '22023'; end if;
  select * into cur from public.studio_subscriptions where org_id = p_org for update;
  if found and cur.status = 'suspended' and p_status is not null then
    raise exception 'this studio is suspended — reactivate it first' using errcode = '22023'; end if;
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, current_period_start, current_period_end, notes, updated_at, updated_by)
    values (p_org, v_plan, coalesce(p_status, 'trial'), p_trial_ends_at, p_period_start, p_period_end, nullif(left(p_notes, 1000), ''), now(), auth.uid())
  on conflict (org_id) do update set
    plan_id = coalesce(v_plan, studio_subscriptions.plan_id),
    status = coalesce(p_status, studio_subscriptions.status),
    trial_ends_at = coalesce(p_trial_ends_at, studio_subscriptions.trial_ends_at),
    current_period_start = coalesce(p_period_start, studio_subscriptions.current_period_start),
    current_period_end = coalesce(p_period_end, studio_subscriptions.current_period_end),
    notes = coalesce(nullif(left(p_notes, 1000), ''), studio_subscriptions.notes),
    updated_at = now(), updated_by = auth.uid();
  return (select to_jsonb(s) - 'prev_status' from public.studio_subscriptions s where s.org_id = p_org);
end $$;

create or replace function public.hq_suspend_studio(p_org uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform public._hq_wgate('hq.studio.suspend', 'studio_subscriptions', p_org::text, jsonb_build_object('reason', left(v_reason, 300)));
  if not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'unknown studio' using errcode = '22023'; end if;
  if length(v_reason) < 3 then raise exception 'a reason is required' using errcode = '22023'; end if;
  insert into public.studio_subscriptions(org_id, status, prev_status, suspended_at, suspend_reason, updated_at, updated_by)
    values (p_org, 'suspended', 'trial', now(), left(v_reason, 300), now(), auth.uid())
  on conflict (org_id) do update set
    prev_status = case when studio_subscriptions.status = 'suspended' then studio_subscriptions.prev_status else studio_subscriptions.status end,
    status = 'suspended',
    suspended_at = case when studio_subscriptions.status = 'suspended' then studio_subscriptions.suspended_at else now() end,
    suspend_reason = left(v_reason, 300), updated_at = now(), updated_by = auth.uid();
  return jsonb_build_object('org_id', p_org, 'status', 'suspended');
end $$;

create or replace function public.hq_reactivate_studio(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_status text;
begin
  perform public._hq_wgate('hq.studio.reactivate', 'studio_subscriptions', p_org::text);
  update public.studio_subscriptions set status = coalesce(prev_status, 'active'), prev_status = null, suspended_at = null,
         suspend_reason = null, updated_at = now(), updated_by = auth.uid()
   where org_id = p_org and status = 'suspended'
  returning status into v_status;
  if v_status is null then raise exception 'this studio is not suspended' using errcode = '22023'; end if;
  return jsonb_build_object('org_id', p_org, 'status', v_status);
end $$;

create or replace function public.hq_record_payment(p_org uuid, p_amount numeric, p_paid_on date, p_method text,
  p_currency text default 'INR', p_period_start date default null, p_period_end date default null, p_reference text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public._hq_wgate('hq.payment.record', 'subscription_payments', p_org::text,
    jsonb_build_object('amount', p_amount, 'currency', p_currency, 'paid_on', p_paid_on, 'method', p_method,
                       'period_start', p_period_start, 'period_end', p_period_end, 'reference', left(p_reference, 120)));
  v_id := public._sub_record_payment(p_org, p_amount, p_currency, p_paid_on, p_period_start, p_period_end, p_method, p_reference, auth.uid());
  return (select public._sub_payment_json(sp) from public.subscription_payments sp where sp.id = v_id);
end $$;

create or replace function public.hq_void_payment(p_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_reason text := btrim(coalesce(p_reason, '')); n int;
begin
  perform public._hq_wgate('hq.payment.void', 'subscription_payments', p_id::text, jsonb_build_object('reason', left(v_reason, 300)));
  if length(v_reason) < 3 then raise exception 'a reason is required' using errcode = '22023'; end if;
  update public.subscription_payments set voided_at = now(), voided_by = auth.uid(), void_reason = left(v_reason, 300)
   where id = p_id and voided_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'payment not found or already void' using errcode = '22023'; end if;
  return (select public._sub_payment_json(sp) from public.subscription_payments sp where sp.id = p_id);
end $$;

create or replace function public.hq_invoice(p_payment_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._hq_gate('hq_invoice', p_payment_id::text);
  return public._sub_invoice_json(p_payment_id);
end $$;

create or replace function public.hq_billing_settings()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._hq_gate('hq_billing_settings');
  return (select to_jsonb(b) - 'id' from public.helm_billing_settings b where b.id);
end $$;

create or replace function public.hq_set_billing_settings(p_legal_name text, p_gstin text, p_address text,
                                                          p_gst_rate numeric, p_invoice_prefix text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._hq_wgate('hq.billing.settings', 'helm_billing_settings', null,
    jsonb_build_object('legal_name', p_legal_name, 'gstin', p_gstin, 'gst_rate', p_gst_rate, 'invoice_prefix', p_invoice_prefix));
  if length(btrim(coalesce(p_legal_name, ''))) not between 1 and 160 then raise exception 'legal name is required' using errcode = '22023'; end if;
  if p_gst_rate is null or p_gst_rate < 0 or p_gst_rate > 50 then raise exception 'GST rate must be 0-50' using errcode = '22023'; end if;
  if coalesce(p_invoice_prefix, '') !~ '^[A-Za-z0-9/_-]{0,16}$' then raise exception 'invoice prefix: up to 16 letters, numbers, / - _' using errcode = '22023'; end if;
  if p_gstin is not null and btrim(p_gstin) <> '' and upper(btrim(p_gstin)) !~ '^[0-9]{2}[A-Z0-9]{13}$' then
    raise exception 'GSTIN must be 15 characters' using errcode = '22023'; end if;
  update public.helm_billing_settings set legal_name = btrim(p_legal_name), gstin = nullif(upper(btrim(coalesce(p_gstin, ''))), ''),
         address = nullif(left(btrim(coalesce(p_address, '')), 500), ''), gst_rate = p_gst_rate,
         invoice_prefix = coalesce(p_invoice_prefix, ''), updated_at = now(), updated_by = auth.uid()
   where id;
  return (select to_jsonb(b) - 'id' from public.helm_billing_settings b where b.id);
end $$;

create or replace function public.hq_audit(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare f date := coalesce(p_from, current_date - 30); t date := coalesce(p_to, current_date);
begin
  perform public._hq_gate('hq_audit', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  return jsonb_build_object('from', f, 'to', t, 'rows', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
     select jsonb_build_object('at', a.at, 'actor_email', a.actor_email, 'action', a.action, 'entity', a.entity,
              'entity_id', a.entity_id, 'changed', a.changed) x
       from public.audit_log a
      where a.action like 'hq.%' and a.org_id is null and a.at >= f and a.at < t + 1
      order by a.at desc limit 1000) z), '[]'::jsonb));
end $$;

-- ---- 6) operators -------------------------------------------------------------------------------------
create or replace function public.hq_operators()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_mfa boolean := to_regclass('auth.mfa_factors') is not null; r jsonb;
begin
  perform public._hq_gate('hq_operators');
  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object('email', pa.email, 'bound', pa.user_id is not null, 'added_at', pa.added_at,
             'added_by', pa.added_by, 'require_mfa', pa.require_mfa, 'last_sign_in_at', u.last_sign_in_at,
             'mfa_enabled', %s, 'is_me', u.id is not null and u.id = auth.uid()) order by pa.added_at, pa.email), '[]'::jsonb)
      from public.platform_admins pa left join auth.users u on lower(u.email) = pa.email$q$,
    case when v_mfa then 'exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status::text = ''verified'')' else 'false' end)
    into r;
  return r;
end $$;

create or replace function public.hq_add_operator(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_uid uuid; v_by text;
begin
  perform public._hq_wgate('hq.operator.add', 'platform_admins', v_email);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'enter a valid e-mail' using errcode = '22023'; end if;
  if exists (select 1 from public.profiles p where lower(p.email) = v_email and p.org_id is not null)
     or exists (select 1 from public.profiles p join auth.users u on u.id = p.id where lower(u.email) = v_email and p.org_id is not null) then
    raise exception 'this e-mail belongs to a studio member — an HQ operator must have its own account' using errcode = '22023'; end if;
  if exists (select 1 from public.platform_admins where email = v_email) then raise exception 'already an operator' using errcode = '22023'; end if;
  select u.id into v_uid from auth.users u where lower(u.email) = v_email and u.email_confirmed_at is not null;
  select u.email into v_by from auth.users u where u.id = auth.uid();
  insert into public.platform_admins(email, added_by, user_id) values (v_email, coalesce(v_by, 'hq'), v_uid);
  return jsonb_build_object('email', v_email, 'bound', v_uid is not null);
end $$;

create or replace function public.hq_remove_operator(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_me text; v_row jsonb;
begin
  select lower(u.email) into v_me from auth.users u where u.id = auth.uid();
  select to_jsonb(pa) into v_row from public.platform_admins pa where pa.email = v_email;
  perform public._hq_wgate('hq.operator.remove', 'platform_admins', v_email, v_row);
  if v_row is null then raise exception 'not an operator' using errcode = '22023'; end if;
  perform 1 from public.platform_admins for update;
  if (select count(*) from public.platform_admins) <= 1 then raise exception 'the last operator can''t be removed' using errcode = '22023'; end if;
  if v_email = v_me then raise exception 'you can''t remove yourself' using errcode = '22023'; end if;
  delete from public.platform_admins where email = v_email;
  return jsonb_build_object('email', v_email, 'removed', true);
end $$;

-- ---- 7) studio side: read-only view of the studio's own subscription ---------------------------------
create or replace function public.my_subscription()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.studio_subscriptions; r jsonb;
begin
  if v_org is null then return null; end if;
  select * into s from public.studio_subscriptions where org_id = v_org;
  r := jsonb_build_object('status', s.status, 'read_only', coalesce(s.status = 'suspended', false));
  if coalesce(public.user_role(), '') <> 'admin' then return r; end if;
  return r || jsonb_build_object(
    'plan', (select jsonb_build_object('code', hp.code, 'name', hp.name, 'price_monthly', hp.price_monthly, 'currency', hp.currency)
               from public.helm_plans hp where hp.id = s.plan_id),
    'trial_ends_at', s.trial_ends_at, 'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', sp.id, 'invoice_no', sp.invoice_no, 'paid_on', sp.paid_on,
          'amount', sp.amount, 'currency', sp.currency, 'period_start', sp.period_start, 'period_end', sp.period_end,
          'method', sp.method, 'voided', sp.voided_at is not null) order by sp.paid_on desc, sp.recorded_at desc)
        from public.subscription_payments sp where sp.org_id = v_org), '[]'::jsonb));
end $$;

create or replace function public.my_invoice(p_payment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or coalesce(public.user_role(), '') <> 'admin' then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.subscription_payments sp where sp.id = p_payment_id and sp.org_id = v_org) then
    raise exception 'not found' using errcode = '42501'; end if;
  return public._sub_invoice_json(p_payment_id);
end $$;

-- ---- 8) provider settlement (dormant; service role only, idempotent on provider_payment_id) -------------
create or replace function public.hq_settle_provider_payment(p_provider_payment_id text, p_org uuid, p_amount numeric,
  p_paid_on date, p_period_start date default null, p_period_end date default null, p_currency text default 'INR',
  p_provider text default 'razorpay', p_provider_subscription_id text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_created boolean := false; v_ppid text := btrim(coalesce(p_provider_payment_id, ''));
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_ppid = '' or length(v_ppid) > 100 then raise exception 'provider_payment_id is required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('helm_settle:' || v_ppid));
  select id into v_id from public.subscription_payments where provider_payment_id = v_ppid;
  if v_id is null then
    v_id := public._sub_record_payment(p_org, p_amount, p_currency, p_paid_on, p_period_start, p_period_end, 'other',
              v_ppid, null, coalesce(nullif(btrim(p_provider), ''), 'razorpay'), v_ppid, p_provider_subscription_id);
    v_created := true;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'hq.payment.provider_settled', 'subscription_payments', v_id::text,
              jsonb_build_object('org_id', p_org, 'provider_payment_id', v_ppid, 'amount', p_amount), null, now());
  end if;
  return (select public._sub_payment_json(sp) || jsonb_build_object('created', v_created,
           'result', case when v_created then 'settled' else 'replay' end) from public.subscription_payments sp where sp.id = v_id);
end $$;

-- ---- 9) grants ------------------------------------------------------------------------------------------
do $$
declare fn text;
begin
  -- signed-in callers (each RPC checks operator / studio itself)
  foreach fn in array array['public.hq_overview()', 'public.hq_studios(text,text,int,int)', 'public.hq_studio_detail(uuid)',
      'public.hq_users(text,int,int)', 'public.hq_payments(date,date)', 'public.hq_refresh_billing_status()',
      'public.hq_billing(date,date)', 'public.hq_plans()', 'public.hq_upsert_plan(text,text,numeric,text,boolean)',
      'public.hq_set_subscription(uuid,text,text,date,date,date,text)', 'public.hq_suspend_studio(uuid,text)',
      'public.hq_reactivate_studio(uuid)', 'public.hq_record_payment(uuid,numeric,date,text,text,date,date,text)',
      'public.hq_void_payment(uuid,text)', 'public.hq_invoice(uuid)', 'public.hq_billing_settings()',
      'public.hq_set_billing_settings(text,text,text,numeric,text)', 'public.hq_audit(date,date)',
      'public.hq_operators()', 'public.hq_add_operator(text)', 'public.hq_remove_operator(text)',
      'public.my_subscription()', 'public.my_invoice(uuid)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || fn || ' to authenticated'; end if;
  end loop;
  -- internal only
  foreach fn in array array['public._hq_studio_rows()', 'public._hq_wgate(text,text,text,jsonb)', 'public._hq_money_by_currency(date,date)',
      'public._hq_mrr()', 'public._billing_refresh()',
      'public._sub_record_payment(uuid,numeric,text,date,date,date,text,text,uuid,text,text,text)',
      'public._sub_payment_json(public.subscription_payments)', 'public._sub_invoice_json(uuid)', 'public._studio_writable(uuid)',
      'public.tg_studio_read_only()', 'public._a45_attach_read_only_guards()', 'public.tg_subscription_payment_immutable()',
      'public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || fn || ' from authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text) to service_role;
    grant execute on function public._billing_refresh() to service_role;
    grant execute on function public._studio_writable(uuid) to service_role;
  end if;
end $$;

-- ---- 10) schedule the billing refresh (only when pg_cron is installed) -------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'helm_billing_refresh') then
      perform cron.schedule('helm_billing_refresh', '15 0 * * *', 'select public._billing_refresh()');
    end if;
  else
    raise notice '0045: pg_cron not installed — billing refresh runs when HQ opens Overview / Billing';
  end if;
end $$;
