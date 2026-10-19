# Two-step verification (MFA) - owner test, about 10 minutes (r22)

Do this on **staging** first (helm-v01.vercel.app + the staging Supabase project), then on **production**
(www.helm.events) when staging passes. You need your phone with **Google Authenticator** (any TOTP app works:
Microsoft Authenticator, 1Password, Authy).

What Helm does today (all in code, tested by `test/r22-mfa.test.mjs` and `tests/db/r22-mfa-reset-0253.sql`):

- Anyone (password or Google sign-in) can turn two-step on in **Account -> Two-step verification**: QR code + a key
  you can type, then the first 6-digit code.
- After that, every new sign-in asks for the code. Supabase signs in with the password (or Google) at "aal1"; Helm
  keeps every page closed until the code is entered ("aal2"). The **database** enforces it too: a studio member with
  two-step on gets no studio data at aal1 (0043), and Helm HQ refuses an operator who has two-step on at aal1.
- The same browser stays signed in at aal2 until you sign out (no code on every page). There is no "remember this
  device for 30 days" option: a new sign-in always asks for the code.
- Wrong codes: after 5 wrong codes in 15 minutes, code entry is locked for 15 minutes (server-side, every device -
  0050). Supabase's own rate limit is the backstop. The optional MFA hook (0158) makes Supabase itself refuse codes
  while locked - see step 0.4.
- Turning two-step **off** now needs a current code from the app (a signed-in browser alone is not enough).
- **Lost phone:** the person e-mails security@helm.events from their account's address. A Helm HQ operator confirms
  who they are, then uses **HQ -> People -> Reset** (new in 0253). See "Recovering a lost phone" below.

---

## 0. One-time setup (per Supabase project: staging, then production)

1. **Supabase dashboard -> Authentication -> Multi-Factor** (in newer dashboards: *Authentication -> Sign In /
   Providers -> Multi-Factor Authentication*). Under **TOTP (App Authenticator)** make sure it is **Enabled**
   (enrolment and verification both on). Leave *Phone* MFA off. Save.
   (`supabase/config.toml` now has `[auth.mfa.totp] enroll_enabled = true, verify_enabled = true` for local
   parity only - the hosted projects take the dashboard setting. Do not run `supabase config push` from that file.)
2. **SQL editor:** paste `supabase/APPLY-0253.sql` and Run. Every VERIFY row must say `ok = true`.
   It adds the HQ-assisted reset and makes HQ require the code for every call while `hq_require_mfa` is on.
3. **Deploy** the site (store-api.js, auth-ui.js, hq.js, login.html changed).
4. Optional but recommended: **Authentication -> Hooks -> MFA Verification Attempt** -> Postgres ->
   schema `public`, function `hook_mfa_verification_attempt` (from 0158). Enable it. (If your plan does not offer
   this hook, skip it - the app-side lockout still works.)

## 1. Turn it on for your admin account (2 min)

1. Sign in to the studio as your **admin** account (staging test studio).
2. Avatar (top-right) -> **Account settings** -> **Two-step verification** -> **Turn on**.
3. In Google Authenticator: **+** -> **Scan a QR code** -> scan the code on screen
   (or **Enter a setup key** and type the key shown under the QR).
4. Type the 6-digit code -> **Verify & turn on**. You should see "Two-step verification is on" and then
   "On - you enter a code from your authenticator app when you sign in".
   - Try a wrong code first if you like: "That code didn't work. Codes change every 30 seconds..."

## 2. Sign out and in again with the code (2 min)

1. Avatar -> **Sign out**.
2. Sign in with your e-mail + password (or **Continue with Google**). Helm shows **Two-step verification - 6-digit code**.
3. Open any studio link in a new tab before entering the code: it must send you back to the sign-in page (nothing opens).
4. Enter the code from the app -> you land on the dashboard.
5. Optional lockout check: sign out, sign in, enter 5 wrong codes. The button says "Try again in ... s" and even the
   right code is refused until the pause is over (15 minutes; use a test account for this).

## 3. Turn-off needs a code (1 min)

1. Account settings -> Two-step verification -> **Turn off**. Helm asks for a 6-digit code.
2. Enter a wrong code: refused, two-step stays on. Press **Keep it on** (leave it on for the HQ steps below).

## 4. HQ operator: the readiness card shows "on" (2 min)

