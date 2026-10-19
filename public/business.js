/* business.js — Business page bootstrap: auth gate (r20 / 0239: the "business" area VIEW - admin only by
   default, a studio can switch it on per role in Control Center -> Roles & access; planners keep "finance"
   for payments on events without seeing this page) then HelmMoney.mount. Read-only. */
(function () {
  "use strict";
  function $(s) { return document.querySelector(s); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function here() { try { return HelmUrl.here(); } catch (e) { return "business.html"; } }
  async function renderAccount() {
    var box = $("#account"), A = BPStore.auth; if (!A.enabled()) { box.hidden = true; return; }
    box.hidden = false; while (box.firstChild) box.removeChild(box.firstChild);
    var u = A.user();
    if (u) {
      var role = await A.role();
      box.appendChild(el("span", "role", role || "")); box.appendChild(el("span", null, u.email || ""));
      var b = el("button", null, "Log out"); b.type = "button"; b.id = "logoutBtn";
      b.addEventListener("click", async function () { await A.signOut(); location.href = "dashboard.html"; }); box.appendChild(b);
    } else {
      var s = el("button", null, "Sign in"); s.type = "button"; s.id = "loginBtn";
      s.addEventListener("click", function () { location.replace("login.html?next=" + encodeURIComponent(here())); }); box.appendChild(s);
    }
  }
  async function load() {
    await BPStore.init(); await renderAccount();
    try { await BPStore.bell.mount($("#bell")); } catch (e) {}
    var A = BPStore.auth;
    if (A.enabled() && A.required() && !A.user()) { location.replace("login.html?next=" + encodeURIComponent(here())); return; }
    var ok = !A.enabled() || await A.canView("business");
    /* r20 planner: the header "Insights" link only for a role that can open Insights */
    try { var ins = $("#bzInsNav"); if (ins) ins.hidden = !(!A.enabled() || (await A.canView("insights")) === true); } catch (e) {}
    if (!ok) { $("#noaccess").hidden = false; return; }
    var app = $("#bzApp"); app.hidden = false;
    await window.HelmMoney.mount(app);
  }
  function go() { if (window.BPUI && BPUI.boot) BPUI.boot(load); else load(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
})();
