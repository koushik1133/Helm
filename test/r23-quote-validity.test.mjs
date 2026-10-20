// r23 (0262): quote "Valid until" - pure helpers (dd/mm/yyyy, pill, client words, settings parsing), the client
// banner + "Request a new quote", the staff line (Extend / Change date), the Control Center card, page wiring
// (approve / booklet / flow / event / quotes / control), store-api calls + the Attention tab, the dispatcher
// message (fails closed), and the SQL shape (additive, wrapped once, self-check rows, ASCII).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const JS = read('public/quote-validity.js'), CSS = read('public/quote-validity.css'), API = read('public/store-api.js');
const AP = read('public/approve.html'), BK = read('public/booklet.html'), BJ = read('public/booklet.js'), FL = read('public/flow.html');
const EV = read('public/event.html'), QU = read('public/quotes.html'), CC = read('public/control.html'), SPLIT = read('public/control-split.js');
const M = read('supabase/migrations/0262_quote_validity.sql'), A = read('supabase/APPLY-0262.sql'), MAN = read('supabase/migrations/MANIFEST');
const DISP = read('supabase/functions/comms-dispatch/index.ts');
const DOC = read('docs/manual/r23-quote-validity.md');
let n = 0, fail = 0; const pending = [];
const t = (name, fn) => { pending.push((async () => { try { await fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name, e.message); } })()); };

/* ---- a tiny DOM ---- */
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this._text = ''; this.listeners = {}; this.parentNode = null; this.hidden = false; this.className = ''; this.disabled = false; this.value = '';
    const self = this; this.classList = { add(c) { self.className = (self.className + ' ' + c).trim(); }, remove() {}, toggle() {}, contains(c) { return self.className.split(/\s+/).includes(c); } }; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  get firstChild() { return this.children[0] || null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'type') this.type = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  async click() { for (const f of (this.listeners.click || [])) await f({ target: this, preventDefault() {} }); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  scrollIntoView() {} focus() {}
  all(pred, out = []) { this.children.forEach((c) => { if (pred(c)) out.push(c); c.all(pred, out); }); return out; }
}
const doc = { readyState: 'complete', createElement: (t) => new El(t), createTextNode: (s) => { const e = new El('#text'); e._text = String(s); return e; },
  querySelectorAll: () => [], getElementById: () => null, addEventListener() {} };
function load(store) {
  const win = { BPStore: store ? { quoteValidity: store, auth: { user: () => ({ id: 'u' }) }, fmtDateTime: (x) => String(x).slice(0, 10) } : undefined,
    location: { search: '?id=11111111-2222-4333-8444-555555555555', hash: '' }, BPUI: { toast() {} } };
  const ctx = { window: win, document: doc, console, URLSearchParams, setTimeout: () => 0 }; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(JS, ctx);
  return win.HelmQuoteValidity;
}
const Q = load(null);
const tick = () => new Promise((r) => setTimeout(r, 5));
const find = (root, pred) => root.all(pred)[0];

