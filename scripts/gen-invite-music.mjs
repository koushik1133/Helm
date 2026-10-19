#!/usr/bin/env node
/* =============================================================================
   gen-invite-music.mjs — R23: the Invitation Studio's built-in music library.

   Every track is ORIGINAL: composed note-by-note in this file and synthesised
   from scratch (additive piano, band-limited saw strings, Karplus-Strong plucks,
   FM bells, synthetic dhol), then encoded locally with ffmpeg (libmp3lame).
   Nothing is downloaded or sampled, so Helm owns the audio outright (no third-
   party copyright, no licence to track).

   Each track is a seamless loop: notes and reverb tails that run past the loop
   end are wrapped back onto the start, so <audio loop> repeats it smoothly.

   Usage:  node scripts/gen-invite-music.mjs [--tmp <dir>] [--only <key>]
   Output: public/invite/music/<key>.mp3   (stereo, 32 kHz, 64 kbps, ~300 KB)
   Track list for the pages lives in public/invite-music.js (keep in sync).
   Deterministic: a fixed seed, so re-running gives the same notes.
   ========================================================================== */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "invite", "music");
const SR = 32000;
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

/* ---------- helpers ---------- */
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

class Mix {
  constructor(seconds) { this.N = Math.round(seconds * SR); this.L = new Float32Array(this.N); this.R = new Float32Array(this.N); }
  // add a mono voice buffer at time t (seconds), wrapping past the loop end
  add(buf, t, gain = 1, pan = 0) {
    const s0 = Math.round(t * SR), gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < buf.length; i++) { const j = (s0 + i) % this.N; this.L[j] += buf[i] * gl; this.R[j] += buf[i] * gr; }
  }
}

