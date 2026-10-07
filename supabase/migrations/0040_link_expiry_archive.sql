-- ============================================================================
-- 0040_link_expiry_archive.sql — CANONICAL forward-only. REQUIRES 0039.
-- "When a quote's client link expires (and the client never approved or paid):
--  Keep it (default) | Move to Archive | Move to Deleted quotes" — an OPTIONAL
-- per-studio choice under 0039's "auto-expire client links" switch in Control
-- Center (studio ADMIN only, every change audited).
--
-- Archive / Deleted are SOFT: a quote is only ever flagged (quotes.archived_at or
-- quotes.deleted_at + who/why), never removed. "Deleted quotes" is a tab with a
-- Restore button, not a delete. Nothing here deletes, truncates or rewrites a row,
-- and the 0026 delete guard (aa_quote_delete_guard) is untouched and still applies
-- to real deletes.
--
-- Which quotes move (all must hold; re-checked at move time):
--   * the studio has 0039 auto-expire ON (N days) and chose Archive or Deleted;
--   * a client link went out (approval/portal token, or a proposal link) and the
--     NEWEST one is older than N days (the 0039 rule: issued time + N days);
--   * never confirmed by the studio (status 'quote', no confirmed_at), still at
--     lead/discovery/proposal/quote, client never approved or paid
--     (approval_status none/sent);
--   * no money or consent on record: no client consent, no paid/refunded/open
--     payment, no paid milestone, no refund (the 0026 guard set, plus open intents);
--   * not already archived/deleted, and not restored by someone in the last N days.
--
-- When it runs: there may be no pg_cron, so the studio's own app runs it — opening
-- Quotes or the Dashboard calls link_expiry_shelf_tick(), which does the work at
-- most once every 10 minutes per studio (tracked in org_link_expiry_shelf). If
-- pg_cron is ALREADY installed, a 30-minute job is scheduled too (the extension is
-- never created here). Each moved quote gets an audit_log row.
--
-- Drift-safe: additive columns on quotes (all NULL by default), one new settings
-- table, one BEFORE trigger that stops the API roles from setting the new columns
-- directly (only the functions below may), new functions only. No existing function
-- is replaced. Idempotent: safe to re-run.
-- ============================================================================