1. Sign in as your **HQ operator** account (admin@helm.events). If it has no two-step yet, the sign-in page (or
   HQ -> Overview -> **Set up two-step**) takes you through the same QR + code set-up. You are not locked out.
2. Sign out, sign in again: HQ asks for the code before it opens.
3. HQ -> **Overview** -> **HQ two-step readiness**: your line says **two-step on**. The state says
   "Ready - not required yet" once every operator with a login has two-step.

## 5. Require two-step for HQ (2 min)

1. SQL editor: run `supabase/audit/R21-SECURITY-PREFLIGHT.sql` (read-only). Section 1 must show
   `blocking = false` for every operator.
2. Run: `update public.helm_hq_settings set hq_require_mfa = true where id;`
   - If an operator with a login still has no authenticator, the database refuses and names them (0249) - set them
     up first. Nobody can be locked out by this switch.
3. Reload HQ -> Overview: the card state now says **Required**.
4. From now on every HQ call (reads and writes) needs a code-verified session (0253). To turn it off again:
   `update public.helm_hq_settings set hq_require_mfa = false where id;` (never blocked).
5. Studio admins (later, when you decide): tell them first, then set `mfaRequiredForAdmins: true` in
   `public/config.js`, bump config.js and deploy. Admins without two-step see a set-up screen at their next page
   load (with Sign out). They are guided to set it up, not locked out. If set-up itself is switched off in Supabase
   they get a clear message and "Continue for now".

Then repeat steps 0-5 on **production**.

---

## Recovering a lost phone

**A studio user (or Google sign-in user) lost their phone**

1. They e-mail **security@helm.events** from the e-mail address of their Helm account (the sign-in page and the
   Account panel say this).
2. Check it is really them before you do anything: call them on a number you already have (not one in the e-mail), or
   ask their studio admin to confirm. Never reset because of the e-mail alone.
3. Helm HQ -> **People** -> search their e-mail -> the 2-step column says **on** -> **Reset**.
   Confirm, type the reason (for example "phone lost - confirmed by call to studio admin"), then type their
   e-mail again. HQ says "Two-step reset".
4. Tell them: sign in with your password (or Google) as usual, then Account settings -> Two-step verification -> Turn on, and
   scan the new QR code with the new phone. Their Account panel shows when Helm support reset it.
5. If you think the password was stolen too, ask them to change it (Account -> Change password) or send a reset link.

Rules the database enforces on **Reset** (`hq_mfa_reset`, 0253): only an HQ operator who signed in **with** two-step;
never your own account; a reason of 10-500 characters; at most 10 resets per operator per 24 hours. Every reset is in
HQ -> Activity (`hq.mfa.reset`) and in the append-only `public.mfa_resets` log (it cannot be edited or deleted). The
person's old authenticator is marked *unverified* - nothing is deleted; their new set-up replaces it.

**An HQ operator lost their phone**

- Another HQ operator does the Reset above (you cannot reset your own account - no self-bypass).
- If you are the **only** operator, in the Supabase **SQL editor** (owner only), after checking it is really you:

  ```sql
  -- 1) look first: your verified authenticators
  select f.id, f.status, f.created_at from auth.mfa_factors f join auth.users u on u.id = f.user_id
   where lower(u.email) = 'admin@helm.events';
  -- 2) if hq_require_mfa is on, turn it off for a moment (never blocked)
  update public.helm_hq_settings set hq_require_mfa = false where id;
  -- 3) mark them unverified (not deleted), and log it
  update auth.mfa_factors set status = 'unverified', updated_at = now()
   where user_id = (select id from auth.users where lower(email) = 'admin@helm.events') and status::text = 'verified';
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (null, 'owner (SQL editor)', 'hq.mfa.reset', 'auth_user',
            (select id::text from auth.users where lower(email) = 'admin@helm.events'),
            '{"reason":"owner lost phone - SQL editor runbook"}'::jsonb, null, now());
  ```

  Then sign in, set two-step up again (HQ -> Overview -> Set up two-step), and turn `hq_require_mfa` back on
  (step 5).

**Backup codes:** Supabase Auth does not offer backup / recovery codes for TOTP. The safe recovery path is the
HQ-assisted reset above. Tip for every admin: when setting up, also save the setup key in a password manager, or add
the same QR code to a second device - then a lost phone is not a lock-out at all.
