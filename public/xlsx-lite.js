/* =========================================================================
   HELM — minimal, dependency-free Excel (.xlsx) reader + template writer.
   Self-hosted (no CDN, no CSP change). Reads the FIRST worksheet's cell VALUES
   only: shared strings, inline strings, numbers, booleans. Formulas are never
   evaluated (their cached value is used). Legacy binary .xls (BIFF/OLE) is not
   parsed; the caller is told to re-save as .xlsx or CSV.
   Unzip uses the browser's DecompressionStream("deflate-raw").
   Loaded as window.HelmXlsx; tests require() it (Node 18+ has DecompressionStream).
   ========================================================================= */
(function (root) {
  "use strict";
  const MAX_ENTRY = 20 * 1024 * 1024;   // uncompressed cap per part (zip-bomb guard)
  const MAX_ROWS = 5000, MAX_COLS = 60;

  function kindOf(u8) {
    if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04) return "zip";
    if (u8.length >= 8 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return "ole";
    return "text";
  }

  // central directory -> { name: {method, csize, usize, offset} }
  function listZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a valid .xlsx file.");
    const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const out = {}; const td = new TextDecoder("utf-8");
    for (let k = 0; k < n && k < 2000; k++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("Not a valid .xlsx file.");
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      out[td.decode(u8.subarray(p + 46, p + 46 + nl))] = { method, csize, usize, offset: off };
      p += 46 + nl + el + cl;
    }
    return out;
  }
  async function inflateRaw(data) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot open .xlsx files. Save the sheet as CSV and import that.");
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const reader = stream.getReader(); const parts = []; let total = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length;
      if (total > MAX_ENTRY) { try { reader.cancel(); } catch (e) {} throw new Error("The spreadsheet is too large."); }
      parts.push(value); }
    const out = new Uint8Array(total); let o = 0; parts.forEach((x) => { out.set(x, o); o += x.length; }); return out;
  }
  async function readEntry(u8, dir, name) {
    const e = dir[name]; if (!e) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error("Not a valid .xlsx file.");
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    const data = u8.subarray(start, start + e.csize);
    let raw;
    if (e.method === 0) raw = data; else if (e.method === 8) raw = await inflateRaw(data); else throw new Error("Unsupported .xlsx compression.");
    if (raw.length > MAX_ENTRY) throw new Error("The spreadsheet is too large.");
    return new TextDecoder("utf-8").decode(raw);
  }

  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  function unxml(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      if (e[0] === "#") { const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; }
      return ENT[e.toLowerCase()] || m;
    });
  }
  // concatenated <t> text of a shared-string / inline-string item (rich text runs included, phonetic <rPh> skipped)
  function textOf(xml) {
    const noPh = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let out = ""; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g; let m;
    while ((m = re.exec(noPh))) out += m[1] ? unxml(m[1]) : "";
    return out;
  }
  function parseShared(xml) {
    const out = []; if (!xml) return out; const re = /<si>([\s\S]*?)<\/si>|<si\/>/g; let m;
    while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : "");
    return out;
  }
  function colIndex(ref) { const m = /^([A-Z]+)/.exec(ref || ""); if (!m) return -1; let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
  function fmtNum(v) { const n = Number(v); if (!Number.isFinite(n)) return String(v); return String(Math.round(n * 1e10) / 1e10); }
  // sheet XML -> string[][] (values only)
  function parseSheet(xml, shared) {
    const rows = []; const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g; let rm, nextRow = 0;
    while ((rm = rowRe.exec(xml))) {
      const rAttr = /\br="(\d+)"/.exec(rm[1]); const ri = rAttr ? Number(rAttr[1]) - 1 : nextRow; nextRow = ri + 1;
      if (ri >= MAX_ROWS + 1) break;
      const cells = []; const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm, nextCol = 0;
      while ((cm = cRe.exec(rm[2]))) {
        const attrs = cm[1]; const body = cm[2] || "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs); const ci = ref ? colIndex(ref[1]) : nextCol; nextCol = ci + 1;
        if (ci < 0 || ci >= MAX_COLS) continue;
        const t = (/\bt="(\w+)"/.exec(attrs) || [])[1] || "n";
        const vm = /<v>([\s\S]*?)<\/v>/.exec(body); const v = vm ? unxml(vm[1]) : "";
        let val;
        if (t === "s") val = shared[Number(v)] != null ? shared[Number(v)] : "";
        else if (t === "inlineStr") val = textOf((/<is>([\s\S]*?)<\/is>/.exec(body) || [])[1] || "");
        else if (t === "b") val = v === "1" ? "TRUE" : v === "0" ? "FALSE" : v;
        else if (t === "e") val = "";
        else if (t === "str") val = v;
        else val = v === "" ? "" : fmtNum(v);
        cells[ci] = val;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = "";
      while (rows.length < ri) rows.push([]);
      rows[ri] = cells;
    }
    return rows;
  }
  // first worksheet path from workbook.xml + rels (falls back to sheet1.xml)
  function firstSheetPath(wb, rels, dir) {
    const sm = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb || "") || /<sheet\b[^>]*\bid="([^"]+)"/.exec(wb || "");
    if (sm && rels) {
      const re = /<Relationship\b([^>]*)\/?>/g; let m;
      while ((m = re.exec(rels))) {
        const id = (/\bId="([^"]+)"/.exec(m[1]) || [])[1], tg = (/\bTarget="([^"]+)"/.exec(m[1]) || [])[1];
        if (id === sm[1] && tg) { const path = tg.charAt(0) === "/" ? tg.slice(1) : "xl/" + tg.replace(/^\.\//, ""); if (dir[path]) return path; }
      }
    }
    if (dir["xl/worksheets/sheet1.xml"]) return "xl/worksheets/sheet1.xml";
    const any = Object.keys(dir).filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k)).sort()[0];
    if (!any) throw new Error("No worksheet found in this file.");
    return any;
  }
  // ArrayBuffer|Uint8Array -> { rows: string[][], sheetNames }
  async function readXlsx(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const k = kindOf(u8);
    if (k === "ole") { const e = new Error("Old Excel (.xls) files can't be imported, for safety. Download the .xlsx template below and copy your rows into it, or in Excel choose File > Save As > Excel Workbook (.xlsx), then import that."); e.code = "xls_legacy"; throw e; }
    if (k !== "zip") throw new Error("Not a valid .xlsx file.");
    const dir = listZip(u8);
    const wb = await readEntry(u8, dir, "xl/workbook.xml");
    if (wb == null) throw new Error("Not an Excel workbook.");
    const rels = await readEntry(u8, dir, "xl/_rels/workbook.xml.rels");
    const shared = parseShared(await readEntry(u8, dir, "xl/sharedStrings.xml"));
    const sheetXml = await readEntry(u8, dir, firstSheetPath(wb, rels, dir));
    const names = []; const nr = /<sheet\b[^>]*\bname="([^"]*)"/g; let m; while ((m = nr.exec(wb))) names.push(unxml(m[1]));
    return { rows: parseSheet(sheetXml || "", shared), sheetNames: names };
  }
  // rows -> CSV text (plain RFC-4180 quoting; formula neutralising happens at validation)
  function toCSV(rows) {
    return (rows || []).map((r) => (r || []).map((c) => { const s = String(c == null ? "" : c); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\r\n") + "\r\n";
  }

  /* ---------- template writer: stored (uncompressed) zip, inline strings ---------- */
  let CRC = null;
  function crc32(u8) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStored(files) {
    const te = new TextEncoder(); const locals = []; const centrals = []; let offset = 0;
    files.forEach(([name, text]) => {
      const nb = te.encode(name), data = te.encode(text), crc = crc32(data);
      const lh = new Uint8Array(30 + nb.length); const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nb.length, true); lh.set(nb, 30);
      const ch = new Uint8Array(46 + nb.length); const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nb.length, true); cv.setUint32(42, offset, true); ch.set(nb, 46);
      locals.push(lh, data); centrals.push(ch); offset += lh.length + data.length;
    });
    const csize = centrals.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array(22); const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, csize, true); ev.setUint32(16, offset, true);
    const parts = locals.concat(centrals, [end]); const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let o = 0; parts.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  }
  const xesc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  function colName(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  // rows: string[][] (header first) -> Uint8Array of a one-sheet .xlsx; every cell is text
  function buildXlsx(rows, sheetName) {
    const sd = (rows || []).map((r, ri) => `<row r="${ri + 1}">` + (r || []).map((c, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xesc(c)}</t></is></c>`).join("") + "</row>").join("");
    const nm = xesc(String(sheetName || "Sheet1").replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
    return zipStored([
      ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${nm}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ["xl/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
      ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sd}</sheetData></worksheet>`],
    ]);
  }

  const api = { kindOf, readXlsx, parseSheet, parseShared, toCSV, buildXlsx, colIndex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.HelmXlsx = api;
})(typeof window !== "undefined" ? window : null);
