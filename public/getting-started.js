/* =========================================================================
   HELM — dashboard "Getting started" checklist (0059)
   -------------------------------------------------------------------------
   • Steps come from my_getting_started(): yes/no flags worked out on the
     server from the studio's real data (no manual ticks). Admins get 8 steps,
     other roles a shorter list that matches their access.
   • Progress ring + "X of N done", collapsible (remembered on this browser),
     "Dismiss checklist" (stored on the server, per member), celebratory state
     when every required step is done.
   • A one-time tour hint points at the card (reuses tour.js).
   • FREE TRIAL (Oct 2026): a short, different list (trialData): explore a sample
     event, open the 2D/3D builder on a sample layout, send a quote (e-mail works in the trial),
     invite a teammate (you + 2), choose a plan. Nothing the trial hides (studio
     set-up, branding, import, notifications...) is ever listed. Opening an event
     page / the builder ticks itself (trial-lock.js -> auth.markTrialStep); the
     trial's "dismissed" lives on the account (auth user_metadata.helm_trial_gs),
     so hiding the trial list never hides the paid list after upgrading.
   • Paid list: lead / floor plan / quote tick from the studio's OWN rows
     (store.gettingStarted.ownFacts) - sample rows never count, and a quote's floor
     plan (saved as a quote version) counts.
   • When every required step is done the card celebrates once, then is hidden for
     good (same per-account dismissal as "Dismiss checklist").
   • CSP: no inline style attributes, runtime CSS via window.__helmAdoptCss;
     every interpolated value goes through esc().
   ========================================================================= */
