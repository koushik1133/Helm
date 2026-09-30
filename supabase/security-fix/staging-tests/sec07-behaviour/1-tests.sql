-- SEC-07 v2 BEHAVIOUR — BLOCK 1: G1 / G2 / G3 (quote limit) / G4 / G5. Run as ONE script. STAGING ONLY.
-- Results are collected in session settings sec07.* and shown as one table at the end.
reset role;
select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claims','',false);

-- ---------- G1 approval links (Studio A admin issues; event date = today + 90) ----------
select set_config('request.jwt.claim.sub','ee5ec07e-0000-4000-8000-0000000000a1',false),
       set_config('request.jwt.claims','{"sub":"ee5ec07e-0000-4000-8000-0000000000a1","role":"authenticated"}',false);
set role authenticated;
select set_config('sec07.tok1', public.generate_approval_token('ee5ec07e-0000-4000-8000-00000000c001')::text, false);
reset role;
select set_config('sec07.g1_issue', (select approval_token_expires_at::date - current_date from public.quotes where id='ee5ec07e-0000-4000-8000-00000000c001')::text, false);
-- expiry is never silently cleared
update public.quotes set approval_token_expires_at = null where id='ee5ec07e-0000-4000-8000-00000000c001';
select set_config('sec07.g1_notnull', (select (approval_token_expires_at is not null)::text from public.quotes where id='ee5ec07e-0000-4000-8000-00000000c001'), false);
-- an EXPIRED link is not revived by an approval
update public.quotes set approval_token_expires_at = now() - interval '1 minute' where id='ee5ec07e-0000-4000-8000-00000000c001';
update public.quotes set approval_status = 'approved' where id='ee5ec07e-0000-4000-8000-00000000c001';
select set_config('sec07.g1_norevive', (select (approval_token_expires_at < now())::text from public.quotes where id='ee5ec07e-0000-4000-8000-00000000c001'), false);
update public.quotes set approval_status = 'sent' where id='ee5ec07e-0000-4000-8000-00000000c001';
-- re-issuing an expired link gives a NEW token that works again
set role authenticated;
select set_config('sec07.tok2', public.generate_approval_token('ee5ec07e-0000-4000-8000-00000000c001')::text, false);
reset role;
select set_config('sec07.g1_renew', ((current_setting('sec07.tok2') <> current_setting('sec07.tok1'))
   and (select approval_token_expires_at > now() from public.quotes where id='ee5ec07e-0000-4000-8000-00000000c001'))::text, false);
-- a LIVE link is extended when the event moves later (event + 30 days)
update public.quotes set event_date = current_date + 200 where id='ee5ec07e-0000-4000-8000-00000000c001';
select set_config('sec07.g1_extend', (select approval_token_expires_at::date - current_date from public.quotes where id='ee5ec07e-0000-4000-8000-00000000c001')::text, false);

-- ---------- G2 worker links (event date now today + 200) ----------
insert into public.work_tokens(token, quote_id, phone, name, org_id)
values ('ee5ec07e-0000-4000-8000-00000000f001','ee5ec07e-0000-4000-8000-00000000c001','9000000001','SEC07 worker','ee5ec07e-0000-4000-8000-00000000000a');
select set_config('sec07.g2_issue', (select expires_at::date - current_date from public.work_tokens where token='ee5ec07e-0000-4000-8000-00000000f001')::text, false);
update public.work_tokens set expires_at = now() - interval '1 day' where token='ee5ec07e-0000-4000-8000-00000000f001';
insert into public.event_tasks(quote_id, category, title, assignee_phone, status, org_id)
values ('ee5ec07e-0000-4000-8000-00000000c001','setup','SEC07 task 1','9000000001','assigned','ee5ec07e-0000-4000-8000-00000000000a');
select set_config('sec07.g2_renew', (select (expires_at > now())::text from public.work_tokens where token='ee5ec07e-0000-4000-8000-00000000f001'), false);
update public.work_tokens set revoked_at = now(), expires_at = now() - interval '1 day' where token='ee5ec07e-0000-4000-8000-00000000f001';
insert into public.event_tasks(quote_id, category, title, assignee_phone, status, org_id)
values ('ee5ec07e-0000-4000-8000-00000000c001','setup','SEC07 task 2','9000000001','assigned','ee5ec07e-0000-4000-8000-00000000000a');
select set_config('sec07.g2_revoked', (select (expires_at < now())::text from public.work_tokens where token='ee5ec07e-0000-4000-8000-00000000f001'), false);

-- ---------- G3 per-quote limit (quote T3 already has 9 today) ----------
insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
values ('ee5ec07e-0000-4000-8000-00000000c003','7200000001','x',now()+interval '10 min','ee5ec07e-0000-4000-8000-00000000000a');
select set_config('sec07.g3_10th', 'accepted', false);
do $$ begin
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
  values ('ee5ec07e-0000-4000-8000-00000000c003','7200000002','x',now()+interval '10 min','ee5ec07e-0000-4000-8000-00000000000a');
  raise exception 'UNEXPECTED: 11th code for one quote accepted';
