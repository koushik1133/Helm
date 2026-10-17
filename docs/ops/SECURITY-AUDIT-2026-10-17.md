# Security + end-to-end audit - 2026-10-17 (AUD-1017)

## Scope
- Staging deployment helm-v01 (Supabase project xizehqgeyjcfpzrdymly) with several studios in one database.
- Five areas: tenant isolation, RPC/RLS static review, web security (headers, CSP, XSS, redirects, secrets),
  core money lifecycle (lead -> quote -> confirm -> payments -> change order -> vendor bills -> claims ->
  refunds -> settlement -> closure -> reports), and ops/team pages (leads, invites, roles, calendar, mobile, dark mode).

## Method
- White-box review of `supabase/migrations` (canonical base + 0001-0145) and the web app in `public/`.
- Black-box browser testing on the staging app as one studio owner, using only records labelled AUD-1017 / CHK-1017.
- Live cross-tenant probing with raw PostgREST requests was **not** done. The harness safety classifier
  blocked reading session tokens and the anon key from the page. Cross-studio isolation is therefore proven
  from source and from app-layer checks (every row the store returned belonged to the signed-in studio; a
  foreign studio slug did not resolve). It is not proven by runtime SQL.
- No personal data appears in this report. Test records used example.com addresses.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | High | Net profit counted vendor spend twice when it was entered as a Budget "Vendor" cost line **and** as a vendor bill not linked to a booking (Vendors -1,60,000 instead of -80,000) | **Fixed**: 0146 `_vb_event_pnl` + `vendorPnlCalc`. Loose vendor spend now counts once, as the larger of loose bills and loose vendor lines |
| 2 | Medium | A processed refund to the client was not taken off Net profit, and the Closure P&L had no refund line | **Fixed**: processed refunds (kind `refund`) are subtracted on the server and client, returned as `refunds`, and shown as "Refunds to client" |
| 3 | Medium | A studio whose `organizations.currency` is USD showed every amount in INR | **Accepted (by design)**: money follows each quote's tax snapshot and the studio's tax country, not `organizations.currency`. The test studio's tax country is India and its quotes are priced with GST, so INR is correct. The USD value is a stale column (see 0145). Owner action: set the tax country in Control Center if the studio really is in the US |
| 4 | Low | `trial_test_approve` let anyone holding a trial studio's approval link approve the quote without an OTP | **Fixed**: 0146 also requires the caller to be a signed-in member of that studio. `trial_test_mode_for_token` only shows the button to members |
| 5 | Low | Identical iCloud " 2" copies of 0143/0144 and their APPLY bundles sat in `supabase/` | **Fixed**: they were untracked byte-identical copies, moved out of the repo tree (not deleted). A regression test now fails if one comes back |
| 6 | Low | The offline/localStorage proposal path made its share token from `Date.now()` + `Math.random()` | **Fixed**: it now uses `crypto.randomUUID()` |
| 7 | Low | `config.js` defaults to the production project. If `config.staging.js` failed to load, staging would connect to prod | **Accepted / remaining risk**: the production site needs that default. Runtime and CSP `connect-src` on staging were verified to pin staging, so the CSP blocks prod calls from the staging origin. Recommended later: a host-to-project assertion in `BPStore.init` |
| 8 | Low | invite-mailer preflight fails on staging, so invite emails are not sent | **Accepted (deploy)**: the function code answers OPTIONS correctly. The function is not deployed on staging. Copy-link works. Owner action: deploy invite-mailer and set its secrets |
| 9 | Low | `/site.webmanifest` 404 in the console | **Accepted**: no page links a manifest, and the public/ file-type allowlist (FILE-01) forbids adding one. The request comes from outside the app |
| 10 | Low | The Events CSV "stage" column reads `discovery` for a confirmed event | **Accepted**: the column is the lead pipeline stage. The event lifecycle is the separate `status` column (`confirmed`). Candidate for a later UX change |
| 11 | Info | `upload_guard_update` restrictive policy uses USING(true) | Accepted. This is intentional and adds no access because the policy is restrictive |
| 12 | Info | Trusted Types are loaded but not enforced, and `style-src-attr 'unsafe-inline'` is set | Accepted. Output encoding (esc / HelmSanitize / check-html-sinks) is the control. Enforcement is a later hardening step |
| 13 | Info | The HTML document sends a static ACAO for www.helm.events | Accepted. It is inert on navigations and has no credentials flag. Tenant JSON is served only by Supabase |
| 14 | Info | A confirmed event has no start time | Deferred (time-aware calendar) |

## Verified OK (summary)
- Studio binding comes from the server (`current_org_id()` from profiles) and cannot be changed by users (0021 lockdown).
- Every tenant table has RLS and org-scoped policies. Children are pinned to their parent's org (`tg_quote_org_match`).
- No table grants to anon. Every anon RPC checks a token or slug.
- Strict hash CSP, HSTS preload, frame-ancestors, nosniff and COOP/CORP are in place. The open-redirect guard holds against 10+ bypass forms.
- No service_role key reaches the client.
- The full money lifecycle reconciles (GST split, milestones, change orders with tax, approve-before-pay gates). The audit log is complete. The CSV contains only the studio's own rows.

## Remaining risks / owner actions
1. Run `supabase/APPLY-0146.sql` on staging first, check that every verify row says ok = true, then run it on prod.
2. Run a privileged catalog check on both databases for 100% RLS coverage and anon function grants: `pg_class.relrowsecurity` for tables with `org_id`, and `has_function_privilege('anon', ...)`.
3. Run a live cross-tenant probe with two studio test accounts (PostgREST + storage + realtime). This audit could not do it.
4. Deploy invite-mailer on staging. Review item 7 (config fail-closed) and item 12 (Trusted Types enforcement).
