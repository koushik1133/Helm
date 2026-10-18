// staffui-1018: app dialogs sit above the top bar / trial banner (shared shell rule), and the Staff "Add staff" dialog
// redesign (option cards, aligned grid, inline checks, chips, sticky footer, trial hides Custom fields / Import).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const pages = r('public/shell-b-pages.css'), proto = r('public/shell-proto.js'), staff = r('public/staff.html');
const pol = r('public/staff-polish.css'), tlc = r('public/trial-lock.css'), tlj = r('public/trial-lock.js'), api = r('public/store-api.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// 1. shared dialog layer (every app page, loaded by shell-proto)
const layer = /html\[data-shell="b"\] \.lmodal \{([^}]*)\}/.exec(pages);
ok(layer, 'shell-b-pages.css has the shared .lmodal layer rule');
const z = +/z-index:\s*(\d+)/.exec(layer[1])[1];
ok(z > 950 && z < 9000, 'dialog layer above top bar 800 / rail + trial cards 900 / tab bar 950, below the tour 9000');
ok(/align-items:\s*flex-start/.test(layer[1]) && /background:\s*rgba\(20,27,46,\.5\)\s*!important/.test(layer[1]), 'backdrop always painted, sheet pinned to the top gutter');
ok(/\.lmodal > :is\(\.sheet, \.lsheet\) \{[^}]*margin:\s*auto[^}]*max-height:\s*calc\(100dvh - 48px\)[^}]*overflow:\s*auto/.test(pages), 'sheet centred when it fits, max-height + internal scroll');
ok(/body:has\(#imgEdit\) \.ov \{[^}]*z-index:\s*1100/.test(pages), 'chat dialogs use the same layer');
ok(/css\("shell-b-pages\.css"\)/.test(proto) && /var SHELL_V = "\d+"/.test(proto), 'shell-b-pages.css is loaded on every app page');
const sv = +/var SHELL_V = "(\d+)"/.exec(proto)[1]; ok(sv >= 125, 'SHELL_V bumped');

// 2. staff dialog structure
const modal = staff.slice(staff.indexOf('<div id="staffModal"'), staff.indexOf('<!-- invite a staff member'));
ok(/class="sheet smsheet"/.test(modal) && /class="sm-head"/.test(modal) && /class="sm-body"/.test(modal) && /class="sm-foot"/.test(modal), 'head / scrolling body / sticky footer');
ok(modal.indexOf('id="sm_err"') > modal.indexOf('class="sm-foot"') && /id="sm_save"/.test(modal.slice(modal.indexOf('class="sm-foot"'))), 'error + Save/Cancel live in the sticky footer');
ok((modal.match(/class="acc-card"/g) || []).length === 2 && /class="acc-t">Save as a record only</.test(modal) && /class="acc-t">Save and invite to sign in</.test(modal), 'two option cards with bold titles');
ok(/name="s_access" value="record" checked/.test(modal) && /name="s_access" value="invite"/.test(modal), 'radio values unchanged');
ok(/<option value="">— Choose employment —<\/option>/.test(modal), 'Employment placeholder');
ok(/id="s_role_hint">Roles come from Control Center → Users &amp; access\./.test(modal) && /class="fmsg fhint" id="s_role_hint"/.test(modal), 'role helper on the reserved message line');
ok(/id="s_email_req"[^>]*hidden>\*/.test(modal), 'email asterisk hidden by default');
ok(/class="inpfx"><span class="pfx" id="s_rate_cur"/.test(modal) && /id="s_rate" type="number" min="0"/.test(modal), 'day rate: currency prefix, numeric, min 0');
ok(/id="s_skills_box"/.test(modal) && /id="s_skills_chips"/.test(modal), 'skills chip box');
ok(!/style="/.test(modal), 'no inline style attributes (CSP)');

// 3. staff dialog behaviour
ok(/function checkPhone\(\)/.test(staff) && /function checkEmail\(\)/.test(staff) && /function checkRate\(\)/.test(staff) && /function checkName\(\)/.test(staff), 'inline field checks');
ok(/fieldMsg\("s_email",need\?"Needed to send the sign-in invitation\.":""\)/.test(staff), 'email required only when inviting');
ok(/function syncEmailReq\(\)\{ \$\("#s_email_req"\)\.hidden=!wantsInvite\(\)/.test(staff) && /addEventListener\("change",syncEmailReq\)/.test(staff), 'asterisk follows the access choice');
ok(/e\.key==="-"\|\|e\.key==="e"/.test(staff), 'day rate never negative');
ok(/const skills=readSkills\(\);/.test(staff) && /function addSkills\(text\)/.test(staff) && /el\.value\.includes\(","\)/.test(staff), 'comma -> chips, chips saved');
ok(/BPStore\.studioTax&&BPStore\.studioTax\(\)/.test(staff), 'currency prefix follows the studio country');
ok(/wantInvite && added/.test(staff) && /BPStore\.staff\.linkErrorText\(e\)\|\|BPUI\.friendlyError/.test(staff), 'save + invite flow and server error text (incl. trial cap) unchanged');
ok(/e\.hint === "trial_cap"/.test(api), 'trial creation cap message comes from the server via friendlyError');

// 4. styling
ok(/#s_access \.acc-cards\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(pol), 'equal-width option cards');
ok(/#staffModal \.smgrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(pol), 'aligned 2-column grid');
ok(/#staffModal \.fmsg\{display:block;min-height:16px/.test(pol), 'reserved message line keeps rows aligned');
ok(/@media\(max-width:560px\)\{[\s\S]*#s_access \.acc-cards,#staffModal \.smgrid\{grid-template-columns:1fr\}/.test(pol), 'one column on phones');
ok(/staff-polish\.css\?v=([2-9]|\d\d)/.test(staff), 'staff-polish.css pin bumped');

// 5. free trial: Import + Custom fields hidden
ok(/html\.helm-trial:not\(\.tl-budget\) #importBtn/.test(tlc), 'trial hides Import from Excel / CSV');
ok(/html\.helm-trial details\.attrbox/.test(tlc), 'trial hides Custom fields');
ok(/trial-lock\.css\?v=([2-9]|\d\d)/.test(tlj), 'trial-lock.css pin bumped');

console.log(`staff-dialog-ui: ${n} checks passed`);
