# Photo renders (builder "✦ Render") — setup

The builder's **✦ Render** button turns a floor plan into an ultra-realistic photograph of the
event. The browser captures three reference pictures (clean 3D view from the chosen camera, the
2D plan without labels, the 2D plan with names + measurements), builds a layout-exact prompt
(`public/photo-render-prompt.js`) and sends them to the Supabase edge function **`render-photo`**.
Only that function talks to OpenAI; the API key is a server secret and never reaches the browser.

Until the steps below are done the feature is **dormant**: the function answers
`503 {"error":"render_not_configured"}` and the builder shows
"Photo renders aren't switched on yet — ask your admin" (admins see these steps).

## Model + endpoint

- Endpoint: `POST https://api.openai.com/v1/images/edits` (multipart), several reference
  pictures sent as repeated `image[]` fields (GPT image models accept up to 16).
- Model: `gpt-image-2` (override with the secret `OPENAI_IMAGE_MODEL`, e.g. a dated snapshot).
- Parameters used: `size` 1536x1024 (1024x1536 for a tall top-down plan), `quality`
  `medium` ("Standard") or `high`, `n` 1–4, `output_format=jpeg`, `output_compression=88`.
  (`input_fidelity` is ignored by gpt-image-2, so it is not sent.)

## 1. Apply the SQL

Apply `supabase/migrations/0095_photo_render.sql` (additive, idempotent). It adds the
`photo_renders` / `photo_render_usage` / `photo_render_settings` tables (RLS on, no direct
access), the RPCs, and the **Photo renders** access area (seeded *edit* for every role that can
already edit quotes; admins always).

## 2. Set the secret and deploy the function

```bash
supabase link --project-ref <project-ref>
supabase secrets set OPENAI_API_KEY=sk-...your-key...
supabase functions deploy render-photo
```

Optional secrets:

| Secret | Default | Meaning |
|---|---|---|
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | image model id |
| `RENDER_TIMEOUT_MS` | `170000` | give up on OpenAI after this long (20 000–380 000) |
| `RENDER_COST_USD_MEDIUM` / `_HIGH` / `_LOW` | 0.07 / 0.25 / 0.02 | per-photo cost estimate written to the usage log |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase.
CORS uses the same exact-origin allowlist as the other functions (`_shared/cors.ts`).

To switch it off again: `supabase secrets unset OPENAI_API_KEY` (or switch it off per studio in
Control Center).

## 3. Who may render, quotas

- **Control Center → Users & access → Photo renders**: *edit* = may make photos (quotes edit is
  needed too).
- **Control Center → ✦ Photo renders** card: on/off for the studio, photos per month (default 60),
  render requests per hour (default 20), and this month's usage + cost estimate.
- The database enforces these in `photo_render_begin` (runs as the signed-in user, under a
  per-studio lock) before OpenAI is ever called.

## Cost

OpenAI bills per image by quality and size (plus a little for the input pictures). Rough guide
for a 1536x1024 photo: Standard (medium) ≈ US$0.05–0.10, High ≈ US$0.20–0.30. Check the current
price list on platform.openai.com/docs/pricing and set the `RENDER_COST_USD_*` secrets to match;
every request is logged in `photo_render_usage` (studio, user, event, model, size, quality,
number of photos, status, cost estimate) for billing.

## Where the photos go

Photos are stored in the database (`photo_renders`, ≤ 6 MB each — no public bucket), listed per
event in the dialog ("Past renders"), downloadable, and **Use in client booklet** copies one into
the booklet's "3D without labels" picture (≤ 1.5 MB, the 0083 limit). Note: the booklet's
automatic re-capture after a new layout version replaces that picture again.
