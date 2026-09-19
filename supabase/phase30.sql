-- =========================================================================
-- Phase 30 — Nurture automation: recurring occasions + auto greetings
--
-- WHAT this adds
--   • Recurring occasions on each nurture contact (birthday / anniversary /
--     festival / custom) with a per-contact auto-greeting switch.
--   • nurture_templates — one editable message per occasion type, with a good
--     default. Placeholders: {{name}} {{occasion}} {{years}} {{last_event}} {{studio}}.
--   • nurture_automation — a single global on/off switch (+ how many days ahead).
--   • nurture_due()  — everyone with an occasion coming up (age/years, next date,
--     whether already greeted this year).
--   • queue_nurture_greeting() — renders the template, attaches up to 3 photos
--     from that client's event gallery, and drops the message in the notification
--     outbox (channel=email, status=simulated — real send stays deferred).
--   • run_nurture_auto() — queues greetings for every due, auto-on contact; this
--     is what a daily scheduled job would call once real email is switched on.
--
-- RUN ORDER: run phase29-role-access.sql FIRST (this uses has_area('nurture')).
-- Idempotent. Real SMS/email sending is intentionally deferred.
-- =========================================================================

-- 1) extend the nurture contacts with recurrence + automation --------------
alter table public.nurture add column if not exists occasion_type text not null default 'custom';
alter table public.nurture add column if not exists recurrence    text not null default 'yearly';
alter table public.nurture add column if not exists auto_on       boolean not null default false;
alter table public.nurture add column if not exists last_greeted  date;

-- 2) editable per-occasion templates --------------------------------------
create table if not exists public.nurture_templates (
  occasion_type text primary key,
  subject       text not null,
  body          text not null,
  enabled       boolean not null default true,
  updated_at    timestamptz not null default now()
);

insert into public.nurture_templates (occasion_type, subject, body) values
 ('birthday',   'Happy Birthday, {{name}}! 🎂',
  E'Hi {{name}},\n\nHappy birthday from all of us at {{studio}}! 🎉 We were just remembering {{last_event}} — it was such a joy working with you. Wishing you a wonderful year ahead. We''ve attached a few favourite memories below.\n\nWarmly,\n{{studio}}'),
 ('anniversary','Happy Anniversary, {{name}}! 💐',
  E'Hi {{name}},\n\nHappy {{years}}-year anniversary! It feels like yesterday we were part of {{last_event}}. Thank you for letting us be part of your story — here are a few memories we still love. If you''re planning a celebration, we''d be honoured to help again.\n\nWith love,\n{{studio}}'),
 ('festival',  'Season''s greetings, {{name}}! ✨',
  E'Hi {{name}},\n\nWarmest wishes from {{studio}} this festive season. We loved being part of {{last_event}} and hope this year brings more moments worth celebrating. A few memories attached to bring a smile.\n\nBest,\n{{studio}}'),
 ('custom',    'Thinking of you, {{name}}',
  E'Hi {{name}},\n\nJust checking in from {{studio}} — we remember {{last_event}} fondly and would love to work with you again. Here are a few memories.\n\nWarmly,\n{{studio}}')
on conflict (occasion_type) do nothing;

-- 3) global automation switch (singleton row) -----------------------------
create table if not exists public.nurture_automation (
  id          int primary key default 1 check (id = 1),
  enabled     boolean not null default false,
  within_days int not null default 0,          -- send on the day (0) or N days ahead
  updated_at  timestamptz not null default now()
);
insert into public.nurture_automation (id) values (1) on conflict (id) do nothing;

-- 4) RLS on the two new tables (nurture area) ------------------------------
do $$ declare t text; p record; begin
  foreach t in array array['nurture_templates','nurture_automation'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format($f$create policy "n30 view" on public.%I for select to authenticated using ( public.has_area('nurture','view') )$f$, t);
    execute format($f$create policy "n30 ins"  on public.%I for insert to authenticated with check ( public.has_area('nurture','edit') )$f$, t);
    execute format($f$create policy "n30 upd"  on public.%I for update to authenticated using ( public.has_area('nurture','edit') ) with check ( public.has_area('nurture','edit') )$f$, t);
    execute format($f$create policy "n30 del"  on public.%I for delete to authenticated using ( public.has_area('nurture','edit') )$f$, t);
  end loop;
end $$;

-- 5) helper: the next occurrence of a yearly occasion (never errors) -------
-- adds the occasion's day-of-year offset to Jan 1 of the current year; rolls to
-- next year if it has already passed. Good enough for greetings (no leap crash).
create or replace function public._next_occasion(p_date date) returns date
  language plpgsql stable set search_path = public as $$
declare
  y int := extract(year from current_date)::int;
  m int; d int; cand date;
