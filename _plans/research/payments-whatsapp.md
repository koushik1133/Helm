# Research: studios collecting from THEIR clients + WhatsApp number strategy
_Date: 2026-10-14. Research only, no code changed. Fees/rules are as published at time of writing; confirm on the provider dashboard before committing. Items marked (unverified) were not confirmed from a primary source in this pass._

## TL;DR
1. **Payments (India):** do NOT keep collecting all studios' client money into Helm's single Razorpay account (today's `create-payment-link` uses one global `RAZORPAY_KEY_ID`). That makes Helm a de-facto collector of third-party funds — RBI's Payment Aggregator framework reserves that for licensed PAs, and Razorpay has **discontinued Route for accounts that fail RBI turnover / payer-payee-transparency checks from 1 Jan 2026**.
   **Recommend: "each studio is its own Razorpay merchant; Helm is a Razorpay Technology Partner."** Studio connects its Razorpay account via **Razorpay Partner OAuth** (or, as an MVP, pastes its own API keys); Helm creates Payment Links *on the studio's account*; money settles straight to the studio; Helm earns via its existing subscription billing (Helm's own Razorpay account, already built). This is the HoneyBook/Square/Fresha pattern adapted to Indian regulation.
2. **WhatsApp:** Phase 1 — keep the **Helm shared number** (already built) for utility notifications only. Phase 2 — become a **Meta Tech Provider** and add **Embedded Signup (v4)** so each studio links its *own* number/WABA, billed to the studio's own card. Skip reselling via a BSP unless speed-to-market beats margin.

---

## Part 1 — How multi-tenant SaaS lets businesses get paid by their customers

### The three architectures
| Model | Who is merchant of record | Money flow | KYC owner | Liability (chargebacks/fraud/refunds) | India fit |
|---|---|---|---|---|---|
| **A. Platform-as-aggregator (split/marketplace)** | Platform | Client -> platform account -> split to sub-merchants | Provider KYCs platform; platform/provider KYCs vendors as "linked accounts" | Platform first | Needs PA licence or eligibility under provider; Razorpay Route restricted since 2026 |
| **B. Connected/sub-merchant accounts (Connect-style)** | Each business (on provider) | Client -> business's own provider account; platform can skim an application fee | Provider KYCs each business via hosted/embedded flow | Business (Standard) or platform (Express/Custom) | Good — Razorpay Partners/OAuth, Cashfree Platforms |
| **C. Bring-your-own gateway (BYO keys / OAuth)** | Business | Client -> business's account; platform never touches funds | Business does KYC with provider directly | Business | Simplest + safest for Helm today |

### Top examples

**1. Stripe Connect (Standard / Express / Custom)** — the reference design.
- Implementation: platform creates `account` objects; Standard = business has full Stripe dashboard and connects via OAuth/Account Links; Express = Stripe-hosted onboarding + light dashboard; Custom = fully white-label. Charges are *direct* (on connected account, `application_fee_amount`) or *destination* (on platform, `transfer_data.destination`).
- Fees: standard card pricing per country; Express/Custom add per-active-account + payout fees billed to the platform (Standard: no extra platform fee).
- KYC: Stripe-hosted onboarding collects KYC for each connected account.
- Liability: Standard — connected account bears negative balances; Express/Custom — **platform** is liable.
- India: Stripe India is invite-only for new domestic businesses (unverified as of 2026) — not a viable primary rail for Indian studios.
- Source: https://docs.stripe.com/connect , https://docs.stripe.com/connect/accounts , https://stripe.com/connect/pricing

**2. Shopify Payments** — Shopify is a platform that embeds Stripe (Connect Custom-style) so each shop is a sub-merchant with Shopify-hosted KYC; Shopify bears/passes chargeback liability and earns on rate spread + a penalty fee for using third-party gateways. In India Shopify Payments is **not available**; Indian stores plug in Razorpay/PayU/Cashfree as third-party gateways with their own merchant accounts (= model C).
- Source: https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries , https://help.shopify.com/en/manual/payments/third-party-providers

