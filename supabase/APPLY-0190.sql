-- APPLY-0190.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0168 / 0169 (works on the current production state 0166-0172 and on the trial bundle 0173-0177).
-- Free-trial sign-up reliability: the sign-up call (start_self_serve_trial) is 2-3x faster so it stays far
-- inside Supabase's 8 second API limit (a time-out cannot be caught and would undo the whole sign-up):
-- cheap time zone check instead of reading pg_timezone_names on every sign-up, and a faster sample clone
-- (same rows, same result). The clone also reports 'kept_existing' (sample rows the new studio already had,
-- e.g. the 145 library dishes + 6 menu packages create_studio copies) so the audit log no longer reads
-- "dish_catalog 0, menu_templates 0".
-- Functions only: 2 bodies replaced + 1 helper added; no table, column or row change, nothing deleted.
-- Safe to run twice. ASCII only.
begin;
-- ============================================================================
-- 0190_trial_clone_reliability.sql - CANONICAL forward-only. Free-trial sign-up: the sample
-- clone and the trial start are made fast enough that they can never hit the API time limit.
-- REQUIRES 0119 (start_self_serve_trial), 0166 + 0167 + 0168 (sample clone chain:
--          _sample_clone_into -> _sample_clone_into__pre0168), 0169 (_sample_clone_tables).
--
-- In plain words:
--   1  The free trial is created by ONE database call from the browser (start_self_serve_trial).
--      On Supabase every browser call has an 8 second limit (authenticated statement_timeout).
--      A time-out is NOT caught by the "a failed sample never blocks the trial" safety net
--      (PostgreSQL never lets a function catch a cancel): the whole sign-up would be undone and
--      the visitor would see an error. Today the call takes well under a second on a laptop, but
--      two parts of it were needlessly slow and grow with the sample size:
--        a) the visitor time zone was checked against pg_timezone_names, which reads every time
--           zone file from disk on each call (about 0.2 s here, more on a small cloud server).
--           It is now checked with a cheap name pattern + PostgreSQL's own time zone lookup;
--           anything unknown still falls back to UTC, exactly as before.
--        b) the clone (_sample_clone_into__pre0168, body from 0167) re-scanned the WHOLE id map
--           (about 500 ids) for every one of the ~500 sample rows, and re-read the table
--           definitions from the catalog for every row. It now finds only the ids that are in
--           the row, reads each table's definition once, and inserts each table's rows in one
--           statement. Same rows, same ids remapped, same dates, same dummy contacts, same
--           is_demo flags, same "do nothing on a duplicate" rule - only faster.
--   2  The clone result now also says how many sample rows were already present in the new
--      studio and therefore kept as they were ('kept_existing'), e.g. the 145 dishes and 6 menu
--      packages that create_studio() already copies from the Helm library studio. Before this
--      the audit log showed "dish_catalog 0, menu_templates 0", which looked like missing data.
--   3  Nothing else changes: 'own data' trials are still empty by design, paid studios are not
--      touched, the sample master is never a clone target, the switch / manifest rules are the
--      0167 / 0174 ones.
--
-- ZERO DATA LOSS: two function bodies replaced (CREATE OR REPLACE, same signatures, same grants);
-- no table, column, index or row is changed or removed; no trigger added. ASCII only. Safe to
-- run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._sample_clone_into__pre0168(uuid)') is null or to_regprocedure('public._sample_clone_into(uuid)') is null then
    raise exception '0190: apply 0166 + 0167 + 0168 (sample clone chain) first'; end if;
  if to_regprocedure('public._sample_clone_tables()') is null or to_regclass('public.helm_trial_seed_manifest') is null then
    raise exception '0190: apply 0167 + 0169 first'; end if;
  if to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is null then
    raise exception '0190: apply 0119 (unified trial) first'; end if;
end $$;

