-- =========================================================================
-- Event operations: crew, predefined task templates, event tasks, worker links.
-- Run ONCE (after setup-complete.sql + otp-payments.sql). Idempotent.
--
-- Flow: a confirmed event (quote) → manager assigns predefined tasks by category
-- to crew (all-to-one or split) → each crew member gets a no-login link
-- (work.html?token=) to Accept/Reject/Start/Complete → the manager dashboard
-- tracks every status live and can reassign a rejected task in one click.
-- Reuses _notify()/notifications (sms) and the can_edit() RBAC guard.
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

-- role helpers (redefined so this file stands alone)
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;

-- _notify() lives in otp-payments.sql; provide a fallback if that file wasn't run
create or replace function public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications(quote_id,channel,recipient,kind,status,detail)
    values (p_quote,p_channel,p_to,p_kind,'simulated',coalesce(p_detail,'{}'::jsonb));
exception when undefined_table then null;  -- notifications table not present → skip
end; $$;

-- ------------------------------------------------------------------ tables
create table if not exists public.crew_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  department text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists crew_dept_idx on public.crew_members(department) where active;

create table if not exists public.task_templates (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  title text not null,
  seq int not null default 0,
  default_duration_min int not null default 60,
  unique (category, title)
);

create table if not exists public.event_tasks (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  category text not null,
  title text not null,
  seq int not null default 0,
  crew_id uuid references public.crew_members(id) on delete set null,
  assignee_name text,
  assignee_phone text,
  status text not null default 'assigned'
    check (status in ('unassigned','assigned','accepted','rejected','in_progress','completed','cancelled')),
  note text,
  planned_end timestamptz,     -- Phase-2 scheduling (unused now)
  buffer_min int,              -- Phase-2
  depends_on uuid,             -- Phase-2
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz
);
create index if not exists etask_quote_idx on public.event_tasks(quote_id, category, seq);
create index if not exists etask_phone_idx on public.event_tasks(quote_id, assignee_phone);

create table if not exists public.work_tokens (
  token uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  phone text not null,
  name text,
  created_at timestamptz not null default now(),
  unique (quote_id, phone)
);

-- event → manager assignment ("event assigning")
alter table public.quotes add column if not exists manager_id uuid references auth.users(id);

-- ------------------------------------------------------------------ RLS
alter table public.crew_members enable row level security;
alter table public.event_tasks  enable row level security;
alter table public.work_tokens  enable row level security;
alter table public.task_templates enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('crew_members','event_tasks','work_tokens','task_templates')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
-- managers (authenticated) read everything; anon reaches tasks only via token RPCs
create policy "read templates" on public.task_templates for select to authenticated using ( true );
create policy "read crew"      on public.crew_members  for select to authenticated using ( true );
create policy "write crew"     on public.crew_members  for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read tasks"     on public.event_tasks   for select to authenticated using ( true );
create policy "read tokens"    on public.work_tokens   for select to authenticated using ( true );  -- managers copy the worker link
-- event_tasks/work_tokens writes go through SECURITY DEFINER RPCs only (no direct anon/authenticated write policy)

