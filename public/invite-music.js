/* invite-music.js — R23: the Invitation Studio's built-in music library.
 * Original instrumental loops composed + synthesised by scripts/gen-invite-music.mjs (no samples, nothing
 * downloaded), so they are Helm's own, copyright-free audio. Files: /invite/music/<key>.mp3 (same origin:
 * CSP media-src 'self'). A saved invitation stores only the KEY (data.musicTrack); src() maps a key to its
 * fixed file and returns "" for anything else, so a stored value can never point the player elsewhere. */
(function (global) {
  "use strict";
  var TRACKS = [
    { key: "gentle-piano",     title: "Gentle Piano",     mood: "Soft · weddings & engagements", secs: 38 },
    { key: "strings-serenade", title: "Strings Serenade", mood: "Romantic waltz · receptions",   secs: 36 },
    { key: "festive-dhol",     title: "Festive Dhol",     mood: "Upbeat · sangeet & birthdays",   secs: 37 },
    { key: "tanpura-evening",  title: "Tanpura Evening",  mood: "Calm Indian classical feel",     secs: 40 },
    { key: "ambient-glow",     title: "Ambient Glow",     mood: "Modern ambient · any event",     secs: 40 }
  ];
  var BY = {};
  TRACKS.forEach(function (t) { t.src = "/invite/music/" + t.key + ".mp3"; BY[t.key] = t; Object.freeze(t); });
  function has(k) { return typeof k === "string" && Object.prototype.hasOwnProperty.call(BY, k); }
  global.HelmInviteMusic = Object.freeze({
    TRACKS: Object.freeze(TRACKS.slice()),
    has: has,
    get: function (k) { return has(k) ? BY[k] : null; },
    src: function (k) { return has(k) ? BY[k].src : ""; }
  });
})(typeof window !== "undefined" ? window : globalThis);
