#!/usr/bin/env node
/* builder-pricing-guards.test.mjs — static guards for builder.js pricing safety. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/builder.js'), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
ok(/HelmRepriceGuard\.platesFor\(q\.client, currentPricing\)/.test(js) && /currentPricing\.guests!=null \? \+currentPricing\.guests/.test(js), 'R112: the quote plates (Confirm-modal pricing.guests) win over the client head count');
ok(/BPStore\.quotes\.get\(currentQuoteId\)/.test(js) && /\{ pricing \}, expectedUpdatedAt\)/.test(js), 'sync refetches and passes expectedUpdatedAt');
ok(/HelmSizing\.handOther\(currentPricing/.test(js) && /other: hand!=null \? hand : auto/.test(js), 'hand-edited other is preserved');
ok(/Client approval will go stale/.test(js) && /currentQuoteGuard\.closed/.test(js), 'stale-approval confirm + closed block');
// r19 (0211): "No package…" really un-applies the package on the server (clear_menu_template) - never a silent keep
ok(/if\(!tid\)\{[\s\S]{0,400}await BPStore\.menuTemplates\.clear\(currentQuoteId\);/.test(js) && /PRICING\.menuPlatePrice = PRICING\.platePrice!=null/.test(js), '"No package" un-applies the package (server) and prices at the default plate price');
ok(/price left unchanged/.test(js) && /PRICING\.menuPlatePrice=prev\.plate/.test(js), 'failed package apply reverts pricing');
ok(/editing is locked so nothing gets overwritten/.test(js), 'load-failure lock retained');
console.log('builder-pricing-guards: ' + n + ' checks passed');
