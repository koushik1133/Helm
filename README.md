# Blueprint Stage — 2D Event Layout & Blueprint Builder

An interactive, to-scale **2D drag-and-drop floor-plan builder** for events —
political rallies, conferences & expos, weddings & galas, and outdoor festivals.
Drop stages, podiums, seating blocks, barricades, press risers, expo booths and
more onto a scaled floor; drag, rotate, resize, and snap them to a grid; then
save, reopen, and export your layout.

Full-stack: a single-file vanilla-JS front end backed by a **zero-dependency
Node REST API** that persists layouts to disk.

---

## The event management platform (what each phase added)

Blueprint Stage began as a floor-plan builder. It now runs a full event
workflow on top of the same app, backed by **Supabase**. Everything for one
event lives on **one calm page** so the user is never overwhelmed. Here is
what each phase added, in plain words.

### The main flow (how to use it)

1. Open the **home page** and sign in.
2. Go to **Leads** and click **＋ New lead** to save an enquiry — name, phone,
   budget, event type.
3. **Drag the card** across the pipeline as the deal grows
   (New → Qualified → Discovery → Quoted → Won / Lost), or **click a card** to
   view, edit or delete it.
4. When it is real, click **Convert →**. This turns the lead into an **event**
   and opens its **Workspace**.
5. In the Workspace, follow the steps at the top —
   **Discovery → Proposal → Quote → Confirm → Plan …** — each step has a card
   that opens the right tool.

### What each phase added

- **Phase 1 — Event Workspace.** One page per event (`event.html?id=`). It
  shows the event details, a step-by-step lifecycle bar, and a card for each
  tool (floor plan, quote, approval, tasks). All the numbers are read **live**
  from the database. The **Advance** button saves the current step.

- **Phase 2 — Leads & pipeline.** A CRM board. Add a lead, **drag it** between
  columns, **undo / redo**, **click** a card to view / edit / delete, and
  **Convert** a lead into a real event. Changes save to Supabase and update
  **live** for everyone viewing.

- **Phase 2b — CRM archive.** Every lead is automatically copied to a safe
  archive on **create, edit, convert and delete**. The copy **stays even if the
  lead is deleted**. See it on the **CRM archive** page. It is read-only.

- **Phase 3 — Discovery & requirements.** For each event, record the discovery
  meeting (date, mode, notes), a **budget range**, and a list of requested
  services tagged **Must-have / Optional / Nice-to-have**. The Workspace shows
  this next to the Quote card, so you price from real needs.

- **Phase 4 — Proposal & mood-board.** Build a concept page for the client:
  theme, **colour palette**, reference images, and what's included. Click
  **Publish** to get a **private link** the client opens with **no login**.
  Unpublished proposals cannot be opened. There is also an internal
  **risk checklist** (never shown to the client).

- **Phase 5 — MVP checkpoint.** Polished and tested the whole path from lead to
  workspace. A converted lead now opens on the **Discovery** step so the flow
  reads naturally. This completes the working MVP.

- **Phase 6 — In-house staff directory** *(start of Resource Management)*. A
  **Staff** page where you keep your own team: name, **role**, **department**,
  **skills**, employment type, phone/email and an optional day rate. Search and
  filter by department or skill, and mark people active/inactive. The idea: plan
  your in-house people first, and only reach for outside vendors or freelancers
  for the gaps.

### Where the data lives

All of this is stored in **Supabase**. The SQL is in `supabase/` — one file per
phase (`phase1-workspace.sql`, `phase2-leads.sql`, …) — and everything together
in **`supabase/full-schema/complete-setup.sql`** (run once on a fresh database).
See `supabase/full-schema/README.md` for the exact run order.

---

## Quick start

```bash
cd "2d view"
npm start
# → Blueprint Stage running →  http://localhost:4173
```

Open <http://localhost:4173>. No `npm install` needed — the server uses only
Node's standard library (Node 18+).

Set a different port with `PORT=8080 npm start`.

---

## Features

**Canvas & scale**
- 200 × 140 ft floor at 12 px/ft, with top + left **rulers** and a live cursor readout.
- **Snap-to-grid** engine, switchable between **feet** and **meters** (1-unit cells, major lines every 10).
- Zoom (buttons, `FIT`, and ⌘/Ctrl-scroll), pan, and a live status bar.

