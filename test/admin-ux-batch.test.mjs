// Source checks for the admin/chat/login/tour UX batch (A3,A5-A10,L1,L3,L5,L6).
import fs from "node:fs"; import assert from "node:assert/strict";
const rd = (f) => fs.readFileSync(new URL("../public/" + f, import.meta.url), "utf8");
const ctl = rd("control.html"), chat = rd("chat.html"), login = rd("login.html"), tour = rd("tour.js"),
  auth = rd("auth-ui.js"), bk = rd("booklet.js"), ob = rd("onboarding.js"), ap = rd("approve.html");
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok -", name); };
t("A3 pending invites table with revoke+confirm", () => { assert.match(ctl, /id="inv_rows"/); assert.match(ctl, /invitations\.list\(\)/); assert.match(ctl, /invitations\.revoke\(/); assert.match(ctl, /Revoke the invite for/); });
t("A5 chat maxlength 4000 + counter", () => { assert.match(chat, /id="msgInput"[^>]*maxlength="4000"/); assert.match(chat, /id="msgCount"/); assert.match(chat, /function syncCount/); });
t("A6 forward disabled for media", () => { assert.match(chat, /msg\.kind==="image"\|\|msg\.kind==="voice"/); assert.match(chat, /m\.kind==="image"\|\|m\.kind==="voice"\) return;/); });
t("A7 new-chat rows are buttons", () => { assert.match(chat, /<button type="button" class="prow" data-id=/); });
t("A8 lightbox dialog semantics", () => { assert.match(chat, /setAttribute\("role","dialog"\)/); assert.match(chat, /aria-modal/); assert.match(chat, /e\.key==="Escape"/); assert.match(chat, /prev\.focus\(\)/); });
t("A9 invite token cleared only on terminal errors", () => { assert.doesNotMatch(login, /finally\{ clearInvite\(\); \}/); assert.match(login, /const terminal=/); assert.match(login, /confirm your e-\?mail/); });
t("A10 tour escape/label/focus", () => { assert.match(tour, /!otherModalOpen\(\)/); assert.match(tour, /aria-label="Guided tour"/); assert.match(tour, /\.next"\)\.focus/); });
t("L1 trial notice docked, session dismissal", () => { assert.match(auth, /dock-left/); assert.match(auth, /compact: true/); assert.match(auth, /helm_trial_dismissed_/); });
t("L3 booklet email hidden when empty", () => { assert.match(bk, /bizEmail/); });
t("L5 undone count helper", () => { assert.match(ob, /function undoneCount/); });
t("L6 approve clears loading text", () => { assert.match(ap, /\$\("#loading"\)\.textContent=""/); });
console.log(n + " passed");