-- ------------------------------------------------------------------ seed templates (6 categories × ~18 tasks)
insert into public.task_templates(category,title,seq) values
 ('Stage','Confirm stage size & position',1),('Stage','Mark stage footprint',2),('Stage','Erect truss frame',3),
 ('Stage','Lay stage decking',4),('Stage','Level & lock platforms',5),('Stage','Skirt & drape the stage',6),
 ('Stage','Rig main backdrop',7),('Stage','Install side wings',8),('Stage','Place podium/lectern',9),
 ('Stage','Set up stairs & ramp',10),('Stage','Lay stage carpet',11),('Stage','Cable management on stage',12),
 ('Stage','Safety rails & edge guards',13),('Stage','Position monitors/wedges',14),('Stage','Décor on stage',15),
 ('Stage','Final stage cleaning',16),('Stage','Load-in remaining props',17),('Stage','Manager walkthrough & sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Decoration','Finalize theme & colours',1),('Decoration','Entrance arch setup',2),('Decoration','Aisle/pathway décor',3),
 ('Decoration','Floral centerpieces',4),('Decoration','Table linens & runners',5),('Decoration','Chair covers & sashes',6),
 ('Decoration','Backdrop florals',7),('Decoration','Balloon/prop installation',8),('Decoration','Drapes & fabric',9),
 ('Decoration','Welcome signage',10),('Decoration','Photo booth setup',11),('Decoration','Candle/lantern placement',12),
 ('Decoration','Stage floral accents',13),('Decoration','Perimeter greenery',14),('Decoration','Ceiling/canopy décor',15),
 ('Decoration','Touch-up & fluff',16),('Decoration','Remove packaging/waste',17),('Decoration','Décor walkthrough & sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Lighting','Survey power & DB points',1),('Lighting','Position generators/distro',2),('Lighting','Rig front truss',3),
 ('Lighting','Hang wash fixtures',4),('Lighting','Hang spot fixtures',5),('Lighting','Place uplighters on perimeter',6),
 ('Lighting','Install moving heads',7),('Lighting','Set up followspot',8),('Lighting','LED wall/screen power',9),
 ('Lighting','DMX patch & addressing',10),('Lighting','Focus & aim fixtures',11),('Lighting','Program scenes/cues',12),
 ('Lighting','Haze/fog machine setup',13),('Lighting','Cable ramps & safety',14),('Lighting','Dimmer/console test',15),
 ('Lighting','Full lighting test run',16),('Lighting','Blackout & failover check',17),('Lighting','Lighting sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Catering','Confirm menu & headcount',1),('Catering','Set up kitchen/prep area',2),('Catering','Position buffet counters',3),
 ('Catering','Live-counter setup',4),('Catering','Chafing dishes & warmers',5),('Catering','Beverage/bar station',6),
 ('Catering','Water & welcome drinks',7),('Catering','Crockery & cutlery',8),('Catering','Glassware setup',9),
 ('Catering','Serving staff briefing',10),('Catering','Cold storage/refrigeration',11),('Catering','Dessert station',12),
 ('Catering','Tasting & quality check',13),('Catering','Waste bins & disposal',14),('Catering','Hand-wash/sanitation',15),
 ('Catering','Replenishment plan',16),('Catering','Post-meal clearing',17),('Catering','Catering sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Labor','Confirm crew headcount',1),('Labor','Load-in from trucks',2),('Labor','Move furniture to zones',3),
 ('Labor','Chair layout as per plan',4),('Labor','Table placement',5),('Labor','Carpet/flooring lay',6),
 ('Labor','Assist stage team',7),('Labor','Assist décor team',8),('Labor','Assist lighting team',9),
 ('Labor','Barricades & queue posts',10),('Labor','Signage placement',11),('Labor','Waste clearing round',12),
 ('Labor','Restroom/porta setup',13),('Labor','Water points setup',14),('Labor','Standby during event',15),
 ('Labor','Teardown & load-out',16),('Labor','Site cleanup',17),('Labor','Labor sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Transportation','Plan vehicle & route',1),('Transportation','Confirm pickup schedule',2),('Transportation','Load stage material',3),
 ('Transportation','Load décor & florals',4),('Transportation','Load lighting/AV gear',5),('Transportation','Load catering equipment',6),
 ('Transportation','Load furniture & chairs',7),('Transportation','Dispatch to venue',8),('Transportation','Unload at venue',9),
 ('Transportation','Return empties',10),('Transportation','Guest shuttle (if any)',11),('Transportation','Fuel & toll settlement',12),
 ('Transportation','Standby vehicle on site',13),('Transportation','Post-event load-out',14),('Transportation','Return material to store',15),
 ('Transportation','Damage/inventory check',16),('Transportation','Driver briefing',17),('Transportation','Transport sign-off',18)
on conflict (category,title) do nothing;

