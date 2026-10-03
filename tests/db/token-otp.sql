-- token-otp.sql — G1 approval-token expiry + G3 OTP rate-limit (sequential).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _to; create temp table _to(name text, result text);
-- G1: expired approval token rejected by public_get_portal
update public.quotes set approval_token_expires_at = now() - interval '1 day' where id='a0000000-0000-4000-8000-00000000da01';
do $$ begin
  perform public.public_get_portal('a0000000-0000-4000-8000-0000000000aa'::uuid);
  insert into _to values ('G1 expired approval token','FAIL: accepted');
exception when others then insert into _to values ('G1 expired approval token','PASS: rejected ('||left(sqlerrm,20)||')'); end $$;
-- G1: live token works
update public.quotes set approval_token_expires_at = now() + interval '30 days' where id='a0000000-0000-4000-8000-00000000da01';
do $$ begin
  perform public.public_get_portal('a0000000-0000-4000-8000-0000000000aa'::uuid);
  insert into _to values ('G1 live approval token','PASS: accepted');
exception when others then insert into _to values ('G1 live approval token','FAIL: rejected ('||left(sqlerrm,20)||')'); end $$;
-- G3: 3 OTPs for a phone allowed, 4th rejected
delete from public.quote_otps where quote_id='a0000000-0000-4000-8000-00000000da01';
do $$ declare i int; ok int:=0; begin
  for i in 1..3 loop
    insert into public.quote_otps(quote_id,phone,code_hash,expires_at,org_id)
      values('a0000000-0000-4000-8000-00000000da01','9991112222','h',now()+interval '10 min','a0000000-0000-4000-8000-000000000001');
    ok:=ok+1;
  end loop;
  begin
    insert into public.quote_otps(quote_id,phone,code_hash,expires_at,org_id)
      values('a0000000-0000-4000-8000-00000000da01','9991112222','h',now()+interval '10 min','a0000000-0000-4000-8000-000000000001');
    insert into _to values('G3 4th OTP/phone/hour','FAIL: allowed (4 inserted)');
  exception when others then insert into _to values('G3 4th OTP/phone/hour','PASS: 4th rejected (3 allowed)'); end;
end $$;
select name,result from _to order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'TOKEN-OTP: ALL PASS' else 'TOKEN-OTP: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _to;