/* ---------- instruments (each returns a mono Float32Array) ---------- */
function piano(m, dur, vel = 0.6) {
  const f = hz(m), len = Math.round(Math.min(dur + 1.6, 5) * SR), out = new Float32Array(len), B = 0.00035;
  const bright = 0.5 + vel * 0.6, scale = Math.pow(f / 261.6, 0.35);
  for (let k = 1; k <= 9; k++) {
    const fk = k * f * Math.sqrt(1 + B * k * k); if (fk > SR * 0.45) break;
    const a = Math.pow(1 / k, 1.25) * (k === 1 ? 1 : bright), d = (1.1 + 0.55 * k) * scale, w = 2 * Math.PI * fk / SR, ph = k * 0.7;
    for (let i = 0; i < len; i++) out[i] += a * Math.exp(-d * i / SR) * Math.sin(w * i + ph);
  }
  const att = Math.round(0.004 * SR), offS = Math.round(dur * SR);
  for (let i = 0; i < len; i++) {
    let e = i < att ? i / att : 1;
    if (i > offS) e *= Math.exp(-(i - offS) / SR * 6);
    out[i] *= e * vel * 0.32;
  }
  return out;
}
function blep(p, dt) { if (p < dt) { const t = p / dt; return t + t - t * t - 1; } if (p > 1 - dt) { const t = (p - 1) / dt; return t * t + t + t + 1; } return 0; }
// band-limited saw ensemble -> 2-pole state-variable low-pass (strings / pads)
function strings(m, dur, vel = 0.5, o = {}) {
  const f = hz(m), atk = o.atk ?? 0.35, rel = o.rel ?? 0.9, len = Math.round((dur + rel) * SR), out = new Float32Array(len);
  const det = [-7, 0, 6].map((c) => f * Math.pow(2, c / 1200)), ph = [0.1, 0.43, 0.77];
  const cut = Math.min((o.cut ?? 1500) + 1.4 * f, SR / 8), F = 2 * Math.sin(Math.PI * cut / SR), Q = 0.9;
  let lo = 0, bd = 0, lo2 = 0, bd2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR, vib = 1 + (t > 0.4 ? 0.0018 * Math.sin(2 * Math.PI * 5.1 * t) : 0);
    let s = 0;
    for (let v = 0; v < 3; v++) { const dt = det[v] * vib / SR; ph[v] += dt; if (ph[v] >= 1) ph[v] -= 1; s += 2 * ph[v] - 1 - blep(ph[v], dt); }
    s /= 3;
    lo += F * bd; const hi = s - lo - Q * bd; bd += F * hi;
    lo2 += F * bd2; const hi2 = lo - lo2 - Q * bd2; bd2 += F * hi2;
    let e = t < atk ? t / atk : 1; if (t > dur) e *= Math.max(0, 1 - (t - dur) / rel);
    out[i] = lo2 * e * e * vel * 0.35;
  }
  return out;
}
// Karplus-Strong plucked string (harp / sitar-like / tanpura)
function pluck(m, dur, vel = 0.6, o = {}, rand = Math.random) {
  const f = hz(m), N = SR / f - 0.5, len = Math.round((dur + (o.tail ?? 1.2)) * SR), out = new Float32Array(len);
  const size = Math.ceil(N) + 3, buf = new Float32Array(size), g = o.decay ?? 0.996, bright = o.bright ?? 0.5;
  // excitation: noise smoothed by brightness
  let prev = 0; for (let i = 0; i < size; i++) { const n = rand() * 2 - 1; prev = prev + bright * (n - prev); buf[i] = prev; }
  const y = new Float32Array(len);
  const at = (n) => { const i = Math.floor(n), fr = n - i; const a = i >= 0 ? y[i] : 0, b = i + 1 >= 0 ? y[i + 1] : 0; return a + (b - a) * fr; };
  for (let n = 0; n < len; n++) {
    if (n < size) y[n] = buf[n] * (n < N ? 1 : 0);
    if (n >= N) y[n] += g * 0.5 * (at(n - N) + at(n - N - 1));
  }
  const offS = Math.round(dur * SR);
  for (let i = 0; i < len; i++) { let e = 1; if (i > offS) e = Math.exp(-(i - offS) / SR * 5); let v = y[i]; if (o.buzz) v = Math.tanh(v * (1 + 3 * o.buzz)) / (1 + o.buzz);   // jawari-like buzz (outside the loop: stable)
    out[i] = v * e * vel * 0.4; }
  return out;
}
// FM bell
function bell(m, vel = 0.4, o = {}) {
  const f = hz(m), len = Math.round((o.len ?? 4) * SR), out = new Float32Array(len), ratio = o.ratio ?? 3.5;
  for (let i = 0; i < len; i++) {
    const t = i / SR, I = (o.index ?? 2.4) * Math.exp(-t * 2.2), a = Math.exp(-t * (o.decay ?? 1.1)) * Math.min(1, t / 0.002);
    out[i] = Math.sin(2 * Math.PI * f * t + I * Math.sin(2 * Math.PI * f * ratio * t)) * a * vel * 0.3;
  }
  return out;
}
// dhol: bass head (dagga) and treble head (tilli), clap, shaker
function dholBass(vel = 1) { const len = Math.round(0.6 * SR), o = new Float32Array(len); let ph = 0;
  for (let i = 0; i < len; i++) { const t = i / SR, fr = 52 + 95 * Math.exp(-t * 22); ph += 2 * Math.PI * fr / SR; o[i] = (Math.sin(ph) + 0.25 * Math.sin(2 * ph)) * Math.exp(-t * 6.5) * Math.min(1, t / 0.0015) * vel * 0.55; } return o; }
function noiseBand(len, center, q, decay, vel, rand, tone) {
  const n = Math.round(len * SR), o = new Float32Array(n), F = 2 * Math.sin(Math.PI * Math.min(center, SR / 7) / SR); let lo = 0, bd = 0;   // Chamberlin SVF: keep F < 1 (stable)
  for (let i = 0; i < n; i++) { const t = i / SR, x = rand() * 2 - 1; lo += F * bd; const hi = x - lo - q * bd; bd += F * hi;
    o[i] = (bd + (tone ? 0.6 * Math.sin(2 * Math.PI * tone * t) : 0)) * Math.exp(-t * decay) * Math.min(1, t / 0.001) * vel; }
  return o;
}
const dholTreble = (vel, rand) => noiseBand(0.25, 1900, 0.6, 28, vel * 0.32, rand, 360);
const clap = (vel, rand) => noiseBand(0.18, 1300, 0.9, 22, vel * 0.22, rand, 0);
const shaker = (vel, rand) => noiseBand(0.07, 4500, 1.0, 60, vel * 0.09, rand, 0);
function sub(m, dur, vel = 0.5) { const f = hz(m), len = Math.round((dur + 0.15) * SR), o = new Float32Array(len);
  for (let i = 0; i < len; i++) { const t = i / SR; let e = Math.min(1, t / 0.01) * Math.exp(-t * 2.5); if (t > dur) e *= Math.max(0, 1 - (t - dur) / 0.15); o[i] = (Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(4 * Math.PI * f * t)) * e * vel * 0.5; } return o; }

