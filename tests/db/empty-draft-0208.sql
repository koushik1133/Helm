-- empty-draft-0208.sql -- 0208: the 0141 empty-draft clean-up really moves an EMPTY, 24h+ old draft to the
-- Deleted shelf now (quotes_deleted_reason_chk allows 'auto_empty_draft'); the check still refuses an unknown
-- reason; filled drafts and the other studio are untouched by a per-studio run; a 2nd run moves nothing more.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ed(name text, result text);
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ed values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;

do $$
declare
  org_a uuid := 'a0000000-0000-4000-8000-000000000001';
  org_b uuid := 'b0000000-0000-4000-8000-000000000001';
  qE uuid := gen_random_uuid(); qF uuid := gen_random_uuid(); qB uuid := gen_random_uuid(); qX uuid := gen_random_uuid();
  old timestamptz := now() - interval '3 days';
  e text; n int; j jsonb;
begin
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at) values
    (qE, 'ED-E', '', 'quote', '{}', '{}', 1, 'none', org_a, old, old),
    (qF, 'ED-F', 'Mehta wedding', 'quote', '{"name":"Mehta"}', '{}', 1, 'none', org_a, old, old),
    (qX, 'ED-X', '', 'quote', '{}', '{}', 1, 'none', org_a, old, old),
    (qB, 'ED-B', '', 'quote', '{}', '{}', 1, 'none', org_b, old, old);
  -- the insert triggers may stamp updated_at; make the drafts 3 days old (test-only, inside the rollback)
  set local session_replication_role = replica;
  update public.quotes set created_at = old, updated_at = old where id in (qE, qF, qX, qB);
  set local session_replication_role = origin;

  perform pg_temp.res('01 the check allows auto_empty_draft, manual, link_expired',
    exists (select 1 from pg_constraint c where c.conname = 'quotes_deleted_reason_chk' and c.conrelid = 'public.quotes'::regclass
             and c.convalidated and pg_get_constraintdef(c.oid) like '%''auto_empty_draft''%'
             and pg_get_constraintdef(c.oid) like '%''manual''%' and pg_get_constraintdef(c.oid) like '%''link_expired''%'),
    (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'quotes_deleted_reason_chk'));

  e := ''; begin update public.quotes set deleted_at = now(), deleted_reason = 'bogus' where id = qX;
  exception when others then e := sqlstate; end;
  perform pg_temp.res('02 an unknown deleted reason is still refused (23514)', e = '23514', 'got ' || coalesce(nullif(e, ''), 'no error'));

  perform pg_temp.res('03 the empty 3-day-old draft is empty for 0141', public._empty_draft_reason(qE) is null,
    coalesce(public._empty_draft_reason(qE), ''));
  perform pg_temp.res('04 a filled draft is not empty', public._empty_draft_reason(qF) is not null);

  e := ''; begin n := public._discard_empty_drafts_for(org_a, 200); exception when others then e := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.res('05 the per-studio clean-up runs without an error (it failed with 23514 before 0208)', e = '', e);
  perform pg_temp.res('06 it moved the empty drafts (2: ED-E and ED-X)', n = 2, 'moved ' || coalesce(n::text, 'null'));
  perform pg_temp.res('07 the empty draft is on the Deleted shelf as auto_empty_draft',
    exists (select 1 from public.quotes where id = qE and deleted_at is not null and deleted_reason = 'auto_empty_draft'
             and auto_discarded_at is not null and archived_at is null));
  perform pg_temp.res('08 the move is in the activity log',
    exists (select 1 from public.audit_log where quote_id = qE and action = 'quote.moved_to_deleted' and changed ->> 'reason' = 'auto_empty_draft'));
  perform pg_temp.res('09 the filled draft is untouched',
    exists (select 1 from public.quotes where id = qF and deleted_at is null and deleted_reason is null and auto_discarded_at is null));
  perform pg_temp.res('10 the other studio''s empty draft is untouched by studio A''s run',
    exists (select 1 from public.quotes where id = qB and deleted_at is null and auto_discarded_at is null));
  perform pg_temp.res('11 a 2nd run moves nothing more', public._discard_empty_drafts_for(org_a, 200) = 0);

  e := ''; begin j := public.discard_empty_drafts_all(); exception when others then e := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.res('12 the all-studios run (cron) works and moves studio B''s empty draft',
    e = '' and coalesce((j ->> 'discarded')::int, 0) >= 1
    and exists (select 1 from public.quotes where id = qB and deleted_reason = 'auto_empty_draft'), coalesce(e, '') || ' ' || coalesce(j::text, ''));
  perform pg_temp.res('13 nothing was hard-deleted', (select count(*) from public.quotes where id in (qE, qF, qX, qB)) = 4);
exception when others then insert into _ed values ('0x setup', 'FAIL: ' || sqlstate || ' ' || sqlerrm);
end $$;

select name, result from _ed order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'EMPTY-DRAFT-0208: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'EMPTY-DRAFT-0208: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _ed;
rollback;
