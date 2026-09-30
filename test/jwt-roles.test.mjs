// Negative + positive tests for scripts/check-jwt-roles.mjs.
// The fake tokens are CONSTRUCTED AT RUNTIME (nothing key-shaped is committed):
// a service_role JWT must be rejected, an anon JWT accepted, and the report must
// never echo the token itself.
import assert from 'node:assert/strict';
import { scanText, problemWith } from '../scripts/check-jwt-roles.mjs';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (payload) =>
  [b64u({ alg: 'HS256', typ: 'JWT' }), b64u(payload), Buffer.from('not-a-real-signature-' + Math.random()).toString('base64url')].join('.');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const service = fakeJwt({ iss: 'supabase', ref: 'testprojectref', role: 'service' + '_role', iat: 1, exp: 2 });
const anon = fakeJwt({ iss: 'supabase', ref: 'testprojectref', role: 'anon', iat: 1, exp: 2 });
const authed = fakeJwt({ sub: 'u1', role: 'authenticated' });
const noRole = fakeJwt({ sub: 'u1' });
const sneaky = fakeJwt({ role: 'anon', note: 'service' + '_role' });

t('service_role JWT fails', () => {
  const f = scanText(`const k = "${service}";\n`, 'fake.js');
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'fake.js');
  assert.equal(f[0].line, 1);
  assert.match(f[0].reason, /service_role/);
});
t('report never contains the token', () => {
  const f = scanText(`x\n${service}\n`, 'a.txt');
  assert.equal(f[0].line, 2);
  assert.ok(!JSON.stringify(f).includes(service.split('.')[1]));
});
t('anon JWT passes', () => assert.deepEqual(scanText(`anonKey: '${anon}'`), []));
t('authenticated (user) JWT fails', () => assert.match(problemWith(authed), /role=authenticated/));
t('JWT with no role fails', () => assert.match(problemWith(noRole), /role=\(none\)/));
t('anon role with a service_role claim still fails', () => assert.match(problemWith(sneaky), /service_role/));
t('non-JSON JWT-shaped text is ignored', () => assert.deepEqual(scanText('eyJhbGciOiJIUzI1.eyJub3RqcA.abc'), []));

console.log(`\njwt-roles: ${n} test(s) passed.`);
