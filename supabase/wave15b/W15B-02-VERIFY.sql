-- W15B-02-VERIFY.sql — run on STAGING AFTER the UPGRADE. Read-only assertions.
-- Proves the server is now authoritative for the SHIPPING payload shape and that
-- the client-supplied total/computed are ignored. STAGING ONLY.
\set ON_ERROR_STOP on

do $$
declare v numeric;
begin
  -- 1. Shipping payload: 100 chairs*1000 + 100 plates*1000 = 200000, +18% GST = 236000.
  --    Client total (1) and computed (200000/1) must be IGNORED.
  v := public.helm_quote_total('{"chairs":100,"chairPrice":1000,"guests":100,"platePrice":1000,
        "serviceChargePct":0,"discount":0,"discountPct":0,"gstPct":18,
        "catering":{"mode":"inhouse","amount":0},"computed":{"subtotal":5,"total":1},"total":1}'::jsonb);
  if v <> 236000 then raise exception 'FAIL shipping recompute: got %, want 236000', v; end if;

  -- 2. Service charge 10%% then 18%% GST: preSvc 100000, svc 10000, subtotal 110000, gst 19800 => 129800.
  v := public.helm_quote_total('{"chairs":100,"chairPrice":1000,"guests":0,"platePrice":0,
        "serviceChargePct":10,"discount":0,"discountPct":0,"gstPct":18,
        "catering":{"mode":"inhouse","amount":0},"total":1}'::jsonb);
  if v <> 129800 then raise exception 'FAIL svc-charge case: got %, want 129800', v; end if;

  -- 3. Client catering suppresses plates+amount: only chairs 50*1000=50000, +18%% = 59000.
  v := public.helm_quote_total('{"chairs":50,"chairPrice":1000,"guests":999,"platePrice":2500,
        "serviceChargePct":0,"discount":0,"discountPct":0,"gstPct":18,
        "catering":{"mode":"client","amount":99999},"total":1}'::jsonb);
  if v <> 59000 then raise exception 'FAIL client-cater case: got %, want 59000', v; end if;

  -- 4. Legacy top-level subtotal path unchanged: 200000 +18%% = 236000.
  v := public.helm_quote_total('{"subtotal":200000,"discount":0,"gstPct":18,"total":1}'::jsonb);
  if v <> 236000 then raise exception 'FAIL legacy path: got %, want 236000', v; end if;

  raise notice 'W15B VERIFY PASS — server pricing authority holds for shipping + legacy payloads';
end $$;
