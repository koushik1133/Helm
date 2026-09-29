-- ============================================================================
-- WAVE-10-PROD-UPGRADE.sql   (PRODUCTION — run ONLY after: explicit authorization
-- + WAVE-10-PROD-PREFLIGHT.sql PASS + a fresh DB backup/snapshot.)
-- ----------------------------------------------------------------------------
-- Contains ONLY the two staging-proven security fixes. NOTHING else — no
-- event_sites, no indexes, no pricing, no schema/data changes, no other funcs.
--   W10-D1: verify_and_consent — persistent failed-attempt lockout (soft-return).
--           REQUIRES the matching frontend (public/approve.html checks r.approved)
--           to be DEPLOYED FIRST; it is backward-compatible with the old version.
--   W10-D2: public_get_portal — enforce approval_token_expires_at.
-- Idempotent (CREATE OR REPLACE). Run WAVE-10-PROD-VERIFY.sql afterwards.
-- ============================================================================
begin;

-- ---- W10-D1: OTP attempt-limit now enforced (soft-return, no rollback) -------
CREATE OR REPLACE FUNCTION public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q public.quotes; rec public.quote_otps;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;   -- structural: keep as raise
  select * into rec from public.quote_otps
    where quote_id=q.id and phone=p_phone and verified_at is null and expires_at > now()
    order by created_at desc limit 1;
  if rec.id is null then
    return jsonb_build_object('approved', false, 'error','no_active_code', 'message','no active code — request a new OTP');
  end if;
  if rec.attempts >= 5 then
    return jsonb_build_object('approved', false, 'error','locked', 'message','too many attempts — request a new OTP');
  end if;
  if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then
    -- soft-return (NOT raise) so this increment persists → lockout actually works
    update public.quote_otps set attempts = attempts+1 where id = rec.id;
    return jsonb_build_object('approved', false, 'error','incorrect_code', 'message','incorrect code',
      'remaining', greatest(0, 5 - (rec.attempts+1)));
  end if;
  if p_agreed is not true then
    return jsonb_build_object('approved', false, 'error','not_agreed', 'message','you must accept the terms to confirm');
  end if;
  update public.quote_otps set verified_at = now() where id = rec.id;
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, user_agent)
    values (q.id, p_phone, p_client_name, p_terms_version, p_consent_text, true, true, p_user_agent);
  update public.quotes set approval_status='approved', updated_at=now() where id=q.id;
  return jsonb_build_object('approved', true);
end; $function$;

-- ---- W10-D2: public_get_portal enforces token expiry -------------------------

CREATE OR REPLACE FUNCTION public.public_get_portal(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; prop public.event_proposal; ms jsonb; gal jsonb; outstanding numeric; studio jsonb;
begin
  -- W10-D2 FIX: enforce approval-token expiry, matching public_get_quote().
  select * into q from public.quotes
    where approval_token = p_token
      and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select * into prop from public.event_proposal where quote_id = q.id;
  select jsonb_build_object('name', o.name, 'brand', o.brand) into studio
    from public.organizations o where o.id = q.org_id;
  select coalesce(jsonb_agg(jsonb_build_object('label',label,'due_date',due_date,'amount',amount,'status',status)
                            order by seq, due_date), '[]'::jsonb)
    into ms from public.payment_milestones where quote_id = q.id;
  select coalesce(sum(amount),0) into outstanding
    from public.payment_milestones where quote_id = q.id and status not in ('paid','waived');
  select coalesce(jsonb_agg(jsonb_build_object('url',url,'kind',kind,'caption',caption)
                            order by seq, created_at), '[]'::jsonb)
    into gal from public.event_media where quote_id = q.id and in_gallery = true;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_type',q.event_type,
                                'event_date',q.event_date,'event_time',q.event_time,
                                'status',q.status,'stage',q.lifecycle_stage),
    'studio', studio,
    'client_name', coalesce(q.client->>'name',''),
    'approval_status', q.approval_status,
    'total', coalesce((q.pricing->>'total')::numeric, 0),
    'proposal', case when prop.quote_id is not null and prop.published
                  then jsonb_build_object('concept',prop.concept,'theme',prop.theme,
                                          'palette',prop.palette,'images',prop.images,'scope',prop.scope)
                  else null end,
    'payment', jsonb_build_object('milestones', ms, 'outstanding', outstanding),
    'gallery', gal);
end; $function$;

commit;
