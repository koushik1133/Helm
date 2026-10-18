# Helm — Design System (as built)

Documents the visual system that exists today in `public/` (vanilla HTML/CSS/JS). Every claim cites a file. "Assumption:" = inferred, not verified. "Decision needed:" = owner call.

## 1. Visual direction and principles

| Principle | What it means in code | Source |
|---|---|---|
| One calm style | All app pages run under `html[data-shell="b"]`; one layer remaps every page's legacy tokens to the active theme | `shell-b-style.css` header, `shell-b-pages.css` |
| One accent, neutral surfaces | Each theme = white panel + tinted page background + a single accent colour | `shell-b.css` lines 3-12 |
| Look-only themes | Themes never hide/move controls and never recolour money (`[data-money]`, `.hbp-m`) | `shell-b-theme-studio.css`, `shell-b-pages.css` |
| Light only | Dark mode is switched off (Oct 2026). `shell-proto.js` forces `data-theme="light"` and adds `html.hb-nodark` unless `window.HELM_DARK_MODE === true`; the rail hides the light/dark toggle | `shell-proto.js:37`, `shell-b.js:178` |
| Calm motion | Short eased transitions, one-time entrance, all disabled under `prefers-reduced-motion` | `shell-b-dash.css:390`, `shell-b.css:153` |

Note: dark-mode CSS still exists in `theme.css`, `shell-b.css` and theme files (dormant). Decision needed: delete the dormant dark rules or keep them for a future re-enable (memory: dark-green contrast work is parked).

The public marketing site (`landing.css`, `marketing*.css`, `home.css`) is a separate editorial style ("Helm demo 9 — editorial, light emerald": Instrument Serif + Plus Jakarta Sans, `--acc:#0b7d53`). It does not use shell-b.

## 2. Colour — themes

Theme is set by `html[data-hb-theme]`; default is **emerald** (`shell-b.js:221`). Picker offers 5 themes (`shell-b.js:220`): Emerald, Cobalt, Midnight, Graphite, Studio. A sixth, **Luxe** (`shell-b-theme-luxe.css`), exists in CSS but is not in the picker.

Light tokens (`shell-b.css`):

| Theme | `--hb-bg` (panel) | `--hb-bg2` (page) | `--hb-line` | `--hb-ink` | `--hb-acc` | `--hb-acc-soft` | `--hb-acc-text` |
|---|---|---|---|---|---|---|---|
| Emerald (default) | #ffffff | #f4f8f6 | #e0eae5 | #0b2a22 | #047857 | #e3f4ed | #036b4d |
| Cobalt (unscoped base) | #ffffff | #f5f7fc | #e3e8f2 | #0b1b3f | #2450f0 | #eaeffe | #1d44d8 |
| Midnight | #ffffff | #f5f5fb | #e4e4f0 | #12133a | #4338ca | #eeedfc | #3f34c2 |
| Graphite (pure B/W) | #ffffff | #f5f5f5 | #e5e5e5 | #000000 | #000000 | #f0f0f0 | #000000 |
| Studio (warm + plum) | #FFFFFF (`--c8-su`) | #FAF8F5 | #E7E2DA | #1F1A24 | #5B2A86 | #F1EBF7 | — |

Secondary ink: `--hb-ink2`, `--hb-ink3` per theme. Derived tokens (all themes): `--hb-grad` (primary button gradient), `--hb-tile` (icon tile gradient acc2→acc), `--hb-glow`, `--hb-lift`, `--hb-pop` shadows — built with `color-mix()` from the accent (`shell-b.css` ~line 20).

Bridge: `shell-b-style.css` maps legacy page tokens (`--accent`, `--bg`, `--panel`, `--ink*`, `--line`) to `--hb-*`, so older pages styled with `theme.css` tokens follow the theme.

