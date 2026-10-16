# Helm Legal Pages Review (16 October 2026)

> **Status: DRAFT templates.** Have a qualified lawyer in each jurisdiction (India, UAE, US, UK, EU) review the pages before you publish them. Nothing in this document is legal advice. Every page carries the HTML comment "DRAFT Template — have a qualified lawyer in each jurisdiction review before publishing", and the visible placeholders are marked `[OWNER TO FILL: …]` or `[BRACKETED]`.

## 1. Reference repository

- **Source:** `https://github.com/General-Legal/legal-templates`, cloned read-only to the scratchpad. None of its code was executed.
- **Licence:** CC0 1.0 Universal (public domain dedication), so the templates can be reused freely.
- **Contents:** privacy-policy-gdpr, privacy-policy-us, cookie-notice, dpa-global, dpa-us, terms-of-use, master-services-agreement, NDAs, BAA, offer letter and advisor agreement.
- **How it was used:** as a checklist for section coverage, comparing Helm's pages against its GDPR/US privacy, cookie, DPA and terms templates. The comparison found that Helm's existing pages already covered the core template sections. The gaps were in jurisdiction-specific items and in the standalone trust pages that B2B SaaS buyers expect, so both were added.
- **Templates not used:** the BAA (HIPAA) is not applicable because Helm does not process US health data. The NDA, offer letter and advisor agreement are internal documents, not public pages.

## 2. What changed, by document

| Page | Change |
|---|---|
| `privacy.html` | Added §10 "Region-specific information", covering India (DPDP Rules 2025 phase-in dates and the continuing IT Act s.43A / SPDI Rules), UAE (PDPL, DIFC/ADGM carve-out), the 19 US state laws with an appeal process and GPC, the UK (DUAA 2025 complaints duty and ADM safeguards) and the EU. Also added COPPA. Added the UAE transfer basis to §6. The complaint route now names the ICO, the UAE Data Office and the DPB. The sub-processor link now points to the new page. Sections were renumbered. |
| `terms.html` | §5 gained billing details: GST tax invoice fields (GSTIN, place of supply, SAC, e-invoice/IRN threshold), UAE VAT TRN and reverse charge. Added an India Consumer Protection (E-Commerce) Rules 2020 disclosure paragraph. Added links to the SLA and the AI notice. |
| `cookie-policy.html` | Added UK DUAA 2025 analytics/functionality exemption (in force 5 Feb 2026, with an opt-out still offered), EU ePrivacy opt-in, US GPC and the India DPDP note. |
| `dpa.html` | The sub-processor placeholder now links to `/subprocessors`. |
| All 7 existing pages | Updated the draft comment, set the date to 16 Oct 2026, and expanded the footer Legal nav and "related policies" cards to all 14 pages. |
| **NEW** `subprocessors.html` | Lists 9 providers taken from the codebase: Supabase, Vercel, Resend, Razorpay, Meta WhatsApp, Sentry, OpenAI, Google, Cloudflare. Covers purpose, data, region, safeguard, 30-day change notice and the right to object. |
| **NEW** `security.html` | Covers tenant isolation (RLS), encryption, CSP/Trusted Types, MFA, audit log, backups, incident response (DPB 72h, GDPR 72h, CERT-In 6h, UAE) and responsible disclosure. |
| **NEW** `sla.html` | Sets 99.5% uptime `[OWNER TO FILL]`, exclusions, a credit table (10/25/50%), support response targets and status-page notices. |
| **NEW** `accessibility.html` | Targets WCAG 2.2 AA (EAA, ADA, RPwD Act/GIGW). States partial conformance with known limits (builder canvas, PDFs) and gives a feedback route. |
| **NEW** `grievance.html` | Lists the Grievance Officer, DPO, EU/UK representatives and legal notices. Gives response timelines per law and escalation bodies per country. |
| **NEW** `ai-notice.html` | Covers AI photo render and smart import, no training on customer data, no solely-automated significant decisions, EU AI Act Art. 50 labelling and the India synthetic-content labelling rules. |
| **NEW** `copyright.html` | Covers DMCA §512 notice and counter-notice, IT Act s.79 / IT Rules 2021, UAE Copyright Law 38/2021, DSA Art. 16 and the repeat-infringer policy. |

