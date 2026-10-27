/* =========================================================================
   HELM — shared per-page guided tour engine (zero-dependency, vanilla JS)
   -------------------------------------------------------------------------
   One engine, many pages. Each page's steps live in page-tours.js (R46: the
   single source of truth, keyed by page and Control Center section).
   A page opts in by including page-tours.js then tour.js; the app shell's
   "Tour this page" (the "?" menu, the sidebar) loads both on demand.

   • Injects its own spotlight CSS (pages need no markup).
   • Renders a floating "? Tour" button, or wires an existing #helpBtn.
   • Never auto-starts by itself (only the dashboard / builder first-run tours
     call start() once); remembers "seen" per page / section; always replayable.
   • Next / Back / Skip, arrow keys, Esc closes, focus stays in the card and
     returns to where it was; respects prefers-reduced-motion.
   • Robust: a step whose target is missing is SKIPPED, not fatal — this is
     the fix for the old "tour jumps straight to the end" bug.
   ========================================================================= */
(function () {
  "use strict";

  /* ---- per-page steps live in page-tours.js (window.HelmPageTours) ------
     R46: ONE data file holds every page's tour (and one per Control Center
     section). This engine reads it; it never keeps steps of its own. Pages that
     include tour.js include page-tours.js just before it; anything else (the
     app shell's "Tour this page") loads it on demand (ensureData below). */
  const PT_V = "1";
  function PT() { return window.HelmPageTours || null; }
  function ensureData(cb) {
    if (PT()) { cb(); return; }
    try {
      let s = document.querySelector('script[data-helm-page-tours]');
      if (!s) {
        s = document.createElement("script"); s.src = "/page-tours.js?v=" + PT_V; s.async = true;
        s.setAttribute("data-helm-page-tours", "1"); document.head.appendChild(s);
      }
      s.addEventListener("load", () => cb());
      s.addEventListener("error", () => cb());
    } catch (_) { cb(); }
  }

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
  // r20 (live QA): studio pretty URLs end in an id or "floor-plan" (/<studio>/events/<id>/floor-plan is the builder), so
  // the builder never found its steps there - no first-run tour, no "? Tour". HelmUrl (store-api.js) knows the real page.
  let routed = null;
  try { const H = window.HelmUrl; routed = H && typeof H.route === "function" && H.route() && typeof H.page === "function" ? H.page() : null; } catch (_) { routed = null; }
  const base = (routed || location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "");
  const page = base || "index";
  // Pages without steps of their own (e.g. the dashboard, which passes its own list to
  // HelmTour.start) still get the engine, just no "? Tour" button of our own.
  // A sectioned page (Control Center) picks the section on screen at the moment the tour starts.
  function pageEntry() { const P = PT(); return P ? P.entry(page) : null; }
  function pageSection() { const P = PT(); return P ? P.sectionOf(page) : null; }
  function pageSteps() { const P = PT(); return P ? P.stepsFor(page) : []; }
  function pageKey() { const P = PT(); return P ? P.seenKey(page, pageSection()) : "helm_tour_seen_" + page; }

  /* ---- inject spotlight styles once ---------------------------------- */
  const css = `
  .htour{position:fixed;inset:0;z-index:9000;pointer-events:none;font-family:inherit}
  .htour .ring{position:absolute;box-sizing:border-box;border:3px solid var(--hb-acc,var(--accent,#2450f0));border-radius:12px;
    box-shadow:0 0 0 9999px rgba(20,18,40,.58)}
  .htour .arrow{position:absolute;color:var(--hb-acc,var(--accent,#2450f0));font-size:28px;line-height:1;
    filter:drop-shadow(0 2px 3px rgba(0,0,0,.25));animation:htbob 1s ease-in-out infinite}
  @keyframes htbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
  @media (prefers-reduced-motion:reduce){.htour .arrow{animation:none}.htour .tip{transition:none}}
  .htour .tip{position:absolute;max-width:calc(100vw - 24px);box-sizing:border-box;max-height:calc(100vh - 24px);overflow:auto;background:var(--hb-bg,var(--panel,#fff));color:var(--hb-ink,var(--ink,#1b1930));
    border:1px solid var(--hb-line,var(--line,#e8e3db));border-radius:14px;box-shadow:0 10px 30px rgba(20,18,40,.22);
    padding:16px 18px;pointer-events:auto}
  .htour .tip .tstep{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hb-acc-text,var(--accent,#047857))}
  .htour .tip h4{margin:4px 0 6px;font-size:16px}
  .htour .tip p{margin:0 0 7px;font-size:13px;color:var(--hb-ink2,var(--ink-2,#4b475f));line-height:1.55}
  .htour .tip{transition:opacity .14s ease}
  .htour.htour-moving .tip,.htour.htour-moving .arrow{opacity:0;pointer-events:none}
  .htour .tip .trow{display:flex;gap:8px;align-items:center;position:sticky;bottom:-16px;margin:0 -18px -16px;padding:6px 18px 16px;background:var(--hb-bg,var(--panel,#fff))}
  .htour .tip .trow .sp{flex:1}
  .htour .tip button{height:32px;padding:0 13px;border-radius:8px;border:1px solid var(--hb-line,var(--line,#e8e3db));
    background:var(--hb-bg,var(--panel,#fff));font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;color:var(--hb-ink2,var(--ink-2,#4b475f))}
  .htour .tip button.pri{background:var(--hb-acc,var(--accent,#047857));border-color:transparent;color:var(--hb-acc-ink,#fff)}
  .htour .tip button:focus-visible{outline:2px solid var(--hb-acc-text,var(--accent,#047857));outline-offset:2px}
  .htour .tip button.skip{border:0;background:transparent;color:var(--hb-ink3,var(--ink-3,#6b6577))}
  .htour-fab{position:fixed;left:16px;bottom:16px;z-index:8000;height:34px;padding:0 14px;border-radius:20px;
    border:1px solid var(--hb-line,var(--line,#e8e3db));background:var(--hb-bg,var(--panel,#fff));color:var(--hb-acc-text,var(--accent,#047857));font-family:inherit;
    font-weight:700;font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(20,18,40,.14);display:inline-flex;align-items:center;gap:5px}
  @media print{.htour,.htour-fab{display:none!important}}
  .htour-fab:hover{border-color:var(--hb-acc-text,var(--accent,#047857));background:var(--hb-acc-soft,var(--accent-soft,#e3f4ed))}
  @media (max-width:767.98px){body.hmn-on:not(.hmn-kb) .htour-fab{bottom:calc(72px + env(safe-area-inset-bottom,0px))}}
  @media (min-width:820px){html.htour-tuck:not(.hb-pinned) .hb-rail{width:var(--hb-w)!important;box-shadow:none!important}
    html.htour-tuck:not(.hb-pinned) .hb-rail :is(.hb-lb,.hb-head,.hb-pin){opacity:0!important}}
  @media (max-width:819.98px){html.htour-tuck .hb-rail{transform:translateX(-100%)!important;box-shadow:none!important}}
  @media (min-width:820px){html.htour-rail:not(.hb-pinned) .hb-rail{width:var(--hb-wx)!important;transition:none!important;box-shadow:10px 0 30px rgba(0,0,0,.10)!important}
    html.htour-rail:not(.hb-pinned) .hb-rail :is(.hb-lb,.hb-head,.hb-pin){opacity:1!important;transition:none!important}}`;
  __helmAdoptCss(document, css);

  /* ---- engine -------------------------------------------------------- */
  let list = [], i = 0, root = null, endKey = "helm_tour_seen_" + page;
  const seenKey = "helm_tour_seen_" + page;   // form coaching / custom lists; page tours use pageKey()

  // A target counts as "present" when it exists, isn't [hidden], isn't inside a
  // display:none / visibility:hidden / collapsed ancestor, and actually occupies
  // space. We use getBoundingClientRect (not offsetParent) because position:fixed
  // elements always report a null offsetParent even when fully visible.
  function present(sel) {
    const t = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!t || t.hidden || (t.closest && t.closest("[hidden]"))) return null;
    const cs = getComputedStyle(t);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return null;
    if (typeof t.checkVisibility === "function" && !t.checkVisibility({ checkVisibilityCSS: true })) return null;
    const r = t.getBoundingClientRect();
    return (r.width > 1 && r.height > 1) ? t : null;
  }

  // A step's sel may be one selector or an ordered list of fallbacks (e.g. the
  // desktop rail first, then the phone bottom bar). The first VISIBLE match wins.
  // A step without sel is a centered card (welcome / wrap-up).
  function pick(step) {
    if (!step.sel) return null;
    const cands = Array.isArray(step.sel) ? step.sel : [step.sel];
    for (const c of cands) {
      let all; try { all = document.querySelectorAll(c); } catch (_) { continue; }
      for (const t of all) {
        if (!present(t)) continue;
        // an off-canvas drawer (phone sidebar) is "present" but parked off-screen: skip it
        const r = t.getBoundingClientRect(), vw = document.documentElement.clientWidth || window.innerWidth;
        if (r.right <= 0 || r.left >= vw) continue;
        return t;
      }
    }
    return null;
  }
  function usable(step) { return !step.sel || !!pick(step); }

  // trial:false marks a step about something a FREE-TRIAL studio does not have
  // (studio set-up, branding, import, exports, photo renders, notification
  // settings, templates). html.helm-trial is set by trial-lock.js once the server
  // says the studio is on its free trial; such steps are never shown there.
  function inTrial() { try { return document.documentElement.classList.contains("helm-trial"); } catch (_) { return false; } }
  // r20 coord (b): role-aware steps. A step may carry need: "area" | "edit:area" | "create" (or a list,
  // all must pass) - it is skipped for a role without that access - and uses: [...] for the tokens its
  // alt(can) reads to pick role-appropriate wording (see wording()). Tokens resolve once
  // through BPStore.auth (canView / canEditArea / can) before the tour starts. An unresolved token
  // (no BPStore on the page, auth off) reads as allowed, so admins / owners keep the full wording.
  const access = {};
  function toks(v) { return v == null ? [] : [].concat(v).filter((x) => typeof x === "string" && x); }
  function can(tok) { return access[tok] !== false; }
  function needOk(step) { return toks(step && step.need).every(can); }
  function resolveTok(tok) {
    const A = window.BPStore && window.BPStore.auth;
    if (!A || typeof A.canView !== "function") return Promise.resolve(true);
    return Promise.resolve().then(() => {
      if (tok === "create") return typeof A.can === "function" ? A.can("create") : true;
      if (tok.indexOf("edit:") === 0) return typeof A.canEditArea === "function" ? A.canEditArea(tok.slice(5)) : true;
      return A.canView(tok.indexOf("view:") === 0 ? tok.slice(5) : tok);
    }).then((v) => v === true, () => false);
  }
  function prepare(list) {
    const want = [];
    (list || []).forEach((st) => { if (st) toks(st.need).concat(toks(st.uses)).forEach((t) => { if (!(t in access) && want.indexOf(t) < 0) want.push(t); }); });
    return Promise.all(want.map((t) => resolveTok(t).then((v) => { access[t] = v; })));
  }
  function allowed(step) { return !!step && !(step.trial === false && inTrial()) && needOk(step); }
  // step.alt(can) may return { title?, desc? } for a role that lacks something the admin wording names
  // (payments, revenue, Control Center...); null / nothing = the step's own (admin) wording.
  function wording(step) {
    let o = null;
    try { o = typeof step.alt === "function" ? step.alt(can) : null; } catch (_) { o = null; }
    return { title: (o && o.title) || step.title, desc: (o && o.desc) || step.desc };
  }

  // The steps that would show RIGHT NOW, as indexes into list, in order: allowed,
  // target rendered + visible, and not the very same element as the step before
  // (on a phone two steps can fall back to one "More" button — show it once).
  // Re-evaluated as the tour moves, so an item hidden by trial-lock / the role, or
  // removed from the sidebar, is skipped instead of highlighting nothing, and the
  // "Step 3 of 9" counter only counts what is really on screen.
  function shown() {
    const out = []; let prev = null;
    for (let k = 0; k < list.length; k++) {
      const st = list[k];
      if (!allowed(st)) continue;
      const t = st.sel ? pick(st) : null;
      if (st.sel && !t) continue;
      if (t && t === prev) continue;
      out.push(k); prev = t;
    }
    return out;
  }
  let visCache = null, visAt = 0;
  function shownNow() {
    const now = Date.now();
    if (!visCache || now - visAt > 250) { visCache = shown(); visAt = now; }
    return visCache;
  }
  // next / previous shown step from index `from` (d = +1 / -1); -1 when none
  function nextShown(from, d) {
    const vis = shown(); visCache = vis; visAt = Date.now();
    if (d > 0) { for (const k of vis) if (k > from) return k; return -1; }
    for (let n = vis.length - 1; n >= 0; n--) if (vis[n] < from) return vis[n];
    return -1;
  }
  // "Step n of total" for index i, counting only shown steps
  function counter(idx) {
    const vis = shownNow(); let n = vis.indexOf(idx), total = vis.length;
    if (n < 0) { n = vis.filter(k => k < idx).length; total += 1; }   // current target just vanished: still count it
    return { n: n + 1, total, first: !vis.some(k => k < idx), last: !vis.some(k => k > idx) };
  }

  // ---- pure geometry (exported for tests via HelmTour._layout) -------------
  // r: target rect in VIEWPORT coords (getBoundingClientRect — matches the
  // position:fixed overlay, no scrollX/scrollY mixing); vw/vh: viewport size;
  // tw/th: tip size. Returns ring/tip/arrow boxes, all clamped into the viewport,
  // with the tip flipped to whichever side (below/above/right/left) has room.
  // r === null means "target not visible at this breakpoint" -> centered step.
  // prefer: a side to use when it has room (e.g. "right" for sidebar items, so the
  // card sits beside the rail instead of covering the next menu items).
  function layout(r, vw, vh, tw, th, prefer) {
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
    const fits = { below: room.below >= th + GAP, above: room.above >= th + GAP, right: room.right >= tw + GAP, left: room.left >= tw + GAP };
    let side, maxH = 0;
    if (prefer && fits[prefer]) side = prefer;
    else if (fits.below) side = "below";
    else if (fits.above) side = "above";
    else if (fits.right) side = "right";
    else if (fits.left) side = "left";
    else {
      // nothing fits whole (tall target on a short phone screen): take the larger
      // gap and shrink the card to it (it scrolls; its buttons stay pinned) so the
      // card never covers its target. Only when even a short card cannot fit does it clamp over it.
      side = room.below >= room.above ? "below" : "above";
      const fitH = room[side] - GAP - M;
      if (fitH >= 96) { maxH = fitH; th = fitH; }
    }
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
    const tip = { left: tx, top: ty, width: tw };
    if (maxH) tip.maxHeight = maxH;
    return { centered: false, side, ring, arrow, tip };
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

  let ro = null, rafPending = false, opener = null, placeSeq = 0;
  // B30: a step that is NOT in the sidebar tucks the hover / focus-expanded sidebar (or the phone drawer) away, so
  // it no longer covers the dashboard cards the later steps point at. A pinned sidebar is left alone (it does not
  // cover the page). Undone on a sidebar step and when the tour ends.
  function tuckRail(on) {
    const h = document.documentElement; if (!h || !h.classList) return;
    try { h.classList.toggle("htour-tuck", !!on); } catch (_) { return; }
    if (on) { try { const a = document.activeElement, rail = document.getElementById("hbRail"); if (a && rail && rail.contains(a) && a.blur) a.blur(); } catch (_) {} }
  }
  // R19: a sidebar step opens a slim (unpinned) desktop rail while it shows, without the width animation, so the
  // ring is measured on the real control. Slim, the pin (opacity 0) sat on top of the logo, so the "Keep the
  // sidebar open" step outlined the LOGO instead of the pin; the labels are readable on every sidebar step too.
  function openRail(on) {
    const h = document.documentElement; if (!h || !h.classList) return;
    try { h.classList.toggle("htour-rail", !!on); } catch (_) {}
  }
  function end() {
    const had = !!root;
    tuckRail(false);
    openRail(false);
    if (root) { root.remove(); root = null; }
    visCache = null;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onView);
    window.removeEventListener("scroll", onView, true);
    window.removeEventListener("orientationchange", onView);
    if (window.visualViewport) { visualViewport.removeEventListener("resize", onView); visualViewport.removeEventListener("scroll", onView); }
    if (ro) { ro.disconnect(); ro = null; }
    if (had) { try { localStorage.setItem(endKey, "1"); } catch (_) {} }   // R46: only a tour that really ran is "seen"
    if (had && opener && opener.isConnected) { try { opener.focus({ preventScroll: true }); } catch (_) {} }
    opener = null;
  }
  function go(d) {
    // move to the next / previous step that is really on screen now, skipping any
    // whose target is missing, hidden or not part of this studio's plan
    const j = nextShown(i, d);
    if (j < 0) { if (d > 0) end(); return; }
    i = j; place();
    try { root.querySelector(".next").focus({ preventScroll: true }); } catch (_) {}
  }
  // keyboard while the tour is open: Esc closes, arrows step, Tab stays in the card
  function onKey(e) {
    if (!root) return;
    if (e.key === "Escape") { if (!otherModalOpen()) { e.preventDefault(); e.stopPropagation(); end(); } return; }
    const tip = root.querySelector(".tip");
    const inTip = tip.contains(document.activeElement);
    if (e.key === "ArrowRight" && !e.altKey) { e.preventDefault(); go(1); }
    else if (e.key === "ArrowLeft" && !e.altKey) { e.preventDefault(); go(-1); }
    else if (e.key === "Tab") {
      const btns = Array.prototype.filter.call(tip.querySelectorAll("button"), b => b.offsetParent && getComputedStyle(b).visibility !== "hidden");
      if (!btns.length) return;
      const k = btns.indexOf(document.activeElement);
      if (!inTip) { e.preventDefault(); btns[0].focus(); }
      else if (e.shiftKey && k <= 0) { e.preventDefault(); btns[btns.length - 1].focus(); }
      else if (!e.shiftKey && k === btns.length - 1) { e.preventDefault(); btns[0].focus(); }
    }
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

  // role-aware steps (need / uses) resolve their access first; plain steps start right away
  function start(customSteps, key) {
    if (!customSteps && !PT()) { ensureData(() => { if (PT()) start(null, key); }); return; }
    if (!customSteps) key = key || pageKey();
    const src = customSteps || pageSteps();
    const pending = (src || []).some((st) => st && toks(st.need).concat(toks(st.uses)).some((t) => !(t in access)));
    if (pending) { const seq = ++startSeq; prepare(src).then(() => { if (seq === startSeq) startNow(customSteps, key); }); return; }
    startSeq++; startNow(customSteps, key);
  }
  let startSeq = 0;
  function startNow(customSteps, key) {
    end();
    endKey = key || seenKey;
    // Keep every step this studio's plan allows; whether its target is on screen
    // is decided step by step as the tour moves (shown()), so an element that
    // renders a moment later is still visited and a hidden one is skipped.
    list = (customSteps || pageSteps()).filter(allowed);
    visCache = null;
    const first = nextShown(-1, 1);
    if (first < 0) { list = []; return false; }
    opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    i = first;
    root = document.createElement("div");
    root.className = "htour";
    root.innerHTML = `<div class="ring"></div><div class="arrow">▼</div>
      <div class="tip" role="dialog" aria-modal="false" aria-label="Guided tour" aria-describedby="htourS htourT htourD"><div class="tstep" id="htourS" aria-live="polite" aria-atomic="true"></div><h4 id="htourT"></h4><p id="htourD"></p>
        <div class="trow"><button type="button" class="skip">Skip tour</button><span class="sp"></span>
        <button type="button" class="back">Back</button><button type="button" class="pri next">Next →</button></div></div>`;
    document.body.appendChild(root);
    root.querySelector(".skip").onclick = end;
    root.querySelector(".back").onclick = () => go(-1);
    root.querySelector(".next").onclick = () => go(1);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onView);
    window.addEventListener("scroll", onView, true);   // capture inner-scroll containers too
    window.addEventListener("orientationchange", onView);
    if (window.visualViewport) { visualViewport.addEventListener("resize", onView); visualViewport.addEventListener("scroll", onView); }
    if (typeof ResizeObserver === "function") ro = new ResizeObserver(onView);
    place();
    try { root.querySelector(".next").focus({ preventScroll: true }); } catch (e) {}
    return true;
  }

  // R46 "Tour this page": this page's tour (the section on screen for Control Center). When the page has
  // none, or nothing of it is on screen for this role / plan right now, the fallback list runs instead
  // (the app shell passes its generic tour), so the button never does nothing.
  function startPage(fallback, fallbackKey) {
    ensureData(() => {
      const src = pageSteps(), key = pageKey();
      const run = (s, k) => { const seq = ++startSeq; return prepare(s).then(() => seq === startSeq ? startNow(s, k) : true); };
      (src.length ? run(src, key) : Promise.resolve(false)).then((ok) => {
        if (!ok && fallback && fallback.length) run(fallback, fallbackKey || "helm_tour_shell");
      });
    });
  }
  // has this page's (section's) tour been seen on this device?
  function pageSeen() { try { return !!localStorage.getItem(pageKey()); } catch (_) { return false; } }

  // Pure positioning from the target's CURRENT rect — no scrolling. Safe to call
  // on every scroll/resize frame.
  function position() {
    if (!root) return;
    if (i >= list.length) { end(); return; }
    const step = list[i], el = pick(step), vr = el ? visibleRect(el) : null, tgt = vr ? el : null;
    const de = document.documentElement;
    const vw = de.clientWidth || window.innerWidth, vh = window.innerHeight || de.clientHeight;
    const ring = root.querySelector(".ring");
    const tip = root.querySelector(".tip"), arrow = root.querySelector(".arrow");
    const C = counter(i);
    const stepTxt = `Step ${C.n} of ${C.total}`, tsEl = root.querySelector(".tstep");
    if (tsEl.textContent !== stepTxt) tsEl.textContent = stepTxt;
    const W = wording(step);
    root.querySelector("h4").textContent = W.title;
    root.querySelector("p").textContent = (tgt || !step.sel) ? W.desc
      : W.desc + " (This part isn't shown at the current screen size — widen the window or open the menu to see it.)";
    root.querySelector(".back").style.visibility = C.first ? "hidden" : "visible";
    root.querySelector(".next").textContent = C.last ? "Done" : "Next →";
    tip.style.width = Math.min(320, vw - 24) + "px";
    tip.style.maxHeight = "";   // measure the card's natural height, then let layout() shrink it if needed
    const L = layout(vr, vw, vh, tip.offsetWidth, tip.offsetHeight, step.side);
    tip.style.maxHeight = L.tip.maxHeight ? L.tip.maxHeight + "px" : "";
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

  // r20 (live QA): a target inside a scrolled box (the sidebar list after you scrolled it) was ringed at its visible
  // 18px sliver. Bring it fully inside its nearest scrolling ancestor first - instantly, the box only - before the
  // page-level scrollIntoView below. A no-op when the target already fits.
  function revealInScroller(t) {
    try {
      for (let a = t.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (!/(auto|scroll)/.test(cs.overflowY) || a.scrollHeight <= a.clientHeight + 1) continue;
        const r = t.getBoundingClientRect(), ar = a.getBoundingClientRect(), pad = 12;
        if (r.height + 2 * pad > ar.height) return;
        if (r.top < ar.top + pad) a.scrollTop -= (ar.top + pad - r.top);
        else if (r.bottom > ar.bottom - pad) a.scrollTop += (r.bottom - (ar.bottom - pad));
        return;
      }
    } catch (_) {}
  }

  function place() {
    if (!root) return;
    if (i >= list.length) { end(); return; }
    const tgt = pick(list[i]), seq = ++placeSeq;
    visCache = null;
    tuckRail(!(tgt && tgt.closest && tgt.closest("#hbRail")));
    openRail(!!(tgt && tgt.closest && tgt.closest("#hbRail")));
    observe(tgt);
    let moving = false;
    if (tgt) {
      revealInScroller(tgt);
      // Scroll the target into view BEFORE measuring (only when not already fully on screen).
      const r = tgt.getBoundingClientRect();
      const vr = visibleRect(tgt);   // also catches a pill clipped inside a scrolling nav bar
      if (!vr || vr.width < r.width - 1 || vr.height < r.height - 1 ||
          r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
        const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
        const smooth = !(reduce || document.hidden);
        tgt.scrollIntoView({ block: "center", inline: "center", behavior: smooth ? "smooth" : "auto" });
        moving = smooth;
      }
    }
    // While the page scrolls the target into view the card + arrow stay hidden
    // (the ring stays glued to the target), so the card never flies across the
    // screen; it appears once the target has stopped moving.
    root.classList.toggle("htour-moving", moving);
    const reveal = () => { if (!root || seq !== placeSeq) return; position(); root.classList.remove("htour-moving"); };
    if (moving) setTimeout(reveal, 1200);   // safety net: rAF is throttled in background tabs
    // Position IMMEDIATELY so the ring is never left stranded, even where rAF is
    // throttled (a backgrounded tab) or the scroll jumps instantly. Then REFINE as
    // the smooth scroll progresses: the 'scroll' listener re-glues on every scroll
    // event, and the rAF settle below repositions once the rect stops moving
    // (3 stable frames, ~1s cap). position() is idempotent.
    position();
    if (!tgt) return;
    let lastTop = NaN, stable = 0, frames = 0;
    (function settle() {
      if (!root || seq !== placeSeq) return;
      const top = tgt.getBoundingClientRect().top;
      if (Math.abs(top - lastTop) < 0.5) { if (++stable >= 3) { position(); return reveal(); } }
      else { stable = 0; }
      lastTop = top;
      if (++frames > 60) { position(); return reveal(); }   // ~1s hard cap (60 frames)
      requestAnimationFrame(settle);
    })();
  }

  // another dialog (BPUI overlay, app modal) owns Escape while it is open
  function otherModalOpen() {
    try { return Array.prototype.some.call(document.querySelectorAll('.bpui-overlay, .modal:not([hidden]), .ov, .lightbox, [aria-modal="true"]:not([hidden])'),
      m => !m.closest(".htour") && !!present(m)); }
    catch (e) { return false; }
  }

  /* ---- mount: reuse #helpBtn if present, else a floating button ------- */
  function mount() {
    if (!PT()) return;   // page-tours.js is included just before tour.js wherever a page has its own button
    if (!pageSteps().length) return;   // engine-only page: the page wires its own button
    const ent = pageEntry();
    if (ent && ent.signedIn) {   // client-facing page (the booklet): the button only for a signed-in studio member
      let n = 0;
      (function wait() {
        let u = null; try { const A = window.BPStore && window.BPStore.auth; u = A && typeof A.user === "function" ? A.user() : null; } catch (_) { u = null; }
        if (u) { mountButton(); return; }
        if (++n < 40) setTimeout(wait, 250);
      })();
      return;
    }
    mountButton();
  }
  function mountButton() {
    const existing = document.getElementById("helpBtn");
    if (existing) { existing.addEventListener("click", () => start()); }
    else {
      const fab = document.createElement("button");
      fab.className = "htour-fab"; fab.type = "button";
      fab.textContent = "? Tour"; fab.title = "Tour this page: a quick walk through what is on it";
      fab.setAttribute("aria-label", "Tour this page");
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
        setTimeout(() => {
          const m = present(form.modal); if (!m) return;
          start(form.steps, form.key);
          // the field coach belongs to the modal: stop it as soon as the modal closes (save/cancel),
          // so it never lingers over the board or another dialog
          const mine = root;
          if (typeof MutationObserver === "function") {
            const mo = new MutationObserver(() => { if (root !== mine) { mo.disconnect(); return; } if (!present(form.modal)) { mo.disconnect(); end(); } });
            mo.observe(m, { attributes: true, attributeFilter: ["hidden", "class", "style"] });
          }
        }, 300);
      });
    }

    // NOTE: inner feature pages no longer auto-start a tour. The guided tour
    // auto-runs only on the dashboard (dashboard.html) at first login/signup. Every
    // page still exposes the manual "? Tour" button/FAB (see mount above), so
    // users can launch the tour on demand whenever they need it. (seenKey kept
    // for the form-coaching hints above, which remain click-triggered.)
  }

  window.HelmTour = { start, startPage, pageSeen, end, can, prepare, wording, get hasSteps() { return pageSteps().length > 0; },
    get page() { return page; }, get section() { return pageSection(); }, get seenKey() { return pageKey(); },
    _layout: layout, _present: present, _pick: pick, get _steps() { const P = PT(); return P ? P.TOURS : {}; },
    _shown: (stepsList) => { const keep = list; list = stepsList || []; try { return shown(); } finally { list = keep; } },
    _state: () => ({ i, list }) };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();

/* CSP: style-src-elem carries no 'unsafe-inline', so runtime CSS goes through a
   constructable stylesheet (CSSOM — not an inline <style>, not governed by CSP).
   Falls back to a <style> element only on browsers without adoptedStyleSheets. */
function __helmAdoptCss(doc, css) {
  try {
    var W = doc.defaultView || window;
    if (W.CSSStyleSheet && "adoptedStyleSheets" in doc && "replaceSync" in W.CSSStyleSheet.prototype) {
      var sh = new W.CSSStyleSheet(); sh.replaceSync(css);
      doc.adoptedStyleSheets = Array.prototype.slice.call(doc.adoptedStyleSheets).concat([sh]);
      return true;
    }
  } catch (e) {}
  var st = doc.createElement("style"); st.textContent = css;
  (doc.head || doc.documentElement).appendChild(st);
  return true;
}