**Objects** — every item carries `{ id, type, category, x, y, width, height, rotation, label, color, properties }`
- **Drag** to move, corner handles to **resize**, top handle to **rotate** (0–359°, snaps to 15° when snap is on).
- **Inspector** (right panel) shows and edits exact X/Y, width/height, rotation, label, category color, and type-specific props.
- **Seating is adjustable**: chair rows and seating blocks take **rows × cols**; round tables take **seats around** + diameter — the chairs redraw live.
- Duplicate, bring-to-front, center, delete. Keyboard: arrows nudge, `Shift`+arrows nudge ×5, `R` rotates, `D` duplicates, `Del` removes, `Esc` deselects.
- **Multi-select**: drag on empty floor for a **marquee/rubber-band** selection, **Shift/⌘-click** to add or remove, **⌘A** select all. Selected objects **move, nudge, rotate, duplicate and delete as a group**, with **⌘C / ⌘V** copy-paste (across events too, via localStorage). The inspector shows a group panel with **Align & Distribute** (left/center/right, top/middle/bottom, distribute across/down).

**Templates** — 12 one-click layouts, grouped by event type (3 subtypes each):
- **Political / Rally** — theatre seating · town hall (round tables) · arena (3-sided stands).
- **Conference & Expo** — expo hall (booth grid) · keynote theatre · classroom / breakout.
- **Wedding & Gala** — ceremony (canopy + aisle) · banquet + dance floor · cocktail reception. *(Evocative layouts with no religious naming.)*
- **Outdoor Festival** — main stage + food lane · two-stage festival · open-air market.

**✨ Custom Event builder** — a header button opens a form (event type, expected guests, seats per table, aisle width, bars, food trucks, expo booths, restrooms, exits, plus toggles for stage / canopy / dance floor / head table / buffet / lounge / press / fence — **everything optional**). It procedurally generates **3 tailored layout variants** as cards, each showing **all counts** (chairs, tables, booths, bars, exits, objects); click one to drop it on the floor. Deterministic — no external AI, works offline. The guest count drives the number of tables/seat rows, and every count is preserved and shown.

**Live counts** — the status bar always shows total **seats** and **tables**; the generator cards show a full count breakdown.

**Capacity & congestion** — set the venue's **max capacity** in the header and the meter shows seats-placed vs the limit (green → amber near 90% → red over 100%), with a warning banner. Seating blocks whose chair spacing drops below a comfortable gap are flagged **congested** — chairs tint amber (tight) then red (packed) in **both 2D and 3D** — so you can *show a client* how crowded an over-filled room will actually look.

**Equidistant seating** — a seating block's **Rows / Cols / Spacing** keep chairs at a constant gap: changing a count adds/removes chairs and resizes the block instead of squeezing the spacing.

**Autosave** — after a layout has been saved once (or opened), edits autosave ~2.5 s later (the Save button shows "✓ Saved"). Dense seating blocks are dot-capped in 2D for smooth rendering.

**Asset toolbox (36 types)** across 6 categories, including LED screens, truss towers, speaker stacks, greenery, carpet/aisle runners, coat check, first aid, and parking zones — with richer 3D models (stages now carry an LED backdrop, truss rig and stairs) under ACES-tone-mapped lighting.

**Asset toolbox** (28 types across 6 categories): stage, dance floor, canopy, arch, tent · chair row, seating block, round table, banquet table, head table, cocktail highboy, lounge · podium, press riser, DJ booth, photo booth · barricade, fence, checkpoint · expo booth, reg desk, food truck, bar, buffet, gift table, cake table, restrooms · exit zone. Seat-bearing items (blocks, rows, banquet/head/cocktail tables) render **real individual chairs** in 3D.

**3D rendered view**
- A **2D Plan / 3D View** toggle renders the same layout as real, modelled objects — a stage with backdrop, podium, press riser, DJ booth, round wood tables, expo booths, food trucks, barricades, chain-link fencing, and glowing exit signs.
- **Real chairs, one consistent model**: every seat (seating blocks, chair rows, and the ring around each round table) is the same chair model, GPU-**instanced** so hundreds render smoothly.
- Orbit (drag), zoom (scroll), pan (right-drag), and **click any object to select** it — the inspector on the right stays live, so you can adjust seating (rows × cols), dimensions, and rotation and watch the 3D update.
- The 3D view stays in sync with every 2D edit and template change; rotated seat blocks and tables rotate as a unit.
- **Edit directly in 3D** with a TransformControls gizmo — a **Move / Rotate / Scale** toolbar (shortcuts `G` / `T` / `Y`) lets you drag, rotate (yaw), and resize the selected object on the floor plane; changes snap to the grid and write straight back to the 2D plan, inspector, and counts.
- **Load real 3D meshes** — the inspector has a **3D model (.glb / .gltf URL)** field per object. Paste a glTF/GLB URL and it replaces that object's built-in shape with the real mesh (auto-scaled to the footprint, still selectable and editable). This is the drop-in point for models from **Sloyd, Spline, Meshy, Tripo3D**, or a **Hugging Face** image-to-3D space (TRELLIS, Hunyuan3D, TripoSR, Stable-Fast-3D…) — they all export glTF/GLB. For an automated *image → 3D* API call (Meshy/Tripo), supply your own API key; the app can call the provider, then feed the returned GLB into this same field.
- Powered by three.js + TransformControls + GLTFLoader (loaded from CDN). If the CDN is unreachable, the 3D toggle disables itself and the 2D builder keeps working.

