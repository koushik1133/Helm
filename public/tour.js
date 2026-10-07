/* =========================================================================
   HELM — shared per-page guided tour engine (zero-dependency, vanilla JS)
   -------------------------------------------------------------------------
   One engine, many pages. Each page's steps live in STEPS keyed by filename.
   A page opts in simply by including  <script src="tour.js?v=1"></script>.

   • Injects its own spotlight CSS (pages need no markup).
   • Renders a floating "? Tour" button, or wires an existing #helpBtn.
   • Auto-starts once per page for signed-in first-time visitors.
   • Robust: a step whose target is missing is SKIPPED, not fatal — this is
     the fix for the old "tour jumps straight to the end" bug.
   ========================================================================= */
(function () {
  "use strict";

  /* ---- per-page steps: { selector, title, desc } --------------------- */
  const STEPS = {
    "builder.html": [
      { sel: "#customBtn", title: "Build your floor", desc: "Click ✨ Custom Event, type your hall length × breadth and guest count, and Helm sizes the canvas to your hall and auto-arranges the seating." },
      { sel: "#preset", title: "…or start from a template", desc: "Prefer a head start? Pick a ready-made event layout (wedding, conference, concert…) and tweak it." },
      { sel: "#toolbox", title: "Drag any asset", desc: "Drag stages, chairs, tables, bars, exits — anything — onto the floor. Every object is movable, resizable and rotatable." },
      { sel: "#measureBtn", title: "Measure everything", desc: "Turn on 📏 Measure, then select an object to see its distance from all four walls AND its nearest neighbour on every side." },
      { sel: "#capMeter", title: "Capacity & congestion", desc: "Seats placed vs the venue's capacity. It flags any block packed tighter than a walkable aisle." },
      { sel: "#saveBtn", title: "Save to the quote", desc: "Save ties this layout to the event — and the chair count flows straight into the price breakdown on the right." },
    ],
    "quotes.html": [
      { sel: "#newBtn", title: "Start a new quote", desc: "Price a fresh event here. It becomes the event everything else hangs off." },
      { sel: "#tabs", title: "Find confirmed fast", desc: "Active · Quotes · Confirmed · Archive · Deleted. Confirmed events rise to the top and are highlighted so you never scroll to find them." },
      { sel: "#search", title: "Search", desc: "Jump to any quote by client name or quote code." },
      { sel: "#rows", title: "Your quotes", desc: "Click a row to open it, confirm it, re-price it, or take client approval by OTP / consent / payment link." },
    ],
    "flow.html": [
      { sel: "#code", title: "The event workspace", desc: "Every stage of this one event lives here, top to bottom — fill it in order and nothing gets missed." },
      { sel: "#sec-client", title: "1 · Client", desc: "Who the event is for. Saved here, reused everywhere." },
      { sel: "#sec-discovery", title: "2 · Discovery", desc: "Capture requirements and the budget range before you price." },
      { sel: "#sec-proposal", title: "3 · Proposal", desc: "Your pitch to the client — it sits above the floor layout so you sell first, then plan." },
      { sel: "#sec-layout", title: "4 · Floor layout", desc: "Open the builder. The chairs you place here feed straight back into the quotation." },
      { sel: "#sec-quote", title: "5 · Quote", desc: "Final pricing and confirmation. Confirming sets the event live." },
      { sel: "#sec-pay", title: "6 · Payment", desc: "Send the client an approval + payment link and track what's paid." },
    ],
    "logistics.html": [
      { sel: "#tabs", title: "Event logistics", desc: "Everything that has to happen for this event, organised by section (stage, lighting, catering…)." },
      { sel: "#tplBar", title: "Apply a template", desc: "Drop a saved checklist into this event in one click — no retyping the same tasks every time. (You build templates in Control Center.)" },
      { sel: "#a_title", title: "Add a one-off task", desc: "Need something the template didn't cover? Add your own task right here." },
      { sel: "#pane", title: "Assign & track", desc: "Assign staff to each task and tick off progress as the event comes together." },
    ],
    "leads.html": [
      { sel: "#newBtn", title: "Capture a lead", desc: "Every enquiry starts here. Click + New lead to open the form and record who got in touch." },
      { sel: "#board", title: "The pipeline board", desc: "Leads sit in columns by stage — New, Qualified, Discovery, Quoted, Won, Lost. Drag a card between columns to move it along." },
      { sel: "#search", title: "Find anyone fast", desc: "Search by name, phone or event type across every column." },
    ],
    "staff.html": [
      { sel: "#newBtn", title: "Add your team", desc: "Add an in-house team member with their name, phone and department (stage, lighting, catering…)." },
      { sel: "#grid", title: "Your people", desc: "Everyone on the team, by department. You assign them to event tasks from an event's Logistics page." },
      { sel: "#search", title: "Find a person", desc: "Search by name or role to quickly pull someone up." },
    ],
    "inventory.html": [
      { sel: "#newBtn", title: "Add stock", desc: "Add equipment to your inventory, graded A / B / C by value so losses are easy to price." },
      { sel: "#eventPanel", title: "Reserve for an event", desc: "Book items to a specific event — this is what the close-out later checks is returned." },
      { sel: "#pane-loans", title: "Check out & back in", desc: "Issue stock to a person and record how much comes back. Anything short is flagged with its rupee value." },
    ],
    "vendors.html": [
      { sel: "#kindTabs", title: "Vendor categories", desc: "Outside partners grouped by what they provide — catering, sound, décor, transport and more." },
      { sel: "#newBtn", title: "Add a vendor", desc: "Record a partner once (contact + rates) and reuse them across events." },
      { sel: "#grid", title: "Your partner list", desc: "Everyone you work with. Book them for the gaps your in-house team can't cover." },
    ],
    "calendar.html": [
      { sel: "#agenda", title: "Every event, dated", desc: "A running schedule of all your events so nothing collides." },
      { sel: "#conflicts", title: "Clash detection", desc: "Helm flags staff or stock booked on two events at once — before it becomes a problem on the day." },
    ],
    "control.html": [
      { sel: "#tab-pricing", title: "Default pricing", desc: "Set chair price, plate price, GST % and service charge once — every new quote uses these." },
      { sel: "#tab-users", title: "Team & roles", desc: "Invite teammates by email link and tick exactly which areas each role can view or edit." },
    ],
    "crm.html": [
      { sel: "#rows", title: "Client history", desc: "Every past client and enquiry, snapshotted automatically from Leads — nothing is ever lost." },
      { sel: "#search", title: "Search the archive", desc: "Find any past client by name, phone or event type for follow-up or a repeat booking." },
    ],
    "nurture.html": [
      { sel: "#addCard", title: "Add a relationship", desc: "Keep past clients warm — record birthdays and anniversaries to greet them automatically." },
      { sel: "#tplTabs", title: "Message templates", desc: "Set the greeting messages Helm sends, so repeat business comes to you." },
    ],
    "plan.html": [
      { sel: "#dishSearch", title: "Build the menu", desc: "Search the dish catalog and add items to this event's menu." },
      { sel: "#lockBtn", title: "Lock the plan", desc: "Once the menu and details are final, lock the plan so numbers don't drift before the event." },
    ],
    "runsheet.html": [
      { sel: "#r_add", title: "Add a run-sheet item", desc: "Build a timed schedule of the day — each moment, who owns it and when." },
      { sel: "#printBtn", title: "Print / share", desc: "Print the run-sheet or share it so everyone runs to the same timeline." },
    ],
    "command.html": [
      { sel: "#pullBtn", title: "Pull the roster", desc: "Load the assigned staff for the day so you can check them in as they arrive." },
      { sel: "#chkAdd", title: "Day-of checklist", desc: "Tick tasks off live as the event runs." },
      { sel: "#gst_add", title: "Guests & stock", desc: "Check in guests and track stock used through the day." },
    ],
    "closure.html": [
      { sel: "#c_feedback", title: "Capture feedback", desc: "Record the client's feedback and a quotable testimonial for your marketing." },
      { sel: "#rateAdd", title: "Rate vendors & staff", desc: "Score who worked well so you know who to rebook next time." },
      { sel: "#closeBtn", title: "Close & archive", desc: "Once all equipment is returned, close the event. It moves to the Archive tab with a clean P&L." },
    ],
    "event.html": [
      { sel: "#steps", title: "The event lifecycle", desc: "Every stage of this event, from proposal to settlement. Click a step to jump straight to it." },
      { sel: "#inviteBtn", title: "Invitation website", desc: "Once confirmed, build a public invitation site for the client to share with guests." },
      { sel: "#advBtn", title: "Advance the stage", desc: "Move the event forward — discovery → proposal → quote → confirmed → planning, and on." },
    ],
  };

  /* ---- optional form coaching: runs once when a page's create-modal opens -- */
  const FORMS = {
    "leads.html": {
      trigger: "#newBtn", modal: "#leadModal", key: "helm_tour_form_leads",
      steps: [
        { sel: "#f_name", title: "Who's enquiring", desc: "The contact's name — the only required field. Everything else is optional and can be added later." },
        { sel: "#f_type", title: "What & when", desc: "Event type and date. These help you prioritise and quote faster." },
        { sel: "#f_budget", title: "Budget & guests", desc: "A rough budget and headcount — they pre-fill the quote and the floor layout when you convert this lead." },
        { sel: "#f_source", title: "Where it came from", desc: "Website, referral, walk-in… useful later to see which channels bring the best events." },
        { sel: "#lm_save", title: "Save the lead", desc: "Adds it to the New column and snapshots it to the CRM archive automatically." },
      ],
    },
  };

  // Normalise the page key so it matches with or without the ".html" suffix
  // (the app is served under clean URLs, e.g. "/builder" as well as "/builder.html").
  const base = (location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "");
  const page = base || "index";
  // Pages without built-in steps (e.g. the dashboard, which passes its own list to
  // HelmTour.start) still get the engine, just no "? Tour" button of our own.
  const steps = STEPS[page + ".html"] || STEPS[page] || [];

  /* ---- inject spotlight styles once ---------------------------------- */
  const css = `
  .htour{position:fixed;inset:0;z-index:9000;pointer-events:none;font-family:inherit}
  .htour .ring{position:absolute;box-sizing:border-box;border:3px solid var(--gold,#e0a938);border-radius:12px;
    box-shadow:0 0 0 9999px rgba(20,18,40,.58)}
  .htour .arrow{position:absolute;color:var(--gold,#e0a938);font-size:28px;line-height:1;
    filter:drop-shadow(0 2px 3px rgba(0,0,0,.25));animation:htbob 1s ease-in-out infinite}
  @keyframes htbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
  .htour .tip{position:absolute;max-width:calc(100vw - 24px);box-sizing:border-box;max-height:calc(100vh - 24px);overflow:auto;background:var(--panel,#fff);color:var(--ink,#1b1930);
    border:1px solid var(--line,#e8e3db);border-radius:14px;box-shadow:0 10px 30px rgba(20,18,40,.22);
    padding:16px 18px;pointer-events:auto}
  .htour .tip .tstep{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent,#6d28d9)}
  .htour .tip h4{margin:4px 0 6px;font-size:16px}
  .htour .tip p{margin:0 0 13px;font-size:13px;color:var(--ink-2,#4b475f);line-height:1.55}
  .htour .tip .trow{display:flex;gap:8px;align-items:center}
  .htour .tip .trow .sp{flex:1}
  .htour .tip button{height:32px;padding:0 13px;border-radius:8px;border:1px solid var(--line,#e8e3db);
    background:var(--panel,#fff);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink-2,#4b475f)}
  .htour .tip button.pri{background:linear-gradient(120deg,var(--accent,#6d28d9),#7c5cff);border-color:transparent;color:#fff}
  .htour .tip button.skip{border:0;background:transparent;color:var(--ink-3,#6b6577)}
  .htour-fab{position:fixed;left:16px;bottom:16px;z-index:8000;height:34px;padding:0 14px;border-radius:20px;
    border:1px solid var(--line,#e8e3db);background:var(--panel,#fff);color:var(--accent,#6d28d9);font-family:inherit;
    font-weight:700;font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(20,18,40,.14);display:inline-flex;align-items:center;gap:5px}
  .htour-fab:hover{border-color:var(--accent,#6d28d9);background:var(--accent-soft,#efe9ff)}`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  /* ---- engine -------------------------------------------------------- */
  let list = [], i = 0, root = null, endKey = "helm_tour_seen_" + page;
  const seenKey = "helm_tour_seen_" + page;

  // A target counts as "present" when it exists, isn't [hidden], isn't inside a
  // display:none / visibility:hidden / collapsed ancestor, and actually occupies
  // space. We use getBoundingClientRect (not offsetParent) because position:fixed
  // elements always report a null offsetParent even when fully visible.
  function present(sel) {
    const t = document.querySelector(sel);
    if (!t || t.hidden || (t.closest && t.closest("[hidden]"))) return null;
    const cs = getComputedStyle(t);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return null;
    if (typeof t.checkVisibility === "function" && !t.checkVisibility({ checkVisibilityCSS: true })) return null;
    const r = t.getBoundingClientRect();
    return (r.width > 1 && r.height > 1) ? t : null;
  }

  // ---- pure geometry (exported for tests via HelmTour._layout) -------------
  // r: target rect in VIEWPORT coords (getBoundingClientRect — matches the
  // position:fixed overlay, no scrollX/scrollY mixing); vw/vh: viewport size;
  // tw/th: tip size. Returns ring/tip/arrow boxes, all clamped into the viewport,
  // with the tip flipped to whichever side (below/above/right/left) has room.
  // r === null means "target not visible at this breakpoint" -> centered step.
  function layout(r, vw, vh, tw, th) {
    const M = 12, GAP = 18, pad = 6;
    tw = Math.min(tw || 320, vw - M * 2); th = th || 170;
    if (!r) return { centered: true, side: "center", ring: null, arrow: null,
      tip: { left: Math.max(M, (vw - tw) / 2), top: Math.max(M, (vh - th) / 2), width: tw } };
    // Target scrolled completely out of view (the user scrolled away mid-step):
    // no ring; the card sits at that edge with an arrow pointing toward the target.
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {
      const up = r.bottom <= 0, cx0 = Math.min(Math.max(M + 14, (r.left + r.right) / 2), vw - M - 14);
      return { centered: false, offscreen: true, side: up ? "above" : "below", ring: null,
        arrow: { left: cx0 - 14, top: up ? 2 : vh - 30, glyph: up ? "▲" : "▼" },
        tip: { left: Math.min(Math.max(M, cx0 - tw / 2), Math.max(M, vw - tw - M)), top: up ? 34 : Math.max(M, vh - th - 34), width: tw } };
    }
    // ring: target box + padding, clipped to the viewport (huge targets stay visible)
    const rl = Math.max(2, r.left - pad), rt = Math.max(2, r.top - pad);
    const rr = Math.min(vw - 2, r.right + pad), rb = Math.min(vh - 2, r.bottom + pad);
    const ring = { left: rl, top: rt, width: Math.max(0, rr - rl), height: Math.max(0, rb - rt) };
    const room = { below: vh - rb, above: rt, right: vw - rr, left: rl };
    let side;
    if (room.below >= th + GAP) side = "below";
    else if (room.above >= th + GAP) side = "above";
    else if (room.right >= tw + GAP) side = "right";
    else if (room.left >= tw + GAP) side = "left";
    else side = room.below >= room.above ? "below" : "above";   // nothing fits: larger gap, then clamp
    const cx = (rl + rr) / 2, cy = (rt + rb) / 2;
    let tx, ty;
    if (side === "below" || side === "above") {
      tx = cx - tw / 2;
      ty = side === "below" ? rb + GAP : rt - th - GAP;
    } else {
      ty = cy - th / 2;
      tx = side === "right" ? rr + GAP : rl - tw - GAP;
    }
    tx = Math.min(Math.max(M, tx), Math.max(M, vw - tw - M));
    ty = Math.min(Math.max(M, ty), Math.max(M, vh - th - M));
    const A = 14;   // arrow glyph half-size
    const arrow = side === "below" ? { left: cx - A, top: rb + 1, glyph: "▲" }
      : side === "above" ? { left: cx - A, top: rt - 28, glyph: "▼" }
      : side === "right" ? { left: rr + 1, top: cy - A, glyph: "◀" }
      : { left: rl - 26, top: cy - A, glyph: "▶" };
    arrow.left = Math.min(Math.max(2, arrow.left), vw - 28);
    arrow.top = Math.min(Math.max(2, arrow.top), vh - 30);
    return { centered: false, side, ring, arrow, tip: { left: tx, top: ty, width: tw } };
  }

  // The part of the target actually visible: its rect intersected with every
  // scrolling/clipping ancestor (e.g. a horizontally-scrolling nav bar on a phone,
  // where a pill's raw rect can sit outside the bar). null when fully clipped.
  function visibleRect(t) {
    const r = t.getBoundingClientRect();
    let l = r.left, tp = r.top, rt = r.right, b = r.bottom;
    for (let a = t.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
        const ar = a.getBoundingClientRect();
        l = Math.max(l, ar.left); tp = Math.max(tp, ar.top); rt = Math.min(rt, ar.right); b = Math.min(b, ar.bottom);
      }
      if (cs.position === "fixed") break;
    }
    if (rt - l < 2 || b - tp < 2) return null;
    return { left: l, top: tp, right: rt, bottom: b, width: rt - l, height: b - tp };
  }

  let ro = null, rafPending = false;
  function end() {
    if (root) { root.remove(); root = null; }
    window.removeEventListener("resize", onView);
    window.removeEventListener("scroll", onView, true);
    window.removeEventListener("orientationchange", onView);
    if (window.visualViewport) { visualViewport.removeEventListener("resize", onView); visualViewport.removeEventListener("scroll", onView); }
    if (ro) { ro.disconnect(); ro = null; }
    try { localStorage.setItem(endKey, "1"); } catch (_) {}
  }
  // Re-glue the spotlight to its target whenever the viewport OR layout changes
  // (page/inner scroll, resize, orientation change, pinch-zoom, sidebar collapse,
  // late-loading content) WITHOUT starting a new scroll — so it never fights the
  // user. Coalesced to one position() per animation frame.
  function onView() {
    if (document.hidden) { position(); return; }   // rAF is paused in background tabs
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(() => { rafPending = false; position(); });
  }
  function observe(tgt) {
    if (!ro) return;
    ro.disconnect();
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
    if (tgt) ro.observe(tgt);
  }

  function start(customSteps, key) {
    end();
    endKey = key || seenKey;
    // Keep every step whose target EXISTS. Visibility is decided per render: a
    // target hidden at the current breakpoint gets a centered card instead of
    // being dropped, and a later resize brings the spotlight back.
    list = (customSteps || steps).filter(s => document.querySelector(s.sel));
    if (!list.length) return;
    i = 0;
    root = document.createElement("div");
    root.className = "htour";
    root.innerHTML = `<div class="ring"></div><div class="arrow">▼</div>
      <div class="tip" role="dialog" aria-live="polite"><div class="tstep"></div><h4></h4><p></p>
        <div class="trow"><button class="skip">Skip</button><span class="sp"></span>
        <button class="back">Back</button><button class="pri next">Next →</button></div></div>`;
    document.body.appendChild(root);
    root.querySelector(".skip").onclick = end;
    root.querySelector(".back").onclick = () => { if (i > 0) { i--; place(); } };
    root.querySelector(".next").onclick = () => { if (i < list.length - 1) { i++; place(); } else end(); };
    window.addEventListener("resize", onView);
    window.addEventListener("scroll", onView, true);   // capture inner-scroll containers too
    window.addEventListener("orientationchange", onView);
    if (window.visualViewport) { visualViewport.addEventListener("resize", onView); visualViewport.addEventListener("scroll", onView); }
    if (typeof ResizeObserver === "function") ro = new ResizeObserver(onView);
    place();
  }

  // Pure positioning from the target's CURRENT rect — no scrolling. Safe to call
  // on every scroll/resize frame.
  function position() {
    if (!root) return;
    if (i >= list.length) { end(); return; }
    const step = list[i], el = present(step.sel), vr = el ? visibleRect(el) : null, tgt = vr ? el : null;
    const de = document.documentElement;
    const vw = de.clientWidth || window.innerWidth, vh = window.innerHeight || de.clientHeight;
    const ring = root.querySelector(".ring");
    const tip = root.querySelector(".tip"), arrow = root.querySelector(".arrow");
    root.querySelector(".tstep").textContent = `Step ${i + 1} of ${list.length}`;
    root.querySelector("h4").textContent = step.title;
    root.querySelector("p").textContent = tgt ? step.desc
      : step.desc + " (This part isn't shown at the current screen size — widen the window or open the menu to see it.)";
    root.querySelector(".back").style.visibility = i ? "visible" : "hidden";
    root.querySelector(".next").textContent = i < list.length - 1 ? "Next →" : "Done";
    tip.style.width = Math.min(320, vw - 24) + "px";
    const L = layout(vr, vw, vh, tip.offsetWidth, tip.offsetHeight);
    if (!L.ring) {
      // no visible target (hidden at this size, or scrolled out of view): dim the
      // page and collapse the ring instead of outlining the wrong spot
      ring.style.left = (vw / 2) + "px"; ring.style.top = (vh / 2) + "px";
      ring.style.width = "0px"; ring.style.height = "0px"; ring.style.borderWidth = "0px";
    } else {
      ring.style.borderWidth = "";
      ring.style.left = L.ring.left + "px"; ring.style.top = L.ring.top + "px";
      ring.style.width = L.ring.width + "px"; ring.style.height = L.ring.height + "px";
    }
    if (!L.arrow) arrow.style.display = "none";
    else {
      arrow.style.display = "";
      arrow.textContent = L.arrow.glyph;
      arrow.style.left = L.arrow.left + "px"; arrow.style.top = L.arrow.top + "px";
    }
    tip.style.left = L.tip.left + "px"; tip.style.top = L.tip.top + "px";
  }

  function place() {
    if (!root) return;
    if (i >= list.length) { end(); return; }
    const tgt = present(list[i].sel);
    observe(tgt);
    if (tgt) {
      // Scroll the target into view BEFORE measuring (only when not already fully on screen).
      const r = tgt.getBoundingClientRect();
      const vr = visibleRect(tgt);   // also catches a pill clipped inside a scrolling nav bar
      if (!vr || vr.width < r.width - 1 || vr.height < r.height - 1 ||
          r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
        const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
        tgt.scrollIntoView({ block: "center", inline: "center", behavior: (reduce || document.hidden) ? "auto" : "smooth" });
      }
    }
    // Position IMMEDIATELY so the ring is never left stranded, even where rAF is
    // throttled (a backgrounded tab) or the scroll jumps instantly. Then REFINE as
    // the smooth scroll progresses: the 'scroll' listener re-glues on every scroll
    // event, and the rAF settle below repositions once the rect stops moving
    // (3 stable frames, ~1s cap). position() is idempotent.
    position();
    if (!tgt) return;
    let lastTop = NaN, stable = 0, frames = 0;
    (function settle() {
      if (!root) return;
      const top = tgt.getBoundingClientRect().top;
      if (Math.abs(top - lastTop) < 0.5) { if (++stable >= 3) return position(); }
      else { stable = 0; }
      lastTop = top;
      if (++frames > 60) return position();   // ~1s hard cap (60 frames)
      requestAnimationFrame(settle);
    })();
  }

  /* ---- mount: reuse #helpBtn if present, else a floating button ------- */
  function mount() {
    document.addEventListener("keydown", e => { if (e.key === "Escape" && root) end(); });
    if (!steps.length) return;   // engine-only page: the page wires its own button
    const existing = document.getElementById("helpBtn");
    if (existing) { existing.addEventListener("click", () => start()); }
    else {
      const fab = document.createElement("button");
      fab.className = "htour-fab"; fab.type = "button";
      fab.textContent = "? Tour"; fab.title = "Take a guided tour of this page";
      fab.addEventListener("click", () => start());
      document.body.appendChild(fab);
    }

    // form coaching: when this page's create-modal opens, run the field tour once
    const form = FORMS[page + ".html"] || FORMS[page];
    if (form) {
      const btn = document.querySelector(form.trigger);
      if (btn) btn.addEventListener("click", () => {
        try { if (localStorage.getItem(form.key)) return; } catch (_) {}
        // wait for the modal to actually render, then coach the fields
        setTimeout(() => { if (present(form.modal)) start(form.steps, form.key); }, 300);
      });
    }

    // NOTE: inner feature pages no longer auto-start a tour. The guided tour
    // auto-runs only on the dashboard (dashboard.html) at first login/signup. Every
    // page still exposes the manual "? Tour" button/FAB (see mount above), so
    // users can launch the tour on demand whenever they need it. (seenKey kept
    // for the form-coaching hints above, which remain click-triggered.)
  }

  window.HelmTour = { start, end, _layout: layout, _present: present };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
