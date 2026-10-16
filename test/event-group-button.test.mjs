// Event group (0035) button: confirmed events show a clear Create/Open event group button
// at the bottom of the event workspace (managers only to create) and the quotes picker deep-link works.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const ev = readFileSync(new URL("../public/event.html", import.meta.url), "utf8");
const qs = readFileSync(new URL("../public/quotes.html", import.meta.url), "utf8");
// event workspace: bottom panel after the files panel, inside <main>
const iPanel = ev.indexOf('id="egPanel"'), iFiles = ev.indexOf('id="filesPanel"'), iMain = ev.indexOf("</main>");
assert.ok(iPanel > iFiles && iPanel < iMain, "event group panel sits at the bottom of the workspace");
assert.match(ev, /if\(ev\.status!=="confirmed"\)\{ sec\.hidden=true; return; \}/, "hidden until confirmed");
assert.match(ev, /\} else if\(canEdit\)\{/, "create only for users who can manage the event");
assert.match(ev, /Open event group/); assert.match(ev, /Create event group/);
assert.match(ev, /quotes\.html\?egroup=/); assert.match(ev, /chat\.html\?c=/);
assert.match(ev, /renderEventGroup\(\);/, "rendered with the workspace");
assert.ok(!/id="egPanel"[^>]*style=/.test(ev), "no inline style attr");
// quotes: deep-link + gating + preselection
assert.match(qs, /get\("egroup"\)/, "?egroup= opens the picker");
assert.match(qs, /egIndex\[x\.id\]\|\|\(canEdit&&x\.status==="confirmed"\)/, "create button gated by canEdit");
assert.match(qs, /if\(!canEdit\)\{ BPUI\.toast\("Ask an admin or manager/, "server-call guarded for viewers");
assert.match(qs, /p\.role==="owner"\|\|p\.role==="admin"/, "admins pre-ticked");
assert.match(qs, /BPStore\.staff\.forEvent\(id\)/, "assigned staff pre-ticked");
assert.match(qs, /"💬 Open event group":"💬 Create event group"/, "button label flips to Open once created");
assert.match(qs, /q=await BPStore\.quotes\.get\(id\)/, "deep link works when quote is off the current page");
console.log("event-group-button: ok");
