-- worker-evidence.sql — 0038 crew evidence from the signed-out work link.
-- A worker link (bearer token) can attach a reject reason / voice note and proof
-- photos to ITS OWN task only, through one-time 15-minute upload grants on the
-- private 'task-proof' bucket; wrong / expired / revoked links, other workers'
-- tasks, reused or expired grants, bad MIME types and floods are refused; staff of
-- the owning studio (Staff view) can read the evidence + objects, another studio
-- and a signed-out visitor cannot. Fixture: studio A (a_admin) + studio B (b_admin).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _we; create temp table _we(name text, result text); grant all on _we to anon, authenticated;
drop table if exists _we_k; create temp table _we_k(k text primary key, v text); grant all on _we_k to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _we values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into _we_k values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _we_k where k = p_k $$;
-- run a statement, return '' on success or the error message
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return coalesce(nullif(sqlerrm, ''), sqlstate); end $$;
grant execute on function pg_temp.try(text), pg_temp.put(text, text), pg_temp.get(text) to anon, authenticated;

-- ids: tokens tLive (worker 1, event A), tOther (worker 2, event A), tExp, tRev, tB (studio B)
--      tasks k_rej (w1, assigned), k_done (w1, in_progress), k_done2 (w1, in_progress),
--      k_asg (w1, assigned), k_oth (w2, assigned), k_exp (expired link), k_b (studio B)
do $$ declare
  qA uuid := 'a0000000-0000-4000-8000-00000000da01'; qB uuid := 'b0000000-0000-4000-8000-00000000da01';
  oA uuid := 'a0000000-0000-4000-8000-000000000001'; oB uuid := 'b0000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.su();
  delete from storage.objects where bucket_id = 'task-proof';
  delete from public.task_evidence where task_id in (select id from public.event_tasks where title like 'WEV %');
  delete from public.task_evidence_grants where task_id in (select id from public.event_tasks where title like 'WEV %');
  delete from public.event_tasks where title like 'WEV %';
  delete from public.work_tokens where phone like '99955510%' or phone like '99955520%';
  insert into public.event_tasks(id, quote_id, org_id, category, title, status, assignee_name, assignee_phone, seq) values
    ('e0000000-0000-4000-8000-0000000000a1', qA, oA, 'Setup', 'WEV reject me',  'assigned',    'Worker One', '9995551001', 1),
    ('e0000000-0000-4000-8000-0000000000a2', qA, oA, 'Setup', 'WEV done',       'in_progress', 'Worker One', '9995551001', 2),
    ('e0000000-0000-4000-8000-0000000000a3', qA, oA, 'Setup', 'WEV done 2',     'in_progress', 'Worker One', '9995551001', 3),
    ('e0000000-0000-4000-8000-0000000000a4', qA, oA, 'Setup', 'WEV assigned',   'assigned',    'Worker One', '9995551001', 4),
    ('e0000000-0000-4000-8000-0000000000a5', qA, oA, 'Setup', 'WEV other',      'assigned',    'Worker Two', '9995551002', 5),
    ('e0000000-0000-4000-8000-0000000000a6', qA, oA, 'Setup', 'WEV expired',    'in_progress', 'Worker Exp', '9995551003', 6),
    ('e0000000-0000-4000-8000-0000000000a7', qA, oA, 'Setup', 'WEV revoked',    'in_progress', 'Worker Rev', '9995551004', 7),
    ('e0000000-0000-4000-8000-0000000000b1', qB, oB, 'Setup', 'WEV studio B',   'in_progress', 'Worker B',   '9995552001', 1);
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values
    ('f0000000-0000-4000-8000-000000000001', qA, '9995551001', 'Worker One', oA),
    ('f0000000-0000-4000-8000-000000000002', qA, '9995551002', 'Worker Two', oA),
    ('f0000000-0000-4000-8000-000000000003', qA, '9995551003', 'Worker Exp', oA),
    ('f0000000-0000-4000-8000-000000000004', qA, '9995551004', 'Worker Rev', oA),
    ('f0000000-0000-4000-8000-0000000000b1', qB, '9995552001', 'Worker B',   oB);
  update public.work_tokens set expires_at = now() + interval '10 days' where token in
    ('f0000000-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-0000000000b1');
  update public.work_tokens set expires_at = now() - interval '1 day' where token = 'f0000000-0000-4000-8000-000000000003';
  update public.work_tokens set expires_at = now() + interval '10 days', revoked_at = now() where token = 'f0000000-0000-4000-8000-000000000004';
