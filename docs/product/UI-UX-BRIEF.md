# Helm — UI/UX Design Brief

| Field | Value |
|---|---|
| Document | UI/UX Design Brief and design-system reference |
| Product | Helm — multi-tenant event-management SaaS for event studios (web app, phone + laptop) |
| Version | 1.0 — 2026-10-16 |
| Source of truth | `public/shell-b.css`, `public/shell-b-theme-studio.css`, `public/shell-b-theme-luxe.css`, `public/theme.css`, `public/ui-kit.css` + `ui-kit.js`, `public/status-pills.css`, `public/tables-mobile.css`, `public/shell-b-privacy.css`, `public/shell-b-loader.css`, `public/public-pages-v2.css`, `public/home.css`, `public/tour.js`, `public/shell-b.js` |
| Owner | [OWNER TO FILL] |
| Related | `PRD.md`, `TRD.md`, `BACKEND-SCHEMA.md`, `USER-MANUAL.md` |

This brief tells a designer or engineer how Helm looks, feels and behaves, and lists the exact design tokens as they exist in the code today. When this document and the CSS disagree, **the CSS wins** and this document should be updated.

---

## 1. Brand

| Element | Definition |
|---|---|
| Name | **Helm** (domain `helm.events`) — "take the helm of every event" |
| Positioning | The operating system for event studios: from enquiry to quote, floor plan, crew, stock, money and close-out in one place |
| Audience | Studio owners and admins (laptop, office), event managers / planners / sales (laptop + phone), crew and workers (phone, often outdoors, signed-out work link), clients (phone, signed-out approval link / booklet / invitation site) |
| Personality | Calm, competent, precise, warm. A senior event manager who has seen everything — never flashy, never anxious |
| Markets | India (INR, GST), UAE (AED, VAT), USA (USD, sales tax); UK and others via country profile (labels and tax names change, layouts do not) |
| Logo | Rounded-square mark (34 px, radius 9 px) filled with the theme "on" colour, white letter/mark; wordmark weight 650, 15 px in the rail. Loader mark is a self-drawing blueprint SVG (`HB_MARK` in `shell-proto.js`) |
| Marketing look | Emerald on warm off-white, editorial serif headline + friendly sans (see §4.3) |

---

## 2. Design principles

1. **The job, not the tool.** Every screen answers "what must I do next for this event?" Primary action first, top-right on laptop, sticky bottom on phone.
2. **One event, one truth.** The quote *is* the event; every page shows the same event code, client and status pill. Money shown anywhere comes from the server (no client-side recalculation for display totals).
3. **Calm by default, loud only when it matters.** Neutral surfaces, one accent per theme. Green / amber / red / blue are reserved for status (safe / warn / bad / info) and never used decoratively.
4. **Forgiving.** Destructive actions use confirm or undo (5 s undo window); money and stock records are cancelled, never deleted. Errors say what happened and what to do.
5. **Phone-first for the field, laptop-first for the office.** Crew and client surfaces are designed at 360 px first; studio back-office is designed at 1280 px and must still work at 360 px (tables become cards).
6. **Accessible is the baseline.** WCAG 2.2 AA everywhere, including dark mode and every theme.
7. **Fast feels trustworthy.** Skeletons not spinners, optimistic UI with undo, motion only as feedback.
8. **Privacy in public.** Studios present Helm in front of clients: "Hide amounts" masks money with one tap.

---

## 3. Layout and shell ("Shell B")

