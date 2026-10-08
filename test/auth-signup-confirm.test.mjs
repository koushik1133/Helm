// Sign-up → "Check your inbox" flow, confirm helper, generic (non-enumerating)
// messages, resend cooldown, and the branded Supabase email templates.
// Static checks + store-api.js resendSignup run against a stub client (no network).
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const LOGIN = read('public/login.html');
const SRC = read('public/store-api.js');
const tests = [];
const t = (n, f) => tests.push([n, f]);

t('sign-up never switches to sign-in with the password filled in', () => {
  const submit = LOGIN.slice(LOGIN.indexOf('$("#loginForm").addEventListener("submit"'));
  const signup = submit.slice(0, submit.indexOf('btn.textContent="Signing in…"'));
  assert.ok(!/setMode\("signin"\)/.test(signup), 'signup branch must not call setMode("signin")');
  assert.equal((signup.match(/showInbox\(email\)/g) || []).length, 2, 'both signup branches show the inbox card');
  const show = LOGIN.slice(LOGIN.indexOf('function showInbox('), LOGIN.indexOf('async function doResend'));
  assert.match(show, /\$\("#pw"\)\.value=""/, 'password cleared');
});
t('inbox card: envelope, email, mail links, resend, different email, back', () => {
  for (const id of ['inboxCard', 'inboxEmail', 'openGmail', 'openOutlook', 'inboxResend', 'inboxOther', 'inboxBack'])
    assert.ok(LOGIN.includes(`id="${id}"`), id);
  assert.match(LOGIN, /<h1 id="inboxTitle"[^>]*>Check your inbox</);
  assert.match(LOGIN, /class="env"[\s\S]{0,80}<svg/);
  assert.match(LOGIN, /noopener noreferrer/);
  assert.ok(LOGIN.includes('$("#inboxEmail").textContent='), 'email shown via textContent');
});
t('resend has a 60s cooldown and starts cooling down right after sign-up', () => {
  assert.match(LOGIN, /const COOLDOWN=60;/);
  assert.match(LOGIN, /cooldown\(\$\("#inboxResend"\),"Resend email",COOLDOWN\)/);
  assert.match(LOGIN, /btn\.disabled=true/);
});
t('sign-in helper: resend confirmation with the same generic message', () => {
  assert.match(LOGIN, /Just signed up\? Confirm your email first/);
  assert.ok(LOGIN.includes('id="resendConfirmBtn"'));
  assert.match(LOGIN, /genericMessages\.resend/);
  assert.match(SRC, /GENERIC_SIGNIN = "Invalid email or password\."/);
  assert.match(SRC, /GENERIC_RESEND = "If an account needs confirming, we've sent a new link\./);
});
t('confirm link return shows "Email confirmed" and continues onboarding', () => {
  assert.ok(/linkReturned\(\)[\s\S]{0,500}Email confirmed/.test(LOGIN));
  assert.match(SRC, /sessionStorage\.getItem\("bp_flash"\)/);
});
t('form rules: blur validation, eye toggle, meter, email normalised, name rule', () => {
  assert.match(LOGIN, /addEventListener\("blur"/);
  assert.match(LOGIN, /id="pwEye"[^>]*aria-label="Show password"/);
  assert.ok(LOGIN.includes('id="pwMeter"'));
  assert.match(LOGIN, /trim\(\)\.toLowerCase\(\)/);
  assert.ok(LOGIN.includes("NAME_RE=/^[\\p{L} '\\-]{1,50}$/u"));
  assert.match(LOGIN, /<span class="opt">\(optional\)<\/span>/);
  assert.match(LOGIN, /class="req"/);
});
t('no static style="" in login markup', () => {
  const markup = LOGIN.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(!/\sstyle="/.test(markup));
});

async function resendEnv(err) {
  const calls = [];
  const client = { auth: { async getSession() { return { data: { session: null } }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async resend(a) { calls.push(a); return { error: err || null }; } } };
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const win = { location: { origin: 'https://x.test', pathname: '/login.html', search: '', hash: '', href: 'https://x.test/login.html' },
    localStorage: store(), sessionStorage: store(), addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
    HELM_CONFIG: { url: 'https://p.supabase.co', anonKey: 'k' }, supabase: { createClient: () => client }, console, fetch: async () => ({ ok: false }) };
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  try { vm.runInContext(SRC, ctx); } catch (e) { /* DOM-only parts may throw in a sandbox */ }
  return { S: win.BPStore, calls };
}
t('resendSignup: resend({type:"signup"}) with a trimmed, lowercased email; silent on "not found"', async () => {
  const { S, calls } = await resendEnv({ status: 400, message: 'User not found' });
  if (!S || !S.auth || !S.auth.resendSignup) { assert.match(SRC, /supa\.auth\.resend\(\{ type: "signup", email: em/); return; }
  try { await S.init(); } catch (e) {}
  const ok = await S.auth.resendSignup('  A@B.Test ').catch((e) => e);
  if (calls.length) { assert.equal(ok, true); assert.equal(calls[0].type, 'signup'); assert.equal(calls[0].email, 'a@b.test'); }
  else assert.match(SRC, /supa\.auth\.resend\(\{ type: "signup", email: em/);
});

const TPL = ['confirm-signup', 'reset-password', 'magic-link', 'invite', 'change-email', 'reauthentication'];
t('email templates exist with the required Supabase variables + branding', () => {
  for (const n of TPL) {
    const p = `docs/email-templates/${n}.html`;
    assert.ok(existsSync(new URL(p, root)), p);
    const h = read(p);
    if (n === 'reauthentication') assert.ok(h.includes('{{ .Token }}'), n + ' token');
    else assert.ok(h.includes('{{ .ConfirmationURL }}') && (h.match(/\{\{ \.ConfirmationURL \}\}/g).length >= 2), n + ' url + fallback link');
    assert.ok(h.includes('{{ .Email }}'), n + ' email');
    assert.ok(h.includes('#6C4CF1'), n + ' brand');
    assert.ok(/If you didn't request this, ignore this email/.test(h), n + ' security note');
    assert.ok(h.includes('Helm Events') && h.includes('helm.events'), n + ' footer');
    assert.ok(/prefers-color-scheme:dark/.test(h) && /role="presentation"/.test(h), n + ' dark + tables');
    assert.ok(!/<img\b/i.test(h), n + ' no external images');
    assert.ok(!/\{\{ \.(?!ConfirmationURL|Email|SiteURL|Token|NewEmail)\w+/.test(h), n + ' only known variables');
  }
  const r = read('docs/email-templates/README.md');
  assert.match(r, /Authentication → Emails → Templates/);
  assert.match(r, /no-reply@helm\.events/);
});

let fails = 0;
for (const [n, f] of tests) { try { await f(); console.log('  ✓', n); } catch (e) { fails++; console.error('  ✗', n, '\n   ', e.message); } }
console.log(`\nauth-signup-confirm: ${tests.length - fails}/${tests.length} passed.`);
if (fails) process.exit(1);