-- ------------------------------------------------------------------ RPCs
-- assign a set of tasks (by title) in a category to one worker; returns the worker link token
create or replace function public.assign_tasks(
  p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; tok uuid; t text; n int := 0; s int;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes where id = p_quote_id;
  if q.id is null then raise exception 'no such event'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'valid worker phone required'; end if;
  -- ensure a work link exists for (event, phone)
  select token into tok from public.work_tokens where quote_id=p_quote_id and phone=p_phone;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,p_quote_id,p_phone,p_name); end if;
  foreach t in array coalesce(p_titles,'{}') loop
    select seq into s from public.task_templates where category=p_category and title=t;
    insert into public.event_tasks(quote_id,category,title,seq,crew_id,assignee_name,assignee_phone,status,created_by)
      values (p_quote_id,p_category,t,coalesce(s,999),p_crew_id,p_name,p_phone,'assigned',auth.uid());
    n := n + 1;
  end loop;
  perform public._notify(p_quote_id,'sms',p_phone,'task_assigned',
    jsonb_build_object('count',n,'category',p_category,'token',tok));
  return jsonb_build_object('work_token',tok,'tasks_created',n);
end; $$;

-- move a task to a different worker (after a reject or no-response)
create or replace function public.reassign_task(p_task_id uuid, p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare qt uuid; tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into qt from public.event_tasks where id=p_task_id;
  if qt is null then raise exception 'no such task'; end if;
  select token into tok from public.work_tokens where quote_id=qt and phone=p_phone;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,qt,p_phone,p_name); end if;
  update public.event_tasks set crew_id=p_crew_id, assignee_name=p_name, assignee_phone=p_phone,
    status='assigned', responded_at=null, started_at=null, completed_at=null where id=p_task_id;
  perform public._notify(qt,'sms',p_phone,'task_assigned', jsonb_build_object('reassigned',true,'token',tok));
  return jsonb_build_object('work_token',tok);
end; $$;

-- worker (no login): fetch my tasks for this event via my token
create or replace function public.worker_get_tasks(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; q public.quotes; tasks jsonb;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  select * into q from public.quotes where id=w.quote_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'title',title,'status',status
           ) order by category, seq), '[]'::jsonb) into tasks
    from public.event_tasks where quote_id=w.quote_id and assignee_phone=w.phone;
  return jsonb_build_object('event', jsonb_build_object('code',q.code,'title',q.title),
    'worker', jsonb_build_object('name',w.name,'phone',w.phone), 'tasks', tasks);
end; $$;

-- worker (no login): accept / reject / start / complete one of my tasks
create or replace function public.worker_respond(p_token uuid, p_task_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; tsk public.event_tasks; newst text;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  select * into tsk from public.event_tasks where id=p_task_id and quote_id=w.quote_id and assignee_phone=w.phone;
  if tsk.id is null then raise exception 'task not found'; end if;
  newst := case p_action
    when 'accept'   then 'accepted'
    when 'reject'   then 'rejected'
    when 'start'    then 'in_progress'
    when 'complete' then 'completed'
    else null end;
  if newst is null then raise exception 'invalid action'; end if;
  if p_action='start'    and tsk.status not in ('accepted','assigned') then raise exception 'accept the task first'; end if;
  if p_action='complete' and tsk.status not in ('in_progress','accepted') then raise exception 'start the task first'; end if;
  update public.event_tasks set status=newst,
    responded_at = case when p_action in ('accept','reject') then now() else responded_at end,
    started_at   = case when p_action='start'    then now() else started_at end,
    completed_at = case when p_action='complete' then now() else completed_at end
    where id=p_task_id;
  perform public._notify(w.quote_id,'sms',null,'task_'||p_action, jsonb_build_object('task',tsk.title,'worker',w.name));
  return jsonb_build_object('ok',true,'status',newst);
end; $$;

-- grants: manager RPCs → authenticated only; worker RPCs → anon + authenticated (token-scoped)
revoke all on function public.assign_tasks(uuid,text,text[],uuid,text,text) from anon;
revoke all on function public.reassign_task(uuid,uuid,text,text)          from anon;
grant execute on function public.assign_tasks(uuid,text,text[],uuid,text,text) to authenticated;
grant execute on function public.reassign_task(uuid,uuid,text,text)            to authenticated;
grant execute on function public.worker_get_tasks(uuid)          to anon, authenticated;
grant execute on function public.worker_respond(uuid,uuid,text)  to anon, authenticated;

-- verify
select 'crew_members' t, count(*) n from public.crew_members
union all select 'task_templates', count(*) from public.task_templates
union all select 'event_tasks', count(*) from public.event_tasks
union all select 'work_tokens', count(*) from public.work_tokens
union all select 'template_categories', count(distinct category) from public.task_templates;
