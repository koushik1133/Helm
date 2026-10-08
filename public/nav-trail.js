/* Helm nav trail — breadcrumbs under the top bar + "Recent" records menu.
 * Loaded by store-api.js on signed-in studio pages (same gate as studio-search.js).
 *  - Pages call window.HelmTrail.setCurrent({ title, kind, href }) once a record is open
 *    (store-api defines a queueing stub so calls before this file loads are not lost).
 *  - Recent records: last 10, per user + org, localStorage (try/catch; never required),
 *    cleared on sign out (store-api removes every helm_trail_* key).
 *  - HelmTrail.recent() feeds studio-search's empty state.
 * No HTML-string sinks / inline style: DOM via textContent, CSS via __helmAdoptCss. */
(function (global) {
  "use strict";
  const doc = global.document || null;
  const MAX = 10;
  const PREFIX = "helm_trail_";
  const NOT_HERE = { hq: 1, login: 1, "reset-password": 1, "profile-setup": 1 };

  // page -> [section label, section href, optional leaf label]
  const PAGES = {
    dashboard: ["Dashboard", "dashboard.html"], index: ["Dashboard", "dashboard.html"],
    quotes: ["Quotes", "quotes.html"], event: ["Quotes", "quotes.html"], builder: ["Quotes", "quotes.html", "Floor plan"],
    design: ["Quotes", "quotes.html", "Design"], plan: ["Quotes", "quotes.html", "Plan"], budget: ["Quotes", "quotes.html", "Budget"],
    runsheet: ["Quotes", "quotes.html", "Run sheet"], logistics: ["Quotes", "quotes.html", "Logistics"],
    settlement: ["Quotes", "quotes.html", "Settlement"], closure: ["Quotes", "quotes.html", "Closure"],
    teardown: ["Quotes", "quotes.html", "Teardown"], proposal: ["Quotes", "quotes.html", "Proposal"],
    "invite-studio": ["Quotes", "quotes.html", "Invitation"], ready: ["Quotes", "quotes.html", "Readiness"],
    leads: ["Leads", "leads.html"], crm: ["CRM", "crm.html"], nurture: ["Leads", "leads.html", "Nurture"], discovery: ["Leads", "leads.html", "Discovery"],
    calendar: ["Calendar", "calendar.html"], staff: ["Staff", "staff.html"], vendors: ["Vendors", "vendors.html"],
    inventory: ["Inventory", "inventory.html"], resources: ["Resources", "resources.html"], ops: ["Operations", "ops.html"],
    command: ["Operations", "ops.html", "Command"], flow: ["Operations", "ops.html", "Flow"], issues: ["Operations", "ops.html", "Issues"],
    reports: ["Reports", "reports.html"], insights: ["Reports", "reports.html", "Insights"], audit: ["Settings", "control.html", "Audit log"],
    control: ["Settings", "control.html"], templates: ["Settings", "control.html", "Templates"], services: ["Settings", "control.html", "Services"],
    media: ["Media", "media.html"], chat: ["Chat", "chat.html"], manual: ["Help", "manual.html"],
  };
  const ICONS = { event: "📅", quote: "📅", lead: "👤", builder: "📐", vendor: "🏷️", staff: "🧑", record: "📄" };
  const KIND_LABEL = { event: "Event", quote: "Quote", lead: "Lead", builder: "Floor plan", vendor: "Vendor", staff: "Staff", record: "Record" };

  function pageKey() {
    try { return (global.location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index"; } catch (e) { return "index"; }
  }
  function clean(s, n) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 120); }
  // own pages only: relative "x.html?..." with no scheme / protocol-relative / backslashes
  function safeHref(h) {
    const s = String(h == null ? "" : h).trim();
    if (!s || s.length > 400) return "";
    if (!/^\/?[a-z0-9-]+\.html(?:[?#][^\s\\]*)?$/i.test(s)) return "";
    return s.charAt(0) === "/" ? s.slice(1) : s;
  }
  function kindOf(k) { k = String(k || "").toLowerCase(); return ICONS[k] ? k : "record"; }

  /* ---- storage ---------------------------------------------------------- */
  let orgId = "";
  function userId() { try { const st = global.BPStore; const u = st && st.auth && st.auth.user && st.auth.user(); return (u && u.id) || ""; } catch (e) { return ""; } }
  function key() { const u = userId(); return u ? PREFIX + u + "_" + (orgId || "none") : ""; }
  function recent() {
    const k = key(); if (!k) return [];
    try {
      const v = JSON.parse(global.localStorage.getItem(k) || "[]");
      if (!Array.isArray(v)) return [];
      return v.filter((r) => r && typeof r.title === "string" && safeHref(r.href)).slice(0, MAX)
        .map((r) => ({ title: clean(r.title), kind: kindOf(r.kind), href: safeHref(r.href), at: Number(r.at) || 0 }));
    } catch (e) { return []; }
  }
  function remember(rec) {
    const k = key(); if (!k) return;
    try {
      const list = [rec].concat(recent().filter((r) => r.href !== rec.href)).slice(0, MAX);
      global.localStorage.setItem(k, JSON.stringify(list));
    } catch (e) {}
  }
  function clearAll() {
    try {
      const ls = global.localStorage, del = [];
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.indexOf(PREFIX) === 0) del.push(k); }
      del.forEach((k) => ls.removeItem(k));
    } catch (e) {}
  }
  function timeAgo(at, now) {
    const s = Math.max(0, Math.round(((now || Date.now()) - at) / 1000));
    if (!at) return "";
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    const d = Math.floor(s / 86400); return d === 1 ? "yesterday" : d + "d ago";
  }

  /* ---- trail model ------------------------------------------------------ */
  let current = null;
  function trail(page, cur) {
    const p = PAGES[page || pageKey()];
    if (!p) return cur ? [{ label: cur.title, href: "" }] : [];
    const out = [{ label: p[0], href: p[1] }];
    if (cur && cur.title) out.push({ label: cur.title, href: p[2] ? (cur.recordHref || "") : "" });
    if (p[2]) out.push({ label: p[2], href: "" });
    if (out.length === 1) out[0] = { label: p[0], href: "" };
    return out;
  }
  function setCurrent(o) {
    if (!o || !o.title) return;
    // "CODE CODE" (event with no separate name) -> "CODE"
    { const t = String(o.title).trim(), h = t.split(/\s+/); if (h.length % 2 === 0 && h.length) { const a = h.slice(0, h.length / 2).join(" "); if (a === h.slice(h.length / 2).join(" ")) o = Object.assign({}, o, { title: a }); } }
    if (!booted) { (global.__helmTrailQ = global.__helmTrailQ || []).push(o); return; }
    const kind = kindOf(o.kind);
    let href = safeHref(o.href);
    if (!href) { try { href = safeHref(pageKey() + ".html" + global.location.search); } catch (e) {} }
    current = { title: clean(o.title), kind, href, recordHref: safeHref(o.recordHref) };
    if (href) remember({ title: current.title, kind, href, at: Date.now() });
    renderTrail();
  }

  /* ---- styles ----------------------------------------------------------- */
  const CSS = [
    ".htr-bc{display:flex;align-items:center;gap:6px;min-width:0;padding:6px 16px;font-size:13px;color:var(--muted,#6b7280);border-bottom:1px solid var(--line,var(--border,rgba(127,127,127,.2)));background:var(--bg,transparent)}",
    ".htr-bc ol{display:flex;align-items:center;gap:6px;list-style:none;margin:0;padding:0;min-width:0;overflow:hidden}",
    ".htr-bc li{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}",
    ".htr-bc li+li::before{content:'/';opacity:.5}",
    ".htr-bc a{color:inherit;text-decoration:none;border-radius:4px}",
    ".htr-bc a:hover{color:var(--ink,var(--text,inherit));text-decoration:underline}",
    ".htr-bc a:focus-visible,.htr-back:focus-visible,.htr-btn:focus-visible,.htr-it:focus-visible{outline:2px solid var(--accent,#6366f1);outline-offset:2px}",
    ".htr-bc [aria-current]{color:var(--ink,var(--text,inherit));font-weight:600;overflow:hidden;text-overflow:ellipsis}",
    ".htr-back{display:none;background:none;border:0;color:inherit;font:inherit;font-size:18px;line-height:1;cursor:pointer;padding:4px 6px;min-width:36px;min-height:36px}",
    "@media (max-width:640px){.htr-bc li{display:none}.htr-bc li:last-child{display:flex}.htr-bc li+li::before{content:none}.htr-back{display:inline-flex;align-items:center;justify-content:center}}",
    ".htr-w{position:relative}",
    ".htr-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;border:1px solid var(--line,var(--border,rgba(127,127,127,.25)));background:var(--card,var(--panel,transparent));color:var(--ink,var(--text,inherit));cursor:pointer}",
    ".htr-btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}",
    ".htr-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:60;width:320px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;background:var(--card,var(--panel,#fff));color:var(--ink,var(--text,#111));border:1px solid var(--line,var(--border,rgba(127,127,127,.25)));border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:6px}",
    ".htr-pop[hidden]{display:none}",
    ".htr-h{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#6b7280);padding:6px 8px}",
    ".htr-it{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;color:inherit;text-decoration:none;min-height:40px}",
    ".htr-it:hover,.htr-it:focus{background:var(--hover,rgba(127,127,127,.12))}",
    ".htr-ii{width:22px;text-align:center;flex:none}",
    ".htr-tx{display:flex;flex-direction:column;min-width:0;flex:1}",
    ".htr-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".htr-s{font-size:12px;color:var(--muted,#6b7280)}",
    ".htr-e{padding:12px 8px;font-size:13px;color:var(--muted,#6b7280)}",
  ].join("\n");
  let cssDone = false;
  function css() { if (cssDone || !doc) return; cssDone = true; if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS); }

  function el(tag, attrs, text) {
    const n = doc.createElement(tag);
    if (attrs) for (const k in attrs) { if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? "" : String(attrs[k])); }
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clockIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const s = doc.createElementNS(NS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    const c = doc.createElementNS(NS, "circle"); c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "9");
    const p = doc.createElementNS(NS, "path"); p.setAttribute("d", "M12 7v5l3 2");
    s.appendChild(c); s.appendChild(p); return s;
  }

  /* ---- breadcrumbs ------------------------------------------------------ */
  let nav = null;
  function renderTrail() {
    if (!doc || !booted) return;
    const tb = doc.getElementById("hauTopbar");
    if (!tb) return;
    css();
    const items = trail(pageKey(), current);
    if (!items.length) { if (nav) nav.remove(); return; }
    if (!nav) nav = el("nav", { class: "htr-bc", id: "helmTrail", "aria-label": "Breadcrumb" });
    nav.textContent = "";
    const back = el("button", { type: "button", class: "htr-back", "aria-label": "Back" }, "←");
    const up = items.length > 1 ? items[items.length - 2].href || items[0].href : "";
    back.addEventListener("click", () => { try { if (global.history.length > 1) global.history.back(); else if (up) global.location.href = up; } catch (e) {} });
    if (items.length > 1) nav.appendChild(back);
    const ol = el("ol");
    items.forEach((it, i) => {
      const li = el("li");
      const last = i === items.length - 1;
      if (!last && it.href) li.appendChild(el("a", { href: it.href }, it.label));
      else li.appendChild(el("span", last ? { "aria-current": "page" } : null, it.label));
      ol.appendChild(li);
    });
    nav.appendChild(ol);
    // place directly under the header row that holds the top bar
    const host = (tb.closest && tb.closest("header")) || (tb.parentNode && tb.parentNode.parentNode !== doc.body ? tb.parentNode : null) || tb.parentNode;
    if (host && host.parentNode && nav.previousSibling !== host) host.parentNode.insertBefore(nav, host.nextSibling);
  }

  /* ---- Recent menu ------------------------------------------------------ */
  const R = { wrap: null, btn: null, pop: null, open: false };
  function renderPop() {
    const pop = R.pop; pop.textContent = "";
    pop.appendChild(el("div", { class: "htr-h", id: "htrHead" }, "Recently opened"));
    const list = recent();
    if (!list.length) { pop.appendChild(el("div", { class: "htr-e" }, "Records you open will show up here.")); return; }
    const now = Date.now();
    list.forEach((r) => {
      const a = el("a", { class: "htr-it", href: r.href, role: "menuitem" });
      a.appendChild(el("span", { class: "htr-ii", "aria-hidden": "true" }, ICONS[r.kind]));
      const tx = el("span", { class: "htr-tx" });
      tx.appendChild(el("span", { class: "htr-t" }, r.title));
      tx.appendChild(el("span", { class: "htr-s" }, KIND_LABEL[r.kind] + (r.at ? " · " + timeAgo(r.at, now) : "")));
      a.appendChild(tx); pop.appendChild(a);
    });
  }
  function setOpen(on, focusFirst) {
    R.open = on; R.pop.hidden = !on; R.btn.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) { renderPop(); const f = focusFirst && R.pop.querySelector(".htr-it"); if (f) f.focus(); }
  }
  function placeRecent() {
    const tb = doc.getElementById("hauTopbar");
    if (!tb) return;
    css();
    if (!R.wrap) {
      R.wrap = el("div", { class: "htr-w" });
      R.btn = el("button", { type: "button", class: "htr-btn", id: "htrRecentBtn", "aria-haspopup": "menu", "aria-expanded": "false",
        "aria-controls": "htrRecent", "aria-label": "Recently opened records", title: "Recent" });
      R.btn.appendChild(clockIcon());
      R.pop = el("div", { class: "htr-pop", id: "htrRecent", role: "menu", "aria-labelledby": "htrHead" }); R.pop.hidden = true;
      R.wrap.appendChild(R.btn); R.wrap.appendChild(R.pop);
      R.btn.addEventListener("click", () => setOpen(!R.open, false));
      R.btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true, true); } });
      R.pop.addEventListener("keydown", (e) => {
        const items = Array.prototype.slice.call(R.pop.querySelectorAll(".htr-it"));
        const i = items.indexOf(doc.activeElement);
        if (e.key === "Escape") { e.preventDefault(); setOpen(false); R.btn.focus(); }
        else if (e.key === "ArrowDown" && items.length) { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      });
      doc.addEventListener("click", (e) => { if (R.open && R.wrap && !R.wrap.contains(e.target)) setOpen(false); });
    }
    if (R.wrap.parentNode === tb) return;
    const mw = tb.querySelector(".hau-mw");
    tb.insertBefore(R.wrap, mw || null);
  }

  /* ---- boot ------------------------------------------------------------- */
  let booted = false, booting = false;
  async function boot() {
    if (booted || booting || !doc || NOT_HERE[pageKey()]) return booted;
    const st = global.BPStore;
    if (!st || !st.auth || typeof st.mode !== "function" || st.mode() !== "supabase" || !st.auth.user || !st.auth.user()) return false;
    booting = true;
    try {
      let role = null; try { role = await st.auth.role(); } catch (e) {}
      if (!role || role === "client") return false;
      try { orgId = (st.org && (await st.org.id())) || ""; } catch (e) { orgId = ""; }
      booted = true;
      // replay calls made before this file loaded
      const q = global.__helmTrailQ; global.__helmTrailQ = null;
      if (Array.isArray(q)) q.forEach((o) => setCurrent(o));
      const tick = () => { placeRecent(); renderTrail(); };
      tick();
      try {
        let pending = false;
        new MutationObserver(() => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (!doc.getElementById("helmTrail") || !(R.wrap && R.wrap.isConnected)) tick(); }, 120); })
          .observe(doc.body, { childList: true, subtree: true });
      } catch (e) {}
      return true;
    } finally { booting = false; }
  }
  function auto() {
    let tries = 0;
    (function go() { boot().then((ok) => { if (!ok && !booted && tries++ < 30) setTimeout(go, 400); }).catch(() => {}); })();
  }
  if (doc) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", auto); else auto(); }

  const api = { setCurrent, recent, clearAll, trail, timeAgo, safeHref, boot, PAGES, ICONS, KIND_LABEL, MAX, PREFIX, _css: CSS, _key: key };
  global.HelmTrail = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
