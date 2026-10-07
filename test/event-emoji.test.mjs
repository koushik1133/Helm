// Event-group avatars: an emoji from the quote's event type (then the title), used for the
// chat list / thread header avatar and the event card header. Plain groups keep 👥, DMs keep
// initials. The event type comes from the group's event card or ONE RLS-scoped quotes read
// for all groups (never a server call per conversation).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  const from = src.slice(at - 6, at) === 'async ' ? at - 6 : at;
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1); }
  throw new Error(name + ' unterminated');
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ctx = {}; vm.runInNewContext(fnSrc(api, 'chatEventEmoji') + '\nglobalThis.f=chatEventEmoji;', ctx);
const emo = ctx.f;

await t('event type → emoji (case-insensitive, _ and - as spaces)', () => {
  const cases = {
    wedding: '💍', 'Wedding': '💍', wedding_ceremony: '💍', 'Marriage': '💍', Engagement: '💞', 'ring ceremony': '💞',
    reception: '🥂', wedding_reception: '🥂', Birthday: '🎂', birthday_party: '🎂', 'ANNIVERSARY': '💐',
    corporate: '🏢', Conference: '🏢', political: '🗳️', 'Political Rally': '🗳️', concert: '🎤', 'Music night': '🎤',
    sports: '🏟️', 'sports-day': '🏟️', festival: '🎪', exhibition: '🖼️', 'Trade Expo': '🖼️', religious: '🪔', Puja: '🪔', 'pooja': '🪔',
    'baby shower': '🍼', 'Baby_Shower party': '🍼', graduation: '🎓', party: '🎉', 'Office party': '🎉',
  };
  for (const [k, v] of Object.entries(cases)) assert.equal(emo(k), v, k);
});
await t('falls back to the title, then 📅; whole words only', () => {
  assert.equal(emo(null, 'C-101 · Sharma wedding'), '💍');
  assert.equal(emo('', '10062026-11 · Riya 5th birthday'), '🎂');
  assert.equal(emo('general', 'Untitled event'), '📅');
  assert.equal(emo(undefined, undefined), '📅');
  assert.equal(emo('Partyline Corp'), '📅');          // "party" inside a word doesn't count
  assert.equal(emo('corporate', 'Sharma wedding'), '🏢');   // the event type wins over the title
  assert.equal(emo('<script>'), '📅');
});
await t('chat.html: event groups use the emoji; plain groups 👥; DMs initials; avatars escaped', () => {
  const src = ['evEmoji', 'convAvatar'].map((f) => fnSrc(chat, f)).join('\n');
  const c2 = { BPStore: { chat: { eventEmoji: emo } }, colorFor: () => '#123', initials: (s) => s.slice(0, 2).toUpperCase(),
    personName: (id) => ({ u2: 'Ravi Kumar' }[id] || 'Member'), convOther: (c) => c.other };
  vm.runInNewContext(src + '\nglobalThis.f=convAvatar;', c2);
  assert.equal(c2.f({ kind: 'group', id: 'g', quote_id: 'q', _evType: 'birthday', title: 'C-1 · x' }).txt, '🎂');
  assert.equal(c2.f({ kind: 'group', id: 'g', quote_id: 'q', title: 'C-1 · Sharma wedding' }).txt, '💍');     // type unknown → title
  assert.equal(c2.f({ kind: 'group', id: 'g', quote_id: 'q', _evType: null, _evTitle: 'Gala', title: 'C-1 · Gala' }).txt, '📅');
  assert.equal(c2.f({ kind: 'group', id: 'g', title: 'Wedding crew' }).txt, '👥');                           // plain group unchanged
  assert.equal(c2.f({ kind: 'dm', other: 'u2' }).txt, 'RA');
  assert.equal(c2.f({ kind: 'broadcast' }).txt, '📢');
  // evEmoji degrades to 📅 when the store isn't loaded
  const c3 = {}; vm.runInNewContext(fnSrc(chat, 'evEmoji') + '\nglobalThis.f=evEmoji;', c3); assert.equal(c3.f('wedding'), '📅');
  assert.match(chat, /function avHtml\(a,id\)\{ return `<div class="av"\$\{id\?' id="'\+id\+'"':''\} style="background:\$\{a\.bg\}">\$\{esc\(a\.txt\)\}<\/div>`; \}/);
});
await t('event card header shows the event emoji (escaped)', () => {
  const src = ['evEmoji', 'fmtEvDate', 'eventCardHtml'].map((f) => fnSrc(chat, f)).join('\n');
  const c2 = { esc, BPStore: { chat: { eventEmoji: emo } } }; vm.runInNewContext(src + '\nglobalThis.f=eventCardHtml;', c2);
  assert.match(c2.f({ kind: 'event', quote_id: 'q', code: 'C-1', title: 'Riya', event_type: 'Birthday' }), /<div class="ev-h"><span><i class="ev-emo" aria-hidden="true">🎂<\/i> Event details<\/span>/);
  assert.match(c2.f({ kind: 'event', refreshed: true, title: 'Sharma wedding' }), /<i class="ev-emo" aria-hidden="true">💍<\/i> Event details · updated/);
});
await t('event type lookup: from the loaded card, else ONE quotes read for all groups, cached', async () => {
  const src = ['isEventCard', 'resolveEventTypes'].map((f) => fnSrc(chat, f)).join('\n');
  const calls = [];
  const convs = [
    { kind: 'group', quote_id: 'q1', _msgs: [{ kind: 'card', sender_id: null, meta: { kind: 'event', event_type: 'wedding', title: 'S' } }] },
    { kind: 'group', quote_id: 'q2', _msgs: [{ kind: 'text', sender_id: 'u' }] },
    { kind: 'group', quote_id: 'q3', _msgs: [] },
    { kind: 'group', _msgs: [] }, { kind: 'dm', _msgs: [] },
  ];
  const c2 = { convs, evTypeCache: {}, BPStore: { chat: { eventGroups: { types: async (ids) => { calls.push(ids); return { q2: { event_type: 'birthday', title: 'R' } }; } } } } };
  vm.runInNewContext(src + '\nglobalThis.f=resolveEventTypes;', c2);
  await c2.f();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['q2', 'q3']]);                     // one batched read, only for groups without a card
  assert.equal(convs[0]._evType, 'wedding'); assert.equal(convs[1]._evType, 'birthday'); assert.equal(convs[2]._evType, null);
  await c2.f(); assert.equal(calls.length, 1);                 // cached: no read on the next refresh
  assert.match(chat, /await resolveEventTypes\(\);\s*renderConvs\(\);/);
});
await t('store-api: types() is a single RLS-scoped .in() read, fail-open; eventEmoji exported', () => {
  const body = api.slice(api.indexOf('async types(quoteIds)'), api.indexOf('// create (or, if it already exists, return)'));
  assert.match(body, /supa\.from\("quotes"\)\.select\("id,event_type,title"\)\.in\("id", ids\)/);
  assert.equal((body.match(/supa\./g) || []).length, 1);
  assert.match(body, /if \(error\) return out;/);
  assert.doesNotMatch(body, /rpc\(/);
  assert.match(api, /eventEmoji: chatEventEmoji,/);
});
console.log(`\nevent-emoji: ${n} passed`);
