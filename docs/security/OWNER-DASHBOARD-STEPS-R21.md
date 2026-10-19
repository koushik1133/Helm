# Owner dashboard steps - round 21 security posture

These are the owner's steps for the top 10 actions in `SECURITY-POSTURE-CHECKLIST.md` (19 Oct 2026). The code side is in
branch `fix/r21-security` (migration **0249**). Every switch it adds is **OFF**, so the site behaves exactly as
before until you do the steps below.

Do them in this order. The rough score gain from the checklist is shown in brackets.

| # | Section | Time |
|---|---|---|
| 1 | B. Default-password accounts | 30 min (+4 %) |
| 2 | A. GitHub: private repos, ruleset, Dependabot | 20 min (+4 %) |
| 3 | C. Two-step for HQ, admins and the provider consoles | 1 h (+3 %) |
| 4 | D. Cloudflare Turnstile | 45 min (+2 %) |
| 5 | I. Backups: PITR + restore drill | half a day (+3 %) |
| 6 | E. Edge functions: rate limits + config.toml | 20 min (+1.5 %) |
| 7 | G. Legal facts | 1 h (+1.5 %) |
| 8 | J. Staging lock-down | 15 min (+1 %) |
| 9 | F. Monitoring | half a day (+2.5 %) |
| 10 | H. DNS + redirects | 45 min (+1.5 %) |

---

## A. GitHub - both `koushik1133/Helm` and `praneethreddykiwik/Helm`

1. **Make the repos private.** Settings -> General -> Danger Zone -> Change repository visibility -> **Private**.
   Then, in Vercel -> Project -> Settings -> Git, check that the next push still deploys. Vercel keeps access through its GitHub app.
2. **Add a branch ruleset.** Settings -> Rules -> Rulesets -> **New branch ruleset**:
   - Name `main protection`. Enforcement **Active**. Target branches -> Add target -> **Include default branch**.
   - Tick **Restrict deletions**, **Block force pushes**, and **Require a pull request before merging** (approvals 0 or 1 -
     with 1, the other owner must approve).
   - Tick **Require status checks to pass**, then add `ci` and `CodeQL` (they appear after one run).
   - Save.
3. **Turn on code security.** Settings -> Code security:
   - **Dependabot alerts: Enable**
   - **Dependabot security updates: Enable**
   - **Private vulnerability reporting: Enable**
   - Secret scanning and push protection are already on.
4. **Triage CodeQL.** Security -> Code scanning. After this branch is merged and CodeQL has run, the 16 fixed alerts close
   on their own. Dismiss the other 19 with the reason and comment listed in `docs/security/CODEQL-TRIAGE-R21.md`, section 3.
5. **Environments.** Settings -> Environments -> `staging-tests` and `production` -> Required reviewers = you.
   Add the `HELM_E2E_*` secrets so `e2e.yml` really runs.
6. **Your own account.** Settings -> Password and authentication -> two-factor with an authenticator app or passkey. Do this on both owner accounts.

## B. Default-password accounts (production) - do this FIRST

1. Supabase (prod `nqltzgiwznphugcfhmbm`) -> SQL editor. Run `supabase/audit/P3-CHECK-default-passwords.sql` (read-only).
   It lists the accounts.
2. For the `@helm.com` test logins, use the two scripts kept OUTSIDE the repo in `~/Desktop/Agency/Helm/`:
   - `HELM-COM-ACCOUNTS-1-PREVIEW.sql` is read-only. Review the `plan` column.
   - `HELM-COM-ACCOUNTS-2-LOCK.sql` bans every `@helm.com` login except `admin@helm.com` and HQ operators. Nothing is
     deleted, and its UNLOCK block reverses it. Note: it creates and truncates a helper table `public.zz_lock_log`, which
     holds its own log only.
3. For `admin@helm.com` and any other account you keep: Authentication -> Users -> the account -> **Send password
   recovery**, or set a long random password from your password manager. Then **Sign out user**.
4. Run `P3-CHECK-default-passwords.sql` again until it returns **0 rows**.

## C. Two-step verification (HQ operators, studio admins, provider consoles)

What the code now does:
- HQ -> Overview has a new **"HQ two-step readiness"** card. It lists every operator as *two-step on*, *needs set-up*,
  or *never signed in*, and shows how many studio admins have two-step. An operator without two-step gets a
  **"Set up two-step"** button there (scan the QR code, enter the code).
