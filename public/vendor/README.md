# public/vendor — self-hosted third-party scripts

Third-party browser code is served from our own origin (`script-src 'self'`),
pinned to an exact version, and loaded with Subresource Integrity (SRI) so a
changed file is refused by the browser.

| File | Source package | Version | Source path in package | sha384 (SRI) |
|---|---|---|---|---|
| `supabase-js-2.117.2.min.js` | `@supabase/supabase-js` (npm) | 2.117.2 | `dist/umd/supabase.js` (the minified UMD build; exposes `window.supabase`) | `sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok` |

npm tarball integrity for 2.117.2:
`sha512-eSG2VKnHR+Clp1PmidZ1/weJ8PJwoybjva3L2GgKqFG4YDS1Iqmc61psKGZP5xw6OMT2O7ZorPR42PY6q1BOXg==`.

Loaded by `public/store-api.js` → `loadSupabaseLib()`. The version, file name
and integrity are in the `SUPABASE_JS` constant there.

## Sentry (not vendored)

`public/telemetry.js` still loads `https://browser.sentry-cdn.com/8.35.0/bundle.min.js`,
and only when a DSN is configured. The npm package `@sentry/browser@8.35.0` does not
include the CDN bundles: it has only `build/npm/{cjs,esm,types}`, with no
`build/bundles/`. So there is no npm file that is byte-identical to the CDN bundle,
and no SRI hash could be checked for it. To self-host it, download
`bundle.min.js` from the Sentry CDN on a machine that can reach it. Check it against
the SRI hash Sentry publishes for 8.35.0, commit it here as
`sentry-browser-8.35.0.bundle.min.js`, and point `loadSentry()` at it with
`sc.integrity`.

## Updating supabase-js

```sh
cd "$(mktemp -d)"
npm pack @supabase/supabase-js@<version>          # e.g. 2.118.0 (stay on 2.x)
tar xzf supabase-supabase-js-<version>.tgz
cp package/dist/umd/supabase.js <repo>/public/vendor/supabase-js-<version>.min.js
echo "sha384-$(openssl dgst -sha384 -binary <repo>/public/vendor/supabase-js-<version>.min.js | openssl base64 -A)"
```

Then:
1. In `public/store-api.js`, update `SUPABASE_JS` (`version`, `file`, `integrity`).
2. Delete the old `supabase-js-*.min.js`.
3. Update the table above.
4. Bump the `store-api.js?v=` cache-buster on every page so they all match
   (`scripts/ci-check.mjs` enforces this).
5. Run `npm run ci`, then sign in on a page to smoke-test.

Keep the version in the file name. The file is immutable per version, so it can be
cached for a long time, and a stale `store-api.js` can never load a mismatched file.
