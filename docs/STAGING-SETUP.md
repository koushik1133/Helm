# Environment separation & staging setup

## The problem (Wave 3 finding ENV / DEPLOY-02)
`public/config.js` ships the **production** Supabase URL + anon key (the anon key
is public by design and RLS-protected — that part is fine). But because there was
no environment separation, pages served from **localhost** connected straight to
the **production** database. Authenticated actions from a dev machine could read
or mutate live tenant data.

## What Wave 4 changed (source-level, fail-closed)
`public/config.js` now detects a localhost/`.local`/loopback hostname and, unless
the operator explicitly opts in, **blanks the Supabase credentials**. With no URL,
`store-api.js` falls back to the local Node backend (`server.js` `/api/layouts`)
and then `localStorage` — it does **not** touch production.

`scripts/check-env-safety.mjs` (in CI) fails if this guard is removed.

### Deliberately targeting production from localhost (read-only debugging only)
```js
window.HELM_ALLOW_PROD_FROM_LOCALHOST = true;      // before config.js loads
// or, in the browser console:
localStorage.setItem('helm.allowProdFromLocalhost','1');
```
A console warning is emitted whenever this override is active. Use it read-only.

## Wiring a real isolated staging Supabase (recommended future step)
> Requires authorization to create a Supabase project — **not** done automatically.

1. Create a **separate** Supabase project for staging (its own DB, its own keys).
2. Apply the canonical migrations in order: the numbered `supabase/phaseNN-name.sql`
   files (never `full-schema/complete-setup.sql` — see `supabase/full-schema/README.md`).
3. Provide staging credentials **without committing them to prod config** — e.g.
   a separate `config.staging.js` served only on the staging host, or a build-time
   swap. Never put staging/prod keys for one env in the other.
4. Seed two synthetic organizations + test users for the tenant-isolation suite
   (`test/authz-tenant-isolation.NOT-TESTED.md`, `test/layouts-rls.NOT-TESTED.md`).
5. Run the pending DB/RLS tests against staging — only then can findings move from
   *source/automated verified* to *staging verified*.

**Never** point automated mutation tests at production.