-- ---- 1) soft flags on quotes (NULL = in the normal lists) --------------------
alter table public.quotes add column if not exists archived_at       timestamptz;
alter table public.quotes add column if not exists archived_by       uuid;
alter table public.quotes add column if not exists archived_reason   text;
alter table public.quotes add column if not exists deleted_at        timestamptz;
alter table public.quotes add column if not exists deleted_by        uuid;
alter table public.quotes add column if not exists deleted_reason    text;
alter table public.quotes add column if not exists link_expired_at   timestamptz;  -- set when moved because the link expired
alter table public.quotes add column if not exists shelf_restored_at timestamptz;  -- last Restore from Archive/Deleted

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_archived_reason_chk' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_archived_reason_chk
      check (archived_reason is null or archived_reason in ('manual', 'link_expired'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_deleted_reason_chk' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_deleted_reason_chk
      check (deleted_reason is null or deleted_reason in ('manual', 'link_expired'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_shelf_one_chk' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_shelf_one_chk
      check (archived_at is null or deleted_at is null);
  end if;
end $$;
create index if not exists quotes_shelf_idx on public.quotes (org_id)
  where archived_at is not null or deleted_at is not null;

-- the API roles can read these columns (normal quote RLS) but never write them:
-- only the SECURITY DEFINER functions below change them
create or replace function public.quotes_shelf_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.archived_at is not null or new.archived_by is not null or new.archived_reason is not null
         or new.deleted_at is not null or new.deleted_by is not null or new.deleted_reason is not null
         or new.link_expired_at is not null or new.shelf_restored_at is not null then
        raise exception 'a new quote can''t start archived or deleted' using errcode = '42501';
      end if;
    elsif (new.archived_at, new.archived_by, new.archived_reason, new.deleted_at, new.deleted_by,
           new.deleted_reason, new.link_expired_at, new.shelf_restored_at)
          is distinct from
          (old.archived_at, old.archived_by, old.archived_reason, old.deleted_at, old.deleted_by,
           old.deleted_reason, old.link_expired_at, old.shelf_restored_at) then
      raise exception 'archive and deleted change only through Archive / Delete / Restore in the app'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.quotes_shelf_guard() from public, anon, authenticated;
drop trigger if exists quotes_shelf_guard_biu on public.quotes;
create trigger quotes_shelf_guard_biu before insert or update on public.quotes
  for each row execute function public.quotes_shelf_guard();

-- ---- 2) the studio's choice + when it last ran (one row per studio; none = Keep) --
create table if not exists public.org_link_expiry_shelf (
  org_id         uuid primary key references public.organizations(id),
  action         text not null default 'keep',
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  last_run_at    timestamptz,
  last_run_moved int,
  constraint org_link_expiry_shelf_action_chk check (action in ('keep', 'archive', 'delete'))
);
alter table public.org_link_expiry_shelf enable row level security;
revoke all on public.org_link_expiry_shelf from public, anon, authenticated;   -- RPCs only
grant select on public.org_link_expiry_shelf to service_role;

-- ---- 3) which quotes qualify (read-only) ----------------------------------------
create or replace function public.link_expiry_shelf_candidates(p_org uuid, p_days int)
returns table(quote_id uuid, link_expired_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select q.id, x.sent + make_interval(days => p_days)
    from public.quotes q
    cross join lateral (
      select greatest(
        case when q.approval_token is not null then
          coalesce((select i.issued_at from public.client_link_issued i
                     where i.kind = 'quote' and i.token = q.approval_token), q.created_at) end,
        (select max(coalesce(i.issued_at, q.created_at))
           from public.event_proposal pr
           left join public.client_link_issued i on i.kind = 'proposal' and i.token = pr.share_token
          where pr.quote_id = q.id and pr.share_token is not null)
      ) as sent
    ) x
   where p_org is not null and p_days between 1 and 365
     and q.org_id = p_org
     and q.archived_at is null and q.deleted_at is null
     and q.status = 'quote' and q.confirmed_at is null
     and coalesce(q.lifecycle_stage, 'quote') in ('lead', 'discovery', 'proposal', 'quote')
     and q.approval_status in ('none', 'sent')
     and x.sent is not null
     and x.sent + make_interval(days => p_days) <= now()
     and (q.shelf_restored_at is null or q.shelf_restored_at + make_interval(days => p_days) <= now())
     and not exists (select 1 from public.quote_consents c where c.quote_id = q.id)
     and not exists (select 1 from public.quote_payments p where p.quote_id = q.id
                      and p.status in ('paid', 'refunded', 'created'))
     and not exists (select 1 from public.payment_milestones m where m.quote_id = q.id and m.status = 'paid')
     and not exists (select 1 from public.event_refunds r where r.quote_id = q.id);
$$;
revoke all on function public.link_expiry_shelf_candidates(uuid, int) from public, anon, authenticated;

-- ---- 4) the job: move what qualifies for ONE studio (idempotent) -------------------
create or replace function public.apply_link_expiry_archive(p_org uuid default public.current_org_id())
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_days int; v_action text; v_n int := 0; v_me uuid := auth.uid(); r record;
begin
  if p_org is null then
    return jsonb_build_object('moved', 0, 'action', 'keep', 'enabled', false);
  end if;
  -- a signed-in caller can only ever run it for their own studio
  if v_me is not null and p_org is distinct from public.current_org_id() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_days := public.link_autoexpire_days(p_org);                 -- NULL = auto-expire off
  select s.action into v_action from public.org_link_expiry_shelf s where s.org_id = p_org;
  v_action := coalesce(v_action, 'keep');
  if v_days is null or v_action not in ('archive', 'delete') then
    return jsonb_build_object('moved', 0, 'action', v_action, 'enabled', v_days is not null);
  end if;
  for r in select c.quote_id, c.link_expired_at from public.link_expiry_shelf_candidates(p_org, v_days) c loop
    if v_action = 'archive' then
      update public.quotes q
         set archived_at = now(), archived_by = null, archived_reason = 'link_expired', link_expired_at = r.link_expired_at
       where q.id = r.quote_id and q.org_id = p_org and q.archived_at is null and q.deleted_at is null
         and q.status = 'quote' and q.confirmed_at is null and q.approval_status in ('none', 'sent');
    else
      update public.quotes q
         set deleted_at = now(), deleted_by = null, deleted_reason = 'link_expired', link_expired_at = r.link_expired_at
       where q.id = r.quote_id and q.org_id = p_org and q.archived_at is null and q.deleted_at is null
         and q.status = 'quote' and q.confirmed_at is null and q.approval_status in ('none', 'sent');
    end if;
    if found then
      v_n := v_n + 1;
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
        values (null, null, case when v_action = 'archive' then 'quote.moved_to_archive' else 'quote.moved_to_deleted' end,
                'quotes', r.quote_id::text, r.quote_id, p_org,
                jsonb_build_object('auto', true, 'reason', 'link_expired', 'link_expired_at', r.link_expired_at,
                                   'days', v_days, 'run_by', v_me));
    end if;
  end loop;
  return jsonb_build_object('moved', v_n, 'action', v_action, 'enabled', true, 'days', v_days);
end $$;
revoke all on function public.apply_link_expiry_archive(uuid) from public, anon, authenticated;
grant execute on function public.apply_link_expiry_archive(uuid) to service_role;

-- every studio that switched it on (for pg_cron / the service role)
create or replace function public.apply_link_expiry_archive_all()
returns int language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid; v_out jsonb; v_total int := 0;
begin
  for v_org in select s.org_id from public.org_link_expiry_shelf s
                 join public.org_link_autoexpire a on a.org_id = s.org_id
                where s.action in ('archive', 'delete') and a.enabled loop
    v_out := public.apply_link_expiry_archive(v_org);
    update public.org_link_expiry_shelf s set last_run_at = now(), last_run_moved = (v_out ->> 'moved')::int
     where s.org_id = v_org;
    v_total := v_total + coalesce((v_out ->> 'moved')::int, 0);
  end loop;
  return v_total;
end $$;
revoke all on function public.apply_link_expiry_archive_all() from public, anon, authenticated;
grant execute on function public.apply_link_expiry_archive_all() to service_role;

-- the app's lazy trigger: opening Quotes / Dashboard. At most once per 10 minutes per
-- studio (the row update below is the claim, so two tabs can't both run it).
create or replace function public.link_expiry_shelf_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_claimed boolean; v_out jsonb;
begin
  if auth.uid() is null or v_org is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- roles that can't see quotes (crew, …) open the Dashboard too: a quiet no-op, not an error
  if not public.has_area('quotes', 'view') then
    return jsonb_build_object('ran', false, 'moved', 0);
  end if;
  update public.org_link_expiry_shelf s set last_run_at = now()
   where s.org_id = v_org and s.action in ('archive', 'delete')
     and (s.last_run_at is null or s.last_run_at <= now() - interval '10 minutes')
  returning true into v_claimed;
  if not coalesce(v_claimed, false) then
    return jsonb_build_object('ran', false, 'moved', 0);
  end if;
  v_out := public.apply_link_expiry_archive(v_org);
  update public.org_link_expiry_shelf s set last_run_moved = (v_out ->> 'moved')::int where s.org_id = v_org;
  return v_out || jsonb_build_object('ran', true);
end $$;
revoke all on function public.link_expiry_shelf_tick() from public, anon;
grant execute on function public.link_expiry_shelf_tick() to authenticated;

-- ---- 5) Quotes page: list the Archive / Deleted shelves; move by hand; Restore ------
-- SECURITY INVOKER: the caller's normal quote RLS (has_area quotes view + own studio)
-- decides what they see — this only picks the flagged rows, plus the two tab counts
-- (Archive = flagged archived + finished events: cancelled, or closed after confirming).
create or replace function public.list_quote_shelf()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', q.id, 'code', q.code, 'title', q.title, 'event_type', q.event_type,
               'status', q.status, 'lifecycle_stage', q.lifecycle_stage, 'approval_status', q.approval_status,
               'current_version', q.current_version, 'event_date', q.event_date,
               'client_name', coalesce(q.client ->> 'name', q.pricing -> 'client' ->> 'name'),
               'total', q.pricing -> 'total', 'created_at', q.created_at, 'updated_at', q.updated_at,
               'shelf', case when q.deleted_at is not null then 'deleted' else 'archived' end,
               'shelved_at', coalesce(q.deleted_at, q.archived_at),
               'reason', case when q.deleted_at is not null then q.deleted_reason else q.archived_reason end,
               'link_expired_at', q.link_expired_at)
             order by coalesce(q.deleted_at, q.archived_at) desc)
        from public.quotes q
       where q.archived_at is not null or q.deleted_at is not null), '[]'::jsonb),
    'archived_count', (select count(*) from public.quotes q
                        where q.deleted_at is null
                          and (q.archived_at is not null or q.status = 'cancelled'
                               or (q.lifecycle_stage = 'closed' and q.status = 'confirmed'))),
    'deleted_count', (select count(*) from public.quotes q where q.deleted_at is not null));
