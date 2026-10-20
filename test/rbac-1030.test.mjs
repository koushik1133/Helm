// rbac-1030: Roles & access matrix changes must take effect on the next page load, and
// page edit/delete controls must follow the matrix (not the fixed role-cap list).
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const rd = (f) => readFileSync(new URL("../public/" + f, import.meta.url), "utf8");
const api = rd("store-api.js");
assert.ok(!/revalidateAccess/.test(api), "no stale-while-revalidate for role/matrix");
assert.ok(/cached && cached\.val && cached\.fresh\) \{ roleCache = cached\.val; return roleCache; \}/.test(api), "role: fresh snapshot only");
assert.ok(/csnap && csnap\.val && csnap\.fresh && csnap\.val\.role/.test(api), "matrix: fresh snapshot only");
assert.ok(/accessCache = null; try \{ sessionStorage\.removeItem\("bp_sess_access"\)/.test(api), "setAccess drops the session matrix");
assert.ok(/canEdit = await BPStore\.auth\.canEditArea\("quotes"\)/.test(rd("event.html")), "event page edit follows quotes matrix");
for (const f of ["teardown", "settlement", "closure", "logistics", "inventory", "budget", "issues", "staff", "runsheet"])
  assert.ok(rd(f + ".html").includes('canDelete=canEdit && await BPStore.auth.can("delete");'), f + ": delete needs area edit");
// r24: the resource plan reads its role checks in parallel - delete still needs the area edit AND the delete right
assert.ok(rd("resources.html").includes('ok(()=>A.canEditArea("resources")), ok(()=>A.can("delete")),') && rd("resources.html").includes("canEdit=!!ce; canDelete=canEdit && !!cd;"), "resources: delete needs area edit");
assert.ok(rd("leads.html").includes("canDelete=!!(d1&&e1)"), "leads: delete needs leads edit");
assert.ok(rd("dashboard.html").includes("canCreate = false; canDelete = false;"), "dashboard: delete needs quotes edit");
console.log("rbac-1030: ok");
