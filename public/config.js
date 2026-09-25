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
// ENV SEPARATION (Wave 4 / finding ENV / DEPLOY-02): local development must NOT
// silently use the PRODUCTION Supabase project. Wave 3 found that pages served
// from localhost connected straight to prod. If this page is on localhost and
// the operator has NOT explicitly opted in, we blank the Supabase credentials
// so store-api.js falls back to the local Node backend / localStorage instead
// of reading/mutating production data. Production hostnames are unaffected.
// Deliberate localhost→prod (read-only debugging) requires an explicit opt-in:
//   window.HELM_ALLOW_PROD_FROM_LOCALHOST = true;   // set before this file, OR
//   localStorage.setItem('helm.allowProdFromLocalhost','1');
// See docs/STAGING-SETUP.md for wiring a real isolated staging project.
// ---------------------------------------------------------------------------
(function () {
  try {
    var h = ((location && location.hostname) || '').toLowerCase();
    // Treat all loopback, LAN/RFC1918 and bare/.local hostnames as NON-production.
    var isLocal =
      h === 'localhost' || h === '' || h === '0.0.0.0' ||
      h === '::1' || h === '[::1]' ||
      /\.local$/.test(h) || /\.localhost$/.test(h) ||
      /^127\./.test(h) ||                                   // 127.0.0.0/8 loopback
      /^10\./.test(h) ||                                    // 10.0.0.0/8
      /^192\.168\./.test(h) ||                              // 192.168.0.0/16
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||               // 172.16.0.0/12
      h.indexOf('.') === -1;                                // bare hostname (no dot) → not a public FQDN
    if (!isLocal) return; // production / deployed public host: use committed config as-is

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
    //        localStorage.setItem('helm.allowProdFromLocalhost','1');
    //
    // The legacy HELM_BLOCK_PROD_FROM_LOCALHOST flag is still honoured (it forces a
    // block) but is now redundant: blocking is the default.
    var allowProd = (typeof window !== 'undefined' && window.HELM_ALLOW_PROD_FROM_LOCALHOST === true);
    try { allowProd = allowProd || (localStorage.getItem('helm.allowProdFromLocalhost') === '1'); } catch (e) {}
    // Legacy explicit block flag can only *reinforce* fail-closed, never open prod.
    var legacyBlock = (typeof window !== 'undefined' && window.HELM_BLOCK_PROD_FROM_LOCALHOST === true);
    try { legacyBlock = legacyBlock || (localStorage.getItem('helm.blockProdFromLocalhost') === '1'); } catch (e) {}
    if (legacyBlock) allowProd = false;

    var staging = (typeof window !== 'undefined' && window.HELM_STAGING_SUPABASE) || null;

    if (staging && staging.url && staging.anonKey) {
      // Use the isolated staging project — never production — for local development.
      window.SUPABASE_CONFIG.url = staging.url;
      window.SUPABASE_CONFIG.anonKey = staging.anonKey;
      window.SUPABASE_CONFIG.__staging = true;
      console.info('[Helm] Local development using the STAGING Supabase project (isolated from production).');
      return;
    }

    if (allowProd && window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url) {
      // Explicit, deliberate opt-in to hit PRODUCTION from localhost.
      console.warn('[Helm] Local development is DELIBERATELY using the PRODUCTION Supabase ' +
        'project (HELM_ALLOW_PROD_FROM_LOCALHOST opt-in). Changes here affect LIVE data — be careful.');
      return;
    }

    // Default: fail closed. Blank the prod credentials so nothing on localhost can
    // read/mutate production, and tell the developer exactly how to proceed.
    window.SUPABASE_CONFIG.url = '';          // → store-api supaConfigured() = false
    window.SUPABASE_CONFIG.anonKey = '';
    window.SUPABASE_CONFIG.__localFallback = true;
    console.error('[Helm] Supabase is DISABLED on localhost to protect PRODUCTION data ' +
      '(env separation, fail-closed). No staging project is configured. To proceed, either:\n' +
      '  • configure staging:  window.HELM_STAGING_SUPABASE = { url, anonKey }  (see docs/STAGING-SETUP.md), or\n' +
      "  • deliberately use production (read-only debugging):  localStorage.setItem('helm.allowProdFromLocalhost','1'); then reload.\n" +
      'Until then the app uses the local Node backend / localStorage only.');
  } catch (e) { /* never break config load */ }
})();
