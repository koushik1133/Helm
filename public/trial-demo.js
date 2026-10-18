/* =========================================================================
   HELM — free-trial demo data (0097)
   -------------------------------------------------------------------------
   • Dashboard (#tdCard[data-td-auto]): a trial studio without its sample data yet
     gets ONE action, "Load the sample data" (seed_demo_data → a sample Hyderabad
     studio, every row marked "Demo ·"). Trial terms: the old "own data" start
     choice is gone (0180: every free trial runs on the sample data).
   • Switching to own data (openSwitch): keep the demo data, or clear it. Clearing
     asks twice and calls clear_demo_data(), which removes ONLY this studio's rows
     flagged is_demo inside one database transaction — real rows are never touched.
   • Control Center (#tdControl[data-td-control]): the same actions in a card, plus
     "Clear sample data" (0166 clear_sample_data: admin, trial / ex-trial, is_demo rows only).
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
    ".td-opt:hover,.td-opt:focus-visible{border-color:var(--accent,#047857)}",
    ".td-opt b{font-size:15px}.td-opt span{font-size:13px;color:var(--ink-2,#4b475f)}",
    ".td-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
    ".td-tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent,#047857);background:var(--accent-soft,#e3f4ed);border-radius:999px;padding:2px 8px;margin-bottom:6px}",
    ".td-dlg{border:1px solid var(--line,#e8e3db);border-radius:14px;padding:20px;max-width:440px;width:calc(100vw - 32px);background:var(--panel,#fff);color:var(--ink,#1b1930)}",
    ".td-dlg::backdrop{background:rgba(20,27,46,.45)}.td-dlg h3{margin:0 0 6px;font-size:17px}.td-dlg p{margin:0 0 14px;font-size:14px;color:var(--ink-2,#4b475f)}",
    ".td-dlg .td-row{justify-content:flex-end}",
    ".td-busy{opacity:.7;cursor:progress}",
    ".td-list{margin:0 0 12px;padding-left:20px;font-size:14px}.td-list li{margin:2px 0}",
    ".td-safe{font-weight:600}.td-fresh{margin:0 0 14px}",
    ".td-dlg .td-row .danger{background:var(--danger,#b42318);border-color:var(--danger,#b42318);color:#fff}",
    ".td-err{color:var(--danger,#b42318);margin:8px 0 0;font-size:13px}",
    ".td-welcome{max-width:480px}.td-fld{display:flex;flex-direction:column;gap:4px;margin:0 0 10px}.td-fld label{font-size:13px;font-weight:600}",
    ".td-fld input,.td-fld select{min-height:40px;padding:0 10px;border:1px solid var(--line,#e8e3db);border-radius:9px;font:inherit;background:var(--panel,#fff);color:inherit}",
    ".td-hint{font-size:12px;color:var(--ink-3,#6b6577)}.td-inv{display:grid;grid-template-columns:1fr 150px;gap:8px}",
    "@media (max-width:480px){.td-inv{grid-template-columns:1fr}}",
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

  // QA B3 (pure, unit-tested): is this studio on its free trial? t = my_trial_status() (status / state 'trial', the
  // same rule trial-lock.js uses), else html.helm-trial. During the trial the sample data is FIXED: nothing here
  // offers to remove or clear it (the server refuses too, B12).
  function trialOn(t) {
    if (t && typeof t === "object" && ("state" in t || "status" in t)) return t.state === "trial" || t.status === "trial";
    try { return !!(doc && doc.documentElement && doc.documentElement.classList.contains("helm-trial")); } catch (e) { return false; }
  }
  // one message for the toasts (QA B3) and the cards (0236)
  const TRIAL_KEEP = "The sample data stays for your whole free trial. When you choose a plan you decide whether to keep it or remove it.";
  async function trialNow() {
    // a CONFIRMED trial class wins; the early (cached, unconfirmed) class asks the server, so a studio that just
    // paid is not refused while trial-lock.js is still checking (refuses if the server cannot be asked)
    const early = (() => { try { return !!(doc && doc.documentElement && doc.documentElement.classList.contains("helm-trial-early")); } catch (e) { return false; } })();
    if (trialOn(null) && !early) return true;
    try { const st = S(); if (st && st.subscription && st.subscription.trial) return trialOn(await st.subscription.trial()); } catch (e) {}
    return trialOn(null);
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
  async function clearDemo(then) {
    if (await trialNow()) { toast(TRIAL_KEEP, "info"); return false; }   // QA B3
    const ok = await confirmDlg("This removes only the sample rows marked “Demo ·” (events, leads, staff, vendors, items, packages, layout). Your own data is never touched. Demo venues are switched off, and a demo item one of your real events uses is kept.",
      { title: "Remove all demo data?", okLabel: "Remove demo data", danger: true });
    if (!ok) return false;
    try { await S().demo.clear(); toast("Demo data removed. Your own data is untouched."); }
    catch (e) { toast(errMsg(e, "remove the demo data"), "err"); return false; }
    if (then) global.location.assign(then); else global.location.reload();
    return true;
  }
  // 0166 — Control Center "Clear sample data" (admin; trial or converted studio; is_demo rows only)
  async function clearSample(b) {
    if (b && b.disabled) return false;
    if (await trialNow()) { toast(TRIAL_KEEP, "info"); return false; }   // QA B3
    const ok = await confirmDlg("This deletes only the sample rows marked \u201cDemo \u00b7\u201d in this studio (events, leads, staff, vendors, items, packages, layout). Anything you added yourself is never touched. A sample item one of your real events uses is switched off instead of deleted.",
      { title: "Clear sample data?", okLabel: "Clear sample data", danger: true });
    if (!ok) return false;
    const done = busy(b, "Clearing\u2026");
    try { await S().demo.clearSample(); toast("Sample data cleared. Your own data is untouched."); }
    catch (e) { done(); toast(errMsg(e, "clear the sample data"), "err", b); return false; }
    global.location.reload();
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
  // 0177: a free-trial studio never opens the full studio setup (/onboarding): it gets the short
  // 2-step welcome on the dashboard instead. After paying (checkout) the studio is no longer a trial.
  function nextAfterFresh(then) { return then === "checkout" ? "checkout.html?next=" + encodeURIComponent("onboarding.html?fresh=1") : "dashboard.html"; }
  // 0180: the welcome is a server-side flag (shows on any device). The browser flag ("again:<time>")
  // still asks for it on THIS device, e.g. a studio that already chose a plan (the server flag is trial-only).
  async function toWelcome() {
    try { const st = S(); if (st && st.trialOrg && st.trialOrg.welcomeAgain) await st.trialOrg.welcomeAgain(); } catch (e) {}
    try { global.localStorage.setItem("bp_trial_welcome", "again:" + String(Date.now())); } catch (e) {}
    global.location.assign("dashboard.html");
  }

  // One clear action: shows what goes (counts), what stays, then clear_demo_data() -> studio setup.
  // opts.then: "checkout" when opened from "Choose a plan".
  async function startFresh(opts) {
    opts = opts || {};
    if (await trialNow()) { toast(TRIAL_KEEP, "info"); return; }   // QA B3: no "Remove samples & set up my studio" in the trial
    let d = null;
    try { d = await S().demo.status(); } catch (e) {}
    if (d && d.has_demo === false) { global.location.assign(nextAfterFresh(opts.then)); return; }
    css();
    const dlg = el("dialog", "td-dlg");
    dlg.setAttribute("aria-labelledby", "tdDlgT");
    const h = el("h3", null, opts.then === "checkout" ? "Start fresh before you choose a plan?" : "Ready to start your own studio?"); h.id = "tdDlgT";
    dlg.appendChild(h);
    dlg.appendChild(el("p", null, opts.then === "checkout" ? "We'll remove only the sample rows marked “Demo ·”, then take you to choose a plan." : "We'll remove only the sample rows marked “Demo ·”, then you can name your studio and invite up to 2 people."));
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
      try { await S().demo.setMode("own"); toWelcome(); } catch (e) { done(); toast(errMsg(e, "keep the demo data"), "err", ev.currentTarget); } }));
    const go = btn("Remove samples & set up my studio", "btn primary danger", async () => {
      const done = busy(go, "Removing samples…");
      try { await S().demo.clear(); }
      catch (e) { done(); toast(errMsg(e, "remove the demo data"), "err", go); return; }
      toast("Sample data removed. Your own data is untouched.");
      if (opts.then === "checkout") global.location.assign(nextAfterFresh(opts.then)); else toWelcome();
    });
    row.appendChild(go);
    dlg.appendChild(row);
    dlg.addEventListener("cancel", close);
    doc.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
  }
  // 0185: once the plan is active, trial-upgrade.js (keep / remove sample / start clean) takes over
  async function openSwitch() {
    if (await trialNow()) { toast(TRIAL_KEEP, "info"); return; }   // QA B3
    try { if (global.HelmTrialUpgrade && typeof global.HelmTrialUpgrade.takeOver === "function" && await global.HelmTrialUpgrade.takeOver()) return; } catch (e) {}
    return startFresh({});
  }

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
  // inTrial (0180): the studio is ON its free trial -> no "Start my own studio" (the trial keeps the samples)
  function render(host, v, d, place, inTrial) {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!v) { host.hidden = true; return; }
    css(); host.hidden = false; host.classList.add("td");
    const admin = d && d.is_admin === true;
    // Trial terms: no "demo data or own data?" choice any more (every free trial runs on the sample data, 0180).
    // A trial studio whose sample data did not load yet only gets the one "Load the sample data" action.
    if (v === "choose") {
      host.appendChild(el("span", "td-tag", "Free trial"));
      host.appendChild(el("h3", null, "Load your sample studio"));
      host.appendChild(el("p", null, "Your free trial runs on ready-made sample data: leads, quotes in every stage, a confirmed wedding with an advance paid, venues, menu packages, inventory, staff, vendors, a finished floor layout and a checklist. Every sample record is marked “Demo ·”, and nothing is sent to anyone."));
      const pick = el("div", "td-pick");
      const a = el("button", "td-opt"); a.type = "button";
      a.appendChild(el("b", null, "Load the sample data"));
      a.appendChild(el("span", null, "Takes a few seconds. You can add up to 2 records of your own in each list."));
      a.addEventListener("click", () => seed(a));
      pick.appendChild(a); host.appendChild(pick);
      return;
    }
    if (v === "demo") {
      host.appendChild(el("span", "td-tag", "Sample data"));
      host.appendChild(el("h3", null, "You're exploring a demo studio"));
      host.appendChild(el("p", null, "Sample data: everything marked “Demo ·” is sample data. Messages, approval codes and payment links are switched off for it."));
      // 0236: the sample data stays for the whole free trial (the server refuses clear / reset / switch there);
      // what happens to it is chosen when the studio picks a plan (0185)
      if (admin && inTrial) { host.appendChild(el("p", "td-safe", TRIAL_KEEP)); return; }
      if (admin) {
        const row = el("div", "td-row");
        if (!inTrial) row.appendChild(btn("Start my own studio →", "btn primary", () => startFresh({})));
        const r = btn("Reset demo data", "btn", () => resetDemo(r)); row.appendChild(r);
        // QA B3: no "Clear sample data" during the trial (the sample data is fixed for the whole trial)
        if (place === "control" && !inTrial) { const c = btn("Clear sample data", "btn", () => clearSample(c)); row.appendChild(c); }
        host.appendChild(row);
      }
      return;
    }
    if (v === "leftover") {
      if (inTrial) { host.hidden = true; return; }   // QA B3: no remove / clear entry point during the trial
      host.appendChild(el("span", "td-tag", "Sample data"));
      host.appendChild(el("h3", null, "Demo data is still in your studio"));
      if (inTrial) { host.appendChild(el("p", "td-safe", TRIAL_KEEP)); return; }
      host.appendChild(el("p", null, "Remove the sample rows marked “Demo ·” when you no longer need them. Your own data is never touched."));
      const row = el("div", "td-row");
      if (place === "control") { const c = btn("Clear sample data", "btn", () => clearSample(c)); row.appendChild(c); }
      else row.appendChild(btn("Remove demo data", "btn", () => clearDemo()));
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
    mountWelcome();
    if (!dash && !ctl) return;
    const st = S(); if (!st || !st.demo || !st.subscription) return;
    try { if (st.init) await st.init(); } catch (e) {}
    let d = null, t = null;
    try { [d, t] = await Promise.all([st.demo.status(), st.subscription.trial().catch(() => null)]); } catch (e) { return; }
    if (!d) return;
    // 0185: not a trial any more (plan active) -> the trial-upgrade.js cards show the sample-data choices
    if (t && t.state === "none" && global.HelmTrialUpgrade) { if (dash) dash.hidden = true; if (ctl) ctl.hidden = true; return; }
    const v = view(d, t);
    // 0180: during the free trial the trial strip + the 2-step welcome are the whole trial UI: no
    // sample-data card on the dashboard and no "Start my own studio" (Control Center keeps Reset / Clear)
    // QA B3: the subscription's answer (status / state 'trial'), the same rule as trial-lock.js / html.helm-trial
    const inTrial = trialOn(t);
    if (dash) render(dash, inTrial && v === "demo" ? null : v, d, "dashboard", inTrial);
    if (ctl) { if (v === "demo" || v === "leftover") render(ctl, v, d, "control", inTrial); else renderControlEmpty(ctl, d, t); }
    try {
      const q = global.location.search || "";
      // 0180: "Choose a plan" goes straight to the plan page (an old link that still asks to remove the samples first, too)
      if (/[?&]demo=fresh\b/.test(q) && /[?&]then=checkout\b/.test(q)) { global.location.assign("checkout.html?next=dashboard.html"); return; }
      // QA B3 + 0236: dashboard.html?demo=switch is ignored during the trial (the server refuses it as well)
      if (!inTrial && d.is_admin && d.has_demo && /[?&]demo=(switch|fresh)\b/.test(q)) startFresh({});
    } catch (e) {}
  }

  /* ---- 0167: trial welcome (dashboard, right after a trial sign-up) ---------------------------------
     0207 Step 1 "Your 8-day free trial": the full trial terms (HelmTrialFacts, public/trial-facts.js -
     the same source as the sign-up box) + the required tick "I have read and agree to the free-trial
     terms, the Terms of Service and the Privacy Policy"; Continue stays disabled until it is ticked.
     accept_trial_terms records it (server-side, so on another device the welcome starts here again
     until it is agreed). Already agreed (e.g. on another device): the welcome starts at "Name".
     Step "Name your trial studio": name + city (default Hyderabad) + optional phone ->
     trial_welcome_setup (own trial studio only). The sample data is already there (seeded at sign-up).
     Step "Invite your team (up to 2)" (optional): email + role rows -> create_invitation (the
     server enforces the seat limit) + Skip. Then the guided tour. Paid "Create studio" never sees this.
     0180: whether it shows is decided by the SERVER (organizations.trial_welcome_pending, set when
     the trial starts, cleared when the welcome is finished), so it also shows when the e-mail confirm
     link is opened on another device, and never twice. Before 0180 is installed the browser flag
     set at sign-up (bp_trial_welcome) is used instead. The dashboard tour waits for this decision.
     0207: a trial owner who finished the welcome before the terms step existed gets the same terms once
     as a window ("Agree and continue"); an invited teammate gets a short read-only notice ("Got it", no
     agreement). Paid studios and ended (read-only) trials never see either. */
  const WKEY = "bp_trial_welcome";
  const TF = () => global.HelmTrialFacts || null;
  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) global.localStorage.removeItem(k); else global.localStorage.setItem(k, v); } catch (e) {} }
  // Pure (unit-tested): is the welcome due? a browser flag ("<time>" at sign-up, "again:<time>"), at most 2 days old
  function welcomeDue(flag, now) { const t = Number(String(flag == null ? "" : flag).replace(/^again:/, "")); return isFinite(t) && t > 0 && now - t >= 0 && now - t < 2 * 24 * 3600 * 1000; }
  // Pure (unit-tested): show the welcome? t = my_trial_org(), server = my_trial_welcome_pending()
  //   server true  -> yes (any device);  server false -> no, unless THIS browser just asked for it again
  //   ("again:" flag: start fresh / set up the studio); null (0180 not installed / unknown) -> the browser flag
  function welcomeShow(t, server, flag, now) {
    if (!t || typeof t !== "object" || t.is_trial_org !== true || t.is_admin !== true || t.ended === true || t.locked === true) return false;
    if (server === true) return true;
    if (server === false) return /^again:/.test(String(flag == null ? "" : flag)) && welcomeDue(flag, now);
    return welcomeDue(flag, now);
  }
  // 0207 (pure, unit-tested): which trial-terms window does this person get?
  //   t = my_trial_org(), terms = my_trial_terms_status() (null = 0207 not installed / unknown), welcome = welcomeShow(..)
  //   "welcome+terms" the welcome starts with "Your 8-day free trial" (not agreed yet; unknown -> still asked)
  //   "welcome"       the welcome without the terms step (already agreed, e.g. on another device)
  //   "terms"         no welcome, the owner has not agreed yet: the one-time "agree" window
  //   "notice"        an invited teammate: the short read-only notice, once
  //   null            nothing (paid studio, ended / read-only trial, client, already agreed / seen)
  function termsPlan(t, terms, welcome) {
    const known = !!(terms && typeof terms === "object");
    if (welcome === true) return known && terms.must_agree !== true ? "welcome" : "welcome+terms";
    if (!t || typeof t !== "object" || t.is_trial_org !== true || t.ended === true || t.locked === true) return null;
    if (!known || terms.trial !== true) return null;
    if (terms.must_agree === true) return "terms";
    if (terms.notice === true) return "notice";
    return null;
  }
  // Pure (unit-tested): the invite rows worth sending (valid-looking emails, max 2, no duplicates)
  function inviteRows(rows) {
    const out = [], seen = {};
    (rows || []).forEach(function (r) {
      const e = String((r && r.email) || "").trim().toLowerCase();
      if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || seen[e] || out.length >= 2) return;
      seen[e] = 1; out.push({ email: e, role: String((r && r.role) || "coordinator") });
    });
    return out;
  }
  // hold the tour back until the welcome is done (dashboard awaits welcomeDecision() before its tour)
  const onDash = /(^|\/)dashboard(\.html)?$/.test((global.location && global.location.pathname) || "");
  let welcomeOn = false, welcomeT = null, decided = null, plan = null;
  // 0207: the one-time terms window / teammate notice: the tour waits for it to close (termsGate())
  let gateOpen = null; const gate = new Promise((r) => { gateOpen = r; });
  // the one decision per page load (dashboard only): trial admin? then ask the server
  function welcomeDecision() {
    if (decided) return decided;
    decided = (async () => {
      if (!onDash) return false;
      const st = S(); if (!st || !st.trialOrg) return false;
      let t = null, server = null, terms = null;
      try { if (st.init) await st.init(); } catch (e) {}
      try { t = await st.trialOrg.status(); } catch (e) { t = null; }
      const asks = [];
      if (t && t.is_trial_org === true && t.is_admin === true && st.trialOrg.welcomePending) {
        asks.push(st.trialOrg.welcomePending().then((v) => { server = v; }, () => { server = null; }));   // network: fall back to the browser flag
      }
      // 0207: owner agreed? teammate saw the notice? (null = not installed / offline)
      if (t && t.is_trial_org === true && st.trialOrg.terms) asks.push(st.trialOrg.terms().then((v) => { terms = v; }, () => { terms = null; }));
      await Promise.all(asks);
      const on = welcomeShow(t, server, lsGet(WKEY), Date.now());
      plan = termsPlan(t, terms, on);
      // finished elsewhere (or not a trial admin): drop this browser's old sign-up flag; the tour flag stays
      if (!on) lsSet(WKEY, null); else lsSet("bp_tour_autorun", "1");
      welcomeOn = on; welcomeT = t;
      return on;
    })().then((on) => { if (plan !== "terms" && plan !== "notice") gateOpen(); return on; }, () => { gateOpen(); return false; });
    return decided;
  }
  // 0207: resolves once no trial-terms window is open any more (the dashboard tour waits for it)
  function termsGate() { return welcomeDecision().then(() => gate, () => undefined); }
  if (onDash) welcomeDecision();
  function field(id, label, type, value, hint) {
    const f = el("div", "td-fld"), l = el("label", null, label); l.htmlFor = id; f.appendChild(l);
    const i = el("input"); i.id = id; i.type = type || "text"; if (value) i.value = value; f.appendChild(i);
    if (hint) f.appendChild(el("span", "td-hint", hint));
    return { box: f, input: i };
  }
  async function finishWelcome(dlg) {
    // 0180: finished on this device = finished everywhere (a failure only means it may show once more)
    try { const st = S(); if (st && st.trialOrg && st.trialOrg.welcomeDone) await st.trialOrg.welcomeDone(); } catch (e) {}
    lsSet(WKEY, null); lsSet("bp_tour_autorun", null); lsSet("bp_force_tour", "1");
    finishDlg(dlg);
    global.location.replace("dashboard.html");
  }

  /* ---- 0207: the trial terms inside a dialog ------------------------------------------------------- */
  // dialog skeleton shared by the welcome, the one-time terms window and the teammate notice
  function shell(cls, titleId) {
    const dlg = el("dialog", "td-dlg " + cls); dlg.setAttribute("aria-labelledby", titleId);
    const head = el("div", "tdw-head"), tag = el("span", "td-tag"), h = el("h3"); h.id = titleId;
    const extra = el("div", "tdw-extra");
    head.appendChild(tag); head.appendChild(h); head.appendChild(extra);
    const body = el("div", "tdw-body"), foot = el("div", "tdw-foot");
    const err = el("p", "td-err"); err.setAttribute("role", "alert"); err.hidden = true;
    const row = el("div", "td-row");
    foot.appendChild(err); foot.appendChild(row);
    dlg.appendChild(head); dlg.appendChild(body); dlg.appendChild(foot);
    const empty = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
    return { dlg, tag, h, extra, body, foot, err, row, empty,
      showErr: (m) => { err.textContent = m || ""; err.hidden = !m; } };
  }
  // fills a shell with the full terms + the required tick; onTick(checked) enables the caller's button
  function termsInto(s, intro, onTick) {
    const F = TF();
    s.dlg.classList.add("tw-dlg");
    s.empty(s.extra); s.empty(s.body);
    s.h.textContent = "Your " + (F ? F.DAYS : 8) + "-day free trial";
    s.extra.appendChild(el("p", "tw-intro", intro));
    if (F) {
      const chips = el("ul", "tw-chips");
      [F.DAYS + " days free", "No card needed", "India · " + F.REGION.symbol + " · " + F.REGION.tz, "You + " + F.TEAM_EXTRA + " teammates"]
        .forEach((c) => chips.appendChild(el("li", null, c)));
      s.extra.appendChild(chips);
    }
    const scroll = el("div", "tw-scroll"); scroll.setAttribute("tabindex", "0"); scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Free-trial terms");
    if (F && F.panel) scroll.appendChild(F.panel(doc, s.h.id + "S"));
    else {   // trial-facts.js did not load: still ask, with the full terms one click away
      const p = el("p", "tw-lead", "Please read the free-trial terms before you continue: ");
      const a = el("a", null, "Terms of Service, section 4 (free trial)"); a.href = "/terms#trial"; a.target = "_blank"; a.rel = "noopener";
      p.appendChild(a); scroll.appendChild(p);
    }
    s.body.appendChild(scroll);
    let box, input;
    if (F && F.agreeBox) { const ab = F.agreeBox(doc, s.h.id + "Ok", onTick); box = ab.box; input = ab.input; }
    else {
      box = el("div", "tw-agree"); input = el("input"); input.type = "checkbox"; input.id = s.h.id + "Ok";
      const l = el("label", null, "I have read and agree to the free-trial terms, the Terms of Service and the Privacy Policy."); l.htmlFor = input.id;
      box.appendChild(input); box.appendChild(l);
      input.addEventListener("change", () => onTick(!!input.checked));
    }
    s.foot.insertBefore(box, s.err);
    return { scroll, box, input };
  }
  // the primary button that stays disabled until the tick (a polite live hint says why)
  function agreeButton(label, onClick) {
    const b = btn(label, "btn primary", onClick); b.disabled = true; b.setAttribute("aria-describedby", "twNeedTick");
    return b;
  }
  function needTick(on) {
    const n = el("span", "tw-need", on ? "" : "Tick the box above to continue."); n.id = "twNeedTick"; n.setAttribute("aria-live", "polite");
    return n;
  }
  async function recordTerms() {
    const st = S(), F = TF();
    if (!st || !st.trialOrg || !st.trialOrg.acceptTerms) return null;
    return st.trialOrg.acceptTerms(F ? F.VERSION : "");
  }
  function openDlg(dlg, focusEl) {
    doc.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    try { if (focusEl) focusEl.focus(); } catch (e) {}
  }
  // a required window: Esc is refused (cancel), and if the browser closes it anyway (Chrome lets Esc through
  // when the page has had no click yet) it opens again until finishDlg(dlg) marked it finished
  function keepOpen(dlg) {
    dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); });
    dlg.addEventListener("close", () => {
      if (dlg.getAttribute("data-done") === "1" || !dlg.parentNode) return;
      try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    });
  }
  function finishDlg(dlg) { dlg.setAttribute("data-done", "1"); try { dlg.close(); } catch (e) {} dlg.remove(); }

  // the one-time "agree" window: a trial that finished the welcome before the terms step existed
  function mountTermsOnly() {
    css();
    const s = shell("td-welcome", "tdTT");
    s.tag.textContent = "Free-trial terms";
    let ok = null;
    const hint = needTick(false);
    const go = agreeButton("Agree and continue", async () => {
      if (!ok || !ok.input.checked) { s.showErr("Tick the box to agree to the free-trial terms."); return; }
      s.showErr(""); const done = busy(go, "Saving…");
      try { await recordTerms(); }
      catch (e) { done(); go.disabled = !ok.input.checked; s.showErr(errMsg(e, "save your agreement")); return; }
      finishDlg(s.dlg);
      toast("Thanks — enjoy your free trial.");
      gateOpen();
    });
    ok = termsInto(s, "Before you continue, please read exactly how the free trial works and tick “I agree”. You only need to do this once.",
      (on) => { go.disabled = !on; hint.textContent = on ? "" : "Tick the box above to continue."; });
    s.row.appendChild(hint); s.row.appendChild(go);
    keepOpen(s.dlg);   // agreeing is required: Esc does not close it
    openDlg(s.dlg, ok.scroll);
  }
  // the teammate notice: read-only, no agreement; "Got it" (or Esc) records that it was seen
  function mountNotice(t) {
    css();
    const F = TF(), s = shell("td-welcome tw-note", "tdTN");
    s.tag.textContent = "Free trial";
    s.h.textContent = "You’re in a free-trial studio";
    let end = "";
    try { if (t && t.ends_at) end = new Date(t.ends_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: (t && t.timezone) || "Asia/Kolkata" }); } catch (e) { end = ""; }
    s.extra.appendChild(el("p", "tw-intro", ((t && t.name) ? "“" + t.name + "”" : "This studio") + " is trying Helm" + (end ? " until " + end : "") + ". A few things work differently during the trial:"));
    if (F && F.notice) s.body.appendChild(F.notice(doc));
    let closed = false;
    const close = async () => {
      if (closed) return; closed = true;
      try { await recordTerms(); } catch (e) {}   // only means the notice may show once more
      finishDlg(s.dlg);
      gateOpen();
    };
    const b = btn("Got it", "btn primary", close); s.row.appendChild(b);
    s.dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
    s.dlg.addEventListener("close", () => { close(); });   // closed by the browser itself: same as "Got it"
    openDlg(s.dlg, b);
  }

  let welcomeMounted = false;
  async function mountWelcome() {
    if (welcomeMounted) return;
    const on = await welcomeDecision();
    if (welcomeMounted) return;
    if (!on) {   // 0207: no welcome; maybe the one-time terms window / the teammate notice
      if (plan === "terms") { welcomeMounted = true; mountTermsOnly(); }
      else if (plan === "notice") { welcomeMounted = true; mountNotice(welcomeT); }
      return;   // otherwise: the dashboard tour runs as usual
    }
    welcomeMounted = true;
    const st = S(), t = welcomeT;
    const withTerms = plan !== "welcome";   // "welcome+terms": Step 1 is "Your 8-day free trial"
    const total = withTerms ? 3 : 2;
    css();
    const s = shell("td-welcome", "tdWT"), dlg = s.dlg, body = s.body, row = s.row, h = s.h, step = s.tag, showErr = s.showErr;
    // step: the free-trial terms + "I agree" (0207)
    function stepTerms() {
      step.textContent = "Step 1 of " + total;
      let ok = null;
      const hint = needTick(false);
      const next = agreeButton("Agree and continue", async () => {
        if (!ok || !ok.input.checked) { showErr("Tick the box to agree to the free-trial terms."); return; }
        showErr(""); const done = busy(next, "Saving…");
        try { await recordTerms(); }
        catch (e) { done(); next.disabled = !ok.input.checked; showErr(errMsg(e, "save your agreement")); return; }
        if (ok.box && ok.box.remove) ok.box.remove();
        stepName();
      });
      ok = termsInto(s, "Here is exactly how your free trial works. Please read it and tick “I agree” to enter your studio.",
        (v) => { next.disabled = !v; hint.textContent = v ? "" : "Tick the box above to continue."; });
      row.appendChild(hint); row.appendChild(next);
      return ok.scroll;
    }
    // step: name the studio
    function stepName() {
      dlg.classList.remove("tw-dlg");
      s.empty(s.extra); s.empty(body); s.empty(row); showErr("");
      step.textContent = "Step " + (withTerms ? 2 : 1) + " of " + total; h.textContent = "Name your trial studio";
      body.appendChild(el("p", null, t.trial_mode === "own" ? "Give your trial studio your name — you can change it later." : "Your sample studio is loading with events, leads, menus, staff and inventory. Give it your name — you can change it later."));
      const fn = field("tdw_name", "Studio name", "text", /^Demo [0-9]+$/.test(t.name || "") ? "" : (t.name || ""));
      fn.input.required = true; fn.input.maxLength = 120; fn.input.autocomplete = "organization";
      const fc = field("tdw_city", "City", "text", "Hyderabad"); fc.input.maxLength = 120;
      const fp = field("tdw_phone", "Phone (optional)", "tel", "", "Shown on your quotes. Leave empty if you like."); fp.input.maxLength = 40;
      [fn, fc, fp].forEach((x) => body.appendChild(x.box));
      const next = btn("Continue", "btn primary", async () => {
        const name = fn.input.value.trim();
        if (name.length < 2) { showErr("Enter your studio name (at least 2 characters)."); fn.input.focus(); return; }
        showErr(""); const done = busy(next, "Saving…");
        try { await st.trialOrg.welcome(name, fc.input.value, fp.input.value); }
        catch (e) { done(); showErr(errMsg(e, "save the studio name")); return; }
        step2();
      });
      row.appendChild(next);
      try { fn.input.focus(); } catch (e) {}
      return fn.input;
    }
    function step2() {
      step.textContent = "Step " + total + " of " + total + " (optional)"; h.textContent = "Invite your team (up to 2)";
      s.empty(body); s.empty(row);
      showErr("");
      body.appendChild(el("p", null, "Your free trial includes you + 2 people. They get an email with a join link. You can also do this later in Control Center → Users & invites."));
      const roles = (st.auth && st.auth.admin && st.auth.admin.roles) ? st.auth.admin.roles().filter((r) => r !== "client") : ["manager", "coordinator", "sales"];
      const lines = [];
      for (let n = 1; n <= 2; n++) {
        const line = el("div", "td-inv");
        const e = field("tdw_e" + n, "Email " + n, "email", ""); e.input.autocomplete = "off";
        const rf = el("div", "td-fld"), rl = el("label", null, "Role"); rl.htmlFor = "tdw_r" + n; rf.appendChild(rl);
        const sel = el("select"); sel.id = "tdw_r" + n;
        roles.forEach((r) => { const o = el("option", null, st.auth.admin.roleLabel ? st.auth.admin.roleLabel(r) : r); o.value = r; if (r === "coordinator") o.selected = true; sel.appendChild(o); });
        rf.appendChild(sel); line.appendChild(e.box); line.appendChild(rf); body.appendChild(line);
        lines.push({ e: e.input, r: sel });
      }
      row.appendChild(btn("Skip", "btn", () => finishWelcome(dlg)));
      const send = btn("Send invites", "btn primary", async () => {
        const list = inviteRows(lines.map((x) => ({ email: x.e.value, role: x.r.value })));
        if (!list.length) { showErr("Enter at least one email — or press Skip."); lines[0].e.focus(); return; }
        showErr(""); const done = busy(send, "Sending…");
        for (const it of list) {
          try { await st.invitations.create(it.email, it.role); }
          catch (e) { done(); showErr(errMsg(e, "invite " + it.email)); return; }
        }
        try { await st.invitations.sendNow(); } catch (e) {}
        toast(list.length === 1 ? "Invite sent." : "Invites sent.");
        finishWelcome(dlg);
      });
      row.appendChild(send);
      lines[0].e.focus();
    }
    keepOpen(dlg);   // finish or skip, never lost by Esc
    const first = withTerms ? stepTerms() : null;
    openDlg(dlg, first);
    if (!withTerms) stepName();
  }

  global.HelmTrialDemo = { welcomeDue: welcomeDue, welcomeShow: welcomeShow, welcomeDecision: welcomeDecision, termsPlan: termsPlan, termsGate: termsGate, inviteRows: inviteRows, view: view, trialOn: trialOn, openSwitch: openSwitch, startFresh: startFresh, countLines: countLines, nextAfterFresh: nextAfterFresh, mount: mount,
    get welcomeOn() { return welcomeOn; } };
  if (doc) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount); else mount(); }
})(typeof window !== "undefined" ? window : globalThis);
