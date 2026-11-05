/* trial-preview-frame.js - R125 (database 0334). The real client pages, shown inside the free-trial preview pop-up.
   The pop-up (trial-preview.js) opens /trial-preview-<page> in a same-origin frame. That address holds no token and no
   quote: pasted anywhere else it opens the normal page with a link that cannot exist, so "This link isn't available".
   Inside the pop-up the page's server calls are answered from the pop-up's memory (data the signed-in studio member
   already fetched through trial_preview_bundle), so the page is the real page and nothing reaches the server except the
   two members-only test actions. Links inside lose their address: nothing can be copied, opened or sent.
   Every other page and every other address: this file does nothing at all.
   CSP-safe: no inline code, no HTML strings. */
(function (w) {
  "use strict";
  var m = /^\/trial-preview-([a-z]+)\/?$/.exec(w.location.pathname);
  if (!m) return;
  var NIL = "00000000-0000-4000-8000-000000000000", HEX = new Array(65).join("0");
  var MAP = { approve: "/approve?token=" + NIL, portal: "/portal?token=" + NIL, booklet: "/booklet?t=" + NIL,
    proposal: "/proposal-view?token=" + NIL, invite: "/invite?s=preview", work: "/work?token=" + NIL,
    vendor: "/vendor-request?t=" + HEX, enquiry: "/enquiry?studio=preview" };
  var bridge = null;
  try { if (w.parent !== w && w.parent.location.origin === w.location.origin) bridge = w.parent.HelmTrialPreviewBridge || null; } catch (e) { bridge = null; }
  try { w.history.replaceState(null, "", MAP[m[1]] || "/404"); } catch (e) {}
  if (!bridge) return;   // no signed-in pop-up around it: the real page with a dead token = the plain "not available" page

  try { w.document.documentElement.classList.add("tp-framed"); } catch (e) {}
  var real = w.fetch.bind(w);
  function reply(status, body) {
    return new w.Response(body === undefined ? "null" : JSON.stringify(body), { status: status, headers: { "Content-Type": "application/json" } });
  }
  w.fetch = function (input, init) {
    var url = "";
    try { url = String(typeof input === "string" ? input : (input && input.url) || ""); } catch (e) { url = ""; }
    var rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)/i.exec(url);
    if (rpc) {
      var args = {};
      try { args = JSON.parse((init && init.body) || "{}"); } catch (e) { args = {}; }
      return Promise.resolve(bridge.rpc(rpc[1], args)).then(function (r) { return reply(r.status, r.json); },
        function () { return reply(500, { message: "Preview could not load this." }); });
    }
    if (/\/rest\/v1\//.test(url)) return Promise.resolve(reply(200, []));
    if (/\/functions\/v1\//.test(url)) return Promise.resolve(reply(200, {}));
    return real(input, init);
  };
  // nothing leaves: no new windows, no print, no share sheet, no clipboard write of an address
  w.open = function () { bridge.note(); return null; };
  w.print = function () { bridge.note(); };
  try { if (w.navigator.share) w.navigator.share = function () { bridge.note(); return Promise.resolve(); }; } catch (e) {}

  function strip(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll(".htour-fab,#shareBtm"), function (n) { n.hidden = true; n.style.display = "none"; });
    Array.prototype.forEach.call(root.querySelectorAll("a[href]"), function (a) {
      var h = a.getAttribute("href") || "";
      if (h.charAt(0) === "#") return;
      a.removeAttribute("href"); a.removeAttribute("target"); a.setAttribute("role", "button"); a.setAttribute("tabindex", "0");
      a.setAttribute("data-tp-dead", "1");
    });
  }
  w.addEventListener("click", function (e) {
    var t = e.target && e.target.closest && e.target.closest("a[data-tp-dead],a[href]");
    if (!t) return;
    var h = t.getAttribute("href");
    if (h && h.charAt(0) === "#") return;
    e.preventDefault(); bridge.note();
  }, true);
  // focus inside the frame: Esc still closes the pop-up
  w.addEventListener("keydown", function (e) { if (e.key === "Escape" && bridge.close) { e.preventDefault(); bridge.close(); } }, true);
  w.addEventListener("submit", function (e) {
    var f = e.target; if (f && f.getAttribute && f.getAttribute("action")) { e.preventDefault(); bridge.note(); }
  }, true);
  w.document.addEventListener("DOMContentLoaded", function () {
    strip(w.document);
    new w.MutationObserver(function () { strip(w.document); }).observe(w.document.documentElement, { childList: true, subtree: true });
  });
  w.HELM_TRIAL_PREVIEW = true;
})(window);
