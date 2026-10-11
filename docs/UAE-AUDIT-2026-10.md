# UAE-studio audit — October 2026 (branch fix/uae-polish)

Scope: a studio whose country is AE (Dubai), end to end: onboarding / Control Center → lead → quote
(flow + Quotes modal) → pricing / VAT → approval link → payment → invoice / print → booklet / portal /
invitation → settlement / closure / insights → staff / inventory / menu → layout wizard / builder →
demo data. Method: code reading, headless Node runs of the pure modules, `npm run ci`,
`scripts/db-test/run-all.sh` and new regression tests in `test/uae-polish.test.mjs` +
`tests/db/uae-demo-0102.sql`. No live browser / Supabase session (see "Not verified").

## Rules researched (Oct 2026)
- VAT 5% — Federal Decree-Law No. 8 of 2017; tax invoice contents — Executive Regulation (Cabinet
  Decision 52/2017) Art. 59: "Tax Invoice" title, supplier name / address / TRN, recipient name / address /
  TRN where registered, sequential number, date of issue, date of supply, description, rate + VAT amount,
  total in AED (VAT in AED even if invoiced in another currency). Simplified tax invoice allowed when the
  recipient is not registered or the supply is not more than AED 10,000 (sources differ on "under" vs
  "not more than" — check FTA text). Arabic is not mandatory; "Tax Invoice / فاتورة ضريبية" is common.
- TRN = 15 digits; AED has 2-decimal fils; en-AE dates dd/mm/yyyy; Asia/Dubai (UTC+4, no DST); weekend
  Sat–Sun since 2022; +971 (mobile 05X → +9715X); seven emirates; P.O. box addressing, no postal codes.
- Sources: meydanfz.ae/blog/uae-tax-invoice-requirements, mondaq.com/sales-taxes-vat-gst/670546,
  farahatco.com (information included in tax invoices), cleartax.com/ae/create-simplified-vat-invoice-uae,
  nyuad.nyu.edu VAT 2018 guide. Primary text to confirm: tax.gov.ae (Art. 59, VATP006).

## Findings

