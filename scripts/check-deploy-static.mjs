#!/usr/bin/env node
/* =============================================================================
   check-deploy-static.mjs — deployment-containment regression check (Option 1)
   -----------------------------------------------------------------------------
   Purpose: prove production is a STATIC deploy of public/ and that server.js is
   NOT executed as a function in production, while local dev via server.js still
   works.

   Two layers:
     1) Static config assertions on vercel.json (always run, no network).
     2) HTTP assertions against a deployed/preview URL — ONLY when a URL is given
        via env DEPLOY_CHECK_URL (or --url=). Never deploys. GET-only.

   Local dev is checked separately by `npm run check:localapi` (starts server.js,
   asserts GET /api/health -> 200, stops it).
   Exit non-zero on any failure so CI can gate on it.
   ============================================================================= */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.error("  ✗ " + m); failures++; };

/* ---- 1. static config assertions ---------------------------------------- */
console.log("vercel.json static-deploy assertions:");
const cfg = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));

cfg.outputDirectory === "public" ? ok('outputDirectory = "public"') : bad(`outputDirectory must be "public" (got ${JSON.stringify(cfg.outputDirectory)})`);
cfg.framework === null ? ok("framework = null (no framework build)") : bad(`framework must be null (got ${JSON.stringify(cfg.framework)})`);
!("builds" in cfg) ? ok("no legacy 'builds' key") : bad("'builds' present — may build a function");
!("functions" in cfg) ? ok("no 'functions' key") : bad("'functions' present — declares a serverless function");

// routing the static app must keep working without server.js
const cleanUrls = cfg.cleanUrls === true;
const sources = new Set((cfg.rewrites || []).map((r) => r.source));
// The invite short-link needs an explicit rewrite (no matching file).
sources.has("/i/:slug*") ? ok("rewrite present: /i/:slug*") : bad("missing required rewrite: /i/:slug*");
// Root: index.html is the landing (directory index) → "/" serves it natively.
existsSync(join(ROOT, "public", "index.html")) || sources.has("/")
  ? ok("root served (public/index.html present or / rewrite)")
  : bad("no root: add public/index.html or a / rewrite");
// Page routes: served extensionlessly by cleanUrls (from <name>.html), or an
// explicit per-page rewrite. Either satisfies clean, server-less routing.
cleanUrls ? ok("cleanUrls enabled (extensionless page routes)")
          : ok("cleanUrls off (page routes via explicit rewrites)");
for (const s of ["/login", "/dashboard", "/privacy", "/terms", "/about", "/services"]) {
  (cleanUrls || sources.has(s)) ? ok(`route ok: ${s}`) : bad(`missing route: ${s} (add a rewrite or enable cleanUrls)`);
}

/* ---- 2. optional HTTP assertions against a deployed/preview URL ---------- */
const arg = process.argv.find((a) => a.startsWith("--url="));
const base = (arg ? arg.slice(6) : process.env.DEPLOY_CHECK_URL || "").replace(/\/$/, "");

if (!base) {
  console.log("\nHTTP checks skipped (no DEPLOY_CHECK_URL / --url=<preview>). Static config checks only.");
} else {
  console.log(`\nHTTP checks against ${base} (GET only):`);
  const get = async (path) => {
    const res = await fetch(base + path, { method: "GET", redirect: "manual" });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  };
  const leak = (b) => /\/var\/task|ENOENT|at\s+\w+\s+\(|\.js:\d+:\d+|filesystem/i.test(b);

  try {
    for (const p of ["/api/health", "/api/layouts"]) {
      const r = await get(p);
      r.status === 404 ? ok(`${p} -> 404 (server.js not executing)`) : bad(`${p} -> ${r.status} (expected 404; server.js may still run)`);
      leak(r.body) ? bad(`${p} response leaks a path/stack/internal error`) : ok(`${p} response has no path/stack leak`);
    }
    for (const p of ["/", "/login", "/dashboard"]) {
      const r = await get(p);
      (r.status === 200 || (r.status >= 300 && r.status < 400)) ? ok(`${p} -> ${r.status} (app entry loads)`) : bad(`${p} -> ${r.status} (expected 200/redirect)`);
    }
  } catch (e) {
    bad(`HTTP check error: ${e && e.message}`);
  }
}

console.log(failures ? `\nFAILED (${failures})` : "\nAll deploy-static checks passed.");
process.exit(failures ? 1 : 0);