Status colours (not themed, by design): `theme.css` defines `--safe-text #0f7a43`, `--warn-text #8f5f00`, `--bad-text #b42318`, `--info-text #1d4ed8` (all ≥4.5:1 on white per comments). Dashboard uses `--hd-ok/warn/risk` (`shell-b-dash.css`). Danger buttons: `#b42318` text on `#f1c4bf` border (`shell-b-style.css`).

## 3. Typography

| Use | Font | Source |
|---|---|---|
| App UI / rail | IBM Plex Sans, system-ui fallback | `shell-b.css` rail, `--hd-f-ui` |
| Display numbers, greetings, KPI values | Fraunces (variable, opsz) | `--hd-f-disp` in `shell-b-dash.css` |
| Codes / mono | IBM Plex Mono | `--hd-f-mono` |
| Control Center search | Apple system stack (SF Pro) | `control-split.css` |
| Luxe theme | Cormorant Garamond + Inter Tight (Google Fonts) | `shell-b-theme-luxe.css` |

Type scale (`theme.css`): `--fs-xs 12`, `--fs-sm 13`, `--fs-base 14`, `--fs-md 16`, `--fs-lg 19`, `--fs-xl 23`, `--fs-2xl 28` px. Body 14/20. Eyebrows 11px uppercase, .08em tracking. Rail group heads 10.5px uppercase. Numbers use `tabular-nums` in tables, KPIs and money (`theme.css:285`). KPI value 36px Fraunces; countdown `clamp(40px,4vw,60px)`.

## 4. Spacing, radius, elevation

- Spacing (`theme.css:257`): `--sp-1 4`, `--sp-2 8`, `--sp-3 12`, `--sp-4 16`, `--sp-5 24`, `--sp-6 32`, `--sp-7 48` px.
- Radius rule: controls 9px, cards/modals 14px, pills 999px (`theme.css:246-258`). Shell-b buttons use 8px; dashboard rows 10px; Luxe 2px.
- Elevation: `--elev-sm/md/lg` (`theme.css`); in shell-b the base shadow is near-flat (`0 1px 2px rgba(0,0,0,.04)`), with `--hb-lift` for hover and `--hb-pop` for popovers.
- Shell geometry (`shell-b.css:2`): rail 68px collapsed / 240px expanded or pinned, top bar 60px, ease `cubic-bezier(.22,1,.36,1)`.
- Dashboard grid: 12 columns, max 1360px, gap 20px, side padding 32px; wide lane = cols 1-7, side lane = cols 8-12 (`shell-b-dash.css:60-75`).

## 5. Reusable components

