#!/usr/bin/env node
/* ============================================================================
 * contract-coverage.mjs — canonical DB feature-completeness / drift guard.
 * Extracts every RPC (rpc("name")) and table (.from("name")) the current app
 * source depends on, and asserts each exists in the connected canonical DB
 * (base-v1 + all forward migrations). Fails if the app needs an object the
 * canonical path does not create — prevents the DB contract from drifting away
 * from the current application. Self-skips without a reachable PG.
 * ========================================================================== */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function dbOk(){ try { execFileSync('psql',['-tAc','select 1'],{stdio:['ignore','ignore','ignore']}); return true;} catch { return false; } }
if (!dbOk()) { console.log('contract-coverage: SKIP (no local PG).'); process.exit(0); }

// gather app source
const srcFiles = [];
for (const d of ['public']) for (const f of readdirSync(join(ROOT,d))) if (/\.(js|html)$/.test(f)) srcFiles.push(join(ROOT,d,f));
const src = srcFiles.map(f=>readFileSync(f,'utf8')).join('\n');
const rpcs = [...new Set([...src.matchAll(/rpc\("([a-zA-Z0-9_]+)"/g)].map(m=>m[1]))].sort();
const tables = [...new Set([...src.matchAll(/\.from\("([a-zA-Z0-9_]+)"/g)].map(m=>m[1]))].sort();

const q = (sql) => execFileSync('psql',['-X','-q','-t','-A','-c',sql],{encoding:'utf8'}).trim();
const haveFns = new Set(q("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'").split('\n').filter(Boolean));
const haveTbls = new Set(q("select table_name from information_schema.tables where table_schema='public'").split('\n').filter(Boolean));

const missRpc = rpcs.filter(r=>!haveFns.has(r));
const missTbl = tables.filter(t=>!haveTbls.has(t));
console.log(`contract-coverage: RPCs expected=${rpcs.length} present=${rpcs.length-missRpc.length} ; tables expected=${tables.length} present=${tables.length-missTbl.length}`);
if (missRpc.length) console.error('  MISSING RPCs: '+missRpc.join(', '));
if (missTbl.length) console.error('  MISSING TABLES: '+missTbl.join(', '));
if (missRpc.length || missTbl.length) { console.error('CONTRACT-COVERAGE: FAIL'); process.exit(1); }
console.log('CONTRACT-COVERAGE: 100% (app DB contract fully represented in canonical path)');