$$;
revoke all on function public.list_quote_shelf() from public, anon;
grant execute on function public.list_quote_shelf() to authenticated;

create or replace function public.move_quote_to_shelf(p_quote_id uuid, p_shelf text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_email text;
        v_pending boolean := false; v_can_delete boolean := false;
begin
  if v_me is null or v_org is null or not public.has_area('quotes', 'edit') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v_pending;
    if coalesce(v_pending, false) then raise exception 'set your own password first' using errcode = '42501'; end if;
  end if;
  if p_shelf is null or p_shelf not in ('archive', 'delete') then
    raise exception 'choose archive or delete' using errcode = '22023';
  end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = v_org) then
    raise exception 'no such quote' using errcode = '42501';
  end if;
  if p_shelf = 'delete' then
    -- same people who could delete before (admin / planner) ...
    if to_regprocedure('public.can_delete()') is not null then
      execute 'select public.can_delete()' into v_can_delete;
    else v_can_delete := public.is_admin(); end if;
    if not coalesce(v_can_delete, false) then raise exception 'not authorized' using errcode = '42501'; end if;
    -- ... and the 0026 rule still holds: money / consent / refunds -> cancel, don't delete
    if exists (select 1 from public.quote_payments where quote_id = p_quote_id and status in ('paid', 'refunded'))
       or exists (select 1 from public.payment_milestones where quote_id = p_quote_id and status = 'paid')
       or exists (select 1 from public.quote_consents where quote_id = p_quote_id)
       or exists (select 1 from public.event_refunds where quote_id = p_quote_id) then
      raise exception 'This event has payments, a client approval or refunds on record, so it can''t be deleted. Cancel it instead.'
        using errcode = 'P0001';
    end if;
    update public.quotes q set deleted_at = now(), deleted_by = v_me, deleted_reason = 'manual',
                               archived_at = null, archived_by = null, archived_reason = null, link_expired_at = null
     where q.id = p_quote_id and q.org_id = v_org and q.deleted_at is null;
  else
    update public.quotes q set archived_at = now(), archived_by = v_me, archived_reason = 'manual', link_expired_at = null
     where q.id = p_quote_id and q.org_id = v_org and q.archived_at is null and q.deleted_at is null;
  end if;
  if found then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
      values (v_me, v_email, case when p_shelf = 'archive' then 'quote.moved_to_archive' else 'quote.moved_to_deleted' end,
              'quotes', p_quote_id::text, p_quote_id, v_org, jsonb_build_object('auto', false, 'reason', 'manual'));
  end if;
  return jsonb_build_object('id', p_quote_id, 'shelf', case when p_shelf = 'archive' then 'archived' else 'deleted' end);
