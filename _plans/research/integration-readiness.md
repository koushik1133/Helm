# Integration readiness audit — WhatsApp (Meta Cloud API) + Razorpay
_Date: 2026-10-14. Read-only audit of the repo (no code changed). Companion: `payments-whatsapp.md`._

## 1. What is built
### Razorpay
| Piece | File | State |
|---|---|---|
| Client payment link for an approved quote | `supabase/functions/create-payment-link/index.ts` | Built, hardened: per-quote lock (`payment_link_begin`, 0027), reuse/expiry, cancels superseded links, token-free callback, INR-only gate (0092), rate limits. **Uses ONE global Helm account** (`RAZORPAY_KEY_ID/SECRET`). |
| Webhook settlement | `supabase/functions/razorpay-webhook/index.ts` + `public.razorpay_settle` (0027) | Built: HMAC-SHA256 timing-safe verify, single-transaction settle, unmatched money -> `payment_reconciliation`, studio receipt email. Handles only `payment_link.paid`, `payment.captured`; **no refund / failed / expired handling**. |
| Helm subscription (studio -> Helm) | `create-subscription-checkout`, `razorpay-subscription-webhook`, `billing-reminder` (0045, 0056) | Built, dormant behind `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED` / `HELM_BILLING_REMINDERS_ENABLED`. Correctly uses Helm's own account. |
| Package/booklet payments | migrations 0069, 0070, 0099, 0110 | Built on the same settle path. |
| Client toggles | `public/config.js liveChannels.pay=false`; DB `app_config.channels.pay_live=false` | Simulation (sim-pay.html) until both flipped. CI guard `check-deferred-integrations` fails if flipped without updating it. |
| Tests | `tests/edge/create-payment-link.test.ts`, `razorpay-webhook.test.ts`, `create-subscription-checkout.test.ts`, `billing-extras.test.ts`, `tests/staging/payment-redteam.mjs` | Present. |

### WhatsApp
| Piece | File | State |
|---|---|---|
| Ad-hoc template send from app | `supabase/functions/send-whatsapp/index.ts` | Built: JWT required, RLS-authorised via `whatsapp_authorize` (studio, quotes-edit, number belongs to event, 100/studio/hr), template allowlist, free text only if `WHATSAPP_ALLOW_TEXT=1`, logged to `notifications`. `{ping:true}` credential check. |
| Member phone verification OTP | `send-phone-code` (0055) | Built, dormant until `liveChannels.whatsapp=true`. Needs AUTHENTICATION template. |
| Automated reminders / follow-ups / bell forwards | `comms-dispatch` (0078, pg_cron `helm_comms_tick` every 15 min) | Built, dormant unless `HELM_COMMS_ENABLED=true`; cron-secret auth. |
| Package flow notifications | `pkg-client-notify` (0069) | Built, dormant unless `HELM_PKG_NOTIFY_ENABLED=true`. |
| **Inbound webhook (delivery status, replies, opt-out, template status, quality)** | — | **NOT BUILT.** |
| **Per-studio number / Embedded Signup** | — | **NOT BUILT** (single `WHATSAPP_PHONE_ID`). |

