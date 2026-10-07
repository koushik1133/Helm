-- link-autoexpire.sql — 0039: optional per-studio "links stop working N days after
-- they were sent". OFF = unchanged; ON (N=10): 11 days old refused, 9 days old allowed
-- for approval/portal/OTP/payment, proposal, crew and invitation links; the earlier
-- event window still wins; sending again gives a fresh link; Razorpay link capped;
-- only a studio admin can change it (audited, 1–365); another studio is unaffected.
-- Own quotes are created here and removed at the end (shared fixture quotes untouched).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _ae; create temp table _ae(name text, result text); grant all on _ae to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.su_as(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u); execute 'reset role';
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _ae values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- run p_sql as p_who ('anon' | e-mail | 'service'); returns 'live' or the error text / sqlstate
create or replace function pg_temp.as_who(p_who text, p_sql text) returns text language plpgsql as $$
declare r text; begin
  if p_who = 'anon' then perform pg_temp.anon();
  elsif p_who = 'service' then perform pg_temp.su();
  else perform pg_temp.login(p_who); end if;
  begin execute p_sql; r := 'live'; exception when others then r := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.su(); return r;
end $$;
create or replace function pg_temp.q(p text) returns uuid language sql immutable as $$
  select (case p when 'A1' then 'a0000000-0000-4000-8000-000000039a01' when 'A2' then 'a0000000-0000-4000-8000-000000039a02'
                 when 'A3' then 'a0000000-0000-4000-8000-000000039a03' when 'B1' then 'b0000000-0000-4000-8000-000000039b01'
                 -- tokens
                 when 'tA1' then 'a0000000-0000-4000-8000-0000000391a1' when 'tA2' then 'a0000000-0000-4000-8000-0000000391a2'
                 when 'tA3' then 'a0000000-0000-4000-8000-0000000391a3' when 'tB1' then 'b0000000-0000-4000-8000-0000000391b1'
                 when 'pA1' then 'a0000000-0000-4000-8000-0000000392a1' when 'wA1' then 'a0000000-0000-4000-8000-0000000393a1'
            end)::uuid $$;
-- make a link look p_days old
create or replace function pg_temp.age(p_kind text, p_days numeric) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  if p_kind = 'quote' then
    update public.client_link_issued set issued_at = now() - make_interval(secs => p_days * 86400) where kind = 'quote' and token = pg_temp.q('tA1');
  elsif p_kind = 'quoteB' then
    update public.client_link_issued set issued_at = now() - make_interval(secs => p_days * 86400) where kind = 'quote' and token = pg_temp.q('tB1');
  elsif p_kind = 'quoteA3' then
    update public.client_link_issued set issued_at = now() - make_interval(secs => p_days * 86400) where kind = 'quote' and token = pg_temp.q('tA3');
  elsif p_kind = 'proposal' then
    update public.client_link_issued set issued_at = now() - make_interval(secs => p_days * 86400) where kind = 'proposal' and token = pg_temp.q('pA1');
  elsif p_kind = 'work' then
    update public.work_tokens set created_at = now() - make_interval(secs => p_days * 86400) where token = pg_temp.q('wA1');
  elsif p_kind = 'invite' then
    perform pg_temp.su_as('a_admin@a.test');
    update public.event_sites set published_at = now() - make_interval(secs => p_days * 86400) where slug = 'lae-a1';
  end if;
  perform pg_temp.su();
end $$;
create or replace function pg_temp.set_policy(p_org text, p_on boolean, p_days int) returns void language plpgsql as $$
begin
  perform pg_temp.login(case p_org when 'A' then 'a_admin@a.test' else 'b_admin@b.test' end);
  perform public.admin_set_link_autoexpire(p_on, p_days);
  perform pg_temp.su();
end $$;
create or replace function pg_temp.all_links() returns text language plpgsql as $$
begin
  return concat_ws(' | ',
    'quote:'    || pg_temp.as_who('anon', format('select public.public_get_quote(%L)', pg_temp.q('tA1'))),
    'portal:'   || pg_temp.as_who('anon', format('select public.public_get_portal(%L)', pg_temp.q('tA1'))),
    'proposal:' || pg_temp.as_who('anon', format('select public.public_get_proposal(%L)', pg_temp.q('pA1'))),
    'crew:'     || pg_temp.as_who('anon', format('select public.worker_get_tasks(%L)', pg_temp.q('wA1'))),
    'invite:'   || pg_temp.as_who('anon', $s$select * from public.public_event_site('lae-a1')$s$));
end $$;

