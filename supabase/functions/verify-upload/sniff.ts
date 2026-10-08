// verify-upload / sniff.ts — server-side magic-byte check, mirroring the browser's
// store-api uploads.sniff (UG_SNIFF) and the 0048 per-bucket key/extension allowlists.
// Pure functions, no I/O — unit-tested in tests/edge/verify-upload.test.ts.

export type Sniff = { mime: string; ext: string };

const SNIFF: Array<[string, string, (b: Uint8Array) => boolean]> = [
  ["image/png", "png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A],
  ["image/jpeg", "jpg", (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF],
  ["image/webp", "webp", (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
  ["image/gif", "gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61],
  ["application/pdf", "pdf", (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2D],
  ["audio/webm", "webm", (b) => b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3],
  ["audio/ogg", "ogg", (b) => b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53],
  ["audio/mp4", "m4a", (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70],
  ["audio/mpeg", "mp3", (b) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)],
];

export function sniff(bytes: Uint8Array | null | undefined): Sniff | null {
  if (!bytes || bytes.length < 12) return null;
  for (const [mime, ext, ok] of SNIFF) if (ok(bytes)) return { mime, ext };
  return null;
}

// extension → the sniffed mime it must be
const EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf",
  webm: "audio/webm", ogg: "audio/ogg", m4a: "audio/mp4", mp3: "audio/mpeg",
};
// declared content-type aliases (recorders label audio as video/*, etc.)
const ALIAS: Record<string, string> = {
  "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4",
  "video/webm": "audio/webm", "video/mp4": "audio/mp4", "audio/mp3": "audio/mpeg", "application/x-pdf": "application/pdf",
  "audio/aac": "audio/mp4",
};

// per bucket: allowed sniffed types + size cap (matches 0048 bucket config)
export const BUCKETS: Record<string, { mimes: string[]; max: number }> = {
  "event-docs": { mimes: ["application/pdf", "image/png", "image/jpeg", "image/webp"], max: 10485760 },
  "invite-media": { mimes: ["image/png", "image/jpeg", "image/webp", "image/gif"], max: 8388608 },
  "chat-media": { mimes: ["image/png", "image/jpeg", "image/webp", "image/gif", "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4"], max: 16777216 },
  "task-proof": { mimes: ["image/jpeg", "image/png", "image/webp", "audio/webm", "audio/ogg", "audio/mp4"], max: 8388608 },
};

export type Verdict = { ok: true; mime: string } | { ok: false; reason: string };

/** Decide from the object's first bytes, its total size, its key and its declared type. */
export function verdict(bucket: string, name: string, head: Uint8Array, size: number, declared?: string | null): Verdict {
  const rule = BUCKETS[bucket];
  if (!rule) return { ok: false, reason: "bucket not scanned" };
  if (!Number.isFinite(size) || size < 12) return { ok: false, reason: "empty or truncated" };
  if (size > rule.max) return { ok: false, reason: "over bucket size cap" };
  const s = sniff(head);
  if (!s) return { ok: false, reason: "unrecognised content" };
  if (!rule.mimes.includes(s.mime)) return { ok: false, reason: "type not allowed in bucket: " + s.mime };
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!EXT[ext]) return { ok: false, reason: "extension not allowed" };
  if (EXT[ext] !== s.mime) return { ok: false, reason: "extension/content mismatch (" + ext + " vs " + s.mime + ")" };
  const d = String(declared || "").split(";")[0].trim().toLowerCase();
  const dn = ALIAS[d] || d;
  if (dn && dn !== "application/octet-stream" && dn !== s.mime) return { ok: false, reason: "declared type/content mismatch" };
  return { ok: true, mime: s.mime };
}
