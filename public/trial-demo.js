/* =========================================================================
   HELM — free-trial demo data (0097)
   -------------------------------------------------------------------------
   • Dashboard (#tdCard[data-td-auto]): right after the trial starts the studio
     admin chooses "Try with demo data" (seed_demo_data → a sample Hyderabad
     studio, every row marked "Demo ·") or "Start with my own data" (→ the
     onboarding wizard). In demo mode the card offers "Start onboarding with my
     data" and "Reset demo data".
   • Switching to own data (openSwitch): keep the demo data, or clear it. Clearing
     asks twice and calls clear_demo_data(), which removes ONLY this studio's rows
     flagged is_demo inside one database transaction — real rows are never touched.
   • Control Center (#tdControl[data-td-control]): the same actions in a card.
   • The persistent banner lives in auth-ui.js (demoNotice), on every page.
   • CSP: DOM built with createElement/textContent only; runtime CSS via __helmAdoptCss.
   ========================================================================= */
(function (global) {
  "use strict";
  const doc = global.document;
  const CSS = [
    ".td{border:1px solid var(--line,#e8e3db);background:var(--panel,#fff);border-radius:14px;padding:18px;margin:14px 0}",
    ".td h3{margin:0 0 4px;font-size:17px}.td p{margin:0 0 10px;color:var(--ink-2,#4b475f);font-size:14px}",
    ".td-pick{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:10px}",
    ".td-opt{display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;padding:16px;border-radius:12px;border:1px solid var(--line,#e8e3db);background:var(--panel-2,#faf8f5);color:inherit;font:inherit;cursor:pointer}",
    ".td-opt:hover,.td-opt:focus-visible{border-color:var(--accent,#6d28d9)}",
    ".td-opt b{font-size:15px}.td-opt span{font-size:13px;color:var(--ink-2,#4b475f)}",
    ".td-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
    ".td-tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent,#6d28d9);background:var(--accent-soft,#efe9ff);border-radius:999px;padding:2px 8px;margin-bottom:6px}",
    ".td-dlg{border:1px solid var(--line,#e8e3db);border-radius:14px;padding:20px;max-width:440px;width:calc(100vw - 32px);background:var(--panel,#fff);color:var(--ink,#1b1930)}",
    ".td-dlg::backdrop{background:rgba(20,27,46,.45)}.td-dlg h3{margin:0 0 6px;font-size:17px}.td-dlg p{margin:0 0 14px;font-size:14px;color:var(--ink-2,#4b475f)}",
    ".td-dlg .td-row{justify-content:flex-end}",
    ".td-busy{opacity:.7;cursor:progress}",
    ".td-list{margin:0 0 12px;padding-left:20px;font-size:14px}.td-list li{margin:2px 0}",
    ".td-safe{font-weight:600}.td-fresh{margin:0 0 14px}",
    ".td-dlg .td-row .danger{background:var(--danger,#b42318);border-color:var(--danger,#b42318);color:#fff}",
    ".td-err{color:var(--danger,#b42318);margin:8px 0 0;font-size:13px}",
  ].join("\n");
  let cssDone = false;
  function css() { if (cssDone) return; cssDone = true; if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS); }
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(label, cls, onClick) { const b = el("button", cls || "btn", label); b.type = "button"; b.addEventListener("click", onClick); return b; }
  const S = () => global.BPStore;
  // toast; if BPUI.toast is missing / throws, an error still shows (inline next to the button, else alert)
  const toast = (m, type, near) => {
    try { if (global.BPUI && typeof global.BPUI.toast === "function") { global.BPUI.toast(m, { type: type || "ok" }); return; } } catch (e) {}
    if (type !== "err") return;
    try {
      const host = near && near.parentNode;
      if (host) { let n = host.querySelector(".td-err"); if (!n) { n = el("p", "td-err"); n.setAttribute("role", "alert"); host.appendChild(n); } n.textContent = m; return; }
    } catch (e) {}
    try { global.alert(m); } catch (e) {}
  };
  const errMsg = (e, action) => {
    try { if (global.BPUI && typeof global.BPUI.friendlyError === "function") { const m = global.BPUI.friendlyError(e, { action: action || "load the demo data" }); if (m) return String(m); } } catch (x) {}
    return (e && (e.message || e.error_description)) || "Couldn't " + (action || "load the demo data") + " — please try again.";
  };
  // busy state on a button: disabled + aria-busy + "Working…" label; returns a restore fn
  function busy(b, label) {
    if (!b) return () => {};
    const tgt = b.querySelector("b") || b, prev = tgt.textContent;
    b.disabled = true; b.setAttribute("aria-busy", "true"); b.classList.add("td-busy");
    if (label) tgt.textContent = label;
    return () => { b.disabled = false; b.removeAttribute("aria-busy"); b.classList.remove("td-busy"); tgt.textContent = prev; };
  }

  /* ---- pure model (exported for tests) ---------------------------------- */
  // d = my_demo_status(), t = my_trial_status() → which card to show
  //   'choose'  admin, trial running, no choice made yet
  //   'demo'    demo mode with demo rows (admins get the actions)
  //   'leftover' own-data mode but demo rows are still there (admin can remove them)
  //   null      nothing to show
  function view(d, t) {
    if (!d || typeof d !== "object") return null;
    if (d.trial_mode == null && !d.has_demo) {
      return d.is_admin === true && t && typeof t === "object" && t.state === "trial" ? "choose" : null;
    }
    if (d.trial_mode === "demo" && d.has_demo) return "demo";
    if (d.trial_mode === "own" && d.has_demo && d.is_admin === true) return "leftover";
    return null;
  }

  /* ---- actions ------------------------------------------------------------ */
  async function confirmDlg(msg, o) {
    try { if (global.BPUI && global.BPUI.confirm) return !!(await global.BPUI.confirm(msg, o)); } catch (e) { return false; }
    return global.confirm(msg);
  }
  async function seed(b) {
    if (b && b.disabled) return;
    const done = busy(b, "Loading demo data…");
    try { await S().demo.seed(); toast("Demo studio ready — look around! Everything marked “Demo ·” is sample data."); global.location.reload(); }
    catch (e) { done(); toast(errMsg(e, "load the demo data"), "err", b); }
  }
  async function own(b) {
    if (b && b.disabled) return;
    const done = busy(b, "Opening setup…");
    try { await S().demo.setMode("own"); global.location.assign("onboarding.html"); }
    catch (e) { done(); toast(errMsg(e, "start with your own data"), "err", b); }
  }
  async function clearDemo(then) {
    const ok = await confirmDlg("This removes only the sample rows marked “Demo ·” (events, leads, staff, vendors, items, packages, layout). Your own data is never touched. Demo venues are switched off, and a demo item one of your real events uses is kept.",
      { title: "Remove all demo data?", okLabel: "Remove demo data", danger: true });
    if (!ok) return false;
    try { await S().demo.clear(); toast("Demo data removed. Your own data is untouched."); }
    catch (e) { toast(errMsg(e, "remove the demo data"), "err"); return false; }
    if (then) global.location.assign(then); else global.location.reload();
    return true;
  }
  async function resetDemo(b) {
    const ok = await confirmDlg("All demo rows go back to how they started (your changes to demo rows are undone). Your own data is never touched.",
      { title: "Reset demo data?", okLabel: "Reset demo data" });
    if (!ok) return;
    const done = busy(b, "Resetting…");
    try { await S().demo.reset(); toast("Demo data reset."); global.location.reload(); }
    catch (e) { done(); toast(errMsg(e, "reset the demo data"), "err", b); }
  }
  /* ---- "Start my own studio" (0123) --------------------------------------- */
  // Pure (unit-tested): my_demo_status().counts -> plain-words lines, biggest first; [] when unknown
  const COUNT_LABELS = [["events", "sample event", "sample events"], ["leads", "sample lead", "sample leads"],
    ["staff", "sample staff member", "sample staff members"], ["vendors", "sample vendor", "sample vendors"],
    ["inventory", "sample inventory item", "sample inventory items"], ["packages", "sample menu package", "sample menu packages"],
    ["dishes", "sample dish", "sample dishes"], ["layouts", "sample floor layout", "sample floor layouts"],
    ["venues", "sample venue (switched off, not deleted)", "sample venues (switched off, not deleted)"]];
  function countLines(c) {
    if (!c || typeof c !== "object") return [];
    const out = [];
    COUNT_LABELS.forEach(function (x) { const n = Math.floor(Number(c[x[0]])); if (isFinite(n) && n > 0) out.push(n + " " + (n === 1 ? x[1] : x[2])); });
    return out;
  }
  // only these follow-ups are allowed (never an arbitrary URL from the query string)
  function nextAfterFresh(then) { return then === "checkout" ? "checkout.html?next=" + encodeURIComponent("onboarding.html?fresh=1") : "onboarding.html?fresh=1"; }

  // One clear action: shows what goes (counts), what stays, then clear_demo_data() -> studio setup.
  // opts.then: "checkout" when opened from "Choose a plan".
  async function startFresh(opts) {
    opts = opts || {};
    let d = null;
    try { d = await S().demo.status(); } catch (e) {}
    if (d && d.has_demo === false) { global.location.assign(nextAfterFresh(opts.then)); return; }
    css();
    const dlg = el("dialog", "td-dlg");
    dlg.setAttribute("aria-labelledby", "tdDlgT");
    const h = el("h3", null, opts.then === "checkout" ? "Start fresh before you choose a plan?" : "Ready to start your own studio?"); h.id = "tdDlgT";
    dlg.appendChild(h);
    dlg.appendChild(el("p", null, "We'll remove only the sample rows marked “Demo ·”, then take you to studio setup (name, logo, currency, packages)."));
    const lines = countLines(d && d.counts);
    if (lines.length) { const ul = el("ul", "td-list"); lines.forEach((t) => ul.appendChild(el("li", null, t))); dlg.appendChild(ul); }
    else if (d && d.demo_rows > 0) dlg.appendChild(el("p", null, d.demo_rows + " sample rows in total."));
    dlg.appendChild(el("p", "td-safe", "Everything you added yourself stays exactly as it is. A sample item one of your real events uses is kept and switched off."));
    const row = el("div", "td-row");
    const close = () => { try { dlg.close(); } catch (e) {} dlg.remove(); };
    row.appendChild(btn("Cancel", "btn", close));
    row.appendChild(btn(opts.then === "checkout" ? "Keep samples, choose plan" : "Keep samples for now", "btn", async (ev) => {
      if (opts.then === "checkout") { close(); global.location.assign("checkout.html?next=dashboard.html"); return; }
      const done = busy(ev.currentTarget, "Opening setup…");
      try { await S().demo.setMode("own"); global.location.assign("onboarding.html"); } catch (e) { done(); toast(errMsg(e, "keep the demo data"), "err", ev.currentTarget); } }));
    const go = btn("Remove samples & set up my studio", "btn primary danger", async () => {
      const done = busy(go, "Removing samples…");
      try { await S().demo.clear(); }
      catch (e) { done(); toast(errMsg(e, "remove the demo data"), "err", go); return; }
      toast("Sample data removed. Your own data is untouched.");
      global.location.assign(nextAfterFresh(opts.then));
    });
    row.appendChild(go);
    dlg.appendChild(row);
    dlg.addEventListener("cancel", close);
    doc.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
  }
  function openSwitch() { return startFresh({}); }

  // onboarding.html?fresh=1: a short welcome; offers to rename a "Demo N" studio in step 1
  async function mountFresh() {
    if (!/[?&]fresh=1\b/.test(global.location.search || "")) return;
    const st = S(); let name = "";
    try { const t = st && st.trialOrg ? await st.trialOrg.status() : null; name = (t && t.name) || ""; } catch (e) {}
    css();
    const box = el("div", "td td-fresh"); box.setAttribute("role", "status");
    box.appendChild(el("span", "td-tag", "Fresh start"));
    box.appendChild(el("h3", null, "Your studio is clean — let's set it up"));
    box.appendChild(el("p", null, /^Demo [0-9]+$/.test(name)
      ? "Your studio is still called “" + name + "”. Give it your real name in the first step, then add your logo, currency and packages."
      : "Add your studio name, logo, currency and packages. You can change any of it later."));
    const host = doc.getElementById("main") || doc.body;
    host.insertBefore(box, host.firstChild);
  }
  /* ---- rendering ---------------------------------------------------------- */
  function render(host, v, d, place) {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!v) { host.hidden = true; return; }
    css(); host.hidden = false; host.classList.add("td");
    const admin = d && d.is_admin === true;
    if (v === "choose") {
      host.appendChild(el("span", "td-tag", "Free trial"));
      host.appendChild(el("h3", null, "How would you like to start?"));
      host.appendChild(el("p", null, "You can switch at any time during your 8-day free trial."));
      const pick = el("div", "td-pick");
      const a = el("button", "td-opt"); a.type = "button";
      a.appendChild(el("b", null, "Try with demo data"));
      a.appendChild(el("span", null, "Explore a ready sample studio from Hyderabad: leads, quotes in every stage, a confirmed wedding with an advance paid, venues, menu packages, inventory, staff, vendors, a finished floor layout and a checklist. Nothing is sent to anyone."));
      a.addEventListener("click", () => seed(a));
      const b = el("button", "td-opt"); b.type = "button";
      b.appendChild(el("b", null, "Start with my own data"));
      b.appendChild(el("span", null, "Go straight to studio setup: your details, menu, prices, team, venues and imports."));
      b.addEventListener("click", () => own(b));
      pick.appendChild(a); pick.appendChild(b); host.appendChild(pick);
      return;
    }
    if (v === "demo") {
      host.appendChild(el("span", "td-tag", "Demo data"));
      host.appendChild(el("h3", null, "You're exploring a demo studio"));
      host.appendChild(el("p", null, "Everything marked “Demo ·” is sample data. Messages, approval codes and payment links are switched off for it."));
      if (admin) {
        const row = el("div", "td-row");
        row.appendChild(btn("Start my own studio →", "btn primary", () => startFresh({})));
        const r = btn("Reset demo data", "btn", () => resetDemo(r)); row.appendChild(r);
        if (place === "control") row.appendChild(btn("Remove demo data", "btn", () => clearDemo()));
        host.appendChild(row);
      }
      return;
    }
    if (v === "leftover") {
      host.appendChild(el("span", "td-tag", "Demo data"));
      host.appendChild(el("h3", null, "Demo data is still in your studio"));
      host.appendChild(el("p", null, "Remove the sample rows marked “Demo ·” when you no longer need them. Your own data is never touched."));
      const row = el("div", "td-row");
      row.appendChild(btn("Remove demo data", "btn", () => clearDemo()));
      if (place === "control") { const r = btn("Reset demo data", "btn", () => resetDemo(r)); row.appendChild(r); }
      host.appendChild(row);
    }
  }
  // Control Center: also offer "Load demo data" to an admin with no demo rows during the trial
  function renderControlEmpty(host, d, t) {
    if (!(d && d.is_admin === true && !d.has_demo && t && t.state === "trial")) { host.hidden = true; return; }
    css(); host.hidden = false;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(el("h3", null, "Demo data"));
    host.appendChild(el("p", null, "Load a sample studio to explore Helm. Every sample row is marked “Demo ·” and can be removed in one click; your own data is never touched."));
    const b = btn("Load demo data", "btn", () => seed(b)); host.appendChild(b);
  }

  async function mount() {
    if (/(^|\/)onboarding(\.html)?$/.test(global.location.pathname || "")) { mountFresh(); return; }
    const dash = doc.querySelector("[data-td-auto]"), ctl = doc.querySelector("[data-td-control]");
    if (!dash && !ctl) return;
    const st = S(); if (!st || !st.demo || !st.subscription) return;
    try { if (st.init) await st.init(); } catch (e) {}
    let d = null, t = null;
    try { [d, t] = await Promise.all([st.demo.status(), st.subscription.trial().catch(() => null)]); } catch (e) { return; }
    if (!d) return;
    const v = view(d, t);
    if (dash) render(dash, v, d, "dashboard");
    if (ctl) { if (v === "demo" || v === "leftover") render(ctl, v, d, "control"); else renderControlEmpty(ctl, d, t); }
    try {
      const q = global.location.search || "";
      if (/[?&]demo=fresh\b/.test(q) && /[?&]then=checkout\b/.test(q) && !(d.is_admin && d.has_demo)) { global.location.assign("checkout.html?next=dashboard.html"); return; }
      if (d.is_admin && d.has_demo && /[?&]demo=(switch|fresh)\b/.test(q)) startFresh({ then: /[?&]then=checkout\b/.test(q) ? "checkout" : "" });
    } catch (e) {}
  }

  global.HelmTrialDemo = { view: view, openSwitch: openSwitch, startFresh: startFresh, countLines: countLines, nextAfterFresh: nextAfterFresh, mount: mount };
  if (doc) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount); else mount(); }
})(typeof window !== "undefined" ? window : globalThis);
