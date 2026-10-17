/* shell-b-privacy.js — "Hide amounts" privacy screen for presenting in front of clients.
 * Eye button in the top bar. Hidden by default each browser session; showing needs a 4-digit PIN.
 * Masking is VISUAL ONLY: it adds classes / data attributes to what is already on screen and never
 * changes a value, an input's value, or any stored data.
 *   - [data-money] elements, text that looks like money (₹ / Rs / INR / AED / د.إ / $ …, 1,23,456, 12.3 L, 1.2 Cr)
 *   - title attributes and SVG <title> tooltips containing money (stashed while hidden, restored on show)
 *   - inputs that hold money get a CSS class (the value is untouched; editing one reveals it)
 * The PIN is ONE per studio and is checked on the server (0157): the server keeps only a bcrypt hash, counts wrong tries
 * per person, and only a studio admin can change or reset it (Control Center > Hide amounts). Default 0000 until changed.
 * Before 0157 / in local mode the default 0000 applies. The PIN is never stored in this browser.
 * This is a privacy screen, NOT security: the numbers are still in the page and in the user's account. */
(function () {
  "use strict";
  if (window.__hbPriv) return; window.__hbPriv = 1;
  var root = document.documentElement;

  /* ---- tunables ---- */
  var IDLE_MS = 5 * 60 * 1000;          // re-hide after 5 minutes without interaction
  var AWAY_MS = 60 * 1000;              // re-hide when the tab was hidden for longer than this
  var MAX_TRIES = 5, LOCK_MS = 30 * 1000;
  var DEFAULT_PIN = "0000";              // owner decision: the studio PIN until an admin changes it (server-side, 0157)

  var SK = "helm.priv.state", SK_T = "helm.priv.t", SK_AWAY = "helm.priv.away";
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function uid() { try { var u = window.BPStore && BPStore.auth && BPStore.auth.user && BPStore.auth.user(); if (u && u.id) return String(u.id); } catch (e) {} return "local"; }
  function lockKey() { return "helm.priv.lock." + uid(); }

  /* ---------- state ---------- */
  function hidden() { return root.classList.contains("hb-priv-on"); }
  (function initial() {
    var st = ss(SK), now = Date.now(), t = +ss(SK_T) || 0, away = +ss(SK_AWAY) || 0;
    if (st === "shown" && ((t && now - t > IDLE_MS) || (away && now - away > AWAY_MS))) st = null;
    ss(SK_AWAY, null);
    root.classList.toggle("hb-priv-on", st !== "shown");   // default: hidden
  })();

  /* ---------- money detection ---------- */
  var CUR = "(?:₹|Rs\\.?|INR|AED|د\\.إ|USD|US\\$|\\$|€|£|EUR|GBP|SAR|QAR|OMR|KWD|BHD)";
  var NUMS = "\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:L|Cr|K|M|lakh|lakhs|crore|crores)\\b)?";
  var RE = new RegExp(
    "(?:" + CUR + "\\s?[-−]?\\s?" + NUMS + ")" +                         // ₹1,20,000 · Rs 500 · AED 1.2K
    "|(?:[-−]?\\d[\\d,]*(?:\\.\\d+)?\\s?(?:INR|AED|د\\.إ|USD|EUR|GBP)\\b)" + // 1,200 AED
    "|(?:\\b\\d{1,2}(?:,\\d{2})+,\\d{3}(?:\\.\\d+)?\\b)" +               // 1,23,456 (Indian grouping)
    "|(?:\\b\\d+(?:\\.\\d+)?\\s?(?:L|Cr|lakh|lakhs|crore|crores)\\b)" +  // 12.3 L · 1.2 Cr
    "|(?:\\b(?:Rupees|Dirhams?)\\s[A-Za-z ,-]*?\\bonly\\b)",          // manager-1019: amount in words ("Rupees One Lakh ... only")
    "g");
  function hasMoney(s) { RE.lastIndex = 0; return !!s && RE.test(s); }
  var SKIP_TAG = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, TEMPLATE: 1, CODE: 1, PRE: 1 };
  function skipEl(e) {
    for (var n = e; n && n !== document.body; n = n.parentElement) {
      if (n.nodeType !== 1) continue;
      if (SKIP_TAG[n.tagName] || n.isContentEditable || n.id === "hbpModal" || n.classList.contains("hbp-skip") || n.id === "hbRail") return true;
    }
    return false;
  }
  var MONEY_INPUT = /amount|price|rate|cost|total|discount|advance|fee|budget|paid|balance|revenue|value|deposit|payment|subtotal|tax|gst|vat|markup|margin/i;

  function markText(t) {
    var p = t.parentNode; if (!p || p.nodeType !== 1) return;
    if (p.classList && (p.classList.contains("hbp-w") || p.classList.contains("hbp-m"))) { if (!hasMoney(p.textContent)) p.classList.remove("hbp-m"); return; }
    var s = t.nodeValue; if (!s || s.length > 2000 || (!/\d/.test(s) && !/\bonly\b/.test(s)) || !hasMoney(s)) return;
    if (skipEl(p)) return;
    if (p.namespaceURI === "http://www.w3.org/2000/svg") {
      if (p.tagName.toLowerCase() === "title") { stashSvgTitle(p); return; }
      p.classList.add("hbp-m"); return;
    }
    RE.lastIndex = 0; var m, covered = 0; while ((m = RE.exec(s))) covered += m[0].length;
    var trimmed = s.replace(/\s+/g, "").length || 1;
    if (p.childNodes.length === 1 && covered / trimmed >= 0.5) { p.classList.add("hbp-m"); return; }
    /* longer sentence: wrap only the amounts (display-only spans around the same text) */
    var frag = document.createDocumentFragment(), last = 0; RE.lastIndex = 0;
    while ((m = RE.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      var w = document.createElement("span"); w.className = "hbp-w hbp-m"; w.textContent = m[0]; frag.appendChild(w);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    selfMut = true; p.replaceChild(frag, t); selfMut = false;
  }
  function stashTitle(e) {
    var tt = e.getAttribute("title"); if (!tt || !hasMoney(tt)) return;
    e.setAttribute("data-hbp-title", tt); e.removeAttribute("title");
  }
  function stashSvgTitle(t) { if (t.hasAttribute("data-hbp-t")) return; t.setAttribute("data-hbp-t", t.textContent); selfMut = true; t.textContent = "Amount hidden"; selfMut = false; }
  function markInput(i) {
    if (i.type === "hidden" || i.type === "checkbox" || i.type === "radio" || i.type === "password") return;
    var sig = [i.id, i.name, i.getAttribute("aria-label"), i.placeholder, i.className, i.getAttribute("data-k")].join(" ");
    if (i.hasAttribute("data-money") || hasMoney(i.value) || ((i.type === "number" || i.inputMode === "decimal" || i.inputMode === "numeric") && MONEY_INPUT.test(sig)))
      i.classList.add("hbp-in");
  }
  function scan(node) {
    if (!node) return;
    if (node.nodeType === 3) { markText(node); return; }
    if (node.nodeType !== 1) return;
    if (node.id === "hbpModal" || node.id === "hbRail") return;
    if (node.tagName === "INPUT") { markInput(node); return; }
    if (node.hasAttribute && node.hasAttribute("title")) stashTitle(node);
    var w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null), list = [], n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) { if (/\d|\bonly\b/.test(n.nodeValue)) list.push(n); }
      else if (n.tagName === "INPUT") markInput(n);
      else if (n.hasAttribute("title")) stashTitle(n);
    }
    list.forEach(markText);
  }
  function fullScan() { if (document.body) scan(document.body); }
  function unstash() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-hbp-title]"), function (e) { if (!e.hasAttribute("title")) e.setAttribute("title", e.getAttribute("data-hbp-title")); e.removeAttribute("data-hbp-title"); });
    selfMut = true;
    Array.prototype.forEach.call(document.querySelectorAll("title[data-hbp-t]"), function (t) { t.textContent = t.getAttribute("data-hbp-t"); t.removeAttribute("data-hbp-t"); });
    selfMut = false;
  }

  /* ---------- observer: added nodes only, batched per animation frame ---------- */
  var mo = null, queue = [], queued = false, selfMut = false;
  function flush() { if (!queued) return; queued = false; var q = queue; queue = []; if (!hidden()) return; for (var i = 0; i < q.length; i++) if (q[i].isConnected) scan(q[i]); }
  function observe() {
    if (mo || !window.MutationObserver) return;
    mo = new MutationObserver(function (muts) {
      if (selfMut) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "attributes") { if (m.target.nodeType === 1 && m.target.hasAttribute("title")) queue.push(m.target); continue; }
        for (var j = 0; j < m.addedNodes.length; j++) queue.push(m.addedNodes[j]);
      }
      if (queue.length && !queued) { queued = true; if (window.requestAnimationFrame) requestAnimationFrame(flush); setTimeout(function () { if (queued) flush(); }, 120); }   /* rAF batch; timer backup for background tabs (no rAF) */
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
  }
  function unobserve() { if (mo) { mo.disconnect(); mo = null; } queue = []; }
  function inputWatch(e) { var t = e.target; if (hidden() && t && t.tagName === "INPUT" && !t.classList.contains("hbp-in")) markInput(t); }

  /* ---------- hide / show ---------- */
  function setHidden(on, why) {
    root.classList.toggle("hb-priv-on", !!on);
    ss(SK, on ? null : "shown");
    if (on) { fullScan(); observe(); } else { unobserve(); unstash(); touch(); }
    paintBtn();
    if (why && window.BPUI && BPUI.toast) try { BPUI.toast(why, { type: "info", timeout: 3500 }); } catch (e) {}
  }
  function touch() { if (!hidden()) ss(SK_T, String(Date.now())); }
  var lastTouch = 0;
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (ev) {
    document.addEventListener(ev, function () { var n = Date.now(); if (n - lastTouch > 5000) { lastTouch = n; touch(); } }, { capture: true, passive: true });
  });
  setInterval(function () { if (!hidden()) { var t = +ss(SK_T) || 0; if (t && Date.now() - t > IDLE_MS) setHidden(true, "Amounts hidden after 5 minutes without activity."); } }, 15000);
  var awayAt = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { awayAt = Date.now(); ss(SK_AWAY, String(awayAt)); return; }
    var a = awayAt; awayAt = 0; ss(SK_AWAY, null);
    if (!hidden() && a && Date.now() - a > AWAY_MS) setHidden(true);
  });
  document.addEventListener("copy", function (e) {   /* belt and braces: masked text never reaches the clipboard */
    if (!hidden()) return;
    try { var sel = document.getSelection(); if (!sel || sel.isCollapsed) return;
      var frag = sel.getRangeAt(0).cloneContents(), box = document.createElement("div"); box.appendChild(frag);
      Array.prototype.forEach.call(box.querySelectorAll(".hbp-m,[data-money]"), function (n) { n.textContent = "••••"; });
      var txt = box.textContent; RE.lastIndex = 0; txt = txt.replace(RE, "••••");
      e.clipboardData.setData("text/plain", txt); e.preventDefault(); } catch (x) {}
  }, true);

  /* ---------- PIN: checked on the server (0157). One PIN per studio, stored only as a bcrypt hash. ----------
   * BPStore.privacyPin.check() returns {ok, tries_left, locked_seconds}; the server counts wrong tries per person.
   * Before 0157 (or in local mode) it returns null and the default PIN 0000 applies, with a local try counter. */
  function pinApi() { var s = window.BPStore; return s && s.privacyPin ? s.privacyPin : null; }
  var pinStatus = null, pinStatusErr = false;
  function loadPinStatus() {
    var a = pinApi(); if (!a) return Promise.resolve(null);
    return Promise.resolve().then(function () { return a.status(); })
      .then(function (s) { pinStatus = s || null; pinStatusErr = false; return pinStatus; }, function () { pinStatusErr = true; return pinStatus; });
  }
  function canChangePin() { return !!(pinStatus && pinStatus.can_change); }
  async function checkPin(pin) {
    var a = pinApi(), r = a ? await a.check(pin) : null;   // throws on a network / server error
    if (!r) return { ok: String(pin) === DEFAULT_PIN, local: true };
    return { ok: r.ok === true, left: Math.max(0, +r.tries_left || 0), lock: Math.max(0, +r.locked_seconds || 0) };
  }
  function lockState() { try { return JSON.parse(ls(lockKey()) || "null") || { n: 0, until: 0 }; } catch (e) { return { n: 0, until: 0 }; } }
  function setLock(o) { ls(lockKey(), o && (o.n || o.until) ? JSON.stringify(o) : null); }
  var PIN_PAGE = "/control.html#privacy-pin";

  /* ---------- PIN modal ---------- */
  var modal = null;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function openModal(mode, done) {
    closeModal();
    var prevFocus = document.activeElement;
    var ov = el("div", "hbp-ov"); ov.id = "hbpModal";
    var dlg = el("div", "hbp-dlg"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "hbpTitle"); dlg.setAttribute("aria-describedby", "hbpDesc");
    var ttl = el("h2", "hbp-title"); ttl.id = "hbpTitle";
    var desc = el("p", "hbp-desc"); desc.id = "hbpDesc";
    var dots = el("div", "hbp-dots"); dots.setAttribute("aria-hidden", "true");
    var inp = el("input", "hbp-input"); inp.type = "password"; inp.inputMode = "numeric"; inp.autocomplete = "off"; inp.maxLength = 4; inp.placeholder = "••••"; inp.pattern = "[0-9]*";
    inp.setAttribute("aria-label", "PIN"); inp.spellcheck = false; inp.setAttribute("data-lpignore", "true"); inp.name = "hbp-" + Math.random().toString(36).slice(2);
    var err = el("p", "hbp-err"); err.setAttribute("role", "alert");
    var pad = el("div", "hbp-pad");
    var foot = el("div", "hbp-foot");
    var cancel = el("button", "hbp-link", "Cancel"); cancel.type = "button";
    var ok = el("button", "hbp-ok", "Unlock"); ok.type = "button";
    dlg.appendChild(ttl); dlg.appendChild(desc); dlg.appendChild(dots); dlg.appendChild(inp); dlg.appendChild(err); dlg.appendChild(pad); dlg.appendChild(foot);
    ov.appendChild(dlg);
    for (var i = 0; i < 4; i++) dots.appendChild(el("i"));
    "1 2 3 4 5 6 7 8 9 ⌫ 0 ✓".split(" ").forEach(function (k) {
      var b = el("button", "hbp-key" + (k === "✓" ? " hbp-key-ok" : ""), k); b.type = "button"; b.tabIndex = -1;
      b.setAttribute("aria-label", k === "⌫" ? "Delete digit" : k === "✓" ? "Enter" : k);
      b.addEventListener("click", function () {
        if (inp.disabled) return;
        if (k === "⌫") inp.value = inp.value.slice(0, -1); else if (k === "✓") { submit(); return; } else if (inp.value.length < 4) { inp.value += k; if (inp.value.length === 4) submit(); }
        sync(); inp.focus();
      });
      pad.appendChild(b);
    });
    var step = mode, busy = false, timer = null;
    function sync() { inp.value = inp.value.replace(/\D/g, "").slice(0, 4); Array.prototype.forEach.call(dots.children, function (d, j) { d.classList.toggle("on", j < inp.value.length); }); }
    function shake(msg) { err.textContent = msg; dlg.classList.remove("hbp-shake"); void dlg.offsetWidth; dlg.classList.add("hbp-shake"); inp.value = ""; sync(); inp.focus(); }
    function unlockDesc() {
      var hint = !pinStatusErr && (!pinStatus || pinStatus.is_default)
        ? " (Default PIN 0000" + (canChangePin() ? " — change it in Control Center.)" : " — your studio admin can change it.)") : "";
      return "Amounts are hidden while you present. Enter your studio's privacy PIN to show them." + hint;
    }
    function paint() {
      clearInterval(timer); err.textContent = ""; inp.disabled = false; ok.disabled = false; while (foot.firstChild) foot.removeChild(foot.firstChild);
      if (step === "forgot") {
        ttl.textContent = "Forgot the PIN?";
        desc.textContent = canChangePin()
          ? "The privacy PIN is one PIN for the whole studio. As an admin you can change it, or put it back to 0000, in Control Center › Hide amounts."
          : "The privacy PIN is one PIN for the whole studio. Only a studio admin can change or reset it — ask your admin for the PIN.";
        ok.textContent = canChangePin() ? "Open Control Center" : "Back";
      } else { ttl.textContent = "Show amounts"; desc.textContent = unlockDesc(); ok.textContent = "Unlock"; }
      dots.hidden = inp.hidden = pad.hidden = step === "forgot";
      foot.appendChild(cancel);
      if (step === "unlock") { var f = el("button", "hbp-link", "Forgot PIN?"); f.type = "button"; f.addEventListener("click", function () { step = "forgot"; paint(); ok.focus(); }); foot.appendChild(f); }
      foot.appendChild(ok);
      inp.value = ""; sync();
      if (step === "unlock") { lockPaint(); setTimeout(function () { if (!inp.disabled) inp.focus(); }, 30); }
    }
    function lockPaint() {
      var L = lockState(), left = L.until - Date.now();
      if (left > 0) {
        inp.disabled = true; ok.disabled = true;
        var tick = function () { var s = Math.ceil((L.until - Date.now()) / 1000); if (s <= 0) { clearInterval(timer); setLock({ n: 0, until: 0 }); err.textContent = ""; inp.disabled = false; ok.disabled = false; inp.focus(); return; } err.textContent = "Too many wrong tries. Try again in " + s + "s."; };
        tick(); timer = setInterval(tick, 500);
      }
    }
    function lockFor(sec) { setLock({ n: 0, until: Date.now() + sec * 1000 }); lockPaint(); }
    async function submit() {
      if (busy) return;
      if (step === "forgot") { if (canChangePin()) { closeModal(); location.href = PIN_PAGE; } else { step = "unlock"; paint(); } return; }
      var v = inp.value;
      if (!/^\d{4}$/.test(v)) { shake("Enter 4 digits."); return; }
      if (lockState().until > Date.now()) { lockPaint(); return; }
      busy = true; var res = null;
      try { res = await checkPin(v); } catch (e) { res = null; }
      busy = false;
      if (!modal) return;   // closed while checking
      if (!res) { shake("Couldn't check the PIN. Check your connection and try again."); return; }
      if (!res.ok) {
        if (res.local) {   /* before 0157: local try counter, as before */
          var L = lockState(); L.n = (L.n || 0) + 1;
          if (L.n >= MAX_TRIES) { L = { n: 0, until: Date.now() + LOCK_MS }; setLock(L); shake("Wrong PIN."); lockPaint(); return; }
          setLock(L); shake("Wrong PIN. " + (MAX_TRIES - L.n) + " " + (MAX_TRIES - L.n === 1 ? "try" : "tries") + " left."); return;
        }
        if (res.lock > 0) { shake("Wrong PIN."); lockFor(res.lock); return; }
        shake("Wrong PIN. " + res.left + " " + (res.left === 1 ? "try" : "tries") + " left."); return;
      }
      setLock(null);
      closeModal(); done();
    }
    inp.addEventListener("input", function () { sync(); if (inp.value.length === 4) submit(); });   // 4th digit unlocks straight away
    ok.addEventListener("click", submit);
    cancel.addEventListener("click", closeModal);
    ov.addEventListener("mousedown", function (e) { if (e.target === ov) closeModal(); });
    dlg.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModal(); return; }
      if (e.key === "Enter") { e.preventDefault(); submit(); return; }
      if (e.key === "Tab") {   // focus trap
        var f = Array.prototype.filter.call(dlg.querySelectorAll("button:not([tabindex='-1']),input"), function (x) { return !x.disabled && !x.hidden && x.offsetParent; });
        if (!f.length) return; var a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    });
    document.body.appendChild(ov);
    modal = { ov: ov, prev: prevFocus, stop: function () { clearInterval(timer); } };
    paint();
    loadPinStatus().then(function () { if (modal && modal.ov === ov && step === "unlock") desc.textContent = unlockDesc(); });
  }
  function closeModal() { if (!modal) return; var m = modal; modal = null; m.stop(); if (m.ov.parentNode) m.ov.parentNode.removeChild(m.ov); try { if (m.prev && m.prev.focus) m.prev.focus(); } catch (e) {} }

  function requestShow() {
    if (!hidden()) return;
    openModal("unlock", function () { setHidden(false); });
  }
  /* the studio PIN is changed by an admin in Control Center (server-side, 0157) */
  function changePin() { location.href = PIN_PAGE; }
  function toggle() { if (hidden()) requestShow(); else setHidden(true); }

  /* ---------- eye button in the top bar (next to search) ---------- */
  var btn = null;
  var EYE = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0";
  var EYE_OFF = "M3 3l18 18|M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9|M6.6 6.6C3.8 8.4 2 12 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4.4-1|M9.9 9.9a3 3 0 0 0 4.2 4.2";
  function svg(d) {
    var NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "hb-svg");
    d.split("|").forEach(function (x) { var p = document.createElementNS(NS, "path"); p.setAttribute("d", x); s.appendChild(p); }); return s;
  }
  function paintBtn() {
    if (!btn) return; var on = hidden();
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(svg(on ? EYE_OFF : EYE));
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    var l = on ? "Amounts hidden — show amounts (needs PIN)" : "Hide amounts while you present";
    btn.setAttribute("aria-label", l); btn.title = l; btn.classList.toggle("hbp-on", on);
  }
  function mountBtn() {
    if (btn && btn.isConnected) return true;
    var tools = document.querySelector("header .hb-tools"); if (!tools) return false;
    btn = document.createElement("button"); btn.type = "button"; btn.className = "hb-ibtn hbp-btn"; btn.id = "hbpBtn"; btn.setAttribute("data-tour", "privacy");
    btn.addEventListener("click", toggle);
    var after = tools.querySelector(".hb-search");
    if (after && after.nextSibling) tools.insertBefore(btn, after.nextSibling); else tools.insertBefore(btn, tools.firstChild);
    paintBtn(); return true;
  }
  function mountFallback() {   /* pages without the shell top bar */
    if (btn && btn.isConnected) return;
    btn = document.createElement("button"); btn.type = "button"; btn.className = "hbp-btn hbp-float"; btn.id = "hbpBtn"; btn.setAttribute("data-tour", "privacy");
    btn.addEventListener("click", toggle); document.body.appendChild(btn); paintBtn();
  }

  /* ---------- one-time hint chip beside the eye button (first time amounts are hidden) ---------- */
  var HINT_K = "helm.priv.hintSeen";
  function hint() {
    if (!btn || !btn.isConnected || !hidden() || ls(HINT_K) === "1") return;
    ls(HINT_K, "1");
    var chip = el("button", "hbp-hint", "Amounts hidden \u2014 tap \u{1F441} to show"); chip.type = "button"; chip.setAttribute("role", "status");
    function place() { try { var r = btn.getBoundingClientRect(); chip.style.top = Math.round(r.bottom + 8) + "px"; chip.style.left = Math.max(8, Math.round(r.right - chip.offsetWidth)) + "px"; } catch (e) {} }
    function gone() { if (chip.parentNode) chip.parentNode.removeChild(chip); btn.removeEventListener("click", gone); window.removeEventListener("resize", place); }
    chip.addEventListener("click", function () { gone(); toggle(); });
    btn.addEventListener("click", gone); window.addEventListener("resize", place);
    document.body.appendChild(chip); place(); setTimeout(gone, 9000);
  }

  /* ---------- ⌘K actions (studio-search palette) ---------- */
  var RUN = { "#hbp-act-toggle": toggle, "#hbp-act-pin": changePin };
  function palette() {
    var api = window.HelmStudioSearch; if (!api || !Array.isArray(api.ACTIONS)) return false;
    var here = location.pathname + location.search;
    [{ id: "hbp-toggle", label: "Hide / show amounts", icon: "\u{1F441}", href: here + "#hbp-act-toggle", need: [], kw: "privacy money prices present client mask blur" },
     /* 0157: one studio PIN, changed by an admin in Control Center (the card tells other roles who can change it) */
     { id: "hbp-pin", label: "Change studio privacy PIN", icon: "\u{1F512}", href: PIN_PAGE, need: [["view", "controls"]], kw: "privacy pin passcode hide amounts money reset 0000" }]
      .forEach(function (a) { if (!api.ACTIONS.some(function (x) { return x.id === a.id; })) api.ACTIONS.push(a); });
    return true;
  }
  function onHash() { var f = RUN[location.hash]; if (!f) return; try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} setTimeout(f, 30); }
  window.addEventListener("hashchange", onHash);

  /* ---------- boot ---------- */
  if (hidden()) observe();
  document.addEventListener("input", inputWatch, true);
  function boot() {
    if (hidden()) fullScan();
    var n = 0; (function wait() { if (mountBtn()) { setTimeout(hint, 600); return; } if (n++ < 40) setTimeout(wait, 150); else { mountFallback(); setTimeout(hint, 600); } })();
    var p = 0; (function pw() { if (!palette() && p++ < 40) setTimeout(pw, 250); })();
    onHash();
    touch();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.HelmPrivacy = { hide: function () { setHidden(true); }, show: requestShow, toggle: toggle, changePin: changePin, isHidden: hidden, rescan: fullScan };
})();