end $$;

-- ================= 1) upload grants: who may get one ===================================
do $$ declare r jsonb; begin
  perform pg_temp.anon();
  r := public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a2', 'proof_photo', 'image/jpeg');
  perform pg_temp.put('p1', r->>'path');
  perform pg_temp.res('01 valid link gets a photo grant on its own in-progress task (org/quote/task/uuid.jpg)',
    r->>'path' ~ '^a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/e0000000-0000-4000-8000-0000000000a2/[0-9a-f-]{36}\.jpg$'
    and r->>'bucket' = 'task-proof' and (r->>'expires_at')::timestamptz between now() + interval '14 minutes' and now() + interval '16 minutes', r::text);
exception when others then perform pg_temp.res('01 valid link gets a photo grant on its own in-progress task (org/quote/task/uuid.jpg)', false, sqlerrm); end $$;

do $$ declare e text; begin
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000a2', 'proof_photo', 'image/jpeg')$q$);
  perform pg_temp.res('02 another worker''s link cannot get a grant for my task', e ilike '%task not found%', e);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-0000000000a6', 'proof_photo', 'image/jpeg')$q$);
  perform pg_temp.res('03 expired link is refused a grant', e ilike '%expired%', e);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-0000000000a7', 'proof_photo', 'image/jpeg')$q$);
  perform pg_temp.res('04 revoked link is refused a grant', e ilike '%revoked%', e);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_evidence_upload(gen_random_uuid(), 'e0000000-0000-4000-8000-0000000000a2', 'proof_photo', 'image/jpeg')$q$);
  perform pg_temp.res('05 unknown link is refused a grant', e ilike '%invalid%', e);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000b1', 'proof_photo', 'image/jpeg')$q$);
  perform pg_temp.res('06 a studio-A link cannot reach a studio-B task', e ilike '%task not found%', e);
end $$;

do $$ declare e1 text; e2 text; e3 text; e4 text; e5 text; begin
  perform pg_temp.anon();
  e1 := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a2', 'proof_photo', 'image/svg+xml')$q$);
  e2 := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a2', 'proof_photo', 'text/html')$q$);
  e3 := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'reject_voice', 'image/jpeg')$q$);
  e4 := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a2', 'evil', 'image/jpeg')$q$);
  e5 := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a4', 'proof_photo', 'image/jpeg')$q$);
  perform pg_temp.res('07 only png/jpeg/webp photos and webm/ogg/mp4 voice; unknown kinds refused',
    e1 <> '' and e2 <> '' and e3 <> '' and e4 ilike '%kind%', concat_ws(' | ', e1, e2, e3, e4));
  perform pg_temp.res('08 proof photos need a started/accepted task', e5 ilike '%start the task first%', e5);
end $$;

-- ================= 2) storage: the grant is the only way in ============================
do $$ declare e text; begin
  perform pg_temp.anon();
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'task-proof', pg_temp.get('p1')));
  perform pg_temp.res('09 link holder uploads to the granted key', e = '', e);
  perform pg_temp.anon();
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'task-proof', pg_temp.get('p1')));
  perform pg_temp.res('10 the same key cannot be written twice (single use, no overwrite)', e <> '', 'second write allowed');
  perform pg_temp.anon();
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'task-proof',
        'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/e0000000-0000-4000-8000-0000000000a2/' || gen_random_uuid() || '.jpg'));
  perform pg_temp.res('11 a key without a grant is refused', e <> '', 'ungranted upload allowed');
  perform pg_temp.anon();
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'chat-media', pg_temp.get('p1')));
  perform pg_temp.res('12 a grant does not open any other bucket', e <> '', 'chat-media upload allowed');