-- ---- setup (superuser) --------------------------------------------------------
do $$ begin
  perform pg_temp.su_as('a_admin@a.test');
  delete from public.org_link_autoexpire where org_id in ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001');
  delete from public.audit_log where action = 'link_autoexpire.set';
  delete from public.leads where quote_id in (pg_temp.q('A1'), pg_temp.q('A2'), pg_temp.q('A3'));
  delete from public.quotes where id in (pg_temp.q('A1'), pg_temp.q('A2'), pg_temp.q('A3'));
  delete from public.client_link_issued where quote_id in (pg_temp.q('A1'), pg_temp.q('A2'), pg_temp.q('A3'), pg_temp.q('B1'));
  insert into public.quotes(id,code,title,status,client,pricing,current_version,approval_status,org_id,approval_token,created_at,updated_at)
  values (pg_temp.q('A1'),'LAE-A1','Autoexpire A1','quote','{"name":"Ann"}'::jsonb,
          '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb,1,'sent','a0000000-0000-4000-8000-000000000001',pg_temp.q('tA1'),now() - interval '400 days',now()),
         (pg_temp.q('A2'),'LAE-A2','Autoexpire A2','quote','{"name":"Abe"}'::jsonb,
          '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb,1,'sent','a0000000-0000-4000-8000-000000000001',pg_temp.q('tA2'),now(),now()),
         (pg_temp.q('A3'),'LAE-A3','Autoexpire A3','quote','{"name":"Ava"}'::jsonb,
          '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb,1,'approved','a0000000-0000-4000-8000-000000000001',pg_temp.q('tA3'),now(),now());
  insert into public.event_proposal(quote_id, share_token, published) values (pg_temp.q('A1'), pg_temp.q('pA1'), true);
  insert into public.work_tokens(token, quote_id, phone, name) values (pg_temp.q('wA1'), pg_temp.q('A1'), '+919800039001', 'Crew AE');
  delete from public.event_sites where slug = 'lae-a1';
  insert into public.event_sites(quote_id, slug, status, data, published_at) values (pg_temp.q('A1'), 'lae-a1', 'published', '{}'::jsonb, now());
  perform pg_temp.su_as('b_admin@b.test');
  delete from public.leads where quote_id = pg_temp.q('B1');
  delete from public.quotes where id = pg_temp.q('B1');
  insert into public.quotes(id,code,title,status,client,pricing,current_version,approval_status,org_id,approval_token,created_at,updated_at)
  values (pg_temp.q('B1'),'LAE-B1','Autoexpire B1','quote','{"name":"Bea"}'::jsonb,
          '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb,1,'sent','b0000000-0000-4000-8000-000000000001',pg_temp.q('tB1'),now(),now());
  perform pg_temp.su();
end $$;

-- ---- issue times are recorded by the triggers ----------------------------------
do $$ declare n int; begin
  perform pg_temp.su();
  select count(*) into n from public.client_link_issued
   where (kind, token) in (('quote', pg_temp.q('tA1')), ('quote', pg_temp.q('tB1')), ('proposal', pg_temp.q('pA1')))
     and issued_at > now() - interval '1 minute' and source = 'trigger';
  perform pg_temp.res('issue time recorded for new approval + proposal tokens', n = 3, n || '/3');
end $$;

-- ---- OFF (no row) = unchanged, even for very old links -------------------------
do $$ declare r text; begin
  perform pg_temp.age('quote', 400); perform pg_temp.age('proposal', 400); perform pg_temp.age('work', 400); perform pg_temp.age('invite', 400);
  r := pg_temp.all_links();
  perform pg_temp.res('OFF: 400-day-old quote/portal/proposal/crew/invite links all still work', r !~ 'expired|ended|invalid', r);
end $$;

-- ---- access control: admin only, own studio, 1..365, audited --------------------
do $$ declare r text; begin
  r := pg_temp.as_who('a_staff@a.test', 'select public.admin_set_link_autoexpire(true, 10)');
  perform pg_temp.res('non-admin cannot switch it on', r like '42501%', r);
  r := pg_temp.as_who('a_staff@a.test', 'select public.admin_get_link_autoexpire()');
  perform pg_temp.res('non-admin cannot read the admin view', r like '42501%', r);
  r := pg_temp.as_who('anon', 'select public.admin_set_link_autoexpire(true, 10)');
  perform pg_temp.res('anon cannot switch it on', r like '42501%', r);
  r := pg_temp.as_who('a_admin@a.test', $s$insert into public.org_link_autoexpire(org_id, enabled, days) values ('a0000000-0000-4000-8000-000000000001', true, 1)$s$);
  perform pg_temp.res('no direct table writes, even for an admin', r like '42501%', r);
  r := pg_temp.as_who('a_admin@a.test', 'select public.admin_set_link_autoexpire(true, 0)');
  perform pg_temp.res('0 days rejected', r like '22023%', r);
  r := pg_temp.as_who('a_admin@a.test', 'select public.admin_set_link_autoexpire(true, 366)');
  perform pg_temp.res('366 days rejected', r like '22023%', r);
  perform pg_temp.su();
  perform pg_temp.res('rejected values stored nothing',
    not exists (select 1 from public.org_link_autoexpire where org_id = 'a0000000-0000-4000-8000-000000000001'), 'row exists');
  r := pg_temp.as_who('anon', format('select public.public_get_quote__pre0039(%L)', pg_temp.q('tA1')));
  perform pg_temp.res('anon cannot call the unguarded originals', r like '42501%', r);
  r := pg_temp.as_who('a_staff@a.test', format('select public._work_token_live(%L)', pg_temp.q('wA1')));
  perform pg_temp.res('signed-in users cannot call the crew-token helper', r like '42501%', r);
end $$;

do $$ declare j jsonb; n int; begin
  perform pg_temp.login('a_admin@a.test');
  j := public.admin_get_link_autoexpire();
  perform pg_temp.res('default view: OFF, 10 days, range 1-365',
    j->>'enabled' = 'false' and j->>'days' = '10' and j->>'min_days' = '1' and j->>'max_days' = '365', j::text);
  perform pg_temp.login('a_admin@a.test');
  j := public.admin_set_link_autoexpire(true, 10);
  perform pg_temp.res('admin switches it on with 10 days', j->>'enabled' = 'true' and j->>'days' = '10', j::text);
  perform pg_temp.su();
  select count(*) into n from public.audit_log
   where action = 'link_autoexpire.set' and org_id = 'a0000000-0000-4000-8000-000000000001'
     and changed->'enabled'->>'new' = 'true' and changed->'days'->>'new' = '10' and actor_email = 'a_admin@a.test';
  perform pg_temp.res('the change is in the audit log', n = 1, n || ' rows');
  perform pg_temp.login('a_admin@a.test');
  perform public.admin_set_link_autoexpire(true, 10);      -- no change -> no extra audit row
  perform pg_temp.su();
  select count(*) into n from public.audit_log where action = 'link_autoexpire.set' and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('saving the same values adds no audit noise', n = 1, n || ' rows');
end $$;

-- ---- ON, N = 10: 11 days old refused, 9 days old allowed ------------------------
do $$ declare r text; begin
  perform pg_temp.age('quote', 11);
  r := pg_temp.as_who('anon', format('select public.public_get_quote(%L)', pg_temp.q('tA1')));
  perform pg_temp.res('approval link 11 days old -> expired', r ~ 'expired', r);
  r := pg_temp.as_who('anon', format('select public.public_get_portal(%L)', pg_temp.q('tA1')));
  perform pg_temp.res('portal 11 days old -> expired', r ~ 'expired', r);
  r := pg_temp.as_who('anon', format('select public.request_otp(%L, %L)', pg_temp.q('tA1'), '+919811100000'));
  perform pg_temp.res('OTP request on an 11-day-old link -> expired', r ~ 'expired', r);
  r := pg_temp.as_who('anon', format('select public.verify_and_consent(%L,%L,%L,true,%L,%L,%L,%L)', pg_temp.q('tA1'), '+919811100000', '123456', 'v3', 'I accept', 'Ann', 'ua'));
  perform pg_temp.res('approve (verify) on an 11-day-old link -> expired', r ~ 'expired', r);
  r := pg_temp.as_who('anon', format('select public.create_payment(%L)', pg_temp.q('tA1')));
  perform pg_temp.res('pay on an 11-day-old link -> expired', r ~ 'expired', r);
  r := pg_temp.as_who('service', format('select public.otp_send_authorize(%L, %L)', pg_temp.q('tA1'), '+919811100000'));
  perform pg_temp.res('SMS edge function refused (HL404) for an 11-day-old link', r like 'HL404%', r);
  perform pg_temp.su();
  perform pg_temp.res('payment edge function refused for an 11-day-old link',
    public.payment_link_begin(pg_temp.q('tA1')) ->> 'action' = 'invalid', 'not invalid');

  perform pg_temp.age('quote', 9);
  r := pg_temp.as_who('anon', format('select public.public_get_quote(%L)', pg_temp.q('tA1')));
  perform pg_temp.res('approval link 9 days old -> works', r = 'live', r);
  r := pg_temp.as_who('anon', format('select public.public_get_portal(%L)', pg_temp.q('tA1')));
  perform pg_temp.res('portal 9 days old -> works', r = 'live', r);

  perform pg_temp.age('proposal', 11);
  r := pg_temp.as_who('anon', format('select public.public_get_proposal(%L)', pg_temp.q('pA1')));
  perform pg_temp.res('proposal 11 days old -> expired', r ~ 'expired', r);
  perform pg_temp.age('proposal', 9);
  r := pg_temp.as_who('anon', format('select public.public_get_proposal(%L)', pg_temp.q('pA1')));
  perform pg_temp.res('proposal 9 days old -> works', r = 'live', r);

  perform pg_temp.age('work', 11);
  r := pg_temp.as_who('anon', format('select public.worker_get_tasks(%L)', pg_temp.q('wA1')));
  perform pg_temp.res('crew link 11 days old -> expired', r ~ 'expired', r);
  perform pg_temp.age('work', 9);
  r := pg_temp.as_who('anon', format('select public.worker_get_tasks(%L)', pg_temp.q('wA1')));
  perform pg_temp.res('crew link 9 days old -> works', r = 'live', r);

  perform pg_temp.age('invite', 11);
  r := pg_temp.as_who('anon', $s$select * from public.public_event_site('lae-a1')$s$);
  perform pg_temp.res('invitation published 11 days ago -> ended', r ~ 'ended', r);
  perform pg_temp.age('invite', 9);
  r := pg_temp.as_who('anon', $s$select * from public.public_event_site('lae-a1')$s$);
  perform pg_temp.res('invitation published 9 days ago -> works', r = 'live', r);
  perform pg_temp.su();
  perform pg_temp.res('studio "live until" = published + 10 days',
    abs(extract(epoch from (public.event_site_live_until((select id from public.event_sites where slug = 'lae-a1'))
                            - (select published_at + interval '10 days' from public.event_sites where slug = 'lae-a1')))) < 1, 'mismatch');
end $$;

-- crew: assigning a new task re-sends the link -> its age starts again
do $$ declare r text; begin
  perform pg_temp.age('work', 11);
  perform pg_temp.su_as('a_admin@a.test');
  insert into public.event_tasks(quote_id, category, title, seq, assignee_name, assignee_phone, status, created_at)
    values (pg_temp.q('A1'), 'setup', 'AE task', 1, 'Crew AE', '+919800039001', 'assigned', now() - interval '1 day');
  r := pg_temp.as_who('anon', format('select public.worker_get_tasks(%L)', pg_temp.q('wA1')));
  perform pg_temp.res('crew link re-sent with a new task yesterday -> works again', r = 'live', r);
end $$;

-- ---- the earlier event window still wins ----------------------------------------
do $$ declare r text; begin
  perform pg_temp.set_policy('A', true, 365);
  perform pg_temp.su();
  update public.quotes set approval_token_expires_at = now() - interval '1 hour' where id = pg_temp.q('A2');
  r := pg_temp.as_who('anon', format('select public.public_get_quote(%L)', pg_temp.q('tA2')));
  perform pg_temp.res('N=365: approval link past its event window stays refused', r ~ 'invalid link|expired', r);
  perform pg_temp.age('work', 1);
  update public.work_tokens set expires_at = now() - interval '1 minute' where token = pg_temp.q('wA1');
  r := pg_temp.as_who('anon', format('select public.worker_get_tasks(%L)', pg_temp.q('wA1')));
  perform pg_temp.res('N=365: crew link past its event window stays refused', r ~ 'expired', r);
  perform pg_temp.su_as('a_admin@a.test');
  update public.quotes set event_date = current_date - 9 where id = pg_temp.q('A1');
  perform pg_temp.age('invite', 1);
  r := pg_temp.as_who('anon', $s$select * from public.public_event_site('lae-a1')$s$);
  perform pg_temp.res('N=365: invitation published yesterday for an event 9 days ago stays ended', r ~ 'ended', r);
  perform pg_temp.su_as('a_admin@a.test');
  update public.quotes set event_date = null where id = pg_temp.q('A1');
  perform pg_temp.su();
  update public.work_tokens set expires_at = now() + interval '60 days' where token = pg_temp.q('wA1');
  perform pg_temp.set_policy('A', true, 10);
end $$;

-- ---- another studio is unaffected ------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.age('quoteB', 11);
  r := pg_temp.as_who('anon', format('select public.public_get_quote(%L)', pg_temp.q('tB1')));
  perform pg_temp.res('studio B (setting off) 11-day-old link still works while A is on', r = 'live', r);
  perform pg_temp.su();
  perform pg_temp.res('studio A''s setting created no row for studio B',
    not exists (select 1 from public.org_link_autoexpire where org_id = 'b0000000-0000-4000-8000-000000000001'), 'row for B');
end $$;

-- ---- sending again gives a fresh link -----------------------------------------------
do $$ declare r text; t uuid; begin
  perform pg_temp.age('quote', 11);
  perform pg_temp.login('a_admin@a.test');
  t := public.generate_approval_token(pg_temp.q('A1'));
  perform pg_temp.res('"Send approval link" on an aged-out link hands out a NEW token', t is not null and t <> pg_temp.q('tA1'), coalesce(t::text, 'null'));
  r := pg_temp.as_who('anon', format('select public.public_get_quote(%L)', t));
  perform pg_temp.res('the new approval link works', r = 'live', r);
  r := pg_temp.as_who('anon', format('select public.public_get_quote(%L)', pg_temp.q('tA1')));
  perform pg_temp.res('the old approval link stays dead', r ~ 'invalid link|expired', r);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('sending again within the limit keeps the same token', public.generate_approval_token(pg_temp.q('A1')) = t, 'rotated');

  perform pg_temp.age('proposal', 11);
  perform pg_temp.login('a_admin@a.test');
  t := public.publish_proposal(pg_temp.q('A1'), true);
  perform pg_temp.res('re-publishing an aged-out proposal hands out a NEW token', t is not null and t <> pg_temp.q('pA1'), coalesce(t::text, 'null'));
  r := pg_temp.as_who('anon', format('select public.public_get_proposal(%L)', t));
  perform pg_temp.res('the new proposal link works', r = 'live', r);
  perform pg_temp.su();
end $$;

-- ---- payment link (Razorpay) never outlives the approval link ----------------------
do $$ declare j jsonb; v_until timestamptz; begin
  perform pg_temp.age('quoteA3', 9.5);                 -- 12 hours left
  perform pg_temp.su();
  v_until := public.approval_link_age_until(pg_temp.q('tA3'));
  j := public.payment_link_begin(pg_temp.q('tA3'));
  perform pg_temp.res('payment link expiry capped at the approval link''s age limit',
    j->>'action' = 'create' and abs((j->>'expire_by')::bigint - extract(epoch from v_until)) <= 1
    and abs(extract(epoch from (select link_expires_at from public.quote_payments where id = (j->>'payment_id')::uuid)) - extract(epoch from v_until)) <= 1,
    j::text);
end $$;

-- ---- OFF again: everything comes back (nothing was rewritten) ---------------------
do $$ declare r text; begin
  perform pg_temp.set_policy('A', false, 10);
  perform pg_temp.age('proposal', 400); perform pg_temp.age('work', 400); perform pg_temp.age('invite', 400);
  r := concat_ws(' | ',
    pg_temp.as_who('anon', format('select public.public_get_proposal(%L)', (select share_token from public.event_proposal where quote_id = pg_temp.q('A1')))),
    pg_temp.as_who('anon', format('select public.worker_get_tasks(%L)', pg_temp.q('wA1'))),
    pg_temp.as_who('anon', $s$select * from public.public_event_site('lae-a1')$s$));
  perform pg_temp.res('switched off: old links work again', r !~ 'expired|ended|invalid', r);
end $$;

-- ---- cleanup: only what this suite created ----------------------------------------
do $$ begin
  perform pg_temp.su_as('a_admin@a.test');
  delete from public.org_link_autoexpire where org_id in ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001');
  delete from public.audit_log where action = 'link_autoexpire.set';
  delete from public.event_sites where slug = 'lae-a1';
  delete from public.leads where quote_id in (pg_temp.q('A1'), pg_temp.q('A2'), pg_temp.q('A3'));
  delete from public.quotes where id in (pg_temp.q('A1'), pg_temp.q('A2'), pg_temp.q('A3'));
  perform pg_temp.su_as('b_admin@b.test');
  delete from public.leads where quote_id = pg_temp.q('B1');
  delete from public.quotes where id = pg_temp.q('B1');
  perform pg_temp.su();
  delete from public.client_link_issued where quote_id in (pg_temp.q('A1'), pg_temp.q('A2'), pg_temp.q('A3'), pg_temp.q('B1'));
end $$;

select name, result from _ae order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 45 then 'LINK-AUTOEXPIRE: ALL PASS (45/45)'
            else 'LINK-AUTOEXPIRE: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/45 ran' end from _ae;