| Part | Spec |
|---|---|
| Activation | `html[data-shell="b"]`; theme `html[data-hb-theme="cobalt|midnight|emerald|graphite|studio"]`; mode `html[data-theme="light|dark"]` (unset = follow OS) |
| Rail (left nav) | Collapsed `--hb-w: 68px`, expanded/pinned `--hb-wx: 240px`; expands on hover/focus-within; pin button persists. Groups with 10.5 px uppercase headings; items 40 px tall, radius 10 px, 20 px stroke icons (1.7 px stroke) |
| Top bar | `--hb-top: 60px`; search (Cmd/Ctrl+K palette), bell, chat, account menu |
| Rail footer | Recently viewed, Guided tour button, theme swatch picker, account. On windows < 1100 px tall, Recent + Tour move into the scrolling nav |
| Phone (≤ 819 px) | Rail becomes a drawer (burger + scrim); keyboard hints hidden; account menu becomes a bottom sheet (12 px side insets, 76 px from bottom) |
| Content width | Fluid; cards on a 4 px grid; max line length ~75 ch for prose |
| Easing | `--hb-ease: cubic-bezier(.22,1,.36,1)` (shell), `--ease-out: cubic-bezier(.2,.7,.2,1)` (pages) |

---

## 4. Colour and themes

### 4.1 App themes (picker in the rail: Cobalt, Midnight, Emerald, Graphite, Studio)

Shell tokens (`--hb-*`). `bg` = panel/rail surface, `bg2` = page background, `line` = hairline, `ink/ink2/ink3` = text primary/secondary/tertiary, `acc` = primary action fill, `acc2` = hover / secondary accent, `acc-ink` = text on accent, `acc-soft` = selected/tinted background, `acc-text` = accent used as text.

**Light**

| Token | Cobalt (default) | Midnight | Emerald | Graphite | Studio |
|---|---|---|---|---|---|
| `--hb-bg` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` | `#FAF8F5` |
| `--hb-bg2` | `#f5f7fc` | `#f5f5fb` | `#f4f8f6` | `#f6f6f5` | `#F4F1EC` |
| `--hb-line` | `#e3e8f2` | `#e4e4f0` | `#e0eae5` | `#e6e6e3` | `#E7E2DA` |
| `--hb-ink` | `#0b1b3f` | `#12133a` | `#0b2a22` | `#111111` | `#1F1A24` |
| `--hb-ink2` | `#34405c` | `#3a3c5e` | `#2f4a42` | `#3a3a3a` | `#4A4351` |
| `--hb-ink3` | `#5f6b88` | `#62658a` | `#5a7068` | `#6e6e6a` | `#6E6676` |
| `--hb-acc` | `#2450f0` | `#4338ca` | `#047857` | `#111111` | `#5B2A86` |
| `--hb-acc2` | `#4a72ff` | `#6157e8` | `#10a37a` | `#3a3a3a` | `#4A1F70` |
| `--hb-acc-ink` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` | `#FFFFFF` |
| `--hb-acc-soft` | `#eaeffe` | `#eeedfc` | `#e3f4ed` | `#ececea` | `#F1EBF7` |
| `--hb-acc-text` | `#1d44d8` | `#3f34c2` | `#036b4d` | `#111111` | `#5B2A86` |

**Dark**

| Token | Cobalt | Midnight | Emerald | Graphite | Studio |
|---|---|---|---|---|---|
| `--hb-bg` | `#111833` | `#14152f` | `#0f1f1c` | `#161616` | `#141216` (surface `#1C1A1F`) |
| `--hb-bg2` | `#0a0f1e` | `#0b0b1c` | `#081311` | `#0e0e0e` | `#242128` |
| `--hb-line` | `#243056` | `#272a52` | `#1f3a33` | `#2a2a2a` | `#2F2B33` |
| `--hb-ink` | `#e8edfb` | `#ebebfa` | `#e6f4ef` | `#f2f2f2` | `#F3F0F5` |
| `--hb-ink2` | `#b9c3de` | `#c0c1e0` | `#b5d0c7` | `#cfcfcf` | `#CFC9D4` |
| `--hb-ink3` | `#8e9aba` | `#9294bb` | `#86a59b` | `#999999` | `#A39CAB` |
| `--hb-acc` | `#3d63f5` | `#5b52e6` | `#08795a` | `#f2f2f2` | `#B794E0` |
| `--hb-acc2` | `#6d8cff` | `#8a83ff` | `#34d399` | `#d4d4d4` | `#C9AEE9` |
| `--hb-acc-ink` | `#ffffff` | `#ffffff` | `#ffffff` | `#111111` | `#141216` |
| `--hb-acc-soft` | `#1a2550` | `#221f52` | `#123329` | `#242424` | `#2A2233` |
| `--hb-acc-text` | `#93acff` | `#a9a4ff` | `#5fe0b0` | `#f2f2f2` | `#B794E0` |