end $$;

do $$ declare r jsonb; e text; begin
  perform pg_temp.anon();
  r := public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a2', 'proof_photo', 'image/png');
  perform pg_temp.su(); update public.task_evidence_grants set expires_at = now() - interval '1 second' where path = r->>'path';
  perform pg_temp.anon();
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'task-proof', r->>'path'));
  perform pg_temp.res('13 an expired grant (15-minute window) no longer allows the upload', e <> '', 'upload allowed after expiry');
  -- a grant whose link was revoked after issue is dead too
  perform pg_temp.anon();
  r := public.worker_evidence_upload('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000a5', 'reject_voice', 'audio/webm');
  perform pg_temp.su(); update public.work_tokens set revoked_at = now() where token = 'f0000000-0000-4000-8000-000000000002';
  perform pg_temp.anon();
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'task-proof', r->>'path'));
  perform pg_temp.res('14 revoking the link kills its outstanding grants', e <> '', 'upload allowed on revoked link');
  perform pg_temp.su(); update public.work_tokens set revoked_at = null where token = 'f0000000-0000-4000-8000-000000000002';
end $$;

-- ================= 3) complete with photos =============================================
do $$ declare r jsonb; st text; n int; used timestamptz; begin
  perform pg_temp.anon();
  r := public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a2', 'complete',
         null, null, null, array[pg_temp.get('p1')]);
  perform pg_temp.su();
  select status into st from public.event_tasks where id = 'e0000000-0000-4000-8000-0000000000a2';
  select count(*) into n from public.task_evidence where task_id = 'e0000000-0000-4000-8000-0000000000a2' and kind = 'proof_photo' and storage_path = pg_temp.get('p1') and mime = 'image/jpeg';
  select used_at into used from public.task_evidence_grants where path = pg_temp.get('p1');
  perform pg_temp.res('15 done + photo: status completed, photo recorded, grant burned',
    st = 'completed' and n = 1 and used is not null and (r->>'evidence')::int = 1, coalesce(st,'?')||' n='||n||' '||coalesce(r::text,''));
exception when others then perform pg_temp.res('15 done + photo: status completed, photo recorded, grant burned', false, sqlerrm); end $$;

do $$ declare e text; n int; begin
  perform pg_temp.anon();
  e := pg_temp.try(format($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'complete', null, null, null, array[%L])$q$, pg_temp.get('p1')));
  perform pg_temp.su(); select count(*) into n from public.event_tasks where id = 'e0000000-0000-4000-8000-0000000000a3' and status = 'in_progress';
  perform pg_temp.res('16 a used grant cannot be attached again (other task) and nothing changes', e ilike '%upload not found%' and n = 1, e);
end $$;

