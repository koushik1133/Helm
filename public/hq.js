/* hq.js — Helm HQ, the private platform-owner dashboard (migrations 0029 + 0045).
   Not linked from anywhere. Signed out → sign-in page. Signed in but not a
   platform operator → an ordinary "page not found" (the route never confirms it
   exists). The real control is in the database: every hq_* RPC is SECURITY
   DEFINER and refuses (42501) anyone not in public.platform_admins; every HQ
   write also needs a two-step (aal2) session and is audit-logged.
   0045: HQ shows NO studio business data — only studios, their people and what
   each studio paid Helm (subscription billing).
   External file — no inline script, so the hash-based CSP needs no change.
   All values are written with textContent / createElement (never parsed as HTML).
   r27 (0277): HQ STAFF ROLES - hq_me() says who I am (role, permissions, status); pages / buttons a role can't use are
   hidden (the database refuses them anyway), two-step always, idle sign-out, a fresh code before big changes
   (HQ_REAUTH), "Staff access" = the HQ team with monitoring + Helm e-mail addresses.
   r28 (HQ v2): Overview · Studios · Billing · Requests · Plans · People · Security & activity · HQ team · Settings;
   e-mails / phones / PAN / GSTIN are MASKED by default and "Show" is logged first (hq_log_reveal, 0278; a database
   without 0278 logs a throttled hq_heartbeat('reveal') tick instead); phones get a slide-in menu + bottom bar and
   tables turn into cards (data-label from the column headings). ?demo=1 on localhost only = made-up data in the
   browser (hq-demo.js, never deployed - .vercelignore). */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var PAGE = 25, sOff = 0, uOff = 0, sTimer = null, uTimer = null, plans = [], lastBilling = null;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k]; else if (k === "cls") e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function int(v) { return num(v).toLocaleString("en-IN"); }
  // the exact amount in its own currency (forms, confirmations, plan prices, invoices)
  function moneyRaw(v, cur) {
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", maximumFractionDigits: 2 }).format(num(v)); }
    catch (e) { return (cur || "INR") + " " + num(v).toFixed(2); }
  }
  /* r28 (owner): HQ shows money in US dollars by default. Rupee amounts are converted with a rate the HQ person sets
     in Settings (this browser only; default 84) and marked "≈"; a hover shows the exact rupee amount. "Original"
     shows every amount in its own currency. Nothing stored on the server changes. */
  var DISP = { cur: "USD", rate: 84 };
  try { var dc = localStorage.getItem("helm.hq.dispCur"), dr = Number(localStorage.getItem("helm.hq.inrPerUsd"));
    if (dc === "USD" || dc === "ORIG") DISP.cur = dc; if (dr >= 1 && dr <= 1000) DISP.rate = dr; } catch (e) {}
  // pure: an amount in display dollars, or null when it stays as it is (exported for tests)
  function toUsd(v, cur, disp) {
    disp = disp || DISP; cur = cur || "INR";
    if (disp.cur !== "USD") return null;
    if (cur === "USD") return { usd: num(v), approx: false };
    if (cur === "INR" && disp.rate > 0) return { usd: num(v) / disp.rate, approx: true };
    return null;
  }
  function usdText(u) { return (u.approx ? "≈ " : "") + new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: u.usd >= 1000 ? 0 : 2 }).format(u.usd); }
  function money(v, cur) { var u = toUsd(v, cur); return u ? usdText(u) : moneyRaw(v, cur); }
  // confirmations: the dollar view plus the exact amount ("≈ $47.62 (₹3,999.00)")
  function moneyBoth(v, cur) { var u = toUsd(v, cur); return u && u.approx ? usdText(u) + " (" + moneyRaw(v, cur) + ")" : moneyRaw(v, cur); }
  function moneyList(list, times) {
    list = Array.isArray(list) ? list : []; times = times || 1;
    if (DISP.cur === "USD" && list.length && list.every(function (m) { return toUsd(m.amount, m.currency); })) {
      var t = 0, ap = false; list.forEach(function (m) { var u = toUsd(m.amount, m.currency); t += u.usd; ap = ap || u.approx; });
      return usdText({ usd: t * times, approx: ap });
    }
    return list.length ? list.map(function (m) { return money(num(m.amount) * times, m.currency); }).join(" + ") : money(0);
  }
  function shortMoney(v) {
    var u = toUsd(v, "INR"); if (!u) return shortInr(v);
    var a = Math.abs(u.usd), s = a >= 1e6 ? (a / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K" : String(Math.round(a));
    return "$" + s;
  }
  // a bare day ("2026-10-26") is shown as that day (new Date("YYYY-MM-DD") is UTC midnight: the day before west of UTC)
  function date(v) {
    if (!v) return "—"; var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
    var d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : new Date(v);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-IN", m ? { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" } : { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });   // r37: HQ = India time
  }
  // L9 (live QA): a studio's trial end is the STUDIO's calendar day of the exact end moment (hq_trial_info 0223 sends
  // the studio's timezone; trial studios are India by default) - the same day the studio sees, never the UTC day or
  // the operator's browser day. An end at exactly midnight belongs to the day before.
  function trialDay(v, tz) {
    if (!v) return "—";
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v).trim())) return date(v);
    var ms = Date.parse(v); if (!isFinite(ms)) return "—";
    var zones = [tz || "Asia/Kolkata", "Asia/Kolkata"];
    for (var i = 0; i < zones.length; i++) {
      try { return new Date(ms - 1).toLocaleDateString("en-IN", { timeZone: zones[i], day: "numeric", month: "short", year: "numeric" }); } catch (e) {}
    }
    return date(v);
  }
  function ago(v) {
    if (!v) return "never"; var d = (Date.now() - new Date(v).getTime()) / 864e5;
    if (!isFinite(d)) return "—"; if (d < 1) return "today"; if (d < 2) return "yesterday"; return Math.floor(d) + " days ago";
  }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function istDay(ms) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); }
  function notFound() {
    document.title = "Page not found — Helm";
    $("#vLoading").hidden = true; $("#vApp").hidden = true; $("#vNotFound").hidden = false;
    var vb = $("#vBlocked"); if (vb) vb.hidden = true; var ve = $("#vLoadErr"); if (ve) ve.hidden = true;   // r118 (F-07): never two screens at once
  }
  // r118 (F-07): an HQ person whose first load failed (network blip, one call failing) - NOT the 404 page: a plain
  // "couldn't load" box with Retry. Only shown after the HQ gate said "this is an HQ person", so it reveals nothing.
  function loadFailed(e) {
    if (blockedNow) return;   // "Session expired" (or another blocked screen) is already up - leave it alone
    $("#vLoading").hidden = true; $("#vApp").hidden = true; $("#vNotFound").hidden = true;
    var vb = $("#vBlocked"); if (vb) vb.hidden = true;
    var ve = $("#vLoadErr"); if (!ve) { notFound(); return; }
    ve.hidden = false; document.title = "Helm HQ";
    var m = $("#leDetail"); if (m) m.textContent = (e && e.message) ? "Details: " + String(e.message).slice(0, 200) : "";
    var r = $("#leRetry"); if (r && !r.dataset.wired) { r.dataset.wired = "1"; r.addEventListener("click", function () { try { location.reload(); } catch (x) {} }); }
    var o = $("#leOut"); if (o && !o.dataset.wired) { o.dataset.wired = "1"; o.addEventListener("click", function () { signOutThen("login.html"); }); }
  }
  function showErr(e) { var b = $("#err"); b.textContent = "Couldn’t complete that: " + ((e && e.message) || "unknown error"); b.hidden = false; }
  function okMsg(t) { var b = $("#ok"); b.textContent = t; b.hidden = false; setTimeout(function () { b.hidden = true; }, 4000); }
  /* ---------------- r28: data minimisation - masked by default, "Show" is logged first ----------------
     pure maskers (exported for tests): never more than a hint of the value */
  var DOT = "\u2022";
  function maskEmail(v) {
    var s = String(v == null ? "" : v).trim(), at = s.lastIndexOf("@");
    if (!s) return "";
    if (at < 1) return s.charAt(0) + DOT + DOT + DOT;
    var local = s.slice(0, at), keep = local.length > 3 ? 2 : 1;
    return local.slice(0, keep) + DOT + DOT + DOT + s.slice(at);
  }
  function maskPhone(v) {
    var s = String(v == null ? "" : v).trim(), d = s.replace(/\D/g, "");
    if (!d) return "";
    var cc = /^\+(\d{1,3})[\s-]/.exec(s), rest = cc ? d.slice(cc[1].length) : d;
    return (cc ? "+" + cc[1] + " " : "") + new Array(Math.max(2, rest.length - 2) + 1).join(DOT) + rest.slice(-2);
  }
  function maskId(v) {
    var s = String(v == null ? "" : v).replace(/\s+/g, "");
    if (!s) return "";
    if (s.length <= 4) return new Array(s.length + 1).join(DOT);
    return s.slice(0, 2) + new Array(s.length - 3).join(DOT) + s.slice(-2);
  }
  var MASKERS = { email: maskEmail, phone: maskPhone, id: maskId };
  // one audit row per reveal (0278 hq_log_reveal: which field, never the value). Older database: a throttled
  // hq_heartbeat("reveal") tick, so it still shows as HQ use. A role refusal / ended sign-in = nothing is shown.
  function logReveal(entity, id, field) {
    return call("hq_log_reveal", { p_entity: entity, p_entity_id: id == null ? null : String(id), p_field: field || "value" }).catch(function (e) {
      if (S && S.errKind(e)) throw e;
      if (/hq_log_reveal|PGRST202|does not exist|schema cache|not find the function/i.test(String((e && e.message) || ""))) return BPStore.hq("hq_heartbeat", { p_page: "reveal" }).catch(function () { return null; });
      throw e;
    });
  }
  // r57 (0298): the database now sends these values ALREADY masked; the real one comes only from hq_reveal, which
  // checks the HQ role, writes the hq.reveal log row and returns the value in one step. A value that is not masked
  // (older database) is masked here and "Show" logs first (hq_log_reveal), as before.
  function isMasked(v) { return String(v == null ? "" : v).indexOf(DOT) >= 0; }
  function revealValue(entity, id, field, shown) {
    return call("hq_reveal", { p_entity: entity, p_entity_id: id == null ? null : String(id), p_field: field || "value" }).then(function (r) {
      return r && typeof r === "object" ? r : { value: null };
    }, function (e) {
      if (S && S.errKind(e)) throw e;
      if (/hq_reveal|PGRST202|does not exist|schema cache|not find the function/i.test(String((e && e.message) || "")) && !isMasked(shown)) {
        return logReveal(entity, id, field).then(function () { return { value: shown }; });
      }
      throw e;
    });
  }
  // a masked value with a small "Show" button; null for an empty value (kvList / joins skip it)
  function masked(value, kind, entity, id, field) {
    var v = String(value == null ? "" : value).trim(); if (!v) return null;
    var hid = isMasked(v) ? v : (MASKERS[kind] || maskId)(v);
    var t = el("span", { cls: "mv hid", text: hid, title: "Masked - press Show to see it (recorded)" });
    var b = el("button", { cls: "rv", type: "button", text: "Show", "aria-label": "Show " + (field || kind).replace(/_/g, " ") + " (recorded in the HQ log)" });
    var w = el("span", { cls: "mask" }, [t, b]);
    b.addEventListener("click", function (e) {
      if (e) e.stopPropagation();
      b.disabled = true;
      revealValue(entity, id, field || kind, v).then(function (r) {
        var real = r.value == null ? "" : String(r.value);
        t.textContent = real || "\u2014"; t.classList.remove("hid"); t.removeAttribute("title"); b.remove();
      }).catch(function (er) { b.disabled = false; showErr(er); });
    });
    return w;
  }
  // "name, masked e-mail · masked phone" under a row heading
  function contactLine(email, phone, entity, id) {
    var me = masked(email, "email", entity, id, "email"), mp = masked(phone, "phone", entity, id, "phone");
    return el("div", { cls: "muted cline" }, [me ? el("div", null, [me]) : null, mp ? el("div", null, [mp]) : null]);
  }
  // r27: who I am in HQ (hq_me, 0277). null = a database without 0277 (everything shown, as before)
  var ME = null, S = window.HelmHqStaff || null, blockedNow = false;
  function can(p) { return !ME || !S ? true : S.can(ME.perms, p); }
  function canTab(t) { return !ME || !S ? true : S.can(ME.perms, S.TAB_PERM[t] || "owner.only"); }
  // every HQ call: a refusal for a big change asks for a fresh two-step code once and retries; an ended / idle /
  // expired HQ sign-in shows "sign in again"; a role refusal gets a plain sentence
  function call(fn, args) {
    return BPStore.hq(fn, args).catch(function (e) {
      var k = S ? S.errKind(e) : null;
      if (k === "reauth") return askCode().then(function () { return BPStore.hq(fn, args); });
      if (k === "idle" || k === "expired" || k === "ended") { sessionOver(S.friendly(k)); throw new Error(S.friendly(k)); }
      if (k === "role" || k === "ip") throw new Error(S.friendly(k, ME && ME.role_label));
      throw e;
    });
  }
  /* ---- r27: fresh two-step code (sudo mode) ---- */
  var codeWait = null;
  function askCode() {
    if (codeWait) return codeWait;
    codeWait = new Promise(function (resolve, reject) {
      var box = $("#reauth"), inp = $("#raCode"), er = $("#raErr"), go = $("#raGo"), no = $("#raCancel");
      if (!box || !BPStore.auth.mfa || !BPStore.auth.mfa.challenge) { reject(new Error("Sign in again to make this change.")); return; }
      er.textContent = ""; inp.value = ""; box.hidden = false; setTimeout(function () { try { inp.focus(); } catch (e) {} }, 30);
      var done = function (ok, err) { box.hidden = true; go.onclick = null; no.onclick = null; inp.onkeydown = null; if (ok) resolve(true); else reject(err || new Error("Cancelled - nothing was changed.")); };
      go.onclick = function () {
        go.disabled = true; er.textContent = "";
        Promise.resolve(BPStore.auth.mfa.challenge(String(inp.value || "").trim())).then(function () { done(true); })
          .catch(function (e) { er.textContent = (e && e.message) || "That code didn't work."; try { inp.select(); } catch (x) {} })
          .then(function () { go.disabled = false; });
      };
      no.onclick = function () { done(false); };
      inp.onkeydown = function (e) { if (e.key === "Enter") go.onclick(); if (e.key === "Escape") done(false); };
    }).then(function (v) { codeWait = null; return v; }, function (e) { codeWait = null; throw e; });
    return codeWait;
  }
  /* ---- r27: blocked states (two-step first / paused / session over) ---- */
  function blocked(title, text, goText, goHref) {
    blockedNow = true;
    $("#vLoading").hidden = true; $("#vApp").hidden = true; $("#vNotFound").hidden = true; $("#vBlocked").hidden = false;
    $("#blkTitle").textContent = title; $("#blkText").textContent = text;
    var g = $("#blkGo"); if (goText) { g.textContent = goText; g.setAttribute("href", goHref || "login.html"); g.hidden = false; } else g.hidden = true;
    document.title = "Helm HQ";
  }
  // r27: an HQ person without two-step sets it up HERE (same QR + code flow as Account settings), then HQ opens.
  // Nobody is locked out: HQ needs two-step, and this screen is how you get it.
  function enrollGate() {
    blocked("Set up two-step first", "Helm HQ needs two-step verification for everyone. Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then type the 6-digit code.", null);
    var box = $("#blkEnroll"), card = document.querySelector("#vBlocked .box");
    if (card) card.classList.add("wide");
    box.hidden = false;
    if (!window.HelmAuthUI || !window.HelmAuthUI.renderEnroll) {
      box.textContent = "Two-step set-up couldn't load here. Use the sign-in page instead.";
      var g = $("#blkGo"); g.textContent = "Set up on the sign-in page"; g.setAttribute("href", "login.html"); g.hidden = false; return;
    }
    window.HelmAuthUI.renderEnroll(box, function () {
      $("#blkTitle").textContent = "Two-step is on"; $("#blkText").textContent = "Opening Helm HQ…";
      setTimeout(function () { try { location.reload(); } catch (e) {} }, 900);
    });
  }
  // r39 (0288): while HQ's Google-only switch is on, a Helm staff person on a password / link sign-in is sent to Google
  async function needsGoogle() {
    if (!BPStore.staffGoogleSessionCheck) return false;
    var r = await BPStore.staffGoogleSessionCheck();
    return !!(r && r.needs_google);
  }
  function googleGate() {
    blocked("Sign in with Google", "Helm staff sign in to HQ with their helm.events Google Workspace account. Sign out, then use Continue with Google on the sign-in page.", "Sign out and use Google", "login.html");
    var g = $("#blkGo"); g.addEventListener("click", function (e) { e.preventDefault(); signOutThen("login.html"); });
  }
  function signOutThen(href) { Promise.resolve(BPStore.auth.signOut && BPStore.auth.signOut()).catch(function () {}).then(function () { location.replace(href || "login.html"); }); }
  // r28 round 2: a clear "Session expired" screen; the sign-in is ended here (nothing left open), the button goes to sign-in
  function sessionOver(text) {
    if (blockedNow) return;
    blocked("Session expired — sign in again", text || "Your Helm HQ sign-in has ended.", "Sign in again", "login.html");
    try { var bo = $("#blkOut"); if (bo) bo.hidden = true; } catch (e) {}
    Promise.resolve(BPStore.auth.signOut && BPStore.auth.signOut()).catch(function () {});
  }
  /* ---- r28 round 2: my HQ session (hq_my_session, 0280): short id, started, ends at; a database without 0280 shows the rules ---- */
  var MYS = null;
  function hhmm(v) { var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }); }   // r37: HQ = India time
  // pure: when an HQ session ends - the earlier of started + max hours and last use + idle minutes (exported for tests)
  function sessionEnds(started, lastUse, idleMin, maxHours) {
    var a = Date.parse(started || ""), b = Date.parse(lastUse || "");
    var hard = isFinite(a) ? a + Math.max(1, Number(maxHours) || 12) * 3600000 : Infinity, soft = isFinite(b) ? b + Math.max(5, Number(idleMin) || 30) * 60000 : Infinity;
    var e = Math.min(hard, soft); return isFinite(e) ? new Date(e).toISOString() : null;
  }
  function paintSession() {
    var box = $("#sessInfo"); if (!box || !ME) return;
    clear(box); box.hidden = false;
    var idle = Number(ME.idle_minutes) || 30, max = Number(ME.max_hours) || 12;
    if (MYS && MYS.started_at) {
      var ends = sessionEnds(MYS.started_at, new Date(lastInput).toISOString(), idle, max);
      box.appendChild(el("span", null, [el("b", { text: "Session " + (MYS.sid || "") }), el("br"), "started " + hhmm(MYS.started_at) + " · ends by " + hhmm(MYS.hard_end_at || sessionEnds(MYS.started_at, null, idle, max)),
        el("br"), "sign-out after " + idle + " min idle" + (ends ? " (" + hhmm(ends) + ")" : "")]));
    } else box.appendChild(el("span", null, ["Sign-out after " + idle + " min idle; sign-ins end after " + max + " h."]));
  }
  function loadMySession() {
    return BPStore.hq("hq_my_session").then(function (r) { MYS = r && !Array.isArray(r) ? r : null; paintSession(); }).catch(function () { MYS = null; paintSession(); });
  }
  /* ---- r27: idle sign-out on this page + throttled "still here" heartbeat (page views, hq_heartbeat) ---- */
  var lastInput = Date.now(), lastBeat = 0, curTab = "overview";
  function beat(page, force) {
    if (!ME || blockedNow) return;
    var t = Date.now(); if (!force && t - lastBeat < 120000) return; lastBeat = t;
    BPStore.hq("hq_heartbeat", { p_page: page || curTab }).catch(function (e) { var k = S && S.errKind(e); if (k === "idle" || k === "expired" || k === "ended") sessionOver(S.friendly(k)); });
  }
  function startWatch() {
    ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (ev) { document.addEventListener(ev, function () { lastInput = Date.now(); }, { passive: true }); });
    setInterval(function () {
      if (!ME || blockedNow) return;
      var idleMs = Math.max(5, Number(ME.idle_minutes) || 30) * 60000;
      if (Date.now() - lastInput > idleMs) { sessionOver(S ? S.friendly("idle") : ""); return; }
      if (MYS && MYS.hard_end_at && Date.now() > Date.parse(MYS.hard_end_at)) { sessionOver(S ? S.friendly("expired") : ""); return; }
      paintSession();
      if (Date.now() - lastInput < 120000 && document.visibilityState === "visible") beat(curTab, false);
    }, 30000);
  }
  // r118 (F-09): Data & privacy rule 3 states the REAL sign-in rules (HQ team -> Sign-in rules), not fixed numbers
  function paintPrivacyRules() {
    if (!ME) return;
    var i = Number(ME.idle_minutes), m = Number(ME.max_hours), a = $("#pvIdle"), b = $("#pvMax");
    if (a && i > 0) a.textContent = int(i) + " minute" + (i === 1 ? "" : "s") + " idle";
    if (b && m > 0) b.textContent = int(m) + " hour" + (m === 1 ? "" : "s");
  }
  // pure (r118 F-08): the tab an address asks for (/hq#studios, #billing, #plans, #activity ... from the Referrals menu);
  // null for none / unknown (exported for tests)
  function hashTab(h) { var t = String(h || "").replace(/^#/, "").toLowerCase(); return TABS.indexOf(t) >= 0 ? t : null; }
  // hide every page / control the role can't use (the database refuses them anyway)
  function applyPerms() {
    Array.prototype.slice.call(document.querySelectorAll("[data-perm]")).forEach(function (n) { if (!can(n.getAttribute("data-perm"))) n.hidden = true; });
    TABS.forEach(function (t) { var b = $("#tab-" + t); if (b && b.parentNode) b.parentNode.hidden = !canTab(t); });
    $("#navgBiz").hidden = !["overview", "studios", "requests", "billing", "plans"].some(canTab);
    $("#navgTeam").hidden = !["people", "activity", "staff", "settings", "privacy"].some(canTab);
    if (!can("studios.read") && !can("people.read")) { var gs = document.querySelector(".gs"); if (gs) gs.hidden = true; }
    var rc = $("#whoRole"); if (rc && ME) { rc.textContent = ME.role_label || ""; rc.hidden = !ME.role_label; }
  }
  function statusPill(s) {
    var tone = { active: "ok", trial: "", past_due: "warn", suspended: "bad", cancelled: "", none: "" }[s || "none"];
    var words = { active: "Paying", trial: "Trial", past_due: "Past due", suspended: "Suspended", cancelled: "Cancelled", none: "No plan" };
    return el("span", { cls: "pill " + (tone || ""), text: words[s || "none"] || String(s).replace("_", " ") });
  }
  function ask(text, def) { var r = window.prompt(text, def || ""); return r == null ? null : String(r).trim(); }
  function openInvoice(fn, id) {
    call(fn, { p_payment_id: id }).then(function (data) {
      if (window.HelmInvoice && typeof window.HelmInvoice.open === "function") window.HelmInvoice.open(data);
      else showErr(new Error("Invoice viewer not loaded"));
    }).catch(showErr);
  }

  /* ---------------- tabs ---------------- */
  var TABS = ["overview", "studios", "billing", "requests", "plans", "people", "activity", "staff", "settings", "privacy"];
  var TITLES = { overview: "Overview", studios: "Studios", billing: "Billing", requests: "Requests", plans: "Plans & prices",
    people: "People", activity: "Security & activity", staff: "HQ team", settings: "Settings", privacy: "Data & privacy" };
  var SUBS = { overview: "Studios, people and Helm subscriptions. Never a studio’s clients, quotes or prices.",
    studios: "Every studio on Helm: plan, status, people and what they paid Helm.", billing: "Money studios paid Helm, invoices, past due and settings.",
    requests: "Plan requests, sales enquiries and suggestions in one inbox.", plans: "The plans studios can buy, their prices and tax rules.",
    people: "Everyone with a Helm login, their studio and two-step.", activity: "What the HQ team did, and security events across studios.",
    staff: "Who can use Helm HQ, what they can do, and when they last used it.",
    settings: "Money display, Helm addresses, invoice and checkout settings.",
    privacy: "What HQ stores and shows about studios and people, why, for how long, and who can see it." };
  function showTab(name) {
    if (!canTab(name)) return;
    curTab = name; beat(name, true);
    var cr = $("#crumbTitle"); if (cr) cr.textContent = TITLES[name] || "Helm HQ";
    var ps = $("#pageSub"); if (ps) ps.textContent = SUBS[name] || "";
    TABS.forEach(function (t) {
      var p = $("#pane-" + t), b = $("#tab-" + t);
      if (p) p.hidden = t !== name;
      if (b) b.setAttribute("aria-pressed", t === name ? "true" : "false");
    });
    var h = $("#pageTitle"); if (h) h.textContent = TITLES[name] || "Helm HQ";
    navOpen(false); paintBnav();
    var dr = $("#studioDrawer"); if (dr && !dr.hidden) closeDrawer();
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  /* ---------------- r28: phone / tablet menu (slide-in sidebar) + bottom bar ---------------- */
  function navOpen(on) {
    var app = $("#vApp"), sc = $("#navScrim"), b = $("#btnMenu"); if (!app || !app.classList || typeof app.classList.toggle !== "function") return;
    app.classList.toggle("nav-open", !!on); if (sc) sc.hidden = !on; if (b) b.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) { var cur = document.querySelector('.side .tab[aria-pressed="true"]'); try { (cur || $("#btnOut")).focus(); } catch (e) {} }
  }
  var BNAV_ICON = { overview: "M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-3H4z", studios: "M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6",
    requests: "M4 6h16v12H4zM4 7l8 6 8-6", billing: "M3 7h18v10H3zM3 11h18M7 15h3", people: "M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
    plans: "M20 12l-8 8-8-8V4h8zM8 8h.01", activity: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", staff: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1",
    more: "M5 12h.01M12 12h.01M19 12h.01" };
  var BNAV_WORD = { overview: "Overview", studios: "Studios", requests: "Requests", billing: "Billing", people: "People", plans: "Plans", activity: "Security", staff: "Team" };
  function bnavIcon(k) { var g = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }); g.appendChild(svg("path", { d: BNAV_ICON[k] || BNAV_ICON.more })); return g; }
  function buildBnav() {
    var nav = $("#bnav"); if (!nav || typeof document.querySelectorAll !== "function") return; clear(nav);
    ["overview", "studios", "requests", "billing", "people", "plans", "activity", "staff"].filter(canTab).slice(0, 4).forEach(function (t) {
      var b = el("button", { type: "button", "data-tab": t }, [bnavIcon(t), el("span", { text: BNAV_WORD[t] })]);
      if (t === "requests") b.appendChild(el("span", { cls: "bb", id: "bnReq", hidden: "hidden" }));
      b.addEventListener("click", function () { var tb = $("#tab-" + t); if (tb) tb.click(); });
      nav.appendChild(b);
    });
    var more = el("button", { type: "button", "aria-label": "More - open the HQ menu" }, [bnavIcon("more"), el("span", { text: "More" })]);
    more.addEventListener("click", function () { navOpen(true); });
    nav.appendChild(more);
    paintBnav();
  }
  function paintBnav() {
    if (typeof document.querySelectorAll !== "function") return;
    Array.prototype.slice.call(document.querySelectorAll("#bnav button[data-tab]")).forEach(function (b) {
      if (b.getAttribute("data-tab") === curTab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    var nb = $("#navReqCount"), bb = $("#bnReq"); if (nb && bb) { bb.textContent = nb.textContent; bb.hidden = nb.hidden; }
  }
  /* ---------------- r28: tables -> cards on phones (each cell carries its column heading) ---------------- */
  function labelTables(root) {
    Array.prototype.slice.call((root || document).querySelectorAll("table.rt")).forEach(function (t) {
      var heads = Array.prototype.slice.call(t.querySelectorAll("thead th")).map(function (th) { return String(th.textContent || "").trim(); });
      if (!heads.length) return;
      Array.prototype.slice.call(t.querySelectorAll("tbody > tr:not(.rowdetail)")).forEach(function (tr) {
        Array.prototype.slice.call(tr.children).forEach(function (td, i) { if (!td.hasAttribute("data-label")) td.setAttribute("data-label", heads[i] || ""); });
      });
    });
  }
  var labelQueued = false;
  function watchTables() {
    if (typeof MutationObserver !== "function" || !document.body || typeof document.querySelectorAll !== "function") return;
    new MutationObserver(function () {
      if (labelQueued) return; labelQueued = true;
      (window.requestAnimationFrame || setTimeout)(function () { labelQueued = false; labelTables(document); });
    }).observe(document.body, { childList: true, subtree: true });
    labelTables(document);
  }

  /* ---------------- r25: small inline-SVG charts (no library; textContent / attributes only) ---------------- */
  var SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, kids) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, String(attrs[k])); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  // pure: a "nice" top for an axis (1, 2, 2.5, 5 x 10^n) - exported for tests
  function niceMax(v) {
    v = Number(v); if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  // pure: short rupees for an axis / tile (₹950, ₹12.5K, ₹3.2L, ₹1.1Cr)
  function shortInr(v) {
    var n = num(v), a = Math.abs(n), s = n < 0 ? "-" : "";
    if (a >= 1e7) return s + "₹" + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, "") + "Cr";
    if (a >= 1e5) return s + "₹" + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, "") + "L";
    if (a >= 1e3) return s + "₹" + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
    return s + "₹" + Math.round(a);
  }
  function monthLabel(ym) { var m = /^(\d{4})-(\d{2})/.exec(String(ym || "")); return m ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[2] - 1] : ""; }
  function weekLabel(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); return m ? (+m[3]) + " " + monthLabel(m[1] + "-" + m[2]) : ""; }
  function emptyChart(box, text) { clear(box).appendChild(svg("svg", { viewBox: "0 0 600 170", role: "img", "aria-label": text }, [svg("text", { x: 300, y: 90, "text-anchor": "middle", "class": "empty-c", text: text })])); }
  // bar chart: rows [{label, value}]
  function barChart(box, rows, fmt, label) {
    rows = rows || []; fmt = fmt || int;
    var W = 600, H = 170, L = 34, B = 22, T = 14, max = niceMax(Math.max.apply(null, rows.map(function (r) { return num(r.value); }).concat([0])));
    if (!rows.length) { emptyChart(box, "No data yet"); return; }
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label || "" });
    [0, 0.5, 1].forEach(function (f) { var y = T + (H - T - B) * (1 - f);
      g.appendChild(svg("line", { x1: L, x2: W, y1: y, y2: y, "class": "grid-l" }));
      g.appendChild(svg("text", { x: L - 6, y: y + 3, "text-anchor": "end", "class": "ax", text: fmt(max * f) })); });
    var step = (W - L) / rows.length, bw = Math.max(6, Math.min(34, step * 0.62));
    rows.forEach(function (r, i) {
      var v = num(r.value), h = (H - T - B) * (v / max), x = L + step * i + (step - bw) / 2, y = H - B - h;
      var b = svg("rect", { x: x.toFixed(1), y: y.toFixed(1), width: bw.toFixed(1), height: Math.max(v > 0 ? 2 : 0, h).toFixed(1), rx: 3, "class": "cbar" });
      b.appendChild(svg("title", { text: r.label + ": " + fmt(v) })); g.appendChild(b);
      if (v > 0) g.appendChild(svg("text", { x: (x + bw / 2).toFixed(1), y: (y - 4).toFixed(1), "text-anchor": "middle", "class": "vl", text: fmt(v) }));
      if (rows.length <= 12 && (i % (rows.length > 8 ? 2 : 1) === 0 || i === rows.length - 1))
        g.appendChild(svg("text", { x: (x + bw / 2).toFixed(1), y: H - 6, "text-anchor": "middle", "class": "ax", text: r.label }));
    });
    clear(box).appendChild(g);
  }
  // line chart: rows [{label, a, b}] - a = solid line + area, b = dashed line
  function lineChart(box, rows, fmt, label) {
    rows = rows || []; fmt = fmt || int;
    if (!rows.length) { emptyChart(box, "No data yet"); return; }
    var W = 600, H = 170, L = 44, B = 22, T = 14;
    var max = niceMax(Math.max.apply(null, rows.map(function (r) { return Math.max(num(r.a), num(r.b)); }).concat([0])));
    var X = function (i) { return L + (rows.length === 1 ? (W - L) / 2 : (W - L - 10) * i / (rows.length - 1)); };
    var Y = function (v) { return T + (H - T - B) * (1 - num(v) / max); };
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label || "" });
    [0, 0.5, 1].forEach(function (f) { var y = T + (H - T - B) * (1 - f);
      g.appendChild(svg("line", { x1: L, x2: W, y1: y, y2: y, "class": "grid-l" }));
      g.appendChild(svg("text", { x: L - 6, y: y + 3, "text-anchor": "end", "class": "ax", text: fmt(max * f) })); });
    var pa = rows.map(function (r, i) { return X(i).toFixed(1) + "," + Y(r.a).toFixed(1); });
    var pb = rows.map(function (r, i) { return X(i).toFixed(1) + "," + Y(r.b).toFixed(1); });
    g.appendChild(svg("polygon", { points: X(0).toFixed(1) + "," + (H - B) + " " + pa.join(" ") + " " + X(rows.length - 1).toFixed(1) + "," + (H - B), "class": "ar-u" }));
    g.appendChild(svg("polyline", { points: pb.join(" "), "class": "ln-s" }));
    g.appendChild(svg("polyline", { points: pa.join(" "), "class": "ln-u" }));
    rows.forEach(function (r, i) {
      var d = svg("circle", { cx: X(i).toFixed(1), cy: Y(r.a).toFixed(1), r: 3.2, "class": "dot" });
      d.appendChild(svg("title", { text: r.label + ": MRR " + fmt(r.a) + " · received " + fmt(r.b) })); g.appendChild(d);
      if (i % 2 === (rows.length - 1) % 2) g.appendChild(svg("text", { x: X(i).toFixed(1), y: H - 6, "text-anchor": "middle", "class": "ax", text: r.label }));
    });
    clear(box).appendChild(g);
  }
  // donut: rows [{label, value}]
  function donut(box, rows, centre, sub) {
    rows = (rows || []).filter(function (r) { return num(r.value) > 0; });
    var total = rows.reduce(function (s, r) { return s + num(r.value); }, 0), R = 52, C = 2 * Math.PI * R, off = 0;
    var g = svg("svg", { viewBox: "0 0 150 150", role: "img", "aria-label": "Plan mix" });
    g.appendChild(svg("circle", { cx: 75, cy: 75, r: R, fill: "none", "stroke-width": 18, "class": "dbg" }));
    rows.forEach(function (r, i) {
      var len = C * num(r.value) / total;
      var c = svg("circle", { cx: 75, cy: 75, r: R, fill: "none", "stroke-width": 18, "class": "d" + (i % 6 + 1), "stroke-dasharray": len.toFixed(2) + " " + (C - len).toFixed(2), "stroke-dashoffset": (-off).toFixed(2), transform: "rotate(-90 75 75)" });
      c.appendChild(svg("title", { text: r.label + ": " + int(r.value) })); g.appendChild(c); off += len;
    });
    g.appendChild(svg("text", { x: 75, y: 78, "text-anchor": "middle", "class": "ctr", text: centre }));
    g.appendChild(svg("text", { x: 75, y: 94, "text-anchor": "middle", "class": "ctr2", text: sub }));
    var lg = el("div", { cls: "legend" });
    rows.forEach(function (r, i) { lg.appendChild(el("div", { cls: "li" }, [el("i", { cls: "sw s" + (i % 6 + 1) }), el("span", { text: r.label }), el("b", { text: int(r.value) })])); });
    if (!rows.length) lg.appendChild(el("div", { cls: "empty", text: "No paying studios yet." }));
    clear(box).appendChild(g); box.appendChild(lg);
  }
  function funnel(box, steps) {
    clear(box); var top = Math.max(1, num(steps[0] && steps[0].value));
    steps.forEach(function (s) {
      var pct = Math.round(100 * num(s.value) / top);
      var bar = el("div", { cls: "bar" }), fill = el("i"); fill.style.width = Math.max(0, Math.min(100, pct)) + "%"; bar.appendChild(fill);
      box.appendChild(el("div", { cls: "fstep" }, [el("div", { cls: "fl" }, [el("span", { text: s.label }), el("b", { text: int(s.value) + (s.pct != null ? " · " + s.pct : "") })]), bar]));
    });
  }

  /* ---------------- overview ---------------- */
  function kpi(label, value, sub, tone, go) {
    var k = el(go ? "button" : "div", { cls: "kpi" + (tone ? " " + tone : "") }, [el("div", { cls: "l", text: label }), el("div", { cls: "v", text: value }), sub ? el("div", { cls: "s", text: sub }) : null]);
    if (go) { k.setAttribute("type", "button"); k.addEventListener("click", go); }
    return k;
  }
  function goTab(t, after) { return canTab(t) ? function () { showTab(t); if (after) after(); } : null; }
  function goStudios(status) { return canTab("studios") ? function () { showTab("studios"); $("#fStatus").value = status || ""; loadStudios(0).catch(showErr); } : null; }
  function inrOf(list) { var t = 0; (Array.isArray(list) ? list : []).forEach(function (m) { if ((m.currency || "INR") === "INR") t += num(m.amount); }); return t; }
  function failedEmails(m) { return ((m && m.health && m.health.queues) || []).reduce(function (s, q) { return s + num(q.failed_7d); }, 0); }
  function openRequests(m) { var a = (m && m.attention) || {}; return num(a.new_plan_requests) + num(a.new_sales_enquiries) + num(a.new_suggestions); }
  function renderOverview(o, m) {
    o = o || {};
    var s = o.studios || {}, u = o.users || {}, b = o.billing || {}, bs = s.by_status || {};
    var k = clear($("#kpis"));
    if (m && m.studios) {
      var ms = m.studios, conv = m.conversion || {}, mrr = inrOf(b.mrr), nReq = openRequests(m), nFail = failedEmails(m);
      var growth = num(ms.new_30d) - num(ms.new_prev_30d);
      k.appendChild(kpi("Studios", int(ms.total), int(ms.active_30d) + " signed in within 30 days", "", goStudios("")));
      k.appendChild(kpi("Paying studios", int(ms.paying), int(ms.past_due) + " past due · " + int(ms.suspended) + " suspended", "good", goStudios("active")));
      k.appendChild(kpi("On free trial", int(ms.trial), int((m.attention || {}).trials_ending_count) + " end within 7 days", "", goStudios("trial")));
      k.appendChild(kpi("MRR", moneyList(b.mrr), "ARR " + moneyList(b.mrr, 12) + " · from active plans"));
      k.appendChild(kpi("New studios (30 days)", int(ms.new_30d), (growth >= 0 ? "+" : "") + int(growth) + " vs the 30 days before"));
      k.appendChild(kpi("Trial → paid", conv.pct == null ? "—" : num(conv.pct) + "%", int(conv.converted) + " of " + int(conv.trials_ended) + " ended trials paid"));
      k.appendChild(kpi("Open requests", int(nReq), "plan requests, sales, suggestions", nReq > 0 ? "warn" : "", goTab("requests", loadRequestsTab)));
      k.appendChild(kpi("Failed e-mails (7 days)", int(nFail), "see System health", nFail > 0 ? "bad" : ""));
    } else {
      k.appendChild(kpi("Studios", int(s.total), "+" + int(s.new_7d) + " in 7d · +" + int(s.new_30d) + " in 30d"));
      k.appendChild(kpi("MRR", moneyList(b.mrr), "active + past-due plans"));
      k.appendChild(kpi("Paid this month", moneyList(b.paid_this_month), "Helm subscription payments"));
      k.appendChild(kpi("Past due", int(b.past_due_count), int(b.reminders_pending) + " reminders queued", num(b.past_due_count) > 0 ? "warn" : ""));
      k.appendChild(kpi("Suspended", int(b.suspended_count), "read-only studios", num(b.suspended_count) > 0 ? "bad" : ""));
      k.appendChild(kpi("Users", int(u.total), int(u.active_7d) + " active in 7 days"));
      if (o.auth_logins_7d != null) k.appendChild(kpi("Sign-ins", int(o.auth_logins_7d), "last 7 days"));
    }
    renderCharts(o, m);
    renderAttention(o, m);
    renderHealth(m);
    renderTop(m);
    var st = clear($("#byStatus"));
    ["trial", "active", "past_due", "suspended", "cancelled", "none"].forEach(function (key) {
      st.appendChild(el("li", null, [statusPill(key), el("span", { cls: "muted", text: int(bs[key] || 0) + " studios" })]));
    });
    var mf = clear($("#mfa"));
    if (o.mfa) {
      var pct = Math.max(0, Math.min(100, num(o.mfa.pct)));
      mf.appendChild(el("div", null, [el("strong", { text: pct + "%" }), " of users (" + int(o.mfa.users_with_mfa) + " / " + int(o.mfa.users_total) + ")"]));
      var bar = el("div", { cls: "bar" }); var fill = el("i"); fill.style.width = pct + "%"; bar.appendChild(fill); mf.appendChild(bar);
    } else mf.appendChild(el("div", { cls: "empty", text: "Not available on this database." }));
    var nb = $("#navReqCount"), nr = openRequests(m);
    if (nb) { nb.textContent = nr > 99 ? "99+" : String(nr); nb.hidden = !(nr > 0); }
    paintBnav();
  }
  function renderCharts(o, m) {
    var sw = (m && m.signups_weekly) || null;
    if (!sw) {   // database without 0272: daily signups of hq_overview, grouped by week
      var days = Array.isArray(o.signups_30d) ? o.signups_30d : [], wk = {};
      days.forEach(function (d) { var k2 = String(d.day).slice(0, 10), t = new Date(k2 + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); var key = t.toISOString().slice(0, 10); wk[key] = (wk[key] || 0) + num(d.studios); });
      sw = Object.keys(wk).sort().map(function (key) { return { week: key, studios: wk[key] }; });
    }
    var total = sw.reduce(function (a, r) { return a + num(r.studios); }, 0);
    $("#cSignSum").textContent = int(total) + " in " + sw.length + " weeks";
    barChart($("#cSign"), sw.map(function (r) { return { label: weekLabel(r.week), value: r.studios }; }), int, "New studios per week");
    var mm = (m && m.mrr_monthly) || [];
    if (mm.length) {
      var last = mm[mm.length - 1] || {};
      $("#cMrrSum").textContent = "this month " + shortMoney(last.mrr);
      lineChart($("#cMrr"), mm.map(function (r) { return { label: monthLabel(r.month), a: r.mrr, b: r.collected }; }), shortMoney, "MRR and money received per month");
    } else { $("#cMrrSum").textContent = ""; emptyChart($("#cMrr"), "Appears after SQL 0272 is applied"); }
    var mix = (m && m.plan_mix) || null;
    if (mix) { var paying = mix.reduce(function (a, r) { return a + num(r.studios); }, 0);
      donut($("#cMix"), mix.map(function (r) { return { label: r.plan, value: r.studios }; }), int(paying), "studios"); }
    else clear($("#cMix")).appendChild(el("div", { cls: "empty", text: "Appears after SQL 0272 is applied." }));
    var f = (m && m.funnel) || null;
    if (f) {
      var p = function (a, b2) { return num(b2) > 0 ? Math.round(100 * num(a) / num(b2)) + "%" : null; };
      funnel($("#cFun"), [{ label: "Signed up", value: f.signed_up }, { label: "Still on trial", value: f.on_trial, pct: p(f.on_trial, f.signed_up) },
        { label: "Added a teammate", value: f.added_team, pct: p(f.added_team, f.signed_up) }, { label: "Paid Helm", value: f.paid, pct: p(f.paid, f.signed_up) }]);
    } else clear($("#cFun")).appendChild(el("div", { cls: "empty", text: "Appears after SQL 0272 is applied." }));
  }
  // r42: small line icons for "Needs attention" (same 24-grid stroke style as the side menu; no emoji / text glyphs)
  var ATT_ICONS = {
    mail: "M4 6h16v12H4zM4 7l8 6 8-6",
    payment: "M3 7h18v10H3zM3 11h18M7 15h3",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2",
    alert: "M12 3l9.5 17h-19zM12 10v4M12 17.5h.01",
    quiet: "M3 6l6 6 4-4 8 8M21 11v5h-5",
    check: "M5 12.5l4.5 4.5L19 7.5",
    shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"   // r118 (F-12): the Security table's line icon (was an emoji)
  };
  function attIcon(name) {
    var NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    path.setAttribute("d", ATT_ICONS[name] || ATT_ICONS.alert); svg.appendChild(path);
    return svg;
  }
  function attRow(icon, tone, title, sub, go, btnText) {
    var li = el("li", null, [el("span", { cls: "ic " + tone, "aria-hidden": "true" }, [attIcon(icon)]), el("div", { cls: "tx" }, [el("b", { text: title }), el("span", { text: sub })])]);
    if (go) { var b = el("button", { cls: "btn sm", type: "button", text: btnText || "Open" }); b.addEventListener("click", go); li.appendChild(b); }
    return li;
  }
  function renderAttention(o, m) {
    var ul = clear($("#attList")), a = (m && m.attention) || {}, n = 0, add = function (li) { ul.appendChild(li); n++; };
    var open = function (id) { return canTab("studios") ? function () { openStudio(id); } : null; };
    var reqs = [["new_plan_requests", "plan request", "plan requests", "plan"], ["new_sales_enquiries", "sales enquiry", "sales enquiries", "sales"],
      ["new_suggestions", "suggestion", "suggestions", "sugg"]];
    reqs.forEach(function (r) { var c = num(a[r[0]]); if (c > 0) add(attRow("mail", "warn", int(c) + " new " + (c === 1 ? r[1] : r[2]), "waiting for a reply",
      canTab("requests") ? function () { showTab("requests"); reqTab(r[3]); loadRequestsTab(); } : null, "Reply")); });
    (a.past_due || []).forEach(function (x) { add(attRow("payment", "bad", (x.name || "Studio") + " — payment pending", "plan period ended " + date(x.period_end), open(x.org_id), "Open")); });
    (a.trials_ending || []).forEach(function (x) { add(attRow("clock", "warn", (x.name || "Studio") + " — trial ends " + trialDay(x.ends_at), "talk to them before it ends", open(x.org_id), "Open")); });
    var nf = failedEmails(m); if (nf > 0) add(attRow("alert", "bad", int(nf) + " e-mail" + (nf === 1 ? "" : "s") + " failed in 7 days", "see System health", null));
    (a.at_risk || []).forEach(function (x) { add(attRow("quiet", "", (x.name || "Studio") + " — paying, quiet", "no sign-in " + (x.last_sign_in ? "since " + date(x.last_sign_in) : "yet"), open(x.org_id), "Open")); });
    if (!m) { var pd = num((o.billing || {}).past_due_count); if (pd) add(attRow("payment", "bad", int(pd) + " studio" + (pd === 1 ? "" : "s") + " past due", "see Billing", goTab("billing"))); }
    if (!n) ul.appendChild(attRow("check", "ok", "All clear", "nothing needs you right now", null));
    $("#attCount").textContent = n ? int(n) + " item" + (n === 1 ? "" : "s") : "";
  }
  var QUEUE_OK_MIN = 60;   // a waiting e-mail older than this many minutes = the sender is probably not running
  function renderHealth(m) {
    var box = clear($("#health")), st = clear($("#healthState"));
    if (!m || !m.health) { box.appendChild(el("div", { cls: "empty", text: "Appears after SQL 0272 is applied." })); return; }
    var qs = m.health.queues || [], bad = 0;
    qs.forEach(function (q) {
      var oldMin = q.oldest_waiting ? (Date.now() - new Date(q.oldest_waiting).getTime()) / 6e4 : 0;
      var stuck = num(q.waiting) > 0 && oldMin > QUEUE_OK_MIN, failed = num(q.failed_7d) > 0;
      if (stuck || failed) bad++;
      box.appendChild(el("div", { cls: "hrow" }, [el("span", { text: q.label || q.name }), el("span", { cls: "nums" }, [
        el("span", { cls: "pill " + (stuck ? "warn" : ""), text: int(q.waiting) + " waiting" }),
        el("span", { cls: "pill " + (failed ? "bad" : ""), text: int(q.failed_7d) + " failed" }),
        el("span", { cls: "pill ok", text: int(q.sent_24h) + " sent today" })])]));
    });
    var c = m.health.cron || {};
    box.appendChild(el("h3", { cls: "muted", text: "Scheduled jobs" }));
    if (!c.readable) box.appendChild(el("div", { cls: "empty", text: "Job history isn’t readable on this database." }));
    else {
      var jobs = c.jobs || [], failedJobs = jobs.filter(function (j) { return num(j.failed_24h) > 0 || j.last_status === "failed"; });
      if (failedJobs.length) bad++;
      var lastRun = jobs.reduce(function (a, j) { return j.last_run && (!a || j.last_run > a) ? j.last_run : a; }, null);
      box.appendChild(el("div", { cls: "hrow" }, [el("span", { text: int(jobs.length) + " jobs · last run " + (lastRun ? ago2(lastRun) : "never") }),
        el("span", { cls: "pill " + (failedJobs.length ? "bad" : "ok"), text: failedJobs.length ? int(failedJobs.length) + " failing" : "all OK" })]));
      failedJobs.slice(0, 5).forEach(function (j) { box.appendChild(el("div", { cls: "hrow" }, [el("span", { cls: "m", text: j.name }), el("span", { cls: "pill bad", text: int(j.failed_24h) + " failed in 24 h" })])); });
    }
    st.appendChild(el("span", { cls: "pill " + (bad ? "warn" : "ok"), text: bad ? "Check" : "All good" }));
  }
  function ago2(v) { var mins = (Date.now() - new Date(v).getTime()) / 6e4; if (!isFinite(mins)) return "—"; if (mins < 1) return "just now"; if (mins < 60) return Math.round(mins) + " min ago"; if (mins < 1440) return Math.round(mins / 60) + " h ago"; return ago(v); }
  function renderTop(m) {
    var tb = clear($("#tTop")), rows = (m && m.top_usage) || [];
    rows.forEach(function (r) {
      var tr = el("tr", { cls: "click", tabindex: "0" }, [el("td", null, [el("strong", { text: r.name || "—" })]),
        el("td", null, [statusPill(r.status), r.plan ? " " + r.plan : ""]), el("td", { cls: "n", text: int(r.active_30d) }),
        el("td", { cls: "n", text: int(r.people) }), el("td", { text: ago(r.last_sign_in) })]);
      var go = function () { openStudio(r.org_id); };
      if (canTab("studios")) tr.addEventListener("click", go); tr.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
      tb.appendChild(tr);
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: m ? "No sign-ins in the last 30 days." : "Appears after SQL 0272 is applied." })]));
  }

  /* ---------------- studios ---------------- */
  function pager(node, off, total, go) {
    clear(node);
    var from = total ? off + 1 : 0, to = Math.min(off + PAGE, total);
    node.appendChild(el("span", { text: from + "–" + to + " of " + total }));
    var prev = el("button", { cls: "btn", type: "button", text: "‹ Prev" }); prev.disabled = off <= 0;
    var next = el("button", { cls: "btn", type: "button", text: "Next ›" }); next.disabled = off + PAGE >= total;
    prev.addEventListener("click", function () { go(Math.max(0, off - PAGE)); });
    next.addEventListener("click", function () { go(off + PAGE); });
    node.appendChild(prev); node.appendChild(next);
  }
  async function loadStudios(off) {
    sOff = off || 0;
    var rows = await call("hq_studios", { p_search: $("#qStudios").value || null, p_status: $("#fStatus").value || null, p_limit: PAGE, p_offset: sOff });
    var tb = clear($("#tStudios")); rows = Array.isArray(rows) ? rows : [];
    rows.forEach(function (r) {
      var tr = el("tr", { cls: "click", tabindex: "0" }, [
        el("td", null, [el("strong", { text: r.name || "—" }), r.slug ? el("div", { cls: "muted", text: "helm.events/" + r.slug }) : null]),
        el("td", null, [r.primary_contact_name || (r.owner_email ? masked(r.owner_email, "email", "studio", r.org_id, "owner_email") : null) || "—",
          contactLine(r.primary_contact_email, r.primary_contact_phone, "studio", r.org_id)]),
        el("td", { text: [r.state, r.country].filter(Boolean).join(", ") || "—" }),
        el("td", null, [r.plan_name || "No plan", el("div", { cls: "muted", text: "billed in " + billCur(r) })]), el("td", null, [statusPill(r.status)]),
        el("td", { text: date(r.created_at) }), el("td", { cls: "n", text: int(r.users_count) }),
        el("td", { cls: "n", text: num(r.total_paid) > 0 ? money(r.total_paid, r.paid_currency || "INR") : "—", title: moneyRaw(r.total_paid, r.paid_currency || "INR") }), el("td", { text: ago(r.last_activity) })]);
      var open = function () { openStudio(r.org_id); };
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
      tb.appendChild(tr);
    });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "9", cls: "empty", text: "No studios match." })]));
    pager($("#pStudios"), sOff, rows.length ? num(rows[0].total_count) : 0, function (o) { loadStudios(o).catch(showErr); });
  }
  function billCur(r) { var c = String((r && (r.billing_currency || (r.account && r.account.billing_currency))) || "").toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : (r && r.country && r.country !== "IN" ? "USD" : "INR"); }
  function daysSince(v) { var t = Date.parse(v || ""); return isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 864e5)) : null; }
  function field(label, input) { return el("label", { cls: "fld" }, [el("span", { text: label }), input]); }
  function paymentRows(tbody, list, withStudio, invoiceFn) {
    clear(tbody);
    (list || []).forEach(function (p) {
      var inv = el("button", { cls: "btn sm", type: "button", text: "Invoice" });
      inv.addEventListener("click", function () { openInvoice(invoiceFn || "hq_invoice", p.id); });
      var acts = el("td", null, [inv]);
      if (!p.voided && can("billing.write")) {
        var v = el("button", { cls: "btn sm danger", type: "button", text: "Void" });
        v.addEventListener("click", function () {
          var why = ask("Void payment " + (p.invoice_no || "") + " of " + moneyBoth(p.amount, p.currency) + "? The row and invoice number are kept. Reason:");
          if (!why) return;
          call("hq_void_payment", { p_id: p.id, p_reason: why }).then(function () { okMsg("Payment voided."); refreshAfterWrite(p.org_id); }).catch(showErr);
        });
        acts.appendChild(v);
      }
      tbody.appendChild(el("tr", { cls: p.voided ? "void" : "" }, [
        el("td", { text: date(p.paid_on) }), withStudio ? el("td", { text: p.studio || "—" }) : null,
        el("td", { cls: "m", text: p.invoice_no || "—" }), el("td", { text: p.method || "—" }),
        el("td", { text: (p.period_start ? date(p.period_start) + " – " + date(p.period_end) : "—") }),
        el("td", { cls: "n", text: money(p.amount, p.currency), title: moneyRaw(p.amount, p.currency) }),
        el("td", null, [p.voided ? el("span", { cls: "pill bad", text: "void" }) : el("span", { cls: "pill ok", text: "paid" })]), acts]));
    });
    if (!tbody.firstChild) tbody.appendChild(el("tr", null, [el("td", { colspan: withStudio ? "8" : "7", cls: "empty", text: "No payments." })]));
  }
  var openOrg = null;
  function refreshAfterWrite(org) {
    if (org && openOrg === org) loadDetail(org, curDTab).catch(showErr);
    loadStudios(sOff).catch(showErr); loadBilling().catch(showErr); loadOverview().catch(showErr);
  }

  /* ---------------- r25: studio drawer (Overview · Plan & billing · People · Name & link · Activity) ---------------- */
  var DTABS = ["overview", "plan", "people", "ident", "activity"], curDTab = "overview", lastFocus = null;
  function dTab(name) {
    curDTab = DTABS.indexOf(name) >= 0 ? name : "overview";
    DTABS.forEach(function (t) {
      var b = $("#dt-" + t), p = $("#dp-" + t);
      if (b) b.setAttribute("aria-selected", t === curDTab ? "true" : "false");
      if (p) p.hidden = t !== curDTab;
    });
    var body = $("#studioDetail"); if (body) body.scrollTop = 0;
  }
  function openDrawer() {
    var dr = $("#studioDrawer"); if (!dr.hidden) return;
    lastFocus = document.activeElement; dr.hidden = false; $("#studioScrim").hidden = false;
    try { $("#btnDClose").focus(); } catch (e) {}
  }
  function closeDrawer() {
    $("#studioDrawer").hidden = true; $("#studioScrim").hidden = true; openOrg = null;
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
  }
  function openStudio(org, tab) { if (!org || !canTab("studios")) return; loadDetail(org, tab || "overview").catch(showErr); }
  // r118 (F-11): "Trial ends" on the drawer Overview = the same studio-zone day as the Plan tab (trialDay; hq_trial_info
  // then repaints both with the studio's own time zone)
  function trialFact(sub) {
    var f = fact(sub.status === "trial" ? "Trial ends" : "Period ends", sub.status === "trial" ? trialDay(sub.trial_ends_at, null) : date(sub.current_period_end));
    if (sub.status === "trial") { var v = f.querySelector ? f.querySelector(".v") : null; if (v) v.id = "ovTrialEnd"; }
    return f;
  }
  function fact(label, value) { return el("div", { cls: "fact" }, [el("div", { cls: "l", text: label }), el("div", { cls: "v", text: value })]); }
  function kvList(pairs) {
    var dl = el("dl", { cls: "kv" });
    pairs.filter(function (p) { return p[1] != null && (typeof p[1] === "object" || String(p[1]).trim() !== ""); }).forEach(function (p) {
      dl.appendChild(el("dt", { text: p[0] })); dl.appendChild(typeof p[1] === "object" ? el("dd", null, [p[1]]) : el("dd", { text: String(p[1]) })); });
    if (!dl.firstChild) dl.appendChild(el("dd", { cls: "muted", text: "Not filled in yet." }));
    return dl;
  }
  async function loadDetail(org, tab) {
    var d = await call("hq_studio_detail", { p_org: org }); var box = clear($("#studioDetail"));
    if (!d) return; openOrg = org;
    var sub = d.subscription || {}, acc = d.account || {};
    $("#dName").textContent = d.name || "Studio";
    $("#dMeta").textContent = [d.slug ? "helm.events/" + d.slug : "", "joined " + date(d.created_at), int(d.users_count) + " people"].filter(Boolean).join(" · ");
    clear($("#dStatus")).appendChild(statusPill(sub.status || d.status));
    var panes = {};
    DTABS.forEach(function (t) { panes[t] = el("div", { cls: "dpane", id: "dp-" + t, role: "tabpanel", "aria-labelledby": "dt-" + t }); box.appendChild(panes[t]); });
    var lastIn = (d.members || []).reduce(function (a, m) { return m.last_sign_in_at && (!a || m.last_sign_in_at > a) ? m.last_sign_in_at : a; }, null);

    // ---- Overview: the key facts, contacts, the big buttons, business details
    var wrap = panes.overview;
    var since = daysSince(d.created_at);
    wrap.appendChild(el("div", { cls: "facts" }, [
      fact("Plan", (sub.plan_name || "No plan") + " · billed in " + billCur({ billing_currency: acc.billing_currency || d.billing_currency, country: acc.country })),
      trialFact(sub),
      fact("Paid to Helm", money(d.total_paid, d.paid_currency || "INR")),
      fact("Team size", int(d.users_count) + " user" + (num(d.users_count) === 1 ? "" : "s")), fact("Last active", ago(d.last_active_at || lastIn)),
      fact("Created", date(d.created_at))]));
    // r28 (owner): use of Helm - numbers only (hq_studio_usage), filled when it answers
    var useBox = el("div", { cls: "facts" }, [fact("Using Helm", since == null ? "—" : int(since) + " day" + (since === 1 ? "" : "s"))]);
    wrap.appendChild(useBox);

    var bName = el("button", { cls: "btn primary", type: "button", text: "Change studio name & link" });
    bName.addEventListener("click", function () { dTab("ident"); });
    var bPlan = el("button", { cls: "btn", type: "button", text: sub.status === "active" ? "Plan & payments" : "Activate plan" });
    bPlan.addEventListener("click", function () { dTab("plan"); });
    var bPeople = el("button", { cls: "btn", type: "button", text: "People & 2-step" });
    bPeople.addEventListener("click", function () { dTab("people"); });
    wrap.appendChild(el("div", { cls: "card" }, [el("h2", { text: "Quick actions" }), el("div", { cls: "bigact" }, [can("studios.edit") ? bName : null, bPlan, bPeople])]));
    wrap.appendChild(el("div", { cls: "card" }, [el("h2", { text: "Contact" }), kvList([
      ["Primary contact", acc.primary_contact_name], ["E-mail", masked(acc.primary_contact_email || d.owner_email, "email", "studio", org, "email")],
      ["Phone", masked(acc.primary_contact_phone, "phone", "studio", org, "phone")],
      ["Billing e-mail", masked(acc.billing_contact_email, "email", "studio", org, "billing_email")], ["Place", [acc.city, acc.state, acc.country].filter(Boolean).join(", ")],
      ["Legal name", acc.legal_business_name], ["GSTIN", masked(acc.gstin, "id", "studio", org, "gstin")], ["PAN", masked(acc.pan, "id", "studio", org, "pan")],
      ["Website", acc.website]]), el("p", { cls: "muted", text: "Masked details: press Show to see one. Each Show is recorded in Security & activity." })]));

    // account profile (business account data only)
    var more = el("details", { cls: "more" }, [el("summary", { text: "Edit business details (shows every detail - recorded)" })]);
    var AF = [["legal_business_name", "Legal name"], ["gstin", "GSTIN"], ["country", "Country (ISO-2)"], ["state", "State"], ["city", "City"],
      ["billing_address", "Billing address"], ["website", "Website"], ["timezone", "Timezone"], ["primary_contact_name", "Primary contact"],
      ["primary_contact_email", "Primary e-mail"], ["primary_contact_phone", "Primary phone"], ["secondary_contact_name", "Secondary contact"],
      ["secondary_contact_email", "Secondary e-mail"], ["secondary_contact_phone", "Secondary phone"], ["billing_contact_email", "Billing e-mail"],
      ["team_size_band", "Team size (1, 2-5, 6-15, 16-50, 51+)"], ["signup_source", "Signup source"],
      ["business_type", "Business type"], ["is_business", "Business (true/false)"], ["tax_id_type", "Tax ID type"], ["tax_id", "Tax ID"], ["pan", "PAN (India)"],
      ["billing_currency", "Billing currency"], ["payment_mandate_ref", "Mandate reference"], ["referral_code", "Referral code"], ["referred_by", "Referred by"]];
    var inputs = {}, real = acc;   // r57: `real` = the unmasked account from hq_reveal('business_details') once the form opens
    var af = el("div", { cls: "form" });
    AF.forEach(function (f) { var i = el("input", { type: /_phone$/.test(f[0]) ? "tel" : (/_email$/.test(f[0]) ? "email" : "text") }); inputs[f[0]] = i; af.appendChild(field(f[1], i)); });
    var fillForm = function () { AF.forEach(function (f) { inputs[f[0]].value = real[f[0]] == null ? "" : String(real[f[0]]); }); };
    var asave = el("button", { cls: "btn primary", type: "button", text: "Save business details" });
    asave.addEventListener("click", function () {
      if (Object.keys(real).some(function (k) { return isMasked(real[k]); })) { showErr(new Error("Open the form again to load the details.")); return; }
      var patch = {}; AF.forEach(function (f) { var v = String(inputs[f[0]].value || "").trim(); if (v !== (real[f[0]] == null ? "" : String(real[f[0]]))) patch[f[0]] = v; });
      call("hq_set_studio_account", { p_org: org, p_account: patch }).then(function () { okMsg("Business details saved."); refreshAfterWrite(org); }).catch(showErr);
    });
    af.appendChild(asave);
    // r28: the form shows every value unmasked, so it fills only after the reveal is logged
    // r57 (0298): the real values come from hq_reveal('studio', org, 'business_details') - logged in the same step
    var filled = false;
    more.addEventListener("toggle", function () {
      if (!more.open || filled) return;
      call("hq_reveal", { p_entity: "studio", p_entity_id: String(org), p_field: "business_details" }).then(function (r) {
        real = (r && r.account && typeof r.account === "object") ? r.account : {};
      }, function (e) {
        if (S && S.errKind(e)) throw e;
        if (/hq_reveal|PGRST202|does not exist|schema cache|not find the function/i.test(String((e && e.message) || ""))) {
          return logReveal("studio", org, "business_details").then(function () { real = acc; });   // older database: acc is unmasked
        }
        throw e;
      }).then(function () { fillForm(); filled = true; more.appendChild(af); })
        .catch(function (e) { more.open = false; showErr(e); });
    });
    if (can("studios.edit")) wrap.appendChild(more);

    // ---- Plan & billing: subscription, suspend, activate, free trial, payments
    wrap = panes.plan;
    var subCard = el("div", { cls: "card" }); wrap.appendChild(subCard);
    subCard.appendChild(el("h2", { text: "Subscription" }));
    subCard.appendChild(el("div", null, [statusPill(sub.status || d.status), " ", (sub.plan_name || "No plan"),
      sub.price_monthly != null ? " · " + money(sub.price_monthly, sub.currency) + "/month" : "",
      sub.current_period_end ? " · period ends " + date(sub.current_period_end) : "",
      // L9: replaced by the studio-zone day once hq_trial_info answers (loadTrialInfo)
      sub.trial_ends_at ? el("span", { id: "subTrialEnd", text: " · trial ends " + trialDay(sub.trial_ends_at, null) }) : ""]));
    if (sub.status === "suspended") subCard.appendChild(el("div", { cls: "muted", text: "Suspended " + date(sub.suspended_at) + " — " + (sub.suspend_reason || "") }));
    var selPlan = el("select", { "aria-label": "Plan" }); selPlan.appendChild(el("option", { value: "", text: "(keep plan)" }));
    plans.filter(function (p) { return p.active; }).forEach(function (p) { selPlan.appendChild(el("option", { value: p.code, text: p.name + " · " + moneyBoth(p.price_monthly, p.currency) })); });
    var selSt = el("select", { "aria-label": "Status" });
    [["", "(keep status)"], ["trial", "trial"], ["active", "active"], ["past_due", "past due"], ["cancelled", "cancelled"]].forEach(function (o) { selSt.appendChild(el("option", { value: o[0], text: o[1] })); });
    var ps = el("input", { type: "date" }), pe = el("input", { type: "date" }), te = el("input", { type: "date" });
    var save = el("button", { cls: "btn", type: "button", text: "Save subscription" });
    save.addEventListener("click", function () {
      var what = subscriptionChangeText({ plan: selPlan.value ? selPlan.options[selPlan.selectedIndex].text : "", status: selSt.value, periodStart: ps.value, periodEnd: pe.value, trialEnds: te.value });
      if (!what) { showErr(new Error("Nothing to change - pick a plan, a status or a date first.")); return; }
      if (!window.confirm("Change the subscription of " + (d.name || "this studio") + " by hand?\n\n" + what + "\n\nThe studio sees this at once. It is recorded in the HQ log.")) return;   // r118 (F-06)
      save.disabled = true;
      call("hq_set_subscription", { p_org: org, p_plan_code: selPlan.value || null, p_status: selSt.value || null, p_trial_ends_at: te.value || null,
        p_period_start: ps.value || null, p_period_end: pe.value || null, p_notes: null })
        .then(function () { okMsg("Subscription saved."); refreshAfterWrite(org); }).catch(showErr).then(function () { save.disabled = false; });
    });
    var adv = el("details", { cls: "more" }, [el("summary", { text: "Change plan or status by hand" }),
      el("div", { cls: "form" }, [field("Plan", selPlan), field("Status", selSt), field("Period start", ps), field("Period end", pe), field("Trial ends", te), save])]);
    if (can("billing.write")) subCard.appendChild(adv);
    var sus = el("button", { cls: "btn " + (sub.status === "suspended" ? "primary" : "danger"), type: "button", text: sub.status === "suspended" ? "Reactivate studio" : "Suspend (read-only)…" });
    sus.addEventListener("click", function () {
      if (sub.status === "suspended") {
        if (!window.confirm("Reactivate " + (d.name || "this studio") + "? Members can create and change data again.")) return;
        call("hq_reactivate_studio", { p_org: org }).then(function () { okMsg("Studio reactivated."); refreshAfterWrite(org); }).catch(showErr);
      } else {
        var why = ask("Suspend " + (d.name || "this studio") + "? Members can still sign in, view and export, but cannot create, change or delete anything. No data is touched. Reason:");
        if (!why) return;
        call("hq_suspend_studio", { p_org: org, p_reason: why }).then(function () { okMsg("Studio suspended (read-only)."); refreshAfterWrite(org); }).catch(showErr);
      }
    });
    if (can("studios.suspend")) subCard.appendChild(el("div", { cls: "actions" }, [sus]));

    // r21 (0244): ONE step from trial (or ended trial) to a paying studio
    if (sub.status !== "suspended" && can("billing.write")) wrap.appendChild(activateBox(org, d.name, sub));

    // 0186: free trial — one extension per studio (1–7 days, reason required)
    var trialCard = el("div", { cls: "card" }, [el("h2", { text: "Free trial" })]); wrap.appendChild(trialCard);
    var trialBox = el("div", { id: "trialExt" }); trialCard.appendChild(trialBox);
    loadTrialInfo(org, d.name, trialBox).catch(function () {
      clear(trialBox).appendChild(el("div", { cls: "muted", text: "Trial details appear after migration 0186 is applied." }));
    });

    // r28 (owner): referral info + credits (e.g. referral free months) - records kept by Helm HQ only
    var rf = d.referral || {};
    wrap.appendChild(el("div", { cls: "card" }, [el("h2", { text: "Referrals" }), kvList([["Their referral code", rf.code || acc.referral_code],
      ["Referred by", rf.referred_by || acc.referred_by], ["Studios they referred", rf.referred_count != null ? int(rf.referred_count) : null],
      ["Credits earned", rf.credits != null ? money(rf.credits, rf.credits_currency || "INR") : null]])]));
    var credBox = el("div", { cls: "card" }, [el("h2", { text: "Credits & free months" })]); wrap.appendChild(credBox);
    loadCredits(org, d.name, credBox).catch(function () { credBox.appendChild(el("p", { cls: "muted", text: "Credits appear after SQL 0280 is applied." })); });

    // payments
    var payCard = el("div", { cls: "card" }, [el("h2", { text: "Payments to Helm" })]); wrap.appendChild(payCard);
    var pt = el("tbody"); paymentRows(pt, d.payments, false);
    payCard.appendChild(el("div", { cls: "scroll" }, [el("table", { cls: "rt" }, [el("thead", null, [el("tr", null, ["Paid on", "Invoice", "Method", "Period", "Amount", "Status", ""].map(function (h) { return el("th", { text: h }); }))]), pt])]));
    var rec = el("button", { cls: "btn", type: "button", text: "Record a payment for this studio" });
    rec.addEventListener("click", function () { closeDrawer(); showTab("billing"); $("#rOrg").value = org; $("#rOrgName").textContent = d.name || ""; });
    if (can("billing.write")) payCard.appendChild(el("div", { cls: "actions" }, [rec]));

    // ---- People (no phone, no client data)
    wrap = panes.people;
    var mt = el("tbody");
    (d.members || []).forEach(function (m) {
      mt.appendChild(el("tr", null, [el("td", { text: m.display_name || "—" }), el("td", null, [masked(m.email, "email", "member", m.user_id || org, m.user_id ? "email" : "member_email") || "—"]), el("td", { text: m.role || "—" }),
        el("td", null, [el("span", { cls: "pill " + (m.active ? "ok" : "bad"), text: m.active ? "active" : "inactive" })]),
        el("td", { text: ago(m.last_sign_in_at) }), el("td", null, mfaCell(m.email, m.mfa_enabled, function () { refreshAfterWrite(org); }, m.user_id ? ["member", m.user_id] : null))]));
    });
    if (!mt.firstChild) mt.appendChild(el("tr", null, [el("td", { colspan: "6", cls: "empty", text: "Nobody yet." })]));
    wrap.appendChild(el("div", { cls: "facts" }, [fact("Team size", int(d.users_count) + " user" + (num(d.users_count) === 1 ? "" : "s")),
      fact("With two-step", int((d.members || []).filter(function (m) { return m.mfa_enabled; }).length) + " of " + int((d.members || []).length)),
      fact("Last sign-in", ago(lastIn))]));
    wrap.appendChild(el("div", { cls: "card" }, [el("h2", { text: "People" }),
      el("p", { cls: "hint", text: "E-mails are masked - Show is recorded. Reset two-step only after you have confirmed who is asking (lost phone)." }),
      el("div", { cls: "scroll" }, [el("table", { cls: "rt" }, [el("thead", null, [el("tr", null, ["Name", "E-mail", "Role", "Status", "Last sign-in", "2-step"].map(function (h) { return el("th", { text: h }); }))]), mt])])]));

    // r42: adding / deactivating a studio's logins from HQ is COMING SOON - it waits for PR #271 (r33 team safety:
    // Deactivate, never delete) and will be HQ Owner / Admin only, two-step + a fresh code, a written reason, logged.
    wrap.appendChild(el("div", { cls: "card", id: "studioLoginsSoon" }, [el("h2", null, [document.createTextNode("Add or deactivate a studio login "), el("span", { cls: "pill", text: "Coming soon" })]),
      el("p", { cls: "muted", text: "Studio admins add and deactivate their own people in Settings → Team. Doing it from Helm HQ is coming soon: it will be for HQ Owners and Admins only, with two-step, a written reason and a log entry, and it deactivates (never deletes). Until then, ask a studio admin - or reset two-step above for a lost phone." })]));

    // r33 (0283): the studio owner, its history, and "Recover studio owner" (owner gone: HQ Owner role, two-step, reason)
    var ownBox = el("div"); wrap.appendChild(ownBox);
    loadOwner(org, ownBox, d.name).catch(function () { clear(ownBox).appendChild(el("div", { cls: "card" }, [el("h2", { text: "Studio owner" }),
      el("div", { cls: "muted", text: "The studio owner appears after SQL 0283 is applied." })])); });

    // ---- Name & link: r23 (0257) studio name + link are fixed for the studio; only Helm HQ changes them (two-step,
    // reason, audited, studio admins told by bell + e-mail, the old link keeps working)
    wrap = panes.ident;
    if (can("studios.edit")) wrap.appendChild(identityBox(org, d));
    else wrap.appendChild(el("div", { cls: "card" }, [el("h2", { text: "Studio name & link" }), kvList([["Name", d.name], ["Link", d.slug ? "helm.events/" + d.slug : ""]]),
      el("p", { cls: "muted", text: "Only HQ people who may edit studios can change these." })]));

    // ---- Activity: numbers only + what HQ changed on this studio
    wrap = panes.activity;
    var actBox = el("div"); wrap.appendChild(actBox);
    loadUsage(org, actBox, d, useBox).catch(function () { clear(actBox).appendChild(el("div", { cls: "card" }, [el("div", { cls: "empty", text: "Activity appears after SQL 0272 is applied." })])); });

    dTab(tab || curDTab || "overview");
    openDrawer();
  }
  /* ---------------- r28 round 2 (0280): studio credits (referral free months etc.) - records only ---------------- */
  var CREDIT_KIND = { referral: "Referral free month", goodwill: "Goodwill", promo: "Promotion" };
  async function loadCredits(org, name, box) {
    var r = await call("hq_studio_credits", { p_org: org }); r = r && !Array.isArray(r) ? r : {};
    while (box.childNodes.length > 1) box.removeChild(box.lastChild);
    var list = Array.isArray(r.credits) ? r.credits : [];
    box.appendChild(el("p", { cls: "hint", text: int(r.months_total) + " free month" + (num(r.months_total) === 1 ? "" : "s") + " on record. A credit is a record for HQ: apply it when you activate or renew the plan (it never changes an invoice by itself)." }));
    var ul = el("ul", { cls: "list" });
    list.forEach(function (c) { ul.appendChild(el("li", null, [el("span", null, [el("b", { text: (CREDIT_KIND[c.kind] || c.kind) + " · " + int(c.months) + " month" + (num(c.months) === 1 ? "" : "s") }),
      el("div", { cls: "muted", text: c.reason || "" })]), el("span", { cls: "muted", text: date(c.granted_at) + (c.granted_by ? " · " + c.granted_by : "") + (c.voided_at ? " · voided" : "") })])); });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "No credits yet." }));
    box.appendChild(ul);
    if (!can("billing.write")) return;
    var kind = el("select", { "aria-label": "Kind of credit" }); Object.keys(CREDIT_KIND).forEach(function (k) { kind.appendChild(el("option", { value: k, text: CREDIT_KIND[k] })); });
    var months = el("select", { "aria-label": "Months" }); for (var i = 1; i <= 12; i++) months.appendChild(el("option", { value: String(i), text: i + " month" + (i === 1 ? "" : "s") }));
    var why = el("input", { type: "text", maxlength: "500", placeholder: "e.g. referred Mehndi & Co. (paid 14 Oct)", "aria-label": "Reason" });
    var go = el("button", { cls: "btn primary", type: "button", text: "Add credit…" });
    go.addEventListener("click", function () {
      var rs = String(why.value || "").trim();
      if (rs.length < 5) { showErr(new Error("Write the reason (at least 5 characters).")); return; }
      if (!window.confirm("Add " + months.value + " free month(s) (" + CREDIT_KIND[kind.value] + ") to " + (name || "this studio") + "? It is recorded in the HQ log and can't be deleted (only voided).")) return;
      go.disabled = true;
      call("hq_grant_studio_credit", { p_org: org, p_kind: kind.value, p_months: Number(months.value), p_reason: rs })
        .then(function () { okMsg("Credit added."); loadCredits(org, name, box).catch(showErr); }).catch(showErr).then(function () { go.disabled = false; });
    });
    box.appendChild(el("div", { cls: "form" }, [field("Kind", kind), field("Months", months), el("label", { cls: "fld wide" }, [el("span", { text: "Reason (required)" }), why]), go]));
  }
  /* ---------------- r33 (0283) studio owner + "Recover studio owner" (Helm HQ only, never self-serve) ---------------- */
  var OWNER_SOURCE = { backfill_creator: "Recorded: studio creator", backfill_admin: "Recorded: earliest admin (creator missing)", backfill_none: "No admin found",
    auto: "First admin of the studio", transfer: "Handed over by the previous owner", hq_recovery: "Recovered by Helm HQ" };
  // r118 (0326, F-01): one owner-card e-mail, masked with "Show". With a person id: hq_reveal('member', id, 'email')
  // (role check + hq.reveal row + the value in one step). An older database (before 0326) sends the address in clear
  // and no id: it is masked here and Show writes hq_log_reveal first, then shows it.
  function ownerMail(v, uid, org) {
    var s = String(v == null ? "" : v).trim(); if (!s) return null;
    if (uid) return masked(s, "email", "member", uid, "email");
    if (isMasked(s)) return el("span", { cls: "mv hid", text: s });
    var t = el("span", { cls: "mv hid", text: maskEmail(s), title: "Masked - press Show to see it (recorded)" });
    var b = el("button", { cls: "rv", type: "button", text: "Show", "aria-label": "Show owner e-mail (recorded in the HQ log)" });
    b.addEventListener("click", function (e) {
      if (e) e.stopPropagation(); b.disabled = true;
      logReveal("studio", org, "owner_email").then(function () { t.textContent = s; t.classList.remove("hid"); t.removeAttribute("title"); b.remove(); })
        .catch(function (er) { b.disabled = false; showErr(er); });
    });
    return el("span", { cls: "mask" }, [t, b]);
  }
  // the real address of the admin chosen in "Recover studio owner" (hq_reveal - logged; an older database: logged, then the clear value)
  function ownerRealEmail(a, org) {
    var v = String((a && a.email) || "").trim();
    if (a && a.user_id && isMasked(v)) return revealValue("member", a.user_id, "email", v).then(function (r) { return r && r.value ? String(r.value) : ""; });
    return logReveal(a && a.user_id ? "member" : "studio", a && a.user_id ? a.user_id : org, "email").then(function () { return isMasked(v) ? "" : v; });
  }
  async function loadOwner(org, box, studio) {
    var r = await call("hq_studio_owner_info", { p_org: org }); r = r && !Array.isArray(r) ? r : {};
    clear(box);
    var card = el("div", { cls: "card" }, [el("h2", { text: "Studio owner" })]); box.appendChild(card);
    var o = r.owner || null;
    // r118 (0326, F-01): every e-mail on this card arrives masked; Show = hq_reveal('member', user id) - logged
    card.appendChild(kvList([["Owner", o ? el("span", null, [(o.name || "-") + " (", ownerMail(o.email, o.user_id, org) || "-", ")"]) : "Nobody recorded"],
      ["Status", r.owner_missing ? "Needs attention: the owner is not an active admin" : "Active admin"]]));
    var ul = el("ul", { cls: "list" });
    (r.history || []).forEach(function (h) {
      var om = ownerMail(h.owner_email, h.owner_user_id, org), bm = ownerMail(h.by_email, h.by_user_id, org);
      ul.appendChild(el("li", null, [el("span", { cls: "m", text: (OWNER_SOURCE[h.source] || h.source || "") + (h.hq_flag ? " - check this" : "") }),
        el("span", { cls: "muted" }, [ist(h.at), om ? " · " : null, om, bm ? " · by " : null, bm, h.reason ? " · " + h.reason : null])]));
    });
    if (ul.firstChild) card.appendChild(ul);
    var admins = (r.admins || []).filter(function (a) { return a && a.active && (!o || a.user_id !== o.user_id); });
    if (!can("owner.only")) { card.appendChild(el("p", { cls: "muted", text: "Only the Helm HQ owner can recover a studio's owner." })); return; }
    var det = el("details", { cls: "more" }, [el("summary", { text: "Recover studio owner (the owner has left or lost access)" })]);
    det.appendChild(el("p", { cls: "hint", text: "Only when the studio's owner can't act any more (left, died or lost access) and you have checked who is asking: a call back on the registered number, proof of the business. Never on a call or e-mail alone. Every admin of the studio is told by e-mail and in the bell." }));
    if (!admins.length) { det.appendChild(el("p", { cls: "muted", text: "This studio has no other active admin. The studio must make someone an admin first." })); card.appendChild(det); return; }
    var sel = el("select", { "aria-label": "New owner" });
    // r118 (F-01): the option shows the masked address; the real one is asked from hq_reveal (logged) only on "Make owner"
    admins.forEach(function (a, i) { var mk = isMasked(a.email) ? a.email : maskEmail(a.email);
      sel.appendChild(el("option", { value: String(i), text: (a.name || mk) + " (" + mk + ")" + (a.two_step ? "" : " - no two-step") })); });
    var why = el("textarea", { maxlength: "1000", rows: "3", "aria-label": "Reason", placeholder: "Why, and how you checked who is asking (20+ characters)" });
    var go = el("button", { cls: "btn danger", type: "button", text: "Make this admin the owner" });
    go.addEventListener("click", function () {
      var reason = String(why.value || "").trim();
      if (reason.length < 20) { showErr({ message: "Write at least 20 characters: why, and how you checked who is asking." }); why.focus(); return; }
      var pick = admins[Number(sel.value)]; if (!pick) return;
      go.disabled = true;
      ownerRealEmail(pick, org).then(function (email) {
        if (!email) throw new Error("Couldn't read that admin's e-mail. Try again.");
        if (!window.confirm("Make " + (pick.name ? pick.name + " (" + email + ")" : email) + " the owner of " + (studio || "this studio") + "? Every admin of the studio is told.")) return null;
        return call("hq_studio_owner_recover", { p_org: org, p_email: email, p_reason: reason })
          .then(function () { okMsg("Studio owner changed. The studio's admins were told."); return loadOwner(org, box, studio); });
      }).catch(showErr).then(function () { go.disabled = false; });
    });
    det.appendChild(el("div", { cls: "form" }, [field("New owner (an active admin)", sel), field("Reason", why), go]));
    card.appendChild(det);
  }
  var ACTION_WORDS = { "hq.studio.suspend": "Suspended", "hq.studio.reactivate": "Reactivated", "hq.studio.identity": "Name / link changed",
    "hq.subscription.set": "Subscription changed", "hq.subscription.activate": "Plan activated", "hq.payment.record": "Payment recorded",
    "hq.payment.void": "Payment voided", "hq.trial.extend": "Trial extended", "hq.studio_account.set": "Business details saved", "hq.mfa.reset": "Two-step reset",
    "hq.reveal": "A masked detail was shown", "hq.credit.grant": "Credit added", "hq.studio.owner_recover": "Studio owner recovered" };
  async function loadUsage(org, box, d, useBox) {
    var u = await call("hq_studio_usage", { p_org: org }); u = u && !Array.isArray(u) ? u : {};
    if (useBox) {
      var since = daysSince(d && d.created_at);
      clear(useBox);
      [fact("Using Helm", since == null ? "—" : int(since) + " day" + (since === 1 ? "" : "s")),
        fact("Active days (last 30)", u.active_days_30d != null ? int(u.active_days_30d) + " of 30" : "—"),
        fact("Sign-ins (last 30 days)", u.sign_ins_30d != null ? int(u.sign_ins_30d) : int(u.people_active_30d) + " people")].forEach(function (f) { useBox.appendChild(f); });
    }
    clear(box);
    box.appendChild(el("div", { cls: "facts" }, [fact("People", int(u.people)), fact("Signed in (7 days)", int(u.people_active_7d)),
      fact("Signed in (30 days)", int(u.people_active_30d)), fact("Last sign-in", ago(u.last_sign_in)),
      fact("Payments to Helm", int(u.payments_to_helm)), fact("Last payment", date(u.last_payment_on))]));
    var ul = el("ul", { cls: "list" });
    (u.hq_changes || []).forEach(function (x) {
      ul.appendChild(el("li", null, [el("span", { cls: "m", text: ACTION_WORDS[x.action] || String(x.action || "").replace(/^hq\./, "").replace(/[._]/g, " ") }),
        el("span", { cls: "muted", text: ist(x.at) + (x.actor_email ? " · " + x.actor_email : "") })]));
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "Helm HQ hasn’t changed anything on this studio." }));
    box.appendChild(el("div", { cls: "card" }, [el("h2", { text: "Changes made by Helm HQ" }), ul]));
    box.appendChild(el("p", { cls: "muted", text: "Helm HQ never sees a studio’s clients, quotes or prices — only these numbers." }));
  }

  /* ---------------- r23 (0257) "Change studio name / link" (Helm HQ only) ---------------- */
  function identityBox(org, d) {
    var box = el("div", { cls: "card hq-ident" });
    box.appendChild(el("h2", { text: "Change studio name & link" }));
    box.appendChild(el("div", { cls: "muted", text: "Studios can't change these themselves. Change them only when the studio asks (confirm who is asking). Old links keep working; the studio's admins get a bell notice and an e-mail." }));
    var nm = el("input", { type: "text", maxlength: "120", "aria-label": "Studio name" }); nm.value = d.name || "";
    var sl = el("input", { type: "text", maxlength: "40", spellcheck: "false", autocomplete: "off", "aria-label": "Studio link" }); sl.value = d.slug || "";
    var why = el("input", { type: "text", maxlength: "500", "aria-label": "Reason", placeholder: "Who asked, and how you confirmed it (10+ characters)" });
    var avail = el("div", { cls: "muted", "aria-live": "polite" });
    var seq = 0, tmr = null;
    var paint = function () {
      var v = String(sl.value || "").trim().toLowerCase(); var my = ++seq; clearTimeout(tmr);
      if (!v || v === d.slug) { avail.textContent = v ? "helm.events/" + v + " (current link)" : ""; return; }
      avail.textContent = "helm.events/" + v + " - checking...";
      tmr = setTimeout(function () {
        call("hq_studio_link_check", { p_org: org, p_slug: v }).then(function (r) {
          if (my !== seq || !r) return;
          avail.textContent = "helm.events/" + v + " - " + (r.ok ? (r.previous ? "available (an earlier link of this studio)" : "available")
            : r.reason === "taken" ? "used by another studio, or looks like one" : r.reason === "reserved" ? "reserved (a Helm word or look-alike)" : "3-40 lowercase letters, numbers or single dashes");
        }).catch(function () { if (my === seq) avail.textContent = ""; });
      }, 350);
    };
    sl.addEventListener("input", function () { var c = String(sl.value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-"); if (c !== sl.value) sl.value = c; paint(); });
    var go = el("button", { cls: "btn primary", type: "button", text: "Change studio name & link" });
    go.addEventListener("click", function () {
      var n = String(nm.value || "").trim(), l = String(sl.value || "").trim().toLowerCase().replace(/-+$/, ""), r = String(why.value || "").trim();
      if (n === (d.name || "") && l === (d.slug || "")) { showErr({ message: "Nothing to change." }); return; }
      if (r.length < 10) { showErr({ message: "Give a reason of at least 10 characters." }); why.focus(); return; }
      var lines = [];
      if (n !== (d.name || "")) lines.push("Name: " + (d.name || "-") + " -> " + n);
      if (l !== (d.slug || "")) lines.push("Link: helm.events/" + (d.slug || "-") + " -> helm.events/" + l + " (old links keep working)");
      if (!window.confirm("Change this studio?\n\n" + lines.join("\n") + "\n\nThe studio's admins are told by bell and e-mail.")) return;
      go.disabled = true;
      call("hq_set_studio_identity", { p_org: org, p_name: n !== (d.name || "") ? n : null, p_slug: l !== (d.slug || "") ? l : null, p_reason: r })
        .then(function () { okMsg("Studio name / link changed."); refreshAfterWrite(org); }).catch(showErr).then(function () { go.disabled = false; });
    });
    box.appendChild(el("div", { cls: "form" }, [field("Studio name", nm), field("Studio link (helm.events/...)", sl), el("label", { cls: "fld wide" }, [el("span", { text: "Reason" }), why]), go]));
    box.appendChild(avail);
    return box;
  }

  /* ---------------- r21 (0244) "Activate plan" ----------------
     Records the payment (numbered GST invoice), sets the plan ACTIVE with plan, billing and period and lifts the
     trial caps / read-only - one server step (hq_activate_plan), audit-logged. The studio admin is then asked
     once what happens to the sample data (keep / remove sample / start clean). */
  // pure: the last day of a period that starts on start (inclusive) - mirrors public._sub_period_end
  function periodEnd(start, interval) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(start || "")); if (!m) return "";
    var y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (interval === "yearly") y += 1; else mo += 1;
    var last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();   // Postgres date + interval clamps to the month end
    var e = new Date(Date.UTC(y, mo, Math.min(d, last)) - 864e5);
    return e.toISOString().slice(0, 10);
  }
  // pure: validated args for hq_activate_plan (exported for tests). The database checks the same.
  function activateArgs(org, plan, interval, amount, method, start, paidOn, ref) {
    var a = Number(amount), r = String(ref == null ? "" : ref).replace(/\s+/g, " ").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(org || ""))) throw new Error("Open a studio first");
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(String(plan || ""))) throw new Error("Choose the plan");
    if (interval !== "monthly" && interval !== "yearly") throw new Error("Choose monthly or yearly");
    if (!(a > 0) || a > 100000000) throw new Error("Amount (incl. tax) must be more than 0");
    if (["upi", "bank", "cash", "card", "other"].indexOf(method) < 0) throw new Error("Choose how they paid");
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("Period start must be a date");
    if (paidOn && !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new Error("Paid on must be a date");
    if (r.length > 120) throw new Error("Reference: up to 120 characters");
    return { p_org: org, p_plan_code: plan, p_interval: interval, p_amount: Math.round(a * 100) / 100, p_method: method,
      p_period_start: start || null, p_paid_on: paidOn || null, p_reference: r || null, p_currency: "INR", p_fx_rate_to_inr: null };
  }
  function activateBox(org, name, sub) {
    var box = el("div", { id: "activatePlan", cls: "card" });
    box.appendChild(el("h2", { text: "Activate plan" }));
    box.appendChild(el("div", { cls: "muted", text: "When the studio has paid (UPI / bank transfer): records the payment with a GST invoice, makes the plan active for the period and lifts the trial limits and read-only - in one step. The studio admin then chooses what happens to the sample data." }));
    var selPlan = el("select", { "aria-label": "Plan to activate" });
    plans.filter(function (p) { return p.active; }).forEach(function (p) {
      var o = el("option", { value: p.code, text: p.name + " · " + moneyBoth(p.price_monthly, p.currency) + "/month" });
      if (sub.plan_code === p.code || sub.plan_name === p.name) o.selected = true;
      selPlan.appendChild(o);
    });
    var selIv = el("select", { "aria-label": "Billing" });
    [["monthly", "Monthly"], ["yearly", "Yearly"]].forEach(function (o) { selIv.appendChild(el("option", { value: o[0], text: o[1] })); });
    var amt = el("input", { type: "number", min: "1", step: "0.01", "aria-label": "Amount paid incl. tax" });
    var meth = el("select", { "aria-label": "Paid by" });
    [["upi", "UPI"], ["bank", "Bank transfer"], ["card", "Card"], ["cash", "Cash"], ["other", "Other"]].forEach(function (o) { meth.appendChild(el("option", { value: o[0], text: o[1] })); });
    var today = istDay(Date.now());
    var start = el("input", { type: "date", "aria-label": "Period start" }); start.value = today;
    var paid = el("input", { type: "date", "aria-label": "Paid on" }); paid.value = today;
    var ref = el("input", { type: "text", maxlength: "120", placeholder: "UTR / reference", "aria-label": "Payment reference" });
    var endTxt = el("div", { cls: "muted" });
    var showEnd = function () { var e = periodEnd(start.value, selIv.value); endTxt.textContent = e ? "Plan period: " + date(start.value) + " – " + date(e) : ""; };
    selIv.addEventListener("change", showEnd); start.addEventListener("change", showEnd); showEnd();
    var go = el("button", { cls: "btn primary", type: "button", text: "Activate plan…" });
    if (!selPlan.options.length) { go.disabled = true; endTxt.textContent = "Add an active plan in Plans first."; }
    go.addEventListener("click", function () {
      var a; try { a = activateArgs(org, selPlan.value, selIv.value, amt.value, meth.value, start.value, paid.value, ref.value); } catch (e) { showErr(e); return; }
      var pe = periodEnd(a.p_period_start || today, a.p_interval);
      if (!window.confirm("Activate " + (selPlan.options[selPlan.selectedIndex] ? selPlan.options[selPlan.selectedIndex].text.split(" · ")[0] : a.p_plan_code) +
        " (" + a.p_interval + ") for " + (name || "this studio") + "?\n\nPayment " + moneyBoth(a.p_amount) + " by " + a.p_method + (a.p_reference ? " (" + a.p_reference + ")" : "") +
        "\nPeriod " + date(a.p_period_start || today) + " – " + date(pe) + "\n\nThis records the payment with a GST invoice and makes the plan active now.")) return;
      go.disabled = true;
      call("hq_activate_plan", a).then(function (r) {
        var inv = r && r.payment && r.payment.invoice_no;
        okMsg((r && r.result === "replay" ? "Already activated with this payment" : "Plan activated") + (inv ? " — invoice " + inv : "") + ".");
        amt.value = ""; ref.value = ""; refreshAfterWrite(org);
      }).catch(showErr).then(function () { go.disabled = false; });
    });
    box.appendChild(el("div", { cls: "form" }, [field("Plan", selPlan), field("Billing", selIv), field("Amount paid (incl. tax)", amt),
      field("Paid by", meth), field("Paid on", paid), field("Period start", start), field("Reference (UTR)", ref), go]));
    box.appendChild(endTxt);
    return box;
  }

  /* ---------------- r25: Requests = one inbox with tabs; click a row to read it, reply by e-mail, mark it ---------------- */
  var RTABS = ["plan", "sales", "sugg", "alerts"];
  function reqTab(name) {
    RTABS.forEach(function (t) {
      var b = $("#rt-" + t), p = $("#rp-" + t);
      if (b) b.setAttribute("aria-selected", t === name ? "true" : "false");
      if (p) p.hidden = t !== name;
    });
  }
  var REQ_NEW = { plan: 0, sales: 0, sugg: 0 }, ALERT_TO = "";
  function paintReqCounts() {
    $("#rcPlan").textContent = int(REQ_NEW.plan); $("#rcSales").textContent = int(REQ_NEW.sales); $("#rcSugg").textContent = int(REQ_NEW.sugg);
    var k = clear($("#reqCards"));
    k.appendChild(kpi("New plan requests", int(REQ_NEW.plan), "from studios on a trial", REQ_NEW.plan ? "warn" : "", function () { reqTab("plan"); }));
    k.appendChild(kpi("New sales enquiries", int(REQ_NEW.sales), "from the Contact sales form", REQ_NEW.sales ? "warn" : "", function () { reqTab("sales"); }));
    k.appendChild(kpi("New suggestions", int(REQ_NEW.sugg), "from the app and the website", REQ_NEW.sugg ? "warn" : "", function () { reqTab("sugg"); }));
    k.appendChild(kpi("Alerts go to", ALERT_TO || "—", "change in E-mail alerts", "mail", function () { reqTab("alerts"); }));
    var nb = $("#navReqCount"), n = REQ_NEW.plan + REQ_NEW.sales + REQ_NEW.sugg;
    if (nb) { nb.textContent = n > 99 ? "99+" : String(n); nb.hidden = !(n > 0); }
    paintBnav();
  }
  // pure: a safe "Reply by email" link (only a plain address; subject + greeting encoded) - exported for tests
  function mailtoHref(email, subject, name) {
    var e = String(email || "").trim();
    if (e.indexOf("\u2022") >= 0) return null;   // r57: a masked address is never a mailto target (self-contained for tests)
    if (!/^[^\s@<>",;:?&]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(e)) return null;
    var nm = /[@\u2022]/.test(String(name || "")) ? "" : String(name || "").trim();
    var body = "Hi " + (nm.split(/\s+/)[0] || "there") + ",\n\n";
    return "mailto:" + e + "?subject=" + encodeURIComponent(subject || "Helm") + "&body=" + encodeURIComponent(body);
  }
  // r57: the "Reply by email" target - a plain mailto link for a clear address (older database), else an object the
  // button turns into one after hq_reveal
  function replyTo(email, subject, name) {
    var e = String(email || "").trim(); if (!e) return null;
    return isMasked(e) ? { email: e, subject: subject, name: name } : mailtoHref(e, subject, name);
  }
  // click a row: a detail row opens under it (one at a time); build(td) fills it
  function rowWithDetail(tb, tr, cols, build) {
    tr.classList.add("click"); tr.setAttribute("tabindex", "0"); tr.setAttribute("aria-expanded", "false");
    var toggle = function (e) {
      if (e && e.target && e.target.closest && e.target.closest("button, a, select, input")) return;
      var next = tr.nextSibling, isOpen = next && next.classList && next.classList.contains("rowdetail");
      Array.prototype.slice.call(tb.querySelectorAll("tr.rowdetail")).forEach(function (r) { r.remove(); });
      Array.prototype.slice.call(tb.querySelectorAll("tr.open")).forEach(function (r) { r.classList.remove("open"); r.setAttribute("aria-expanded", "false"); });
      if (isOpen) return;
      var td = el("td", { colspan: String(cols) }), dr = el("tr", { cls: "rowdetail" }, [td]);
      build(td); tr.parentNode.insertBefore(dr, tr.nextSibling); tr.classList.add("open"); tr.setAttribute("aria-expanded", "true");
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", function (e) { if (e.key === "Enter") toggle(); });
    tb.appendChild(tr);
  }
  function noteBlock(x) {
    var ul = el("ul", { cls: "notes" });
    if (x.hq_note) ul.appendChild(el("li", null, [el("b", { text: "Note: " }), x.hq_note, x.handled_at ? el("span", { cls: "muted", text: " · " + ist(x.handled_at) }) : null]));
    else ul.appendChild(el("li", { cls: "muted", text: "No note yet." }));
    return ul;
  }
  function detailBox(td, pairs, message, reply, actions, rec) {
    td.appendChild(kvList(pairs));
    td.appendChild(el("div", { cls: "msgbox", text: message || "(no message)" }));
    var acts = el("div", { cls: "actions" });
    if (reply && typeof reply === "object") {
      // r57 (0298): the address is masked here - the button asks hq_reveal for it (logged) and then opens the mail app
      var rb = el("button", { cls: "btn primary", type: "button", text: "Reply by email" });
      rb.addEventListener("click", function () {
        rb.disabled = true;
        revealValue(rec ? rec[0] : "", rec ? rec[1] : null, "reply_email", reply.email).then(function (r) {
          var href = mailtoHref(r.value, reply.subject, reply.name);
          if (!href) throw new Error("No e-mail address to reply to.");
          window.location.href = href;
        }).catch(showErr).then(function () { rb.disabled = false; });
      });
      acts.appendChild(rb);
    } else if (reply) {
      var ra = el("a", { cls: "btn primary", href: reply, rel: "noopener", text: "Reply by email" });
      // r28: the reply opens the mail app with the full address = a reveal (logged, never blocks the reply)
      if (rec) ra.addEventListener("click", function () { logReveal(rec[0], rec[1], "reply_email").catch(function () {}); });
      acts.appendChild(ra);
    }
    (actions || []).forEach(function (a) { if (a) acts.appendChild(a); });
    td.appendChild(acts);
  }
  function msgCell(text) { return el("td", { cls: "msg" }, [el("div", { cls: "clip", text: text || "—" })]); }

  /* ---------------- r21 (0244) plan requests ("Contact sales") ---------------- */
  var REQ_STATUS = { new: ["New", "warn"], contacted: ["Contacted", ""], won: ["Won", "ok"], lost: ["Lost", "bad"] };
  async function loadRequests() {
    var r = await call("hq_sales_requests", { p_status: $("#fReq").value || null }); r = r && !Array.isArray(r) ? r : {};
    var c = r.counts || {};
    REQ_NEW.plan = num(c.new); paintReqCounts();
    $("#reqCounts").textContent = ["new", "contacted", "won", "lost"].map(function (k) { return REQ_STATUS[k][0] + ": " + int(c[k] || 0); }).join(" · ");
    var tb = clear($("#tReq"));
    (Array.isArray(r.rows) ? r.rows : []).forEach(function (x) {
      var st = REQ_STATUS[x.status] || [x.status || "—", ""];
      var tr = el("tr", null, [
        el("td", { text: ist(x.created_at) }),
        el("td", null, [el("strong", { text: x.studio || x.studio_name || "—" }), el("div", { cls: "muted",
          text: [x.subscription_status ? "now: " + String(x.subscription_status).replace("_", " ") : "", x.source === "read_only_banner" ? "from read-only banner" : "from plan page"].filter(Boolean).join(" · ") })]),
        el("td", null, [x.contact_name || "—", contactLine(x.contact_email, x.contact_phone, "request", x.id)]),
        el("td", { text: (x.plan_name || x.plan_code || "—") + " · " + (x.billing_interval === "yearly" ? "Yearly" : "Monthly") }),
        msgCell(x.message),
        el("td", null, [el("span", { cls: "pill " + st[1], text: st[0] })])]);
      rowWithDetail(tb, tr, 6, function (td) {
        var acts = [];
        ["contacted", "won", "lost"].filter(function (k) { return k !== x.status && can("inbox.write"); }).forEach(function (k) {
          var b = el("button", { cls: "btn", type: "button", text: "Mark " + REQ_STATUS[k][0].toLowerCase() });
          b.addEventListener("click", function () {
            var note = ask("Mark this request " + REQ_STATUS[k][0].toLowerCase() + ". Note (optional):", x.hq_note || "");
            if (note == null) return;
            call("hq_set_sales_request_status", { p_id: x.id, p_status: k, p_note: note || null })
              .then(function () { okMsg("Request marked " + REQ_STATUS[k][0].toLowerCase() + "."); loadRequests().catch(showErr); }).catch(showErr);
          });
          acts.push(b);
        });
        if (x.org_id && canTab("studios")) {
          var o = el("button", { cls: "btn", type: "button", text: "Open studio" });
          o.addEventListener("click", function () { openStudio(x.org_id, "plan"); });
          acts.push(o);
        }
        detailBox(td, [["Studio", x.studio || x.studio_name], ["Contact", x.contact_name], ["E-mail", masked(x.contact_email, "email", "request", x.id, "email")],
          ["Phone", masked(x.contact_phone, "phone", "request", x.id, "phone")],
          ["Plan", (x.plan_name || x.plan_code || "—") + " · " + (x.billing_interval === "yearly" ? "Yearly" : "Monthly")], ["Sent", ist(x.created_at)]],
          x.message, replyTo(x.contact_email, "Your Helm plan request", x.contact_name), acts, ["request", x.id]);
        td.appendChild(noteBlock(x));
      });
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "6", cls: "empty", text: "No requests here." })]));
  }

  // pure (r118 F-06): the lines the "Save subscription" confirm shows; "" when nothing would change (exported for tests)
  var SUB_STATUS_WORD = { trial: "Trial", active: "Paying (active)", past_due: "Past due", cancelled: "Cancelled" };
  function subscriptionChangeText(c) {
    c = c || {}; var out = [];
    if (c.plan) out.push("Plan: " + c.plan);
    if (c.status) out.push("Status: " + (SUB_STATUS_WORD[c.status] || c.status) + (c.status === "cancelled" || c.status === "past_due" ? " - the studio's access changes" : ""));
    if (c.periodStart) out.push("Period start: " + date(c.periodStart));
    if (c.periodEnd) out.push("Period end: " + date(c.periodEnd));
    if (c.trialEnds) out.push("Trial ends: " + date(c.trialEnds));
    return out.join("\n");
  }
  /* ---------------- r24 (0271) sales enquiries + suggestions + their e-mail settings ---------------- */
  var SE_STATUS = { new: ["New", "warn"], contacted: ["Contacted", ""], won: ["Won", "ok"], lost: ["Lost", "bad"] };
  var SG_STATUS = { new: ["New", "warn"], reviewed: ["Reviewed", ""], done: ["Done", "ok"] };
  var SE_PLAN = { starter: "Starter", studio: "Studio", enterprise: "Enterprise", not_sure: "Not sure yet" };
  var SE_TEAM = { "1": "Just me", "2-5": "2–5 people", "6-15": "6–15 people", "16-50": "16–50 people", "51+": "51+ people" };
  var SG_KIND = { idea: "Idea", problem: "Problem", other: "Other" };
  function ist(v) { var d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—"; }   // r37: India time, no zone label (owner); r118 (F-14): a bad timestamp shows "—", never "Invalid Date"
  // status buttons + "Note" for one row; fn = the HQ RPC, map = the statuses
  function rowActions(x, map, fn, reload) {
    var out = [];
    if (!can("inbox.write")) return out;
    Object.keys(map).filter(function (k) { return k !== "new" && k !== x.status; }).forEach(function (k) {
      var b = el("button", { cls: "btn", type: "button", text: "Mark " + map[k][0].toLowerCase() });
      b.addEventListener("click", function () {
        call(fn, { p_id: x.id, p_status: k, p_note: null })
          .then(function () { okMsg("Marked " + map[k][0].toLowerCase() + "."); reload().catch(showErr); }).catch(showErr);
      });
      out.push(b);
    });
    var n = el("button", { cls: "btn", type: "button", text: x.hq_note ? "Edit note" : "Add note" });
    n.addEventListener("click", function () {
      var note = ask("Note (leave empty to remove it):", x.hq_note || "");
      if (note == null) return;
      call(fn, { p_id: x.id, p_status: null, p_note: note }).then(function () { okMsg("Note saved."); reload().catch(showErr); }).catch(showErr);
    });
    out.push(n);
    return out;
  }
  function statusCell(x, map) {
    var st = map[x.status] || [x.status || "—", ""];
    return el("td", null, [el("span", { cls: "pill " + st[1], text: st[0] }), x.hq_note ? el("div", { cls: "muted", text: "note added" }) : null]);
  }
  async function loadSales() {
    var r = await call("hq_sales_enquiries", { p_status: $("#fSe").value || null }); r = r && !Array.isArray(r) ? r : {};
    var c = r.counts || {};
    REQ_NEW.sales = num(c.new);
    $("#seCounts").textContent = Object.keys(SE_STATUS).map(function (k) { return SE_STATUS[k][0] + ": " + int(c[k] || 0); }).join(" · ");
    var s = r.settings || {};
    if (s.notify_email != null) { $("#seEmail").value = s.notify_email; $("#seAck").checked = !!s.auto_reply; $("#seOpen").checked = !!s.form_open; ALERT_TO = s.notify_email; }
    paintReqCounts();
    var tb = clear($("#tSe"));
    (Array.isArray(r.rows) ? r.rows : []).forEach(function (x) {
      var det = [SE_PLAN[x.plan] ? "Plan: " + SE_PLAN[x.plan] : "", SE_TEAM[x.team_size] ? "Team: " + SE_TEAM[x.team_size] : "", x.events_per_year ? "Events / year: " + x.events_per_year : ""].filter(Boolean);
      var tr = el("tr", null, [
        el("td", { text: ist(x.created_at) }),
        el("td", null, [el("strong", { text: x.company || "—" }), el("div", { cls: "muted", text: [x.city, x.source === "home" ? "from home page" : "from Contact sales"].filter(Boolean).join(" · ") })]),
        el("td", null, [x.name || "—", contactLine(x.email, x.phone, "enquiry", x.id)]),
        el("td", { text: det.join(" · ") || "—" }),
        msgCell(x.message),
        statusCell(x, SE_STATUS)]);
      rowWithDetail(tb, tr, 6, function (td) {
        detailBox(td, [["Company", x.company], ["City", x.city], ["Name", x.name], ["E-mail", masked(x.email, "email", "enquiry", x.id, "email")],
          ["Phone", masked(x.phone, "phone", "enquiry", x.id, "phone")],
          ["Plan", SE_PLAN[x.plan]], ["Team", SE_TEAM[x.team_size]], ["Events / year", x.events_per_year], ["Sent", ist(x.created_at)]],
          x.message, replyTo(x.email, "Helm — your enquiry", x.name), rowActions(x, SE_STATUS, "hq_set_sales_enquiry", loadSales), ["enquiry", x.id]);
        td.appendChild(noteBlock(x));
      });
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "6", cls: "empty", text: "No sales enquiries here." })]));
  }
  async function loadSuggestions() {
    var r = await call("hq_suggestions", { p_status: $("#fSg").value || null }); r = r && !Array.isArray(r) ? r : {};
    var c = r.counts || {};
    REQ_NEW.sugg = num(c.new); paintReqCounts();
    $("#sgCounts").textContent = Object.keys(SG_STATUS).map(function (k) { return SG_STATUS[k][0] + ": " + int(c[k] || 0); }).join(" · ");
    var tb = clear($("#tSg"));
    (Array.isArray(r.rows) ? r.rows : []).forEach(function (x) {
      var who = x.who || (x.source === "app" ? "A Helm user" : "A visitor");
      var tr = el("tr", null, [
        el("td", { text: ist(x.created_at) }),
        el("td", null, [who, el("div", { cls: "muted", text: [x.studio, x.source === "app" ? "in the app" + (x.page ? " (" + x.page + ")" : "") : "website"].filter(Boolean).join(" · ") }),
          x.email ? el("div", null, [masked(x.email, "email", "suggestion", x.id, "email")]) : null]),
        el("td", { text: SG_KIND[x.category] || "—" }),
        msgCell(x.message),
        statusCell(x, SG_STATUS)]);
      rowWithDetail(tb, tr, 5, function (td) {
        detailBox(td, [["From", who], ["Studio", x.studio], ["E-mail", masked(x.email, "email", "suggestion", x.id, "email")], ["Kind", SG_KIND[x.category]],
          ["Where", x.source === "app" ? "in the app" + (x.page ? " (" + x.page + ")" : "") : "website"], ["Sent", ist(x.created_at)]],
          x.message, replyTo(x.email, "Thanks for your Helm suggestion", x.who), rowActions(x, SG_STATUS, "hq_set_suggestion", loadSuggestions), ["suggestion", x.id]);
        td.appendChild(noteBlock(x));
      });
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "No suggestions here." })]));
  }
  function saveSalesSettings() {
    var em = $("#seEmail").value.trim();
    if (!/^[^\s@<>",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(em)) { showErr(new Error("Enter a valid e-mail address")); return; }
    call("hq_set_sales_enquiry_settings", { p_notify_email: em, p_auto_reply: $("#seAck").checked, p_form_open: $("#seOpen").checked })
      .then(function () { ALERT_TO = em; paintReqCounts(); okMsg("Saved. Alerts go to " + em + "."); }).catch(showErr);
  }
  function loadRequestsTab() { loadRequests().catch(showErr); loadSales().catch(showErr); loadSuggestions().catch(showErr); }

  /* ---------------- r25: search across studios + people (top bar) ---------------- */
  var gTimer = null, gSeq = 0;
  function closeSearch() { var r = $("#gResults"); if (r) { r.hidden = true; clear(r); } }
  function runSearch() {
    var q = String($("#gSearch").value || "").trim(), box = $("#gResults"), my = ++gSeq;
    if (q.length < 2) { closeSearch(); return; }
    Promise.all([can("studios.read") ? call("hq_studios", { p_search: q, p_status: null, p_limit: 5, p_offset: 0 }).catch(function () { return []; }) : [],
      can("people.read") ? call("hq_users", { p_search: q, p_limit: 5, p_offset: 0 }).catch(function () { return []; }) : []]).then(function (r) {
      if (my !== gSeq) return;
      var st = Array.isArray(r[0]) ? r[0] : [], us = Array.isArray(r[1]) ? r[1] : [];
      clear(box);
      box.appendChild(el("h4", { text: "Studios" }));
      st.forEach(function (s) {
        var b = el("button", { type: "button" }, [el("span", null, [el("strong", { text: s.name || "—" }), s.slug ? el("span", { cls: "muted", text: "  helm.events/" + s.slug }) : null]), statusPill(s.status)]);
        b.addEventListener("click", function () { closeSearch(); openStudio(s.org_id); });
        box.appendChild(b);
      });
      if (!st.length) box.appendChild(el("div", { cls: "empty", text: "  No studio matches." }));
      box.appendChild(el("h4", { text: "People" }));
      us.forEach(function (u) {
        var b = el("button", { type: "button" }, [el("span", { text: maskEmail(u.email) || "—" }), el("span", { cls: "muted", text: [u.studio, u.role].filter(Boolean).join(" · ") })]);
        b.addEventListener("click", function () { closeSearch(); if (!canTab("people")) return; showTab("people"); $("#qUsers").value = u.email || ""; loadUsers(0).catch(showErr); });
        box.appendChild(b);
      });
      if (!us.length) box.appendChild(el("div", { cls: "empty", text: "  Nobody matches." }));
      box.hidden = false;
    });
  }

  /* ---------------- 0186 free-trial extension ---------------- */
  // pure: validated args for hq_extend_trial (exported for tests). The database checks the same.
  function trialExtendArgs(org, days, reason) {
    var d = Number(days), r = String(reason == null ? "" : reason).replace(/\s+/g, " ").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(org || ""))) throw new Error("Open a studio first");
    if (!(d >= 1 && d <= 7) || Math.floor(d) !== d) throw new Error("An extension is 1 to 7 days");
    if (r.length < 5) throw new Error("Write the reason for the extension (at least 5 characters)");
    if (r.length > 500) throw new Error("The reason can be up to 500 characters");
    return { p_org: org, p_days: d, p_reason: r };
  }
  async function loadTrialInfo(org, name, box) {
    var t = await call("hq_trial_info", { p_org: org }); t = t && !Array.isArray(t) ? t : {};
    clear(box);
    var x = t.extension || null, ended = t.trial_ends_at && new Date(t.trial_ends_at).getTime() <= Date.now(), tz = t.timezone || null;
    var subEnd = document.getElementById("subTrialEnd");
    if (subEnd && t.trial_ends_at) subEnd.textContent = " · trial ends " + trialDay(t.trial_ends_at, tz);
    var ovEnd = document.getElementById("ovTrialEnd");   // r118 (F-11): the Overview fact shows the same day
    if (ovEnd && t.trial_ends_at) ovEnd.textContent = trialDay(t.trial_ends_at, tz);
    box.appendChild(el("div", null, [statusPill(t.status || "none"), " ",
      t.trial_ends_at ? (ended ? "trial ended " : "trial ends ") + trialDay(t.trial_ends_at, tz) : "no trial end date",
      t.locked ? " · read-only" : "", t.trial_mode ? " · " + (t.trial_mode === "demo" ? "sample data" : "own data") : ""]));
    if (x) {
      box.appendChild(el("div", { cls: "muted", text: "Extended once by " + int(x.days) + " day" + (num(x.days) === 1 ? "" : "s") +
        " on " + date(x.granted_at) + (x.granted_by_email ? " by " + x.granted_by_email : "") + " (" + trialDay(x.previous_ends_at, tz) + " → " + trialDay(x.new_ends_at, tz) + ")." }));
      box.appendChild(el("div", { cls: "muted", text: "Reason: " + (x.reason || "—") }));
      box.appendChild(el("div", { cls: "muted", text: "Only one extension is allowed per studio." }));
      return;
    }
    if (!can("studios.edit")) { box.appendChild(el("div", { cls: "muted", text: "Trial extensions are done by HQ people who may edit studios." })); return; }
    if (!t.can_extend) { box.appendChild(el("div", { cls: "muted", text: t.why_not || "This studio cannot get a trial extension." })); return; }
    var sel = el("select", { "aria-label": "Extra days" });
    for (var i = 1; i <= 7; i++) { var o = el("option", { value: String(i), text: i + " day" + (i === 1 ? "" : "s") }); if (i === 7) o.selected = true; sel.appendChild(o); }
    var why = el("input", { type: "text", maxlength: "500", placeholder: "Why? e.g. customer asked for more time to evaluate", "aria-label": "Reason for the extension" });
    var go = el("button", { cls: "btn primary", type: "button", text: "Extend trial…" });
    go.addEventListener("click", function () {
      var a; try { a = trialExtendArgs(org, sel.value, why.value); } catch (e) { showErr(e); return; }
      if (!window.confirm("Extend the free trial of " + (name || "this studio") + " by " + a.p_days + " day" + (a.p_days === 1 ? "" : "s") +
        "? This can be done only ONCE for this studio, and the reason is kept in the HQ log.")) return;
      go.disabled = true;
      call("hq_extend_trial", a).then(function (r) { okMsg("Trial extended" + (r && r.new_ends_at ? " to " + date(r.new_ends_at) : "") + "."); refreshAfterWrite(org); })
        .catch(showErr).then(function () { go.disabled = false; });
    });
    box.appendChild(el("div", { cls: "muted", text: "One-time extension (up to 7 days). It starts from the current trial end, or from today if the trial has already ended." }));
    box.appendChild(el("div", { cls: "form" }, [field("Extra days", sel), field("Reason (required)", why), go]));
  }

  /* ---------------- r22 (0253): lost phone -> Helm-assisted two-step reset ----------------
     The database decides (hq_mfa_reset): HQ operator signed in WITH two-step (aal2), never your own account, a reason,
     at most 10 a day, audited (HQ Activity) + kept in an append-only log. The person's authenticator is marked
     unverified (never deleted); at their next sign-in Helm asks them to set it up again. */
  // r57: is this (possibly masked) address the same as a typed / my own address?
  function sameAddr(shown, typed) {
    var a = String(shown || "").trim().toLowerCase(), b = String(typed || "").trim().toLowerCase();
    if (!a || !b) return false;
    return isMasked(a) ? maskEmail(b).toLowerCase() === a : a === b;
  }
  function mfaCell(email, on, after, rec) {
    var kids = [el("span", { cls: "pill " + (on ? "ok" : ""), text: on ? "on" : "off" })];
    var me = (BPStore.auth.user() && BPStore.auth.user().email) || "";
    if (on && email && can("security.write") && !sameAddr(email, me)) {
      var b = el("button", { cls: "btn sm danger", type: "button", text: "Reset", title: "Reset two-step for " + email + " (lost phone)" });
      b.addEventListener("click", function () { resetMfa(email, b, after, rec); });
      kids.push(" "); kids.push(b);
    }
    return kids;
  }
  function resetMfa(email, btn, after, rec) {
    if (!window.confirm("Reset two-step verification for " + email + "?\n\nOnly do this after you have confirmed who they are (for example a call to the number you already have, or an e-mail from this address). Their next sign-in needs only their password or Google, and Helm then asks them to set two-step up again.")) return;
    var why = ask("Reason (kept in the HQ log) - how did you confirm who they are?", "");
    if (why == null) return;
    if (why.length < 10) { showErr(new Error("Give a reason of at least 10 characters.")); return; }
    var again = ask("Type the person's e-mail address to confirm:", "");
    if (again == null) return;
    again = String(again).trim();
    if (!sameAddr(email, again)) { showErr(new Error("The e-mail address didn't match - nothing was reset.")); return; }
    btn.disabled = true;
    // r57 (0298): the list shows a masked address - check the typed one against the real one (hq_reveal, logged)
    // so a look-alike address can never reset someone else; the reset itself goes to the address typed
    var check = (isMasked(email) && rec) ? revealValue(rec[0], rec[1], "email", email).then(function (r) {
      if (String((r && r.value) || "").toLowerCase() !== again.toLowerCase()) throw new Error("The e-mail address didn't match - nothing was reset.");
    }) : Promise.resolve();
    check.then(function () { return call("hq_mfa_reset", { p_email: isMasked(email) ? again : email, p_reason: why }); }).then(function (r) {
      okMsg((r && r.message) || "Two-step reset."); if (after) after();
    }).catch(showErr).then(function () { btn.disabled = false; });
  }

  /* ---------------- people ---------------- */
  async function loadUsers(off) {
    uOff = off || 0;
    var rows = await call("hq_users", { p_search: $("#qUsers").value || null, p_limit: PAGE, p_offset: uOff });
    var tb = clear($("#tUsers")); rows = Array.isArray(rows) ? rows : [];
    rows.forEach(function (r) {
      tb.appendChild(el("tr", null, [el("td", null, [masked(r.email, "email", "person", r.user_id || null, "email") || "—"]), el("td", { text: r.studio || "—" }), el("td", { text: r.role || "—" }),
        el("td", { text: date(r.created_at) }), el("td", { text: ago(r.last_sign_in_at) }),
        el("td", null, [el("span", { cls: "pill " + (r.email_confirmed ? "ok" : "warn"), text: r.email_confirmed ? "yes" : "no" })]),
        el("td", null, mfaCell(r.email, r.mfa_enabled, function () { loadUsers(uOff).catch(showErr); }, r.user_id ? ["person", r.user_id] : null))]));
    });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "7", cls: "empty", text: "No users match." })]));
    pager($("#pUsers"), uOff, rows.length ? num(rows[0].total_count) : 0, function (o) { loadUsers(o).catch(showErr); });
  }

  /* ---------------- billing ---------------- */
  async function loadBilling() {
    var r = await call("hq_billing", { p_from: $("#bFrom").value || null, p_to: $("#bTo").value || null });
    r = r && !Array.isArray(r) ? r : {}; lastBilling = r;
    var k = clear($("#bKpis"));
    k.appendChild(kpi("Collected", moneyList(r.collected), int(r.payments_count) + " payments · " + int(r.voided_count) + " void"));
    k.appendChild(kpi("MRR", moneyList(r.mrr), "active + past-due"));
    k.appendChild(kpi("Past due", int((r.past_due || []).length), "studios", (r.past_due || []).length ? "warn" : ""));
    paymentRows(clear($("#tPay")), r.payments, true);
    var pd = clear($("#pastDue"));
    (r.past_due || []).forEach(function (x) { pd.appendChild(el("li", null, [el("span", { text: x.name || "—" }), el("span", { cls: "muted", text: (x.plan_code || "") + " · ended " + date(x.current_period_end) + " · " + int(x.days_overdue) + " days" })])); });
    if (!pd.firstChild) pd.appendChild(el("li", { cls: "empty", text: "No studio is past due." }));
    var rm = clear($("#reminders"));
    (r.reminders || []).slice(0, 30).forEach(function (x) { rm.appendChild(el("li", null, [el("span", { text: (x.studio || "—") + " · " + String(x.kind || "").replace("_", " ") }), el("span", { cls: "muted", text: "period " + date(x.period_end) + " · " + (x.sent_at ? "sent " + date(x.sent_at) + " (" + (x.channel || "") + ")" : "queued") })])); });
    if (!rm.firstChild) rm.appendChild(el("li", { cls: "empty", text: "No reminders." }));
    var ux = await call("hq_unrealised_exports"); ux = Array.isArray(ux) ? ux : [];
    var ul = clear($("#unrealised"));
    ux.forEach(function (p) {
      var b = el("button", { cls: "btn sm", type: "button", text: "Mark realised" });
      b.addEventListener("click", function () {
        var ref = ask("FIRA / FIRC reference for " + (p.invoice_no || "") + ":"); if (!ref) return;
        var on = ask("Realised on (YYYY-MM-DD):", istDay(Date.now())); if (!on) return;
        call("hq_record_realisation", { p_id: p.id, p_fira_firc_ref: ref, p_realised_on: on }).then(function () { okMsg("Realisation recorded."); loadBilling().catch(showErr); }).catch(showErr);
      });
      ul.appendChild(el("li", null, [el("span", { text: (p.studio || "—") + " · " + (p.invoice_no || "") + " · " + money(p.amount, p.currency) }), el("span", { cls: "muted", text: (p.tax_regime || "") + " · " + date(p.paid_on) }), b]));
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "Every export payment is realised." }));
  }
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    // spreadsheet formula injection guard (R32: same rule as reports.html toCSV - leading spaces and the
    // full-width ＝＋－＠ forms count too; real numbers such as -500 stay numbers)
    if (typeof v !== "number" && /^[\s\u00a0\u3000]*[=+\-@\t\r\uff1d\uff0b\uff0d\uff20]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportCsv() {
    logReveal("billing", "payments", "csv_export").catch(function () {});   // r28: an export is recorded like a reveal
    var r = lastBilling || {}, rows = [["paid_on", "studio", "invoice_no", "amount", "currency", "net_amount", "gst_amount", "method", "reference", "period_start", "period_end", "status", "void_reason"]];
    (r.payments || []).forEach(function (p) {
      rows.push([p.paid_on, p.studio, p.invoice_no, p.amount, p.currency, p.net_amount, p.gst_amount, p.method, p.reference, p.period_start, p.period_end, p.voided ? "void" : "paid", p.void_reason]);
    });
    var csv = rows.map(function (x) { return x.map(csvCell).join(","); }).join("\r\n");
    var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    var a = el("a", { href: url, download: "helm-billing-" + (r.from || "") + "-to-" + (r.to || "") + ".csv" });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function recordPayment() {
    var org = $("#rOrg").value;
    if (!org) { showErr(new Error("Open a studio (Studios tab) and choose “Record a payment”, or paste its id.")); return; }
    var amt = Number($("#rAmount").value);
    if (!(amt > 0)) { showErr(new Error("Amount must be more than 0")); return; }
    var b = $("#btnRecord"); b.disabled = true;
    call("hq_record_payment", { p_org: org, p_amount: amt, p_paid_on: $("#rPaidOn").value || istDay(Date.now()), p_method: $("#rMethod").value,
      p_currency: ($("#rCur").value || "INR").toUpperCase(), p_fx_rate_to_inr: $("#rFx").value ? Number($("#rFx").value) : null, p_period_start: $("#rPs").value || null, p_period_end: $("#rPe").value || null, p_reference: $("#rRef").value || null })
      .then(function (p) { okMsg("Payment recorded" + (p && p.invoice_no ? " — invoice " + p.invoice_no : "") + "."); $("#rAmount").value = ""; $("#rRef").value = ""; refreshAfterWrite(org); })
      .catch(showErr).then(function () { b.disabled = false; });
  }
  async function loadSettings() {
    var s = await call("hq_billing_settings"); s = s && !Array.isArray(s) ? s : {};
    $("#sName").value = s.legal_name || ""; $("#sGstin").value = s.gstin || ""; $("#sAddr").value = s.address || "";
    $("#sState").value = s.seller_state || ""; $("#sCountry").value = s.seller_country || "IN";
    $("#sLut").value = s.lut_number || ""; $("#sLutFrom").value = s.lut_valid_from || ""; $("#sLutTo").value = s.lut_valid_to || "";
    $("#sRate").value = s.gst_rate != null ? s.gst_rate : 18; $("#sPrefix").value = s.invoice_prefix != null ? s.invoice_prefix : "HELM-";
    showCheckoutSettings(s);
  }
  /* ---------------- 0056 studio checkout switches ---------------- */
  function showCheckoutSettings(s) {
    var has = s && Object.prototype.hasOwnProperty.call(s, "allow_trial_bypass");
    $("#coLive").checked = !!(s && s.online_payments_live); $("#coBypass").checked = !!(s && s.allow_trial_bypass);
    $("#coTermsV").value = (s && s.terms_version) || "";
    ["#coLive", "#coBypass", "#coTermsV", "#btnCheckout"].forEach(function (q) { $(q).disabled = !has; });
    $("#coState").textContent = !has ? "Checkout settings appear after migration 0056 is applied."
      : "Online payment: " + (s.online_payments_live ? "LIVE" : "off (free trial)") + " · Testing bypass: " + (s.allow_trial_bypass ? "ON — turn off before launch" : "off");
  }
  // pure: validated args for hq_set_checkout_settings (exported for tests)
  function checkoutSettingsArgs(live, bypass, terms) {
    var t = String(terms == null ? "" : terms).trim();
    if (t && !/^[A-Za-z0-9._-]{1,32}$/.test(t)) throw new Error("Terms version: letters, numbers, . _ - only (up to 32)");
    return { p_allow_trial_bypass: !!bypass, p_online_payments_live: !!live, p_terms_version: t || null };
  }
  function saveCheckoutSettings() {
    var a; try { a = checkoutSettingsArgs($("#coLive").checked, $("#coBypass").checked, $("#coTermsV").value); } catch (e) { showErr(e); return; }
    if (a.p_online_payments_live && !window.confirm("Turn ON online payment? New studios will be asked to pay through Razorpay.")) { $("#coLive").checked = false; return; }
    var b = $("#btnCheckout"); b.disabled = true;
    call("hq_set_checkout_settings", a).then(function (s) { showCheckoutSettings(s); okMsg("Checkout settings saved."); })
      .catch(showErr).then(function () { b.disabled = false; });
  }
  function saveSettings() {
    var rate; try { rate = requiredNumber($("#sRate").value, "GST rate (%)", 0, 50); } catch (e) { showErr(e); return; }
    if (rate === 0 && !window.confirm("GST rate 0%? New Helm invoices will charge NO GST. Press OK only if that is right (for example an export under LUT).")) return;
    call("hq_set_billing_settings", { p_legal_name: $("#sName").value, p_gstin: $("#sGstin").value || null, p_address: $("#sAddr").value || null,
      p_gst_rate: rate, p_invoice_prefix: $("#sPrefix").value })
      .then(function () { return call("hq_set_seller_tax", { p_seller_country: $("#sCountry").value || "IN", p_seller_state: $("#sState").value || null,
        p_lut_number: $("#sLut").value || null, p_lut_valid_from: $("#sLutFrom").value || null, p_lut_valid_to: $("#sLutTo").value || null }); }).then(function () { okMsg("Invoice settings saved — used for new payments."); }).catch(showErr);
  }

  // r118 (F-02): "Refresh past-due" writes to real studios - say so first (the database then asks for a fresh two-step code)
  var REFRESH_PAST_DUE_CONFIRM = "Refresh past-due now?\n\nThis is not just a refresh of the screen. Helm checks every studio: a paid period or a trial that has ended unpaid is marked PAST DUE, and billing reminder e-mails + bell notices are queued to those studios' admins.\n\nHelm can't tell in advance how many studios this touches; the count shows when it is done. It also runs on its own every day.";
  // r118 (F-05): a money / rate field - blank is an error (never a silent 0); a deliberate 0 must be typed as 0
  function requiredNumber(raw, label, min, max) {
    var t = String(raw == null ? "" : raw).trim();
    if (!t) throw new Error(label + " is empty - type a number (type 0 only if you really mean 0)");
    var n = Number(t);
    if (!isFinite(n)) throw new Error(label + " must be a number");
    if (min != null && n < min) throw new Error(label + " must be " + min + " or more");
    if (max != null && n > max) throw new Error(label + " must be " + max + " or less");
    return n;
  }
  /* ---------------- plans ---------------- */
  // r25 (0273): each plan's fixed USD price (studios outside India pay in USD) - {code: {monthly, yearly}}
  var PLAN_INR = {};
  async function usdPrices() {
    var out = {}; PLAN_INR = {};
    try { var r = await call("hq_plan_checkout"); (Array.isArray(r) ? r : []).forEach(function (p) {
      (Array.isArray(p.prices) ? p.prices : []).forEach(function (x) { if (x.currency === "USD") out[p.code] = { monthly: x.monthly, yearly: x.yearly };
        if (x.currency === "INR") PLAN_INR[p.code] = { monthly: x.monthly, yearly: x.yearly }; }); }); }
    catch (e) {}
    return out;
  }
  // r28 round 2: one "Edit plan" card - name, visible, prices ($ and ₹, monthly / yearly), website + checkout text
  function openPlanEditor(p, u, ir) {
    var ed = $("#planEditor"); if (!ed) return;
    p = p || {}; u = u || {}; ir = ir || {};
    $("#peH").textContent = p.code ? "Edit plan - " + (p.name || p.code) : "New plan";
    $("#plCode").value = p.code || ""; $("#plCode").readOnly = !!p.code; $("#plName").value = p.name || ""; $("#plActive").checked = p.code ? !!p.active : true;
    $("#plPrice").value = p.price_monthly == null ? "" : p.price_monthly; $("#plInrY").value = ir.yearly == null ? "" : ir.yearly;
    $("#plUsdM").value = u.monthly == null ? "" : u.monthly; $("#plUsdY").value = u.yearly == null ? "" : u.yearly;
    var co = planCo.filter(function (x) { return x.code === p.code; })[0];
    if (co) fillPlanCoForm(co, "INR"); else { $("#pcCode").value = p.code || ""; $("#pcDesc").value = ""; $("#pcFeat").value = ""; $("#pcRzpM").value = ""; $("#pcRzpY").value = ""; clear($("#pcCur")).appendChild(el("option", { value: "INR", text: "INR" })); }
    ed.hidden = false; try { ed.scrollIntoView({ behavior: "smooth", block: "start" }); $("#plName").focus(); } catch (e) {}
  }
  // pure: validated args for hq_upsert_plan_price in USD, or null when both fields are empty (exported for tests)
  function usdPriceArgs(code, m, y) {
    var ms = String(m == null ? "" : m).trim(), ys = String(y == null ? "" : y).trim();
    if (!ms && !ys) return null;
    if (!ms) throw new Error("Enter the USD price per month (the yearly price is optional)");
    var mm = Number(ms), yy = ys ? Number(ys) : null;
    if (!isFinite(mm) || mm < 0 || (yy != null && (!isFinite(yy) || yy < 0))) throw new Error("USD prices must be 0 or more");
    return { p_plan_code: String(code || "").trim().toLowerCase(), p_currency: "USD", p_price_monthly: mm, p_price_yearly: yy };
  }
  async function loadPlans() {
    var r = await call("hq_plans"); plans = Array.isArray(r) ? r : [];
    var usd = await usdPrices(), inr = PLAN_INR;
    var tb = clear($("#tPlans"));
    plans.forEach(function (p) {
      var edit = el("button", { cls: "btn sm", type: "button", text: "Edit" }), u = usd[p.code] || {};
      edit.addEventListener("click", function () { openPlanEditor(p, u, inr[p.code] || {}); });
      tb.appendChild(el("tr", null, [el("td", null, [el("strong", { text: p.name }), el("div", { cls: "muted m", text: p.code })]),
        el("td", { cls: "n", text: money(p.price_monthly, p.currency), title: moneyRaw(p.price_monthly, p.currency) }),
        el("td", { cls: "n", text: u.monthly == null ? "—" : moneyRaw(u.monthly, "USD") }), el("td", { cls: "n", text: u.yearly == null ? "—" : moneyRaw(u.yearly, "USD") }),
        el("td", null, [el("span", { cls: "pill " + (p.active ? "ok" : ""), text: p.active ? "visible" : "hidden" })]), el("td", { cls: "n", text: int(p.studios) }), el("td", null, [can("billing.write") ? edit : null])]));
    });
    var tr = can("billing.read") ? await call("hq_tax_rules") : []; tr = Array.isArray(tr) ? tr : [];
    var tt = clear($("#tTax"));
    tr.forEach(function (x) { tt.appendChild(el("tr", null, [el("td", { text: x.country + (x.region ? " · " + x.region : "") }), el("td", { cls: "m", text: x.regime }),
      el("td", { cls: "n", text: num(x.rate) + "%" }), el("td", { text: date(x.effective_from) + " – " + (x.effective_to ? date(x.effective_to) : "open") }),
      el("td", null, [el("span", { cls: "pill " + (x.active ? "ok" : ""), text: x.active ? "active" : "off" })]), el("td", { text: x.invoice_note || "" })])); });
    if (!plans.length) tb.appendChild(el("tr", null, [el("td", { colspan: "7", cls: "empty", text: "No plans yet — add one below." })]));
    loadPlanCheckout().catch(showErr);
  }
  function saveTaxRule() {
    call("hq_upsert_tax_rule", { p_country: $("#txCountry").value, p_region: $("#txRegion").value || null, p_regime: $("#txRegime").value,
      p_rate: Number($("#txRate").value), p_invoice_note: $("#txNote").value || null, p_effective_from: $("#txFrom").value || null,
      p_effective_to: $("#txTo").value || null, p_active: $("#txActive").checked }).then(function () { okMsg("Tax rule saved."); loadPlans().catch(showErr); }).catch(showErr);
  }
  /* ---------------- 0056 per-plan checkout details ---------------- */
  var planCo = [];
  // pure: validated args for hq_set_plan_checkout (exported for tests)
  function planCheckoutArgs(code, cur, desc, featText, rzpM, rzpY) {
    var RZ = /^plan_[A-Za-z0-9]{6,40}$/;
    var feats = String(featText || "").split(/\r?\n/).map(function (x) { return x.replace(/\s+/g, " ").trim(); }).filter(Boolean);
    if (feats.length > 20) throw new Error("Up to 20 included items");
    feats.forEach(function (f) { if (f.length > 120) throw new Error("Each included item: up to 120 characters"); if (/[<>]/.test(f)) throw new Error("Remove < and > from included items"); });
    var d = String(desc || "").replace(/\s+/g, " ").trim();
    if (d.length > 300 || /[<>]/.test(d)) throw new Error("Description: up to 300 characters, no < or >");
    var m = String(rzpM || "").trim(), y = String(rzpY || "").trim();
    if (m && !RZ.test(m)) throw new Error("Monthly Razorpay plan id must look like plan_XXXXXXXXXXXX");
    if (y && !RZ.test(y)) throw new Error("Yearly Razorpay plan id must look like plan_XXXXXXXXXXXX");
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(String(code || ""))) throw new Error("Choose a plan");
    return { p_code: code, p_currency: /^[A-Z]{3}$/.test(cur) ? cur : "INR", p_description: d || null, p_features: feats,
      p_sort_order: null, p_razorpay_plan_id_monthly: m || null, p_razorpay_plan_id_yearly: y || null };
  }
  function fillPlanCoForm(p, cur) {
    var sel = clear($("#pcCur")), prices = Array.isArray(p.prices) ? p.prices : [];
    prices.forEach(function (x) { var o = el("option", { value: x.currency, text: x.currency }); if (x.currency === cur) o.selected = true; sel.appendChild(o); });
    if (!prices.length) sel.appendChild(el("option", { value: "INR", text: "INR (add a price first)" }));
    var pr = prices.filter(function (x) { return x.currency === sel.value; })[0] || {};
    $("#pcCode").value = p.code; $("#pcDesc").value = p.description || "";
    $("#pcFeat").value = (Array.isArray(p.features) ? p.features : []).join("\n");
    $("#pcRzpM").value = pr.razorpay_plan_id_monthly || ""; $("#pcRzpY").value = pr.razorpay_plan_id_yearly || "";
    $("#pcForm").hidden = false;
  }
  async function loadPlanCheckout() {
    var tb = clear($("#tPlanCo"));
    try { var r = await call("hq_plan_checkout"); planCo = Array.isArray(r) ? r : []; }
    catch (e) { planCo = []; tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "Checkout details appear after migration 0056 is applied." })])); return; }
    planCo.forEach(function (p) {
      var ids = (Array.isArray(p.prices) ? p.prices : []).map(function (x) {
        return x.currency + ": " + (x.razorpay_plan_id_monthly || "— monthly") + " / " + (x.razorpay_plan_id_yearly || "— yearly"); }).join("; ") || "no prices yet";
      var edit = el("button", { cls: "btn sm", type: "button", text: "Edit" });
      edit.addEventListener("click", function () { var hp = plans.filter(function (x) { return x.code === p.code; })[0] || { code: p.code, name: p.name, active: true };
        var u2 = {}; (Array.isArray(p.prices) ? p.prices : []).forEach(function (x) { if (x.currency === "USD") u2 = x; }); openPlanEditor(hp, u2, PLAN_INR[p.code]); });
      tb.appendChild(el("tr", null, [el("td", { text: p.name + " (" + p.code + ")" }), el("td", { text: p.description || "—" }),
        el("td", { cls: "n", text: int((p.features || []).length) + " items" }), el("td", { cls: "m", text: ids }), el("td", null, [can("billing.write") ? edit : null])]));
    });
    if (!planCo.length) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "No plans yet — add one above." })]));
  }
  function savePlanCheckout() {
    var a; try { a = planCheckoutArgs($("#pcCode").value, $("#pcCur").value, $("#pcDesc").value, $("#pcFeat").value, $("#pcRzpM").value, $("#pcRzpY").value); }
    catch (e) { showErr(e); return; }
    var b = $("#btnPlanCo"); b.disabled = true;
    call("hq_set_plan_checkout", a).then(function () { okMsg("Checkout details saved."); loadPlanCheckout().catch(showErr); })
      .catch(showErr).then(function () { b.disabled = false; });
  }
  function savePlan() {
    var u; try { u = usdPriceArgs($("#plCode").value, $("#plUsdM").value, $("#plUsdY").value); } catch (e) { showErr(e); return; }
    var code = String($("#plCode").value || "").trim().toLowerCase(), iy = String($("#plInrY").value || "").trim(), co = null, pm;
    if (iy && !(Number(iy) >= 0)) { showErr(new Error("₹ price per year must be 0 or more")); return; }
    try { pm = requiredNumber($("#plPrice").value, "₹ price per month", 0); } catch (e) { showErr(e); return; }   // r118 (F-05): blank is never ₹0
    if (pm === 0 && $("#plActive").checked && !window.confirm("Save this visible plan at ₹0 per month? It shows as free on the website pricing page and in checkout.")) return;
    // r28 round 2: the website + checkout text is saved in the same step when it was filled in
    if (String($("#pcDesc").value || "").trim() || String($("#pcFeat").value || "").trim() || $("#pcRzpM").value || $("#pcRzpY").value) {
      try { co = planCheckoutArgs(code, "INR", $("#pcDesc").value, $("#pcFeat").value, $("#pcRzpM").value, $("#pcRzpY").value); } catch (e) { showErr(e); return; }
    }
    call("hq_upsert_plan", { p_code: $("#plCode").value, p_name: $("#plName").value, p_price_monthly: pm, p_currency: "INR", p_active: $("#plActive").checked })
      .then(function () { return u ? call("hq_upsert_plan_price", u) : null; })   // r25: the fixed USD price next to INR
      .then(function () { return iy ? call("hq_upsert_plan_price", { p_plan_code: code, p_currency: "INR", p_price_monthly: pm, p_price_yearly: Number(iy) }) : null; })
      .then(function () { return co ? call("hq_set_plan_checkout", co) : null; })
      .then(function () { okMsg("Plan saved. Visible plans show on the website pricing page."); $("#planEditor").hidden = true; loadPlans().catch(showErr); }).catch(showErr);
  }

  /* ---------------- activity + operators ---------------- */
  async function loadAudit() {
    var r = await call("hq_audit", { p_from: $("#aFrom").value || null, p_to: $("#aTo").value || null }); r = r && !Array.isArray(r) ? r : {};
    var tb = clear($("#tAudit")), writesOnly = $("#aWrites").checked;
    (r.rows || []).filter(function (x) { return !writesOnly || x.action !== "hq.view"; }).slice(0, 500).forEach(function (x) {
      var what = (x.entity || "") + (x.entity_id ? " · " + x.entity_id : "") + (x.action === "hq.reveal" && x.changed && x.changed.field ? " · " + String(x.changed.field).replace(/_/g, " ") : "");
      tb.appendChild(el("tr", null, [el("td", { text: x.at ? ist(x.at) : "—" }), el("td", { cls: "m", text: x.actor_email || "system" }),
        el("td", null, [el("span", { cls: "pill " + (x.action === "hq.reveal" ? "warn" : x.action === "hq.view" ? "" : "ok"), text: actWord(x.action) }), el("div", { cls: "muted m", text: x.action || "" })]),
        el("td", { text: what })]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "No HQ activity in this range." })]));
  }
  // 0054: cross-studio security feed (operators only; names, no e-mails)
  async function loadSecurity() {
    var r = await call("hq_security_alerts", { p_from: $("#aFrom").value || null, p_to: $("#aTo").value || null }); r = r && !Array.isArray(r) ? r : {};
    $("#secTotal").textContent = int(r.total) + " event" + (num(r.total) === 1 ? "" : "s");
    var tb = clear($("#tSec"));
    (r.by_studio || []).forEach(function (x) {
      tb.appendChild(el("tr", null, [el("td", null, [el("span", { cls: "secic", "aria-hidden": "true" }, [attIcon("shield")]), String(x.label || x.type || "")]), el("td", { text: x.studio || "—" }),
        el("td", { cls: "n", text: int(x.count) }), el("td", { text: x.latest ? new Date(x.latest).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—" })]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "No security events in this range." })]));
    var tl = clear($("#tSecLatest"));
    (r.latest || []).slice(0, 100).forEach(function (x) {
      var who = [x.actor_name ? "by " + x.actor_name : "", x.subject_name || ""].filter(Boolean).join(" · ");
      tl.appendChild(el("tr", null, [el("td", { text: x.at ? new Date(x.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—" }), el("td", { text: x.label || x.type || "" }),
        el("td", { text: x.studio || "—" }), el("td", { text: who || "—" })]));
    });
    if (!tl.firstChild) tl.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "Nothing yet." })]));
  }
  /* ---------------- r27 (0277): the HQ team - roles, two-step, sessions, monitoring ----------------
     hq_staff_list (staff.read) gives HQ people only - never studio data. Owners add people / change roles; Owner +
     Security pause people and sign them out everywhere. The database checks every one of these again. */
  var ACT_WORDS = { "hq.view": "looked", "hq.staff.invite": "added someone to HQ", "hq.staff.role": "changed a role", "hq.staff.suspend": "paused someone",
    "hq.staff.restore": "gave access back", "hq.staff.remove": "removed someone", "hq.staff.signout": "signed someone out", "hq.staff.settings": "changed sign-in rules",
    "hq.studio.suspend": "paused a studio", "hq.studio.reactivate": "restarted a studio", "hq.studio.identity": "changed a studio name / link",
    "hq.subscription.activate": "activated a plan", "hq.payment.record": "recorded a payment", "hq.payment.void": "voided a payment",
    "hq.trial.extend": "extended a trial", "hq.mfa.reset": "reset someone's two-step", "hq.sales_request.status": "answered a plan request",
    "hq.sales_enquiry.update": "answered a sales enquiry", "hq.suggestion.update": "marked a suggestion", "hq.reveal": "showed a masked detail", "hq.credit.grant": "added a studio credit" };
  function actWord(a) { return ACT_WORDS[a] || String(a || "").replace(/^hq\./, "").replace(/[._]/g, " "); }
  function when(v) { return v ? ago2(v) : "never"; }
  function teamAction(text, cls, fn) { var b = el("button", { cls: "btn sm" + (cls ? " " + cls : ""), type: "button", text: text }); b.addEventListener("click", fn); return b; }
  function teamRow(x) {
    var st = S ? S.statusOf(x.status) : [x.status, ""];
    var nm = el("div", { cls: "nm" }, [el("span", { text: x.name ? x.name + " · " + x.email : x.email }),
      el("span", { cls: "pill", text: x.role_label || x.role }), el("span", { cls: "pill " + st[1], text: st[0] }),
      el("span", { cls: "pill " + (x.has_2step ? "ok" : "warn"), text: x.has_2step ? "2-step on" : "2-step not set up" }),
      x.is_me ? el("span", { cls: "pill", text: "you" }) : null]);
    var meta = [x.has_login ? "Last sign-in " + when(x.last_sign_in_at) : "No login yet", "Last active in HQ " + when(x.last_active_at),
      int(x.views_7d) + " page view" + (num(x.views_7d) === 1 ? "" : "s") + " this week"];
    var body = el("div", { cls: "sp-1" }, [nm, el("div", { cls: "meta", text: meta.join(" · ") })]);
    if (x.status === "invited") body.appendChild(el("div", { cls: "meta", text: "Added " + date(x.invited_at || x.added_at) + (x.invited_by ? " by " + x.invited_by : "") + " - waiting for their first sign-in." }));
    if (x.status === "suspended") body.appendChild(el("div", { cls: "meta", text: "Paused " + date(x.suspended_at) + (x.suspended_by ? " by " + x.suspended_by : "") + (x.suspend_reason ? " - " + x.suspend_reason : "") }));
    var sessions = Array.isArray(x.sessions) ? x.sessions : [], recent = Array.isArray(x.recent) ? x.recent : [];
    var sl = el("ul", { cls: "mini" });
    sessions.forEach(function (z) {
      var tset = TEAM_SET || {}, ends = sessionEnds(z.since, z.hq_last || z.seen, tset.idle_minutes, tset.max_hours);
      sl.appendChild(el("li", null, [el("span", null, [z.sid ? el("span", { cls: "m", text: z.sid + " " }) : null, (S ? S.deviceName(z.device) : "Device") + (z.current ? " (this one)" : "")]),
        el("span", { cls: "muted", text: [z.ip, "started " + date(z.since) + " " + hhmm(z.since), "seen " + when(z.seen), ends ? (Date.parse(ends) < Date.now() ? "expired" : "ends " + hhmm(ends)) : ""].filter(Boolean).join(" · ") })]));
    });
    if (!sl.firstChild) sl.appendChild(el("li", { cls: "muted", text: "Not signed in anywhere right now." }));
    var rl = el("ul", { cls: "mini" });
    recent.forEach(function (z) { rl.appendChild(el("li", null, [el("span", { text: actWord(z.action) }), el("span", { cls: "muted", text: when(z.at) })])); });
    if (!rl.firstChild) rl.appendChild(el("li", { cls: "muted", text: "No changes made in HQ." }));
    body.appendChild(el("details", null, [el("summary", { text: int(sessions.length) + " sign-in" + (sessions.length === 1 ? "" : "s") + " · recent HQ changes" }),
      el("div", { cls: "sub2" }, [el("div", null, [el("h4", { text: "Signed in on" }), sl]), el("div", null, [el("h4", { text: "Recent changes in HQ" }), rl])])]));
    var acts = el("div", { cls: "acts" }), mine = ME && ME.role;
    if (!x.is_me && x.status !== "removed") {
      if (can("staff.manage")) {
        var sel = el("select", { "aria-label": "Role for " + x.email });
        (S ? S.ROLES : []).forEach(function (r) { var o = el("option", { value: r.key, text: r.label }); if (r.key === x.role) o.selected = true; sel.appendChild(o); });
        sel.addEventListener("change", function () {
          var to = sel.value;
          if (!window.confirm("Change " + x.email + " from " + (x.role_label || x.role) + " to " + (S ? S.roleLabel(to) : to) + "? They and every Owner get an e-mail.")) { sel.value = x.role; return; }
          call("hq_staff_set_role", { p_email: x.email, p_role: to }).then(function () { okMsg("Role changed."); loadTeam().catch(showErr); }).catch(function (e) { sel.value = x.role; showErr(e); });
        });
        acts.appendChild(sel);
      }
      if (can("staff.suspend") && (x.role !== "owner" || mine === "owner")) {
        if (x.status === "active" || x.status === "invited") acts.appendChild(teamAction("Pause access", "danger", function () {
          var why = ask("Pause Helm HQ access for " + x.email + " now? They are signed out of HQ everywhere. Reason (kept in the HQ log):", "");
          if (!why) return;
          call("hq_staff_suspend", { p_email: x.email, p_reason: why }).then(function () { okMsg("Access paused."); loadTeam().catch(showErr); }).catch(showErr);
        }));
        if (sessions.length) acts.appendChild(teamAction("Sign out everywhere", "", function () {
          if (!window.confirm("Sign " + x.email + " out of Helm HQ on every device? They can sign in again.")) return;
          call("hq_staff_signout", { p_email: x.email }).then(function (r) { okMsg("Signed out of " + int(r && r.sessions_ended) + " sign-in(s)."); loadTeam().catch(showErr); }).catch(showErr);
        }));
      }
      if (can("staff.manage") && x.status === "suspended") acts.appendChild(teamAction("Give access back", "", function () {
        call("hq_staff_restore", { p_email: x.email }).then(function () { okMsg("Access given back."); loadTeam().catch(showErr); }).catch(showErr);
      }));
      if (can("staff.manage")) acts.appendChild(teamAction("Remove", "danger", function () {
        if (!window.confirm("Remove " + x.email + " from Helm HQ? Their HQ access ends now. Nothing is deleted - you can add them again later.")) return;
        var why = ask("Reason (optional, kept in the HQ log):", ""); if (why == null) return;
        call("hq_staff_remove", { p_email: x.email, p_reason: why || null }).then(function () { okMsg("Removed from HQ."); loadTeam().catch(showErr); }).catch(showErr);
      }));
    }
    if (x.status === "removed" && can("staff.manage")) acts.appendChild(teamAction("Add back", "", function () {
      call("hq_staff_restore", { p_email: x.email }).then(function () { okMsg("Added back - they get access at their next sign-in."); loadTeam().catch(showErr); }).catch(showErr);
    }));
    return el("div", { cls: "tm" }, [el("div", { cls: "av", "aria-hidden": "true", text: S ? S.initials(x.name, x.email) : "?" }), body, acts]);
  }
  function paintMatrix() {
    var t = clear($("#tmMatrix")); if (!S) return;
    t.appendChild(el("thead", null, [el("tr", null, [el("th", { text: "Can…" })].concat(S.ROLES.map(function (r) { return el("th", { text: r.label, title: r.blurb }); })))]));
    var tb = el("tbody");
    S.MATRIX.forEach(function (row) {
      tb.appendChild(el("tr", null, [el("td", { text: row[0] })].concat(S.ROLES.map(function (r) {
        var y = S.can(S.ROLE_PERMS[r.key], row[1]); return el("td", { cls: y ? "yes" : "no", text: y ? "✓" : "–", "aria-label": y ? "yes" : "no" }); }))));
    });
    t.appendChild(tb);
  }
  function paintTeamSettings(st) {
    $("#tmIdle").value = st.idle_minutes || 30; $("#tmMax").value = st.max_hours || 12; $("#tmReauth").value = st.reauth_minutes || 15;
    $("#tmIpOn").checked = !!st.ip_allowlist_on; $("#tmIps").value = (Array.isArray(st.ip_allowlist) ? st.ip_allowlist : []).join("\n");
    var ro = !can("staff.manage");
    ["#tmIdle", "#tmMax", "#tmReauth", "#tmIpOn", "#tmIps"].forEach(function (id) { $(id).disabled = ro; });
    $("#tmSetState").textContent = "Two-step: always required for everyone." + (st.my_ip ? " Your network right now: " + st.my_ip + "." : "") + (ro ? " Only an Owner can change these." : "");
  }
  var TEAM_SET = null;
  async function loadTeam() {
    var r = await call("hq_staff_list", { p_include_removed: !!$("#tmRemoved").checked }); r = r && !Array.isArray(r) ? r : {};
    TEAM_SET = r.settings || null;
    var list = Array.isArray(r.staff) ? r.staff : [], box = clear($("#tmList"));
    var on = list.filter(function (x) { return x.status === "active"; }).length, inv = list.filter(function (x) { return x.status === "invited"; }).length;
    $("#tmCount").textContent = int(on) + " active" + (inv ? " · " + int(inv) + " invited" : "");
    list.forEach(function (x) { box.appendChild(teamRow(x)); });
    if (!list.length) box.appendChild(el("div", { cls: "empty", text: "Nobody on the HQ team yet." }));
    paintTeamSettings(r.settings || {});
    paintMatrix();
    var ev = clear($("#tmEvents"));
    (Array.isArray(r.events) ? r.events : []).forEach(function (e) {
      if (e.kind === "settings") { ev.appendChild(el("li", null, [el("span", { text: "Sign-in rules changed" + (e.by ? " by " + e.by : "") }), el("span", { cls: "muted", text: when(e.at) })])); return; }
      var w = (S && S.EVENT_WORDS[e.kind]) || e.kind;
      ev.appendChild(el("li", null, [el("span", { cls: "m", text: e.email + " - " + w + (e.role && (e.kind === "invited" || e.kind === "role_changed") ? " (" + (S ? S.roleLabel(e.role) : e.role) + ")" : "") }),
        el("span", { cls: "muted", text: (e.by && e.by !== e.email ? "by " + e.by + " · " : "") + when(e.at) })]));
    });
    if (!ev.firstChild) ev.appendChild(el("li", { cls: "empty", text: "No changes yet." }));
  }
  function addTeamMember() {
    var e = String($("#tmEmail").value || "").trim().toLowerCase(), role = $("#tmRole").value, nm = String($("#tmName").value || "").trim();
    if (!/^[^\s@<>",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(e)) { showErr(new Error("Enter a valid e-mail address.")); return; }
    if (!window.confirm("Add " + e + " to Helm HQ as " + (S ? S.roleLabel(role) : role) + "?\n\nThey sign in with exactly this address, set up two-step, and see only what this role allows. They and every Owner get an e-mail.")) return;
    call("hq_staff_invite", { p_email: e, p_role: role, p_name: nm || null }).then(function () {
      $("#tmEmail").value = ""; $("#tmName").value = "";
      okMsg("Added. " + e + " can now sign in at helm.events/login with this address and set up two-step."); loadTeam().catch(showErr);
    }).catch(showErr);
  }
  /* ---- r39 (0288): Google-only sign-in for Helm staff (Owner). The database decides; this shows the switch + checklist ---- */
  var sgData = null;
  async function loadGoogleOnly() {
    var card = $("#sgCard"); if (!card) return;
    if (!ME || ME.role !== "owner") { card.hidden = true; return; }
    var r;
    try { r = await call("hq_staff_google_only"); } catch (e) { card.hidden = true; return; }   // a database without 0288
    sgData = r && typeof r === "object" ? r : {}; card.hidden = false;
    var on = !!sgData.on, st = $("#sgState");
    st.textContent = on ? "On" : "Off"; st.className = "pill" + (on ? " ok" : "");
    $("#sgMe").textContent = "Your sign-in right now: " + (sgData.my_session_google ? "Google \u2713" : "not Google - sign out and use Continue with Google first")
      + (sgData.changed_at ? " · last changed " + when(sgData.changed_at) + (sgData.changed_by ? " by " + sgData.changed_by : "") : "");
    var ul = clear($("#sgList"));
    (Array.isArray(sgData.staff) ? sgData.staff : []).forEach(function (x) {
      var p = !x.on_domain ? ["not on helm.events - loses HQ while this is on", "bad"] : x.google_ok ? ["Google \u2713" + (x.google_last_sign_in ? " · " + when(x.google_last_sign_in) : ""), "ok"]
        : !x.has_login ? ["no login yet - first sign-in with Google", "warn"] : ["has not signed in with Google yet", "warn"];
      ul.appendChild(el("li", null, [el("span", { cls: "m", text: x.email + " (" + (S ? S.roleLabel(x.role) : x.role) + ")" }), el("span", { cls: "pill " + p[1], text: p[0] })]));
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "Nobody on the HQ team yet." }));
    $("#btnSgOn").hidden = on; $("#btnSgOff").hidden = !on; $("#sgTestedRow").hidden = on;
    $("#btnSgOn").disabled = !sgData.my_session_google;
  }
  function setGoogleOnly(want) {
    if (want) {
      if (!$("#sgTested").checked) { showErr(new Error("Tick \u201cI have tested Google sign-in\u201d first.")); return; }
      var notYet = (sgData && Array.isArray(sgData.staff) ? sgData.staff : []).filter(function (x) { return !x.google_ok; }).map(function (x) { return x.email; });
      if (!window.confirm("Turn on Google-only sign-in for Helm staff?\n\n" + (notYet.length ? "These HQ people have NOT signed in with Google yet and cannot use HQ until they do: " + notYet.join(", ") + "\n\n" : "")
        + "Passwords, magic links and reset links stop working for helm.events addresses. You will be asked for a fresh two-step code.")) return;
    } else if (!window.confirm("Turn off Google-only sign-in? Helm staff can use a password again.")) return;
    call("hq_set_staff_google_only", { p_on: !!want }).then(function (r) {
      $("#sgTested").checked = false;
      okMsg(r && r.on ? "Google-only sign-in for Helm staff is ON." : "Google-only sign-in for Helm staff is OFF.");
      loadGoogleOnly().catch(showErr); loadTeam().catch(showErr);
    }).catch(showErr);
  }
  function saveTeamSettings() {
    var ips = S ? S.ipList($("#tmIps").value) : [];
    call("hq_set_staff_settings", { p_idle_minutes: Number($("#tmIdle").value) || 30, p_max_hours: Number($("#tmMax").value) || 12,
      p_reauth_minutes: Number($("#tmReauth").value) || 15, p_ip_allowlist_on: $("#tmIpOn").checked, p_ip_allowlist: ips })
      .then(function (st) { paintTeamSettings(st || {}); okMsg("Sign-in rules saved."); }).catch(showErr);
  }

  /* ---------------- staff access (0248): reserved e-mail domains + staff allowlist ---------------- */
  async function loadStaff() {
    var r = await call("hq_staff_access"); r = r && !Array.isArray(r) ? r : {};
    var doms = Array.isArray(r.domains) ? r.domains : [], allow = Array.isArray(r.allowlist) ? r.allowlist : [], acc = Array.isArray(r.accounts) ? r.accounts : [];
    var open = acc.filter(function (a) { return !a.allowlisted && !a.banned_until; }).length;
    $("#stState").textContent = "Reserved: " + (doms.map(function (d) { return d.domain; }).join(", ") || "none") + " · " + int(allow.length) + " allowlisted · "
      + int(acc.length) + " existing login" + (acc.length === 1 ? "" : "s") + " on these domains" + (open ? " (" + int(open) + " not staff — review below)" : "");
    var ul = clear($("#stAllow"));
    allow.forEach(function (a) {
      var right = el("span", { cls: "muted", text: (a.is_platform_admin ? "HQ operator · " : "") + (a.has_login ? "has a login" : "no login yet") + (a.note ? " · " + a.note : "") });
      var li = el("li", null, [el("span", { cls: "m", text: a.email }), right]);
      if (!a.is_platform_admin && can("security.write")) {
        var rm = el("button", { cls: "btn sm danger", type: "button", text: "Remove" });
        rm.addEventListener("click", function () {
          if (!window.confirm("Remove " + a.email + " from the staff allowlist? New logins for it will be refused. An existing login is not deleted or signed out.")) return;
          call("hq_staff_allow_remove", { p_email: a.email }).then(function () { okMsg("Removed from the staff allowlist."); loadStaff().catch(showErr); }).catch(showErr);
        });
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "Nobody yet." }));
    var dl = clear($("#stDomains"));
    doms.forEach(function (d) {
      var li = el("li", null, [el("span", { cls: "m", text: d.domain + (d.include_subdomains ? " (+ sub-domains)" : "") }),
        el("span", { cls: "muted", text: d.builtin ? "Helm’s own domain" : (d.note || "added " + date(d.added_at)) })]);
      if (!d.builtin && can("security.write")) {
        var rm = el("button", { cls: "btn sm danger", type: "button", text: "Remove" });
        rm.addEventListener("click", function () {
          if (!window.confirm("Stop reserving " + d.domain + "? People could sign up with it again.")) return;
          call("hq_reserved_domain_remove", { p_domain: d.domain }).then(function () { okMsg("Domain no longer reserved."); loadStaff().catch(showErr); }).catch(showErr);
        });
        li.appendChild(rm);
      }
      dl.appendChild(li);
    });
    var tb = clear($("#tStAcc"));
    acc.forEach(function (a) {
      var st = a.banned_until ? el("span", { cls: "pill", text: "sign-in off" })
        : a.allowlisted ? el("span", { cls: "pill ok", text: a.is_platform_admin ? "HQ operator" : "staff" })
        : el("span", { cls: "pill warn", text: "not staff — review" });
      tb.appendChild(el("tr", null, [el("td", { cls: "m", text: a.email || "" }), el("td", { text: a.studio ? a.studio + (a.role ? " · " + a.role : "") : "—" }),
        el("td", { text: date(a.created_at) }), el("td", { text: ago(a.last_sign_in_at) }), el("td", null, [st])]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "No logins on reserved domains." })]));
  }
  function addStaff() {
    var e = String($("#stEmail").value || "").trim().toLowerCase(); if (!e) return;
    call("hq_staff_allow_add", { p_email: e, p_note: String($("#stNote").value || "").trim() || null })
      .then(function () { $("#stEmail").value = ""; $("#stNote").value = ""; okMsg("Added to the staff allowlist — this address can now be given a login."); loadStaff().catch(showErr); }).catch(showErr);
  }
  function addDomain() {
    var d = String($("#stDomain").value || "").trim().toLowerCase(); if (!d) return;
    if (!window.confirm("Reserve " + d + " (and its sub-domains)? Nobody outside the staff allowlist will be able to sign up with it.")) return;
    call("hq_reserved_domain_add", { p_domain: d, p_note: String($("#stDomNote").value || "").trim() || null })
      .then(function () { $("#stDomain").value = ""; $("#stDomNote").value = ""; okMsg("Domain reserved."); loadStaff().catch(showErr); }).catch(showErr);
  }

  /* ---------------- r21 (0249): HQ two-step readiness ---------------- */
  async function loadMfaReadiness() {
    var M = window.HelmHqMfa; if (!M || !$("#mfaROps")) return;
    var r = null, ops = null;
    try { r = await call("hq_mfa_readiness"); }
    catch (e) { try { ops = await call("hq_operators"); } catch (e2) { ops = []; } }   // database without 0249
    // r27 (0277): two-step is always required for HQ, whatever the old switch says
    var m = M.model(r ? Object.assign({}, r, { hq_require_mfa: true }) : r, ops, true);
    var st = clear($("#mfaRState")); st.appendChild(el("span", { cls: "pill " + m.state.tone, text: m.state.text }));
    $("#mfaRHint").textContent = m.hint;
    var ul = clear($("#mfaROps"));
    m.lines.forEach(function (x) {
      ul.appendChild(el("li", null, [el("span", { cls: "m", text: x.email + (x.me ? " (you)" : "") }), el("span", { cls: "pill " + x.tone, text: x.label })]));
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "No HQ operators." }));
    var ad = $("#mfaRAdmins"); ad.textContent = m.admins || ""; ad.hidden = !m.admins;
    var b = $("#btnMfaEnroll"); b.hidden = !m.showEnroll || !(window.HelmAuthUI && window.HelmAuthUI.renderEnroll);
  }
  function startMfaEnroll() {
    var box = $("#mfaREnroll"), b = $("#btnMfaEnroll");
    if (!window.HelmAuthUI || !window.HelmAuthUI.renderEnroll) { showErr(new Error("Two-step set-up couldn't load. Reload the page and try again.")); return; }
    b.hidden = true; box.hidden = false;
    window.HelmAuthUI.renderEnroll(box, function () {
      okMsg("Two-step is on for your HQ account. Next time you sign in, Helm asks for the code from your app.");
      setTimeout(function () { box.hidden = true; clear(box); loadMfaReadiness().catch(showErr); }, 1200);
    });
  }

  // r25: hq_overview (always) + hq_metrics (0272; a database without it shows the older tiles and "appears after SQL 0272")
  async function loadOverview() {
    var r = await Promise.all([call("hq_overview"), call("hq_metrics").catch(function () { return null; })]);
    renderOverview(r[0] || {}, r[1] && !Array.isArray(r[1]) && r[1].studios ? r[1] : null);
  }
  async function loadAll() {
    $("#err").hidden = true;
    var jobs = [];
    if (canTab("overview")) jobs.push(loadOverview());
    if (can("plans.read")) jobs.push(loadPlans());
    if (canTab("studios")) jobs.push(loadStudios(0));
    if (canTab("people")) jobs.push(loadUsers(0));
    if (canTab("billing")) jobs.push(loadBilling());
    await Promise.all(jobs);
    if (can("security.read")) loadMfaReadiness().catch(function () {});
  }

  // Who may see HQ, decided BEFORE any hq_* data is requested:
  //   signed out / a sign-in step pending (incl. the two-step code) → sign-in page
  //   not a platform operator                                         → ordinary 404
  //   operator without a verified authenticator, or session < aal2    → sign-in page,
  //     which forces set-up / the code (no skip); "unknown" fails closed the same way
  //   operator at aal2                                                → HQ
  // Authenticators are only looked at after is_platform_admin() said yes.
  async function gate() {
    if (!BPStore.auth.pendingUser()) return "login";
    if (BPStore.auth.pendingStep()) return "login";
    var step = BPStore.auth.mfa && BPStore.auth.mfa.operatorStep ? await BPStore.auth.mfa.operatorStep() : "unknown";
    if (step === "none") return "notfound";
    if (step === "enroll") return "enroll";   // r27: set two-step up right here (no trip to the sign-in page)
    return step === "ok" ? "hq" : "login";
  }

  function on(id, ev, fn) { var n = $(id); if (n) n.addEventListener(ev, fn); }
  // pure (r118): "hq_me does not exist on this database" (older than 0277) vs any other failure (exported for tests)
  function meMissing(e) { return /PGRST202|does not exist|schema cache|not find the function/i.test(String((e && (e.message || e.code)) || "")); }
  // r28: ?demo=1 ONLY on this computer (localhost / 127.0.0.1 / [::1]): hq-demo.js swaps BPStore for made-up data held in
  // the browser. Any other host ignores ?demo=1 (and hq-demo.js is never deployed - .vercelignore). Pure - exported for tests.
  function demoWanted(host, search) {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(host || "")) && /(^|[?&])demo=1(&|$)/.test(String(search || "").replace(/^\?/, ""));
  }
  function loadDemo() {
    return new Promise(function (resolve, reject) {
      var sc = document.createElement("script"); sc.src = "hq-demo.js?v=1";
      sc.addEventListener("load", resolve); sc.addEventListener("error", reject); document.head.appendChild(sc);
    });
  }
  async function start() {
    var dm = false; try { dm = demoWanted(location.hostname, location.search); } catch (e) { dm = false; }
    if (dm) {
      // r42: demo = made-up data ONLY. If the demo did not install itself, stop here - never fall through to the real
      // database under a "demo" address (the real HQ is reached only without ?demo=1, through sign-in + the HQ gates).
      try { await loadDemo(); } catch (e) {}
      if (!window.HelmHqDemo || !window.BPStore || window.BPStore.__helmHqDemo !== true) { notFound(); return; }
      var db = $("#demoBar"); if (db) db.hidden = false;
    }
    try { await BPStore.init(); } catch (e) { notFound(); return; }
    if (!BPStore.auth.enabled()) { notFound(); return; }
    BPStore.auth.required();
    var g = "notfound";
    try { g = await gate(); } catch (e) { g = "notfound"; }
    if ((g === "enroll" || g === "hq") && await needsGoogle().catch(function () { return false; })) { on("#blkOut", "click", function () { signOutThen("login.html"); }); googleGate(); return; }
    if (g === "enroll") { on("#blkOut", "click", function () { signOutThen("login.html"); }); enrollGate(); return; }
    if (g === "login") { location.replace("login.html"); return; }
    if (g !== "hq") { notFound(); return; }
    on("#blkOut", "click", function () { signOutThen("login.html"); });
    // r27 (0277): who am I in HQ? (a database without 0277: null -> everything shown as before; the gates still decide)
    // r118 (F-15): hq_me missing (a database without 0277) = null, as before; hq_me FAILING = fail closed - no buttons
    // drawn for a role we don't know: "couldn't load" + Retry (an ended / idle sign-in -> "Session expired")
    try { ME = await BPStore.hq("hq_me"); } catch (e) {
      ME = null;
      var mk = S ? S.errKind(e) : null;
      if (mk === "idle" || mk === "expired" || mk === "ended") { sessionOver(S.friendly(mk)); return; }
      if (!meMissing(e)) { loadFailed(e); return; }
    }
    if (ME && typeof ME !== "object") ME = null;
    if (ME && ME.status === "suspended") { blocked("Your Helm HQ access is paused", "An HQ owner or the security team paused your access. Ask the HQ owner if you think this is a mistake.", null); return; }
    if (ME && ME.needs_2step && !ME.has_2step) { enrollGate(); return; }
    if (ME && ME.needs_2step) { blocked("Set up two-step first", "Helm HQ needs two-step verification for everyone, on every visit. Sign in again and set it up - it takes a minute.", "Set up two-step", "login.html"); return; }
    applyPerms(); paintPrivacyRules();
    // r37: Helm HQ runs on India time - default ranges and the paid-on date are IST days (same as the server's hq_today)
    var tIst = istDay(Date.now()), mIst = tIst.slice(0, 8) + "01", pIst = istDay(Date.now() - 30 * 864e5);
    $("#bFrom").value = mIst; $("#bTo").value = tIst; $("#aFrom").value = pIst; $("#aTo").value = tIst; $("#rPaidOn").value = tIst;
    try { await loadAll(); }
    catch (e) { loadFailed(e); return; }   // r118 (F-07): the gate already said HQ - a failed first load gets Retry, not the 404 page
    document.title = "Helm HQ";
    $("#who").textContent = (BPStore.auth.user() && BPStore.auth.user().email) || "";
    $("#vLoading").hidden = true; $("#vApp").hidden = false;
    // r24 (0271): the e-mail alerts link straight to Requests (hq#requests)
    var first = TABS.filter(canTab)[0] || "overview";
    var askTab = hashTab(location.hash);
    if (location.hash === "#requests" && canTab("requests")) { showTab("requests"); reqTab("plan"); loadRequestsTab(); }
    else if (askTab && askTab !== "requests" && canTab(askTab)) showTab(askTab);   // r118 (F-08): /hq#studios etc. (its loaders run once the tabs are wired, below)
    else { showTab(canTab("overview") ? "overview" : first); if (first === "requests" && !canTab("overview")) loadRequestsTab(); if (!canTab("overview") && first === "staff") { loadTeam().catch(showErr); loadStaff().catch(showErr); loadGoogleOnly().catch(showErr); } }
    startWatch();

    TABS.forEach(function (t) { on("#tab-" + t, "click", function () {
      showTab(t);
      if (t === "activity") { loadAudit().catch(showErr); loadSecurity().catch(showErr); }
      if (t === "settings" && can("billing.read")) loadSettings().catch(showErr);
      if (t === "requests") loadRequestsTab();
      if (t === "staff") { loadTeam().catch(showErr); loadStaff().catch(showErr); loadGoogleOnly().catch(showErr); }
    }); });
    if (askTab && askTab !== "requests" && canTab(askTab)) { var tb0 = $("#tab-" + askTab); if (tb0) tb0.click(); }
    on("#btnRefresh", "click", function () { loadAll().catch(showErr); if (!$("#pane-requests").hidden) loadRequestsTab(); if (!$("#pane-staff").hidden) { loadTeam().catch(showErr); loadStaff().catch(showErr); loadGoogleOnly().catch(showErr); }
      if (!$("#pane-activity").hidden) { loadAudit().catch(showErr); loadSecurity().catch(showErr); } if (!$("#pane-settings").hidden && can("billing.read")) loadSettings().catch(showErr); });
    // r28: phone menu + bottom bar + Settings shortcuts
    on("#btnMenu", "click", function () { var va = $("#vApp"); navOpen(!(va && va.classList && va.classList.contains("nav-open"))); });
    on("#navScrim", "click", function () { navOpen(false); });
    on("#btnGoAlerts", "click", function () { showTab("requests"); reqTab("alerts"); loadRequestsTab(); });
    on("#btnPlanNew", "click", function () { openPlanEditor(null); });
    on("#btnPlanCancel", "click", function () { $("#planEditor").hidden = true; });
    loadMySession();
    on("#btnGoLog", "click", function () { var b = $("#tab-activity"); if (b) b.click(); });
    buildBnav(); watchTables();
    // r28 (owner): money display (US dollars by default; this browser only)
    $("#dispCur").value = DISP.cur; $("#dispRate").value = DISP.rate;
    on("#btnDisp", "click", function () {
      var c = $("#dispCur").value === "ORIG" ? "ORIG" : "USD", r = Number($("#dispRate").value);
      if (!(r >= 1 && r <= 1000)) { showErr(new Error("Rupees per US dollar: a number from 1 to 1000")); return; }
      DISP.cur = c; DISP.rate = r;
      try { localStorage.setItem("helm.hq.dispCur", c); localStorage.setItem("helm.hq.inrPerUsd", String(r)); } catch (e) {}
      okMsg("Money display saved for this browser."); loadAll().catch(showErr);
    });
    // r25: studio drawer, Requests tabs, search
    on("#btnDClose", "click", closeDrawer);
    on("#studioScrim", "click", closeDrawer);
    DTABS.forEach(function (t) { on("#dt-" + t, "click", function () { dTab(t); }); });
    RTABS.forEach(function (t) { on("#rt-" + t, "click", function () { reqTab(t); }); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!$("#gResults").hidden) { closeSearch(); return; }
      var va = $("#vApp"); if (va && va.classList && va.classList.contains("nav-open")) { navOpen(false); return; }
      if (!$("#studioDrawer").hidden) closeDrawer();
    });
    on("#gSearch", "input", function () { clearTimeout(gTimer); gTimer = setTimeout(runSearch, 250); });
    on("#gSearch", "focus", function () { if (String($("#gSearch").value || "").trim().length >= 2) runSearch(); });
    document.addEventListener("click", function (e) { if (e.target && e.target.closest && !e.target.closest(".gs")) closeSearch(); });
    on("#btnMfaEnroll", "click", startMfaEnroll);
    on("#btnOut", "click", function () { Promise.resolve(BPStore.auth.signOut && BPStore.auth.signOut()).finally(function () { location.replace("login.html"); }); });
    on("#btnBill", "click", function () { loadBilling().catch(showErr); });
    on("#btnCsv", "click", exportCsv);
    on("#btnRecord", "click", recordPayment);
    on("#btnReq", "click", function () { loadRequests().catch(showErr); });
    on("#fReq", "change", function () { loadRequests().catch(showErr); });
    on("#btnSe", "click", function () { loadSales().catch(showErr); });
    on("#fSe", "change", function () { loadSales().catch(showErr); });
    on("#btnSg", "click", function () { loadSuggestions().catch(showErr); });
    on("#fSg", "change", function () { loadSuggestions().catch(showErr); });
    on("#btnSeSet", "click", saveSalesSettings);
    on("#btnSettings", "click", saveSettings);
    on("#btnPlan", "click", savePlan);
    on("#btnCheckout", "click", saveCheckoutSettings);
    on("#btnPlanCo", "click", savePlanCheckout);
    on("#pcCur", "change", function () { var p = planCo.filter(function (x) { return x.code === $("#pcCode").value; })[0]; if (p) fillPlanCoForm(p, $("#pcCur").value); });
    on("#btnTax", "click", saveTaxRule);
    on("#btnAudit", "click", function () { loadAudit().catch(showErr); loadSecurity().catch(showErr); });
    on("#aWrites", "change", function () { loadAudit().catch(showErr); });
    on("#btnTmAdd", "click", addTeamMember);
    on("#btnTmSet", "click", saveTeamSettings);
    on("#btnSgOn", "click", function () { setGoogleOnly(true); });
    on("#btnSgOff", "click", function () { setGoogleOnly(false); });
    on("#tmRemoved", "change", function () { loadTeam().catch(showErr); });
    on("#btnStAdd", "click", addStaff);
    on("#btnStDom", "click", addDomain);
    on("#btnRefreshBilling", "click", function () { if (!window.confirm(REFRESH_PAST_DUE_CONFIRM)) return; call("hq_refresh_billing_status").then(function (r) { okMsg("Billing status refreshed: " + int(r && r.past_due_set) + " now past due, " + int(r && r.reminders_queued) + " reminders queued."); refreshAfterWrite(null); }).catch(showErr); });
    on("#fStatus", "change", function () { loadStudios(0).catch(showErr); });
    on("#qStudios", "input", function () { clearTimeout(sTimer); sTimer = setTimeout(function () { loadStudios(0).catch(showErr); }, 300); });
    on("#qUsers", "input", function () { clearTimeout(uTimer); uTimer = setTimeout(function () { loadUsers(0).catch(showErr); }, 300); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
