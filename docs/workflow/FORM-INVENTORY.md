# Form Inventory — Helm workflow (staging runtime)

Forms exercised during the real lifecycle + validation runs. Field values were synthetic. Validation is enforced client-side (shared `BPStore.validate` + global number hardener) AND server-side (RPC guards, CHECK constraints, triggers).

| Form | Role | Key fields | Required/validation | Invalid test | Persistence | Status |
|---|---|---|---|---|---|---|
| Sign in | all | email, password | both required | wrong creds → denied | session | PASS |
| New lead | sales | name, phone, email, event_type, source | name+contact required; phone/email format | empty → blocked | `leads` row | PASS |
| Convert lead→quote | sales | (lead ref) | `can_create()` server-gated | non-authorized role → denied | `quotes` row | PASS |
| Discovery | planner | event details, requirements | required fields | — | `event_discovery` | PASS |
| Pricing / version | planner | chairs, prices, discount, discountPct, coupon, svcPct, gstPct | numeric ≥0; server recomputes | tampered total `1` → recomputed | `quotation_versions` (server total) | PASS |
| Builder/layout | planner | layout elements | — | — | `quote_versions` | PASS |
| Proposal publish | planner | proposal content | — | — | published + share token | PASS |
| Client approval (OTP) | client | 6-digit OTP | single-use, lockout after 5, expiry | wrong OTP → fail; replay → denied | `quote_consents` | PASS |
| Record payment | planner | amount, idempotency key | amount > 0 (RPC + CHECK); overpayment rejected | negative/zero → rejected; overpay → 23514 | `quote_payments` (idempotent) | PASS |
| Event plan | operations | venue, plan, menu | — | — | `event_plan` | PASS |
| Assign task | operations | task, assignee | — | — | `event_tasks` + worker token | PASS |
| Settlement/closure | manager | settlement, closure fields | `can_edit()` (W16-02 manager) | non-authorized → 42501 | `event_closure`, terminal `closed` | PASS |
| Global number inputs | all | any `input[type=number]` | blocks `-`/`e`/`+`, clamps min/max, integer when step=1 | negative/`e` → blocked | n/a | PASS (@validation) |

Validation coverage proven by `@validation` (shared validators + global hardener clamps even dynamically-added inputs) and the money trust-boundary tests. No credential values documented.
