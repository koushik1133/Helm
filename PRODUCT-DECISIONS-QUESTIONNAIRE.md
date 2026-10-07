# Helm — Business Decisions Questionnaire

A few business choices shape how we build the next version. Each question has a short
plain-English explanation and the options — just tick or write your preference under
**Your choice:**. No technical knowledge needed.

---

## 1. How events move through their stages

An event in Helm passes through stages, roughly:
**Enquiry → Quote → Confirmed → Event day → Settled → Closed.**

**1.1 — Should the system enforce that order?**
Right now a staff member can jump an event straight to any stage (for example, mark a
brand-new enquiry as "Confirmed" or "Closed" without pricing it or taking a payment).
- (a) Enforce the order — you can't confirm an event before it's priced, and can't close
  it before it's paid and finished.
- (b) Let a manager/admin override the order when they need to, but warn others.
- (c) Keep it fully open — anyone can move an event to any stage anytime.

Your choice: ______________________________________________

**1.2 — Can an event be closed while the client still owes money (or a vendor is unpaid)?**
- (a) No — block closing until everything is paid, unless a manager overrides with a note.
- (b) Allow it, but show a clear warning first.
- (c) Allow it with no warning.

Your choice: ______________________________________________

---

## 2. Who can do what (staff roles & permissions)

Helm has roles (admin, manager, sales, operations, planner, designer, etc.) and a settings
screen where you tick which areas each role can see and edit.

**2.1 — Should that settings screen control *everything* a role can do?**
Today it controls viewing and editing, but a few actions (creating, converting, and deleting
leads) still follow fixed rules — so a role can be blocked from editing yet still create or
delete. Should the settings screen be the single source of truth for all of it?
- (a) Yes — the permissions screen decides view, create, edit, and delete for every area.
- (b) No — keep create/delete limited to senior roles (admin/manager/sales) regardless.

Your choice: ______________________________________________

**2.2 — Who should be allowed to see money information (profit, settlements, invoices)?**
- (a) Only roles you grant "finance" access to (admin always).
- (b) A fixed set, e.g. admin and manager only.
- (c) Other (describe): ______________________________________________

Your choice: ______________________________________________

**2.3 — Who should be allowed to record a payment, mark an invoice paid, or settle a vendor?**
- (a) Anyone with finance access (plus admin/manager).
- (b) Admin and manager only.
- (c) Other (describe): ______________________________________________

Your choice: ______________________________________________

---

## 3. Money: tax, currency & going global

Helm will be used in different countries, so tax and currency should follow the country the
company picks when they sign up — not be fixed to India.

**3.1 — Which countries must work at launch?**
(for example: India, UAE/Dubai, Saudi Arabia, UK, USA…)

Your answer: ______________________________________________

**3.2 — What tax applies in each of those countries?**
Please give the tax name and rate(s) for each country, and any special rule.
- India (GST): single rate like 18%, or split by in-state/out-of-state? Which rate for
  events and for catering?
  Your answer: ______________________________________________
- UAE / Dubai (VAT): standard 5%? Any cases that are tax-free?
  Your answer: ______________________________________________
- Other countries: name, rate, rules:
  Your answer: ______________________________________________

**3.3 — Should tax be the same across the whole bill?**
Today catering and the rest can have different tax rates. Do you want **one tax rate** for
the whole quote per country, or the ability to tax catering differently?

Your choice: ______________________________________________

**3.4 — Can each company change their own tax rate, or is it fixed by country?**
- (a) Fixed by country automatically.
- (b) Fixed by default, but an admin can adjust it.
- (c) Fully manual each time.

Your choice: ______________________________________________

**3.5 — Tax registration numbers on invoices.**
Should we capture and print each company's tax number on quotes/invoices?
(India GSTIN, UAE TRN, EU VAT number, etc.) Required, optional, or not needed?

Your choice: ______________________________________________

**3.6 — Currency.**
- (a) Each company's currency follows their country (₹, AED, £, $…).
- (b) Allow multiple currencies within one company.
Any rounding preference (e.g. whole rupees, 2 decimals for dollars)?

Your choice: ______________________________________________

**3.7 — Invoice format rules per country.**
Any legal must-haves on invoices in your launch countries? (e.g. tax breakdown wording,
sequential invoice numbers, Arabic + English invoices in the UAE)

Your answer: ______________________________________________

**3.8 — What should profit include?**
When Helm shows profit for an event, should it subtract staff expense claims and refunds
given to the client (giving the true net profit), or show profit before those?

Your choice: ______________________________________________

**3.9 — A couple of tax detail rules:**
- Is the **service charge** taxable?
- Are discounts applied **before or after** tax?
- Any **tax-exempt** clients (government, charity, business-to-business)?

Your answer: ______________________________________________

---

## 4. Look & branding

**4.1 — Primary colour.**
We're moving away from the current violet/blue. What colour would you like as the main
brand colour? (a colour name or code, or share your brand/logo guide)

Your answer: ______________________________________________

**4.2 — Light & dark mode — keep both?**  Your choice: ______________________

**4.3 — Should each client company be able to set their own colour and logo (white-label)?**

Your choice: ______________________________________________

**4.4 — Final product name and logo to use on the app and invoices?**

Your answer: ______________________________________________

---

## 5. Next-phase features (tell us Yes / No and a priority 1–3)

For each: do you want it, and how important? We'll follow up with details on the "Yes" ones.

- **5.1 Online payments** (clients pay advances/balances online — e.g. Razorpay in India,
  a card gateway for UAE/global). Which?  → ______
- **5.2 Client messaging** by WhatsApp, email, and SMS (approvals, reminders, receipts).  → ______
- **5.3 Clients sign the quote/contract online (e-signature).**  → ______
- **5.4 Automatic deposits & refunds** (auto-schedule the advance, auto-receipt, track refunds).  → ______
- **5.5 A richer client portal** (client sees their timeline, pays, approves, downloads invoice).  → ______
- **5.6 Smarter calendar** that flags clashes by actual time (not just same day).  → ______
- **5.7 A mobile app for event-day staff** (check-in, tasks on the phone).  → ______
- **5.8 Barcodes/QR for equipment** check-out and return.  → ______
- **5.9 Dashboards & analytics** (revenue, win rate, best vendors, repeat clients).  → ______
- **5.10 Multiple branches/locations** under one company.  → ______
- **5.11 AI assistant** that suggests pricing and menus from past events.  → ______
- **5.12 Anything you want that isn't here:**  → ______

---

*That's everything. Your answers to sections 1–3 let us finish the core build; sections 4–5
shape the look and the next phase. Thank you!*
