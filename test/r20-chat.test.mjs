// r20 chat (live QA, Oct 2026): quote snippet overflowing its bubble on a 375px phone,
// a 409 from two racing chat_ensure_broadcast calls on first visit, "S" instead of
// "S Koushik" in the group subtitle, and a read-only member list from the group header.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const html = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
let n = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('1 quote snippet: contained inside the bubble, ellipsis, readable minimum column', () => {
  assert.match(html, /\.bub \.reply\{[^}]*min-width:0;max-width:100%;overflow:hidden\}/);
  assert.match(html, /\.bub \.reply \.rt\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis;[^}]*contain:inline-size\}/);
  assert.match(html, /\.m:has\(\.bub \.reply\)\{min-width:min\(340px,72%\)\}/, 'never wider than the 72% message column');
});

t('2 ensure broadcast: one in-flight call, 409/23505 counts as done', async () => {
  const start = api.indexOf('if (!chatBcastEnsured && pageKey() === "chat") {');
  const end = api.indexOf('const { data, error } = await supa.from("chat_conversations")', start);
  assert.ok(start > 0 && end > start);
  const block = api.slice(start, end);
  const run = (rpcImpl) => {
    const store = {};
    const ctx = { calls: 0 };
    // the real ensure block, run against stubbed rpc / sessionStorage with module-level state shared across calls
    const shared = new Function('ctx', 'rpcImpl', 'store', `
      const pageKey = () => "chat"; const currentUser = { id: "u1" };
      const sessionStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
      const rpc = async (name) => { ctx.calls++; return rpcImpl(name); };
      let chatBcastEnsured = false, chatBcastInflight = null;
      return { go: async () => { ${block} return chatBcastEnsured; }, state: () => ({ chatBcastEnsured, chatBcastInflight }) };`);
    return { api: shared(ctx, rpcImpl, store), ctx, store };
  };
  // two concurrent loads -> one RPC
  { const r = run(() => new Promise((res) => setTimeout(() => res('id'), 10)));
    const [a, b] = await Promise.all([r.api.go(), r.api.go()]);
    assert.equal(r.ctx.calls, 1, 'single-flight'); assert.ok(a && b); assert.equal(r.store['bp_chat_bcast:u1'], '1');
    assert.equal(r.api.state().chatBcastInflight, null);
    await r.api.go(); assert.equal(r.ctx.calls, 1, 'ensured once per tab'); }
  // a 409 / 23505 from a race elsewhere still counts as ensured
  for (const err of [{ code: '23505' }, { status: 409 }]) {
    const r = run(() => Promise.reject(Object.assign(new Error('dup'), err)));
    assert.equal(await r.api.go(), true); assert.equal(r.store['bp_chat_bcast:u1'], '1'); }
  // any other failure: not ensured, retried next time
  { const r = run(() => Promise.reject(Object.assign(new Error('net'), { code: '08006' })));
    assert.equal(await r.api.go(), false); await r.api.go(); assert.equal(r.ctx.calls, 2); }
});

t('3 group subtitle: a 1-2 letter first word is an initial, so the full name is kept', () => {
  const src = (html.match(/function shortName\(name\)\{[^\n]*\}/) || [])[0];
  assert.ok(src, 'shortName defined');
  const shortName = new Function(src + '; return shortName;')();
  assert.equal(shortName('S Koushik'), 'S Koushik');
  assert.equal(shortName('Ra Vi Kumar'), 'Ra Vi Kumar');
  assert.equal(shortName('Praneeth Reddy'), 'Praneeth');
  assert.equal(shortName('Raj  Patel'), 'Raj');
  assert.equal(shortName('  '), '');
  assert.match(html, /shortName\(personName\(m\.user_id\)\)\)\.concat\(\(thread\.contacts\|\|\[\]\)\.map\(k=>shortName\(k\.name\)\)\)/);
  assert.doesNotMatch(html, /personName\(m\.user_id\)\.split\(" "\)\[0\]/);
});

t('4 group header opens a read-only member list (every group, with roles)', () => {
  assert.match(html, /<div class="ti" id="tTi">/);
  assert.match(html, /ti\.classList\.toggle\("clk",grp\)/);
  assert.match(html, /\$\("#tTi"\)\.addEventListener\("click",\(\)=>\{ if\(\$\("#tTi"\)\.classList\.contains\("clk"\)\) peopleModal\(\); \}\)/);
  assert.match(html, /function memberSub\(m\)\{[\s\S]{0,200}roleLbl\(p\.role\)[\s\S]{0,120}group admin/);
  assert.match(html, /if\(c\.kind==="group"\) items\.push\(\{k:"ppl"/);
  // plain groups: no event-only "Add people" / contacts in the panel
  assert.match(html, /if\(ev\)\{ const add=document\.createElement\("button"\)/);
  assert.match(html, /const contacts=ev\?\(thread\.contacts\|\|\[\]\):\[\];/);
});

for (const [name, fn] of tests) { await fn(); n++; console.log('ok -', name); }
console.log(`r20-chat: ${n} passed`);
