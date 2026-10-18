// trial-data-v3: the "Templates" rail item is hidden behind a flag (page kept), and an empty booklet
// Terms box starts with the studio's own terms (pricing termsText).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sh = r("public/shell-b.js");
assert.match(sh, /if \(!\(window\.HELM_FLAGS && window\.HELM_FLAGS\.navTemplates === true\)\) skip\.templates = 1;/);
assert.ok(sh.indexOf("skip.templates = 1") > sh.indexOf("var skip = { dashboard: 1"), "flag sits after the skip list");
assert.ok(r("public/templates.html").length > 0, "templates page still shipped");
const bk = r("public/booklet-share.js");
assert.match(bk, /pc\.termsText/); assert.match(bk, /if \(!terms\.value\)/);
const mig = r("supabase/migrations/0169_trial_data_v3.sql");
assert.ok(/^[\x00-\x7F]*$/.test(mig), "0169 is ASCII only");
assert.ok(/^[\x00-\x7F]*$/.test(r("supabase/APPLY-0169.sql")), "APPLY-0169 is ASCII only");
console.log("trial-data-v3-ui: ALL PASS");