end $$;
revoke all on function public.move_quote_to_shelf(uuid, text) from public, anon;
grant execute on function public.move_quote_to_shelf(uuid, text) to authenticated;

create or replace function public.restore_quote_from_shelf(p_quote_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_email text; v_from text;
        v_pending boolean := false;
begin
  if v_me is null or v_org is null or not public.has_area('quotes', 'edit') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v_pending;
    if coalesce(v_pending, false) then raise exception 'set your own password first' using errcode = '42501'; end if;
  end if;
  select case when q.deleted_at is not null then 'deleted' when q.archived_at is not null then 'archived' end
    into v_from from public.quotes q where q.id = p_quote_id and q.org_id = v_org;
  if not found then raise exception 'no such quote' using errcode = '42501'; end if;
  if v_from is null then
    return jsonb_build_object('id', p_quote_id, 'restored', false);       -- already in the normal lists
  end if;
  -- shelf_restored_at keeps it from being moved again by the link rule for N days
  update public.quotes q
     set archived_at = null, archived_by = null, archived_reason = null,
         deleted_at = null, deleted_by = null, deleted_reason = null,
         link_expired_at = null, shelf_restored_at = now()
   where q.id = p_quote_id and q.org_id = v_org;
  select u.email into v_email from auth.users u where u.id = v_me;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
    values (v_me, v_email, 'quote.restored', 'quotes', p_quote_id::text, p_quote_id, v_org,
            jsonb_build_object('from', v_from));
  return jsonb_build_object('id', p_quote_id, 'restored', true, 'from', v_from);
end $$;
revoke all on function public.restore_quote_from_shelf(uuid) from public, anon;
grant execute on function public.restore_quote_from_shelf(uuid) to authenticated;

-- ---- 6) Control Center (studio admin) ----------------------------------------------
create or replace function public.admin_get_link_expiry_shelf()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.org_link_expiry_shelf; v_days int; v_waiting int;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into s from public.org_link_expiry_shelf x where x.org_id = v_org;
  select coalesce(a.days, 10) into v_days from public.org_link_autoexpire a where a.org_id = v_org;
  -- how many quotes would move right now with the current number of days
  select count(*) into v_waiting from public.link_expiry_shelf_candidates(v_org, coalesce(v_days, 10));
  return jsonb_build_object('action', coalesce(s.action, 'keep'), 'updated_at', s.updated_at,
    'last_run_at', s.last_run_at, 'last_run_moved', s.last_run_moved, 'waiting', v_waiting);
