# public/vendor — self-hosted third-party scripts

Third-party browser code is served from our own origin (`script-src 'self'`),
pinned to an exact version, and loaded with Subresource Integrity (SRI) so a
changed file is refused by the browser.

| File | Source package | Version | Source path in package | sha384 (SRI) |
|---|---|---|---|---|
| `supabase-js-2.118.0.min.js` | `@supabase/supabase-js` (npm) | 2.118.0 | `dist/umd/supabase.js` (the minified UMD build; exposes `window.supabase`) | `sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK` |

npm tarball integrity for 2.118.0 (r30, verified against the registry 2026-10-26):
`sha512-FxI8UXMVC2UG7IkeiI8fuQZqq2oI3JeSuN8MPIC2RLVaoEAxKS0nqE6kii9Ewpq8f9gNPM6git1Y8f0vN/QLFw==`.

Loaded by `public/store-api.js` → `loadSupabaseLib()`. The version, file name
and integrity are in the `SUPABASE_JS` constant there.

## three.js 0.186.1 (r186) — the builder's 3D view

Source: npm `three@0.186.1` (published 2026-09-24), tarball integrity
`sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA==`.
Licence: MIT, Copyright 2010-2026 three.js authors (banner kept in every file).

Built by `scripts/vendor-three.mjs` (dev-time esbuild minify only): `three.module.min.js` =
`build/three.module.js` + `build/three.core.js` bundled into one ES module; each addon is
`examples/jsm/<path>` minified with its bare `'three'` import rewritten to the relative core file,
so no importmap is needed. `node scripts/vendor-three.mjs --check` re-hashes everything against
`scripts/three-vendor.SHA384SUMS`.

Loaded only by `public/three-boot.js` (dynamic `import()` from `public/builder-3d.js` on the first
3D / Render use). Same-origin, so `script-src 'self'` covers it; no CDN host in any CSP.

| File | sha384 |
|---|---|
| `three-0.186.1/addons/controls/OrbitControls.js` | `sha384-mRj9SLRBCpbNLJNWuAgI0lVou2CvzmApyYJhoHA5z1KMGJx+hGzWx7sNqE0FLjPp` |
| `three-0.186.1/addons/controls/TransformControls.js` | `sha384-oB0s0+j4QZri4fdyHnZM//Smq+ygOPZG41j6g29Z4fB3PBOhAiA9y6Xwb95gJkS5` |
| `three-0.186.1/addons/loaders/GLTFLoader.js` | `sha384-s1W6NvCVpzAJr8N0uermT4mHg71dtbooMJ7JOfvrMzYscRwqdytW3MgyRg+KMIED` |
| `three-0.186.1/addons/utils/BufferGeometryUtils.js` | `sha384-Mldi6k0a3Je+fd+qbCYfg6/quNYVkBrYztsQJ3tmofWN6vt+fmZl2kygU3zzUraQ` |
| `three-0.186.1/addons/utils/SkeletonUtils.js` | `sha384-YDk7ED8kkTj8Sr8O8624JO3W2l6TmabXBy5IR8qNsqRjUWbSygeJTo2C0gAz0aA6` |
| `three-0.186.1/three.module.min.js` | `sha384-eZH+Pcr30iKKjwjbpwrnDAgDtIdAPelzi9C6s/tx+5fiQS1SgwamixZGtfLHPjHN` |

## Sentry (CDN, SRI-pinned, not vendored)

`public/telemetry.js` loads `https://browser.sentry-cdn.com/8.55.2/bundle.min.js`
only when a DSN is configured, and sets `sc.integrity` to
`sha384-lNMClDekFF9oPvouGJqnUSKioEadbe8byR7uGUA0sPP+g9r2x3eiErEJmm/Em+wB`
(audit run-3 supply-chain/telemetry/sentry-cdn-script-no-sri). That value is the
checksum Sentry publishes in its release registry
(`release-registry.services.sentry.io/sdks/sentry.javascript.browser/8.55.2`, file
`bundle.min.js`, `sha384-base64`) and it matched a hash of the CDN bytes on
2026-10-26 (r30 bump from 8.35.0). A tampered file is refused by the browser. To change version, update
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