| Component | Classes | Behaviour | Source |
|---|---|---|---|
| Rail (side nav) | `.hb-rail`, `.hb-group`, `.hb-head`, `.hb-item`, `.hb-lb`, `.hb-pin` | Fixed left, icons only at 68px; expands on hover/focus-within to 240px; pin button keeps it open (`html.hb-pinned`); groups separated by hairlines; role-hidden items use `[hidden]` | `shell-b.css`, `shell-b.js` |
| Rail bottom | `.hb-bottom`, `.hb-theme` (theme picker `#hbThemePick`), `.hb-acct` (account menu), `.hb-who` | Theme swatch picker; light/dark toggle only if `HELM_DARK_MODE` | `shell-b.js:175-237` |
| Top bar | `header.hb-header`, `.hb-tools`, `.hb-search`, `.hb-ibtn`, `.hb-new`, `.hb-chat`, bell `#bpBellBtn` | 60px; search trigger, chat, notifications, "+ New" | `shell-b.css:100-135` |
| Search palette | `.hss-dlg`, `.hss-ov` | Cmd/Ctrl+K; full-screen sheet on phones | `shell-b-search.css`, `studio-search.js` |
| Buttons | `.btn`, `.btn.primary`/`.go`, `.btn.ghost`, `.btn.danger`/`.no` | Primary = accent gradient + glow, lifts 1px on hover; disabled opacity .45 | `shell-b-style.css` §2 |
| Cards / modules | `.card`, `.mod`, `.kpi` | White panel, 1px line, 14px radius | `theme.css`, `shell-b-style.css` |
| KPI tiles | `.hd-kpi`, `.hd-kpi-v` | Eyebrow + big Fraunces number | `shell-b-dash.css:185-196` |
| Pills / badges / status | `.pill`, `.badge`, `.chip`, `.stat.*`, `.st.*`, `.paybadge.*`, `.gate.*`, `.qc.*` | Tinted status fills; tabular numerals | `theme.css:201-220, 330` |
| Sheets / modals | `.sheet`, `.lsheet`, `.usheet`, `.modal`, `.hp-pop` | Panel background, `--elev-lg`/`--hb-pop` | `theme.css:181-186, 326` |
| Toast | `.toast` | Ink background, bg-colour text, 10px radius | `shell-b-style.css:79` |
| Phone input | `.hp`, `.hp-cc`, `.hp-pop`, `.hp-opt` | Country-code picker, 38px floor | `theme.css:377`, `shell-b-style.css:62,151` |
| Settings layout | `#app.cs-on`, `.cs-aside`, `.cs-nav`, `.cs-search`, `.cs-savebar`, `.cs-flash` | 232px grouped left nav + content (max 1120px); sticky "unsaved changes" bar; search flashes target card | `control-split.css` |
| Privacy mask | `html.hb-priv-on` on `.hbp-m`/`[data-money]` | "Hide amounts": visual blur only, values unchanged | `shell-b-privacy.css` |

## 6. Navigation

- Desktop: rail + top bar; breadcrumb `#helmTrail` (hidden on dashboard) from `nav-trail.js` (`shell-b.css:106`, `shell-b-dash.css`).
- Phone (<820px): rail becomes an off-canvas drawer (`min(280px,86vw)`) opened by `.hb-burger` with a 40% scrim; labels always visible (`shell-b.css:140-152`).
- Phone (<768px): bottom tab bar from `mobile-nav.js` (`body.hmn-on`); Chat moves into the tab bar (`shell-b.css:275-276`).
- Keyboard shortcuts sheet: grouped and filterable (`shell-b-style.css:179`); hint hidden on phones.
- What appears in the rail is driven by role/area access (RBAC matrix, `has_area`). Assumption: rail item visibility mirrors the server `has_area` check, with RLS as the real gate.

## 7. Forms

- Inputs: shell-b gives 8px radius and white fill; focus = accent border + `--focus-halo` (3px accent at 24%) (`shell-b-pages.css`, `shell-b-style.css`).
- Validation: `.fv-ok` adds a green tick icon; `.fv-msg` shows the error text in red; `[aria-invalid="true"]` styling excluded from neutral reset (`theme.css:47, 426-433`). Shared validators + global number hardener (memory: Wave 16).
- Settings forms batch changes behind the sticky save bar (`control-split.css:69`).

## 8. Loading, empty and error states

| State | Pattern | Source |
|---|---|---|
| First load | 2px accent shimmer at top + blueprint intro mark `#hb-ld` until `html.hb-loaded`; also while `html.auth-pending` | `shell-b-loader.css` |
| Header guard | Old header hidden until shell converts it; safety timeout adds `hb-ready` so a JS error never leaves a page headless | `shell-b-boot.css` |
| Page boot skeleton | `<div id="boot" aria-busy="true">` shows two shimmer blocks | `theme.css:61-76` |
| Section skeleton | `.sb-skel` / `.sb-skel-sm` (two bars), `.hd-skel` shimmer | `shell-b-style.css:88-102`, `shell-b-dash.css:377` |
| Empty | `.empty`, `.emptystate`, `.emptylist`, `.colempty`, `.bpb-empty` — padded, "an invitation to act, not a dead end" | `theme.css:335`, `shell-b-style.css:106,177` |
| Error / success messages | `.msg.err`/`.lerr`, `.msg.ok`/`.lok`, `.offline`, `#conflictBanner` | `theme.css:210-223` |
| Entrance | Staggered `.hd-in` rise (50ms steps); `hb-settled` stops replay to avoid flicker | `shell-b-dash.css:386`, `shell-b-boot.css` |

