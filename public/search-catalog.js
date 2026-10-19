/* search-catalog.js - the static "what can I search for" list shared by the global palette
 * (studio-search.js, Cmd/Ctrl+K) and the Control Center settings search (control-split.js).
 *   PAGES     every studio page, each with the same access gate its sidebar entry uses
 *   SECTIONS  every Control Center section (keys = control-split.js SECTIONS keys)
 *   SETTINGS  every card title, field, toggle and button in those sections
 *   ACCOUNT   the signed-in person's own account items (2FA, password, profile, devices)
 * Pure data + helpers, no DOM, no network. Works in the browser (window.HelmSearchCatalog)
 * and in Node tests (module.exports). Matching uses settings-search-core.js when present. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HelmSearchCatalog = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* gate: "always" | "admin" | "controls" (canView controls or admin) | {view:area} | {any:[...]} |
     {all:[...]} | {role:/re/} | {feature:"name"} - checked by canSee() against BPStore.auth */
  var CTL = "controls";
  var PAGES = [
    { key: "dashboard",  label: "Dashboard",        href: "dashboard.html",  gate: "always", kw: "home overview today start" },
    { key: "quotes",     label: "Quotes & events",  href: "quotes.html",     gate: { view: "quotes" }, kw: "events quote list workspace bookings estimates" },
    { key: "leads",      label: "Leads",            href: "leads.html",      gate: { view: "leads" }, kw: "pipeline enquiries enquiry prospects clients" },
    { key: "calendar",   label: "Calendar",         href: "calendar.html",   gate: { view: "calendar" }, kw: "schedule dates bookings availability" },
    { key: "chat",       label: "Team chat",        href: "chat.html",       gate: "always", kw: "messages chat team talk" },
    { key: "crm",        label: "CRM archive",      href: "crm.html",        gate: { view: "crm" }, kw: "archive old leads clients history" },
    { key: "nurture",    label: "Nurture",          href: "nurture.html",    gate: { view: "nurture" }, kw: "follow up campaigns drip" },
    { key: "staff",      label: "Staff & crew",     href: "staff.html",      gate: { view: "staff" }, kw: "staff crew workers people team employees" },
    { key: "inventory",  label: "Inventory",        href: "inventory.html",  gate: { view: "inventory" }, kw: "stock items equipment warehouse" },
    { key: "vendors",    label: "Vendors",          href: "vendors.html",    gate: { view: "vendors" }, kw: "partners suppliers" },
    { key: "templates",  label: "Templates",        href: "templates.html",  gate: { view: "templates" }, kw: "proposal templates layouts" },
    { key: "control",    label: "Control Center",   href: "control.html",    gate: CTL, kw: "control center settings preferences configuration admin", alias: ["control center", "control centre", "settings", "control"] },
    { key: "business",   label: "Business",         href: "business.html",   gate: { view: "business" }, kw: "money revenue collected outstanding payments finance" },
    { key: "insights",   label: "Insights",         href: "insights.html",   gate: { view: "insights" }, kw: "insights analytics numbers trends" },
    { key: "reports",    label: "Reports",          href: "reports.html",    gate: { any: [CTL, { role: /^(admin|manager|planner)$/ }] }, kw: "reports export summary analytics" },
    { key: "audit",      label: "Audit log",        href: "audit.html",      gate: CTL, kw: "audit history activity who changed log" },
    { key: "setup",      label: "Studio setup",     href: "onboarding.html", gate: CTL, kw: "onboarding wizard getting started setup import" },
    // hidden on live (config.js HELM_FEATURES.integrationsPage): never a dead link in search
    { key: "integrations", label: "Integrations (WhatsApp, e-mail, payments)", href: "integrations.html", gate: { all: [CTL, { feature: "integrationsPage" }] }, kw: "whatsapp email smtp webhook api connect payment gateway razorpay" },
    // r20 coord (e): hidden for now (config.js HELM_FEATURES.manual) - never a "coming soon" dead end in search
    { key: "manual",     label: "User manual",      href: "manual.html",     gate: { feature: "manual" }, kw: "help guide docs how to manual" }
  ];

  /* keys/hashes mirror control-split.js; gate = who sees that section's cards */
  var SECTIONS = [
    { key: "general",    label: "General",                     hash: "#general",          gate: CTL,     kw: "studio account organization business name logo accent colour currency timezone gst gstin tax address billing details country" },
    { key: "billing",    label: "Plan & billing",              hash: "#billing",          gate: "admin", kw: "subscription plan invoice trial upgrade" },
    { key: "privacy",    label: "Hide amounts (privacy PIN)",  hash: "#privacy-pin",      gate: "admin", kw: "privacy pin passcode hide amounts money mask unlock" },
    { key: "links",      label: "Client links & packages",     hash: "#client-links",     gate: "admin", kw: "expire expiry link security package flow booklet" },
    { key: "pricing",    label: "Pricing & coupons",           hash: "#pricing",          gate: CTL,     kw: "price tax gst vat discount rate card coupon capacity object service charge" },
    { key: "payments",   label: "Payment schedules",           hash: "#payment-schedules", gate: CTL,    kw: "payment schedule milestone installment advance balance upfront deposit due upi bank overdue plan template" },
    { key: "catalog",    label: "Menus & catalog",             hash: "#menu",             gate: CTL,     kw: "chair plate dish catering menu package standard gold premium" },
    { key: "rules",      label: "Layout rules",                hash: "#layout-rules",     gate: CTL,     kw: "seats guests buffet bar generator event type layout" },
    { key: "data",       label: "Import & custom fields",      hash: "#data",             gate: CTL,     kw: "excel import xlsx csv custom field" },
    { key: "users",      label: "Users & invites",             hash: "#users",            gate: "admin", kw: "team member invite role user details staff login add remove people accounts", alias: ["user details", "users", "user", "team", "staff login", "logins", "user management", "team members"] },
    { key: "access",     label: "Roles & access",              hash: "#access",           gate: "admin", kw: "access matrix permission role view edit rbac" },
    { key: "compliance", label: "Data & compliance",           hash: "#compliance",       gate: "admin", kw: "gdpr dpdp export archive download privacy" },
    { key: "notify",     label: "Notifications",               hash: "#notifications",    gate: "admin", kw: "bell notification sms email override mute alert" },
    { key: "reminders",  label: "Reminders & client messages", hash: "#reminders",        gate: "admin", kw: "event reminder payment reminder client followup whatsapp inventory stock automatic message" },
    { key: "renders",    label: "Photo renders",               hash: "#renders",          gate: "admin", kw: "render photo quota image" },
    { key: "venues",     label: "Venues",                      hash: "#venues",           gate: { all: [CTL, { any: ["admin", { view: "venues" }] }] }, kw: "venue hall space" },
    { key: "ltemplates", label: "Layout templates",            hash: "#layout-templates", gate: { all: [CTL, { any: ["admin", { view: "templates" }] }] }, kw: "template floor layout" }
  ];

  /* [section, text, extra keywords]. text = the card title / label exactly as on the page, so the
     Control Center deep link (control.html?cs=<text>) lands on that very field. */
  var SETTINGS = [
    ["general", "Studio account", "account owner"],
    ["general", "Organization / studio", "studio business"],
    ["general", "Country (sets tax & currency)", "country region tax currency"],
    ["general", "Studio / business name", "name studio"],
    ["general", "Business email", "email contact"],
    ["general", "Business phone", "phone mobile contact"],
    ["general", "Location (city, country)", "city address"],
    ["general", "Logo URL", "logo brand image"],
    ["general", "Accent colour", "colour color theme brand"],
    ["general", "Currency", "money inr aed"],
    ["general", "Timezone", "time zone"],
    ["general", "GSTIN (optional)", "gst tax number vat trn"],
    ["general", "Billing details", "invoice address legal"],
    ["general", "Legal / business name", "legal name"],
    ["general", "Billing address", "address"],
    ["general", "Address line 2", "address"],
    ["general", "City", "address town"],
    ["general", "State", "address region"],
    ["general", "PIN code", "postal zip pincode"],
    ["general", "Save studio settings", "save"],
    ["general", "Studio link", "slug url link name client link address helm.events"],
    ["billing", "Subscription", "plan billing invoice upgrade trial"],
    ["privacy", "Hide amounts — privacy PIN", "pin privacy hide"],
    ["privacy", "Current PIN", "pin"],
    ["privacy", "New PIN (4 digits)", "pin change"],
    ["privacy", "Forgot the PIN? Reset to 0000", "reset pin forgot"],
    ["privacy", "Save privacy PIN", "pin"],
    ["links", "Client links — auto-expire", "expire expiry security"],
    ["links", "Days after the link is sent (1–365)", "expiry days"],
    ["links", "Which links this covers", "expiry"],
    ["links", "Save link expiry", "expire"],
    ["links", "Client package flow", "package booklet flow"],
    ["pricing", "Default pricing (applies to every new quote)", "price default"],
    ["pricing", "Price / chair", "chair price"],
    ["pricing", "Price / plate", "plate price catering"],
    ["pricing", "Chair/rental GST %", "gst tax vat"],
    ["pricing", "Catering GST %", "gst tax vat"],
    ["pricing", "Tax name", "gst vat tax label"],
    ["pricing", "Service charge % (optional)", "service charge fee"],
    ["pricing", "Layout & setup fee", "fee setup"],
    ["pricing", "Venue booking gap (hours)", "gap buffer"],
    ["pricing", "Save pricing", "save"],
    ["pricing", "Target margin", "target margin profit insights benchmark green amber red"],
    ["pricing", "Target margin %", "target margin profit insights benchmark"],
    ["pricing", "Save target margin", "target margin save"],
    ["pricing", "Item pricing (rate cards)", "rate card item price"],
    ["pricing", "Capacity limits (layout builder)", "max limit capacity"],
    ["pricing", "Max guests", "capacity"],
    ["pricing", "Max chairs", "capacity chair"],
    ["pricing", "Max plates", "capacity plate"],
    ["pricing", "Max round tables", "capacity table"],
    ["pricing", "Max bars", "capacity bar"],
    ["pricing", "Max food trucks / stalls", "capacity stall"],
    ["pricing", "Max expo booths", "capacity booth"],
    ["pricing", "Max restrooms", "capacity toilet"],
    ["pricing", "Max exits", "capacity exit"],
    ["pricing", "Max hall length / breadth (ft)", "capacity size"],
    ["pricing", "Save capacity limits", "capacity"],
    ["pricing", "Object & item prices (layout builder)", "object price builder"],
    ["pricing", "Save item prices", "object price"],
    ["pricing", "Coupons", "coupon discount promo code"],
    ["pricing", "+ Add coupon", "coupon discount create"],
    ["catalog", "Chair types & prices", "chair"],
    ["catalog", "+ Add chair type", "chair"],
    ["catalog", "Plate types & prices (catering)", "plate catering"],
    ["catalog", "+ Add plate type", "plate"],
    ["catalog", "Dishes catalog (menu)", "dish food menu"],
    ["catalog", "+ Add dish", "dish food"],
    ["catalog", "Menu packages (Standard / Gold / Premium)", "menu package"],
    ["rules", "Default layout rules (per event type)", "layout rules generator"],
    ["data", "Import from Excel", "excel import xlsx csv"],
    ["data", "Import staff", "excel staff"],
    ["data", "Import dishes", "excel dish"],
    ["data", "Import inventory", "excel stock"],
    ["data", "Import vendors", "excel vendor"],
    ["data", "Custom fields", "custom field extra"],
    ["data", "+ Add field", "custom field"],
    ["users", "Team members", "users team staff login people accounts user details"],
    ["users", "Add user", "add user team member staff login create account"],
    ["users", "Invite by email link", "invite join teammate"],
    ["users", "Create invite link", "invite"],
    ["users", "Pending invites", "invite"],
    ["access", "Roles", "role admin manager planner sales staff"],
    ["access", "Access control — who can see & do what", "roles permissions matrix rbac"],
    ["compliance", "Data Portability & Compliance Archive", "export gdpr dpdp download"],
    ["venues", "Venues", "venue hall"],
    ["ltemplates", "Layout templates", "template floor"],
    ["notify", "Notifications — who hears about what", "bell alert"],
    ["notify", "Reset to defaults", "notifications reset"],
    ["notify", "Per-person overrides", "notifications override mute"],
    ["reminders", "Event reminders", "reminder event team"],
    ["reminders", "Automatic client messages & WhatsApp", "whatsapp automatic messages"],
    ["reminders", "Payment reminders", "payment reminder overdue"],
    ["payments", "Payment schedules", "payment schedule milestone installment advance balance 30 50 20 upfront"],
    ["payments", "Default schedule", "default payment schedule template"],
    ["payments", "Add the default schedule when a client approves a quote", "automatic apply approval"],
    ["payments", "Bell notice to the team when a client payment is overdue", "overdue alert bell"],
    ["payments", "UPI ID", "upi vpa pay"],
    ["payments", "Payment note (e.g. bank details)", "bank account ifsc pay note"],
    ["payments", "New schedule", "custom payment plan template"],
    ["payments", "Save payment settings", "save payment schedule"],
    ["reminders", "Days before the due date", "payment reminder"],
    ["reminders", "Then every N days overdue", "payment reminder overdue"],
    ["reminders", "Max overdue reminders", "payment reminder"],
    ["reminders", "Client follow-ups", "followup client"],
    ["reminders", "Days after opening", "followup"],
    ["reminders", "Max follow-ups", "followup"],
    ["reminders", "Inventory", "stock low warning"],
    ["reminders", "WhatsApp forwarding", "whatsapp forward"],
    ["reminders", "Studio WhatsApp number", "whatsapp phone"],
    ["reminders", "Save automatic messages", "save"],
    ["renders", "Photo renders", "render photo"],
    ["renders", "Photos per month", "render quota"],
    ["renders", "Render requests per hour", "render limit"],
    ["renders", "Save photo render settings", "render"]
  ];

  /* the person's own account (auth-ui.js HelmAuthUI.openAccount) - every signed-in member */
  var ACCOUNT = [
    { id: "mfa",      text: "Two-step sign-in (2FA)", kw: "twostep 2fa mfa otp authenticator verification code security turn on off enable disable", open: { section: "settings", focus: "mfa" } },
    { id: "password", text: "Change password",        kw: "password signin security reset", open: { section: "settings", focus: "password" } },
    { id: "profile",  text: "Your profile (name, mobile, photo)", kw: "profile name phone mobile avatar photo my details", open: { section: "profile" } },
    { id: "devices",  text: "Sign out other devices", kw: "devices sessions security signout logout", open: { section: "settings", focus: "devices" } },
    // QA1026 #4: the rail's colour theme picker (shell-b.js), per device - not a Control Center field
    { id: "theme",    text: "Colour theme",           kw: "theme colour color accent appearance look emerald cobalt midnight graphite studio", open: { theme: true } }
  ];

  /* run an ACCOUNT item: the theme picker opens the rail swatch; everything else is HelmAuthUI.openAccount */
  function openAccountItem(open, win) {
    win = win || (typeof window !== "undefined" ? window : null); if (!win) return false;
    if (open && open.theme) {
      var d = win.document, b = d && (d.getElementById("hbThemePick") || d.querySelector(".hb-swbtn"));
      if (b) { setTimeout(function () { try { b.click(); } catch (e) {} }, 0); return true; }
      return false;
    }
    try { if (win.HelmAuthUI && win.HelmAuthUI.openAccount) { win.HelmAuthUI.openAccount(open || {}); return true; } } catch (e) {}
    return false;
  }

  var SECBY = {}; SECTIONS.forEach(function (s) { SECBY[s.key] = s; });

  /* QA B5: what a studio on its FREE TRIAL never gets, so search never lists it (the pages / sections are locked
     there anyway: trial-lock.js covers the pages, control-split.js locks the sections).
     TRIAL_OFF_SECTIONS = control-split.js TRIAL_OFF (keep the two lists the same);
     TRIAL_OFF_PAGES = studio set-up (onboarding, import), checklist templates, the activity log, Reports & exports. */
  var TRIAL_OFF_SECTIONS = { general: 1, links: 1, data: 1, compliance: 1, notify: 1, reminders: 1, renders: 1, privacy: 1, ltemplates: 1 };
  var TRIAL_OFF_PAGES = { setup: 1, templates: 1, audit: 1, reports: 1 };
  var TRIAL_OFF_HREF = /(^|\/)(onboarding|templates|audit|reports)(\.html)?([?#\/]|$)/;
  function trialOff(e) {
    if (!e || typeof e !== "object") return false;
    if (e.kind === "page" && TRIAL_OFF_PAGES[e.key]) return true;
    if ((e.kind === "section" || e.kind === "setting") && TRIAL_OFF_SECTIONS[e.sec]) return true;
    return typeof e.href === "string" && TRIAL_OFF_HREF.test(e.href);
  }
  /* is the page showing a free-trial studio? (html.helm-trial is set by trial-lock.js once the server says "trial") */
  function trialNow() {
    try { return typeof document !== "undefined" && !!document.documentElement && document.documentElement.classList.contains("helm-trial"); } catch (e) { return false; }
  }
  /* the list without the trial-off entries when trial is true (trial undefined -> asks the page) */
  function forTrial(list, trial) {
    if (trial === undefined) trial = trialNow();
    return trial ? (list || []).filter(function (e) { return !trialOff(e); }) : (list || []);
  }

  function settingHref(sec, text) {
    var s = SECBY[sec]; if (!s) return "control.html";
    return "control.html" + (text ? "?cs=" + encodeURIComponent(String(text).slice(0, 80)) : "") + s.hash;
  }

  /* async gate check against BPStore.auth-like {role(), canView(area)}; features = window.HELM_FEATURES */
  function canSee(gate, auth, features, cache) {
    cache = cache || {};
    function view(a) {
      if (!auth || typeof auth.canView !== "function") return Promise.resolve(false);
      if (!(a in cache)) cache[a] = Promise.resolve().then(function () { return auth.canView(a); }).then(function (v) { return !!v; }, function () { return false; });
      return cache[a];
    }
    function role() {
      if (!("__role" in cache)) cache.__role = Promise.resolve().then(function () { return auth && typeof auth.role === "function" ? auth.role() : null; }).then(function (r) { return String(r || ""); }, function () { return ""; });
      return cache.__role;
    }
    function check(g) {
      if (g === "always") return Promise.resolve(true);
      if (g === "admin") return role().then(function (r) { return r === "admin"; });
      if (g === CTL) return role().then(function (r) { return r === "admin" ? true : view(CTL); });
      if (!g || typeof g !== "object") return Promise.resolve(false);
      if (g.view) return view(g.view);
      if (g.role) return role().then(function (r) { return g.role.test(r); });
      // r20 coord: the manual flag may be "admin" (studio admin only)
      if (g.feature === "manual" && features && features.manual === "admin") return role().then(function (r) { return r === "admin"; });
      if (g.feature) return Promise.resolve(!!(features && features[g.feature] === true));
      if (g.any) return Promise.all(g.any.map(check)).then(function (v) { return v.some(Boolean); });
      if (g.all) return Promise.all(g.all.map(check)).then(function (v) { return v.every(Boolean); });
      return Promise.resolve(false);
    }
    return check(gate).catch(function () { return false; });
  }

  /* everything this person may open, as flat search entries:
     {kind:"page"|"section"|"setting"|"account", text, context, keywords, href?, open?, sec?} */
  function entriesFor(auth, features, opts) {
    var trial = opts && typeof opts.trial === "boolean" ? opts.trial : undefined;
    var cache = {};
    var pages = Promise.all(PAGES.map(function (p) { return canSee(p.gate, auth, features, cache); }));
    var secs = Promise.all(SECTIONS.map(function (s) { return canSee(s.gate, auth, features, cache); }));
    return Promise.all([pages, secs]).then(function (r) {
      var out = [], okSec = {};
      PAGES.forEach(function (p, i) { if (r[0][i]) out.push({ kind: "page", key: p.key, text: p.label, context: "Page", keywords: p.kw, href: p.href, alias: p.alias, boost: 0.05 }); });
      SECTIONS.forEach(function (s, i) {
        if (!r[1][i]) return; okSec[s.key] = 1;
        out.push({ kind: "section", sec: s.key, text: s.label, context: "Control Center", keywords: s.kw, href: settingHref(s.key, ""), alias: s.alias, boost: 0.03 });
      });
      SETTINGS.forEach(function (x) {
        if (!okSec[x[0]]) return;
        out.push({ kind: "setting", sec: x[0], text: x[1], context: "Control Center " + SECBY[x[0]].label, keywords: x[2] + " " + SECBY[x[0]].kw, href: settingHref(x[0], x[1]) });
      });
      ACCOUNT.forEach(function (a) { out.push({ kind: "account", id: a.id, text: a.text, context: "Your account", keywords: a.kw, open: a.open, boost: 0.2 }); });
      return forTrial(out, trial);   // QA B5: no trial-off pages / sections / settings in a free trial
    });
  }

  /* rank with settings-search-core.js (synonyms, typos) when given, else every word must appear */
  function plainNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  /* an exact alias ("user details", "control center") always comes first: Enter goes straight there */
  function rank(q, list, core, limit) {
    var nq = plainNorm(q), first = (list || []).filter(function (e) { return e.alias && e.alias.indexOf(nq) >= 0; });
    var rest = rankPlain(q, list, core, (limit || 12) + first.length).filter(function (e) { return first.indexOf(e) < 0; });
    return first.concat(rest).slice(0, limit || 12);
  }
  function rankPlain(q, list, core, limit) {
    if (core && typeof core.rank === "function") return core.rank(q, list, limit || 12);
    var words = plainNorm(q).split(" ").filter(Boolean);
    if (!words.length) return [];
    var has = function (txt) { var h = " " + plainNorm(txt); return words.every(function (w) { return h.indexOf(" " + w) >= 0; }); };
    var all = (list || []).filter(function (e) { return has(e.text + " " + (e.context || "") + " " + (e.keywords || "")); });
    var inText = all.filter(function (e) { return has(e.text); });   // words in the title first
    return inText.concat(all.filter(function (e) { return inText.indexOf(e) < 0; })).slice(0, limit || 12);
  }

  return { PAGES: PAGES, SECTIONS: SECTIONS, SETTINGS: SETTINGS, ACCOUNT: ACCOUNT, openAccountItem: openAccountItem, settingHref: settingHref, canSee: canSee, entriesFor: entriesFor, rank: rank,
    TRIAL_OFF_SECTIONS: TRIAL_OFF_SECTIONS, TRIAL_OFF_PAGES: TRIAL_OFF_PAGES, trialOff: trialOff, trialNow: trialNow, forTrial: forTrial };
});
