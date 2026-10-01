-- ============================================================================
-- tenant-attack.sql — Org A vs Org B hostile matrix for F2 (portal/proposal org
-- match) + G4 (quote<->org reject trigger). Requires 0004 + fixtures.
-- Prints one row per case; 'PASS' = cross-tenant action correctly blocked / no leak.
-- ============================================================================
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _t; create temp table _t(n int, name text, result text);
grant all on _t to anon, authenticated;

-- A1: G4 — B staff plants a published proposal on A's quote (direct insert) -> REJECTED
do $$ begin
  begin
    perform auth.login_as((select id from auth.users where email='b_staff@b.test'));
    insert into public.event_proposal(quote_id,org_id,published,share_token,palette,images,scope,concept,updated_at)
      values ('a0000000-0000-4000-8000-00000000da01','b0000000-0000-4000-8000-000000000001',true,
              'c0000000-0000-4000-8000-0000000000c1','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'LEAK-B',now());
    insert into _t values (1,'G4: B plants proposal on A quote (direct)','FAIL: allowed');
  exception when others then insert into _t values (1,'G4: B plants proposal on A quote (direct)','PASS: rejected ('||sqlerrm||')');
  end; perform auth.logout();
end $$;

-- A2: G4 — B staff plants an event_task on A's quote -> REJECTED
do $$ begin
  begin
    perform auth.login_as((select id from auth.users where email='b_staff@b.test'));
    insert into public.event_tasks(quote_id,org_id,category,title,seq,status)
      values ('a0000000-0000-4000-8000-00000000da01','b0000000-0000-4000-8000-000000000001','x','PLANT',1,'todo');
    insert into _t values (2,'G4: B plants event_task on A quote','FAIL: allowed');
  exception when others then insert into _t values (2,'G4: B plants event_task on A quote','PASS: rejected ('||sqlerrm||')');
  end; perform auth.logout();
end $$;

-- A3: F2 defense-in-depth — even if a cross-org proposal EXISTS (inserted with G4
--     disabled, simulating pre-fix data), the public portal must NOT leak it.
do $$ declare leaked text; begin
  alter table public.event_proposal disable trigger zz_quote_org_match;
  insert into public.event_proposal(quote_id,org_id,published,share_token,palette,images,scope,concept,updated_at)
    values ('a0000000-0000-4000-8000-00000000da01','b0000000-0000-4000-8000-000000000001',true,
            'c0000000-0000-4000-8000-0000000000c3','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'LEAK-B-DID',now());
  alter table public.event_proposal enable trigger zz_quote_org_match;
  leaked := (public.public_get_portal('a0000000-0000-4000-8000-0000000000aa'::uuid))->'proposal'->>'concept';
  if leaked is null then insert into _t values (3,'F2: portal hides cross-org proposal','PASS: no leak (null)');
  else insert into _t values (3,'F2: portal hides cross-org proposal','FAIL: leaked '||leaked); end if;
  delete from public.event_proposal where share_token='c0000000-0000-4000-8000-0000000000c3';
end $$;

-- A4: no-regression — a legitimate SAME-ORG proposal is still shown by the portal
do $$ declare shown text; begin
  insert into public.event_proposal(quote_id,org_id,published,share_token,palette,images,scope,concept,updated_at)
    values ('a0000000-0000-4000-8000-00000000da01','a0000000-0000-4000-8000-000000000001',true,
            'c0000000-0000-4000-8000-0000000000c4','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'LEGIT-A',now())
    on conflict (quote_id) do update set published=true, concept='LEGIT-A', org_id='a0000000-0000-4000-8000-000000000001';
  shown := (public.public_get_portal('a0000000-0000-4000-8000-0000000000aa'::uuid))->'proposal'->>'concept';
  if shown = 'LEGIT-A' then insert into _t values (4,'F2 no-regression: same-org proposal shown','PASS: shows LEGIT-A');
  else insert into _t values (4,'F2 no-regression: same-org proposal shown','FAIL: got '||coalesce(shown,'null')); end if;
end $$;

select n,name,result from _t order by n;
select case when count(*) filter (where result like 'FAIL%')=0 then 'TENANT-ATTACK: ALL PASS' else 'TENANT-ATTACK: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _t;