**Persistence & export**
- **Save / Open** layouts to the server (auto-falls back to this browser's `localStorage` if the server is offline — the badge in the header shows **Server** vs **Local**).
- **Export PNG** (colors resolved from the live theme so the raster matches the screen) and **Export JSON**.
- **Import** a previously exported JSON file.
- **Light / dark** theme toggle (light by default, choice persisted).
- **Undo / redo** (⌘/Ctrl-Z, ⌘/Ctrl-Shift-Z), and a **Live State Schema** inspector.

---

## Pages & flow

- **`/` — landing page.** A hero with **✨ Generate a layout** (creates a new event, auto-named `MMDDYYYY-NN` — e.g. `09142026-01` for the first event on 2026-09-14) and a **Your events** grid to reopen or delete saved layouts. The storage badge shows where events live (Supabase / Server / This browser).
- **`/builder.html` — the builder.** Opened from the landing page:
  - `builder.html?event=<name>&new=1` → a fresh canvas pre-named with the generated date-name.
  - `builder.html?id=<id>` → opens a saved event.
  - The brand in the header links back to **← All events**.
- Event names auto-increment per day and are fully editable in the builder's **Project** field; renaming and saving updates the same record in place.

## Storage — Supabase-ready (3-tier)

Persistence is centralised in **`public/store-api.js`** (`BPStore`), chosen once at startup with graceful fallback:

1. **Supabase** — used when `public/config.js` has a `url` + `anonKey`.
2. **Node REST API** — `/api/layouts` (this server, `data/layouts.json`).
3. **localStorage** — this browser, the always-available offline fallback.

**To turn on Supabase (later, with your own credentials):**
1. Create a Supabase project → **Project Settings → API**.
2. Run **`supabase/schema.sql`** in the Supabase SQL editor (creates the `layouts` table + RLS policy + `updated_at` trigger).
3. Paste your **Project URL** and **anon key** into `public/config.js`.

That's it — both the landing page and the builder switch to Supabase automatically (the client library is loaded from CDN only when configured). No code changes needed. Until then everything runs on the Node backend / localStorage.

> `config.js` ships with empty credentials. If you put real keys in it, decide whether to keep it out of version control.

## REST API

Base URL: `/api`

| Method   | Path                | Body                     | Result |
|----------|---------------------|--------------------------|--------|
| `GET`    | `/api/health`       | —                        | `{ ok:true }` |
| `GET`    | `/api/layouts`      | —                        | array of `{ id, name, updatedAt, objectCount }` |
| `GET`    | `/api/layouts/:id`  | —                        | full layout `{ id, name, createdAt, updatedAt, data }` |
| `POST`   | `/api/layouts`      | `{ name, data }`         | created layout (`data.items` required) |
| `PUT`    | `/api/layouts/:id`  | `{ name?, data }`        | updated layout |
| `DELETE` | `/api/layouts/:id`  | —                        | `{ ok:true }` |

`data` is the builder's serialized envelope: `{ items:[…], grid:{…}, scale:{…}, savedAt }`.
Layouts are stored in `data/layouts.json` (created on first save; git-ignored).

Example:

```bash
curl -X POST http://localhost:4173/api/layouts \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Rally","data":{"items":[]}}'
```

---

## Project structure

```
2d view/
├── server.js          # zero-dependency Node http server + REST API
├── package.json       # start script (no runtime deps)
├── public/
│   └── index.html     # the entire single-file builder (HTML + CSS + JS)
├── data/              # layouts.json persistence (git-ignored, auto-created)
└── .claude/launch.json
```

## Notes
- The front end talks to the API with relative paths, so it works on any host/port.
- With the server down, the app still runs fully offline (localStorage-backed Save/Open).
