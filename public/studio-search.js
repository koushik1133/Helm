/* =========================================================================
   HELM — universal studio search (0061)
   -------------------------------------------------------------------------
   • Top-bar trigger (mounted into #helm-topbar-search when the page has one,
     otherwise a small slot just left of the account chip) + a Cmd/Ctrl+K
     command palette (also "/" when you are not typing in a field).
   • Results come from studio_search() via BPStore.search(): grouped by kind,
     only the caller's own studio, only the areas their role may view. Before
     0061 is applied the store answers {} and the palette shows "no matches".
   • Quick actions ("New lead", "Go to calendar"…) are filtered by the same
     access checks the pages use (BPStore.auth.canView / canEditArea / can).
   • Recent searches: this browser only, per signed-in user, try/catch storage.
   • a11y: role=combobox input + role=listbox with grouped role=option rows,
     aria-activedescendant; ↑/↓ move, Enter opens, Tab / Shift+Tab jump
     between groups, Esc closes and gives focus back.
   • CSP: no inline style attributes, no HTML string sinks — DOM nodes + textContent
     only; runtime CSS via window.__helmAdoptCss.
   ========================================================================= */
(function (global) {
  "use strict";

  const MIN = 2, MAX = 80, DEBOUNCE = 200, RECENT_MAX = 6;
  const NOT_HERE = { hq: 1, login: 1, "reset-password": 1, "profile-setup": 1, index: 1, approve: 1, portal: 1,
    "proposal-view": 1, invite: 1, work: 1, "sim-pay": 1, about: 1, services: 1, privacy: 1, terms: 1, "refund-policy": 1 };

  // kind → label + icon (order = display order)
  const TYPES = [
    { key: "events",    label: "Events & quotes", icon: "📋" },
    { key: "leads",     label: "Leads",           icon: "🎯" },
    { key: "staff",     label: "Staff",           icon: "👷" },
    { key: "team",      label: "Team members",    icon: "👥" },
    { key: "vendors",   label: "Vendors",         icon: "🤝" },
    { key: "inventory", label: "Inventory",       icon: "📦" },
    { key: "payments",  label: "Payments",        icon: "🧾" },
  ];
  // quick actions: `need` = [kind, area] checked through BPStore.auth
  const ACTIONS = [
    { id: "new-lead",   label: "New lead",           icon: "➕", href: "leads.html?hs_act=new",     need: [["edit", "leads"]],  kw: "add create enquiry" },
    { id: "new-quote",  label: "New quote",          icon: "✨", href: "dashboard.html",            need: [["cap", "create"], ["edit", "quotes"]], kw: "create event estimate" },
    { id: "new-staff",  label: "Add staff",          icon: "➕", href: "staff.html?hs_act=new",     need: [["edit", "staff"]],  kw: "crew create" },
    { id: "new-item",   label: "Add stock item",     icon: "➕", href: "inventory.html?hs_act=new", need: [["edit", "inventory"]], kw: "inventory create" },
    { id: "new-vendor", label: "Add vendor",         icon: "➕", href: "vendors.html?hs_act=new",   need: [["edit", "vendors"]], kw: "partner supplier create" },
    { id: "go-dash",    label: "Go to dashboard",    icon: "🏠", href: "dashboard.html",            need: [],                   kw: "home" },
    { id: "go-cal",     label: "Go to calendar",     icon: "📅", href: "calendar.html",             need: [["view", "calendar"]], kw: "schedule dates" },
    { id: "go-quotes",  label: "Go to quotes",       icon: "📋", href: "quotes.html",               need: [["view", "quotes"]], kw: "events" },
    { id: "go-leads",   label: "Go to leads",        icon: "🎯", href: "leads.html",                need: [["view", "leads"]],  kw: "pipeline" },
    { id: "go-staff",   label: "Go to staff",        icon: "👷", href: "staff.html",                need: [["view", "staff"]],  kw: "crew" },
    { id: "go-inv",     label: "Go to inventory",    icon: "📦", href: "inventory.html",            need: [["view", "inventory"]], kw: "stock" },
    { id: "go-vendors", label: "Go to vendors",      icon: "🤝", href: "vendors.html",              need: [["view", "vendors"]], kw: "partners" },
    { id: "go-chat",    label: "Open team chat",     icon: "💬", href: "chat.html",                 need: [],                   kw: "messages" },
    { id: "go-control", label: "Open Control Center", icon: "⚙", href: "control.html",              need: [["view", "controls"]], kw: "settings access" },
  ];

  const doc = global.document;
  const isMac = (() => { try { return /Mac|iPhone|iPad/.test(global.navigator.platform || global.navigator.userAgent || ""); } catch (e) { return false; } })();

  /* ---- pure helpers (exported for tests) ------------------------------- */
  function cleanQuery(q) { return String(q == null ? "" : q).replace(/\s+/g, " ").trim().slice(0, MAX); }
  // only the app's own pages: "<page>.html" plus a simple query / hash
  const LINK_RE = /^[a-z][a-z0-9-]*\.html(?:[?#][A-Za-z0-9_\-=&.#%]*)?$/;
  function safeLink(link, title) {
    const l = String(link || "");
    if (!LINK_RE.test(l)) return null;
    // list pages have no per-record URL: hand the title to the page's own search box
    return /[?&]hs=$/.test(l) ? l + encodeURIComponent(String(title || "").slice(0, MAX)) : l;
  }
  function normalize(data) {
    const out = [];
    if (!data || typeof data !== "object" || Array.isArray(data)) return out;
    TYPES.forEach((t) => {
      const rows = Array.isArray(data[t.key]) ? data[t.key] : [];
      const items = [];
      rows.forEach((r) => {
        if (!r || r.id == null || r.title == null) return;
        const href = safeLink(r.link, r.title);
        if (!href) return;
        items.push({ id: String(r.id), title: String(r.title), subtitle: r.subtitle == null ? "" : String(r.subtitle), href });
      });
      if (items.length) out.push({ type: t.key, label: t.label, icon: t.icon, items });
    });
    // 0062: leads and events also open their client's one-page timeline (client.html?id=)
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const clients = [];
    out.forEach((g) => {
      if (g.type !== "leads" && g.type !== "events") return;
      g.items.forEach((it) => {
        if (clients.length < 3 && UUID.test(it.id)) clients.push({ id: "c:" + it.id, title: it.title, subtitle: "Client page", href: "client.html?id=" + it.id });
      });
    });
    if (clients.length) out.push({ type: "clients", label: "Client pages", icon: "🧑", items: clients });
    return out;
  }
  // split text into [{t, hit}] runs for highlighting (case-insensitive, every occurrence)
  function highlight(text, q) {
    const s = String(text == null ? "" : text), needle = cleanQuery(q).toLowerCase();
    if (needle.length < 1) return [{ t: s, hit: false }];
    const low = s.toLowerCase(), parts = [];
    let i = 0;
    while (i <= s.length) {
      const j = low.indexOf(needle, i);
      if (j < 0) { if (i < s.length) parts.push({ t: s.slice(i), hit: false }); break; }
      if (j > i) parts.push({ t: s.slice(i, j), hit: false });
      parts.push({ t: s.slice(j, j + needle.length), hit: true });
      i = j + needle.length;
    }
    return parts.length ? parts : [{ t: s, hit: false }];
  }
  function matchAction(a, q) {
    const n = cleanQuery(q).toLowerCase();
    if (!n) return true;
    return (a.label + " " + a.kw).toLowerCase().split(" ").some((w) => w.startsWith(n)) || a.label.toLowerCase().includes(n);
  }

  /* ---- storage (recent searches; never required) ----------------------- */
  function recentKey() {
    let u = "";
    try { const st = global.BPStore; const usr = st && st.auth && st.auth.user && st.auth.user(); u = (usr && usr.id) || ""; } catch (e) {}
    return "helm_ss_recent_" + u;
  }
  function recentGet() {
    try { const v = JSON.parse(global.localStorage.getItem(recentKey()) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : []; }
    catch (e) { return []; }
  }
  function recentAdd(q) {
    const c = cleanQuery(q); if (c.length < MIN) return;
    try {
      const list = [c].concat(recentGet().filter((x) => x.toLowerCase() !== c.toLowerCase())).slice(0, RECENT_MAX);
      global.localStorage.setItem(recentKey(), JSON.stringify(list));
    } catch (e) {}
  }
  function recentClear() { try { global.localStorage.removeItem(recentKey()); } catch (e) {} }

  /* ---- styles ------------------------------------------------------------- */
  const CSS = [
    "html.hss-lock{overflow:hidden}",
    ".hss-slot{display:inline-flex;align-items:center;margin-right:8px}",
    ".hss-trig{display:inline-flex;align-items:center;gap:8px;height:32px;min-width:200px;padding:0 8px 0 10px;border:1px solid var(--line,#e8e3db);border-radius:9px;background:var(--panel,#fff);color:var(--ink-3,#6b6577);font:500 13px var(--font,system-ui);cursor:pointer;transition:border-color .12s,box-shadow .12s}",
    ".hss-trig:hover{border-color:var(--accent,#6d28d9)}",
    ".hss-trig:focus-visible{outline:2px solid var(--accent,#6d28d9);outline-offset:2px}",
    ".hss-trig .hss-tl{flex:1;text-align:left}",
    ".hss-kbd{display:inline-flex;align-items:center;gap:2px;font:600 11px var(--mono,ui-monospace,monospace);color:var(--ink-3,#6b6577);border:1px solid var(--line,#e8e3db);border-bottom-width:2px;border-radius:5px;padding:1px 5px;background:var(--panel-2,#faf8f5);white-space:nowrap}",
    ".hss-ico{width:16px;height:16px;flex:0 0 auto;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round}",
    ".hss-ov{position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:center;align-items:flex-start;padding:12vh 16px 16px;background:rgba(17,15,30,.42);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);animation:hssFade .12s ease-out}",
    ".hss-dlg{width:min(640px,100%);max-height:min(560px,76vh);display:flex;flex-direction:column;background:var(--panel,#fff);color:var(--ink,#1b1930);border:1px solid var(--line,#e8e3db);border-radius:14px;box-shadow:0 24px 70px rgba(20,16,40,.32),0 2px 6px rgba(20,16,40,.12);overflow:hidden;font-family:var(--font,system-ui);animation:hssPop .14s ease-out}",
    ".hss-in-row{display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--line,#e8e3db)}",
    ".hss-in-row .hss-ico{width:18px;height:18px;color:var(--ink-3,#6b6577)}",
    ".hss-in{flex:1;min-width:0;height:54px;border:0;outline:0;background:transparent;color:var(--ink,#1b1930);font:400 16px var(--font,system-ui)}",
    // the field is the dialog's only focus target: its focus indicator is the accent rule
    // under the row (theme.css's global input ring would draw a box inside the header)
    ".hss-in-row{box-shadow:inset 0 -2px 0 transparent;transition:box-shadow .12s}",
    ".hss-in-row:focus-within{box-shadow:inset 0 -2px 0 var(--accent,#6d28d9)}",
    ".hss-dlg .hss-in:focus,.hss-dlg .hss-in:focus-visible{outline:none!important;box-shadow:none}",
    "html[data-theme=dark] .hss-dlg input.hss-in{background-color:transparent}",
    ".hss-in::placeholder{color:var(--ink-3,#6b6577)}",
    ".hss-in::-webkit-search-cancel-button{display:none}",
    ".hss-x{border:0;background:transparent;color:var(--ink-3,#6b6577);font:600 12px var(--font,system-ui);cursor:pointer;padding:6px;border-radius:6px}",
    ".hss-x:focus-visible{outline:2px solid var(--accent,#6d28d9)}",
    ".hss-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--line,#e8e3db);border-top-color:var(--accent,#6d28d9);animation:hssSpin .7s linear infinite;flex:0 0 auto}",
    ".hss-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:6px 0 8px}",
    ".hss-grp{padding:4px 0}",
    ".hss-gh{display:flex;align-items:center;gap:8px;padding:8px 16px 4px;font:700 11px var(--font,system-ui);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3,#6b6577)}",
    ".hss-gh button{margin-left:auto;border:0;background:none;color:var(--ink-3,#6b6577);font:500 11.5px var(--font,system-ui);text-transform:none;letter-spacing:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}",
    ".hss-opt{display:flex;align-items:center;gap:11px;margin:0 6px;padding:8px 10px;border-radius:9px;cursor:pointer;min-height:44px}",
    ".hss-opt[aria-selected=true]{background:var(--accent-soft,#efe9ff)}",
    ".hss-oi{flex:0 0 auto;width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:var(--panel-2,#faf8f5);border:1px solid var(--line-2,#f1ede7);font-size:14px}",
    ".hss-ot{flex:1;min-width:0;display:flex;flex-direction:column}",
    ".hss-t{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".hss-s{font-size:12px;color:var(--ink-3,#6b6577);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".hss-t mark,.hss-s mark{background:transparent;color:var(--accent,#6d28d9);font-weight:700}",
    ".hss-go{flex:0 0 auto;font-size:12px;color:var(--ink-3,#6b6577);opacity:0}",
    ".hss-opt[aria-selected=true] .hss-go{opacity:1}",
    ".hss-msg{padding:28px 20px;text-align:center;color:var(--ink-2,#4b475f);font-size:14px}",
    ".hss-msg b{display:block;color:var(--ink,#1b1930);margin-bottom:4px;font-size:15px}",
    ".hss-msg button{margin-top:12px;font:600 13px var(--font,system-ui);padding:7px 14px;border-radius:8px;border:1px solid var(--line,#e8e3db);background:var(--panel-2,#faf8f5);color:var(--ink,#1b1930);cursor:pointer}",
    ".hss-foot{display:flex;align-items:center;gap:14px;padding:8px 14px;border-top:1px solid var(--line,#e8e3db);background:var(--panel-2,#faf8f5);font-size:11.5px;color:var(--ink-3,#6b6577)}",
    ".hss-foot span{display:inline-flex;align-items:center;gap:5px}",
    ".hss-foot .hss-st{margin-left:auto}",
    ".hss-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
    "html[data-theme=dark] .hss-ov{background:rgba(0,0,0,.6)}",
    "html[data-theme=dark] .hss-opt[aria-selected=true]{background:rgba(139,92,246,.22)}",
    "html[data-theme=dark] .hss-t mark,html[data-theme=dark] .hss-s mark{color:#c4b5fd}",
    "@keyframes hssFade{from{opacity:0}to{opacity:1}}",
    "@keyframes hssPop{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}",
    "@keyframes hssSpin{to{transform:rotate(360deg)}}",
    "@media (prefers-reduced-motion:reduce){.hss-ov,.hss-dlg{animation:none}.hss-spin{animation-duration:2s}}",
    "@media (max-width:900px){.hss-trig{min-width:0}.hss-trig .hss-tl,.hss-trig .hss-kbd{display:none}.hss-trig{width:36px;height:36px;justify-content:center;padding:0}}",
    "@media (max-width:640px){.hss-ov{padding:0;align-items:stretch}.hss-dlg{width:100%;max-height:none;height:100%;border-radius:0;border:0}.hss-foot .hss-k{display:none}.hss-in{font-size:16px}}",
  ].join("\n");
  let cssDone = false;
  function css() {
    if (cssDone) return; cssDone = true;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
  }

  /* ---- tiny DOM helper (textContent only) -------------------------------- */
  function el(tag, attrs, text) {
    const n = doc.createElement(tag);
    if (attrs) for (const k in attrs) { if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? "" : String(attrs[k])); }
    if (text != null) n.textContent = String(text);
    return n;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function searchIcon() {
    const s = doc.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "hss-ico"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    const c = doc.createElementNS(SVGNS, "circle"); c.setAttribute("cx", "11"); c.setAttribute("cy", "11"); c.setAttribute("r", "7");
    const l = doc.createElementNS(SVGNS, "path"); l.setAttribute("d", "M20 20l-3.5-3.5");
    s.appendChild(c); s.appendChild(l); return s;
  }
  function hl(node, text, q) {
    highlight(text, q).forEach((p) => { node.appendChild(p.hit ? el("mark", null, p.t) : doc.createTextNode(p.t)); });
    return node;
  }

  /* ---- access (quick actions) ----------------------------------------------- */
  async function allowedActions() {
    const st = global.BPStore, a = st && st.auth;
    if (!a) return ACTIONS.filter((x) => !x.need.length);
    const out = [];
    for (const x of ACTIONS) {
      let ok = true;
      for (const [kind, what] of x.need) {
        try {
          if (kind === "view") ok = await a.canView(what);
          else if (kind === "edit") ok = await a.canEditArea(what);
          else if (kind === "cap") ok = await a.can(what);
        } catch (e) { ok = false; }
        if (!ok) break;
      }
      if (ok) out.push(x);
    }
    return out;
  }

  /* ---- palette ------------------------------------------------------------- */
  const S = { open: false, ov: null, input: null, list: null, status: null, spin: null, opts: [], active: -1,
    q: "", groups: [], err: false, loading: false, ctrl: null, timer: null, seq: 0, actions: null, returnFocus: null };

  function build() {
    css();
    const ov = el("div", { class: "hss-ov", "data-hss": "overlay" });
    const dlg = el("div", { class: "hss-dlg", role: "dialog", "aria-modal": "true", "aria-label": "Search your studio" });
    const row = el("div", { class: "hss-in-row" });
    row.appendChild(searchIcon());
    const input = el("input", { class: "hss-in", id: "hssInput", type: "search", role: "combobox", "aria-expanded": "true", "aria-controls": "hssList",
      "aria-autocomplete": "list", "aria-haspopup": "listbox", autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false",
      maxlength: String(MAX), placeholder: "Search leads, events, staff, vendors, stock…", "aria-label": "Search your studio", enterkeyhint: "go" });
    const spin = el("span", { class: "hss-spin", "aria-hidden": "true" }); spin.hidden = true;
    const x = el("button", { type: "button", class: "hss-x", "aria-label": "Close search" }, "Esc");
    row.appendChild(input); row.appendChild(spin); row.appendChild(x);
    const body = el("div", { class: "hss-body" });
    const list = el("div", { id: "hssList", role: "listbox", "aria-label": "Search results" });
    body.appendChild(list);
    const foot = el("div", { class: "hss-foot" });
    [["↑↓", "move"], ["↵", "open"], ["Tab", "next group"]].forEach(([k, t]) => {
      const sp = el("span", { class: "hss-k" }); sp.appendChild(el("kbd", { class: "hss-kbd" }, k)); sp.appendChild(doc.createTextNode(t)); foot.appendChild(sp);
    });
    const status = el("span", { class: "hss-st", role: "status", "aria-live": "polite" });
    foot.appendChild(status);
    dlg.appendChild(row); dlg.appendChild(body); dlg.appendChild(foot); ov.appendChild(dlg);

    ov.addEventListener("mousedown", (e) => { if (e.target === ov) { e.preventDefault(); close(); } });
    x.addEventListener("click", close);
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKey);
    dlg.addEventListener("keydown", (e) => { if (e.key === "Tab" && e.target !== input) { e.preventDefault(); input.focus(); } });
    Object.assign(S, { ov, input, list, status, spin });
  }

  async function open(initial) {
    if (S.open) { S.input.focus(); S.input.select(); return; }
    if (!S.ov) build();
    S.returnFocus = doc.activeElement;
    S.open = true; S.err = false; S.groups = [];
    doc.body.appendChild(S.ov);
    try { doc.documentElement.classList.add("hss-lock"); } catch (e) {}
    S.input.value = initial != null ? cleanQuery(initial) : "";
    S.q = cleanQuery(S.input.value);
    S.input.focus();
    if (!S.actions) { try { S.actions = await allowedActions(); } catch (e) { S.actions = []; } }
    if (S.q.length >= MIN) run(S.q); else render();
  }
  function close() {
    if (!S.open) return;
    S.open = false;
    if (S.ctrl) { try { S.ctrl.abort(); } catch (e) {} S.ctrl = null; }
    clearTimeout(S.timer);
    if (S.ov && S.ov.parentNode) S.ov.parentNode.removeChild(S.ov);
    try { doc.documentElement.classList.remove("hss-lock"); } catch (e) {}
    const r = S.returnFocus; S.returnFocus = null;
    if (r && typeof r.focus === "function" && doc.contains(r)) { try { r.focus(); } catch (e) {} }
  }

  function onInput() {
    const q = cleanQuery(S.input.value);
    S.q = q; S.err = false;
    clearTimeout(S.timer);
    if (S.ctrl) { try { S.ctrl.abort(); } catch (e) {} S.ctrl = null; }
    if (q.length < MIN) { S.groups = []; setLoading(false); render(); return; }
    setLoading(true);
    render();                                 // actions filter instantly; results follow
    S.timer = setTimeout(() => run(q), DEBOUNCE);
  }
  function setLoading(on) { S.loading = on; if (S.spin) S.spin.hidden = !on; }

  async function run(q) {
    const st = global.BPStore;
    const my = ++S.seq;
    let ctrl = null;
    try { ctrl = new AbortController(); } catch (e) {}
    S.ctrl = ctrl;
    setLoading(true);
    try {
      const data = st && typeof st.search === "function" ? await st.search(q, { signal: ctrl ? ctrl.signal : undefined }) : {};
      if (my !== S.seq || !S.open) return;    // a newer request superseded this one
      S.groups = normalize(data); S.err = false;
    } catch (e) {
      if (my !== S.seq || !S.open) return;
      if (e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")))) return;
      S.groups = []; S.err = true;
    }
    setLoading(false);
    render();
  }

  // flattened model of what's on screen: [{group, rows:[{kind, label, sub, icon, href, q?}]}]
  // empty-state hook: recently opened records from nav-trail.js (HelmTrail.recent()); own pages only
  function recentRecords() {
    let list = [];
    try { const t = global.HelmTrail; list = t && typeof t.recent === "function" ? t.recent() : []; } catch (e) { list = []; }
    if (!Array.isArray(list)) return [];
    const t = global.HelmTrail || {};
    return list.slice(0, 5).map((r) => {
      const href = r && typeof r.href === "string" ? r.href : "";
      if (!href || !/^[a-z0-9-]+\.html(?:[?#][^\s\\]*)?$/i.test(href)) return null;
      const kind = String(r.kind || "record");
      return { title: String(r.title || "").slice(0, 120), href, icon: (t.ICONS && t.ICONS[kind]) || "📄",
        sub: ((t.KIND_LABEL && t.KIND_LABEL[kind]) || "Record") + (r.at && t.timeAgo ? " · " + t.timeAgo(r.at) : "") };
    }).filter((r) => r && r.title);
  }
  function sections() {
    const out = [];
    const q = S.q;
    if (q.length < MIN) {
      const recs = recentRecords();
      if (recs.length) out.push({ key: "records", label: "Recently opened",
        rows: recs.map((r) => ({ kind: "record", label: r.title, sub: r.sub, icon: r.icon, href: r.href })) });
      const rec = recentGet();
      if (rec.length) out.push({ key: "recent", label: "Recent searches", clear: true,
        rows: rec.map((r) => ({ kind: "recent", label: r, sub: "", icon: "🕘", q: r })) });
    } else {
      S.groups.forEach((g) => out.push({ key: g.type, label: g.label,
        rows: g.items.map((it) => ({ kind: "result", label: it.title, sub: it.subtitle, icon: g.icon, href: it.href })) }));
    }
    const acts = (S.actions || []).filter((a) => matchAction(a, q)).slice(0, q.length ? 4 : 8);
    if (acts.length) out.push({ key: "actions", label: q.length ? "Actions" : "Quick actions",
      rows: acts.map((a) => ({ kind: "action", label: a.label, sub: "", icon: a.icon, href: a.href })) });
    return out;
  }

  function render() {
    if (!S.list) return;
    const list = S.list; list.textContent = "";
    S.opts = []; S.active = -1;
    const secs = sections();
    const q = S.q;
    let n = 0;
    secs.forEach((sec, gi) => {
      const grp = el("div", { class: "hss-grp", role: "group", "aria-labelledby": "hssG" + gi, "data-g": String(gi) });
      const gh = el("div", { class: "hss-gh", id: "hssG" + gi, role: "presentation" }, sec.label);
      if (sec.clear) {
        const b = el("button", { type: "button", tabindex: "-1" }, "Clear");
        b.addEventListener("mousedown", (e) => { e.preventDefault(); recentClear(); render(); });
        gh.appendChild(b);
      }
      grp.appendChild(gh);
      sec.rows.forEach((r) => {
        const id = "hssO" + (n++);
        const o = el("div", { class: "hss-opt", role: "option", id, "aria-selected": "false", "data-g": String(gi) });
        o.appendChild(el("span", { class: "hss-oi", "aria-hidden": "true" }, r.icon));
        const t = el("span", { class: "hss-ot" });
        t.appendChild(r.kind === "result" ? hl(el("span", { class: "hss-t" }), r.label, q) : el("span", { class: "hss-t" }, r.label));
        if (r.sub) t.appendChild(hl(el("span", { class: "hss-s" }), r.sub, q));
        o.appendChild(t);
        o.appendChild(el("span", { class: "hss-go", "aria-hidden": "true" }, "↵"));
        o.addEventListener("mousemove", () => { const i = S.opts.findIndex((x) => x.node === o); if (i !== S.active) setActive(i, false); });
        o.addEventListener("mousedown", (e) => e.preventDefault());
        o.addEventListener("click", (e) => { const i = S.opts.findIndex((x) => x.node === o); choose(i, e.metaKey || e.ctrlKey); });
        grp.appendChild(o);
        S.opts.push({ node: o, row: r, g: gi });
      });
      list.appendChild(grp);
    });

    let msg = "";
    if (S.err) {
      const m = el("div", { class: "hss-msg", role: "presentation" });
      m.appendChild(el("b", null, "Search isn't available right now"));
      m.appendChild(doc.createTextNode("Check your connection and try again."));
      const b = el("button", { type: "button" }, "Try again");
      b.addEventListener("click", () => { S.err = false; run(S.q); S.input.focus(); });
      m.appendChild(b); list.insertBefore(m, list.firstChild);
      msg = "Search failed.";
    } else if (q.length >= MIN && !S.loading && !S.groups.length) {
      const m = el("div", { class: "hss-msg", role: "presentation" });
      m.appendChild(el("b", null, "No matches for “" + q + "”"));
      m.appendChild(doc.createTextNode("Try a name, event code or receipt number. Only areas you have access to are searched."));
      list.insertBefore(m, list.firstChild);
      msg = "No results.";
    } else if (q.length >= MIN && S.loading) {
      msg = "Searching…";
    } else if (q.length >= MIN) {
      const c = S.groups.reduce((a, g) => a + g.items.length, 0);
      msg = c + (c === 1 ? " result" : " results");
    } else if (!S.opts.length) {
      const m = el("div", { class: "hss-msg", role: "presentation" });
      m.appendChild(el("b", null, "Search your studio"));
      m.appendChild(doc.createTextNode("Type at least 2 letters to find leads, events, staff, vendors and more."));
      list.appendChild(m);
    }
    S.status.textContent = msg;
    if (S.opts.length) setActive(0, false); else S.input.removeAttribute("aria-activedescendant");
  }

  function setActive(i, scroll) {
    if (!S.opts.length) return;
    if (S.active >= 0 && S.opts[S.active]) S.opts[S.active].node.setAttribute("aria-selected", "false");
    S.active = (i + S.opts.length) % S.opts.length;
    const o = S.opts[S.active].node;
    o.setAttribute("aria-selected", "true");
    S.input.setAttribute("aria-activedescendant", o.id);
    if (scroll !== false && typeof o.scrollIntoView === "function") { try { o.scrollIntoView({ block: "nearest" }); } catch (e) {} }
  }
  function jumpGroup(dir) {
    if (!S.opts.length) return;
    const cur = S.active >= 0 ? S.opts[S.active].g : -1;
    const gs = []; S.opts.forEach((o) => { if (gs.indexOf(o.g) < 0) gs.push(o.g); });
    let gi = gs.indexOf(cur) + dir;
    if (gi >= gs.length) gi = 0; if (gi < 0) gi = gs.length - 1;
    setActive(S.opts.findIndex((o) => o.g === gs[gi]));
  }
  function choose(i, newTab) {
    const o = S.opts[i]; if (!o) return;
    const r = o.row;
    if (r.kind === "recent") { S.input.value = r.q; onInput(); S.input.focus(); return; }
    if (r.kind === "result") recentAdd(S.q);
    if (!r.href) return;
    if (newTab) { try { global.open(r.href, "_blank", "noopener"); } catch (e) {} return; }
    close();
    global.location.href = global.HelmUrl ? global.HelmUrl.upgrade(r.href) : r.href;
  }
  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(S.active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(S.active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (S.active >= 0) choose(S.active, e.metaKey || e.ctrlKey); }
    else if (e.key === "Tab") { e.preventDefault(); jumpGroup(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setActive(S.opts.length - 1); }
  }

  /* ---- top-bar trigger -------------------------------------------------------- */
  let trig = null;
  function makeTrigger() {
    const b = el("button", { type: "button", class: "hss-trig", id: "hssTrigger", "aria-haspopup": "dialog",
      "aria-keyshortcuts": isMac ? "Meta+K" : "Control+K", title: "Search (" + (isMac ? "⌘K" : "Ctrl+K") + ")", "aria-label": "Search your studio" });
    b.appendChild(searchIcon());
    b.appendChild(el("span", { class: "hss-tl", "aria-hidden": "true" }, "Search…"));
    b.appendChild(el("kbd", { class: "hss-kbd", "aria-hidden": "true" }, isMac ? "⌘K" : "Ctrl K"));
    b.addEventListener("click", () => open());
    return b;
  }
  function placeTrigger() {
    if (!doc.body) return;
    css();
    if (!trig) trig = makeTrigger();
    const mount = doc.getElementById("helm-topbar-search");
    if (mount) { if (trig.parentNode !== mount) { const old = doc.querySelector(".hss-slot"); mount.appendChild(trig); if (old && !old.firstChild) old.remove(); } return; }
    if (trig.isConnected) return;
    // fallback: own slot just left of the account chip (the element holding #logoutBtn)
    const lo = doc.getElementById("logoutBtn");
    const acct = lo && lo.parentNode && lo.parentNode !== doc.body ? lo.parentNode : null;
    if (acct && acct.parentNode) {
      const slot = el("span", { class: "hss-slot" }); slot.appendChild(trig);
      acct.parentNode.insertBefore(slot, acct);
    }
  }

  /* ---- landing helpers: ?hs=<text> fills the page's own search box; ?hs_act=new opens "new" -- */
  function landing() {
    let p; try { p = new URLSearchParams(global.location.search); } catch (e) { return; }
    const hs = p.get("hs"), act = p.get("hs_act");
    if (hs == null && act == null) return;
    try { p.delete("hs"); p.delete("hs_act"); const qs = p.toString();
      global.history.replaceState(global.history.state, "", global.location.pathname + (qs ? "?" + qs : "") + global.location.hash); } catch (e) {}
    let tries = 0;
    (function go() {
      if (hs != null) {
        const box = doc.getElementById("search");
        if (box && box.tagName === "INPUT") { box.value = cleanQuery(hs); box.dispatchEvent(new global.Event("input", { bubbles: true })); }
        else if (tries++ < 20) { setTimeout(go, 250); return; }
      }
      if (act === "new") {
        const nb = doc.getElementById("newBtn");
        if (nb && !nb.hidden) nb.click();
        else if (tries++ < 24) setTimeout(go, 250);
      }
    })();
  }

  /* ---- boot -------------------------------------------------------------------- */
  function pageKey() {
    try { return (global.location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index"; } catch (e) { return "index"; }
  }
  let booted = false, booting = null;
  // one boot at a time (auto-retry and a manual call must never both wire the shortcut)
  function boot() {
    if (booting) return booting;
    booting = doBoot().then((ok) => { if (!ok && !booted) booting = null; return ok; }, () => { booting = null; return false; });
    return booting;
  }
  async function doBoot() {
    if (booted || !doc || NOT_HERE[pageKey()]) return false;
    const st = global.BPStore;
    if (!st || !st.auth || typeof st.mode !== "function" || st.mode() !== "supabase" || !st.auth.user || !st.auth.user()) return false;
    let role = null; try { role = await st.auth.role(); } catch (e) {}
    if (!role || role === "client") { if (role) booted = true; return false; }
    booted = true;
    placeTrigger();
    try {
      let pending = false;
      new MutationObserver(() => { if (pending) return; pending = true; setTimeout(() => { pending = false; placeTrigger(); }, 80); })
        .observe(doc.body, { childList: true, subtree: true });
    } catch (e) {}
    doc.addEventListener("keydown", (e) => {
      const k = (e.key || "").toLowerCase();
      if (k === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); if (S.open) close(); else open(); return; }
      if (k === "/" && !S.open && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target, tag = t && t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
        e.preventDefault(); open();
      }
    });
    landing();
    return true;
  }
  function auto() {
    if (!doc) return;
    let tries = 0;
    (function go() { boot().then((ok) => { if (!ok && !booted && tries++ < 30) setTimeout(go, 400); }).catch(() => {}); })();
  }
  if (doc) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", auto); else auto(); }

  const api = { open, close, boot, placeTrigger, normalize, highlight, cleanQuery, safeLink, matchAction, sections, recentRecords, recentGet, recentAdd, recentClear,
    TYPES, ACTIONS, MIN, MAX, DEBOUNCE, _css: CSS, _state: S };
  global.HelmStudioSearch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
