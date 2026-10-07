-- link-expiry-archive.sql — 0040: "when a quote's client link expires (never approved /
-- confirmed / paid): Keep | Move to Archive | Move to Deleted quotes". Setting off =
-- nothing moves; archive mode moves only eligible quotes (aged link, unconfirmed, no
-- money); deleted mode sets the soft flag and the row stays; confirmed / paid quotes
-- never move; Restore works and isn't undone for N days; only an admin changes the
-- setting; other studio unaffected; audit rows written; the 10-minute rate limit; the
-- 0026 delete guard still holds. Own quotes are created here and removed at the end.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _lx; create temp table _lx(name text, result text); grant all on _lx to anon, authenticated;

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
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _lx values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- run p_sql as p_who ('anon' | e-mail | 'service'); returns 'ok' or sqlstate + message
create or replace function pg_temp.as_who(p_who text, p_sql text) returns text language plpgsql as $$
declare r text; begin
  if p_who = 'anon' then perform pg_temp.su(); perform auth.login_anon();
  elsif p_who = 'service' then perform pg_temp.su();
  else perform pg_temp.login(p_who); end if;
  begin execute p_sql; r := 'ok'; exception when others then r := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.su(); return r;
end $$;
create or replace function pg_temp.q(p text) returns uuid language sql immutable as $$
  select (case p
    when 'E1' then 'a0000000-0000-4000-8000-000000040a01' when 'E2' then 'a0000000-0000-4000-8000-000000040a02'
    when 'E3' then 'a0000000-0000-4000-8000-000000040a03' when 'F1' then 'a0000000-0000-4000-8000-000000040a04'
    when 'C1' then 'a0000000-0000-4000-8000-000000040a05' when 'P1' then 'a0000000-0000-4000-8000-000000040a06'
    when 'N1' then 'a0000000-0000-4000-8000-000000040a07' when 'R1' then 'a0000000-0000-4000-8000-000000040a08'
    when 'B1' then 'b0000000-0000-4000-8000-000000040b01'
    when 'tE1' then 'a0000000-0000-4000-8000-0000000401e1' when 'tE2' then 'a0000000-0000-4000-8000-0000000401e2'
    when 'tE3' then 'a0000000-0000-4000-8000-0000000401e3' when 'tF1' then 'a0000000-0000-4000-8000-0000000401f1'
    when 'tC1' then 'a0000000-0000-4000-8000-0000000401c1' when 'tP1' then 'a0000000-0000-4000-8000-0000000401d1'
    when 'pR1' then 'a0000000-0000-4000-8000-0000000402a8' when 'tB1' then 'b0000000-0000-4000-8000-0000000401b1'
  end)::uuid $$;
create or replace function pg_temp.orgA() returns uuid language sql immutable as $$ select 'a0000000-0000-4000-8000-000000000001'::uuid $$;
create or replace function pg_temp.orgB() returns uuid language sql immutable as $$ select 'b0000000-0000-4000-8000-000000000001'::uuid $$;
-- make a link look p_days old (approval token or proposal share token)
create or replace function pg_temp.age(p_token text, p_days numeric) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  update public.client_link_issued set issued_at = now() - make_interval(secs => p_days * 86400) where token = pg_temp.q(p_token);
end $$;
create or replace function pg_temp.flag(p text) returns text language sql as $$
  select case when deleted_at is not null then 'deleted:' || coalesce(deleted_reason, '')
              when archived_at is not null then 'archived:' || coalesce(archived_reason, '') else 'active' end
    from public.quotes where id = pg_temp.q(p) $$;
create or replace function pg_temp.mine() returns uuid[] language sql immutable as $$
  select array[pg_temp.q('E1'), pg_temp.q('E2'), pg_temp.q('E3'), pg_temp.q('F1'), pg_temp.q('C1'),
               pg_temp.q('P1'), pg_temp.q('N1'), pg_temp.q('R1')] $$;