Studio also defines status tokens: light ok `#2F7D57` / warn `#A86B12` / risk `#B3261E` (tints `#EAF4EE`, `#FBF2E3`, `#FBEAE8`); dark ok `#6FCF97` / warn `#E6B35C` / risk `#F2827A`. Studio uses **Plus Jakarta Sans** as its font.

**Measured contrast (WCAG 2.x ratio)** — all pass AA for body text:

| Theme | ink on bg | ink3 on bg | text on accent button | accent-as-text on bg |
|---|---|---|---|---|
| Cobalt L / D | 16.9 / 14.9 | 5.3 / 6.2 | 6.0 / **4.9** | 7.3 / 8.0 |
| Midnight L / D | 17.8 / 15.1 | 5.6 / 6.1 | 7.9 / 5.5 | 8.5 / 8.0 |
| Emerald L / D | 15.4 / 15.0 | 5.3 / 6.4 | 5.5 / 5.4 | 6.5 / 10.4 |
| Graphite L / D | 18.9 / 16.2 | 5.1 / 6.4 | 18.9 / 16.9 | 18.9 / 16.2 |
| Studio L / D | 16.1 / 16.5 | 5.2 / 7.0 | 9.9 / 7.4 | 9.3 / 7.4 |

Theme persistence: `localStorage["helm.shellb.theme"]` (per browser). Dark mode: explicit toggle or OS `prefers-color-scheme` when unset.

**Note — Luxe.** A sixth theme, *Luxe* (ivory `#f7f3ea` / ink `#1b1814` / oxblood `#6b1e24`, dark accent `#d29a96`; Cormorant Garamond + Inter Tight; 2 px radii), exists in `shell-b-theme-luxe.css` and in the public-page palettes but is **not offered in the picker**. Decision needed: ship or retire. [OWNER TO DECIDE]

### 4.2 Public / client-facing pages

`public-pages-v2.css` mirrors the same five (+Luxe) palettes under `html[data-pt="…"]`, so the client approval page, booklet, portal and invitation site follow the **studio's** chosen theme, with light and dark variants. Extra semantic tokens: `--yes #0d7a3c`, `--part #9a5b00`.

### 4.3 Marketing site (emerald, light)

From `home.css`: background `#f5f6f1`, alt `#eef1ea`, ink `#101511`, muted `#5a6159`, hairline `rgba(16,21,17,.09)`, accent `#0d8a5c`, accent-dark `#08603f`, accent-light `#b8f0d3`, accent-soft `#e3f5ec`, card `#fff`. Shadows tinted green (`rgba(20,48,34,…)`). Fonts: **Instrument Serif** (display), **Plus Jakarta Sans** (UI/body), Caveat (hand-note accents only). Nav height 72 px.

> **Finding:** white text on `#0d8a5c` is **4.37:1** — passes only as *large* text (≥ 24 px regular or ≥ 18.66 px bold). Keep marketing buttons at ≥ 18.66 px bold or use `#08603f` (accent-dark) for button fills with small text.

### 4.4 Status colours (one language app-wide)

Pills come from `ui-kit.css` / `status-pills.css` (`.hs-pill`, 22 px high, full radius, 12 px / 600, 6 px leading dot).

