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

  const BOOKLET_SUB = "A private, read-only page for your client: event details, floor plan, 3D view, menu, quotation, payments and terms. Internal costs and notes are never shown.";
  // R113 (0322): free-trial approval = test mode (same words as trial-test-note.js on the quote page)
  const TRIAL_NOTE = "Trial: your client sees a test-mode approval page (no code is sent).";
  const TRIAL_ASK = "Their page gets an Approve button - in the free trial it is a test approval (code 000000, nothing is sent). Untick to share the booklet only.";
  const SHARE_SUB = "One private link for your client: the event booklet, the quotation and an Approve button. Internal costs and notes are never shown.";

  /* ---- r21: "Share with client" = booklet + approval link in ONE dialog ([data-approval] buttons) ----
     Before the client approves: an "Ask the client to approve" switch (on by default) with "Send for approval ->",
     which mints the approval link with the SAME calls as the quote page (approval.generateToken -> links.build
     "portal") and offers Copy / Open / Send by email (email-send.js, kind "approval"; e-mail only where it is
     allowed). Once approved / paid (or cancelled / closed) the dialog is plain "Share booklet": no approval step.
     The server re-checks every permission; nothing new is created here beyond those existing calls. */
  function approvalDone(q) {
    if (!q) return true;   // could not read the quote: never offer an approval step on it
    const ap = String(q.approvalStatus || q.approval_status || "none");
    if (ap === "approved" || ap === "paid" || q.status === "cancelled" || q.lifecycleStage === "closed" || q.closedAt) return true;
    try { const B = global.BPStore; if (B && B.quoteStatus && B.quoteStatus(q, {}).confirmed) return true; } catch (e) {}
    return false;
  }
  function setMode(ask) {
    const t = doc.getElementById("bkDlgTitle"), sub = doc.getElementById("bkDlgSub"), bh = doc.getElementById("bkBookletH");
    if (t) t.textContent = ask ? "Share with client" : "Share booklet";
    if (sub) sub.textContent = ask ? SHARE_SUB : BOOKLET_SUB;
    if (bh) { bh.hidden = !ask; bh.textContent = "Event booklet \u00b7 included on the client's page"; }
    const b = doc.getElementById("bkApprBody"); if (b) b.hidden = !ask;
  }
  async function renderApproval(quoteId, wanted) {
    const box = doc.getElementById("bkApprBox"); if (!box) return;
    clear(box); box.hidden = true; setMode(false);
    if (!wanted) return;
    const st = global.BPStore; let q = null;
    try { q = await st.quotes.get(quoteId); } catch (e) { q = null; }
    if (approvalDone(q) || !st.approval || typeof st.approval.generateToken !== "function") return;
    const ap = String(q.approvalStatus || q.approval_status || "none");
    const ask = el("label", "bk-ask"); ask.setAttribute("for", "bkAsk");
    const cb = el("input"); cb.type = "checkbox"; cb.id = "bkAsk"; cb.checked = true;
    const txt = el("span"); txt.appendChild(el("b", "", "Ask the client to approve"));
    const askSmall = el("small", "", "Their page gets an Approve button - they confirm with a one-time code. Untick to share the booklet only.");
    txt.appendChild(askSmall);
    ask.appendChild(cb); ask.appendChild(txt); box.appendChild(ask);
    const inner = el("div", "bk-appr-body"); inner.id = "bkApprBody";
    inner.appendChild(el("h3", "bk-part-h", "Approval link"));
    inner.appendChild(el("p", "bk-meta", (ap === "sent" || ap === "viewed")
      ? "Already sent - waiting for the client. Create the link again to copy it or e-mail it."
      : "The client's page shows the booklet, the quotation and the Approve button."));
    const go = el("button", "bk-btn", "Send for approval \u2192"); go.type = "button"; go.id = "bkApprGo";
    const out = el("div", "bk-appr-out"); out.id = "bkApprOut";
    const msg = el("p", "bk-err"); msg.setAttribute("role", "alert");
    inner.appendChild(go); inner.appendChild(msg); inner.appendChild(out); box.appendChild(inner);
    // R113 (0322): a free-trial studio (active or ended) sends the client NO code - their page is a test-mode approval
    try {
      if (st.trialOrg && typeof st.trialOrg.status === "function") st.trialOrg.status().then((t) => {
        if (!t || t.is_trial_org !== true || doc.getElementById("bkTrialNote")) return;
        askSmall.textContent = TRIAL_ASK;
        const n = el("p", "bk-meta", TRIAL_NOTE); n.id = "bkTrialNote"; n.setAttribute("role", "note"); inner.insertBefore(n, go);
      }).catch(() => {});
    } catch (e) {}
    cb.addEventListener("change", () => setMode(cb.checked));
    go.addEventListener("click", async () => {
      msg.textContent = "";
      const c = (q && q.client && typeof q.client === "object") ? q.client : {};
      if (!String(c.email || "").trim() && !String(c.phone || "").trim()) { msg.textContent = "Add the client's email or phone on the quote before sending for approval."; return; }
      try { if (global.HelmCapacity && !(await global.HelmCapacity.gate({ quoteId: quoteId, quote: q, why: "send" }))) return; } catch (e) {}
      const total = q && (q.total != null ? q.total : (q.pricing && q.pricing.total));
      if (!Number(total)) { let ok = true; try { if (global.BPUI && global.BPUI.confirm) ok = await global.BPUI.confirm("No quotation total saved yet. Send anyway?", { title: "Send for approval?", okLabel: "Send anyway" }); } catch (e) {} if (!ok) return; }
      go.disabled = true;
      try {
        const r = await st.approval.generateToken(quoteId);
        const token = (r && (r.token || r.approval_token)) || r;
        const link = await st.links.build("portal", token, global.location.origin + "/portal.html?token=" + encodeURIComponent(token));
        clear(out);
        const lab = el("label", "bk-lab", "Approval link"); lab.setAttribute("for", "bkApprUrl"); out.appendChild(lab);
        const row = el("div", "bk-row");
        const inp = el("input", "bk-url"); inp.id = "bkApprUrl"; inp.type = "text"; inp.readOnly = true; inp.value = link; inp.addEventListener("focus", () => inp.select());
        const copy = el("button", "bk-btn", "Copy"); copy.type = "button";
        copy.addEventListener("click", async () => { try { await global.navigator.clipboard.writeText(link); toast("Approval link copied"); } catch (e) { inp.focus(); inp.select(); toast("Press Ctrl/Cmd + C to copy", "info"); } });
        const open = el("a", "bk-btn ghost", "Preview"); open.setAttribute("href", link + "#preview");   // r23 (0261): a studio preview is never counted as a client view open.setAttribute("target", "_blank"); open.setAttribute("rel", "noopener noreferrer");
        row.appendChild(inp); row.appendChild(copy); row.appendChild(open); out.appendChild(row);
        if (global.HelmEmailSend) global.HelmEmailSend.mount(out, { quoteId: quoteId, kind: "approval", allowUnknown: true, getEmail: () => String(c.email || "") });
        go.textContent = "Create the link again";
        toast("Approval link ready");
        try { global.dispatchEvent(new global.CustomEvent("helm:approval-link", { detail: { quoteId: quoteId } })); } catch (e) {}
      } catch (e) { msg.textContent = (global.BPUI && global.BPUI.friendlyError) ? global.BPUI.friendlyError(e, { action: "create the approval link" }) : String((e && e.message) || "Could not create the approval link"); }
      go.disabled = false;
    });
    box.hidden = false; setMode(true);
  }

  let dlg = null;
  function dialog() {
    if (dlg) return dlg;
    dlg = el("dialog", "bk-dlg"); dlg.setAttribute("aria-labelledby", "bkDlgTitle");
    const head = el("div", "bk-head"); const h = el("h2", "", "Share booklet"); h.id = "bkDlgTitle"; head.appendChild(h);
    const x = el("button", "bk-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.addEventListener("click", () => dlg.close()); head.appendChild(x);
    dlg.appendChild(head);
    const sub = el("p", "bk-sub", BOOKLET_SUB); sub.id = "bkDlgSub"; dlg.appendChild(sub);
    // r21: "Share with client" - the approval link lives in the same dialog as the booklet (renderApproval)
    const ap = el("section", "bk-appr"); ap.id = "bkApprBox"; ap.hidden = true; dlg.appendChild(ap);
    const bh = el("h3", "bk-part-h", "Event booklet"); bh.id = "bkBookletH"; bh.hidden = true; dlg.appendChild(bh);
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
    const open = el("a", "bk-btn ghost", "Open"); open.setAttribute("href", url + "#preview");   // r23 (0261): not counted as a client view open.setAttribute("target", "_blank"); open.setAttribute("rel", "noopener noreferrer");
    row.appendChild(open);
    box.appendChild(row);
    box.appendChild(el("p", cur.expired ? "bk-meta bk-warn" : "bk-meta",
      (cur.expired ? "Expired on " : "Valid until ") + when(cur.expires_at) + " · created " + when(cur.created_at) +
      " · " + versionsNote(cur)));
    mountSections(box, quoteId, cur);
    // r21: while the dialog also makes the approval link, the client's approval page already carries the booklet -
    // sending the booklet on its own is folded away (one obvious send) but still one click away
    const ab = doc.getElementById("bkApprBody"), asking = !!(ab && !ab.hidden);
    if (asking) { const more = el("details", "bk-more"); more.appendChild(el("summary", "", "Send the booklet link on its own")); box.appendChild(more); mountSend(more, quoteId, cur, url); }
    else mountSend(box, quoteId, cur, url);
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

  // r19 L11 (0220): which sections the LIVE link shows, as switches - a change applies to the same link at once
  // (booklet_set_sections; the client sees it on the next visit). Before 0220 (no sections on the link) nothing shows.
  const LIVE_SECTIONS = [["studio", "Studio details"], ["client", "Client details"], ["venue", "Venue details"], ["menu", "Menu / packages"],
    ["layout2d", "Floor plan"], ["layout3d", "3D view"], ["quotation", "Quotation"], ["payments", "Payments"], ["terms", "Terms"]];
  function liveSections(cur) {
    const s = cur && cur.sections && typeof cur.sections === "object" ? cur.sections : null; if (!s) return null;
    const out = {}; LIVE_SECTIONS.forEach((x) => { out[x[0]] = s[x[0]] !== false; }); return out;
  }
  function mountSections(box, quoteId, cur) {
    const st = global.BPStore, state = liveSections(cur);
    if (!state || !st || !st.booklet || typeof st.booklet.setSections !== "function" || cur.expired) return null;
    const fs = el("fieldset", "bk-fs bk-secs"); fs.appendChild(el("legend", "bk-lab", "What the client sees"));
    const list = el("div", "bk-seclist"); fs.appendChild(list);
    const note = el("p", "bk-meta"); note.setAttribute("aria-live", "polite"); fs.appendChild(note);
    if (cur.layoutAutoOn) note.textContent = "Floor plan and 3D view are now shown — this event has a saved layout. Switch them off if the client should not see them.";
    LIVE_SECTIONS.forEach((x) => {
      const id = "bkSec_" + x[0], lab = el("label", "bk-check"); lab.setAttribute("for", id);
      const cb = el("input"); cb.type = "checkbox"; cb.id = id; cb.setAttribute("role", "switch"); cb.setAttribute("data-sec", x[0]); cb.checked = state[x[0]];
      cb.addEventListener("change", async () => {
        const want = cb.checked; cb.disabled = true; note.textContent = "Saving…";
        try {
          const r = await st.booklet.setSections(quoteId, { [x[0]]: want });
          state[x[0]] = want; if (r && r.sections && typeof r.sections === "object") cur.sections = r.sections;
          note.textContent = x[1] + (want ? " is shown" : " is hidden") + " on this booklet link — the client sees the change on their next visit.";
        } catch (e) { cb.checked = !want; note.textContent = ""; toast(errText(e), "err"); }
        cb.disabled = false;
      });
      lab.appendChild(cb); lab.appendChild(doc.createTextNode(" " + x[1])); list.appendChild(lab);
    });
    box.appendChild(fs);
    return fs;
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
    let cur = null, autoOn = false;
    // r19 L11 (0220): a link made while the layout was empty had the floor plan / 3D view switched off -
    // turn them on now that the layout has objects (server-checked; never after someone switched sections)
    try { const B = global.BPStore.booklet; if (B && typeof B.layoutAutoOn === "function") { const r = await B.layoutAutoOn(quoteId); autoOn = !!(r && r.changed); } } catch (e) { autoOn = false; }
    try { cur = await global.BPStore.booklet.current(quoteId); if (cur && autoOn) cur.layoutAutoOn = true; }
    catch (e) { clear(body); body.appendChild(el("p", "bk-err", errText(e))); return; }
    if (cur && cur.token) await renderLive(body, quoteId, cur); else await renderForm(body, quoteId, null);
  }

  async function openFor(btn) {
    const quoteId = quoteIdFor(btn);
    if (!quoteId) { toast("Open an event first to share its booklet.", "info"); return; }
    const d = dialog();
    if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", "");
    await renderApproval(quoteId, btn.hasAttribute("data-approval"));
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

  global.HelmBookletShare = { quoteIdFor, wire, reveal, DAYS, sendText, istDate, liveSections, LIVE_SECTIONS, approvalDone };
  if (doc && doc.querySelector("[data-booklet-share]")) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", wire); else wire();
  }
})(typeof window !== "undefined" ? window : globalThis);