create or replace function pg_temp.cleanup() returns void language plpgsql as $$
begin
  perform pg_temp.su();
  delete from public.org_link_expiry_shelf where org_id in (pg_temp.orgA(), pg_temp.orgB());
  delete from public.org_link_autoexpire  where org_id in (pg_temp.orgA(), pg_temp.orgB());
  delete from public.audit_log where action in ('link_autoexpire.set', 'link_expiry_shelf.set', 'quote.moved_to_archive',
                                                'quote.moved_to_deleted', 'quote.restored');
  perform pg_temp.su_as('a_admin@a.test');
  delete from public.quote_payments where quote_id = any(pg_temp.mine());
  delete from public.event_proposal where quote_id = any(pg_temp.mine());
  delete from public.leads where quote_id = any(pg_temp.mine());
  delete from public.quotes where id = any(pg_temp.mine());
  perform pg_temp.su_as('b_admin@b.test');
  delete from public.leads where quote_id = pg_temp.q('B1');
  delete from public.quotes where id = pg_temp.q('B1');
  perform pg_temp.su();
  delete from public.client_link_issued where quote_id = any(pg_temp.mine() || pg_temp.q('B1'));
  update public.role_access set can_view = true, can_edit = true where role = 'sales' and area = 'quotes' and org_id = pg_temp.orgA();
end $$;

