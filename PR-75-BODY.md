## Label modes + client booklet pictures stored in the database (no edge function)

### In plain words
- **Builder live 3D view** keeps its `Labels: None | Numbers | Names` switch (remembered per browser).
- **"Update client images"** in the builder now captures the 2D plan and the 3D view in two styles:
  **With labels** (numbered badges + legend, the approved look) and **Without labels** (plain model).
  The pictures are JPEG (~0.85, max 1600 px wide) and are saved **in the database** - no storage
  bucket, no edge function, no Supabase dashboard / JWT setup. Auto-capture keeps them fresh after a save
  while a booklet link is live.
- **Share flow** (event / flow / client pages and the Share booklet dialog): the 2D and 3D sections each get
  "With labels" / "Without labels" toggles (both on by default). These pages use the newest builder pictures.
  If a picture is missing the page says so with an **"Open builder to capture"** button and the share is
  blocked (we never silently publish an empty section). The chosen styles are saved on the link.
- **Client booklet**: above each picture a `With labels | Without labels` toggle (default With labels), shown
  only when both styles exist. Each picture is fetched only when shown; the full-size view follows the
  toggle; the toggle is hidden in print. Revoking / expiring the link stops the pictures immediately.
- Old bucket snapshots still work as a fallback if the (optional, legacy) edge function is enabled, but the
  database path is primary. `DASHBOARD-PASTE.ts` was removed (never deployed); `HELM_BOOKLET_SNAPSHOT_ENABLED`
  is no longer needed.

### SQL 0083 (`supabase/migrations/0083_booklet_images.sql`, paste `supabase/APPLY-0083.sql`)
Additive + idempotent, nothing deleted, every function `SECURITY DEFINER` with `search_path = ''`.
- `client_booklet_images` (org, event, kind `2d|3d`, variant `labels|plain`, mime jpeg/png/webp, bytes <= 1.5 MB,
  `data bytea`). RLS on, no policies, no table grants for anon / authenticated - only the RPCs below touch it.
  Studio read-only + quote/org integrity triggers. A new upload supersedes older rows (newest wins).
- `client_booklets.image_variants` jsonb - which styles the link shows (default all).
- `booklet_put_image(event, kind, variant, mime, base64)` - own studio, quotes EDIT, studio writable,
  magic bytes match the mime, <= 1.5 MB, rate limited.
- `booklet_image_info(event)`, `booklet_staff_image(event, kind, variant)` - quotes VIEW, own studio.
- `booklet_set_image_variants(event, {2d_labels, 2d_plain, 3d_labels, 3d_plain})` - quotes EDIT.
- `public_get_booklet` wrapped (previous kept as `__pre0083`, not anon-callable): adds
  `images.{2d,3d}.{labels,plain}` flags (no bytes) only for shown sections + styles.
- `public_get_booklet_image(token, kind, variant)` - anon; live / unexpired / unrevoked token, section and
  style shown, same booklet read limiter; returns `{mime, data}` (base64) or null.
- The earlier variant kinds (`2d_none`, `3d_names`, `snap_variants`, ...) are gone (0083 was never applied).

### CSP
The booklet routes already allow `img-src 'self' data: blob: https:` - no header change; a test pins it.

### Tests
- `npm run ci` green (label-modes rewritten: database API, booklet toggle with lazy fetch + lightbox,
  share checklist missing-picture block + styles, SQL shape, edge function legacy note).
- DB: new `tests/db/booklet-images.sql` (25 checks: upload/mime/size/magic/base64, other studio cannot
  insert or read, view-only member cannot upload, no direct table access, anon fetch only with a live token,
  revoked / expired / replaced link -> nothing, hidden section / hidden style -> nothing, newest wins with no
  delete, grants + definer). Full `run-all.sh` green.
- `APPLY-0083.sql` pasted twice on a database at 0082: all 10 verify rows true both times.

### Owner steps
1. Paste `supabase/APPLY-0083.sql` on staging, then prod (after 0082). Expect 10 rows, all `ok = true`.
2. Open an event in the builder and press "Update client images" (or save a layout while a link is live).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
