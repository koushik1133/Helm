# Multi-tenant — open questions for the team

> Block F (making Blueprint Stage serve many studios worldwide) is **deferred to the end**.
> Nothing here is decided yet. Answer these with your teammates and we'll design around them.
> (Existing data will always be preserved under a "Helm Studio" org — that part is not in question.)

## A. Tenancy model & data
1. Is one shared database with row-level isolation (`org_id` + RLS) acceptable, or do any clients contractually require a **separate database/region** (data residency, e.g. EU/India)?
2. Any regulatory constraints (GDPR, India DPDP, etc.) on where each studio's data is stored?
3. Should one studio's data ever be **shared/visible** to another (e.g. a marketplace of vendors across studios), or is isolation absolute?

## B. Users & access
4. Can a single person work for **more than one studio** (e.g. a freelance planner)? (We defaulted to one-studio-per-user for v1 — is that OK, or is multi-studio membership needed soon?)
5. Who can **invite users** into a studio — only its admin, or also managers?
6. Should the existing 11-role matrix be **per-studio customizable**, or a fixed platform-wide set?
7. Do you need a **platform super-admin** (you) who can see/support all studios, or should each studio be fully sealed even from you?

## C. Onboarding & sign-up
8. Self-serve "Create your studio" from the sign-in page, or **you provision** each studio manually? (We tentatively said self-serve.)
9. On sign-up, should a new studio require **email verification / approval** before it's active?
10. Should a new studio start **seeded with default templates/pricing/plate types/role matrix**, or empty? (Tentatively: seeded — but you asked to reset this; please reconfirm.)
11. Is there a **free trial**, and what happens to data when a trial/subscription lapses?

## D. Billing & plans
12. Will studios be **charged** (subscription)? If so, what plan tiers and limits (users, events, storage)?
13. Which billing provider (Razorpay / Stripe)? Per-studio invoices in their own currency?
14. Any **usage limits** per plan we should enforce (max events, max staff, max storage)?

## E. Branding & localisation
15. Per-studio **branding** (logo, accent colour, name on client-facing pages/invoices) — needed at launch?
16. Per-studio **currency, timezone, tax/GST number, language** — which of these at launch?
17. Client-facing pages (proposal, approval, invoice) — should they show the **studio's brand**, not "Blueprint Stage"?

## F. Domains & routing
18. Do studios need **custom subdomains** (studio.blueprintstage.com) or custom domains, or is a shared login fine for v1?

## G. Migration & go-live
19. Confirm: all current data stays under **"Helm Studio"** and Helm keeps working exactly as today. (Assumed yes.)
20. Is there a **second real studio** ready to onboard for the first isolation test, or do we test with a throwaway one?

## H. Support & operations
21. Who handles **password resets / locked-out admins** per studio (self-serve vs. you)?
22. Do you need an **audit trail per studio** of who did what (this is also Block H — Phase 47)?
