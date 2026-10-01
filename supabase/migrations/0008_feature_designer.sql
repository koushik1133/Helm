-- ============================================================================
-- 0008_feature_designer.sql — CANONICAL feature-completeness (Design Studio).
-- The canonical base (2026-09-25) predates the Design Studio; the current app
-- depends on design_get/design_queue/design_advance, design_stages, the 'designer'
-- role and the 'design' area. This adds ONLY those missing objects (extracted from
-- completion/BUILD1-designer.sql — it does NOT redefine any hardened function).
-- It then installs the G4 quote<->org reject trigger on design_stages (which 0004
-- could not cover because the table did not yet exist), giving SEC-05 F3 protection
-- structurally: a designer cannot seed a design row for another studio's quote.
-- Idempotent. Forward-only.
-- ============================================================================
-- =====================================================================
-- BUILD 1 — Designer role + 2D->3D design-approval state machine
-- =====================================================================
-- Adds a dedicated `designer` role (BESIDE the existing 11, additive) and a
-- formal per-event design pipeline with validated state transitions, notifications,
-- audit, and optimistic locking. "The quote row IS the event" — design_stages.quote_id
-- is the event. All additive + idempotent. Zero data loss.
--
-- States: draft_2d -> internal_review -> approved_2d -> build_3d -> client_review
--         -> approved_3d -> locked   (with `revise` loop-backs, revision counter)
-- =====================================================================

-- 1) Widen the profiles role CHECK to allow 'designer' (additive: only expands the set)
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['admin','manager','planner','sales','coordinator',
    'supervisor','quality','operations','crew','worker','client','designer']));

-- 2) New area 'design' + seed role_access defaults for every existing org.
--    Admin bypasses has_area entirely (no rows needed). Designer gets design+layouts+
--    proposal+quotes; manager/planner get design edit; coordinator gets design view.
--    Matrix stays editable in Control Center afterwards. Idempotent via PK upsert.
insert into public.role_access (org_id, role, area, can_view, can_edit)
select o.id, v.role, v.area, v.can_view, v.can_edit
from public.organizations o
cross join (values
  -- designer: owns design + layouts, sees proposal/quotes/calendar/templates
  ('designer','design',     true,  true),
  ('designer','layouts',    true,  true),
  ('designer','quotes',     true,  false),
  ('designer','proposal',   true,  true),
  ('designer','calendar',   true,  false),
  ('designer','templates',  true,  false),
  ('designer','media',      true,  true),
  -- others gain the new design area at sensible defaults
  ('manager','design',      true,  true),
  ('planner','design',      true,  true),
  ('coordinator','design',  true,  false),
  ('sales','design',        true,  false),
  ('supervisor','design',   true,  false),
  ('quality','design',      true,  false),
  ('operations','design',   true,  false),
  ('crew','design',         false, false),
  ('worker','design',       false, false),
  ('client','design',       false, false)
) as v(role, area, can_view, can_edit)
on conflict (org_id, role, area) do nothing;   -- never clobber an operator's edits

-- 2b) Allow an 'in_app' notification channel (additive: widen the CHECK set only).
--     Design transitions raise in-app dashboard pings, not SMS/email.
alter table public.notifications drop constraint if exists notifications_channel_check;
alter table public.notifications add constraint notifications_channel_check
  check (channel = any (array['sms','email','in_app']));

-- 3) design_stages: one current design record per event (quote). History -> audit_log.
create table if not exists public.design_stages (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  state text not null default 'draft_2d',
  revision integer not null default 1,
  assigned_designer uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  org_id uuid not null default public.current_org_id(),
  constraint design_stages_pkey primary key (id),
  constraint design_stages_quote_uk unique (quote_id),
  constraint design_stages_quote_fk foreign key (quote_id) references public.quotes(id) on delete cascade,
  constraint design_stages_state_chk check (state = any (array[
    'draft_2d','internal_review','approved_2d','build_3d','client_review','approved_3d','locked','revise']))
);
create index if not exists ix_design_stages_org_state on public.design_stages (org_id, state);
-- Idempotently ensure the state CHECK includes the 'revise' loop-back state
-- (fixes a table that may have been created before 'revise' was added).
alter table public.design_stages drop constraint if exists design_stages_state_chk;
alter table public.design_stages add constraint design_stages_state_chk check (state = any (array[
  'draft_2d','internal_review','approved_2d','build_3d','client_review','approved_3d','locked','revise']));

-- 4) RLS: org + has_area('design'|'layouts'). Client sees only their own event at client_review+.
alter table public.design_stages enable row level security;
alter table public.design_stages force row level security;
drop policy if exists design_stages_select on public.design_stages;
drop policy if exists design_stages_write  on public.design_stages;
create policy design_stages_select on public.design_stages
  for select to authenticated
  using (org_id = public.current_org_id()
    and (public.has_area('design','view') or public.has_area('layouts','view')));
create policy design_stages_write on public.design_stages
  for all to authenticated
  using (org_id = public.current_org_id() and public.has_area('design','edit'))
  with check (org_id = public.current_org_id() and public.has_area('design','edit'));

