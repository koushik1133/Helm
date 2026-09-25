# Authorization / tenant-isolation regression suite — NOT TESTED (needs staging DB + 2 synthetic orgs)

**Status: NOT TESTED.** No approved staging database and no two synthetic
organizations exist in this environment. These are executable-ready
specifications only; they were **not run**. Do not mark any of these Verified
Fixed until they execute green against an approved, isolated staging DB seeded
with two synthetic tenants (never production, never real customer data).

Protects: PR-DEPLOY-01 (stale non-org-scoped DEFINER bodies must not be live),
and the multi-tenant model behind PR-MONEY-01 / exports.

## Fixtures required
- Org **A** and Org **B**, each with: 1 admin user, 1 `users:edit` non-admin, 1 `client` role user.
- One quote per lifecycle stage in each org; one `quote_payments` row; one pending invitation.
- Two authenticated sessions in Org A (concurrency) + one in Org B (isolation).

## Tests (assert properties, no fabricated financial values)
1. **Cross-tenant read denied** — as B, `select` each tenant table for A's rows → 0 rows.
2. **Every org_id table is policy-covered** — `pg_policies` audit: every `public` table with an `org_id` column has a policy referencing `current_org_id()` → expect 0 uncovered (validates PR-AUTHZ-01).
3. **Cross-tenant write denied** — as B, call `confirm_quote`/`add_quote_version`/`set_event_plan`/`checkout_equipment` with A's ids → expect `assert_quote_org` / org-filter error (`42501` or "no such …").
4. **Client-supplied org_id cannot bypass** — attempt to set/insert a foreign `org_id`; triggers force `current_org_id()` → row rejected or re-stamped.
5. **Privileged RPC org scope** — as B admin, `admin_set_role`/`admin_delete_user` on A's user → "no such user" (detects a phase73→stale revert; validates PR-DEPLOY-01 on the live DB).
6. **Deployed-body proof** — `pg_get_functiondef` for `admin_set_role`, `admin_create_user`, `admin_delete_user`, `confirm_quote`, `create_quote` and the `quote_consents/payments/notifications` policies contain `current_org_id()` (proves no stale mirror was applied last). See `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md`.
7. **Export scope** — as B with only `users:view`, `export_tenant_organization_package()` returns only B's data; confirm the intended gate vs `export_org_data`'s `is_admin()` (PR-AUTHZ-02, product decision).
8. **OTP (PR-AUTH-01) runtime** — call `request_otp(token, phone)` twice → codes differ (random), are never `123456`, and (once the echo product-decision lands) `dev_code` is null under production config.

## How to run (operator, on staging only)
Seed the fixtures, then execute each assertion in the Supabase SQL editor or a
scoped test harness using the two synthetic tenants. Record exact SQL, the role
used, and the observed result. Until then: **NOT TESTED**.
