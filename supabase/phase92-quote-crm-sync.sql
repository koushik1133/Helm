-- ============================================================================
-- Phase 92 — Quote → CRM auto-sync (Cluster B)
-- ---------------------------------------------------------------------------
-- WHY: a quote generated directly (not converted from a lead) had no matching
-- row in `leads`, so its client never appeared in CRM (crm.html reads
-- `lead_archive`, which is fed by the existing archive_lead() trigger on
-- `leads`). This migration keeps a lead in sync with every quote's client:
--   • quote created / client edited / status changed  →  upsert a `leads` row
--     (org-scoped), which the existing archive trigger snapshots into CRM.
--   • the nurture client dropdown (reads leads) then also lists quote clients.
--
-- SAFE / ADDITIVE: no columns dropped, no rows deleted. The trigger is
-- SECURITY DEFINER and always binds the lead to NEW.org_id (never cross-tenant).
-- It writes ONLY to `leads` (never back to `quotes`), so there is no trigger
-- recursion. A 'won'/'lost' lead is never silently downgraded to 'quoted'.
--
-- DO NOT BREAK: convert_lead_to_quote (already links a lead → the INSERT trigger
-- just finds that lead by quote_id and refreshes it, no duplicate); existing
-- leads/CRM/archive behavior; multi-tenant isolation.
-- Idempotent. Run AFTER phase56/57 (org_id), phase2/2b (leads + archive),
-- otp-payments (quotes.approval_status).
-- ============================================================================

create or replace function public.sync_quote_to_lead()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name  text := nullif(btrim(NEW.client->>'name'), '');
  v_email text := nullif(btrim(NEW.client->>'email'), '');
  v_phone text := nullif(btrim(NEW.client->>'phone'), '');
  v_status text;
  v_lead public.leads;
begin
  -- nothing to sync without a client name
  if v_name is null then return NEW; end if;

  -- map the quote's lifecycle to the Leads pipeline stage (enum-safe):
  --   cancelled → lost; confirmed/paid/planning..closed → won;
  --   discovery → discovery; everything else (quote/proposal) → quoted.
  v_status := case
    when NEW.status = 'cancelled'                          then 'lost'
    when NEW.approval_status = 'paid'
      or NEW.status = 'confirmed'
      or NEW.lifecycle_stage in ('planning','event','settlement','closed') then 'won'
    when NEW.lifecycle_stage = 'discovery'                 then 'discovery'
    else 'quoted' end;

  -- 1) a lead already linked to this quote?
  select * into v_lead from public.leads
   where quote_id = NEW.id and org_id = NEW.org_id
   limit 1;

  -- 2) else an UNLINKED lead for the same client in this org (match on email,
  --    else on name) — link it instead of creating a duplicate CRM entry.
  if v_lead.id is null then
    select * into v_lead from public.leads
     where org_id = NEW.org_id and quote_id is null
       and ( (v_email is not null and lower(coalesce(email,'')) = lower(v_email))
          or (v_email is null and lower(coalesce(name,'')) = lower(v_name)) )
     order by updated_at desc
     limit 1;
  end if;

  if v_lead.id is not null then
    update public.leads set
      name       = v_name,
      email      = coalesce(v_email, email),
      phone      = coalesce(v_phone, phone),
      event_type = coalesce(NEW.event_type, event_type),
      event_date = coalesce(NEW.event_date, event_date),
      -- don't downgrade a won/lost lead back to 'quoted' on a routine edit
      -- never downgrade a terminal won/lost lead on a routine edit
      status     = case when status in ('won','lost') and v_status in ('quoted','discovery')
                        then status else v_status end,
      quote_id   = NEW.id,
      updated_at = now()
     where id = v_lead.id;
  else
    insert into public.leads (org_id, name, phone, email, source, event_type, event_date, status, quote_id)
      values (NEW.org_id, v_name, v_phone, v_email, 'quote', NEW.event_type, NEW.event_date, v_status, NEW.id);
  end if;

  return NEW;
end; $$;

-- fire on insert (always) and on the meaningful updates only (keeps the CRM
-- archive from snapshotting on every unrelated updated_at bump).
drop trigger if exists quotes_sync_lead_ins on public.quotes;
create trigger quotes_sync_lead_ins after insert on public.quotes
  for each row execute function public.sync_quote_to_lead();

drop trigger if exists quotes_sync_lead_upd on public.quotes;
create trigger quotes_sync_lead_upd after update on public.quotes
  for each row
  when ( NEW.client          is distinct from OLD.client
      or NEW.status          is distinct from OLD.status
      or NEW.approval_status is distinct from OLD.approval_status
      or NEW.lifecycle_stage is distinct from OLD.lifecycle_stage
      or NEW.event_type      is distinct from OLD.event_type
      or NEW.event_date      is distinct from OLD.event_date )
  execute function public.sync_quote_to_lead();

-- ---- one-time backfill: existing quotes with a client but no linked lead ----
-- Inserts only the MISSING leads (never touches existing ones). org_id is taken
-- from the quote so it lands in the right tenant. The archive trigger then
-- surfaces them in CRM.
insert into public.leads (org_id, name, phone, email, source, event_type, event_date, status, quote_id)
select q.org_id,
       nullif(btrim(q.client->>'name'), ''),
       nullif(btrim(q.client->>'phone'), ''),
       nullif(btrim(q.client->>'email'), ''),
       'quote',
       q.event_type,
       q.event_date,
       case when q.status = 'cancelled' then 'lost'
            when q.status = 'confirmed' or q.approval_status = 'paid' then 'won'
            else 'quoted' end,
       q.id
from public.quotes q
where coalesce(btrim(q.client->>'name'), '') <> ''
  and not exists (select 1 from public.leads l where l.quote_id = q.id);

notify pgrst, 'reload schema';
select 'phase92 quote→CRM sync' t, 'ready' s;