-- 5) design_get(quote_id): current design record for an event (RLS-scoped read)
create or replace function public.design_get(p_quote_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when public.has_area('design','view') or public.has_area('layouts','view') then
    coalesce((
      select to_jsonb(d) from public.design_stages d
      where d.quote_id = p_quote_id and d.org_id = public.current_org_id()
    ), jsonb_build_object('quote_id', p_quote_id, 'state', null))
  else null end;
$$;
revoke all on function public.design_get(uuid) from anon, public;
grant execute on function public.design_get(uuid) to authenticated;

-- 6) design_queue(): designer's work queue — active design records grouped by state
create or replace function public.design_queue()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when public.has_area('design','view') then
    coalesce((
      select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from (
        select d.quote_id, d.state, d.revision, d.updated_at, q.code as event_code, q.title as event_title
        from public.design_stages d join public.quotes q on q.id = d.quote_id
        where d.org_id = public.current_org_id() and d.state <> 'locked'
      ) x
    ), '[]'::jsonb)
  else '[]'::jsonb end;
$$;
revoke all on function public.design_queue() from anon, public;
grant execute on function public.design_queue() to authenticated;

-- 7) design_advance(quote_id, to_state, note, expected_updated_at):
--    validates the transition, enforces has_area('design','edit'), optimistic-locks,
--    writes audit_log + a notification, bumps revision on a 'revise' loop-back.
create or replace function public.design_advance(
  p_quote_id uuid, p_to_state text, p_note text default null, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_uid uuid := auth.uid();
  v_cur text;
  v_rev integer;
  v_upd timestamptz;
  v_allowed boolean := false;
begin
  if not public.has_area('design','edit') then
    raise exception 'not authorized for design' using errcode='42501';
  end if;

  -- ensure a record exists (first advance seeds draft_2d)
  insert into public.design_stages (quote_id, state, org_id, updated_by)
  values (p_quote_id, 'draft_2d', v_org, v_uid)
  on conflict (quote_id) do nothing;

  select state, revision, updated_at into v_cur, v_rev, v_upd
  from public.design_stages
  where quote_id = p_quote_id and org_id = v_org
  for update;
  if not found then raise exception 'no such event in this org'; end if;

  -- optimistic lock (only when caller supplies the expected timestamp)
  if p_expected_updated_at is not null and v_upd is distinct from p_expected_updated_at then
    raise exception 'design record changed, reload' using errcode='40001';
  end if;

  -- allowed transitions (state machine). 'revise' loops back and bumps revision.
  v_allowed := (v_cur, p_to_state) in (
    ('draft_2d','internal_review'),
    ('internal_review','approved_2d'),
    ('internal_review','revise'),
    ('revise','draft_2d'),
    ('approved_2d','build_3d'),
    ('build_3d','client_review'),
    ('client_review','approved_3d'),
    ('client_review','revise'),
    ('approved_3d','locked'),
    ('approved_3d','client_review')   -- re-open for a further client tweak before lock
  );
  if not v_allowed then
    raise exception 'illegal design transition: % -> %', v_cur, p_to_state using errcode='22023';
  end if;

  update public.design_stages
     set state = p_to_state,
         revision = case when p_to_state = 'revise' then revision + 1 else revision end,
         note = coalesce(p_note, note),
         updated_at = now(),
         updated_by = v_uid
   where quote_id = p_quote_id and org_id = v_org;

  insert into public.audit_log (actor, action, entity, entity_id, quote_id, changed, org_id)
  values (v_uid, 'design.advance', 'design_stages', p_quote_id::text, p_quote_id,
          jsonb_build_object('from', v_cur, 'to', p_to_state, 'note', p_note), v_org);

  insert into public.notifications (quote_id, channel, kind, status, detail)
  values (p_quote_id, 'in_app', 'design_'||p_to_state, 'simulated',
          jsonb_build_object('from', v_cur, 'to', p_to_state));

  return jsonb_build_object('quote_id', p_quote_id, 'state', p_to_state,
    'revision', case when p_to_state='revise' then v_rev+1 else v_rev end, 'as_of', now());
end; $$;
revoke all on function public.design_advance(uuid, text, text, timestamptz) from anon, public;
grant execute on function public.design_advance(uuid, text, text, timestamptz) to authenticated;

-- VERIFY
select 'designer role allowed in profiles' as check,
  'designer' = any (string_to_array(
     replace(replace(pg_get_constraintdef(oid),'CHECK ((role = ANY (ARRAY[',''),'])))',''), ', '))
  is not null as ok
  from pg_constraint where conname='profiles_role_check'
union all
select 'design_stages RLS forced',
  (select relforcerowsecurity from pg_class where relname='design_stages')
union all
select 'design_advance revoked from anon (want true)',
  not has_function_privilege('anon','public.design_advance(uuid,text,text,timestamptz)','EXECUTE')
union all
select 'design_queue authenticated can execute',
  has_function_privilege('authenticated','public.design_queue()','EXECUTE');

-- ---- G4 coverage for the newly-created design_stages (SEC-05 F3 structural) ----
drop trigger if exists zz_quote_org_match on public.design_stages;
create trigger zz_quote_org_match before insert or update on public.design_stages
  for each row execute function public.tg_quote_org_match();
