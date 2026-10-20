-- 0270_inbox_visible_speed.sql - CANONICAL forward-only.
-- REQUIRES 0266 (_r23_visible: the bell / inbox visibility rules).
--
-- In plain words (r24 CI follow-up: the 0266 inbox DB suite took 5+ minutes in CI):
--   The bell, the inbox, the "mark all read" button and the e-mail digests all ask _r23_visible "which notifications
--   may this person see?". Inside it, the person's own rules (their role's quote / closure access, the types they
--   switched off in Notification settings, their personal mutes) are worked out in a small "me" step. Postgres
--   folded that step into the main query, so those rules were worked out again FOR EVERY NOTIFICATION ROW
--   (about 70 ms each time on a test machine) - the bell of a studio with 200 notifications needed ~15 seconds,
--   and a busy studio could reach the API time limit (the bell then fails instead of loading).
--   Fix: the "me" step is marked MATERIALIZED, so the rules are worked out ONCE per call. Same rules, same rows,
--   same order - only faster (about 20x on the test data).
--   The live function body is read and changed in place (only "with me as (" -> "with me as materialized (" plus a
--   marker comment), so nothing else in it can drift. Replaced only while it is the 0266 body; a later body is left
--   alone (notice).
-- ZERO DATA LOSS: one function replaced in place (same name, arguments, result, owner, grants). No table, column,
-- row, policy or grant is created, changed or deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): re-run section 4 of 0266 (_r23_visible) - the rules are identical.

do $$
declare v_oid oid := to_regprocedure('public._r23_visible(uuid,uuid)'); v_src text; v_def text;
begin
  if v_oid is null then raise exception 'STOP 0270: public._r23_visible(uuid, uuid) missing - run 0266 first'; end if;
  select p.prosrc into v_src from pg_proc p where p.oid = v_oid;
  if position('r24-ci-0270' in v_src) > 0 then return; end if;   -- already applied
  if position('r23-inbox-0266' in v_src) = 0
     or (length(v_src) - length(replace(v_src, 'with me as (', ''))) <> length('with me as (')
     or (length(v_src) - length(replace(v_src, '-- r23-inbox-0266', ''))) <> length('-- r23-inbox-0266') then
    raise notice '0270: _r23_visible is not the 0266 body - left unchanged';
    return;
  end if;
  v_def := pg_get_functiondef(v_oid);
  v_def := replace(v_def, 'with me as (', 'with me as materialized (');
  v_def := replace(v_def, '-- r23-inbox-0266',
    '-- r23-inbox-0266 + r24-ci-0270: "me" is materialized - the person''s rules are worked out once per call, not per row');
  execute v_def;
end $$;

-- ---- VERIFY (read-only): every row must say ok = true ------------------------------------
select item, ok from (values
  ('01 _r23_visible works the person''s rules out once (materialized)',
       position('r24-ci-0270' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)'))) > 0
       and position('with me as materialized (' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)'))) > 0),
  ('02 still the 0266 rules, still security definer with an empty search path',
       position('r23-inbox-0266' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)'))) > 0
       and (select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
              from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)'))),
  ('03 still private: the app cannot call it',
       not has_function_privilege('authenticated', 'public._r23_visible(uuid,uuid)', 'execute')
       and not has_function_privilege('anon', 'public._r23_visible(uuid,uuid)', 'execute'))
) v(item, ok) order by item;
