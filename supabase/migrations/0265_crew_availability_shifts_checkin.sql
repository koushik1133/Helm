-- 0265_crew_availability_shifts_checkin.sql - CANONICAL forward-only.
-- REQUIRES base crew_members / event_tasks / work_tokens / event_day / app_config, 0012 + 0042 + 0154 (_work_token_live:
--          liveness + per-link and per-IP rate limit), 0132 (assign_notify_outbox + _assign132_phone), 0198
--          (_a198_org_today), 0246 + 0252 (_r21_cost_lines: the event cost ledger).
--
-- In plain words (r23 owner, INDUSTRY-BENCHMARK-PLAN.md F7 "Staff and crew scheduling", the Deputy / When I Work /
-- Homebase model) - marker r23-crew-0265:
--   1  CREW AVAILABILITY. Each crew member marks days they are NOT available (or available again) on their own crew
--      link (work.html) - today up to 120 days ahead. Staff admins can mark it for them on the Staff page. NEW table
--      crew_availability (one row per person per day; "available again" updates the row, nothing is deleted).
--      crew_day_status(date) tells the Assign screens who is unavailable or already booked on another event that day,
--      so Operations warns before double-booking.
--   2  OPEN SHIFTS. A coordinator posts an open shift for an event: role (e.g. Waiter), date + time, wage (per day or
--      per hour), how many people, optional department (only that department may claim), first-come or "needs
--      approval". NEW tables open_shifts + open_shift_claims. Eligible crew get ONE WhatsApp message QUEUED in the 0132
--      assign_notify_outbox (item kind 'open_shift', dormant: comms-dispatch sends only when the studio's WhatsApp is
--      on) with their own crew link, and the shift shows on every crew link of theirs. One tap claims it:
--        first-come -> the claim is approved at once, an event task is created for them (status accepted) and the
--                      shift closes itself as "filled" when enough people have it;
--        approval   -> the claim waits; the office approves / declines on Operations (approve creates the task).
--      The claim takes a row lock on the shift, so two people can never take the last place. A crew member who
--      later rejects that task frees the place again (the shift re-opens).
--   3  SELF CHECK-IN. On the event day the crew link shows Check in / Check out. The time is the SERVER's time.
--      If the event has a check-in location (Operations -> lat / lng + radius) and the studio switched on the
--      location check, the phone's location must be within the radius (only the DISTANCE is stored, never the
--      coordinates). Late (after the start + grace minutes) is flagged and the office is told; no check-in long
--      after the start shows as "no-show?" on the timesheet. NEW table crew_checkins; every check-in / out also
--      updates the event-day arrival roster (arrived / left), so command.html, closure and the 0246 ledger keep
--      working exactly as before. The office can enter or correct times (the crew's original times are kept).
--   4  ACTUAL WAGES. _r21_cost_lines (the 0246 ledger) section D: Actual = day rate x days checked in, or hours x
--      hourly rate (pay basis "hours" in Control Center, or a shift posted per hour; hourly = day rate / day
--      hours); a shift's posted wage replaces the day rate for that event; a person marked "left" on the roster
--      counts as arrived (they were there). Without check-ins / shift wages / hourly pay every number is the same
--      as 0252. Everything else in the function is the 0252 body unchanged.
--   5  CONTROL CENTER. app_config key 'crew' (one row per studio, merged): availability on, open shifts on,
--      default claim mode first_come, WhatsApp shift notices on, self check-in on, location check off (radius
--      300 m), late grace 15 min, no-show after 60 min, pay basis day, day hours 8. get_crew_settings /
--      set_crew_settings (Control Center edit).
-- SECURITY: crew-link RPCs take the work-link token and go through _work_token_live (invalid / expired / revoked /
--   deactivated / shelved event refused; 120 calls a minute per link, 600 per IP). The person is the ACTIVE crew
--   member of the link's own studio with the link's phone; everything is scoped to that studio. Extra limits: 100
--   availability changes and 20 claims an hour per person. New tables: RLS on, read for Staff view of the same
--   studio, NO direct writes (functions only), studio read-only lock (tg_studio_read_only) on every table.
-- DRIFT-SAFE: _r21_cost_lines is replaced only while it is the 0252 body (or already this one); assign_notify_claim
--   gets one added 'open_shift' branch only while it is the 0132 body; the assign_notify_outbox item_kind check is
--   widened once to a superset (every existing row still passes).
-- TRIAL RETENTION: the 5 new tables join the 0184 purge list (owner switch, off by default) next to the other event rows.
-- ZERO DATA LOSS: 5 new tables, new functions, 1 new trigger on event_tasks (reopens a shift when its task is
--   rejected), 2 function bodies replaced in place (above). No table, column, row, policy or trigger is dropped;
--   no existing row is updated by this file. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved):
--   re-run supabase/migrations/0252_crew_wages_unassigned.sql (ledger back to the roster-only wages);
--   re-run the 0132 assign_notify_claim body (queued 'open_shift' rows are then skipped);
--   drop trigger zz_r23_shift_task_release on public.event_tasks;
--   revoke execute on the r23 functions from anon, authenticated (the tables can stay - nothing reads them then).

do $$ begin
  if to_regprocedure('public._work_token_live(uuid)') is null then
    raise exception 'STOP 0265: apply 0012 + 0042 + 0154 (_work_token_live) first'; end if;
  if to_regclass('public.assign_notify_outbox') is null or to_regprocedure('public._assign132_phone(text)') is null then
    raise exception 'STOP 0265: apply 0132 (assign_notify_outbox) first'; end if;
  if to_regprocedure('public._a198_org_today(uuid)') is null then
    raise exception 'STOP 0265: apply 0198 (_a198_org_today) first'; end if;
  if to_regprocedure('public._r21_cost_lines(uuid,uuid)') is null then
    raise exception 'STOP 0265: apply 0246 + 0252 (_r21_cost_lines) first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.helm_norm_phone(text)') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'STOP 0265: phase29 / 0020 helpers (has_area, current_org_id, helm_norm_phone, is_admin) missing'; end if;
  if to_regclass('public.app_config') is null or to_regclass('public.event_day') is null then
    raise exception 'STOP 0265: app_config / event_day missing'; end if;
end $$;

-- ============================================================================================================
-- 1) tables
-- ============================================================================================================
create table if not exists public.crew_availability (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  crew_id     uuid not null references public.crew_members(id) on delete cascade,
  day         date not null,
  status      text not null check (status in ('unavailable', 'available')),
  note        text check (note is null or char_length(note) <= 200),
  source      text not null default 'crew' check (source in ('crew', 'office')),
  set_by      uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (crew_id, day)
);
create index if not exists crew_availability_org_day_idx on public.crew_availability (org_id, day);

create table if not exists public.open_shifts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id() references public.organizations(id),
  quote_id      uuid not null references public.quotes(id) on delete cascade,
  title         text not null check (char_length(title) between 2 and 80),
  department    text check (department is null or char_length(department) <= 60),
  shift_date    date not null,
  start_time    time,
  end_time      time,
  wage          numeric check (wage is null or (wage >= 0 and wage < 10000000)),
  wage_basis    text not null default 'day' check (wage_basis in ('day', 'hour')),
  needed        integer not null default 1 check (needed between 1 and 100),
  claim_mode    text not null default 'first_come' check (claim_mode in ('first_come', 'approval')),
  task_category text not null default 'Crew' check (char_length(task_category) between 1 and 60),
  note          text check (note is null or char_length(note) <= 500),
  status        text not null default 'open' check (status in ('open', 'filled', 'closed', 'cancelled')),
  notified      integer not null default 0,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz
);
create index if not exists open_shifts_quote_idx on public.open_shifts (quote_id);
create index if not exists open_shifts_open_idx on public.open_shifts (org_id, shift_date) where status = 'open';

create table if not exists public.open_shift_claims (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id),
  shift_id        uuid not null references public.open_shifts(id) on delete cascade,
  quote_id        uuid not null references public.quotes(id) on delete cascade,
  crew_id         uuid not null references public.crew_members(id) on delete cascade,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  task_id         uuid references public.event_tasks(id) on delete set null,
  claimed_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid,
  decline_reason  text check (decline_reason is null or char_length(decline_reason) <= 300),
  unique (shift_id, crew_id)
);
create index if not exists open_shift_claims_quote_idx on public.open_shift_claims (quote_id, crew_id);
create index if not exists open_shift_claims_task_idx on public.open_shift_claims (task_id) where task_id is not null;

create table if not exists public.crew_checkins (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id),
  quote_id          uuid not null references public.quotes(id) on delete cascade,
  crew_id           uuid not null references public.crew_members(id) on delete cascade,
  work_day          date not null,
  check_in_at       timestamptz not null,
  check_out_at      timestamptz,
  expected_start    timestamptz,
  late_min          integer check (late_min is null or late_min >= 0),
  in_distance_m     integer check (in_distance_m is null or in_distance_m >= 0),
  in_accuracy_m     integer check (in_accuracy_m is null or in_accuracy_m >= 0),
  in_within         boolean,
  out_distance_m    integer check (out_distance_m is null or out_distance_m >= 0),
  out_within        boolean,
  source            text not null default 'crew' check (source in ('crew', 'office')),
  orig_check_in_at  timestamptz,
  orig_check_out_at timestamptz,
  edited_by         uuid,
  edited_at         timestamptz,
  edit_note         text check (edit_note is null or char_length(edit_note) <= 300),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (quote_id, crew_id, work_day),
  check (check_out_at is null or (check_out_at >= check_in_at and check_out_at - check_in_at <= interval '24 hours'))
);
create index if not exists crew_checkins_org_idx on public.crew_checkins (org_id, work_day);

create table if not exists public.event_checkin_sites (
  quote_id    uuid primary key references public.quotes(id) on delete cascade,
  org_id      uuid not null references public.organizations(id),
  lat         numeric(9, 6) check (lat is null or (lat between -90 and 90)),
  lng         numeric(9, 6) check (lng is null or (lng between -180 and 180)),
  radius_m    integer not null default 300 check (radius_m between 50 and 5000),
  set_by      uuid,
  updated_at  timestamptz not null default now(),
  check ((lat is null) = (lng is null))
);

-- RLS: read for the same studio's Staff viewers (check-ins also Event-day viewers); no direct writes
do $$
declare t text;
begin
  foreach t in array array['crew_availability', 'open_shifts', 'open_shift_claims', 'crew_checkins', 'event_checkin_sites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant all on table public.%I to service_role', t); end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'r23 read') then
      if t in ('crew_checkins', 'event_checkin_sites') then
        execute format('create policy "r23 read" on public.%I for select to authenticated using '
          || '((public.has_area(''staff'', ''view'') or public.has_area(''command'', ''view'')) and org_id = (select public.current_org_id()))', t);
      else
        execute format('create policy "r23 read" on public.%I for select to authenticated using '
          || '(public.has_area(''staff'', ''view'') and org_id = (select public.current_org_id()))', t);
      end if;
    end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I '
        || 'for each row execute function public.tg_studio_read_only(''org_id'')', t);
    end if;
    -- G4: a row's quote must belong to the same studio; a named crew member too
    if t <> 'crew_availability' and to_regprocedure('public.tg_quote_org_match()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zz_quote_org_match') then
      execute format('create trigger zz_quote_org_match before insert or update on public.%I '
        || 'for each row execute function public.tg_quote_org_match()', t);
    end if;
    if t in ('crew_availability', 'open_shift_claims', 'crew_checkins') and to_regprocedure('public.tg_ref_org_match()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zz_ref_org_match_crew_id') then
      execute format('create trigger zz_ref_org_match_crew_id before insert or update of crew_id, org_id on public.%I '
        || 'for each row execute function public.tg_ref_org_match(''crew_id'', ''crew_members'')', t);
    end if;
  end loop;
end $$;

