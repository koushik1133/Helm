# Edge Function secrets inventory — STAGING

Target project: **helm-staging** (`xizehqgeyjcfpzrdymly`). **Never** set these on prod
(`nqltzgiwznphugcfhmbm`) from this workflow.

Set with `supabase secrets set --project-ref xizehqgeyjcfpzrdymly NAME=value` (the
`deploy-edge.sh` helper does this from env without printing values). Read from the
function source `Deno.env.get(...)` calls — this list is derived directly from them.

> **STAGING RULES**
> - Razorpay: **test-mode keys only** (`rzp_test_...` key id + its test secret, and a
>   webhook secret from a **test-mode** webhook). Never live keys on staging.
> - OTP (MSG91): prefer a **mock / no-op provider**. If `MSG91_AUTHKEY` is left
>   **unset**, `send-otp` still stores the hashed OTP and returns `{sent:true, live:false}`
>   (status `simulated`) — no real SMS. That is the recommended staging posture.
> - Email (Resend): leave `RESEND_API_KEY` **unset** on staging → receipts are recorded
>   as `simulated`, no mail sent.
> - WhatsApp (Meta): use a **test number / sandbox token**; do not point at a live
>   business number.

## Platform-injected (do NOT set manually)
These are provided automatically by Supabase to every function:
| Name | Notes |
|---|---|
| `SUPABASE_URL` | injected |
| `SUPABASE_SERVICE_ROLE_KEY` | injected |
| `SUPABASE_ANON_KEY` | injected (not used by these four) |

## send-otp
| Secret | Required? | Mode | Purpose |
|---|---|---|---|
| `MSG91_AUTHKEY` | optional | **mock**: leave unset on staging | MSG91 auth key; unset ⇒ OTP simulated, no SMS |
| `MSG91_SENDER` | with authkey | test | 6-char DLT sender id |
| `MSG91_OTP_TEMPLATE_ID` | with authkey | test | DLT template id containing `##OTP##` |

Recommended staging: all three **unset** (mock OTP provider).

## send-whatsapp
| Secret | Required? | Mode | Purpose |
|---|---|---|---|
| `WHATSAPP_TOKEN` | **required** | test/sandbox | Meta system-user access token (function returns 500 if unset) |
| `WHATSAPP_PHONE_ID` | **required** | test/sandbox | WhatsApp Business phone number ID |
| `WHATSAPP_API_VERSION` | optional | — | Graph API version (defaults `v21.0`) |
| `ALLOWED_ORIGINS` | optional | staging | CORS allowlist override (replaces defaults); set to the staging front-end origin |
| `ALLOW_LOCALHOST` | optional | staging | `1` to also allow localhost origins for CORS |

## create-payment-link
| Secret | Required? | Mode | Purpose |
|---|---|---|---|
| `RAZORPAY_KEY_ID` | **required** | **test** `rzp_test_...` | Razorpay key id |
| `RAZORPAY_KEY_SECRET` | **required** | **test** | Razorpay key secret |
| `APP_URL` | optional | staging | base URL for the payment `callback_url` (approve.html) |
| `ALLOWED_ORIGINS` | optional | staging | CORS allowlist override |
| `ALLOW_LOCALHOST` | optional | staging | `1` to allow localhost CORS |

## razorpay-webhook
Server-to-server (no CORS).
| Secret | Required? | Mode | Purpose |
|---|---|---|---|
| `RAZORPAY_WEBHOOK_SECRET` | **required** | **test** | HMAC-SHA256 secret; must match the test-mode webhook in the Razorpay dashboard |
| `RESEND_API_KEY` | optional | **mock**: leave unset | Resend key; unset ⇒ receipts simulated, no email |
| `RESEND_FROM` | with resend | test | From header (e.g. `Helm <events@domain>`) |
| `MANAGER_EMAIL` | optional | test | studio copy recipient |
| `MANAGER_PHONE` | optional | test | studio SMS recipient |
| `MSG91_AUTHKEY` | optional | mock | SMS receipt (unset ⇒ none) |
| `MSG91_SENDER` | with authkey | test | SMS sender id |
| `MSG91_SMS_TEMPLATE_ID` | with authkey | test | SMS receipt template |

## Recommended minimal staging secret set
To exercise the full payment + whatsapp paths with no real external effects:

- `create-payment-link`: `RAZORPAY_KEY_ID` (`rzp_test_...`), `RAZORPAY_KEY_SECRET`, `APP_URL`
- `razorpay-webhook`: `RAZORPAY_WEBHOOK_SECRET` (test webhook) — leave Resend/MSG91 unset
- `send-whatsapp`: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` (sandbox) — or skip this function
- `send-otp`: leave all MSG91 unset (mock)
