// 0176 trial client flow: portal "Test mode - confirm" (no OTP in trial) + flow "Create event group?" prompt.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const ap = readFileSync(new URL("../public/approve.html", import.meta.url), "utf8");
const fl = readFileSync(new URL("../public/flow.html", import.meta.url), "utf8");
const sql = readFileSync(new URL("../supabase/migrations/0176_trial_client_flow.sql", import.meta.url), "utf8");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
// R113 (0322): the trial button is "Simulate approval" (test code 000000); approve-test-mode.js shows the box and hides
// every send button (e-mail / WhatsApp / SMS) in a trial
ok(/id="trialSkipBtn"[^>]*>Simulate approval</.test(ap), "portal button says Simulate approval");
const tmjs = readFileSync(new URL("../public/approve-test-mode.js", import.meta.url), "utf8");
ok(/HelmApproveTestMode\.apply\(tm\)/.test(ap) && /\["#sendEmailOtp", "#sendWa", "#sendOtp", "#waNote"\]\.forEach\(hide\)/.test(tmjs)
   && /var box = q\("#trialSkip"\); if \(box\) box\.hidden = false;/.test(tmjs), "trial portal hides Send OTP");
ok(/id="egBar"/.test(fl) && /id="egBarGo"/.test(fl) && /id="egBarNo"/.test(fl), "flow has the bottom group prompt");
ok(/event-group-picker\.js\?v=\d+/.test(fl), "flow loads the group picker");
ok(/async function renderEgPrompt\(\)/.test(fl) && (fl.match(/renderEgPrompt\(\)\.catch/g) || []).length >= 2, "prompt runs on load + after advance (+ after the client approves, confirm-1018)");
ok(/if\(st!=="confirmed"\) return;/.test(fl), "prompt only for a confirmed event");
ok(/_trial_test_mode_ok\(p_org\)\s*\n\s*and \(public\._aud1017_is_member\(p_org\) or auth\.uid\(\) is null\)/.test(sql), "server gate: active trial + member or portal");
ok(/if not public\._trial_client_skip_ok\(v_org\) then/.test(sql), "approve re-checks the gate");
ok(!/[^\x00-\x7F]/.test(sql), "SQL is ASCII");
console.log(`trial-client-flow-ui: ${n} checks passed`);
