-- RESCORE2-PRECHECK.sql — READ-ONLY. Run on staging and production BEFORE APPLY-PENDING v9.
-- Changes nothing. Every row should say ok (row 6 is information only).
select item, coalesce(ok::text, 'n/a') as ok, detail from (values
  ('1 request_otp(uuid,text) exists',            to_regprocedure('public.request_otp(uuid,text)') is not null, ''),
  ('2 verify_and_consent (8 args) exists',       to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)') is not null, ''),
  ('3 publish_event_site(uuid,boolean) exists',  to_regprocedure('public.publish_event_site(uuid,boolean)') is not null, ''),
  ('4 storage_upload_allowed(text,text) exists', to_regprocedure('public.storage_upload_allowed(text,text)') is not null, ''),
  ('5 0026 + 0029-0031 installed',               to_regproc('public.tg_refund_maker_checker') is not null and to_regclass('public.platform_admins') is not null, ''),
  ('6 accounts still flagged must-change-password (they become read-only until they change it)', null::boolean,
     (select count(*)::text || ' account(s): ' || coalesce(string_agg(coalesce(email, id::text), ', '), '-')
        from public.profiles where must_change_password))
) v(item, ok, detail);
