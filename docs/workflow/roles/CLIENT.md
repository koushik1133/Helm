# CLIENT

**Purpose:** the customer — review the published proposal and approve via OTP.
**Access model:** view-only studio session + **token/OTP** approval flow (not a full studio user). Login `client.a@…` exists; the approval itself is token-scoped on approve.html.
**Caps:** view only. RLS: **client sees ZERO** quotes/leads/payments in the studio (enforced denial) — verified.

**Primary work:** open the scoped proposal (share token) → review pricing → approve via OTP.
**Approval security (verified, lifecycle 06):** wrong OTP → fail; 5 wrong → lockout; correct OTP → approve **once**; replay of a consumed OTP → denied; single-use + fail-closed. **Creates:** `quote_consents` (consent record). OTP values are never shown in docs/screenshots.

**Handoff:** ← Planner (published proposal) → payment recording (Planner) once approved.

**Negative auth:** attempting to read studio quotes/leads/payments → 0 rows (PASS).
**Screenshots:** `screenshots/04-client/01-dashboard.png` (restricted view). **Status:** PASS.