| Tone | Light bg / fg | Dark bg / fg | Statuses mapped |
|---|---|---|---|
| draft (grey) | `#eef0f4` / `#4b5565` | `rgba(160,170,190,.16)` / `#c3cad8` | draft, new, enquiry, open, requested, unassigned, dormant |
| sent (blue) | `#e6efff` / `#1d4ed8` | `rgba(80,130,255,.18)` / `#a9c0ff` | sent, assigned, invoiced, booked, reserved, allocated, active, in_progress |
| due (amber) | `#fff4dc` / `#8a5a00` | `rgba(240,170,40,.18)` / `#ffd27a` | pending, due |
| ok (green) | `#e3f6ea` / `#12703a` | `rgba(63,185,80,.16)` / `#7fe39a` | confirmed, approved, accepted, completed, done, resolved, delivered, returned, won |
| paid (dark green) | `#d6eedd` / `#0c5a2a` | `rgba(25,120,60,.34)` / `#b4f3c8` | paid |
| bad (red) | `#fdeaea` / `#b42318` | `rgba(240,90,90,.18)` / `#ffa3a3` | rejected, cancelled, overdue, no |
| muted (outline) | transparent, ink3 text, line border | same | archived, closed, waived |

Status is never colour-only: every pill carries its word (WCAG 1.4.1).

---

## 5. Typography

| Use | Family | Notes |
|---|---|---|
| App UI (default themes) | **IBM Plex Sans** 400/500/600/700 | Rail items `500 13.5px/1.2` |
| Numbers / codes | **IBM Plex Mono** 400–600 | Event codes, receipts; tables and money use `font-variant-numeric: tabular-nums` |
| Dashboard display | Fraunces (opsz) | Greeting / large KPI headings only |
| Studio theme | Plus Jakarta Sans | Whole UI |
| Luxe theme | Cormorant Garamond (display) + Inter Tight (UI) | Not in picker |
| Marketing | Instrument Serif + Plus Jakarta Sans | See §4.3 |
| Emoji flags | Apple / Segoe / Noto Color Emoji | Country pickers |

**Type scale** (1.2 minor third on 14 px base, `theme.css`): `--fs-xs 12`, `--fs-sm 13`, `--fs-base 14`, `--fs-md 16`, `--fs-lg 19`, `--fs-xl 23`, `--fs-2xl 28` px. Inputs on phone are ≥ 16 px to stop iOS zoom. Headings use `text-wrap: balance`; paragraphs avoid widows.

---

## 6. Spacing, radius, elevation

| Scale | Values |
|---|---|
| Spacing (4 px grid) | `--sp-1 4` · `--sp-2 8` · `--sp-3 12` · `--sp-4 16` · `--sp-5 24` · `--sp-6 32` · `--sp-7 48` px |
| Radius | controls `--r-ctl 9px`, cards/modals `--r-card 14px`, pills `--r-pill 999px`; rail items 10 px; logo 9 px; Luxe 2 px |
| Elevation (light) | `--elev-sm 0 1px 2px rgba(27,25,48,.06)` rest · `--elev-md` + `0 8px 24px rgba(27,25,48,.10)` hover/popover · `--elev-lg 0 2px 6px …, 0 24px 64px rgba(27,25,48,.18)` modal. Shadows tinted to ink, never pure black on light |
| Elevation (dark) | `0 1px 2px rgba(0,0,0,.5)` · `…0 10px 28px rgba(0,0,0,.6)` · `…0 28px 72px rgba(0,0,0,.75)` |
| Focus | 2 px accent outline + 2 px offset; text fields add `--focus-halo` (3 px accent-soft ring) |
| Touch targets | ≥ 44 × 44 px on phone (rail items 40 px tall inside 48 px rows; buttons min 44 px under `pointer: coarse`) — WCAG 2.5.8 minimum is 24 × 24 |

---

## 7. Components inventory