- The database (0249) **refuses** to turn `hq_require_mfa` on while any operator with a login has no authenticator. The
  error names them. So the switch can never lock someone out. Turning it off is never blocked.

Steps:
1. Apply `supabase/APPLY-0249.sql` - staging first, then production. Every VERIFY row must say `t`. Then deploy the site.
2. Each HQ operator (admin@ and security@helm.events): sign in to HQ -> Overview -> **Set up two-step**.
3. Run `supabase/audit/R21-SECURITY-PREFLIGHT.sql` (read-only). Section 1 must show `blocking = false` for everyone.
4. Run `update public.helm_hq_settings set hq_require_mfa = true where id;`
   Also run `update public.platform_admins set require_mfa = true;` (this is the per-operator flag; it is only used while the switch is on).
5. **Studio admins.** Tell them first. Then set `mfaRequiredForAdmins: true` in `public/config.js`, bump `config.js`, and deploy.
   Admins without two-step are asked to set it up at their next sign-in. They are not locked out.
6. **Provider consoles:**
   - Supabase -> Organization -> Settings -> **Require MFA for all members**
   - Vercel -> Team Settings -> Security -> **Enforce two-factor**
   - Google Admin -> Security -> 2-Step Verification -> **Enforce**
   - GoDaddy, Cloudflare, Razorpay and Meta: turn 2FA on.
7. Supabase -> Authentication -> Hooks -> enable **MFA Verification Attempt** -> `hook_mfa_verification_attempt` (0158).
   Test on staging first.

## D. Cloudflare Turnstile (CAPTCHA) - order matters

What the code now does:
- Sign-up, sign-in, password reset and the "Join" flow already send the Turnstile token to Supabase. Supabase verifies it
  when its CAPTCHA is on.
- The free trial starts only after a confirmed sign-up (or Google), so it is covered by that same Supabase check.
- **Sign-in:** the widget is invisible unless Cloudflare wants a click. It becomes a visible check after 3 wrong passwords
  in a tab (`config.js captcha.login`). It can't be skipped entirely: once Supabase CAPTCHA is on, Supabase requires a token
  on EVERY password sign-in.
- **Checkout "Contact sales":** a Turnstile widget plus the new `captcha-verify` edge function. With a secret set, the
  function fails closed: a bad token is refused, and Cloudflare being unreachable means "try again". With no secret it
  fails open. A one-use, 10-minute pass is recorded, and the database asks for it only when
  `helm_hq_settings.rpc_captcha_required` is on.
- CSP: `challenges.cloudflare.com` is allowed in `script-src` and `frame-src` on `/login`, `/reset-password` and `/checkout`
  only. It is never in `connect-src`. Nothing is fetched while the site key is empty.

Steps:
1. Cloudflare -> Turnstile -> **Add site**:
   - Domains: `www.helm.events`, `helm.events`, `helm-v01.vercel.app`, and `localhost` for testing.
   - Mode: **Managed**.
   - Copy the **site key** (public) and the **secret key**.
2. Supabase -> Edge Functions -> Secrets: `TURNSTILE_SECRET_KEY=<secret>` and
   `HELM_TURNSTILE_HOSTNAMES=www.helm.events,helm.events`. Then:
   `supabase functions deploy captcha-verify --no-verify-jwt`.
3. Code PR: put the **site key** in `public/config.js` -> `captcha.siteKey`. Bump `config.js`, deploy, and wait until it is live.
4. Supabase -> Authentication -> Attack Protection -> **Enable CAPTCHA protection** -> Cloudflare Turnstile -> paste the
   **secret** -> Save. Only do this after step 3 is live, otherwise sign-in fails.
5. Test, ideally on staging first:
   - Sign in with a wrong password 3 times; the check becomes visible.
   - Sign in correctly.
   - Sign up.
   - "Forgot password".
   - Checkout -> Contact sales.
6. Then run `update public.helm_hq_settings set rpc_captcha_required = true where id;` (audited).
   Undo: set it to `false`.
- **Undo the whole CAPTCHA** (if sign-in breaks): Supabase Attack Protection -> CAPTCHA **off** first, then clear the site key.

## E. Edge functions - rate limits fail closed + `supabase/config.toml`

What the code now does:
- `_shared/limits.ts` now **fails closed by default**: a database error during the rate check gives a 429. A project without
  `rate_hit` still fails open, with a loud log line. `HELM_RATE_LIMIT_FAIL_CLOSED=false` restores fail-open, and `true` = strict.
- `supabase/config.toml` declares `verify_jwt` for all 24 functions (the 22 existing ones plus `captcha-verify` and `csp-report`),
  with the reason for each.

