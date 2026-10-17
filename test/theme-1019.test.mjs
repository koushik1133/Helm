import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const P = (f) => readFileSync(new URL("../public/" + f, import.meta.url), "utf8");

test("builder back-to-event link: pretty URL and ?quote=", () => {
  const { backUrl } = require("../public/builder-back.js");
  assert.equal(backUrl({ pathname: "/staging-demo/events/10172026-01/floor-plan", search: "?v=1" }), "/staging-demo/events/10172026-01");
  assert.equal(backUrl({ pathname: "/builder.html", search: "?quote=abc-1" }), "event.html?id=abc-1");
  assert.equal(backUrl({ pathname: "/builder.html", search: "?quote=%3Cx%3E" }), null);
  assert.equal(backUrl({ pathname: "/builder.html", search: "" }), null);
});

test("builder loads theme + back link, full-screen (no sidebar shell)", () => {
  const h = P("builder.html");
  assert.match(h, /builder-v2\.css/);
  assert.match(h, /builder-back\.js/);
  assert.match(P("shell-proto.js"), /if \(m\[3\] === "floor-plan"\) return null/);
});

test("tour popups use theme tokens (no old gold) and are themed in the builder", () => {
  const t = P("tour.js");
  assert.doesNotMatch(t, /--gold/);
  assert.match(t, /border:3px solid var\(--hb-acc/);
  assert.match(P("builder-v2.css"), /:is\(\.htour,\.htour-fab\) \{ --hb-bg:var\(--panel\)/);
});
