-- ============================================================================
-- HELM - 0065 client event booklet (one paste) (2026-10-08)
--   * client_booklets: one shared, read-only "event booklet" link per event
--     (public/booklet.html?t=<token>) with expiry + revoke. RLS on; members
--     read their own studio's rows (quotes view); writes only via the RPCs.
--   * booklet_share / booklet_revoke (quotes EDIT), booklet_current (quotes VIEW),
--     public_get_booklet (signed out; client-safe fields only; rate-limited +
--     logged). Suspended studios are read-only here like every studio table.
-- REQUIRES the base schema (has_area, current_org_id), 0040, 0045 and 0050.
-- WHAT IT TOUCHES: 1 new table (RLS on), 5 new functions, triggers on the new
-- table only. NO existing table or row is created, deleted or changed.
-- SAFE TO RE-RUN. Plain ASCII on purpose (the SQL editor mangles fancy characters).
-- ============================================================================
-- ============================================================================
-- 0065_client_booklet.sql - CANONICAL forward-only. The client "event booklet":
-- a read-only website the studio shares with its client (public/booklet.html?t=<token>).
-- REQUIRES the base schema (has_area, current_org_id), 0040 (quotes.deleted_at),
-- 0045 (tg_studio_read_only) and 0050 (rate_hit) - the preflight stops if missing.
--
-- In plain words:
--   * client_booklets - one row per shared booklet link: which studio, which event,
--     an unguessable token (random uuid), when it expires, whether it was revoked,
--     which quote versions the studio chose to show, optional terms and a note.
--     RLS on. Members of the SAME studio whose role may VIEW quotes can read the rows;
--     nobody writes the table directly - only through the functions below.
--   * booklet_share(event, days, versions, terms, note) - staff whose role may EDIT
--     quotes (has_area('quotes','edit')) create a new link for an event of their own
--     studio. Any older live link for that event is revoked first (one live link per
--     event). Links last 1..365 days (default 30).
--   * booklet_revoke(event) - same permission; revokes the live link at once.
--   * booklet_current(event) - quotes VIEW; the live link (or null) for the studio UI.
--   * public_get_booklet(token) - signed-out clients. Returns ONLY client-safe fields:
--     studio name / brand / contact, event details, venue, guests, the saved 2D layout
--     (shapes only), menu + selected menu package, the client-facing price lines and
--     totals, the shared quote versions (label, total, date, latest flag), payment
--     milestones and terms. NO internal costs, margins, vendors, staff notes, client
--     phone / e-mail or any other event. Expired, revoked, deleted or unknown tokens
--     all answer the same "invalid link". Reads are rate-limited per token (120 per
--     10 minutes) and logged to audit_log (at most one row per token per hour).
--   * Suspended studios are read-only here too (zzz_studio_read_only, like every
--     studio table). Clients and signed-out callers cannot share or revoke.
--
-- Additive + idempotent: 1 new table (RLS on), 4 new functions. NO existing table,
-- function or row is changed or deleted.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0065: has_area() is not installed'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception '0065: current_org_id() is not installed'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception '0065: 0050 (rate_hit) is not installed'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null then raise exception '0065: 0045 (tg_studio_read_only) is not installed'; end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.quotes'::regclass and attname = 'deleted_at' and not attisdropped) then
    raise exception '0065: 0040 (quotes.deleted_at) is not installed'; end if;
end $$;

create table if not exists public.client_booklets (
  id              uuid        primary key default gen_random_uuid(),
  org_id          uuid        not null default public.current_org_id(),
  quote_id        uuid        not null references public.quotes(id) on delete cascade,
  token           uuid        not null default gen_random_uuid(),
  shared_versions uuid[]      not null default '{}',
  terms           text,
  note            text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '30 days'),
  revoked_at      timestamptz,
  revoked_by      uuid,
  constraint client_booklets_terms_len check (terms is null or char_length(terms) <= 8000),
  constraint client_booklets_note_len check (note is null or char_length(note) <= 1000),
  constraint client_booklets_versions_len check (cardinality(shared_versions) <= 50)
);
create unique index if not exists client_booklets_token_key on public.client_booklets(token);
create index if not exists client_booklets_quote_idx on public.client_booklets(quote_id, created_at desc);
create unique index if not exists client_booklets_one_live on public.client_booklets(quote_id) where revoked_at is null;

