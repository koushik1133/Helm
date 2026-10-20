/* suggest.js - r24 (0271): the Suggestions box.
   Two ways in, ONE anonymous-safe RPC (submit_suggestion; answers ok or a plain-words reason, nothing read back):
   - inside the app: the profile menu's "Send a suggestion" loads this file and calls HelmSuggest.open() -> a small
     dialog; sent through BPStore.suggest (signed in, so Helm records who and which studio - the server decides);
   - the public page /suggest (visitors, optional e-mail): the form #sg-form on that page.
   Lands in Helm HQ -> Requests -> Suggestions; an e-mail is queued to the HQ address. Text only, no inline script. */
(function () {
  "use strict";
  var KINDS = [["", "Choose\u2026"], ["idea", "Idea"], ["problem", "Problem"], ["other", "Other"]];

  function anonRpc(body) {
    var cfg = window.SUPABASE_CONFIG || {}, base = String(cfg.url || "").replace(/\/+$/, "");
    if (!base || !cfg.anonKey) return Promise.resolve({ ok: false, error: "config" });
    return fetch(base + "/rest/v1/rpc/submit_suggestion", { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
      body: JSON.stringify({ p: body }) })
      .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true, data: j } : { ok: false, error: "" }; }, function () { return { ok: false, error: "" }; }); })
      .catch(function () { return { ok: false, error: "network" }; });
  }
  function appRpc(body) {
    var st = window.BPStore;
    if (!st || typeof st.suggest !== "function") return anonRpc(body);
    return Promise.resolve(st.suggest(body)).then(function (d) { return { ok: true, data: d }; },
      function (e) { return { ok: false, error: /fetch|network/i.test(String(e && e.message)) ? "network" : "" }; });
  }
  function failText(r) {
    var d = r.ok ? r.data : null;
    if (d && d.message) return String(d.message).slice(0, 200);
    return r.error === "network" ? "No connection. Check your internet and try again." : "Something went wrong. Please try again.";
  }
  function page() { try { return (location.pathname || "/").slice(0, 120); } catch (e) { return null; } }

  /* ---- the public page (/suggest) ---- */
  var form = document.getElementById("sg-form");
  if (form) {
    var $ = function (id) { return document.getElementById(id); };
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var msg = $("sg-message").value.trim(), email = $("sg-email").value.trim(), e = $("sg-err");
      var show = function (t, el) { e.textContent = t; e.hidden = !t; ["sg-message", "sg-email"].forEach(function (i) { $(i).removeAttribute("aria-invalid"); }); if (el) { el.setAttribute("aria-invalid", "true"); el.focus(); } };
      if (msg.length < 3) return show("Please write your suggestion.", $("sg-message"));
      if (email && !/^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(email)) return show("Please enter a valid e-mail, or leave it empty.", $("sg-email"));
      show("");
      var body = { message: msg, category: $("sg-kind").value || null, email: email || null, page: "/suggest" };
      if ($("sg-website").value) body.website = $("sg-website").value;
      var btn = $("sg-send"); btn.disabled = true; btn.textContent = "Sending\u2026";
      anonRpc(body).then(function (r) {
        btn.disabled = false; btn.textContent = "Send suggestion";
        if (r.ok && r.data && r.data.ok === true) { form.hidden = true; $("sg-done").hidden = false; return; }
        show(failText(r), r.data && r.data.field === "email" ? $("sg-email") : $("sg-message"));
      });
    });
    return;
  }

  /* ---- inside the app: a small dialog ---- */
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function ensureCss() {
    if (document.getElementById("helm-suggest-css")) return;
    var l = el("link", { id: "helm-suggest-css", rel: "stylesheet", href: "/suggest.css?v=1" }); document.head.appendChild(l);
  }
  var open = null;
  function close() { if (open) { try { open.dlg.close(); } catch (e) {} open.dlg.remove(); var f = open.back; open = null; try { if (f) f.focus(); } catch (e) {} } }
  function openDialog() {
    if (open) return;
    ensureCss();
    var back = document.activeElement;
    var dlg = el("dialog", { class: "sgd", "aria-labelledby": "sgd-h" });
    var f = el("form", { class: "sgd-f", novalidate: "" });
    f.appendChild(el("h2", { id: "sgd-h" }, "Send a suggestion"));
    f.appendChild(el("p", { class: "sgd-sub" }, "An idea, something that is not working, or anything else - it goes straight to the Helm team."));
    var lk = el("label", { for: "sgd-kind" }, "What is it about?"); var sel = el("select", { id: "sgd-kind" });
    KINDS.forEach(function (k) { sel.appendChild(el("option", { value: k[0] }, k[1])); });
    var lm = el("label", { for: "sgd-msg" }, "Your suggestion *"); var ta = el("textarea", { id: "sgd-msg", rows: "5", maxlength: "2000" });
    var err = el("p", { class: "sgd-err", role: "alert" }); err.hidden = true;
    var row = el("div", { class: "sgd-row" });
    var cancel = el("button", { type: "button", class: "sgd-btn sgd-ghost" }, "Cancel");
    var send = el("button", { type: "submit", class: "sgd-btn" }, "Send");
    row.appendChild(cancel); row.appendChild(send);
    [lk, sel, lm, ta, err, row].forEach(function (n) { f.appendChild(n); });
    dlg.appendChild(f); document.body.appendChild(dlg);
    open = { dlg: dlg, back: back };
    cancel.addEventListener("click", close);
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    dlg.addEventListener("click", function (e) { if (e.target === dlg) close(); });
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var m = ta.value.trim();
      if (m.length < 3) { err.textContent = "Please write your suggestion."; err.hidden = false; ta.focus(); return; }
      err.hidden = true; send.disabled = true; send.textContent = "Sending\u2026";
      appRpc({ message: m, category: sel.value || null, page: page() }).then(function (r) {
        send.disabled = false; send.textContent = "Send";
        if (r.ok && r.data && r.data.ok === true) {
          while (f.firstChild) f.removeChild(f.firstChild);
          f.appendChild(el("h2", { id: "sgd-h" }, "Thank you!"));
          f.appendChild(el("p", { class: "sgd-sub" }, "The Helm team has your suggestion. We read every one."));
          var ok = el("button", { type: "button", class: "sgd-btn" }, "Close"); ok.addEventListener("click", close);
          var r2 = el("div", { class: "sgd-row" }); r2.appendChild(ok); f.appendChild(r2); ok.focus();
          return;
        }
        err.textContent = failText(r); err.hidden = false;
      });
    });
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    ta.focus();
  }
  window.HelmSuggest = { open: openDialog };
})();