do $$ declare r jsonb; e text; n int; begin
  -- a grant for task a3 cannot be attached to task a2's sibling via another worker, nor to a different task
  perform pg_temp.anon();
  r := public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'proof_photo', 'image/webp');
  perform pg_temp.put('p3', r->>'path');
  e := pg_temp.try(format($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000a5', 'reject', null, %L, 5, null)$q$, r->>'path'));
  perform pg_temp.su(); select count(*) into n from public.event_tasks where id = 'e0000000-0000-4000-8000-0000000000a5' and status = 'assigned';
  perform pg_temp.res('17 another link cannot claim my grant (and its task stays unchanged)', e <> '' and n = 1, e);
  perform pg_temp.anon();
  e := pg_temp.try(format($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000a3', 'complete', null, null, null, array[%L])$q$, r->>'path'));
  perform pg_temp.res('18 wrong link cannot complete my task with evidence', e ilike '%task not found%', e);
end $$;

do $$ declare e1 text; e2 text; e3 text; begin
  perform pg_temp.anon();
  e1 := pg_temp.try($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'complete', null, null, null,
          array(select 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/e0000000-0000-4000-8000-0000000000a3/' || gen_random_uuid() || '.jpg' from generate_series(1, 11)))$q$);
  e2 := pg_temp.try(format($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'complete', null, null, null, array[%L, %L])$q$, pg_temp.get('p3'), pg_temp.get('p3')));
  e3 := pg_temp.try($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'complete', 'because', null, null, null)$q$);
  perform pg_temp.res('19 more than 10 photos, duplicate photos, or a reason on DONE are refused',
    e1 ilike '%10 photos%' and e2 ilike '%duplicate%' and e3 <> '', concat_ws(' | ', e1, e2, e3));
end $$;

do $$ declare e text; n int; begin
  -- grant whose upload window closed > 15 minutes ago can no longer be attached
  perform pg_temp.su(); update public.task_evidence_grants set expires_at = now() - interval '20 minutes' where path = pg_temp.get('p3');
  perform pg_temp.anon();
  e := pg_temp.try(format($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'complete', null, null, null, array[%L])$q$, pg_temp.get('p3')));
  perform pg_temp.su(); select count(*) into n from public.task_evidence where storage_path = pg_temp.get('p3');
  perform pg_temp.res('20 an expired grant cannot be attached', e ilike '%expired%' and n = 0, e);
end $$;

-- ================= 4) reject with reason + voice ========================================
do $$ declare r jsonb; e text; st text; begin
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'reject', repeat('x', 1001), null, null, null)$q$);
  perform pg_temp.su(); select status into st from public.event_tasks where id = 'e0000000-0000-4000-8000-0000000000a1';
  perform pg_temp.res('21 reason over 1000 characters is refused and the task is NOT rejected', e ilike '%too long%' and st = 'assigned', e||' '||st);
  perform pg_temp.anon();
  e := pg_temp.try(format($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'reject', null, null, null, array[%L])$q$, pg_temp.get('p3')));
  perform pg_temp.res('22 photos cannot be attached to a rejection', e <> '', e);
end $$;

do $$ declare r jsonb; v jsonb; st text; n int; d int; b text; begin
  perform pg_temp.anon();
  v := public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'reject_voice', 'audio/webm');
  perform pg_temp.put('v1', v->>'path');
  perform pg_temp.anon();
  execute format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'task-proof', v->>'path');
  perform pg_temp.anon();
  r := public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'reject',
         '  Van broke down <script>alert(1)</script>  ', v->>'path', 500, null);
  perform pg_temp.su();
  select status into st from public.event_tasks where id = 'e0000000-0000-4000-8000-0000000000a1';
  select count(*) into n from public.task_evidence where task_id = 'e0000000-0000-4000-8000-0000000000a1';
  select duration_s into d from public.task_evidence where task_id = 'e0000000-0000-4000-8000-0000000000a1' and kind = 'reject_voice';
  select body into b from public.task_evidence where task_id = 'e0000000-0000-4000-8000-0000000000a1' and kind = 'reject_reason';
  perform pg_temp.res('23 reject + reason + voice: task rejected, both recorded (reason trimmed, stored verbatim; voice capped at 120 s)',
    st = 'rejected' and n = 2 and d = 120 and b = 'Van broke down <script>alert(1)</script>' and r->>'status' = 'rejected',
    coalesce(st,'?')||' n='||n||' d='||coalesce(d::text,'?')||' b='||coalesce(b,'?'));
exception when others then perform pg_temp.res('23 reject + reason + voice: task rejected, both recorded (reason trimmed, stored verbatim; voice capped at 120 s)', false, sqlerrm); end $$;

