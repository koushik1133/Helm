# Event ideas — landing page film strip

The "Event ideas" section ("Plan events like these.") on the home page (`/`, section `#events`) is a
full-width film strip (a dark tape with sprocket holes) that slowly scrolls on its own, built
from `events.json` in this folder. Right under it, the "Moments" section ("Scroll through the moments.",
section `#moments`) shows the same photos on a 3D cylinder: tall frames (photos are centre-cropped),
the front one large with a green glow, the rest turned and darker. It moves by swipe / drag,
sideways trackpad scroll, the arrow keys or its buttons, and turns slowly by itself while nobody
is using it. Both sections come from the same list, so one new entry shows up in both. While the list is empty (`[]`) the whole section stays
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
| `caption` | no       | Short line on the bottom of the frame (event · city); keep it short, long ones are cut with … |
| `type`    | no       | Small tag on the photo: Wedding, Corporate, Birthday, Festival… |
| `small`   | no       | ~800 px wide copy of the same photo (e.g. `wedding-800.webp`); the strip loads it on most screens (and only it on Data Saver), the full-screen view uses `src`. |
| `avif`    | no       | AVIF copy of the same photo; browsers that support it load it first. |
| `width` / `height` | no | Pixel size of the file; stops the page jumping while photos load. |

Image files are cached by browsers for a year, so to **replace** a photo give the new file a
new name (e.g. `sharma-wedding-2.webp`) and update `events.json`. To remove one, delete its
entry from `events.json`. Set the file back to `[]` to hide the whole section again.

How the strip shows them:

- Every frame is the same size (3:2); photos are cropped to fill it (centre crop), so any shape works,
  but landscape photos with the subject near the middle look best.
- With 6 or more photos there are two strips running in opposite directions: 1st, 3rd, 5th… photo
  on the top strip, 2nd, 4th, 6th… on the bottom one. With fewer than 6 there is one strip.
- The film moves slowly and loops forever; it stops while the mouse is over it or a frame has keyboard
  focus, and it can be dragged / swiped sideways. Tapping a frame opens it full screen.
- With "reduce motion" switched on in the device settings, the strip stands still and scrolls sideways
  by hand instead.
- Photos are lazy-loaded. Up to 24 entries are used. More photos = a longer, more varied strip, so
  just keep adding files + entries.

4. Before deploying, run `node scripts/bump-changed-assets.mjs --apply` only if you also
   changed CSS/JS; adding photos + editing `events.json` needs no other step.

The current images were supplied by the owner and are not from client events, so the section is titled
"Event ideas" ("Plan events like these") — keep that wording unless every photo is from a real
client event. The same files (`wedding`, `product-launch`, `birthday`, `sangeet`, `corporate-gala`, `mehendi`)
are also the backgrounds of the "Built for every kind of celebration" slider (see `CEL_PHOTOS` in `home.js`),
so keep those names when replacing them (or update `CEL_PHOTOS`).

Only use photos you own or have written permission to publish, and make sure guests who
can be identified are fine with it.

This README is not deployed (listed in `.vercelignore`).
