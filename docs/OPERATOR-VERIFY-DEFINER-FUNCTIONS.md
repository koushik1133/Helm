# Operator note — verifying deployed SECURITY DEFINER functions

**Purpose:** confirm that a database has the **org-scoped (phase73+) bodies** of the
privileged functions, not the pre-hardening ones from the stale
`full-schema/complete-setup.sql` snapshot.

## Ground rules (read first)

- **Do not run these against production casually.** They are read-only
  (`pg_get_functiondef`, `information_schema`, `pg_proc`, `pg_policies`), but run
  them only on an **approved staging database or a schema export** taken with
  permission. Never paste production connection strings, secrets, or exported rows
  into logs, tickets, or chat.
- **Source files cannot prove which body is deployed.** The repo contains multiple
  `create or replace` definitions of these functions (org-scoped only in
  `phase73-definer-org-isolation-final.sql`; non-org-scoped in
  `complete-setup.sql` / `01-core-auth-quotes.sql` / `quotes.sql` /
  `admin-users.sql` / `setup-complete.sql`). Only the live database says which one
  ran last.
- These queries verify the **function body, grants, `SECURITY DEFINER` status,
  `search_path`, and the org/role checks**. They do **not** prove runtime
  authorization — that needs the runtime tests below.

## 1. Function bodies — must contain the org check

Run and read each body. PASS criteria in the comment.

```sql
-- admin_* and confirm_quote: body MUST contain  org_id = public.current_org_id()
select pg_get_functiondef('public.admin_set_role(uuid,text)'::regprocedure);
select pg_get_functiondef('public.admin_create_user(text,text,text)'::regprocedure);
select pg_get_functiondef('public.admin_delete_user(uuid)'::regprocedure);
select pg_get_functiondef('public.confirm_quote(uuid,jsonb,jsonb)'::regprocedure);
--   FAIL (pre-hardening / cross-tenant) if the body scopes only by  where id = ...
--   with no current_org_id() in the target/exists-check.

-- version + payment numbering and export gates
select pg_get_functiondef('public.save_quotation_version(uuid,jsonb)'::regprocedure);
select pg_get_functiondef('public.record_payment(uuid,numeric,text,uuid,uuid,text)'::regprocedure);
select pg_get_functiondef('public.export_org_data()'::regprocedure);                        -- expect is_admin()
select pg_get_functiondef('public.export_tenant_organization_package()'::regprocedure);     -- expect has_area('users','view')
```

## 2. Metadata — SECURITY DEFINER, search_path, owner, grants

```sql
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef                       as security_definer,   -- expect true
       p.proconfig                       as settings,           -- expect search_path=...
       r.rolname                         as owner,
       (select string_agg(g.grantee::text, ',')
          from information_schema.role_routine_grants g
         where g.routine_schema = 'public' and g.routine_name = p.proname) as grantees
  from pg_proc p
  join pg_roles r on r.oid = p.proowner
 where p.pronamespace = 'public'::regnamespace
   and p.proname in (
     'admin_create_user','admin_set_role','admin_delete_user','confirm_quote',
     'save_quotation_version','record_payment',
     'export_org_data','export_tenant_organization_package')
 order by p.proname;
--   Expect: security_definer = true; settings include search_path;
--           grantees do NOT include anon for the admin_/export functions.
```

## 3. Tenant-coverage backstop (defense in depth)

```sql
-- every public table with an org_id column should have an RLS policy
-- referencing current_org_id(). Expect ZERO rows.
select t.tablename
  from pg_tables t
 where t.schemaname = 'public'
   and exists (select 1 from information_schema.columns c
                where c.table_schema='public' and c.table_name=t.tablename
                  and c.column_name='org_id')
   and not exists (select 1 from pg_policies pol
                where pol.schemaname='public' and pol.tablename=t.tablename
                  and pol.qual ilike '%current_org_id%');
```

## 4. Runtime authorization tests — require two synthetic orgs + users

Body/metadata checks above cannot prove access control end-to-end. To prove it,
an **explicitly isolated** staging environment must be seeded with **two synthetic
organizations and at least one user each**, then assert (never on production):

- User A can read/mutate Org A rows; **cannot** read/mutate Org B rows (and vice
  versa).
- Anonymous and expired sessions are denied.
- A valid parent id from Org B cannot bypass Org A child-record checks.
- `admin_set_role` / `admin_delete_user` by Org A's admin cannot affect Org B.
- `confirm_quote` cannot confirm another org's quote by id.
- Exports return only the caller's org and obey their privilege gate.
- A revoked user loses access after refresh / session renewal.

Do not fabricate credentials or results. If no isolated environment exists, record
these as **NOT TESTED**.