do $$ declare r jsonb; n int; begin
  -- plain reject (no evidence) through the same RPC still works; the old worker_respond is untouched
  perform pg_temp.anon();
  r := public.worker_respond_evidence('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000a5', 'reject', '   ', null, null, null);
  perform pg_temp.su(); select count(*) into n from public.task_evidence where task_id = 'e0000000-0000-4000-8000-0000000000a5';
  perform pg_temp.res('24 reject without evidence works (blank reason stored as nothing)', r->>'status' = 'rejected' and n = 0, r::text||' n='||n);
exception when others then perform pg_temp.res('24 reject without evidence works (blank reason stored as nothing)', false, sqlerrm); end $$;

do $$ declare e text; begin
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-0000000000a6', 'complete', null, null, null, null)$q$);
  perform pg_temp.res('25 expired link cannot respond with evidence', e ilike '%expired%', e);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_respond_evidence('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'delete', null, null, null, null)$q$);
  perform pg_temp.res('26 unknown action refused', e ilike '%invalid action%', e);
end $$;

-- ================= 5) rate limit: 30 grants / hour / link ==============================
do $$ declare i int; e text; ok int := 0; begin
  perform pg_temp.su();
  -- count already issued to tLive in this suite, then fill up to 30
  for i in 1 .. 40 loop
    perform pg_temp.anon();
    e := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'proof_photo', 'image/jpeg')$q$);
    if e = '' then ok := ok + 1; else exit; end if;
  end loop;
  perform pg_temp.su();
  perform pg_temp.res('27 a link gets at most 30 upload grants per hour',
    (select count(*) from public.task_evidence_grants where work_token = 'f0000000-0000-4000-8000-000000000001' and created_at > now() - interval '1 hour') = 30
    and e ilike '%too many uploads%', 'ok='||ok||' last='||e);
  -- another link is not affected
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.worker_evidence_upload('f0000000-0000-4000-8000-0000000000b1', 'e0000000-0000-4000-8000-0000000000b1', 'proof_photo', 'image/jpeg')$q$);
  perform pg_temp.res('28 the limit is per link (another link still works)', e = '', e);
end $$;

-- ================= 6) who can read ======================================================
do $$ declare n int; o int; begin
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from public.task_evidence where task_id in ('e0000000-0000-4000-8000-0000000000a1','e0000000-0000-4000-8000-0000000000a2');
  select count(*) into o from storage.objects where bucket_id = 'task-proof' and name in (pg_temp.get('p1'), pg_temp.get('v1'));
  perform pg_temp.res('29 staff of the owning studio read the evidence and its two objects', n = 3 and o = 2, 'rows='||n||' objects='||o);
end $$;

do $$ declare n int; o int; begin
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.task_evidence;
  select count(*) into o from storage.objects where bucket_id = 'task-proof';
  perform pg_temp.res('30 another studio''s admin sees no evidence and no objects', n = 0 and o = 0, 'rows='||n||' objects='||o);
end $$;

do $$ declare o int; begin
  -- an orphan (uploaded, never attached) object is never served, even to the owning studio
  perform pg_temp.anon();
  perform pg_temp.put('orph', (public.worker_evidence_upload('f0000000-0000-4000-8000-0000000000b1', 'e0000000-0000-4000-8000-0000000000b1', 'proof_photo', 'image/jpeg'))->>'path');
  perform pg_temp.anon();
  execute format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'task-proof', pg_temp.get('orph'));
  perform pg_temp.login('b_admin@b.test');
  select count(*) into o from storage.objects where bucket_id = 'task-proof';
  perform pg_temp.res('31 an unattached upload is not readable by staff', o = 0, 'objects='||o);
end $$;

