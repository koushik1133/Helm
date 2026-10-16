# Builder header: 4 options (proposal, NOT applied)

Today the header is one long row. It holds Template · Past events · Create layout | Units · Snap/Grid · View
(2D/3D/Render) · Measure | Undo/Redo/Clear | Project name · quote badge · version · Save · Open · More |
Venue capacity · meter | account · theme · dims. It wraps on laptops, and fullscreen shows up twice (header and
canvas).

Rules for every option:
- **Fullscreen leaves the header.** It stays only as the bottom-right canvas button (⛶, which turns into ✕) plus the F / Esc keys.
- Save stays one click away in every option.
- The 2D / 3D switch stays visible in every option.
- Same IDs (`#snapBtn`, `#gridBtn`, `#viewSeg`, `#measureBtn`, `#saveBtn`, ...), so builder.js wiring and tests keep working. Only markup and CSS move.

---

## Option A: two tiers (document bar + tool bar)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ Helm  ‹ All events │ [Untitled event_________] Q-1042 · v3 ▾  ● Unsaved   [↶][↷]  [💾 Save] [More ▾] 👤 ◑ │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ [Template ▾] [✨ Create]  │  [ 2D | 3D | ✦ Render ]  │  [#Snap][▦Grid][📏Measure]  ft▾  │ Cap [500] ██░ 412 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- Top row is about the document: name, version, save state and save. The second row holds the tools.
- **Pros:** nothing wraps at 1280 px, and it reads like Figma or Canva. **Cons:** about 40 px less canvas height.

## Option B: one slim row with grouped menus

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ ‹ │ Untitled event · Q-1042 v3 ▾ │ Layout ▾  View: [2D|3D|✦]  Tools ▾  │ ↶ ↷ │ ● [💾 Save] ⋯ │ 👤 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
  Layout ▾ → Template…, Past events…, ✨ Create layout, Clear floor, Venue capacity…
  Tools  ▾ → ☑ Snap  ☑ Grid  ☐ Measure  ─  Units: ft / m
  ⋯       → Open, PNG, JSON, Import, Update client images, Theme
```
- **Pros:** the canvas gets the most room (one 48 px row), and it suits tablets. **Cons:** Snap and Grid move behind a menu, so the state needs a small dot on "Tools" when Snap is off.

## Option C: header row plus floating canvas tool rail (tools live on the canvas)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ ‹ All events │ Untitled event · Q-1042 v3 ▾ │ [Template ▾] [✨ Create] │ ↶ ↷ │ [💾 Save] [Open] ⋯ │ 👤 ◑ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
   ┌─────────────── canvas ─────────────────────────────────────────────────────┐
   │ ┌──────────────────────────────┐                                          │
   │ │ 2D │ 3D │ ✦ │ # │ ▦ │ 📏 │ ft │  ← floating pill, top-left of canvas     │
   │ └──────────────────────────────┘                                          │
   │                                                                  [⛶]      │
   │                                                                  [▲◀◎▶▼]  │
   │                                                                  [− 100% + FIT] │
   └────────────────────────────────────────────────────────────────────────────┘
```
- View and drawing tools sit next to the thing they change. The pill stays visible in fullscreen, so the custom fs-bar 2D/3D buttons can be retired.
- **Pros:** one consistent toolset in normal and fullscreen views, and a clean header. **Cons:** the pill has to avoid the 3D Move/Rotate/Scale bar (stack them, or merge them in 3D).

## Option D: mode-aware header (changes between 2D and 3D)

```
2D:
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ ‹ │ Untitled event v3 ▾ │ [ 2D ● | 3D ] │ #Snap ▦Grid 📏Measure ft▾ │ ↶ ↷ Clear │ [💾 Save] ⋯ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
3D:
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◧ ‹ │ Untitled event v3 ▾ │ [ 2D | 3D ● ] │ ✥Move ⟳Rotate ⤢Scale │ Labels: None·No.·Names │ ✦ Render │ [💾 Save] ⋯ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- Snap, Grid and Measure only apply in 2D, and the gizmo and labels only apply in 3D, so each mode shows only its own tools. The in-canvas `#tools3d` bar moves into the header.
- **Pros:** less noise, and each mode feels purpose-built. **Cons:** the header changes under the user, so a short cross-fade is needed, and the tests that look for `#tools3d` inside the viewport need updating.

---

### Recommendation
**C** if the canvas should come first, including fullscreen. **A** if the lowest-risk change is wanted (pure CSS/markup move). In
both cases: delete the header `#fsBtn` (fullscreen.js `mount()` then puts only the FAB in place), and move Template / Past
events / Create layout out of the always-visible row.
