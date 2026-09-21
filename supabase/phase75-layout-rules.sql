-- ============================================================================
-- Phase 75 — Admin-configurable default LAYOUT RULES per event type
-- ---------------------------------------------------------------------------
-- Embeds experienced planners' defaults as editable numbers so the layout
-- generator produces a sensible default per event type + guest count WITHOUT a
-- code change. Rules live as JSONB per event type, edited in the Control Centre.
-- Multi-tenant: org_id + cfg-style RLS (mirrors menu_templates / dish_catalog).
-- Idempotent. Run AFTER phase57 + phase58 + phase62.
-- ============================================================================

create table if not exists public.layout_rules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  event_type  text not null,
  rules       jsonb not null default '{}'::jsonb,   -- {seatsPerGuest, buffetPer, bars, stage, dancefloor, walkway, dj}
  active      boolean not null default true,
  seq         int not null default 0,
  created_at  timestamptz not null default now(),
  unique (org_id, event_type)
);
create index if not exists layout_rules_org_idx on public.layout_rules(org_id);

alter table public.layout_rules enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='layout_rules'
  loop execute format('drop policy if exists %I on public.layout_rules', p.policyname); end loop;
end $$;
create policy "cfg read"  on public.layout_rules for select to authenticated
  using ( org_id = (select public.current_org_id()) );
create policy "cfg write" on public.layout_rules for all to authenticated
  using ( public.has_area('controls','edit') and org_id = (select public.current_org_id()) )
  with check ( public.has_area('controls','edit') and org_id = (select public.current_org_id()) );

-- seed placeholder defaults for the Helm/default org (editable in Control Centre)
insert into public.layout_rules (org_id, event_type, seq, rules) values
('00000000-0000-4000-8000-000000000001','wedding',1,
  '{"seatsPerGuest":1,"buffetPer":75,"bars":1,"stage":true,"dancefloor":true,"walkway":true,"dj":true}'::jsonb),
('00000000-0000-4000-8000-000000000001','conference',2,
  '{"seatsPerGuest":1,"buffetPer":100,"bars":0,"stage":true,"dancefloor":false,"walkway":false,"dj":false}'::jsonb),
('00000000-0000-4000-8000-000000000001','concert',3,
  '{"seatsPerGuest":0.4,"buffetPer":150,"bars":2,"stage":true,"dancefloor":true,"walkway":false,"dj":true}'::jsonb),
('00000000-0000-4000-8000-000000000001','festival',4,
  '{"seatsPerGuest":0.3,"buffetPer":120,"bars":2,"stage":true,"dancefloor":true,"walkway":false,"dj":true}'::jsonb),
('00000000-0000-4000-8000-000000000001','political',5,
  '{"seatsPerGuest":1,"buffetPer":200,"bars":0,"stage":true,"dancefloor":false,"walkway":true,"dj":false}'::jsonb)
on conflict (org_id, event_type) do nothing;

-- wire create_studio() to seed layout_rules for new studios --------------------
create or replace function public.create_studio(
  p_name text, p_email text default null, p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_existing uuid;
  helm constant uuid := '00000000-0000-4000-8000-000000000001';
  t text; cols text; has_name boolean;
  lib text[] := array['role_access','task_templates','checklist_templates','plate_types',
                      'chair_types','dish_catalog','menu_templates','layout_rules','nurture_templates','nurture_automation','app_config'];
  v_slug text;
begin
  if v_uid is null then raise exception 'must be signed in to create a studio' using errcode='42501'; end if;
  select org_id into v_existing from public.profiles where id = v_uid;
  if v_existing is not null then return v_existing; end if;
  if coalesce(btrim(p_name),'') = '' then raise exception 'studio name required'; end if;

  v_org := gen_random_uuid();
  v_slug := left(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), 40) || '-' || left(v_org::text, 8);
  insert into public.organizations(id, name, slug, business_email, currency, timezone, created_by)
    values (v_org, p_name, v_slug, p_email, coalesce(p_currency,'INR'), coalesce(p_timezone,'Asia/Kolkata'), v_uid);

  insert into public.profiles(id, email, org_id, role)
    values (v_uid, coalesce(p_email, (select email from auth.users where id = v_uid)), v_org, 'admin')
  on conflict (id) do update set org_id = v_org, role = 'admin';

  foreach t in array lib loop
    if to_regclass('public.'||t) is null then continue; end if;
    select string_agg(quote_ident(column_name), ',') into cols
      from information_schema.columns
      where table_schema='public' and table_name=t
        and column_name not in ('id','org_id','created_at','updated_at','created_by','updated_by','locked_at','locked_by');
    if cols is null then continue; end if;
    has_name := exists(select 1 from information_schema.columns
                       where table_schema='public' and table_name=t and column_name='name');
    execute format(
      'insert into public.%I (org_id,%s) select %L,%s from public.%I where org_id=%L %s',
      t, cols, v_org, cols, t, helm,
      case when has_name then 'and coalesce(name,'''') not ilike ''%(testing)%''' else '' end);
  end loop;

  return v_org;
end; $$;
revoke all on function public.create_studio(text,text,text,text) from anon;
grant execute on function public.create_studio(text,text,text,text) to authenticated;

notify pgrst, 'reload schema';

select 'layout_rules' t, count(*)::text n from public.layout_rules;
