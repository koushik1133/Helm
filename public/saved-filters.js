/* saved-filters.js — saved views / quick filters for list pages (0064).
 * A chip row above the list: built-in presets + the member's own saved views + views an
 * admin shared with the studio. A view captures the page's search / filter / tab state
 * through a tiny per-page adapter (control ids only) and re-applies it by setting the
 * controls and firing their normal input/change/click events, so each page keeps its
 * own loading logic. Deep link: ?view=<uuid> or ?view=preset:<key>.
 * CSP: DOM built with createElement/textContent only; runtime CSS only via window.__helmAdoptCss.
 */
(function (global) {
  "use strict";
  var doc = global.document;
  if (!doc) return;

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ---- per-page adapters: which controls make up the "state" --------------------------
  var PAGES = {
    leads: { search: "search", sel: [], chk: [], tabs: null, presets: [] },
    quotes: {
      search: "search", sel: ["typeFilter"], chk: [], tabs: "tabs",
      presets: [
        { key: "confirmed", name: "Confirmed events", state: { tab: "confirmed" } },
        { key: "attention", name: "Needs attention", state: { tab: "attention" } },
        { key: "archived", name: "Archive", state: { tab: "archived" } },
      ],
    },
    staff: {
      search: "search", sel: ["deptFilter", "skillFilter"], chk: ["showInactive"], tabs: null,
      presets: [{ key: "inactive", name: "Include inactive", state: { chk: { showInactive: true } } }],
    },
    vendors: {
      search: "search", sel: [], chk: ["showInactive"], tabs: null,
      presets: [{ key: "inactive", name: "Include inactive", state: { chk: { showInactive: true } } }],
    },
    inventory: {
      search: "search", sel: ["catFilter", "priFilter"], chk: ["showInactive"], tabs: null, extra: ["low"],
      presets: [
        { key: "low", name: "Low stock", state: { x: "low" } },
        { key: "high", name: "High value (A)", state: { sel: { priFilter: "A" } } },
      ],
    },
  };

  function pageKey(path) {
    var f = String(path || "").split("/").pop().replace(/\.html$/i, "");
    return Object.prototype.hasOwnProperty.call(PAGES, f) ? f : null;
  }

  // ---- state: clean / read / apply ---------------------------------------------------
  function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
  function clean(cfg, s) {
    s = s && typeof s === "object" && !Array.isArray(s) ? s : {};
    var out = { q: str(s.q, 120), sel: {}, chk: {}, tab: "", x: "" };
    cfg.sel.forEach(function (id) { if (s.sel && typeof s.sel[id] === "string") out.sel[id] = s.sel[id].slice(0, 80); });
    cfg.chk.forEach(function (id) { if (s.chk && typeof s.chk[id] === "boolean") out.chk[id] = s.chk[id]; });
    if (cfg.tabs && typeof s.tab === "string" && /^[a-z_]{1,24}$/.test(s.tab)) out.tab = s.tab;
    if (cfg.extra && cfg.extra.indexOf(s.x) >= 0) out.x = s.x;
    return out;
  }
  var current = { page: null, x: "", activeId: "" };

  function el(id) { return doc.getElementById(id); }
  function readState(cfg) {
    var s = { q: "", sel: {}, chk: {}, tab: "", x: current.x || "" };
    var q = el(cfg.search); if (q) s.q = String(q.value || "");
    cfg.sel.forEach(function (id) { var e = el(id); if (e && e.value) s.sel[id] = String(e.value); });
    cfg.chk.forEach(function (id) { var e = el(id); if (e && e.checked) s.chk[id] = true; });
    if (cfg.tabs) { var t = el(cfg.tabs); var on = t && t.querySelector("button.on"); if (on && on.dataset && on.dataset.f && on.dataset.f !== "all") s.tab = on.dataset.f; }
    return clean(cfg, s);
  }
  function fire(e, type) { try { e.dispatchEvent(new global.Event(type, { bubbles: true })); } catch (_) {} }
  function applyState(cfg, raw) {
    var s = clean(cfg, raw);
    current.x = s.x;
    cfg.chk.forEach(function (id) { var e = el(id); var want = !!s.chk[id]; if (e && e.checked !== want) { e.checked = want; fire(e, "change"); } });
    cfg.sel.forEach(function (id) {
      var e = el(id); if (!e) return; var want = s.sel[id] || "";
      if (want && e.options && ![].some.call(e.options, function (o) { return o.value === want; })) {
        var o = doc.createElement("option"); o.value = want; o.textContent = want; e.appendChild(o);   // options may load later
      }
      e.value = want; fire(e, "change");
    });
    if (cfg.tabs) {
      var t = el(cfg.tabs), want = s.tab || "all";
      var b = t && [].filter.call(t.querySelectorAll("button"), function (x) { return x.dataset && x.dataset.f === want && !x.hidden; })[0];
      if (b && !b.classList.contains("on")) b.click();
    }
    var q = el(cfg.search); if (q && q.value !== s.q) { q.value = s.q; fire(q, "input"); }
    if (!cfg.sel.length && !cfg.chk.length && !cfg.tabs && q) fire(q, "input");
    return s;
  }

  // page render hook (inventory): extra preset-only filters that have no visible control
  function match(page, ctx) {
    if (page !== current.page || !current.x) return true;
    if (page === "inventory" && current.x === "low") {
      var i = (ctx && ctx.item) || {}, a = (ctx && ctx.avail) || { available: Number(i.total_qty || 0) };
      var total = Number(i.total_qty || 0), av = Number(a.available);
      return av <= 0 || (total > 0 && av < total * 0.2);
    }
    return true;
  }

  // ---- URL ---------------------------------------------------------------------------
  function viewParam() { try { return new global.URLSearchParams(global.location.search).get("view") || ""; } catch (_) { return ""; } }
  function setViewParam(v) {
    try {
      var u = new global.URL(global.location.href);
      if (v) u.searchParams.set("view", v); else u.searchParams.delete("view");
      global.history.replaceState(global.history.state, "", u.pathname + u.search + u.hash);
    } catch (_) {}
  }

  // ---- UI ----------------------------------------------------------------------------
  var CSS = ".hsf-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 10px;max-width:100%}" +
    ".hsf-lbl{font-size:12px;font-weight:600;color:var(--ink-3,#667085);margin-right:2px}" +
    ".hsf-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line,#e4e7ec);background:var(--panel,#fff);color:var(--ink-2,#344054);" +
    "border-radius:999px;font:inherit;font-size:12px;font-weight:600;padding:5px 11px;cursor:pointer;min-height:30px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".hsf-chip[aria-pressed=true]{background:var(--accent,#6d28d9);border-color:var(--accent,#6d28d9);color:#fff}" +
    ".hsf-chip:focus-visible,.hsf-more:focus-visible,.hsf-menu button:focus-visible{outline:2px solid var(--accent,#6d28d9);outline-offset:2px}" +
    ".hsf-grp{display:inline-flex;align-items:center;position:relative}" +
    ".hsf-more{border:0;background:transparent;color:var(--ink-3,#667085);font:inherit;font-size:14px;cursor:pointer;padding:2px 6px;min-height:30px;border-radius:6px}" +
    ".hsf-save{border-style:dashed}" +
    ".hsf-menu{position:absolute;top:100%;left:0;z-index:40;margin-top:4px;min-width:170px;background:var(--panel,#fff);border:1px solid var(--line,#e4e7ec);border-radius:10px;box-shadow:0 8px 24px rgba(16,24,40,.14);padding:4px;display:flex;flex-direction:column}" +
    ".hsf-menu[hidden]{display:none}" +
    ".hsf-menu button{border:0;background:transparent;text-align:left;font:inherit;font-size:13px;color:var(--ink,#101828);padding:8px 10px;border-radius:7px;cursor:pointer}" +
    ".hsf-menu button:hover{background:var(--panel-2,#f2f4f7)}.hsf-menu .danger{color:#b42318}" +
    ".hsf-tag{font-size:10px;font-weight:700;opacity:.8}" +
    "html[data-theme=dark] .hsf-menu{box-shadow:0 8px 24px rgba(0,0,0,.5)}";

  function Ctl(page, cfg, store, deps) {
    this.page = page; this.cfg = cfg; this.store = store; this.deps = deps || {};
    this.views = []; this.me = null; this.admin = false; this.row = null;
  }
  Ctl.prototype.toast = function (m, err) {
    var ui = global.BPUI; if (ui && typeof ui.toast === "function") ui.toast(m, err ? { type: "err" } : undefined);
  };
  Ctl.prototype.mount = function () {
    var anchor = el(this.cfg.search); if (!anchor) return false;
    var bar = anchor.parentNode; if (!bar || !bar.parentNode) return false;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
    var row = doc.createElement("div");
    row.className = "hsf-row"; row.setAttribute("role", "toolbar"); row.setAttribute("aria-label", "Saved views");
    bar.parentNode.insertBefore(row, bar);
    this.row = row; return true;
  };
  Ctl.prototype.chip = function (label, active, onClick, extraTag) {
    var b = doc.createElement("button"); b.type = "button"; b.className = "hsf-chip";
    b.setAttribute("aria-pressed", String(!!active)); b.textContent = label; b.title = label;
    if (extraTag) { var t = doc.createElement("span"); t.className = "hsf-tag"; t.textContent = extraTag; b.appendChild(t); }
    b.addEventListener("click", onClick); return b;
  };
  Ctl.prototype.render = function () {
    var self = this, row = this.row; if (!row) return;
    while (row.firstChild) row.removeChild(row.firstChild);
    var lbl = doc.createElement("span"); lbl.className = "hsf-lbl"; lbl.textContent = "Views:"; row.appendChild(lbl);
    row.appendChild(this.chip("All", !current.activeId, function () { self.select("", { q: "" }); }));
    this.cfg.presets.forEach(function (p) {
      var id = "preset:" + p.key;
      row.appendChild(self.chip(p.name, current.activeId === id, function () { self.select(id, p.state); }));
    });
    this.views.forEach(function (v) {
      var mine = self.me && v.user_id === self.me;
      var grp = doc.createElement("span"); grp.className = "hsf-grp";
      grp.appendChild(self.chip(v.name, current.activeId === v.id, function () { self.select(v.id, v.state); },
        v.is_default && mine ? " ★" : (v.shared ? " · studio" : "")));
      if (mine) grp.appendChild(self.menu(v));
      row.appendChild(grp);
    });
    if (this.me) {
      var s = this.chip("+ Save view", false, function () { self.saveNew(); });
      s.classList.add("hsf-save"); s.removeAttribute("aria-pressed"); row.appendChild(s);
    }
  };
  Ctl.prototype.menu = function (v) {
    var self = this;
    var wrap = doc.createDocumentFragment();
    var btn = doc.createElement("button"); btn.type = "button"; btn.className = "hsf-more";
    btn.setAttribute("aria-haspopup", "menu"); btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Options for view " + v.name); btn.textContent = "⋯";
    var m = doc.createElement("div"); m.className = "hsf-menu"; m.setAttribute("role", "menu"); m.hidden = true;
    function item(label, fn, danger) {
      var b = doc.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitem"); b.textContent = label;
      if (danger) b.className = "danger";
      b.addEventListener("click", function () { close(); fn(); }); m.appendChild(b);
    }
    function close() { m.hidden = true; btn.setAttribute("aria-expanded", "false"); }
    item("Update with current filters", function () { self.act(self.store.update(v.id, { state: readState(self.cfg) }), "View updated"); });
    item("Rename", function () { self.rename(v); });
    item(v.is_default ? "Clear default" : "Set as default", function () { self.act(self.store.setDefault(v.id, !v.is_default), v.is_default ? "Default cleared" : "Default view set"); });
    if (this.admin) item(v.shared ? "Stop sharing" : "Share with studio", function () { self.act(self.store.update(v.id, { shared: !v.shared }), v.shared ? "No longer shared" : "Shared with your studio"); });
    item("Delete", function () { self.remove(v); }, true);
    btn.addEventListener("click", function () { var open = m.hidden; m.hidden = !open; btn.setAttribute("aria-expanded", String(open)); if (open && m.firstChild) m.firstChild.focus(); });
    m.addEventListener("keydown", function (e) { if (e.key === "Escape") { close(); btn.focus(); } });
    wrap.appendChild(btn); wrap.appendChild(m);
    return wrap;
  };
  Ctl.prototype.select = function (id, state) {
    current.activeId = id || "";
    applyState(this.cfg, state);
    setViewParam(id);
    this.render();
  };
  Ctl.prototype.ask = function (msg, def) { var p = this.deps.prompt || global.prompt; var r = p ? p.call(global, msg, def || "") : null; return r == null ? null : String(r).trim().slice(0, 60); };
  Ctl.prototype.confirm = function (msg) { var c = this.deps.confirm || global.confirm; return c ? !!c.call(global, msg) : false; };
  Ctl.prototype.act = function (p, ok) {
    var self = this;
    return Promise.resolve(p).then(function () { if (ok) self.toast(ok); return self.reload(); })
      .catch(function (e) { self.toast((e && e.code === "25006") ? "Your studio is read-only right now." : "Couldn't save that view. Please try again.", true); });
  };
  Ctl.prototype.saveNew = function () {
    var name = this.ask("Name this view:"); if (!name) return null;
    var shared = this.admin ? this.confirm("Share “" + name + "” with everyone in your studio who can see this page?") : false;
    var self = this;
    return this.act(this.store.save(this.page, name, readState(this.cfg), shared).then(function (v) { if (v && v.id) { current.activeId = v.id; setViewParam(v.id); } }), "View saved");
  };
  Ctl.prototype.rename = function (v) { var n = this.ask("Rename view:", v.name); if (!n || n === v.name) return null; return this.act(this.store.update(v.id, { name: n }), "View renamed"); };
  Ctl.prototype.remove = function (v) {
    if (!this.confirm("Delete the view “" + v.name + "”? Your data is not affected.")) return null;
    if (current.activeId === v.id) { current.activeId = ""; setViewParam(""); }
    return this.act(this.store.remove(v.id), "View deleted");
  };
  Ctl.prototype.reload = function () {
    var self = this;
    return Promise.resolve(this.store.list(this.page)).catch(function () { return []; }).then(function (rows) {
      self.views = (rows || []).filter(function (v) { return v && UUID.test(String(v.id)) && typeof v.name === "string"; });
      self.render(); return self.views;
    });
  };
  Ctl.prototype.start = function () {
    var self = this;
    if (!this.mount()) return Promise.resolve(false);
    this.render();
    return this.reload().then(function () {
      var want = viewParam(), v = null;
      if (/^preset:/.test(want)) {
        var p = self.cfg.presets.filter(function (x) { return "preset:" + x.key === want; })[0];
        if (p) { self.select(want, p.state); return true; }
      }
      if (UUID.test(want)) v = self.views.filter(function (x) { return x.id === want; })[0];
      if (!v && !want) v = self.views.filter(function (x) { return x.is_default && x.user_id === self.me; })[0];
      if (v) self.select(v.id, v.state);
      return true;
    });
  };

  // waits for the page's own sign-in (BPStore.init) so the owner id + role are known
  function boot(tries) {
    var page = pageKey(global.location && global.location.pathname);
    var S = global.BPStore;
    if (!page || !S || !S.savedViews) return;
    var enabled = false, u = null;
    try { enabled = !!(S.auth && S.auth.enabled && S.auth.enabled()); u = enabled ? S.auth.user() : null; } catch (_) {}
    if (enabled && !u && (tries || 0) < 40) { global.setTimeout(function () { boot((tries || 0) + 1); }, 250); return; }
    current.page = page;
    var ctl = new Ctl(page, PAGES[page], S.savedViews);
    ctl.me = u && u.id ? u.id : null;
    global.HelmSavedFilters.ctl = ctl;
    var roleP = (ctl.me && typeof S.auth.role === "function") ? Promise.resolve(S.auth.role()).catch(function () { return null; }) : Promise.resolve(null);
    roleP.then(function (r) { ctl.admin = r === "admin"; return ctl.start(); });
  }

  global.HelmSavedFilters = { PAGES: PAGES, pageKey: pageKey, clean: clean, readState: readState, applyState: applyState, match: match, Ctl: Ctl, _current: current };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { global.setTimeout(function () { boot(0); }, 0); });
  else global.setTimeout(function () { boot(0); }, 0);
})(typeof window !== "undefined" ? window : globalThis);
