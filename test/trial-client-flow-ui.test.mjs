// 0176 trial client flow: portal "Test mode - confirm" (no OTP in trial) + flow "Create event group?" prompt.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const ap = readFileSync(new URL("../public/approve.html", import.meta.url), "utf8");
const fl = readFileSync(new URL("../public/flow.html", import.meta.url), "utf8");
const sql = readFileSync(new URL("../supabase/migrations/0176_trial_client_flow.sql", import.meta.url), "utf8");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
ok(/id="trialSkipBtn"[^>]*>Test mode - confirm</.test(ap), "portal button says Test mode - confirm");
ok(/on===true\)\{ \$\("#trialSkip"\)\.hidden=false;[^\n]*#sendOtp/.test(ap), "trial portal hides Send OTP");
ok(/id="egBar"/.test(fl) && /id="egBarGo"/.test(fl) && /id="egBarNo"/.test(fl), "flow has the bottom group prompt");
ok(/event-group-picker\.js\?v=\d+/.test(fl), "flow loads the group picker");
ok(/async function renderEgPrompt\(\)/.test(fl) && (fl.match(/renderEgPrompt\(\)\.catch/g) || []).length >= 2, "prompt runs on load + after advance (+ after the client approves, confirm-1018)");
ok(/if\(st!=="confirmed"\) return;/.test(fl), "prompt only for a confirmed event");
ok(/_trial_test_mode_ok\(p_org\)\s*\n\s*and \(public\._aud1017_is_member\(p_org\) or auth\.uid\(\) is null\)/.test(sql), "server gate: active trial + member or portal");
ok(/if not public\._trial_client_skip_ok\(v_org\) then/.test(sql), "approve re-checks the gate");
ok(!/[^\x00-\x7F]/.test(sql), "SQL is ASCII");
console.log(`trial-client-flow-ui: ${n} checks passed`);
