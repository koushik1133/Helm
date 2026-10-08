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
   • CSP: no inline style attributes, runtime CSS via window.__helmAdoptCss;
     every interpolated value goes through esc().
   ========================================================================= */
(function (global) {
  "use strict";

  // key → presentation + where "Start" goes. `act` = open the account panel instead.
  const STEPS = {
    profile:    { icon: "👤", title: "Complete your profile", why: "Add your name and mobile so your team knows who you are and can reach you.", href: "profile-setup.html", act: "profile" },
    studio:     { icon: "🏢", title: "Fill in studio details", why: "Your legal name and billing address appear on every Helm invoice.", href: "control.html#account" },
    pricing:    { icon: "💲", title: "Set your prices", why: "New quotes use your default rates and menu packages automatically.", href: "control.html#pricing" },
    lead:       { icon: "📥", title: "Add your first lead", why: "Log each enquiry so you can follow it up and turn it into an event.", href: "leads.html" },
    floor_plan: { icon: "📐", title: "Design your first floor plan", why: "Plan the hall layout. The chairs you place are added to the quote.", href: "builder.html" },
    quote:      { icon: "📨", title: "Send your first quote", why: "Send the client an approval link they can approve and pay from.", href: "quotes.html" },
    team:       { icon: "👥", title: "Invite your team", why: "Add your staff and choose what each role can see and edit.", href: "control.html#users" },
    mfa:        { icon: "🔐", title: "Turn on two-step sign-in", why: "A code at sign-in protects your studio even if a password leaks.", href: "", act: "mfa" },
  };
  const COLLAPSE_KEY = "bp_gs_collapsed";
  const HINT_KEY = "bp_seen_gs_hint";
  const RING_R = 22, RING_C = 2 * Math.PI * RING_R;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return global.localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { if (v == null) global.localStorage.removeItem(k); else global.localStorage.setItem(k, v); } catch (e) {} };

  /* ---- pure model (exported for tests) ---------------------------------- */
  function model(data) {
    if (!data || !Array.isArray(data.steps)) return null;
    const steps = data.steps
      .filter((s) => s && Object.prototype.hasOwnProperty.call(STEPS, s.key))
      .map((s) => Object.assign({ key: s.key, done: s.done === true, optional: s.optional === true }, STEPS[s.key]));
    if (!steps.length) return null;
    const done = steps.filter((s) => s.done).length;
    const required = steps.filter((s) => !s.optional);
    const complete = required.length > 0 && required.every((s) => s.done);
    return { steps, done, total: steps.length, complete, admin: data.admin === true, dismissed: data.dismissed === true,
      pct: Math.round((done / steps.length) * 100), next: steps.find((s) => !s.done) || null };
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
      ? `<h3 id="gsTitle">🎉 You're all set up</h3><p class="gs-sub">${Number(m.done)} of ${Number(m.total)} done — your studio is ready for its first event.</p>`
      : `<h3 id="gsTitle">Getting started</h3><p class="gs-sub"><b>${Number(m.done)} of ${Number(m.total)} done</b>${m.next ? " · Next: " + esc(m.next.title) : ""}</p>`;
    const items = m.steps.map((s) => `<li class="gs-item${s.done ? " done" : ""}">`
      + `<span class="gs-ico" aria-hidden="true">${s.done ? "✓" : esc(s.icon)}</span>`
      + `<span class="gs-txt"><span class="gs-t">${esc(s.title)}${s.optional ? ' <span class="gs-opt">Optional</span>' : ""}</span>`
      + `<span class="gs-why">${esc(s.why)}</span></span>`
      + (s.done ? `<span class="gs-done">Done<span class="sr-only"> — ${esc(s.title)}</span></span>`
        : (s.act ? `<button type="button" class="gs-go" data-act="${esc(s.act)}" data-href="${esc(s.href)}">Start<span class="sr-only"> — ${esc(s.title)}</span></button>`
          : `<a class="gs-go" href="${esc(s.href)}">Start<span class="sr-only"> — ${esc(s.title)}</span></a>`))
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
    ".gs-ring{flex:0 0 auto}.gs-ring-bg{stroke:var(--line,#e8e3db)}.gs-ring-fg{stroke:var(--accent,#6d28d9);transition:stroke-dashoffset .6s ease}",
    ".gs-win .gs-ring-fg{stroke:var(--safe,#12a150)}.gs-ring-txt{font:700 12px var(--font,system-ui);fill:var(--ink,#1b1930)}",
    ".gs-tog{flex:0 0 auto;width:36px;height:36px;border-radius:10px;border:1px solid var(--line,#e8e3db);background:var(--panel-2,#faf8f5);color:var(--ink-2,#4b475f);cursor:pointer;font-size:16px;line-height:1}",
    ".gs-tog[aria-expanded=false] .gs-chev{display:inline-block;transform:rotate(-90deg)}",
    ".gs-tog:focus-visible,.gs-go:focus-visible,.gs-dismiss:focus-visible{outline:2px solid var(--accent,#6d28d9);outline-offset:2px}",
    ".gs-body{position:relative;margin-top:12px}",
    ".gs-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px}",
    ".gs-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--line-2,#f1ede7);border-radius:12px;background:var(--panel-2,#faf8f5);min-width:0}",
    ".gs-ico{flex:0 0 auto;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:17px;background:var(--accent-soft,#efe9ff)}",
    ".gs-item.done .gs-ico{background:var(--safe,#12a150);color:#fff;font-weight:700;font-size:15px}",
    "html[data-theme=dark] .gs-item.done .gs-ico{color:#062b1a}",
    ".gs-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
    ".gs-t{font-size:13.5px;font-weight:600}.gs-item.done .gs-t{color:var(--ink-3,#6b6577);text-decoration:line-through;text-decoration-thickness:1px}",
    ".gs-why{font-size:12px;color:var(--ink-3,#6b6577);line-height:1.35}",
    ".gs-opt{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3,#6b6577);border:1px solid var(--line,#e8e3db);border-radius:6px;padding:0 5px;margin-left:4px;text-decoration:none;display:inline-block}",
    ".gs-go{flex:0 0 auto;font:600 12.5px var(--font,system-ui);padding:7px 13px;border-radius:9px;border:0;cursor:pointer;color:#fff;background:linear-gradient(120deg,var(--accent,#6d28d9),var(--accent-2,#4f46e5));text-decoration:none;white-space:nowrap}",
    "html[data-theme=dark] .gs-go{background:linear-gradient(120deg,#7c3aed,#6d28d9)}",
    ".gs-done{flex:0 0 auto;font-size:12px;font-weight:600;color:var(--safe-text,#0f7a43)}",
    ".gs-foot{display:flex;justify-content:flex-end;margin-top:10px}",
    ".gs-dismiss{background:none;border:0;padding:6px 4px;font:500 12.5px var(--font,system-ui);color:var(--ink-3,#6b6577);text-decoration:underline;text-underline-offset:3px;cursor:pointer}",
    ".gs-dismiss:hover{color:var(--ink,#1b1930)}",
    ".gs-win{position:relative}",
    ".gs-confetti{position:absolute;inset:-12px 0 auto;height:0;pointer-events:none}",
    ".gs-confetti i{position:absolute;top:0;width:7px;height:11px;border-radius:2px;opacity:0;animation:gsFall 1.6s ease-out .1s 2 forwards}",
    ".gs-confetti i:nth-child(1){left:6%;background:#f59e0b}.gs-confetti i:nth-child(2){left:18%;background:#6d28d9;animation-delay:.25s}",
    ".gs-confetti i:nth-child(3){left:31%;background:#12a150;animation-delay:.05s}.gs-confetti i:nth-child(4){left:44%;background:#ec4899;animation-delay:.35s}",
    ".gs-confetti i:nth-child(5){left:57%;background:#4f46e5;animation-delay:.15s}.gs-confetti i:nth-child(6){left:69%;background:#f59e0b;animation-delay:.4s}",
    ".gs-confetti i:nth-child(7){left:82%;background:#12a150;animation-delay:.2s}.gs-confetti i:nth-child(8){left:93%;background:#6d28d9;animation-delay:.3s}",
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
  function openAccount(focus) {
    const ui = global.HelmAuthUI;
    if (ui && typeof ui.openAccount === "function") { ui.openAccount(focus === "profile" ? { focus: "profile" } : {}); return true; }
    return false;
  }

  function maybeHint(card) {
    // One-time pointer to the checklist — only after the main dashboard tour was seen,
    // so the two never overlap. tour.js marks HINT_KEY when the hint closes.
    if (!global.HelmTour || lsGet(HINT_KEY) || !lsGet("bp_seen_tour") || lsGet("bp_force_tour")) return;
    if (global.document.querySelector(".htour")) return;
    setTimeout(() => {
      if (card.hidden || global.document.querySelector(".htour")) return;
      global.HelmTour.start([{ sel: "#gsCard", title: "Your getting-started checklist",
        desc: "Work through these steps to set up your studio. Each one ticks itself off as you do it, and you can collapse or dismiss the list any time." }], HINT_KEY);
    }, 700);
  }

  async function mount(opts) {
    const o = opts || {};
    const doc = global.document;
    const card = doc.getElementById(o.id || "gsCard");
    const store = global.BPStore;
    if (!card || !store || !store.gettingStarted) return null;
    let data;
    try { data = await store.gettingStarted.get(); } catch (e) { card.hidden = true; return null; }
    const m = model(data);
    if (!m || m.dismissed) { card.hidden = true; return m; }
    css();
    let collapsed = lsGet(COLLAPSE_KEY) === "1";
    card.innerHTML = gsMarkup(m, collapsed);
    card.hidden = false;
    card.setAttribute("aria-labelledby", "gsTitle");

    card.querySelector("#gsToggle").addEventListener("click", (e) => {
      collapsed = !collapsed; lsSet(COLLAPSE_KEY, collapsed ? "1" : null);
      e.currentTarget.setAttribute("aria-expanded", String(!collapsed));
      const sr = e.currentTarget.querySelector(".sr-only"); if (sr) sr.textContent = (collapsed ? "Show" : "Hide") + " steps";
      card.querySelector("#gsBody").hidden = collapsed;
    });
    card.querySelectorAll("button.gs-go[data-act]").forEach((b) => b.addEventListener("click", () => {
      if (!openAccount(b.dataset.act) && b.dataset.href) global.location.href = b.dataset.href;
    }));
    card.querySelector("#gsDismiss").addEventListener("click", async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        await store.gettingStarted.dismiss(true);
        card.hidden = true;
        const ui = global.BPUI;
        if (ui && ui.toast) ui.toast("Checklist hidden.", { type: "info", action: { label: "Undo", onClick: async () => {
          try { await store.gettingStarted.dismiss(false); await mount(o); } catch (err) {} } } });
      } catch (err) {
        btn.disabled = false;
        const ui = global.BPUI;
        if (ui && ui.toast) ui.toast(ui.friendlyError ? ui.friendlyError(err, { action: "hide the checklist" }) : "Couldn't hide the checklist.", { type: "err" });
      }
    });
    if (o.hint !== false) maybeHint(card);
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

  const api = { mount, auto, model, render: gsMarkup, ringOffset, STEPS, esc, _css: CSS };
  global.HelmGettingStarted = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
