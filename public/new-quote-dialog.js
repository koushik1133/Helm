/* new-quote-dialog.js (window.HelmNewQuote) - the one guard in front of every "New quote".
 *
 * Owner audit (Oct 2026, items 7 + 8): "New quote" created a real quote on ONE click, and
 * opening /quotes?new=1 (or /dashboard#hb-new) created one on page load. A free trial may
 * only add 2 quotes, so one stray click - or one link someone sends you - used one up.
 *
 *   HelmNewQuote.ask({ country })  -> Promise<null | { title, eventType }>
 *       A small dialog: event name (optional), event type (optional), Cancel / Create quote.
 *       Nothing is created until the user presses Create. Cancel, Escape and the backdrop
 *       resolve null. The caller then calls BPStore.quotes.startBlank as before.
 *   HelmNewQuote.arm(href)          -> href with a one-time nonce (&nq=...) that Helm's own
 *       pages add to a "quotes?new=1" link. The nonce is kept in sessionStorage.
 *   HelmNewQuote.consume(search)    -> true only when the URL has new=1 AND the nonce Helm
 *       stored for this tab (then the stored nonce is dropped: one use, 10-minute life).
 *       A link from anywhere else (no / wrong nonce) never opens anything by itself.
 *
 * DOM built with createElement / textContent only (no HTML strings, no inline styles - CSP and
 * Trusted Types safe). Reuses the app dialog look (BPUI .bpui-overlay / .bpui-dialog) and
 * BPUI.modal for the focus trap and inert background.
 */
