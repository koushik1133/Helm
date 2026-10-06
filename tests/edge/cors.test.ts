// _shared/cors.ts — CORS allowlist + escHtml. Pure, runtime-verified.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv } from "./harness.ts";
import { isAllowedOrigin, corsFor, escHtml, normPhone } from "../../supabase/functions/_shared/cors.ts";

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

Deno.test("CORS: attacker-registrable Vercel names are NOT trusted (no preview regex)", () => {
  const restore = setEnv({});
  try {
    // anyone can create a Vercel project literally named like this
    assert(!isAllowedOrigin("https://helm-v01-abc123def-vk-hub.vercel.app"));
    assert(!isAllowedOrigin("https://helm-v01-x-vk-hub.vercel.app"));
    assertEquals(corsFor(reqWithOrigin("https://helm-v01-x-vk-hub.vercel.app"))["Access-Control-Allow-Origin"], undefined);
  } finally { restore(); }
});

Deno.test("CORS: one preview can be allowed EXACTLY via EXTRA_ALLOWED_ORIGINS", () => {
  const restore = setEnv({ EXTRA_ALLOWED_ORIGINS: "https://helm-v01-abc123def-vk-hub.vercel.app, not a url" });
  try {
    assert(isAllowedOrigin("https://helm-v01-abc123def-vk-hub.vercel.app"));
    assert(isAllowedOrigin("https://helm.events"));                       // defaults kept
    assert(!isAllowedOrigin("https://helm-v01-zzz-vk-hub.vercel.app"));     // no pattern
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

Deno.test("CORS: ALLOWED_ORIGINS env REPLACES default list", () => {
  const restore = setEnv({ ALLOWED_ORIGINS: "https://a.example,https://b.example/" });
  try {
    assert(isAllowedOrigin("https://a.example"));
    assert(isAllowedOrigin("https://b.example")); // trailing slash trimmed
    assert(!isAllowedOrigin("https://helm.events")); // default no longer present
    assert(!isAllowedOrigin("https://helm-v01-xyz-vk-hub.vercel.app")); // no preview pattern
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

Deno.test("normPhone: Indian formats agree with public.helm_norm_phone", () => {
  assertEquals(normPhone("+91 98000 00001"), "919800000001");
  assertEquals(normPhone("09800000001"), "919800000001");
  assertEquals(normPhone("9800000001"), "919800000001");
  assertEquals(normPhone("0044 7700 900123"), "447700900123");
  assertEquals(normPhone(null), "");
});
