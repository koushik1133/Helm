# Helm — Net-New Product Build Scope & Estimates

Scoping (not building) the four features from MASTER-PLATFORM-AUDIT.md that are **genuinely new** vs Helm's current model — the spec asks for them but Helm doesn't have them yet. Each is broken into DB migration → RLS → RPC → UI → tests, with an honest effort estimate and the risks.

**Ground rules that constrain every build below:** additive + idempotent migrations only (zero-data-loss guardrail); `has_area(area, need)` drives all table RLS; "the quote row IS the event" (everything FKs to `quotes.id`); staging (`xizeh…`) first, user runs prod SQL; no new npm deps (vanilla JS). Effort is *my* build time in focused work-sessions, then you run the SQL + review.

---

## BUILD 1 — Designer role + 2D→3D design-approval state machine  🔶 LARGEST

### What exists today
- 11 roles; no dedicated **designer**. Layout work happens in `builder.html` gated by `has_area('layouts'|'quotes')`.
- Client approval already exists: proposal publish → client OTP approval → **version locking** (`quotation_versions`, approve RPC). So "client signs off and it locks" is **done** — what's missing is a *formal design revision pipeline* with its own states and a design-specific role.

### What "net-new" means here
A real state machine per event's design: `draft_2d → internal_review → revise → approved_2d → build_3d → client_review → approved_3d → locked`, with a **Designer** role who owns the 2D/3D stages and hand-back on rejection.

### Scope
| Layer | Work |
|---|---|
| DB (additive) | New table `design_stages` (id, quote_id FK, state enum-as-text + CHECK, revision int, assigned_designer, notes, updated_at, updated_by); append `designer` to the roles list + seed `role_access` rows for it (copy `coordinator` baseline + full `layouts`/`proposal`). New area key `design`. |
| RLS | `design_stages` policies: `org_id = current_org_id() AND has_area('design'|'layouts', need)`; client can SELECT only their own event's `client_review`+ rows. Anon = 0. |
| RPC (SECURITY DEFINER) | `design_advance(quote_id, to_state, note)` — validates the transition against an allowed-transitions map, enforces role (only designer/manager/admin can advance internal states; only client-token can approve `client_review`→`approved_3d`), writes audit_log, fires a notification on each transition. Optimistic-lock on `updated_at`. |
| UI | `builder.html`: a design-stage rail (current state + allowed next actions as buttons, role-filtered). New `design.html` queue page for the Designer (their assigned events by state). Client sees the review/approve step inside the existing proposal/portal flow. |
| store-api | `BPStore.design = { get, advance, queue }` wrappers. Add `designer` to `ROLE_CAPS` + `ROLE_LABELS` + `AREAS`. |
| Tests | e2e: full transition happy-path + illegal-transition rejection + cross-org + client-can-only-approve-own; RLS anon-deny. |

### Risks / decisions you must make
- **Does the Designer replace or sit beside `planner`?** (Affects role_access seeding.) — recommend *beside*.
- Enum-as-text + CHECK (not a Postgres enum) so it stays additive/reversible.
- 3D is `builder.html`'s existing three.js view — no new render engine; the "3D" state just gates which view the client sees.

### Estimate: **~2–3 build-sessions** (largest). 1 migration, 1 RPC file, ~2 UI surfaces, e2e suite.

---

## BUILD 2 — 6 bespoke per-role dashboards  🔶

### What exists today
One role-aware `dashboard.html`: nav filtered by `has_area`, plus the Phase-3 "Upcoming & my tasks" widget (`my_pending()` RPC). Every role sees the same shell with different cards shown/hidden.

### What "net-new" means
Distinct default landing experiences for **Sales, Event-Manager, Coordinator, Designer, Crew, Client** — each opening on the widgets that role actually uses, not a filtered copy of one page.

