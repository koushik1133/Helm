-- 0099_pkg_payment_balance.sql - CANONICAL forward-only. Staff "payment received" WhatsApp carries the balance.
--
-- In plain words:
--   When a client pays on a package-flow event, the staff WhatsApp said only "a payment of
--   Rs50,000 was received". The sender (pkg-client-notify templates.ts) already appends
--   "Balance due: Rs2,56,800." or "Paid in full." when the payload has a `balance` - but the
--   0069 trigger never sent one (India audit #15). This re-creates that ONE trigger function so
--   the payload also carries `balance` (quote total minus the quote_payments LEDGER, the same
--   source settlement + 0098 use) and the quote's `currency`.
--
--   Balance is added only for ledger rows (quote_payments) and only when the quote total is a
--   number; for a milestone-only payment the text stays exactly as before.
--
-- Additive + idempotent: one function body replaced (same signature, same triggers, same
-- never-blocks-a-payment exception guard). NO table, NO column, NO row changed.
-- Needs 0069 (_pkg_notify / _pkg_tg_payment), 0089 (quotes.currency).
-- ============================================================================

do $$ begin
  if to_regprocedure('public._pkg_notify(uuid,text,jsonb,text)') is null then raise exception '0099: apply 0069 first (_pkg_notify missing)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'currency') then
    raise exception '0099: apply 0089 first (quotes.currency missing)';
  end if;
end $$;

create or replace function public._pkg_tg_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_detail jsonb; v_total numeric; v_paid numeric; v_cur text;
begin
  begin
    if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid')
       and exists (select 1 from public.package_selections s where s.quote_id = new.quote_id and s.status = 'accepted') then
      v_detail := jsonb_build_object('payment_id', new.id, 'amount', new.amount, 'source', tg_table_name,
                                     'path', 'settlement.html?quote=' || new.quote_id::text || '#payments');
      select case when coalesce(q.pricing->>'total', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (q.pricing->>'total')::numeric end,
             nullif(btrim(coalesce(q.currency, '')), '')
        into v_total, v_cur from public.quotes q where q.id = new.quote_id;
      if v_cur is not null then v_detail := v_detail || jsonb_build_object('currency', v_cur); end if;
      if tg_table_name = 'quote_payments' and v_total is not null then
        select coalesce(sum(p.amount), 0) into v_paid from public.quote_payments p where p.quote_id = new.quote_id and p.status = 'paid';
        v_detail := v_detail || jsonb_build_object('balance', greatest(v_total - v_paid, 0));
      end if;
      perform public._pkg_notify(new.quote_id, 'pkg_payment', v_detail, 'pay:' || tg_table_name || ':' || new.id::text);
    end if;
  exception when others then raise warning 'pkg-0099: payment notice skipped (%)', sqlstate;
  end;
  return null;
end $$;
revoke all on function public._pkg_tg_payment() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._pkg_tg_payment() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._pkg_tg_payment() from authenticated; end if;
end $$;
