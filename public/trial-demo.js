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
  const TRIAL_KEEP = "Your free trial keeps its sample data for the whole trial. Choose a plan to start your own studio.";
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
      // QA B3: dashboard.html?demo=switch is ignored during the trial (startFresh refuses as well)
      if (d.is_admin && d.has_demo && !inTrial && /[?&]demo=(switch|fresh)\b/.test(q)) startFresh({});
    } catch (e) {}
  }

  /* ---- 0167: 2-step trial welcome (dashboard, right after a trial sign-up) ------------------------
     Step 1 "Name your trial studio": name + city (default Hyderabad) + optional phone ->
     trial_welcome_setup (own trial studio only). The sample data is already there (seeded at sign-up).
     Step 2 (optional) "Invite your team (up to 2)": email + role rows -> create_invitation (the
     server enforces the seat limit) + Skip. Then the guided tour. Paid "Create studio" never sees this.
     0180: whether it shows is decided by the SERVER (organizations.trial_welcome_pending, set when
     the trial starts, cleared when the welcome is finished), so it also shows when the e-mail confirm
     link is opened on another device, and never twice. Before 0180 is installed the browser flag
     set at sign-up (bp_trial_welcome) is used instead. The dashboard tour waits for this decision. */
  const WKEY = "bp_trial_welcome";
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
  let welcomeOn = false, welcomeT = null, decided = null;
  // the one decision per page load (dashboard only): trial admin? then ask the server
  function welcomeDecision() {
    if (decided) return decided;
    decided = (async () => {
      if (!onDash) return false;
      const st = S(); if (!st || !st.trialOrg) return false;
      let t = null, server = null;
      try { if (st.init) await st.init(); } catch (e) {}
      try { t = await st.trialOrg.status(); } catch (e) { t = null; }
      if (t && t.is_trial_org === true && t.is_admin === true && st.trialOrg.welcomePending) {
        try { server = await st.trialOrg.welcomePending(); } catch (e) { server = null; }   // network: fall back to the browser flag
      }
      const on = welcomeShow(t, server, lsGet(WKEY), Date.now());
      // finished elsewhere (or not a trial admin): drop this browser's old sign-up flag; the tour flag stays
      if (!on) lsSet(WKEY, null); else lsSet("bp_tour_autorun", "1");
      welcomeOn = on; welcomeT = t;
      return on;
    })().catch(() => false);
    return decided;
  }
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
    try { dlg.close(); } catch (e) {} dlg.remove();
    global.location.replace("dashboard.html");
  }
  let welcomeMounted = false;
  async function mountWelcome() {
    if (welcomeMounted || !(await welcomeDecision())) return;   // not shown: the dashboard tour runs as usual
    welcomeMounted = true;
    const st = S(), t = welcomeT;
    css();
    const dlg = el("dialog", "td-dlg td-welcome"); dlg.setAttribute("aria-labelledby", "tdWT");
    const step = el("span", "td-tag", "Step 1 of 2"); dlg.appendChild(step);
    const h = el("h3", null, "Name your trial studio"); h.id = "tdWT"; dlg.appendChild(h);
    const body = el("div"); dlg.appendChild(body);
    const err = el("p", "td-err"); err.setAttribute("role", "alert"); err.hidden = true; dlg.appendChild(err);
    const row = el("div", "td-row"); dlg.appendChild(row);
    const showErr = (m) => { err.textContent = m; err.hidden = !m; };
    // step 1
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
    function step2() {
      step.textContent = "Step 2 of 2 (optional)"; h.textContent = "Invite your team (up to 2)";
      while (body.firstChild) body.removeChild(body.firstChild);
      while (row.firstChild) row.removeChild(row.firstChild);
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
    dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); });   // finish or skip, never lost by Esc
    doc.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    fn.input.focus();
  }

  global.HelmTrialDemo = { welcomeDue: welcomeDue, welcomeShow: welcomeShow, welcomeDecision: welcomeDecision, inviteRows: inviteRows, view: view, trialOn: trialOn, openSwitch: openSwitch, startFresh: startFresh, countLines: countLines, nextAfterFresh: nextAfterFresh, mount: mount,
    get welcomeOn() { return welcomeOn; } };
  if (doc) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount); else mount(); }
})(typeof window !== "undefined" ? window : globalThis);
