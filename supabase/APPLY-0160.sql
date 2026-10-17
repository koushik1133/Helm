-- APPLY-0160.sql - paste into the Supabase SQL editor (staging first, then prod).
-- Additive + idempotent: re-issues ONE read-only function (client_timeline). No table, column or row is created, changed or deleted. Safe to run twice.
begin;
-- 0160_client_due_confirmed_only.sql - CANONICAL forward-only. Client page money + stage label.
--
-- In plain words (client.html, the client 360 page, reads client_timeline):
--   * "Due" now counts ONLY confirmed events: for each confirmed event, invoice total minus what was
--     paid (never below 0), invoice total = quote total + APPROVED change orders - the same balance
--     the event's settlement page shows. A quote the client has not booked yet owes nothing, so it
--     no longer inflates "Due". (Before: every matched quote's total minus all payments.)
--     totals.by_currency[].due follows the same rule. "Quoted" and "Paid" are unchanged.
--   * The "Status now: ..." timeline row and the client status said "quote" for a confirmed event
--     whose lifecycle stage was never moved off "quote"; it now reads "confirmed" (the event page
--     already treats such an event as confirmed).
--
-- Additive + idempotent: create or replace of ONE read-only function, same signature, same
-- security definer / empty search_path / access checks / grants. NO table, column or row is
-- created, changed or deleted. Needs 0094 (and 0062/0068, phase12 change_requests). Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.client_timeline(uuid,integer)') is null then raise exception '0160: apply 0062/0068/0094 first (client_timeline missing)'; end if;
  if to_regclass('public.change_requests') is null then raise exception '0160: change_requests table missing (phase12)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'currency') then
    raise exception '0160: apply 0089 + 0091 first (quotes.currency missing)';
  end if;
end $$;

create or replace function public.client_timeline(p_ref uuid, p_limit integer default 300)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_role text;
  v_leads boolean; v_quotes boolean; v_fin boolean; v_media boolean; v_staff boolean;
  v_name text; v_phone text; v_email text; v_digits text; v_lname text;
  v_lead_ids uuid[] := '{}'; v_quote_ids uuid[] := '{}'; v_lim int;
  v_items jsonb := '[]'::jsonb; v_rows jsonb; v_status text; v_found boolean := false;
  v_quoted numeric; v_paid numeric; v_totals jsonb := null; v_sections text[] := '{}';
  v_bycur jsonb; v_due numeric := 0;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = v_me and p.org_id = v_org;
  if not found or v_role is null or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_ref is null then raise exception 'not found' using errcode = 'P0002'; end if;

  v_leads := public.has_area('leads', 'view');
  v_quotes := public.has_area('quotes', 'view');
  v_fin := public.has_area('finance', 'view');
  v_media := public.has_area('media', 'view');
  v_staff := public.has_area('staff', 'view');
  v_lim := greatest(1, least(500, coalesce(p_limit, 300)));

  -- 1. the anchor: a lead (leads area) or an event (quotes area) of this studio
  if v_leads then
    select l.name, l.phone, l.email into v_name, v_phone, v_email
      from public.leads l where l.id = p_ref and l.org_id = v_org;
    v_found := found;
  end if;
  if not v_found and v_quotes then
    select q.client ->> 'name', q.client ->> 'phone', q.client ->> 'email' into v_name, v_phone, v_email
      from public.quotes q where q.id = p_ref and q.org_id = v_org and q.deleted_at is null;
    v_found := found;
  end if;
  if not v_found then raise exception 'not found' using errcode = 'P0002'; end if;

  v_name := nullif(btrim(coalesce(v_name, '')), '');
  v_lname := lower(v_name);
  v_digits := nullif(right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10), '');
  if char_length(coalesce(v_digits, '')) < 7 then v_digits := null; end if;
  v_email := nullif(lower(btrim(coalesce(v_email, ''))), '');

  -- 2. the same person's leads and events (own studio only)
  select coalesce(array_agg(l.id), '{}') into v_lead_ids from public.leads l
   where l.org_id = v_org and (l.id = p_ref
      or (v_digits is not null and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = v_digits)
      or (v_email is not null and lower(btrim(coalesce(l.email, ''))) = v_email)
      or (v_lname is not null and lower(btrim(coalesce(l.name, ''))) = v_lname
          and (v_digits is null or char_length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) < 7)));
  select coalesce(array_agg(q.id), '{}') into v_quote_ids from public.quotes q
   where q.org_id = v_org and q.deleted_at is null and (q.id = p_ref
      or q.id in (select l.quote_id from public.leads l where l.org_id = v_org and l.id = any(v_lead_ids))
      or (v_digits is not null and right(regexp_replace(coalesce(q.client ->> 'phone', ''), '\D', '', 'g'), 10) = v_digits)
      or (v_email is not null and lower(btrim(coalesce(q.client ->> 'email', ''))) = v_email)
      or (v_lname is not null and lower(btrim(coalesce(q.client ->> 'name', ''))) = v_lname
          and (v_digits is null or char_length(regexp_replace(coalesce(q.client ->> 'phone', ''), '\D', '', 'g')) < 7)));
  -- events linked from a matched lead pull that lead in too
  select coalesce(array_agg(distinct x), '{}') into v_lead_ids from (
    select unnest(v_lead_ids) x union
    select l.id from public.leads l where l.org_id = v_org and l.quote_id = any(v_quote_ids)) s;

  -- 3. timeline parts, each gated by the access matrix
  if v_leads then
    v_sections := v_sections || 'leads'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'leads', 'at', l.created_at, 'id', l.id,
               'title', 'Lead added: ' || coalesce(nullif(l.name, ''), 'lead'),
               'subtitle', concat_ws(' / ', nullif(l.status, ''), nullif(l.event_type, ''), nullif(l.source, ''), to_char(l.event_date, 'YYYY-MM-DD')),
               'link', 'leads.html?hs=' ) as j
        from public.leads l where l.org_id = v_org and l.id = any(v_lead_ids)
      union all
      select jsonb_build_object('kind', 'leads', 'at', l.updated_at, 'id', l.id,
               'title', 'Lead status: ' || l.status, 'subtitle', coalesce(nullif(l.name, ''), ''),
               'link', 'leads.html?hs=')
        from public.leads l where l.org_id = v_org and l.id = any(v_lead_ids)
         and l.updated_at is not null and l.updated_at > l.created_at + interval '1 minute' and nullif(l.status, '') is not null) s;
    v_items := v_items || v_rows;
    select l.status into v_status from public.leads l where l.org_id = v_org and l.id = any(v_lead_ids)
     order by l.updated_at desc nulls last limit 1;
  end if;

  if v_quotes then
    v_sections := v_sections || 'events'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'events', 'at', q.created_at, 'id', q.id,
               'title', 'Event created: ' || coalesce(nullif(q.title, ''), q.code),
               'subtitle', concat_ws(' / ', q.code, nullif(q.event_type, ''), to_char(q.event_date, 'YYYY-MM-DD')),
               'link', 'event.html?id=' || q.id::text) as j
        from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids)
      union all
      select jsonb_build_object('kind', 'events', 'at', q.confirmed_at, 'id', q.id,
               'title', 'Event confirmed: ' || coalesce(nullif(q.title, ''), q.code),
               'subtitle', concat_ws(' / ', q.code, nullif(q.approval_status, '')),
               'link', 'event.html?id=' || q.id::text)
        from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids) and q.confirmed_at is not null
      union all
      select jsonb_build_object('kind', 'events', 'at', q.updated_at, 'id', q.id,
               'title', 'Status now: ' || case when q.status = 'confirmed' and coalesce(nullif(q.lifecycle_stage, ''), 'quote') = 'quote' then 'confirmed' else coalesce(nullif(q.lifecycle_stage, ''), q.status) end,
               'subtitle', concat_ws(' / ', q.code, nullif(q.approval_status, '')),
               'link', 'event.html?id=' || q.id::text)
        from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids)
         and q.updated_at > q.created_at + interval '1 minute'
      union all
      select jsonb_build_object('kind', 'events', 'at', v.created_at, 'id', v.id,
               'title', 'Quote version ' || v.version_no || coalesce(': ' || nullif(v.label, ''), ''),
               'subtitle', q.code, 'link', 'event.html?id=' || q.id::text)
        from public.quote_versions v join public.quotes q on q.id = v.quote_id and q.org_id = v_org
       where v.org_id = v_org and v.quote_id = any(v_quote_ids)) s;
    v_items := v_items || v_rows;
    if cardinality(v_quote_ids) > 0 then   -- the latest event's stage wins over a lead status
      select case when q.status = 'confirmed' and coalesce(nullif(q.lifecycle_stage, ''), 'quote') = 'quote' then 'confirmed' else coalesce(nullif(q.lifecycle_stage, ''), q.status) end into v_status from public.quotes q
       where q.org_id = v_org and q.id = any(v_quote_ids) order by q.updated_at desc nulls last limit 1;
    end if;
    -- 0068: same fallback as the app (store-api mapQuoteSummary / budget.summary):
    -- pricing.total, then an older top-level total column if this database has one.
    select coalesce(sum(coalesce(
             case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric end,
             case when (to_jsonb(q) ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (to_jsonb(q) ->> 'total')::numeric end,
             0)), 0) into v_quoted
      from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids);
    v_totals := jsonb_build_object('quoted', round(v_quoted, 2), 'events', cardinality(v_quote_ids));
  end if;

  if v_fin then
    v_sections := v_sections || 'payments'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'payments', 'at', coalesce(pm.paid_at, pm.created_at), 'id', pm.id,
               'title', case when pm.status = 'paid' then 'Payment received' else 'Payment ' || pm.status end
                        || coalesce(' (' || pm.receipt_no || ')', ''),
               'subtitle', concat_ws(' / ', q.code, pm.currency || ' ' || to_char(pm.amount, 'FM999999999990.00'), nullif(pm.method, '')),
               'link', 'settlement.html?quote=' || q.id::text) as j
        from public.quote_payments pm join public.quotes q on q.id = pm.quote_id and q.org_id = v_org
       where pm.org_id = v_org and pm.quote_id = any(v_quote_ids)
      union all
      select jsonb_build_object('kind', 'payments', 'at', coalesce(m.paid_at, m.created_at), 'id', m.id,
               'title', 'Milestone: ' || coalesce(nullif(m.label, ''), 'payment') || ' (' || m.status || ')',
               'subtitle', concat_ws(' / ', q.code, to_char(m.amount, 'FM999999999990.00'), 'due ' || to_char(m.due_date, 'YYYY-MM-DD')),
               'link', 'settlement.html?quote=' || q.id::text)
        from public.payment_milestones m join public.quotes q on q.id = m.quote_id and q.org_id = v_org
       where m.org_id = v_org and m.quote_id = any(v_quote_ids)) s;
    v_items := v_items || v_rows;
    -- 0068: same rule as the settlement page (store-api settlement.summary), per event:
    -- the quote_payments LEDGER when that event has any ledger row, otherwise its paid milestones.
    -- 0160: paid stays the 0068 rule (ledger when the event has any ledger row, else paid milestones);
    -- DUE = per CONFIRMED event, max(invoice total - paid, 0), invoice total = quote total + APPROVED
    -- change orders (the same balance the settlement page shows). Unconfirmed quotes owe nothing yet.
    select coalesce(sum(pd), 0), coalesce(sum(case when st = 'confirmed' then greatest(inv - pd, 0) else 0 end), 0)
      into v_paid, v_due
      from (select q.status as st, coalesce(
             case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric end,
             case when (to_jsonb(q) ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (to_jsonb(q) ->> 'total')::numeric end,
             0)
                   + coalesce((select sum(c.price_delta) from public.change_requests c
                                where c.org_id = v_org and c.quote_id = q.id and c.status = 'approved'), 0) as inv,
                   case when exists (select 1 from public.quote_payments x where x.org_id = v_org and x.quote_id = q.id)
                     then (select coalesce(sum(pm.amount), 0) from public.quote_payments pm
                            where pm.org_id = v_org and pm.quote_id = q.id and pm.status = 'paid')
                     else (select coalesce(sum(m.amount), 0) from public.payment_milestones m
                            where m.org_id = v_org and m.quote_id = q.id and m.status = 'paid') end as pd
              from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids)) s;
    v_totals := coalesce(v_totals, '{}'::jsonb) || jsonb_build_object('paid', round(v_paid, 2));
    if v_quotes then
      v_totals := v_totals || jsonb_build_object('due', round(v_due, 2));
    end if;
  end if;

  -- per-currency-0094: the same quoted / paid / due, one row per quote currency
  if v_totals is not null and cardinality(v_quote_ids) > 0 then
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('currency', cur, 'events', n,
             'quoted', case when v_quotes then round(qd, 2) end,
             'paid', case when v_fin then round(pd, 2) end,
             'due', case when v_quotes and v_fin then round(dd, 2) end)) order by cur), '[]'::jsonb) into v_bycur
      from (select cur, count(*) as n, sum(base) as qd, sum(pd) as pd,
                   sum(case when st = 'confirmed' then greatest(base + chg - pd, 0) else 0 end) as dd
              from (select coalesce(nullif(upper(btrim(q.currency)), ''), 'INR') as cur, q.status as st,
                           coalesce(
             case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric end,
             case when (to_jsonb(q) ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (to_jsonb(q) ->> 'total')::numeric end,
             0) as base,
                           coalesce((select sum(c.price_delta) from public.change_requests c
                                      where c.org_id = v_org and c.quote_id = q.id and c.status = 'approved'), 0) as chg,
                           case when exists (select 1 from public.quote_payments x where x.org_id = v_org and x.quote_id = q.id)
                             then (select coalesce(sum(pm.amount), 0) from public.quote_payments pm
                                    where pm.org_id = v_org and pm.quote_id = q.id and pm.status = 'paid')
                             else (select coalesce(sum(m.amount), 0) from public.payment_milestones m
                                    where m.org_id = v_org and m.quote_id = q.id and m.status = 'paid') end as pd
                      from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids)) e
             group by cur) s;
    v_totals := v_totals || jsonb_build_object('by_currency', v_bycur);
  end if;

  if v_quotes or v_media then
    v_sections := v_sections || 'files'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'files', 'at', f.created_at, 'id', f.id,
               'title', 'File uploaded: ' || coalesce(nullif(f.filename, ''), 'file'),
               'subtitle', q.code, 'link', 'event.html?id=' || q.id::text) as j
        from public.event_files f join public.quotes q on q.id = f.quote_id and q.org_id = v_org
       where f.org_id = v_org and f.quote_id = any(v_quote_ids)) s;
    v_items := v_items || v_rows;
  end if;

  if v_staff then
    v_sections := v_sections || 'tasks'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'tasks', 'at', coalesce(t.completed_at, t.created_at), 'id', t.id,
               'title', 'Task: ' || coalesce(nullif(t.title, ''), 'task'),
               'subtitle', concat_ws(' / ', q.code, nullif(t.status, ''), nullif(t.assignee_name, '')),
               'link', 'ops.html?quote=' || q.id::text) as j
        from public.event_tasks t join public.quotes q on q.id = t.quote_id and q.org_id = v_org
       where t.org_id = v_org and t.quote_id = any(v_quote_ids)) s;
    v_items := v_items || v_rows;
  end if;

  -- messages: only event chats the caller can already see (membership / broadcast)
  v_sections := v_sections || 'messages'::text;
  select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('kind', 'messages', 'at', m.created_at, 'id', m.id,
             'title', 'Message in ' || coalesce(nullif(c.title, ''), 'event chat'),
             'subtitle', left(case when m.kind = 'text' then coalesce(m.body, '') else '[' || coalesce(m.kind, 'media') || ']' end, 140),
             'link', 'chat.html?c=' || c.id::text) as j
      from public.chat_messages m join public.chat_conversations c on c.id = m.conversation_id and c.org_id = v_org
     where m.org_id = v_org and not coalesce(m.deleted, false) and c.quote_id = any(v_quote_ids)
       and public.chat_can_see(c.id)
     order by m.created_at desc limit 100) s;
  v_items := v_items || v_rows;

  select coalesce(jsonb_agg(e order by (e ->> 'at')::timestamptz desc nulls last), '[]'::jsonb) into v_items
    from (select e from jsonb_array_elements(v_items) e order by (e ->> 'at')::timestamptz desc nulls last limit v_lim) s;

  return jsonb_build_object(
    'client', jsonb_build_object('name', coalesce(v_name, 'Client'), 'phone', v_phone, 'email', v_email, 'status', v_status),
    'totals', v_totals, 'sections', to_jsonb(v_sections),
    'counts', jsonb_strip_nulls(jsonb_build_object('leads', case when v_leads then cardinality(v_lead_ids) end,
                                                   'events', case when v_quotes then cardinality(v_quote_ids) end)),
    'items', v_items);
