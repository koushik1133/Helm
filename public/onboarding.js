/* =========================================================================
   HELM — client onboarding wizard (UI). Pure logic lives in onboarding-core.js
   (unit-tested). This file only wires DOM + BPStore.

   Writes ONLY through existing BPStore create/update APIs (RLS + org scoping
   stay server-side). Nothing is written before the preview step. Undo is a
   SOFT delete (active=false) of rows this import created — never a hard delete.
   CSP: no inline handlers / style attributes; CSS via __helmAdoptCss; every
   interpolated value goes through esc() or Number().
   ========================================================================= */
(function () {
  "use strict";
  const O = window.HelmOnboarding;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const W = window.HelmOnbWizard;
  // whole flow (onboarding-wizard.js): billing (BILL) → settings + import steps (KEYS) → finish (KEYS.length)
  const KEYS = W.FLOW.filter((k) => k !== "billing" && k !== "finish");
  const OPTIONAL = {}; KEYS.forEach((k) => { if (!W.REQUIRED[k]) OPTIONAL[k] = true; });
  const isSet = (k) => !!W.SETTINGS[k];
  const lbl = (k) => W.LABELS[k] || (O.KINDS[k] && O.KINDS[k].label) || k;
  const keyOf = (i) => (i === BILL ? "billing" : i >= KEYS.length ? "finish" : KEYS[i]);
  const idxOf = (k) => (k === "billing" ? BILL : k === "finish" ? KEYS.length : Math.max(0, KEYS.indexOf(k)));
  let setVals = {}, setErr = {}, pricingCfg = null, invites = [], venuesOpened = false, tplCounts = null, serverProg = null, progT = null;
  const INTRO = {
    studio: "How your studio appears to clients and in Helm. Currency and timezone follow the country you picked in Business details; change them if needed.",
    brand: "Optional. Your logo and accent colour on quotations, booklets and client links.",
    team: "Optional. Invite the people who will sign in to Helm and pick each person's role. They get a join link (valid 7 days). Crew who don't sign in can be added in the Staff step.",
    venues: "Optional. The halls and venues you work with. Pick one on a quote to fill in the hall details. Venues are never deleted, only deactivated.",
    payment: "Optional. Your default advance and when the balance is due. Shown as your standard terms; you can still change them per event.",
    connect: "Optional. Check your e-mail sender name and reply-to, and save your studio WhatsApp number. Each has a Send test button on the Integrations page.",
    templates: "Optional. Menu packages and checklist templates speed up every quote. Review them now or later in Control Center.",
    menu: "Add the dishes you serve. They appear in the menu picker on every quote. Dishes with the same name as an existing one are skipped by default.",
    pricing: "Your per-chair and per-plate rates. These feed live quote pricing. Existing rates are never changed here; duplicates are skipped by default.",
    inventory: "Your stock: item, quantity and (optionally) unit cost. If an item already exists you can add the quantity to it instead of skipping.",
    vendors: "Optional. Your regular partners (caterers, decorators, sound...). You can add more later from the Vendors page.",
    staff: "Optional. Your team members and crew. You can add more later from the Staff page.",
  };
  const LS_DRAFT = "helm_onb_draft_v1:", LS_LEDGER = "helm_onb_ledger_v1:";
  let uid = "anon", S = null, ledger = { entries: {} }, perms = {}, busy = false, existingCache = {}, previews = {}, invCache = null;
  // business / billing details (step 0): org row, whether this user may save it, last form values + errors
  let org = null, orgErr = null, canBill = false, bill = { values: {}, errors: {} };
  const billingOk = () => !!org && O.billingMissing(org).length === 0;
  const BILL = -1;   // S.step value of the business-details step

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };

  const CSS = [
    ".ob{max-width:960px;margin:0 auto}.ob h2{margin:0 0 4px;font-size:20px}.ob .sub{color:var(--ink-3,#6b6577);font-size:13px;margin:0 0 14px}",
    ".ob-steps{display:flex;gap:6px;overflow-x:auto;padding:4px 0 12px;margin:0;list-style:none}",
    ".ob-steps li{flex:0 0 auto}.ob-steps button{display:flex;align-items:center;gap:7px;border:1px solid var(--line,#e8e3db);background:var(--panel,#fff);border-radius:999px;padding:7px 12px;font:600 12.5px var(--font,system-ui);color:var(--ink-2,#4b475f);cursor:pointer}",
    ".ob-steps button[aria-current=step]{border-color:var(--accent,#6d28d9);color:var(--accent,#6d28d9);background:var(--accent-soft,#efe9ff)}",
    ".ob-steps button:disabled{opacity:.5;cursor:not-allowed}.ob-steps .n{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--line-2,#f1ede7);font-size:11px}",
    ".ob-steps .done .n{background:var(--safe,#18a558);color:#fff}",
    ".ob-card{background:var(--panel,#fff);border:1px solid var(--line,#e8e3db);border-radius:14px;padding:18px;margin-bottom:14px}",
    ".ob-tabs{display:flex;gap:6px;margin:0 0 12px}.ob-tabs button{padding:7px 14px;border-radius:8px;border:1px solid var(--line,#e8e3db);background:var(--panel-2,#faf8f5);font:600 13px var(--font,system-ui);cursor:pointer}",
    ".ob-tabs button[aria-pressed=true]{background:var(--accent,#6d28d9);color:#fff;border-color:var(--accent,#6d28d9)}",
    ".ob-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}.ob table{border-collapse:collapse;width:100%;font-size:13px}",
    ".ob th,.ob td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line-2,#f1ede7);vertical-align:top}.ob th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3,#6b6577);white-space:nowrap}",
    ".ob td input,.ob td select{width:100%;min-width:90px;box-sizing:border-box;padding:7px 8px;border:1px solid var(--line,#e8e3db);border-radius:8px;font:inherit;background:var(--panel,#fff);color:inherit}",
    ".ob textarea{width:100%;min-height:150px;box-sizing:border-box;padding:10px;border:1px solid var(--line,#e8e3db);border-radius:10px;font:12.5px var(--mono,monospace);background:var(--panel,#fff);color:inherit}",
    ".ob-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}.ob-grow{flex:1 1 auto}",
    ".ob-chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.ob-chip{padding:6px 12px;border-radius:999px;font:600 12.5px var(--font,system-ui);background:var(--line-2,#f1ede7)}",
    ".ob-chip.ok{background:#e3f6ec;color:#0f7a43}.ob-chip.warn{background:#fff1de;color:#9a5a08}.ob-chip.bad{background:#fde7e7;color:#a12626}",
    ".ob-st{font-weight:700;font-size:11.5px;white-space:nowrap}.ob-st.new{color:#0f7a43}.ob-st.dup{color:#9a5a08}.ob-st.bad{color:#a12626}",
    ".ob-err{color:#a12626;font-size:12px}.ob-note{font-size:12.5px;color:var(--ink-3,#6b6577)}.ob-warn{background:#fff7e8;border:1px solid #f1d9a8;border-radius:10px;padding:9px 12px;font-size:12.5px;margin:8px 0}",
    ".ob-map{display:grid;grid-template-columns:minmax(120px,200px) 1fr;gap:8px 12px;align-items:center}.ob-map select{padding:7px 8px;border-radius:8px;border:1px solid var(--line,#e8e3db);background:var(--panel,#fff);color:inherit;font:inherit}",
    ".ob-lock{padding:14px;border:1px dashed var(--line,#e8e3db);border-radius:12px;color:var(--ink-3,#6b6577)}",
    ".ob-bf{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px}.ob-bf .full{grid-column:1/-1}.ob-bf label{display:block;font-size:12.5px;font-weight:600;margin:0 0 4px}",
    ".ob-bf input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--line,#e8e3db);border-radius:8px;font:inherit;background:var(--panel,#fff);color:inherit}",
    ".ob-bf input[aria-invalid=true]{border-color:#c43c3c}.ob-bf .ob-err{margin-top:3px}@media (max-width:640px){.ob-bf{grid-template-columns:1fr}}",
    ".ob-bar{height:8px;border-radius:99px;background:var(--line-2,#f1ede7);overflow:hidden}.ob-bar i{display:block;height:100%;background:var(--accent,#6d28d9);width:0}",
    ".ob-bf select,.ob-bf textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--line,#e8e3db);border-radius:8px;font:inherit;background:var(--panel,#fff);color:inherit;min-height:0}",
    ".ob-bf input[type=color]{padding:2px;height:40px}.ob-req{font:600 10.5px var(--font,system-ui);color:#9a5a08;background:#fff1de;border-radius:99px;padding:1px 7px;margin-left:4px}",
    ".ob-prog{display:flex;align-items:center;gap:10px;margin:0 0 8px}.ob-prog progress{flex:1 1 auto;height:8px;accent-color:var(--accent,#6d28d9)}",
    ".ob-inv{list-style:none;padding:0;margin:8px 0}.ob-inv li{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-2,#f1ede7)}.ob-inv input{flex:1 1 220px;min-width:0;padding:7px 8px;border:1px solid var(--line,#e8e3db);border-radius:8px;font:12px var(--mono,monospace)}",
    "#obPark{display:none}",
    "@media (max-width:640px){.ob-card{padding:12px}.ob-map{grid-template-columns:1fr}.ob-row .btn{flex:1 1 100%}}",
  ].join("\n");

  /* ---------- state + draft ---------- */
  function blankStep() { return { mode: "manual", text: "", fileName: "", manual: [{}, {}, {}, {}, {}], mapping: null, actions: {}, batchKey: null, contentHash: null, stage: "input", done: false, skipped: false }; }
  function freshState() { const s = { step: 0, steps: {} }; KEYS.forEach((k) => { s.steps[k] = blankStep(); }); return s; }
  function loadDraft() {
    const d = O.parseDraft(lsGet(LS_DRAFT + uid)); const s = freshState(); if (!d) return { s, resumed: false };
    // v1 drafts stored only an index into the old import-only list; newer ones carry stepKey
    const sk = typeof d.stepKey === "string" ? d.stepKey : ((d.step | 0) >= W.LEGACY_KEYS.length ? "finish" : W.LEGACY_KEYS[Math.max(0, d.step | 0)]);
    s.step = W.FLOW.indexOf(sk) >= 0 ? idxOf(sk) : 0;
    KEYS.forEach((k) => { if (d.steps[k]) Object.assign(s.steps[k], d.steps[k]); if (!Array.isArray(s.steps[k].manual) || !s.steps[k].manual.length) s.steps[k].manual = [{}, {}, {}]; });
    return { s, resumed: true };
  }
  let saveT = null, saveWarned = false;
  function saveDraft() { clearTimeout(saveT); saveT = setTimeout(() => { if (!lsSet(LS_DRAFT + uid, draftJson()) && !saveWarned) { saveWarned = true; BPUI.toast("Could not autosave your progress in this browser (storage full or blocked).", { type: "info" }); } }, 300); }
  function draftJson() { let j = {}; try { j = JSON.parse(O.serializeDraft(S)); } catch (e) {} j.stepKey = keyOf(S.step); return JSON.stringify(j); }
  function loadLedger() { try { const l = JSON.parse(lsGet(LS_LEDGER + uid) || "null"); if (l && l.entries) ledger = l; } catch (e) {} }
  function saveLedger() { lsSet(LS_LEDGER + uid, JSON.stringify(ledger)); }

  /* ---------- permissions ---------- */
  async function computePerms() {
    const sb = BPStore.mode() === "supabase"; const role = sb ? await BPStore.auth.role() : "admin";
    for (const k of KEYS) {
      if (!sb || role === "admin") { perms[k] = true; continue; }
      if (k === "templates") { perms[k] = true; continue; }                     // review-only step (links out)
      if (k === "venues") { perms[k] = await BPStore.auth.canEditArea("venues"); continue; }
      if (isSet(k)) { perms[k] = false; continue; }                             // studio row, invites, pricing config: admin only
      if (k === "menu" || k === "pricing") { perms[k] = false; continue; }       // company-wide config: admin only (matches Control Center)
      perms[k] = await BPStore.auth.canEditArea(O.KINDS[k].area);
    }
  }

  /* ---------- store adapters ---------- */
  async function loadExisting(kind) {
    if (kind === "menu") return (await BPStore.dishCatalog.list(true)) || [];
    if (kind === "pricing") {
      const [c, p] = await Promise.all([BPStore.chairTypes.list(true), BPStore.plateTypes.list(true)]);
      return (c || []).map((r) => Object.assign({}, r, { _type: "chair" })).concat((p || []).map((r) => Object.assign({}, r, { _type: "plate" })));
    }
    if (kind === "inventory") return (await BPStore.inventory.items(true)) || [];
    if (kind === "vendors") return (await BPStore.vendors.listAll(true)) || [];
    return (await BPStore.staff.list(true)) || [];
  }
  const adapter = {
    async create(kind, p) {
      if (kind === "menu") return BPStore.dishCatalog.add(p.category, p.name, p.kind);
      if (kind === "pricing") { const r = await (p.type === "chair" ? BPStore.chairTypes : BPStore.plateTypes).add(p.name, p.price); return { id: p.type + ":" + r.id }; }
      if (kind === "inventory") return BPStore.inventory.addItem(p);
      if (kind === "vendors") return BPStore.vendors.addFull(p);
      return BPStore.staff.add(p);
    },
    async createMany(kind, list) { if (kind === "inventory") return BPStore.inventory.addItems(list); throw new Error("no bulk"); },
    async merge(kind, id, p) {
      if (kind !== "inventory") throw new Error("merge not supported");
      invCache = invCache || await BPStore.inventory.items(true);            // fresh quantities, read just before writing
      const cur = invCache.find((x) => x.id === id); if (!cur) throw new Error("item no longer exists");
      const next = Math.min(O.MAX_QTY, (Number(cur.total_qty) || 0) + p.total_qty);
      await BPStore.inventory.updateItem(id, { total_qty: next }); cur.total_qty = next; return true;
    },
    async update(kind, id, p) {                                               // only after the user picked "Update existing"
      if (kind === "pricing") return (p.type === "chair" ? BPStore.chairTypes : BPStore.plateTypes).update(id, { price: p.price });
      if (kind === "inventory") { invCache = null; return BPStore.inventory.updateItem(id, { total_qty: p.total_qty, unit: p.unit, unit_cost: p.unit_cost }); }
      throw new Error("update not supported");
    },
    async deactivate(kind, id) {                                              // SOFT delete only
      if (kind === "menu") return BPStore.dishCatalog.remove(id);
      if (kind === "pricing") { const [t, rid] = String(id).split(":"); return (t === "chair" ? BPStore.chairTypes : BPStore.plateTypes).remove(rid); }
      if (kind === "inventory") return BPStore.inventory.updateItem(id, { active: false });
      if (kind === "vendors") return BPStore.vendors.remove(id);
      return BPStore.staff.update(id, { active: false });
    },
  };

  /* ---------- derived data ---------- */
  function tableOf(kind) {
    const st = S.steps[kind];
    if (st.mode === "manual") return O.tableFromManual(kind, st.manual);
    return O.parseCSV(st.text).rows;
  }
  function hashOf(o) { const s = JSON.stringify(o); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h >>> 0); }
  function currentMapping(kind, table) {
    const st = S.steps[kind];
    if (st.mode === "manual") { const m = {}; O.KINDS[kind].fields.forEach((f, i) => { m[f.key] = i; }); return m; }
    return st.mapping || O.mapHeaders(table[0] || [], kind).mapping;
  }
  function counts(kind) { const st = S.steps[kind]; return st.batchKey ? O.ledgerCounts(ledger, st.batchKey, kind) : { ok: 0, merged: 0, error: 0 }; }

  /* ---------- rendering ---------- */
  function doneKeys() { const d = billingOk() ? ["billing"] : []; KEYS.forEach((k) => { if (S.steps[k].done) d.push(k); }); return d; }
  function skippedKeys() { return KEYS.filter((k) => S.steps[k].skipped && !S.steps[k].done); }
  function render() {
    const root = $("#obRoot"); if (!root) return;
    parkVenues();
    const req = (k) => (W.REQUIRED[k] ? ' <span class="ob-req">required</span>' : "");
    const pos = S.step === BILL ? 1 : Math.min(KEYS.length + 2, S.step + 2), total = KEYS.length + 2, pct = W.percent(doneKeys(), skippedKeys());
    const prog = `<div class="ob-prog"><span class="ob-note">Step ${Number(pos)} of ${Number(total)} · ${Number(pct)}% done</span><progress max="100" value="${Number(pct)}" aria-label="Setup progress">${Number(pct)}%</progress></div>`;
    const stepsNav = prog + `<ol class="ob-steps" aria-label="Setup steps"><li class="${billingOk() ? "done" : ""}"><button type="button" data-act="goto" data-i="${BILL}"${S.step === BILL ? ' aria-current="step"' : ""}><span class="n">${billingOk() ? "✓" : "1"}</span>Business details${req("billing")}</button></li>` + KEYS.map((k, i) => {
      const st = S.steps[k]; const cls = st.done || st.skipped ? "done" : "";
      return `<li class="${esc(cls)}"><button type="button" data-act="goto" data-i="${Number(i)}"${S.step === i ? ' aria-current="step"' : ""}><span class="n">${st.done ? "✓" : Number(i) + 2}</span>${esc(lbl(k))}${req(k)}</button></li>`;
    }).join("") + `<li class="${S.step === KEYS.length ? "" : ""}"><button type="button" data-act="goto" data-i="${KEYS.length}"${S.step === KEYS.length ? ' aria-current="step"' : ""}><span class="n">★</span>Finish</button></li></ol>`;
    let body = "";
    if (S.step === BILL) body = renderBilling();
    else if (S.step >= KEYS.length) body = renderFinish();
    else {
      const kind = KEYS[S.step], st = S.steps[kind];
      if (!perms[kind]) body = `<div class="ob-card"><h2>${esc(lbl(kind))}</h2><div class="ob-lock"><b>${esc(lbl(kind))}</b> can only be set up by ${kind === "menu" || kind === "pricing" || isSet(kind) ? "an admin" : "a role that can edit this area"}. Ask your admin, or skip this step.</div><div class="ob-row">${navBack()}<span class="ob-grow"></span><button type="button" class="btn" data-act="skip">Skip for now</button></div></div>`;
      else if (isSet(kind)) body = renderSetting(kind);
      else if (st.stage === "map") body = renderMap(kind);
      else if (st.stage === "preview") body = renderPreview(kind);
      else if (st.stage === "result") body = renderResult(kind);
      else body = renderInput(kind);
    }
    root.innerHTML = `${stepsNav}${body}`;
    const live = $("#obLive"); if (live) live.textContent = "";
    mountVenues();
  }
  const navBack = () => (S.step > BILL ? '<button type="button" class="btn" data-act="prev">Back</button>' : "");

  /* ---------- settings steps (studio, brand, team, venues, payment, templates) ---------- */
  function sfld(kind, key, label, v, o) {
    o = o || {}; const id = "ob_s_" + key, eid = id + "_err", e = (setErr[kind] || {})[key] || "";
    const attrs = `id="${esc(id)}" data-set="${esc(key)}" aria-invalid="${!!e}" aria-describedby="${esc(eid)}${o.hint ? " " + esc(id) + "_hint" : ""}"${o.req ? ' aria-required="true"' : ""}${o.max ? ` maxlength="${Number(o.max)}"` : ""}${o.ac ? ` autocomplete="${esc(o.ac)}"` : ""}${o.list ? ` list="${esc(o.list)}"` : ""}${o.im ? ` inputmode="${esc(o.im)}"` : ""}`;
    const ctl = o.area ? `<textarea ${attrs} rows="3">${esc(v)}</textarea>` : `<input type="${esc(o.type || "text")}" ${attrs} value="${esc(v)}"${o.type === "number" ? ` min="${Number(o.min || 0)}" max="${Number(o.maxN || 100)}" step="${esc(o.step || "1")}"` : ""}>`;
    return `<div class="${o.full ? "full" : ""}"><label for="${esc(id)}">${esc(label)}${o.req ? " *" : ""}</label>${ctl}`
      + (o.hint ? `<div class="ob-note" id="${esc(id)}_hint">${esc(o.hint)}</div>` : "") + `<div class="ob-err" id="${esc(eid)}">${esc(e)}</div></div>`;
  }
  // country defaults + the timezone of the billing state (US: by state) - B2
  function studioDefaults(cc, region) {
    const bl = O.billingFromOrg(org); cc = cc || bl.country; region = region == null ? bl.state : region;
    const cd = W.countryDefaults(cc, BPStore), H = window.HelmCountry; const tz = H && H.timezone ? H.timezone(cc, region) : "";
    if (tz) cd.timezone = tz; return cd;
  }
  function setFooter(kind, saveLabel) {
    return `<div id="obErr" class="ob-err" role="alert"></div><div class="ob-row">${navBack()}<span class="ob-grow"></span>`
      + (OPTIONAL[kind] ? '<button type="button" class="btn" data-act="skip">Skip for now</button>' : "")
      + `<button type="submit" class="btn primary" data-act="setsave">${esc(saveLabel || "Save & continue")}</button></div>`;
  }
  const TZS = ["Asia/Kolkata", "Asia/Dubai", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Asia/Singapore"];
  function renderSetting(kind) {
    const v = setVals[kind] || {}; const head = `<h2>${esc(lbl(kind))}${W.REQUIRED[kind] ? ' <span class="ob-req">required</span>' : ""}</h2><p class="sub">${esc(INTRO[kind])}</p>`;
    const form = (inner, save) => `<div class="ob-card">${head}<form id="obSet" data-kind="${esc(kind)}" novalidate>${inner}${setFooter(kind, save)}</form></div>`;
    if (kind === "studio") {
      const cd = studioDefaults(), d = W.followCountry(Object.assign(W.studioFromOrg(org), v), v, cd);
      const def = (cd.currency || cd.timezone) && (cd.currency !== d.currency || cd.timezone !== d.timezone)
        ? `<div class="ob-warn">Your country suggests ${esc(cd.currency)} · ${esc(cd.timezone)}. <button type="button" class="btn" data-act="setdefaults">Use these</button></div>` : "";
      return form(`${def}<div class="ob-bf">${sfld(kind, "name", "Studio / brand name", d.name, { req: 1, max: 80, ac: "organization", full: 1 })}`
        + sfld(kind, "email", "Business email", d.email, { type: "email", max: 254, ac: "email", hint: "Shown to clients as your contact." })
        + sfld(kind, "website", "Website", d.website, { type: "url", max: 200, ac: "url", hint: "Optional, e.g. https://studio.com" })
        + sfld(kind, "currency", "Currency", d.currency, { req: 1, max: 3, hint: cd.taxName ? "Tax: " + cd.taxName + (cd.taxRate != null ? " " + cd.taxRate + "%" : "") : "" })
        + sfld(kind, "timezone", "Timezone", d.timezone, { req: 1, max: 40, list: "obTzList" })
        + `<datalist id="obTzList">${TZS.map((z) => `<option value="${esc(z)}"></option>`).join("")}</datalist></div>`);
    }
    if (kind === "brand") {
      // #setup-accent: a studio that never picked a colour starts on Helm's green (the theme default),
      // not the old violet; a colour the studio already saved is shown and kept exactly as it is.
      const d = Object.assign(W.brandFromOrg(org), v); if (v.accent === undefined && !d.accent) d.accent = W.DEFAULT_ACCENT;
      return form(`<div class="ob-bf">${sfld(kind, "logo", "Logo link (https)", d.logo, { type: "url", max: 500, full: 1, hint: "A public https:// link to your logo image (PNG, JPG or SVG)." })}`
        + sfld(kind, "accent", "Accent colour", d.accent, { max: 7, hint: "Hex colour, e.g. " + W.DEFAULT_ACCENT + " (Helm green)" })
        + `<div><label for="ob_s_accent_pick">Pick a colour</label><input type="color" id="ob_s_accent_pick" data-pick="accent" value="${esc(/^#[0-9a-f]{6}$/i.test(d.accent) ? d.accent : W.DEFAULT_ACCENT)}"></div></div>`);
    }
    if (kind === "payment") {
      const d = Object.assign(W.paymentFromCfg(pricingCfg), v);
      return form(`<div class="ob-bf">${sfld(kind, "advancePct", "Advance to confirm a booking (%)", d.advancePct, { type: "number", req: 1, maxN: 100, step: "0.5", im: "decimal" })}`
        + sfld(kind, "balanceDueDays", "Balance due (days before the event)", d.balanceDueDays, { type: "number", req: 1, maxN: 365, im: "numeric", hint: "0 = on the event day." })
        + sfld(kind, "paymentTermsNote", "Payment terms note", d.paymentTermsNote, { area: 1, max: 500, full: 1, hint: "Optional, e.g. cancellation or refund terms." }) + `</div>`);
    }
    if (kind === "team") {
      const roles = (BPStore.auth.admin && BPStore.auth.admin.roles && BPStore.auth.admin.roles()) || ["coordinator"];
      const rl = (r) => (BPStore.auth.admin && BPStore.auth.admin.roleLabel ? BPStore.auth.admin.roleLabel(r) : r);
      const list = invites.length ? `<ul class="ob-inv">${invites.map((x, i) => `<li><b>${esc(x.email)}</b> · ${esc(rl(x.role))}<input readonly aria-label="Join link for ${esc(x.email)}" value="${esc(x.link)}"><button type="button" class="btn" data-act="invcopy" data-i="${Number(i)}">Copy link</button></li>`).join("")}</ul>` : "";
      return form(`<div class="ob-bf">${sfld(kind, "email", "Teammate email", v.email || "", { type: "email", max: 254, ac: "off" })}`
        + `<div><label for="ob_s_role">Role</label><select id="ob_s_role" data-set="role">${roles.map((r) => `<option value="${esc(r)}"${r === (v.role || "coordinator") ? " selected" : ""}>${esc(rl(r))}</option>`).join("")}</select><div class="ob-err" id="ob_s_role_err"></div></div></div>`
        + `<div class="ob-row"><button type="button" class="btn" data-act="invite">Create invite link</button><a class="btn" href="control.html#users">Manage roles &amp; access</a></div>${list}`,
        invites.length ? "Save & continue" : "Continue");
    }
    if (kind === "venues") return form(`<div id="obVenuesSlot"></div>`);
    // 0134: review-only - email invites (on via Helm) + WhatsApp setup guide on the Integrations page
    if (kind === "connect") {
      return form(`<ul class="ob-check"><li>✓ <b>Email invites</b> <span class="ob-note">Every teammate you invite gets the Join link by e-mail; Copy link stays as a backup. Set the sender name and reply-to address clients see on the Integrations page.</span></li>`
        + `<li>○ <a href="integrations.html#whatsapp"><b>Connect WhatsApp</b></a> <span class="ob-note">Save your studio WhatsApp number (with + and country code) and press Send test. It shows Simulated until Helm switches WhatsApp on, then Live.</span></li></ul>`
        + `<div class="ob-row"><a class="btn" href="integrations.html#whatsapp">Set up WhatsApp</a><a class="btn" href="integrations.html#email">Set up e-mail</a></div>`, "Continue");
    }
    // templates
    const c = tplCounts;
    const line = c ? `<ul><li><b>${Number(c.pkgs)}</b> menu package(s)</li><li><b>${Number(c.lists)}</b> checklist template(s)</li><li><b>${Number(c.layouts)}</b> layout template(s) of your own</li></ul>` : `<p class="ob-note">Loading…</p>`;
    // 0096: checklist item "Customize your own templates" -> builder in template-edit mode (blank hall + name + Save template)
    const ti = (window.HelmOnbWizard && HelmOnbWizard.TEMPLATE_ITEMS || []).filter((x) => x.key === "layouts")[0];
    const own = ti ? `<ul class="ob-check"><li>${c && c.layouts > 0 ? "✓" : "○"} <a href="${esc(ti.href)}">${esc(ti.label)}</a> <span class="ob-note">${esc(ti.why)}</span></li></ul>` : "";
    return form(`${line}${own}<div class="ob-row"><a class="btn" href="control.html#pricing">Edit menu packages</a><a class="btn" href="templates.html">Open checklist templates</a>${ti ? `<a class="btn" href="${esc(ti.href)}">${esc(ti.label)}</a>` : ""}</div>`, "Looks good — continue");
  }
  // reuse Control Center's venues manager (venues-admin.js): its pane is parked off-screen and moved in/out
  function parkVenues() { const pane = $("#pane-venues"), park = $("#obPark"); if (pane && park && pane.parentNode !== park) { park.appendChild(pane); pane.hidden = true; } }
  function mountVenues() {
    const slot = $("#obVenuesSlot"), pane = $("#pane-venues"); if (!slot) return;
    if (!pane || !window.HelmVenuesAdmin) { slot.innerHTML = '<div class="ob-lock">Venues can be added in <a href="control.html#venues">Control Center → Venues</a>.</div>'; return; }
    slot.appendChild(pane); pane.hidden = false;
    if (!venuesOpened) { venuesOpened = true; try { window.HelmVenuesAdmin.reload(); } catch (e) {} }
  }
  async function loadTplCounts() {
    if (tplCounts) return; const n = async (f) => { try { return ((await f()) || []).length; } catch (e) { return 0; } };
    tplCounts = { pkgs: await n(() => BPStore.menuTemplates.list(false)), lists: await n(() => BPStore.templates.list()),
      layouts: await n(() => (BPStore.layoutTemplates ? BPStore.layoutTemplates.list({ lite: true }) : [])) };
    if (KEYS[S.step] === "templates") render();
  }
  function readSet() { const vals = {}; document.querySelectorAll("#obSet [data-set]").forEach((el) => { vals[el.dataset.set] = el.value; }); return vals; }
  function setFail(kind, r) {
    setVals[kind] = readSet(); setErr[kind] = r.errors; render();
    const k = Object.keys(r.errors)[0]; const el = k && $("#ob_s_" + k); if (el) el.focus();
    const live = $("#obLive"); if (live) live.textContent = "Please fix " + Object.keys(r.errors).length + " field(s).";
  }
  async function saveSetting(kind) {
    const vals = readSet(); const st = S.steps[kind];
    try {
      if (kind === "studio" || kind === "brand") {
        const r = kind === "studio" ? W.validateStudio(vals) : W.validateBrand(vals); if (!r.ok) return setFail(kind, r);
        const fresh = await BPStore.org.current(); if (!fresh) throw new Error("Studio settings aren't available.");
        await BPStore.org.save(kind === "studio" ? W.studioPatch(fresh, r.data) : W.brandPatch(fresh, r.data));
        org = await BPStore.org.current();
      } else if (kind === "payment") {
        const r = W.validatePayment(vals); if (!r.ok) return setFail(kind, r);
        const cfg = (await BPStore.config.getPricing()) || {}; const next = W.paymentPatch(cfg, r.data);
        await BPStore.config.setPricing(next); pricingCfg = next;
      }
      setVals[kind] = {}; setErr[kind] = {}; st.done = true; st.skipped = false;
      if (kind !== "templates" && kind !== "venues" && kind !== "team" && kind !== "connect") BPUI.toast(lbl(kind) + " saved.", { type: "ok" });
      go(S.step + 1);
    } catch (err) { const x = $("#obErr"); if (x) x.textContent = BPUI.friendlyError(err, { action: "save " + lbl(kind).toLowerCase() }); }
  }
  async function createInvite() {
    const vals = readSet(); setVals.team = { role: vals.role };
    const email = String(vals.email || "").trim().toLowerCase(), x = $("#obErr");
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { setErr.team = { email: "Enter the teammate's email." }; setVals.team.email = vals.email; render(); const el = $("#ob_s_email"); if (el) el.focus(); return; }
    try {
      const r = await BPStore.invitations.create(email, vals.role);
      invites.push({ email, role: vals.role, link: location.origin + "/login?invite=" + encodeURIComponent(r.token) });
      setErr.team = {}; render(); BPUI.toast((r.reused ? "Existing invite link ready for " : "Invite link created for ") + email + ".", { type: "ok" });
    } catch (err) { if (x) x.textContent = BPUI.friendlyError(err, { action: "create the invite" }); }
  }
  // server-side progress on organizations.brand.onboarding (admins only; merged into the fresh row)
  function persistProgress(complete) {
    if (!canBill || !org || BPStore.mode() !== "supabase") return;
    clearTimeout(progT);
    progT = setTimeout(async () => {
      try { const fresh = await BPStore.org.current(); if (!fresh) return;
        const prev = W.progressFromOrg(fresh);
        await BPStore.org.save(W.progressPatch(fresh, { step: keyOf(S.step), done: doneKeys(), skipped: skippedKeys(), completed_at: complete ? new Date().toISOString() : prev.completed_at }));
        org = (await BPStore.org.current()) || org;
      } catch (e) { /* progress is a convenience; the local draft still resumes */ }
    }, complete ? 0 : 400);
  }

  // B1: one source for the country-dependent billing labels (same HelmCountry.formMeta as Control Center)
  function billMeta(cc) {
    const H = window.HelmCountry, tid = O.taxIdOf(cc);
    const m = H && H.formMeta ? H.formMeta(cc, tid.label) : { taxIdLabel: tid.label, taxIdExample: tid.eg, regionLabel: cc === "IN" ? "State" : "State / region", regions: [], postalLabel: cc === "IN" ? "PIN code" : "Postal code", postalPlaceholder: "", timezone: "" };
    m.taxIdLabel = tid.label; return m;
  }
  function billLabel(f, meta) {
    return f.key === "gstin" ? meta.taxIdLabel + " (optional)" : f.key === "pin" ? meta.postalLabel : f.key === "state" ? meta.regionLabel : f.label;
  }
  // B1: a country change updates the form IN PLACE (labels, placeholders, state list, phone code);
  // the old full re-render replaced the <select> while it was being used and could leave stale labels.
  function applyBillCountry(cc) {
    cc = O.countryCode(cc); const meta = billMeta(cc), tid = O.taxIdOf(cc);
    O.BILLING_FIELDS.forEach((f) => { const l = $("#ob_b_" + f.key + "_lbl"); if (l) l.textContent = billLabel(f, meta) + (f.required ? " *" : ""); });
    const pin = $("#ob_b_pin"); if (pin) { pin.placeholder = meta.postalPlaceholder || ""; pin.maxLength = cc === "IN" ? 6 : 10; }
    const g = $("#ob_b_gstin"); if (g) g.placeholder = meta.taxIdExample || tid.eg || "";
    const dl = $("#ob_b_state_list"); if (dl) { dl.textContent = ""; meta.regions.forEach((r) => { const o = document.createElement("option"); o.value = r.name; dl.appendChild(o); }); }
    const ph = $("#ob_b_phone"); if (ph) { ph.setAttribute("data-country", cc); const hp = ph.helmPhone; if (hp && !hp.national()) hp.setCountry(cc); }
    const sub = $("#obBill") && $("#obBill").closest(".ob-card"); const sp = sub && sub.querySelector(".sub [data-taxid]"); if (sp) sp.textContent = tid.label;
    ["country", "gstin", "pin", "state"].forEach((k) => { const er = $("#ob_b_" + k + "_err"); if (er) er.textContent = ""; });
  }
  function renderBilling() {
    if (orgErr) return `<div class="ob-card"><h2>Business details</h2><div class="ob-warn">Could not load your studio details. Reload the page to try again.</div><div class="ob-row"><span class="ob-grow"></span><button type="button" class="btn" data-act="goto" data-i="0">Continue</button></div></div>`;
    if (!org) return `<div class="ob-card"><h2>Business details</h2><p class="ob-note">Studio details aren't available for this workspace.</p><div class="ob-row"><span class="ob-grow"></span><button type="button" class="btn primary" data-act="goto" data-i="0">Continue</button></div></div>`;
    const v = Object.assign(O.billingFromOrg(org), bill.values); const e = bill.errors || {};
    if (!canBill) return `<div class="ob-card"><h2>Business details</h2><div class="ob-lock">Only an admin can enter the studio's billing details${billingOk() ? " (already complete)." : ". Ask your admin to complete them in Control Center → Studio details."}</div><div class="ob-row"><span class="ob-grow"></span><button type="button" class="btn primary" data-act="goto" data-i="0">Continue</button></div></div>`;
    const full = { legal_name: 1, line1: 1, line2: 1 };
    const ac = { legal_name: "organization", line1: "address-line1", line2: "address-line2", city: "address-level2", state: "address-level1", pin: "postal-code", phone: "tel", location: "off", gstin: "off" };
    const cc = O.countryCode(v.country), india = cc === "IN", tid = O.taxIdOf(cc), meta = billMeta(cc);
    const label = (f) => billLabel(f, meta);
    const ctry = (BPStore.tax && BPStore.tax.countries()) || [{ iso: "IN", name: "India" }];
    let others = []; try { others = (BPStore.countries() || []).filter((c) => !ctry.some((k) => k.iso === c.iso)); } catch (x) { others = []; }
    const fields = O.BILLING_FIELDS.map((f) => {
      const id = "ob_b_" + f.key, eid = id + "_err", bad = !!e[f.key];
      if (f.type === "country") {
        const opt = (c) => `<option value="${esc(c.iso)}"${c.iso === cc ? " selected" : ""}>${esc(c.name)}</option>`;
        return `<div><label for="${esc(id)}">Country * <span class="ob-note">(sets tax, tax ID and currency)</span></label><select id="${esc(id)}" data-bill="country" data-billcountry="1" data-picker="search" aria-describedby="${esc(eid)}">`
          + ctry.map(opt).join("") + (others.length ? `<optgroup label="Other countries (custom tax)">${others.map(opt).join("")}</optgroup>` : "")
          + `</select><div class="ob-err" id="${esc(eid)}">${esc(e[f.key] || "")}</div></div>`;
      }
      // B1: phone follows the country (data-country, only while no number is typed); state gets the
      // country's states / emirates; postal + tax-ID placeholders per country (HelmCountry.formMeta)
      const im = f.key === "pin" ? ' inputmode="numeric"' : f.key === "phone" ? ` inputmode="tel" type="tel" data-country="${esc(cc)}"` : f.key === "state" ? ' list="ob_b_state_list"' : "";
      const ph = f.key === "pin" ? meta.postalPlaceholder : f.key === "gstin" ? (meta.taxIdExample || tid.eg || "") : "";
      return `<div class="${full[f.key] ? "full" : ""}"><label for="${esc(id)}" id="${esc(id)}_lbl">${esc(label(f))}${f.required ? " *" : ""}</label>`
        + `<input id="${esc(id)}" data-bill="${esc(f.key)}" maxlength="${Number(f.key === "gstin" ? 30 : f.key === "pin" && india ? 6 : f.max)}" autocomplete="${esc(ac[f.key])}" value="${esc(v[f.key] || "")}" placeholder="${esc(ph)}"${im}${f.required ? ' aria-required="true"' : ""} aria-invalid="${bad}" aria-describedby="${esc(eid)}">`
        + (f.key === "state" ? `<datalist id="ob_b_state_list">${meta.regions.map((r) => `<option value="${esc(r.name)}"></option>`).join("")}</datalist>` : "")
        + `<div class="ob-err" id="${esc(eid)}">${esc(e[f.key] || "")}</div></div>`;
    }).join("");
    return `<div class="ob-card"><h2>Business details</h2><p class="sub">Used on your quotations and invoices. Fields marked * are required to finish setup; <span data-taxid="1">${esc(tid.label)}</span> is optional. You can edit these later in Control Center → Studio details.</p>`
      + `<form id="obBill" novalidate><div class="ob-bf">${fields}</div><div id="obErr" class="ob-err" role="alert"></div>`
      + `<div class="ob-row"><span class="ob-grow"></span><button type="submit" class="btn primary" data-act="billsave">Save &amp; continue</button></div></form></div>`;
  }
  async function saveBilling() {
    const form = $("#obBill"); if (!form) return;
    const vals = {}; form.querySelectorAll("[data-bill]").forEach((el) => { vals[el.dataset.bill] = el.value; });
    const r = O.validateBilling(vals); bill = { values: vals, errors: r.errors };
    if (!r.ok) {
      render(); const first = O.BILLING_FIELDS.find((f) => r.errors[f.key]); const el = first && $("#ob_b_" + first.key); if (el) el.focus();
      const live = $("#obLive"); if (live) live.textContent = "Please fix " + Object.keys(r.errors).length + " field(s).";
      return;
    }
    try {
      const fresh = await BPStore.org.current(); if (!fresh) throw new Error("Studio settings aren't available.");
      await BPStore.org.save(O.billingPatch(fresh, r.data));
      await syncTaxCountry(r.data.country);
      org = await BPStore.org.current(); bill = { values: {}, errors: {} };
      BPUI.toast("Business details saved.", { type: "ok" }); const cd = studioDefaults(r.data.country, r.data.state); setVals.studio = Object.assign({}, setVals.studio || {}, cd.currency ? { currency: cd.currency } : {}, cd.timezone ? { timezone: cd.timezone } : {}); go(0);
    } catch (err) { const x = $("#obErr"); if (x) x.textContent = BPUI.friendlyError(err, { action: "save your business details" }); }
  }

  // 0079: the studio's country drives the tax (name, default rate, currency) used on new
  // quotes. Only when the country actually changes; India with no config stays as is.
  async function syncTaxCountry(cc) {
    try {
      const T = BPStore.tax; if (!T) return; cc = T.code(cc);
      const cfg = (await BPStore.config.getPricing()) || {};
      if (T.code(cfg.taxCountry || "IN") === cc) return;
      const p = T.profile(cc);
      const next = Object.assign({}, cfg, { taxCountry: cc, currency: p.known ? p.currency : (cfg.currency || "INR") });
      if (p.rate != null) next.gstPct = p.rate;
      await BPStore.config.setPricing(next);
    } catch (x) { /* pricing is admin-only; the studio can set the tax in Control Center */ }
  }
  function header(kind) { return `<h2>${esc(O.KINDS[kind].label)}</h2><p class="sub">${esc(INTRO[kind])}</p>`; }

  function renderInput(kind) {
    const st = S.steps[kind], def = O.KINDS[kind];
    // smart column-mapping importer (smart-import.js) when it is on the page; the built-in CSV path stays as the fallback
    const smart = window.HelmImport && typeof window.HelmImport.open === "function" && W.IMPORT_ENTITY[kind]
      ? `<button type="button" class="btn" data-act="smartimport">Smart import from Excel / CSV</button>` : "";
    const tabs = `<div class="ob-tabs" role="group" aria-label="How do you want to add them?"><button type="button" data-act="mode" data-m="manual" aria-pressed="${st.mode === "manual"}">Type them in</button><button type="button" data-act="mode" data-m="csv" aria-pressed="${st.mode === "csv"}">Import from Excel / CSV</button>${smart}</div>`;
    let inner;
    if (st.mode === "csv") {
      inner = `<div class="ob-row"><button type="button" class="btn" data-act="template" data-fmt="xlsx">Download Excel template</button><button type="button" class="btn" data-act="template" data-fmt="csv">CSV template</button>`
        + `<label class="btn" for="obFile">Choose a file (.xlsx, .xls, .csv)</label><input type="file" id="obFile" accept=".xlsx,.xls,.csv,.txt,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden>`
        + `<span class="ob-note">${esc(st.fileName || "or paste below")}</span></div>`
        + `<label class="ob-note" for="obText">The first sheet of an Excel file is read (values only, formulas are not run). Or paste CSV (first row = column names). Up to ${Number(O.MAX_ROWS)} rows.</label>`
        + `<textarea id="obText" spellcheck="false" aria-describedby="obHint">${esc(st.text)}</textarea>`
        + `<p class="ob-note" id="obHint">Columns we understand: ${def.fields.map((f) => esc(f.label) + (f.required ? "*" : "")).join(", ")}. Prices may include ₹ and Indian commas (1,25,000).</p>`;
    } else {
      inner = `<div class="ob-scroll"><table><thead><tr>${def.fields.map((f) => `<th scope="col">${esc(f.label)}${f.required ? "*" : ""}</th>`).join("")}<th><span class="sr-only">Remove</span></th></tr></thead><tbody>`
        + st.manual.map((r, ri) => `<tr>${def.fields.map((f) => `<td>${manualCell(kind, f, r, ri)}</td>`).join("")}<td><button type="button" class="btn" data-act="delrow" data-r="${Number(ri)}" aria-label="Remove row ${Number(ri) + 1}">×</button></td></tr>`).join("")
        + `</tbody></table></div><div class="ob-row"><button type="button" class="btn" data-act="addrow">+ Add row</button></div>`;
    }
    const ready = st.mode === "csv" ? st.text.trim().length > 0 : st.manual.some((r) => Object.values(r).some((v) => String(v || "").trim()));
    return `<div class="ob-card">${header(kind)}${tabs}${inner}<div id="obErr" class="ob-err" role="alert"></div>`
      + `<div class="ob-row">${navBack()}<span class="ob-grow"></span>`
      + (OPTIONAL[kind] ? '<button type="button" class="btn" data-act="skip">Skip for now</button>' : "")
      + `<button type="button" class="btn primary" data-act="review"${ready ? "" : ' data-empty="1"'}>Review before importing</button></div></div>`;
  }
  function manualCell(kind, f, r, ri) {
    const v = r[f.key] == null ? "" : r[f.key]; const base = `data-r="${Number(ri)}" data-f="${esc(f.key)}" aria-label="${esc(f.label)} row ${Number(ri) + 1}"`;
    if (f.type === "diet") return `<select ${base}>${["", "veg", "nonveg", "special"].map((o) => `<option value="${esc(o)}"${o === v ? " selected" : ""}>${esc(o || "veg (default)")}</option>`).join("")}</select>`;
    if (f.type === "ratetype") return `<select ${base}>${["", "chair", "plate"].map((o) => `<option value="${esc(o)}"${o === v ? " selected" : ""}>${esc(o || "plate (default)")}</option>`).join("")}</select>`;
    const im = f.type === "price" || f.type === "qty" ? ' inputmode="decimal"' : (f.type === "phone" ? ' inputmode="tel"' : "");
    return `<input type="text" maxlength="${f.type === "text" ? 200 : 40}" value="${esc(v)}" ${base}${im} autocomplete="off">`;
  }

  function renderMap(kind) {
    const st = S.steps[kind], def = O.KINDS[kind]; const table = tableOf(kind); const hdr = table[0] || [];
    const m = currentMapping(kind, table);
    const warn = (st.warnings || []).map((w) => `<div class="ob-warn">${esc(w)}</div>`).join("");
    const rowsN = Math.max(0, table.length - 1);
    return `<div class="ob-card">${header(kind)}${warn}<p class="ob-note">We found ${Number(rowsN)} data row(s) and ${Number(hdr.length)} column(s). Check which column is which.</p><div class="ob-map">`
      + def.fields.map((f) => `<label for="map_${esc(f.key)}">${esc(f.label)}${f.required ? " *" : ""}</label><select id="map_${esc(f.key)}" data-map="${esc(f.key)}"><option value="-1">— not in my file —</option>${hdr.map((h, i) => `<option value="${Number(i)}"${m[f.key] === i ? " selected" : ""}>${esc(O.cleanText(h) || "Column " + (i + 1))}</option>`).join("")}</select>`).join("")
      + `</div><div id="obErr" class="ob-err" role="alert"></div><div class="ob-row"><button type="button" class="btn" data-act="stage" data-s="input">Back</button><span class="ob-grow"></span><button type="button" class="btn primary" data-act="preview">Continue to preview</button></div></div>`;
  }

  function renderPreview(kind) {
    const pv = previews[kind]; const st = S.steps[kind];
    if (!pv) return `<div class="ob-card"><p class="ob-note">Checking your data…</p></div>`;
    const s = pv.summary;
    const chips = `<div class="ob-chips" role="status"><span class="ob-chip ok">${Number(s.new)} new</span><span class="ob-chip warn">${Number(s.dupExisting)} already exist</span><span class="ob-chip warn">${Number(s.dupFile)} repeated in file</span><span class="ob-chip bad">${Number(s.invalid)} invalid</span></div>`;
    const rows = pv.rows.map((r) => {
      let stat, act = "";
      if (r.status === "new") stat = '<span class="ob-st new">New</span>';
      else if (r.status === "invalid") stat = `<span class="ob-st bad">Invalid</span><div class="ob-err">${esc(r.errors.join("; "))}</div>`;
      else if (r.status === "dup-file") { stat = `<span class="ob-st dup">Repeat of line ${Number(r.dupOfLine)}</span>`; act = "Skipped"; }
      else {
        stat = `<span class="ob-st dup">Exists: ${esc(r.matchName)}</span>`;
        act = `<select data-line="${Number(r.line)}" aria-label="What to do with line ${Number(r.line)}"><option value="skip"${r.action === "skip" ? " selected" : ""}>Skip (keep existing)</option>`
          + (r.mergeable ? `<option value="merge"${r.action === "merge" ? " selected" : ""}>Add quantity to existing</option>` : "")
          + (r.updatable ? `<option value="update"${r.action === "update" ? " selected" : ""}>Update existing (exact name)</option>` : "")
          + `<option value="rename"${r.action === "rename" ? " selected" : ""}>Keep both (rename)</option></select>`
          + (r.action === "rename" ? `<div class="ob-note">Will be saved as "${esc(r.renamedTo)}"</div>` : "");
      }
      const cells = O.KINDS[kind].fields.map((f) => `<td>${esc(r.data[f.key] == null ? "" : r.data[f.key])}</td>`).join("");
      return `<tr><td>${Number(r.line)}</td><td>${stat}</td>${cells}<td>${act}</td></tr>`;
    }).join("");
    const nWrite = s.willAdd + s.willMerge;
    return `<div class="ob-card">${header(kind)}${chips}`
      + (pv.truncated ? `<div class="ob-warn">Only the first ${Number(O.MAX_ROWS)} rows are shown and will be imported. Split larger files and import them in parts.</div>` : "")
      + ((st.warnings || []).map((w) => `<div class="ob-warn">${esc(w)}</div>`).join(""))
      + `<p class="ob-note">Nothing has been saved yet. ${Number(nWrite)} row(s) will be written: ${Number(s.willAdd)} added, ${Number(s.willMerge)} updated/merged; existing rows are never deleted; ${Number(s.willSkip)} skipped.</p>`
      + `<div class="ob-scroll"><table><thead><tr><th>Line</th><th>Status</th>${O.KINDS[kind].fields.map((f) => `<th>${esc(f.label)}</th>`).join("")}<th>If it already exists</th></tr></thead><tbody>${rows}</tbody></table></div>`
      + `<div class="ob-bar" id="obBarWrap" hidden><i id="obBar"></i></div><div id="obErr" class="ob-err" role="alert"></div>`
      + `<div class="ob-row"><button type="button" class="btn" data-act="stage" data-s="${st.mode === "csv" ? "map" : "input"}">Back</button><span class="ob-grow"></span>`
      + `<button type="button" class="btn primary" data-act="import"${nWrite ? "" : " disabled"}>Import ${Number(nWrite)} row(s)</button></div></div>`;
  }

  // every ledger row of this batch that was undone (any status)
  function undoneCount(st, kind) {
    return Object.keys(ledger.entries).filter((k) => st.batchKey && k.indexOf(st.batchKey + ":" + kind + ":") === 0 && ledger.entries[k] && ledger.entries[k].undone).length;
  }
  function renderResult(kind) {
    const st = S.steps[kind]; const c = counts(kind); const pv = previews[kind];
    const errs = Object.keys(ledger.entries).filter((k) => k.indexOf(st.batchKey + ":" + kind + ":") === 0 && ledger.entries[k].status === "error").map((k) => ledger.entries[k]);
    const undone = undoneCount(st, kind);
    return `<div class="ob-card">${header(kind)}<div class="ob-chips" role="status"><span class="ob-chip ok">${Number(c.ok)} added${undone ? " (" + Number(undone) + " undone)" : ""}</span><span class="ob-chip ok">${Number(c.merged)} merged</span><span class="ob-chip ${c.error ? "bad" : ""}">${Number(c.error)} failed</span></div>`
      + (errs.length ? `<div class="ob-warn"><b>Some rows were not saved.</b> Nothing was lost; you can retry just these.<ul>${errs.slice(0, 50).map((e) => `<li>Line ${Number(e.line)} — ${esc(e.name)}: ${esc(e.error)}</li>`).join("")}</ul></div>` : "")
      + `<div id="obErr" class="ob-err" role="alert"></div><div class="ob-row">`
      + (errs.length ? '<button type="button" class="btn primary" data-act="retry">Retry failed rows</button>' : "")
      + (c.ok - undone > 0 ? '<button type="button" class="btn" data-act="undo">Undo this import</button>' : "")
      + `<span class="ob-grow"></span><button type="button" class="btn" data-act="stage" data-s="input">Add more</button><button type="button" class="btn primary" data-act="next">${S.step === KEYS.length - 1 ? "Finish" : "Continue"}</button></div>`
      + (c.merged ? '<p class="ob-note">Undo removes the rows this import added. Quantities that were added to existing items are not reversed; adjust them in Inventory if needed.</p>' : "")
      + (pv ? "" : "") + `</div>`;
  }

  function renderFinish() {
    if (org && !billingOk()) return `<div class="ob-card"><h2>Almost there</h2><div class="ob-warn" role="alert">Your business details are incomplete (missing: ${esc(O.billingMissing(org).join(", "))}). They are required to finish setup.</div><div class="ob-row"><span class="ob-grow"></span><button type="button" class="btn primary" data-act="goto" data-i="${BILL}">${canBill ? "Complete business details" : "View business details"}</button></div></div>`;
    if (org && !studioOk()) return `<div class="ob-card"><h2>Almost there</h2><div class="ob-warn" role="alert">Your studio details (name, currency, timezone) are required to finish setup.</div><div class="ob-row"><span class="ob-grow"></span><button type="button" class="btn primary" data-act="goto" data-i="${idxOf("studio")}">${canBill ? "Complete studio details" : "View studio details"}</button></div></div>`;
    const lines = KEYS.map((k) => { const c = counts(k); const st = S.steps[k]; const st2 = st.skipped && !st.done ? "skipped" : (st.done ? (isSet(k) ? "saved" : !st.batchKey ? "imported" : `${Number(c.ok)} added${undoneCount(st, k) ? " (" + undoneCount(st, k) + " undone)" : ""}, ${Number(c.merged)} merged`) : "not done");
      return `<li><b>${esc(lbl(k))}</b> — ${esc(st2)}</li>`; }).join("");
    return `<div class="ob-card"><h2>🎉 You're set up</h2><p class="sub">Here is what you set up. Skipped steps can be finished any time from Control Center.</p><ul>${lines}</ul>`
      + `<div class="ob-row"><a class="btn" href="inventory.html">Open Inventory</a><a class="btn" href="vendors.html">Open Vendors</a><a class="btn" href="staff.html">Open Staff</a><a class="btn" href="control.html#pricing">Open Control Center</a>`
      + `<span class="ob-grow"></span><button type="button" class="btn" data-act="reset">Clear saved draft</button><a class="btn primary" href="dashboard.html">Go to dashboard</a></div></div>`;
  }

  /* ---------- navigation + history ---------- */
  function studioOk() { return !org || S.steps.studio.done || W.validateStudio(W.studioFromOrg(org)).ok; }
  function go(step, stage, push) {
    S.step = Math.max(BILL, Math.min(KEYS.length, step));
    if (stage && S.step >= 0 && S.step < KEYS.length) S.steps[KEYS[S.step]].stage = stage;
    if (push !== false) { try { history.pushState({ onb: 1, step: S.step, stage: S.step >= 0 && S.step < KEYS.length ? S.steps[KEYS[S.step]].stage : "finish" }, "", location.pathname + location.search + "#step-" + keyOf(S.step)); } catch (e) {} }
    if (KEYS[S.step] === "templates") loadTplCounts();
    saveDraft(); render(); persistProgress(S.step === KEYS.length && billingOk() && studioOk()); const h = $("#obRoot h2"); if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: false }); }
  }
  window.addEventListener("popstate", (e) => {
    const s = e.state; if (!S || !s || !s.onb) return;
    S.step = Math.max(BILL, Math.min(KEYS.length, s.step | 0));
    if (S.step >= 0 && S.step < KEYS.length) { const st = S.steps[KEYS[S.step]]; st.stage = ["input", "map", "preview", "result"].includes(s.stage) ? s.stage : "input"; if (st.stage === "result" && !st.batchKey) st.stage = "input"; if (st.stage === "preview" || st.stage === "map") prepare(KEYS[S.step]).then(render); }
    saveDraft(); render();
  });

  async function prepare(kind) {                 // build the preview model (fetches existing records)
    const st = S.steps[kind]; const table = tableOf(kind);
    try { existingCache[kind] = await loadExisting(kind); } catch (e) { existingCache[kind] = null; throw e; }
    const mapping = currentMapping(kind, table);
    previews[kind] = O.buildPreview(kind, table, mapping, existingCache[kind], st.actions);
    return previews[kind];
  }

  /* ---------- actions ---------- */
  async function act(kind, a, el) {
    const st = S.steps[kind] || {};
    const err = (m) => { const e = $("#obErr"); if (e) e.textContent = m || ""; };
    if (a === "review" || a === "preview") {
      if (a === "review") {
        if (st.mode === "csv") {
          if (!st.text.trim()) return err("Paste some CSV or choose a file first.");
          const p = O.parseCSV(st.text); st.warnings = p.warnings.slice(); if (p.truncated) st.warnings.push("Only the first " + O.MAX_ROWS + " rows will be used.");
          if (p.rows.length < 2) return err("We need a header row and at least one data row.");
          st.mapping = O.mapHeaders(p.rows[0], kind).mapping; st.stage = "map"; saveDraft(); return render();
        }
        if (!st.manual.some((r) => Object.values(r).some((v) => String(v || "").trim()))) return err("Fill in at least one row first.");
      } else {
        const table = tableOf(kind); const m = O.sanitizeMapping(st.mapping, kind, (table[0] || []).length); st.mapping = m;
        const miss = O.KINDS[kind].fields.filter((f) => f.required && m[f.key] < 0).map((f) => f.label);
        if (miss.length) return err("Pick a column for: " + miss.join(", ") + ".");
      }
      try { await prepare(kind); } catch (e) { return err(BPUI.friendlyError(e, { action: "check your existing records" })); }
      const table = tableOf(kind); const hash = hashOf([table, currentMapping(kind, table)]);
      if (hash !== st.contentHash || !st.batchKey) { st.contentHash = hash; st.batchKey = O.newBatchKey(); }   // same data => same key => resume-safe
      st.stage = "preview"; return go(S.step, "preview");
    }
    if (a === "import" || a === "retry") {
      if (busy) return; busy = true;
      try {
        const pv = previews[kind] || await prepare(kind);
        invCache = null; const bar = $("#obBar"), wrap = $("#obBarWrap"); if (wrap) wrap.hidden = false;
        $("#obLive").textContent = "Importing…";
        const res = await O.applyBatch({ kind, rows: pv.rows, batchKey: st.batchKey, ledger, api: adapter,
          onProgress: (d, t) => { if (bar) bar.style.width = Math.round(d / Math.max(1, t) * 100) + "%"; }, save: saveLedger });
        const c = res.counts; st.done = c.error === 0; st.stage = "result";
        BPUI.toast(c.error ? `${c.ok + c.merged} saved, ${c.error} failed — see the list.` : `${c.ok + c.merged} saved.`, { type: c.error ? "err" : "ok" });
        go(S.step, "result");
      } catch (e) { BPUI.toast(BPUI.friendlyError(e, { action: "import" }), { type: "err" }); }
      finally { busy = false; }
      return;
    }
    if (a === "undo") {
      if (busy) return;
      if (!(await BPUI.confirm("Remove the rows this import added? They will be deactivated (not permanently deleted). Existing records are not touched.", { title: "Undo this import?", okLabel: "Undo import", danger: true }))) return;
      busy = true;
      try { const r = await O.undoBatch({ kind, batchKey: st.batchKey, ledger, api: adapter, save: saveLedger });
        BPUI.toast(r.failed ? `${r.undone} undone, ${r.failed} could not be undone.` : `${r.undone} row(s) removed.`, { type: r.failed ? "err" : "ok" });
        st.done = false; render(); }
      catch (e) { BPUI.toast(BPUI.friendlyError(e, { action: "undo the import" }), { type: "err" }); }
      finally { busy = false; }
      return;
    }
  }

  function onClick(ev) {
    const b = ev.target.closest("[data-act]"); if (!b || !S) return;
    const a = b.dataset.act, kind = KEYS[S.step], st = kind ? S.steps[kind] : null;
    if (a === "goto") return go(Number(b.dataset.i));
    if (a === "prev") return go(S.step - 1);
    if (a === "billsave") { ev.preventDefault(); return BPUI.guard(b, () => saveBilling(), { busyLabel: "Saving…" }); }
    if (a === "next") { if (st) st.skipped = false; return go(S.step + 1); }
    if (a === "skip") { if (st) st.skipped = true; return go(S.step + 1); }
    if (a === "setsave") { ev.preventDefault(); return BPUI.guard(b, () => saveSetting(kind), { busyLabel: "Saving…" }); }
    if (a === "invite") return BPUI.guard(b, () => createInvite(), { busyLabel: "Creating…" });
    if (a === "invcopy") { const x = invites[Number(b.dataset.i)]; if (x) { try { navigator.clipboard.writeText(x.link).then(() => BPUI.toast("Link copied.", { type: "ok" }), () => {}); } catch (e) {} } return; }
    if (a === "setdefaults") { const cd = studioDefaults(); setVals.studio = Object.assign(readSet(), { currency: cd.currency, timezone: cd.timezone }); return render(); }
    if (a === "smartimport") {
      try { window.HelmImport.open({ entity: W.IMPORT_ENTITY[kind], onDone: (res) => { st.done = true; st.skipped = false; saveDraft(); BPUI.toast("Import finished.", { type: "ok" }); go(S.step + 1); } }); }
      catch (e) { BPUI.toast("Smart import isn't available right now — use “Import from Excel / CSV”.", { type: "err" }); st.mode = "csv"; render(); }
      return;
    }
    if (a === "mode") { st.mode = b.dataset.m === "csv" ? "csv" : "manual"; saveDraft(); return render(); }
    if (a === "stage") { st.stage = b.dataset.s; if (st.stage === "map" || st.stage === "input") return go(S.step, st.stage); return go(S.step, st.stage); }
    if (a === "addrow") { if (st.manual.length >= O.MAX_ROWS) return BPUI.toast("Row limit reached; use CSV import for more.", { type: "info" }); st.manual.push({}); saveDraft(); return render(); }
    if (a === "delrow") { st.manual.splice(Number(b.dataset.r), 1); if (!st.manual.length) st.manual.push({}); saveDraft(); return render(); }
    if (a === "template") return downloadTemplate(kind, b.dataset.fmt);
    if (a === "reset") { try { localStorage.removeItem(LS_DRAFT + uid); } catch (e) {} S = freshState(); previews = {}; BPUI.toast("Saved draft cleared. Data already imported is untouched.", { type: "ok" }); return go(0); }
    if (["review", "preview", "import", "retry", "undo"].includes(a)) return BPUI.guard(b, () => act(kind, a, b), { busyLabel: a === "import" || a === "retry" ? "Importing…" : "Working…" });
  }
  function downloadTemplate(kind, fmt) {
    const xl = fmt === "xlsx" && window.HelmXlsx;
    const blob = xl ? new Blob([window.HelmXlsx.buildXlsx(O.KINDS[kind].template, O.KINDS[kind].label)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      : new Blob(["﻿" + O.templateCSV(kind)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "helm-" + kind + "-template." + (xl ? "xlsx" : "csv");
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function onInput(ev) {
    if (!S) return;
    if (ev.target && ev.target.dataset && ev.target.dataset.billcountry) {
      const form = $("#obBill"); const vals = {}; if (form) form.querySelectorAll("[data-bill]").forEach((el) => { vals[el.dataset.bill] = el.value; });
      bill = { values: vals, errors: {} }; applyBillCountry(ev.target.value); return;
    }
    if (ev.target && ev.target.dataset && ev.target.dataset.pick) { const tx = $("#ob_s_" + ev.target.dataset.pick); if (tx) tx.value = ev.target.value; return; }
    const kind = KEYS[S.step]; if (!kind) return; const st = S.steps[kind], t = ev.target;
    if (t.id === "obText") { st.text = t.value.slice(0, O.MAX_FILE_BYTES); st.fileName = ""; st.mapping = null; saveDraft(); }
    else if (t.dataset && t.dataset.r !== undefined && t.dataset.f) { const r = st.manual[Number(t.dataset.r)]; if (r) { r[t.dataset.f] = t.value; saveDraft(); } }
  }
  function onChange(ev) {
    if (!S) return;
    if (ev.target && ev.target.dataset && ev.target.dataset.billcountry) {
      const form = $("#obBill"); const vals = {}; if (form) form.querySelectorAll("[data-bill]").forEach((el) => { vals[el.dataset.bill] = el.value; });
      bill = { values: vals, errors: {} }; applyBillCountry(ev.target.value); return;
    }
    const kind = KEYS[S.step]; if (!kind) return; const st = S.steps[kind], t = ev.target;
    if (t.id === "obFile") return readFile(kind, t.files && t.files[0]);
    if (t.dataset && t.dataset.map) { st.mapping = st.mapping || {}; st.mapping[t.dataset.map] = Number(t.value); saveDraft(); return; }
    if (t.dataset && t.dataset.line && previews[kind]) {
      const line = Number(t.dataset.line); st.actions[line] = t.value; saveDraft();
      previews[kind] = O.buildPreview(kind, tableOf(kind), currentMapping(kind, tableOf(kind)), existingCache[kind] || [], st.actions); render();
      const again = $('select[data-line="' + line + '"]'); if (again) again.focus();
    }
  }
  function showXlsHelp(msg) {
    const x = $("#obErr"); if (!x) return BPUI.toast(msg, { type: "err" });
    x.textContent = "";
    const p = document.createElement("div"); p.textContent = msg; x.appendChild(p);
    const b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.id = "obXlsTpl";
    b.dataset.act = "template"; b.dataset.fmt = "xlsx"; b.textContent = "Download template (.xlsx)"; x.appendChild(b);
  }
  function readFile(kind, f) {
    const st = S.steps[kind]; if (!f) return;
    if (f.size > O.MAX_FILE_BYTES) return BPUI.toast("That file is over 2 MB. Split it into smaller files.", { type: "err" });
    const fr = new FileReader();
    fr.onerror = () => BPUI.toast("Could not read that file.", { type: "err" });
    fr.onload = async () => {
      const X = window.HelmXlsx; const kindF = X ? X.kindOf(new Uint8Array(fr.result)) : "text";
      if (kindF !== "text") {
        try { const r = await X.readXlsx(fr.result); st.text = X.toCSV(r.rows); st.fileName = f.name.slice(0, 80); st.mapping = null;
          st.warnings = r.sheetNames.length > 1 ? ["Only the first sheet (" + r.sheetNames[0] + ") was read."] : []; saveDraft(); render(); }
        catch (e) {
          // R4: legacy .xls stays rejected (security) - say so plainly, with a one-click template right there
          if (e && e.code === "xls_legacy") return showXlsHelp(e.message);
          BPUI.toast((e && e.message) || "Could not read that Excel file.", { type: "err" });
        }
        return;
      }
      try { const d = O.decodeBytes(fr.result); st.text = d.text; st.fileName = f.name.slice(0, 80); st.mapping = null; st.warnings = d.warnings; saveDraft(); render(); }
      catch (e) { BPUI.toast("Could not decode that file. Save it as UTF-8 CSV and try again.", { type: "err" }); }
    };
    fr.readAsArrayBuffer(f);
  }

  /* ---------- boot ---------- */
  BPUI.boot(async () => {
    CSS && typeof window.__helmAdoptCss === "function" && window.__helmAdoptCss(document, CSS);
    await BPStore.init();
    if (BPStore.auth.enabled() && BPStore.auth.required() && !BPStore.auth.user()) { location.replace("login.html?next=" + encodeURIComponent("onboarding.html")); return; }
    // 0177: a free-trial studio never uses the full studio setup - its 2-step welcome is on the dashboard
    if (BPStore.trialOrg && BPStore.trialOrg.inTrial && (await BPStore.trialOrg.inTrial())) { location.replace("dashboard.html"); return; }
    const u = BPStore.auth.user(); uid = (u && u.id) ? String(u.id).replace(/[^\w-]/g, "").slice(0, 40) : "anon";
    await computePerms();
    try { org = await BPStore.org.current(); } catch (e) { org = null; orgErr = e; }
    canBill = BPStore.mode() !== "supabase" || (await BPStore.auth.role()) === "admin";
    if (!KEYS.some((k) => k !== "templates" && perms[k]) && (billingOk() || !canBill)) { $("#obRoot").innerHTML = '<div class="ob-lock">Your role cannot add menu, pricing, inventory, vendors or staff. Ask an admin to run this setup.</div>'; $("#app").hidden = false; return; }
    loadLedger();
    const d = loadDraft(); S = d.s;
    // resume: server progress (any device) when there is no local draft; done/skipped always merged
    serverProg = W.progressFromOrg(org);
    KEYS.forEach((k) => { if (serverProg.done.indexOf(k) >= 0) S.steps[k].done = true; else if (serverProg.skipped.indexOf(k) >= 0) S.steps[k].skipped = true; });
    if (!d.resumed && serverProg.step) S.step = idxOf(serverProg.step);
    if (canBill && BPStore.mode() === "supabase") { try { pricingCfg = (await BPStore.config.getPricing()) || {}; } catch (e) { pricingCfg = {}; } }
    const hk = W.stepFromHash(location.hash || "");
    if (hk && hk !== "billing" && hk !== "finish" && perms[hk]) { S.step = idxOf(hk); if (/^#s\d$/.test(location.hash) && !isSet(hk)) { S.steps[hk].mode = "csv"; S.steps[hk].stage = "input"; } }
    else if (hk) S.step = idxOf(hk);
    if (org && canBill && !billingOk()) S.step = BILL;
    else if (S.step >= 0 && !perms[KEYS[S.step]] && S.step < KEYS.length) S.step = Math.max(0, KEYS.findIndex((k) => perms[k]));
    // after a refresh in the middle of preview/result, rebuild what the screen needs
    const cur = KEYS[S.step];
    if (cur && S.steps[cur].stage === "preview") { try { await prepare(cur); } catch (e) { S.steps[cur].stage = "input"; } }
    if (cur && S.steps[cur].stage === "map" && S.steps[cur].mode !== "csv") S.steps[cur].stage = "input";
    if (cur && S.steps[cur].stage === "result" && !S.steps[cur].batchKey) S.steps[cur].stage = "input";
    document.addEventListener("submit", (ev) => {
      if (ev.target && ev.target.id === "obBill") { ev.preventDefault(); const b = $('[data-act="billsave"]'); BPUI.guard(b, () => saveBilling(), { busyLabel: "Saving…" }); }
      if (ev.target && ev.target.id === "obSet") { ev.preventDefault(); const b = $('[data-act="setsave"]'); BPUI.guard(b, () => saveSetting(KEYS[S.step]), { busyLabel: "Saving…" }); }
    });
    document.addEventListener("click", onClick); document.addEventListener("input", onInput); document.addEventListener("change", onChange);
    try { history.replaceState({ onb: 1, step: S.step, stage: cur ? S.steps[cur].stage : "finish" }, "", location.pathname + location.search + "#step-" + keyOf(S.step)); } catch (e) {}
    if (KEYS[S.step] === "templates") loadTplCounts();
    $("#app").hidden = false; render();
    if (d.resumed) BPUI.toast("Welcome back — your draft was restored.", { type: "info" });
  });
})();