## 9. Interactions and animation

Durations: fast 140ms, normal 220ms, slow 420ms (`--hd-t-*`); rail 150ms. Patterns: button lift on hover, KPI tick (180ms), bar grow (700ms), today-node pulse (once), save-bar slide up (180ms), search-result flash (1.2s). All are turned off by `@media (prefers-reduced-motion: reduce)` in `shell-b.css`, `shell-b-dash.css`, `shell-b-style.css`, `control-split.css`, `theme.css`.

## 10. Responsive rules

| Breakpoint | Change | Source |
|---|---|---|
| ≤900px | Search trigger collapses to icon | `shell-b.css:136` |
| ≤819px | Rail → drawer; body padding 0; "+ New" label hidden; account menu as bottom sheet; search full-screen | `shell-b.css:140`, `shell-b-boot.css`, `shell-b-search.css` |
| ≤820px | Control Center collapses to one column | `control-split.css:80` |
| ≤767px | Phone tab bar, page tweaks | `shell-b-pages.css:46,67`, `mobile-nav.js` |
| ≤600 / ≤480px | Smaller page adjustments | `shell-b-pages.css` |
| Dashboard | Container queries (`container-name: hd`) | `shell-b-dash.css:59` |
| Tables | Card-style tables on mobile | `tables-mobile.css/js` |
| Touch | `@media (hover:none)` shows rail favourites star always | `shell-b.css:254` |

Safe-area insets respected for bottom popovers (`env(safe-area-inset-bottom)`). Day rows keep ≥44px touch height (`shell-b-dash.css:221`).

## 11. Accessibility

- Skip link `.skip-link` → `#main` (`theme.css:30-37`).
- Visible `:focus-visible` ring on links, buttons, inputs, `[tabindex]`, `[role=button]` (`theme.css:105-108`).
- Rail opens on `:focus-within`, so it works by keyboard; pin uses `aria-pressed`.
- `forced-colors` support for search results (`control-split.css:28`).
- Contrast: text tokens documented ≥4.5:1; `--line-strong` for control borders ≥3:1 (`theme.css` comments).
- Reduced motion honoured everywhere (see §9).
- Plan: `docs/STAGING-A11Y-PERF-PLAN.md`. Decision needed: run a full WCAG 2.2 AA pass on the Emerald theme now that it is the only live mode.

## 12. Page-level layout guidance (for new pages)

1. Load order: `theme.css` → `shell-b-boot.css` (via `shell-proto.js`) → `shell-b.css` → `shell-b-pages.css` → `shell-b-style.css` → theme files → page `*-polish.css`.
2. Use only tokens (`--hb-*` or bridged `--accent/--ink/--panel/--line`, `--sp-*`, `--fs-*`, `--r-*`). Never hard-code colours, so all themes work.
3. Put content in `#main`, max ~1200px (dashboard 1360px, settings 1120px), 24-32px side padding.
4. Lists/dashboards: 12-col grid, wide lane + side lane; collapse to one column on phones.
5. Settings-style pages: reuse the Control Center split (`#app.cs-on`) with the sticky save bar.
6. Mark every amount with `data-money` or `.hbp-m` so "Hide amounts" works and themes don't recolour it.
7. Always provide skeleton, empty and error states; respect reduced motion.
8. The floor-plan builder (`builder*.css`) is excluded from shell-b styling (`shell-b-style.css` header) and keeps its own look.

## Decisions needed
- Remove dormant dark-mode CSS or keep it for re-enable.
- Ship or delete the Luxe theme (in CSS, not in picker).
- Whether the marketing site (Instrument Serif / Plus Jakarta) and app (IBM Plex / Fraunces) should share one type family.
