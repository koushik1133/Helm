# India-first audit — October 2026 (branch fix/india-polish)

Scope: lead → client → quote (flow) → pricing/GST → proposal → approval link → advance payment →
receipts/invoice → settlement → portal/booklet → reminders/dates. Method: code reading + the test
suite (`npm run ci`) + new regression tests in `test/india-polish.test.mjs`. Live OTP / Razorpay /
375px device checks were NOT run in this pass (no live creds / browser session) — see "Not verified".

| # | Sev | Area | Finding (evidence) | Status |
|---|-----|------|--------------------|--------|
| 1 | P1 | Approval link | `approve.html` showed "🎉 Payment received — your event is confirmed" whenever `approval_status='paid'`, even for a ₹50,000 advance on ₹3,06,800 (12202026-01). Now `showPaid()` (public/approve.html:273) reads paid vs total from the `quote_payments` ledger via new RPC `public_quote_paid_status` (supabase/migrations/0098_public_paid_status.sql) and shows "Advance of ₹50,000 received (receipt RCP-…). Balance ₹2,56,800 due by dd/mm/yyyy" (balance_due_days from payment terms, else event date); "Paid in full" only when paid ≥ total. Before 0098 is applied it falls back to neutral "Payment recorded" wording. | FIXED |
| 2 | P1 | Client portal | `portal.html` badge said "Paid" and outstanding came from milestones only (public/portal.html:142, 163). Now `ledgerPaid()` (portal.html:128) uses the same ledger RPC: "Advance received" / "Paid in full", received + balance + due date. | FIXED |
| 3 | P1 | Payment e-mail | razorpay-webhook receipt e-mail printed the quote TOTAL as "Amount" and "Your event is confirmed" for an advance (supabase/functions/razorpay-webhook/index.ts:133). Now: amount actually received, quote total, balance due, or "paid in full". | FIXED |
| 4 | P2 | Booklet | package status card titled "Payment received" with a balance still due (public/booklet-pkg.js:95). Now "Advance received — balance due" / "Paid in full". | FIXED |
| 5 | P1 | GST (flow) | Guided flow hard-coded `placeOfSupply:"intra"` (public/flow.html:479 old) — an out-of-state client got CGST+SGST instead of IGST, and every flow save overwrote an "inter" set on the Quotes page. Now `flowPos()` keeps the quote's value, else derives from studio billing state vs client state (flow.html:469). | FIXED |
| 6 | P2 | Dashboard | Saved-quote row total used `inr()` (studio ₹) instead of the quote's own currency (public/dashboard.html:465). Now `BPStore.quoteMoney(s.total, s)`. | FIXED |
| 7 | P2 | Invoice | Printed invoice had no Place of supply line (GST rule 46) — added for India with intra/inter label (public/quotes.html:759). | FIXED |
| 8 | P2 | Invoice | Discount row printed AFTER the GST rows although GST is charged on the post-discount value — read as tax on the gross. Moved above tax (quotes.html). | FIXED |
| 9 | P2 | Dates / IST | Nurture "today" used `toISOString()` (UTC) → follow-ups due today not flagged 00:00–05:30 IST; "next year" date same (public/nurture.html:181, 214). Now `BPStore.todayLocal()`. | FIXED |
| 10 | P2 | Dates | Browser-default `toLocaleString()/toLocaleDateString()` (mm/dd on en-US browsers) on dashboard, approve "Recorded on", builder drafts/versions, inventory check-in/out, quotes list; ISO yyyy-mm-dd shown raw on invoice event date, "Balance due by", nurture. Now dd/mm/yyyy via `BPStore.fmtDateIN / fmtDay / fmtDateTime` (US studios keep US order). | FIXED |
| 11 | P2 | GST invoice | No client GSTIN field on quotes/clients, so a B2B (corporate) client's GSTIN never prints — the client cannot claim ITC. Needs a product decision (client record vs quote) + form field. | OPEN |
| 12 | P2 | GST invoice | "Invoice" number = quote code (e.g. 12202026-01); GST rule 46 wants a consecutive per-financial-year serial (≤16 chars). Needs a numbering migration + decision on FY reset. | OPEN |
| 13 | P3 | Amount in words | `BPStore.amountInWords` rounds to whole rupees — paise ("and Fifty Paise") never shown (public/store-api.js:9155). | OPEN |
| 14 | P3 | Portal | milestone due dates now dd/mm/yyyy; event "when" line still uses its own formatter — verify on device. | OPEN |
| 15 | P3 | Wording | Client SMS/WhatsApp templates for "payment received" should also carry balance due (only e-mail + pages changed here). | OPEN |

Not verified in this pass (need live/staging session): OTP +91 delivery, Razorpay live link, 375px
screenshots of every page, PDF export rendering, reminders cron timing in IST on the server.

Owner action: run `supabase/migrations/0098_public_paid_status.sql` on staging then prod (additive, one
read-only function). Until then the approval/portal pages show neutral "Payment recorded" wording.
