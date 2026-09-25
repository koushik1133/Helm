# Environment separation & staging setup

Wave 6 goal: an **isolated staging Supabase** so authenticated E2E and the
two-tenant authorization red-team can run against real RLS **without ever
touching production data**.

---

## 0. Current state (as of Wave 6)

- `public/config.js` is **fail-closed on localhost** (Wave 6 ENV P1): a
  local/LAN/`.local`/loopback host does **not** connect to production Supabase.
  It uses a staging project if one is configured, else an explicit prod opt-in,
  else it blanks the credentials and shows a developer error.
- Production DB (`nqltzgiwznphugcfhmbm`) is **PRODUCTION APPLIED — VERIFIED**
  through Wave 5 + phase97/98. **Staging must be a SEPARATE project** — never a
  branch of, or a shared ref with, production.
- `scripts/check-env-safety.mjs` (CI) enforces the fail-closed guard.

The config hook the app already understands (no code change needed to use staging):

```js
// Set BEFORE public/config.js loads (e.g. in a config.staging.js served ONLY on
// the staging host, or a <script> block on the staging deploy).
window.HELM_STAGING_SUPABASE = {
  url: "https://<STAGING_REF>.supabase.co",
  anonKey: "<STAGING_ANON_KEY>"   // anon key only — never the service_role key
};
```

When present on a localhost/LAN host, the app uses staging and logs
`Local development using the STAGING Supabase project`.

---

## 1. Create the staging project

1. Supabase dashboard → **New project** (same org is fine). Name it e.g.
   `helm-staging`. Choose a **different** region only if you want; region does not
   matter for isolation.
2. Record its **Project Ref** (`<STAGING_REF>`), **anon key**
   (Settings → API), and **database password** (Settings → Database).
3. Confirm it is a distinct project: its ref must **not** be
   `nqltzgiwznphugcfhmbm`.

> Do not use a Supabase *branch* of production for adversarial mutation testing —
> a branch can share configuration/data lineage. Use a standalone project.

---

## 2. Build the staging schema

You need the staging schema to match the **verified production schema exactly**
(all phases through 98, org-scoped SECURITY DEFINER functions, RLS, grants). Two
options — **Option A is recommended** because it guarantees parity and avoids
migration ordering.

### Option A (recommended) — clone the schema from production, no data

This copies **structure only** (tables, functions, policies, grants, indexes) —
**no rows** — from prod into staging. You run it from your machine with `pg_dump`
/`psql` (Postgres client tools). Get both connection strings from each project's
Settings → Database → **Connection string › URI** (they include the password).

```bash
# 1) Dump PRODUCTION schema only (no data), public schema, incl. RLS & grants.
# (grants/privileges are included by default — do NOT pass --no-privileges)
pg_dump "postgresql://postgres:<PROD_DB_PASSWORD>@db.nqltzgiwznphugcfhmbm.supabase.co:5432/postgres" \
  --schema=public --schema-only --no-owner \
  --file=helm-schema.sql

# 2) Load it into STAGING.
psql "postgresql://postgres:<STAGING_DB_PASSWORD>@db.<STAGING_REF>.supabase.co:5432/postgres" \
  --file=helm-schema.sql
```

Notes:
- `--schema-only` = **no customer data** is copied. Good — staging starts empty.
- If `pg_dump` warns about `auth`/`storage` schemas, ignore — those are managed by
  Supabase and already exist in the new project. Only `public` is ours.
- After loading, jump to **Step 3**.

### Option B (fallback) — replay migrations

Only if you cannot use `pg_dump`. In the staging project's SQL Editor:

1. Run `supabase/full-schema/complete-setup.sql` — the frozen bootstrap
   (~phase 55–58). This is acceptable **only on a brand-new empty DB** as a base.
2. Run every numbered `supabase/phaseNN-name.sql` **in ascending order from 59
   through 98** (do not skip; phase73/76/77/85+ are mandatory for isolation &
   money integrity). See `docs/full-schema/README.md` and `TECHNICAL-HANDOFF.md`.
3. Run `supabase/wave5/HELM-CUMULATIVE-UPGRADE-WAVES-1-5.sql` to land the final
   hardened definitions (idempotent).
4. Run `supabase/phase97-fix-app_config-multitenant.sql` and
   `supabase/phase98-revoke-anon-set-pricing.sql`.

Option B is error-prone; prefer A.

### Verify staging parity (either option)