**3. HoneyBook (closest analogue to Helm: event pros, proposals -> contract -> invoice)** — "HoneyBook Payments" is embedded payments (built on a payments provider, each member is onboarded/KYC'd as a sub-merchant). Client pays the invoice inside the proposal; funds go to the member's bank; HoneyBook takes card/ACH processing fee (about 3% card / 1.5% ACH, can be passed to client) (unverified exact rates). Lesson for Helm: **pay button inside the proposal/approval page** (Helm already does this via `approve.html`).
- Source: https://www.honeybook.com/payments , https://help.honeybook.com/en/articles/2209133-honeybook-payments-faq

**4. Square** — Square is itself the acquirer (payfac); every seller is a sub-merchant with instant self-serve KYC. Third-party SaaS integrate via **Square OAuth**: the app acts on the seller's Square account and may take an `app_fee_money` on each payment. Seller is MoR; liability with seller/Square.
- Source: https://developer.squareup.com/docs/oauth-api/overview , https://developer.squareup.com/docs/payments-api/take-payments-and-collect-fees

**5. Toast** — vertical POS payfac for restaurants: Toast is the payment processor, each restaurant KYC'd as Toast merchant, processing fees bundled with SaaS plan. Pattern: monetise payments, SaaS subsidised. Not replicable for Helm without a PA licence.
- Source: https://pos.toasttab.com/payments

**6. Mindbody / Fresha / Vagaro (beauty/fitness bookings)** — all three run integrated payments where each studio/salon is onboarded as a sub-merchant (Mindbody Payments, Fresha Payments via Stripe/Adyen, Vagaro Merchant Services), deposits/no-show fees collected at booking, platform earns processing margin (Fresha's core model: free software, ~2.19% + fixed per transaction in UK, unverified). Fresha in India historically supported in-app payments only in select markets — local studios fall back to "record payment".
- Sources: https://www.mindbodyonline.com/business/payments , https://www.fresha.com/pricing , https://www.vagaro.com/pro/credit-card-processing

**7. Razorpay Route (India split/marketplace)** — platform's Razorpay account receives payment, `transfers` move funds to **Linked Accounts** (vendor KYC'd by Razorpay, lighter). Fees: payment MDR (~2%) + transfer fee (example 0.25%) + 18% GST. **Since 1 Jan 2026 Razorpay discontinued Route for merchants not meeting RBI minimum turnover or payer-payee transparency criteria; no category exempt.** Fallback suggested by Razorpay is manual settle-then-pay-out — which for Helm means Helm holds client money (bad).
- Sources: https://razorpay.com/docs/payments/route/ , https://razorpay.com/docs/payments/route/transfer-fees-example , https://razorpay.com/docs/payments/route/faqs.md , https://razorpay.com/docs/api/payments/transfers/direct-transfers

**8. Razorpay Partner Program (India Connect-equivalent)** — Helm registers as a Partner. Two sub-models:
- *Technology Partner (OAuth)*: studio already has (or creates) its own Razorpay account and authorises Helm's app; Helm gets an access token scoped to that account and calls normal APIs (payment links, webhooks) on its behalf. Studio is MoR; Razorpay does KYC; settlement to studio's bank; chargebacks on studio. Partner may earn a revenue share from Razorpay.
- *Aggregator Partner (Sub-Merchant Onboarding API + Custom Onboarding SDK)*: Helm creates sub-merchant accounts via `POST /v2/accounts`, uploads stakeholder/KYC docs, can prefill KYC so studio never signs up separately. Higher integration effort, but best UX.
- Sources: https://razorpay.com/docs/partners/ , https://razorpay.com/docs/partners/aggregators/onboarding-api/ , https://razorpay.com/docs/partners/onboarding-api/workflow , https://razorpay.com/docs/partners/platform/onboard-businesses/onboarding-sdk/ , https://razorpay.com/docs/api/partners

**9. Cashfree Easy Split / Platforms** — Cashfree (RBI-authorised PA) offers marketplace split settlement: collect, deduct commission, settle vendors on schedule, vendor balance debited on split refunds; plus a "Platforms" API to onboard merchants. Same regulatory caveat as Route (platform-collected funds); best treated as a second rail.
- Sources: https://www.cashfree.com/marketplace-settlements , https://cashfree.com/docs/api-reference/platforms/overview

### Regulatory note (India)
RBI's Payment Aggregator guidelines (2020, updated) require any entity that *pools and settles funds on behalf of merchants* to be an authorised PA with net-worth requirements and escrow. A SaaS that only *orchestrates* payments on the merchant's own gateway account (model C / OAuth) is not a PA. Source: https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=11822 . Background on PA licensing of Razorpay/Cashfree: https://www.business-standard.com/amp/article/companies/rbi-asks-razorpay-cashfree-to-temporarily-stop-onboarding-of-new-customers-122121600780_1.html , https://ibsintelligence.com/ibsi_prime_news/is-the-rbis-approval-of-a-payment-aggregator-beneficial-for-the-regulated-payments-landscape

### Recommendation for Helm (India) — step-by-step mapped onto existing code
Current state (see `integration-readiness.md`): one Helm Razorpay account (`RAZORPAY_KEY_ID/SECRET`) used by `supabase/functions/create-payment-link`, one webhook secret in `razorpay-webhook`, settlement in `public.razorpay_settle` (migration 0027). INR only (`_shared/money.ts razorpaySupports`).

**Stage 0 (now, zero code): keep `liveChannels.pay=false`.** Studios record offline/UPI/bank payments (already supported). Do not flip pay live on the single Helm account for third-party studios' money.

**Stage 1 (MVP, ~1 sprint): Bring-your-own Razorpay keys per studio.**
1. New additive table `org_payment_accounts(org_id pk, provider 'razorpay', key_id text, key_secret_enc bytea / vault secret id, webhook_secret_enc, status, connected_at)` — secrets stored in **Supabase Vault** (never readable by `authenticated`; only service role via SECURITY DEFINER fetch). RLS: admin of org can see `key_id` + status only.
2. Settings page "Connect Razorpay": admin pastes Key ID/Secret -> new edge fn `payment-account-connect` validates with `GET /v1/payments?count=1` and stores in Vault.
3. `create-payment-link`: replace global env keys with a lookup by `qc.org_id` (service role RPC `org_razorpay_creds(org_id)`); 503 "studio has not connected online payments" if absent. Keep everything else (payment_link_begin lock, expiry, cancel superseded, INR gate).
4. `razorpay-webhook`: per-studio webhook URL `.../razorpay-webhook?org=<uuid>`; verify HMAC with **that org's** webhook secret; `razorpay_settle` additionally asserts `quote.org_id = org` (cross-tenant guard). Studio adds the webhook in its own Razorpay dashboard (we show the URL + generated secret).
5. Receipts already use studio name/business_email — unchanged.

**Stage 2 (scale): Razorpay Partner OAuth (Technology Partner).**
1. Enrol Helm in Razorpay Partner Program; create an OAuth application (client_id/secret, redirect `https://www.helm.events/settings/payments/callback`).
2. "Connect with Razorpay" button -> Razorpay auth -> callback edge fn exchanges code for access/refresh tokens -> stored in Vault against `org_payment_accounts` (`auth_kind='oauth'`, `rzp_account_id`).
3. `create-payment-link` uses `Authorization: Bearer <access_token>`; refresh on 401.
4. Webhooks: one **Partner-level webhook** to `razorpay-webhook`, routed by `account_id` in payload -> org (no per-studio secrets).
5. Optional: Sub-merchant Onboarding API + Custom Onboarding SDK so studios without Razorpay can sign up inside Helm with prefilled KYC.

**Do not**: use Route/Easy Split to take a commission on client payments unless Helm itself meets RBI eligibility; monetise via the subscription (already built: `create-subscription-checkout`, `razorpay-subscription-webhook`, Helm's own account — this one IS correct to keep on Helm's account).

**International (UAE/US studios):** Stripe Connect Standard via OAuth is the equivalent of Stage 2 for non-India orgs; keep "record bank transfer" until then.

---

## Part 2 — WhatsApp: Helm number vs studio's own number

### Options
| Option | How | Who pays Meta | Sender shown to client | Effort | Risk |
|---|---|---|---|---|---|
| **A. Helm shared number** (built) | Helm's WABA + system-user token in Supabase secrets | Helm (re-bill in plan) | "Helm" (verified name) | Done | One quality rating for all studios; one bad studio can throttle everyone; clients see Helm not studio |
| **B. Tech Provider + Embedded Signup** | Helm's Meta app becomes Tech Provider; studio clicks "Connect WhatsApp", Embedded Signup creates/links the studio's WABA + number and grants Helm's app access | Studio (adds card to its WABA) | Studio's own brand/number | Medium (Meta App Review + Business Verification) | Per-studio quality isolation; best UX |
| **C. Via BSP (Interakt, AiSensy, Wati, Gupshup)** | Studio or Helm subscribes to BSP; Helm calls BSP API | Studio/Helm via BSP (markup) | Studio | Low per studio but per-vendor API | Markups, vendor lock-in |

### Meta Tech Provider + Embedded Signup (recommended Phase 2)
- Tech Provider can independently provide messaging services to businesses it onboards; Embedded Signup gathers business info, creates WABA/phone assets and grants the app access. After signup the platform must subscribe webhooks and the business must **add a payment method** before sending.
- **Embedded Signup v2 is deprecated 15 Oct 2026 — build on v4.**
- Steps: Meta Business Verification of Helm -> create Meta app (Business type) with WhatsApp product -> App Review for `whatsapp_business_management` + `whatsapp_business_messaging` -> Tech Provider enrolment -> configure Embedded Signup (Facebook Login for Business config id) -> frontend JS SDK launches popup -> backend exchanges code for business token, gets `waba_id` + `phone_number_id` -> `POST /{waba_id}/subscribed_apps` -> register number (`/{phone_id}/register` with PIN) -> submit studio's templates via `/{waba_id}/message_templates`.
- Sources: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/ , https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider , https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers , https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog/

### Costs (India)
- Meta charges **per delivered template message** by category (marketing / utility / authentication); service (free-form) replies inside the 24h window are free, and utility templates sent inside an open window are free. India marketing rate increased 1 Jan 2026. Third-party estimates: marketing about Rs 0.78-0.88, utility about Rs 0.11-0.16, authentication similar to utility — **sources conflict; use Meta's rate card**. Volume tiers apply to utility/auth.
- BSPs: platform fee + markup (flat monthly from ~Rs 999-2,500 for Interakt/AiSensy entry tiers, Wati higher; some pass Meta rates at cost, others mark up 30-60%) (unverified exact current prices).
- Sources: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing , https://baat.ai/blog/whatsapp-api-pricing-india , https://hyperleap.ai/whatsapp-pricing-calculator-india , https://www.interakt.shop/pricing , https://www.aisensy.com/pricing , https://www.wati.io/pricing , https://www.gupshup.io/pricing

### Templates Helm needs (category)
| Template | Category | Params | Used by |
|---|---|---|---|
| `event_update` | utility | text | send-whatsapp |
| `payment_reminder` | utility | client, amount, link | send-whatsapp, comms-dispatch |
| `event_reminder` | utility | event, date | send-whatsapp |
| `crew_assignment` | utility | name, event, date | send-whatsapp |
| `phone_verification` | **authentication** (OTP, copy-code button) | code | send-phone-code |
| `COMMS_WHATSAPP_TEMPLATE` (one body param) | utility | text | comms-dispatch |
| `PKG_WHATSAPP_TEMPLATE` (one body param) | utility | text | pkg-client-notify |
Note: generic "one free-text param" templates risk rejection/recategorisation as marketing; prefer specific wording.

### Recommendation
1. **Now:** go live on Option A (Helm number) for utility + auth templates only (code built, fail-closed). Display name "Helm Events"; message body always names the studio.
2. **Next:** Option B (Tech Provider + Embedded Signup v4). Code changes: additive table `org_whatsapp_accounts(org_id, waba_id, phone_number_id, token vault id, status, quality)`; senders (`send-whatsapp`, `comms-dispatch`, `pkg-client-notify`, `send-phone-code`) resolve `phone_id/token` per org, falling back to Helm number; new edge fns `wa-embedded-signup-callback` and `wa-webhook` (status/quality/template events, verify token + `X-Hub-Signature-256`). Keep `send-phone-code` on the Helm number (member verification is a Helm concern).
3. **Use a BSP only** if Meta App Review blocks; Gupshup/Interakt both offer partner/ISV APIs, but you lose margin and add a dependency.
