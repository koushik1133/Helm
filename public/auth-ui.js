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
    if (e && e.code && /^(mfa_invalid|mfa_locked|bad_current_password|current_password_required|captcha_|rate_limited)/.test(e.code)) return e.message;
    if (e && e.message && /^(Use at least|Include at least|Enter the 6-digit|Choose a password)/.test(e.message)) return e.message;
    return UI && UI.friendlyError ? UI.friendlyError(e, { action: action }) : ((e && e.message) || "Something went wrong.");
  }
  // Only ever an image data: URI from Supabase — never a remote URL.
  // Supabase returns the TOTP QR as raw "<svg…>", as "data:image/svg+xml;utf-8,<svg…>" (unescaped,
  // so a "#" in a colour cuts the URI short), or already URL-encoded. Normalise every form to a
  // properly encoded SVG data URI; only SVG/PNG images are ever rendered.
  function safeQr(src) {
    src = String(src || "").trim();
    var svg = null;
    if (/^<svg[\s>]/i.test(src)) svg = src;
    var m = /^data:image\/svg\+xml(?:;charset=utf-?8|;utf-?8)?,(.*)$/is.exec(src);
    if (m) { svg = m[1]; if (/^%3Csvg/i.test(svg)) { try { svg = decodeURIComponent(svg); } catch (e) { return ""; } } }
    if (svg !== null) return /^<svg[\s>]/i.test(svg) ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg) : "";
    if (/^data:image\/(svg\+xml|png);base64,[A-Za-z0-9+\/=]+$/i.test(src)) return src;
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
      /* notice cards (MFA nudge, profile nudge, read-only) — one stack above the theme toggle, max 2 visible (1 on phones), priority-ordered */
      ".hau-notes{position:fixed;right:20px;bottom:80px;z-index:900;display:flex;flex-direction:column;gap:10px;width:min(400px,calc(100vw - 32px));pointer-events:none;font-family:inherit}",
      ".hau-note{pointer-events:auto;display:grid;grid-template-columns:36px 1fr auto;gap:12px;align-items:start;padding:14px 12px 14px 14px;background:var(--panel,#fff);color:var(--ink,#141b2e);border:1px solid var(--line,#e5e0ea);border-radius:14px;box-shadow:0 1px 2px rgba(20,27,46,.06),0 12px 32px rgba(20,27,46,.14);font-size:14px;line-height:1.45;animation:hauIn .22s ease-out}",
      "html[data-theme=dark] .hau-note{box-shadow:0 1px 2px rgba(0,0,0,.5),0 16px 40px rgba(0,0,0,.6)}",
      ".hau-note[hidden]{display:none}",
      ".hau-note-ic{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--accent-soft,#f1ebfd);color:var(--accent,#6d28d9)}",
      ".hau-note.warn .hau-note-ic{background:rgba(232,145,45,.14);color:var(--warn-text,#8f5f00)}",
      ".hau-note-ic svg{width:18px;height:18px}.hau-note-x svg{width:16px;height:16px}",
      ".hau-note-t{margin:0;font-weight:650;font-size:14px;color:var(--ink,#141b2e)}",
      ".hau-note-b{margin:2px 0 0;color:var(--ink-2,#4a5673);font-size:13px}",
      ".hau-note-a{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".hau-note .hau-btn{min-height:32px;padding:0 12px;font-size:13px;border-radius:8px}",
      ".hau-note .hau-btn.ghost{background:transparent;border-color:transparent;color:var(--ink-2,#4a5673)}",
      ".hau-note .hau-btn.ghost:hover{background:var(--accent-soft,#f4f2fb)}",
      ".hau-note-x{width:28px;height:28px;min-height:0;min-width:0;border:0;background:transparent;color:var(--ink-3,#7a7590);border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}",
      ".hau-note-x:hover{background:var(--accent-soft,#f4f2fb);color:var(--ink,#141b2e)}",
      ".hau-note button:focus-visible{outline:2px solid var(--accent,#6d28d9);outline-offset:2px}",
      "@keyframes hauIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion:reduce){.hau-note{animation:none}}",
      "@media (max-width:600px){.hau-notes{left:16px;right:16px;bottom:72px;width:auto}}",
      /* profile form (Account panel + /profile-setup) — page tokens first, BPUI tokens as fallback */
      ".hpf{--hpf-ink:var(--ink,var(--bpui-ink,#141b2e));--hpf-ink2:var(--ink-3,var(--bpui-ink-2,#4a5673));--hpf-line:var(--line-strong,var(--bpui-line,#86808f));--hpf-bg:var(--panel-2,var(--bpui-bg,#fff));--hpf-acc:var(--accent,var(--bpui-accent,#6d28d9));--hpf-soft:var(--accent-soft,var(--bpui-soft,#f4f2fb));--hpf-bad:var(--bpui-danger,#b91c1c);color:var(--hpf-ink);font-size:15px}",
      "html[data-theme=dark] .hpf{--hpf-bad:#f87171}",
      ".hpf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0 14px}",
      ".hpf-f{margin:0 0 14px;min-width:0}",
      ".hpf .hpf-l{display:block;font-size:13px;font-weight:600;text-transform:none;letter-spacing:normal;color:var(--hpf-ink);margin:0 0 5px}",
      ".hpf .hpf-l .hpf-opt{font-weight:400;color:var(--hpf-ink2)}",
      ".hpf .hpf-i{display:block;width:100%;box-sizing:border-box;min-height:44px;height:auto;padding:9px 12px;border:1px solid var(--hpf-line);border-radius:10px;background:var(--hpf-bg);color:var(--hpf-ink);font:inherit;font-size:16px;letter-spacing:normal;margin:0}",
      ".hpf .hpf-i:focus{outline:none;border-color:var(--hpf-acc);box-shadow:0 0 0 3px var(--hpf-soft)}",
      ".hpf .hpf-i[aria-invalid=true]{border-color:var(--hpf-bad)}",
      ".hpf-pre{display:flex;align-items:stretch}",
      ".hpf-pre>span{display:flex;align-items:center;padding:0 12px;border:1px solid var(--hpf-line);border-right:0;border-radius:10px 0 0 10px;background:var(--hpf-soft);color:var(--hpf-ink);font-weight:600;font-size:15px}",
      ".hpf .hpf-pre>.hpf-i{border-radius:0 10px 10px 0;flex:1;min-width:0}",
      ".hpf .hpf-h{margin:5px 0 0;font-size:12.5px;color:var(--hpf-ink2)}",
      ".hpf .hpf-e{margin:5px 0 0;font-size:13px;color:var(--hpf-bad);font-weight:600}.hpf .hpf-e:empty{display:none}",
      ".hpf-cbrow{display:flex;align-items:center;gap:8px;margin:-4px 0 14px;font-size:14px;color:var(--hpf-ink)}",
      ".hpf .hpf-cb{width:18px!important;height:18px!important;min-height:0!important;padding:0!important;margin:0!important;accent-color:var(--hpf-acc);flex:0 0 auto}",
      ".hpf .hpf-cbrow label{margin:0;font-size:14px;font-weight:500;text-transform:none;letter-spacing:normal;color:var(--hpf-ink)}",
      ".hpf-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px;padding:0;list-style:none}.hpf-chips:empty{display:none}",
      ".hpf-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 4px 3px 10px;border-radius:999px;background:var(--hpf-soft);color:var(--hpf-ink);font-size:13.5px;border:1px solid var(--hpf-line);max-width:100%}",
      ".hpf-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".hpf-x{width:26px;height:26px;border:0;border-radius:50%;background:transparent;color:var(--hpf-ink2);font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0}",
      ".hpf-x:hover,.hpf-x:focus-visible{background:var(--hpf-line);color:var(--hpf-ink)}",
      ".hpf-photo{display:flex;align-items:center;gap:14px;margin:0 0 16px;flex-wrap:wrap}",
      ".hpf-av{position:relative;width:76px;height:76px;border-radius:50%;overflow:hidden;flex:0 0 auto;background:linear-gradient(135deg,#6d28d9,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:26px}",
      ".hpf-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}",
      ".hpf-photo .hau-row{margin:0}",
      ".hpf .hpf-file{position:absolute!important;width:1px!important;height:1px!important;min-height:0!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;border:0!important}",
      ".hpf-prog{margin:0 0 16px}.hpf-bar{height:6px;border-radius:99px;background:var(--hpf-soft);overflow:hidden;border:1px solid var(--hpf-line)}",
      ".hpf-bar>span{display:block;height:100%;width:0;background:var(--hpf-acc);transition:width .25s}",
      "@media (prefers-reduced-motion:reduce){.hpf-bar>span{transition:none}}",
      ".hpf .hpf-alert{border-radius:10px;padding:10px 13px;font-size:13.5px;margin:0 0 14px;background:#fdecec;color:#b42318;border:1px solid #f5c6c6}",
      ".hpf .hpf-alert.ok{background:#e7f6ee;color:#0f7a43;border-color:#b6e3ca}",
      "html[data-theme=dark] .hpf-alert{background:#3a1414;color:#fecaca;border-color:#7f1d1d}html[data-theme=dark] .hpf-alert.ok{background:#0f2a1c;color:#a7f3d0;border-color:#14532d}",
      ".hpf .hpf-legend{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hpf-ink2);margin:6px 0 10px;padding:0}",
      ".hpf fieldset{border:0;margin:0;padding:0;min-width:0}",
    ].join("\n");
    // CSP: style-src-elem has no 'unsafe-inline' — inject via a constructable stylesheet.
    if (typeof window.__helmAdoptCss === "function") window.__helmAdoptCss(doc, s.textContent);
    else {
      try {
        var sh = new CSSStyleSheet(); sh.replaceSync(s.textContent);
        doc.adoptedStyleSheets = Array.prototype.slice.call(doc.adoptedStyleSheets).concat([sh]);
      } catch (e) { (doc.head || doc.documentElement).appendChild(s); }
    }
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
      var inp = el("input", { id: "hauEnrollCode", class: "hau-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}", "aria-describedby": "hauEnrollHint" });
      var hint = el("p", { id: "hauEnrollHint", class: "hau-muted", style: "margin:4px 0 0" }, "Codes refresh every 30 seconds — enter the newest one.");
      var er = el("div", { class: "hau-err", role: "alert" });
      var go = el("button", { type: "button", class: "hau-btn primary" }, "Verify & turn on");
      box.appendChild(lab); box.appendChild(inp); box.appendChild(hint); box.appendChild(er);
      var row = el("div", { class: "hau-row" }); row.appendChild(go); box.appendChild(row);
      var submit = function () {
        if (go.disabled) return;
        er.textContent = ""; go.disabled = true;
        S().auth.mfa.verify(r.factorId, inp.value).then(function () {
          box.textContent = ""; box.appendChild(el("p", { class: "hau-ok" }, "Two-step verification is on. You'll be asked for a code each time you sign in."));
          if (onDone) onDone();
        }, function (e) {
          er.textContent = errText(e, "verify the code"); inp.focus();
          // too many wrong codes: keep the button off until the pause is over
          if (e && e.code === "mfa_locked" && e.retryAfter > 0) setTimeout(function () { go.disabled = false; er.textContent = ""; }, e.retryAfter * 1000);
          else go.disabled = false;
        });
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
  // openAccount({focus:"profile"}) opens the panel scrolled to "Your profile"
  function openAccount(opts) {
    var focusProfile = !!(opts && opts.focus === "profile");
    css(); closePanel();
    var st = S(); var u = st && st.auth.user(); if (!u) return;
    panel = el("div", { class: "bpui-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "hauTitle", id: "hauAccount" });
    var card = el("div", { class: "bpui-dialog", style: "width:min(520px,100%)" });
    panel.appendChild(card);
    card.appendChild(el("h2", { id: "hauTitle" }, "Your account"));
    card.appendChild(el("p", { class: "hau-muted" }, "Signed in as " + (u.email || "")));
    if (st.profile && st.profile.validate && st.profile.update) card.appendChild(profileSection(st, focusProfile));
    else if (st.profile && st.profile.setMine) card.appendChild(displayNameSection(st));

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
    if (st.auth.hasPassword && !st.auth.hasPassword()) {
      // Google-only account: no Helm password exists, so there's nothing to change here
      pw.appendChild(el("p", { class: "hau-muted" }, "You sign in with Google, so there's no Helm password. Manage your password in your Google account."));
      card.appendChild(pw);
    } else {
      pw.appendChild(el("p", { class: "hau-muted" }, "You'll confirm your current password, then choose a new one (at least 12 characters with a lowercase letter, an uppercase letter, a number and a symbol). Other devices are signed out."));
      var pwRow = el("div", { class: "hau-row" });
      var pwLink = el("a", { class: "hau-btn", href: "/reset-password?mode=change", style: "display:inline-flex;align-items:center;text-decoration:none" }, "Change password");
      pwRow.appendChild(pwLink); pw.appendChild(pwRow); card.appendChild(pw);
    }

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
    if (!focusProfile) setTimeout(function () { try { close.focus(); } catch (e) {} }, 30);

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
  // "Display name" — the name teammates see in chat (set_my_display_name, 0034)
  function displayNameSection(st) {
    var sec = el("div", { class: "hau-sec" });
    sec.appendChild(el("h3", null, "Display name"));
    sec.appendChild(el("p", { class: "hau-muted" }, "The name your teammates see in chat and around Helm."));
    var inp = el("input", { id: "hauDisplayName", type: "text", class: "hau-input", maxlength: "80", autocomplete: "name", "aria-label": "Display name", placeholder: "e.g. Ananya Rao", style: "font-size:15px;letter-spacing:normal" });
    var save = el("button", { type: "button", class: "hau-btn primary" }, "Save name");
    var msg = el("div", { class: "hau-err", role: "status", "aria-live": "polite" });
    var row = el("div", { class: "hau-row" }); row.appendChild(save);
    sec.appendChild(inp); sec.appendChild(row); sec.appendChild(msg);
    var current = "";
    Promise.resolve(st.profile.mine()).then(function (p) { current = (p && p.full_name) || ""; if (!inp.value) inp.value = current; }, function () {});
    var submit = function () {
      msg.className = "hau-err"; msg.textContent = "";
      var bad = st.profile.problem(inp.value); if (bad) { msg.textContent = bad; inp.focus(); return; }
      save.disabled = true;
      st.profile.setMine(inp.value).then(function (saved) {
        current = saved || st.profile.clean(inp.value); inp.value = current;
        msg.className = "hau-ok"; msg.textContent = "Saved. Teammates will see “" + current + "”.";
      }, function (e) { msg.textContent = errText(e, "save your display name"); }).then(function () { save.disabled = false; });
    };
    save.addEventListener("click", submit);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    return sec;
  }
  /* ------------------------------------------- member profile form (0041) ----
     Shared by the Account panel ("Your profile") and /profile-setup. Rules + upload
     live in BPStore.profile (validate / complete / update / uploadAvatar); this only
     draws the form. Everything user-supplied is set with textContent / value. */
  var PF_FIELD_OF = [["That mobile number", "phone"], ["Mobile number", "phone"], ["WhatsApp", "whatsapp"], ["Full name", "full_name"],
    ["Job title", "job_title"], ["Department", "department"], ["City", "city"], ["Emergency contact name", "emergency_contact_name"],
    ["Emergency contact number", "emergency_contact_phone"], ["A skill", "skills"], ["Each skill", "skills"], ["Skills", "skills"], ["Add up to", "skills"]];
  function pfFieldOf(msg) {
    msg = String(msg || "");
    for (var i = 0; i < PF_FIELD_OF.length; i++) if (msg.indexOf(PF_FIELD_OF[i][0]) === 0) return PF_FIELD_OF[i][1];
    return null;
  }
  function pfServerText(e) {
    var c = (e && e.code) || "", m = String((e && e.message) || "");
    if (c === "profile_invalid" || c === "avatar_invalid" || c === "avatar_unavailable") return m;
    if (/set your own password first/i.test(m)) return "Set your own password first, then try again.";
    // 0041 raises plain-language messages (22023 bad value, 23505 mobile already used)
    if ((c === "22023" || c === "23505") && m && m.length < 240 && !/[<>{}]|violates|constraint|column/i.test(m)) return m;
    return null;
  }
  function initials(name, email) {
    var s = String(name || "").trim() || String(email || "").split("@")[0] || "";
    var parts = s.split(/\s+/).filter(Boolean);
    var out = parts.length > 1 ? parts[0].charAt(0) + parts[parts.length - 1].charAt(0) : s.slice(0, 2);
    return (out || "?").toUpperCase();
  }
  // profileForm(BPStore, {mode:"setup"|"panel", idp, profile, email, submitLabel, onSaved(row)})
  //   → {el, focusFirst()}
  function profileForm(st, opts) {
    css();
    var o = opts || {}, P = o.profile || {}, idp = o.idp || "hpf", setup = o.mode === "setup";
    var hadName = !!String(P.full_name || "").trim(), hadPhone = !!P.phone;
    var vopts = setup ? { requireName: true, requirePhone: true } : { requireName: hadName, requirePhone: hadPhone };
    var lim = (st.profile && st.profile.limits) || { text: 80, skill: 40, skills: 20 };
    var form = el("form", { class: "hpf", novalidate: "" });
    if (o.labelledBy) form.setAttribute("aria-labelledby", o.labelledBy);
    var alertBox = el("div", { class: "hpf-alert", role: "alert", tabindex: "-1" }); alertBox.hidden = true;
    form.appendChild(alertBox);
    var inputs = {}, errs = {}, touched = {}, busy = false;

    // progress
    var prog = el("div", { class: "hpf-prog" });
    var bar = el("div", { class: "hpf-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-labelledby": idp + "_progtxt" });
    var fill = el("span"); bar.appendChild(fill);
    var progTxt = el("p", { class: "hpf-h", id: idp + "_progtxt", style: "margin:0 0 6px" });
    prog.appendChild(progTxt); prog.appendChild(bar); form.appendChild(prog);

    // photo
    var avPath = P.avatar_path || null;
    var photo = el("div", { class: "hpf-photo" });
    var av = el("div", { class: "hpf-av" });
    var avIni = el("span", { "aria-hidden": "true" }, initials(P.full_name, P.email || o.email));
    var avImg = el("img", { alt: "Your profile photo" }); avImg.hidden = true;
    av.appendChild(avIni); av.appendChild(avImg);
    var photoCol = el("div", { style: "min-width:0;flex:1" });
    photoCol.appendChild(el("div", { class: "hpf-l", id: idp + "_photo_l" }, "Photo"));
    var fileIn = el("input", { type: "file", id: idp + "_photo", class: "hpf-file", accept: "image/png,image/jpeg,image/webp", tabindex: "-1", "aria-hidden": "true" });
    var upBtn = el("button", { type: "button", class: "hau-btn", "aria-describedby": idp + "_photo_h" });
    var rmBtn = el("button", { type: "button", class: "hau-btn danger" }, "Remove photo");
    var photoRow = el("div", { class: "hau-row" }); photoRow.appendChild(upBtn); photoRow.appendChild(rmBtn);
    var photoMsg = el("p", { class: "hpf-h", id: idp + "_photo_h", role: "status", "aria-live": "polite" }, "PNG, JPEG or WebP — cropped to a square.");
    photoCol.appendChild(photoRow); photoCol.appendChild(photoMsg); photoCol.appendChild(fileIn);
    photo.appendChild(av); photo.appendChild(photoCol); form.appendChild(photo);
    function showPhoto() {
      upBtn.textContent = avPath ? "Change photo" : "Add photo";
      rmBtn.hidden = !avPath;
      if (!avPath) { avImg.hidden = true; avImg.removeAttribute("src"); avIni.hidden = false; return; }
      var want = avPath;
      Promise.resolve(st.profile.avatarUrl ? st.profile.avatarUrl(want) : null).then(function (u) {
        if (want !== avPath) return;
        if (u) { avImg.src = u; avImg.hidden = false; avIni.hidden = true; } else { avImg.hidden = true; avIni.hidden = false; }
      }, function () {});
    }
    avImg.addEventListener("error", function () { avImg.hidden = true; avIni.hidden = false; });
    upBtn.addEventListener("click", function () { if (!busy) fileIn.click(); });
    fileIn.addEventListener("change", function () {
      var f = fileIn.files && fileIn.files[0]; fileIn.value = "";
      if (!f || busy) return;
      busy = true; upBtn.disabled = true; rmBtn.disabled = true; photoMsg.style.color = ""; photoMsg.textContent = "Uploading your photo…";
      st.profile.uploadAvatar(f).then(function (path) {
        avPath = path; showPhoto(); photoMsg.textContent = "Photo saved."; progress();
      }, function (e) {
        photoMsg.style.color = "var(--hpf-bad)";
        photoMsg.textContent = pfServerText(e) || errText(e, "upload your photo");
      }).then(function () { busy = false; upBtn.disabled = false; rmBtn.disabled = false; try { upBtn.focus(); } catch (x) {} });
    });
    rmBtn.addEventListener("click", function () {
      if (busy) return;
      busy = true; upBtn.disabled = true; rmBtn.disabled = true; photoMsg.style.color = "";
      st.profile.removeAvatar().then(function () { avPath = null; showPhoto(); photoMsg.textContent = "Photo removed."; progress(); },
        function (e) { photoMsg.style.color = "var(--hpf-bad)"; photoMsg.textContent = pfServerText(e) || errText(e, "remove your photo"); })
        .then(function () { busy = false; upBtn.disabled = false; rmBtn.disabled = false; try { upBtn.focus(); } catch (x) {} });
    });
    showPhoto();

    // one labelled input with its hint + error line
    function field(parent, key, label, a) {
      a = a || {};
      var id = idp + "_" + key;
      var wrap = el("div", { class: "hpf-f" });
      var lab = el("label", { for: id, class: "hpf-l" }, label);
      if (a.req) lab.appendChild(el("span", { class: "req-star", "aria-hidden": "true" }, " *"));
      else if (a.optional) lab.appendChild(el("span", { class: "hpf-opt" }, " (optional)"));
      var inp = el("input", { id: id, class: "hpf-i", type: a.type || "text", autocomplete: a.ac || "off", maxlength: String(a.max || lim.text) });
      if (a.ph) inp.setAttribute("placeholder", a.ph);
      if (a.inputmode) inp.setAttribute("inputmode", a.inputmode);
      if (a.type === "tel") inp.setAttribute("data-no-country", "1");   // our own +91 prefix, not the global country picker
      if (a.req) inp.setAttribute("aria-required", "true");
      var desc = [];
      var hint = a.hint ? el("p", { class: "hpf-h", id: id + "_h" }, a.hint) : null;
      if (hint) desc.push(hint.id);
      var er = el("p", { class: "hpf-e", id: id + "_e" }); desc.push(er.id);
      inp.setAttribute("aria-describedby", desc.join(" "));
      wrap.appendChild(lab);
      if (a.prefix) { var pre = el("div", { class: "hpf-pre" }); pre.appendChild(el("span", { "aria-hidden": "true" }, a.prefix)); pre.appendChild(inp); wrap.appendChild(pre); }
      else wrap.appendChild(inp);
      if (hint) wrap.appendChild(hint);
      wrap.appendChild(er);
      parent.appendChild(wrap);
      inp.value = a.value == null ? "" : String(a.value);
      inputs[key] = inp; errs[key] = er;
      inp.addEventListener("blur", function () { touched[key] = true; check(key); });
      inp.addEventListener("input", function () { if (inp.getAttribute("aria-invalid") === "true") check(key); progress(); });
      return { wrap: wrap, input: inp };
    }

    // --- about you
    var fsA = el("fieldset"); fsA.appendChild(el("legend", { class: "hpf-legend" }, "About you"));
    field(fsA, "full_name", "Full name", { req: setup || hadName, ac: "name", ph: "e.g. Ananya Rao", value: P.full_name });
    var mob = field(fsA, "phone", "Mobile number", { req: setup || hadPhone, type: "tel", ac: "tel-national", inputmode: "tel", max: 16, prefix: "+91",
      ph: "98765 43210", hint: "Indian mobile: 10 digits starting with 6, 7, 8 or 9.", value: P.phone ? st.profile.localMobile(P.phone) : "" });
    mob.input.setAttribute("aria-label", "Mobile number, after +91");
    var cbRow = el("div", { class: "hpf-cbrow" });
    var same = el("input", { type: "checkbox", id: idp + "_wa_same", class: "hpf-cb" });
    same.checked = P.whatsapp_same !== false;
    cbRow.appendChild(same); cbRow.appendChild(el("label", { for: idp + "_wa_same" }, "WhatsApp is on the same number"));
    fsA.appendChild(cbRow);
    var wa = field(fsA, "whatsapp", "WhatsApp number", { type: "tel", ac: "off", inputmode: "tel", max: 16, prefix: "+91", optional: true, ph: "98765 43210",
      value: P.whatsapp_same === false && P.whatsapp ? st.profile.localMobile(P.whatsapp) : "" });
    wa.input.setAttribute("aria-label", "WhatsApp number, after +91");
    function syncWa() { wa.wrap.hidden = same.checked; if (same.checked) setErr("whatsapp", ""); }
    same.addEventListener("change", function () { syncWa(); progress(); if (!same.checked) try { wa.input.focus(); } catch (x) {} });
    syncWa();
    form.appendChild(fsA);

    // --- work
    var fsW = el("fieldset"); fsW.appendChild(el("legend", { class: "hpf-legend" }, "Work"));
    var gW = el("div", { class: "hpf-grid" });
    field(gW, "job_title", "Job title", { ac: "organization-title", ph: "e.g. Event coordinator", optional: true, value: P.job_title });
    field(gW, "department", "Department", { ph: "e.g. Operations", optional: true, value: P.department });
    fsW.appendChild(gW);
    // skills: chips (Enter or comma adds, × removes, Backspace on an empty box removes the last)
    var skills = Array.isArray(P.skills) ? P.skills.slice(0, lim.skills) : [];
    var skWrap = el("div", { class: "hpf-f" });
    skWrap.appendChild(el("label", { for: idp + "_skills", class: "hpf-l" }, "Skills"));
    skWrap.lastChild.appendChild(el("span", { class: "hpf-opt" }, " (optional)"));
    var chips = el("ul", { class: "hpf-chips", "aria-label": "Your skills" });
    var skIn = el("input", { id: idp + "_skills", class: "hpf-i", type: "text", autocomplete: "off", maxlength: String(lim.skill), placeholder: "e.g. Lighting, Décor — press Enter to add",
      "aria-describedby": idp + "_skills_h " + idp + "_skills_e" });
    var skHint = el("p", { class: "hpf-h", id: idp + "_skills_h" });
    var skErr = el("p", { class: "hpf-e", id: idp + "_skills_e" });
    skWrap.appendChild(chips); skWrap.appendChild(skIn); skWrap.appendChild(skHint); skWrap.appendChild(skErr);
    inputs.skills = skIn; errs.skills = skErr;
    fsW.appendChild(skWrap);
    function renderChips() {
      while (chips.firstChild) chips.removeChild(chips.firstChild);
      skills.forEach(function (s, i) {
        var li = el("li", { class: "hpf-chip" });
        li.appendChild(el("span", { title: s }, s));
        var x = el("button", { type: "button", class: "hpf-x", "aria-label": "Remove skill " + s }, "×");
        x.addEventListener("click", function () {
          skills.splice(i, 1); renderChips(); progress();
          skHint.textContent = "Removed " + s + ". " + skills.length + " of " + lim.skills + " skills.";
          try { skIn.focus(); } catch (e) {}
        });
        li.appendChild(x); chips.appendChild(li);
      });
      if (!skHint.textContent || /of \d+ skills\.$/.test(skHint.textContent)) skHint.textContent = "Press Enter or type a comma to add. " + skills.length + " of " + lim.skills + " skills.";
    }
    function addSkills(raw) {
      var parts = String(raw || "").split(",").map(function (s) { return s.replace(/\s+/g, " ").trim(); }).filter(Boolean);
      if (!parts.length) return true;
      var r = st.profile.validate({ skills: skills.concat(parts) });
      if (r.errors.skills) { setErr("skills", r.errors.skills); return false; }
      setErr("skills", "");
      var before = skills.length; skills = r.clean.skills; renderChips(); progress();
      skHint.textContent = (skills.length > before ? "Added. " : "Already added. ") + skills.length + " of " + lim.skills + " skills.";
      return true;
    }
    skIn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (addSkills(skIn.value)) skIn.value = ""; }
      else if (e.key === "Backspace" && !skIn.value && skills.length) { var gone = skills.pop(); renderChips(); progress(); skHint.textContent = "Removed " + gone + ". " + skills.length + " of " + lim.skills + " skills."; }
    });
    skIn.addEventListener("input", function () {
      if (skIn.value.indexOf(",") < 0) return;
      var parts = skIn.value.split(","), last = parts.pop();
      if (addSkills(parts.join(","))) skIn.value = last;
    });
    skIn.addEventListener("blur", function () { if (skIn.value.trim() && addSkills(skIn.value)) skIn.value = ""; });
    renderChips();
    field(fsW, "city", "City", { ac: "address-level2", ph: "e.g. Hyderabad", optional: true, value: P.city });
    form.appendChild(fsW);

    // --- emergency contact
    var fsE = el("fieldset"); fsE.appendChild(el("legend", { class: "hpf-legend" }, "Emergency contact"));
    var gE = el("div", { class: "hpf-grid" });
    field(gE, "emergency_contact_name", "Name", { ac: "off", ph: "e.g. Ravi Rao", optional: true, value: P.emergency_contact_name });
    inputs.emergency_contact_name.setAttribute("aria-label", "Emergency contact name");
    field(gE, "emergency_contact_phone", "Phone number", { type: "tel", ac: "off", inputmode: "tel", max: 18, optional: true, ph: "98765 43210 or +44 …",
      hint: "Indian mobile, or an international number starting with +.", value: P.emergency_contact_phone ? st.profile.localMobile(P.emergency_contact_phone) : "" });
    inputs.emergency_contact_phone.setAttribute("aria-label", "Emergency contact phone number");
    fsE.appendChild(gE);
    fsE.appendChild(el("p", { class: "hpf-h", style: "margin:-6px 0 14px" }, "Only you and your studio admins can see your mobile, WhatsApp, city and emergency contact."));
    form.appendChild(fsE);

    var row = el("div", { class: "hau-row", style: "margin-top:4px" });
    var save = el("button", { type: "submit", class: setup ? "btn primary hpf-save" : "hau-btn primary" }, o.submitLabel || "Save");
    row.appendChild(save); form.appendChild(row);

    function collect() {
      var pending = skIn.value.trim() ? skills.concat([skIn.value]) : skills;
      return {
        full_name: inputs.full_name.value, phone: inputs.phone.value, whatsapp_same: same.checked,
        whatsapp: same.checked ? null : inputs.whatsapp.value, job_title: inputs.job_title.value, department: inputs.department.value,
        skills: pending, city: inputs.city.value, emergency_contact_name: inputs.emergency_contact_name.value,
        emergency_contact_phone: inputs.emergency_contact_phone.value,
      };
    }
    function setErr(key, msg) {
      var inp = inputs[key], er = errs[key]; if (!inp || !er) return;
      er.textContent = msg || "";
      if (msg) inp.setAttribute("aria-invalid", "true"); else inp.removeAttribute("aria-invalid");
    }
    function check(key) {
      var r = st.profile.validate(collect(), vopts);
      setErr(key, r.errors[key] || "");
      return !r.errors[key];
    }
    var ORDER = ["full_name", "phone", "whatsapp", "job_title", "department", "skills", "city", "emergency_contact_name", "emergency_contact_phone"];
    function progress() {
      var f = collect(), n = 0;
      if (avPath) n++;
      if (String(f.full_name).trim()) n++;
      var hasPhone = !!String(f.phone).trim(); if (hasPhone) n++;
      if (f.whatsapp_same ? hasPhone : String(f.whatsapp || "").trim()) n++;
      ["job_title", "department", "city", "emergency_contact_name", "emergency_contact_phone"].forEach(function (k) { if (String(f[k] || "").trim()) n++; });
      if (skills.length) n++;
      var pct = Math.round(n * 10);
      fill.style.width = pct + "%"; bar.setAttribute("aria-valuenow", String(pct));
      var need = [];
      if (!String(f.full_name).trim()) need.push("full name");
      if (!hasPhone) need.push("mobile number");
      progTxt.textContent = n + " of 10 details added" + (need.length ? " · still needed: " + need.join(" and ") : (setup ? " · ready to save" : ""));
    }
    function showAlert(msg, ok) {
      alertBox.className = "hpf-alert" + (ok ? " ok" : "");
      alertBox.textContent = msg || ""; alertBox.hidden = !msg;
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (busy) return;
      showAlert("");
      var fields = collect();
      var r = st.profile.validate(fields, vopts);
      ORDER.forEach(function (k) { setErr(k, r.errors[k] || ""); });
      if (!r.ok) {
        var first = ORDER.filter(function (k) { return r.errors[k]; })[0];
        showAlert(Object.keys(r.errors).length > 1 ? "Please fix the highlighted fields." : r.errors[first]);
        try { inputs[first].focus(); } catch (x) {}
        return;
      }
      busy = true; save.disabled = true; var label = save.textContent; save.textContent = "Saving…";
      var p = setup ? st.profile.complete(fields) : st.profile.update(fields, vopts);
      p.then(function (row) {
        if (row && typeof row === "object") {
          hadName = !!String(row.full_name || "").trim(); hadPhone = !!row.phone;
          if (!setup) vopts = { requireName: hadName, requirePhone: hadPhone };
          if (!skIn.value.trim() || !setup) skIn.value = "";
          if (Array.isArray(row.skills)) { skills = row.skills.slice(); renderChips(); }
          avIni.textContent = initials(row.full_name, row.email || o.email);
        }
        progress();
        if (!setup) showAlert("Profile saved.", true);
        if (o.onSaved) o.onSaved(row || null);
      }, function (err) {
        var msg = pfServerText(err), key = msg ? pfFieldOf(msg) : null;
        if (err && err.fields) { ORDER.forEach(function (k) { setErr(k, err.fields[k] || ""); }); key = err.field || key; }
        else if (key) setErr(key, msg);
        showAlert(msg || errText(err, "save your profile"));
        try { (key && inputs[key] ? inputs[key] : alertBox).focus(); } catch (x) {}
      }).then(function () { busy = false; save.disabled = false; save.textContent = label; });
    });
    progress();
    return {
      el: form,
      focusFirst: function () {
        var k = !String(inputs.full_name.value).trim() ? "full_name" : (!String(inputs.phone.value).trim() ? "phone" : "full_name");
        setTimeout(function () { try { inputs[k].focus(); } catch (e) {} }, 30);
      },
    };
  }
  // "Your profile" (Account panel) — falls back to the display-name section without 0041
  function profileSection(st, focusIt) {
    var sec = el("div", { class: "hau-sec", id: "hauProfile" });
    sec.appendChild(el("h3", { id: "hauProfileTitle" }, "Your profile"));
    var body = el("div", null); body.appendChild(el("p", { class: "hau-muted" }, "Loading…"));
    sec.appendChild(body);
    Promise.resolve(st.profile.mine()).then(function (p) {
      if (!p || !("complete" in p)) { sec.replaceWith(displayNameSection(st)); return; }   // 0041 not installed
      body.textContent = "";
      body.appendChild(el("p", { class: "hau-muted" }, "Teammates see your name, job title, department and photo."));
      if (!p.complete) body.appendChild(el("p", { class: "hau-muted", style: "font-weight:600" }, "Add your full name and mobile number to complete your profile."));
      var u = st.auth.user() || {};
      var f = profileForm(st, { mode: "panel", idp: "hap", profile: p, email: u.email, labelledBy: "hauProfileTitle", submitLabel: "Save profile",
        onSaved: function (row) { if (row && row.complete) hideProfileBanner(); } });
      body.appendChild(f.el);
      if (focusIt) { try { sec.scrollIntoView({ block: "start" }); } catch (e) {} f.focusFirst(); }
    }, function (e) {
      body.textContent = "";
      body.appendChild(el("p", { class: "hau-err" }, errText(e, "load your profile")));
    });
    return sec;
  }

  /* ------------------------------- notice cards: one stack for every nudge */
  var NOTE_ICONS = {
    shield: [["path", { d: "M12 3l7 3v5c0 4.5-3 8.3-7 9.5-4-1.2-7-5-7-9.5V6l7-3z" }], ["path", { d: "M9.5 12l1.8 1.8L15 10" }]],
    user: [["circle", { cx: "12", cy: "8", r: "3.5" }], ["path", { d: "M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" }]],
    lock: [["rect", { x: "5", y: "11", width: "14", height: "9", rx: "2" }], ["path", { d: "M8 11V8a4 4 0 018 0v3" }]],
    x: [["path", { d: "M6 6l12 12M18 6L6 18" }]]
  };
  var notes = []; var noteHost = null; var NOTE_MAX = 2;
  function svgIcon(name) {
    var ns = "http://www.w3.org/2000/svg", s = doc.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.8"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
    (NOTE_ICONS[name] || []).forEach(function (spec) {
      var c = doc.createElementNS(ns, spec[0]); Object.keys(spec[1]).forEach(function (k) { c.setAttribute(k, spec[1][k]); }); s.appendChild(c);
    });
    return s;
  }
  function layoutNotes() {
    notes.sort(function (a, b) { return a.priority - b.priority; });
    var max = NOTE_MAX; try { if (global.matchMedia && global.matchMedia("(max-width:600px)").matches) max = 1; } catch (e) {}
    notes.forEach(function (n, i) { n.node.hidden = i >= max; if (noteHost) noteHost.appendChild(n.node); });
  }
  // showNote({id, priority (lower = more important), icon, tone, title, body, primary:{label,onClick}, secondary:{label,onClick}, onDismiss, dismissLabel})
  function showNote(o) {
    if (!doc.body || notes.some(function (n) { return n.id === o.id; })) return null;
    css();
    if (!noteHost || !noteHost.isConnected) { noteHost = el("div", { class: "hau-notes", "aria-label": "Notices" }); doc.body.appendChild(noteHost); }
    var card = el("div", { class: "hau-note" + (o.tone ? " " + o.tone : ""), id: o.id, role: o.role || "status", "aria-labelledby": o.id + "T" });
    var ic = el("div", { class: "hau-note-ic" }); ic.appendChild(svgIcon(o.icon)); card.appendChild(ic);
    var mid = el("div", null);
    mid.appendChild(el("p", { class: "hau-note-t", id: o.id + "T" }, o.title));
    if (o.body) mid.appendChild(el("p", { class: "hau-note-b" }, o.body));
    if (o.primary || o.secondary) {
      var acts = el("div", { class: "hau-note-a" });
      if (o.primary) { var p = el("button", { type: "button", class: "hau-btn primary" }, o.primary.label); p.addEventListener("click", o.primary.onClick); acts.appendChild(p); }
      if (o.secondary) { var q = el("button", { type: "button", class: "hau-btn ghost" }, o.secondary.label); q.addEventListener("click", function () { o.secondary.onClick(); hideNote(o.id); }); acts.appendChild(q); }
      mid.appendChild(acts);
    }
    card.appendChild(mid);
    if (o.onDismiss) {
      var x = el("button", { type: "button", class: "hau-note-x", "aria-label": o.dismissLabel || "Dismiss" });
      x.appendChild(svgIcon("x"));
      x.addEventListener("click", function () { o.onDismiss(); hideNote(o.id); });
      card.appendChild(x);
    }
    card.addEventListener("keydown", function (e) { if (e.key === "Escape" && o.onDismiss) { o.onDismiss(); hideNote(o.id); } });
    notes.push({ id: o.id, priority: o.priority || 9, node: card });
    layoutNotes();
    return card;
  }
  function hideNote(id) {
    notes = notes.filter(function (n) { if (n.id === id) { try { n.node.remove(); } catch (e) {} return false; } return true; });
    layoutNotes();
  }
  // per-user snooze for notices without a store-level snooze (localStorage, try/catch)
  function noteSnoozed(key) {
    var st = S(), u = st && st.auth.user(); if (!u) return false;
    try { var o = JSON.parse(localStorage.getItem("helm_note_" + key) || "null"); return !!(o && o.uid === u.id && Number(o.until) > Date.now()); } catch (e) { return false; }
  }
  function snoozeNote(key, days) {
    var st = S(), u = st && st.auth.user(); if (!u) return;
    try { localStorage.setItem("helm_note_" + key, JSON.stringify({ uid: u.id, until: Date.now() + days * 86400000 })); } catch (e) {}
  }

  /* ------------------------------- "Complete your profile" banner (0041) */
  var pBanner = null;
  function hideProfileBanner() { if (pBanner) { hideNote("hauProfileNudge"); pBanner = null; } }
  function pageName() {
    try { return (location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index"; } catch (e) { return ""; }
  }
  function profileNudge() {
    var st = S(); if (!st || !st.auth.user() || !st.profile || !st.profile.status || !st.profile.gateDecision) return;
    var page = pageName(); if (page === "profile-setup") return;
    st.profile.status().then(function (s) {
      if (st.profile.gateDecision(s, page, st.auth.cachedRole ? st.auth.cachedRole() : null) !== "nudge") return;
      if (st.profile.nudgeSnoozed() || pBanner || !doc.body) return;
      css();
      pBanner = showNote({ id: "hauProfileNudge", priority: 3, icon: "user", title: "Complete your profile",
        body: "Add your mobile number so your team can reach you and assign you work.",
        primary: { label: "Complete now", onClick: function () { openAccount({ focus: "profile" }); } },
        secondary: { label: "Later", onClick: function () { st.profile.snoozeNudge(7); pBanner = null; } },
        onDismiss: function () { st.profile.snoozeNudge(7); pBanner = null; }, dismissLabel: "Dismiss — remind me in 7 days" });
    }).catch(function () {});
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
  function hideBanner() { if (banner) { hideNote("hauMfaNudge"); banner = null; } }
  function adminTwoStep() {
    var st = S(); if (!st || !st.auth.user()) return;
    Promise.resolve(st.auth.role()).then(function (role) {
      if (role !== "admin") return;
      return st.auth.mfa.verifiedTotp().then(function (fs) {
        if (fs.length) return;
        if (st.auth.mfa.requiredForAdmins()) return forceEnroll();
        var dismissed = noteSnoozed("mfa");
        if (dismissed || banner) return;
        banner = showNote({ id: "hauMfaNudge", priority: 2, icon: "shield", title: "Turn on two-step verification",
          body: "Admins control every user and setting — protect your studio with a code from your phone.",
          primary: { label: "Set up now", onClick: function () { openAccount(); } },
          secondary: { label: "Later", onClick: function () { snoozeNote("mfa", 3); banner = null; } },
          onDismiss: function () { snoozeNote("mfa", 3); banner = null; }, dismissLabel: "Dismiss — remind me in 3 days" });
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
  /* ------------------------------- Helm subscription (0045): read-only banner + Control Center card */
  var subBanner = null;
  function money2(v, cur) {
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", maximumFractionDigits: 2 }).format(Number(v) || 0); }
    catch (e) { return (cur || "INR") + " " + (Number(v) || 0).toFixed(2); }
  }
  function day(v) { if (!v) return "—"; try { return new Date(v).toLocaleDateString(undefined, { dateStyle: "medium" }); } catch (e) { return String(v); } }
  function subscriptionCard(st, sub) {
    var box = doc.getElementById("subCard"); if (!box) return;
    var body = doc.getElementById("subBody"); if (!body) return;
    if (!sub || !("payments" in sub)) { box.hidden = true; return; }        // admins only (the DB decides)
    css(); box.hidden = false; body.textContent = "";
    var plan = sub.plan || {};
    var line = (plan.name || "No plan yet") + (plan.price_monthly != null ? " · " + money2(plan.price_monthly, plan.currency) + " / month" : "");
    body.appendChild(el("p", { class: "hau-muted", style: "font-weight:600" }, line));
    body.appendChild(el("p", { class: "hau-muted" }, "Status: " + String(sub.status || "not set").replace("_", " ") +
      (sub.current_period_end ? " · current period ends " + day(sub.current_period_end) : "") +
      (sub.trial_ends_at ? " · trial ends " + day(sub.trial_ends_at) : "")));
    var list = el("ul", { class: "hau-list" });
    (sub.payments || []).forEach(function (p) {
      var li = el("li", null, day(p.paid_on) + " · " + money2(p.amount, p.currency) + " · " + (p.invoice_no || "") + (p.voided ? " (void)" : "") + " ");
      var b = el("button", { type: "button", class: "hau-btn" }, "Invoice");
      b.addEventListener("click", function () {
        st.subscription.invoice(p.id).then(function (data) {
          if (global.HelmInvoice && typeof global.HelmInvoice.open === "function") global.HelmInvoice.open(data);
        }).catch(function (e) { try { global.alert(errText(e, "open the invoice")); } catch (x) {} });
      });
      li.appendChild(b); list.appendChild(li);
    });
    if (!list.firstChild) list.appendChild(el("li", null, "No payments recorded yet."));
    body.appendChild(list);
    body.appendChild(el("p", { class: "hau-muted" }, "Billing is managed by Helm. Questions about your plan or an invoice? Contact Helm."));
  }
  var ACC_FIELDS = [["legal_business_name", "Legal business name"], ["gstin", "GSTIN (optional)"], ["country", "Country (2 letters, e.g. IN)"],
    ["state", "State"], ["city", "City"], ["billing_address", "Billing address"], ["website", "Website (https://…)"], ["timezone", "Timezone"],
    ["primary_contact_name", "Primary contact name"], ["primary_contact_email", "Primary contact e-mail"], ["primary_contact_phone", "Primary contact phone (+91…)"],
    ["secondary_contact_name", "Secondary contact name"], ["secondary_contact_email", "Secondary contact e-mail"], ["secondary_contact_phone", "Secondary contact phone"],
    ["billing_contact_email", "Billing e-mail"], ["team_size_band", "Team size (1, 2-5, 6-15, 16-50, 51+)"], ["signup_source", "How did you hear about Helm?"],
    ["business_type", "Business type (wedding, corporate, decor, catering, other)"], ["events_per_month_band", "Events per month (0-2, 3-5, 6-10, 11-20, 21+)"],
    ["preferred_contact_method", "Preferred contact (whatsapp, phone, email)"], ["preferred_language", "Preferred language (e.g. en, hi)"],
    ["is_business", "Registered business? (true / false)"], ["tax_id_type", "Tax ID type (IN_GSTIN, IN_PAN, EU_VAT, UK_VAT, AU_ABN, CA_GST, SG_GST, AE_TRN, US_EIN, OTHER)"],
    ["tax_id", "Tax ID"], ["pan", "PAN (India only)"], ["billing_currency", "Billing currency (e.g. INR, USD)"], ["referred_by", "Referred by"]];
  function accountCard(st) {
    var box = doc.getElementById("accCard"), body = doc.getElementById("accBody");
    if (!box || !body || !st.subscription || !st.subscription.account) return;
    st.subscription.account().then(function (a) {
      if (!a || !a.can_edit) { box.hidden = true; return; }
      css(); box.hidden = false; body.textContent = "";
      var grid = el("div", { class: "hpf-grid" }), inputs = {};
      ACC_FIELDS.forEach(function (f) {
        var w = el("div", { class: "hpf-f" }), id = "acc_" + f[0];
        w.appendChild(el("label", { for: id, class: "hpf-l" }, f[1]));
        var i = el("input", { id: id, class: "hpf-i", type: "text" }); i.value = a[f[0]] == null ? "" : String(a[f[0]]); inputs[f[0]] = i;
        w.appendChild(i); grid.appendChild(w);
      });
      var wrap = el("div", { class: "hpf" }); wrap.appendChild(grid); body.appendChild(wrap);
      var msg = el("div", { class: "hau-muted", role: "status" });
      var save = el("button", { type: "button", class: "hau-btn primary" }, "Save account details");
      save.addEventListener("click", function () {
        var patch = {}; ACC_FIELDS.forEach(function (f) { var v = String(inputs[f[0]].value || "").trim(); if (v !== (a[f[0]] == null ? "" : String(a[f[0]]))) patch[f[0]] = v; });
        save.disabled = true;
        st.subscription.updateAccount(patch).then(function (r) { a = r || a; msg.textContent = "Saved."; },
          function (e) { msg.textContent = errText(e, "save the account details"); }).then(function () { save.disabled = false; });
      });
      body.appendChild(save); body.appendChild(msg);
    }).catch(function () { box.hidden = true; });
  }
  function subscriptionStatus() {
    var st = S(); if (!st || !st.auth.user() || !st.subscription || !st.subscription.mine) return;
    st.subscription.mine().then(function (sub) {
      subscriptionCard(st, sub);
      if (!sub || !sub.read_only || subBanner || !doc.body) return;
      subBanner = showNote({ id: "hauReadOnly", priority: 1, icon: "lock", tone: "warn", title: "Read-only: subscription suspended — contact Helm",
        body: "You can view and export everything, but nothing can be created, changed or deleted until it is reactivated." });
    }).catch(function () {});
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
    profileNudge();
    subscriptionStatus();
    accountCard(S());
  }

  global.HelmAuthUI = {
    mountAppChrome: mountAppChrome,
    openAccount: openAccount,
    mountCaptcha: mountCaptcha,
    renderEnroll: renderEnroll,
    profileForm: profileForm,
    showNote: showNote,
    hideNote: hideNote,
    _safeQr: safeQr,
  };
})(window);
