// R58 (0299, audit 2026-10-28): the pages read the protected columns through the role-checked RPCs.
//  D-01 crew_members.day_rate / attributes -> staff_pay_fields (never select("*") on crew_members)
//  D-02 work_tokens.token -> work_links_for_event (Staff edit)
//  D-09 inventory_items.unit_cost -> inventory_costs (finance view / inventory edit); a hidden cost is never shown as 0
//  BS-01 the event card's client phone / e-mail come from event_group_contact; "not added" people are named in the toast
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const API = read('public/store-api.js'), CHAT = read('public/chat.html'), INV = read('public/inventory.html'), EGP = read('public/event-group-picker.js');
const MIG = read('supabase/migrations/0299_r58_crew_events_hardening.sql');
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};

test('no select("*") / bare .select() on the three protected tables', () => {
  for (const t of ['crew_members', 'inventory_items', 'work_tokens']) {
    const re = new RegExp('from\\("' + t + '"\\)[^;]*?\\.select\\((\\)|"\\*")', 'g');
    assert.equal((API.match(re) || []).length, 0, t);
  }
  assert.match(API, /const CREW_COLS = "id,name,phone,department,active,created_at,role,skills,email,emp_type,notes,org_id,profile_id,is_demo";/);
  assert.ok(!/day_rate|attributes/.test(API.match(/const CREW_COLS = "[^"]*"/)[0]), 'pay columns are not in the table read');
  assert.ok(!/unit_cost/.test(API.match(/const INV_COLS = "[^"]*"/)[0]));
});

test('pay / cost / links come from the RPCs, with the pre-0299 table read as the fallback', () => {
  assert.match(API, /key: "pay", rpc: "staff_pay_fields", table: "crew_members", cols: "id,day_rate,attributes"/);
  assert.match(API, /key: "cost", rpc: "inventory_costs", table: "inventory_items", cols: "id,unit_cost"/);
  assert.match(API, /supa\.rpc\("work_links_for_event", \{ p_quote: quoteId \}\)/);
  assert.match(API, /else if \(rpcMissing\(r\.error\)\) r58Rpc\[o\.key\] = false; else throw r\.error;/, 'only a missing RPC falls back');
  assert.match(API, /return crewWithPay\(await sbAll\(/);
  assert.match(API, /const pg = await sbPage\(q\.order\("name"\)\.order\("id"\), o\); await crewWithPay\(pg\.rows\); return pg;/);
  assert.match(API, /return invWithCost\(await sbAll\(/);
  assert.match(API, /var one = await crewWithPay\(\[\{ id: id \}\]\); base = \(one\[0\] && one\[0\]\.attributes\) \|\| \{\};/, 'staff custom-field merge reads through the RPC');
});

test('payVisible: a row the server marked pay_hidden is never shown; otherwise the r20 rule', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fnSrc(API, 'staffPayVisible') + '\nthis.f = staffPayVisible;', ctx);
  assert.equal(ctx.f({ profile_id: 'u', pay_hidden: true }, true), false);
  assert.equal(ctx.f({ profile_id: 'u' }, true), true);
  assert.equal(ctx.f({ profile_id: 'u' }, false), false);
  assert.equal(ctx.f({ profile_id: null }, false), true);
});

test('r58Fill fills rows in place (list keeps .truncated) and falls back before 0299', async () => {
  const src = API.slice(API.indexOf('const r58Rpc = '), API.indexOf('  // 0078: fire-and-forget'));
  const calls = [];
  const mk = (rpcErr) => ({
    rpc: async (fn, a) => { calls.push(['rpc', fn, a.p_ids.length]); return rpcErr ? { error: rpcErr } : { data: a.p_ids.map((id) => ({ id, day_rate: 7, attributes: { a: 1 }, pay_hidden: id === 'b' })) }; },
    from: (t) => ({ select: (c) => ({ in: async (k, ids) => { calls.push(['from', t, c]); return { data: ids.map((id) => ({ id, day_rate: 9, attributes: {} })) }; } }) }) });
  const run = async (supa) => {
    const ctx = vm.createContext({ supa, rpcMissing: (e) => e && e.code === 'PGRST202' });
    vm.runInContext(src + '\nthis.c = crewWithPay;', ctx);
    const rows = [{ id: 'a' }, { id: 'b' }]; rows.truncated = true; const out = await ctx.c(rows); return { rows, out };
  };
  let r = await run(mk(null));
  assert.equal(r.out, r.rows); assert.equal(r.rows.truncated, true);
  assert.equal(r.rows[0].day_rate, 7); assert.equal(r.rows[1].pay_hidden, true); assert.equal(r.rows[0].pay_hidden, undefined);
  r = await run(mk({ code: 'PGRST202' }));
  assert.equal(r.rows[0].day_rate, 9); assert.ok(calls.some((c) => c[0] === 'from' && c[2] === 'id,day_rate,attributes'));
  await assert.rejects(run(mk({ code: '42501', message: 'not authorized' })));
});

test('inventory: a hidden cost is not shown as a zero value', () => {
  assert.match(INV, /\(it\.unit_cost!=null\?` - taken off your stock \(\$\{BPStore\.studioMoney/);
  assert.match(INV, /\$\{lostVal\?" · "\+esc\(BPStore\.studioMoney\(lostVal\)\)\+" lost":""\}/);
});

test('chat event card: phone / e-mail from event_group_contact (Quotes view), once per event', () => {
  assert.match(API, /async contact\(quoteId\) \{/);
  assert.match(API, /supa\.rpc\("event_group_contact", \{ p_quote: quoteId \}\)/);
  assert.match(CHAT, /const ct=\(typeof evContactFor==="function"\?evContactFor\(qid\):null\)\|\|\{\}; const ph=ct\.phone\|\|cl\.phone, em=ct\.email\|\|cl\.email;/);
  assert.match(CHAT, /if\(Object\.prototype\.hasOwnProperty\.call\(evContact,qid\)\) return evContact\[qid\]; evContact\[qid\]=null;/, 'asked once per event');
  assert.match(EGP, /not added: their role can't open this event \(Settings \\u2192 Users & access\)\./);
});

test('migration: additive, keeps previous bodies, ASCII only', () => {
  assert.ok(!/[^\x00-\x7f]/.test(MIG), 'ASCII only');
  assert.ok(!/\bdrop\s+(table|column|function|policy|trigger)\b/i.test(MIG.replace(/^--.*$/gm, '')), 'no drops');
  assert.ok(!/\bdelete\s+from\b/i.test(MIG.replace(/^--.*$/gm, '')), 'no deletes');
  assert.match(MIG, /chat_card_contact_backup_r58/);
  assert.match(MIG, /rename to %I/);
});
