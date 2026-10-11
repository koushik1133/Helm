// Design studio is hidden for now (owner 2026-10-11): no nav tile, no dashboard link, no builder chip.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const api = readFileSync('public/store-api.js', 'utf8'), dash = readFileSync('public/dashboard.html', 'utf8'), b = readFileSync('public/builder.js', 'utf8');
assert.match(api, /key: "design",\s+label: "Design studio",\s+icon: "🎨", page: null/, 'no nav tile');
assert.ok(!/"link","design\.html"/.test(dash), 'no dashboard card links to design.html');
assert.match(b, /chip\.hidden=true; return;\s+\/\/ Design studio hidden/, 'builder chip hidden');
console.log('design-hidden: ok');
