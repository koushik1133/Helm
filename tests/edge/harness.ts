import { _resetRateLimits } from "../../supabase/functions/_shared/limits.ts";
// Shared harness: stub Deno.env, global fetch, and Deno.serve so an edge
// function's handler can be invoked in-process with NO real network/provider calls.

type FetchRec = { url: string; init?: RequestInit };

const g = globalThis as any;

/** Replace Deno.env.get with a map lookup. Returns a restore fn. */
export function setEnv(env: Record<string, string>) {
  const orig = Deno.env.get;
  // the durable (DB) rate limiter is OFF unless a test opts in (keeps per-test RPC logs exact)
  const e: Record<string, string> = { HELM_DURABLE_RATE_LIMIT: "off", ...env };
  (Deno.env as any).get = (k: string) => (k in e ? e[k] : undefined);
  return () => ((Deno.env as any).get = orig);
}

/**
 * Install a mock fetch. `responder(url, init)` returns a Response (or body/status).
 * Every call is recorded. Any URL the responder does not handle THROWS — this is
 * what guarantees the harness never performs a real provider call.
 */
export function installFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  g.__fetchLog = [] as FetchRec[];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    g.__fetchLog.push({ url, init });
    return await responder(url, init);
  }) as any;
  return () => (globalThis.fetch = orig);
}

export function fetchLog(): FetchRec[] {
  return (g.__fetchLog as FetchRec[]) || [];
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

/**
 * Import an edge function module with Deno.serve stubbed to capture its handler.
 * A unique cache-buster is appended so module top-level `const`s (e.g. the
 * WhatsApp TOKEN) are re-read from the CURRENT Deno.env on every load.
 */
export async function loadHandler(relPath: string): Promise<(req: Request) => Promise<Response> | Response> {
  let captured: any = null;
  _resetRateLimits();   // per-isolate limiter state must not leak between tests
  const origServe = (Deno as any).serve;
  (Deno as any).serve = (h: any) => {
    captured = h;
    return { finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} } as any;
  };
  try {
    await import(`${relPath}?v=${crypto.randomUUID()}`);
  } finally {
    (Deno as any).serve = origServe;
  }
  if (!captured) throw new Error(`handler not captured from ${relPath}`);
  return captured;
}

export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://fn.local/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Capture console.error output during a thunk, to assert no secret leakage. */
export async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.error = orig;
  }
}

export function resetSupaMock() {
  g.__supaLog = [];
  g.__supaRpc = undefined;
  g.__supaGetUser = undefined;
  g.__supaResolver = undefined;
}
export function supaLog(): any[] {
  return (g.__supaLog as any[]) || [];
}