| Component | Source | Spec / behaviour |
|---|---|---|
| **Buttons** | page CSS + `ui-kit.css` (`.hs-btn`, `.hs-btn-primary`) | Primary = accent fill + `acc-ink` text; secondary = panel + line border; danger = red text/border, filled only inside the confirm dialog. Height 36–40 px (44 px on touch). One primary per view |
| **Inputs / selects** | page CSS, `form-validate.js`, `phone-input.js` | 36–40 px, radius 9, `panel-2` fill, line border; label above; inline error under field in `--bad-text`; phone input with country flag + E.164; number hardener blocks invalid characters |
| **Pills / status** | `ui-kit.js statusPill()`, `status-pills.css` | §4.4 |
| **Cards** | `--panel`, `--r-card`, `--elev-sm`; hover `--elev-md` only when clickable |
| **Tables → mobile cards** | `tables-mobile.css` / `tables-mobile.js` | Below 640 px, `table.tm-stack` rows become cards: `td[data-label]` shows label on the left (max 45 %), `.tm-primary` becomes the card title, `.tm-actions` a full-width action row. Never horizontal-scroll a data table on phone |
| **Toasts** | `HelmUI.toast(msg, {type, action, timeout})` | Region `role=region aria-label=Notifications`; `role=status` (info/success), `role=alert` (error). Auto-dismiss 4 s (8 s for errors); optional action button; × dismiss |
| **Confirm dialog** | `HelmUI.confirm(opts)` → Promise<boolean> | Modal with title, body, Cancel + Confirm; Esc / backdrop = cancel; focus trapped and returned |
| **Undo** | `HelmUI.undoable({message, run, undo, ms, mode})` | Default `defer` mode: action runs after 5 s unless *Undo*; `immediate` mode runs now and calls `undo()`. Failure shows "That didn't save. Please try again." |
| **Empty states** | `HelmUI.emptyState({icon, title, text, actionLabel})` | Centred, 40 px padding, one sentence why it is empty + one primary action |
| **Skeletons / loader** | `shell-b-loader.css`, page `*-polish.css` | 2 px accent shimmer bar while loading; branded blueprint intro on first load; staggered block entrance after `.hb-loaded`; content skeletons match final layout to avoid CLS |
| **Guided tour** | `tour.js` | Per-page steps keyed by filename; rail "Take a guided tour" button on every page; page's own `#helpBtn` wins; generic shell tour fallback |
| **Rail badges** | `.hb-badge`, `.hb-cnt` | Count badge 18 px pill top-right of icon; collapsed rail shows an 8 px dot; hidden at zero |
| **Bell (notifications)** | shell + `notifications` / prefs / mutes | Unread count badge; list with deep links (task id etc.); per-type "Mute this type"; admin-managed per-role preferences |
| **Chat** | `chat.html`, `.hb-chat` | WhatsApp-style DMs, groups, event groups, org-wide "Everyone"; @mentions; reactions; attachment cards (quote, floor plan), images and voice notes; read state |
| **Search palette** | `studio-search.js` | Cmd/Ctrl+K; grouped results by record type, keyboard navigable |
| **Saved views** | `saved-filters.js` | Save a list page's filters by name |
| **Theme picker** | `shell-b.js` | Swatch popover, `aria-pressed` on current, Esc closes, focus returns |
| **Privacy mode** | `shell-b-privacy.js/.css` | §10 |
| **Breadcrumb / trail** | `nav-trail.js` | Event code › page |
| **Builder (2D/3D)** | `builder.css`, `builder-3d.js` | Canvas tools; its own toolbars follow shell tokens |

---

## 8. Motion

