#!/usr/bin/env node
/* inv-fixes-ui.test.mjs - source-level guards for the 0073 batch:
 *  D4  lists are read in full (paged .range() walk, capped + flagged), not the first 1000 rows
 *  #4  check-outs are cancelled through cancel_checkout, never deleted; UI shows Cancel + toggle
 *  #12 23505 duplicate names become a friendly "already exists" message; bulk starter import skips per row
 *  L2  the number hardener tells people why a minus sign disappeared
 * Pure Node, no deps. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'public', 'store-api.js'), 'utf8');
const INV = readFileSync(join(ROOT, 'public', 'inventory.html'), 'utf8');
const MIG = readFileSync(join(ROOT, 'supabase', 'migrations', '0073_inventory_cancel_and_unique_names.sql'), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };
const body = (start, len = 900) => { const i = SRC.indexOf(start); assert.ok(i !== -1, 'missing: ' + start); return SRC.slice(i, i + len); };

t('sbAll walks .range() pages with a cap and flags truncation', () => {
  const b = body('async function sbAll(build, max)');
  assert.ok(/\.range\(off, off \+ want - 1\)/.test(b));
  assert.ok(/SB_ALL_MAX = 20000/.test(SRC));
  assert.ok(/out\.truncated = true/.test(b) && /console\.warn/.test(b));
});

// behavioral: run the real sbAll body against a fake PostgREST that caps responses at 1000 rows
{
  const start = SRC.indexOf('const SB_ALL_CHUNK'); const end = SRC.indexOf('  // D12:', start);
  const make = new Function(SRC.slice(start, end) + '; return sbAll;');
  const sbAll = make();
  const fake = (n) => () => ({ range: async (a, b) => ({ data: Array.from({ length: Math.max(0, Math.min(b, n - 1, a + 999) - a + 1) }, (_, i) => a + i), error: null }) });
  const r1 = await sbAll(fake(2500)); assert.equal(r1.length, 2500); assert.equal(r1.truncated, undefined);
  const r2 = await sbAll(fake(1000)); assert.equal(r2.length, 1000);
  const warn = console.warn; console.warn = () => {}; const r3 = await sbAll(fake(50000)); console.warn = warn;
  assert.equal(r3.length, 20000); assert.equal(r3.truncated, true);
  passed++; console.log('  \u2713 sbAll returns every row past 1000 and flags the 20k cap (behavioral)');
}

t('full lists use sbAll (quotes, leads, contacts, vendors, staff, inventory, checkouts, reservations, dishes)', () => {
  for (const tbl of ['quotes', 'leads', 'vendors', 'crew_members', 'inventory_items', 'inventory_checkouts', 'inventory_reservations', 'dish_catalog', 'lead_archive']) {
    assert.ok(new RegExp('sbAll\\(\\(\\) => (?:\\{ let q = )?supa\\.from\\("' + tbl + '"\\)').test(SRC), 'sbAll over ' + tbl);
  }
  assert.ok(/sbAll\(\(\) => supa\.from\("leads"\)\.select\("id,name,phone,email"\)/.test(SRC), 'lead dedupe contacts paged');
});

t('check-outs: cancel via RPC, no hard delete left in the data layer', () => {
  assert.ok(/supa\.rpc\("cancel_checkout"/.test(SRC));
  assert.ok(!/from\("inventory_checkouts"\)\.delete\(/.test(SRC), 'no .delete() on inventory_checkouts');
});

t('inventory.html: Cancel button + confirm, cancelled rows behind a toggle, not counted as loss', () => {
  assert.ok(/data-cxl=/.test(INV) && /BPStore\.inventory\.checkouts\.cancel\(/.test(INV));
  assert.ok(/Cancel check-out\?/.test(INV));
  assert.ok(/id="showCancelled"/.test(INV) && /showCancelled && cancelled\.length/.test(INV));
  assert.ok(/c\.status!=="cancelled"/.test(INV), 'loss report excludes cancelled');
});

t('duplicate names: friendly 23505 on add / rename / reactivate; starter import skips per row', () => {
  const d = body('function dupError(e, what, name)', 500);
  assert.ok(/e\.code !== "23505"/.test(d) && /already exists/.test(d));
  for (const w of ['"partner", name', '"partner", v && v.name', '"partner", patch && patch.name', '"item", it.name', '"item", patch.name', '"dish", name'])
    assert.ok(SRC.includes('dupError(error, ' + w + ')'), 'dupError ' + w);
  assert.ok(/skipDuplicates/.test(SRC) && /made\.skipped/.test(SRC));
  assert.ok(/addItems\(toAdd,\{skipDuplicates:true\}\)/.test(INV));
});

t('L2: hardener shows an inline hint when it drops a minus sign', () => {
  assert.ok(/Negative numbers aren\\u2019t allowed here/.test(SRC));
  assert.ok(/e\.key === "-" && !allowNeg\) \{ e\.preventDefault\(\); negHint\(el\)/.test(SRC));
  assert.ok(/!allowNeg && v\.indexOf\("-"\) !== -1\) negHint\(el\)/.test(SRC));
  assert.ok(/aria-live/.test(body('function negHint(el)', 600)));
});

t('0073: cancelled excluded from sums, delete policy dropped, guarded unique indexes', () => {
  assert.ok(/status in \('out','partial'\)/.test(MIG));
  assert.ok(/drop policy if exists "ra del" on public\.inventory_checkouts/.test(MIG));
  assert.ok(/revoke delete on public\.inventory_checkouts from anon, authenticated/.test(MIG));
  assert.ok((MIG.match(/raise notice '0073: .* SKIPPED/g) || []).length === 3);
  assert.ok(!/delete from|truncate/i.test(MIG.replace(/^--.*$/gm, '')), 'no data deletion');
});

console.log(`\ninv-fixes-ui: ${passed} assertion(s) passed.`);
