# Security fixes — apply order & runbook

All additive, idempotent, reversible. **Claude does NOT run these against production** — you run them in the Supabase SQL editor. Apply on **staging (`xizeh…`) first**, verify, then **production (`nqltz…`)**.

| File | Severity | What | Break risk | Staging test needed? |
|---|---|---|---|---|
| **SEC-01** create-helm-user-lockdown | 🔴 CRITICAL | revoke anon/authenticated EXECUTE on `create_helm_user` + `_notify` | none (dev-seed helper; app uses other funcs) | minimal — run + confirm signup still works |
| **SEC-02** layouts-area-gate | 🟠 HIGH | re-gate `layouts` on `has_area('quotes')` + org | builder access | YES — confirm 2D/3D builder loads+saves for planner/admin; crew/client denied |
| **SEC-03** profiles-users-gate | 🟡 MED | gate `profiles` reads on self OR `has_area('users','view')` | team-name displays | YES — click leads/quotes/ops/settlement as planner+operations; nothing blank |
| **SEC-04** coupons-codes-gate | 🟢 LOW | gate coupon writes on `codes`/`controls` | none | smoke only |
| **SEC-05** audit-fixes | 🔴 HIGH | F1 org-scope channel flags (`_flag`/`_notify`/`request_otp`/`create_payment`, which reverts WAVE-05's cross-tenant `_flag`); F2 proposal/portal tenant match; F3 `design_advance` org assert; F4 revoke `helm_total_paid`/`_flag`; F5 revoke PUBLIC+anon EXECUTE on authenticated-only RPCs; F6 `invite-media` no public listing + image MIME/size allow-list; F7 invitation writes admin-only; F8 org settings gated on admin/`controls` edit; F9 `inventory_availability` security_invoker; F10 quote-editing RPCs also require the page's matrix area edit (read-only roles, `operations` by default, can no longer write via RPC); F11 `mark_paid` admin/manager only; F12 guard trigger on `event_tasks` QC columns for direct API writes | OTP/payment flags now per-studio (check PRECHECK P2 first) | YES: run PRECHECK P2, then approval flow (OTP + consent + payment), portal, proposal link, worker link, invite photo upload + public invite page, designer advance, Control Center studio save, admin invite, flow.html save as planner/sales (works) and as operations (denied), Mark paid as manager (works) and as planner (denied), ops QC pass/reject |
| **SEC-06** teardown-return-and-invite-lookup | 🟡 MED | new `return_reservation()`: teardown Return marks returned + writes off damaged stock in ONE transaction (org + `inventory` edit checked, repeat/over-qty rejected); new anon `invitation_preview()` (org name, role, validity only, no email/ids) so the sign-in invite banner shows | none (front-end falls back to the old path until applied) | YES: Return with damaged 0 / partial / > qty (rejected) / twice (rejected); signed-out `login?invite=<token>` shows the banner |
| **SEC-07** backend-hardening | 🟠 HIGH | approval links expire after 30 days and worker links after 60 (existing live links get that from today); OTP limit of 3 codes per phone number per hour and 10 per quote per day; trigger rejects any row whose quote belongs to another studio; new functions no longer executable by anon/PUBLIC by default | old approval/worker links now expire; a 4th OTP to one number within an hour is refused | YES: send an approval link (opens); request 4 OTPs to one number (4th refused); open a worker link; save discovery/plan/proposal |

## Order
1. **SEC-01 → prod ASAP** (live unauthenticated account-takeover). One-liner is enough:
   `revoke all on function public.create_helm_user(text,text,text) from anon, authenticated, public;`
2. SEC-02 → staging → regression (builder + e2e) → prod.
3. SEC-03 → staging → regression (assignment/team UIs) → prod.
4. SEC-04 → staging smoke → prod.
5. SEC-05 → staging: PRECHECK (esp. P2: each studio's own `channels` row decides its OTP/payment mode after APPLY) → APPLY → VERIFY (all PASS) → regression → prod.
7. SEC-07 → staging (after SEC-05): PRECHECK (lists any existing cross-studio rows) → APPLY → VERIFY (all PASS) → smoke → prod.
6. SEC-06 → staging: PRECHECK → APPLY → VERIFY (`leaks_email` false) → teardown + invite-banner smoke → prod. Independent of SEC-05.

Each file has PRECHECK (read-only), APPLY (idempotent), VERIFY, ROLLBACK sections. Run PRECHECK + VERIFY as their own statements (Supabase shows only the last statement's result).

After you apply SEC-01/02/03 on staging, tell Claude — it will re-probe as `anon`/cross-role via the API to confirm each hole is closed and run the e2e + workflow suites to confirm nothing broke, then hand you a verified prod bundle.

**Tested before release:** all of SEC-05/06/07 were applied twice (idempotent) to a Postgres 16 copy of the 09-25 production schema snapshot + every later prod bundle (PROD-01, wave10, completion, prod-fix, SEC-01..04); every VERIFY row read PASS and behaviour tests passed (two studios, admin/planner/operations roles, anon token flows). On the bare 09-25 snapshot SEC-05 refuses with a clear "apply these first" message and changes nothing.

PRANEETH REPO — UNTOUCHED / WWW.HELM.EVENTS — UNTOUCHED / PRODUCTION DATABASE — UNTOUCHED (you run the SQL; Claude runs nothing against prod).
