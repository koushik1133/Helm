/* booklet-share.js — studio side of the client event booklet (0065).
   Any button with [data-booklet-share] opens a "Share booklet" dialog for the event in its
   data-quote attribute (event.html falls back to ?id=). Staff whose role may EDIT quotes create
   a link (expiry, which quote versions to show, a note, terms), copy it, open it, or revoke it.
   The server re-checks every permission (booklet_share / booklet_revoke / booklet_current).
   DOM built with textContent / setAttribute only. */
(function (global) {
  "use strict";
  const doc = global.document;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DAYS = [7, 14, 30, 60, 90, 180];

  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function when(t) { const d = new Date(t); if (isNaN(d.getTime())) return ""; try { return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return d.toISOString().slice(0, 10); } }
  function money(n) { const v = Number(n); if (!isFinite(v)) return ""; try { return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 0 }); } catch (e) { return "₹" + Math.round(v); } }
  function quoteIdFor(btn) {
    const q = btn && btn.getAttribute("data-quote");
    if (q && UUID_RE.test(q)) return q;
    if (btn && btn.hasAttribute("data-quote-from-url")) { const id = new URLSearchParams(global.location.search).get("id"); if (id && UUID_RE.test(id)) return id; }
    return null;
  }
  function toast(msg, type) { try { if (global.BPUI && global.BPUI.toast) { global.BPUI.toast(msg, { type: type || "ok" }); return; } } catch (e) {} }
  function errText(e) { try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: "share the booklet" }); } catch (x) {} return String((e && e.message) || "Something went wrong"); }

  let dlg = null;
  function dialog() {
    if (dlg) return dlg;
    dlg = el("dialog", "bk-dlg"); dlg.setAttribute("aria-labelledby", "bkDlgTitle");
    const head = el("div", "bk-head"); const h = el("h2", "", "Share booklet"); h.id = "bkDlgTitle"; head.appendChild(h);
    const x = el("button", "bk-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.addEventListener("click", () => dlg.close()); head.appendChild(x);
    dlg.appendChild(head);
    dlg.appendChild(el("p", "bk-sub", "A private, read-only page for your client: event details, floor plan, 3D view, menu, quotation, payments and terms. Internal costs and notes are never shown."));
    const body = el("div", "bk-body"); body.id = "bkDlgBody"; dlg.appendChild(body);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    doc.body.appendChild(dlg);
    return dlg;
  }

  async function renderLive(body, quoteId, cur) {
    clear(body);
    const st = global.BPStore, url = st.booklet.url(cur.token);
    const box = el("div", "bk-live");
    const lab = el("label", "bk-lab", "Booklet link"); lab.setAttribute("for", "bkUrl"); box.appendChild(lab);
    const row = el("div", "bk-row");
    const inp = el("input", "bk-url"); inp.id = "bkUrl"; inp.type = "text"; inp.readOnly = true; inp.value = url; inp.addEventListener("focus", () => inp.select());
    row.appendChild(inp);
    const copy = el("button", "bk-btn", "Copy"); copy.type = "button";
    copy.addEventListener("click", async () => {
      try { await global.navigator.clipboard.writeText(url); toast("Booklet link copied"); }
      catch (e) { inp.focus(); inp.select(); toast("Press Ctrl/Cmd + C to copy", "info"); }
    });
    row.appendChild(copy);
    const open = el("a", "bk-btn ghost", "Open"); open.setAttribute("href", url); open.setAttribute("target", "_blank"); open.setAttribute("rel", "noopener noreferrer");
    row.appendChild(open);
    box.appendChild(row);
    box.appendChild(el("p", cur.expired ? "bk-meta bk-warn" : "bk-meta",
      (cur.expired ? "Expired on " : "Valid until ") + when(cur.expires_at) + " · created " + when(cur.created_at) +
      " · " + (Array.isArray(cur.shared_versions) ? cur.shared_versions.length : 0) + " quote version(s) shown"));
    const acts = el("div", "bk-acts");
    const again = el("button", "bk-btn ghost", "Create a new link"); again.type = "button";
    again.addEventListener("click", () => renderForm(body, quoteId, cur));
    const rev = el("button", "bk-btn danger", "Revoke link"); rev.type = "button";
    rev.addEventListener("click", async () => {
      let ok = true;
      try { if (global.BPUI && global.BPUI.confirm) ok = await global.BPUI.confirm("The client will no longer be able to open this booklet.", { title: "Revoke booklet link?", okLabel: "Revoke", danger: true }); } catch (e) {}
      if (!ok) return;
      rev.disabled = true;
      try { await st.booklet.revoke(quoteId); toast("Booklet link revoked"); await load(quoteId); }
      catch (e) { rev.disabled = false; toast(errText(e), "err"); }
    });
    acts.appendChild(again); acts.appendChild(rev); box.appendChild(acts);
    body.appendChild(box);
  }

  async function renderForm(body, quoteId, cur) {
    clear(body);
    const st = global.BPStore;
    const form = el("form", "bk-form"); form.noValidate = true;
    const f1 = el("label", "bk-lab", "Link valid for"); f1.setAttribute("for", "bkDays");
    const sel = el("select", "bk-in"); sel.id = "bkDays";
    DAYS.forEach((d) => { const o = el("option", "", d + " days"); o.value = String(d); if (d === 30) o.selected = true; sel.appendChild(o); });
    form.appendChild(f1); form.appendChild(sel);

    const fs = el("fieldset", "bk-fs"); fs.appendChild(el("legend", "bk-lab", "Quote versions to show"));
    const vbox = el("div", "bk-vers"); vbox.appendChild(el("p", "bk-meta", "Loading versions…")); fs.appendChild(vbox); form.appendChild(fs);
    let versions = [];
    try { versions = (await st.quotationVersions.list(quoteId)) || []; } catch (e) { versions = []; }
    clear(vbox);
    const prev = cur && Array.isArray(cur.shared_versions) ? cur.shared_versions : null;
    if (!versions.length) vbox.appendChild(el("p", "bk-meta", "No saved quote versions yet — the current quotation is always shown."));
    versions.forEach((v, i) => {
      const lab = el("label", "bk-check"); const cb = el("input"); cb.type = "checkbox"; cb.value = v.id; cb.name = "bkv";
      cb.checked = prev ? prev.indexOf(v.id) >= 0 : true;
      lab.appendChild(cb); lab.appendChild(doc.createTextNode(" " + (v.label || "Version") + " · " + money(v.total) + " · " + when(v.created_at) + (i === 0 ? " (latest)" : "")));
      vbox.appendChild(lab);
    });

    const f3 = el("label", "bk-lab", "Note to your client (optional)"); f3.setAttribute("for", "bkNote");
    const note = el("textarea", "bk-in"); note.id = "bkNote"; note.rows = 2; note.maxLength = 1000; note.value = (cur && cur.note) || "";
    const f4 = el("label", "bk-lab", "Terms (optional — standard terms are shown if empty)"); f4.setAttribute("for", "bkTerms");
    const terms = el("textarea", "bk-in"); terms.id = "bkTerms"; terms.rows = 4; terms.maxLength = 8000; terms.value = (cur && cur.terms) || "";
    form.appendChild(f3); form.appendChild(note); form.appendChild(f4); form.appendChild(terms);
    if (cur) form.appendChild(el("p", "bk-meta bk-warn", "Creating a new link replaces the current one — the old link stops working."));
    const msg = el("p", "bk-err"); msg.setAttribute("role", "alert"); form.appendChild(msg);
    const acts = el("div", "bk-acts");
    if (cur) { const back = el("button", "bk-btn ghost", "Cancel"); back.type = "button"; back.addEventListener("click", () => renderLive(body, quoteId, cur)); acts.appendChild(back); }
    const go = el("button", "bk-btn", "Create link"); go.type = "submit"; acts.appendChild(go); form.appendChild(acts);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); msg.textContent = ""; go.disabled = true;
      const ids = Array.from(form.querySelectorAll('input[name="bkv"]')).filter((c) => c.checked).map((c) => c.value);
      try {
        await st.booklet.share(quoteId, { days: Number(sel.value), versionIds: versions.length ? ids : null, note: note.value.trim(), terms: terms.value.trim() });
        toast("Booklet link ready"); await load(quoteId);
      } catch (err) { go.disabled = false; msg.textContent = errText(err); }
    });
    body.appendChild(form);
  }

  async function load(quoteId) {
    const body = clear(doc.getElementById("bkDlgBody"));
    body.appendChild(el("p", "bk-meta", "Loading…"));
    let cur = null;
    try { cur = await global.BPStore.booklet.current(quoteId); }
    catch (e) { clear(body); body.appendChild(el("p", "bk-err", errText(e))); return; }
    if (cur && cur.token) await renderLive(body, quoteId, cur); else await renderForm(body, quoteId, null);
  }

  async function openFor(btn) {
    const quoteId = quoteIdFor(btn);
    if (!quoteId) { toast("Open an event first to share its booklet.", "info"); return; }
    const d = dialog();
    if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", "");
    await load(quoteId);
  }

  async function wire() {
    const btns = Array.from(doc.querySelectorAll("[data-booklet-share]"));
    if (!btns.length || !global.BPStore) return;
    let can = false;
    try { await global.BPStore.init(); can = global.BPStore.mode() === "supabase" && await global.BPStore.auth.canEditArea("quotes"); } catch (e) { can = false; }
    btns.forEach((b) => {
      if (b.dataset.bkWired) return; b.dataset.bkWired = "1";
      if (!can) { b.hidden = true; return; }
      b.dataset.bkCan = "1"; reveal(b);
      b.addEventListener("click", () => openFor(b));
    });
  }

  // shown only to quote editors, and (data-wait-quote) only once the page has set data-quote
  function reveal(b) { if (b && b.dataset.bkCan === "1" && (!b.hasAttribute("data-wait-quote") || quoteIdFor(b))) b.hidden = false; }

  global.HelmBookletShare = { quoteIdFor, wire, reveal, DAYS };
  if (doc && doc.querySelector("[data-booklet-share]")) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", wire); else wire();
  }
})(typeof window !== "undefined" ? window : globalThis);
