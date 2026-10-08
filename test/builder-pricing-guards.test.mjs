#!/usr/bin/env node
/* builder-pricing-guards.test.mjs — static guards for builder.js pricing safety. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/builder.js'), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
ok(/else if\(currentPricing\.guests!=null\) PRICING\.guests/.test(js), 'guests fall back to Confirm-modal pricing.guests');
ok(/BPStore\.quotes\.get\(currentQuoteId\)/.test(js) && /\{ pricing \}, expectedUpdatedAt\)/.test(js), 'sync refetches and passes expectedUpdatedAt');
ok(/hand \? currentPricing\.other : auto/.test(js), 'hand-edited other is preserved');
ok(/Client approval will go stale/.test(js) && /currentQuoteGuard\.closed/.test(js), 'stale-approval confirm + closed block');
ok(/if\(!tid && prev\.id\)/.test(js), '"No package" does not silently keep a repriced package');
ok(/price left unchanged/.test(js) && /PRICING\.menuPlatePrice=prev\.plate/.test(js), 'failed package apply reverts pricing');
ok(/editing is locked so nothing gets overwritten/.test(js), 'load-failure lock retained');
console.log('builder-pricing-guards: ' + n + ' checks passed');
