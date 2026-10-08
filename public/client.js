/* client.js — one page per client (client.html?id=<lead id or event id>), 0062.
   • Data comes only from BPStore.clientTimeline() → client_timeline() RPC, which enforces
     the caller's studio and the role matrix per section (server is the authority).
   • Every value is inserted with textContent / setAttribute — no HTML strings.
   • Links are accepted only when they point at the app's own pages (LINK_RE). */
(function (global) {
  "use strict";
  const doc = global.document;
  const KINDS = [
    { key: "leads",    label: "Leads",    icon: "🎯" },
    { key: "events",   label: "Events",   icon: "📋" },
    { key: "payments", label: "Payments", icon: "💳" },
    { key: "files",    label: "Files",    icon: "📎" },
    { key: "tasks",    label: "Tasks",    icon: "✅" },
    { key: "messages", label: "Messages", icon: "💬" },
  ];
  const LINK_RE = /^[a-z][a-z0-9-]*\.html(?:\?[A-Za-z0-9_\-=&.%]*)?$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ---- pure helpers (exported for tests) ---- */
  function safeLink(link, name) {
    const l = String(link || "");
    if (!LINK_RE.test(l)) return null;
    // list pages have no per-record URL: hand the client's name to the page's own search box
    return /[?&]hs=$/.test(l) ? l + encodeURIComponent(String(name || "").slice(0, 80)) : l;
  }
  function money(n) {
    const v = Number(n);
    if (!isFinite(v)) return "—";
    try { return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 }); } catch (e) { return "₹" + v.toFixed(2); }
  }
  function when(t) {
    if (!t) return "";
    const d = new Date(t);
    if (isNaN(d.getTime())) return "";
    try { return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return d.toISOString(); }
  }
  function initials(name) {
    const p = String(name || "").trim().split(/\s+/).filter(Boolean);
    return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
  }
  function normalize(data) {
    const out = { client: { name: "Client", phone: "", email: "", status: "" }, totals: null, sections: [], counts: {}, items: [] };
    if (!data || typeof data !== "object") return out;
    const c = data.client || {};
    out.client = { name: String(c.name || "Client"), phone: c.phone ? String(c.phone) : "", email: c.email ? String(c.email) : "", status: c.status ? String(c.status) : "" };
    out.totals = data.totals && typeof data.totals === "object" ? data.totals : null;
    out.counts = data.counts && typeof data.counts === "object" ? data.counts : {};
    const known = KINDS.map((k) => k.key);
    out.sections = Array.isArray(data.sections) ? data.sections.filter((s) => known.indexOf(s) >= 0) : [];
    (Array.isArray(data.items) ? data.items : []).forEach((r) => {
      if (!r || known.indexOf(r.kind) < 0 || r.title == null) return;
      out.items.push({ kind: r.kind, at: r.at || null, id: String(r.id || ""), title: String(r.title),
        subtitle: r.subtitle == null ? "" : String(r.subtitle), href: safeLink(r.link, out.client.name) });
    });
    return out;
  }
  function filterItems(items, kind) { return kind === "all" ? items.slice() : items.filter((i) => i.kind === kind); }

  /* ---- DOM ---- */
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  const $ = (s) => doc.querySelector(s);
  let model = null, active = "all";

  function renderHead(m) {
    const c = m.client;
    $("#c_name").textContent = c.name;
    $("#c_avatar").textContent = initials(c.name);
    try { doc.title = c.name + " — Client — Helm Events"; } catch (e) {}
    const box = $("#c_contact"); box.textContent = "";
    if (c.phone) { const a = el("a", "", c.phone); a.setAttribute("href", "tel:" + c.phone.replace(/[^\d+]/g, "")); box.appendChild(a); }
    if (c.email) { const a = el("a", "", c.email); a.setAttribute("href", "mailto:" + c.email); box.appendChild(a); }
    if (!c.phone && !c.email) box.appendChild(el("span", "muted", "No contact details yet"));
    const st = $("#c_status"); st.hidden = !c.status; st.textContent = c.status.replace(/_/g, " ");
    const bits = [];
    if (typeof m.counts.leads === "number") bits.push(m.counts.leads + " lead" + (m.counts.leads === 1 ? "" : "s"));
    if (typeof m.counts.events === "number") bits.push(m.counts.events + " event" + (m.counts.events === 1 ? "" : "s"));
    $("#c_counts").textContent = bits.join(" · ");
    const t = m.totals;
    $("#c_totals").hidden = !t;
    if (t) {
      $("#t_quoted").textContent = t.quoted != null ? money(t.quoted) : "—";
      $("#t_paid").textContent = t.paid != null ? money(t.paid) : "—";
      const due = $("#t_due"); due.textContent = t.due != null ? money(t.due) : "—";
      due.classList.toggle("due", Number(t.due) > 0);
    }
  }
  function renderFilters(m) {
    const box = $("#filters"); box.textContent = "";
    const defs = [{ key: "all", label: "All", icon: "" }].concat(KINDS.filter((k) => m.sections.indexOf(k.key) >= 0));
    defs.forEach((d) => {
      const n = d.key === "all" ? m.items.length : m.items.filter((i) => i.kind === d.key).length;
      const b = el("button", "chip");
      b.type = "button"; b.dataset.k = d.key;
      b.setAttribute("aria-pressed", String(active === d.key));
      b.appendChild(doc.createTextNode((d.icon ? d.icon + " " : "") + d.label));
      b.appendChild(el("span", "n", String(n)));
      b.addEventListener("click", () => { active = d.key; renderFilters(model); renderList(model); });
      box.appendChild(b);
    });
  }
  function renderList(m) {
    const list = $("#timeline"); list.textContent = "";
    const rows = filterItems(m.items, active);
    if (!rows.length) { const li = el("li", "empty", active === "all" ? "Nothing on this client's timeline yet." : "Nothing of this type yet."); list.appendChild(li); return; }
    rows.forEach((it) => {
      const k = KINDS.find((x) => x.key === it.kind) || KINDS[0];
      const li = el("li", "tl");
      li.appendChild(el("span", "dot", k.icon)).setAttribute("aria-hidden", "true");
      const body = el("div", "body");
      const t = el("div", "t");
      t.appendChild(el("span", "k", k.label.replace(/s$/, "")));
      if (it.href) { const a = el("a", "", it.title); a.setAttribute("href", it.href); t.appendChild(a); }
      else t.appendChild(doc.createTextNode(it.title));
      body.appendChild(t);
      if (it.subtitle) body.appendChild(el("div", "s", it.subtitle));
      const w = when(it.at);
      if (w) { const tm = el("time", "when", w); tm.setAttribute("datetime", String(it.at)); body.appendChild(tm); }
      li.appendChild(body);
      list.appendChild(li);
    });
  }
  function notFound() { $("#app").hidden = true; $("#notfound").hidden = false; }

  async function start() {
    const st = global.BPStore;
    await st.init();
    const id = new URLSearchParams(global.location.search).get("id") || "";
    if (st.auth.enabled() && st.auth.required() && !st.auth.user()) {
      global.location.replace("login.html?next=" + encodeURIComponent(global.location.pathname.split("/").pop() + global.location.search)); return;
    }
    if (!UUID_RE.test(id)) { notFound(); return; }
    let data;
    try { data = await st.clientTimeline(id); }
    catch (e) {
      const code = (e && e.code) || "";
      if (code === "P0002" || code === "42501") { notFound(); return; }
      throw e;
    }
    if (!data) { notFound(); return; }
    model = normalize(data); active = "all";
    renderHead(model); renderFilters(model); renderList(model);
    $("#app").hidden = false;
  }

  global.HelmClient360 = { safeLink, money, when, initials, normalize, filterItems, KINDS };
  if (doc && global.BPUI && typeof global.BPUI.boot === "function" && doc.getElementById("timeline")) global.BPUI.boot(start);
})(typeof window !== "undefined" ? window : globalThis);
