/* =========================================================================
   Helm Events — runtime configuration.
   With these Supabase credentials set, layouts are stored in Supabase.
   (The anon/public key is safe in client code — Row Level Security protects the data.)
   Leave url/anonKey blank to fall back to the Node backend, then localStorage.

   Schema: run supabase/schema.sql in the Supabase SQL editor (already done).
   ========================================================================= */
// MVP/trial feature switches (one place). integrationsPage=false hides the Integrations page
// (sidebar entry, /integrations + /<studio>/integrations redirect to the dashboard), the
// "Connect WhatsApp" getting-started step and the "WhatsApp & email" onboarding step —
// Helm's own e-mail and WhatsApp are used. Flip to true to bring all of it back.
// Local preview (owner 2026-10-17): the WhatsApp number + e-mail setup is ON on localhost only, still off on live sites.
window.HELM_FEATURES = Object.assign({ integrationsPage: /^(localhost|127\.0\.0\.1)$/.test(location.hostname) }, window.HELM_FEATURES || {});
// manual (owner 2026-10-18, r20 coord; r23 2026-10-19: back on for everyone): ONE flag for the user manual.
// true = every signed-in studio role sees "User manual" (profile menu, Settings Help, search) and /manual shows
// the chapters for their role (manual.js data-areas filter). "admin" = only the studio admin; false = nobody
// (/manual says "coming soon", no storage fetch).
window.HELM_FEATURES = Object.assign({ manual: true }, window.HELM_FEATURES);
window.helmManualFor = function (role) { var f = window.HELM_FEATURES && window.HELM_FEATURES.manual; return f === true || (f === "admin" && String(role || "") === "admin"); };
// payNow (owner 2026-10-19, r24): ONE switch for every "Pay now" button inside the app - the sign-up "How would you
// like to start?" plan cards and the /checkout "Choose a plan" cards. false (now) = no Pay now anywhere: each plan
// offers "Contact sales" (+ "Try free" where a trial is possible), a ?mode=paid link reads as Contact sales, and
// online payment / the UPI + bank details stay hidden. true = Pay now comes back exactly as before (r22).
// (The public pricing pages have no Pay now buttons in R24 - put them back there by hand when this goes true.)
window.HELM_FEATURES = Object.assign({ payNow: false }, window.HELM_FEATURES);
// googleGis (r26): "Continue with Google" runs ON this site (Google's own button, public/google-gis.js), so Google's
// account screen says helm.events instead of the supabase.co project address. ON for helm.events + www.helm.events,
// OFF elsewhere (staging / previews / localhost keep the classic redirect button). Needs, once (owner,
// GOOGLE-SIGNIN-DIRECT-STEPS.md): Google Cloud -> the Web client -> Authorized JavaScript origins = https://www.helm.events
// + https://helm.events, and Supabase -> Auth -> Google -> "Client IDs" lists the client ID below. If Google's script
// can't load, or Supabase refuses the token, the page falls back to the classic redirect button by itself.
// To switch it off: set googleGis to false here (everything goes back to the redirect flow).
window.HELM_FEATURES = Object.assign({ googleGis: /^(www\.)?helm\.events$/.test(((typeof location !== "undefined" && location.hostname) || "").toLowerCase()) }, window.HELM_FEATURES);
// The PUBLIC Google OAuth web client ID (not a secret - it is in every Google sign-in page). Never put the client SECRET here.
// oneTap: also show Google's "One Tap" account chooser on the sign-in page (off).
window.HELM_GOOGLE = Object.assign({ clientId: "326378207877-nkcq44qbfh4qavnv438ec6q5kjc6klib.apps.googleusercontent.com", oneTap: false }, window.HELM_GOOGLE || {});
// r21 (owner fills these in): Helm's OWN bank / UPI details shown on /checkout ("Pay by UPI or bank transfer") while
// online payment is off. Public on purpose (customers pay to them) - put ONLY the receiving details here, never a
// password, PIN or API key. An empty value is not shown; with everything empty the page says our team sends the
// details with the plan confirmation. HQ then confirms the payment with Studios -> "Activate plan".
window.HELM_PAY_MANUAL = Object.assign({
  upiId: "",          // e.g. "helmevents@okaxis"
  payeeName: "",      // the UPI payee / company name, e.g. "Helm Events Pvt Ltd"
  accountName: "",    // bank account holder name
  accountNumber: "",  // bank account number
  ifsc: "",           // IFSC code
  bankName: "",       // bank name
  branch: "",         // branch (optional)
  note: ""            // optional line under the details (default: send us the UTR / reference, same-day activation)
}, window.HELM_PAY_MANUAL || {});
// r21 monitoring: front-end error reports (public/telemetry.js -> Sentry). EMPTY dsn = OFF (nothing loaded, nothing
// sent). R45 (owner 2026-10-27): ON - the DSN of the owner's Sentry project "helm" (free plan), ERRORS ONLY
// (no tracing, no session replay, no profiling). One project for every site; the environment tag below tells
// production and staging apart. Changing the DSN: Sentry -> Settings -> Projects -> helm -> Client Keys (DSN),
//   then run `node scripts/gen-csp.mjs` (it puts the DSN's EXACT ingest host in connect-src) and deploy.
//   The DSN is public by design (it can only SEND events) - safe to commit. Steps: SENTRY-TURNSTILE-STEPS.md.
//   To switch monitoring off again: set dsn to "" and re-run gen-csp.
// Test (staging only): open https://helm-v01.vercel.app/?sentry_test=1 - telemetry.js throws ONE test error per tab
// (Sentry -> Issues, tag environment:staging). Ignored on helm.events, previews and localhost.
// environment: "production" on helm.events, "staging" on helm-v01.vercel.app, "development" on localhost (never sent),
// "preview" anywhere else. release: "helm-web@<this file's asset version>" (the ?v= every page loads config.js with -
// bumped whenever config.js changes). Errors: every one (100%). Tracing: off (0); at most 0.1 = 10% if ever wanted.
// Tokens, e-mails, phone numbers, amounts and every query string in URLs are scrubbed before anything is sent.
window.HELM_TELEMETRY = Object.assign({
  dsn: "https://1dc17f49258bac56dd0eb8e778842d7e@o4512062490738688.ingest.us.sentry.io/4512328815542272",   // Sentry project "helm" (public DSN)
  env: (function (h) {
    if (/^(www\.)?helm\.events$/.test(h)) return "production";
    if (h === "helm-v01.vercel.app") return "staging";
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(h)) return "development";
    return "preview";
  })(((typeof location !== "undefined" && location.hostname) || "").toLowerCase()),
  release: (function () {
    try { var m = /[?&]v=(\d{1,9})/.exec((document.currentScript && document.currentScript.src) || ""); return "helm-web@" + (m ? m[1] : "0"); }
    catch (e) { return "helm-web@0"; }
  })(),
  tracesSampleRate: 0     // errors only, no performance tracing - keep 0 (free plan; telemetry.js caps any value at 0.1)
}, window.HELM_TELEMETRY || {});
window.SUPABASE_CONFIG = {
  url: "https://nqltzgiwznphugcfhmbm.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xbHR6Z2l3em5waHVnY2ZobWJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzOTg5NDYsImV4cCI6MjEwNDk3NDk0Nn0.UWainTYBaCr8dNaugqWkCuLVh2H0TkiG6ZIFH6ZPKIQ",
  table: "layouts",
  // Live channels — flip a flag to true only AFTER that channel's Edge Function
  // is deployed and its secrets are set. false = the app simulates the channel
  // (no external calls), so everything keeps working without it configured.
  liveChannels: {
    sms: false,       // send-otp        → MSG91
    pay: false,       // create-payment-link → Razorpay Payment Links (enable only after deploy+secrets — see docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md)
    whatsapp: false,  // send-whatsapp   → Meta WhatsApp Cloud API   (enable only after deploy+secrets — see docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md)
    email: true       // client-mailer + send-otp e-mail → Resend or SMTP (SMTP_* secrets). false = "Send by email" + e-mail code switched off
  },
  // Bot protection on sign-in / sign-up / password reset (Cloudflare Turnstile).
  // siteKey is the PUBLIC site key. EMPTY = off (sign-in works exactly as before).
  // r26 safe order: put the site key here and deploy FIRST (Supabase ignores the token while its own CAPTCHA
  // is off), THEN turn on Supabase → Authentication → Attack Protection → CAPTCHA (Turnstile, SECRET key)
  // (docs/AUTH-DASHBOARD-SETTINGS.md). The other way round, sign-in fails until this key is live. Never put the secret here.
  // r21: the same key also guards checkout "Contact sales" (captcha-verify edge function + the
  // 0249 database switch) - order of steps: docs/security/OWNER-DASHBOARD-STEPS-R21.md section D.
  // login: invisible unless Cloudflare wants a click; a visible check after 3 wrong passwords in a tab.
  // r26: the same key also shows the check on the public forms - Contact sales (/contact-sales + the home page form),
  // the studio enquiry form (/<studio>/enquiry) and /suggest; captcha-verify gives a signed-out visitor a one-use pass.
  //   >>> TURNSTILE SITE KEY GOES HERE <<<  (public, starts with "0x4AAAA..."; the SECRET key never goes in this file)
  //   Steps + the safe order: SENTRY-TURNSTILE-STEPS.md. Empty = every form works exactly as today.
  captcha: { provider: "turnstile", siteKey: "", login: { appearance: "interaction-only", alwaysAfterFailures: 3 } },
  // Onboarding checkout (0056). allowPaymentBypass shows the clearly-labelled
  // "Skip payment (testing only)" button on /checkout. The SERVER flag
  // helm_billing_settings.allow_trial_bypass is the real gate — set BOTH to false
  // for launch. Online payment there needs liveChannels.pay AND HQ's
  // online_payments_live, plus the create-subscription-checkout edge function.
  // Launch (owner 2026-10-17): OFF on the production hosts (helm.events, www.helm.events);
  // still ON on staging (helm-v01.vercel.app), previews and localhost so testing keeps working.
  onboarding: { allowPaymentBypass: !/^(www\.)?helm\.events$/.test(((typeof location !== 'undefined' && location.hostname) || '').toLowerCase()) },
  auth: {
    // ── THE two-step switch (one place) ─────────────────────────────────────────
    // false (now, owner decision: two-step OPTIONAL while testing) — admins may use
    //   the app without setting up an authenticator; anyone who HAS set one up is
    //   still asked for the code, and wrong codes lock the account's code entry on
    //   the server (5 wrong → 15 min, migration 0050).
    // true (later, for launch) — admins without two-step must set it up first.
    //   Flip together with the HQ database switch:
    //     update public.helm_hq_settings set hq_require_mfa = true where id;   (0047)
    //   r21 (0249): HQ -> Overview -> "HQ two-step readiness" shows who still needs it (operators by name,
    //   studio admins as a count) and the database refuses the HQ switch while an operator would be locked
    //   out. Admins who have not enrolled are ASKED to set it up at their next sign-in (not locked out).
    mfaRequiredForAdmins: false,
    // App-side sign-out on signed-in staff pages (studio app AND Helm HQ):
    //   idleMinutes — sign out after this many minutes with no activity in any tab
    //   warnSeconds — the "Still there?" warning appears this long before that
    //   maxHours    — always sign out this long after sign-in (re-login required)
    // 0 = that limit off. Signing out in one tab signs out every tab.
    session: { idleMinutes: 0, warnSeconds: 120, maxHours: 0 }   // owner 2026-10-16: no app-side session limit (0 = off); Supabase refresh tokens keep users signed in
  }
};