exception when others then
  if sqlerrm like 'UNEXPECTED%' then raise; end if;
  perform set_config('sec07.g3_11th', sqlerrm, false);
end $$;

-- ---------- G4 quote must belong to the row's studio ----------
do $$ begin
  insert into public.event_tasks(quote_id, category, title, status, org_id)
  values ('ee5ec07e-0000-4000-8000-00000000c001','setup','SEC07 cross','assigned','ee5ec07e-0000-4000-8000-00000000000b');
  raise exception 'UNEXPECTED: cross-studio task accepted';
exception when others then
  if sqlerrm like 'UNEXPECTED%' then raise; end if;
  perform set_config('sec07.g4_cross', sqlerrm, false);
end $$;
do $$ begin
  insert into public.event_tasks(quote_id, category, title, status, org_id)
  values ('ee5ec07e-0000-4000-8000-0000deadbeef','setup','SEC07 unknown','assigned','ee5ec07e-0000-4000-8000-00000000000a');
  raise exception 'UNEXPECTED: task for unknown quote accepted';
exception when others then
  if sqlerrm like 'UNEXPECTED%' then raise; end if;
  perform set_config('sec07.g4_unknown', sqlerrm, false);
end $$;
delete from public.quotes where id='ee5ec07e-0000-4000-8000-00000000c004';
select set_config('sec07.g4_delete', (not exists (select 1 from public.quotes where id='ee5ec07e-0000-4000-8000-00000000c004'))::text, false);

-- ---------- G5 a NEW public function (created, checked, then ROLLED BACK — nothing is left) ----------
do $$ declare v text; begin
  begin
    create function public.zz_sec07_probe() returns int language sql as 'select 1';
    v := (not has_function_privilege('anon','public.zz_sec07_probe()','EXECUTE')
          and has_function_privilege('authenticated','public.zz_sec07_probe()','EXECUTE')
          and not exists (select 1 from aclexplode((select proacl from pg_proc where oid='public.zz_sec07_probe()'::regprocedure)) a where a.grantee = 0))::text;
    raise exception 'G5RESULT:%', v;          -- undoes the CREATE FUNCTION
  exception when others then
    perform set_config('sec07.g5', sqlerrm, false);
  end;
end $$;

select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claims','',false);
-- ---------- RESULTS ----------
select t.test, t.expected, t.actual, case when t.ok then 'PASS' else 'FAIL' end as result from (values
 ('G1 issue: expiry = event + 30 days', '120 days', current_setting('sec07.g1_issue') || ' days', current_setting('sec07.g1_issue') = '120'),
 ('G1 expiry cannot be cleared', 'true', current_setting('sec07.g1_notnull'), current_setting('sec07.g1_notnull') = 'true'),
 ('G1 approval does not revive an expired link', 'true', current_setting('sec07.g1_norevive'), current_setting('sec07.g1_norevive') = 'true'),
 ('G1 re-issue of expired link: NEW working token', 'true', current_setting('sec07.g1_renew'), current_setting('sec07.g1_renew') = 'true'),
 ('G1 live link extended when event moves', '230 days', current_setting('sec07.g1_extend') || ' days', current_setting('sec07.g1_extend') = '230'),
 ('G2 issue: expiry = event + 14 days', '214 days', current_setting('sec07.g2_issue') || ' days', current_setting('sec07.g2_issue') = '214'),
 ('G2 new assignment renews expired link', 'true', current_setting('sec07.g2_renew'), current_setting('sec07.g2_renew') = 'true'),
 ('G2 revoked link NOT renewed', 'true', current_setting('sec07.g2_revoked'), current_setting('sec07.g2_revoked') = 'true'),
 ('G3 quote: 10th code today accepted', 'accepted', current_setting('sec07.g3_10th'), current_setting('sec07.g3_10th') = 'accepted'),
 ('G3 quote: 11th code today refused', 'error: too many codes … this quote', current_setting('sec07.g3_11th'), current_setting('sec07.g3_11th') like 'too many codes requested for this quote%'),
 ('G4 cross-studio row refused', 'error: another studio', current_setting('sec07.g4_cross'), current_setting('sec07.g4_cross') like '%another studio%'),
 ('G4 unknown quote refused', 'error: quote not found', current_setting('sec07.g4_unknown'), current_setting('sec07.g4_unknown') like '%quote not found%' or current_setting('sec07.g4_unknown') like '%foreign key%'),
 ('G4 deleting a quote still works', 'true', current_setting('sec07.g4_delete'), current_setting('sec07.g4_delete') = 'true'),
 ('G5 new function: PUBLIC/anon cannot, authenticated can', 'G5RESULT:true', current_setting('sec07.g5'), current_setting('sec07.g5') = 'G5RESULT:true')
) as t(test, expected, actual, ok);
