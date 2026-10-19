# Events made with Helm — landing page photo gallery

The "Events made with Helm" section on the home page (`/`, section `#events`) is built
from `events.json` in this folder. While the list is empty (`[]`) the whole section stays
hidden, so nothing half-finished ever shows on the live site.

## Add photos

1. Export each photo about **1600 px wide** (long side), as **WebP**, ideally **under 300 KB**
   (quality 70–80 is usually plenty). Optional: also export an `.avif` copy of the same photo.
2. Drop the files into this folder, e.g. `public/landing/events/sharma-wedding.webp`.
3. Add one entry per photo to `events.json`:

```json
[
  {
    "src": "/landing/events/sharma-wedding.webp",
    "alt": "Mandap with marigold canopy and fairy lights at dusk",
    "caption": "Sharma wedding · Hyderabad",
    "type": "Wedding",
    "width": 1600,
    "height": 1067
  },
  {
    "src": "/landing/events/tech-launch.webp",
    "avif": "/landing/events/tech-launch.avif",
    "alt": "Stage with LED wall and theatre seating for a product launch",
    "caption": "Product launch · Bengaluru",
    "type": "Corporate"
  }
]
```

| Field     | Required | Notes |
|-----------|----------|-------|
| `src`     | yes      | Path under `/landing/events/` (WebP or JPG). Other hosts are ignored. |
| `alt`     | yes      | What the photo shows, for screen readers. Entries without `alt` are skipped. |
| `caption` | no       | Short line under the photo (event · city). |
| `type`    | no       | Small tag on the photo: Wedding, Corporate, Birthday, Festival… |
| `avif`    | no       | AVIF copy of the same photo; browsers that support it load it first. |
| `width` / `height` | no | Pixel size of the file; stops the page jumping while photos load. |

Image files are cached by browsers for a year, so to **replace** a photo give the new file a
new name (e.g. `sharma-wedding-2.webp`) and update `events.json`. To remove one, delete its
entry from `events.json`. Set the file back to `[]` to hide the whole section again.

Photos are shown in the order listed (first = top left), lazy-loaded, and open full screen
when tapped. Up to 24 entries are used.

4. Before deploying, run `node scripts/bump-changed-assets.mjs --apply` only if you also
   changed CSS/JS; adding photos + editing `events.json` needs no other step.

Only use photos you own or have written permission to publish, and make sure guests who
can be identified are fine with it.

This README is not deployed (listed in `.vercelignore`).
