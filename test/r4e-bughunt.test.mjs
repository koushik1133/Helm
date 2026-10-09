// R4-E: booklet capture must never upload pictures to a quote/version other than the one it started on.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const src = readFileSync(new URL("../public/builder.js", import.meta.url), "utf8");
const cap = src.slice(src.indexOf("async function captureClientImages"), src.indexOf("async function autoCaptureIfStale"));
assert.match(cap, /const qid=currentQuoteId, vno=currentVersionNo, sig=docSig\(\)/, "capture pins quote/version/layout");
assert.match(cap, /if\(moved\(\)\) return false;\s*if\(p2\[v\]\) await BPStore\.booklet\.putImage\(qid,'2d'/, "aborts before upload when switched");
assert.ok(!/putImage\(currentQuoteId/.test(cap), "uploads use the pinned id, not the live one");
const auto = src.slice(src.indexOf("async function autoCaptureIfStale"), src.indexOf("function importJSON"));
assert.match(auto, /currentQuoteId!==qid \|\| isViewingOlder\(\) \|\| docSig\(\)!==savedSig\) return;\s*if\(\['2d','3d'\]\.some\(k=>old\(k,'labels'\)/, "re-checks after async staleness lookups");
console.log("r4e-bughunt: ok");
// R4-E: no background booklet capture for closed / cancelled / archived events
assert.match(src, /frozen: q\.lifecycleStage==='closed' \|\| q\.status==='cancelled' \|\| !!q\.archivedAt/);
assert.match(auto, /if\(currentQuoteGuard\.frozen\) return;/);
console.log("r4e-bughunt frozen: ok");
