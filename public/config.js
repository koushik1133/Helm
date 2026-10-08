/* =========================================================================
   Helm Events — runtime configuration.
   With these Supabase credentials set, layouts are stored in Supabase.
   (The anon/public key is safe in client code — Row Level Security protects the data.)
   Leave url/anonKey blank to fall back to the Node backend, then localStorage.

   Schema: run supabase/schema.sql in the Supabase SQL editor (already done).
   ========================================================================= */
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
    whatsapp: false   // send-whatsapp   → Meta WhatsApp Cloud API   (enable only after deploy+secrets — see docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md)
  },
  // Bot protection on sign-in / sign-up / password reset (Cloudflare Turnstile).
  // siteKey is the PUBLIC site key. EMPTY = off (sign-in works exactly as before).
  // Turn on only AFTER Supabase → Authentication → Bot protection is enabled with
  // the Turnstile SECRET key (docs/AUTH-DASHBOARD-SETTINGS.md) — never put the secret here.
  captcha: { provider: "turnstile", siteKey: "" },
  // Onboarding checkout (0056). allowPaymentBypass shows the clearly-labelled
  // "Skip payment (testing only)" button on /checkout. The SERVER flag
  // helm_billing_settings.allow_trial_bypass is the real gate — set BOTH to false
  // for launch. Online payment there needs liveChannels.pay AND HQ's
  // online_payments_live, plus the create-subscription-checkout edge function.
  onboarding: { allowPaymentBypass: true },
  auth: {
    // ── THE two-step switch (one place) ─────────────────────────────────────────
    // false (now, owner decision: two-step OPTIONAL while testing) — admins may use
    //   the app without setting up an authenticator; anyone who HAS set one up is
    //   still asked for the code, and wrong codes lock the account's code entry on
    //   the server (5 wrong → 15 min, migration 0050).
    // true (later, for launch) — admins without two-step must set it up first.
    //   Flip together with the HQ database switch:
    //     update public.helm_hq_settings set hq_require_mfa = true where id;   (0047)
    mfaRequiredForAdmins: false,
    // App-side sign-out on signed-in staff pages (studio app AND Helm HQ):
    //   idleMinutes — sign out after this many minutes with no activity in any tab
    //   warnSeconds — the "Still there?" warning appears this long before that
    //   maxHours    — always sign out this long after sign-in (re-login required)
    // 0 = that limit off. Signing out in one tab signs out every tab.
    session: { idleMinutes: 60, warnSeconds: 120, maxHours: 12 }
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
    'helm-v01.vercel.app': 1, 'helm-alpha-nine.vercel.app': 1
  };
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
    //     helm-v01 / helm-alpha-nine can never fall through to here. Every remaining
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
