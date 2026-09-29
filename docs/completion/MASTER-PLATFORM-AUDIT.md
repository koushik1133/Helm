# Helm — Master Platform Audit (mapped to the full workflow/security spec)

Honest mapping of the master platform prompt to what Helm actually is, what was verified this engagement, and what is a **net-new build** vs Helm's current model. "The quote row IS the event" — Helm threads one `quotes.id` through the whole lifecycle rather than separate lead/quote/event tables.

## Legend
✅ Implemented + verified · 🟡 Partial · 🔶 Net-new build (different from Helm's model) · N/A not present

---

## 1. Business workflow & roles
| Spec area | Helm status | Evidence |
|---|---|---|
| Lead → qualify → quote → approve → event → execute → close | ✅ (single-quote lineage) | lifecycle.spec 12/12 green ×3 browsers; docs/workflow/HELM-OPERATING-MODEL.md |
| 11 roles + per-area RBAC matrix | ✅ | store-api ROLE_CAPS; docs/workflow/ROLE-HANDOFF-MATRIX.md + roles/*.md |
| Quotation lifecycle + audit | ✅ | quotation_versions, approval, audit_log |
| 2D/3D layout | ✅ | builder.html; quote_versions (layout) |
| Design-approval workflow (designer role, 2D→review→3D→client-approve→lock) | 🔶 | Helm has proposal publish + client OTP approval + version locking, but not a *dedicated Designer role* with a formal 2D→3D revision-approval state machine. Net-new if you want that exact flow. |
| Per-role dashboards (Sales/EM/Coordinator/Designer/Crew/Client-specific) | 🟡🔶 | Helm has one role-aware dashboard + the new Phase-3 "Upcoming & my tasks" widget; not 6 bespoke dashboards. Net-new for the bespoke versions. |
| Task lifecycle + dependencies + notifications | ✅🟡 | event_tasks (status/verify/depends_on/schedule); notifications + bell; handoff *auto*-notifications on stage RPCs = deferred (F-series). |
| Event timeline | 🟡 | event_activity RPC builds a chronological trail; not a dedicated timeline UI on every event. |
| "My Tasks" TODAY/Overdue/Blocked/Completed buckets | 🟡🔶 | Phase-3 widget shows upcoming events + open/done task rollup; the exact TODAY/Overdue/Blocked segmentation is a small net-new enhancement. |

---

## 2. Security & multi-tenancy — VERIFIED THIS ENGAGEMENT
| Spec requirement (§18–§32, §47) | Result | Evidence |
|---|---|---|
| Complete tenant isolation (no cross-org read/write/RPC) | ✅ PASS | 3-org (A/B/C) runtime matrix: 0 cross-org access any direction; 0 unscoped policies across all tables. |
| Disabled feature blocked at API, not just UI (§19–20) | ✅ PASS | Runtime proof: disabling `inventory` in role_access → endpoint returns 0 rows; re-enable → returns. has_area() baked into RLS of 20+ tables. |
| Anonymous access to protected tables (§27) | ✅ PASS | anon → 0 rows / 401 on quotes/leads/profiles/payments/tasks/notifications/orgs/audit_log/layouts/coupons. |
| IDOR / broken access control (§25) | ✅ PASS | cross-org quote read by id = 0; cross-org PATCH = 0 rows; token RPCs can't be coerced cross-org. |
| Account takeover (§21, §47) | ✅ FIXED | SEC-01 (create_helm_user) revoked on prod — was a confirmed unauthenticated pw-reset takeover. |
| Notification isolation (§31) | ✅ PASS | notifications RLS org-scoped; org C admin saw 0 others' notifications. |
| File/document isolation (§29) | N/A | Zero Supabase storage buckets exist — no file attack surface. If uploads are added later, apply bucket RLS. |
| Search isolation (§30) | ✅ (inherited) | Search hits the same RLS-scoped tables; no separate search index that bypasses RLS. |
| Audit logging + isolation (§32) | ✅ | audit_log table, org-scoped RLS (anon = 0). |
| Secrets management (§38) | ✅ | No service_role/secret committed; anon-only client keys; CI gitleaks. SEC note: rotate the exposed DB password. |
| Input validation (§34) | ✅ | Wave-16 validators + global number hardener + DB CHECK constraints; @validation e2e green. |
| Auth (signup/signin/reset/session) (§22) | ✅🟡 | Supabase GoTrue; password policy 12 + complexity + leaked-pw (Pro) + email verification + Google OAuth. MFA enforcement = open (F6). |

---

## 3. Production readiness (per §42.16)
| Area | Status | Notes |
|---|---|---|
| Authentication | PASS | policy hardened; MFA enforcement pending (F6) |
| Authorization / RBAC | PASS | server-enforced, runtime-proven |
| Multi-tenancy | PASS | 3-org proof, 0 unscoped policies |
| Database | PASS | RLS 100%, CHECK/FK, hot indexes |
| API | PASS | org+area guarded RPCs; rate-limit on business RPCs = open (F4) |
| Frontend | PASS-with-notes | hardened on koushik; **prod frontend 43 commits behind (F2)** |
| Notifications | PASS | org-scoped; auto-handoff pings deferred |
| Files | N/A | no storage in use |
| Input validation | PASS | 4-layer |
| Performance | NOT MEASURED | tool shipped (F8), no baseline run |
| Error handling | PASS | injected-failure e2e; no stack-trace leakage |
| Logging | PARTIAL | Postgres logs; structured/tracing open (F5) |
| Monitoring | FAIL | no live DSN/uptime (F1) |

---

## 4. Honest final standard (§46–§47)
**Zero known critical/high tenant-isolation or authorization vulnerabilities remain** after this engagement: the one confirmed CRITICAL (account-takeover) is fixed on prod; cross-org isolation, feature-flag enforcement, anon denial, and IDOR are runtime-verified. **No claim of "100% secure."** Remaining risks are operational (F1 monitoring, F2 frontend parity, F3 backup drill) and enhancement (F4/F6/F7), tracked in ELITE-AUDIT.md + F1-F10-IMPLEMENTATION-GUIDE.md.

**Net-new product scope** (beyond Helm's current model, only if you want the spec literally): a dedicated Designer role + formal 2D→3D design-approval state machine; 6 bespoke per-role dashboards; per-user "My Tasks" TODAY/Overdue/Blocked segmentation; file/document storage. These are builds, not fixes — say the word and I'll scope them.

## 5. Production verdict
**HIGH RISK → READY WITH MINOR CHANGES once F1/F2/F3 close.** Security/data core is production-grade and verified; the blockers are operational (monitoring, frontend-parity deploy, backup drill), not code defects.