Run `supabase/wave5/WAVE-05-FINAL-VERIFY.sql` in the **staging** SQL Editor. It is
100% read-only. Expect the same all-PASS grid as production (the anon
`set_pricing_config` row should be PASS because Option A copies grants and Option B
ends with phase98). If any high-severity row FAILs, fix parity before testing.

---

## 3. Configure staging Auth

Supabase (staging) → Authentication → **URL Configuration**:

- **Site URL:** the staging host you will serve from. For local testing use
  `http://localhost:4173` (the `server.js` dev port). For a hosted staging Vercel
  use that URL.
- **Redirect URLs:** add the login path for each staging origin, e.g.
  `http://localhost:4173/login.html`, `http://localhost:4173/**`, and your hosted
  staging URL + `/login.html` + `/**`.

Providers:
- **Email**: enable (email/password) — needed for the synthetic test users.
- **Google**: optional for staging. If you enable it, add a **separate** Google
  OAuth client whose redirect URI is
  `https://<STAGING_REF>.supabase.co/auth/v1/callback`. Do **not** reuse the prod
  client. For the red-team, email/password users are sufficient.

---

## 4. Point the app at staging

Pick one:

- **Local dev (simplest):** create `public/config.staging.js` (git-ignored, do NOT
  commit keys) that sets `window.HELM_STAGING_SUPABASE = {url, anonKey}`, and load
  it **before** `config.js` only when developing against staging. Or just paste the
  `HELM_STAGING_SUPABASE` object into the browser console before first load and
  reload — the fail-closed guard will pick it up.
- **Hosted staging deploy:** serve a `config.staging.js` (or inline `<script>`)
  containing the `HELM_STAGING_SUPABASE` block on the staging host only. Never ship
  it to production or commit staging keys into `config.js`.

Confirm the footer / console shows staging, not production, before any mutation.

---

## 5. Seed two synthetic tenants (for the red-team)

Create two isolated orgs, each with its own user, using **synthetic** emails you
control. In the **staging** SQL Editor / Auth dashboard:

1. Auth → **Users → Add user** twice (email + password), e.g.
   `orga.owner@staging.helm.test` and `orgb.owner@staging.helm.test`.
   Use throwaway passwords you record locally — never real customer creds.
2. For each user, run onboarding in the app (sign in → create studio) so each gets
   its **own** `org_id`, OR create the orgs via the app's normal `create_studio`
   flow. Do not hand-forge `org_id` values.
3. As Org A, create a couple of records in each area you will attack: a quote, a
   client, an event, a saved layout, a coupon. Repeat as Org B with clearly
   different values so cross-reads are obvious.

Record: `USER_A email/password + ORG_A id`, `USER_B email/password + ORG_B id`,
and a sample **row id** owned by each org (quote id, layout id, etc.).

---

## 6. Run the two-tenant authorization red-team (Wave 6 Agents 5/6)

Goal: prove **Org A cannot touch Org B** via **direct API/RPC**, not just UI
hiding. Use the staging anon key + each user's access token (get a token by signing
in through the app and copying it from the session, or via
`supabase.auth.signInWithPassword` in a script).

For every area, signed in as **User A**, attempt to act on **Org B's** ids and
expect **0 rows / denied**:

- read/update/delete B's quotes, clients, events, layouts, coupons
- `select` B rows by id through PostgREST (`/rest/v1/<table>?id=eq.<B_id>`)
- call privileged RPCs (`generate_approval_token`, `mark_paid`,
  `record_payment`, `set_pricing_config`, `save_quotation_version`,
  `export_org_data`) with **B's** ids / while authenticated as A
- attempt to forge `org_id` on insert/update (should be overridden by the
  stamping trigger / rejected by RLS)
- exercise parent→child relationships (e.g. a payment on B's quote)

Then repeat **B→A**. Any successful cross-tenant read/write/RPC is a **Critical**
finding. Record each attempt as PASS (denied) / FAIL (leaked) with the exact
request and response.

There are placeholder specs to fill in:
`test/authz-tenant-isolation.NOT-TESTED.md`, `test/layouts-rls.NOT-TESTED.md`.
Only after this runs on staging do those findings move from *source/automated
verified* to **STAGING VERIFIED**.

---

## Safety rules (non-negotiable)

- **Never** point automated mutation tests at production.
- **Never** commit staging or prod keys into `public/config.js`, and never put a
  `service_role` key in any client code.
- Staging users/data are synthetic only — no real customers, no real messages, no
  real payments.
- Razorpay/WhatsApp stay **DEFERRED — SECURELY DISABLED** on staging too
  (`liveChannels` all false).
