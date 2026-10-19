---
id: two-step
nav: Two-step verification
order: 20
---
# Two-step verification (sign-in code from your phone)

Two-step verification means a stolen password alone can't open your account. After your password (or Google) Helm also asks for a 6-digit code from an authenticator app on your phone. It is optional for every role, and strongly suggested for admins.

> Two-step is **not shown during the free trial**. It appears in Account settings once your studio is on a paid plan. (If you had already turned it on, you still see it so you can turn it off.)

## Turn it on
1. Open your profile menu (your initials, top right - on a phone, **Profile** in the bottom bar) → **Account settings**.
2. Find the **Two-step verification** card. It shows **Off**.
3. **Scan this QR code** with an authenticator app - Google Authenticator, Microsoft Authenticator, Authy or 1Password. If the app asks, choose "time-based".
   - Can't scan? Press **Copy** and type the key into the app instead. On a phone you can tap **Open in authenticator app**.
4. **Enter the 6-digit code** the app shows and press **Verify & turn on**. Codes change every 30 seconds - type the newest one.
5. You see **Two-step verification is on**. From now on Helm asks for a code each time you sign in.

## Signing in with two-step
1. Sign in with your e-mail and password (or Google) as usual.
2. On the **Two-step verification** screen, open your authenticator app and type the 6-digit code for Helm.
3. Press **Verify →**. No page opens until the code is right.

After 5 wrong codes the screen locks for 15 minutes.

## Turn it off
In **Account settings → Two-step verification** press **Turn off two-step**. Helm asks for a current code first, so only you can switch it off.

## Lost your phone?
There are no backup codes. Write to **security@helm.events** from your account's e-mail address. Helm support confirms who you are, then resets your two-step. Account settings then shows **Helm support reset your two-step verification on** (date). Set it up again at your next sign-in.

## When your studio makes it compulsory
If your studio requires two-step for admins, an admin who hasn't set it up sees **Set up two-step verification** at sign-in and can't skip it. Free-trial studios are never forced.

## Who can do what
| Action | Who |
| --- | --- |
| Turn two-step on or off for yourself | Every signed-in user on a paid studio |
| Reset someone's two-step after a lost phone | Helm support (HQ) only - after checking who they are, and every reset is logged |
| Use two-step during the free trial | Not available |