Steps:
1. Redeploy every function you use, so they pick up the new `limits.ts` and the config. The JWT flags now come from
   `config.toml`, so `--no-verify-jwt` is optional:
   `for f in send-otp create-payment-link send-whatsapp wa-proposal client-mailer invite-mailer invite-signup comms-dispatch welcome-mailer pkg-client-notify billing-reminder email-unsubscribe integrations-test send-phone-code; do supabase functions deploy $f --project-ref nqltzgiwznphugcfhmbm; done`
   Add any dormant function the same way when you turn it on.
2. Optional: `supabase secrets set HELM_RATE_LIMIT_FAIL_CLOSED=true` (strict). Not needed - the default is now closed.
3. Watch the Edge Function logs for a day for `[limits] durable rate limit unavailable`.

## F. Monitoring

See `docs/security/MONITORING-R21.md`:
- deploy `csp-report`
- Sentry DSN -> `config.js` -> `gen-csp`
- uptime monitor
- `security-alert-mailer` checklist

## G. Legal facts - fill in `public/legal-facts.js`

Every `[OWNER TO FILL]` on the 14 public legal pages is now one `data-fact` spot. Its value comes from
`public/legal-facts.js`. An empty value shows a small "To be updated" mark (notes show "To be confirmed"); a visitor never
sees a raw placeholder. **Do not guess these. Get them from your CA or company secretary, and have a lawyer review the pages.**

| Key | What to put | Used on |
|---|---|---|
| `legalEntityName` | Registered company name | grievance, privacy, terms, dpa, refund-policy, copyright |
| `registeredAddress` | Registered office address | grievance, privacy, terms, refund-policy |
| `cin` | CIN (or trade licence no.) | grievance, privacy |
| `gstin` | GSTIN | grievance, terms |
| `uaeTrn` | UAE VAT TRN (only if registered) | terms |
| `sacCode` | Your SAC code, or `true` to confirm "e.g. 998314 / 998431" | terms |
| `jurisdictionLaw` | Governing law ("the laws of India") | terms |
| `jurisdictionSeat` | Courts / arbitration seat ("Hyderabad, India") | terms |
| `paymentProcessor` | e.g. "Razorpay Software Private Limited" | privacy, terms, refund-policy, cookie-policy |
| `hostingRegion` | Database region (today Canada `ca-central-1`; Mumbai after the move) | privacy, subprocessors |
| `grievanceOfficerName`, `grievanceOfficerDesignation` | A real person (DPDP s. 8(10)) | grievance, privacy, terms, data-deletion |
| `grievanceOfficerEmail`, `grievanceOfficerPhone`, `grievanceOfficerAddress` | E-mail, phone, address **in India** | grievance, privacy, terms, data-deletion |
| `dpoName` | DPO / privacy contact name | grievance, privacy, dpa |
| `privacyEmail` | e.g. privacy@helm.events | privacy, dpa, grievance, data-deletion, cookie-policy, subprocessors |
| `supportEmail` | e.g. support@helm.events | terms, sla, ai-notice |
| `billingEmail` | e.g. billing@helm.events | refund-policy |
| `legalEmail` | e.g. legal@helm.events | terms, dpa |
| `legalNotices` | Legal notices e-mail **and** postal address | grievance |
| `securityEmail` | security@helm.events (must exist - step C6 / monitoring) | security, terms, acceptable-use |
| `accessibilityEmail` | Accessibility contact | accessibility |
| `euRepresentative`, `ukRepresentative` | GDPR Art. 27 representative, or "Not required" once counsel confirms | privacy, grievance |
| `copyrightAgent`, `dmcaDesignation` | DMCA agent (name, e-mail, address) and US Copyright Office number | copyright |
| `supportHours` | e.g. "Mon-Sat 10:00-19:00 IST" | sla |
| `statusPageUrl` | e.g. https://status.helm.events (Better Stack status page) | sla |
| `accessibilityAuditDate` | Last self-assessment date (dd/mm/yyyy) | accessibility |
| `slaTargetConfirmed`, `backupPlanConfirmed`, `certificationConfirmed`, `aiImportConfirmed`, `uaeRulesConfirmed`, `subprocessorsConfirmed` | `true` once you have checked the sentence already on the page, or your own wording | sla, security, ai-notice, grievance, subprocessors |

After editing: `node scripts/bump-changed-assets.mjs --base origin/main --apply`, commit, deploy. Then open `/grievance`:
there should be no "To be updated" marks left.

