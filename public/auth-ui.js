/* =========================================================================
   HelmAuthUI — account panel, two-step verification set-up, admin two-step
   banner and the Turnstile CAPTCHA helper (audit Phase 3-4 follow-up).

   Loaded by store-api.js on signed-in staff pages (account button next to every
   "Log out" button) and directly by login.html / reset-password.html (CAPTCHA,
   two-step code). No inline handlers, no external libraries: the QR code is the
   SVG image Supabase returns from mfa.enroll(). Depends on window.BPStore
   (+ window.BPUI for dialogs/toasts when present).
   ========================================================================= */
(function (global) {
  "use strict";
  if (typeof document === "undefined" || global.HelmAuthUI) return;
  var doc = document;
  var S = function () { return global.BPStore; };

  function el(tag, attrs, text) {
    var n = doc.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "style") n.style.cssText = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (text != null) n.textContent = text;
    return n;
  }
  function fmt(ts) {
    if (!ts) return "—";
    try { return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return String(ts); }
  }
  function uaLabel(ua) {
    ua = String(ua || "");
    if (!ua) return "Unknown device";
    var b = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    var o = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    return b + (o ? " on " + o : "");
  }
  function errText(e, action) {
    var UI = global.BPUI;
    if (e && e.code && /^(mfa_invalid|bad_current_password|captcha_|rate_limited)/.test(e.code)) return e.message;
    if (e && e.message && /^(Use at least|Include at least|Enter the 6-digit|Choose a password)/.test(e.message)) return e.message;
    return UI && UI.friendlyError ? UI.friendlyError(e, { action: action }) : ((e && e.message) || "Something went wrong.");
  }
  // Only ever an image data: URI from Supabase — never a remote URL.
  function safeQr(src) {
    src = String(src || "");
    var m = /^data:image\/svg\+xml;utf-?8,(.*)$/i.exec(src);
    if (m) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(m[1]);
    if (/^data:image\/(svg\+xml|png);(charset=utf-8,|base64,)/i.test(src)) return src;
    return "";
  }

  /* ---------------------------------------------------------------- CSS */
  var cssDone = false;
  function css() {
    if (cssDone) return; cssDone = true;
    var s = el("style");
    s.textContent = [
      ".hau-btn{min-height:36px;padding:0 14px;border-radius:9px;border:1px solid var(--bpui-line,#c9c3d3);background:var(--bpui-bg,#fff);color:var(--bpui-ink,#141b2e);font:inherit;font-weight:600;cursor:pointer}",
      ".hau-btn.primary{background:var(--bpui-accent,#6d28d9);border-color:var(--bpui-accent,#6d28d9);color:#fff}",
      ".hau-btn.danger{color:var(--bpui-danger,#b91c1c)}",
      ".hau-btn:disabled{opacity:.6;cursor:default}",
      ".hau-sec{border-top:1px solid var(--bpui-line,#e5e0ea);padding:12px 0 4px;margin-top:8px}",
      ".hau-sec h3{margin:0 0 6px;font-size:15px}",
      ".hau-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}",
      ".hau-muted{color:var(--bpui-ink-2,#4a5673);font-size:13px;margin:0 0 6px}",
      ".hau-err{color:var(--bpui-danger,#b91c1c);font-size:13px;min-height:18px;margin:4px 0}",
      ".hau-ok{color:#0f7a43;font-size:13px;margin:4px 0}",
      ".hau-qr{display:block;width:180px;height:180px;background:#fff;border-radius:8px;padding:6px;margin:6px 0}",
      ".hau-code{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all;background:var(--bpui-soft,#f4f2fb);padding:6px 8px;border-radius:6px}",
      ".hau-input{width:100%;box-sizing:border-box;min-height:40px;padding:8px 10px;border:1px solid var(--bpui-line,#c9c3d3);border-radius:8px;font:inherit;font-size:18px;letter-spacing:.2em}",
      ".hau-list{margin:4px 0 0;padding:0;list-style:none;font-size:13px}",
      ".hau-list li{padding:3px 0;color:var(--bpui-ink-2,#4a5673)}",
      ".hau-banner{position:relative;z-index:50;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:var(--bpui-warn-bg,#fff4d6);color:var(--bpui-warn-ink,#5c3d00);border-bottom:1px solid var(--bpui-warn-line,#e8c26a);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}",
      ".hau-banner b{font-weight:700}.hau-banner .hau-sp{flex:1}",
    ].join("\n");
    (doc.head || doc.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------ CAPTCHA */
  var tsPromise = null;
  function loadTurnstile() {
    if (global.turnstile) return Promise.resolve(true);
    if (tsPromise) return tsPromise;
    tsPromise = new Promise(function (resolve) {
      var s = el("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = function () { resolve(!!global.turnstile); };
      s.onerror = function () { tsPromise = null; resolve(false); };
      (doc.head || doc.documentElement).appendChild(s);
    });
    return tsPromise;
  }
  // Mount a Turnstile widget in `host`. Returns null when CAPTCHA is off
  // (config siteKey empty) — callers then send no token, exactly as before.
  function mountCaptcha(host, opts) {
    var st = S(); if (!st || !st.auth.captcha.enabled() || !host) return null;
    var token = null, wid = null;
    host.hidden = false;
    var ready = loadTurnstile().then(function (ok) {
      if (!ok || !global.turnstile) { host.textContent = "The security check couldn't load. Check your connection (or pause content blockers) and reload the page."; return false; }
      wid = global.turnstile.render(host, {
        sitekey: st.auth.captcha.siteKey(),
        action: (opts && opts.action) || "auth",
        callback: function (t) { token = t; },
        "expired-callback": function () { token = null; },
        "error-callback": function () { token = null; },
      });
      return true;
    });
    return {
      ready: ready,
      token: function () { return token; },
      reset: function () { token = null; try { if (wid !== null && global.turnstile) global.turnstile.reset(wid); } catch (e) {} },
    };
  }

  /* ------------------------------------------------ two-step enrolment */
  // Renders the set-up steps into `box`; calls onDone() once the code verifies.
  function renderEnroll(box, onDone) {
    css();
    box.textContent = "";
    var p = el("p", { class: "hau-muted" }, "Setting up…"); box.appendChild(p);
    S().auth.mfa.enrollTotp().then(function (r) {
      box.textContent = "";
      box.appendChild(el("p", { class: "hau-muted" }, "1. Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…)."));
      var src = safeQr(r.qr);
      if (src) box.appendChild(el("img", { class: "hau-qr", src: src, alt: "QR code for your authenticator app" }));
      box.appendChild(el("p", { class: "hau-muted" }, "Can't scan? Type this key into the app instead:"));
      box.appendChild(el("div", { class: "hau-code" }, r.secret || ""));
      var lab = el("label", { for: "hauEnrollCode", style: "display:block;margin:10px 0 4px;font-weight:600;font-size:14px" }, "2. Enter the 6-digit code the app shows");
      var inp = el("input", { id: "hauEnrollCode", class: "hau-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}" });
      var er = el("div", { class: "hau-err", role: "alert" });
      var go = el("button", { type: "button", class: "hau-btn primary" }, "Verify & turn on");
      box.appendChild(lab); box.appendChild(inp); box.appendChild(er);
      var row = el("div", { class: "hau-row" }); row.appendChild(go); box.appendChild(row);
      var submit = function () {
        er.textContent = ""; go.disabled = true;
        S().auth.mfa.verify(r.factorId, inp.value).then(function () {
          box.textContent = ""; box.appendChild(el("p", { class: "hau-ok" }, "Two-step verification is on. You'll be asked for a code each time you sign in."));
          if (onDone) onDone();
        }, function (e) { er.textContent = errText(e, "verify the code"); go.disabled = false; inp.focus(); });
      };
      go.addEventListener("click", submit);
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      setTimeout(function () { inp.focus(); }, 30);
    }, function (e) {
      box.textContent = ""; box.appendChild(el("p", { class: "hau-err" }, errText(e, "set up two-step verification")));
    });
  }

  /* ----------------------------------------------------- account panel */
  var panel = null;
  function closePanel() { if (panel) { try { panel.remove(); } catch (e) {} panel = null; } }
  function openAccount() {
    css(); closePanel();
    var st = S(); var u = st && st.auth.user(); if (!u) return;
    panel = el("div", { class: "bpui-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "hauTitle", id: "hauAccount" });
    var card = el("div", { class: "bpui-dialog", style: "width:min(520px,100%)" });
    panel.appendChild(card);
    card.appendChild(el("h2", { id: "hauTitle" }, "Your account"));
    card.appendChild(el("p", { class: "hau-muted" }, "Signed in as " + (u.email || "")));

    // sign-in details (my_auth_info — caller's own data only)
    var info = el("div", { class: "hau-sec" });
    info.appendChild(el("h3", null, "Sign-in activity"));
    var infoBody = el("div", null); infoBody.appendChild(el("p", { class: "hau-muted" }, "Loading…"));
    info.appendChild(infoBody); card.appendChild(info);
    var lim = st.auth.sessionLimits.config();
    var limTxt = [];
    if (lim.idleMs > 0) limTxt.push("after " + Math.round(lim.idleMs / 60000) + " minutes without activity");
    if (lim.maxMs > 0) limTxt.push(Math.round(lim.maxMs / 3600000) + " hours after you sign in");
    if (limTxt.length) info.appendChild(el("p", { class: "hau-muted" }, "For security you're signed out " + limTxt.join(", and always ") + "."));

    // password
    var pw = el("div", { class: "hau-sec" });
    pw.appendChild(el("h3", null, "Password"));
    pw.appendChild(el("p", { class: "hau-muted" }, "You'll confirm your current password, then choose a new one (at least 12 characters with a lowercase letter, an uppercase letter, a number and a symbol). Other devices are signed out."));
    var pwRow = el("div", { class: "hau-row" });
    var pwLink = el("a", { class: "hau-btn", href: "/reset-password?mode=change", style: "display:inline-flex;align-items:center;text-decoration:none" }, "Change password");
    pwRow.appendChild(pwLink); pw.appendChild(pwRow); card.appendChild(pw);

    // two-step verification
    var mf = el("div", { class: "hau-sec" });
    mf.appendChild(el("h3", null, "Two-step verification"));
    var mfBody = el("div", null); mfBody.appendChild(el("p", { class: "hau-muted" }, "Loading…"));
    mf.appendChild(mfBody); card.appendChild(mf);

    // other devices
    var dv = el("div", { class: "hau-sec" });
    dv.appendChild(el("h3", null, "Other devices"));
    dv.appendChild(el("p", { class: "hau-muted" }, "Signed in somewhere you don't recognise? Sign out everywhere except this browser, then change your password."));
    var dvMsg = el("div", { class: "hau-err", role: "status" });
    var dvBtn = el("button", { type: "button", class: "hau-btn" }, "Sign out other devices");
    dvBtn.addEventListener("click", function () {
      dvBtn.disabled = true; dvMsg.className = "hau-err"; dvMsg.textContent = "";
      st.auth.signOutOthers().then(function () { dvMsg.className = "hau-ok"; dvMsg.textContent = "Other devices were signed out."; },
        function (e) { dvMsg.textContent = errText(e, "sign out other devices"); }).then(function () { dvBtn.disabled = false; });
    });
    var dvRow = el("div", { class: "hau-row" }); dvRow.appendChild(dvBtn); dv.appendChild(dvRow); dv.appendChild(dvMsg); card.appendChild(dv);

    var foot = el("div", { class: "hau-row", style: "justify-content:flex-end;margin-top:12px" });
    var close = el("button", { type: "button", class: "hau-btn", "data-close": "" }, "Close");
    close.addEventListener("click", closePanel);
    foot.appendChild(close); card.appendChild(foot);
    panel.addEventListener("click", function (e) { if (e.target === panel) closePanel(); });
    panel.addEventListener("keydown", function (e) { if (e.key === "Escape") closePanel(); });
    doc.body.appendChild(panel);
    setTimeout(function () { try { close.focus(); } catch (e) {} }, 30);

    st.auth.myAuthInfo().then(function (d) {
      infoBody.textContent = "";
      if (!d) { infoBody.appendChild(el("p", { class: "hau-muted" }, "Sign-in history isn't available yet.")); return; }
      infoBody.appendChild(el("p", { class: "hau-muted" }, "Last sign-in: " + fmt(d.last_sign_in_at) + " · Account created: " + fmt(d.created_at)));
      var ss = Array.isArray(d.sessions) ? d.sessions : [];
      if (ss.length) {
        infoBody.appendChild(el("p", { class: "hau-muted", style: "margin-top:6px" }, "Signed-in sessions (newest first):"));
        var ul = el("ul", { class: "hau-list" });
        ss.slice(0, 6).forEach(function (s) {
          ul.appendChild(el("li", null, uaLabel(s.user_agent) + (s.ip ? " · " + s.ip : "") + " · since " + fmt(s.created_at) + (s.aal === "aal2" ? " · two-step ✓" : "")));
        });
        infoBody.appendChild(ul);
      }
    }, function () { infoBody.textContent = ""; infoBody.appendChild(el("p", { class: "hau-muted" }, "Couldn't load sign-in activity.")); });

    renderMfaSection(mfBody);
  }
  function renderMfaSection(box) {
    var st = S();
    st.auth.mfa.verifiedTotp().then(function (fs) {
      box.textContent = "";
      if (fs.length) {
        box.appendChild(el("p", { class: "hau-ok" }, "On — you enter a code from your authenticator app when you sign in."));
        var off = el("button", { type: "button", class: "hau-btn danger" }, "Turn off");
        var er = el("div", { class: "hau-err", role: "alert" });
        off.addEventListener("click", function () {
          var ask = global.BPUI && global.BPUI.confirm ? global.BPUI.confirm("Turn off two-step verification? Your account will be protected by your password only.", { title: "Turn off two-step verification", okLabel: "Turn off", danger: true }) : Promise.resolve(global.confirm("Turn off two-step verification?"));
          ask.then(function (yes) {
            if (!yes) return;
            off.disabled = true;
            Promise.all(fs.map(function (f) { return st.auth.mfa.unenroll(f.id); }))
              .then(function () { renderMfaSection(box); }, function (e) { er.textContent = errText(e, "turn off two-step verification"); off.disabled = false; });
          });
        });
        var row = el("div", { class: "hau-row" }); row.appendChild(off); box.appendChild(row); box.appendChild(er);
      } else {
        box.appendChild(el("p", { class: "hau-muted" }, "Off. Turn it on so a stolen password alone can't open your account."));
        var on = el("button", { type: "button", class: "hau-btn primary" }, "Turn on");
        var area = el("div", null);
        on.addEventListener("click", function () { on.hidden = true; renderEnroll(area, function () { hideBanner(); setTimeout(function () { renderMfaSection(box); }, 1500); }); });
        var r2 = el("div", { class: "hau-row" }); r2.appendChild(on); box.appendChild(r2); box.appendChild(area);
      }
    }, function (e) { box.textContent = ""; box.appendChild(el("p", { class: "hau-err" }, errText(e, "load two-step settings"))); });
  }

  /* ------------------------------------------ admin two-step banner/gate */
  var banner = null;
  function hideBanner() { if (banner) { try { banner.remove(); } catch (e) {} banner = null; } }
  function adminTwoStep() {
    var st = S(); if (!st || !st.auth.user()) return;
    Promise.resolve(st.auth.role()).then(function (role) {
      if (role !== "admin") return;
      return st.auth.mfa.verifiedTotp().then(function (fs) {
        if (fs.length) return;
        if (st.auth.mfa.requiredForAdmins()) return forceEnroll();
        var dismissed = false; try { dismissed = sessionStorage.getItem("hau_banner_later") === "1"; } catch (e) {}
        if (dismissed || banner) return;
        css();
        banner = el("div", { class: "hau-banner", role: "region", "aria-label": "Security recommendation" });
        banner.appendChild(el("span", null, "🔐"));
        var t = el("span", null); t.appendChild(el("b", null, "Protect your studio: ")); t.appendChild(doc.createTextNode("admins control every user and setting — turn on two-step verification."));
        banner.appendChild(t); banner.appendChild(el("span", { class: "hau-sp" }));
        var set = el("button", { type: "button", class: "hau-btn primary" }, "Set up now");
        var later = el("button", { type: "button", class: "hau-btn" }, "Later");
        set.addEventListener("click", openAccount);
        later.addEventListener("click", function () { try { sessionStorage.setItem("hau_banner_later", "1"); } catch (e) {} hideBanner(); });
        banner.appendChild(set); banner.appendChild(later);
        doc.body.insertBefore(banner, doc.body.firstChild);
      });
    }).catch(function () {});
  }
  // MFA_REQUIRED_FOR_ADMINS: a blocking set-up screen (no close button).
  function forceEnroll() {
    css();
    if (doc.getElementById("hauForce")) return;
    var ov = el("div", { class: "bpui-overlay", id: "hauForce", role: "dialog", "aria-modal": "true", "aria-labelledby": "hauForceTitle", "data-dismissible": "false" });
    var card = el("div", { class: "bpui-dialog", style: "width:min(480px,100%)" });
    card.appendChild(el("h2", { id: "hauForceTitle" }, "Turn on two-step verification"));
    card.appendChild(el("p", { class: "hau-muted" }, "Your studio requires admins to use two-step verification. Set it up to continue."));
    var area = el("div", null); card.appendChild(area);
    var out = el("button", { type: "button", class: "hau-btn", style: "margin-top:10px" }, "Sign out");
    out.addEventListener("click", function () { S().auth.signOut().then(function () { location.replace("login.html"); }); });
    card.appendChild(out);
    ov.appendChild(card); doc.body.appendChild(ov);
    renderEnroll(area, function () { setTimeout(function () { try { ov.remove(); } catch (e) {} }, 1200); });
  }

  /* ------------------------------------- account button next to Log out */
  function placeAccountButton() {
    var lo = doc.getElementById("logoutBtn");
    if (!lo || !lo.parentNode) return;
    var prev = lo.previousElementSibling;
    if (prev && prev.id === "hauAccountBtn") return;
    var old = doc.getElementById("hauAccountBtn"); if (old) old.remove();
    var b = el("button", { type: "button", id: "hauAccountBtn", title: "Password, two-step verification, sign-in activity" }, "Account");
    b.addEventListener("click", openAccount);
    lo.parentNode.insertBefore(b, lo);
  }
  var chromeMounted = false;
  function mountAppChrome() {
    if (chromeMounted) return; chromeMounted = true;
    placeAccountButton();
    try {
      var pending = false;
      new MutationObserver(function () {
        if (pending) return; pending = true;
        setTimeout(function () { pending = false; placeAccountButton(); }, 50);
      }).observe(doc.body, { childList: true, subtree: true });
    } catch (e) {}
    adminTwoStep();
  }

  global.HelmAuthUI = {
    mountAppChrome: mountAppChrome,
    openAccount: openAccount,
    mountCaptcha: mountCaptcha,
    renderEnroll: renderEnroll,
    _safeQr: safeQr,
  };
})(window);
