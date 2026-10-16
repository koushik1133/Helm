# Layout images for demo 9

Two layouts, one folder each. Every folder needs exactly these three files:

| File | What it shows | Size |
|---|---|---|
| `2d.webp` | Top-down 2D plan with measurements | 1600 × 1000 px (16:10), under 300 KB |
| `3d.webp` | The same plan in the 3D view, same framing | 1600 × 1000 px (16:10), under 350 KB |
| `render.webp` | Photoreal render of the same view | 1600 × 1000 px (16:10), under 400 KB |

Folders:

- `wedding/` — Garden wedding. Used in the story film (Meeting proposal thumbnails and the Design chapter).
- `corporate/` — Corporate gala. Default tab of the "Draw it once, show it three ways" showcase.

Paths are lowercase and exact, e.g. `demo-9-assets/layouts/wedding/render.webp`.

After all three files of a layout are in place, open `demo-9-assets/manifest.json` and set that layout's `"ready": true`.
Until then the page shows existing sample stills with a "Sample" label and never requests these files.
Keep the same camera angle across 2d / 3d / render so the cross-fade lines up. Export WebP at quality ~80.
