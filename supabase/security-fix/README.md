# Security fixes — apply order & runbook

All additive, idempotent, reversible. **Claude does NOT run these against production** — you run them in the Supabase SQL editor. Apply on **staging (`xizeh…`) first**, verify, then **production (`nqltz…`)**.

| File | Severity | What | Break risk | Staging test needed? |
|---|---|---|---|---|
| **SEC-01** create-helm-user-lockdown | 🔴 CRITICAL | revoke anon/authenticated EXECUTE on `create_helm_user` + `_notify` | none (dev-seed helper; app uses other funcs) | minimal — run + confirm signup still works |
| **SEC-02** layouts-area-gate | 🟠 HIGH | re-gate `layouts` on `has_area('quotes')` + org | builder access | YES — confirm 2D/3D builder loads+saves for planner/admin; crew/client denied |
| **SEC-03** profiles-users-gate | 🟡 MED | gate `profiles` reads on self OR `has_area('users','view')` | team-name displays | YES — click leads/quotes/ops/settlement as planner+operations; nothing blank |
| **SEC-04** coupons-codes-gate | 🟢 LOW | gate coupon writes on `codes`/`controls` | none | smoke only |

## Order
1. **SEC-01 → prod ASAP** (live unauthenticated account-takeover). One-liner is enough:
   `revoke all on function public.create_helm_user(text,text,text) from anon, authenticated, public;`
2. SEC-02 → staging → regression (builder + e2e) → prod.
3. SEC-03 → staging → regression (assignment/team UIs) → prod.
4. SEC-04 → staging smoke → prod.

Each file has PRECHECK (read-only), APPLY (idempotent), VERIFY, ROLLBACK sections. Run PRECHECK + VERIFY as their own statements (Supabase shows only the last statement's result).

After you apply SEC-01/02/03 on staging, tell Claude — it will re-probe as `anon`/cross-role via the API to confirm each hole is closed and run the e2e + workflow suites to confirm nothing broke, then hand you a verified prod bundle.

PRANEETH REPO — UNTOUCHED / WWW.HELM.EVENTS — UNTOUCHED / PRODUCTION DATABASE — UNTOUCHED (you run the SQL; Claude runs nothing against prod).