end $$;

revoke all on function public.client_timeline(uuid, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.client_timeline(uuid, integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.client_timeline(uuid, integer) to authenticated'; end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- VERIFY (read-only; expect every ok = true)
select item, ok from (values
  ('01 client_timeline exists', to_regprocedure('public.client_timeline(uuid,integer)') is not null),
  ('02 still security definer + stable', coalesce((select prosecdef and provolatile = 's' from pg_proc where oid = to_regprocedure('public.client_timeline(uuid,integer)')), false)),
  ('03 due counts confirmed events only', coalesce(pg_get_functiondef(to_regprocedure('public.client_timeline(uuid,integer)')) like '%when st = ''confirmed'' then greatest(inv - pd, 0)%', false)),
  ('04 due includes approved change orders', coalesce(pg_get_functiondef(to_regprocedure('public.client_timeline(uuid,integer)')) like '%change_requests%', false)),
  ('05 Status now maps confirmed-on-stage-quote', coalesce(pg_get_functiondef(to_regprocedure('public.client_timeline(uuid,integer)')) like '%then ''confirmed'' else%', false)),
  ('06 callable by authenticated', has_function_privilege('authenticated', 'public.client_timeline(uuid,integer)', 'execute')),
  ('07 not callable by anon', not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.client_timeline(uuid,integer)', 'execute'))
) v(item, ok);
