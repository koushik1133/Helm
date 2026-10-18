# Logo swap checklist (updated 2026-10-17)

## Current state (2026-10-18 v3): kit SHAPE recoloured per theme
- Lockup + rail logo are inline SVG built from the kit geometry with classes hl-ink (H+ELM) / hl-acc (points) / hl-ring; colours = --hl-ink/--hl-acc/--hl-ring per theme in shell-b.css (marketing + login: Emerald in home.css/legal.css/login.html). Ring/ticks bolder, flat colours, points cut a gap into the H via a mask.
- Emerald standalone: brand/helm-logo-emerald.svg, helm-symbol-emerald.svg, helm-app-icon-emerald.svg (icons), favicon.svg, helm-email-emerald.svg.
- E-mail logo (r19): `public/email/helm-logo-v3.png` (80x80, from helm-email-emerald.svg) via `LOGO_URL` in `supabase/functions/_shared/email-layout.mjs`. Never overwrite an e-mail PNG in place (immutable cache + mail image proxies); add a new versioned file name.

## Earlier (v2): brand kit logo, copied as-is
- Kit files (docs/HELM_Brand_and_Website_Kit 2/HELM_Brand_Kit/assets) are copied unchanged into `public/brand/` (svg), `public/brand/png/`, `public/brand/icons/`.
- Lockup = kit `helm-primary.svg` (the compass symbol IS the H of HELM): marketing header/footer `<img class="lockup">`, login brand pane.
- App rail: `.hb-logo` = kit symbol, `.hb-name` = `helm-elm*.svg` (the kit lockup cropped to "ELM", viewBox only) -> reads HELM; collapsed rail = symbol only. Variant by theme in `shell-b.css`: primary / `-on-dark` (dark) / `-monochrome` (graphite).
- Small `.mark` / `.mmk` tiles = kit `helm-symbol.svg` background.
- favicon.ico + favicon.svg (= helm-app-icon.svg), icon-192/512 = kit icons; favicon-48, apple-touch-180, email logo 112 = resized kit icons; og.png logo tile = kit symbol.
- Loader outlines (`HB_MARK`, `MARK`) are a simplified H + compass trace (animation only).
(The two-pill notes below are historical.)


## 0. Current state (2026-10-16): ONE shared mark
The home-page mark (two tilted pills, ink + accent) is now the logo everywhere:

| Surface | How it draws the mark | Theme-aware via |
|---|---|---|
| **Source of truth** `public/brand/mark.svg` | `<symbol id="helm-mark">`: pill 1 `stroke="currentColor"`, pill 2 has no stroke (inherits `stroke` from the host `<svg>`) | host CSS `color` + `stroke` |
| App rail (all signed-in pages) `shell-b.js` | `<svg class="helm-mark"><use href="/brand/mark.svg#helm-mark">` built with createElementNS | `.hb-logo` colour per theme (5 themes x light/dark); pill 2 = `color-mix(currentColor 58%)` in `shell-b.css` |
| Login brand pane, `hq.html` | same `<svg><use>` markup in HTML | `.mk .helm-mark{color;stroke}` in the page's (CSP-hashed) `<style>` |
| Marketing/legal/try/demo header+footer (58 pages) | `<span class="mark"><i></i><i></i></span>` CSS pills (identical shape) | `.mark i{background:var(--ink)}`, `.mark i+i{background:var(--acc)}` in each page CSS |
| App loader `shell-proto.js` HB_MARK, marketing intro `marketing-loader.js` MARK, `shell-b-loader-mark.svg` | pill outline paths + `transform="rotate(-20 24 24)"` | `var(--hb-acc)` stroke |
| Favicon | `public/brand/favicon.svg` (light/dark via `prefers-color-scheme` inside the SVG) + PNG fallbacks `favicon-48.png`, `favicon.ico`, `apple-touch-icon.png` (rendered from it) | OS colour scheme |

