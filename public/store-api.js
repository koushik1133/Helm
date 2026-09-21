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

(function (global) {
  const CFG = global.SUPABASE_CONFIG || {};
  const TABLE = CFG.table || "layouts";
  const LS_KEY = "bps.layouts";
  const API = "/api";

  let mode = "local";           // resolved backend: 'supabase' | 'server' | 'local'
  let supa = null;              // Supabase client (lazy)
  let ready = null;             // init() promise
  let currentUser = null;       // signed-in Supabase user (or null)
  let roleCache = null;         // this user's RBAC role
  let accessCache = null;       // { role, map:{area:{view,edit}} | null } — the live access matrix for this user
  let authRequired = false;     // true when Supabase enforces login (RLS) and nobody is signed in
  // capability matrix per role (10 roles)
  const ROLE_CAPS = {
    admin:       ["view", "create", "edit", "delete", "manage"],
    manager:     ["view", "create", "edit", "delete", "manage"],
    planner:     ["view", "create", "edit", "delete"],
    sales:       ["view", "create", "edit"],
    coordinator: ["view", "create", "edit"],
    supervisor:  ["view", "edit"],
    quality:     ["view", "edit"],
    operations:  ["view", "edit"],
    crew:        ["view"],
    worker:      ["view"],
    client:      ["view"],
  };
  const EDIT_ROLES = ["admin", "manager", "planner", "sales", "coordinator", "supervisor", "quality", "operations"];
  const ALL_ROLES  = ["admin", "manager", "planner", "sales", "coordinator", "supervisor", "quality", "operations", "crew", "worker", "client"];
  // friendly labels for the UI (keys stay stable in the DB)
  const ROLE_LABELS = {
    admin: "Admin", manager: "Event manager", planner: "Planner", sales: "Sales",
    coordinator: "Event coordinator", supervisor: "Supervisor", quality: "Quality engineer",
    operations: "Operations", crew: "Crew", worker: "Worker", client: "Client",
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
    workspace: ["quotes", "layouts"],
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
  function loadSupabaseLib() {
    return new Promise((resolve) => {
      if (global.supabase && global.supabase.createClient) return resolve(true);
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
      s.onload = () => resolve(true); s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  const sb = {
    map: (r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, data: r.data }),
    async list() { const { data, error } = await supa.from(TABLE).select("id,name,created_at,updated_at,data").order("updated_at", { ascending: false });
      if (error) throw error; return data.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, objectCount: objectCount({ data: r.data }) })); },
    async get(id) { const { data, error } = await supa.from(TABLE).select("*").eq("id", id).single(); if (error) throw error; return this.map(data); },
    async create(name, data) { const { data: r, error } = await supa.from(TABLE).insert({ name, data }).select().single(); if (error) throw error; return this.map(r); },
    async update(id, patch) { const upd = { updated_at: now() }; if (patch.name != null) upd.name = patch.name; if (patch.data) upd.data = patch.data;
      const { data: r, error } = await supa.from(TABLE).update(upd).eq("id", id).select().single(); if (error) throw error; return this.map(r); },
    async remove(id) { const { error } = await supa.from(TABLE).delete().eq("id", id); if (error) throw error; return true; },
  };

  /* ---------------- init: pick the best available backend ---------------- */
  async function init() {
    if (ready) return ready;
    ready = (async () => {
      if (supaConfigured()) {
        try { const ok = await loadSupabaseLib();
          if (ok && global.supabase && global.supabase.createClient) {
            supa = global.supabase.createClient(CFG.url, CFG.anonKey,
              { auth: { persistSession: true, autoRefreshToken: true } });
            const { data: { session } } = await supa.auth.getSession();
            currentUser = session ? session.user : null;
            // Supabase is configured ⇒ the app uses accounts; no session ⇒ must sign in.
            authRequired = !currentUser;
            mode = "supabase"; return mode;
          }
        } catch (e) { console.warn("[BPStore] Supabase init error, falling back:", e && e.message); }
      }
      try { await api("GET", "/health"); mode = "server"; return mode; } catch (e) { /* fall through */ }
      mode = "local"; return mode;
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
  async function getRole() {
    if (!supa || !currentUser) return null;
    if (roleCache) return roleCache;
    try {
      const { data, error } = await supa.from("profiles").select("role").eq("id", currentUser.id).single();
      if (error) throw error;
      roleCache = (data && data.role) || "client";       // cache only a successful lookup
      return roleCache;
    } catch {
      return "client";                                    // transient failure → don't cache, retry next call
    }
  }
  // Load this user's access matrix (rows for their role). RLS returns only their
  // own role's rows. If the table is absent (phase29 not run) map stays null and
  // callers fall back to the legacy VIEW_SCOPE. Cached until sign-in/out/role change.
  async function loadAccess() {
    if (accessCache) return accessCache;
    const r = await getRole();
    try {
      const { data, error } = await supa.from("role_access").select("area,can_view,can_edit").eq("role", r);
      if (error) throw error;
      const map = {};
      (data || []).forEach((row) => { map[row.area] = { view: !!row.can_view, edit: !!row.can_edit }; });
      accessCache = { role: r, map };
    } catch {
      accessCache = { role: r, map: null };               // legacy fallback
    }
    return accessCache;
  }
  const auth = {
    enabled: () => mode === "supabase",
    required: () => authRequired,
    user: () => currentUser,
    role: getRole,
    // In non-Supabase (server/local) mode there is no auth ⇒ single-user, full access.
    async can(cap) { if (mode !== "supabase") return true; if (!currentUser) return false; const r = await getRole(); return (ROLE_CAPS[r] || ["view"]).includes(cap); },
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
      const fine = COARSE_TO_FINE[area];
      if (acc.map) {
        if (fine) return fine.some((k) => acc.map[k] && acc.map[k].edit);
        return !!(acc.map[area] && acc.map[area].edit);
      }
      return EDIT_ROLES.includes(r);
    },
    areas: () => AREAS.slice(),
    // Whole-page guard: if the signed-in role can't view `area`, hide #app and show a
    // "no access" panel, returning false. Call it right after the login check on a page.
    async requireView(area) {
      if (await this.canView(area)) return true;
      try {
        document.querySelectorAll("#app").forEach((e) => { e.hidden = true; });
        ["gate", "notfound"].forEach((idv) => { const g = document.getElementById(idv); if (g) g.hidden = true; });
        if (!document.getElementById("__noaccess")) {
          const box = document.createElement("div");
          box.id = "__noaccess";
          box.style.cssText = "max-width:520px;margin:64px auto;padding:28px;border-radius:14px;background:#fff;border:1px solid #d7deea;box-shadow:0 10px 30px rgba(20,27,46,.1);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;color:#4a5673";
          box.innerHTML = '<div style="font-size:34px">🔒</div><h2 style="color:#141b2e;margin:10px 0 6px">No access</h2><p style="margin:0 0 14px">Your role doesn’t have access to this page. Ask an admin if you need it.</p><a href="index.html" style="color:#2f6fed;font-weight:600">← Back to dashboard</a>';
          document.body.appendChild(box);
        }
      } catch (e) { /* non-browser context */ }
      return false;
    },
    async signIn(email, password) {
      if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
      currentUser = data.user; roleCache = null; accessCache = null; authRequired = false;
      return currentUser;
    },
    // Phase 58 — self-serve sign-up (studio created via create_studio once a session exists)
    async signUp(email, password) {
      if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) { currentUser = data.user; roleCache = null; accessCache = null; authRequired = false; }
      return { user: data.user, session: data.session };   // session null when email confirmation is required
    },
    // Google OAuth sign-in (requires the Google provider enabled in Supabase).
    // Redirects the browser to Google; on return, login.html resumes (and, for a
    // pending studio signup, calls create_studio). redirectTo must be an allowed
    // Redirect URL in Supabase → Authentication → URL Configuration.
    async signInWithGoogle(redirectTo) {
      if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirectTo || (location.origin + "/login.html"),
          queryParams: { access_type: "offline", prompt: "select_account" },
        },
      });
      if (error) throw error;
      return data; // browser navigates away to Google
    },
    async signOut() { if (supa) await supa.auth.signOut(); currentUser = null; roleCache = null; accessCache = null;
      if (mode === "supabase") authRequired = true; },
    onChange(cb) { if (supa) supa.auth.onAuthStateChange((_e, session) => {
      currentUser = session ? session.user : null; roleCache = null; accessCache = null;
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
          .select("id,email,role,created_at").order("role", { ascending: true });
        if (error) throw error; return data;
      },
      async createUser(email, password, role) {
        if (!supa) throw new Error("Supabase not configured");
        const { data, error } = await supa.rpc("admin_create_user",
          { p_email: email, p_password: password, p_role: role });
        if (error) throw error; return data;   // new user id
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

  /* ---------------- quotes + versions ---------------- */
  // Supabase tier (RPC-backed; errors surface). Falls back to localStorage when not in supabase mode.
  const sbq = {
    async list() {
      // select * so a not-yet-migrated column (e.g. lifecycle_stage before its SQL runs) is simply absent, never a 400
      const { data, error } = await supa.from("quotes").select("*").order("updated_at", { ascending: false });
      if (error) throw error;
      return data.map((q) => ({ id: q.id, code: q.code, title: q.title, eventType: q.event_type, status: q.status,
        lifecycleStage: q.lifecycle_stage || "quote",
        approvalStatus: q.approval_status || "none", approvalToken: q.approval_token,
        currentVersion: q.current_version, client: q.client || {}, pricing: q.pricing || {}, total: (q.pricing && q.pricing.total) || 0,
        eventDate: q.event_date || null, eventTime: q.event_time || null,
        updatedAt: q.updated_at, createdAt: q.created_at, confirmedAt: q.confirmed_at }));
    },
    async get(id) {
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
    async updateMeta(quoteId, patch) {
      const upd = {}; if (patch.title != null) upd.title = patch.title; if (patch.eventType != null) upd.event_type = patch.eventType;
      if (patch.client) upd.client = patch.client; if (patch.pricing) upd.pricing = patch.pricing; if (patch.status) upd.status = patch.status;
      if (patch.eventDate !== undefined) upd.event_date = patch.eventDate || null;
      if (patch.eventTime !== undefined) upd.event_time = patch.eventTime || null;
      const { data, error } = await supa.from("quotes").update(upd).eq("id", quoteId).select().single(); if (error) throw error; return data;
    },
    async remove(quoteId) { const { error } = await supa.from("quotes").delete().eq("id", quoteId); if (error) throw error; return true; },
  };
  // localStorage fallback tier
  const LSQ = "bps.quotes";
  const lsq = {
    read() { try { return JSON.parse(localStorage.getItem(LSQ) || "[]"); } catch { return []; } },
    write(v) { try { localStorage.setItem(LSQ, JSON.stringify(v)); } catch {} },
    async list() { return this.read().map((q) => ({ id: q.id, code: q.code, title: q.title, eventType: q.eventType, status: q.status,
      lifecycleStage: q.lifecycleStage || "quote",
      currentVersion: q.currentVersion, client: q.client || {}, pricing: q.pricing || {}, total: (q.pricing && q.pricing.total) || 0,
      updatedAt: q.updatedAt, createdAt: q.createdAt, confirmedAt: q.confirmedAt })); },
    async get(id) { const q = this.read().find((x) => x.id === id); if (!q) throw new Error("not found");
      return { ...q, lifecycleStage: q.lifecycleStage || "quote", versions: (q.versions || []).map((v) => ({ id: v.id, versionNo: v.versionNo, label: v.label, objectCount: v.objectCount, createdAt: v.createdAt })).sort((a, b) => b.versionNo - a.versionNo) }; },
    async setStage(id, stage) { const a = this.read(); const q = a.find((x) => x.id === id); if (q) { q.lifecycleStage = stage; q.updatedAt = now(); this.write(a); } return { stage }; },
    async getVersion(id, no) { const q = this.read().find((x) => x.id === id); const v = q && (q.versions || []).find((v) => v.versionNo === no);
      if (!v) throw new Error("no version"); return { versionNo: no, data: v.data }; },
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
      q.updatedAt = now(); this.write(a); return q; },
    async remove(id) { this.write(this.read().filter((x) => x.id !== id)); return true; },
  };
  const qt = () => (mode === "supabase" ? sbq : lsq);
  const quotes = {
    list: () => qt().list(),
    get: (id) => qt().get(id),
    getVersion: (id, no) => qt().getVersion(id, no),
    create: (code, title, eventType, data, objectCount) => qt().create(code, title, eventType, data, objectCount),
    addVersion: (id, label, data, objectCount) => qt().addVersion(id, label, data, objectCount),
    confirm: (id, client, pricing) => qt().confirm(id, client, pricing),
    setStage: (id, stage) => qt().setStage(id, stage),
    updateMeta: (id, patch) => qt().updateMeta(id, patch),
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
    const { data, error } = await supa.rpc(fn, args); if (error) throw error; return data;
  };
  // Edge Function caller — used only when live channels are enabled in config.js
  const fnUrl = (name) => (CFG.url ? CFG.url.replace(/\/$/, "") + "/functions/v1/" + name : null);
  async function callFn(name, body) {
    const res = await fetch(fnUrl(name), { method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + CFG.anonKey, "apikey": CFG.anonKey },
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
    // ---- worker (no login; token-scoped) ----
    worker: {
      getTasks: (token) => rpc("worker_get_tasks", { p_token: token }),
      respond: (token, taskId, action) => rpc("worker_respond", { p_token: token, p_task_id: taskId, p_action: action }),
      // Phase 52 — crew equipment (kit out to them for this event) + check-in
      getEquipment: (token) => rpc("worker_get_equipment", { p_token: token }),
      checkinEquipment: (token, id, qtyIn) => rpc("worker_checkin_equipment", { p_token: token, p_id: id, p_qty_in: qtyIn }),
    },
  };

  /* ---------------- control center: pricing config, vendors, coupons ---------------- */
  const config = {
    getPricing: () => rpc("get_pricing_config"),
    setPricing: (p) => rpc("set_pricing_config", { p }),
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
      l.status = "quoted"; l.quote_id = q.id; l.updated_at = now(); writeLeadsLs(a); pushArchiveLs("converted", l); return q;
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
      if (mode === "supabase") {
        return rpc("set_proposal", { p_quote_id: quoteId, p_concept: p.concept || null, p_theme: p.theme || null,
          p_palette: p.palette || [], p_images: p.images || [], p_scope: p.scope || [] });
      }
      const a = readLs(PROP_LS).filter((x) => x.quote_id !== quoteId);
      const cur = readLs(PROP_LS).find((x) => x.quote_id === quoteId) || {};
      const row = { quote_id: quoteId, share_token: cur.share_token || null, published: cur.published || false, ...p, updated_at: now() };
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
    async addItem(it) {
      if (mode === "supabase") { const { data, error } = await supa.from("inventory_items").insert(it).select().single(); if (error) throw error; return data; }
      const a = readLs(INV_LS); const row = { id: uid(), active: true, total_qty: 0, ...it, created_at: now() }; a.push(row); localStorage.setItem(INV_LS, JSON.stringify(a)); return row;
    },
    async updateItem(id, patch) {
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
    // permanently change what you own (e.g. reduce by damaged/lost at teardown)
    async adjustTotal(itemId, delta) {
      // atomic in Supabase (avoids a lost update when two teardown returns run at once)
      if (mode === "supabase") return rpc("adjust_inventory_total", { p_item_id: itemId, p_delta: Number(delta || 0) });
      const items = await this.items(true); const it = items.find((i) => i.id === itemId); if (!it) return false;
      return this.updateItem(itemId, { total_qty: Math.max(0, Number(it.total_qty || 0) + Number(delta || 0)) });
    },
    // committed & available per item id, from all active reservations
    async availability() {
      const [items, res] = await Promise.all([this.items(false), this.reservations()]);
      const committed = {};
      (res || []).forEach((r) => { if (ACTIVE_RES.includes(r.status)) committed[r.item_id] = (committed[r.item_id] || 0) + Number(r.qty || 0); });
      const map = {};
      items.forEach((i) => { const c = committed[i.id] || 0; map[i.id] = { ...i, committed: c, available: Number(i.total_qty || 0) - c }; });
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
    async id() { if (!supa) return null; const { data } = await supa.rpc("current_org_id"); return data || null; },
    async current() { if (!supa) return null;
      const { data, error } = await supa.from("organizations").select("*").eq("id", (await this.id())).maybeSingle();
      if (error) throw error; return data; },
    async save(patch) { if (!supa) throw new Error("Supabase not configured");
      const { error } = await supa.from("organizations").update(patch).eq("id", (await this.id())); if (error) throw error; return true; },
    createStudio: (name, opts) => rpc("create_studio", { p_name: name, p_email: (opts && opts.email) || null,
      p_currency: (opts && opts.currency) || "INR", p_timezone: (opts && opts.timezone) || "Asia/Kolkata" }),
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
      const [events, invRes, vendorBk, items, team, vends, tasks] = await Promise.all([
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
      ]);
      const evById = {}; events.forEach((e) => { evById[e.id] = e; });
      const itemById = {}; items.forEach((i) => { itemById[i.id] = i; });
      const staffById = {}; team.forEach((p) => { staffById[p.id] = p; });
      const vendById = {}; vends.forEach((v) => { vendById[v.id] = v; });
      const dateOf = (qid) => { const e = evById[qid]; return e ? e.eventDate : null; };

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
      const row = { quote_id: quoteId, menu_locked: cur.menu_locked || false, ...p, updated_at: now() };
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
      let added = 0;
      for (const it of items) { const title = typeof it === "string" ? it : (it && it.title); if (!title) continue;
        await checklist.add(quoteId, { section: t.section, title }); added++; }
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
    async setStatus(id, status) { return this.update(id, { status, paid_at: status === "paid" ? now() : null }); },
    async remove(id) {
      if (mode === "supabase") { const { error } = await supa.from("payment_milestones").delete().eq("id", id); if (error) throw error; return true; }
      localStorage.setItem(MILE_LS, JSON.stringify(readLs(MILE_LS).filter((m) => m.id !== id))); return true;
    },
    // reminder via the existing notification outbox (simulated unless channels are live)
    sendReminder: (quoteId, to, detail) => (mode === "supabase"
      ? rpc("mgr_notify", { p_quote_id: quoteId, p_channel: "sms", p_to: to, p_kind: "payment_reminder", p_detail: detail || {} })
      : Promise.resolve({ sent: true, simulated: true })),
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
      const [b, ms, bk, exp] = await Promise.all([
        budget.summary(quoteId), milestones.list(quoteId), bookings.list(quoteId), expenses.list(quoteId),
      ]);
      const received = ms.filter((m) => m.status === "paid").reduce((a, m) => a + Number(m.amount || 0), 0);
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

  /* ---------------- notification center: in-app bell (Phase 48) ---------------- */
  const bell = {
    feed: (limit) => rpc("bell_feed", limit ? { p_limit: limit } : {}),
    markSeen: () => rpc("bell_mark_seen", {}),
    // friendly label + icon for a raw notification kind
    label(n) {
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
      };
      const hit = m[k];
      if (hit) return { icon: hit[0], text: hit[1] };
      return { icon: "🔔", text: (n.kind || "Update").replace(/_/g, " ") };
    },
    // Mount a self-contained bell widget into `el` (works on any page, inline-styled).
    async mount(el) {
      if (!el) return;
      if (!(auth.enabled() && auth.user())) { el.innerHTML = ""; return; }
      const S = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(";");
      el.style.position = "relative";
      el.innerHTML = `<button id="bpBellBtn" title="Notifications" style="${S({position:'relative',height:'30px',width:'34px','border':'1px solid var(--line,#e8e3db)',background:'var(--panel,#fff)','border-radius':'8px',cursor:'pointer','font-size':'15px'})}">🔔<span id="bpBellDot" hidden style="${S({position:'absolute',top:'-6px',right:'-6px',background:'#e5484d',color:'#fff','font-size':'10px','font-weight':'700','min-width':'16px',height:'16px','line-height':'16px','border-radius':'9px',padding:'0 4px'})}">0</span></button>
        <div id="bpBellPanel" hidden style="${S({position:'absolute',right:'0',top:'38px',width:'340px','max-width':'86vw',background:'var(--panel,#fff)',border:'1px solid var(--line,#e8e3db)','border-radius':'12px','box-shadow':'0 10px 30px rgba(20,27,46,.18)','z-index':'90',overflow:'hidden'})}">
          <div style="${S({padding:'10px 14px','border-bottom':'1px solid var(--line,#eee)','font-weight':'700','font-size':'13px',display:'flex','align-items':'center','justify-content':'space-between'})}">Notifications <span id="bpBellClear" style="${S({'font-size':'11px',color:'var(--accent,#6d28d9)',cursor:'pointer','font-weight':'600'})}">Mark all read</span></div>
          <div id="bpBellList" style="${S({'max-height':'380px','overflow':'auto'})}"><div style="padding:18px;text-align:center;color:#8b8698;font-size:13px">Loading…</div></div>
        </div>`;
      const btn = el.querySelector("#bpBellBtn"), dot = el.querySelector("#bpBellDot"),
            panel = el.querySelector("#bpBellPanel"), list = el.querySelector("#bpBellList");
      const rel = (iso) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; };
      const esc = (t) => (t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const renderList = (items) => {
        if (!items || !items.length) { list.innerHTML = `<div style="padding:22px;text-align:center;color:#8b8698;font-size:13px">Nothing yet.</div>`; return; }
        list.innerHTML = items.map((n) => { const L = this.label(n); const href = n.quote_id ? ("event.html?id=" + encodeURIComponent(n.quote_id)) : null;
          return `<a ${href ? `href="${href}"` : ""} style="${S({display:'flex',gap:'10px',padding:'10px 14px','border-bottom':'1px solid var(--line-2,#f1ede7)','text-decoration':'none',color:'inherit',background:n.unread?'#f6f2ff':'transparent'})}">
            <span style="font-size:16px">${L.icon}</span>
            <span style="flex:1;min-width:0"><span style="font-size:13px;font-weight:${n.unread?'700':'500'}">${esc(L.text)}</span>
              <span style="display:block;font-size:11px;color:#8b8698">${n.event_code ? esc(n.event_code) + " · " : ""}${rel(n.created_at)}</span></span></a>`;
        }).join("");
      };
      const refresh = async () => { try { const f = await this.feed(20);
        if (f.unread > 0) { dot.hidden = false; dot.textContent = f.unread > 99 ? "99+" : f.unread; } else dot.hidden = true;
        return f; } catch { return null; } };
      let f0 = await refresh();
      btn.addEventListener("click", async (e) => { e.stopPropagation(); const open = panel.hidden;
        if (open) { panel.hidden = false; let f = null; try { f = await this.feed(20); } catch {} renderList((f && f.items) || []);
          try { await this.markSeen(); } catch {} dot.hidden = true; } else panel.hidden = true; });
      el.querySelector("#bpBellClear").addEventListener("click", async (e) => { e.stopPropagation(); try { await this.markSeen(); } catch {} dot.hidden = true;
        let f = null; try { f = await this.feed(20); } catch {} renderList((f && f.items) || []); });
      document.addEventListener("click", (e) => { if (!el.contains(e.target)) panel.hidden = true; });
      setInterval(() => { if (!document.hidden && panel.hidden) refresh(); }, 30000);
    },
  };

  /* ---------------- client portal (Phase 53) ---------------- */
  const portal = { get: (token) => rpc("public_get_portal", { p_token: token }) };

  /* ---------------- post-event insights (Phase 51) ---------------- */
  const insights = {
    async summary() {
      const empty = { vendors: [], taskSlips: [], losses: { total: 0, byItem: [], byMonth: [] }, margins: { events: [], totalProfit: 0, avgMargin: null } };
      if (mode !== "supabase" || !supa) return empty;
      const events = await quotes.list();
      const [tR, cR, iR] = await Promise.all([
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

  /* ---------------- audit log (Phase 47) ---------------- */
  const audit = {
    async list(opts) { opts = opts || {}; if (!supa) throw new Error("Supabase not configured");
      let q = supa.from("audit_log").select("*").order("at", { ascending: false }).limit(opts.limit || 150);
      if (opts.entity) q = q.eq("entity", opts.entity);
      if (opts.quoteId) q = q.eq("quote_id", opts.quoteId);
      if (opts.actor) q = q.eq("actor", opts.actor);
      const { data, error } = await q; if (error) throw error; return data; },
    async entities() { if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.from("audit_log").select("entity").order("entity"); if (error) throw error;
      return [...new Set((data || []).map((x) => x.entity))]; },
  };

  const BPStore = {
    init, mode: () => mode, auth, quotes, approval, ops, config, vendors, coupons, chairTypes, plateTypes, dishCatalog, eventMenu, menuTemplates, org, leads, discovery, proposal, staff, inventory, resources, bookings, calendar, runsheet, budget, plan, checklist, milestones, readiness, dayops, guests, stockreq, issues, expenses, refunds, media, templates, nurture, settlement, closure, bell, audit, insights, portal,
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
})(window);
