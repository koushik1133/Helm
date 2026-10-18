-- 0172_wa_proposal_quote_guard.sql - CANONICAL forward-only. REQUIRES 0004 (tg_quote_org_match) + 0151.
--
-- In plain words:
--   0136 put the cross-studio guard (trigger zz_quote_org_match: a row can never point at another
--   studio's event) on every table that has quote_id + org_id. 0151 then added two such tables,
--   wa_proposal_optins and wa_proposal_audit, without it. Today they are only written by 0151's
--   SECURITY DEFINER functions, which always take org_id from the quote itself, so no bad row can
--   exist; this is defence in depth so a future code path cannot write a mismatched row.
--   Re-runs the 0136 install loop: any table missing the guard (now or later) gets it.
--   Only adds missing triggers; no row, column or existing trigger is changed. Safe to run twice.
do $$ declare r record; begin
  if to_regprocedure('public.tg_quote_org_match()') is null then return; end if;
  for r in
    select c.table_name from information_schema.columns c
      join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
      join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
    where c.table_schema='public' and c.column_name='quote_id'
      and c.table_name not in ('quotes','audit_log','lead_archive')
      and not exists (select 1 from pg_trigger tg join pg_class k on k.oid=tg.tgrelid
                      where k.relnamespace='public'::regnamespace and k.relname=c.table_name
                        and tg.tgname='zz_quote_org_match')
    order by 1
  loop
    execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', r.table_name);
  end loop;
end $$;
