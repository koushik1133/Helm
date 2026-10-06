# Owner actions — security (OWASP audit, Oct 2026)

These are the security fixes that code cannot make. Each one needs the owner's
login to GitHub, Vercel, Supabase, the domain registrar/DNS, or Google Cloud.
They come from the OWASP scorecard (Information Gathering, Configuration /
Transport, Authentication, Data Validation, HTML5). Tick each box when it is done
and write the date next to it.

Order: do **1–3 first**. They close the issues an outsider can use today.

---

## 1. Rotate or delete the default-password accounts — CRITICAL, do now

There are 11 production accounts still on published default passwords:
`admin@helm.com`, 5 `@helm.events` managers, and
`client|crew|operations|planner|sales@helm.com`. Staging synthetic users share
`helm0909`, which is printed in `docs/tester-guide/index.html`.

- [ ] Supabase → project `nqltzgiwznphugcfhmbm` (prod) → SQL Editor. Run
      `supabase/audit/P3-CHECK-default-passwords.sql` and **read the row count**.
- [ ] Run `supabase/audit/P3-FIX-rotate-default-passwords.sql`, or delete these
      users (Authentication → Users → ⋯ → Delete user) and recreate them on
      `@helm.events` once MX exists (step 4).
- [ ] Re-run P3-CHECK. It must return **0 rows**.
- [ ] Staging (`xizehqgeyjcfpzrdymly`): reset every synthetic user's password
      (Authentication → Users → ⋯ → Send password recovery, or set a new one).
      Put the new value only in `~/.helm-e2e.env` (gitignored).
- [ ] Remove the password from `docs/tester-guide/index.html` (code PR), then
      treat it as disclosed. It stays in git history until step 2.

## 2. Make the GitHub repositories private — planned for the end of the audit

The repos `koushik1133/Helm` and `praneethreddykiwik/Helm` are public. They
contain the full schema, the audit and red-team documents, and the seed and
default-password tooling.

- [ ] github.com/koushik1133/Helm → Settings → General → Danger Zone →
      **Change repository visibility** → Private. Type the repo name to confirm.
- [ ] Do the same for github.com/praneethreddykiwik/Helm (the `prod` remote).
- [ ] Vercel: check that both projects still deploy after the change.
      (Vercel → Project → Settings → Git: the GitHub app keeps access to private
      repos it is installed on. If it does not, reinstall it for that repo.)
- [ ] Optional: if a repo ever has to stay public, move `docs/completion/`,
      `docs/STAGING-REDTEAM-MATRIX.md`, `tests/staging/redteam.mjs`,
      `supabase/audit/`, `supabase/seed-users.sql` and `docs/tester-guide/` into a
      private repo, and purge them from history (`git filter-repo`).

## 3. Turn off open sign-up on staging

The production bundle (`public/config.js`) ships the staging URL and anon key on
purpose. Preview hosts need them, and production hosts can never select staging:
`tests/staging/env-routing.test.mjs` and `test/html5-config-hardening.test.mjs`
(STOR-01) pin this. Staging still accepts public sign-ups
(`disable_signup:false`), so anyone can create a staging account and reach the
staging Edge Functions.

- [ ] Supabase → staging `xizehqgeyjcfpzrdymly` → Authentication → Sign In / Providers
      → **Allow new users to sign up: OFF**. Use invite-only for testers.
- [ ] Check it: `GET https://xizehqgeyjcfpzrdymly.supabase.co/auth/v1/settings` with
      the anon key must show `"disable_signup": true`.
- [ ] Until the staging Edge Functions are hardened, undeploy them or unset their
      provider secrets: Edge Functions → `send-whatsapp`, `send-otp`,
      `create-payment-link` → Delete, or Settings → Secrets → remove
      MSG91 / Meta / Razorpay keys.
- [ ] Vercel → Project → Settings → Deployment Protection → turn on
      **Vercel Authentication** for Preview deployments.

## 4. Provision `security@helm.events` and the MX records

