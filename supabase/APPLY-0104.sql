-- APPLY-0104.sql - paste into the Supabase SQL editor (prod or staging). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains 0104_venue_samples_4.sql:
--   * "Load sample venues" now offers a 4th sample: 'SAMPLE - Square Garden Pavilion, Gachibowli',
--     exactly 200 x 200 ft (stored 60.96 x 60.96 m, unit ft).
--   * The loader adds only the sample names a studio is missing: studios that already loaded the
--     3 old samples get just the new one; clicking again adds nothing. Studios with only their own
--     venues still get nothing (unchanged). Existing rows are never changed or removed.
--   Function only (venue_load_samples) - no table, column or row is changed by this paste.
-- Needs 0085 - checked below with a clear message.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

-- =================================================================================================
-- 0104_venue_samples_4.sql
-- =================================================================================================
-- ============================================================================
-- 0104_venue_samples_4.sql - CANONICAL forward-only. 4th sample venue (200 x 200 ft).
-- REQUIRES 0085 (venues table + venue_load_samples).
--
-- In plain words:
--   "Load sample venues" (Control Center -> Venues, admin only) now offers 4 sample venues.
--   The new one is 'SAMPLE - Square Garden Pavilion, Gachibowli': an exactly 200 x 200 ft
--   open-air lawn + covered pavilion (stored as 60.96 x 60.96 m, shown as 200 x 200 ft).
--   The loader is now "add what is missing":
--     * a studio with no venues gets all 4;
--     * a studio that already loaded the 3 old samples gets only the new 4th one;
--     * clicking again adds nothing (a sample whose name already exists is skipped);
--     * a studio that only has its own (non-sample) venues still gets nothing, as before.
--   Existing rows are never changed or removed. Function only - no table or column change.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.venue_load_samples()') is null or to_regclass('public.venues') is null then
    raise exception '0104: venues / venue_load_samples() missing (apply 0085 first)'; end if;
end $$;

