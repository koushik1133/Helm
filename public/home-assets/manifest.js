/* Owner asset flags:
   events[name] true once /home-assets/events/<name>.<events_ext[name]> exists (webp|jpg|png, default webp);
   events_video[name] true once <name>.mp4 + <name>.webm (short muted loop) exist.
   set to true once the file exists (see _plans/demo9-assets/layouts-README.md).
   layouts[]: files live in /home-assets/layouts/<id>/{2d,3d,render,measure}.<ext>.
     ready     true once 2d/3d/render exist   ext     per-view file type: "webp" | "jpg" | "png"
     measure   true once measure.<ext> exists video3d true once 3d.mp4 (short silent loop) exists
     measurements  legend beside the Measure view, entered in METRES: {label, m} or {label, w, h};
                   the page converts to feet live (1 m = 3.28084 ft). Placeholders until the owner sends values. */
window.DEMO9_MANIFEST = {
  "heroVideo": true,
  "heroWebm": true,
  "heroPoster": true,
  "events": {
    "corporate": false,
    "wedding": false,
    "concert": false,
    "birthday": false,
    "gala": false,
    "cultural": false
  },
  "events_ext": { "corporate": "webp", "wedding": "webp", "concert": "webp", "birthday": "webp", "gala": "webp", "cultural": "webp" },
  "events_video": { "corporate": false, "wedding": false, "concert": false, "birthday": false, "gala": false, "cultural": false },
  "layouts": [
    {
      "id": "wedding",
      "name": "Garden wedding",
      "ready": false,
      "ext": { "2d": "webp", "3d": "webp", "render": "webp", "measure": "webp" },
      "measure": false,
      "video3d": false,
      "measurements": [
        { "label": "Stage to first table", "m": 4.5 },
        { "label": "Centre aisle", "m": 1.8 },
        { "label": "Table to table", "m": 1.5 },
        { "label": "Hall", "w": 24, "h": 16 }
      ]
    },
    {
      "id": "corporate",
      "name": "Corporate gala",
      "ready": false,
      "ext": { "2d": "webp", "3d": "webp", "render": "webp", "measure": "webp" },
      "measure": false,
      "video3d": false,
      "measurements": [
        { "label": "Stage to first row", "m": 5 },
        { "label": "Main aisle", "m": 2.4 },
        { "label": "Exit clearance", "m": 1.2 },
        { "label": "Hall", "w": 30, "h": 20 }
      ]
    }
  ]
};
