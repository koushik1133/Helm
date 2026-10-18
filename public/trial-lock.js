/* trial-lock.js (0173): FREE TRIAL studios only. Paid studios: the server says "not a trial" and nothing here runs.
 * - adds html.helm-trial (trial-lock.css hides downloads, imports, photo renders, studio set-up, catalog "add" rows)
 * - blocks print / file downloads / Excel import in the page and shows "Not available in the free trial"
 * - pages that are studio set-up (onboarding) show a "Not available in the free trial" panel instead
 * The server enforces the same rules (migration 0173); this only keeps the screens honest. */
(function () {
  "use strict";
  if (window.HelmTrialLock) return;
  var MSG = "Not available in the free trial. Upgrade to use this.";
  var on = false, known = false, waiters = [];
  var BLOCKED_PAGES = /(^|\/)(onboarding)(\.html)?\/?$/;
  function css() {
    if (document.getElementById("trialLockCss")) return;
    var l = document.createElement("link"); l.id = "trialLockCss"; l.rel = "stylesheet"; l.href = "/trial-lock.css?v=2";
    (document.head || document.documentElement).appendChild(l);
  }
  function note(msg) {
    msg = msg || MSG;
    try { if (window.BPUI && BPUI.toast) { BPUI.toast(msg, { type: "info", timeout: 4000 }); return; } } catch (e) {}
    try { window.alert(msg); } catch (e) {}
  }
  function cover(title, text) {
    if (document.getElementById("tlCover")) return;
    var c = document.createElement("div"); c.id = "tlCover"; c.className = "tl-cover"; c.setAttribute("role", "dialog"); c.setAttribute("aria-modal", "true");
    var b = document.createElement("div"); b.className = "tl-block";
    var h = document.createElement("h2"); h.textContent = title || "Not available in the free trial";
    var p = document.createElement("p"); p.textContent = text || "Your free trial comes ready to use with sample data, so this set-up step is not needed. Upgrade to set up your own studio.";
    var a = document.createElement("a"); a.href = "/dashboard.html"; a.textContent = "Go to dashboard";
    b.appendChild(h); b.appendChild(p); b.appendChild(a); c.appendChild(b);
    (document.body || document.documentElement).appendChild(c);
  }
  function wrapImport() {
    var H = window.HelmImport;
    if (H && typeof H.open === "function" && !H.__tl) { H.open = function () { note(); return null; }; H.__tl = true; }
  }
  function apply() {
    if (on) return; on = true;
    css();
    document.documentElement.classList.add("helm-trial");
    if (/(^|\/)budget(\.html)?\/?$/.test(location.pathname)) document.documentElement.classList.add("tl-budget");   // "Import vendor bookings" copies in-app rows, not a file
    try { window.print = function () { note(); }; } catch (e) {}
    try {
      var click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) { note(); return; } return click.apply(this, arguments); };
    } catch (e) {}
    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest('a[download], [data-csv], [data-act="download"], [data-act="dl"], #exportBtn, #jsonBtn, #printBtn, #printPL, #q_pdf, #viewSeg [data-v="render"], #ch_add, #pl_add, #dc_add') : null;
      if (!t) return;
      e.preventDefault(); e.stopImmediatePropagation(); note();
    }, true);
    wrapImport(); var n = 0, iv = setInterval(function () { wrapImport(); if (++n > 40) clearInterval(iv); }, 250);
    function page() { if (BLOCKED_PAGES.test(location.pathname)) cover(); }
    if (document.body) page(); else document.addEventListener("DOMContentLoaded", page);
    try { localStorage.setItem("helm.trial", "1"); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent("helm:trial", { detail: { trial: true } })); } catch (e) {}
    known = true; waiters.splice(0).forEach(function (f) { try { f(true); } catch (e) {} });
  }
  function done() { known = true; waiters.splice(0).forEach(function (f) { try { f(on); } catch (e) {} }); }
  function check(tries) {
    var S = window.BPStore;
    if (!S || !S.subscription || !S.subscription.trial) { if ((tries || 0) < 80) setTimeout(function () { check((tries || 0) + 1); }, 100); else done(); return; }
    Promise.resolve(S.init ? S.init() : null).then(function () { if (S.auth && S.auth.user && !S.auth.user()) return null; return S.subscription.trial(); }).then(function (t) {
      if (t && t.status === "trial") apply();
      else { try { localStorage.removeItem("helm.trial"); } catch (e) {} done(); }
    }, done);
  }
  window.HelmTrialLock = {
    MSG: MSG,
    isTrial: function () { return on; },
    // resolves true/false once the server has answered
    whenKnown: function () { return new Promise(function (r) { if (known || on) { r(on); return; } waiters.push(r); setTimeout(function () { r(on); }, 5000); }); },
    note: note,
    cover: cover
  };
  check(0);
})();
