-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0052 lifecycle transitions + re-approval on price change (one paste) (2026-10-08)
--   * Stage moves: back = always; forward only when its checks pass —
--       Confirmed/Planning need the client's OTP approval, Settlement needs the event date
--       to have arrived, Closed only from the Closure page. An ADMIN can move past a
--       check with a written reason (recorded in lifecycle_stage_overrides + audit_log).
--   * If an APPROVED quote's total changes after the client approved it, the approval is
--     marked stale ("Price changed after approval — client must approve again"):
--     confirm & lock, plan lock and client payment / payment links are blocked until the
--     client approves the new total through a NEW approval link (OTP). Consent history is kept.
-- REQUIRES 0049 — the preflight stops if not. STAGING first, then PROD.
-- WHAT IT TOUCHES: 4 new columns on quotes (server-only), 1 new table (RLS on, read-only for
--   members), wraps 6 functions (old bodies kept as *__pre0052), 2 new triggers, 3 new RPCs.
--   NO row is deleted, NO existing stage or approval is changed by running this.
-- SAFE TO RE-RUN. If anything fails, it rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regprocedure('public._a49_close_gate(uuid,text)') is null then raise exception 'STOP: 0049 not installed'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP: current_org_id() missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null then raise exception 'STOP: has_area() missing'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP: audit_log missing'; end if;
  raise notice 'Preflight OK — applying 0052…';
end $$;
-- ---- 0) keep this database's own bodies (rename once) --------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['set_lifecycle_stage', 'uuid, text'],
    ['confirm_quote',       'uuid, jsonb, jsonb'],
    ['set_plan_lock',       'uuid, boolean'],
    ['create_payment',      'uuid'],
    ['payment_link_begin',  'uuid, integer'],
    ['public_get_quote',    'uuid']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0052', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        raise exception '0052: public.%(%) is missing on this database', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0052');
    end if;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0052', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1] || '__pre0052', f[2]);
  end loop;
end $$;

-- ---- 1) columns + override table ---------------------------------------------------
alter table public.quotes add column if not exists consent_stale boolean not null default false;
alter table public.quotes add column if not exists consent_stale_at timestamptz;
alter table public.quotes add column if not exists consent_stale_prev_total numeric;
alter table public.quotes add column if not exists consent_stale_new_total numeric;
-- server-owned: never client-writable (0049 column allow-list is not extended)
revoke update (consent_stale, consent_stale_at, consent_stale_prev_total, consent_stale_new_total)
  on public.quotes from public, anon, authenticated;

create table if not exists public.lifecycle_stage_overrides (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete restrict,
  quote_id    uuid not null,
  actor       uuid,
  actor_email text,
  from_stage  text,
  to_stage    text not null,
  reason      text not null check (length(btrim(reason)) between 5 and 1000),
  blockers    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists lifecycle_stage_overrides_quote_idx on public.lifecycle_stage_overrides(org_id, quote_id);
alter table public.lifecycle_stage_overrides enable row level security;
revoke all on public.lifecycle_stage_overrides from public, anon, authenticated;
grant select on public.lifecycle_stage_overrides to authenticated;
grant all on public.lifecycle_stage_overrides to service_role;
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    drop trigger if exists zz_quote_org_match on public.lifecycle_stage_overrides;
    create trigger zz_quote_org_match before insert or update on public.lifecycle_stage_overrides
      for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    drop trigger if exists zzz_studio_read_only on public.lifecycle_stage_overrides;
    create trigger zzz_studio_read_only before insert or update or delete on public.lifecycle_stage_overrides
      for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;
drop policy if exists "a52 stage overrides read" on public.lifecycle_stage_overrides;
create policy "a52 stage overrides read" on public.lifecycle_stage_overrides for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));

-- ---- 2) helpers ------------------------------------------------------------------------
create or replace function public._a52_stage_idx(p text)
returns integer language sql immutable set search_path = '' as $$
  select array_position(array['lead','discovery','proposal','quote','confirmed','planning',
                              'resources','ready','event_day','settlement','closed']::text[], p);
$$;

