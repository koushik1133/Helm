// 0040 — "client link expired → Keep | Archive | Deleted quotes". Pins: the Control Center
// card is an explicit Enabled/Disabled switch with the new sub-option (default Keep); store-api
// calls the 0040 RPCs with the migration's argument names; Quotes has Archive + Deleted tabs
// with counts, the "moved automatically" note and Restore (quotes editors only); Delete is
// soft once 0040 is installed; Quotes + Dashboard run the rate-limited tick; the migration is
// additive. Then the card script and the Quotes shelf block run against stub DOMs.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const ctl = r('public/control.html');
const qh = r('public/quotes.html');
const dash = r('public/dashboard.html');
const api = r('public/store-api.js');
const mig = r('supabase/migrations/0040_link_expiry_archive.sql');
const apply = r('supabase/APPLY-0040.sql');
const manifest = r('supabase/migrations/MANIFEST');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const sigOf = (fn) => { const m = mig.match(new RegExp(`create or replace function public\\.${fn}\\(([\\s\\S]*?)\\)\\s*returns`));
  assert.ok(m, fn + ' not in 0040'); return [...m[1].matchAll(/(p_[a-z_]+)\s/g)].map((x) => x[1]); };

// ---- static pins ---------------------------------------------------------------
await t('card: explicit on/off switch with Enabled/Disabled state, default Disabled', () => {
  assert.match(ctl, /<input type="checkbox" role="switch" id="lx_on" aria-describedby="lx_state">/);
  assert.match(ctl, /<span class="lxstate" id="lx_state" aria-live="polite">Disabled<\/span>/);
  assert.match(ctl, /\.lxtoggle input\{appearance:none/, 'styled as a switch');
});

await t('card: "when the link expires" choice — Keep (default) | Archive | Deleted quotes', () => {
  const fs = ctl.slice(ctl.indexOf('<fieldset class="lxmove" id="lx_moveSet" hidden>'), ctl.indexOf('</fieldset>'));
  assert.ok(fs.length > 100, 'fieldset missing (must start hidden until 0040 answers)');
  assert.match(fs, /never approved, confirmed or paid/);
  assert.match(fs, /id="lx_move_keep" value="keep" checked> Keep it in Quotes <span>\(default\)/);
  assert.match(fs, /id="lx_move_archive" value="archive"> Move to Archive/);
  assert.match(fs, /id="lx_move_delete" value="delete"> Move to Deleted quotes <span>\(nothing is erased/);
  assert.equal((fs.match(/type="radio" name="lx_move"/g) || []).length, 3);
});

await t('store-api → 0040 RPCs with the migration\'s argument names', () => {
  assert.deepEqual(sigOf('admin_set_link_expiry_shelf'), ['p_action']);
  assert.deepEqual(sigOf('move_quote_to_shelf'), ['p_quote_id', 'p_shelf']);
  assert.deepEqual(sigOf('restore_quote_from_shelf'), ['p_quote_id']);
  assert.match(api, /get: \(\) => rpc\("admin_get_link_expiry_shelf", \{\}\)/);
  assert.match(api, /set: \(action\) => rpc\("admin_set_link_expiry_shelf", \{ p_action: action \}\)/);
  assert.match(api, /list: \(\) => rpc\("list_quote_shelf", \{\}\)/);
  assert.match(api, /move: \(quoteId, shelf\) => rpc\("move_quote_to_shelf", \{ p_quote_id: quoteId, p_shelf: shelf \}\)/);
  assert.match(api, /restore: \(quoteId\) => rpc\("restore_quote_from_shelf", \{ p_quote_id: quoteId \}\)/);
  assert.match(api, /tick: \(\) => rpc\("link_expiry_shelf_tick", \{\}\)/);
  assert.match(api, /profile, quoteShelf,/, 'quoteShelf exported on BPStore');
});

await t('Quotes: Archive + Deleted tabs with counts; Restore only for quotes editors; note copy', () => {
  assert.match(qh, /data-f="archived" aria-pressed="false">Archive<span class="tcount" id="cnt_archived" hidden><\/span>/);
  assert.match(qh, /data-f="deleted" aria-pressed="false" id="tab_deleted" hidden>Deleted<span class="tcount" id="cnt_deleted">/);
  assert.match(qh, /\$\{canEdit\?`<button type="button" class="ic restore" data-act="restore"/);
  assert.match(qh, /\$\{shelf\.ready&&canEdit\?`<button type="button" class="ic" data-act="archive"/);
  assert.match(qh, /else if\(act==="restore"\) restoreQuote\(id, b\);/);
  assert.match(qh, /<div class="shelfnote">\$\{esc\(shelfNote\(sh\(x\)\)\)\}<\/div>/, 'note is escaped');
  assert.match(qh, /fetch:\(offset\)=>shelfPage\(offset, \(\)=>BPStore\.quotes\.page\(/, 'pager goes through the shelf filter');
  // Delete is soft (Deleted tab) once 0040 is installed; the old hard delete only without it
  const del = qh.slice(qh.indexOf('async function delQuote('), qh.indexOf('// generate/return the per-quote client approval link'));
  assert.match(del, /^async function delQuote\(id, btn\)\{\s*\/\/[^\n]*\n\s*if\(shelf\.ready\) return shelfMove\(id, "delete", btn\);/);
});

await t('Quotes + Dashboard run the rate-limited tick without blocking', () => {
  assert.match(qh, /\n\s*runShelfTick\(\);\s+\/\/ 0040/);
  assert.match(dash, /if \(BPStore\.mode\(\) === "supabase" && BPStore\.quoteShelf\) BPStore\.quoteShelf\.tick\(\)\.catch\(\(\) => \{\}\);/);
});

await t('0040: additive, soft, admin-only setting, rate limit, pg_cron only if present, MANIFEST after 0039', () => {
  assert.doesNotMatch(mig, /\b(drop table|truncate|delete from|drop column)\b/i, 'additive only — never deletes');
  assert.doesNotMatch(mig, /create (temp|temporary) table/i, 'no temp tables');
  assert.doesNotMatch(mig, /create extension/i, 'never creates pg_cron');
  assert.match(mig, /if exists \(select 1 from pg_extension where extname = 'pg_cron'\)/);
  assert.match(mig, /alter table public\.quotes add column if not exists deleted_at\s+timestamptz;/);
  assert.match(mig, /admin_set_link_expiry_shelf[\s\S]*?not public\.is_admin\(\) then\s*raise exception 'not authorized' using errcode = '42501'/);
  assert.match(mig, /s\.last_run_at <= now\(\) - interval '10 minutes'/);
  assert.match(mig, /q\.status = 'quote' and q\.confirmed_at is null/);
  assert.match(mig, /q\.approval_status in \('none', 'sent'\)/);
  assert.match(mig, /shelf_restored_at \+ make_interval\(days => p_days\) <= now\(\)/, 'a restore holds for N days');
  assert.match(mig, /revoke all on function public\.apply_link_expiry_archive\(uuid\) from public, anon, authenticated;/);
  const lines = manifest.split('\n').filter((l) => /^forward\s/.test(l));
  const i39 = lines.findIndex((l) => l.includes('0039_link_autoexpire.sql'));
  const i40 = lines.findIndex((l) => l.includes('0040_link_expiry_archive.sql'));
  assert.ok(i39 >= 0 && i40 === i39 + 1, '0040 must follow 0039 in MANIFEST');
  // the paste = preflight (requires 0039) + the migration body, verbatim + verify rows
  assert.match(apply, /STOP: 0039 \(link auto-expire\) not installed/);
  const body = (s, end) => s.slice(s.indexOf('-- ---- 1) soft flags on quotes'), s.indexOf(end));
  assert.equal(body(apply, '-- ═══════════════════════════════ VERIFY'), body(mig, '-- ---- VERIFY (read-only)'));
  assert.match(apply, /select item, case when ok then 'ok' else 'FAIL' end as status/);
});

// ---- behaviour: the Control Center card -----------------------------------------
const cardSrc = ctl.slice(ctl.indexOf('/* ---------------- CLIENT LINK AUTO-EXPIRE (0039'), ctl.indexOf('  let dishCache=[];'));
const FIXED = Date.UTC(2026, 9, 7, 6, 0, 0);
function card({ get = async () => ({ enabled: false, days: 10, timezone: 'Asia/Kolkata' }),
                onExpiry = { action: 'keep', waiting: 3 }, confirm = true } = {}) {
  const els = {}; const L = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', hidden: id === 'lxCard' || id === 'lx_moveSet',
    value: '', checked: id === 'lx_move_keep', disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, focus() {},
    addEventListener(ev, fn) { (L[id + ':' + ev] = L[id + ':' + ev] || []).push(fn); } });
  const calls = []; const prompts = [];
  class FixedDate extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } }
  const autoExpire = { get, set: async (on, days) => { calls.push(['set', on, days]); return { enabled: on, days: days == null ? 10 : days }; } };
  if (onExpiry) autoExpire.onExpiry = {
    get: async () => { if (onExpiry instanceof Error) throw onExpiry; return onExpiry; },
    set: async (a) => { calls.push(['move', a]); return { action: a, waiting: 3 }; } };
  const ctx = {
    $: (s) => el(s.replace(/^#/, '')), esc: (s) => String(s), numAttr: (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d),
    errMsg: (e) => 'ERR ' + (e && e.message), setTimeout: () => 0, Date: FixedDate, Number, String, Object,
    BPUI: { guard: async (b, fn) => fn(), confirm: async (m) => { prompts.push(m); return confirm; },
            isMissingFunction: (e) => !!(e && e.code === 'PGRST202'), loadError: (c) => { c.innerHTML = 'LOADERR'; } },
    BPStore: { links: { autoExpire } },
  };
  vm.createContext(ctx);
  vm.runInContext(cardSrc + '\n;this.initLinkExpiry=initLinkExpiry;', ctx);
  const pick = (v) => { for (const k of ['keep', 'archive', 'delete']) el('lx_move_' + k).checked = k === v; };
  return { ctx, el, calls, prompts, pick, fire: async (id, ev) => { for (const f of L[id + ':' + ev] || []) await f({}); } };
}

await t('card loads Disabled + Keep; the choice is shown but greyed out while off', async () => {
  const s = card(); await s.ctx.initLinkExpiry();
  assert.equal(s.el('lx_state').innerHTML, 'Disabled'); assert.equal(s.el('lx_state').className, 'lxstate');
  assert.equal(s.el('lx_moveSet').hidden, false); assert.equal(s.el('lx_moveSet').disabled, true);
  assert.equal(s.el('lx_move_keep').checked, true);
  assert.match(s.el('lx_moveWait').textContent, /Turn auto-expire on/);
});

await t('switching on shows "Enabled — not saved yet" and unlocks the choice', async () => {
  const s = card(); await s.ctx.initLinkExpiry();
  s.el('lx_on').checked = true; await s.fire('lx_on', 'change');
  assert.match(s.el('lx_state').innerHTML, /^Enabled <small>— not saved yet<\/small>$/);
  assert.equal(s.el('lx_state').className, 'lxstate on'); assert.equal(s.el('lx_on').attrs['aria-checked'], 'true');
  assert.equal(s.el('lx_moveSet').disabled, false);
  s.pick('archive'); await s.fire('lx_move_archive', 'change');
  assert.match(s.el('lx_moveWait').textContent, /^3 quotes would move right now\. Quotes move to Archive the next time someone opens Quotes or the Dashboard/);
});

await t('saving on + Archive asks once (mentions the move), then saves both', async () => {
  const s = card(); await s.ctx.initLinkExpiry();
  s.el('lx_on').checked = true; s.pick('archive'); await s.fire('lx_save', 'click');
  assert.equal(s.prompts.length, 1);
  assert.match(s.prompts[0], /10 days after it was sent/);
  assert.match(s.prompts[0], /will move to Archive \(3 right now\) — you can restore them/);
  assert.deepEqual(s.calls, [['set', true, 10], ['move', 'archive']]);
  assert.match(s.el('lxMsg').innerHTML, /Expired, never-approved quotes go to Archive\./);
  assert.equal(s.el('lx_state').innerHTML, 'Enabled', 'saved → no "not saved yet"');
});

await t('cancel at the prompt saves nothing; unchanged choice is not re-sent', async () => {
  let s = card({ confirm: false }); await s.ctx.initLinkExpiry();
  s.el('lx_on').checked = true; s.pick('delete'); await s.fire('lx_save', 'click');
  assert.equal(s.calls.length, 0);
  s = card({ get: async () => ({ enabled: true, days: 10 }), onExpiry: { action: 'delete', waiting: 0 } }); await s.ctx.initLinkExpiry();
  assert.equal(s.el('lx_move_delete').checked, true);
  await s.fire('lx_save', 'click');
  assert.deepEqual(s.calls, [['set', true, 10]]);
  assert.doesNotMatch(s.prompts[0], /will move to/, 'no move warning when the choice did not change');
});

await t('switching off: no prompt, nothing moves while off', async () => {
  const s = card({ get: async () => ({ enabled: true, days: 10 }), onExpiry: { action: 'archive', waiting: 2 } }); await s.ctx.initLinkExpiry();
  s.el('lx_on').checked = false; await s.fire('lx_on', 'change'); await s.fire('lx_save', 'click');
  assert.equal(s.prompts.length, 0); assert.deepEqual(s.calls, [['set', false, 10]]);
  assert.equal(s.el('lx_state').innerHTML, 'Disabled');
});

await t('older database (0040 missing): the choice stays hidden, the switch still saves', async () => {
  const e = new Error('missing'); e.code = 'PGRST202';
  let s = card({ onExpiry: e }); await s.ctx.initLinkExpiry();
  assert.equal(s.el('lx_moveSet').hidden, true); assert.equal(s.el('lx_save').disabled, false);
  s.el('lx_on').checked = true; await s.fire('lx_save', 'click');
  assert.deepEqual(s.calls, [['set', true, 10]]);
  s = card({ onExpiry: null }); await s.ctx.initLinkExpiry();          // store-api without onExpiry
  assert.equal(s.el('lx_moveSet').hidden, true);
});

// ---- behaviour: the Quotes shelf block ---------------------------------------------
const shelfSrc = qh.slice(qh.indexOf('/* ---------- Archive / Deleted shelves (0040)'), qh.indexOf('/* ---------- end Archive / Deleted shelves ---------- */'));
assert.ok(shelfSrc.length > 1500, 'shelf block not found');
const SHELF = { rows: [
  { id: 'a1', code: 'Q-A1', title: 'Wedding', event_type: 'Wedding', status: 'quote', client_name: 'Ann', total: 1000,
    shelf: 'archived', shelved_at: '2026-10-20T10:00:00Z', reason: 'link_expired', link_expired_at: '2026-10-12T09:00:00Z' },
  { id: 'a2', code: 'Q-A2', title: 'Party', event_type: 'Birthday', status: 'confirmed', client_name: 'Abe', total: 500,
    shelf: 'archived', shelved_at: '2026-10-05T10:00:00Z', reason: 'manual', link_expired_at: null },
  { id: 'd1', code: 'Q-D1', title: 'Gala', event_type: 'Corporate', status: 'quote', client_name: 'Dee', total: 0,
    shelf: 'deleted', shelved_at: '2026-10-21T10:00:00Z', reason: 'link_expired', link_expired_at: '2026-10-11T09:00:00Z' },
], archived_count: 7, deleted_count: 1 };
function quotesPage({ mode = 'supabase', list = async () => SHELF, tick = async () => ({ ran: true, moved: 0 }), confirm = true } = {}) {
  const els = {}; const el = (id) => els[id] || (els[id] = { id, hidden: id === 'tab_deleted' || id === 'cnt_archived', textContent: '', value: '' });
  const calls = []; const toasts = []; const prompts = [];
  const ctx = {
    $: (s) => el(s.replace(/^#/, '')), Number, String, Array, Promise, Date, isNaN,
    filter: 'all', typeFilter: '', quotes: [{ id: 'x1', code: 'Q-X1' }, { id: 'a1', code: 'Q-A1' }], detailCache: {},
    pager: { remove: (id) => calls.push(['pager.remove', id]) },
    render: () => calls.push(['render']), reloadQuiet: () => calls.push(['reloadQuiet']),
    BPUI: { guard: async (b, fn) => fn(), confirm: async (m) => { prompts.push(m); return confirm; },
            toast: (m, o) => toasts.push([m, o && o.type]), friendlyError: (e) => 'ERR ' + e.message },
    BPStore: { mode: () => mode, quoteShelf: { list: async () => { calls.push(['list']); return list(); }, tick: async () => { calls.push(['tick']); return tick(); },
      move: async (id, s) => { calls.push(['move', id, s]); return {}; }, restore: async (id) => { calls.push(['restore', id]); return {}; } } },
  };
  vm.createContext(ctx);
  vm.runInContext(shelfSrc + '\n;Object.assign(this,{shelf,shelfPage,shelfNote,loadShelf,runShelfTick,shelfMove,restoreQuote});', ctx);
  return { ctx, el, calls, toasts, prompts };
}
const page = (rows, hasMore = true) => async () => ({ rows, hasMore, offset: 25 });

await t('shelf loads: tab counts painted, Deleted tab revealed', async () => {
  const p = quotesPage(); await p.ctx.loadShelf();
  assert.equal(p.ctx.shelf.ready, true);
  assert.equal(p.el('cnt_archived').hidden, false); assert.equal(p.el('cnt_archived').textContent, '7');
  assert.equal(p.el('tab_deleted').hidden, false); assert.equal(p.el('cnt_deleted').textContent, '1');
});

await t('0040 not installed / offline: classic tabs, no Deleted tab, no calls offline', async () => {
  let p = quotesPage({ list: async () => { const e = new Error('missing'); e.code = 'PGRST202'; throw e; } }); await p.ctx.loadShelf();
  assert.equal(p.ctx.shelf.ready, false); assert.equal(p.el('tab_deleted').hidden, true); assert.equal(p.el('cnt_archived').hidden, true);
  p = quotesPage({ mode: 'local' }); await p.ctx.loadShelf(); await p.ctx.runShelfTick();
  assert.equal(p.calls.filter((c) => c[0] === 'list' || c[0] === 'tick').length, 0);
});

await t('day-to-day tabs drop archived / deleted quotes from the server page', async () => {
  const p = quotesPage(); p.ctx.filter = 'all';
  const r = await p.ctx.shelfPage(0, page([{ id: 'x1' }, { id: 'a1' }, { id: 'd1' }, { id: 'x2' }]));
  assert.deepEqual(r.rows.map((x) => x.id), ['x1', 'x2']); assert.equal(r.hasMore, true); assert.equal(r.offset, 25);
});

await t('Archive tab: flagged-archived first (page 1 only), then the finished events', async () => {
  const p = quotesPage(); p.ctx.filter = 'archived';
  let r = await p.ctx.shelfPage(0, page([{ id: 'c1', status: 'cancelled' }, { id: 'a1' }]));
  assert.deepEqual(r.rows.map((x) => x.id), ['a1', 'a2', 'c1']);
  assert.equal(r.rows[0].client.name, 'Ann'); assert.equal(r.rows[0].total, 1000); assert.equal(r.rows[0].eventType, 'Wedding');
  r = await p.ctx.shelfPage(25, page([{ id: 'c2' }], false));
  assert.deepEqual(r.rows.map((x) => x.id), ['c2']);
  p.ctx.typeFilter = 'birthday';
  r = await p.ctx.shelfPage(0, page([]));
  assert.deepEqual(r.rows.map((x) => x.id), ['a2'], 'type filter applies to the shelf rows too');
});

await t('Deleted tab: only flagged-deleted rows, one page, no server list call; search applies', async () => {
  const p = quotesPage(); p.ctx.filter = 'deleted'; let based = 0;
  let r = await p.ctx.shelfPage(0, async () => { based++; return { rows: [{ id: 'x1' }] }; });
  assert.deepEqual(r.rows.map((x) => x.id), ['d1']); assert.equal(r.hasMore, false); assert.equal(based, 0);
  p.el('search').value = 'nomatch';
  r = await p.ctx.shelfPage(0, page([]));
  assert.equal(r.rows.length, 0);
});

await t('note: "Moved automatically — client link expired on <date>" / by hand', () => {
  const p = quotesPage();
  assert.equal(p.ctx.shelfNote(SHELF.rows[0]), 'Moved automatically — client link expired on 12 Oct 2026');
  assert.equal(p.ctx.shelfNote(SHELF.rows[1]), 'Archived by hand on 5 Oct 2026');
  assert.equal(p.ctx.shelfNote({ shelf: 'deleted', reason: 'manual', shelved_at: '2026-10-21T10:00:00Z' }), 'Moved to Deleted by hand on 21 Oct 2026');
});

await t('tick on open: a move shows a toast and refreshes the list; nothing moved = silent', async () => {
  let p = quotesPage({ tick: async () => ({ ran: true, moved: 2, action: 'archive' }) }); await p.ctx.runShelfTick();
  assert.match(p.toasts[0][0], /^2 quotes moved to the Archive — the client link expired/); assert.ok(p.calls.some((c) => c[0] === 'reloadQuiet'));
  p = quotesPage({ tick: async () => ({ ran: false, moved: 0 }) }); await p.ctx.runShelfTick();
  assert.equal(p.toasts.length, 0); assert.ok(!p.calls.some((c) => c[0] === 'reloadQuiet'));
  p = quotesPage({ tick: async () => { throw new Error('boom'); } }); await p.ctx.runShelfTick();   // never surfaces
  assert.equal(p.toasts.length, 0);
});

await t('Delete = move to Deleted (says nothing is erased); Restore puts it back', async () => {
  let p = quotesPage(); await p.ctx.shelfMove('x1', 'delete', null);
  assert.match(p.prompts[0], /Move Q-X1 to Deleted quotes\? Nothing is erased/);
  assert.deepEqual(p.calls.filter((c) => c[0] === 'move'), [['move', 'x1', 'delete']]);
  assert.ok(p.calls.some((c) => c[0] === 'pager.remove' && c[1] === 'x1'));
  p = quotesPage({ confirm: false }); await p.ctx.shelfMove('x1', 'archive', null);
  assert.equal(p.calls.filter((c) => c[0] === 'move').length, 0, 'cancel moves nothing');
  p = quotesPage(); await p.ctx.restoreQuote('a1', null);
  assert.deepEqual(p.calls.filter((c) => c[0] === 'restore'), [['restore', 'a1']]);
  assert.match(p.toasts[0][0], /Restored/);
});

console.log(`\nlink-expiry-archive-ui: ${n} passed`);
