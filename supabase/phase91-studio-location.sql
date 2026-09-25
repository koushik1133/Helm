-- ============================================================================
-- Phase 91 — Studio location (onboarding)
-- ---------------------------------------------------------------------------
-- Adds an optional free-text location (city, country) captured during
-- onboarding and editable later in Control Center. Additive, idempotent,
-- non-destructive. No RLS change (organizations RLS already org-scopes rows).
-- ============================================================================
alter table public.organizations add column if not exists location text;

notify pgrst, 'reload schema';
select 'phase91 studio-location' t, 'ready' s;
