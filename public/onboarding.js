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
  const KEYS = ["menu", "pricing", "inventory", "vendors", "staff"];
  const OPTIONAL = { vendors: true, staff: true };
  const INTRO = {
    menu: "Add the dishes you serve. They appear in the menu picker on every quote. Dishes with the same name as an existing one are skipped by default.",
    pricing: "Your per-chair and per-plate rates. These feed live quote pricing. Existing rates are never changed here; duplicates are skipped by default.",
    inventory: "Your stock: item, quantity and (optionally) unit cost. If an item already exists you can add the quantity to it instead of skipping.",
    vendors: "Optional. Your regular partners (caterers, decorators, sound...). You can add more later from the Vendors page.",
    staff: "Optional. Your team members and crew. You can add more later from the Staff page.",
  };
  const LS_DRAFT = "helm_onb_draft_v1:", LS_LEDGER = "helm_onb_ledger_v1:";
  let uid = "anon", S = null, ledger = { entries: {} }, perms = {}, busy = false, existingCache = {}, previews = {}, invCache = null;

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
    ".ob-bar{height:8px;border-radius:99px;background:var(--line-2,#f1ede7);overflow:hidden}.ob-bar i{display:block;height:100%;background:var(--accent,#6d28d9);width:0}",
    "@media (max-width:640px){.ob-card{padding:12px}.ob-map{grid-template-columns:1fr}.ob-row .btn{flex:1 1 100%}}",
  ].join("\n");

  /* ---------- state + draft ---------- */
  function blankStep() { return { mode: "manual", text: "", fileName: "", manual: [{}, {}, {}, {}, {}], mapping: null, actions: {}, batchKey: null, contentHash: null, stage: "input", done: false, skipped: false }; }
  function freshState() { const s = { step: 0, steps: {} }; KEYS.forEach((k) => { s.steps[k] = blankStep(); }); return s; }
  function loadDraft() {
    const d = O.parseDraft(lsGet(LS_DRAFT + uid)); const s = freshState(); if (!d) return { s, resumed: false };
    s.step = Math.max(0, Math.min(KEYS.length, d.step | 0));
    KEYS.forEach((k) => { if (d.steps[k]) Object.assign(s.steps[k], d.steps[k]); if (!Array.isArray(s.steps[k].manual) || !s.steps[k].manual.length) s.steps[k].manual = [{}, {}, {}]; });
    return { s, resumed: true };
  }
  let saveT = null, saveWarned = false;
  function saveDraft() { clearTimeout(saveT); saveT = setTimeout(() => { if (!lsSet(LS_DRAFT + uid, O.serializeDraft(S)) && !saveWarned) { saveWarned = true; BPUI.toast("Could not autosave your progress in this browser (storage full or blocked).", { type: "info" }); } }, 300); }
  function loadLedger() { try { const l = JSON.parse(lsGet(LS_LEDGER + uid) || "null"); if (l && l.entries) ledger = l; } catch (e) {} }
  function saveLedger() { lsSet(LS_LEDGER + uid, JSON.stringify(ledger)); }

  /* ---------- permissions ---------- */
  async function computePerms() {
    const sb = BPStore.mode() === "supabase"; const role = sb ? await BPStore.auth.role() : "admin";
    for (const k of KEYS) {
      if (!sb || role === "admin") { perms[k] = true; continue; }
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
  function render() {
    const root = $("#obRoot"); if (!root) return;
    const stepsNav = `<ol class="ob-steps" aria-label="Setup steps">` + KEYS.map((k, i) => {
      const st = S.steps[k]; const cls = st.done || st.skipped ? "done" : "";
      return `<li class="${esc(cls)}"><button type="button" data-act="goto" data-i="${Number(i)}"${S.step === i ? ' aria-current="step"' : ""}><span class="n">${st.done ? "✓" : Number(i) + 1}</span>${esc(O.KINDS[k].label)}${OPTIONAL[k] ? " (optional)" : ""}</button></li>`;
    }).join("") + `<li class="${S.step === KEYS.length ? "" : ""}"><button type="button" data-act="goto" data-i="${KEYS.length}"${S.step === KEYS.length ? ' aria-current="step"' : ""}><span class="n">★</span>Finish</button></li></ol>`;
    let body = "";
    if (S.step >= KEYS.length) body = renderFinish();
    else {
      const kind = KEYS[S.step], st = S.steps[kind];
      if (!perms[kind]) body = `<div class="ob-lock"><b>${esc(O.KINDS[kind].label)}</b> can only be set up by ${kind === "menu" || kind === "pricing" ? "an admin" : "a role that can edit this area"}. Ask your admin, or skip this step.</div><div class="ob-row"><button type="button" class="btn" data-act="skip">Skip this step</button></div>`;
      else if (st.stage === "map") body = renderMap(kind);
      else if (st.stage === "preview") body = renderPreview(kind);
      else if (st.stage === "result") body = renderResult(kind);
      else body = renderInput(kind);
    }
    root.innerHTML = `${stepsNav}${body}`;
    const live = $("#obLive"); if (live) live.textContent = "";
  }

  function header(kind) { return `<h2>${esc(O.KINDS[kind].label)}</h2><p class="sub">${esc(INTRO[kind])}</p>`; }

  function renderInput(kind) {
    const st = S.steps[kind], def = O.KINDS[kind];
    const tabs = `<div class="ob-tabs" role="group" aria-label="How do you want to add them?"><button type="button" data-act="mode" data-m="manual" aria-pressed="${st.mode === "manual"}">Type them in</button><button type="button" data-act="mode" data-m="csv" aria-pressed="${st.mode === "csv"}">Import a CSV</button></div>`;
    let inner;
    if (st.mode === "csv") {
      inner = `<div class="ob-row"><button type="button" class="btn" data-act="template">Download CSV template</button>`
        + `<label class="btn" for="obFile">Choose a CSV file</label><input type="file" id="obFile" accept=".csv,.txt,text/csv,text/plain" hidden>`
        + `<span class="ob-note">${esc(st.fileName || "or paste below")}</span></div>`
        + `<label class="ob-note" for="obText">Paste CSV (first row = column names). Up to ${Number(O.MAX_ROWS)} rows.</label>`
        + `<textarea id="obText" spellcheck="false" aria-describedby="obHint">${esc(st.text)}</textarea>`
        + `<p class="ob-note" id="obHint">Columns we understand: ${def.fields.map((f) => esc(f.label) + (f.required ? "*" : "")).join(", ")}. Prices may include ₹ and Indian commas (1,25,000).</p>`;
    } else {
      inner = `<div class="ob-scroll"><table><thead><tr>${def.fields.map((f) => `<th scope="col">${esc(f.label)}${f.required ? "*" : ""}</th>`).join("")}<th><span class="sr-only">Remove</span></th></tr></thead><tbody>`
        + st.manual.map((r, ri) => `<tr>${def.fields.map((f) => `<td>${manualCell(kind, f, r, ri)}</td>`).join("")}<td><button type="button" class="btn" data-act="delrow" data-r="${Number(ri)}" aria-label="Remove row ${Number(ri) + 1}">×</button></td></tr>`).join("")
        + `</tbody></table></div><div class="ob-row"><button type="button" class="btn" data-act="addrow">+ Add row</button></div>`;
    }
    const ready = st.mode === "csv" ? st.text.trim().length > 0 : st.manual.some((r) => Object.values(r).some((v) => String(v || "").trim()));
    return `<div class="ob-card">${header(kind)}${tabs}${inner}<div id="obErr" class="ob-err" role="alert"></div>`
      + `<div class="ob-row">${S.step > 0 ? '<button type="button" class="btn" data-act="prev">Back</button>' : ""}<span class="ob-grow"></span>`
      + (OPTIONAL[kind] ? '<button type="button" class="btn" data-act="skip">Skip this step</button>' : "")
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
      + `<p class="ob-note">Nothing has been saved yet. ${Number(nWrite)} row(s) will be written: ${Number(s.willAdd)} added, ${Number(s.willMerge)} merged; ${Number(s.willSkip)} skipped.</p>`
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
      + `<span class="ob-grow"></span><button type="button" class="btn" data-act="stage" data-s="input">Add more</button><button type="button" class="btn primary" data-act="next">${S.step === KEYS.length - 1 ? "Finish" : "Next step"}</button></div>`
      + (c.merged ? '<p class="ob-note">Undo removes the rows this import added. Quantities that were added to existing items are not reversed; adjust them in Inventory if needed.</p>' : "")
      + (pv ? "" : "") + `</div>`;
  }

  function renderFinish() {
    const lines = KEYS.map((k) => { const c = counts(k); const st = S.steps[k]; const st2 = st.skipped ? "skipped" : (st.done ? `${Number(c.ok)} added${undoneCount(st, k) ? " (" + undoneCount(st, k) + " undone)" : ""}, ${Number(c.merged)} merged` : "not done");
      return `<li><b>${esc(O.KINDS[k].label)}</b> — ${esc(st2)}</li>`; }).join("");
    return `<div class="ob-card"><h2>You're set up</h2><p class="sub">Here is what this session added.</p><ul>${lines}</ul>`
      + `<div class="ob-row"><a class="btn" href="inventory.html">Open Inventory</a><a class="btn" href="vendors.html">Open Vendors</a><a class="btn" href="staff.html">Open Staff</a><a class="btn" href="control.html#pricing">Open Control Center</a>`
      + `<span class="ob-grow"></span><button type="button" class="btn" data-act="reset">Clear saved draft</button><a class="btn primary" href="dashboard.html">Go to dashboard</a></div></div>`;
  }

  /* ---------- navigation + history ---------- */
  function go(step, stage, push) {
    S.step = Math.max(0, Math.min(KEYS.length, step));
    if (stage && S.step < KEYS.length) S.steps[KEYS[S.step]].stage = stage;
    if (push !== false) { try { history.pushState({ onb: 1, step: S.step, stage: S.step < KEYS.length ? S.steps[KEYS[S.step]].stage : "finish" }, "", "#s" + S.step); } catch (e) {} }
    saveDraft(); render(); const h = $("#obRoot h2"); if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: false }); }
  }
  window.addEventListener("popstate", (e) => {
    const s = e.state; if (!S || !s || !s.onb) return;
    S.step = Math.max(0, Math.min(KEYS.length, s.step | 0));
    if (S.step < KEYS.length) { const st = S.steps[KEYS[S.step]]; st.stage = ["input", "map", "preview", "result"].includes(s.stage) ? s.stage : "input"; if (st.stage === "result" && !st.batchKey) st.stage = "input"; if (st.stage === "preview" || st.stage === "map") prepare(KEYS[S.step]).then(render); }
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
    if (a === "next") { if (st) st.skipped = false; return go(S.step + 1); }
    if (a === "skip") { st.skipped = true; return go(S.step + 1); }
    if (a === "mode") { st.mode = b.dataset.m === "csv" ? "csv" : "manual"; saveDraft(); return render(); }
    if (a === "stage") { st.stage = b.dataset.s; if (st.stage === "map" || st.stage === "input") return go(S.step, st.stage); return go(S.step, st.stage); }
    if (a === "addrow") { if (st.manual.length >= O.MAX_ROWS) return BPUI.toast("Row limit reached; use CSV import for more.", { type: "info" }); st.manual.push({}); saveDraft(); return render(); }
    if (a === "delrow") { st.manual.splice(Number(b.dataset.r), 1); if (!st.manual.length) st.manual.push({}); saveDraft(); return render(); }
    if (a === "template") return downloadTemplate(kind);
    if (a === "reset") { try { localStorage.removeItem(LS_DRAFT + uid); } catch (e) {} S = freshState(); previews = {}; BPUI.toast("Saved draft cleared. Data already imported is untouched.", { type: "ok" }); return go(0); }
    if (["review", "preview", "import", "retry", "undo"].includes(a)) return BPUI.guard(b, () => act(kind, a, b), { busyLabel: a === "import" || a === "retry" ? "Importing…" : "Working…" });
  }
  function downloadTemplate(kind) {
    const blob = new Blob(["﻿" + O.templateCSV(kind)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "helm-" + kind + "-template.csv";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function onInput(ev) {
    if (!S) return; const kind = KEYS[S.step]; if (!kind) return; const st = S.steps[kind], t = ev.target;
    if (t.id === "obText") { st.text = t.value.slice(0, O.MAX_FILE_BYTES); st.fileName = ""; st.mapping = null; saveDraft(); }
    else if (t.dataset && t.dataset.r !== undefined && t.dataset.f) { const r = st.manual[Number(t.dataset.r)]; if (r) { r[t.dataset.f] = t.value; saveDraft(); } }
  }
  function onChange(ev) {
    if (!S) return; const kind = KEYS[S.step]; if (!kind) return; const st = S.steps[kind], t = ev.target;
    if (t.id === "obFile") return readFile(kind, t.files && t.files[0]);
    if (t.dataset && t.dataset.map) { st.mapping = st.mapping || {}; st.mapping[t.dataset.map] = Number(t.value); saveDraft(); return; }
    if (t.dataset && t.dataset.line && previews[kind]) {
      const line = Number(t.dataset.line); st.actions[line] = t.value; saveDraft();
      previews[kind] = O.buildPreview(kind, tableOf(kind), currentMapping(kind, tableOf(kind)), existingCache[kind] || [], st.actions); render();
      const again = $('select[data-line="' + line + '"]'); if (again) again.focus();
    }
  }
  function readFile(kind, f) {
    const st = S.steps[kind]; if (!f) return;
    if (f.size > O.MAX_FILE_BYTES) return BPUI.toast("That file is over 2 MB. Split it into smaller files.", { type: "err" });
    const fr = new FileReader();
    fr.onerror = () => BPUI.toast("Could not read that file.", { type: "err" });
    fr.onload = () => {
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
    const u = BPStore.auth.user(); uid = (u && u.id) ? String(u.id).replace(/[^\w-]/g, "").slice(0, 40) : "anon";
    await computePerms();
    if (!KEYS.some((k) => perms[k])) { $("#obRoot").innerHTML = '<div class="ob-lock">Your role cannot add menu, pricing, inventory, vendors or staff. Ask an admin to run this setup.</div>'; $("#app").hidden = false; return; }
    loadLedger();
    const d = loadDraft(); S = d.s;
    if (!perms[KEYS[S.step]] && S.step < KEYS.length) S.step = Math.max(0, KEYS.findIndex((k) => perms[k]));
    // after a refresh in the middle of preview/result, rebuild what the screen needs
    const cur = KEYS[S.step];
    if (cur && S.steps[cur].stage === "preview") { try { await prepare(cur); } catch (e) { S.steps[cur].stage = "input"; } }
    if (cur && S.steps[cur].stage === "map" && S.steps[cur].mode !== "csv") S.steps[cur].stage = "input";
    if (cur && S.steps[cur].stage === "result" && !S.steps[cur].batchKey) S.steps[cur].stage = "input";
    document.addEventListener("click", onClick); document.addEventListener("input", onInput); document.addEventListener("change", onChange);
    try { history.replaceState({ onb: 1, step: S.step, stage: cur ? S.steps[cur].stage : "finish" }, "", "#s" + S.step); } catch (e) {}
    $("#app").hidden = false; render();
    if (d.resumed) BPUI.toast("Welcome back — your draft was restored.", { type: "info" });
  });
})();