begin
  if p_date is null then return null; end if;
  m := extract(month from p_date)::int;
  d := extract(day from p_date)::int;
  begin cand := make_date(y, m, d); exception when others then cand := make_date(y, m, 28); end;
  if cand < current_date then
    begin cand := make_date(y + 1, m, d); exception when others then cand := make_date(y + 1, m, 28); end;
  end if;
  return cand;
end $$;

-- 6) who has an occasion coming up -----------------------------------------
create or replace function public.nurture_due(p_within_days int default 30)
  returns table(
    id uuid, name text, email text, phone text, occasion text, occasion_type text,
    occasion_date date, next_date date, years int, auto_on boolean,
    greeted_this_year boolean, quote_id uuid, last_event text
  ) language sql stable security definer set search_path = public as $$
  select n.id, n.name, n.email, n.phone, n.occasion, coalesce(n.occasion_type,'custom'),
         n.occasion_date,
         public._next_occasion(n.occasion_date) as next_date,
         (extract(year from public._next_occasion(n.occasion_date))::int
            - extract(year from n.occasion_date)::int) as years,
         n.auto_on,
         coalesce(n.last_greeted > current_date - interval '335 days', false) as greeted_this_year,
         n.quote_id,
         (select q.title from public.quotes q where q.id = n.quote_id) as last_event
  from public.nurture n
  where public.has_area('nurture','view')
    and n.occasion_date is not null
    and public._next_occasion(n.occasion_date) <= current_date + (greatest(p_within_days,0) || ' days')::interval
  order by public._next_occasion(n.occasion_date);
$$;
revoke all on function public.nurture_due(int) from anon;
grant execute on function public.nurture_due(int) to authenticated;

-- 7) render + queue one greeting (attaches gallery photos) -----------------
create or replace function public.queue_nurture_greeting(p_id uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n public.nurture; tpl public.nurture_templates; ot text;
  v_years int; v_last text; v_photos text[]; v_subject text; v_body text; v_detail jsonb;
  v_studio text := 'Blueprint Stage';
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into n from public.nurture where id = p_id;
  if not found then raise exception 'contact not found'; end if;

  ot := coalesce(n.occasion_type,'custom');
  select * into tpl from public.nurture_templates where occasion_type = ot;
  if not found then select * into tpl from public.nurture_templates where occasion_type='custom'; end if;

  v_years := coalesce(extract(year from public._next_occasion(n.occasion_date))::int
                      - extract(year from n.occasion_date)::int, 0);
  select q.title into v_last from public.quotes q where q.id = n.quote_id;
  v_last := coalesce(v_last, 'your event with us');
  select array_agg(url order by seq, created_at) into v_photos
    from (select url, seq, created_at from public.event_media
          where quote_id = n.quote_id and in_gallery = true order by seq, created_at limit 3) m;

  v_subject := replace(replace(replace(replace(replace(coalesce(tpl.subject,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);
  v_body := replace(replace(replace(replace(replace(coalesce(tpl.body,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);

  v_detail := jsonb_build_object(
    'subject', v_subject, 'body', v_body,
    'photos', to_jsonb(coalesce(v_photos, array[]::text[])),
    'occasion_type', ot, 'contact', n.name, 'auto', n.auto_on);

  perform public._notify(n.quote_id, 'email', n.email, 'nurture_'||ot, v_detail);
  update public.nurture set last_greeted = current_date where id = p_id;
  return v_detail;
end; $$;
revoke all on function public.queue_nurture_greeting(uuid) from anon;
grant execute on function public.queue_nurture_greeting(uuid) to authenticated;

-- 8) queue greetings for every due, auto-on contact (the daily job) --------
create or replace function public.run_nurture_auto(p_within_days int default null)
  returns int language plpgsql security definer set search_path = public as $$
declare a public.nurture_automation; within int; d record; cnt int := 0;
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into a from public.nurture_automation where id = 1;
  if not coalesce(a.enabled,false) then return 0; end if;
  within := coalesce(p_within_days, a.within_days, 0);
  for d in
    select nd.* from public.nurture_due(within) nd
    join public.nurture_templates t on t.occasion_type = nd.occasion_type
    where nd.auto_on = true and nd.greeted_this_year = false
      and nd.email is not null and t.enabled = true
  loop
    perform public.queue_nurture_greeting(d.id);
    cnt := cnt + 1;
  end loop;
  return cnt;
end; $$;
revoke all on function public.run_nurture_auto(int) from anon;
grant execute on function public.run_nurture_auto(int) to authenticated;

-- 9) let PostgREST see the new definitions immediately
notify pgrst, 'reload schema';

-- =========================================================================
-- GO-LIVE (deferred): to send greetings automatically every morning, once a
-- real email channel (Resend/SendGrid) is wired into a "send-email" Edge
-- Function, schedule this with pg_cron:
--   select cron.schedule('nurture-daily','0 9 * * *', $$ select public.run_nurture_auto(); $$);
-- Until then greetings queue to notifications with status='simulated'.
-- =========================================================================
