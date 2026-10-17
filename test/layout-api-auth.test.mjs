// Regression: /api/layouts must be loopback-only unless a bearer token is configured.
// Closes the audit P2 "/api/layouts unauthenticated" finding. The live app does not use
// this endpoint (layouts persist via Supabase RLS + localStorage); this guards an
// exposed server.js from being an open read/write/delete relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LAYOUTS_API_TOKEN = 'secret-token-123';   // set BEFORE requiring server.js
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { layoutApiAllowed, isLocalHostHeader, isJsonContentType } = require('../server.js');
const fs = await import('node:fs');

const req = (remoteAddress, authorization, extra = {}) => ({ socket: { remoteAddress }, headers: { host: 'localhost:4173', ...(authorization ? { authorization } : {}), ...extra } });

test('loopback IPv4 is allowed without a token', () => {
  assert.equal(layoutApiAllowed(req('127.0.0.1')), true);
});
test('loopback IPv6 (::1 and mapped) is allowed', () => {
  assert.equal(layoutApiAllowed(req('::1')), true);
  assert.equal(layoutApiAllowed(req('::ffff:127.0.0.1')), true);
});
test('non-local client with NO Authorization is denied', () => {
  assert.equal(layoutApiAllowed(req('203.0.113.9')), false);
});
test('non-local client with WRONG bearer is denied', () => {
  assert.equal(layoutApiAllowed(req('203.0.113.9', 'Bearer wrong')), false);
});
test('non-local client with CORRECT bearer is allowed', () => {
  assert.equal(layoutApiAllowed(req('203.0.113.9', 'Bearer secret-token-123')), true);
});

// audit run-3 local/server.js/layout-api-dns-rebinding-host-unchecked
test('loopback socket with a FOREIGN Host (DNS rebinding) is denied', () => {
  assert.equal(layoutApiAllowed(req('127.0.0.1', null, { host: 'evil.example:4173' })), false);
  assert.equal(layoutApiAllowed(req('127.0.0.1', null, { host: '' })), false);
});
test('loopback socket with a cross-site Origin is denied', () => {
  assert.equal(layoutApiAllowed(req('127.0.0.1', null, { origin: 'https://evil.example' })), false);
  assert.equal(layoutApiAllowed(req('127.0.0.1', null, { origin: 'null' })), false);
});
test('loopback socket with a local Origin is allowed', () => {
  assert.equal(layoutApiAllowed(req('127.0.0.1', null, { origin: 'http://localhost:4173' })), true);
  assert.equal(layoutApiAllowed(req('::1', null, { host: '[::1]:4173', origin: 'http://[::1]:4173' })), true);
  assert.equal(layoutApiAllowed(req('127.0.0.1', null, { host: '127.0.0.1' })), true);
});
test('token caller with a cross-site Origin is denied', () => {
  assert.equal(layoutApiAllowed(req('203.0.113.9', 'Bearer secret-token-123', { host: 'dev.lan:4173', origin: 'https://evil.example' })), false);
  assert.equal(layoutApiAllowed(req('203.0.113.9', 'Bearer secret-token-123', { host: 'dev.lan:4173', origin: 'http://dev.lan:4173' })), true);
});
test('Host matcher is strict', () => {
  for (const h of ['localhost', 'localhost:1', '127.0.0.1:65535', '[::1]', 'LOCALHOST:80']) assert.equal(isLocalHostHeader(h), true, h);
  for (const h of ['localhost.evil.com', 'evil.localhost', '127.0.0.2', '127.0.0.1.nip.io', 'localhost:abc', '']) assert.equal(isLocalHostHeader(h), false, h);
});
test('writes require application/json (text/plain CSRF refused)', () => {
  assert.equal(isJsonContentType('application/json'), true);
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  for (const c of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '', 'application/jsonp']) assert.equal(isJsonContentType(c), false, c);
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /isJsonContentType\(req\.headers && req\.headers\['content-type'\]\)[\s\S]{0,200}415/);
});
// audit run-3 infra/server.js/listen-all-interfaces
test('server.js binds to loopback by default', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.HOST \|\| '127\.0\.0\.1'/);
  assert.match(src, /server\.listen\(PORT, HOST,/);
});