`public/.well-known/security.txt` advertises `mailto:security@helm.events`, but
helm.events has no MX record, so reports bounce. The default-account recreation
(step 1) and Supabase auth emails also need a mailbox on the domain.

- [ ] Pick a mail host (for example Google Workspace, Zoho or Fastmail) and add
      helm.events there.
- [ ] At the DNS host for helm.events, add the provider's **MX** records, plus
      **SPF** (`TXT v=spf1 include:<provider> -all`), **DKIM** (the provider's TXT
      or CNAME) and **DMARC** (`TXT _dmarc  v=DMARC1; p=quarantine; rua=mailto:security@helm.events`).
- [ ] Create the mailbox or alias `security@helm.events`. Send a test email from
      an outside account.
- [ ] Optional: in Supabase → Authentication → Emails → SMTP Settings, use this
      domain as the sender, and enable the security notifications (password
      changed, email changed, MFA changed).

## 5. Enable GitHub private vulnerability reporting

security.txt links to the GitHub advisory form, which currently redirects
because the feature is off.

- [ ] github.com/koushik1133/Helm → Settings → **Code security** (or "Security") →
      Private vulnerability reporting → **Enable**.
- [ ] Check it: github.com/koushik1133/Helm/security/advisories/new opens a form.
- [ ] If the repo goes private (step 2), keep `security@helm.events` as the
      primary contact in `public/.well-known/security.txt` (the advisory form
      is only for people with access).

## 6. Vercel: remove the extra production alias `helm-alpha-nine.vercel.app`

`helm-alpha-nine.vercel.app` serves production (same content, wired to the prod
DB through `PROD_HOSTS` in `public/config.js`). It is not in the documented host
inventory, and its sessions live in a separate origin.

- [ ] Vercel → the project that owns it → Settings → **Domains**. Remove
      `helm-alpha-nine.vercel.app` if nothing uses it. If it must stay, set it to
      **Redirect to** `www.helm.events` (308).
- [ ] After removal, open a code PR that drops `'helm-alpha-nine.vercel.app'` from
      `PROD_HOSTS` in `public/config.js`, and from the STOR-01 host list in
      `test/html5-config-hardening.test.mjs`. **Order matters**: if the alias
      still served the app after it left `PROD_HOSTS`, it would be treated as a
      preview host and switch to staging.
- [ ] If the alias is kept, it serves the same deployment, so it gets the same
      `vercel.json` headers. Check it once:
      `curl -sI https://helm-alpha-nine.vercel.app/ | grep -i -E 'strict-transport|content-security'`
      should match `www.helm.events`.
- [ ] Optional: redirect `helm-v01.vercel.app` to `www.helm.events` too, once it
      is no longer used for release checks.

## 7. HSTS: make the apex send the full header, then submit to the preload list

`www.helm.events` sends `max-age=63072000; includeSubDomains; preload` on every
response, including redirects that `vercel.json` makes. The apex
`helm.events → www` redirect is made by Vercel's **domain setting**, so it sends
only `max-age=63072000` (no includeSubDomains/preload), and the domain is not
preload-eligible.

`vercel.json` now has a host-matched redirect (`has: host = helm.events`,
`/:path*` → `https://www.helm.events/:path*`, permanent). It takes effect once the
apex is served by the project instead of by the domain-level redirect:

- [ ] Vercel → Project → Settings → **Domains** → `helm.events` → Edit → change
      "Redirect to www.helm.events" to **No redirect** (connect it to Production).
      The vercel.json rule then makes the redirect, with the full HSTS header.
- [ ] Check it: `curl -sI https://helm.events/ | grep -i -E '^HTTP|location|strict-transport'`
      should show `308`, `location: https://www.helm.events/`, and
      `max-age=63072000; includeSubDomains; preload`.
- [ ] Check every subdomain of helm.events serves HTTPS (`crt.sh/?q=%25.helm.events`
      lists them). includeSubDomains forces HTTPS on all of them.