| Rule | Value |
|---|---|
| Purpose | Motion only responds to a user action or explains a change of state; no ambient animation inside the app |
| Durations | 120–180 ms for hover/press/toggle; rail expand 150 ms; label fade 120 ms; toast enter ≤ 200 ms; page block stagger ≤ 400 ms total |
| Easing | `--ease-out cubic-bezier(.2,.7,.2,1)`; shell `cubic-bezier(.22,1,.36,1)` |
| Properties | Animate `opacity` and `transform` only (no layout properties) |
| Reduced motion | Every animated stylesheet has a `@media (prefers-reduced-motion: reduce)` block (≈ 67 blocks across 47 files) that removes transitions, the loader intro and stagger; content appears instantly |
| Marketing | Richer motion allowed (scroll reveals, floating notes) but still fully disabled under reduced motion |

---

## 9. Accessibility (target: WCAG 2.2 Level AA)

| Area | Requirement |
|---|---|
| Contrast | Text ≥ 4.5:1 (large ≥ 3:1); UI boundaries / focus ≥ 3:1 (`--line-strong`); use `--warn-text #8f5f00` / `--safe-text #0f7a43` when status colours are used as text |
| Keyboard | Everything reachable by Tab; visible focus (2.4.7) and focus not obscured by sticky bars (2.4.11); Esc closes popovers/dialogs; Cmd/Ctrl+K search |
| Target size | ≥ 24 × 24 px minimum (2.5.8); Helm standard 44 px on touch |
| Dragging | Every drag (builder, dashboard blocks) has a click/keyboard alternative (2.5.7) |
| Forms | Labels, `autocomplete`, inline errors linked with `aria-describedby`; do not ask for the same info twice (3.3.7 Redundant Entry); OTP/login without cognitive tests, paste allowed (3.3.8 Accessible Authentication) |
| Help | Help (tour button, manual link) in the same place on every page (3.2.6 Consistent Help) |
| Live regions | Toasts `status` / `alert`; counters announced politely |
| Semantics | Landmarks (`nav`, `main`), headings in order, `aria-expanded`, `aria-pressed`, `aria-haspopup` on menus |
| Media | Alt text on images; voice notes have duration and a text fallback where possible |
| Language | `lang` on `<html>`; numbers and currency formatted per studio locale |
| Testing | axe/Lighthouse in CI (`lighthouserc.json`), manual screen-reader pass (VoiceOver iOS/macOS, TalkBack, NVDA) per release |

---

## 10. Privacy mode ("Hide amounts")

For presenting Helm in front of clients. Toggle in the shell; default **hidden** until the user chooses to show. Every element marked `.hbp-m` or `[data-money]` gets transparent text with a `••••` overlay on a soft ink tint and is unselectable. It is a *privacy screen, not security*: values remain in the page and account. Themes must never recolour `[data-money]` / `.hbp-m`.

---

## 11. Responsive breakpoints

| Breakpoint | Behaviour |
|---|---|
| ≤ 400 / 420 px | Small phones: single column, compact headers |
| ≤ 480 / 560 px | Phones: stacked form rows, full-width buttons |
| **< 640 px** | **Tables become cards**; dialogs become full-width sheets |
| ≤ 720 / 768 px | Large phones / small tablets: two-column grids collapse |
| **≤ 819 px** | **Shell switches to drawer navigation**; bottom-sheet account menu; keyboard hints hidden |
| ≤ 1023 px | Tablet: dashboard grid reduces columns |
| ≤ 1280 px | Laptop: side panels narrow |
| > 1280 px | Desktop: full dashboard, pinned rail recommended |
| Height < 1100 px | Rail footer tools move into scroll area |
| `pointer: coarse` | Larger hit areas, no hover-only affordances |
| `print` | Quotes, booklets and run sheets have print styles |

Test matrix: 360 × 800 (Android), 390 × 844 (iPhone), 768 × 1024, 1280 × 800, 1440 × 900, 1920 × 1080; light + dark; each of the five themes.

---

## 12. Content and voice

