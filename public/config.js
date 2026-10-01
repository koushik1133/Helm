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
  }
};

// ---------------------------------------------------------------------------
// STAGING project (PUBLIC values only — same posture as the prod anon key above,
// which is public-by-design and RLS-protected). The staging anon/publishable key
// and URL are safe to commit. NEVER put the elevated service-role key, DB password, OAuth
// client secret, or any provider secret here — those live only in Supabase/Vercel
// dashboards. Leave BLANK until the staging project is created; blank = "no
// staging configured", which makes staging hosts and localhost fail closed rather
// than ever touching production.
// ---------------------------------------------------------------------------
window.SUPABASE_STAGING = {
  url: "https://xizehqgeyjcfpzrdymly.supabase.co",   // Helm-staging project (isolated from prod)
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhpemVocWdleWpjZnB6cmR5bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxOTAyNTMsImV4cCI6MjEwNTc2NjI1M30.KvL6N-N7iIY7GzsxglWJRmP3JVZuXrHDeqQX1GWaZFo",  // staging ANON/publishable key (public-by-design, RLS-protected — never the elevated key)
  hosts: []       // EXACT staging frontend hostname(s) — add the Vercel staging host at deploy time, e.g. ["helm-staging.vercel.app"]
};

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
(function () {
  try {
    var h = ((location && location.hostname) || '').toLowerCase();

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
    }
    function failClosed(where) {
      window.SUPABASE_CONFIG.url = '';
      window.SUPABASE_CONFIG.anonKey = '';
      window.SUPABASE_CONFIG.__localFallback = true;
      console.error('[Helm] Supabase DISABLED on ' + where + ' — no STAGING project configured, and ' +
        'connecting to PRODUCTION here is not allowed (env separation, fail-closed). ' +
        'Fill window.SUPABASE_STAGING in config.js (public url+anonKey) — see docs/STAGING-SETUP.md.');
    }

    // EXPLICIT ALLOWLISTS (no broad substring matching). Unknown hosts fail closed.
    var PROD_HOSTS = {
      'www.helm.events': 1, 'helm.events': 1,
      'helm-v01.vercel.app': 1, 'helm-alpha-nine.vercel.app': 1
    };
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
    if (PROD_HOSTS[h]) return;

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
})();
