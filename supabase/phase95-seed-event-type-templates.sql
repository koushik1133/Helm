-- =========================================================================
-- Phase 95 — Add event-type checklist templates (Wedding / Birthday / Engagement /
-- Corporate full). SAFE + IDEMPOTENT + ADDITIVE. Run in the Supabase SQL editor.
-- Only inserts a template when one of the same name doesn't already exist for the
-- studio. Detects org_id column presence (works even without the multi-tenant
-- migration). Nothing overwritten or deleted. Re-running changes nothing.
-- Run the DO block on its own (verify at the bottom is a separate run).
-- =========================================================================

do $$
declare
  v_org uuid;
  v_has_tpl_org boolean;
begin
  select p.org_id into v_org
    from public.profiles p join auth.users u on u.id = p.id
   where lower(u.email) = 'admin@helm.com' limit 1;
  if v_org is null then v_org := '00000000-0000-4000-8000-000000000001'; end if;

  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='checklist_templates' and column_name='org_id')
    into v_has_tpl_org;

  if v_has_tpl_org then
    insert into public.checklist_templates(name, section, items, notes, org_id)
    select v.name, v.section, v.items, v.notes, v_org
      from (values
        ('Wedding — full planning','logistics',
          '["Lock event date & venue","Confirm guest count & budget","Book caterer & finalise menu","Book decor / mandap & florist","Book photographer & videographer","Book DJ / live music","Arrange guest transport & parking","Confirm makeup & attire timeline","Rehearsal / sound check","Day-of run sheet to all vendors","Welcome desk & seating plan","Teardown, settlement & thank-you"]'::jsonb,
          'End-to-end wedding checklist by event type'),
        ('Birthday party','logistics',
          '["Confirm theme & guest count","Book venue / home setup","Order cake & catering","Decor & balloons","Entertainment / games / DJ","Return gifts & favours","Photographer (optional)","Cleanup & teardown"]'::jsonb,
          'Birthday event checklist'),
        ('Engagement / reception','logistics',
          '["Confirm date, venue & guest count","Stage & backdrop decor","Catering & menu tasting","Photography & videography","Music / DJ","Ring / ceremony logistics","Seating & welcome desk","Teardown & settlement"]'::jsonb,
          'Engagement or reception checklist'),
        ('Corporate event — full','logistics',
          '["Confirm agenda & headcount","Book venue & AV vendor","Registration & badging plan","Catering & breaks","Speaker / VIP coordination","Signage, branding & stage","Recording / live-stream","Feedback capture & wrap report"]'::jsonb,
          'Full corporate event checklist by event type')
      ) as v(name, section, items, notes)
     where not exists (select 1 from public.checklist_templates t where t.name = v.name and t.org_id = v_org);
  else
    insert into public.checklist_templates(name, section, items, notes)
    select v.name, v.section, v.items, v.notes
      from (values
        ('Wedding — full planning','logistics',
          '["Lock event date & venue","Confirm guest count & budget","Book caterer & finalise menu","Book decor / mandap & florist","Book photographer & videographer","Book DJ / live music","Arrange guest transport & parking","Confirm makeup & attire timeline","Rehearsal / sound check","Day-of run sheet to all vendors","Welcome desk & seating plan","Teardown, settlement & thank-you"]'::jsonb,
          'End-to-end wedding checklist by event type'),
        ('Birthday party','logistics',
          '["Confirm theme & guest count","Book venue / home setup","Order cake & catering","Decor & balloons","Entertainment / games / DJ","Return gifts & favours","Photographer (optional)","Cleanup & teardown"]'::jsonb,
          'Birthday event checklist'),
        ('Engagement / reception','logistics',
          '["Confirm date, venue & guest count","Stage & backdrop decor","Catering & menu tasting","Photography & videography","Music / DJ","Ring / ceremony logistics","Seating & welcome desk","Teardown & settlement"]'::jsonb,
          'Engagement or reception checklist'),
        ('Corporate event — full','logistics',
          '["Confirm agenda & headcount","Book venue & AV vendor","Registration & badging plan","Catering & breaks","Speaker / VIP coordination","Signage, branding & stage","Recording / live-stream","Feedback capture & wrap report"]'::jsonb,
          'Full corporate event checklist by event type')
      ) as v(name, section, items, notes)
     where not exists (select 1 from public.checklist_templates t where t.name = v.name);
  end if;
end $$;

-- Verify (separate run):
-- select name, section from public.checklist_templates order by name;
