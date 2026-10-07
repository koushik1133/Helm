/* =========================================================================
   BPStore — shared persistence for the landing page + builder.
   Tiered backend, chosen once at init(), with graceful fallback:
     1. Supabase        (when window.SUPABASE_CONFIG.url + anonKey are set)
     2. Node REST API   (/api/layouts, served by server.js)
     3. localStorage    (this browser only — ultimate offline fallback)

   Normalised shapes:
     summary = { id, name, createdAt, updatedAt, objectCount }
     layout  = { id, name, createdAt, updatedAt, data }   (data = { items:[...] , ... })
   ========================================================================= */
/* Phase 54 — apply the saved light/dark theme synchronously (before the body
   paints, so there is no flash), and mount a floating theme toggle on every page. */
(function () {
  try { var t = localStorage.getItem("bp_theme"); if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); } catch (e) {}
  function mountToggle() {
    if (document.getElementById("bpThemeToggle") || !document.body) return;
    // Pages can opt out of the floating light/dark toggle (e.g. the public
    // invitation page, which has its own template themes) via a meta tag.
    if (document.querySelector('meta[name="bp-theme-toggle"][content="off"]')) return;
    var b = document.createElement("button");
    b.id = "bpThemeToggle"; b.className = "bp-theme-toggle"; b.type = "button"; b.title = "Toggle light / dark";
    var sync = function () { b.textContent = (document.documentElement.getAttribute("data-theme") === "dark") ? "☀" : "☾"; };
    sync();
    b.addEventListener("click", function () {
      var d = (document.documentElement.getAttribute("data-theme") === "dark") ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", d);
      try { localStorage.setItem("bp_theme", d); } catch (e) {}
      sync();
    });
    document.body.appendChild(b);
  }
  if (document.readyState !== "loading") mountToggle(); else document.addEventListener("DOMContentLoaded", mountToggle);
})();

/* ---- global "logo = home" wiring -------------------------------------
   The Helm brand block (icon + wordmark) should take you back to your events
   from every page. Historically only the small icon linked home, and only on
   some pages. This makes the WHOLE brand a home link everywhere, in one place,
   without editing each page's markup. */
(function () {
  function wireHome() {
    try {
      var page = (location.pathname.split("/").pop() || "dashboard.html").toLowerCase().replace(/\.html$/, "") || "index";
      if (page === "index" || page === "welcome" || page === "login") return;   // home / auth pages: no self-link
      // client-facing token pages: clients have no dashboard to go "home" to
      if (/^(approve|portal|proposal-view|invite|work|sim-pay)$/.test(page) || location.pathname.indexOf("/i/") === 0) return;
      var mark = document.querySelector("header .mark") || document.querySelector(".mark");
      if (!mark) return;
      if (mark.tagName !== "A" && mark.closest("a[href]")) return;   // brand already WRAPPED in one home link (e.g. builder)
      var goHome = function () { location.href = "dashboard.html"; };
      if (mark.tagName === "A") { if (!mark.getAttribute("href")) mark.setAttribute("href", "dashboard.html"); }
      else {
        mark.style.cursor = "pointer"; mark.setAttribute("role", "link"); mark.setAttribute("title", "Home"); mark.setAttribute("tabindex", "0");
        mark.addEventListener("click", goHome);
        mark.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); } });
      }
      var text = mark.nextElementSibling;   // the wordmark block (holds the <h1>)
      if (text && text.querySelector && text.querySelector("h1")) {
        text.style.cursor = "pointer"; text.setAttribute("title", "Home");
        text.addEventListener("click", function (e) { if (e.target.closest("a,button,input,select,textarea,label")) return; goHome(); });
      }
    } catch (e) {}
  }
  if (document.readyState !== "loading") wireHome(); else document.addEventListener("DOMContentLoaded", wireHome);
})();

(function (global) {
  // this script's own URL (captured synchronously at load) — used to resolve vendor/ files
  const SELF_SRC = (typeof document !== "undefined" && document.currentScript && document.currentScript.src) || "";
  const CFG = global.SUPABASE_CONFIG || {};
  const TABLE = CFG.table || "layouts";
  const LS_KEY = "bps.layouts";
  const API = "/api";
  // Warm the connection to the configured Supabase origin (DNS + TCP + TLS) while
  // supabase-js loads. Pages already preconnect to the production origin in <head>;
  // this covers staging / local. No-op when that origin is already preconnected.
  (function preconnectSupabase() {
    try {
      if (typeof document === "undefined" || !document.head || !CFG.url || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(CFG.url)) return;
      const origin = CFG.url.replace(/\/$/, "");
      if (document.querySelector('link[rel="preconnect"][href="' + origin + '"]')) return;
      const l = document.createElement("link");
      l.setAttribute("rel", "preconnect"); l.setAttribute("href", origin); l.setAttribute("crossorigin", "anonymous");
      document.head.appendChild(l);
    } catch (e) {}
  })();

  let mode = "local";           // resolved backend: 'supabase' | 'server' | 'local'
  let supa = null;              // Supabase client (lazy)
  let ready = null;             // init() promise
  let currentUser = null;       // signed-in Supabase user (or null)
  let roleCache = null;         // this user's RBAC role
  let accessCache = null;       // { role, map:{area:{view,edit}} | null } — the live access matrix for this user
  let rolePromise = null;       // in-flight getRole() (dedupes the parallel canView fan-out)
  let accessPromise = null;     // in-flight loadAccess()
  // Per-tab session cache (Wave 16 perf): a static multipage app re-fetches
  // profiles + role_access on EVERY page navigation, which makes tabs feel slow.
  // Cache them in sessionStorage for a short TTL, keyed to the user id, so
  // navigations within a tab reuse them. RLS on the server is the real gate, so a
  // briefly-stale UI role/matrix cannot grant access — it only saves round-trips.
  const SESS_TTL = 60000;
  // Stale-while-revalidate (perf, Oct 2026): an entry older than SESS_TTL but younger
  // than SESS_STALE is still used for THIS navigation while a background re-check
  // refreshes it (studio id: a changed / revoked answer hides the page and reloads or
  // signs out; role / matrix: the next navigation picks up the new value). Entries are
  // only ever written after a successful server answer for the same user in this tab.
  const SESS_STALE = 10 * 60000;
  // Entries carry the user id they belong to: a cached role/matrix is ignored when a
  // DIFFERENT user is signed in (cross-tab account switch — audit session puzzling).
  function sessEntry(key, uid) {
    try {
      const raw = sessionStorage.getItem(key); if (!raw) return null; const o = JSON.parse(raw);
      const age = Date.now() - o.ts;
      if (!(age >= 0) || age > SESS_STALE) return null; if (!uid || o.uid !== uid) return null;
      return { val: o.val, age: age, fresh: age <= SESS_TTL };
    } catch (e) { return null; }
  }
  function sessGet(key, uid) { const e = sessEntry(key, uid); return e && e.fresh ? e.val : null; }
  function sessSet(key, uid, val) { try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), uid: uid || null, val: val })); } catch (e) {} }
  function sessClear() { try { sessionStorage.removeItem("bp_sess_role"); sessionStorage.removeItem("bp_sess_access"); sessionStorage.removeItem("bp_sess_org"); sessionStorage.removeItem(PROFILE_SESS_KEY); sessionStorage.removeItem(PW_OK_KEY); } catch (e) {} }
  const PROFILE_SESS_KEY = "bp_sess_profile";   // per tab: my_profile_status() answer (never a "must complete" one)
  const NUDGE_KEY = "helm_profile_nudge";       // localStorage {uid, until}: "complete your profile" banner snoozed
  const PW_OK_KEY = "bp_pw_ok";                 // per tab: "<uid>" once password_change_required() said no
  // Per-USER browser state that must not carry over to the next person who signs in
  // on a shared computer (audit Phase 4). Device prefs (theme, tours) are kept.
  const USER_LOCAL_KEYS = ["bps.clip", "wa_pin", "wa_mute", "wa_fav", "bp_chat_ping", "helm_org_country", "helm_ev_showall"];
  function userLocalClear() { USER_LOCAL_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} }); }
  let authRequired = false;     // true when Supabase enforces login (RLS) and nobody is signed in

  /* ---- sign-in steps, session limits, CAPTCHA (audit Phase 3-4 follow-up) ----
     pendingStep: a session exists but the person may NOT use the app yet:
       "mfa"      — has a verified authenticator but the session is only aal1
       "password" — signed in with a one-time temp password (must set their own)
       "recovery" — arrived via a password-reset link and hasn't set the new password
       "verify"   — the account status could not be checked (fail CLOSED)
     While a step is pending auth.user() returns null, so every page's gate
     (required() && !user()) sends the person to login.html, which finishes the step.
     Config (window.SUPABASE_CONFIG, all optional — defaults keep today's behaviour):
       captcha: { provider: "turnstile", siteKey: "" }       empty siteKey = off
       auth: { mfaRequiredForAdmins: false,
               session: { idleMinutes: 0, warnSeconds: 60, maxHours: 0 } }   0 = off (default) */
  let pendingStep = null;
  let localAuthOp = 0;                  // >0 while THIS tab is signing in (its own SIGNED_IN is not a cross-tab switch)
  let pwChangedAwaitingClear = false;   // forced change: password updated, flag not cleared yet
  // Password CHANGE (Account → Change password) proof: set only by a successful
  // reverifyPassword() for this same account, kept in memory (never stored), and
  // valid for REAUTH_MS. updatePassword() refuses without it unless the session is
  // a genuine password-reset session (signed JWT amr says "recovery").
  const REAUTH_MS = 10 * 60 * 1000;
  let reauth = null;                    // { uid, until, pw }
  function reauthClear() { reauth = null; }
  function reauthFresh() { return !!(reauth && currentUser && reauth.uid === currentUser.id && Date.now() < reauth.until); }
  // amr methods from the signed access token (Supabase signs it; a client cannot
  // forge "recovery"). Any decode problem → [] (fail closed).
  function jwtAmrMethods(token) {
    try {
      const part = String(token || "").split(".")[1]; if (!part) return [];
      const b64 = part.replace(/-/g, "+").replace(/_/g, "/"); const pad = b64 + "===".slice((b64.length + 3) % 4);
      const claims = JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(pad), (c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")));
      return Array.isArray(claims.amr) ? claims.amr.map((a) => String((a && a.method) || a || "")) : [];
    } catch (e) { return []; }
  }
  async function isRecoverySession() {
    if (!supa || !currentUser) return false;
    try {
      const { data } = await supa.auth.getSession();
      const s = data && data.session;
      if (!s || !s.user || s.user.id !== currentUser.id) return false;
      return jwtAmrMethods(s.access_token).indexOf("recovery") !== -1;
    } catch (e) { return false; }
  }
  // Does this account have a Helm (email) password at all? Google-only → false.
  function hasPasswordLogin(u) {
    u = u || currentUser; if (!u) return false;
    const am = u.app_metadata || {};
    const provs = Array.isArray(am.providers) ? am.providers : (am.provider ? [am.provider] : []);
    if (Array.isArray(u.identities) && u.identities.length) return u.identities.some((i) => i && i.provider === "email") || provs.indexOf("email") !== -1;
    return provs.length ? provs.indexOf("email") !== -1 : true;   // unknown shape → assume password (reverify still decides)
  }
  const AUTH_CFG = (function () {
    const a = (CFG && CFG.auth) || {}; const s = a.session || {};
    const num = (v, d) => (v === 0 || v === "0") ? 0 : (Number(v) > 0 ? Number(v) : d);
    return {
      idleMs: num(s.idleMinutes, 0) * 60000,      // default OFF (owner decision 2026-10)
      warnMs: num(s.warnSeconds, 60) * 1000,
      maxMs: num(s.maxHours, 0) * 3600000,        // default OFF
      mfaRequiredForAdmins: a.mfaRequiredForAdmins === true,
    };
  })();
  const CAPTCHA = (function () {
    const c = (CFG && CFG.captcha) || {};
    const key = typeof c.siteKey === "string" ? c.siteKey.trim() : "";
    return (c.provider === "turnstile" && key) ? { provider: "turnstile", siteKey: key } : null;
  })();
  const PW_MIN = 12;
  // Password rule used everywhere a password is SET. Identical to the Supabase Auth
  // policy ("Lowercase, uppercase letters, digits and symbols", min 12) and to
  // public._password_ok in migration 0030. The symbol set is Supabase's exactly.
  const PW_SYMBOLS = "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~";
  const PW_HINT = "At least " + PW_MIN + " characters, with a lowercase letter, an uppercase letter, a number and a symbol (like ! @ # $ %).";
  function passwordChecks(pw) {
    pw = String(pw || "");
    let sym = false;
    for (const ch of pw) if (PW_SYMBOLS.indexOf(ch) !== -1) { sym = true; break; }
    return [
      { id: "len",   label: "At least " + PW_MIN + " characters", ok: pw.length >= PW_MIN },
      { id: "lower", label: "A lowercase letter (a–z)",            ok: /[a-z]/.test(pw) },
      { id: "upper", label: "An uppercase letter (A–Z)",           ok: /[A-Z]/.test(pw) },
      { id: "digit", label: "A number (0–9)",                      ok: /[0-9]/.test(pw) },
      { id: "symbol", label: "A symbol, e.g. ! @ # $ % & * ? -",   ok: sym },
    ];
  }
  function passwordProblem(pw) {
    pw = String(pw || "");
    if (pw.length < PW_MIN) return "Use at least " + PW_MIN + " characters.";
    const miss = passwordChecks(pw).filter((c) => !c.ok && c.id !== "len");
    if (miss.length) {
      const names = { lower: "a lowercase letter", upper: "an uppercase letter", digit: "a number", symbol: "a symbol (like ! @ # $ %)" };
      const parts = miss.map((c) => names[c.id]);
      return "Include at least " + (parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0]) + ".";
    }
    return null;
  }
  // Live checklist for any "new password" input: renders under `input` (or into
  // `host`) and ticks each requirement as the person types. Pure DOM, no innerHTML.
  function attachPasswordChecklist(input, host) {
    if (!input || typeof document === "undefined") return null;
    let box = host;
    if (!box) { box = document.createElement("ul"); input.insertAdjacentElement("afterend", box); }
    box.className = (box.className ? box.className + " " : "") + "pw-checklist";
    box.setAttribute("aria-live", "polite");
    box.style.cssText = "list-style:none;margin:6px 0 10px;padding:0;font-size:12.5px;line-height:1.7";
    if (!box.id) box.id = (input.id || "pw") + "_rules";
    const prev = input.getAttribute("aria-describedby");
    if (!prev || prev.split(" ").indexOf(box.id) === -1) input.setAttribute("aria-describedby", ((prev ? prev + " " : "") + box.id).trim());
    function render() {
      while (box.firstChild) box.removeChild(box.firstChild);
      passwordChecks(input.value).forEach((c) => {
        const li = document.createElement("li");
        li.textContent = (c.ok ? "✓ " : "○ ") + c.label;
        li.style.color = c.ok ? "#15803d" : "#6b6577";
        li.style.fontWeight = c.ok ? "600" : "400";
        li.setAttribute("data-ok", c.ok ? "1" : "0");
        box.appendChild(li);
      });
    }
    input.addEventListener("input", render);
    render();
    return { render: render, el: box };
  }
  const SESSION_START_KEY = "bp_session_start";  // localStorage {uid, ts}: absolute session age (shared by tabs)
  const ACTIVITY_KEY = "bp_last_activity";       // localStorage ms timestamp: last activity in ANY tab
  const RECOVERY_KEY = "bp_recovery_pending";    // localStorage "<uid>": reset link used, new password not set yet
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function sessionStart() { try { const o = JSON.parse(lsGet(SESSION_START_KEY) || "null"); return (o && o.uid && o.ts) ? o : null; } catch (e) { return null; } }
  function stampSessionStart(uid, fresh) {
    if (!uid) return;
    const cur = sessionStart();
    if (fresh || !cur || cur.uid !== uid) lsSet(SESSION_START_KEY, JSON.stringify({ uid: uid, ts: Date.now() }));
    lsSet(ACTIVITY_KEY, String(Date.now()));
  }
  // Pure decision used by the session-limit timer (exported for tests).
  function sessionDecision(now, lastActivity, startedAt, cfg) {
    if (cfg.maxMs > 0 && startedAt && now - startedAt >= cfg.maxMs) return "max";
    if (cfg.idleMs > 0) {
      const idle = now - (lastActivity || now);
      if (idle >= cfg.idleMs) return "idle";
      if (idle >= Math.max(0, cfg.idleMs - cfg.warnMs)) return "warn";
    }
    return "ok";
  }

  /* ---- session-expiry handling ------------------------------------------
     When a signed-in session dies underneath a page (refresh token revoked or
     expired, signed out in another tab, JWT rejected by PostgREST) we send the
     user to  login.html?next=<page+query>&expired=1  instead of leaving them on
     a page whose every request now fails. login.html shows "Your session
     expired" when expired=1.
     Only pages that GATE on auth (called auth.required() or auth.requireView())
     redirect, and never the public token pages below. */
  const PUBLIC_PAGES = { approve: 1, portal: 1, "proposal-view": 1, invite: 1, work: 1, "sim-pay": 1,
    index: 1, login: 1, about: 1, services: 1, privacy: 1, terms: 1, "reset-password": 1 };
  let authGateUsed = false;     // page called auth.required()/requireView()
  let hadSession = false;       // a user was signed in at some point on this page
  let explicitSignOut = false;  // the user clicked "sign out" (not an expiry)
  let sessionExpired = false;   // redirect already triggered (run once)
  let authFailPromise = null;   // in-flight verification of a suspected auth failure
  function pageKey() {
    try { return (location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index"; }
    catch (e) { return "index"; }
  }
  function shouldRedirectOnExpiry() {
    return mode === "supabase" && authGateUsed && hadSession && !explicitSignOut && !PUBLIC_PAGES[pageKey()];
  }

  /* ---- page auth gate: nothing of a signed-in page paints before auth is confirmed ----
     Every protected page ships  <html class="auth-pending">  plus a head rule that
     hides <body> while that class is present (set statically, so it holds from the
     first paint). init() removes the class ONLY after it has confirmed, in order:
       1. a Supabase session with no sign-in step pending (else → /login?next=…),
       2. the account belongs to a studio (else → platform operator? /hq : onboarding).
     Every redirect uses location.replace, so Back never lands on a protected page.
     Public pages (no class) are untouched. The class is read once, at load. */
  const PAGE_GATED = (function () {
    try { return !!(document.documentElement && document.documentElement.classList && document.documentElement.classList.contains("auth-pending")); }
    catch (e) { return false; }
  })();
  const HANG = () => new Promise(() => {});   // a redirect is under way — the page's own code must not run
  function revealPage() { try { document.documentElement.classList.remove("auth-pending"); } catch (e) {} }
  function hidePage() { try { document.documentElement.classList.add("auth-pending"); } catch (e) {} }
  // ?next= may only name one of the app's own pages (fixed list — the page string is
  // never taken from the URL); only its query string is carried over, re-encoded.
  // Anything else (//host, https://…, /\host, javascript:, encoded tricks) → dashboard.
  const NEXT_PAGES = ["audit", "budget", "builder", "calendar", "chat", "closure", "command", "control", "crm", "dashboard", "design", "discovery", "event", "flow", "insights", "inventory", "invite-studio", "issues", "leads", "logistics", "manual", "media", "nurture", "ops", "plan", "proposal", "quotes", "ready", "reports", "resources", "runsheet", "settlement", "staff", "teardown", "templates", "vendors"];
  function safeNext(raw) {
    const m = /^\/?([a-z0-9-]+)(?:\.html)?(?:\?([^#]*))?$/i.exec(typeof raw === "string" ? raw : "");
    const page = m && NEXT_PAGES.find((p) => p === m[1].toLowerCase());
    if (!page) return "dashboard.html";
    let qs = "";
    try { qs = new URLSearchParams(m[2] || "").toString(); } catch (e) { qs = ""; }
    return page + ".html" + (qs ? "?" + qs : "");
  }
  function gotoLogin() {
    let page = "dashboard";
    try { page = (location.pathname.split("/").pop() || "dashboard") + (location.search || ""); } catch (e) {}
    try { location.replace("/login?next=" + encodeURIComponent(page)); } catch (e) {}
  }
  // Supabase is configured but its client could not start: never fall back to showing
  // the app shell on a protected page — show a retry notice instead.
  function gateUnreachable() {
    try {
      const b = document.body; if (!b) return;
      while (b.firstChild) b.removeChild(b.firstChild);
      const box = document.createElement("div");
      box.setAttribute("role", "alert");
      box.style.cssText = "max-width:480px;margin:64px auto;padding:28px;border-radius:14px;background:#fff;border:1px solid #d7deea;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;color:#4a5673";
      const h = document.createElement("h2"); h.textContent = "Couldn’t reach Helm"; h.style.cssText = "color:#141b2e;margin:0 0 6px";
      const p = document.createElement("p"); p.textContent = "We couldn’t confirm your sign-in. Check your connection and try again."; p.style.margin = "0 0 16px";
      const r = document.createElement("button"); r.type = "button"; r.textContent = "Retry";
      r.style.cssText = "min-height:40px;padding:0 18px;border:0;border-radius:10px;background:#6d28d9;color:#fff;font:inherit;font-weight:600;cursor:pointer";
      r.addEventListener("click", () => { try { location.reload(); } catch (e) {} });
      box.appendChild(h); box.appendChild(p); box.appendChild(r); b.appendChild(box);
      revealPage();
    } catch (e) {}
  }
  // The studio this account belongs to. Throws on a failed lookup (so a network blip
  // is never mistaken for "no studio"); a found id is cached per tab for SESS_TTL.
  async function orgIdStrict() {
    if (!supa || !currentUser) return null;
    const uid = currentUser.id;
    const hit = sessEntry("bp_sess_org", uid);
    if (hit && hit.val) {
      if (!hit.fresh) revalidateOrg(uid, hit.val);   // stale: use it now, re-check in the background
      return hit.val;
    }
    return fetchOrgId(uid);
  }
  async function fetchOrgId(uid) {
    const { data, error } = await supa.rpc("current_org_id");
    if (error) throw error;
    if (data) sessSet("bp_sess_org", uid, data);
    return data || null;
  }
  // Background re-check of a stale cached studio id. A different / missing studio →
  // drop the caches, hide the page and reload (the gate decides again); a rejected
  // token → hide + sign-in. A network blip keeps the cached answer (RLS still checks
  // every data call).
  let orgRecheck = null;
  let orgRevoked = false;       // a background re-check said no: never (re)show this page
  function revalidateOrg(uid, was) {
    if (orgRecheck || !supa) return;
    orgRecheck = fetchOrgId(uid).then((now) => {
      if (!currentUser || currentUser.id !== uid || now === was) return;
      orgRevoked = true; sessClear();
      if (PAGE_GATED) { hidePage(); try { location.reload(); } catch (e) {} }
    }, (e) => {
      if (!looksLikeAuthError(e)) return;
      orgRevoked = true; sessClear();
      if (PAGE_GATED) { hidePage(); gotoLogin(); }
    }).then(() => { orgRecheck = null; }, () => { orgRecheck = null; });
  }
  // Started alongside the sign-in step check on a protected page (one round-trip
  // instead of two before the page shows); runPageGate awaits it.
  let orgEarly = null;
  // Helm platform operator (public.platform_admins)? Asked ONLY for an account with no
  // studio; any error counts as "no". The hq_* RPCs remain the real server gate.
  async function isPlatformAdmin() {
    if (!supa || !currentUser || pendingStep) return false;
    // 0037 is_platform_operator: "is my e-mail on the HQ list" WITHOUT the two-step
    // requirement, so an operator who still owes a code is routed to the code step
    // (never to studio setup). Falls back to is_platform_admin before 0037 exists.
    try {
      const r = await supa.rpc("is_platform_operator");
      if (!r.error && typeof r.data === "boolean") return r.data;
      const { data, error } = await supa.rpc("is_platform_admin"); return !error && data === true;
    } catch (e) { return false; }
  }
  // The ONE place the HQ path appears outside hq.html/hq.js (test/hq-private.test.mjs):
  // reached only after is_platform_admin() said true for an account with no studio.
  // Resolves true when it has sent the browser to HQ (location.replace).
  async function operatorToHq() {
    if (!(await isPlatformAdmin())) return false;
    try { location.replace("/hq"); } catch (e) {}
    return true;
  }
  // Signed in with no studio: operators go to HQ, everyone else to onboarding.
  async function routeNoStudio() {
    if (await operatorToHq()) return;
    try { location.replace("/login?next=" + encodeURIComponent(safeNext((location.pathname.split("/").pop() || "") + (location.search || "")))); } catch (e) {}
  }
  /* ---- "Complete your profile" (0041) — first sign-in step for NEW members ----
     my_profile_status() → {complete, required, nudge}. The server decides who must
     complete it (a non-client studio member, not an HQ operator, whose account was
     created after the 0041 cutoff and who has no full name or mobile yet); older
     incomplete members only get a dismissible banner (nudge). This is a UX step,
     not a security boundary: an unknown answer (network) never blocks the app,
     and 0041 not installed (PGRST202 / 42883) = the feature is simply off.
     Answers that do NOT require the step are cached per tab (bp_sess_profile); a
     "must complete" answer is always asked again. */
  const PROFILE_SETUP_PAGE = "profile-setup";
  let profEarly = null;         // started alongside the studio lookup on a protected page
  // Pure decision (exported for tests): "setup" (send to /profile-setup), "nudge" (banner), "none".
  function profileGateDecision(st, page, role) {
    if (!st || typeof st !== "object" || st.missing) return "none";
    if (role === "client" || st.complete === true) return "none";
    if (st.required === true) return page === PROFILE_SETUP_PAGE ? "none" : "setup";
    if (st.nudge === true) return "nudge";
    return "none";
  }
  // Throws on a failed lookup (callers decide); {missing:true} when 0041 isn't installed.
  async function fetchProfileStatus(force) {
    if (!supa || !currentUser) return null;
    const uid = currentUser.id;
    if (!force) { const hit = sessEntry(PROFILE_SESS_KEY, uid); if (hit && hit.val && typeof hit.val === "object") return hit.val; }
    const { data, error } = await supa.rpc("my_profile_status");
    if (error) {
      if (isMissingFn(error)) { const v = { missing: true }; sessSet(PROFILE_SESS_KEY, uid, v); return v; }
      throw error;
    }
    if (!data || typeof data !== "object") return null;
    const v = { complete: data.complete === true, required: data.required === true, nudge: data.nudge === true };
    if (!v.required) sessSet(PROFILE_SESS_KEY, uid, v); else { try { sessionStorage.removeItem(PROFILE_SESS_KEY); } catch (e) {} }
    return v;
  }
  // After a successful save: remember "complete" for this tab (no re-ask on the next page).
  function noteProfileComplete(complete) {
    if (!currentUser) return;
    if (complete) sessSet(PROFILE_SESS_KEY, currentUser.id, { complete: true, required: false, nudge: false });
    else { try { sessionStorage.removeItem(PROFILE_SESS_KEY); } catch (e) {} }
  }
  // "/profile-setup?next=<this page>" — next always goes through safeNext.
  function profileSetupUrl(next) {
    return "/" + PROFILE_SETUP_PAGE + "?next=" + encodeURIComponent(safeNext(next));
  }
  function currentPageRef() {
    try { return (location.pathname.split("/").pop() || "dashboard") + (location.search || ""); } catch (e) { return "dashboard"; }
  }
  function nextParam() {
    try { return new URLSearchParams(location.search || "").get("next") || ""; } catch (e) { return ""; }
  }
  async function runPageGate() {
    if (!PAGE_GATED) return;
    authGateUsed = true;
    if (mode !== "supabase") {
      if (supaConfigured()) { gateUnreachable(); return HANG(); }
      revealPage(); return;                              // no accounts configured (local/offline dev)
    }
    if (!currentUser || pendingStep) { gotoLogin(); return HANG(); }
    // The studio lookup is also the SERVER's confirmation of the session (a stale or
    // forged local token fails here). Rejected token → sign-in; any other failure →
    // "Couldn't reach Helm — Retry". The app is shown only after a real answer.
    let oid = null;
    const early = orgEarly; orgEarly = null;
    try { oid = await (early || orgIdStrict()); }
    catch (e) {
      if (looksLikeAuthError(e)) { gotoLogin(); return HANG(); }
      gateUnreachable(); return HANG();
    }
    if (!oid) { await routeNoStudio(); return HANG(); }
    if (orgRevoked) return HANG();   // a background re-check already took the page away
    // "Complete your profile" (0041): decided BEFORE the page shows (no flash).
    const pk = pageKey();
    let pst = null;
    const pe = profEarly; profEarly = null;
    try { pst = await (pe || fetchProfileStatus(false)); }
    catch (e) {
      if (looksLikeAuthError(e)) { gotoLogin(); return HANG(); }
      pst = null;                    // unknown (network): never blocks the app
    }
    if (pk === PROFILE_SETUP_PAGE) {
      // nothing to complete here (done, not a studio member, client, HQ operator, or
      // 0041 not installed) → straight on to ?next= (never back to this page: no loop)
      if (pst && (pst.missing || pst.complete || (!pst.required && !pst.nudge))) {
        try { location.replace(safeNext(nextParam())); } catch (e) {}
        return HANG();
      }
    } else if (profileGateDecision(pst, pk, roleCache) === "setup") {
      try { location.replace(profileSetupUrl(currentPageRef())); } catch (e) {}
      return HANG();
    }
    revealPage();
  }
  // Back/Forward restored this page from the bfcache: re-check before showing it again.
  function onPageShow(ev) {
    if (!ev || !ev.persisted || !PAGE_GATED) return;
    hidePage();
    (async () => {
      try {
        if (mode !== "supabase" || !supa) { location.reload(); return; }
        const { data } = await supa.auth.getSession();
        const s = data && data.session;
        if (!s || !s.user || pendingStep) { gotoLogin(); return; }
        if (currentUser && s.user.id !== currentUser.id) { location.reload(); return; }
        revealPage();
      } catch (e) { gotoLogin(); }
    })();
  }
  try { if (PAGE_GATED && typeof window !== "undefined" && window.addEventListener) window.addEventListener("pageshow", onPageShow); } catch (e) {}
  function looksLikeAuthError(e) {
    if (global.BPUI && global.BPUI.isAuthError) return global.BPUI.isAuthError(e);
    const c = (e && e.code) || ""; const m = String((e && e.message) || "");
    return c === "PGRST301" || c === "PGRST303" || (e && e.status === 401) || /jwt expired|invalid jwt/i.test(m);
  }
  function expireSession() {
    if (sessionExpired || !shouldRedirectOnExpiry()) return false;
    sessionExpired = true;
    currentUser = null; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; sessClear(); authRequired = true;
    let page = "dashboard.html";
    try { page = (location.pathname.split("/").pop() || "dashboard.html") + location.search; } catch (e) {}
    const url = "login.html?next=" + encodeURIComponent(page) + "&expired=1";
    const UI = global.BPUI;
    // Don't yank the page away from unsaved work: tell the user and let them choose.
    if (UI && UI.hasUnsavedChanges && UI.hasUnsavedChanges()) {
      UI.toast("Your session expired — sign in again. Copy any unsaved changes first.",
        { type: "err", timeout: 0, action: { label: "Sign in", onClick: () => { UI.allowUnload(); location.replace(url); } } });
      return true;
    }
    try { location.replace(url); } catch (e) {}
    return true;
  }
  // A request failed in a way that looks like a dead session. Confirm by trying a
  // token refresh (it may just have been a stale JWT); redirect only if that fails
  // and we are online. Deduped: many parallel failures → one check, one redirect.
  function onAuthFailure() {
    if (sessionExpired || !supa || !shouldRedirectOnExpiry()) return Promise.resolve(false);
    if (authFailPromise) return authFailPromise;
    authFailPromise = (async () => {
      try {
        const { data, error } = await supa.auth.refreshSession();
        if (!error && data && data.session) { currentUser = data.session.user; return false; }
        if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
        if (error && global.BPUI && global.BPUI.isNetworkError(error)) return false;
      } catch (e) {
        if (global.BPUI && global.BPUI.isNetworkError(e)) return false;
      }
      return expireSession();
    })();
    authFailPromise.then(() => { authFailPromise = null; }, () => { authFailPromise = null; });
    return authFailPromise;
  }
  // fetch used by the Supabase client: a 401 from PostgREST while signed in means
  // the JWT was rejected — run the session-expiry check (the response is returned
  // to the caller untouched either way).
  function authAwareFetch(input, init) {
    return global.fetch(input, init).then((res) => {
      try {
        if (res.status === 401 && currentUser) {
          const u = typeof input === "string" ? input : (input && input.url) || "";
          if (/\/rest\/v1\//.test(u)) onAuthFailure();
        }
      } catch (e) {}
      return res;
    });
  }
  /* ---- sign-in gate: which step (if any) must be finished before the app opens ---- */
  function isMissingFn(e) {
    if (global.BPUI && global.BPUI.isMissingFunction) return global.BPUI.isMissingFunction(e);
    const c = (e && e.code) || ""; return c === "PGRST202" || c === "42883";
  }
  async function evaluateGate() {
    pendingStep = null;
    if (!supa || !currentUser) return null;
    // 1) two-step verification: a verified factor exists but this session is aal1.
    //    (local check — reads the session; no network)
    try {
      const { data, error } = await supa.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) throw error;
      if (data && data.nextLevel === "aal2" && data.currentLevel !== "aal2") { pendingStep = "mfa"; return pendingStep; }
    } catch (e) { pendingStep = "verify"; return pendingStep; }
    // 2) a password-reset link was used in this browser and the new password isn't set yet
    if (lsGet(RECOVERY_KEY) === currentUser.id) { pendingStep = "recovery"; return pendingStep; }
    // 3) one-time temp password — checked once per tab, FAILS CLOSED on error
    let ok = null; try { ok = sessionStorage.getItem(PW_OK_KEY); } catch (e) {}
    if (ok === currentUser.id) return null;
    try {
      const { data, error } = await supa.rpc("password_change_required");
      if (error && !isMissingFn(error)) throw error;
      if (!error && data === true) { pendingStep = "password"; return pendingStep; }
      try { sessionStorage.setItem(PW_OK_KEY, currentUser.id); } catch (e) {}
    } catch (e) { pendingStep = "verify"; }
    return pendingStep;
  }
  /* ---- two-step code lockout (UX layer; Supabase Auth's own rate limit is the real one) ----
     After MFA_MAX_TRIES wrong codes in a row the form pauses for 60 s, doubling for
     each further run of wrong codes (max 15 min). Kept in localStorage per account so a
     reload or a new tab does not reset it; cleared by the next correct code. */
  const MFA_LOCK_KEY = "bp_mfa_lock", MFA_MAX_TRIES = 5, MFA_LOCK_BASE = 60000, MFA_LOCK_MAX = 15 * 60000;
  function mfaLockRead(uid) {
    try { const o = JSON.parse(lsGet(MFA_LOCK_KEY) || "null"); return (o && uid && o.uid === uid) ? o : { uid: uid, n: 0, until: 0 }; }
    catch (e) { return { uid: uid, n: 0, until: 0 }; }
  }
  function mfaLockLeft(uid) { const o = mfaLockRead(uid); return Math.max(0, (Number(o.until) || 0) - Date.now()); }
  function mfaLockFor(uid, ms) { const o = mfaLockRead(uid); o.until = Date.now() + ms; lsSet(MFA_LOCK_KEY, JSON.stringify(o)); return ms; }
  function mfaStrike(uid) {
    const o = mfaLockRead(uid); o.n = (Number(o.n) || 0) + 1;
    if (o.n % MFA_MAX_TRIES === 0) o.until = Date.now() + Math.min(MFA_LOCK_MAX, MFA_LOCK_BASE * Math.pow(2, o.n / MFA_MAX_TRIES - 1));
    lsSet(MFA_LOCK_KEY, JSON.stringify(o));
    return Math.max(0, (Number(o.until) || 0) - Date.now());
  }
  function mfaLockClear() { lsDel(MFA_LOCK_KEY); }
  function mfaLockedError(ms, cause) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    const e = new Error("Too many incorrect codes. For your security, wait " + (s >= 90 ? Math.ceil(s / 60) + " minutes" : s + " seconds") + ", then enter the newest code from your app.");
    e.code = "mfa_locked"; e.retryAfter = s; if (cause) e.cause = cause; return e;
  }
  // Pure decision for a platform operator (exported for tests): no verified
  // authenticator → enroll; verified but session below aal2 → challenge; else ok.
  function operatorMfaDecision(level, verifiedCount) {
    if (!(verifiedCount > 0)) return "enroll";
    return (level && level.currentLevel === "aal2") ? "ok" : "challenge";
  }

  // gate is evaluated on staff pages + the auth pages, not on public client-link pages
  function gatePage() { const k = pageKey(); if (publicLinkPath()) return false; return !PUBLIC_PAGES[k] || k === "login" || k === "reset-password"; }
  // branded client links (/<studio>/quote|portal|proposal|work|invite/<ref>) and /i/<slug>
  function publicLinkPath() {
    try { const p = location.pathname || ""; return /^\/i(\/|$)/.test(p) || /^\/[a-z0-9-]+\/(invite|quote|proposal|portal|work)\/[^/]+\/?$/i.test(p); }
    catch (e) { return false; }
  }

  /* ---- session limits: inactivity logout + absolute max age (client side) ----
     Activity in ANY tab keeps every tab alive (shared localStorage timestamp, so
     the 'storage' event syncs tabs); a limit logout in one tab tells the others
     over BroadcastChannel. Never runs on public client-link pages. */
  let limitsStarted = false, limitTimer = null, warnBox = null, lastLocalActivity = 0, lastWrite = 0, bc = null, limitOut = false;
  function touchActivity(force) {
    const t = Date.now(); lastLocalActivity = t;
    if (force || t - lastWrite > 5000) { lastWrite = t; lsSet(ACTIVITY_KEY, String(t)); }
  }
  function lastActivity() { return Math.max(lastLocalActivity, Number(lsGet(ACTIVITY_KEY)) || 0); }
  function hideWarn() { if (warnBox) { try { warnBox.remove(); } catch (e) {} warnBox = null; } }
  function showWarn(secondsLeft) {
    if (!warnBox) {
      warnBox = document.createElement("div");
      warnBox.className = "bpui-overlay"; warnBox.id = "bpIdleWarn";
      warnBox.setAttribute("role", "alertdialog"); warnBox.setAttribute("aria-modal", "true"); warnBox.setAttribute("aria-labelledby", "bpIdleTitle");
      warnBox.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(20,27,46,.5)";
      const card = document.createElement("div");
      card.className = "bpui-dialog";
      card.style.cssText = "background:var(--bpui-bg,#fff);color:var(--bpui-ink,#141b2e);border-radius:14px;padding:22px;max-width:400px;width:100%;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 24px 60px rgba(20,27,46,.3)";
      const h = document.createElement("h2"); h.id = "bpIdleTitle"; h.textContent = "Still there?"; h.style.cssText = "margin:0 0 8px;font-size:18px";
      const p = document.createElement("p"); p.id = "bpIdleText"; p.style.margin = "0 0 14px";
      const b = document.createElement("button"); b.type = "button"; b.textContent = "Stay signed in";
      b.style.cssText = "min-height:40px;padding:0 18px;border:0;border-radius:10px;background:var(--bpui-accent,#6d28d9);color:#fff;font:inherit;font-weight:600;cursor:pointer";
      b.addEventListener("click", () => { touchActivity(true); hideWarn(); });
      card.appendChild(h); card.appendChild(p); card.appendChild(b); warnBox.appendChild(card);
      document.body.appendChild(warnBox);
      try { b.focus(); } catch (e) {}
    }
    const p = warnBox.querySelector("#bpIdleText");
    if (p) p.textContent = "For your security you'll be signed out in " + Math.max(0, Math.ceil(secondsLeft)) + " seconds because there has been no activity.";
  }
  async function limitLogout(reason, fromOtherTab) {
    if (limitOut) return; limitOut = true;
    if (limitTimer) { clearInterval(limitTimer); limitTimer = null; }
    explicitSignOut = true;
    if (!fromOtherTab) { try { if (bc) bc.postMessage({ type: "logout", reason: reason }); } catch (e) {} }
    try { if (supa) await supa.auth.signOut({ scope: "local" }); } catch (e) {}
    currentUser = null; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; pendingStep = null;
    sessClear(); userLocalClear(); lsDel(SESSION_START_KEY); authRequired = true;
    let page = "dashboard.html";
    try { page = (location.pathname.split("/").pop() || "dashboard.html") + location.search; } catch (e) {}
    try { if (global.BPUI && global.BPUI.allowUnload) global.BPUI.allowUnload(); } catch (e) {}
    try { location.replace("login.html?next=" + encodeURIComponent(page) + "&expired=1&reason=" + (reason === "max" ? "max" : "idle")); } catch (e) {}
  }
  function checkLimits() {
    if (limitOut || !currentUser) return;
    const st = sessionStart();
    if (!st || st.uid !== currentUser.id) stampSessionStart(currentUser.id, false);   // sessions from before this release: start the clock now
    const s2 = sessionStart();
    const now = Date.now(), last = lastActivity();
    const d = sessionDecision(now, last, s2 && s2.ts, AUTH_CFG);
    if (d === "max" || d === "idle") { hideWarn(); limitLogout(d); return; }
    if (d === "warn") showWarn((AUTH_CFG.idleMs - (now - last)) / 1000); else hideWarn();
  }
  function startSessionLimits() {
    if (limitsStarted || mode !== "supabase" || !currentUser || pendingStep || !gatePage() || pageKey() === "login" || pageKey() === "reset-password") return;
    if (typeof document === "undefined" || typeof window === "undefined") return;
    limitsStarted = true;
    touchActivity(true);
    const onAct = (e) => {
      // while the warning is up, only a deliberate click / key press counts
      if (warnBox && (e.type === "mousemove" || e.type === "scroll" || e.type === "wheel")) return;
      touchActivity(false);
    };
    ["pointerdown", "keydown", "touchstart", "wheel", "scroll", "mousemove"].forEach((ev) => {
      try { window.addEventListener(ev, onAct, { passive: true, capture: true }); } catch (e) {}
    });
    try {
      window.addEventListener("storage", (e) => {
        if (e.key === ACTIVITY_KEY && warnBox) checkLimits();
        if (e.key === SESSION_START_KEY) checkLimits();
      });
    } catch (e) {}
    try {
      if (typeof BroadcastChannel !== "undefined") {
        bc = new BroadcastChannel("helm-session");
        bc.addEventListener("message", (m) => { const d = m && m.data; if (d && d.type === "logout") limitLogout(d.reason, true); });
      }
    } catch (e) { bc = null; }
    try { document.addEventListener("visibilitychange", () => { if (!document.hidden) checkLimits(); }); } catch (e) {}
    limitTimer = setInterval(checkLimits, 5000);
    checkLimits();
    loadAuthUi();
  }
  // Account menu / two-step banner live in auth-ui.js (loaded on signed-in staff pages only).
  const AUTH_UI_VERSION = "10";
  let authUiLoading = null;
  function loadAuthUi() {
    if (authUiLoading || typeof document === "undefined") return authUiLoading;
    authUiLoading = new Promise((resolve) => {
      if (global.HelmAuthUI) return resolve(true);
      const s = document.createElement("script");
      s.src = vendorUrl("auth-ui.js?v=" + AUTH_UI_VERSION);
      s.onload = () => resolve(true); s.onerror = () => resolve(false);
      document.head.appendChild(s);
    }).then((ok) => { try { if (ok && global.HelmAuthUI && global.HelmAuthUI.mountAppChrome) global.HelmAuthUI.mountAppChrome(); } catch (e) {} return ok; });
    return authUiLoading;
  }

  // capability matrix per role (10 roles)
  // capability matrix per role. IMPORTANT: `create` and `delete` here gate
  // buttons (dashboard/quotes/leads/builder create, delete controls) that map to
  // the server functions can_create() = {admin,planner,sales} and can_delete() =
  // {admin,planner}. They are kept IN SYNC with those SQL functions so no button
  // is shown that the server will reject with "not authorized" (Wave 16 fix —
  // manager/coordinator previously saw a create button that always errored).
  // `edit` is NOT used for edit buttons — pages gate editing via canEditArea()
  // (the has_area matrix) — so it stays broad here for any legacy checks.
  // Whether a manager SHOULD be able to create/delete quotes is a PRODUCT
  // DECISION (would require adding manager to can_create/can_delete server-side).
  const ROLE_CAPS = {
    admin:       ["view", "create", "edit", "delete", "manage"],
    manager:     ["view", "create", "edit", "manage"],
    planner:     ["view", "create", "edit", "delete"],
    sales:       ["view", "create", "edit"],
    coordinator: ["view", "edit"],
    supervisor:  ["view", "edit"],
    quality:     ["view", "edit"],
    operations:  ["view", "edit"],
    designer:    ["view", "create", "edit"],
    crew:        ["view"],
    worker:      ["view"],
    client:      ["view"],
  };
  const EDIT_ROLES = ["admin", "manager", "planner", "sales", "coordinator", "supervisor", "quality", "operations", "designer"];
  const ALL_ROLES  = ["admin", "manager", "planner", "sales", "coordinator", "supervisor", "quality", "operations", "designer", "crew", "worker", "client"];
  // friendly labels for the UI (keys stay stable in the DB)
  const ROLE_LABELS = {
    admin: "Admin", manager: "Event manager", planner: "Planner", sales: "Sales",
    coordinator: "Event coordinator", supervisor: "Supervisor", quality: "Quality engineer",
    operations: "Operations", designer: "Designer", crew: "Crew", worker: "Worker", client: "Client",
  };
  const roleLabel = (r) => ROLE_LABELS[r] || r;

  // Fine-grained AREAS the access matrix governs (key must match role_access.area
  // and phase29-role-access.sql). label/icon/page power the Control Center editor
  // and the dashboard nav. page=null → area is a workspace card, not its own nav link.
  const AREAS = [
    { key: "leads",      label: "Leads",             icon: "🎯", page: "leads.html",     group: "Pipeline" },
    { key: "crm",        label: "CRM archive",       icon: "🗄", page: "crm.html",       group: "Pipeline" },
    { key: "nurture",    label: "Nurture",           icon: "🌱", page: "nurture.html",   group: "Pipeline" },
    { key: "discovery",  label: "Discovery",         icon: "🔎", page: null,             group: "Pipeline" },
    { key: "proposal",   label: "Proposal",          icon: "🎨", page: null,             group: "Pipeline" },
    { key: "quotes",     label: "Quotes & workspace",icon: "📋", page: "quotes.html",    group: "Workspace" },
    { key: "layouts",    label: "Floor layouts",     icon: "📐", page: null,             group: "Workspace" },
    { key: "design",     label: "Design studio",     icon: "🎨", page: "design.html",    group: "Workspace" },
    { key: "staff",      label: "Staff",             icon: "👷", page: "staff.html",     group: "Resources" },
    { key: "inventory",  label: "Inventory",         icon: "📦", page: "inventory.html", group: "Resources" },
    { key: "vendors",    label: "Vendors",           icon: "🤝", page: "vendors.html",   group: "Resources" },
    { key: "calendar",   label: "Calendar",          icon: "📅", page: "calendar.html",  group: "Resources" },
    { key: "templates",  label: "Templates",         icon: "🧩", page: "templates.html", group: "Resources" },
    { key: "resources",  label: "Resource plan",     icon: "🧮", page: null,             group: "Planning" },
    { key: "runsheet",   label: "Run-sheet",         icon: "🗓", page: null,             group: "Planning" },
    { key: "plan",       label: "Venue & menu",      icon: "📍", page: null,             group: "Planning" },
    { key: "logistics",  label: "Logistics",         icon: "🚚", page: null,             group: "Planning" },
    { key: "ready",      label: "Readiness",         icon: "✅", page: null,             group: "Planning" },
    { key: "finance",    label: "Budget & finance",  icon: "💰", page: null,             group: "Finance" },
    { key: "settlement", label: "Settlement",        icon: "🧾", page: null,             group: "Finance" },
    { key: "closure",    label: "Closure & P&L",     icon: "🏁", page: null,             group: "Finance" },
    { key: "command",    label: "Event-day command", icon: "🎛", page: null,             group: "Event day" },
    { key: "issues",     label: "Issues & incidents",icon: "🚨", page: null,             group: "Event day" },
    { key: "media",      label: "Media & gallery",   icon: "📸", page: null,             group: "Event day" },
    { key: "controls",   label: "Control Center",    icon: "⚙", page: "control.html",   group: "Admin" },
    { key: "codes",      label: "Coupons & codes",   icon: "🔑", page: null,             group: "Admin" },
    { key: "users",      label: "Users & access",    icon: "👥", page: "control.html",   group: "Admin" },
  ];
  // coarse keys the older per-page gates pass → the fine areas they cover
  const COARSE_TO_FINE = {
    finance:   ["finance", "settlement", "closure"],
    pipeline:  ["leads", "crm", "nurture", "discovery", "proposal"],
    ops:       ["staff", "inventory", "vendors", "calendar", "templates", "resources", "runsheet", "plan", "logistics", "ready", "command", "issues", "media"],
    workspace: ["quotes", "layouts", "design"],
    manage:    ["controls", "users"],
  };
  // legacy fallback (used only if phase29 role_access isn't present yet)
  const VIEW_SCOPE = {
    finance:   ["admin", "manager", "planner", "sales"],
    pipeline:  ["admin", "manager", "planner", "sales"],
    ops:       ["admin", "manager", "planner", "sales", "coordinator", "supervisor", "operations"],
    workspace: ["admin", "manager", "planner", "sales", "coordinator", "supervisor", "operations"],
    manage:    ["admin", "manager"],
  };
  const FINE_TO_COARSE = (() => { const m = {}; for (const c in COARSE_TO_FINE) COARSE_TO_FINE[c].forEach((f) => { m[f] = c; }); return m; })();

  const supaConfigured = () => !!(CFG.url && CFG.anonKey);
  const now = () => new Date().toISOString();
  const uid = () => "local_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const objectCount = (l) => (l && l.data && Array.isArray(l.data.items) ? l.data.items.length : 0);

  /* ---------------- localStorage tier ---------------- */
  const ls = {
    read() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; } },
    write(v) { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch {} },
    list() { return this.read().map((l) => ({ id: l.id, name: l.name, createdAt: l.createdAt, updatedAt: l.updatedAt, objectCount: objectCount(l) })); },
    get(id) { return this.read().find((l) => l.id === id) || null; },
    create(name, data) { const l = { id: uid(), name, data, createdAt: now(), updatedAt: now() }; const a = this.read(); a.push(l); this.write(a); return l; },
    update(id, patch) { const a = this.read(); const i = a.findIndex((l) => l.id === id);
      if (i < 0) { const l = { id, name: patch.name || "Untitled", data: patch.data, createdAt: now(), updatedAt: now() }; a.push(l); this.write(a); return l; }
      a[i] = { ...a[i], ...(patch.name != null ? { name: patch.name } : {}), ...(patch.data ? { data: patch.data } : {}), updatedAt: now() }; this.write(a); return a[i]; },
    remove(id) { this.write(this.read().filter((l) => l.id !== id)); return true; },
  };

  /* ---------------- Node REST tier ---------------- */
  async function api(method, path, body) {
    const res = await fetch(API + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.status === 204 ? null : res.json();
  }
  const server = {
    list: () => api("GET", "/layouts"),
    get: (id) => api("GET", "/layouts/" + id),
    create: (name, data) => api("POST", "/layouts", { name, data }),
    update: (id, patch) => api("PUT", "/layouts/" + id, patch),
    remove: (id) => api("DELETE", "/layouts/" + id).then(() => true),
  };

  /* ---------------- Supabase tier ---------------- */
  // Pinned supabase-js build — update together with public/vendor/README.md.
  const SUPABASE_JS = {
    version: "2.117.2",
    file: "vendor/supabase-js-2.117.2.min.js",
    integrity: "sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok",
  };
  function vendorUrl(rel) {
    try { if (SELF_SRC) return new URL(rel, SELF_SRC).href; } catch (e) {}
    return rel;
  }
  function loadSupabaseLib() {
    return new Promise((resolve) => {
      if (global.supabase && global.supabase.createClient) return resolve(true);
      const s = document.createElement("script");
      // Self-hosted, version-pinned copy (see public/vendor/README.md). Resolved
      // relative to THIS script so it works from any page path. SRI pins the exact
      // bytes; a mismatch fires onerror → the normal server/local fallback.
      s.src = vendorUrl(SUPABASE_JS.file);
      s.integrity = SUPABASE_JS.integrity;
      s.crossOrigin = "anonymous";
      // A stalled CDN request (e.g. blocked by a browser extension) may never fire
      // load OR error — resolve after a timeout so init() can never hang the page.
      let done = false;
      const finish = (ok) => { if (done) return; done = true; clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => finish(!!(global.supabase && global.supabase.createClient)), 8000);
      s.onload = () => finish(true); s.onerror = () => finish(false);
      document.head.appendChild(s);
    });
  }
  // Layouts are the one table the anon role has no grant on, so a request made after the
  // session died showed up as "permission denied for table layouts" in the DB log. Don't
  // send it: treat a missing user as an expired session (redirects gated pages to login).
  function needUser() {
    if (currentUser) return;
    try { onAuthFailure(); } catch (e) {}
    const e = new Error("Your session has ended — please sign in again."); e.status = 401; e.code = "PGRST301"; throw e;
  }
  const sb = {
    map: (r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, data: r.data }),
    async list() { needUser(); const { data, error } = await supa.from(TABLE).select("id,name,created_at,updated_at,data").order("updated_at", { ascending: false });
      if (error) throw error; return data.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, objectCount: objectCount({ data: r.data }) })); },
    async get(id) { needUser(); const { data, error } = await supa.from(TABLE).select("*").eq("id", id).single(); if (error) throw error; return this.map(data); },
    async create(name, data) { needUser(); const { data: r, error } = await supa.from(TABLE).insert({ name, data }).select().single(); if (error) throw error; return this.map(r); },
    async update(id, patch) { needUser(); const upd = { updated_at: now() }; if (patch.name != null) upd.name = patch.name; if (patch.data) upd.data = patch.data;
      const { data: r, error } = await supa.from(TABLE).update(upd).eq("id", id).select().single(); if (error) throw error; return this.map(r); },
    async remove(id) { needUser(); const { error } = await supa.from(TABLE).delete().eq("id", id); if (error) throw error; return true; },
  };

  /* ---------------- init: pick the best available backend ---------------- */
  async function init() {
    if (ready) return ready;
    ready = (async () => {
      // A password-reset email link that landed on any other page (e.g. the Site
      // URL) must NOT just sign the person in: hand it to the reset page.
      try {
        if (/(^#|&)type=recovery(&|$)/.test(location.hash || "") && pageKey() !== "reset-password") {
          location.replace("/reset-password" + location.hash);
          return new Promise(() => {});
        }
      } catch (e) {}
      if (supaConfigured()) {
        try { const ok = await loadSupabaseLib();
          if (ok && global.supabase && global.supabase.createClient) {
            supa = global.supabase.createClient(CFG.url, CFG.anonKey,
              { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.localStorage },
                global: { fetch: authAwareFetch } });
            const { data: { session } } = await supa.auth.getSession();
            currentUser = session ? session.user : null;
            if (currentUser) hadSession = true;
            // Session-expiry watcher: a SIGNED_OUT we did not ask for (refresh token
            // failed / revoked / signed out in another tab) → back to login.
            try {
              supa.auth.onAuthStateChange((event, sess) => {
                // Another tab signed in as a DIFFERENT person: this tab's role / matrix /
                // studio caches belong to the old user — drop them and reload.
                if (sess && sess.user && currentUser && sess.user.id !== currentUser.id && !explicitSignOut && !localAuthOp && gatePage() && pageKey() !== "login" && pageKey() !== "reset-password") {
                  currentUser = sess.user; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null;
                  studioSlugCache = null; pendingStep = null; sessClear();
                  setTimeout(function () { try { location.reload(); } catch (e) {} }, 0);
                  return;
                }
                // first sign-in in this browser (e.g. returning from Google): start the session clock
                if (event === "SIGNED_IN" && sess && sess.user) { const st = sessionStart(); if (!st || st.uid !== sess.user.id) stampSessionStart(sess.user.id, true); }
                if (sess && sess.user) { hadSession = true; if (!explicitSignOut) currentUser = sess.user; }
                if ((event === "SIGNED_OUT" && !explicitSignOut) || (event === "TOKEN_REFRESHED" && !sess)) {
                  // Don't log the user out on a transient blip. supabase-js can emit a
                  // spurious SIGNED_OUT during a flaky refresh; route through onAuthFailure,
                  // which tries refreshSession() first and only redirects on a hard failure
                  // while genuinely online. (defer: supabase-js holds its auth lock here.)
                  setTimeout(function () { onAuthFailure(); }, 0);
                }
              });
            } catch (e) { /* older client — best effort */ }
            // Supabase is configured ⇒ the app uses accounts; no session ⇒ must sign in.
            authRequired = !currentUser;
            mode = "supabase";
            // signed in, but a sign-in step (two-step code / temp password / reset) may be pending.
            // On a protected page the studio lookup runs at the same time (it is only
            // USED after the step check passed — the page still shows only after both).
            if (currentUser && gatePage()) {
              if (PAGE_GATED) {
                orgEarly = orgIdStrict(); orgEarly.catch(() => {});
                profEarly = fetchProfileStatus(false); profEarly.catch(() => {});   // 0041 profile step, same round-trip
              }
              await evaluateGate();
              // role + access matrix are needed by nearly every page right after it
              // shows: start them now (cached per tab; failures are retried by the page)
              if (PAGE_GATED && !pendingStep) loadAccess().catch(() => {});
            }
            mode = "supabase";
            await runPageGate();          // protected page: confirm session + studio before it shows
            return mode;
          }
        } catch (e) { console.warn("[BPStore] Supabase init error, falling back:", e && e.message); }
      }
      try { await api("GET", "/health"); mode = "server"; } catch (e) { mode = "local"; }
      await runPageGate();            // no Supabase session possible: reveal only when accounts aren't configured
      return mode;
    })();
    return ready;
  }

  const tier = () => (mode === "supabase" ? sb : mode === "server" ? server : ls);

  // each op uses the active tier. In Supabase mode a failure (RLS denial or a
  // network blip) must SURFACE — silently diverting the write to localStorage
  // would fake success and split-brain the data. Only server/local tiers keep
  // the offline localStorage fallback.
  async function withFallback(fn, localFn) {
    try { return await fn(tier()); }
    catch (e) {
      if (mode === "supabase") throw e;
      return localFn(ls);
    }
  }

  /* ---------------- auth / RBAC ---------------- */
  // Resolve this user's role. A transient profiles-fetch failure must NEVER
  // downgrade to a low-privilege role (that used to get cached by loadAccess and
  // stick for the whole page — the "Leads tab appears only after clicking another
  // tab" bug). Instead: retry a few times, dedupe concurrent callers with one
  // in-flight promise, cache ONLY a successful lookup, and return null (unknown)
  // if it genuinely can't resolve so callers deny-this-render without caching.
  // Background refresh of a stale cached role + matrix (stale-while-revalidate). Both
  // entries are written together, and only when BOTH reads succeed; the in-memory
  // values of this page are left alone (the next navigation uses the new ones).
  let accessRecheck = false;
  function revalidateAccess(uid) {
    if (accessRecheck || !supa || !uid) return;
    accessRecheck = true;
    (async () => {
      const p = await supa.from("profiles").select("role").eq("id", uid).single();
      if (!p || p.error || !currentUser || currentUser.id !== uid) return;
      const r = (p.data && p.data.role) || "client";
      const ra = await supa.from("role_access").select("area,can_view,can_edit").eq("role", r);
      if (!ra || ra.error || !currentUser || currentUser.id !== uid) return;
      const map = {};
      (ra.data || []).forEach((row) => { map[row.area] = { view: !!row.can_view, edit: !!row.can_edit }; });
      sessSet("bp_sess_role", uid, r);
      sessSet("bp_sess_access", uid, { role: r, map });
    })().catch(() => {}).then(() => { accessRecheck = false; });
  }
  async function getRole() {
    if (!supa || !currentUser) return null;
    if (roleCache) return roleCache;
    const cached = sessEntry("bp_sess_role", currentUser.id);
    if (cached && cached.val) { roleCache = cached.val; if (!cached.fresh) revalidateAccess(currentUser.id); return roleCache; }
    if (rolePromise) return rolePromise;
    rolePromise = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { data, error } = await supa.from("profiles").select("role").eq("id", currentUser.id).single();
          if (error) throw error;
          roleCache = (data && data.role) || "client";
          sessSet("bp_sess_role", currentUser.id, roleCache);
          return roleCache;
        } catch (e) {
          if (attempt < 2) { await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); continue; }
          return null;   // unknown after retries — do NOT guess a role
        }
      }
    })();
    try { return await rolePromise; } finally { rolePromise = null; }
  }
  // Load this user's access matrix (rows for their role). RLS returns only their
  // own role's rows. If the table is absent (phase29 not run) map stays null and
  // callers fall back to the legacy VIEW_SCOPE. Cached until sign-in/out/role change.
  async function loadAccess() {
    if (accessCache) return accessCache;
    const csnap = currentUser && sessEntry("bp_sess_access", currentUser.id);
    // a snapshot is used only for the role this page resolved (never mixes two roles)
    if (csnap && csnap.val && csnap.val.role && (!roleCache || csnap.val.role === roleCache)) {
      roleCache = csnap.val.role;   // role and matrix of this page always come from the same snapshot
      accessCache = csnap.val; if (!csnap.fresh) revalidateAccess(currentUser.id); return accessCache;
    }
    if (accessPromise) return accessPromise;              // dedupe the parallel canView fan-out
    accessPromise = (async () => {
      const r = await getRole();
      if (!r) return { role: null, map: null };           // role unknown → transient, do NOT cache; next call retries
      try {
        const { data, error } = await supa.from("role_access").select("area,can_view,can_edit").eq("role", r);
        if (error) throw error;
        const map = {};
        (data || []).forEach((row) => { map[row.area] = { view: !!row.can_view, edit: !!row.can_edit }; });
        accessCache = { role: r, map };
        if (currentUser) sessSet("bp_sess_access", currentUser.id, accessCache);
      } catch (e) {
        // A network/auth failure is NOT "phase29 absent": don't cache a legacy
        // fallback for the session — report unknown (fail closed) and retry next call.
        const UI = global.BPUI;
        if (UI && (UI.isNetworkError(e) || UI.isAuthError(e))) return { role: r, map: null, unknown: true };
        accessCache = { role: r, map: null };             // legacy fallback (phase29 role_access absent)
      }
      return accessCache;
    })();
    try { return await accessPromise; } finally { accessPromise = null; }
  }
  // Full-page panel shown by requireView: "denied" (role lacks access) or
  // "offline" (role/access couldn't be loaded — network), themed via page tokens.
  function gatePanel(kind) {
    try {
      document.querySelectorAll("#app").forEach((e) => { e.hidden = true; });
      ["gate", "notfound", "boot"].forEach((idv) => { const g = document.getElementById(idv); if (g) g.hidden = true; });
      ["__noaccess", "__noreach"].forEach((idv) => { const g = document.getElementById(idv); if (g) g.remove(); });
      const box = document.createElement("div");
      box.id = kind === "offline" ? "__noreach" : "__noaccess";
      box.setAttribute("role", kind === "offline" ? "alert" : "status");
      box.style.cssText = "max-width:520px;margin:64px auto;padding:28px;border-radius:14px;background:var(--panel,#fff);border:1px solid var(--line,#d7deea);box-shadow:0 10px 30px rgba(20,27,46,.1);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;color:var(--ink-2,#4a5673)";
      if (kind === "offline") {
        box.innerHTML = '<div style="font-size:34px" aria-hidden="true">📡</div><h2 style="color:var(--ink,#141b2e);margin:10px 0 6px">Couldn’t reach the server</h2>' +
          '<p style="margin:0 0 16px">We couldn’t load your access for this page. Check your connection and try again.</p>' +
          '<button type="button" class="btn primary" data-retry style="min-height:40px;padding:0 18px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer">Retry</button>' +
          '<p style="margin:14px 0 0"><a href="dashboard.html" style="color:var(--accent,#6d28d9);font-weight:600">← Back to dashboard</a></p>';
        box.querySelector("[data-retry]").addEventListener("click", () => location.reload());
      } else {
        box.innerHTML = '<div style="font-size:34px" aria-hidden="true">🔒</div><h2 style="color:var(--ink,#141b2e);margin:10px 0 6px">No access</h2><p style="margin:0 0 14px">Your role doesn’t have access to this page. Ask an admin if you need it.</p><a href="dashboard.html" style="color:var(--accent,#6d28d9);font-weight:600">← Back to dashboard</a>';
      }
      (document.querySelector("main") && !document.querySelector("main").closest("#app") ? document.querySelector("main") : document.body).appendChild(box);
    } catch (e) { /* non-browser context */ }
  }
  const auth = {
    enabled: () => mode === "supabase",
    // Calling required() marks this page as auth-gated (session expiry → login redirect).
    required: () => { authGateUsed = true; if (currentUser && !pendingStep) startSessionLimits(); return authRequired || !!pendingStep; },
    // null while a sign-in step is pending (two-step code, temp password, reset) — see evaluateGate
    user: () => (pendingStep ? null : currentUser),
    // the signed-in account even while a step is pending (login / reset pages only)
    pendingUser: () => currentUser,
    pendingStep: () => pendingStep,
    resolveGate: () => evaluateGate(),
    // same-site ?next= sanitiser (login.html) — always returns one of the app's own pages
    safeNext: (raw) => safeNext(raw),
    // Helm platform operator? Only meaningful (and only asked) for an account with no
    // studio; false on any error. UI routing only — hq_* RPCs enforce it server-side.
    isPlatformAdmin: () => isPlatformAdmin(),
    // No-studio account: if it is a platform operator, location.replace → HQ and resolve
    // true; otherwise resolve false (caller shows onboarding). Never creates anything.
    operatorToHq: () => operatorToHq(),
    role: getRole,
    // Synchronous, cache-only role (null if not loaded yet / unknown). Never fetches.
    cachedRole: () => roleCache || (currentUser ? sessGet("bp_sess_role", currentUser.id) : null),
    // Route an error through the session-expiry check. Resolves true if a redirect started.
    handleAuthError: (e) => (looksLikeAuthError(e) ? onAuthFailure() : Promise.resolve(false)),
    // In non-Supabase (server/local) mode there is no auth ⇒ single-user, full access.
    // Unknown role (profiles unreachable) fails CLOSED for every capability.
    async can(cap) { if (mode !== "supabase") return true; if (!currentUser) return false; const r = await getRole(); if (!r) return false; return (ROLE_CAPS[r] || ["view"]).includes(cap); },
    canEdit: async () => { if (mode !== "supabase") return true; if (!currentUser) return false; const r = await getRole(); return EDIT_ROLES.includes(r); },
    // ---- role-based VIEW scope (must mirror the RLS read policies in phase21-hardening.sql) ----
    // finance = money pages/tables; pipeline = leads/CRM/discovery/proposal; ops = resources/planning/day-of; workspace = the event hub.
    // Area may be a fine key (e.g. "leads") or a legacy coarse key ("finance",
    // "pipeline", "ops", "workspace", "manage"). Driven by the live role_access
    // matrix; falls back to VIEW_SCOPE only when the matrix isn't present.
    async canView(area) {
      if (mode !== "supabase") return true;          // single-user offline/server mode
      if (!currentUser) return false;
      const r = await getRole();
      if (r === "admin") return true;                // admin: full floor
      const acc = await loadAccess();
      if (acc.unknown) return false;                 // matrix unreachable → fail closed (not cached)
      const fine = COARSE_TO_FINE[area];             // set only for coarse keys
      if (acc.map) {
        if (fine) return fine.some((k) => acc.map[k] && acc.map[k].view);   // coarse: any child visible
        return !!(acc.map[area] && acc.map[area].view);                     // fine key
      }
      // legacy fallback (phase29 not yet applied)
      const coarse = fine ? area : (FINE_TO_COARSE[area] || area);
      return (VIEW_SCOPE[coarse] || []).includes(r);
    },
    // Can this role EDIT a given area (fine or coarse key)?
    async canEditArea(area) {
      if (mode !== "supabase") return true;
      if (!currentUser) return false;
      const r = await getRole();
      if (r === "admin") return true;
      const acc = await loadAccess();
      if (acc.unknown) return false;
      const fine = COARSE_TO_FINE[area];
      if (acc.map) {
        if (fine) return fine.some((k) => acc.map[k] && acc.map[k].edit);
        return !!(acc.map[area] && acc.map[area].edit);
      }
      return EDIT_ROLES.includes(r);
    },
    areas: () => AREAS.slice(),
    // Force a fresh read of the access matrix (drop the in-memory + sessionStorage
    // cache). Used when a just-granted permission must show up without waiting for
    // the 60s cache TTL or a re-login (e.g. the dashboard nav retry).
    async refreshAccess() { accessCache = null; accessPromise = null; try { sessionStorage.removeItem("bp_sess_access"); } catch (e) {} return loadAccess(); },
    // Whole-page guard: if the signed-in role can't view `area`, hide #app and show a
    // "no access" panel, returning false. Call it right after the login check on a page.
    // If the role/access matrix could not be LOADED (network), it shows a "Couldn't
    // reach the server — Retry" panel instead of the lock panel (still returns false).
    async requireView(area) {
      authGateUsed = true;
      if (mode === "supabase" && (pendingStep || !currentUser)) { gatePanel("denied"); return false; }
      startSessionLimits();
      if (mode === "supabase" && currentUser) {
        const r = await getRole();
        let unknown = !r;
        if (r && r !== "admin") { const acc = await loadAccess(); unknown = !!acc.unknown; }
        if (unknown) { gatePanel("offline"); return false; }
      }
      if (await this.canView(area)) return true;
      gatePanel("denied");
      return false;
    },
    // Password sign-in. opts.captchaToken = the Turnstile token when CAPTCHA is on.
    // Always starts a FRESH session: a previous session in this browser is ended
    // first, and per-user browser state is cleared when the account changes.
    async signIn(email, password, opts) {
      if (!supa) throw new Error("Supabase not configured");
      const captchaToken = opts && opts.captchaToken;
      if (CAPTCHA && !captchaToken) {
        // in-page sign-in boxes have no CAPTCHA widget → send them to the sign-in page
        const e = new Error("Please sign in on the sign-in page."); e.code = "captcha_required";
        if (pageKey() !== "login") { try { location.href = "login.html?next=" + encodeURIComponent((location.pathname.split("/").pop() || "dashboard.html") + location.search); } catch (x) {} }
        throw e;
      }
      localAuthOp++;
      try {
        const prev = currentUser;
        if (prev) { explicitSignOut = true; try { await supa.auth.signOut({ scope: "local" }); } catch (e) {} currentUser = null; pendingStep = null; }
        const { data, error } = await supa.auth.signInWithPassword(captchaToken ? { email, password, options: { captchaToken } } : { email, password });
        if (error) throw error;
        const st = sessionStart();
        if ((prev && prev.id !== data.user.id) || (st && st.uid !== data.user.id)) userLocalClear();
        currentUser = data.user; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; sessClear(); authRequired = false;
        hadSession = true; explicitSignOut = false; sessionExpired = false; limitOut = false;
        stampSessionStart(currentUser.id, true);
        lsDel(RECOVERY_KEY);
        await evaluateGate();
        return currentUser;
      } finally { localAuthOp--; }
    },
    // Phase 58 — self-serve sign-up (studio created via create_studio once a session exists)
    async signUp(email, password, opts) {
      if (!supa) throw new Error("Supabase not configured");
      const bad = passwordProblem(password); if (bad) throw new Error(bad);
      const captchaToken = opts && opts.captchaToken;
      if (CAPTCHA && !captchaToken) { const e = new Error("Please complete the security check."); e.code = "captcha_required"; throw e; }
      localAuthOp++;
      try {
        const { data, error } = await supa.auth.signUp(captchaToken ? { email, password, options: { captchaToken } } : { email, password });
        if (error) throw error;
        if (data.session) { userLocalClear(); currentUser = data.user; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; sessClear(); authRequired = false; stampSessionStart(currentUser.id, true); await evaluateGate(); }
        return { user: data.user, session: data.session };   // session null when email confirmation is required
      } finally { localAuthOp--; }
    },
    // Google OAuth sign-in (requires the Google provider enabled in Supabase).
    // Redirects the browser to Google; on return, login.html resumes (and, for a
    // pending studio signup, calls create_studio). redirectTo must be an allowed
    // Redirect URL in Supabase → Authentication → URL Configuration.
    // No offline access is requested: Helm never calls Google APIs, so it neither
    // needs nor should receive a long-lived Google refresh token. The implicit flow
    // is kept on purpose (PKCE recommended later — docs/AUTH-DASHBOARD-SETTINGS.md).
    async signInWithGoogle(redirectTo) {
      if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirectTo || (location.origin + "/login.html"),
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
      return data; // browser navigates away to Google
    },
    // Explicit "Log out" = global sign-out (revokes every device's refresh token).
    async signOut() { explicitSignOut = true; reauthClear(); if (supa) { try { await supa.auth.signOut(); } catch (e) { try { await supa.auth.signOut({ scope: "local" }); } catch (x) {} } } currentUser = null; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; pendingStep = null; sessClear(); userLocalClear(); studioSlugCache = null;
      lsDel(SESSION_START_KEY); lsDel(RECOVERY_KEY);
      if (mode === "supabase") authRequired = true; },
    // End every OTHER session of this account (other browsers / devices); this one stays.
    async signOutOthers() {
      if (!supa) throw new Error("Supabase not configured");
      const { error } = await supa.auth.signOut({ scope: "others" });
      if (error) throw error; return true;
    },
    // Option A: does the signed-in user still hold a temp password they must replace?
    // FAILS CLOSED: an error is thrown (never "no"), so a failed check can't let
    // someone skip the forced change. A database without the function → false.
    async passwordChangeRequired() {
      if (!supa) return false;
      const { data, error } = await supa.rpc("password_change_required");
      if (error) { if (isMissingFn(error)) return false; throw error; }
      return data === true;
    },
    // Set the user's own new password (forced temp-password change), then clear the
    // must-change flag. The server refuses to clear it until the password really
    // changed (0028); a failure is an error — never silently ignored.
    async completePasswordChange(newPassword) {
      if (!supa) throw new Error("Supabase not configured");
      const bad = passwordProblem(newPassword); if (bad) throw new Error(bad);
      // only while the server says this account holds a temp password (evaluateGate)
      if (!pwChangedAwaitingClear && pendingStep !== "password") { const e = new Error("Please sign in again to change your password."); e.code = "reauth_required"; throw e; }
      if (!pwChangedAwaitingClear) {
        const { error } = await supa.auth.updateUser({ password: newPassword });
        if (error) {
          if (/different from the old|same_password/i.test(String(error.message || "") + " " + String(error.code || ""))) throw new Error("Choose a password that's different from the temporary one.");
          throw error;
        }
        pwChangedAwaitingClear = true;   // a retry only re-runs the clear below
      }
      let lastErr = null;
      for (let i = 0; i < 3; i++) {
        const { error } = await supa.rpc("clear_password_change_required");
        if (!error || isMissingFn(error)) { lastErr = null; break; }
        lastErr = error; await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
      if (lastErr) throw lastErr;
      pwChangedAwaitingClear = false;
      try { if (currentUser) sessionStorage.setItem(PW_OK_KEY, currentUser.id); } catch (e) {}
      try { await supa.auth.signOut({ scope: "others" }); } catch (e) {}
      await evaluateGate();
      return true;
    },
    // ---- self-service password reset / change -----------------------------------
    passwordRule: { min: PW_MIN, symbols: PW_SYMBOLS, hint: PW_HINT, problem: passwordProblem, checks: passwordChecks, attachChecklist: attachPasswordChecklist },
    // Resolves the same way whether or not the email has an account (the caller
    // shows one generic message). Only rate-limit / network / CAPTCHA errors throw.
    async requestPasswordReset(email, opts) {
      if (!supa) throw new Error("Supabase not configured");
      const captchaToken = opts && opts.captchaToken;
      if (CAPTCHA && !captchaToken) { const e = new Error("Please complete the security check."); e.code = "captcha_required"; throw e; }
      const o = { redirectTo: (opts && opts.redirectTo) || (location.origin + "/reset-password") };
      if (captchaToken) o.captchaToken = captchaToken;
      const { error } = await supa.auth.resetPasswordForEmail(String(email || "").trim(), o);
      if (error) {
        const st = Number(error.status) || 0, m = String(error.message || "");
        if (st === 429 || /rate limit|too many/i.test(m)) { const e = new Error("Too many requests — please wait a few minutes and try again."); e.code = "rate_limited"; throw e; }
        if (/captcha/i.test(m)) { const e = new Error("The security check failed — please try again."); e.code = "captcha_failed"; throw e; }
        if (global.BPUI && global.BPUI.isNetworkError && global.BPUI.isNetworkError(error)) throw error;
        // anything else (e.g. "user not found" on older GoTrue builds) is deliberately not shown
      }
      return true;
    },
    // Re-check the CURRENT password before a change (signs in again as the same
    // email). Returns "mfa" when the new session still needs the two-step code.
    // FAILS CLOSED: any error (wrong password, rate limit, a different account
    // coming back) → one generic message, and no change proof is recorded.
    hasPassword: () => hasPasswordLogin(),
    isRecoverySession: () => isRecoverySession(),
    async reverifyPassword(currentPassword, opts) {
      reauthClear();
      if (!supa || !currentUser || !currentUser.email) throw new Error("Not signed in");
      if (!hasPasswordLogin()) { const e = new Error("This account signs in with Google, so it has no Helm password to change."); e.code = "bad_current_password"; throw e; }
      if (typeof currentPassword !== "string" || !currentPassword) { const e = new Error("Your current password isn't right."); e.code = "bad_current_password"; throw e; }
      const captchaToken = opts && opts.captchaToken;
      if (CAPTCHA && !captchaToken) { const e = new Error("Please complete the security check."); e.code = "captcha_required"; throw e; }
      localAuthOp++;
      try {
        const email = currentUser.email, uid = currentUser.id;
        let res;
        try { res = await supa.auth.signInWithPassword(captchaToken ? { email, password: currentPassword, options: { captchaToken } } : { email, password: currentPassword }); }
        catch (x) { res = { data: null, error: x }; }
        const { data, error } = res || {};
        if (error || !data || !data.user || data.user.id !== uid) { const e = new Error("Your current password isn't right."); e.code = "bad_current_password"; e.cause = error; throw e; }
        currentUser = data.user; explicitSignOut = false;
        reauth = { uid, until: Date.now() + REAUTH_MS, pw: currentPassword };
        const { data: lv } = await supa.auth.mfa.getAuthenticatorAssuranceLevel();
        return (lv && lv.nextLevel === "aal2" && lv.currentLevel !== "aal2") ? "mfa" : null;
      } finally { localAuthOp--; }
    },
    // Set a new password for the signed-in user (reset link or change), then end
    // every other session. The rule is enforced here AND by the Supabase policy.
    // Allowed only (a) right after reverifyPassword() for this account, or (b) in a
    // genuine reset-link session (JWT amr "recovery"). Anything else fails closed.
    // The current password is also sent as current_password so the server-side
    // "require current password" Auth setting can be switched on without app changes.
    async updatePassword(newPassword) {
      if (!supa) throw new Error("Supabase not configured");
      const bad = passwordProblem(newPassword); if (bad) throw new Error(bad);
      const fresh = reauthFresh();
      if (!fresh && !(await isRecoverySession())) { reauthClear(); const e = new Error("Please confirm your current password first."); e.code = "reauth_required"; throw e; }
      const attrs = { password: newPassword };
      if (fresh && reauth.pw) attrs.current_password = reauth.pw;
      const { error } = await supa.auth.updateUser(attrs);
      if (error) {
        if (/different from the old|same_password/i.test(String(error.message || "") + " " + String(error.code || ""))) throw new Error("Choose a password that's different from your current one.");
        throw error;
      }
      reauthClear();
      lsDel(RECOVERY_KEY);
      try { await supa.auth.signOut({ scope: "others" }); } catch (e) {}
      return true;
    },
    // reset-link bookkeeping (reset-password.html): until the new password is set,
    // every staff page in this browser sends the person back to the reset page.
    recovery: {
      mark(uid) { if (uid) lsSet(RECOVERY_KEY, uid); if (currentUser && uid === currentUser.id) pendingStep = "recovery"; },
      clear() { lsDel(RECOVERY_KEY); },
    },
    // ---- two-step verification (TOTP, Supabase Auth MFA) ------------------------
    mfa: {
      async level() { if (!supa) return null; const { data, error } = await supa.auth.mfa.getAuthenticatorAssuranceLevel(); if (error) throw error; return data; },
      // every factor of this user, incl. unfinished enrolments
      async factors() {
        if (!supa) return [];
        const { data, error } = await supa.auth.mfa.listFactors();
        if (error) throw error;
        return (data && (data.all || data.totp)) || [];
      },
      async verifiedTotp() { return (await this.factors()).filter((f) => f.factor_type === "totp" && f.status === "verified"); },
      // Start enrolment → { factorId, qr (SVG data URI for <img src>), secret }.
      // Unfinished earlier attempts are removed first (Supabase refuses duplicates).
      async enrollTotp() {
        if (!supa) throw new Error("Supabase not configured");
        for (const f of await this.factors()) {
          if (f.factor_type === "totp" && f.status !== "verified") { try { await supa.auth.mfa.unenroll({ factorId: f.id }); } catch (e) {} }
        }
        const { data, error } = await supa.auth.mfa.enroll({ factorType: "totp", friendlyName: "Helm " + new Date().toISOString().slice(0, 16).replace("T", " ") });
        if (error) throw error;
        return { factorId: data.id, qr: (data.totp && data.totp.qr_code) || "", secret: (data.totp && data.totp.secret) || "" };
      },
      // finish enrolment (or step up) with a 6-digit code from the authenticator app
      async verify(factorId, code) {
        if (!supa) throw new Error("Supabase not configured");
        const uid = currentUser && currentUser.id;
        const wait = mfaLockLeft(uid);
        if (wait > 0) throw mfaLockedError(wait);
        const c = String(code || "").replace(/\s+/g, "");
        if (!/^\d{6}$/.test(c)) throw new Error("Enter the 6-digit code from your authenticator app.");
        let error = null;
        try { error = (await supa.auth.mfa.challengeAndVerify({ factorId, code: c })).error; } catch (x) { error = x; }
        if (error) {
          // Network trouble is not a wrong code (no lockout strike; friendlyError explains it)
          if (global.BPUI && global.BPUI.isNetworkError && global.BPUI.isNetworkError(error)) throw error;
          const st = Number(error.status) || 0, msg = String(error.message || "") + " " + String(error.code || "");
          const left = (st === 429 || /rate.?limit|too many/i.test(msg)) ? mfaLockFor(uid, 60000) : mfaStrike(uid);
          if (left > 0) throw mfaLockedError(left, error);
          // one generic message: never says whether the factor, the challenge or the code was the problem
          const e = new Error("That code didn't work. Codes change every 30 seconds — enter the newest one, and check the time on your phone is set automatically."); e.code = "mfa_invalid"; e.cause = error; throw e;
        }
        mfaLockClear();
        const { data: s } = await supa.auth.getSession(); if (s && s.session) currentUser = s.session.user;
        await evaluateGate();
        return true;
      },
      // seconds until another code may be tried (0 = now) — UI countdown
      lockedSeconds() { return Math.ceil(mfaLockLeft(currentUser && currentUser.id) / 1000); },
      // Helm platform operator (HQ) two-step requirement — no skip, no opt-out:
      //   "none"      not an operator (or not signed in): nothing changes for this account
      //   "enroll"    operator without a verified authenticator → must set one up now
      //   "challenge" operator with an authenticator, session still aal1 → must enter a code
      //               (also any session already waiting for its two-step code)
      //   "ok"        operator at aal2
      //   "unknown"   operator, but the factors / level couldn't be read → fail CLOSED
      // Factors are only ever read AFTER is_platform_admin() said yes (nothing about an
      // ordinary account's authenticators is looked at or shown here).
      async operatorStep() {
        if (!supa || !currentUser) return "none";
        if (pendingStep === "mfa") return "challenge";       // aal1 with a verified factor (is_platform_admin() is false until aal2)
        if (pendingStep) return "none";                       // temp password / reset: those pages finish it first
        if (!(await isPlatformAdmin())) return "none";
        try {
          const [lv, fs] = await Promise.all([this.level(), this.verifiedTotp()]);
          return operatorMfaDecision(lv, fs.length);
        } catch (e) { return "unknown"; }
      },
      // sign-in step-up: verify against the account's verified authenticator
      async challenge(code) {
        const f = (await this.verifiedTotp())[0];
        if (!f) throw new Error("No authenticator is set up for this account.");
        return this.verify(f.id, code);
      },
      async unenroll(factorId) {
        if (!supa) throw new Error("Supabase not configured");
        const { error } = await supa.auth.mfa.unenroll({ factorId });
        if (error) throw error;
        try { await supa.auth.refreshSession(); } catch (e) {}
        return true;
      },
      requiredForAdmins: () => AUTH_CFG.mfaRequiredForAdmins,
      _operatorDecision: operatorMfaDecision,
    },
    // ---- CAPTCHA (Cloudflare Turnstile through Supabase's captchaToken) ----------
    captcha: { enabled: () => !!CAPTCHA, siteKey: () => (CAPTCHA ? CAPTCHA.siteKey : ""), provider: () => (CAPTCHA ? CAPTCHA.provider : "") },
    // ---- the caller's own sign-in details (my_auth_info, 0028) -------------------
    async myAuthInfo() {
      if (!supa || !currentUser) return null;
      const { data, error } = await supa.rpc("my_auth_info");
      if (error) { if (isMissingFn(error)) return null; throw error; }
      return data;
    },
    // ---- session limits (account panel + tests) ----------------------------------
    sessionLimits: { config: () => Object.assign({}, AUTH_CFG), decision: sessionDecision, start: () => startSessionLimits() },
    onChange(cb) { if (supa) supa.auth.onAuthStateChange((_e, session) => {
      if (localAuthOp) return;   // this tab's own sign-in in progress — its caller updates state
      currentUser = session ? session.user : null; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; sessClear();
      if (mode === "supabase") authRequired = !currentUser; if (cb) cb(currentUser); }); },
    // ---- admin user management (RPC guarded by is_admin() at the DB) ----
    admin: {
      roles: () => ALL_ROLES.slice(),
      roleLabel,
      areas: () => AREAS.slice(),
      // the whole access matrix (admin only) → [{role,area,can_view,can_edit}]
      async getAccess() {
        if (!supa) throw new Error("Supabase not configured");
        const { data, error } = await supa.rpc("admin_get_role_access");
        if (error) throw error; return data || [];
      },
      // set one cell; returns the saved row
      async setAccess(role, area, canView, canEdit) {
        if (!supa) throw new Error("Supabase not configured");
        const { data, error } = await supa.rpc("admin_set_role_access",
          { p_role: role, p_area: area, p_view: !!canView, p_edit: !!canEdit });
        if (error) throw error; accessCache = null; return data;
      },
      async listUsers() {
        if (!supa) throw new Error("Supabase not configured");
        const { data, error } = await supa.from("profiles")
          .select("id,email,full_name,role,created_at").order("role", { ascending: true });
        if (error) throw error; return data;
      },
      // User control (0041): everyone in my studio WITH their profile, privacy-filtered by the
      // DB (phone / city / emergency contact only for admins + users-view). Before 0041 is
      // applied → today's list. → { rows, profiles: true|false }
      async members() {
        if (!supa) throw new Error("Supabase not configured");
        if (!memberListMissing) {
          const { data, error } = await supa.rpc("member_profile_list");
          if (!error) return { rows: Array.isArray(data) ? data : [], profiles: true };
          if (!rpcMissing(error)) throw error;
          memberListMissing = true;
        }
        return { rows: (await this.listUsers()) || [], profiles: false };
      },
      // admin edit of a member's profile (+ day rate / employment type on their staff row).
      // `orig` = the row as loaded, `form` = the dialog's values: only CHANGED fields are sent.
      // → the saved row, or null when nothing changed.
      async updateMember(userId, orig, form) {
        if (!supa) throw new Error("Supabase not configured");
        const bad = memberProfileProblems(form);
        const keys = Object.keys(bad);
        if (keys.length) { const e = new Error(bad[keys[0]]); e.code = "22023"; e.fields = bad; throw e; }
        const patch = memberProfilePatch(orig, form);
        if (!Object.keys(patch).length) return null;
        return rpc("admin_update_member_profile", { p_user: userId, p_profile: patch });
      },
      memberProblems: memberProfileProblems,
      memberPatch: memberProfilePatch,
      memberErrorText,
      mobile: memberMobile,
      async createUser(email, password, role) {
        if (!supa) throw new Error("Supabase not configured");
        const bad = passwordProblem(password); if (bad) throw new Error(bad);   // same rule as 0028 admin_create_user
        const { data, error } = await supa.rpc("admin_create_user",
          { p_email: email, p_password: password, p_role: role });
        if (error) throw error; return data;   // new user id
      },
      // Option A: server generates a one-time temp password + forces a change on
      // first login. Returns { user_id, temp_password } — show temp_password ONCE.
      async createUserTemp(email, role) {
        if (!supa) throw new Error("Supabase not configured");
        const { data, error } = await supa.rpc("admin_create_user_temp",
          { p_email: email, p_role: role });
        if (error) throw error; return data;   // { user_id, temp_password }
      },
      async setRole(id, role) {
        if (!supa) throw new Error("Supabase not configured");
        const { error } = await supa.rpc("admin_set_role", { p_id: id, p_role: role });
        if (error) throw error; return true;
      },
      async deleteUser(id) {
        if (!supa) throw new Error("Supabase not configured");
        const { error } = await supa.rpc("admin_delete_user", { p_id: id });
        if (error) throw error; return true;
      },
    },
  };

  /* ---------------- list paging (perf, Oct 2026) ----------------
     The production DB is ~250 ms away from the people using it, so a list view must
     never download a whole table (or a table's heavy JSON) to show one screen.
     A page = { rows, hasMore, offset } where offset is where the NEXT page starts.
     We ask for limit+1 rows: the extra row says "there is more" without a COUNT. */
  const PAGE_SIZE = Math.max(5, Math.min(200, parseInt(CFG.pageSize, 10) || 25));   // window.SUPABASE_CONFIG.pageSize
  const pageLimit = (n) => Math.max(1, Math.min(500, parseInt(n, 10) || PAGE_SIZE));
  const pageOffset = (n) => Math.max(0, parseInt(n, 10) || 0);
  // User text inside a LIKE pattern must match literally: escape \ % _ ; PostgREST turns
  // every * into %, which can't be escaped, so it is dropped.
  function likeEscape(s) { return String(s == null ? "" : s).replace(/\*/g, "").replace(/[\\%_]/g, (c) => "\\" + c); }
  // "%term%" for .ilike(), or null for a blank search (capped at 100 chars)
  function likeTerm(term) { const t = likeEscape(String(term == null ? "" : term).trim().slice(0, 100)); return t ? "%" + t + "%" : null; }
  // inside or=(…) a value with reserved chars (, . : ( ) ") must be double-quoted, \ and " escaped
  const pgQuote = (v) => '"' + String(v).replace(/[\\"]/g, (c) => "\\" + c) + '"';
  // or=(colA.ilike."%t%",colB.ilike."%t%") — null when the search is blank
  function orIlike(cols, term) { const p = likeTerm(term); return p ? cols.map((c) => c + ".ilike." + pgQuote(p)).join(",") : null; }
  // run a built query for one page (limit+1 rows → hasMore)
  async function sbPage(query, o) {
    const limit = pageLimit(o && o.limit), offset = pageOffset(o && o.offset);
    const { data, error, count } = await query.range(offset, offset + limit);
    if (error) throw error;
    const rows = data || [];
    const out = { rows: rows.slice(0, limit), hasMore: rows.length > limit, offset: offset + Math.min(rows.length, limit) };
    if (typeof count === "number") out.total = count;   // only when the query asked for { count: "exact" }
    return out;
  }
  // the same contract over an in-memory array (local / offline mode)
  function arrPage(arr, o) {
    const limit = pageLimit(o && o.limit), offset = pageOffset(o && o.offset), a = arr || [];
    const rows = a.slice(offset, offset + limit);
    return { rows, hasMore: offset + limit < a.length, offset: offset + rows.length, total: a.length };
  }
  // case-insensitive "contains" over a few fields (local mirror of orIlike)
  function textHit(term, vals) { const t = String(term == null ? "" : term).trim().toLowerCase(); if (!t) return true;
    return vals.some((v) => String(v == null ? "" : v).toLowerCase().indexOf(t) !== -1); }
  // HEAD count: no rows travel, only the Content-Range total
  async function sbCount(query) { const { count, error } = await query; if (error) throw error; return count || 0; }
  // a column the query names doesn't exist on this database yet (older schema)
  const isMissingColumn = (e) => { const c = (e && e.code) || ""; return c === "42703" || c === "PGRST204" || /column .* does not exist/i.test(String((e && e.message) || "")); };
  const localISODate = (d) => { const x = d || new Date(); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };

  /* ---------------- quotes + versions ---------------- */
  // What a quotes LIST shows — never the full pricing JSON (line items, computed
  // breakdown, catering…), only its total and client; layouts live in quote_versions.
  const QUOTE_LIST_COLS = "id,code,title,event_type,status,lifecycle_stage,approval_status,approval_token,current_version," +
    "event_date,event_time,updated_at,created_at,confirmed_at,client,total:pricing->total,pricing_client:pricing->client";
  // A list VIEW (page) needs even less: the client's name + phone, not the whole client JSON.
  const QUOTE_PAGE_COLS = "id,code,title,event_type,status,lifecycle_stage,approval_status,current_version,event_date,event_time," +
    "updated_at,created_at,confirmed_at,client_name:client->>name,client_phone:client->>phone,total:pricing->total," +
    "pricing_client_name:pricing->client->>name,pricing_client_phone:pricing->client->>phone";
  const nameOnly = (n, p) => { const o = {}; if (n != null) o.name = n; if (p != null) o.phone = p; return o; };
  function mapQuoteSummary(q) {
    let pricing = q.pricing;
    if (!pricing) { pricing = {}; if (q.total != null) pricing.total = q.total;
      if (q.pricing_client != null) pricing.client = q.pricing_client;
      else if (q.pricing_client_name != null || q.pricing_client_phone != null) pricing.client = nameOnly(q.pricing_client_name, q.pricing_client_phone); }
    if (!q.client && (q.client_name != null || q.client_phone != null)) q = Object.assign({}, q, { client: nameOnly(q.client_name, q.client_phone) });
    return { id: q.id, code: q.code, title: q.title, eventType: q.event_type, status: q.status,
      lifecycleStage: q.lifecycle_stage || "quote",
      approvalStatus: q.approval_status || "none", approvalToken: q.approval_token,
      currentVersion: q.current_version, client: q.client || {}, pricing, total: pricing.total || 0,
      eventDate: q.event_date || null, eventTime: q.event_time || null,
      updatedAt: q.updated_at, createdAt: q.created_at, confirmedAt: q.confirmed_at,
      // 0040 soft shelves (absent → null on a database without them)
      archivedAt: q.archived_at || null, archivedReason: q.archived_reason || null,
      deletedAt: q.deleted_at || null, deletedReason: q.deleted_reason || null, linkExpiredAt: q.link_expired_at || null };
  }
  // 0040 adds quotes.archived_at / deleted_at (soft Archive / Deleted shelves). Until a
  // database has them the list queries must not name them: learn it once per tab.
  const QUOTE_SHELF_COLS = ",archived_at,archived_reason,deleted_at,deleted_reason,link_expired_at";
  let shelfColsKnown = (() => { try { const v = sessionStorage.getItem("bp_q_shelf"); return v === "1" ? true : v === "0" ? false : null; } catch (e) { return null; } })();
  const setShelfColsKnown = (v) => { shelfColsKnown = v; try { sessionStorage.setItem("bp_q_shelf", v ? "1" : "0"); } catch (e) {} };
  // run build(shelf) with the shelf columns when the database may have them; on "no
  // such column" remember that and run it again without
  async function withShelf(run) {
    if (shelfColsKnown !== false) {
      try { const r = await run(true); if (shelfColsKnown === null) setShelfColsKnown(true); return r; }
      catch (e) { if (!isMissingColumn(e)) throw e; setShelfColsKnown(false); }
    }
    return run(false);
  }
  // Quote list views (quotes.html tabs). ONE place defines them so the list, the counts
  // and the local mirror agree:
  //   archived  = flagged archived (0040), cancelled, or closed after it was confirmed
  //   deleted   = flagged deleted (0040 soft delete) — never in any other view
  //   active    = everything else;  attention = active, not cancelled, event date passed
  //   all       = everything not moved to Archive / Deleted (dashboard, pickers, counters)
  const QUOTE_VIEWS = ["all", "active", "quote", "confirmed", "attention", "archived", "deleted"];
  const quoteIsArchived = (x) => !x.deletedAt && (!!x.archivedAt || x.status === "cancelled" || (x.lifecycleStage === "closed" && x.status === "confirmed"));
  function quoteInView(x, view, today) {
    if (view === "deleted") return !!x.deletedAt;
    if (x.deletedAt) return false;
    const arch = quoteIsArchived(x);
    if (view === "archived") return arch;
    if (view === "all" || !view) return !x.archivedAt;
    if (arch) return false;
    if (view === "quote" || view === "confirmed") return x.status === view;
    if (view === "attention") return x.status !== "cancelled" && !!x.eventDate && String(x.eventDate).slice(0, 10) < today;
    return true;   // "active"
  }
  function sbQuoteView(q, view, today, shelf) {
    if (view === "deleted") return shelf ? q.not("deleted_at", "is", null) : q.eq("id", "00000000-0000-0000-0000-000000000000");
    if (shelf) q = q.is("deleted_at", null);
    if (view === "archived") return q.or("status.eq.cancelled,and(lifecycle_stage.eq.closed,status.eq.confirmed)" + (shelf ? ",archived_at.not.is.null" : ""));
    if (shelf) q = q.is("archived_at", null);   // moved quotes leave every other view
    if (view === "all" || !view) return q;
    q = q.neq("status", "cancelled").or("lifecycle_stage.is.null,lifecycle_stage.neq.closed,status.neq.confirmed");
    if (view === "quote" || view === "confirmed") q = q.eq("status", view);
    if (view === "attention") q = q.lt("event_date", today);
    return q;
  }
  // Supabase tier (RPC-backed; errors surface). Falls back to localStorage when not in supabase mode.
  const sbq = {
    // every quote, light columns (pickers, calendar, availability…). A database that
    // is missing one of the named columns falls back to select * rather than a 400.
    // Quotes moved to Archive / Deleted (0040) are left out, guarded like page().
    async list() {
      const r = await withShelf(async (shelf) => {
        let q = supa.from("quotes").select(QUOTE_LIST_COLS + (shelf ? QUOTE_SHELF_COLS : ""));
        if (shelf) q = q.is("archived_at", null).is("deleted_at", null);
        const x = await q.order("updated_at", { ascending: false });
        if (x.error) throw x.error; return x;
      }).catch(async (e) => {
        if (!isMissingColumn(e)) throw e;   // an even older schema (pre lifecycle columns): select *
        const x = await supa.from("quotes").select("*").order("updated_at", { ascending: false }); if (x.error) throw x.error; return x;
      });
      return (r.data || []).map(mapQuoteSummary);
    },
    // one page of a list view: { rows, hasMore, offset }
    //   o.view    QUOTE_VIEWS (default "all")       o.search  code / title / client name
    //   o.eventType  exact, case-insensitive          o.sort  "updated" (default) | "confirmedFirst"
    //   o.offset / o.limit
    async page(o) {
      o = o || {}; const today = localISODate();
      const build = (cols, shelf) => {
        let q = supa.from("quotes").select(cols);
        q = sbQuoteView(q, o.view, today, shelf);
        if (o.eventType) q = q.ilike("event_type", likeEscape(o.eventType));
        const s = orIlike(["code", "title", "client->>name"], o.search); if (s) q = q.or(s);
        // confirmed first: status sorts cancelled < confirmed < quote, so ascending puts
        // confirmed above quote in the active views and descending puts closed-confirmed
        // above cancelled in the archive (status is CHECK-limited to those three).
        if (o.sort === "confirmedFirst") q = q.order("status", { ascending: o.view !== "archived" });
        return q.order("updated_at", { ascending: false }).order("id", { ascending: false });
      };
      const r = await withShelf((shelf) => sbPage(build(QUOTE_PAGE_COLS + (shelf ? QUOTE_SHELF_COLS : ""), shelf), o));
      return { rows: r.rows.map(mapQuoteSummary), hasMore: r.hasMore, offset: r.offset };
    },
    // KPI counters without downloading rows (quotes moved to Archive / Deleted excluded):
    // { total, quote, confirmed, cancelled }
    async counts() {
      return withShelf(async (shelf) => {
        const c = () => { const q = supa.from("quotes").select("id", { count: "exact", head: true }); return shelf ? q.is("archived_at", null).is("deleted_at", null) : q; };
        const [total, confirmed, cancelled] = await Promise.all([sbCount(c()), sbCount(c().eq("status", "confirmed")), sbCount(c().eq("status", "cancelled"))]);
        return { total, confirmed, cancelled, quote: Math.max(0, total - confirmed - cancelled) };
      });
    },
    // codes issued for one MMDDYYYY stamp (→ nextCode) — a few short strings, not the table
    async codesFor(stamp) {
      const { data, error } = await supa.from("quotes").select("code").like("code", stamp + "-%").limit(1000);
      if (error) throw error; return data || [];
    },
    // distinct event types for the type filter (one short column, capped)
    async eventTypes() {
      const { data, error } = await supa.from("quotes").select("event_type").not("event_type", "is", null).limit(5000);
      if (error) throw error; return [...new Set((data || []).map((x) => x.event_type).filter(Boolean))];
    },
    async get(id) {
      // a truncated/garbled id from a link would reach Postgres as a 22P02 error — answer "not found" instead
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ""))) { const e = new Error("This event link is incomplete or no longer exists."); e.code = "PGRST116"; throw e; }
      const { data: q, error } = await supa.from("quotes").select("*").eq("id", id).single(); if (error) throw error;
      const { data: vs, error: e2 } = await supa.from("quote_versions")
        .select("id,version_no,label,object_count,created_at").eq("quote_id", id).order("version_no", { ascending: false });
      if (e2) throw e2;
      return { id: q.id, code: q.code, title: q.title, eventType: q.event_type, status: q.status, lifecycleStage: q.lifecycle_stage || "quote",
        approvalStatus: q.approval_status || "none", approvalToken: q.approval_token, client: q.client || {},
        pricing: q.pricing || {}, currentVersion: q.current_version, createdAt: q.created_at, updatedAt: q.updated_at,
        eventDate: q.event_date || null, eventTime: q.event_time || null,
        confirmedAt: q.confirmed_at, versions: vs.map((v) => ({ id: v.id, versionNo: v.version_no, label: v.label,
          objectCount: v.object_count, createdAt: v.created_at })) };
    },
    async setStage(id, stage) {
      const { data, error } = await supa.rpc("set_lifecycle_stage", { p_quote_id: id, p_stage: stage });
      if (error) throw error; return data;
    },
    async getVersion(quoteId, versionNo) {
      const { data, error } = await supa.from("quote_versions").select("data,version_no")
        .eq("quote_id", quoteId).eq("version_no", versionNo).single();
      if (error) throw error; return { versionNo: data.version_no, data: data.data };
    },
    // Read-only list of every saved layout version (newest first) for the builder's version
    // switcher, incl. who saved it (created_by) when that column is readable. Falls back to the
    // same column set get() uses, so an older schema can never break the list. Never writes.
    async versions(quoteId) {
      const cols = "id,version_no,label,object_count,created_at";
      let r = await supa.from("quote_versions").select(cols + ",created_by").eq("quote_id", quoteId).order("version_no", { ascending: false });
      if (r.error) r = await supa.from("quote_versions").select(cols).eq("quote_id", quoteId).order("version_no", { ascending: false });
      if (r.error) throw r.error;
      return (r.data || []).map((v) => ({ id: v.id, versionNo: v.version_no, label: v.label, objectCount: v.object_count,
        createdAt: v.created_at, createdBy: v.created_by || null }));
    },
    async create(code, title, eventType, data, objectCount, eventDate) {
      const { data: q, error } = await supa.rpc("create_quote",
        { p_code: code, p_title: title, p_event_type: eventType, p_data: data, p_object_count: objectCount, p_event_date: eventDate || null });
      if (error) throw error; return Array.isArray(q) ? q[0] : q;
    },
    // re-issue the code from the event date (idempotent); returns the (possibly new) code
    async rebrandCode(quoteId) {
      if (mode !== "supabase") return null;
      const { data, error } = await supa.rpc("rebrand_quote_code", { p_quote_id: quoteId });
      if (error) throw error; return data;
    },
    async addVersion(quoteId, label, data, objectCount) {
      const { data: v, error } = await supa.rpc("add_quote_version",
        { p_quote_id: quoteId, p_label: label, p_data: data, p_object_count: objectCount });
      if (error) throw error; return Array.isArray(v) ? v[0] : v;
    },
    async confirm(quoteId, client, pricing) {
      const { data: q, error } = await supa.rpc("confirm_quote",
        { p_quote_id: quoteId, p_client: client, p_pricing: pricing });
      if (error) throw error; return Array.isArray(q) ? q[0] : q;
    },
    // Wave 16 lost-update guard: when the caller passes expectedUpdatedAt (the
    // updated_at it last read), the update is conditioned on the row NOT having
    // changed since. quotes_set_updated bumps updated_at on every write, so a
    // concurrent edit makes the predicate miss → 0 rows → we raise a CONFLICT the
    // UI surfaces ("changed by someone else — reload"). Omit the arg for the old
    // last-write-wins behaviour (backward compatible).
    async updateMeta(quoteId, patch, expectedUpdatedAt) {
      const upd = {}; if (patch.title != null) upd.title = patch.title; if (patch.eventType != null) upd.event_type = patch.eventType;
      if (patch.client) upd.client = patch.client; if (patch.pricing) upd.pricing = patch.pricing; if (patch.status) upd.status = patch.status;
      if (patch.eventDate !== undefined) upd.event_date = patch.eventDate || null;
      if (patch.eventTime !== undefined) upd.event_time = patch.eventTime || null;
      let q = supa.from("quotes").update(upd).eq("id", quoteId);
      if (expectedUpdatedAt) q = q.eq("updated_at", expectedUpdatedAt);
      const { data, error } = await q.select();
      if (error) throw error;
      // FAIL CLOSED: an update that changed NO rows must never report success — otherwise
      // the UI flashes "Saved ✓" while nothing persisted and the data is lost on reload
      // (QA H-01). With an optimistic-lock token a 0-row result means a concurrent edit;
      // without one it means the write didn't land (lost access / row gone / RLS).
      if (!data || data.length === 0) {
        if (expectedUpdatedAt) {
          const e = new Error("This event was changed by someone else since you opened it. Reload to get the latest, then reapply your change."); e.code = "CONFLICT"; throw e;
        }
        const e = new Error("Couldn't save — the change didn't reach the server. Reload the page and try again."); e.code = "NOT_SAVED"; throw e;
      }
      return Array.isArray(data) ? data[0] : data;
    },
    // 0042: "Delete" moves the quote to the Deleted shelf (Restore brings it back); the
    // server refuses a hard delete of a quote that is not on that shelf
    async remove(quoteId) { await rpc("move_quote_to_shelf", { p_quote_id: quoteId, p_shelf: "delete" }); return true; },
  };
  // localStorage fallback tier
  const LSQ = "bps.quotes";
  const lsq = {
    read() { try { return JSON.parse(localStorage.getItem(LSQ) || "[]"); } catch { return []; } },
    write(v) { try { localStorage.setItem(LSQ, JSON.stringify(v)); } catch {} },
    async list() { return this.read().map((q) => ({ id: q.id, code: q.code, title: q.title, eventType: q.eventType, status: q.status,
      lifecycleStage: q.lifecycleStage || "quote",
      currentVersion: q.currentVersion, client: q.client || {}, pricing: q.pricing || {}, total: (q.pricing && q.pricing.total) || 0,
      eventDate: q.eventDate || null, eventTime: q.eventTime || null,
      updatedAt: q.updatedAt, createdAt: q.createdAt, confirmedAt: q.confirmedAt,
      archivedAt: q.archivedAt || null, deletedAt: q.deletedAt || null })); },
    // local mirror of sbq.page / counts / codesFor / eventTypes (same filters, same order)
    async page(o) {
      o = o || {}; const today = localISODate(), et = String(o.eventType || "").toLowerCase();
      const rank = (x) => (x.status === "cancelled" ? 0 : x.status === "confirmed" ? 1 : 2);
      const arch = o.view === "archived";
      const rows = (await this.list()).filter((x) => quoteInView(x, o.view, today) && (!et || String(x.eventType || "").toLowerCase() === et) &&
        textHit(o.search, [x.code, x.title, x.client && x.client.name]))
        .sort((a, b) => (o.sort === "confirmedFirst" ? (arch ? rank(b) - rank(a) : rank(a) - rank(b)) : 0) ||
          String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || String(b.id).localeCompare(String(a.id)));
      return arrPage(rows, o);
    },
    async counts() { const a = this.read().filter((q) => !q.deletedAt && !q.archivedAt); const n = (s) => a.filter((q) => q.status === s).length;
      const confirmed = n("confirmed"), cancelled = n("cancelled"); return { total: a.length, confirmed, cancelled, quote: Math.max(0, a.length - confirmed - cancelled) }; },
    async codesFor(stamp) { return this.read().filter((q) => String(q.code || "").indexOf(stamp + "-") === 0).map((q) => ({ code: q.code })); },
    async eventTypes() { return [...new Set(this.read().map((q) => q.eventType).filter(Boolean))]; },
    async get(id) { const q = this.read().find((x) => x.id === id); if (!q) throw new Error("not found");
      return { ...q, lifecycleStage: q.lifecycleStage || "quote", versions: (q.versions || []).map((v) => ({ id: v.id, versionNo: v.versionNo, label: v.label, objectCount: v.objectCount, createdAt: v.createdAt })).sort((a, b) => b.versionNo - a.versionNo) }; },
    async setStage(id, stage) { const a = this.read(); const q = a.find((x) => x.id === id); if (q) { q.lifecycleStage = stage; q.updatedAt = now(); this.write(a); } return { stage }; },
    async getVersion(id, no) { const q = this.read().find((x) => x.id === id); const v = q && (q.versions || []).find((v) => v.versionNo === no);
      if (!v) throw new Error("no version"); return { versionNo: no, data: v.data }; },
    async versions(id) { const q = this.read().find((x) => x.id === id); if (!q) throw new Error("not found");
      return (q.versions || []).map((v) => ({ id: v.id, versionNo: v.versionNo, label: v.label, objectCount: v.objectCount, createdAt: v.createdAt, createdBy: v.createdBy || null }))
        .sort((a, b) => b.versionNo - a.versionNo); },
    async create(code, title, eventType, data, objectCount) { const q = { id: uid(), code, title: title || "Untitled event", eventType,
      status: "quote", client: {}, pricing: {}, currentVersion: 1, createdAt: now(), updatedAt: now(), confirmedAt: null,
      versions: [{ id: uid(), versionNo: 1, label: null, data: data || { items: [] }, objectCount: objectCount || 0, createdAt: now() }] };
      const a = this.read(); a.push(q); this.write(a); return q; },
    async addVersion(id, label, data, objectCount) { const a = this.read(); const q = a.find((x) => x.id === id);
      const no = Math.max(0, ...q.versions.map((v) => v.versionNo)) + 1;
      const v = { id: uid(), versionNo: no, label, data: data || { items: [] }, objectCount: objectCount || 0, createdAt: now() };
      q.versions.push(v); q.currentVersion = no; q.updatedAt = now(); this.write(a); return v; },
    async confirm(id, client, pricing) { const a = this.read(); const q = a.find((x) => x.id === id);
      q.status = "confirmed"; if (client) q.client = client; if (pricing) q.pricing = pricing; q.confirmedAt = now(); q.updatedAt = now(); this.write(a); return q; },
    async updateMeta(id, patch) { const a = this.read(); const q = a.find((x) => x.id === id);
      if (patch.title != null) q.title = patch.title; if (patch.eventType != null) q.eventType = patch.eventType;
      if (patch.client) q.client = patch.client; if (patch.pricing) q.pricing = patch.pricing; if (patch.status) q.status = patch.status;
      if (patch.eventDate !== undefined) q.eventDate = patch.eventDate || null;
      if (patch.eventTime !== undefined) q.eventTime = patch.eventTime || null;
      q.updatedAt = now(); this.write(a); return q; },
    async remove(id) { this.write(this.read().filter((x) => x.id !== id)); return true; },
  };
  const qt = () => (mode === "supabase" ? sbq : lsq);
  const quotes = {
    list: () => qt().list(),
    // paged list view + counters (perf): see sbq.page / sbq.counts
    PAGE_SIZE,
    VIEWS: QUOTE_VIEWS.slice(),
    isArchived: quoteIsArchived,
    page: (o) => qt().page(o),
    counts: () => qt().counts(),
    eventTypes: () => qt().eventTypes(),
    // the next MMDDYYYY-NN guess for a date, from just that day's codes (not every quote)
    async nextCodeFor(date) {
      const d = date || new Date();
      const stamp = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + d.getFullYear();
      return quotes.nextCode(await qt().codesFor(stamp), d);
    },
    // a few quotes by id, light columns (lookups for a page of something else)
    async byIds(ids) {
      const a = [...new Set((ids || []).filter((x) => typeof x === "string" && x))]; if (!a.length) return [];
      if (mode !== "supabase") { const set = new Set(a); return (await lsq.list()).filter((q) => set.has(q.id)); }
      let r = await supa.from("quotes").select(QUOTE_LIST_COLS).in("id", a);
      if (r.error && isMissingColumn(r.error)) r = await supa.from("quotes").select("*").in("id", a);
      if (r.error) throw r.error; return (r.data || []).map(mapQuoteSummary);
    },
    get: (id) => qt().get(id),
    getVersion: (id, no) => qt().getVersion(id, no),
    versions: (id) => qt().versions(id),
    create: (code, title, eventType, data, objectCount) => qt().create(code, title, eventType, data, objectCount),
    addVersion: (id, label, data, objectCount) => qt().addVersion(id, label, data, objectCount),
    confirm: (id, client, pricing) => qt().confirm(id, client, pricing),
    setStage: (id, stage) => qt().setStage(id, stage),
    updateMeta: (id, patch, expectedUpdatedAt) => qt().updateMeta(id, patch, expectedUpdatedAt),
    remove: (id) => qt().remove(id),
    // next MMDDYYYY-NN given a list of quote summaries (uses .code)
    nextCode(list, date) {
      const d = date || new Date();
      const stamp = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + d.getFullYear();
      const re = new RegExp("^" + stamp + "-(\\d+)"); let max = 0;
      (list || []).forEach((s) => { const m = re.exec(s.code || ""); if (m) max = Math.max(max, parseInt(m[1], 10)); });
      return stamp + "-" + String(max + 1).padStart(2, "0");
    },
  };

  /* ---------------- client approval: OTP + consent + payment ---------------- */
  const rpc = async (fn, args) => {
    if (!supa) throw new Error("Supabase not configured");
    const { data, error } = await supa.rpc(fn, args);
    if (error) { if (looksLikeAuthError(error)) onAuthFailure(); throw error; }
    return data;
  };
  // true only when the RPC itself is not deployed yet (PostgREST PGRST202 / Postgres 42883),
  // so callers can fall back to an older path; every other error must still surface.
  const rpcMissing = (e) => { const c = (e && e.code) || ""; const m = String((e && e.message) || "");
    return c === "PGRST202" || c === "42883" || /could not find the function|function[^]*does not exist/i.test(m); };
  // Edge Function caller — used only when live channels are enabled in config.js
  const fnUrl = (name) => (CFG.url ? CFG.url.replace(/\/$/, "") + "/functions/v1/" + name : null);
  async function callFn(name, body) {
    // signed-in staff send their own access token (send-whatsapp requires it);
    // the public approval page has no session and falls back to the anon key
    let bearer = CFG.anonKey;
    try { const { data: { session } } = await supa.auth.getSession(); if (session && session.access_token) bearer = session.access_token; } catch (e) {}
    const res = await fetch(fnUrl(name), { method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + bearer, "apikey": CFG.anonKey },
      body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || ("HTTP " + res.status)); return j;
  }
  const LIVE = CFG.liveChannels || {};   // { sms:true, pay:true } flips to Edge Functions
  const approval = {
    // ---- public (token-scoped; works for anon on the approval page) ----
    getByToken: (token) => rpc("public_get_quote", { p_token: token }),
    // simulation → RPC (returns dev OTP); live → MSG91 via Edge Function (sends real SMS, no code returned)
    requestOtp: (token, phone) => LIVE.sms ? callFn("send-otp", { token, phone }) : rpc("request_otp", { p_token: token, p_phone: phone }),
    verifyConsent: (token, phone, code, agreed, termsVersion, consentText, clientName, ua) =>
      rpc("verify_and_consent", { p_token: token, p_phone: phone, p_code: code, p_agreed: agreed,
        p_terms_version: termsVersion, p_consent_text: consentText, p_client_name: clientName, p_user_agent: ua }),
    // simulation → RPC (mock link); live → Razorpay via Edge Function (real payment link)
    createPayment: (token) => LIVE.pay ? callFn("create-payment-link", { token }) : rpc("create_payment", { p_token: token }),
    // ---- manager (authenticated) ----
    generateToken: (quoteId) => rpc("generate_approval_token", { p_quote_id: quoteId }),
    markPaid: (quoteId, ref) => rpc("mark_paid", { p_quote_id: quoteId, p_provider_ref: ref || null }),
    async consents(quoteId) { if (!supa) return []; const { data, error } = await supa.from("quote_consents")
      .select("*").eq("quote_id", quoteId).order("created_at", { ascending: false }); if (error) throw error; return data; },
    async payments(quoteId) { if (!supa) return []; const { data, error } = await supa.from("quote_payments")
      .select("*").eq("quote_id", quoteId).order("created_at", { ascending: false }); if (error) throw error; return data; },
    async notifications(quoteId) { if (!supa) return []; const { data, error } = await supa.from("notifications")
      .select("*").eq("quote_id", quoteId).order("created_at", { ascending: false }); if (error) throw error; return data; },
  };

  /* ---------------- event operations: crew + tasks ---------------- */
  const ops = {
    // ---- manager (authenticated) ----
    async templates(category) { if (!supa) throw new Error("Supabase not configured");
      let q = supa.from("task_templates").select("category,title,seq").order("category").order("seq");
      if (category) q = q.eq("category", category);
      const { data, error } = await q; if (error) throw error; return data; },
    async categories() { const t = await this.templates(); return [...new Set(t.map((x) => x.category))]; },
    async listCrew() { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("crew_members").select("*").eq("active", true).order("name");
      if (error) throw error; return data; },
    async addCrew(name, phone, department) { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("crew_members").insert({ name, phone, department }).select().single();
      if (error) throw error; return data; },
    async deactivateCrew(id) { const { error } = await supa.from("crew_members").update({ active: false }).eq("id", id); if (error) throw error; return true; },
    async listTasks(quoteId) { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("event_tasks").select("*").eq("quote_id", quoteId).order("category").order("seq");
      if (error) throw error; return data; },
    async listTokens(quoteId) { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("work_tokens").select("token,phone,name").eq("quote_id", quoteId);
      if (error) throw error; return data; },
    assignTasks: (quoteId, category, titles, crewId, name, phone) => rpc("assign_tasks",
      { p_quote_id: quoteId, p_category: category, p_titles: titles, p_crew_id: crewId || null, p_name: name, p_phone: phone }),
    // Phase 40 — outsource a set of tasks to a vendor (sends them the checklist via the worker link)
    assignTasksVendor: (quoteId, category, titles, vendorId) => rpc("assign_tasks_vendor",
      { p_quote_id: quoteId, p_category: category, p_titles: titles, p_vendor_id: vendorId }),
    reassign: (taskId, crewId, name, phone) => rpc("reassign_task",
      { p_task_id: taskId, p_crew_id: crewId || null, p_name: name, p_phone: phone }),
    // ---- Phase 35: quality-engineer verification ----
    verify: (taskId, pass, note) => rpc("verify_task", { p_id: taskId, p_pass: !!pass, p_note: note || null }),
    verifySummary: (quoteId) => rpc("task_verify_summary", { p_quote: quoteId }).then(r => (Array.isArray(r) ? r[0] : r)),
    // ---- Phase 37: scheduling + dependencies ----
    setSchedule: (taskId, start, end, dependsOn) => rpc("set_task_schedule",
      { p_id: taskId, p_start: start || null, p_end: end || null, p_depends: dependsOn || null }),
    runTriggers: (quoteId) => rpc("run_task_triggers", quoteId ? { p_quote: quoteId } : {}),
    // ---- Phase 38: special-task recurring reminder ----
    setSpecial: (taskId, on, everyMin) => rpc("set_task_special", { p_id: taskId, p_on: !!on, p_every_min: everyMin || 5 }),
    runReminders: (quoteId) => rpc("run_task_reminders", quoteId ? { p_quote: quoteId } : {}),
    async setEventManager(quoteId, managerId) { const { error } = await supa.from("quotes").update({ manager_id: managerId }).eq("id", quoteId); if (error) throw error; return true; },
    // ---- 0038: crew evidence (reject reason / voice note, proof photos) — staff read ----
    // Rows are RLS-gated (Staff view, own studio). Before 0038 is applied the table is
    // missing: treat that as "no evidence" so the Operations page keeps working.
    async listEvidence(quoteId) { if (!supa) return [];
      const { data, error } = await supa.from("task_evidence")
        .select("id,task_id,kind,body,storage_path,mime,duration_s,worker_name,created_at")
        .eq("quote_id", quoteId).order("created_at", { ascending: true });
      if (error) { const c = error.code || ""; if (c === "PGRST205" || c === "42P01" || /task_evidence/.test(String(error.message || "")) && /does not exist|schema cache/i.test(String(error.message || ""))) return []; throw error; }
      return data || []; },
    // Signed, short-lived (300 s) URLs; only our own task-proof keys are ever signed.
    async evidenceUrls(paths, seconds) { if (!supa) return {};
      const ok = (paths || []).filter((p) => TASK_PROOF_KEY.test(String(p || ""))); if (!ok.length) return {};
      const { data, error } = await supa.storage.from("task-proof").createSignedUrls(ok, seconds || 300);
      if (error) throw error;
      const out = {}; (data || []).forEach((r, k) => { if (r && r.signedUrl && !r.error) out[ok[k]] = r.signedUrl; }); return out; },
    // ---- worker (no login; token-scoped) ----
    worker: {
      getTasks: (token) => rpc("worker_get_tasks", { p_token: token }),
      respond: (token, taskId, action) => rpc("worker_respond", { p_token: token, p_task_id: taskId, p_action: action }),
      // Phase 52 — crew equipment (kit out to them for this event) + check-in
      getEquipment: (token) => rpc("worker_get_equipment", { p_token: token }),
      checkinEquipment: (token, id, qtyIn) => rpc("worker_checkin_equipment", { p_token: token, p_id: id, p_qty_in: qtyIn }),
      // 0038 — upload one evidence file: the link asks the server for a one-time
      // 15-minute grant (checks link + task + status + type, 30/hour), then writes
      // the file to that exact key in the private 'task-proof' bucket. Type comes
      // from the file's bytes, never from its name. Returns the key.
      async uploadEvidence(token, taskId, kind, file) {
        if (!supa) throw new Error("Supabase not configured");
        if (!file) throw new Error("no file");
        if (file.size > TASK_PROOF_MAX) throw new Error("File too large (max 8 MB).");
        const sniff = await sniffChat(file);
        const allowed = kind === "proof_photo" ? /^image\/(jpeg|png|webp)$/ : /^audio\/(webm|ogg|mp4)$/;
        if (!sniff || !allowed.test(sniff.mime)) throw new Error(kind === "proof_photo" ? "Photos must be JPEG, PNG or WebP." : "That voice note format isn't supported.");
        const g = await rpc("worker_evidence_upload", { p_token: token, p_task_id: taskId, p_kind: kind, p_mime: sniff.mime });
        if (!g || !TASK_PROOF_KEY.test(String(g.path || ""))) throw new Error("upload not available");
        const { error } = await supa.storage.from("task-proof").upload(g.path, file, { upsert: false, contentType: g.mime });
        if (error) throw error;
        return g.path;
      },
      // reject / complete together with the evidence, in one server transaction
      respondEvidence: (token, taskId, action, ev) => { ev = ev || {};
        return rpc("worker_respond_evidence", { p_token: token, p_task_id: taskId, p_action: action,
          p_reason: ev.reason || null, p_voice_path: ev.voicePath || null, p_voice_seconds: ev.voiceSeconds == null ? null : Math.round(ev.voiceSeconds),
          p_photo_paths: (ev.photoPaths && ev.photoPaths.length) ? ev.photoPaths : null }); },
    },
  };
  const TASK_PROOF_MAX = 8 * 1024 * 1024;                   // matches the task-proof bucket cap (0038)
  const TASK_PROOF_KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|webm|ogg|m4a)$/;

  /* ---------------- control center: pricing config, vendors, coupons ---------------- */
  const PRICING_DEFAULTS = { chairPrice:200, platePrice:500, gstPct:18, serviceChargePct:0, currency:"INR", conflictBufferHours:3,
    // Capacity ceilings (editable in Control Center). They keep the layout builder from
    // being asked to render absurd counts (which froze the app), and drive the inline
    // "Maximum is N" hints. Additive config keys — old blobs fall back to these.
    maxGuests:20000, maxChairs:20000, maxPlates:20000, maxRoundTables:2000, maxBars:200,
    maxFoodTrucks:200, maxExpoBooths:1000, maxRestrooms:200, maxExits:200, maxHallFt:1000 };
  const config = {
    getPricing: () => mode === "supabase"
      ? rpc("get_pricing_config")
      : Promise.resolve(Object.assign({}, PRICING_DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem("bp_pricing_cfg") || "{}"); } catch (e) { return {}; } })())),
    setPricing: (p) => mode === "supabase"
      ? rpc("set_pricing_config", { p })
      : Promise.resolve((localStorage.setItem("bp_pricing_cfg", JSON.stringify(p || {})), p)),
  };

  /* ---------------- ONE shared pricing engine (Phase 66) ----------------
     Both the 2D builder's live panel and the quote total run through this,
     so the number is always the same everywhere. Inputs come from the layout
     (chairs + objects), the guest count, and the applied menu package's
     per-plate price. Object prices fall back to a category default, then to
     Control-Centre overrides (rates.assetPrices).                         */
  const OBJECT_CAT_PRICE = { structure:15000, seating:2500, av:9000, security:2000, logistics:4000, safety:1500, decor:12000 };
  const OBJECT_PRICE = {
    stage:45000, tent:35000, canopy:25000, mandap:75000, arch:9000, floralarch:15000,
    dancefloor:20000, redcarpet:8000, viprisers:18000, truss:6000,
    videowall:120000, ledscreen:60000, linearray:40000, subwoofer:12000, foh:20000,
    piano:30000, press:15000, dj:10000, photobooth:12000,
    bar:12000, buffet:9000, truck:25000, greenroom:8000, generator:15000, parking:10000,
    chandelier:12000, fountain:20000, restroom:12000, coatcheck:5000, firstaid:4000,
  };
  const SEAT_TYPES = { chiavari:1, barstool:1 };   // chairs with no explicit seat count
  const pricing = {
    OBJECT_CAT_PRICE, OBJECT_PRICE, SEAT_TYPES,
    isSeat(it){ const p=it.properties||{}; return !!((p.rows&&p.cols) || p.seats || (SEAT_TYPES[it.type]!=null)); },
    seatCount(it){ const p=it.properties||{}; if(p.rows&&p.cols) return p.rows*p.cols; if(p.seats) return p.seats; return SEAT_TYPES[it.type]||0; },
    unitPrice(it, assetPrices){ const t=it.type;
      if(assetPrices && assetPrices[t]!=null) return +assetPrices[t];
      if(OBJECT_PRICE[t]!=null) return OBJECT_PRICE[t];
      return OBJECT_CAT_PRICE[it.category] || 3000; },
    // chairs + itemised object lines from a layout items array
    fromItems(items, assetPrices){
      items = items||[]; let chairs=0; const groups={};
      items.forEach(it=>{ if(this.isSeat(it)){ chairs+=this.seatCount(it); return; }
        (groups[it.type]=groups[it.type]||{qty:0,cat:it.category}).qty++; });
      const lines=Object.keys(groups).map(t=>{ const g=groups[t], unit=this.unitPrice({type:t,category:g.cat},assetPrices);
        return { type:t, qty:g.qty, unit, cost:g.qty*unit }; }).filter(l=>l.unit>0).sort((a,b)=>b.cost-a.cost);
      return { chairs, objectLines:lines, objectsCost:lines.reduce((s,l)=>s+l.cost,0) };
    },
    // ── CANONICAL money core (Wave 6 MONEY-01, locked decisions) ────────────
    // ONE formula both quoteTotal() and breakdown() delegate to, so the stored
    // quote.pricing.total can never depend on which entry point wrote it.
    // Locked rules:
    //   D2 object-based cost feeds preSvc   D4 stacking: preSvc → service charge →
    //   fixed discount → percent discount → coupon → cap at subtotal
    //   D1 GST is charged on the POST-discount (taxable) value
    //   D5 a SINGLE GST rate (no separate catering rate)
    //   D7 round the FINAL total only (integer rupees); components kept in full
    //      precision here (callers may round for display).
    _canon(a){
      const preSvc = +a.preSvc||0, svcPct = +a.svcPct||0, gstPct = +a.gstPct||0;
      const serviceCharge = preSvc * svcPct/100;
      const subtotal = preSvc + serviceCharge;
      let discount = (+a.discountFixed||0) + subtotal*(+a.discountPct||0)/100;
      if(a.coupon && a.coupon.value){ discount += a.coupon.kind==="percent" ? subtotal*(+a.coupon.value)/100 : (+a.coupon.value); }
      discount = Math.min(Math.max(0,discount), subtotal);          // D4 cap
      const taxed = Math.max(0, subtotal - discount);               // D1 base = post-discount
      const gst = taxed * gstPct/100;                               // D5 single rate
      const total = Math.round(taxed + gst);                        // D7 round final only
      return { serviceCharge, subtotal, discount, taxed, gst, total };
    },
    // Quote-total (confirm-modal / write-back input shape). Now routes through
    // _canon so it agrees with breakdown() to the rupee for equivalent inputs.
    quoteTotal(p){
      const chairs=+p.chairs||0, chairPrice=+p.chairPrice||0, guests=+p.guests||0, platePrice=+p.platePrice||0;
      const mode=(p.catering&&p.catering.mode)||"inhouse", clientCater=mode==="client";
      const rental = chairs*chairPrice + (+p.other||0);
      const plateSub = clientCater?0:guests*platePrice;
      const cateringAmt = clientCater?0:(+((p.catering&&p.catering.amount))||0);
      const cateringBucket = plateSub + cateringAmt;
      const c = this._canon({ preSvc: rental+cateringBucket, svcPct:+p.serviceChargePct||0,
        discountFixed:+p.discount||0, discountPct:+p.discountPct||0, coupon:p.coupon, gstPct:+p.gstPct||0 });
      // Single-rate GST; CGST/SGST split kept for invoice display (intra-state
      // default; IGST only when place of supply is inter-state).
      const interstate = p.placeOfSupply==="inter";
      return { rental, plateSub, cateringAmt, cateringBucket,
        serviceCharge:c.serviceCharge, subtotal:c.subtotal,
        gstRental:c.gst, gstCatering:0, totalGst:c.gst,
        cgst: interstate?0:c.gst/2, sgst: interstate?0:c.gst/2, igst: interstate?c.gst:0,
        discount:c.discount, total:c.total };
    },
    // THE unified breakdown. rates = getPricing() result.
    breakdown(inp, rates){
      rates = rates||{};
      const items = inp.items||[];
      const oi = (inp.chairs!=null && inp.objectsCost!=null)
        ? { chairs:inp.chairs, objectLines:inp.objectLines||[], objectsCost:inp.objectsCost }
        : this.fromItems(items, rates.assetPrices);
      const chairs = inp.chairs!=null ? inp.chairs : oi.chairs;
      const guests = inp.guests!=null && inp.guests!=="" ? Number(inp.guests) : chairs;   // plates = guests, default from chairs
      const chairPrice = +rates.chairPrice||0;
      const platePrice = inp.menuPlatePrice!=null && inp.menuPlatePrice!=="" ? Number(inp.menuPlatePrice) : (+rates.platePrice||0);
      const chairsCost   = chairs*chairPrice;
      const cateringCost = inp.clientCater ? 0 : guests*platePrice + (+inp.cateringExtra||0);
      const objectsCost  = oi.objectsCost;
      const layoutBase   = +rates.layoutBase||0;
      const svcPct       = +(inp.serviceChargePct!=null?inp.serviceChargePct:rates.serviceChargePct)||0;
      const preSvc       = chairsCost + objectsCost + cateringCost + layoutBase;
      const gstPct       = +(rates.gstPct!=null?rates.gstPct:18);
      // D3: percent discount + coupon now honoured here too (were previously
      // dropped by the builder path). D1/D5/D7 via the shared core.
      const c = this._canon({ preSvc, svcPct, discountFixed:+inp.discount||0,
        discountPct:+inp.discountPct||0, coupon:inp.coupon, gstPct });
      return { chairs, guests, chairPrice, platePrice, chairsCost, cateringCost,
        objectLines:oi.objectLines, objectsCost, layoutBase,
        serviceCharge:Math.round(c.serviceCharge), svcPct,
        subtotal:c.subtotal, discount:c.discount, gstPct, gst:Math.round(c.gst), total:c.total };
    },
  };
  const vendors = {
    async list() { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("vendors").select("*").eq("active", true).order("name"); if (error) throw error; return data; },
    async add(name, category, phone) { const { data, error } = await supa.from("vendors").insert({ name, category, phone }).select().single(); if (error) throw error; return data; },
    async remove(id) { const { error } = await supa.from("vendors").update({ active: false }).eq("id", id); if (error) throw error; return true; },
    // Phase 9 — richer directory (kind / email / services)
    async listAll(includeInactive) { if (!supa) throw new Error("Supabase not configured");
      let q = supa.from("vendors").select("*").order("name"); if (!includeInactive) q = q.eq("active", true);
      const { data, error } = await q; if (error) throw error; return data; },
    // one page of the directory, by name (perf). o.includeInactive, o.kind, o.ids (only
    // these partners — "this event only"), o.search (name / category / email / phone, or
    // an exact service). Needs Supabase, like listAll().
    async page(o) { o = o || {}; if (!supa) throw new Error("Supabase not configured");
      let q = supa.from("vendors").select("*");
      if (!o.includeInactive) q = q.eq("active", true);
      if (o.kind) q = q.eq("kind", o.kind);
      if (o.ids) q = q.in("id", o.ids.length ? o.ids : ["00000000-0000-0000-0000-000000000000"]);
      const s = orIlike(["name", "category", "email", "phone"], o.search);
      if (s) q = q.or(s + ",services.cs." + pgQuote(JSON.stringify([String(o.search).trim()])));   // services is a jsonb array
      return sbPage(q.order("name").order("id"), o); },
    // does the studio have any partner at all (first-run empty state) — HEAD count
    async count(includeInactive) { if (!supa) throw new Error("Supabase not configured");
      let q = supa.from("vendors").select("id", { count: "exact", head: true }); if (!includeInactive) q = q.eq("active", true);
      return sbCount(q); },
    async addFull(v) { const { data, error } = await supa.from("vendors").insert(v).select().single(); if (error) throw error; return data; },
    async update(id, patch) { const { error } = await supa.from("vendors").update(patch).eq("id", id); if (error) throw error; return true; },
  };
  const coupons = {
    async list() { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("coupons").select("*").eq("active", true).order("code"); if (error) throw error; return data; },
    async add(code, kind, value, note) { const { data, error } = await supa.from("coupons").insert({ code, kind, value, note }).select().single(); if (error) throw error; return data; },
    async remove(id) { const { error } = await supa.from("coupons").update({ active: false }).eq("id", id); if (error) throw error; return true; },
  };
  // extend approval with a manager "send the link by SMS" (simulated unless sms_live)
  approval.sendLinkSms = (quoteId, phone, url) => rpc("mgr_notify",
    { p_quote_id: quoteId, p_channel: "sms", p_to: phone, p_kind: "approval_link", p_detail: { url } });

  /* ---------------- leads: pipeline / CRM front (Phase 2 + 2b) ---------------- */
  const LEAD_LS = "bp_leads";
  const ARCH_LS = "bp_lead_archive";
  const readLeadsLs = () => { try { return JSON.parse(localStorage.getItem(LEAD_LS) || "[]"); } catch { return []; } };
  const writeLeadsLs = (a) => localStorage.setItem(LEAD_LS, JSON.stringify(a));
  // offline mirror of the DB trigger: append an immutable snapshot to the CRM archive
  const pushArchiveLs = (action, row) => {
    try {
      const a = JSON.parse(localStorage.getItem(ARCH_LS) || "[]");
      a.unshift({ id: uid(), lead_id: row.id, action, name: row.name, phone: row.phone, email: row.email,
        source: row.source, event_type: row.event_type, event_date: row.event_date, budget: row.budget,
        guest_count: row.guest_count, notes: row.notes, status: row.status, quote_id: row.quote_id || null,
        snapshot: row, archived_at: now() });
      localStorage.setItem(ARCH_LS, JSON.stringify(a));
    } catch {}
  };
  const leads = {
    async list() {
      if (mode === "supabase") {
        const { data, error } = await supa.from("leads").select("*").order("updated_at", { ascending: false });
        if (error) throw error; return data;
      }
      return readLeadsLs();
    },
    async add(lead) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("leads").insert(lead).select().single();
        if (error) throw error; return data;   // DB trigger archives it
      }
      const a = readLeadsLs();
      const row = { id: uid(), status: "new", ...lead, quote_id: null, created_at: now(), updated_at: now() };
      a.unshift(row); writeLeadsLs(a); pushArchiveLs("created", row); return row;
    },
    async setStatus(id, status) {
      if (mode === "supabase") { const { error } = await supa.from("leads").update({ status }).eq("id", id); if (error) throw error; return true; }
      const a = readLeadsLs(); const r = a.find((x) => x.id === id);
      if (r) { r.status = status; r.updated_at = now(); writeLeadsLs(a); pushArchiveLs("updated", r); } return true;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("leads").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLeadsLs(); const r = a.find((x) => x.id === id);
      if (r) { Object.assign(r, patch, { updated_at: now() }); writeLeadsLs(a); pushArchiveLs("updated", r); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("leads").delete().eq("id", id); if (error) throw error; return true; }
      const a = readLeadsLs(); const r = a.find((x) => x.id === id);
      if (r) pushArchiveLs("deleted", r);   // archive keeps the record even after delete
      writeLeadsLs(a.filter((x) => x.id !== id)); return true;
    },
    // Convert to a quote (creates + links on first call, returns the linked quote thereafter).
    async convert(id) {
      if (mode === "supabase") return rpc("convert_lead_to_quote", { p_lead_id: id });
      const a = readLeadsLs(); const l = a.find((x) => x.id === id);
      if (!l) throw new Error("lead not found");
      if (l.quote_id) return { id: l.quote_id };
      const code = quotes.nextCode(await lsq.list());
      const q = await lsq.create(code, (l.name || "Untitled") + (l.event_type ? " — " + l.event_type : ""), l.event_type, { items: [] }, 0);
      // Carry the lead's contact details into the new quote's client — mirrors the
      // production convert_lead_to_quote RPC so local mode behaves the same (the quote
      // opens pre-filled instead of blank).
      try {
        const client = {};
        if (l.name) client.name = l.name;
        if (l.phone) client.phone = l.phone;
        if (l.email) client.email = l.email;
        const g = (l.guest_count != null ? l.guest_count : l.guests);
        if (g != null && g !== "") client.guests = g;
        if (l.budget != null && l.budget !== "") client.budget = l.budget;
        await lsq.updateMeta(q.id, { client, eventType: l.event_type || null, eventDate: l.event_date || null });
      } catch (e) {}
      l.status = "quoted"; l.quote_id = q.id; l.updated_at = now(); writeLeadsLs(a); pushArchiveLs("converted", l); return q;
    },
    // One page of the board (perf): o.status = one stage column, o.search = name / phone /
    // email / event type / source, o.count → also the column total (same request).
    // Newest-updated first, like list(). → { rows, hasMore, offset, total? }
    async page(o) {
      o = o || {};
      if (mode === "supabase") {
        let q = supa.from("leads").select("*", o.count ? { count: "exact" } : undefined);
        if (o.status) q = q.eq("status", o.status);
        const s = orIlike(["name", "phone", "email", "event_type", "source"], o.search); if (s) q = q.or(s);
        return sbPage(q.order("updated_at", { ascending: false }).order("id", { ascending: false }), o);
      }
      const rows = readLeadsLs().filter((l) => (!o.status || l.status === o.status) && textHit(o.search, [l.name, l.phone, l.email, l.event_type, l.source]))
        .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || String(b.id).localeCompare(String(a.id)));
      return arrPage(rows, o);
    },
    // Contact fields of every lead (duplicate check on "add lead") — four short columns, not the rows.
    async contacts() {
      if (mode === "supabase") { const { data, error } = await supa.from("leads").select("id,name,phone,email"); if (error) throw error; return data || []; }
      return readLeadsLs().map((l) => ({ id: l.id, name: l.name, phone: l.phone, email: l.email }));
    },
    // Read the immutable CRM archive (all snapshots, or just one lead's history).
    async archive(leadId) {
      if (mode === "supabase") {
        let q = supa.from("lead_archive").select("*").order("archived_at", { ascending: false });
        if (leadId) q = q.eq("lead_id", leadId);
        const { data, error } = await q; if (error) throw error; return data;
      }
      let a = []; try { a = JSON.parse(localStorage.getItem(ARCH_LS) || "[]"); } catch {}
      return leadId ? a.filter((x) => x.lead_id === leadId) : a;
    },
    // One page of the CRM archive, newest first, WITHOUT the full `snapshot` JSON (perf).
    //   o.stage / o.source (case-insensitive) / o.search (name, phone, type, source, action)
    //   o.latest → only rows that are their lead's NEWEST snapshot (one light lookup per
    //   page), so "latest per lead" filters exactly like before. A page may then hold
    //   fewer rows than the limit; hasMore / offset still describe the raw archive.
    async archivePage(o) {
      o = o || {};
      const COLS = "id,lead_id,action,name,phone,email,source,event_type,event_date,budget,guest_count,status,quote_id,archived_at";
      if (mode === "supabase") {
        let q = supa.from("lead_archive").select(COLS);
        if (o.stage) q = q.eq("status", o.stage);
        if (o.source) q = q.ilike("source", likeEscape(String(o.source).trim()));
        const s = orIlike(["name", "phone", "event_type", "source", "action"], o.search); if (s) q = q.or(s);
        const r = await sbPage(q.order("archived_at", { ascending: false }).order("id", { ascending: false }), o);
        if (o.latest) {
          const ids = [...new Set(r.rows.map((x) => x.lead_id).filter(Boolean))];
          if (ids.length) {
            const { data, error } = await supa.from("lead_archive").select("id,lead_id,archived_at").in("lead_id", ids)
              .order("archived_at", { ascending: false }).order("id", { ascending: false });
            if (error) throw error;
            const newest = {}; (data || []).forEach((x) => { if (!newest[x.lead_id]) newest[x.lead_id] = x.id; });
            r.rows = r.rows.filter((x) => !x.lead_id || newest[x.lead_id] === x.id);
          }
        }
        return r;
      }
      let a = []; try { a = JSON.parse(localStorage.getItem(ARCH_LS) || "[]"); } catch {}
      a = a.slice().sort((x, y) => String(y.archived_at || "").localeCompare(String(x.archived_at || "")) || String(y.id).localeCompare(String(x.id)));
      const newest = {}; a.forEach((x) => { if (x.lead_id && !newest[x.lead_id]) newest[x.lead_id] = x.id; });
      const src = String(o.source || "").trim().toLowerCase();
      const rows = a.filter((r) => (!o.stage || r.status === o.stage) && (!src || String(r.source || "").trim().toLowerCase() === src) &&
        textHit(o.search, [r.name, r.phone, r.event_type, r.source, r.action]));
      const pg = arrPage(rows, o);
      if (o.latest) pg.rows = pg.rows.filter((x) => !x.lead_id || newest[x.lead_id] === x.id);
      pg.rows = pg.rows.map((x) => { const c = Object.assign({}, x); delete c.snapshot; return c; });
      return pg;
    },
    // values for the CRM filter dropdowns (two short columns, capped)
    async archiveFacets() {
      let rows;
      if (mode === "supabase") { const { data, error } = await supa.from("lead_archive").select("source,status").limit(5000); if (error) throw error; rows = data || []; }
      else { try { rows = JSON.parse(localStorage.getItem(ARCH_LS) || "[]"); } catch { rows = []; } }
      return { sources: rows.map((r) => r.source), stages: rows.map((r) => r.status) };
    },
    // Realtime: call cb on any leads change. Returns a channel with .unsubscribe().
    subscribe(cb, onStatus) {
      if (mode !== "supabase" || !supa) { if (onStatus) onStatus("DISABLED"); return { unsubscribe() {} }; }
      try {
        return supa.channel("leads-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, (payload) => cb && cb(payload))
          .subscribe((status) => { if (onStatus) onStatus(status); });   // real status: SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED
      } catch { if (onStatus) onStatus("ERROR"); return { unsubscribe() {} }; }
    },
  };

  /* ---------------- CRM nurture / repeat business (Phase 27, spec step 94) ---------------- */
  const NURTURE_LS = "bp_nurture";
  const nurture = {
    async list() {
      if (mode === "supabase") {
        const { data, error } = await supa.from("nurture").select("*").order("next_followup", { nullsFirst: false });
        if (error) throw error; return data;
      }
      return readLs(NURTURE_LS);
    },
    // one page, soonest follow-up first (no date last) → { rows, hasMore, offset }
    async page(o) {
      o = o || {};
      if (mode === "supabase") return sbPage(supa.from("nurture").select("*").order("next_followup", { nullsFirst: false }).order("id"), o);
      const rows = readLs(NURTURE_LS).slice().sort((a, b) => (a.next_followup ? 0 : 1) - (b.next_followup ? 0 : 1) ||
        String(a.next_followup || "").localeCompare(String(b.next_followup || "")) || String(a.id).localeCompare(String(b.id)));
      return arrPage(rows, o);
    },
    // "N follow-ups due" without loading the list: active + next_followup on/before `today`
    async dueCount(today) {
      if (mode === "supabase") return sbCount(supa.from("nurture").select("id", { count: "exact", head: true }).eq("status", "active").lte("next_followup", today));
      return readLs(NURTURE_LS).filter((n) => n.status === "active" && n.next_followup && n.next_followup <= today).length;
    },
    async add(n) {
      if (mode === "supabase") { const { data, error } = await supa.from("nurture").insert(n).select().single(); if (error) throw error; return data; }
      const a = readLs(NURTURE_LS); const row = { id: uid(), status: "active", ...n, created_at: now() }; a.push(row); localStorage.setItem(NURTURE_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("nurture").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(NURTURE_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(NURTURE_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("nurture").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(NURTURE_LS, JSON.stringify(readLs(NURTURE_LS).filter((n) => n.id !== id))); return true;
    },
    // ---- Phase 30: recurring-occasion automation ----
    // Editable per-occasion templates (birthday / anniversary / festival / custom)
    templates: {
      async list() {
        if (mode === "supabase") { const { data, error } = await supa.from("nurture_templates").select("*").order("occasion_type"); if (error) throw error; return data; }
        return readLs("bp_nurture_templates");
      },
      async save(type, patch) {
        if (mode === "supabase") { const { error } = await supa.from("nurture_templates").update({ ...patch, updated_at: now() }).eq("occasion_type", type); if (error) throw error; return true; }
        const a = readLs("bp_nurture_templates"); const r = a.find((x) => x.occasion_type === type); if (r) Object.assign(r, patch); else a.push({ occasion_type: type, ...patch }); localStorage.setItem("bp_nurture_templates", JSON.stringify(a)); return true;
      },
    },
    // Global automation switch (singleton)
    automation: {
      async get() {
        if (mode === "supabase") { const { data, error } = await supa.from("nurture_automation").select("*").eq("id", 1).maybeSingle(); if (error) throw error; return data || { enabled: false, within_days: 0 }; }
        return readLs("bp_nurture_auto")[0] || { enabled: false, within_days: 0 };
      },
      async set(enabled, withinDays) {
        if (mode === "supabase") { const { error } = await supa.from("nurture_automation").update({ enabled: !!enabled, within_days: withinDays == null ? 0 : +withinDays, updated_at: now() }).eq("id", 1); if (error) throw error; return true; }
        localStorage.setItem("bp_nurture_auto", JSON.stringify([{ enabled: !!enabled, within_days: +withinDays || 0 }])); return true;
      },
    },
    // Everyone with an occasion in the next `withinDays` days
    async due(withinDays) {
      if (mode === "supabase") { const { data, error } = await supa.rpc("nurture_due", { p_within_days: withinDays == null ? 30 : +withinDays }); if (error) throw error; return data || []; }
      return [];   // offline: not computed
    },
    // Render + queue one greeting (attaches gallery photos). Returns the message.
    async greet(id) {
      if (mode !== "supabase") throw new Error("Greetings need Supabase");
      const { data, error } = await supa.rpc("queue_nurture_greeting", { p_id: id }); if (error) throw error; return data;
    },
    // Queue greetings for every due, auto-on contact (the daily job). Returns count.
    async runAuto(withinDays) {
      if (mode !== "supabase") throw new Error("Automation needs Supabase");
      const { data, error } = await supa.rpc("run_nurture_auto", withinDays == null ? {} : { p_within_days: +withinDays }); if (error) throw error; return data || 0;
    },
    // turn a nurture contact into a fresh pipeline lead (reuses the leads pipeline)
    async convertToLead(id) {
      const all = await this.list(); const n = (all || []).find((x) => x.id === id);
      if (!n) throw new Error("contact not found");
      const lead = await leads.add({ name: n.name, phone: n.phone || null, email: n.email || null,
        source: "Repeat / referral", event_type: n.occasion || null, event_date: n.occasion_date || null,
        notes: n.note || null, status: "new" });
      await this.update(id, { status: "won" });
      return lead;
    },
  };

  /* ---------------- discovery & requirements (Phase 3) ---------------- */
  const DISC_LS = "bp_discovery", REQ_LS = "bp_requirements";
  const readLs = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
  const discovery = {
    async get(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_discovery").select("*").eq("quote_id", quoteId).maybeSingle();
        if (error) throw error; return data || null;
      }
      return readLs(DISC_LS).find((d) => d.quote_id === quoteId) || null;
    },
    async save(quoteId, d) {
      if (mode === "supabase") {
        return rpc("set_discovery", { p_quote_id: quoteId, p_meet_date: d.meet_date || null, p_mode: d.mode || null,
          p_location: d.location || null, p_attendees: d.attendees || null, p_notes: d.notes || null,
          p_budget_min: d.budget_min != null ? d.budget_min : null, p_budget_max: d.budget_max != null ? d.budget_max : null });
      }
      const a = readLs(DISC_LS).filter((x) => x.quote_id !== quoteId);
      const row = { quote_id: quoteId, ...d, updated_at: now() }; a.push(row);
      localStorage.setItem(DISC_LS, JSON.stringify(a)); return row;
    },
    async listReqs(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_requirements").select("*").eq("quote_id", quoteId).order("created_at");
        if (error) throw error; return data;
      }
      return readLs(REQ_LS).filter((r) => r.quote_id === quoteId);
    },
    async addReq(quoteId, req) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_requirements").insert({ quote_id: quoteId, ...req }).select().single();
        if (error) throw error; return data;
      }
      const a = readLs(REQ_LS); const row = { id: uid(), quote_id: quoteId, ...req, created_at: now() };
      a.push(row); localStorage.setItem(REQ_LS, JSON.stringify(a)); return row;
    },
    async removeReq(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_requirements").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(REQ_LS, JSON.stringify(readLs(REQ_LS).filter((r) => r.id !== id))); return true;
    },
  };

  /* ---------------- proposal & mood-board (Phase 4) ---------------- */
  const PROP_LS = "bp_proposal", RISK_LS = "bp_risks";
  const proposal = {
    async get(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_proposal").select("*").eq("quote_id", quoteId).maybeSingle();
        if (error) throw error; return data || null;
      }
      return readLs(PROP_LS).find((p) => p.quote_id === quoteId) || null;
    },
    async save(quoteId, p) {
      // Preserve any field the caller OMITS by merging with what's already saved. Without
      // this, saving the proposal from the workspace (flow.html sends only concept/theme/
      // scope) would wipe the colour palette and reference images the planner set on the
      // Proposal screen — set_proposal and the local upsert both overwrite the whole row.
      let cur = {};
      try { cur = (await this.get(quoteId)) || {}; } catch (e) { cur = {}; }
      const pick = (k, dflt) => (p[k] !== undefined ? p[k] : (cur[k] !== undefined && cur[k] !== null ? cur[k] : dflt));
      const merged = { concept: pick("concept", null), theme: pick("theme", null),
        scope: pick("scope", []), palette: pick("palette", []), images: pick("images", []) };
      if (mode === "supabase") {
        return rpc("set_proposal", { p_quote_id: quoteId, p_concept: merged.concept || null, p_theme: merged.theme || null,
          p_palette: merged.palette || [], p_images: merged.images || [], p_scope: merged.scope || [] });
      }
      const a = readLs(PROP_LS).filter((x) => x.quote_id !== quoteId);
      const curLs = readLs(PROP_LS).find((x) => x.quote_id === quoteId) || {};
      const row = { quote_id: quoteId, share_token: curLs.share_token || null, published: curLs.published || false, ...merged, updated_at: now() };
      a.push(row); localStorage.setItem(PROP_LS, JSON.stringify(a)); return row;
    },
    async publish(quoteId, published) {
      if (mode === "supabase") return rpc("publish_proposal", { p_quote_id: quoteId, p_published: !!published });
      const a = readLs(PROP_LS); let row = a.find((x) => x.quote_id === quoteId);
      if (!row) { row = { quote_id: quoteId, palette: [], images: [], scope: [] }; a.push(row); }
      if (!row.share_token && published) row.share_token = uid();
      row.published = !!published; localStorage.setItem(PROP_LS, JSON.stringify(a));
      return row.share_token || null;
    },
    // public (anon) — client view by token
    getByToken: (token) => (mode === "supabase" ? rpc("public_get_proposal", { p_token: token })
      : Promise.resolve((readLs(PROP_LS).find((p) => p.share_token === token && p.published)) || null)),
    async listRisks(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("proposal_risks").select("*").eq("quote_id", quoteId).order("created_at");
        if (error) throw error; return data;
      }
      return readLs(RISK_LS).filter((r) => r.quote_id === quoteId);
    },
    async addRisk(quoteId, risk) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("proposal_risks").insert({ quote_id: quoteId, ...risk }).select().single();
        if (error) throw error; return data;
      }
      const a = readLs(RISK_LS); const row = { id: uid(), quote_id: quoteId, status: "open", ...risk, created_at: now() };
      a.push(row); localStorage.setItem(RISK_LS, JSON.stringify(a)); return row;
    },
    async setRiskStatus(id, status) {
      if (mode === "supabase") { const { error } = await supa.from("proposal_risks").update({ status }).eq("id", id); if (error) throw error; return true; }
      const a = readLs(RISK_LS); const r = a.find((x) => x.id === id); if (r) { r.status = status; localStorage.setItem(RISK_LS, JSON.stringify(a)); } return true;
    },
    async removeRisk(id) {
      if (mode === "supabase") { const { error } = await supa.from("proposal_risks").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(RISK_LS, JSON.stringify(readLs(RISK_LS).filter((r) => r.id !== id))); return true;
    },
  };

  /* ---------------- quotation versions Q1/Q2/Q3 (Phase 77) ---------------- */
  const quotationVersions = {
    async list(quoteId) {
      if (mode !== "supabase") return [];
      const { data, error } = await supa.from("quotation_versions").select("*").eq("quote_id", quoteId).order("created_at", { ascending: false });
      if (error) throw error; return data;
    },
    // snapshot as the next Q-number; also updates the quote's current pricing
    save: (quoteId, pricing) => rpc("save_quotation_version", { p_quote: quoteId, p_pricing: pricing || {} }),
  };

  /* ---------------- admin-configurable layout rules (Phase 75) ---------------- */
  const layoutRules = {
    async list() {
      if (mode !== "supabase") return readLs("bp_layout_rules");
      const { data, error } = await supa.from("layout_rules").select("*").eq("active", true).order("seq");
      if (error) throw error; return data;
    },
    async get(eventType) {
      const all = await this.list().catch(() => []);
      const r = all.find((x) => (x.event_type || "").toLowerCase() === String(eventType || "").toLowerCase());
      return r ? r.rules : null;
    },
    async update(id, patch) {
      if (mode !== "supabase") { const a = readLs("bp_layout_rules"); const r = a.find((x) => x.id === id); if (r) Object.assign(r, patch); localStorage.setItem("bp_layout_rules", JSON.stringify(a)); return true; }
      const { error } = await supa.from("layout_rules").update(patch).eq("id", id); if (error) throw error; return true;
    },
  };

  /* ---------------- combined people picker (staff + vendors) ---------------- */
  // One source for every "who is responsible" dropdown across the app, so a
  // person shows up the same way whether they're in-house Staff or a Vendor.
  const people = {
    async options() {
      const [s, v] = await Promise.all([
        staff.list(false).catch(() => []),
        vendors.listAll(false).catch(() => []),
      ]);
      return [
        ...s.map((p) => ({ id: p.id, name: p.name, kind: "staff", role: p.role || p.department || "" })),
        ...v.map((p) => ({ id: p.id, name: p.name, kind: "vendor", role: p.category || "" })),
      ].filter((p) => p.name);
    },
  };

  /* ---------------- in-house staff directory (Phase 6) ---------------- */
  const STAFF_LS = "bp_staff";
  const staff = {
    async list(includeInactive) {
      if (mode === "supabase") {
        let q = supa.from("crew_members").select("*").order("name");
        if (!includeInactive) q = q.eq("active", true);
        const { data, error } = await q; if (error) throw error; return data;
      }
      const a = readLs(STAFF_LS); return includeInactive ? a : a.filter((s) => s.active !== false);
    },
    // one page of the directory, by name (perf). o.includeInactive, o.dept, o.skill,
    // o.ids (only these people — "this event only"), o.search (name / role / department /
    // email / phone, or an exact skill), o.count → also the filtered total.
    async page(o) {
      o = o || {};
      if (mode === "supabase") {
        let q = supa.from("crew_members").select("*", o.count ? { count: "exact" } : undefined);
        if (!o.includeInactive) q = q.eq("active", true);
        if (o.dept) q = q.eq("department", o.dept);
        if (o.skill) q = q.filter("skills", "cs", JSON.stringify([o.skill]));   // skills is a jsonb array
        if (o.ids) q = q.in("id", o.ids.length ? o.ids : ["00000000-0000-0000-0000-000000000000"]);
        let s = orIlike(["name", "role", "department", "email", "phone"], o.search);
        if (s) { s += ",skills.cs." + pgQuote(JSON.stringify([String(o.search).trim()])); q = q.or(s); }   // + an exact skill
        return sbPage(q.order("name").order("id"), o);
      }
      const ids = o.ids ? new Set(o.ids) : null;
      const rows = readLs(STAFF_LS).filter((p) => (o.includeInactive || p.active !== false) && (!o.dept || p.department === o.dept) &&
        (!o.skill || (Array.isArray(p.skills) && p.skills.includes(o.skill))) && (!ids || ids.has(p.id)) &&
        textHit(o.search, [p.name, p.role, p.department, (p.skills || []).join(" "), p.email, p.phone]))
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")) || String(a.id).localeCompare(String(b.id)));
      return arrPage(rows, o);
    },
    // departments + skills for the filters (two short columns) and the headcount
    async facets(includeInactive) {
      let rows;
      if (mode === "supabase") { let q = supa.from("crew_members").select("department,skills"); if (!includeInactive) q = q.eq("active", true);
        const { data, error } = await q.limit(5000); if (error) throw error; rows = data || []; }
      else rows = readLs(STAFF_LS).filter((p) => includeInactive || p.active !== false);
      return { total: rows.length, depts: [...new Set(rows.map((r) => r.department).filter(Boolean))].sort(),
        skills: [...new Set(rows.flatMap((r) => (Array.isArray(r.skills) ? r.skills : [])))].sort() };
    },
    async add(s) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("crew_members").insert(s).select().single();
        if (error) throw error; return data;
      }
      const a = readLs(STAFF_LS); const row = { id: uid(), active: true, skills: [], ...s, created_at: now() };
      a.push(row); localStorage.setItem(STAFF_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("crew_members").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(STAFF_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(STAFF_LS, JSON.stringify(a)); } return true;
    },
    async setActive(id, active) { return this.update(id, { active: !!active }); },
    // 0041: a row with profile_id is LINKED to a Helm account — its name / phone / e-mail /
    // department / title follow the member's profile (edited in Control Center → User control).
    isLinked: (s) => !!(s && s.profile_id),
    normPhone: memberNormPhone,
    // The linked staff record that already has this number (another row would be a second
    // record for one account) → { id, name } or null. Before 0041 / on error → null (the DB
    // guard still refuses it; its message is shown through linkErrorText).
    async linkedOwnerOfPhone(phone, exceptId) {
      const want = memberNormPhone(phone); if (!want || mode !== "supabase" || !supa) return null;
      try {
        const { data, error } = await supa.from("crew_members").select("id,name,phone,profile_id").not("profile_id", "is", null).limit(2000);
        if (error) return null;
        const hit = (data || []).find((r) => r && r.id !== exceptId && r.profile_id && memberNormPhone(r.phone) === want);
        return hit ? { id: hit.id, name: hit.name || "a team member" } : null;
      } catch (e) { return null; }
    },
    linkErrorText: memberErrorText,
    // the fields a linked row must NOT send (the DB refuses changes to them from the Staff page)
    LINKED_FIELDS: ["name", "phone", "email", "department", "role"],
    // crew actually assigned to ONE event (derived from their tasks) — for event-scoped views
    async forEvent(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_tasks")
          .select("crew_id,assignee_name,assignee_phone,status").eq("quote_id", quoteId).not("crew_id", "is", null);
        if (error) throw error;
        const by = {};
        (data || []).forEach((t) => { const k = t.crew_id;
          by[k] = by[k] || { crew_id: k, name: t.assignee_name, phone: t.assignee_phone, tasks: 0, done: 0 };
          by[k].tasks++; if (t.status === "completed") by[k].done++; });
        return Object.values(by);
      }
      return [];
    },
    // distinct departments/skills across the team (for filters)
    async facets() {
      const list = await this.list(true);
      const depts = [...new Set(list.map((s) => s.department).filter(Boolean))].sort();
      const skills = [...new Set(list.flatMap((s) => Array.isArray(s.skills) ? s.skills : []))].sort();
      return { depts, skills };
    },
    // Phase 50 — suggest in-house crew for a category, ranked by skill match + availability.
    // Marks anyone already booked on the event's date as busy (one batched query).
    async suggest({ category, date, excludeQuote, limit } = {}) {
      const crew = await this.list(false);
      const cat = (category || "").toLowerCase();
      // who is busy on this date? (assigned to another event on the same day)
      let busy = new Set();
      if (date && mode === "supabase" && supa) {
        try {
          const { data: evs } = await supa.from("quotes").select("id").eq("event_date", date);
          const ids = (evs || []).map((e) => e.id).filter((i) => i !== excludeQuote);
          if (ids.length) {
            const { data: ts } = await supa.from("event_tasks").select("crew_id").in("quote_id", ids).not("crew_id", "is", null);
            (ts || []).forEach((t) => busy.add(t.crew_id));
          }
        } catch {}
      }
      const scored = crew.map((c) => {
        const dept = (c.department || "").toLowerCase();
        const skills = (Array.isArray(c.skills) ? c.skills : []).map((s) => String(s).toLowerCase());
        const deptMatch = cat && dept && (dept === cat || cat.includes(dept) || dept.includes(cat));
        const skillMatch = cat && skills.some((s) => s && (cat.includes(s) || s.includes(cat)));
        const available = !busy.has(c.id);
        const score = (available ? 100 : 0) + (deptMatch ? 20 : 0) + (skillMatch ? 15 : 0);
        return { id: c.id, name: c.name, phone: c.phone, department: c.department, skills: c.skills || [],
          available, match: !!(deptMatch || skillMatch), score };
      }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      return scored.slice(0, limit || 5);
    },
  };

  /* ---------------- in-house inventory (Phase 7) ---------------- */
  const INV_LS = "bp_inventory", RES_LS = "bp_inv_res";
  const ACTIVE_RES = ["reserved", "allocated"];
  const inventory = {
    async items(includeInactive) {
      if (mode === "supabase") {
        let q = supa.from("inventory_items").select("*").order("name");
        if (!includeInactive) q = q.eq("active", true);
        const { data, error } = await q; if (error) throw error; return data;
      }
      const a = readLs(INV_LS); return includeInactive ? a : a.filter((i) => i.active !== false);
    },
    // clamp inventory numerics at the data layer: quantities and costs can never
    // be negative regardless of what the UI sends (Wave 16 defense-in-depth;
    // backs the global input hardener and the DB CHECK constraints).
    _sanitize(o) {
      const s = { ...o };
      if ("total_qty" in s) s.total_qty = Math.max(0, Math.trunc(Number(s.total_qty) || 0));
      if ("unit_cost" in s) s.unit_cost = Math.max(0, Number(s.unit_cost) || 0);
      if ("reorder_at" in s && s.reorder_at != null) s.reorder_at = Math.max(0, Math.trunc(Number(s.reorder_at) || 0));
      return s;
    },
    async addItem(it) {
      it = this._sanitize(it);
      if (mode === "supabase") { const { data, error } = await supa.from("inventory_items").insert(it).select().single(); if (error) throw error; return data; }
      const a = readLs(INV_LS); const row = { id: uid(), active: true, total_qty: 0, ...it, created_at: now() }; a.push(row); localStorage.setItem(INV_LS, JSON.stringify(a)); return row;
    },
    // Bulk insert (one round-trip) — used by "Load starter items" so seeding ~20 rows
    // is instant instead of 20 sequential requests. Returns the inserted rows.
    async addItems(list) {
      const rows = (list || []).map((it) => this._sanitize(it));
      if (!rows.length) return [];
      if (mode === "supabase") { const { data, error } = await supa.from("inventory_items").insert(rows).select(); if (error) throw error; return data; }
      const a = readLs(INV_LS); const made = rows.map((it) => ({ id: uid(), active: true, total_qty: 0, ...it, created_at: now() })); a.push(...made); localStorage.setItem(INV_LS, JSON.stringify(a)); return made;
    },
    async updateItem(id, patch) {
      patch = this._sanitize(patch);
      if (mode === "supabase") { const { error } = await supa.from("inventory_items").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(INV_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(INV_LS, JSON.stringify(a)); } return true;
    },
    // all active reservations (for availability math), or one event's reservations
    async reservations(quoteId) {
      if (mode === "supabase") {
        let q = supa.from("inventory_reservations").select("*").order("created_at");
        if (quoteId) q = q.eq("quote_id", quoteId);
        const { data, error } = await q; if (error) throw error; return data;
      }
      const a = readLs(RES_LS); return quoteId ? a.filter((r) => r.quote_id === quoteId) : a;
    },
    async reserve(itemId, quoteId, qty, note) {
      if (mode === "supabase") { const { data, error } = await supa.from("inventory_reservations").insert({ item_id: itemId, quote_id: quoteId, qty, note: note || null }).select().single(); if (error) throw error; return data; }
      const a = readLs(RES_LS); const row = { id: uid(), item_id: itemId, quote_id: quoteId, qty, status: "reserved", note: note || null, created_at: now() }; a.push(row); localStorage.setItem(RES_LS, JSON.stringify(a)); return row;
    },
    async setResStatus(id, status) {
      if (mode === "supabase") { const { error } = await supa.from("inventory_reservations").update({ status }).eq("id", id); if (error) throw error; return true; }
      const a = readLs(RES_LS); const r = a.find((x) => x.id === id); if (r) { r.status = status; localStorage.setItem(RES_LS, JSON.stringify(a)); } return true;
    },
    async removeRes(id) {
      if (mode === "supabase") { const { error } = await supa.from("inventory_reservations").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(RES_LS, JSON.stringify(readLs(RES_LS).filter((r) => r.id !== id))); return true;
    },
    // teardown "Return": mark returned + write off damaged stock in ONE transaction
    // (SEC-06 return_reservation). Falls back to the old two-call path until it's deployed.
    async returnReservation(resId, itemId, damaged) {
      const dmg = Number(damaged || 0);
      if (mode === "supabase") {
        try { return await rpc("return_reservation", { p_reservation_id: resId, p_damaged: dmg }); }
        catch (e) { if (!rpcMissing(e)) throw e; }
      }
      await this.setResStatus(resId, "returned");
      if (dmg > 0) await this.adjustTotal(itemId, -dmg);
      return true;
    },
    // permanently change what you own (e.g. reduce by damaged/lost at teardown)
    async adjustTotal(itemId, delta) {
      // atomic in Supabase (avoids a lost update when two teardown returns run at once)
      if (mode === "supabase") return rpc("adjust_inventory_total", { p_item_id: itemId, p_delta: Number(delta || 0) });
      const items = await this.items(true); const it = items.find((i) => i.id === itemId); if (!it) return false;
      return this.updateItem(itemId, { total_qty: Math.max(0, Number(it.total_qty || 0) + Number(delta || 0)) });
    },
    // committed & available per item id — DATE-AWARE.
    // An item used on two different dates isn't gone twice: it comes back between
    // events. So "committed" is the PEAK concurrent demand on any single event
    // date (the busiest day), plus any reservations on events that have no date
    // yet (those could land on any day, so we count them on top, conservatively).
    // "available" = what you own minus that peak, i.e. how many are safe to commit.
    async availability() {
      const [items, res, quotesList] = await Promise.all([
        this.items(false), this.reservations(), quotes.list().catch(() => []),
      ]);
      const dateByQuote = {}; (quotesList || []).forEach((q) => { dateByQuote[q.id] = q.eventDate || null; });
      const dayTotals = {};  // item_id -> { date -> qty on that date }
      const undated = {};    // item_id -> qty on dateless events
      (res || []).forEach((r) => {
        if (!ACTIVE_RES.includes(r.status)) return;
        const q = Number(r.qty || 0); const d = dateByQuote[r.quote_id];
        if (d) { (dayTotals[r.item_id] = dayTotals[r.item_id] || {}); dayTotals[r.item_id][d] = (dayTotals[r.item_id][d] || 0) + q; }
        else { undated[r.item_id] = (undated[r.item_id] || 0) + q; }
      });
      const peakOf = (m) => { let mx = 0; for (const k in m) if (m[k] > mx) mx = m[k]; return mx; };
      const map = {};
      items.forEach((i) => {
        const c = peakOf(dayTotals[i.id] || {}) + (undated[i.id] || 0);
        map[i.id] = { ...i, committed: c, available: Number(i.total_qty || 0) - c };
      });
      return map;
    },
    // ---- Phase 33: check-out / check-in accountability ----
    checkouts: {
      // all checkouts, or just one event's; newest first
      async list(quoteId) {
        if (mode !== "supabase") return readLs("bp_checkouts").filter((c) => !quoteId || c.quote_id === quoteId);
        let q = supa.from("inventory_checkouts").select("*").order("checked_out_at", { ascending: false });
        if (quoteId) q = q.eq("quote_id", quoteId);
        const { data, error } = await q; if (error) throw error; return data;
      },
      // issue equipment out
      async out(itemId, quoteId, qty, issuedTo, crewId, note) {
        if (mode !== "supabase") throw new Error("Check-out needs Supabase");
        const { data, error } = await supa.rpc("checkout_equipment",
          { p_item: itemId, p_quote: quoteId || null, p_qty: Number(qty), p_issued_to: issuedTo, p_issued_to_id: crewId || null, p_note: note || null });
        if (error) throw error; return data;
      },
      // bring it back: returned count + who signed off; writeoff reduces stock by the missing amount
      async in(id, qtyIn, returnedBy, writeoff) {
        if (mode !== "supabase") throw new Error("Check-in needs Supabase");
        const { data, error } = await supa.rpc("checkin_equipment",
          { p_id: id, p_qty_in: Number(qtyIn), p_returned_by: returnedBy || null, p_writeoff: !!writeoff });
        if (error) throw error; return data;
      },
      async remove(id) {
        if (mode !== "supabase") { localStorage.setItem("bp_checkouts", JSON.stringify(readLs("bp_checkouts").filter((c) => c.id !== id))); return true; }
        const { error } = await supa.from("inventory_checkouts").delete().eq("id", id); if (error) throw error; return true;
      },
    },
  };

  /* ---------------- chair types (Control Center catalog, Phase 33) ---------------- */
  const chairTypes = {
    async list(includeInactive) {
      if (mode !== "supabase") return readLs("bp_chair_types");
      let q = supa.from("chair_types").select("*").order("name");
      if (!includeInactive) q = q.eq("active", true);
      const { data, error } = await q; if (error) throw error; return data;
    },
    async add(name, price) {
      if (mode !== "supabase") { const a = readLs("bp_chair_types"); const r = { id: uid(), name, price: Number(price || 0), active: true }; a.push(r); localStorage.setItem("bp_chair_types", JSON.stringify(a)); return r; }
      const { data, error } = await supa.from("chair_types").insert({ name, price: Number(price || 0) }).select().single(); if (error) throw error; return data;
    },
    async update(id, patch) {
      if (mode !== "supabase") { const a = readLs("bp_chair_types"); const r = a.find((x) => x.id === id); if (r) Object.assign(r, patch); localStorage.setItem("bp_chair_types", JSON.stringify(a)); return true; }
      const { error } = await supa.from("chair_types").update(patch).eq("id", id); if (error) throw error; return true;
    },
    async remove(id) {
      if (mode !== "supabase") { localStorage.setItem("bp_chair_types", JSON.stringify(readLs("bp_chair_types").filter((c) => c.id !== id))); return true; }
      const { error } = await supa.from("chair_types").update({ active: false }).eq("id", id); if (error) throw error; return true;
    },
  };

  /* ---------------- plate types (catering categories, Phase 39) ---------------- */
  const plateTypes = {
    async list(includeInactive) {
      if (mode !== "supabase") return readLs("bp_plate_types");
      let q = supa.from("plate_types").select("*").order("price");
      if (!includeInactive) q = q.eq("active", true);
      const { data, error } = await q; if (error) throw error; return data;
    },
    async add(name, price) {
      if (mode !== "supabase") { const a = readLs("bp_plate_types"); const r = { id: uid(), name, price: Number(price || 0), active: true }; a.push(r); localStorage.setItem("bp_plate_types", JSON.stringify(a)); return r; }
      const { data, error } = await supa.from("plate_types").insert({ name, price: Number(price || 0) }).select().single(); if (error) throw error; return data;
    },
    async update(id, patch) {
      if (mode !== "supabase") { const a = readLs("bp_plate_types"); const r = a.find((x) => x.id === id); if (r) Object.assign(r, patch); localStorage.setItem("bp_plate_types", JSON.stringify(a)); return true; }
      const { error } = await supa.from("plate_types").update(patch).eq("id", id); if (error) throw error; return true;
    },
    async remove(id) {
      if (mode !== "supabase") { localStorage.setItem("bp_plate_types", JSON.stringify(readLs("bp_plate_types").filter((c) => c.id !== id))); return true; }
      const { error } = await supa.from("plate_types").update({ active: false }).eq("id", id); if (error) throw error; return true;
    },
  };

  /* ---------------- dish catalog + per-event menu (Phase 55) ---------------- */
  const dishCatalog = {
    async list(includeInactive) {
      if (mode !== "supabase") return readLs("bp_dish_catalog");
      let q = supa.from("dish_catalog").select("*").order("category").order("name");
      if (!includeInactive) q = q.eq("active", true);
      const { data, error } = await q; if (error) throw error; return data;
    },
    async add(category, name, kind) {
      if (mode !== "supabase") { const a = readLs("bp_dish_catalog"); const r = { id: uid(), category, name, kind: kind || "veg", active: true }; a.push(r); localStorage.setItem("bp_dish_catalog", JSON.stringify(a)); return r; }
      const { data, error } = await supa.from("dish_catalog").insert({ category, name, kind: kind || "veg" }).select().single(); if (error) throw error; return data;
    },
    async remove(id) {
      if (mode !== "supabase") { localStorage.setItem("bp_dish_catalog", JSON.stringify(readLs("bp_dish_catalog").filter((c) => c.id !== id))); return true; }
      const { error } = await supa.from("dish_catalog").update({ active: false }).eq("id", id); if (error) throw error; return true;
    },
  };
  const eventMenu = {
    async list(quoteId) {
      if (mode !== "supabase") return readLs("bp_event_menu").filter((x) => x.quote_id === quoteId);
      const { data, error } = await supa.from("event_menu_items").select("*").eq("quote_id", quoteId).order("seq"); if (error) throw error; return data;
    },
    add: (quoteId, dishId) => rpc("add_event_dish", { p_quote: quoteId, p_dish: dishId }),
    remove: (id) => rpc("remove_event_dish", { p_id: id }),
    setQty: (id, qty) => rpc("set_event_dish_qty", { p_id: id, p_qty: (qty === "" || qty == null) ? null : Number(qty) }),
  };

  /* ---------------- fixed menu packages / templates (Phase 62) ---------------- */
  const menuTemplates = {
    async list(includeInactive) {
      if (mode !== "supabase") return readLs("bp_menu_templates");
      let q = supa.from("menu_templates").select("*").order("seq");
      if (!includeInactive) q = q.eq("active", true);
      const { data, error } = await q; if (error) throw error; return data;
    },
    async update(id, patch) {
      if (mode !== "supabase") { const a = readLs("bp_menu_templates"); const r = a.find((x) => x.id === id); if (r) Object.assign(r, patch); localStorage.setItem("bp_menu_templates", JSON.stringify(a)); return true; }
      const { error } = await supa.from("menu_templates").update(patch).eq("id", id); if (error) throw error; return true;
    },
    // apply a package to an event's menu in one shot (replaces current dishes)
    async apply(quoteId, templateId) {
      if (mode !== "supabase") {
        const t = readLs("bp_menu_templates").find((x) => x.id === templateId); if (!t) throw new Error("no such package");
        const menu = readLs("bp_event_menu").filter((x) => x.quote_id !== quoteId);
        (t.dishes || []).forEach((d, i) => menu.push({ id: uid(), quote_id: quoteId, dish_name: d.n, category: d.c, kind: d.k || "veg", seq: i + 1 }));
        localStorage.setItem("bp_event_menu", JSON.stringify(menu)); return true;
      }
      return rpc("apply_menu_template", { p_quote: quoteId, p_template: templateId });
    },
  };

  /* ---------------- organization / studio (Phase 58) ---------------- */
  const org = {
    async id() { if (!supa) return null; try { return await orgIdStrict(); } catch (e) { return null; } },
    // Like id() but THROWS when the lookup fails, so callers can tell "no studio"
    // (null) from "couldn't check" (error) — onboarding must only follow a real null.
    resolveId: () => orgIdStrict(),
    async current() { if (!supa) return null;
      const { data, error } = await supa.from("organizations").select("*").eq("id", (await this.id())).maybeSingle();
      if (error) throw error; return data; },
    async save(patch) { if (!supa) throw new Error("Supabase not configured");
      const { error } = await supa.from("organizations").update(patch).eq("id", (await this.id())); if (error) throw error; return true; },
    createStudio: (name, opts) => rpc("create_studio", { p_name: name, p_email: (opts && opts.email) || null,
      p_currency: (opts && opts.currency) || "INR", p_timezone: (opts && opts.timezone) || "Asia/Kolkata" }),
    // GDPR / DPDP: admin downloads THIS org's data only (server re-scopes to current_org_id)
    exportData: () => rpc("export_org_data", {}),
    // Full portability package (organizations/profiles/quotes/event_attendees/invitations),
    // gated on has_area('users','view'); every table filtered by current_org_id server-side.
    exportPackage: () => rpc("export_tenant_organization_package", {}),
  };

  /* ---------------- branded client links: /<studio>/<kind>/<ref> (0020) ----------------
     The <ref> (token / published invitation slug) is the only secret; <studio> is a
     public label. Public pages call links.require() first: the server confirms that
     <studio> really owns that link (current or retired name), so nobody can dress
     their own token up in another studio's name. Legacy URLs keep working. */
  const LINK_KINDS = { invite: 1, quote: 1, proposal: 1, portal: 1, work: 1 };
  const LINK_PROD_HOSTS = ["helm-v01.vercel.app", "helm.events", "www.helm.events"];
  const LINK_RE = /^\/([a-z0-9-]{3,40})\/(invite|quote|proposal|portal|work)\/([^\/?#]+)\/?$/;
  let studioSlugCache = null, studioSlugPromise = null;
  const links = {
    // production links always use the public brand domain; staging/local keep their host
    base() { return LINK_PROD_HOSTS.indexOf(location.hostname) >= 0 ? "https://www.helm.events" : location.origin; },
    parse(kind) {
      const m = LINK_RE.exec(location.pathname); if (!m || (kind && m[2] !== kind)) return null;
      let ref; try { ref = decodeURIComponent(m[3]); } catch (e) { return null; }
      return { studio: m[1], kind: m[2], ref: ref };
    },
    async studio() {                                   // my studio's link name (null = not set up → legacy links)
      if (studioSlugCache) return studioSlugCache;
      if (!studioSlugPromise) studioSlugPromise = (async () => {
        try { const o = await org.current(); studioSlugCache = (o && o.public_slug) || null; } catch (e) { studioSlugCache = null; }
        studioSlugPromise = null; return studioSlugCache;
      })();
      return studioSlugPromise;
    },
    url(kind, ref, legacy) {                           // sync — call studio() once first
      return (studioSlugCache && ref && LINK_KINDS[kind])
        ? links.base() + "/" + studioSlugCache + "/" + kind + "/" + encodeURIComponent(ref) : legacy;
    },
    async build(kind, ref, legacy) { await links.studio(); return links.url(kind, ref, legacy); },
    // true = this studio owns the link; false = mismatch/unknown; throws on network errors
    async verify(L) {
      if (!L) return true;
      await init(); if (!supa) return false;
      const { data, error } = await supa.rpc("public_link_studio", { p_kind: L.kind, p_ref: L.ref, p_studio: L.studio });
      if (error) { if (global.BPUI && global.BPUI.isMissingFunction(error)) return false; throw error; }
      if (!data) return false;
      if (data !== L.studio) {                         // retired name → show the studio's current one
        try { history.replaceState(null, "", location.pathname.replace("/" + L.studio + "/", "/" + data + "/") + location.search + location.hash); } catch (e) {}
      }
      return true;
    },
    async require(L) {                                 // throw a "link not found" the pages already handle
      if (!(await links.verify(L))) { const e = new Error("invalid link"); e.code = "PGRST116"; throw e; }
    },
    rename: (slug) => rpc("set_studio_link_name", { p_slug: slug }).then((r) => { studioSlugCache = r || null; return r; }),
    // optional "links stop working N days after they're sent" (0039) — studio admin only, enforced server-side
    autoExpire: {
      get: () => rpc("admin_get_link_autoexpire", {}),
      set: (enabled, days) => rpc("admin_set_link_autoexpire", { p_enabled: !!enabled, p_days: days }),
      // what happens to a never-approved quote once its client link expired (0040):
      // "keep" | "archive" | "delete" (soft — Deleted quotes tab, restorable). Admin only.
      onExpiry: {
        get: () => rpc("admin_get_link_expiry_shelf", {}),
        set: (action) => rpc("admin_set_link_expiry_shelf", { p_action: action }),
      },
    },
  };

  /* ---------------- quote Archive / Deleted shelves (0040) ----------------
     Soft flags on the quote row (archived_at / deleted_at) — nothing is ever removed;
     Restore puts it back. The server checks has_area quotes (view to list, edit to
     move/restore; moving to Deleted also needs the delete right + no money/consent). */
  const quoteShelf = {
    // { rows: [{ id, code, title, event_type, status, approval_status, client_name, total, updated_at,
    //    shelf: "archived"|"deleted", shelved_at, reason: "manual"|"link_expired", link_expired_at }],
    //   archived_count, deleted_count }   (Archive count includes cancelled / closed events)
    list: () => rpc("list_quote_shelf", {}).then((r) => r || { rows: [], archived_count: 0, deleted_count: 0 }),
    move: (quoteId, shelf) => rpc("move_quote_to_shelf", { p_quote_id: quoteId, p_shelf: shelf }),
    restore: (quoteId) => rpc("restore_quote_from_shelf", { p_quote_id: quoteId }),
    // opening Quotes / Dashboard: moves quotes whose client link expired, per the studio's
    // Control Center choice — the server runs it at most once per 10 minutes per studio
    tick: () => rpc("link_expiry_shelf_tick", {}),
  };

  /* ---------------- invitations: join an existing studio (Phase 83) ---------------- */
  // Onboarding split: create a NEW company = org.createStudio; JOIN an existing
  // one = accept an admin's invite token. Tenant is resolved server-side by RLS.
  const invitations = {
    create: (email, role) => rpc("create_invitation", { p_email: email, p_role: role }),   // admin only (server-checked)
    async list() { if (!supa) return [];                                                     // RLS returns only this org's invites
      const { data, error } = await supa.from("invitations").select("*").order("created_at", { ascending: false });
      if (error) throw error; return data || []; },
    accept:  (token) => rpc("accept_invitation", { p_token: token }),                        // signed-in invitee attaches to the org
    byToken: (token) => rpc("invitation_by_token", { p_token: token }),                      // minimal, no-PII info for the accept screen
    async preview(token) {                                                                   // anon-safe banner info (SEC-06); falls back until deployed
      try { return await rpc("invitation_preview", { p_token: token }); }
      catch (e) { if (rpcMissing(e)) return rpc("invitation_by_token", { p_token: token }); throw e; } },
    async revoke(id) { if (!supa) throw new Error("Supabase not configured");
      const { error } = await supa.from("invitations").update({ status: "revoked" }).eq("id", id); // .eq() key enforced
      if (error) throw error; return true; },
  };

  /* ---------------- per-person attendees / tickets (Phase 84) ---------------- */
  // Individual named attendees with a ticket status. Complements (does not replace)
  // event_guests group counts. Every write is org-forced by a DB trigger + RLS.
  const attendees = {
    async list(quoteId) { if (!supa) return [];
      const { data, error } = await supa.from("event_attendees").select("*").eq("quote_id", quoteId).order("seq");
      if (error) throw error; return data || []; },
    async add(quoteId, a) { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("event_attendees")
        .insert({ quote_id: quoteId, name: (a && a.name) || null, email: (a && a.email) || null,
                  ticket_status: (a && a.ticket_status) || "invited", seq: (a && a.seq) || 0 })
        .select().single(); if (error) throw error; return data; },
    async update(id, patch) { if (!supa) throw new Error("Supabase not configured");
      const { error } = await supa.from("event_attendees").update(patch).eq("id", id); // .eq() key enforced
      if (error) throw error; return true; },
    async remove(id) { if (!supa) throw new Error("Supabase not configured");
      const { error } = await supa.from("event_attendees").delete().eq("id", id);       // .eq() key enforced
      if (error) throw error; return true; },
  };

  /* ---------------- digital invitation sites (Phase 87) ---------------- */
  // A public "digital invitation" website for a CONFIRMED event. All manager-side
  // reads/writes are org-scoped by RLS; the ONLY anon path is public(slug), which
  // hits a SECURITY DEFINER read that returns display fields of a PUBLISHED site.
  // Invitation photos are MAGIC-BYTE validated (never trust the client name/type),
  // image-only allowlist, size-capped, and stored under a random key. Mirrors the
  // event-docs `FILE_SNIFF`/`sniffFile` defence below, but restricted to images
  // (png/jpeg/webp/gif) since these render straight onto the public invite page.
  const INVITE_IMG_MAX = 8 * 1024 * 1024;                 // 8 MB
  const INVITE_IMG_SNIFF = [                               // [mime, ext, magic-byte matcher]
    ["image/png",  "png",  (b) => b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47],           // \x89PNG
    ["image/jpeg", "jpg",  (b) => b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF],                          // JPEG SOI
    ["image/webp", "webp", (b) => b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50], // RIFF....WEBP
    ["image/gif",  "gif",  (b) => b[0]===0x47 && b[1]===0x49 && b[2]===0x46 && b[3]===0x38 && (b[4]===0x37 || b[4]===0x39) && b[5]===0x61], // GIF87a / GIF89a
  ];
  async function sniffInviteImage(file) {
    const buf = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    for (const [mime, ext, ok] of INVITE_IMG_SNIFF) { if (ok(buf)) return { mime, ext }; }
    return null;
  }

  const sites = {
    INVITE_IMG_LABEL: "PNG, JPG, WEBP or GIF, up to 8 MB",
    // manager side (authenticated, RLS-scoped) ----------------------------------
    async forQuote(quoteId) { if (!supa) return null;
      const { data, error } = await supa.from("event_sites").select("*").eq("quote_id", quoteId).maybeSingle();
      if (error) throw error; return data || null; },
    create: (quoteId, eventType, template) =>                                            // admin/edit only (server-checked); idempotent
      rpc("create_event_site", { p_quote_id: quoteId, p_event_type: eventType || "general", p_template: template || "soiree" }),
    async save(id, patch) { if (!supa) throw new Error("Supabase not configured");        // patch: {title, template, event_type, data}
      const { error } = await supa.from("event_sites").update(patch).eq("id", id);        // .eq() key enforced; org forced by trigger+RLS
      if (error) throw error; return true; },
    publish:   (id) => rpc("publish_event_site", { p_id: id, p_publish: true }),          // stamps published_at + name-based slug server-side
    unpublish: (id) => rpc("publish_event_site", { p_id: id, p_publish: false }),
    // Upload an invitation photo to Supabase Storage (public bucket 'invite-media').
    // Path is prefixed with the org id so storage RLS keeps tenants isolated.
    async uploadPhoto(quoteId, file) {
      if (!supa) throw new Error("Supabase not configured");
      if (!file) throw new Error("no file");
      if (file.size > INVITE_IMG_MAX) throw new Error("Image too large (max 8 MB).");
      // Validate by MAGIC BYTES — never trust the client-declared type or extension.
      const sniff = await sniffInviteImage(file);
      if (!sniff) throw new Error("Unsupported image type — allowed: " + this.INVITE_IMG_LABEL + ".");
      const orgId = await org.id();
      if (!orgId) throw new Error("no organization in context");
      // Random object key; the client filename is discarded. Extension + content-type
      // come from the sniff, not from anything the client declared.
      const uuid = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      const path = orgId + "/" + quoteId + "/" + uuid + "." + sniff.ext;
      const { error } = await supa.storage.from("invite-media").upload(path, file, { upsert: false, contentType: sniff.mime });
      if (error) throw error;
      // The returned URL is a stable REFERENCE stored in site data; the bucket is private,
      // so render it through mediaUrls() (signed) — never assume it is publicly fetchable.
      const { data } = supa.storage.from("invite-media").getPublicUrl(path);
      return data.publicUrl;
    },
    // Resolve stored invite-media references to short-lived signed URLs (P2-01). Guests
    // can sign only photos on a PUBLISHED site (storage policy 0019); staff sign their
    // own org's. Non-invite-media http(s) URLs pass through; a failed sign keeps the
    // original reference (still works on a DB whose bucket hasn't been made private yet).
    async mediaUrls(urls, seconds) {
      const list = Array.isArray(urls) ? urls.slice() : [];
      if (!supa) { try { await BPStore.init(); } catch (e) {} }
      if (!supa || !list.length) return list;
      const re = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/invite-media\/([^?#]+)/;
      const idx = [], paths = [];
      list.forEach((u, i) => { const m = re.exec(String(u || "")); if (m) { idx.push(i); paths.push(decodeURIComponent(m[1])); } });
      if (!paths.length) return list;
      try {
        const { data, error } = await supa.storage.from("invite-media").createSignedUrls(paths, seconds || 3600);
        if (error || !Array.isArray(data)) return list;
        data.forEach((r, k) => { if (r && r.signedUrl && !r.error) list[idx[k]] = r.signedUrl; });
      } catch (e) {}
      return list;
    },
    // public side (anonymous guests) --------------------------------------------
    // when guests stop being able to open this invitation (0022): Date, or null = no event date yet
    async liveUntil(siteId) { if (!supa) return null;
      const { data, error } = await supa.rpc("event_site_live_until", { p_site_id: siteId });
      if (error) throw error; return data ? new Date(data) : null; },
    async public(slug) {                                                                  // display fields of a PUBLISHED site only
      if (!supa) { try { await BPStore.init(); } catch (e) {} }
      if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.rpc("public_event_site", { p_slug: slug });
      if (error) throw error; return (data && data[0]) || null; },
  };

  /* ---------------- Build 4: event files (private bucket 'event-docs') ---------------- */
  // Files are the classic tenant-isolation hole, so: PRIVATE bucket, org-prefixed path
  // (<org>/<quote>/<uuid>.<ext>), magic-byte sniff (never trust the name/type), size cap,
  // mime allowlist, and signed URLs for download. Storage RLS + list_event_files enforce
  // isolation server-side; this is defence-in-depth on the client.
  const FILE_MAX = 10 * 1024 * 1024;                       // 10 MB
  const FILE_SNIFF = [                                     // [mime, ext, magic-byte matcher]
    ["application/pdf", "pdf", (b) => b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46],       // %PDF
    ["image/png",  "png",  (b) => b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47],           // \x89PNG
    ["image/jpeg", "jpg",  (b) => b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF],                          // JPEG SOI
    ["image/webp", "webp", (b) => b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50], // RIFF....WEBP
  ];
  async function sniffFile(file) {
    const buf = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    for (const [mime, ext, ok] of FILE_SNIFF) { if (ok(buf)) return { mime, ext }; }
    return null;
  }
  const files = {
    ALLOWED_LABEL: "PDF, PNG, JPG or WEBP, up to 10 MB",
    list: (quoteId) => (supa ? rpc("list_event_files", { p_quote_id: quoteId }) : Promise.resolve([])),
    // Validate by MAGIC BYTES, discard the client filename, store as a uuid, record metadata.
    async upload(quoteId, file) {
      if (!supa) throw new Error("Supabase not configured");
      if (!file) throw new Error("no file");
      if (file.size > FILE_MAX) throw new Error("File too large (max 10 MB).");
      const sniff = await sniffFile(file);
      if (!sniff) throw new Error("Unsupported file type — allowed: " + this.ALLOWED_LABEL + ".");
      const orgId = await org.id();
      if (!orgId) throw new Error("no organization in context");
      const uuid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      const path = orgId + "/" + quoteId + "/" + uuid + "." + sniff.ext;   // client name discarded
      const { error: upErr } = await supa.storage.from("event-docs").upload(path, file, {
        upsert: false, contentType: sniff.mime, cacheControl: "3600" });
      if (upErr) throw upErr;
      // record metadata (RLS re-checks org + has_area). Keep the original name for display only.
      const { data: uid } = await supa.auth.getUser().then((r) => ({ data: r && r.data && r.data.user && r.data.user.id })).catch(() => ({ data: null }));
      const { data: row, error: metaErr } = await supa.from("event_files").insert({
        quote_id: quoteId, storage_path: path, filename: (file.name || uuid).slice(0, 200),
        mime: sniff.mime, size_bytes: file.size, uploaded_by: uid || null }).select().single();
      if (metaErr) { try { await supa.storage.from("event-docs").remove([path]); } catch (e) {} throw metaErr; }
      return row;
    },
    // Short-lived signed URL for a private object (never a public URL).
    async signedUrl(storagePath, seconds) {
      if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.storage.from("event-docs").createSignedUrl(storagePath, seconds || 120);
      if (error) throw error; return data && data.signedUrl;
    },
    async remove(fileId, storagePath) {
      if (!supa) throw new Error("Supabase not configured");
      const { error } = await supa.from("event_files").delete().eq("id", fileId);
      if (error) throw error;
      try { await supa.storage.from("event-docs").remove([storagePath]); } catch (e) { /* metadata gone is the source of truth */ }
      return true;
    },
  };

  /* ===================================================================
     CHAT (Phase: team messaging) — per-org DMs / groups / broadcast, with
     text, images, voice notes, replies, reactions, read state and realtime.
     Supabase: tables + RPCs from migration 0016; media in private 'chat-media'
     bucket (signed URLs). Local fallback: localStorage + BroadcastChannel so it
     works (and syncs across tabs) offline/in dev.
     =================================================================== */
  const CHAT_MEDIA_MAX = 16 * 1024 * 1024;                  // 16 MB (matches the bucket cap)
  const CHAT_MEDIA_KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9-]{1,64}\.[a-z0-9]{2,5}$/i;   // uploadMedia()'s key shape
  const CHAT_SNIFF = [                                       // images + audio, by magic bytes
    ["image/png",  "png",  (b) => b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47],
    ["image/jpeg", "jpg",  (b) => b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF],
    ["image/webp", "webp", (b) => b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50],
    ["image/gif",  "gif",  (b) => b[0]===0x47 && b[1]===0x49 && b[2]===0x46],
    ["audio/webm", "webm", (b) => b[0]===0x1A && b[1]===0x45 && b[2]===0xDF && b[3]===0xA3],   // EBML (MediaRecorder webm)
    ["audio/ogg",  "ogg",  (b) => b[0]===0x4F && b[1]===0x67 && b[2]===0x67 && b[3]===0x53],   // OggS
    ["audio/mp4",  "m4a",  (b) => b[4]===0x66 && b[5]===0x74 && b[6]===0x79 && b[7]===0x70],   // ....ftyp
    ["audio/mpeg", "mp3",  (b) => (b[0]===0x49 && b[1]===0x44 && b[2]===0x33) || (b[0]===0xFF && (b[1]&0xE0)===0xE0)],
  ];
  async function sniffChat(file) {
    const buf = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    for (const [mime, ext, ok] of CHAT_SNIFF) { if (ok(buf)) return { mime, ext }; }
    return null;
  }
  // ---- local-mode state (demo / offline): a settable identity + a seeded roster ----
  const CHAT_LS_C = "bp_chat_conv", CHAT_LS_M = "bp_chat_msg", CHAT_LS_R = "bp_chat_react";
  const CHAT_LOCAL_ROSTER = [
    { id:"u-you",    full_name:"You",          email:"you@demo.in",    role:"admin" },
    { id:"u-ananya", full_name:"Ananya Rao",   email:"ananya@demo.in", role:"manager" },
    { id:"u-vikram", full_name:"Vikram Singh", email:"vikram@demo.in", role:"operations" },
    { id:"u-meera",  full_name:"Meera Nair",   email:"meera@demo.in",  role:"coordinator" },
    { id:"u-rohit",  full_name:"Rohit Verma",  email:"rohit@demo.in",  role:"crew" },
  ];
  // Local demo identity. A per-TAB override (sessionStorage) lets two tabs act as
  // two different demo teammates for a real two-login test — no UI, demo only.
  // Real Supabase mode never calls this; identity there comes from the auth session.
  function chatLocalUid() {
    try { const s = sessionStorage.getItem("helm_local_uid"); if (s) return s; } catch (e) {}
    try { return localStorage.getItem("helm_local_uid") || "u-you"; } catch (e) { return "u-you"; }
  }
  let chatBackendMissing = false, chatBcastEnsured = false;   // bell: skip when chat SQL absent; ensure broadcast once
  function chatMultiUser() { try { return !!sessionStorage.getItem("helm_local_uid"); } catch (e) { return false; } }
  const chatReadLs = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch (e) { return []; } };
  const chatWriteLs = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  let chatBC = null; try { chatBC = (typeof BroadcastChannel !== "undefined") ? new BroadcastChannel("helm-chat") : null; } catch (e) {}
  function chatPing() { try { chatBC && chatBC.postMessage({ t: Date.now() }); } catch (e) {} try { localStorage.setItem("bp_chat_ping", String(Date.now())); } catch (e) {} }
  function chatDmKey(a, b) { return a < b ? a + ":" + b : b + ":" + a; }
  // One-line preview for a message (used by the list + the notification bell).
  function chatPreviewText(m) {
    if (!m) return "";
    if (m.kind === "image") return "📷 Photo";
    if (m.kind === "voice") return "🎤 Voice message";
    if (m.kind === "card") { const t = m.meta || {}; if (t.kind === "event") return "📋 Event details" + (t.code ? ": " + t.code : ""); if (t.kind === "layout") return "📐 Layout" + (t.name ? ": " + t.name : ""); return "📄 Quote" + (t.code ? ": " + t.code : (t.title ? ": " + t.title : "")); }
    return m.body || "";
  }
  // Conversations the viewer muted (per-user, stored by the chat page in localStorage).
  function chatReadMuted() { try { return new Set(JSON.parse(localStorage.getItem("wa_mute") || "[]")); } catch (e) { return new Set(); } }
  // A conversation's display title (group / broadcast name, or the other person of a DM).
  function chatConvTitle(c, me, nameFor) {
    if (c.kind === "broadcast") return c.title || "Everyone";
    if (c.kind === "group") return c.title || "Group";
    const ids = (c.dm_key || "").split(":"); const o = ids[0] === me ? ids[1] : ids[0]; return nameFor(o);
  }
  // @mentions (0035) → bell items. A mention turns that conversation's bell row into
  // "X mentioned you in <group>" and is shown EVEN IF the chat is muted.
  function chatMergeMentions(out, mentions) {
    const byConv = {};
    (mentions || []).forEach((m) => { const b = byConv[m.conversation_id]; if (b) b.n++; else byConv[m.conversation_id] = { m, n: 1 }; });
    Object.keys(byConv).forEach((cid) => {
      const { m, n } = byConv[cid];
      const title = m.conv_kind === "dm" ? (m.who + " mentioned you") : (m.who + " mentioned you in " + m.title);
      const item = out.find((x) => x.conversation_id === cid);
      if (item) { item.kind = "mention"; item.mention = true; item.title = title; item.who = ""; item.preview = m.preview; if (String(m.created_at) > String(item.created_at)) item.created_at = m.created_at; }
      else out.push({ conversation_id: cid, kind: "mention", mention: true, title, who: "", preview: m.preview, created_at: m.created_at, count: n });
    });
    out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return out;
  }
  let chatMentionsMissing = false;   // 0035 not installed yet → no mention lookups
  // Local/offline event card — the SAME whitelist as the server's _event_card (0035):
  // client contact, event type/date/time, venue, guests, layout, menu, notes. Never money.
  function chatLocalEventCard(q) {
    q = q || {}; const cl = q.client || (q.pricing && q.pricing.client) || {}; const pr = q.pricing || {};
    const s = (v, n) => { const t = String(v == null ? "" : v).trim(); return t ? t.slice(0, n || 200) : undefined; };
    const g = [pr.guests, cl.guests, pr.chairs].map((x) => Number(x)).find((x) => Number.isInteger(x) && x >= 0);
    const card = { kind: "event", v: 1, quote_id: q.id, code: s(q.code, 40), title: s(q.title), status: q.status, event_type: s(q.eventType, 80),
      event_date: s(q.eventDate || cl.eventDate, 10), client: { name: s(cl.name, 120), phone: s(cl.phone, 40), email: s(cl.email), company: s(cl.company, 120) },
      venue: s(cl.venue), venue_address: s(cl.address, 400), guests: g, layout: { kind: "layout", quote_id: q.id, version: q.currentVersion },
      notes: s(cl.notes, 2000), generated_at: new Date().toISOString() };
    return JSON.parse(JSON.stringify(card));   // drops undefined keys
  }
  // Event-group avatar: an emoji for the quote's event type, else keywords in its title,
  // else 📅. Whole words, case-insensitive; "_"/"-" count as spaces ("wedding_reception").
  // Order matters — the more specific occasion wins ("baby shower" before "party",
  // "reception" before "wedding", "birthday party" → 🎂). Output is a fixed emoji, never user text.
  function chatEventEmoji(eventType, title) {
    const RULES = [
      [/\bbaby ?shower\b|\bgodh ?bharai\b|\bseemantham\b/, "🍼"],
      [/\bengage(?:ment|d)?\b|\bring ceremony\b|\broka\b|\bsagai\b/, "💞"],
      [/\breception\b/, "🥂"],
      [/\bwedding\b|\bmarriage\b|\bshaadi\b|\bvivah\b|\bsangeet\b|\bmehe?ndi\b|\bhaldi\b/, "💍"],
      [/\banniversary\b/, "💐"],
      [/\bbirthday\b|\bbday\b/, "🎂"],
      [/\bgraduation\b|\bconvocation\b/, "🎓"],
      [/\bpolitical\b|\brally\b|\belection\b/, "🗳️"],
      [/\bconcert\b|\bmusic(?:al)?\b|\blive show\b/, "🎤"],
      [/\bsports?\b|\btournament\b|\bmarathon\b/, "🏟️"],
      [/\bfestival\b|\bfest\b|\bmela\b|\bcarnival\b/, "🎪"],
      [/\bexhibition\b|\bexpo\b|\btrade show\b/, "🖼️"],
      [/\breligious\b|\bpuja\b|\bpooja\b|\bhavan\b|\bsatsang\b/, "🪔"],
      [/\bcorporate\b|\bconference\b|\bseminar\b|\bsummit\b|\boffsite\b/, "🏢"],
      [/\bparty\b|\bcelebration\b/, "🎉"],
    ];
    const hit = (v) => { v = String(v == null ? "" : v).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim(); if (!v) return null;
      for (let i = 0; i < RULES.length; i++) if (RULES[i][0].test(v)) return RULES[i][1]; return null; };
    return hit(eventType) || hit(title) || "📅";
  }

  /* ---------------- display names (0034) ---------------- */
  // What to call a person: their display name → the part of their e-mail before "@"
  // → their role → "Member". Plain text — callers must still escape it.
  function personDisplayName(p) {
    if (!p) return "Member";
    const n = String(p.full_name || "").trim(); if (n) return n;
    const local = String(p.email_name || String(p.email || "").split("@")[0] || "").trim(); if (local) return local;
    return p.role ? roleLabel(p.role) : "Member";
  }
  // Same rule as public._clean_display_name: spaces collapsed, 1-80 characters, no < > or control characters.
  const cleanDisplayName = (name) => String(name == null ? "" : name).replace(/\s+/g, " ").trim();
  function displayNameProblem(name) {
    const v = cleanDisplayName(name);
    if (!v || [...v].length > 80) return "A display name must be 1 to 80 characters.";
    if (/[<>]/.test(v)) return "A display name can't contain < or >.";
    if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return "A display name can't contain control characters.";
    return null;
  }
  /* ---------------- member profile (0041 "Complete your profile") ----------------
     Client-side mirror of the SQL rules in 0041 (_mp_text / _mp_mobile / _mp_any_phone
     / _mp_skills) so the form can explain a problem before the round-trip. The server
     re-checks everything; these never relax it. */
  const MP_TEXT_MAX = 80, MP_SKILL_MAX = 40, MP_SKILLS_MAX = 20;
  const MP_KEYS = ["full_name", "phone", "whatsapp", "whatsapp_same", "job_title", "department", "skills",
    "city", "emergency_contact_name", "emergency_contact_phone"];
  const MP_TEXT_LABEL = { full_name: "Full name", job_title: "Job title", department: "Department", city: "City",
    emergency_contact_name: "Emergency contact name" };
  const mpClean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  // → { val } (null = blank) or { err }
  function mpText(v, label, max) {
    const s = mpClean(v);
    if (!s) return { val: null };
    if ([...s].length > max) return { err: label + " must be " + max + " characters or fewer." };
    if (/[<>]/.test(s)) return { err: label + " can't contain < or >." };
    if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) return { err: label + " can't contain control characters." };
    return { val: s };
  }
  // Indian mobile → +91XXXXXXXXXX (accepts 98765 43210, 098765…, +91 98765…, 91 98765…)
  function mpMobile(v, label) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return { val: null };
    if (!/^\+?[0-9 ().-]{6,24}$/.test(s)) return { err: label + " must be a 10-digit Indian mobile number." };
    let d = s.replace(/[^0-9]/g, "");
    if (d.length === 12 && d.slice(0, 2) === "91") d = d.slice(2);
    else if (d.length === 11 && d.charAt(0) === "0") d = d.slice(1);
    if (!/^[6-9][0-9]{9}$/.test(d)) return { err: label + " must be a 10-digit Indian mobile number starting with 6, 7, 8 or 9." };
    return { val: "+91" + d };
  }
  // emergency contact: an Indian mobile, or an international number written with a leading +
  function mpAnyPhone(v, label) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return { val: null };
    const m = mpMobile(s, label); if (!m.err) return m;
    const d = s.replace(/[^0-9]/g, "");
    if (/^\+[0-9 ().-]{6,24}$/.test(s) && /^[1-9][0-9]{7,14}$/.test(d)) return { val: "+" + d };
    return { err: label + " must be a 10-digit Indian mobile number, or an international number starting with +." };
  }
  function mpSkills(v) {
    let src = v;
    if (src == null) return { val: [] };
    if (typeof src === "string") src = src.split(",");
    if (!Array.isArray(src)) return { err: "Skills must be a list." };
    const out = [];
    for (const item of src) {
      if (typeof item !== "string") return { err: "Each skill must be text." };
      const t = mpText(item, "A skill", MP_SKILL_MAX); if (t.err) return t;
      if (t.val && !out.some((s) => s.toLowerCase() === t.val.toLowerCase())) out.push(t.val);
    }
    if (out.length > MP_SKILLS_MAX) return { err: "Add up to " + MP_SKILLS_MAX + " skills." };
    return { val: out };
  }
  // "+919876543210" → "9876543210" (for an input that shows the +91 prefix itself)
  function mpLocalMobile(e164) {
    const m = /^\+91([6-9][0-9]{9})$/.exec(String(e164 || ""));
    return m ? m[1] : String(e164 || "");
  }
  // validate(fields, {requireName, requirePhone}) → {ok, errors:{key:msg}, clean:{…}}.
  // `clean` holds only the keys the RPCs accept; a blank optional text is sent as null
  // (clears it); a blank name / mobile is left out unless required (they can't be cleared).
  function mpValidate(fields, opts) {
    const f = fields || {}, o = opts || {};
    const errors = {}, clean = {};
    const name = mpText(f.full_name, "Full name", MP_TEXT_MAX);
    if (name.err) errors.full_name = name.err;
    else if (name.val) clean.full_name = name.val;
    else if (o.requireName) errors.full_name = "Full name is required.";
    const ph = mpMobile(f.phone, "Mobile number");
    if (ph.err) errors.phone = ph.err;
    else if (ph.val) clean.phone = ph.val;
    else if (o.requirePhone) errors.phone = "Mobile number is required.";
    const same = f.whatsapp_same !== false;
    clean.whatsapp_same = same;
    if (!same) {
      const wa = mpMobile(f.whatsapp, "WhatsApp number");
      if (wa.err) errors.whatsapp = wa.err; else clean.whatsapp = wa.val;
    }
    ["job_title", "department", "city", "emergency_contact_name"].forEach((k) => {
      if (!(k in f)) return;
      const t = mpText(f[k], MP_TEXT_LABEL[k], MP_TEXT_MAX);
      if (t.err) errors[k] = t.err; else clean[k] = t.val;
    });
    if ("emergency_contact_phone" in f) {
      const ep = mpAnyPhone(f.emergency_contact_phone, "Emergency contact number");
      if (ep.err) errors.emergency_contact_phone = ep.err; else clean.emergency_contact_phone = ep.val;
    }
    if ("skills" in f) {
      const sk = mpSkills(f.skills);
      if (sk.err) errors.skills = sk.err; else clean.skills = sk.val;
    }
    return { ok: Object.keys(errors).length === 0, errors, clean };
  }
  function mpInvalid(r) {
    const k = Object.keys(r.errors)[0];
    const e = new Error(r.errors[k]); e.code = "profile_invalid"; e.fields = r.errors; e.field = k; return e;
  }

  /* ---- profile photo: checked + resized in the browser, then uploaded ----
     Private bucket member-avatars (0041): key <studio>/<user>/<uuid>.<png|jpg|webp>,
     <= 2 MB, png / jpeg / webp. Only real PNG / JPEG / WebP files are accepted (by
     their first bytes, not the file name or the browser's guess); the picture is
     centre-cropped to a square and redrawn at <= 512 px, so whatever was in the
     original file (metadata, scripts, extra frames) is never uploaded. */
  const AVATAR_BUCKET = "member-avatars";
  const AVATAR_PX = 512, AVATAR_MAX_BYTES = 2 * 1024 * 1024, AVATAR_MAX_INPUT = 20 * 1024 * 1024, AVATAR_MAX_PIXELS = 60e6;
  const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const AVATAR_PATH_RE = new RegExp("^" + UUID_RE + "/" + UUID_RE + "/" + UUID_RE + "\\.(png|jpg|webp)$");
  // first bytes → "png" | "jpeg" | "webp" | null (GIF, SVG, HEIC, PDF … → null)
  function sniffImage(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
    return null;
  }
  // centre square of a w×h picture, drawn at min(side, max) px
  function avatarCrop(w, h, max) {
    w = Math.floor(Number(w) || 0); h = Math.floor(Number(h) || 0);
    if (!(w > 0 && h > 0)) return null;
    const side = Math.min(w, h);
    return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side: side, size: Math.min(side, max || AVATAR_PX) };
  }
  function avatarPathFor(orgId, uid, id, ext) {
    const p = String(orgId || "").toLowerCase() + "/" + String(uid || "").toLowerCase() + "/" + String(id || "").toLowerCase() + "." + ext;
    return AVATAR_PATH_RE.test(p) ? p : null;
  }
  function newUuid() {
    const c = global.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    if (c && typeof c.getRandomValues === "function") {
      const b = c.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const hx = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return hx.slice(0, 8) + "-" + hx.slice(8, 12) + "-" + hx.slice(12, 16) + "-" + hx.slice(16, 20) + "-" + hx.slice(20);
    }
    return null;
  }
  function photoErr(msg, code) { const e = new Error(msg); e.code = code || "avatar_invalid"; return e; }
  async function readHead(file, n) {
    const part = file.slice(0, n);
    if (part && typeof part.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer());
    return new Uint8Array(await new Response(part).arrayBuffer());
  }
  // a File / Blob → { blob, type, ext } (square, <= 512 px, <= 2 MB) — throws a user-facing error
  async function processAvatar(file) {
    if (!file || typeof file.size !== "number" || typeof file.slice !== "function") throw photoErr("Choose a photo to upload.");
    if (file.size < 12) throw photoErr("That file is empty or not a photo.");
    if (file.size > AVATAR_MAX_INPUT) throw photoErr("That photo is too large — choose one under 20 MB.");
    const kind = sniffImage(await readHead(file, 16));
    if (!kind) throw photoErr("Use a PNG, JPEG or WebP photo.");
    if (typeof document === "undefined") throw photoErr("Photos can't be processed here.");
    let img = null, url = null;
    try {
      if (typeof global.createImageBitmap === "function") {
        try { img = await global.createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { img = null; }
      }
      if (!img) {
        url = URL.createObjectURL(file);
        img = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im); im.onerror = () => reject(photoErr("That photo couldn't be opened — try another one."));
          im.src = url;
        });
      }
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (w * h > AVATAR_MAX_PIXELS) throw photoErr("That photo is too large — choose a smaller one.");
      const box = avatarCrop(w, h, AVATAR_PX);
      if (!box || box.side < 32) throw photoErr("That photo is too small — use one at least 32 × 32 pixels.");
      const cv = document.createElement("canvas"); cv.width = box.size; cv.height = box.size;
      const ctx = cv.getContext("2d");
      if (!ctx) throw photoErr("Photos can't be processed in this browser.");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, box.size, box.size);
      try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; } catch (e) {}
      ctx.drawImage(img, box.sx, box.sy, box.side, box.side, 0, 0, box.size, box.size);
      const toBlob = (type, q) => new Promise((resolve) => { try { cv.toBlob((b) => resolve(b), type, q); } catch (e) { resolve(null); } });
      let out = null;
      for (const q of [0.88, 0.8, 0.7, 0.6, 0.5]) {
        let b = await toBlob("image/webp", q);
        if (!b || b.type !== "image/webp") b = await toBlob("image/jpeg", q);
        if (b && b.size <= AVATAR_MAX_BYTES) { out = b; break; }
      }
      if (!out) throw photoErr("That photo couldn't be made small enough — try another one.");
      const outKind = sniffImage(await readHead(out, 16));
      if (outKind !== "webp" && outKind !== "jpeg") throw photoErr("That photo couldn't be converted — try another one.");
      return { blob: out, type: outKind === "webp" ? "image/webp" : "image/jpeg", ext: outKind === "webp" ? "webp" : "jpg" };
    } finally {
      if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
      if (img && typeof img.close === "function") { try { img.close(); } catch (e) {} }
    }
  }
  // signed photo URLs (private bucket), cached briefly per page
  const avatarUrlCache = new Map();   // path → { url, exp } | { pending }
  const AVATAR_URL_TTL = 3600, AVATAR_URL_REUSE = 45 * 60000;
  let avatarSignQueue = null;         // { paths, done } — one createSignedUrls call per tick
  let profileRpcMissing = false;      // 0041 not installed → my_profile() falls back to the profiles row

  const profile = {
    displayName: personDisplayName,
    clean: cleanDisplayName,
    problem: displayNameProblem,
    // My own profile. With 0041: my_profile() (name, mobile, WhatsApp, title, department,
    // skills, city, emergency contact, photo path, complete). Without it: the profiles
    // row (id, email, full_name, role) as before. Always carries id + full_name.
    async mine() {
      if (mode !== "supabase") { const u = CHAT_LOCAL_ROSTER.find((x) => x.id === chatLocalUid()) || CHAT_LOCAL_ROSTER[0]; return Object.assign({}, u); }
      if (!supa || !currentUser) return null;
      if (!profileRpcMissing) {
        const { data, error } = await supa.rpc("my_profile");
        if (!error) return data && typeof data === "object" ? Object.assign({ id: data.user_id }, data) : null;
        if (!rpcMissing(error)) { if (looksLikeAuthError(error)) onAuthFailure(); throw error; }
        profileRpcMissing = true;
      }
      const { data, error } = await supa.from("profiles").select("id,email,full_name,role").eq("id", currentUser.id).maybeSingle();
      if (error) throw error; return data || null;
    },
    // {complete, required, nudge} | {missing:true} (0041 not installed) | null (offline /
    // signed out / unknown). Never throws. {fresh:true} skips the per-tab cache.
    async status(o) {
      if (mode !== "supabase") return null;
      try { return await fetchProfileStatus(!!(o && o.fresh)); } catch (e) { return null; }
    },
    // Is the profile feature installed on this database (0041)?
    async available() { const s = await profile.status(); return !!(s && !s.missing); },
    // "setup" | "nudge" | "none" for a status answer (pure — see profileGateDecision)
    gateDecision: (st, page, role) => profileGateDecision(st, page, role),
    // Signed in and about to leave the login page: a NEW member who must complete their
    // profile goes to /profile-setup?next=… first (location.replace). Resolves true when
    // it redirected; false otherwise (incl. any error — the next page's gate re-checks).
    async routeIfRequired(next) {
      if (mode !== "supabase" || !currentUser || pendingStep) return false;
      let st = null; try { st = await fetchProfileStatus(true); } catch (e) { return false; }
      if (profileGateDecision(st, "login", roleCache) !== "setup") return false;
      try { location.replace(profileSetupUrl(next)); } catch (e) { return false; }
      return true;
    },
    // where /profile-setup sends you afterwards (always one of the app's own pages)
    setupNext: () => safeNext(nextParam()),
    // mirror of the SQL checks → {ok, errors, clean}
    validate: (fields, opts) => mpValidate(fields, opts),
    localMobile: mpLocalMobile,
    limits: { text: MP_TEXT_MAX, skill: MP_SKILL_MAX, skills: MP_SKILLS_MAX, photoBytes: AVATAR_MAX_BYTES, photoPx: AVATAR_PX },
    // save some fields (update_my_profile) → the saved profile
    async update(fields, opts) {
      const r = mpValidate(fields, Object.assign({ requireName: false, requirePhone: false }, opts || {}));
      if (!r.ok) throw mpInvalid(r);
      const row = await rpc("update_my_profile", { p_profile: r.clean });
      if (row && typeof row === "object") noteProfileComplete(row.complete === true);
      return row;
    },
    // finish the first sign-in step (complete_my_profile: name + mobile required)
    async complete(fields) {
      const r = mpValidate(fields, { requireName: true, requirePhone: true });
      if (!r.ok) throw mpInvalid(r);
      const row = await rpc("complete_my_profile", { p_profile: r.clean });
      noteProfileComplete(true);
      return row;
    },
    // pure helpers (exported for tests)
    _sniffImage: sniffImage, _avatarCrop: avatarCrop, _avatarPath: avatarPathFor,
    // check + square-crop + resize a picked photo → {blob, type, ext}
    processAvatar: processAvatar,
    // upload my photo, then point my profile at it (set_my_avatar) → the stored path
    async uploadAvatar(file) {
      if (mode !== "supabase" || !supa || !currentUser) throw photoErr("Sign in to add a photo.", "avatar_unavailable");
      const p = await processAvatar(file);
      const oid = await orgIdStrict();
      const path = avatarPathFor(oid, currentUser.id, newUuid(), p.ext);
      if (!path) throw photoErr("Your photo couldn't be saved — reload the page and try again.", "avatar_unavailable");
      const up = await supa.storage.from(AVATAR_BUCKET).upload(path, p.blob, { contentType: p.type, upsert: false, cacheControl: "3600" });
      if (up && up.error) { if (looksLikeAuthError(up.error)) onAuthFailure(); throw up.error; }
      const saved = await rpc("set_my_avatar", { p_path: path });
      try { avatarUrlCache.set(path, { url: URL.createObjectURL(p.blob), exp: Date.now() + 24 * 3600000 }); } catch (e) {}
      return saved || path;
    },
    // remove my photo (the file stays in storage — "remove" only clears the link)
    async removeAvatar() {
      if (mode !== "supabase") throw photoErr("Sign in to change your photo.", "avatar_unavailable");
      await rpc("set_my_avatar", { p_path: null });
      return null;
    },
    // a short-lived signed URL for a photo path (null when it can't be shown)
    async avatarUrl(path) {
      if (mode !== "supabase" || !supa || !currentUser || !AVATAR_PATH_RE.test(String(path || ""))) return null;
      const hit = avatarUrlCache.get(path);
      if (hit && hit.pending) return hit.pending;
      if (hit && hit.url && hit.exp > Date.now()) return hit.url;
      // paths asked for in the same tick are signed in ONE request
      if (!avatarSignQueue) {
        const q = avatarSignQueue = { paths: [] };
        q.done = new Promise((r) => setTimeout(r, 0)).then(async () => {
          avatarSignQueue = null;
          const st = supa.storage.from(AVATAR_BUCKET), out = {};
          if (typeof st.createSignedUrls === "function") {
            const { data, error } = await st.createSignedUrls(q.paths, AVATAR_URL_TTL);
            if (!error) (data || []).forEach((r, k) => { const p = (r && r.path) || q.paths[k]; if (r && r.signedUrl && !r.error) out[p] = r.signedUrl; });
          } else {
            await Promise.all(q.paths.map(async (p) => { const { data, error } = await st.createSignedUrl(p, AVATAR_URL_TTL); if (!error && data && data.signedUrl) out[p] = data.signedUrl; }));
          }
          return out;
        });
      }
      const q = avatarSignQueue;
      if (q.paths.indexOf(path) < 0) q.paths.push(path);
      const pending = q.done.then((out) => {
        const url = out[path] || null;
        if (url) avatarUrlCache.set(path, { url: url, exp: Date.now() + AVATAR_URL_REUSE }); else avatarUrlCache.delete(path);
        return url;
      }, () => { avatarUrlCache.delete(path); return null; });
      avatarUrlCache.set(path, { pending: pending });
      return pending;
    },
    // several at once → { path: url|null }
    async avatarUrls(paths) {
      const list = Array.from(new Set((paths || []).filter((p) => AVATAR_PATH_RE.test(String(p || "")))));
      const out = {};
      await Promise.all(list.map(async (p) => { out[p] = await profile.avatarUrl(p); }));
      return out;
    },
    // "Complete your profile" banner snooze (7 days, this browser, per account)
    nudgeSnoozed() {
      if (!currentUser) return false;
      try { const o = JSON.parse(localStorage.getItem(NUDGE_KEY) || "null"); return !!(o && o.uid === currentUser.id && Number(o.until) > Date.now()); }
      catch (e) { return false; }
    },
    snoozeNudge(days) {
      if (!currentUser) return;
      const d = Number(days) > 0 ? Number(days) : 7;
      try { localStorage.setItem(NUDGE_KEY, JSON.stringify({ uid: currentUser.id, until: Date.now() + d * 86400000 })); } catch (e) {}
    },
    // name yourself (set_my_display_name) → the saved, cleaned name
    async setMine(name) {
      const bad = displayNameProblem(name); if (bad) throw new Error(bad);
      if (mode !== "supabase") { const u = CHAT_LOCAL_ROSTER.find((x) => x.id === chatLocalUid()); if (u) u.full_name = cleanDisplayName(name); return cleanDisplayName(name); }
      return rpc("set_my_display_name", { p_name: cleanDisplayName(name) });
    },
    // admin: name a member of your own studio (admin_set_display_name; the DB refuses anyone else)
    async setName(userId, name) {
      const bad = displayNameProblem(name); if (bad) throw new Error(bad);
      return rpc("admin_set_display_name", { p_user: userId, p_name: cleanDisplayName(name) });
    },
  };
  let chatDirectoryMissing = false;   // 0034 not installed yet → fall back to the RLS-scoped profiles read

  const chat = {
    // Is the feature running on localStorage (true) or a real backend (false)?
    isLocal: () => mode !== "supabase",
    // Who am I, for display + "is this mine" checks.
    async me() {
      if (mode !== "supabase") { const u = CHAT_LOCAL_ROSTER.find((x) => x.id === chatLocalUid()) || CHAT_LOCAL_ROSTER[0]; return { id: u.id, name: u.full_name, email: u.email }; }
      const id = currentUser && currentUser.id;
      let name = personDisplayName({ email: currentUser && currentUser.email });
      try { const { data } = await supa.from("profiles").select("full_name,email,role").eq("id", id).maybeSingle(); if (data) name = personDisplayName(data); } catch (e) {}
      return { id, name, email: currentUser && currentUser.email };
    },
    // display name for a roster row (name → e-mail before "@" → role)
    displayName: personDisplayName,
    // member photos (0041): signed URL for an avatar_path / paint [data-avatar-path] avatars
    avatarUrl: memberAvatarUrl,
    paintAvatars: paintMemberAvatars,
    // everyone in my studio by id (one chat_directory read per page)
    directory: memberDirectory,
    // event-group avatar emoji from an event type / title (see chatEventEmoji)
    eventEmoji: chatEventEmoji,
    // Local-mode only: switch the acting identity (two tabs = two "users" for a live demo).
    localRoster: () => CHAT_LOCAL_ROSTER.slice(),
    setLocalUser: (id) => { try { localStorage.setItem("helm_local_uid", id); } catch (e) {} },
    // Everyone in my studio, by name (chat_directory, 0034: names + e-mail local part
    // + role, own studio only). Before 0034 is installed, falls back to the profiles
    // read — RLS then shows colleagues only to users with the users-view capability.
    async roster() {
      if (mode !== "supabase") return CHAT_LOCAL_ROSTER.slice();
      if (!chatDirectoryMissing) {
        const { data, error } = await supa.rpc("chat_directory");
        if (!error) return (data || []).map(chatPerson);   // + avatar_path / job_title / department (0041)
        if (!rpcMissing(error)) throw error;
        chatDirectoryMissing = true;
      }
      const { data, error } = await supa.from("profiles").select("id,email,full_name,role").order("full_name");
      if (error) throw error; return data || [];
    },
    // Conversations I can see (my DMs + groups + the org broadcast), newest first.
    async conversations() {
      if (mode !== "supabase") {
        let convs = chatReadLs(CHAT_LS_C);
        if (!convs.some((c) => c.kind === "broadcast")) { convs.unshift({ id: "bcast", kind: "broadcast", title: "Everyone", created_at: now(), last_message_at: now(), members: [] }); chatWriteLs(CHAT_LS_C, convs); }
        return convs.slice().sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
      }
      // ensure the org "Everyone" channel ONCE per page — not on every bell poll
      if (!chatBcastEnsured) { try { await rpc("chat_ensure_broadcast"); chatBcastEnsured = true; } catch (e) {} }
      const { data, error } = await supa.from("chat_conversations").select("*").order("last_message_at", { ascending: false });
      if (error) throw error; return data || [];
    },
    // My membership rows (→ last_read_at per conversation, for unread badges).
    async myMemberships() {
      if (mode !== "supabase") { const me = chatLocalUid(); const out = {}; chatReadLs(CHAT_LS_C).forEach((c) => { const m = (c.members || []).find((x) => x.user_id === me); if (m) out[c.id] = m; }); return out; }
      const { data } = await supa.from("chat_members").select("conversation_id,last_read_at,member_role").eq("user_id", currentUser ? currentUser.id : null);
      const out = {}; (data || []).forEach((m) => { out[m.conversation_id] = m; }); return out;
    },
    // Everything needed to render one conversation: messages (oldest→newest) + reactions + members.
    // Perf (Oct 2026): the LATEST `limit` messages (default 50) — a long thread no longer
    // ships hundreds of messages (and it used to get the OLDEST 500, so the newest went missing).
    //   opts.before = a message → the `limit` messages just older than it (scroll-up history)
    //   opts.since  = timestamp → every message from then on (re-sync what's already on screen)
    //   opts.light  → skip reactions (conversation-list previews don't show them)
    // returns { messages, reactions, members, hasMore }  hasMore = older messages exist
    // (undefined for `since`; members are not re-read for `before`).
    async thread(convId, limit, opts) {
      opts = opts || {};
      const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
      const byTime = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
      if (mode !== "supabase") {
        let all = chatReadLs(CHAT_LS_M).filter((x) => x.conversation_id === convId).sort(byTime);
        let msgs, hasMore;
        if (opts.since) { msgs = all.filter((m) => String(m.created_at) >= String(opts.since)); hasMore = undefined; }
        else {
          if (opts.before) all = all.filter((m) => byTime(m, opts.before) < 0);
          msgs = all.slice(Math.max(0, all.length - n)); hasMore = all.length > n;
        }
        const ids = msgs.map((m) => m.id);
        const reactions = opts.light ? [] : chatReadLs(CHAT_LS_R).filter((r) => ids.indexOf(r.message_id) !== -1);
        const conv = chatReadLs(CHAT_LS_C).find((c) => c.id === convId) || {};
        return { messages: msgs, reactions, members: opts.before ? [] : (conv.members || []), hasMore };
      }
      let q = supa.from("chat_messages").select("*").eq("conversation_id", convId);
      let msgs = [], hasMore;
      if (opts.since) {
        const { data, error } = await q.gte("created_at", opts.since).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(1000);
        if (error) throw error; msgs = data || [];
      } else {
        if (opts.before && opts.before.created_at) {
          const t = pgQuote(opts.before.created_at);
          q = q.or("created_at.lt." + t + (opts.before.id ? ",and(created_at.eq." + t + ",id.lt." + pgQuote(opts.before.id) + ")" : ""));
        }
        const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(n + 1);
        if (error) throw error;
        const d = data || []; hasMore = d.length > n; msgs = d.slice(0, n).reverse();
      }
      const ids = msgs.map((m) => m.id);
      const [rr, mm] = await Promise.all([
        (!opts.light && ids.length) ? supa.from("chat_reactions").select("*").in("message_id", ids) : Promise.resolve({ data: [] }),
        opts.before ? Promise.resolve({ data: [] }) : supa.from("chat_members").select("*").eq("conversation_id", convId),
      ]);
      return { messages: msgs, reactions: (rr && rr.data) || [], members: (mm && mm.data) || [], hasMore };
    },
    async startDm(otherId) {
      if (mode !== "supabase") {
        const me = chatLocalUid(); if (otherId === me) throw new Error("invalid recipient");
        const key = chatDmKey(me, otherId); const convs = chatReadLs(CHAT_LS_C);
        let c = convs.find((x) => x.dm_key === key);
        if (!c) { c = { id: uid(), kind: "dm", dm_key: key, created_by: me, created_at: now(), last_message_at: now(), members: [{ user_id: me }, { user_id: otherId }] }; convs.push(c); chatWriteLs(CHAT_LS_C, convs); chatPing(); }
        return c.id;
      }
      return rpc("chat_start_dm", { p_other: otherId });
    },
    async createGroup(title, memberIds) {
      if (mode !== "supabase") {
        const me = chatLocalUid(); const convs = chatReadLs(CHAT_LS_C);
        const members = [{ user_id: me, member_role: "admin" }].concat((memberIds || []).filter((x) => x !== me).map((x) => ({ user_id: x })));
        const c = { id: uid(), kind: "group", title: (title || "Group").trim(), created_by: me, created_at: now(), last_message_at: now(), members };
        convs.push(c); chatWriteLs(CHAT_LS_C, convs); chatPing(); return c.id;
      }
      return rpc("chat_create_group", { p_title: title, p_members: memberIds || [] });
    },
    async addMembers(convId, memberIds) {
      if (mode !== "supabase") { const convs = chatReadLs(CHAT_LS_C); const c = convs.find((x) => x.id === convId); if (c) { c.members = c.members || []; (memberIds || []).forEach((id) => { if (!c.members.some((m) => m.user_id === id)) c.members.push({ user_id: id }); }); chatWriteLs(CHAT_LS_C, convs); chatPing(); } return; }
      return rpc("chat_add_members", { p_conversation: convId, p_members: memberIds || [] });
    },
    // Upload an image or voice note; returns { path, mime } to pass to send().
    async uploadMedia(convId, file, opts) {
      opts = opts || {};
      if (!file) throw new Error("no file");
      if (file.size > CHAT_MEDIA_MAX) throw new Error("File too large (max 16 MB).");
      const sniff = await sniffChat(file);
      if (!sniff) throw new Error("Unsupported file — images or voice notes only.");
      if (mode !== "supabase") { const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); return { path: dataUrl, mime: sniff.mime }; }
      const orgId = await org.id(); if (!orgId) throw new Error("no organization in context");
      const u = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
      const path = orgId + "/" + convId + "/" + u + "." + sniff.ext;
      const { error } = await supa.storage.from("chat-media").upload(path, file, { upsert: false, contentType: sniff.mime, cacheControl: "3600" });
      if (error) throw error;
      return { path, mime: sniff.mime };
    },
    // Resolve a media_path to something an <img>/<audio> can load.
    async mediaUrl(path, seconds) {
      if (!path) return null;
      if (mode !== "supabase") return path;   // local data: URL
      // Only our own storage keys (<org>/<conversation>/<file>.<ext>) are signed. A message
      // carrying an external URL is never loaded — it would let a sender track every viewer.
      if (!CHAT_MEDIA_KEY.test(path)) return null;
      const { data, error } = await supa.storage.from("chat-media").createSignedUrl(path, seconds || 300);
      if (error) throw error; return data && data.signedUrl;
    },
    async send(convId, m) {
      m = m || {};
      if (mode !== "supabase") {
        const msgs = chatReadLs(CHAT_LS_M);
        const row = { id: uid(), conversation_id: convId, org_id: "local", sender_id: chatLocalUid(), kind: m.kind || "text", body: m.body || null, media_path: m.media_path || null, media_mime: m.media_mime || null, media_duration: m.media_duration || null, reply_to: m.reply_to || null, meta: m.meta || null, created_at: now(), deleted: false };
        msgs.push(row); chatWriteLs(CHAT_LS_M, msgs);
        const convs = chatReadLs(CHAT_LS_C); const c = convs.find((x) => x.id === convId); if (c) { c.last_message_at = now(); chatWriteLs(CHAT_LS_C, convs); }
        chatPing();
        // Demo only (local fallback): simulate teammates opening the chat a moment
        // later so the delivered (grey ✓✓) → read (blue ✓✓) transition is visible.
        // Skipped when two tabs are acting as two real identities (then the other
        // tab's actual markRead drives the read receipt). Real Supabase never runs this.
        try {
         if (!chatMultiUser())
          setTimeout(() => {
            try {
              const cv = chatReadLs(CHAT_LS_C); const cc = cv.find((x) => x.id === convId); if (!cc) return;
              cc.members = cc.members || [];
              const peers = (cc.kind === "broadcast") ? CHAT_LOCAL_ROSTER.map((p) => p.id) : cc.members.map((x) => x.user_id);
              peers.filter((id) => id && id !== row.sender_id).forEach((id) => { let mm = cc.members.find((x) => x.user_id === id); if (!mm) { mm = { user_id: id }; cc.members.push(mm); } mm.last_read_at = now(); });
              chatWriteLs(CHAT_LS_C, cv); chatPing();
            } catch (e) {}
          }, 1200);
        } catch (e) {}
        return row;
      }
      // Only pass p_meta when there's actually an attachment. A plain message then
      // resolves against BOTH the 0016 chat_send (7-arg) and the 0017 one (8-arg),
      // so sending never breaks if attachments (0017) haven't been applied yet.
      const sendArgs = { p_conversation: convId, p_kind: m.kind || "text", p_body: m.body || null, p_media_path: m.media_path || null, p_media_mime: m.media_mime || null, p_media_duration: m.media_duration || null, p_reply_to: m.reply_to || null };
      if (m.meta) sendArgs.p_meta = m.meta;
      return rpc("chat_send", sendArgs);
    },
    // Edit the text of my own message. RLS (chat_msg_upd: sender_id = auth.uid())
    // enforces "mine only" on the server; the local tier checks sender_id too.
    async editMessage(messageId, body) {
      if (mode !== "supabase") {
        const msgs = chatReadLs(CHAT_LS_M); const me = chatLocalUid(); const m = msgs.find((x) => x.id === messageId);
        if (m && m.sender_id === me) { m.body = body; m.edited_at = now(); chatWriteLs(CHAT_LS_M, msgs); chatPing(); }
        return;
      }
      const { error } = await supa.from("chat_messages").update({ body: body, edited_at: new Date().toISOString() }).eq("id", messageId);
      if (error) throw error;
    },
    // Soft-delete my own message (kept as a tombstone; content cleared).
    async deleteMessage(messageId) {
      if (mode !== "supabase") {
        const msgs = chatReadLs(CHAT_LS_M); const me = chatLocalUid(); const m = msgs.find((x) => x.id === messageId);
        if (m && m.sender_id === me) { m.deleted = true; m.body = null; m.media_path = null; m.meta = null; chatWriteLs(CHAT_LS_M, msgs); chatPing(); }
        return;
      }
      const { error } = await supa.from("chat_messages").update({ deleted: true, body: null, media_path: null, meta: null }).eq("id", messageId);
      if (error) throw error;
    },
    async react(messageId, emoji, on) {
      if (mode !== "supabase") {
        let rs = chatReadLs(CHAT_LS_R); const me = chatLocalUid();
        rs = rs.filter((r) => !(r.message_id === messageId && r.user_id === me && r.emoji === emoji));
        if (on !== false) rs.push({ message_id: messageId, user_id: me, emoji, created_at: now() });
        chatWriteLs(CHAT_LS_R, rs); chatPing(); return;
      }
      return rpc("chat_react", { p_message: messageId, p_emoji: emoji, p_on: on !== false });
    },
    async markRead(convId) {
      if (mode !== "supabase") { const convs = chatReadLs(CHAT_LS_C); const c = convs.find((x) => x.id === convId); const me = chatLocalUid(); if (c) { c.members = c.members || []; let m = c.members.find((x) => x.user_id === me); if (!m) { m = { user_id: me }; c.members.push(m); } m.last_read_at = now(); chatWriteLs(CHAT_LS_C, convs); } return; }
      try { return await rpc("chat_mark_read", { p_conversation: convId }); } catch (e) {}
    },
    // Unread messages FROM OTHERS in MY conversations, one row per conversation
    // (latest first), for the notification bell. RLS scopes every read to the
    // conversations I belong to, so this can never leak another team's or another
    // DM's messages. Muted conversations are skipped.
    async notifications(limit) {
      const muted = chatReadMuted(); const cap = limit || 20;
      if (mode !== "supabase") {
        const me = chatLocalUid(); const convs = chatReadLs(CHAT_LS_C); const msgs = chatReadLs(CHAT_LS_M);
        const nameFor = (id) => { const u = CHAT_LOCAL_ROSTER.find((x) => x.id === id); return u ? u.full_name : "Member"; };
        const out = [];
        convs.forEach((c) => {
          if (muted.has(c.id)) return;
          const mem = (c.members || []).find((x) => x.user_id === me); const lr = mem && mem.last_read_at;
          const unread = msgs.filter((m) => m.conversation_id === c.id && m.sender_id !== me && !m.deleted && (!lr || String(m.created_at) > String(lr)));
          if (!unread.length) return;
          const last = unread[unread.length - 1];
          let title; if (c.kind === "broadcast") title = c.title || "Everyone"; else if (c.kind === "group") title = c.title || "Group";
          else { const ids = (c.dm_key || "").split(":"); const o = ids[0] === me ? ids[1] : ids[0]; title = nameFor(o); }
          out.push({ conversation_id: c.id, kind: c.kind, title, who: nameFor(last.sender_id), preview: chatPreviewText(last), created_at: last.created_at, count: unread.length });
        });
        out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        try { chatMergeMentions(out, await this.mentionsForMe(cap)); } catch (e) {}   // @mentions: even when muted
        return out.slice(0, cap);
      }
      const me = currentUser && currentUser.id; if (!me || chatBackendMissing) return [];
      let convs = [], mem = {}, roster = [];
      try { [convs, mem, roster] = await Promise.all([this.conversations(), this.myMemberships(), this.roster()]); }
      catch (e) {
        // chat SQL not installed on this project: stop the bell re-asking every poll (404 noise)
        const U = global.BPUI; if (U && ((U.isMissingTable && U.isMissingTable(e)) || (U.isMissingFunction && U.isMissingFunction(e)))) chatBackendMissing = true;
        return [];
      }
      const nameById = {}; roster.forEach((p) => { nameById[p.id] = personDisplayName(p); });
      const convById = {}; convs.forEach((c) => { convById[c.id] = c; });
      let msgs = [];
      try { const { data, error } = await supa.from("chat_messages").select("id,conversation_id,sender_id,kind,body,meta,created_at").neq("sender_id", me).eq("deleted", false).order("created_at", { ascending: false }).limit(60); if (error) return []; msgs = data || []; } catch (e) { return []; }
      const seen = {}, out = [];
      msgs.forEach((m) => {
        const c = convById[m.conversation_id]; if (!c || muted.has(c.id)) return;
        const lr = mem[m.conversation_id] && mem[m.conversation_id].last_read_at;
        if (lr && String(m.created_at) <= String(lr)) return;
        if (seen[m.conversation_id]) { seen[m.conversation_id].count++; return; }
        let title; if (c.kind === "broadcast") title = c.title || "Everyone"; else if (c.kind === "group") title = c.title || "Group";
        else { const ids = (c.dm_key || "").split(":"); const o = ids[0] === me ? ids[1] : ids[0]; title = nameById[o] || "Direct message"; }
        const item = { conversation_id: m.conversation_id, kind: c.kind, title, who: nameById[m.sender_id] || "Member", preview: chatPreviewText(m), created_at: m.created_at, count: 1 };
        seen[m.conversation_id] = item; out.push(item);
      });
      try { chatMergeMentions(out, await this.mentionsForMe(cap, nameById)); } catch (e) {}   // @mentions: even when muted
      return out.slice(0, cap);
    },
    // My unread @mentions (0035 chat_my_mentions; the server checks I'm still in that
    // conversation), newest first: [{ id, conversation_id, conv_kind, title, who, preview, created_at }].
    async mentionsForMe(limit, nameById) {
      const cap = limit || 20;
      if (mode !== "supabase") {
        const me = chatLocalUid(); const convs = chatReadLs(CHAT_LS_C);
        const nameFor = (id) => { const u = CHAT_LOCAL_ROSTER.find((x) => x.id === id); return u ? u.full_name : "Member"; };
        const out = [];
        chatReadLs(CHAT_LS_M).forEach((m) => {
          if (m.deleted || m.sender_id === me || !(m.meta && Array.isArray(m.meta.mentions) && m.meta.mentions.indexOf(me) >= 0)) return;
          const c = convs.find((x) => x.id === m.conversation_id); if (!c) return;
          const mem = (c.members || []).find((x) => x.user_id === me); const lr = mem && mem.last_read_at;
          if (lr && String(m.created_at) <= String(lr)) return;
          out.push({ id: m.id, conversation_id: c.id, conv_kind: c.kind, title: chatConvTitle(c, me, nameFor), who: nameFor(m.sender_id), preview: chatPreviewText(m), created_at: m.created_at });
        });
        out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return out.slice(0, cap);
      }
      const me = currentUser && currentUser.id; if (!me || chatBackendMissing || chatMentionsMissing) return [];
      const { data, error } = await supa.rpc("chat_my_mentions", { p_limit: cap });
      if (error) { if (rpcMissing(error)) chatMentionsMissing = true; return []; }
      let names = nameById;
      if (!names) { names = {}; try { (await this.roster()).forEach((p) => { names[p.id] = personDisplayName(p); }); } catch (e) {} }
      return (data || []).map((r) => ({ id: r.id, conversation_id: r.conversation_id, conv_kind: r.conv_kind,
        title: chatConvTitle({ kind: r.conv_kind, title: r.conv_title, dm_key: r.dm_key }, me, (id) => names[id] || "Direct message"),
        who: names[r.sender_id] || "Member", preview: r.body || chatPreviewText(r), created_at: r.created_at }));
    },
    // Event groups (0035): one chat group per confirmed quote, opened with an event card the
    // SERVER builds (client contact, date, venue, guests, layout, menu, notes — never money).
    eventGroups: {
      // { [quoteId]: { conversation_id, is_member } } for my studio (quotes-view access)
      async index() {
        if (mode !== "supabase") {
          const me = chatLocalUid(); const out = {};
          chatReadLs(CHAT_LS_C).forEach((c) => { if (c.quote_id) out[c.quote_id] = { conversation_id: c.id, is_member: (c.members || []).some((m) => m.user_id === me) }; });
          return out;
        }
        const data = await rpc("event_group_index", {});
        const out = {}; (data || []).forEach((r) => { out[r.quote_id] = { conversation_id: r.conversation_id, is_member: !!r.is_member }; });
        return out;
      },
      // { [quoteId]: { event_type, title } } for event-group avatars — ONE read for all the
      // groups (not one per conversation), RLS-scoped to quotes I can already see. Fail-open:
      // no quotes access / an error → {} and the avatar falls back to the group title.
      async types(quoteIds) {
        const ids = Array.from(new Set((quoteIds || []).filter((x) => typeof x === "string" && x))).slice(0, 200);
        const out = {}; if (!ids.length) return out;
        if (mode !== "supabase") {
          for (const id of ids) { try { const q = await quotes.get(id); if (q) out[id] = { event_type: q.eventType || null, title: q.title || null }; } catch (e) {} }
          return out;
        }
        try {
          const { data, error } = await supa.from("quotes").select("id,event_type,title").in("id", ids);
          if (error) return out;
          (data || []).forEach((q) => { out[q.id] = { event_type: q.event_type || null, title: q.title || null }; });
        } catch (e) {}
        return out;
      },
      // create (or, if it already exists, return) the quote's event group → conversation id
      async create(quoteId, memberIds) {
        if (mode !== "supabase") {
          const convs = chatReadLs(CHAT_LS_C); const found = convs.find((c) => c.quote_id === quoteId); if (found) return found.id;
          const q = await quotes.get(quoteId); if (!q || q.status !== "confirmed") throw new Error("Confirm this quote before creating its event group.");
          const card = chatLocalEventCard(q);
          const name = (q.title && q.title !== "Untitled event") ? q.title : ((card.client && card.client.name) || "Event");
          const id = await chat.createGroup(String((q.code || "") + " · " + name).slice(0, 120), memberIds || []);
          const cv = chatReadLs(CHAT_LS_C); const c = cv.find((x) => x.id === id); if (c) { c.quote_id = quoteId; chatWriteLs(CHAT_LS_C, cv); }
          const msgs = chatReadLs(CHAT_LS_M);
          msgs.push({ id: uid(), conversation_id: id, org_id: "local", sender_id: null, kind: "card", body: "Event details", meta: card, created_at: now(), deleted: false });
          chatWriteLs(CHAT_LS_M, msgs); chatPing(); return id;
        }
        return rpc("create_event_group", { p_quote: quoteId, p_members: memberIds || [] });
      },
      // post an updated event card when the details changed → new message id, or null if unchanged
      async refresh(convId) {
        if (mode !== "supabase") {
          const c = chatReadLs(CHAT_LS_C).find((x) => x.id === convId); if (!c || !c.quote_id) throw new Error("This group isn't linked to an event any more.");
          const q = await quotes.get(c.quote_id); if (!q || q.status !== "confirmed") throw new Error("This event is no longer confirmed — its details can't be refreshed.");
          const card = chatLocalEventCard(q); const msgs = chatReadLs(CHAT_LS_M);
          const last = msgs.filter((m) => m.conversation_id === convId && m.sender_id == null && m.meta && m.meta.kind === "event").pop();
          const strip = (o) => { const x = Object.assign({}, o); delete x.generated_at; delete x.refreshed; return JSON.stringify(x); };
          if (last && strip(last.meta) === strip(card)) return null;
          const row = { id: uid(), conversation_id: convId, org_id: "local", sender_id: null, kind: "card", body: "Event details updated", meta: Object.assign(card, { refreshed: true }), created_at: now(), deleted: false };
          msgs.push(row); chatWriteLs(CHAT_LS_M, msgs); chatPing(); return row.id;
        }
        return rpc("refresh_event_group", { p_conversation: convId });
      },
    },
    // Realtime: call cb() on any chat change. Returns { unsubscribe() }.
    // chanName lets independent subscribers on the same page (e.g. the chat page AND
    // the notification bell) each have their own channel instead of colliding.
    subscribe(cb, onStatus, chanName) {
      if (mode !== "supabase") {
        const h = () => cb && cb();
        // addEventListener (not onmessage=) so multiple local subscribers coexist.
        try { if (chatBC) chatBC.addEventListener("message", h); } catch (e) {}
        const sh = (e) => { if (e.key === "bp_chat_ping") h(); };
        try { window.addEventListener("storage", sh); } catch (e) {}
        if (onStatus) onStatus("LOCAL");
        return { unsubscribe() { try { if (chatBC) chatBC.removeEventListener("message", h); } catch (e) {} try { window.removeEventListener("storage", sh); } catch (e) {} } };
      }
      try {
        const ch = supa.channel(chanName || "chat-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages" }, () => cb && cb())
          .on("postgres_changes", { event: "*", schema: "public", table: "chat_reactions" }, () => cb && cb())
          .on("postgres_changes", { event: "*", schema: "public", table: "chat_conversations" }, () => cb && cb())
          .subscribe((status) => { if (onStatus) onStatus(status); });
        return ch;
      } catch (e) { if (onStatus) onStatus("ERROR"); return { unsubscribe() {} }; }
    },
  };

  /* ---------------- resource needs + capability check (Phase 8) ---------------- */
  const NEED_LS = "bp_resource_needs";
  const resources = {
    async listNeeds(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_resource_needs").select("*").eq("quote_id", quoteId).order("created_at");
        if (error) throw error; return data;
      }
      return readLs(NEED_LS).filter((n) => n.quote_id === quoteId);
    },
    async addNeed(quoteId, need) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_resource_needs").insert({ quote_id: quoteId, ...need }).select().single();
        if (error) throw error; return data;
      }
      const a = readLs(NEED_LS); const row = { id: uid(), quote_id: quoteId, status: "open", ...need, created_at: now() };
      a.push(row); localStorage.setItem(NEED_LS, JSON.stringify(a)); return row;
    },
    async updateNeed(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("event_resource_needs").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(NEED_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(NEED_LS, JSON.stringify(a)); } return true;
    },
    async removeNeed(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_resource_needs").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(NEED_LS, JSON.stringify(readLs(NEED_LS).filter((n) => n.id !== id))); return true;
    },
    // Capability check: for each need, work out in-house coverage and the gap.
    // staff need  -> counts active staff whose skills/role match `skill`
    // inventory need -> uses inventory availability for item_id
    // other       -> always a gap (must be outsourced)
    async check(quoteId) {
      const [needs, team, avail] = await Promise.all([
        this.listNeeds(quoteId), staff.list(false), inventory.availability(),
      ]);
      const matchStaff = (sk) => {
        const k = String(sk || "").trim().toLowerCase(); if (!k) return 0;
        return team.filter((p) => {
          const skills = (Array.isArray(p.skills) ? p.skills : []).map((s) => String(s).toLowerCase());
          return skills.includes(k) || String(p.role || "").toLowerCase().includes(k) || String(p.department || "").toLowerCase() === k;
        }).length;
      };
      return needs.map((n) => {
        const qty = Number(n.qty || 0); let have = 0, unit = "", detail = "";
        if (n.kind === "staff") { have = matchStaff(n.skill); unit = "people"; detail = n.skill || ""; }
        else if (n.kind === "inventory") { const a = avail[n.item_id]; have = a ? a.available : 0; unit = a ? (a.unit || "") : ""; detail = a ? a.name : "(item removed)"; }
        else { have = 0; unit = ""; detail = "external"; }
        const outsourced = n.status === "outsourced";
        const covered = outsourced || have >= qty;
        const gap = outsourced ? 0 : Math.max(0, qty - have);
        return { ...n, have, unit, detail, covered, gap, outsourced };
      });
    },
  };

  /* ---------------- external bookings: vendors/freelancers/rentals (Phase 9) ---------------- */
  const BOOK_LS = "bp_bookings";
  const bookings = {
    async list(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_resources").select("*").eq("quote_id", quoteId).order("created_at");
        if (error) throw error; return data;
      }
      return readLs(BOOK_LS).filter((b) => b.quote_id === quoteId);
    },
    async listAll() {
      if (mode === "supabase") { const { data, error } = await supa.from("event_resources").select("*"); if (error) throw error; return data; }
      return readLs(BOOK_LS);
    },
    // event history for a page of partners: just vendor / event / status of their bookings
    async forVendors(vendorIds) {
      const ids = [...new Set((vendorIds || []).filter(Boolean))]; if (!ids.length) return [];
      if (mode === "supabase") { const { data, error } = await supa.from("event_resources").select("vendor_id,quote_id,status").in("vendor_id", ids); if (error) throw error; return data || []; }
      return readLs(BOOK_LS).filter((b) => ids.indexOf(b.vendor_id) !== -1);
    },
    async add(quoteId, b) {
      let row;
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_resources").insert({ quote_id: quoteId, ...b }).select().single();
        if (error) throw error; row = data;
      } else {
        const a = readLs(BOOK_LS); row = { id: uid(), quote_id: quoteId, status: "enquiry", contract: false, ...b, created_at: now() };
        a.push(row); localStorage.setItem(BOOK_LS, JSON.stringify(a));
      }
      // close the loop: if this covers a flagged need, mark that need outsourced
      if (b.need_id) { try { await resources.updateNeed(b.need_id, { status: "outsourced" }); }
        catch (e) { console.warn("booking saved, but couldn't mark the resource need outsourced:", (e && e.message) || e); } }
      return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("event_resources").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(BOOK_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(BOOK_LS, JSON.stringify(a)); } return true;
    },
    setSettled(id, settled) { return this.update(id, { settled: !!settled, settled_at: settled ? now() : null }); },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_resources").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(BOOK_LS, JSON.stringify(readLs(BOOK_LS).filter((b) => b.id !== id))); return true;
    },
  };

  /* ---------------- unified resource calendar + conflicts (Phase 10) ---------------- */
  const calendar = {
    // Pull every commitment across all events and detect date clashes.
    async load() {
      const [events, invRes, vendorBk, items, team, vends, tasks, plans, pricingCfg] = await Promise.all([
        quotes.list(),
        inventory.reservations().catch(() => []),
        bookings.listAll().catch(() => []),
        inventory.items(true).catch(() => []),
        staff.list(true).catch(() => []),
        vendors.listAll(true).catch(() => []),
        (async () => {
          if (mode !== "supabase") return readLs("bp_tasks_stub") || [];
          const { data, error } = await supa.from("event_tasks").select("quote_id,crew_id,title").not("crew_id", "is", null);
          if (error) throw error; return data;
        })().catch(() => []),
        (async () => {
          // venue name/address per event (for the venue-double-booking check)
          if (mode !== "supabase") return [];
          const { data, error } = await supa.from("event_plan").select("quote_id,venue_name,venue_address");
          if (error) throw error; return data;
        })().catch(() => []),
        config.getPricing().catch(() => ({})),   // for the venue-clash buffer (parallel, no extra round-trip)
      ]);
      const evById = {}; events.forEach((e) => { evById[e.id] = e; });
      const itemById = {}; items.forEach((i) => { itemById[i.id] = i; });
      const staffById = {}; team.forEach((p) => { staffById[p.id] = p; });
      const vendById = {}; vends.forEach((v) => { vendById[v.id] = v; });
      const planByQuote = {}; (plans || []).forEach((p) => { planByQuote[p.quote_id] = p; });
      const dateOf = (qid) => { const e = evById[qid]; return e ? e.eventDate : null; };
      // venue name/address for an event: canonical event_plan first, then the mirror on the quote's client
      const venueOf = (e) => {
        const pl = planByQuote[e.id] || {};
        return {
          name: pl.venue_name || (e.client && e.client.venue) || "",
          address: pl.venue_address || (e.client && e.client.address) || "",
        };
      };

      // ---- conflict detection (only for events that have a date) ----
      const conflicts = [];
      // 1) inventory over-commit per item per date
      const invByItemDate = {};
      invRes.forEach((r) => {
        if (!["reserved", "allocated"].includes(r.status)) return;
        const d = dateOf(r.quote_id); if (!d) return;
        const k = r.item_id + "|" + d; (invByItemDate[k] = invByItemDate[k] || []).push(r);
      });
      Object.entries(invByItemDate).forEach(([k, list]) => {
        const [itemId, d] = k.split("|"); const item = itemById[itemId]; if (!item) return;
        const sum = list.reduce((a, r) => a + Number(r.qty || 0), 0);
        if (sum > Number(item.total_qty || 0)) conflicts.push({ type: "inventory", date: d,
          label: item.name, detail: `${sum} committed of ${item.total_qty} ${item.unit || ""} across ${new Set(list.map((r) => r.quote_id)).size} events`,
          events: [...new Set(list.map((r) => r.quote_id))].map((q) => evById[q]) });
      });
      // 2) vendor double-booked on a date
      const vByVendorDate = {};
      vendorBk.forEach((b) => {
        if (b.status === "cancelled" || !b.vendor_id) return;
        const d = dateOf(b.quote_id); if (!d) return;
        const k = b.vendor_id + "|" + d; (vByVendorDate[k] = vByVendorDate[k] || new Set()).add(b.quote_id);
      });
      Object.entries(vByVendorDate).forEach(([k, qset]) => {
        const [vid, d] = k.split("|"); if (qset.size > 1) { const v = vendById[vid];
          conflicts.push({ type: "vendor", date: d, label: v ? v.name : "Partner",
            detail: `booked for ${qset.size} events on this date`, events: [...qset].map((q) => evById[q]) }); }
      });
      // 3) staff double-booked on a date
      const sByStaffDate = {};
      tasks.forEach((t) => {
        if (!t.crew_id) return; const d = dateOf(t.quote_id); if (!d) return;
        const k = t.crew_id + "|" + d; (sByStaffDate[k] = sByStaffDate[k] || new Set()).add(t.quote_id);
      });
      Object.entries(sByStaffDate).forEach(([k, qset]) => {
        const [sid, d] = k.split("|"); if (qset.size > 1) { const p = staffById[sid];
          conflicts.push({ type: "staff", date: d, label: p ? p.name : "Staff",
            detail: `assigned to ${qset.size} events on this date`, events: [...qset].map((q) => evById[q]) }); }
      });
      // 4) venue double-booking: two DIFFERENT events sharing the SAME date + time + venue name + venue address.
      //    All four must be present and equal — a match on fewer fields is NOT a conflict.
      //    A venue can host back-to-back events if there's enough of a gap between their
      //    start times (e.g. one at 3pm, the next at 6pm). So we only flag a clash when two
      //    different events at the SAME venue on the SAME day start CLOSER together than the
      //    buffer. The buffer (hours) is set in Control Center → Pricing (conflictBufferHours,
      //    default 3). If an event has no start time we can't measure the gap, so we flag it
      //    to review rather than silently miss it. Venue identity matches on name, or address
      //    when the name is blank (no longer requires BOTH to be filled).
      let bufferHours = 3;
      { const _b = Number(pricingCfg && pricingCfg.conflictBufferHours); if (isFinite(_b) && _b >= 0) bufferHours = _b; }
      const bufferMin = bufferHours * 60;
      const vnorm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
      const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? (+m[1] * 60 + +m[2]) : null; };
      const byVenueDay = {};
      events.forEach((e) => {
        const d = e.eventDate; const v = venueOf(e);
        const vkey = vnorm(v.name) || vnorm(v.address);     // name preferred, address as fallback
        if (!d || !vkey) return;                             // need a date + some venue identity
        const k = d + "||" + vkey;
        (byVenueDay[k] = byVenueDay[k] || []).push(e);
      });
      Object.values(byVenueDay).forEach((list) => {
        const uniq = [...new Map(list.map((e) => [e.id, e])).values()];
        if (uniq.length < 2) return;
        const clashing = new Set(); let hasTimeClash = false, hasNoTime = false;
        for (let i = 0; i < uniq.length; i++) {
          for (let j = i + 1; j < uniq.length; j++) {
            const ti = toMin(uniq[i].eventTime), tj = toMin(uniq[j].eventTime);
            if (ti == null || tj == null) { hasNoTime = true; clashing.add(uniq[i].id); clashing.add(uniq[j].id); }
            else if (Math.abs(ti - tj) < bufferMin) { hasTimeClash = true; clashing.add(uniq[i].id); clashing.add(uniq[j].id); }
          }
        }
        if (clashing.size < 2) return;
        const ev = uniq.filter((e) => clashing.has(e.id));
        const v = venueOf(ev[0]); const vname = v.name || v.address || "Venue";
        conflicts.push({ type: "venue", date: ev[0].eventDate, label: vname,
          detail: hasTimeClash
            ? `${ev.length} events at ${vname} on ${ev[0].eventDate} within ${bufferHours}h of each other`
            : `${ev.length} events at ${vname} on ${ev[0].eventDate} — set start times to check the ${bufferHours}h gap`,
          events: ev });
      });

      // ---- per-event commitment rollup (for the agenda) ----
      const agenda = events.map((e) => {
        const inv = invRes.filter((r) => r.quote_id === e.id && ["reserved", "allocated"].includes(r.status));
        const vend = vendorBk.filter((b) => b.quote_id === e.id && b.status !== "cancelled");
        const crew = [...new Set(tasks.filter((t) => t.quote_id === e.id).map((t) => t.crew_id))];
        return { event: e, invCount: inv.length, vendCount: vend.length, staffCount: crew.length,
          items: inv.map((r) => ({ name: (itemById[r.item_id] || {}).name || "item", qty: r.qty })),
          vendorsList: vend.map((b) => (vendById[b.vendor_id] || {}).name || b.label),
          staffList: crew.map((c) => (staffById[c] || {}).name || "crew") };
      });
      return { agenda, conflicts, counts: { events: events.length, dated: events.filter((e) => e.eventDate).length } };
    },
    // Phase 49 — the conflicts that involve one specific event (for the workspace card)
    async conflictsForEvent(quoteId) {
      const { conflicts } = await this.load();
      return conflicts.filter((c) => (c.events || []).some((e) => e && e.id === quoteId));
    },
    // Phase 49 — predictive pre-commit check: would assigning this crew / vendor on this
    // event's date collide with another event on the same day? (light, targeted queries)
    async wouldClash({ date, crewId, vendorId, excludeQuote } = {}) {
      if (!date || mode !== "supabase" || !supa) return { clash: false };
      const events = await quotes.list();
      const sameDay = events.filter((e) => e.eventDate === date && e.id !== excludeQuote);
      if (!sameDay.length) return { clash: false };
      const ids = sameDay.map((e) => e.id); const byId = {}; sameDay.forEach((e) => (byId[e.id] = e));
      if (crewId) {
        const { data } = await supa.from("event_tasks").select("quote_id").eq("crew_id", crewId).in("quote_id", ids).limit(1);
        if (data && data.length) { const e = byId[data[0].quote_id];
          return { clash: true, type: "staff", detail: `already assigned on ${date} to ${e ? e.code : "another event"}` }; }
      }
      if (vendorId) {
        const { data } = await supa.from("event_resources").select("quote_id,status").eq("vendor_id", vendorId).in("quote_id", ids).neq("status", "cancelled").limit(1);
        if (data && data.length) { const e = byId[data[0].quote_id];
          return { clash: true, type: "vendor", detail: `already booked on ${date} for ${e ? e.code : "another event"}` }; }
      }
      return { clash: false };
    },
  };

  /* ---------------- run-sheet: timed event-day schedule (Phase 11) ---------------- */
  const RUN_LS = "bp_runsheet";
  const runsheet = {
    async list(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("run_sheet_items").select("*").eq("quote_id", quoteId).order("start_time").order("seq");
        if (error) throw error; return data;
      }
      return readLs(RUN_LS).filter((r) => r.quote_id === quoteId)
        .sort((a, b) => String(a.start_time || "").localeCompare(String(b.start_time || "")) || (a.seq || 0) - (b.seq || 0));
    },
    async add(quoteId, item) {
      if (mode === "supabase") { const { data, error } = await supa.from("run_sheet_items").insert({ quote_id: quoteId, ...item }).select().single(); if (error) throw error; return data; }
      const a = readLs(RUN_LS); const row = { id: uid(), quote_id: quoteId, seq: 0, ...item, created_at: now() }; a.push(row); localStorage.setItem(RUN_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("run_sheet_items").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(RUN_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(RUN_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("run_sheet_items").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(RUN_LS, JSON.stringify(readLs(RUN_LS).filter((r) => r.id !== id))); return true;
    },
  };

  /* ---------------- budget vs actuals + change orders (Phase 12) ---------------- */
  const COST_LS = "bp_costs", CHG_LS = "bp_changes";
  const budget = {
    async listCosts(quoteId) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_costs").select("*").eq("quote_id", quoteId).order("created_at"); if (error) throw error; return data; }
      return readLs(COST_LS).filter((c) => c.quote_id === quoteId);
    },
    async addCost(quoteId, c) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_costs").insert({ quote_id: quoteId, ...c }).select().single(); if (error) throw error; return data; }
      const a = readLs(COST_LS); const row = { id: uid(), quote_id: quoteId, estimated: 0, kind: "internal", ...c, created_at: now() }; a.push(row); localStorage.setItem(COST_LS, JSON.stringify(a)); return row;
    },
    async updateCost(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("event_costs").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(COST_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(COST_LS, JSON.stringify(a)); } return true;
    },
    async removeCost(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_costs").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(COST_LS, JSON.stringify(readLs(COST_LS).filter((c) => c.id !== id))); return true;
    },
    // pull vendor bookings (event_resources) in as vendor cost lines (skips ones already imported)
    async importVendorCosts(quoteId) {
      const [bk, costs] = await Promise.all([bookings.list(quoteId), this.listCosts(quoteId)]);
      const have = new Set(costs.map((c) => c.booking_id).filter(Boolean));
      let added = 0;
      for (const b of bk) {
        if (b.status === "cancelled" || have.has(b.id) || b.cost == null) continue;
        await this.addCost(quoteId, { category: "Vendor", description: b.label || "Vendor booking", kind: "vendor",
          estimated: Number(b.cost || 0), actual: null, booking_id: b.id }); added++;
      }
      return added;
    },
    async listChanges(quoteId) {
      if (mode === "supabase") { const { data, error } = await supa.from("change_requests").select("*").eq("quote_id", quoteId).order("created_at"); if (error) throw error; return data; }
      return readLs(CHG_LS).filter((c) => c.quote_id === quoteId);
    },
    async addChange(quoteId, c) {
      if (mode === "supabase") { const { data, error } = await supa.from("change_requests").insert({ quote_id: quoteId, ...c }).select().single(); if (error) throw error; return data; }
      const a = readLs(CHG_LS); const row = { id: uid(), quote_id: quoteId, status: "requested", price_delta: 0, cost_delta: 0, ...c, created_at: now() }; a.push(row); localStorage.setItem(CHG_LS, JSON.stringify(a)); return row;
    },
    async setChangeStatus(id, status) {
      const patch = { status, decided_at: (status === "requested" ? null : now()) };
      if (mode === "supabase") { const { error } = await supa.from("change_requests").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(CHG_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(CHG_LS, JSON.stringify(a)); } return true;
    },
    async removeChange(id) {
      if (mode === "supabase") { const { error } = await supa.from("change_requests").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(CHG_LS, JSON.stringify(readLs(CHG_LS).filter((c) => c.id !== id))); return true;
    },
    // revenue / cost / margin rollup (quote total + approved change price deltas)
    async summary(quoteId) {
      const [ev, costs, changes, bk] = await Promise.all([quotes.get(quoteId), this.listCosts(quoteId), this.listChanges(quoteId), bookings.list(quoteId).catch(() => [])]);
      const baseRevenue = (ev && (ev.total != null ? ev.total : (ev.pricing && ev.pricing.total))) || 0;
      const approved = changes.filter((c) => c.status === "approved");
      const changeRevenue = approved.reduce((a, c) => a + Number(c.price_delta || 0), 0);
      const changeCost = approved.reduce((a, c) => a + Number(c.cost_delta || 0), 0);
      // vendor bookings not yet imported as cost lines — so vendor spend is never silently missing from cost
      const importedBk = new Set(costs.map((c) => c.booking_id).filter(Boolean));
      const vendorExtra = (bk || []).filter((b) => b.status !== "cancelled" && !importedBk.has(b.id) && b.cost != null)
        .reduce((a, b) => a + Number(b.cost || 0), 0);
      const lineEst = costs.reduce((a, c) => a + Number(c.estimated || 0), 0);
      const lineActuals = costs.reduce((a, c) => a + (c.actual != null ? Number(c.actual) : 0), 0);
      // best-known per line: use the actual where entered, otherwise fall back to that line's estimate
      const lineBlend = costs.reduce((a, c) => a + (c.actual != null ? Number(c.actual) : Number(c.estimated || 0)), 0);
      const estCost = lineEst + changeCost + vendorExtra;             // full estimated cost to deliver
      const actCost = lineActuals;                                    // real money spent so far (entered actuals)
      const finalCost = lineBlend + changeCost + vendorExtra;         // best-known total cost (actuals where entered, else estimate)
      const revenue = Number(baseRevenue) + changeRevenue;
      const estMargin = revenue - estCost, actMargin = revenue - actCost, finalMargin = revenue - finalCost;
      return { revenue, baseRevenue, changeRevenue, estCost, actCost, finalCost, changeCost, vendorExtra,
        estMargin, actMargin, finalMargin,
        estMarginPct: revenue ? Math.round(estMargin / revenue * 100) : null,
        finalMarginPct: revenue ? Math.round(finalMargin / revenue * 100) : null,
        costs, changes, pendingChanges: changes.filter((c) => c.status === "requested").length };
    },
  };

  /* ---------------- venue + menu/package plan (Phase 13) ---------------- */
  const PLAN_LS = "bp_plan";
  const plan = {
    async get(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_plan").select("*").eq("quote_id", quoteId).maybeSingle();
        if (error) throw error; return data || null;
      }
      return readLs(PLAN_LS).find((p) => p.quote_id === quoteId) || null;
    },
    async save(quoteId, p) {
      if (mode === "supabase") {
        return rpc("set_event_plan", { p_quote_id: quoteId, p_venue_name: p.venue_name || null, p_venue_address: p.venue_address || null,
          p_venue_contact: p.venue_contact || null, p_access_notes: p.access_notes || null, p_package: p.package || null, p_menu: p.menu || null });
      }
      const a = readLs(PLAN_LS).filter((x) => x.quote_id !== quoteId);
      const cur = readLs(PLAN_LS).find((x) => x.quote_id === quoteId) || {};
      // Merge onto the existing row so a venue/menu-notes save can't wipe a previously
      // applied package (menu_template / menu_plate_price) or other prior fields.
      const row = { ...cur, quote_id: quoteId, menu_locked: cur.menu_locked || false, ...p, updated_at: now() };
      a.push(row); localStorage.setItem(PLAN_LS, JSON.stringify(a)); return row;
    },
    async setLock(quoteId, locked) {
      if (mode === "supabase") return rpc("set_plan_lock", { p_quote_id: quoteId, p_locked: !!locked });
      const a = readLs(PLAN_LS); let row = a.find((x) => x.quote_id === quoteId);
      if (!row) { row = { quote_id: quoteId }; a.push(row); }
      row.menu_locked = !!locked; row.locked_at = locked ? now() : null; localStorage.setItem(PLAN_LS, JSON.stringify(a)); return row;
    },
    async setSignoff(quoteId, field, done) {
      if (mode === "supabase") return rpc("set_plan_signoff", { p_quote_id: quoteId, p_field: field, p_done: !!done });
      const a = readLs(PLAN_LS); let row = a.find((x) => x.quote_id === quoteId);
      if (!row) { row = { quote_id: quoteId }; a.push(row); }
      const k = field === "dry_run" ? "dry_run_at" : "briefing_at"; row[k] = done ? now() : null;
      localStorage.setItem(PLAN_LS, JSON.stringify(a)); return row;
    },
  };

  /* ---------------- logistics / compliance / comms / guests + payments (Phase 14) ---------------- */
  const CHK_LS = "bp_checklist", MILE_LS = "bp_milestones";
  const checklist = {
    async list(quoteId, section) {
      if (mode === "supabase") {
        let q = supa.from("event_checklist").select("*").eq("quote_id", quoteId);
        if (section) q = q.eq("section", section);
        const { data, error } = await q.order("seq").order("created_at"); if (error) throw error; return data;
      }
      return readLs(CHK_LS).filter((c) => c.quote_id === quoteId && (!section || c.section === section));
    },
    async add(quoteId, item) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_checklist").insert({ quote_id: quoteId, ...item }).select().single(); if (error) throw error; return data; }
      const a = readLs(CHK_LS); const row = { id: uid(), quote_id: quoteId, status: "open", ...item, created_at: now() }; a.push(row); localStorage.setItem(CHK_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("event_checklist").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(CHK_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(CHK_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_checklist").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(CHK_LS, JSON.stringify(readLs(CHK_LS).filter((c) => c.id !== id))); return true;
    },
  };
  /* ---------------- reusable checklist templates (Phase 26, spec step 92) ---------------- */
  const TPL_LS = "bp_tpl";
  const templates = {
    async list(section) {
      if (mode === "supabase") {
        let q = supa.from("checklist_templates").select("*").order("section").order("name");
        if (section) q = q.eq("section", section);
        const { data, error } = await q; if (error) throw error; return data;
      }
      return readLs(TPL_LS).filter((t) => !section || t.section === section);
    },
    async add(t) {
      if (mode === "supabase") { const { data, error } = await supa.from("checklist_templates").insert(t).select().single(); if (error) throw error; return data; }
      const a = readLs(TPL_LS); const row = { id: uid(), section: "logistics", items: [], ...t, created_at: now() }; a.push(row); localStorage.setItem(TPL_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("checklist_templates").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(TPL_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(TPL_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("checklist_templates").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(TPL_LS, JSON.stringify(readLs(TPL_LS).filter((t) => t.id !== id))); return true;
    },
    // apply a template's items into an event's checklist (its section). returns how many were added.
    async applyTo(quoteId, templateId) {
      const all = await this.list(); const t = (all || []).find((x) => x.id === templateId);
      if (!t) throw new Error("template not found");
      const items = Array.isArray(t.items) ? t.items : [];
      // Idempotent apply: skip titles already on this event's checklist SECTION, so
      // re-applying a template (or applying one twice) doesn't duplicate every item.
      const have = new Set();
      try { const cur = await checklist.list(quoteId, t.section); (cur || []).forEach((c) => { if (c && c.title) have.add(String(c.title).trim().toLowerCase()); }); } catch (e) {}
      let added = 0;
      for (const it of items) { const title = typeof it === "string" ? it : (it && it.title); if (!title) continue;
        const key = String(title).trim().toLowerCase(); if (have.has(key)) continue;
        await checklist.add(quoteId, { section: t.section, title }); have.add(key); added++; }
      return added;
    },
  };
  const milestones = {
    async list(quoteId) {
      if (mode === "supabase") { const { data, error } = await supa.from("payment_milestones").select("*").eq("quote_id", quoteId).order("due_date").order("seq"); if (error) throw error; return data; }
      return readLs(MILE_LS).filter((m) => m.quote_id === quoteId).sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")));
    },
    async add(quoteId, m) {
      if (mode === "supabase") { const { data, error } = await supa.from("payment_milestones").insert({ quote_id: quoteId, ...m }).select().single(); if (error) throw error; return data; }
      const a = readLs(MILE_LS); const row = { id: uid(), quote_id: quoteId, status: "due", amount: 0, ...m, created_at: now() }; a.push(row); localStorage.setItem(MILE_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("payment_milestones").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(MILE_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(MILE_LS, JSON.stringify(a)); } return true;
    },
    // Audit Phase 8: "paid" is a money event — in Supabase mode it goes through
    // settle_milestone (receipt in the ledger + overpayment lock); the DB refuses a
    // direct paid write. Other statuses (due / invoiced / waived) stay plain edits.
    async setStatus(id, status) {
      if (status === "paid" && mode === "supabase") return this.settle(id);
      return this.update(id, { status, paid_at: status === "paid" ? now() : null });
    },
    settle: (id, method, idempotencyKey) =>
      rpc("settle_milestone", { p_milestone: id, p_method: method || "cash",
        p_idempotency_key: idempotencyKey || ((typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "ms-" + id + "-" + Date.now()) }),
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("payment_milestones").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(MILE_LS, JSON.stringify(readLs(MILE_LS).filter((m) => m.id !== id))); return true;
    },
    // reminder via the existing notification outbox (simulated unless channels are live)
    sendReminder: (quoteId, to, detail) => (mode === "supabase"
      ? rpc("mgr_notify", { p_quote_id: quoteId, p_channel: "sms", p_to: to, p_kind: "payment_reminder", p_detail: detail || {} })
      : Promise.resolve({ sent: true, simulated: true })),
    // record an advance/stage payment (online link or offline cash) → issues a
    // receipt, marks the milestone paid, confirms the booking, notifies both sides
    // W15B/CF (record_payment idempotency): callers pass a STABLE per-submission
    // idempotencyKey so a retry/replay of the same submission dedups server-side
    // (phase90 record_payment reuses the existing receipt for a repeated key).
    record: (quoteId, amount, method, receiptNo, milestoneId, note, idempotencyKey) =>
      rpc("record_payment", { p_quote: quoteId, p_amount: Number(amount) || 0, p_method: method || "cash",
        p_receipt_no: receiptNo || null, p_milestone: milestoneId || null, p_note: note || null,
        p_idempotency_key: idempotencyKey || null }),
    // B5 — settlement (post-event balance): same idempotency + server receipt + overpayment
    // cap as record_payment, but WITHOUT the booking-confirm status flip or "booking confirmed"
    // notifications (settlement isn't a booking event). Server: record_settlement_payment.
    recordSettlement: (quoteId, amount, method, receiptNo, milestoneId, note, idempotencyKey) =>
      rpc("record_settlement_payment", { p_quote: quoteId, p_amount: Number(amount) || 0, p_method: method || "cash",
        p_receipt_no: receiptNo || null, p_milestone: milestoneId || null, p_note: note || null,
        p_idempotency_key: idempotencyKey || null }),
    // list logged payments (receipts) for an event
    async payments(quoteId) {
      if (mode !== "supabase") return [];
      const { data, error } = await supa.from("quote_payments").select("*").eq("quote_id", quoteId).order("created_at", { ascending: false });
      if (error) throw error; return data;
    },
    // consolidated activity trail (versions, payments, receipts, consents, notifications)
    activity: (quoteId) => (mode === "supabase" ? rpc("event_activity", { p_quote: quoteId }) : Promise.resolve([])),
  };

  /* ---------------- readiness gate: Event Ready checkpoint (Phase 15) ---------------- */
  const readiness = {
    async check(quoteId) {
      const [ev, planRow, resCheck, bk, tasks, ms, rs] = await Promise.all([
        quotes.get(quoteId),
        plan.get(quoteId).catch(() => null),
        resources.check(quoteId).catch(() => []),
        bookings.list(quoteId).catch(() => []),
        (async () => { if (mode !== "supabase") return [];
          const { data, error } = await supa.from("event_tasks").select("crew_id").eq("quote_id", quoteId).not("crew_id", "is", null);
          if (error) throw error; return data; })().catch(() => []),
        milestones.list(quoteId).catch(() => []),
        runsheet.list(quoteId).catch(() => []),
      ]);
      const gaps = resCheck.filter((c) => !c.covered).length;
      const enquiry = bk.filter((b) => b.status === "enquiry").length;
      const crew = new Set(tasks.map((t) => t.crew_id)).size;
      const paid = ms.some((m) => m.status === "paid");
      const checks = [
        { key: "date", label: "Event date set", critical: true, ok: !!ev.eventDate, detail: ev.eventDate || "not set" },
        { key: "approval", label: "Client approved", critical: true, ok: ["approved", "paid"].includes(ev.approvalStatus), detail: ev.approvalStatus || "none" },
        { key: "menu", label: "Menu & package locked", critical: true, ok: !!(planRow && planRow.menu_locked), detail: (planRow && planRow.menu_locked) ? "locked" : "not locked" },
        { key: "resources", label: "Resources covered (no gaps)", critical: true, ok: resCheck.length > 0 && gaps === 0, detail: resCheck.length === 0 ? "no needs mapped yet" : (gaps ? (gaps + " gap" + (gaps === 1 ? "" : "s")) : "all covered") },
        { key: "vendors", label: "Vendors confirmed", critical: true, ok: enquiry === 0 && (bk.length > 0 || resCheck.length > 0), detail: enquiry ? (enquiry + " still enquiry") : (bk.length ? "all confirmed" : (resCheck.length ? "in-house — none needed" : "nothing planned")) },
        { key: "staff", label: "Staff assigned", critical: true, ok: crew > 0, detail: crew ? (crew + " assigned") : "none" },
        { key: "runsheet", label: "Run-sheet built", critical: true, ok: rs.length > 0, detail: rs.length ? (rs.length + " items") : "empty" },
        { key: "payments", label: "Advance received", critical: false, ok: paid, detail: paid ? "yes" : "not yet" },
        { key: "dry_run", label: "Dry run done", critical: true, ok: !!(planRow && planRow.dry_run_at), detail: (planRow && planRow.dry_run_at) ? "done" : "pending", signoff: "dry_run" },
        { key: "briefing", label: "Team briefed", critical: true, ok: !!(planRow && planRow.briefing_at), detail: (planRow && planRow.briefing_at) ? "done" : "pending", signoff: "briefing" },
      ];
      const crit = checks.filter((c) => c.critical);
      return { checks, passed: checks.filter((c) => c.ok).length, total: checks.length,
        criticalPassed: crit.filter((c) => c.ok).length, criticalTotal: crit.length, ready: crit.every((c) => c.ok) };
    },
    setSignoff: (quoteId, field, done) => plan.setSignoff(quoteId, field, done),
    markReady: (quoteId) => quotes.setStage(quoteId, "ready"),
  };

  /* ---------------- event-day command center (Phase 16) ---------------- */
  const DAY_LS = "bp_eventday";
  const dayops = {
    async list(quoteId, kind) {
      if (mode === "supabase") {
        let q = supa.from("event_day").select("*").eq("quote_id", quoteId);
        if (kind) q = q.eq("kind", kind);
        const { data, error } = await q.order("seq").order("created_at"); if (error) throw error; return data;
      }
      return readLs(DAY_LS).filter((d) => d.quote_id === quoteId && (!kind || d.kind === kind));
    },
    async add(quoteId, item) {
      const withDefault = { status: item.kind === "check" ? "pending" : "expected", ...item };
      if (mode === "supabase") { const { data, error } = await supa.from("event_day").insert({ quote_id: quoteId, ...withDefault }).select().single(); if (error) throw error; return data; }
      const a = readLs(DAY_LS); const row = { id: uid(), quote_id: quoteId, ...withDefault, created_at: now() }; a.push(row); localStorage.setItem(DAY_LS, JSON.stringify(a)); return row;
    },
    async setStatus(id, status) {
      if (mode === "supabase") { const { error } = await supa.from("event_day").update({ status }).eq("id", id); if (error) throw error; return true; }
      const a = readLs(DAY_LS); const r = a.find((x) => x.id === id); if (r) { r.status = status; localStorage.setItem(DAY_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_day").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(DAY_LS, JSON.stringify(readLs(DAY_LS).filter((d) => d.id !== id))); return true;
    },
    // build the arrivals roster from crew assigned (event_tasks) + vendors booked
    async pullRoster(quoteId) {
      const existing = await this.list(quoteId, "arrival");
      const have = new Set(existing.map((e) => e.ref_id).filter(Boolean));
      let added = 0;
      const [team, vends, bk, tasks] = await Promise.all([
        staff.list(true).catch(() => []), vendors.listAll(true).catch(() => []), bookings.list(quoteId).catch(() => []),
        (async () => { if (mode !== "supabase") return [];
          const { data, error } = await supa.from("event_tasks").select("crew_id").eq("quote_id", quoteId).not("crew_id", "is", null);
          if (error) throw error; return data; })().catch(() => []),
      ]);
      const staffById = {}; team.forEach((p) => { staffById[p.id] = p; });
      const vById = {}; vends.forEach((v) => { vById[v.id] = v; });
      const crewIds = [...new Set(tasks.map((t) => t.crew_id))];
      for (const cid of crewIds) { if (have.has(cid)) continue; const p = staffById[cid] || {};
        await this.add(quoteId, { kind: "arrival", who: p.name || "Crew", role: p.department || "Staff", ref_id: cid, status: "expected" }); added++; }
      for (const b of bk) { if (b.status === "cancelled" || b.status === "enquiry" || have.has(b.id)) continue; const v = vById[b.vendor_id] || {};
        await this.add(quoteId, { kind: "arrival", who: v.name || b.label || "Vendor", role: "vendor", ref_id: b.id, status: "expected" }); added++; }
      return added;
    },
  };

  /* ---------------- guest entry / reception (Phase 22, spec step 56) ---------------- */
  const GUEST_LS = "bp_guests";
  const guests = {
    async list(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_guests").select("*").eq("quote_id", quoteId).order("seq").order("created_at");
        if (error) throw error; return data;
      }
      return readLs(GUEST_LS).filter((g) => g.quote_id === quoteId);
    },
    async add(quoteId, g) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_guests").insert({ quote_id: quoteId, ...g }).select().single(); if (error) throw error; return data; }
      const a = readLs(GUEST_LS); const row = { id: uid(), quote_id: quoteId, expected: 0, arrived: 0, ...g, created_at: now() }; a.push(row); localStorage.setItem(GUEST_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("event_guests").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(GUEST_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(GUEST_LS, JSON.stringify(a)); } return true;
    },
    // bump the arrived count (never below 0); delta usually +1/-1
    async checkIn(id, delta) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_guests").select("arrived").eq("id", id).single();
        if (error) throw error;
        return this.update(id, { arrived: Math.max(0, Number((data && data.arrived) || 0) + Number(delta || 0)) });
      }
      const a = readLs(GUEST_LS); const g = a.find((x) => x.id === id); const cur = g ? Number(g.arrived || 0) : 0;
      return this.update(id, { arrived: Math.max(0, cur + Number(delta || 0)) });
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_guests").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(GUEST_LS, JSON.stringify(readLs(GUEST_LS).filter((g) => g.id !== id))); return true;
    },
    // seed the day-of guest groups from the logistics guest list (event_checklist section 'guests')
    async pullFromLogistics(quoteId) {
      const existing = await this.list(quoteId);
      const have = new Set(existing.map((g) => (g.label || "").toLowerCase()));
      let rows = [];
      try { rows = await checklist.list(quoteId, "guests"); } catch { rows = []; }
      let added = 0;
      for (const r of rows) { const label = r.title || "Guests"; if (have.has(label.toLowerCase())) continue;
        await this.add(quoteId, { label, expected: Number(r.qty || 0) }); added++; }
      return added;
    },
  };

  /* ---------------- live inventory support (Phase 23, spec step 60) ---------------- */
  const STOCKREQ_LS = "bp_stockreq";
  const stockreq = {
    async list(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_stock_requests").select("*").eq("quote_id", quoteId).order("created_at", { ascending: false });
        if (error) throw error; return data;
      }
      return readLs(STOCKREQ_LS).filter((r) => r.quote_id === quoteId);
    },
    async add(quoteId, r) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_stock_requests").insert({ quote_id: quoteId, ...r }).select().single(); if (error) throw error; return data; }
      const a = readLs(STOCKREQ_LS); const row = { id: uid(), quote_id: quoteId, status: "requested", qty: 1, ...r, created_at: now() }; a.unshift(row); localStorage.setItem(STOCKREQ_LS, JSON.stringify(a)); return row;
    },
    async setStatus(id, status) {
      if (mode === "supabase") { const { error } = await supa.from("event_stock_requests").update({ status }).eq("id", id); if (error) throw error; return true; }
      const a = readLs(STOCKREQ_LS); const r = a.find((x) => x.id === id); if (r) { r.status = status; localStorage.setItem(STOCKREQ_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_stock_requests").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(STOCKREQ_LS, JSON.stringify(readLs(STOCKREQ_LS).filter((r) => r.id !== id))); return true;
    },
  };

  /* ---------------- live issues & incident log (Phase 17) ---------------- */
  const ISS_LS = "bp_issues";
  const issues = {
    async list(quoteId, kind) {
      if (mode === "supabase") {
        let q = supa.from("event_issues").select("*").eq("quote_id", quoteId);
        if (kind) q = q.eq("kind", kind);
        const { data, error } = await q.order("created_at", { ascending: false }); if (error) throw error; return data;
      }
      return readLs(ISS_LS).filter((i) => i.quote_id === quoteId && (!kind || i.kind === kind));
    },
    async add(quoteId, item) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_issues").insert({ quote_id: quoteId, ...item }).select().single(); if (error) throw error; return data; }
      const a = readLs(ISS_LS); const row = { id: uid(), quote_id: quoteId, status: "open", severity: "medium", kind: "issue", ...item, created_at: now() }; a.unshift(row); localStorage.setItem(ISS_LS, JSON.stringify(a)); return row;
    },
    async setStatus(id, status) {
      const patch = { status, resolved_at: status === "resolved" ? now() : null };
      if (mode === "supabase") { const { error } = await supa.from("event_issues").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(ISS_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(ISS_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_issues").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(ISS_LS, JSON.stringify(readLs(ISS_LS).filter((i) => i.id !== id))); return true;
    },
  };

  /* ---------------- event media / gallery (Phase 25, spec step 86) ---------------- */
  const MEDIA_LS = "bp_media";
  const media = {
    async list(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_media").select("*").eq("quote_id", quoteId).order("seq").order("created_at");
        if (error) throw error; return data;
      }
      return readLs(MEDIA_LS).filter((m) => m.quote_id === quoteId);
    },
    async add(quoteId, m) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_media").insert({ quote_id: quoteId, ...m }).select().single(); if (error) throw error; return data; }
      const a = readLs(MEDIA_LS); const row = { id: uid(), quote_id: quoteId, kind: "photo", in_gallery: true, ...m, created_at: now() }; a.push(row); localStorage.setItem(MEDIA_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("event_media").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(MEDIA_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(MEDIA_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_media").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(MEDIA_LS, JSON.stringify(readLs(MEDIA_LS).filter((m) => m.id !== id))); return true;
    },
  };

  /* ---------------- refunds / recovery (Phase 24, spec step 80) ---------------- */
  const REFUND_LS = "bp_refunds";
  const refunds = {
    async list(quoteId) {
      if (mode === "supabase") {
        const { data, error } = await supa.from("event_refunds").select("*").eq("quote_id", quoteId).order("created_at");
        if (error) throw error; return data;
      }
      return readLs(REFUND_LS).filter((r) => r.quote_id === quoteId);
    },
    async add(quoteId, r) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_refunds").insert({ quote_id: quoteId, ...r }).select().single(); if (error) throw error; return data; }
      const a = readLs(REFUND_LS); const row = { id: uid(), quote_id: quoteId, kind: "refund", amount: 0, status: "pending", ...r, created_at: now() }; a.push(row); localStorage.setItem(REFUND_LS, JSON.stringify(a)); return row;
    },
    async setStatus(id, status) {
      if (mode === "supabase") { const { error } = await supa.from("event_refunds").update({ status }).eq("id", id); if (error) throw error; return true; }
      const a = readLs(REFUND_LS); const r = a.find((x) => x.id === id); if (r) { r.status = status; localStorage.setItem(REFUND_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_refunds").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(REFUND_LS, JSON.stringify(readLs(REFUND_LS).filter((r) => r.id !== id))); return true;
    },
  };

  /* ---------------- settlement & billing (Phase 19) ---------------- */
  const EXP_LS = "bp_expenses";
  const expenses = {
    async list(quoteId) {
      if (mode === "supabase") { const { data, error } = await supa.from("expense_claims").select("*").eq("quote_id", quoteId).order("created_at"); if (error) throw error; return data; }
      return readLs(EXP_LS).filter((e) => e.quote_id === quoteId);
    },
    async add(quoteId, e) {
      if (mode === "supabase") { const { data, error } = await supa.from("expense_claims").insert({ quote_id: quoteId, ...e }).select().single(); if (error) throw error; return data; }
      const a = readLs(EXP_LS); const row = { id: uid(), quote_id: quoteId, status: "pending", amount: 0, ...e, created_at: now() }; a.push(row); localStorage.setItem(EXP_LS, JSON.stringify(a)); return row;
    },
    async setStatus(id, status) {
      if (mode === "supabase") { const { error } = await supa.from("expense_claims").update({ status }).eq("id", id); if (error) throw error; return true; }
      const a = readLs(EXP_LS); const r = a.find((x) => x.id === id); if (r) { r.status = status; localStorage.setItem(EXP_LS, JSON.stringify(a)); } return true;
    },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("expense_claims").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(EXP_LS, JSON.stringify(readLs(EXP_LS).filter((e) => e.id !== id))); return true;
    },
  };
  const settlement = {
    async summary(quoteId) {
      const [b, ms, bk, exp, pays] = await Promise.all([
        budget.summary(quoteId), milestones.list(quoteId), bookings.list(quoteId), expenses.list(quoteId),
        milestones.payments(quoteId).catch(() => []),
      ]);
      // "Received" = money actually collected, summed from the quote_payments LEDGER —
      // the single source of truth that holds EVERY receipt (both the advance and any
      // settlement/cash payment). The old code summed milestone STATUS, so a recorded
      // settlement payment (which writes quote_payments with no milestone) never counted,
      // leaving Balance due overstated. Fall back to paid milestones only if the ledger
      // is unavailable.
      const fromLedger = (pays || []).filter((p) => p.status === "paid").reduce((a, p) => a + Number(p.amount || 0), 0);
      const fromMilestones = ms.filter((m) => m.status === "paid").reduce((a, m) => a + Number(m.amount || 0), 0);
      const received = (pays && pays.length) ? fromLedger : fromMilestones;
      const revenue = b.revenue, balance = revenue - received;
      const vend = bk.filter((x) => x.status !== "cancelled");
      const vendorCost = vend.reduce((a, x) => a + Number(x.cost || 0), 0);
      const vendorAdvance = vend.reduce((a, x) => a + Number(x.advance || 0), 0);
      const vendorOutstanding = vend.filter((x) => !x.settled).reduce((a, x) => a + Math.max(0, Number(x.cost || 0) - Number(x.advance || 0)), 0);
      const expTotal = exp.reduce((a, e) => a + Number(e.amount || 0), 0);
      const expPaid = exp.filter((e) => e.status === "paid").reduce((a, e) => a + Number(e.amount || 0), 0);
      return { revenue, received, balance, estCost: b.estCost, actCost: b.actCost, finalCost: b.finalCost,
        estMargin: b.estMargin, actMargin: b.actMargin, finalMargin: b.finalMargin,
        milestones: ms, bookings: vend, expenses: exp, vendorCost, vendorAdvance, vendorOutstanding, expTotal, expPaid };
    },
  };

  /* ---------------- closure, feedback, ratings & P&L (Phase 20) ---------------- */
  const CLOSE_LS = "bp_closure", RATE_LS = "bp_ratings";
  const closure = {
    async get(quoteId) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_closure").select("*").eq("quote_id", quoteId).maybeSingle(); if (error) throw error; return data || null; }
      return readLs(CLOSE_LS).find((c) => c.quote_id === quoteId) || null;
    },
    async save(quoteId, c) {
      if (mode === "supabase") {
        return rpc("set_closure", { p_quote_id: quoteId, p_rating: c.client_rating || null, p_feedback: c.feedback || null,
          p_testimonial: c.testimonial || null, p_media_consent: !!c.media_consent, p_lessons: c.lessons || null });
      }
      const a = readLs(CLOSE_LS).filter((x) => x.quote_id !== quoteId);
      const cur = readLs(CLOSE_LS).find((x) => x.quote_id === quoteId) || {};
      const row = { quote_id: quoteId, closed_at: cur.closed_at || null, ...c, updated_at: now() }; a.push(row);
      localStorage.setItem(CLOSE_LS, JSON.stringify(a)); return row;
    },
    async setClosed(quoteId, closed) {
      if (mode === "supabase") return rpc("close_event", { p_quote_id: quoteId, p_closed: !!closed });
      const a = readLs(CLOSE_LS); let row = a.find((x) => x.quote_id === quoteId);
      if (!row) { row = { quote_id: quoteId }; a.push(row); }
      row.closed_at = closed ? now() : null; localStorage.setItem(CLOSE_LS, JSON.stringify(a));
      try { await lsq.setStage(quoteId, closed ? "closed" : "settlement"); } catch {}
      return row;
    },
    async listRatings(quoteId) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_ratings").select("*").eq("quote_id", quoteId).order("created_at"); if (error) throw error; return data; }
      return readLs(RATE_LS).filter((r) => r.quote_id === quoteId);
    },
    async addRating(quoteId, r) {
      if (mode === "supabase") { const { data, error } = await supa.from("event_ratings").insert({ quote_id: quoteId, ...r }).select().single(); if (error) throw error; return data; }
      const a = readLs(RATE_LS); const row = { id: uid(), quote_id: quoteId, ...r, created_at: now() }; a.push(row); localStorage.setItem(RATE_LS, JSON.stringify(a)); return row;
    },
    async removeRating(id) {
      if (mode === "supabase") { const { error } = await supa.from("event_ratings").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(RATE_LS, JSON.stringify(readLs(RATE_LS).filter((r) => r.id !== id))); return true;
    },
    // profit & loss for the event
    async pl(quoteId) {
      const s = await settlement.summary(quoteId);
      const cost = s.finalCost;                      // best-known total cost: actuals where entered, else the estimate — per line, plus vendor spend & approved change cost
      const profit = s.revenue - cost - s.expPaid;
      return { revenue: s.revenue, cost, expenses: s.expPaid, profit,
        marginPct: s.revenue ? Math.round(profit / s.revenue * 100) : null, estCost: s.estCost, actCost: s.actCost, finalCost: s.finalCost };
    },
  };

  /* ---------------- notification bell: view (pure — unit-tested in test/bell-panel.test.mjs) ----------------
     bellPanelView(items, { filter, now, label }) → { filter, tabs, tabsHtml, html, unread }
     items = the merged feed: bell_feed rows + chat rows ({ __chat:true, … }). Every piece of
     server / chat text goes through esc(); hrefs are built from encodeURIComponent'd ids. */
  function bellPanelView(items, opts) {
    opts = opts || {};
    const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const label = opts.label || ((n) => ({ icon: "🔔", text: String((n && n.kind) || "Update").replace(/_/g, " ") }));
    const now = Number(opts.now) || Date.now();
    const list = (items || []).filter((n) => n && typeof n === "object");
    // which filter group a row belongs to (also drives the icon-chip colour)
    const groupOf = (n) => {
      if (n.__chat) return n.mention ? "mention" : "chat";
      const k = String(n.kind || "").toLowerCase();
      if (k.indexOf("task_") === 0) return "task";
      if (/payment|advance_paid/.test(k)) return "payment";
      return "other";
    };
    const inFilter = (f, g) => f === "all" || (f === "mentions" && g === "mention") || (f === "tasks" && g === "task")
      || (f === "payments" && g === "payment") || (f === "chat" && (g === "chat" || g === "mention"));
    const rows = list.map((n, i) => ({ n, i, g: groupOf(n) }));
    const count = (f) => rows.filter((r) => inFilter(f, r.g)).length;
    // Payments only when the feed carries any (bell_feed already hides money types this role can't see)
    const tabs = [["all", "All"], ["mentions", "Mentions"], ["tasks", "Tasks"], ["payments", "Payments"], ["chat", "Chat"]]
      .filter(([id]) => id !== "payments" || count("payments") > 0)
      .map(([id, name]) => ({ id, label: name, count: count(id) }));
    let filter = String(opts.filter || "all"); if (!tabs.some((t) => t.id === filter)) filter = "all";
    const tabsHtml = tabs.map((t) => `<button type="button" role="tab" class="bpb-tab" id="bpBellTab-${t.id}" data-f="${t.id}" aria-selected="${t.id === filter}" aria-controls="bpBellList" tabindex="${t.id === filter ? 0 : -1}">${t.label}${t.count ? `<span class="bpb-n">${t.count > 99 ? "99+" : t.count}</span>` : ""}</button>`).join("");
    const unread = rows.reduce((s, r) => s + (r.n.__chat ? (Number(r.n.count) || 1) : (r.n.unread ? 1 : 0)), 0);
    // relative time + Today / Yesterday / Earlier (local calendar days)
    const ts = (n) => { const t = new Date(n.created_at).getTime(); return Number.isFinite(t) ? t : NaN; };
    const rel = (t) => {
      if (!Number.isFinite(t)) return "";
      const s = Math.max(0, (now - t) / 1000);
      if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h";
      if (s < 7 * 86400) return Math.floor(s / 86400) + "d";
      try { return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }); } catch (e) { return Math.floor(s / 86400) + "d"; }
    };
    const sod = new Date(now); sod.setHours(0, 0, 0, 0); const today0 = sod.getTime();
    const yd = new Date(today0); yd.setDate(yd.getDate() - 1); const yest0 = yd.getTime();
    const bucket = (t) => !Number.isFinite(t) ? "Earlier" : t >= today0 ? "Today" : t >= yest0 ? "Yesterday" : "Earlier";
    const item = (r) => {
      const n = r.n, t = ts(n); let icon, title, preview, href, isUnread, key;
      if (n.__chat) {
        const who = n.who || "";
        title = esc(n.kind === "dm" ? (who || n.title || "Direct message") : ((n.title || "Chat") + (who ? " · " + who : "")));
        if (Number(n.count) > 1) title += ` <span class="bpb-c">(${Number(n.count) > 99 ? "99+" : Number(n.count)})</span>`;
        preview = esc(n.preview || ""); icon = n.mention ? "@" : "💬"; isUnread = true;
        href = "chat.html?c=" + encodeURIComponent(n.conversation_id || ""); key = "c:" + (n.conversation_id || r.i);
      } else {
        const L = label(n) || {}; icon = esc(L.icon || "🔔"); title = esc(L.text || "Update");
        preview = esc([n.event_code, n.event_title].filter(Boolean).join(" · "));
        href = n.quote_id ? "event.html?id=" + encodeURIComponent(n.quote_id) : ""; isUnread = !!n.unread; key = "n:" + (n.id || r.i);
      }
      const cls = `bpb-item g-${r.g}${isUnread ? " is-unread" : ""}`;
      const inner = `<span class="bpb-chip" aria-hidden="true">${icon}</span>`
        + `<span class="bpb-body"><span class="bpb-t">${title}</span>${preview ? `<span class="bpb-p">${preview}</span>` : ""}</span>`
        + `<span class="bpb-meta">${Number.isFinite(t) ? `<time datetime="${esc(new Date(t).toISOString())}">${esc(rel(t))}</time>` : ""}`
        + `${isUnread ? '<span class="bpb-u"><span class="sr-only">Unread</span></span>' : ""}</span>`;
      return href ? `<a class="${cls}" href="${esc(href)}" data-k="${esc(key)}">${inner}</a>`
                  : `<div class="${cls}" tabindex="0" data-k="${esc(key)}">${inner}</div>`;
    };
    const shown = rows.filter((r) => inFilter(filter, r.g));
    let html;
    if (!shown.length) {
      const msg = { all: ["You’re all caught up", "New tasks, payments and messages will show up here."],
        mentions: ["No mentions", "When a teammate @mentions you in chat, it lands here."],
        tasks: ["No task updates", "Assignments, check-ins and reminders will appear here."],
        payments: ["No payment updates", "Payment links, receipts and reminders will appear here."],
        chat: ["No unread messages", "Unread chats from your team show up here."] }[filter];
      html = `<div class="bpb-empty"><svg class="bpb-art" viewBox="0 0 120 96" aria-hidden="true" focusable="false">`
        + `<circle cx="60" cy="50" r="38" class="bpb-art-bg"/><path class="bpb-art-bell" d="M60 26c-10 0-17 8-17 18v11l-6 8h46l-6-8V44c0-10-7-18-17-18z"/>`
        + `<circle cx="60" cy="69" r="5" class="bpb-art-bell"/><path class="bpb-art-z" d="M84 18h8l-8 9h8M96 8h5l-5 6h5"/></svg>`
        + `<b>${msg[0]}</b><span>${msg[1]}</span></div>`;
    } else {
      const order = ["Today", "Yesterday", "Earlier"], by = { Today: [], Yesterday: [], Earlier: [] };
      shown.slice().sort((a, b) => (ts(b.n) || 0) - (ts(a.n) || 0)).forEach((r) => by[bucket(ts(r.n))].push(r));
      html = order.filter((d) => by[d].length).map((d) =>
        `<div class="bpb-sec" role="group" aria-label="${d}"><div class="bpb-day" aria-hidden="true">${d}</div>${by[d].map(item).join("")}</div>`).join("");
    }
    return { filter, tabs, tabsHtml, html, unread };
  }
  // Bell styles: injected once (the bell must look the same on pages without theme.css).
  // Light/dark follow the page tokens (theme.css re-points them under html[data-theme=dark]).
  const BELL_CSS = [
    ".bpb-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;height:32px;width:36px;padding:0;border:1px solid var(--line,#e8e3db);background:var(--panel,#fff);color:var(--ink,#1b1930);border-radius:10px;cursor:pointer;transition:background .15s,border-color .15s}",
    ".bpb-btn:hover{border-color:var(--accent,#6d28d9);background:var(--accent-soft,#efe9ff)}",
    ".bpb-btn[aria-expanded=true]{border-color:var(--accent,#6d28d9);background:var(--accent-soft,#efe9ff);color:var(--accent,#6d28d9)}",
    ".bpb-btn svg{width:17px;height:17px}",
    ".bpb-dot{position:absolute;top:-6px;right:-7px;min-width:17px;height:17px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#e5484d;color:#fff;font:700 10px/17px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:center;box-shadow:0 0 0 2px var(--panel,#fff)}",
    ".bpb-dot[hidden]{display:none}",
    ".bpb-root{--bpb-bg:var(--panel,#fff);--bpb-bg2:var(--panel-2,#faf8f5);--bpb-ink:var(--ink,#1b1930);--bpb-ink2:var(--ink-2,#4b475f);--bpb-ink3:var(--ink-3,#6b6577);",
    "--bpb-line:var(--line,#e8e3db);--bpb-acc:var(--accent,#6d28d9);--bpb-unread:#f7f3ff;",
    "--bpb-mention-bg:#ffe4ec;--bpb-mention:#be123c;--bpb-chat-bg:#e0ecff;--bpb-chat:#1d4ed8;--bpb-task-bg:#dcf5e7;--bpb-task:#0f7a43;",
    "--bpb-pay-bg:#fff1d6;--bpb-pay:#8f5f00;--bpb-other-bg:var(--accent-soft,#efe9ff);--bpb-other:var(--accent,#6d28d9);",
    "--bpb-scrim:rgba(24,20,40,.42);--bpb-scrim-blur:rgba(24,20,40,.18);--bpb-shadow:0 24px 60px rgba(20,27,46,.22),0 2px 8px rgba(20,27,46,.08);",
    "position:fixed;inset:0;z-index:2147482000;font:14px/1.4 var(--font,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);color:var(--bpb-ink)}",
    "html[data-theme=dark] .bpb-root{--bpb-unread:#19152a;--bpb-mention-bg:#3a1424;--bpb-mention:#fda4af;--bpb-chat-bg:#172a4d;--bpb-chat:#93c5fd;--bpb-task-bg:#12301f;--bpb-task:#6ee7b7;",
    "--bpb-pay-bg:#3a2a0c;--bpb-pay:#fcd34d;--bpb-other-bg:#1d1730;--bpb-other:#c4b5fd;--bpb-scrim:rgba(0,0,0,.66);--bpb-scrim-blur:rgba(0,0,0,.42);--bpb-shadow:0 24px 60px rgba(0,0,0,.7)}",
    ".bpb-root[hidden]{display:none}",
    // backdrop: solid scrim everywhere; a lighter, blurred one where backdrop-filter works
    ".bpb-scrim{position:absolute;inset:0;background:var(--bpb-scrim);opacity:0;transition:opacity .2s ease}",
    "@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.bpb-scrim{background:var(--bpb-scrim-blur);-webkit-backdrop-filter:blur(8px) saturate(120%);backdrop-filter:blur(8px) saturate(120%)}}",
    ".bpb-root.is-open .bpb-scrim{opacity:1}",
    // desktop: a popover anchored under the bell (top/right set from the button's position)
    ".bpb-panel{position:absolute;top:56px;right:16px;width:420px;max-width:calc(100vw - 24px);max-height:min(640px,calc(100vh - 72px));display:flex;flex-direction:column;box-sizing:border-box;",
    "background:var(--bpb-bg);color:var(--bpb-ink);border:1px solid var(--bpb-line);border-radius:16px;box-shadow:var(--bpb-shadow);overflow:hidden;outline:none;",
    "opacity:0;transform:translateY(-8px) scale(.98);transform-origin:top right;transition:opacity .18s ease,transform .22s cubic-bezier(.2,.8,.2,1)}",
    ".bpb-root.is-open .bpb-panel{opacity:1;transform:none}",
    ".bpb-grab{display:none}",
    ".bpb-head{padding:14px 14px 0;border-bottom:1px solid var(--bpb-line);background:var(--bpb-bg)}",
    ".bpb-hrow{display:flex;align-items:center;gap:8px}",
    ".bpb-title{margin:0;font-size:16px;font-weight:750;letter-spacing:-.01em;color:var(--bpb-ink)}",
    ".bpb-count{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--bpb-acc);color:#fff;font-size:11px;font-weight:700}",
    "html[data-theme=dark] .bpb-count{color:#141418}",
    ".bpb-count[hidden]{display:none}",
    ".bpb-sp{flex:1}",
    ".bpb-link{border:0;background:transparent;color:var(--bpb-acc);font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;padding:6px 8px;border-radius:8px}",
    ".bpb-link:hover{background:var(--bpb-other-bg)}.bpb-link[disabled]{opacity:.5;cursor:default}",
    ".bpb-x{border:0;background:transparent;color:var(--bpb-ink3);font-size:16px;line-height:1;cursor:pointer;width:32px;height:32px;border-radius:8px}",
    ".bpb-x:hover{background:var(--bpb-bg2);color:var(--bpb-ink)}",
    ".bpb-tabs{display:flex;gap:2px;margin:10px -4px 0;overflow-x:auto;scrollbar-width:none}",
    ".bpb-tabs::-webkit-scrollbar{display:none}",
    ".bpb-tab{flex:1 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;background:transparent;color:var(--bpb-ink2);font:inherit;font-size:12.5px;font-weight:600;",
    "padding:7px 6px 9px;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;cursor:pointer}",
    ".bpb-tab:hover{color:var(--bpb-ink);background:var(--bpb-bg2)}",
    ".bpb-tab[aria-selected=true]{color:var(--bpb-acc);border-bottom-color:var(--bpb-acc)}",
    ".bpb-n{min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:var(--bpb-bg2);border:1px solid var(--bpb-line);color:var(--bpb-ink2);font-size:10.5px;font-weight:700;line-height:16px;text-align:center}",
    ".bpb-tab[aria-selected=true] .bpb-n{background:var(--bpb-other-bg);border-color:transparent;color:var(--bpb-acc)}",
    ".bpb-list{flex:1;min-height:120px;overflow:auto;overscroll-behavior:contain;padding:4px 0 10px}",
    ".bpb-day{position:sticky;top:0;z-index:1;padding:10px 16px 6px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--bpb-ink3);background:var(--bpb-bg)}",
    ".bpb-item{position:relative;display:flex;align-items:flex-start;gap:12px;margin:2px 8px;padding:10px 10px;border-radius:12px;text-decoration:none;color:inherit;cursor:pointer;outline:none;transition:background .12s}",
    "div.bpb-item{cursor:default}",
    ".bpb-item:hover{background:var(--bpb-bg2)}",
    ".bpb-item.is-unread{background:var(--bpb-unread)}",
    ".bpb-item:focus-visible{box-shadow:0 0 0 2px var(--bpb-acc)}",
    ".bpb-chip{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:12px;font-size:17px;font-weight:800;line-height:1;background:var(--bpb-other-bg);color:var(--bpb-other)}",
    ".g-mention .bpb-chip{background:var(--bpb-mention-bg);color:var(--bpb-mention);font-size:19px}",
    ".g-chat .bpb-chip{background:var(--bpb-chat-bg);color:var(--bpb-chat)}",
    ".g-task .bpb-chip{background:var(--bpb-task-bg);color:var(--bpb-task)}",
    ".g-payment .bpb-chip{background:var(--bpb-pay-bg);color:var(--bpb-pay)}",
    ".bpb-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-top:1px}",
    ".bpb-t{font-size:13.5px;font-weight:650;color:var(--bpb-ink);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}",
    ".bpb-item.is-unread .bpb-t{font-weight:750}",
    ".bpb-c{color:var(--bpb-ink3);font-weight:600}",
    ".bpb-p{font-size:12.5px;color:var(--bpb-ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".bpb-meta{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:7px;padding-top:2px}",
    ".bpb-meta time{font-size:11.5px;color:var(--bpb-ink3);font-variant-numeric:tabular-nums;white-space:nowrap}",
    ".bpb-u{width:8px;height:8px;border-radius:50%;background:var(--bpb-acc);box-shadow:0 0 0 3px var(--bpb-other-bg)}",
    ".bpb-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px;padding:34px 28px 30px;color:var(--bpb-ink2)}",
    ".bpb-empty b{font-size:15px;color:var(--bpb-ink);margin-top:6px}.bpb-empty span{font-size:13px;max-width:260px}",
    ".bpb-art{width:120px;height:96px}.bpb-art-bg{fill:var(--bpb-other-bg)}.bpb-art-bell{fill:var(--bpb-acc);opacity:.85}",
    ".bpb-art-z{fill:none;stroke:var(--bpb-acc);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;opacity:.6}",
    ".bpb-skel{margin:10px 18px;height:44px;border-radius:12px;background:linear-gradient(90deg,var(--bpb-bg2) 0%,var(--bpb-line) 50%,var(--bpb-bg2) 100%);background-size:200% 100%;animation:bpbShimmer 1.2s linear infinite}",
    "@keyframes bpbShimmer{to{background-position:-200% 0}}",
    // phone: a full-height sheet that slides up from the bottom
    "@media (max-width:640px){",
    ".bpb-panel{top:max(10px,env(safe-area-inset-top,0px))!important;right:0!important;left:0;bottom:0;width:auto;max-width:none;max-height:none;border-radius:20px 20px 0 0;border-bottom:0;",
    "padding-bottom:env(safe-area-inset-bottom,0px);transform:translateY(100%);opacity:1;transition:transform .28s cubic-bezier(.2,.8,.2,1)}",
    ".bpb-root.is-open .bpb-panel{transform:none}",
    ".bpb-grab{display:block;width:40px;height:4px;border-radius:2px;background:var(--bpb-line);margin:8px auto 0}",
    ".bpb-head{padding-top:8px}.bpb-item{padding:12px 10px}.bpb-x{width:40px;height:40px}}",
    "@media (prefers-reduced-motion:reduce){.bpb-root .bpb-scrim,.bpb-root .bpb-panel,.bpb-btn{transition:none!important}.bpb-panel{transform:none!important}.bpb-skel{animation:none}}",
    "@media print{.bpb-root{display:none!important}}",
  ].join("\n");
  function bellInjectCss() {
    if (typeof document === "undefined" || document.getElementById("bpb-style")) return;
    const st = document.createElement("style"); st.id = "bpb-style"; st.textContent = BELL_CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  // friendly label + icon for a raw notification kind
  function bellLabel(n) {
    const k = (n.kind || "").toLowerCase(); const d = n.detail || {};
    const m = {
      task_assigned: ["🛠️", d.outsourced ? `Tasks outsourced to ${d.vendor || "a vendor"}` : `${d.count || ""} task(s) assigned${d.category ? " · " + d.category : ""}`],
      task_accept: ["✅", "Task accepted" + (d.worker ? " by " + d.worker : "")],
      task_reject: ["⛔", "Task rejected" + (d.worker ? " by " + d.worker : "")],
      task_start: ["▶️", "Task started" + (d.worker ? " by " + d.worker : "")],
      task_complete: ["🎉", "Task completed" + (d.worker ? " by " + d.worker : "")],
      task_reminder: ["🔔", "Task reminder" + (d.task ? ": " + d.task : "")],
      otp: ["🔐", "Approval OTP sent"],
      approval_link: ["✉️", "Approval link sent"],
      payment: ["💳", "Payment update"],
      payment_link: ["💳", "Payment link sent"],
      payment_received: ["💰", "Payment received"],
      task_due: ["⏰", "Task due" + (d.task ? ": " + d.task : "")],
      payment_reminder: ["💳", "Payment reminder sent"],
      payment_receipt: ["🧾", "Payment receipt sent"],
      advance_paid: ["💰", "Payment received"],
      payment_reconcile: ["⚠️", "Payment needs attention"],
    };
    const hit = m[k] || (k.indexOf("design_") === 0 ? ["🎨", "Design stage: " + k.slice(7).replace(/_/g, " ")]
                      : k.indexOf("nurture_") === 0 ? ["🌱", "Greeting queued" + (k.length > 8 ? " · " + k.slice(8).replace(/_/g, " ") : "")] : null);
    // 0036: an automatic staff text/e-mail the studio switched off is logged, not sent
    const off = n.status === "suppressed" ? " (not sent — switched off)" : "";
    if (hit) return { icon: hit[0], text: hit[1] + off };
    return { icon: "🔔", text: (n.kind || "Update").replace(/_/g, " ") + off };
  }

  /* ---------------- notification center: in-app bell (Phase 48) ---------------- */
  const bell = {
    feed: (limit) => rpc("bell_feed", limit ? { p_limit: limit } : {}),
    markSeen: () => rpc("bell_mark_seen", {}),
    label: bellLabel,
    // 0036 admin-managed notifications. mine() → { hidden:[type…] } for the signed-in
    // person (fail-open: an older database without 0036 hides nothing).
    prefs: {
      async mine() {
        if (mode !== "supabase" || !supa || !currentUser) return { hidden: [] };
        try { const r = await rpc("my_notification_prefs", {}); return { hidden: (r && Array.isArray(r.hidden)) ? r.hidden : [] }; }
        catch (e) { return { hidden: [] }; }
      },
      // studio admin only (the DB refuses anyone else): catalog + effective matrix
      get: () => rpc("admin_get_notification_prefs", {}),
      // one cell; enabled null = back to the default. role for the bell; user for a person override
      set: (type, channel, role, enabled, userId) => rpc("admin_set_notification_pref",
        { p_type: type, p_channel: channel, p_role: role || null, p_enabled: enabled === null || enabled === undefined ? null : !!enabled, p_user: userId || null }),
      reset: () => rpc("admin_reset_notification_prefs", {}),
    },
    // Mount the bell into `el` (works on any page): a button in the header + a panel portalled
    // to <body> (blurred backdrop; anchored popover on desktop, full-height sheet on phones).
    async mount(el) {
      if (!el) return;
      if (!(auth.enabled() && auth.user())) { el.innerHTML = ""; return; }
      bellInjectCss();
      // a second mount on the same page replaces the first (no duplicate panels / timers)
      try { if (typeof window.__bpBellTeardown === "function") window.__bpBellTeardown(); } catch (e) {}
      el.style.position = "relative";
      el.innerHTML = `<button type="button" id="bpBellBtn" class="bpb-btn" title="Notifications" aria-label="Notifications" aria-haspopup="dialog" aria-expanded="false" aria-controls="bpBellPanel">`
        + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`
        + `<span id="bpBellDot" class="bpb-dot" hidden>0</span></button>`;
      const root = document.createElement("div");
      root.className = "bpb-root"; root.id = "bpBellRoot"; root.hidden = true;
      root.innerHTML = `<div class="bpb-scrim" data-bpb-close></div>
        <section id="bpBellPanel" class="bpb-panel" role="dialog" aria-modal="true" aria-labelledby="bpBellTitle" tabindex="-1" data-bpui-skip>
          <div class="bpb-grab" aria-hidden="true"></div>
          <header class="bpb-head">
            <div class="bpb-hrow"><h2 id="bpBellTitle" class="bpb-title">Notifications</h2><span id="bpBellCount" class="bpb-count" hidden></span><span class="bpb-sp"></span>
              <button type="button" id="bpBellClear" class="bpb-link">Mark all read</button>
              <button type="button" class="bpb-x" data-bpb-close aria-label="Close notifications">✕</button></div>
            <div id="bpBellTabs" class="bpb-tabs" role="tablist" aria-label="Filter notifications"></div>
          </header>
          <div id="bpBellList" class="bpb-list" role="tabpanel" aria-labelledby="bpBellTitle"><div class="bpb-skel"></div><div class="bpb-skel"></div><div class="bpb-skel"></div></div>
        </section>`;
      document.body.appendChild(root);
      const btn = el.querySelector("#bpBellBtn"), dot = el.querySelector("#bpBellDot");
      const panel = root.querySelector("#bpBellPanel"), list = root.querySelector("#bpBellList"),
            tabsEl = root.querySelector("#bpBellTabs"), countEl = root.querySelector("#bpBellCount");
      const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
      const isPhone = () => { try { return window.matchMedia("(max-width: 640px)").matches; } catch (e) { return false; } };
      let isOpen = false, filter = "all", lastItems = [], loaded = false, closeTimer = null, prevOverflow = "", lastFocus = null;
      // Chat notifications (my unread DMs/groups/broadcast) merged into the same bell.
      let chatItems = [];
      const chatUnread = () => chatItems.reduce((s, c) => s + (c.count || 1), 0);
      const mergedFeed = (serverItems) => (serverItems || []).slice()
        .concat(chatItems.map((c) => Object.assign({ __chat: true }, c)))
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      // 0036: the studio admin can switch chat off in the bell for a role / person
      // (re-checked every 5 minutes; server-side types are already filtered by bell_feed).
      let hiddenTypes = [], hiddenAt = 0;
      const loadHidden = async () => { if (Date.now() - hiddenAt < 300000) return; hiddenAt = Date.now(); hiddenTypes = (await this.prefs.mine()).hidden; };
      const loadChat = async () => { try { await loadHidden(); } catch (e) {} const chatOff = hiddenTypes.indexOf("chat_message") !== -1;   // chat switched off → @mentions still come through
        try { chatItems = (chat && chat.notifications) ? (await chat.notifications(20)) : []; } catch (e) { chatItems = []; }
        if (chatOff) chatItems = chatItems.filter((c) => c && c.mention); };
      const setDot = (serverUnread) => { const total = (serverUnread || 0) + chatUnread();
        if (total > 0) { dot.hidden = false; dot.textContent = total > 99 ? "99+" : total; } else dot.hidden = true;
        btn.setAttribute("aria-label", total > 0 ? `Notifications, ${total > 99 ? "99+" : total} unread` : "Notifications"); };
      // render the open panel, keeping keyboard focus on the same row / tab across live refreshes
      const render = () => {
        const ae = document.activeElement, keepKey = ae && root.contains(ae) && ae.getAttribute ? (ae.getAttribute("data-k") || (ae.getAttribute("data-f") ? "tab:" + ae.getAttribute("data-f") : null)) : null;
        const v = bellPanelView(lastItems, { filter, now: Date.now(), label: bellLabel });
        filter = v.filter; tabsEl.innerHTML = v.tabsHtml; list.innerHTML = v.html;
        list.setAttribute("aria-labelledby", "bpBellTab-" + filter);
        if (v.unread > 0) { countEl.hidden = false; countEl.textContent = (v.unread > 99 ? "99+" : v.unread) + " new"; } else countEl.hidden = true;
        if (keepKey) { const sel = keepKey.indexOf("tab:") === 0 ? `[data-f="${keepKey.slice(4)}"]` : `[data-k="${String(keepKey).replace(/["\\]/g, "\\$&")}"]`;
          const t = root.querySelector(sel); if (t) try { t.focus(); } catch (e) {} }
      };
      const refresh = async () => { let f = null; try { f = await this.feed(20); } catch {} await loadChat(); setDot(f && f.unread);
        if (isOpen) { lastItems = mergedFeed(f && f.items); loaded = true; render(); } return f; };
      // desktop: anchor the popover under the bell; phone: the CSS sheet takes over
      const position = () => {
        if (isPhone()) { panel.style.top = ""; panel.style.right = ""; panel.style.maxHeight = ""; return; }
        const r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight;
        const top = Math.max(8, Math.round(r.bottom + 10)), right = Math.max(12, Math.round(vw - r.right - 4));
        panel.style.top = top + "px"; panel.style.right = right + "px"; panel.style.maxHeight = Math.max(240, Math.min(640, vh - top - 16)) + "px";
      };
      const items = () => Array.prototype.slice.call(list.querySelectorAll(".bpb-item"));
      const focusables = () => Array.prototype.filter.call(panel.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
        (n) => !n.hidden && n.getClientRects().length > 0);
      const open = async () => {
        if (isOpen) return; isOpen = true; clearTimeout(closeTimer);
        lastFocus = document.activeElement;
        root.hidden = false; position(); btn.setAttribute("aria-expanded", "true");
        try { prevOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = "hidden"; } catch (e) {}
        void root.offsetWidth; root.classList.add("is-open");     // next frame → CSS transition runs
        try { panel.focus({ preventScroll: true }); } catch (e) { panel.focus(); }
        if (loaded) render();                                       // show the last list at once, then refresh
        let f = null; try { f = await this.feed(20); } catch {} await loadChat();
        if (!isOpen) return;
        lastItems = mergedFeed(f && f.items); loaded = true; render();
        try { await this.markSeen(); } catch {} setDot(0);   // event notifs cleared; any chat unread keeps the dot until that chat is opened
      };
      const close = (restore) => {
        if (!isOpen) return; isOpen = false;
        root.classList.remove("is-open"); btn.setAttribute("aria-expanded", "false");
        try { document.documentElement.style.overflow = prevOverflow || ""; } catch (e) {}
        const hide = () => { if (!isOpen) root.hidden = true; };
        if (reduced()) hide(); else closeTimer = setTimeout(hide, 280);
        if (restore !== false) { const t = (lastFocus && lastFocus.isConnected && lastFocus !== document.body) ? lastFocus : btn; try { t.focus({ preventScroll: true }); } catch (e) {} }
      };
      btn.addEventListener("click", (e) => { e.stopPropagation(); if (isOpen) close(); else open(); });
      root.addEventListener("click", (e) => {
        const c = e.target.closest && e.target.closest("[data-bpb-close]"); if (c) { e.preventDefault(); close(); return; }
        const tab = e.target.closest && e.target.closest(".bpb-tab"); if (tab) { filter = tab.getAttribute("data-f") || "all"; render(); try { root.querySelector(`[data-f="${filter}"]`).focus(); } catch (x) {} return; }
        const it = e.target.closest && e.target.closest("a.bpb-item"); if (it) close(false);   // navigating away
      });
      root.querySelector("#bpBellClear").addEventListener("click", async (e) => { e.stopPropagation(); const b = e.currentTarget; b.disabled = true;
        try { await this.markSeen(); } catch {} await refresh(); b.disabled = false; });
      // keyboard: Esc closes, Tab is trapped, arrows walk the list, ←/→ switch tabs
      root.addEventListener("keydown", (e) => {
        if (!isOpen) return;
        if (e.key === "Escape" || e.key === "Esc") { e.preventDefault(); e.stopPropagation(); close(); return; }
        const ae = document.activeElement;
        if (e.key === "Tab") {
          const f = focusables(); if (!f.length) { e.preventDefault(); return; }
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && (ae === first || ae === panel || !panel.contains(ae))) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && (ae === last || !panel.contains(ae))) { e.preventDefault(); first.focus(); }
          return;
        }
        const onTab = ae && ae.classList && ae.classList.contains("bpb-tab");
        if (onTab && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          const ts = Array.prototype.slice.call(tabsEl.querySelectorAll(".bpb-tab")); const i = ts.indexOf(ae);
          const nx = ts[(i + (e.key === "ArrowRight" ? 1 : -1) + ts.length) % ts.length];
          if (nx) { e.preventDefault(); filter = nx.getAttribute("data-f"); render(); try { root.querySelector(`[data-f="${filter}"]`).focus(); } catch (x) {} }
          return;
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].indexOf(e.key) === -1) return;
        const its = items(); if (!its.length) return;
        const i = its.indexOf(ae); let n;
        if (e.key === "ArrowUp" && i === 0) { const sel = tabsEl.querySelector('[aria-selected="true"]'); e.preventDefault(); if (sel) sel.focus(); return; }   // top row → back to the tabs
        if (e.key === "Home") n = 0; else if (e.key === "End") n = its.length - 1;
        else if (e.key === "ArrowDown") n = i < 0 ? 0 : Math.min(its.length - 1, i + 1);
        else n = i < 0 ? its.length - 1 : i - 1;
        e.preventDefault(); try { its[n].focus(); its[n].scrollIntoView({ block: "nearest" }); } catch (x) {}
      });
      const onResize = () => { if (isOpen) position(); };
      window.addEventListener("resize", onResize);
      await refresh();
      const timer = setInterval(() => { if (!document.hidden && !isOpen) refresh(); }, 30000);
      // Live: refresh the bell whenever a chat message arrives — on ANY page.
      var csub = null;
      try { if (chat && chat.subscribe) { csub = chat.subscribe(function () { refresh(); }, function () {}, "chat-rt-bell"); window.addEventListener("beforeunload", function () { try { csub && csub.unsubscribe && csub.unsubscribe(); } catch (e) {} }); } } catch (e) {}
      // Let the chat page nudge the bell after it marks a conversation read.
      try { window.__bpBellRefresh = refresh; } catch (e) {}
      try { window.__bpBellTeardown = () => { clearInterval(timer); window.removeEventListener("resize", onResize); if (isOpen) close(false);
        try { csub && csub.unsubscribe && csub.unsubscribe(); } catch (e) {} try { root.remove(); } catch (e) {} }; } catch (e) {}
    },
  };

  /* ---------------- client portal (Phase 53) ---------------- */
  const portal = { get: (token) => rpc("public_get_portal", { p_token: token }) };

  /* ---------------- post-event insights (Phase 51) ---------------- */
  const insights = {
    async summary() {
      const empty = { vendors: [], taskSlips: [], losses: { total: 0, byItem: [], byMonth: [] }, margins: { events: [], totalProfit: 0, avgMargin: null } };
      if (mode !== "supabase" || !supa) return empty;
      // Wave 16 perf: fetch the event list alongside the three aggregates instead
      // of awaiting it first (it isn't an input to them) — removes one serial round-trip.
      const [events, tR, cR, iR] = await Promise.all([
        quotes.list(),
        supa.from("event_tasks").select("category,status,verify_status,assignee_kind,assignee_name,quote_id"),
        supa.from("inventory_checkouts").select("item_id,qty_out,qty_in,checked_in_at"),
        supa.from("inventory_items").select("id,name,unit"),
      ]);
      const tasks = tR.data || [], chk = cR.data || [], items = iR.data || [];
      const itemById = {}; items.forEach((i) => (itemById[i.id] = i));
      // vendor reliability (outsourced tasks)
      const vmap = {};
      tasks.forEach((t) => { if (t.assignee_kind === "outsourced" && t.assignee_name) {
        const v = vmap[t.assignee_name] || { name: t.assignee_name, total: 0, rejected: 0, completed: 0 };
        v.total++; if (t.verify_status === "rejected") v.rejected++; if (t.status === "completed") v.completed++; vmap[t.assignee_name] = v; } });
      const vendors = Object.values(vmap).map((v) => ({ ...v, rejectRate: v.total ? Math.round(v.rejected / v.total * 100) : 0 }))
        .sort((a, b) => b.rejected - a.rejected || b.total - a.total);
      // task slippage by category
      const cmap = {};
      tasks.forEach((t) => { const c = cmap[t.category] || { category: t.category, total: 0, rejected: 0 };
        c.total++; if (t.verify_status === "rejected") c.rejected++; cmap[t.category] = c; });
      const taskSlips = Object.values(cmap).filter((c) => c.rejected > 0)
        .map((c) => ({ ...c, rejectRate: c.total ? Math.round(c.rejected / c.total * 100) : 0 })).sort((a, b) => b.rejected - a.rejected);
      // inventory loss trends (qty_out not fully returned)
      let total = 0; const byItem = {}, byMonth = {};
      chk.forEach((c) => { const out = Number(c.qty_out || 0); const inn = (c.qty_in != null) ? Number(c.qty_in) : out; const lost = Math.max(0, out - inn);
        if (lost > 0) { total += lost; const nm = (itemById[c.item_id] || {}).name || "item"; byItem[nm] = (byItem[nm] || 0) + lost;
          const m = (c.checked_in_at || "").slice(0, 7) || "—"; byMonth[m] = (byMonth[m] || 0) + lost; } });
      const losses = { total,
        byItem: Object.entries(byItem).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty),
        byMonth: Object.entries(byMonth).map(([month, qty]) => ({ month, qty })).sort((a, b) => a.month.localeCompare(b.month)) };
      // margin trends across closed events
      const closed = events.filter((e) => e.lifecycleStage === "closed");
      const pls = await Promise.all(closed.map((e) => closure.pl(e.id)
        .then((pl) => ({ code: e.code, date: e.eventDate, profit: pl.profit, marginPct: pl.marginPct, revenue: pl.revenue })).catch(() => null)));
      const mlist = pls.filter(Boolean).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const totalProfit = mlist.reduce((a, x) => a + (x.profit || 0), 0);
      const avgMargin = mlist.length ? Math.round(mlist.reduce((a, x) => a + (x.marginPct || 0), 0) / mlist.length) : null;
      return { vendors, taskSlips, losses, margins: { events: mlist, totalProfit, avgMargin } };
    },
  };

  /* ---------------- member profiles (0041) — where profiles show up ----------------
     Shared by Control Center → User control, the Staff directory, task pickers, chat and
     the audit log. The DB decides who sees what (member_profile_list hides phone / city /
     emergency contact from colleagues); nothing here assumes a field is present.
     Client checks mirror 0041's SQL validators so mistakes show inline, before a round trip. */
  const MEMBER_AVATAR_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;
  const MEMBER_EMP_TYPES = ["full_time", "part_time", "on_call"];
  let memberListMissing = false;   // member_profile_list not deployed (pre-0041) → plain profiles list
  // Indian mobile → "+91XXXXXXXXXX" (accepts 98765 43210, 098765…, +91 98765…, 91 98765…), else null
  function memberMobile(v) {
    const s = String(v == null ? "" : v).trim(); if (!s || !/^\+?[0-9 ().-]{6,24}$/.test(s)) return null;
    let d = s.replace(/\D/g, "");
    if (d.length === 12 && d.slice(0, 2) === "91") d = d.slice(2); else if (d.length === 11 && d[0] === "0") d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? "+91" + d : null;
  }
  // emergency contact: an Indian mobile, or an international number written with a leading +
  function memberAnyPhone(v) {
    const s = String(v == null ? "" : v).trim(); if (!s) return null;
    const m = memberMobile(s); if (m) return m;
    const d = s.replace(/\D/g, "");
    return /^\+[0-9 ().-]{6,24}$/.test(s) && /^[1-9]\d{7,14}$/.test(d) ? "+" + d : null;
  }
  // same digits rule as the DB's helm_norm_phone (used to spot "the same number written differently")
  function memberNormPhone(p) {
    const d = String(p == null ? "" : p).replace(/\D/g, "");
    if (/^\d{10}$/.test(d)) return "91" + d;
    if (/^0\d{10}$/.test(d)) return "91" + d.slice(1);
    if (/^00\d{8,15}$/.test(d)) return d.slice(2);
    return d;
  }
  // a short text field: trimmed, spaces collapsed, <= max, no < >, no control characters → problem or null
  function memberTextProblem(v, label, max) {
    const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim(); if (!s) return null;
    if ([...s].length > max) return label + " must be " + max + " characters or fewer.";
    if (/[<>]/.test(s)) return label + " can't contain < or >.";
    if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) return label + " can't contain control characters.";
    return null;
  }
  const memberClean = (v) => { const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim(); return s || null; };
  // skills: array (or "a, b") → deduped (case-insensitive) list of trimmed tags
  function memberSkills(v) {
    const a = Array.isArray(v) ? v : String(v == null ? "" : v).split(","); const out = [];
    a.forEach((x) => { const s = memberClean(x); if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s); });
    return out;
  }
  // Validate a profile form (the keys present only). → { field: message } ({} = all good)
  function memberProfileProblems(f) {
    f = f || {}; const bad = {}; const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
    if (has("full_name")) { const p = displayNameProblem(f.full_name); if (p) bad.full_name = p.replace(/^A display name/, "Full name"); }
    if (has("phone")) { if (!String(f.phone == null ? "" : f.phone).trim()) bad.phone = "Mobile number is required.";
      else if (!memberMobile(f.phone)) bad.phone = "Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9."; }
    if (has("whatsapp") && f.whatsapp_same === false && String(f.whatsapp == null ? "" : f.whatsapp).trim() && !memberMobile(f.whatsapp))
      bad.whatsapp = "Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.";
    [["job_title", "Job title"], ["department", "Department"], ["city", "City"], ["emergency_contact_name", "Emergency contact name"]]
      .forEach(([k, label]) => { if (has(k)) { const p = memberTextProblem(f[k], label, 80); if (p) bad[k] = p; } });
    if (has("emergency_contact_phone") && String(f.emergency_contact_phone == null ? "" : f.emergency_contact_phone).trim() && !memberAnyPhone(f.emergency_contact_phone))
      bad.emergency_contact_phone = "Enter a 10-digit Indian mobile, or an international number starting with +.";
    if (has("skills")) { const sk = memberSkills(f.skills);
      if (sk.length > 20) bad.skills = "Add up to 20 skills.";
      else { const b = sk.map((s) => memberTextProblem(s, "A skill", 40)).find(Boolean); if (b) bad.skills = b; } }
    if (has("day_rate") && f.day_rate !== null && String(f.day_rate).trim() !== "") {
      const n = Number(f.day_rate);
      if (!/^\d+(\.\d{1,2})?$/.test(String(f.day_rate).trim()) || !Number.isFinite(n) || n < 0 || n > 10000000)
        bad.day_rate = "Day rate must be between 0 and 1,00,00,000 (up to 2 decimals).";
    }
    if (has("emp_type") && f.emp_type && MEMBER_EMP_TYPES.indexOf(f.emp_type) < 0) bad.emp_type = "Employment type must be full-time, part-time or on-call.";
    return bad;
  }
  // The admin edit: only the fields that CHANGED from the loaded row, normalised the way the
  // DB stores them (so nothing unchanged is re-sent, re-audited or re-synced to the staff row).
  function memberProfilePatch(orig, form) {
    orig = orig || {}; form = form || {}; const out = {}; const has = (k) => Object.prototype.hasOwnProperty.call(form, k);
    const same = (a, b) => (a == null ? null : a) === (b == null ? null : b);
    if (has("full_name")) { const v = cleanDisplayName(form.full_name); if (!same(v || null, memberClean(orig.full_name))) out.full_name = v; }
    if (has("phone")) { const v = memberMobile(form.phone) || memberClean(form.phone); if (!same(v, orig.phone)) out.phone = v; }
    if (has("whatsapp_same")) { const ws = form.whatsapp_same !== false;
      if (ws !== (orig.whatsapp_same !== false)) out.whatsapp_same = ws;
      if (!ws && has("whatsapp")) { const v = memberMobile(form.whatsapp) || memberClean(form.whatsapp); if (!same(v, orig.whatsapp)) out.whatsapp = v; } }
    ["job_title", "department", "city", "emergency_contact_name"].forEach((k) => { if (has(k)) { const v = memberClean(form[k]); if (!same(v, memberClean(orig[k]))) out[k] = v; } });
    if (has("emergency_contact_phone")) { const v = memberAnyPhone(form.emergency_contact_phone) || memberClean(form.emergency_contact_phone);
      if (!same(v, orig.emergency_contact_phone)) out.emergency_contact_phone = v; }
    if (has("skills")) { const v = memberSkills(form.skills), o = memberSkills(orig.skills || []);
      if (v.length !== o.length || v.some((s, i) => s !== o[i])) out.skills = v; }
    if (has("day_rate")) { const raw = form.day_rate; const v = raw === null || String(raw).trim() === "" ? null : Math.round(Number(raw) * 100) / 100;
      const o = orig.day_rate == null ? null : Number(orig.day_rate); if (v !== o) out.day_rate = v; }
    if (has("emp_type")) { const v = form.emp_type || null; if (!same(v, orig.emp_type || null)) out.emp_type = v; }
    return out;
  }
  // a DB business message from 0041 (validation / duplicate number / linked staff row) that is
  // safe to show as-is → that text; anything else → null (the caller uses BPUI.friendlyError)
  function memberErrorText(e) {
    const c = (e && e.code) || "", m = String((e && e.message) || "").trim();
    if (!m || m.length > 300 || /violates|constraint|duplicate key|column|relation|syntax|PGRST|SQLSTATE/i.test(m)) return null;
    if (c === "22023" || c === "23505") return m;
    if (c === "42501" && /linked to (a Helm|an) account|Only a studio admin/i.test(m)) return m;
    return null;
  }
  // chat_directory row → roster person (0041 adds photo / job title / department)
  const chatPerson = (p) => ({ id: p.id, full_name: p.full_name, email_name: p.email_name, role: p.role,
    avatar_path: p.avatar_path || null, job_title: p.job_title || null, department: p.department || null });

  // ---- photos: lazy, batched, short-lived signed URLs, cached for this browser session ----
  // Only our own bucket keys (<studio>/<user>/<uuid>.<ext>) are ever signed — anything else
  // (an outside URL, a data: URI, ../) never loads. Uses BPStore.profile.avatarUrl when the
  // profile module provides one; otherwise the local signer below (one batched call).
  const AV_TTL = 3600, AV_SS = "helm_member_av";
  let avMem = null, avQueue = null;
  function avCache() {
    if (avMem) return avMem; avMem = {};
    try { const o = JSON.parse(sessionStorage.getItem(AV_SS) || "{}"); Object.keys(o).forEach((k) => { if (o[k] && o[k].exp > Date.now() && MEMBER_AVATAR_KEY.test(k)) avMem[k] = o[k]; }); } catch (e) {}
    return avMem;
  }
  function avSave() { try { sessionStorage.setItem(AV_SS, JSON.stringify(avMem || {})); } catch (e) {} }
  async function avSignBatch(paths) {
    const { data, error } = await supa.storage.from("member-avatars").createSignedUrls(paths, AV_TTL);
    if (error) throw error;
    const c = avCache(), exp = Date.now() + (AV_TTL - 300) * 1000;
    (data || []).forEach((r, k) => { const p = (r && r.path) || paths[k]; if (r && r.signedUrl && !r.error && paths.indexOf(p) >= 0) c[p] = { url: r.signedUrl, exp }; });
    avSave();
  }
  async function memberAvatarUrl(path) {
    path = String(path == null ? "" : path);
    if (!path || !MEMBER_AVATAR_KEY.test(path) || mode !== "supabase" || !supa) return null;
    const ext = profile.avatarUrl;
    if (typeof ext === "function" && ext !== memberAvatarUrl) { try { const u = await ext(path); return u || null; } catch (e) { return null; } }
    const hit = avCache()[path]; if (hit && hit.exp > Date.now()) return hit.url;
    if (!avQueue) {
      avQueue = { paths: [], done: null };
      avQueue.done = new Promise((res) => setTimeout(res, 0)).then(() => { const q = avQueue; avQueue = null; return avSignBatch(q.paths.slice(0, 100)); });
    }
    if (avQueue.paths.indexOf(path) < 0) avQueue.paths.push(path);
    try { await avQueue.done; } catch (e) { return null; }
    const got = avCache()[path]; return got ? got.url : null;
  }
  // Fill every <… data-avatar-path="…"> under root with the member's photo (initials stay
  // underneath as the fallback, and come back if the photo fails). Off-screen ones wait until
  // they scroll into view. → Promise (settles when the visible ones are done).
  let avIO = null;
  function avPaintOne(el) {
    const p = el.getAttribute("data-avatar-path"); el.setAttribute("data-av-done", "1");
    if (!p || !MEMBER_AVATAR_KEY.test(p)) return Promise.resolve(false);
    return memberAvatarUrl(p).then((url) => {
      if (!url || el.isConnected === false) return false;
      const img = document.createElement("img");
      img.alt = ""; img.setAttribute("aria-hidden", "true"); img.decoding = "async"; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit";
      img.onerror = () => { try { img.remove(); } catch (e) {} };
      try { const cs = el.style; if (!cs.position) cs.position = "relative"; cs.overflow = "hidden"; } catch (e) {}
      img.src = url; el.appendChild(img); return true;
    }).catch(() => false);
  }
  function paintMemberAvatars(root) {
    const host = root || (typeof document !== "undefined" ? document : null); if (!host || !host.querySelectorAll) return Promise.resolve([]);
    const els = Array.prototype.slice.call(host.querySelectorAll("[data-avatar-path]:not([data-av-done])"));
    if (!els.length) return Promise.resolve([]);
    if (typeof global.IntersectionObserver === "function") {
      if (!avIO) avIO = new global.IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { avIO.unobserve(en.target); avPaintOne(en.target); } }), { rootMargin: "200px" });
      els.forEach((el) => { el.setAttribute("data-av-done", "0"); avIO.observe(el); });
      return Promise.resolve([]);
    }
    return Promise.all(els.map(avPaintOne));
  }
  // Everyone in my studio by id (chat_directory) — photos / job titles for the Staff directory
  // and task pickers (crew_members.profile_id → this). One read per page; {} if unavailable.
  let memberDirPromise = null;
  function memberDirectory() {
    if (!memberDirPromise) memberDirPromise = chat.roster().then((rows) => { const by = {}; (rows || []).forEach((p) => { if (p && p.id) by[p.id] = p; }); return by; })
      .catch(() => { memberDirPromise = null; return {}; });
    return memberDirPromise;
  }

  /* ---------------- audit log (Phase 47) ---------------- */
  const audit = {
    async list(opts) { opts = opts || {}; if (!supa) throw new Error("Supabase not configured");
      let q = supa.from("audit_log").select("*").order("at", { ascending: false }).limit(opts.limit || 150);
      if (opts.entity) q = q.eq("entity", opts.entity);
      if (opts.quoteId) q = q.eq("quote_id", opts.quoteId);
      if (opts.actor) q = q.eq("actor", opts.actor);
      const { data, error } = await q; if (error) throw error; return data; },
    // One page of the log, newest first. Keyset paging (at, id) — a busy log never shifts
    // rows between pages. o.after = the last row shown; o.search matches who / action /
    // area / the identifying fields of the change (code, title, name, status).
    // → { rows, hasMore, offset: <last row, pass back as o.after> }
    async page(opts) { const o = opts || {}; if (!supa) throw new Error("Supabase not configured");
      const limit = pageLimit(o.limit);
      let q = supa.from("audit_log").select("*");
      if (o.entity) q = q.eq("entity", o.entity);
      if (o.quoteId) q = q.eq("quote_id", o.quoteId);
      if (o.actor) q = q.eq("actor", o.actor);
      let s = orIlike(["actor_email", "action", "entity", "changed->>code", "changed->>title", "changed->>name", "changed->>status"], o.search);
      // + people whose display NAME matches the search (ids from actorNames(); uuids only)
      const ids = (Array.isArray(o.actorIds) ? o.actorIds : []).filter((x) => /^[0-9a-f-]{36}$/i.test(String(x))).slice(0, 50);
      if (s && ids.length) s += ",actor.in.(" + ids.join(",") + ")";
      if (s) q = q.or(s);
      if (o.after && o.after.at) { const t = pgQuote(o.after.at); q = q.or("at.lt." + t + (o.after.id ? ",and(at.eq." + t + ",id.lt." + pgQuote(o.after.id) + ")" : "")); }
      const { data, error } = await q.order("at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
      if (error) throw error;
      const d = data || [], rows = d.slice(0, limit);
      return { rows, hasMore: d.length > limit, offset: rows.length ? rows[rows.length - 1] : (o.after || null) }; },
    // Areas for the filter: every audited table, plus any other area seen in the recent
    // log (was: the WHOLE log's entity column, every row, on every visit).
    AREAS: ["app_config", "chair_types", "change_requests", "coupons", "crew_members", "event_costs", "expense_claims", "inventory_checkouts",
      "inventory_items", "member_profiles", "payment_milestones", "plate_types", "profiles", "quote_payments", "quotes", "role_access", "vendors"],
    // Who is who in my studio (audit_actor_names, 0041) → { <user id>: { full_name, email } }.
    // Before 0041 (or no access) → {} and the log keeps showing e-mails.
    async actorNames() { if (!supa) return {};
      const { data, error } = await supa.rpc("audit_actor_names");
      if (error) { if (rpcMissing(error) || (error.code || "") === "42501") return {}; throw error; }
      const by = {}; (data || []).forEach((r) => { if (r && r.id) by[r.id] = { full_name: r.full_name || null, email: r.email || null }; }); return by; },
    // How a row's actor is shown: the display name (e-mail on hover), else the e-mail, else "system".
    actorLabel(row, names) { row = row || {}; const p = (names && row.actor && names[row.actor]) || null;
      const nm = p && String(p.full_name || "").replace(/\s+/g, " ").trim();
      const email = row.actor_email || (p && p.email) || "";
      if (nm) return { text: nm, title: email || nm };
      return { text: email || "system", title: email || "" }; },
    // ids of the people whose display name contains the search (for page({actorIds}))
    actorIdsMatching(names, term) { const t = String(term == null ? "" : term).trim().toLowerCase(); if (!t || !names) return [];
      return Object.keys(names).filter((id) => String((names[id] && names[id].full_name) || "").toLowerCase().indexOf(t) >= 0); },
    async entities() { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("audit_log").select("entity").order("at", { ascending: false }).limit(1000); if (error) throw error;
      return [...new Set(this.AREAS.concat((data || []).map((x) => x.entity).filter(Boolean)))].sort(); },
  };

  const BPStore = {
    init, mode: () => mode, auth, quotes, approval, ops, config, vendors, coupons, chairTypes, plateTypes, dishCatalog, eventMenu, menuTemplates, quotationVersions, layoutRules, people, pricing, org, links, invitations, attendees, sites, leads, discovery, proposal, staff, inventory, resources, bookings, calendar, runsheet, budget, plan, checklist, milestones, readiness, dayops, guests, stockreq, issues, expenses, refunds, media, templates, nurture, settlement, closure, bell, audit, insights, portal, files, chat, profile, quoteShelf,
    // User manual (migration 0031): lives in the PRIVATE storage bucket "helm-manual",
    // readable only by signed-in users. Returns { html, files: { "screenshots/x.webp": signedUrl } }
    // or throws { code: "manual_missing" } when the owner hasn't uploaded it yet.
    manual: {
      BUCKET: "helm-manual",
      async load(seconds) {
        if (!supa) { try { await init(); } catch (e) {} }
        if (!supa || !currentUser) { const e = new Error("Please sign in to read the manual."); e.code = "auth"; throw e; }
        const b = supa.storage.from("helm-manual"), ttl = seconds || 3600;
        const { data: d, error } = await b.download("USER-MANUAL.html");
        if (error || !d) { const e = new Error("The manual hasn't been published yet."); e.code = "manual_missing"; e.cause = error; throw e; }
        const html = await d.text();
        const files = {};
        const { data: shots } = await b.list("screenshots", { limit: 200 });
        const names = (shots || []).map((o) => o && o.name).filter((n) => n && /^[\w.-]+\.(webp|png|jpe?g)$/i.test(n)).map((n) => "screenshots/" + n);
        if (names.length) {
          const { data: signed } = await b.createSignedUrls(names, ttl);
          (signed || []).forEach((r, k) => { if (r && r.signedUrl && !r.error) files[names[k]] = r.signedUrl; });
        }
        return { html, files };
      },
    },
    // Phase 3 — personal dashboard feed: upcoming events + per-event task rollup + unread count.
    // Org- and area-scoped server-side (my_pending is SECURITY DEFINER gated on has_area('quotes','view')).
    pending: () => (supa ? rpc("my_pending") : Promise.resolve({ upcoming: [], unread: 0 })),
    // Build 3 — personal task list bucketed TODAY/OVERDUE/BLOCKED/UPCOMING/COMPLETED.
    // Inherently personal + org-scoped server-side (my_tasks is SECURITY DEFINER, crew_id = caller).
    // Operator-only read RPCs (0029). The database refuses every non-operator (42501).
    hq: (fn, args) => (/^hq_[a-z_]+$/.test(fn) ? rpc(fn, args || {}) : Promise.reject(new Error("bad call"))),
    // 0045 — this studio's Helm subscription (read-only). Every member gets {status, read_only};
    // studio admins also get plan, period and payments. invoice(): admins, own studio only.
    subscription: {
      mine: () => (supa ? rpc("my_subscription").catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      invoice: (id) => rpc("my_invoice", { p_payment_id: id }),
      account: () => (supa ? rpc("my_studio_account").catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      updateAccount: (patch) => rpc("my_studio_account_update", { p_account: patch || {} }),
    },
    myTasks: () => (supa ? rpc("my_tasks") : Promise.resolve({ today: [], overdue: [], blocked: [], upcoming: [], completed: [], counts: {} })),
    // Build 1 — Designer 2D->3D design-approval state machine.
    design: {
      STATES: ["draft_2d","internal_review","approved_2d","build_3d","client_review","approved_3d","locked"],
      NEXT: {   // allowed transitions surfaced as buttons (matches design_advance server map)
        draft_2d: ["internal_review"], internal_review: ["approved_2d","revise"],
        revise: ["draft_2d"], approved_2d: ["build_3d"], build_3d: ["client_review"],
        client_review: ["approved_3d","revise"], approved_3d: ["locked","client_review"], locked: [],
      },
      LABEL: { draft_2d:"2D draft", internal_review:"Internal review", approved_2d:"2D approved",
        build_3d:"Building 3D", client_review:"Client review", approved_3d:"3D approved",
        locked:"Locked", revise:"Needs revision" },
      get: (quoteId) => (supa ? rpc("design_get", { p_quote_id: quoteId }) : Promise.resolve({ quote_id: quoteId, state: null })),
      queue: () => (supa ? rpc("design_queue") : Promise.resolve([])),
      advance: (quoteId, toState, note, expectedUpdatedAt) => rpc("design_advance",
        { p_quote_id: quoteId, p_to_state: toState, p_note: note || null, p_expected_updated_at: expectedUpdatedAt || null }),
    },
    list: () => withFallback((t) => t.list(), (l) => l.list()),
    get: (id) => withFallback((t) => t.get(id), (l) => l.get(id)),
    create: (name, data) => withFallback((t) => t.create(name, data), (l) => l.create(name, data)),
    update: (id, patch) => withFallback((t) => t.update(id, patch), (l) => l.update(id, patch)),
    remove: (id) => withFallback((t) => t.remove(id), (l) => l.remove(id)),
    // MMDDYYYY-NN for a given date, given existing summaries
    nextEventName(summaries, date) {
      const d = date || new Date();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const stamp = mm + dd + d.getFullYear();
      const re = new RegExp("^" + stamp + "-(\\d+)");
      let max = 0;
      (summaries || []).forEach((s) => { const m = re.exec(s.name || ""); if (m) max = Math.max(max, parseInt(m[1], 10)); });
      return stamp + "-" + String(max + 1).padStart(2, "0");
    },
  };
  global.BPStore = BPStore;
  // Protected page: start the auth gate now (init is idempotent), so the sign-in
  // redirect never depends on the page's own boot code running.
  if (PAGE_GATED) Promise.resolve().then(init).catch(() => {});
})(window);

/* =========================================================================
   BPUI — shared, dependency-free UI primitives for every page.
   Every app page already loads store-api.js, so these live here. Components
   inject their own CSS on first use (9 pages don't load theme.css), follow
   html[data-theme="dark"], and honour prefers-reduced-motion.

     BPUI.toast(msg, {type:'ok'|'err'|'info', timeout, action:{label,onClick}})
     BPUI.alert(msg, {title, okLabel})                         → Promise<void>
     BPUI.confirm(msg, {title, okLabel, cancelLabel, danger})  → Promise<boolean>
     BPUI.prompt(msg, {title, label, value, required, multiline, type,
                       placeholder, okLabel, cancelLabel, validate}) → Promise<string|null>
     BPUI.guard(el, asyncFn, {busyLabel})   double-submit guard
     BPUI.isNotFound / isMissingTable / isMissingFunction / isAuthError /
       isNetworkError / isPermissionError(err)
     BPUI.friendlyError(err, {action, setupHint})  → user-facing string
     BPUI.loadError(container, err, retryFn, {what}) inline "Couldn't load — Retry"
     BPUI.boot(asyncFn)                     page bootstrap w/ skeleton + error card
     BPUI.trackDirty(rootEl?) → {mark, clean, isDirty, dispose}
     BPUI.confirmDiscard(isDirtyFnOrTracker) → Promise<boolean>
   Plus automatic enhancement of existing page modals (.lmodal, .modal,
   [role="dialog"], [data-modal]): focus trap, inert background, Escape →
   [data-close], focus restore. And a global offline/online banner.
   ========================================================================= */
(function (global) {
  if (typeof document === "undefined" || global.BPUI) return;
  var doc = document;
  var seq = 0;

  /* ------------------------------------------------------------------ CSS */
  var CSS = [
    ":root{--bpui-bg:#fff;--bpui-ink:#141b2e;--bpui-ink-2:#4a5673;--bpui-line:#86808f;--bpui-soft:#f4f2fb;",
    "--bpui-accent:#6d28d9;--bpui-on-accent:#fff;--bpui-danger:#b91c1c;--bpui-on-danger:#fff;",
    "--bpui-scrim:rgba(20,27,46,.5);--bpui-veil:rgba(246,244,241,.72);--bpui-shadow:0 24px 60px rgba(20,27,46,.3);",
    "--bpui-toast-bg:#1f1b2e;--bpui-toast-ink:#fff;--bpui-toast-act:#d8ccff;--bpui-ok:#34d399;--bpui-err:#f87171;--bpui-info:#a78bfa;",
    "--bpui-warn-bg:#fff4d6;--bpui-warn-ink:#5c3d00;--bpui-warn-line:#e8c26a}",
    "html[data-theme=dark]{--bpui-bg:#1c1c22;--bpui-ink:#f3f1fa;--bpui-ink-2:#c6c2d6;--bpui-line:#75707f;--bpui-soft:#26222f;",
    "--bpui-accent:#7c3aed;--bpui-on-accent:#fff;--bpui-danger:#b91c1c;--bpui-on-danger:#fff;",
    "--bpui-scrim:rgba(0,0,0,.66);--bpui-veil:rgba(0,0,0,.6);--bpui-shadow:0 24px 60px rgba(0,0,0,.7);",
    "--bpui-toast-bg:#2a2635;--bpui-toast-ink:#f3f1fa;--bpui-warn-bg:#3a2f14;--bpui-warn-ink:#ffd884;--bpui-warn-line:#5a4a1e}",
    /* utilities usable on pages without theme.css (zero specificity → pages override) */
    ":where(.sr-only){position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;white-space:nowrap!important;border:0!important}",
    ":where(.skip-link){position:absolute;left:8px;top:-60px;z-index:10000;padding:10px 16px;border-radius:8px;background:var(--bpui-accent);color:var(--bpui-on-accent);font-weight:600;text-decoration:none}",
    ":where(.skip-link:focus){top:8px}",
    /* shared bits */
    ".bpui-overlay,.bpui-boot-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit}",
    ".bpui-overlay{background:var(--bpui-scrim)}",
    ".bpui-dialog,.bpui-card{background:var(--bpui-bg);color:var(--bpui-ink);border:1px solid var(--bpui-line);border-radius:14px;box-shadow:var(--bpui-shadow);",
    "width:min(460px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:22px 22px 18px;box-sizing:border-box;font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:left}",
    ".bpui-dialog h2,.bpui-card h2{margin:0 0 8px;font-size:18px;line-height:1.3;color:var(--bpui-ink)}",
    ".bpui-dialog p,.bpui-card p{margin:0 0 14px;color:var(--bpui-ink-2);white-space:pre-wrap;overflow-wrap:anywhere}",
    ".bpui-dialog label{display:block;font-weight:600;font-size:14px;text-transform:none;letter-spacing:normal;margin:4px 0 6px;color:var(--bpui-ink)}",
    ".bpui-dialog input,.bpui-dialog textarea{width:100%;box-sizing:border-box;min-height:40px;padding:8px 10px;border:1px solid var(--bpui-line);border-radius:8px;",
    "background:var(--bpui-bg);color:var(--bpui-ink);font:inherit}",
    ".bpui-dialog textarea{min-height:96px;resize:vertical}",
    ".bpui-dialog [aria-invalid=true]{border-color:var(--bpui-danger);box-shadow:0 0 0 1px var(--bpui-danger)}",
    ".bpui-dialog .bpui-field-err{color:var(--bpui-danger);font-size:13px;font-weight:600;margin:6px 0 0}",
    "html[data-theme=dark] .bpui-dialog .bpui-field-err{color:#ff9ea3}",
    ".bpui-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:18px}",
    ".bpui-btn{min-height:40px;min-width:44px;padding:0 16px;border-radius:10px;border:1px solid var(--bpui-line);background:var(--bpui-bg);color:var(--bpui-ink);",
    "font:inherit;font-weight:600;cursor:pointer}",
    ".bpui-btn:hover{background:var(--bpui-soft)}",
    ".bpui-btn.bpui-primary{background:var(--bpui-accent);border-color:var(--bpui-accent);color:var(--bpui-on-accent)}",
    ".bpui-btn.bpui-primary:hover{filter:brightness(1.08)}",
    ".bpui-btn.bpui-danger{background:var(--bpui-danger);border-color:var(--bpui-danger);color:var(--bpui-on-danger)}",
    ".bpui-btn:focus-visible,.bpui-toast button:focus-visible,.bpui-dialog :focus-visible{outline:2px solid var(--bpui-accent);outline-offset:2px}",
    ".bpui-btn[disabled]{opacity:.6;cursor:not-allowed}",
    "@media (pointer:coarse){.bpui-btn,.bpui-toast button{min-height:44px}}",
    /* toasts */
    ".bpui-toasts{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483600;display:flex;flex-direction:column;gap:8px;",
    "width:min(520px,calc(100vw - 32px));pointer-events:none}",
    ".bpui-lane{display:flex;flex-direction:column;gap:8px}",
    ".bpui-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;border-radius:10px;background:var(--bpui-toast-bg);",
    "color:var(--bpui-toast-ink);border-left:4px solid var(--bpui-info);box-shadow:0 10px 30px rgba(0,0,0,.3);font:14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    ".bpui-toast.bpui-ok{border-left-color:var(--bpui-ok)}.bpui-toast.bpui-err{border-left-color:var(--bpui-err)}",
    ".bpui-toast-msg{flex:1;min-width:0;overflow-wrap:anywhere}",
    ".bpui-toast button{background:transparent;border:0;color:var(--bpui-toast-act);font:inherit;font-weight:700;cursor:pointer;min-height:32px;min-width:32px;padding:0 8px;border-radius:6px}",
    ".bpui-toast button:hover{background:rgba(255,255,255,.1)}",
    ".bpui-toast .bpui-x{color:var(--bpui-toast-ink);opacity:.85;font-size:18px;line-height:1}",
    /* offline banner */
    ".bpui-offline{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483500;max-width:calc(100vw - 32px);padding:8px 14px;border-radius:999px;",
    "background:var(--bpui-warn-bg);color:var(--bpui-warn-ink);border:1px solid var(--bpui-warn-line);font:600 13px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.15);text-align:center}",
    ".bpui-offline[hidden]{display:none}",
    /* boot skeleton / spinner / error */
    ".bpui-boot-overlay{background:var(--bpui-veil);flex-direction:column;gap:12px;color:var(--bpui-ink)}",
    ".bpui-spin{width:36px;height:36px;border-radius:50%;border:3px solid var(--bpui-line);border-top-color:var(--bpui-accent);box-sizing:border-box}",
    ".bpui-spin2{display:inline-block;width:15px;height:15px;border-radius:50%;border:2px solid var(--bpui-line);border-top-color:var(--bpui-accent);box-sizing:border-box;vertical-align:-2px}",
    ".bpui-loading{display:inline-flex;align-items:center;gap:7px;color:var(--bpui-ink-2);justify-content:center}",
    ":where(#boot){display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:40vh;padding:24px;color:var(--bpui-ink-2)}",
    ":where(#boot[hidden]){display:none}",
    ":where(#boot:empty)::before{content:'';width:36px;height:36px;border-radius:50%;border:3px solid var(--bpui-line);border-top-color:var(--bpui-accent);box-sizing:border-box}",
    ".bpui-boot-overlay .bpui-card,#boot .bpui-card{text-align:center}",
    ".bpui-loaderr{border:1px solid var(--bpui-line);border-radius:12px;padding:16px;margin:8px 0;background:var(--bpui-bg);color:var(--bpui-ink);text-align:center;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    ".bpui-loaderr strong{display:block;margin-bottom:4px;color:var(--bpui-ink)}",
    ".bpui-loaderr p{margin:0 0 10px;color:var(--bpui-ink-2)}",
    /* paged lists: loading row / Load more / end of list (BPUI.pager) */
    ".bpui-pager{display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 8px 4px;color:var(--bpui-ink-2);font:13px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:center}",
    ".bpui-pager[hidden]{display:none}",
    ".bpui-pager .bpui-pager-end{font-size:12px;opacity:.8}",
    ".bpui-pager .bpui-pager-err{color:var(--bpui-ink)}",
    "[aria-busy=true].bpui-busy{cursor:progress}",
    "@media (prefers-reduced-motion:no-preference){",
    ".bpui-overlay{animation:bpuiFade .14s ease-out}.bpui-dialog{animation:bpuiPop .16s ease-out}",
    ".bpui-toast{animation:bpuiUp .18s ease-out}.bpui-spin,.bpui-spin2,:where(#boot:empty)::before{animation:bpuiSpin .8s linear infinite}",
    ".bpui-boot-overlay{animation:bpuiFade .2s ease-out}}",
    /* Reduced-motion users got a FROZEN ring that read as a broken/odd shape. Give the */
    /* spinners a gentle opacity pulse instead so a loading state never looks stuck. */
    "@media (prefers-reduced-motion:reduce){",
    ".bpui-spin,.bpui-spin2,:where(#boot:empty)::before{animation:bpuiPulse 1.1s ease-in-out infinite}}",
    "@keyframes bpuiPulse{0%,100%{opacity:.35}50%{opacity:1}}",
    "@keyframes bpuiFade{from{opacity:0}to{opacity:1}}",
    "@keyframes bpuiPop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}",
    "@keyframes bpuiUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
    "@keyframes bpuiSpin{to{transform:rotate(360deg)}}",
    /* Smoother, more modern spinner on capable browsers: a clean accent arc that fades to */
    /* a faint tail (conic + radial mask), replacing the flat border ring — one shared look */
    /* across every screen. Falls back to the border ring where mask isn't supported. */
    "@supports ((-webkit-mask:radial-gradient(#000,#000)) or (mask:radial-gradient(#000,#000))){",
    ".bpui-spin,:where(#boot:empty)::before{border:none;background:conic-gradient(from 90deg,color-mix(in srgb,var(--bpui-accent) 12%,transparent),var(--bpui-accent));-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3.5px),#000 calc(100% - 3px));mask:radial-gradient(farthest-side,transparent calc(100% - 3.5px),#000 calc(100% - 3px))}",
    ".bpui-spin2{border:none;background:conic-gradient(from 90deg,color-mix(in srgb,var(--bpui-accent) 12%,transparent),var(--bpui-accent));-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 calc(100% - 2px))}}",
    "@media print{.bpui-toasts,.bpui-offline,.bpui-boot-overlay{display:none!important}}",
  ].join("\n");
  function injectCSS() {
    if (doc.getElementById("bpui-style")) return;
    var s = doc.createElement("style");
    s.id = "bpui-style"; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  /* -------------------------------------------------------------- helpers */
  function h(tag, attrs, text) {
    var e = doc.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    if (text != null) e.textContent = String(text);
    return e;
  }
  function whenBody(fn) {
    if (doc.body) return fn();
    doc.addEventListener("DOMContentLoaded", fn, { once: true });
  }
  function reduceMotion() {
    try { return global.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }
  function report(kind, err) {
    try { if (global.HelmTelemetry && global.HelmTelemetry.report) global.HelmTelemetry.report(kind, err); } catch (e) {}
  }

  /* ------------------------------------------------------- error classes */
  function errCode(e) { return e && typeof e === "object" ? String(e.code || "") : ""; }
  function errMsg(e) {
    if (e == null) return "";
    if (typeof e === "string") return e;
    return String(e.message || e.error_description || e.msg || e.error || e.details || "");
  }
  function errStatus(e) {
    if (!e || typeof e !== "object") return 0;
    var s = +(e.status || e.statusCode || 0);
    if (!s) { var m = /^HTTP (\d{3})\b/.exec(errMsg(e)); if (m) s = +m[1]; }
    return s;
  }
  // isNotFound(err)            → PGRST116 ("0 rows" from .single()), HTTP 404
  // isNotFound(null, result)   → true when there was no error but the result is null/undefined
  function isNotFound(e, result) {
    if (e == null) return arguments.length > 1 && result == null;
    if (isMissingTable(e) || isMissingFunction(e)) return false;
    var c = errCode(e), m = errMsg(e);
    return c === "PGRST116" || errStatus(e) === 404 || /\b0 rows\b|no rows|not found/i.test(m);
  }
  function isMissingTable(e) {
    var c = errCode(e), m = errMsg(e);
    return c === "42P01" || c === "PGRST205" ||
      /relation ["'][^"']*["'] does not exist|relation \S+ does not exist|could not find the table/i.test(m);
  }
  // "RPC not deployed" — the function the UI called does not exist in the API /
  // schema cache yet. PostgREST answers a missing RPC with HTTP 404 + code
  // PGRST202 ("Could not find the function … in the schema cache"); Postgres
  // raises 42883. A bare 404 is NOT enough (that is a missing row/route — see
  // isNotFound): only a 404 whose message points at a function / schema-cache
  // miss counts here, so this never swallows an ordinary not-found.
  function isMissingFunction(e) {
    var c = errCode(e), m = errMsg(e);
    if (c === "PGRST202" || c === "42883") return true;
    if (/could not find the function|function \S+ does not exist/i.test(m)) return true;
    if (errStatus(e) === 404 && /function|schema cache/i.test(m)) return true;
    return false;
  }
  function isAuthError(e) {
    if (!e) return false;
    var c = errCode(e), m = errMsg(e), n = (e && e.name) || "";
    if (c === "PGRST301" || c === "PGRST302" || c === "PGRST303" || c === "session_expired" ||
        c === "refresh_token_not_found" || c === "refresh_token_already_used" || c === "bad_jwt" || c === "session_not_found") return true;
    if (n === "AuthSessionMissingError" || n === "AuthInvalidJwtError") return true;
    if (/jwt expired|invalid jwt|jwt malformed|jwserror|invalid (refresh )?token|refresh token not found|auth session missing|session (has )?expired|session not found/i.test(m)) return true;
    // A bare 401 is an auth failure — but not a failed LOGIN (that's "invalid credentials").
    return errStatus(e) === 401 && !/invalid login|credentials/i.test(m);
  }
  function isNetworkError(e) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
    if (!e) return false;
    var m = errMsg(e), n = (e && e.name) || "";
    if (n === "AuthRetryableFetchError" || n === "NetworkError") return true;
    if (/failed to fetch|networkerror|network request failed|load failed|network error|fetch failed|err_internet_disconnected|err_network/i.test(m)) return true;
    return (n === "TypeError" || e instanceof TypeError) && /fetch|network/i.test(m);
  }
  function isPermissionError(e) {
    var c = errCode(e), m = errMsg(e);
    return c === "42501" || errStatus(e) === 403 || /permission denied|not authori[sz]ed|row-level security|insufficient privilege/i.test(m);
  }
  function isAdmin() {
    try { return !!(global.BPStore && global.BPStore.auth.cachedRole && global.BPStore.auth.cachedRole() === "admin"); } catch (e) { return false; }
  }
  var TECHNICAL = /TypeError|ReferenceError|SyntaxError|RangeError|\bundefined\b|\bnull\b|NaN|JSON|Unexpected token|Cannot read|is not a function|is not defined|\bat \S+ \(|violates|constraint|column|relation|syntax error|PGRST|SQLSTATE|stack/i;
  function clip(s, n) { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function endDot(s) { return /[.!?…]$/.test(s) ? s : s + "."; }

  // friendlyError(err, {action:'save the lead', setupHint:'phase29-role-access.sql'}) → string.
  // Never asks END USERS to run SQL; the setup hint is shown only to admins, as an admin notice.
  function friendlyError(e, o) {
    o = o || {};
    var action = o.action ? String(o.action) : "";
    var pre = action ? "Couldn’t " + action + ". " : "";
    if (isAuthError(e)) return "Your session expired — sign in again.";
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "You’re offline — reconnect and try again.";
    if (isNetworkError(e)) return pre + "Couldn’t reach the server — check your connection and try again.";
    if (isPermissionError(e)) return "You don’t have permission to " + (action || "do that") + ".";
    if (isMissingTable(e) || isMissingFunction(e)) {
      if (isAdmin()) return "Admin notice: this feature’s database setup hasn’t been applied yet" +
        (o.setupHint ? " (" + o.setupHint + ")" : "") + ". Apply the pending Supabase migration, then reload.";
      return pre + "This feature isn’t available yet — please contact your administrator.";
    }
    if (isNotFound(e)) return pre + "It may have been deleted, or you may no longer have access.";
    var c = errCode(e), st = errStatus(e), m = errMsg(e);
    if (c === "23505") return pre + "That already exists — use a different value.";
    if (c === "23503") return pre + "It’s linked to other records, so it can’t be changed or removed.";
    if (c === "23502") return pre + "A required field is missing.";
    if (c === "23514" || c === "22P02" || c === "22003" || c === "22007" || c === "22008") return pre + "Some values are invalid — check them and try again.";
    if (c === "40001" || c === "40P01" || st === 409) return pre + "Someone else changed this at the same time — reload and try again.";
    if (c === "57014" || st === 504 || st === 408) return pre + "The server took too long — try again.";
    if (st === 429) return pre + "Too many requests — wait a moment and try again.";
    if (st >= 500) return pre + "The server had a problem — try again in a moment.";
    // Server-raised business errors (P0001 / plain Error thrown by BPStore) are written for users.
    if (m && (c === "P0001" || !c) && !TECHNICAL.test(m) && !/^HTTP \d{3}/.test(m)) return pre + endDot(clip(m, 240));
    return pre + "Something went wrong — please try again.";
  }

  /* ------------------------------------------------------------- toasts */
  var toastRoot = null, lanes = {};
  function ensureToasts() {
    injectCSS();
    if (toastRoot && toastRoot.isConnected) return true;
    if (!doc.body) return false;
    toastRoot = h("div", { class: "bpui-toasts", "data-bpui-keep": "" });
    lanes.polite = h("div", { class: "bpui-lane", role: "status", "aria-live": "polite" });
    lanes.assertive = h("div", { class: "bpui-lane", role: "alert", "aria-live": "assertive" });
    toastRoot.appendChild(lanes.assertive); toastRoot.appendChild(lanes.polite);
    doc.body.appendChild(toastRoot);
    return true;
  }
  // toast(msg, {type:'ok'|'err'|'info', timeout:ms (0 = sticky), action:{label,onClick}})
  // → { close() }. Same message+type already showing → its timer restarts (no stacking).
  function toast(msg, o) {
    o = o || {};
    var type = o.type === "ok" || o.type === "err" ? o.type : "info";
    var timeout = o.timeout != null ? +o.timeout : (type === "err" ? 8000 : 4000);
    var handle = { close: function () {} };
    var run = function () {
      var fresh = !(toastRoot && toastRoot.isConnected);
      if (!ensureToasts()) return;
      var lane = type === "err" ? lanes.assertive : lanes.polite;
      var text = String(msg == null ? "" : msg);
      var existing = null;
      Array.prototype.forEach.call(lane.children, function (t) { if (t.__bpuiKey === type + "|" + text) existing = t; });
      if (existing) { existing.__bpuiArm(); handle.close = existing.__bpuiClose; return; }
      var t = h("div", { class: "bpui-toast bpui-" + type });
      t.__bpuiKey = type + "|" + text;
      var body = h("span", { class: "bpui-toast-msg" });
      t.appendChild(body);
      var timer = null, closed = false;
      function close() {
        if (closed) return; closed = true; clearTimeout(timer);
        if (t.parentNode) t.parentNode.removeChild(t);
      }
      function arm() { clearTimeout(timer); if (timeout > 0) timer = setTimeout(close, timeout); }
      t.__bpuiClose = close; t.__bpuiArm = arm;
      if (o.action && o.action.label) {
        var a = h("button", { type: "button" }, o.action.label);
        a.addEventListener("click", function () { try { o.action.onClick && o.action.onClick(); } finally { if (o.action.keepOpen !== true) close(); } });
        t.appendChild(a);
      }
      var x = h("button", { type: "button", class: "bpui-x", "aria-label": "Dismiss notification" }, "×");
      x.addEventListener("click", close);
      t.appendChild(x);
      // pause while hovered / focused so it can be read and acted on
      t.addEventListener("mouseenter", function () { clearTimeout(timer); });
      t.addEventListener("mouseleave", arm);
      t.addEventListener("focusin", function () { clearTimeout(timer); });
      t.addEventListener("focusout", arm);
      lane.appendChild(t);
      while (lane.children.length > 3) lane.removeChild(lane.firstChild);
      // Set the text AFTER insertion (and after a tick when the live region is
      // brand new) so screen readers reliably announce it.
      var setText = function () { body.textContent = text; };
      if (fresh) setTimeout(setText, 60); else setText();
      arm();
      handle.close = close;
    };
    whenBody(run);
    return handle;
  }

  /* -------------------------------------------------- modal stack manager */
  var MODAL_SEL = '.lmodal, .modal, [role="dialog"], [data-modal]';
  var FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), iframe, audio[controls], video[controls], summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
  var FIELDS = 'input:not([disabled]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), select:not([disabled]), textarea:not([disabled])';
  var stack = [];            // [{el, trigger, inerted:[], lifted:[], onEscape, own}]
  var lastOutside = null;    // last focused element outside any open modal

  function visibleEl(e) {
    if (!e || !e.isConnected || e.hidden) return false;
    if (!e.getClientRects().length) return false;
    var cs = global.getComputedStyle(e);
    return cs.visibility !== "hidden";
  }
  function isShown(e) {
    if (!visibleEl(e)) return false;
    var cs = global.getComputedStyle(e);
    return !(cs.opacity === "0" && cs.pointerEvents === "none");
  }
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (n) {
      return visibleEl(n) && !n.closest("[inert]") && n.tabIndex >= 0;
    });
  }
  function entryOf(el) { for (var i = 0; i < stack.length; i++) if (stack[i].el === el) return stack[i]; return null; }
  function topEntry() {
    while (stack.length && !stack[stack.length - 1].el.isConnected) deactivate(stack[stack.length - 1].el, true);
    return stack[stack.length - 1] || null;
  }
  function focusFirst(el) {
    if (el.contains(doc.activeElement) && doc.activeElement !== el) return;   // page already placed focus
    var t = el.querySelector("[autofocus]");
    if (!t || !visibleEl(t)) t = Array.prototype.filter.call(el.querySelectorAll(FIELDS), visibleEl)[0];
    if (!t) t = focusables(el)[0];
    if (!t) { if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1"); t = el; }
    try { t.focus(); } catch (e) {}
  }
  function activate(el, opts) {
    if (entryOf(el)) return entryOf(el);
    opts = opts || {};
    var ae = doc.activeElement;
    var trigger = (ae && ae !== doc.body && !el.contains(ae)) ? ae : lastOutside;
    var entry = { el: el, trigger: trigger, inerted: [], lifted: [], onEscape: opts.onEscape || null, own: !!opts.own };
    // If this modal (or an ancestor) was made inert by a modal below it, lift that.
    stack.forEach(function (other) {
      other.inerted = other.inerted.filter(function (n) {
        if (n === el || n.contains(el)) { n.removeAttribute("inert"); entry.lifted.push({ owner: other, node: n }); return false; }
        return true;
      });
    });
    // inert every sibling along the ancestor chain up to <body>
    var node = el;
    while (node && node.parentElement && node !== doc.body && node !== doc.documentElement) {
      var parent = node.parentElement;
      Array.prototype.forEach.call(parent.children, function (sib) {
        if (sib === node || sib.hasAttribute("inert") || sib.hasAttribute("data-bpui-keep")) return;
        if (/^(SCRIPT|STYLE|LINK|TEMPLATE|META|NOSCRIPT|TITLE)$/.test(sib.tagName)) return;
        sib.setAttribute("inert", ""); entry.inerted.push(sib);
      });
      node = parent;
    }
    stack.push(entry);
    return entry;
  }
  function deactivate(el, skipFocus) {
    var entry = entryOf(el); if (!entry) return;
    stack.splice(stack.indexOf(entry), 1);
    entry.inerted.forEach(function (n) { n.removeAttribute("inert"); });
    entry.lifted.forEach(function (l) {
      if (stack.indexOf(l.owner) >= 0 && l.node.isConnected && !l.node.hasAttribute("inert")) { l.node.setAttribute("inert", ""); l.owner.inerted.push(l.node); }
    });
    if (skipFocus) return;
    var ae = doc.activeElement;
    var focusLost = !ae || ae === doc.body || el.contains(ae) || !visibleEl(ae);
    var t = entry.trigger;
    if (focusLost && t && t.isConnected && visibleEl(t) && !t.closest("[inert]")) { try { t.focus(); } catch (e) {} }
  }

  function onKeydown(e) {
    if (!stack.length) return;
    var top = topEntry(); if (!top) return;
    if (e.key === "Escape" || e.key === "Esc") {
      if (top.el.getAttribute("data-dismissible") === "false") { if (top.own) { e.preventDefault(); e.stopPropagation(); } return; }
      if (top.onEscape) { e.preventDefault(); e.stopPropagation(); top.onEscape(); return; }
      var c = top.el.querySelector("[data-close]");
      if (c && !c.disabled) { e.preventDefault(); e.stopPropagation(); c.click(); }
      return;
    }
    if (e.key !== "Tab") return;
    var f = focusables(top.el);
    if (!f.length) { e.preventDefault(); try { top.el.focus(); } catch (x) {} return; }
    var first = f[0], last = f[f.length - 1], a = doc.activeElement;
    if (e.shiftKey) { if (a === first || !top.el.contains(a) || a === top.el) { e.preventDefault(); last.focus(); } }
    else if (a === last || !top.el.contains(a)) { e.preventDefault(); first.focus(); }
  }
  function onFocusin(e) {
    var t = e.target;
    var top = stack.length ? topEntry() : null;
    if (!top) { if (t && t !== doc.body) lastOutside = t; return; }
    if (top.el.contains(t) || (t.closest && t.closest("[data-bpui-keep]"))) return;
    var f = focusables(top.el); (f[0] || top.el).focus();   // focus escaped the modal → pull it back
  }

  // ---- automatic enhancement of the pages' own modals ----
  function isCandidate(n) {
    return n.nodeType === 1 && n.matches && n.matches(MODAL_SEL) && !n.closest("[data-bpui]") &&
      n.getAttribute("aria-modal") !== "false" && !n.hasAttribute("data-bpui-skip") &&
      !(n.parentElement && n.parentElement.closest(MODAL_SEL));   // outermost modal element only
  }
  function sync(n) {
    var on = isShown(n), entry = entryOf(n);
    if (on && !entry) {
      activate(n);
      // let the page finish populating the modal before choosing what to focus
      setTimeout(function () { if (entryOf(n) && isShown(n)) focusFirst(n); }, 0);
    } else if (!on && entry) {
      deactivate(n);
    }
  }
  function onMutations(muts) {
    var cands = [], hides = [], shows = [];
    muts.forEach(function (m) {
      if (m.type === "attributes") { if (isCandidate(m.target)) cands.push(m.target); return; }
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) return;
        if (isCandidate(n)) cands.push(n);
        if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll(MODAL_SEL), function (x) { if (isCandidate(x)) cands.push(x); });
      });
    });
    stack.slice().forEach(function (en) { if (!en.own && !en.el.isConnected) deactivate(en.el); });
    // process hides before shows so "close A, open B" in one tick hands focus over cleanly
    cands.forEach(function (n, i) { if (cands.indexOf(n) !== i) return; (isShown(n) ? shows : hides).push(n); });
    hides.forEach(sync); shows.forEach(sync);
  }
  function startModalObserver() {
    Array.prototype.forEach.call(doc.querySelectorAll(MODAL_SEL), function (n) { if (isCandidate(n) && isShown(n)) sync(n); });
    try {
      new MutationObserver(onMutations).observe(doc.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style", "open"],
      });
    } catch (e) {}
  }

  /* ----------------------------------------------- alert / confirm / prompt */
  function dialog(kind, msg, o) {
    o = o || {};
    injectCSS();
    return new Promise(function (resolve) {
      whenBody(function () {
        var id = "bpui-d" + (++seq);
        var cancelValue = kind === "confirm" ? false : kind === "prompt" ? null : undefined;
        var title = o.title || (kind === "alert" ? "Notice" : kind === "confirm" ? "Please confirm" : "");
        var ov = h("div", { class: "bpui-overlay", "data-bpui": "dialog", "data-bpui-keep": "" });
        var form = h("form", { class: "bpui-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": id + "-t", novalidate: "" });
        var text = msg == null ? "" : String(msg);
        var label = kind === "prompt" ? String(o.label || text || "Value") : "";
        // prompt without a title: the message is the heading (and the field's label)
        var heading = title || (kind === "prompt" ? (text || label) : "");
        form.appendChild(h("h2", { id: id + "-t" }, heading));
        if (text && text !== heading) {
          form.appendChild(h("p", { id: id + "-m" }, text));
          form.setAttribute("aria-describedby", id + "-m");
        }
        var input = null, errEl = null;
        if (kind === "prompt") {
          form.appendChild(h("label", { for: id + "-i", class: label === heading || label === text ? "sr-only" : null }, label));
          input = o.multiline ? h("textarea", { id: id + "-i", rows: "4" }) : h("input", { id: id + "-i", type: o.type || "text", autocomplete: "off" });
          if (o.placeholder) input.setAttribute("placeholder", o.placeholder);
          if (o.required) input.setAttribute("aria-required", "true");
          if (o.maxLength) input.setAttribute("maxlength", o.maxLength);
          input.value = o.value == null ? "" : String(o.value);
          errEl = h("p", { id: id + "-e", class: "bpui-field-err", hidden: true });
          form.appendChild(input); form.appendChild(errEl);
        }
        var actions = h("div", { class: "bpui-actions" });
        var cancelBtn = null;
        if (kind !== "alert") {
          cancelBtn = h("button", { type: "button", class: "bpui-btn", "data-close": "" }, o.cancelLabel || "Cancel");
          actions.appendChild(cancelBtn);
        }
        var okBtn = h("button", { type: "submit", class: "bpui-btn " + (o.danger ? "bpui-danger" : "bpui-primary") },
          o.okLabel || (kind === "alert" ? "OK" : kind === "confirm" ? (o.danger ? "Delete" : "OK") : "OK"));
        actions.appendChild(okBtn);
        form.appendChild(actions);
        ov.appendChild(form);

        var done = false;
        function close(val) {
          if (done) return; done = true;
          deactivate(ov);
          if (ov.parentNode) ov.parentNode.removeChild(ov);
          resolve(val);
        }
        function fail(message) {
          errEl.textContent = message; errEl.hidden = false;
          input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", id + "-e");
          input.focus();
        }
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          if (kind !== "prompt") return close(kind === "confirm" ? true : undefined);
          var v = input.value;
          if (o.required && !String(v).trim()) return fail(o.requiredMessage || "This field is required.");
          if (input.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return fail("Enter a valid email address.");
          if (typeof o.validate === "function") { var bad = o.validate(v); if (bad) return fail(String(bad)); }
          close(v);
        });
        if (input) {
          input.addEventListener("input", function () { if (!errEl.hidden) { errEl.hidden = true; input.removeAttribute("aria-invalid"); } });
          if (o.multiline) input.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : okBtn.click(); }
          });
        }
        if (cancelBtn) cancelBtn.addEventListener("click", function () { close(cancelValue); });
        // scrim click cancels alert/confirm (never prompt — don't lose typed input)
        // Close only when the press both starts AND ends on the backdrop itself, and not
        // on the scrollbar — a single scrollbar press used to report e.target===ov and
        // dismiss the dialog (wiping what the user was reading).
        var downOnOv = false;
        ov.addEventListener("mousedown", function (e) {
          downOnOv = false;
          try { var de = document.documentElement; if (e.clientX > de.clientWidth || e.clientY > de.clientHeight) return; } catch (_) {}
          downOnOv = (e.target === ov);
        });
        ov.addEventListener("mouseup", function (e) {
          if (downOnOv && e.target === ov && kind !== "prompt") close(cancelValue);
          downOnOv = false;
        });

        doc.body.appendChild(ov);
        activate(ov, { own: true, onEscape: function () { close(cancelValue); } });
        if (input) { input.focus(); try { input.select(); } catch (e) {} }
        else if (o.danger && cancelBtn) cancelBtn.focus();   // destructive: default to the safe choice
        else okBtn.focus();
      });
    });
  }
  function alertDlg(msg, o) { return dialog("alert", msg, o); }
  function confirmDlg(msg, o) { return dialog("confirm", msg, o); }
  function promptDlg(msg, o) { return dialog("prompt", msg, o); }

  /* --------------------------------------------------------------- guard */
  var busy = typeof WeakSet === "function" ? new WeakSet() : null;
  function guardTargets(el) {
    if (el && el.tagName === "FORM") {
      var list = Array.prototype.slice.call(el.querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]'));
      Array.prototype.forEach.call(doc.querySelectorAll('[form="' + (el.id || "\u0000") + '"]'), function (b) { if (list.indexOf(b) < 0) list.push(b); });
      return list;
    }
    return el ? [el] : [];
  }
  // guard(el, asyncFn, {busyLabel}) — prevents double submits.
  // If el is disabled/aria-disabled or already busy → resolves undefined WITHOUT calling fn.
  // Otherwise sets disabled + aria-busy, awaits fn(), re-enables in finally.
  // Resolves with fn's result; rejects with fn's error (rethrown).
  function guard(el, fn, o) {
    o = o || {};
    if (typeof el === "string") el = doc.querySelector(el);
    if (el && (el.disabled || el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-busy") === "true" || (busy && busy.has(el)))) return Promise.resolve(undefined);
    var targets = guardTargets(el).filter(function (t) { return !t.disabled; });
    var label = null;
    if (el) { if (busy) busy.add(el); el.setAttribute("aria-busy", "true"); el.classList.add("bpui-busy"); }
    targets.forEach(function (t) { t.disabled = true; });
    if (o.busyLabel && el && el.tagName === "BUTTON") { label = el.textContent; el.textContent = o.busyLabel; }
    var restore = function () {
      if (el) { if (busy) busy.delete(el); el.removeAttribute("aria-busy"); el.classList.remove("bpui-busy"); if (label != null) el.textContent = label; }
      targets.forEach(function (t) { t.disabled = false; });
    };
    var p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    return p.then(function (v) { restore(); return v; }, function (e) { restore(); throw e; });
  }

  /* ----------------------------------------------------------- loadError */
  // loadError(container, err, retryFn, {what:'leads'}) — renders an inline
  // "Couldn't load leads — <reason> [Retry]" card into container (replacing its
  // content). A <tbody>/<table> container gets a full-width row. Retry calls
  // retryFn (guarded); if that rejects, the card re-renders with the new error.
  function loadError(container, err, retryFn, o) {
    o = o || {};
    injectCSS();
    if (typeof container === "string") container = doc.querySelector(container);
    if (!container) return null;
    var what = o.what || "this section";
    var card = h("div", { class: "bpui-loaderr", role: "alert" });
    card.appendChild(h("strong", null, "Couldn’t load " + what));
    card.appendChild(h("p", null, friendlyError(err)));
    if (typeof retryFn === "function") {
      var btn = h("button", { type: "button", class: "bpui-btn bpui-primary" }, "Retry");
      btn.addEventListener("click", function () {
        guard(btn, function () { return retryFn(); }).catch(function (e2) { loadError(container, e2, retryFn, o); });
      });
      card.appendChild(btn);
    }
    var node = card;
    var tag = container.tagName;
    if (tag === "TBODY" || tag === "TABLE" || tag === "THEAD" || tag === "TFOOT") {
      var table = tag === "TABLE" ? container : container.closest("table");
      var cols = 1;
      try { var r = table && (table.tHead && table.tHead.rows[0] || table.rows[0]); if (r) { cols = 0; Array.prototype.forEach.call(r.cells, function (c) { cols += c.colSpan || 1; }); } } catch (e) {}
      var tr = h("tr"), td = h("td", { colspan: String(Math.max(cols, 1)) });
      td.appendChild(card); tr.appendChild(td); node = tr;
    }
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(node);
    return card;
  }

  /* ---------------------------------------------------------------- boot */
  // boot(asyncFn, {delay}) — runs the page bootstrap. Shows #boot (if present)
  // or, after `delay` ms (default 150), a spinner overlay. On resolve: hides it,
  // resolves with fn's result. On reject: shows "Something went wrong loading
  // this page" + friendlyError + Reload, reports to telemetry, resolves undefined
  // (never rejects, so no second global error toast).
  function boot(fn, o) {
    o = o || {};
    injectCSS();
    var bootEl = doc.getElementById("boot"), overlay = null, timer = null, finished = false;
    if (bootEl) { bootEl.hidden = false; bootEl.setAttribute("aria-busy", "true"); }
    else timer = setTimeout(function () {
      whenBody(function () {
        if (finished) return;
        overlay = h("div", { class: "bpui-boot-overlay", "data-bpui-keep": "", role: "status", "aria-live": "polite" });
        overlay.appendChild(h("div", { class: "bpui-spin", "aria-hidden": "true" }));
        overlay.appendChild(h("span", { class: "sr-only" }, "Loading…"));
        doc.body.appendChild(overlay);
      });
    }, o.delay == null ? 150 : o.delay);
    function clear() {
      finished = true; clearTimeout(timer);
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (bootEl) { bootEl.hidden = true; bootEl.removeAttribute("aria-busy"); }
    }
    var p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    return p.then(function (v) { clear(); return v; }, function (err) {
      clear();
      try { console.error("[BPUI.boot] page failed to load:", err); } catch (e) {}
      report("boot", err);
      try { if (isAuthError(err) && global.BPStore) global.BPStore.auth.handleAuthError(err); } catch (e) {}
      whenBody(function () { showBootError(err, bootEl); });
      return undefined;
    });
  }
  function showBootError(err, bootEl) {
    var card = h("div", { class: "bpui-card", role: "alert" });
    var hd = h("h2", { tabindex: "-1" }, "Something went wrong loading this page");
    card.appendChild(hd);
    card.appendChild(h("p", null, friendlyError(err)));
    var row = h("div", { class: "bpui-actions" });
    row.style.justifyContent = "center";
    var reload = h("button", { type: "button", class: "bpui-btn bpui-primary" }, "Reload");
    reload.addEventListener("click", function () { location.reload(); });
    var page = "";
    try { page = (location.pathname.split("/").pop() || "").replace(/\.html$/, ""); } catch (e) {}
    if (page !== "dashboard") { var back = h("a", { href: "dashboard.html", class: "bpui-btn" }, "Dashboard"); back.style.cssText = "display:inline-flex;align-items:center;text-decoration:none"; row.appendChild(back); }
    row.appendChild(reload);
    card.appendChild(row);
    if (bootEl) {
      while (bootEl.firstChild) bootEl.removeChild(bootEl.firstChild);
      bootEl.appendChild(card); bootEl.hidden = false;
    } else {
      var wrap = h("div", { class: "bpui-boot-overlay", "data-bpui-keep": "" });
      var dismiss = h("button", { type: "button", class: "bpui-btn" }, "Dismiss");
      dismiss.addEventListener("click", function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); });
      row.insertBefore(dismiss, row.firstChild);
      wrap.appendChild(card); doc.body.appendChild(wrap);
    }
    try { hd.focus(); } catch (e) {}
  }

  /* ---------------------------------------------------- unsaved changes */
  var trackers = [], unloadBypass = false, unloadHooked = false;
  function anyDirty() { for (var i = 0; i < trackers.length; i++) if (trackers[i].isDirty()) return true; return false; }
  function hookUnload() {
    if (unloadHooked) return; unloadHooked = true;
    global.addEventListener("beforeunload", function (e) {
      if (unloadBypass || !anyDirty()) return;
      e.preventDefault(); e.returnValue = ""; return "";
    });
  }
  // trackDirty(rootEl?) → {mark, clean, isDirty, dispose}. With rootEl, any
  // input/change event inside it marks dirty automatically. One shared
  // beforeunload warning is active while ANY tracker is dirty.
  function trackDirty(root) {
    var dirty = false;
    var t = {
      mark: function () { dirty = true; },
      clean: function () { dirty = false; },
      isDirty: function () { return dirty; },
      dispose: function () {
        dirty = false; var i = trackers.indexOf(t); if (i >= 0) trackers.splice(i, 1);
        if (root) { root.removeEventListener("input", t.mark); root.removeEventListener("change", t.mark); }
      },
    };
    if (typeof root === "string") root = doc.querySelector(root);
    if (root) { root.addEventListener("input", t.mark); root.addEventListener("change", t.mark); }
    trackers.push(t); hookUnload();
    return t;
  }
  // confirmDiscard(isDirtyFn | tracker, {title,message}) → Promise<boolean>
  // true = safe to close (not dirty, or the user chose Discard).
  function confirmDiscard(src, o) {
    o = o || {};
    var dirty = false;
    try { dirty = typeof src === "function" ? !!src() : !!(src && src.isDirty && src.isDirty()); } catch (e) {}
    if (!dirty) return Promise.resolve(true);
    return confirmDlg(o.message || "You have unsaved changes. If you close now, they’ll be lost.",
      { title: o.title || "Discard changes?", okLabel: "Discard", cancelLabel: "Keep editing", danger: true });
  }

  /* ------------------------------------------------------ offline banner */
  var offlineEl = null, offlineInstalled = false;
  function installOffline() {
    if (offlineInstalled) return; offlineInstalled = true;
    whenBody(function () {
      injectCSS();
      offlineEl = h("div", { class: "bpui-offline", role: "status", "aria-live": "polite", "data-bpui-keep": "", hidden: true });
      doc.body.appendChild(offlineEl);
      var set = function (on) {
        offlineEl.textContent = on ? "" : "You’re offline — changes won’t be saved until your connection returns.";
        offlineEl.hidden = on;
      };
      if (navigator.onLine === false) set(false);
      global.addEventListener("offline", function () { set(false); });
      global.addEventListener("online", function () { set(true); toast("Back online.", { type: "ok", timeout: 3000 }); });
    });
  }

  /* --------------------------------------------------------------- pager */
  // pager({ after, fetch, render, what, endText, key }) — "Load more" + infinite scroll
  // for a server-paged list.
  //   fetch(offset)  → Promise<{ rows, hasMore, offset }>  (offset = where the next page starts)
  //   render(rows, { reset, all })  paints: reset → replace the list, else append `rows`
  //   after          element the footer (loading row / Load more / end of list) goes after
  // An IntersectionObserver on the footer loads the next page when it scrolls into view.
  // reset() starts over (new filter / search) and resolves after the first page (rejects
  // on error so the page can show its own loadError); a response from before the latest
  // reset is dropped, so fast typing can never paint stale results. Rows already shown
  // (same `key`, default "id") are skipped — offset paging can repeat a row when new
  // ones are inserted above it.
  function pager(o) {
    injectCSS();
    var key = o.key === undefined ? "id" : o.key;
    var st = { gen: 0, offset: 0, hasMore: false, loading: false, err: null, rows: [], seen: {}, auto: 0 };
    var foot = h("div", { class: "bpui-pager", "data-bpui-pager": "", hidden: true });
    if (o.after && o.after.parentNode) o.after.parentNode.insertBefore(foot, o.after.nextSibling);
    var io = null;
    function paint() {
      while (foot.firstChild) foot.removeChild(foot.firstChild);
      if (st.loading) {
        var l = h("span", { class: "bpui-loading", role: "status" });
        l.appendChild(h("i", { class: "bpui-spin2", "aria-hidden": "true" }));
        l.appendChild(doc.createTextNode(st.rows.length ? "Loading more…" : "Loading…"));
        foot.appendChild(l); foot.hidden = false; return;
      }
      if (st.err) {
        var e = h("div", { class: "bpui-pager-err", role: "alert" }, "Couldn’t load more " + (o.what || "") + " — " + friendlyError(st.err));
        var rb = h("button", { type: "button", class: "bpui-btn" }, "Retry");
        rb.addEventListener("click", function () { more(); });
        foot.appendChild(e); foot.appendChild(rb); foot.hidden = false; return;
      }
      if (st.hasMore) {
        var b = h("button", { type: "button", class: "bpui-btn", "data-bpui-more": "" }, "Load more");
        b.addEventListener("click", function () { st.auto = 0; more(); });
        foot.appendChild(b); foot.hidden = false; return;
      }
      if (st.rows.length && o.endText !== false) {
        foot.appendChild(h("span", { class: "bpui-pager-end" }, typeof o.endText === "function" ? o.endText(st.rows.length) : "End of list · " + st.rows.length + " shown"));
        foot.hidden = false; return;
      }
      foot.hidden = true;
    }
    function visible() {
      try { if (!foot.isConnected || foot.hidden || foot.offsetParent === null) return false;
        var r = foot.getBoundingClientRect(); return r.top < (global.innerHeight || 800) + 300 && r.bottom > -300; } catch (e) { return false; }
    }
    // a short page can leave the footer on screen (the observer won't fire again):
    // keep going, but at most 10 automatic pages in a row without a scroll / click
    function check() { if (st.hasMore && !st.loading && !st.err && st.auto < 10 && visible()) { st.auto++; more(); } }
    function load(reset) {
      if (st.loading && !reset) return Promise.resolve();
      if (reset) { st.gen++; st.offset = 0; st.hasMore = false; st.rows = []; st.seen = {}; st.auto = 0; }
      var gen = st.gen, from = st.offset;
      st.loading = true; st.err = null; paint();
      return Promise.resolve().then(function () { return o.fetch(from); }).then(function (r) {
        if (gen !== st.gen) return;
        r = r || {};
        var rows = (r.rows || []).filter(function (x) {
          if (!key || !x || x[key] == null) return true;
          if (st.seen[x[key]]) return false; st.seen[x[key]] = 1; return true;
        });
        st.rows = st.rows.concat(rows);
        st.offset = r.offset != null ? r.offset : from + (r.rows || []).length;
        st.hasMore = !!r.hasMore; st.loading = false;
        try { o.render(rows, { reset: !!reset, all: st.rows }); } finally { paint(); }
        setTimeout(check, 0);
      }, function (e) {
        if (gen !== st.gen) return;
        st.loading = false;
        if (reset) { paint(); foot.hidden = true; throw e; }
        st.err = e; paint();
      });
    }
    function more() { return load(false); }
    if (typeof global.IntersectionObserver === "function") {
      try {
        io = new global.IntersectionObserver(function (ents) {
          ents.forEach(function (en) { if (en.isIntersecting && st.hasMore && !st.loading && !st.err) { st.auto = 0; more(); } });
        }, { rootMargin: "300px 0px" });
        io.observe(foot);
      } catch (e) { io = null; }
    }
    return {
      el: foot,
      reset: function () { return load(true); },
      more: more,
      rows: function () { return st.rows.slice(); },
      hasMore: function () { return st.hasMore; },
      loading: function () { return st.loading; },
      // keep the shown list in step with a local delete (no refetch)
      remove: function (id) { st.rows = st.rows.filter(function (x) { return !x || x[key] !== id; }); if (st.offset > 0) st.offset--; paint(); },
      destroy: function () { st.gen++; if (io) try { io.disconnect(); } catch (e) {} if (foot.parentNode) foot.parentNode.removeChild(foot); },
    };
  }
  // debounce(fn, ms) — the search box waits for a pause in typing before querying
  function debounce(fn, ms) {
    var t = null;
    return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms == null ? 300 : ms); };
  }

  /* --------------------------------------------------------------- wire */
  global.addEventListener("keydown", onKeydown, true);
  doc.addEventListener("focusin", onFocusin, true);
  function start() { injectCSS(); startModalObserver(); installOffline(); }
  if (doc.readyState !== "loading") start(); else doc.addEventListener("DOMContentLoaded", start, { once: true });

  global.BPUI = {
    version: 1,
    toast: toast,
    alert: alertDlg, confirm: confirmDlg, prompt: promptDlg,
    guard: guard,
    isNotFound: isNotFound, isMissingTable: isMissingTable, isMissingFunction: isMissingFunction,
    // readable alias for pages that branch on "the RPC this UI needs isn't deployed"
    isRpcMissing: isMissingFunction,
    isAuthError: isAuthError, isNetworkError: isNetworkError, isPermissionError: isPermissionError,
    friendlyError: friendlyError,
    loadError: loadError,
    boot: boot,
    pager: pager, debounce: debounce,
    trackDirty: trackDirty, confirmDiscard: confirmDiscard,
    hasUnsavedChanges: anyDirty,
    allowUnload: function () { unloadBypass = true; },
    // manual hooks for modals the observer can't see (rare): open → trap, close → restore
    modal: {
      open: function (el) { var en = activate(el); setTimeout(function () { focusFirst(el); }, 0); return en; },
      close: function (el) { deactivate(el); },
    },
    installOfflineBanner: installOffline,
  };
})(window);

/* =========================================================================
   Wave 16 — shared input validation + global numeric-input hardening.
   Root-cause fix: every page already loads store-api.js, so a single global
   guard here hardens EVERY input[type=number] across all 45 pages at once,
   and BPStore.validate.* gives composable, business-semantic submit checks.
   Design rules:
     - HTML min= does NOT block typed/pasted values; JS must enforce it.
     - Negatives are denied by DEFAULT. A field that legitimately allows a
       negative opts in with the attribute data-allow-negative (e.g. builder
       coordinates, financial credit/debit). Business rule per field, not global.
     - Reject NaN / Infinity / scientific notation / letters / stray symbols.
   ========================================================================= */
(function (global) {
  var BPStore = global.BPStore; if (!BPStore) return;

  // ---- composable value validators. each returns {ok, value?, error?} ----
  function core(raw, opt) {
    opt = opt || {};
    if (raw == null) return { ok: false, error: "is required" };
    var s = String(raw).trim();
    if (s === "") return { ok: false, error: "is required" };
    var re = opt.integer ? /^[+-]?\d+$/ : /^[+-]?\d+(\.\d+)?$/;   // no e-notation, no letters
    if (!re.test(s)) return { ok: false, error: opt.integer ? "must be a whole number" : "must be a number" };
    var n = Number(s);
    if (!isFinite(n)) return { ok: false, error: "must be a finite number" };
    if (!opt.allowNeg && n < 0) return { ok: false, error: "cannot be negative" };
    if (opt.min != null && n < opt.min) return { ok: false, error: "must be at least " + opt.min };
    if (opt.max != null && n > opt.max) return { ok: false, error: "must be at most " + opt.max };
    if (opt.gtZero && n <= 0) return { ok: false, error: "must be greater than 0" };
    return { ok: true, value: n };
  }
  var V = {
    // integer count >= 0 (guests, chairs, seats, stock qty). allowZero default true.
    count: function (raw, o) { o = o || {}; var r = core(raw, { integer: true, min: o.allowZero === false ? 1 : 0, max: o.max }); return r.ok ? r : { ok: false, error: (o.field || "Value") + " " + r.error }; },
    // money >= 0, 2-dp (price, amount, cost, rate, decor).
    money: function (raw, o) { o = o || {}; var r = core(raw, { min: 0, max: o.max }); if (!r.ok) return { ok: false, error: (o.field || "Amount") + " " + r.error }; return { ok: true, value: Math.round(r.value * 100) / 100 }; },
    // percentage 0..100.
    pct: function (raw, o) { o = o || {}; var r = core(raw, { min: 0, max: 100 }); return r.ok ? r : { ok: false, error: (o.field || "Percentage") + " must be between 0 and 100" }; },
    // physical dimension > 0 (hall/stage/table length/breadth/height).
    dimension: function (raw, o) { o = o || {}; var r = core(raw, { gtZero: true }); return r.ok ? r : { ok: false, error: (o.field || "Dimension") + " " + r.error }; },
    // generic number with explicit opts (allowNeg, min, max, integer).
    num: core,
    phone: function (raw) { var s = String(raw == null ? "" : raw).trim(); if (!s) return { ok: false, error: "Phone number is required" }; var c = s.replace(/[\s\-().]/g, ""); if (!/^\+?\d{7,15}$/.test(c)) return { ok: false, error: "Enter a valid phone number (7–15 digits, optional leading +)" }; return { ok: true, value: c }; },
    email: function (raw) { var s = String(raw == null ? "" : raw).trim(); if (!s) return { ok: false, error: "Email is required" }; if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { ok: false, error: "Enter a valid email address" }; return { ok: true, value: s.toLowerCase() }; },
    required: function (raw, label) { var s = String(raw == null ? "" : raw).trim(); return s ? { ok: true, value: s } : { ok: false, error: (label || "This field") + " is required" }; },
    url: function (raw) { var s = String(raw == null ? "" : raw).trim(); if (!s) return { ok: false, error: "URL is required" }; if (!/^https?:\/\/[^\s]+$/i.test(s)) return { ok: false, error: "Enter a valid http(s) URL" }; return { ok: true, value: s }; },
    // validate a list; returns {ok, errors:[...], value:{}}. spec = [[getter,'kind',opts]]
    all: function (checks) { var out = { ok: true, errors: [] }; checks.forEach(function (c) { var r = c; if (!r.ok) { out.ok = false; out.errors.push(r.error); } }); return out; }
  };
  BPStore.validate = V;

  // ---- amount in words (Indian numbering: crore/lakh/thousand) — QA M-07 -----
  // Used on quotes/invoices so a large manually-influenced total is unambiguous
  // ("₹5,36,000" → "Rupees Five Lakh Thirty Six Thousand only").
  BPStore.amountInWords = function (amount) {
    var num = Math.round(Math.abs(Number(amount) || 0));
    if (num === 0) return "Rupees Zero only";
    var a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
      "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    var b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
    function two(n) { return n < 20 ? a[n] : (b[Math.floor(n / 10)] + (n % 10 ? " " + a[n % 10] : "")); }
    function three(n) { return (n >= 100 ? a[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " : "") : "") + (n % 100 ? two(n % 100) : ""); }
    var out = "";
    var crore = Math.floor(num / 10000000); num %= 10000000;
    var lakh = Math.floor(num / 100000); num %= 100000;
    var thousand = Math.floor(num / 1000); num %= 1000;
    if (crore) out += three(crore) + " Crore ";
    if (lakh) out += two(lakh) + " Lakh ";
    if (thousand) out += two(thousand) + " Thousand ";
    if (num) out += three(num);
    return "Rupees " + out.trim() + " only";
  };

  // ---- global input[type=number] hardener -------------------------------
  if (typeof document === "undefined") return;
  function harden(el) {
    if (el.getAttribute("data-hardened") === "1") return;
    el.setAttribute("data-hardened", "1");
    var allowNeg = el.hasAttribute("data-allow-negative");
    var stepAttr = el.getAttribute("step");
    var integer = el.hasAttribute("data-integer") || stepAttr === "1";
    if (!el.getAttribute("inputmode")) el.setAttribute("inputmode", integer ? "numeric" : "decimal");
    if (!allowNeg && el.getAttribute("min") == null) el.setAttribute("min", "0");
    el.addEventListener("keydown", function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "e" || e.key === "E" || e.key === "+") { e.preventDefault(); return; }
      if (e.key === "-" && !allowNeg) { e.preventDefault(); return; }
      if (e.key === "." && integer) { e.preventDefault(); return; }
    });
    var fix = function () {
      var v = String(el.value).trim();
      if (v === "") return;
      var n = Number(v);
      if (!isFinite(n)) { el.value = ""; el.dispatchEvent(new Event("change", { bubbles: true })); return; }
      if (!allowNeg && n < 0) n = 0;
      var mn = el.getAttribute("min"), mx = el.getAttribute("max");
      if (mn !== null && mn !== "" && n < Number(mn)) n = Number(mn);
      if (mx !== null && mx !== "" && n > Number(mx)) n = Number(mx);
      // Default sanity cap (QA H-06): no realistic money/qty/count field exceeds a
      // trillion, and values past Number.MAX_SAFE_INTEGER silently lose precision.
      // Fields that genuinely need more set their own higher max=.
      else if ((mx === null || mx === "") && n > 1e12) n = 1e12;
      if (integer) n = Math.trunc(n);
      var s = String(n);
      if (s !== el.value) { el.value = s; el.dispatchEvent(new Event("change", { bubbles: true })); }
    };
    // Live sanitiser: keydown blocks typed junk, but PASTE and programmatic sets slip
    // through until blur — and live consumers read .value on `input` before blur ever
    // fires. Strip letters/symbols (and the sign/decimal where not allowed) on every
    // input and after a paste, so a pasted "-5", "5e3" or "12.5x" can never reach a
    // consumer. The blur `fix` still does the final min/max clamp.
    var strip = function () {
      var v = String(el.value);
      var cleaned = v.replace(allowNeg ? /[^\d.\-]/g : /[^\d.]/g, "");
      if (integer) cleaned = cleaned.replace(/\./g, "");
      if (allowNeg) { var neg = cleaned.charAt(0) === "-"; cleaned = (neg ? "-" : "") + cleaned.replace(/-/g, ""); }
      // keep only the first decimal point
      var dot = cleaned.indexOf(".");
      if (dot !== -1) cleaned = cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, "");
      if (cleaned !== v) el.value = cleaned;
    };
    el.addEventListener("input", strip);
    el.addEventListener("paste", function () { setTimeout(strip, 0); });
    el.addEventListener("blur", fix);
  }

  // ---- phone hardener: digits only (plus one optional leading +) --------
  // Phone fields are type="tel"/inputmode="tel". Browsers do NOT restrict what
  // you can type into a tel input, so letters/symbols used to be accepted and
  // only caught on save. This live-strips every keystroke/paste down to a single
  // optional leading '+' and digits, caps the length, and leaves the final
  // range check to BPStore.validate.phone (7–15 digits). It never reformats
  // beyond stripping, so existing +91… numbers keep working.
  function isPhone(el) {
    return el.tagName === "INPUT" && (el.type === "tel" || (el.getAttribute("inputmode") || "").toLowerCase() === "tel" || el.hasAttribute("data-phone"));
  }

  // ---- international phone component (QA M-01) -------------------------------
  // A country dropdown + number field that STORES E.164 (+<dial><national>). The input
  // itself always holds the full E.164 string, so the ~40 pages that read $("#x_phone").value
  // and run BPStore.validate.phone keep working unchanged. The dropdown just sets/replaces
  // the leading +dial; the default country comes from Control Center (org settings), India
  // fallback. [name, iso2, dial]; India first; US/CA share +1 (display picks the first).
  var COUNTRIES = [
    ["India","IN","91"],["UAE","AE","971"],["United Kingdom","GB","44"],["USA","US","1"],
    ["Saudi Arabia","SA","966"],["Singapore","SG","65"],["Australia","AU","61"],["Canada","CA","1"],
    ["Qatar","QA","974"],["Kuwait","KW","965"],["Bahrain","BH","973"],["Oman","OM","968"],
    ["Malaysia","MY","60"],["Indonesia","ID","62"],["Philippines","PH","63"],["Thailand","TH","66"],
    ["Sri Lanka","LK","94"],["Nepal","NP","977"],["Bangladesh","BD","880"],["Pakistan","PK","92"],
    ["New Zealand","NZ","64"],["South Africa","ZA","27"],["Nigeria","NG","234"],["Kenya","KE","254"],
    ["Germany","DE","49"],["France","FR","33"],["Italy","IT","39"],["Spain","ES","34"],
    ["Netherlands","NL","31"],["Ireland","IE","353"],["Switzerland","CH","41"],["Sweden","SE","46"],
    ["Hong Kong","HK","852"],["Japan","JP","81"],["China","CN","86"]
  ];
  var DIALS = COUNTRIES.map(function (c) { return c[2]; }).sort(function (a, b) { return b.length - a.length; });
  var _defaultCC = (function () { try { return localStorage.getItem("helm_org_country") || "IN"; } catch (e) { return "IN"; } })();
  function loadDefaultCountry() {
    // Signed-out pages (login, client token pages) must not call the members-only
    // get_pricing_config RPC — it 401s for anon and floods the API logs (Oct 2026).
    try { BPStore.init().then(function () {
      if (BPStore.mode() === "supabase" && !BPStore.auth.user()) return null;
      return BPStore.config.getPricing();
    }).then(function (p) { if (!p) return; var c = p.country || "IN"; _defaultCC = c; try { localStorage.setItem("helm_org_country", c); } catch (e) {} }).catch(function () {}); } catch (e) {}
  }
  function dialOf(iso) { for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][1] === iso) return COUNTRIES[i][2]; return "91"; }
  BPStore.countries = function () { return COUNTRIES.map(function (c) { return { name: c[0], iso: c[1], dial: c[2] }; }); };
  function matchDial(e164) { if (!e164 || e164.charAt(0) !== "+") return null; var d = e164.slice(1); for (var i = 0; i < DIALS.length; i++) if (d.indexOf(DIALS[i]) === 0) return DIALS[i]; return null; }

  function hardenPhone(el) {
    if (el.getAttribute("data-phone-hardened") === "1") return;
    el.setAttribute("data-phone-hardened", "1");
    el.setAttribute("inputmode", "tel");
    if (!el.getAttribute("maxlength")) el.setAttribute("maxlength", "16"); // +<dial>+<=15 digits
    var maxLen = parseInt(el.getAttribute("maxlength") || "16", 10) || 16;
    var clean = function () {
      var v = String(el.value); var lead = v.charAt(0) === "+" ? "+" : ""; var digits = v.replace(/[^\d]/g, "");
      var next = lead + digits;
      if (next.length > maxLen) next = next.slice(0, maxLen);
      if (next !== el.value) { var atEnd = el.selectionStart === el.value.length; el.value = next; if (atEnd) { try { el.setSelectionRange(next.length, next.length); } catch (e) {} } }
    };
    var sel = null;
    try {
      if (el.parentNode && !el.getAttribute("data-no-country")) {
        var wrap = document.createElement("span"); wrap.className = "bpui-tel";
        sel = document.createElement("select"); sel.className = "bpui-tel-cc"; sel.setAttribute("aria-label", "Country dialing code");
        COUNTRIES.forEach(function (c) { var o = document.createElement("option"); o.value = c[1]; o.textContent = c[1] + " +" + c[2]; sel.appendChild(o); });
        el.parentNode.insertBefore(wrap, el); wrap.appendChild(sel); wrap.appendChild(el);
      }
    } catch (e) { sel = null; }
    var syncSel = function () { if (!sel) return; var d = matchDial(String(el.value || "")); if (d) { for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][2] === d) { sel.value = COUNTRIES[i][1]; return; } } else { sel.value = _defaultCC; } };
    syncSel();
    el.addEventListener("input", function () { clean(); syncSel(); });
    el.addEventListener("focus", function () { if (sel && el.value === "") { el.value = "+" + dialOf(sel.value); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} } });
    el.addEventListener("blur", function () {
      clean();
      // if only a bare dial code remains (focused but no number typed), treat as empty
      if (/^\+\d{1,4}$/.test(el.value) && DIALS.indexOf(el.value.slice(1)) !== -1) { el.value = ""; }
    });
    if (sel) sel.addEventListener("change", function () {
      var newDial = dialOf(sel.value); var v = String(el.value); var oldDial = matchDial(v);
      var national = oldDial ? v.slice(1 + oldDial.length) : v.replace(/[^\d]/g, "");
      el.value = national ? ("+" + newDial + national) : "";
      try { el.focus(); } catch (e) {}
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // ---- required-field marker: a real "*" beside the label + aria-required
  // Any field explicitly marked required (required / aria-required="true" /
  // data-required) gets a visible red "*" appended to its <label> (idempotent —
  // never doubles up), and aria-required so assistive tech announces it. The
  // asterisk carries aria-hidden so screen readers hear "required", not "star".
  function labelFor(el) {
    var id = el.id;
    if (id) { var l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'); if (l) return l; }
    var p = el.closest && el.closest("label");
    return p || null;
  }
  function markRequired(el) {
    if (el.getAttribute("data-req-marked") === "1") return;
    var req = el.hasAttribute("required") || el.getAttribute("aria-required") === "true" || el.hasAttribute("data-required");
    if (!req) return;
    el.setAttribute("data-req-marked", "1");
    el.setAttribute("aria-required", "true");
    var lab = labelFor(el);
    if (lab && lab.querySelector(".req-star")) return;      // already has one
    if (lab && lab.textContent.indexOf("*") !== -1) return;  // author already wrote a *
    if (lab) {
      var star = document.createElement("span");
      star.className = "req-star"; star.setAttribute("aria-hidden", "true"); star.textContent = " *";
      lab.appendChild(star);
    }
  }

  // ---- date hardener: reject implausible years (QA H-03) --------------------
  // A native date input still accepts typed/pasted years like 0026 or 61115. We
  // bound every date field to a sane window (2000–2100 by default — covers any
  // real event, birthday or anniversary) and clear an out-of-range value so a
  // nonsense year can't be saved or propagated. A field needing a different window
  // sets its own min=/max=.
  var DATE_MIN = "2000-01-01", DATE_MAX = "2100-12-31";
  function hardenDate(el) {
    if (el.getAttribute("data-date-hardened") === "1") return;
    el.setAttribute("data-date-hardened", "1");
    // Event/booking fields opt into a "no past dates" floor with data-min-today.
    // (Birthdays, anniversaries and DOB fields leave it off so past dates stay allowed.)
    if (el.hasAttribute("data-min-today") && !el.getAttribute("min")) {
      el.setAttribute("min", new Date().toISOString().slice(0, 10));
    }
    if (!el.getAttribute("min")) el.setAttribute("min", DATE_MIN);
    if (!el.getAttribute("max")) el.setAttribute("max", DATE_MAX);
    var lo = el.getAttribute("min"), hi = el.getAttribute("max");
    var fix = function () {
      var v = el.value; if (!v) return;
      var y = parseInt(String(v).slice(0, 4), 10);
      if (!isFinite(y) || y < 2000 || y > 2100 || (v < lo) || (v > hi)) {
        el.value = ""; el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    el.addEventListener("blur", fix); el.addEventListener("change", fix);
  }

  function scan(root) {
    var r = root || document;
    try { r.querySelectorAll('input[type="number"]:not([data-hardened])').forEach(harden); } catch (e) {}
    try { r.querySelectorAll('input[type="tel"]:not([data-phone-hardened]), input[inputmode="tel"]:not([data-phone-hardened]), input[data-phone]:not([data-phone-hardened])').forEach(hardenPhone); } catch (e) {}
    try { r.querySelectorAll('input[type="date"]:not([data-date-hardened])').forEach(hardenDate); } catch (e) {}
    try { r.querySelectorAll('[required]:not([data-req-marked]), [aria-required="true"]:not([data-req-marked]), [data-required]:not([data-req-marked])').forEach(markRequired); } catch (e) {}
  }
  function boot() {
    try {
      var st = document.createElement("style");
      st.textContent = ".req-star{color:var(--danger,#c0392b);font-weight:700}"
        + ".bpui-tel{display:flex;align-items:stretch;gap:0;width:100%}"
        + ".bpui-tel>.bpui-tel-cc{flex:0 0 auto;max-width:40%;border:1px solid var(--line,#d9d4cc);border-right:0;border-radius:9px 0 0 9px;background:var(--panel-2,#f4f1ea);color:var(--ink,#1b1930);font:inherit;padding:0 6px}"
        + ".bpui-tel>input{flex:1 1 auto;min-width:0;border-radius:0 9px 9px 0!important}";
      document.head.appendChild(st);
    } catch (e) {}
    loadDefaultCountry();
    scan(document);
    try {
      var mo = new MutationObserver(function (muts) {
        muts.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes || [], function (nd) {
          if (nd.nodeType === 1) {
            if (nd.matches && nd.matches('input[type="number"]')) harden(nd);
            if (nd.matches && isPhone(nd)) hardenPhone(nd);
            if (nd.matches && nd.matches('input[type="date"]')) hardenDate(nd);
            if (nd.matches && (nd.hasAttribute("required") || nd.getAttribute("aria-required") === "true" || nd.hasAttribute("data-required"))) markRequired(nd);
            scan(nd);
          }
        }); });
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
})(window);