do $$ declare o int; e1 text; e2 text; u int; begin
  perform pg_temp.anon();
  select count(*) into o from storage.objects where bucket_id = 'task-proof';
  e1 := pg_temp.try('select count(*) from public.task_evidence');
  e2 := pg_temp.try('select count(*) from public.task_evidence_grants');
  perform pg_temp.res('32 a signed-out visitor reads no objects, no evidence, no grants', o = 0 and e1 <> '' and e2 <> '', 'objects='||o||' '||e1||' '||e2);
  perform pg_temp.anon();
  with x as (update storage.objects set name = name where bucket_id = 'task-proof' returning 1) select count(*) into u from x;
  perform pg_temp.anon();
  with x as (delete from storage.objects where bucket_id = 'task-proof' returning 1) select count(*) into u from x;
  perform pg_temp.su(); select count(*) into o from storage.objects where bucket_id = 'task-proof';
  perform pg_temp.res('33 a signed-out visitor cannot overwrite or delete an object', o = 3, 'objects left='||o);
end $$;

do $$ declare e text; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.task_evidence(org_id, quote_id, task_id, kind, body) values ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000da01','e0000000-0000-4000-8000-0000000000a3','reject_reason','forged')$q$);
  perform pg_temp.res('34 even staff cannot write evidence directly (only the link RPCs)', e <> '', 'direct insert allowed');
end $$;

-- ================= 7) catalog: bucket + grants ==========================================
do $$ declare r record; begin
  perform pg_temp.su();
  select public, file_size_limit, allowed_mime_types into r from storage.buckets where id = 'task-proof';
  perform pg_temp.res('35 task-proof bucket: private, 8 MB, images + voice only',
    r.public = false and r.file_size_limit = 8388608
    and r.allowed_mime_types @> array['image/jpeg','image/png','image/webp','audio/webm','audio/ogg','audio/mp4']
    and cardinality(r.allowed_mime_types) = 6, coalesce(r::text, 'no bucket'));
  perform pg_temp.res('36 anon may call only the link RPCs (+ the upload gate); never the staff read gate',
    has_function_privilege('anon', 'public.worker_evidence_upload(uuid,uuid,text,text)', 'EXECUTE')
    and has_function_privilege('anon', 'public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])', 'EXECUTE')
    and has_function_privilege('anon', 'public.task_proof_upload_ok(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.task_proof_visible(text)', 'EXECUTE')
    and not has_table_privilege('anon', 'public.task_evidence', 'SELECT')
    and not has_table_privilege('anon', 'public.task_evidence_grants', 'SELECT')
    and not has_table_privilege('authenticated', 'public.task_evidence_grants', 'SELECT')
    and not has_table_privilege('authenticated', 'public.task_evidence', 'INSERT'));
  perform pg_temp.res('37 no anon read/update/delete policy on task-proof objects',
    not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and (qual ilike '%task-proof%' or with_check ilike '%task-proof%')
                 and cmd in ('SELECT','UPDATE','DELETE','ALL') and roles && array['anon','public']::name[]));
end $$;

-- ================= 8) idempotent re-apply keeps every row ===============================
do $$ begin perform pg_temp.su(); perform pg_temp.put('n_ev', (select count(*) from public.task_evidence)::text);
  perform pg_temp.put('n_gr', (select count(*) from public.task_evidence_grants)::text); end $$;
\i supabase/migrations/0038_worker_evidence.sql
set client_min_messages = warning;
do $$ begin perform pg_temp.su();
  perform pg_temp.res('38 re-applying 0038 keeps every evidence row and grant',
    (select count(*) from public.task_evidence)::text = pg_temp.get('n_ev')
    and (select count(*) from public.task_evidence_grants)::text = pg_temp.get('n_gr')
    and (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'task_proof%') = 2);
end $$;

-- cleanup (superuser)
do $$ begin perform pg_temp.su();
  delete from storage.objects where bucket_id = 'task-proof';
  delete from public.task_evidence where task_id in (select id from public.event_tasks where title like 'WEV %');
  delete from public.task_evidence_grants where task_id in (select id from public.event_tasks where title like 'WEV %');
  delete from public.event_tasks where title like 'WEV %';
  delete from public.work_tokens where phone like '99955510%' or phone like '99955520%';
end $$;
select name, result from _we order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 38 then 'WORKER-EVIDENCE: ALL PASS (38/38)'
            else 'WORKER-EVIDENCE: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/38 ran' end from _we;