-- ---- 1) the clone: same result as 0167, built set-wise --------------------------------------------
create or replace function public._sample_clone_into__pre0168(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-clone-0190 (trial-sample-0167 / trial-sandbox-0166 semantics): own org only, once, every row
-- is_demo, from the frozen CURRENT manifest; per-table metadata read once, ids remapped by lookup,
-- one INSERT per table (per column set)
declare
  tpl public.helm_sample_template; m public.helm_trial_seed_manifest; v_src uuid; v_shift integer; v_map jsonb;
  v_batch uuid := gen_random_uuid(); v_tables text[] := public._sample_clone_tables(); t text; r record; k record; c record;
  v_txt text; v_row jsonb; v_cols text; v_counts jsonb := '{}'::jsonb; v_kept jsonb := '{}'::jsonb; n integer;
  v_seq integer := 0; v_total integer := 0; v_rel regclass; v_col text; v_has_id boolean; v_fix jsonb[] := '{}';
  f jsonb; v_pos integer; v_ins integer; v_sub jsonb; v_src_n integer;
  -- per-table metadata (read once per table, not per row)
  v_attrs text[]; v_fk_null text[]; v_fk_fix text[]; v_actor text[]; v_dates text[]; v_date_is_date boolean[];
  v_has_demo boolean; i integer;
  -- batch of rows sharing one column list
  v_bcols text; v_brows jsonb[] := '{}';
begin
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'no studio' using errcode = '22023'; end if;
  select * into tpl from public.helm_sample_template x where x.id;
  select * into m from public.helm_trial_seed_manifest x where x.is_current;
  if tpl.org_id is null or not tpl.active or m.version is null then
    return jsonb_build_object('cloned', false, 'reason', 'no_template'); end if;
  v_src := m.source_org;
  if p_org = v_src or p_org = tpl.org_id or exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master) then
    raise exception 'the sample master is never a clone target' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(hashtextextended('helm:sample_clone:' || p_org::text, 0));
  if exists (select 1 from public.organizations o where o.id = p_org and o.sample_cloned_at is not null) then
    return jsonb_build_object('cloned', false, 'reason', 'already_cloned'); end if;

  v_shift := current_date - m.anchor_date;
  -- pass 1: a new id for every row (any reference, in any order, resolves) - one statement
  select jsonb_build_object(v_src::text, p_org::text) || coalesce(jsonb_object_agg(x.id, gen_random_uuid()::text), '{}'::jsonb)
    into v_map
    from (select e.j ->> 'id' as id
            from unnest(v_tables) tt(name)
            cross join lateral jsonb_array_elements(coalesce(m.payload #> array['tables', tt.name], '[]'::jsonb)) e(j)
           where e.j ? 'id' and e.j ->> 'id' is not null) x;
  if (select count(*) from jsonb_object_keys(v_map)) <= 1 then
    return jsonb_build_object('cloned', false, 'reason', 'template_empty'); end if;

  -- pass 2: insert, parents first
  foreach t in array v_tables loop
    n := 0;
    if to_regclass('public.' || t) is null then continue; end if;
    v_rel := format('public.%I', t)::regclass;
    v_pos := array_position(v_tables, t);
    v_src_n := jsonb_array_length(coalesce(m.payload #> array['tables', t], '[]'::jsonb));
    if v_src_n = 0 then v_counts := v_counts || jsonb_build_object(t, 0); continue; end if;

    -- table metadata, once
    select coalesce(array_agg(a.attname::text order by a.attnum), '{}') into v_attrs
      from pg_catalog.pg_attribute a
     where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
    v_fk_null := '{}'; v_fk_fix := '{}';
    for c in select a.attname::text as col, rn.nspname::text as rns, rc.relname::text as rrel
               from pg_catalog.pg_constraint cf
               join pg_catalog.pg_attribute a on a.attrelid = cf.conrelid and a.attnum = cf.conkey[1]
               join pg_catalog.pg_class rc on rc.oid = cf.confrelid
               join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
              where cf.conrelid = v_rel and cf.contype = 'f' and array_length(cf.conkey, 1) = 1 loop
      -- links: login users and tenant rows this clone does not copy are dropped; a link to a row
      -- inserted LATER (e.g. lead -> quote, task -> task) is set after every row is in
      if (c.rns = 'auth' and c.rrel = 'users') or (c.rns = 'public' and c.rrel = 'profiles')
         or (c.rns = 'public' and c.rrel <> 'organizations' and not (c.rrel = any(v_tables))
             and exists (select 1 from pg_catalog.pg_attribute ra
                          where ra.attrelid = format('public.%I', c.rrel)::regclass and ra.attname = 'org_id'
                            and ra.attnum > 0 and not ra.attisdropped)) then
        v_fk_null := v_fk_null || c.col;
      elsif c.rns = 'public' and c.rrel = any(v_tables) and array_position(v_tables, c.rrel) >= v_pos then
        v_fk_fix := v_fk_fix || c.col;
      end if;
    end loop;
    select coalesce(array_agg(a.attname::text), '{}') into v_actor
      from pg_catalog.pg_attribute a
     where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.atttypid = 'uuid'::regtype
       and a.attname in ('created_by', 'updated_by', 'profile_id', 'owner', 'confirmed_by', 'manager_id', 'archived_by',
                         'deleted_by', 'verified_by', 'reviewed_by', 'drafted_by', 'published_by');
    select coalesce(array_agg(a.attname::text order by a.attnum), '{}'), coalesce(array_agg(a.atttypid = 'date'::regtype order by a.attnum), '{}')
      into v_dates, v_date_is_date
      from pg_catalog.pg_attribute a
     where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped
       and a.atttypid in ('date'::regtype, 'timestamptz'::regtype, 'timestamp'::regtype)
       and a.attname not in ('created_at', 'updated_at', 'approval_token_expires_at');
    v_has_demo := 'is_demo' = any(v_attrs);
    v_bcols := null; v_brows := '{}';

    for r in select e.j from jsonb_array_elements(m.payload #> array['tables', t]) e(j) loop
      -- ids are unique uuids: remap every uuid in the row text (top-level AND nested jsonb references)
      -- that the map knows; only the uuids present in this row are looked up
      v_txt := r.j::text;
      for k in select distinct x.u[1] as u
                 from regexp_matches(v_txt, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') x(u) loop
        if v_map ? k.u then v_txt := replace(v_txt, k.u, v_map ->> k.u); end if;
      end loop;
      v_row := v_txt::jsonb;
      v_has_id := v_row ? 'id';
      foreach v_col in array v_fk_null loop
        if v_row ? v_col and jsonb_typeof(v_row -> v_col) <> 'null' then v_row := jsonb_set(v_row, array[v_col], 'null'::jsonb); end if;
      end loop;
      if v_has_id then
        foreach v_col in array v_fk_fix loop
          if v_row ? v_col and jsonb_typeof(v_row -> v_col) <> 'null' then
            v_fix := v_fix || jsonb_build_object('t', t, 'id', v_row ->> 'id', 'col', v_col, 'v', v_row ->> v_col);
            v_row := jsonb_set(v_row, array[v_col], 'null'::jsonb);
          end if;
        end loop;
      end if;
      foreach v_col in array v_actor loop
        if v_row ? v_col then v_row := jsonb_set(v_row, array[v_col], 'null'::jsonb); end if;
      end loop;
      -- contacts can never reach a person (already-dummy values are kept)
      v_seq := v_seq + 1;
      foreach v_col in array array['email', 'contact_email'] loop
        if v_row ? v_col and jsonb_typeof(v_row -> v_col) = 'string' then
          v_row := jsonb_set(v_row, array[v_col], to_jsonb(public._sample_safe_email(v_row ->> v_col, v_seq))); end if;
      end loop;
      foreach v_col in array array['phone', 'contact_phone', 'assignee_phone'] loop
        if v_row ? v_col and jsonb_typeof(v_row -> v_col) = 'string' then
          v_row := jsonb_set(v_row, array[v_col], to_jsonb(public._sample_safe_phone(v_row ->> v_col, v_seq))); end if;
      end loop;
      -- nested client contacts (quotes.client, quotes.pricing.client)
      foreach v_col in array array['client', 'pricing'] loop
        if jsonb_typeof(v_row -> v_col) = 'object' then
          v_sub := v_row -> v_col;
          if v_col = 'pricing' then v_sub := v_sub -> 'client'; end if;
          if jsonb_typeof(v_sub) = 'object' then
            if jsonb_typeof(v_sub -> 'email') = 'string' then v_sub := jsonb_set(v_sub, '{email}', to_jsonb(public._sample_safe_email(v_sub ->> 'email', v_seq))); end if;
            if jsonb_typeof(v_sub -> 'phone') = 'string' then v_sub := jsonb_set(v_sub, '{phone}', to_jsonb(public._sample_safe_phone(v_sub ->> 'phone', v_seq))); end if;
            if v_col = 'pricing' then v_row := jsonb_set(v_row, '{pricing,client}', v_sub); else v_row := jsonb_set(v_row, '{client}', v_sub); end if;
          end if;
        end if;
      end loop;
      -- an approval link is per trial: a fresh token, never the master's
      if t = 'quotes' and jsonb_typeof(v_row -> 'approval_token') = 'string' then
        v_row := v_row || jsonb_build_object('approval_token', gen_random_uuid(), 'approval_token_expires_at', now() + interval '30 days',
                                             'approval_token_revoked_at', null);
      end if;
      -- dates follow the signup day
      if v_shift <> 0 then
        for i in 1 .. coalesce(array_length(v_dates, 1), 0) loop
          if jsonb_typeof(v_row -> v_dates[i]) = 'string' then
            if v_date_is_date[i] then
              v_row := jsonb_set(v_row, array[v_dates[i]], to_jsonb(((v_row ->> v_dates[i])::date + v_shift)));
            else
              v_row := jsonb_set(v_row, array[v_dates[i]], to_jsonb(((v_row ->> v_dates[i])::timestamptz + make_interval(days => v_shift))));
            end if;
          end if;
        end loop;
      end if;
      v_row := v_row || jsonb_build_object('org_id', p_org);
      if v_has_demo then v_row := v_row || jsonb_build_object('is_demo', true); end if;
      if v_row ? 'created_at' then v_row := v_row || jsonb_build_object('created_at', now()); end if;
      if v_row ? 'updated_at' then v_row := v_row || jsonb_build_object('updated_at', now()); end if;
      -- only the columns this snapshot row carries (a column added later keeps its default)
      select string_agg(quote_ident(x.a), ', ' order by x.o) into v_cols
        from unnest(v_attrs) with ordinality x(a, o) where v_row ? x.a;
      if v_bcols is not null and v_cols is distinct from v_bcols then
        execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict do nothing',
                       t, v_bcols, v_bcols, t) using to_jsonb(v_brows);
        get diagnostics v_ins = row_count;
        n := n + v_ins; v_brows := '{}';
      end if;
      v_bcols := v_cols; v_brows := v_brows || v_row;
    end loop;
    if v_bcols is not null and coalesce(array_length(v_brows, 1), 0) > 0 then
      execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict do nothing',
                     t, v_bcols, v_bcols, t) using to_jsonb(v_brows);
      get diagnostics v_ins = row_count;
      n := n + v_ins;
    end if;
    v_counts := v_counts || jsonb_build_object(t, n); v_total := v_total + n;
    if v_src_n > n then v_kept := v_kept || jsonb_build_object(t, v_src_n - n); end if;
  end loop;

  -- links to rows inserted later
  foreach f in array v_fix loop
    execute format('update public.%I set %I = $1::uuid where id = $2::uuid and org_id = $3 and %I is distinct from $1::uuid',
                   f ->> 't', f ->> 'col', f ->> 'col')
      using f ->> 'v', f ->> 'id', p_org;
  end loop;

  update public.organizations
     set sample_cloned_at = now(), sample_source_org = v_src, sample_batch_id = v_batch, sample_version = m.version
   where id = p_org;
  insert into public.trial_sample_runs(org_id, source_org, version, batch_id, counts, manifest_version)
    values (p_org, v_src, m.version, v_batch, v_counts, m.version);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'trial.sample_cloned', 'organizations', p_org::text,
            jsonb_build_object('version', m.version, 'batch', v_batch, 'counts', v_counts, 'kept_existing', v_kept,
                               'shift_days', v_shift), p_org, now());
  return jsonb_build_object('cloned', true, 'seeded', true, 'source', 'sample_manifest', 'version', m.version,
                            'batch', v_batch, 'rows', v_total, 'counts', v_counts, 'kept_existing', v_kept);
end $$;

-- ---- 2) trial start: the 0119 body, time zone checked without reading every zone file ----------
create or replace function public._tz_name_ok(p text)
returns boolean language plpgsql stable set search_path = '' as $$
-- trial-clone-0190: an IANA zone name ("Asia/Kolkata", "America/Argentina/Buenos_Aires", "UTC")
-- that PostgreSQL knows; POSIX offsets like "+05:30" or "UTC+5" are refused (fall back to UTC)
declare v timestamp;
begin
  if p is null or char_length(p) > 64 then return false; end if;
  if p !~ '^(UTC|GMT|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$' then return false; end if;
  v := now() at time zone p;
  return true;
exception when others then return false;
end $$;
revoke all on function public._tz_name_ok(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._tz_name_ok(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._tz_name_ok(text) from authenticated; end if;
end $$;

create or replace function public.start_self_serve_trial(p_name text, p_timezone text, p_currency text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119 trial-clone-0190 (cheap time zone name check, _tz_name_ok)
declare
  v_uid uuid := auth.uid();
  v_tz text := 'UTC'; v_cur text := 'USD';
  v_mode text := lower(btrim(coalesce(p_mode, 'demo')));
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_had uuid; v_org uuid; v_n bigint; v_end timestamptz;
  v_seed jsonb; v_extra jsonb; o public.organizations;
begin
  if v_uid is null then raise exception 'must be signed in to start a trial' using errcode = '42501'; end if;
  -- already in a studio: hand it back, create / seed / change nothing
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then
    select * into o from public.organizations x where x.id = v_had;
    return jsonb_build_object('result', 'has_studio', 'org_id', v_had, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;
  if coalesce(public.is_platform_admin(), false) then
    raise exception 'Helm operators do not get a studio' using errcode = '42501'; end if;
  if v_mode not in ('demo', 'own') then raise exception 'choose demo or own' using errcode = '22023'; end if;
  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 80) then
    raise exception 'studio name must be 2 to 80 characters' using errcode = '22023'; end if;
  -- visitor's own time zone + currency (0118 rules: unknown values fall back to UTC / USD)
  if p_timezone is not null and public._tz_name_ok(btrim(p_timezone)) then
    v_tz := btrim(p_timezone); end if;
  if p_currency is not null and upper(btrim(p_currency)) in ('INR','USD','AED','GBP','SGD','AUD','CAD','EUR') then
    v_cur := upper(btrim(p_currency)); end if;

  if v_name is null then
    -- one "Demo N" at a time across the whole database (same lock as 0116)
    perform pg_advisory_xact_lock(hashtextextended('helm:start_trial:demo_n', 0));
    v_n := public._trial_next_demo_number();
    v_name := 'Demo ' || v_n::text;
  end if;
  v_org := public.create_studio(v_name, null, v_cur, v_tz);
  select * into o from public.organizations x where x.id = v_org;
  -- never touch a studio this call did not just create
  if o.id is null or o.created_by is distinct from v_uid or o.trial_ends_at is not null then
    return jsonb_build_object('result', 'has_studio', 'org_id', v_org, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;

  v_end := now() + make_interval(days => public._trial_days());
  update public.organizations set trial_ends_at = v_end, trial_mode = v_mode
   where id = v_org and trial_ends_at is null;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, 'trial', (v_end at time zone 'UTC')::date, 'bypass', now(), v_uid)
  on conflict (org_id) do nothing;

  if v_mode = 'demo' then
    -- sample data: a failure here never blocks the trial (that block alone is rolled back)
    begin v_seed := public._demo_seed(v_org);
    exception when others then v_seed := jsonb_build_object('seeded', false, 'error', sqlstate); end;
    begin v_extra := public._trial_seed_extra(v_org);
    exception when others then v_extra := jsonb_build_object('seeded', false, 'error', sqlstate); end;
  end if;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'subscription.trial_started',
           'organizations', v_org::text,
           jsonb_build_object('source', 'start_self_serve_trial', 'name', v_name, 'mode', v_mode,
                              'trial_ends_at', v_end, 'seed', v_seed, 'extra', v_extra),
           v_org, now();
  return jsonb_build_object('result', 'started', 'org_id', v_org, 'name', v_name, 'mode', v_mode,
                            'trial_ends_at', v_end, 'trial_days', public._trial_days(), 'seed', v_seed, 'extra', v_extra);
end $$;

-- ---- privileges: unchanged (re-stated so a re-run never widens them) -------------------------------
do $$
begin
  revoke all on function public._sample_clone_into__pre0168(uuid) from public;
  revoke all on function public.start_self_serve_trial(text, text, text, text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public._sample_clone_into__pre0168(uuid) from anon;
    revoke all on function public.start_self_serve_trial(text, text, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._sample_clone_into__pre0168(uuid) from authenticated;
    grant execute on function public.start_self_serve_trial(text, text, text, text) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public._sample_clone_into__pre0168(uuid) to service_role;
    grant execute on function public.start_self_serve_trial(text, text, text, text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 clone is the 0190 version', position('trial-clone-0190' in (select prosrc from pg_proc where oid = 'public._sample_clone_into__pre0168(uuid)'::regprocedure)) > 0),
  ('02 trial start is the 0190 version (no pg_timezone_names)', position('trial-clone-0190' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial(text,text,text,text)'::regprocedure)) > 0
       and position('pg_timezone_names' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial(text,text,text,text)'::regprocedure)) = 0),
  ('03 app roles cannot call the clone or the tz helper', not has_function_privilege('authenticated', 'public._sample_clone_into__pre0168(uuid)', 'execute')
       and not has_function_privilege('anon', 'public._sample_clone_into__pre0168(uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public._sample_clone_into(uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public._tz_name_ok(text)', 'execute')),
  ('04 signed-in users can still start a trial, anon cannot', has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
       and not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')),
  ('05 time zone check: Asia/Kolkata yes, +05:30 no', public._tz_name_ok('Asia/Kolkata') and not public._tz_name_ok('+05:30')),
  ('06 switch on + manifest current (false = sample switch still off)', public._sample_template_ready())
) v(item, ok) order by item;
