/* =========================================================================
   HELM — client onboarding wizard: PURE logic (no DOM, no network).
   Unit-tested in test/onboarding-import.test.mjs. Loaded in the browser as a
   plain script (window.HelmOnboarding) and in tests via vm / module.exports.

   Safety rules baked in here:
     * never overwrite silently: duplicates default to "skip";
     * nothing is written until the caller runs applyBatch() after a preview;
     * text cells are neutralised against spreadsheet formula injection;
     * numbers are strictly validated (no NaN / negative / absurd values);
     * applyBatch is idempotent per batch key + row (double-submit / resume safe).
   ========================================================================= */
(function (global) {
  "use strict";

  const MAX_ROWS = 2000;          // hard cap on rows per import
  const CHUNK = 100;              // rows per insert round
  const MAX_TEXT = 200;           // longest text cell we keep
  const MAX_PRICE = 100000000;    // 10 crore per unit — anything above is a typo
  const MAX_QTY = 10000000;       // 1 crore units
  const MAX_FILE_BYTES = 2 * 1024 * 1024;

  /* ---------- text cleaning ---------- */
  // Control chars out, NBSP/ZWSP out, whitespace collapsed, capped.
  function cleanText(v) {
    let s = String(v == null ? "" : v);
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‍⁠﻿]/g, "")
         .replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT).trim() : s;
  }
  // Spreadsheet formula injection: a leading = + - @ (or tab/CR) makes Excel/Sheets run
  // the cell as a formula when the data is later exported. Prefix with an apostrophe.
  // Leading "-"/"+" followed by a digit is a plain signed number in a *text* cell? Still
  // neutralised — text fields are never numbers.
  function neutralise(v) {
    const s = cleanText(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }
  // Strip tags / angle brackets from stored text. Rendering still goes through esc(),
  // this just keeps junk like <script> out of the database in the first place.
  function stripMarkup(s) { return s.replace(/<[^>]*>/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim(); }
  function safeText(v) { return neutralise(stripMarkup(cleanText(v))); }

  // Case/whitespace/unicode/punctuation-insensitive key used for duplicate detection.
  function normKey(v) {
    let s = String(v == null ? "" : v);
    try { s = s.normalize("NFKD"); } catch (e) {}
    return s.replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and")
            .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  /* ---------- numbers ---------- */
  // Returns { ok, value, empty, error }. opts: { int, max, allowZero(default true), required }
  function parseNumber(raw, opts) {
    opts = opts || {};
    if (raw == null || String(raw).trim() === "") return opts.required ? { ok: false, empty: true, error: "required" } : { ok: true, empty: true, value: null };
    let s = String(raw).trim().normalize ? String(raw).trim().normalize("NFKC") : String(raw).trim();
    // currency decorations
    s = s.replace(/(?:₹|rs\.?|inr|rupees?|\/-|\$|€|£)/gi, "").replace(/\s+/g, "");
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); }
    if (s[0] === "+") s = s.slice(1);
    if (!s) return { ok: false, error: "not a number" };
    // thousands separators: Indian (1,25,000) and western (1,250,000); also 1_000 / 1 000 (spaces removed above)
    if (/^\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
    else if (/^\d+(\.\d+)?$/.test(s)) { /* plain */ }
    else if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(s) || /^\.\d+$/.test(s)) { /* scientific / .5 */ }
    else return { ok: false, error: "not a number" };
    const n = Number(s);
    if (!Number.isFinite(n)) return { ok: false, error: "not a number" };
    if (neg && n !== 0) return { ok: false, error: "negative" };
    const max = opts.max != null ? opts.max : MAX_PRICE;
    if (n > max) return { ok: false, error: "too large" };
    if (opts.int) {
      if (Math.abs(n - Math.round(n)) > 1e-9) return { ok: false, error: "must be a whole number" };
      return { ok: true, value: Math.round(n) };
    }
    return { ok: true, value: Math.round(n * 100) / 100 };
  }

  /* ---------- CSV ---------- */
  // Decode bytes (ArrayBuffer/Uint8Array) -> { text, warnings }. UTF-8 (BOM aware), UTF-16 BOM, else windows-1252.
  function decodeBytes(buf, TD) {
    TD = TD || global.TextDecoder;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const warnings = [];
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return { text: new TD("utf-16le").decode(u8), warnings };
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return { text: new TD("utf-16be").decode(u8), warnings };
    try { return { text: new TD("utf-8", { fatal: true }).decode(u8), warnings }; }
    catch (e) {
      warnings.push("The file is not UTF-8; it was read as Windows-1252. Check accented characters in the preview.");
      return { text: new TD("windows-1252").decode(u8), warnings };
    }
  }

  function detectDelimiter(text) {
    const first = text.split(/\r\n|\n|\r/, 1)[0] || "";
    const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
    let q = false;
    for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
    let best = ",", n = 0;
    for (const d of Object.keys(counts)) if (counts[d] > n) { best = d; n = counts[d]; }
    return best;
  }

  // RFC-4180-ish parser: BOM, CRLF/CR/LF, quoted fields with commas/newlines/"" escapes.
  // Returns { rows: string[][], warnings, truncated }
  function parseCSV(text, opts) {
    opts = opts || {};
    const warnings = [];
    let s = String(text == null ? "" : text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    if (s.indexOf("�") >= 0) warnings.push("Some characters could not be read (wrong file encoding?). Re-save the file as UTF-8 CSV.");
    if (/\u0000/.test(s)) { s = s.replace(/\u0000/g, ""); warnings.push("The file contains binary data; it may not be a CSV."); }
    const d = opts.delimiter || detectDelimiter(s);
    const rows = []; let row = [], f = "", q = false, i = 0, quotedField = false;
    const endField = () => { row.push(f); f = ""; quotedField = false; };
    const endRow = () => { endField(); if (!(row.length === 1 && row[0].trim() === "" && !quotedField)) rows.push(row); row = []; };
    const limit = (opts.maxRows || MAX_ROWS) + 2;   // header + cap + 1 sentinel
    for (; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"' && f === "") { q = true; quotedField = true; }
      else if (c === d) endField();
      else if (c === "\r") { if (s[i + 1] === "\n") i++; endRow(); if (rows.length >= limit) break; }
      else if (c === "\n") { endRow(); if (rows.length >= limit) break; }
      else f += c;
    }
    if (rows.length < limit && (f !== "" || row.length)) endRow();
    if (q) warnings.push("A quoted value was never closed; the last row may be incomplete.");
    let truncated = false;
    if (rows.length > (opts.maxRows || MAX_ROWS) + 1) { rows.length = (opts.maxRows || MAX_ROWS) + 1; truncated = true; }
    return { rows, warnings, truncated, delimiter: d };
  }

  // Template CSV text; values that start with a formula char are not present, but go through the same escape.
  function csvEscapeCell(v) {
    let s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ---------- kinds (what each step imports) ---------- */
  // fields: key, label, required, type (text|price|qty|enum|phone|email), synonyms (normKey'd below)
  const KINDS = {
    menu: {
      label: "Menu items", noun: "dish", area: "admin",
      fields: [
        { key: "name", label: "Dish name", required: true, type: "text", syn: ["name", "dish", "dishname", "item", "menuitem", "menu"] },
        { key: "category", label: "Category", required: false, type: "text", syn: ["category", "course", "section", "type", "group"], dflt: "Other" },
        { key: "kind", label: "Veg / Non-veg", required: false, type: "diet", syn: ["kind", "diet", "veg", "vegnonveg", "dietary", "foodtype"], dflt: "veg" },
      ],
      template: [["name", "category", "kind"], ["Paneer Butter Masala", "Main course", "veg"], ["Chicken Biryani", "Main course", "nonveg"], ["Gulab Jamun", "Dessert", "veg"]],
    },
    pricing: {
      label: "Rates", noun: "rate", area: "admin",
      fields: [
        { key: "name", label: "Name", required: true, type: "text", syn: ["name", "item", "rate", "ratename", "title", "package"] },
        { key: "price", label: "Price (₹)", required: true, type: "price", syn: ["price", "rate", "amount", "cost", "rs", "inr", "unitprice", "perunit", "charge"] },
        { key: "type", label: "Applies to", required: false, type: "ratetype", syn: ["type", "kind", "applies", "appliesto", "for", "category"], dflt: "plate" },
      ],
      template: [["name", "price", "type"], ["Gold chair", "150", "chair"], ["Standard plate", "850", "plate"], ["Premium plate", "1,250", "plate"]],
    },
    inventory: {
      label: "Inventory items", noun: "item", area: "inventory",
      fields: [
        { key: "name", label: "Item name", required: true, type: "text", syn: ["name", "item", "itemname", "product", "asset", "description"] },
        { key: "category", label: "Category", required: false, type: "text", syn: ["category", "group", "type", "section"] },
        { key: "total_qty", label: "Quantity", required: true, type: "qty", syn: ["quantity", "qty", "stock", "count", "totalqty", "units", "number", "nos", "pieces", "pcs"] },
        { key: "unit", label: "Unit", required: false, type: "text", syn: ["unit", "uom", "unitofmeasure"], dflt: "pcs" },
        { key: "unit_cost", label: "Unit cost (₹)", required: false, type: "price", syn: ["unitcost", "cost", "price", "rate", "value", "rent", "amount"] },
      ],
      template: [["name", "category", "quantity", "unit", "unit_cost"], ["Chiavari chair", "Seating", "200", "pcs", "150"], ["Round table 5ft", "Tables", "30", "pcs", "400"], ["White table linen", "Linens", "120", "pcs", "50"]],
    },
    vendors: {
      label: "Vendors", noun: "vendor", area: "vendors",
      fields: [
        { key: "name", label: "Vendor name", required: true, type: "text", syn: ["name", "vendor", "vendorname", "company", "business", "supplier"] },
        { key: "category", label: "Category", required: false, type: "text", syn: ["category", "service", "services", "type", "trade"] },
        { key: "phone", label: "Phone", required: false, type: "phone", syn: ["phone", "mobile", "contact", "number", "tel", "whatsapp", "phoneno"] },
        { key: "email", label: "Email", required: false, type: "email", syn: ["email", "mail", "emailid", "emailaddress"] },
      ],
      template: [["name", "category", "phone", "email"], ["Sharma Decorators", "Decor", "9876543210", "sharma@example.com"], ["Royal Caterers", "Catering", "9123456780", ""]],
    },
    staff: {
      label: "Staff", noun: "person", area: "staff",
      fields: [
        { key: "name", label: "Name", required: true, type: "text", syn: ["name", "staff", "staffname", "employee", "fullname", "person"] },
        { key: "phone", label: "Phone", required: true, type: "phone", syn: ["phone", "mobile", "contact", "number", "tel", "phoneno"] },
        { key: "role", label: "Role", required: false, type: "text", syn: ["role", "designation", "title", "position", "job"] },
        { key: "department", label: "Department", required: false, type: "text", syn: ["department", "dept", "team", "division"] },
      ],
      template: [["name", "phone", "role", "department"], ["Ravi Kumar", "9876501234", "Lead technician", "Production"], ["Anita Rao", "9811122233", "Coordinator", "Operations"]],
    },
  };
  KINDS.menu.fields.forEach(prep); KINDS.pricing.fields.forEach(prep); KINDS.inventory.fields.forEach(prep);
  KINDS.vendors.fields.forEach(prep); KINDS.staff.fields.forEach(prep);
  function prep(f) { f.synN = f.syn.map(normKey); }

  function templateCSV(kind) {
    return KINDS[kind].template.map((r) => r.map(csvEscapeCell).join(",")).join("\r\n") + "\r\n";
  }

  /* ---------- header mapping ---------- */
  function lev(a, b) {
    if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  // Best-effort header → field mapping. Returns { mapping:{fieldKey: colIndex|-1}, confident:boolean, missing:[required keys not mapped] }
  function mapHeaders(headers, kind) {
    const def = KINDS[kind]; const hs = (headers || []).map(normKey);
    const used = new Set(); const mapping = {};
    // pass 1 exact synonym, pass 2 contains, pass 3 fuzzy
    const passes = [
      (h, f) => f.synN.includes(h),
      (h, f) => h.length >= 3 && f.synN.some((s) => s.length >= 3 && (h.includes(s) || s.includes(h))),
      (h, f) => h.length >= 4 && f.synN.some((s) => s.length >= 4 && lev(h, s) <= Math.max(1, Math.floor(Math.min(h.length, s.length) / 4))),
    ];
    def.fields.forEach((f) => { mapping[f.key] = -1; });
    passes.forEach((test) => {
      def.fields.forEach((f) => {
        if (mapping[f.key] !== -1) return;
        const idx = hs.findIndex((h, i) => !used.has(i) && h && test(h, f));
        if (idx >= 0) { mapping[f.key] = idx; used.add(idx); }
      });
    });
    const missing = def.fields.filter((f) => f.required && mapping[f.key] === -1).map((f) => f.key);
    return { mapping, missing, confident: missing.length === 0 };
  }
  // Manual mapping from the UI can carry bad values; clamp to valid column indexes, no column used twice.
  function sanitizeMapping(mapping, kind, ncols) {
    const out = {}; const used = new Set();
    KINDS[kind].fields.forEach((f) => {
      let v = mapping && Number.isInteger(mapping[f.key]) ? mapping[f.key] : -1;
      if (v < 0 || v >= ncols || used.has(v)) v = -1; else used.add(v);
      out[f.key] = v;
    });
    return out;
  }

  /* ---------- row validation ---------- */
  const DIET = { veg: "veg", v: "veg", vegetarian: "veg", pureveg: "veg", nonveg: "nonveg", nv: "nonveg", nonvegetarian: "nonveg", egg: "nonveg", special: "special" };
  const RATE = { chair: "chair", chairs: "chair", seat: "chair", seating: "chair", plate: "plate", plates: "plate", catering: "plate", meal: "plate" };

  function cleanPhone(v) {
    const raw = cleanText(v); if (!raw) return { ok: true, value: "" };
    const digits = raw.replace(/[^\d+]/g, "");
    const d = digits.replace(/^\+/, "");
    if (!/^\+?\d+$/.test(digits) || d.length < 7 || d.length > 15) return { ok: false, error: "invalid phone" };
    return { ok: true, value: digits };
  }
  function cleanEmail(v) {
    const s = cleanText(v).toLowerCase(); if (!s) return { ok: true, value: "" };
    return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(s) && s.length <= 120 ? { ok: true, value: s } : { ok: false, error: "invalid email" };
  }

  function validateRow(kind, vals) {
    const def = KINDS[kind]; const out = {}; const errors = [];
    def.fields.forEach((f) => {
      const raw = vals[f.key];
      const blank = raw == null || String(raw).trim() === "";
      if (f.type === "text") {
        const t = safeText(raw);
        if (!t && f.required) errors.push(f.label + " is required");
        out[f.key] = t || (f.dflt !== undefined ? f.dflt : "");
      } else if (f.type === "price") {
        const r = parseNumber(raw, { required: f.required, max: MAX_PRICE });
        if (!r.ok) errors.push(f.label + ": " + (r.empty ? "required" : r.error)); out[f.key] = r.ok ? (r.value == null ? 0 : r.value) : null;
      } else if (f.type === "qty") {
        const r = parseNumber(raw, { required: f.required, int: true, max: MAX_QTY });
        if (!r.ok) errors.push(f.label + ": " + (r.empty ? "required" : r.error)); out[f.key] = r.ok ? (r.value == null ? 0 : r.value) : null;
      } else if (f.type === "diet") {
        if (blank) out[f.key] = f.dflt; else { const k = DIET[normKey(raw)]; if (!k) { errors.push("Veg/Non-veg: use veg, nonveg or special"); out[f.key] = null; } else out[f.key] = k; }
      } else if (f.type === "ratetype") {
        if (blank) out[f.key] = f.dflt; else { const k = RATE[normKey(raw)]; if (!k) { errors.push("Applies to: use chair or plate"); out[f.key] = null; } else out[f.key] = k; }
      } else if (f.type === "phone") {
        const r = cleanPhone(raw); if (!r.ok) errors.push(r.error); else if (!r.value && f.required) errors.push(f.label + " is required"); out[f.key] = r.ok ? r.value : null;
      } else if (f.type === "email") {
        const r = cleanEmail(raw); if (!r.ok) errors.push(r.error); out[f.key] = r.ok ? r.value : null;
      }
    });
    return { data: out, errors };
  }

  // The identity used for duplicate detection (per kind).
  function dupKey(kind, d) {
    if (kind === "pricing") return normKey(d.type) + "|" + normKey(d.name);
    return normKey(d.name);
  }
  function existingKey(kind, rec) {
    if (kind === "pricing") return normKey(rec._type) + "|" + normKey(rec.name);
    return normKey(rec.name);
  }

  const CAN_MERGE = { inventory: true };       // only inventory has an additive meaning (add the quantity)
  // "update" overwrites the existing record's numbers with the file's — offered only when the
  // name matches EXACTLY (same spelling + case, ignoring outer spaces) and only after the preview.
  const CAN_UPDATE = { pricing: true, inventory: true };
  // Suggest a free "name (2)" given a Set of taken keys.
  function renameFree(kind, d, taken) {
    for (let n = 2; n < 1000; n++) {
      const cand = Object.assign({}, d, { name: d.name.slice(0, MAX_TEXT - 6) + " (" + n + ")" });
      if (!taken.has(dupKey(kind, cand))) return cand.name;
    }
    return d.name + " (copy)";
  }

  /* ---------- the preview model ----------
     table: string[][] with header row first (already CSV-parsed or built from manual entry)
     mapping: {fieldKey: colIndex}
     existing: [{id,name,_type?,total_qty?,...}]
     prior: {lineNo: action} user choices carried across re-renders
     Returns { rows, summary, truncated } — rows[].status in new|dup-file|dup-existing|invalid. */
  function buildPreview(kind, table, mapping, existing, prior) {
    const def = KINDS[kind]; prior = prior || {};
    const body = (table || []).slice(1);
    const truncated = body.length > MAX_ROWS;
    const src = truncated ? body.slice(0, MAX_ROWS) : body;
    const map = sanitizeMapping(mapping, kind, Math.max(0, ...(table || []).map((r) => r.length), 0));
    const exMap = new Map();
    (existing || []).forEach((e) => { const k = existingKey(kind, e); if (k && !exMap.has(k)) exMap.set(k, e); });
    const seen = new Map(); const rows = [];
    src.forEach((cells, i) => {
      if (!cells || cells.every((c) => String(c == null ? "" : c).trim() === "")) return;   // fully blank line: ignore silently
      const vals = {};
      def.fields.forEach((f) => { const ci = map[f.key]; vals[f.key] = ci >= 0 ? cells[ci] : undefined; });
      const line = i + 2;     // spreadsheet-style line number (header = 1)
      const v = validateRow(kind, vals);
      // more cells than header columns = an unquoted comma split a value (e.g. 1,250) — never import a guessed value
      if (table[0] && cells.filter((c, ci) => ci >= table[0].length && String(c == null ? "" : c).trim() !== "").length) v.errors = v.errors.concat(["Row has more cells than the header — put values that contain commas in quotes"]);
      const row = { line, data: v.data, errors: v.errors, status: "new", action: "add", matchId: null, mergeable: false };
      if (v.errors.length) { row.status = "invalid"; row.action = "skip"; rows.push(row); return; }
      const k = dupKey(kind, v.data);
      if (!k) { row.status = "invalid"; row.errors = ["Name has no letters or digits"]; row.action = "skip"; rows.push(row); return; }
      if (seen.has(k)) { row.status = "dup-file"; row.action = "skip"; row.dupOfLine = seen.get(k); rows.push(row); return; }
      seen.set(k, line);
      const ex = exMap.get(k);
      if (ex) {
        row.status = "dup-existing"; row.matchId = ex.id; row.matchName = ex.name;
        row.mergeable = !!CAN_MERGE[kind] && ex.active !== false;
        row.updatable = !!CAN_UPDATE[kind] && ex.active !== false && String(ex.name == null ? "" : ex.name).trim() === String(v.data.name).trim();
        const a = prior[line];
        row.action = (a === "merge" && row.mergeable) || (a === "update" && row.updatable) || a === "rename" || a === "skip" ? a : "skip";
      }
      rows.push(row);
    });
    // resolve renames now so they are unique against existing + file
    const taken = new Set(exMap.keys()); rows.forEach((r) => { if (r.status === "new") taken.add(dupKey(kind, r.data)); });
    rows.forEach((r) => {
      if (r.status === "dup-existing" && r.action === "rename") {
        const nm = renameFree(kind, r.data, taken); r.renamedTo = nm; taken.add(dupKey(kind, Object.assign({}, r.data, { name: nm })));
      }
    });
    return { rows, summary: summarise(rows), truncated, mapping: map };
  }
  function summarise(rows) {
    const s = { total: rows.length, new: 0, dupFile: 0, dupExisting: 0, invalid: 0, willAdd: 0, willMerge: 0, willSkip: 0 };
    rows.forEach((r) => {
      if (r.status === "new") s.new++; else if (r.status === "dup-file") s.dupFile++;
      else if (r.status === "dup-existing") s.dupExisting++; else s.invalid++;
      if (r.status === "new" || (r.status === "dup-existing" && r.action === "rename")) s.willAdd++;
      else if (r.status === "dup-existing" && (r.action === "merge" || r.action === "update")) s.willMerge++; else s.willSkip++;
    });
    return s;
  }
  function setAction(preview, line, action) {
    const r = preview.rows.find((x) => x.line === line); if (!r || r.status !== "dup-existing") return preview;
    if (action === "merge" && !r.mergeable) return preview;
    if (action === "update" && !r.updatable) return preview;
    if (action !== "skip" && action !== "merge" && action !== "rename" && action !== "update") return preview;
    return { ...preview, rows: preview.rows.map((x) => x === r ? Object.assign({}, x, { action }) : x) };
  }

  /* ---------- manual entry → table ---------- */
  function tableFromManual(kind, manualRows) {
    const keys = KINDS[kind].fields.map((f) => f.key);
    return [keys].concat((manualRows || []).map((r) => keys.map((k) => (r && r[k] != null ? String(r[k]) : ""))));
  }

  /* ---------- chunking + idempotent apply ---------- */
  function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
  function newBatchKey() {
    const r = () => Math.random().toString(36).slice(2, 10);
    return "ob-" + Date.now().toString(36) + "-" + r() + r();
  }
  function ledgerKey(batchKey, kind, line) { return batchKey + ":" + kind + ":" + line; }

  /* Payload sent to BPStore for one row. */
  function toPayload(kind, row) {
    const d = row.data; const name = row.action === "rename" && row.renamedTo ? row.renamedTo : d.name;
    if (kind === "menu") return { category: d.category, name, kind: d.kind };
    if (kind === "pricing") return { type: d.type, name, price: d.price };
    if (kind === "inventory") return { name, category: d.category || null, total_qty: d.total_qty, unit: d.unit || "pcs", unit_cost: d.unit_cost || 0 };
    if (kind === "vendors") return { name, category: d.category || null, phone: d.phone || null, email: d.email || null };
    return { name, phone: d.phone, role: d.role || null, department: d.department || null, skills: [] };
  }

  /* applyBatch(opts)
       kind, rows (preview.rows), batchKey, ledger ({entries:{key:{status,id,error,...}}} — mutated + returned),
       api: { create(kind, payload) → record, createMany?(kind, payloads) → records, merge(kind, matchId, payload) → void },
       onProgress(done,total), save(ledger) — called after each chunk so a refresh keeps progress,
       isCancelled().
     Idempotent: rows already ok/merged in the ledger are never re-sent. Failed rows are retried on the next call.
     Never throws for a row failure: records it. Returns { ledger, counts }. */
  async function applyBatch(o) {
    const ledger = o.ledger || { entries: {} }; ledger.entries = ledger.entries || {};
    const todo = o.rows.filter((r) => {
      if (r.status === "invalid" || r.status === "dup-file") return false;
      if (r.status === "dup-existing" && r.action === "skip") return false;
      const e = ledger.entries[ledgerKey(o.batchKey, o.kind, r.line)];
      return !(e && (e.status === "ok" || e.status === "merged"));
    });
    const isChange = (r) => r.status === "dup-existing" && (r.action === "merge" || r.action === "update");
    const inserts = todo.filter((r) => !isChange(r));
    const merges = todo.filter(isChange);
    let done = 0; const total = todo.length;
    const rec = (r, v) => { ledger.entries[ledgerKey(o.batchKey, o.kind, r.line)] = Object.assign({ line: r.line, name: r.renamedTo || r.data.name }, v); };
    const tick = async () => { done++; if (o.onProgress) o.onProgress(done, total); };
    for (const group of chunk(inserts, o.chunkSize || CHUNK)) {
      if (o.isCancelled && o.isCancelled()) break;
      let handled = false;
      if (o.api.createMany && group.length > 1) {
        try {
          const made = await o.api.createMany(o.kind, group.map((r) => toPayload(o.kind, r)));
          if (Array.isArray(made) && made.length === group.length) {
            group.forEach((r, i) => rec(r, { status: "ok", id: made[i] && made[i].id })); handled = true;
          }
        } catch (e) { /* fall through to per-row so every row gets its own result */ }
      }
      if (!handled) {
        for (const r of group) {
          if (o.isCancelled && o.isCancelled()) break;
          try { const made = await o.api.create(o.kind, toPayload(o.kind, r)); rec(r, { status: "ok", id: made && made.id }); }
          catch (e) { rec(r, { status: "error", error: String((e && e.message) || e).slice(0, 200) }); }
        }
      }
      for (let i = 0; i < group.length; i++) await tick();
      if (o.save) o.save(ledger);
    }
    for (const r of merges) {
      if (o.isCancelled && o.isCancelled()) break;
      try {
        if (r.action === "update") { if (!o.api.update) throw new Error("update not supported"); await o.api.update(o.kind, r.matchId, toPayload(o.kind, r)); rec(r, { status: "merged", updated: true, id: r.matchId }); }
        else { await o.api.merge(o.kind, r.matchId, toPayload(o.kind, r)); rec(r, { status: "merged", id: r.matchId }); }
      }
      catch (e) { rec(r, { status: "error", error: String((e && e.message) || e).slice(0, 200) }); }
      await tick();
    }
    if (o.save) o.save(ledger);
    return { ledger, counts: ledgerCounts(ledger, o.batchKey, o.kind) };
  }
  function ledgerCounts(ledger, batchKey, kind) {
    const c = { ok: 0, merged: 0, error: 0 };
    Object.keys((ledger && ledger.entries) || {}).forEach((k) => {
      if (k.indexOf(batchKey + ":" + kind + ":") !== 0) return;
      const s = ledger.entries[k].status; if (c[s] != null) c[s]++;
    });
    return c;
  }

  /* undoBatch: soft-deactivates ONLY rows this batch created (ledger status ok with an id).
     Merged rows (existing records whose quantity was topped up) are deliberately not touched. */
  async function undoBatch(o) {
    const out = { undone: 0, failed: 0, skippedMerged: 0 };
    for (const k of Object.keys(o.ledger.entries || {})) {
      if (k.indexOf(o.batchKey + ":" + o.kind + ":") !== 0) continue;
      const e = o.ledger.entries[k];
      if (e.status === "merged") { out.skippedMerged++; continue; }
      if (e.status !== "ok" || !e.id || e.undone) continue;
      try { await o.api.deactivate(o.kind, e.id); e.undone = true; out.undone++; } catch (err) { out.failed++; }
    }
    if (o.save) o.save(o.ledger);
    return out;
  }

  /* ---------- draft (localStorage) ---------- */
  const DRAFT_VERSION = 1;
  function serializeDraft(state) {
    const s = { v: DRAFT_VERSION, savedAt: Date.now(), step: state.step | 0, steps: {} };
    Object.keys(state.steps || {}).forEach((k) => {
      const st = state.steps[k] || {};
      s.steps[k] = { mode: st.mode === "csv" ? "csv" : "manual", text: String(st.text || "").slice(0, MAX_FILE_BYTES), manual: (st.manual || []).slice(0, MAX_ROWS), mapping: st.mapping || null,
        actions: st.actions || {}, batchKey: st.batchKey || null, stage: st.stage || "input", done: !!st.done, skipped: !!st.skipped };
    });
    return JSON.stringify(s);
  }
  function parseDraft(json) {
    try {
      const d = JSON.parse(json);
      if (!d || d.v !== DRAFT_VERSION || typeof d.steps !== "object") return null;
      return d;
    } catch (e) { return null; }
  }

  /* ---------- studio billing details (onboarding + Control Center) ----------
     Stored on organizations: name (studio), location (primary city), gst_number, and
     brand.phone + brand.billing {legal_name,line1,line2,city,state,pin}. brand.billing is
     never exposed by the public booklet RPCs (they pick brand keys one by one). */
  const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  const PIN_RE = /^[1-9][0-9]{5}$/;
  // Tax-ID formats per studio country (0079) - kept identical to BPStore.tax.COUNTRIES in
  // store-api.js (test/country-tax.test.mjs checks they match). Unknown country: generic.
  const TAX_IDS = {
    IN: { label: "GSTIN", re: GSTIN_RE, eg: "36ABCDE1234F1Z5" },
    AE: { label: "TRN", re: /^[0-9]{15}$/, eg: "100123456700003" },
    GB: { label: "VAT number", re: /^(GB)?([0-9]{9}|[0-9]{12})$/, eg: "GB123456789" },
    US: { label: "Sales tax permit / EIN", re: /^[A-Z0-9-]{4,20}$/, eg: "12-3456789" },
    SG: { label: "GST reg. no.", re: /^([0-9]{8,9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z]|M[0-9A-Z][0-9]{7}[A-Z])$/, eg: "200312345A" },
    AU: { label: "ABN", re: /^[0-9]{11}$/, eg: "51824753556" },
    CA: { label: "GST/HST number", re: /^[0-9]{9}(RT[0-9]{4})?$/, eg: "123456789RT0001" },
  };
  const TAX_ID_OTHER = { label: "Tax ID", re: /^[A-Z0-9 ./-]{3,30}$/, eg: "" };
  const countryCode = (v) => { const c = String(v || "").trim().toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : "IN"; };
  const taxIdOf = (cc) => TAX_IDS[countryCode(cc)] || TAX_ID_OTHER;
  const BILLING_FIELDS = [
    { key: "country", label: "Country", required: true, max: 2, type: "country" },
    { key: "legal_name", label: "Legal / business name", required: true, max: 120 },
    { key: "line1", label: "Billing address", required: true, max: 160 },
    { key: "line2", label: "Address line 2", required: false, max: 160 },
    { key: "city", label: "City", required: true, max: 60 },
    { key: "state", label: "State", required: true, max: 60 },
    { key: "pin", label: "PIN code", required: true, max: 10 },
    { key: "phone", label: "Business phone", required: true, max: 24 },
    { key: "location", label: "Primary location / city", required: true, max: 80 },
    { key: "gstin", label: "GSTIN (optional)", required: false, max: 15 },
  ];
  const bstr = (v, max) => stripMarkup(cleanText(v)).slice(0, max);
  function validateBilling(input) {
    const i = input || {}; const data = {}; const errors = {};
    BILLING_FIELDS.forEach((f) => { data[f.key] = bstr(i[f.key], f.key === "gstin" ? 30 : f.key === "country" ? 4 : f.max); });
    data.country = countryCode(data.country); const india = data.country === "IN";
    data.gstin = data.gstin.toUpperCase().replace(/\s+/g, "");
    data.pin = india ? data.pin.replace(/\s+/g, "") : data.pin.trim().toUpperCase();
    BILLING_FIELDS.forEach((f) => { if (f.required && !data[f.key]) errors[f.key] = f.label + " is required."; });
    if (data.legal_name && !/[A-Za-z0-9]/.test(data.legal_name)) errors.legal_name = "Enter a real business name.";
    if (data.pin && india && !PIN_RE.test(data.pin)) errors.pin = "PIN code must be 6 digits (not starting with 0).";
    if (data.pin && !india && !/^[A-Z0-9][A-Z0-9 -]{1,9}$/.test(data.pin)) errors.pin = "Enter a valid postal code.";
    if (data.phone) { const d = data.phone.replace(/[^\d]/g, ""); if (!/^[+\d\s()-]+$/.test(data.phone) || d.length < (india ? 10 : 7) || d.length > (india ? 13 : 15)) errors.phone = "Enter a valid phone number, e.g. " + (india ? "+91 98765 43210." : "+44 20 7946 0958."); }
    if (data.gstin && india && !GSTIN_RE.test(data.gstin)) errors.gstin = "Enter a valid 15-character GSTIN, e.g. 36ABCDE1234F1Z5 (or leave it blank).";
    if (data.gstin && !india) { const t = taxIdOf(data.country); if (data.gstin.length > 30 || !t.re.test(data.gstin)) errors.gstin = "Enter a valid " + t.label + (t.eg ? ", e.g. " + t.eg : "") + " (or leave it blank)."; }
    return { ok: Object.keys(errors).length === 0, data, errors };
  }
  function billingFromOrg(o) {
    o = o || {}; const b = (o.brand && typeof o.brand === "object" && !Array.isArray(o.brand)) ? o.brand : {};
    const bl = (b.billing && typeof b.billing === "object" && !Array.isArray(b.billing)) ? b.billing : {};
    const s = (v) => (typeof v === "string" ? v : "");
    return { country: countryCode(bl.country), legal_name: s(bl.legal_name) || "", line1: s(bl.line1), line2: s(bl.line2), city: s(bl.city), state: s(bl.state), pin: s(bl.pin),
      phone: s(b.phone), location: s(o.location), gstin: s(o.gst_number) };
  }
  // fields still missing on an existing studio (labels) — [] when complete
  function billingMissing(o) {
    const v = validateBilling(billingFromOrg(o)); return BILLING_FIELDS.filter((f) => v.errors[f.key]).map((f) => f.label);
  }
  // organizations update patch. Keeps every brand key it does not own; never clears the studio name.
  function billingPatch(o, data) {
    o = o || {}; const b = (o.brand && typeof o.brand === "object" && !Array.isArray(o.brand)) ? o.brand : {};
    const oldBl = (b.billing && typeof b.billing === "object" && !Array.isArray(b.billing)) ? b.billing : {};
    const billing = Object.assign({}, oldBl, { legal_name: data.legal_name, line1: data.line1, line2: data.line2 || null, city: data.city, state: data.state, pin: data.pin, country: countryCode(data.country) });
    const patch = { location: data.location, gst_number: data.gstin || null, brand: Object.assign({}, b, { phone: data.phone, billing }) };
    if (!String(o.name || "").trim()) patch.name = data.legal_name;
    return patch;
  }

  const api = {
    GSTIN_RE, PIN_RE, TAX_IDS, taxIdOf, countryCode, BILLING_FIELDS, validateBilling, billingFromOrg, billingMissing, billingPatch,
    MAX_ROWS, CHUNK, MAX_FILE_BYTES, MAX_PRICE, MAX_QTY, KINDS,
    cleanText, neutralise, safeText, normKey, parseNumber, decodeBytes, parseCSV, detectDelimiter, csvEscapeCell, templateCSV,
    mapHeaders, sanitizeMapping, validateRow, buildPreview, summarise, setAction, tableFromManual,
    chunk, newBatchKey, ledgerKey, toPayload, applyBatch, ledgerCounts, undoBatch, serializeDraft, parseDraft,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.HelmOnboarding = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
