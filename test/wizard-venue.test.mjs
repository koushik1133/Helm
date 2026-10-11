// Create-layout wizard: "Saved venue" picker fills the hall size and links the venue to the event.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const js = readFileSync("public/layout-wizard.js", "utf8");
assert.match(js, /field\('Saved venue', venueSel\(\)/, "step 1 has the Saved venue field");
assert.match(js, /S\.venues\.list\(\)/, "loads the studio's venues");
assert.match(js, /spec\.hall\.w = clamp\(Math\.round\(f\.lenFt\)/, "length from the venue");
assert.match(js, /spec\.hall\.h = clamp\(Math\.round\(f\.widFt\)/, "width from the venue");
assert.match(js, /B\.link\(v \|\| null\)/, "links the venue to the event");
assert.match(readFileSync("public/builder.html", "utf8"), /layout-wizard\.js\?v=8/, "cache bust");
console.log("wizard-venue: ok");
