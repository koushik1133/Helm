import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const EN = require("../public/event-name.js");
assert.equal(EN.isAuto("VIP", "08102026-01"), false, "manual 3-letter rename kept");
assert.equal(EN.isAuto("WED", "x"), true);
assert.equal(EN.isAuto("WED-2", "x"), true);
assert.equal(EN.isAuto("WED_HYD_100_19AUG26-3", "x"), true);
const X = require("../public/xlsx-lite.js");
// zip whose only entry is named __proto__ / constructor must not resolve via the prototype
function zipWith(name) {
  const nb = new TextEncoder().encode(name); const data = new TextEncoder().encode("<x/>");
  const lh = new Uint8Array(30 + nb.length); const lv = new DataView(lh.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nb.length, true); lh.set(nb, 30);
  const ch = new Uint8Array(46 + nb.length); const cv = new DataView(ch.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nb.length, true); ch.set(nb, 46);
  const cdOff = lh.length + data.length; const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, ch.length, true); ev.setUint32(16, cdOff, true);
  const out = new Uint8Array(cdOff + ch.length + 22); out.set(lh, 0); out.set(data, lh.length); out.set(ch, cdOff); out.set(end, cdOff + ch.length); return out;
}
for (const n of ["__proto__", "constructor"]) await assert.rejects(X.readXlsx(zipWith(n)), /Not an Excel workbook|Not a valid/);
console.log("r4c-bughunt: ok");
