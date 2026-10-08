// booklet-snapshot (0069) - dormant 404, token + kind validated, the DB decides (path only
// for a live link with that section ticked), path re-checked, private no-sniff response. Mock-only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, loadHandler, resetSupaMock, supaLog } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/booklet-snapshot/index.ts";
const ON = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_BOOKLET_SNAPSHOT_ENABLED: "true" };
const TOK = "a0000000-0000-4000-8000-0000000000aa";
const ORG = "a0000000-0000-4000-8000-000000000001", Q = "a0000000-0000-4000-8000-00000000da01";
const get = (q: string) => new Request("https://fn.local/?" + q, { method: "GET" });
const noFetch = () => installFetch(() => { throw new Error("no fetch expected"); });

function db(path: unknown, bytes = new Uint8Array([137, 80, 78, 71])) {
  g.__supaRpc = (name: string) => name === "booklet_snapshot_path" ? { data: path, error: null } : { data: null, error: null };
  g.__supaStorage = (_b: string, _op: string, _p: string) => ({ data: new Blob([bytes]), error: null });
}

Deno.test("booklet-snapshot: dormant -> 404, DB untouched", async () => {
  resetSupaMock(); db(`${ORG}/${Q}/2d.png`);
  const r = setEnv({ ...ON, HELM_BOOKLET_SNAPSHOT_ENABLED: "" }); const f = noFetch();
  try {
    assertEquals((await (await loadHandler(FN))(get(`t=${TOK}&k=2d`))).status, 404);
    assertEquals(supaLog().length, 0);
  } finally { f(); r(); }
});

Deno.test("booklet-snapshot: bad token / kind -> 404 without a DB call", async () => {
  resetSupaMock(); db(`${ORG}/${Q}/2d.png`);
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    for (const q of ["t=nope&k=2d", `t=${TOK}&k=4d`, ""]) assertEquals((await h(get(q))).status, 404);
    assertEquals(supaLog().filter((l) => l.rpc).length, 0);
  } finally { f(); r(); }
});

Deno.test("booklet-snapshot: hidden section / unknown link (null path) -> 404", async () => {
  resetSupaMock(); db(null);
  const r = setEnv(ON); const f = noFetch();
  try {
    assertEquals((await (await loadHandler(FN))(get(`t=${TOK}&k=3d`))).status, 404);
    assertEquals(supaLog().filter((l) => l.storage).length, 0);
  } finally { f(); r(); }
});

Deno.test("booklet-snapshot: malformed / mismatched path from DB -> 404", async () => {
  for (const p of ["../etc/passwd", `${ORG}/${Q}/3d.png`, `${ORG}/${Q}/2d.svg`]) {
    resetSupaMock(); db(p);
    const r = setEnv(ON); const f = noFetch();
    try { assertEquals((await (await loadHandler(FN))(get(`t=${TOK}&k=2d`))).status, 404); } finally { f(); r(); }
  }
});

Deno.test("booklet-snapshot: ticked snapshot streamed privately", async () => {
  resetSupaMock(); db(`${ORG}/${Q}/2d.png`);
  const r = setEnv(ON); const f = noFetch();
  try {
    const res = await (await loadHandler(FN))(get(`t=${TOK}&k=2d`));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    assert((res.headers.get("cache-control") || "").startsWith("private"));
    assertEquals((await res.arrayBuffer()).byteLength, 4);
    const call = supaLog().find((l) => l.rpc === "booklet_snapshot_path")!;
    assertEquals(call.args, { p_token: TOK, p_kind: "2d" });
    assertEquals(supaLog().find((l) => l.storage)!.key, "service-role-secret");
  } finally { f(); r(); }
});