| # | Sev | Area | Finding (evidence) | Status |
|---|-----|------|--------------------|--------|
| 1 | P1 | Billing / onboarding | A UAE studio could not save billing details without a "Postal code" (required for every non-India country), but the UAE has no postal codes; "P.O. Box 12345" was rejected/sliced to 10 chars (public/onboarding-core.js:526, 544). Now the AE P.O. box is optional, "P.O. Box" prefix stripped, digits ≤6; Control Center label "P.O. box (optional)" (public/control.html:1165). India PIN rule unchanged. | FIXED |
| 2 | P1 | Invoice (Art. 59) | Printed invoice for AE always titled "Tax Invoice", even when the studio has no TRN (a non-registered supplier must not issue a tax invoice) and English only. New `invTitle()` (public/quotes.html:732): AE + supplier TRN → "Tax Invoice / فاتورة ضريبية"; AE without TRN → "Invoice (supplier TRN not set - not a VAT tax invoice)". India "Tax Invoice", others "Invoice" unchanged. | FIXED |
| 3 | P1 | Invoice (Art. 59) | No recipient TRN for a VAT-registered (B2B) UAE client — the client cannot recover input VAT. Optional "Client TRN" field (AE only, 15-digit validation via HelmCountry.validateTaxId) on the Quotes confirm modal (quotes.html:186), stored in quote `client.trn`, printed as "Client TRN" with "Emirate" (quotes.html:775-776). | FIXED |
| 4 | P2 | Quote modal | "Client / event state" with "e.g. Telangana" and CGST/IGST tooltip for a UAE studio; phone placeholder +91. Now "Client emirate" with the 7-emirate list, +971 placeholder (paintTaxCopy, quotes.html:~388). | FIXED |
| 5 | P2 | Layout wizard | Only India-style types (mandap wedding, "Engagement / sangeet", "Political rally") and feet by default (public/layout-wizard.js:60, 119). Added Gala dinner, Iftar / Ramadan tent (halal buffet + majlis sofas, no bar / dance floor), Eid / National Day, Exhibition / trade show; `typesFor('AE')` hides the political rally and renames sangeet → henna night; AE defaults to metres and the mandap starts off. India list / aliases unchanged (Gala → wedding, Expo → conference kept). | FIXED |
| 6 | P2 | Builder units | New layouts always started in feet (public/builder.js:451). Now metres unless the studio is IN / US (a saved layout's unit still wins). | FIXED |
| 7 | P2 | Flow event types | Event-type suggestions were India-only ("Sangeet", "Political", "Religious / Puja"; concepts "Bollywood Glam", "Traditional South Indian") (public/flow.html:369). A UAE studio now gets Iftar, Suhoor, Eid, National Day, Gala dinner, Exhibition, Henna night, Award ceremony + Gulf concepts (flow.html:374). Event-name labels added (public/event-name.js). | FIXED |
| 8 | P2 | Menu | Dish kinds shown as "veg / non-veg" (Indian framing) in Plan and Control Center (public/plan.html:168, control.html:1346). A UAE studio now sees "vegetarian / meat / fish (halal)"; stored kinds unchanged. event.html warning no longer says "veg/non-veg mix" ("menu mix"). | FIXED |
| 9 | P2 | Demo data | "Try with demo data" seeded the Hyderabad demo for a UAE studio: rupees, GST 18%, +91, veg thali, UPI advance. 0102 adds `_demo_seed_ae` (Dubai ballroom + desert camp in metres, halal AED packages AED 295 / 425 pp, AED day rates, +971 00… sample numbers, AED + VAT 5% events priced by the D8 server engine, 50% bank-transfer deposit, DET permit checklist, a B2B gala with client TRN) and the `_demo_seed_for` dispatcher. India `_demo_seed` untouched; only is_demo rows. DB suite `uae-demo-0102` 17/17. | FIXED (run APPLY-0102) |
| 10 | P2 | Client portal (live E2E) | Title "Wedding · 28 Dec 2026" without the client name and a duplicate "Wedding · Monday, 28 December 2026" line (public/portal.html:159-161). Title now gets `client_name` ("Wedding for ZZ India Flow Test · 28 Dec 2026"); second line is the full date only. | FIXED |
| 11 | P2 | Client portal (live E2E) | Payments card said "No payment schedule yet — your planner will share one." on a Paid-in-full event (portal.html:182). Hidden once paid; with no schedule the ledger now shows "Balance AED/₹X due by dd/mm/yyyy" (portal.html:201). | FIXED |
| 12 | — | Verified OK | AE profile (AED, VAT 5%, TRN regex, 7 emirates, +971, Asia/Dubai, en-AE dd/mm) public/country-profile.js:50; quote tax snapshot / inclusive mode (computeTax); approval page AE terms v1-2026-09-AE, +971 default, Pay button hidden, bank/card wording (public/approve.html:160, 179, 267); Razorpay INR-only (supabase/functions/_shared/money.ts:35); OTP SMS non-+91 message (send-otp/index.ts:54); ₹ → AED relabel on settlement / staff / inventory inputs (BPStore.relabel, store-api.js:9293); closure P&L "Revenue (ex-VAT)" + "VAT collected (payable)" (closure.html:186); insights ex-tax revenue + "tax collected (payable)" (insights.html:262, 271); WhatsApp/e-mail money per quote currency (_shared/money.ts). | OK |
| 13 | P3 | Money rounding | Quote totals round to whole AED (D7, server helm_quote_total) — fils are dropped from the grand total; VAT line keeps 2 decimals. Moving to fils needs a server pricing change across currencies. | OPEN |
| 14 | P3 | Invoice number | Art. 59 wants a sequential tax-invoice number; Helm prints the quote code (same as India #12). Needs a numbering migration + decision. | OPEN |
| 15 | P3 | Flow client step | Client TRN / emirate are captured in the Quotes confirm modal only, not in the guided flow step 1. | OPEN |
| 16 | P3 | Reports CSV | P&L / settlement CSV "revenue" columns are gross (incl. VAT); insights and closure already show ex-VAT. | OPEN |
| 17 | P3 | Staff | No Emirates ID field (none for India either). Optional, privacy-sensitive — product decision; not added. | OPEN |
| 18 | P3 | Alcohol | No alcohol-licence note on venues / packages beyond the demo text; venues already have a `no_alcohol` restriction. | OPEN |

## Not verified (need a live staging session)
375px screenshots of a UAE studio, PDF print of the bilingual title (Arabic font fallback), reminders cron
in Asia/Dubai on the server, invitation site dates on device, MSG91 international route.

## Owner action
Run `supabase/APPLY-0102.sql` on staging, then prod (functions only, idempotent, ends with 7 verify rows —
all must be `t`). Until then a UAE studio still gets the India demo.