alter table public.client_booklets enable row level security;
revoke all on table public.client_booklets from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.client_booklets from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.client_booklets from authenticated';
    execute 'grant select on table public.client_booklets to authenticated';
  end if;
end $$;
drop policy if exists client_booklets_read on public.client_booklets;
create policy client_booklets_read on public.client_booklets for select
  using (org_id = public.current_org_id() and public.has_area('quotes', 'view'));

-- suspended studios are read-only here too (0045 guard, like every studio table)
do $$ begin
  drop trigger if exists zzz_studio_read_only on public.client_booklets;
  create trigger zzz_studio_read_only before insert or update or delete on public.client_booklets
    for each row execute function public.tg_studio_read_only('org_id');
end $$;
-- the event must belong to the same studio (0004 guard) when that guard is installed
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    drop trigger if exists zz_quote_org_match on public.client_booklets;
    create trigger zz_quote_org_match before insert or update on public.client_booklets
      for each row execute function public.tg_quote_org_match();
  end if;
end $$;

-- ---- staff side ---------------------------------------------------------------------------
create or replace function public._booklet_staff_quote(p_quote_id uuid, p_edit boolean)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_role text; v_q uuid;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = v_me and p.org_id = v_org;
  if v_role is null or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('quotes', case when p_edit then 'edit' else 'view' end) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select q.id into v_q from public.quotes q where q.id = p_quote_id and q.org_id = v_org and q.deleted_at is null;
  if v_q is null then raise exception 'event not found' using errcode = 'P0002'; end if;
  return v_org;
end $$;

create or replace function public.booklet_share(p_quote_id uuid, p_days integer default 30,
  p_version_ids uuid[] default null, p_terms text default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid; v_days int; v_vers uuid[]; r public.client_booklets;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);
  v_days := greatest(1, least(365, coalesce(p_days, 30)));
  if p_version_ids is null then
    select coalesce(array_agg(v.id order by v.created_at), '{}') into v_vers
      from public.quotation_versions v where v.quote_id = p_quote_id and v.org_id = v_org;
  else
    select coalesce(array_agg(v.id order by v.created_at), '{}') into v_vers
      from public.quotation_versions v where v.quote_id = p_quote_id and v.org_id = v_org and v.id = any(p_version_ids);
  end if;
  v_vers := v_vers[greatest(1, cardinality(v_vers) - 49):];
  update public.client_booklets b set revoked_at = now(), revoked_by = auth.uid()
   where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  insert into public.client_booklets(org_id, quote_id, shared_versions, terms, note, created_by, expires_at)
    values (v_org, p_quote_id, coalesce(v_vers, '{}'), nullif(btrim(left(coalesce(p_terms, ''), 8000)), ''),
            nullif(btrim(left(coalesce(p_note, ''), 1000)), ''), auth.uid(), now() + make_interval(days => v_days))
    returning * into r;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'booklet.share', 'client_booklets', r.id::text, p_quote_id,
            jsonb_build_object('expires_at', r.expires_at, 'versions', cardinality(r.shared_versions)), v_org);
  return jsonb_build_object('id', r.id, 'token', r.token, 'expires_at', r.expires_at, 'created_at', r.created_at,
                            'shared_versions', to_jsonb(r.shared_versions));
end $$;

create or replace function public.booklet_revoke(p_quote_id uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid; n int;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);
  update public.client_booklets b set revoked_at = now(), revoked_by = auth.uid()
   where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, org_id)
      values (auth.uid(), 'booklet.revoke', 'client_booklets', p_quote_id::text, p_quote_id, v_org);
  end if;
  return n;
