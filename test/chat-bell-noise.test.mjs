// Bell <-> chat polling hygiene (prod log finding, Oct 2026): before the chat SQL was
// applied, every page's bell re-requested chat tables/RPCs every poll (404 storm), and
// chat_ensure_broadcast ran on EVERY poll. Pin: missing backend latches off; broadcast
// is ensured once per page.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
t('notifications() short-circuits once the chat backend is known missing', () => {
  assert.match(api, /if \(!me \|\| chatBackendMissing\) return \[\];/);
  assert.match(api, /isMissingTable\(e\)\)[\s\S]{0,80}chatBackendMissing = true;/);
});
t('chat_ensure_broadcast runs once per page, not per poll', () => {
  assert.match(api, /if \(!chatBcastEnsured\) \{ try \{ await rpc\("chat_ensure_broadcast"\); chatBcastEnsured = true;/);
  assert.equal((api.match(/rpc\("chat_ensure_broadcast"\)/g) || []).length, 1);
});
t('signed-out pages skip the members-only get_pricing_config RPC', () => {
  assert.match(api, /if \(BPStore\.mode\(\) === "supabase" && !BPStore\.auth\.user\(\)\) return null;\s*return BPStore\.config\.getPricing\(\);/);
});
console.log(`\nchat-bell-noise: ${n} passed`);
