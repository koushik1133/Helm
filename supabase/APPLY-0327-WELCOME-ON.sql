-- APPLY-0327-WELCOME-ON.sql - R119: switch welcome e-mails ON (run AFTER APPLY-0327.sql and the comms-dispatch redeploy).
-- What happens next: within one comms-dispatch run (a few minutes) every welcome queued in the LAST 48 HOURS that still
-- passes the checks (studio exists, trial not ended, person still a member, one owner welcome per studio) is e-mailed
-- through the same mailer as invitations and trial reminders. Nothing older than 48 hours is ever sent.
-- Free-trial studios get the free-trial welcome (8 days, sample data, nothing sent to clients, limits, read-only after).
-- TO SWITCH OFF AGAIN (takes effect on the next run, nothing to redeploy):
--   update public.helm_welcome_mail_settings set enabled = false, updated_at = now() where id;
-- Changes one setting row only. Safe to run twice.
begin;
do $$ begin
  if to_regprocedure('public.welcome_email_switch()') is null or to_regclass('public.helm_welcome_mail_settings') is null then
    raise exception 'STOP: run APPLY-0327.sql first'; end if;
end $$;
update public.helm_welcome_mail_settings set enabled = true, updated_at = now() where id;
commit;

-- VERIFY (ok must be true)
select item, ok from (values
  ('01 welcome e-mails are switched ON', public.welcome_email_switch()),
  ('02 info: welcomes waiting (queued in the last 48 hours, not sent yet)',
     (select count(*) from public.welcome_email_outbox w where w.sent_at is null and w.created_at >= now() - interval '48 hours') >= 0)
) v(item, ok);
