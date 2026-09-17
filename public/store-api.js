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
      const { data, error } = await supa.from("quotes")
        .select("id,code,title,event_type,status,approval_status,approval_token,current_version,client,pricing,updated_at,created_at,confirmed_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data.map((q) => ({ id: q.id, code: q.code, title: q.title, eventType: q.event_type, status: q.status,
        approvalStatus: q.approval_status || "none", approvalToken: q.approval_token,
        currentVersion: q.current_version, client: q.client || {}, pricing: q.pricing || {}, total: (q.pricing && q.pricing.total) || 0,
        updatedAt: q.updated_at, createdAt: q.created_at, confirmedAt: q.confirmed_at }));
    },
    async get(id) {
      const { data: q, error } = await supa.from("quotes").select("*").eq("id", id).single(); if (error) throw error;
      const { data: vs, error: e2 } = await supa.from("quote_versions")
        .select("id,version_no,label,object_count,created_at").eq("quote_id", id).order("version_no", { ascending: false });
      if (e2) throw e2;
      return { id: q.id, code: q.code, title: q.title, eventType: q.event_type, status: q.status, client: q.client || {},
        pricing: q.pricing || {}, currentVersion: q.current_version, createdAt: q.created_at, updatedAt: q.updated_at,
        confirmedAt: q.confirmed_at, versions: vs.map((v) => ({ id: v.id, versionNo: v.version_no, label: v.label,
          objectCount: v.object_count, createdAt: v.created_at })) };
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
      currentVersion: q.currentVersion, client: q.client || {}, pricing: q.pricing || {}, total: (q.pricing && q.pricing.total) || 0,
      updatedAt: q.updatedAt, createdAt: q.createdAt, confirmedAt: q.confirmedAt })); },
    async get(id) { const q = this.read().find((x) => x.id === id); if (!q) throw new Error("not found");
      return { ...q, versions: (q.versions || []).map((v) => ({ id: v.id, versionNo: v.versionNo, label: v.label, objectCount: v.objectCount, createdAt: v.createdAt })).sort((a, b) => b.versionNo - a.versionNo) }; },
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

  const BPStore = {
    init, mode: () => mode, auth, quotes, approval, ops, config, vendors, coupons,
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
