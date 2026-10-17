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

## Sentry (CDN, SRI-pinned, not vendored)

`public/telemetry.js` loads `https://browser.sentry-cdn.com/8.35.0/bundle.min.js`
only when a DSN is configured, and sets `sc.integrity` to
`sha384-j1K2/oFJn/QPiNs/Fk58NwXcaEbWzaUEF04vKMBnEprfbZ2hIQrAO0yc0XEfai1E`
(audit run-3 supply-chain/telemetry/sentry-cdn-script-no-sri). That value is the
checksum Sentry publishes in its release registry
(`release-registry.services.sentry.io/sdks/sentry.javascript.browser/8.35.0`, file
`bundle.min.js`, `sha384-base64`) and it matched a hash of the CDN bytes on
2026-10-17. A tampered file is refused by the browser. To change version, update
`SENTRY_SRC`, `SENTRY_SRI` and the CSP `script-src` directory in
`scripts/csp-hashes.cjs` together.

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