| Do | Don't |
|---|---|
| Plain words, short sentences ("Record payment", "Send to client") | Jargon or system words ("Persist entity", "RPC failed 42501") |
| Verb-first buttons naming the outcome | "OK", "Submit", "Yes" on destructive dialogs |
| Say what happened and what to do next ("That didn't save. Please try again.") | Blame the user or show raw errors |
| Sentence case everywhere | Title Case Or ALL CAPS (except rail group headings) |
| Use the studio's country terms: GST / VAT / Sales tax, GSTIN / TRN / EIN, ₹ / AED / $ | Hard-coded rupees or +91 |
| Event code + client name to identify an event | Internal UUIDs |
| Dates in the studio's time zone, unambiguous (16 Oct 2026) | 10/16/26 |
| Plain ASCII in server messages (no long dashes that break on copy/paste) | Smart punctuation in SQL error texts |

Tone shifts: celebratory but brief on success ("Booking confirmed"), calm and specific on errors, warm on empty states, formal on client-facing legal/consent text.

---

## 13. Iconography

- Single outline set drawn inline as SVG: 20 × 20 viewBox, `stroke: currentColor`, stroke-width 1.7, round caps and joins, no fill (`.hb-svg`). 16 px variant for small buttons.
- Icons always paired with a text label (rail labels appear on expand; collapsed rail has `aria-label` + tooltip).
- Colour inherits from text; accent only for the active item.
- No emoji as UI icons (emoji only for country flags).
- Built with `createElementNS` (CSP- and Trusted-Types-safe; no `innerHTML`).

---

## 14. Dos and don'ts

| Do | Don't |
|---|---|
| Use tokens (`--hb-*`, `--panel`, `--ink`, `--accent`…) | Hard-code hex values in page CSS |
| One accent per view; status colours only for status | Gradients/decoration on status colours or money |
| Confirm or undo every destructive action | Hard-delete money, stock or bill records |
| Design phone layouts for crew/client pages first | Rely on hover for essential actions |
| Keep money in tabular numerals, marked `data-money` | Recolour or restyle `[data-money]` in themes |
| Test every screen in all five themes × light/dark | Ship a component checked only in Cobalt light |
| Use skeletons that match final layout | Full-page spinners that shift layout |
| Keep focus visible and in view | Remove outlines |

---

## 15. Gaps and recommendations

| # | Item | Priority |
|---|---|---|
| 1 | Decide Luxe theme (ship in picker or remove file) | Low |
| 2 | Marketing accent button 4.37:1 — use bold ≥ 18.66 px or darker fill | Medium |
| 3 | Theme choice is per-browser (`localStorage`); consider saving to `user_dashboard_prefs` so it follows the user across devices | Medium |
| 4 | Legacy `theme.css` dark palette uses violet `#a78bfa` accent for pages outside Shell B; converge to theme tokens | Medium |
| 5 | Publish a living component gallery page (all components × themes) for QA | Medium |
| 6 | Formal screen-reader audit report per release | [OWNER TO FILL owner/date] |
| 7 | RTL (Arabic for UAE) not yet supported — logical CSS properties needed before Arabic locale | Future |

---

## References

- W3C — Web Content Accessibility Guidelines (WCAG) 2.2: https://www.w3.org/TR/WCAG22/
- W3C — What's new in WCAG 2.2: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- W3C WAI-ARIA Authoring Practices Guide (dialog, menu, toast patterns): https://www.w3.org/WAI/ARIA/apg/
- MDN — `prefers-reduced-motion`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- MDN — `prefers-color-scheme`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme
- Material Design 3 — Design tokens and color roles: https://m3.material.io/foundations/design-tokens/overview
- Apple Human Interface Guidelines — Accessibility / layout (44 pt targets): https://developer.apple.com/design/human-interface-guidelines/accessibility
- GOV.UK Design System — writing for user interfaces and error messages: https://design-system.service.gov.uk/
- Nielsen Norman Group — 10 Usability Heuristics: https://www.nngroup.com/articles/ten-usability-heuristics/
- Design Tokens Community Group format: https://www.designtokens.org/
- Repository sources listed in the header table.
