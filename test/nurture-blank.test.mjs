// 0107: blank birthday / anniversary templates get the default text; the page never saves an empty one.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const mig = readFileSync("supabase/migrations/0107_nurture_fill_blank.sql", "utf8");
const app = readFileSync("supabase/APPLY-0107.sql", "utf8");
assert.match(mig, /btrim\(coalesce\(t\.body, ''\)\) = ''/, "only blank bodies are filled");
assert.ok(!/delete\s+from/i.test(mig + app), "no deletes");
assert.ok(app.includes(mig.trim()), "APPLY-0107 contains the migration verbatim");
assert.ok(!/[^\x00-\x7F]/.test(app), "APPLY-0107 is ASCII");
for (const k of ["birthday", "anniversary"]) assert.ok(mig.includes("$t$" + k + "$t$"), k);
const html = readFileSync("public/nurture.html", "utf8");
assert.match(html, /an empty template would send a blank greeting/, "save refuses an empty body");
assert.match(html, /This template was empty - showing the default text/, "blank template shows the default");
console.log("nurture-blank: ok");
