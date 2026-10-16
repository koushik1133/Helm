-- 0139_crm_restore_lead.sql - CANONICAL forward-only. REQUIRES 0122 (archive_lead with org_id),
-- 0125 (lead audit trigger), phase29 (has_area).
--
-- In plain words:
--   When a lead is deleted, the delete dialog promises "It stays in the CRM archive". This adds a
--   one-click Restore for those archived "deleted" rows. restore_archived_lead(archive_id):
--     * only works on a "deleted" archive row of the signed-in user's OWN studio (current_org_id());
--     * only for people allowed to edit leads (has_area('leads','edit'));
--     * refuses if a live lead with the same id already exists (nothing is overwritten);
--     * refuses if that archive row was already restored;
--     * re-creates the lead from the saved snapshot with its original id, in the same studio
--       (a quote or owner that no longer exists is left blank rather than failing);
--     * marks the archive row restored (restored_at / restored_by). The archive row is NEVER deleted;
--     * writes an audit_log row "lead.restored".
--   Additive only: two nullable columns on lead_archive and one function. No row is deleted or changed
--   except the stamp on the archive row being restored.
-- Idempotent: "add column if not exists" + "create or replace function"; re-running changes nothing.

alter table public.lead_archive add column if not exists restored_at timestamptz;
alter table public.lead_archive add column if not exists restored_by uuid;

create or replace function public.restore_archived_lead(p_archive_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid := public.current_org_id();
  v_arc  public.lead_archive;
  v_lead public.leads;
begin
  if auth.uid() is null or v_org is null then
    raise exception 'Sign in to a studio first.' using errcode = '42501';
  end if;
  if not public.has_area('leads', 'edit') then
    raise exception 'You do not have permission to restore leads.' using errcode = '42501';
  end if;

  -- lock the archive row so two clicks cannot restore it twice
  select * into v_arc from public.lead_archive a
   where a.id = p_archive_id and a.org_id = v_org
   for update;
  if not found then
    raise exception 'Archive record not found.' using errcode = 'P0002';
  end if;
  if v_arc.action <> 'deleted' then
    raise exception 'Only deleted leads can be restored.' using errcode = '22023';
  end if;
  if v_arc.restored_at is not null then
    raise exception 'This lead was already restored.' using errcode = '23505';
  end if;
  if v_arc.lead_id is null or v_arc.snapshot is null then
    raise exception 'This archive record has no saved lead to restore.' using errcode = '22023';
  end if;
  if exists (select 1 from public.leads l where l.id = v_arc.lead_id) then
    raise exception 'A live lead with this id already exists - nothing was changed.' using errcode = '23505';
  end if;

  -- rebuild the row from the snapshot (keeps every saved column, including ones added later)
  v_lead := jsonb_populate_record(null::public.leads, v_arc.snapshot);
  v_lead.id         := v_arc.lead_id;
  v_lead.org_id     := v_org;                               -- always the caller's studio
  v_lead.name       := coalesce(nullif(btrim(v_lead.name), ''), v_arc.name, 'Restored lead');
  v_lead.status     := coalesce(v_lead.status, v_arc.status, 'new');
  v_lead.created_at := coalesce(v_lead.created_at, now());
  v_lead.updated_at := now();
  if v_lead.quote_id is not null and not exists
       (select 1 from public.quotes q where q.id = v_lead.quote_id and q.org_id = v_org) then
    v_lead.quote_id := null;
  end if;
  if v_lead.owner is not null and not exists (select 1 from auth.users u where u.id = v_lead.owner) then
    v_lead.owner := null;
  end if;

  insert into public.leads select (v_lead).*;

  update public.lead_archive
     set restored_at = now(), restored_by = auth.uid()
   where id = v_arc.id;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
  select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'lead.restored',
         'leads', v_arc.lead_id::text,
         jsonb_build_object('archive_id', v_arc.id, 'name', v_lead.name), v_org, now();

  return jsonb_build_object('result', 'restored', 'lead_id', v_arc.lead_id);
end $$;

revoke all on function public.restore_archived_lead(uuid) from public, anon;
grant execute on function public.restore_archived_lead(uuid) to authenticated;