## H. DNS and redirects (GoDaddy DNS + Vercel)

1. **Apex 308 with full HSTS.** Vercel -> Project -> Settings -> Domains -> `helm.events` -> Edit. Choose
   **"Connect to an environment: Production"** with **no redirect**. Vercel's own domain redirect is a 307 and sends no
   includeSubDomains/preload. `vercel.json` already has the 308 apex -> www redirect, and it serves the full HSTS header.
   Check: `curl -sI https://helm.events/` should show `HTTP/2 308`, `location: https://www.helm.events/`, and
   `strict-transport-security: max-age=63072000; includeSubDomains; preload`.
2. **HSTS preload.** First check that every subdomain you use is HTTPS-only (`www`, any mail / status subdomains).
   Then go to https://hstspreload.org -> enter `helm.events` -> fix anything it lists -> **Submit**. Removal takes months,
   so be sure.
3. **CAA records** (GoDaddy -> DNS -> Add -> Type CAA, host `@`). First check the live certificate issuer:
   `echo | openssl s_client -connect www.helm.events:443 -servername www.helm.events 2>/dev/null | openssl x509 -noout -issuer`
   - `0 issue "letsencrypt.org"`
   - `0 issue "pki.goog"` (Google Workspace / Vercel fallback)
   - `0 issue "globalsign.com"` only if the issuer above is GlobalSign
   - `0 iodef "mailto:security@helm.events"`
4. **Delete the dangling `api` record.** In GoDaddy, delete the `api` CNAME (it points at Vercel and returns 404). Then in
   Vercel -> Domains, remove `api.helm.events` if it is listed. Also remove `helm-alpha-nine.vercel.app` there. After that,
   a code PR can drop it from `PROD_HOSTS` and the edge CORS defaults.
5. **DMARC.** Today it is `p=quarantine`. After 2-4 weeks of clean aggregate reports (every legitimate sender passes SPF or
   DKIM), set the TXT record at `_dmarc` to
   `v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:dmarc@helm.events`. Create that mailbox or group first.
6. **SPF.** Once every sender is included (Google Workspace, plus the SMTP / Resend service that sends Supabase and Helm mail),
   change `~all` to **`-all`** in the root TXT `v=spf1 ...` record.
7. Optional:
   - DNSSEC on (GoDaddy -> Domain -> DNSSEC).
   - MTA-STS and TLS-RPT records.
   - Registrar: 2FA, domain lock and auto-renew on.

## I. Backups - Supabase PITR + restore drill

1. Supabase (prod) -> Project Settings -> **Add-ons** -> **Point in Time Recovery** -> 7 days. This needs the Small compute
   add-on. Then check Database -> Backups shows PITR.
2. Restore drill (quarterly):
   - Database -> Backups -> **Restore to a new project** (pick a point 1 hour ago).
   - In the new project, run row counts (`select count(*)` on organizations, quotes, profiles, quote_payments) and compare.
   - Write down how long it took (your RTO) in `docs/DISASTER-RECOVERY-RUNBOOK.md`.
   - Pause or delete the scratch project afterwards.
3. Storage files are NOT in database backups. Schedule a weekly copy of the buckets to your own encrypted R2 or S3 bucket.
4. Sign off the RPO/RTO targets in the runbook (recommended: 5 min / 2 h).

## J. Staging lock-down (`xizehqgeyjcfpzrdymly`)

1. Authentication -> Sign In / Providers: **Allow new users to sign up: OFF**, and **Confirm email: ON**.
2. Project Settings -> API -> JWT secret -> **Roll**. The old service_role key was pasted in chat, so treat it as burned.
   Then update `public/config.staging.js` (anon key, by PR) and any CI secrets.
3. Reset every synthetic tester password. Keep the new values only in `~/.helm-e2e.env` and GitHub Secrets.
4. Remove provider secrets you don't use from staging edge functions.

## K. Supabase Auth settings (production) - quick confirmations

- Attack Protection -> leaked-password protection **ON**.
- Rate Limits: sign-in and sign-up about 10-30 per 5 min per IP.
- Sessions: time-box **7 days**, inactivity **24 h**. JWT expiry 1800 s.
- URL Configuration: Site URL `https://www.helm.events`, redirect allowlist exactly `https://www.helm.events/**`.
- Project Settings -> Database: **Enforce SSL ON**, Network Restrictions to known IPs.
- Organization -> Billing: spend cap or usage alerts.
