-- 0092 country-aware comms helpers (pure functions + caller wiring). Run by scripts/db-test/run-all.sh.
select case when bool_and(ok) then 'COUNTRY-TEMPLATES-0092: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'COUNTRY-TEMPLATES-0092: FAILED ' || string_agg(item, ', ') filter (where not ok) end as result
from (values
  ('01 INR money unchanged', public._comms_money(125000, 'INR') = public._comms_money(125000) and public._comms_money(125000, null) = 'Rs. 125,000'),
  ('02 AED money', public._comms_money(1234.5, 'AED') = 'AED 1,234.50'),
  ('03 USD money', public._comms_money(1234.5, 'usd') = '$1,234.50'),
  ('04 IN phone unchanged', public.helm_norm_phone_cc('9876543210', '91') = '919876543210' and public.helm_norm_phone_cc('09876543210', '91') = '919876543210'),
  ('05 AE local mobile', public.helm_norm_phone_cc('0501234567', '971') = '971501234567' and public.helm_norm_phone_cc('501234567', '971') = '971501234567'),
  ('06 AE full number kept', public.helm_norm_phone_cc('971501234567', '971') = '971501234567' and public.helm_norm_phone_cc('00971501234567', '971') = '971501234567'),
  ('07 US local + full', public.helm_norm_phone_cc('4155551234', '1') = '14155551234' and public.helm_norm_phone_cc('14155551234', '1') = '14155551234'),
  ('08 foreign number kept for AE/US', public.helm_norm_phone_cc('919876543210', '971') = '919876543210' and public.helm_norm_phone_cc('919876543210', '1') = '919876543210'),
  ('09 unknown studio is India', public._comms_country('00000000-0000-0000-0000-000000000000'::uuid) = 'IN'
       and public._comms_date('2026-10-12'::date, '00000000-0000-0000-0000-000000000000'::uuid) = '12 Oct 2026'),
  ('10 email path unchanged', public._comms_client_to('{"email":"A@b.co"}'::jsonb, 'email', null) = 'a@b.co'),
  ('11 callers use the country-aware helpers',
       pg_get_functiondef('public._comms_queue_pay(uuid, text, text, boolean, uuid)'::regprocedure) like '%_comms_client_to(q.client, ch, q.org_id)%'
   and pg_get_functiondef('public._comms_queue_pay(uuid, text, text, boolean, uuid)'::regprocedure) like '%_comms_quote_cur(q.id)%'
   and pg_get_functiondef('public.comms_tick()'::regprocedure) like '%_comms_client_to(f.client, v_ch, o.id)%'
   and pg_get_functiondef('public.payment_reminder_send_now(uuid)'::regprocedure) like '%_comms_client_to(q.client, c, v_org)%'
   and (pg_get_functiondef('public.comms_outbox_claim(integer)'::regprocedure) like '%r.channel, r.org_id)%'
        or (to_regprocedure('public.comms_outbox_claim__pre0155(integer)') is not null      -- 0155 STOP wrapper over the 0092 body
            and pg_get_functiondef('public.comms_outbox_claim__pre0155(integer)'::regprocedure) like '%r.channel, r.org_id)%'))),
  ('12 helpers not callable by anon', not has_function_privilege('anon', 'public._comms_money(numeric, text)', 'execute')
       and not has_function_privilege('anon', 'public._comms_client_to(jsonb, text, uuid)', 'execute'))
) v(item, ok);
