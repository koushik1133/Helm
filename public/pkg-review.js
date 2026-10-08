/* pkg-review.js — studio side of the client package flow (0069).
   • [data-pkg-review] (event.html, client.html): the "Package selections" panel for one event.
     Lists client choices from BPStore.pkgflow.list(quoteId). Roles with has_area('pkg_review','edit')
     get Accept (optional price override) / Decline (reason required); others see it read-only.
     The server re-checks every permission (incl. "you can't approve your own request").
   • [data-pkg-settings] (control.html): the "Client package flow" settings card.
   DOM via createElement / textContent / setAttribute only. */
(function (global) {
  "use strict";
  const doc = global.document;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const STATUS_LABEL = { pending: "Awaiting review", accepted: "Accepted", declined: "Declined", superseded: "Replaced" };
  const CHANNELS = [["whatsapp", "WhatsApp"], ["email", "Email"], ["both", "Both"]];
  const OVERPAY = [["credit", "Keep as credit"], ["manual_refund", "Manual refund"]];

  /* ---- pure helpers (exported for tests) ---- */
  function num(v) { const n = Number(v); return v !== "" && v != null && isFinite(n) ? n : null; }
  function money(n, cur) {
    const v = num(n); if (v == null) return "—";
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: /^[A-Z]{3}$/.test(cur || "") ? cur : "INR", maximumFractionDigits: 0 }).format(v); }
    catch (e) { return String(Math.round(v)); }
  }
  function when(t) { const d = new Date(t); if (!t || isNaN(d.getTime())) return ""; try { return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); } catch (e) { return d.toISOString().slice(0, 16); } }
  function rowView(r) {
    r = r || {};
    const st = STATUS_LABEL[r.status] ? r.status : "pending";
    const draft = r.draft_totals || r.draft || {};
    return { id: String(r.id || ""), name: String(r.package_name || r.name || "Package").slice(0, 80), guests: num(r.guests),
      status: st, statusLabel: STATUS_LABEL[st], at: when(r.created_at), note: r.note ? String(r.note).slice(0, 500) : "",
      reason: r.decline_reason ? String(r.decline_reason).slice(0, 500) : "",
      total: num(draft.total != null ? draft.total : r.draft_total), currency: draft.currency || r.currency || "INR" };
  }
  // a valid accept / decline payload, or { error }
  function reviewArgs(action, override, reason) {
    if (action === "decline") {
      const why = String(reason || "").trim();
      if (why.length < 3) return { error: "Please give the client a reason (at least 3 characters)." };
      return { action: "decline", price: null, reason: why.slice(0, 500) };
    }
    if (action !== "accept") return { error: "Unknown action." };
    const raw = String(override == null ? "" : override).trim();
    if (!raw) return { action: "accept", price: null, reason: null };
    const v = Number(raw.replace(/[, ]/g, ""));
    if (!isFinite(v) || v <= 0 || v > 1e9) return { error: "Price per guest must be a positive number." };
    return { action: "accept", price: Math.round(v * 100) / 100, reason: null };
  }
  function errText(e) {
    const m = String((e && e.message) || "");
    if (/self|own (request|selection)|yourself/i.test(m)) return m.slice(0, 240);  // server's self-approval-blocked message, verbatim
    try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: "review the package choice" }); } catch (x) {}
    return m.slice(0, 240) || "Something went wrong.";
  }
  function safeUrl(u) { const s = typeof u === "string" ? u.trim() : ""; return /^https:\/\/[^\s"'<>\\]+$/i.test(s) && s.length <= 600 ? s : null; }
  function quoteIdFor(n) {
    const q = n && n.getAttribute("data-quote");
    if (q && UUID_RE.test(q)) return q;
    if (n && n.hasAttribute("data-quote-from-url")) { const id = new URLSearchParams(global.location.search).get("id"); if (id && UUID_RE.test(id)) return id; }
    return null;
  }
  function settingsView(s) {
    s = s || {};
    const ch = CHANNELS.some((c) => c[0] === s.pkg_client_channel) ? s.pkg_client_channel : "whatsapp";
    const op = OVERPAY.some((c) => c[0] === s.overpay_mode) ? s.overpay_mode : "credit";
    const d = Math.round(num(s.pkg_lock_days) == null ? 3 : num(s.pkg_lock_days));
    return { pkg_require_otp: !!s.pkg_require_otp, pkg_client_channel: ch, overpay_mode: op, pkg_lock_days: Math.max(0, Math.min(90, d)) };
  }

  /* ---- DOM ---- */
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function btn(cls, text) { const b = el("button", cls, text); b.type = "button"; return b; }
  function toast(msg, type) { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(msg, { type: type || "ok" }); } catch (e) {} }

  function linkBox(url) {
    const box = el("div", "pkr-link");
    const lab = el("label", "pkr-lab", "Updated quote — approval link for the client");
    const id = "pkrUrl" + Math.random().toString(36).slice(2, 8); lab.setAttribute("for", id);
    const row = el("div", "pkr-row");
    const inp = el("input", "pkr-url"); inp.id = id; inp.type = "text"; inp.readOnly = true; inp.value = url; inp.addEventListener("focus", () => inp.select());
    const copy = btn("btn sm", "Copy link");
    copy.addEventListener("click", async () => {
      try { await global.navigator.clipboard.writeText(url); toast("Approval link copied"); copy.textContent = "Copied ✓"; }
      catch (e) { inp.focus(); inp.select(); toast("Press Ctrl/Cmd + C to copy", "info"); }
    });
    row.appendChild(inp); row.appendChild(copy); box.appendChild(lab); box.appendChild(row);
    return box;
  }

  function reviewForm(li, v, quoteId, panel) {
    const f = el("div", "pkr-form");
    const err = el("p", "pkr-err"); err.setAttribute("role", "alert");
    const oid = "pkrO_" + v.id.replace(/[^A-Za-z0-9_-]/g, ""), rid = "pkrR_" + v.id.replace(/[^A-Za-z0-9_-]/g, "");
    const ol = el("label", "pkr-lab", "Price per guest override (optional)"); ol.setAttribute("for", oid);
    const ov = el("input", "pkr-in"); ov.id = oid; ov.type = "number"; ov.min = "1"; ov.step = "1"; ov.inputMode = "decimal"; ov.placeholder = "Package price";
    const rl = el("label", "pkr-lab", "Reason for declining (shown to the client)"); rl.setAttribute("for", rid);
    const rs = el("textarea", "pkr-in"); rs.id = rid; rs.rows = 2; rs.maxLength = 500;
    const acts = el("div", "pkr-acts");
    const acc = btn("btn sm primary", "Accept"), dec = btn("btn sm", "Decline");
    const go = async (action, b) => {
      err.textContent = "";
      const a = reviewArgs(action, ov.value, rs.value);
      if (a.error) { err.textContent = a.error; (action === "decline" ? rs : ov).focus(); return; }
      acc.disabled = dec.disabled = true;
      try {
        const r = await global.BPStore.pkgflow.review(v.id, a.action, a.price, a.reason);
        if (r && r.ok === false) throw new Error(r.error || r.message || "The server refused this review.");
        toast(action === "accept" ? "Package accepted — updated quote created" : "Package choice declined");
        await load(panel, quoteId, action === "accept" && r ? safeUrl(r.approve_url) : null);
      } catch (e) { err.textContent = errText(e); acc.disabled = dec.disabled = false; b.focus(); }
    };
    acc.addEventListener("click", () => go("accept", acc)); dec.addEventListener("click", () => go("decline", dec));
    const g1 = el("div", "pkr-fld"); g1.appendChild(ol); g1.appendChild(ov);
    const g2 = el("div", "pkr-fld"); g2.appendChild(rl); g2.appendChild(rs);
    acts.appendChild(acc); acts.appendChild(dec);
    f.appendChild(g1); f.appendChild(g2); f.appendChild(acts); f.appendChild(err);
    li.appendChild(f);
  }

  async function load(panel, quoteId, freshUrl) {
    const body = clear(panel.querySelector(".pkr-body"));
    body.appendChild(el("p", "muted", "Loading…"));
    let rows;
    try { rows = await global.BPStore.pkgflow.list(quoteId); }
    catch (e) { clear(body); body.appendChild(el("p", "pkr-err", errText(e))); return; }
    clear(body);
    if (freshUrl) body.appendChild(linkBox(freshUrl));
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) { body.appendChild(el("p", "muted", "No package choices from the client yet. They choose from the booklet link.")); return; }
    const ol = el("ol", "pkr-list");
    rows.forEach((r) => {
      const v = rowView(r); const li = el("li", "pkr-item"); li.setAttribute("data-id", v.id);
      const top = el("div", "pkr-top");
      top.appendChild(el("strong", "pkr-name", v.name));
      top.appendChild(el("span", "pkr-pill " + v.status, v.statusLabel));
      li.appendChild(top);
      li.appendChild(el("p", "pkr-meta", [v.guests != null ? v.guests + " guests" : "", v.total != null ? "draft " + money(v.total, v.currency) : "", v.at].filter(Boolean).join(" · ")));
      if (v.note) li.appendChild(el("p", "pkr-note", "Client note: " + v.note));
      if (v.reason) li.appendChild(el("p", "pkr-note", "Declined: " + v.reason));
      if (v.status === "pending") { if (panel.dataset.pkrEdit === "1") reviewForm(li, v, quoteId, panel); else li.appendChild(el("p", "muted", "Waiting for a reviewer with approval rights.")); }
      ol.appendChild(li);
    });
    body.appendChild(ol);
  }

  function build(panel) {
    if (panel.querySelector(".pkr-body")) return;
    const h = el("h3", "pkr-h", "📦 Package selections"); panel.appendChild(h);
    panel.appendChild(el("p", "pkr-sub", panel.dataset.pkrEdit === "1" ? "Your client's package choices. Accept to create an updated quote, or decline with a reason."
      : "Your client's package choices (view only — approving needs “Package selections (review)” edit access)."));
    const body = el("div", "pkr-body"); body.setAttribute("aria-live", "polite"); panel.appendChild(body);
  }

  async function wire() {
    const st = global.BPStore;
    if (!st || !st.pkgflow) return;
    const panels = Array.from(doc.querySelectorAll("[data-pkg-review]"));
    const sets = Array.from(doc.querySelectorAll("[data-pkg-settings]"));
    if (!panels.length && !sets.length) return;
    try { await st.init(); } catch (e) { return; }
    if (st.mode && st.mode() !== "supabase") return;
    let view = false, edit = false;
    try { view = await st.auth.canView("pkg_review"); edit = view && await st.auth.canEditArea("pkg_review"); } catch (e) { view = edit = false; }
    panels.forEach((p) => {
      const q = quoteIdFor(p);
      if (!view || !q) { p.hidden = true; return; }
      if (p.dataset.pkrWired === q) return; p.dataset.pkrWired = q;
      p.dataset.pkrEdit = edit ? "1" : "0"; build(p); p.hidden = false; load(p, q, null);
    });
    if (sets.length) { let can = false; try { can = await st.auth.canEditArea("controls"); } catch (e) { can = false; } sets.forEach((c) => wireSettings(c, can)); }
  }

  /* ---- Control Center card ---- */
  function radios(name, opts, cur, legend) {
    const fs = el("fieldset", "pkr-fs"); fs.appendChild(el("legend", "", legend));
    opts.forEach((o) => {
      const id = name + "_" + o[0]; const lab = el("label", "pkr-radio"); lab.setAttribute("for", id);
      const r = el("input"); r.type = "radio"; r.name = name; r.id = id; r.value = o[0]; r.checked = o[0] === cur;
      lab.appendChild(r); lab.appendChild(doc.createTextNode(" " + o[1])); fs.appendChild(lab);
    });
    return fs;
  }
  async function wireSettings(card, can) {
    if (card.dataset.pkrWired) return; card.dataset.pkrWired = "1";
    const body = clear(card.querySelector(".pkr-sbody") || card.appendChild(el("div", "pkr-sbody")));
    let s;
    try { s = settingsView(await global.BPStore.pkgflow.settingsGet()); }
    catch (e) { body.appendChild(el("p", "pkr-err", errText(e))); card.hidden = false; return; }
    const sw = el("label", "pkr-switch"); sw.setAttribute("for", "pk_otp");
    const cb = el("input"); cb.type = "checkbox"; cb.id = "pk_otp"; cb.setAttribute("role", "switch"); cb.checked = s.pkg_require_otp;
    sw.appendChild(cb); sw.appendChild(doc.createTextNode(" Require a WhatsApp code before a client's choice is sent"));
    body.appendChild(sw);
    body.appendChild(radios("pk_channel", CHANNELS, s.pkg_client_channel, "Client messages go by"));
    body.appendChild(radios("pk_overpay", OVERPAY, s.overpay_mode, "If a client pays more than the updated quote"));
    const f = el("div", "fld"); const ll = el("label", "", "Lock package choices this many days before the event (0–90)"); ll.setAttribute("for", "pk_lock");
    const li = el("input"); li.id = "pk_lock"; li.type = "number"; li.min = "0"; li.max = "90"; li.step = "1"; li.inputMode = "numeric"; li.value = String(s.pkg_lock_days);
    f.appendChild(ll); f.appendChild(li); body.appendChild(f);
    const msg = el("p", "pkr-err"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    const acts = el("div", "actions"); const save = btn("btn primary", "Save package flow"); acts.appendChild(save);
    body.appendChild(acts); body.appendChild(msg);
    if (!can) { Array.from(body.querySelectorAll("input,button")).forEach((x) => { x.disabled = true; }); msg.textContent = "View only — editing needs Control Center edit access."; }
    save.addEventListener("click", async () => {
      const pick = (n) => { const r = body.querySelector('input[name="' + n + '"]:checked'); return r ? r.value : null; };
      const d = Number(li.value);
      if (!Number.isInteger(d) || d < 0 || d > 90) { msg.textContent = "Lock days must be a whole number from 0 to 90."; li.focus(); return; }
      const v = settingsView({ pkg_require_otp: cb.checked, pkg_client_channel: pick("pk_channel"), overpay_mode: pick("pk_overpay"), pkg_lock_days: d });
      save.disabled = true; msg.textContent = "";
      try { await global.BPStore.pkgflow.settingsSet(v); msg.textContent = "Saved ✓"; toast("Package flow settings saved"); }
      catch (e) { msg.textContent = errText(e); }
      save.disabled = false;
    });
    card.hidden = false;
  }

  global.HelmPkgReview = { wire, rowView, reviewArgs, errText, settingsView, quoteIdFor, safeUrl, money, STATUS_LABEL };
  if (doc && (doc.querySelector("[data-pkg-review]") || doc.querySelector("[data-pkg-settings]"))) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", wire); else wire();
  }
})(typeof window !== "undefined" ? window : globalThis);