### Scope
| Layer | Work |
|---|---|
| DB | **None.** Pure frontend + existing RPCs (`my_pending`, `listTasks`, lead/quote lists already RLS-scoped). This is the cheap one. |
| UI | A `DASHBOARDS` config map in `dashboard.html`: per-role → ordered widget list (e.g. Sales = pipeline funnel + my leads + conversion; EM = events this week + approvals waiting + budget flags; Coordinator = run-sheet + tasks + staff gaps; Designer = design queue by state [needs Build 1]; Crew = today's tasks + call time + location; Client = my event + approvals + payments). Reuse existing render fns; add ~4 new small widget renderers. |
| RPC | Optional 2 read-only aggregates (`sales_funnel_counts`, `em_week_summary`) — org+area gated, or compute client-side from already-fetched lists to add **zero** DB surface. Recommend client-side first. |
| Tests | Snapshot each role's dashboard renders its widget set; crew/client don't see privileged widgets (already proven pattern). |

### Risks
- Designer dashboard depends on Build 1. Ship 5 now, add the 6th with Build 1.
- Keep it data-driven (one config map) so it's not 6 copy-pasted HTML files to maintain.

### Estimate: **~1.5 build-sessions.** No migration if aggregates stay client-side.

---

## BUILD 3 — "My Tasks" TODAY / Overdue / Blocked / Completed buckets  🔶 SMALLEST

### What exists today
`event_tasks` has `status`, `verify_status`, `depends_on`, `planned_start`/`planned_end`, `completed_at`. The Phase-3 widget shows upcoming events + an open/done rollup. No per-user segmentation into time buckets.

**Confirmed against schema:** tasks are assigned via `crew_id` (uuid → staff/crew record) + `assignee_name`/`assignee_phone` — there is **no direct `assigned_to = auth.uid()` column**. So "my tasks" for a logged-in user resolves `auth.uid() → staff row → crew_id`, then matches `event_tasks.crew_id`. That join lives inside the `my_tasks()` RPC (SECURITY DEFINER), so no schema change is needed. Due-date bucketing uses `planned_end`.

### What "net-new" means
A personal task view bucketed **TODAY** (due today), **OVERDUE** (past due, open), **BLOCKED** (open but `depends_on` not done), **COMPLETED**.

### Scope
| Layer | Work |
|---|---|
| DB | **None new** — `event_tasks` already has the columns. Optional: 1 additive index `ix_event_tasks_crew_status (crew_id, status)` for speed. |
| RPC | Extend/parallel `my_pending()` → `my_tasks()` SECURITY DEFINER: resolves `auth.uid() → staff → crew_id`, returns that user's tasks across the caller's org, pre-bucketed by comparing `planned_end` to today and checking `depends_on` completion. Org + `has_area('quotes'|'ops','view')` gated, revoked from anon (same pattern as `my_pending`). |
| UI | New "My Tasks" section on dashboard (or its own `work.html` tab) with 4 collapsible groups + counts. Reuse `.ptasks/.trow` CSS already added in Phase 3. |
| Tests | Seed tasks across buckets → assert each lands in the right group; blocked-by-dependency logic; cross-org = 0; anon-deny. |

### Risks
- "BLOCKED" needs `depends_on` populated — if most tasks have none, the bucket is usually empty (fine, honest).
- Assignment resolves through `crew_id` (schema-confirmed); a user with no linked staff/crew row sees an empty list — expected, not a bug.

### Estimate: **~1 build-session (final, schema-confirmed).** One RPC (with the uid→crew join) + one dashboard section, reusing Phase-3 plumbing.

---

## BUILD 4 — File / document storage  🔶 (security-sensitive)

### What exists today
**Zero** Supabase storage buckets (verified: `storage.buckets` = 0 rows, 0 policies). No file attack surface today — which is why §29 was N/A. Adding files **adds** a whole attack surface, so this one is as much security work as feature work.

### What "net-new" means
Upload/attach documents (contracts, layouts export, invoices, event photos) to an event, scoped per-org, downloadable only by authorized roles.

### Scope
| Layer | Work |
|---|---|
| Storage | Create bucket(s) `event-docs` (private, not public). Path convention `org_id/quote_id/<uuid>.<ext>`. |
| RLS (critical) | Storage policies: SELECT/INSERT/DELETE `WHERE bucket_id='event-docs' AND (storage.foldername(name))[1] = current_org_id()::text AND has_area('quotes'|'media', need)`. **force RLS**. Verify anon = 0 and cross-org = 0 (same 3-org proof as tables). |
| DB | `event_files` metadata table (id, quote_id FK, storage_path, filename, mime, size, uploaded_by, org_id, created_at) with matching `has_area` RLS — so listings go through RLS, not raw bucket enumeration. |
| App-layer hardening (from /security skill) | client-side: cap size (10 MB), **sniff magic bytes not the name**, allowlist mime (pdf/png/jpg/webp), discard client filename → store as uuid, `content-disposition: attachment` (never inline-render user files on our origin), CSP unchanged (files served from supabase.co, already allowed). |
| UI | An "Attachments" panel on `event.html`/`portal.html`: list + upload + download; role-gated. |
| Tests | anon can't read a signed path's object; org-B can't read org-A's file by guessing path; oversize/wrong-type rejected; only allowed roles see the panel. |

### Risks / why this is the touchiest
- Files are the classic tenant-isolation hole — **must** re-run the cross-org + anon proof against the bucket, not just tables.
- Signed-URL TTL short; never make the bucket public.
- This one I'd want to test hardest on staging before any prod bucket is created.

### Estimate: **~2 build-sessions** (feature is small; the security proof is the work).

---

## Summary & recommended order

| # | Build | DB change | Effort | Depends on | Security weight |
|---|---|---|---|---|---|
| 3 | My-Tasks buckets | none (maybe 1 index) | ~1 session | — | low |
| 2 | 6 role dashboards | none | ~1.5 sessions | Designer widget needs #1 | low |
| 1 | Designer + design state machine | 1 table + role + RPC | ~2–3 sessions | — | medium |
| 4 | File storage | bucket + table + RLS | ~2 sessions | — | **high** (new attack surface) |

**Recommended sequence:** #3 (quick win, all plumbing exists) → #1 (unlocks the Designer dashboard) → #2 (now all 6 dashboards, data-driven) → #4 last (isolate the new file attack surface and prove it in one focused pass).

**Total: ~6.5–7.5 build-sessions**, each landing on staging with e2e + the cross-org/anon security proof before you run the prod SQL.

### One decision I need before building #1
**Designer role: beside or replacing planner?** (recommend beside.) — Build #3's open question is resolved: schema confirmed, no new column needed.

Say which build to start (recommend **#3** first) and I'll implement it on staging, verify, and hand you the idempotent prod SQL.