-- trial retention (0184, owner switch, off by default): the new tables are part of a studio's event / staff records
-- (purged with them for an ended free trial, children before quotes / crew_members)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''open_shift_claims''' in v_def) > 0 then return; end if;
  if position('''event_close_overrides'', ' in v_def) = 0 then
    raise notice '0265: _tr184_purge_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''event_close_overrides'', ',
    '''event_close_overrides'', ''open_shift_claims'', ''open_shifts'', ''crew_checkins'', ''event_checkin_sites'', ''crew_availability'', ');
end $$;

-- ============================================================================================================
-- 2) helpers (internal - never callable by the app)
-- ============================================================================================================
-- the studio's crew settings, defaults filled in, every value type / range checked
create or replace function public._r23_cfg(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265
declare v jsonb; d jsonb := jsonb_build_object(
  'availability', true, 'openShifts', true, 'claimMode', 'first_come', 'notifyShifts', true,
  'selfCheckin', true, 'geofence', false, 'geofenceRadiusM', 300, 'lateGraceMin', 15, 'noShowAfterMin', 60,
  'payBasis', 'day', 'dayHours', 8);
  k text; n numeric;
begin
  select c.value into v from public.app_config c where c.org_id = p_org and c.key = 'crew';
  if v is null or jsonb_typeof(v) <> 'object' then return d; end if;
  foreach k in array array['availability', 'openShifts', 'notifyShifts', 'selfCheckin', 'geofence'] loop
    if jsonb_typeof(v -> k) = 'boolean' then d := d || jsonb_build_object(k, v -> k); end if;
  end loop;
  if v ->> 'claimMode' in ('first_come', 'approval') then d := d || jsonb_build_object('claimMode', v ->> 'claimMode'); end if;
  if v ->> 'payBasis' in ('day', 'hours') then d := d || jsonb_build_object('payBasis', v ->> 'payBasis'); end if;
  if jsonb_typeof(v -> 'geofenceRadiusM') = 'number' then n := (v ->> 'geofenceRadiusM')::numeric;
    if n between 50 and 5000 then d := d || jsonb_build_object('geofenceRadiusM', round(n)); end if; end if;
  if jsonb_typeof(v -> 'lateGraceMin') = 'number' then n := (v ->> 'lateGraceMin')::numeric;
    if n between 0 and 240 then d := d || jsonb_build_object('lateGraceMin', round(n)); end if; end if;
  if jsonb_typeof(v -> 'noShowAfterMin') = 'number' then n := (v ->> 'noShowAfterMin')::numeric;
    if n between 15 and 720 then d := d || jsonb_build_object('noShowAfterMin', round(n)); end if; end if;
  if jsonb_typeof(v -> 'dayHours') = 'number' then n := (v ->> 'dayHours')::numeric;
    if n between 1 and 24 then d := d || jsonb_build_object('dayHours', round(n, 1)); end if; end if;
  return d;
end $$;

create or replace function public._r23_tz(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265
declare v text;
begin
  select coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata') into v from public.organizations o where o.id = p_org;
  v := coalesce(v, 'Asia/Kolkata');
  begin perform now() at time zone v; exception when others then v := 'Asia/Kolkata'; end;
  return v;
end $$;

-- "18:30", "6:30 pm", "6 PM" -> time (anything else -> null)
create or replace function public._r23_parse_time(p text)
returns time language plpgsql immutable set search_path = '' as $$
-- r23-crew-0265
declare m text[]; h int; mi int;
begin
  if p is null then return null; end if;
  m := regexp_match(lower(btrim(p)), '^([0-9]{1,2})(?:[:.]([0-9]{2}))?\s*(am|pm|a\.m\.|p\.m\.)?');
  if m is null then return null; end if;
  h := m[1]::int; mi := coalesce(m[2], '0')::int;
  if m[3] is null and m[2] is null then return null; end if;          -- a bare number is not a time
  if m[3] like 'p%' and h < 12 then h := h + 12; end if;
  if m[3] like 'a%' and h = 12 then h := 0; end if;
  if h > 23 or mi > 59 then return null; end if;
  return make_time(h, mi, 0);
end $$;

-- the ACTIVE crew member a work link belongs to (same studio, same phone); prefers the one named on this
-- event's tasks. null for a vendor's link or a number that is not on the Staff list.
create or replace function public._r23_crew_of_token(w public.work_tokens)
returns public.crew_members language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265
declare c public.crew_members;
begin
  select cm.* into c from public.event_tasks t join public.crew_members cm on cm.id = t.crew_id and cm.org_id = w.org_id
   where t.quote_id = w.quote_id and t.org_id = w.org_id and t.assignee_phone = w.phone and cm.active
     and public.helm_norm_phone(cm.phone) = public.helm_norm_phone(w.phone)
   order by t.created_at limit 1;
  if c.id is not null then return c; end if;
  select cm.* into c from public.crew_members cm
   where cm.org_id = w.org_id and cm.active and public.helm_norm_phone(cm.phone) = public.helm_norm_phone(w.phone)
   order by (cm.profile_id is not null) desc, cm.created_at, cm.id limit 1;
  return c;
end $$;

-- bell row for the office (never blocks the caller)
create or replace function public._r23_notify(p_quote uuid, p_kind text, p_detail jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
begin
  perform public._notify(p_quote, 'in_app', null, p_kind, coalesce(p_detail, '{}'::jsonb));
exception when others then
  raise warning 'r23-crew-0265: notice skipped (%)', sqlstate;
end $$;

-- the crew member's live work link for an event (an existing one, else a new one); null when their link for this
-- event was revoked or has expired (the office decided that - never re-opened here)
create or replace function public._r23_ensure_token(p_quote uuid, c public.crew_members)
returns public.work_tokens language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare w public.work_tokens;
begin
  select * into w from public.work_tokens wt
   where wt.quote_id = p_quote and wt.org_id = c.org_id and public.helm_norm_phone(wt.phone) = public.helm_norm_phone(c.phone)
   order by (wt.revoked_at is null) desc, wt.created_at desc limit 1;
  if w.token is not null then
    if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then return null; end if;
    return w;
  end if;
  insert into public.work_tokens (quote_id, phone, name, org_id) values (p_quote, c.phone, c.name, c.org_id)
    on conflict (quote_id, phone) do nothing;
  select * into w from public.work_tokens wt where wt.quote_id = p_quote and wt.phone = c.phone;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then return null; end if;
  return w;
end $$;

-- when the person is expected to start on a day of an event: the earliest of their approved shift start, their
-- tasks' planned start that day, the event's own time (on the event date)
create or replace function public._r23_expected_start(p_quote uuid, p_crew uuid, p_day date)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265
declare q record; v_tz text; v timestamptz; t time;
begin
  select qq.org_id, qq.event_date, qq.event_time into q from public.quotes qq where qq.id = p_quote;
  if q.org_id is null then return null; end if;
  v_tz := public._r23_tz(q.org_id);
  select min((s.shift_date + s.start_time) at time zone v_tz) into v
    from public.open_shift_claims c join public.open_shifts s on s.id = c.shift_id
   where c.quote_id = p_quote and c.crew_id = p_crew and c.status = 'approved' and s.shift_date = p_day and s.start_time is not null;
  select least(v, min(tk.planned_start)) into v from public.event_tasks tk
   where tk.quote_id = p_quote and tk.crew_id = p_crew and tk.status not in ('rejected', 'cancelled')
     and tk.planned_start is not null and (tk.planned_start at time zone v_tz)::date = p_day;
  if v is null and q.event_date = p_day then
    t := public._r23_parse_time(q.event_time);
    if t is not null then v := (p_day + t) at time zone v_tz; end if;
  end if;
  return v;
end $$;

-- great-circle distance in metres
create or replace function public._r23_dist_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns integer language sql immutable set search_path = '' as $$
  select round(2 * 6371000 * asin(least(1, sqrt(
           power(sin(radians((lat2 - lat1)::float8) / 2), 2)
           + cos(radians(lat1::float8)) * cos(radians(lat2::float8)) * power(sin(radians((lng2 - lng1)::float8) / 2), 2)))))::integer;
$$;

-- is the person on the event? (a live task naming them, an approved shift claim, or the arrival roster)
create or replace function public._r23_on_event(p_quote uuid, p_crew uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.crew_id = p_crew and t.status not in ('rejected', 'cancelled'))
      or exists (select 1 from public.open_shift_claims c where c.quote_id = p_quote and c.crew_id = p_crew and c.status = 'approved')
      or exists (select 1 from public.event_day d where d.quote_id = p_quote and d.ref_id = p_crew and d.kind = 'arrival');
$$;

-- create the task for an approved claim (status accepted: claiming IS accepting) and link it
create or replace function public._r23_claim_task(p_claim uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare cl record; s public.open_shifts; c public.crew_members; w public.work_tokens; v_tz text; v_task uuid; v_title text;
begin
  select * into cl from public.open_shift_claims where id = p_claim;
  select * into s from public.open_shifts where id = cl.shift_id;
  select * into c from public.crew_members where id = cl.crew_id and org_id = s.org_id;
  if s.id is null or c.id is null then raise exception 'shift not found' using errcode = 'P0002'; end if;
  w := public._r23_ensure_token(s.quote_id, c);
  v_tz := public._r23_tz(s.org_id);
  v_title := left('Shift: ' || s.title
    || case when s.start_time is not null then ' ' || to_char(s.start_time, 'HH24:MI')
            || case when s.end_time is not null then '-' || to_char(s.end_time, 'HH24:MI') else '' end else '' end
    || ' (' || to_char(s.shift_date, 'DD/MM/YYYY') || ')', 500);
  insert into public.event_tasks (quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status,
                                  responded_at, planned_start, planned_end, note)
  values (s.quote_id, s.org_id, s.task_category, v_title, 900, c.id, c.name, coalesce(w.phone, c.phone), 'accepted', now(),
          case when s.start_time is not null then (s.shift_date + s.start_time) at time zone v_tz end,
          case when s.start_time is not null and s.end_time is not null then
                 ((s.shift_date + s.end_time) + case when s.end_time <= s.start_time then interval '1 day' else interval '0' end) at time zone v_tz end,
          left('Claimed from an open shift' || case when nullif(btrim(coalesce(s.note, '')), '') is not null then ': ' || s.note else '' end, 600))
  returning id into v_task;
  update public.open_shift_claims set task_id = v_task where id = p_claim;
  return v_task;
end $$;

-- after an approval: close the shift as filled when enough people have it
create or replace function public._r23_shift_fill_check(p_shift uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare s public.open_shifts; n int;
begin
  select * into s from public.open_shifts where id = p_shift;
  select count(*) into n from public.open_shift_claims c where c.shift_id = p_shift and c.status = 'approved';
  if s.status = 'open' and n >= s.needed then
    update public.open_shifts set status = 'filled', closed_at = now(), updated_at = now() where id = p_shift;
    -- the people still waiting are told no on the crew link (their claim is declined, never deleted)
    update public.open_shift_claims set status = 'declined', decided_at = now(), decline_reason = 'the shift is full'
     where shift_id = p_shift and status = 'pending';
    perform public._r23_notify(s.quote_id, 'shift_filled', jsonb_build_object('shift', s.title, 'needed', s.needed));
    return 'filled';
  end if;
  return s.status;
end $$;

-- ============================================================================================================
-- 3) Control Center settings
-- ============================================================================================================
create or replace function public.get_crew_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not (public.has_area('staff', 'view') or public.has_area('controls', 'view') or public.has_area('command', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r23_cfg(v_org) || jsonb_build_object('can_edit', public.has_area('controls', 'edit'));
end $$;

create or replace function public.set_crew_settings(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare v_org uuid := public.current_org_id(); v jsonb := '{}'::jsonb; k text; n numeric;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Control Center) can change the crew settings.' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  foreach k in array array['availability', 'openShifts', 'notifyShifts', 'selfCheckin', 'geofence'] loop
    if p ? k then
      if jsonb_typeof(p -> k) <> 'boolean' then raise exception '% must be on or off', k using errcode = '22023'; end if;
      v := v || jsonb_build_object(k, p -> k);
    end if;
  end loop;
  if p ? 'claimMode' then
    if p ->> 'claimMode' not in ('first_come', 'approval') then raise exception 'Claim mode must be first come or needs approval.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('claimMode', p ->> 'claimMode'); end if;
  if p ? 'payBasis' then
    if p ->> 'payBasis' not in ('day', 'hours') then raise exception 'Pay basis must be per day or per hour.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('payBasis', p ->> 'payBasis'); end if;
  if p ? 'geofenceRadiusM' then
    if jsonb_typeof(p -> 'geofenceRadiusM') <> 'number' then raise exception 'Radius must be a number.' using errcode = '22023'; end if;
    n := (p ->> 'geofenceRadiusM')::numeric;
    if not (n between 50 and 5000) then raise exception 'Check-in radius must be 50 to 5000 metres.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('geofenceRadiusM', round(n)); end if;
  if p ? 'lateGraceMin' then
    if jsonb_typeof(p -> 'lateGraceMin') <> 'number' then raise exception 'Late grace must be a number.' using errcode = '22023'; end if;
    n := (p ->> 'lateGraceMin')::numeric;
    if not (n between 0 and 240) then raise exception 'Late grace must be 0 to 240 minutes.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('lateGraceMin', round(n)); end if;
  if p ? 'noShowAfterMin' then
    if jsonb_typeof(p -> 'noShowAfterMin') <> 'number' then raise exception 'No-show time must be a number.' using errcode = '22023'; end if;
    n := (p ->> 'noShowAfterMin')::numeric;
    if not (n between 15 and 720) then raise exception 'No-show time must be 15 to 720 minutes.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('noShowAfterMin', round(n)); end if;
  if p ? 'dayHours' then
    if jsonb_typeof(p -> 'dayHours') <> 'number' then raise exception 'Day hours must be a number.' using errcode = '22023'; end if;
    n := (p ->> 'dayHours')::numeric;
    if not (n between 1 and 24) then raise exception 'A working day must be 1 to 24 hours.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('dayHours', round(n, 1)); end if;
  insert into public.app_config (org_id, key, value, updated_at) values (v_org, 'crew', v, now())
  on conflict (org_id, key) do update
    set value = (case when jsonb_typeof(public.app_config.value) = 'object' then public.app_config.value else '{}'::jsonb end) || v,
        updated_at = now();
  return public.get_crew_settings();
end $$;

-- ============================================================================================================
-- 4) the crew link (work.html): one read + availability + shifts + check-in
-- ============================================================================================================
create or replace function public.crew_link_home(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265: token-scoped; only the caller's own rows + open shifts of the link's studio
declare
  w public.work_tokens; c public.crew_members; v_cfg jsonb; v_tz text; v_today date; q record;
  v_avail jsonb := '[]'::jsonb; v_busy jsonb := '[]'::jsonb; v_shifts jsonb := '[]'::jsonb; v_ci jsonb;
  v_days date[]; v_rec public.crew_checkins; v_exp timestamptz; v_site record; v_cur text;
begin
  w := public._work_token_live(p_token);
  c := public._r23_crew_of_token(w);
  v_cfg := public._r23_cfg(w.org_id);
  v_tz := public._r23_tz(w.org_id);
  v_today := public._a198_org_today(w.org_id);
  select coalesce(nullif(btrim(o.currency), ''), 'INR') into v_cur from public.organizations o where o.id = w.org_id;
  if c.id is null then
    return jsonb_build_object('crew', null, 'today', v_today, 'currency', coalesce(v_cur, 'INR'));
  end if;
  select qq.id, qq.event_date, qq.event_time, qq.status, qq.deleted_at into q from public.quotes qq where qq.id = w.quote_id;

  if (v_cfg ->> 'availability')::boolean then
    select coalesce(jsonb_agg(jsonb_build_object('day', a.day, 'status', a.status, 'note', a.note, 'by_office', a.source = 'office') order by a.day), '[]'::jsonb)
      into v_avail from public.crew_availability a
     where a.crew_id = c.id and a.org_id = w.org_id and a.day between v_today and v_today + 120 and a.status = 'unavailable';
    -- days they already work (dates only - never other events' names)
    select coalesce(jsonb_agg(distinct d order by d), '[]'::jsonb) into v_busy from (
      select coalesce((t.planned_start at time zone v_tz)::date, qq.event_date) as d
        from public.event_tasks t join public.quotes qq on qq.id = t.quote_id and qq.org_id = w.org_id and qq.deleted_at is null
       where t.org_id = w.org_id and t.crew_id = c.id and t.status not in ('rejected', 'cancelled')
         and coalesce(qq.status, '') not in ('cancelled', 'lost')) x
     where d between v_today and v_today + 120;
  end if;

  if (v_cfg ->> 'openShifts')::boolean then
    select coalesce(jsonb_agg(z.j order by z.shift_date, z.start_time nulls first, z.id), '[]'::jsonb) into v_shifts from (
      select s.id, s.shift_date, s.start_time, jsonb_build_object(
          'id', s.id, 'title', s.title, 'event_title', coalesce(nullif(btrim(qq.title), ''), qq.code), 'event_code', qq.code,
          'venue', nullif(btrim(coalesce(ep.venue_name, '')), ''),
          'date', s.shift_date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
          'wage', s.wage, 'basis', s.wage_basis, 'needed', s.needed, 'mode', s.claim_mode, 'note', s.note,
          'filled', (select count(*) from public.open_shift_claims x where x.shift_id = s.id and x.status = 'approved'),
          'my_status', (select x.status from public.open_shift_claims x where x.shift_id = s.id and x.crew_id = c.id),
          'my_reason', (select x.decline_reason from public.open_shift_claims x where x.shift_id = s.id and x.crew_id = c.id),
          'status', s.status,
          -- their own live link for that event once they are on the shift (to open its tasks / check in)
          'my_link', case when s.quote_id <> w.quote_id and exists (select 1 from public.open_shift_claims x where x.shift_id = s.id and x.crew_id = c.id and x.status = 'approved')
                          then (select wt.token from public.work_tokens wt where wt.quote_id = s.quote_id and wt.org_id = w.org_id
                                   and public.helm_norm_phone(wt.phone) = public.helm_norm_phone(c.phone) and wt.revoked_at is null
                                   and (wt.expires_at is null or wt.expires_at > now()) order by wt.created_at desc limit 1) end,
          'unavailable', exists (select 1 from public.crew_availability a where a.crew_id = c.id and a.day = s.shift_date and a.status = 'unavailable'),
          'on_event', public._r23_on_event(s.quote_id, c.id)) as j
        from public.open_shifts s
        join public.quotes qq on qq.id = s.quote_id and qq.org_id = w.org_id and qq.deleted_at is null
        left join public.event_plan ep on ep.quote_id = qq.id and ep.org_id = w.org_id
       where s.org_id = w.org_id and s.shift_date between v_today and v_today + 60
         and coalesce(qq.status, '') not in ('cancelled', 'lost') and coalesce(qq.lifecycle_stage, '') not in ('closed', 'cancelled', 'archived')
         and (s.department is null or lower(btrim(s.department)) = lower(btrim(coalesce(c.department, ''))))
         and (s.status = 'open' or exists (select 1 from public.open_shift_claims x where x.shift_id = s.id and x.crew_id = c.id))
       order by s.shift_date, s.start_time nulls first, s.id limit 30) z;
  end if;

  if (v_cfg ->> 'selfCheckin')::boolean and public._r23_on_event(w.quote_id, c.id) then
    select array_agg(distinct d) into v_days from (
      select q.event_date as d
      union select s.shift_date from public.open_shift_claims x join public.open_shifts s on s.id = x.shift_id
               where x.quote_id = w.quote_id and x.crew_id = c.id and x.status = 'approved'
      union select (t.planned_start at time zone v_tz)::date from public.event_tasks t
               where t.quote_id = w.quote_id and t.crew_id = c.id and t.status not in ('rejected', 'cancelled') and t.planned_start is not null) x
     where d is not null;
    select * into v_rec from public.crew_checkins k where k.quote_id = w.quote_id and k.crew_id = c.id
     order by (k.check_out_at is null) desc, k.check_in_at desc limit 1;
    if v_rec.id is not null and v_rec.work_day < v_today and v_rec.check_out_at is not null then v_rec := null; end if;
    v_exp := public._r23_expected_start(w.quote_id, c.id, v_today);
    select s2.lat, s2.lng, s2.radius_m into v_site from public.event_checkin_sites s2 where s2.quote_id = w.quote_id and s2.org_id = w.org_id;
    v_ci := jsonb_build_object(
      'today_ok', v_today = any (coalesce(v_days, '{}'::date[])),
      'days', to_jsonb(coalesce(v_days, '{}'::date[])),
      'event_live', q.deleted_at is null and coalesce(q.status, '') not in ('cancelled', 'lost'),
      'expected_start', to_char(v_exp at time zone v_tz, 'HH24:MI'),
      'opens_at', case when v_exp is not null then to_char((v_exp - interval '3 hours') at time zone v_tz, 'HH24:MI') end,
      'check_in', to_char(v_rec.check_in_at at time zone v_tz, 'HH24:MI'), 'check_out', to_char(v_rec.check_out_at at time zone v_tz, 'HH24:MI'),
      'work_day', v_rec.work_day, 'late_min', v_rec.late_min,
      'needs_location', (v_cfg ->> 'geofence')::boolean and v_site.lat is not null,
      'site_known', v_site.lat is not null);
  end if;

  return jsonb_build_object(
    'crew', jsonb_build_object('name', c.name, 'department', c.department),
    'today', v_today, 'currency', coalesce(v_cur, 'INR'),
    'settings', jsonb_build_object('availability', v_cfg -> 'availability', 'openShifts', v_cfg -> 'openShifts', 'selfCheckin', v_cfg -> 'selfCheckin'),
    'availability', v_avail, 'busy', v_busy, 'shifts', v_shifts, 'checkin', v_ci);
end $$;

create or replace function public.crew_set_availability(p_token uuid, p_day date, p_status text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare w public.work_tokens; c public.crew_members; v_today date; n int; v_note text; r record; v_clash int := 0;
begin
  w := public._work_token_live(p_token);
  c := public._r23_crew_of_token(w);
  if c.id is null then raise exception 'This link is not linked to a staff member - ask the office.' using errcode = '42501'; end if;
  if not (public._r23_cfg(w.org_id) ->> 'availability')::boolean then
    raise exception 'Your studio has switched availability off - tell the office directly.' using errcode = '42501'; end if;
  v_today := public._a198_org_today(w.org_id);
  if p_day is null or p_day < v_today or p_day > v_today + 120 then
    raise exception 'Pick a day from today up to 120 days ahead.' using errcode = '22023'; end if;
  if p_status not in ('unavailable', 'available') then raise exception 'invalid status' using errcode = '22023'; end if;
  v_note := nullif(left(regexp_replace(btrim(coalesce(p_note, '')), '[[:cntrl:]<>]', ' ', 'g'), 200), '');
  perform pg_advisory_xact_lock(hashtextextended('helm.r23.avail:' || c.id::text, 0));
  select count(*) into n from public.crew_availability a where a.crew_id = c.id and a.source = 'crew' and a.updated_at > now() - interval '1 hour';
  if n >= 100 then raise exception 'Too many changes - try again in an hour.' using errcode = '54000'; end if;
  insert into public.crew_availability (org_id, crew_id, day, status, note, source, set_by)
    values (w.org_id, c.id, p_day, p_status, v_note, 'crew', null)
  on conflict (crew_id, day) do update set status = excluded.status, note = excluded.note, source = 'crew', set_by = null, updated_at = now();
  if p_status = 'unavailable' then
    -- already booked that day: the office is told (once per event)
    for r in select distinct t.quote_id from public.event_tasks t join public.quotes qq on qq.id = t.quote_id and qq.deleted_at is null
              where t.org_id = w.org_id and t.crew_id = c.id and t.status not in ('rejected', 'cancelled')
                and coalesce((t.planned_start at time zone public._r23_tz(w.org_id))::date, qq.event_date) = p_day loop
      v_clash := v_clash + 1;
      perform public._r23_notify(r.quote_id, 'crew_unavailable', jsonb_build_object('worker', c.name, 'day', p_day, 'note', v_note));
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'day', p_day, 'status', p_status, 'booked_that_day', v_clash > 0);
end $$;

create or replace function public.crew_claim_shift(p_token uuid, p_shift uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265: the row lock on the shift serializes claims - never more people than needed
declare
  w public.work_tokens; c public.crew_members; s public.open_shifts; v_cfg jsonb; n int; v_today date;
  v_prev record; v_claim uuid; v_status text; ev public.work_tokens; q record;
begin
  w := public._work_token_live(p_token);
  c := public._r23_crew_of_token(w);
  if c.id is null then raise exception 'This link is not linked to a staff member - ask the office.' using errcode = '42501'; end if;
  v_cfg := public._r23_cfg(w.org_id);
  if not (v_cfg ->> 'openShifts')::boolean then raise exception 'Open shifts are switched off for this studio.' using errcode = '42501'; end if;
  select * into s from public.open_shifts where id = p_shift and org_id = w.org_id for update;
  if s.id is null then raise exception 'shift not found' using errcode = 'P0002'; end if;
  select qq.deleted_at, qq.status, qq.lifecycle_stage into q from public.quotes qq where qq.id = s.quote_id and qq.org_id = w.org_id;
  if q.deleted_at is not null or coalesce(q.status, '') in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('closed', 'cancelled', 'archived') then
    raise exception 'This event is no longer running.' using errcode = '22023'; end if;
  v_today := public._a198_org_today(w.org_id);
  if s.status <> 'open' then raise exception '%', case s.status when 'filled' then 'This shift is already full.' else 'This shift is closed.' end using errcode = '22023'; end if;
  if s.shift_date < v_today then raise exception 'This shift is in the past.' using errcode = '22023'; end if;
  if s.department is not null and lower(btrim(s.department)) <> lower(btrim(coalesce(c.department, ''))) then
    raise exception 'This shift is for the % team.', s.department using errcode = '42501'; end if;
  if exists (select 1 from public.crew_availability a where a.crew_id = c.id and a.day = s.shift_date and a.status = 'unavailable') then
    raise exception 'You marked yourself unavailable on that day - change it first.' using errcode = '22023'; end if;
  select count(*) into n from public.open_shift_claims x where x.crew_id = c.id and x.claimed_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'Too many claims - try again in an hour.' using errcode = '54000'; end if;
  select * into v_prev from public.open_shift_claims x where x.shift_id = s.id and x.crew_id = c.id;
  if v_prev.id is not null and v_prev.status in ('pending', 'approved') then
    return jsonb_build_object('ok', true, 'status', v_prev.status, 'already', true);
  end if;
  if v_prev.id is not null and v_prev.status = 'declined' then
    raise exception 'The office has not given you this shift.' using errcode = '42501'; end if;
  select count(*) into n from public.open_shift_claims x where x.shift_id = s.id and x.status = 'approved';
  if n >= s.needed then raise exception 'This shift is already full.' using errcode = '22023'; end if;
  v_status := case when s.claim_mode = 'first_come' then 'approved' else 'pending' end;
  if v_prev.id is not null then   -- they withdrew earlier and claim again: the same row (never a second one)
    update public.open_shift_claims set status = v_status, claimed_at = now(), decided_at = case when v_status = 'approved' then now() end,
           decided_by = null, decline_reason = null, task_id = null where id = v_prev.id returning id into v_claim;
  else
    insert into public.open_shift_claims (org_id, shift_id, quote_id, crew_id, status, decided_at)
      values (w.org_id, s.id, s.quote_id, c.id, v_status, case when v_status = 'approved' then now() end) returning id into v_claim;
  end if;
  if v_status = 'approved' then
    perform public._r23_claim_task(v_claim);
    perform public._r23_shift_fill_check(s.id);
    perform public._r23_notify(s.quote_id, 'shift_claimed', jsonb_build_object('worker', c.name, 'shift', s.title));
  else
    perform public._r23_notify(s.quote_id, 'shift_claim_pending', jsonb_build_object('worker', c.name, 'shift', s.title));
  end if;
  ev := public._r23_ensure_token(s.quote_id, c);
  return jsonb_build_object('ok', true, 'status', v_status, 'event_token', ev.token);
end $$;

create or replace function public.crew_withdraw_claim(p_token uuid, p_shift uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265: only a WAITING claim; an approved shift is a task - reject it there (that frees the place)
declare w public.work_tokens; c public.crew_members; n int;
begin
  w := public._work_token_live(p_token);
  c := public._r23_crew_of_token(w);
  if c.id is null then raise exception 'This link is not linked to a staff member - ask the office.' using errcode = '42501'; end if;
  update public.open_shift_claims set status = 'withdrawn', decided_at = now()
   where shift_id = p_shift and crew_id = c.id and org_id = w.org_id and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'There is no waiting claim to withdraw.' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true, 'status', 'withdrawn');
end $$;

create or replace function public.crew_check(p_token uuid, p_action text, p_lat numeric default null, p_lng numeric default null, p_accuracy numeric default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265: server time only; location -> distance only (the coordinates are never stored)
declare
  w public.work_tokens; c public.crew_members; v_cfg jsonb; v_tz text; v_today date; q record; v_site record;
  v_dist integer; v_within boolean; v_acc integer; v_exp timestamptz; v_late integer; v_rec public.crew_checkins; v_days date[];
  v_grace integer;
begin
  w := public._work_token_live(p_token);
  c := public._r23_crew_of_token(w);
  if c.id is null then raise exception 'This link is not linked to a staff member - ask the office.' using errcode = '42501'; end if;
  v_cfg := public._r23_cfg(w.org_id);
  if not (v_cfg ->> 'selfCheckin')::boolean then raise exception 'Self check-in is switched off - check in with the office.' using errcode = '42501'; end if;
  if p_action not in ('in', 'out') then raise exception 'invalid action' using errcode = '22023'; end if;
  if not public._r23_on_event(w.quote_id, c.id) then raise exception 'You are not on this event.' using errcode = '42501'; end if;
  select qq.event_date, qq.status, qq.deleted_at, qq.lifecycle_stage into q from public.quotes qq where qq.id = w.quote_id;
  if q.deleted_at is not null or coalesce(q.status, '') in ('cancelled', 'lost') then
    raise exception 'This event is no longer running.' using errcode = '22023'; end if;
  v_tz := public._r23_tz(w.org_id);
  v_today := public._a198_org_today(w.org_id);
  -- location (optional): checked against the event's check-in location when the studio switched it on
  if p_lat is not null or p_lng is not null then
    if p_lat is null or p_lng is null or not (p_lat between -90 and 90) or not (p_lng between -180 and 180) then
      raise exception 'invalid location' using errcode = '22023'; end if;
    v_acc := case when p_accuracy is not null and p_accuracy >= 0 and p_accuracy < 100000 then round(p_accuracy)::integer end;
  end if;
  select s2.lat, s2.lng, s2.radius_m into v_site from public.event_checkin_sites s2 where s2.quote_id = w.quote_id and s2.org_id = w.org_id;
  if v_site.lat is not null and p_lat is not null then
    v_dist := public._r23_dist_m(p_lat, p_lng, v_site.lat, v_site.lng);
    v_within := v_dist <= v_site.radius_m + least(coalesce(v_acc, 0), 200);
  end if;
  if (v_cfg ->> 'geofence')::boolean and v_site.lat is not null then
    if p_lat is null then raise exception 'Allow location on your phone to check in, or ask the office to check you in.' using errcode = '22023'; end if;
    if not v_within then
      raise exception 'You seem to be % m from the venue. Check in when you reach the venue (or ask the office).', v_dist using errcode = '22023'; end if;
  end if;

  if p_action = 'in' then
    select array_agg(distinct d) into v_days from (
      select q.event_date as d
      union select s.shift_date from public.open_shift_claims x join public.open_shifts s on s.id = x.shift_id
               where x.quote_id = w.quote_id and x.crew_id = c.id and x.status = 'approved'
      union select (t.planned_start at time zone v_tz)::date from public.event_tasks t
               where t.quote_id = w.quote_id and t.crew_id = c.id and t.status not in ('rejected', 'cancelled') and t.planned_start is not null) x
     where d is not null;
    if not (v_today = any (coalesce(v_days, '{}'::date[]))) then
      raise exception 'Check-in opens on the event day.' using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('helm.r23.check:' || w.quote_id::text || ':' || c.id::text, 0));
    select * into v_rec from public.crew_checkins k where k.quote_id = w.quote_id and k.crew_id = c.id and k.work_day = v_today;
    if v_rec.id is not null then   -- already in today: the first time stays (never overwritten)
      return jsonb_build_object('ok', true, 'already', true, 'check_in', to_char(v_rec.check_in_at at time zone v_tz, 'HH24:MI'),
                                'check_out', to_char(v_rec.check_out_at at time zone v_tz, 'HH24:MI'));
    end if;
    v_exp := public._r23_expected_start(w.quote_id, c.id, v_today);
    if v_exp is not null and now() < v_exp - interval '3 hours' then
      raise exception 'Too early - check-in opens at %.', to_char((v_exp - interval '3 hours') at time zone v_tz, 'HH24:MI') using errcode = '22023'; end if;
    v_late := case when v_exp is not null and now() > v_exp then floor(extract(epoch from (now() - v_exp)) / 60)::integer else 0 end;
    insert into public.crew_checkins (org_id, quote_id, crew_id, work_day, check_in_at, expected_start, late_min, in_distance_m, in_accuracy_m, in_within, source)
      values (w.org_id, w.quote_id, c.id, v_today, now(), v_exp, v_late, v_dist, v_acc, v_within, 'crew') returning * into v_rec;
    -- the event-day roster (command.html / closure / ledger): arrived
    update public.event_day d set status = 'arrived' where d.quote_id = w.quote_id and d.org_id = w.org_id and d.kind = 'arrival'
       and d.ref_id = c.id and d.status in ('expected', 'no_show');
    if not exists (select 1 from public.event_day d where d.quote_id = w.quote_id and d.org_id = w.org_id and d.kind = 'arrival' and d.ref_id = c.id) then
      insert into public.event_day (quote_id, org_id, kind, who, role, ref_id, status, note)
        values (w.quote_id, w.org_id, 'arrival', left(c.name, 200), left(coalesce(nullif(btrim(c.department), ''), 'Staff'), 60), c.id, 'arrived', 'self check-in');
    end if;
    v_grace := (v_cfg ->> 'lateGraceMin')::integer;
    if v_late > v_grace then
      perform public._r23_notify(w.quote_id, 'crew_late', jsonb_build_object('worker', c.name, 'late_min', v_late));
    end if;
    return jsonb_build_object('ok', true, 'check_in', to_char(v_rec.check_in_at at time zone v_tz, 'HH24:MI'), 'late_min', v_late,
                              'late', v_late > v_grace, 'within', v_within, 'distance_m', v_dist);
  end if;

  -- out: the latest open check-in of this event (also after midnight)
  perform pg_advisory_xact_lock(hashtextextended('helm.r23.check:' || w.quote_id::text || ':' || c.id::text, 0));
  select * into v_rec from public.crew_checkins k where k.quote_id = w.quote_id and k.crew_id = c.id and k.check_out_at is null
   order by k.check_in_at desc limit 1;
  if v_rec.id is null then raise exception 'Check in first.' using errcode = '22023'; end if;
  if now() - v_rec.check_in_at > interval '24 hours' then
    raise exception 'Your check-in is more than 24 hours old - ask the office to enter your out time.' using errcode = '22023'; end if;
  update public.crew_checkins set check_out_at = now(), out_distance_m = v_dist, out_within = v_within, updated_at = now()
   where id = v_rec.id returning * into v_rec;
  update public.event_day d set status = 'left' where d.quote_id = w.quote_id and d.org_id = w.org_id and d.kind = 'arrival'
     and d.ref_id = c.id and d.status in ('arrived', 'expected');
  return jsonb_build_object('ok', true, 'check_in', to_char(v_rec.check_in_at at time zone v_tz, 'HH24:MI'),
                            'check_out', to_char(v_rec.check_out_at at time zone v_tz, 'HH24:MI'),
                            'hours', round((extract(epoch from (v_rec.check_out_at - v_rec.check_in_at)) / 3600.0)::numeric, 2));
end $$;

-- ============================================================================================================
-- 5) office: availability, day status (assign warnings), open shifts, check-in site, timesheet
-- ============================================================================================================
create or replace function public.crew_availability_range(p_from date, p_to date, p_crew uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'pick a range of up to 92 days' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('crew_id', a.crew_id, 'day', a.day, 'status', a.status, 'note', a.note,
                                                        'source', a.source, 'updated_at', a.updated_at) order by a.day, a.crew_id)
                     from public.crew_availability a
                    where a.org_id = v_org and a.day between p_from and p_to and a.status = 'unavailable'
                      and (p_crew is null or a.crew_id = p_crew)), '[]'::jsonb);
end $$;

create or replace function public.crew_availability_set(p_crew uuid, p_day date, p_status text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare v_org uuid := public.current_org_id(); v_today date; v_note text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'Only people who can edit Staff can change availability.' using errcode = '42501'; end if;
  if not exists (select 1 from public.crew_members cm where cm.id = p_crew and cm.org_id = v_org) then
    raise exception 'staff member not found' using errcode = 'P0002'; end if;
  v_today := public._a198_org_today(v_org);
  if p_day is null or p_day < v_today - 30 or p_day > v_today + 365 then
    raise exception 'Pick a day from 30 days ago up to a year ahead.' using errcode = '22023'; end if;
  if p_status not in ('unavailable', 'available') then raise exception 'invalid status' using errcode = '22023'; end if;
  v_note := nullif(left(regexp_replace(btrim(coalesce(p_note, '')), '[[:cntrl:]<>]', ' ', 'g'), 200), '');
  insert into public.crew_availability (org_id, crew_id, day, status, note, source, set_by)
    values (v_org, p_crew, p_day, p_status, v_note, 'office', auth.uid())
  on conflict (crew_id, day) do update set status = excluded.status, note = excluded.note, source = 'office', set_by = auth.uid(), updated_at = now();
  return jsonb_build_object('ok', true, 'crew_id', p_crew, 'day', p_day, 'status', p_status);
end $$;

-- who is unavailable / already booked on a day (for the Assign warnings); only people with something to say
create or replace function public.crew_day_status(p_date date, p_exclude_quote uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265
declare v_org uuid := public.current_org_id(); v_tz text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_date is null then return '[]'::jsonb; end if;
  v_tz := public._r23_tz(v_org);
  return coalesce((
    select jsonb_agg(jsonb_build_object('crew_id', cm.id, 'name', cm.name, 'unavailable', u.day is not null, 'note', u.note,
                                        'booked', coalesce(b.codes, '[]'::jsonb)) order by cm.name)
      from public.crew_members cm
      left join public.crew_availability u on u.crew_id = cm.id and u.day = p_date and u.status = 'unavailable'
      left join lateral (
        select jsonb_agg(distinct jsonb_build_object('quote_id', qq.id, 'code', qq.code)) as codes
          from public.event_tasks t join public.quotes qq on qq.id = t.quote_id and qq.org_id = v_org and qq.deleted_at is null
         where t.org_id = v_org and t.crew_id = cm.id and t.status not in ('rejected', 'cancelled')
           and coalesce(qq.status, '') not in ('cancelled', 'lost') and coalesce(qq.lifecycle_stage, '') not in ('closed', 'cancelled', 'archived')
           and (p_exclude_quote is null or qq.id <> p_exclude_quote)
           and coalesce((t.planned_start at time zone v_tz)::date, qq.event_date) = p_date) b on true
     where cm.org_id = v_org and cm.active and (u.day is not null or b.codes is not null)), '[]'::jsonb);
end $$;

create or replace function public.open_shift_post(p_quote uuid, p_title text, p_date date, p_start time default null, p_end time default null,
  p_wage numeric default null, p_basis text default 'day', p_needed integer default 1, p_mode text default null,
  p_department text default null, p_category text default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare
  v_org uuid := public.current_org_id(); v_cfg jsonb; v_today date; q record; v_id uuid; v_title text; v_dept text; v_note text;
  c public.crew_members; w public.work_tokens; v_n int := 0; v_body text; v_phone text; v_cur text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'Only people who can edit Staff can post open shifts.' using errcode = '42501'; end if;
  v_cfg := public._r23_cfg(v_org);
  if not (v_cfg ->> 'openShifts')::boolean then raise exception 'Open shifts are switched off (Control Center -> Crew).' using errcode = '42501'; end if;
  select qq.id, qq.code, qq.title, qq.status, qq.deleted_at, qq.lifecycle_stage into q from public.quotes qq where qq.id = p_quote and qq.org_id = v_org;
  if q.id is null then raise exception 'no such event' using errcode = 'P0002'; end if;
  if q.deleted_at is not null or coalesce(q.status, '') in ('cancelled', 'lost') or coalesce(q.lifecycle_stage, '') in ('closed', 'cancelled', 'archived') then
    raise exception 'This event is not running - no shifts can be posted.' using errcode = '22023'; end if;
  v_title := btrim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]<>]', ' ', 'g'));
  if char_length(v_title) < 2 or char_length(v_title) > 80 then raise exception 'Give the role in 2 to 80 characters (e.g. Waiter).' using errcode = '22023'; end if;
  v_today := public._a198_org_today(v_org);
  if p_date is null or p_date < v_today or p_date > v_today + 365 then raise exception 'Pick a shift date from today up to a year ahead.' using errcode = '22023'; end if;
  if p_end is not null and p_start is null then raise exception 'Give a start time with the end time.' using errcode = '22023'; end if;
  if p_wage is not null and (p_wage = 'NaN'::numeric or p_wage < 0 or p_wage >= 10000000) then raise exception 'Wage must be 0 or more.' using errcode = '22023'; end if;
  if coalesce(p_basis, 'day') not in ('day', 'hour') then raise exception 'Wage must be per day or per hour.' using errcode = '22023'; end if;
  if p_needed is null or p_needed < 1 or p_needed > 100 then raise exception 'People needed must be 1 to 100.' using errcode = '22023'; end if;
  if p_mode is not null and p_mode not in ('first_come', 'approval') then raise exception 'invalid claim mode' using errcode = '22023'; end if;
  v_dept := nullif(left(btrim(regexp_replace(coalesce(p_department, ''), '[[:cntrl:]<>]', ' ', 'g')), 60), '');
  v_note := nullif(left(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]<>]', ' ', 'g')), 500), '');
  insert into public.open_shifts (org_id, quote_id, title, department, shift_date, start_time, end_time, wage, wage_basis, needed, claim_mode,
                                  task_category, note, created_by)
    values (v_org, p_quote, v_title, v_dept, p_date, p_start, p_end, round(p_wage, 2), coalesce(p_basis, 'day'), p_needed,
            coalesce(p_mode, v_cfg ->> 'claimMode'),
            coalesce(nullif(left(btrim(regexp_replace(coalesce(p_category, ''), '[[:cntrl:]<>]', ' ', 'g')), 60), ''), 'Crew'), v_note, auth.uid())
    returning id into v_id;
  -- WhatsApp notice QUEUED to every eligible person (dormant until the studio's WhatsApp is on); never blocks the post
  if (v_cfg ->> 'notifyShifts')::boolean then
    select coalesce(nullif(btrim(o.currency), ''), 'INR') into v_cur from public.organizations o where o.id = v_org;
    for c in select cm.* from public.crew_members cm
              where cm.org_id = v_org and cm.active
                and (v_dept is null or lower(btrim(coalesce(cm.department, ''))) = lower(v_dept))
                and not exists (select 1 from public.crew_availability a where a.crew_id = cm.id and a.day = p_date and a.status = 'unavailable')
                and not public._r23_on_event(p_quote, cm.id)
              order by cm.name limit 200 loop
      begin
        v_phone := public._assign132_phone(c.phone);
        if v_phone is null then continue; end if;
        w := public._r23_ensure_token(p_quote, c);
        v_body := 'Hi ' || coalesce(nullif(btrim(c.name), ''), 'there') || ', open shift: ' || v_title
          || ' on ' || to_char(p_date, 'DD/MM/YYYY')
          || case when p_start is not null then ' ' || to_char(p_start, 'HH24:MI') || case when p_end is not null then '-' || to_char(p_end, 'HH24:MI') else '' end else '' end
          || ' for ' || coalesce(nullif(btrim(q.title), ''), q.code)
          || case when p_wage is not null then ' (' || case when v_cur = 'INR' then 'Rs ' else v_cur || ' ' end
                   || to_char(round(p_wage), 'FM99,99,99,990') || case when coalesce(p_basis, 'day') = 'hour' then '/hour' else '/day' end || ')' else '' end
          || ', ' || p_needed || ' needed.' || case when w.token is not null then ' Tap to claim:' else ' Ask the office to claim it.' end;
        v_body := left(regexp_replace(v_body, '[[:cntrl:]<>]', ' ', 'g'), 880);
        insert into public.assign_notify_outbox (org_id, quote_id, item_kind, item_id, phone, name, body, link_path, created_by)
          values (v_org, p_quote, 'open_shift', v_id, v_phone, left(nullif(btrim(c.name), ''), 120), v_body,
                  case when w.token is not null then 'work.html?token=' || w.token::text end, auth.uid());
        v_n := v_n + 1;
      exception when others then
        raise warning 'r23-crew-0265: shift notice skipped (%)', sqlstate;
      end;
    end loop;
    update public.open_shifts set notified = v_n where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'notified', v_n);
end $$;

create or replace function public.open_shift_set_status(p_shift uuid, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265: close (no more claims) / reopen / cancel. Approved people keep their task (the office decides).
declare v_org uuid := public.current_org_id(); s public.open_shifts; n int;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into s from public.open_shifts where id = p_shift and org_id = v_org for update;
  if s.id is null then raise exception 'shift not found' using errcode = 'P0002'; end if;
  if p_action = 'close' then
    if s.status <> 'open' then raise exception 'Only an open shift can be closed.' using errcode = '22023'; end if;
    update public.open_shifts set status = 'closed', closed_at = now(), updated_at = now() where id = s.id;
  elsif p_action = 'reopen' then
    if s.status not in ('closed', 'filled') then raise exception 'Only a closed or full shift can be re-opened.' using errcode = '22023'; end if;
    select count(*) into n from public.open_shift_claims c where c.shift_id = s.id and c.status = 'approved';
    if n >= s.needed then raise exception 'All % places are taken - nothing to re-open.', s.needed using errcode = '22023'; end if;
    update public.open_shifts set status = 'open', closed_at = null, updated_at = now() where id = s.id;
  elsif p_action = 'cancel' then
    if s.status = 'cancelled' then return jsonb_build_object('ok', true, 'status', 'cancelled'); end if;
    update public.open_shifts set status = 'cancelled', closed_at = now(), updated_at = now() where id = s.id;
    update public.open_shift_claims set status = 'declined', decided_at = now(), decided_by = auth.uid(), decline_reason = 'the shift was cancelled'
     where shift_id = s.id and status = 'pending';
  else
    raise exception 'invalid action' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true, 'status', (select status from public.open_shifts where id = s.id));
end $$;

create or replace function public.open_shift_decide(p_claim uuid, p_approve boolean, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare v_org uuid := public.current_org_id(); cl public.open_shift_claims; s public.open_shifts; n int; c public.crew_members;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into cl from public.open_shift_claims where id = p_claim and org_id = v_org;
  if cl.id is null then raise exception 'claim not found' using errcode = 'P0002'; end if;
  select * into s from public.open_shifts where id = cl.shift_id and org_id = v_org for update;
  select * into cl from public.open_shift_claims where id = p_claim for update;
  if cl.status <> 'pending' then raise exception 'This claim was already decided.' using errcode = '22023'; end if;
  select * into c from public.crew_members where id = cl.crew_id and org_id = v_org;
  if coalesce(p_approve, false) then
    if s.status not in ('open', 'closed') then raise exception 'This shift is % - re-open it first.', s.status using errcode = '22023'; end if;
    if not c.active then raise exception 'This staff member is no longer active.' using errcode = '22023'; end if;
    select count(*) into n from public.open_shift_claims x where x.shift_id = s.id and x.status = 'approved';
    if n >= s.needed then raise exception 'All % places are already taken.', s.needed using errcode = '22023'; end if;
    update public.open_shift_claims set status = 'approved', decided_at = now(), decided_by = auth.uid() where id = cl.id;
    perform public._r23_claim_task(cl.id);
    perform public._r23_shift_fill_check(s.id);
  else
    update public.open_shift_claims set status = 'declined', decided_at = now(), decided_by = auth.uid(),
           decline_reason = nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]<>]', ' ', 'g')), 300), '')
     where id = cl.id;
  end if;
  return jsonb_build_object('ok', true, 'status', case when coalesce(p_approve, false) then 'approved' else 'declined' end);
end $$;

create or replace function public.open_shifts_for_event(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265: wages shown to people who can edit Staff (they post them)
declare v_org uuid := public.current_org_id(); v_wage boolean;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'no such event' using errcode = 'P0002'; end if;
  v_wage := public.has_area('staff', 'edit');
  return jsonb_build_object('can_edit', public.has_area('staff', 'edit'), 'settings', public._r23_cfg(v_org),
    'shifts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'title', s.title, 'department', s.department, 'date', s.shift_date,
        'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
        'wage', case when v_wage then s.wage end, 'basis', s.wage_basis, 'needed', s.needed, 'mode', s.claim_mode,
        'category', s.task_category, 'note', s.note, 'status', s.status, 'notified', s.notified, 'created_at', s.created_at,
        'claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'crew_id', c.crew_id, 'name', cm.name, 'department', cm.department,
                              'status', c.status, 'claimed_at', c.claimed_at, 'decided_at', c.decided_at, 'reason', c.decline_reason,
                              'task_id', c.task_id) order by c.claimed_at)
                             from public.open_shift_claims c join public.crew_members cm on cm.id = c.crew_id
                            where c.shift_id = s.id), '[]'::jsonb)) order by s.shift_date, s.start_time nulls first, s.created_at)
       from public.open_shifts s where s.quote_id = p_quote and s.org_id = v_org), '[]'::jsonb));
end $$;

create or replace function public.event_checkin_site_set(p_quote uuid, p_lat numeric, p_lng numeric, p_radius integer default 300)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265: the venue point for the optional location check (null lat / lng = no location check for this event)
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not (public.has_area('staff', 'edit') or public.has_area('command', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'no such event' using errcode = 'P0002'; end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'Give both latitude and longitude.' using errcode = '22023'; end if;
  if p_lat is not null and (not (p_lat between -90 and 90) or not (p_lng between -180 and 180)) then
    raise exception 'That is not a valid location.' using errcode = '22023'; end if;
  if p_radius is null or p_radius < 50 or p_radius > 5000 then raise exception 'Radius must be 50 to 5000 metres.' using errcode = '22023'; end if;
  insert into public.event_checkin_sites (quote_id, org_id, lat, lng, radius_m, set_by, updated_at)
    values (p_quote, v_org, round(p_lat, 6), round(p_lng, 6), p_radius, auth.uid(), now())
  on conflict (quote_id) do update set lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m, set_by = auth.uid(), updated_at = now()
   where public.event_checkin_sites.org_id = v_org;
  return jsonb_build_object('ok', true, 'lat', round(p_lat, 6), 'lng', round(p_lng, 6), 'radius_m', p_radius);
end $$;

create or replace function public.event_timesheet(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-crew-0265: times + hours + late / no-show flags (no pay - that is the ledger, admin only)
declare v_org uuid := public.current_org_id(); v_tz text; v_cfg jsonb; v_today date; q record; v_site record; v_rows jsonb;
begin
  if auth.uid() is null or v_org is null or not (public.has_area('staff', 'view') or public.has_area('command', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select qq.id, qq.event_date into q from public.quotes qq where qq.id = p_quote and qq.org_id = v_org;
  if q.id is null then raise exception 'no such event' using errcode = 'P0002'; end if;
  v_tz := public._r23_tz(v_org); v_cfg := public._r23_cfg(v_org); v_today := public._a198_org_today(v_org);
  select s.lat, s.lng, s.radius_m into v_site from public.event_checkin_sites s where s.quote_id = p_quote and s.org_id = v_org;
  select coalesce(jsonb_agg(jsonb_build_object(
      'crew_id', x.id, 'name', x.name, 'department', x.department, 'roster', x.roster,
      'expected_start', to_char(x.exp at time zone v_tz, 'HH24:MI'),
      'entries', x.entries,
      'hours', x.hours,
      'flag', case when x.n_in > 0 and x.max_late > (v_cfg ->> 'lateGraceMin')::int then 'late'
                   when x.n_in > 0 then null
                   when x.roster = 'no_show' then 'no_show'
                   when x.roster in ('arrived', 'left') then null
                   when x.exp is not null and now() > x.exp + make_interval(mins => (v_cfg ->> 'noShowAfterMin')::int) then 'no_show_suspected'
                   end,
      'late_min', x.max_late) order by x.name, x.id), '[]'::jsonb)
    into v_rows
  from (
    select cm.id, cm.name, cm.department,
           (select d.status from public.event_day d where d.quote_id = p_quote and d.org_id = v_org and d.kind = 'arrival' and d.ref_id = cm.id
             order by d.updated_at desc limit 1) as roster,
           public._r23_expected_start(p_quote, cm.id, coalesce((select min(k.work_day) from public.crew_checkins k where k.quote_id = p_quote and k.crew_id = cm.id), q.event_date)) as exp,
           (select count(*) from public.crew_checkins k where k.quote_id = p_quote and k.crew_id = cm.id) as n_in,
           (select max(k.late_min) from public.crew_checkins k where k.quote_id = p_quote and k.crew_id = cm.id) as max_late,
           (select round(sum(extract(epoch from (k.check_out_at - k.check_in_at)) / 3600.0)::numeric, 2) from public.crew_checkins k
             where k.quote_id = p_quote and k.crew_id = cm.id and k.check_out_at is not null) as hours,
           coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'day', k.work_day,
                       'in', to_char(k.check_in_at at time zone v_tz, 'HH24:MI'), 'out', to_char(k.check_out_at at time zone v_tz, 'HH24:MI'),
                       'in_at', k.check_in_at, 'out_at', k.check_out_at, 'late_min', k.late_min,
                       'distance_m', k.in_distance_m, 'within', k.in_within, 'source', k.source,
                       'edited', k.edited_at is not null, 'edit_note', k.edit_note,
                       'orig_in', to_char(k.orig_check_in_at at time zone v_tz, 'HH24:MI'), 'orig_out', to_char(k.orig_check_out_at at time zone v_tz, 'HH24:MI'))
                     order by k.work_day) from public.crew_checkins k where k.quote_id = p_quote and k.crew_id = cm.id), '[]'::jsonb) as entries
      from public.crew_members cm
     where cm.org_id = v_org
       and (public._r23_on_event(p_quote, cm.id) or exists (select 1 from public.crew_checkins k where k.quote_id = p_quote and k.crew_id = cm.id))) x;
  return jsonb_build_object('rows', v_rows, 'today', v_today, 'event_date', q.event_date,
    'site', case when v_site.lat is not null then jsonb_build_object('lat', v_site.lat, 'lng', v_site.lng, 'radius_m', v_site.radius_m) end,
    'settings', jsonb_build_object('selfCheckin', v_cfg -> 'selfCheckin', 'geofence', v_cfg -> 'geofence', 'geofenceRadiusM', v_cfg -> 'geofenceRadiusM',
                                   'lateGraceMin', v_cfg -> 'lateGraceMin', 'noShowAfterMin', v_cfg -> 'noShowAfterMin', 'payBasis', v_cfg -> 'payBasis'),
    'can_edit', public.has_area('command', 'edit') or public.has_area('staff', 'edit'));
end $$;

-- office enters / corrects a person's times (the crew's own first times are kept in orig_*)
create or replace function public.crew_checkin_office_set(p_quote uuid, p_crew uuid, p_day date, p_in timestamptz, p_out timestamptz default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-crew-0265
declare v_org uuid := public.current_org_id(); q record; c public.crew_members; v_rec public.crew_checkins; v_note text; v_today date;
begin
  if auth.uid() is null or v_org is null or not (public.has_area('command', 'edit') or public.has_area('staff', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select qq.id, qq.event_date into q from public.quotes qq where qq.id = p_quote and qq.org_id = v_org and qq.deleted_at is null;
  if q.id is null then raise exception 'no such event' using errcode = 'P0002'; end if;
  select * into c from public.crew_members where id = p_crew and org_id = v_org;
  if c.id is null then raise exception 'staff member not found' using errcode = 'P0002'; end if;
  v_today := public._a198_org_today(v_org);
  if p_day is null or p_day > v_today or p_day < coalesce(q.event_date, v_today) - 7 then
    raise exception 'Pick the work day (not in the future).' using errcode = '22023'; end if;
  if p_in is null then raise exception 'Give the check-in time.' using errcode = '22023'; end if;
  if p_in > now() + interval '5 minutes' or (p_out is not null and p_out > now() + interval '5 minutes') then
    raise exception 'Times cannot be in the future.' using errcode = '22023'; end if;
  if p_out is not null and (p_out < p_in or p_out - p_in > interval '24 hours') then
    raise exception 'The out time must be after the in time and within 24 hours.' using errcode = '22023'; end if;
  v_note := nullif(left(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]<>]', ' ', 'g')), 300), '');
  select * into v_rec from public.crew_checkins k where k.quote_id = p_quote and k.crew_id = p_crew and k.work_day = p_day for update;
  if v_rec.id is not null then
    if v_rec.source = 'crew' and v_note is null then raise exception 'Say why you are changing the times the crew member recorded.' using errcode = '22023'; end if;
    update public.crew_checkins set
      orig_check_in_at = coalesce(orig_check_in_at, case when source = 'crew' then check_in_at end),
      orig_check_out_at = case when orig_check_in_at is null and source = 'crew' then check_out_at else orig_check_out_at end,
      check_in_at = p_in, check_out_at = p_out, edited_by = auth.uid(), edited_at = now(), edit_note = v_note, updated_at = now(),
      late_min = case when expected_start is not null and p_in > expected_start then floor(extract(epoch from (p_in - expected_start)) / 60)::integer else 0 end
     where id = v_rec.id;
  else
    insert into public.crew_checkins (org_id, quote_id, crew_id, work_day, check_in_at, check_out_at, expected_start, late_min, source, edited_by, edited_at, edit_note)
      select v_org, p_quote, p_crew, p_day, p_in, p_out, e.exp,
             case when e.exp is not null and p_in > e.exp then floor(extract(epoch from (p_in - e.exp)) / 60)::integer else 0 end,
             'office', auth.uid(), now(), v_note
        from (select public._r23_expected_start(p_quote, p_crew, p_day) as exp) e;
  end if;
  update public.event_day d set status = case when p_out is not null then 'left' else 'arrived' end
   where d.quote_id = p_quote and d.org_id = v_org and d.kind = 'arrival' and d.ref_id = p_crew;
  if not found then
    insert into public.event_day (quote_id, org_id, kind, who, role, ref_id, status, note, created_by)
      values (p_quote, v_org, 'arrival', left(c.name, 200), left(coalesce(nullif(btrim(c.department), ''), 'Staff'), 60), p_crew,
              case when p_out is not null then 'left' else 'arrived' end, 'entered by the office', auth.uid());
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================================================
-- 6) a task made from a shift that the crew member rejects (or the office cancels) frees the place again
-- ============================================================================================================
create or replace function public.tg_r23_shift_task_release()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r23-crew-0265
declare r record;
begin
  begin
    for r in update public.open_shift_claims set status = 'withdrawn', decided_at = now(),
                    decline_reason = case when new.status = 'rejected' then 'the task was rejected' else 'the task was cancelled' end
              where task_id = new.id and status = 'approved' returning shift_id loop
      update public.open_shifts s set status = 'open', closed_at = null, updated_at = now()
       where s.id = r.shift_id and s.status = 'filled'
         and (select count(*) from public.open_shift_claims c where c.shift_id = s.id and c.status = 'approved') < s.needed;
    end loop;
  exception when others then
    raise warning 'r23-crew-0265: shift release skipped (%)', sqlstate;
  end;
  return new;
end $$;
drop trigger if exists zz_r23_shift_task_release on public.event_tasks;
create trigger zz_r23_shift_task_release after update of status on public.event_tasks
  for each row when (new.status in ('rejected', 'cancelled') and old.status is distinct from new.status)
  execute function public.tg_r23_shift_task_release();

-- ============================================================================================================
-- 7) WhatsApp notices: the 0132 outbox learns the 'open_shift' kind (superset) + one claim branch
-- ============================================================================================================
do $$ declare v_def text; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.assign_notify_outbox'::regclass and c.conname = 'assign_notify_outbox_item_kind_check';
  if v_def is not null and position('open_shift' in v_def) > 0 then return; end if;
  if v_def is distinct from 'CHECK ((item_kind = ANY (ARRAY[''runsheet''::text, ''task''::text])))' then
    raise notice '0265: assign_notify_outbox item_kind check has an unexpected body - left unchanged (shift notices are not queued)'; return; end if;
  alter table public.assign_notify_outbox add constraint assign_notify_outbox_item_kind_check_0265
    check (item_kind in ('runsheet', 'task', 'open_shift'));
  alter table public.assign_notify_outbox drop constraint assign_notify_outbox_item_kind_check;
  alter table public.assign_notify_outbox rename constraint assign_notify_outbox_item_kind_check_0265 to assign_notify_outbox_item_kind_check;
end $$;

do $$
declare v_src text := (select prosrc from pg_proc where oid = to_regprocedure('public.assign_notify_claim(integer)'));
begin
  if v_src is null then raise notice '0265: assign_notify_claim missing - shift notices stay queued only'; return; end if;
  if position('r23-crew-0265' in v_src) > 0 then return; end if;
  if position('helm-0132-assign-notify' in v_src) = 0 or position('when ''task'' then exists' in v_src) = 0 then
    raise notice '0265: assign_notify_claim has an unexpected body - left unchanged (shift notices will be skipped)'; return; end if;
  execute $f$
create or replace function public.assign_notify_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $b$
-- helm-0132-assign-notify: gates re-checked at claim time (r23-crew-0265: + open shifts still open)
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; v_cfg jsonb;
begin
  update public.assign_notify_outbox set status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  update public.assign_notify_outbox set status = 'skipped', sent_at = now() where sent_at is null and created_at < now() - interval '1 day';
  for r in select o.* from public.assign_notify_outbox o
     where o.sent_at is null and o.status = 'pending' and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
       and o.updated_at < now() - interval '1 minute'          -- let a burst of edits settle first
     order by o.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update skip locked
  loop
    v_cfg := public._comms_cfg(r.org_id);
    v_ok := coalesce(v_cfg ->> 'studio_whatsapp', '') ~ '^[0-9]{8,15}$'
      and not exists (select 1 from public.whatsapp_opt_outs x where x.phone = r.phone and x.opted_out
                        and (x.org_id is null or x.org_id = r.org_id))
      and exists (select 1 from public.quotes q where q.id = r.quote_id and q.org_id = r.org_id and q.deleted_at is null
                    and coalesce(q.status, '') <> 'cancelled')
      and case r.item_kind
            when 'runsheet' then exists (select 1 from public.run_sheet_items i where i.id = r.item_id and i.quote_id = r.quote_id)
            when 'task' then exists (select 1 from public.event_tasks t where t.id = r.item_id and t.quote_id = r.quote_id)
            when 'open_shift' then exists (select 1 from public.open_shifts s where s.id = r.item_id and s.quote_id = r.quote_id and s.status = 'open')
            else false end;
    if not coalesce(v_ok, false) then
      update public.assign_notify_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.assign_notify_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', r.phone, 'text', r.body, 'link_path', r.link_path));
  end loop;
  return v_out;
end $b$;
$f$;
end $$;

-- ============================================================================================================
-- 8) the ledger: _r21_cost_lines section D (replaced only while it is the 0252 body, or already this one)
-- ============================================================================================================
do $do$
declare v_src text := (select prosrc from pg_proc where oid = to_regprocedure('public._r21_cost_lines(uuid,uuid)'));
begin
  if position('r22-money-0252' in coalesce(v_src, '')) = 0 then
    raise notice '0265: _r21_cost_lines is not the 0252 body - left unchanged (wages keep using the arrival roster only)'; return; end if;
  execute $fn$
create or replace function public._r21_cost_lines(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-money-0246 (r22-money-0252: a task naming a crew member counts while unassigned - estimated wage)
-- r23-crew-0265: crew wages use the crew link's check-in / check-out times, shift wages and hourly pay (section D)
declare
  v_lines jsonb := '[]'::jsonb; v_part jsonb;
  v_lb numeric; v_llf numeric; v_bills_win boolean; v_has_crew boolean;
  v_cfg jsonb := public._r23_cfg(p_org); v_basis text; v_day_h numeric;
begin
  v_basis := coalesce(v_cfg ->> 'payBasis', 'day'); if v_basis = 'hours' then v_basis := 'hours'; else v_basis := 'day'; end if;
  v_day_h := coalesce((v_cfg ->> 'dayHours')::numeric, 8); if v_day_h <= 0 then v_day_h := 8; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = p_org) then return null; end if;

  -- crew on this event: assigned by a live task, or on the arrival roster (a crew member of this studio)
  v_has_crew := exists (select 1 from public.event_tasks t join public.crew_members cm on cm.id = t.crew_id and cm.org_id = p_org
                         where t.quote_id = p_quote and t.org_id = p_org and t.status not in ('rejected', 'cancelled'))
             or exists (select 1 from public.event_day d join public.crew_members cm on cm.id = d.ref_id and cm.org_id = p_org
                         where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival');

  -- A) active vendor bookings: one line each (bills, else a typed actual on its cost line(s), else committed / estimate)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'booking:' || x.id, 'source', 'booking', 'source_id', x.id, 'category', x.cat, 'label', x.label,
      'estimated', x.est, 'committed', x.com, 'actual', x.act,
      'c_est', x.est, 'c_com', coalesce(x.com, 0), 'c_fc', coalesce(x.act, x.com, x.est), 'c_act', coalesce(x.act, 0),
      'paid', x.paid, 'gst_status', x.gst_status, 'input_tax', x.itc, 'blocked_gst', x.blocked,
      'bills', x.nbills, 'note', x.note) order by x.cat, x.label), '[]'::jsonb)
    into v_part
  from (
    select b.id, coalesce(nullif(btrim(b.label), ''), 'Vendor booking') as label, y.cat,
           case when coalesce(l.est, 0) > 0 then l.est else coalesce(b.cost, l.est, 0) end as est,
           case when b.status in ('booked', 'confirmed', 'delivered') or b.contract
                then coalesce(b.cost, case when coalesce(l.est, 0) > 0 then l.est end) end as com,
           case when bl.n > 0 then bl.cost when l.n > 0 and l.n_act = l.n then l.act end as act,
           coalesce(bl.paid, 0) + coalesce(b.advance, 0) as paid,
           case when bl.n > 0 then case when bl.n_unknown > 0 then 'unknown' else 'split' end end as gst_status,
           coalesce(bl.itc, 0) as itc, coalesce(bl.blocked, 0) as blocked, coalesce(bl.n, 0) as nbills,
           case when bl.n > 0 then 'actual from ' || bl.n || ' vendor bill(s)'
                when l.n > 0 and l.n_act = l.n then 'actual typed on the budget line'
                when b.status in ('booked', 'confirmed', 'delivered') or b.contract then 'booked - no bill yet'
                else 'enquiry - estimate only' end as note
      from public.event_resources b
      left join public.vendors v on v.id = b.vendor_id and v.org_id = p_org
      left join lateral (
        select count(*) as n, count(k.actual) as n_act, sum(k.estimated) as est, sum(k.actual) as act,
               string_agg(coalesce(k.requirement_key, '') || ' ' || coalesce(k.category, '') || ' ' || coalesce(k.description, ''), ' ') as words
          from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote) l on true
      left join lateral (
        select count(*) as n, count(*) filter (where vb.gst_amount is null) as n_unknown,
               sum(vb.amount - case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end) as cost,
               sum(case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end) as itc,
               sum(case when vb.gst_amount is not null and not z.claim then vb.gst_amount else 0 end) as blocked,
               sum((select coalesce(sum(p.amount), 0) from public.vendor_payouts p where p.bill_id = vb.id)) as paid
          from public.vendor_bills vb
          cross join lateral (select coalesce(vb.gst_claimable,
                      public._r21_category(coalesce(l.words, '') || ' ' || coalesce(b.kind, '') || ' ' || coalesce(b.label, '') || ' ' || coalesce(v.category, ''), 'vendors') <> 'food') as claim) z
         where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void') bl on true
      cross join lateral (select public._r21_category(
                  case when l.words ~ '(^| )std:' then substring(l.words from 'std:[a-z]+')
                       else coalesce(l.words, '') || ' ' || coalesce(b.kind, '') || ' ' || coalesce(b.label, '') || ' ' || coalesce(v.category, '') end,
                  'vendors') as cat) y
     where b.quote_id = p_quote and b.org_id = p_org and b.status <> 'cancelled') x;
  v_lines := v_lines || v_part;

  -- B) vendor spend NOT tied to an active booking has ONE source (0146 rule): the unlinked bills or the
  --    unlinked "vendor" cost lines, whichever is larger - never both. The other side shows, counted 0.
  v_lb := coalesce((select sum(vb.amount - case when vb.gst_amount is not null and coalesce(vb.gst_claimable,
                         public._r21_category(coalesce(v.category, '') || ' ' || coalesce(v.name, '') || ' ' || coalesce(vb.description, ''), 'vendors') <> 'food')
                       then vb.gst_amount else 0 end)
       from public.vendor_bills vb left join public.vendors v on v.id = vb.vendor_id and v.org_id = p_org
      where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
        and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')), 0);
  v_llf := coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
      where k.quote_id = p_quote and k.org_id = p_org and k.kind = 'vendor' and not (k.crew_covered and v_has_crew)
        and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0);
  v_bills_win := v_lb > 0 and v_lb >= v_llf;

  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'bill:' || x.id, 'source', 'bill', 'source_id', x.id, 'category', x.cat,
      'label', x.label, 'estimated', null, 'committed', null, 'actual', x.cost,
      'c_est', 0, 'c_com', 0, 'c_fc', case when v_bills_win then x.cost else 0 end, 'c_act', case when v_bills_win then x.cost else 0 end,
      'paid', x.paid, 'gst_status', case when x.gst_amount is null then 'unknown' else 'split' end,
      'input_tax', case when v_bills_win and x.gst_amount is not null and x.claim then x.gst_amount else 0 end,
      'blocked_gst', case when v_bills_win and x.gst_amount is not null and not x.claim then x.gst_amount else 0 end,
      'bills', 1,
      'note', case when v_bills_win then 'vendor bill not linked to a booking' else 'not counted: the vendor cost lines for this spend are larger' end)
      order by x.bill_date, x.id), '[]'::jsonb)
    into v_part
  from (
    select vb.id, vb.bill_date, vb.gst_amount, z.cat, z.claim,
           coalesce(nullif(btrim(coalesce(v.name, '') || case when vb.bill_no is not null then ' #' || vb.bill_no else '' end), ''), 'Vendor bill') as label,
           vb.amount - case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end as cost,
           (select coalesce(sum(p.amount), 0) from public.vendor_payouts p where p.bill_id = vb.id) as paid
      from public.vendor_bills vb
      left join public.vendors v on v.id = vb.vendor_id and v.org_id = p_org
      cross join lateral (select public._r21_category(coalesce(v.category, '') || ' ' || coalesce(v.name, '') || ' ' || coalesce(vb.description, ''), 'vendors') as cat) c0
      cross join lateral (select c0.cat as cat, coalesce(vb.gst_claimable, c0.cat <> 'food') as claim) z
     where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
       and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')) x;
  v_lines := v_lines || v_part;

  -- C) budget lines not tied to an active booking (vendor lines follow rule B; contingency is plan-only;
  --    a line ticked "replaced by crew wages" counts 0 while the event has crew)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'cost:' || x.id, 'source', case when x.kind = 'vendor' then 'vendor_line' else 'cost_line' end, 'source_id', x.id,
      'category', x.cat, 'label', x.label, 'estimated', x.estimated, 'committed', null, 'actual', x.actual,
      'c_est', case when x.replaced then 0 else x.estimated end, 'c_com', 0,
      'c_fc', case when x.replaced or (x.kind = 'vendor' and v_bills_win) then 0
                   when x.cat = 'contingency' then coalesce(x.actual, 0) else coalesce(x.actual, x.estimated) end,
      'c_act', case when x.replaced or (x.kind = 'vendor' and v_bills_win) then 0 else coalesce(x.actual, 0) end,
      'paid', null, 'crew_covered', x.crew_covered, 'staff_like', x.cat = 'staff',
      'note', case when x.replaced then 'replaced by the crew wage lines'
                   when x.kind = 'vendor' and v_bills_win then 'in the plan only: the unlinked vendor bills count instead'
                   when x.cat = 'contingency' then 'buffer - counts in the plan only'
                   when x.actual is not null then 'actual typed on the budget line'
                   else 'estimate only - no actual yet' end)
      order by x.created_at, x.id), '[]'::jsonb)
    into v_part
  from (
    select k.id, k.kind, k.estimated, k.actual, k.created_at, k.crew_covered,
           coalesce(nullif(btrim(k.description), ''), 'Cost line') as label,
           (k.crew_covered and v_has_crew) as replaced,
           public._r21_category(case when k.requirement_key ~ '^std:' then k.requirement_key
                                     else coalesce(k.category, '') || ' ' || coalesce(k.description, '') end,
                                case when k.kind = 'vendor' then 'vendors' else 'misc' end) as cat
      from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')) x;
  v_lines := v_lines || v_part;

  -- D) crew wages: one line per person.
  --    r23-crew-0265: Actual comes from the crew link's own check-in / check-out (crew_checkins) when there is one:
  --    day rate x days checked in, or hours worked x hourly rate when the studio pays by the hour (Control Center ->
  --    Crew: pay basis; hourly rate = day rate / day hours) or the open shift they claimed was posted per hour.
  --    A wage posted on an open shift replaces the day rate for that event. No check-in -> the event-day arrival
  --    roster as before ('arrived' or 'left' = 1 day, no-show = 0).
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'crew:' || y.id, 'source', 'crew', 'source_id', y.id, 'crew_id', y.id, 'category', 'staff',
      'label', y.name, 'day_rate', y.rate, 'rate_missing', y.rate_missing,
      'estimated', y.est, 'committed', case when y.accepted then y.est end,
      'actual', y.act,
      'c_est', y.est, 'c_com', case when y.accepted then y.est else 0 end,
      'c_fc', case when y.act is not null then y.act when y.no_show then 0 else y.est end,
      'c_act', coalesce(y.act, 0),
      'attendance', case when y.arrived then 'arrived' when y.no_show then 'no_show' else 'not_marked' end,
      'pay_basis', y.basis, 'hours', y.hours, 'days', y.days, 'checked_in', y.days > 0,
      'shift_wage', y.shift_wage, 'paid', null,
      'note', case when y.rate_missing then 'day rate missing - set it on the Staff page'
                   when y.days > 0 and y.basis = 'hours' and y.open_n > 0 and coalesce(y.hours, 0) = 0
                     then 'checked in on the crew link - not checked out yet (planned hours until then)'
                   when y.days > 0 and y.basis = 'hours'
                     then 'checked in / out on the crew link: ' || to_char(coalesce(y.hours, 0), 'FM9990.0') || ' h'
                          || case when y.open_n > 0 then ' so far (still checked in)' else '' end
                   when y.days > 0 then 'checked in on the crew link (' || y.days || ' day' || case when y.days = 1 then '' else 's' end || ')'
                   when y.arrived then 'arrived on the event day (1 day)'
                   when y.no_show then 'no-show on the event day (no wage)'
                   when y.accepted then 'accepted - attendance not marked yet'
                   else 'assigned - not accepted yet' end)
      order by y.name, y.id), '[]'::jsonb)
    into v_part
  from (
    select x.*,
           (coalesce(x.rate, 0) = 0 and x.shift_wage is null) as rate_missing,
           x.days > 0 or x.roster_in as arrived,
           not (x.days > 0 or x.roster_in) and x.roster_no as no_show,
           case when x.basis = 'hours' then round(coalesce(x.hourly, 0) * coalesce(x.planned_h, v_day_h), 2)
                else coalesce(x.rate, 0) end as est,
           case when x.days > 0 then
                  case when x.basis = 'hours' then
                         case when x.open_n > 0 and coalesce(x.hours, 0) = 0 then null
                              else round(coalesce(x.hourly, 0) * coalesce(x.hours, 0), 2) end
                       else coalesce(x.rate, 0) * x.days end
                when x.roster_in then
                  case when x.basis = 'hours' then round(coalesce(x.hourly, 0) * coalesce(x.planned_h, v_day_h), 2)
                       else coalesce(x.rate, 0) end
                when x.roster_no then 0 end as act
      from (
        select cm.id, coalesce(nullif(btrim(cm.name), ''), 'Crew member') as name,
               coalesce(case when sw.basis = 'day' then sw.wage end, cm.day_rate) as rate,
               case when sw.basis = 'hour' then sw.wage
                    when coalesce(cm.day_rate, 0) > 0 then round(cm.day_rate / v_day_h, 2) end as hourly,
               case when sw.basis = 'hour' then 'hours' when sw.basis = 'day' then 'day' else v_basis end as basis,
               sw.wage as shift_wage, sw.planned_h,
               coalesce(ci.days, 0) as days, round(ci.hours, 2) as hours, coalesce(ci.open_n, 0) as open_n,
               exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org and t.crew_id = cm.id
                         and (t.status in ('accepted', 'in_progress', 'completed') or (t.responded_at is not null and t.status not in ('rejected', 'cancelled')))) as accepted,
               exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                         and d.ref_id = cm.id and d.status in ('arrived', 'left')) as roster_in,
               exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                         and d.ref_id = cm.id and d.status = 'no_show') as roster_no
          from public.crew_members cm
          left join lateral (
            select s.wage, s.wage_basis as basis,
                   case when s.start_time is not null and s.end_time is not null
                        then round((extract(epoch from (s.end_time - s.start_time)) / 3600.0
                                    + case when s.end_time <= s.start_time then 24 else 0 end)::numeric, 2) end as planned_h
              from public.open_shift_claims c join public.open_shifts s on s.id = c.shift_id and s.org_id = p_org
             where c.quote_id = p_quote and c.org_id = p_org and c.crew_id = cm.id and c.status = 'approved' and s.wage is not null
             order by c.decided_at desc nulls last, c.id limit 1) sw on true
          left join lateral (
            select count(distinct k.work_day) filter (where k.check_in_at is not null) as days,
                   sum(extract(epoch from (k.check_out_at - k.check_in_at)) / 3600.0) filter (where k.check_out_at is not null) as hours,
                   count(*) filter (where k.check_in_at is not null and k.check_out_at is null) as open_n
              from public.crew_checkins k where k.quote_id = p_quote and k.org_id = p_org and k.crew_id = cm.id) ci on true
         where cm.org_id = p_org
           and (exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org and t.crew_id = cm.id
                          and t.status not in ('rejected', 'cancelled'))
             or exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival' and d.ref_id = cm.id))) x) y;
  v_lines := v_lines || v_part;

  -- E) expense claims (staff out-of-pocket): waiting = committed, approved / paid = actual, rejected = not a cost
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'claim:' || e.id, 'source', 'claim', 'source_id', e.id, 'category', 'misc',
      'label', 'Expense: ' || left(coalesce(nullif(btrim(e.who), ''), 'staff') || coalesce(' - ' || nullif(btrim(e.description), ''), ''), 160),
      'estimated', null, 'committed', case when e.status = 'pending' then e.amount end,
      'actual', case when e.status in ('approved', 'paid') then e.amount end,
      'c_est', 0, 'c_com', case when e.status = 'pending' then e.amount else 0 end,
      'c_fc', e.amount, 'c_act', case when e.status in ('approved', 'paid') then e.amount else 0 end,
      'paid', case when e.status = 'paid' then e.amount else 0 end, 'status', e.status,
      'note', case e.status when 'pending' then 'claim waiting for approval' when 'approved' then 'approved - not paid yet' else 'paid' end)
      order by e.created_at, e.id), '[]'::jsonb)
    into v_part
  from public.expense_claims e
  where e.quote_id = p_quote and e.org_id = p_org and e.status <> 'rejected';
  v_lines := v_lines || v_part;

  -- F) approved change orders: their extra cost is agreed (committed); the real spend arrives as a bill / line
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'change:' || c.id, 'source', 'change', 'source_id', c.id, 'category', 'changes',
      'label', 'Change: ' || left(coalesce(nullif(btrim(c.title), ''), 'change order'), 160),
      'estimated', c.cost_delta, 'committed', c.cost_delta, 'actual', null,
      'c_est', c.cost_delta, 'c_com', c.cost_delta, 'c_fc', c.cost_delta, 'c_act', 0, 'paid', null,
      'note', 'approved change order - extra cost agreed')
      order by c.created_at, c.id), '[]'::jsonb)
    into v_part
  from public.change_requests c
  where c.quote_id = p_quote and c.org_id = p_org and c.status = 'approved' and c.cost_delta <> 0;
  v_lines := v_lines || v_part;

  -- G) our own equipment written off at check-in: written off x the item's cost (absorbed by the event)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'writeoff:' || x.id, 'source', 'writeoff', 'source_id', x.id, 'category', 'damages',
      'label', x.name || ' x' || trim(to_char(x.written_off, 'FM999999990.##')),
      'estimated', null, 'committed', null, 'actual', x.cost,
      'c_est', 0, 'c_com', 0, 'c_fc', x.cost, 'c_act', x.cost, 'paid', null, 'cost_missing', x.unit_cost = 0,
      'note', case when x.unit_cost = 0 then 'written off - item cost missing (set it in Inventory)' else 'written off at check-in' end)
      order by x.name, x.id), '[]'::jsonb)
    into v_part
  from (
    select ch.id, ch.written_off, coalesce(i.unit_cost, 0) as unit_cost,
           coalesce(nullif(btrim(i.name), ''), 'Item') as name, round(ch.written_off * coalesce(i.unit_cost, 0), 2) as cost
      from public.inventory_checkouts ch join public.inventory_items i on i.id = ch.item_id and i.org_id = p_org
     where ch.quote_id = p_quote and ch.org_id = p_org and ch.written_off > 0 and ch.status <> 'cancelled') x;
  v_lines := v_lines || v_part;

  return v_lines;
end $$
$fn$;
end $do$;

-- grants as in 0246 (internal: never callable by the app)
do $$ begin
  execute 'revoke all on function public._r21_cost_lines(uuid, uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r21_cost_lines(uuid, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r21_cost_lines(uuid, uuid) from authenticated'; end if;
end $$;

-- ============================================================================================================
-- 9) grants: internal helpers -> nobody; crew-link RPCs -> anon + authenticated; office RPCs -> authenticated
-- ============================================================================================================
do $$
declare f text;
  v_internal text[] := array['public._r23_cfg(uuid)', 'public._r23_tz(uuid)', 'public._r23_parse_time(text)',
    'public._r23_crew_of_token(public.work_tokens)', 'public._r23_notify(uuid,text,jsonb)', 'public._r23_ensure_token(uuid,public.crew_members)',
    'public._r23_expected_start(uuid,uuid,date)', 'public._r23_dist_m(numeric,numeric,numeric,numeric)', 'public._r23_on_event(uuid,uuid)',
    'public._r23_claim_task(uuid)', 'public._r23_shift_fill_check(uuid)', 'public.tg_r23_shift_task_release()',
    'public.assign_notify_claim(integer)'];
  v_link text[] := array['public.crew_link_home(uuid)', 'public.crew_set_availability(uuid,date,text,text)',
    'public.crew_claim_shift(uuid,uuid)', 'public.crew_withdraw_claim(uuid,uuid)', 'public.crew_check(uuid,text,numeric,numeric,numeric)'];
  v_office text[] := array['public.get_crew_settings()', 'public.set_crew_settings(jsonb)',
    'public.crew_availability_range(date,date,uuid)', 'public.crew_availability_set(uuid,date,text,text)', 'public.crew_day_status(date,uuid)',
    'public.open_shift_post(uuid,text,date,time,time,numeric,text,integer,text,text,text,text)', 'public.open_shift_set_status(uuid,text)',
    'public.open_shift_decide(uuid,boolean,text)', 'public.open_shifts_for_event(uuid)', 'public.event_checkin_site_set(uuid,numeric,numeric,integer)',
    'public.event_timesheet(uuid)', 'public.crew_checkin_office_set(uuid,uuid,date,timestamptz,timestamptz,text)'];
begin
  foreach f in array v_internal || v_link || v_office loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array v_link loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  foreach f in array v_office loop
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.assign_notify_claim(integer) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
