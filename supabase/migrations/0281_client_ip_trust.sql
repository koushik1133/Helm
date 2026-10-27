-- 0281_client_ip_trust.sql - CANONICAL forward-only.
-- REQUIRES 0026 (tg_consent_snapshot: quote_consents.request_ip), 0069 (_pkg_req_meta: package_selections.ip_hash),
--          0269 (_r24_ip_hash: the public enquiry form limits), 0271 (_r24s_ip_hash: Contact sales + Suggestions limits).
--
-- In plain words (r31 cyber review, "make sure everything is good"):
--   Helm's database is reached through Supabase, and Supabase sits behind Cloudflare. Cloudflare writes the visitor's
--   real internet address into a header called cf-connecting-ip and REPLACES anything a visitor puts there. It does NOT
--   replace x-forwarded-for: it only adds the real address at the END of whatever the visitor already sent.
--   Four helpers read the FIRST x-forwarded-for entry - which a visitor can type themselves. So a bot sending a new
--   made-up address with every request looked like a new visitor every time and walked past the per-network limits on:
--     - the signed-out Contact sales form (8 an hour per network) and Suggestions (5 an hour per network),
--     - a studio's public enquiry form (per-network limit on enquiries and their automatic replies),
--   and could write a made-up address into the record kept when a client accepts a quote (quote_consents.request_ip)
--   and into a package choice (package_selections.ip_hash).
--   Fix: ONE new helper _r31_client_ip() reads cf-connecting-ip first (set by Cloudflare, can't be faked), and only
--   falls back to the first x-forwarded-for entry / x-real-ip when that header is missing (local tests). The four
--   helpers are re-issued with ONLY their address line changed; names, arguments, answers and privileges stay the same.
--   Hashes for ordinary visitors do not change (for them Cloudflare's address IS the first x-forwarded-for entry).
--   (0151 _wa151_ip, 0261 _lv261_req and 0277 _hq27_client_ip already read cf-connecting-ip first - not touched.)
-- Changes: 1 NEW helper function (no API access), 4 functions re-issued in place. No table, column, row or policy is
-- changed; nothing deleted. Safe to run twice. ASCII only.

-- ---- 1) the caller's address: Cloudflare's header first --------------------------------------------------------------
create or replace function public._r31_client_ip()
returns text language plpgsql stable set search_path = '' as $$
-- r31-client-ip-0281
declare h jsonb; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  if h is null then return null; end if;
  v := coalesce(nullif(btrim(coalesce(h ->> 'cf-connecting-ip', '')), ''),
                nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''),
                nullif(btrim(coalesce(h ->> 'x-real-ip', '')), ''));
  return left(v, 64);
end $$;

-- ---- 2) the public enquiry form (0269): same hash, trusted address --------------------------------------------------
create or replace function public._r24_ip_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
-- r31-client-ip-0281 (was 0269: first x-forwarded-for hop)
declare v text;
begin
  v := public._r31_client_ip();
  return case when v is null then null else encode(pg_catalog.sha256(convert_to('helm-enq:' || v, 'UTF8')), 'hex') end;
end $$;

-- ---- 3) Contact sales + Suggestions (0271): same hash, trusted address ---------------------------------------------
create or replace function public._r24s_ip_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
-- r31-client-ip-0281 (was 0271: first x-forwarded-for hop)
declare v text;
begin
  v := public._r31_client_ip();
  return case when v is null then null else encode(pg_catalog.sha256(convert_to('helm-sales:' || v, 'UTF8')), 'hex') end;
end $$;

-- ---- 4) a client's package choice (0069): same answer shape, trusted address ---------------------------------------
create or replace function public._pkg_req_meta()
returns jsonb language plpgsql stable set search_path = '' as $$
-- r31-client-ip-0281 (was 0069: first x-forwarded-for hop)
declare h jsonb; v_ip text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v_ip := coalesce(public._r31_client_ip(), '');
  return jsonb_build_object('ip_hash', case when v_ip <> '' then md5('helm-pkg:' || left(v_ip, 64)) end,
                            'ua', nullif(left(coalesce(h ->> 'user-agent', ''), 300), ''));
end $$;

-- ---- 5) the record kept when a client accepts a quote (0026): body unchanged except the address line -----------------
create or replace function public.tg_consent_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r31-client-ip-0281 (was 0026: first x-forwarded-for hop)
declare q public.quotes; v_ip text;
begin
  select * into q from public.quotes where id = new.quote_id;
  new.quote_total      := public.helm_pricing_num(q.pricing -> 'total');
  new.quote_version    := q.current_version;
  new.pricing_snapshot := q.pricing;
  new.consent_text_sha256 := case when new.consent_text is null then null
                                  else encode(sha256(convert_to(new.consent_text, 'UTF8')), 'hex') end;
  new.phone_matches_client := case
    when nullif(regexp_replace(coalesce(q.client ->> 'phone', ''), '[^0-9]', '', 'g'), '') is null
      or nullif(regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g'), '') is null then null
    else right(regexp_replace(q.client ->> 'phone', '[^0-9]', '', 'g'), 10)
       = right(regexp_replace(new.phone, '[^0-9]', '', 'g'), 10) end;
  begin
    v_ip := public._r31_client_ip();
  exception when others then v_ip := null;
  end;
  new.request_ip := left(nullif(v_ip, ''), 64);
  new.user_agent := left(new.user_agent, 1000);   -- browsers send < 1000; bound the stored copy
  return new;
end $$;

-- ---- 6) privileges: the new helper is internal only (the callers above run as the owner); the others keep theirs ----
do $$ begin
  execute 'revoke all on function public._r31_client_ip() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r31_client_ip() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r31_client_ip() from authenticated'; end if;
  execute 'revoke all on function public.tg_consent_snapshot() from public';
  execute 'revoke all on function public._r24_ip_hash() from public';
  execute 'revoke all on function public._r24s_ip_hash() from public';
  execute 'revoke all on function public._pkg_req_meta() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.tg_consent_snapshot() from anon';
    execute 'revoke all on function public._r24_ip_hash() from anon';
    execute 'revoke all on function public._r24s_ip_hash() from anon';
    execute 'revoke all on function public._pkg_req_meta() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.tg_consent_snapshot() from authenticated';
    execute 'revoke all on function public._r24_ip_hash() from authenticated';
    execute 'revoke all on function public._r24s_ip_hash() from authenticated';
    execute 'revoke all on function public._pkg_req_meta() from authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';
