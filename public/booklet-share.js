/* booklet-share.js — studio side of the client event booklet (0065).
   Any button with [data-booklet-share] opens a "Share booklet" dialog for the event in its
   data-quote attribute (event.html falls back to ?id=). Staff whose role may EDIT quotes create
   a link (expiry, which quote versions to show, a note, terms), copy it, open it, or revoke it.
   The server re-checks every permission (booklet_share / booklet_revoke / booklet_current).
   0200: a live link also gets "Send to client" (Email / WhatsApp, address pre-filled from the quote and
   editable, message preview, send log) - the shared box from invite-site-share.js (HelmSendToClient),
   sending through booklet_send -> comms_outbox -> comms-dispatch. Free trial (0212): e-mail is sent (capped), the WhatsApp option is hidden.
   DOM built with textContent / setAttribute only. */
(function (global) {
  "use strict";
  const doc = global.document;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DAYS = [7, 14, 30, 60, 90, 180];

  // PL1027 #5: no extra versions shared = the client sees the current quotation only
  function versionsNote(cur) {
    const n = Array.isArray(cur.shared_versions) ? cur.shared_versions.length : 0;
    if (n > 0) return n + " quote version" + (n === 1 ? "" : "s") + " shown";
    const v = cur.current_version || cur.version_no || cur.version || 1;
    return "Current quotation (Version " + v + ")";
  }
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  // 0092: studio date order - "12 Oct 2026" (India / UAE) or "Oct 12, 2026" (USA)
  function dateLocale() { try { const B = (typeof window !== "undefined" && window.BPStore) || null; return B && B.studioTax && B.studioTax().country === "US" ? "en-US" : "en-IN"; } catch (e) { return "en-IN"; } }
  // qa-quote-flow B28: dates in the STUDIO's time zone (same day as the "valid until" in the sent message and on
  // the booklet), never the viewer's browser zone - a link expiring 18 Nov 01:30 IST read "17 Nov" in a UTC browser
  function when(t) { const d = new Date(t); if (isNaN(d.getTime())) return "";
    try { const B = (typeof window !== "undefined" && window.BPStore) || null; if (B && B.fmtStudioDate) return B.fmtStudioDate(d, { style: "long" }); } catch (e) {}
    try { return d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }); } catch (e) { return d.toISOString().slice(0, 10); } }
  function money(n) { const v = Number(n); if (!isFinite(v)) return ""; if ((typeof window!=="undefined"&&window.BPStore&&window.BPStore.studioTax&&window.BPStore.studioTax().country!=="IN")) return window.BPStore.studioMoney(v, { round: true }); try { return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 0 }); } catch (e) { return "₹" + Math.round(v); } }
  function quoteIdFor(btn) {
    const q = btn && btn.getAttribute("data-quote");
    if (q && UUID_RE.test(q)) return q;
    if (btn && btn.hasAttribute("data-quote-from-url")) { const id = global.HelmUrl ? global.HelmUrl.value("id") : new URLSearchParams(global.location.search).get("id"); if (id && UUID_RE.test(id)) return id; }
    return null;
  }
  function toast(msg, type) { try { if (global.BPUI && global.BPUI.toast) { global.BPUI.toast(msg, { type: type || "ok" }); return; } } catch (e) {} }
  // 0200: the same text the server queues (booklet_send): name / studio cut to 60, expiry as an India date
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function istDate(iso) { const t = Date.parse(String(iso || "")); if (!isFinite(t)) return ""; const d = new Date(t + 330 * 60000);
    return d.getUTCDate() + " " + MON[d.getUTCMonth()] + " " + d.getUTCFullYear(); }
  function sendText(q, studio, link, expiresAt) {
    const c = q && q.client && typeof q.client === "object" ? q.client : {};
    const name = String(c.name || "").replace(/\s+/g, " ").trim().slice(0, 60) || "there";
    const st = String(studio || "").replace(/\s+/g, " ").trim().slice(0, 60) || "your event planner";
    const until = istDate(expiresAt);
    return "Hi " + name + ", here is your event booklet from " + st + ": " + String(link || "") + (until ? " (valid until " + until + ")" : "");
  }
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
      " · " + versionsNote(cur)));
    mountSend(box, quoteId, cur, url);
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

  // 0200 "Send to client" under the live link (shared box, invite-site-share.js)
  let trialP = null;
  function trialOnce() {
    const st = global.BPStore;
    return trialP || (trialP = st && st.subscription && st.subscription.trial
      ? Promise.resolve(st.init()).then(() => st.subscription.trial()).then((t) => !!(t && t.status === "trial")).catch(() => false)
      : Promise.resolve(false));
  }
  function mountSend(box, quoteId, cur, url) {
    const st = global.BPStore, S2C = global.HelmSendToClient;
    if (!S2C || !st || !st.booklet || !st.booklet.send) return null;
    const sec = el("section", "bk-send"); sec.setAttribute("aria-labelledby", "bkSendTitle");
    const h = el("h3", "bk-send-h", "Send to client"); h.id = "bkSendTitle"; sec.appendChild(h);
    box.appendChild(sec);
    let quote = null, studio = "";
    const live = !cur.expired && !!cur.token;
    const share = S2C.mount(sec, {
      ready: () => live, getLink: () => (live ? url : ""), getQuote: () => quote,
      country: () => { try { return (st.studioTax && st.studioTax().country) || "IN"; } catch (e) { return "IN"; } },
      message: (q, link) => sendText(q, studio, link, cur.expires_at),
      gateText: "This booklet link has expired \u2014 create a new link to send it.",
      pendingPreview: "Create a new booklet link to send it to your client.",
      logKey: () => quoteId + ":" + cur.token,
      send: (ch, to, optIn, consent) => st.booklet.send(quoteId, ch, to, optIn, consent),
      sendLog: () => st.booklet.sendLog(quoteId),
      trial: trialOnce(),
    });
    if (!share) return null;
    Promise.resolve().then(() => st.quotes.get(quoteId)).then((q) => { quote = q; share.refresh(); }).catch(() => {});
    Promise.resolve().then(() => st.org.current()).then((o) => { studio = (o && o.name) || ""; share.refresh(); }).catch(() => {});
    return share;
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
    if (!versions.length) vbox.appendChild(el("p", "bk-meta", "Only the current quotation (Version 1) so far — it is always shown. Earlier versions appear here once you save a revised quote."));
    versions.forEach((v, i) => {
      const lab = el("label", "bk-check"); const cb = el("input"); cb.type = "checkbox"; cb.value = v.id; cb.name = "bkv";
      cb.checked = prev ? prev.indexOf(v.id) >= 0 : true;
      lab.appendChild(cb); lab.appendChild(doc.createTextNode(" " + (v.label || "Version") + " · " + money(v.total) + " · " + when(v.created_at) + (i === 0 ? " (latest)" : "")));
      vbox.appendChild(lab);
    });

    // 0069: which sections the client sees (+ 2D / 3D screenshots) — share-checklist.js
    const ck = global.HelmShareChecklist ? global.HelmShareChecklist.mount(form, { quoteId: quoteId, cur: cur, embedded: true }) : null;
    const f3 = el("label", "bk-lab", "Note to your client (optional)"); f3.setAttribute("for", "bkNote");
    const note = el("textarea", "bk-in"); note.id = "bkNote"; note.rows = 2; note.maxLength = 1000; note.value = (cur && cur.note) || "";
    const f4 = el("label", "bk-lab", "Terms (optional — standard terms are shown if empty)"); f4.setAttribute("for", "bkTerms");
    const terms = el("textarea", "bk-in"); terms.id = "bkTerms"; terms.rows = 4; terms.maxLength = 8000; terms.value = (cur && cur.terms) || "";
    // trial-data-v3: an empty Terms box starts with the studio's own terms (pricing config termsText), when set
    if (!terms.value) { try { const st = global.BPStore; if (st && st.config && st.config.getPricing) st.config.getPricing().then((pc) => {
      const tt = pc && typeof pc.termsText === "string" ? pc.termsText.slice(0, 8000) : ""; if (tt && !terms.value) terms.value = tt; }).catch(() => {}); } catch (e) {} }
    form.appendChild(f3); form.appendChild(note); form.appendChild(f4); form.appendChild(terms);
    if (cur) form.appendChild(el("p", "bk-meta bk-warn", "Creating a new link replaces the current one — the old link stops working."));
    const msg = el("p", "bk-err"); msg.setAttribute("role", "alert"); form.appendChild(msg);
    const acts = el("div", "bk-acts");
    if (cur) { const back = el("button", "bk-btn ghost", "Cancel"); back.type = "button"; back.addEventListener("click", () => renderLive(body, quoteId, cur)); acts.appendChild(back); }
    const go = el("button", "bk-btn", "Create link"); go.type = "submit"; acts.appendChild(go); form.appendChild(acts);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); msg.textContent = "";
      const ids = Array.from(form.querySelectorAll('input[name="bkv"]')).filter((c) => c.checked).map((c) => c.value);
      // qa-quote-flow B28: with versions listed, at least one must be ticked (an empty list used to make a link anyway)
      if (versions.length && !ids.length) { msg.textContent = "Tick at least one quote version to show the client."; const f0 = form.querySelector('input[name="bkv"]'); if (f0) f0.focus(); return; }
      go.disabled = true;
      try {
        const vids = versions.length ? ids : null;
        if (ck) await ck.uploadSnapshots();
        await st.booklet.share(quoteId, ck ? global.HelmShareChecklist.sharePayload({ days: sel.value, versions: vids, note: note.value.trim(), terms: terms.value.trim(), sections: ck.sections() })
          : { days: Number(sel.value), versionIds: vids, note: note.value.trim(), terms: terms.value.trim() });
        if (ck && ck.attachSnapshots) await ck.attachSnapshots();
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

  global.HelmBookletShare = { quoteIdFor, wire, reveal, DAYS, sendText, istDate };
  if (doc && doc.querySelector("[data-booklet-share]")) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", wire); else wire();
  }
})(typeof window !== "undefined" ? window : globalThis);