// ---------------------------------------------------------------------------
// STAGING project config lives in public/config.staging.js (public values only).
// It is loaded below ONLY on non-production hosts, and vercel.json 404s it on
// the production hosts, so the staging URL/key never reach production visitors.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ENV SEPARATION (Wave 4 / finding ENV / DEPLOY-02): local development must NOT
// silently use the PRODUCTION Supabase project. Wave 3 found that pages served
// from localhost connected straight to prod. If this page is on localhost and
// the operator has NOT explicitly opted in, we blank the Supabase credentials
// so store-api.js falls back to the local Node backend / localStorage instead
// of reading/mutating production data. Production hostnames are unaffected.
// Deliberate localhost→prod (read-only debugging) requires an explicit opt-in:
//   window.HELM_ALLOW_PROD_FROM_LOCALHOST = true;   // set before this file, OR
//   localStorage.setItem('helm.allowProdFromLocalhost', String(Date.now()));
// The localStorage opt-in is a TIMESTAMP and expires after 8 hours (the legacy
// sticky value '1' is treated as expired).
// See docs/STAGING-SETUP.md for wiring a real isolated staging project.
// ---------------------------------------------------------------------------
var CONFIG_STAGING_V = '1';
(function () {
  var h = '';
  try { h = ((location && location.hostname) || '').toLowerCase(); } catch (e) {}
  // EXPLICIT production allowlist (no broad substring matching). Unknown hosts fail closed.
  var PROD_HOSTS = {
    'www.helm.events': 1, 'helm.events': 1,
    'helm-alpha-nine.vercel.app': 1   // old alias; vercel.json also redirects it to www.helm.events
  };
  // helm-v01.vercel.app is the STAGING site (staging Supabase), NOT production: it is
  // listed in SUPABASE_STAGING.hosts (config.staging.js) and, as a *.vercel.app host,
  // could never fall through to production anyway (step 2b fails closed).
  var PROD_URL = window.SUPABASE_CONFIG.url, PROD_KEY = window.SUPABASE_CONFIG.anonKey;
  var routed = false;
  function route() {
  if (routed) return; routed = true;
  try {
    // Restore the committed prod values (a deferred route blanked them provisionally).
    window.SUPABASE_CONFIG.url = PROD_URL;
    window.SUPABASE_CONFIG.anonKey = PROD_KEY;
    try { delete window.SUPABASE_CONFIG.__localFallback; } catch (e) {}

    // Resolve staging creds from (in priority): committed SUPABASE_STAGING block →
    // window.HELM_STAGING_SUPABASE override → localStorage 'helm.staging'. Returns
    // null when none is configured. (All PUBLIC values — never secrets.)
    // The localStorage override is only honoured for a genuine Supabase project
    // URL (https://<20-char ref>.supabase.co) so a stray/injected value can't
    // point the app at an arbitrary backend.
    var SUPABASE_PROJECT_URL = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/;
    function resolveStaging() {
      var s = (window.SUPABASE_STAGING && window.SUPABASE_STAGING.url) ? window.SUPABASE_STAGING : null;
      if (!s && window.HELM_STAGING_SUPABASE && window.HELM_STAGING_SUPABASE.url) s = window.HELM_STAGING_SUPABASE;
      if (!s) {
        try {
          var j = localStorage.getItem('helm.staging');
          if (j) {
            var p = JSON.parse(j);
            if (p && typeof p.url === 'string' && SUPABASE_PROJECT_URL.test(p.url) && typeof p.anonKey === 'string') s = p;
            else if (p) console.warn('[Helm] Ignoring localStorage helm.staging — url must match https://<project-ref>.supabase.co');
          }
        } catch (e) {}
      }
      return (s && s.url && s.anonKey) ? s : null;
    }
    function useStaging(s) {
      window.SUPABASE_CONFIG.url = s.url;
      window.SUPABASE_CONFIG.anonKey = s.anonKey;
      window.SUPABASE_CONFIG.__staging = true;
      console.info('[Helm] Using the STAGING Supabase project (isolated from production).');
      markStagingEnv();
    }
    // Phase 4 — STAGING VISUAL SAFETY. Reached ONLY from useStaging(), so it can
    // never fire on a production host → production UX is untouched. CSP-safe
    // (style-src allows 'unsafe-inline'); every path is wrapped so it can never
    // break a page, and it is a no-op outside a browser (e.g. the Node routing
    // tests), where `document` is undefined.
    function markStagingEnv() {
      try {
        if (typeof document === 'undefined') return;                 // non-browser (tests) → skip
        if (document.title && document.title.indexOf(' — STAGING') === -1) {
          document.title = document.title + ' — STAGING';            // "… — STAGING" (idempotent)
        }
        var inject = function () {
          try {
            if (!document.body) return;
            // Visible bottom "STAGING" banner removed per request. The env marker
            // stays as an attribute (and the tab title suffix above) so staging is
            // still distinguishable without overlapping the UI (e.g. the chat composer).
            document.documentElement.setAttribute('data-helm-env', 'staging');
            var old = document.getElementById('helm-staging-badge'); if (old) old.remove();
          } catch (e) {}
        };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', inject, { once: true });
        } else { inject(); }
      } catch (e) { /* visual marker must never break the app */ }
    }
    function failClosed(where) {
      window.SUPABASE_CONFIG.url = '';
      window.SUPABASE_CONFIG.anonKey = '';
      window.SUPABASE_CONFIG.__localFallback = true;
      console.error('[Helm] Supabase DISABLED on ' + where + ' — no STAGING project configured, and ' +
        'connecting to PRODUCTION here is not allowed (env separation, fail-closed). ' +
        'Fill window.SUPABASE_STAGING in config.js (public url+anonKey) — see docs/STAGING-SETUP.md.');
    }

    var STAGING_HOSTS = {};
    try {
      ((window.SUPABASE_STAGING && window.SUPABASE_STAGING.hosts) || []).forEach(function (x) {
        if (x) STAGING_HOSTS[String(x).toLowerCase()] = 1;
      });
    } catch (e) {}

    function isLocalLAN(host) {
      return host === 'localhost' || host === '' || host === '0.0.0.0' ||
        host === '::1' || host === '[::1]' ||
        /\.local$/.test(host) || /\.localhost$/.test(host) ||
        /^127\./.test(host) ||                              // 127.0.0.0/8 loopback
        /^10\./.test(host) ||                               // 10.0.0.0/8
        /^192\.168\./.test(host) ||                         // 192.168.0.0/16
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||          // 172.16.0.0/12
        host.indexOf('.') === -1;                           // bare hostname (no dot)
    }

    // 1) EXPLICIT PRODUCTION host → production Supabase (committed config as-is).
    if (PROD_HOSTS[h]) { try { window.HELM_IS_PROD_HOST = true; } catch (e) {} return; }

    // 2) EXPLICIT STAGING host (allow-listed) → staging Supabase, or fail closed.
    //    Never falls back to production, and ignores the localhost prod opt-in.
    if (STAGING_HOSTS[h]) {
      var stg = resolveStaging();
      if (stg) { useStaging(stg); } else { failClosed('the staging host'); }
      return;
    }

    // 2b) VERCEL BRANCH-PREVIEW host → STAGING (never production).
    //     Any *.vercel.app that reached this point is, by construction, NOT one of the
    //     production aliases: PROD_HOSTS is matched first (step 1) and returns early, so
    //     helm-alpha-nine can never fall through to here. Every remaining
    //     *.vercel.app is a branch/preview deploy (e.g. the harden/pre-react-canonical
    //     preview alias), which must resolve to STAGING or FAIL CLOSED — it can NEVER
    //     reach production, and it ignores the localhost→prod opt-in entirely.
    //     This is a deterministic, host-based rule (no build-time env needed): the
    //     committed SUPABASE_STAGING block makes resolveStaging() succeed on preview,
    //     and if staging is blank the host fails closed (blank creds) rather than prod.
    if (/\.vercel\.app$/.test(h)) {
      var pv = resolveStaging();
      if (pv) { useStaging(pv); } else { failClosed('a Vercel branch-preview host'); }
      return;
    }

    // 3) LOCALHOST / LAN handled below.
    var isLocal = isLocalLAN(h);

    // 4) UNKNOWN host (not prod, not staging, not local) → FAIL CLOSED (never prod).
    if (!isLocal) { failClosed('an unrecognised host (' + h + ')'); return; }

    // FAIL-CLOSED BY DEFAULT (Wave 6 ENV P1): local/LAN/.local/loopback must NOT
    // silently connect to the PRODUCTION Supabase project. On localhost we blank
    // the committed prod credentials so store-api falls back to the local Node
    // backend / localStorage, and we print an actionable error. Two escape hatches:
    //
    //  1) Point local dev at a real STAGING project (preferred). Set BEFORE this
    //     file loads:  window.HELM_STAGING_SUPABASE = { url:'…', anonKey:'…' };
    //  2) Deliberately use PRODUCTION from localhost (read-only debugging / when no
    //     staging exists yet). Opt IN explicitly:
    //        window.HELM_ALLOW_PROD_FROM_LOCALHOST = true;   // before this file, OR
    //        localStorage.setItem('helm.allowProdFromLocalhost', String(Date.now()));  // valid 8h
    //
    // The legacy HELM_BLOCK_PROD_FROM_LOCALHOST flag is still honoured (it forces a
    // block) but is now redundant: blocking is the default.
    // 2) LOCALHOST / LAN: prefer STAGING; never silently use production. An explicit
    //    opt-in still allows read-only prod debugging; otherwise fail closed.
    var allowProd = (typeof window !== 'undefined' && window.HELM_ALLOW_PROD_FROM_LOCALHOST === true);
    // localStorage opt-in = the ms timestamp when it was set; valid for 8 hours so
    // it can't silently stay on for weeks. Legacy '1' (or anything stale/invalid)
    // is treated as expired and removed.
    try {
      var PROD_OPT_IN_TTL = 8 * 60 * 60 * 1000;
      var optIn = localStorage.getItem('helm.allowProdFromLocalhost');
      if (optIn != null) {
        var ts = Number(optIn), age = Date.now() - ts;
        if (isFinite(ts) && ts > 1e12 && age >= 0 && age < PROD_OPT_IN_TTL) {
          allowProd = true;
        } else {
          try { localStorage.removeItem('helm.allowProdFromLocalhost'); } catch (e2) {}
          console.info('[Helm] The localhost→production opt-in has expired (it lasts 8 hours). To re-enable: ' +
            "localStorage.setItem('helm.allowProdFromLocalhost', String(Date.now()))");
        }
      }
    } catch (e) {}
    // Legacy explicit block flag can only *reinforce* fail-closed, never open prod.
    var legacyBlock = (typeof window !== 'undefined' && window.HELM_BLOCK_PROD_FROM_LOCALHOST === true);
    try { legacyBlock = legacyBlock || (localStorage.getItem('helm.blockProdFromLocalhost') === '1'); } catch (e) {}
    if (legacyBlock) allowProd = false;

    var stgLocal = resolveStaging();
    if (stgLocal) { useStaging(stgLocal); return; }   // localhost → staging (never prod)

    if (allowProd && window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url) {
      // Explicit, deliberate opt-in to hit PRODUCTION from localhost.
      console.warn('[Helm] Local development is DELIBERATELY using the PRODUCTION Supabase ' +
        'project (HELM_ALLOW_PROD_FROM_LOCALHOST opt-in). Changes here affect LIVE data — be careful.');
      return;
    }

    failClosed('localhost');   // no staging + no opt-in → disabled (never prod)
  } catch (e) { /* never break config load */ }
  }

  // Production host, staging already defined (e.g. tests / pre-set), or no DOM
  // (Node tests) → route now. Otherwise load config.staging.js synchronously
  // (parser-inserted, so it runs before any later <script>) and let it call
  // route(). Until then the credentials are BLANK, so if the staging file fails
  // to load the page stays fail-closed — never production.
  try {
    if (PROD_HOSTS[h] || window.SUPABASE_STAGING || typeof document === 'undefined' ||
        document.readyState !== 'loading') { route(); return; }
    window.SUPABASE_CONFIG.url = '';
    window.SUPABASE_CONFIG.anonKey = '';
    window.SUPABASE_CONFIG.__localFallback = true;
    window.__helmRouteEnv = route;
    document.write('<script src="/config.staging.js?v=' + CONFIG_STAGING_V + '"><\/script>');
  } catch (e) { /* stays blank → fail closed */ }
})();
