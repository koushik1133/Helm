-- ════════════════════════════════════════════════════════════════════════════
-- HELM — PRECHECK before Phases 7-9 + login hardening (0026-0028) — READ-ONLY
-- Changes NOTHING. Run on staging AND production, send me both result tables.
--   1) Are the 4 database functions we replace in full the versions we expect?
--   2) How many existing rows would fail the 80 new data rules (amounts, lengths,
--      phone/email shape)? Old rows are never touched, but such a row would refuse
--      its NEXT edit until corrected — so we want to see them first.
--   3) Which upload (storage) write rules exist today?
-- ════════════════════════════════════════════════════════════════════════════
with fp(name, expected) as (values
  ('request_otp',                    array['89d128bfbfb989efb8042cdffbc6d58b']),
  ('verify_and_consent',             array['a0d7bf970ee9cc86d90cf609cb327621','eca92460964599bc9065be7f036540df']),
  ('admin_create_user_temp',         array['35c47faca737b085db31fbc593e45ea3']),
  ('clear_password_change_required', array['908967ab325d5f4d8c9e59b86d9c5b4f'])
),
f as (
  select fp.name, (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = fp.name limit 1) as actual, fp.expected
    from fp
),
nv as (
  select 'chair_types_price_finite_chk' as rule, 'chair_types' as tbl, count(*) as rows_failing from chair_types where not coalesce((((price >= (0)::numeric) AND (price < '1000000000000'::numeric))), true)
  union all
  select 'change_requests_cost_delta_finite_chk' as rule, 'change_requests' as tbl, count(*) as rows_failing from change_requests where not coalesce((((cost_delta > '-1000000000000'::numeric) AND (cost_delta < '1000000000000'::numeric))), true)
  union all
  select 'change_requests_detail_len_chk' as rule, 'change_requests' as tbl, count(*) as rows_failing from change_requests where not coalesce(((char_length(detail) <= 20000)), true)
  union all
  select 'change_requests_price_delta_finite_chk' as rule, 'change_requests' as tbl, count(*) as rows_failing from change_requests where not coalesce((((price_delta > '-1000000000000'::numeric) AND (price_delta < '1000000000000'::numeric))), true)
  union all
  select 'change_requests_title_len_chk' as rule, 'change_requests' as tbl, count(*) as rows_failing from change_requests where not coalesce(((char_length(title) <= 500)), true)
  union all
  select 'chat_messages_body_len_chk' as rule, 'chat_messages' as tbl, count(*) as rows_failing from chat_messages where not coalesce(((char_length(body) <= 10000)), true)
  union all
  select 'coupons_code_len_chk' as rule, 'coupons' as tbl, count(*) as rows_failing from coupons where not coalesce(((char_length(code) <= 64)), true)
  union all
  select 'coupons_value_finite_chk' as rule, 'coupons' as tbl, count(*) as rows_failing from coupons where not coalesce((((value >= (0)::numeric) AND (value < '1000000000000'::numeric))), true)
  union all
  select 'crew_members_day_rate_finite_chk' as rule, 'crew_members' as tbl, count(*) as rows_failing from crew_members where not coalesce((((day_rate >= (0)::numeric) AND (day_rate < '1000000000000'::numeric))), true)
  union all
  select 'crew_members_email_len_chk' as rule, 'crew_members' as tbl, count(*) as rows_failing from crew_members where not coalesce(((char_length(email) <= 320)), true)
  union all
  select 'crew_members_name_len_chk' as rule, 'crew_members' as tbl, count(*) as rows_failing from crew_members where not coalesce(((char_length(name) <= 300)), true)
  union all
  select 'crew_members_notes_len_chk' as rule, 'crew_members' as tbl, count(*) as rows_failing from crew_members where not coalesce(((char_length(notes) <= 20000)), true)
  union all
  select 'crew_members_phone_len_chk' as rule, 'crew_members' as tbl, count(*) as rows_failing from crew_members where not coalesce(((char_length(phone) <= 40)), true)
  union all
  select 'event_attendees_email_len_chk' as rule, 'event_attendees' as tbl, count(*) as rows_failing from event_attendees where not coalesce(((char_length(email) <= 320)), true)
  union all
  select 'event_attendees_name_len_chk' as rule, 'event_attendees' as tbl, count(*) as rows_failing from event_attendees where not coalesce(((char_length(name) <= 300)), true)
  union all
  select 'event_costs_actual_finite_chk' as rule, 'event_costs' as tbl, count(*) as rows_failing from event_costs where not coalesce((((actual >= (0)::numeric) AND (actual < '1000000000000'::numeric))), true)
  union all
  select 'event_costs_description_len_chk' as rule, 'event_costs' as tbl, count(*) as rows_failing from event_costs where not coalesce(((char_length(description) <= 5000)), true)
  union all
  select 'event_costs_estimated_finite_chk' as rule, 'event_costs' as tbl, count(*) as rows_failing from event_costs where not coalesce((((estimated >= (0)::numeric) AND (estimated < '1000000000000'::numeric))), true)
  union all
  select 'event_costs_note_len_chk' as rule, 'event_costs' as tbl, count(*) as rows_failing from event_costs where not coalesce(((char_length(note) <= 5000)), true)
  union all
  select 'event_discovery_budget_max_finite_chk' as rule, 'event_discovery' as tbl, count(*) as rows_failing from event_discovery where not coalesce((((budget_max >= (0)::numeric) AND (budget_max < '1000000000000'::numeric))), true)
  union all
  select 'event_discovery_budget_min_finite_chk' as rule, 'event_discovery' as tbl, count(*) as rows_failing from event_discovery where not coalesce((((budget_min >= (0)::numeric) AND (budget_min < '1000000000000'::numeric))), true)
  union all
  select 'event_files_filename_safe' as rule, 'event_files' as tbl, count(*) as rows_failing from event_files where not coalesce(((((char_length(filename) >= 1) AND (char_length(filename) <= 255)) AND (filename !~ '[[:cntrl:]]'::text))), true)
  union all
  select 'event_files_path_in_event' as rule, 'event_files' as tbl, count(*) as rows_failing from event_files where not coalesce(((storage_path ~~ ((((org_id)::text || '/'::text) || (quote_id)::text) || '/%'::text))), true)
  union all
  select 'event_issues_detail_len_chk' as rule, 'event_issues' as tbl, count(*) as rows_failing from event_issues where not coalesce(((char_length(detail) <= 20000)), true)
  union all
  select 'event_issues_title_len_chk' as rule, 'event_issues' as tbl, count(*) as rows_failing from event_issues where not coalesce(((char_length(title) <= 500)), true)
  union all
  select 'event_menu_items_qty_finite_chk' as rule, 'event_menu_items' as tbl, count(*) as rows_failing from event_menu_items where not coalesce((((qty >= (0)::numeric) AND (qty < '1000000000000'::numeric))), true)
  union all
  select 'event_plan_menu_plate_price_finite_chk' as rule, 'event_plan' as tbl, count(*) as rows_failing from event_plan where not coalesce((((menu_plate_price >= (0)::numeric) AND (menu_plate_price < '1000000000000'::numeric))), true)
  union all
  select 'event_refunds_amount_finite_chk' as rule, 'event_refunds' as tbl, count(*) as rows_failing from event_refunds where not coalesce((((amount >= (0)::numeric) AND (amount < '1000000000000'::numeric))), true)
  union all
  select 'event_refunds_note_len_chk' as rule, 'event_refunds' as tbl, count(*) as rows_failing from event_refunds where not coalesce(((char_length(note) <= 5000)), true)
  union all
  select 'event_refunds_reason_len_chk' as rule, 'event_refunds' as tbl, count(*) as rows_failing from event_refunds where not coalesce(((char_length(reason) <= 5000)), true)
  union all
  select 'event_resource_needs_qty_finite_chk' as rule, 'event_resource_needs' as tbl, count(*) as rows_failing from event_resource_needs where not coalesce((((qty >= (0)::numeric) AND (qty < '1000000000000'::numeric))), true)
  union all
  select 'event_resources_advance_finite_chk' as rule, 'event_resources' as tbl, count(*) as rows_failing from event_resources where not coalesce((((advance >= (0)::numeric) AND (advance < '1000000000000'::numeric))), true)
  union all
  select 'event_resources_cost_finite_chk' as rule, 'event_resources' as tbl, count(*) as rows_failing from event_resources where not coalesce((((cost >= (0)::numeric) AND (cost < '1000000000000'::numeric))), true)
  union all
  select 'event_resources_label_len_chk' as rule, 'event_resources' as tbl, count(*) as rows_failing from event_resources where not coalesce(((char_length(label) <= 500)), true)
  union all
  select 'event_resources_note_len_chk' as rule, 'event_resources' as tbl, count(*) as rows_failing from event_resources where not coalesce(((char_length(note) <= 20000)), true)
  union all
  select 'event_resources_qty_finite_chk' as rule, 'event_resources' as tbl, count(*) as rows_failing from event_resources where not coalesce((((qty >= (0)::numeric) AND (qty < '1000000000000'::numeric))), true)
  union all
  select 'event_sites_photos_max' as rule, 'event_sites' as tbl, count(*) as rows_failing from event_sites where not coalesce((((jsonb_typeof((data -> 'photos'::text)) IS DISTINCT FROM 'array'::text) OR (jsonb_array_length((data -> 'photos'::text)) <= 60))), true)
  union all
  select 'event_stock_requests_qty_finite_chk' as rule, 'event_stock_requests' as tbl, count(*) as rows_failing from event_stock_requests where not coalesce((((qty >= (0)::numeric) AND (qty < '1000000000000'::numeric))), true)
  union all
  select 'event_tasks_assignee_name_len_chk' as rule, 'event_tasks' as tbl, count(*) as rows_failing from event_tasks where not coalesce(((char_length(assignee_name) <= 300)), true)
  union all
  select 'event_tasks_assignee_phone_len_chk' as rule, 'event_tasks' as tbl, count(*) as rows_failing from event_tasks where not coalesce(((char_length(assignee_phone) <= 40)), true)
  union all
  select 'event_tasks_note_len_chk' as rule, 'event_tasks' as tbl, count(*) as rows_failing from event_tasks where not coalesce(((char_length(note) <= 20000)), true)
  union all
  select 'event_tasks_title_len_chk' as rule, 'event_tasks' as tbl, count(*) as rows_failing from event_tasks where not coalesce(((char_length(title) <= 500)), true)
  union all
  select 'expense_claims_amount_finite_chk' as rule, 'expense_claims' as tbl, count(*) as rows_failing from expense_claims where not coalesce((((amount >= (0)::numeric) AND (amount < '1000000000000'::numeric))), true)
  union all
  select 'expense_claims_description_len_chk' as rule, 'expense_claims' as tbl, count(*) as rows_failing from expense_claims where not coalesce(((char_length(description) <= 5000)), true)
  union all
  select 'expense_claims_who_len_chk' as rule, 'expense_claims' as tbl, count(*) as rows_failing from expense_claims where not coalesce(((char_length(who) <= 300)), true)
  union all
  select 'inventory_checkouts_qty_in_finite_chk' as rule, 'inventory_checkouts' as tbl, count(*) as rows_failing from inventory_checkouts where not coalesce((((qty_in >= (0)::numeric) AND (qty_in < '1000000000000'::numeric))), true)
  union all
  select 'inventory_checkouts_qty_out_finite_chk' as rule, 'inventory_checkouts' as tbl, count(*) as rows_failing from inventory_checkouts where not coalesce((((qty_out >= (0)::numeric) AND (qty_out < '1000000000000'::numeric))), true)
  union all
  select 'inventory_items_name_len_chk' as rule, 'inventory_items' as tbl, count(*) as rows_failing from inventory_items where not coalesce(((char_length(name) <= 300)), true)
  union all
  select 'inventory_items_notes_len_chk' as rule, 'inventory_items' as tbl, count(*) as rows_failing from inventory_items where not coalesce(((char_length(notes) <= 20000)), true)
  union all
  select 'inventory_items_total_qty_finite_chk' as rule, 'inventory_items' as tbl, count(*) as rows_failing from inventory_items where not coalesce((((total_qty >= (0)::numeric) AND (total_qty < '1000000000000'::numeric))), true)
  union all
  select 'inventory_items_unit_cost_finite_chk' as rule, 'inventory_items' as tbl, count(*) as rows_failing from inventory_items where not coalesce((((unit_cost >= (0)::numeric) AND (unit_cost < '1000000000000'::numeric))), true)
  union all
  select 'inventory_reservations_qty_finite_chk' as rule, 'inventory_reservations' as tbl, count(*) as rows_failing from inventory_reservations where not coalesce((((qty >= (0)::numeric) AND (qty < '1000000000000'::numeric))), true)
  union all
  select 'leads_budget_finite_chk' as rule, 'leads' as tbl, count(*) as rows_failing from leads where not coalesce((((budget >= (0)::numeric) AND (budget < '1000000000000'::numeric))), true)
  union all
  select 'leads_email_len_chk' as rule, 'leads' as tbl, count(*) as rows_failing from leads where not coalesce(((char_length(email) <= 320)), true)
  union all
  select 'leads_name_len_chk' as rule, 'leads' as tbl, count(*) as rows_failing from leads where not coalesce(((char_length(name) <= 300)), true)
  union all
  select 'leads_notes_len_chk' as rule, 'leads' as tbl, count(*) as rows_failing from leads where not coalesce(((char_length(notes) <= 20000)), true)
  union all
  select 'leads_phone_len_chk' as rule, 'leads' as tbl, count(*) as rows_failing from leads where not coalesce(((char_length(phone) <= 40)), true)
  union all
  select 'menu_templates_price_per_plate_finite_chk' as rule, 'menu_templates' as tbl, count(*) as rows_failing from menu_templates where not coalesce((((price_per_plate >= (0)::numeric) AND (price_per_plate < '1000000000000'::numeric))), true)
  union all
  select 'notifications_channel_check' as rule, 'notifications' as tbl, count(*) as rows_failing from notifications where not coalesce(((channel = ANY (ARRAY['sms'::text, 'email'::text, 'in_app'::text, 'whatsapp'::text]))), true)
  union all
  select 'nurture_email_len_chk' as rule, 'nurture' as tbl, count(*) as rows_failing from nurture where not coalesce(((char_length(email) <= 320)), true)
  union all
  select 'nurture_name_len_chk' as rule, 'nurture' as tbl, count(*) as rows_failing from nurture where not coalesce(((char_length(name) <= 300)), true)
  union all
  select 'nurture_note_len_chk' as rule, 'nurture' as tbl, count(*) as rows_failing from nurture where not coalesce(((char_length(note) <= 20000)), true)
  union all
  select 'nurture_phone_len_chk' as rule, 'nurture' as tbl, count(*) as rows_failing from nurture where not coalesce(((char_length(phone) <= 40)), true)
  union all
  select 'payment_milestones_amount_finite_chk' as rule, 'payment_milestones' as tbl, count(*) as rows_failing from payment_milestones where not coalesce((((amount >= (0)::numeric) AND (amount < '1000000000000'::numeric))), true)
  union all
  select 'payment_milestones_label_len_chk' as rule, 'payment_milestones' as tbl, count(*) as rows_failing from payment_milestones where not coalesce(((char_length(label) <= 300)), true)
  union all
  select 'payment_milestones_note_len_chk' as rule, 'payment_milestones' as tbl, count(*) as rows_failing from payment_milestones where not coalesce(((char_length(note) <= 5000)), true)
  union all
  select 'plate_types_price_finite_chk' as rule, 'plate_types' as tbl, count(*) as rows_failing from plate_types where not coalesce((((price >= (0)::numeric) AND (price < '1000000000000'::numeric))), true)
  union all
  select 'quotation_versions_total_finite_chk' as rule, 'quotation_versions' as tbl, count(*) as rows_failing from quotation_versions where not coalesce((((total >= (0)::numeric) AND (total < '1000000000000'::numeric))), true)
  union all
  select 'quote_consents_client_name_len_chk' as rule, 'quote_consents' as tbl, count(*) as rows_failing from quote_consents where not coalesce(((char_length(client_name) <= 300)), true)
  union all
  select 'quote_consents_consent_text_len_chk' as rule, 'quote_consents' as tbl, count(*) as rows_failing from quote_consents where not coalesce(((char_length(consent_text) <= 20000)), true)
  union all
  select 'quote_consents_phone_len_chk' as rule, 'quote_consents' as tbl, count(*) as rows_failing from quote_consents where not coalesce(((char_length(phone) <= 40)), true)
  union all
  select 'quote_consents_terms_version_len_chk' as rule, 'quote_consents' as tbl, count(*) as rows_failing from quote_consents where not coalesce(((char_length(terms_version) <= 64)), true)
  union all
  select 'quote_consents_user_agent_len_chk' as rule, 'quote_consents' as tbl, count(*) as rows_failing from quote_consents where not coalesce(((char_length(user_agent) <= 1000)), true)
  union all
  select 'quote_payments_amount_finite_chk' as rule, 'quote_payments' as tbl, count(*) as rows_failing from quote_payments where not coalesce((((amount >= (0)::numeric) AND (amount < '1000000000000'::numeric))), true)
  union all
  select 'quotes_client_size_chk' as rule, 'quotes' as tbl, count(*) as rows_failing from quotes where not coalesce((((client IS NULL) OR (octet_length((client)::text) <= 20000))), true)
  union all
  select 'quotes_title_len_chk' as rule, 'quotes' as tbl, count(*) as rows_failing from quotes where not coalesce(((char_length(title) <= 300)), true)
  union all
  select 'vendors_email_len_chk' as rule, 'vendors' as tbl, count(*) as rows_failing from vendors where not coalesce(((char_length(email) <= 320)), true)
  union all
  select 'vendors_name_len_chk' as rule, 'vendors' as tbl, count(*) as rows_failing from vendors where not coalesce(((char_length(name) <= 300)), true)
  union all
  select 'vendors_notes_len_chk' as rule, 'vendors' as tbl, count(*) as rows_failing from vendors where not coalesce(((char_length(notes) <= 20000)), true)
  union all
  select 'vendors_phone_len_chk' as rule, 'vendors' as tbl, count(*) as rows_failing from vendors where not coalesce(((char_length(phone) <= 40)), true)
)
select 1 as sort, '1 function ' || name as item, coalesce(actual, '(missing)') as detail,
       case when actual = any(expected) then 'ok' when actual is null then 'ok (not installed)' else 'DIFFERENT — send me' end as status
  from f
union all
select 2, '2 rows failing new rules (total)', coalesce(sum(rows_failing),0)::text,
       case when coalesce(sum(rows_failing),0) = 0 then 'ok' else 'LOOK — see rows below' end
  from nv
union all
select 3, '2   ' || rule || ' (' || tbl || ')', rows_failing::text, 'LOOK'
  from nv where rows_failing > 0
union all
select 4, '3 upload write rule: ' || policyname, cmd || ' / ' || array_to_string(roles, ','), 'info'
  from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('INSERT','UPDATE','DELETE','ALL')
order by 1, 2;
