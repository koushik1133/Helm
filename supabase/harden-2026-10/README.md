# harden-2026-10 — payment / OTP / RLS hardening series

**Branch:** `harden/payment-otp-rls-2026-10` · **Status: LOCAL ONLY. NOT APPLIED. NOT PUSHED.**
Forward-only. Verify on an **isolated non-production test DB** (staging `xizehqgeyjcfpzrdymly`
or a throwaway project) with `supabase/tests/` **before** any production apply. Never run
against production (`nqltzgiwznphugcfhmbm`) from here.

## Apply order
1. **H01** — `H01-overpayment-update-path-and-lock.sql` — quote_payments overpayment trigger now fires on **INSERT *and* UPDATE** (was INSERT-only → UPDATE bypass); both guard functions take a per-quote advisory lock **and** `SELECT … FOR UPDATE` on the parent quote, recomputing the paid total after the lock.
2. **H02** — `H02-otp-verify-row-lock.sql` — `verify_and_consent` locks the active OTP row `FOR UPDATE` → concurrent verifications serialize (single-use + attempt accounting race-safe). Preserves the C2b persist-attempts fix. Codes stay hashed.
3. **H03** — `H03-payment-milestones-rls-tighten.sql` — **GATED/STAGE-2**: `payment_milestones` write RLS becomes schedule-only (no direct paid transition, no mutate/delete of paid rows); money transitions go through `record_settlement_payment`. Apply **only after** the settlement UI posts paid exclusively via the RPC and the role-regression tests pass.

Each file has PRECHECK (read-only) → APPLY → VERIFY → ROLLBACK.

## A. Canonical payment model (design)
- **`quote_payments` is the authoritative money ledger.** It is append-oriented, has unique partial indexes on `(quote_id, idempotency_key)` and `(quote_id, receipt_no)` (preserved), and — in the authoritative schema — has **RLS SELECT-only, no write policy**, so only the `SECURITY DEFINER` RPCs (`record_payment`, `record_settlement_payment`) can write it. Those RPCs authorize server-side (`can_edit()`), serialize per quote (advisory + row lock, H01), compute outstanding from the ledger, and honor idempotency (return the existing receipt on a repeated key).
- **`payment_milestones` is a schedule/workflow record**, not a second independent ledger. H03 stops staff from moving money directly through it.

### ⚠️ PRODUCT DECISION REQUIRED (brief category 7) — double-count
`helm_total_paid` currently sums **paid `quote_payments` + paid `payment_milestones`** (W16-04). But `record_settlement_payment` writes **both** a `quote_payments` row **and** flips the targeted milestone to `paid` for the **same money** → that payment is **counted twice**, which can **falsely reject** a later legitimate payment (fail-closed; not a loss). Two options — **your call**, I will not change money semantics by inference:
- **(Recommended) Ledger-only:** change `helm_total_paid` to sum **`quote_payments` only**, and treat milestone `paid` purely as schedule status. Safe **once** every money path is confirmed to write a `quote_payments` row (today `record_payment` and `record_settlement_payment` both do; H03 blocks direct milestone-paid writes, which closes the last gap). This removes the double-count.
- **Keep summing both:** only correct if a milestone can be `paid` representing money that has **no** `quote_payments` row — which H03 is designed to prevent. Not recommended alongside H03.
A migration for the recommended option is **drafted but intentionally not written to apply** until you choose — say the word.

## D. Permission matrix (reviewed)
| Surface | anon | authed (ordinary) | quote editor | finance editor | admin | server/definer |
|---|---|---|---|---|---|---|
| `request_otp` / `verify_and_consent` (public approval) | ✅ by token + rate limit | ✅ | ✅ | ✅ | ✅ | n/a |
| `quote_payments` write | ❌ | ❌ (no RLS write policy) | ❌ | ❌ (RPC only) | ❌ (RPC only) | ✅ RPC |
| `record_payment` / `record_settlement_payment` | ❌ | gated `can_edit()` | ✅ if `can_edit()` | ✅ | ✅ | ✅ |
| `payment_milestones` schedule (non-paid) | ❌ | ❌ | ✅ `can_edit()` | ✅ | ✅ | ✅ |
| `payment_milestones` set/mutate/delete **paid** | ❌ | ❌ | ❌ (H03) | ❌ (H03) | ❌ (H03) | ✅ RPC only |
| finance/settlement/closure edit (`has_area`) | ❌ | ❌ | ❌ | ✅ | ✅ | — |
> No broad GRANT/REVOKE. Public approval endpoints, storage, and Supabase system roles are untouched. Role-regression tests (anon / ordinary / finance editor / quote editor / admin) live in `supabase/tests/`.

## Source-vs-production compatibility matrix
| Concern | Production (nqltz…) today | This branch (local) |
|---|---|---|
| `record_settlement_payment` | ✅ applied this session (B5) | present (unchanged) |
| `my_pending` | ✅ applied this session (PROD-FINAL) | present (unchanged) |
| OTP attempt-counter persists | ✅ applied (C2b) | + row `FOR UPDATE` (H02) |
| Overpayment advisory lock | ✅ applied (B2) | + `FOR UPDATE` + **UPDATE-path** (H01) |
| quote_payments overpayment on UPDATE | ❌ INSERT-only (bypass) | ✅ INSERT **or** UPDATE (H01) |
| payment_milestones write | `can_edit()` for-all (direct money) | schedule-only (H03, gated) |
| supabase-js delivery | self-hosted pinned `vendor/…2.117.2` | unchanged (already compliant) |
| helm_total_paid double-count | present (QP+PM) | **unresolved — product decision** |

## Manual production verification steps — NOT YET PERFORMED
1. Apply H01 → H02 on **staging**, run `supabase/tests/` concurrency + OTP-race suites, capture output.
2. Land the settlement-UI RPC routing (frontend), then apply **H03** on staging, run role-regression + boundary tests.
3. Decide the canonical-ledger question; apply the chosen `helm_total_paid` migration on staging; re-run payment tests.
4. Only after staging is green: schedule the same ordered series on production (PRECHECK → APPLY → VERIFY per file).