end $$;

create or replace function public.admin_set_link_expiry_shelf(p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_old text; v_email text;
        v_pending boolean := false;
begin
  if v_me is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v_pending;
    if coalesce(v_pending, false) then raise exception 'set your own password first' using errcode = '42501'; end if;
  end if;
  if p_action is null or p_action not in ('keep', 'archive', 'delete') then
    raise exception 'choose keep, archive or delete' using errcode = '22023';
  end if;
  select x.action into v_old from public.org_link_expiry_shelf x where x.org_id = v_org for update;
  insert into public.org_link_expiry_shelf as x (org_id, action, updated_by, updated_at)
    values (v_org, p_action, v_me, now())
  on conflict (org_id) do update
    set action = excluded.action, updated_by = excluded.updated_by, updated_at = now(),
        -- a new choice runs at the next page open, not 10 minutes later
        last_run_at = case when x.action is distinct from excluded.action then null else x.last_run_at end;
  if coalesce(v_old, 'keep') is distinct from p_action then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (v_me, v_email, 'link_expiry_shelf.set', 'organizations', v_org::text, v_org,
              jsonb_build_object('action', jsonb_build_object('old', coalesce(v_old, 'keep'), 'new', p_action)));
  end if;
  return public.admin_get_link_expiry_shelf();
end $$;

do $$ declare f text; begin
  foreach f in array array['admin_get_link_expiry_shelf()', 'admin_set_link_expiry_shelf(text)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

-- ---- 7) pg_cron, ONLY if it is already installed (never created here) ---------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_link_expiry_shelf') then
        perform cron.schedule('helm_link_expiry_shelf', '*/30 * * * *',
                              'select public.apply_link_expiry_archive_all()');
      end if;
    exception when others then
      raise notice 'pg_cron present but the job could not be scheduled (%); the app runs it on page open instead', sqlerrm;
    end;
  end if;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select o.name, s.action, s.last_run_at, s.last_run_moved from public.org_link_expiry_shelf s join public.organizations o on o.id = s.org_id;
-- select count(*) filter (where archived_at is not null) archived, count(*) filter (where deleted_at is not null) deleted from public.quotes;
