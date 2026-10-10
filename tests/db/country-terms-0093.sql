-- 0093 UAE / USA approval OTP numbers. Run by scripts/db-test/run-all.sh (all edits rolled back).
begin;
set local session_replication_role = replica;   -- plain fixture edits, no stamping triggers
update public.quotes set tax_snapshot = coalesce(tax_snapshot, '{}'::jsonb) || '{"country":"AE"}', client = coalesce(client, '{}'::jsonb) || '{"phone":"050 123 4567"}'
 where id = 'a0000000-0000-4000-8000-00000000da01';
update public.quotes set tax_snapshot = coalesce(tax_snapshot, '{}'::jsonb) || '{"country":"US"}', client = coalesce(client, '{}'::jsonb) || '{"phone":"(415) 555-1234"}'
 where id = 'b0000000-0000-4000-8000-00000000da01';
update public.quotes set tax_snapshot = coalesce(tax_snapshot, '{}'::jsonb) || '{"country":"IN"}', client = coalesce(client, '{}'::jsonb) || '{"phone":"9876543210"}'
 where id = 'a0000000-0000-4000-8000-0000000052a1';
set local session_replication_role = origin;
select case when bool_and(ok) then 'COUNTRY-TERMS-0093: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'COUNTRY-TERMS-0093: FAILED ' || string_agg(item, ', ') filter (where not ok) end as result
from (values
  ('01 AE +971 typed = local on file', public._otp_canon_phone('a0000000-0000-4000-8000-0000000000aa', '+971501234567') = '050 123 4567'),
  ('02 AE other number untouched', public._otp_canon_phone('a0000000-0000-4000-8000-0000000000aa', '+971509999999') = '+971509999999'),
  ('03 US +1 typed = local on file', public._otp_canon_phone('b0000000-0000-4000-8000-0000000000bb', '+14155551234') = '(415) 555-1234'),
  ('04 India path unchanged', public._otp_canon_phone('afb0d5d3-1fd5-4b87-94cd-816cfac501a0', '+919876543210') = '+919876543210'),
  ('05 AE send-authorize gives +971 mobile', (public.otp_send_authorize('a0000000-0000-4000-8000-0000000000aa', '+971501234567') ->> 'mobile') = '971501234567'),
  ('06 US send-authorize gives +1 mobile', (public.otp_send_authorize('b0000000-0000-4000-8000-0000000000bb', '+14155551234') ->> 'mobile') = '14155551234')
) v(item, ok);
rollback;
