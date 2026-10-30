// r79: every quotes.updateMeta call that writes client details or the event date must pass the
// optimistic-lock token (the record's updatedAt) so concurrent edits can't silently overwrite each other.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const files = ["public/flow.html", "public/event.html", "public/calendar.html", "public/quotes.html"];
let checked = 0;
for (const f of files) {
  const src = readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const re = /BPStore\.quotes\.updateMeta\(/g; let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1;
    while (depth && i < src.length) { const c = src[i++]; if (c === "(") depth++; else if (c === ")") depth--; }
    const args = src.slice(m.index + m[0].length, i - 1);
    const line = src.slice(0, m.index).split("\n").length;
    // patch is either an inline object or a variable named "patch"
    const writesClientOrDate = /\bclient\b|eventDate/.test(args.split("}")[0]) || /^\s*[\w.]+\s*,\s*patch\b/.test(args);
    if (!writesClientOrDate) continue;
    // exempt: quotes.html column sync that re-writes the date the user JUST saved under the lock
    // (or under confirm()'s own stale check) a moment earlier in the same handler
    if (f === "public/quotes.html" && /^\s*cmId,\s*\{\s*eventDate:\s*client\.eventDate\s*\}\s*$/.test(args)) continue;
    // a third argument (lock token) after the patch
    const after = args.includes("}") ? args.slice(args.indexOf("}") + 1) : args.replace(/^[^,]*,\s*patch/, "");
    assert.match(after, /,\s*[\w.]+/, `${f}:${line} updateMeta writes client/date without the updatedAt lock`);
    checked++;
  }
}
assert.ok(checked >= 5, "expected at least 5 client/date updateMeta call sites, found " + checked);
// store contract: with a lock, the update is filtered on updated_at and 0 rows -> CONFLICT
const store = readFileSync(new URL("../public/store-api.js", import.meta.url), "utf8");
assert.match(store, /if \(expectedUpdatedAt\) q = q\.eq\("updated_at", expectedUpdatedAt\)/);
assert.match(store, /e\.code = "CONFLICT"/);
console.log("r79 lost-update lock: OK (" + checked + " call sites)");
