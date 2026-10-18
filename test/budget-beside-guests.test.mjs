import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const flow = readFileSync(new URL('../public/flow.html', import.meta.url), 'utf8');
const leads = readFileSync(new URL('../public/leads.html', import.meta.url), 'utf8');
// flow step 1: Budget is a half-width field directly after Guests
assert.match(flow, /<div class="fld"><label for="c_guests">[^\n]*\n\s*<div class="fld"><label for="d_bmax">Budget/);
assert.ok(!/fld full"><label for="d_bmax"/.test(flow), 'budget must not span full row');
assert.ok(flow.includes('(the budget is above)') && !flow.includes('budget range is above'));
// mobile stacks to one column
assert.match(flow, /@media\(max-width:620px\)\{\.grid\{grid-template-columns:1fr\}\}/);
// leads form: Guests then Budget
assert.ok(leads.indexOf('for="f_guests"') < leads.indexOf('for="f_budget"'));
console.log('budget-beside-guests: ok');
