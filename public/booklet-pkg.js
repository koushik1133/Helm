/* booklet-pkg.js — "Choose your package" on the client booklet (booklet.html?t=<token>, 0069).
   • Data only from BPStore.pkgflow.packages(token) / choose() / otpRequest(); the server is the
     authority for prices, limits, lock and OTP. This file only presents and forwards.
   • DOM via createElement / textContent / setAttribute — no HTML strings.
   • The confirm dialog traps focus, closes on Escape, and returns focus to the opener.
   • Everything interactive carries .pk-ctl, which the print stylesheet hides. */
(function (global) {
  "use strict";
  const doc = global.document;
  const fmt = { locale: "en-IN", currency: "INR" };

  /* ---- pure helpers (exported for tests) ---- */
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function setFormat(locale, currency) {
    try { if (locale && typeof locale === "string") { new Intl.NumberFormat(locale); fmt.locale = locale; } } catch (e) {}
    if (currency && /^[A-Z]{3}$/.test(String(currency))) fmt.currency = String(currency);
    return { locale: fmt.locale, currency: fmt.currency };
  }
  function money(n, cur) {
    const v = num(n); if (v == null) return "—";
    try { return new Intl.NumberFormat(fmt.locale, { style: "currency", currency: cur && /^[A-Z]{3}$/.test(cur) ? cur : fmt.currency, maximumFractionDigits: 0 }).format(v); }
    catch (e) { return String(Math.round(v)); }
  }
  function limits(p) {
    const lo = Math.max(1, Math.round(num(p && p.min_guests) || 1));
    let hi = Math.round(num(p && p.max_guests) || 0); if (!hi || hi < lo) hi = Math.max(lo, 5000);
    return { min: lo, max: hi };
  }
  function clampGuests(n, p) { const l = limits(p); const v = Math.round(num(n) || 0); return Math.min(l.max, Math.max(l.min, v || l.min)); }
  function estimate(p, guests) { const pp = p && p.per_person != null && p.per_person !== "" ? num(p.per_person) : null; return pp == null ? null : pp * clampGuests(guests, p); }
  // https:// links, or a same-site path (never protocol-relative / javascript:)
  function safeUrl(u) {
    const s = typeof u === "string" ? u.trim() : "";
    if (!s || s.length > 600 || /[\s"'<>\\]/.test(s)) return null;
    if (/^https:\/\//i.test(s)) return s;
    if (/^\/(?!\/)/.test(s)) return s;
    return null;
  }
  const STATUS = { pending: 1, accepted: 1, declined: 1, superseded: 1 };
  // which face the section shows
  function phase(d) {
    if (!d || typeof d !== "object") return "off";
    if (d.mode === "hidden" || d.mode === "selected") return "off";     // menu hidden / studio already picked the package
    const sel = d.current_selection && STATUS[d.current_selection.status] ? d.current_selection : null;
    const t = d.totals || {};
    if (sel && sel.status === "accepted" && num(t.paid) > 0) return "paid";
    if (sel && sel.status === "accepted" && d.quote_ready && safeUrl(d.quote_ready.approve_url)) return "ready";
    if (sel && sel.status === "accepted") return "accepted";
    if (sel && sel.status === "pending") return "pending";
    if (d.locked) return "locked";
    if (sel && sel.status === "declined") return "declined";
    return "choose";
  }
  // status timeline: chosen → under review → updated quote ready → paid
  function timeline(d) {
    const p = phase(d);
    const cur = { pending: 1, accepted: 2, ready: 3, paid: 4 }[p];
    const steps = [["chosen", "Package chosen"], ["review", "Under review"], ["ready", "Updated quote ready"], ["paid", "Paid"]];
    return steps.map((s, i) => ({ key: s[0], label: s[1],
      state: cur == null ? "todo" : i < cur ? "done" : i === cur ? "current" : "todo" }));
  }
  function canChoose(d) { const p = phase(d); return p === "choose" || p === "declined"; }

  /* ---- DOM ---- */
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function btn(cls, text) { const b = el("button", cls, text); b.type = "button"; return b; }
  const LOCK_REASON = { frozen: "the event details are frozen", confirmed: "the event is confirmed", too_close: "the event is too close",
    menu_locked: "the menu is locked", selected: "the studio has already chosen your package", hidden: "the studio hasn't shared packages" };
  function errText(e) {
    const m = String((e && e.message) || ""), h = String((e && e.hint) || (e && e.status) || "");
    if (e && (e.code === "25006" || h === "studio_suspended")) return "This booklet is paused right now. Please contact the studio.";
    if (h === "otp_invalid") return "That code didn't match. Please check it and try again.";
    if (h === "otp_required") return "Please enter the code we sent you.";
    if (h === "rate_limited") return "Too many attempts — please wait a few minutes and try again.";
    if (h === "guests") return "Please choose a guest count within the package's limits.";
    if (h === "package") return "This package is no longer available. Please choose another.";
    if (h === "locked") { const r = (/\(([a-z_]+)\)/.exec(m) || [])[1]; return "Package choices are closed" + (LOCK_REASON[r] ? " — " + LOCK_REASON[r] : "") + ". Please contact the studio."; }
    if (/too many/i.test(m)) return "Too many attempts — please wait a few minutes and try again.";
    if (/code|otp/i.test(m)) return "That code didn't match. Please check it and try again.";
    if (/lock/i.test(m)) return "Package choices are closed for this event. Please contact the studio.";
    if (/guest/i.test(m)) return "Please choose a guest count within the package's limits.";
    return "Something went wrong. Please try again, or contact the studio.";
  }

  const S = { token: null, data: null, box: null, live: null, choosing: false, lastFocus: null };

  function renderStatus(d) {
    const live = clear(S.live), p = phase(d), sel = d.current_selection || {}, t = d.totals || {};
    const pkg = (d.packages || []).find((x) => x && x.id === sel.package_id);
    if (p === "choose") return;
    const card = el("div", "pk-status pk-" + p);
    const title = { pending: "Thanks — your choice is with the studio", accepted: "Your package is confirmed",
      ready: "Your updated quotation is ready", paid: "Payment received", locked: "Package choices are closed",
      declined: "The studio couldn't confirm this choice" }[p];
    card.appendChild(el("h3", "", title));
    if (pkg || sel.guests) card.appendChild(el("p", "pk-sel", [pkg ? pkg.name : "", num(sel.guests) ? sel.guests + " guests" : ""].filter(Boolean).join(" · ")));
    if (p === "pending") card.appendChild(el("p", "", "We'll update your quotation and let you know as soon as it's reviewed."));
    if (p === "locked") card.appendChild(el("p", "", "Changes can no longer be made online this close to the event. Please contact the studio for any change."));
    if (p === "declined") {
      if (sel.decline_reason) { const q = el("blockquote", "pk-reason"); q.textContent = String(sel.decline_reason).slice(0, 500); card.appendChild(q); }
      const again = btn("btn pk-ctl", "Choose again"); again.id = "pkAgain";
      again.addEventListener("click", () => { S.choosing = true; renderCards(d); const f = S.box.querySelector(".pk-card button"); if (f) f.focus(); });
      card.appendChild(again);
    }
    if (p !== "locked" && p !== "declined") {
      const ol = el("ol", "pk-steps"); ol.setAttribute("aria-label", "Progress");
      timeline(d).forEach((s) => { const li = el("li", "pk-step " + s.state, s.label); if (s.state === "current") li.setAttribute("aria-current", "step"); ol.appendChild(li); });
      card.appendChild(ol);
    }
    const payUrl = d.quote_ready && safeUrl(d.quote_ready.approve_url);
    if (payUrl && (p === "ready" || (p === "paid" && num(t.balance) > 0))) {
      const a = el("a", "btn pk-ctl", p === "ready" ? "Review & pay" : "Pay the balance"); a.setAttribute("href", payUrl); a.setAttribute("rel", "noopener noreferrer");
      card.appendChild(a);
    }
    if ((p === "paid" || p === "ready") && d.totals && num(t.total) != null) {
      const dl = el("dl", "pk-totals"), bal = num(t.balance);
      [["Total", t.total], ["Paid", t.paid], [bal != null && bal < 0 ? "Credit" : "Balance", bal != null && bal < 0 ? -bal : t.balance]].filter((x) => x[1] != null).forEach((x) => { const w = el("div"); w.appendChild(el("dt", "", x[0])); w.appendChild(el("dd", "", money(x[1], t.currency))); dl.appendChild(w); });
      card.appendChild(dl);
    }
    live.appendChild(card);
  }

  function stepper(p, onChange) {
    const l = limits(p), wrap = el("div", "pk-stepper pk-ctl");
    const id = "pkg_" + String(p.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    const lab = el("label", "pk-lab", "Guests"); lab.setAttribute("for", id + "_g");
    const minus = btn("pk-sb", "−"), plus = btn("pk-sb", "+");
    minus.setAttribute("aria-label", "Fewer guests"); plus.setAttribute("aria-label", "More guests");
    const inp = el("input", "pk-g"); inp.id = id + "_g"; inp.type = "number"; inp.inputMode = "numeric";
    inp.min = String(l.min); inp.max = String(l.max); inp.step = "1"; inp.value = String(clampGuests(p.min_guests || l.min, p));
    const hint = el("span", "pk-hint", l.min + "–" + l.max + " guests"); hint.id = id + "_h"; inp.setAttribute("aria-describedby", hint.id);
    const set = (v) => { inp.value = String(clampGuests(v, p)); onChange(Number(inp.value)); };
    minus.addEventListener("click", () => set(Number(inp.value) - 1));
    plus.addEventListener("click", () => set(Number(inp.value) + 1));
    inp.addEventListener("change", () => set(inp.value));
    const row = el("div", "pk-srow"); row.appendChild(minus); row.appendChild(inp); row.appendChild(plus);
    wrap.appendChild(lab); wrap.appendChild(row); wrap.appendChild(hint);
    return { node: wrap, value: () => clampGuests(inp.value, p) };
  }

  function renderCards(d) {
    const grid = clear(S.box.querySelector("#pkCards"));
    const show = canChoose(d) && (phase(d) === "choose" || S.choosing);
    grid.hidden = !show;
    if (!show) return;
    const list = Array.isArray(d.packages) ? d.packages.filter((p) => p && p.id && p.name) : [];
    if (!list.length) { grid.appendChild(el("p", "empty", "The studio hasn't added packages yet.")); return; }
    list.forEach((p) => {
      const c = el("article", "pk-card"); const hid = "pkh_" + String(p.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      c.setAttribute("aria-labelledby", hid);
      const h = el("h3", "", String(p.name).slice(0, 80)); h.id = hid; c.appendChild(h);
      c.appendChild(el("p", "pk-price", money(p.per_person, p.currency) + " per guest"));
      if (p.description) c.appendChild(el("p", "pk-desc", String(p.description).slice(0, 400)));
      const items = Array.isArray(p.items) ? p.items.map((x) => (x && typeof x === "object" ? x.name || x.label : x)).filter((x) => typeof x === "string" && x) : [];
      if (items.length) { const ul = el("ul", "pk-items"); items.slice(0, 60).forEach((x) => ul.appendChild(el("li", "", x.slice(0, 80)))); c.appendChild(ul); }
      const est = el("p", "pk-est pk-ctl"); est.setAttribute("aria-live", "polite");
      const st = stepper(p, (g) => { est.textContent = "Estimated " + money(estimate(p, g), p.currency); });
      est.textContent = "Estimated " + money(estimate(p, st.value()), p.currency);
      c.appendChild(st.node); c.appendChild(est);
      const go = btn("btn pk-ctl", "Choose this package");
      go.addEventListener("click", () => openModal(p, st.value(), go));
      c.appendChild(go);
      grid.appendChild(c);
    });
  }

  /* ---- confirm modal (focus-trapped) ---- */
  function modal() { return doc.getElementById("pkModal"); }
  function focusables(m) { return Array.from(m.querySelectorAll("button, input, textarea, a[href]")).filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null); }
  function trap(e) {
    const m = modal(); if (!m || m.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key !== "Tab") return;
    const f = focusables(m); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function closeModal() {
    const m = modal(); if (!m) return; m.hidden = true; doc.body.classList.remove("pk-open");
    doc.removeEventListener("keydown", trap, true);
    if (S.lastFocus && S.lastFocus.isConnected) S.lastFocus.focus(); else { const h = doc.getElementById("h_packages"); if (h) h.focus(); }
  }
  function openModal(p, guests, opener) {
    const m = modal(); S.lastFocus = opener;
    const body = clear(m.querySelector("#pkModalBody"));
    m.querySelector("#pkModalTitle").textContent = "Confirm your package";
    const dl = el("dl", "pk-sum");
    [["Package", p.name], ["Guests", String(guests)], ["Estimated total", money(estimate(p, guests), p.currency)]].forEach((x) => {
      const w = el("div"); w.appendChild(el("dt", "", x[0])); w.appendChild(el("dd", "", String(x[1]))); dl.appendChild(w); });
    body.appendChild(dl);
    body.appendChild(el("p", "pk-fine", "The studio will review your choice and send an updated quotation. Nothing is charged now."));
    const nl = el("label", "pk-lab", "Note for the studio (optional)"); nl.setAttribute("for", "pkNote");
    const note = el("textarea", "pk-note"); note.id = "pkNote"; note.maxLength = 500; note.rows = 3;
    body.appendChild(nl); body.appendChild(note);
    const err = el("p", "pk-err"); err.id = "pkErr"; err.setAttribute("role", "alert"); body.appendChild(err);
    const acts = el("div", "pk-acts");
    const cancel = btn("btn ghost", "Cancel"); cancel.addEventListener("click", closeModal);
    const ok = btn("btn", S.data && S.data.require_otp ? "Send me a code" : "Confirm choice"); ok.id = "pkConfirm";
    acts.appendChild(cancel); acts.appendChild(ok); body.appendChild(acts);
    ok.addEventListener("click", async () => {
      err.textContent = ""; ok.disabled = true;
      try {
        if (S.data && S.data.require_otp) {
          const r = await global.BPStore.pkgflow.otpRequest(S.token);
          if (!r) throw new Error("Package selection is not available yet.");
          otpStep(p, guests, note.value.trim(), r || {});
        } else if (!(await submit(p, guests, note.value.trim(), null, err, ok)) && S.needOtp) {
          S.needOtp = false; const r = await global.BPStore.pkgflow.otpRequest(S.token); otpStep(p, guests, note.value.trim(), r || {});
        }
      } catch (e) { err.textContent = errText(e); ok.disabled = false; }
    });
    m.hidden = false; doc.body.classList.add("pk-open");
    doc.addEventListener("keydown", trap, true);
    ok.focus();
  }
  function otpStep(p, guests, note, r) {
    const m = modal(), body = clear(m.querySelector("#pkModalBody"));
    m.querySelector("#pkModalTitle").textContent = "Enter your code";
    const via = r.channel === "email" ? "e-mail" : "WhatsApp";
    body.appendChild(el("p", "", r.sent === false ? "We couldn't send a code just now. Please try again in a minute." : "We've sent a 6-digit code to you on " + via + "."));
    if (r.dev_code && /^\d{6}$/.test(String(r.dev_code))) body.appendChild(el("p", "pk-fine", "Test mode — your code is " + r.dev_code));
    const lab = el("label", "pk-lab", "Code"); lab.setAttribute("for", "pkOtp");
    const inp = el("input", "pk-otp"); inp.id = "pkOtp"; inp.inputMode = "numeric"; inp.autocomplete = "one-time-code"; inp.maxLength = 6; inp.pattern = "[0-9]{6}";
    body.appendChild(lab); body.appendChild(inp);
    const err = el("p", "pk-err"); err.setAttribute("role", "alert"); body.appendChild(err);
    const acts = el("div", "pk-acts");
    const cancel = btn("btn ghost", "Cancel"); cancel.addEventListener("click", closeModal);
    const ok = btn("btn", "Confirm choice"); ok.id = "pkConfirm";
    ok.addEventListener("click", async () => {
      const code = inp.value.replace(/\D/g, "");
      if (code.length !== 6) { err.textContent = "Please enter the 6-digit code."; inp.focus(); return; }
      ok.disabled = true; await submit(p, guests, note, code, err, ok);
    });
    acts.appendChild(cancel); acts.appendChild(ok); body.appendChild(acts);
    inp.focus();
  }
  async function submit(p, guests, note, otp, err, ok) {
    try {
      const r = await global.BPStore.pkgflow.choose(S.token, p.id, guests, note || null, otp);
      if (r && r.ok === false) { const x = new Error(r.error || r.status || "failed"); x.status = r.status; throw x; }
      if (!r) throw new Error("Package selection is not available yet.");
      const m = modal(), body = clear(m.querySelector("#pkModalBody"));
      m.querySelector("#pkModalTitle").textContent = "Choice sent";
      body.appendChild(el("p", "pk-ok", "Thank you! " + p.name + " for " + guests + " guests is now with the studio for review."));
      const acts = el("div", "pk-acts"); const done = btn("btn", "Done"); done.addEventListener("click", closeModal); acts.appendChild(done); body.appendChild(acts);
      done.focus();
      S.choosing = false; await refresh(); return true;
    } catch (e) { S.needOtp = !!(e && e.hint === "otp_required"); err.textContent = errText(e); ok.disabled = false; return false; }
  }

  function render(d) {
    S.data = d; S.box.hidden = false;
    const p = phase(d);
    S.box.querySelector("#pkLede").textContent = p === "choose" || (p === "declined" && S.choosing)
      ? "Pick the package that suits you best and tell us how many guests to plan for. The studio confirms every choice before anything changes."
      : "Your package choice and where it stands.";
    renderStatus(d); renderCards(d);
  }
  async function refresh() {
    let d = null;
    try { d = await global.BPStore.pkgflow.packages(S.token); } catch (e) { d = null; }
    if (!d || typeof d !== "object") { S.box.hidden = true; return; }
    render(d);
  }
  // called by booklet.js once the booklet has rendered
  async function mount(token, booklet) {
    S.box = doc.getElementById("packages"); S.live = doc.getElementById("pkLive"); S.token = token;
    if (!S.box || !S.live || !global.BPStore || !global.BPStore.pkgflow) return;
    const q = (booklet && booklet.quote) || {};
    setFormat((booklet && booklet.locale) || q.locale, q.currency || (booklet && booklet.currency));
    await refresh();
  }

  global.HelmBookletPkg = { mount, render, phase, timeline, canChoose, clampGuests, limits, estimate, safeUrl, money, setFormat, errText, _state: S };
})(typeof window !== "undefined" ? window : globalThis);