(function (G) {
  "use strict";
  var doc = G.document;
  var NONCE_KEY = "helm.newQuoteNonce";
  var NONCE_TTL = 10 * 60 * 1000;
  var NAME_MAX = 80;

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

  function el(tag, attrs, text) {
    var e = doc.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    if (text != null) e.textContent = String(text);
    return e;
  }
  function typeOptions(country) {
    var N = G.HelmEventName;
    try { if (N && typeof N.eventTypeOptions === "function") return N.eventTypeOptions(country || "", "", undefined); } catch (e) {}
    return (N && N.EVENT_TYPE_LIST) || ["Wedding", "Reception", "Birthday", "Corporate", "Conference"];
  }
  function studioCountry() {
    try { var t = G.BPStore && typeof G.BPStore.studioTax === "function" ? G.BPStore.studioTax() : null; return (t && t.country) || ""; } catch (e) { return ""; }
  }

  var CSS = ".nqd select{width:100%;box-sizing:border-box;min-height:40px;padding:8px 10px;border:1px solid var(--bpui-line);border-radius:8px;" +
    "background:var(--bpui-bg);color:var(--bpui-ink);font:inherit}.nqd label{margin-top:10px}.nqd .bpui-actions{margin-top:16px}";
  var cssDone = false;
  function css() { if (cssDone) return; cssDone = true; try { if (typeof G.__helmAdoptCss === "function") G.__helmAdoptCss(doc, CSS); } catch (e) {} }

  var open = null;   // one dialog at a time (a double click must not stack two)
  function ask(opts) {
    opts = opts || {};
    if (open) return open;
    css();
    open = new Promise(function (resolve) {
      var seq = Math.random().toString(36).slice(2, 8), id = "nqd-" + seq;
      var ov = el("div", { class: "bpui-overlay nqd-overlay", "data-bpui": "dialog", "data-bpui-keep": "" });
      var form = el("form", { class: "bpui-dialog nqd", role: "dialog", "aria-modal": "true", "aria-labelledby": id + "-t", "aria-describedby": id + "-m", novalidate: "" });
      form.appendChild(el("h2", { id: id + "-t" }, opts.title || "Start a new quote?"));
      var msg = el("p", { id: id + "-m" }, opts.message || "This adds a new quote to your studio. You can change these later.");
      form.appendChild(msg);

      form.appendChild(el("label", { for: id + "-n" }, "Event name (optional)"));
      var name = el("input", { id: id + "-n", type: "text", autocomplete: "off", maxlength: String(NAME_MAX), placeholder: "e.g. Sharma wedding" });
      form.appendChild(name);
      var err = el("p", { id: id + "-e", class: "bpui-field-err", hidden: true });
      form.appendChild(err);

      form.appendChild(el("label", { for: id + "-y" }, "Event type (optional)"));
      var type = el("select", { id: id + "-y" });
      type.appendChild(el("option", { value: "" }, "Choose later"));
      typeOptions(opts.country != null ? opts.country : studioCountry()).forEach(function (t) { type.appendChild(el("option", { value: t }, t)); });
      form.appendChild(type);

      var acts = el("div", { class: "bpui-actions" });
      var cancel = el("button", { type: "button", class: "bpui-btn", "data-close": "" }, "Cancel");
      var ok = el("button", { type: "submit", class: "bpui-btn bpui-primary" }, opts.okLabel || "Create quote");
      acts.appendChild(cancel); acts.appendChild(ok); form.appendChild(acts);
      ov.appendChild(form);

      var done = false, U = G.BPUI;
      function onKey(e) { if (e.key === "Escape" || e.key === "Esc") { e.preventDefault(); close(null); } }
      function close(val) {
        if (done) return; done = true;
        try { if (U && U.modal && U.modal.close) U.modal.close(ov); } catch (e) {}
        try { doc.removeEventListener("keydown", onKey, true); } catch (e) {}
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        open = null;
        resolve(val);
      }
      function fail(msg) {
        err.textContent = msg; err.hidden = false;
        name.setAttribute("aria-invalid", "true"); name.setAttribute("aria-describedby", id + "-e"); name.focus();
      }
      name.addEventListener("input", function () { if (!err.hidden) { err.hidden = true; name.removeAttribute("aria-invalid"); } });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var t = String(name.value || "").trim().replace(/\s+/g, " ");
        if (t.length > NAME_MAX) return fail("Keep the name to " + NAME_MAX + " characters or fewer.");
        var N = G.HelmEventName, et = String(type.value || "").trim();
        try { if (et && N && N.canonEventType) et = N.canonEventType(et) || et; } catch (x) {}
        close({ title: t, eventType: et });
      });
      cancel.addEventListener("click", function () { close(null); });
      // backdrop: close only when the press starts AND ends on the backdrop itself
      var downOnOv = false;
      ov.addEventListener("mousedown", function (e) { downOnOv = e.target === ov; });
      ov.addEventListener("mouseup", function (e) { if (downOnOv && e.target === ov) close(null); downOnOv = false; });

      (doc.body || doc.documentElement).appendChild(ov);
      var trapped = false;
      try { if (U && U.modal && U.modal.open) { U.modal.open(ov); trapped = true; } } catch (e) {}
      // BPUI.modal Escape clicks [data-close]; without BPUI handle Escape here
      if (!trapped) doc.addEventListener("keydown", onKey, true);
      try { name.focus(); } catch (e) {}
      // free trial only: say how many of the trial's new quotes are left (paid studios: no change)
      if (!opts.message) try {
        var sub = G.BPStore && G.BPStore.subscription;
        if (sub && typeof sub.limits === "function") Promise.resolve(sub.limits()).then(function (r) {
          if (done || !r || r.trial !== true) return;
          var cap = Number(r.cap) > 0 ? Number(r.cap) : 2, used = Number(r.used && r.used.quotes) || 0, left = Math.max(0, cap - used);
          msg.textContent = left > 0
            ? "Free trial: a new quote uses 1 of your " + cap + " (" + left + " left). Deleting a quote does not give it back."
            : "Your free trial has used its " + cap + " new quotes. Choose a plan to add more.";
        }).catch(function () {});
      } catch (e) {}
    });
    return open;
  }

  G.HelmNewQuote = { ask: ask, arm: arm, consume: consume, isNewQuoteHref: isNewQuoteHref, NONCE_KEY: NONCE_KEY, NONCE_TTL: NONCE_TTL };
})(typeof window !== "undefined" ? window : globalThis);
