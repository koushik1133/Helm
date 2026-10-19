/* App layout loader: shell-proto.js decides (allowlist) which signed-in studio pages get the sidebar layout. All hosts. */
(function () { try { if (!document.getElementById("shellProto")) {
  var s = document.createElement("script"); s.id = "shellProto"; s.src = "/shell-proto.js?v=37"; document.head.appendChild(s); } } catch (e) {} })();
/* 0173 free-trial lock (trial studios only; a paid studio gets "not a trial" and nothing changes) */
/* 0181: a studio last seen in its trial gets html.helm-trial at once (cached flag), so export / render buttons never
   flash usable; trial-lock.js takes it back off if the server says "not a trial". App pages already did this in <head>
   (shell-proto.js, trial-early.js); this is the fallback for every other page. */
(function () { try { if (localStorage.getItem("helm.trial") === "1") { var d = document.documentElement;
  if (!d.classList.contains("helm-trial")) { d.classList.add("helm-trial"); d.classList.add("helm-trial-early"); }
  if (!document.getElementById("trialLockCss")) { var l = document.createElement("link"); l.id = "trialLockCss"; l.rel = "stylesheet"; l.href = "/trial-lock.css?v=8"; document.head.appendChild(l); } } } catch (e) {} })();
(function () { try { if (!document.getElementById("trialLock")) {
  var s = document.createElement("script"); s.id = "trialLock"; s.src = "/trial-lock.js?v=9"; document.head.appendChild(s); } } catch (e) {} })();
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
/* ---- 0067 pretty studio URLs: HelmUrl (sync core) ---------------------------------
   https://www.helm.events/<studio>/<section>[/<ref>[/<sub>]]  →  the existing pages
   (vercel.json rewrites; server.js prettyPage mirrors them). <studio> is the studio's
   link name (organizations.public_slug); <ref> is an event number, a client ref or a
   booklet token. HelmUrl.build(kind, params) is the ONE place app links are made;
   HelmUrl.parse(path) the one place they are read. Every value is encodeURIComponent'd
   and every path starts with "/<slug>/" from a fixed section list (no open redirect). */
var HelmUrl = (function (global) {
  var SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // kind → [section, sub, page, legacy query key]
  var KINDS = {
    dashboard: ["dashboard", "", "dashboard", ""], quotes: ["quotes", "", "quotes", ""], leads: ["leads", "", "leads", ""],
    chat: ["chat", "", "chat", ""], settings: ["settings", "", "control", ""],
    event: ["events", "", "event", "id"], "floor-plan": ["events", "floor-plan", "builder", "quote"], tasks: ["events", "tasks", "ops", "quote"],
    client: ["clients", "", "client", "id"], booklet: ["booklet", "", "booklet", "t"]
  };
  // plain sidebar pages served at /<studio>/<page> (no ref); control is reached via "settings"
  "audit|inventory|staff|vendors|templates|business|insights|reports|crm|nurture|calendar|onboarding|integrations|settlement|discovery|proposal|budget|closure|runsheet|resources|logistics|teardown|command|ready|flow".split("|").forEach(function (p) { KINDS[p] = [p, "", p, ""]; });
  var PAGE_KIND = { dashboard: "dashboard", quotes: "quotes", leads: "leads", chat: "chat", control: "settings",
    event: "event", builder: "floor-plan", ops: "tasks", client: "client", booklet: "booklet" };
  Object.keys(KINDS).forEach(function (k) { if (!PAGE_KIND[KINDS[k][2]]) PAGE_KIND[KINDS[k][2]] = k; });
  var RE = /^\/([a-z0-9-]{3,40})\/(dashboard|quotes|leads|chat|settings|events|clients|booklet|audit|inventory|staff|vendors|templates|business|insights|reports|crm|nurture|calendar|onboarding|integrations|control|settlement|discovery|proposal|budget|closure|runsheet|resources|logistics|teardown|command|ready|flow)(?:\/([^/?#]{1,160})(?:\/(floor-plan|tasks))?)?\/?$/;
  var slug = null;
  try { var s0 = global.sessionStorage && sessionStorage.getItem("bp_studio_slug"); if (s0 && SLUG.test(s0)) slug = s0; } catch (e) {}
  function dec(v) { try { return decodeURIComponent(v); } catch (e) { return null; } }
  function parse(pathname) {
    var m = RE.exec(String(pathname || "")); if (!m) return null;
    var sec = m[2], ref = m[3] ? dec(m[3]) : null, sub = m[4] || "";
    if (m[3] && ref == null) return null;
    var kind = null;
    if (sec === "events") kind = ref ? (sub === "floor-plan" ? "floor-plan" : sub === "tasks" ? "tasks" : "event") : "quotes";   // /<studio>/events → the events (quotes) list
    else if (sub) kind = null;
    else if (sec === "clients" || sec === "booklet") kind = ref ? (sec === "clients" ? "client" : "booklet") : null;
    else if (!ref) kind = (sec === "settings" || sec === "control") ? "settings" : sec;
    if (!kind) return null;
    return { studio: m[1], kind: kind, ref: ref, page: KINDS[kind][2], key: KINDS[kind][3] };
  }
  var route = null;
  try { route = parse(global.location.pathname); } catch (e) {}
  function qs(extra) {
    if (!extra) return "";
    var p = new URLSearchParams();
    Object.keys(extra).forEach(function (k) { var v = extra[k]; if (v != null && v !== "") p.set(k, String(v)); });
    var s = p.toString(); return s ? "?" + s : "";
  }
  // build("event", {ref:"EVT-0912"}) → "/sharma-events/events/EVT-0912"; no studio → legacy URL
  function build(kind, params) {
    var k = KINDS[kind]; params = params || {};
    if (!k) return "dashboard.html";
    var ref = params.ref != null ? String(params.ref) : (params.code || params.id || params.token || "");
    ref = String(ref || "");
    var extra = params.query || null, hash = params.hash ? "#" + String(params.hash).replace(/^#/, "") : "";
    var s = params.studio && SLUG.test(params.studio) ? params.studio : slug;
    if (k[3] && !ref) return k[2] + ".html" + qs(extra) + hash;
    if (!s) {
      var q = {}; if (k[3]) q[k[3]] = ref;
      if (extra) Object.keys(extra).forEach(function (x) { q[x] = extra[x]; });
      return k[2] + ".html" + qs(q) + hash;
    }
    return "/" + s + "/" + k[0] + (k[3] ? "/" + encodeURIComponent(ref) : "") + (k[1] ? "/" + k[1] : "") + qs(extra) + hash;
  }
  // a legacy relative/absolute app link → its pretty form (or the input unchanged)
  function upgrade(href) {
    if (!slug || typeof href !== "string") return href;
    var m = /^\/?([a-z-]+)(?:\.html)?(\?[^#]*)?(#.*)?$/.exec(href); if (!m) return href;
    var kind = PAGE_KIND[m[1]]; if (!kind) return href;
    var p; try { p = new URLSearchParams(m[2] || ""); } catch (e) { return href; }
    var key = KINDS[kind][3], ref = key ? p.get(key) : null;
    if (key && !ref) return href;
    if (kind === "booklet") return href;   // public client page: shared links come from booklet_share
    if (key) p.delete(key);
    var extra = {}; p.forEach(function (v, x) { extra[x] = v; });
    return build(kind, { ref: ref, query: extra, hash: m[3] ? m[3].slice(1) : "" });
  }
  function page() {
    if (route) return route.page;
    try { return (global.location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index"; } catch (e) { return "index"; }
  }
  // where am I, for login ?next= (pretty path kept; legacy: page + query)
  function here() {
    try {
      if (route) return global.location.pathname + (global.location.search || "");
      return (global.location.pathname.split("/").pop() || "dashboard") + (global.location.search || "");
    } catch (e) { return "dashboard"; }
  }
  function setStudio(s) {
    if (s && SLUG.test(s)) { slug = s; try { sessionStorage.setItem("bp_studio_slug", s); } catch (e) {} }
  }
  return { parse: parse, build: build, upgrade: upgrade, page: page, here: here, setStudio: setStudio,
    route: function () { return route; }, studio: function () { return slug; }, KINDS: KINDS, isUuid: function (v) { return UUID.test(String(v || "")); } };
})(window);
window.HelmUrl = HelmUrl;

/* Phase 54 — apply the saved light/dark theme synchronously (before the body
   paints, so there is no flash), and mount a floating theme toggle on every page.
   DARK MODE FLAG (Oct 2026, owner decision): dark mode is OFF everywhere for now. Every page renders LIGHT, saved
   'bp_theme' / 'bps.theme' = dark and the OS prefers-color-scheme are ignored, and no light/dark toggle is shown.
   The dark CSS is kept untouched: set window.HELM_DARK_MODE = true (e.g. in config.js) to bring it all back.
   Colour themes (emerald default, cobalt, midnight, graphite, studio) are separate and still switchable. */
(function () {
  var DARK_ON = window.HELM_DARK_MODE === true;
  var root = document.documentElement;
  // marketing + sign-in pages are always light (marketing-theme.js sets data-mk-lock): never apply the app's saved mode there
  var mkLock = false; try { mkLock = document.documentElement.getAttribute("data-mk-lock") != null; } catch (e) {}
  if (!DARK_ON) {
    // light lock: force light now, and revert any later attempt (page-level toggles in builder/chat/demo) back to light
    if (!window.__helmLightLock) {
      window.__helmLightLock = true;
      var lock = function () { if (root.getAttribute("data-theme") !== "light") root.setAttribute("data-theme", "light"); try { root.style.colorScheme = "light"; } catch (e) {} };
      lock();
      try { new MutationObserver(lock).observe(root, { attributes: true, attributeFilter: ["data-theme"] }); } catch (e) {}
    }
    return;   // no floating toggle while dark mode is off
  }
  try { var t = localStorage.getItem("bp_theme"); if (!mkLock && (t === "dark" || t === "light")) document.documentElement.setAttribute("data-theme", t); } catch (e) {}
  function mountToggle() {
    if (mkLock || document.getElementById("bpThemeToggle") || !document.body) return;
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
      var page = HelmUrl.page();
      if (page === "index" || page === "welcome" || page === "login") return;   // home / auth pages: no self-link
      // client-facing token pages: clients have no dashboard to go "home" to
      if (/^(approve|portal|booklet|proposal-view|invite|work|sim-pay)$/.test(page) || location.pathname.indexOf("/i/") === 0) return;
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
  // supabase-js loads. Pages carry NO hardcoded origin hint (staging must not warm prod);
  // this covers prod / staging / local. No-op when that origin is already preconnected.
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
  let urlAuthCode = false, urlAuthError = "";   // PKCE ?code= return (see init)
  let ready = null;             // init() promise
  let currentUser = null;       // signed-in Supabase user (or null)
  let roleCache = null;         // this user's RBAC role
  let accessCache = null;       // { role, map:{area:{view,edit}} | null } — the live access matrix for this user
  let photoProbe = null;        // in-flight / cached render-photo deploy probe (0095)
  let rolePromise = null;       // in-flight getRole() (dedupes the parallel canView fan-out)
  let accessPromise = null;     // in-flight loadAccess()
  let trialOrgInflight = null;  // in-flight my_trial_org() (trial strip + read-only check share one call)
  let readOnlyMemo = null;      // { uid, p } — 0183: is this studio read-only after its free trial? (once per page)
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
  function sessClear() { try { sessionStorage.removeItem("bp_sess_role"); sessionStorage.removeItem("bp_sess_access"); sessionStorage.removeItem("bp_sess_org"); sessionStorage.removeItem(PROFILE_SESS_KEY); sessionStorage.removeItem(CHECKOUT_SESS_KEY); sessionStorage.removeItem(PW_OK_KEY); sessionStorage.removeItem("bp_studio_slug"); } catch (e) {} swrClear(); memoClear(); }
  /* ---- per-tab stale-while-revalidate cache (perf pass 2, Oct 2026) ----
     Studio-wide, rarely-changing reads (pricing config, item rate cards, organization row, demo / trial status) are
     answered from sessionStorage for this tab and refreshed in the background. An entry is used ONLY when the user id
     AND the studio (org) id match the ones it was written for (never shared between users or studios); sessClear()
     (sign-in / sign-out / account or org switch / revoked) drops them all, and so does any write from this tab that
     could change them (coalescedFetch). It is a display cache: RLS and the server still decide every read and write. */
  const SWR_PREFIX = "bp_swr:", SWR_MAX = 5 * 60000, SWR_REVAL = 20000;
  const swrBusy = {};
  // cc-general-billing: a read that STARTED before a write must not refill the cache after it
  // (it would bring back the pre-save row - e.g. billing details "empty again" after a reload)
  let swrGen = 0;
  function swrClear() { swrGen++; try { const del = []; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && k.indexOf(SWR_PREFIX) === 0) del.push(k); } del.forEach((k) => sessionStorage.removeItem(k)); } catch (e) {} }
  function swrOrg(uid) { const h = sessEntry("bp_sess_org", uid); return (h && h.val) || null; }
  function swr(name, fetcher) {
    if (!supa || !currentUser || mode !== "supabase") return fetcher();
    const uid = currentUser.id, oid = swrOrg(uid), key = SWR_PREFIX + name, gen = swrGen;
    const store = (v) => { const o2 = swrOrg(uid);
      if (o2 && gen === swrGen && currentUser && currentUser.id === uid) { try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), uid: uid, oid: o2, val: v === undefined ? null : v })); } catch (e) {} }
      return v; };
    let hit = null;
    try { const o = JSON.parse(sessionStorage.getItem(key) || "null");
      if (o && oid && o.uid === uid && o.oid === oid) { const age = Date.now() - o.ts; if (age >= 0 && age < SWR_MAX) hit = { val: o.val, age: age }; } } catch (e) {}
    if (hit) {
      if (hit.age > SWR_REVAL && !swrBusy[name]) { swrBusy[name] = 1; Promise.resolve().then(fetcher).then(store, () => {}).then(() => { swrBusy[name] = 0; }); }
      return Promise.resolve(hit.val);
    }
    return fetcher().then(store);
  }
  // anon-42501 (prod logs: "permission denied for function my_trial_status / my_trial_org"): both RPCs are granted to
  // authenticated only (0180 / 0183 / 0204), so a signed-out page (login, public pages) never calls them - it gets
  // the "not a trial" answer (null) instead. The session is read locally (no network call).
  async function trialSignedIn() {
    if (!supa) return false;
    if (currentUser) return true;
    try { const { data } = await supa.auth.getSession(); return !!(data && data.session && data.session.access_token); } catch (e) { return false; }
  }
  // 0116 / 0183: my_trial_org() — one in-flight call shared by the trial strip and the read-only check
  function trialOrgStatus() {
    if (!supa) return Promise.resolve(null);
    if (trialOrgInflight) return trialOrgInflight;
    // la-fetch (audit 25): + a per-page memo, so the trial strip, trial-lock and trial-demo share ONE answer even
    // before the per-tab swr entry can be written (it needs the studio id cached first)
    // anon-42501: signed out = "not a trial" without asking (my_trial_org is granted to authenticated only)
    const p = trialSignedIn().then((ok) => (ok ? memoRead("trialorg", 15000, () => swr("trialorg", () => rpc("my_trial_org", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }))) : null));
    trialOrgInflight = p;
    const done = () => { if (trialOrgInflight === p) trialOrgInflight = null; };
    p.then(done, done);
    return p;
  }
  // 0203: areas a studio on its FREE TRIAL never gets (photo renders, checklist templates, activity log), whatever
  // the saved role matrix says - admins included. Status-based (my_trial_status().status = 'trial', the same as the
  // server's _is_trial_org); one shared call per page. The server refuses the same things (0173 / 0181 / 0203).
  const TRIAL_OFF_AREAS = { photo_render: 1, templates: 1, audit: 1 };
  let trialSubInflight = null;
  function inFreeTrial() {
    if (mode !== "supabase" || !supa || !currentUser) return Promise.resolve(false);
    if (!trialSubInflight) {
      // B29: the same per-page memo as subscription.trial(), so the role gate, the trial banner, trial-lock and the
      // demo card share ONE my_trial_status call per page (it went out 4 times on a cold load)
      const p = Promise.resolve(memoRead("trial", 15000, () => swr("trial", () => rpc("my_trial_status").catch((e) => { if (rpcMissing(e)) return null; throw e; }))))
        .then((t) => !!(t && t.status === "trial"), () => false);
      trialSubInflight = p;
      p.then(() => { setTimeout(() => { if (trialSubInflight === p) trialSubInflight = null; }, 30000); });
    }
    return trialSubInflight;
  }
  // 0183 (post-trial policy 1 / 6 / 10): true when this studio's free trial ended unpaid — the studio is then
  // READ-ONLY for everyone (owner + invited members) until it upgrades. The database refuses every change
  // (hint 'trial_ended'); this only lets the edit helpers below answer "no" so pages show view-only screens.
  // Any error / older database / paid studio = false (the server still decides).
  function studioReadOnly() {
    if (mode !== "supabase" || !supa || !currentUser) return Promise.resolve(false);
    const uid = currentUser.id;
    if (readOnlyMemo && readOnlyMemo.uid === uid) return readOnlyMemo.p;
    let p;
    try { p = Promise.resolve(trialOrgStatus()).then((t) => !!(t && (t.read_only === true || t.locked === true)), () => false); }
    catch (e) { p = Promise.resolve(false); }
    readOnlyMemo = { uid: uid, p: p };
    return p;
  }
  // writes that cannot touch the cached reads above (everything else drops the cache)
  const SWR_KEEP_RPCS = /\/rest\/v1\/rpc\/(my_(?!start_trial|studio_account_update)|get_|is_|current_org_id|recent_|chat_|bell|my_notification|mfa_|resolve_|list_|pkg_selection_list|password_change_required|audit_actor_names|dashboard_|insights_|studio_search|studio_avatars|mark_|telemetry|privacy_pin_(?:check|status)|link_expiry_shelf_tick)/;
  const CHECKOUT_SESS_KEY = "bp_sess_checkout"; // per tab: my_checkout_status() answer (never a "must check out" one)
  const PROFILE_SESS_KEY = "bp_sess_profile";   // per tab: my_profile_status() answer (never a "must complete" one)
  const NUDGE_KEY = "helm_profile_nudge";       // localStorage {uid, until}: "complete your profile" banner snoozed
  const PW_OK_KEY = "bp_pw_ok";                 // per tab: "<uid>" once password_change_required() said no
  // Per-USER browser state that must not carry over to the next person who signs in
  // on a shared computer (audit Phase 4). Device prefs (theme, tours) are kept.
  const USER_LOCAL_KEYS = ["bps.clip", "wa_pin", "wa_mute", "wa_fav", "bp_chat_ping", "helm_org_country", "helm_ev_showall", "helm.trial", "helm.studioTax", "helm.studioTz"];   // 0181: helm.trial = the cached free-trial flag
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
  // valid for REAUTH_MS. The proof holds NO password: the current password is used
  // for the one re-sign-in and dropped immediately (callers clear their field too). updatePassword() refuses without it unless the session is
  // a genuine password-reset session (signed JWT amr says "recovery").
  const REAUTH_MS = 10 * 60 * 1000;
  let reauth = null;                    // { uid, until } — never the password
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
  const SIGNOUT_KEY = "bp_signed_out";           // localStorage {uid, ts}: this person clicked "Log out" (any tab)
  // Pure (exported for tests): did THIS person deliberately sign out in another tab within the
  // last 2 minutes? Then the other tabs' SIGNED_OUT is not an "expired session" (e.g. the
  // owner logs out to create a new studio) - they go to sign-in without the expiry warning.
  function signedOutElsewhere(raw, uid, now) {
    try { const o = JSON.parse(raw || "null"); return !!(o && uid && o.uid === uid && o.ts && now - o.ts >= 0 && now - o.ts < 120000); }
    catch (e) { return false; }
  }
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
  const PUBLIC_PAGES = { approve: 1, portal: 1, booklet: 1, "proposal-view": 1, invite: 1, work: 1, "sim-pay": 1, confirm: 1, "auth-confirm": 1,
    index: 1, login: 1, about: 1, services: 1, privacy: 1, terms: 1, "refund-policy": 1, "reset-password": 1 };
  let authGateUsed = false;     // page called auth.required()/requireView()
  let hadSession = false;       // a user was signed in at some point on this page
  let explicitSignOut = false;  // the user clicked "sign out" (not an expiry)
  let sessionExpired = false;   // redirect already triggered (run once)
  let authFailPromise = null;   // in-flight verification of a suspected auth failure
  let sessionUnverified = false; // a stored session exists but could not be checked (network)
  function hasStoredSession() {
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^sb-[a-z0-9]+-auth-token$/.test(k || "") && localStorage.getItem(k)) return true; } } catch (e) {}
    return false;
  }
  function pageKey() {
    try { return HelmUrl.page(); }
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
  const NEXT_PAGES = ["audit", "budget", "builder", "calendar", "chat", "closure", "command", "control", "crm", "dashboard", "design", "discovery", "event", "flow", "insights", "integrations", "inventory", "invite-studio", "issues", "leads", "logistics", "manual", "media", "nurture", "ops", "plan", "proposal", "quotes", "ready", "reports", "resources", "runsheet", "settlement", "staff", "teardown", "templates", "vendors"];
  function safeNext(raw) {
    // 0067: a pretty studio path (/<slug>/<section>…) is re-built from its parsed parts
    if (typeof raw === "string" && raw.charAt(0) === "/" && raw.charAt(1) !== "/" && raw.charAt(1) !== "\\") {
      const qi = raw.indexOf("?"), r = HelmUrl.parse(qi < 0 ? raw : raw.slice(0, qi));
      if (r) {
        let q = {}; try { new URLSearchParams(qi < 0 ? "" : raw.slice(qi + 1).split("#")[0]).forEach((v, k) => { q[k] = v; }); } catch (e) { q = {}; }
        return HelmUrl.build(r.kind, { studio: r.studio, ref: r.ref, query: q });
      }
    }
    const m = /^\/?([a-z0-9-]+)(?:\.html)?(?:\?([^#]*))?$/i.exec(typeof raw === "string" ? raw : "");
    const page = m && NEXT_PAGES.find((p) => p === m[1].toLowerCase());
    if (!page) return "dashboard.html";
    let qs = "";
    try { qs = new URLSearchParams(m[2] || "").toString(); } catch (e) { qs = ""; }
    return page + ".html" + (qs ? "?" + qs : "");
  }
  function gotoLogin() {
    let page = "dashboard";
    try { page = HelmUrl.here(); } catch (e) {}
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
      r.style.cssText = "min-height:40px;padding:0 18px;border:0;border-radius:10px;background:#047857;color:#fff;font:inherit;font-weight:600;cursor:pointer";
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
  // 0047 platform flag: must HQ operators use two-step? Anything but an explicit
  // false (missing RPC, error, offline) counts as "required" — fails closed.
  async function hqMfaRequired() {
    if (!supa || !currentUser) return true;
    try { const r = await supa.rpc("operator_mfa_required"); return !(r && !r.error && r.data === false); }
    catch (e) { return true; }
  }
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
    try { location.replace("/login?next=" + encodeURIComponent(safeNext(HelmUrl.here()))); } catch (e) {}
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
    try { return HelmUrl.here(); } catch (e) { return "dashboard"; }
  }
  function nextParam() {
    try { return new URLSearchParams(location.search || "").get("next") || ""; } catch (e) { return ""; }
  }
  /* ---- Onboarding checkout (0056) — after the profile step, for NEW studio owners ----
     my_checkout_status() → {required, reason, …}. The SERVER decides: required only for a
     studio admin whose studio was created after 0056 and has no subscription row yet.
     Invited members, older studios, clients and HQ operators never see /checkout.
     UX step, not a security boundary: unknown (network) never blocks the app, and 0056
     not installed (PGRST202 / 42883) = the feature is off. "Not required" answers are
     cached per tab (bp_sess_checkout); a "must check out" answer is always asked again. */
  const CHECKOUT_PAGE = "checkout";
  const ROLE_BLOCK_MSG = "Your role can't open that page.";   // same text as trial-lock.js ROLE_MSG (R20 item 20)
  let coEarly = null;
  // Pure decision (exported for tests): "checkout" (send to /checkout) or "none".
  function checkoutGateDecision(st, page, role) {
    if (!st || typeof st !== "object" || st.missing) return "none";
    if (role === "client" || st.required !== true) return "none";
    if (page === CHECKOUT_PAGE || page === PROFILE_SETUP_PAGE) return "none";   // profile step comes first
    return "checkout";
  }
  // r20: on /checkout itself - stay when a plan is required, or when a studio ADMIN on (or just past) the free
  // trial came to pick a plan ("Choose a plan": trial banner, cap toast / note, bell). Anyone else (members,
  // subscribed or older studios, 0056 missing) goes straight on to ?next=. Pure (unit-tested).
  function checkoutPageStays(st) {
    if (!st || typeof st !== "object" || st.missing) return false;
    if (st.required === true) return true;
    return st.is_admin === true && (st.reason === "trial" || st.reason === "trial_ended");
  }
  async function fetchCheckoutStatus(force) {
    if (!supa || !currentUser) return null;
    const uid = currentUser.id;
    if (!force) { const hit = sessEntry(CHECKOUT_SESS_KEY, uid); if (hit && hit.val && typeof hit.val === "object") return hit.val; }
    const { data, error } = await supa.rpc("my_checkout_status");
    if (error) {
      if (isMissingFn(error)) { const v = { missing: true }; sessSet(CHECKOUT_SESS_KEY, uid, v); return v; }
      throw error;
    }
    if (!data || typeof data !== "object") return null;
    const v = { required: data.required === true, is_admin: data.is_admin === true, has_subscription: data.has_subscription === true,
      reason: typeof data.reason === "string" ? data.reason : "", pending_payment: data.pending_payment === true };
    if (!v.required) sessSet(CHECKOUT_SESS_KEY, uid, v); else { try { sessionStorage.removeItem(CHECKOUT_SESS_KEY); } catch (e) {} }
    return v;
  }
  function noteCheckoutDone() {
    if (!currentUser) return;
    sessSet(CHECKOUT_SESS_KEY, currentUser.id, { required: false, is_admin: true, has_subscription: true, reason: "subscribed" });
  }
  function checkoutUrl(next) {
    return "/" + CHECKOUT_PAGE + "?next=" + encodeURIComponent(safeNext(next));
  }
  async function runPageGate() {
    if (!PAGE_GATED) return;
    authGateUsed = true;
    if (mode !== "supabase") {
      if (supaConfigured()) { gateUnreachable(); return HANG(); }
      revealPage(); return;                              // no accounts configured (local/offline dev)
    }
    // session-1017: signed in, but the status check could not reach the server (or the stored
    // session could not be refreshed because of the network) → "Couldn't reach Helm — Retry",
    // never the sign-in page (that looked like a random logout on a slow connection)
    if ((pendingStep === "verify" && currentUser) || (!currentUser && sessionUnverified)) { gateUnreachable(); return HANG(); }
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
    // Onboarding checkout (0056): decided BEFORE the page shows (no flash).
    if (pk !== PROFILE_SETUP_PAGE) {
      let cst = null;
      const ce = coEarly; coEarly = null;
      try { cst = await (ce || fetchCheckoutStatus(pk === CHECKOUT_PAGE)); }
      catch (e) {
        if (looksLikeAuthError(e)) { gotoLogin(); return HANG(); }
        cst = null;                  // unknown (network): never blocks the app
      }
      if (pk === CHECKOUT_PAGE) {
        // nothing to buy here (member, already subscribed, older studio, 0056 not
        // installed) → straight on to ?next= (never back to this page: no loop)
        if (cst && !checkoutPageStays(cst)) {
          // R20 (live QA, item 20): a teammate (not a studio admin) can't buy a plan - say so once on the page they land on
          // (the same one-time "bp_flash" notice trial-lock.js uses), instead of a silent bounce to the dashboard
          if (!cst.missing && cst.reason === "member") { try { sessionStorage.setItem("bp_flash", "i|" + ROLE_BLOCK_MSG); } catch (e) {} }
          try { location.replace(safeNext(nextParam())); } catch (e) {}
          return HANG();
        }
      } else if (checkoutGateDecision(cst, pk, roleCache) === "checkout") {
        try { location.replace(checkoutUrl(currentPageRef())); } catch (e) {}
        return HANG();
      }
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
  // r20-coord #33: the auth server REVOKED this browser's session (signed out on another browser / device with
  // "Sign out other devices", the account was removed or changed) - not a plain timeout. supabase-js reports it as
  // a 400 from /auth/v1/token?grant_type=refresh_token with one of these error codes.
  const REVOKED_CODES = /^(refresh_token_not_found|session_not_found|user_not_found)$/;
  let refreshRevoked = false;
  function isRevokedRefusal(err) {
    if (!err) return false;
    const c = String(err.code || err.error_code || ""), st = Number(err.status) || 0;
    return REVOKED_CODES.test(c) && (!st || st === 400 || st === 403 || st === 404);
  }
  function expireSession(revoked) {
    if (sessionExpired || !shouldRedirectOnExpiry()) return false;
    sessionExpired = true;
    const byLogout = signedOutElsewhere(lsGet(SIGNOUT_KEY), currentUser && currentUser.id, Date.now());
    currentUser = null; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; sessClear(); authRequired = true;
    let page = "dashboard.html";
    try { page = HelmUrl.here(); } catch (e) {}
    const url = "login.html?next=" + encodeURIComponent(page) + (byLogout ? "&reason=signout" : "&expired=1" + ((revoked || refreshRevoked) ? "&reason=revoked" : ""));
    const UI = global.BPUI;
    // signed out on purpose in another tab: nothing "expired" and nothing to warn about
    if (byLogout) { try { if (UI && UI.allowUnload) UI.allowUnload(); } catch (e) {} try { location.replace(url); } catch (e) {} return true; }
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
  // A refresh failure counts as a DEAD session only when the auth server said so
  // (revoked / already used / not found / 4xx). Network errors, 5xx, 429, timeouts and
  // lock contention are transient: the user stays signed in (session-1017: no false "session expired").
  function definiteAuthRefusal(err) {
    if (!err) return false;
    const m = String(err.message || ""), st = Number(err.status) || 0;
    if (global.BPUI && global.BPUI.isNetworkError && global.BPUI.isNetworkError(err)) return false;
    if (err.name === "AuthRetryableFetchError" || st >= 500 || st === 429) return false;
    if (/timeout|timed out|aborted|lock/i.test(m) && !/refresh token|session/i.test(m)) return false;
    return true;
  }
  const AUTH_RETRY_MS = [0, 400, 900];   // < 1 s each: a rotating tab / slow network gets time to settle
  // A request failed in a way that looks like a dead session. Confirm first:
  //   1) another tab may already have rotated the token (shared localStorage) → reuse it;
  //   2) otherwise refresh (supabase-js serialises refreshes across tabs with navigator.locks),
  //      retrying a couple of times;
  // and redirect ONLY when the auth server definitively refused and we are online.
  // Deduped: many parallel failures → one check, one redirect.
  function onAuthFailure() {
    if (sessionExpired || !supa || !shouldRedirectOnExpiry()) return Promise.resolve(false);
    if (authFailPromise) return authFailPromise;
    authFailPromise = (async () => {
      const adopt = (sess) => {
        // the browser's session now belongs to a DIFFERENT person (e.g. a new studio was just
        // created in another tab): never adopt it silently on this page - reload so the gate decides
        if (currentUser && sess.user && sess.user.id !== currentUser.id) {
          currentUser = sess.user; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null;
          studioSlugCache = null; pendingStep = null; sessClear();
          try { location.reload(); } catch (e) {}
          return true;
        }
        currentUser = sess.user; return false;
      };
      let lastErr = null;
      for (let i = 0; i < AUTH_RETRY_MS.length; i++) {
        if (AUTH_RETRY_MS[i]) await new Promise((r) => setTimeout(r, AUTH_RETRY_MS[i]));
        try {
          // a still-valid session (possibly just refreshed by another tab) → nothing expired
          if (i > 0) {
            const g = await supa.auth.getSession();
            const gs = g && g.data && g.data.session;
            if (gs && gs.user && Number(gs.expires_at || 0) * 1000 > Date.now() + 30000) return adopt(gs);
          }
          const { data, error } = await supa.auth.refreshSession();
          if (!error && data && data.session) return adopt(data.session);
          lastErr = error || null;
        } catch (e) { lastErr = e; }
        if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
      if (lastErr && !definiteAuthRefusal(lastErr)) return false;   // transient: stay signed in
      return expireSession(isRevokedRefusal(lastErr));
    })();
    authFailPromise.then(() => { authFailPromise = null; }, () => { authFailPromise = null; });
    return authFailPromise;
  }
  // fetch used by the Supabase client: a 401 from PostgREST while signed in means
  // the JWT was rejected — run the session-expiry check (the response is returned
  // to the caller untouched either way).
  /* ---- read coalescing (perf, Oct 2026) ----
     Pages fire the same Supabase reads several times while booting (quotes x10 on the
     dashboard, event_resources x8 on the event page). Identical READS (same URL, same
     body, same token + headers) that start within READ_TTL_MS share ONE network
     request; each caller gets its own clone of the response. Any write (non-GET that
     is not a known read-only RPC) or a token change drops the whole cache, so this tab
     never sees its own write as stale. Keyed by the Authorization header → never
     shared across users. Storage / auth / functions URLs are never touched. */
  const READ_TTL_MS = 1500;
  // la-fetch (audit 25): the list below also names the STABLE (read-only) RPCs every page asks while it
  // boots (trial / upgrade status, seat use, prefs, shelf list, mentions, PIN status). Before, each one was
  // treated as a write and dropped every shared read of the page, so the page's own reads ran again.
  const READ_RPCS = /\/rest\/v1\/rpc\/(current_org_id|my_profile|my_profile_status|get_pricing_config|get_item_rate_cards|my_demo_status|my_trial_status|my_subscription|my_auth_info|my_dashboard_prefs|my_getting_started|is_platform_admin|is_platform_operator|chat_directory|dashboard_money|dashboard_due_today|bell_feed|my_pending|admin_get_role_access|my_trial_welcome_pending|my_trial_terms_status|my_trial_org|my_upgrade_status|my_trial_limits|my_trial_access|my_seat_usage|my_notification_prefs|my_notification_mutes|my_studio_route|my_tasks|list_quote_shelf|chat_my_mentions|privacy_pin_status|my_unfinished_quotes)(\?|$)/;
  const readCache = new Map();
  function hdrOf(init, input, name) {
    try {
      const h = (init && init.headers) || (input && typeof input !== "string" && input.headers);
      if (!h) return "";
      if (typeof h.get === "function") return h.get(name) || "";
      const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
      return k ? String(h[k]) : "";
    } catch (e) { return ""; }
  }
  function coalescedFetch(input, init) {
    let u = "", method = "GET";
    try { u = typeof input === "string" ? input : (input && input.url) || ""; method = String((init && init.method) || (input && input.method) || "GET").toUpperCase(); } catch (e) {}
    if (!/\/rest\/v1\//.test(u)) return global.fetch(input, init);
    /* never answer a data read from the browser's HTTP cache: a Back/Forward navigation makes the browser prefer
       cached responses, which re-showed minutes-old rows (dashboard "Recent activity" said "14m ago" while the
       Audit log page, opened fresh, was current). Oct 2026. */
    if (!(init && init.cache)) init = Object.assign({}, init || {}, { cache: "no-store" });
    if (init.signal) return global.fetch(input, init);
    const isRead = method === "GET" || method === "HEAD" || (method === "POST" && READ_RPCS.test(u) && typeof (init && init.body || "") === "string");
    if (!isRead) {
      readCache.clear(); memoClear(); if (!SWR_KEEP_RPCS.test(u)) swrClear();
      // a list read that started while this write was running must not be kept as the fresh answer
      const wp = global.fetch(input, init); const after = () => { readCache.clear(); memoClear(); };
      wp.then(after, after); return wp;
    }
    const key = [method, u, (init && init.body) || "", hdrOf(init, input, "Authorization"), hdrOf(init, input, "Accept"),
      hdrOf(init, input, "Prefer"), hdrOf(init, input, "Range"), hdrOf(init, input, "Accept-Profile"), hdrOf(init, input, "Content-Profile")].join("\u0001");
    const now = Date.now();
    const hit = readCache.get(key);
    if (hit && now - hit.t < READ_TTL_MS) return hit.p.then((r) => r.clone());
    const p = global.fetch(input, init);
    readCache.set(key, { t: now, p });
    p.then((r) => { if (!r.ok) readCache.delete(key); }, () => readCache.delete(key));
    if (readCache.size > 200) { for (const [k, v] of readCache) if (now - v.t >= READ_TTL_MS) readCache.delete(k); }
    return p.then((r) => r.clone());
  }
  function authAwareFetch(input, init) {
    return coalescedFetch(input, init).then((res) => {
      try {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        if (res.status === 401 && currentUser) {
          if (/\/rest\/v1\//.test(u)) onAuthFailure();
        }
        // r20-coord #33: a refused token refresh (supabase-js auto-refresh included) - remember whether the server said
        // the session was REVOKED, so the sign-in page can say why. Reads a clone; the caller's response is untouched.
        if (res.status === 400 && /\/auth\/v1\/token\?(?:[^#]*&)?grant_type=refresh_token/.test(u) && res.clone) {
          res.clone().json().then((b) => { if (b && isRevokedRefusal({ code: b.error_code || b.code, status: 400 })) refreshRevoked = true; }).catch(() => {});
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
    // session-1017: one quick retry first - a transient lock/refresh race must not send a
    // signed-in person to the sign-in page (still fails CLOSED if it keeps failing)
    let aalOk = false;
    for (let i = 0; i < 2 && !aalOk; i++) {
      try {
        if (i) await new Promise((r) => setTimeout(r, 300));
        const { data, error } = await supa.auth.mfa.getAuthenticatorAssuranceLevel();
        if (error) throw error;
        aalOk = true;
        if (data && data.nextLevel === "aal2" && data.currentLevel !== "aal2") { pendingStep = "mfa"; return pendingStep; }
      } catch (e) { /* retried below */ }
    }
    if (!aalOk) { pendingStep = "verify"; return pendingStep; }
    // 2) a password-reset link was used in this browser and the new password isn't set yet
    if (lsGet(RECOVERY_KEY) === currentUser.id) { pendingStep = "recovery"; return pendingStep; }
    // 3) one-time temp password — checked once per tab, FAILS CLOSED on error
    let ok = null; try { ok = sessionStorage.getItem(PW_OK_KEY); } catch (e) {}
    if (ok === currentUser.id) return null;
    for (let i = 0; i < 3; i++) {
      try {
        if (i) await new Promise((r) => setTimeout(r, 250 * i));   // transient network: retry before failing closed
        const { data, error } = await supa.rpc("password_change_required");
        if (error && !isMissingFn(error)) throw error;
        if (!error && data === true) { pendingStep = "password"; return pendingStep; }
        try { sessionStorage.setItem(PW_OK_KEY, currentUser.id); } catch (e) {}
        pendingStep = null; return pendingStep;
      } catch (e) { pendingStep = "verify"; if (looksLikeAuthError(e)) break; }
    }
    return pendingStep;
  }
  /* ---- two-step code lockout — SERVER side (0050 mfa_record_failure / mfa_lock_status) ----
     5 wrong codes → the account's code entry is locked for 15 minutes, counted in the
     database (every tab, device and reload sees the same lock; locks are audited). This
     tab keeps only an in-memory copy of the lock for the countdown. If the server
     functions aren't installed yet / can't be reached, a per-tab in-memory fallback
     (5 wrong → 60 s) applies; Supabase Auth's own MFA rate limit stays the backstop.
     Nothing here changes the session's assurance level (aal). */
  const MFA_MAX_TRIES = 5, MFA_FALLBACK_LOCK = 60000;
  let mfaLock = { uid: null, until: 0, n: 0 };
  function mfaLockFor(uid, ms) { if (mfaLock.uid !== uid) mfaLock = { uid: uid, until: 0, n: 0 }; mfaLock.until = Date.now() + ms; return ms; }
  function mfaLockLeft(uid) { return (uid && mfaLock.uid === uid) ? Math.max(0, mfaLock.until - Date.now()) : 0; }
  function mfaLockClear() { mfaLock = { uid: null, until: 0, n: 0 }; }
  function mfaServerVerdict(uid, d) {
    if (!d || typeof d !== "object") return null;
    const ra = Math.max(0, Number(d.retry_after) || 0);
    if (d.locked === true && ra > 0) return mfaLockFor(uid, ra * 1000);
    if (mfaLock.uid === uid) mfaLock.until = 0;
    return 0;
  }
  // current lock from the server (null = server can't tell → local copy decides)
  async function mfaLockFetch(uid) {
    if (!supa || !uid) return null;
    try { const { data, error } = await supa.rpc("mfa_lock_status"); if (error) return null; return mfaServerVerdict(uid, data); }
    catch (e) { return null; }
  }
  // one wrong code: count it on the server; fallback per-tab counter if unavailable
  async function mfaStrike(uid) {
    try {
      const { data, error } = await supa.rpc("mfa_record_failure");
      if (!error) { const v = mfaServerVerdict(uid, data); if (v !== null) return v; }
    } catch (e) {}
    if (mfaLock.uid !== uid) mfaLock = { uid: uid, until: 0, n: 0 };
    mfaLock.n++;
    if (mfaLock.n % MFA_MAX_TRIES === 0) mfaLock.until = Date.now() + MFA_FALLBACK_LOCK;
    return Math.max(0, mfaLock.until - Date.now());
  }
  function mfaLockedError(ms, cause) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    const e = new Error("Too many incorrect codes. For your security, wait " + (s >= 90 ? Math.ceil(s / 60) + " minutes" : s + " seconds") + ", then enter the newest code from your app.");
    e.code = "mfa_locked"; e.retryAfter = s; if (cause) e.cause = cause; return e;
  }
  // Pure decision for a platform operator (exported for tests): no verified
  // authenticator → enroll; verified but session below aal2 → challenge; else ok.
  // `required` (0047 operator_mfa_required(), default true = fail closed): when the platform
  // flag is off an operator without an authenticator may enter at aal1; one who has
  // set it up is still asked for the code.
  function operatorMfaDecision(level, verifiedCount, required) {
    if (!(verifiedCount > 0)) return required === false ? "ok" : "enroll";
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
      b.style.cssText = "min-height:40px;padding:0 18px;border:0;border-radius:10px;background:var(--bpui-accent,#047857);color:#fff;font:inherit;font-weight:600;cursor:pointer";
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
    // Max session age / idle: revoke THIS session's refresh token server-side so it can't outlive the cap
    // (scope "local" revokes the current session on the server too). r20-coord #33: never "global" - one
    // browser hitting its cap must not sign the account out on every other browser / device.
    // If the network call fails, still sign out locally.
    if (supa) {
      try { await supa.auth.signOut({ scope: "local" }); } catch (e) {}
    }
    currentUser = null; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; pendingStep = null;
    sessClear(); userLocalClear(); lsDel(SESSION_START_KEY); authRequired = true;
    let page = "dashboard.html";
    try { page = HelmUrl.here(); } catch (e) {}
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
  const AUTH_UI_VERSION = "47";
  let authUiLoading = null;
  function loadAuthUi() {
    if (authUiLoading || typeof document === "undefined") return authUiLoading;
    authUiLoading = new Promise((resolve) => {
      if (global.HelmAuthUI) return resolve(true);
      const s = document.createElement("script");
      s.src = vendorUrl("auth-ui.js?v=" + AUTH_UI_VERSION);
      s.onload = () => resolve(true); s.onerror = () => resolve(false);
      document.head.appendChild(s);
    }).then((ok) => { try { if (ok && global.HelmAuthUI && global.HelmAuthUI.mountAppChrome) global.HelmAuthUI.mountAppChrome(); } catch (e) {} loadStudioSearch(); return ok; });
    return authUiLoading;
  }
  // 0061 universal search (top-bar trigger + Cmd/Ctrl+K palette). Studio pages only:
  // never on HQ / public client pages; studio-search.js re-checks the role (no clients).
  // verify-166: PR #166 merged four branches that each shipped a different store-api.js as v=232 (and shell-b as 114) - re-bumped so no browser keeps a stale copy
  const STUDIO_SEARCH_VERSION = "12";
  // nav trail (breadcrumbs + Recent records). Pages may call HelmTrail.setCurrent before
  // nav-trail.js loads: this stub queues the calls; nav-trail.js replays them after boot.
  const NAV_TRAIL_VERSION = "6";
  if (typeof global.HelmTrail === "undefined") {
    global.HelmTrail = { setCurrent(o) { if (o) (global.__helmTrailQ = global.__helmTrailQ || []).push(o); }, recent() { return []; }, _stub: true };
  }
  function navTrailClear() { try { const del = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf("helm_trail_") === 0) del.push(k); } del.forEach((k) => localStorage.removeItem(k)); } catch (e) {} }
  const NO_SEARCH_PAGES = { hq: 1, login: 1, "reset-password": 1, "profile-setup": 1 };
  let studioSearchLoading = false;
  function loadStudioSearch() {
    if (studioSearchLoading || typeof document === "undefined" || global.HelmStudioSearch) return;
    if (NO_SEARCH_PAGES[pageKey()] || PUBLIC_PAGES[pageKey()] || publicLinkPath()) return;
    studioSearchLoading = true;
    const s = document.createElement("script");
    s.src = vendorUrl("studio-search.js?v=" + STUDIO_SEARCH_VERSION);
    document.head.appendChild(s);
    const t = document.createElement("script");
    t.src = vendorUrl("nav-trail.js?v=" + NAV_TRAIL_VERSION);
    document.head.appendChild(t);
    loadMobileNav();
    loadTrialBanner();
    loadTrialUpgrade();
  }
  // 0185 — the "Sample" badge on sample rows (every studio page) + the upgrade data choice cards.
  // trial-upgrade.js asks my_demo_status() / my_upgrade_status() itself and does nothing without sample data.
  const TRIAL_UPGRADE_VERSION = "2";
  let trialUpgradeLoading = false;
  function loadTrialUpgrade() {
    if (trialUpgradeLoading || typeof document === "undefined" || global.HelmTrialUpgrade) return;
    trialUpgradeLoading = true;
    const s = document.createElement("script");
    s.src = vendorUrl("trial-upgrade.js?v=" + TRIAL_UPGRADE_VERSION);
    document.head.appendChild(s);
  }
  // 0116 — "Demo N" free-trial strip (days left / read-only + upgrade). trial.js asks
  // my_trial_org() itself and shows nothing for a studio that isn't a start_trial() trial.
  const TRIAL_BANNER_VERSION = "18";
  let trialBannerLoading = false;
  function loadTrialBanner() {
    if (trialBannerLoading || typeof document === "undefined" || global.HelmTrial) return;
    trialBannerLoading = true;
    // theme-aware banner/reminder colours (follows the app theme, not the OS setting)
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = vendorUrl("trial-theme.css?v=3");
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = vendorUrl("trial.js?v=" + TRIAL_BANNER_VERSION);
    document.head.appendChild(s);
  }
  // Mobile bottom bar (< 768px): same pages as the studio search; mobile-nav.js re-checks the role.
  const MOBILE_NAV_VERSION = "4";
  let mobileNavLoading = false;
  function loadMobileNav() {
    if (mobileNavLoading || typeof document === "undefined" || global.HelmMobileNav) return;
    if (NO_SEARCH_PAGES[pageKey()] || PUBLIC_PAGES[pageKey()] || publicLinkPath()) return;
    mobileNavLoading = true;
    const s = document.createElement("script");
    s.src = vendorUrl("mobile-nav.js?v=" + MOBILE_NAV_VERSION);
    document.head.appendChild(s);
  }

  // capability matrix per role (10 roles)
  // capability matrix per role. IMPORTANT: `create` and `delete` here gate
  // buttons (dashboard/quotes/leads/builder create, delete controls) that map to
  // the server functions can_create() = {admin, manager/planner/sales per quote_create} and can_delete() =
  // {admin,planner}. They are kept IN SYNC with those SQL functions so no button
  // is shown that the server will reject with "not authorized" (Wave 16 fix —
  // manager/coordinator previously saw a create button that always errored).
  // `edit` is NOT used for edit buttons — pages gate editing via canEditArea()
  // (the has_area matrix) — so it stays broad here for any legacy checks.
  // 0147 (owner decision): manager may create by default; can_create() = admin, or
  // manager/planner/sales per their "quote_create" matrix switch (default ON). can() checks it too.
  const ROLE_CAPS = {
    admin:       ["view", "create", "edit", "delete", "manage"],
    manager:     ["view", "create", "edit"],   // manager-1019: "manage" was never checked; Control Center access comes from role_access "controls"
    planner:     ["view", "create", "edit", "delete"],
    sales:       ["view", "create", "edit"],
    coordinator: ["view", "edit"],
    supervisor:  ["view", "edit"],
    quality:     ["view", "edit"],
    operations:  ["view", "edit"],
    designer:    ["view", "edit"],              // QA1017: server can_create() = admin/planner/sales - no create
    crew:        ["view"],
    worker:      ["view"],
    client:      ["view"],
  };
  const EDIT_ROLES = ["admin", "manager", "planner", "sales", "coordinator", "supervisor", "quality", "operations", "designer"];
  const ALL_ROLES  = ["admin", "manager", "planner", "sales", "coordinator", "supervisor", "quality", "operations", "designer", "crew", "worker", "client"];
  // 0143: "worker" is merged into "crew" - still a valid stored value (legacy rows) but never offered
  const PICK_ROLES = ALL_ROLES.filter((r) => r !== "worker");
  // friendly labels for the UI (keys stay stable in the DB)
  const ROLE_LABELS = {
    admin: "Admin", manager: "Event manager", planner: "Planner", sales: "Sales",
    coordinator: "Event coordinator", supervisor: "Supervisor", quality: "Quality engineer",
    operations: "Operations", designer: "Designer", crew: "Crew", worker: "Crew", client: "Client",
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
    // 0147: "Create new quotes" switch. edit = this role may create quotes. Default ON (no row yet)
    // for manager / planner / sales; the server can_create() reads the same row.
    { key: "quote_create", label: "Create new quotes", icon: "\u2795", page: null,      group: "Workspace", defaultOn: ["manager", "planner", "sales"] },
    { key: "layouts",    label: "Floor layouts",     icon: "📐", page: null,             group: "Workspace" },
    { key: "design",     label: "Design studio",     icon: "🎨", page: null,             group: "Workspace" },   // HIDDEN for now (owner, 2026-10-11) - restore page: "design.html" to bring it back
    // 0095: photo-realistic renders (builder ✦ Render). edit = may make photos (also needs quotes edit)
    { key: "photo_render", label: "Photo renders",    icon: "✦", page: null,             group: "Workspace" },
    { key: "staff",      label: "Staff",             icon: "👷", page: "staff.html",     group: "Resources" },
    { key: "inventory",  label: "Inventory",         icon: "📦", page: "inventory.html", group: "Resources" },
    { key: "vendors",    label: "Vendors",           icon: "🤝", page: "vendors.html",   group: "Resources" },
    { key: "calendar",   label: "Calendar",          icon: "📅", page: "calendar.html",  group: "Resources" },
    { key: "templates",  label: "Templates",         icon: "🧩", page: "templates.html", group: "Resources" },
    // 0085: studio venue list (Control Center -> Venues; picker in the quote flow + builder)
    { key: "venues",     label: "Venues",            icon: "🏛", page: null,             group: "Resources" },
    { key: "resources",  label: "Resource plan",     icon: "🧮", page: null,             group: "Planning" },
    { key: "runsheet",   label: "Run-sheet",         icon: "🗓", page: null,             group: "Planning" },
    { key: "plan",       label: "Venue & menu",      icon: "📍", page: null,             group: "Planning" },
    { key: "logistics",  label: "Logistics",         icon: "🚚", page: null,             group: "Planning" },
    { key: "ready",      label: "Readiness",         icon: "✅", page: null,             group: "Planning" },
    { key: "finance",    label: "Budget & finance",  icon: "💰", page: null,             group: "Finance" },
    { key: "settlement", label: "Settlement",        icon: "🧾", page: null,             group: "Finance" },
    { key: "closure",    label: "Closure & P&L",     icon: "🏁", page: null,             group: "Finance" },
    // 0069 client package flow: pkg_review view = notified of client choices, edit = accept / decline;
    // pkg_payments view = package payment alerts
    { key: "pkg_review",   label: "Package selections (review)", icon: "📦", page: null, group: "Finance" },
    { key: "pkg_payments", label: "Package payment alerts",      icon: "💸", page: null, group: "Finance" },
    { key: "command",    label: "Event-day command", icon: "🎛", page: null,             group: "Event day" },
    // 0241 (r21): delivery / arrival reminders + the tracker on the event-day page. view = see the tracker,
    // edit = schedule reminders and mark status. No row yet = the role's "Event-day command" switch (defaultFrom).
    { key: "deliveries", label: "Deliveries & arrivals (reminders)", icon: "🚚", page: null, group: "Event day", defaultFrom: "command" },
    { key: "issues",     label: "Issues & incidents",icon: "🚨", page: null,             group: "Event day" },
    { key: "media",      label: "Media & gallery",   icon: "📸", page: null,             group: "Event day" },
    { key: "controls",   label: "Control Center",    icon: "⚙", page: "control.html",   group: "Admin" },
    // 0239 (r20): the Business page (studio money: P&L, vendor payables). Its own switch, separate from
    // "Budget & finance" (planners keep finance for payments / settlement / closure on events). No row = off:
    // admin only until a studio switches it on for a role here.
    { key: "business",   label: "Business overview (studio money)", icon: "💼", page: null, group: "Admin" },
    // 0076: date-ranged Insights page (insights_range). Money inside it also needs "finance".
    { key: "insights",   label: "Insights",          icon: "📊", page: null,             group: "Admin" },
    { key: "codes",      label: "Coupons & codes",   icon: "🔑", page: null,             group: "Admin" },
    // 0086: item rate cards (Control Center -> Item pricing). view = see rates, edit = change them.
    // Adjusting an item's spec on a quote stays with quotes edit rights.
    { key: "item_pricing", label: "Item pricing (rate cards)", icon: "🏷", page: null, group: "Admin" },
    { key: "users",      label: "Users & access",    icon: "👥", page: "control.html",   group: "Admin" },
  ];
  // 0241: an area with no saved row follows another area's switch (the server's _dl241_can does the same)
  const AREA_FALLBACK = AREAS.reduce((m, a) => { if (a.defaultFrom) m[a.key] = a.defaultFrom; return m; }, {});
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

  // Account enumeration: one answer whether or not an email is registered.
  const GENERIC_SIGNIN = "Invalid email or password.";
  const GENERIC_RESEND = "If an account needs confirming, we've sent a new link. It can take a few minutes — check spam too.";
  const GENERIC_SENT = "If this email can be used, we've sent a link. It can take a few minutes — check spam too.";
  const LOCKOUT_RE = /^Too many attempts\. Try again in (15 minutes|1 hour) or reset your password\.$/;
  function genericSignInError(error) {
    const c = String((error && error.code) || ""), m = String((error && error.message) || ""), st = Number(error && error.status) || 0;
    // 0053: the server-side password lockout (Supabase password-verification hook) — show its message as-is
    if (LOCKOUT_RE.test(m)) { const e = new Error(m); e.code = "account_locked"; return e; }
    if (st === 429 || /rate limit|too many/i.test(m) || /captcha/i.test(m + " " + c)) return error;
    if (global.BPUI && global.BPUI.isNetworkError && global.BPUI.isNetworkError(error)) return error;
    if (/invalid_credentials|email_not_confirmed|user_not_found|user_banned|invalid login|not confirmed|credentials|user not found/i.test(c + " " + m) || st === 400) {
      const e = new Error(GENERIC_SIGNIN); e.code = "invalid_credentials"; return e; }
    return error;
  }

  /* ---------------- init: pick the best available backend ---------------- */
  const INVITE_SET_PW_KEY = "bp_invite_set_pw";
  const SIGNUP_MARK_KEY = "bp_signup_email";   // 0205: e-mail of a sign-up started in this browser   // user id of an invitee who arrived by an "Invite user" link and still needs a password
  let inviteFragment = null;
  function invitePwPending() {
    try { const id = sessionStorage.getItem(INVITE_SET_PW_KEY); return !!(id && currentUser && currentUser.id === id); } catch (e) { return false; }
  }   // { access_token, refresh_token } from a Supabase invite e-mail link (login page only)
  // Workspace tool pages (settlement, budget, …) read ?quote=<uuid>. A link may carry the
  // event NUMBER instead (/<studio>/settlement?quote=DEMO-202): resolve it (caller's org only,
  // resolve_event_ref) and reload with the record id. true = a reload is under way.
  const TOOL_PAGES = ["settlement", "budget", "closure", "runsheet", "resources", "logistics", "teardown", "command", "ready"];
  async function toolQuoteRef() {
    try {
      if (!currentUser || TOOL_PAGES.indexOf(pageKey()) < 0) return false;
      const q = new URLSearchParams(location.search || "");
      const key = q.get("quote") ? "quote" : (q.get("id") ? "id" : "");
      const ref = key ? String(q.get(key)) : "";
      if (!ref || HelmUrl.isUuid(ref) || ref.length > 80) return false;
      const e = await rpc("resolve_event_ref", { p_ref: ref });
      if (!e || !e.id || !HelmUrl.isUuid(e.id)) return false;
      q.set(key, e.id);
      location.replace(location.pathname + "?" + q.toString() + (location.hash || ""));
      return true;
    } catch (e) { return false; }
  }
  async function init() {
    if (ready) return ready;
    ready = (async () => {
      // PKCE flow (no tokens in the URL): email / OAuth links return with ?code=,
      // which supabase-js exchanges (detectSessionInUrl) using the code verifier it
      // saved in THIS browser when the link was requested. Note it before init so a
      // failed exchange (link opened in another browser / already used) can be shown.
      // A legacy implicit-flow fragment (#access_token=…) is never read: strip it.
      try {
        const qs = new URLSearchParams(location.search || "");
        urlAuthCode = !!qs.get("code");
        urlAuthError = qs.get("error_code") || qs.get("error") || "";
        // EXCEPTION (0131 invite e-mails sent by Supabase Auth): a staff invitation link opens
        // login?invite=<token> with an invite / magic-link fragment. Keep those two tokens in
        // memory only, ONLY on the login page with an invite token, and hand them to
        // setSession() below (Supabase re-validates them server-side); everything else is dropped.
        const hp = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
        if (pageKey() === "login" && /^[0-9a-f]{16,128}$/i.test(qs.get("invite") || "") && /^(invite|magiclink)$/.test(hp.get("type") || "")
            && /^[A-Za-z0-9._-]{20,4096}$/.test(hp.get("access_token") || "") && /^[A-Za-z0-9._-]{6,512}$/.test(hp.get("refresh_token") || ""))
          inviteFragment = { access_token: hp.get("access_token"), refresh_token: hp.get("refresh_token"), type: hp.get("type") };
        // an e-mail link that failed at Supabase (expired / already used) comes back as
        // #error=access_denied&error_code=otp_expired&error_description=… : note the code
        // (short, allow-listed shape only) so the page can say so, then drop the fragment
        const hErr = String(hp.get("error_code") || hp.get("error") || "");
        if (!urlAuthError && /^[a-z0-9_]{1,64}$/i.test(hErr)) urlAuthError = hErr.toLowerCase();
        if (/(^#|&)(access_token|refresh_token|provider_token|error|error_code|error_description)=/.test(location.hash || "") && global.history && global.history.replaceState)
          global.history.replaceState(null, "", location.pathname + location.search);
      } catch (e) {}
      if (supaConfigured()) {
        try { const ok = await loadSupabaseLib();
          if (ok && global.supabase && global.supabase.createClient) {
            supa = global.supabase.createClient(CFG.url, CFG.anonKey,
              { auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.localStorage },
                global: { fetch: authAwareFetch } });
            if (inviteFragment) {
              // never swap an existing signed-in account for one carried in a link (login-CSRF guard);
              // accept_invitation still refuses an invite whose e-mail differs from the session's.
              try { const cur = await supa.auth.getSession(); if (!(cur && cur.data && cur.data.session)) {
                const isNew = inviteFragment.type === "invite";   // "Invite user" link = brand-new account with no password yet
                const sr = await supa.auth.setSession({ access_token: inviteFragment.access_token, refresh_token: inviteFragment.refresh_token });
                // 0205: a NEW link e-mailed from the join page ("Email me a new link") may be a magic link
                // for a login the invitation made without a password: ask the server (own login only)
                let needPw = isNew;
                if (sr && !sr.error && sr.data && sr.data.user) {
                  try { const np = await supa.rpc("my_needs_password"); if (!np.error && typeof np.data === "boolean") needPw = np.data; } catch (e) {}
                }
                try { sessionStorage.setItem("bp_invite_link_session", "1");
                  if (needPw && sr && !sr.error && sr.data && sr.data.user) sessionStorage.setItem(INVITE_SET_PW_KEY, sr.data.user.id); } catch (e) {} } } catch (e) {}
              inviteFragment = null;
            }
            const gs = await supa.auth.getSession();
            const session = gs && gs.data ? gs.data.session : null;
            // a stored session whose refresh hit a NETWORK error is unknown, not signed out
            try { sessionUnverified = !session && !!(gs && gs.error) && !definiteAuthRefusal(gs.error) && hasStoredSession(); } catch (e) { sessionUnverified = false; }
            currentUser = session ? session.user : null;
            if (urlAuthCode) {
              // the code was exchanged (or failed): drop ?code= from the address bar
              if (!session && !urlAuthError) urlAuthError = "pkce_exchange_failed";
              try { const q = new URLSearchParams(location.search || ""); ["code", "type"].forEach((k) => q.delete(k)); const qs = q.toString();
                if (global.history && global.history.replaceState) global.history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + (location.hash || "")); } catch (e) {}
            }
            // a reset link that landed on another page (e.g. the Site URL) must not just
            // sign the person in: the signed token says "recovery" → the reset page
            try {
              if (session && pageKey() !== "reset-password" && jwtAmrMethods(session.access_token).indexOf("recovery") !== -1 && urlAuthCode) {
                location.replace("/reset-password");
                return new Promise(() => {});
              }
            } catch (e) {}
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
                  setTimeout(function () { onAuthFailure(); }, 600);   // let a cross-tab token rotation land first
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
                coEarly = fetchCheckoutStatus(false); coEarly.catch(() => {});      // 0056 checkout step, same round-trip
              }
              await evaluateGate();
              // role + access matrix are needed by nearly every page right after it
              // shows: start them now (cached per tab; failures are retried by the page)
              if (PAGE_GATED && !pendingStep) loadAccess().catch(() => {});
            }
            mode = "supabase";
            await runPageGate();          // protected page: confirm session + studio before it shows
            if (await toolQuoteRef()) await HANG();
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
  async function getRole() {
    if (!supa || !currentUser) return null;
    if (roleCache) return roleCache;
    const cached = sessEntry("bp_sess_role", currentUser.id);
    // rbac-1030: only a FRESH (<= SESS_TTL) snapshot is reused. A stale role/matrix used to be served for one more
    // navigation (stale-while-revalidate), so an admin's Roles & access change could take two page loads to show.
    if (cached && cached.val && cached.fresh) { roleCache = cached.val; return roleCache; }
    if (rolePromise) return rolePromise;
    rolePromise = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { data, error } = await supa.from("profiles").select("role").eq("id", currentUser.id).maybeSingle();   // L7
          if (error) throw error;
          if (!data) throw new Error("no profile row");   // same as .single()'s 0-row error: retry, then unknown
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
    if (csnap && csnap.val && csnap.fresh && csnap.val.role && (!roleCache || csnap.val.role === roleCache)) {   // rbac-1030: fresh only
      roleCache = csnap.val.role;   // role and matrix of this page always come from the same snapshot
      accessCache = csnap.val; return accessCache;
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
          '<p style="margin:14px 0 0"><a href="dashboard.html" style="color:var(--accent,#047857);font-weight:600">← Back to dashboard</a></p>';
        box.querySelector("[data-retry]").addEventListener("click", () => location.reload());
      } else {
        box.innerHTML = '<div style="font-size:34px" aria-hidden="true">🔒</div><h2 style="color:var(--ink,#141b2e);margin:10px 0 6px">No access</h2><p style="margin:0 0 14px">Your role doesn’t have access to this page. Ask an admin if you need it.</p><a href="dashboard.html" style="color:var(--accent,#047857);font-weight:600">← Back to dashboard</a>';
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
    // Product tour "seen" flag, kept SERVER-side on the account (auth user_metadata,
    // the user's own record — no SQL) so it follows the person across devices and
    // browsers. localStorage alone reset per device → the tour re-ran on every new
    // browser / cleared storage. → true | false | null (no signed-in user)
    tourSeen: () => { const u = pendingStep ? null : currentUser; if (!u) return null; const m = u.user_metadata || {}; return m.helm_tour_seen === true; },
    // Account created on/after the server-side flag shipped (older accounts have
    // already been through onboarding, so they never auto-see the tour again).
    tourEligible: () => { const u = pendingStep ? null : currentUser; if (!u) return false; const t = Date.parse(u.created_at || ""); return t >= Date.parse("2026-10-09T00:00:00Z"); },
    markTourSeen: async () => {
      const u = pendingStep ? null : currentUser; if (!u || !supa) return false;
      if ((u.user_metadata || {}).helm_tour_seen === true) return true;
      try { const { data, error } = await supa.auth.updateUser({ data: { helm_tour_seen: true } }); if (error) return false; if (data && data.user && currentUser && data.user.id === currentUser.id) currentUser = data.user; return true; } catch (e) { return false; }
    },
    // R4: getting-started checklist hint "seen" - same per-account flag pattern as the tour
    gsHintSeen: () => { const u = pendingStep ? null : currentUser; if (!u) return null; return (u.user_metadata || {}).helm_gs_hint_seen === true; },
    markGsHintSeen: async () => {
      const u = pendingStep ? null : currentUser; if (!u || !supa) return false;
      if ((u.user_metadata || {}).helm_gs_hint_seen === true) return true;
      try { const { data, error } = await supa.auth.updateUser({ data: { helm_gs_hint_seen: true } }); if (error) return false; if (data && data.user && currentUser && data.user.id === currentUser.id) currentUser = data.user; return true; } catch (e) { return false; }
    },
    // Free-trial checklist, per account (auth user_metadata.helm_trial_gs, same pattern as the tour flag):
    // {event, builder} = the person opened a sample event / the layout builder, dismissed = hid the list.
    // UI-only flags (no studio data). null when nobody is signed in.
    trialSteps: () => {
      const u = pendingStep ? null : currentUser; if (!u) return null;
      const v = (u.user_metadata || {}).helm_trial_gs; const o = {};
      if (v && typeof v === "object") ["event", "builder", "dismissed"].forEach((k) => { if (v[k] === true) o[k] = true; });
      return o;
    },
    markTrialStep: async (key, on) => {
      if (["event", "builder", "dismissed"].indexOf(key) < 0) return false;
      const u = pendingStep ? null : currentUser; if (!u || !supa) return false;
      const cur = auth.trialSteps() || {}; const want = on !== false;
      if ((cur[key] === true) === want) return true;
      const next = Object.assign({}, cur); if (want) next[key] = true; else delete next[key];
      try { const { data, error } = await supa.auth.updateUser({ data: { helm_trial_gs: next } }); if (error) return false; if (data && data.user && currentUser && data.user.id === currentUser.id) currentUser = data.user; return true; } catch (e) { return false; }
    },
    // the signed-in account even while a step is pending (login / reset pages only)
    pendingUser: () => currentUser,
    // "" | the error from an auth link return: "pkce_exchange_failed" = the ?code=
    // could not be exchanged (opened in a different browser, or used / expired).
    linkError: () => urlAuthError,
    linkReturned: () => urlAuthCode,
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
    // 0183: in a studio that is read-only after its free trial every capability except "view" is
    // false (owner and invited members alike) — the server refuses those writes anyway.
    async can(cap) {
      if (mode !== "supabase") return true; if (!currentUser) return false;
      const [r, ro] = await Promise.all([getRole(), cap === "view" ? false : studioReadOnly()]); if (!r) return false;
      if (!(ROLE_CAPS[r] || ["view"]).includes(cap)) return false;
      if (ro) return false;
      // 0147: create also follows the "Create new quotes" switch (no row = default ON), mirroring can_create()
      if (cap === "create" && r !== "admin") {
        const acc = await loadAccess();
        if (acc.unknown) return false;
        const cell = acc.map && acc.map.quote_create;
        if (cell) return !!cell.edit;
      }
      return true;
    },
    canEdit: async () => { if (mode !== "supabase") return true; if (!currentUser) return false;
      const [r, ro] = await Promise.all([getRole(), studioReadOnly()]); return EDIT_ROLES.includes(r) && !ro; },
    // ---- role-based VIEW scope (must mirror the RLS read policies in phase21-hardening.sql) ----
    // finance = money pages/tables; pipeline = leads/CRM/discovery/proposal; ops = resources/planning/day-of; workspace = the event hub.
    // Area may be a fine key (e.g. "leads") or a legacy coarse key ("finance",
    // "pipeline", "ops", "workspace", "manage"). Driven by the live role_access
    // matrix; falls back to VIEW_SCOPE only when the matrix isn't present.
    async canView(area) {
      if (mode !== "supabase") return true;          // single-user offline/server mode
      if (!currentUser) return false;
      if (TRIAL_OFF_AREAS[area] && (await inFreeTrial())) return false;   // 0203: not part of the free trial
      const r = await getRole();
      if (r === "admin") return true;                // admin: full floor
      const acc = await loadAccess();
      if (acc.unknown) return false;                 // matrix unreachable → fail closed (not cached)
      const fine = COARSE_TO_FINE[area];             // set only for coarse keys
      if (acc.map) {
        if (fine) return fine.some((k) => acc.map[k] && acc.map[k].view);   // coarse: any child visible
        if (!acc.map[area] && AREA_FALLBACK[area]) return !!(acc.map[AREA_FALLBACK[area]] && acc.map[AREA_FALLBACK[area]].view);   // 0241
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
      const [r, ro] = await Promise.all([getRole(), studioReadOnly()]);
      if (ro) return false;                          // 0183: read-only after the free trial (admins too)
      if (TRIAL_OFF_AREAS[area] && (await inFreeTrial())) return false;   // 0203: not part of the free trial
      if (r === "admin") return true;
      const acc = await loadAccess();
      if (acc.unknown) return false;
      const fine = COARSE_TO_FINE[area];
      if (acc.map) {
        if (fine) return fine.some((k) => acc.map[k] && acc.map[k].edit);
        if (!acc.map[area] && AREA_FALLBACK[area]) return !!(acc.map[AREA_FALLBACK[area]] && acc.map[AREA_FALLBACK[area]].edit);   // 0241
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
        if (pageKey() !== "login") { try { location.href = "login.html?next=" + encodeURIComponent(HelmUrl.here()); } catch (x) {} }
        throw e;
      }
      localAuthOp++;
      try {
        const prev = currentUser;
        if (prev) { explicitSignOut = true; try { await supa.auth.signOut({ scope: "local" }); } catch (e) {} currentUser = null; pendingStep = null; }
        const { data, error } = await supa.auth.signInWithPassword(captchaToken ? { email, password, options: { captchaToken } } : { email, password });
        if (error) throw genericSignInError(error);
        const st = sessionStart();
        if ((prev && prev.id !== data.user.id) || (st && st.uid !== data.user.id)) userLocalClear();
        // Take the user from the stored session (same object signInWithPassword just saved), so the
        // sign-in response itself never flows into web storage (CodeQL clear-text-storage).
        const { data: sd } = await supa.auth.getSession();
        if (!(sd && sd.session && sd.session.user && sd.session.user.id === data.user.id)) throw genericSignInError(new Error("no session after sign-in"));
        currentUser = sd.session.user; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; sessClear(); authRequired = false;
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
        // emailRedirectTo: the confirm link returns to the sign-in page with ?code= (PKCE)
        const so = { emailRedirectTo: (opts && opts.emailRedirectTo) || (location.origin + "/login.html") };
        if (captchaToken) so.captchaToken = captchaToken;
        const fullName = opts && typeof opts.fullName === "string" ? opts.fullName.trim().slice(0, 50) : "";
        if (fullName) so.data = { full_name: fullName };
        // round 19: what this sign-up was for (free trial / paid studio) + the studio name typed, kept on the
        // account so a confirm link opened in ANOTHER browser can still go straight on to the trial welcome
        const intent = opts && (opts.intent === "trial" || opts.intent === "direct") ? opts.intent : "";
        if (intent) {
          const sn = opts && typeof opts.studioName === "string" ? opts.studioName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
          so.data = Object.assign({}, so.data || {}, { helm_signup_intent: intent, helm_signup_studio: sn });
        }
        // 0205: this browser started a sign-up for this address - /auth/confirm keeps the confirm link's
        // session only then (a link someone else made for THEIR account never signs this browser in)
        try { localStorage.setItem(SIGNUP_MARK_KEY, String(email || "").trim().toLowerCase().slice(0, 254)); } catch (e) {}
        const { data, error } = await supa.auth.signUp({ email, password, options: so });
        if (error) {
          const c = String(error.code || ""), m = String(error.message || ""), st = Number(error.status) || 0;
          if (st === 429 || /rate limit|too many/i.test(m)) { const e = new Error("Too many requests — please wait a few minutes and try again."); e.code = "rate_limited"; throw e; }
          if (/captcha/i.test(m)) { const e = new Error("The security check failed — please try again."); e.code = "captcha_failed"; throw e; }
          // "already registered" must look exactly like a fresh sign-up awaiting confirmation
          if (/user_already_exists|email_exists|already registered|already exists/i.test(c + " " + m)) return { user: null, session: null, generic: GENERIC_SENT };
          throw error;
        }
        if (!data.session) return { user: null, session: null, generic: GENERIC_SENT };
        if (data.session) { userLocalClear(); currentUser = data.user; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; sessClear(); authRequired = false; stampSessionStart(currentUser.id, true); await evaluateGate(); }
        return { user: data.user, session: data.session };   // session null when email confirmation is required
      } finally { localAuthOp--; }
    },
    // Google OAuth sign-in (requires the Google provider enabled in Supabase).
    // Redirects the browser to Google; on return, login.html resumes (and, for a
    // pending studio signup, calls create_studio). redirectTo must be an allowed
    // Redirect URL in Supabase → Authentication → URL Configuration.
    // No offline access is requested: Helm never calls Google APIs, so it neither
    // needs nor should receive a long-lived Google refresh token. PKCE flow: Google
    // returns to redirectTo with ?code=, exchanged in init() (detectSessionInUrl).
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
    // Explicit "Log out" = THIS browser only (r20-coord #33). scope "local" still revokes this session's refresh
    // token on the server; it no longer ends the account's sessions on other browsers / devices (supabase-js v2's
    // bare signOut() defaults to "global", which logged the owner's Safari out when another browser signed out).
    // "Sign out other devices" (signOutOthers, scope "others") is the explicit way to end the rest.
    async signOut() { explicitSignOut = true; reauthClear(); if (currentUser && currentUser.id) lsSet(SIGNOUT_KEY, JSON.stringify({ uid: currentUser.id, ts: Date.now() })); if (supa) { try { await supa.auth.signOut({ scope: "local" }); } catch (e) { try { await supa.auth.signOut({ scope: "local" }); } catch (x) {} } } currentUser = null; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; pendingStep = null; sessClear(); userLocalClear(); navTrailClear(); studioSlugCache = null;
      lsDel(SESSION_START_KEY); lsDel(RECOVERY_KEY);
      if (mode === "supabase") authRequired = true; },
    // End every OTHER session of this account (other browsers / devices); this one stays.
    async signOutOthers() {
      if (!supa) throw new Error("Supabase not configured");
      const { error } = await supa.auth.signOut({ scope: "others" });
      if (error) throw error; return true;
    },
    // Change my sign-in e-mail (Supabase change-email flow): Supabase sends a confirmation
    // link (to both addresses when "secure e-mail change" is on); nothing changes until it
    // is clicked. → { pending: newEmail }
    async changeEmail(newEmail) {
      if (!supa || !currentUser) throw new Error("Supabase not configured");
      const em = String(newEmail == null ? "" : newEmail).trim().toLowerCase();
      if (!/^[^\s@<>()\[\],;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(em) || em.length > 254) { const e = new Error("Enter a valid e-mail address."); e.code = "email_invalid"; throw e; }
      if (em === String(currentUser.email || "").toLowerCase()) { const e = new Error("That's already your e-mail address."); e.code = "email_same"; throw e; }
      const { error } = await supa.auth.updateUser({ email: em }, { emailRedirectTo: location.origin + "/login.html" });
      if (error) throw error;
      return { pending: em };
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
    // The temporary password is the "current password" Supabase requires (prod has
    // "require current password" ON): completePasswordChange(newPw, { currentPassword }).
    async completePasswordChange(newPassword, opts) {
      if (!supa) throw new Error("Supabase not configured");
      const bad = passwordProblem(newPassword); if (bad) throw new Error(bad);
      // only while the server says this account holds a temp password (evaluateGate)
      if (!pwChangedAwaitingClear && pendingStep !== "password") { const e = new Error("Please sign in again to change your password."); e.code = "reauth_required"; throw e; }
      let cur = opts && typeof opts.currentPassword === "string" ? opts.currentPassword : "";
      if (opts) opts.currentPassword = null;
      if (!pwChangedAwaitingClear) {
        if (!cur) { const e = new Error("Enter the temporary password you signed in with."); e.code = "current_password_required"; throw e; }
        const attrs = { password: newPassword, current_password: cur }; cur = null;
        const { error } = await supa.auth.updateUser(attrs);   // attrs is local: dropped with this call
        if (error) {
          if (/different from the old|same_password/i.test(String(error.message || "") + " " + String(error.code || ""))) throw new Error("Choose a password that's different from the temporary one.");
          if (/current.?password|reauthenticat/i.test(String(error.message || "") + " " + String(error.code || ""))) { const e = new Error("The temporary password isn't right."); e.code = "bad_current_password"; e.cause = error; throw e; }
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
    genericMessages: { signIn: GENERIC_SIGNIN, sent: GENERIC_SENT, resend: GENERIC_RESEND },
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
    // Re-send the sign-up confirmation email. Resolves the same way whether or not the
    // email has an account / still needs confirming (no enumeration) — the caller shows
    // GENERIC_RESEND. Only rate-limit / network / CAPTCHA errors throw.
    async resendSignup(email, opts) {
      if (!supa) throw new Error("Supabase not configured");
      const em = String(email || "").trim().toLowerCase();
      if (!em) return true;
      const o = { emailRedirectTo: (opts && opts.emailRedirectTo) || (location.origin + "/login.html") };
      if (opts && opts.captchaToken) o.captchaToken = opts.captchaToken;
      const { error } = await supa.auth.resend({ type: "signup", email: em, options: o });
      if (error) {
        const st = Number(error.status) || 0, m = String(error.message || "");
        if (st === 429 || /rate limit|too many|seconds/i.test(m)) { const e = new Error("Too many requests — please wait a minute and try again."); e.code = "rate_limited"; throw e; }
        if (/captcha/i.test(m)) { const e = new Error("The security check failed — please try again."); e.code = "captcha_failed"; throw e; }
        if (global.BPUI && global.BPUI.isNetworkError && global.BPUI.isNetworkError(error)) throw error;
      }
      return true;
    },
    // Re-check the CURRENT password before a change (signs in again as the same
    // email). Returns "mfa" when the new session still needs the two-step code.
    // FAILS CLOSED: any error (wrong password, rate limit, a different account
    // coming back) → one generic message, and no change proof is recorded.
    hasPassword: () => hasPasswordLogin(),
    // A NEW invitee (arrived by the Supabase "Invite user" link, so the account has no
    // password yet) must choose one + give their name before entering the studio.
    // Magic-link invitees (existing accounts) never get this flag.
    inviteSetPasswordPending: () => invitePwPending(),
    // 0205 - /auth/confirm: e-mail links on Helm's own domain (token_hash + type), verified here.
    // → { user } | throws the Supabase error (otp_expired / access_denied …). Never called with a session open.
    async verifyEmailLink(tokenHash, type) {
      if (!supa) throw new Error("Supabase not configured");
      if (!/^(invite|magiclink|recovery|signup|email|email_change)$/.test(String(type || ""))) { const e = new Error("bad link type"); e.code = "bad_type"; throw e; }
      localAuthOp++;
      try {
        const { data, error } = await supa.auth.verifyOtp({ token_hash: String(tokenHash || ""), type: type === "signup" ? "email" : type });
        if (error) throw error;
        if (data && data.user) { currentUser = data.user; hadSession = true; }
        return { user: (data && data.user) || null };
      } finally { localAuthOp--; }
    },
    // does MY login still have no password (0205 my_needs_password)? null = unknown (not applied / offline)
    async needsPassword() {
      if (!supa || !currentUser) return null;
      try { const r = await supa.rpc("my_needs_password"); return !r.error && typeof r.data === "boolean" ? r.data : null; } catch (e) { return null; }
    },
    // the session came from an invitation e-mail link: same marks as the #fragment path in init()
    markInviteLinkSession(needPw) {
      try { sessionStorage.setItem("bp_invite_link_session", "1");
        if (needPw && currentUser && currentUser.id) sessionStorage.setItem(INVITE_SET_PW_KEY, currentUser.id); } catch (e) {}
    },
    // a sign-up for this address was started in THIS browser (and the marker is used up)
    signupStartedHere(email) {
      try { const m = localStorage.getItem(SIGNUP_MARK_KEY); const ok = !!m && m === String(email || "").trim().toLowerCase();
        if (ok) localStorage.removeItem(SIGNUP_MARK_KEY); return ok; } catch (e) { return false; }
    },
    async setInvitePassword(newPassword, fullName) {
      if (!supa) throw new Error("Supabase not configured");
      if (!invitePwPending()) { const e = new Error("Please sign in again to set your password."); e.code = "reauth_required"; throw e; }
      const name = String(fullName || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!name) { const e = new Error("Enter your full name."); e.code = "name_required"; throw e; }
      const bad = passwordProblem(newPassword); if (bad) { const e = new Error(bad); e.code = "weak_password"; throw e; }
      const attrs = { password: newPassword, data: { full_name: name } };
      const { data, error } = await supa.auth.updateUser(attrs);   // attrs is local: dropped with this call
      if (error) throw error;
      if (data && data.user && currentUser && data.user.id === currentUser.id) currentUser = data.user;
      try { sessionStorage.removeItem(INVITE_SET_PW_KEY); } catch (e) {}
      return true;
    },
    isRecoverySession: () => isRecoverySession(),
    async reverifyPassword(currentPassword, opts) {
      reauthClear();
      if (!supa || !currentUser || !currentUser.email) throw new Error("Not signed in");
      if (!hasPasswordLogin()) { const e = new Error("This account signs in with Google, so it has no Helm password to change."); e.code = "bad_current_password"; throw e; }
      if (typeof currentPassword !== "string" || !currentPassword) { const e = new Error("Your current password isn't right."); e.code = "bad_current_password"; throw e; }
      let pw = currentPassword; currentPassword = null;   // only this local survives, until the re-sign-in returns
      const captchaToken = opts && opts.captchaToken;
      if (CAPTCHA && !captchaToken) { const e = new Error("Please complete the security check."); e.code = "captcha_required"; throw e; }
      localAuthOp++;
      try {
        const email = currentUser.email, uid = currentUser.id;
        let res;
        try { res = await supa.auth.signInWithPassword(captchaToken ? { email, password: pw, options: { captchaToken } } : { email, password: pw }); }
        catch (x) { res = { data: null, error: x }; }
        finally { pw = null; }
        const { data, error } = res || {};
        if (error && LOCKOUT_RE.test(String(error.message || ""))) { const e = new Error(String(error.message)); e.code = "account_locked"; throw e; }
        if (error || !data || !data.user || data.user.id !== uid) { const e = new Error("Your current password isn't right."); e.code = "bad_current_password"; e.cause = error; throw e; }
        // currentUser is already this account (data.user.id === uid checked above); keep it rather than
        // copying the sign-in response, which must not flow into web storage.
        explicitSignOut = false;
        reauth = { uid, until: Date.now() + REAUTH_MS };
        const { data: lv } = await supa.auth.mfa.getAuthenticatorAssuranceLevel();
        return (lv && lv.nextLevel === "aal2" && lv.currentLevel !== "aal2") ? "mfa" : null;
      } finally { localAuthOp--; }
    },
    // Set a new password for the signed-in user (reset link or change), then end
    // every other session. The rule is enforced here AND by the Supabase policy.
    // Allowed only (a) right after reverifyPassword() for this account, or (b) in a
    // genuine reset-link session (JWT amr "recovery"). Anything else fails closed.
    // The current password is NOT retained after reverifyPassword(). If the Supabase
    // Prod has Supabase "require current password" ON: an ordinary change MUST pass it
    // here — updatePassword(newPw, { currentPassword }) — sent once as current_password
    // and never kept. A genuine reset-link (recovery) session needs no current password
    // (Supabase skips the check for recovery sessions), so none is sent there.
    async updatePassword(newPassword, opts) {
      if (!supa) throw new Error("Supabase not configured");
      const bad = passwordProblem(newPassword); if (bad) throw new Error(bad);
      let cur = opts && typeof opts.currentPassword === "string" ? opts.currentPassword : "";
      if (opts) opts.currentPassword = null;
      const recovery = await isRecoverySession();
      const fresh = reauthFresh();
      if (!fresh && !recovery) { reauthClear(); const e = new Error("Please confirm your current password first."); e.code = "reauth_required"; throw e; }
      const attrs = { password: newPassword };
      if (!recovery) {
        if (!cur) { const e = new Error("Enter your current password."); e.code = "current_password_required"; throw e; }
        attrs.current_password = cur;
      }
      cur = null;
      const { error } = await supa.auth.updateUser(attrs);   // attrs is local: dropped with this call
      if (error) {
        if (/different from the old|same_password/i.test(String(error.message || "") + " " + String(error.code || ""))) throw new Error("Choose a password that's different from your current one.");
        if (/current.?password|reauthenticat/i.test(String(error.message || "") + " " + String(error.code || ""))) { const e = new Error("Your current password isn't right."); e.code = "bad_current_password"; e.cause = error; throw e; }
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
        let wait = mfaLockLeft(uid);
        if (wait <= 0) { const sv = await mfaLockFetch(uid); wait = sv || 0; }
        if (wait > 0) throw mfaLockedError(wait);
        const c = String(code || "").replace(/\s+/g, "");
        if (!/^\d{6}$/.test(c)) throw new Error("Enter the 6-digit code from your authenticator app.");
        let error = null;
        try { error = (await supa.auth.mfa.challengeAndVerify({ factorId, code: c })).error; } catch (x) { error = x; }
        if (error) {
          // Network trouble is not a wrong code (no lockout strike; friendlyError explains it)
          if (global.BPUI && global.BPUI.isNetworkError && global.BPUI.isNetworkError(error)) throw error;
          const st = Number(error.status) || 0, msg = String(error.message || "") + " " + String(error.code || "");
          const left = (st === 429 || /rate.?limit|too many/i.test(msg)) ? mfaLockFor(uid, 60000) : await mfaStrike(uid);
          if (left > 0) throw mfaLockedError(left, error);
          // one generic message: never says whether the factor, the challenge or the code was the problem
          const e = new Error("That code didn't work. Codes change every 30 seconds — enter the newest one, and check the time on your phone is set automatically."); e.code = "mfa_invalid"; e.cause = error; throw e;
        }
        mfaLockClear();
        const { data: s } = await supa.auth.getSession(); if (s && s.session) currentUser = s.session.user;
        try { await supa.rpc("mfa_record_success"); } catch (e) {}   // server clears the counter only at aal2
        await evaluateGate();
        return true;
      },
      // seconds until another code may be tried (0 = now) — UI countdown
      lockedSeconds() { return Math.ceil(mfaLockLeft(currentUser && currentUser.id) / 1000); },
      // ask the server for this account's lock (another tab / device may have set it)
      async refreshLock() { const uid = currentUser && currentUser.id; await mfaLockFetch(uid); return Math.ceil(mfaLockLeft(uid) / 1000); },
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
          const [lv, fs, req] = await Promise.all([this.level(), this.verifiedTotp(), hqMfaRequired()]);
          return operatorMfaDecision(lv, fs.length, req);
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
    sessionLimits: { config: () => Object.assign({}, AUTH_CFG), decision: sessionDecision, signedOutElsewhere: signedOutElsewhere, start: () => startSessionLimits() },
    onChange(cb) { if (supa) supa.auth.onAuthStateChange((_e, session) => {
      if (localAuthOp) return;   // this tab's own sign-in in progress — its caller updates state
      currentUser = session ? session.user : null; roleCache = null; accessCache = null; rolePromise = null; accessPromise = null; sessClear();
      if (mode === "supabase") authRequired = !currentUser; if (cb) cb(currentUser); }); },
    // ---- admin user management (RPC guarded by is_admin() at the DB) ----
    admin: {
      roles: () => PICK_ROLES.slice(),
      roleLabel,
      areas: () => AREAS.slice(),
      // B29: areas a FREE-TRIAL studio never gets whatever the matrix says (0203) -> [] for a paid studio. The Roles
      // matrix hides them in the trial so it never offers a switch that does nothing.
      trialOffAreas: () => inFreeTrial().then((t) => (t ? Object.keys(TRIAL_OFF_AREAS) : []), () => []),
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
        if (error) throw error; accessCache = null; try { sessionStorage.removeItem("bp_sess_access"); } catch (e) {} return data;
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
  // D4: EVERY row of a list (PostgREST silently caps one response at max-rows, 1000 by
  // default). `build` returns a FRESH query each call (ordered, with a unique tie-breaker
  // such as id); we walk it with .range() in 1000-row pages up to SB_ALL_MAX rows. Past
  // the cap the result is flagged (.truncated = true) and a warning is logged, never cut silently.
  const SB_ALL_CHUNK = 1000, SB_ALL_MAX = 20000;
  async function sbAll(build, max) {
    const cap = Math.max(1, max || SB_ALL_MAX); let out = [];
    for (let off = 0; off < cap; off += SB_ALL_CHUNK) {
      const want = Math.min(SB_ALL_CHUNK, cap - off);
      const { data, error } = await build().range(off, off + want - 1);
      if (error) throw error;
      const rows = data || []; out = out.concat(rows);
      if (rows.length < want) return out;
    }
    try { console.warn("[helm] list reached the " + cap + "-row safety cap; older rows are not shown"); } catch (_) {}
    out.truncated = true; return out;
  }
  // D12: a unique-name clash (23505 from the 0073 partial unique indexes) as a message people can act on
  function dupError(e, what, name) {
    if (!e || e.code !== "23505") return e;
    const n = String(name == null ? "" : name).trim().slice(0, 80);
    const x = new Error((n ? "A " + what + " named \u201c" + n + "\u201d" : "An active " + what + " with this name") +
      " already exists \u2014 open it from the list instead of adding it again.");
    x.duplicate = true; x.cause = e; return x;
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
  // R20 (live QA): the MMDDYYYY stamp of a quote-code guess. With no date it is the STUDIO's today (the server stamps
  // codes with the studio's local date) - the browser's date gave 10182026-01 while the real code was 10192026-01.
  // An explicit Date keeps its own calendar day.
  const quoteCodeStamp = (date) => {
    if (!date) {
      try { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(BPStore.todayLocal ? BPStore.todayLocal() : "")); if (m) return m[2] + m[3] + m[1]; } catch (e) {}
    }
    const d = date || new Date();
    return String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + d.getFullYear();
  };
  const localISODate = (d) => { const x = d || new Date(); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };

  /* ---------------- quotes + versions ---------------- */
  // What a quotes LIST shows — never the full pricing JSON (line items, computed
  // breakdown, catering…), only its total and client; layouts live in quote_versions.
  // la-fetch (audit 23): never the client approval link (approval_token) and never the whole client JSON
  // (e-mail, notes, ...) - only the client fields a list shows: name + phone, plus venue / address / city for
  // the calendar's venue-clash check. A page that needs more opens ONE quote with get().
  const QUOTE_LIST_COLS = "id,code,title,event_type,status,lifecycle_stage,approval_status,current_version," +
    "event_date,event_time,updated_at,created_at,confirmed_at,client_name:client->>name,client_phone:client->>phone," +
    "client_venue:client->>venue,client_address:client->>address,client_city:client->>city,total:pricing->total," +
    "pricing_client_name:pricing->client->>name,pricing_client_phone:pricing->client->>phone," +
    "tax_country:pricing->>taxCountry,tax_region:pricing->>taxRegion,tax_name:pricing->>taxName,tax_currency:pricing->>currency," +
    "pricing_guests:pricing->guests,client_guests:client->>guests";   // B11: each quote's OWN currency; cal-events-1018: guest count (a number, no contact) for the calendar
  // A list VIEW (page) needs even less: the client's name + phone, not the whole client JSON.
  // r20: + venue / address / city and the guest count, so the automatic event name (TYPE_CITY_GUESTS_DATE)
  // matches the event page - the list showed "WED_03DEC26" where the event page said "WED_HYD_200_03DEC26".
  const QUOTE_PAGE_COLS = "id,code,title,event_type,status,lifecycle_stage,approval_status,current_version,event_date,event_time," +
    "updated_at,created_at,confirmed_at,client_name:client->>name,client_phone:client->>phone,total:pricing->total," +
    "pricing_client_name:pricing->client->>name,pricing_client_phone:pricing->client->>phone," +
    "tax_country:pricing->>taxCountry,tax_region:pricing->>taxRegion,tax_name:pricing->>taxName,tax_currency:pricing->>currency," +
    "client_venue:client->>venue,client_address:client->>address,client_city:client->>city,pricing_guests:pricing->guests,client_guests:client->>guests";
  const nameOnly = (n, p, x) => { const o = {}; if (n != null) o.name = n; if (p != null) o.phone = p;
    if (x) { if (x.client_venue != null) o.venue = x.client_venue; if (x.client_address != null) o.address = x.client_address; if (x.client_city != null) o.city = x.client_city;
      if (x.client_guests != null && x.client_guests !== "") o.guests = x.client_guests; }   // r20: same guest count the event page's name uses
    return o; };
  // cal-events-1018: the first whole, positive guest count of the candidates (pricing.guests, then client.guests)
  const listGuests = (...v) => { for (const x of v) { const n = Number(x); if (x != null && x !== "" && Number.isFinite(n) && n > 0) return Math.round(n); } return null; };
  function mapQuoteSummary(q) {
    let pricing = q.pricing;
    if (!pricing) { pricing = {}; if (q.total != null) pricing.total = q.total;
      if (q.pricing_client != null) pricing.client = q.pricing_client;
      else if (q.pricing_client_name != null || q.pricing_client_phone != null) pricing.client = nameOnly(q.pricing_client_name, q.pricing_client_phone);
      if (q.tax_country) { pricing.taxCountry = q.tax_country; if (q.tax_region) pricing.taxRegion = q.tax_region; if (q.tax_name) pricing.taxName = q.tax_name; if (q.tax_currency) pricing.currency = q.tax_currency; } }
    if (!q.client && (q.client_name != null || q.client_phone != null || q.client_venue != null || q.client_address != null || q.client_city != null))
      q = Object.assign({}, q, { client: nameOnly(q.client_name, q.client_phone, q) });
    return { id: q.id, code: q.code, title: q.title, eventType: q.event_type, status: q.status,
      lifecycleStage: q.lifecycle_stage || "quote",
      approvalStatus: q.approval_status || "none", approvalToken: q.approval_token,
      currentVersion: q.current_version, client: q.client || {}, pricing, total: pricing.total || 0,
      eventDate: q.event_date || null, eventTime: q.event_time || null,
      guests: listGuests(q.pricing_guests, q.client_guests, pricing.guests, q.client && q.client.guests),   // cal-events-1018 (null when unknown)
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
  // r19 L1: does THIS browser hold an unsaved floor plan (builder crash-safety copy, builder.js draftKey:
  // bps.draft.<user>.<quote>) with at least one object for this quote? Blocked storage -> false.
  function hasLocalLayoutDraft(quoteId, store) {
    const id = String(quoteId || ""); if (!id) return false;
    try {
      const ls = store || localStorage; const n = ls.length || 0;
      for (let i = 0; i < n; i++) {
        const k = ls.key(i);
        if (!k || k.indexOf("bps.draft.") !== 0 || k.slice(-(id.length + 1)) !== "." + id) continue;
        let d = null; try { d = JSON.parse(ls.getItem(k) || "null"); } catch (e) { d = null; }
        if (d && d.data && Array.isArray(d.data.items) && d.data.items.length > 0) return true;
      }
    } catch (e) {}
    return false;
  }
  const sbq = {
    // every quote, light columns (pickers, calendar, availability…). A database that
    // is missing one of the named columns falls back to select * rather than a 400.
    // Quotes moved to Archive / Deleted (0040) are left out, guarded like page().
    async list() {
      const r = await withShelf(async (shelf) => {
        const data = await sbAll(() => {
          let q = supa.from("quotes").select(QUOTE_LIST_COLS + (shelf ? QUOTE_SHELF_COLS : ""));
          if (shelf) q = q.is("archived_at", null).is("deleted_at", null);
          return q.order("updated_at", { ascending: false }).order("id", { ascending: false });
        });
        return { data };
      }).catch(async (e) => {
        if (!isMissingColumn(e)) throw e;   // an even older schema (pre lifecycle columns): select *
        return { data: await sbAll(() => supa.from("quotes").select("*").order("updated_at", { ascending: false }).order("id", { ascending: false })) };
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
        eventDate: q.event_date || null, eventTime: q.event_time || null, tax_snapshot: q.tax_snapshot || null, currency: q.currency || null,
        capacityDecision: q.capacity_decision || null,   // 0197: over-capacity decision (set_quote_capacity_decision)
        confirmedAt: q.confirmed_at, versions: vs.map((v) => ({ id: v.id, versionNo: v.version_no, label: v.label,
          objectCount: v.object_count, createdAt: v.created_at })) };
    },
    async setStage(id, stage, overrideReason) {
      // 0052: forward moves are gated server-side; an admin may pass a gate with a reason (audited)
      const args = { p_quote_id: id, p_stage: stage };
      if (overrideReason) args.p_override_reason = String(overrideReason);
      const { data, error } = await supa.rpc("set_lifecycle_stage", args);
      if (error) throw error; return data;
    },
    // 0052: ids (of the given ones) whose client approval went stale after a price change.
    // Fail-soft: a database without 0052 simply has no stale quotes.
    async staleApprovals(ids) {
      const list = (ids || []).filter(Boolean); if (!list.length) return new Set();
      try {
        const { data, error } = await supa.from("quotes").select("id,consent_stale,consent_stale_prev_total,consent_stale_new_total")
          .in("id", list.slice(0, 200)).eq("consent_stale", true);
        if (error) return new Set();
        const out = new Set((data || []).map((r) => r.id)); out.detail = {};
        (data || []).forEach((r) => { out.detail[r.id] = { prev: r.consent_stale_prev_total, next: r.consent_stale_new_total }; });
        return out;
      } catch { return new Set(); }
    },
    // 0052: rotate the client approval link after a price change (fresh OTP approval)
    async reissueApprovalLink(id) {
      const { data, error } = await supa.rpc("reissue_approval_link", { p_quote_id: id });
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
    // L8 (0075): reuse MY most recent untouched blank quote in this studio, else create one.
    // Server decides "untouched" + takes a per-user lock (two tabs never make two). Before
    // 0075 is installed (PGRST202 / 42883) it falls back to a plain create, as before.
    // 0141: soft-move this studio's EMPTY drafts (>24h old, nothing filled, no related rows)
    // to the Deleted shelf. Server-checked twice; restorable. Missing RPC → no-op.
    async discardEmptyDrafts() {
      const { data, error } = await supa.rpc("discard_empty_drafts", {});
      if (error) { if (error.code === "PGRST202" || error.code === "42883") return { discarded: 0 }; throw error; }
      return data || { discarded: 0 };
    },
    async startBlank(code) {
      const { data: q, error } = await supa.rpc("start_blank_quote", { p_code: code, p_title: code });
      if (error) {
        if (error.code === "PGRST202" || error.code === "42883") return this.create(code, code, null, { items: [] }, 0);
        throw error;
      }
      const row = Array.isArray(q) ? q[0] : q;
      // Owner bug: the server's "untouched" test only checks the client NAME, so a reused draft
      // where someone had typed just a phone / e-mail came back with that number pre-filled in
      // the NEW quote. Such a draft is not blank: leave it as-is (zero data loss) and start fresh.
      const cl = row && row.client && typeof row.client === "object" ? row.client : {};
      const clean = !["name", "phone", "email", "company"].some((k) => String(cl[k] == null ? "" : cl[k]).trim() !== "");
      if (!clean) return this.create(code, code, null, { items: [] }, 0);
      // r19 L1: a draft whose floor plan is still unsaved in THIS browser (builder crash-safety copy
      // bps.draft.<user>.<quote>) is not blank either - reusing it renamed the person's draft and offered
      // its plan in the "new" quote. Leave it untouched and start a fresh quote.
      if (row && row.id && hasLocalLayoutDraft(row.id)) return this.create(code, code, null, { items: [] }, 0);
      return row;
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
          // money-1024: 0 rows is ALSO what a refused write looks like (RLS / no edit right / locked
          // event) - only call it a conflict when the row really moved on since we read it.
          let cur = null;
          try { const r = await supa.from("quotes").select("updated_at").eq("id", quoteId).maybeSingle(); cur = r && !r.error && r.data ? r.data.updated_at : null; } catch (_) { cur = null; }
          if (cur && !sameStamp(cur, expectedUpdatedAt)) {
            const e = new Error("This event was changed by someone else since you opened it. Reload to get the latest, then reapply your change."); e.code = "CONFLICT"; throw e;
          }
          const e = new Error("Couldn't save — you may not have permission to change this event, or it is locked. Nothing was changed."); e.code = "NOT_SAVED"; throw e;
        }
        const e = new Error("Couldn't save — the change didn't reach the server. Reload the page and try again."); e.code = "NOT_SAVED"; throw e;
      }
      return Array.isArray(data) ? data[0] : data;
    },
    // 0042: "Delete" moves the quote to the Deleted shelf (Restore brings it back); the
    // server refuses a hard delete of a quote that is not on that shelf
    async remove(quoteId) { await rpc("move_quote_to_shelf", { p_quote_id: quoteId, p_shelf: "delete" }); return true; },
  };
  // money-1024: compare two timestamptz strings by instant (formats can differ: "+00:00" vs "Z", precision)
  function sameStamp(a, b) { if (a === b) return true; const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && x === y; }
  // localStorage fallback tier
  const LSQ = "bps.quotes";
  const lsq = {
    read() { try { return JSON.parse(localStorage.getItem(LSQ) || "[]"); } catch { return []; } },
    write(v) { try { localStorage.setItem(LSQ, JSON.stringify(v)); } catch {} },
    async list() { return this.read().map((q) => ({ id: q.id, code: q.code, title: q.title, eventType: q.eventType, status: q.status,
      lifecycleStage: q.lifecycleStage || "quote",
      currentVersion: q.currentVersion, client: q.client || {}, pricing: q.pricing || {}, total: (q.pricing && q.pricing.total) || 0,
      eventDate: q.eventDate || null, eventTime: q.eventTime || null,
      guests: listGuests(q.pricing && q.pricing.guests, q.client && q.client.guests),
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
  // Adds an auto-generated title to an updateMeta patch when the event's current title is
  // still automatic. Best-effort: any failure returns the patch unchanged (never blocks a save).
  async function autoTitlePatch(id, patch) {
    const EN = typeof window !== "undefined" && window.HelmEventName;
    if (!EN || !patch || patch.title != null || !("client" in patch || "eventType" in patch || "eventDate" in patch)) return patch;
    try {
      let cur, taken = [];
      if (mode === "supabase") {
        const { data, error } = await supa.from("quotes").select("id,code,title,event_type,event_date,client").eq("id", id).maybeSingle();
        if (error || !data) return patch; cur = data;
      } else { cur = (await lsq.list()).find((x) => x.id === id); if (!cur) return patch; }
      const code = cur.code, title = cur.title;
      if (!EN.isAuto(title, code)) return patch;
      const merged = { client: patch.client || cur.client || {}, eventType: patch.eventType != null ? patch.eventType : (cur.eventType != null ? cur.eventType : cur.event_type),
        eventDate: patch.eventDate !== undefined ? patch.eventDate : (cur.eventDate !== undefined ? cur.eventDate : cur.event_date) };
      const base = EN.fromQuote(merged); if (!base) return patch;
      if (title === base || (String(title || "").indexOf(base + "-") === 0 && /^-\d+$/.test(String(title).slice(base.length)))) return patch;
      if (mode === "supabase") {
        const { data } = await supa.from("quotes").select("title").like("title", base.replace(/[%_\\]/g, "\\$&") + "%").neq("id", id).limit(1000);
        taken = (data || []).map((r) => r.title);
      } else taken = (await lsq.list()).filter((x) => x.id !== id).map((x) => x.title);
      return Object.assign({}, patch, { title: EN.unique(base, taken) });
    } catch (e) { return patch; }
  }
  // perf 1017: share one in-flight read between callers that ask at the same moment (page + search
  // prefetch + widgets). Nothing is cached after it settles, so a later list() always re-reads.
  const _inflight = {};
  function shareInflight(key, fn) {
    if (_inflight[key]) return _inflight[key];
    const p = Promise.resolve().then(fn);
    _inflight[key] = p;
    const done = () => { if (_inflight[key] === p) delete _inflight[key]; };
    p.then(done, done);
    return p;
  }
  // la-fetch (audit 25): the shell (rail counts, search, bell, dashboard widgets) and the page used to
  // read the same lists a few seconds apart - each one a full network read. A settled answer is now
  // kept for a few seconds per tab and handed out as a COPY (no caller can change another's rows).
  // It is dropped by ANY write from this tab (coalescedFetch -> memoClear), by a sign-in change and
  // when the user id differs. Display cache only: RLS and the server still decide every read.
  var _memo = new Map();   // var: memoClear() may run (sign-in / write) before this line is reached
  function memoClear() { if (_memo) _memo.clear(); }
  function memoCopy(v) {
    if (v == null || typeof v !== "object") return v;
    try { if (typeof structuredClone === "function") return structuredClone(v); } catch (e) {}
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }
  function memoRead(key, ttl, fn) {
    if (mode !== "supabase" || !currentUser) return Promise.resolve().then(fn);   // local mode writes skip fetch: never cache there
    if (!_memo) _memo = new Map();
    const uid = (currentUser && currentUser.id) || "", now = Date.now(), hit = _memo.get(key);
    if (hit && hit.uid === uid && now - hit.t < ttl) return hit.p.then(memoCopy);
    const p = Promise.resolve().then(fn);
    const ent = { t: now, uid: uid, p: p };
    _memo.set(key, ent);
    p.catch(() => { if (_memo.get(key) === ent) _memo.delete(key); });
    return p.then(memoCopy);
  }
  const MEMO_LIST_MS = 8000;
  // Any non-read method on the object forgets the shared read first, so a list() asked for after a
  // save never gets an answer that started before it.
  const READ_NAME = /^(list|page|get|counts|eventTypes|nextCode|byIds|isArchived|templates|categories|search|find|count|due|codes|lookup)/;
  function dropInflightOnWrite(obj, prefix) {
    Object.keys(obj).forEach((k) => { const fn = obj[k];
      if (typeof fn !== "function" || READ_NAME.test(k)) return;
      obj[k] = function () { Object.keys(_inflight).forEach((x) => { if (x.indexOf(prefix) === 0) delete _inflight[x]; }); memoClear(); return fn.apply(this, arguments); };
    });
  }
  const quotes = {
    list: () => memoRead("quotes.list", MEMO_LIST_MS, () => shareInflight("quotes.list", () => qt().list())),
    // paged list view + counters (perf): see sbq.page / sbq.counts
    PAGE_SIZE,
    VIEWS: QUOTE_VIEWS.slice(),
    isArchived: quoteIsArchived,
    page: (o) => qt().page(o),
    counts: () => qt().counts(),
    // la-fetch (audit 25): the sidebar "sent, waiting for client approval" badge - a HEAD count of open
    // quotes (status quote, approval sent / viewed, not on the Archive / Deleted shelf) instead of the full list
    async countAwaiting() {
      if (mode !== "supabase") return (await lsq.list()).filter((q) => q && q.status === "quote" && !q.archivedAt && !q.deletedAt && (q.approvalStatus === "sent" || q.approvalStatus === "viewed")).length;
      return withShelf((shelf) => { let q = supa.from("quotes").select("id", { count: "exact", head: true }).eq("status", "quote").in("approval_status", ["sent", "viewed"]);
        if (shelf) q = q.is("archived_at", null).is("deleted_at", null); return sbCount(q); });
    },
    eventTypes: () => qt().eventTypes(),
    // the next MMDDYYYY-NN guess for a date, from just that day's codes (not every quote)
    async nextCodeFor(date) {
      const stamp = quoteCodeStamp(date);
      return quotes.nextCode(await qt().codesFor(stamp), date);
    },
    // a few quotes by id, light columns (lookups for a page of something else)
    async byIds(ids) {
      const a = [...new Set((ids || []).filter((x) => typeof x === "string" && x))]; if (!a.length) return [];
      if (mode !== "supabase") { const set = new Set(a); return (await lsq.list()).filter((q) => set.has(q.id)); }
      let r = await supa.from("quotes").select(QUOTE_LIST_COLS).in("id", a);
      if (r.error && isMissingColumn(r.error)) r = await supa.from("quotes").select("*").in("id", a);
      if (r.error) throw r.error; return (r.data || []).map(mapQuoteSummary);
    },
    // confirm-1018 #3: the approval state of a few quotes (lean columns only) — the studio pages poll this while a
    // client approval is pending, so "Client approved" shows without a reload. → [{id, code, status, approvalStatus, updatedAt}]
    async approvalStates(ids) {
      const a = [...new Set((ids || []).filter((x) => typeof x === "string" && x))].slice(0, 100); if (!a.length) return [];
      if (mode !== "supabase") { const set = new Set(a); return (await lsq.list()).filter((q) => set.has(q.id)).map((q) => ({ id: q.id, code: q.code, status: q.status, approvalStatus: q.approvalStatus || "none", updatedAt: q.updatedAt || null })); }
      const { data, error } = await supa.from("quotes").select("id,code,status,approval_status,updated_at").in("id", a);
      if (error) throw error;
      return (data || []).map((q) => ({ id: q.id, code: q.code, status: q.status, approvalStatus: q.approval_status || "none", updatedAt: q.updated_at || null }));
    },
    get: (id) => qt().get(id),
    getVersion: (id, no) => qt().getVersion(id, no),
    versions: (id) => qt().versions(id),
    // 0077: live version lists. cb(kind) whenever a floor-plan version ("layout") or a quotation
    // version ("quotation") of this quote is saved on ANY device (Supabase realtime; row level
    // security keeps it to the caller's studio). Fail-soft: no realtime -> a no-op handle.
    subscribeVersions(id, cb) {
      if (mode !== "supabase" || !supa || typeof supa.channel !== "function" || !/^[0-9a-f-]{36}$/i.test(String(id || ""))) return { unsubscribe() {} };
      try {
        const f = "quote_id=eq." + id;
        const ch = supa.channel("qv-rt-" + id + "-" + Math.random().toString(36).slice(2, 8))
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "quote_versions", filter: f }, () => { try { cb && cb("layout"); } catch (e) {} })
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "quotation_versions", filter: f }, () => { try { cb && cb("quotation"); } catch (e) {} })
          .subscribe();
        return { unsubscribe() { try { supa.removeChannel(ch); } catch (e) {} } };
      } catch (e) { return { unsubscribe() {} }; }
    },
    create: (code, title, eventType, data, objectCount) => qt().create(code, title, eventType, data, objectCount),
    discardEmptyDrafts: () => { const t = qt(); return typeof t.discardEmptyDrafts === "function" ? t.discardEmptyDrafts() : Promise.resolve({ discarded: 0 }); },
    startBlank: (code) => { const t = qt(); return typeof t.startBlank === "function" ? t.startBlank(code) : t.create(code, code, null, { items: [] }, 0); },
    addVersion: (id, label, data, objectCount) => qt().addVersion(id, label, data, objectCount),
    confirm: (id, client, pricing) => qt().confirm(id, client, pricing),
    setStage: (id, stage, overrideReason) => qt().setStage(id, stage, overrideReason),
    // 0198: what blocks moving this event to `stage`, in plain words: [] = free; {hard:true} entries can
    // never be passed (confirmed floor, closed, cancelled); other entries are HL409 gates an admin may
    // override with a reason. null = this database has no 0198 yet (the page then just tries the move).
    async stageBlockers(id, stage) {
      if (mode !== "supabase" || !supa) return [];
      const { data, error } = await supa.rpc("lifecycle_stage_blockers", { p_quote_id: id, p_stage: stage });
      if (error) { const c = error.code || "", m = String(error.message || "");
        if (c === "PGRST202" || c === "42883" || /could not find the function/i.test(m)) return null; throw error; }
      return Array.isArray(data) ? data : [];
    },
    // 0198: an event that will not happen - status 'cancelled' (admin / manager, reason 5-1000 characters,
    // recorded + audited). Payments, reservations and the stage are kept; the client link is revoked.
    async cancelEvent(id, reason) {
      const r = String(reason == null ? "" : reason).trim();
      if (r.length < 5 || r.length > 1000) throw new Error("Give a reason of 5 to 1000 characters for cancelling.");
      if (mode !== "supabase" || !supa) {
        const a = lsq.read(); const q = a.find((x) => x.id === id); if (!q) throw new Error("This event no longer exists.");
        if (q.status !== "cancelled") { q.status = "cancelled"; q.cancelReason = r; q.updatedAt = now(); lsq.write(a); }
        return { status: "cancelled" };
      }
      const { data, error } = await supa.rpc("cancel_event", { p_quote_id: id, p_reason: r });
      if (error) throw error; return data;
    },
    staleApprovals: (ids) => (qt().staleApprovals ? qt().staleApprovals(ids) : Promise.resolve(new Set())),
    reissueApprovalLink: (id) => qt().reissueApprovalLink(id),
    // stage change that explains a refused move and, for an admin, offers an audited override.
    // Resolves {stage} on success, null when the user cancelled; throws other errors.
    async setStageGuided(id, stage) {
      try { return await qt().setStage(id, stage); }
      catch (e) {
        const code = e && e.code;
        if (e && typeof e.message === "string") e.message = demojibake(e.message);
        if (code === "HL428") {
          await window.BPUI.alert(String(e.message || "Price changed after approval — client must approve again."),
            { title: "Client must approve again" });
          return null;
        }
        if (code !== "HL409") throw e;
        let admin = false; try { admin = (await auth.role()) === "admin"; } catch {}
        if (!admin) { await window.BPUI.alert(String(e.message || "This stage can't be set yet.") + " Ask an admin if it must be moved anyway.",
          { title: "Can't move the event yet" }); return null; }
        const reason = await window.BPUI.prompt(String(e.message || "") + "\n\nAs an admin you can move it anyway. The reason is recorded in the audit log.",
          { title: "Override stage check?", label: "Reason (5–1000 characters)", required: true, multiline: true, okLabel: "Move anyway",
            validate: (v) => (String(v || "").trim().length < 5 ? "Give a reason of at least 5 characters." : "") });
        if (!reason) return null;
        return await qt().setStage(id, stage, reason.trim());
      }
    },
    // Display title follows TYPE_LOC_GUESTS_DDMMMYY (event-name.js) and refreshes when type /
    // city / guests / date change — unless the user renamed it. The code is never touched.
    updateMeta: async (id, patch, expectedUpdatedAt) => qt().updateMeta(id, await autoTitlePatch(id, patch), expectedUpdatedAt),
    // 0197: record how an over-capacity quote was resolved (venue / reduce / extend / proceed + note);
    // null clears it. Returns the stored decision. The server checks the shape and the studio.
    async setCapacityDecision(id, decision) {
      if (mode === "supabase") return rpc("set_quote_capacity_decision", { p_quote: id, p_decision: decision == null ? null : decision });
      const a = lsq.read(); const q = a.find((x) => x.id === id); if (!q) throw new Error("not found");
      q.capacityDecision = decision == null ? null : Object.assign({}, decision, { decided_at: now() }); lsq.write(a); return q.capacityDecision;
    },
    remove: (id) => qt().remove(id),
    // next MMDDYYYY-NN given a list of quote summaries (uses .code)
    nextCode(list, date) {
      const stamp = quoteCodeStamp(date);
      const re = new RegExp("^" + stamp + "-(\\d+)"); let max = 0;
      (list || []).forEach((s) => { const m = re.exec(s.code || ""); if (m) max = Math.max(max, parseInt(m[1], 10)); });
      return stamp + "-" + String(max + 1).padStart(2, "0");
    },
  };
  dropInflightOnWrite(quotes, "quotes.list");

  /* ---------------- client approval: OTP + consent + payment ---------------- */
  const rpc = async (fn, args) => {
    if (!supa) throw new Error("Supabase not configured");
    const { data, error } = await supa.rpc(fn, args);
    if (error) { if (looksLikeAuthError(error)) onAuthFailure(); throw error; }
    return data;
  };
  // crew-1020: worker link RPCs take a uuid token; a malformed one gets the same clean
  // "invalid link" as an unknown one instead of the raw Postgres cast error (22P02).
  const WTOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const wrpc = async (fn, args) => {
    const t = args && args.p_token;
    if (typeof t !== "string" || !WTOKEN_RE.test(t.trim())) { const e = new Error("invalid link"); e.code = "P0001"; throw e; }
    try { return await rpc(fn, Object.assign({}, args, { p_token: t.trim() })); }
    catch (e) { if (e && e.code === "22P02") { const x = new Error("invalid link"); x.code = "P0001"; throw x; } throw e; }
  };
  // true only when the RPC itself is not deployed yet (PostgREST PGRST202 / Postgres 42883),
  // so callers can fall back to an older path; every other error must still surface.
  const rpcMissing = (e) => { const c = (e && e.code) || ""; const m = String((e && e.message) || "");
    return c === "PGRST202" || c === "42883" || /could not find the function|function[^]*does not exist/i.test(m); };
  // 0078: fire-and-forget "the client opened the link" (follow-up timing); never throws, never blocks
  const linkOpened = (kind, token) => { try { if (supa && /^[0-9a-f-]{36}$/i.test(String(token || "")))
    Promise.resolve(supa.rpc("public_link_opened", { p_kind: kind, p_token: String(token) })).catch(() => {}); } catch (e) {} };
  // Edge Function caller — used only when live channels are enabled in config.js
  // 0069 booklet share checklist keys (server validates the same list)
  const BOOKLET_SECTIONS = ["studio", "client", "venue", "menu", "layout2d", "layout3d", "quotation", "payments", "terms", "note"];
  const UUID_RE_PKG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /* 0206: "Continue where you left off" - where each person last was in a quote's flow, kept on the server
     (one row per quote per person; quote_flow_progress). mark(): flow.html, debounced, only on a step change
     (mark_ RPC: keeps the cached reads). dismiss(): hide the dashboard button for ME until I work on it again.
     list({scope:'mine'|'studio', limit, offset, quote, maxDays}) -> {total, rows, can_edit, read_only} or null
     when this database has no 0206 / local mode / signed out (flow-resume.js then uses its per-quote
     browser copy). Never throws for a missing function; other errors surface to the caller. */
  const FLOW_STEP_KEYS = ["client", "discovery", "reqs", "venue", "menu", "proposal", "layout", "quote", "pay"];
  const flowProgress = {
    STEPS: FLOW_STEP_KEYS,
    available() { return mode === "supabase" && !!supa && !!currentUser; },
    async mark(quoteId, step) {
      if (!UUID_RE_PKG.test(String(quoteId || "")) || FLOW_STEP_KEYS.indexOf(step) < 0) return { ok: false, invalid: true };
      if (!flowProgress.available()) return { ok: false, local: true };
      try { const r = await rpc("mark_flow_step", { p_quote: String(quoteId), p_step: step }); return r && typeof r === "object" ? r : { ok: true }; }
      catch (e) { if (rpcMissing(e)) return { ok: false, missing: true }; throw e; }
    },
    async dismiss(quoteId) {
      if (!UUID_RE_PKG.test(String(quoteId || ""))) return { ok: false, invalid: true };
      if (!flowProgress.available()) return { ok: false, local: true };
      try { const r = await rpc("mark_flow_resume_dismissed", { p_quote: String(quoteId) }); return r && typeof r === "object" ? r : { ok: true }; }
      catch (e) { if (rpcMissing(e)) return { ok: false, missing: true }; throw e; }
    },
    async list(opts) {
      if (!flowProgress.available()) return null;
      const o = opts || {}, n = (v, lo, hi, d) => { v = Math.floor(Number(v)); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
      const q = o.quote && UUID_RE_PKG.test(String(o.quote)) ? String(o.quote) : null;
      if (o.quote && !q) return { total: 0, rows: [], can_edit: false };
      const args = { p_scope: o.scope === "studio" ? "studio" : "mine", p_limit: n(o.limit, 1, 100, 20), p_offset: n(o.offset, 0, 100000, 0),
        p_quote: q, p_max_days: o.maxDays == null ? null : n(o.maxDays, 1, 3650, 60) };
      try { const d = await rpc("my_unfinished_quotes", args); return d && typeof d === "object" && Array.isArray(d.rows) ? d : null; }
      catch (e) { if (rpcMissing(e)) return null; throw e; }
    },
  };
  // 0083: booklet pictures kept in the database
  const BOOKLET_IMG_KINDS = ["2d", "3d"], BOOKLET_IMG_VARIANTS = ["labels", "plain"], BOOKLET_IMG_MAX = 1536 * 1024;
  const BOOKLET_IMG_MIME = /^image\/(jpeg|png|webp)$/;
  // server answer {mime, data(base64)} -> data: URL (only the three image types, only base64 characters)
  // 0095: stored photo render -> data: URL (<= 6 MB)
  function photoDataUrl(r) {
    if (!r || typeof r !== "object" || !BOOKLET_IMG_MIME.test(String(r.mime || ""))) return null;
    const d = String(r.data || "");
    if (!d || d.length > 8400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d)) return null;
    return "data:" + r.mime + ";base64," + d;
  }
  function bookletDataUrl(r) {
    if (!r || typeof r !== "object" || !BOOKLET_IMG_MIME.test(String(r.mime || ""))) return null;
    const d = String(r.data || "");
    if (!d || d.length > 2100000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d)) return null;
    return "data:" + r.mime + ";base64," + d;
  }
  // blob / canvas -> {mime:"image/jpeg", data(base64), bytes}; downscaled to maxW (1600) wide, JPEG quality q (0.85)
  async function encodeBookletImage(src, maxW, q) {
    maxW = Math.max(200, Math.min(4000, Number(maxW) || 1600)); q = Math.max(0.5, Math.min(0.95, Number(q) || 0.85));
    if (!src || typeof document === "undefined") return null;
    let w, h, draw;
    if (src.getContext) { w = src.width; h = src.height; draw = src; }
    else {
      const url = URL.createObjectURL(src);
      try { draw = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("Couldn't read the picture.")); im.src = url; }); }
      finally { setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 0); }
      w = draw.naturalWidth || draw.width; h = draw.naturalHeight || draw.height;
    }
    if (!(w > 0) || !(h > 0)) return null;
    let s = Math.min(1, maxW / w);
    for (let i = 0; i < 4; i++) {
      const cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
      const cx = cv.getContext("2d"); cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(draw, 0, 0, cv.width, cv.height);
      const b = await new Promise((res) => { try { cv.toBlob((x) => res(x), "image/jpeg", q); } catch (e) { res(null); } });
      if (!b) return null;
      if (b.size <= BOOKLET_IMG_MAX || i === 3) {
        const buf = new Uint8Array(await b.arrayBuffer()); let bin = "";
        for (let j = 0; j < buf.length; j += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(j, j + 0x8000));
        return { mime: "image/jpeg", data: btoa(bin), bytes: buf.length };
      }
      s *= 0.75; q = Math.max(0.6, q - 0.1);
    }
    return null;
  }
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
    getByToken: (token) => rpc("public_get_quote", { p_token: token }).then((r) => { linkOpened("quote", token); return r; }),
    // 0098: paid vs total from the quote_payments ledger (null when the function is not deployed yet)
    paidStatus: (token) => mode === "supabase" ? rpc("public_quote_paid_status", { p_token: token }).catch(() => null) : Promise.resolve(null),
    // simulation → RPC (returns dev OTP); live → MSG91 via Edge Function (sends real SMS, no code returned)
    requestOtp: (token, phone) => LIVE.sms ? callFn("send-otp", { token, phone }) : rpc("request_otp", { p_token: token, p_phone: phone }),
    verifyConsent: (token, phone, code, agreed, termsVersion, consentText, clientName, ua) =>
      rpc("verify_and_consent", { p_token: token, p_phone: phone, p_code: code, p_agreed: agreed,
        p_terms_version: termsVersion, p_consent_text: consentText, p_client_name: clientName, p_user_agent: ua }),
    // simulation → RPC (mock link); live → Razorpay via Edge Function (real payment link)
    // Online pay is offered only when it is real (pay live) or off production: the
    // simulated checkout (/sim-pay) is 404 on prod hosts, so prod never links there.
    onlinePayAvailable: () => !!LIVE.pay || (typeof window === "undefined" || window.HELM_IS_PROD_HOST !== true),
    createPayment: (token) => LIVE.pay ? callFn("create-payment-link", { token })
      : (typeof window !== "undefined" && window.HELM_IS_PROD_HOST === true)
        ? Promise.reject(new Error("Online payment isn't available — your planner will share payment details."))
        : rpc("create_payment", { p_token: token }),
    // ---- 0151: WhatsApp / e-mail approval code (always to the phone / e-mail ON THE QUOTE) ----
    // live (liveChannels.whatsapp) -> send-otp edge function (itself simulated until the Meta /
    // Resend secrets exist); otherwise the simulated RPC (code shown on screen off production).
    requestChannelOtp: (token, channel) => (channel === "email" ? LIVE.email : LIVE.whatsapp) ? callFn("send-otp", { token, channel })
      : rpc("wa_request_otp", { p_token: token, p_channel: channel, p_user_agent: (typeof navigator !== "undefined" ? navigator.userAgent : "").slice(0, 400) }),
    verifyChannel: (token, channel, code, agreed, termsVersion, consentText, clientName, ua) =>
      rpc("wa_verify_and_consent", { p_token: token, p_channel: channel, p_code: code, p_agreed: agreed,
        p_terms_version: termsVersion, p_consent_text: consentText, p_client_name: clientName, p_user_agent: ua }),
    // "Send by email": client-mailer e-mails the approval / booklet link to the client e-mail ON THE
    // QUOTE (server picks the address). Off when liveChannels.email is false.
    emailEnabled: () => LIVE.email !== false,
    emailLink: (quoteId, kind) => LIVE.email === false
      ? Promise.resolve({ status: "not_configured", reason: "e-mail sending is switched off for this site" })
      : callFn("client-mailer", { quote_id: quoteId, kind: kind === "booklet" ? "booklet" : "approval" }),
    // ---- 0151: studio "Send on WhatsApp" (Simulated / Sent / Delivered / Read / Failed) ----
    waSend: (quoteId, kind, phone, optIn, consentText) => LIVE.whatsapp
      ? callFn("wa-proposal", { quote_id: quoteId, kind, phone, opt_in: !!optIn, consent_text: consentText || "" })
      : rpc("wa_proposal_prepare", { p_quote: quoteId, p_kind: kind, p_phone: phone, p_opt_in: !!optIn,
          p_consent_text: optIn ? (consentText || "") : null, p_simulate: true }).then((r) => ({ simulated: true, status: (r && r.status) || "simulated" })),
    waState: (quoteId) => mode === "supabase" ? rpc("wa_proposal_state", { p_quote: quoteId }).catch(() => null) : Promise.resolve(null),
    // ---- manager (authenticated) ----
    // 0128 trial test mode (server-gated: active trial studios only; no SMS / email sent)
    trialTestMode: (token) => mode === "supabase" ? rpc("trial_test_mode_for_token", { p_token: token }).catch(() => false) : Promise.resolve(false),
    trialTestApprove: (token, phone, clientName, termsVersion, consentText, ua) =>
      rpc("trial_test_approve", { p_token: token, p_phone: phone || null, p_client_name: clientName,
        p_terms_version: termsVersion, p_consent_text: consentText, p_user_agent: ua }),
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
      return shareInflight("ops.templates:" + (category || ""), async () => {
        let q = supa.from("task_templates").select("category,title,seq").order("category").order("seq");
        if (category) q = q.eq("category", category);
        const { data, error } = await q; if (error) throw error; return data; }); },
    // add one task to the org's template catalog (seq = end of its section); insert only, never overwrites
    async addTemplate(category, title) { if (!supa) throw new Error("Supabase not configured");
      category = String(category || "").trim().slice(0, 60); title = String(title || "").trim().slice(0, 120);
      if (!category || !title) throw new Error("Section and task title are required");
      const cur = await this.templates(category);
      const seq = cur.reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0) + 1;
      const { data, error } = await supa.from("task_templates").insert({ category, title, seq }).select("category,title,seq").single();
      if (error) throw error; return data; },
    async categories() { const t = await this.templates(); return [...new Set(t.map((x) => x.category))]; },
    async listCrew() { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("crew_members").select("*").eq("active", true).order("name");
      if (error) throw error; return data; },
    async addCrew(name, phone, department) { if (!supa) throw new Error("Supabase not configured");
      phone = phoneOrThrow(phone, true);
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
    // ---- crew (signed in): my own event header + act on my own tasks (0153) ----
    crew: {
      eventBrief: (quoteId) => rpc("crew_event_brief", { p_quote: quoteId }),
      respond: (taskId, action) => rpc("crew_task_respond", { p_task: taskId, p_action: action }),
      // crew schedule calendar (0161): schedule fields only; own rows for crew, any org crew for staff/calendar viewers
      schedule: (from, to, staffId) => (supa ? rpc("crew_schedule", { p_from: from, p_to: to, p_staff: staffId || null }).then((r) => r || []) : Promise.resolve([])),
    },
    // ---- worker (no login; token-scoped) ----
    worker: {
      getTasks: (token) => wrpc("worker_get_tasks", { p_token: token }),
      // 0132 — what changed for me ("Updated" badges) + my run-sheet lines
      updates: (token) => wrpc("worker_assignment_updates", { p_token: token }),
      respond: (token, taskId, action) => wrpc("worker_respond", { p_token: token, p_task_id: taskId, p_action: action }),
      // Phase 52 — crew equipment (kit out to them for this event) + check-in
      getEquipment: (token) => wrpc("worker_get_equipment", { p_token: token }),
      checkinEquipment: (token, id, qtyIn) => wrpc("worker_checkin_equipment", { p_token: token, p_id: id, p_qty_in: qtyIn }),
      // 0038 — upload one evidence file: the link asks the server for a one-time
      // 15-minute grant (checks link + task + status + type, 30/hour), then writes
      // the file to that exact key in the private 'task-proof' bucket. Type comes
      // from the file's bytes, never from its name. Returns the key.
      async uploadEvidence(token, taskId, kind, file) {
        if (!supa) throw new Error("Supabase not configured");
        if (!file) throw new Error("no file");
        if (file.size > TASK_PROOF_MAX) throw new Error("File too large (max 8 MB).");
        let sniff = await sniffChat(file);
        const allowed = kind === "proof_photo" ? /^image\/(jpeg|png|webp)$/ : /^audio\/(webm|ogg|mp4)$/;
        if (!sniff || !allowed.test(sniff.mime)) throw new Error(kind === "proof_photo" ? "Photos must be JPEG, PNG or WebP." : "That voice note format isn't supported.");
        // 0048: proof photos re-encoded (EXIF/GPS stripped — a crew phone's location never
        // leaves the device); voice notes must match their declared type
        if (kind === "proof_photo") {
          const img = await ugPrepareImage(file, { maxBytes: TASK_PROOF_MAX, maxPx: 2048, allow: ["image/png", "image/jpeg", "image/webp"] });
          file = img.blob; sniff = { mime: img.mime, ext: img.ext };
        } else {
          await ugCheckFile(file, ["audio/webm", "audio/ogg", "audio/mp4"], TASK_PROOF_MAX);
        }
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
    // also loads the studio's item rate cards (0086) so pricing.fromItems() prices spec'd items
    // with them; a rate-card failure never blocks the pricing config (defaults apply).
    getPricing: () => Promise.all([mode === "supabase"
      ? swr("pricing", () => rpc("get_pricing_config"))
      : Promise.resolve(Object.assign({}, PRICING_DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem("bp_pricing_cfg") || "{}"); } catch (e) { return {}; } })())),
      config.loadItemRates().catch(() => null)]).then((r) => { try { BPStore.rememberStudioTax && BPStore.rememberStudioTax(r[0]); } catch (e) {} return r[0]; }),
    // 0086 item rate cards: { rates:{type:{...}}, canEdit, custom:[types the studio changed] }.
    // Every reader gets the merged card (studio edits over the shipped defaults).
    _itemRatesP: null,
    itemRates: () => mode === "supabase"
      ? swr("rates", () => rpc("get_item_rate_cards"))
      : Promise.resolve((() => { let o = {}; try { o = JSON.parse(localStorage.getItem("bp_item_rates") || "{}") || {}; } catch (e) {}
          return { rates: Object.assign({}, ITEM_SPEC.DEFAULT_RATES, o), canEdit: true, custom: Object.keys(o) }; })()),
    loadItemRates(force) {
      if (!force && config._itemRatesP) return config._itemRatesP;
      config._itemRatesP = config.itemRates().then((r) => { if (r && r.rates) pricing.setItemRates(r.rates); return r; })
        .catch((e) => { config._itemRatesP = null; throw e; });
      return config._itemRatesP;
    },
    // admin / item_pricing editors only (server re-checks has_area('item_pricing','edit'))
    setItemRate: (type, rates) => {
      if (ITEM_SPEC.TYPES.indexOf(type) < 0) return Promise.reject(new Error("Unknown item type."));
      if (!ITEM_SPEC.ratesOk(rates)) return Promise.reject(new Error("Rates must be numbers between 0 and 1,00,00,000."));
      const done = (r) => { config._itemRatesP = null; return config.loadItemRates(true).then(() => r); };
      if (mode === "supabase") return rpc("set_item_rate_card", { p_type: type, p_rates: rates }).then(done);
      let o = {}; try { o = JSON.parse(localStorage.getItem("bp_item_rates") || "{}") || {}; } catch (e) {}
      o[type] = rates; localStorage.setItem("bp_item_rates", JSON.stringify(o)); return done({ type, rates });
    },
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
    // CATALOG-DEFAULTS (2026-10): newer builder items — see docs/ITEM-PRICING-DEFAULTS.md
    led:18000, lighting:9600, walkway:6000, brandwall:9600, podium:3500, barricade:1800, stagebarrier:9000, fence:1500,
    checkpoint:3000, exit:500, speaker:4000, monitor:1500, movinghead:2500, uplight:500, smoke:5000, dancers:14000,
    chocolatefountain:9000, chariot:20000, booth:8000, desk:2500, gifttable:1500, caketable:1500, heater:2500, easel:500,
    distro:3000, cableramp:600, lounge:6000, sofa:2500, loveseat:2000, armchair:1200, ottoman:500, bench:800,
    coffeetable:800, bleacher:15000, floral:1500, pillar:2000, drape:2400, planter:800,
    entrancegate:25000, phoolchadar:6000, jhoola:12000, haldi:18000, mehendi:15000, selfieframe:3500, welcomeboard:2500,
    fairylights:8000, couplesofa:8000, livecounter:7000, kidszone:15000, aircooler:1500,
    floralentrance:30000, stagebackdrop:35000, flowerwall:12000, toran:4000, floralpillar:4500, aislefloral:1800, centrepiece:2500,
    balloonarch:6000, balloonbunch:800, lectern:4000, dais:30000, flagstand:1500, hoarding:12000, patower:15000, lightingtree:3500,
    diyastand:2500, trophytable:3000,
    havankund:3500, rangoli:2500, lanterns:1200, hangingfloral:18000, neonsign:4000,
    backdrop:6000, floralstand:1500, decorbox:2000, signage:1200, stageroof:60000, varmala:25000, micstand:500, teleprompter:6000, projector:8000, tvstand:4000, interpreter:15000, pyro:3000, towerlight:4000, gaddi:3000, urli:2500, umbrellas:5000, doli:12000, kalash:800, altar:8000, shoerack:1000, dessert:3500, coffee:3000, stall:6000, counter:2500, plinth:1000, kiosk:3000, ticketbooth:5000, stanchion:1200, watchtower:8000, extinguisher:300, ambulance:6000,
  };
  /* ITEM-SPEC-ENGINE:BEGIN (0086 item specifications + spec-based pricing) ---------------
     An item placed on the floor (item.properties.spec) can carry a SPEC — e.g. a stage's
     length x width x height, a generator's kVA and days, a DJ's power connection. When it
     does, its price comes from the studio's RATE CARD for that item type (editable in
     Control Center -> Item pricing, stored per studio in item_rate_cards, 0086). Items
     WITHOUT a spec keep the old flat catalog price, so existing quotes never change.
     A missing / zero-length rate falls back to the catalog price with a "rate not set" note;
     a bad spec (negative, absurd, not a number) falls back the same way ("spec invalid").
     Dimensions are always STORED in metres; spec.unit ("m" default | "ft") is display only.
     Defaults below mirror public._a86_default_rates() (0086) and docs/ITEM-PRICING-DEFAULTS.md. */
  const ITEM_SPEC = (function () {
    const FT = 0.3048;
    const TYPES = ["dj", "generator", "stage", "lighting", "led", "chandelier", "photobooth", "chocolatefountain", "chariot", "smoke", "dancers"];
    const DEFAULT_RATES = {
      dj:        { setup: { console: 15000, speakers2: 25000, speakers4: 40000 }, power: { pin2: 0, pin3: 1500, pin4: 4000 }, perExtraSpeaker: 3000 },
      generator: { base: 2000, perKvaDay: 60, dieselPerKvaDay: 100, operatorPerDay: 1000 },
      stage:     { base: 0, perSqM: 450, stdHeightM: 0.6, heightPerSqMPerM: 150 },
      lighting:  { each: { par: 600, moving_head: 2500, uplighter: 500 }, perM: { fairy: 40, truss_wash: 800 } },
      led:       { perSqMDay: { p39_indoor: 1100, p48_outdoor: 900, p6_outdoor: 650 } },
      chandelier:{ each: { small: 3000, medium: 6000, large: 12000, grand: 25000 } },
      photobooth:{ perHour: { standard: 2500, spin360: 5000, mirror: 4000 }, minHours: 2 },
      chocolatefountain: { base: { small: 6000, medium: 9000, large: 14000 }, perServing: 40 },
      chariot:   { perTrip: { horse: 15000, vintage_car: 12000, flower: 20000 } },
      smoke:     { perUnit: { cold_pyro: 2500, low_fog: 6000, dry_ice: 5000 } },
      dancers:   { perDancerShow: 3500, perDancerHour: 1500 },
    };
    // option labels for the Adjust popup + the Control Center card (keys = rate keys)
    const LABELS = {
      pin2: "2-pin (single phase, small)", pin3: "3-pin (single phase, earthed)", pin4: "4-pin (3-phase)",
      console: "DJ + console", speakers2: "DJ + console + 2 speakers", speakers4: "DJ + console + 4 speakers",
      par: "PAR can", moving_head: "Moving head", uplighter: "Uplighter", fairy: "Fairy / string lights", truss_wash: "Truss wash",
      p39_indoor: "Indoor P3.9", p48_outdoor: "Outdoor P4.8", p6_outdoor: "Outdoor P6",
      small: "Small", medium: "Medium", large: "Large", grand: "Grand crystal",
      standard: "Standard booth", spin360: "360° spin booth", mirror: "Mirror booth",
      horse: "Horse (ghodi)", vintage_car: "Vintage car", flower: "Flower chariot",
      cold_pyro: "Cold pyro", low_fog: "Low fog", dry_ice: "Dry ice",
      show: "per performance", hour: "per hour",
    };
    const KVA_PRESETS = [15, 25, 62.5, 125, 250, 500];
    const MAX = { dim: 200, height: 10, kva: 3000, days: 60, qty: 10000, hours: 72, servings: 20000, rate: 10000000 };
    const fmt = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
    const num = (v) => (typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN));
    const toM = (v, unit) => unit === "ft" ? num(v) * FT : num(v);
    const fromM = (m, unit) => unit === "ft" ? m / FT : m;
    const r2 = (n) => Math.round(n * 100) / 100;
    // a finite number in [lo, hi]; else throws (caller turns it into a "spec invalid" fallback)
    function need(v, lo, hi, what) { const n = num(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(what + " must be between " + lo + " and " + hi); return n; }
    function rate(v) { const n = num(v); return (Number.isFinite(n) && n >= 0 && n <= MAX.rate) ? n : null; }
    function pick(map, key) { if (!map || typeof map !== "object" || !Object.prototype.hasOwnProperty.call(map, key)) return null; return rate(map[key]); }
    const NOT_SET = (what) => { const e = new Error("rate not set: " + what); e.rateNotSet = true; return e; };
    const req = (v, what) => { if (v == null) throw NOT_SET(what); return v; };
    const lbl = (k) => LABELS[k] || k;

    // compute(type, spec, rates) -> { price, label } ; throws on bad spec / missing rate
    function compute(type, spec, rates) {
      spec = spec || {}; rates = rates || {};
      switch (type) {
        case "stage": {
          const L = need(spec.lengthM, 0.5, MAX.dim, "Length"), W = need(spec.widthM, 0.5, MAX.dim, "Width");
          const H = spec.heightM == null || spec.heightM === "" ? 0 : need(spec.heightM, 0, MAX.height, "Height");
          const per = req(rate(rates.perSqM), "stage per m²"), base = rate(rates.base) || 0;
          const area = L * W, std = rate(rates.stdHeightM) || 0, hs = rate(rates.heightPerSqMPerM) || 0;
          const extraH = Math.max(0, H - std), hCost = extraH * area * hs;
          const price = Math.round(base + area * per + hCost);
          const u = spec.unit === "ft" ? "ft" : "m";
          const dims = u === "ft" ? r2(fromM(L, "ft")) + " × " + r2(fromM(W, "ft")) + " ft" : r2(L) + " × " + r2(W) + " m";
          return { price, label: "Stage " + dims + " (" + r2(area) + " m²) @ " + fmt(per) + "/m²" + (base ? " + base " + fmt(base) : "") + (hCost ? " + height " + fmt(hCost) : "") + " = " + fmt(price) };
        }
        case "generator": {
          const kva = need(spec.kva, 1, MAX.kva, "Capacity (kVA)"), days = need(spec.days == null ? 1 : spec.days, 1, MAX.days, "Days");
          const per = req(rate(rates.perKvaDay), "generator per kVA/day"), base = rate(rates.base) || 0;
          let price = base * days + kva * per * days, extra = "";
          if (spec.diesel) { const d = req(rate(rates.dieselPerKvaDay), "diesel per kVA/day"); price += kva * d * days; extra += " + diesel"; }
          if (spec.operator) { const o = req(rate(rates.operatorPerDay), "operator per day"); price += o * days; extra += " + operator"; }
          price = Math.round(price);
          return { price, label: "Generator " + r2(kva) + " kVA × " + days + " day" + (days === 1 ? "" : "s") + extra + " = " + fmt(price) };
        }
        case "dj": {
          const s = req(pick(rates.setup, spec.setup), "DJ setup " + spec.setup), p = req(pick(rates.power, spec.power || "pin3"), "power " + spec.power);
          const xs = spec.extraSpeakers == null ? 0 : need(spec.extraSpeakers, 0, 100, "Extra speakers");
          const xr = xs ? req(rate(rates.perExtraSpeaker), "extra speaker") : 0;
          const price = Math.round(s + p + xs * xr);
          const pin = { pin2: "2-pin", pin3: "3-pin", pin4: "4-pin, 3-phase" }[spec.power || "pin3"] || spec.power;
          return { price, label: "DJ " + lbl(spec.setup).replace(/^DJ \+ /, "") + " (" + pin + ")" + (xs ? " + " + xs + " extra speaker" + (xs === 1 ? "" : "s") : "") + " = " + fmt(price) };
        }
        case "lighting": {
          const qty = need(spec.qty == null ? 1 : spec.qty, 1, MAX.qty, "Quantity");
          const each = pick(rates.each, spec.kind);
          if (each != null) { const price = Math.round(qty * each); return { price, label: "Lighting " + lbl(spec.kind) + " × " + qty + " @ " + fmt(each) + " = " + fmt(price) }; }
          const pm = req(pick(rates.perM, spec.kind), "lighting " + spec.kind);
          const len = need(spec.lengthM, 0.5, 1000, "Length");
          const price = Math.round(qty * len * pm);
          return { price, label: "Lighting " + lbl(spec.kind) + " " + r2(len) + " m × " + qty + " @ " + fmt(pm) + "/m = " + fmt(price) };
        }
        case "led": {
          const W = need(spec.widthM, 0.5, 100, "Width"), H = need(spec.heightM, 0.5, 50, "Height"), days = need(spec.days == null ? 1 : spec.days, 1, MAX.days, "Days");
          const per = req(pick(rates.perSqMDay, spec.pitch), "LED " + spec.pitch);
          const area = W * H, price = Math.round(area * per * days);
          return { price, label: "LED wall " + lbl(spec.pitch) + " " + r2(W) + " × " + r2(H) + " m (" + r2(area) + " m²) @ " + fmt(per) + "/m²" + (days > 1 ? " × " + days + " days" : "") + " = " + fmt(price) };
        }
        case "chandelier": {
          const qty = need(spec.qty == null ? 1 : spec.qty, 1, MAX.qty, "Quantity"), e = req(pick(rates.each, spec.size), "chandelier " + spec.size);
          const price = Math.round(qty * e);
          return { price, label: "Chandelier " + lbl(spec.size) + " × " + qty + " @ " + fmt(e) + " = " + fmt(price) };
        }
        case "photobooth": {
          const h = need(spec.hours, 1, MAX.hours, "Hours"), ph = req(pick(rates.perHour, spec.kind), "photo booth " + spec.kind);
          const billed = Math.max(h, rate(rates.minHours) || 0), price = Math.round(billed * ph);
          return { price, label: "Photo booth " + lbl(spec.kind) + " × " + billed + " h" + (billed > h ? " (minimum)" : "") + " @ " + fmt(ph) + "/h = " + fmt(price) };
        }
        case "chocolatefountain": {
          const sv = need(spec.servings, 0, MAX.servings, "Servings"), b = req(pick(rates.base, spec.size), "fountain " + spec.size);
          const ps = sv ? req(rate(rates.perServing), "per serving") : 0, price = Math.round(b + sv * ps);
          return { price, label: "Chocolate fountain " + lbl(spec.size) + " + " + sv + " servings = " + fmt(price) };
        }
        case "chariot": {
          const t = need(spec.trips == null ? 1 : spec.trips, 1, 50, "Trips"), pt = req(pick(rates.perTrip, spec.kind), "chariot " + spec.kind);
          const price = Math.round(t * pt);
          return { price, label: "Chariot " + lbl(spec.kind) + " × " + t + " trip" + (t === 1 ? "" : "s") + " = " + fmt(price) };
        }
        case "smoke": {
          const u = need(spec.units == null ? 1 : spec.units, 1, 500, "Units"), pu = req(pick(rates.perUnit, spec.kind), "smoke " + spec.kind);
          const price = Math.round(u * pu);
          return { price, label: "Smoke " + lbl(spec.kind) + " × " + u + " @ " + fmt(pu) + " = " + fmt(price) };
        }
        case "dancers": {
          const c = need(spec.count, 1, 500, "Dancers"), q = need(spec.qty == null ? 1 : spec.qty, 1, 100, spec.basis === "hour" ? "Hours" : "Performances");
          const hour = spec.basis === "hour";
          const r = req(rate(hour ? rates.perDancerHour : rates.perDancerShow), hour ? "dancer per hour" : "dancer per performance");
          const price = Math.round(c * q * r);
          return { price, label: "Dancers " + c + " × " + q + (hour ? " h" : " performance" + (q === 1 ? "" : "s")) + " @ " + fmt(r) + " = " + fmt(price) };
        }
        default: throw NOT_SET(type);
      }
    }
    // price(item, cardRates, fallbackUnit) -> { price, label, spec:true|false, note? }
    // fallbackUnit = the existing flat catalog price for this item.
    function price(item, allRates, fallbackUnit) {
      const p = (item && item.properties) || {}, s = p.spec, t = item && item.type;
      if (!s || typeof s !== "object" || TYPES.indexOf(t) < 0) return { price: fallbackUnit, spec: false };
      const rates = (allRates && allRates[t]) || null;
      if (!rates) return { price: fallbackUnit, spec: false, note: "rate not set" };
      try { const r = compute(t, s, rates); return { price: r.price, label: r.label, spec: true }; }
      catch (e) { return { price: fallbackUnit, spec: false, note: e.rateNotSet ? "rate not set" : "spec invalid: " + e.message }; }
    }
    // rate-card sanity (mirrors public._a86_rates_ok): numbers 0..1e7, one level of nesting
    function ratesOk(r) {
      if (!r || typeof r !== "object" || Array.isArray(r)) return false;
      const keys = Object.keys(r); if (!keys.length || keys.length > 40) return false;
      return keys.every((k) => /^[A-Za-z0-9_]{1,40}$/.test(k) && (typeof r[k] === "number" ? rate(r[k]) != null
        : (r[k] && typeof r[k] === "object" && !Array.isArray(r[k]) && Object.keys(r[k]).length >= 1 && Object.keys(r[k]).length <= 40
           && Object.keys(r[k]).every((k2) => /^[A-Za-z0-9_]{1,40}$/.test(k2) && typeof r[k][k2] === "number" && rate(r[k][k2]) != null))));
    }
    // sensible starting spec when an item is first adjusted
    function defaultSpec(type, item) {
      const d = { dj: { setup: "speakers2", power: "pin3", extraSpeakers: 0 }, generator: { kva: 125, days: 1, diesel: false, operator: false },
        lighting: { kind: "par", qty: 8, lengthM: 10 }, led: { pitch: "p39_indoor", widthM: 4, heightM: 2.5, days: 1 },
        chandelier: { size: "medium", qty: 1 }, photobooth: { kind: "standard", hours: 3 }, chocolatefountain: { size: "medium", servings: 100 },
        chariot: { kind: "horse", trips: 1 }, smoke: { kind: "cold_pyro", units: 2 }, dancers: { count: 6, basis: "show", qty: 1 } }[type];
      if (type === "stage") { const w = item && +item.width > 0 ? +item.width * FT : 8, h = item && +item.height > 0 ? +item.height * FT : 5;
        return { lengthM: r2(w), widthM: r2(h), heightM: 0.6, unit: "m" }; }
      return d ? Object.assign({}, d) : null;
    }
    return { TYPES, DEFAULT_RATES, LABELS, KVA_PRESETS, MAX, FT, toM, fromM, compute, price, ratesOk, defaultSpec, label: lbl };
  })();
  /* ITEM-SPEC-ENGINE:END */
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
    // 0086: the studio's item rate cards (Control Center -> Item pricing). Loaded by
    // config.getPricing(); until then the shipped defaults (same as the DB seed) apply.
    ITEM_SPEC, itemRates: null,
    setItemRates(r){ this.itemRates = (r && typeof r === "object") ? r : null; },
    currentItemRates(){ return this.itemRates || ITEM_SPEC.DEFAULT_RATES; },
    // one item's price: spec-based when it has item.properties.spec (0086), else the flat catalog unit
    itemPrice(it, assetPrices, itemRates){
      const unit=this.unitPrice(it, assetPrices);
      return ITEM_SPEC.price(it, itemRates||this.currentItemRates(), unit);
    },
    // chairs + itemised object lines from a layout items array. Items WITHOUT a spec are grouped
    // per type at the flat catalog price exactly as before (old quotes unchanged); each item WITH a
    // spec is its own line priced from the rate card (label e.g. "Stage 8 × 5 m (40 m²) @ ₹450/m² = ₹18,000").
    fromItems(items, assetPrices, itemRates){
      items = items||[]; let chairs=0; const groups={}, specLines=[]; const cards=itemRates||this.currentItemRates();
      items.forEach(it=>{ if(this.isSeat(it)){ chairs+=this.seatCount(it); return; }
        const sp=it.properties&&it.properties.spec;
        if(sp && typeof sp==="object" && ITEM_SPEC.TYPES.indexOf(it.type)>=0){
          const r=this.itemPrice(it, assetPrices, cards);
          if(r.spec){ specLines.push({ type:it.type, qty:1, unit:r.price, cost:r.price, label:r.label, spec:true, id:it.id }); return; }
          const g=(groups[it.type]=groups[it.type]||{qty:0,cat:it.category}); g.qty++; if(r.note) g.note=r.note; return;
        }
        (groups[it.type]=groups[it.type]||{qty:0,cat:it.category}).qty++; });
      const lines=Object.keys(groups).map(t=>{ const g=groups[t], unit=this.unitPrice({type:t,category:g.cat},assetPrices);
        const l={ type:t, qty:g.qty, unit, cost:g.qty*unit }; if(g.note) l.note=g.note; return l; }).filter(l=>l.unit>0)
        .concat(specLines.filter(l=>l.cost>0)).sort((a,b)=>b.cost-a.cost);
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
      // 0079: tax-inclusive prices — the post-discount value already contains the
      // tax, so the total is the taxed value itself and the tax is extracted from
      // it. Mirrors helm_quote_total (server) which prices it as gstPct 0.
      const incl = String(a.taxInclusive).toLowerCase()==="true";
      // 0089: a tax-exempt client (e.g. US resale/nonprofit certificate) is priced at 0%
      // on both sides (helm_quote_total prices taxExempt as gstPct 0).
      const exempt = String(a.taxExempt).toLowerCase()==="true";
      const rate = exempt ? 0 : gstPct;
      const gst = incl ? taxed - taxed/(1+rate/100) : taxed * rate/100;   // D5 single rate
      const total = Math.round(incl ? taxed : taxed + gst);         // D7 round final only
      return { serviceCharge, subtotal, discount, taxed, gst, total, taxInclusive:incl, taxExempt:exempt };
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
        discountFixed:+p.discount||0, discountPct:+p.discountPct||0, coupon:p.coupon, gstPct:+p.gstPct||0, taxInclusive:p.taxInclusive, taxExempt:p.taxExempt });
      // Single-rate GST; CGST/SGST split kept for invoice display (intra-state
      // default; IGST only when place of supply is inter-state).
      const interstate = p.placeOfSupply==="inter";
      return { rental, plateSub, cateringAmt, cateringBucket,
        serviceCharge:c.serviceCharge, subtotal:c.subtotal,
        gstRental:c.gst, gstCatering:0, totalGst:c.gst,
        cgst: interstate?0:c.gst/2, sgst: interstate?0:c.gst/2, igst: interstate?c.gst:0,
        discount:c.discount, total:c.total, taxInclusive:c.taxInclusive, taxExempt:c.taxExempt };
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
        discountPct:+inp.discountPct||0, coupon:inp.coupon, gstPct, taxInclusive:rates.taxInclusive, taxExempt:inp.taxExempt });
      return { chairs, guests, chairPrice, platePrice, chairsCost, cateringCost,
        objectLines:oi.objectLines, objectsCost, layoutBase,
        serviceCharge:Math.round(c.serviceCharge), svcPct,
        subtotal:c.subtotal, discount:c.discount, gstPct, gst:Math.round(c.gst), total:c.total, taxInclusive:c.taxInclusive, taxExempt:c.taxExempt };
    },
  };
  const vendors = {
    async list() { if (!supa) throw new Error("Supabase not configured");
      return sbAll(() => supa.from("vendors").select("*").eq("active", true).order("name").order("id")); },
    async add(name, category, phone) { const { data, error } = await supa.from("vendors").insert({ name, category, phone }).select().single(); if (error) throw dupError(error, "partner", name); return data; },
    async remove(id) { const { error } = await supa.from("vendors").update({ active: false }).eq("id", id); if (error) throw error; return true; },
    // Phase 9 — richer directory (kind / email / services)
    async listAll(includeInactive) { if (!supa) throw new Error("Supabase not configured");
      return sbAll(() => { let q = supa.from("vendors").select("*").order("name").order("id"); if (!includeInactive) q = q.eq("active", true); return q; }); },
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
    async addFull(v) { const { data, error } = await supa.from("vendors").insert(v).select().single(); if (error) throw dupError(error, "partner", v && v.name); return data; },
    async update(id, patch) { const { error } = await supa.from("vendors").update(patch).eq("id", id); if (error) throw dupError(error, "partner", patch && patch.name); return true; },
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
  let leadArchiveHasRestored = null;   // null = unknown, false = DB has no restored_at column yet (pre-0139)
  const leads = {
    async list() {
      if (mode === "supabase") {
        return memoRead("leads.list", MEMO_LIST_MS, () => shareInflight("leads.list", () => sbAll(() => supa.from("leads").select("*").order("updated_at", { ascending: false }).order("id", { ascending: false }))));
      }
      return readLeadsLs();
    },
    // la-fetch (audit 25): the sidebar "new leads not yet contacted" badge - a HEAD count (no rows travel)
    // instead of downloading every lead on every page; same rule as the badge used: status empty or "new"
    async countNew() {
      if (mode === "supabase") return sbCount(supa.from("leads").select("id", { count: "exact", head: true }).or("status.is.null,status.eq.new"));
      return (await readLeadsLs()).filter((l) => l && String(l.status || "new") === "new").length;
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
      if (mode === "supabase") return sbAll(() => supa.from("leads").select("id,name,phone,email").order("id"));
      return readLeadsLs().map((l) => ({ id: l.id, name: l.name, phone: l.phone, email: l.email }));
    },
    // Read the immutable CRM archive (all snapshots, or just one lead's history).
    async archive(leadId) {
      if (mode === "supabase") {
        return sbAll(() => { let q = supa.from("lead_archive").select("*").order("archived_at", { ascending: false }).order("id");
          if (leadId) q = q.eq("lead_id", leadId); return q; });
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
      const COLS0 = "id,lead_id,action,name,phone,email,source,event_type,event_date,budget,guest_count,status,quote_id,archived_at";
      if (mode === "supabase") {
        // restored_at arrives with migration 0139; until it is applied, fall back to the old column list
        const COLS = leadArchiveHasRestored === false ? COLS0 : COLS0 + ",restored_at";
        let q = supa.from("lead_archive").select(COLS);
        if (o.stage) q = q.eq("status", o.stage);
        if (o.source) q = q.ilike("source", likeEscape(String(o.source).trim()));
        const s = orIlike(["name", "phone", "event_type", "source", "action"], o.search); if (s) q = q.or(s);
        let r;
        try { r = await sbPage(q.order("archived_at", { ascending: false }).order("id", { ascending: false }), o); }
        catch (err) {
          if (leadArchiveHasRestored !== false && /restored_at/.test(String((err && err.message) || ""))) { leadArchiveHasRestored = false; return leads.archivePage(o); }
          throw err;
        }
        // B17: the live lead's stage (read-only, best-effort). Converting a lead writes TWO archive rows in one
        // transaction - the quote-sync trigger's "converted" row (stage discovery, from the new quote's
        // lifecycle) and convert_lead_to_quote's own "quoted" update - and both carry the same archived_at.
        // "Latest per lead" breaks that tie on the live stage instead of the random uuid, and every row
        // carries live_status so the CRM shows the lead's CURRENT stage on its latest row.
        const live = {};
        try {
          const lids0 = [...new Set(r.rows.map((x) => x.lead_id).filter(Boolean))];
          if (lids0.length) {
            const { data: lv, error: le } = await supa.from("leads").select("id,status").in("id", lids0);
            if (!le && lv) lv.forEach((x) => { live[x.id] = x.status; });
          }
        } catch (e) {}
        if (o.latest) {
          const ids = [...new Set(r.rows.map((x) => x.lead_id).filter(Boolean))];
          if (ids.length) {
            const { data, error } = await supa.from("lead_archive").select("id,lead_id,archived_at,status").in("lead_id", ids)
              .order("archived_at", { ascending: false }).order("id", { ascending: false });
            if (error) throw error;
            r.rows = r.rows.filter((x) => !x.lead_id || leads._newestArchive(data || [], live)[x.lead_id] === x.id);
          }
        }
        r.rows.forEach((x) => { if (x.lead_id && live[x.lead_id] != null) x.live_status = live[x.lead_id]; });
        // LA-34: flag rows of SAMPLE leads (leads.is_demo, 0097) so the CRM never labels seeded rows "RESTORED".
        // Read-only and best-effort: a failure just leaves the flag off.
        try {
          const lids = [...new Set(r.rows.map((x) => x.lead_id).filter(Boolean))];
          if (lids.length) {
            const { data: dm, error: de } = await supa.from("leads").select("id").in("id", lids).eq("is_demo", true);
            if (!de && dm && dm.length) { const demo = new Set(dm.map((x) => x.id)); r.rows.forEach((x) => { if (demo.has(x.lead_id)) x.is_demo = true; }); }
          }
        } catch (e) {}
        return r;
      }
      let a = []; try { a = JSON.parse(localStorage.getItem(ARCH_LS) || "[]"); } catch {}
      a = a.slice().sort((x, y) => String(y.archived_at || "").localeCompare(String(x.archived_at || "")) || String(y.id).localeCompare(String(x.id)));
      const liveLs = {}; readLeadsLs().forEach((l) => { liveLs[l.id] = l.status; });
      const newest = leads._newestArchive(a, liveLs);
      const src = String(o.source || "").trim().toLowerCase();
      const rows = a.filter((r) => (!o.stage || r.status === o.stage) && (!src || String(r.source || "").trim().toLowerCase() === src) &&
        textHit(o.search, [r.name, r.phone, r.event_type, r.source, r.action]));
      const pg = arrPage(rows, o);
      if (o.latest) pg.rows = pg.rows.filter((x) => !x.lead_id || newest[x.lead_id] === x.id);
      pg.rows = pg.rows.map((x) => { const c = Object.assign({}, x); delete c.snapshot; if (c.lead_id && liveLs[c.lead_id] != null) c.live_status = liveLs[c.lead_id]; return c; });
      return pg;
    },
    // B17: lead_id -> id of its newest archive row. Rows come newest first (archived_at desc, id desc); rows written in
    // the same transaction share archived_at, so among those the one whose stage matches the live lead wins.
    _newestArchive(rows, live) {
      const out = {}, at = {}, hit = {};
      (rows || []).forEach((x) => {
        const k = x.lead_id; if (!k) return;
        if (!(k in out)) { out[k] = x.id; at[k] = String(x.archived_at || ""); hit[k] = live && live[k] != null && x.status === live[k]; return; }
        if (!hit[k] && String(x.archived_at || "") === at[k] && live && live[k] != null && x.status === live[k]) { out[k] = x.id; hit[k] = true; }
      });
      return out;
    },
    // CRM archive: re-create a DELETED lead from its saved snapshot (migration 0139). Server-side
    // checks: same studio, leads edit access, no live lead with that id, not already restored.
    // The archive row is kept and stamped restored; an audit row is written.
    async restoreArchived(archiveId) {
      if (!archiveId) throw new Error("Missing archive record.");
      if (mode === "supabase") {
        const { data, error } = await supa.rpc("restore_archived_lead", { p_archive_id: archiveId });
        if (error) throw error; return data;
      }
      let a = []; try { a = JSON.parse(localStorage.getItem(ARCH_LS) || "[]"); } catch {}
      const rec = a.find((x) => x.id === archiveId);
      if (!rec) throw new Error("Archive record not found.");
      if (rec.action !== "deleted") throw new Error("Only deleted leads can be restored.");
      if (rec.restored_at) throw new Error("This lead was already restored.");
      const live = readLeadsLs();
      if (live.some((x) => x.id === rec.lead_id)) throw new Error("A live lead with this id already exists - nothing was changed.");
      const row = Object.assign({}, rec.snapshot || {}, { id: rec.lead_id, updated_at: now() });
      if (!row.name) row.name = rec.name || "Restored lead";
      if (!row.status) row.status = rec.status || "new";
      live.unshift(row); writeLeadsLs(live);
      rec.restored_at = now(); localStorage.setItem(ARCH_LS, JSON.stringify(a));
      pushArchiveLs("created", row);
      return { result: "restored", lead_id: rec.lead_id };
    },
    // Archived leads view: "deleted" archive rows of THIS studio that were not restored yet,
    // newest first, one row per lead (no snapshot JSON). Needs migration 0139 (restored_at).
    async archivedList() {
      if (mode === "supabase") {
        const org = await orgIdStrict(); if (!org) return [];
        const rows = await sbAll(() => supa.from("lead_archive")
          .select("id,lead_id,name,phone,email,source,event_type,event_date,status,archived_at")
          .eq("org_id", org).eq("action", "deleted").is("restored_at", null)
          .order("archived_at", { ascending: false }).order("id", { ascending: false }));
        const seen = {}; return (rows || []).filter((r) => r.lead_id && !seen[r.lead_id] && (seen[r.lead_id] = true));
      }
      let a = []; try { a = JSON.parse(localStorage.getItem(ARCH_LS) || "[]"); } catch {}
      const live = new Set(readLeadsLs().map((x) => x.id)); const seen = {};
      return a.filter((x) => x.action === "deleted" && !x.restored_at && x.lead_id && !live.has(x.lead_id))
        .sort((x, y) => String(y.archived_at || "").localeCompare(String(x.archived_at || "")))
        .filter((x) => !seen[x.lead_id] && (seen[x.lead_id] = true))
        .map((x) => { const c = Object.assign({}, x); delete c.snapshot; return c; });
    },
    // Archive a lead: same data path as before (lead row removed, the "deleted" archive row kept),
    // then returns that archive row's id so the caller can offer Undo via restoreArchived().
    async archiveLead(id) {
      await leads.remove(id);
      try { const r = (await leads.archivedList()).find((x) => x.lead_id === id); return r ? r.id : null; }
      catch (e) { return null; }
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
  dropInflightOnWrite(leads, "leads.list");
  dropInflightOnWrite(ops, "ops.templates:");

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
      n = { ...n, phone: phoneOrThrow(n && n.phone, false) };
      if (mode === "supabase") { const { data, error } = await supa.from("nurture").insert(n).select().single(); if (error) throw error; return data; }
      const a = readLs(NURTURE_LS); const row = { id: uid(), status: "active", ...n, created_at: now() }; a.push(row); localStorage.setItem(NURTURE_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, "phone")) patch = { ...patch, phone: phoneOrThrow(patch.phone, false) };
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
        // la-fetch (security gap): scoped to THIS studio's row (key is org_id + occasion_type); RLS "ra upd" also checks org + nurture edit
        if (mode === "supabase") { const org = await orgIdStrict(); if (!org) throw new Error("No studio is linked to this account.");
          const { error } = await supa.from("nurture_templates").update({ ...patch, updated_at: now() }).eq("org_id", org).eq("occasion_type", type); if (error) throw error; return true; }
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
      if (!row.share_token && published) row.share_token = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : uid();  // AUD-1017: never a guessable token
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
  // 0106 helpers: free text → access-matrix role key when the match is obvious, else null
  const STAFF_DEPT_LS = "bp_staff_departments";
  let staffDeptMissing = false;
  const STAFF_ROLE_WORDS = [["admin", /\b(admin|administrator|owner|director)\b/], ["manager", /\b(event manager|manager)\b/],
    ["coordinator", /\bco-?ordinator\b/], ["planner", /\bplanner\b/], ["sales", /\bsales\b/], ["supervisor", /\bsupervisor\b/],
    ["quality", /\bquality\b|\bqa\b/], ["operations", /\boperations?\b|\bops\b/], ["designer", /\bdesigner\b/],
    ["crew", /\bcrew\b|\bworkers?\b/]];
  function staffMatchRole(text) {
    const t = String(text == null ? "" : text).trim().toLowerCase().replace(/\s+/g, " ");
    if (!t) return null;
    for (const r of PICK_ROLES) if (r !== "client" && (t === r || t === roleLabel(r).toLowerCase())) return r;
    const hits = STAFF_ROLE_WORDS.filter(([, re]) => re.test(t)).map(([r]) => r);
    return hits.length === 1 ? hits[0] : null;   // ambiguous ("sales manager") → keep as custom
  }
  function staffMergeDepts(list, defaults) {
    const seen = new Set(), out = [];
    for (const d of [].concat(list || [], (list && list.length) ? [] : defaults || [])) {
      const v = String(d == null ? "" : d).trim(); if (!v || seen.has(v.toLowerCase())) continue; seen.add(v.toLowerCase()); out.push(v);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }
  // r20 coord (d), owner decision: pay on a staff row LINKED to a team login (profile_id) is the
  // studio admin's business only. Everyone else - including that person on their own record -
  // never sees the day rate or a pay-like custom field of a linked row. Plain crew (no login) as before.
  function staffPayVisible(s, isAdmin) { return isAdmin === true || !(s && s.profile_id); }
  // a custom field that is pay (monthly salary, wage, CTC, ...): hidden with the day rate
  function staffPayAttr(key, label) {
    const re = /(salary|wage|ctc|stipend|remuneration|compensation|payout|day_?rate|daily_?rate|per_?day|(^|[^a-z])pay([^a-z]|$))/i;
    return re.test(String(key == null ? "" : key)) || re.test(String(label == null ? "" : label));
  }
  // the day_rate part of a Staff-page save. ZERO DATA LOSS: a hidden field, or an admin leaving a
  // linked member's (optional) rate empty, sends NO day_rate key at all - the stored value stays.
  // Plain crew keep today's behaviour (an emptied box clears their rate). value: number | null.
  function staffPayPatch(s, isAdmin, value) {
    if (!staffPayVisible(s, isAdmin)) return {};
    const v = value === undefined || value === "" ? null : value;
    if (s && s.profile_id && v == null) return {};
    return { day_rate: v };
  }
  const staff = {
    payVisible: staffPayVisible,
    payAttr: staffPayAttr,
    payPatch: staffPayPatch,
    async list(includeInactive) {
      if (mode === "supabase") {
        return sbAll(() => { let q = supa.from("crew_members").select("*").order("name").order("id");
          if (!includeInactive) q = q.eq("active", true); return q; });
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
      if (s && !s.profile_id) s = { ...s, phone: phoneOrThrow(s.phone, true) };
      if (mode === "supabase") {
        const { data, error } = await supa.from("crew_members").insert(s).select().single();
        if (error) throw error; return data;
      }
      const a = readLs(STAFF_LS); const row = { id: uid(), active: true, skills: [], ...s, created_at: now() };
      a.push(row); localStorage.setItem(STAFF_LS, JSON.stringify(a)); return row;
    },
    async update(id, patch) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, "phone")) patch = { ...patch, phone: phoneOrThrow(patch.phone, true) };
      if (mode === "supabase") { const { error } = await supa.from("crew_members").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(STAFF_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(STAFF_LS, JSON.stringify(a)); } return true;
    },
    async setActive(id, active) { return this.update(id, { active: !!active }); },
    // 0041: a row with profile_id is LINKED to a Helm account — its name / phone / e-mail /
    // department / title follow the member's profile (edited in Control Center → User control).
    isLinked: (s) => !!(s && s.profile_id),
    normPhone: memberNormPhone,
    phoneE164: memberPhoneE164,
    // r7: an existing row whose stored phone fails today's rule (shown as "Invalid phone — please fix")
    // demo/sample rows (trial seed: is_demo or "Demo · …" name) carry placeholder numbers on purpose: no red warning
    isDemo: (s) => !!(s && (s.is_demo === true || /^Demo \u00b7 /.test(String(s.name || "")))),
    phoneInvalid: (s) => !!(s && s.phone && !(s.is_demo === true || /^Demo \u00b7 /.test(String(s.name || ""))) && !memberPhoneE164(s.phone).ok),
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
    // ---- 0106: role / department drop-downs + login (invite) status ----------------------
    // Roles = the studio's access-matrix roles (never "client" for staff). Stored on the staff
    // row as the friendly label ("Event manager"); free text that isn't an obvious match stays
    // as-is and is shown as "Custom: …" until an admin picks a role (zero data loss).
    staffRoles: () => PICK_ROLES.filter((r) => r !== "client").map((r) => ({ key: r, label: roleLabel(r) })),
    matchRole: staffMatchRole,
    roleLabel,
    DEFAULT_DEPARTMENTS: ["Management", "Planning", "Sales", "Operations", "Production", "Design", "Quality", "Crew"],
    // the studio list + departments already used (0106). Before 0106 / offline → used + defaults.
    async departments() {
      const used = [];
      try { const f = await this.facets(true); used.push(...f.depts); } catch (e) {}
      let list = [];
      if (mode === "supabase" && supa && !staffDeptMissing) {
        const { data, error } = await supa.rpc("staff_departments");
        if (!error) list = Array.isArray(data) ? data : [];
        else if (rpcMissing(error)) staffDeptMissing = true; else throw error;
      } else if (mode !== "supabase") { list = readLs(STAFF_DEPT_LS); }
      return staffMergeDepts(list.length || used.length ? list.concat(used) : list, this.DEFAULT_DEPARTMENTS);
    },
    // add a department to the studio list (Staff EDIT, server-checked) → the new list
    async addDepartment(name) {
      const n = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
      if (!n || n.length > 60 || /[<>\u0000-\u001f]/.test(n)) { const e = new Error("Department names are 1-60 characters (no < or >)."); e.code = "22023"; throw e; }
      if (mode === "supabase") {
        const { data, error } = await supa.rpc("staff_department_add", { p_name: n });
        if (error) throw error; return staffMergeDepts(data || [], this.DEFAULT_DEPARTMENTS);
      }
      const a = readLs(STAFF_DEPT_LS); if (!a.some((x) => String(x).toLowerCase() === n.toLowerCase())) a.push(n);
      localStorage.setItem(STAFF_DEPT_LS, JSON.stringify(a)); return staffMergeDepts(a, this.DEFAULT_DEPARTMENTS);
    },
    // admin: change the LOGIN role of a staff member linked to a Helm account (0106 wraps admin_set_role)
    async setLoginRole(staffId, role) {
      if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.rpc("staff_set_login_role", { p_staff: staffId, p_role: role });
      if (error) throw error; accessCache = null; return data;
    },
    // "active" (linked account) | "invited" (pending, unexpired invite for their e-mail) | "none"
    loginStatus(s, invites) {
      if (s && s.profile_id) return "active";
      const em = String((s && s.email) || "").trim().toLowerCase(); if (!em) return "none";
      const now = Date.now();
      return (invites || []).some((i) => i && i.status === "pending" && String(i.email || "").toLowerCase() === em &&
        (!i.expires_at || new Date(i.expires_at).getTime() > now)) ? "invited" : "none";
    },
    inviteLink: (token) => location.origin + "/login?invite=" + encodeURIComponent(token),
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
  let _reserveRpc = null;   // null = untried, true = RPC works, false = not deployed (use the client-side path)
  const inventory = {
    async items(includeInactive) {
      if (mode === "supabase") {
        return sbAll(() => { let q = supa.from("inventory_items").select("*").order("name").order("id");
          if (!includeInactive) q = q.eq("active", true); return q; });
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
      if (mode === "supabase") { const { data, error } = await supa.from("inventory_items").insert(it).select().single(); if (error) throw dupError(error, "item", it.name); return data; }
      const a = readLs(INV_LS); const row = { id: uid(), active: true, total_qty: 0, ...it, created_at: now() }; a.push(row); localStorage.setItem(INV_LS, JSON.stringify(a)); return row;
    },
    // Bulk insert (one round-trip) — used by "Load starter items" so seeding ~20 rows
    // is instant instead of 20 sequential requests. Returns the inserted rows.
    // o.skipDuplicates: a name clash (23505) must not fail the whole batch — retry row by row
    // and return the rows that went in, with .skipped = [{ name, error }] for the rest.
    async addItems(list, o) {
      const rows = (list || []).map((it) => this._sanitize(it));
      if (!rows.length) return [];
      if (mode === "supabase") {
        const { data, error } = await supa.from("inventory_items").insert(rows).select();
        if (!error) return data;
        if (!(o && o.skipDuplicates) || error.code !== "23505") throw dupError(error, "item", rows.length === 1 ? rows[0].name : null);
        const made = []; made.skipped = [];
        for (const r of rows) {
          const x = await supa.from("inventory_items").insert(r).select().single();
          if (x.error) { if (x.error.code !== "23505") throw x.error; made.skipped.push({ name: r.name, error: dupError(x.error, "item", r.name).message }); }
          else made.push(x.data);
        }
        return made;
      }
      const a = readLs(INV_LS); const made = rows.map((it) => ({ id: uid(), active: true, total_qty: 0, ...it, created_at: now() })); a.push(...made); localStorage.setItem(INV_LS, JSON.stringify(a)); return made;
    },
    async updateItem(id, patch) {
      patch = this._sanitize(patch);
      if (mode === "supabase") { const { error } = await supa.from("inventory_items").update(patch).eq("id", id); if (error) throw dupError(error, "item", patch.name); return true; }
      const a = readLs(INV_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(INV_LS, JSON.stringify(a)); } return true;
    },
    // all active reservations (for availability math), or one event's reservations
    async reservations(quoteId) {
      if (mode === "supabase") {
        return sbAll(() => { let q = supa.from("inventory_reservations").select("*").order("created_at").order("id");
          if (quoteId) q = q.eq("quote_id", quoteId); return q; });
      }
      const a = readLs(RES_LS); return quoteId ? a.filter((r) => r.quote_id === quoteId) : a;
    },
    async reserve(itemId, quoteId, qty, note, opts) {
      const allowOver = !!(opts && opts.allowOver);   // the user confirmed 'Reserve anyway': a deliberate over-commit is allowed (it shows as a calendar conflict)
      if (mode === "supabase") {
        // Preferred path: the atomic reserve_inventory RPC (0070) locks the item row and checks stock
        // in one transaction. If the function isn't deployed yet (PGRST202 / 42883) fall through to the
        // client-side re-check + plain insert below, exactly as before.
        if (_reserveRpc !== false && !allowOver) {
          const { data, error } = await supa.rpc("reserve_inventory", { p_item: itemId, p_quote: quoteId, p_qty: qty, p_note: note || null });
          if (!error) { _reserveRpc = true; return data; }
          const missing = error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message || "");
          if (!missing) {
            if (error.code === "P0001" && /not enough stock/i.test(error.message || "")) {
              const lm = /\((\d+(?:\.\d+)?) left\)/.exec(String(error.message || ""));   // server says "not enough stock free (N left)"
              const err = new Error("Not enough stock free" + (lm ? ": only " + lm[1] + " left" : "") + ". Someone else may have just reserved it.");
              err.code = "INVENTORY_CONFLICT"; throw err;
            }
            throw error;
          }
          _reserveRpc = false;   // not deployed: stop trying for this page load
        }
        // Race guard: re-read fresh demand right before the insert so two people who both
        // saw "3 left" can't both take them. Not atomic (see 0070 reserve_inventory RPC);
        // a failed READ here never blocks the save, the database stays the final authority.
        let d = null; if (!allowOver) { try { d = await this._demand([quoteId]); } catch (e) { d = null; } }
        if (d && !allowOver) {
          const it = d.items.find((i) => i.id === itemId), total = it ? Number(it.total_qty || 0) : null;
          if (total != null && Number(qty) > 0) {
            const qd = d.meta[quoteId] && d.meta[quoteId].date;
            const have = qd ? ((d.dayTotals[itemId] || {})[qd] || 0) + (d.undated[itemId] || 0)
                            : d.peakOf(d.dayTotals[itemId] || {}) + (d.undated[itemId] || 0);
            if (have + Number(qty) > total) {
              const err = new Error("Not enough " + (it.name || "stock") + " free: only " + Math.max(0, total - have) + " left. Someone else may have just reserved it.");
              err.code = "INVENTORY_CONFLICT"; throw err;
            }
          }
        }
        const { data, error } = await supa.from("inventory_reservations").insert({ item_id: itemId, quote_id: quoteId, qty, note: note || null }).select().single(); if (error) throw error; return data;
      }
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
    // 0197: asked for more than is free -> reserve ONLY what is free and record the rest as a
    // shortage (o.source "vendor" = rent from o.vendorId at o.rate per unit -> also a vendor booking
    // on the event; "buy" = outsource / buy; "none" = unsourced). One transaction server-side, so
    // available stock never goes below 0. -> { reserved, short, available, reservation_id, request_id, booking_id }
    async reserveWithSourcing(itemId, quoteId, qty, note, o) {
      o = o || {};
      const source = ["vendor", "buy", "none"].indexOf(o.source) >= 0 ? o.source : "none";
      const rate = o.rate === "" || o.rate == null ? null : Number(o.rate);
      if (mode === "supabase") {
        try {
          return await rpc("reserve_inventory_with_sourcing", { p_item: itemId, p_quote: quoteId, p_qty: Number(qty), p_note: note || null,
            p_source: source, p_vendor: source === "vendor" ? (o.vendorId || null) : null, p_rate: rate, p_source_note: o.sourceNote || null });
        } catch (e) { if (!rpcMissing(e)) throw e; }
      }
      // database without 0197 (or local mode): same steps one by one - reserve what is free, then record the rest
      const av = await this.availability(quoteId); const a = av[itemId] || {};
      const free = Math.max(0, Math.floor(Number(a.availableOnEvent != null ? a.availableOnEvent : (a.available != null ? a.available : 0)) || 0));
      const take = Math.min(Number(qty), free), short = Number(qty) - take;
      const out = { reserved: take, short, available: free };
      if (take > 0) { const r = await this.reserve(itemId, quoteId, take, note || null); out.reservation_id = r && r.id; }
      if (short > 0) {
        const nm = a.name || "item";
        if (source === "vendor" && o.vendorId) {
          const bk = await bookings.add(quoteId, { vendor_id: o.vendorId, label: (nm + " - rent " + short + " (stock shortfall)").slice(0, 500), qty: short,
            cost: rate == null ? null : Math.round(short * rate * 100) / 100, status: "enquiry", note: ("Rent " + short + " " + nm + " (stock shortfall)" + (o.sourceNote ? ". " + o.sourceNote : "")).slice(0, 2000) });
          out.booking_id = bk && bk.id;
        }
        const lead = source === "vendor" ? "Sourcing from " + (o.vendorName || "vendor") : source === "buy" ? "Outsource / buy" : "Unsourced";
        const rq = await stockreq.add(quoteId, { item_id: itemId, label: ("Short: " + short + " x " + nm).slice(0, 200), qty: short,
          note: (lead + (o.sourceNote ? " - " + o.sourceNote : "")).slice(0, 1000),
          ...(mode !== "supabase" ? { source, vendor_id: source === "vendor" ? (o.vendorId || null) : null, booking_id: out.booking_id || null } : {}) });
        out.request_id = rq && rq.id; out.source = source;
      }
      return out;
    },
    // 0197: open shortages (stock requests raised by "Reserve for this event") for one event, or all
    // events when no quoteId. [] on a database without 0197.
    async shortages(quoteId) {
      if (mode === "supabase") {
        let q = supa.from("event_stock_requests").select("id,quote_id,item_id,label,qty,status,note,source,vendor_id,booking_id,created_at")
          .not("source", "is", null).eq("status", "requested").order("created_at");
        if (quoteId) q = q.eq("quote_id", quoteId);
        const { data, error } = await q;
        if (error) { if (isMissingColumn(error)) return []; throw error; }
        return data || [];
      }
      return readLs(STOCKREQ_LS).filter((r) => r.source && r.status === "requested" && (!quoteId || r.quote_id === quoteId));
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
    // Event rows (date + whether still live) for just the quotes the reservations/checkouts
    // point at, not the capped quotes.list(). Archived / deleted / cancelled / closed events
    // are "inactive": their reserved stock is free again.
    async _quoteMeta(ids) {
      const meta = {}; ids = [...new Set((ids || []).filter(Boolean))];
      const put = (q) => { meta[q.id] = { date: q.eventDate || q.event_date || null,
        active: !(q.deletedAt || q.deleted_at || q.archivedAt || q.archived_at || q.status === "cancelled" ||
                  ((q.lifecycleStage || q.lifecycle_stage) === "closed" && q.status === "confirmed")) }; };
      if (mode !== "supabase") { (await quotes.list().catch(() => [])).forEach(put); return meta; }
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        let r = await supa.from("quotes").select("id,event_date,status,lifecycle_stage,archived_at,deleted_at").in("id", chunk);
        if (r.error && isMissingColumn(r.error)) r = await supa.from("quotes").select("id,event_date,status,lifecycle_stage").in("id", chunk);
        if (r.error) throw r.error;
        (r.data || []).forEach(put);
      }
      return meta;
    },
    // Demand per item: by event date, plus undated. Counts live reservations AND open
    // check-outs (out/partial, still-out qty). A checkout against an event that also
    // holds a reservation for the same item is the same physical stock, so per
    // (item, event) the larger of the two counts, not the sum.
    async _demand(extraQuoteIds) {
      const [items, res, cos] = await Promise.all([
        this.items(false), this.reservations(), this.checkouts.list().catch(() => []),
      ]);
      const stillOut = (c) => Math.max(Number(c.qty_out || 0) - Number(c.qty_in || 0), 0);
      const openCo = (cos || []).filter((c) => (c.status === "out" || c.status === "partial") && stillOut(c) > 0);
      const liveRes = (res || []).filter((r) => ACTIVE_RES.includes(r.status));
      const meta = await this._quoteMeta([].concat(liveRes.map((r) => r.quote_id), openCo.map((c) => c.quote_id), extraQuoteIds || []));
      const per = {};   // item|quote -> { res, out }
      const slot = (it, q) => { const k = it + "|" + (q || ""); return per[k] || (per[k] = { it, q: q || null, res: 0, out: 0 }); };
      liveRes.forEach((r) => { slot(r.item_id, r.quote_id).res += Number(r.qty || 0); });
      openCo.forEach((c) => { slot(c.item_id, c.quote_id).out += stillOut(c); });
      const dayTotals = {}, undated = {};
      Object.values(per).forEach((x) => {
        const m = x.q ? meta[x.q] : null;
        const shelved = !!(m && !m.active);
        if (shelved && !x.out) return;                       // reservation on a shelved/cancelled event: stock is free
        const q = shelved ? x.out : Math.max(x.res, x.out);  // stock physically still out stays committed
        const d = m && m.active ? m.date : null;
        if (d) { (dayTotals[x.it] = dayTotals[x.it] || {}); dayTotals[x.it][d] = (dayTotals[x.it][d] || 0) + q; }
        else undated[x.it] = (undated[x.it] || 0) + q;
      });
      const peakOf = (m) => { let mx = 0; for (const k in m) if (m[k] > mx) mx = m[k]; return mx; };
      return { items, meta, dayTotals, undated, peakOf };
    },
    // committed & available per item id, DATE-AWARE.
    // An item used on two different dates isn't gone twice: it comes back between
    // events. So "committed" is the PEAK concurrent demand on any single event
    // date (the busiest day), plus anything on events with no date yet or checked
    // out with no event (those could land on any day, so counted on top, conservatively).
    // Shelved (archived/deleted/cancelled/closed) events release their reservations;
    // stock physically checked out stays committed until it is checked back in.
    // QA-FR2: optional quoteId adds availableOnEvent = what's free on THAT event's date
    // (other events' same-day demand + undated), so reserving for a December event isn't
    // flagged as an over-commit because of a November event. `available` is unchanged.
    async availability(quoteId) {
      const d = await this._demand(quoteId ? [quoteId] : undefined);
      const qd = quoteId && d.meta[quoteId] && d.meta[quoteId].date;
      const map = {};
      d.items.forEach((i) => {
        const c = d.peakOf(d.dayTotals[i.id] || {}) + (d.undated[i.id] || 0);
        const row = { ...i, committed: c, available: Number(i.total_qty || 0) - c };
        if (qd) row.availableOnEvent = Number(i.total_qty || 0) - (((d.dayTotals[i.id] || {})[qd] || 0) + (d.undated[i.id] || 0));
        map[i.id] = row;
      });
      return map;
    },
    // ---- Phase 33: check-out / check-in accountability ----
    checkouts: {
      // all checkouts, or just one event's; newest first
      async list(quoteId) {
        if (mode !== "supabase") return readLs("bp_checkouts").filter((c) => !quoteId || c.quote_id === quoteId);
        return sbAll(() => { let q = supa.from("inventory_checkouts").select("*").order("checked_out_at", { ascending: false }).order("id");
          if (quoteId) q = q.eq("quote_id", quoteId); return q; });
      },
      // issue equipment out
      async out(itemId, quoteId, qty, issuedTo, crewId, note) {
        if (mode !== "supabase") throw new Error("Check-out needs Supabase");
        const { data, error } = await supa.rpc("checkout_equipment",
          { p_item: itemId, p_quote: quoteId || null, p_qty: Number(qty), p_issued_to: issuedTo, p_issued_to_id: crewId || null, p_note: note || null });
        if (error) throw error; return data;
      },
      // 0105: availability for a check-out on this event's date (open check-outs on any event +
      // other events' same-day reservations), who holds the rest, due-back dates, substitutes.
      // null when the RPC isn't deployed (older DB) - the page then computes it client-side.
      async availability(itemId, quoteId) {
        if (mode !== "supabase") return null;
        const { data, error } = await supa.rpc("checkout_availability", { p_item: itemId, p_quote: quoteId || null });
        if (error) { if (rpcMissing(error)) return null; throw error; }
        return data;
      },
      // 0105: server-enforced check-out. A shortage is an ANSWER, not an error:
      //   {ok:true, checkout_id, qty_out, partial, shortfall} | {ok:false, code:"shortage", requested, available, blocking, ...}
      // partial=true checks out only what is free and records the shortfall. Falls back to the
      // 0073 checkout_equipment when the RPC is missing (that one still refuses an over-issue).
      async outSmart(itemId, quoteId, qty, issuedTo, crewId, note, partial) {
        if (mode !== "supabase") throw new Error("Check-out needs Supabase");
        const { data, error } = await supa.rpc("checkout_equipment_smart",
          { p_item: itemId, p_quote: quoteId || null, p_qty: Number(qty), p_issued_to: issuedTo, p_issued_to_id: crewId || null, p_note: note || null, p_partial: !!partial });
        if (!error) return data;
        if (!rpcMissing(error)) throw error;
        const row = await this.out(itemId, quoteId, qty, issuedTo, crewId, note);
        return { ok: true, checkout_id: row && row.id, qty_out: Number(qty), partial: false, shortfall: 0, legacy: true };
      },
      // bring it back: returned count + who signed off; writeoff reduces stock by the missing amount
      async in(id, qtyIn, returnedBy, writeoff) {
        if (mode !== "supabase") throw new Error("Check-in needs Supabase");
        const { data, error } = await supa.rpc("checkin_equipment",
          { p_id: id, p_qty_in: Number(qtyIn), p_returned_by: returnedBy || null, p_writeoff: !!writeoff });
        if (error) throw error; return data;
      },
      // Owner decision #4: a check-out record is never hard-deleted. A mistaken one (nothing
      // returned yet) is CANCELLED server-side (0073 cancel_checkout): kept for audit, no longer
      // counted as out. remove() stays as an alias so old callers cancel instead of deleting.
      async cancel(id, reason) {
        if (mode !== "supabase") { const a = readLs("bp_checkouts"); const r = a.find((c) => c.id === id);
          if (r) { r.status = "cancelled"; r.cancelled_at = now(); localStorage.setItem("bp_checkouts", JSON.stringify(a)); } return r || null; }
        const { data, error } = await supa.rpc("cancel_checkout", { p_id: id, p_reason: reason || null });
        if (error) throw error; return data;
      },
      remove(id) { return this.cancel(id); },
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
      return sbAll(() => { let q = supa.from("dish_catalog").select("*").order("category").order("name").order("id");
        if (!includeInactive) q = q.eq("active", true); return q; });
    },
    async add(category, name, kind) {
      if (mode !== "supabase") { const a = readLs("bp_dish_catalog"); const r = { id: uid(), category, name, kind: kind || "veg", active: true }; a.push(r); localStorage.setItem("bp_dish_catalog", JSON.stringify(a)); return r; }
      const { data, error } = await supa.from("dish_catalog").insert({ category, name, kind: kind || "veg" }).select().single(); if (error) throw dupError(error, "dish", name); return data;
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
      if (mode !== "supabase") { const a = readLs("bp_menu_templates"); const r = a.find((x) => x.id === id); if (r) Object.assign(r, patch); localStorage.setItem("bp_menu_templates", JSON.stringify(a)); return r || true; }
      // 0192: return the stored row (the card then shows exactly what was saved). No row back = nothing
      // was saved (removed, or no access under RLS) - never report that as "saved".
      const { data, error } = await supa.from("menu_templates").update(patch).eq("id", id).select("*"); if (error) throw error;
      if (!data || !data.length) throw new Error("This package was not saved. It may have been removed, or you may not have access to edit it. Reload the page and try again.");
      return data[0];
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
    // r19 (0211): "No package / decide later" - the plan forgets the applied package + its plate price (the quote is
    // priced at the default plate price again). The event's dishes are kept. Menu locked / not allowed -> refused.
    async clear(quoteId) {
      if (mode !== "supabase") {
        const a = readLs("bp_plan"), row = a.find((x) => x.quote_id === quoteId);
        if (row && row.menu_locked) throw new Error("The menu is locked. Unlock it to change the package.");
        if (row) { row.package = null; row.menu_template = null; row.menu_plate_price = null; localStorage.setItem("bp_plan", JSON.stringify(a)); }
        return { cleared: !!row };
      }
      try { return await rpc("clear_menu_template", { p_quote: quoteId }); }
      catch (e) {
        if (e && (e.code === "PGRST202" || e.code === "42883")) throw new Error("Removing a package needs the latest Helm update. Pick another package for now.");
        throw e;
      }
    },
  };

  /* ---------------- organization / studio (Phase 58) ---------------- */
  const org = {
    async id() { if (!supa) return null; try { return await orgIdStrict(); } catch (e) { return null; } },
    // Like id() but THROWS when the lookup fails, so callers can tell "no studio"
    // (null) from "couldn't check" (error) — onboarding must only follow a real null.
    resolveId: () => orgIdStrict(),
    // opts.fresh: read the saved row from the server (an edit form must never start from the tab cache)
    async current(opts) { if (!supa) return null;
      const oid = await this.id();
      const read = async () => { const { data, error } = await supa.from("organizations").select("*").eq("id", oid).maybeSingle();
        if (error) throw error; try { if (data && data.timezone && BPStore.rememberStudioTimezone) BPStore.rememberStudioTimezone(data.timezone); } catch (e) {}
        studioEmit(data); return data; };
      if (opts && opts.fresh) { try { sessionStorage.removeItem(SWR_PREFIX + "org:" + oid); } catch (e) {} }
      return swr("org:" + oid, read); },
    async save(patch) { if (!supa) throw new Error("Supabase not configured");
      const oid = await this.id();
      if (!oid) throw new Error("Studio settings aren't available for this workspace yet.");
      // cc-general-billing: ask for the updated row back - an update the database row rules do not
      // allow changes NOTHING and returns no error, so "saved" must only be said when a row changed
      let { data, error } = await supa.from("organizations").update(patch).eq("id", oid).select("id");
      // #16: business_email_confirmed arrives with 0075; on an older database save the rest
      if (error && patch && "business_email_confirmed" in patch && (error.code === "PGRST204" || /business_email_confirmed/.test(error.message || ""))) {
        const rest = Object.assign({}, patch); delete rest.business_email_confirmed;
        ({ data, error } = await supa.from("organizations").update(rest).eq("id", oid).select("id"));
      }
      if (error) throw error;
      if (Array.isArray(data) && data.length === 0) {
        const e = new Error("Nothing was changed: only a studio admin (or someone allowed to edit Control Center) can change the studio settings.");
        e.code = "42501"; e.hint = "org_not_updated"; throw e;
      }
      // r19-studio-name: a rename / new logo shows at once in the rail, top bar, dashboard and profile menu (one fresh read)
      if (patch && ("name" in patch || "brand" in patch)) Promise.resolve().then(() => org.current({ fresh: true })).catch(() => {});
      return true; },
    // r19-studio-name: "which studio am I in" for the app shell / dashboard / profile menu. Built from the per-tab cached
    // studio row (current()) + the cached trial answer (subscription.trial(), memo + swr) - no extra request on a warm tab.
    // Resolves null when signed out or when there is no studio row. Repaints arrive as the "helm:studio" window event.
    async identity() {
      if (!supa || !currentUser) return null;
      const B = (typeof window !== "undefined" && window.BPStore) || null;
      const [row, t] = await Promise.all([org.current().catch(() => null),
        Promise.resolve().then(() => (B && B.subscription && B.subscription.trial ? B.subscription.trial() : null)).catch(() => null)]);
      if (t !== undefined) studioTrial = t || null;
      return studioDescribe(row, studioTrial);
    },
    describe: (row, trial) => studioDescribe(row, trial),
    createStudio: (name, opts) => rpc("create_studio", { p_name: name, p_email: (opts && opts.email) || null,
      p_currency: (opts && opts.currency) || "INR", p_timezone: (opts && opts.timezone) || "Asia/Kolkata" }),
    // GDPR / DPDP: admin downloads THIS org's data only (server re-scopes to current_org_id)
    exportData: () => rpc("export_org_data", {}),
    // Full portability package (organizations/profiles/quotes/event_attendees/invitations),
    // gated on has_area('users','view'); every table filtered by current_org_id server-side.
    exportPackage: () => rpc("export_tenant_organization_package", {}),
  };

  /* r19-studio-name (pure): the studio row + my_trial_status() answer -> what the UI shows. Text only (callers use
     textContent); the logo is used only when it is a plain https URL (same rule as the client booklet, 0065). */
  let studioTrial = null;
  function studioDescribe(row, trial) {
    if (!row || typeof row !== "object") return null;
    const name = String(row.name == null ? "" : row.name).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) return null;
    const words = name.split(/[\s\u00b7\u2022|/&,.+_-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    const first = (w) => (Array.from(w.replace(/[^\p{L}\p{N}]/gu, ""))[0] || "");
    let initials = words.length > 1 ? first(words[0]) + first(words[1]) : Array.from((words[0] || name).replace(/[^\p{L}\p{N}]/gu, "")).slice(0, 2).join("");
    initials = (initials || name.charAt(0)).toLocaleUpperCase();
    const b = row.brand && typeof row.brand === "object" && !Array.isArray(row.brand) ? row.brand : {};
    const lg = typeof b.logo === "string" ? b.logo.trim() : "";
    const logo = /^https:\/\/[^\s"'<>()]+$/i.test(lg) && lg.length <= 500 ? lg : null;
    let plan = null;
    const tr = trial && typeof trial === "object" ? trial : null;
    if (tr) {
      const days = Math.floor(Number(tr.days_left));
      if (tr.state === "ended") plan = { key: "ended", label: "Trial ended", title: "Your free trial has ended" };
      else if (tr.state === "trial" || tr.status === "trial") plan = { key: "trial", label: "Free trial",
        title: isFinite(days) && days >= 0 ? (days === 0 ? "Free trial: ends today" : "Free trial: " + days + (days === 1 ? " day" : " days") + " left") : "Free trial" };
      else if (tr.status === "active") plan = { key: "paid", label: "Paid plan", title: "Your studio is on a paid Helm plan" };
      else if (tr.status === "past_due") plan = { key: "due", label: "Payment due", title: "Your Helm subscription payment is due" };
      else if (tr.status === "suspended") plan = { key: "due", label: "Read-only", title: "Subscription suspended: the studio is read-only" };
    }
    return { id: row.id || null, name, initials, logo, plan };
  }
  // tell the shell / dashboard / profile menu the studio row changed (fresh read, rename, background refresh). Sent after
  // the read is cached (setTimeout). Listeners repaint from e.detail only - they must not call org.current() from here.
  function studioEmit(row) {
    try { const d = studioDescribe(row, studioTrial); if (d && typeof window !== "undefined" && window.dispatchEvent)
      setTimeout(() => { try { window.dispatchEvent(new CustomEvent("helm:studio", { detail: d })); } catch (e) {} }, 0); } catch (e) {}
  }

  /* ---------------- branded client links: /<studio>/<kind>/<ref> (0020) ----------------
     The <ref> (token / published invitation slug) is the only secret; <studio> is a
     public label. Public pages call links.require() first: the server confirms that
     <studio> really owns that link (current or retired name), so nobody can dress
     their own token up in another studio's name. Legacy URLs keep working. */
  const LINK_KINDS = { invite: 1, quote: 1, proposal: 1, portal: 1, work: 1 };
  const LINK_PROD_HOSTS = ["helm.events", "www.helm.events"];   // helm-v01.vercel.app is the staging site: keeps its own host
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
        try { const o = await org.current(); studioSlugCache = (o && o.public_slug) || null; } catch (e) { studioSlugCache = null; } if (studioSlugCache) HelmUrl.setStudio(studioSlugCache);
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
    rename: (slug) => rpc("set_studio_link_name", { p_slug: slug }).then((r) => { studioSlugCache = r || null; if (r) HelmUrl.setStudio(r); return r; }),
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
    // la-fetch (audit 44): once per 10 minutes per tab (the server's own per-studio limit), not on every
    // open of Quotes / Dashboard - a write on page open also dropped every shared read of that page
    // (coalescedFetch), so the page's start-up reads ran twice. pg_cron (0040 helm_link_expiry_shelf,
    // every 30 min) does the same work where it is installed. Skipped -> { moved: 0, skipped: true }.
    tick(o) {
      const k = "bp_shelf_tick:" + ((currentUser && currentUser.id) || "");
      if (!(o && o.force)) { try { const last = Number(sessionStorage.getItem(k) || 0); if (last && Date.now() - last >= 0 && Date.now() - last < SHELF_TICK_MS) return Promise.resolve({ moved: 0, skipped: true }); } catch (e) {} }
      try { sessionStorage.setItem(k, String(Date.now())); } catch (e) {}
      return rpc("link_expiry_shelf_tick", {});
    },
  };
  const SHELF_TICK_MS = 10 * 60000;

  /* ---------------- invitations: join an existing studio (Phase 83) ---------------- */
  // Onboarding split: create a NEW company = org.createStudio; JOIN an existing
  // one = accept an admin's invite token. Tenant is resolved server-side by RLS.
  const invitations = {
    create: (email, role) => rpc("create_invitation", { p_email: email, p_role: role }),   // admin only (server-checked)
    async list() { if (!supa) return [];                                                     // RLS returns only this org's invites
      const { data, error } = await supa.from("invitations").select("*").order("created_at", { ascending: false });
      if (error) throw error; return data || []; },
    // 0131: invitation e-mails. resendEmail re-queues (admin, same studio, once per 10 min);
    // sendNow asks the invite-mailer to flush THIS studio's queue right away. Never throws:
    // { status: "ok", sent, skipped, failed } | { status: "dormant" } | { status: "unavailable" }.
    resendEmail: (id) => rpc("resend_invitation_email", { p_invitation_id: id }),
    // "unavailable" carries a short reason: not_configured | not_deployed (404) | unauthorized
    // (401 — usually deployed without --no-verify-jwt) | forbidden (not an admin) | rate_limited | server_error | network.
    async sendNow() { if (!supa || !fnUrl("invite-mailer")) return { status: "unavailable", reason: "not_configured" };
      try { const r = await callFn("invite-mailer", {}); return (r && typeof r === "object") ? r : { status: "unavailable", reason: "server_error" }; }
      catch (e) { const msg = String(e && e.message || ""); const m = /HTTP (\d+)/.exec(msg);
        const code = m ? Number(m[1]) : (/unauthor/i.test(msg) ? 401 : /forbidden/i.test(msg) ? 403 : /too many/i.test(msg) ? 429 : 0);
        const reason = code === 404 ? "not_deployed" : code === 401 ? "unauthorized" : code === 403 ? "forbidden"
          : code === 429 ? "rate_limited" : (code || (msg && !/fetch|network/i.test(msg))) ? "server_error" : "network";
        return { status: "unavailable", reason }; } },
    // 0167 — "2 of 2 seats used": members + open invitations vs the studio's seat limit (free trial: you + 2)
    seats: () => rpc("my_seat_usage"),
    accept:  (token) => rpc("accept_invitation", { p_token: token }),                        // signed-in invitee attaches to the org
    byToken: (token) => rpc("invitation_by_token", { p_token: token }),                      // minimal, no-PII info for the accept screen
    // Direct invite sign-up (edge function invite-signup): the server creates the account,
    // already confirmed, ONLY for the e-mail the invitation is bound to. → { ok:true } |
    // { fallback:true } (use the normal confirm-by-e-mail sign-up: function not deployed, no
    // bound e-mail, kill switch). A refusal throws an Error with .code (email_mismatch, …).
    // the invited e-mail for a valid invitation (shown locked on the join form) → string | null
    async invitedEmail(token) { const p = await invitations.peek(token); return p && !p.invalid ? p.email : null; },
    // 0205: { email, account, studio, inviter, role, role_label } of a valid invitation (only its OWN
    // e-mail; inviter = display name) | { invalid: true, reason: expired|used|revoked|"", studio } for a
    // token that no longer works | null (function not deployed / offline). account:
    // "new" (no login yet) | "needs_link" (the invite e-mail made a login without a password -
    // the old link was used / expired: offer "Email me a new link") | "existing" (sign in) | null (unknown)
    async peek(token) {
      if (!supa || !fnUrl("invite-signup") || !token) return null;
      try {
        const res = await fetch(fnUrl("invite-signup"), { method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CFG.anonKey, "apikey": CFG.anonKey },
          body: JSON.stringify({ token, peek: true }) });
        const j = await res.json().catch(() => ({}));
        const str = (v, n) => String(v == null ? "" : v).slice(0, n);
        if (res.status === 400 && j && j.code === "invalid_invite")
          return { invalid: true, reason: /^(expired|used|revoked)$/.test(String(j.reason || "")) ? j.reason : "", studio: str(j.studio, 120) };
        if (!(res.ok && j && typeof j.email === "string" && j.email)) return null;
        return { email: j.email, account: /^(new|needs_link|unconfirmed|existing)$/.test(String(j.account || "")) ? j.account : null,
          studio: str(j.studio, 120), inviter: str(j.inviter, 60), role: str(j.role, 40), role_label: str(j.role_label, 60) };
      } catch (e) { return null; }
    },
    // 0205: e-mail the invited address a NEW link (sign in → set password → join). The server sends
    // only to the invitation's own e-mail and rate-limits it. → { sent: true } | { account: "new" };
    // a refusal throws an Error with .code (rate_limited, account_exists, invalid_invite, send_failed, unavailable).
    async resendLink(token) {
      const fail = (msg, code) => { const e = new Error(msg); e.code = code; return e; };
      if (!supa || !fnUrl("invite-signup") || !token) throw fail("We couldn't send a new link from here — ask your studio admin to re-send the invitation.", "unavailable");
      let res;
      try {
        res = await fetch(fnUrl("invite-signup"), { method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CFG.anonKey, "apikey": CFG.anonKey },
          body: JSON.stringify({ token, resend: true }) });
      } catch (e) { throw fail("We couldn't reach Helm — check your connection and try again.", "network"); }
      const j = await res.json().catch(() => ({}));
      if (res.ok && j && j.sent === true) return { sent: true };
      if (res.ok && j && j.account === "new") return { account: "new" };
      if (res.ok && j && j.requested === true) return { requested: true, studio: String(j.studio || "").slice(0, 120) };   // expired: the studio was asked
      if (j && j.code && (res.status < 500 || j.code === "send_failed")) throw fail(String(j.error || "Couldn't send the e-mail."), String(j.code));
      throw fail("We couldn't send a new link from here — ask your studio admin to re-send the invitation.", "unavailable");
    },
    async signupDirect(token, email, password, fullName) {
      if (!supa || !fnUrl("invite-signup")) return { fallback: true };
      let res;
      try {
        res = await fetch(fnUrl("invite-signup"), { method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CFG.anonKey, "apikey": CFG.anonKey },
          body: JSON.stringify({ token, email, password, full_name: fullName || "" }) });
      } catch (e) { return { fallback: true }; }          // not deployed / CORS / offline → old path
      const j = await res.json().catch(() => ({}));
      if (res.ok) return j && j.ok ? { ok: true } : { fallback: true };
      if (res.status === 404 || res.status >= 500 || !j || !j.code) return { fallback: true };
      const e = new Error(String(j.error || "Couldn't create the account.")); e.code = j.code; e.status = res.status; if (j.reason) e.reason = String(j.reason).slice(0, 20); throw e;
    },
    // 0210 (free-trial sign-up, before anything is created): does this e-mail have an OPEN invitation?
    // → { invited: true, studio, role, role_label } | { invited: false } | null (function not deployed,
    // rate limited, offline, slow - the sign-up then simply carries on). Only studio + role ever come back.
    async openForEmail(email, opts) {
      const em = String(email || "").trim().toLowerCase();
      if (!supa || !fnUrl("invite-signup") || !em) return null;
      const ms = Math.max(500, Math.min(10000, Number(opts && opts.timeoutMs) || 4000));
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, ms) : null;
      try {
        const res = await fetch(fnUrl("invite-signup"), { method: "POST", signal: ctl ? ctl.signal : undefined,
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CFG.anonKey, "apikey": CFG.anonKey },
          body: JSON.stringify({ email_lookup: true, email: em }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j || typeof j !== "object") return null;
        if (j.invited !== true) return j.invited === false ? { invited: false } : null;
        const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
        return { invited: true, studio: str(j.studio, 120), role: str(j.role, 40), role_label: str(j.role_label, 60) };
      } catch (e) { return null; }
      finally { if (timer) clearTimeout(timer); }
    },
    // 0210 "Join <Studio>" from the sign-up: e-mail THAT address its invitation again (Join link →
    // /login?invite=<token>; the token never comes to this browser). → { sent: true|false }; a refusal
    // throws an Error with .code (rate_limited, send_failed, unavailable, network).
    async emailInviteLink(email) {
      const fail = (msg, code) => { const e = new Error(msg); e.code = code; return e; };
      const em = String(email || "").trim().toLowerCase();
      if (!supa || !fnUrl("invite-signup") || !em) throw fail("We couldn't send it from here — open the invitation e-mail you already have.", "unavailable");
      let res;
      try {
        res = await fetch(fnUrl("invite-signup"), { method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CFG.anonKey, "apikey": CFG.anonKey },
          body: JSON.stringify({ email_send: true, email: em }) });
      } catch (e) { throw fail("We couldn't reach Helm — check your connection and try again.", "network"); }
      const j = await res.json().catch(() => ({}));
      if (res.ok && j && j.ok === true) return { sent: j.sent === true };
      if (j && (j.code === "rate_limited" || j.code === "send_failed")) throw fail(String(j.error || "Couldn't send the e-mail."), String(j.code));
      throw fail("We couldn't send it from here — open the invitation e-mail you already have.", "unavailable");
    },
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

  /* ---------------- upload guard (0048): sniff · mismatch · re-encode · safe names ----------------
     Every image that leaves the browser is decoded and re-drawn on a canvas, then saved as
     WebP (JPEG fallback). That drops EXIF / GPS / XMP / ICC comments and any bytes appended
     to the picture, and caps size + pixels. Type is always taken from the file's bytes; a
     file whose declared type or extension disagrees with its bytes is refused. Object keys
     are server-shaped (<org>/<folder>/<uuid>.<ext>), never the client's file name; the
     storage policies in 0048 enforce the same shape server-side. */
  const UG_SNIFF = [                                       // [mime, ext, magic-byte matcher]
    ["image/png",  "png",  (b) => b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47 && b[4]===0x0D && b[5]===0x0A && b[6]===0x1A && b[7]===0x0A],
    ["image/jpeg", "jpg",  (b) => b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF],
    ["image/webp", "webp", (b) => b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 && b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50],
    ["image/gif",  "gif",  (b) => b[0]===0x47 && b[1]===0x49 && b[2]===0x46 && b[3]===0x38 && (b[4]===0x37 || b[4]===0x39) && b[5]===0x61],
    ["application/pdf", "pdf", (b) => b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46 && b[4]===0x2D],
    ["audio/webm", "webm", (b) => b[0]===0x1A && b[1]===0x45 && b[2]===0xDF && b[3]===0xA3],
    ["audio/ogg",  "ogg",  (b) => b[0]===0x4F && b[1]===0x67 && b[2]===0x67 && b[3]===0x53],
    ["audio/mp4",  "m4a",  (b) => b[4]===0x66 && b[5]===0x74 && b[6]===0x79 && b[7]===0x70],
    ["audio/mpeg", "mp3",  (b) => (b[0]===0x49 && b[1]===0x44 && b[2]===0x33) || (b[0]===0xFF && (b[1]&0xE0)===0xE0)],
  ];
  // declared type / extension → the sniffed mime it must agree with
  const UG_ALIAS = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4",
    "video/webm": "audio/webm", "video/mp4": "audio/mp4", "audio/mp3": "audio/mpeg", "application/x-pdf": "application/pdf" };
  const UG_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg", webp: "image/webp", gif: "image/gif",
    pdf: "application/pdf", webm: "audio/webm", weba: "audio/webm", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
    m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/mp4", mp3: "audio/mpeg" };
  function ugErr(msg, code) { const e = new Error(msg); e.code = code || "upload_invalid"; return e; }
  function ugSniff(bytes) {
    const b = bytes || [];
    if (b.length < 12) return null;
    for (const [mime, ext, ok] of UG_SNIFF) { if (ok(b)) return { mime, ext }; }
    return null;
  }
  async function ugHead(file, n) {
    const part = file.slice(0, n || 16);
    if (part && typeof part.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer());
    return new Uint8Array(await new Response(part).arrayBuffer());
  }
  // null when declared type + extension agree with the bytes; otherwise the reason
  function ugMismatch(file, sniff) {
    if (!sniff) return "unrecognised";
    const norm = (m) => { m = String(m || "").split(";")[0].trim().toLowerCase(); return UG_ALIAS[m] || m; };
    const declared = norm(file && file.type);
    // (a recorder may label audio "video/webm" etc. — aliased above); anything else that differs is refused
    if (declared && declared !== "application/octet-stream" && declared !== sniff.mime) return "type";
    const name = String((file && file.name) || "");
    const dot = name.lastIndexOf(".");
    if (dot > 0) {
      const ext = name.slice(dot + 1).toLowerCase();
      if (UG_EXT[ext] && UG_EXT[ext] !== sniff.mime) return "extension";
      if (!UG_EXT[ext] && /^(html?|svg|xml|js|mjs|php|exe|bat|cmd|sh|jar|com|scr|msi|dll|hta|xhtml)$/.test(ext)) return "extension";
    }
    return null;
  }
  // server-shaped object name: <uuid>.<ext> (ext from the allowlist only)
  function ugObjectName(ext) {
    if (!/^(png|jpg|webp|gif|pdf|webm|ogg|m4a|mp3)$/.test(String(ext || ""))) return null;
    const id = newUuid();
    return id ? id.toLowerCase() + "." + ext : null;
  }
  // display-only file name: no path, no control / markup characters, bounded
  function ugDisplayName(name, fallback) {
    let s = String(name || "").split(/[\\/]/).pop();
    s = s.replace(/[\u0000-\u001f\u007f<>:"|?*`$;&{}\[\]]/g, "").replace(/\s+/g, " ").replace(/^\.+/, "").trim();
    if (s.length > 120) { const d = s.lastIndexOf("."); const ext = d > 0 && s.length - d <= 8 ? s.slice(d) : ""; s = s.slice(0, 120 - ext.length) + ext; }
    return s || String(fallback || "file");
  }
  // longest edge ≤ maxPx, aspect kept
  function ugFit(w, h, maxPx) {
    w = Math.floor(Number(w) || 0); h = Math.floor(Number(h) || 0);
    if (!(w > 0 && h > 0)) return null;
    const k = Math.min(1, (maxPx || 2560) / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  /* check + re-encode one picked image → { blob, mime, ext, sniffed }
     opts: maxBytes (output cap), maxInput (input cap), maxPx (long edge), allow (sniffed mimes) */
  async function ugPrepareImage(file, opts) {
    opts = opts || {};
    const maxBytes = opts.maxBytes || 8 * 1024 * 1024, maxInput = opts.maxInput || 25 * 1024 * 1024, maxPx = opts.maxPx || 2560;
    const allow = opts.allow || ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (!file || typeof file.size !== "number" || typeof file.slice !== "function") throw ugErr("Choose a photo to upload.");
    if (file.size < 12) throw ugErr("That file is empty or not a photo.");
    if (file.size > maxInput) throw ugErr("That photo is too large — choose one under " + Math.round(maxInput / 1048576) + " MB.", "upload_too_large");
    const sniff = ugSniff(await ugHead(file, 16));
    if (!sniff || allow.indexOf(sniff.mime) < 0) throw ugErr("Unsupported image type.", "upload_type");
    if (ugMismatch(file, sniff)) throw ugErr("That file's name or type doesn't match its contents — it was not uploaded.", "upload_mismatch");
    const doc = global.document;
    if (!doc || typeof doc.createElement !== "function") throw ugErr("Photos can't be processed here.", "upload_unavailable");
    let img = null, url = null;
    try {
      if (typeof global.createImageBitmap === "function") {
        try { img = await global.createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { img = null; }
      }
      if (!img) {
        url = URL.createObjectURL(file);
        img = await new Promise((resolve, reject) => {
          const im = new global.Image();
          im.onload = () => resolve(im); im.onerror = () => reject(ugErr("That photo couldn't be opened — try another one."));
          im.src = url;
        });
      }
      const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
      if (w0 * h0 > 80e6) throw ugErr("That photo is too large — choose a smaller one.", "upload_too_large");
      const box = ugFit(w0, h0, maxPx);
      if (!box) throw ugErr("That photo couldn't be opened — try another one.");
      const cv = doc.createElement("canvas"); cv.width = box.w; cv.height = box.h;
      const ctx = cv.getContext("2d");
      if (!ctx) throw ugErr("Photos can't be processed in this browser.", "upload_unavailable");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, box.w, box.h);            // flatten transparency for JPEG
      try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; } catch (e) {}
      ctx.drawImage(img, 0, 0, box.w, box.h);
      const toBlob = (type, q) => new Promise((resolve) => { try { cv.toBlob((b) => resolve(b), type, q); } catch (e) { resolve(null); } });
      let out = null, cur = cv;
      for (let pass = 0; pass < 3 && !out; pass++) {
        for (const q of [0.9, 0.82, 0.74, 0.66, 0.58]) {
          let b = await toBlob("image/webp", q);
          if (!b || b.type !== "image/webp") b = await toBlob("image/jpeg", q);
          if (b && b.size <= maxBytes) { out = b; break; }
        }
        if (!out && pass < 2) {                                                 // still too big: halve the pixels
          const nw = Math.max(1, Math.round(cur.width * 0.7)), nh = Math.max(1, Math.round(cur.height * 0.7));
          const c2 = doc.createElement("canvas"); c2.width = nw; c2.height = nh;
          const g2 = c2.getContext("2d"); g2.fillStyle = "#ffffff"; g2.fillRect(0, 0, nw, nh); g2.drawImage(cur, 0, 0, nw, nh);
          cv.width = nw; cv.height = nh; ctx.drawImage(c2, 0, 0); cur = cv;
        }
      }
      if (!out) throw ugErr("That photo couldn't be made small enough — try another one.", "upload_too_large");
      const outSniff = ugSniff(await ugHead(out, 16));
      if (!outSniff || (outSniff.mime !== "image/webp" && outSniff.mime !== "image/jpeg")) throw ugErr("That photo couldn't be converted — try another one.");
      return { blob: out, mime: outSniff.mime, ext: outSniff.ext, sniffed: sniff.mime };
    } finally {
      if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
      if (img && typeof img.close === "function") { try { img.close(); } catch (e) {} }
    }
  }
  // non-image (pdf / audio): bytes must match an allowed type AND the declared type / name
  async function ugCheckFile(file, allow, maxBytes) {
    if (!file || typeof file.size !== "number" || typeof file.slice !== "function") throw ugErr("Choose a file to upload.");
    if (maxBytes && file.size > maxBytes) throw ugErr("File too large (max " + Math.round(maxBytes / 1048576) + " MB).", "upload_too_large");
    const sniff = ugSniff(await ugHead(file, 16));
    if (!sniff || (allow && allow.indexOf(sniff.mime) < 0)) throw ugErr("Unsupported file type.", "upload_type");
    if (ugMismatch(file, sniff)) throw ugErr("That file's name or type doesn't match its contents — it was not uploaded.", "upload_mismatch");
    return sniff;
  }
  /* 0051 server-side verification: { path: "pending" | "clean" | "rejected" } for objects of the
     caller's studio. Unknown / not tracked → absent (treat as clean). Best-effort: {} on error or
     before 0051 is applied, so the UI never breaks while the scanner is not deployed. */
  async function ugScanStatus(bucket, paths) {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p).slice(0, 200);
    if (!supa || !list.length) return {};
    try {
      const { data, error } = await supa.rpc("upload_scan_status", { p_bucket: String(bucket || ""), p_names: list });
      if (error || !Array.isArray(data)) return {};
      const out = {}; data.forEach((r) => { if (r && r.name && /^(pending|clean|rejected)$/.test(r.status)) out[r.name] = r.status; });
      return out;
    } catch (e) { return {}; }
  }
  const uploads = { sniff: ugSniff, mismatch: ugMismatch, objectName: ugObjectName, displayName: ugDisplayName, fit: ugFit,
    prepareImage: ugPrepareImage, checkFile: ugCheckFile, scanStatus: ugScanStatus };

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

  // one anon client per invitation slug; no session is stored or read (guests never sign in here)
  const guestMediaClients = new Map();
  function guestMediaClient(slug) {
    slug = String(slug || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(slug)) return null;
    if (guestMediaClients.has(slug)) return guestMediaClients.get(slug);
    if (!(global.supabase && global.supabase.createClient) || !supaConfigured()) return null;
    let c = null;
    try {
      c = global.supabase.createClient(CFG.url, CFG.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "helm-guest-media" },
        global: { headers: { "x-helm-site-slug": slug } } });
    } catch (e) { c = null; }
    if (c) guestMediaClients.set(slug, c);
    return c;
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
    // 0195 "Send to client": queues the PUBLISHED invitation link (fixed text) by e-mail / WhatsApp.
    // The server checks consent / STOP / caps. FREE TRIAL (0212): an e-mail of an ACTIVE trial is queued
    // ({status:"queued", trial_email:true}; over the daily cap {status:"skipped", reason:"trial_email_cap"}); WhatsApp,
    // an ended trial and a demo event get {status:"skipped", reason:"free_trial" | "demo"} - nothing is sent.
    send: (siteId, channel, to, optIn, consentText) => rpc("event_site_send", { p_site: siteId, p_channel: channel === "whatsapp" ? "whatsapp" : "email",
      p_to: String(to || "").slice(0, 200), p_opt_in: !!optIn, p_consent_text: optIn ? String(consentText || "").slice(0, 500) : null }),
    sendLog: (siteId) => (supa ? rpc("event_site_send_log", { p_site: siteId }).catch(() => []) : Promise.resolve([])),
    unpublish: (id) => rpc("publish_event_site", { p_id: id, p_publish: false }),
    // Upload an invitation photo to Supabase Storage (public bucket 'invite-media').
    // Path is prefixed with the org id so storage RLS keeps tenants isolated.
    async uploadPhoto(quoteId, file) {
      if (!supa) throw new Error("Supabase not configured");
      if (!file) throw new Error("no file");
      if (file.size > INVITE_IMG_MAX * 3) throw new Error("Image too large (max 8 MB).");
      // Validate by MAGIC BYTES — never trust the client-declared type or extension.
      let sniff = await sniffInviteImage(file);
      if (!sniff) throw new Error("Unsupported image type — allowed: " + this.INVITE_IMG_LABEL + ".");
      // 0048: declared type / extension must agree with the bytes; then re-encode on a
      // canvas (strips EXIF/GPS, caps size at INVITE_IMG_MAX + pixels). The bytes uploaded
      // are the re-encoded ones; type + extension come from re-sniffing them.
      const img = await ugPrepareImage(file, { maxBytes: INVITE_IMG_MAX, maxInput: INVITE_IMG_MAX * 3, maxPx: 2560 });
      sniff = { mime: img.mime, ext: img.ext };
      const orgId = await org.id();
      if (!orgId) throw new Error("no organization in context");
      // Random object key; the client filename is discarded.
      const uuid = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      const path = orgId + "/" + quoteId + "/" + uuid + "." + sniff.ext;
      const { error } = await supa.storage.from("invite-media").upload(path, img.blob, { upsert: false, contentType: sniff.mime });
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
    // slug (guest invitation page): 0048 binds a guest's read to the invitation it holds —
    // the signing request carries x-helm-site-slug on its own session-less client.
    async mediaUrls(urls, seconds, slug) {
      const list = Array.isArray(urls) ? urls.slice() : [];
      if (!supa) { try { await BPStore.init(); } catch (e) {} }
      if (!supa || !list.length) return list;
      const re = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/invite-media\/([^?#]+)/;
      const idx = [], paths = [];
      list.forEach((u, i) => { const m = re.exec(String(u || "")); if (m) { idx.push(i); paths.push(decodeURIComponent(m[1])); } });
      if (!paths.length) return list;
      try {
        const client = slug ? (guestMediaClient(slug) || supa) : supa;
        const { data, error } = await client.storage.from("invite-media").createSignedUrls(paths, seconds || 3600);
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
      const sniff = await sniffFile(file);
      if (!sniff) throw new Error("Unsupported file type — allowed: " + this.ALLOWED_LABEL + ".");
      // 0048: images are re-encoded (EXIF/GPS stripped); PDFs must match their name/type
      let body = file, mime = sniff.mime, ext = sniff.ext;
      if (sniff.mime === "application/pdf") { await ugCheckFile(file, ["application/pdf"], FILE_MAX); }
      else { const img = await ugPrepareImage(file, { maxBytes: FILE_MAX, maxPx: 3000, allow: ["image/png", "image/jpeg", "image/webp"] });
             body = img.blob; mime = img.mime; ext = img.ext; }
      const orgId = await org.id();
      if (!orgId) throw new Error("no organization in context");
      const name = ugObjectName(ext);
      if (!name) throw new Error("upload not available");
      const uuid = name.split(".")[0];
      const path = orgId + "/" + quoteId + "/" + name;   // client name discarded
      const { error: upErr } = await supa.storage.from("event-docs").upload(path, body, {
        upsert: false, contentType: mime, cacheControl: "3600" });
      if (upErr) throw upErr;
      // record metadata (RLS re-checks org + has_area). Keep the original name for display only.
      const { data: uid } = await supa.auth.getUser().then((r) => ({ data: r && r.data && r.data.user && r.data.user.id })).catch(() => ({ data: null }));
      const { data: row, error: metaErr } = await supa.from("event_files").insert({
        quote_id: quoteId, storage_path: path, filename: ugDisplayName(file.name, uuid + "." + ext).slice(0, 200),
        mime: mime, size_bytes: body.size, uploaded_by: uid || null }).select().single();
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
  let chatBackendMissing = false, chatBcastEnsured = false, chatBcastInflight = null;   // bell: skip when chat SQL absent; ensure broadcast once
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
      if (item) { item.kind = "mention"; item.mention = true; item.title = title; item.who = ""; item.preview = m.preview; if (m.id) item.msg_id = m.id; if (String(m.created_at) > String(item.created_at)) item.created_at = m.created_at; }
      else out.push({ conversation_id: cid, msg_id: m.id, kind: "mention", mention: true, title, who: "", preview: m.preview, created_at: m.created_at, count: n });
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

  /* ---------------- sample-row names (r20) ---------------- */
  // r20 (live QA): ONE display format for a free-trial sample name everywhere a page shows it as
  // plain text (lists and drop-downs alike): "Demo \u00b7 PA Speaker" -> "PA Speaker (sample)". A seed
  // name that already ends in "(sample)" ("Demo \u00b7 Pandit Sharma Ji (sample)") gets it once, never
  // twice. Any other name is returned unchanged. Display only - the stored name is never touched.
  function sampleDisplayName(n) {
    const s = String(n == null ? "" : n), m = /^\s*Demo \u00b7\s*/.exec(s);
    if (!m) return s;
    const base = s.slice(m[0].length).replace(/\s*\(sample\)\s*$/i, "");
    return base ? base + " (sample)" : s;
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
    if (!/^\+?[0-9 ().-]{6,24}$/.test(s)) return { err: label + " must be a valid mobile number." };
    let d = s.replace(/[^0-9]/g, "");
    // 0055: international mobiles (E.164) are accepted; Indian numbers keep the 6–9 rule
    if (s.charAt(0) === "+" && d.slice(0, 2) !== "91") {
      if (!/^[1-9][0-9]{6,14}$/.test(d)) return { err: label + " must be 7–15 digits including the country code." };
      return { val: "+" + d };
    }
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
    if (ugMismatch(file, ugSniff(await readHead(file, 16)))) throw photoErr("That file's name or type doesn't match its contents — choose the original photo.");
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
  let studioAvMemo = null;          // 0060 studio_avatars() memo
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
      // la-fetch (audit 25): the shell menu, the dashboard greeting and the page each asked my_profile()
      // on open - one answer per 30 s per tab now (any save from this tab drops it, see memoRead)
      return memoRead("profile.mine", 30000, () => profile._mineFetch());
    },
    async _mineFetch() {
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
    // 0055 phone verification by WhatsApp code. DORMANT while config.liveChannels.whatsapp
    // is false: available() says so and the page lets the member continue unverified.
    // The code is minted + sent server-side (send-phone-code edge function); it is never
    // returned to the browser, in any mode.
    phoneVerify: {
      available: () => mode === "supabase" && !!LIVE.whatsapp,
      async send(e164) {
        if (!(mode === "supabase" && LIVE.whatsapp)) { const e = new Error("Phone verification will be available shortly — you can continue."); e.code = "verify_unavailable"; throw e; }
        if (!/^\+[1-9][0-9]{6,14}$/.test(String(e164 || ""))) { const e = new Error("Enter a valid mobile number first."); e.code = "profile_invalid"; throw e; }
        return callFn("send-phone-code", { phone: e164 });
      },
      async check(code) {
        if (!/^[0-9]{6}$/.test(String(code || ""))) return { ok: false, reason: "format", remaining: null };
        return rpc("phone_verify_check", { p_code: String(code) });
      },
      async status() { try { return await rpc("phone_verify_status", {}); } catch (e) { return null; } },
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
    // 0060: own-studio members → { user_id: { full_name, role, avatar_path } } (cached 5 min).
    // Never throws: offline / older database / refused → {}.
    async studioAvatars() {
      if (mode !== "supabase" || !supa || !currentUser) return {};
      if (studioAvMemo && studioAvMemo.uid === currentUser.id && studioAvMemo.exp > Date.now()) return studioAvMemo.p;
      const p = (async () => {
        try {
          const { data, error } = await supa.rpc("studio_avatars");
          if (error) return {};
          const out = {}; (data || []).forEach((r) => { if (r && r.user_id) out[r.user_id] = { full_name: r.full_name || "", role: r.role || "", avatar_path: AVATAR_PATH_RE.test(String(r.avatar_path || "")) ? r.avatar_path : null }; });
          return out;
        } catch (e) { return {}; }
      })();
      studioAvMemo = { uid: currentUser.id, exp: Date.now() + 300000, p };
      return p;
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

  // A12 (0074): pinned / muted / favourite chats are kept per user on the server (chat_prefs).
  // The wa_pin / wa_mute / wa_fav localStorage sets stay as a cache (the bell reads wa_mute).
  const CHAT_PREF_LS = { pinned: "wa_pin", muted: "wa_mute", favourite: "wa_fav" };
  let chatPrefsAt = 0, chatPrefsMissing = false;
  function chatPrefLocal(field) { try { const v = JSON.parse(localStorage.getItem(CHAT_PREF_LS[field]) || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch (e) { return []; } }
  function chatPrefWrite(field, ids) { try { localStorage.setItem(CHAT_PREF_LS[field], JSON.stringify(ids)); } catch (e) {} }
  const chatPrefs = {
    // → { pinned:[convId], muted:[...], favourite:[...] }; first run per user uploads the browser's old sets once
    async sync(force) {
      const local = () => ({ pinned: chatPrefLocal("pinned"), muted: chatPrefLocal("muted"), favourite: chatPrefLocal("favourite") });
      const uidNow = currentUser && currentUser.id;
      if (mode !== "supabase" || !supa || !uidNow || chatPrefsMissing) return local();
      if (!force && Date.now() - chatPrefsAt < 60000) return local();
      chatPrefsAt = Date.now();
      const read = async () => { const { data, error } = await supa.from("chat_prefs").select("conversation_id,pinned,muted,favourite"); if (error) throw error; return data || []; };
      let rows;
      try { rows = await read(); } catch (e) { const U = global.BPUI; if (U && U.isMissingTable && U.isMissingTable(e)) chatPrefsMissing = true; return local(); }
      const upKey = "wa_prefs_up:" + uidNow;
      let uploaded = false; try { uploaded = localStorage.getItem(upKey) === "1"; } catch (e) {}
      if (!uploaded) {
        const l = local(), ids = Array.from(new Set(l.pinned.concat(l.muted, l.favourite)));
        const have = new Set(rows.map((r) => String(r.conversation_id)));
        for (const id of ids) {
          if (have.has(id) || !/^[0-9a-f-]{36}$/i.test(id)) continue;
          try { await rpc("chat_set_pref", { p_conversation: id, p_pinned: l.pinned.indexOf(id) !== -1, p_muted: l.muted.indexOf(id) !== -1, p_favourite: l.favourite.indexOf(id) !== -1 }); } catch (e) {}   // a chat I left: skipped
        }
        try { localStorage.setItem(upKey, "1"); } catch (e) {}
        if (ids.length) { try { rows = await read(); } catch (e) { return local(); } }
      }
      const out = { pinned: [], muted: [], favourite: [] };
      rows.forEach((r) => { ["pinned", "muted", "favourite"].forEach((f) => { if (r[f]) out[f].push(String(r.conversation_id)); }); });
      Object.keys(out).forEach((f) => chatPrefWrite(f, out[f]));
      return out;
    },
    // field: "pinned" | "muted" | "favourite"
    async set(convId, field, on) {
      if (!CHAT_PREF_LS[field] || !convId) return;
      const cur = chatPrefLocal(field).filter((x) => x !== String(convId)); if (on) cur.push(String(convId)); chatPrefWrite(field, cur);
      if (mode !== "supabase" || !supa || chatPrefsMissing) return;
      const args = { p_conversation: convId, p_pinned: null, p_muted: null, p_favourite: null }; args["p_" + field] = !!on;
      await rpc("chat_set_pref", args);
    },
  };
  const chat = {
    // Is the feature running on localStorage (true) or a real backend (false)?
    isLocal: () => mode !== "supabase",
    // Who am I, for display + "is this mine" checks.
    async me() {
      if (mode !== "supabase") { const u = CHAT_LOCAL_ROSTER.find((x) => x.id === chatLocalUid()) || CHAT_LOCAL_ROSTER[0]; return { id: u.id, name: u.full_name, email: u.email }; }
      const id = currentUser && currentUser.id;
      // r20-2: same chain as the dashboard greeting - profile name, then the sign-in name (auth user_metadata
      // full_name / name, e.g. from Google), then the e-mail before "@"
      const md = (currentUser && currentUser.user_metadata) || {};
      const metaRaw = cleanDisplayName(md.full_name || md.name || "");
      const metaName = metaRaw && !displayNameProblem(metaRaw) ? metaRaw : "";
      let name = personDisplayName({ full_name: metaName, email: currentUser && currentUser.email });
      try { const { data } = await supa.from("profiles").select("full_name,email,role").eq("id", id).maybeSingle();
        if (data) name = personDisplayName(Object.assign({}, data, { full_name: String(data.full_name || "").trim() || metaName })); } catch (e) {}
      return { id, name, email: currentUser && currentUser.email, metaName };
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
      // la-fetch (audit 25): the studio directory changes rarely - one read per minute per tab is shared by the
      // bell poll, the chat page and the mention picker (any write from this tab drops it)
      return memoRead("chat.roster", 60000, () => chat._rosterFetch());
    },
    async _rosterFetch() {
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
      // ensure the org "Everyone" channel - la-fetch (audit 44): only on the Chat page and once per tab
      // session (it is a write: on every page open it dropped that page's shared reads). The bell on other
      // pages just lists the conversations that exist; the channel is made the first time someone opens Chat.
      if (!chatBcastEnsured && pageKey() === "chat") {
        const bk = "bp_chat_bcast:" + ((currentUser && currentUser.id) || "");
        let done = false; try { done = sessionStorage.getItem(bk) === "1"; } catch (e) {}
        if (done) chatBcastEnsured = true;
        else {
          // r20: single-flight - the Chat page can ask for conversations twice at once on first visit;
          // both used to fire the ensure RPC and the loser hit the one-broadcast-per-studio unique index
          // (409 / 23505). Share one in-flight call, and treat 409/23505 as "already exists" (it does).
          if (!chatBcastInflight) chatBcastInflight = (async () => {
            try { await rpc("chat_ensure_broadcast"); chatBcastEnsured = true; try { sessionStorage.setItem(bk, "1"); } catch (e) {} }
            catch (e) { const c = String((e && e.code) || ""), st = Number(e && e.status);
              if (c === "23505" || c === "409" || st === 409) { chatBcastEnsured = true; try { sessionStorage.setItem(bk, "1"); } catch (_) {} } }
            finally { chatBcastInflight = null; }
          })();
          try { await chatBcastInflight; } catch (e) {}
        }
      }
      const { data, error } = await supa.from("chat_conversations").select("*").order("last_message_at", { ascending: false });
      if (error) throw error;
      // event-group titles made while create_event_group's " \u00b7 " was mis-encoded (UTF-8 read as
      // Mac Roman: "\u00ac\u2211") - show the intended middle dot (display only; 0137 fixes new ones)
      (data || []).forEach((c) => { if (c && typeof c.title === "string" && c.title.indexOf("\u00ac\u2211") >= 0) c.title = c.title.split("\u00ac\u2211").join("\u00b7"); });
      return data || [];
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
    // B30: leave a group = remove MY membership row only (RLS chat_mem_del: user_id = auth.uid(), same studio).
    // The conversation, its messages and every other member stay. Groups only - never a DM or the broadcast.
    async leaveGroup(convId) {
      if (!convId) throw new Error("No group selected.");
      if (mode !== "supabase") {
        const convs = chatReadLs(CHAT_LS_C); const c = convs.find((x) => x.id === convId); const me = chatLocalUid();
        if (!c || c.kind !== "group") throw new Error("Only a group can be left.");
        c.members = (c.members || []).filter((m) => m.user_id !== me); chatWriteLs(CHAT_LS_C, convs); chatPing(); return true;
      }
      const uidMe = currentUser && currentUser.id; if (!uidMe) throw new Error("Sign in again to leave the group.");
      const { data: cv, error: ce } = await supa.from("chat_conversations").select("id,kind").eq("id", convId).maybeSingle();
      if (ce) throw ce;
      if (!cv || cv.kind !== "group") throw new Error("Only a group can be left.");
      const { data, error } = await supa.from("chat_members").delete().eq("conversation_id", convId).eq("user_id", uidMe).select("conversation_id");
      if (error) throw error;
      if (!data || !data.length) throw new Error("You are not in this group any more.");
      return true;
    },
    prefs: chatPrefs,
    // A6: forward a photo / voice note = COPY the object into the target conversation's folder.
    // Storage checks both sides (chat-media policies: I can read the source conversation and
    // upload into the target); 0074 refuses a message whose media key is under another conversation.
    async forwardMedia(fromPath, toConv) {
      if (mode !== "supabase") return { path: fromPath };   // local tier: data: URL, nothing to copy
      const m = CHAT_MEDIA_KEY.exec(String(fromPath || "")); if (!m) throw new Error("This attachment can't be forwarded.");
      const ext = String(fromPath).split(".").pop().toLowerCase();
      const orgId = await org.id(); if (!orgId || String(fromPath).split("/")[0] !== String(orgId)) throw new Error("This attachment can't be forwarded.");
      const name = ugObjectName(ext); if (!name) throw new Error("upload not available");
      const path = orgId + "/" + toConv + "/" + name;
      const { error } = await supa.storage.from("chat-media").copy(fromPath, path);
      if (error) throw error;
      return { path };
    },
    // Upload an image or voice note; returns { path, mime } to pass to send().
    async uploadMedia(convId, file, opts) {
      opts = opts || {};
      if (!file) throw new Error("no file");
      if (file.size > CHAT_MEDIA_MAX && !/^image\//.test(String(file.type || ""))) throw new Error("File too large (max 16 MB).");
      let sniff = await sniffChat(file);
      if (!sniff) throw new Error("Unsupported file — images or voice notes only.");
      // 0048: photos (incl. marked-up ones) are re-encoded → no EXIF/GPS; audio must match its type
      if (/^image\//.test(sniff.mime)) {
        const img = await ugPrepareImage(file, { maxBytes: 8 * 1024 * 1024, maxPx: 2560 });
        file = img.blob; sniff = { mime: img.mime, ext: img.ext };
      } else {
        await ugCheckFile(file, ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"], CHAT_MEDIA_MAX);
      }
      if (mode !== "supabase") { const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); return { path: dataUrl, mime: sniff.mime }; }
      const orgId = await org.id(); if (!orgId) throw new Error("no organization in context");
      const name = ugObjectName(sniff.ext);
      if (!name) throw new Error("upload not available");
      const path = orgId + "/" + convId + "/" + name;
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
          out.push({ conversation_id: c.id, msg_id: last.id, kind: c.kind, title, who: nameFor(last.sender_id), preview: chatPreviewText(last), created_at: last.created_at, count: unread.length });
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
        const item = { conversation_id: m.conversation_id, msg_id: m.id, kind: c.kind, title, who: nameById[m.sender_id] || "Member", preview: chatPreviewText(m), created_at: m.created_at, count: 1 };
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
      // 0194: "Add people" — people = [{kind:"user"|"staff"|"vendor"|"client", id}]. Teammates (and staff who sign
      // in) become chat members; other staff, vendors and the client are kept as the group's contacts (name only).
      // Nothing is sent to anyone (no WhatsApp / SMS / e-mail). → { users, contacts, skipped, trial, messages_sent:0 }
      async addPeople(convId, people) {
        const list = (Array.isArray(people) ? people : []).filter((x) => x && typeof x === "object" && /^(user|staff|vendor|client)$/.test(String(x.kind)))
          .map((x) => (x.kind === "client" ? { kind: "client" } : { kind: x.kind, id: String(x.id || "") })).slice(0, 200);
        if (!list.length) return { users: 0, contacts: 0, skipped: 0, trial: false, messages_sent: 0 };
        if (mode !== "supabase") {
          const convs = chatReadLs(CHAT_LS_C); const c = convs.find((x) => x.id === convId);
          if (!c || !c.quote_id) throw new Error("People can be added this way only to an event group.");
          c.members = c.members || []; c.contacts = c.contacts || []; let users = 0, contacts = 0;
          const crew = list.some((x) => x.kind === "staff") ? await staff.list(true).catch(() => []) : [];
          const vend = list.some((x) => x.kind === "vendor") ? await vendors.listAll(true).catch(() => []) : [];
          let q = null; if (list.some((x) => x.kind === "client")) { try { q = await quotes.get(c.quote_id); } catch (e) { q = null; } }
          list.forEach((x) => {
            if (x.kind === "user") { if (!c.members.some((m) => m.user_id === x.id)) { c.members.push({ user_id: x.id }); users++; } return; }
            let name = "", ref = x.kind === "client" ? null : x.id;
            if (x.kind === "staff") { const r = crew.find((s) => s.id === x.id && s.active !== false); name = r ? r.name : ""; }
            else if (x.kind === "vendor") { const r = vend.find((v) => v.id === x.id && v.active !== false); name = r ? r.name : ""; }
            else name = (q && q.client && String(q.client.name || "").trim()) || "Client";
            if (!name) return;
            const key = ref || x.kind, cur = c.contacts.find((k) => k.kind === x.kind && k.ref_key === key);
            if (cur) { if (cur.removed_at) { cur.removed_at = null; contacts++; } return; }
            c.contacts.push({ id: uid(), conversation_id: convId, kind: x.kind, ref_id: ref, ref_key: key, name: String(name).slice(0, 120), created_at: now(), removed_at: null }); contacts++;
          });
          chatWriteLs(CHAT_LS_C, convs); chatPing(); return { users, contacts, skipped: 0, trial: false, messages_sent: 0 };
        }
        return rpc("event_group_add_people", { p_conversation: convId, p_people: list });
      },
      // 0194: the group's contacts still in it (staff / vendors / client who don't sign in), oldest first.
      // Fail-soft: 0194 not installed yet → [] (the group shows its chat members only).
      async contacts(convId) {
        if (mode !== "supabase") { const c = chatReadLs(CHAT_LS_C).find((x) => x.id === convId); return ((c && c.contacts) || []).filter((k) => !k.removed_at); }
        const { data, error } = await supa.from("chat_group_contacts").select("id,kind,ref_id,name,created_at")
          .eq("conversation_id", convId).is("removed_at", null).order("created_at").limit(500);
        if (error) { const U = global.BPUI; if (U && U.isMissingTable && U.isMissingTable(error)) return []; throw error; }
        return data || [];
      },
      async removeContact(convId, contactId) {
        if (mode !== "supabase") { const convs = chatReadLs(CHAT_LS_C); const c = convs.find((x) => x.id === convId); const k = c && (c.contacts || []).find((x) => x.id === contactId); if (k) { k.removed_at = now(); chatWriteLs(CHAT_LS_C, convs); chatPing(); } return !!k; }
        return rpc("event_group_remove_contact", { p_conversation: convId, p_contact: contactId });
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
      const [needs, team, avail, ownRes] = await Promise.all([
        this.listNeeds(quoteId), staff.list(false), inventory.availability(),
        inventory.reservations(quoteId).catch(() => []),
      ]);
      // Stock already reserved/allocated FOR THIS EVENT is covered in-house: availability
      // subtracts it, so add it back for this event's own needs.
      const mine = {};
      (ownRes || []).forEach((r) => { if (r && r.quote_id === quoteId && ACTIVE_RES.includes(r.status)) mine[r.item_id] = (mine[r.item_id] || 0) + Number(r.qty || 0); });
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
        else if (n.kind === "inventory") { const a = avail[n.item_id]; have = (a ? Math.max(0, Number(a.available) || 0) : 0) + (mine[n.item_id] || 0); unit = a ? (a.unit || "") : ""; detail = a ? a.name : "(item removed)"; }
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
      // la-fetch (security gap): explicit studio filter + paged with the shared safety cap (calendar clash check)
      if (mode === "supabase") { const org = await orgIdStrict(); if (!org) return [];
        return sbAll(() => supa.from("event_resources").select("*").eq("org_id", org).order("id")); }
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
  // 0198: the one rule for "this event still holds its date / venue / crew / vendors / stock"
  const calEvLive = (e) => !!e && e.status !== "cancelled" && e.lifecycleStage !== "closed" && !e.closedAt && !e.archivedAt && !e.deletedAt;
  const ackLs = () => { try { const v = JSON.parse(localStorage.getItem("bp_conflict_acks") || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
  const conflictKey = (c) => [c.type, c.date || "", String(c.rid || c.label || "").toLowerCase().slice(0, 120),
    (c.events || []).map((e) => e && e.id).filter(Boolean).sort().join(",")].join("|");
  const calendar = {
    // Pull every commitment across all events and detect date clashes.
    async load() {
      let [events, invRes, vendorBk, items, team, vends, tasks, plans, pricingCfg, shortRows] = await Promise.all([
        quotes.list(),
        inventory.reservations().catch(() => []),
        bookings.listAll().catch(() => []),
        inventory.items(true).catch(() => []),
        staff.list(true).catch(() => []),
        vendors.listAll(true).catch(() => []),
        (async () => {
          if (mode !== "supabase") return readLs("bp_tasks_stub") || [];
          // la-fetch (security gap): explicit studio filter (RLS is still the gate) + paged with the shared
          // safety cap, not one unbounded read that PostgREST silently cut at 1000 rows
          const org = await orgIdStrict(); if (!org) return [];
          return sbAll(() => supa.from("event_tasks").select("id,quote_id,crew_id,title,status").eq("org_id", org).not("crew_id", "is", null).order("id"));
        })().catch(() => []),
        (async () => {
          // venue name/address per event (for the venue-double-booking check)
          if (mode !== "supabase") return [];
          const org = await orgIdStrict(); if (!org) return [];
          return sbAll(() => supa.from("event_plan").select("quote_id,venue_name,venue_address").eq("org_id", org).order("quote_id"));
        })().catch(() => []),
        config.getPricing().catch(() => ({})),   // for the venue-clash buffer (parallel, no extra round-trip)
        inventory.shortages().catch(() => []),   // 0197: open stock shortages ("Short: 10 x Air Cooler - sourcing from ...")
      ]);
      // Cancelled / closed events and finished tasks don't hold anything: leave them out of clash checks.
      // 0198: a closed event never clashes, whatever its status (and neither does an archived / deleted one).
      const evLive = calEvLive;
      const liveEvents = events.filter(evLive);
      const evById = {}; liveEvents.forEach((e) => { evById[e.id] = e; });
      tasks = (tasks || []).filter((t) => !["done", "completed", "cancelled"].includes(String(t.status || "").toLowerCase()));
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
        if (sum > Number(item.total_qty || 0)) conflicts.push({ type: "inventory", date: d, rid: itemId,
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
          conflicts.push({ type: "vendor", date: d, rid: vid, label: v ? v.name : "Partner",
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
          conflicts.push({ type: "staff", date: d, rid: sid, label: p ? p.name : "Staff",
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
      liveEvents.forEach((e) => {
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
        conflicts.push({ type: "venue", date: ev[0].eventDate, rid: vnorm(v.name) || vnorm(v.address), label: vname,
          detail: hasTimeClash
            ? `${ev.length} events at ${vname} on ${ev[0].eventDate} within ${bufferHours}h of each other`
            : `${ev.length} events at ${vname} on ${ev[0].eventDate} — set start times to check the ${bufferHours}h gap`,
          events: ev });
      });

      // 0198: every clash names only live events, and gets a stable key (type | date | what | which events)
      // so it can be acknowledged; the key changes - and the clash shows again - when another event joins.
      conflicts.forEach((c) => {
        c.events = (c.events || []).filter(Boolean);
        c.key = conflictKey(c);
      });

      // ---- per-event commitment rollup (for the agenda) ----
      const agenda = events.map((e) => {
        const inv = invRes.filter((r) => r.quote_id === e.id && ["reserved", "allocated"].includes(r.status));
        const vend = vendorBk.filter((b) => b.quote_id === e.id && b.status !== "cancelled");
        const crew = [...new Set(tasks.filter((t) => t.quote_id === e.id).map((t) => t.crew_id))];
        return { event: e, invCount: inv.length, vendCount: vend.length, staffCount: crew.length, venue: venueOf(e).name,   // cal-events-1018: event_plan venue first
          items: inv.map((r) => ({ name: (itemById[r.item_id] || {}).name || "item", qty: r.qty })),
          vendorsList: vend.map((b) => (vendById[b.vendor_id] || {}).name || b.label),
          staffList: crew.map((c) => (staffById[c] || {}).name || "crew") };
      });
      // 0197: open stock shortages on live events (reserved only what was free; the rest is being sourced)
      const shortages = (shortRows || []).filter((r) => evById[r.quote_id]).map((r) => {
        const b = vendorBk.find((x) => x.id === r.booking_id), v = vendById[r.vendor_id];
        return { id: r.id, date: dateOf(r.quote_id), event: evById[r.quote_id], source: r.source || "none", qty: Number(r.qty) || 0,
          text: shortageText(r, { itemName: (itemById[r.item_id] || {}).name, vendorName: v && v.name, bookingStatus: b && b.status }) };
      });
      agenda.forEach((a) => { a.shortages = shortages.filter((x) => x.event && x.event.id === a.event.id); });
      return { agenda, conflicts, shortages, counts: { events: events.length, dated: events.filter((e) => e.eventDate).length } };
    },
    // cal-events-1018: ids of this studio's SAMPLE (free-trial seed, is_demo) quotes, for the calendar's "Sample" chip.
    // Read-only, RLS = own studio; advisory: a database without is_demo / any error = no sample ids.
    async sampleIds() {
      if (mode !== "supabase" || !supa) return [];
      try {
        const { data, error } = await supa.from("quotes").select("id").eq("is_demo", true).limit(500);
        return !error && Array.isArray(data) ? data.map((r) => r.id) : [];
      } catch (e) { return []; }
    },
    // Phase 49 — the conflicts that involve one specific event (for the workspace card)
    async conflictsForEvent(quoteId) {
      const { conflicts } = await this.load();
      return conflicts.filter((c) => (c.events || []).some((e) => e && e.id === quoteId));
    },
    // 0198: open "acknowledged" marks for these conflict keys -> { key: {by, at, note} }.
    // null = this database has no 0198 yet (the page hides "Mark acknowledged").
    async acks(keys) {
      const list = [...new Set((keys || []).filter(Boolean))].slice(0, 200);
      if (mode !== "supabase" || !supa) { const all = ackLs(); const out = {}; list.forEach((k) => { if (all[k]) out[k] = all[k]; }); return out; }
      if (!list.length) return {};
      const { data, error } = await supa.from("calendar_conflict_acks").select("conflict_key,acked_email,acked_at,note")
        .in("conflict_key", list).is("revoked_at", null);
      if (error) { const c = error.code || ""; if (c === "42P01" || c === "PGRST205" || /calendar_conflict_acks/i.test(String(error.message || ""))) return null; throw error; }
      const out = {}; (data || []).forEach((r) => { out[r.conflict_key] = { by: r.acked_email || "", at: r.acked_at, note: r.note || "" }; });
      return out;
    },
    async ack(quoteId, key, note) {
      if (mode !== "supabase" || !supa) { const all = ackLs(); all[key] = { by: "", at: now(), note: note || "" };
        localStorage.setItem("bp_conflict_acks", JSON.stringify(all)); return { acknowledged: true }; }
      const { data, error } = await supa.rpc("ack_calendar_conflict", { p_quote_id: quoteId, p_key: key, p_note: note || null });
      if (error) throw error; return data;
    },
    async unack(quoteId, key) {
      if (mode !== "supabase" || !supa) { const all = ackLs(); delete all[key];
        localStorage.setItem("bp_conflict_acks", JSON.stringify(all)); return { acknowledged: false }; }
      const { data, error } = await supa.rpc("unack_calendar_conflict", { p_quote_id: quoteId, p_key: key });
      if (error) throw error; return data;
    },
    // Phase 49 — predictive pre-commit check: would assigning this crew / vendor on this
    // event's date collide with another event on the same day? (light, targeted queries)
    async wouldClash({ date, crewId, vendorId, excludeQuote } = {}) {
      if (!date || mode !== "supabase" || !supa) return { clash: false };
      const events = await quotes.list();
      // 0198: a cancelled / closed / archived event on that day holds nobody - never a clash
      const sameDay = events.filter((e) => calEvLive(e) && e.eventDate === date && e.id !== excludeQuote);
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
    // 0132 — does this event have a team chat group (and am I in it)? best-effort: {has_group:false} when not installed
    async groupStatus(quoteId) {
      if (mode !== "supabase") return { has_group: false, member: false };
      const { data, error } = await supa.rpc("runsheet_group_status", { p_quote: quoteId });
      if (error) return { has_group: false, member: false };
      return { has_group: !!(data && data.has_group), member: !!(data && data.member) };
    },
    // 0132 — post "<who> added '<activity>' at <time> -> @<owner>" into the event's own group
    async postToGroup(itemId, action) {
      if (mode !== "supabase") return "no_group";
      const { data, error } = await supa.rpc("runsheet_post_to_group", { p_item: itemId, p_action: action === "updated" ? "updated" : "added" });
      if (error) throw error; return data;
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
    // 0196: are the budget-planning columns (requirement_key / priority / quoted / vendor_id) installed?
    // A 0-row read of those columns, cached once it says yes. Local mode always has them.
    async planReady() {
      if (mode !== "supabase") return true;
      if (this._planReady) return true;
      const { error } = await supa.from("event_costs").select("id,requirement_key,priority,quoted,vendor_id").limit(0);
      if (error) return false;
      this._planReady = true; return true;
    },
    // 0196: add budget lines made from requirements / standard lines. Lines are only ever ADDED:
    // a row whose requirement_key the event already has is skipped (unique index 23505 / local check),
    // so a reload, a second click or two open tabs never duplicate a line. Returns how many were added.
    async addPlanLines(quoteId, rows) {
      let added = 0;
      for (const r of rows || []) {
        if (!r || !r.requirement_key) continue;   // keyed rows only - never an un-deduplicable insert
        if (mode !== "supabase" && readLs(COST_LS).some((c) => c.quote_id === quoteId && c.requirement_key === r.requirement_key)) continue;
        try { await this.addCost(quoteId, r); added++; }
        catch (e) { if (e && e.code === "23505") continue; throw e; }
      }
      return added;
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
    // money-1024: { quoteId: sum of APPROVED change-order price deltas } for many events in one
    // read - lets list views show the same invoice total as the workspace / settlement (summary()).
    async approvedChangeTotals(quoteIds) {
      const ids = Array.from(new Set((quoteIds || []).filter(Boolean).map(String))).slice(0, 500);
      const out = {}; if (!ids.length) return out;
      let rows;
      if (mode === "supabase") {
        const { data, error } = await supa.from("change_requests").select("quote_id,price_delta").in("quote_id", ids).eq("status", "approved");
        if (error) throw error; rows = data || [];
      } else rows = readLs(CHG_LS).filter((c) => c.status === "approved" && ids.indexOf(String(c.quote_id)) >= 0);
      rows.forEach((c) => { const d = Number(c.price_delta || 0); if (Number.isFinite(d) && d) out[c.quote_id] = (out[c.quote_id] || 0) + d; });
      return out;
    },
    // qts-1018: { quoteId: invoice total } for list rows (each row carries its server-stamped
    // total) - BPStore.invoiceTotal over the same approved change orders summary() counts.
    // Fail-soft: an unreadable change-order table gives the base totals (same on every screen).
    async invoiceTotals(rows) {
      const list = (rows || []).filter((r) => r && r.id); const out = {}; if (!list.length) return out;
      let ch = {}; try { ch = (await this.approvedChangeTotals(list.map((r) => r.id))) || {}; } catch (_) { ch = {}; }
      list.forEach((r) => { out[r.id] = BPStore.invoiceTotal(r, ch[r.id]); });
      return out;
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
      const revenue = Number(baseRevenue) + changeRevenue;   // what the client pays (incl. tax) - balances use this
      // E13: GST / VAT / sales tax collected is payable to the government, not studio income -
      // margins are on the ex-tax revenue (same rule as insights_range *_ex_tax, 0101)
      const baseTax = BPStore.quoteTaxAmount(ev && ev.pricing, baseRevenue);
      // dev pass 3: a change order's price_delta is what the CLIENT pays (incl. tax, same rule as
      // the server overpay cap / booklet / insights). Its tax share is split out at the quote's
      // own rate so GST on change orders is never understated.
      const taxRate = (baseTax > 0 && Number(baseRevenue) - baseTax > 0) ? baseTax / (Number(baseRevenue) - baseTax) : 0;
      const changeTax = Math.round(changeRevenue * taxRate / (1 + taxRate) * 100) / 100;
      const tax = Math.round((baseTax + changeTax) * 100) / 100;
      const changeRevenueExTax = Math.round((changeRevenue - changeTax) * 100) / 100;
      const revenueExTax = Math.round((revenue - tax) * 100) / 100;
      const estMargin = revenueExTax - estCost, actMargin = revenueExTax - actCost, finalMargin = revenueExTax - finalCost;
      return { revenue, revenueExTax, tax, taxRate, changeTax, changeRevenueExTax, baseRevenue, changeRevenue, estCost, actCost, finalCost, changeCost, vendorExtra,
        estMargin, actMargin, finalMargin,
        estMarginPct: revenueExTax ? Math.round(estMargin / revenueExTax * 100) : null,
        finalMarginPct: revenueExTax ? Math.round(finalMargin / revenueExTax * 100) : null,
        costs, changes, pendingChanges: changes.filter((c) => c.status === "requested").length,
        // additive flag: the quote has no priced total (missing or 0) - revenue above still reads 0 as before
        pricingMissing: !(Number(baseRevenue) > 0) };
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
      if (mode === "supabase") { const { data, error } = await supa.from("payment_milestones").update(patch).eq("id", id).select("id"); if (error) throw error;
        // retest2-1017: RLS/locks can silently match 0 rows (e.g. a paid milestone) - report it, never fake success
        if (!data || !data.length) { const e = new Error("This milestone could not be changed (it may already be paid and locked)."); e.code = "HELM_NOCHANGE"; throw e; }
        return true; }
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
  // 0197 over-capacity: a venue holds seated + floating guests (40,000 + 10,000 = 50,000). Over it, the
  // quote needs a decision; "proceed" covers up to the guests it was recorded for, "extend" up to
  // capacity + the extra space, both only for the venue they were recorded for.
  function capacityStatus(q, venue, guestsOverride) {
    const c = (q && q.client) || {};
    const g = Math.round(Number(guestsOverride != null && guestsOverride !== "" ? guestsOverride : c.guests) || 0);
    if (!venue || !(g > 0)) return { over: false, guests: g };
    const seat = Math.max(0, Math.round(Number(venue.seated_capacity) || 0)), flt = Math.max(0, Math.round(Number(venue.floating_capacity) || 0));
    const total = seat + flt;
    if (!(total > 0) || g <= total) return { over: false, guests: g, seated: seat, floating: flt, total, venue };
    const d = (q && q.capacityDecision) || null;
    const same = !!d && String(d.venue_id || "") === String(venue.id || "");
    const resolved = same && (d.choice === "proceed" ? g <= Number(d.guests || 0)
      : d.choice === "extend" ? g <= total + Number(d.extra_capacity || 0) : false);
    return { over: true, guests: g, seated: seat, floating: flt, total, short: g - total, venue, decision: d, resolved };
  }
  // 0197 "Short: 10 x Air Cooler / Fan - sourcing from Cool Rentals (enquiry)" / "- outsource / buy" / "- unsourced"
  function shortageText(r, o) {
    o = o || {};
    const qty = Number(r && r.qty) || 0;
    const name = o.itemName || String((r && r.label) || "").replace(/^Short:\s*\d+(\.\d+)?\s*[x\u00d7]\s*/i, "") || "item";
    const head = "Short: " + qty.toLocaleString("en-IN") + " \u00d7 " + name;
    if (r && r.source === "vendor") return head + " \u2014 sourcing from " + (o.vendorName || "a vendor") + (o.bookingStatus ? " (" + o.bookingStatus + ")" : "");
    if (r && r.source === "buy") return head + " \u2014 outsource / buy";
    return head + " \u2014 unsourced";
  }
  // r20 coord (b): ONE "advance is in" rule for every screen - the same truth the status label
  // ("Confirmed · advance paid") uses: the client paid (approval_status "paid"), or a payment
  // milestone is paid, or the payments ledger has a paid receipt, or settlement received > 0.
  // Every input is optional: a role without finance may not be able to read milestones or the
  // ledger, so a missing / denied read simply counts as "no evidence", never an error.
  function advanceIn(ev, o) {
    o = o || {};
    if (ev && String(ev.approvalStatus || ev.approval_status || "") === "paid") return true;
    if ((o.milestones || []).some((m) => m && m.status === "paid")) return true;
    if ((o.payments || []).some((p) => p && p.status === "paid" && Number(p.amount || 0) > 0)) return true;
    if (o.settlement && Number(o.settlement.received) > 0) return true;
    return false;
  }
  // r20 coord (b): a quote whose venue is typed by name ("Demo · Green Meadows Lawn") but not linked
  // to a saved venue: match a saved venue by name - case / space-insensitive, tolerating the trial
  // "Demo · " and old seed "SAMPLE - " prefixes on either side. Only an unambiguous match counts.
  function venueNameKey(n, keepPrefix) {
    let s = String(n == null ? "" : n).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    if (!keepPrefix) s = s.replace(/^(demo|sample)\s*[\u00b7\u2022:\-\u2013\u2014]\s*/, "").trim();
    return s;
  }
  function venueForQuote(ev, list) {
    const c = (ev && ev.client) || {}; list = (list || []).filter(Boolean);
    if (c.venueId) { const byId = list.find((v) => v.id === c.venueId); if (byId) return byId; }
    const want = venueNameKey(c.venue);
    if (!want) return null;
    const exact = list.filter((v) => venueNameKey(v.name, true) === venueNameKey(c.venue, true));
    if (exact.length === 1) return exact[0];
    const loose = list.filter((v) => venueNameKey(v.name) === want);
    if (loose.length === 1) return loose[0];
    const live = loose.filter((v) => v.active !== false);
    return live.length === 1 ? live[0] : null;
  }
  const readiness = {
    async check(quoteId) {
      // r20 coord (b): money truth (milestones / ledger) only for a role that can see finance - for the
      // rest those reads are RLS-blocked (and read as "not yet"), so they get the quote's own status.
      const canFin = await Promise.resolve().then(() => auth.canView("finance")).then((v) => v === true, () => false);
      const [ev, planRow, resCheck, bk, tasks, ms, rs] = await Promise.all([
        quotes.get(quoteId),
        plan.get(quoteId).catch(() => null),
        resources.check(quoteId).catch(() => []),
        bookings.list(quoteId).catch(() => []),
        (async () => { if (mode !== "supabase") return [];
          const { data, error } = await supa.from("event_tasks").select("crew_id").eq("quote_id", quoteId).not("crew_id", "is", null);
          if (error) throw error; return data; })().catch(() => []),
        canFin ? milestones.list(quoteId).catch(() => []) : Promise.resolve([]),
        runsheet.list(quoteId).catch(() => []),
      ]);
      // r20: a locked menu only counts when it HOLDS something (dishes, a package or menu notes) - never an empty lock.
      // The package is read from the same places the builder reads it (plan.menu_template, else pricing._packageName).
      const pkgName = String((planRow && (planRow.package || planRow.menu_template)) || (ev && ev.pricing && ev.pricing._packageName) || "").trim();
      const menuLocked = !!(planRow && planRow.menu_locked);
      // 0197: stock shortages + guests vs the linked venue
      const [shorts, items, vlist, dishes] = await Promise.all([
        inventory.shortages(quoteId).catch(() => []),
        inventory.items(true).catch(() => []),
        (ev && ev.client && (ev.client.venueId || String(ev.client.venue || "").trim())) ? venues.list({ all: true }).catch(() => []) : Promise.resolve([]),
        eventMenu.list(quoteId).catch(() => null),
      ]);
      const menuHas = (Array.isArray(dishes) && dishes.length > 0) || !!pkgName || !!String((planRow && planRow.menu) || "").trim();
      // r20 coord (b): the linked venue, else a saved venue matching the typed venue name ("Demo · Green Meadows Lawn")
      const capVenue = venueForQuote(ev, vlist);
      const cap = capacityStatus(ev, capVenue);
      const capUnchecked = !cap.over && !(cap.total > 0 && cap.guests > 0);
      const capWhy = !capVenue ? "not checked - no saved venue linked" : !(cap.guests > 0) ? "not checked - no guest count yet" : "not checked - the venue has no capacity saved";
      const itemName = (id) => ((items || []).find((i) => i.id === id) || {}).name;
      const vend = (shorts || []).some((r) => r.vendor_id) ? await vendors.listAll(true).catch(() => []) : [];
      const shortLines = (shorts || []).map((r) => { const b = bk.find((x) => x.id === r.booking_id), v = (vend || []).find((x) => x.id === r.vendor_id);
        return shortageText(r, { itemName: itemName(r.item_id), bookingStatus: b && b.status, vendorName: v && v.name }); });
      const unsourced = (shorts || []).filter((r) => r.source !== "vendor" && r.source !== "buy").length;
      const gaps = resCheck.filter((c) => !c.covered).length;
      const enquiry = bk.filter((b) => b.status === "enquiry").length;
      const crew = new Set(tasks.map((t) => t.crew_id)).size;
      // ledger receipts only when the milestones don't already show it (a role without finance gets [])
      const pays = (canFin && ev && String(ev.approvalStatus || "") !== "paid" && !ms.some((m) => m && m.status === "paid"))
        ? await milestones.payments(quoteId).catch(() => []) : [];
      const paid = advanceIn(ev, { milestones: ms, payments: pays });
      const checks = [
        { key: "date", label: "Event date set", critical: true, ok: !!ev.eventDate, detail: ev.eventDate || "not set" },
        { key: "approval", label: "Client approved", critical: true, ok: ["approved", "paid"].includes(ev.approvalStatus), detail: ev.approvalStatus || "none" },
        { key: "menu", label: "Menu & package locked", critical: true, ok: menuLocked && menuHas,
          detail: menuLocked ? (menuHas ? "locked" + (pkgName ? " - " + pkgName : "") : "locked, but no package or dishes yet") : "not locked" },
        { key: "resources", label: "Resources covered (no gaps)", critical: true, ok: resCheck.length > 0 && gaps === 0, detail: resCheck.length === 0 ? "no needs mapped yet" : (gaps ? (gaps + " gap" + (gaps === 1 ? "" : "s")) : "all covered") },
        { key: "vendors", label: "Vendors confirmed", critical: true, ok: enquiry === 0 && (bk.length > 0 || resCheck.length > 0), detail: enquiry ? (enquiry + " still enquiry") : (bk.length ? "all confirmed" : (resCheck.length ? "in-house — none needed" : "nothing planned")) },
        { key: "staff", label: "Staff assigned", critical: true, ok: crew > 0, detail: crew ? (crew + " assigned") : "none" },
        { key: "runsheet", label: "Run-sheet built", critical: true, ok: rs.length > 0, detail: rs.length ? (rs.length + " items") : "empty" },
        // r20: no saved venue (or no capacity / guest count) = NOT CHECKED - a warning, never counted as passed
        { key: "capacity", label: "Guests fit the venue", critical: !capUnchecked, unchecked: capUnchecked || undefined, ok: !capUnchecked && (!cap.over || cap.resolved),
          detail: !cap.over ? (capUnchecked ? capWhy : cap.guests.toLocaleString("en-IN") + " of " + cap.total.toLocaleString("en-IN"))
            : cap.resolved ? (cap.decision.choice === "extend" ? "extended: +" + Number(cap.decision.extra_capacity || 0).toLocaleString("en-IN") + " space" : "proceeding anyway (noted)")
            : cap.short.toLocaleString("en-IN") + " guests won't fit - decide in the quote" },
        { key: "stock", label: "Stock sourced (no shortages left open)", critical: true, ok: unsourced === 0,
          detail: shortLines.length ? shortLines.join("; ") : "no shortages" },
        // no "Fix" link without finance: the payments tab it points at is hidden for that role
        { key: "payments", label: "Advance received", critical: false, ok: paid, detail: paid ? "yes" : "not yet", noFix: !canFin },
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

  // Status gate shared by refunds + expense claims: only an APPROVED row may be paid / processed.
  async function needApproved(table, lsKey, id, msg) {
    let st = null;
    if (mode === "supabase") { const { data, error } = await supa.from(table).select("status").eq("id", id).maybeSingle(); if (error) throw error; st = data && data.status; }
    else { const r = readLs(lsKey).find((x) => x.id === id); st = r && r.status; }
    if (st !== "approved") { const e = new Error(msg); e.userMessage = msg; e.code = "HL409"; throw e; }
  }
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
      // dev pass 3: approve, then process - a pending entry can't jump straight to processed
      if (status === "processed") await needApproved("event_refunds", REFUND_LS, id, "Approve this entry before marking it done.");
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
      if (status === "paid") await needApproved("expense_claims", EXP_LS, id, "Approve this claim before marking it paid.");
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
      const [b, ms, bk, exp, pays, refs] = await Promise.all([
        budget.summary(quoteId), milestones.list(quoteId), bookings.list(quoteId), expenses.list(quoteId),
        milestones.payments(quoteId).catch(() => []), refunds.list(quoteId).catch(() => []),
      ]);
      // "Received" = money actually collected, summed from the quote_payments LEDGER —
      // the single source of truth that holds EVERY receipt (both the advance and any
      // settlement/cash payment). The old code summed milestone STATUS, so a recorded
      // settlement payment (which writes quote_payments with no milestone) never counted,
      // leaving Balance due overstated. Fall back to paid milestones only if the ledger
      // is unavailable.
      const fromLedger = (pays || []).filter((p) => p.status === "paid").reduce((a, p) => a + Number(p.amount || 0), 0);
      const fromMilestones = ms.filter((m) => m.status === "paid").reduce((a, m) => a + Number(m.amount || 0), 0);
      const gross = (pays && pays.length) ? fromLedger : fromMilestones;
      // dev pass 3: a PROCESSED refund to the client is money given back - net it off Received
      // (so Balance due goes back up). Pending / approved refunds are only "Refunds due".
      const refundedOut = (refs || []).filter((r) => r.kind === "refund" && r.status === "processed").reduce((a, r) => a + Number(r.amount || 0), 0);
      const received = Math.round((gross - refundedOut) * 100) / 100;
      // retest-1018: what the CLIENT owes is total - everything they paid (gross). A processed
      // refund is money we gave back, it never creates a new debt - same rule as the server
      // close gate (closure.blockers: paid = ledger receipts). Received above stays net.
      const revenue = b.revenue, balance = Math.round((revenue - gross) * 100) / 100;   // the client's balance includes tax
      const vend = bk.filter((x) => x.status !== "cancelled");
      const vendorCost = vend.reduce((a, x) => a + Number(x.cost || 0), 0);
      const vendorAdvance = vend.reduce((a, x) => a + Number(x.advance || 0), 0);
      const vendorOutstanding = vend.filter((x) => !x.settled).reduce((a, x) => a + Math.max(0, Number(x.cost || 0) - Number(x.advance || 0)), 0);
      const expTotal = exp.reduce((a, e) => a + Number(e.amount || 0), 0);
      const expPaid = exp.filter((e) => e.status === "paid").reduce((a, e) => a + Number(e.amount || 0), 0);
      return { revenue, revenueExTax: b.revenueExTax != null ? b.revenueExTax : revenue, tax: b.tax || 0, received, balance, pricingMissing: !!b.pricingMissing, estCost: b.estCost, actCost: b.actCost, finalCost: b.finalCost,
        estMargin: b.estMargin, actMargin: b.actMargin, finalMargin: b.finalMargin,
        milestones: ms, bookings: vend, expenses: exp, vendorCost, vendorAdvance, vendorOutstanding, expTotal, expPaid, receivedGross: gross, refundedOut };
    },
    // Vendor bills overlay (one rule, shared by Settlement + the event workspace): per booking
    // cost = bills total if bills else booked cost; paid = advance + payouts; owed = max(cost - paid, 0).
    // Rewrites sum.vendorOutstanding + per-booking _cost/_paid/_out/_billed and shifts finalMargin by
    // the bills delta (vendorBills.calc). Returns the delta so other profit figures can apply it too.
    // A failed bills read leaves the summary untouched (delta 0).
    async applyBills(sum, quoteId, preBills) {
      let bills = preBills;
      if (!bills) { try { bills = (await vendorBills.list(quoteId)) || []; } catch (_) { return 0; } }
      const st = vendorSettle(sum.bookings || [], bills).byBooking;
      let out = 0;
      (sum.bookings || []).forEach((b) => { const r = st[b.id]; if (!r) return;
        b._out = r.owed; b._billed = r.billed; b._cost = r.cost; b._paid = r.paid; if (!b.settled) out += r.owed; });
      sum.vendorOutstanding = Math.round(out * 100) / 100;
      if (!bills.some((b) => b && b.status !== "void")) return 0;
      let costs = []; try { costs = (await budget.listCosts(quoteId)) || []; } catch (_) { return 0; }
      const base = { bookings: sum.bookings || [], costs };
      const delta = vendorPnlCalc(Object.assign({ bills: [] }, base)).vendors - vendorPnlCalc(Object.assign({ bills }, base)).vendors;
      sum.finalMargin = Math.round((Number(sum.finalMargin || 0) + delta) * 100) / 100;
      return delta;
    },
    // Shift a budget summary's estimated cost/margin by the vendor-bills delta so the Budget
    // page + workspace Budget card show the same margin as Settlement / Closure once a bill
    // replaces a booking's cost. delta = booked cost - billed cost (0 when there are no bills).
    applyBillsToBudget(bs, delta) {
      if (!bs || !delta) return bs;
      const r2 = (n) => Math.round(n * 100) / 100;
      bs.estCost = r2(Number(bs.estCost || 0) - delta); bs.estMargin = r2(Number(bs.estMargin || 0) + delta);
      const rx = bs.revenueExTax != null ? bs.revenueExTax : bs.revenue;
      bs.estMarginPct = rx ? Math.round(bs.estMargin / rx * 100) : null;
      return bs;
    },
    async billsDelta(quoteId) {
      let bk = []; try { bk = ((await bookings.list(quoteId)) || []).filter((x) => x.status !== "cancelled"); } catch (_) { return 0; }
      if (!bk.length) return 0;
      try { return await this.applyBills({ bookings: bk, finalMargin: 0 }, quoteId); } catch (_) { return 0; }
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
    // 0049: the server refuses to close while the ledger balance is owed or equipment is
    // still checked out. blockers() shows why up front; an admin may pass an override reason
    // (required, audited server-side).
    async blockers(quoteId) {
      if (mode !== "supabase") return null;
      try { return await rpc("close_event_blockers", { p_quote_id: quoteId }); }
      catch (e) { if (rpcMissing(e)) return null; throw e; }
    },
    async setClosed(quoteId, closed, overrideReason) {
      if (mode === "supabase") {
        const reason = overrideReason == null ? "" : String(overrideReason).trim();
        if (closed && reason) return rpc("close_event", { p_quote_id: quoteId, p_closed: true, p_override_reason: reason });
        // 0156: re-opening is admin-only and needs a reason - it goes through reopen() / reopen_event
        if (!closed) throw new Error("Only an admin can re-open a closed event - use Re-open and give a reason.");
        return rpc("close_event", { p_quote_id: quoteId, p_closed: true });
      }
      const a = readLs(CLOSE_LS); let row = a.find((x) => x.quote_id === quoteId);
      if (!row) { row = { quote_id: quoteId }; a.push(row); }
      row.closed_at = closed ? now() : null; localStorage.setItem(CLOSE_LS, JSON.stringify(a));
      try { await lsq.setStage(quoteId, closed ? "closed" : "settlement"); } catch {}
      return row;
    },
    // r7 (0084): an admin re-opens a closed event (back to settlement). Reason required + audited;
    // nothing is deleted - payments, ledger and costs stay as they are.
    async reopen(quoteId, reason) {
      const r = String(reason == null ? "" : reason).trim();
      if (r.length < 5) throw new Error("Give a reason of at least 5 characters.");
      if (mode === "supabase") return rpc("reopen_event", { p_quote_id: quoteId, p_reason: r });
      return this.setClosed(quoteId, false);
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
      // E13: revenue is EX-TAX; the tax collected is shown separately (payable), margin on ex-tax revenue
      const rev = s.revenueExTax != null ? s.revenueExTax : s.revenue, tax = s.tax || 0;
      // retest2-1017: a PROCESSED refund is money given back, so it reduces profit (matches
      // settlement net profit, closure P&L, event_pnl and the Business page)
      const refunds = Number(s.refundedOut || 0);
      let profit = rev - cost - s.expPaid - refunds, costOut = cost, billsIncluded = false;
      // retest-1018: the server event_pnl (vendor bills + payouts) is the one profit every other page
      // shows - use it when installed so this P&L never disagrees with Settlement / Business
      try {
        const v = await vendorBills.pnl(quoteId);
        if (v && v.source === "server" && Number.isFinite(Number(v.net_profit))) {
          profit = Number(v.net_profit); costOut = Number(v.vendors || 0) + Number(v.other || 0);
          billsIncluded = true;   // manager-1019: vendor bills are already in this profit - callers must not add the bills delta again
        }
      } catch (_) { /* fall back to the settlement maths */ }
      return { revenue: rev, gross: s.revenue, tax, cost: costOut, expenses: s.expPaid, refunds, profit, billsIncluded,
        marginPct: rev ? Math.round(profit / rev * 100) : null, estCost: s.estCost, actCost: s.actCost, finalCost: s.finalCost };
    },
  };

  /* ---------------- Phase C (0124): vendor bills, payouts & per-event net profit ----------------
     Bills are never deleted (void with a reason); payouts go through record_vendor_payout, which is
     idempotent and refuses overpaying. P&L: Revenue (ex-tax) - Vendors - Logistics/Other - Staff
     expenses = Net profit. Vendor cost has ONE source per booking: its bills if it has any, else its
     imported cost line, else the booking cost (no double count). Pure helpers are unit-tested in
     test/vendor-bills.test.mjs and mirror the SQL _vb_event_pnl. */
  const vbNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const vbLineVal = (c) => (c && c.actual != null && c.actual !== "") ? vbNum(c.actual) : vbNum(c && c.estimated);
  function vendorPnlCalc(o) {
    o = o || {};
    const bookings = (o.bookings || []).filter((b) => b && b.status !== "cancelled");
    const active = new Set(bookings.map((b) => b.id));
    const bills = (o.bills || []).filter((b) => b && b.status !== "void");
    const costs = o.costs || [];
    let vendors = 0;
    for (const b of bookings) {
      const bb = bills.filter((x) => x.booking_id === b.id);
      const lines = costs.filter((c) => c.booking_id === b.id);
      vendors += bb.length ? bb.reduce((a, x) => a + vbNum(x.amount), 0)
        : lines.length ? lines.reduce((a, c) => a + vbLineVal(c), 0) : vbNum(b.cost);
    }
    // AUD-1017: spend not tied to an active booking has ONE source too. Unlinked bills and
    // unlinked "Vendor" cost lines usually record the same spend twice (a cost line typed in on
    // Budget + the vendor's bill), so the larger of the two counts - never both. Mirrors 0146.
    const looseBills = bills.filter((x) => !active.has(x.booking_id)).reduce((a, x) => a + vbNum(x.amount), 0);
    const looseLines = costs.filter((c) => c.kind === "vendor" && !active.has(c.booking_id)).reduce((a, c) => a + vbLineVal(c), 0);
    vendors += Math.max(looseBills, looseLines);
    const other = costs.filter((c) => c.kind !== "vendor" && !active.has(c.booking_id)).reduce((a, c) => a + vbLineVal(c), 0) + vbNum(o.changeCost);
    const staff = vbNum(o.staff), revenue = vbNum(o.revenue);
    // AUD-1017: money handed back to the client (processed refunds) comes off profit
    const refunds = (o.refunds || []).filter((r) => r && (r.kind || "refund") === "refund" && r.status === "processed")
      .reduce((a, r) => a + vbNum(r.amount), 0);
    const r2 = (n) => Math.round(n * 100) / 100;
    const net = r2(revenue - vendors - other - staff - refunds);
    return { revenue: r2(revenue), vendors: r2(vendors), other: r2(other), staff: r2(staff), refunds: r2(refunds), net_profit: net,
      margin_pct: revenue ? Math.round(net / revenue * 100) : null };
  }
  // paid / part / unpaid / overdue / void for one bill (today = "YYYY-MM-DD")
  function vendorBillState(bill, today) {
    if (!bill) return "unpaid";
    if (bill.status === "void") return "void";
    const paid = (bill.vendor_payouts || []).reduce((a, p) => a + vbNum(p.amount), 0);
    if (paid >= vbNum(bill.amount) - 0.005) return "paid";
    const t = today || new Date().toISOString().slice(0, 10);
    if (bill.due_date && String(bill.due_date) < t) return "overdue";
    return paid > 0 ? "part" : "unpaid";
  }
  // One vendor rule shared by Settlement's vendor table, the Vendor bills card and the event
  // workspace: per booking cost = bills total if bills else booked cost (vendorPnlCalc);
  // paid = booking advance + payouts; owed = max(cost - paid, 0). The advance is credited to
  // that booking's bills oldest-first, so per-bill paid/unpaid adds up to the booking's owed.
  function vendorSettle(bookingsIn, billsIn, today) {
    const r2 = (n) => Math.round(n * 100) / 100;
    const bills = (billsIn || []).filter((b) => b && b.status !== "void");
    const payOf = (b) => (b.vendor_payouts || []).reduce((a, p) => a + vbNum(p.amount), 0);
    const byBooking = {}, byBill = {};
    for (const b of (bookingsIn || [])) {
      if (!b) continue;
      const own = bills.filter((x) => x.booking_id === b.id);
      const cost = own.length ? vendorPnlCalc({ bookings: [Object.assign({}, b, { status: "confirmed" })], bills: own }).vendors : vbNum(b.cost);
      const advance = vbNum(b.advance), payouts = r2(own.reduce((a, x) => a + payOf(x), 0));
      const paid = r2(advance + payouts);
      byBooking[b.id] = { cost: r2(cost), advance: r2(advance), payouts, paid, owed: r2(Math.max(0, cost - paid)), billed: own.length > 0 };
      let credit = advance;
      own.slice().sort((x, y) => String(x.bill_date || "").localeCompare(String(y.bill_date || "")) || String(x.created_at || "").localeCompare(String(y.created_at || "")))
        .forEach((x) => { const po = payOf(x), gap = Math.max(0, vbNum(x.amount) - po), use = Math.min(gap, credit); credit -= use;
          byBill[x.id] = { advance: r2(use), payouts: r2(po) }; });
    }
    for (const x of (billsIn || [])) {
      if (!x) continue;
      const e = byBill[x.id] || (byBill[x.id] = { advance: 0, payouts: r2(payOf(x)) });
      e.paid = r2(e.advance + e.payouts); e.left = r2(Math.max(0, vbNum(x.amount) - e.paid));
      e.state = x.status === "void" ? "void" : e.left <= 0.005 ? "paid" : vendorBillState(Object.assign({}, x, { vendor_payouts: [{ amount: e.paid }] }), today);
    }
    return { byBooking, byBill };
  }
  const vbTableMissing = (e) => { const c = (e && e.code) || ""; const m = String((e && e.message) || "");
    return c === "42P01" || c === "PGRST205" || /relation .*vendor_(bills|payouts).* does not exist|could not find the table/i.test(m); };
  // r21 money (0246): the GST part of a bill - empty = unknown; must be 0 or more and below the bill amount
  function vbGstPart(v, amount) {
    if (v === null || v === undefined || String(v).trim() === "") return { value: null };
    const n = Number(v); const a = Number(amount);
    if (!Number.isFinite(n) || n < 0) return { error: "Enter the GST as an amount of 0 or more (or leave it empty)." };
    if (Number.isFinite(a) && n >= a) return { error: "The GST must be less than the bill amount (the amount includes the GST)." };
    return { value: Math.round(n * 100) / 100 };
  }
  const vbGstColMissing = (e) => { const c = (e && e.code) || ""; const m = String((e && e.message) || "");
    return c === "PGRST204" || c === "42703" || /gst_(amount|claimable)/i.test(m); };
  const vbMissingErr = () => { const er = new Error("Vendor bills need database update 0124 (ask your admin to run APPLY-0124.sql)."); er.code = "vendor_bills_missing"; return er; };
  const vendorBills = {
    calc: vendorPnlCalc, state: vendorBillState, settle: vendorSettle, gstPart: vbGstPart,
    async list(quoteId) {
      if (mode !== "supabase") return [];
      const { data, error } = await supa.from("vendor_bills").select("*, vendor_payouts(*)").eq("quote_id", quoteId).order("bill_date", { ascending: false });
      if (error) { if (vbTableMissing(error)) throw vbMissingErr(); throw error; }
      return data || [];
    },
    // b: { amount, bill_no, bill_date, due_date, description, vendor_id, booking_id, currency }; file optional (photo/PDF -> event-docs)
    async add(quoteId, b, file) {
      if (mode !== "supabase") throw new Error("Vendor bills need the online database.");
      const amt = Number(b && b.amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter the bill amount (above zero).");
      let fileId = null;
      if (file) { const row = await files.upload(quoteId, file); fileId = row && row.id; }
      const clean = (v, n) => { const t = String(v == null ? "" : v).trim(); return t ? t.slice(0, n) : null; };
      const day = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null;
      const row = { quote_id: quoteId, amount: Math.round(amt * 100) / 100, bill_no: clean(b.bill_no, 80),
        description: clean(b.description, 500), bill_date: day(b.bill_date) || new Date().toISOString().slice(0, 10),
        due_date: day(b.due_date), vendor_id: b.vendor_id || null, booking_id: b.booking_id || null, file_id: fileId };
      if (b.currency) row.currency = String(b.currency).slice(0, 3).toUpperCase();
      // r21 money (0246): optional GST inside the bill amount + whether the input credit can be claimed
      const gst = vbGstPart(b.gst_amount, row.amount);
      if (gst.error) throw new Error(gst.error);
      if (gst.value != null) { row.gst_amount = gst.value; if (typeof b.gst_claimable === "boolean") row.gst_claimable = b.gst_claimable; }
      let { data, error } = await supa.from("vendor_bills").insert(row).select().single();
      if (error && gst.value != null && vbGstColMissing(error)) {
        // database without 0246: keep the bill, drop only the GST split (it is optional)
        delete row.gst_amount; delete row.gst_claimable;
        ({ data, error } = await supa.from("vendor_bills").insert(row).select().single());
        if (!error && data) data.gst_dropped = true;
      }
      if (error) { if (vbTableMissing(error)) throw vbMissingErr(); throw error; }
      return data;
    },
    async void(id, reason) {
      const r = String(reason == null ? "" : reason).trim();
      if (r.length < 3) throw new Error("Give a reason (at least 3 characters).");
      const { error } = await supa.from("vendor_bills").update({ status: "void", void_reason: r.slice(0, 300) }).eq("id", id);
      if (error) throw error; return true;
    },
    async pay(billId, amount, paidOn, method, reference, key) {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter an amount above zero.");
      try {
        return await rpc("record_vendor_payout", { p_bill: billId, p_amount: Math.round(amt * 100) / 100, p_paid_on: paidOn || null,
          p_method: method || null, p_reference: reference || null, p_idempotency_key: key || null });
      } catch (e) { if (rpcMissing(e)) throw vbMissingErr(); throw e; }
    },
    // per-event P&L: server event_pnl when installed, else the same maths on the client (no bills)
    async pnl(quoteId) {
      if (mode === "supabase") {
        try { const r = await rpc("event_pnl", { p_quote: quoteId }); if (r) return Object.assign({ source: "server" }, r); }
        catch (e) { if (!rpcMissing(e)) throw e; }
      }
      const [b, bk, costs, exp, refs] = await Promise.all([budget.summary(quoteId), bookings.list(quoteId).catch(() => []),
        budget.listCosts(quoteId).catch(() => []), expenses.list(quoteId).catch(() => []), refunds.list(quoteId).catch(() => [])]);
      const staff = (exp || []).filter((e) => e.status === "paid").reduce((a, e) => a + vbNum(e.amount), 0);
      return Object.assign({ source: "client", missing0124: mode === "supabase" }, vendorPnlCalc({
        revenue: b.revenueExTax != null ? b.revenueExTax : b.revenue, bookings: bk, costs, bills: [], changeCost: b.changeCost, staff, refunds: refs }));
    },
    async payables() {
      if (mode !== "supabase") return null;
      try { return await rpc("vendor_payables_summary", {}); } catch (e) { if (rpcMissing(e)) return null; throw e; }
    },
    async business(from, to) {
      if (mode !== "supabase") return null;
      try { return await rpc("business_pnl", { p_from: from || null, p_to: to || null }); } catch (e) { if (rpcMissing(e)) return null; throw e; }
    },
  };

  /* ---------------- r21 money (0246): event cost ledger (Estimated / Committed / Actual) ----------------
     One server calculation: event_cost_breakdown(quote) = P&L (estimated / expected / actual margin +
     accuracy %), per-category variance, cost lines and warnings; studio_cost_breakdown(from, to) = the same
     per confirmed event + totals per currency (Insights / Business). null = database without 0246 (callers
     keep their older cards). Pure helpers are unit-tested in test/r21-money.test.mjs. */
  const ML_CATS = [["venue", "Venue"], ["food", "Food & catering"], ["decor", "Décor & flowers"], ["rentals", "Rentals & equipment"],
    ["vendors", "Other vendors"], ["staff", "Staff & crew wages"], ["misc", "Misc, petty cash & staff expenses"],
    ["logistics", "Logistics & transport"], ["damages", "Damages & loss"], ["changes", "Change orders"], ["contingency", "Contingency (plan only)"]];
  const mlCatLabel = (k) => { const f = ML_CATS.find((c) => c[0] === k); return f ? f[1] : String(k || "Other"); };
  // flag a category row (plan section 3.6): "over" = above the plan by more than pct % OR more than abs
  // (defaults 10 % / 10,000); a smaller overrun is "watch"; spend with no plan at all is "new"
  function mlVarianceFlag(row, o) {
    o = o || {}; const pct = o.pct != null ? Number(o.pct) : 10, abs = o.abs != null ? Number(o.abs) : 10000;
    const est = vbNum(row && row.estimated), v = vbNum(row && row.variance);
    if (v <= 0) return v < 0 ? "under" : "";
    if (est <= 0) return v > abs ? "over" : "new";
    return (v / est * 100 > pct || v > abs) ? "over" : "watch";
  }
  // the stage a line has reached: actual > committed > estimated
  function mlStage(line) {
    if (!line) return "estimated";
    if (line.actual !== null && line.actual !== undefined) return "actual";
    if (line.committed !== null && line.committed !== undefined) return "committed";
    return "estimated";
  }
  const moneyLedger = {
    CATS: ML_CATS, catLabel: mlCatLabel, varianceFlag: mlVarianceFlag, stage: mlStage,
    async breakdown(quoteId) {
      if (mode !== "supabase") return null;
      try { return await rpc("event_cost_breakdown", { p_quote: quoteId }); } catch (e) { if (rpcMissing(e)) return null; throw e; }
    },
    async studio(from, to) {
      if (mode !== "supabase") return null;
      try { return await rpc("studio_cost_breakdown", { p_from: from || null, p_to: to || null }); } catch (e) { if (rpcMissing(e)) return null; throw e; }
    },
    // a typed staff budget line is replaced by the automatic crew wage lines (or counted again)
    async setCrewCovered(costId, on) {
      if (mode !== "supabase") throw new Error("Needs the online database.");
      const { error } = await supa.from("event_costs").update({ crew_covered: !!on }).eq("id", costId);
      if (error) throw error; return true;
    },
  };

  /* ---------------- notification deep links (pure — unit-tested in test/notif-deeplinks.test.mjs) ----------------
     notifLink(n) → a RELATIVE link to one of the app's own pages ("" when there is nowhere to go).
     Every id is encodeURIComponent'd; the destination page reads ?task= / ?msg= / #payments and
     scrolls to + briefly highlights the row (deeplinkFocus below). */
  // 0067: the same link in its pretty studio form (/<studio>/events/<id>/tasks?task=…) once the studio is known
  function notifHref(n) { const h = notifLink(n); return typeof HelmUrl !== "undefined" ? HelmUrl.upgrade(h) : h; }
  function notifLink(n) {
    if (!n || typeof n !== "object") return "";
    const enc = (v) => encodeURIComponent(String(v));
    const has = (v) => v != null && String(v) !== "";
    if (n.__chat) {
      if (!has(n.conversation_id)) return "chat.html";
      return "chat.html?c=" + enc(n.conversation_id) + (has(n.msg_id) ? "&msg=" + enc(n.msg_id) : "");
    }
    const k0 = String(n.kind || "").toLowerCase().trim();
    const d = (n.detail && typeof n.detail === "object") ? n.detail : {};
    // 0069: package-flow notifications carry their own deep link in detail.path — internal relative pages only
    if (/^pkg_(selected|accepted|declined|payment)$/.test(k0)) {
      const p = typeof d.path === "string" ? d.path.trim() : "";
      if (/^(event|settlement)\.html\?(id|quote)=[0-9a-f-]{36}(#[a-z-]{1,32})?$/i.test(p))
        return k0 === "pkg_payment" ? p.replace(/#.*$/, "") + "#payments" : p.replace(/#.*$/, "") + "#pkg-selections";
      if (!has(n.quote_id) && has(d.quote_id)) n = Object.assign({}, n, { quote_id: d.quote_id });
    }
    const k = k0, q = has(n.quote_id) ? n.quote_id : null;
    if (k === "trial_reminder") return "checkout.html";
    if (k === "security_alert") return "control.html#users";
    // 0078: low stock -> the event's inventory page, the item row highlighted
    if (k === "inventory_low_stock") {
      const it = /^[0-9a-f-]{36}$/i.test(String(d.item_id || "")) ? String(d.item_id) : "";
      if (!q) return it ? "inventory.html?item=" + enc(it) : "inventory.html";
      return "inventory.html?quote=" + enc(q) + (it ? "&item=" + enc(it) : "");
    }
    if (k.indexOf("chat_") === 0) return "chat.html";
    if (k.indexOf("nurture_") === 0) return "nurture.html";
    if (!q) return "";
    if (k.indexOf("task_") === 0) return "ops.html?quote=" + enc(q) + (has(d.task_id) ? "&task=" + enc(d.task_id) : "");
    if (/^(payment_link|payment_reminder|payment_receipt|payment|payment_received|advance_paid|payment_reconcile|pkg_payment)$/.test(k))
      return "settlement.html?quote=" + enc(q) + "#payments";
    if (/^(approval_link|otp|reapproval_required|quote_approved|quote_changed|approved|change_order|client_follow_up)$/.test(k))
      return "quotes.html?focus=" + enc(has(n.event_code) ? n.event_code : q);
    if (k === "price_change") return "flow.html?id=" + enc(q) + "#sec-quote";
    if (k === "invite_site_link") return "invite-studio.html?quote=" + enc(q);
    if (k === "booklet_link") return "event.html?id=" + enc(q);
    if (k.indexOf("design_") === 0) return "design.html?quote=" + enc(q);
    if (/^pkg_(selected|accepted|declined)$/.test(k)) return "event.html?id=" + enc(q) + "#pkg-selections";
    if (k === "pkg_payment") return "settlement.html?quote=" + enc(q) + "#payments";
    return "event.html?id=" + enc(q);
  }
  /* ---------------- notification bell: view (pure — unit-tested in test/bell-panel.test.mjs) ----------------
     bellPanelView(items, { filter, now, label }) → { filter, tabs, tabsHtml, html, unread }
     items = the merged feed: bell_feed rows + chat rows ({ __chat:true, … }). Every piece of
     server / chat text goes through esc(); hrefs are built from encodeURIComponent'd ids. */
  // 0063: a feed row → its catalog type (mirrors notification_type_of in SQL). @mentions → null (never muted).
  function bellTypeOf(n) {
    if (!n || typeof n !== "object") return "other";
    if (n.__chat) return n.mention ? null : "chat_message";
    const k = String(n.kind || "").toLowerCase().trim();
    if (["approval_link", "otp", "payment_link", "payment_reminder", "payment_receipt", "advance_paid", "payment_reconcile",
         "task_assigned", "task_reminder", "task_due", "security_alert", "inventory_low_stock", "client_follow_up"].indexOf(k) !== -1) return k;
    if (k === "payment" || k === "payment_received") return "payment_receipt";
    if (k === "trial_reminder") return "billing_trial";
    if (/^pkg_(selected|accepted|declined|payment)$/.test(k)) return k;
    if (/^task_(accept|reject|start|complete)$/.test(k)) return "task_update";
    if (k.indexOf("design_") === 0) return "design_update";
    if (k.indexOf("nurture_") === 0) return "nurture_greeting";
    if (k.indexOf("chat_") === 0) return "chat_message";
    if (n.channel === "whatsapp") return "whatsapp_message";
    return "other";
  }
  // friendly names for the muted-types list (types the bell can show)
  const BELL_TYPE_LABELS = { approval_link: "Approval links", otp: "Approval codes (OTP)", whatsapp_message: "WhatsApp messages",
    nurture_greeting: "Greetings", design_update: "Design stage changes", task_assigned: "Tasks assigned", task_update: "Task updates",
    task_reminder: "Task reminders", task_due: "Tasks due", payment_link: "Payment links", payment_reminder: "Payment reminders",
    payment_receipt: "Payment receipts", advance_paid: "Payments received", payment_reconcile: "Payments needing attention",
    chat_message: "Chat messages", pkg_selected: "Client package choices", pkg_accepted: "Package choices accepted",
    pkg_declined: "Package choices declined", pkg_payment: "Package payments", security_alert: "Security alerts", billing_trial: "Free trial reminders",
    inventory_low_stock: "Low stock warnings", client_follow_up: "Client follow-ups", other: "Other updates" };
  // A4: a chat row's read key carries its newest message time, so marking a conversation read
  // only covers what was there; a later message makes a new key and counts as unread again.
  function bellChatKey(n) { return "c:" + ((n && n.conversation_id) || "") + "@" + ((n && n.created_at) || ""); }
  function bellPanelView(items, opts) {
    opts = opts || {};
    const muted = Array.isArray(opts.muted) ? opts.muted : [], readKeys = Array.isArray(opts.read) ? opts.read : [];
    const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const label = opts.label || ((n) => ({ icon: "🔔", text: String((n && n.kind) || "Update").replace(/_/g, " ") }));
    const now = Number(opts.now) || Date.now();
    // 0063: a type this person muted never shows (an @mention always does)
    const list = (items || []).filter((n) => n && typeof n === "object" && muted.indexOf(bellTypeOf(n)) === -1);
    // which filter group a row belongs to (also drives the icon-chip colour)
    const groupOf = (n) => {
      if (n.__chat) return n.mention ? "mention" : "chat";
      const k = String(n.kind || "").toLowerCase();
      if (k === "security_alert") return "security";
      if (k.indexOf("task_") === 0) return "task";
      if (/payment|advance_paid|trial_reminder/.test(k)) return "billing";
      return "other";
    };
    const inFilter = (f, g) => f === "all" || (f === "mentions" && g === "mention") || (f === "tasks" && g === "task")
      || (f === "billing" && g === "billing") || (f === "security" && g === "security") || (f === "chat" && (g === "chat" || g === "mention"));
    const keyOf = (n, i) => n.__chat ? bellChatKey(n) : "n:" + (n.id || i);
    const rows = list.map((n, i) => { const k = keyOf(n, i);
      return { n, i, g: groupOf(n), k, un: readKeys.indexOf(k) === -1 && (n.__chat || !!n.unread) }; });
    const has = (f) => rows.some((r) => inFilter(f, r.g));
    // r20-2: a chat row stands for `count` unread messages - the tabs count them the same way as the "N new"
    // header and the bell dot (they used to count rows: "4 new" over an All tab of 2). Mentions counts chats.
    const weight = (r, f) => (r.n.__chat && f !== "mentions" ? (Number(r.n.count) || 1) : 1);
    const unreadIn = (f) => rows.reduce((s, r) => s + (r.un && inFilter(f, r.g) ? weight(r, f) : 0), 0);
    const secMuted = muted.indexOf("security_alert") !== -1;
    // Billing only when the feed carries any (bell_feed already hides money types this role can't see);
    // Security when there are alerts or they are muted (so the "turn back on" line stays reachable)
    const tabs = [["all", "All"], ["mentions", "Mentions"], ["tasks", "Tasks"], ["billing", "Billing"], ["security", "Security"], ["chat", "Chat"]]
      .filter(([id]) => (id !== "billing" || has("billing")) && (id !== "security" || has("security") || secMuted))
      .map(([id, name]) => ({ id, label: name, count: unreadIn(id) }));
    let filter = String(opts.filter || "all"); if (filter !== "muted" && !tabs.some((t) => t.id === filter)) filter = "all";
    const tabsHtml = tabs.map((t) => `<button type="button" role="tab" class="bpb-tab" id="bpBellTab-${t.id}" data-f="${t.id}" aria-selected="${t.id === filter}" aria-controls="bpBellList" tabindex="${t.id === filter ? 0 : -1}">${t.label}${t.count ? `<span class="bpb-n">${t.count > 99 ? "99+" : t.count}</span>` : ""}</button>`).join("");
    const unread = rows.reduce((s, r) => s + (!r.un ? 0 : r.n.__chat ? (Number(r.n.count) || 1) : 1), 0);
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
        preview = esc(n.preview || ""); icon = n.mention ? "@" : "💬"; isUnread = r.un;
        href = notifHref(n); key = r.k;
      } else {
        const L = label(n) || {}; icon = esc(L.icon || "🔔"); title = esc(L.text || "Update");
        preview = esc([n.event_code, n.event_title].filter(Boolean).join(" · "));
        href = notifHref(n); isUnread = r.un; key = r.k;
      }
      const cls = `bpb-item g-${r.g}${isUnread ? " is-unread" : ""}`;
      const inner = `<span class="bpb-chip" aria-hidden="true">${icon}</span>`
        + `<span class="bpb-body"><span class="bpb-t">${title}</span>${preview ? `<span class="bpb-p">${preview}</span>` : ""}</span>`
        + `<span class="bpb-meta">${Number.isFinite(t) ? `<time datetime="${esc(new Date(t).toISOString())}">${esc(rel(t))}</time>` : ""}`
        + `${isUnread ? '<span class="bpb-u"><span class="sr-only">Unread</span></span>' : ""}</span>`;
      const ty = bellTypeOf(n);
      const more = `<button type="button" class="bpb-more" data-mk="${esc(key)}" data-ty="${esc(ty || "")}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions">⋯</button>`;
      return `<div class="bpb-row">` + (href ? `<a class="${cls}" href="${esc(href)}" data-k="${esc(key)}">${inner}</a>`
                  : `<div class="${cls}" tabindex="0" data-k="${esc(key)}">${inner}</div>`) + more + `</div>`;
    };
    const shown = filter === "muted" ? [] : rows.filter((r) => inFilter(filter, r.g));
    const secLine = secMuted && (filter === "security" || filter === "all")
      ? `<div class="bpb-mline">Security alerts muted - <button type="button" class="bpb-link" data-unmute="security_alert">turn back on</button></div>` : "";
    let html;
    if (filter === "muted") {
      html = `<div class="bpb-mhead"><button type="button" class="bpb-link" data-f-back>‹ Back</button><b>Muted types</b></div>`
        + (muted.length ? `<ul class="bpb-mlist">` + muted.map((ty) => `<li><span>${esc(BELL_TYPE_LABELS[ty] || String(ty).replace(/_/g, " "))}</span>`
          + `<button type="button" class="bpb-link" data-unmute="${esc(ty)}">Unmute</button></li>`).join("") + `</ul>`
          : `<div class="bpb-empty"><b>Nothing muted</b><span>Use the ⋯ menu on a notification to mute that type.</span></div>`);
    } else if (!shown.length) {
      const msg = { all: ["You’re all caught up", "New tasks, payments and messages will show up here."],
        mentions: ["No mentions", "When a teammate @mentions you in chat, it lands here."],
        tasks: ["No task updates", "Assignments, check-ins and reminders will appear here."],
        billing: ["No billing updates", "Payment links, receipts, reminders and trial notices will appear here."],
        security: ["No security alerts", "Admin overrides, lockouts and role changes will appear here."],
        chat: ["No unread messages", "Unread chats from your team show up here."] }[filter];
      html = `<div class="bpb-empty"><svg class="bpb-art" viewBox="0 0 120 96" aria-hidden="true" focusable="false">`
        + `<circle cx="60" cy="50" r="38" class="bpb-art-bg"/><path class="bpb-art-bell" d="M60 26c-10 0-17 8-17 18v11l-6 8h46l-6-8V44c0-10-7-18-17-18z"/>`
        + `<circle cx="60" cy="69" r="5" class="bpb-art-bell"/><path class="bpb-art-z" d="M84 18h8l-8 9h8M96 8h5l-5 6h5"/></svg>`
        + `<b>${msg[0]}</b><span>${msg[1]}</span></div>`;
      html = secLine + html;
    } else {
      const order = ["Today", "Yesterday", "Earlier"], by = { Today: [], Yesterday: [], Earlier: [] };
      shown.slice().sort((a, b) => (ts(b.n) || 0) - (ts(a.n) || 0)).forEach((r) => by[bucket(ts(r.n))].push(r));
      html = order.filter((d) => by[d].length).map((d) =>
        `<div class="bpb-sec" role="group" aria-label="${d}"><div class="bpb-day" aria-hidden="true">${d}</div>${by[d].map(item).join("")}</div>`).join("");
      html = secLine + html;
    }
    return { filter, tabs, tabsHtml, html, unread };
  }
  /* ---------------- notification toasts: which feed rows pop up (pure — unit-tested in test/toast.test.mjs) ----------------
     bellToastPick(items, seen, { label }) → { toasts:[{ key, title, message, href, type, icon }], seen }
     seen = { t: newest created_at already handled (ISO), ids: [recent keys] } or null.
     null (first load for this person on this browser) → baseline only, nothing pops up, so an old
     backlog never floods the screen. Only unread server rows / unread chats newer than the
     baseline and not already seen become toasts (newest 3). Text is plain (BPUI.toast uses textContent). */
  function bellToastPick(items, seen, opts) {
    opts = opts || {};
    const label = opts.label || ((n) => ({ icon: "🔔", text: String((n && n.kind) || "Update").replace(/_/g, " ") }));
    const muted = Array.isArray(opts.muted) ? opts.muted : [];   // 0063: muted types never pop up (mentions always do)
    const list = (items || []).filter((n) => n && typeof n === "object" && muted.indexOf(bellTypeOf(n)) === -1);
    const keyOf = (n) => n.__chat ? "c:" + (n.conversation_id || "") + "@" + (n.created_at || "") : "n:" + (n.id || "") + "@" + (n.created_at || "");
    const newest = list.reduce((m, n) => { const c = String(n.created_at || ""); return c > m ? c : m; }, String((seen && seen.t) || ""));
    const ids = (seen && Array.isArray(seen.ids)) ? seen.ids.slice(-60) : [];
    if (!seen || typeof seen !== "object") return { toasts: [], seen: { t: newest, ids: list.map(keyOf).slice(0, 60) } };
    const since = String(seen.t || "");
    const fresh = list.filter((n) => (n.__chat || n.unread) && String(n.created_at || "") > since && ids.indexOf(keyOf(n)) === -1)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 3);
    const typeOf = (k) => k === "security_alert" ? "security" : k === "trial_reminder" ? "warning" : /^(payment_received|advance_paid|task_complete|task_accept)$/.test(k) ? "success"
      : /^(payment_reconcile|task_reject|task_due)$/.test(k) ? "warning" : "info";
    const toasts = fresh.map((n) => {
      if (n.__chat) {
        const who = n.who || "";
        return { key: keyOf(n), type: "info", icon: n.mention ? "@" : "💬",
          title: n.mention ? (n.title || "You were mentioned") : n.kind === "dm" ? (who || n.title || "Direct message") : ((n.title || "Chat") + (who ? " · " + who : "")),
          message: String(n.preview || "New message"), href: notifHref(n), rk: bellChatKey(n) };
      }
      const L = label(n) || {}, k = String(n.kind || "").toLowerCase();
      return { key: keyOf(n), type: typeOf(k), icon: L.icon || "🔔", title: String(L.text || "Update"),
        message: k === "trial_reminder" ? "Choose a plan to keep using Helm" : [n.event_code, n.event_title].filter(Boolean).join(" · ") || "Open to see details",
        href: notifHref(n), rk: "n:" + (n.id || "") };
    });
    return { toasts, seen: { t: newest, ids: ids.concat(fresh.map(keyOf)).slice(-60) } };
  }
  // Bell styles: injected once (the bell must look the same on pages without theme.css).
  // Light/dark follow the page tokens (theme.css re-points them under html[data-theme=dark]).
  const BELL_CSS = [
    ".bpb-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;height:32px;width:36px;padding:0;border:1px solid var(--line,#e8e3db);background:var(--panel,#fff);color:var(--ink,#1b1930);border-radius:10px;cursor:pointer;transition:background .15s,border-color .15s}",
    ".bpb-btn:hover{border-color:var(--accent,#047857);background:var(--accent-soft,#e3f4ed)}",
    ".bpb-btn[aria-expanded=true]{border-color:var(--accent,#047857);background:var(--accent-soft,#e3f4ed);color:var(--accent,#047857)}",
    ".bpb-btn svg{width:17px;height:17px}",
    ".bpb-dot{position:absolute;top:-6px;right:-7px;min-width:17px;height:17px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#e5484d;color:#fff;font:700 10px/17px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:center;box-shadow:0 0 0 2px var(--panel,#fff)}",
    ".bpb-dot[hidden]{display:none}",
    ".bpb-root{--bpb-bg:var(--panel,#fff);--bpb-bg2:var(--panel-2,#faf8f5);--bpb-ink:var(--ink,#1b1930);--bpb-ink2:var(--ink-2,#4b475f);--bpb-ink3:var(--ink-3,#6b6577);",
    "--bpb-line:var(--line,#e8e3db);--bpb-acc:var(--accent,#047857);--bpb-acc-t:var(--hb-acc-text,var(--accent,#047857));--bpb-unread:#f0f9f5;",
    "--bpb-mention-bg:#ffe4ec;--bpb-mention:#be123c;--bpb-chat-bg:#e0ecff;--bpb-chat:#1d4ed8;--bpb-task-bg:#dcf5e7;--bpb-task:#0f7a43;",
    "--bpb-pay-bg:#fff1d6;--bpb-pay:#8f5f00;--bpb-other-bg:var(--accent-soft,#e3f4ed);--bpb-other:var(--accent,#047857);",
    "--bpb-scrim:rgba(24,20,40,.10);--bpb-scrim-phone:rgba(24,20,40,.38);--bpb-shadow:0 24px 60px rgba(20,27,46,.22),0 2px 8px rgba(20,27,46,.08);",
    "position:fixed;inset:0;z-index:2147482000;font:14px/1.4 var(--font,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);color:var(--bpb-ink)}",
    "html[data-theme=dark] .bpb-root{--bpb-unread:#19152a;--bpb-mention-bg:#3a1424;--bpb-mention:#fda4af;--bpb-chat-bg:#172a4d;--bpb-chat:#93c5fd;--bpb-task-bg:#12301f;--bpb-task:#6ee7b7;",
    "--bpb-pay-bg:#3a2a0c;--bpb-pay:#fcd34d;--bpb-other-bg:#123329;--bpb-other:#6ee7b7;--bpb-scrim:rgba(0,0,0,.28);--bpb-scrim-phone:rgba(0,0,0,.55);--bpb-shadow:0 24px 60px rgba(0,0,0,.7)}",
    ".bpb-root[hidden]{display:none}",
    // backdrop: a light dim only (no blur — the page behind stays readable); darker under the phone sheet
    ".bpb-scrim{position:absolute;inset:0;background:var(--bpb-scrim);opacity:0;transition:opacity .2s ease}",
    ".bpb-root.is-open .bpb-scrim{opacity:1}",
    // desktop: a popover anchored under the bell (top/right set from the button's position)
    ".bpb-panel{position:absolute;top:56px;right:16px;width:min(420px,calc(100vw - 32px));max-height:min(640px,calc(100vh - 72px));display:flex;flex-direction:column;box-sizing:border-box;",
    "background:var(--bpb-bg);color:var(--bpb-ink);border:1px solid var(--bpb-line);border-radius:16px;box-shadow:var(--bpb-shadow);overflow:hidden;outline:none;",
    "opacity:0;transform:translateY(-8px) scale(.98);transform-origin:top right;transition:opacity .18s ease,transform .22s cubic-bezier(.2,.8,.2,1)}",
    ".bpb-root.is-open .bpb-panel{opacity:1;transform:none}",
    ".bpb-grab{display:none}",
    ".bpb-head{display:block;position:static;height:auto;margin:0;box-shadow:none;padding:12px 10px 0 16px;border-bottom:1px solid var(--bpb-line);background:var(--bpb-bg)}",
    // header = ONE row: title + count on the left, "Mark all read" + close on the right (never wraps)
    ".bpb-hrow{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-width:0;white-space:nowrap}",
    ".bpb-title{margin:0;font-size:16px;font-weight:750;letter-spacing:-.01em;color:var(--bpb-ink);white-space:nowrap;flex:0 0 auto}",
    ".bpb-count{flex:0 0 auto;display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--bpb-acc);color:#fff;font-size:11px;font-weight:700;white-space:nowrap}",
    "html[data-theme=dark] .bpb-count{color:var(--hb-acc-ink,#141418)}",
    ".bpb-count[hidden]{display:none}",
    ".bpb-sp{flex:1 1 auto;min-width:4px}",
    ".bpb-link{flex:0 0 auto;white-space:nowrap;border:0;background:transparent;color:var(--bpb-acc-t);font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;padding:6px 8px;border-radius:8px}",
    ".bpb-link:hover{background:var(--bpb-other-bg)}.bpb-link[disabled]{opacity:.5;cursor:default}",
    ".bpb-x{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--bpb-ink3);font-size:16px;line-height:1;cursor:pointer;width:32px;height:32px;border-radius:8px}",
    ".bpb-x:hover{background:var(--bpb-bg2);color:var(--bpb-ink)}",
    ".bpb-tabs{display:flex;gap:4px;margin:8px 0 0 -6px;padding-right:6px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity}",
    ".bpb-tabs::-webkit-scrollbar{display:none}",
    ".bpb-tab{flex:0 0 auto;white-space:nowrap;scroll-snap-align:start;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;color:var(--bpb-ink2);font:inherit;font-size:13px;font-weight:600;",
    "padding:8px 10px 10px;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;cursor:pointer}",
    ".bpb-tab:hover{color:var(--bpb-ink);background:var(--bpb-bg2)}",
    ".bpb-tab[aria-selected=true]{color:var(--bpb-acc-t);border-bottom-color:var(--bpb-acc)}",
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
    ".g-billing .bpb-chip{background:var(--bpb-pay-bg);color:var(--bpb-pay)}",
    ".g-security .bpb-chip{background:var(--bpb-mention-bg);color:var(--bpb-mention)}",
    // 0063: per-row ⋯ menu, muted line, muted-types list
    ".bpb-row{position:relative}.bpb-row .bpb-item{padding-right:40px}",
    ".bpb-more{position:absolute;right:14px;bottom:8px;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--bpb-ink3);font:inherit;font-size:16px;line-height:1;cursor:pointer}",
    ".bpb-more:hover,.bpb-more[aria-expanded=true]{background:var(--bpb-bg2);color:var(--bpb-ink)}.bpb-more:focus-visible{outline:2px solid var(--bpb-acc)}",
    ".bpb-menu{position:absolute;right:14px;top:calc(100% - 6px);z-index:3;min-width:170px;padding:4px;background:var(--bpb-bg);border:1px solid var(--bpb-line);border-radius:10px;box-shadow:var(--bpb-shadow)}",
    ".bpb-menu button{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--bpb-ink);font:inherit;font-size:13px;padding:8px 10px;border-radius:7px;cursor:pointer}",
    ".bpb-menu button:hover,.bpb-menu button:focus-visible{background:var(--bpb-bg2);outline:none}",
    ".bpb-mline{margin:8px 16px 4px;padding:8px 10px;border-radius:10px;background:var(--bpb-bg2);color:var(--bpb-ink2);font-size:12.5px}",
    ".bpb-mhead{display:flex;align-items:center;gap:8px;padding:10px 12px}.bpb-mlist{list-style:none;margin:0;padding:0 8px}",
    ".bpb-mlist li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px;border-bottom:1px solid var(--bpb-line)}",
    ".bpb-foot{border-top:1px solid var(--bpb-line);padding:6px 10px;text-align:right}",
    ".bpb-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-top:1px}",
    ".bpb-t{font-size:13.5px;font-weight:650;color:var(--bpb-ink);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}",
    ".bpb-chip{width:36px;height:36px;font-size:16px}",
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
    ".bpb-panel{top:max(48px,env(safe-area-inset-top,0px))!important;right:0!important;left:0;bottom:0;width:auto;max-width:none;max-height:none;border-radius:20px 20px 0 0;border-bottom:0;",
    "padding-bottom:env(safe-area-inset-bottom,0px);transform:translateY(100%);opacity:1;transition:transform .28s cubic-bezier(.2,.8,.2,1)}",
    ".bpb-root.is-open .bpb-panel{transform:none}",
    ".bpb-grab{display:block;width:40px;height:4px;border-radius:2px;background:var(--bpb-line);margin:8px auto 0}",
    ".bpb-scrim{background:var(--bpb-scrim-phone)}",
    ".bpb-head{padding-top:8px}.bpb-item{padding:12px 10px}.bpb-x{width:40px;height:40px}}",
    "@media (prefers-reduced-motion:reduce){.bpb-root .bpb-scrim,.bpb-root .bpb-panel,.bpb-btn{transition:none!important}.bpb-panel{transform:none!important}.bpb-skel{animation:none}}",
    "@media (min-width:641px){html.bpb-is-open .bpui-toasts{right:calc(28px + min(420px,calc(100vw - 32px)))}}",
    "@media print{.bpb-root{display:none!important}}",
  ].join("\n");
  function bellInjectCss() {
    if (typeof document === "undefined" || document.__bpbStyle) return;
    document.__bpbStyle = true; __helmAdoptCss(document, BELL_CSS);
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
      // 0054: names only (who / whom) — never e-mails, links or tokens
      security_alert: ["🛡️", "Security: " + String(d.label || "security event")
        + ((Number(d.count) || 1) > 1 ? " ×" + (Number(d.count) || 1) : "")
        + (d.subject_name ? " · " + d.subject_name : d.actor_name ? " · by " + d.actor_name : "")
        + (d.event_code ? " · " + d.event_code : "")],
      // 0058: free-trial reminders (admins only — the server decides)
      trial_reminder: ["⏳", String(d.label || "Free trial update")],
      // 0129: "event is coming up" (studio-wide; never forwarded)
      event_reminder: ["📅", String(d.label || "An event is coming up")],
      // 0205: an invitee whose invitation expired asked for a new link (re-send it from Staff)
      invite_link_request: ["✉️", String(d.label || "A teammate asked for a new invitation link")],
      // 0069 client package flow
      pkg_selected: ["📦", "Client chose a package" + (d.package ? ": " + d.package : "") + (d.event_code ? " · " + d.event_code : "")],
      pkg_accepted: ["✅", "Package choice accepted" + (d.event_code ? " · " + d.event_code : "")],
      pkg_declined: ["↩️", "Package choice declined" + (d.event_code ? " · " + d.event_code : "")],
      // 0077: Control Center prices changed after this future quote was priced (quote editors only — server-gated)
      price_change: ["🏷️", "Prices changed — review & re-price" + (d.event_code ? " · " + d.event_code : "")],
      pkg_payment: ["💸", "Package payment received" + (d.event_code ? " · " + d.event_code : "")],
      // 0078: low stock on an event date / automatic client follow-up
      inventory_low_stock: ["📦", "Low stock: " + String(d.item || "an item") + (d.date ? " on " + d.date : "")
        + (Number(d.short) > 0 ? " — short by " + Number(d.short) : "")],
      client_follow_up: ["💬", "Follow-up sent to the client" + (d.auto === false ? "" : " (automatic)")],
      // 0195: "Send to client" on the Invitation Studio
      invite_site_link: ["💌", n.status === "suppressed"
        ? "Invitation link not sent" + (d.skipped === "free_trial" ? " (free trial test mode)" : d.skipped === "demo" ? " (demo event)" : d.suppressed_by === "trial_cap" ? " (free trial e-mail limit)" : "")
        : n.status === "failed" ? "Invitation link could not be sent" : "Invitation link sent to the client"],
      // 0200: "Send to client" in the Share booklet dialog (and the older client-mailer e-mail)
      booklet_link: ["📖", n.status === "suppressed"
        ? "Booklet link not sent" + (d.skipped === "free_trial" || d.suppressed_by === "trial" ? " (free trial test mode)" : d.skipped === "demo" || d.suppressed_by === "demo" ? " (demo event)" : d.suppressed_by === "trial_cap" ? " (free trial e-mail limit)" : "")
        : n.status === "failed" ? "Booklet link could not be sent" : n.status === "simulated" ? "Booklet link not sent (sending not set up)" : "Booklet link sent to the client"],
    };
    if (k === "invite_site_link" || k === "booklet_link") return { icon: m[k][0], text: m[k][1] };
    const hit = m[k] || (k.indexOf("design_") === 0 ? ["🎨", "Design stage: " + k.slice(7).replace(/_/g, " ")]
                      : k.indexOf("nurture_") === 0 ? ["🌱", "Greeting queued" + (k.length > 8 ? " · " + k.slice(8).replace(/_/g, " ") : "")] : null);
    // 0036: an automatic staff text/e-mail the studio switched off is logged, not sent
    const off = n.status === "suppressed" ? " (not sent — switched off)" : "";
    if (hit) return { icon: hit[0], text: hit[1] + off };
    return { icon: "🔔", text: (n.kind || "Update").replace(/_/g, " ") + off };
  }

  /* ---------------- notification center: in-app bell (Phase 48) ---------------- */
  /* destination side of a notification deep link: ?task=<id> (ops), ?msg=<id> (chat), #payments
     (settlement). Waits for the row to render (≤15 s), scrolls it into view and highlights it briefly.
     Ids are allow-listed ([A-Za-z0-9_-]) before going into a selector. */
  function deeplinkTarget(search, hash) {
    let p; try { p = new URLSearchParams(search || ""); } catch (e) { return null; }
    const ok = (v) => (v && /^[A-Za-z0-9_-]{1,64}$/.test(v)) ? v : null;
    const task = ok(p.get("task")), msg = ok(p.get("msg")), item = ok(p.get("item"));
    if (task) return '.trow[data-id="' + task + '"]';
    if (item) return 'tr[data-item="' + item + '"]';
    if (msg) return '.m[data-mid="' + msg + '"]';
    if (hash === "#payments") return "#payments";
    if (hash === "#pkg-selections") return "#pkg-selections";
    return null;
  }
  function deeplinkFocus() {
    if (typeof document === "undefined" || typeof location === "undefined") return;
    const sel = deeplinkTarget(location.search, location.hash); if (!sel) return;
    __helmAdoptCss(document, "@keyframes bpDlFlash{0%,60%{box-shadow:0 0 0 3px var(--accent,#c8a24a);background-color:var(--accent-soft,rgba(200,162,74,.18))}100%{box-shadow:0 0 0 0 transparent}}"
      + ".bp-dl-hl{animation:bpDlFlash 2.4s ease-out 1;scroll-margin:96px}@media (prefers-reduced-motion:reduce){.bp-dl-hl{animation:none;outline:3px solid var(--accent,#c8a24a)}}");
    let tries = 0, done = 0, last = null;
    const tick = () => {
      const el = document.querySelector(sel);
      if (el && el !== last) {
        last = el; el.classList.add("bp-dl-hl"); done++;
        try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { try { el.scrollIntoView(); } catch (x) {} }
        setTimeout(() => { try { el.classList.remove("bp-dl-hl"); } catch (e) {} }, 2600);
      }
      // keep watching briefly: pages re-render lists after load (chat scrolls to the bottom)
      if (++tries < 60 && done < 2) setTimeout(tick, done ? 700 : 250);
    };
    tick();
  }
  try { if (typeof document !== "undefined") { if (document.readyState !== "loading") setTimeout(deeplinkFocus, 0); else document.addEventListener("DOMContentLoaded", deeplinkFocus); } } catch (e) {}

  const bell = {
    link: notifLink,
    // la-fetch (audit 25): the bell's first load and the realtime-subscribe refresh right after it asked bell_feed
    // twice - one answer per 5 s per tab (markSeen or any other write drops it)
    feed: (limit) => memoRead("bell.feed:" + (limit || ""), 5000, () => rpc("bell_feed", limit ? { p_limit: limit } : {})),
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
      // 0063: types this person muted for themselves (fail-open: no 0063 → nothing muted)
      async mutes() {
        if (mode !== "supabase" || !supa || !currentUser) return [];
        try { const r = await rpc("my_notification_mutes", {}); return Array.isArray(r) ? r.map(String) : []; } catch (e) { return []; }
      },
      setMute: (type, muted) => rpc("set_notification_mute", { p_type: String(type || ""), p_muted: !!muted }),
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
          <div class="bpb-foot"><button type="button" id="bpBellMuted" class="bpb-link">Muted types</button></div>
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
      const chatReadCount = () => chatItems.reduce((s, c) => s + (readKeys.indexOf(bellChatKey(c)) !== -1 ? (c.count || 1) : 0), 0);
      // server unread minus muted / marked-read rows (only recounted when something is muted or read)
      const serverUnread = (f) => !f ? 0 : (muted.length || readKeys.length)
        ? bellPanelView((f.items || []), { muted, read: readKeys }).unread : f.unread;
      const mergedFeed = (serverItems) => (serverItems || []).slice()
        .concat(chatItems.map((c) => Object.assign({ __chat: true }, c)))
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      // 0036: the studio admin can switch chat off in the bell for a role / person
      // (re-checked every 5 minutes; server-side types are already filtered by bell_feed).
      let hiddenTypes = [], hiddenAt = 0, muted = [];
      const loadHidden = async () => { if (Date.now() - hiddenAt < 300000) return; hiddenAt = Date.now(); hiddenTypes = (await this.prefs.mine()).hidden;
        muted = await this.prefs.mutes(); };
      // 0063: rows this person marked read from the ⋯ menu (this browser only; try/catch for private mode)
      const readKey = "bpBellRead:" + ((auth.user() && auth.user().id) || "anon");
      let readKeys = (() => { try { const v = JSON.parse(localStorage.getItem(readKey) || "[]"); return Array.isArray(v) ? v.slice(-200) : []; } catch (e) { return []; } })();
      const saveRead = () => { try { localStorage.setItem(readKey, JSON.stringify(readKeys.slice(-200))); } catch (e) {} };
      const loadChat = async () => { try { await loadHidden(); } catch (e) {} const chatOff = hiddenTypes.indexOf("chat_message") !== -1;   // chat switched off → @mentions still come through
        try { if (chat && chat.prefs) await chat.prefs.sync(); } catch (e) {}   // A12: server mutes → wa_mute cache
        try { chatItems = (chat && chat.notifications) ? (await chat.notifications(20)) : []; } catch (e) { chatItems = []; }
        if (chatOff) chatItems = chatItems.filter((c) => c && c.mention);
        if (muted.indexOf("chat_message") !== -1) chatItems = chatItems.filter((c) => c && c.mention); };
      const setDot = (serverUnread) => { const total = (serverUnread || 0) + chatUnread() - chatReadCount();
        if (total > 0) { dot.hidden = false; dot.textContent = total > 9 ? "9+" : total; } else dot.hidden = true;
        btn.setAttribute("aria-label", total > 0 ? `Notifications, ${total} unread` : "Notifications"); btn.title = total > 0 ? `${total} unread notification${total === 1 ? "" : "s"}` : "Notifications"; };
      // render the open panel, keeping keyboard focus on the same row / tab across live refreshes
      const render = () => {
        const ae = document.activeElement, keepKey = ae && root.contains(ae) && ae.getAttribute ? (ae.getAttribute("data-k") || (ae.getAttribute("data-f") ? "tab:" + ae.getAttribute("data-f") : null)) : null;
        const v = bellPanelView(lastItems, { filter, now: Date.now(), label: bellLabel, muted, read: readKeys });
        filter = v.filter; tabsEl.innerHTML = v.tabsHtml; list.innerHTML = v.html;
        list.setAttribute("aria-labelledby", "bpBellTab-" + filter);
        if (v.unread > 0) { countEl.hidden = false; countEl.textContent = (v.unread > 99 ? "99+" : v.unread) + " new"; } else countEl.hidden = true;
        if (keepKey) { const sel = keepKey.indexOf("tab:") === 0 ? `[data-f="${keepKey.slice(4)}"]` : `[data-k="${String(keepKey).replace(/["\\]/g, "\\$&")}"]`;
          const t = root.querySelector(sel); if (t) try { t.focus(); } catch (e) {} }
      };
      // On-screen toasts for NEW notifications (bell_feed already applies the per-role prefs; chat
      // honours 0036 via loadChat). Last-seen is kept per user in localStorage (try/catch: private
      // mode just means a fresh baseline). Nothing pops up while the panel is open.
      const seenKey = "bpBellToastSeen:" + ((auth.user() && auth.user().id) || "anon");
      const readSeen = () => { try { const v = JSON.parse(localStorage.getItem(seenKey) || "null"); return v && typeof v === "object" ? v : null; } catch (e) { return null; } };
      const writeSeen = (v) => { try { localStorage.setItem(seenKey, JSON.stringify(v)); } catch (e) {} };
      const popToasts = (merged) => {
        const r = bellToastPick(merged, readSeen(), { label: bellLabel, muted }); writeSeen(r.seen);
        if (isOpen || !window.BPUI || !window.BPUI.toast) return;
        r.toasts.slice().reverse().forEach((x) => { try { window.BPUI.toast(x.message, { title: x.title, type: x.type, icon: x.icon, href: x.href || null, linkLabel: "View", timeout: 5000,
          onOpen: () => { if (x.rk && readKeys.indexOf(x.rk) === -1) { readKeys.push(x.rk); saveRead(); } } }); } catch (e) {} });
      };
      let lastRf = 0;
      const refreshNow = async () => { lastRf = Date.now(); let f = null; try { f = await this.feed(20); } catch {} await loadChat(); setDot(serverUnread(f));
        const merged = mergedFeed(f && f.items); if (f) popToasts(merged);
        if (isOpen) { lastItems = merged; loaded = true; render(); } return f; };
      // r20 planner: refreshes run ONE AT A TIME, in call order. The chat page's "I just read this chat" nudge
      // (__bpBellRefresh) used to run alongside a realtime / poll refresh that had read the chat BEFORE the mark;
      // when that older one finished last it put the stale count back ("4 unread" until a reload / the 90 s poll).
      let rfChain = Promise.resolve();
      const refresh = () => { const p = rfChain.then(refreshNow, refreshNow); rfChain = p.then(() => {}, () => {}); return p; };
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
        void root.offsetWidth; root.classList.add("is-open"); document.documentElement.classList.add("bpb-is-open");     // next frame → CSS transition runs
        try { panel.focus({ preventScroll: true }); } catch (e) { panel.focus(); }
        if (loaded) render();                                       // show the last list at once, then refresh
        let f = null; try { f = await this.feed(20); } catch {} await loadChat();
        if (!isOpen) return;
        lastItems = mergedFeed(f && f.items); loaded = true; render(); if (f) popToasts(lastItems);   // panel open → just moves the baseline
        try { await this.markSeen(); } catch {} setDot(0);   // event notifs cleared; any chat unread keeps the dot until that chat is opened
      };
      const close = (restore) => {
        if (!isOpen) return; isOpen = false;
        root.classList.remove("is-open"); document.documentElement.classList.remove("bpb-is-open"); btn.setAttribute("aria-expanded", "false");
        try { document.documentElement.style.overflow = prevOverflow || ""; } catch (e) {}
        const hide = () => { if (!isOpen) root.hidden = true; };
        if (reduced()) hide(); else closeTimer = setTimeout(hide, 280);
        if (restore !== false) { const t = (lastFocus && lastFocus.isConnected && lastFocus !== document.body) ? lastFocus : btn; try { t.focus({ preventScroll: true }); } catch (e) {} }
      };
      btn.addEventListener("click", (e) => { e.stopPropagation(); if (isOpen) close(); else open(); });
      // 0063: per-row ⋯ menu (Mute this type / Mark read) with an Undo toast
      const say = (msg, undo) => { try { window.BPUI && window.BPUI.toast && window.BPUI.toast(msg, { type: "info", timeout: 6000, action: undo ? { label: "Undo", onClick: undo } : undefined }); } catch (x) {} };
      const closeMenu = () => { const m = root.querySelector(".bpb-menu"); if (m) { const b = m.__btn; m.remove(); if (b) b.setAttribute("aria-expanded", "false"); return b; } return null; };
      const setMuted = async (ty, on) => {
        try { const r = await this.prefs.setMute(ty, on); muted = Array.isArray(r) ? r.map(String) : muted; }
        catch (x) { say("Could not update muted types. Try again."); return false; }
        await refresh(); if (isOpen) render(); return true;
      };
      const markRead = (k, on) => { readKeys = readKeys.filter((x) => x !== k); if (on) readKeys.push(k); saveRead(); render(); refresh(); };
      const openMenu = (btn) => {
        closeMenu();
        const k = btn.getAttribute("data-mk") || "", ty = btn.getAttribute("data-ty") || "";
        const m = document.createElement("div"); m.className = "bpb-menu"; m.setAttribute("role", "menu"); m.__btn = btn;
        const add = (text, fn) => { const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitem"); b.textContent = text;
          b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); closeMenu(); fn(); }); m.appendChild(b); return b; };
        if (ty) add("Mute this type", async () => { if (await setMuted(ty, true))
          say("Muted: " + (BELL_TYPE_LABELS[ty] || ty.replace(/_/g, " ")), () => { setMuted(ty, false); }); });
        add("Mark read", () => { markRead(k, true); say("Marked as read", () => markRead(k, false)); });
        btn.parentNode.appendChild(m); btn.setAttribute("aria-expanded", "true");
        try { m.querySelector("button").focus(); } catch (x) {}
      };
      root.addEventListener("click", (e) => {
        const mb = e.target.closest && e.target.closest(".bpb-more");
        if (mb) { e.preventDefault(); e.stopPropagation(); if (mb.getAttribute("aria-expanded") === "true") closeMenu(); else openMenu(mb); return; }
        if (!(e.target.closest && e.target.closest(".bpb-menu"))) closeMenu();
        const um = e.target.closest && e.target.closest("[data-unmute]");
        if (um) { e.preventDefault(); const ty = um.getAttribute("data-unmute"); setMuted(ty, false).then((ok) => { if (ok) say("Turned back on: " + (BELL_TYPE_LABELS[ty] || ty)); }); return; }
        if (e.target.closest && e.target.closest("#bpBellMuted")) { e.preventDefault(); filter = "muted"; render(); return; }
        if (e.target.closest && e.target.closest("[data-f-back]")) { e.preventDefault(); filter = "all"; render(); return; }
        const c = e.target.closest && e.target.closest("[data-bpb-close]"); if (c) { e.preventDefault(); close(); return; }
        const tab = e.target.closest && e.target.closest(".bpb-tab"); if (tab) { filter = tab.getAttribute("data-f") || "all"; render(); try { root.querySelector(`[data-f="${filter}"]`).focus(); } catch (x) {} return; }
        const it = e.target.closest && e.target.closest("a.bpb-item");
        if (it) { const k = it.getAttribute("data-k"); if (k && readKeys.indexOf(k) === -1) { readKeys.push(k); saveRead(); } close(false); }   // mark read, navigate away
      });
      root.querySelector("#bpBellClear").addEventListener("click", async (e) => { e.stopPropagation(); const b = e.currentTarget; b.disabled = true;
        try { await this.markSeen(); } catch {} await refresh(); b.disabled = false; });
      // keyboard: Esc closes, Tab is trapped, arrows walk the list, ←/→ switch tabs
      root.addEventListener("keydown", (e) => {
        if (!isOpen) return;
        if ((e.key === "Escape" || e.key === "Esc") && root.querySelector(".bpb-menu")) { e.preventDefault(); e.stopPropagation(); const b = closeMenu(); try { b && b.focus(); } catch (x) {} return; }
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
      /* perf (Oct 2026): the feed + chat bootstrap (bell_feed, prefs, mutes, chat members/directory/messages/mentions
         ≈ 8 sequential reads) no longer block the page's own boot - pages `await bell.mount()` before loading their data.
         Off the chat page they start once the page is idle after load (or at once if the bell is opened first: open()
         fetches its own feed). The chat page keeps the immediate load. */
      var csub = null, kicked = false;
      // perf 1017: realtime events (and the subscribe handshake right after kick) used to start a second
      // full feed + chat bootstrap while the first was still loading. Coalesce: one in flight, one trailing.
      let rfBusy = null, rfAgain = false;
      const liveRefresh = () => { if (rfBusy) { rfAgain = true; return rfBusy; }
        rfBusy = Promise.resolve(refresh()).catch(() => {}).then(() => { rfBusy = null; if (rfAgain) { rfAgain = false; return liveRefresh(); } });
        return rfBusy; };
      const kick = () => { if (kicked) return; kicked = true; liveRefresh();
        try { if (chat && chat.subscribe) { csub = chat.subscribe(function () { liveRefresh(); }, function () {}, "chat-rt-bell"); window.addEventListener("beforeunload", function () { try { csub && csub.unsubscribe && csub.unsubscribe(); } catch (e) {} }); } } catch (e) {}
      };
      // la-fetch (audit 25): one poll is ~7 reads (feed + chat bootstrap). On the Chat page realtime already
      // refreshes on every message, so the safety poll there runs every 90 s, elsewhere every 30 s; never
      // while the tab is hidden, and a tab coming back after its interval catches up once.
      const pollMs = () => (pageKey() === "chat" && csub ? 90000 : 30000);
      const timer = setInterval(() => { if (kicked && !document.hidden && !isOpen && Date.now() - lastRf >= pollMs() - 1000) refresh(); }, 30000);
      const onVis = () => { if (kicked && !document.hidden && !isOpen && Date.now() - lastRf >= pollMs()) liveRefresh(); };
      document.addEventListener("visibilitychange", onVis);
      btn.addEventListener("click", kick);
      if (pageKey() === "chat") kick();
      else {
        const idle = () => { if (window.requestIdleCallback) window.requestIdleCallback(kick, { timeout: 4000 }); else setTimeout(kick, 1200); };
        if (document.readyState === "complete") setTimeout(idle, 1200); else window.addEventListener("load", () => setTimeout(idle, 1200), { once: true });
      }
      // Let the chat page nudge the bell after it marks a conversation read.
      try { window.__bpBellRefresh = refresh; } catch (e) {}
      try { window.__bpBellTeardown = () => { kicked = true; clearInterval(timer); window.removeEventListener("resize", onResize); document.removeEventListener("visibilitychange", onVis); if (isOpen) close(false);
        try { csub && csub.unsubscribe && csub.unsubscribe(); } catch (e) {} try { root.remove(); } catch (e) {} }; } catch (e) {}
    },
  };

  /* ---------------- client portal (Phase 53) ---------------- */
  const portal = { get: (token) => rpc("public_get_portal", { p_token: token }),
    // 0101 (E11): booklet link, published invitation, receipts, studio contact - read-only, same token; null before 0101
    extras: (token) => (mode === "supabase" ? rpc("public_portal_extras", { p_token: token }).catch(() => null) : Promise.resolve(null)) };

  /* ---------------- post-event insights (Phase 51) ---------------- */
  // 0077: "Recently opened" records kept on the server per person + studio, so the clock
  // menu is the same on every device. Fail-soft: null = server list unavailable (old DB).
  const recents = {
    async touch(href, title, kind) {
      if (mode !== "supabase" || !supa) return false;
      try { await rpc("recent_touch", { p_href: String(href || ""), p_title: String(title || ""), p_kind: kind || "record" }); return true; } catch (e) { return false; }
    },
    async list(limit) {
      if (mode !== "supabase" || !supa) return null;
      try { const r = await rpc("recent_list", { p_limit: limit || 10 }); return Array.isArray(r) ? r : []; } catch (e) { return null; }
    },
  };
  // 0085 venues: read under RLS (own studio + "venues" view); writes only via RPCs
  const venues = {
    async list(opts) {
      if (mode !== "supabase" || !supa) return [];
      let q = supa.from("venues").select("*").order("active", { ascending: false }).order("name");
      if (!(opts && opts.all)) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) { if (/venues/.test(String(error.message || "")) && /does not exist|schema cache/i.test(String(error.message || ""))) { const er = new Error("Venues need database update 0085 (ask your admin to run APPLY-0085.sql)."); er.code = "venues_missing"; throw er; } throw error; }
      return data || [];
    },
    async save(id, data) { return rpc("venue_save", { p_id: id || null, p: data || {} }); },
    async setActive(id, on) { return rpc("venue_set_active", { p_id: id, p_active: !!on }); },
    async loadSamples() { return rpc("venue_load_samples", {}); },
  };
  // 0096 studio layout templates: read under RLS (own studio + layouts/controls view); writes only via RPCs
  const layoutTemplates = {
    async list(opts) {
      if (mode !== "supabase" || !supa) return [];
      let q = supa.from("studio_layout_templates").select(opts && opts.lite ? "id,name,event_type,description,thumbnail,is_default,archived,updated_at" : "*").order("archived").order("name");
      if (!(opts && opts.all)) q = q.eq("archived", false);
      const { data, error } = await q;
      if (error) { if (/studio_layout_templates/.test(String(error.message || "")) && /does not exist|schema cache/i.test(String(error.message || ""))) { const er = new Error("Studio templates need database update 0096 (ask your admin to run it)."); er.code = "templates_missing"; throw er; } throw error; }
      return data || [];
    },
    async get(id) {
      if (mode !== "supabase" || !supa) return null;
      const { data, error } = await supa.from("studio_layout_templates").select("*").eq("id", id).maybeSingle();
      if (error) throw error; return data || null;
    },
    async save(id, data) { return rpc("studio_template_save", { p_id: id || null, p: data || {} }); },
    async setArchived(id, on) { return rpc("studio_template_set_archived", { p_id: id, p_archived: !!on }); },
    async setDefault(id, on) { return rpc("studio_template_set_default", { p_id: id, p_on: !!on }); },
    async duplicate(id) { return rpc("studio_template_duplicate", { p_id: id }); },
  };
  // 0108 dashboard_money: exact booked / collected (payment ledger) / outstanding / overdue / pipeline
  // for the dashboard. null when not on Supabase or 0108 isn't installed (the dashboard falls back
  // to its own client-side sums); not-authorized also gives null so the card simply hides money.
  const dashboard = {
    async money(months) {
      if (mode !== "supabase" || !supa) return null;
      const n = Math.min(24, Math.max(1, Math.round(Number(months) || 12)));
      // final-1022 (0154): ask in the studio's own currency (studio tax setting), so a stale
      // organizations.currency (e.g. USD on an INR studio) no longer blanks Business; older DBs fall back
      let cur = ""; try { cur = String(BPStore.studioCurrency() || "").toUpperCase(); } catch (e) {}
      if (/^[A-Z]{3}$/.test(cur)) {
        try { const d = await rpc("dashboard_money_for", { p_months: n, p_currency: cur }); return d && typeof d === "object" ? d : null; }
        catch (e) { const st = Number(e && e.status) || 0; if (e && e.code === "42501") return null;
          if (!(rpcMissing(e) || st === 404)) throw e; }
      }
      try { const d = await rpc("dashboard_money", { p_months: n }); return d && typeof d === "object" ? d : null; }
      catch (e) { const st = Number(e && e.status) || 0;
        if (rpcMissing(e) || st === 404 || (e && e.code === "42501")) return null; throw e; }
    },
    // 0121 dashboard_due_today: payment milestones due today (studio time zone). null = not installed / no finance view
    async dueToday() {
      if (mode !== "supabase" || !supa) return null;
      try { const d = await rpc("dashboard_due_today", {}); return d && typeof d === "object" ? d : null; }
      catch (e) { const st = Number(e && e.status) || 0;
        if (rpcMissing(e) || st === 404 || (e && e.code === "42501")) return null; throw e; }
    },
    // 0109 user_dashboard_prefs: this user's own layout + desk notes in the current studio. FAIL SOFT:
    // prefs() -> null when not on Supabase / 0109 not applied / any error (caller keeps its default
    // order + localStorage). save*() never throw: true = saved, null = backend unavailable, false = error.
    async prefs() {
      if (mode !== "supabase" || !supa) return null;
      try { const d = await rpc("my_dashboard_prefs", {}); return d && typeof d === "object" ? d : null; }
      catch (e) { return null; }
    },
    cleanLayout(x) {
      const ID = /^[a-z][a-z0-9_-]{0,31}$/;
      const list = (a) => { const out = []; if (Array.isArray(a)) for (const v of a) { if (typeof v === "string" && ID.test(v) && out.indexOf(v) < 0 && out.length < 40) out.push(v); } return out; };
      const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
      const order = list(o.order), hidden = list(o.hidden);
      return (order.length || hidden.length) ? { v: 1, order, hidden } : {};
    },
    async saveLayout(layout) {
      if (mode !== "supabase" || !supa) return null;
      try { await rpc("save_dashboard_layout", { p_layout: dashboard.cleanLayout(layout) }); return true; }
      catch (e) { const st = Number(e && e.status) || 0; return (rpcMissing(e) || st === 404) ? null : false; }
    },
    async saveNotes(text) {
      if (mode !== "supabase" || !supa) return null;
      try { await rpc("save_desk_notes", { p_text: String(text == null ? "" : text).slice(0, 2000) }); return true; }
      catch (e) { const st = Number(e && e.status) || 0; return (rpcMissing(e) || st === 404) ? null : false; }
    },
  };
  const insights = {
    presets: () => RANGE_PRESETS.map((p) => ({ key: p[0], label: p[1] })),
    rangeFor, rangeCheck, inRange,
    // 0077 insights_events: per-event profit rows (money null without finance)
    async events(from, to) {
      if (mode !== "supabase" || !supa) return null;
      // QA-FR2 / 0113: prefer the ex-tax wrapper (adds revenue_ex_tax / profit_ex_tax per row); older DB → plain rows
      try { return await rpc("insights_events_ex_tax", { p_from: from || null, p_to: to || null }); }
      catch (e0) { if (!rpcMissing(e0)) throw e0; }
      try { return await rpc("insights_events", { p_from: from || null, p_to: to || null }); }
      catch (e) { if (rpcMissing(e)) { const er = new Error("Per-event profit needs database update 0077 (ask your admin to run APPLY-0077.sql)."); er.code = "insights_events_missing"; throw er; } throw e; }
    },
    // r21 (0240) insights_event_costs: per-event cost split (vendors / crew / logistics / rentals / change orders /
    // other / expense claims / refunds), profit = event_pnl, type, guests, collected / outstanding. Finance only.
    async costs(from, to) {
      if (mode !== "supabase" || !supa) return null;
      try { return await rpc("insights_event_costs", { p_from: from || null, p_to: to || null }); }
      catch (e) { if (rpcMissing(e)) { const er = new Error("Event cost charts need database update 0240 (ask your admin to run APPLY-0240.sql)."); er.code = "insights_costs_missing"; throw er; } throw e; }
    },
    // r21 (0242) ONE studio-wide target margin for the Benchmarks card (was per device).
    // -> { target_margin_pct (null = not set; screens use default_pct 30), default_pct, can_edit, updated_at };
    //    null when signed out / the server is older than 0242. Readers: insights OR controls view (admins always).
    async targetMargin() {
      if (mode !== "supabase" || !supa) return null;
      try { return await rpc("get_studio_target_margin", {}); }
      catch (e) { if (rpcMissing(e)) return null; throw e; }
    },
    // Control Center edit / admins only (server re-checks has_area('controls','edit')); 0 to 90, kept to 1 decimal
    async setTargetMargin(pct) {
      const raw = String(pct == null ? "" : pct).trim(), n = Number(raw);
      if (raw === "" || !isFinite(n) || n < 0 || n > 90) throw Object.assign(new Error("Target margin must be a number from 0 to 90."), { code: "22023" });
      if (mode !== "supabase" || !supa) throw new Error("The target margin needs a signed-in studio.");
      try { return await rpc("set_studio_target_margin", { p_pct: Math.round(n * 10) / 10 }); }
      catch (e) { if (rpcMissing(e)) { const er = new Error("Saving the target margin needs database update 0242 (ask your admin to run APPLY-0242.sql)."); er.code = "target_margin_missing"; throw er; } throw e; }
    },
    // 0076 insights_range: counts, money (null without finance), top types, staff participation
    async range(from, to) {
      if (mode !== "supabase" || !supa) return null;
      try { return await rpc("insights_range", { p_from: from || null, p_to: to || null }); }
      catch (e) { if (rpcMissing(e)) { const er = new Error("Date-range insights need database update 0076 (ask your admin to run APPLY-0076.sql)."); er.code = "insights_missing"; throw er; } throw e; }
    },
    // r = { from, to } (optional): tasks of events dated in the range, losses checked in during
    // it, closed events dated in it. No r = all time (Reports' P&L export without a range).
    async summary(r) {
      const empty = { vendors: [], taskSlips: [], losses: { total: 0, byItem: [], byMonth: [] }, margins: { events: [], withRevenue: [], noRevenue: [], totalProfit: 0, avgMargin: null } };
      if (mode !== "supabase" || !supa) return empty;
      // Wave 16 perf: fetch the event list alongside the three aggregates instead
      // of awaiting it first (it isn't an input to them) — removes one serial round-trip.
      const [events, tR, cR, iR] = await Promise.all([
        quotes.list(),
        // D4: all rows, not the first 1000 (a failed read stays an empty aggregate, as before)
        sbAll(() => supa.from("event_tasks").select("id,category,status,verify_status,assignee_kind,assignee_name,quote_id").order("id")).then((data) => ({ data }), () => ({ data: null })),
        sbAll(() => supa.from("inventory_checkouts").select("id,item_id,qty_out,qty_in,checked_in_at,status").order("id")).then((data) => ({ data }), () => ({ data: null })),
        sbAll(() => supa.from("inventory_items").select("id,name,unit").order("id")).then((data) => ({ data }), () => ({ data: null })),
      ]);
      const evDate = (e) => e.eventDate || String(e.createdAt || e.created_at || "").slice(0, 10);
      const inEv = r ? new Set(events.filter((e) => inRange(evDate(e), r)).map((e) => e.id)) : null;
      const tasks = (tR.data || []).filter((t) => !inEv || inEv.has(t.quote_id)), items = iR.data || [];
      const chk = (cR.data || []).filter((c) => !r || inRange(c.checked_in_at, r));
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
      const closed = events.filter((e) => e.lifecycleStage === "closed" && (!r || inRange(evDate(e), r)));
      const pls = await Promise.all(closed.map((e) => closure.pl(e.id)
        .then((pl) => ({ code: e.code, date: e.eventDate, profit: pl.profit, marginPct: pl.marginPct, revenue: pl.revenue, currency: BPStore.quoteCurrency(e) })).catch(() => null)));
      const mlist = pls.filter(Boolean).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const totalProfit = mlist.reduce((a, x) => a + (x.profit || 0), 0);
      // R4: a closed event with no revenue recorded has no margin - keep it out of the chart
      // and the average (it is listed separately as "no revenue recorded"); events stays the
      // full list for the Reports P&L export.
      const withRevenue = mlist.filter((x) => Number(x.revenue) > 0);
      const noRevenue = mlist.filter((x) => !(Number(x.revenue) > 0));
      const avgMargin = withRevenue.length ? Math.round(withRevenue.reduce((a, x) => a + (x.marginPct || 0), 0) / withRevenue.length) : null;
      // 0094: profit and the average margin per currency (never ₹ + AED added together)
      const byCurrency = BPStore.sumByCurrency(mlist, (x) => x.profit || 0, (x) => x.currency).map((g) => {
        const w = withRevenue.filter((x) => x.currency === g.currency);
        return { currency: g.currency, events: g.count, totalProfit: g.total,
          revenue: Math.round(mlist.filter((x) => x.currency === g.currency).reduce((a, x) => a + (Number(x.revenue) || 0), 0) * 100) / 100,
          avgMargin: w.length ? Math.round(w.reduce((a, x) => a + (x.marginPct || 0), 0) / w.length) : null };
      });
      return { vendors, taskSlips, losses, margins: { events: mlist, withRevenue, noRevenue, totalProfit, avgMargin, byCurrency } };
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
    if (s.charAt(0) === "+" && d.slice(0, 2) !== "91") return /^[1-9]\d{6,14}$/.test(d) ? "+" + d : null;   // 0055: international
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
  // r7: repair UTF-8 text that was decoded as MacRoman / Windows-1252 ("long dash" garbage)
  const MOJI = [["\u201a\u00c4\u00ee", "\u2014"], ["\u201a\u00c4\u00ec", "\u2013"], ["\u201a\u00c4\u00f4", "\u2019"], ["\u201a\u00c4\u00b6", "\u2026"],
    ["\u00e2\u20ac\u201d", "\u2014"], ["\u00e2\u20ac\u201c", "\u2013"], ["\u00e2\u20ac\u2122", "\u2019"], ["\u00e2\u20ac\u00a6", "\u2026"]];
  function demojibake(t) { let s = String(t == null ? "" : t); MOJI.forEach(([a, b]) => { s = s.split(a).join(b); }); return s; }
  global.HelmDemojibake = demojibake;
  // r7: a phone for staff / nurture → { ok, value: E.164 | null, error }. Digits with an optional
  // leading +, 7–15 digits; spaces . - ( ) ignored; a bare 10-digit (or 0 + 10) number is India (+91).
  function memberPhoneE164(raw, required) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return required ? { ok: false, error: "Phone number is required." } : { ok: true, value: null };
    let c = s.replace(/[\s\-().]/g, "");
    if (/^00\d/.test(c)) c = "+" + c.slice(2);
    if (!/^\+?\d{7,15}$/.test(c)) return { ok: false, error: "Enter a valid phone number: 7–15 digits, optional leading +." };
    if (c[0] === "+") {
      // per-country national length (UAE 9 / India 10 / US 10 …) when the phone library is loaded
      const HP = typeof window !== "undefined" ? window.HelmPhone : null;
      if (HP && HP.validate) { const r = HP.validate(c); return r.ok ? { ok: true, value: r.e164 } : { ok: false, error: r.error }; }
      return { ok: true, value: c };
    }
    // 0092: a UAE / US studio's numbers typed without a code get +971 / +1 (India unchanged below)
    var k0 = ""; try { k0 = (BPStore.studioTax() || {}).country || ""; } catch (e) {}
    if ((k0 === "AE" || k0 === "US") && BPStore.waNumber) { var w0 = BPStore.waNumber(c, k0); if (w0) return { ok: true, value: "+" + w0 }; }
    if (/^\d{10}$/.test(c)) return { ok: true, value: "+91" + c };
    if (/^0\d{10}$/.test(c)) return { ok: true, value: "+91" + c.slice(1) };
    return { ok: true, value: "+" + c };
  }
  function phoneOrThrow(raw, required) { const r = memberPhoneE164(raw, required); if (!r.ok) { const e = new Error(r.error); e.code = "invalid_phone"; throw e; } return r.value; }
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
      else if (!memberMobile(f.phone)) bad.phone = "Enter a valid mobile number — Indian mobiles are 10 digits starting with 6, 7, 8 or 9."; }
    if (has("whatsapp") && f.whatsapp_same === false && String(f.whatsapp == null ? "" : f.whatsapp).trim() && !memberMobile(f.whatsapp))
      bad.whatsapp = "Enter a valid WhatsApp number — Indian mobiles are 10 digits starting with 6, 7, 8 or 9.";
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

  /* ---------------- audit log: plain-words rendering (0076 pass) ----------------
     Pure helpers (unit-tested in test/insights-audit.test.mjs). Rows like
     "booklet.view · client_booklets" used to fall through to the insert/delete branch and
     read "Deleted id <uuid>". Each known action now has its own sentence; unknown dotted
     actions are humanised ("hq.plan.upsert" → "Hq plan upsert"), never called a deletion. */
  const AUDIT_AREA_LABELS = { role_access: "Access matrix", app_config: "Pricing settings", plate_types: "Plate types", chair_types: "Chair types",
    quote_payments: "Payments", event_costs: "Budget & costs", inventory_items: "Inventory", inventory_checkouts: "Equipment check-in/out",
    change_requests: "Change orders", expense_claims: "Expense claims", payment_milestones: "Payment milestones", crew_members: "Crew",
    vendors: "Vendors", coupons: "Coupons", profiles: "Users & roles", quotes: "Events", leads: "Leads", member_profiles: "Team profiles",
    client_booklets: "Client booklet", package_selections: "Package choices", design_stages: "Design", "storage.objects": "File uploads",
    work_links: "Work links", event_sites: "Invitation sites", notification_prefs: "Notification settings", studio_account: "Studio billing",
    subscriptions: "Subscription", mfa: "Two-step sign-in", chat_conversations: "Team chat", organizations: "Studio details",
    vendor_bills: "Vendor bills", vendor_payouts: "Vendor payouts", inventory_reservations: "Inventory reservations", run_sheet_items: "Run sheet" };
  function auditHuman(s) { s = String(s == null ? "" : s).replace(/[._]+/g, " ").replace(/\s+/g, " ").trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function auditAreaLabel(e) { return AUDIT_AREA_LABELS[e] || auditHuman(e) || "—"; }
  // actions a CLIENT triggers through a link (no signed-in actor) — shown as "Client", not "system"
  const AUDIT_CLIENT_ACTIONS = /^(booklet\.(view|read)|pkg\.(view|read|choose|otp|otp_request))$/;
  function auditActionLabel(a) {
    a = String(a || "");
    const m = { insert: "Created", update: "Edited", delete: "Deleted" };
    if (m[a]) return m[a];
    const fixed = { "booklet.view": "Viewed", "booklet.read": "Viewed", "booklet.share": "Shared", "booklet.revoke": "Link revoked",
      "booklet.snapshot": "Snapshot", "booklet.snap": "Snapshot", "pkg.view": "Viewed", "pkg.choose": "Chose", "pkg.accept": "Accepted",
      "pkg.decline": "Declined", "pkg.adjust": "Adjusted", "quote.moved_to_archive": "Archived", "quote.moved_to_deleted": "Moved to bin",
      "quote.restored": "Restored", "design.advance": "Stage moved", "upload.rejected": "Rejected" };
    if (fixed[a]) return fixed[a];
    const last = a.split(".").pop(); return auditHuman(last) || "—";
  }
  // "for W-0012 · Sharma wedding" when the event is known, else ""
  function auditEventText(row, events) {
    const ev = row && row.quote_id && events ? events[row.quote_id] : null;
    if (!ev) return "";
    const t = [ev.code, ev.title].filter((x) => x && String(x).trim()).join(" · ");
    return t ? " for " + t : "";
  }
  // One plain sentence for a row, or null when the generic field-diff view is better
  // (insert / update / delete of ordinary tables and profile.* changes keep their detail view).
  function auditDescribe(row, events) {
    row = row || {}; const a = String(row.action || ""); const c = (row.changed && typeof row.changed === "object") ? row.changed : {};
    const ev = auditEventText(row, events);
    const kindLabel = (k) => ({ snapshot_3d: "3D snapshot", snapshot_2d: "2D snapshot", layout: "layout snapshot", cover: "cover image" }[k] || auditHuman(k) || "snapshot");
    switch (a) {
      case "booklet.view": case "booklet.read": return "Client viewed the booklet" + ev;
      case "booklet.share": return "Booklet shared with the client" + ev + (c.expires_at ? " (link valid until " + String(c.expires_at).slice(0, 10) + ")" : "");
      case "booklet.revoke": return "Booklet link revoked" + ev;
      case "booklet.link_sent": return "Booklet link " + (c.status === "skipped" ? "not sent (" + (c.reason === "free_trial" ? "free trial test mode" : c.reason === "demo" ? "demo event" : "skipped") + ")" : "sent")
        + (c.channel === "whatsapp" ? " on WhatsApp" : c.channel === "email" ? " by email" : "") + (c.to ? " to " + String(c.to).slice(0, 80) : "") + ev;
      case "booklet.snapshot": case "booklet.snap": return auditHuman(kindLabel(c.kind)) + (c.set === false ? " removed" : " updated") + " in the booklet" + ev;
      case "booklet.log": return "Booklet activity" + ev;
      case "pkg.view": case "pkg.read": return "Client viewed the package options" + ev;
      case "pkg.choose": return "Client chose a package" + ev + (c.guests ? " for " + c.guests + " guests" : "");
      case "pkg.accept": return "Package choice accepted" + ev;
      case "pkg.decline": return "Package choice declined" + ev + (c.reason ? " — " + String(c.reason).slice(0, 80) : "");
      case "pkg.adjust": return "Package price adjusted" + ev + (c.per_person != null ? " (" + (typeof BPStore !== "undefined" && BPStore.studioMoney ? BPStore.studioMoney(c.per_person) : "\u20b9" + c.per_person) + " per guest)" : "");
      case "pkg.otp": case "pkg.otp_request": return "Client asked for a verification code" + ev;
      case "pkg.self_approve_override": return "Package approved by the only admin (maker-checker override)" + ev;
      case "quote.moved_to_archive": return "Event archived" + ev + (c.auto ? " automatically (link expired)" : "");
      case "quote.moved_to_deleted": return "Event moved to the bin" + ev + (c.auto ? " automatically (link expired)" : "");
      case "quote.restored": return "Event restored" + ev + (c.from ? " from " + c.from : "");
      case "design.advance": return "Design stage moved" + ev + (c.from || c.to ? ": " + auditHuman(c.from || "start") + " → " + auditHuman(c.to || "") : "");
      case "upload.rejected": return "Uploaded file rejected" + (c.reason ? " — " + String(c.reason).slice(0, 80) : "");
      case "work_links.revoked": return "Work links revoked" + ev;
      case "event_site.reslugged": return "Invitation site address changed" + ev;
      case "event_site.link_sent": return "Invitation website link " + (c.status === "skipped" ? "not sent (" + (c.reason === "free_trial" ? "free trial test mode" : c.reason === "demo" ? "demo event" : "skipped") + ")" : "sent")
        + (c.channel === "whatsapp" ? " on WhatsApp" : c.channel === "email" ? " by email" : "") + (c.to ? " to " + String(c.to).slice(0, 80) : "") + ev;
      case "chat.event_group.create": return "Event chat group created" + ev;
      case "notification_pref.set": return "Notification setting changed";
      case "notification_pref.reset": return "Notification settings reset to default";
      case "link_autoexpire.set": return "Link auto-expiry setting changed";
      case "link_expiry_shelf.set": return "Expired-link shelf setting changed";
      case "profiles.role": return "Role changed" + (c.role ? " to " + auditHuman(c.role) : "");
      case "profiles.delete": return "User removed from the studio";
      case "mfa.record": return "Two-step sign-in updated";
      case "subscription.trial_started": return "Free trial started";
      case "subscription.checkout_created": return "Subscription checkout opened";
      case "studio_account.update": return "Studio billing details updated";
      default: break;
    }
    if (/^(insert|update|delete)$/.test(a) || /^profile\./.test(a)) return null;
    return (auditHuman(a) || "Activity") + ev;
  }
  // who: display name, else e-mail, else "Client" for link-driven actions, else "System"
  function auditWho(row, names) {
    row = row || {}; const p = (names && row.actor && names[row.actor]) || null;
    // 0164: a change made straight in the database (not by a studio user) is tagged by the server
    if (!row.actor && row.actor_email === "helm:maintenance") return { text: "System maintenance", title: "Changed directly in the database, not by a studio user" };
    const nm = p && String(p.full_name || "").replace(/\s+/g, " ").trim();
    const email = row.actor_email || (p && p.email) || "";
    if (nm) return { text: nm, title: email || nm };
    if (email) return { text: email, title: email };
    if (!row.actor && AUDIT_CLIENT_ACTIONS.test(String(row.action || ""))) return { text: "Client", title: "Through the client's link" };
    return { text: "System", title: "Automatic" };
  }

  /* quote activity trail (event_activity): "advance_paid → client@x.com" / "pkg_payment → " in plain words */
  function activityText(a, ctx) {
    a = a || {}; ctx = ctx || {}; const raw = String(a.text || "");
    // 0092: the quote's own currency when the caller passes it (ctx.quote), else the studio's (India unchanged)
    const B = typeof BPStore !== "undefined" ? BPStore : null;
    const money = (n) => B && ctx.quote && B.quoteMoney ? B.quoteMoney(Number(n), ctx.quote) : B && B.studioMoney ? B.studioMoney(Number(n)) : "\u20b9" + Number(n).toLocaleString("en-IN");
    if (a.kind === "payment") {
      const m = /^Payment (created|failed|refunded|cancelled) — (\d+(?:\.\d+)?)$/.exec(raw);
      if (m) return ({ created: "Payment link created", failed: "Payment attempt failed", refunded: "Payment refunded", cancelled: "Payment link cancelled" }[m[1]]) + " — " + money(m[2]);
      const p = /^Payment (\S*) — (\d+(?:\.\d+)?) \((.*)\)$/.exec(raw);
      if (p) return "Payment received" + (ctx.clientName ? " from " + String(ctx.clientName).trim() : "") + " — " + money(p[2]) + " by " + auditHuman(p[3]).toLowerCase() + (p[1] ? " (receipt " + p[1] + ")" : "");
      return raw;
    }
    if (a.kind !== "notify") return raw;
    const i = raw.indexOf(" → "); const kind = (i >= 0 ? raw.slice(0, i) : raw).trim(); const to = (i >= 0 ? raw.slice(i + 3) : "").trim();
    const what = ({ advance_paid: "Payment received — receipt sent", payment_received: "Payment received — receipt sent", pkg_payment: "Package payment received",
      payment_receipt: "Payment receipt sent", payment_link: "Payment link sent", payment_reminder: "Payment reminder sent", payment_reconcile: "Payment flagged for checking",
      approval_link: "Approval link sent", otp: "Approval code sent", pkg_selected: "Client chose a package", pkg_accepted: "Package choice accepted",
      pkg_declined: "Package choice declined", task_assigned: "Tasks assigned", task_complete: "Task completed", booklet_shared: "Booklet shared",
      client_follow_up: "Follow-up sent" }[kind])
      || auditHuman(kind) || "Notification";
    if (!to) return what;
    const via = /^(email|e-mail|mail)$/i.test(to) ? "by e-mail" : /^(whatsapp|wa|sms)$/i.test(to) ? "on " + (to.toLowerCase() === "sms" ? "SMS" : "WhatsApp")
      : /@/.test(to) ? "by e-mail" : /^\+?[0-9 ()-]{7,}$/.test(to) ? "on WhatsApp/SMS" : "";
    const who = ctx.clientName ? String(ctx.clientName).trim() : "";
    const addr = (/@/.test(to) || /^\+?[0-9 ()-]{7,}$/.test(to)) ? to : "";
    return what + (who || addr ? " to " + (who || addr) : "") + (who && addr ? " (" + addr + ")" : "") + (via ? " " + via : (!addr && to ? " · " + to : ""));
  }

  /* ---------------- date ranges for Insights / Reports (pure; local calendar dates) ---------------- */
  const RANGE_PRESETS = [["this_month", "This month"], ["last_month", "Last month"], ["last_30", "Last 30 days"], ["last_60", "Last 60 days"],
    ["last_90", "Last 90 days"], ["this_year", "This year"], ["custom", "Custom range"]];
  function rangeFor(key, today) {
    const d0 = (today && typeof today.getFullYear === "function") ? new Date(today.getFullYear(), today.getMonth(), today.getDate()) : new Date();
    const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const y = d0.getFullYear(), m = d0.getMonth();
    const back = (n) => { const d = new Date(y, m, d0.getDate() - (n - 1)); return { from: iso(d), to: iso(d0) }; };
    switch (key) {
      case "this_month": return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
      case "last_month": return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
      case "last_30": return back(30);
      case "last_60": return back(60);
      case "last_90": return back(90);
      case "this_year": return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) };
      default: return null;
    }
  }
  // a custom from/to: both real YYYY-MM-DD dates and from <= to → {from,to}, else null
  function rangeCheck(from, to) {
    const ok = (s) => { s = String(s || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + "T00:00:00Z"); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
    if (!ok(from) || !ok(to) || String(from) > String(to)) return null;
    return { from: String(from), to: String(to) };
  }
  // is a YYYY-MM-DD (or ISO timestamp) inside {from,to}? null range = everything
  // r9: a full timestamp (created_at / paid_at, stored in UTC) is compared by its LOCAL calendar
  // day — 2026-09-30T20:00Z is 1 Oct in IST and belongs to October, not September.
  function inRange(date, r) { if (!r) return true; const s = String(date || ""); let d = s.slice(0, 10);
    if (s.length > 10 && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const t = new Date(s.replace(" ", "T"));
      if (!isNaN(t.getTime())) d = t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); }
    if (!d) return false; return d >= r.from && d <= r.to; }

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
      // vendor_payouts rows carry bill_id, not quote_id: resolve the event through the bill so the
      // EVENT column links like the bill / payment rows (read-only, best effort; RLS-scoped).
      const billIds = [...new Set(rows.filter((r) => r.entity === "vendor_payouts" && !r.quote_id && r.changed && r.changed.bill_id)
        .map((r) => String(r.changed.bill_id)).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 100);
      if (billIds.length) { try { const { data: bl } = await supa.from("vendor_bills").select("id, quote_id").in("id", billIds);
        const m = {}; (bl || []).forEach((b) => { if (b && b.quote_id) m[b.id] = b.quote_id; });
        rows.forEach((r) => { if (r.entity === "vendor_payouts" && !r.quote_id && r.changed && m[r.changed.bill_id]) r.quote_id = m[r.changed.bill_id]; }); } catch (_) {} }
      return { rows, hasMore: d.length > limit, offset: rows.length ? rows[rows.length - 1] : (o.after || null) }; },
    // Areas for the filter: every audited table, plus any other area seen in the recent
    // log (was: the WHOLE log's entity column, every row, on every visit).
    AREAS: ["app_config", "chair_types", "change_requests", "coupons", "crew_members", "event_costs", "expense_claims", "inventory_checkouts",
      "inventory_items", "member_profiles", "payment_milestones", "plate_types", "profiles", "quote_payments", "quotes", "role_access", "vendors", "leads", "vendor_bills", "vendor_payouts", "inventory_reservations", "run_sheet_items"],
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
    describe: auditDescribe, actionLabel: auditActionLabel, areaLabel: auditAreaLabel, who: auditWho,
    // { <quote id>: { code, title } } for the events named on a page of the log (RLS decides; {} on error)
    async eventLabels(ids) { const list = [...new Set((ids || []).filter((x) => /^[0-9a-f-]{36}$/i.test(String(x))))].slice(0, 200);
      if (!supa || !list.length) return {};
      try { const { data, error } = await supa.from("quotes").select("id,code,title").in("id", list); if (error) return {};
        const by = {}; (data || []).forEach((q) => { by[q.id] = { code: q.code, title: q.title }; }); return by; } catch (e) { return {}; } },
    async entities() { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("audit_log").select("entity").order("at", { ascending: false }).limit(1000); if (error) throw error;
      return [...new Set(this.AREAS.concat((data || []).map((x) => x.entity).filter(Boolean)))].sort(); },
  };

  /* ---------------- onboarding checkout (0056) ----------------
     Billing rules mirror the SQL checks on studio_account (0045): trimmed, legal name
     <= 160, address <= 500, state/city <= 80, ISO country, GSTIN format (optional).
     Card / UPI / netbanking data is NEVER collected here: paying opens Razorpay Standard
     Checkout (its own modal) for a subscription created server-side; the signature is
     verified server-side and the webhook stays the source of truth. Dormant → trial. */
  const CO_GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  const CO_BAD_TEXT = /[<>\u0000-\u001f]/;
  function coValidate(fields) {
    const f = fields && typeof fields === "object" ? fields : {};
    const t = (k) => String(f[k] == null ? "" : f[k]).replace(/\s+/g, " ").trim();
    const clean = {
      legal_business_name: t("legal_business_name"),
      gstin: t("gstin").toUpperCase().replace(/\s+/g, ""),
      billing_address: String(f.billing_address == null ? "" : f.billing_address).trim().replace(/[ \t]+/g, " "),
      city: t("city"), state: t("state"), country: t("country").toUpperCase(),
    };
    const errors = {};
    if (!clean.legal_business_name) errors.legal_business_name = "Enter your studio's legal name";
    else if (clean.legal_business_name.length > 160) errors.legal_business_name = "Keep it under 160 characters";
    else if (CO_BAD_TEXT.test(clean.legal_business_name)) errors.legal_business_name = "Remove < and > characters";
    if (clean.gstin && !CO_GSTIN.test(clean.gstin)) errors.gstin = "Enter a valid 15-character GSTIN, e.g. 36ABCDE1234F1Z5";
    if (clean.gstin && clean.country && clean.country !== "IN") errors.gstin = "GSTIN applies to Indian studios only";
    if (!clean.billing_address) errors.billing_address = "Enter your billing address";
    else if (clean.billing_address.length > 500) errors.billing_address = "Keep it under 500 characters";
    else if (/[<>]/.test(clean.billing_address)) errors.billing_address = "Remove < and > characters";
    if (clean.city.length > 80) errors.city = "Keep it under 80 characters";
    else if (CO_BAD_TEXT.test(clean.city)) errors.city = "Remove < and > characters";
    if (!clean.state) errors.state = "Enter your state or region";
    else if (clean.state.length > 80) errors.state = "Keep it under 80 characters";
    else if (CO_BAD_TEXT.test(clean.state)) errors.state = "Remove < and > characters";
    if (!/^[A-Z]{2}$/.test(clean.country)) errors.country = "Choose your country";
    return { ok: Object.keys(errors).length === 0, errors, clean };
  }
  // One error → {kind, message} for the page. Validation messages are shown as-is;
  // provider declines get a retry message; anything security-related (auth, rate
  // limit, permission) gets ONE generic message — never the details.
  const CO_SECURITY_MSG = "We couldn't verify this request. Please sign in again, or contact support if this keeps happening.";
  function coClassify(e) {
    const kind = e && typeof e === "object" ? String(e.kind || "") : "";
    const code = e && typeof e === "object" ? String(e.code || "") : "";
    const status = e && typeof e === "object" ? Number(e.status) || 0 : 0;
    const msg = String((e && e.message) || "");
    if (kind === "cancelled") return { kind: "cancelled", message: "Payment window closed — nothing was charged. You can try again whenever you're ready." };
    if (kind === "dormant" || status === 503) return { kind: "dormant", message: "Online payment is being enabled — your studio starts on a free trial." };
    if (kind === "security" || code === "42501" || status === 401 || status === 403 || status === 429 || /jwt|not authori[sz]ed|permission denied/i.test(msg))
      return { kind: "security", message: CO_SECURITY_MSG };
    if (kind === "declined" || status === 402 || status === 502)
      return { kind: "declined", message: msg && kind === "declined" ? msg : "The payment didn't go through. No money was taken — please try again or use another method." };
    if (kind === "validation" || code === "22023" || status === 400 || status === 409)
      return { kind: "validation", message: (msg || "Please check your details").replace(/[<>]/g, "").slice(0, 160) };
    if (e instanceof TypeError || /failed to fetch|network/i.test(msg)) return { kind: "network", message: "Couldn't reach Helm. Check your connection and try again." };
    return { kind: "server", message: "Something went wrong. Please try again." };
  }
  const CO_ONB = (CFG && CFG.onboarding) || {};
  const checkout = {
    // {required, is_admin, has_subscription, reason} | {missing:true} | null. Never throws.
    async status(o) {
      if (mode !== "supabase") return null;
      try { return await fetchCheckoutStatus(!!(o && o.fresh)); } catch (e) { return null; }
    },
    gateDecision: (st, page, role) => checkoutGateDecision(st, page, role),
    pageStays: (st) => checkoutPageStays(st),
    // where /checkout sends you afterwards (always one of the app's own pages)
    next: () => safeNext(nextParam()),
    url: (next) => checkoutUrl(next),
    // signed in and leaving login / profile-setup: a new studio owner goes to /checkout first
    async routeIfRequired(next) {
      if (mode !== "supabase" || !currentUser || pendingStep) return false;
      let st = null; try { st = await fetchCheckoutStatus(true); } catch (e) { return false; }
      if (checkoutGateDecision(st, "login", roleCache) !== "checkout") return false;
      try { location.replace(checkoutUrl(next)); } catch (e) { return false; }
      return true;
    },
    options: () => rpc("my_checkout_options"),
    preview: (plan, interval) => rpc("my_checkout_preview", { p_plan: String(plan || ""), p_interval: interval === "yearly" ? "yearly" : "monthly" }),
    validate: (fields) => coValidate(fields),
    classify: (e) => coClassify(e),
    // the client-side switch for the "Skip payment (testing only)" button (the server
    // flag helm_billing_settings.allow_trial_bypass is the real gate)
    bypassEnabled: () => CO_ONB.allowPaymentBypass === true,
    // online payment is offered only when BOTH config.js and HQ say it is live
    payLive: (opts) => !!(LIVE.pay && opts && opts.online_payments_live === true),
    // save billing details + accept the Terms (the server stamps the time)
    async saveBilling(fields, termsVersion) {
      const r = coValidate(fields);
      if (!r.ok) { const e = new Error("Please fix the highlighted fields"); e.kind = "validation"; e.fields = r.errors; throw e; }
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(String(termsVersion || ""))) { const e = new Error("Please accept the Terms of Service"); e.kind = "validation"; throw e; }
      const patch = Object.assign({}, r.clean, { terms_version_accepted: termsVersion });
      return rpc("my_studio_account_update", { p_account: patch });
    },
    async startTrial(source, plan) {
      const out = await rpc("my_start_trial", { p_source: source === "payment_pending" ? "payment_pending" : "bypass", p_plan: plan || null });
      noteCheckoutDone();
      return out;
    },
    // Edge function call → JSON; throws an Error carrying {kind, status}.
    async _fn(body) {
      if (!supa || !fnUrl("create-subscription-checkout")) { const e = new Error("dormant"); e.kind = "dormant"; throw e; }
      let token = "";
      try { const { data: { session } } = await supa.auth.getSession(); token = (session && session.access_token) || ""; } catch (e) {}
      if (!token) { const e = new Error("signed out"); e.kind = "security"; e.status = 401; throw e; }
      const res = await fetch(fnUrl("create-subscription-checkout"), { method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token, "apikey": CFG.anonKey },
        body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(String(j.error || ("HTTP " + res.status))); e.kind = j.kind || ""; e.status = res.status; throw e; }
      return j;
    },
    // create the Razorpay subscription server-side → {key_id, subscription_id}
    async begin(plan, interval) {
      const j = await checkout._fn({ plan: String(plan || ""), interval: interval === "yearly" ? "yearly" : "monthly" });
      if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(String(j.key_id || "")) || !/^sub_[A-Za-z0-9]{6,40}$/.test(String(j.subscription_id || ""))) {
        const e = new Error("bad provider answer"); e.kind = "declined"; e.status = 502; throw e; }
      return j;
    },
    // Razorpay Standard Checkout (the ONLY place payment details are entered). The exact
    // script URL is the one the /checkout CSP + Trusted Types allow.
    RAZORPAY_JS: "https://checkout.razorpay.com/v1/checkout.js",
    loadRazorpay() {
      if (typeof window === "undefined") return Promise.reject(Object.assign(new Error("no window"), { kind: "declined" }));
      if (typeof window.Razorpay === "function") return Promise.resolve(window.Razorpay);
      return new Promise((resolve, reject) => {
        const sc = document.createElement("script");
        sc.src = checkout.RAZORPAY_JS; sc.async = true;
        sc.onload = () => (typeof window.Razorpay === "function" ? resolve(window.Razorpay)
          : reject(Object.assign(new Error("The payment window couldn't load. Please try again."), { kind: "declined" })));
        sc.onerror = () => reject(Object.assign(new Error("The payment window couldn't load. Check your connection and try again."), { kind: "declined" }));
        document.head.appendChild(sc);
      });
    },
    // Razorpay "payment.failed" → an Error the page can classify. Risk / fraud /
    // authentication failures get the generic security message (never the reason).
    failure(resp) {
      const er = (resp && resp.error) || {};
      const reason = String(er.reason || "") + " " + String(er.code || "");
      const e = new Error(String(er.description || "").replace(/[<>]/g, "").slice(0, 160));
      e.kind = /risk|fraud|blocked|authenticat|security/i.test(reason) ? "security"
        : /BAD_REQUEST/i.test(reason) && /input|invalid/i.test(String(er.reason || "")) ? "validation" : "declined";
      return e;
    },
    // open the modal → resolves {verified} after the server checked the signature;
    // rejects {kind:"cancelled"} when the person closes it.
    async pay(plan, interval, prefill) {
      const { key_id, subscription_id } = await checkout.begin(plan, interval);
      const Rzp = await checkout.loadRazorpay();
      const resp = await new Promise((resolve, reject) => {
        const p = prefill && typeof prefill === "object" ? prefill : {};
        const rz = new Rzp({ key: key_id, subscription_id, name: "Helm Events", description: "Helm subscription",
          prefill: { name: String(p.name || "").slice(0, 100), email: String(p.email || "").slice(0, 200), contact: String(p.contact || "").slice(0, 20) },
          theme: { color: "#6C4CF1" },
          handler: (r) => resolve(r),
          modal: { ondismiss: () => reject(Object.assign(new Error("Payment cancelled"), { kind: "cancelled" })), escape: true } });
        try { rz.on("payment.failed", (r) => reject(checkout.failure(r))); } catch (e) {}
        rz.open();
      });
      const v = await checkout._fn({ action: "verify", razorpay_payment_id: String(resp.razorpay_payment_id || ""),
        razorpay_subscription_id: String(resp.razorpay_subscription_id || subscription_id), razorpay_signature: String(resp.razorpay_signature || "") });
      if (v && v.verified === true) noteCheckoutDone();
      return v;
    },
    done: () => noteCheckoutDone(),
    // 0159: a directly created studio waiting for its first payment can switch to the normal
    // free trial (own data) while online payment is not live. Server decides; no card, no money.
    async switchToTrial() {
      if (mode !== "supabase" || !supa) { const e = new Error("Needs a signed-in studio."); e.kind = "validation"; throw e; }
      const out = await rpc("my_pending_start_trial", {});
      noteCheckoutDone();
      return out;
    },
    // r21 (0244): "Contact sales" is saved in Helm (HQ Requests + an e-mail alert to sales) - studio admin only.
    // { id, status: "received", duplicate }; null when the server is older than 0244 (the page then falls back to e-mail).
    requestSales: (c) => {
      const a = c || {};
      if (mode !== "supabase" || !supa) return Promise.resolve(null);
      return rpc("request_plan_activation", { p_plan: String(a.plan || ""), p_interval: a.interval === "yearly" ? "yearly" : "monthly",
        p_studio: String(a.studio || ""), p_name: String(a.name || ""), p_email: String(a.email || ""), p_phone: String(a.phone || "") || null,
        p_message: String(a.message || "") || null, p_source: a.source === "read_only_banner" ? "read_only_banner" : "checkout" })
        .catch((e) => { if (rpcMissing(e)) return null; throw e; });
    },
    // the contact address shown while online payment is being set up
    SALES_EMAIL: "sales@helm.events",
  };

  /* ---------------- 0078 automatic client messages + WhatsApp forwarding ----------------
     Settings live server-side (comms_settings, Control Center admins). Sending is done ONLY by the
     server (cron + the dormant comms-dispatch edge function); the browser never sends. */
  // {placeholder} preview — mirrors public._comms_render (unknown placeholders stay as typed)
  function commsRender(tpl, vars) {
    let out = String(tpl == null ? "" : tpl); const v = vars || {};
    Object.keys(v).forEach((k) => { out = out.split("{" + k + "}").join(String(v[k] == null ? "" : v[k])); });
    return out.slice(0, 1000);
  }
  const COMMS_SAMPLE = { client: "Riya", studio: "your studio", event: "Riya's Wedding", label: "50% advance",
    amount: "Rs. 50,000", due: "12 Nov 2026", status: "due in 3 days" };
  const comms = {
    render: commsRender, sample: COMMS_SAMPLE,
    get: () => (supa ? rpc("comms_settings_get", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
    set: (patch) => (supa ? rpc("comms_settings_set", { p: patch || {} }) : Promise.reject(new Error("Automatic messages need a signed-in studio."))),
    // "Send reminder now" → { queued, already_queued }; null when the server is older than 0078
    remindNow: (milestoneId) => (supa ? rpc("payment_reminder_send_now", { p_milestone: milestoneId }).catch((e) => { if (rpcMissing(e)) return null; throw e; })
      : Promise.resolve(null)),
    myForward: () => (supa ? rpc("my_wa_forward_get", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
    setMyForward: (on) => (supa ? rpc("my_wa_forward_set", { p_on: !!on }) : Promise.reject(new Error("Needs a signed-in studio."))),
    // 0129 event-approaching reminders: { days, can_edit } / { days, items:[{quote_id,code,title,event_date,days_left}] }; null before 0129
    reminderGet: () => (supa ? rpc("event_reminder_settings_get", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
    reminderSet: (days) => (supa ? rpc("event_reminder_settings_set", { p_days: days }) : Promise.reject(new Error("Needs a signed-in studio."))),
    reminderUpcoming: () => (supa ? rpc("event_reminder_upcoming", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
  };

  // 0241 (r21): delivery / arrival reminders. Every call goes through the RPCs (studio + 'deliveries' area checked
  // in the database). null from settings() = the server is older than 0241.
  const DLV_STATUS = { scheduled: "Scheduled", reminded: "Reminded", confirmed: "On the way", arrived: "Arrived",
    delayed: "Delayed", issue: "Problem", cancelled: "Cancelled", edited: "Edited", no_response: "No response" };
  const deliveries = {
    STATUS: DLV_STATUS,
    statusLabel: (s) => DLV_STATUS[s] || String(s || ""),
    settings: () => (supa ? rpc("delivery_settings_get", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
    saveSettings: (patch) => (supa ? rpc("delivery_settings_set", { p: patch || {} }) : Promise.reject(new Error("Needs a signed-in studio."))),
    list: (quoteId) => (supa ? rpc("delivery_list", { p_quote: quoteId || null, p_from: null, p_to: null }).then((d) => (Array.isArray(d) ? d : []))
      : Promise.resolve([])),
    save: (row) => (supa ? rpc("delivery_save", { p: row || {} }) : Promise.reject(new Error("Needs a signed-in studio."))),
    setStatus: (id, status, note, eta) => (supa ? rpc("delivery_set_status", { p_id: id, p_status: status, p_note: note || null, p_eta: eta || null })
      : Promise.reject(new Error("Needs a signed-in studio."))),
    history: (id) => (supa ? rpc("delivery_history", { p_id: id }) : Promise.resolve({ log: [], reminders: [] })),
    issueLink: (id) => (supa ? rpc("delivery_link_issue", { p_id: id }) : Promise.reject(new Error("Needs a signed-in studio."))),
    linkUrl: (token) => (/^[0-9a-f]{64}$/.test(String(token || "")) ? location.origin + "/delivery?t=" + token : ""),
  };

  // 0117 studio integration accounts + 0134 read-only overview (Integrations page). null = server too old.
  const integrations = {
    overview: () => (supa ? rpc("integrations_overview", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
    mine: () => (supa ? rpc("my_integration_accounts", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
    saveRazorpay: (args) => (supa ? rpc("save_org_payment_account", args || {}) : Promise.reject(new Error("Needs a signed-in studio."))),
    saveWhatsapp: (args) => (supa ? rpc("save_org_whatsapp_account", args || {}) : Promise.reject(new Error("Needs a signed-in studio."))),
    setStatus: (args) => (supa ? rpc("set_org_integration_status", args || {}) : Promise.reject(new Error("Needs a signed-in studio."))),
    // 0150 studio e-mail sender name + reply-to (null before 0150)
    emailSettings: () => (supa ? rpc("studio_email_settings_get", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
    saveEmailSettings: (fromName, replyTo) => (supa ? rpc("studio_email_settings_set", { p_from_name: fromName || null, p_reply_to: replyTo || null }) : Promise.reject(new Error("Needs a signed-in studio."))),
    // 0150 integrations-test edge function: { email:{live}, whatsapp:{live,...} } or null when it is not deployed
    // manager-1019: capped at 5s - when the function is not deployed (CORS / preflight error) the page must not hang on it
    channelStatus: () => (supa && fnUrl("integrations-test")
      ? Promise.race([callFn("integrations-test", { action: "status" }).catch(() => null), new Promise((r) => setTimeout(() => r(null), 5000))])
      : Promise.resolve(null)),
    // { mode: "live" | "simulated", sent, to, from?, reply_to?, reason?, error? }; throws when not deployed / refused
    sendTest: (channel) => (supa && fnUrl("integrations-test") ? callFn("integrations-test", { action: "test", channel: channel }) : Promise.reject(new Error("Needs a signed-in studio."))),
  };

  const BPStore = {
    activityText, init, mode: () => mode, capacityStatus, shortageText, advanceIn, venueForQuote, auth, quotes, flowProgress, recents, approval, ops, config, vendors, coupons, chairTypes, plateTypes, dishCatalog, eventMenu, menuTemplates, quotationVersions, layoutRules, people, pricing, org, links, invitations, attendees, sites, leads, discovery, proposal, staff, inventory, resources, bookings, calendar, runsheet, budget, plan, checklist, milestones, readiness, dayops, guests, stockreq, issues, expenses, refunds, media, templates, nurture, settlement, closure, vendorBills, moneyLedger, bell, audit, insights, dashboard, venues, layoutTemplates, portal, files, chat, profile, quoteShelf, uploads, comms, deliveries, integrations,
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
    checkout,
    subscription: {
      mine: () => (supa ? rpc("my_subscription").catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      invoice: (id) => rpc("my_invoice", { p_payment_id: id }),
      account: () => (supa ? rpc("my_studio_account").catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      updateAccount: (patch) => rpc("my_studio_account_update", { p_account: patch || {} }),
      // 0058: {state:'trial'|'ended'|'none', days_left, ends_at, is_admin, can_pay}; null before 0058
      // 0173: {trial, cap: 2, used: {leads, quotes, inventory_items, vendors, crew_members, venues}}; null before 0173
      limits: () => (supa ? rpc("my_trial_limits").catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      // anon-42501: signed out = null ("not a trial") without asking the server
      trial: () => (supa ? trialSignedIn().then((ok) => (ok ? memoRead("trial", 15000, () => swr("trial", () => rpc("my_trial_status").catch((e) => { if (rpcMissing(e)) return null; throw e; }))) : null)) : Promise.resolve(null)),
      // 0212 — what reaches this studio's clients: {trial, active, email, whatsapp, sms, payment_links,
      // email_per_day, email_per_recipient_day, email_used_today}. Paid studio: everything true. An ACTIVE free
      // trial: e-mail true (capped), WhatsApp / SMS / payment links false. null before 0212 / signed out / error
      // (callers then keep the older "free trial = test mode" wording).
      messaging: () => (supa ? trialSignedIn().then((ok) => (ok ? rpc("my_trial_messaging").catch(() => null) : null)) : Promise.resolve(null)),
    },
    // 0157 — "Hide amounts" privacy PIN, ONE per studio. The server keeps only a bcrypt hash
    // (default 0000 until an admin changes it) and counts wrong tries per person.
    // status(): {is_default, can_change, updated_at, locked_seconds}; check(pin): {ok, tries_left, locked_seconds}.
    // Both return null before 0157 / in local mode (callers then fall back to the default 0000);
    // any other error still throws. set()/reset(): studio admins only (the server refuses others, 42501).
    privacyPin: {
      status: () => (supa ? rpc("privacy_pin_status").catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      check: (pin) => (supa ? rpc("privacy_pin_check", { p_pin: String(pin == null ? "" : pin) }).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      set: (current, next) => rpc("privacy_pin_set", { p_current: String(current == null ? "" : current), p_new: String(next == null ? "" : next) }),
      reset: () => rpc("privacy_pin_reset", {}),
    },
    // 0059 — dashboard "Getting started" checklist. Flags are computed server-side for the
    // caller's own studio (no personal data); dismissal is stored per member. Before 0059
    // (or local mode) → null, and the dashboard simply shows no checklist.
    // 0061 — universal studio search. studio_search() returns {kind: [{id,title,subtitle,link}]}
    // for the caller's own studio and only the areas their role may view. Before 0061, in
    // local mode, or for < 2 characters → {} (the palette then shows "no matches").
    // opts.signal (AbortSignal) cancels a stale request.
    search: (q, opts) => {
      const t = String(q == null ? "" : q).replace(/\s+/g, " ").trim().slice(0, 80);
      if (!supa || t.length < 2) return Promise.resolve({});
      let call = supa.rpc("studio_search", { p_q: t, p_limit: (opts && opts.limit) || 5 });
      const sig = opts && opts.signal;
      if (sig && call && typeof call.abortSignal === "function") call = call.abortSignal(sig);
      return Promise.resolve(call).then(({ data, error }) => {
        if (error) {
          if (rpcMissing(error)) return {};
          if (looksLikeAuthError(error)) onAuthFailure();
          throw error;
        }
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
      });
    },
    // 0062 — one page per client (client.html?id=<lead or event id>). client_timeline()
    // merges that person's leads, events, payments, files, tasks and event-chat messages in
    // the caller's own studio, only for the areas their role may view. Returns
    // {client:{name,phone,email,status}, totals, sections, counts, items:[{kind,at,id,title,subtitle,link}]}.
    // Not found / not allowed → the RPC error (P0002 / 42501). Before 0062 or local mode → null.
    clientTimeline: (id) => {
      const ref = String(id == null ? "" : id).trim();
      if (!supa || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return Promise.resolve(null);
      return rpc("client_timeline", { p_ref: ref, p_limit: 300 }).catch((e) => { if (rpcMissing(e)) return null; throw e; });
    },
    // 0095 — photo-realistic renders. The image model is called ONLY by the edge function
    // render-photo (its OpenAI key is a server secret, never in the browser). Dormant until the
    // owner sets OPENAI_API_KEY: render() then rejects with e.code === "render_not_configured".
    photoRender: {
      available: () => !!(supa && mode === "supabase" && fnUrl("render-photo")),
      // cheap pre-check: is the render-photo function deployed? (CORS preflight OPTIONS; no body,
      // no token). Resolves true / false; a not-deployed function answers 404 or fails the fetch.
      probe: () => {
        if (!(supa && mode === "supabase" && fnUrl("render-photo"))) return Promise.resolve(false);
        if (photoProbe) return photoProbe;
        photoProbe = fetch(fnUrl("render-photo"), { method: "OPTIONS" })
          .then((r) => r.status !== 404 && r.status < 500)
          .catch(() => false)
          .then((ok) => { if (!ok) photoProbe = null; return ok; });
        return photoProbe;
      },
      // { quote_id, prompt, n, quality, size, style, camera, theme, images:[{data}] } -> { renders:[{id,mime,data}], used, quota }
      render: async (payload, signal) => {
        if (!supa || mode !== "supabase" || !fnUrl("render-photo")) { const e = new Error("Photo renders need a signed-in studio."); e.code = "render_not_configured"; throw e; }
        let token = "";
        try { const { data: { session } } = await supa.auth.getSession(); token = (session && session.access_token) || ""; } catch (e) {}
        if (!token) { const e = new Error("Please sign in again."); e.code = "signed_out"; e.status = 401; throw e; }
        let res;
        try {
          res = await fetch(fnUrl("render-photo"), { method: "POST", signal,
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token, "apikey": CFG.anonKey },
            body: JSON.stringify(payload || {}) });
        } catch (fe) {
          if (fe && fe.name === "AbortError") throw fe;
          // network failure / CORS preflight 404 = the render-photo function is not deployed
          const e = new Error("Photo renders aren't switched on yet."); e.code = "render_not_configured"; e.cause = fe; throw e;
        }
        const j = await res.json().catch(() => ({}));
        // 404 without the function's own error code = the function is not deployed
        if (res.status === 404 && !j.error) { const e = new Error("Photo renders aren't switched on yet."); e.code = "render_not_configured"; e.status = 404; throw e; }
        if (!res.ok) { const e = new Error(String(j.message || j.error || ("HTTP " + res.status))); e.code = String(j.error || ""); e.status = res.status; throw e; }
        if (res.status !== 202 || !j.job_id) return j;
        // async render (0095): the server answered at once; poll the job, then load each photo
        const JOB_MSG = { timeout: ["render_timeout", "The render took too long - try standard quality or fewer images"],
          blocked: ["render_blocked", "The image service refused this request - change the decor theme and try again"],
          busy: ["render_busy", "The image service is busy - try again in a minute"],
          failed: ["render_failed", "The image service could not make the photo"] };
        const t0 = Date.now();
        for (;;) {
          if (signal && signal.aborted) { const e = new Error("Cancelled"); e.name = "AbortError"; throw e; }
          if (Date.now() - t0 > 8 * 60 * 1000) { const e = new Error(JOB_MSG.timeout[1]); e.code = JOB_MSG.timeout[0]; throw e; }
          await new Promise((ok) => setTimeout(ok, 4000));
          let st = null;
          try { st = await rpc("photo_render_job", { p_usage_id: j.job_id }); } catch (e) { if (e && (e.code === "42501" || e.code === "P0002")) throw e; continue; }
          if (!st || st.status === "pending") continue;
          if (st.status === "error") { const k = String(st.error || "failed").split(":")[0]; const m = JOB_MSG[k] || JOB_MSG.failed;
            const e = new Error(m[1]); e.code = m[0]; throw e; }
          const ids = Array.isArray(st.renders) ? st.renders : [];
          const renders = [];
          for (const id of ids) {
            const r = await rpc("photo_render_image", { p_render_id: id }).catch(() => null);
            if (r && r.data) renders.push({ id: String(id), mime: String(r.mime || "image/jpeg"), data: String(r.data) });
          }
          if (!renders.length) { const e = new Error("No photo came back - please try again"); e.code = "render_failed"; throw e; }
          return { renders, used: j.used, quota: j.quota };
        }
      },
      job: (jobId) => rpc("photo_render_job", { p_usage_id: jobId }),
      list: (quoteId) => (supa && mode === "supabase" && UUID_RE_PKG.test(String(quoteId || ""))
        ? rpc("photo_render_list", { p_quote_id: quoteId }).then((r) => (Array.isArray(r) ? r : [])).catch((e) => { if (rpcMissing(e)) return []; throw e; })
        : Promise.resolve([])),
      // data: URL of one stored render (lazy), or null
      image: (renderId) => (supa && mode === "supabase" && UUID_RE_PKG.test(String(renderId || ""))
        ? rpc("photo_render_image", { p_render_id: renderId }).then(photoDataUrl).catch((e) => { if (rpcMissing(e)) return null; throw e; })
        : Promise.resolve(null)),
      // copy into the client booklet as its own picture (kind "photo"; the 2D / 3D re-capture never replaces it)
      useInBooklet: (renderId) => rpc("photo_render_use_in_booklet", { p_render_id: renderId }),
      settings: () => (supa && mode === "supabase"
        ? rpc("photo_render_settings_get", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; })
        : Promise.resolve(null)),
      setSettings: (enabled, monthlyQuota, hourlyLimit) => rpc("photo_render_settings_set",
        { p_enabled: !!enabled, p_monthly_quota: Math.round(Number(monthlyQuota) || 0), p_hourly_limit: Math.round(Number(hourlyLimit) || 0) }),
    },
    // 0065 — client event booklet (public/booklet.html?t=<token>). Staff whose role may EDIT
    // quotes share / revoke; current() needs quotes VIEW. get() is the signed-out client read
    // (client-safe fields only, rate-limited + logged server-side). Before 0065 / local mode:
    // current() → null and share() rejects with a friendly message.
    booklet: {
      get: (token) => rpc("public_get_booklet", { p_token: token }).then((r) => { linkOpened("booklet", token); return r; }),
      // 0101 (E6): {event_date, balance_due_days, advance_pct} for this link; null before 0101 / on any error
      payTerms: (token) => (supa ? rpc("public_booklet_pay_terms", { p_token: token }).catch(() => null) : Promise.resolve(null)),
      // 0067: /<studio>/booklet/<token> — the studio name must belong to the token's studio
      studioOk: (token, studio) => (supa ? rpc("public_booklet_studio", { p_token: String(token || ""), p_studio: String(studio || "") })
        .then((r) => { if (r && r !== studio) { try { history.replaceState(null, "", "/" + r + "/booklet/" + encodeURIComponent(String(token))); } catch (e) {} } return !!r; })
        .catch((e) => { if (rpcMissing(e)) return true; throw e; }) : Promise.resolve(true)),
      current: (quoteId) => (supa ? rpc("booklet_current", { p_quote_id: quoteId }).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      // 0069: o.sections = { studio, client, venue, menu, layout2d, layout3d, quotation, payments, terms, note } (booleans;
      // missing = shown). Hidden sections are removed server-side. o.versions is an alias of o.versionIds.
      share: (quoteId, o) => { o = o || {};
        if (!supa) return Promise.reject(new Error("Sharing a booklet needs a signed-in studio."));
        const vers = Array.isArray(o.versionIds) ? o.versionIds : (Array.isArray(o.versions) ? o.versions : null);
        let sec = null;
        if (o.sections && typeof o.sections === "object") { sec = {}; for (const k of BOOKLET_SECTIONS) if (k in o.sections) sec[k] = !!o.sections[k]; }
        return rpc("booklet_share", { p_quote_id: quoteId, p_days: Math.max(1, Math.min(365, Math.round(Number(o.days) || 30))),
          p_version_ids: vers, p_terms: o.terms ? String(o.terms).slice(0, 8000) : null, p_note: o.note ? String(o.note).slice(0, 1000) : null,
          ...(sec ? { p_sections: sec } : {}) }); },
      revoke: (quoteId) => rpc("booklet_revoke", { p_quote_id: quoteId }),
      // r19 L11 (0220): floor plan + 3D view on for the live link once the layout has objects (a link made on an
      // empty layout had them skipped); never when someone switched sections on the live link. null before 0220.
      layoutAutoOn: (quoteId) => (supa ? rpc("booklet_layout_auto_on", { p_quote_id: quoteId }).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      // r19 L11 (0220): change which sections the LIVE link shows, in place (same link / token)
      setSections: (quoteId, sections) => { const sec = {};
        for (const k of BOOKLET_SECTIONS) if (sections && typeof sections === "object" && k in sections) sec[k] = !!sections[k];
        return supa ? rpc("booklet_set_sections", { p_quote_id: quoteId, p_sections: sec }) : Promise.reject(new Error("Sharing a booklet needs a signed-in studio.")); },
      // 0200 "Send to client": queues the LIVE booklet link (fixed text) by e-mail / WhatsApp (comms_outbox -> comms-dispatch).
      // The server checks consent / STOP / caps. FREE TRIAL (0212): as sites.send - an active trial's e-mail is queued
      // (capped), WhatsApp / an ended trial / a demo event -> {status:"skipped", reason:"free_trial" | "demo"}.
      send: (quoteId, channel, to, optIn, consentText) => rpc("booklet_send", { p_quote: quoteId, p_channel: channel === "whatsapp" ? "whatsapp" : "email",
        p_to: String(to || "").slice(0, 200), p_opt_in: !!optIn, p_consent_text: optIn ? String(consentText || "").slice(0, 500) : null }),
      sendLog: (quoteId) => (supa ? rpc("booklet_send_log", { p_quote: quoteId }).catch(() => []) : Promise.resolve([])),
      url: (token) => (HelmUrl.studio() ? links.base() + "/" + HelmUrl.studio() + "/booklet/" + encodeURIComponent(String(token || "")) : links.base() + "/booklet?t=" + encodeURIComponent(String(token || ""))),
      sections: () => BOOKLET_SECTIONS.slice(),
      // 0069: 2D / 3D snapshot -> private bucket booklet-snapshots at <org>/<quote>/<kind>.<png|jpg|webp> (<= 3 MB),
      // then recorded on the live booklet link. Returns the storage path.
      uploadSnapshot: async (quoteId, kind, blob) => {
        if (!supa || mode !== "supabase") throw new Error("Snapshots need a signed-in studio.");
        if (kind !== "2d" && kind !== "3d") throw new Error("Snapshot kind must be 2d or 3d.");
        if (!UUID_RE_PKG.test(String(quoteId || ""))) throw new Error("Unknown event.");
        const type = String((blob && blob.type) || "");
        const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[type];
        if (!ext) throw new Error("Snapshot must be a PNG, JPEG or WebP image.");
        if (!blob.size || blob.size > 3 * 1024 * 1024) throw new Error("Snapshot must be 3 MB or smaller.");
        const oid = await orgIdStrict();
        const path = oid + "/" + quoteId + "/" + kind + "." + ext;
        const up = await supa.storage.from("booklet-snapshots").upload(path, blob, { contentType: type, upsert: true, cacheControl: "300" });
        if (up && up.error) { if (looksLikeAuthError(up.error)) onAuthFailure(); throw up.error; }
        await rpc("booklet_set_snapshot", { p_quote_id: quoteId, p_kind: kind, p_path: path });
        return path;
      },
      // R2: what's already in the bucket for this event -> { "2d": { path, updatedAt }, "3d": ... } (read policy = own studio).
      snapshotInfo: async (quoteId) => {
        const out = {};
        if (!supa || mode !== "supabase" || !UUID_RE_PKG.test(String(quoteId || ""))) return out;
        const oid = await orgIdStrict();
        const r = await supa.storage.from("booklet-snapshots").list(oid + "/" + quoteId, { limit: 20 });
        if (r && r.error) return out;
        ((r && r.data) || []).forEach((f) => { const m = /^(2d|3d)\.(png|jpg|webp)$/.exec(String((f && f.name) || ""));
          if (!m) return; const t = f.updated_at || f.created_at || null;
          if (!out[m[1]] || String(t) > String(out[m[1]].updatedAt)) out[m[1]] = { path: oid + "/" + quoteId + "/" + f.name, updatedAt: t }; });
        return out;
      },
      // R2: signed preview URL of a studio snapshot (staff only - storage read policy)
      snapshotPreview: async (path) => { if (!supa) return null;
        const r = await supa.storage.from("booklet-snapshots").createSignedUrl(String(path || ""), 300);
        return r && !r.error && r.data ? r.data.signedUrl : null; },
      // R2: (re)attach an already-uploaded snapshot to the live booklet link
      attachSnapshot: (quoteId, kind, path) => rpc("booklet_set_snapshot", { p_quote_id: quoteId, p_kind: kind === "3d" ? "3d" : "2d", p_path: path }),
      // 0083: booklet pictures stored IN THE DATABASE (no edge function / bucket needed).
      // kind '2d' | '3d', variant 'labels' (numbered badges + legend) | 'plain'. JPEG ~0.85, <= 1600 px wide.
      imageKinds: () => BOOKLET_IMG_KINDS.slice(), imageVariants: () => BOOKLET_IMG_VARIANTS.slice(),
      encodeImage: (blob, maxW, q) => encodeBookletImage(blob, maxW, q),
      putImage: async (quoteId, kind, variant, blob) => {
        if (!supa || mode !== "supabase") throw new Error("Client pictures need a signed-in studio.");
        if (!BOOKLET_IMG_KINDS.includes(kind) || !BOOKLET_IMG_VARIANTS.includes(variant)) throw new Error("Unknown picture kind.");
        if (!UUID_RE_PKG.test(String(quoteId || ""))) throw new Error("Unknown event.");
        const enc = await encodeBookletImage(blob);
        if (!enc) throw new Error("Couldn't prepare the picture.");
        if (enc.bytes > BOOKLET_IMG_MAX) throw new Error("Picture must be 1.5 MB or smaller.");
        return rpc("booklet_put_image", { p_quote_id: quoteId, p_kind: kind, p_variant: variant, p_mime: enc.mime, p_data: enc.data });
      },
      // { "2d": { labels: iso, plain: iso }, "3d": { ... } } - newest picture per style (no bytes); {} before 0083
      imageInfo: (quoteId) => (supa && mode === "supabase" && UUID_RE_PKG.test(String(quoteId || ""))
        ? rpc("booklet_image_info", { p_quote_id: quoteId }).then((r) => (r && typeof r === "object" ? r : {})).catch((e) => { if (rpcMissing(e)) return {}; throw e; })
        : Promise.resolve({})),
      // staff preview: data: URL of the newest picture, or null
      staffImage: (quoteId, kind, variant) => (supa && mode === "supabase" && UUID_RE_PKG.test(String(quoteId || "")) && BOOKLET_IMG_KINDS.includes(kind) && BOOKLET_IMG_VARIANTS.includes(variant)
        ? rpc("booklet_staff_image", { p_quote_id: quoteId, p_kind: kind, p_variant: variant }).then(bookletDataUrl).catch((e) => { if (rpcMissing(e)) return null; throw e; })
        : Promise.resolve(null)),
      // which styles the live link shows: { "2d_labels": bool, "2d_plain": bool, "3d_labels": bool, "3d_plain": bool }
      setImageVariants: (quoteId, v) => { const o = {};
        ["2d_labels", "2d_plain", "3d_labels", "3d_plain"].forEach((k) => { if (v && typeof v[k] === "boolean") o[k] = v[k]; });
        return rpc("booklet_set_image_variants", { p_quote_id: quoteId, p_variants: o }).catch((e) => { if (rpcMissing(e)) return null; throw e; }); },
      // signed-out booklet page: data: URL of one picture of a live link (lazy), or null
      publicImage: (token, kind, variant) => (supa && UUID_RE_PKG.test(String(token || "")) && (BOOKLET_IMG_KINDS.includes(kind) || (kind === "photo" && variant === "plain")) && BOOKLET_IMG_VARIANTS.includes(variant)
        ? rpc("public_get_booklet_image", { p_token: String(token), p_kind: kind, p_variant: variant }).then(bookletDataUrl).catch(() => null)
        : Promise.resolve(null)),
      // signed-out booklet page: <img src> for a ticked snapshot (dormant edge function booklet-snapshot)
      snapshotUrl: (token, kind) => { const u = fnUrl("booklet-snapshot");
        return u ? u + "?t=" + encodeURIComponent(String(token || "")) + "&k=" + (kind === "3d" ? "3d" : "2d") : ""; },
    },
    // 0069 - client package selection (booklet) + staff review. Before 0069 is applied (or local
    // mode) the reads return null / [] and writes reject with a friendly message.
    pkgflow: {
      packages: (token) => (supa ? rpc("public_booklet_packages", { p_token: token }).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      choose: (token, pkg, guests, note, otp) => {
        if (!supa) return Promise.reject(new Error("Package selection is not available."));
        return rpc("public_booklet_choose", { p_token: token, p_package: pkg, p_guests: Math.round(Number(guests) || 0),
          p_note: note ? String(note).slice(0, 1000) : null, p_otp: otp ? String(otp).trim().slice(0, 12) : null })
          .catch((e) => { if (rpcMissing(e)) return null; throw e; });
      },
      otpRequest: (token) => (supa ? rpc("public_booklet_otp_request", { p_token: token }).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      list: (quoteId) => (supa ? rpc("pkg_selection_list", { p_quote: quoteId || null }).then((d) => (Array.isArray(d) ? d : []))
        .catch((e) => { if (rpcMissing(e)) return []; throw e; }) : Promise.resolve([])),
      review: (id, action, price, reason) => {
        if (!supa) return Promise.reject(new Error("Reviewing needs a signed-in studio."));
        const p = price === null || price === undefined || price === "" ? null : Number(price);
        return rpc("pkg_selection_review", { p_id: id, p_action: action === "decline" ? "decline" : "accept",
          p_price_override: Number.isFinite(p) ? p : null, p_reason: reason ? String(reason).slice(0, 500) : null });
      },
      settingsGet: () => (supa ? rpc("pkg_settings_get", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      settingsSet: (obj) => {
        if (!supa) return Promise.reject(new Error("Settings need a signed-in studio."));
        const o = obj || {}, out = {};
        for (const k of ["pkg_require_otp", "pkg_client_channel", "overpay_mode", "pkg_lock_days"]) if (k in o) out[k] = o[k];
        return rpc("pkg_settings_set", { p: out });
      },
    },
    // 0064 — saved filters / views for list pages (public/saved-filters.js). RLS: own rows +
    // studio-shared rows the role may view; the DB stamps owner + studio and refuses shared
    // from non-admins. Before 0064 / local mode → list() is [] and writes are refused.
    savedViews: {
      list: (page) => {
        if (!supa) return Promise.resolve([]);
        return Promise.resolve(supa.from("saved_views").select("id,user_id,page,name,state,shared,is_default,updated_at")
          .eq("page", String(page || "")).order("name", { ascending: true }).limit(200)).then(({ data, error }) => {
            if (error) { if (rpcMissing(error) || error.code === "42P01" || error.code === "PGRST205") return []; if (looksLikeAuthError(error)) onAuthFailure(); throw error; }
            return Array.isArray(data) ? data : [];
          });
      },
      save: (page, name, state, shared) => {
        if (!supa) return Promise.reject(new Error("Saved views need a signed-in studio."));
        return Promise.resolve(supa.from("saved_views").insert({ page: String(page), name: String(name).trim().slice(0, 60), state: state || {}, shared: !!shared })
          .select("id,user_id,page,name,state,shared,is_default,updated_at").single()).then(({ data, error }) => { if (error) throw error; return data; });
      },
      update: (id, patch) => {
        if (!supa) return Promise.reject(new Error("Saved views need a signed-in studio."));
        const p = {};
        if (patch && "name" in patch) p.name = String(patch.name).trim().slice(0, 60);
        if (patch && "shared" in patch) p.shared = !!patch.shared;
        if (patch && "state" in patch) p.state = patch.state || {};
        return Promise.resolve(supa.from("saved_views").update(p).eq("id", id).select("id").single()).then(({ error }) => { if (error) throw error; return true; });
      },
      remove: (id) => {
        if (!supa) return Promise.reject(new Error("Saved views need a signed-in studio."));
        return Promise.resolve(supa.from("saved_views").delete().eq("id", id)).then(({ error }) => { if (error) throw error; return true; });
      },
      setDefault: (id, on) => rpc("saved_view_set_default", { p_id: id, p_on: on !== false }),
    },
    // 0088 - smart import (public/smart-import.js): custom fields, remembered column mappings and the
    // batch import RPC. Before 0088 is applied the reads return [] / null and writes reject.
    smartImport: {
      ENTITIES: ["staff", "inventory", "menu", "vendors"],
      existing: (entity) => entity === "staff" ? BPStore.staff.list(true) : entity === "inventory" ? BPStore.inventory.items(true)
        : entity === "menu" ? BPStore.dishCatalog.list(true) : entity === "vendors" ? BPStore.vendors.listAll(true) : Promise.resolve([]),
      fieldDefs: (entity) => {
        if (!supa) return Promise.resolve([]);
        let q = supa.from("custom_field_defs").select("entity,key,label,type,position,active").order("position").order("key").limit(500);
        if (entity) q = q.eq("entity", entity);
        return Promise.resolve(q).then(({ data, error }) => {
          if (error) { if (rpcMissing(error) || error.code === "42P01" || error.code === "PGRST205") return []; throw error; }
          return Array.isArray(data) ? data : [];
        });
      },
      saveFieldDef: (d) => {
        if (!supa) return Promise.reject(new Error("Custom fields need a signed-in studio."));
        const row = { entity: String(d.entity), key: String(d.key), label: String(d.label || "").trim().slice(0, 80),
          type: ["text", "number", "date", "bool"].includes(d.type) ? d.type : "text", active: d.active !== false };
        if (d.position != null) row.position = Math.max(0, Math.min(10000, Math.round(Number(d.position) || 0)));
        const q = d.isNew ? supa.from("custom_field_defs").insert(row)
          : supa.from("custom_field_defs").update({ label: row.label, type: row.type, active: row.active }).eq("entity", row.entity).eq("key", row.key);
        return Promise.resolve(q).then(({ error }) => { if (error) throw error; return true; });
      },
      getMapping: (entity) => {
        if (!supa) return Promise.resolve(null);
        return Promise.resolve(supa.from("import_mappings").select("mapping").eq("entity", entity).maybeSingle()).then(({ data, error }) => {
          if (error) return null; return data && data.mapping ? data.mapping : null; });
      },
      saveMapping: (entity, mapping) => {
        if (!supa) return Promise.resolve(false);
        return Promise.resolve(supa.from("import_mappings").upsert({ entity, mapping: mapping || {} }, { onConflict: "org_id,entity" }))
          .then(({ error }) => !error, () => false);
      },
      importBatch: (entity, rows, defs) => {
        if (!supa) return Promise.reject(new Error("Importing needs a signed-in studio."));
        return rpc("smart_import_batch", { p_entity: entity, p_rows: rows || [], p_defs: defs || [] });
      },
    },
    // 0097 — free-trial demo data. status(): {trial_mode:'demo'|'own'|null, demo_rows, has_demo,
    // is_admin}; null before 0097 / local mode. seed / clear / reset / setMode are studio-admin
    // only and touch ONLY this studio's rows flagged is_demo (enforced in the database).
    demo: {
      status: () => (supa ? memoRead("demo", 15000, () => swr("demo", () => rpc("my_demo_status").catch((e) => { if (rpcMissing(e)) return null; throw e; }))) : Promise.resolve(null)),
      setMode: (mode) => rpc("set_trial_mode", { p_mode: mode === "demo" ? "demo" : "own" }),
      seed: () => rpc("seed_demo_data"),
      clear: () => rpc("clear_demo_data"),
      // 0166 — Control Center "Clear sample data": admin of a trial / ex-trial studio; removes ONLY is_demo rows.
      clearSample: () => rpc("clear_sample_data"),
      reset: () => rpc("reset_demo_data"),
      // 0127 — after subscribing: "fresh" removes ONLY this studio's is_demo rows, "keep" keeps them.
      choose: (choice) => rpc("trial_demo_choice", { p_choice: choice === "fresh" ? "fresh" : "keep" }),
    },
    // 0185 — after a free trial upgrades the admin chooses once: "keep" (default) keeps the sample data
    // (tagged Sample), "remove_sample" removes ONLY is_demo rows, "clean" also ARCHIVES every own record
    // (never deletes; needs the typed phrase START CLEAN). status(): my_upgrade_status(); null before 0185.
    upgrade: {
      status: () => (supa ? rpc("my_upgrade_status").catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      choose: (choice, confirm) => rpc("upgrade_data_choice", {
        p_choice: choice === "clean" || choice === "remove_sample" ? choice : "keep",
        p_confirm: confirm == null ? null : String(confirm).slice(0, 40) }),
      // Control Center "Delete all sample data": is_demo rows only (own records never touched)
      deleteSample: () => rpc("delete_all_sample_data"),
      // undo of "Start completely clean": every archived record back in the lists
      restore: () => rpc("restore_clean_start"),
    },
    // 0116 — "Start free trial": start() creates the caller's "Demo N" studio (sample data,
    // 8 days) through create_studio; a caller who already has a studio gets it back untouched.
    // status(): {is_trial_org, name, ends_at, days_left, ended, locked, is_admin}; null before 0116.
    // 0183: + read_only (ended unpaid trial: read-only for everyone); is_trial_org false once paid / converted.
    trialOrg: {
      // r21 (0244): "Ask my admin to upgrade" - a teammate of a trial / ended-trial studio puts one admin-only bell
      // notice (+ an e-mail to the admins). { sent, already }; null when the server is older than 0244.
      askAdmin: () => (supa ? rpc("ask_admin_upgrade", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      start: (loc) => (loc && (loc.timezone || loc.currency) ? rpc("start_trial", { p_timezone: loc.timezone || null, p_currency: loc.currency || null }) : rpc("start_trial", {})),
      // 0167 — 2-step trial welcome, step 1: rename the caller's own trial studio (name, link slug, city, optional phone)
      welcome: (name, city, phone) => rpc("trial_welcome_setup", { p_name: String(name || "").trim(), p_city: String(city || "").trim() || "Hyderabad", p_phone: String(phone || "").trim() || null }),
      // 0210 — the same step with City + State (Indian states) + Country India (fixed for the trial); phone optional.
      // Falls back to the 0167 step (no state) while 0210 is not applied yet.
      welcomeSave: (o) => {
        const a = o || {};
        const args = { p_name: String(a.name || "").trim(), p_city: String(a.city || "").trim(), p_state: String(a.state || "").trim(),
          p_phone: String(a.phone || "").trim() || null, p_country: "IN" };
        return rpc("trial_welcome_save", args).catch((e) => {
          if (!rpcMissing(e)) throw e;
          return rpc("trial_welcome_setup", { p_name: args.p_name, p_city: args.p_city || "Hyderabad", p_phone: args.p_phone });
        });
      },
      // 0180 — server-side welcome flag (works across devices): true while the free-trial owner's
      // 2-step welcome is not finished, false otherwise; null = 0180 not installed (the page then
      // falls back to this browser's sign-up flag)
      welcomePending: () => (supa ? rpc("my_trial_welcome_pending", {}).then((v) => v === true, (e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      // finished (Skip / Send invites) -> false; "start my own studio" names the studio again -> true
      welcomeDone: () => (supa ? rpc("trial_welcome_set", { p_pending: false }).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      welcomeAgain: () => (supa ? rpc("trial_welcome_set", { p_pending: true }).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      // 0207 — free-trial terms ("Your 8-day free trial", I agree): {version, trial, owner, accepted, must_agree,
      // notice, welcome_pending}; null = 0207 not installed / no backend (the page then asks without recording)
      terms: () => (supa ? rpc("my_trial_terms_status", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      // records the owner's "I agree" (or a teammate's "Got it") for that terms version; null = not installed
      acceptTerms: (version) => (supa ? rpc("accept_trial_terms", { p_version: String(version || ""),
        p_user_agent: String((global.navigator && global.navigator.userAgent) || "").slice(0, 160) || null })
        .catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      status: () => trialOrgStatus(),
      // 0183 — true while this studio is READ-ONLY after its free trial ended unpaid (everyone in it); false otherwise
      readOnly: () => studioReadOnly(),
      // 0177 — true while this is a self-serve free-trial studio still ON its trial (not yet paid):
      // such a studio uses the short 2-step welcome, never the full studio setup (/onboarding).
      async inTrial() {
        if (!supa) return false;
        try {
          const r = await Promise.all([BPStore.trialOrg.status(), BPStore.subscription.trial()]);
          return !!(r[0] && r[0].is_trial_org === true && r[1] && r[1].state === "trial");
        } catch (e) { return false; }
      },
      // 0126 — {is_trial_org, ends_at, ended, locked, is_owner, blocked}; works for a member blocked after an unpaid trial ends.
      access: () => (supa ? rpc("my_trial_access", {}).catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      // 0119 — the ONE self-serve trial: {name (blank -> "Demo N")}. 0180: always the sample data on
      // INR / Asia/Kolkata (any mode / time zone / currency passed in is ignored; the server does the same).
      // Before 0119 is applied: own studio name -> create_studio (old path); no name -> start_trial (Demo N).
      async startSelfServe(o) {
        o = o || {};
        // 0180: every free trial is sample data + India (INR / Asia/Kolkata); the server enforces the same
        const name = String(o.name || "").trim() || null, mode = "demo";
        try {
          return await rpc("start_self_serve_trial", { p_name: name, p_timezone: "Asia/Kolkata", p_currency: "INR", p_mode: mode });
        } catch (e) {
          if (!rpcMissing(e)) throw e;
          if (!name) return BPStore.trialOrg.start({ timezone: "Asia/Kolkata", currency: "INR" });
          const id = await BPStore.org.createStudio(name, { currency: "INR", timezone: "Asia/Kolkata" });
          try { await BPStore.demo.seed(); } catch (x) {}
          return { result: "started", org_id: id, name: name, mode: mode, legacy: true };
        }
      },
    },
    gettingStarted: {
      get: () => (supa ? rpc("my_getting_started").catch((e) => { if (rpcMissing(e)) return null; throw e; }) : Promise.resolve(null)),
      dismiss: (on) => rpc("my_getting_started_dismiss", { p_dismissed: on !== false }),
      // free-trial checklist facts (read-only, RLS = the caller's own studio): a sample event to open
      // (prefers one whose floor plan has objects, so the builder link shows a real layout) and whether
      // the studio has sent one of its OWN quotes (is_demo = false; sample quotes never count).
      async trialFacts() {
        const out = { eventId: null, layoutQuoteId: null, ownQuoteSent: false };
        if (!supa) return out;
        try {
          let r = await supa.from("quotes").select("id,lifecycle_stage,event_date,deleted_at").eq("is_demo", true).is("deleted_at", null).order("event_date", { ascending: true }).limit(40);
          if (r.error && isMissingColumn(r.error)) r = await supa.from("quotes").select("id,lifecycle_stage,event_date").eq("is_demo", true).order("event_date", { ascending: true }).limit(40);
          const demo = (!r.error && Array.isArray(r.data)) ? r.data : [];
          if (demo.length) {
            const BOOKED = ["confirmed", "planning", "resources", "ready", "event_day"];
            let withLayout = [];
            try {
              const v = await supa.from("quote_versions").select("quote_id,object_count").in("quote_id", demo.map((q) => q.id)).gt("object_count", 0).limit(40);
              if (!v.error && Array.isArray(v.data)) withLayout = v.data.map((x) => x.quote_id);
            } catch (e) { withLayout = []; }
            const has = (q) => withLayout.indexOf(q.id) >= 0, booked = (q) => BOOKED.indexOf(q.lifecycle_stage) >= 0;
            const ev = demo.find((q) => booked(q) && has(q)) || demo.find(booked) || demo[0];
            const lay = demo.find((q) => has(q) && booked(q)) || demo.find(has) || null;
            out.eventId = ev ? ev.id : null; out.layoutQuoteId = lay ? lay.id : null;
          }
        } catch (e) { /* links fall back to the lists */ }
        try {
          const s = await supa.from("quotes").select("id").eq("is_demo", false).in("approval_status", ["sent", "approved", "paid"]).limit(1);
          out.ownQuoteSent = !s.error && Array.isArray(s.data) && s.data.length > 0;
        } catch (e) { out.ownQuoteSent = false; }
        return out;
      },
      // the studio's OWN work for the paid checklist (read-only, RLS = own studio). Sample rows (is_demo,
      // a trial kept after paying) never tick a step, and a quote's floor plan counts: the builder saves
      // it as a quote version (quote_versions), not in the standalone layouts table my_getting_started reads.
      // -> {lead, floorPlan, quoteSent} booleans, or null when it can't be read (callers keep the server flags).
      async ownFacts() {
        if (!supa) return null;
        const own = async (build) => {
          let r = await build(true);
          if (r.error && isMissingColumn(r.error)) r = await build(false);   // a database without is_demo: every row is the studio's own
          if (r.error) throw r.error;
          return Array.isArray(r.data) ? r.data : [];
        };
        try {
          const lead = (await own((d) => { const q = supa.from("leads").select("id").limit(1); return d ? q.eq("is_demo", false) : q; })).length > 0;
          const quoteSent = (await own((d) => { const q = supa.from("quotes").select("id").in("approval_status", ["sent", "approved", "paid"]).limit(1); return d ? q.eq("is_demo", false) : q; })).length > 0;
          let floorPlan = false;
          // newest first: a studio kept after its trial has many sample versions, and its own (newer) floor plans
          // must not fall outside the 200-row window
          let v = await supa.from("quote_versions").select("quote_id").gt("object_count", 0).order("created_at", { ascending: false }).limit(200);
          if (v.error && isMissingColumn(v.error)) v = await supa.from("quote_versions").select("quote_id").gt("object_count", 0).limit(200);
          const ids = (!v.error && Array.isArray(v.data)) ? Array.from(new Set(v.data.map((x) => x.quote_id).filter(Boolean))) : [];
          if (ids.length) floorPlan = (await own((d) => { const q = supa.from("quotes").select("id").in("id", ids).limit(1); return d ? q.eq("is_demo", false) : q; })).length > 0;
          if (!floorPlan) {
            try { floorPlan = (await own((d) => { const q = supa.from(TABLE).select("id").limit(1); return d ? q.eq("is_demo", false) : q; })).length > 0; } catch (e) { /* standalone layouts unreadable: quote plans decide */ }
          }
          return { lead, floorPlan, quoteSent };
        } catch (e) { return null; }
      },
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
  BPStore.sampleName = sampleDisplayName;   // r20: shared sample-name display (see sampleDisplayName)
  /* ---- 0067 pretty studio URLs: studio check + ref resolution (HelmUrl.get) ----
     Signed-in pages only. my_studio_route() answers for the caller's OWN studio only:
     another studio's slug (or an unknown one) shows "not your studio" and the page's own
     code never runs (no data is requested). Event numbers / client refs resolve through
     resolve_event_ref / resolve_client_ref (caller org + has_area). Old ?id= URLs keep
     working; once resolved the address bar shows the pretty URL (history.replaceState). */
  (function prettyRoutes() {
    const R = HelmUrl.route();
    const resolved = {};
    let readyP = null;
    const query = () => { const o = {}; try { new URLSearchParams(location.search).forEach((v, k) => { o[k] = v; }); } catch (e) {} return o; };
    const swap = (path) => { try { if (path && path.charAt(0) === "/" && path.charAt(1) !== "/") history.replaceState(history.state, "", path + (location.hash || "")); } catch (e) {} };
    const leadRef = (name, id) => { const b = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); return (b ? b + "-" : "") + String(id).slice(0, 8); };
    function notYourStudio(own) {
      // a link / ?next= naming ANOTHER studio (e.g. left over from an earlier session) silently
      // lands on the caller's OWN dashboard (location.replace: Back never returns here)
      if (own) { try { location.replace(HelmUrl.build("dashboard", { studio: own })); return; } catch (e) {} }
      try {
        revealPage();
        const main = document.createElement("main"); main.className = "bp-not-your-studio"; main.id = "main";
        const h1 = document.createElement("h1"); h1.textContent = "This page belongs to another studio";
        const p = document.createElement("p"); p.textContent = "You are signed in to a different studio, so there is nothing to show here. Check the link, or go back to your own workspace.";
        const a = document.createElement("a"); a.className = "btn primary"; a.href = HelmUrl.build("dashboard", { studio: own || undefined }); a.textContent = "Go to my dashboard";
        main.appendChild(h1); main.appendChild(p); main.appendChild(a);
        document.title = "Not your studio · Helm";
        document.body.replaceChildren(main);
      } catch (e) {}
    }
    async function refToId(kind, ref) {
      try {
        if (kind === "client") {
          const c = await rpc("resolve_client_ref", { p_ref: ref });
          if (!c || !c.id) return null;
          return { id: c.id, ref: c.kind === "lead" ? leadRef(c.name, c.id) : (c.code || c.id) };
        }
        const e = await rpc("resolve_event_ref", { p_ref: ref });
        return e && e.id ? { id: e.id, ref: e.code || e.id } : null;
      } catch (e) { if (rpcMissing(e)) return { id: HelmUrl.isUuid(ref) ? ref : null, ref: ref }; return null; }
    }
    function ready() {
      if (readyP) return readyP;
      readyP = (async () => {
        try { await init(); } catch (e) { return; }
        if (!supa || !currentUser) return;                       // signed out: the page gate sends them to login
        if (!R) {                                                // legacy URL: learn the studio name for links
          try { const s = await links.studio(); if (s) HelmUrl.setStudio(s); } catch (e) {}
          return;
        }
        if (R.kind === "booklet") return;                        // public page: booklet.js checks the token's studio
        let j = null;
        try { j = await rpc("my_studio_route", { p_slug: R.studio }); }
        catch (e) { if (rpcMissing(e)) return; j = null; }
        if (!j || j.own !== true) { notYourStudio(j && j.slug); return HANG(); }
        HelmUrl.setStudio(j.slug);
        if (R.key) {
          const r = await refToId(R.kind, R.ref);
          resolved[R.key] = (r && r.id) || "";
          if (r && r.id) swap(HelmUrl.build(R.kind, { studio: j.slug, ref: r.ref, query: query() }));
        } else if (j.slug !== R.studio) swap(HelmUrl.build(R.kind, { studio: j.slug, query: query() }));
      })();
      return readyP;
    }
    // await HelmUrl.get("id", legacyValue) → the record id for this page
    HelmUrl.get = async function (name, fallback) {
      await ready();
      if (R && R.key === name && R.kind !== "booklet") return resolved[name] != null ? resolved[name] : (HelmUrl.isUuid(R.ref) ? R.ref : "");
      if (!R && fallback && HelmUrl.studio()) {                // legacy ?id= → pretty address bar
        const kind = HelmUrl.KINDS[{ event: "event", builder: "floor-plan", ops: "tasks", client: "client" }[HelmUrl.page()]] ? { event: "event", builder: "floor-plan", ops: "tasks", client: "client" }[HelmUrl.page()] : null;
        if (kind && HelmUrl.KINDS[kind][3] === name) {
          const r = await refToId(kind, fallback);
          if (r && r.id === fallback) { const q = query(); delete q[name]; swap(HelmUrl.build(kind, { ref: r.ref, query: q })); }
        }
      }
      return fallback;
    };
    // sync: a value already resolved by get() (or the query string)
    HelmUrl.value = function (name) {
      if (R && R.key === name) return resolved[name] != null ? resolved[name] : (HelmUrl.isUuid(R.ref) ? R.ref : "");
      try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
    };
    HelmUrl.ready = ready;
    // keyless pages (quotes, leads, chat, settings, dashboard): pretty address bar once the studio is known
    if (PAGE_GATED) Promise.resolve().then(ready).then(() => {
      const k = { dashboard: "dashboard", quotes: "quotes", leads: "leads", chat: "chat", control: "settings" }[HelmUrl.page()];
      if (!R && k && HelmUrl.studio()) swap(HelmUrl.build(k, { query: query() }));
    }).catch(() => {});
    // legacy app links in the DOM (nav, breadcrumbs, search results, bell) → pretty links
    function upgradeLinks(root) {
      if (!HelmUrl.studio() || !root || !root.querySelectorAll) return;
      root.querySelectorAll("a[href]").forEach((a) => {
        const h = a.getAttribute("href"); if (!h || h.charAt(0) === "#" || /^[a-z]+:/i.test(h) || h.charAt(1) === "/") return;
        const u = HelmUrl.upgrade(h); if (u !== h) a.setAttribute("href", u);
      });
    }
    // <base href="/"> pages: in-page "#x" links must not navigate to "/#x"
    document.addEventListener("click", (ev) => {
      const a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
      if (!a || !document.querySelector("base[href]")) return;
      const h = a.getAttribute("href"); if (!h || h.charAt(0) !== "#") return;
      ev.preventDefault();
      if (h.length > 1) {
        const t = document.getElementById(decodeURIComponent(h.slice(1)));
        if (t) { try { t.scrollIntoView(); if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); } catch (e) {} }
        try { history.replaceState(history.state, "", location.pathname + location.search + h); } catch (e) {}
      }
    }, true);
    if (PAGE_GATED) {
      const boot = () => ready().then(() => {
        upgradeLinks(document);
        try { new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches && n.matches("a[href]")) upgradeLinks(n.parentNode); else upgradeLinks(n); } }))).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
      }).catch(() => {});
      if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
    }
  })();
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
    "--bpui-accent:#047857;--bpui-on-accent:#fff;--bpui-danger:#b91c1c;--bpui-on-danger:#fff;",
    "--bpui-scrim:rgba(20,27,46,.5);--bpui-veil:rgba(246,244,241,.72);--bpui-shadow:0 24px 60px rgba(20,27,46,.3);",
    "--bpui-toast-bg:#1f1b2e;--bpui-toast-ink:#fff;--bpui-toast-act:#a7f3d0;--bpui-ok:#34d399;--bpui-err:#f87171;--bpui-info:#34d399;",
    "--bpui-warn-bg:#fff4d6;--bpui-warn-ink:#5c3d00;--bpui-warn-line:#e8c26a}",
    "html[data-theme=dark]{--bpui-bg:#1c1c22;--bpui-ink:#f3f1fa;--bpui-ink-2:#c6c2d6;--bpui-line:#75707f;--bpui-soft:#26222f;",
    "--bpui-accent:#047857;--bpui-on-accent:#fff;--bpui-danger:#b91c1c;--bpui-on-danger:#fff;",
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
    ".bpui-btn:focus-visible,.bpui-toast button:focus-visible,.bpui-toast a:focus-visible,.bpui-dialog :focus-visible{outline:2px solid var(--bpui-accent);outline-offset:2px}",
    ".bpui-btn[disabled]{opacity:.6;cursor:not-allowed}",
    "@media (pointer:coarse){.bpui-btn,.bpui-toast button{min-height:44px}}",
    /* toasts — white cards, bottom-right stack (1017: off the page toolbars; bottom-centre on phones), max 2, title + message + link + close + progress */
    // PP1028 #8: while a modal is open, toasts move to the TOP so they never cover its footer buttons (e.g. Save lead)
    "html:has([role=dialog][aria-modal=true]:not([hidden])) .bpui-toasts,html:has(dialog[open]) .bpui-toasts{bottom:auto;top:20px}",
    ".bpui-toasts{position:fixed;bottom:20px;right:16px;z-index:2147483600;display:flex;flex-direction:column;gap:10px;",
    "width:min(380px,calc(100vw - 32px));pointer-events:none;--bpui-t-bg:#fff;--bpui-t-ink:#1b1930;--bpui-t-ink2:#5b566b;--bpui-t-line:#e8e3db;",
    "--bpui-t-info:#047857;--bpui-t-info-bg:#e3f4ed;--bpui-t-ok:#0f7a43;--bpui-t-ok-bg:#dcf5e7;--bpui-t-warn:#8f5f00;--bpui-t-warn-bg:#fff1d6;",
    "--bpui-t-err:#c0262d;--bpui-t-err-bg:#ffe3e3;--bpui-t-sec:#1d4ed8;--bpui-t-sec-bg:#e0ecff;--bpui-t-shadow:0 12px 32px rgba(20,27,46,.16),0 2px 6px rgba(20,27,46,.06)}",
    "html[data-theme=dark] .bpui-toasts{--bpui-t-bg:#221e2e;--bpui-t-ink:#f3f1fa;--bpui-t-ink2:#c6c2d6;--bpui-t-line:#3a3548;--bpui-t-info:#6ee7b7;--bpui-t-info-bg:#123329;",
    "--bpui-t-ok:#6ee7b7;--bpui-t-ok-bg:#12301f;--bpui-t-warn:#fcd34d;--bpui-t-warn-bg:#3a2a0c;--bpui-t-err:#fca5a5;--bpui-t-err-bg:#3d1518;--bpui-t-sec:#93c5fd;--bpui-t-sec-bg:#172a4d;--bpui-t-shadow:0 14px 36px rgba(0,0,0,.6)}",
    ".bpui-lane{display:flex;flex-direction:column;gap:10px}",
    ".bpui-toast{--bpui-t-c:var(--bpui-t-info);--bpui-t-cbg:var(--bpui-t-info-bg);position:relative;overflow:hidden;pointer-events:auto;display:flex;align-items:flex-start;gap:12px;padding:12px 8px 14px 12px;",
    "border-radius:14px;background:var(--bpui-t-bg);color:var(--bpui-t-ink);border:1px solid var(--bpui-t-line);box-shadow:var(--bpui-t-shadow);font:14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    ".bpui-toast.bpui-ok{--bpui-t-c:var(--bpui-t-ok);--bpui-t-cbg:var(--bpui-t-ok-bg)}.bpui-toast.bpui-err{--bpui-t-c:var(--bpui-t-err);--bpui-t-cbg:var(--bpui-t-err-bg)}",
    ".bpui-toast.bpui-warn{--bpui-t-c:var(--bpui-t-warn);--bpui-t-cbg:var(--bpui-t-warn-bg)}.bpui-toast.bpui-sec{--bpui-t-c:var(--bpui-t-sec);--bpui-t-cbg:var(--bpui-t-sec-bg)}",
    ".bpui-toast-ic{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:10px;background:var(--bpui-t-cbg);color:var(--bpui-t-c);font-size:16px;font-weight:800;line-height:1}",
    ".bpui-toast-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-top:1px}",
    ".bpui-toast-title{font-weight:700;font-size:14px;color:var(--bpui-t-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".bpui-toast-msg{font-size:13px;color:var(--bpui-t-ink2);overflow-wrap:anywhere}",
    ".bpui-toast.has-title .bpui-toast-msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".bpui-toast.no-title .bpui-toast-msg{color:var(--bpui-t-ink);font-size:13.5px;padding-top:5px}",
    ".bpui-toast-act{align-self:flex-start;margin-top:4px;background:transparent;border:0;padding:0;color:var(--bpui-t-c);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;text-decoration:none}",
    ".bpui-toast-act:hover{text-decoration:underline}",
    ".bpui-toast .bpui-x{flex:0 0 auto;background:transparent;border:0;color:var(--bpui-t-ink2);font-size:18px;line-height:1;cursor:pointer;width:30px;height:30px;border-radius:8px}",
    ".bpui-toast .bpui-x:hover{background:var(--bpui-t-cbg);color:var(--bpui-t-ink)}",
    ".bpui-toast.is-link{cursor:pointer}",
    ".bpui-toast-bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:var(--bpui-t-c);opacity:.7;transform-origin:left center}",
    ".bpui-toast.is-paused .bpui-toast-bar{animation-play-state:paused!important}",
    "@keyframes bpuiBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}",
    "@keyframes bpuiIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}",
    "@media (max-width:640px){.bpui-toasts{top:auto;right:auto;left:50%;transform:translateX(-50%);bottom:max(16px,env(safe-area-inset-bottom,0px));flex-direction:column-reverse}",
    ".bpui-lane{flex-direction:column-reverse}@keyframes bpuiIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}}",
    "@media (pointer:coarse){.bpui-toast .bpui-x{width:44px;height:44px}}",
    "@media (prefers-reduced-motion:reduce){.bpui-toast-bar{display:none}}",
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
    ".bpui-toast{animation:bpuiIn .22s cubic-bezier(.2,.8,.2,1)}.bpui-spin,.bpui-spin2,:where(#boot:empty)::before{animation:bpuiSpin .8s linear infinite}",
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
    ".bpui-capnote{display:inline-block;margin:0 8px;font-size:12.5px;line-height:1.3;color:var(--bpui-ink-2);vertical-align:middle}",
    ".bpui-caplink{font-weight:700;color:inherit;text-decoration:underline}",
    /* r20 cap note: a quiet line of its own BELOW a button row (never between a split button and its caret) */
    ".bpui-capnote.is-below{display:block;flex:1 0 100%;width:100%;margin:2px 0 0;font-size:12px;text-align:left;white-space:normal}",
    ".bpui-capnote.is-full .bpui-caplink{color:var(--bpui-accent);text-decoration:none;white-space:nowrap}",
    ".bpui-capnote.is-full .bpui-caplink:hover{text-decoration:underline}",
    /* soft-off at the cap: looks off but still takes the click (to say why); the next-code chip is hidden */
    "[data-cap-soft=\"1\"][aria-disabled=true]{opacity:.55;cursor:not-allowed;filter:none!important;box-shadow:none!important}",
    "[data-cap-soft=\"1\"][aria-disabled=true] *{transform:none!important}",
    "[data-cap-off=\"1\"] #nextName,[data-cap-off=\"1\"] .hd-code{display:none!important}",
  ].join("\n");
  function injectCSS() {
    if (doc.__bpuiStyle) return;
    doc.__bpuiStyle = true; __helmAdoptCss(doc, CSS);
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
    if (e && typeof e.message === "string" && global.HelmDemojibake) { try { e.message = global.HelmDemojibake(e.message); } catch (_) {} }
    var action = o.action ? String(o.action) : "";
    var pre = action ? "Couldn’t " + action + ". " : "";
    if (isAuthError(e)) return "Your session expired — sign in again.";
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "You’re offline — reconnect and try again.";
    if (isNetworkError(e)) return pre + "Couldn’t reach the server — check your connection and try again.";
    // 0046 D6: a locked (approved / paid / closed-event) money record — the DB message says why
    if (e && e.hint === "money_frozen" && e.message && !TECHNICAL.test(e.message)) return pre + endDot(clip(String(e.message), 240));
    // 0159: a directly created studio is read-only until its plan is paid (or it switches to the trial)
    if (e && e.hint === "payment_pending") return pre + "Choose a plan and complete payment to start using Helm — or start a free trial instead.";
    // 0166 — free-trial seat limit (you + 2 people; open invitations count)
    // 0173 — free-trial lock / 2-row creation cap: the DB message is written for people
    if (e && (e.hint === "trial_cap" || e.hint === "trial_locked") && e.message) return pre + endDot(clip(String(e.message), 240));
    // 0192 - menu package checks (price per plate / dish list): the DB message is written for people
    if (e && e.hint === "menu_pkg_invalid" && e.message) return pre + endDot(clip(String(e.message), 240));
    // B15: a phone refused by phoneOrThrow (staff / nurture / leads: per-country length, India = 10 digits) - the
    // message says what to type ("Enter a 10-digit number for India."), never the generic "Something went wrong"
    if (e && e.code === "invalid_phone" && e.message && !TECHNICAL.test(e.message)) return pre + endDot(clip(String(e.message), 240));
    if (e && e.hint === "seat_limit") return pre + "Your free trial includes you + 2 people, and both seats are in use. Revoke an invitation or remove someone to add another person — or upgrade for more seats.";
    // 0045 / 0069: a suspended (or lapsed-trial) studio is read-only — say so, not "something went wrong"
    // 0183 — the free trial ended unpaid: the whole studio is read-only for everyone until it is upgraded
    if (e && e.hint === "trial_ended") return pre + "Your trial has ended. Your data is preserved and available in read-only mode. Upgrade now to continue creating and editing records.";
    if (e && (e.hint === "studio_suspended" || errCode(e) === "25006")) return pre + "This studio is read-only because its Helm subscription is suspended or the trial has ended — contact Helm (or an admin can renew in Billing).";
    // 0052 lifecycle gates / re-approval: the DB message is written for people
    if (e && (e.code === "HL409" || e.code === "HL428" || e.code === "HL425") && e.message) return endDot(clip(String(e.message), 300));   // 0198 HL425: event day not over
    // r9: a server-raised 22023 / 42501 written as a sentence for people ("Only an admin can
    // re-open a closed event.", "This event is not closed.") is shown as-is instead of a generic line
    var hc = errCode(e), hm = errMsg(e);
    if ((hc === "22023" || hc === "42501") && hm && /^[A-Z][^]*[.!?]$/.test(hm) && !TECHNICAL.test(hm)
        && !/permission denied|not authori[sz]ed|row-level security|insufficient privilege/i.test(hm)) return pre + clip(hm, 300);
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
  // toast(msg, {type, title, timeout:ms (0 = sticky), action:{label,onClick}, href, linkLabel, icon})
  //   type: 'info' | 'ok'/'success' | 'warn'/'warning' | 'err'/'error' | 'security'
  //   href: a same-site link — "Open" action + clicking the card opens it.
  // → { close() }. Same title+message+type already showing → its timer restarts (no stacking).
  // At most 3 cards are visible (oldest dropped). Auto-dismiss pauses on hover / focus.
  var TOAST_TYPES = { ok: "ok", success: "ok", err: "err", error: "err", warn: "warn", warning: "warn", security: "sec", sec: "sec", info: "info" };
  var TOAST_ICON = { info: "i", ok: "✓", warn: "!", err: "✕", sec: "🛡" };
  function toastType(t) { return TOAST_TYPES[t] || "info"; }
  var toastRecent = {};   // r20: title|text -> when its card was last created (burst guard)
  // only relative / same-origin http(s) links (never javascript: / data:)
  function safeHref(u) {
    u = String(u == null ? "" : u).trim(); if (!u) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.indexOf("//") === 0) {
      try { var x = new URL(u, global.location.href); return x.origin === global.location.origin ? x.href : null; } catch (e) { return null; }
    }
    return u;
  }
  function toast(msg, o) {
    o = o || {};
    var type = toastType(o.type);
    var timeout = o.timeout != null ? +o.timeout : (type === "err" ? 8000 : 5000);
    var handle = { close: function () {} };
    var run = function () {
      var fresh = !(toastRoot && toastRoot.isConnected);
      if (!ensureToasts()) return;
      var lane = (type === "err" || type === "sec") ? lanes.assertive : lanes.polite;
      var text = String(msg == null ? "" : msg), title = o.title != null ? String(o.title) : "";
      var key = type + "|" + title + "|" + text, same = title + "|" + text, existing = null;
      // r20: the same title + text is ONE card in either lane (whatever its type) - a repeat restarts its timer
      // instead of stacking another copy ("Step 1 not saved: Email is required." x5)
      Array.prototype.forEach.call(toastRoot.querySelectorAll(".bpui-toast"), function (t) { if (t.__bpuiKey === key || t.__bpuiSame === same) existing = t; });
      if (existing) { if (existing.__bpuiArm) existing.__bpuiArm(true); handle.close = existing.__bpuiClose || handle.close; return; }
      // ...and a burst of the same message (several saves refusing at once) shows once, even if that card was just pushed out
      var nowMs = Date.now(); if (toastRecent[same] && nowMs - toastRecent[same] < 1500) return; if (Object.keys(toastRecent).length > 60) toastRecent = {}; toastRecent[same] = nowMs;
      var href = safeHref(o.href);
      var t = h("div", { class: "bpui-toast bpui-" + type + (title ? " has-title" : " no-title") + (href ? " is-link" : "") });
      t.__bpuiKey = key; t.__bpuiSame = same;
      t.appendChild(h("span", { class: "bpui-toast-ic", "aria-hidden": "true" }, o.icon ? String(o.icon).slice(0, 4) : TOAST_ICON[type]));
      var col = h("div", { class: "bpui-toast-body" });
      var tEl = title ? h("strong", { class: "bpui-toast-title" }) : null;
      var body = h("span", { class: "bpui-toast-msg" });
      if (tEl) col.appendChild(tEl);
      col.appendChild(body);
      t.appendChild(col);
      var timer = null, closed = false, left = timeout, startedAt = 0, bar = null;
      function close() {
        if (closed) return; closed = true; clearTimeout(timer);
        if (t.parentNode) t.parentNode.removeChild(t);
        try { o.onClose && o.onClose(); } catch (e) {}
      }
      function pause() { if (!timer) return; clearTimeout(timer); timer = null; left = Math.max(800, left - (Date.now() - startedAt)); t.classList.add("is-paused"); }
      function arm(restart) {
        clearTimeout(timer); timer = null; t.classList.remove("is-paused");
        if (!(timeout > 0)) return;
        if (restart) { left = timeout; if (bar) { bar.style.animation = "none"; void bar.offsetWidth; bar.style.animation = "bpuiBar " + timeout + "ms linear forwards"; } }
        startedAt = Date.now(); timer = setTimeout(close, left);
      }
      t.__bpuiClose = close; t.__bpuiArm = arm;
      if (o.action && o.action.label) {
        var a = h("button", { type: "button", class: "bpui-toast-act" }, o.action.label);
        a.addEventListener("click", function (ev) { ev.stopPropagation(); try { o.action.onClick && o.action.onClick(); } finally { if (o.action.keepOpen !== true) close(); } });
        col.appendChild(a);
      } else if (href) {
        var ln = h("a", { class: "bpui-toast-act", href: href }, o.linkLabel || "Open");
        ln.addEventListener("click", function (ev) { ev.stopPropagation(); try { o.onOpen && o.onOpen(); } catch (e) {} close(); });
        col.appendChild(ln);
      }
      var x = h("button", { type: "button", class: "bpui-x", "aria-label": "Dismiss notification" }, "×");
      x.addEventListener("click", function (ev) { ev.stopPropagation(); close(); });
      t.appendChild(x);
      if (href) t.addEventListener("click", function () { try { o.onOpen && o.onOpen(); } catch (e) {} close(); try { global.location.assign(href); } catch (e) {} });
      if (timeout > 0) { bar = h("span", { class: "bpui-toast-bar", "aria-hidden": "true" }); bar.style.animation = "bpuiBar " + timeout + "ms linear forwards"; t.appendChild(bar); }
      // pause while hovered / focused so it can be read and acted on
      t.addEventListener("mouseenter", pause);
      t.addEventListener("mouseleave", function () { arm(false); });
      t.addEventListener("focusin", pause);
      t.addEventListener("focusout", function () { arm(false); });
      lane.appendChild(t);
      // at most 3 visible across both lanes — drop the oldest
      var all = function () { return Array.prototype.slice.call(toastRoot.querySelectorAll(".bpui-toast")); };
      var cards = all();
      while (cards.length > 2) { var old = cards.filter(function (c) { return c !== t; })[0]; if (!old) break; if (old.__bpuiClose) old.__bpuiClose(); else old.remove(); cards = all(); }
      // Set the text AFTER insertion (and after a tick when the live region is
      // brand new) so screen readers reliably announce it.
      var setText = function () { if (tEl) tEl.textContent = title; body.textContent = text; };
      if (fresh) setTimeout(setText, 60); else setText();
      arm(false);
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
        var form = h("form", { class: "bpui-dialog" + (o.reveal ? " hbp-skip" : ""), role: "dialog", "aria-modal": "true", "aria-labelledby": id + "-t", novalidate: "" });
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
      try { if (global.performance && performance.mark) performance.mark("helm:boot-done"); } catch (e) {}
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
    try { page = HelmUrl.page(); } catch (e) {}
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
  // one-shot "flash" toast carried across a location.replace (e.g. "Email confirmed")
  function showFlash() {
    var f = null;
    try { f = sessionStorage.getItem("bp_flash"); sessionStorage.removeItem("bp_flash"); } catch (e) {}
    var ty = "ok"; if (f && f.indexOf("i|") === 0) { ty = "info"; f = f.slice(2); }   // R20: "i|..." = a notice, not a success
    if (f && /^[\w .,'!—-]{1,80}$/.test(f)) setTimeout(function () { toast(f, { type: ty }); }, 300);
  }
  function start() { injectCSS(); startModalObserver(); installOffline(); showFlash(); }
  if (doc.readyState !== "loading") start(); else doc.addEventListener("DOMContentLoaded", start, { once: true });

  // B29 (QA): the free trial's creation cap is said BEFORE a form is filled ("2 of 2 used"), instead of a refusal
  // after the whole form. entity = a key of my_trial_limits().used: leads, quotes, inventory_items, vendors,
  // crew_members, venues. Paid studio / older database / any error -> null: nothing changes (the server still refuses).
  function trialCap(entity) {
    var S = global.BPStore;
    if (!S || !S.subscription || typeof S.subscription.limits !== "function") return Promise.resolve(null);
    return Promise.resolve().then(function () { return S.subscription.limits(); }).then(function (r) {
      if (!r || r.trial !== true) return null;
      var cap = Number(r.cap) > 0 ? Number(r.cap) : 2, used = Math.max(0, Number(r.used && r.used[entity]) || 0);
      return { cap: cap, used: used, left: Math.max(0, cap - used), full: used >= cap };
    }, function () { return null; });
  }
  function capText(c, nouns) {
    if (!c) return "";
    var u = Math.min(c.used, c.cap) + " of " + c.cap + " " + (nouns || "new records") + " used";
    return c.full ? "Free trial: " + u + ". Choose a plan to add more." : "Free trial: " + u + ".";
  }
  // capGate(buttons, entity, nouns, opts) -> Promise<cap|null>. At the cap the add buttons are switched off (only the
  // ones this turned off are ever switched back on) and a short note follows the first one; under it the note says how
  // many are used. Re-run after every add / load so the state follows the server.
  // r20 cap note (owner): the note never sits inside a split button (between "New quote" and its caret) - in a button
  // row (.hd-acts) it is a quiet line of its own below the row: "Free trial · 2 of 2 new quotes used · Choose a plan →"
  // (teammates: "Ask your studio admin to choose a plan"). opts.soft: at the cap the button only LOOKS off
  // (aria-disabled + data-cap-soft) so its own click handler can show the friendly cap toast; the caller must check
  // data-cap-off before creating. opts.offTitle: its tooltip at the cap.
  function capNoteFill(note, c, nouns, full) {
    var u = "Free trial \u00b7 " + Math.min(c.used, c.cap) + " of " + c.cap + " " + (nouns || "new records") + " used";
    var role = null;
    try { role = global.BPStore && global.BPStore.auth && global.BPStore.auth.cachedRole ? global.BPStore.auth.cachedRole() : null; } catch (e) {}
    if (!full) { note.textContent = u; return; }
    if (role && role !== "admin") { note.textContent = u + " \u00b7 Ask your studio admin to choose a plan"; return; }
    note.textContent = u + " \u00b7 ";
    note.appendChild(h("a", { href: capHref(), class: "bpui-caplink" }, "Choose a plan \u2192"));
  }
  function capGate(btns, entity, nouns, opts) {
    opts = opts || {};
    var list = (Array.isArray(btns) ? btns : [btns]).filter(function (b) { return b && b.nodeType === 1; });
    return trialCap(entity).then(function (c) {
      var full = !!(c && c.full), txt = capText(c, nouns);
      list.forEach(function (b, i) {
        if (full && opts.soft) {
          if (!b.disabled && b.getAttribute("data-cap-off") !== "1") {
            var t0 = b.getAttribute("title"); if (t0 != null) b.setAttribute("data-cap-title", t0);
            b.setAttribute("data-cap-off", "1"); b.setAttribute("data-cap-soft", "1"); b.setAttribute("aria-disabled", "true");
          }
          b.setAttribute("title", opts.offTitle || txt);
        }
        else if (full) { if (!b.disabled) { b.disabled = true; b.setAttribute("data-cap-off", "1"); } b.setAttribute("title", txt); }
        else if (b.getAttribute("data-cap-off") === "1") {
          if (b.getAttribute("data-cap-soft") === "1") { b.removeAttribute("data-cap-soft"); b.removeAttribute("aria-disabled"); }
          else b.disabled = false;
          b.removeAttribute("data-cap-off");
          var t1 = b.getAttribute("data-cap-title");
          if (t1 != null) { b.setAttribute("title", t1); b.removeAttribute("data-cap-title"); } else b.removeAttribute("title");
        }
        var id = (b.id || entity + "_add" + i) + "_capnote", note = doc.getElementById(id);
        if (i > 0 || !c) { if (note && i === 0) note.remove(); return; }
        injectCSS();
        var row = b.closest ? b.closest(".hd-acts") : null;
        var after = (b.closest && b.closest(".hd-split, .hd-create-slot, .hb-split")) || b;
        if (!note) note = h("span", { id: id, class: "bpui-capnote", role: "status" });
        if (row) { if (note.parentNode !== row || row.lastElementChild !== note) row.appendChild(note); }
        else if (note.previousElementSibling !== after) after.insertAdjacentElement("afterend", note);
        note.classList.toggle("is-below", !!row);
        capNoteFill(note, c, nouns, full); note.classList.toggle("is-full", full);
      });
      return c;
    });
  }

  // L13 (live QA): a "new record" dialog opened at the free-trial cap (e.g. ?hs_act=new at 2 / 2) had Save on, and the
  // server's refusal ("Free trial limit reached (2)") came with no way to upgrade. capDialog(save, errEl, entity, nouns,
  // stillNew) switches Save off and says "Free trial: 2 of 2 items used. Choose a plan to add more" with the link to
  // /checkout; capDialogReset undoes ONLY what capDialog did (call it on every open). capLimit shows the same words for
  // a server refusal. isCapError: the server's trial-cap refusal (0181 hint trial_cap).
  function capHref() {
    var pg = "dashboard";
    try { pg = (global.location.pathname.split("/").pop() || "dashboard").replace(/\.html$/, "") || "dashboard"; } catch (e) {}
    return "/checkout?next=" + encodeURIComponent(pg + ".html");
  }
  function capLimit(errEl, c, nouns) {
    if (!errEl) return;
    var used = c ? "Free trial: " + Math.min(c.used, c.cap) + " of " + c.cap + " " + (nouns || "new records") + " used. " : "Free trial limit reached. ";
    errEl.textContent = "";
    errEl.appendChild(doc.createTextNode(used));
    var a = h("a", { href: capHref(), class: "bpui-caplink" }, "Choose a plan to add more");
    errEl.appendChild(a); errEl.appendChild(doc.createTextNode("."));
    errEl.setAttribute("data-cap", "1"); errEl.hidden = false;
  }
  function capDialogReset(save, errEl) {
    if (save && save.getAttribute("data-cap-off") === "1") { save.disabled = false; save.removeAttribute("data-cap-off"); save.removeAttribute("title"); }
    if (errEl && errEl.getAttribute("data-cap") === "1") { errEl.removeAttribute("data-cap"); errEl.textContent = ""; errEl.hidden = true; }
  }
  function capDialog(save, errEl, entity, nouns, stillNew) {
    capDialogReset(save, errEl);
    return trialCap(entity).then(function (c) {
      if (!c || !c.full || (typeof stillNew === "function" && !stillNew())) return c;
      capLimit(errEl, c, nouns);
      if (save) { if (!save.disabled) { save.disabled = true; save.setAttribute("data-cap-off", "1"); } save.setAttribute("title", capText(c, nouns)); }
      return c;
    }, function () { return null; });
  }
  function isCapError(e) { return !!(e && (e.hint === "trial_cap" || /free trial limit reached/i.test(String(e.message || "")))); }
  // r20 (owner: the trial makes 2 new quotes, 0238): a refused 3rd quote / lead / ... says so in plain words, with the
  // way on ("Choose a plan" -> /checkout). capToast(err, nouns, keep) -> true when err was the trial cap (toast shown),
  // false otherwise (the caller shows its usual error). nouns: "new quotes"; keep: what still works.
  function capToast(e, nouns, keep) {
    if (!isCapError(e)) return false;
    var F = global.HelmTrialFacts, cap = (F && Number(F.CREATE_CAP) > 0) ? Number(F.CREATE_CAP) : 2;
    var w = nouns || "new records";
    toast("Your free trial includes " + cap + " " + w + " and " + (cap === 2 ? "both are" : "all are") + " used. " +
      (keep ? String(keep) + " " : "") + "Choose a plan to add more.",
      { type: "warn", title: "Free trial limit reached", href: capHref(), linkLabel: "Choose a plan", timeout: 12000 });
    return true;
  }
  // L13: a form-level error ("Contact name is required.") goes away as soon as a field in the dialog is changed;
  // the cap message (data-cap) stays - it is not about a field. Bound once per dialog.
  function clearErrOnEdit(box, errEl) {
    if (!box || !errEl || box.__bpuiErrClear) return;
    box.__bpuiErrClear = true;
    var clear = function (e) {
      if (errEl.hidden || errEl.getAttribute("data-cap") === "1" || (e && e.target && errEl.contains(e.target))) return;
      errEl.hidden = true; errEl.textContent = "";
    };
    box.addEventListener("input", clear, true); box.addEventListener("change", clear, true);
  }

  global.BPUI = {
    version: 1,
    trialCap: trialCap, capText: capText, capGate: capGate,
    capDialog: capDialog, capDialogReset: capDialogReset, capLimit: capLimit, isCapError: isCapError, capToast: capToast, clearErrOnEdit: clearErrOnEdit,
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

  // ---- country-based tax (0079) ------------------------------------------------
  // The studio's country (brand.billing.country, mirrored into the pricing config as
  // taxCountry) decides the tax name, the tax-ID label/format, the default rate and the
  // currency. The money itself is still ONE rate (pricing.gstPct) through the shared
  // engine above + the server's helm_quote_total, so totals never diverge. A studio
  // with no country set is India / GST exactly as before.
  BPStore.tax = (function () {
    var C = {
      IN: { name: "India", currency: "INR", symbol: "₹", locale: "en-IN", tax: "GST", idLabel: "GSTIN", idRe: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, idEg: "36ABCDE1234F1Z5", rate: 18, rates: [18, 5, 12, 28, 0], split: true, regionLabel: "State" },
      AE: { name: "United Arab Emirates", currency: "AED", symbol: "AED ", locale: "en-AE", tax: "VAT", idLabel: "TRN", idRe: /^[0-9]{15}$/, idEg: "100123456700003", rate: 5, rates: [5, 0], regionLabel: "Emirate" },
      GB: { name: "United Kingdom", currency: "GBP", symbol: "£", locale: "en-GB", tax: "VAT", idLabel: "VAT number", idRe: /^(GB)?([0-9]{9}|[0-9]{12})$/, idEg: "GB123456789", rate: 20, rates: [20, 5, 0], regionLabel: "County" },
      US: { name: "United States", currency: "USD", symbol: "$", locale: "en-US", tax: "Sales tax", idLabel: "EIN", idRe: /^[0-9]{2}-?[0-9]{7}$/, idEg: "12-3456789", rate: null, rates: [], regionLabel: "State" },
      SG: { name: "Singapore", currency: "SGD", symbol: "S$", locale: "en-SG", tax: "GST", idLabel: "GST reg. no.", idRe: /^([0-9]{8,9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z]|M[0-9A-Z][0-9]{7}[A-Z])$/, idEg: "200312345A", rate: 9, rates: [9, 0], regionLabel: "Region" },
      AU: { name: "Australia", currency: "AUD", symbol: "A$", locale: "en-AU", tax: "GST", idLabel: "ABN", idRe: /^[0-9]{11}$/, idEg: "51824753556", rate: 10, rates: [10, 0], regionLabel: "State" },
      CA: { name: "Canada", currency: "CAD", symbol: "C$", locale: "en-CA", tax: "GST/HST", idLabel: "GST/HST number", idRe: /^[0-9]{9}(RT[0-9]{4})?$/, idEg: "123456789RT0001", rate: null, rates: [5, 13, 15], regionLabel: "Province" },
    };
    var ISO = /^[A-Z]{2}$/;
    function code(cc) { cc = String(cc || "").trim().toUpperCase(); return ISO.test(cc) ? cc : "IN"; }
    function profile(cc) {
      cc = code(cc); var p = C[cc];
      if (p) return Object.assign({ code: cc, known: true }, p);
      var nm = cc; try { var l = (BPStore.countries && BPStore.countries()) || []; for (var i = 0; i < l.length; i++) if (l[i].iso === cc) { nm = l[i].name; break; } } catch (e) {}
      return { code: cc, known: false, name: nm, currency: "", symbol: "", locale: "en-GB", tax: "Tax", idLabel: "Tax ID", idRe: /^[A-Z0-9 ./-]{3,30}$/, idEg: "", rate: null, rates: [], regionLabel: "Region" };
    }
    var cleanName = function (v) { return String(v == null ? "" : v).replace(/[<>"'`\u0000-\u001f]/g, "").trim().slice(0, 24); };
    var isTrue = function (v) { return String(v).toLowerCase() === "true"; };
    // cfg = pricing config OR a quote's pricing snapshot ({taxCountry,taxName,gstPct,taxInclusive,currency})
    function resolve(cfg) {
      cfg = cfg || {}; var p = profile(cfg.taxCountry || "IN");
      var HC = (typeof window !== "undefined" && window.HelmCountry) || (typeof globalThis !== "undefined" && globalThis.HelmCountry) || null;
      var region = String(cfg.taxRegion || "").replace(/[<>"'`\u0000-\u001f]/g, "").trim().slice(0, 60);
      // 0089: default rate = studio override > US state base rate (HelmCountry) > country default
      var dflt = (HC && (p.code === "US" || p.code === "AE" || p.code === "IN")) ? HC.defaultRate(p.code, region, cfg.taxRateOverride) : (p.rate == null ? 0 : p.rate);
      var r = Number(cfg.gstPct); var rate = (cfg.gstPct == null || cfg.gstPct === "" || !isFinite(r)) ? dflt : r;
      var exempt = isTrue(cfg.taxExempt); if (exempt) rate = 0;
      var cur = String(cfg.currency || "").trim().toUpperCase();
      var currency = p.known ? p.currency : (/^[A-Z]{3}$/.test(cur) ? cur : "INR");
      var name = (!p.known && cleanName(cfg.taxName)) || p.tax;
      return { country: p.code, countryName: p.name, name: name, rate: rate, inclusive: isTrue(cfg.taxInclusive), currency: currency,
        symbol: p.known ? p.symbol : (currency === "INR" ? "₹" : currency + " "), locale: p.locale, split: !!p.split,
        idLabel: p.idLabel, idEg: p.idEg, rates: p.rates.slice(), regionLabel: p.regionLabel,
        region: region, exempt: exempt, invoiceTitle: p.code === "IN" || p.code === "AE" ? "Tax Invoice" : "Invoice" };
    }
    function money(n, res) {
      res = res || resolve({}); var x = Number(n); if (!isFinite(x)) x = 0;
      var neg = x < 0; x = Math.abs(x);
      var s; try { s = x.toLocaleString(res.locale, { maximumFractionDigits: x % 1 ? 2 : 0, minimumFractionDigits: x % 1 ? 2 : 0 }); } catch (e) { s = String(Math.round(x)); }
      return (neg ? "− " : "") + res.symbol + s;
    }
    function validateId(cc, raw) {
      var p = profile(cc); var v = String(raw == null ? "" : raw).toUpperCase().replace(/\s+/g, "");
      if (!v) return { ok: true, value: "" };
      if (v.length > 30 || !p.idRe.test(v)) return { ok: false, value: v, error: "Enter a valid " + p.idLabel + (p.idEg ? ", e.g. " + p.idEg : "") + " (or leave it blank)." };
      return { ok: true, value: v };
    }
    // India: same state -> intra (CGST+SGST), different -> inter (IGST); null when unknown
    function placeOfSupply(studioState, otherState) {
      var n = function (s) { return String(s || "").toLowerCase().replace(/[^a-z]/g, ""); };
      var a = n(studioState), b = n(otherState); if (!a || !b) return null;
      return a === b ? "intra" : "inter";
    }
    // qa-quote-flow B28: GST is rounded ONCE to whole rupees and split from that, so CGST + SGST always
    // add up to the GST line and every screen shows the same two numbers (39,722 + 39,721, never 39,721.5)
    function halves(gst) { var g = Math.round(Number(gst) || 0), a = Math.round(g / 2); return [a, g - a]; }
    // display rows for the tax part of a breakdown: [{label, pct, amount}]
    function rows(t, pricing, res) {
      res = res || resolve(pricing); t = t || {}; pricing = pricing || {};
      var gst = Number(t.totalGst != null ? t.totalGst : t.gst) || 0, pct = res.rate;
      var inc = res.inclusive ? " (included)" : "";
      if (res.exempt || String(pricing.taxExempt).toLowerCase() === "true") return [{ label: res.name + " (exempt)", pct: 0, amount: 0 }];
      if (res.split) {
        if (pricing.placeOfSupply === "inter") return [{ label: "IGST" + inc, pct: pct, amount: gst }];
        var hv = halves(gst);
        return [{ label: "CGST" + inc, pct: pct / 2, amount: hv[0] }, { label: "SGST" + inc, pct: pct / 2, amount: hv[1] }];
      }
      var st = ""; if (res.country === "US" && res.region) { var HC = (typeof window !== "undefined" && window.HelmCountry) || null, f = HC && HC.findRegion("US", res.region); st = " (" + (f ? f.code : res.region) + ")"; }
      return [{ label: res.name + st + inc, pct: pct, amount: gst }];
    }
    // keys a quote's pricing snapshot carries so client pages (which can't read the
    // studio config) label it right. India/exclusive adds nothing -> payload unchanged.
    function snapshot(res) {
      var o = {}; if (!res) return o;
      if (res.country !== "IN") { o.taxCountry = res.country; o.taxName = res.name; o.currency = res.currency; }
      if (res.inclusive) o.taxInclusive = true;
      if (res.exempt) o.taxExempt = true;
      if (res.region && res.country !== "IN") o.taxRegion = res.region;
      return o;
    }
    // live-round2 C3: every pricing WRITE keeps the quote's existing tax identity. A priced quote
    // (gstPct/total present) keeps its taxCountry/taxRegion/currency/taxName/taxInclusive exactly as
    // stored (absent stays absent) unless the user explicitly switched (opts.switch). taxExempt /
    // placeOfSupply / supplier are kept when the writer doesn't mention them at all.
    var IDENT = ["taxCountry", "taxRegion", "currency", "taxName", "taxInclusive"], SOFT = ["taxExempt", "placeOfSupply", "supplier"];
    function preserveSnapshot(prev, next, opts) {
      var out = Object.assign({}, next || {}); prev = prev && typeof prev === "object" ? prev : {};
      if (opts && opts.switch) return out;
      var priced = ("gstPct" in prev) || ("total" in prev);
      if (priced) IDENT.forEach(function (k) { if (prev[k] !== undefined && prev[k] !== null) out[k] = prev[k]; else delete out[k]; });
      SOFT.forEach(function (k) { if (!(k in out) && prev[k] !== undefined) out[k] = prev[k]; });
      return out;
    }
    // india-clickthrough D1: a quote that was NEVER priced (no gstPct/total, no approval sent, not
    // confirmed) has no tax identity worth freezing - it adopts the studio's CURRENT country. Returns
    // the re-stamped pricing, or null when nothing changes. Priced quotes are never touched here.
    function isPricedQuote(q) {
      q = q && typeof q === "object" ? q : {}; var p = q.pricing && typeof q.pricing === "object" ? q.pricing : {};
      var ap = q.approvalStatus || q.approval_status || "none";
      return ("gstPct" in p) || ("total" in p) || q.status === "confirmed" || !!(q.confirmedAt || q.confirmed_at) || (ap && ap !== "none");
    }
    function restampUnpriced(q, studioRes) {
      if (!q || isPricedQuote(q) || !studioRes) return null;
      var pr = q.pricing && typeof q.pricing === "object" ? q.pricing : {}, snap = snapshot(studioRes), out = Object.assign({}, pr);
      IDENT.forEach(function (k) { delete out[k]; }); Object.assign(out, snap);
      var same = IDENT.every(function (k) { return pr[k] === out[k]; });
      return same ? null : out;
    }
    function countries() { return Object.keys(C).map(function (k) { return { iso: k, name: C[k].name }; }); }
    return { COUNTRIES: C, profile: profile, resolve: resolve, money: money, validateId: validateId, placeOfSupply: placeOfSupply, halves: halves, rows: rows, snapshot: snapshot, preserveSnapshot: preserveSnapshot, isPricedQuote: isPricedQuote, restampUnpriced: restampUnpriced, SNAPSHOT_KEYS: IDENT.concat(SOFT), countries: countries, code: code };
  })();

  // ---- studio money (0089) -------------------------------------------------------
  // Pages that only know "the studio" (settlement, budget, inventory, closure, ...) format
  // money through here. The studio's tax country is remembered for the tab session when
  // the pricing config loads; until then (and for every Indian studio) the output is
  // byte-identical to the old "₹" + toLocaleString("en-IN").
  var STUDIO_TAX_KEY = "helm.studioTax";
  BPStore.rememberStudioTax = function (cfg) {
    cfg = cfg || {}; var o = { taxCountry: cfg.taxCountry || "IN", taxRegion: cfg.taxRegion || "", currency: cfg.currency || "" };
    try { sessionStorage.setItem(STUDIO_TAX_KEY, JSON.stringify(o)); } catch (e) {}
    // also kept across tabs/reloads (cleared on sign-out via USER_LOCAL_KEYS) so a UAE/US
    // studio never sees a "\u20b9" flash before the pricing config loads on the next page
    try { localStorage.setItem(STUDIO_TAX_KEY, JSON.stringify(o)); } catch (e) {}
    BPStore._studioTax = BPStore.tax.resolve(o);
    try { if (typeof document !== "undefined") BPStore.localizeCurrency(document); } catch (e) {}
    return BPStore._studioTax;
  };
  BPStore.studioTax = function () {
    if (BPStore._studioTax) return BPStore._studioTax;
    var o = null; try { o = JSON.parse(sessionStorage.getItem(STUDIO_TAX_KEY) || "null"); } catch (e) {}
    if (!o) { try { o = JSON.parse(localStorage.getItem(STUDIO_TAX_KEY) || "null"); } catch (e) {} }
    if (!o || typeof o !== "object") o = null;
    return (BPStore._studioTax = BPStore.tax.resolve(o || {}));
  };
  // ---- per-QUOTE money (live-round1 B11) ------------------------------------------
  // A quote is priced in ITS OWN tax country/currency: pricing.taxCountry (snapshot keys) >
  // quotes.tax_snapshot.country > India. A quote with no snapshot is an India/INR quote (every
  // pre-0089 quote is) - NEVER the studio's current country.
  BPStore.quoteTaxCfg = function (q) {
    q = q && typeof q === "object" ? q : {};
    var p = q.pricing && typeof q.pricing === "object" ? q.pricing : (q.taxCountry !== undefined || q.gstPct !== undefined ? q : {});
    var cfg = Object.assign({}, p), ts = q.tax_snapshot && typeof q.tax_snapshot === "object" ? q.tax_snapshot : null;
    if (!cfg.taxCountry && ts && ts.country) { cfg.taxCountry = ts.country; if (!cfg.taxRegion && ts.region) cfg.taxRegion = ts.region; if (!cfg.taxName && ts.taxName) cfg.taxName = ts.taxName; }
    if (!cfg.taxCountry) { cfg.taxCountry = "IN"; cfg.currency = "INR"; }
    return cfg;
  };
  BPStore.quoteTax = function (q) { return BPStore.tax.resolve(BPStore.quoteTaxCfg(q)); };
  BPStore.quoteMoney = function (n, q, opts) {
    var r = q && q.country && q.symbol ? q : BPStore.quoteTax(q), x = Number(n || 0); if (opts && opts.round) x = Math.round(x);
    if (r.country === "IN") return "\u20b9" + x.toLocaleString("en-IN");
    return BPStore.tax.money(x, r);
  };
  // ---- qts-1018: ONE status label + ONE invoice total for every screen ----------------------
  // A quote has three state columns: status (quote / confirmed = the studio priced + LOCKED it /
  // cancelled), approval_status (none / sent / approved / paid) and lifecycle_stage. Screens used
  // to print them side by side ("Confirmed · awaiting client approval" + "Sent"), so a locked quote
  // read as confirmed before the client approved it. quoteStatus() folds them into ONE label:
  // "Confirmed" only once the client approved (or paid, or the event already moved past the
  // Confirmed stage); a locked quote the client has not approved is "Sent · awaiting client approval".
  var QS_STAGES = ["lead", "discovery", "proposal", "quote", "confirmed", "planning", "resources", "ready", "event_day", "settlement", "closed"];
  BPStore.quoteStatus = function (q, opts) {
    q = q && typeof q === "object" ? q : {}; opts = opts || {};
    var st = String(q.status || "quote"), ap = String(q.approvalStatus || q.approval_status || "none");
    var lc = String(q.lifecycleStage || q.lifecycle_stage || "quote"), si = QS_STAGES.indexOf(lc);
    var closed = lc === "closed" || !!(q.closedAt || q.closed_at);
    var mk = function (key, label, tone, title, confirmed) { return { key: key, label: label, tone: tone, title: title || "", confirmed: !!confirmed }; };
    if (st === "cancelled") return mk("cancelled", "Cancelled", "cancelled", "This event was cancelled.");
    if (closed) return mk("closed", "Closed", "closed", "The event is settled and closed.", true);
    if (ap === "paid" || opts.advance) return mk("booked", "Confirmed · advance paid", "paid", "The client's advance is in - the date is booked.", true);
    if (ap === "approved") return mk("approved", "Confirmed · client approved", "confirmed", "The client approved this quote.", true);
    // lifecycle at/after Confirmed: the client's consent moved it there (0052), or an admin override
    if (si >= QS_STAGES.indexOf("confirmed"))
      return mk("confirmed", "Confirmed", "confirmed", "Moved to Confirmed by the studio - no online client approval on record.", true);
    if (ap === "sent") return mk("sent", "Sent · awaiting client approval", "sent", "The approval link is with the client - it becomes Confirmed when they approve.");
    if (st === "confirmed") return mk("locked", "Locked · not sent yet", "locked", "Priced and locked - send the client the approval link.");
    return mk("quote", "Quote", "draft", "Draft quote - price it, then send it for approval.");
  };
  // The invoice total = the SERVER-priced quote total (pricing.total is stamped by the D8 trigger
  // zz_enforce_pricing_total on every write - never a client-side recompute) + APPROVED change orders.
  // Same rule as budget.summary().revenue (workspace, settlement, closure), so list, dashboard and
  // workspace header can never disagree. changeTotal: that quote's approved change-order sum.
  BPStore.invoiceTotal = function (q, changeTotal) {
    q = q && typeof q === "object" ? q : {};
    var b = Number(q.total != null ? q.total : (q.pricing && q.pricing.total));
    if (!isFinite(b) || !(b > 0)) return 0;
    var c = Number(changeTotal || 0); if (!isFinite(c)) c = 0;
    return Math.round((b + c) * 100) / 100;
  };
  BPStore.studioMoney = function (n, opts) {
    var r = BPStore.studioTax(), x = Number(n || 0); if (opts && opts.round) x = Math.round(x);
    if (r.country === "IN") return "\u20b9" + x.toLocaleString("en-IN");
    return BPStore.tax.money(x, r);
  };
  // ---- 0094: money across MANY quotes is totalled PER CURRENCY (never ₹ + AED together) ----
  // A quote's currency = quotes.currency (stamped by 0089, backfilled by 0091), else its own
  // pricing/tax snapshot (quoteTax), else INR. No FX conversion anywhere.
  BPStore.quoteCurrency = function (q) {
    var c = q && typeof q === "object" && typeof q.currency === "string" ? q.currency.trim().toUpperCase() : "";
    if (/^[A-Z]{3}$/.test(c)) return c;
    var r = BPStore.quoteTax(q); return (r && r.currency) || "INR";
  };
  BPStore.studioCurrency = function () {
    var r = null; try { r = BPStore.studioTax(); } catch (e) {}
    return (r && r.currency) || "INR";
  };
  // n in a given currency; the studio's own currency formats exactly like studioMoney
  BPStore.moneyIn = function (n, cur, opts) {
    cur = String(cur || "").trim().toUpperCase() || "INR";
    var x = Number(n || 0); if (!isFinite(x)) x = 0; if (opts && opts.round) x = Math.round(x);
    if (cur === BPStore.studioCurrency()) return BPStore.studioMoney(x);
    if (cur === "INR") return "₹" + x.toLocaleString("en-IN");
    var cc = { AED: "AE", USD: "US", GBP: "GB", SGD: "SG", AUD: "AU", CAD: "CA" }[cur];
    if (cc) return BPStore.tax.money(x, BPStore.tax.resolve({ taxCountry: cc }));
    return (x < 0 ? "− " : "") + cur + " " + Math.abs(x).toLocaleString("en-US");
  };
  // rows -> [{currency, symbol, total, count}], studio currency first, then most rows, then A-Z.
  // amountFn(row) -> number (null/NaN rows are counted but add 0); curFn defaults to quoteCurrency.
  BPStore.sumByCurrency = function (rows, amountFn, curFn) {
    var by = {}, list = [], home = BPStore.studioCurrency();
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var c = String((curFn ? curFn(r) : BPStore.quoteCurrency(r)) || "INR").trim().toUpperCase() || "INR";
      var v = Number(amountFn ? amountFn(r) : 0);
      if (!by[c]) { by[c] = { currency: c, symbol: c === "INR" ? "₹" : c === "USD" ? "$" : c + " ", total: 0, count: 0 }; list.push(by[c]); }
      by[c].count++; if (isFinite(v)) by[c].total += v;
    });
    list.forEach(function (g) { g.total = Math.round(g.total * 100) / 100; });
    return list.sort(function (a, b) { return (b.currency === home) - (a.currency === home) || b.count - a.count || (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0); });
  };
  // [{currency,total}] -> "₹12,66,494 · AED 615,300" (one currency = exactly one number)
  BPStore.formatByCurrency = function (groups, opts) {
    var g = Array.isArray(groups) ? groups.filter(Boolean) : [];
    if (!g.length) return BPStore.moneyIn(0, BPStore.studioCurrency(), opts);
    return g.map(function (x) { return BPStore.moneyIn(x.total, x.currency, opts); }).join(" · ");
  };
  // ---- 0092: a client's WhatsApp number for wa.me links (digits, full E.164 without "+") ----
  // A number with "+" / "00" keeps its own country code; one typed without a code gets the
  // given country's (else the studio's) dial code: IN +91 (as before), AE +971, US +1. "" if invalid.
  BPStore.waNumber = function (raw, cc) {
    var s = String(raw == null ? "" : raw).trim(); if (!s) return "";
    var c = s.replace(/[\s\-().]/g, ""); if (/^00\d/.test(c)) c = "+" + c.slice(2);
    if (c[0] === "+") { var d0 = c.slice(1); if (!/^\d{7,15}$/.test(d0)) return "";
      if (/^971/.test(d0)) { var n0 = d0.slice(3).replace(/^0/, ""); return /^(5\d{8}|[234679]\d{7})$/.test(n0) ? "971" + n0 : ""; }
      if (/^91/.test(d0) && d0.length > 12) { var n1 = d0.slice(2).replace(/^0/, ""); return n1.length === 10 ? "91" + n1 : ""; }
      return d0; }
    var d = c; if (!/^\d{7,15}$/.test(d)) return "";
    var k = BPStore.tax.code(cc || (BPStore.studioTax() || {}).country);
    if (k === "US") return /^\d{10}$/.test(d) ? "1" + d : d;
    // UAE: 9 national digits for a mobile (5X XXX XXXX), 8 for a landline; trunk 0 dropped
    if (k === "AE") { if (/^9710?\d{8,9}$/.test(d)) { var n = d.slice(3).replace(/^0/, ""); return /^(5\d{8}|[234679]\d{7})$/.test(n) ? "971" + n : ""; }
      var a = d.replace(/^0/, ""); return /^(5\d{8}|[234679]\d{7})$/.test(a) ? "971" + a : ""; }
    if (/^\d{10}$/.test(d)) return "91" + d; if (/^0\d{10}$/.test(d)) return "91" + d.slice(1); return d;
  };
  // ---- payment terms from onboarding (pricing config: advancePct / balanceDueDays / paymentTermsNote) ----
  // {advancePct (0-100, null when the studio never set one), balanceDueDays, note, balanceDue: "YYYY-MM-DD"|null}
  // B6: ONE default advance % for every screen when the studio has not set its own (flow, onboarding)
  BPStore.DEFAULT_ADVANCE_PCT = 10;
  BPStore.paymentTerms = function (cfg, eventDate) {
    cfg = cfg && typeof cfg === "object" ? cfg : {};
    var a = Number(cfg.advancePct), d = Number(cfg.balanceDueDays);
    var adv = cfg.advancePct != null && cfg.advancePct !== "" && isFinite(a) && a >= 0 && a <= 100 ? Math.round(a * 100) / 100 : null;
    var days = cfg.balanceDueDays != null && cfg.balanceDueDays !== "" && Number.isInteger(d) && d >= 0 && d <= 365 ? d : null;
    var note = typeof cfg.paymentTermsNote === "string" ? cfg.paymentTermsNote.replace(/[<>\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, 500) : "";
    var due = null;
    if (days != null && /^\d{4}-\d{2}-\d{2}$/.test(String(eventDate || ""))) {
      var t = Date.UTC(+eventDate.slice(0, 4), +eventDate.slice(5, 7) - 1, +eventDate.slice(8, 10)) - days * 86400000;
      if (isFinite(t)) due = new Date(t).toISOString().slice(0, 10);
    }
    return { advancePct: adv, balanceDueDays: days, note: note, balanceDue: due };
  };
  // ---- supplier block for printed quotes / invoices (UAE Art. 59: name, address, TRN) ----
  // 0098: client-facing payment state from the LEDGER (never milestones / approval_status alone).
  // st = public_quote_paid_status row; total falls back to the quote's own pricing.total.
  // -> {full, paid, total, balance, receipt, balanceDue:"YYYY-MM-DD"|null} or null when unknown
  // India date format dd/mm/yyyy for a "YYYY-MM-DD" (or ISO) date; anything else is returned as-is
  BPStore.fmtDateIN = function (d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
    if (m && BPStore.fmtStudioDate) { var o = BPStore.fmtStudioDate(m[0]); if (o) return o; }   // LA-27: the studio's own order (IN/AE/GB: dd/mm/yyyy, US: mm/dd/yyyy)
    return m ? m[3] + "/" + m[2] + "/" + m[1] : String(d || "");
  };
  // ---- LA-27: ONE date formatter for the whole app: the STUDIO's locale + the STUDIO's timezone ----
  // (never the viewer's browser locale / clock). A calendar day "YYYY-MM-DD" is never shifted by a zone.
  // style: "short" (default) 20/12/2026 · "medium" Sun, 20 Dec · "long" 20 Dec 2026 · "weekday" Sunday ·
  // "month" December 2026 · "daymonth" 20 December · "time" 07:00 pm; or opts.fmt = explicit Intl fields.
  // opts.time adds the time to a timestamp; opts.year adds the year to "medium". A local Date that stands for a
  // calendar DAY must be passed as its "YYYY-MM-DD" string (else the studio zone could move it a day).
  var STUDIO_TZ_KEY = "helm.studioTz";
  BPStore.rememberStudioTimezone = function (tz) {
    tz = typeof tz === "string" ? tz.trim() : "";
    if (tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch (e) { tz = ""; } }
    try { if (tz) localStorage.setItem(STUDIO_TZ_KEY, tz); } catch (e) {}
    BPStore._studioTz = tz || null; return tz;
  };
  BPStore.studioTimezone = function () {
    var tz = BPStore._studioTz || "";
    if (!tz) { try { tz = localStorage.getItem(STUDIO_TZ_KEY) || ""; } catch (e) {} }
    if (!tz) { try { var H = (typeof window !== "undefined" && window.HelmCountry) || null, cc = (BPStore.studioTax() || {}).country; tz = H && H.timezone ? H.timezone(cc) : ""; } catch (e) {} }
    if (tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch (e) { tz = ""; } }
    return tz || undefined;
  };
  BPStore.studioLocale = function () {
    var r = null; try { r = BPStore.studioTax(); } catch (e) {}
    var loc = (r && r.locale) || "en-IN"; try { new Intl.DateTimeFormat(loc); } catch (e) { loc = "en-IN"; } return loc;
  };
  BPStore.fmtStudioDate = function (v, opts) {
    opts = opts || {};
    if (v == null || v === "") return "";
    var s = typeof v === "string" ? v.trim() : v, m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null, d, tz;
    if (m) { d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)); tz = "UTC"; }
    else { d = (v && typeof v.getTime === "function") ? v : new Date(s); tz = BPStore.studioTimezone(); }
    if (!d || isNaN(d.getTime())) return typeof v === "string" ? v : "";
    var st = opts.style || "short", f;
    if (opts.fmt && typeof opts.fmt === "object") f = Object.assign({}, opts.fmt);   // explicit Intl fields (no timeZone: the studio's is added)
    else if (st === "medium") { f = { weekday: "short", day: "numeric", month: "short" }; if (opts.year) f.year = "numeric"; }
    else if (st === "long") f = { day: "numeric", month: "short", year: "numeric" };
    else if (st === "weekday") f = { weekday: opts.narrow ? "short" : "long" };
    else if (st === "month") f = { month: "long", year: "numeric" };
    else if (st === "daymonth") f = { day: "numeric", month: "long" };
    else if (st === "time") f = { hour: "2-digit", minute: "2-digit" };
    else f = { day: "2-digit", month: "2-digit", year: "numeric" };
    if (opts.time && !m && st !== "time") { f.hour = "2-digit"; f.minute = "2-digit"; }
    if (tz) f.timeZone = tz;
    try { return d.toLocaleString(BPStore.studioLocale(), f); }
    catch (e) { return m ? m[3] + "/" + m[2] + "/" + m[1] : d.toISOString().slice(0, 16).replace("T", " "); }
  };
  // ---- LA-28: one label for every lead stage + event lifecycle stage + lead source (never a raw lowercase key) ----
  var STAGE_LABELS = { "new": "New", qualified: "Qualified", discovery: "Discovery", quoted: "Quoted", won: "Won", lost: "Lost",
    lead: "Lead", proposal: "Proposal", quote: "Quote", confirmed: "Confirmed", planning: "Planning", resources: "Resources",
    ready: "Ready", event_day: "Event Day", settlement: "Settlement", closed: "Closed", cancelled: "Cancelled", archived: "Archived" };
  BPStore.stageLabel = function (k) {
    var raw = String(k == null ? "" : k).trim(); if (!raw) return "";
    var key = raw.toLowerCase().replace(/[\s-]+/g, "_");
    if (STAGE_LABELS[key]) return STAGE_LABELS[key];
    var t = raw.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1);
  };
  var SOURCE_LABELS = { "walk_in": "Walk-in", walkin: "Walk-in", google: "Google", instagram: "Instagram", facebook: "Facebook", whatsapp: "WhatsApp",
    referral: "Referral", website: "Website", social: "Other social", ad: "Ad", phone: "Phone", email: "Email", other: "Other", justdial: "Justdial", wedmegood: "WedMeGood" };
  BPStore.sourceLabel = function (v) {
    var raw = String(v == null ? "" : v).trim().replace(/\s+/g, " "); if (!raw) return "";
    var key = raw.toLowerCase().replace(/[\s-]+/g, "_");
    if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
    return raw.charAt(0).toUpperCase() + raw.slice(1);   // first letter only: "walk-in" never becomes "Walk-In"
  };
  // the user's LOCAL calendar day (IST for an Indian studio) as YYYY-MM-DD - toISOString() is UTC
  // and reads as "yesterday" from 00:00 to 05:30 IST
  // B18: the calendar day in the STUDIO's timezone (Asia/Kolkata for an Indian studio), not the device's -
  // a browser set to America/Chicago no longer gets yesterday's date for "today" / date-picker minimums.
  // Falls back to the device day only when the studio zone is unknown.
  BPStore.todayLocal = function (d) {
    d = (d && typeof d.getFullYear === "function") ? d : new Date();   // also a Date from another realm (iframe / test vm)
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    var tz; try { tz = BPStore.studioTimezone ? BPStore.studioTimezone() : undefined; } catch (e) { tz = undefined; }
    if (tz && !isNaN(d.getTime())) {
      try {
        var parts = {}; new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
          .formatToParts(d).forEach(function (x) { parts[x.type] = x.value; });
        if (/^\d{4}$/.test(parts.year) && /^\d{2}$/.test(parts.month) && /^\d{2}$/.test(parts.day)) return parts.year + "-" + parts.month + "-" + parts.day;
      } catch (e) {}
    }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  };
  // B18: wall-clock parts of an instant in the studio's timezone -> { y, mo, d, h, mi, s, date:"YYYY-MM-DD", min: minutes since midnight }
  BPStore.studioClock = function (v) {
    var d = v == null ? new Date() : ((v && typeof v.getTime === "function") ? v : new Date(v));
    if (isNaN(d.getTime())) return null;
    var tz; try { tz = BPStore.studioTimezone ? BPStore.studioTimezone() : undefined; } catch (e) { tz = undefined; }
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var y = d.getFullYear(), mo = d.getMonth() + 1, dd = d.getDate(), h = d.getHours(), mi = d.getMinutes(), s = d.getSeconds();
    if (tz) {
      try {
        var pt = {}; new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
          .formatToParts(d).forEach(function (x) { pt[x.type] = x.value; });
        y = +pt.year; mo = +pt.month; dd = +pt.day; h = (+pt.hour) % 24; mi = +pt.minute; s = +pt.second;
      } catch (e) {}
    }
    return { y: y, mo: mo, d: dd, h: h, mi: mi, s: s, date: y + "-" + pad(mo) + "-" + pad(dd), min: h * 60 + mi };
  };
  // date + time for display: dd/mm/yyyy, hh:mm (US studio: its own order) - never the browser's locale default
  BPStore.fmtDay = function (iso) {
    var d = new Date(iso); if (iso == null || iso === "" || isNaN(d.getTime())) return "";
    if (BPStore.fmtStudioDate) { var o = BPStore.fmtStudioDate(iso); if (o) return o; }
    var loc = "en-IN"; try { if (BPStore.studioTax && BPStore.studioTax().country === "US") loc = "en-US"; } catch (e) {}
    try { return d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit", year: "numeric" }); } catch (e) { return d.toISOString().slice(0, 10); }
  };
  BPStore.fmtDateTime = function (iso) {
    var d = new Date(iso); if (iso == null || iso === "" || isNaN(d.getTime())) return "";
    if (BPStore.fmtStudioDate) { var o = BPStore.fmtStudioDate(iso, { time: true }); if (o) return o; }
    var loc = "en-IN"; try { if (BPStore.studioTax && BPStore.studioTax().country === "US") loc = "en-US"; } catch (e) {}
    try { return d.toLocaleString(loc, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return d.toISOString(); }
  };
  // E13: the tax inside a quote's total (0 when exempt). The server total is the authority (D8); the
  // saved computed.totalGst is used only when it belongs to that same total, else it is derived from gstPct.
  BPStore.quoteTaxAmount = function (pricing, total) {
    var p = pricing && typeof pricing === "object" ? pricing : {};
    var t = Number(total != null ? total : p.total); if (!isFinite(t) || t <= 0) return 0;
    if (p.taxExempt === true || String(p.taxExempt) === "true") return 0;
    var c = p.computed && typeof p.computed === "object" ? p.computed : null;
    if (c && isFinite(Number(c.totalGst)) && isFinite(Number(c.total)) && Math.abs(Number(c.total) - t) <= 1)
      return Math.max(0, Math.min(t, Math.round(Number(c.totalGst) * 100) / 100));
    var g = Number(p.gstPct); if (!isFinite(g) || g <= 0 || g > 100) return 0;
    return Math.round((t - t / (1 + g / 100)) * 100) / 100;
  };
  BPStore.paidState = function (st, fallbackTotal) {
    if (!st || typeof st !== "object") return null;
    var paid = Number(st.paid), total = st.total != null && st.total !== "" ? Number(st.total) : Number(fallbackTotal);
    if (!isFinite(paid) || !isFinite(total) || total <= 0) return null;
    var due = null, ev = String(st.event_date || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(ev)) due = st.balance_due_days != null ? BPStore.paymentTerms({ balanceDueDays: st.balance_due_days }, ev).balanceDue || ev : ev;
    var bal = Math.max(0, Math.round((total - paid) * 100) / 100);
    return { full: paid >= total - 0.5, paid: paid, total: total, balance: bal,
      receipt: typeof st.last_receipt === "string" ? st.last_receipt.replace(/[<>\u0000-\u001f]/g, "").slice(0, 60) : "", balanceDue: due };
  };
  BPStore.studioHeader = function (org) {
    org = org && typeof org === "object" ? org : {};
    var b = org.brand && typeof org.brand === "object" ? org.brand : {}, bl = b.billing && typeof b.billing === "object" ? b.billing : {};
    var str = function (v) { return typeof v === "string" ? v.replace(/[<>\u0000-\u001f]/g, " ").trim() : ""; };
    var cc = /^[A-Z]{2}$/.test(String(bl.country || "")) ? bl.country : "IN";
    var prof = BPStore.tax.profile(cc);
    var addr = [str(bl.line1), str(bl.line2), [str(bl.city), str(bl.state), str(bl.pin)].filter(Boolean).join(", "), prof.name].filter(Boolean).join(", ");
    return { name: str(bl.legal_name) || str(org.name) || "", tradeName: str(org.name), address: addr, country: cc,
      taxIdLabel: prof.idLabel || "Tax ID", taxId: str(org.gst_number).toUpperCase(), phone: str(b.phone) };
  };
  // B15: supplier block for a printed quote. The header frozen on the quote at confirmation
  // (pricing.supplier) wins; an older quote only gets the CURRENT studio header when the studio's
  // country is the quote's tax country - otherwise just the studio name (no mismatched tax ID / address).
  BPStore.quoteSupplier = function (q, org) {
    var r = BPStore.quoteTax(q), p = (q && q.pricing) || {}, sp = p.supplier && typeof p.supplier === "object" ? p.supplier : null;
    var str = function (v) { return typeof v === "string" ? v.replace(/[<>\u0000-\u001f]/g, " ").trim().slice(0, 300) : ""; };
    if (sp && (!sp.country || BPStore.tax.code(sp.country) === r.country))
      return { name: str(sp.name), tradeName: str(sp.tradeName), address: str(sp.address), country: r.country, taxIdLabel: str(sp.taxIdLabel) || BPStore.tax.profile(r.country).idLabel, taxId: str(sp.taxId), phone: str(sp.phone), frozen: true };
    var cur = BPStore.studioHeader(org);
    if (BPStore.tax.code(cur.country) === r.country) return cur;
    return { name: cur.tradeName || cur.name, tradeName: "", address: "", country: r.country, taxIdLabel: "", taxId: "", phone: cur.phone, mismatch: true };
  };
  // the snapshot stored on a quote when it is confirmed (fill-only: an existing one is kept)
  BPStore.supplierSnapshot = function (org, quoteCountry) {
    var h = BPStore.studioHeader(org); if (BPStore.tax.code(h.country) !== BPStore.tax.code(quoteCountry || "IN")) return null;
    return { name: h.name, tradeName: h.tradeName, address: h.address, country: h.country, taxIdLabel: h.taxIdLabel, taxId: h.taxId, phone: h.phone };
  };
  // B16: a date for print/display in the quote's locale; "" for missing / epoch / invalid values
  BPStore.quoteDate = function (iso, r) {
    if (iso == null || iso === "" || iso === 0) return "";
    var d = new Date(iso), t = d.getTime(); if (!isFinite(t) || t < Date.UTC(2000, 0, 1)) return "";
    var loc = r && r.country === "US" ? "en-US" : "en-GB";
    try { return d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit", year: "numeric" }); } catch (e) { return d.toISOString().slice(0, 10); }
  };
  // Custom-field edits (0088): re-read the row's CURRENT attributes and apply only the changed
  // keys, so a save never wipes keys another tab / an import added since the form opened.
  BPStore.mergeAttributes = async function (table, id, ch) {
    if (["crew_members", "inventory_items"].indexOf(table) < 0) throw new Error("Unknown list.");
    var base = {};
    if (mode === "supabase" && supa && id) {
      var r = await supa.from(table).select("attributes").eq("id", id).maybeSingle(); if (r.error) throw r.error;
      base = (r.data && r.data.attributes) || {};
    } else if (ch && ch.base) base = ch.base;
    var out = Object.assign({}, base && typeof base === "object" && !Array.isArray(base) ? base : {});
    if (ch && ch.set) Object.keys(ch.set).forEach(function (k) { out[k] = ch.set[k]; });
    if (ch && Array.isArray(ch.unset)) ch.unset.forEach(function (k) { delete out[k]; });
    return out;
  };
  BPStore.studioSymbol = function () { var r = BPStore.studioTax(); return r.country === "IN" ? "\u20b9" : String(r.symbol || r.currency || "").trim(); };
  // Static labels ("Amount ₹", "Unit cost (₹)") follow the studio currency: text nodes only, never HTML.
  BPStore.localizeCurrency = function (root) {
    var sym = BPStore.studioSymbol(); if (!root || sym === "\u20b9" || !root.querySelectorAll) return;
    var els = root.querySelectorAll("label, th, .totbar, [data-cur]");
    for (var i = 0; i < els.length; i++) {
      var w = document.createTreeWalker(els[i], 4), t;
      // B14: "(\u20b9)" -> "(AED)" (no space inside the brackets); "\u20b9 500" -> "AED 500"
      while ((t = w.nextNode())) if (t.nodeValue.indexOf("\u20b9") >= 0) { var sy = String(sym).trim();
        t.nodeValue = t.nodeValue.split("(\u20b9)").join("(" + sy + ")").split("\u20b9").join(sy + (sy.length > 1 ? " " : "")); }
    }
  };
  if (typeof document !== "undefined") {
    var __lc = function () { try { BPStore.localizeCurrency(document); } catch (e) {} };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", __lc); else setTimeout(__lc, 0);
  }

  // ---- amount in words (Indian numbering: crore/lakh/thousand) — QA M-07 -----
  // Used on quotes/invoices so a large manually-influenced total is unambiguous
  // ("₹5,36,000" → "Rupees Five Lakh Thirty Six Thousand only").
  BPStore.amountInWords = function (amount) {
    var cents = Math.round(Math.abs(Number(amount) || 0) * 100);   // #13: keep paise
    var num = Math.floor(cents / 100), paise = cents % 100;
    if (num === 0 && paise === 0) return "Rupees Zero only";
    var a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
      "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    var b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
    function two(n) { return n < 20 ? a[n] : (b[Math.floor(n / 10)] + (n % 10 ? " " + a[n % 10] : "")); }
    function three(n) { return (n >= 100 ? a[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " : "") : "") + (n % 100 ? two(n % 100) : ""); }
    // Indian grouping; a crore count of 1000+ is itself spelled in Indian words ("One Thousand Crore")
    function indian(n) {
      var o = "", cr = Math.floor(n / 10000000); n %= 10000000;
      var lk = Math.floor(n / 100000); n %= 100000;
      var th = Math.floor(n / 1000); n %= 1000;
      if (cr) o += indian(cr) + " Crore ";
      if (lk) o += two(lk) + " Lakh ";
      if (th) o += two(th) + " Thousand ";
      if (n) o += three(n);
      return o.trim();
    }
    var out = indian(num);
    var p = paise ? two(paise) + " Paise" : "";
    if (!out.trim()) return p + " only";
    return "Rupees " + out.trim() + (p ? " and " + p : "") + " only";
  };

  // ---- global input[type=number] hardener -------------------------------
  if (typeof document === "undefined") return;
  // L2: a minus sign that the hardener drops must not vanish silently — say why, inline,
  // next to the field (text only; aria-live so screen readers hear it too).
  var NEG_HINT = "Negative numbers aren\u2019t allowed here";
  function negHint(el, text, ms) {
    try {
      // B29: a field with its own message under it (data-own-msg, e.g. Control Center > Default pricing) says it once
      if (el.hasAttribute && el.hasAttribute("data-own-msg")) return;
      var h = el.__negHint;
      if (!h || !h.isConnected) {
        __helmAdoptNegCss();
        h = document.createElement("span"); h.className = "neg-hint"; h.setAttribute("role", "status"); h.setAttribute("aria-live", "polite");
        el.insertAdjacentElement("afterend", h); el.__negHint = h;
      }
      h.textContent = text || NEG_HINT;
      h.hidden = false; clearTimeout(h.__t); h.__t = setTimeout(function () { h.hidden = true; }, ms || 3500);
    } catch (_) {}
  }
  var __negCss = false;
  function __helmAdoptNegCss() { if (__negCss) return; __negCss = true;
    try { __helmAdoptCss(document, ".neg-hint{display:block;font-size:12px;color:var(--danger,#b42318);margin-top:2px}.neg-hint[hidden]{display:none}"); } catch (_) {} }
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
      if (e.key === "-" && !allowNeg) { e.preventDefault(); negHint(el); return; }
      if (e.key === "." && integer) { e.preventDefault(); return; }
    });
    var fix = function () {
      var v = String(el.value).trim();
      if (v === "") return;
      var n = Number(v);
      if (!isFinite(n)) { el.value = ""; el.dispatchEvent(new Event("change", { bubbles: true })); return; }
      if (!allowNeg && n < 0) { n = 0; negHint(el); }
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
      // PP1028 #6: a pasted/typed negative ("-500") must be REJECTED, not silently flipped to +500
      if (!allowNeg && /^\s*-/.test(v)) { el.value = ""; el.setAttribute("data-rejected", "negative"); negHint(el, "Negative numbers aren\u2019t allowed here \u2014 value cleared, enter a positive amount", 5000); el.dispatchEvent(new Event("change", { bubbles: true })); return; }
      if (!allowNeg && v.indexOf("-") !== -1) negHint(el);
      if (v.trim() !== "") el.removeAttribute("data-rejected");
      var cleaned = v.replace(allowNeg ? /[^\d.\-]/g : /[^\d.]/g, "");
      // whole-number field: a pasted "2.5" keeps the whole part (2) - stripping only the dot made it 25
      if (integer) { var ip = cleaned.indexOf("."); if (ip !== -1) cleaned = cleaned.slice(0, ip); }
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
    }).then(function (p) { if (!p) return; var c = p.country || "IN"; _defaultCC = c; try { localStorage.setItem("helm_org_country", c); } catch (e) {}
      try { if (window.HelmPhone && window.HelmPhone.setDefaultCountry) window.HelmPhone.setDefaultCountry(c); } catch (e) {} }).catch(function () {}); } catch (e) {}
  }
  function dialOf(iso) { for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][1] === iso) return COUNTRIES[i][2]; return "91"; }
  BPStore.countries = function () { return COUNTRIES.map(function (c) { return { name: c[0], iso: c[1], dial: c[2] }; }); };
  function matchDial(e164) { if (!e164 || e164.charAt(0) !== "+") return null; var d = e164.slice(1); for (var i = 0; i < DIALS.length; i++) if (d.indexOf(DIALS[i]) === 0) return DIALS[i]; return null; }

  // Every phone field becomes the HelmPhone component (phone-input.js: flag + searchable
  // country list + as-you-type format; .value stays E.164). Pages that don't include the
  // script get it loaded on demand; if it can't load, the legacy hardener below is used.
  var PHONE_LIB_V = "7", phoneLib = null;
  function loadPhoneLib() {
    if (window.HelmPhone && window.HelmPhone.attach) return Promise.resolve(true);
    if (phoneLib) return phoneLib;
    phoneLib = new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = "/phone-input.js?v=" + PHONE_LIB_V;
      s.onload = function () { resolve(!!(window.HelmPhone && window.HelmPhone.attach)); };
      s.onerror = function () { resolve(false); };
      (document.head || document.documentElement).appendChild(s);
    });
    return phoneLib;
  }
  function hardenPhone(el) {
    if (el.getAttribute("data-phone-hardened") === "1" || el.helmPhone || el.getAttribute("data-phone-pending") === "1") return;
    if (el.classList && (el.classList.contains("hp-search") || el.type === "search")) return;
    if (window.HelmPhone && window.HelmPhone.attach && el.parentNode) { try { window.HelmPhone.attach(el); return; } catch (e) {} }
    el.setAttribute("data-phone-pending", "1");
    loadPhoneLib().then(function (ok) {
      el.removeAttribute("data-phone-pending");
      if (el.helmPhone) return;
      if (ok && el.parentNode) { try { window.HelmPhone.attach(el); return; } catch (e) {} }
      legacyHardenPhone(el);
    });
  }
  function legacyHardenPhone(el) {
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
  function isoDay(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  // B18: "today" for a date window is the STUDIO's day (BPStore.todayLocal = studio timezone), not the device's
  function todayIso() { try { var t = BPStore.todayLocal(); if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t; } catch (e) {} return isoDay(new Date()); }
  function addYears(n) { var t = todayIso().split("-"), md = t[1] + "-" + t[2]; if (md === "02-29") md = "02-28"; return (+t[0] + n) + "-" + md; }
  function prettyDay(v) { try { if (BPStore.fmtStudioDate) { var o = BPStore.fmtStudioDate(String(v), { style: "long" }); if (o) return o; } } catch (e) {}
    try { var p = String(v).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return v; } }
  function hardenDate(el) {
    if (el.getAttribute("data-date-hardened") === "1") return;
    el.setAttribute("data-date-hardened", "1");
    // Windows (a field can still set its own min=/max=):
    //   data-min-today            event / booking dates: today .. today + 5 years
    //   data-date-window="recent" meetings, follow-ups:   today - 2 years .. today + 1 year
    //   (none)                    other dates (birthdays, invoices, history): 2000 .. 2100
    var win = el.getAttribute("data-date-window") || (el.hasAttribute("data-min-today") ? "future" : "");
    if (!el.getAttribute("min")) el.setAttribute("min", win === "future" ? todayIso() : win === "recent" ? addYears(-2) : DATE_MIN);
    if (!el.getAttribute("max")) el.setAttribute("max", win === "future" ? addYears(5) : win === "recent" ? addYears(1) : DATE_MAX);
    var lo = el.getAttribute("min"), hi = el.getAttribute("max");
    // A value that was already saved (editing an old event) is kept even if it is now in the past;
    // only a value the user types or picks must fall inside the window.
    var original = null; var seen = false;
    var snapshot = function () { if (!seen) { seen = true; original = el.value || null; } };
    el.addEventListener("focus", snapshot); el.addEventListener("pointerdown", snapshot);
    var bad = function (v) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;
      if (original && v === original) return false;
      return v < lo || v > hi;
    };
    var msg = function () { return "Pick a date between " + prettyDay(lo) + " and " + prettyDay(hi); };
    var fix = function (ev) {
      var typingNow = ev && ev.type === "change" && document.activeElement === el;
      // half-typed year (e.g. 0026): the browser reports value "" + badInput while the box still shows text
      if (!el.value && el.validity && el.validity.badInput) {
        if (typingNow) return;
        el.value = ""; negHint(el, msg(), 5000); return;
      }
      var v = el.value; if (!v) return;
      if (!bad(v)) { try { el.removeAttribute("data-date-rejected"); } catch (e) {} return; }
      if (typingNow && el.validity && el.validity.badInput) return;
      // remember what was rejected so a form's Save can refuse instead of silently saving no date
      try { el.setAttribute("data-date-rejected", v < lo ? "past" : "range"); } catch (e) {}
      el.value = ""; negHint(el, msg(), 5000);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    el.addEventListener("blur", fix); el.addEventListener("change", fix);
  }

  function scan(root) {
    var r = root || document;
    try { r.querySelectorAll('input[type="number"]:not([data-hardened])').forEach(harden); } catch (e) {}
    try { r.querySelectorAll('input[type="tel"]:not([data-phone-hardened]), input[inputmode="tel"]:not([data-phone-hardened]), input[data-phone]:not([data-phone-hardened])').forEach(function (x) { if (isPhone(x)) hardenPhone(x); }); } catch (e) {}
    try { r.querySelectorAll('input[type="date"]:not([data-date-hardened])').forEach(hardenDate); } catch (e) {}
    try { r.querySelectorAll('[required]:not([data-req-marked]), [aria-required="true"]:not([data-req-marked]), [data-required]:not([data-req-marked])').forEach(markRequired); } catch (e) {}
  }
  function boot() {
    try {
      __helmAdoptCss(document, ".req-star{color:var(--danger,#c0392b);font-weight:700}"
        + ".bpui-tel{display:flex;align-items:stretch;gap:0;width:100%}"
        + ".bpui-tel>.bpui-tel-cc{flex:0 0 auto;max-width:40%;border:1px solid var(--line,#d9d4cc);border-right:0;border-radius:9px 0 0 9px;background:var(--panel-2,#f4f1ea);color:var(--ink,#1b1930);font:inherit;padding:0 6px}"
        + ".bpui-tel>input{flex:1 1 auto;min-width:0;border-radius:0 9px 9px 0!important}");
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

/* CSP: style-src-elem carries no 'unsafe-inline', so runtime CSS goes through a
   constructable stylesheet (CSSOM — not an inline <style>, not governed by CSP).
   Falls back to a <style> element only on browsers without adoptedStyleSheets. */
function __helmAdoptCss(doc, css) {
  try {
    var W = doc.defaultView || window;
    if (W.CSSStyleSheet && "adoptedStyleSheets" in doc && "replaceSync" in W.CSSStyleSheet.prototype) {
      var sh = new W.CSSStyleSheet(); sh.replaceSync(css);
      doc.adoptedStyleSheets = Array.prototype.slice.call(doc.adoptedStyleSheets).concat([sh]);
      return true;
    }
  } catch (e) {}
  var st = doc.createElement("style"); st.textContent = css;
  (doc.head || doc.documentElement).appendChild(st);
  return true;
}