t('dd/mm/yyyy + relative words', () => {
  assert.equal(Q.fmtDMY('2026-10-23'), '23/10/2026'); assert.equal(Q.fmtDMY('bad'), '');
  assert.equal(Q.relText(14), 'Expires in 14 days'); assert.equal(Q.relText(1), 'Expires tomorrow'); assert.equal(Q.relText(0), 'Expires today');
  assert.equal(Q.relText(-1), 'Expired yesterday'); assert.equal(Q.relText(-4), 'Expired 4 days ago');
  assert.equal(Q.addDaysISO('2026-12-31', 1), '2027-01-01');
});
t('list pill: grey far away, amber soon, red expired, nothing for done / none', () => {
  assert.equal(Q.pill({ state: 'valid', days_left: 10, valid_until_label: '30/10/2026' }).cls, 'hs-draft');
  const soon = Q.pill({ state: 'valid', days_left: 2, valid_until: '2026-10-22' });
  assert.equal(soon.cls, 'qv-due'); assert.equal(soon.text, 'Expires in 2 days'); assert.equal(soon.title, 'Valid until 22/10/2026');
  const ex = Q.pill({ state: 'expired', days_left: -3, valid_until_label: '17/10/2026', locked: true });
  assert.equal(ex.cls, 'hs-overdue'); assert.equal(ex.text, 'Expired 3 days ago'); assert.match(ex.title, /can't approve/);
  assert.equal(Q.pill({ state: 'done' }), null); assert.equal(Q.pill(null), null); assert.equal(Q.pill({ state: 'none' }), null);
});
t('client words: valid / last days / expired with the studio name', () => {
  const v = Q.clientView({ state: 'valid', days_left: 9, valid_until_label: '29/10/2026', studio: 'Aurora' });
  assert.equal(v.lead, 'This quote is valid until 29/10/2026.'); assert.equal(v.text, ''); assert.equal(v.tone, 'ok');
  assert.equal(Q.clientView({ state: 'valid', days_left: 0, valid_until_label: '20/10/2026' }).text, 'Today is the last day to approve it.');
  const e = Q.clientView({ state: 'expired', days_left: -2, valid_until_label: '18/10/2026', studio: 'Aurora', locked: true });
  assert.equal(e.lead, 'This quote has expired - ask Aurora for an updated one.'); assert.match(e.text, /can't be approved/); assert.ok(e.canRequest);
  assert.equal(Q.clientView({ state: 'expired', studio: 'Aurora', requested: true }).canRequest, false);
  assert.equal(Q.clientView({ state: 'done' }).show, false); assert.equal(Q.clientView(null).show, false);
});
t('settings parsing: reminder days + validity days', () => {
  const J = (x) => JSON.stringify(x);
  assert.equal(J(Q.parseReminderDays('1, 3 7').value), '[7,3,1]'); assert.equal(J(Q.parseReminderDays('3,3,1').value), '[3,1]');
  assert.equal(J(Q.parseReminderDays('').value), '[]');
  assert.equal(Q.parseReminderDays('61').ok, false); assert.equal(Q.parseReminderDays('a').ok, false); assert.equal(Q.parseReminderDays('1 2 3 4 5 6').ok, false);
  assert.equal(Q.validateDays('14').value, 14); assert.equal(Q.validateDays('0').ok, false); assert.equal(Q.validateDays('366').ok, false); assert.equal(Q.validateDays('2.5').ok, false);
});
t('client banner: expired -> "Request a new quote" -> thanks; onState tells the page it is locked', async () => {
  const calls = [];
  const X = load({ publicState: async () => ({ state: 'expired', days_left: -1, valid_until_label: '19/10/2026', studio: 'Aurora', locked: true, requested: false }),
                   requestNew: async (k, tok) => { calls.push([k, tok]); return { status: 'sent', studio: 'Aurora' }; } });
  const el = new El('div'); el.hidden = true; let seen = null;
  await X.mountClient(el, 'quote', 'tok', { onState: (s) => { seen = s; } });
  assert.equal(el.hidden, false); assert.match(el.textContent, /This quote has expired - ask Aurora for an updated one\./);
  assert.ok(seen && seen.locked);
  const b = find(el, (c) => c.tagName === 'BUTTON'); assert.equal(b.textContent, 'Request a new quote');
  await b.click(); await tick();
  assert.deepEqual(calls, [['quote', 'tok']]); assert.match(el.textContent, /Thanks - Aurora has been asked to send you an updated quote\./);
  assert.ok(!find(el, (c) => c.tagName === 'BUTTON'), 'button gone after sending');
});
t('client banner: valid shows the date, approved / missing shows nothing', async () => {
  let X = load({ publicState: async () => ({ state: 'valid', days_left: 12, valid_until_label: '01/11/2026', studio: 'Aurora' }) });
  let el = new El('div'); await X.mountClient(el, 'booklet', 'tok');
  assert.equal(el.hidden, false); assert.match(el.textContent, /valid until 01\/11\/2026/); assert.ok(!find(el, (c) => c.tagName === 'BUTTON'));
  X = load({ publicState: async () => ({ state: 'done' }) }); el = new El('div'); el.hidden = true; await X.mountClient(el, 'quote', 'tok'); assert.equal(el.hidden, true);
  X = load({ publicState: async () => null }); el = new El('div'); el.hidden = true; await X.mountClient(el, 'quote', 'tok'); assert.equal(el.hidden, true);
});
t('staff line: Extend +14 days (one click) and Change date only when allowed', async () => {
  const ext = [];
  const base = { state: 'valid', days_left: 2, valid_until: '2026-10-22', valid_until_label: '22/10/2026', can_edit: true, can_override: false, default_days: 14, today: '2026-10-20', log: [{ action: 'auto', new: '22/10/2026', at: '2026-10-08T00:00:00Z' }] };
  const X = load({ get: async () => base, extend: async (id) => { ext.push(id); return Object.assign({}, base, { days_left: 16, valid_until: '2026-11-05', valid_until_label: '05/11/2026' }); } });
  const el = new El('div'); el.hidden = true; el.setAttribute('data-qv-staff', '');
  await X.mountStaff(el);
  assert.equal(el.hidden, false); assert.match(el.textContent, /Valid until 22\/10\/2026 · Expires in 2 days/);
  assert.ok(!find(el, (c) => c.tagName === 'INPUT'), 'no date picker when custom dates are off');
  const b = find(el, (c) => c.tagName === 'BUTTON'); assert.equal(b.textContent, 'Extend +14 days');
  await b.click(); await tick();
  assert.deepEqual(ext, ['11111111-2222-4333-8444-555555555555']); assert.match(el.textContent, /05\/11\/2026/);
  assert.match(el.textContent, /History/);
});
t('staff line: picker range today..+1 year; hidden for approved / no permission / before 0262', async () => {
  let X = load({ get: async () => ({ state: 'expired', days_left: -1, valid_until: '2026-10-19', valid_until_label: '19/10/2026', locked: true, can_edit: true, can_override: true, default_days: 14, today: '2026-10-20', log: [] }) });
  let el = new El('div'); await X.mountStaff(el);
  const inp = find(el, (c) => c.tagName === 'INPUT'); assert.equal(inp.attrs.min, '2026-10-20'); assert.equal(inp.attrs.max, '2027-10-20');
  assert.match(el.textContent, /can't approve it until you extend it/);
  X = load({ get: async () => ({ state: 'done' }) }); el = new El('div'); await X.mountStaff(el); assert.equal(el.hidden, true);
  X = load({ get: async () => ({ state: 'none', can_edit: false }) }); el = new El('div'); await X.mountStaff(el); assert.equal(el.hidden, true);
  X = load({ get: async () => null }); el = new El('div'); await X.mountStaff(el); assert.equal(el.hidden, true);
  X = load({ get: async () => ({ state: 'none', can_edit: true, default_days: 14, log: [] }) }); el = new El('div'); await X.mountStaff(el);
  assert.equal(el.hidden, false); assert.match(el.textContent, /No valid-until date/); assert.match(el.textContent, /Set valid until \(\+14 days\)/);
});
t('page wiring: client pages + staff pages + Control Center', () => {
  for (const [name, html] of [['approve', AP], ['booklet', BK], ['flow', FL], ['event', EV], ['quotes', QU], ['control', CC]]) {
    assert.match(html, /quote-validity\.js\?v=\d+/, name + ' loads quote-validity.js'); assert.match(html, /quote-validity\.css\?v=\d+/, name + ' loads quote-validity.css');
  }
  assert.match(AP, /id="qvBanner"/); assert.match(AP, /mountClient\(\$\("#qvBanner"\), "quote", token/); assert.match(AP, /\["#step1","#step2"\]/);
  assert.match(AP, /r\.error==="quote_expired"/);
  assert.match(BK, /id="qvBanner"/); assert.match(BJ, /mountClient\(\$\("#qvBanner"\), "booklet", token\)/);
  assert.match(FL, /id="qvFlow" data-qv-staff/); assert.match(FL, /HelmQuoteValidity\.refreshStaff\(\)/);
  assert.match(EV, /id="quote-validity" data-qv-staff/);
  assert.match(QU, /refreshValidity\(\)/); assert.match(QU, /function paintValidity\(\)/); assert.match(QU, /s\.textContent=p\.text/); assert.match(QU, /quotes that expire soon/);
  for (const id of ['qvCard', 'qv_on', 'qv_days', 'qv_rem', 'qv_lock', 'qv_over', 'qv_save', 'qv_apply', 'qv_apply_note', 'qv_msg', 'qv_ro']) assert.match(CC, new RegExp('id="' + id + '"'), id);
  // r25 (0274): the two reminders are switched on / off only in Control Center -> Automations
  assert.ok(!/id="qv_cli"|id="qv_stu"/.test(CC), 'no second on / off for the reminders'); assert.match(CC, /au-onoff[^]*#automations/);
  assert.match(SPLIT, /id==="qvCard"\) return "links"/); assert.match(SPLIT, /"#quote-validity":"links"/);
  assert.ok(!/innerHTML/.test(JS), 'quote-validity.js builds the DOM with textContent only');
  assert.match(CSS, /@media \(max-width:480px\)/);
});
t('store-api: one namespace, every RPC, Attention tab adds expiring ids, bell labels + deep link', () => {
  for (const f of ['quote_validity_settings_get', 'quote_validity_settings_set', 'quote_validity_get', 'quote_validity_list', 'quotes_expiring_soon',
                   'quote_validity_extend', 'quote_validity_set', 'quote_validity_apply_open', 'public_quote_validity', 'public_request_new_quote'])
    assert.ok(API.includes('rpc("' + f + '"'), f);
  assert.match(API, /integrations, quoteValidity,/);
  // r23 staging: the Attention ids are one list with 0261's "viewed but not approved" (extraIds = link views + expiring soon)
  assert.match(API, /function sbQuoteView\(q, view, today, shelf, extraIds\)/);
  assert.match(API, /q\.or\("event_date\.lt\." \+ today \+ ",id\.in\.\(" \+ extraIds\.join\(","\) \+ "\)"\)/);
  assert.match(API, /const extraIds = o\.view === "attention" \? \[\.\.\.new Set\(\[\.\.\.\(attnIds \|\| \[\]\), \.\.\.\(soon \|\| \[\]\)\]\)\]\.slice\(0, 300\) : null;/);
  assert.match(API, /quoteValidity\.expiringSoon\(\)\.catch\(\(\) => \[\]\)/);
  assert.match(API, /quote_expiring: \[/); assert.match(API, /quote_renew_request: \[/);
  assert.match(API, /"event\.html\?id=" \+ enc\(q\) \+ "#quote-validity"/);
});
t('dispatcher: fixed text + approval link from the claim; anything odd -> skipped', async () => {
  const { quoteExpiryMessage, QUOTE_PATH } = await import('../supabase/functions/comms-dispatch/quote-expiry.mjs');
  const p = { body: 'Hi Priya, your quote A-262-5 from Aurora is valid until 23/10/2026.', valid_until_label: '23/10/2026', studio: 'Aurora', days_left: 1,
              link_path: 'aurora/quote/df224de1-b3dd-429a-a4c1-4d3dd83f1a15' };
  const m = quoteExpiryMessage(p, 'https://www.helm.events');
  assert.equal(m.subject, 'Your quote from Aurora is valid until 23/10/2026');
  assert.equal(m.text, 'Hi Priya, your quote A-262-5 from Aurora is valid until 23/10/2026. Tomorrow is the last day. Review and approve it here: https://www.helm.events/aurora/quote/df224de1-b3dd-429a-a4c1-4d3dd83f1a15');
  assert.equal(quoteExpiryMessage(Object.assign({}, p, { link_path: 'evil.com/x' }), 'https://www.helm.events').text, '');
  assert.equal(quoteExpiryMessage(Object.assign({}, p, { body: 'Click http://evil' }), 'https://www.helm.events').text, '');
  assert.equal(quoteExpiryMessage(p, 'http://insecure').text, '');
  assert.ok(QUOTE_PATH.test('approve.html?token=df224de1-b3dd-429a-a4c1-4d3dd83f1a15'));
  assert.match(DISP, /purpose === "quote_expiry"\) return quoteExpiryMessage\(payload, origin\)/);
  assert.match(DISP, /if \(purpose === "quote_expiry"\) extra = \{ footer: txFooter\("client_link"/);
});
t('SQL: additive side table, wrapped once, server lock, superset CHECK, cron only if present, ASCII, APPLY + MANIFEST', () => {
  assert.ok(!/[^\x00-\x7f]/.test(M) && !/[^\x00-\x7f]/.test(A), 'ASCII only');
  assert.match(M, /create table if not exists public\.quote_validity \(/); assert.match(M, /create table if not exists public\.quote_validity_log \(/);
  assert.ok(!/alter table public\.quotes add column/i.test(M), 'quotes table not changed');
  assert.ok(!/\bdelete from\b|\btruncate\b|drop table/i.test(M), 'nothing deleted');
  assert.match(M, /if to_regprocedure\('public\.verify_and_consent__pre0262\(uuid,text,text,boolean,text,text,text,text\)'\) is null then/);
  assert.match(M, /if to_regprocedure\('public\.comms_outbox_claim__pre0262\(integer\)'\) is null then/);
  assert.match(M, /'error', 'quote_expired'/); assert.match(M, /coalesce\(\(s ->> 'locked'\)::boolean, false\)/);
  assert.match(M, /comms_outbox_purpose_check_0262/);
  assert.match(M, /if exists \(select 1 from pg_extension where extname = 'pg_cron'\)/);
  assert.match(M, /coalesce\(public\.user_role\(\), ''\) <> 'admin'/, 'apply to open quotes is admin only');
  assert.ok(A.includes(M.trim().slice(0, 4000)) && /^begin;$/m.test(A) && /^commit;$/m.test(A) && /'09 the reminder tick exists/.test(A));
  assert.match(MAN, /^forward  supabase\/migrations\/0262_quote_validity\.sql$/m);
});
t('manual section for the docs agent', () => {
  assert.match(DOC, /Valid until/); assert.match(DOC, /Control Center/); assert.match(DOC, /Request a new quote/);
});

await Promise.all(pending);
console.log(`\n${n} passed, ${fail} failed`);
if (fail) process.exit(1);