/* ---------- Schroeder reverb, steady-state over the loop ---------- */
function reverb(mix, wet = 0.25, size = 1) {
  const run = (x, off) => {
    const combs = [1116, 1188, 1277, 1356].map((d) => Math.round((d + off) * size * SR / 44100));
    const aps = [556, 441].map((d) => Math.round((d + off) * SR / 44100));
    const cb = combs.map((d) => ({ b: new Float32Array(d), i: 0, f: 0 })), ab = aps.map((d) => ({ b: new Float32Array(d), i: 0 }));
    const N = x.length, y = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) for (let n = 0; n < N; n++) {   // pass 1 warms the tail so the loop seam is seamless
      let s = 0; const inp = x[n] * 0.18;
      for (const c of cb) { const o = c.b[c.i]; c.f = o * 0.72 + c.f * 0.28; c.b[c.i] = inp + c.f * 0.82; c.i = (c.i + 1) % c.b.length; s += o; }
      for (const a of ab) { const o = a.b[a.i]; const v = s + o * 0.5; a.b[a.i] = v; s = o - v * 0.5; a.i = (a.i + 1) % a.b.length; }
      if (pass === 1) y[n] = s;
    }
    return y;
  };
  const wl = run(mix.L, 0), wr = run(mix.R, 23);
  for (let i = 0; i < mix.N; i++) { mix.L[i] = mix.L[i] * (1 - wet * 0.5) + wl[i] * wet; mix.R[i] = mix.R[i] * (1 - wet * 0.5) + wr[i] * wet; }
}
// level-match every track (RMS ~ -19 dBFS, soft background level) with a gentle tanh limiter on peaks
function master(mix, rmsDb = -19) {
  for (let i = 0; i < mix.N; i++) { if (!Number.isFinite(mix.L[i]) || !Number.isFinite(mix.R[i])) throw new Error("non-finite sample at " + i); }
  let pk = 0, ss = 0; for (let i = 0; i < mix.N; i++) { pk = Math.max(pk, Math.abs(mix.L[i]), Math.abs(mix.R[i])); ss += mix.L[i] * mix.L[i] + mix.R[i] * mix.R[i]; }
  const rms = Math.sqrt(ss / (2 * mix.N)) || 1, g = Math.min(Math.pow(10, rmsDb / 20) / rms, 1.6 / (pk || 1));
  const out = new Float32Array(mix.N * 2), lim = (x) => 0.92 * Math.tanh(x / 0.92);
  for (let i = 0; i < mix.N; i++) { out[2 * i] = lim(mix.L[i] * g); out[2 * i + 1] = lim(mix.R[i] * g); }
  return out;
}

