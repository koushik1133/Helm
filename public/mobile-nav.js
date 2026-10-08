// Mobile bottom navigation (signed-in studio pages, < 768px).
//  Home · Search · Add (+ sheet of role-allowed quick creates) · Bell · Profile.
//  Reuses the existing chrome: HelmStudioSearch.open(), the bell button (#bpBellBtn,
//  unread in #bpBellDot) and the avatar menu (#hauAccountBtn). Role checks go through
//  BPStore.auth (the access matrix) — the server still enforces everything.
//  No inline styles / innerHTML: CSS via window.__helmAdoptCss, DOM via createElement.
(function (global) {
  "use strict";
  const doc = global.document;
  const BP = 768;
  const NO_PAGES = { hq: 1, login: 1, "reset-password": 1, "profile-setup": 1, index: 1, approve: 1, portal: 1,
    "proposal-view": 1, invite: 1, work: 1, "sim-pay": 1, about: 1, services: 1, privacy: 1, terms: 1, "refund-policy": 1 };
  const CREATES = [
    { id: "new-lead",   label: "New lead",       href: "leads.html?hs_act=new",     need: [["edit", "leads"]] },
    { id: "new-quote",  label: "New quote / event", href: "dashboard.html", need: [["cap", "create"], ["edit", "quotes"]] },
    { id: "new-staff",  label: "Add staff",      href: "staff.html?hs_act=new",     need: [["edit", "staff"]] },
    { id: "new-item",   label: "Add stock item", href: "inventory.html?hs_act=new", need: [["edit", "inventory"]] },
    { id: "new-vendor", label: "Add vendor",     href: "vendors.html?hs_act=new",   need: [["edit", "vendors"]] },
  ];

  function pageKey(loc) {
    try { return ((loc || global.location).pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index"; }
    catch (e) { return "index"; }
  }
  // pure: should the bar exist on this page for this role?
  function eligible(page, role, path) {
    if (NO_PAGES[page]) return false;
    if (path && /^\/(i|p|w|a)\//.test(path)) return false;      // public link paths
    if (role === "client") return false;
    return true;
  }
  // pure: which tab is active for a page
  function activeTab(page) { return page === "dashboard" ? "home" : ""; }
  // pure: keyboard open when the visual viewport is much shorter than the layout viewport
  function keyboardOpen(innerH, vvH) { return !!(innerH && vvH && innerH - vvH > 150); }
  async function allowedCreates(auth) {
    if (!auth) return [];
    const out = [];
    for (const x of CREATES) {
      let ok = true;
      for (const [kind, what] of x.need) {
        try {
          if (kind === "edit") ok = !!(await auth.canEditArea(what));
          else if (kind === "cap") ok = !!(await auth.can(what));
          else ok = !!(await auth.canView(what));
        } catch (e) { ok = false; }
        if (!ok) break;
      }
      if (ok) out.push(x);
    }
    return out;
  }

  const CSS = [
    ".hmn-bar{display:none}",
    "@media (max-width:767.98px){",
    "body.hmn-on{padding-bottom:calc(64px + env(safe-area-inset-bottom,0px))}",
    "body.hmn-on .hss-trig,body.hmn-on #bpBellBtn,body.hmn-on #hauAccountBtn{display:none}",
    "body.hmn-on .hmn-bar{display:flex}",
    "body.hmn-kb .hmn-bar{display:none}",
    "body.hmn-kb.hmn-on{padding-bottom:0}",
    "}",
    ".hmn-bar{position:fixed;left:0;right:0;bottom:0;z-index:900;height:calc(60px + env(safe-area-inset-bottom,0px));padding:0 4px env(safe-area-inset-bottom,0px);background:var(--panel,#fff);border-top:1px solid var(--line,#e8e3db);box-shadow:0 -4px 16px rgba(0,0,0,.06);align-items:stretch;justify-content:space-around}",
    ".hmn-t{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:44px;border:0;background:none;color:var(--ink-3,#6b6577);font:600 11px var(--font,system-ui);cursor:pointer;text-decoration:none;position:relative;padding:6px 0}",
    ".hmn-t svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".hmn-t[aria-current=page],.hmn-t[aria-expanded=true]{color:var(--accent,#6d28d9)}",
    ".hmn-t:focus-visible{outline:2px solid var(--accent,#6d28d9);outline-offset:-4px;border-radius:10px}",
    ".hmn-add .hmn-plus{width:40px;height:40px;border-radius:50%;background:var(--accent,#6d28d9);color:#fff;display:flex;align-items:center;justify-content:center}",
    ".hmn-add .hmn-plus svg{stroke:#fff}",
    ".hmn-badge{position:absolute;top:4px;left:calc(50% + 4px);min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#dc2626;color:#fff;font:700 10px/16px var(--font,system-ui);text-align:center}",
    ".hmn-badge[hidden]{display:none}",
    ".hmn-scrim{position:fixed;inset:0;z-index:950;background:rgba(0,0,0,.4)}",
    ".hmn-scrim[hidden]{display:none}",
    ".hmn-sheet{position:fixed;left:0;right:0;bottom:0;z-index:951;background:var(--panel,#fff);color:var(--ink,#1f1b2d);border-radius:16px 16px 0 0;padding:8px 16px calc(16px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 30px rgba(0,0,0,.2)}",
    ".hmn-sheet[hidden]{display:none}",
    ".hmn-grab{width:40px;height:4px;border-radius:2px;background:var(--line,#e8e3db);margin:4px auto 10px}",
    ".hmn-sheet h2{font:700 15px var(--font,system-ui);margin:0 0 8px}",
    ".hmn-sheet a{display:flex;align-items:center;min-height:48px;padding:0 12px;border-radius:10px;color:inherit;text-decoration:none;font:600 15px var(--font,system-ui)}",
    ".hmn-sheet a:hover,.hmn-sheet a:focus-visible{background:var(--bg-2,rgba(109,40,217,.08));outline:none}",
    ".hmn-empty{color:var(--ink-3,#6b6577);font:500 14px var(--font,system-ui);padding:8px 12px}",
    "@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .hmn-bar,:root:not([data-theme=light]) .hmn-sheet{background:var(--panel,#1c1a24);border-color:var(--line,#2e2b38)}}",
    ":root[data-theme=dark] .hmn-bar,:root[data-theme=dark] .hmn-sheet{background:var(--panel,#1c1a24);border-color:var(--line,#2e2b38)}",
  ].join("\n");

  const ICONS = {
    home: ["M3 11l9-8 9 8", "M5 10v10h14V10"],
    search: ["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14", "M21 21l-4.3-4.3"],
    add: ["M12 5v14", "M5 12h14"],
    bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
    me: ["M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8", "M4 21a8 8 0 0 1 16 0"],
  };
  function el(tag, attrs, text) {
    const n = doc.createElement(tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = String(text);
    return n;
  }
  function icon(name) {
    const s = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    ICONS[name].forEach((d) => { const p = doc.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.appendChild(p); });
    return s;
  }

  const S = { bar: null, sheet: null, scrim: null, addBtn: null, badge: null, lastFocus: null, booted: false };

  function css() {
    if (S.css) return; S.css = true;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
  }
  function tab(id, label, ic, tag) {
    const b = el(tag || "button", tag === "a" ? { class: "hmn-t", href: "dashboard.html" } : { type: "button", class: "hmn-t" });
    b.setAttribute("data-tab", id);
    b.appendChild(icon(ic)); b.appendChild(el("span", null, label));
    return b;
  }
  function openSheet() {
    if (!S.sheet) return;
    S.lastFocus = doc.activeElement;
    S.sheet.hidden = false; S.scrim.hidden = false; S.addBtn.setAttribute("aria-expanded", "true");
    const f = S.sheet.querySelector("a") || S.sheet; try { f.focus(); } catch (e) {}
  }
  function closeSheet(restore) {
    if (!S.sheet || S.sheet.hidden) return;
    S.sheet.hidden = true; S.scrim.hidden = true; S.addBtn.setAttribute("aria-expanded", "false");
    if (restore) try { S.addBtn.focus(); } catch (e) {}
  }
  function fillSheet(list) {
    const box = S.sheetList; box.textContent = "";
    if (!list.length) { box.appendChild(el("p", { class: "hmn-empty" }, "Nothing to create with your access.")); return; }
    list.forEach((x) => { const a = el("a", { href: x.href, "data-create": x.id }, x.label); box.appendChild(a); });
  }
  function syncBadge() {
    const dot = doc.getElementById("bpBellDot");
    const n = dot && !dot.hidden ? (dot.textContent || "").trim() : "";
    if (n && n !== "0") { S.badge.textContent = n; S.badge.hidden = false; S.bell.setAttribute("aria-label", "Notifications, " + n + " unread"); }
    else { S.badge.hidden = true; S.bell.setAttribute("aria-label", "Notifications"); }
  }
  function build() {
    css();
    const nav = el("nav", { class: "hmn-bar", id: "hmnBar", "aria-label": "Quick navigation" });
    const home = tab("home", "Home", "home", "a");
    if (activeTab(pageKey()) === "home") home.setAttribute("aria-current", "page");
    const search = tab("search", "Search", "search");
    search.setAttribute("aria-haspopup", "dialog");
    search.addEventListener("click", () => { const h = global.HelmStudioSearch; if (h && h.open) h.open(); });
    const add = el("button", { type: "button", class: "hmn-t hmn-add", "data-tab": "add", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "hmnSheet", "aria-label": "Create new" });
    const plus = el("span", { class: "hmn-plus" }); plus.appendChild(icon("add")); add.appendChild(plus);
    add.addEventListener("click", () => { if (S.sheet.hidden) openSheet(); else closeSheet(true); });
    const bell = tab("bell", "Alerts", "bell");
    bell.setAttribute("aria-haspopup", "dialog");
    const badge = el("span", { class: "hmn-badge", "aria-hidden": "true" }); badge.hidden = true; bell.appendChild(badge);
    bell.addEventListener("click", () => { const b = doc.getElementById("bpBellBtn"); if (b) b.click(); });
    const me = tab("me", "Profile", "me");
    me.setAttribute("aria-haspopup", "menu");
    me.addEventListener("click", (e) => { e.stopPropagation(); const b = doc.getElementById("hauAccountBtn"); if (b) b.click(); });
    [home, search, add, bell, me].forEach((t) => nav.appendChild(t));

    const scrim = el("div", { class: "hmn-scrim" }); scrim.hidden = true;
    scrim.addEventListener("click", () => closeSheet(true));
    const sheet = el("div", { class: "hmn-sheet", id: "hmnSheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "hmnSheetT", tabindex: "-1" });
    sheet.hidden = true;
    sheet.appendChild(el("div", { class: "hmn-grab", "aria-hidden": "true" }));
    sheet.appendChild(el("h2", { id: "hmnSheetT" }, "Create"));
    const list = el("div", { class: "hmn-list" }); sheet.appendChild(list);
    sheet.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeSheet(true); }
      else if (e.key === "Tab") {
        const it = Array.prototype.slice.call(sheet.querySelectorAll("a")); if (!it.length) { e.preventDefault(); return; }
        const i = it.indexOf(doc.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); it[it.length - 1].focus(); }
        else if (!e.shiftKey && i === it.length - 1) { e.preventDefault(); it[0].focus(); }
      }
    });
    Object.assign(S, { bar: nav, sheet, scrim, addBtn: add, badge, bell, sheetList: list });
    doc.body.appendChild(nav); doc.body.appendChild(scrim); doc.body.appendChild(sheet);
    fillSheet([]);
  }

  async function boot() {
    if (S.booted || !doc || !doc.body) return S.booted;
    const st = global.BPStore, a = st && st.auth;
    const u = a && a.user ? a.user() : null;
    if (!u) return false;
    let role = a.cachedRole ? a.cachedRole() : null;
    if (!role && a.role) { try { role = await a.role(); } catch (e) { role = null; } }
    if (!eligible(pageKey(), role, global.location && global.location.pathname)) { S.booted = true; return true; }
    S.booted = true;
    build();
    doc.body.classList.add("hmn-on");
    allowedCreates(a).then(fillSheet).catch(() => {});
    syncBadge();
    try {
      const dot = doc.getElementById("bpBellDot");
      if (dot && global.MutationObserver) new global.MutationObserver(syncBadge).observe(dot, { attributes: true, childList: true, characterData: true, subtree: true });
      else setInterval(syncBadge, 5000);
    } catch (e) {}
    const vv = global.visualViewport;
    if (vv) {
      const kb = () => { doc.body.classList.toggle("hmn-kb", keyboardOpen(global.innerHeight, vv.height)); if (doc.body.classList.contains("hmn-kb")) closeSheet(false); };
      vv.addEventListener("resize", kb);
    }
    return true;
  }
  function auto() {
    let tries = 0;
    (function go() { boot().then((ok) => { if (!ok && tries++ < 30) setTimeout(go, 400); }).catch(() => {}); })();
  }
  if (doc && doc.addEventListener) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", auto); else auto(); }

  const api = { boot, eligible, activeTab, keyboardOpen, allowedCreates, openSheet, closeSheet, CREATES, BP, _css: CSS, _state: S };
  global.HelmMobileNav = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
