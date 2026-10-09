// Chat + admin fixes (0074): A4 bell read keys carry the newest message time (new messages
// after "mark read" count again), A12 chat prefs synced per user (server, with a one-time
// upload of the old browser sets; the bell respects server mutes), A6 photo / voice forwarding
// copies the object into the target chat, L7 profiles role reads use maybeSingle (no 406).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
const mig = readFileSync(new URL('../supabase/migrations/0074_chat_admin_fixes.sql', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const labelsSrc = api.slice(api.indexOf('const BELL_TYPE_LABELS'), api.indexOf('};', api.indexOf('const BELL_TYPE_LABELS')) + 2);
const ctx = {}; vm.runInNewContext(labelsSrc + '\n' + ['notifLink', 'notifHref', 'bellTypeOf', 'bellLabel', 'bellChatKey', 'bellPanelView'].map((f) => fnSrc(api, f)).join('\n') + '\nglobalThis.view=bellPanelView; globalThis.key=bellChatKey;', ctx);

t('A4: a chat marked read counts again once a newer message arrives', () => {
  const old = { __chat: true, conversation_id: 'g1', kind: 'group', title: 'Crew', created_at: '2026-10-07T10:00:00Z', count: 1 };
  const read = [ctx.key(old)];
  assert.equal(ctx.view([old], { read }).unread, 0);
  const newer = Object.assign({}, old, { created_at: '2026-10-07T11:00:00Z', count: 2 });
  assert.equal(ctx.view([newer], { read }).unread, 2);
  assert.doesNotMatch(api, /"c:" \+ \(n\.conversation_id \|\| i\)/);
  assert.doesNotMatch(api, /readKeys\.indexOf\("c:" \+ c\.conversation_id\)/);
  assert.match(api, /readKeys\.indexOf\(bellChatKey\(c\)\)/);
});

t('A12: chat prefs live on the server; one-time upload; bell syncs mutes', () => {
  assert.match(api, /supa\.from\("chat_prefs"\)\.select\("conversation_id,pinned,muted,favourite"\)/);
  assert.match(api, /rpc\("chat_set_pref"/);
  assert.match(api, /"wa_prefs_up:" \+ uidNow/);
  assert.match(api, /prefs: chatPrefs,/);
  assert.match(api, /chat\.prefs\.sync\(\)/);
  assert.match(chat, /BPStore\.chat\.prefs\.sync\(true\)/);
  ['pinned', 'favourite', 'muted'].forEach((f) => assert.match(chat, new RegExp(`savePref\\(c\\.id,"${f}",on\\)`)));
  assert.match(mig, /create policy chat_prefs_own_read on public\.chat_prefs for select to authenticated\s+using \(user_id = auth\.uid\(\)\)/);
  assert.match(mig, /revoke insert, update, delete on public\.chat_prefs from authenticated/);
});

t('A6: photos / voice notes forward by copying into the target conversation', () => {
  assert.doesNotMatch(chat, /can't be forwarded/);
  assert.match(chat, /BPStore\.chat\.forwardMedia\(mp,to\)/);
  const f = api.slice(api.indexOf('async forwardMedia('), api.indexOf('async uploadMedia('));
  assert.match(f, /CHAT_MEDIA_KEY\.exec/);
  assert.match(f, /supa\.storage\.from\("chat-media"\)\.copy\(fromPath, path\)/);
  assert.match(f, /orgId \+ "\/" \+ toConv \+ "\/" \+ name/);
  assert.match(mig, /this attachment belongs to another conversation/);
});

t('L7: role reads use maybeSingle and keep the 0-row behaviour', () => {
  assert.doesNotMatch(api, /from\("profiles"\)\.select\("role"\)\.eq\("id", [a-zA-Z.]+\)\.single\(\)/);
  assert.match(api, /if \(!data\) throw new Error\("no profile row"\)/);
  assert.match(api, /!p\.data \|\| !currentUser/);
});

console.log(`chat-admin-fixes-ui: ${n} passed`);