end $$;

create or replace function public.booklet_current(p_quote_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; r public.client_booklets;
begin
  v_org := public._booklet_staff_quote(p_quote_id, false);
  select * into r from public.client_booklets b
   where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null
   order by b.created_at desc limit 1;
  if r.id is null then return null; end if;
  return jsonb_build_object('id', r.id, 'token', r.token, 'expires_at', r.expires_at, 'created_at', r.created_at,
                            'expired', r.expires_at <= now(), 'shared_versions', to_jsonb(r.shared_versions),
                            'terms', r.terms, 'note', r.note);
end $$;

-- ---- client side (signed out) -----------------------------------------------------------
create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.client_booklets; q public.quotes; v_key text; v_wait int;
  v_studio jsonb; v_plan jsonb; v_layout jsonb; v_menu jsonb; v_pkg jsonb; v_versions jsonb;
  v_ms jsonb; v_paid numeric; v_due numeric; p jsonb; c jsonb; v_pricing jsonb; v_guests numeric;
  v_latest uuid; v_data jsonb;
begin
  if p_token is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  v_key := md5('booklet:' || p_token::text);
  v_wait := public.rate_hit('booklet.read', v_key, 600, 120);
  if v_wait > 0 then raise exception 'too many requests - try again in % seconds', v_wait using errcode = 'P0001'; end if;

  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null or b.revoked_at is not null or b.expires_at <= now() then
    raise exception 'invalid link' using errcode = 'P0001'; end if;
  select * into q from public.quotes x where x.id = b.quote_id and x.org_id = b.org_id and x.deleted_at is null;
  if q.id is null then raise exception 'invalid link' using errcode = 'P0001'; end if;

  if public.rate_hit('booklet.log', v_key, 3600, 1) = 0 then
    insert into public.audit_log(action, entity, entity_id, quote_id, org_id)
      values ('booklet.view', 'client_booklets', b.id::text, q.id, q.org_id);
  end if;

  select jsonb_build_object('name', o.name, 'email', o.business_email, 'location', o.location,
           'phone', case when jsonb_typeof(o.brand -> 'phone') = 'string' then left(o.brand ->> 'phone', 40) end,
           'accent', case when (o.brand ->> 'accent') ~* '^#([0-9a-f]{3}|[0-9a-f]{6})$' then o.brand ->> 'accent' end,
           'logo', case when (o.brand ->> 'logo') ~* '^https://[^\s"<>]+$' and char_length(o.brand ->> 'logo') <= 500 then o.brand ->> 'logo' end)
    into v_studio from public.organizations o where o.id = q.org_id;

  select jsonb_build_object('venue_name', ep.venue_name, 'venue_address', ep.venue_address,
           'package', ep.package, 'menu', ep.menu, 'menu_locked', ep.menu_locked,
           'menu_template', ep.menu_template, 'menu_plate_price', ep.menu_plate_price)
    into v_plan from public.event_plan ep where ep.quote_id = q.id and ep.org_id = q.org_id;

  -- the saved 2D layout of the current version: shapes only (no prices, no notes)
  select v.data into v_data from public.quote_versions v
   where v.quote_id = q.id and v.org_id = q.org_id order by (v.version_no = q.current_version) desc, v.version_no desc limit 1;
  select jsonb_build_object(
           'room', case when jsonb_typeof(v_data #> '{venue,room}') = 'object'
                        then jsonb_build_object('w', v_data #> '{venue,room,w}', 'h', v_data #> '{venue,room,h}') end,
           'items', coalesce((select jsonb_agg(jsonb_build_object(
               'type', left(it ->> 'type', 40), 'category', left(it ->> 'category', 40), 'label', left(it ->> 'label', 80),
               'x', it -> 'x', 'y', it -> 'y', 'width', it -> 'width', 'height', it -> 'height',
               'rotation', it -> 'rotation', 'color', case when (it ->> 'color') ~* '^#[0-9a-f]{3,8}$' then it ->> 'color' end))
             from (select it from jsonb_array_elements(case when jsonb_typeof(v_data -> 'items') = 'array' then v_data -> 'items' else '[]'::jsonb end) it limit 3000) s
             where jsonb_typeof(it) = 'object'), '[]'::jsonb))
    into v_layout;

  select coalesce(jsonb_agg(jsonb_build_object('name', m.dish_name, 'category', m.category, 'kind', m.kind) order by m.seq, m.dish_name), '[]'::jsonb)
    into v_menu from public.event_menu_items m where m.quote_id = q.id and m.org_id = q.org_id;
  if v_plan is not null and nullif(v_plan ->> 'menu_template', '') is not null then
    select jsonb_build_object('name', t.name, 'tier', t.tier, 'diet', t.diet, 'price_per_plate', t.price_per_plate, 'dishes', t.dishes)
      into v_pkg from public.menu_templates t
     where t.org_id = q.org_id and t.name = v_plan ->> 'menu_template' order by t.active desc, t.seq limit 1;
  end if;

  -- client-facing price lines only (allow-list; vendors, notes and costs never leave)
  p := case when jsonb_typeof(q.pricing) = 'object' then q.pricing else '{}'::jsonb end;
  c := case when jsonb_typeof(p -> 'computed') = 'object' then p -> 'computed' else '{}'::jsonb end;
  v_pricing := jsonb_strip_nulls(jsonb_build_object(
    'chairs', p -> 'chairs', 'chairPrice', p -> 'chairPrice', 'guests', p -> 'guests', 'platePrice', p -> 'platePrice',
    'other', p -> 'other', 'serviceChargePct', p -> 'serviceChargePct', 'discount', p -> 'discount',
    'discountPct', p -> 'discountPct', 'gstPct', p -> 'gstPct', 'placeOfSupply', p -> 'placeOfSupply',
    'couponCode', p -> 'couponCode', 'currency', p -> 'currency',
    'cateringMode', p #> '{catering,mode}', 'cateringAmount', p #> '{catering,amount}',
    'computed', jsonb_strip_nulls(jsonb_build_object('rental', c -> 'rental', 'plateSub', c -> 'plateSub',
      'cateringAmt', c -> 'cateringAmt', 'cateringBucket', c -> 'cateringBucket', 'serviceCharge', c -> 'serviceCharge',
      'subtotal', c -> 'subtotal', 'discount', c -> 'discount', 'totalGst', c -> 'totalGst', 'cgst', c -> 'cgst',
      'sgst', c -> 'sgst', 'igst', c -> 'igst', 'total', c -> 'total')),
    'total', p -> 'total'));
  v_guests := case when (p ->> 'guests') ~ '^[0-9]{1,7}(\.[0-9]+)?$' then (p ->> 'guests')::numeric
                   when (q.client ->> 'guests') ~ '^[0-9]{1,7}$' then (q.client ->> 'guests')::numeric end;

  select v.id into v_latest from public.quotation_versions v
   where v.quote_id = q.id and v.org_id = q.org_id order by v.created_at desc, v.id desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('label', v.label, 'total', v.total, 'created_at', v.created_at,
           'latest', v.id = v_latest) order by v.created_at desc), '[]'::jsonb)
    into v_versions from public.quotation_versions v
   where v.quote_id = q.id and v.org_id = q.org_id and v.id = any(b.shared_versions);

  select coalesce(jsonb_agg(jsonb_build_object('label', m.label, 'due_date', m.due_date, 'amount', m.amount, 'status', m.status)
           order by m.seq, m.due_date), '[]'::jsonb),
         coalesce(sum(m.amount) filter (where m.status = 'paid'), 0),
         coalesce(sum(m.amount) filter (where m.status not in ('paid', 'waived')), 0)
    into v_ms, v_paid, v_due from public.payment_milestones m where m.quote_id = q.id and m.org_id = q.org_id;

  return jsonb_build_object(
    'studio', coalesce(v_studio, '{}'::jsonb),
    'event', jsonb_build_object('code', q.code, 'title', q.title, 'event_type', q.event_type,
      'event_date', q.event_date, 'event_time', q.event_time, 'client_name', coalesce(q.client ->> 'name', ''),
      'guests', v_guests, 'venue_name', coalesce(v_plan ->> 'venue_name', nullif(q.client ->> 'venue', '')),
      'venue_address', coalesce(v_plan ->> 'venue_address', nullif(q.client ->> 'address', ''))),
    'layout', v_layout,
    'menu', jsonb_build_object('items', v_menu, 'package', v_plan -> 'package', 'menu', v_plan -> 'menu',
      'locked', coalesce((v_plan ->> 'menu_locked')::boolean, false), 'plate_price', v_plan -> 'menu_plate_price',
      'selected_package', v_pkg),
    'quote', v_pricing,
    'versions', v_versions,
    'payments', jsonb_build_object('milestones', v_ms, 'paid', v_paid, 'outstanding', v_due),
    'terms', b.terms, 'note', b.note, 'expires_at', b.expires_at, 'shared_at', b.created_at);
end $$;

-- ---- privileges ------------------------------------------------------------------------
revoke all on function public._booklet_staff_quote(uuid, boolean) from public;
revoke all on function public.booklet_share(uuid, integer, uuid[], text, text) from public;
revoke all on function public.booklet_revoke(uuid) from public;
revoke all on function public.booklet_current(uuid) from public;
revoke all on function public.public_get_booklet(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._booklet_staff_quote(uuid, boolean) from anon';
    execute 'revoke all on function public.booklet_share(uuid, integer, uuid[], text, text) from anon';
    execute 'revoke all on function public.booklet_revoke(uuid) from anon';
    execute 'revoke all on function public.booklet_current(uuid) from anon';
    execute 'grant execute on function public.public_get_booklet(uuid) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._booklet_staff_quote(uuid, boolean) from authenticated';
    execute 'grant execute on function public.booklet_share(uuid, integer, uuid[], text, text) to authenticated';
    execute 'grant execute on function public.booklet_revoke(uuid) to authenticated';
    execute 'grant execute on function public.booklet_current(uuid) to authenticated';
    execute 'grant execute on function public.public_get_booklet(uuid) to authenticated';
  end if;
end $$;

-- ---- verify (every row should say ok = true) -----------------------------------------------
select item, ok from (values
  ('client_booklets table exists', to_regclass('public.client_booklets') is not null),
  ('client_booklets has RLS on', (select relrowsecurity from pg_class where oid = 'public.client_booklets'::regclass)),
  ('client_booklets 1 read policy', (select count(*) = 1 from pg_policies where schemaname = 'public' and tablename = 'client_booklets')),
  ('client_booklets not for anon', not has_table_privilege('anon', 'public.client_booklets', 'select')),
  ('members cannot write directly', not has_table_privilege('authenticated', 'public.client_booklets', 'insert')),
  ('suspended-studio guard attached', exists (select 1 from pg_trigger where tgrelid = 'public.client_booklets'::regclass and tgname = 'zzz_studio_read_only')),
  ('token is unique', to_regclass('public.client_booklets_token_key') is not null),
  ('one live link per event', to_regclass('public.client_booklets_one_live') is not null),
  ('share RPC for members', has_function_privilege('authenticated', 'public.booklet_share(uuid,integer,uuid[],text,text)', 'execute')),
  ('share RPC not for anon', not has_function_privilege('anon', 'public.booklet_share(uuid,integer,uuid[],text,text)', 'execute')),
  ('revoke RPC not for anon', not has_function_privilege('anon', 'public.booklet_revoke(uuid)', 'execute')),
  ('public reader for anon', has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')),
  ('internal helper not callable', not has_function_privilege('authenticated', 'public._booklet_staff_quote(uuid,boolean)', 'execute'))
) v(item, ok);
