#!/usr/bin/env node
/* =============================================================================
   check-local-api.mjs — proves local dev is preserved after Option 1.
   Starts server.js on a throwaway port, asserts GET /api/health -> 200 with the
   server's health payload, then shuts it down. GET-only, no data mutation.
   ============================================================================= */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.CHECK_PORT || "4199";
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.error("  ✗ " + m); failures++; };

console.log(`Local server.js dev-preservation check (port ${PORT}):`);
const srv = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT }, stdio: ["ignore", "ignore", "inherit"],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  // wait for the server to come up (poll up to ~5s)
  let up = false;
  for (let i = 0; i < 25 && !up; i++) {
    await sleep(200);
    try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.ok) up = true; } catch {}
  }
  if (!up) { bad("server.js did not start / /api/health not reachable"); }
  else {
    const r = await fetch(`http://localhost:${PORT}/api/health`);
    const j = await r.json().catch(() => ({}));
    r.status === 200 ? ok("GET /api/health -> 200 (local dev preserved)") : bad(`GET /api/health -> ${r.status} (expected 200)`);
    j && j.ok === true ? ok("health payload { ok:true } present") : bad("health payload missing ok:true");
  }
} catch (e) {
  bad(`error: ${e && e.message}`);
} finally {
  srv.kill("SIGTERM");
}

console.log(failures ? `\nFAILED (${failures})` : "\nLocal dev check passed.");
process.exit(failures ? 1 : 0);
