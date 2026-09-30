-- BLOCK 0 — SETUP (staging only). Test studios A/B, 4 test users, 1 item (stock 10), 2 reservations (qty 4).
insert into auth.users(id, email) values
  ('ee5ec06e-0000-4000-8000-0000000000a1','sec06-a@example.invalid'),
  ('ee5ec06e-0000-4000-8000-0000000000b1','sec06-b@example.invalid')
on conflict (id) do nothing;
insert into public.organizations(id, name) values
  ('ee5ec06e-0000-4000-8000-00000000000a','SEC06-TEST Studio A'),
  ('ee5ec06e-0000-4000-8000-00000000000b','SEC06-TEST Studio B')
on conflict (id) do nothing;
insert into public.profiles(id, org_id, role) values
  ('ee5ec06e-0000-4000-8000-0000000000a1','ee5ec06e-0000-4000-8000-00000000000a','admin'),
  ('ee5ec06e-0000-4000-8000-0000000000b1','ee5ec06e-0000-4000-8000-00000000000b','admin')
on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
insert into public.quotes(id, org_id, code, title, pricing) values
  ('ee5ec06e-0000-4000-8000-00000000c001','ee5ec06e-0000-4000-8000-00000000000a','SEC06-T1','SEC06 test','{"gstPct":18,"chairs":1,"chairPrice":1}')
on conflict (id) do nothing;
insert into public.inventory_items(id, name, total_qty, org_id) values
  ('ee5ec06e-0000-4000-8000-00000000d001','SEC06-TEST chairs',10,'ee5ec06e-0000-4000-8000-00000000000a')
on conflict (id) do update set total_qty = 10;
insert into public.inventory_reservations(id, item_id, quote_id, qty, status, org_id) values
  ('ee5ec06e-0000-4000-8000-00000000e001','ee5ec06e-0000-4000-8000-00000000d001','ee5ec06e-0000-4000-8000-00000000c001',4,'reserved','ee5ec06e-0000-4000-8000-00000000000a'),
  ('ee5ec06e-0000-4000-8000-00000000e002','ee5ec06e-0000-4000-8000-00000000d001','ee5ec06e-0000-4000-8000-00000000c001',4,'reserved','ee5ec06e-0000-4000-8000-00000000000a')
on conflict (id) do update set status = 'reserved';
insert into public.invitations(org_id, email, role, token, status, expires_at, invited_by) values
  ('ee5ec06e-0000-4000-8000-00000000000a','sec06-p@example.invalid','planner', repeat('e',47)||'1','pending', now()+interval '7 days','ee5ec06e-0000-4000-8000-0000000000a1'),
  ('ee5ec06e-0000-4000-8000-00000000000a','sec06-e@example.invalid','sales',   repeat('e',47)||'2','pending', now()-interval '1 day', 'ee5ec06e-0000-4000-8000-0000000000a1'),
  ('ee5ec06e-0000-4000-8000-00000000000a','sec06-c@example.invalid','sales',   repeat('e',47)||'3','accepted',now()+interval '7 days','ee5ec06e-0000-4000-8000-0000000000a1'),
  ('ee5ec06e-0000-4000-8000-00000000000a','sec06-r@example.invalid','sales',   repeat('e',47)||'4','revoked', now()+interval '7 days','ee5ec06e-0000-4000-8000-0000000000a1');
select 'setup done' as status,
       (select total_qty from public.inventory_items where id='ee5ec06e-0000-4000-8000-00000000d001') as stock,
       (select string_agg(status, ',' order by id) from public.inventory_reservations where id::text like 'ee5ec06e%') as reservations;
