# Test Results — Helm Real Workflow Validation (staging)

Date: 2026-09-29 · Env: localhost → STAGING (`xizehqgeyjcfpzrdymly`) · retries = 0 · trace off.

## Automated suites (executed this session)

| Suite | Result |
|---|---|
| `npm test` (14 unit/source files incl. 924-case pricing differential) | **PASS (exit 0)**, 0 mismatches |
| Playwright **chromium** (61 tests) | **60 pass / 1 fail** — the fail is `@guide` screenshot-capture (macOS `CVDisplayLink` headed artifact, non-functional) |
| Playwright **firefox** (58 functional) | **57 pass / 1 fail** — `@coverage budget` **flake** (passed in isolation, 11.8s) |
| Playwright **webkit** (58 functional) | **58 pass / 0 fail** |
| `@workflow` role captures (chromium, headless) | **11/11 pass**, 27 screenshots, every role asserted **0 production requests** |

## Lifecycle (single-record Lead→Closure)
**PASS** — all 12 stages green on chromium, firefox, and webkit. Runtime-verified this session (not merely claimed).

## Final role matrix

| Role | Login | Dashboard | Primary work | Save/update | Handoff | Denied action (expected) | Status |
|---|---|---|---|---|---|---|---|
| admin | ✅ | ✅ | oversight/config/audit | ✅ (control) | receives final | n/a (superuser) | PASS |
| manager | ✅ | ✅ | settlement/closure | ✅ (close_event) | ← ops, → admin | cannot delete | PASS |
| planner | ✅ | ✅ | discovery/pricing/proposal/payment | ✅ | ← sales, → client/ops | — | PASS |
| sales | ✅ | ✅ | lead → quote | ✅ (convert) | → planner | cannot close | PASS |
| coordinator | ✅ | ✅ | planning/resources (view/edit) | edit-scoped | supporting | cannot create quote | PASS |
| supervisor | ✅ | ✅ | oversight (view/edit) | edit-scoped | supporting | cannot create | PASS |
| quality | ✅ | ✅ | quality (view/edit) | edit-scoped | supporting | cannot create | PASS |
| operations | ✅ | ✅ | planning/tasks/inventory | ✅ | ← planner, → worker | cannot delete | PASS |
| crew | ✅ | ✅ (view) | view assigned | view only | supporting | cannot edit lifecycle | PASS |
| worker | ✅ | ✅ (view) | assigned task via token | task update | ← operations | cannot see others' events | PASS |
| client | ✅ | ✅ (view, 0 rows) | proposal review + OTP approve | consent | ← planner | **sees 0 quotes/leads/payments** | PASS |

## Negative authorization / tenant isolation
- Client enforced-denial (0 rows on quotes/leads/payments): **PASS**
- Cross-tenant (Org B → Org A quote): **PASS (0 rows)**
- Per-role capture prod-hit guard (`__prodHits==[]`): **PASS for all 11 roles**

## Bugs found
| ID | Area | Severity | Description | Status |
|---|---|---|---|---|
| WF-FLAKE-01 | test-stability | LOW | `@coverage budget` failed once on firefox under full-suite load; passed in isolation (clean console). Not a product defect. | OPEN (test hardening optional) |
| WF-ENV-01 | harness | LOW | `@guide` headed screenshot spec fails on macOS `CVDisplayLink`; replaced by headless `@workflow` capture. | WORKAROUND |

No CRITICAL/HIGH/MEDIUM product defects surfaced in this run.
