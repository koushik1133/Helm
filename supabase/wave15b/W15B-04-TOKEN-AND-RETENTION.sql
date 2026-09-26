-- ============================================================================
-- W15B-02-TOKEN-AND-RETENTION.sql — Cloudflare-audit CONFIRMED findings.
-- STATUS: SOURCE PREPARED. STAGING ONLY. NOT APPLIED. NOT FOR PRODUCTION.
-- Additive & idempotent, forward-only. Apply on staging then re-run the audit
-- (run-2) + E2E. Money/security-critical — review before applying.
-- ============================================================================
begin;

-- CF tokens/worker-token-no-expiry-no-revocation --------------------------------
alter table public.work_tokens add column if not exists expires_at  timestamptz;
alter table public.work_tokens add column if not exists revoked_at  timestamptz;

create or replace function public.revoke_work_token(p_quote_id uuid, p_phone text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  update public.work_tokens set revoked_at = now()
    where quote_id = p_quote_id and phone = p_phone;
end $$;
revoke all on function public.revoke_work_token(uuid,text) from anon;
grant execute on function public.revoke_work_token(uuid,text) to authenticated;

-- NOTE: the four worker_* RPCs (worker_get_tasks/worker_respond/worker_get_equipment/
-- worker_checkin_equipment) must add to their work_tokens lookup:
--   and (expires_at is null or expires_at > now()) and revoked_at is null
-- Those bodies live in operations.sql/phase52 and are re-created there; apply the
-- guarded versions in a companion forward-only migration so a base re-run cannot
-- drop the guard (tracked with CF deploy/legacy-base-files note).

-- CF tokens/portal-proposal-ignore-token-expiry --------------------------------
-- public_get_portal and public_get_proposal must mirror the sibling expiry guard
-- used by public_get_quote/request_otp/verify_and_consent/create_payment:
--   ... where approval_token = p_token
--       and (approval_token_expires_at is null or approval_token_expires_at > now())
-- (Re-create the two functions with the added predicate here once reviewed; left as
-- an explicit TODO rather than a blind rewrite because these are client-facing reads.)

-- CF data-lifecycle/quote-delete-cascades-financial-and-consent ----------------
-- Prevent silent destruction of the financial ledger + signed consent when a quote
-- is deleted. Recommended: a guarded delete_quote RPC that refuses when paid rows
-- exist, plus tightening the FKs from CASCADE to RESTRICT for financial/consent
-- children. FK changes are schema-altering and MUST be validated on staging first:
--   alter table public.quote_payments  drop constraint <fk>, add ... on delete restrict;
--   alter table public.quote_consents  drop constraint <fk>, add ... on delete restrict;
-- Left as reviewed TODO (constraint names vary; capture them from staging PRECHECK).
create or replace function public.delete_quote(p_quote_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.can_delete() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  if exists (select 1 from public.quote_payments where quote_id = p_quote_id and status = 'paid') then
    raise exception 'cannot delete a quote with recorded payments' using errcode='23503';
  end if;
  delete from public.quotes where id = p_quote_id and org_id = public.current_org_id();
end $$;
revoke all on function public.delete_quote(uuid) from anon;
grant execute on function public.delete_quote(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
