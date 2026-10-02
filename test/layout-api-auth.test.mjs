// Regression: /api/layouts must be loopback-only unless a bearer token is configured.
// Closes the audit P2 "/api/layouts unauthenticated" finding. The live app does not use
// this endpoint (layouts persist via Supabase RLS + localStorage); this guards an
// exposed server.js from being an open read/write/delete relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LAYOUTS_API_TOKEN = 'secret-token-123';   // set BEFORE requiring server.js
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { layoutApiAllowed } = require('../server.js');

const req = (remoteAddress, authorization) => ({ socket: { remoteAddress }, headers: authorization ? { authorization } : {} });

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
