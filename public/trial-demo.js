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
  ].join("\n");
  let cssDone = false;
  function css() { if (cssDone) return; cssDone = true; if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS); }
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(label, cls, onClick) { const b = el("button", cls || "btn", label); b.type = "button"; b.addEventListener("click", onClick); return b; }
  const S = () => global.BPStore;
  const toast = (m, type) => { try { global.BPUI.toast(m, { type: type || "ok" }); } catch (e) {} };
  const errMsg = (e) => (e && (e.message || e.error_description)) || "Something went wrong — please try again.";

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
    if (b) b.disabled = true;
    try { await S().demo.seed(); toast("Demo studio ready — look around! Everything marked “Demo ·” is sample data."); global.location.reload(); }
    catch (e) { toast(errMsg(e), "err"); if (b) b.disabled = false; }
  }
  async function own(b) {
    if (b) b.disabled = true;
    try { await S().demo.setMode("own"); global.location.assign("onboarding.html"); }
    catch (e) { toast(errMsg(e), "err"); if (b) b.disabled = false; }
  }
  async function clearDemo(then) {
    const ok = await confirmDlg("This removes only the sample rows marked “Demo ·” (events, leads, staff, vendors, items, packages, layout). Your own data is never touched. Demo venues are switched off, and a demo item one of your real events uses is kept.",
      { title: "Remove all demo data?", okLabel: "Remove demo data", danger: true });
    if (!ok) return false;
    try { await S().demo.clear(); toast("Demo data removed. Your own data is untouched."); }
    catch (e) { toast(errMsg(e), "err"); return false; }
    if (then) global.location.assign(then); else global.location.reload();
    return true;
  }
  async function resetDemo(b) {
    const ok = await confirmDlg("All demo rows go back to how they started (your changes to demo rows are undone). Your own data is never touched.",
      { title: "Reset demo data?", okLabel: "Reset demo data" });
    if (!ok) return;
    if (b) b.disabled = true;
    try { await S().demo.reset(); toast("Demo data reset."); global.location.reload(); }
    catch (e) { toast(errMsg(e), "err"); if (b) b.disabled = false; }
  }
  // "Start onboarding": keep the demo data, or clear it first (the owner chooses)
  function openSwitch() {
    css();
    const dlg = el("dialog", "td-dlg");
    dlg.setAttribute("aria-labelledby", "tdDlgT");
    const h = el("h3", null, "Set up your studio with your own data"); h.id = "tdDlgT";
    dlg.appendChild(h);
    dlg.appendChild(el("p", null, "Keep the demo data to look back at while you set up (remove it any time from Control Center), or clear it now. Clearing removes only rows marked “Demo ·”."));
    const row = el("div", "td-row");
    const close = () => { try { dlg.close(); } catch (e) {} dlg.remove(); };
    row.appendChild(btn("Cancel", "btn", close));
    row.appendChild(btn("Keep demo data", "btn", async (ev) => { ev.currentTarget.disabled = true;
      try { await S().demo.setMode("own"); global.location.assign("onboarding.html"); } catch (e) { toast(errMsg(e), "err"); close(); } }));
    row.appendChild(btn("Clear demo data", "btn primary", async () => { close(); await clearDemo("onboarding.html"); }));
    dlg.appendChild(row);
    dlg.addEventListener("cancel", close);
    doc.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
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
      host.appendChild(el("p", null, "You can switch at any time during your 14-day trial."));
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
        row.appendChild(btn("Start onboarding with my data →", "btn primary", openSwitch));
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
    try { if (/[?&]demo=switch\b/.test(global.location.search) && d.is_admin && d.has_demo) openSwitch(); } catch (e) {}
  }

  global.HelmTrialDemo = { view: view, openSwitch: openSwitch, mount: mount };
  if (doc) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount); else mount(); }
})(typeof window !== "undefined" ? window : globalThis);
