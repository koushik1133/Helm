// event.html on a pretty URL (/studio/events/<code>) has no ?id=: the Share booklet button
// must get the resolved quote id from the page, or it never opens (and links can't be revoked).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ev = readFileSync(new URL('../public/event.html', import.meta.url), 'utf8');
const i = ev.indexOf('ev=await BPStore.quotes.get(id)');
const j = ev.indexOf('bk.setAttribute("data-quote", ev.id)');
assert.ok(i > 0 && j > i, 'event.html sets data-quote on #bkShare after loading the quote');
assert.match(ev, /HelmBookletShare\.reveal\(bk\)/);
console.log('booklet-share-event: 2 assertion(s) passed.');
