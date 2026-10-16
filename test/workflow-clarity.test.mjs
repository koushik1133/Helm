// Static: flow.html action labels are explicit and every step ends with a "Next step" hint.
import fs from 'node:fs'; import assert from 'node:assert/strict';
const s = fs.readFileSync(new URL('../public/flow.html', import.meta.url), 'utf8');
assert.match(s, /id="pay_record">Record advance payment</);
assert.match(s, /id="rq_add">＋ Add requirement</);
assert.match(s, /id="repriceDismiss">Keep current prices</);
assert.match(s, /id="lv_save">Save and leave</);
for (const k of ['client','discovery','reqs','venue','menu','proposal','layout','quote','pay']) {
  const i = s.indexOf(`id="sec-${k}"`); const j = s.indexOf('</section>', i);
  assert.ok(i > 0 && /data-next-step><b>Next step:<\/b>/.test(s.slice(i, j)), `next-step hint in sec-${k}`);
}
assert.ok(!/<p class="hint next-step"[^>]*style=/.test(s), 'no inline styles');
console.log('workflow-clarity: ok');
