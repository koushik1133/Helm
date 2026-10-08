// 0054 security alerts — bell label (names only, count, 🛡️) + HQ "Security" panel wiring.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const hqJs = readFileSync(new URL('../public/hq.js', import.meta.url), 'utf8');
const hqHtml = readFileSync(new URL('../public/hq.html', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = {}; vm.runInNewContext(fnSrc(api, 'bellLabel') + '\nglobalThis.label=bellLabel;', ctx);

t('security_alert gets the shield icon + label + count', () => {
  const r = ctx.label({ kind: 'security_alert', detail: { label: 'Upload rejected by the scanner', count: 4 } });
  assert.equal(r.icon, '🛡️'); assert.equal(r.text, 'Security: Upload rejected by the scanner ×4');
});
t('names + event code shown, single event has no count', () => {
  const r = ctx.label({ kind: 'security_alert', detail: { label: 'Admin override used', count: 1, actor_name: 'Asha', event_code: 'A-0001' } });
  assert.equal(r.text, 'Security: Admin override used · by Asha · A-0001');
  assert.equal(ctx.label({ kind: 'security_alert', detail: { label: 'Member role changed', subject_name: 'Sam' } }).text, 'Security: Member role changed · Sam');
});
t('missing detail falls back safely', () => {
  assert.equal(ctx.label({ kind: 'security_alert' }).text, 'Security: security event');
});
t('HQ Activity tab has the Security panel and loads hq_security_alerts', () => {
  assert.ok(/id="tSec"/.test(hqHtml) && /id="tSecLatest"/.test(hqHtml));
  assert.ok(hqJs.includes('call("hq_security_alerts"'));
  assert.ok(/loadAudit\(\)\.catch\(showErr\); loadSecurity\(\)/.test(hqJs));
});
t('HQ security panel renders with textContent only (no innerHTML)', () => {
  const body = fnSrc(hqJs, 'loadSecurity');
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(body));
});
console.log(`security-alerts-ui: ${n} passed`);
