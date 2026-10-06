// Client-link expiry UI (0022): guests see "ended", crew phones drop cached tasks,
// staff see when an invitation stops working.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
t('invite page shows a friendly "ended" state for an expired invitation', () => {
  const s = r('public/invite.html');
  assert.match(s, /id="ended"[\s\S]{0,80}This invitation has ended/);
  assert.match(s, /\/has ended\|expired\/i\.test\(\(e&&e\.message\)\|\|""\)\)\{ \$\("#ended"\)\.hidden=false; return; \}/);
});
t('crew page never keeps showing cached tasks once the link expired/revoked', () => {
  const s = r('public/work.html');
  assert.match(s, /\/expired\|revoked\/i\.test[\s\S]{0,120}sessionStorage\.removeItem\(CK\)[\s\S]{0,80}data=null; \$\("#content"\)\.hidden=true;/);
});
t('invite studio shows until when guests can open the link', () => {
  assert.match(r('public/invite-studio.html'), /BPStore\.sites\.liveUntil\(site\.id\)/);
  assert.match(r('public/store-api.js'), /rpc\("event_site_live_until", \{ p_site_id: siteId \}\)/);
});
t('0022 wraps (never rewrites) the public RPC bodies and keeps originals private', () => {
  const m = r('supabase/migrations/0022_client_link_windows.sql');
  assert.match(m, /alter function public\.public_event_site\(text\) rename to public_event_site__base/);
  assert.match(m, /alter function public\.public_get_proposal\(uuid\) rename to public_get_proposal__base/);
  assert.match(m, /revoke all on function public\.public_event_site__base\(text\) from public, anon, authenticated/);
  assert.match(m, /revoke all on function public\.public_get_proposal__base\(uuid\) from public, anon, authenticated/);
});
console.log(`\nlink-windows-ui: ${n} passed`);
