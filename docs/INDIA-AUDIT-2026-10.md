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
| 13 | P3 | Amount in words | `BPStore.amountInWords` rounded to whole rupees. Now works in paise: ₹1,250.50 → "Rupees One Thousand Two Hundred Fifty and Fifty Paise only" (public/store-api.js:9155). Pass 2. | FIXED |
| 14 | P3 | Portal | milestone due dates now dd/mm/yyyy; event "when" line still uses its own formatter — verify on device. | OPEN |
| 15 | P3 | Wording | Helm sends no client-facing payment-received SMS/WhatsApp of its own (client receipt = e-mail, fixed in #3; Razorpay's own SMS is Razorpay's text). The staff `pkg_payment` WhatsApp now appends "Balance due: ₹X." / "Paid in full." whenever the caller passes `balance` (supabase/functions/pkg-client-notify/templates.ts:88). The 0069 SQL caller does not pass it yet — wiring needs a migration (0099), deferred. | PARTIAL |

Not verified in this pass (need live/staging session): OTP +91 delivery, Razorpay live link, 375px
screenshots of every page, PDF export rendering, reminders cron timing in IST on the server.

Owner action: run `supabase/migrations/0098_public_paid_status.sql` on staging then prod (additive, one
read-only function). Until then the approval/portal pages show neutral "Payment recorded" wording.


## Pass 2 (branch fix/india-polish-2) — areas not covered by pass 1

Method: code reading + headless Node runs of the pure modules (smart-import-core, flow-dish-editor,
layout-wizard, amountInWords via vm) + `npm run ci`. Regression tests: `test/india-polish-2.test.mjs`.
No browser / live Supabase session in this pass.

| # | Sev | Area | Finding (evidence) | Status |
|---|-----|------|--------------------|--------|
| 16 | P2 | Smart import | Hindi (Devanagari) headers "नाम / मोबाइल / दर (₹) / शहर" were stripped to "" by `normHeader` and imported as unnamed custom fields; Hinglish "Shahar" (city) unmapped. Added a Hindi/Hinglish header dictionary before normalisation (public/smart-import-core.js:30). "Naam / Mobile / Rate (₹)" already worked. | FIXED |
| 17 | P1 | Menu / dish editor | Every dish typed into the flow dish editor was saved to the catalogue as `kind:"veg"` (public/flow-dish-editor.js:59 old) — "Chicken 65" showed a veg mark to the client. New `kindOf(course,name)` → "nonveg" for a non-veg course or meat/fish/egg words (eggless stays veg). | FIXED |
| 18 | P2 | Layout wizard | `typeKey()` fell back to **wedding (mandap)** for Mehendi / Haldi / Roka and any free-text type like "Political rally", "Birthday party", "Corporate offsite" (public/layout-wizard.js:82). Added mehendi/mehndi/haldi/roka → engagement and a per-word match before the wedding fallback. | FIXED |
| 19 | P2 | Reports CSV | `reports.html` CSV had no UTF-8 BOM, so Excel (Windows) showed ₹ and Hindi names as mojibake (public/reports.html:184). BOM added (smart-import and onboarding exports already had it). | FIXED |
| 20 | — | Address / phone | Verified: 36 states/UTs (28 + 8) in public/country-profile.js:23; PIN `^[1-9][0-9]{5}$` (country-profile.js:44, onboarding-core.js:545); +91 phone normaliser `^[6-9]\d{9}$` (store-api.js:6849). | OK |
| 21 | — | Pricing engine | Client/server equality, D7 rupee rounding, coupons, catering mode covered by existing pricing-differential(-extended), d8-pricing-authority-gap, per-currency-totals tests — all green; no new defect found by reading. GST rate split catering vs rental not modelled separately (single quote rate) — product decision, see #23. | OK |
| 22 | — | Not re-verified here | Flow.html 8-step reload/back-forward/unsaved guard (beforeunload present, flow.html:1268), proposal terms v1-2026-09 text, settlement/close_event gate, team chat, invitation sites, booklet: only spot-read; need a live staging walk-through. | NOT VERIFIED |
| 23 | P3 | GST | Outdoor catering (5% no-ITC / 18%) vs rental/decor (18%) are taxed at one quote-level rate. Proposal: per-line `tax_rate` on quote items, GST summary grouped by rate on the invoice. Needs migration + decision. | OPEN |

### #11 client GSTIN — proposal (OPEN)
Add `gstin text` (nullable, CHECK 15-char GSTIN regex) to `clients` (source of truth) and snapshot it on
`quotes.client_gstin` at approval so an issued invoice never changes. Form field on client + flow step 1
(India only, optional), validated with the existing `GSTIN_RE`; printed under "Bill to" with the client
state code driving place of supply (first two GSTIN digits). Additive migration 0099; no backfill.

### #12 invoice serial — proposal (OPEN)
New table `invoice_counters(org_id, fy text, next int)` + `quotes.invoice_no text unique per org`,
assigned once by a SECURITY DEFINER `assign_invoice_no(quote_id)` at first invoice print/payment,
format `INV/2026-27/0001` (≤16 chars), FY = Apr–Mar IST, gap-free via row lock. Existing quotes keep
the code until invoiced. Decision needed: assign at advance receipt or at final invoice.
