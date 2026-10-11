-- 0107: fill BLANK birthday / anniversary greeting templates.
-- Some studios already had empty birthday / anniversary rows before 0105, and 0105 is fill-only
-- (it skips rows that exist), so those stayed blank and the automation could queue an empty greeting.
-- This only touches a row whose body is empty or whitespace. Edited text is never changed.
update public.nurture_templates t
   set body = v.body,
       subject = case when btrim(coalesce(t.subject, '')) = '' then v.subject else t.subject end,
       updated_at = now()
  from (values
    ($t$birthday$t$, $t$Happy birthday, {{name}}!$t$, $t$Hi {{name}},

Happy birthday from everyone at {{studio}}! We still smile when we think of {{last_event}}, and we hope this year brings you plenty to celebrate.

Have a lovely day.

Warm wishes,
{{studio}}$t$),
    ($t$anniversary$t$, $t$Happy anniversary, {{name}}!$t$, $t$Hi {{name}},

Happy {{years}}-year anniversary! It was a privilege to be part of {{last_event}}, and we hope the years since have been full of joy.

If you ever plan a celebration, we would be glad to help.

With love,
{{studio}}$t$)
  ) v(occasion_type, subject, body)
 where t.occasion_type = v.occasion_type
   and btrim(coalesce(t.body, '')) = '';
