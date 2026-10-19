/* new-quote-dialog.js (window.HelmNewQuote) - the one-time link guard for "quotes?new=1".
 *
 * Owner audit (Oct 2026, item 8): opening /quotes?new=1 (or /dashboard#hb-new) created a quote on page
 * load, so a link someone sent you made one. r19 (owner): the "New quote" button itself now opens the
 * quote flow directly (no name / type dialog, no in-progress prompt) - see ask() below.
 *
 *   HelmNewQuote.arm(href)          -> href with a one-time nonce (&nq=...) that Helm's own
 *       pages add to a "quotes?new=1" link. The nonce is kept in sessionStorage.
 *   HelmNewQuote.consume(search)    -> true only when the URL has new=1 AND the nonce Helm
 *       stored for this tab (then the stored nonce is dropped: one use, 10-minute life).
 *       A link from anywhere else (no / wrong nonce) never starts anything by itself.
 *   HelmNewQuote.ask()              -> Promise<{ title: "", eventType: "" }> at once (compatibility only).
 */
(function (G) {
  "use strict";
  var NONCE_KEY = "helm.newQuoteNonce";
  var NONCE_TTL = 10 * 60 * 1000;

  function ss() { try { return G.sessionStorage || null; } catch (e) { return null; } }
  function randomNonce() {
    try {
      var a = new Uint8Array(16); G.crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } catch (e) { return ""; }   // no crypto -> no nonce -> the link just opens the page (never auto-opens)
  }
  function isNewQuoteHref(href) {
    return /(^|\/)quotes(\.html)?\?([^#]*&)?new=1(&|#|$)/.test(String(href || ""));
  }
  function arm(href) {
    href = String(href || "");
    if (!isNewQuoteHref(href)) return href;
    var n = randomNonce(), s = ss();
    if (!n || !s) return href;
    try { s.setItem(NONCE_KEY, JSON.stringify({ n: n, t: Date.now() })); } catch (e) { return href; }
    var hash = "", i = href.indexOf("#");
    if (i >= 0) { hash = href.slice(i); href = href.slice(0, i); }
    href = href.replace(/([?&])nq=[^&]*(&|$)/, "$1").replace(/[?&]$/, "");
    return href + (href.indexOf("?") >= 0 ? "&" : "?") + "nq=" + n + hash;
  }
  function consume(search) {
    var p; try { p = new URLSearchParams(search == null ? (G.location && G.location.search) || "" : search); } catch (e) { return false; }
    if (p.get("new") !== "1") return false;
    var s = ss(), stored = null;
    if (s) { try { stored = JSON.parse(s.getItem(NONCE_KEY) || "null"); } catch (e) { stored = null; } try { s.removeItem(NONCE_KEY); } catch (e) {} }
    var got = p.get("nq") || "";
    if (!stored || typeof stored.n !== "string" || !/^[0-9a-f]{32}$/.test(stored.n)) return false;
    if (!(Date.now() - Number(stored.t) < NONCE_TTL)) return false;
    return got === stored.n;
  }

  // r19 (owner): "New quote" opens the quote flow directly - the pre-create dialog (event name / type) and the
  // "You have N quotes in progress" prompt are gone (quotes are not capped in the free trial any more, 0211; the
  // dashboard "Continue where you left off" card and the Quotes "In progress" tab stay). Callers go straight to
  // BPStore.quotes.startBlank, which reuses the person's untouched blank quote (0075), and empty drafts move to the
  // Deleted shelf after a day (0141 / 0208) - so no empty rows pile up. ask() is kept for an older cached page
  // that still calls it: it answers at once with no picks (nothing is shown).
  function ask() { return Promise.resolve({ title: "", eventType: "" }); }

  G.HelmNewQuote = { ask: ask, arm: arm, consume: consume, isNewQuoteHref: isNewQuoteHref, NONCE_KEY: NONCE_KEY, NONCE_TTL: NONCE_TTL };
})(typeof window !== "undefined" ? window : globalThis);
