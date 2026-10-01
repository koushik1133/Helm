// _shared/cors.ts — CORS allowlist + escHtml. Pure, runtime-verified.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv } from "./harness.ts";
import { isAllowedOrigin, corsFor, escHtml } from "../../supabase/functions/_shared/cors.ts";

function reqWithOrigin(origin: string | null): Request {
  const h: Record<string, string> = {};
  if (origin !== null) h["origin"] = origin;
  return new Request("https://fn.local/", { method: "POST", headers: h });
}

Deno.test("CORS: allowed production origin is echoed", () => {
  const restore = setEnv({});
  try {
    assert(isAllowedOrigin("https://helm.events"));
    const h = corsFor(reqWithOrigin("https://helm.events"));
    assertEquals(h["Access-Control-Allow-Origin"], "https://helm.events");
  } finally { restore(); }
});

Deno.test("CORS: allowed vercel preview origin (regex) is echoed", () => {
  const restore = setEnv({});
  try {
    const o = "https://helm-v01-abc123def-vk-hub.vercel.app";
    assert(isAllowedOrigin(o));
    assertEquals(corsFor(reqWithOrigin(o))["Access-Control-Allow-Origin"], o);
  } finally { restore(); }
});

Deno.test("CORS: random/evil origin is BLOCKED (no ACAO header)", () => {
  const restore = setEnv({});
  try {
    assert(!isAllowedOrigin("https://evil.example"));
    const h = corsFor(reqWithOrigin("https://evil.example"));
    assertEquals(h["Access-Control-Allow-Origin"], undefined);
  } finally { restore(); }
});

Deno.test("CORS: a preview-lookalike on another host is BLOCKED", () => {
  const restore = setEnv({});
  try {
    assert(!isAllowedOrigin("https://helm-v01-abc-vk-hub.vercel.app.evil.com"));
    assert(!isAllowedOrigin("https://helm-v01-abc-attacker.vercel.app"));
  } finally { restore(); }
});

Deno.test("CORS: Vary: Origin always present; no Allow-Credentials; methods POST,OPTIONS", () => {
  const restore = setEnv({});
  try {
    const h = corsFor(reqWithOrigin("https://evil.example")); // even when blocked
    assertEquals(h["Vary"], "Origin");
    assertEquals(h["Access-Control-Allow-Credentials"], undefined);
    assertStringIncludes(h["Access-Control-Allow-Methods"], "POST");
    assertStringIncludes(h["Access-Control-Allow-Methods"], "OPTIONS");
  } finally { restore(); }
});

Deno.test("CORS: localhost blocked unless ALLOW_LOCALHOST=1", () => {
  let restore = setEnv({});
  try { assert(!isAllowedOrigin("http://localhost:3000")); } finally { restore(); }
  restore = setEnv({ ALLOW_LOCALHOST: "1" });
  try {
    assert(isAllowedOrigin("http://localhost:3000"));
    assert(isAllowedOrigin("http://127.0.0.1:5173"));
  } finally { restore(); }
});

Deno.test("CORS: ALLOWED_ORIGINS env REPLACES default list (preview regex kept)", () => {
  const restore = setEnv({ ALLOWED_ORIGINS: "https://a.example,https://b.example/" });
  try {
    assert(isAllowedOrigin("https://a.example"));
    assert(isAllowedOrigin("https://b.example")); // trailing slash trimmed
    assert(!isAllowedOrigin("https://helm.events")); // default no longer present
    assert(isAllowedOrigin("https://helm-v01-xyz-vk-hub.vercel.app")); // preview still allowed
  } finally { restore(); }
});

Deno.test("CORS: null origin is not allowed", () => {
  const restore = setEnv({});
  try { assert(!isAllowedOrigin(null)); } finally { restore(); }
});

Deno.test("escHtml: escapes HTML/quote metacharacters (XSS in email bodies)", () => {
  assertEquals(escHtml(`<script>&"'`), "&lt;script&gt;&amp;&quot;&#39;");
  assertEquals(escHtml(null), "");
  assertEquals(escHtml(undefined), "");
});