-- ---- setup -------------------------------------------------------------------
do $$ declare A uuid := pg_temp.orgA(); P text := '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'; begin
  perform pg_temp.cleanup();
  perform pg_temp.su_as('a_admin@a.test');
  insert into public.quotes(id,code,title,status,client,pricing,current_version,approval_status,org_id,approval_token,created_at,updated_at) values
    (pg_temp.q('E1'),'LXA-E1','Expired E1','quote','{"name":"Eve"}',P::jsonb,1,'sent',A,pg_temp.q('tE1'),now()-interval '60 days',now()),
    (pg_temp.q('E2'),'LXA-E2','Expired E2','quote','{"name":"Eli"}',P::jsonb,1,'sent',A,pg_temp.q('tE2'),now()-interval '60 days',now()),
    (pg_temp.q('E3'),'LXA-E3','Expired E3','quote','{"name":"Ema"}',P::jsonb,1,'none',A,pg_temp.q('tE3'),now()-interval '60 days',now()),
    (pg_temp.q('F1'),'LXA-F1','Fresh F1',  'quote','{"name":"Fay"}',P::jsonb,1,'sent',A,pg_temp.q('tF1'),now()-interval '60 days',now()),
    (pg_temp.q('P1'),'LXA-P1','Paid P1',   'quote','{"name":"Pam"}',P::jsonb,1,'sent',A,pg_temp.q('tP1'),now()-interval '60 days',now()),
    (pg_temp.q('N1'),'LXA-N1','No link N1','quote','{"name":"Ned"}',P::jsonb,1,'none',A,null,           now()-interval '60 days',now()),
    (pg_temp.q('R1'),'LXA-R1','Proposal R1','quote','{"name":"Rex"}',P::jsonb,1,'none',A,null,          now()-interval '60 days',now());
  -- C1: confirmed by the studio (status confirmed) but the client never approved
  insert into public.quotes(id,code,title,status,client,pricing,current_version,approval_status,org_id,approval_token,created_at,updated_at,confirmed_at)
    values (pg_temp.q('C1'),'LXA-C1','Confirmed C1','quote','{"name":"Cy"}',P::jsonb,1,'sent',A,pg_temp.q('tC1'),now()-interval '60 days',now(),null);
  perform pg_temp.su();
  update public.quotes set status = 'confirmed', confirmed_at = now() - interval '30 days' where id = pg_temp.q('C1');
  insert into public.quote_payments(quote_id, provider, amount, status, simulated, org_id, paid_at)
    values (pg_temp.q('P1'), 'manual', 1000, 'paid', true, A, now() - interval '20 days');
  insert into public.event_proposal(quote_id, share_token, published, org_id) values (pg_temp.q('R1'), pg_temp.q('pR1'), true, A);
  perform pg_temp.su_as('b_admin@b.test');
  insert into public.quotes(id,code,title,status,client,pricing,current_version,approval_status,org_id,approval_token,created_at,updated_at)
    values (pg_temp.q('B1'),'LXB-B1','Expired B1','quote','{"name":"Bo"}','{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb,1,'sent',pg_temp.orgB(),pg_temp.q('tB1'),now()-interval '60 days',now());
  perform pg_temp.su();
  -- every link 30 days old except F1 (5 days) and E2 (5 days for now; aged later)
  perform pg_temp.age('tE1', 30); perform pg_temp.age('tE3', 30); perform pg_temp.age('tC1', 30); perform pg_temp.age('tP1', 30);
  perform pg_temp.age('pR1', 30); perform pg_temp.age('tB1', 30);
  perform pg_temp.age('tF1', 5); perform pg_temp.age('tE2', 5);
end $$;

-- ---- defaults: columns NULL, setting absent = Keep -------------------------------
do $$ declare n int; r text; j jsonb; begin
  perform pg_temp.su();
  select count(*) into n from public.quotes where id = any(pg_temp.mine()) and archived_at is null and deleted_at is null
     and archived_by is null and deleted_by is null and link_expired_at is null and shelf_restored_at is null;
  perform pg_temp.res('new columns start NULL (every quote stays in the normal lists)', n = 8, n || '/8');
  r := pg_temp.as_who('a_staff@a.test', 'select public.link_expiry_shelf_tick()');
  perform pg_temp.res('no setting: tick runs nothing', r = 'ok', r);
  perform pg_temp.login('a_staff@a.test');
  j := public.link_expiry_shelf_tick();
  perform pg_temp.res('no setting: tick reports ran=false', j->>'ran' = 'false', j::text);
  perform pg_temp.su();
  j := public.apply_link_expiry_archive(pg_temp.orgA());
  perform pg_temp.res('setting off: the job moves nothing', (j->>'moved')::int = 0, j::text);
  perform pg_temp.login('a_admin@a.test');
  j := public.admin_get_link_expiry_shelf();
  perform pg_temp.res('admin view default: Keep', j->>'action' = 'keep', j::text);
end $$;

-- ---- access control on the setting -----------------------------------------------
do $$ declare r text; begin
  r := pg_temp.as_who('a_staff@a.test', $s$select public.admin_set_link_expiry_shelf('archive')$s$);
  perform pg_temp.res('non-admin cannot change the setting', r like '42501%', r);
  r := pg_temp.as_who('a_staff@a.test', 'select public.admin_get_link_expiry_shelf()');
  perform pg_temp.res('non-admin cannot read the admin view', r like '42501%', r);
  r := pg_temp.as_who('anon', $s$select public.admin_set_link_expiry_shelf('archive')$s$);
  perform pg_temp.res('anon cannot change the setting', r like '42501%', r);
  r := pg_temp.as_who('a_admin@a.test', $s$insert into public.org_link_expiry_shelf(org_id, action) values ('a0000000-0000-4000-8000-000000000001', 'delete')$s$);
  perform pg_temp.res('no direct table writes, even for an admin', r like '42501%', r);
  r := pg_temp.as_who('a_admin@a.test', $s$select public.admin_set_link_expiry_shelf('purge')$s$);
  perform pg_temp.res('unknown choice rejected', r like '22023%', r);
  r := pg_temp.as_who('a_staff@a.test', format('select public.apply_link_expiry_archive(%L)', pg_temp.orgA()));
  perform pg_temp.res('signed-in users cannot call the job directly (no rate-limit bypass)', r like '42501%', r);
  r := pg_temp.as_who('anon', 'select public.link_expiry_shelf_tick()');
  perform pg_temp.res('anon cannot run the tick', r like '42501%', r);
  r := pg_temp.as_who('a_staff@a.test', format('select * from public.link_expiry_shelf_candidates(%L, 1)', pg_temp.orgB()));
  perform pg_temp.res('signed-in users cannot list another studio''s candidates', r like '42501%', r);
  perform pg_temp.su();
  perform pg_temp.res('rejected attempts stored nothing',
    not exists (select 1 from public.org_link_expiry_shelf where org_id = pg_temp.orgA()), 'row exists');
end $$;

-- ---- auto-expire ON but choice Keep -> nothing moves ------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.login('a_admin@a.test'); perform public.admin_set_link_autoexpire(true, 10);
  perform pg_temp.login('a_admin@a.test'); perform public.admin_set_link_expiry_shelf('keep');
  perform pg_temp.su();
  j := public.apply_link_expiry_archive(pg_temp.orgA());
  perform pg_temp.res('auto-expire on + Keep: nothing moves', (j->>'moved')::int = 0
    and not exists (select 1 from public.quotes where id = any(pg_temp.mine()) and (archived_at is not null or deleted_at is not null)), j::text);
end $$;

-- ---- Archive mode -------------------------------------------------------------------------
do $$ declare j jsonb; n int; begin
  perform pg_temp.login('a_admin@a.test');
  j := public.admin_set_link_expiry_shelf('archive');
  perform pg_temp.res('admin chooses Archive; preview counts the 3 that qualify now (E1, E3, R1)',
    j->>'action' = 'archive' and (j->>'waiting')::int = 3, j::text);
  perform pg_temp.su();
  select count(*) into n from public.audit_log where action = 'link_expiry_shelf.set' and org_id = pg_temp.orgA()
     and changed->'action'->>'old' = 'keep' and changed->'action'->>'new' = 'archive' and actor_email = 'a_admin@a.test';
  perform pg_temp.res('setting change is audited', n = 1, n || ' rows');

  perform pg_temp.login('a_staff@a.test');
  j := public.link_expiry_shelf_tick();
  perform pg_temp.res('opening Quotes (tick) moves the 3 eligible quotes', j->>'ran' = 'true' and (j->>'moved')::int = 3, j::text);
  perform pg_temp.su();
  perform pg_temp.res('E1 (approval link 30 days old, never approved) -> Archive', pg_temp.flag('E1') = 'archived:link_expired', pg_temp.flag('E1'));
  perform pg_temp.res('E3 (approval_status none) -> Archive', pg_temp.flag('E3') = 'archived:link_expired', pg_temp.flag('E3'));
  perform pg_temp.res('R1 (only a proposal link, 30 days old) -> Archive', pg_temp.flag('R1') = 'archived:link_expired', pg_temp.flag('R1'));
  perform pg_temp.res('F1 (link 5 days old) stays', pg_temp.flag('F1') = 'active', pg_temp.flag('F1'));
  perform pg_temp.res('C1 (confirmed) never moves', pg_temp.flag('C1') = 'active', pg_temp.flag('C1'));
  perform pg_temp.res('P1 (has a payment) never moves', pg_temp.flag('P1') = 'active', pg_temp.flag('P1'));
  perform pg_temp.res('N1 (no link ever sent) never moves', pg_temp.flag('N1') = 'active', pg_temp.flag('N1'));
  perform pg_temp.res('link_expired_at = link sent + 10 days',
    (select abs(extract(epoch from (q.link_expired_at - (i.issued_at + interval '10 days')))) < 1
       from public.quotes q join public.client_link_issued i on i.token = q.approval_token where q.id = pg_temp.q('E1')), 'mismatch');
  perform pg_temp.res('moved by the system (no person recorded as archiver)',
    (select archived_by is null from public.quotes where id = pg_temp.q('E1')), 'archived_by set');
  select count(*) into n from public.audit_log where action = 'quote.moved_to_archive' and org_id = pg_temp.orgA()
     and quote_id in (pg_temp.q('E1'), pg_temp.q('E3'), pg_temp.q('R1')) and changed->>'auto' = 'true' and changed->>'reason' = 'link_expired';
  perform pg_temp.res('one audit row per moved quote', n = 3, n || ' rows');
end $$;

-- ---- rate limit + idempotent ---------------------------------------------------------------
do $$ declare j jsonb; n int; begin
  perform pg_temp.login('a_staff@a.test');
  j := public.link_expiry_shelf_tick();
  perform pg_temp.res('second tick within 10 minutes does not run', j->>'ran' = 'false', j::text);
  perform pg_temp.su();
  j := public.apply_link_expiry_archive(pg_temp.orgA());
  select count(*) into n from public.audit_log where action = 'quote.moved_to_archive' and org_id = pg_temp.orgA();
  perform pg_temp.res('running the job again moves nothing and writes no audit noise', (j->>'moved')::int = 0 and n = 3, j::text || ' audit=' || n);
  update public.org_link_expiry_shelf set last_run_at = now() - interval '11 minutes' where org_id = pg_temp.orgA();
  perform pg_temp.login('a_staff@a.test');
  j := public.link_expiry_shelf_tick();
  perform pg_temp.res('after 10 minutes the tick runs again (nothing new to move)', j->>'ran' = 'true' and (j->>'moved')::int = 0, j::text);
end $$;

-- ---- the API roles can read but not write the flags -------------------------------------------
do $$ declare r text; j jsonb; begin
  r := pg_temp.as_who('a_staff@a.test', format('update public.quotes set archived_at = null where id = %L', pg_temp.q('E1')));
  perform pg_temp.res('un-archiving by a direct update is refused', r like '42501%', r);
  r := pg_temp.as_who('a_admin@a.test', format('update public.quotes set deleted_at = now() where id = %L', pg_temp.q('F1')));
  perform pg_temp.res('flagging deleted by a direct update is refused (even admin)', r like '42501%', r);
  r := pg_temp.as_who('a_staff@a.test', format('update public.quotes set title = %L where id = %L', 'Renamed F1', pg_temp.q('F1')));
  perform pg_temp.res('normal quote edits still work', r = 'ok', r);
  perform pg_temp.login('a_staff@a.test');
  j := public.list_quote_shelf();
  perform pg_temp.res('Quotes page lists the Archive shelf with the reason + expiry date (+ tab counts)',
    (j->>'archived_count')::int >= 3 and (j->>'deleted_count')::int = 0
    and exists (select 1 from jsonb_array_elements(j->'rows') e where e->>'id' = pg_temp.q('E1')::text and e->>'shelf' = 'archived'
             and e->>'reason' = 'link_expired' and e->>'link_expired_at' is not null and e->>'code' = 'LXA-E1'), j::text);
  perform pg_temp.login('b_staff@b.test');
  j := public.list_quote_shelf();
  perform pg_temp.res('another studio does not see studio A''s archive',
    not exists (select 1 from jsonb_array_elements(j->'rows') e where e->>'id' = any(array[pg_temp.q('E1')::text, pg_temp.q('E3')::text])), j::text);
  perform pg_temp.su();
end $$;

-- ---- Restore -----------------------------------------------------------------------------------
do $$ declare r text; j jsonb; n int; begin
  r := pg_temp.as_who('b_admin@b.test', format('select public.restore_quote_from_shelf(%L)', pg_temp.q('E1')));
  perform pg_temp.res('another studio cannot restore it', r like '42501%', r);
  r := pg_temp.as_who('anon', format('select public.restore_quote_from_shelf(%L)', pg_temp.q('E1')));
  perform pg_temp.res('anon cannot restore', r like '42501%', r);
  update public.role_access set can_edit = false where role = 'sales' and area = 'quotes' and org_id = pg_temp.orgA();
  r := pg_temp.as_who('a_staff@a.test', format('select public.restore_quote_from_shelf(%L)', pg_temp.q('E1')));
  perform pg_temp.res('quotes view-only role cannot restore', r like '42501%', r);
  r := pg_temp.as_who('a_staff@a.test', format('select public.move_quote_to_shelf(%L, %L)', pg_temp.q('F1'), 'archive'));
  perform pg_temp.res('quotes view-only role cannot archive by hand', r like '42501%', r);
  perform pg_temp.su();
  update public.role_access set can_view = false where role = 'sales' and area = 'quotes' and org_id = pg_temp.orgA();
  update public.org_link_expiry_shelf set last_run_at = now() - interval '11 minutes' where org_id = pg_temp.orgA();
  perform pg_temp.login('a_staff@a.test');
  j := public.link_expiry_shelf_tick();
  perform pg_temp.su();
  perform pg_temp.res('a role that can''t see quotes: tick is a quiet no-op (no error, no run)',
    j->>'ran' = 'false' and (select last_run_at < now() - interval '10 minutes' from public.org_link_expiry_shelf where org_id = pg_temp.orgA()), j::text);
  update public.role_access set can_view = true, can_edit = true where role = 'sales' and area = 'quotes' and org_id = pg_temp.orgA();
  perform pg_temp.login('a_staff@a.test');
  j := public.restore_quote_from_shelf(pg_temp.q('E1'));
  perform pg_temp.res('quotes editor restores E1', j->>'restored' = 'true' and j->>'from' = 'archived', j::text);
  perform pg_temp.su();
  perform pg_temp.res('E1 is back in the normal lists with restored_at set',
    pg_temp.flag('E1') = 'active' and (select shelf_restored_at > now() - interval '1 minute' and link_expired_at is null from public.quotes where id = pg_temp.q('E1')), pg_temp.flag('E1'));
  select count(*) into n from public.audit_log where action = 'quote.restored' and quote_id = pg_temp.q('E1') and changed->>'from' = 'archived'
     and actor_email = 'a_staff@a.test';
  perform pg_temp.res('restore is audited', n = 1, n || ' rows');
  j := public.apply_link_expiry_archive(pg_temp.orgA());
  perform pg_temp.res('restored E1 is not moved again within N days (link still aged)', pg_temp.flag('E1') = 'active' and (j->>'moved')::int = 0, j::text);
  update public.quotes set shelf_restored_at = now() - interval '11 days' where id = pg_temp.q('E1');
  j := public.apply_link_expiry_archive(pg_temp.orgA());
  perform pg_temp.res('...but N days after the restore it would move again', pg_temp.flag('E1') = 'archived:link_expired', j::text);
end $$;

-- ---- Deleted mode (soft) ---------------------------------------------------------------------------
do $$ declare j jsonb; n int; begin
  perform pg_temp.login('a_admin@a.test');
  j := public.admin_set_link_expiry_shelf('delete');
  perform pg_temp.res('admin chooses Move to Deleted quotes', j->>'action' = 'delete', j::text);
  perform pg_temp.age('tE2', 30);
  perform pg_temp.login('a_staff@a.test');
  j := public.link_expiry_shelf_tick();         -- a new choice runs at the next page open
  perform pg_temp.res('changing the choice lets the next tick run at once', j->>'ran' = 'true' and (j->>'moved')::int = 1, j::text);
  perform pg_temp.su();
  perform pg_temp.res('E2 -> Deleted (soft flag)', pg_temp.flag('E2') = 'deleted:link_expired', pg_temp.flag('E2'));
  perform pg_temp.res('the deleted quote row still exists (title, client, pricing intact)',
    exists (select 1 from public.quotes where id = pg_temp.q('E2') and title = 'Expired E2'
             and client->>'name' = 'Eli' and (pricing->>'total')::numeric = 236000), 'row gone or changed');
  perform pg_temp.res('already-archived quotes are not re-filed as deleted', pg_temp.flag('E1') = 'archived:link_expired', pg_temp.flag('E1'));
  select count(*) into n from public.audit_log where action = 'quote.moved_to_deleted' and quote_id = pg_temp.q('E2') and changed->>'auto' = 'true';
  perform pg_temp.res('deleted move is audited', n = 1, n || ' rows');
  perform pg_temp.login('a_staff@a.test');
  j := public.list_quote_shelf();
  perform pg_temp.res('Deleted tab lists E2 with its count',
    (j->>'deleted_count')::int = 1 and exists (select 1 from jsonb_array_elements(j->'rows') e
      where e->>'id' = pg_temp.q('E2')::text and e->>'shelf' = 'deleted' and e->>'reason' = 'link_expired'), j::text);
  perform pg_temp.login('a_staff@a.test');
  j := public.restore_quote_from_shelf(pg_temp.q('E2'));
  perform pg_temp.res('restore from Deleted works', j->>'from' = 'deleted' and pg_temp.flag('E2') = 'active', j::text);
end $$;

-- ---- moving by hand + the 0026 guard ------------------------------------------------------------------
do $$ declare r text; j jsonb; begin
  r := pg_temp.as_who('a_staff@a.test', format('select public.move_quote_to_shelf(%L, %L)', pg_temp.q('F1'), 'delete'));
  perform pg_temp.res('sales (no delete right) cannot move to Deleted', r like '42501%', r);
  r := pg_temp.as_who('a_admin@a.test', format('select public.move_quote_to_shelf(%L, %L)', pg_temp.q('P1'), 'delete'));
  perform pg_temp.res('a quote with a payment cannot go to Deleted (0026 rule)', r like 'P0001%', r);
  r := pg_temp.as_who('a_admin@a.test', format('delete from public.quotes where id = %L', pg_temp.q('P1')));
  perform pg_temp.res('the 0026 real-delete guard still blocks a paid quote', r like 'P0001%', r);
  r := pg_temp.as_who('a_admin@a.test', format('select public.move_quote_to_shelf(%L, %L)', pg_temp.q('F1'), 'delete'));
  perform pg_temp.res('admin moves an unpaid quote to Deleted by hand', r = 'ok' and pg_temp.flag('F1') = 'deleted:manual', r || ' ' || pg_temp.flag('F1'));
  r := pg_temp.as_who('a_staff@a.test', format('select public.move_quote_to_shelf(%L, %L)', pg_temp.q('C1'), 'archive'));
  perform pg_temp.res('quotes editor archives a confirmed quote by hand', r = 'ok' and pg_temp.flag('C1') = 'archived:manual', r || ' ' || pg_temp.flag('C1'));
  r := pg_temp.as_who('b_admin@b.test', format('select public.move_quote_to_shelf(%L, %L)', pg_temp.q('N1'), 'archive'));
  perform pg_temp.res('another studio cannot archive it', r like '42501%' and pg_temp.flag('N1') = 'active', r);
end $$;

-- ---- auto-expire switched OFF: nothing moves even with Deleted chosen ------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.login('a_admin@a.test'); perform public.admin_set_link_autoexpire(false, 10);
  perform pg_temp.su();
  update public.quotes set shelf_restored_at = null where id = pg_temp.q('E2');
  j := public.apply_link_expiry_archive(pg_temp.orgA());
  perform pg_temp.res('auto-expire off: E2 (aged, eligible) stays put', (j->>'moved')::int = 0 and pg_temp.flag('E2') = 'active', j::text);
  perform pg_temp.res('apply_link_expiry_archive_all skips a studio that switched it off', public.apply_link_expiry_archive_all() = 0, 'moved');
end $$;

-- ---- other studio unaffected ------------------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('studio B''s aged quote never moved', pg_temp.flag('B1') = 'active', pg_temp.flag('B1'));
  perform pg_temp.res('studio A''s choice created no row for studio B',
    not exists (select 1 from public.org_link_expiry_shelf where org_id = pg_temp.orgB()), 'row for B');
  perform pg_temp.login('b_staff@b.test');
  j := public.link_expiry_shelf_tick();
  perform pg_temp.res('studio B''s tick does nothing', j->>'ran' = 'false' and pg_temp.flag('B1') = 'active', j::text);
end $$;

-- ---- catalog: grants ---------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('grants: job + candidates server-only; tick/list/restore/move/admin signed-in only',
    not has_function_privilege('authenticated', 'public.apply_link_expiry_archive(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.apply_link_expiry_archive(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.apply_link_expiry_archive(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.apply_link_expiry_archive_all()', 'execute')
    and not has_function_privilege('authenticated', 'public.link_expiry_shelf_candidates(uuid,integer)', 'execute')
    and has_function_privilege('authenticated', 'public.link_expiry_shelf_tick()', 'execute')
    and not has_function_privilege('anon', 'public.link_expiry_shelf_tick()', 'execute')
    and not has_function_privilege('anon', 'public.list_quote_shelf()', 'execute')
    and not has_function_privilege('anon', 'public.restore_quote_from_shelf(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.move_quote_to_shelf(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.admin_set_link_expiry_shelf(text)', 'execute')
    and not has_table_privilege('authenticated', 'public.org_link_expiry_shelf', 'select'), 'grant mismatch');
end $$;

select pg_temp.cleanup();
select name, result from _lx order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 66 then 'LINK-EXPIRY-ARCHIVE: ALL PASS (66/66)'
            else 'LINK-EXPIRY-ARCHIVE: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/66 ran' end from _lx;
