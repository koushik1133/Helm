# CodeQL triage - round 21 (19 Oct 2026)

Source: `gh api repos/koushik1133/Helm/code-scanning/alerts?state=open --paginate` (read-only), analysis
`1981704771` on `main` @ `4e3aa0fc`, plus its SARIF code flows. **35 open alerts** (the checklist said 34; one new
test alert, #94, arrived with PR #217). Nothing was dismissed through the API - the owner decides.

Verdicts:
- **Fixed** - changed in branch `fix/r21-security`. The alert should close by itself on the next CodeQL run of `main`
  after the merge. If one stays open, dismiss it with the reason in the table.
- **False positive** - safe as written. Dismiss in GitHub -> Security -> Code scanning -> the alert ->
  **Dismiss alert** -> the reason shown (`False positive` or `Used in tests`), and paste the comment.

## Summary

| Group | Alerts | Verdict |
|---|---|---|
| Shipped website code (`public/`) | 13 (#37, #58, #59, #60, #78, #79, #81, #84, #87, #88, #90, #91, #93) | **All 13 fixed.** None could be exploited from outside a studio's own account. 5 were low-risk true positives (values not escaped before going into HTML). 8 were already safe and are now hardened so the scanner can see that. |
| Staging red-team scripts (`tests/staging/`) | 3 (#33, #34, #35) | **Fixed.** `rand()` now uses `crypto.getRandomValues`. |
| Unit tests and CI tools (`test/`, `tests/edge/`, `scripts/`) | 19 | **False positive / used in tests.** These files never ship to the site and never handle visitor input. They are listed below so each one can be dismissed. |

## 1. Shipped code - all fixed

| # | Rule | Location | What CodeQL saw | Verdict | Fix |
|---|---|---|---|---|---|
| 90 | js/xss | `public/auth-confirm.js:28` | `location.search` -> `next=` -> `location.replace(path)` | False positive (already safe). `auth-confirm-core.js` `safePath()` accepts only same-origin paths: no scheme, `//host`, `/\host`, control characters, or loop back to /auth/confirm. CodeQL does not follow that check across files. | Hardened. `go()` checks again that the path starts with one `/`, then falls back to `/login`. |
| 91 | js/client-side-unvalidated-url-redirection | same line | same flow | False positive (same reason). | Same fix as #90. |
| 58 | js/incomplete-multi-character-sanitization | `public/auth-ui.js:860` (profile skills) | `/<[^>]*>/g` stripped once, so `<scr<script>ipt>` can rebuild a tag | Low-risk true positive. The value is always shown with `textContent`, so it can't run. But cleaned profile text could still be stored with markup in it. | New `noTags()` strips tags repeatedly until none are left, then removes any stray `<` or `>`. |
| 59 | same | `public/auth-ui.js:926` (profile form fields) | same | Low-risk true positive. | `noTags()`. |
| 93 | same | `public/auth-ui.js:1146` (profile suggestions) | same | Low-risk true positive. A second pass already removed `<` and `>`. | `noTags()`. |
| 60 | same | `public/form-validate.js:23` `stripHtml` | same | False positive (a second `.replace(/[<>]/g, "")` already removed every bracket). | Repeat-until-clean loop added, so the scanner can see it. |
| 88 | js/xss-through-dom | `public/events-calendar.js:213` | `data-day` attribute -> `st.anchor` -> raw `d` in the day-view markup (`data-day="' + d + '"`) | Low-risk true positive. Only the page's own markup produces `data-day`, but the day view put the raw anchor into HTML. | `openDay()` uses only a real yyyy-mm-dd, rebuilt from the parsed date. Anything else is ignored. |
| 87 | js/xss-through-dom | `public/quotes.html:674` (layout version picker) | `fmtDate(v.createdAt)` not escaped | False positive. `BPStore.fmtDay` returns a formatted date or "". | Wrapped in `esc()`. |
| 81 | js/xss-through-dom | `public/quotes.html:1047` (print / PDF popup, `document.write`) | `BPStore.quoteDate(...)` and `full.currentVersion` not escaped | Low-risk true positive. The data is the studio's own quote, and on the local-fallback path it comes from browser storage. | `esc()` added to the version and both dates. |
| 78, 79, 84 | js/xss-through-dom | `public/event.html:796/805/811` (event hub cards) | `ev.currentVersion` interpolated into the "Quote & approval" card. The local-fallback store carries form values. | Low-risk true positive. | `esc(ev.currentVersion)`. The card links' `href` and label are now escaped too. |
| 37 | js/xss-through-dom | `public/chat.html:732` | `data-media` -> `mediaUrl()` -> `img.src` | False positive. An `<img src>` cannot run script, and the value is a signed storage URL. | Hardened. Only an `https:` URL is assigned. |

Tests: `test/r21-security.test.mjs` covers each of these fixes (`auth-confirm go()`, the `noTags` and `stripHtml` fixed point, calendar day normalisation, and the escaped interpolations).

## 1b. Follow-up - the 3 website alerts still open after the security PR (branch `fix/r21-codeql-last3`)

The first CodeQL run on `main` after the merge (`ffd1ee12`) closed the other website alerts, but re-raised three on the
hardened lines with new numbers. The guards added in round 21 were correct, but CodeQL does not treat a regex test or
an `https:` check as a sanitizer. This time the flows themselves were changed, so the scanner can follow them.

| # | Rule | Location | Root cause (data flow) | Verdict | Fix |
|---|---|---|---|---|---|
| 95 | js/xss | `public/auth-confirm.js:30` `go()` | `location.search` -> `next=` (`auth-confirm-core.js` `parse()` / `safePath()`) -> `link.next` -> `go(path)` -> `location.replace(p)`. The guard was `if (!/^\/.../.test(p)) p = "/login"`. CodeQL does not count a regex test as a sanitizer, so the link's own text still reached the sink. | False positive. `safePath()` and the regex already allowed only a same-origin path, so `javascript:` could never get through. | `go()` resolves the path with `new URL(path, location.origin)` and requires the same origin. The path must be exactly one of the fixed pages an auth e-mail returns to (`/login`, `/login.html`, `/reset-password`, `/reset-password.html`), and the string sent is the file's own constant. Only the query is carried over, after a literal `"?"`. Anything else goes to `/login`, the default every auth link already falls back to. No real link changes: invite (`/login?invite=`), sign-up (`/login.html?next=&invite=`), recovery (`/reset-password?via=confirm`), `?error_code=` and `?confirmed=` all keep their exact target, on both `helm.events` and `www.helm.events`. |
| 98 | js/client-side-unvalidated-url-redirection | same line | Same flow as #95. | False positive (same reason). | Same fix as #95. The host can never come from the link. |
| 96 | js/xss-through-dom | `public/chat.html:732` | `data-media` attribute (DOM text) -> `el.getAttribute("data-media")` -> `BPStore.chat.mediaUrl(p)` -> `el.src = u`. The `https:` check added in round 21 is not a sanitizer CodeQL knows. | False positive. `<img src>` / `<audio src>` cannot run script, and `mediaUrl()` returns a signed storage URL. | The storage path no longer goes through DOM text. `renderMessages()` keeps the paths in a local `media` list, and `data-media` carries only a number. The loader reads that number with `parseInt` and looks the path up in the list. The `https:` check stays. Photos and voice notes render exactly as before. Mentions, emoji, links and reactions were not touched. |

Tests: `test/r21-security.test.mjs` 6a runs the new `go()` in a sandbox (allowed targets on both origins, and `//host`,
`/\host`, other origins, `javascript:`, unknown pages and `/auth/confirm` all fall back to `/login`). 6c pins the chat
media index list. If any of #95, #96 or #98 is still open after the next `main` run, dismiss it as **False positive** with
the comment in this table.

## 2. Staging scripts - fixed

| # | Rule | Location | Verdict |
|---|---|---|---|
| 33 | js/insecure-randomness | `tests/staging/authz-matrix.mjs:55` | Weak true positive. `rand()` (Math.random) built throw-away passwords for red-team accounts. The test expects the server to refuse to create these accounts, but they still should not be guessable. Fixed in `tests/staging/lib/client.mjs` `rand()` (CSPRNG). |
| 34 | same | `tests/staging/redteam.mjs:152` | Same; fixed by the same change. |
| 35 | same | `tests/staging/redteam.mjs:179` | Same; fixed by the same change. |

## 3. Tests and CI tools - false positive (dismiss as "Used in tests" or "False positive")

None of these files is deployed. `vercel.json` serves `public/` only, and `scripts/check-deploy-static.mjs` enforces that. They only read this repository's own files or fixed strings.

| # | Rule | Location | Dismiss as | Comment to paste |
|---|---|---|---|---|
| 94 | js/incomplete-url-substring-sanitization | `test/r21-trial-paid.test.mjs:167` | Used in tests | Test assertion: checks that a generated URL contains the expected checkout URL. Not a sanitizer. |
| 83 | js/incomplete-url-substring-sanitization | `tests/edge/email-compliance.test.ts:32` | Used in tests | Assertion that a rendered e-mail contains the privacy link. |
| 82 | js/incomplete-url-substring-sanitization | `test/seo-geo.test.mjs:56` | Used in tests | Assertion on our own sitemap / page text. |
| 64 | js/incomplete-url-substring-sanitization | `tests/edge/pkg-client-notify.test.ts:65` | Used in tests | Mock fetch router matching the Meta Graph host in an offline test. |
| 54 | js/incomplete-url-substring-sanitization | `tests/edge/verify-upload.test.ts:191` | Used in tests | Mock fetch router for a fake antivirus host. |
| 44 | js/incomplete-url-substring-sanitization | `tests/edge/create-payment-link.test.ts:132` | Used in tests | Mock fetch router for the Razorpay cancel URL. |
| 92 | js/redos | `test/r20-flow.test.mjs:51` | Used in tests | Regex over our own `store-api.js` source in a unit test. No external input. |
| 89 | js/incomplete-multi-character-sanitization | `test/manual-r19.test.mjs:24` | Used in tests | Strips HTML comments from our own page before asserting on it. Not a sanitizer. |
| 66 | js/incomplete-multi-character-sanitization | `test/render-dialog-polish.test.mjs:162` | Used in tests | Same: comment stripping in a source assertion. |
| 62 | js/incomplete-multi-character-sanitization | `test/onboarding-checkout.test.mjs:291` | Used in tests | Same. |
| 61 | js/incomplete-multi-character-sanitization | `test/auth-signup-confirm.test.mjs:61` | Used in tests | Removes `<script>` blocks from our own HTML to inspect the markup. |
| 57 | js/bad-tag-filter | `test/auth-signup-confirm.test.mjs:61` | Used in tests | Same line as #61. Our pages always write lower-case `<script>`. |
| 63 | js/bad-tag-filter | `test/client-360-ui.test.mjs:71` | Used in tests | Extracts inline scripts from our own HTML for assertions. |
| 48 | js/bad-tag-filter | `test/bell-panel.test.mjs:143` | Used in tests | Same. |
| 46 | js/bad-tag-filter | `test/manual-gate.test.mjs:31` | Used in tests | Same. |
| 56 | js/bad-tag-filter | `scripts/extract-inline-styles.mjs:39` | False positive | CI tool that parses this repository's own HTML to move inline styles into CSS. It never sees visitor input and never sanitizes anything. |
| 55 | js/bad-tag-filter | `scripts/check-html-sinks.mjs:187` | False positive | CI lint that skips our own `<script>` blocks while scanning for HTML sinks. Same reasoning. |
| 53 | js/bad-code-sanitization | `test/sim-pay-prod-ui.test.mjs:13` | Used in tests | Evaluates a snippet from our own `store-api.js` in a `vm` sandbox to unit-test it. |
| 45 | js/incomplete-sanitization | `test/db-log-noise.test.mjs:14` | Used in tests | Builds a RegExp from fixed function names in the test itself. |

## 4. Recommended next steps (owner)

1. After this branch is merged, wait for the CodeQL run on `main`. Fixed alerts close automatically.
2. Dismiss the 19 alerts in section 3 with the reasons above. This takes about 10 minutes.
3. Optional: give the CodeQL step in `.github/workflows/codeql.yml` a config with `paths-ignore: [test, tests, scripts]` (a new `.github/codeql/codeql-config.yml`), so test-only patterns stop being reported. Not done here, because it changes what CI scans and that is the owner's decision.
4. Make CodeQL a required status check in the `main` branch ruleset (see `OWNER-DASHBOARD-STEPS-R21.md` section A).