**Not added as separate pages:** Payment/Billing terms and Trial terms. The 8-day no-card trial is already covered in Terms §4 and Refund §2, and billing is now in Terms §5. Splitting them would create duplicate sources of truth.

**Registration of the new pages:** `server.js` INDEXABLE_PAGES, `public/robots.txt` (all user-agent blocks), `public/sitemap.xml`, and the page lists in `test/headers-parity`, `robots-policy` and `auth-gate`. `vercel.json` needs no change because marketing pages are indexable by omission. All new pages pass the CSP rules: no `style=""`, no inline script/style, no innerHTML, and `gen-csp --check` passes.

## 3. Jurisdiction coverage matrix

| Requirement | India | UAE / Dubai | USA | UK | EU |
|---|---|---|---|---|---|
| Privacy notice / lawful basis | Privacy §3–4 (DPDP s.5–7) | Privacy §10 (PDPL) | Privacy §2, §10 (CCPA notice at collection) | Privacy §3 | Privacy §3 |
| Data subject rights | Privacy §9 (access, correct, erase, nominate) | Privacy §10 | Privacy §9–10 (19 states, appeal) | Privacy §9–10 | Privacy §9 |
| Grievance / complaints | Grievance page (90 days DPDP; 48h/1 month E-Com) | Grievance (Data Office, DED) | Grievance (AG, CPPA) | Grievance (30-day ack, s.164A) | Grievance (DPAs) |
| DPO / representative | Grievance Officer | DPO (PDPL Art. 10) | n/a | UK rep (Art. 27) | EU rep (Art. 27) |
| Breach notification | Security, Privacy §8 (DPB 72h, CERT-In 6h) | Security (PDPL Art. 9) | Security (state laws) | Privacy §8 (72h) | Privacy §8 (72h) |
| Cross-border transfers | Privacy §6 (s.16 negative list) | Privacy §6 (Art. 22–23) | n/a | IDTA | SCCs |
| Processor contract / sub-processors | DPA, Sub-processors | DPA, Sub-processors | DPA (service provider), Sub-processors | DPA, Sub-processors | DPA, Sub-processors |
| Cookies / tracking | Cookie policy | Cookie policy | GPC opt-out | DUAA exemption + PECR | ePrivacy opt-in |
| Children | Privacy §11 (DPDP s.9, under 18) | Privacy §11 | COPPA (no under-13) | Privacy §11 | Privacy §11 (Art. 8) |
| Consumer / e-commerce disclosures | Terms §5 (E-Com Rules 2020) | Terms, Grievance | Terms | Terms | Terms |
| Tax invoicing | Terms §5 (GST, SAC, IRN) | Terms §5 (VAT TRN) | Terms §5 (sales tax) | Terms §5 (VAT) | Terms §5 (VAT reverse charge) |
| Marketing email | Privacy §3 (consent) | Privacy §3 | CAN-SPAM: opt-out in Privacy §3 `[add physical address to emails]` | PECR soft opt-in | ePrivacy |
| Accessibility | Accessibility (RPwD/GIGW) | Accessibility | Accessibility (ADA) | Accessibility | Accessibility (EAA) |
| AI transparency | AI notice (IT Rules labelling) | AI notice | AI notice (CCPA ADMT, Colorado AI Act) | AI notice (DUAA ADM) | AI notice (AI Act Art. 50) |
| IP / takedown | Copyright (s.79, IT Rules) | Copyright (DL 38/2021) | Copyright (DMCA) | Copyright | Copyright (DSA Art. 16) |
| SLA / availability | SLA | SLA | SLA | SLA | SLA |

## 4. Key dates relied on (check these before publishing)

