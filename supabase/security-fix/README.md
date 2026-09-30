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
| **SEC-07** backend-hardening (v2) | 🟠 HIGH | approval links live 30 days from issue or until 30 days after the event (client portal), renewed only by staff re-issue or activity on a LIVE link; worker links 60 days / event+14 days, renewed by a new assignment (never if revoked); OTP limits 3/number/hour + 10/quote/day serialized with advisory locks (concurrency-tested); quote/studio match on all 40 quote_id+org_id tables with exact-coverage VERIFY; GLOBAL default-privilege revoke for the real function-owner role(s) with an effective-ACL VERIFY | old links: backfill uses last activity (never revives/prolongs a stale link); a 4th OTP to one number within an hour is refused | YES: see VERIFY + behaviour list in the file |

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

## Staging status (`xizehqgeyjcfpzrdymly`) — production not applied
| Item | Staging | Evidence |
|---|---|---|
| SEC-05 | applied; VERIFY PASS except **F6 MIME/size = FAIL** (dashboard fix pending) | user's staging VERIFY output |
| SEC-06 | **PASS (2026-09-30)** | catalog VERIFY PASS; `staging-tests/sec06-sql-editor`: 8/8 behaviour rows PASS (damaged > qty rejected, valid return, stock 10→7, repeat rejected, cross-studio "reservation not found"); concurrent returns: TAB 2 `22023 reservation is already returned`, stock 7→5 (one deduction); invitation_preview 6/6 PASS, no private fields; cleanup 0 rows; **correction:** that cleanup checked only studio-scoped tables and left ~9 `audit_log` rows (no studio id) naming `ee5ec06e…` test ids — the SEC-07 master file removes them and reports the count |
| SEC-07 | **v2 applied (2026-09-30); VERIFY 8/8 PASS** (G4 40/40 guarded; G5 PUBLIC/anon cannot, authenticated can). Behaviour: **pending** — run ONE file `staging-tests/SEC-07-v2-STAGING-MASTER-TEST.sql` (+ its CONCURRENCY TAB 1/TAB 2 sections) | local: 36/36 PASS in editor mode (x2) and statement mode; concurrency PASS (TAB 2 waited 16–18 s, refused, 3 codes); negative control without locks → FAIL; production-like DB (no SEC-07) → aborts, nothing written; real-row fingerprint unchanged; 0 leftovers |
| B2 payment concurrency | PARTIAL / OPEN | — |

Note (staging precheck row 12): role `supabase_admin` has a per-schema default ACL in `public` that grants anon EXECUTE. It owns no public functions today (owners: postgres only), so VERIFY G5 is correct; a function `supabase_admin` ever creates in `public` would still be anon-executable. The SQL editor runs as `postgres` and cannot change `supabase_admin` defaults.

**F6 bucket limits:** set them in Dashboard → Storage → invite-media → Edit bucket (or `storage.updateBucket`), keep it PUBLIC; SEC-05 only reports. **Payment concurrency (B2): PARTIAL / OPEN** — SEC-05/07 fix specific writers (mark_paid, webhook) but do not prove every money-writer shares one serialization boundary; not claimed fixed.

PRANEETH REPO — UNTOUCHED / WWW.HELM.EVENTS — UNTOUCHED / PRODUCTION DATABASE — UNTOUCHED (you run the SQL; Claude runs nothing against prod).