## 2. Gaps before go-live (engineering)
1. **[Blocker — policy] Payment money flow.** One Helm Razorpay account collects every studio's client money -> Helm settles on others' behalf (RBI PA territory; Razorpay may also refuse at KYC since the business description won't match). Fix = per-studio accounts (BYO keys then Partner OAuth) — see `payments-whatsapp.md` Part 1 Stage 1/2. Until then, only safe live use is a single studio owned by the Helm entity itself.
2. Razorpay webhook: add `payment_link.cancelled/expired`, `payment.failed`, `refund.processed` handling; store Razorpay `x-razorpay-event-id` for idempotency (check if `razorpay_settle` dedupes by payment id — it settles idempotently per payment, but event-level dedupe/replay window `RAZORPAY_EVENT_MAX_AGE_SEC` exists only on the subscription webhook).
3. WhatsApp inbound webhook (`wa-webhook`): `hub.verify_token` GET handshake + `X-Hub-Signature-256` HMAC (app secret) on POST; record delivered/read/failed; honour "STOP"/opt-out into notification prefs; template status + phone quality events.
4. Opt-in record for clients (Meta policy requires opt-in before business-initiated messages); approval page consent text could include WhatsApp opt-in.
5. Template names consistency: `COMMS_WHATSAPP_TEMPLATE` / `PKG_WHATSAPP_TEMPLATE` are one-free-text-param templates — likely to be rejected or reclassified as marketing; design specific utility templates.
6. Graph API version default `v21.0` — check it is still supported at go-live; set `WHATSAPP_API_VERSION` explicitly.
7. Meta Embedded Signup v2 deprecated 15 Oct 2026 — any future per-studio onboarding must use v4.

## 3. Owner checklist (in order). Nothing here is done by Claude.
### A. WhatsApp — Helm shared number (Phase 1)
- [ ] Meta Business Manager: complete **Business Verification** for the Helm legal entity.
- [ ] developers.facebook.com -> create **Business** app -> add WhatsApp product.
- [ ] Add a dedicated phone number (not on any WhatsApp app), set display name "Helm Events" (display-name review).
- [ ] Create **System User** (admin) -> assign the app + WABA -> generate **permanent token** with `whatsapp_business_messaging`, `whatsapp_business_management`.
- [ ] Add payment method on the WABA (Meta bills per template message).
- [ ] Submit templates in WhatsApp Manager: `event_update`, `payment_reminder`, `event_reminder`, `crew_assignment` (utility), `phone_verification` (authentication, copy-code), plus the comms/pkg templates; wait for APPROVED.
- [ ] `supabase secrets set WHATSAPP_TOKEN=… WHATSAPP_PHONE_ID=… WHATSAPP_API_VERSION=v2x.0 WHATSAPP_TEMPLATES="event_update,payment_reminder,event_reminder,crew_assignment" WHATSAPP_VERIFY_TEMPLATE=phone_verification WHATSAPP_VERIFY_LANG=en_US COMMS_WHATSAPP_TEMPLATE=… PKG_WHATSAPP_TEMPLATE=…` (STAGING project first).
- [ ] `supabase functions deploy send-whatsapp send-phone-code`; `comms-dispatch` and `pkg-client-notify` with `--no-verify-jwt` + `HELM_COMMS_SECRET` / `HELM_PKG_NOTIFY_SECRET`.
- [ ] Test: `{ping:true}` returns verified_name/quality; send one template to your own number.
- [ ] (After `wa-webhook` is built) Meta app -> WhatsApp -> Configuration: callback URL `…/functions/v1/wa-webhook`, verify token, subscribe `messages`, `message_template_status_update`, `phone_number_quality_update`.
- [ ] Flip `config.js liveChannels.whatsapp=true` + update `check-deferred-integrations` in the same change; then `HELM_COMMS_ENABLED=true`, `HELM_PKG_NOTIFY_ENABLED=true`.

### B. Razorpay — client payments
- [ ] **Decide the money model first** (recommended: per-studio accounts; do not go live on the single Helm account for third-party studios).
- [ ] Helm's own Razorpay account: complete KYC (business type = SaaS), enable Payment Links.
- [ ] Test mode: `supabase secrets set RAZORPAY_KEY_ID=rzp_test_… RAZORPAY_KEY_SECRET=… RAZORPAY_WEBHOOK_SECRET=… APP_URL=https://www.helm.events` (staging).
- [ ] Deploy `create-payment-link`, `razorpay-webhook --no-verify-jwt`.
- [ ] Razorpay Dashboard -> Webhooks -> `https://<project>.supabase.co/functions/v1/razorpay-webhook`, events `payment_link.paid`, `payment.captured` (+ refund/failed once handled), secret = `RAZORPAY_WEBHOOK_SECRET`.
- [ ] Run `tests/staging/payment-redteam.mjs` + a real test-mode payment end to end.
- [ ] Flip `liveChannels.pay=true` AND `update public.app_config set value = value || '{"pay_live":true}' where key='channels'` (merge — do not overwrite other channel flags), update CI guard.
- [ ] For Stage 2: enrol in **Razorpay Partner Program**, create OAuth app, get client_id/secret, set redirect URL.

### C. Razorpay — Helm subscription (studio -> Helm)
- [ ] Apply 0045/0056 (check already applied), create Razorpay Plans whose amounts equal server totals.
- [ ] Secrets `HELM_BILLING_CRON_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`; deploy `billing-reminder`, `razorpay-subscription-webhook`, `create-subscription-checkout`.
- [ ] Dashboard webhook `subscription.charged` -> `…/razorpay-subscription-webhook`.
- [ ] Schedule billing-reminder cron; flip `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED=true`, `HELM_BILLING_REMINDERS_ENABLED=true`; set `config.onboarding.allowPaymentBypass=false` and `helm_billing_settings.allow_trial_bypass=false` at launch.

## 4. Sources
- Repo: `supabase/functions/README.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/DEFERRED-INTEGRATIONS.md`.
- Razorpay Payment Links: https://razorpay.com/docs/payments/payment-links/ ; Webhooks/signature: https://razorpay.com/docs/webhooks/validate-test/ ; Route 2026 eligibility: https://razorpay.com/docs/payments/route/faqs.md ; Partners: https://razorpay.com/docs/partners/aggregators/onboarding-api/
- Meta Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started ; Webhooks: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks ; Templates: https://developers.facebook.com/docs/whatsapp/message-templates ; Pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing ; Embedded Signup v2 deprecation: https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog/

## 5. Delta 2026-10-15 — readiness code added (DORMANT, local only, nothing deployed)
What now exists in the repo:
- `supabase/migrations/0117_integration_accounts.sql` (+ `APPLY-0117.sql`, `VERIFY-0117.sql`, MANIFEST line): additive tables `org_payment_accounts`, `org_whatsapp_accounts` (non-secret fields only; secrets as **Supabase Vault ids**, those columns not granted to `authenticated`), `integration_webhook_events` (unique per provider event id), `whatsapp_opt_outs`. RLS: studio admin reads own studio only. Admin RPCs `save_org_payment_account`, `save_org_whatsapp_account`, `set_org_integration_status`, `my_integration_accounts`; service-role RPCs `org_razorpay_creds`, `org_whatsapp_creds`, `mark_org_integration`, `razorpay_settle_for_org` (cross-tenant guard), `razorpay_record_event`, `wa_record_event`, `wa_set_opt_out`. No DROP/DELETE; quotes never modified.
- `create-payment-link`: uses the quote's studio's own keys when its account is `connected`; otherwise the global `RAZORPAY_KEY_*` exactly as before. `RAZORPAY_REQUIRE_STUDIO_ACCOUNT=1` disables the global fallback.
- `razorpay-webhook`: `?org=<studio uuid>` URLs verify with that studio's webhook secret and may only settle that studio's quotes; records `payment.failed`, `payment_link.cancelled`, `payment_link.expired`, `refund.processed` idempotently (`x-razorpay-event-id`). Refunds are recorded only — reconcile by hand.
- New `supabase/functions/wa-webhook`: 404 until `WHATSAPP_WEBHOOK_VERIFY_TOKEN` + `WHATSAPP_APP_SECRET` are set; GET verify handshake, POST `X-Hub-Signature-256`; records delivery statuses, STOP/START opt-outs, template status + quality events. Message text is never stored.
- `public/integrations-settings.js` + `.css`: "Connect Razorpay / Connect WhatsApp" card (not yet included in any page).
- Tests: `tests/edge/integration-accounts.test.ts` (deno, 18 cases) and `test/integration-readiness.test.mjs` (node, 15 checks).

### Owner checklist — new items (in order). Nothing here is done by Claude.
- [ ] Staging: Database -> Extensions -> confirm **Vault** (`supabase_vault`) is enabled (VERIFY-0117 last row). Without it the save buttons say "secure key storage is not switched on" and everything stays on env keys.
- [ ] Staging: paste `APPLY-0117.sql`, then `VERIFY-0117.sql` (all rows true). Prod later, same order.
- [ ] Wire the card: include `integrations-settings.css` + `integrations-settings.js` in `control.html`, expose `BPStore.integrations` in `store-api.js`, then call `HelmIntegrationsSettings.mount(<container>)` (lead/shell owner).
- [ ] Deploy `wa-webhook --no-verify-jwt`; `supabase secrets set WHATSAPP_WEBHOOK_VERIFY_TOKEN=<random> WHATSAPP_APP_SECRET=<Meta app secret>`; Meta app -> WhatsApp -> Configuration: callback `https://<project>.supabase.co/functions/v1/wa-webhook`, same verify token, subscribe `messages`, `message_template_status_update`, `phone_number_quality_update`.
- [ ] Redeploy `create-payment-link` + `razorpay-webhook`; in the Razorpay dashboard add events `payment.failed`, `payment_link.cancelled`, `payment_link.expired`, `refund.processed` to the existing webhook.
- [ ] Per studio (after the money-model decision): studio admin saves keys -> Helm validates them in test mode -> `select public.mark_org_integration('<org>', 'razorpay', 'connected');` (service role / SQL editor) -> studio adds webhook `…/razorpay-webhook?org=<org uuid>` with the secret they saved. Once all studios are on their own accounts: `RAZORPAY_REQUIRE_STUDIO_ACCOUNT=1`.
- [ ] Not yet built (next step): senders (`send-whatsapp`, `comms-dispatch`, `pkg-client-notify`) using `org_whatsapp_creds` + skipping numbers in `whatsapp_opt_outs`; Razorpay Partner OAuth (Stage 2); Embedded Signup v4.
