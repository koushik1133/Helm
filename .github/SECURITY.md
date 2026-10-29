# Security Policy

Helm ([www.helm.events](https://www.helm.events)) is an event-studio SaaS that
event companies use to run quotes, bookings, staffing, payments and client
communication. We take the security of Helm and our customers' data seriously,
and we are grateful to researchers who report issues responsibly.

## Reporting a vulnerability

Please report security vulnerabilities **privately**, using GitHub's Private
vulnerability reporting:

- Open a report here:
  **https://github.com/koushik1133/Helm/security/advisories/new**
- Or, from this repository, go to the **Security** tab and choose
  **"Report a vulnerability"**.

This creates a private advisory that only you and the maintainers can see.

A dedicated security email may be added later; until then, please use private
vulnerability reporting.

Please help keep other users safe:

- **Do not** open a public issue or pull request for a security vulnerability.
- **Do not** disclose the issue publicly until we have confirmed it is fixed and
  agreed on timing with you.

## What to include in a report

A clear report helps us triage and fix the issue quickly. Where possible,
please include:

- The affected URL or endpoint (for example a page on `app.helm.events` or a
  specific API/Edge Function).
- Step-by-step instructions to reproduce the issue.
- The impact — what an attacker could do, and which data or users are affected.
- Any proof-of-concept (request, script, screenshot or short recording).

## Scope

**In scope**

- The Helm web application (`helm.events`, `app.helm.events`).
- Its Supabase backend (database, authentication, Edge Functions) as reached
  through the application.

**Out of scope**

- Automated scanner output without a working, demonstrated proof-of-concept.
- Social engineering of our staff, customers or vendors.
- Physical attacks, or attacks requiring physical access to a device.
- Denial-of-service and volumetric/load testing.
- Issues reproducible only on our public staging/preview environment
  (`helm-v01`) using synthetic test data.
- Best-practice or hardening suggestions with no demonstrated security impact
  (for example, a missing header that leads to no concrete issue).

## Our commitment

Helm is maintained by a small team. We aim to:

- **Acknowledge** your report within **3 business days**.
- Complete initial **triage and severity assessment** within about **7 days**.
- Keep you **updated** on our progress as we investigate and fix the issue.
- **Credit** you for the discovery, if you would like to be named.

These are targets, not guarantees; complex issues may take longer, and we will
let you know if that is the case.

## Safe harbour

We will not pursue or support legal action against researchers who act in good
faith and follow this policy. To stay within safe harbour, please:

- Stay within the scope defined above.
- Do not access, modify, delete or exfiltrate data that is not your own, and
  stop and report immediately if you encounter other users' data.
- Do not run destructive, disruptive or high-volume tests.
- Report any vulnerability you find promptly, and give us reasonable time to
  fix it before any public disclosure.

If you are unsure whether an action is allowed, pause and ask us first through a
private report.

## Supported versions

Helm is a continuously deployed SaaS; there are no numbered releases to pin to.
Only the current production deployment is supported and eligible for security
fixes.

| Version                  | Supported |
| ------------------------ | --------- |
| Production (helm.events) | ✅        |