### Future swap = one file (+ fallbacks)
1. Replace the `<symbol id="helm-mark">` body in `public/brand/mark.svg` (keep the id and `viewBox="0 0 48 48"`; draw the main shape with `currentColor`, the accent part with no fill/stroke attribute so it inherits). App rail, login and hq update automatically.
2. Replace `public/brand/favicon.svg`, then re-render PNGs: `qlmanage -t -s 1440 -o /tmp/ql favicon.svg` then `magick` resize to 180 (flatten on #f5f6f1) / 48 / 32 / 16 and `magick f16.png f32.png f48.png favicon.ico` (ImageMagick's own SVG renderer mis-handles transforms; use qlmanage).
3. Marketing `.mark`: if the new logo is not two pills, switch `.mark` (in the CSS files listed in section 2) to an inline `<svg class="helm-mark"><use href="/brand/mark.svg#helm-mark"/></svg>` or replace the `<i>` rules; the pill CSS is the only remaining copy.
4. Loader paths (`HB_MARK`, `MARK`): paste the new outline `d=` strings.
5. Bump `SHELL_V` in `shell-proto.js`, `?v=` on `marketing-loader.js`, run gen-csp.

---
(Original 2026-10-15 checklist below, kept for the raster/meta details.)


When the owner sends the new logo, deliver it as: **one SVG (mark only, square, transparent)** + **one SVG (mark + "Helm" wordmark)** + a light and dark colour version if they differ. Everything below comes from those files.

## 1. Raster files (replace in place, same names/sizes; no code change)

| File | Size | Used by |
|---|---|---|
| `public/favicon.ico` | 48x48 (multi-size 16/32/48 fine) | browsers default `/favicon.ico` |
| `public/favicon-48.png` | 48x48 PNG | `<link rel="icon">` in 16 pages |
| `public/apple-touch-icon.png` | 180x180 PNG, opaque background, ~10% padding | `<link rel="apple-touch-icon">` in 15 pages |
| `public/og.png` | 1200x630 PNG (logo + tagline; keep key content in centre 1000x520) | `og:image` / `twitter:image` meta in 24 pages (`https://www.helm.events/og.png`) |

Cache: `vercel.json` (rule matching `/(og\.png|apple-touch-icon\.png|favicon-48\.png|favicon\.ico)`) sets long caching. After swapping, either bump a `?v=` on those `<link>` tags or accept up to the cache TTL; social sites (WhatsApp/LinkedIn/X) cache og:image separately — re-scrape via their debuggers.

Note: ~50 app pages have no `<link rel="icon">` and rely on `/favicon.ico`; replacing that file covers them.

## 2. Vector / CSS-drawn marks (code edits)

| Where | What it is today | How to swap |
|---|---|---|
| Marketing header/footer + phone mock-ups — `<span class="mark"><i></i><i></i></span>` in 58 public pages (index, about, services, pricing, legal pages, try, portal, etc.) | Two rotated pills drawn in CSS | Change the CSS rule, not 58 files: `.mark` / `.mark i` in `public/home.css` (line ~40, plus `.core .mark` ~178, `.nic .mark` ~953) and the equivalent `.mark` rules in `landing.css`, `public-v2.css`, `public-pages-v2.css`, `legal.css`, `business.css`, `client.css`, `builder.css`, `builder-v2.css`, `shell-b.css`, `shell-b-pages.css`. Easiest: make `.mark` a `background:url(/brand/mark.svg) center/contain no-repeat` box and hide the `<i>`s. |
| App rail / top bar (all signed-in pages) — `public/shell-b.js` line ~144 `el("span","hb-logo","H")` | Letter "H" in a coloured tile | Styled by `.hb-logo` in `public/shell-b.css` (~44, ~295) and `public/shell-b-theme-studio.css` (~77). Swap text "H" for an `<img src="/brand/mark.svg">` built with createElement, or set a CSS background on `.hb-logo`. Name text "Helm Events" is next to it. |
| App loading screen — `public/shell-b-loader-mark.svg` (48x48 viewBox) | SVG mark | Replace file contents (keep viewBox 0 0 48 48). |
| Marketing first-visit intro — `public/marketing-loader.js` `MARK` path constants (same 48x48 paths) | SVG paths built with createElementNS | Paste new path `d=` strings (no innerHTML — CSP). |
| Login page — `public/login.html` `.brandpane .mk` (CSS lines ~43-44) | CSS square-in-square | Replace with the mark (CSS background or `<img>`); inline `<style>` in login.html is CSP-hashed → run `node scripts/gen-csp.mjs` afterwards. |

## 3. Not affected
- Booklet / proposal / portal show the **studio's own** logo (`booklet.js` `safeLogo(s.logo)`), not Helm's — no change.
- Edge-function and auth e-mails use the hosted PNG in `LOGO_URL` (see the r19 line at the top).

## 4. After the swap
1. Put sources in `public/brand/` (`mark.svg`, `logo.svg`, `logo-dark.svg`).
2. Bump `?v=` on every changed CSS/JS include.
3. `node scripts/gen-csp.mjs && node scripts/gen-csp.mjs --check`, `node scripts/check-html-sinks.mjs`, run `test/*.test.mjs`.
4. Check `/`, `/login`, `/dashboard` light + dark, and a phone width.
