-- e2e-usability-0101.sql -- 0101: insights_range ex-tax fields, public_booklet_pay_terms, public_portal_extras.
-- Two studios (A, B); token-scoped reads only. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;   -- keeps the current role
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;


do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, event_type, status, lifecycle_stage, event_date, pricing, client, org_id) values
    ('a0000000-0000-4000-8000-0000000101e1', 'E101-1', 'WED_HYD_300_28DEC26', 'wedding', 'confirmed', 'planning', '2026-12-28',
     '{"subtotal":502000,"discount":0,"gstPct":18,"total":592360}', '{"name":"Asha Rao","phone":"9000000101"}', a),
    ('a0000000-0000-4000-8000-0000000101e2', 'E101-2', 'Exempt', 'corporate', 'confirmed', 'planning', '2026-12-29',
     '{"subtotal":100000,"discount":0,"gstPct":18,"taxExempt":true,"total":100000}', '{"name":"Exempt Co","phone":"9000000102"}', a),
    ('b0000000-0000-4000-8000-0000000101f1', 'E101-B', 'B event', 'wedding', 'confirmed', 'planning', '2026-12-28',
     '{"subtotal":1000,"discount":0,"gstPct":18,"total":1180}', '{"name":"B Client","phone":"9000000109"}', b);
  update public.quotes set approval_token = 'a0000000-0000-4000-8000-0000000101aa', approval_token_revoked_at = null, approval_token_expires_at = null
   where id = 'a0000000-0000-4000-8000-0000000101e1';
  update public.quotes set approval_token = 'b0000000-0000-4000-8000-0000000101bb', approval_token_revoked_at = null, approval_token_expires_at = null
   where id = 'b0000000-0000-4000-8000-0000000101f1';
  insert into public.quote_payments(quote_id, amount, status, paid_at, receipt_no, method, org_id) values
    ('a0000000-0000-4000-8000-0000000101e1', 177708, 'paid', '2026-10-01 10:00+05:30', 'RCPT-101-1', 'upi', a),
    ('a0000000-0000-4000-8000-0000000101e1', 5000, 'failed', null, null, null, a),
    ('b0000000-0000-4000-8000-0000000101f1', 500, 'paid', '2026-10-01 10:00+05:30', 'RCPT-B', 'cash', b);
  insert into public.client_booklets(quote_id, org_id, token) values
    ('a0000000-0000-4000-8000-0000000101e1', a, 'a0000000-0000-4000-8000-0000000101cc'),
    ('b0000000-0000-4000-8000-0000000101f1', b, 'b0000000-0000-4000-8000-0000000101cc');
  -- event_sites_guard needs the studio in context (claims only, still superuser), then publish
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, false);
  insert into public.event_sites(org_id, quote_id, slug, status, data) values (a, 'a0000000-0000-4000-8000-0000000101e1', 'asha-ravi-101', 'draft', '{}');
  update public.event_sites set status = 'published', published_at = now() where slug = 'asha-ravi-101';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'b_admin@b.test'), 'role', 'authenticated')::text, false);
  insert into public.event_sites(org_id, quote_id, slug, status, data) values (b, 'b0000000-0000-4000-8000-0000000101f1', 'b-site-101', 'draft', '{}');
  update public.event_sites set status = 'published', published_at = now() where slug = 'b-site-101';
  perform pg_temp.su();
  insert into public.app_config(key, org_id, value) values ('pricing', a, '{"balanceDueDays":7,"advancePct":30}')
    on conflict do nothing;
  update public.app_config set value = value || '{"balanceDueDays":7,"advancePct":30}' where key = 'pricing' and org_id = a;
  update public.organizations set business_email = 'hello@studio-a.test', business_email_confirmed = false,
    brand = coalesce(brand, '{}'::jsonb) || '{"phone":"+91 90000 00001","billing":{"legal_name":"Secret Legal LLP"}}' where id = a;
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- E13 insights: tax / ex-tax fields beside the unchanged gross fields
do $$ declare r jsonb; m jsonb; inr jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.insights_range('2026-12-01', '2026-12-31'); m := r -> 'money';
  select x into inr from jsonb_array_elements(r -> 'money_by_currency') x where x ->> 'currency' = 'INR';
  perform pg_temp.res('01 gross revenue unchanged (incl. tax)', (m ->> 'revenue')::numeric = 692360, m::text);
  perform pg_temp.res('02 tax collected = 90360 (exempt adds 0)', (m ->> 'tax')::numeric = 90360, m::text);
  perform pg_temp.res('03 revenue_ex_tax = 602000', (m ->> 'revenue_ex_tax')::numeric = 602000, m::text);
  perform pg_temp.res('04 profit_ex_tax = profit - tax, margin on ex-tax', (m ->> 'profit_ex_tax')::numeric = (m ->> 'profit')::numeric - 90360
    and (m ->> 'margin_pct_ex_tax')::numeric = round(((m ->> 'profit')::numeric - 90360) / 602000 * 100), m::text);
  perform pg_temp.res('05 per-currency row carries the ex-tax fields', (inr ->> 'tax')::numeric = 90360 and (inr ->> 'revenue_ex_tax')::numeric = 602000, inr::text);
  perform pg_temp.su();
  perform pg_temp.res('06 tax helper: computed.totalGst used only for the same total', public._r101_quote_tax('{"gstPct":18,"computed":{"total":118,"totalGst":18}}', 118) = 18
    and public._r101_quote_tax('{"gstPct":18,"computed":{"total":999,"totalGst":500}}', 118) = 18 and public._r101_quote_tax('{"gstPct":0}', 100) = 0);
  perform pg_temp.login('b_admin@b.test');
  r := public.insights_range('2026-12-01', '2026-12-31');
  perform pg_temp.res('07 studio B tax only from its own event', (r #>> '{money,tax}')::numeric = 180, r ->> 'money');
  perform pg_temp.anon();
  perform pg_temp.res('08 anon cannot call insights / the copied body', pg_temp.try('select public.insights_range(null, null)') like '42501%'
    and pg_temp.try('select public.insights_range__pre0101(null, null)') like '42501%');
exception when others then perform pg_temp.su(); insert into _uf values ('0x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- E6 booklet pay terms
do $$ declare t jsonb; begin
  perform pg_temp.anon();
  t := public.public_booklet_pay_terms('a0000000-0000-4000-8000-0000000101cc');
  perform pg_temp.res('10 booklet terms: event date + 7 days + 30%', (t ->> 'event_date') = '2026-12-28' and (t ->> 'balance_due_days')::int = 7 and (t ->> 'advance_pct')::numeric = 30, t::text);
  perform pg_temp.res('11 booklet terms: unknown token is an invalid link', pg_temp.try('select public.public_booklet_pay_terms(''a0000000-0000-4000-8000-00000000dead'')') like '%invalid link%');
  perform pg_temp.res('12 booklet terms: B link never shows A terms', (public.public_booklet_pay_terms('b0000000-0000-4000-8000-0000000101cc') ->> 'balance_due_days') is distinct from '7');
  perform pg_temp.su();
  update public.client_booklets set revoked_at = now() where token = 'b0000000-0000-4000-8000-0000000101cc';
  update public.client_booklets set sections = sections || '{"payments":false}' where token = 'a0000000-0000-4000-8000-0000000101cc';
  perform pg_temp.anon();
  perform pg_temp.res('13 booklet terms: revoked link refused', pg_temp.try('select public.public_booklet_pay_terms(''b0000000-0000-4000-8000-0000000101cc'')') like '%invalid link%');
  perform pg_temp.res('14 booklet terms: hidden Payments section -> null', public.public_booklet_pay_terms('a0000000-0000-4000-8000-0000000101cc') is null);
  perform pg_temp.su();
  update public.client_booklets set sections = sections || '{"payments":true}' where token = 'a0000000-0000-4000-8000-0000000101cc';
exception when others then perform pg_temp.su(); insert into _uf values ('1x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- E11 portal extras
do $$ declare x jsonb; begin
  perform pg_temp.anon();
  x := public.public_portal_extras('a0000000-0000-4000-8000-0000000101aa');
  perform pg_temp.res('20 portal: live booklet link', x ->> 'booklet_token' = 'a0000000-0000-4000-8000-0000000101cc', x::text);
  perform pg_temp.res('21 portal: published invitation slug', x ->> 'invite_slug' = 'asha-ravi-101', x::text);
  perform pg_temp.res('22 portal: paid receipts only', jsonb_array_length(x -> 'receipts') = 1 and x #>> '{receipts,0,number}' = 'RCPT-101-1' and (x #>> '{receipts,0,amount}')::numeric = 177708, x::text);
  perform pg_temp.res('23 portal: studio phone, unconfirmed e-mail hidden, no billing', x #>> '{contact,phone}' = '+91 90000 00001'
    and (x -> 'contact') ? 'email' = false and position('Secret Legal' in x::text) = 0, x::text);
  perform pg_temp.res('24 portal: nothing from studio B', position('RCPT-B' in x::text) = 0 and position('b-site-101' in x::text) = 0
    and position('b0000000-0000-4000-8000-0000000101cc' in x::text) = 0, x::text);
  perform pg_temp.res('25 portal: unknown token is an invalid link', pg_temp.try('select public.public_portal_extras(''a0000000-0000-4000-8000-00000000dead'')') <> '');
  perform pg_temp.su();
  update public.organizations set business_email_confirmed = true where id = 'a0000000-0000-4000-8000-000000000001';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, false);
  update public.event_sites set status = 'unpublished' where slug = 'asha-ravi-101';
  perform pg_temp.su();
  update public.client_booklets set revoked_at = now() where token = 'a0000000-0000-4000-8000-0000000101cc';
  perform pg_temp.anon();
  x := public.public_portal_extras('a0000000-0000-4000-8000-0000000101aa');
  perform pg_temp.res('26 portal: confirmed e-mail shown', x #>> '{contact,email}' = 'hello@studio-a.test', x::text);
  perform pg_temp.res('27 portal: revoked booklet / unpublished site not linked', x -> 'booklet_token' = 'null'::jsonb and x -> 'invite_slug' = 'null'::jsonb, x::text);
  perform pg_temp.res('28 internal helpers not callable by anon', pg_temp.try('select public._r101_studio_contact(null)') like '42501%'
    and pg_temp.try('select public._r101_quote_tax(null, 1)') like '42501%');
  perform pg_temp.su();
  perform pg_temp.res('29 0101 functions are definer with empty search_path', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('insights_range', 'public_booklet_pay_terms', 'public_portal_extras', '_r101_studio_contact')
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'])));
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'E2E-USABILITY-0101: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'E2E-USABILITY-0101: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