- **DPDP Rules 2025:** notified 13/14 Nov 2025. Consent Manager registration applies from about Nov 2026. Most obligations (notice, security, breach reporting, retention, rights) apply from **13 May 2027**.
- **UAE PDPL Executive Regulations:** whether they have been published is **unconfirmed**. Sources conflict, and some cite a 1 Jan 2027 compliance date.
- **UK DUAA 2025:** cookie exemptions in force 5 Feb 2026 (SI 2026/82). Complaints duty (s.164A) in force 19 June 2026.
- **US:** Indiana, Kentucky and Rhode Island in force 1 Jan 2026. COPPA amended rule effective 23 June 2025.
- **EU:** EAA applies from 28 June 2025. AI Act Art. 50 transparency obligations apply from 2 Aug 2026.

## 5. Still needs a lawyer / owner

1. All `[OWNER TO FILL]` items: legal entity, address, CIN/trade licence, GSTIN/TRN, Grievance Officer, DPO, EU/UK representatives, governing law and venue (Terms §15), DMCA agent registration, status page URL, SLA percentage and business hours.
2. Confirm the sub-processor list against signed DPAs and actual regions, especially the Supabase region and whether Cloudflare is in use.
3. Decide whether an EU/UK Art. 27 representative is needed (it depends on whether Helm targets EU/UK customers without an establishment there).
4. UAE: confirm the PDPL Executive Regulations status, whether any studio is DIFC/ADGM-based, and the Arabic-language requirement for consumer-facing terms.
5. India: confirm the SAC code, the e-invoicing threshold, retention periods (8 years under the Companies Act / CGST s.36 is assumed) and DPDP inactivity-erasure periods.
6. CAN-SPAM: every marketing email must carry a valid postal address and a working unsubscribe link. This needs a check in the email templates, not just in the policy.
7. Verify the SLA credit levels and support hours match what Helm can actually deliver.
8. Confirm whether smart import uses an AI provider (`ai-notice.html` has a placeholder).

## 6. Sources (accessed 16 Oct 2026)

- Hogan Lovells, "India's DPDP Act 2023 brought into force" — https://www.hoganlovells.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force-
- Uniqus, "DPDP Act timelines" — https://uniqus.com/digital-personal-data-protection-act-timelines/
- KS&K, "DPDP data breach notification timeline" — https://ksandk.com/md/data-protection-and-data-privacy/dpdp-data-breach-notification-timeline/
- Uppersetup, "UAE PDPL complete business guide" — https://uppersetup.com/en/blog/uae-personal-data-protection-law-pdpl-the-complete-business
- CyberSigma, "UAE PDPL" — https://cybersigmacs.com/knowledge-center/uae-pdpl/
- Kennedys, "DUAA 2025 commencement dates and planned guidance for 2026" — https://www.kennedyslaw.com/en/thought-leadership/article/2026/the-data-use-and-access-act-2025-commencement-dates-and-planned-guidance-for-2026
- Bratby Law, "DUAA 2025: changes now in force" — https://bratby.law/data-use-and-access-act-2025-commencement/
- Clym, "DUAA cookie consent and complaints" — https://www.clym.io/blog/data-use-and-access-act-2025-uk-cookie-consent-complaints
- TrustArc, "New in 2026: Indiana, Kentucky, Rhode Island" — https://trustarc.com/resource/new-in-2026-state-privacy-laws-in-indiana-kentucky-and-rhode-island/
- Hunton, "New U.S. state privacy laws January 2026" — https://www.hunton.com/privacy-and-information-security-law/new-u-s-state-privacy-social-media-and-ai-laws-take-effect-in-january-2026
- General-Legal/legal-templates (CC0 1.0) — https://github.com/General-Legal/legal-templates
- Primary texts to verify against: MeitY (DPDP Act and Rules), legislation.gov.uk (DUAA 2025, SI 2026/82), UAE Official Gazette (FDL 45/2021), 17 U.S.C. §512, W3C WCAG 2.2.
