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
    // R20 (live QA): sign-in activity in the studio's date style + timezone ("18 Oct 2026, 10:30 am"), not the browser's US style
    try { var S = window.BPStore; if (S && S.fmtStudioDate) { var o = S.fmtStudioDate(ts, { style: "long", time: true }); if (o) return o; } } catch (e) {}
    try { return new Date(ts).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return String(ts); }
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
      ".hau-btn.primary{background:var(--bpui-accent,#047857);border-color:var(--bpui-accent,#047857);color:#fff}",
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
      "@media (max-width:600px){body.hau-notes-pad{padding-bottom:var(--hau-notes-pad,0px)}}",
      ".hau-notes{position:fixed;right:20px;bottom:80px;z-index:900;display:flex;flex-direction:column;gap:10px;width:min(400px,calc(100vw - 32px));pointer-events:none;font-family:inherit}",
      ".hau-note{pointer-events:auto;display:grid;grid-template-columns:36px 1fr auto;gap:12px;align-items:start;padding:14px 12px 14px 14px;background:var(--panel,#fff);color:var(--ink,#141b2e);border:1px solid var(--line,#e5e0ea);border-radius:14px;box-shadow:0 1px 2px rgba(20,27,46,.06),0 12px 32px rgba(20,27,46,.14);font-size:14px;line-height:1.45;animation:hauIn .22s ease-out}",
      "html[data-theme=dark] .hau-note{box-shadow:0 1px 2px rgba(0,0,0,.5),0 16px 40px rgba(0,0,0,.6)}",
      ".hau-note[hidden]{display:none}",
      ".hau-note-ic{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--accent-soft,#e3f4ed);color:var(--accent,#047857)}",
      ".hau-note.warn .hau-note-ic{background:rgba(232,145,45,.14);color:var(--warn-text,#8f5f00)}",
      /* 0058 free-trial notice: urgent at <= 3 days left and once the trial has ended */
      /* compact trial notice: docked bottom-LEFT on desktop so it never covers the bottom-right page actions; stays in the (above-nav) stack on phones */
      ".hau-note.compact{grid-template-columns:28px 1fr auto;gap:8px;padding:8px 8px 8px 10px;font-size:13px}",
      ".hau-note.compact .hau-note-ic{width:28px;height:28px}.hau-note.compact .hau-note-t{font-size:13px}.hau-note.compact .hau-note-a{margin-top:6px}",
      "@media (min-width:601px){.hau-note.dock-left{position:fixed;left:20px;bottom:20px;width:min(340px,calc(100vw - 40px));z-index:900}}",
      ".hau-note.urgent{border-color:rgba(220,38,38,.45);box-shadow:0 0 0 1px rgba(220,38,38,.18),0 12px 32px rgba(20,27,46,.14)}",
      ".hau-note.urgent .hau-note-ic{background:rgba(220,38,38,.12);color:var(--bad,#b91c1c)}",
      "html[data-theme=dark] .hau-note.urgent .hau-note-ic{background:rgba(248,113,113,.16);color:#fca5a5}",
      ".hau-note-ic svg{width:18px;height:18px}.hau-note-x svg{width:16px;height:16px}",
      ".hau-note-t{margin:0;font-weight:650;font-size:14px;color:var(--ink,#141b2e)}",
      ".hau-note-b{margin:2px 0 0;color:var(--ink-2,#4a5673);font-size:13px}",
      ".hau-note-a{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".hau-note .hau-btn{min-height:32px;padding:0 12px;font-size:13px;border-radius:8px}",
      ".hau-note .hau-btn.ghost{background:transparent;border-color:transparent;color:var(--ink-2,#4a5673)}",
      ".hau-note .hau-btn.ghost:hover{background:var(--accent-soft,#f4f2fb)}",
      ".hau-note-x{width:28px;height:28px;min-height:0;min-width:0;border:0;background:transparent;color:var(--ink-3,#7a7590);border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}",
      ".hau-note-x:hover{background:var(--accent-soft,#f4f2fb);color:var(--ink,#141b2e)}",
      ".hau-note button:focus-visible{outline:2px solid var(--accent,#047857);outline-offset:2px}",
      "@keyframes hauIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion:reduce){.hau-note{animation:none}}",
      "@media (max-width:600px){.hau-notes{left:16px;right:16px;bottom:72px;width:auto}}",
      ".hau-notes[hidden]{display:none}",
      /* R20: a page slot ([data-hau-notes-slot], the dashboard) holds "inline" notices in the page flow - never over the KPI tiles */
      ".hau-notes.is-inline{position:static;right:auto;bottom:auto;z-index:auto;width:auto;flex-direction:row;flex-wrap:wrap;pointer-events:auto}",
      ".hau-notes.is-inline .hau-note{flex:1 1 320px;min-width:0;box-shadow:0 1px 2px rgba(20,27,46,.06)}",
      /* profile form (Account panel + /profile-setup) — page tokens first, BPUI tokens as fallback */
      ".hpf{--hpf-ink:var(--ink,var(--bpui-ink,#141b2e));--hpf-ink2:var(--ink-2,var(--bpui-ink-2,#4a5673));--hpf-ink3:var(--ink-3,#6b6577);--hpf-line:var(--line-strong,var(--bpui-line,#86808f));--hpf-line2:var(--line,#e8e3db);--hpf-bg:var(--panel,var(--bpui-bg,#fff));--hpf-bg2:var(--panel-2,#faf8f5);--hpf-acc:var(--accent,var(--bpui-accent,#047857));--hpf-soft:var(--accent-soft,var(--bpui-soft,#f4f2fb));--hpf-bad:var(--bad,var(--bpui-danger,#b91c1c));--hpf-ok:var(--safe-text,#0f7a43);color:var(--hpf-ink);font-size:15px}",
      ".hpf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}",
      "@media (max-width:620px){.hpf-grid{grid-template-columns:minmax(0,1fr)}}",
      ".hpf-grid>.hpf-wide{grid-column:1/-1}",
      ".hpf-f{margin:0 0 16px;min-width:0}",
      ".hpf .hpf-l{display:block;font-size:13.5px;font-weight:600;text-transform:none;letter-spacing:normal;color:var(--hpf-ink);margin:0 0 6px}",
      ".hpf .hpf-l .hpf-opt,.hpf .hpf-l .fv-opt{font-weight:400;color:var(--hpf-ink3)}",
      "@media (max-width:420px){.hpf-line{flex-wrap:wrap}.hpf .hpf-vbtn{flex:1 1 100%}}",
      ".hpf-line{display:flex;gap:8px;align-items:stretch;min-width:0}.hpf-line>.hp,.hpf-line>.hpf-i{flex:1 1 auto;min-width:0}",
      ".hpf .hpf-i{display:block;width:100%;box-sizing:border-box;min-height:46px;height:auto;padding:10px 13px;border:1px solid var(--hpf-line);border-radius:10px;background:var(--hpf-bg);color:var(--hpf-ink);font:inherit;font-size:16px;letter-spacing:normal;margin:0;transition:border-color .15s,box-shadow .15s}",
      ".hpf .hpf-i::placeholder,.hpf .hp-num::placeholder,.hpf .hpf-skin::placeholder{color:var(--hpf-ink3);opacity:.85}",
      ".hpf .hpf-i:focus{outline:none;border-color:var(--hpf-acc);box-shadow:0 0 0 3px var(--hpf-soft)}",
      ".hpf .hp{min-height:46px;background:var(--hpf-bg)}",
      ".hpf .hpf-h{margin:6px 0 0;font-size:12.5px;line-height:1.45;color:var(--hpf-ink3)}",
      ".hpf .hpf-h.is-bad{color:var(--hpf-bad);font-weight:600}",
      ".hpf .hpf-e{margin:6px 0 0}",
      /* sections */
      ".hpf-sec{border:1px solid var(--hpf-line2);border-radius:14px;padding:18px 18px 4px;margin:0 0 14px;min-width:0;background:var(--hpf-bg)}",
      "fieldset.hpf-sec>legend{float:left;width:100%;padding:0;margin:0 0 2px}",
      "fieldset.hpf-sec>legend+.hpf-secs{clear:both}",
      ".hpf-sect{display:block;font-size:15.5px;font-weight:650;color:var(--hpf-ink);letter-spacing:-.005em}",
      ".hpf-secs{display:block;margin:2px 0 14px;font-size:13px;color:var(--hpf-ink3);font-weight:400}",
      "details.hpf-sec{padding:0}",
      "/* phone country picker inside the profile modal: stay within the field so the modal never scrolls sideways */",
      ".hpf .hp-pop{left:0;right:0;width:auto;max-width:100%;min-width:0}",
      "details.hpf-sec>.hpf-secb{padding:2px 18px 4px}",
      ".hpf-sum{list-style:none;display:flex;align-items:center;gap:12px;padding:16px 18px;cursor:pointer;border-radius:14px}",
      ".hpf-sum::-webkit-details-marker{display:none}",
      ".hpf-sum::after{content:\"\";flex:0 0 auto;width:9px;height:9px;border-right:2px solid var(--hpf-ink3);border-bottom:2px solid var(--hpf-ink3);transform:rotate(45deg) translate(-2px,-2px);transition:transform .15s}",
      "details[open]>.hpf-sum::after{transform:rotate(-135deg) translate(-2px,-2px)}",
      ".hpf-sum:hover{background:var(--hpf-bg2)}.hpf-sum:focus-visible{outline:2px solid var(--hpf-acc);outline-offset:2px}",
      ".hpf-sumtx{flex:1 1 auto;min-width:0}.hpf-sum .hpf-secs{margin:2px 0 0}",
      ".hpf-badge{flex:0 0 auto;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--hpf-ink3);background:var(--hpf-bg2);border:1px solid var(--hpf-line2);border-radius:99px;padding:3px 9px}",
      /* checkbox row */
      ".hpf-cbrow{display:flex;align-items:center;gap:10px;margin:-4px 0 16px;font-size:14px;color:var(--hpf-ink)}",
      ".hpf .hpf-cb{width:18px!important;height:18px!important;min-height:0!important;min-width:0!important;padding:0!important;margin:0!important;accent-color:var(--hpf-acc);flex:0 0 auto}",
      ".hpf .hpf-cbrow label{margin:0;font-size:14px;font-weight:500;text-transform:none;letter-spacing:normal;color:var(--hpf-ink)}",
      /* skills chips inside one box */
      ".hpf-skbox{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:46px;box-sizing:border-box;padding:6px 8px;border:1px solid var(--hpf-line);border-radius:10px;background:var(--hpf-bg);cursor:text;transition:border-color .15s,box-shadow .15s}",
      ".hpf-skbox:focus-within{border-color:var(--hpf-acc);box-shadow:0 0 0 3px var(--hpf-soft)}",
      ".hpf-chips{display:contents;margin:0;padding:0;list-style:none}",
      ".hpf-chip{display:inline-flex;align-items:center;gap:2px;padding:3px 3px 3px 11px;border-radius:999px;background:var(--hpf-soft);color:var(--hpf-ink);font-size:13.5px;font-weight:500;border:1px solid transparent;max-width:100%}",
      ".hpf-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".hpf .hpf-x{width:24px;height:24px;min-height:0!important;min-width:0!important;border:0;border-radius:50%;background:transparent;color:var(--hpf-ink2);font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0}",
      ".hpf-x:hover,.hpf-x:focus-visible{background:var(--hpf-line2);color:var(--hpf-ink)}",
      ".hpf .hpf-skin{flex:1 1 140px;min-width:120px;border:0!important;outline:none;background:transparent!important;box-shadow:none!important;color:var(--hpf-ink);font:inherit;font-size:16px;padding:6px 4px;min-height:0;margin:0}",
      /* photo */
      ".hpf-photo{display:flex;align-items:center;gap:18px;margin:0 0 18px;padding:16px;border:1.5px dashed var(--hpf-line2);border-radius:16px;background:var(--hpf-bg2);transition:border-color .15s,background .15s}",
      ".hpf-photo.is-drag{border-color:var(--hpf-acc);background:var(--hpf-soft)}",
      ".hpf-photo.is-busy .hpf-av{opacity:.6}",
      ".hpf-av{position:relative;width:84px;height:84px;border-radius:50%;overflow:hidden;flex:0 0 auto;background:linear-gradient(135deg,#047857,#036b4d);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:28px;cursor:pointer;box-shadow:0 0 0 4px var(--hpf-bg),0 0 0 5px var(--hpf-line2)}",
      ".hpf-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}",
      ".hpf-avcam{position:absolute;right:0;bottom:0;width:28px;height:28px;border-radius:50%;background:var(--hpf-bg);color:var(--hpf-ink);display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.25)}",
      ".hpf-avcam svg{width:15px;height:15px}",
      ".hpf-photocol{min-width:0;flex:1}",
      ".hpf-phototitle{margin:0 0 8px;font-weight:650;font-size:14.5px}",
      ".hpf-photo .hau-row{margin:0}",
      ".hpf .hau-btn{background:var(--hpf-bg);color:var(--hpf-ink);border-color:var(--hpf-line)}",
      ".hpf .hau-btn.ghost{background:transparent;border-color:transparent}",
      ".hpf .hau-btn.danger{color:var(--hpf-bad)}",
      ".hpf .hau-btn.primary{background:var(--hpf-acc);border-color:var(--hpf-acc);color:#fff}",
      ".hpf .hau-btn.ghost:hover{background:var(--hpf-soft)}",
      ".hpf .hpf-file{position:absolute!important;width:1px!important;height:1px!important;min-height:0!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;border:0!important}",
      "@media (max-width:420px){.hpf-photo{gap:14px;padding:14px}.hpf-av{width:68px;height:68px;font-size:23px}}",
      /* photo crop step */
      ".hpf-crop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,12,20,.6)}",
      ".hpf-cropbox{width:100%;max-width:360px;background:var(--hpf-bg,#fff);color:var(--hpf-ink,#111);border:1px solid var(--hpf-line,#ddd);border-radius:16px;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.35)}",
      ".hpf-croptitle{margin:0 0 12px;font-weight:650;font-size:16px}",
      ".hpf-cropcv{display:block;width:100%;aspect-ratio:1/1;border-radius:12px;background:#111;touch-action:none;cursor:grab}",
      ".hpf-cropzoom{display:flex;align-items:center;gap:10px;margin:12px 0;font-size:13px}.hpf-cropzoom input{flex:1}",
      ".hpf-crop .hau-row{justify-content:flex-end;gap:8px;margin:0}",
      /* progress */
      ".hpf-prog{margin:0 0 18px}.hpf-progtxt{margin:0 0 8px;font-size:13px;color:var(--hpf-ink2)}.hpf-progtxt b{color:var(--hpf-ink)}",
      ".hpf-bar{height:6px;border-radius:99px;background:var(--hpf-line2);overflow:hidden}",
      ".hpf-bar>span{display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,var(--hpf-acc),var(--accent-2,#036b4d));transition:width .3s}",
      ".hpf-prog.is-ready .hpf-bar>span{background:linear-gradient(90deg,#16a34a,#0f7a43)}",
      "@media (prefers-reduced-motion:reduce){.hpf-bar>span,.hpf-sum::after{transition:none}}",
      /* phone verify */
      ".hpf .hpf-vbtn{flex:0 0 auto;min-height:46px;padding:0 16px;border-radius:10px;border-color:var(--hpf-line);font-weight:650;color:var(--hpf-acc)}",
      ".hpf .hpf-vbtn:hover{background:var(--hpf-soft)}",
      ".hpf-vstate{display:none;align-items:center;gap:6px;margin:6px 0 0;font-size:13px;font-weight:600;color:var(--hpf-ok)}.hpf-vstate.is-ok{display:flex}",
      ".hpf-vic{width:16px;height:16px}",
      ".hpf-vpanel{margin:10px 0 0;padding:14px;border-radius:12px;background:var(--hpf-bg2);border:1px solid var(--hpf-line2)}",
      ".hpf-vinfo{margin:0;font-size:13.5px;line-height:1.5;color:var(--hpf-ink2)}",
      ".hpf-otp{display:flex;gap:8px;margin:12px 0 4px}",
      ".hpf .hpf-otpc{width:46px;height:52px;min-height:0;box-sizing:border-box;padding:0;text-align:center;font:inherit;font-size:22px;font-weight:650;border:1px solid var(--hpf-line);border-radius:10px;background:var(--hpf-bg);color:var(--hpf-ink);font-variant-numeric:tabular-nums}",
      ".hpf .hpf-otpc:focus{outline:none;border-color:var(--hpf-acc);box-shadow:0 0 0 3px var(--hpf-soft)}",
      ".hpf-otp.is-bad .hpf-otpc{border-color:var(--hpf-bad)}",
      "@media (max-width:400px){.hpf-otp{gap:6px}.hpf .hpf-otpc{width:40px;height:48px;font-size:20px}}",
      /* privacy + actions */
      ".hpf-priv{display:flex;gap:8px;align-items:flex-start;margin:4px 2px 16px;font-size:12.5px;line-height:1.5;color:var(--hpf-ink3)}.hpf-privic{width:16px;height:16px;flex:0 0 auto;margin-top:1px}",
      ".hpf-actions{display:flex;align-items:center;justify-content:flex-end;gap:14px;margin-top:4px}",
      ".hpf-actx{margin:0;font-size:13px;color:var(--hpf-ink3);flex:1 1 auto;min-width:0}",
      ".hpf-setup .hpf-priv{margin-bottom:40px;position:relative;z-index:0}",
      ".hpf-setup .hpf-actions{position:sticky;bottom:0;z-index:5;margin:8px -30px -24px;padding:14px 30px calc(14px + env(safe-area-inset-bottom,0px));background:color-mix(in srgb,var(--hpf-bg) 92%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-top:1px solid var(--hpf-line2);border-radius:0 0 18px 18px}",
      "@media (max-width:560px){.hpf-setup .hpf-actions{margin:8px -18px -18px;padding:12px 18px calc(12px + env(safe-area-inset-bottom,0px));border-radius:0 0 14px 14px}.hpf-setup .hpf-actx{display:none}.hpf-setup .hpf-save{width:100%}}",
      ".hpf-save{display:inline-flex;align-items:center;justify-content:center;gap:8px}",
      ".hpf-spin{display:none;width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:hpfSpin .7s linear infinite}",
      ".hpf-save.is-loading .hpf-spin{display:inline-block}",
      "@keyframes hpfSpin{to{transform:rotate(360deg)}}",
      "@media (prefers-reduced-motion:reduce){.hpf-spin{animation-duration:1.6s}}",
      ".hpf .hpf-alert{border-radius:10px;padding:10px 13px;font-size:13.5px;margin:0 0 14px;background:#fdecec;color:#b42318;border:1px solid #f5c6c6}",
      ".hpf .hpf-alert.ok{background:#e7f6ee;color:#0f7a43;border-color:#b6e3ca}",
      "html[data-theme=dark] .hpf-alert{background:#3a1414;color:#fecaca;border-color:#7f1d1d}html[data-theme=dark] .hpf-alert.ok{background:#0f2a1c;color:#a7f3d0;border-color:#14532d}",
      "html[data-theme=dark] .hpf{--hpf-ok:#34d399}",
      /* account dialog bits */
      ".hau-acc{width:min(520px,100%)}",
      ".hau-foot{justify-content:flex-end;margin-top:12px}",
      ".hau-lbl{display:block;margin:6px 0 4px;font-weight:600;font-size:13.5px}",
      ".hau-input.hau-text{font-size:15px;letter-spacing:normal}",
      /* profile menu (top-right avatar) — page tokens first, BPUI/bell fallbacks */
      ".hau-gone{display:none!important}",
      ".hau-host{display:flex;align-items:center;gap:8px}",
      ".hau-tb{display:flex;align-items:center;gap:8px;min-width:0}",
      ".hau-tb-slot{display:flex;align-items:center;min-width:0}",
      ".hau-tb-slot:empty{display:none}",
      ".hau-mw{position:relative;display:flex}",
      ".hau-avbtn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;min-width:36px;min-height:36px;padding:0;margin:0;border:1px solid var(--line,#e8e3db);border-radius:50%;background:var(--panel,#fff);cursor:pointer;transition:box-shadow .15s,border-color .15s}",
      ".hau-avbtn:hover{border-color:var(--accent,#047857)}",
      ".hau-avbtn[aria-expanded=true],.hau-avbtn:focus-visible{outline:none;border-color:var(--accent,#047857);box-shadow:0 0 0 3px var(--accent-soft,#e3f4ed)}",
      ".hau-av{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;overflow:hidden;color:#fff;font:700 12px/1 var(--font,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);letter-spacing:.02em;flex:0 0 auto;user-select:none}",
      ".hau-av-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}",
      ".hau-av-img[hidden]{display:none}",
      ".hau-av-lg{width:44px;height:44px;font-size:16px}",
      ".hau-c0{background:#047857}.hau-c1{background:#2563eb}.hau-c2{background:#0f766e}.hau-c3{background:#b45309}.hau-c4{background:#be185d}.hau-c5{background:#4d7c0f}.hau-c6{background:#374151}.hau-c7{background:#0369a1}",
      ".hau-menu{position:absolute;top:calc(100% + 8px);right:0;z-index:2147481000;width:272px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:6px;background:var(--panel,#fff);color:var(--ink,#1b1930);border:1px solid var(--line,#e8e3db);border-radius:14px;box-shadow:0 24px 60px rgba(20,27,46,.22),0 2px 8px rgba(20,27,46,.08);text-align:left;font:14px/1.4 var(--font,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);animation:hauIn .16s ease-out}",
      "html[data-theme=dark] .hau-menu{box-shadow:0 24px 60px rgba(0,0,0,.7)}",
      ".hau-menu[hidden]{display:none}",
      ".hau-mh{display:flex;gap:12px;align-items:center;padding:10px 10px 12px;margin:0 0 4px;border-bottom:1px solid var(--line,#e8e3db)}",
      ".hau-mh-t{min-width:0;flex:1}",
      ".hau-mh-n{margin:0;font-weight:700;font-size:14.5px;color:var(--ink,#1b1930);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".hau-mh-e{margin:1px 0 6px;font-size:12.5px;color:var(--ink-2,#4b475f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".hau-mh-r{display:flex;align-items:center;gap:6px;min-width:0}.hau-mh-r .hau-chip{flex:0 0 auto}.hau-mh-s{min-width:0;font-size:12.5px;color:var(--ink-2,#4b475f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hau-mh-s b{font-weight:650;color:var(--ink,#1b1930)}.hau-mh-s[hidden]{display:none}",
      ".hau-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--accent-soft,#e3f4ed);color:var(--accent,#047857);font-size:11px;font-weight:700;letter-spacing:.02em}",
      "html[data-theme=dark] .hau-chip{background:#123329;color:#6ee7b7}",
      ".hau-msep{height:1px;margin:4px 6px;background:var(--line,#e8e3db)}",
      ".hau-mi{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;box-sizing:border-box;padding:7px 10px;margin:0;border:0;border-radius:9px;background:transparent;color:var(--ink,#1b1930);font:inherit;font-size:14px;font-weight:500;text-align:left;text-decoration:none;cursor:pointer}",
      ".hau-mi:hover,.hau-mi:focus{outline:none;background:var(--accent-soft,#f4f2fb);color:var(--ink,#1b1930)}",
      ".hau-mi:focus-visible{box-shadow:inset 0 0 0 2px var(--accent,#047857)}",
      "html[data-theme=dark] .hau-mi:hover,html[data-theme=dark] .hau-mi:focus{background:#123329}",
      ".hau-mi.is-out{color:var(--bad,#b91c1c)}",
      "html[data-theme=dark] .hau-mi.is-out{color:#fca5a5}",
      ".hau-mi-ic{width:16px;height:16px;flex:0 0 auto;color:var(--ink-3,#6b6577)}",
      ".hau-mi.is-out .hau-mi-ic{color:inherit}",
      "@media (prefers-reduced-motion:reduce){.hau-menu{animation:none}}",
      "@media (max-width:600px){.hau-menu{position:fixed;top:60px;right:12px;left:auto;width:min(300px,calc(100vw - 24px))}}",
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
  function closePanel() {
    if (!panel) return;
    var back = panel._hauReturn; try { panel.remove(); } catch (e) {} panel = null;
    refreshMenuIdentity();
    if (back && back.isConnected && back.focus) try { back.focus(); } catch (e) {}
  }
  // openAccount({focus:"profile"}) opens the panel scrolled to "Your profile"
  // openAccount({section:"profile"|"settings"}) shows just that half (profile menu);
  // no section = everything (older callers, the profile / two-step notices).
  // openAccount({section:"settings", focus:"mfa"|"password"|"devices"}) scrolls to that part and focuses
  // its heading (Control Center search: "Two-step sign-in", "Change password", "Sign out other devices").
  function openAccount(opts) {
    if (opts && opts.type) opts = null;                 // called as a click handler
    var section = (opts && opts.section) || "all";
    var focusProfile = !!(opts && opts.focus === "profile") || section === "profile";
    css(); closePanel();
    var st = S(); var u = st && st.auth.user(); if (!u) return;
    var returnFocus = doc.activeElement;
    panel = el("div", { class: "bpui-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "hauTitle", id: "hauAccount" });
    var card = el("div", { class: "bpui-dialog hau-acc" });
    panel.appendChild(card);
    card.appendChild(el("h2", { id: "hauTitle" }, section === "profile" ? "Your profile" : section === "settings" ? "Account settings" : "Your account"));
    card.appendChild(el("p", { class: "hau-muted" }, "Signed in as " + (u.email || "")));
    if (section !== "settings") {
      if (st.profile && st.profile.validate && st.profile.update) card.appendChild(profileSection(st, focusProfile, section === "profile"));
      else if (st.profile && st.profile.setMine) card.appendChild(displayNameSection(st));
    }
    panel._hauReturn = returnFocus;
    if (section === "profile") { finishPanel(card, true); return; }
    if (st.auth.changeEmail) card.appendChild(emailSection(st, u));

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
    var pw = el("div", { class: "hau-sec", id: "hauPwSec" });
    pw.appendChild(el("h3", { tabindex: "-1" }, "Password"));
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
    // two-step is OPTIONAL for every role: each person turns it on / off here for their own account.
    // Only admins are ever reminded about it (adminTwoStep); nobody else gets a pop-up.
    var mf = el("div", { class: "hau-sec", id: "hauMfaSec" });
    mf.appendChild(el("h3", { tabindex: "-1" }, "Two-step verification"));
    var mfBody = el("div", null); mfBody.appendChild(el("p", { class: "hau-muted" }, "Loading…"));
    mf.appendChild(mfBody); card.appendChild(mf);

    // other devices
    var dv = el("div", { class: "hau-sec", id: "hauDevSec" });
    dv.appendChild(el("h3", { tabindex: "-1" }, "Other devices"));
    /* r20 planner: a Google sign-in account has no Helm password - point at the Google account instead */
    var dvNoPw = !!(st.auth.hasPassword && !st.auth.hasPassword());
    dv.appendChild(el("p", { class: "hau-muted" }, dvNoPw
      ? "Signed in somewhere you don't recognise? Sign out everywhere except this browser, then secure your Google account (change its password and check its signed-in devices)."
      : "Signed in somewhere you don't recognise? Sign out everywhere except this browser, then change your password."));
    var dvMsg = el("div", { class: "hau-err", role: "status" });
    var dvBtn = el("button", { type: "button", class: "hau-btn" }, "Sign out other devices");
    dvBtn.addEventListener("click", function () {
      dvBtn.disabled = true; dvMsg.className = "hau-err"; dvMsg.textContent = "";
      st.auth.signOutOthers().then(function () { dvMsg.className = "hau-ok"; dvMsg.textContent = "Other devices were signed out."; },
        function (e) { dvMsg.textContent = errText(e, "sign out other devices"); }).then(function () { dvBtn.disabled = false; });
    });
    var dvRow = el("div", { class: "hau-row" }); dvRow.appendChild(dvBtn); dv.appendChild(dvRow); dv.appendChild(dvMsg); card.appendChild(dv);

    finishPanel(card, focusProfile);
    var jumpTo = { mfa: mf, password: pw, devices: dv }[opts && opts.focus];
    if (jumpTo) setTimeout(function () {
      try { jumpTo.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {}
      var h = jumpTo.querySelector("h3"); try { if (h) h.focus({ preventScroll: true }); } catch (e) {}
    }, 80);

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
  function finishPanel(card, focusProfile) {
    var foot = el("div", { class: "hau-row hau-foot" });
    var close = el("button", { type: "button", class: "hau-btn", "data-close": "" }, "Close");
    close.addEventListener("click", closePanel);
    foot.appendChild(close); card.appendChild(foot);
    panel.addEventListener("click", function (e) { if (e.target === panel) closePanel(); });
    panel.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // an open country picker (phone-input.js) owns Escape: close just the picker, keep the profile modal
      var hp = panel.querySelector(".hp.is-open");
      if (hp) { var b = hp.querySelector(".hp-cc"); if (b) b.click(); e.preventDefault(); return; }
      closePanel();
    });
    doc.body.appendChild(panel);
    if (!focusProfile) setTimeout(function () { try { close.focus(); } catch (e) {} }, 30);
  }
  // "E-mail address" — Supabase change-email flow (confirmation link; nothing changes until clicked)
  function emailSection(st, u) {
    var sec = el("div", { class: "hau-sec" });
    sec.appendChild(el("h3", null, "E-mail address"));
    if (st.auth.hasPassword && !st.auth.hasPassword()) {
      sec.appendChild(el("p", { class: "hau-muted" }, "You sign in with Google as " + (u.email || "") + ". To use a different address, sign in with that Google account instead."));
      return sec;
    }
    sec.appendChild(el("p", { class: "hau-muted" }, "We'll e-mail a confirmation link. Your sign-in address changes only after you click it."));
    var lab = el("label", { for: "hauNewEmail", class: "hau-lbl" }, "New e-mail address");
    var inp = el("input", { id: "hauNewEmail", type: "email", class: "hau-input hau-text", maxlength: "254", autocomplete: "email", placeholder: "you@studio.com" });
    var go = el("button", { type: "button", class: "hau-btn" }, "Send confirmation link");
    var msg = el("div", { class: "hau-err", role: "status", "aria-live": "polite" });
    var row = el("div", { class: "hau-row" }); row.appendChild(go);
    sec.appendChild(lab); sec.appendChild(inp); sec.appendChild(row); sec.appendChild(msg);
    var submit = function () {
      if (go.disabled) return;
      msg.className = "hau-err"; msg.textContent = ""; go.disabled = true;
      st.auth.changeEmail(inp.value).then(function (r) {
        msg.className = "hau-ok"; msg.textContent = "Check " + r.pending + " for a confirmation link. Until then you keep signing in with " + (u.email || "your current address") + ".";
        inp.value = "";
      }, function (e) {
        msg.textContent = e && /^email_(invalid|same)$/.test(e.code || "") ? e.message : errText(e, "change your e-mail");
        try { inp.focus(); } catch (x) {}
      }).then(function () { go.disabled = false; });
    };
    go.addEventListener("click", submit);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    return sec;
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
  // phone-input.js + form-validate.js: included by /profile-setup; loaded on demand elsewhere
  var libsP = null;
  function ensureFormLibs() {
    if (global.HelmPhone && global.HelmPhone.attach && global.HelmValidate && global.HelmValidate.bind) return Promise.resolve(true);
    if (libsP) return libsP;
    function load(src, ready) {
      return new Promise(function (res) {
        if (ready()) return res(true);
        var s = el("script"); s.src = src;
        s.onload = function () { res(ready()); }; s.onerror = function () { res(false); };
        (doc.head || doc.documentElement).appendChild(s);
      });
    }
    libsP = Promise.all([
      load("/phone-input.js?v=" + PHONE_LIB_V, function () { return !!(global.HelmPhone && global.HelmPhone.attach); }),
      load("/form-validate.js?v=" + FORM_LIB_V, function () { return !!(global.HelmValidate && global.HelmValidate.bind); }),
    ]).then(function (r) { return r[0] && r[1]; });
    return libsP;
  }
  var FORM_LIB_V = "2", PHONE_LIB_V = "7";
  function pathIcon(path, cls) {
    var ns = "http://www.w3.org/2000/svg", s = doc.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "16"); s.setAttribute("height", "16"); s.setAttribute("aria-hidden", "true"); if (cls) s.setAttribute("class", cls);
    var p = doc.createElementNS(ns, "path"); p.setAttribute("d", path); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p); return s;
  }
  var IC_CAMERA = "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z";
  var IC_CHECK = "M5 12.5l4.5 4.5L19 7.5";
  var IC_SHIELD = "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z";

  // profileForm(BPStore, {mode:"setup"|"panel", idp, profile, email, submitLabel, onSaved(row)})
  //   → {el, focusFirst()}
  // Phones use HelmPhone.attach (flag + country list, .value = E.164); inline errors on
  // blur via HelmValidate; the save still goes through BPStore.profile.validate (the
  // client mirror of the SQL rules) so nothing invalid is ever sent.
  function profileForm(st, opts) {
    css();
    var o = opts || {}, P = o.profile || {}, idp = o.idp || "hpf", setup = o.mode === "setup";
    var hadName = !!String(P.full_name || "").trim(), hadPhone = !!P.phone;
    var vopts = setup ? { requireName: true, requirePhone: true } : { requireName: hadName, requirePhone: hadPhone };
    var lim = (st.profile && st.profile.limits) || { text: 80, skill: 40, skills: 20 };
    var form = el("form", { class: "hpf" + (setup ? " hpf-setup" : ""), novalidate: "" });
    if (o.labelledBy) form.setAttribute("aria-labelledby", o.labelledBy);
    var alertBox = el("div", { class: "hpf-alert", role: "alert", tabindex: "-1" }); alertBox.hidden = true;
    form.appendChild(alertBox);
    var inputs = {}, errs = {}, binds = {}, busy = false;

    // ---- progress (text + bar)
    var prog = el("div", { class: "hpf-prog" });
    var progTxt = el("p", { class: "hpf-progtxt", id: idp + "_progtxt" });
    var bar = el("div", { class: "hpf-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-labelledby": idp + "_progtxt" });
    var fill = el("span"); bar.appendChild(fill);
    prog.appendChild(progTxt); prog.appendChild(bar); form.appendChild(prog);

    // ---- photo: circular preview, click or drag & drop
    var avPath = P.avatar_path || null;
    var photo = el("div", { class: "hpf-photo" });
    var av = el("div", { class: "hpf-av" });
    var avIni = el("span", { class: "hpf-ini", "aria-hidden": "true" }, initials(P.full_name, P.email || o.email));
    var avImg = el("img", { alt: "Your profile photo" }); avImg.hidden = true;
    var avCam = el("span", { class: "hpf-avcam", "aria-hidden": "true" }); avCam.appendChild(pathIcon(IC_CAMERA));
    av.appendChild(avIni); av.appendChild(avImg);
    var photoCol = el("div", { class: "hpf-photocol" });
    photoCol.appendChild(el("p", { class: "hpf-phototitle", id: idp + "_photo_l" }, "Profile photo"));
    var fileIn = el("input", { type: "file", id: idp + "_photo", class: "hpf-file", accept: "image/png,image/jpeg,image/webp", tabindex: "-1", "aria-hidden": "true" });
    var upBtn = el("button", { type: "button", class: "hau-btn", "aria-describedby": idp + "_photo_h" });
    var rmBtn = el("button", { type: "button", class: "hau-btn ghost danger" }, "Remove");
    var photoRow = el("div", { class: "hau-row" }); photoRow.appendChild(upBtn); photoRow.appendChild(rmBtn);
    var photoMsg = el("p", { class: "hpf-h", id: idp + "_photo_h", role: "status", "aria-live": "polite" }, "Drag a photo here, or choose one. PNG, JPEG or WebP — cropped to a circle.");
    photoCol.appendChild(photoRow); photoCol.appendChild(photoMsg); photoCol.appendChild(fileIn);
    photo.appendChild(av); photo.appendChild(photoCol); form.appendChild(photo);
    function showPhoto() {
      upBtn.textContent = avPath ? "Change photo" : "Upload photo";
      rmBtn.hidden = !avPath;
      if (!avPath) { avImg.hidden = true; avImg.removeAttribute("src"); avIni.hidden = false; return; }
      var want = avPath;
      Promise.resolve(st.profile.avatarUrl ? st.profile.avatarUrl(want) : null).then(function (u) {
        if (want !== avPath) return;
        if (u) { avImg.src = u; avImg.hidden = false; avIni.hidden = true; } else { avImg.hidden = true; avIni.hidden = false; }
      }, function () {});
    }
    function photoNote(text, bad) { photoMsg.textContent = text; photoMsg.classList.toggle("is-bad", !!bad); }
    // Square crop + zoom before upload. Falls back to the raw file if the image can't be decoded.
    function cropThen(f, done) {
      if (!f || !/^image\/(png|jpeg|webp)$/.test(f.type || "") || typeof URL === "undefined" || !URL.createObjectURL) { done(f); return; }
      var url = URL.createObjectURL(f), img = new Image();
      img.onerror = function () { URL.revokeObjectURL(url); done(f); };
      img.onload = function () {
        var OUT = 512, cv = el("canvas", { class: "hpf-cropcv", width: String(OUT), height: String(OUT), "aria-label": "Drag to position your photo" });
        var ctx = cv.getContext("2d"), base = OUT / Math.min(img.naturalWidth, img.naturalHeight), z = 1, ox = 0, oy = 0;
        function clamp() { var w = img.naturalWidth * base * z, h = img.naturalHeight * base * z;
          ox = Math.min(0, Math.max(OUT - w, ox)); oy = Math.min(0, Math.max(OUT - h, oy)); }
        function draw() { clamp(); ctx.fillStyle = "#111"; ctx.fillRect(0, 0, OUT, OUT);
          ctx.drawImage(img, ox, oy, img.naturalWidth * base * z, img.naturalHeight * base * z); }
        ox = (OUT - img.naturalWidth * base) / 2; oy = (OUT - img.naturalHeight * base) / 2; draw();
        var ov = el("div", { class: "hpf-crop", role: "dialog", "aria-modal": "true", "aria-label": "Crop your photo" });
        var box = el("div", { class: "hpf-cropbox" });
        box.appendChild(el("p", { class: "hpf-croptitle" }, "Crop your photo"));
        box.appendChild(cv);
        var zl = el("label", { class: "hpf-cropzoom" }, "Zoom");
        var zr = el("input", { type: "range", min: "1", max: "3", step: "0.01", value: "1", "aria-label": "Zoom" });
        zl.appendChild(zr); box.appendChild(zl);
        var row = el("div", { class: "hau-row" });
        var cancel = el("button", { type: "button", class: "hau-btn ghost" }, "Cancel");
        var ok = el("button", { type: "button", class: "hau-btn primary" }, "Use photo");
        row.appendChild(cancel); row.appendChild(ok); box.appendChild(row); ov.appendChild(box);
        (form.closest(".hpf") || doc.body).appendChild(ov);
        function close() { URL.revokeObjectURL(url); doc.removeEventListener("keydown", onKey); if (ov.parentNode) ov.parentNode.removeChild(ov); }
        function onKey(e) { if (e.key === "Escape") { close(); } }
        doc.addEventListener("keydown", onKey);
        zr.addEventListener("input", function () { var nz = parseFloat(zr.value) || 1, c = OUT / 2;
          ox = c - (c - ox) * nz / z; oy = c - (c - oy) * nz / z; z = nz; draw(); });
        var drag = null;
        cv.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY }; try { cv.setPointerCapture(e.pointerId); } catch (x) {} });
        cv.addEventListener("pointermove", function (e) { if (!drag) return; var k = OUT / (cv.getBoundingClientRect().width || OUT);
          ox += (e.clientX - drag.x) * k; oy += (e.clientY - drag.y) * k; drag = { x: e.clientX, y: e.clientY }; draw(); });
        cv.addEventListener("pointerup", function () { drag = null; });
        cv.addEventListener("pointercancel", function () { drag = null; });
        ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
        cancel.addEventListener("click", close);
        ok.addEventListener("click", function () {
          var type = f.type === "image/png" ? "image/png" : "image/jpeg";
          cv.toBlob(function (b) { close(); if (!b) { done(f); return; }
            var name = String(f.name || "avatar").replace(/\.[a-z0-9]+$/i, "") + (type === "image/png" ? ".png" : ".jpg");
            var out; try { out = new File([b], name, { type: type }); } catch (x) { out = b; }
            done(out); }, type, 0.92);
        });
        ok.focus();
      };
      img.src = url;
    }
    function upload(f) {
      if (!f || busy) return;
      busy = true; upBtn.disabled = true; rmBtn.disabled = true; photo.classList.add("is-busy"); photoNote("Uploading your photo…");
      st.profile.uploadAvatar(f).then(function (path) {
        avPath = path; showPhoto(); photoNote("Photo saved."); progress();
      }, function (e) { photoNote(pfServerText(e) || errText(e, "upload your photo"), true); })
        .then(function () { busy = false; upBtn.disabled = false; rmBtn.disabled = false; photo.classList.remove("is-busy"); });
    }
    avImg.addEventListener("error", function () { avImg.hidden = true; avIni.hidden = false; });
    upBtn.addEventListener("click", function () { if (!busy) fileIn.click(); });
    av.addEventListener("click", function () { if (!busy) fileIn.click(); });
    fileIn.addEventListener("change", function () { var f = fileIn.files && fileIn.files[0]; fileIn.value = ""; cropThen(f, upload); });
    ["dragenter", "dragover"].forEach(function (t) { photo.addEventListener(t, function (e) { e.preventDefault(); photo.classList.add("is-drag"); }); });
    ["dragleave", "dragend"].forEach(function (t) { photo.addEventListener(t, function () { photo.classList.remove("is-drag"); }); });
    photo.addEventListener("drop", function (e) {
      e.preventDefault(); photo.classList.remove("is-drag");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) cropThen(f, upload);
    });
    rmBtn.addEventListener("click", function () {
      if (busy) return;
      busy = true; upBtn.disabled = true; rmBtn.disabled = true; photoNote("Removing…");
      st.profile.removeAvatar().then(function () { avPath = null; showPhoto(); photoNote("Photo removed."); progress(); },
        function (e) { photoNote(pfServerText(e) || errText(e, "remove your photo"), true); })
        .then(function () { busy = false; upBtn.disabled = false; rmBtn.disabled = false; try { upBtn.focus(); } catch (x) {} });
    });
    showPhoto();

    // ---- one labelled input (+ hint + error line)
    function field(parent, key, label, a) {
      a = a || {};
      var id = idp + "_" + key;
      var wrap = el("div", { class: "hpf-f" + (a.wide ? " hpf-wide" : "") });
      var lab = el("label", { for: id, class: "hpf-l" }, label);
      if (a.req) lab.appendChild(el("span", { class: "req-star", "aria-hidden": "true" }, " *"));
      else if (!a.core) lab.appendChild(el("span", { class: "hpf-opt" }, " (optional)"));   // core = needed for a complete profile: never labelled optional
      var inp = el("input", { id: id, class: "hpf-i", type: a.type || "text", autocomplete: a.ac || "off", maxlength: String(a.max || lim.text) });
      if (a.ph) inp.setAttribute("placeholder", a.ph);
      if (a.type === "tel") { inp.setAttribute("inputmode", "tel"); inp.setAttribute("data-phone-hardened", "1"); if (a.mobile) inp.setAttribute("data-phone-mobile", "1"); }
      if (a.req) inp.setAttribute("aria-required", "true");
      var desc = [];
      var hint = a.hint ? el("p", { class: "hpf-h", id: id + "_h" }, a.hint) : null;
      if (hint) desc.push(hint.id);
      var er = el("p", { class: "hpf-e fv-msg", id: id + "_e" }); er.hidden = true; desc.push(er.id);
      inp.setAttribute("aria-describedby", desc.join(" "));
      wrap.appendChild(lab);
      var line = el("div", { class: "hpf-line" }); line.appendChild(inp); wrap.appendChild(line);
      wrap.appendChild(er);
      if (hint) wrap.appendChild(hint);
      parent.appendChild(wrap);
      inp.value = a.value == null ? "" : String(a.value);
      inputs[key] = inp; errs[key] = er;
      inp.addEventListener("input", function () { progress(); });
      return { wrap: wrap, input: inp, line: line };
    }
    function section(title, sub, optional, filled) {
      var sec;
      if (optional) {
        sec = el("details", { class: "hpf-sec is-opt" });
        if (!setup || filled) sec.open = true;
        var sum = el("summary", { class: "hpf-sum" });
        var tx = el("span", { class: "hpf-sumtx" });
        tx.appendChild(el("span", { class: "hpf-sect" }, title));
        tx.appendChild(el("span", { class: "hpf-secs" }, sub));
        sum.appendChild(tx);
        sum.appendChild(el("span", { class: "hpf-badge" }, "Optional"));
        sec.appendChild(sum);
      } else {
        sec = el("fieldset", { class: "hpf-sec" });
        var lg = el("legend", { class: "hpf-sect" }, title);
        sec.appendChild(lg);
        sec.appendChild(el("p", { class: "hpf-secs" }, sub));
      }
      var body = el("div", { class: "hpf-secb" }); sec.appendChild(body);
      form.appendChild(sec);
      return body;
    }

    // ---- About you
    var sA = section("About you", "How your team will see and reach you.", false);
    field(sA, "full_name", "Full name", { req: setup || hadName, core: true, ac: "name", max: 50, ph: "e.g. Ananya Rao", value: P.full_name, wide: true });
    var mob = field(sA, "phone", "Mobile number", { req: setup || hadPhone, core: true, type: "tel", ac: "tel", max: 24, mobile: true, value: P.phone || "", wide: true,
      hint: "We'll use this for event-day check-ins and urgent updates." });
    // WhatsApp is parked for launch (owner, Oct 2026): while config.liveChannels.whatsapp is off,
    // the WhatsApp checkboxes, number and the WhatsApp-code "Verify" button are not shown at all.
    var waLive = !!(global.SUPABASE_CONFIG && global.SUPABASE_CONFIG.liveChannels && global.SUPABASE_CONFIG.liveChannels.whatsapp);
    // verify (0055)
    var vBtn = el("button", { type: "button", class: "hau-btn hpf-vbtn", "aria-describedby": idp + "_vstate" }, "Verify");
    var vState = el("span", { class: "hpf-vstate", id: idp + "_vstate", role: "status", "aria-live": "polite" });
    mob.line.appendChild(vBtn);
    var vPanel = el("div", { class: "hpf-vpanel" }); vPanel.hidden = true;
    mob.wrap.insertBefore(vState, mob.wrap.querySelector(".hpf-e"));
    mob.wrap.appendChild(vPanel);
    var cbRow = el("div", { class: "hpf-cbrow" });
    var same = el("input", { type: "checkbox", id: idp + "_wa_same", class: "hpf-cb" });
    same.checked = P.whatsapp_same !== false;
    cbRow.appendChild(same); cbRow.appendChild(el("label", { for: idp + "_wa_same" }, "WhatsApp is on this number"));
    sA.appendChild(cbRow);
    if (!waLive) { vBtn.hidden = true; cbRow.hidden = true; }
    var wa = field(sA, "whatsapp", "WhatsApp number", { type: "tel", ac: "off", max: 24, mobile: true, wide: true,
      value: P.whatsapp_same === false && P.whatsapp ? P.whatsapp : "" });
    function syncWa() { wa.wrap.hidden = same.checked || !waLive; if (same.checked && binds.whatsapp) binds.whatsapp.reset(); }
    same.addEventListener("change", function () { syncWa(); progress(); if (!same.checked) try { wa.input.focus(); } catch (x) {} });
    syncWa();
    // 0078: opt in to WhatsApp copies of my Helm notifications (saved immediately; the server
    // sends nothing until the studio adds its WhatsApp number and switches forwarding on)
    (function () {
      var C = global.BPStore && global.BPStore.comms;
      if (!waLive || !C || typeof C.myForward !== "function") return;
      var fRow = el("div", { class: "hpf-cbrow" });
      var fCb = el("input", { type: "checkbox", id: idp + "_wa_fwd", class: "hpf-cb" });
      var fLb = el("label", { for: idp + "_wa_fwd" }, "Also send my Helm notifications to my WhatsApp");
      var fSt = el("span", { class: "hpf-vstate", role: "status", "aria-live": "polite" });
      fRow.appendChild(fCb); fRow.appendChild(fLb); fRow.appendChild(fSt); fRow.hidden = true;
      sA.appendChild(fRow);
      var paint = function (r) {
        if (!r) { fRow.hidden = true; return; }
        fRow.hidden = false; fCb.checked = !!r.opted_in;
        fSt.textContent = !r.has_number ? "Save a WhatsApp number first." : !r.studio_ready ? "Your studio hasn't switched this on yet." : "";
      };
      C.myForward().then(paint).catch(function () { fRow.hidden = true; });
      fCb.addEventListener("change", function () {
        fCb.disabled = true;
        C.setMyForward(fCb.checked).then(paint).catch(function () { fCb.checked = !fCb.checked; fSt.textContent = "Couldn't save - try again."; })
          .then(function () { fCb.disabled = false; });
      });
    })();

    // ---- Work (optional)
    var wFilled = !!(P.job_title || P.department || P.city || (P.skills && P.skills.length));
    var sW = section("Work", "Helps your studio assign the right jobs to you.", true, wFilled);   // r20 planner: neutral (the viewer may be a planner)
    var gW = el("div", { class: "hpf-grid" }); sW.appendChild(gW);
    field(gW, "job_title", "Job title", { ac: "organization-title", ph: "e.g. Event coordinator", value: P.job_title });
    field(gW, "department", "Department", { ph: "e.g. Operations", value: P.department });
    // skills: chips (Enter or comma adds, × removes, Backspace on an empty box removes the last)
    var skills = Array.isArray(P.skills) ? P.skills.slice(0, lim.skills) : [];
    var skWrap = el("div", { class: "hpf-f hpf-wide" });
    var skLab = el("label", { for: idp + "_skills", class: "hpf-l" }, "Skills"); skLab.appendChild(el("span", { class: "hpf-opt" }, " (optional)"));
    skWrap.appendChild(skLab);
    var skBox = el("div", { class: "hpf-skbox" });
    var chips = el("ul", { class: "hpf-chips", "aria-label": "Your skills" });
    var skIn = el("input", { id: idp + "_skills", class: "hpf-skin", type: "text", autocomplete: "off", maxlength: String(lim.skill), placeholder: "Type a skill and press Enter",
      "aria-describedby": idp + "_skills_h " + idp + "_skills_e" });
    skBox.appendChild(chips); skBox.appendChild(skIn);
    skBox.addEventListener("click", function (e) { if (e.target === skBox) try { skIn.focus(); } catch (x) {} });
    var skHint = el("p", { class: "hpf-h", id: idp + "_skills_h" });
    var skErr = el("p", { class: "hpf-e fv-msg", id: idp + "_skills_e" }); skErr.hidden = true;
    skWrap.appendChild(skBox); skWrap.appendChild(skErr); skWrap.appendChild(skHint);
    inputs.skills = skIn; errs.skills = skErr;
    gW.appendChild(skWrap);
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
      if (!skHint.textContent || /of \d+ skills\.$/.test(skHint.textContent)) skHint.textContent = "e.g. Lighting, Décor, Sound — " + skills.length + " of " + lim.skills + " skills.";
    }
    function addSkills(raw) {
      var parts = String(raw || "").split(",").map(function (s) { return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(); }).filter(Boolean);
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
    field(gW, "city", "City", { ac: "address-level2", ph: "e.g. Hyderabad", value: P.city });

    // ---- Emergency contact (optional)
    var eFilled = !!(P.emergency_contact_name || P.emergency_contact_phone);
    var sE = section("Emergency contact", "A family member or friend we call if you are hurt or unwell while working an event.", true, eFilled);
    // the studio owner / admin isn't asked on first setup (crew / staff are): for them it stays collapsed and
    // does not count towards "profile complete". It is still shown and fillable. (Before: only the section BODY
    // was hidden, so the "Emergency contact" row opened to an empty box - the reported "dropdown not working".)
    // 2026-10-17 owner decision: emergency contact is not needed. The section is hidden for everyone and
    // never counts towards "profile complete"; stored values are kept untouched (sent back unchanged).
    var noEmerg = true; sE.hidden = true; sE.style.display = "none";
    sE.appendChild(el("p", { class: "hpf-h" }, "Your studio admins see this so they can tell your family quickly if something happens to you at an event (an injury, an accident or a health problem). It is not shown to clients or other crew."));
    var gE = el("div", { class: "hpf-grid" }); sE.appendChild(gE);
    field(gE, "emergency_contact_name", "Contact name", { ac: "off", max: 50, ph: "e.g. Ravi Rao", value: P.emergency_contact_name });
    field(gE, "emergency_contact_phone", "Contact phone", { type: "tel", ac: "off", max: 24, value: P.emergency_contact_phone || "" });
    var priv = el("p", { class: "hpf-priv" });
    priv.appendChild(doc.createTextNode("Only you and your studio admins can see your mobile, WhatsApp and city."));
    form.appendChild(priv);

    // ---- actions (sticky on the setup page)
    var row = el("div", { class: "hpf-actions" });
    var save = el("button", { type: "submit", class: setup ? "btn primary hpf-save" : "hau-btn primary hpf-save" });
    var spin = el("span", { class: "hpf-spin", "aria-hidden": "true" });
    var saveTx = el("span", null, o.submitLabel || "Save");
    save.appendChild(spin); save.appendChild(saveTx);
    var rowTx = el("p", { class: "hpf-actx", "aria-hidden": "true" });
    row.appendChild(rowTx); row.appendChild(save); form.appendChild(row);

    function collect() {
      var pending = skIn.value.trim() ? skills.concat([skIn.value]) : skills;
      var t = function (k) { return String(inputs[k].value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(); };
      return {
        full_name: t("full_name"), phone: inputs.phone.value, whatsapp_same: same.checked,
        whatsapp: same.checked ? null : inputs.whatsapp.value, job_title: t("job_title"), department: t("department"),
        skills: pending, city: t("city"), emergency_contact_name: t("emergency_contact_name"),
        emergency_contact_phone: inputs.emergency_contact_phone.value,
      };
    }
    function setErr(key, msg) {
      if (binds[key]) { binds[key].setError(msg || ""); return; }
      var inp = inputs[key], er = errs[key]; if (!inp || !er) return;
      while (er.firstChild) er.removeChild(er.firstChild);
      if (msg) { var ic = el("span", { class: "fv-ic", "aria-hidden": "true" }, "!"); er.appendChild(ic); er.appendChild(doc.createTextNode(msg)); }
      er.hidden = !msg;
      if (msg) inp.setAttribute("aria-invalid", "true"); else inp.removeAttribute("aria-invalid");
    }
    var ORDER = ["full_name", "phone", "whatsapp", "job_title", "department", "skills", "city", "emergency_contact_name", "emergency_contact_phone"];
    function progress() {
      var f = collect(), n = 0;
      if (avPath) n++;
      if (String(f.full_name).trim()) n++;
      var hasPhone = !!String(f.phone).trim(); if (hasPhone) n++;
      if (f.whatsapp_same ? hasPhone : String(f.whatsapp || "").trim()) n++;
      (noEmerg ? ["job_title", "department", "city"] : ["job_title", "department", "city", "emergency_contact_name", "emergency_contact_phone"]).forEach(function (k) { if (String(f[k] || "").trim()) n++; });
      if (skills.length) n++;
      var total = noEmerg ? 8 : 10;
      var pct = Math.round(n * 100 / total);
      fill.style.width = pct + "%"; bar.setAttribute("aria-valuenow", String(pct));
      var need = [];
      if (!String(f.full_name).trim()) need.push("full name");
      if (!hasPhone) need.push("mobile number");
      progTxt.textContent = "";
      progTxt.appendChild(el("b", null, n + " of " + total));
      progTxt.appendChild(doc.createTextNode(" details added" + (need.length ? " · still needed: " + need.join(" and ") : (setup ? " · ready to save" : ""))));
      rowTx.textContent = need.length ? "Still needed: " + need.join(", ") : "All required details added";
      prog.classList.toggle("is-ready", !need.length);
    }
    function showAlert(msg, ok) {
      alertBox.className = "hpf-alert" + (ok ? " ok" : "");
      alertBox.textContent = msg || ""; alertBox.hidden = !msg;
    }

    // ---- phone verification (0055) — dormant until WhatsApp is live
    var PV = st.profile && st.profile.phoneVerify, verifiedPhone = null, cool = 0, coolT = null;
    function vPaint() {
      var cur = inputs.phone.value;
      var ok = !!(verifiedPhone && cur && cur === verifiedPhone);
      vBtn.hidden = ok || !cur;
      vState.textContent = "";
      vState.className = "hpf-vstate" + (ok ? " is-ok" : "");
      if (ok) { vState.appendChild(pathIcon(IC_CHECK, "hpf-vic")); vState.appendChild(doc.createTextNode("Verified on WhatsApp")); }
    }
    function vInfo(text) { vPanel.hidden = false; vPanel.textContent = ""; vPanel.appendChild(el("p", { class: "hpf-vinfo" }, text)); }
    function startCooldown(secs, resend) {
      cool = secs; clearInterval(coolT);
      var tick = function () {
        if (!resend) return;
        resend.disabled = cool > 0;
        resend.textContent = cool > 0 ? "Resend code in " + cool + "s" : "Resend code";
        if (cool <= 0) clearInterval(coolT); cool--;
      };
      tick(); coolT = setInterval(tick, 1000);
    }
    function codePanel(e164) {
      vPanel.hidden = false; vPanel.textContent = "";
      var shown = global.HelmPhone && global.HelmPhone.display ? global.HelmPhone.display(e164) : e164;
      vPanel.appendChild(el("p", { class: "hpf-vinfo", id: idp + "_vlead" }, "We sent a 6-digit code on WhatsApp to " + shown + ". It expires in 10 minutes."));
      var boxes = el("div", { class: "hpf-otp", role: "group", "aria-labelledby": idp + "_vlead" });
      var cells = [];
      for (var i = 0; i < 6; i++) {
        var c = el("input", { class: "hpf-otpc", type: "text", inputmode: "numeric", maxlength: "1", autocomplete: i === 0 ? "one-time-code" : "off", "aria-label": "Digit " + (i + 1) + " of 6", "data-no-validate": "1" });
        cells.push(c); boxes.appendChild(c);
      }
      var vErr = el("p", { class: "hpf-e fv-msg", role: "alert" }); vErr.hidden = true;
      var acts = el("div", { class: "hau-row" });
      var resend = el("button", { type: "button", class: "hau-btn ghost" }, "Resend code");
      var cancel = el("button", { type: "button", class: "hau-btn ghost" }, "Use a different number");
      acts.appendChild(resend); acts.appendChild(cancel);
      vPanel.appendChild(boxes); vPanel.appendChild(vErr); vPanel.appendChild(acts);
      function code() { return cells.map(function (x) { return x.value; }).join(""); }
      function fail(t) { vErr.textContent = ""; vErr.appendChild(el("span", { class: "fv-ic", "aria-hidden": "true" }, "!")); vErr.appendChild(doc.createTextNode(t)); vErr.hidden = false; boxes.classList.add("is-bad"); }
      var checking = false;
      function submit() {
        var c = code(); if (c.length !== 6 || checking) return;
        checking = true; vErr.hidden = true; boxes.classList.remove("is-bad");
        PV.check(c).then(function (r) {
          if (r && r.ok) { verifiedPhone = e164; vPanel.hidden = true; vPanel.textContent = ""; vPaint(); clearInterval(coolT); return; }
          var why = r && r.reason;
          cells.forEach(function (x) { x.value = ""; });
          if (why === "locked") fail("Too many wrong tries. Request a new code.");
          else if (why === "expired") fail("This code has expired. Request a new one.");
          else fail("That code isn't right." + (r && r.remaining != null ? " " + r.remaining + (r.remaining === 1 ? " try" : " tries") + " left." : ""));
          try { cells[0].focus(); } catch (x) {}
        }, function (e) { fail(errText(e, "check the code")); }).then(function () { checking = false; });
      }
      cells.forEach(function (c, i) {
        c.addEventListener("input", function () {
          var d = c.value.replace(/\D/g, "");
          if (d.length > 1) { for (var k = 0; k < d.length && i + k < 6; k++) cells[i + k].value = d.charAt(k); try { cells[Math.min(5, i + d.length)].focus(); } catch (x) {} }
          else { c.value = d; if (d && i < 5) try { cells[i + 1].focus(); } catch (x) {} }
          if (code().length === 6) submit();
        });
        c.addEventListener("keydown", function (e) {
          if (e.key === "Backspace" && !c.value && i > 0) { e.preventDefault(); cells[i - 1].value = ""; cells[i - 1].focus(); }
          else if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); cells[i - 1].focus(); }
          else if (e.key === "ArrowRight" && i < 5) { e.preventDefault(); cells[i + 1].focus(); }
          else if (e.key === "Enter") { e.preventDefault(); submit(); }
        });
        c.addEventListener("paste", function (e) {
          var t = ((e.clipboardData || global.clipboardData) || { getData: function () { return ""; } }).getData("text").replace(/\D/g, "").slice(0, 6);
          if (!t) return; e.preventDefault();
          for (var k = 0; k < 6; k++) cells[k].value = t.charAt(k) || "";
          try { cells[Math.min(5, t.length)].focus(); } catch (x) {}
          if (t.length === 6) submit();
        });
      });
      resend.addEventListener("click", function () { sendCode(true); });
      cancel.addEventListener("click", function () { vPanel.hidden = true; vPanel.textContent = ""; clearInterval(coolT); try { inputs.phone.focus(); } catch (x) {} });
      startCooldown(60, resend);
      setTimeout(function () { try { cells[0].focus(); } catch (x) {} }, 30);
    }
    function sendCode(again) {
      var b = binds.phone, r = b ? b.check(true) : { ok: !!inputs.phone.value };
      if (!r.ok) { try { inputs.phone.focus(); } catch (x) {} return; }
      var e164 = inputs.phone.value;
      if (!PV || !PV.available || !PV.available()) { vInfo("Phone verification will be available shortly — you can continue."); return; }
      vBtn.disabled = true;
      if (!again) vInfo("Sending a code on WhatsApp…");
      PV.send(e164).then(function () { codePanel(e164); }, function (e) {
        if (e && e.code === "verify_unavailable") vInfo("Phone verification will be available shortly — you can continue.");
        else vInfo(/wait|too many/i.test(String(e && e.message)) ? "Please wait a minute before asking for another code." : "We couldn't send the code right now. You can continue and verify later from Account.");
      }).then(function () { vBtn.disabled = false; });
    }
    vBtn.addEventListener("click", function () { sendCode(false); });
    inputs.phone.addEventListener("input", function () { vPaint(); if (!vPanel.hidden && verifiedPhone !== inputs.phone.value) { /* keep an open code panel only for the same number */ } });
    if (PV && PV.available && PV.available() && PV.status) PV.status().then(function (s) { if (s && s.verified_at && s.phone) { verifiedPhone = s.phone; vPaint(); } });

    // ---- inline validation (on blur; live once touched) + phone component
    function wire() {
      var HP = global.HelmPhone, HV = global.HelmValidate;
      ["phone", "whatsapp", "emergency_contact_phone"].forEach(function (k) {
        if (HP && HP.attach && !inputs[k].helmPhone) { inputs[k].removeAttribute("data-phone-hardened"); HP.attach(inputs[k], { mobile: k !== "emergency_contact_phone" }); }
      });
      if (!HV || !HV.bind) return;
      var reqName = function () { return !!vopts.requireName; }, reqPhone = function () { return !!vopts.requirePhone; };
      binds.full_name = HV.bind(inputs.full_name, { rule: "name", label: "full name", required: reqName, max: 50, msgEl: errs.full_name, onChange: progress });
      binds.phone = HV.bind(inputs.phone, { rule: "phone", label: "mobile number", required: reqPhone, mobile: true, msgEl: errs.phone, onChange: function () { progress(); vPaint(); } });
      binds.whatsapp = HV.bind(inputs.whatsapp, { rule: "phone", label: "WhatsApp number", required: function () { return !same.checked; }, mobile: true, msgEl: errs.whatsapp, onChange: progress });
      binds.job_title = HV.bind(inputs.job_title, { rule: "text", label: "Job title", max: lim.text, msgEl: errs.job_title, onChange: progress });
      binds.department = HV.bind(inputs.department, { rule: "text", label: "Department", max: lim.text, msgEl: errs.department, onChange: progress });
      binds.city = HV.bind(inputs.city, { rule: "text", label: "City", max: lim.text, msgEl: errs.city, onChange: progress });
      binds.emergency_contact_name = HV.bind(inputs.emergency_contact_name, { rule: "name", label: "Contact name", article: false, max: 50, msgEl: errs.emergency_contact_name, onChange: progress });
      binds.emergency_contact_phone = HV.bind(inputs.emergency_contact_phone, { rule: "phone", label: "contact phone", msgEl: errs.emergency_contact_phone, onChange: progress });
      vPaint(); progress();
    }
    ensureFormLibs().then(wire, wire);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (busy) return;
      showAlert("");
      // 1) owner rules, inline (all fields marked as touched)
      var HV = global.HelmValidate, firstBad = null;
      if (HV && HV.checkAll) {
        var list = ORDER.filter(function (k) { return binds[k] && !(k === "whatsapp" && same.checked); }).map(function (k) { return binds[k]; });
        firstBad = HV.checkAll(list);
      }
      // 2) the SQL-mirror rules (what the server will accept)
      var fields = collect();
      var r = st.profile.validate(fields, vopts);
      if (!firstBad) ORDER.forEach(function (k) { if (r.errors[k]) setErr(k, r.errors[k]); });
      if (firstBad || !r.ok) {
        var bad = ORDER.filter(function (k) { return r.errors[k] || (binds[k] && binds[k].input.getAttribute("aria-invalid") === "true"); });
        bad.forEach(function (k) { var d = inputs[k].closest && inputs[k].closest("details"); if (d) d.open = true; });
        showAlert(bad.length > 1 ? "Please check the " + bad.length + " highlighted fields." : (r.errors[bad[0]] || "Please check the highlighted field."));
        try { inputs[bad[0] || "full_name"].focus(); } catch (x) {}
        return;
      }
      busy = true; save.disabled = true; save.classList.add("is-loading"); save.setAttribute("aria-busy", "true");
      var label = saveTx.textContent; saveTx.textContent = "Saving…";
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
        if (err && err.fields) { ORDER.forEach(function (k) { if (err.fields[k]) setErr(k, err.fields[k]); }); key = err.field || key; }
        else if (key) setErr(key, msg);
        showAlert(msg || errText(err, "save your profile"));
        try { (key && inputs[key] ? inputs[key] : alertBox).focus(); } catch (x) {}
      }).then(function () { busy = false; save.disabled = false; save.classList.remove("is-loading"); save.removeAttribute("aria-busy"); saveTx.textContent = label; });
    });
    progress(); vPaint();
    return {
      el: form,
      focusFirst: function () {
        var k = !String(inputs.full_name.value).trim() ? "full_name" : (!String(inputs.phone.value).trim() ? "phone" : "full_name");
        setTimeout(function () { try { inputs[k].focus(); } catch (e) {} }, 60);
      },
    };
  }
  // "Your profile" (Account panel) — falls back to the display-name section without 0041
  // r20-coord: soloHead = the panel opened on the profile alone - its <h2> already says "Your profile", so no second heading
  function profileSection(st, focusIt, soloHead) {
    var sec = el("div", { class: "hau-sec", id: "hauProfile" });
    if (!soloHead) sec.appendChild(el("h3", { id: "hauProfileTitle" }, "Your profile"));
    var body = el("div", null); body.appendChild(el("p", { class: "hau-muted" }, "Loading…"));
    sec.appendChild(body);
    Promise.resolve(st.profile.mine()).then(function (p) {
      if (!p || !("complete" in p)) { sec.replaceWith(displayNameSection(st)); return; }   // 0041 not installed
      body.textContent = "";
      body.appendChild(el("p", { class: "hau-muted" }, "Teammates see your name, job title, department and photo."));
      if (!p.complete) body.appendChild(el("p", { class: "hau-muted", style: "font-weight:600" }, "Add your full name and mobile number to complete your profile."));
      var u = st.auth.user() || {};
      var f = profileForm(st, { mode: "panel", idp: "hap", profile: p, email: u.email, labelledBy: soloHead ? "hauTitle" : "hauProfileTitle", submitLabel: "Save profile",
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
    clock: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["path", { d: "M12 7.5V12l3 2" }]],
    info: [["circle", { cx: "12", cy: "12", r: "8.5" }], ["path", { d: "M12 11v5M12 8h.01" }]],
    x: [["path", { d: "M6 6l12 12M18 6L6 18" }]]
  };
  var notes = []; var noteHost = null; var inlineHost = null; var NOTE_MAX = 2;
  // R20 (live QA): the floating "Complete your profile" card covered the bottom of the dashboard's NEW LEADS tile at
  // 1440x900. A notice shown with inline:true sits IN the page's notice slot ([data-hau-notes-slot]) when the page has one,
  // so it takes its own room; everywhere else (and every other notice) it floats as before.
  function noteSlot() { try { return doc.querySelector("[data-hau-notes-slot]"); } catch (e) { return null; } }
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
    var slot = noteSlot(), fl = 0, inl = 0;
    if (slot && !inlineHost) inlineHost = el("div", { class: "hau-notes is-inline", "aria-label": "Notices" });
    if (slot && inlineHost && inlineHost.parentNode !== slot) slot.appendChild(inlineHost);
    notes.forEach(function (n) {
      if (n.inline && slot && inlineHost) { n.node.hidden = false; inlineHost.appendChild(n.node); inl++; return; }
      n.node.hidden = fl >= max; fl++; if (noteHost) noteHost.appendChild(n.node);
    });
    if (slot) slot.hidden = !inl;
    // mobile: reserve room under the page so content scrolls clear of the floating notice
    try {
      var pad = (max === 1 && fl && noteHost) ? Math.ceil(noteHost.getBoundingClientRect().height) + 16 : 0;
      doc.body.classList.toggle("hau-notes-pad", pad > 0);
      if (pad) doc.body.style.setProperty("--hau-notes-pad", pad + "px"); else doc.body.style.removeProperty("--hau-notes-pad");
    } catch (e) {}
  }
  // Never float a notice over an open modal: it covered the modal's Save button, and a click on it
  // could land on the modal backdrop and trigger "Discard changes?". Hidden while a VISIBLE modal
  // is open (the bell panel etc. stay in the DOM with aria-modal, so check layout, not markup).
  var modalWatch = null, modalRaf = 0;
  function modalOpen() {
    return Array.prototype.some.call(doc.querySelectorAll("[aria-modal='true'], dialog[open]"), function (m) {
      if (noteHost && noteHost.contains(m)) return false;
      return !!m.offsetParent || m.getClientRects().length > 0;
    });
  }
  function syncNotesForModal() {
    modalRaf = 0;
    // R20: the page's notice slot appeared after an inline notice was shown (the dashboard draws late) -> move it in
    if (notes.some(function (n) { return n.inline; })) { var sl = noteSlot(); if (sl && (!inlineHost || inlineHost.parentNode !== sl)) layoutNotes(); }
    var hide = !!(notes.length && (modalOpen() || tourActive()));   // one prompt at a time: notices wait for the tour too
    if (noteHost && noteHost.hidden !== hide) noteHost.hidden = hide;   // only on change (the observer sees our own write)
  }
  function watchModals() {
    if (modalWatch || !global.MutationObserver || !doc.body) return;
    modalWatch = new MutationObserver(function () { if (!modalRaf) modalRaf = setTimeout(syncNotesForModal, 60); });
    modalWatch.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "open", "style"] });
  }
  function tourActive() {
    var t = doc.querySelector(".htour");
    return !!(t && !t.hidden && t.isConnected && t.getClientRects().length);
  }
  // showNote({id, priority (lower = more important), icon, tone, title, body, primary:{label,onClick}, secondary:{label,onClick}, onDismiss, dismissLabel})
  function showNote(o) {
    if (!doc.body || notes.some(function (n) { return n.id === o.id; })) return null;
    css();
    if (!noteHost || !noteHost.isConnected) { noteHost = el("div", { class: "hau-notes", "aria-label": "Notices" }); doc.body.appendChild(noteHost); }
    var card = el("div", { class: "hau-note" + (o.tone ? " " + o.tone : "") + (o.compact ? " compact" + (o.dock === false ? "" : " dock-left") : ""), id: o.id, role: o.role || "status", "aria-labelledby": o.id + "T" });
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
    notes.push({ id: o.id, priority: o.priority || 9, node: card, inline: o.inline === true });
    layoutNotes();
    watchModals(); syncNotesForModal();
    // non-blocking notices fold away by themselves (not while the pointer / focus is on them)
    if (o.autoHideMs > 0) (function tick() {
      setTimeout(function () {
        if (!card.isConnected) return;
        var busy = false; try { busy = card.matches(":hover") || card.contains(doc.activeElement); } catch (e) {}
        if (busy) { tick(); return; }
        if (o.onAutoHide) { try { o.onAutoHide(); } catch (e) {} }
        hideNote(o.id);
      }, o.autoHideMs);
    })();
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
      pBanner = showNote({ id: "hauProfileNudge", priority: 3, inline: true, icon: "user", title: "Complete your profile",
        body: "Add your mobile number so your team can reach you and assign you work.",
        primary: { label: "Complete now", onClick: function () { openAccount({ focus: "profile" }); } },
        secondary: { label: "Later", onClick: function () { st.profile.snoozeNudge(7); pBanner = null; } },
        onDismiss: function () { st.profile.snoozeNudge(7); pBanner = null; }, dismissLabel: "Dismiss — remind me in 7 days" });
    }).catch(function () {});
  }

  function renderMfaSection(box) {
    var st = S();
    var noPw = false; try { noPw = !!(st.auth.hasPassword && !st.auth.hasPassword()); } catch (e) {}   // r20 planner: Google sign-in wording
    st.auth.mfa.verifiedTotp().then(function (fs) {
      box.textContent = "";
      if (fs.length) {
        box.appendChild(el("p", { class: "hau-ok" }, "On — you enter a code from your authenticator app when you sign in."));
        var off = el("button", { type: "button", class: "hau-btn danger" }, "Turn off");
        var er = el("div", { class: "hau-err", role: "alert" });
        off.addEventListener("click", function () {
          var ask = global.BPUI && global.BPUI.confirm ? global.BPUI.confirm("Turn off two-step verification? Your account will be protected by " + (noPw ? "your Google sign-in" : "your password") + " only.", { title: "Turn off two-step verification", okLabel: "Turn off", danger: true }) : Promise.resolve(global.confirm("Turn off two-step verification?"));
          ask.then(function (yes) {
            if (!yes) return;
            off.disabled = true;
            Promise.all(fs.map(function (f) { return st.auth.mfa.unenroll(f.id); }))
              .then(function () { renderMfaSection(box); }, function (e) { er.textContent = errText(e, "turn off two-step verification"); off.disabled = false; });
          });
        });
        var row = el("div", { class: "hau-row" }); row.appendChild(off); box.appendChild(row); box.appendChild(er);
      } else {
        box.appendChild(el("p", { class: "hau-muted" }, noPw ? "Off. Turn it on so a Google account someone else gets into still can't open Helm without your code."
          : "Off. Turn it on so a stolen password alone can't open your account."));
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
        // 0203: never in the free trial (the trial studio is sample data; the strip is the only notice)
        if (doc.documentElement.classList.contains("helm-trial")) return;
        // at most once per browser session, and never on top of a tour step
        var SK = "hau_mfa_nudge_session";
        try { if (global.sessionStorage && sessionStorage.getItem(SK)) return; } catch (e) {}
        var tries = 0;
        function waitTour() {
          if (banner) return;
          if (tourActive() && tries++ < 200) { setTimeout(waitTour, 3000); return; }
          if (tourActive()) return;
          inTrialStudio().then(function (t) {
            if (t || banner) return;
            try { if (global.sessionStorage) sessionStorage.setItem(SK, "1"); } catch (e) {}
            showMfaNudge();
          });
        }
        setTimeout(waitTour, 2500);
      });
    }).catch(function () {});
  }
  // 0203: is the signed-in studio on its free trial? (the server's answer via trial-lock.js; false when unknown)
  function inTrialStudio() {
    try {
      if (global.HelmTrialLock && typeof global.HelmTrialLock.whenKnown === "function") return global.HelmTrialLock.whenKnown().then(function (v) { return v === true; }, function () { return false; });
      var st = S();
      if (st && st.subscription && typeof st.subscription.trial === "function")
        return Promise.resolve(st.subscription.trial()).then(function (t) { return !!(t && t.status === "trial"); }, function () { return false; });
    } catch (e) {}
    return Promise.resolve(false);
  }
  function showMfaNudge() {
        // 0203: compact and non-blocking - it stays in the notice stack (never over the page's own docked notices),
        // shows once per browser session and folds away by itself after 20 s
        banner = showNote({ id: "hauMfaNudge", priority: 2, icon: "shield", compact: true, dock: false, autoHideMs: 20000,
          onAutoHide: function () { banner = null; }, title: "Turn on two-step verification",
          body: "Admins control every user and setting — protect your studio with a code from your phone.",
          primary: { label: "Set up now", onClick: function () { openAccount(); } },
          secondary: { label: "Later", onClick: function () { snoozeNote("mfa", 3); banner = null; } },
          onDismiss: function () { snoozeNote("mfa", 3); banner = null; }, dismissLabel: "Dismiss — remind me in 3 days" });
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

  /* ------------------------------- profile menu (avatar, top-right) ---------
     Replaces the old "Account" button + role/e-mail/Log out chip on signed-in studio
     pages (never HQ, never client pages). Like GitHub: a round avatar button opens a
     menu (role=menu) with the identity header, Profile, Account settings (profile,
     password, two-step verification), User manual (opens /manual in a new tab; only while
     config.js HELM_FEATURES.manual is true - hidden for now) and Sign out - for every role, free trial included. R19: Control Center, Insights and
     Customize dashboard left the menu (the sidebar and the dashboard already have them). Keyboard: Enter/Space/ArrowDown open, arrows/Home/End move, Esc closes
     and returns focus, Tab stays inside the open menu. Click outside closes.
     #helm-topbar-search is an empty slot left of the avatar for the studio search. */
  var AV_COLORS = 8;
  function avColorIdx(seed) {
    var h = 0; seed = String(seed || "");
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return h % AV_COLORS;
  }
  // pure (unit-tested): what the menu shows for a user / profile / role
  function menuModel(u, prof, role) {
    u = u || {}; prof = prof || {};
    var name = String(prof.full_name || "").trim();
    var email = String(u.email || prof.email || "");
    var st = S(), label = role && st && st.auth && st.auth.admin && st.auth.admin.roleLabel ? st.auth.admin.roleLabel(role) : (role || "");
    // R19: only account items - Control Center + Insights live in the sidebar (Admin), Customize on the dashboard
    var items = [
      { id: "profile", label: "Profile" },
      { id: "settings", label: "Account settings" },
    ];
    // r20 coord: the user manual follows config.js HELM_FEATURES.manual ("admin" = studio admin only)
    var manualFlag = typeof window !== "undefined" && window.HELM_FEATURES ? window.HELM_FEATURES.manual : false;
    if (manualFlag === true || (manualFlag === "admin" && role === "admin"))
      items.push({ id: "manual", label: "User manual", href: "manual.html", newTab: true });
    items.push({ id: "signout", label: "Sign out", sep: true });
    return { name: name || email.split("@")[0] || "Account", email: email, role: label,
      initials: initials(name, email), color: avColorIdx(u.id || email),
      avatarPath: typeof prof.avatar_path === "string" && prof.avatar_path ? prof.avatar_path : null, items: items };
  }
  function menuHidden() {
    var p = pageName(); if (p === "hq" || p === "login" || p === "portal") return true;
    var st = S(); var r = st && st.auth.cachedRole ? st.auth.cachedRole() : null;
    return r === "client";
  }
  var menu = { root: null, btn: null, pop: null, open: false, model: null, avImgs: [], btnImg: null };
  function avatarNode(m, cls) {
    var w = el("span", { class: "hau-av hau-c" + m.color + (cls ? " " + cls : ""), "aria-hidden": "true" });
    w.appendChild(el("span", { class: "hau-av-i" }, m.initials));
    var img = el("img", { alt: "", class: "hau-av-img" }); img.hidden = true;
    img.addEventListener("error", function () { img.hidden = true; });
    img.addEventListener("load", function () { img.hidden = false; });
    w.appendChild(img); menu.avImgs.push(img);
    return w;
  }
  function paintAvatar(path) {
    var st = S();
    var imgs = menu.avImgs.filter(function (i) { return i.isConnected; }); menu.avImgs = imgs;
    if (!path || !st || !st.profile || !st.profile.avatarUrl) { imgs.forEach(function (i) { i.hidden = true; i.removeAttribute("src"); }); return; }
    Promise.resolve(st.profile.avatarUrl(path)).then(function (url) {
      if (!url || !/^(https:|blob:|http:\/\/localhost)/.test(String(url))) return;
      imgs.forEach(function (i) { if (i.getAttribute("src") !== url) i.src = url; });
    }, function () {});
  }
  var MI_ICONS = {
    profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5",
    settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4",
    manual: "M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h11M9 8h5",
    signout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10",
  };
  function menuItems() { return menu.pop ? Array.prototype.slice.call(menu.pop.querySelectorAll("[role=menuitem]")) : []; }
  function focusItem(i) { var it = menuItems(); if (!it.length) return; i = (i + it.length) % it.length; try { it[i].focus(); } catch (e) {} }
  // the app shell moves the button + menu (.hau-mw) out of #hauTopbar into the rail, so "inside" is
  // the menu / its button wherever they live (was: root only -> a press on "Sign out" closed the menu
  // on mousedown, before its click could run)
  function outside(e) {
    var t = e.target;
    if ((menu.pop && menu.pop.contains(t)) || (menu.btn && menu.btn.contains(t)) || (menu.root && menu.root.contains(t))) return;
    closeMenu(false);
  }
  // QA1026 #11: Escape anywhere on the page closes the menu through closeMenu, so
  // aria-expanded on #hauAccountBtn is reset too (not only Escape from a menu item).
  function escDoc(e) { if (e.key === "Escape" && menu.open) closeMenu(true); }
  function closeMenu(refocus) {
    if (!menu.open) return; menu.open = false;
    if (menu.pop) menu.pop.hidden = true;
    if (menu.btn) menu.btn.setAttribute("aria-expanded", "false");
    try { doc.documentElement.classList.remove("hau-menu-open"); } catch (e) {}
    doc.removeEventListener("mousedown", outside, true); doc.removeEventListener("touchstart", outside, true);
    doc.removeEventListener("keydown", escDoc);
    if (refocus && menu.btn) try { menu.btn.focus(); } catch (e) {}
  }
  function openMenu(focusLast) {
    if (!menu.pop) return;
    buildPop(); menu.open = true; menu.pop.hidden = false;
    menu.btn.setAttribute("aria-expanded", "true");
    // the open menu sits above every floating note / banner (they otherwise cover "Sign out")
    try { doc.documentElement.classList.add("hau-menu-open"); } catch (e) {}
    doc.addEventListener("mousedown", outside, true); doc.addEventListener("touchstart", outside, true);
    doc.addEventListener("keydown", escDoc);
    focusItem(focusLast ? -1 : 0);
  }
  function runItem(id) {
    closeMenu(id !== "signout");
    var st = S();
    if (id === "profile") return openAccount({ section: "profile" });
    if (id === "settings") return openAccount({ section: "settings" });
    if (id === "signout") {
      var lo = doc.getElementById("logoutBtn");
      if (lo) { lo.click(); return; }                     // keeps each page's own sign-out (unsaved-changes checks)
      if (st) st.auth.signOut().then(function () { location.replace("login.html"); });
    }
  }
  // r19-studio-name: the menu header says which studio you are signed in to - "[Admin] at Call · Hyderabad", tooltip
  // "Signed in as <name> · <role> at <studio>". BPStore.org.identity() is the per-tab cached studio row (no extra request
  // on a warm tab); a rename repaints the open menu through the "helm:studio" event.
  function menuStudioLine(who, head, m) {
    var row = el("div", { class: "hau-mh-r" });
    if (m.role) row.appendChild(el("span", { class: "hau-chip" }, m.role));
    var at = el("span", { class: "hau-mh-s" }); at.hidden = true; row.appendChild(at);
    who.appendChild(row);
    function fill(name) {
      if (!name || !at.isConnected) return;
      at.textContent = ""; at.appendChild(doc.createTextNode(m.role ? "at " : "")); at.appendChild(el("b", null, name)); at.hidden = false; at.title = name;
      head.title = "Signed in as " + m.name + (m.role ? " \u00b7 " + m.role : "") + " at " + name;
    }
    menu.studioFill = fill;   // the open menu's line (a rename repaints it in place: focus stays where it is)
    if (menu.studio) fill(menu.studio);
    var st = S();
    if (st && st.org && typeof st.org.identity === "function") Promise.resolve(st.org.identity()).then(function (d) {
      if (d && d.name) { menu.studio = d.name; fill(d.name); }
    }, function () {});
    if (!menu.studioEv) { menu.studioEv = true;
      window.addEventListener("helm:studio", function (e) { var d = e && e.detail; if (!d || !d.name) return; menu.studio = d.name; if (menu.studioFill) menu.studioFill(d.name); }); }
  }
  function buildPop() {
    var m = menu.model, pop = menu.pop; if (!m || !pop) return;
    pop.textContent = ""; menu.avImgs = menu.avImgs.filter(function (i) { return i === menu.btnImg; });
    var head = el("div", { class: "hau-mh", role: "presentation" });
    head.appendChild(avatarNode(m, "hau-av-lg"));
    var who = el("div", { class: "hau-mh-t" });
    who.appendChild(el("p", { class: "hau-mh-n" }, m.name));
    if (m.email) who.appendChild(el("p", { class: "hau-mh-e" }, m.email));
    menuStudioLine(who, head, m);   // r19-studio-name: "<role> at <Studio>" (was: the role chip alone)
    head.appendChild(who); pop.appendChild(head);
    m.items.forEach(function (it) {
      if (it.sep) pop.appendChild(el("div", { class: "hau-msep", role: "separator" }));
      var node = it.href ? el("a", it.newTab ? { href: it.href, class: "hau-mi", role: "menuitem", tabindex: "-1", target: "_blank", rel: "noopener noreferrer" }
          : { href: it.href, class: "hau-mi", role: "menuitem", tabindex: "-1" })
        : el("button", { type: "button", class: "hau-mi" + (it.id === "signout" ? " is-out" : ""), role: "menuitem", tabindex: "-1" });
      node.setAttribute("data-mi", it.id);
      node.appendChild(pathIcon(MI_ICONS[it.id] || MI_ICONS.profile, "hau-mi-ic"));
      node.appendChild(el("span", null, it.label));
      node.addEventListener("click", function () { if (it.href) closeMenu(false); else runItem(it.id); });
      pop.appendChild(node);
    });
    paintAvatar(m.avatarPath);
  }
  function refreshMenuIdentity() {
    var st = S(); if (!st || !menu.btn) return;
    var u = st.auth.user(); if (!u) return;
    Promise.all([
      Promise.resolve().then(function () { return st.profile && st.profile.mine ? st.profile.mine() : null; }).catch(function () { return null; }),
      Promise.resolve().then(function () { return st.auth.role ? st.auth.role() : null; }).catch(function () { return null; }),
    ]).then(function (r) {
      if (r[1] === "client") { if (menu.root) menu.root.remove(); return; }
      var m = menuModel(u, r[0], r[1]);
      menu.model = m;
      var ini = menu.btn.querySelector(".hau-av-i"); if (ini) ini.textContent = m.initials;
      var av = menu.btn.querySelector(".hau-av"); if (av) av.className = "hau-av hau-c" + m.color;
      menu.btn.setAttribute("aria-label", "Open profile menu for " + m.name);
      if (menu.open) buildPop();
      paintAvatar(m.avatarPath);
    });
  }
  function placeAccountButton() {
    var lo = doc.getElementById("logoutBtn");
    if (!lo || !lo.parentNode || menuHidden()) return;
    var host = lo.parentNode;
    // the role / e-mail chip and Log out live in the menu now (Log out stays in the DOM,
    // hidden, so "Sign out" still runs the page's own handler)
    Array.prototype.forEach.call(host.children, function (c) {
      if (c.id === "hauTopbar") return;
      if (c === lo || (c.tagName === "SPAN" && /\b(role|who)\b/.test(c.className || "")) || (c.tagName === "SPAN" && !c.className && c.textContent.indexOf("@") > 0)) c.classList.add("hau-gone");
    });
    host.classList.add("hau-host");
    if (menu.root && menu.root.isConnected && menu.root.parentNode === host) return;
    var old = doc.getElementById("hauTopbar"); if (old) old.remove();
    var st = S(), u = st && st.auth.user(); if (!u) return;
    css();
    var m = menuModel(u, null, st.auth.cachedRole ? st.auth.cachedRole() : null);
    menu.model = m; menu.avImgs = [];
    var root = el("div", { id: "hauTopbar", class: "hau-tb" });
    root.appendChild(el("div", { id: "helm-topbar-search", class: "hau-tb-slot" }));   // studio search mounts here
    var wrap = el("div", { class: "hau-mw" });
    var btn = el("button", { type: "button", id: "hauAccountBtn", class: "hau-avbtn", "aria-haspopup": "menu", "aria-expanded": "false",
      "aria-controls": "hauMenu", "aria-label": "Open profile menu for " + m.name, title: "Profile and account" });
    var av = avatarNode(m); btn.appendChild(av); menu.btnImg = av.querySelector("img");
    var pop = el("div", { id: "hauMenu", class: "hau-menu", role: "menu", "aria-labelledby": "hauAccountBtn" }); pop.hidden = true;
    wrap.appendChild(btn); wrap.appendChild(pop); root.appendChild(wrap);
    menu.root = root; menu.btn = btn; menu.pop = pop; menu.open = false;
    btn.addEventListener("click", function () { if (menu.open) closeMenu(true); else openMenu(false); });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openMenu(e.key === "ArrowUp"); }
    });
    pop.addEventListener("keydown", function (e) {
      var it = menuItems(), i = it.indexOf(doc.activeElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === "ArrowDown") { e.preventDefault(); focusItem(i + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(i - 1); }
      else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
      else if (e.key === "End") { e.preventDefault(); focusItem(-1); }
      else if (e.key === "Tab") { e.preventDefault(); focusItem(e.shiftKey ? i - 1 : i + 1); }   // focus stays in the open menu
      else if (e.key.length === 1 && /\S/.test(e.key)) {                                        // type-ahead
        var k = e.key.toLowerCase();
        for (var n = 1; n <= it.length; n++) { var c = it[(i + n) % it.length]; if (c.textContent.trim().toLowerCase().charAt(0) === k) { c.focus(); break; } }
      }
    });
    host.insertBefore(root, lo);
    refreshMenuIdentity();
  }
  /* ------------------------------- Helm subscription (0045): read-only banner + Control Center card */
  var subBanner = null;
  function money2(v, cur) {
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", maximumFractionDigits: 2 }).format(Number(v) || 0); }
    catch (e) { return (cur || "INR") + " " + (Number(v) || 0).toFixed(2); }
  }
  // QA B2: a calendar day ("2026-10-29", e.g. trial_ends_at) is never shifted by a time zone (new Date("YYYY-MM-DD")
  // is UTC midnight, which showed the day before in a zone west of UTC); a timestamp is shown in the STUDIO's zone.
  // India format ("29 Oct 2026"), the same as BPStore.fmtStudioDate.
  function day(v) {
    if (!v) return "—";
    var s = typeof v === "string" ? v.trim() : v, m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
    var f = { day: "numeric", month: "short", year: "numeric" };
    try {
      var st = S();
      if (st && typeof st.fmtStudioDate === "function") { var out = st.fmtStudioDate(s, { style: "long" }); if (out) return out; }
    } catch (e) {}
    try {
      if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString("en-IN", Object.assign({ timeZone: "UTC" }, f));
      var d = new Date(s); if (isNaN(d.getTime())) return String(v);
      return d.toLocaleDateString("en-IN", f);
    } catch (e) { return String(v); }
  }
  // L9 (live QA): the trial end on Plan & billing is the STUDIO's calendar day of the exact end moment - the same day
  // the trial strip, the reminders and the Staff page show (trial.js endDay). studio_subscriptions.trial_ends_at is a
  // bare day that sign-up stored as the UTC day (26 Oct for an end at 27 Oct 03:30 IST), so it is only the fallback.
  // t = my_trial_org() (exact ends_at + timezone) and/or my_trial_status() (0223: ends_at_exact + timezone).
  function zoneDay(ms, tz) {
    var zones = [tz || "Asia/Kolkata", "Asia/Kolkata"];
    for (var i = 0; i < zones.length; i++) {
      try {
        var o = {}; new Intl.DateTimeFormat("en-CA", { timeZone: zones[i], year: "numeric", month: "2-digit", day: "2-digit" })
          .formatToParts(new Date(ms)).forEach(function (x) { o[x.type] = x.value; });
        if (o.year && o.month && o.day) return o.year + "-" + o.month + "-" + o.day;
      } catch (e) {}
    }
    return new Date(ms).toISOString().slice(0, 10);
  }
  function studioTz(st) { try { return st && typeof st.studioTimezone === "function" ? st.studioTimezone() : undefined; } catch (e) { return undefined; } }
  function trialEndDay(sub, org, ts, tz) {
    var exact = null, zone = null;
    if (org && org.is_trial_org === true && org.ends_at) { exact = org.ends_at; zone = org.timezone; }
    else if (ts && ts.ends_at_exact) { exact = ts.ends_at_exact; zone = ts.timezone; }
    var e = exact ? Date.parse(exact) : NaN;
    if (isFinite(e)) {
      var H = global.HelmTrial;
      if (H && typeof H.endDay === "function") { var d = H.endDay(exact, zone || tz); if (d) return d; }
      return zoneDay(e - 1, zone || tz);
    }
    if (ts && /^\d{4}-\d{2}-\d{2}$/.test(String(ts.ends_at || "")) && ts.timezone) return String(ts.ends_at);   // 0223: already the studio day
    return sub && sub.trial_ends_at ? sub.trial_ends_at : null;
  }
  function subscriptionCard(st, sub, org, ts) {
    var box = doc.getElementById("subCard"); if (!box) return;
    var body = doc.getElementById("subBody"); if (!body) return;
    if (!sub || !("payments" in sub)) { box.hidden = true; return; }        // admins only (the DB decides)
    css(); box.hidden = false; body.textContent = "";
    var plan = sub.plan || {};
    var line = (plan.name || "No plan yet") + (plan.price_monthly != null ? " · " + money2(plan.price_monthly, plan.currency) + " / month" : "");
    body.appendChild(el("p", { class: "hau-muted", style: "font-weight:600" }, line));
    body.appendChild(el("p", { class: "hau-muted" }, "Status: " + String(sub.status || "not set").replace("_", " ") +
      (sub.current_period_end ? " · current period ends " + day(sub.current_period_end) : "") +
      (sub.trial_ends_at ? " · trial ends " + day(trialEndDay(sub, org, ts, studioTz(st)) || sub.trial_ends_at) : "")));
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
    ["primary_contact_name", "Primary contact name"], ["primary_contact_email", "Primary contact e-mail"], ["primary_contact_phone", "Primary contact phone"],
    ["secondary_contact_name", "Secondary contact name"], ["secondary_contact_email", "Secondary contact e-mail"], ["secondary_contact_phone", "Secondary contact phone"],
    ["billing_contact_email", "Billing e-mail"], ["team_size_band", "Team size (1, 2-5, 6-15, 16-50, 51+)"], ["signup_source", "How did you hear about Helm?"],
    ["business_type", "Business type (wedding, corporate, decor, catering, other)"], ["events_per_month_band", "Events per month (0-2, 3-5, 6-10, 11-20, 21+)"],
    ["preferred_contact_method", "Preferred contact (whatsapp, phone, email)"], ["preferred_language", "Preferred language (e.g. en, hi)"],
    ["is_business", "Registered business? (true / false)"], ["tax_id_type", "Tax ID type"],
    ["tax_id", "Tax ID"], ["pan", "PAN (India only)"], ["billing_currency", "Billing currency (e.g. INR, USD)"], ["referred_by", "Referred by"]];
  // B12: human labels for the tax-ID type (stored values unchanged)
  var TAX_ID_TYPES = [["", "-"], ["IN_GSTIN", "India - GSTIN"], ["IN_PAN", "India - PAN"], ["AE_TRN", "UAE - TRN (VAT)"], ["US_EIN", "USA - EIN"],
    ["UK_VAT", "UK - VAT number"], ["EU_VAT", "EU - VAT number"], ["AU_ABN", "Australia - ABN"], ["CA_GST", "Canada - GST/HST number"], ["SG_GST", "Singapore - GST reg. no."], ["OTHER", "Other"]];
  // B12: the "gstin" account field is the studio's tax ID - name it for the studio's country
  function accLabel(f, a, st) {
    if (f[0] !== "gstin") return f[1];
    var cc = String((a && a.country) || "").toUpperCase();
    try { if (!/^[A-Z]{2}$/.test(cc) && st.studioTax) cc = st.studioTax().country; } catch (e) {}
    try { return (st.tax ? st.tax.profile(cc || "IN").idLabel : "GSTIN") + " (optional)"; } catch (e) { return f[1]; }
  }
  function accountCard(st) {
    var box = doc.getElementById("accCard"), body = doc.getElementById("accBody");
    if (!box || !body || !st.subscription || !st.subscription.account) return;
    st.subscription.account().then(function (a) {
      if (!a || !a.can_edit) { box.hidden = true; return; }
      css(); box.hidden = false; body.textContent = "";
      var grid = el("div", { class: "hpf-grid" }), inputs = {};
      ACC_FIELDS.forEach(function (f) {
        var w = el("div", { class: "hpf-f" }), id = "acc_" + f[0];
        w.appendChild(el("label", { for: id, class: "hpf-l", id: id + "_lbl" }, accLabel(f, a, st)));
        var i, cur = a[f[0]] == null ? "" : String(a[f[0]]);
        if (f[0] === "tax_id_type") { i = el("select", { id: id, class: "hpf-i" });
          TAX_ID_TYPES.concat(cur && !TAX_ID_TYPES.some(function (t) { return t[0] === cur; }) ? [[cur, cur]] : []).forEach(function (t) { var o = el("option", { value: t[0] }, t[1]); i.appendChild(o); }); }
        else i = el("input", { id: id, class: "hpf-i", type: /_phone$/.test(f[0]) ? "tel" : (/_email$/.test(f[0]) ? "email" : "text") });
        i.value = cur; inputs[f[0]] = i;
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
    // L9: the exact trial end (my_trial_org / my_trial_status) so the card shows the studio's day, not the UTC day
    var orgQ = st.trialOrg && st.trialOrg.status ? Promise.resolve().then(function () { return st.trialOrg.status(); }).catch(function () { return null; }) : Promise.resolve(null);
    var tsQ = st.subscription.trial ? Promise.resolve().then(function () { return st.subscription.trial(); }).catch(function () { return null; }) : Promise.resolve(null);
    Promise.all([st.subscription.mine(), orgQ, tsQ]).then(function (all) {
      var sub = all[0];
      subscriptionCard(st, sub, all[1], all[2]);
      if (!sub || !sub.read_only || subBanner || !doc.body) return;
      subBanner = showNote({ id: "hauReadOnly", priority: 1, icon: "lock", tone: "warn", title: "Read-only: subscription suspended — contact Helm",
        body: "You can view and export everything, but nothing can be created, changed or deleted until it is reactivated." });
    }).catch(function () {});
  }

  /* ------------------------------- free-trial notice (0058) — studio admins only */
  // Pure (unit-tested): my_trial_status() answer → notice spec, or null (no notice).
  //   trial, > 3 days → calm, dismissible (snoozed for a day); trial, <= 3 days → urgent,
  //   dismissible; ended → urgent, NOT dismissible. Members / clients / paid studios → null.
  function trialNotice(t) {
    if (!t || typeof t !== "object" || t.is_admin !== true || t.can_pay !== true) return null;
    if (t.state === "ended") return { id: "hauTrialNote", tone: "urgent", urgent: true, dismissible: false,
      title: "Your trial has ended — choose a plan to keep using Helm",
      body: "Your data is safe. Pick a plan to keep your team, events and clients running." };
    if (t.state !== "trial") return null;
    var n = Math.max(0, Math.floor(Number(t.days_left)));
    if (!isFinite(n)) return null;
    var when = n === 0 ? "today" : n === 1 ? "tomorrow" : "in " + n + " days";
    var urgent = n <= 3;
    return { id: "hauTrialNote", tone: urgent ? "urgent" : "", urgent: urgent, dismissible: true,
      title: "Your free trial ends " + when, body: urgent ? "Choose a plan now so nothing stops on your studio." : "Choose a plan to keep using Helm after your trial." };
  }
  // QA B2/B3 (pure): is this studio on its free trial (running or ended, not yet paid)? my_trial_status() status
  // 'trial' / state 'trial', or html.helm-trial (trial-lock.js: the server said "trial")
  function onTrial(t) {
    // the server's answer wins when we have it (a studio that just paid still has the cached early class for a moment)
    if (t && typeof t === "object" && ("state" in t || "status" in t)) return t.state === "trial" || t.status === "trial";
    try { return !!(doc && doc.documentElement && doc.documentElement.classList.contains("helm-trial")); } catch (e) { return false; }
  }
  function trialDismissedThisSession(key) { try { return sessionStorage.getItem("helm_trial_dismissed_" + key) === "1"; } catch (e) { return false; } }
  var trialShown = false;
  function trialStatus() {
    var st = S(); if (!st || !st.auth.user() || !st.subscription || !st.subscription.trial) return;
    if (pageName() === "checkout") return;
    var demoQ = st.demo && st.demo.status ? st.demo.status().catch(function () { return null; }) : Promise.resolve(null);
    // 0119: a self-serve trial studio already shows the ONE trial strip (trial.js) — no second notice
    var orgQ = st.trialOrg && st.trialOrg.status ? st.trialOrg.status().catch(function () { return null; }) : Promise.resolve(null);
    Promise.all([st.subscription.trial(), demoQ, orgQ]).then(function (both) {
      var t = both[0], d = both[1], o = both[2];
      // 0180: during the free trial the trial strip is the only notice ("Free trial · N days left" +
      // "Choose a plan"): no "You're exploring demo data" card with its own set-up action.
      // QA B2: "in the trial" is the SUBSCRIPTION's answer (my_trial_status status 'trial', the same rule trial-lock.js
      // uses for html.helm-trial), not only a start_trial() studio (my_trial_org is_trial_org): a trial studio made
      // another way used to get the old "ends in N days / Set up your studio" card + the demo-data card instead.
      if (!onTrial(t)) demoStatus(t, d);
      // the trial strip (trial.js) shows "Free trial · N days left" for every running trial; this notice is only
      // for a trial that has ENDED on a studio the strip does not cover
      var spec = (o && o.is_trial_org === true) || (t && t.state === "trial") ? null : trialNotice(t);
      if (!spec || trialShown || !doc.body) return;
      var key = "trial_" + String(t.ends_at || "") + (spec.urgent ? "_u" : "");
      if (spec.dismissible && (noteSnoozed(key) || trialDismissedThisSession(key))) return;
      trialShown = true;
      showNote({ id: spec.id, priority: spec.urgent ? 1 : 4, icon: "clock", tone: spec.tone, role: spec.urgent ? "alert" : "status", compact: true,
        title: spec.title, body: spec.dismissible ? "" : spec.body,
        primary: { label: "Choose a plan", onClick: function () { try { location.assign("checkout.html?next=" + encodeURIComponent(pageName() + ".html")); } catch (e) {} } },
        // QA B3: no "Set up your studio" (= remove the samples) here: the trial keeps its sample data
        secondary: null,
        onDismiss: spec.dismissible ? function () { snoozeNote(key, 1); try { sessionStorage.setItem("helm_trial_dismissed_" + key, "1"); } catch (e) {} } : null, dismissLabel: "Dismiss — remind me tomorrow" });
    }).catch(function () {});
  }

  /* ------------------------------- demo data banner (0097) */
  // Pure (unit-tested): my_demo_status() + my_trial_status() → banner spec, or null.
  //   demo mode with demo rows → "You're exploring demo data" (dismissible for this session);
  //   once the studio has converted (no trial any more) → "set up your studio" prompt.
  //   Only admins get the action button; everyone in a demo studio sees the banner.
  function demoNotice(d, t) {
    if (!d || typeof d !== "object" || d.trial_mode !== "demo" || d.has_demo !== true) return null;
    var converted = !!(t && typeof t === "object" && t.state === "none");
    // 0185: after upgrading the admin chose to keep the sample data (tagged Sample): no reminder banner
    if (converted && d.demo_choice === "keep") return null;
    return { id: "hauDemoNote", tone: "", converted: converted,
      title: converted ? "Your plan is active — your studio still shows demo data" : "You're exploring demo data",
      body: converted ? "Set up your studio with your own clients, menu and team." : "Everything marked \u201cDemo \u00b7\u201d is sample data. No messages or payments go out for it.",
      action: d.is_admin === true ? (converted ? "Set up your studio \u2192" : "Start onboarding with your data \u2192") : null };
  }
  function goDemoSwitch() {
    try {
      if (onTrial(null)) return;   // QA B3: never offered during the trial (the sample data stays for the whole trial)
      if (pageName() === "dashboard" && global.HelmTrialDemo && global.HelmTrialDemo.openSwitch) { global.HelmTrialDemo.openSwitch(); return; }
      location.assign("dashboard.html?demo=switch");
    } catch (e) {}
  }
  var demoShown = false;
  function demoStatus(t, d) {
    var spec = demoNotice(d, t);
    if (!spec || demoShown || !doc.body || pageName() === "checkout") return;
    var key = "helm_demo_dismissed_" + (spec.converted ? "c" : "d");
    try { if (sessionStorage.getItem(key) === "1") return; } catch (e) {}
    // QA1019: once per session off the dashboard - the trial ribbon already says "sample data" on every
    // page, and on phones the card re-covered content above the bottom nav on every navigation.
    try { if (pageName() !== "dashboard" && sessionStorage.getItem("helm_demo_seen") === "1") return; sessionStorage.setItem("helm_demo_seen", "1"); } catch (e) {}
    demoShown = true;
    showNote({ id: spec.id, priority: 3, icon: "info", tone: spec.tone, role: "status", compact: true, title: spec.title, body: spec.body,
      primary: spec.action ? { label: spec.action, onClick: goDemoSwitch } : null,
      onDismiss: function () { try { sessionStorage.setItem(key, "1"); } catch (e) {} }, dismissLabel: "Hide for this session" });
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
    /* perf (Oct 2026): the two-step NUDGE needs listFactors (= a GET /auth/v1/user round trip); it is display-only,
       so it waits for idle. When two-step is REQUIRED for admins it still runs at once (forced enrolment). The sign-in
       gate (aal check in store-api evaluateGate) is unchanged and still runs before the page opens. */
    var st0 = S(), mfaReq = false; try { mfaReq = !!(st0 && st0.auth.mfa.requiredForAdmins()); } catch (e) {}
    if (mfaReq) adminTwoStep();
    else { var idle2 = function () { if (global.requestIdleCallback) global.requestIdleCallback(adminTwoStep, { timeout: 5000 }); else setTimeout(adminTwoStep, 2000); };
      if (doc.readyState === "complete") setTimeout(idle2, 2000); else global.addEventListener("load", function () { setTimeout(idle2, 2000); }, { once: true }); }
    profileNudge();
    subscriptionStatus();
    trialStatus();
    accountCard(S());
  }

  global.HelmAuthUI = {
    mountAppChrome: mountAppChrome,
    openAccount: openAccount,
    mountCaptcha: mountCaptcha,
    renderEnroll: renderEnroll,
    profileForm: profileForm,
    menuModel: menuModel,
    refreshMenu: refreshMenuIdentity,
    showNote: showNote,
    hideNote: hideNote,
    trialNotice: trialNotice,
    demoNotice: demoNotice,
    onTrial: onTrial,
    _day: day,
    _trialEndDay: trialEndDay,
    _safeQr: safeQr,
  };
})(window);
