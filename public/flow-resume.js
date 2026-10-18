/* =========================================================================
   HELM - "Continue where you left off" for the quote flow (owner, Oct 2026).
   flow.html records the section the user last worked in (per signed-in user,
   this browser): { quoteId, name, step, at }. The Quotes list and the
   dashboard show one button for the most recently edited UNFINISHED quote:
     Continue where you left off → <quote name>, step N
   The quote is re-read from the server first (status / shelf / updated_at), so a
   confirmed, cancelled, archived or deleted quote never shows. Opening a quote
   in the flow without a #section lands on its last section.
   Only the quote id, its display name and a step key are kept (no client data).
   DOM via createElement + textContent. window.HelmFlowResume / require().
   ========================================================================= */
(function (root) {
  "use strict";
  var STEPS = { client: 1, discovery: 2, reqs: 3, venue: 4, menu: 5, proposal: 6, layout: 7, quote: 8, pay: 9 };
  var LABELS = { client: "Client", discovery: "Discovery", reqs: "Requirements", venue: "Venue", menu: "Menu", proposal: "Proposal", layout: "Layout", quote: "Quotation", pay: "Advance payment" };
  var MAX_AGE = 30 * 864e5;
  var DONE = { confirmed: 1, cancelled: 1, lost: 1, closed: 1, settlement: 1 };

  function store() { try { return root.localStorage || null; } catch (e) { return null; } }
  function key(uid) { return "helm_flow_resume_" + String(uid || "anon"); }
  function read(uid, now) {
    var ls = store(); if (!ls) return null;
    try {
      var o = JSON.parse(ls.getItem(key(uid)) || "null");
      if (!o || typeof o !== "object" || !o.quoteId || !STEPS[o.step]) return null;
      if ((now || Date.now()) - (+o.at || 0) > MAX_AGE) return null;
      return o;
    } catch (e) { return null; }
  }
  function record(uid, q, now) {
    var ls = store(); if (!ls || !q || !q.quoteId || !STEPS[q.step]) return null;
    var o = { quoteId: String(q.quoteId), name: String(q.name || "").slice(0, 80), step: q.step, at: now || Date.now() };
    try { ls.setItem(key(uid), JSON.stringify(o)); } catch (e) { return null; }
    return o;
  }
  function clear(uid, quoteId) {
    var ls = store(); if (!ls) return;
    var o = read(uid); if (o && (!quoteId || o.quoteId === String(quoteId))) { try { ls.removeItem(key(uid)); } catch (e) {} }
  }
  function lastStep(uid, quoteId) { var o = read(uid); return o && o.quoteId === String(quoteId) ? o.step : null; }
  // a quote that is still being worked on (not booked / closed / shelved)
  function unfinished(q) {
    if (!q) return false;
    if (q.deletedAt || q.archivedAt || q.deleted_at || q.archived_at) return false;
    var st = String(q.status || "").toLowerCase(), stage = String(q.lifecycleStage || q.lifecycle_stage || "").toLowerCase();
    return !DONE[st] && !DONE[stage];
  }
  function label(o) { return "Continue where you left off → " + (o.name || "your quote") + ", step " + STEPS[o.step] + " · " + LABELS[o.step]; }
  function href(o) { return "flow.html?quote=" + encodeURIComponent(o.quoteId) + "#sec-" + o.step; }

  // page banner: quotes.html + dashboard.html (needs BPStore)
  function mount() {
    var doc = root.document; if (!doc) return;
    var tries = 0;
    function go() {
      var S = root.BPStore;
      if (!S || !S.auth || !S.quotes || !S.quotes.get) { if (tries++ < 40) setTimeout(go, 500); return; }
      var u = null; try { u = S.auth.enabled && S.auth.enabled() ? S.auth.user() : { id: "anon" }; } catch (e) { u = null; }
      if (!u) { if (tries++ < 40) setTimeout(go, 500); return; }
      var o = read(u.id); if (!o) return;
      Promise.resolve(S.quotes.get(o.quoteId)).then(function (q) {
        if (!unfinished(q)) { clear(u.id, o.quoteId); return; }
        try { var H = root.HelmEventName; var nm = H && H.displayName ? H.displayName(q) : ""; if (nm) o.name = nm; else if (q.title || q.code) o.name = q.title || q.code; } catch (e) {}
        var host = doc.getElementById("main") || doc.body; if (!host || doc.getElementById("flowResume")) return;
        var box = doc.createElement("div"); box.id = "flowResume"; box.className = "flow-resume card";
        var a = doc.createElement("a"); a.className = "btn primary"; a.href = href(o); a.textContent = label(o);
        var x = doc.createElement("button"); x.type = "button"; x.className = "btn"; x.textContent = "Dismiss"; x.setAttribute("aria-label", "Dismiss the continue button");
        x.addEventListener("click", function () { clear(u.id, o.quoteId); box.remove(); });
        // CSSOM (CSP-safe): a slim row above the page content
        box.style.display = "flex"; box.style.flexWrap = "wrap"; box.style.gap = "8px"; box.style.alignItems = "center"; box.style.margin = "0 0 14px"; box.style.padding = "10px 12px";
        a.style.whiteSpace = "normal"; a.style.height = "auto"; a.style.minHeight = "38px"; a.style.overflowWrap = "anywhere";
        box.appendChild(a); box.appendChild(x);
        host.insertBefore(box, host.firstChild);
      }).catch(function () { /* not found / offline: no button */ });
    }
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go); else go();
  }

  var api = { STEPS: STEPS, LABELS: LABELS, key: key, read: read, record: record, clear: clear, lastStep: lastStep, unfinished: unfinished, label: label, href: href, mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelmFlowResume = api;
  if (root.document && root.document.currentScript && root.document.currentScript.hasAttribute("data-mount")) mount();
})(typeof window !== "undefined" ? window : globalThis);