/* ---------- compositions (all original) ---------- */
const TRACKS = {
  // 1. Gentle piano — I-V-vi-IV in C, 76 bpm, arpeggiated left hand + simple right-hand line
  "gentle-piano": { title: "Gentle Piano", build() {
    const beat = 60 / 76, bar = beat * 4, bars = 12, mx = new Mix(bar * bars);
    const ch = [[48, 52, 55], [47, 50, 55], [45, 48, 52], [41, 45, 48], [48, 52, 55], [43, 47, 50], [41, 45, 48], [43, 47, 50], [45, 48, 52], [41, 45, 48], [48, 52, 55], [43, 47, 50]];
    const mel = [[[76, 2], [79, 2]], [[74, 2], [71, 2]], [[72, 2], [76, 2]], [[77, 3], [76, 1]], [[79, 2], [76, 2]], [[74, 2], [79, 2]], [[81, 2], [77, 2]], [[74, 4]], [[72, 2], [76, 2]], [[77, 2], [81, 2]], [[79, 2], [76, 2]], [[74, 2], [71, 2]]];
    ch.forEach((c, b) => {
      const t0 = b * bar;
      mx.add(piano(c[0] - 12, bar * 0.95, 0.55), t0, 1, -0.2);
      const arp = [c[0], c[1] + 12, c[2], c[1] + 12, c[0] + 12, c[2], c[1] + 12, c[2]];
      arp.forEach((m, i) => mx.add(piano(m, beat * 0.9, 0.3 + (i % 2 ? 0 : 0.05)), t0 + i * beat / 2, 1, -0.1 + (m % 12) * 0.02));
      let t = t0; for (const [m, d] of mel[b]) { mx.add(piano(m, d * beat * 0.95, 0.55), t + 0.01, 1, 0.15); t += d * beat; }
    });
    reverb(mx, 0.32, 1.1); return mx; } },

  // 2. Strings serenade — a slow waltz in D, 60 bpm 3/4: string pad + cello + violin line + harp
  "strings-serenade": { title: "Strings Serenade", build() {
    const beat = 1.0, bar = beat * 3, bars = 12, mx = new Mix(bar * bars), r = rng(7);
    const ch = [[50, 54, 57], [47, 50, 54], [43, 47, 50], [45, 49, 52], [50, 54, 57], [42, 45, 49], [43, 47, 50], [45, 49, 52], [47, 50, 54], [43, 47, 50], [40, 43, 47], [45, 49, 52]];
    const mel = [[[78, 2], [76, 1]], [[74, 3]], [[71, 1], [74, 1], [79, 1]], [[76, 3]], [[78, 2], [81, 1]], [[81, 2], [78, 1]], [[79, 2], [74, 1]], [[73, 3]], [[74, 2], [78, 1]], [[79, 2], [83, 1]], [[79, 2], [76, 1]], [[73, 1], [76, 1], [69, 1]]];
    ch.forEach((c, b) => {
      const t0 = b * bar;
      mx.add(strings(c[0] - 12, bar * 0.98, 0.55, { atk: 0.25, cut: 700 }), t0, 1, -0.3);
      c.forEach((m, i) => mx.add(strings(m + 12, bar * 1.02, 0.28, { atk: 0.6, rel: 1.0, cut: 1100 }), t0, 1, -0.4 + i * 0.4));
      [c[0] + 24, c[1] + 24, c[2] + 24].forEach((m, i) => mx.add(pluck(m, beat * 0.9, 0.35, { decay: 0.994, bright: 0.35 }, r), t0 + i * beat + 0.01, 1, 0.35));
      let t = t0; for (const [m, d] of mel[b]) { mx.add(strings(m, d * beat * 0.97, 0.5, { atk: 0.18, rel: 0.6, cut: 2200 }), t, 1, 0.1); t += d * beat; }
    });
    reverb(mx, 0.38, 1.2); return mx; } },

  // 3. Festive dhol — 104 bpm bhangra-style groove in G with a plucked riff, bass and claps
  "festive-dhol": { title: "Festive Dhol", build() {
    const beat = 60 / 104, step = beat / 4, bar = beat * 4, bars = 16, mx = new Mix(bar * bars), r = rng(42);
    const scale = [55, 57, 59, 60, 62, 64, 66];           // G major (Bilawal thaat on G)
    const note = (deg) => scale[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);
    const roots = [0, 0, 3, 4, 0, 0, 3, 4, 5, 3, 0, 4, 0, 3, 4, 0];   // G G C D ... Em C G D, G C D G
    const riffA = [[0, 7], [3, 9], [6, 11], [8, 9], [10, 8], [12, 7], [14, 8]], riffB = [[0, 9], [3, 11], [6, 12], [8, 11], [10, 9], [12, 8], [14, 7]];
    for (let b = 0; b < bars; b++) {
      const t0 = b * bar, rt = roots[b];
      [0, 3, 8, 11].forEach((s, i) => mx.add(dholBass(i % 2 ? 0.75 : 1), t0 + s * step, 1, -0.05));
      [2, 6, 10, 12, 14].forEach((s) => mx.add(dholTreble(0.8 + r() * 0.2, r), t0 + s * step, 1, 0.2));
      [4, 12].forEach((s) => mx.add(clap(0.9, r), t0 + s * step, 1, -0.15));
      for (let s = 0; s < 16; s += 2) mx.add(shaker(s % 4 ? 0.7 : 1, r), t0 + s * step, 1, 0.45);
      mx.add(sub(note(rt) - 12, beat * 1.6, 0.6), t0, 1, 0); mx.add(sub(note(rt) - 12, beat * 1.2, 0.5), t0 + 8 * step, 1, 0);
      const riff = b % 2 ? riffB : riffA;
      riff.forEach(([s, d]) => mx.add(pluck(note(d + rt) + 12, step * 2.5, 0.55, { decay: 0.993, bright: 0.75, buzz: 0.25, tail: 0.6 }, r), t0 + s * step, 1, 0.1));
      if (b % 4 === 3) [0, 4, 8, 12].forEach((s, i) => mx.add(bell(note(rt + 7 + i * 2) + 12, 0.25, { len: 1.2, decay: 3 }), t0 + s * step, 1, -0.3));
    }
    reverb(mx, 0.18, 0.8); return mx; } },

  // 4. Tanpura evening — a tanpura drone on D with a plucked Yaman-style phrase and soft bells
  "tanpura-evening": { title: "Tanpura Evening", build() {
    const beat = 0.8, len = 40, mx = new Mix(len), r = rng(11), SA = 62;
    for (let c = 0; c < 10; c++) [[SA - 5, 0], [SA, 1], [SA, 2], [SA - 12, 3]].forEach(([m, i]) =>
      mx.add(pluck(m - 12, 3.2, 0.5, { decay: 0.9993, bright: 0.25, buzz: 0.45, tail: 1.5 }, r), c * 4 + i, 1, -0.25 + i * 0.15));
    for (let c = 0; c < 10; c++) mx.add(strings(SA - 12, 4.2, 0.1, { atk: 1.2, rel: 1.5, cut: 400 }), c * 4, 1, 0);
    const ph = [[61, 2], [64, 1], [66, 3], [64, 1], [66, 1], [68, 1], [69, 3], [68, 1], [66, 1], [64, 2], [62, 4],
      [66, 1], [68, 1], [71, 1], [73, 1], [74, 4], [73, 1], [71, 1], [69, 2], [68, 1], [66, 1], [64, 2], [62, 4]];
    let t = 0.4; for (const [m, d] of ph) { mx.add(pluck(m + 12, d * beat, 0.55, { decay: 0.998, bright: 0.6, buzz: 0.3, tail: 1.2 }, r), t, 1, 0.15); t += d * beat; }
    [[74, 33], [81, 35.4], [78, 37.6]].forEach(([m, at]) => mx.add(bell(m + 12, 0.18, { len: 3.5 }), at, 1, 0.3));
    reverb(mx, 0.34, 1.25); return mx; } },

  // 5. Ambient glow — slow warm pads in F with gentle pentatonic chimes
  "ambient-glow": { title: "Ambient Glow", build() {
    const len = 40, mx = new Mix(len), r = rng(5), chordLen = 8;
    const ch = [[41, 57, 60, 64, 69], [38, 53, 57, 60, 64], [46, 53, 57, 62, 65], [48, 55, 60, 62, 67], [41, 57, 60, 64, 67]];
    ch.forEach((c, i) => c.forEach((m, k) => mx.add(strings(m, chordLen + 0.6, k ? 0.22 : 0.3, { atk: 2.2, rel: 2.4, cut: 500 }), i * chordLen, 1, -0.5 + k * 0.25)));
    const penta = [65, 67, 69, 72, 74, 77, 79, 81, 84];
    for (let t = 0.5; t < len - 0.2; t += 1.2 + r() * 1.4) mx.add(bell(penta[Math.floor(r() * penta.length)], 0.14 + r() * 0.08, { len: 4, ratio: 2.0, index: 1.6, decay: 0.9 }), t, 1, r() * 1.2 - 0.6);
    reverb(mx, 0.45, 1.35); return mx; } },
};

/* ---------- render + encode ---------- */
const only = arg("--only");
const tmp = mkdtempSync(join(arg("--tmp") || tmpdir(), "helm-music-"));
mkdirSync(OUT, { recursive: true });
try {
  for (const [key, tr] of Object.entries(TRACKS)) {
    if (only && only !== key) continue;
    const mx = tr.build(), pcm = master(mx), raw = join(tmp, key + ".f32"), mp3 = join(OUT, key + ".mp3");
    writeFileSync(raw, Buffer.from(pcm.buffer));
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", raw,
      "-c:a", "libmp3lame", "-b:a", "64k", "-ar", String(SR), "-map_metadata", "-1", "-id3v2_version", "3",
      "-metadata", "title=" + tr.title, "-metadata", "artist=Helm Events", "-metadata", "copyright=Original composition, Helm Events", mp3]);
    console.log(`  ✓ ${key}.mp3  ${(mx.N / SR).toFixed(1)}s  ${Math.round(statSync(mp3).size / 1024)} KB`);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
