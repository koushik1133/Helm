# Helm operations runbook (OBS-01)

**Status:** telemetry is **code-ready, NOT live**. `public/telemetry.js` captures
global errors/rejections and is a no-op until a DSN is configured. Monitoring is
not "on" until an operator completes the steps below.

## Enable error reporting
1. Create a browser error-reporting project (e.g. Sentry) — obtain a DSN.
2. Serve, before `telemetry.js`:
   ```html
   <script>window.HELM_TELEMETRY = { dsn: 'https://…', env: 'production', release: '2026-09-24' };</script>
   <script src="telemetry.js?v=1"></script>
   ```
   Do **not** commit the DSN into `config.js`/repo if it is secret; inject per-env.
3. `telemetry.js` redacts JWTs, access tokens, OTP codes, emails, and phone
   numbers before sending, and only ever sends the URL **path** (never query).

## What to alert on
- Client error rate spike (JS errors / unhandled rejections per session).
- Supabase 4xx/5xx rate (auth failures, RLS denials, function errors).
- OTP failures / `request_otp` returning `delivery: 'unavailable'` in production
  (means no SMS provider is configured — the approval flow is down, not bypassed).
- Payment-record anomalies: duplicate receipt attempts (unique_violation), or
  `record_payment` idempotent-replay counts rising.
- Auth: sustained login failures (possible credential stuffing) — Supabase dashboard.

## 2 AM incident checklist
1. Check the error reporter dashboard for the spike signature + affected route.
2. Check Supabase status + DB health (connections, slow queries).
3. Confirm `liveChannels` are still `false` for Razorpay/WhatsApp (must be — deferred).
4. Confirm no unexpected anon activity on `layouts`/RPCs (RLS should deny; see phase89).
5. Roll back the last deploy if a release correlates (Vercel deployment history).
6. Capture a correlation note (time, route, error, tenant if known — no PII in the ticket).

## Known operational gaps (require setup, not code)
- No uptime monitor / alert routing yet — add an external monitor on the deployed URL.
- No structured server logs (static site) — rely on the browser error reporter + Supabase logs.
- No staging environment yet — see `docs/STAGING-SETUP.md`.