- [ ] Submit `helm.events` at https://hstspreload.org. It is hard to undo
      (removal takes months), so do it only after the check above passes.
- [ ] Optional: add a CAA record restricting issuance to the CAs Vercel uses
      (`0 issue "letsencrypt.org"`, `0 issue "pki.goog"`).

## 8. Supabase Auth hardening (dashboard settings, both projects)

- [ ] Authentication → Policies / Passwords: minimum length **12**, require
      character classes, enable **leaked-password protection**.
- [ ] Authentication → Rate Limits: tighten sign-in / token / OTP / recover limits per IP.
- [ ] Authentication → Attack Protection: enable **CAPTCHA (Cloudflare Turnstile)**
      and paste the secret key. The site key goes in the login page (auth work, 0028).
- [ ] Authentication → Sessions: set a **time-box** (for example 7–30 days) and an
      **inactivity timeout** (for example 8–24 h). Set JWT expiry to 15–30 min (Settings → JWT).
- [ ] Authentication → MFA: enable TOTP and require it for admin/manager/finance (auth work, 0028).
- [ ] Authentication → URL Configuration: the redirect allowlist must contain only
      `https://www.helm.events/**` (plus the staging host on staging).
- [ ] Settings → Database → **Network Restrictions**: allowlist only the IPs that need
      direct Postgres access (or confirm a strong DB password and SSL enforcement).

## 9. Supabase billing / invoices

- [ ] Supabase → Organization → **Billing**: set the billing/invoice email to a
      mailbox the owner reads (for example `billing@helm.events` once MX exists),
      and check the payment method on file.
- [ ] Turn the **Spend Cap** on (or set usage alerts) so abuse of storage, Edge
      Functions or auth email/SMS cannot run up an uncapped invoice.
- [ ] Review the last invoices for unexpected usage (Edge Function invocations,
      storage egress, auth SMS) as a cheap abuse signal.

## 10. Vercel firewall / monitoring

- [ ] Vercel → Firewall: the current challenge mode blocks non-browser clients.
      This is a good control, but add a **bypass rule** for your uptime monitor,
      and allow known link-preview bots on `/i/*` and `/<studio>/<kind>/<ref>` if
      WhatsApp/iMessage previews of client links matter.
- [ ] Add a rate-limit rule on `/i/*` and the studio link paths.
- [ ] Optional: a scheduled header snapshot (`curl -sD-` on `/`, `/login`, a branded
      link, `/i/x`, `/store-api.js`, a 404) using a firewall bypass token, stored as evidence.

---

## Notes (no owner action needed)

- **CORS on the static site.** Vercel adds `Access-Control-Allow-Origin: *` to
  static assets. That is fine: they are public files, and no cookie or credential
  is involved. Helm sends no `Access-Control-*` header from `vercel.json` or
  `public/_headers` on any HTML or app route. App data is fetched from Supabase
  with a bearer token, never with cookies, so the site origin's CORS cannot leak
  it. `server.js` sends `Access-Control-Allow-Origin: *` only on its local-dev
  `/api/*` JSON (loopback-only, or bearer-token-gated), which is not deployed.
  Pinned by CORS-01 in `test/html5-config-hardening.test.mjs`.
- **Internal files.** `public/_headers` (Cloudflare/Netlify header file, kept for the
  parity tests) and `public/vendor/README.md` are excluded from the Vercel upload
  by `.vercelignore`, and `vercel.json` also redirects them (and any `.md/.map/
  .sql/.bak/.log/.env/.DS_Store` path) to `/404`. After the next deploy, check:
  `curl -sI https://www.helm.events/_headers` must not return 200 with the file.
- **User manual.** `/docs/USER-MANUAL` stays public on purpose. The dashboard's
  "📖 Manual" button links to it, and a static host cannot put it behind login.
  It holds only end-user help and demo screenshots, with no credentials or
  internals, and is `noindex`.
- **sim-pay.html** and the **Edge Function CORS preview-origin regex** belong to the
  uploads/payments work (0027), not this list.
