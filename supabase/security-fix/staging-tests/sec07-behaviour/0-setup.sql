-- SEC-07 v2 BEHAVIOUR — BLOCK 0: SETUP. STAGING ONLY (xizehqgeyjcfpzrdymly).
-- Two test studios (A, B), one admin each, 4 test quotes, seeded OTP rows. All ids start with ee5ec07e.
insert into auth.users(id, email) values
  ('ee5ec07e-0000-4000-8000-0000000000a1','sec07-a@example.invalid'),
  ('ee5ec07e-0000-4000-8000-0000000000b1','sec07-b@example.invalid')
on conflict (id) do nothing;
insert into public.organizations(id, name) values
  ('ee5ec07e-0000-4000-8000-00000000000a','SEC07-TEST Studio A'),
  ('ee5ec07e-0000-4000-8000-00000000000b','SEC07-TEST Studio B')
on conflict (id) do nothing;
insert into public.profiles(id, org_id, role) values
  ('ee5ec07e-0000-4000-8000-0000000000a1','ee5ec07e-0000-4000-8000-00000000000a','admin'),
  ('ee5ec07e-0000-4000-8000-0000000000b1','ee5ec07e-0000-4000-8000-00000000000b','admin')
on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
insert into public.quotes(id, org_id, code, title, pricing, event_date) values
  ('ee5ec07e-0000-4000-8000-00000000c001','ee5ec07e-0000-4000-8000-00000000000a','SEC07-T1','SEC07 links','{"gstPct":18,"chairs":1,"chairPrice":1}', current_date + 90),
  ('ee5ec07e-0000-4000-8000-00000000c002','ee5ec07e-0000-4000-8000-00000000000a','SEC07-T2','SEC07 otp phone','{"gstPct":18,"chairs":1,"chairPrice":1}', null),
  ('ee5ec07e-0000-4000-8000-00000000c003','ee5ec07e-0000-4000-8000-00000000000a','SEC07-T3','SEC07 otp quote','{"gstPct":18,"chairs":1,"chairPrice":1}', null),
  ('ee5ec07e-0000-4000-8000-00000000c004','ee5ec07e-0000-4000-8000-00000000000a','SEC07-T4','SEC07 delete','{"gstPct":18,"chairs":1,"chairPrice":1}', null)
on conflict (id) do nothing;
-- quote T2: 2 codes already sent to one number (written two ways) in the last hour
insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values
  ('ee5ec07e-0000-4000-8000-00000000c002','+91 90000 12345','x',now()+interval '10 min','ee5ec07e-0000-4000-8000-00000000000a'),
  ('ee5ec07e-0000-4000-8000-00000000c002','919000012345','x',now()+interval '10 min','ee5ec07e-0000-4000-8000-00000000000a');
-- quote T3: 9 codes today, each to a different number
insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
select 'ee5ec07e-0000-4000-8000-00000000c003', '71000000'||g, 'x', now()+interval '10 min', 'ee5ec07e-0000-4000-8000-00000000000a'
  from generate_series(10,18) g;
select 'setup done' as status,
  (select count(*) from public.quotes where id::text like 'ee5ec07e%') as quotes,
  (select count(*) from public.quote_otps where quote_id='ee5ec07e-0000-4000-8000-00000000c002') as otp_t2,
  (select count(*) from public.quote_otps where quote_id='ee5ec07e-0000-4000-8000-00000000c003') as otp_t3;
