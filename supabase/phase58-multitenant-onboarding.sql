-- ============================================================================
-- Phase 58 — Self-serve onboarding + clean seeding + org branding (Block F, 3/3)
-- ---------------------------------------------------------------------------
-- create_studio(): a signed-in user with no studio yet creates one — becomes its
-- admin, and the new studio is seeded with CLEAN curated defaults (the role
-- matrix, task/checklist templates, plate/chair/dish catalogs, nurture templates,
-- default pricing) copied from Helm's library MINUS any '(testing)' rows. No
-- operational data (no contacts, staff, vendors, inventory, events).
-- Also: the client portal now carries the studio's name/branding.
-- Idempotent. Run AFTER phase56 + phase57.
-- ============================================================================

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
                      'chair_types','dish_catalog','nurture_templates','nurture_automation','app_config'];
  v_slug text;
begin
  if v_uid is null then raise exception 'must be signed in to create a studio' using errcode='42501'; end if;
  -- one studio per user: if they already belong to one, just return it
  select org_id into v_existing from public.profiles where id = v_uid;
  if v_existing is not null then return v_existing; end if;
  if coalesce(btrim(p_name),'') = '' then raise exception 'studio name required'; end if;

  v_org := gen_random_uuid();
  v_slug := left(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), 40) || '-' || left(v_org::text, 8);
  insert into public.organizations(id, name, slug, business_email, currency, timezone, created_by)
    values (v_org, p_name, v_slug, p_email, coalesce(p_currency,'INR'), coalesce(p_timezone,'Asia/Kolkata'), v_uid);

  -- make the creator this studio's admin (upsert covers the just-signed-up profile)
  insert into public.profiles(id, email, org_id, role)
    values (v_uid, coalesce(p_email, (select email from auth.users where id = v_uid)), v_org, 'admin')
  on conflict (id) do update set org_id = v_org, role = 'admin';

  -- seed clean curated defaults from Helm's library (dynamic per-table column copy,
  -- excluding identity/audit columns and any '(testing)' library rows)
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

-- client portal carries the studio's name + branding -------------------------
create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; prop public.event_proposal; ms jsonb; gal jsonb; outstanding numeric; studio jsonb;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  select * into prop from public.event_proposal where quote_id = q.id;
  select jsonb_build_object('name', o.name, 'brand', o.brand) into studio
    from public.organizations o where o.id = q.org_id;
  select coalesce(jsonb_agg(jsonb_build_object('label',label,'due_date',due_date,'amount',amount,'status',status)
                            order by seq, due_date), '[]'::jsonb)
    into ms from public.payment_milestones where quote_id = q.id;
  select coalesce(sum(amount),0) into outstanding
    from public.payment_milestones where quote_id = q.id and status not in ('paid','waived');
  select coalesce(jsonb_agg(jsonb_build_object('url',url,'kind',kind,'caption',caption)
                            order by seq, created_at), '[]'::jsonb)
    into gal from public.event_media where quote_id = q.id and in_gallery = true;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_type',q.event_type,
                                'event_date',q.event_date,'event_time',q.event_time,
                                'status',q.status,'stage',q.lifecycle_stage),
    'studio', studio,
    'client_name', coalesce(q.client->>'name',''),
    'approval_status', q.approval_status,
    'total', coalesce((q.pricing->>'total')::numeric, 0),
    'proposal', case when prop.quote_id is not null and prop.published
                  then jsonb_build_object('concept',prop.concept,'theme',prop.theme,
                                          'palette',prop.palette,'images',prop.images,'scope',prop.scope)
                  else null end,
    'payment', jsonb_build_object('milestones', ms, 'outstanding', outstanding),
    'gallery', gal);
end; $$;
grant execute on function public.public_get_portal(uuid) to anon, authenticated;

notify pgrst, 'reload schema';

-- verify
select 'create_studio' t, 'ok' s union all select 'portal_studio_brand','ok';
