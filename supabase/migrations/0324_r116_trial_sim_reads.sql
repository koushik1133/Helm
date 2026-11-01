-- 0324_r116_trial_sim_reads.sql - CANONICAL forward-only. R116: the client pages SHOW the simulated (TEST) payments of a
-- free-trial studio on their payment schedule. READ-ONLY. Additive. Safe to run twice.
--
-- In plain words:
--   In a free trial the client presses "Simulate payment" on the approval page (0323 trial_simulate_payment): a TEST row
--   goes into trial_sim_payments and NOTHING else changes (owner decision: never payment_milestones / quote_payments, so a
--   simulation can never reach P&L or closure). The client portal and booklet then still showed that payment as "due" and
--   "Received 0". This adds ONE read-only function so those pages can mark the milestone "Paid (test) - TEST-XXXXXXXX"
--   and say "Simulated received X (test, no real money)":
--
--   public_trial_sim_payments(kind, ref) - kind 'quote' (the live approval link token, as 0323 _r323_token_quote) or
--     'booklet' (a live, not revoked, not expired booklet token). Answers:
--       * unknown / malformed / expired / revoked link, deleted or cancelled quote -> null
--       * a PAID studio -> {simulation:false} (nothing else; paid studios unchanged)
--       * a trial studio (0179 _tb179_no_send) -> {simulation:true, total, currency, rows:[{milestone_id, amount,
--         currency, label, receipt, at}]} - only what the client already sees on that page (amounts + labels) plus the
--         TEST receipt reference the approval page already showed them. No names, no studio data, no write.
--
--   The studio's own pages read trial_sim_payments directly (0323 RLS: own studio select), so no studio function is added.
--   Nothing is deleted, no table / column / policy is changed, no existing function body is replaced.
--   Goes after 0065 (client_booklets) + 0179 + 0260 + 0323.

do $$ begin
  if to_regclass('public.trial_sim_payments') is null or to_regprocedure('public._r323_token_quote(uuid)') is null then
    raise exception 'STOP 0324: 0323 (trial simulation) missing - run APPLY-0323.sql first'; end if;
  if to_regclass('public.client_booklets') is null then raise exception 'STOP 0324: client_booklets missing (0065)'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception 'STOP 0324: _tb179_no_send missing - run 0179 first'; end if;
  if to_regprocedure('public._a260_quote_cancelled(uuid)') is null then raise exception 'STOP 0324: _a260_quote_cancelled missing - run 0260 first'; end if;
end $$;

create or replace function public.public_trial_sim_payments(p_kind text, p_ref text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r116-trial-sim-reads-0324: read-only; null for an unknown link; {simulation:false} for a paid studio
declare v_ref text := btrim(coalesce(p_ref, '')); v_q uuid; v_org uuid; v_cur text; v_rows jsonb; v_total numeric;
begin
  if v_ref = '' or length(v_ref) > 200 then return null; end if;
  if v_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  if p_kind = 'quote' then
    v_q := public._r323_token_quote(v_ref::uuid);
  elsif p_kind = 'booklet' then
    select b.quote_id into v_q from public.client_booklets b
     where b.token = v_ref::uuid and b.revoked_at is null and (b.expires_at is null or b.expires_at > now())
     limit 1;
  else
    return null;
  end if;
  if v_q is null or coalesce(public._a260_quote_cancelled(v_q), false) then return null; end if;
  select q.org_id, upper(coalesce(nullif(btrim(q.pricing ->> 'currency'), ''), nullif(btrim(q.currency), ''), 'INR'))
    into v_org, v_cur from public.quotes q where q.id = v_q and q.deleted_at is null;
  if v_org is null then return null; end if;
  if not coalesce(public._tb179_no_send(v_org), false) then return jsonb_build_object('simulation', false); end if;
  select coalesce(jsonb_agg(jsonb_build_object('milestone_id', s.milestone_id, 'amount', s.amount, 'currency', s.currency,
                                               'label', left(coalesce(s.label, 'Payment'), 200), 'at', s.created_at,
                                               'receipt', 'TEST-' || upper(left(replace(s.id::text, '-', ''), 8)))
                            order by s.created_at), '[]'::jsonb),
         coalesce(sum(s.amount), 0)
    into v_rows, v_total
    from public.trial_sim_payments s where s.quote_id = v_q and s.org_id = v_org and s.test_mode;
  return jsonb_build_object('simulation', true, 'test_mode', true, 'real_payment', false,
                            'currency', left(v_cur, 3), 'total', v_total, 'rows', v_rows);
end $$;

do $$ declare r text; begin
  execute 'revoke all on function public.public_trial_sim_payments(text, text) from public';
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.public_trial_sim_payments(text, text) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