create or replace function public.venue_load_samples()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- venues-0104
declare v_org uuid := public.current_org_id(); n int;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') <> 'admin' then
    raise exception 'Only an admin can load sample venues.' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('venues.samples:' || v_org::text));
  if exists (select 1 from public.venues v where v.org_id = v_org)
     and not exists (select 1 from public.venues v where v.org_id = v_org and v.is_sample) then
    return jsonb_build_object('ok', true, 'added', 0, 'reason', 'studio already has venues');
  end if;
  insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m,
      dim_unit, event_types, restrictions, restrictions_note, sound_curfew, setup_window, cost_min, cost_max, cost_basis,
      parking_spaces, rooms, power_backup_kw, green_rooms, washrooms, address, city, map_url, contact_name, notes,
      is_sample, created_by)
  select v_org, s.name, s.venue_type, s.ac_type, s.setting, s.seated, s.floating, s.len, s.wid, s.unit,
         s.evs, s.rst, s.note, s.curfew, s.setup, s.cmin, s.cmax, 'per_day', s.parking, s.rooms, s.kw, s.green, s.wash,
         s.address, 'Hyderabad', s.map_url, s.contact, s.notes, true, auth.uid()
    from (values
      (1, 'SAMPLE - Grand Convention Centre, Hitec City', 'convention_centre', 'ac', 'indoor', 1200, 2000, 60::numeric, 40::numeric, 'm',
       array['conference', 'corporate', 'product_launch', 'reception', 'wedding', 'concert']::text[],
       array['decor_vendor_tieup', 'no_open_flame', 'setup_window']::text[],
       'Sample data - edit or deactivate. Fire NOC needed for pyro; load-in through the service gate only.', null::time,
       '06:00-23:00 (setup from 6 AM on event day)', 350000::numeric, 600000::numeric, 400, 0, 500::numeric, 4, 24,
       'Hitec City Main Road, Madhapur', null::text, null::text, 'Sample venue (not real).'),
      (2, 'SAMPLE - Royal Banquet Hall', 'banquet_hall', 'ac', 'indoor', 450, 700, 35, 22, 'm',
       array['wedding', 'reception', 'engagement', 'birthday', 'corporate']::text[],
       array['no_outside_catering', 'no_fireworks', 'sound_curfew']::text[],
       'Sample data - in-house catering only.', '23:00', null, 150000, 250000, 120, 6, 250, 2, 10,
       'Road No. 12, Banjara Hills', null, null, 'Sample venue (not real).'),
      (3, 'SAMPLE - Green Meadows Lawn', 'lawn', 'non_ac', 'outdoor', null, 2000, 80, 50, 'm',
       array['wedding', 'reception', 'festival', 'concert', 'political', 'birthday']::text[],
       array['sound_curfew', 'generator_required', 'parking_limited']::text[],
       'Sample data - no permanent power; bring generators. Rain plan needed June-September.', '22:00', null,
       200000, 400000, 150, 0, 0, 1, 8,
       'Shamshabad Road, near ORR exit 15', null, null, 'Sample venue (not real).'),
      (4, 'SAMPLE - Square Garden Pavilion, Gachibowli', 'lawn', 'non_ac', 'both', 2400, 4000, 60.96, 60.96, 'ft',
       array['wedding', 'reception', 'engagement', 'corporate', 'product_launch', 'festival', 'birthday']::text[],
       array['sound_curfew', 'no_fireworks', 'no_open_flame', 'decor_vendor_tieup', 'parking_limited', 'setup_window']::text[],
       'Sample data - edit or deactivate. Exactly 200 x 200 ft (40,000 sq ft) square lawn with a covered pavilion. '
       || 'Music till 10 PM, max 75 dB at the boundary. No fireworks or sky lanterns. Diesel generator allowed only with '
       || 'an acoustic silencer canopy, parked at the service gate. Vehicle gate 14 ft wide x 13 ft high. Load-in 8 AM - 8 PM '
       || '(day before + event day); load-out by 2 AM. No nails, staples or tape on the pavilion columns - free-standing '
       || 'or truss only. Catering by the venue''s empanelled partners, or an outside caterer for a kitchen fee.',
       '22:00', '08:00-20:00 load-in (day before + event day); clear by 02:00', 250000, 450000, 180, 2, 125, 2, 16,
       'Plot 21, Financial District Road, near ISB, Gachibowli', 'https://maps.google.com/?q=Gachibowli,Hyderabad',
       'Venue manager (sample contact)', 'Sample venue (not real). 200 x 200 ft.')
    ) as s(ord, name, venue_type, ac_type, setting, seated, floating, len, wid, unit, evs, rst, note, curfew, setup,
           cmin, cmax, parking, rooms, kw, green, wash, address, map_url, contact, notes)
   where not exists (select 1 from public.venues v where v.org_id = v_org and lower(btrim(v.name)) = lower(btrim(s.name)))
   order by s.ord;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'added', n);
end $$;

do $$ begin
  execute 'revoke all on function public.venue_load_samples() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.venue_load_samples() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.venue_load_samples() to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.venue_load_samples() to service_role'; end if;
end $$;

commit;

-- =================================================================================================
-- verify (read-only)
-- =================================================================================================
select item, ok from (values
  ('0104 01 venue_load_samples is the 0104 body', exists (select 1 from pg_proc where oid = 'public.venue_load_samples()'::regprocedure and prosrc like '%venues-0104%')),
  ('0104 02 loader has the 200 x 200 ft sample (60.96 m, unit ft)', position('''SAMPLE - Square Garden Pavilion, Gachibowli'', ''lawn'', ''non_ac'', ''both'', 2400, 4000, 60.96, 60.96, ''ft''' in (select prosrc from pg_proc where oid = 'public.venue_load_samples()'::regprocedure)) > 0),
  ('0104 03 loader skips names the studio already has', position('lower(btrim(v.name)) = lower(btrim(s.name))' in (select prosrc from pg_proc where oid = 'public.venue_load_samples()'::regprocedure)) > 0),
  ('0104 04 definer with empty search_path', exists (select 1 from pg_proc where oid = 'public.venue_load_samples()'::regprocedure and prosecdef and coalesce(proconfig, '{}') @> array['search_path=""'])),
  ('0104 05 grants: authenticated yes, anon no', has_function_privilege('authenticated', 'public.venue_load_samples()', 'execute') and not has_function_privilege('anon', 'public.venue_load_samples()', 'execute'))
) v(item, ok)
order by item;
