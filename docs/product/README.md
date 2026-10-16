# Helm product documentation

Index of the product document set (status: draft, 2026-10-16). Source of truth for facts is the code: `public/`, `vercel.json`, `supabase/migrations` 0001–0125 (`MANIFEST` order).

| Document | What it covers |
|---|---|
| [PRD.md](PRD.md) | Product requirements: problem, personas, 12 modules, numbered requirements with acceptance criteria, KPIs, release plan. |
| [TRD.md](TRD.md) | Technical requirements in arc42 form: architecture, key flows, security/RLS, ADRs, quality targets, test, deploy and DR. |
| [APP-FLOW.md](APP-FLOW.md) | Every route and the 17 end-to-end user flows on laptop and phone, with permissions per step and Mermaid diagrams. |
| [UI-UX-BRIEF.md](UI-UX-BRIEF.md) | Design brief: principles, light/dark themes and tokens, typography, components, responsive and accessibility rules. |
| [BACKEND-SCHEMA.md](BACKEND-SCHEMA.md) | Database reference: 136 tables, RLS patterns, functions, triggers, storage, edge functions, cron and the migration index. |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | 18 workstreams, phased timeline, go-live checklist, rollback plan, risks and owner decisions. |
| [LEGAL-REVIEW.md](LEGAL-REVIEW.md) | Review of the public legal pages against India, UAE, US, UK and EU requirements; new pages added; items for counsel. |
| [USER-MANUAL.md](USER-MANUAL.md) / [user-manual.html](user-manual.html) | End-user manual with screenshots (unchanged). |

## Shared facts (kept consistent across all documents)

- **Roles:** 12 role keys: admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew, worker, client. They are mapped against 33 access-matrix areas, and the database enforces them via `has_area` in RLS. There are no separate "finance" or "viewer" roles. You get those through the matrix.
- **Trial:** 8 days, no card, with demo data (`helm_billing_settings.trial_days`, 0119). Reminders on day 5/7/8 in the studio time zone (0120). The studio is read-only after expiry with no data deleted. "Start my own studio" is in 0123.
- **Recent activity vs Audit log:** both show the same `audit_log` table. Recent activity is a short dashboard slice. Audit log is the full admin page. Lead edits are audited only from 0125.
- **Migration status:** prod is through 0115 (re-verify). Staging has 0116 and 0118–0124. 0125 has been prepared but not run. 0117 is held.
- **Parked:** live payments (Razorpay) and WhatsApp sending stay dormant until their flags are turned on. Also parked: the lead same-email overwrite fix, the plan purchase checkout, Google sign-in dashboard setup, and the default-password reset.
- All legal text is a draft until reviewed by counsel. `[OWNER TO FILL]` marks decisions only the owner can make.
