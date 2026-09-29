# SALES

**Purpose:** front of the funnel — capture leads and convert them into a quote/event.
**Login:** email/password (`sales.a@…`; Password: [REDACTED TEST CREDENTIAL]). **Landing:** dashboard.html.
**Caps:** view, create, edit. Server: `can_create()` includes sales.

**Primary work:** CRM/Leads → create a lead (name, phone, email, event_type, source) → qualify → `convert_lead_to_quote`. **Creates:** `leads`, then the canonical `quotes` row. **Cannot:** settle/close (not in `can_edit` for closure), delete.

**Handoff:** → **Planner** (the new quote to scope discovery + pricing).

**Verified:** lifecycle stage 01 (lead created + converted) green ×3 browsers; phone/email validation enforced.
**Screenshots:** `screenshots/02-sales/01-dashboard.png`, `02-leads.png`, `03-crm.png`. **Status:** PASS.
