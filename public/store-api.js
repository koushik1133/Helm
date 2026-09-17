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
  let authRequired = false;     // true when Supabase enforces login (RLS) and nobody is signed in
  // capability matrix per role
  const ROLE_CAPS = {
    admin:      ["view", "create", "edit", "delete", "manage"],
    planner:    ["view", "create", "edit", "delete"],
    sales:      ["view", "create", "edit"],
    operations: ["view", "edit"],
    crew:       ["view"],
    client:     ["view"],
  };
  const EDIT_ROLES = ["admin", "planner", "sales", "operations"];

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
  const auth = {
    enabled: () => mode === "supabase",
    required: () => authRequired,
    user: () => currentUser,
    role: getRole,
    // In non-Supabase (server/local) mode there is no auth ⇒ single-user, full access.
    async can(cap) { if (mode !== "supabase") return true; if (!currentUser) return false; const r = await getRole(); return (ROLE_CAPS[r] || ["view"]).includes(cap); },
    canEdit: async () => { if (mode !== "supabase") return true; if (!currentUser) return false; const r = await getRole(); return EDIT_ROLES.includes(r); },
    async signIn(email, password) {
      if (!supa) throw new Error("Supabase not configured");
      const { data, error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
      currentUser = data.user; roleCache = null; authRequired = false;
      return currentUser;
    },
    async signOut() { if (supa) await supa.auth.signOut(); currentUser = null; roleCache = null;
      if (mode === "supabase") authRequired = true; },
    onChange(cb) { if (supa) supa.auth.onAuthStateChange((_e, session) => {
      currentUser = session ? session.user : null; roleCache = null;
      if (mode === "supabase") authRequired = !currentUser; if (cb) cb(currentUser); }); },
    // ---- admin user management (RPC guarded by is_admin() at the DB) ----
    admin: {
      roles: () => ["admin", "planner", "sales", "operations", "crew", "client"],
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
        eventDate: q.event_date || null,
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
        eventDate: q.event_date || null,
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
    async create(code, title, eventType, data, objectCount) {
      const { data: q, error } = await supa.rpc("create_quote",
        { p_code: code, p_title: title, p_event_type: eventType, p_data: data, p_object_count: objectCount });
      if (error) throw error; return Array.isArray(q) ? q[0] : q;
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
    reassign: (taskId, crewId, name, phone) => rpc("reassign_task",
      { p_task_id: taskId, p_crew_id: crewId || null, p_name: name, p_phone: phone }),
    async setEventManager(quoteId, managerId) { const { error } = await supa.from("quotes").update({ manager_id: managerId }).eq("id", quoteId); if (error) throw error; return true; },
    // ---- worker (no login; token-scoped) ----
    worker: {
      getTasks: (token) => rpc("worker_get_tasks", { p_token: token }),
      respond: (token, taskId, action) => rpc("worker_respond", { p_token: token, p_task_id: taskId, p_action: action }),
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
    subscribe(cb) {
      if (mode !== "supabase" || !supa) return { unsubscribe() {} };
      try {
        return supa.channel("leads-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, (payload) => cb && cb(payload))
          .subscribe();
      } catch { return { unsubscribe() {} }; }
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
    // distinct departments/skills across the team (for filters)
    async facets() {
      const list = await this.list(true);
      const depts = [...new Set(list.map((s) => s.department).filter(Boolean))].sort();
      const skills = [...new Set(list.flatMap((s) => Array.isArray(s.skills) ? s.skills : []))].sort();
      return { depts, skills };
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
    // committed & available per item id, from all active reservations
    async availability() {
      const [items, res] = await Promise.all([this.items(false), this.reservations()]);
      const committed = {};
      (res || []).forEach((r) => { if (ACTIVE_RES.includes(r.status)) committed[r.item_id] = (committed[r.item_id] || 0) + Number(r.qty || 0); });
      const map = {};
      items.forEach((i) => { const c = committed[i.id] || 0; map[i.id] = { ...i, committed: c, available: Number(i.total_qty || 0) - c }; });
      return map;
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
      if (b.need_id) { try { await resources.updateNeed(b.need_id, { status: "outsourced" }); } catch {} }
      return row;
    },
    async update(id, patch) {
      if (mode === "supabase") { const { error } = await supa.from("event_resources").update(patch).eq("id", id); if (error) throw error; return true; }
      const a = readLs(BOOK_LS); const r = a.find((x) => x.id === id); if (r) { Object.assign(r, patch); localStorage.setItem(BOOK_LS, JSON.stringify(a)); } return true;
    },
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

  const BPStore = {
    init, mode: () => mode, auth, quotes, approval, ops, config, vendors, coupons, leads, discovery, proposal, staff, inventory, resources, bookings, calendar, runsheet,
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
