// r80: shared modal keyboard + unsaved-changes behaviour (static checks on public/ sources).
//  - Enter in a single-line field presses the open modal's ONE primary button (bubble phase, skips textarea,
//    <form> fields, datalist/combobox fields, key repeat, IME, modifiers, busy buttons, BPUI's own dialogs)
//  - an app link clicked while a tracked form is dirty asks "Discard changes?" in-app first
//  - Escape on the lead / partner modals still routes through [data-close] -> requestCloseForm -> confirmDiscard
//  - the staff availability grid redraws on "helm:staff-changed" (fired after deactivate / reactivate / save)
//  - no copy / clipboard handler is bound to focus or keydown
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const P = (f) => readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const api = P('store-api.js');
ok(/doc\.addEventListener\("keydown", onEnterSubmit, false\)/.test(api), 'Enter handler wired in bubble phase');
const et = api.slice(api.indexOf('function enterTarget'), api.indexOf('function onEnterSubmit'));
for (const k of ['e.defaultPrevented', 'e.isComposing', 'e.repeat', 'e.shiftKey', 't.form', '"INPUT"', 'aria-autocomplete', '"list"', 'top.own', 'prim.length !== 1', 'prim[0].disabled', 'aria-busy'])
  ok(et.includes(k), 'enterTarget guards ' + k);
ok(!/TEXTAREA/.test(et) || /tagName !== "INPUT"/.test(et), 'textarea never submits');
ok(/doc\.addEventListener\("click", onGuardedLink, false\)/.test(api), 'link guard wired');
const lg = api.slice(api.indexOf('function onGuardedLink'), api.indexOf('/* ------------------------------------------------------ offline banner'));
for (const k of ['anyDirty()', 'unloadBypass', 'u.origin !== global.location.origin', 'confirmDiscard(anyDirty)', 'location.assign', 'e.metaKey', 'download'])
  ok(lg.includes(k), 'link guard has ' + k);
ok(/addEventListener\("beforeunload"[\s\S]{0,120}anyDirty\(\)/.test(api), 'beforeunload prompt still on while dirty');
ok(/var c = top\.el\.querySelector\("\[data-close\]"\)/.test(api), 'Escape clicks the modal [data-close]');
for (const [f, m, req] of [['leads.html', 'leadModal', 'requestCloseForm'], ['vendors.html', 'vModal', 'requestCloseForm'], ['inventory.html', 'itemModal', 'requestCloseItem']]) {
  const s = P(f);
  ok(s.includes('BPUI.trackDirty($("#' + m + '"))'), f + ' tracks dirty');
  ok(new RegExp('class="close"[^>]*data-close').test(s), f + ' close button has data-close');
  ok(s.includes('confirmDiscard(') && s.includes(req), f + ' asks before discarding');
}
ok(/id="lm_save"/.test(P('leads.html')) && /class="btn primary" id="lm_save"/.test(P('leads.html')), 'lead Save is the primary button');
ok(/class="btn primary" id="im_save"/.test(P('inventory.html')), 'inventory Save is the primary button');
const cs = P('crew-shifts.js'), st = P('staff.html');
ok(/addEventListener\("helm:staff-changed", function \(\) \{ draw\(\)/.test(cs), 'availability grid redraws on helm:staff-changed');
ok(/new CustomEvent\("helm:staff-changed"\)/.test(st), 'staff page fires helm:staff-changed');
ok(/Deactivated\."[^\n]*await load\(\); staffChanged\(\);/.test(st), 'fired after deactivate / reactivate');
ok(/Staff saved\."[^\n]*await load\(\); staffChanged\(\);/.test(st), 'fired after save');
// clipboard: only explicit Copy buttons write to it; nothing on focus / keydown
for (const f of ['store-api.js', 'leads.html', 'phone-input.js', 'form-validate.js', 'shell-b-privacy.js', 'tour.js'])
  ok(!/(focusin|focus|keydown|keyup)"\s*,[^\n]{0,200}(clipboard\.write|execCommand\(["']copy)/.test(P(f)), f + ': no clipboard write on focus/keys');
console.log('r80-form-keyboard: ' + n + ' checks passed');
