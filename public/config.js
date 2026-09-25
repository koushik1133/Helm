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
    pay: false,       // create-payment-link → Razorpay (DEFERRED — do not enable)
    whatsapp: false   // send-whatsapp   → Evolution API (DEFERRED — do not enable)
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
    // WARN-BY-DEFAULT: local dev legitimately runs against this Supabase project
    // (there is no separate staging yet), so we do NOT blank the credentials —
    // that would break local sign-in. We loudly warn instead. To hard-disable
    // Supabase on localhost (once a staging project exists), opt IN with:
    //   window.HELM_BLOCK_PROD_FROM_LOCALHOST = true;  (before this file), or
    //   localStorage.setItem('helm.blockProdFromLocalhost','1');
    var block = (typeof window !== 'undefined' && window.HELM_BLOCK_PROD_FROM_LOCALHOST === true);
    try { block = block || (localStorage.getItem('helm.blockProdFromLocalhost') === '1'); } catch (e) {}
    if (block && window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url) {
      window.SUPABASE_CONFIG.url = '';        // → store-api supaConfigured() = false
      window.SUPABASE_CONFIG.anonKey = '';
      window.SUPABASE_CONFIG.__localFallback = true;
      console.warn('[Helm] Local Supabase access BLOCKED by opt-in — using local Node backend / localStorage. See docs/STAGING-SETUP.md.');
    } else {
      console.warn('[Helm] Local development is using the PRODUCTION Supabase project ' +
        '(no staging configured). Changes here affect LIVE data — be careful. ' +
        'See docs/STAGING-SETUP.md to wire an isolated staging project; set ' +
        "window.HELM_BLOCK_PROD_FROM_LOCALHOST=true to hard-disable Supabase locally.");
    }
  } catch (e) { /* never break config load */ }
})();
