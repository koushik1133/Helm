// R104: self-XSS console warning on every page + no secret/PII console logging.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const PUB = path.resolve(import.meta.dirname, '..', 'public');
const pages = fs.readdirSync(PUB).filter(f => f.endsWith('.html'));
const missing = pages.filter(f => !/<script src="\/console-warning\.js\?v=\d+"><\/script>/.test(fs.readFileSync(path.join(PUB, f), 'utf8')));
assert.deepEqual(missing, [], 'pages missing console-warning.js: ' + missing.join(', '));
const w = fs.readFileSync(path.join(PUB, 'console-warning.js'), 'utf8');
assert.match(w, /Stop!/);
assert.match(w, /__helmConsoleWarned/, 'warning must print once per page load');
assert.doesNotMatch(w, /debugger|devtools.*open|contextmenu|innerHTML/i, 'no devtools detection/debugger traps/right-click blocking');
// No first-party console call may print tokens, passwords, emails, phones or sessions.
const bad = [];
for (const f of fs.readdirSync(PUB).filter(f => f.endsWith('.js'))) {
  fs.readFileSync(path.join(PUB, f), 'utf8').split('\n').forEach((l, i) => {
    if (/console\.(log|info|debug|warn|error)\([^;]*\b(access_token|refresh_token|password|session\b|jwt|apikey|\.email\b|\.phone\b)/i.test(l)) bad.push(f + ':' + (i + 1));
  });
}
assert.deepEqual(bad, [], 'console logging of secrets/PII: ' + bad.join(', '));
console.log('r104-devtools-security: ok (' + pages.length + ' pages)');
