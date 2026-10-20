// r24-contact.test.mjs - r24 (0271): the public Contact sales page + the home page contact form -> submit_sales_enquiry,
// the Suggestions box (profile menu dialog + public /suggest) -> submit_suggestion, HQ -> Requests (Sales enquiries,
// Suggestions, e-mail alert settings), the queued e-mails (comms-dispatch helm-notices.mjs) and the SQL contract.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { helmNoticeEmail, NOTICE_KINDS, NOTICE_TX_REASON } from '../supabase/functions/comms-dispatch/helm-notices.mjs';
import { PAGES } from '../scripts/gen-site-header.mjs';

const root = new URL('..', import.meta.url);
const rd = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const sql = rd('supabase/migrations/0271_contact_sales.sql');
const apply = rd('supabase/APPLY-0271.sql');

t('contact-sales page: form fields, honeypot, consent, no inline script / style, generated header', () => {
  const h = rd('public/contact-sales.html');
  for (const id of ['cs-name', 'cs-email', 'cs-phone', 'cs-company', 'cs-city', 'cs-team', 'cs-events', 'cs-plan', 'cs-message', 'cs-website', 'cs-consent'])
    assert.ok(h.includes(`id="${id}"`), id);
  assert.ok(!/<script>(?!\s*<\/script>)/.test(h) && !/<script(?![^>]*\bsrc=)[^>]*>/.test(h.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')), 'no inline script');
  assert.ok(!/\sstyle="/.test(h), 'no inline style');
  assert.equal(PAGES['contact-sales.html'], 'sticky'); assert.equal(PAGES['suggest.html'], 'sticky');
  assert.ok(h.includes('site-header: generated from index.html'));
  assert.ok(h.includes('href="/suggest"'), 'footer links the suggestions page');
});

t('contact-sales.js: ?plan= prefill (only known plans), anon RPC, nothing else called', () => {
  const j = rd('public/contact-sales.js');
  assert.ok(j.includes('rpc("submit_sales_enquiry"'));
  assert.equal((j.match(/rpc\("/g) || []).length, 1);
  const els = {}; const mk = (id) => (els[id] = els[id] || { id, value: '', checked: false, hidden: false, textContent: '', setAttribute() {}, removeAttribute() {}, focus() {}, addEventListener() {} });
  for (const plan of ['studio', 'enterprise', 'starter', 'gold', '']) {
    for (const k of Object.keys(els)) delete els[k];
    vm.runInNewContext(j, { window: {}, document: { getElementById: mk }, location: { search: '?plan=' + plan }, URLSearchParams, fetch: () => {} });
    assert.equal((els['cs-plan'] || { value: '' }).value, ['studio', 'enterprise', 'starter'].includes(plan) ? plan : '', plan);
  }
});

t('home contact form: no more mailto, posts to submit_sales_enquiry with source home + consent + honeypot', () => {
  const j = rd('public/home.js');
  assert.ok(!/mailto:sales@helm\.events\?subject/.test(j), 'mailto handler removed');
  assert.ok(j.includes("/rest/v1/rpc/submit_sales_enquiry") && j.includes("source: 'home'") && j.includes("name: 'website'"));
  assert.ok(/s\.src = '\/config\.js(\?v=\d+)?'/.test(j), 'config.js loaded on first use');
  assert.ok(j.includes("a.href = '/suggest'"), 'footer suggestion link');
});

t('suggestions: profile menu item for every role, lazy dialog, store method, public page', () => {
  const a = rd('public/auth-ui.js');
  assert.ok(a.includes('{ id: "suggest", label: "Send a suggestion" }') && a.includes('"/suggest.js?v=1"'));
  assert.ok(rd('public/store-api.js').includes('suggest: (p) => rpc("submit_suggestion", { p: p || {} })'));
  const s = rd('public/suggest.js');
  assert.ok(s.includes('window.HelmSuggest = { open: openDialog }') && s.includes('/rest/v1/rpc/submit_suggestion'));
  assert.ok(!/innerHTML/.test(s));
  const h = rd('public/suggest.html');
  for (const id of ['sg-form', 'sg-kind', 'sg-message', 'sg-email', 'sg-website', 'sg-done']) assert.ok(h.includes(`id="${id}"`), id);
});

t('HQ: Requests shows Sales enquiries + Suggestions + alert settings; #requests opens the tab', () => {
  const h = rd('public/hq.html'), j = rd('public/hq.js');
  for (const id of ['tSe', 'fSe', 'tSg', 'fSg', 'seEmail', 'seAck', 'seOpen', 'btnSeSet']) assert.ok(h.includes(`id="${id}"`), id);
  for (const fn of ['hq_sales_enquiries', 'hq_set_sales_enquiry', 'hq_set_sales_enquiry_settings', 'hq_suggestions', 'hq_set_suggestion'])
    assert.ok(j.includes(`"${fn}"`) && sql.includes(`function public.${fn}(`), fn);
  assert.ok(j.includes('location.hash === "#requests"'));
  assert.ok(!/innerHTML/.test(j));
});

t('e-mails: alert to the HQ address (reply goes to the sender), thank-you, suggestion; bad data -> null', () => {
  for (const k of ['sales_enquiry', 'sales_enquiry_ack', 'suggestion']) { assert.ok(NOTICE_KINDS.includes(k)); assert.ok(NOTICE_TX_REASON[k]); }
  const m = helmNoticeEmail('sales_enquiry', { name: 'Priya', email: 'p@x.in', company: 'Sharma Events', plan: 'enterprise', team_size: '6-15',
    events_per_year: '21-50', message: 'Hi\u0007 there', source: 'home' }, 'https://www.helm.events');
  assert.ok(m.subject.includes('Sharma Events') && m.subject.includes('Enterprise'));
  assert.ok(m.text.includes('Work e-mail: p@x.in') && m.text.includes('6-15 people') && m.text.includes('(home page)') && !/\u0007/.test(m.text));
  assert.ok(m.text.includes('https://www.helm.events/hq#requests'));
  assert.equal(helmNoticeEmail('sales_enquiry', { name: 'x', email: 'bad', company: 'c' }), null);
  const a = helmNoticeEmail('sales_enquiry_ack', { name: 'Priya', plan: 'studio' }, 'https://www.helm.events');
  assert.ok(a.text.startsWith('Hi Priya,') && a.text.includes('Studio plan') && a.text.includes('/signup?mode=trial'));
  const s = helmNoticeEmail('suggestion', { message: 'Add a Gantt view', category: 'idea', source: 'app', who: 'Asha', studio: 'Aurora' }, '');
  assert.ok(s.subject.startsWith('Helm suggestion (Idea)') && s.text.includes('From: Asha (Aurora)'));
  assert.equal(helmNoticeEmail('suggestion', { message: '  ' }), null);
  const idx = rd('supabase/functions/comms-dispatch/index.ts');
  assert.ok(idx.includes('(kind === "sales_request" || kind === "sales_enquiry" || kind === "suggestion")'));
});

t('SQL 0271: additive, anon RPCs validated + rate-limited, HQ gated, default notifications@helm.events, APPLY in sync', () => {
  assert.ok(!/\bdrop table\b|\bdelete from\b|\btruncate\b/i.test(sql), 'nothing deleted');
  assert.ok(sql.includes("default 'notifications@helm.events'") && !sql.includes('requests@helm.events'));
  for (const b of ["'sales.ip'", "'sales.email'", "'sales.phone'", "'sales.all'", "'sugg.user'", "'sugg.ip'", "'sugg.all'"]) assert.ok(sql.includes(b), b);
  assert.ok(sql.includes("perform public._hq_gate('hq_sales_enquiries'") && sql.includes("perform public._hq_wgate('hq.sales_enquiry.update'"));
  assert.ok(sql.includes("perform public._hq_gate('hq_suggestions'") && sql.includes("perform public._hq_wgate('hq.suggestion.update'"));
  assert.ok(/grant execute on function public\.submit_sales_enquiry\(jsonb\) to anon/.test(sql) && /grant execute on function public\.submit_suggestion\(jsonb\) to anon/.test(sql));
  assert.ok(!/grant execute on function public\.hq_[a-z_]+\([^)]*\) to anon/.test(sql));
  assert.ok(/[\x00-\x08\x0b\x0c\x0e-\x1f\x80-￿]/.test(sql) === false, 'ASCII only');
  assert.ok(apply.includes(sql.trim()), 'APPLY-0271 carries the migration body');
  assert.ok(/^begin;/m.test(apply) && /^commit;/m.test(apply) && apply.includes('-- VERIFY'));
  assert.ok(rd('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0271_contact_sales.sql'));
});

t('vercel: /contact-sales + /suggest served by clean URLs, noindex header', () => {
  const v = JSON.parse(rd('vercel.json'));
  assert.equal(v.cleanUrls, true);
  const h = v.headers.find((x) => x.source === '/(contact-sales|suggest)(\\.html)?');
  assert.ok(h && h.headers.some((x) => x.key === 'X-Robots-Tag' && /noindex/.test(x.value)));
});

console.log(`r24-contact: ${n} checks passed`);
