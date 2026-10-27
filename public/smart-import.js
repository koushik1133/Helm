/* =========================================================================
   HELM \u2014 smart import dialog.  window.HelmImport.open({ entity, onDone })
     entity: "staff" | "inventory" | "menu" | "vendors"
     onDone(summary): called when the dialog closes after an import
                      summary = { created, updated, skipped, errors } (null if nothing ran)
   Needs (loaded before it): store-api.js, xlsx-lite.js, smart-import-core.js.
   Steps: upload (.xlsx / .csv) \u2192 review column mapping \u2192 review rows (errors,
   duplicates: skip / update / create) \u2192 import in batches \u2192 summary + CSV.
   Nothing is written before the user presses Import; existing rows are only
   changed for rows the user set to "Update". DOM is built with textContent only.
   ========================================================================= */
(function (root) {
  "use strict";
  const MAX_FILE = 10 * 1024 * 1024;
  const SHOW_ROWS = 60;

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === "text") el.textContent = String(v);
      else if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked" || k === "selected" || k === "disabled") el[k] = !!v;
      else el.setAttribute(k, v === true ? "" : String(v));
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach((c) => { if (c == null || c === false) return; el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c); });
    return el;
  }
  const toast = (m, type) => { try { root.BPUI.toast(m, { type: type || "info" }); } catch (e) { /* no toasts */ } };
  const friendly = (e, action) => { try { return root.BPUI.friendlyError(e, { action }); } catch (x) { return (e && e.message) || "Something went wrong."; } };
  function ensureCss() {
    if (document.getElementById("hi-css")) return;
    document.head.appendChild(h("link", { id: "hi-css", rel: "stylesheet", href: "smart-import.css?v=3" }));
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" }));
    const a = h("a", { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function readFile(file) {
    const C = root.HelmImportCore, X = root.HelmXlsx;
    if (!file) throw new Error("Choose a file.");
    if (file.size > MAX_FILE) throw new Error("That file is larger than 10 MB. Split it into smaller files.");
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const kind = X ? X.kindOf(u8) : "text";
    if (kind === "zip") { if (!X) throw new Error("Excel reader not loaded."); const r = await X.readXlsx(buf); return r.rows || []; }
    if (kind === "ole") throw new Error("Old Excel (.xls) files can't be read here. In Excel choose File > Save As > Excel Workbook (.xlsx) or CSV, then import that.");
    return C.parseCSV(C.decode(u8));
  }

  function open(opts) {
    opts = opts || {};
    const C = root.HelmImportCore, S = root.BPStore && root.BPStore.smartImport;
    const entity = String(opts.entity || "");
    if (!C || !C.ENTITIES[entity]) { toast("Import is not available for this list.", "err"); return null; }
    if (!S) { toast("Import needs the latest app files \u2014 reload the page.", "err"); return null; }
    ensureCss();
    const def = C.entityDef(entity);
    const st = { step: "upload", fileName: "", table: null, headerIndex: 0, headers: [], mapping: [], built: null, existing: [], results: [], busy: false, summary: null, saved: null };

    const title = h("h2", { id: "hi-title", class: "hi-title", text: "Import " + def.label.toLowerCase() });
    const body = h("div", { class: "hi-body" });
    const foot = h("div", { class: "hi-foot" });
    const live = h("div", { class: "sr-only", "aria-live": "polite", role: "status" });
    const closeBtn = h("button", { type: "button", class: "hi-x", "aria-label": "Close", text: "\u00D7", onclick: () => close() });
    const sheet = h("div", { class: "hi-sheet" }, [h("div", { class: "hi-head" }, [title, closeBtn]), body, foot, live]);
    const overlay = h("div", { class: "hi-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "hi-title" }, sheet);
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    document.body.appendChild(overlay);
    try { root.BPUI.modal.open(overlay); } catch (e) { /* focus handled below */ }

    function close() {
      if (st.busy) { toast("Import is still running \u2014 wait for it to finish.", "info"); return; }
      try { root.BPUI.modal.close(overlay); } catch (e) { /* noop */ }
      overlay.remove();
      // B5: every page refreshes its list after an import - the callback AND a window event (pages
      // that did not pass onDone, e.g. a list opened from elsewhere, still repaint)
      const sum = st.summary;
      if (typeof opts.onDone === "function") { try { const r = opts.onDone(sum); if (r && typeof r.catch === "function") r.catch(() => {}); } catch (e) { /* caller error */ } }
      if (sum) { try { root.dispatchEvent(new CustomEvent("helm:import-done", { detail: { entity, summary: sum } })); } catch (e) { /* old browser */ } }
    }
    function setFoot(btns) { foot.replaceChildren(...btns.filter(Boolean)); }
    function say(m) { live.textContent = m; }
    function stepper() {
      const steps = [["upload", "1. File"], ["map", "2. Columns"], ["review", "3. Rows"], ["done", "4. Done"]];
      const cur = steps.findIndex((s) => s[0] === (st.step === "run" ? "review" : st.step));
      return h("ol", { class: "hi-steps", "aria-label": "Steps" }, steps.map((s, i) => h("li", { class: i === cur ? "on" : i < cur ? "past" : "", "aria-current": i === cur ? "step" : null, text: s[1] })));
    }
    function render() {
      body.replaceChildren(stepper());
      if (st.step === "upload") renderUpload();
      else if (st.step === "map") renderMap();
      else if (st.step === "review") renderReview();
      else if (st.step === "run") renderRun();
      else renderDone();
      const f = body.querySelector("[data-autofocus]") || body.querySelector("button,select,input");
      if (f) setTimeout(() => { try { f.focus(); } catch (e) { /* noop */ } }, 30);
    }

    /* ---------- 1. upload ---------- */
    function renderUpload() {
      const input = h("input", { type: "file", id: "hi-file", accept: ".xlsx,.xls,.csv,.tsv,.txt", class: "hi-file-input" });
      const err = h("div", { class: "hi-error", role: "alert", hidden: true });
      const zone = h("label", { class: "hi-drop", for: "hi-file", tabindex: "0", "data-autofocus": "1" }, [
        h("strong", { text: "Choose an Excel or CSV file" }), h("span", { text: " or drop it here" }),
        h("small", { text: "Your own sheet is fine \u2014 any column names, any order. We match the columns for you and nothing is saved until you confirm." }),
      ]);
      zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
      const go = async (file) => {
        err.hidden = true; zone.classList.add("busy"); say("Reading file\u2026");
        try {
          const table = await readFile(file);
          if (!table.some((r) => (r || []).some((c) => String(c == null ? "" : c).trim()))) throw new Error("The file is empty.");
          st.fileName = file.name.slice(0, 80); st.table = table;
          const [saved, existing] = await Promise.all([S.getMapping(entity).catch(() => null), S.existing(entity).catch(() => [])]);
          st.saved = saved; st.existing = existing || [];
          const hd = C.detectHeader(table, entity); st.headerIndex = hd.index; st.headers = hd.headers;
          st.mapping = C.autoMap(entity, st.headers, table.slice(hd.index + 1, hd.index + 201), saved);
          st.step = "map"; render(); say("File read. Check the column matches.");
        } catch (e) { err.textContent = (e && e.message) || "Could not read that file."; err.hidden = false; zone.classList.remove("busy"); }
      };
      input.addEventListener("change", () => { if (input.files && input.files[0]) go(input.files[0]); });
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) go(f); });
      const tips = h("ul", { class: "hi-tips" }, [
        h("li", { text: "Columns we don't have a place for are kept as custom fields \u2014 no information is lost." }),
        h("li", { text: "Rows already in Helm are skipped unless you choose to update them." }),
        h("li", { text: "Up to " + C.MAX_ROWS.toLocaleString() + " rows per file (.xlsx or .csv)." }),
      ]);
      body.append(zone, input, err, tips);
      setFoot([h("button", { type: "button", class: "btn", text: "Cancel", onclick: close })]);
    }

    /* ---------- 2. mapping ---------- */
    function samples(c) {
      const out = [];
      for (let i = st.headerIndex + 1; i < st.table.length && out.length < 3; i++) { const v = C.clean((st.table[i] || [])[c]); if (v) out.push(v.length > 40 ? v.slice(0, 40) + "\u2026" : v); }
      return out;
    }
    function badge(m) {
      if (m.target === "ignore") return h("span", { class: "hi-badge mute", text: "Ignored" });
      if (m.target === "custom") return h("span", { class: "hi-badge new", text: "Custom" });
      if (m.why === "saved") return h("span", { class: "hi-badge ok", text: "Saved" });
      if (m.why === "manual") return h("span", { class: "hi-badge ok", text: "Chosen" });
      if (m.confidence >= 0.95) return h("span", { class: "hi-badge ok", text: "Exact" });
      if (m.confidence >= 0.75) return h("span", { class: "hi-badge good", text: "Likely" });
      return h("span", { class: "hi-badge warn", text: "Check" });
    }
    function renderMap() {
      const used = new Map(); st.mapping.forEach((m, c) => { if (/^field:/.test(m.target)) used.set(m.target, c); });
      const missing = def.fields.filter((f) => f.required && !used.has("field:" + f.key) && !(f.key === "name" && (used.has("field:first_name") || used.has("field:last_name"))));
      const hdrSel = h("select", { id: "hi-hdr", class: "hi-sel" }, st.table.slice(0, 20).map((r, i) => h("option", { value: String(i), selected: i === st.headerIndex, text: "Row " + (i + 1) + ": " + (r || []).map(C.clean).filter(Boolean).slice(0, 4).join(", ").slice(0, 60) })));
      hdrSel.addEventListener("change", () => {
        st.headerIndex = Number(hdrSel.value); const r = st.table[st.headerIndex] || [];
        const width = Math.max(r.length, ...st.table.slice(st.headerIndex + 1, st.headerIndex + 50).map((x) => (x || []).length));
        st.headers = Array.from({ length: width }, (_, c) => C.clean(r[c]));
        st.mapping = C.autoMap(entity, st.headers, st.table.slice(st.headerIndex + 1, st.headerIndex + 201), st.saved); renderMap0();
      });
      const intro = h("p", { class: "hi-note" }, [h("strong", { text: st.fileName }), " \u2014 " + (st.table.length - st.headerIndex - 1).toLocaleString() + " data rows. Check where each column goes. Columns marked Custom are saved as extra fields on each " + def.noun + "."]);
      const hdrRow = h("div", { class: "hi-row" }, [h("label", { for: "hi-hdr", text: "Column names are in" }), hdrSel]);
      const warn = missing.length ? h("div", { class: "hi-warn", role: "note", text: "Not found in your sheet: " + missing.map((f) => f.label).join(", ") + ". Pick the column for it below, or those rows will be flagged." }) : null;
      const tbl = h("table", { class: "hi-table hi-maptable" }, [
        h("caption", { class: "sr-only", text: "Column mapping" }),
        h("thead", {}, h("tr", {}, [h("th", { scope: "col", text: "Your column" }), h("th", { scope: "col", text: "Sample values" }), h("th", { scope: "col", text: "Goes to" }), h("th", { scope: "col", text: "Match" })])),
        h("tbody", {}, st.headers.map((hd, c) => {
          const m = st.mapping[c] || { target: "ignore" };
          const id = "hi-m-" + c;
          const std = def.fields.filter((f) => f.std), more = def.fields.filter((f) => !f.std);
          const opt = (f) => h("option", { value: "field:" + f.key, selected: m.target === "field:" + f.key, text: f.label + (f.required ? " *" : "") + (used.has("field:" + f.key) && used.get("field:" + f.key) !== c ? " (in use)" : "") });
          const sel = h("select", { id, class: "hi-sel" }, [
            h("optgroup", { label: "Main fields" }, std.map(opt)),
            h("optgroup", { label: "More fields" }, more.map(opt)),
            h("optgroup", { label: "Other" }, [h("option", { value: "custom", selected: m.target === "custom", text: "Keep as custom field" }), h("option", { value: "ignore", selected: m.target === "ignore", text: "Ignore this column" })]),
          ]);
          sel.addEventListener("change", () => {
            const v = sel.value;
            if (/^field:/.test(v)) st.mapping.forEach((o, k) => { if (k !== c && o.target === v) { o.target = "custom"; o.why = "manual"; if (!o.key) { o.label = st.headers[k] || "Column " + (k + 1); o.key = C.slugKey(o.label, new Set(st.mapping.map((x) => x.key).filter(Boolean).concat(def.fields.map((f) => f.key)))); } } });
            m.target = v; m.why = "manual"; m.confidence = 1;
            if (v === "custom" && !m.key) { m.label = hd || "Column " + (c + 1); m.key = C.slugKey(m.label, new Set(st.mapping.map((x) => x.key).filter(Boolean).concat(def.fields.map((f) => f.key)))); }
            st.mapping[c] = m; renderMap0();
          });
          const labelIn = m.target === "custom" ? h("input", { type: "text", class: "hi-in", maxlength: "80", value: m.label || hd, "aria-label": "Custom field name for column " + (hd || c + 1) }) : null;
          if (labelIn) labelIn.addEventListener("change", () => { m.label = C.clean(labelIn.value).slice(0, 80) || hd; });
          return h("tr", { class: m.target === "ignore" ? "off" : "" }, [
            h("th", { scope: "row" }, h("label", { for: id, text: hd || "(no name) column " + (c + 1) })),
            h("td", { class: "hi-samp" }, samples(c).map((s) => h("span", { text: s }))),
            h("td", {}, [sel, labelIn]),
            h("td", {}, badge(m)),
          ]);
        })),
      ]);
      body.append(intro, hdrRow, warn || "", h("div", { class: "hi-scroll" }, tbl));
      setFoot([
        h("button", { type: "button", class: "btn", text: "Back", onclick: () => { st.step = "upload"; render(); } }),
        h("button", { type: "button", class: "btn primary", text: "Next: check rows", onclick: () => { build(); st.step = "review"; render(); } }),
      ]);
    }
    function renderMap0() { const sc = body.querySelector(".hi-scroll"), top = sc ? sc.scrollTop : 0; body.replaceChildren(stepper()); renderMap(); const n = body.querySelector(".hi-scroll"); if (n) n.scrollTop = top; }

    /* ---------- 3. review ---------- */
    function build() {
      st.built = C.buildRows(entity, st.table, st.headerIndex, st.mapping);
      C.markDuplicates(entity, st.built.rows, st.existing);
    }
    function statusBadge(r) {
      if (r.status === "error") return h("span", { class: "hi-badge bad", text: "Fix needed" });
      if (r.status === "duplicate") return h("span", { class: "hi-badge warn", text: "Already in Helm" });
      if (r.status === "dup-in-file") return h("span", { class: "hi-badge warn", text: "Repeated row" });
      return h("span", { class: "hi-badge ok", text: "New" });
    }
    function renderReview() {
      const rows = st.built.rows, sum = C.summarise(rows);
      let onlyProblems = st.onlyProblems === true;
      const counts = h("p", { class: "hi-counts" }, [
        h("span", { class: "hi-badge ok", text: sum.create + " to add" }), " ",
        h("span", { class: "hi-badge good", text: sum.update + " to update" }), " ",
        h("span", { class: "hi-badge mute", text: sum.skip + " to skip" }), " ",
        sum.errors ? h("span", { class: "hi-badge bad", text: sum.errors + " need fixing (skipped)" }) : "",
      ]);
      const notes = [];
      if (st.built.truncated) notes.push("Only the first " + C.MAX_ROWS.toLocaleString() + " rows are used. Import the rest from a second file.");
      if (st.built.skippedBlank) notes.push(st.built.skippedBlank + " blank or repeated-header row(s) ignored.");
      const dups = rows.filter((r) => r.status === "duplicate");
      const bulk = dups.length ? h("div", { class: "hi-row" }, [
        h("label", { for: "hi-bulk", text: dups.length + " row(s) already exist in Helm:" }),
        (() => { const s = h("select", { id: "hi-bulk", class: "hi-sel" }, [h("option", { value: "skip", text: "Skip them (keep what's in Helm)" }), h("option", { value: "update", text: "Update them with this sheet" })]);
          s.value = dups.every((r) => r.action === "update") ? "update" : "skip";
          s.addEventListener("change", () => { dups.forEach((r) => C.setAction(entity, r, s.value)); renderReview0(); }); return s; })(),
      ]) : null;
      const toggle = h("label", { class: "hi-chk" }, [h("input", { type: "checkbox", checked: onlyProblems, onchange: (e) => { st.onlyProblems = e.target.checked; renderReview0(); } }), " Show only rows that need attention"]);
      const shown = (onlyProblems ? rows.filter((r) => r.status !== "new") : rows).slice(0, SHOW_ROWS);
      const tbl = h("table", { class: "hi-table" }, [
        h("caption", { class: "sr-only", text: "Rows to import" }),
        h("thead", {}, h("tr", {}, [h("th", { scope: "col", text: "Row" }), h("th", { scope: "col", text: "Status" }), h("th", { scope: "col", text: "Name" }), h("th", { scope: "col", text: "Details" }), h("th", { scope: "col", text: "Action" })])),
        h("tbody", {}, shown.map((r) => {
          const acts = C.actionsFor(entity, r);
          const label = { create: "Add new", update: "Update existing", skip: "Skip" };
          const sel = acts.length > 1 ? h("select", { class: "hi-sel sm", "aria-label": "Action for row " + r.line }, acts.map((a) => h("option", { value: a, selected: r.action === a, text: label[a] }))) : h("span", { text: label[r.action] });
          if (acts.length > 1) sel.addEventListener("change", () => { C.setAction(entity, r, sel.value); renderReview0(); });
          const det = Object.entries(r.fields).filter(([k]) => k !== "name").map(([k, v]) => (C.fieldOf(entity, k) || { label: k }).label + ": " + (Array.isArray(v) ? v.join(", ") : v))
            .concat(Object.keys(r.attributes).length ? ["+" + Object.keys(r.attributes).length + " more"] : []).join(" \u00B7 ");
          return h("tr", { class: r.status === "error" ? "hi-err" : r.status === "new" ? "" : "hi-dup" }, [
            h("td", { text: String(r.line) }), h("td", {}, statusBadge(r)),
            h("th", { scope: "row", text: r.fields.name || "\u2014" }),
            h("td", {}, [h("div", { class: "hi-det", text: det }),
              r.errors.length ? h("div", { class: "hi-errtxt", text: r.errors.join("; ") }) : null,
              r.match ? h("div", { class: "hi-dettxt", text: "Matches \u201C" + (r.match.name || "") + "\u201D" + (r.match.active === false ? " (inactive)" : "") }) : null,
              r.dupInFile ? h("div", { class: "hi-dettxt", text: "Same as row " + r.dupInFile }) : null]),
            h("td", {}, sel),
          ]);
        })),
      ]);
      const more = rows.length > shown.length && !onlyProblems ? h("p", { class: "hi-note", text: "Showing the first " + shown.length + " of " + rows.length.toLocaleString() + " rows. All rows will be imported as listed in the totals." }) : null;
      body.append(counts, ...notes.map((n) => h("p", { class: "hi-note", text: n })), bulk || "", toggle, h("div", { class: "hi-scroll" }, tbl), more || "");
      const n = sum.create + sum.update;
      setFoot([
        h("button", { type: "button", class: "btn", text: "Back", onclick: () => { st.step = "map"; render(); } }),
        sum.errors ? h("button", { type: "button", class: "btn", text: "Download rows to fix", onclick: () => download("import-problems.csv", C.resultsCSV(st.headers, rows.filter((r) => r.status === "error"), [])) }) : null,
        h("button", { type: "button", class: "btn primary", text: n ? "Import " + n.toLocaleString() + " row(s)" : "Nothing to import", disabled: !n, onclick: run }),
      ]);
    }
    function renderReview0() { const sc = body.querySelector(".hi-scroll"), top = sc ? sc.scrollTop : 0; body.replaceChildren(stepper()); renderReview(); const n = body.querySelector(".hi-scroll"); if (n) n.scrollTop = top; }

    /* ---------- 4. run ---------- */
    let prog = null;
    function renderRun() {
      prog = h("progress", { max: "100", value: "0", "aria-label": "Import progress" });
      body.append(h("p", { class: "hi-note", text: "Importing\u2026 keep this window open." }), prog);
      setFoot([]);
    }
    async function run() {
      const p = C.payloads(entity, st.built.rows, st.mapping);
      st.busy = true; st.step = "run"; st.results = []; render();
      S.saveMapping(entity, C.mappingToSaved(st.headers, st.mapping)).catch(() => {});
      let done = 0, fatal = null;
      const total = p.batches.reduce((a, b) => a + b.length, 0);
      for (let b = 0; b < p.batches.length; b++) {
        const batch = p.batches[b];
        if (fatal) { batch.forEach((r) => st.results.push({ i: r.i, status: "error", error: "Not imported: " + fatal })); continue; }
        try {
          const res = await S.importBatch(entity, batch, b === 0 ? p.defs : []);
          (Array.isArray(res) ? res : []).forEach((x) => st.results.push(x));
        } catch (e) {
          const msg = friendly(e, "import");
          const perm = e && (e.code === "42501" || /not authorized|read-only|password/i.test(String(e.message || "")));
          if (perm) fatal = msg;
          batch.forEach((r) => st.results.push({ i: r.i, status: "error", error: msg }));
        }
        done += batch.length; if (prog) prog.value = String(Math.round((done / Math.max(1, total)) * 100));
        say("Imported " + done + " of " + total);
      }
      const cnt = { created: 0, updated: 0, errors: 0 };
      st.results.forEach((x) => { if (x.status === "created") cnt.created++; else if (x.status === "updated") cnt.updated++; else cnt.errors++; });
      cnt.skipped = st.built.rows.filter((r) => r.action === "skip" && r.status !== "error").length;
      cnt.errors += st.built.rows.filter((r) => r.status === "error").length;
      st.summary = { created: cnt.created, updated: cnt.updated, skipped: cnt.skipped, errors: cnt.errors };
      st.busy = false; st.step = "done"; render();
    }

    /* ---------- 5. done ---------- */
    function renderDone() {
      const s = st.summary || { created: 0, updated: 0, skipped: 0, errors: 0 };
      const failed = st.results.filter((x) => x.status === "error").length;
      body.append(
        h("h3", { class: "hi-h3", text: s.created + s.updated ? "Import finished" : "Nothing was imported" }),
        h("ul", { class: "hi-sum" }, [
          h("li", {}, [h("strong", { text: String(s.created) }), " added"]),
          h("li", {}, [h("strong", { text: String(s.updated) }), " updated"]),
          h("li", {}, [h("strong", { text: String(s.skipped) }), " skipped (already in Helm or repeated)"]),
          h("li", { class: s.errors - failed ? "bad" : "" }, [h("strong", { text: String(s.errors - failed) }), " not imported because they need fixing"]),
          h("li", { class: failed ? "bad" : "" }, [h("strong", { text: String(failed) }), " failed while saving"]),
        ]),
        h("p", { class: "hi-note", text: "Download the results to see what happened to every row; rows that failed can be fixed and imported again." }));
      setFoot([
        h("button", { type: "button", class: "btn", text: "Download results (CSV)", onclick: () => download("import-results-" + entity + ".csv", C.resultsCSV(st.headers, st.built.rows, st.results)) }),
        h("button", { type: "button", class: "btn primary", text: "Done", "data-autofocus": "1", onclick: close }),
      ]);
      say("Import finished: " + s.created + " added, " + s.updated + " updated.");
    }

    render();
    return { close };
  }

  /* ---------- custom attribute display / edit helpers for list + detail pages ---------- */
  // DOM fragment of "Label: value" chips (read-only) for a row's attributes
  function attrChips(entity, attrs, defs, max) {
    const C = root.HelmImportCore; const frag = document.createDocumentFragment();
    if (!C) return frag;
    const list = C.attrList(entity, attrs, defs); const lim = max || 6;
    list.slice(0, lim).forEach((a) => frag.appendChild(h("span", { class: "tag hi-attr", title: a.label + ": " + a.value }, [h("b", { text: a.label + ": " }), a.value.length > 40 ? a.value.slice(0, 40) + "\u2026" : a.value])));
    if (list.length > lim) frag.appendChild(h("span", { class: "tag hi-attr", text: "+" + (list.length - lim) + " more" }));
    return frag;
  }
  // editable custom-field inputs; returns { el, read() → attributes object (only changed/known keys) }
  function attrEditor(entity, attrs, defs, readOnly) {
    const C = root.HelmImportCore; const a = Object.assign({}, attrs || {});
    const keys = new Map();
    (defs || []).filter((d) => d.active !== false).forEach((d) => keys.set(d.key, d.label));
    if (C) C.attrList(entity, a, defs).forEach((x) => { if (!keys.has(x.key)) keys.set(x.key, x.label); });
    const inputs = [];
    const el = h("div", { class: "hi-attrs" }, keys.size ? [...keys].map(([k, label], i) => {
      const id = "hi-a-" + entity + "-" + i;
      const inp = h("input", { id, type: "text", class: "hi-in", maxlength: "500", value: a[k] == null ? "" : String(a[k]), readonly: readOnly ? "readonly" : null });
      inputs.push([k, inp]);
      return h("div", { class: "fld" }, [h("label", { for: id, text: label }), inp]);
    }) : [h("p", { class: "hi-note", text: "No custom fields yet. Import a sheet or ask an admin to add fields in Settings." })]);
    return {
      el,
      read() { const out = Object.assign({}, a); inputs.forEach(([k, inp]) => { const v = String(inp.value || "").trim().slice(0, 500); if (v) out[k] = v; else delete out[k]; }); return out; },
      // only what the user changed: { set: {key: value}, unset: [key] } (a cleared box unsets ONLY that key)
      changes() { const set = {}, unset = []; inputs.forEach(([k, inp]) => { const v = String(inp.value || "").trim().slice(0, 500), was = a[k] == null ? "" : String(a[k]);
        if (v === was) return; if (v) set[k] = v; else unset.push(k); }); return { set, unset, any: Object.keys(set).length + unset.length > 0 }; },
    };
  }

  // apply {set, unset} onto a base attributes object (never touches other keys)
  function mergeAttrs(base, ch) {
    const out = Object.assign({}, base && typeof base === "object" && !Array.isArray(base) ? base : {});
    if (ch && ch.set) Object.keys(ch.set).forEach((k) => { out[k] = ch.set[k]; });
    if (ch && Array.isArray(ch.unset)) ch.unset.forEach((k) => { delete out[k]; });
    return out;
  }
  if (typeof document !== "undefined" && document.head) ensureCss();
  root.HelmImport = { open, attrChips, attrEditor, mergeAttrs, version: 2 };
})(typeof window !== "undefined" ? window : this);
