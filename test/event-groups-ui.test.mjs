// Event groups + @mentions (0035) — UI wiring.
// Pins: the Quotes page offers "Event group" on confirmed quotes (and "Open event group"
// when one exists), prompts after Confirm & lock (manual — nothing is created until the
// click) and hides it all when 0035 isn't installed; store-api calls the 0035 RPCs with
// the migration's argument names; the event card + mentions render escaped; the bell
// shows mentions even for muted chats; neither the server card nor the offline card
// carries a money field.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const chat = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
const quotes = readFileSync(new URL('../public/quotes.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const mig = readFileSync(new URL('../supabase/migrations/0035_event_groups_mentions.sql', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const MONEY = /total|price|amount|advance|paid|balance|gst|discount|budget|coupon/i;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// one function's source, by brace matching from "function name("
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};

t('store-api calls the 0035 RPCs with the migration argument names', () => {
  assert.match(api, /rpc\("create_event_group", \{ p_quote: quoteId, p_members: memberIds \|\| \[\] \}\)/);
  assert.match(api, /rpc\("refresh_event_group", \{ p_conversation: convId \}\)/);
  assert.match(api, /rpc\("event_group_index", \{\}\)/);
  assert.match(api, /supa\.rpc\("chat_my_mentions", \{ p_limit: cap \}\)/);
  assert.match(mig, /function public\.create_event_group\(p_quote uuid, p_members uuid\[\] default null\)/);
  assert.match(mig, /function public\.refresh_event_group\(p_conversation uuid\)/);
  assert.match(mig, /function public\.chat_my_mentions\(p_limit integer default 20\)/);
});
t('bell: mentions merge into chat notifications, even for muted chats', () => {
  const ctx = {}; vm.runInNewContext(fnSrc(api, 'chatMergeMentions') + '\nglobalThis.f=chatMergeMentions;', ctx);
  const out = [{ conversation_id: 'g1', kind: 'group', title: 'Crew', who: 'Ravi', preview: 'hi', created_at: '2026-10-07T10:00:00Z', count: 3 }];
  ctx.f(out, [
    { conversation_id: 'g1', conv_kind: 'group', title: 'Crew', who: 'Asha', preview: '@You look', created_at: '2026-10-07T09:00:00Z' },
    { conversation_id: 'muted', conv_kind: 'group', title: '10062026-11 · Sharma wedding', who: 'Ravi', preview: '@You call client', created_at: '2026-10-07T11:00:00Z' },
    { conversation_id: 'muted', conv_kind: 'group', title: '10062026-11 · Sharma wedding', who: 'Ravi', preview: 'older', created_at: '2026-10-07T08:00:00Z' },
  ]);
  assert.equal(out[0].conversation_id, 'muted');
  assert.equal(out[0].title, 'Ravi mentioned you in 10062026-11 · Sharma wedding'); assert.equal(out[0].who, ''); assert.equal(out[0].count, 2);
  assert.equal(out[1].title, 'Asha mentioned you in Crew'); assert.equal(out[1].kind, 'mention'); assert.equal(out[1].count, 3);
  // both chat.notifications paths merge them AFTER the muted filter
  assert.equal((api.match(/chatMergeMentions\(out, await this\.mentionsForMe\(cap/g) || []).length, 2);
});
t('offline event card uses the same whitelist (no money key) as the server', () => {
  const ctx = {}; vm.runInNewContext(fnSrc(api, 'chatLocalEventCard') + '\nglobalThis.f=chatLocalEventCard;', ctx);
  const card = ctx.f({ id: 'q1', code: 'C-1', title: 'Wedding', status: 'confirmed', eventDate: '2026-12-10', currentVersion: 2,
    client: { name: 'Priya', phone: '9', email: 'p@x.in', venue: 'Lawns', notes: 'Jain', budget: 900000, advance: 5000 },
    pricing: { total: 230100, discount: 5, gstPct: 18, platePrice: 950, guests: 200, amountPaid: 1 } });
  const keys = []; const walk = (o) => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { keys.push(k); walk(o[k]); } }; walk(card);
  assert.deepEqual(keys.filter((k) => MONEY.test(k)), []);
  assert.doesNotMatch(JSON.stringify(card), /230100|900000|5000|950/);
  assert.equal(card.guests, 200); assert.equal(card.client.name, 'Priya'); assert.equal(card.kind, 'event');
});
t('server card: built from an explicit whitelist; pricing is only read for the guest count', () => {
  const body = mig.match(/create or replace function public\._event_card[\s\S]*?end \$\$;/)[0];
  const keys = [...body.matchAll(/'([a-z_]+)',\s/g)].map((m) => m[1]);
  assert.ok(keys.length > 15, 'keys parsed'); assert.deepEqual(keys.filter((k) => MONEY.test(k)), []);
  for (const m of body.matchAll(/pricing ->> '([a-z]+)'/g)) assert.ok(['guests', 'chairs'].includes(m[1]), 'pricing.' + m[1] + ' read');
  assert.match(mig, /new\.meta ->> 'kind' = 'event' and new\.sender_id is not null/);   // users can't forge one
});
t('chat: event card renders escaped (client data never becomes markup)', () => {
  const src = ['fmtEvDate', 'eventCardHtml'].map((f) => fnSrc(chat, f)).join('\n');
  const ctx = { esc }; vm.runInNewContext(src + '\nglobalThis.f=eventCardHtml;', ctx);
  const html = ctx.f({ kind: 'event', quote_id: 'q-1', code: 'C<1>', title: '<img src=x onerror=alert(1)>',
    client: { name: '<b>x</b>', phone: '+91 98"765', email: 'a@b.in"><script>' }, venue: 'V&V', guests: 10,
    menu: { package: 'Royal', dishes: [{ name: '<i>Tikka</i>' }] }, layout: { version: 1, object_count: 4 } });
  assert.doesNotMatch(html, /<img|<b>x|<script|<i>Tikka/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(html, /V&amp;V/);
  assert.match(html, /href="builder\.html\?quote=q-1"/); assert.match(html, /href="event\.html\?id=q-1"/); assert.match(html, /href="tel:\+9198765"/);
  assert.doesNotMatch(fnSrc(chat, 'eventCardHtml'), MONEY);
});
t('chat: mentions highlight only kept ids, escaped', () => {
  const ctx = { esc, ME: { id: 'me' }, personName: (id) => ({ me: 'Asha Rao', u2: '<Ravi>' }[id] || 'Member') };
  vm.runInNewContext(fnSrc(chat, 'mentionHtml') + '\nglobalThis.f=mentionHtml;', ctx);
  assert.equal(ctx.f('hi @Asha Rao & @<Ravi> <b>', ['me', 'u2']),
    'hi <span class="mention me">@Asha Rao</span> &amp; <span class="mention">@&lt;Ravi&gt;</span> &lt;b&gt;');
  assert.equal(ctx.f('<x> @Asha Rao', []), '&lt;x&gt; @Asha Rao');
  assert.match(chat, /<span class="txt">\$\{mentionHtml\(m\.body,m\.meta&&m\.meta\.mentions\)\}<\/span>/);
});
t('chat composer: @ opens the member picker; Enter picks instead of sending; mentions sent in meta', () => {
  assert.match(chat, /id="mentionPop" role="listbox"/);
  assert.match(chat, /addEventListener\("keydown",e=>\{ if\(mpKey\(e\)\) return; if\(e\.key==="Enter"&&!e\.shiftKey\)/);
  assert.match(chat, /const ids=c\.kind==="broadcast"\?Object\.keys\(roster\):\(thread\.members\|\|\[\]\)\.map\(m=>m\.user_id\)/);
  assert.match(chat, /const meta=mentions\.length\?Object\.assign\(\{\},att\|\|\{\},\{mentions\}\):\(att\|\|null\);/);
  assert.match(chat, /BPStore\.chat\.send\(activeId,\{kind,body,meta,reply_to/);
});
t('chat: event group menu has Refresh event details + workspace; pinned card bar', () => {
  assert.match(chat, /if\(c\.kind==="group"&&c\.quote_id\)\{/);
  assert.match(chat, /BPStore\.chat\.eventGroups\.refresh\(c\.id\)/);
  assert.match(chat, /id="pinBar"/); assert.match(chat, /renderPinBar\(c\);/);
  assert.match(chat, /if\(c\.kind==="group"\) items\.push\(\{k:"add",label:"➕  Add members"/);   // add members works for event groups
});
t('quotes: Event group button on confirmed quotes; "Open event group" when it exists; hidden without 0035', () => {
  assert.match(quotes, /egReady&&\(egIndex\[x\.id\]\|\|x\.status==="confirmed"\)/);
  assert.match(quotes, /\$\{egIndex\[x\.id\]\?"💬 Open event group":"💬 Event group"\}/);
  assert.match(quotes, /else if\(act==="egroup"\) BPUI\.guard\(b,\(\)=>openEventGroup\(id\)\)/);
  assert.match(quotes, /catch\(e\)\{ egIndex=\{\}; egReady=false; \}/);
  assert.match(quotes, /if\(g\.is_member\) location\.href="chat\.html\?c="\+encodeURIComponent\(g\.conversation_id\)/);
});
t('quotes: after Confirm & lock a prompt OFFERS the group (manual, nothing auto-created)', () => {
  assert.match(quotes, /await BPStore\.quotes\.confirm\(cmId, client, pricing\); confirmedId=cmId;/);
  assert.match(quotes, /if\(confirmedId\) showEventGroupPrompt\(confirmedId\);/);
  const prompt = fnSrc(quotes, 'showEventGroupPrompt');
  assert.doesNotMatch(prompt, /eventGroups\.create/);
  assert.match(prompt, /egIndex\[id\]\) return;/);   // already has a group → no prompt
  assert.match(quotes, /id="egBarGo"[\s\S]*id="egBarNo"/);
});
console.log(`event-groups-ui: ${n} checks passed`);
