// SAFE local mock of @supabase/supabase-js used by the edge test harness.
// Redirected in via import_map.json so the real npm/esm.sh module is NEVER fetched.
// All behaviour is driven by globals the test sets before invoking a handler:
//   globalThis.__supaRpc(name, args, key)        -> { data?, error? }   (key = that client's API key)
//   globalThis.__supaGetUser(jwt)                -> { data: { user } , error? }
//   globalThis.__supaResolver(table, calls, key) -> { data, error }   (for .from(...))
//   globalThis.__supaAuth(op, args, key)         -> { data, error }   (auth.signInWithOtp / auth.admin.createUser / updateUserById / generateLink / inviteUserByEmail)
// Every call is also recorded on globalThis.__supaLog for assertions, including
// which key / Authorization header each client was created with (caller vs service role).

export type SupabaseClient = any;

function g(): any {
  return globalThis as any;
}

function makeBuilder(table: string, key?: string) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: any = new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === "then") {
        const resolver = g().__supaResolver || (() => ({ data: null, error: null }));
        const result = resolver(table, calls, key);
        g().__supaLog.push({ table, calls: calls.slice(), result, key });
        return (res: any, rej: any) => Promise.resolve(result).then(res, rej);
      }
      return (...args: unknown[]) => {
        calls.push([prop, args]);
        return builder;
      };
    },
  });
  return builder;
}

export function createClient(_url?: string, key?: string, opts?: any): SupabaseClient {
  if (!g().__supaLog) g().__supaLog = [];
  g().__supaLog.push({ createClient: key, authHeader: opts?.global?.headers?.Authorization ?? null });
  return {
    rpc: (name: string, args: unknown) => {
      g().__supaLog.push({ rpc: name, args, key });
      const fn = g().__supaRpc || (() => ({ data: null, error: null }));
      return Promise.resolve(fn(name, args, key));
    },
    auth: {
      getUser: (jwt: string) => {
        g().__supaLog.push({ getUser: jwt });
        const fn = g().__supaGetUser || (() => ({ data: { user: null } }));
        return Promise.resolve(fn(jwt));
      },
      // auth e-mail / admin subset (invite-signup 0205): globalThis.__supaAuth(op, args, key) -> { data, error }
      signInWithOtp: (args: unknown) => {
        g().__supaLog.push({ auth: "signInWithOtp", args, key });
        const fn = g().__supaAuth || (() => ({ data: {}, error: null }));
        return Promise.resolve(fn("signInWithOtp", args, key));
      },
      admin: {
        createUser: (args: unknown) => {
          g().__supaLog.push({ auth: "createUser", args, key });
          const fn = g().__supaAuth || (() => ({ data: {}, error: null }));
          return Promise.resolve(fn("createUser", args, key));
        },
        updateUserById: (id: string, attrs?: unknown) => {
          g().__supaLog.push({ auth: "updateUserById", args: { id, attrs }, key });
          const fn = g().__supaAuth || (() => ({ data: {}, error: null }));
          return Promise.resolve(fn("updateUserById", { id, attrs }, key));
        },
        generateLink: (args: unknown) => {
          g().__supaLog.push({ auth: "generateLink", args, key });
          const fn = g().__supaAuth || (() => ({ data: {}, error: null }));
          return Promise.resolve(fn("generateLink", args, key));
        },
        inviteUserByEmail: (email: string, opts?: unknown) => {
          g().__supaLog.push({ auth: "inviteUserByEmail", args: { email, opts }, key });
          const fn = g().__supaAuth || (() => ({ data: {}, error: null }));
          return Promise.resolve(fn("inviteUserByEmail", { email, opts }, key));
        },
      },
    },
    from: (table: string) => makeBuilder(table, key),
    // storage subset (0069 booklet-snapshot): globalThis.__supaStorage(bucket, op, path, key) -> { data, error }
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          g().__supaLog.push({ storage: bucket, op: "download", path, key });
          const fn = g().__supaStorage || (() => ({ data: null, error: { message: "not found" } }));
          return Promise.resolve(fn(bucket, "download", path, key));
        },
      }),
    },
  };
}

export default { createClient };