(function (global) {
  "use strict";

  // key → presentation + where "Start" goes. `act` = open the account panel instead.
  const STEPS = {
    profile:    { icon: "👤", title: "Complete your profile", why: "Add your name and mobile so your team knows who you are and can reach you.", href: "profile-setup.html", act: "profile" },
    studio:     { icon: "🏢", title: "Add your Helm billing details", why: "Your legal name and billing address go on the invoices Helm sends you.", href: "control.html#account" },
    pricing:    { icon: "💲", title: "Set your prices", why: "New quotes use your default rates and menu packages automatically.", href: "control.html#pricing" },
    lead:       { icon: "📥", title: "Add your first lead", why: "Log each enquiry so you can follow it up and turn it into an event.", href: "leads.html" },
    floor_plan: { icon: "📐", title: "Design your first floor plan", why: "Plan the hall layout. The chairs you place are added to the quote.", href: "quotes.html?new=1&open=builder" },
    quote:      { icon: "📨", title: "Send your first quote", why: "Send the client an approval link they can approve and pay from.", href: "quotes.html?new=1" },
    team:       { icon: "👥", title: "Invite your team", why: "Add your staff and choose what each role can see and edit. Helm e-mails each invite for you.", href: "control.html#users" },
    // 0134 (client-side, optional, admins): WhatsApp for task assignments + event reminders
    whatsapp:   { icon: "💬", title: "Connect WhatsApp", why: "Save your studio WhatsApp number and send a test. Then task assignments and event reminders reach your crew on WhatsApp.", href: "integrations.html#whatsapp" },
    // 0096 (client-side, optional): the studio has saved at least one layout template of its own
    my_templates: { icon: "🧩", title: "Customize your own templates", why: "Save your own floor layouts so every new event starts from your studio's style.", href: "builder.html?new=1&tplEdit=new" },
    mfa:        { icon: "🔐", title: "Turn on two-step sign-in", why: "A code at sign-in protects your studio even if a password leaks.", href: "", act: "mfa" },
    // FREE TRIAL list (trialData). href of t_event / t_builder is set per studio (a sample event with a floor plan).
    t_event:    { icon: "📅", title: "Explore a sample event", why: "Open a sample event to see its plan, payments, tasks and run sheet in one place.", href: "quotes.html", trial: true, mark: "event" },
    t_builder:  { icon: "📐", title: "Open the 2D/3D layout builder", why: "Open a sample floor plan, move things around and switch between 2D and 3D.", href: "builder.html?new=1", trial: true, mark: "builder" },
    t_quote:    { icon: "📨", title: "Send a quote to a client", why: "Make a quote and e-mail it: it really reaches your client in the trial. Or approve it yourself in Test mode.", href: "quotes.html?new=1", trial: true },
    t_team:     { icon: "👥", title: "Invite a teammate", why: "Your trial includes you + 2 people. Send a join link from Users & invites.", href: "control.html#users", trial: true },
    t_plan:     { icon: "⭐", title: "Choose a plan", why: "Pick a plan before your trial ends to keep your studio and everything in it.", href: "control.html#billing", trial: true },
  };
  // a per-studio Start link may only be one of the app's own pages (never another site / scheme)
  const SAFE_HREF = /^[a-z0-9-]+\.html(\?[A-Za-z0-9_=&%.-]*)?(#[A-Za-z0-9_-]*)?$/;
  const COLLAPSE_KEY = "bp_gs_collapsed";
  const HINT_KEY = "bp_seen_gs_hint";
  const RING_R = 22, RING_C = 2 * Math.PI * RING_R;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return global.localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { if (v == null) global.localStorage.removeItem(k); else global.localStorage.setItem(k, v); } catch (e) {} };

  /* ---- pure model (exported for tests) ---------------------------------- */
  function model(data) {
    if (!data || !Array.isArray(data.steps)) return null;
    // two-step sign-in is optional for every role and only admins are reminded about it: other roles
    // turn it on from Account settings themselves, so the checklist never nudges them (owner, Oct 2026)
    const steps = data.steps
      .filter((s) => s && Object.prototype.hasOwnProperty.call(STEPS, s.key))
      .filter((s) => s.key !== "mfa" || data.admin === true)
      .filter((s) => data.trial === true ? STEPS[s.key].trial === true : STEPS[s.key].trial !== true)
      .map((s) => Object.assign({ key: s.key, done: s.done === true, optional: s.optional === true }, STEPS[s.key],
        typeof s.href === "string" && SAFE_HREF.test(s.href) ? { href: s.href } : {}));
    if (!steps.length) return null;
    const done = steps.filter((s) => s.done).length;
    const required = steps.filter((s) => !s.optional);
    const complete = required.length > 0 && required.every((s) => s.done);
    return { steps, done, total: steps.length, complete, admin: data.admin === true, dismissed: data.dismissed === true, trial: data.trial === true,
      pct: Math.round((done / steps.length) * 100), next: steps.find((s) => !s.done) || null };
  }
  // FREE TRIAL checklist from: server = my_getting_started() (who may do what, "team" done),
  // facts = store.gettingStarted.trialFacts(), flags = auth.trialSteps(), t = my_trial_status().
  // An ended trial only offers "Choose a plan" (the studio is read-only until a plan is paid).
  function trialData(server, facts, flags, t) {
    const sv = server && Array.isArray(server.steps) ? server.steps : [];
    const has = (k) => sv.some((s) => s && s.key === k);
    const doneOf = (k) => sv.some((s) => s && s.key === k && s.done === true);
    const admin = !!(server && server.admin === true), f = facts || {}, fl = flags || {};
    const ended = !!(t && t.state === "ended");
    const steps = [];
    if (!ended) {
      steps.push({ key: "t_event", done: fl.event === true, href: f.eventId ? "event.html?id=" + encodeURIComponent(f.eventId) : undefined });
      steps.push({ key: "t_builder", done: fl.builder === true, href: f.layoutQuoteId ? "builder.html?quote=" + encodeURIComponent(f.layoutQuoteId) : undefined });
      if (has("quote")) steps.push({ key: "t_quote", done: f.ownQuoteSent === true });
      if (has("team")) steps.push({ key: "t_team", done: doneOf("team") });
    }
    if (admin) steps.push({ key: "t_plan", done: false });
    return { admin, trial: true, dismissed: fl.dismissed === true, steps };
  }
  // paid list: the studio's OWN rows decide lead / floor plan / quote (null facts = keep the server flags)
  function applyOwnFacts(data, facts) {
    if (!data || !Array.isArray(data.steps) || !facts) return data;
    const map = { lead: facts.lead, floor_plan: facts.floorPlan, quote: facts.quoteSent };
    data.steps.forEach((s) => { if (s && Object.prototype.hasOwnProperty.call(map, s.key) && typeof map[s.key] === "boolean") s.done = map[s.key]; });
    return data;
  }
  // stroke-dashoffset for the ring (number only — goes into an SVG attribute)
  const ringOffset = (pct) => +(RING_C * (1 - Math.max(0, Math.min(100, Number(pct) || 0)) / 100)).toFixed(2);

  function gsMarkup(m, collapsed) {
    const ring = `<svg class="gs-ring" viewBox="0 0 52 52" width="52" height="52" aria-hidden="true" focusable="false">`
      + `<circle class="gs-ring-bg" cx="26" cy="26" r="${RING_R}" fill="none" stroke-width="5"></circle>`
      + `<circle class="gs-ring-fg" cx="26" cy="26" r="${RING_R}" fill="none" stroke-width="5" stroke-linecap="round" transform="rotate(-90 26 26)"`
      + ` stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${ringOffset(m.pct)}"></circle>`
      + `<text x="26" y="30" text-anchor="middle" class="gs-ring-txt">${Number(m.done)}/${Number(m.total)}</text></svg>`;
    const head = m.complete
      ? (m.trial ? `<h3 id="gsTitle">🎉 You've tried the main parts of Helm</h3><p class="gs-sub">${Number(m.done)} of ${Number(m.total)} done. Keep exploring the sample data.</p>`
        : `<h3 id="gsTitle">🎉 You're all set up</h3><p class="gs-sub">${Number(m.done)} of ${Number(m.total)} done. Your studio is ready for its first event.</p>`)
      : `<h3 id="gsTitle">${m.trial ? "Try Helm in a few steps" : "Getting started"}</h3><p class="gs-sub"><b>${Number(m.done)} of ${Number(m.total)} done</b>${m.next ? " · Next: " + esc(m.next.title) : ""}</p>`;
    const items = m.steps.map((s) => `<li class="gs-item${s.done ? " done" : ""}">`
      + `<span class="gs-ico" aria-hidden="true">${s.done ? "✓" : esc(s.icon)}</span>`
      + `<span class="gs-txt"><span class="gs-t">${esc(s.title)}${s.optional ? ' <span class="gs-opt">Optional</span>' : ""}</span>`
      + `<span class="gs-why">${esc(s.why)}</span></span>`
      + (s.done ? `<span class="gs-done">Done<span class="sr-only"> — ${esc(s.title)}</span></span>`
        : (s.act ? `<button type="button" class="gs-go" data-act="${esc(s.act)}" data-href="${esc(s.href)}">Start<span class="sr-only"> — ${esc(s.title)}</span></button>`
          : `<a class="gs-go" href="${esc(s.href)}"${s.mark ? ` data-mark="${esc(s.mark)}"` : ""}>${s.mark ? "Open" : "Start"}<span class="sr-only"> — ${esc(s.title)}</span></a>`))
      + `</li>`).join("");
    return `<div class="gs-head${m.complete ? " gs-win" : ""}">${ring}<div class="gs-hd">${head}</div>`
      + `<button type="button" class="gs-tog" id="gsToggle" aria-expanded="${collapsed ? "false" : "true"}" aria-controls="gsBody">`
      + `<span class="sr-only">${collapsed ? "Show" : "Hide"} steps</span><span aria-hidden="true" class="gs-chev">▾</span></button></div>`
      + `<div id="gsBody" class="gs-body"${collapsed ? " hidden" : ""}>`
      + (m.complete ? `<div class="gs-confetti" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>` : "")
      + `<ol class="gs-list">${items}</ol>`
      + `<div class="gs-foot"><button type="button" class="gs-dismiss" id="gsDismiss">${m.complete ? "Hide checklist" : "Dismiss checklist"}</button></div></div>`;
  }

  /* ---- styles ----------------------------------------------------------- */
  const CSS = [
    ".gs{background:var(--panel,#fff);border:1px solid var(--line,#e8e3db);border-radius:16px;box-shadow:var(--shadow);padding:16px 18px;margin:16px 0 4px;color:var(--ink,#1b1930)}",
    ".gs-head{display:flex;align-items:center;gap:14px}",
    ".gs-hd{flex:1;min-width:0}.gs-hd h3{margin:0;font-size:16px;font-weight:700;letter-spacing:-.01em}",
    ".gs-sub{margin:3px 0 0;font-size:13px;color:var(--ink-2,#4b475f)}",
    ".gs-ring{flex:0 0 auto}.gs-ring-bg{stroke:var(--line,#e8e3db)}.gs-ring-fg{stroke:var(--accent,#047857);transition:stroke-dashoffset .6s ease}",
    ".gs-win .gs-ring-fg{stroke:var(--safe,#12a150)}.gs-ring-txt{font:700 12px var(--font,system-ui);fill:var(--ink,#1b1930)}",
    ".gs-tog{flex:0 0 auto;width:36px;height:36px;border-radius:10px;border:1px solid var(--line,#e8e3db);background:var(--panel-2,#faf8f5);color:var(--ink-2,#4b475f);cursor:pointer;font-size:16px;line-height:1}",
    ".gs-tog[aria-expanded=false] .gs-chev{display:inline-block;transform:rotate(-90deg)}",
    ".gs-tog:focus-visible,.gs-go:focus-visible,.gs-dismiss:focus-visible{outline:2px solid var(--accent,#047857);outline-offset:2px}",
    ".gs-body{position:relative;margin-top:12px}",
    ".gs-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px}",
    ".gs-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--line-2,#f1ede7);border-radius:12px;background:var(--panel-2,#faf8f5);min-width:0}",
    ".gs-ico{flex:0 0 auto;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:17px;background:var(--accent-soft,#e3f4ed)}",
    ".gs-item.done .gs-ico{background:var(--safe,#12a150);color:#fff;font-weight:700;font-size:15px}",
    "html[data-theme=dark] .gs-item.done .gs-ico{color:#062b1a}",
    ".gs-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
    ".gs-t{font-size:13.5px;font-weight:600}.gs-item.done .gs-t{color:var(--ink-3,#6b6577);text-decoration:line-through;text-decoration-thickness:1px}",
    ".gs-why{font-size:12px;color:var(--ink-3,#6b6577);line-height:1.35}",
    ".gs-opt{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3,#6b6577);border:1px solid var(--line,#e8e3db);border-radius:6px;padding:0 5px;margin-left:4px;text-decoration:none;display:inline-block}",
    ".gs-go{flex:0 0 auto;font:600 12.5px var(--font,system-ui);padding:7px 13px;border-radius:9px;border:0;cursor:pointer;color:#fff;background:linear-gradient(120deg,var(--accent,#047857),var(--accent-2,#036b4d));text-decoration:none;white-space:nowrap}",
    "html[data-theme=dark] .gs-go{background:linear-gradient(120deg,#047857,#047857)}",
    ".gs-done{flex:0 0 auto;font-size:12px;font-weight:600;color:var(--safe-text,#0f7a43)}",
    ".gs-foot{display:flex;justify-content:flex-end;margin-top:10px}",
    ".gs-dismiss{background:none;border:0;padding:6px 4px;font:500 12.5px var(--font,system-ui);color:var(--ink-3,#6b6577);text-decoration:underline;text-underline-offset:3px;cursor:pointer}",
    ".gs-dismiss:hover{color:var(--ink,#1b1930)}",
    ".gs-win{position:relative}",
    ".gs-confetti{position:absolute;inset:-12px 0 auto;height:0;pointer-events:none}",
    ".gs-confetti i{position:absolute;top:0;width:7px;height:11px;border-radius:2px;opacity:0;animation:gsFall 1.6s ease-out .1s 2 forwards}",
    ".gs-confetti i:nth-child(1){left:6%;background:#f59e0b}.gs-confetti i:nth-child(2){left:18%;background:#047857;animation-delay:.25s}",
    ".gs-confetti i:nth-child(3){left:31%;background:#12a150;animation-delay:.05s}.gs-confetti i:nth-child(4){left:44%;background:#ec4899;animation-delay:.35s}",
    ".gs-confetti i:nth-child(5){left:57%;background:#036b4d;animation-delay:.15s}.gs-confetti i:nth-child(6){left:69%;background:#f59e0b;animation-delay:.4s}",
    ".gs-confetti i:nth-child(7){left:82%;background:#12a150;animation-delay:.2s}.gs-confetti i:nth-child(8){left:93%;background:#047857;animation-delay:.3s}",
    "@keyframes gsFall{0%{opacity:1;transform:translateY(0) rotate(0)}100%{opacity:0;transform:translateY(90px) rotate(260deg)}}",
    "@media (prefers-reduced-motion:reduce){.gs-confetti{display:none}.gs-ring-fg{transition:none}}",
    "@media (max-width:720px){.gs-list{grid-template-columns:1fr}}",
    "@media (max-width:420px){.gs{padding:14px 12px;border-radius:14px}.gs-head{gap:10px}.gs-item{padding:9px 10px;gap:9px}.gs-why{font-size:11.5px}}",
  ].join("\n");
  let cssDone = false;
  function css() {
    if (cssDone) return; cssDone = true;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(global.document, CSS);
  }

  /* ---- mount -------------------------------------------------------------- */
  // "profile" -> the profile part; "mfa" -> Account settings scrolled to two-step sign-in (it used to open the
  // whole panel at the top, so the two-step section was off-screen)
  function accountOpts(focus) {
    return focus === "profile" ? { focus: "profile" } : focus === "mfa" ? { section: "settings", focus: "mfa" } : {};
  }
  function openAccount(focus) {
    const ui = global.HelmAuthUI;
    if (ui && typeof ui.openAccount === "function") { ui.openAccount(accountOpts(focus)); return true; }
    return false;
  }

  function maybeHint(card) {
    // One-time pointer to the checklist — only after the main dashboard tour was seen,
    // so the two never overlap. tour.js marks HINT_KEY when the hint closes.
    // R4: "seen" lives on the ACCOUNT (auth user_metadata) so the hint never re-appears on
    // a new device; localStorage is only a fast local cache of it.
    if (!global.HelmTour || lsGet("bp_force_tour")) return;
    const auth = global.BPStore && global.BPStore.auth;
    const acctSeen = auth && typeof auth.gsHintSeen === "function" ? auth.gsHintSeen() : null;
    if (acctSeen === true) { lsSet(HINT_KEY, "1"); return; }
    if (lsGet(HINT_KEY)) { if (acctSeen === false && auth.markGsHintSeen) auth.markGsHintSeen(); return; }
    const tourSeen = lsGet("bp_seen_tour") || (auth && typeof auth.tourSeen === "function" && auth.tourSeen() === true);
    if (!tourSeen) return;
    if (global.document.querySelector(".htour")) return;
    setTimeout(() => {
      if (card.hidden || global.document.querySelector(".htour")) return;
      if (auth && typeof auth.markGsHintSeen === "function") auth.markGsHintSeen();
      const trial = card.getAttribute("data-gs-mode") === "trial";
      global.HelmTour.start([{ sel: "#gsCard", title: trial ? "Your free-trial checklist" : "Your getting-started checklist",
        desc: (trial ? "Try these steps to see what Helm can do with the sample data." : "Work through these steps to set up your studio.")
          + " Each one ticks itself off as you do it, and you can collapse or dismiss the list any time." }], HINT_KEY);
    }, 700);
  }

  // 0096: optional "Customize your own templates" step, worked out here (no server change); skipped when unavailable
  async function addTemplatesStep(data, store) {
    if (!data || !Array.isArray(data.steps) || !store.layoutTemplates || data.steps.some((s) => s && s.key === "my_templates")) return;
    let n; try { n = ((await store.layoutTemplates.list({ lite: true })) || []).length; } catch (e) { return; }
    const i = data.steps.findIndex((s) => s && s.key === "floor_plan");
    const step = { key: "my_templates", done: n > 0, optional: true };
    if (i >= 0) data.steps.splice(i + 1, 0, step); else data.steps.push(step);
  }
  // 0134: optional "Connect WhatsApp" step for admins (no server change to my_getting_started);
  // done = studio WhatsApp number saved (0150). Skipped when unavailable.
  async function addWhatsappStep(data, store) {
    // hidden while HELM_FEATURES.integrationsPage is off (MVP/trial: Helm's own e-mail + WhatsApp are used)
    if (!(global.HELM_FEATURES && global.HELM_FEATURES.integrationsPage === true)) return;
    if (!data || !Array.isArray(data.steps) || data.admin !== true || !store.integrations || data.steps.some((s) => s && s.key === "whatsapp")) return;
    let ov = null; try { ov = await store.integrations.overview(); } catch (e) { ov = null; }
    // 0150: done once the studio has saved its WhatsApp number (the studio's part). Switching the
    // channel Live is Helm's job, and liveChannels.whatsapp stays false by CI rule, so it never gates this.
    const done = !!(ov && /^[0-9]{8,15}$/.test(String(ov.studio_whatsapp || "")));
    const i = data.steps.findIndex((s) => s && s.key === "team");
    const step = { key: "whatsapp", done, optional: true };
    if (i >= 0) data.steps.splice(i + 1, 0, step); else data.steps.push(step);
  }
  // Is this studio on its free trial? Asks the server (my_trial_status) so it never depends on whether
  // trial-lock.js has loaded yet; trial-lock's own answer is the fallback. -> {trial, t}
  async function trialState(store) {
    let t = null;
    try { t = store.subscription && store.subscription.trial ? await store.subscription.trial() : null; } catch (e) { t = null; }
    if (t && typeof t === "object") return { trial: t.status === "trial" || t.state === "trial", t };
    try { if (global.HelmTrialLock && (await global.HelmTrialLock.whenKnown())) return { trial: true, t: null }; } catch (e) {}
    return { trial: false, t: null };
  }
  // per-account dismissal: the trial list on the account (user_metadata), the paid list on the server (0059)
  async function setDismissed(store, trial, on) {
    if (trial) {
      const A = store.auth;
      if (!A || typeof A.markTrialStep !== "function" || !(await A.markTrialStep("dismissed", on))) throw new Error("Couldn't save that. Please try again.");
      return true;
    }
    return store.gettingStarted.dismiss(on);
  }
  async function mount(opts) {
    const o = opts || {};
    const doc = global.document;
    const card = doc.getElementById(o.id || "gsCard");
    const store = global.BPStore;
    if (!card || !store || !store.gettingStarted) return null;
    let data;
    try { data = await store.gettingStarted.get(); } catch (e) { card.hidden = true; return null; }
    if (!data || !Array.isArray(data.steps)) { card.hidden = true; return null; }
    const ts = await trialState(store);
    if (ts.trial) {
      const flags = (store.auth && typeof store.auth.trialSteps === "function" ? store.auth.trialSteps() : null) || {};
      if (flags.dismissed === true) { card.hidden = true; return { dismissed: true, trial: true }; }
      let facts = null; try { facts = store.gettingStarted.trialFacts ? await store.gettingStarted.trialFacts() : null; } catch (e) { facts = null; }
      data = trialData(data, facts, flags, ts.t);
    } else {
      if (data.dismissed === true) { card.hidden = true; return model(data); }
      try { applyOwnFacts(data, store.gettingStarted.ownFacts ? await store.gettingStarted.ownFacts() : null); } catch (e) {}
      await addTemplatesStep(data, store);
      await addWhatsappStep(data, store);
    }
    const m = model(data);
    if (!m || m.dismissed) { card.hidden = true; return m; }
    css();
    let collapsed = lsGet(COLLAPSE_KEY) === "1";
    card.innerHTML = gsMarkup(m, collapsed);
    card.hidden = false;
    card.setAttribute("aria-labelledby", "gsTitle");
    // read by the dashboard "Setup" chip (shell-b-dash.js)
    card.setAttribute("data-gs-mode", m.trial ? "trial" : "setup");
    card.setAttribute("data-gs-done", String(m.done)); card.setAttribute("data-gs-total", String(m.total));
    card.setAttribute("data-gs-complete", m.complete ? "1" : "0");

    card.querySelector("#gsToggle").addEventListener("click", (e) => {
      collapsed = !collapsed; lsSet(COLLAPSE_KEY, collapsed ? "1" : null);
      e.currentTarget.setAttribute("aria-expanded", String(!collapsed));
      const sr = e.currentTarget.querySelector(".sr-only"); if (sr) sr.textContent = (collapsed ? "Show" : "Hide") + " steps";
      card.querySelector("#gsBody").hidden = collapsed;
    });
    card.querySelectorAll("button.gs-go[data-act]").forEach((b) => b.addEventListener("click", () => {
      if (!openAccount(b.dataset.act) && b.dataset.href) global.location.href = b.dataset.href;
    }));
    // trial: "Open" on a sample event / the builder also ticks the step (the page itself ticks it too)
    card.querySelectorAll("a.gs-go[data-mark]").forEach((a) => a.addEventListener("click", () => {
      try { if (store.auth && store.auth.markTrialStep) store.auth.markTrialStep(a.dataset.mark).catch(() => {}); } catch (e) {}
    }));
    // audit 8: a "quotes?new=1" Start link carries a one-time nonce, so the Quotes page opens its
    // "Start a new quote?" dialog only for Helm's own link (never creates by itself)
    card.querySelectorAll("a.gs-go").forEach((a) => a.addEventListener("click", () => {
      const NQ = global.HelmNewQuote, h = a.getAttribute("href") || "";
      if (NQ && NQ.isNewQuoteHref && NQ.isNewQuoteHref(h)) a.setAttribute("href", NQ.arm(h));
    }));
    card.querySelector("#gsDismiss").addEventListener("click", async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        await setDismissed(store, m.trial, true);
        card.hidden = true;
        const ui = global.BPUI;
        if (ui && ui.toast) ui.toast("Checklist hidden.", { type: "info", action: { label: "Undo", onClick: async () => {
          try { await setDismissed(store, m.trial, false); await mount(o); } catch (err) {} } } });
      } catch (err) {
        btn.disabled = false;
        const ui = global.BPUI;
        if (ui && ui.toast) ui.toast(ui.friendlyError ? ui.friendlyError(err, { action: "hide the checklist" }) : "Couldn't hide the checklist.", { type: "err" });
      }
    });
    // every required step done: celebrate this once, then the card stays hidden on later visits
    if (m.complete && o.autoHide !== false) { try { Promise.resolve(setDismissed(store, m.trial, true)).catch(() => {}); } catch (e) {} }
    if (o.hint !== false && !m.complete) maybeHint(card);
    return m;
  }

  // Auto-mount on pages that carry <section id="gsCard" data-gs-auto>: waits (without
  // blocking the page) until the store is initialised and someone is signed in.
  function auto() {
    const doc = global.document; if (!doc) return;
    const card = doc.getElementById("gsCard");
    if (!card || !card.hasAttribute("data-gs-auto")) return;
    let tries = 0;
    (function go() {
      const st = global.BPStore;
      const ready = st && st.auth && typeof st.mode === "function" && st.mode() === "supabase" && st.auth.user && st.auth.user();
      if (ready) { mount().catch(() => {}); return; }
      if (tries++ < 40) setTimeout(go, 300);
    })();
  }
  if (typeof global.document !== "undefined" && global.document) {
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", auto); else auto();
  }

  const api = { mount, auto, model, trialData, applyOwnFacts, accountOpts, trialState, _setDismissed: setDismissed, addTemplatesStep, addWhatsappStep, render: gsMarkup, ringOffset, STEPS, SAFE_HREF, esc, _css: CSS };
  global.HelmGettingStarted = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
