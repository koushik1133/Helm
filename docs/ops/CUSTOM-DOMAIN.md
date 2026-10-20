# Own API address: api.helm.events (Supabase custom domain)

**What this gives you:** the Google sign-in screen, sign-in e-mails and the app's data calls show
`api.helm.events` instead of `nqltzgiwznphugcfhmbm.supabase.co`. Same database, same data, same keys.

**Cost:** Supabase "Custom domain" add-on, about **$10 per month** (billed by the hour, about $0.0137 per hour).
It is not covered by the Spend Cap. Needs a paid plan (Pro or higher).

**Safe by design:** the old `nqltzgiwznphugcfhmbm.supabase.co` address keeps working the whole time.
The app does not change until step 9 (one switch in `public/config.js`). Undo = flip it back.

Facts used below (checked 20/10/2026):
- Production project ref: `nqltzgiwznphugcfhmbm`
- `helm.events` DNS is at **GoDaddy** (name servers `ns21.domaincontrol.com`, `ns22.domaincontrol.com`).
- `api.helm.events` **already exists** at GoDaddy as a CNAME pointing to Vercel
  (`6136d3205d3c79af.vercel-dns-017.com`, it only shows a Vercel 404 page). Step 3 changes it.
- `helm.events` has no CAA record, so no certificate-authority setting is needed.

---

## Steps for the owner

1. **Buy the add-on.** Supabase dashboard → project **Helm (nqltzgiwznphugcfhmbm)** → **Project Settings → Add-ons
   → Custom domain** → turn it on (about $10 per month). You need to be Owner or Admin of the project.

2. **Install and sign in to the Supabase CLI** on your Mac (Terminal):
   ```
   brew install supabase/tap/supabase
   supabase login
   ```

3. **Point api.helm.events at Supabase (GoDaddy).** GoDaddy → My Products → `helm.events` → **DNS**.
   Find the existing record **CNAME `api`** (it points to `...vercel-dns-017.com`) → **Edit** it:
   | Type | Name | Value | TTL |
   |---|---|---|---|
   | CNAME | `api` | `nqltzgiwznphugcfhmbm.supabase.co` | 600 seconds (or the lowest offered) |

   Also, in **Vercel → helm project → Settings → Domains**, remove `api.helm.events` if it is listed
   (it is not used by the website).

4. **Register the address with Supabase** (Terminal):
   ```
   supabase domains create --project-ref nqltzgiwznphugcfhmbm --custom-hostname api.helm.events
   ```
   It prints a line like `_acme-challenge.api.helm.events. TXT -> <long value>`. Copy the long value.

5. **Add the proof record (GoDaddy → DNS → Add New Record):**
   | Type | Name | Value | TTL |
   |---|---|---|---|
   | TXT | `_acme-challenge.api` | the long value from step 4 (no spaces before/after) | 600 seconds |

   GoDaddy adds `.helm.events` by itself, so type only `_acme-challenge.api`.

6. **Verify** (Terminal). DNS can take a few minutes to an hour; run it again until it says verified:
   ```
   supabase domains reverify --project-ref nqltzgiwznphugcfhmbm
   ```
   After it is verified Supabase issues the security certificate (up to about 30 minutes).
   To check the status at any time: `supabase domains get --project-ref nqltzgiwznphugcfhmbm`

7. **Google sign-in: add the new return address BEFORE activating.** Google Cloud Console → **APIs & Services →
   Credentials** → the OAuth 2.0 Client used for Helm → **Authorized redirect URIs** → **Add URI**:
   ```
   https://api.helm.events/auth/v1/callback
   ```
   **Keep** the old `https://nqltzgiwznphugcfhmbm.supabase.co/auth/v1/callback` in the list. Save.
   (OAuth consent screen → Authorized domains: make sure `helm.events` is listed.)
   Nothing changes in Supabase → Authentication → URL Configuration (those are the website addresses).

8. **Activate** (Terminal):
   ```
   supabase domains activate --project-ref nqltzgiwznphugcfhmbm
   ```
   From now on Supabase sign-in (Google, e-mail links) uses `api.helm.events`. The old address still works.
   Quick check: open `https://api.helm.events/auth/v1/health` in a browser — it should show a short Supabase
   message (for example "No API key found"), not a Vercel 404 page.

9. **Try it in your own browser first (optional).** On https://www.helm.events open the browser console and run
   `localStorage.setItem('helm.apiDomain', 'custom')`, reload, sign in, open a few pages.
   Undo: `localStorage.removeItem('helm.apiDomain')`.

10. **Tell Claude: "flip the API domain switch".** Claude changes ONE line in `public/config.js`
    (`useCustomDomain: false` → `true`), runs the tests and opens a PR. Merge + deploy as usual.
    Everyone stays signed in (the app keeps the same sign-in key on both addresses).

## What stays as it is (no action needed)
- The scheduled e-mail job (`helm_comms_dispatch` cron) can keep calling `nqltzgiwznphugcfhmbm.supabase.co`.
- Edge Functions keep their built-in `SUPABASE_URL` (supabase.co); they are also reachable at
  `https://api.helm.events/functions/v1/<name>`.
- Razorpay / WhatsApp webhook addresses registered with those companies keep working on supabase.co.
- Photos and files already saved with a supabase.co link keep loading (both addresses are allowed in the
  site's security rules). New ones are served from `https://api.helm.events/storage/v1/...` after the switch.
- Live updates (chat, bell) use `wss://api.helm.events/realtime/v1` after the switch; both addresses are allowed.

## Undo (rollback)
1. App only: tell Claude "switch the API domain back" → `useCustomDomain: false` → deploy. Done; nothing else breaks
   because supabase.co never stopped working.
2. Remove the add-on completely (stops the $10 per month): first do 1., then
   ```
   supabase domains delete --project-ref nqltzgiwznphugcfhmbm
   ```
   then in Supabase → Add-ons turn Custom domain off, and in GoDaddy delete the `_acme-challenge.api` TXT record
   (the `api` CNAME can stay or be deleted). Keep the old Google redirect URI; you may remove the api.helm.events one.
   Note: removing the domain while the switch is ON breaks Google sign-in — always do step 1 first.

## For developers
- Switch: `window.HELM_API_DOMAIN = { useCustomDomain, customUrl }` in `public/config.js`. Only the exact value
  `https://api.helm.events` is accepted; anything else falls back to the supabase.co address.
- `SUPABASE_CONFIG.projectUrl` = the supabase.co address; `SUPABASE_CONFIG.authStorageKey` =
  `sb-nqltzgiwznphugcfhmbm-auth-token`, passed to supabase-js as `storageKey` only when the URL is not *.supabase.co
  (supabase-js would otherwise derive `sb-api-auth-token` and sign everyone out).
- CSP: `node scripts/gen-csp.mjs` adds `https://api.helm.events` / `wss://api.helm.events` next to every production
  project origin (read from `customUrl` in config.js); the staging-site rule never gets it. Test:
  `test/r26-custom-domain.test.mjs`.
- Source: https://supabase.com/docs/guides/platform/custom-domains and
  https://supabase.com/docs/guides/platform/manage-your-usage/custom-domains
