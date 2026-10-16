-- 0140_lead_dates_to_nurture.sql - CANONICAL forward-only. REQUIRES 0105 (leads.birthday / leads.anniversary),
-- phase30 (nurture.occasion_type), 0084 (_a84_phone_ok).
--
-- In plain words:
--   A lead's Birthday / Anniversary now flows into Nurture by itself (no typing it twice).
--   * nurture gets two new nullable columns: source ('lead' for rows made by this sync, null = typed by hand)
--     and lead_id (which lead it came from). Existing rows are untouched (source stays null = manual).
--   * Saving a lead with a birthday/anniversary creates ONE nurture occasion per lead + type, or updates
--     that same row (name, phone, email, date) - never a duplicate (unique index + upsert).
--   * Clearing the date removes ONLY the row this sync created (source = 'lead'), and only if nobody
--     has worked on it (no note, still active, never greeted). If someone did, the row is kept and
--     handed over as a manual row (source -> null), so no follow-up history is ever lost.
--   * Hand-made nurture rows (source null) are never read, changed or deleted by this sync.
--   * Deleting a lead leaves its nurture rows alone (the CRM archive can restore the lead).
--   * The sync is best-effort: if it ever fails, the lead still saves (warning only).
--   * One-time backfill: leads that already have dates get their occasion (idempotent, insert-only).
-- Idempotent: safe to run twice.

alter table public.nurture add column if not exists source text;
alter table public.nurture add column if not exists lead_id uuid;

create unique index if not exists nurture_lead_occ_uidx
  on public.nurture (org_id, lead_id, occasion_type) where source = 'lead';

create or replace function public._n140_sync_one(p_lead public.leads, p_type text, p_date date)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_phone text; v_label text;
begin
  v_label := case p_type when 'birthday' then 'Birthday' else 'Anniversary' end;
  if p_date is null then
    -- untouched auto row -> remove; worked-on auto row -> keep as a manual row
    delete from public.nurture n
     where n.source = 'lead' and n.org_id = p_lead.org_id and n.lead_id = p_lead.id and n.occasion_type = p_type
       and n.note is null and n.status = 'active' and n.last_greeted is null;
    update public.nurture n set source = null
     where n.source = 'lead' and n.org_id = p_lead.org_id and n.lead_id = p_lead.id and n.occasion_type = p_type;
    return;
  end if;
  v_phone := case when p_lead.phone is not null and public._a84_phone_ok(p_lead.phone) then p_lead.phone end;
  insert into public.nurture (org_id, name, phone, email, occasion, occasion_type, occasion_date, next_followup,
                              status, quote_id, source, lead_id)
  values (p_lead.org_id, p_lead.name, v_phone, p_lead.email, v_label, p_type, p_date,
          public._next_occasion(p_date), 'active', p_lead.quote_id, 'lead', p_lead.id)
  on conflict (org_id, lead_id, occasion_type) where source = 'lead' do update
     set name = excluded.name,
         phone = coalesce(excluded.phone, public.nurture.phone),
         email = excluded.email,
         occasion_date = excluded.occasion_date,
         next_followup = case when public.nurture.occasion_date is distinct from excluded.occasion_date
                              then excluded.next_followup else public.nurture.next_followup end;
end $$;
revoke all on function public._n140_sync_one(public.leads, text, date) from public, anon, authenticated;

create or replace function public._n140_tg_lead_dates()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
begin
  if TG_OP = 'UPDATE'
     and new.birthday is not distinct from old.birthday and new.anniversary is not distinct from old.anniversary
     and new.name is not distinct from old.name and new.phone is not distinct from old.phone
     and new.email is not distinct from old.email then
    return new;
  end if;
  begin
    if TG_OP = 'INSERT' then
      if new.birthday is not null then perform public._n140_sync_one(new, 'birthday', new.birthday); end if;
      if new.anniversary is not null then perform public._n140_sync_one(new, 'anniversary', new.anniversary); end if;
    else
      if new.birthday is not null or old.birthday is not null then perform public._n140_sync_one(new, 'birthday', new.birthday); end if;
      if new.anniversary is not null or old.anniversary is not null then perform public._n140_sync_one(new, 'anniversary', new.anniversary); end if;
    end if;
  exception when others then
    raise warning 'lead -> nurture date sync skipped for lead %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public._n140_tg_lead_dates() from public, anon, authenticated;

drop trigger if exists zz_n140_lead_dates on public.leads;
create trigger zz_n140_lead_dates after insert or update on public.leads
  for each row execute function public._n140_tg_lead_dates();

-- one-time backfill (insert-only; existing rows never changed)
insert into public.nurture (org_id, name, phone, email, occasion, occasion_type, occasion_date, next_followup,
                            status, quote_id, source, lead_id)
select l.org_id, l.name,
       case when l.phone is not null and public._a84_phone_ok(l.phone) then l.phone end,
       l.email, v.label, v.t, v.d, public._next_occasion(v.d), 'active', l.quote_id, 'lead', l.id
  from public.leads l
  cross join lateral (values ('birthday', 'Birthday', l.birthday), ('anniversary', 'Anniversary', l.anniversary)) v(t, label, d)
 where v.d is not null and l.org_id is not null
on conflict (org_id, lead_id, occasion_type) where source = 'lead' do nothing;

notify pgrst, 'reload schema';