create or replace function public._a52_num(p jsonb)
returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) not in ('number', 'string') then return null; end if;
  return round((p #>> '{}')::numeric, 2);
exception when others then return null;
end $$;

-- the latest agreed consent's total (null = never approved)
create or replace function public._a52_consent_total(p_quote uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select round(c.quote_total, 2) from public.quote_consents c
   where c.quote_id = p_quote and c.agreed
   order by c.created_at desc, c.id desc limit 1;
$$;

create or replace function public._a52_has_consent(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.quote_consents c where c.quote_id = p_quote and c.agreed);
$$;

-- raise HL428 when the client's approval is stale
create or replace function public._a52_assert_fresh(p_quote uuid, p_action text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare q record;
begin
  select q2.consent_stale, q2.consent_stale_prev_total, q2.consent_stale_new_total into q
    from public.quotes q2 where q2.id = p_quote;
  if coalesce(q.consent_stale, false) then
    raise exception 'Price changed after approval — the client must approve again before you can %.', p_action
      using errcode = 'HL428',
            detail = jsonb_build_object('approved_total', q.consent_stale_prev_total,
                                        'new_total', q.consent_stale_new_total)::text,
            hint = 'Send the client a new approval link.';
  end if;
end $$;

do $$ declare f text; begin
  foreach f in array array['_a52_stage_idx(text)', '_a52_num(jsonb)', '_a52_consent_total(uuid)',
                           '_a52_has_consent(uuid)', '_a52_assert_fresh(uuid, text)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- 3) re-approval: stale flag on price change ---------------------------------------
create or replace function public.tg_a52_consent_stale()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ok numeric; v_new numeric;
begin
  if new.pricing is not distinct from old.pricing then return new; end if;
  if not (old.approval_status = 'approved' or coalesce(old.consent_stale, false)) then return new; end if;
  v_ok := public._a52_consent_total(new.id);
  if v_ok is null then return new; end if;
  v_new := public._a52_num(new.pricing -> 'total');
  if v_new is not distinct from v_ok then
    if coalesce(old.consent_stale, false) then             -- back to the approved total
      new.consent_stale := false; new.consent_stale_at := null;
      new.consent_stale_prev_total := null; new.consent_stale_new_total := null;
      if new.approval_status = 'sent' then new.approval_status := 'approved'; end if;
    end if;
    return new;
  end if;
  if old.approval_status = 'approved' and new.approval_status = 'approved' then
    new.approval_status := 'sent';
  end if;
  if not coalesce(old.consent_stale, false) then new.consent_stale_at := now(); end if;
  new.consent_stale := true;
  new.consent_stale_prev_total := v_ok;
  new.consent_stale_new_total := v_new;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'consent_stale', 'quotes', new.id::text, new.id,
            jsonb_build_object('approved_total', v_ok, 'new_total', v_new), new.org_id);
  begin
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (new.id, 'in_app', 'reapproval_required', 'simulated',
              jsonb_build_object('code', new.code, 'approved_total', v_ok, 'new_total', v_new,
                                 'message', 'Price changed after approval — client must approve again'), new.org_id);
  exception when check_violation then
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (new.id, 'email', 'reapproval_required', 'simulated',
              jsonb_build_object('code', new.code, 'approved_total', v_ok, 'new_total', v_new,
                                 'message', 'Price changed after approval — client must approve again'), new.org_id);
  end;
  return new;
end $$;
revoke all on function public.tg_a52_consent_stale() from public, anon, authenticated;
-- "zzzz_" sorts after every pricing-authority / money-guard BEFORE trigger (reads the final total)
drop trigger if exists zzzz_a52_consent_stale on public.quotes;
create trigger zzzz_a52_consent_stale before update of pricing on public.quotes
  for each row execute function public.tg_a52_consent_stale();

-- a new agreed consent clears the flag; an early-stage quote moves to 'confirmed'
create or replace function public.tg_a52_consent_fresh()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.agreed then return new; end if;
  update public.quotes q
     set consent_stale = false, consent_stale_at = null,
         consent_stale_prev_total = null, consent_stale_new_total = null
   where q.id = new.quote_id and q.consent_stale;
  update public.quotes q set lifecycle_stage = 'confirmed'
   where q.id = new.quote_id and coalesce(q.lifecycle_stage, 'quote') in ('lead', 'discovery', 'proposal', 'quote');
  return new;
end $$;
revoke all on function public.tg_a52_consent_fresh() from public, anon, authenticated;
drop trigger if exists zz_a52_consent_fresh on public.quote_consents;
create trigger zz_a52_consent_fresh after insert on public.quote_consents
  for each row execute function public.tg_a52_consent_fresh();

-- ---- 4) lifecycle transitions ---------------------------------------------------------
-- what blocks moving p_quote to p_stage: [] = allowed; {stale:true} entries can't be overridden
create or replace function public._a52_stage_blockers(p_quote uuid, p_stage text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare q record; v_from int; v_to int; b jsonb := '[]'::jsonb;
begin
  select q2.lifecycle_stage, q2.event_date, q2.consent_stale into q from public.quotes q2 where q2.id = p_quote;
  v_from := coalesce(public._a52_stage_idx(coalesce(q.lifecycle_stage, 'quote')), 4);
  v_to := public._a52_stage_idx(p_stage);
  if v_to is null or v_to <= v_from then return b; end if;            -- same / backward: free
  if v_from < 5 and v_to >= 5 then                                    -- crosses 'confirmed'
    if coalesce(q.consent_stale, false) then
      b := b || jsonb_build_object('gate', 'confirmed', 'stale', true,
             'message', 'the price changed after the client approved — the client must approve again');
    elsif not public._a52_has_consent(p_quote) then
      b := b || jsonb_build_object('gate', 'confirmed',
             'message', 'the client has not approved the quote yet (OTP consent)');
    end if;
  elsif v_from < 6 and v_to >= 6 and coalesce(q.consent_stale, false) then   -- planning while stale
    b := b || jsonb_build_object('gate', 'planning', 'stale', true,
           'message', 'the price changed after the client approved — the client must approve again');
  end if;
  if v_from < 10 and v_to >= 10 and (q.event_date is null or q.event_date > current_date) then
    b := b || jsonb_build_object('gate', 'settlement',
           'message', case when q.event_date is null then 'the event has no date yet'
                           else 'the event date (' || to_char(q.event_date, 'DD Mon YYYY') || ') has not arrived' end);
  end if;
  return b;
end $$;
revoke all on function public._a52_stage_blockers(uuid, text) from public, anon, authenticated;
grant execute on function public._a52_stage_blockers(uuid, text) to service_role;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text, p_override_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_cur text; b jsonb; v_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
        v_msg text;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_stage = 'closed' then raise exception 'Close the event from its Closure page.' using errcode = '22023'; end if;
  if public._a52_stage_idx(p_stage) is null then raise exception 'invalid stage: %', p_stage using errcode = '22023'; end if;
  select coalesce(q.lifecycle_stage, 'quote') into v_cur from public.quotes q
   where q.id = p_quote_id and q.org_id = v_org for update;
  if not found then raise exception 'no such event' using errcode = '42501'; end if;
  if v_cur = 'closed' and p_stage <> 'closed' then
    raise exception 'This event is closed — reopen it from its Closure page.' using errcode = '22023';
  end if;
  b := public._a52_stage_blockers(p_quote_id, p_stage);
  if jsonb_array_length(b) > 0 then
    select string_agg(x ->> 'message', '; ') into v_msg from jsonb_array_elements(b) x;
    if exists (select 1 from jsonb_array_elements(b) x where (x ->> 'stale')::boolean) then
      raise exception 'Can''t move to % — %.', p_stage, v_msg
        using errcode = 'HL428', detail = b::text, hint = 'Send the client a new approval link.';
    end if;
    if v_reason is null then
      raise exception 'Can''t move to % yet — %.', p_stage, v_msg
        using errcode = 'HL409', detail = b::text, hint = 'An admin can move it anyway with a reason.';
    end if;
    if coalesce(public.user_role(), '') <> 'admin' then
      raise exception 'Only an admin can skip a stage check (%).', v_msg using errcode = '42501';
    end if;
    if length(v_reason) < 5 or length(v_reason) > 1000 then
      raise exception 'override reason must be 5 to 1000 characters' using errcode = '22023';
    end if;
    insert into public.lifecycle_stage_overrides(org_id, quote_id, actor, actor_email, from_stage, to_stage, reason, blockers)
      values (v_org, p_quote_id, auth.uid(), (select u.email from auth.users u where u.id = auth.uid()),
              v_cur, p_stage, v_reason, b);
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'stage_override', 'quotes',
              p_quote_id::text, p_quote_id,
              jsonb_build_object('from', v_cur, 'to', p_stage, 'reason', v_reason, 'blockers', b), v_org);
  end if;
  return public.set_lifecycle_stage__pre0052(p_quote_id, p_stage);
end $$;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  return public.set_lifecycle_stage(p_quote_id, p_stage, null::text);
end $$;

-- read-only: what blocks a move (for the stepper)
create or replace function public.lifecycle_stage_blockers(p_quote_id uuid, p_stage text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_area('quotes', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  return public._a52_stage_blockers(p_quote_id, p_stage);
end $$;

-- ---- 5) gates while the approval is stale -----------------------------------------------
create or replace function public.confirm_quote(p_quote_id uuid, p_client jsonb, p_pricing jsonb)
returns public.quotes language plpgsql volatile security definer set search_path = '' as $$
declare r public.quotes;
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) then
    raise exception 'no such event' using errcode = '42501';
  end if;
  perform public._a52_assert_fresh(p_quote_id, 'confirm & lock the quote');
  r := public.confirm_quote__pre0052(p_quote_id, p_client, p_pricing);
  perform public._a52_assert_fresh(p_quote_id, 'confirm & lock the quote');   -- this edit made it stale: roll back
  return r;
end $$;

create or replace function public.set_plan_lock(p_quote_id uuid, p_locked boolean)
returns public.event_plan language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_locked then perform public._a52_assert_fresh(p_quote_id, 'lock the plan'); end if;
  return public.set_plan_lock__pre0052(p_quote_id, p_locked);
end $$;

create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_q uuid;
begin
  select q.id into v_q from public.quotes q where q.approval_token = p_token;
  if v_q is not null then perform public._a52_assert_fresh(v_q, 'pay'); end if;
  return public.create_payment__pre0052(p_token);
end $$;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer default 4320)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.quotes q where q.approval_token = p_token and q.consent_stale) then
    return jsonb_build_object('action', 'not_approved', 'reason', 'reapproval_required');
  end if;
  return public.payment_link_begin__pre0052(p_token, p_ttl_minutes);
end $$;

create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_out jsonb;
begin
  v_out := public.public_get_quote__pre0052(p_token);
  if v_out is not null and jsonb_typeof(v_out) = 'object' then
    v_out := v_out || jsonb_build_object('reapproval_required',
      coalesce((select q.consent_stale from public.quotes q where q.approval_token = p_token), false));
  end if;
  return v_out;
end $$;

-- studio: rotate the client link so the client approves the new total (fresh OTP flow)
create or replace function public.reissue_approval_link(p_quote_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_stale boolean;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select q.consent_stale into v_stale from public.quotes q
   where q.id = p_quote_id and q.org_id = public.current_org_id() for update;
  if not found then raise exception 'not authorized for this event' using errcode = '42501'; end if;
  if not v_stale then raise exception 'This quote doesn''t need a new approval.' using errcode = '22023'; end if;
  perform public.revoke_approval_token(p_quote_id);     -- expires open OTPs too
  return public.generate_approval_token(p_quote_id);
end $$;

-- ---- 6) grants ----------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['set_lifecycle_stage(uuid, text)', 'set_lifecycle_stage(uuid, text, text)',
      'lifecycle_stage_blockers(uuid, text)', 'confirm_quote(uuid, jsonb, jsonb)', 'set_plan_lock(uuid, boolean)',
      'reissue_approval_link(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated, service_role';
  end loop;
  foreach f in array array['create_payment(uuid)', 'public_get_quote(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    execute 'grant execute on function public.' || f || ' to anon, authenticated, service_role';
  end loop;
  execute 'revoke all on function public.payment_link_begin(uuid, integer) from public, anon, authenticated';
  execute 'grant execute on function public.payment_link_begin(uuid, integer) to service_role';
end $$;

notify pgrst, 'reload schema';

-- VERIFY — every row must say ok = true
select item, ok from (values
  ('old bodies kept as __pre0052',
     to_regprocedure('public.set_lifecycle_stage__pre0052(uuid,text)') is not null
     and to_regprocedure('public.confirm_quote__pre0052(uuid,jsonb,jsonb)') is not null
     and to_regprocedure('public.create_payment__pre0052(uuid)') is not null
     and to_regprocedure('public.payment_link_begin__pre0052(uuid,integer)') is not null
     and to_regprocedure('public.set_plan_lock__pre0052(uuid,boolean)') is not null
     and to_regprocedure('public.public_get_quote__pre0052(uuid)') is not null),
  ('wrappers call the kept bodies',
     pg_get_functiondef('public.set_lifecycle_stage(uuid,text,text)'::regprocedure) like '%set_lifecycle_stage__pre0052%'
     and pg_get_functiondef('public.create_payment(uuid)'::regprocedure) like '%create_payment__pre0052%'),
  ('stale trigger on quotes', exists (select 1 from pg_trigger where tgname = 'zzzz_a52_consent_stale' and tgrelid = 'public.quotes'::regclass)),
  ('fresh trigger on quote_consents', exists (select 1 from pg_trigger where tgname = 'zz_a52_consent_fresh' and tgrelid = 'public.quote_consents'::regclass)),
  ('overrides table RLS on', (select relrowsecurity from pg_class where oid = 'public.lifecycle_stage_overrides'::regclass)),
  ('clients cannot write overrides', not has_table_privilege('authenticated', 'public.lifecycle_stage_overrides', 'insert')),
  ('clients cannot write consent_stale', not has_column_privilege('authenticated', 'public.quotes', 'consent_stale', 'update')),
  ('anon cannot change stages', not has_function_privilege('anon', 'public.set_lifecycle_stage(uuid,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.reissue_approval_link(uuid)', 'execute')),
  ('kept bodies not callable by clients', not has_function_privilege('authenticated', 'public.set_lifecycle_stage__pre0052(uuid,text)', 'execute')
     and not has_function_privilege('anon', 'public.create_payment__pre0052(uuid)', 'execute')),
  ('client approval/payment still callable', has_function_privilege('anon', 'public.create_payment(uuid)', 'execute')
     and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')),
  ('payment links service-role only', not has_function_privilege('authenticated', 'public.payment_link_begin(uuid,integer)', 'execute'))
) v(item, ok);
-- informational: quotes currently waiting for re-approval (0 right after install)
select count(*) as stale_quotes from public.quotes where consent_stale;
