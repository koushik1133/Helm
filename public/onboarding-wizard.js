/* =========================================================================
   HELM — studio setup wizard model (onboarding.html) + "Resume setup" nudge
   -------------------------------------------------------------------------
   • Pure helpers (no DOM) for the settings steps that sit between Business
     details and the import steps: Studio details, Branding, Team, Venues,
     Payment terms, Packages & templates. onboarding.js renders them.
   • Progress is kept on the studio row (organizations.brand.onboarding) so a
     refresh / re-login on any device resumes at the same step. Every write
     MERGES into the freshly read brand (no other key is ever dropped).
   • Country defaults come from window.HelmCountry when present, otherwise
     from BPStore.tax + a small built-in timezone map.
   • The nudge (dashboard #obNudge) is DOM-only (textContent), no inline style.
   ========================================================================= */
(function (global) {
  "use strict";

  // Whole flow, in order. "billing" and "finish" are handled by onboarding.js itself.
  // "connect" (WhatsApp & email, 0134) only when HELM_FEATURES.integrationsPage is on (config.js; off for the MVP/trial).
  const INTEGRATIONS_ON = !!(global.HELM_FEATURES && global.HELM_FEATURES.integrationsPage === true);
  const FLOW = ["billing", "studio", "brand", "team", "venues", "menu", "pricing", "inventory", "vendors", "staff", "payment"]
    .concat(INTEGRATIONS_ON ? ["connect"] : [], ["templates", "finish"]);
  const SETTINGS = { studio: 1, brand: 1, team: 1, venues: 1, payment: 1, connect: 1, templates: 1 };
  const REQUIRED = { billing: 1, studio: 1 };
  const LABELS = { billing: "Business details", studio: "Studio details", brand: "Branding", team: "Team", venues: "Venues", menu: "Menu dishes",
    pricing: "Item prices", inventory: "Inventory", vendors: "Vendors", staff: "Staff", payment: "Payment terms", connect: "WhatsApp & email", templates: "Packages & templates", finish: "Finish" };
  const LEGACY_KEYS = ["menu", "pricing", "inventory", "vendors", "staff"];   // old #s<n> links + v1 drafts
  const IMPORT_ENTITY = { staff: "staff", menu: "menu", inventory: "inventory" };
  const TZ = { IN: "Asia/Kolkata", AE: "Asia/Dubai", US: "America/New_York", GB: "Europe/London", SG: "Asia/Singapore" };
  const CUR = { IN: "INR", AE: "AED", US: "USD", GB: "GBP", SG: "SGD" };

  const s = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const clean = (v, max) => s(v).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;
  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  function validTz(tz) {
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 40) return false;
    try { if (global.Intl && Intl.DateTimeFormat) { new Intl.DateTimeFormat("en", { timeZone: tz }); } return true; } catch (e) { return false; }
  }
  function httpsUrl(u) { try { const x = new URL(u); return x.protocol === "https:" && !!x.hostname && x.hostname.indexOf(".") > 0; } catch (e) { return false; } }

  /* ---- country → currency / timezone / tax (HelmCountry first) ---------- */
  function countryDefaults(cc, store) {
    cc = s(cc).toUpperCase().slice(0, 2) || "IN";
    const out = { country: cc, currency: CUR[cc] || "", timezone: TZ[cc] || "", taxName: "", taxRate: null, idLabel: "" };
    try {
      const T = store && store.tax; if (T && T.profile) { const p = T.profile(cc) || {};
        if (p.known && p.currency) out.currency = p.currency; if (p.tax) out.taxName = p.tax; if (p.rate != null) out.taxRate = p.rate; if (p.idLabel) out.idLabel = p.idLabel; }
    } catch (e) {}
    try {
      const H = global.HelmCountry; const p = H && (typeof H.get === "function" ? H.get(cc) : typeof H.profile === "function" ? H.profile(cc) : H[cc]);
      if (p && typeof p === "object") {
        if (typeof p.currency === "string" && /^[A-Z]{3}$/.test(p.currency)) out.currency = p.currency;
        const tz = p.timezone || p.tz; if (typeof tz === "string" && validTz(tz)) out.timezone = tz;
        const tn = p.taxName || p.tax; if (typeof tn === "string") out.taxName = tn.slice(0, 24);
        const tr = p.defaultRate != null ? p.defaultRate : (p.taxRate != null ? p.taxRate : p.rate); if (tr != null && isFinite(Number(tr))) out.taxRate = Number(tr);
        const il = p.taxIdLabel || p.idLabel; if (typeof il === "string") out.idLabel = il.slice(0, 24);
      }
    } catch (e) {}
    return out;
  }

  /* ---- Studio details ----------------------------------------------------- */
  function studioFromOrg(o) {
    o = obj(o); const b = obj(o.brand);
    return { name: s(o.name), email: s(o.business_email), website: s(b.website), currency: s(o.currency), timezone: s(o.timezone) };
  }
  function validateStudio(v) {
    v = obj(v); const errors = {};
    const data = { name: clean(v.name, 80), email: clean(v.email, 254).toLowerCase(), website: clean(v.website, 200),
      currency: clean(v.currency, 8).toUpperCase(), timezone: clean(v.timezone, 40) };
    if (!data.name || !/[A-Za-z0-9]/.test(data.name)) errors.name = "Studio name is required.";
    if (data.email && !EMAIL_RE.test(data.email)) errors.email = "Enter a valid email, e.g. hello@studio.com.";
    if (data.website && !/^https?:\/\//i.test(data.website)) data.website = "https://" + data.website;
    if (data.website && !httpsUrl(data.website)) errors.website = "Enter a website like https://studio.com.";
    if (!/^[A-Z]{3}$/.test(data.currency)) errors.currency = "Currency is a 3-letter code, e.g. INR, AED, USD.";
    if (!validTz(data.timezone)) errors.timezone = "Pick a timezone, e.g. Asia/Kolkata.";
    return { ok: !Object.keys(errors).length, data, errors };
  }
  function studioPatch(o, d) {
    const b = obj(obj(o).brand);
    return { name: d.name, business_email: d.email || null, business_email_confirmed: !!d.email, currency: d.currency, timezone: d.timezone,
      brand: Object.assign({}, b, { website: d.website || null }) };
  }

  /* ---- Branding ----------------------------------------------------------- */
  function brandFromOrg(o) { const b = obj(obj(o).brand); return { logo: s(b.logo), accent: s(b.accent) }; }
  function validateBrand(v) {
    v = obj(v); const errors = {}; const data = { logo: clean(v.logo, 500), accent: clean(v.accent, 7) };
    if (data.logo && !httpsUrl(data.logo)) errors.logo = "Logo must be an https:// link to an image.";
    if (data.accent && !HEX_RE.test(data.accent)) errors.accent = "Accent colour must look like #047857.";
    return { ok: !Object.keys(errors).length, data, errors };
  }
  function brandPatch(o, d) { const b = obj(obj(o).brand); return { brand: Object.assign({}, b, { logo: d.logo || null, accent: d.accent || null }) }; }

  /* ---- Payment terms (stored in the pricing config blob, admin only) ------ */
  function paymentFromCfg(c) {
    c = obj(c);
    return { advancePct: c.advancePct == null || c.advancePct === "" ? String(DEFAULT_ADVANCE_PCT) : s(c.advancePct), balanceDueDays: c.balanceDueDays == null ? "0" : s(c.balanceDueDays), paymentTermsNote: s(c.paymentTermsNote) };
  }
  function validatePayment(v) {
    v = obj(v); const errors = {};
    const a = Number(clean(v.advancePct, 6)), d = Number(clean(v.balanceDueDays, 4)); const note = clean(v.paymentTermsNote, 500);
    if (!isFinite(a) || a < 0 || a > 100 || s(v.advancePct).trim() === "") errors.advancePct = "Advance must be between 0 and 100 %.";
    if (!Number.isInteger(d) || d < 0 || d > 365 || s(v.balanceDueDays).trim() === "") errors.balanceDueDays = "Days must be a whole number from 0 to 365.";
    return { ok: !Object.keys(errors).length, data: { advancePct: Math.round(a * 100) / 100, balanceDueDays: d, paymentTermsNote: note }, errors };
  }
  function paymentPatch(cfg, d) { return Object.assign({}, obj(cfg), { advancePct: d.advancePct, balanceDueDays: d.balanceDueDays, paymentTermsNote: d.paymentTermsNote || "" }); }

  /* ---- progress (server-side, on organizations.brand.onboarding) --------- */
  function progressFromOrg(o) {
    const p = obj(obj(obj(o).brand).onboarding);
    const list = (a) => (Array.isArray(a) ? a.filter((k) => FLOW.indexOf(k) >= 0).slice(0, FLOW.length) : []);
    return { step: FLOW.indexOf(p.step) >= 0 ? p.step : null, done: list(p.done), skipped: list(p.skipped),
      completed_at: typeof p.completed_at === "string" ? p.completed_at.slice(0, 40) : null };
  }
  function progressPatch(o, prog) {
    const b = obj(obj(o).brand); const cur = progressFromOrg(o);
    const rec = { step: FLOW.indexOf(prog.step) >= 0 ? prog.step : (cur.step || "billing"),
      done: (prog.done || []).filter((k) => FLOW.indexOf(k) >= 0), skipped: (prog.skipped || []).filter((k) => FLOW.indexOf(k) >= 0),
      completed_at: prog.completed_at || cur.completed_at || null, updated_at: new Date().toISOString() };
    return { brand: Object.assign({}, b, { onboarding: rec }) };
  }
  // % of the flow (excluding finish) that is done or skipped
  function percent(done, skipped) {
    const steps = FLOW.filter((k) => k !== "finish"); const seen = {};
    (done || []).concat(skipped || []).forEach((k) => { if (steps.indexOf(k) >= 0) seen[k] = 1; });
    return Math.round((Object.keys(seen).length / steps.length) * 100);
  }
  function requiredMissing(done) { return Object.keys(REQUIRED).filter((k) => (done || []).indexOf(k) < 0); }
  // legacy "#s<n>" (old import-only wizard) and new "#step-<key>" hashes
  function stepFromHash(h) {
    h = s(h); let m = /^#step-([a-z]+)$/.exec(h); if (m && FLOW.indexOf(m[1]) >= 0) return m[1];
    m = /^#s(\d)$/.exec(h); if (m && LEGACY_KEYS[Number(m[1])]) return LEGACY_KEYS[Number(m[1])];
    return null;
  }
  // nudge on the dashboard: admins of a studio whose setup isn't finished
  function nudgeFor(o, role) {
    if (!o || role !== "admin") return null; const p = progressFromOrg(o);
    if (p.completed_at) return null;
    if (!p.step && !p.done.length) return null;            // studio predates the wizard and never opened it
    const pct = percent(p.done, p.skipped); const step = p.step && p.step !== "finish" ? p.step : FLOW.find((k) => k !== "finish" && p.done.indexOf(k) < 0 && p.skipped.indexOf(k) < 0) || "finish";
    return { pct, step, label: LABELS[step] || "Finish", href: "onboarding.html#step-" + step };
  }

  /* ---- dashboard nudge (DOM) --------------------------------------------- */
  const NUDGE_CSS = ".ob-nudge{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;background:var(--accent-soft,#e3f4ed);border:1px solid var(--line,#e8e3db);border-radius:14px;padding:12px 16px;margin:0 0 14px}"
    + ".ob-nudge b{font-size:14px}.ob-nudge span{font-size:12.5px;color:var(--ink-3,#6b6577)}.ob-nudge progress{flex:1 1 120px;height:8px;accent-color:var(--accent,#047857)}"
    + ".ob-nudge a.ob-cta{font:600 13px var(--font,system-ui);background:var(--hb-acc,var(--accent,#047857));color:var(--hb-acc-ink,var(--accent-ink,#fff));border-radius:9px;padding:8px 14px;text-decoration:none}";
  async function mountNudge() {
    const box = global.document && document.getElementById("obNudge"); const S = global.BPStore;
    if (!box || !S || !S.org || (S.mode && S.mode() !== "supabase")) return;
    let o = null, role = null;
    try { o = await S.org.current(); role = await S.auth.role(); } catch (e) { return; }
    const n = nudgeFor(o, role); if (!n) return;
    // 0177: a free-trial studio has no full studio setup, so no "Resume setup" nudge
    try { if (S.trialOrg && S.trialOrg.inTrial && (await S.trialOrg.inTrial())) return; } catch (e) {}
    // one shared setup-progress source: the dashboard "Setup" chip reads this same value
    api.lastNudge = n; try { document.dispatchEvent(new CustomEvent("helm:onb-progress", { detail: n })); } catch (e) {}
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(document, NUDGE_CSS);
    box.textContent = "";
    const t = document.createElement("div"); const b = document.createElement("b"); b.textContent = "Finish setting up your studio"; t.appendChild(b);
    const sub = document.createElement("span"); sub.textContent = " · " + n.pct + "% done · Next: " + n.label; t.appendChild(sub);
    const pr = document.createElement("progress"); pr.max = 100; pr.value = n.pct; pr.setAttribute("aria-label", "Setup progress");
    const a = document.createElement("a"); a.href = n.href; a.className = "ob-cta"; a.textContent = "Resume setup";
    box.appendChild(t); box.appendChild(pr); box.appendChild(a); box.hidden = false;
  }
  if (global.document) {
    const start = () => { let tries = 0; (function wait() {
      const S = global.BPStore; if (S && S.auth && S.auth.user && S.auth.user()) { mountNudge(); return; }
      if (tries++ < 30) setTimeout(wait, 500); })(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }

  // B2: studio currency/timezone follow the business country unless the user customised them.
  // d = values shown (org + typed), typed = what the user typed this session, cd = countryDefaults(+state tz)
  // B6: same default as BPStore.DEFAULT_ADVANCE_PCT / flow.html (10%) when the studio never set one
  const DEFAULT_ADVANCE_PCT = (global.BPStore && Number.isFinite(global.BPStore.DEFAULT_ADVANCE_PCT)) ? global.BPStore.DEFAULT_ADVANCE_PCT : 10;
  const AUTO_CUR = ["INR", "AED", "USD", "GBP", "SGD", "AUD", "CAD"];
  function followCountry(d, typed, cd) {
    const out = Object.assign({}, d); typed = obj(typed); cd = obj(cd);
    const H = global.HelmCountry; const autoTz = (tz) => (H && H.isAutoTimezone ? H.isAutoTimezone(tz) : !tz || Object.values(TZ).indexOf(tz) >= 0);
    if (cd.timezone && typed.timezone === undefined && autoTz(out.timezone)) out.timezone = cd.timezone;
    if (cd.currency && typed.currency === undefined && (!out.currency || AUTO_CUR.indexOf(String(out.currency).toUpperCase()) >= 0)) out.currency = cd.currency;
    return out;
  }
  // 0096: step 11 "Packages & templates" checklist - the studio's own layout templates open the builder in template-edit mode
  const TEMPLATE_ITEMS = [
    { key: "pkgs", label: "Review menu packages", href: "control.html#pricing" },
    { key: "lists", label: "Review checklist templates", href: "templates.html" },
    { key: "layouts", label: "Customize your own templates", href: "builder.html?new=1&tplEdit=new", why: "Save your own floor layouts so every new event starts from your studio's style." },
  ];
  const api = { FLOW, TEMPLATE_ITEMS, followCountry, DEFAULT_ADVANCE_PCT, SETTINGS, REQUIRED, LABELS, LEGACY_KEYS, IMPORT_ENTITY, countryDefaults, validTz,
    studioFromOrg, validateStudio, studioPatch, brandFromOrg, validateBrand, brandPatch,
    paymentFromCfg, validatePayment, paymentPatch, progressFromOrg, progressPatch, percent, requiredMissing, stepFromHash, nudgeFor, mountNudge };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.HelmOnbWizard = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
