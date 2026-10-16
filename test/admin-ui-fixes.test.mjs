// Regression checks for admin/public UI fixes found in the Oct 2026 E2E pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8");

test("control.html: .grid collapses to one column at <=560px (rule comes after the 640px rule)", () => {
  const s = read("control.html");
  const i640 = s.indexOf("@media(max-width:640px){.grid{grid-template-columns:1fr 1fr}}");
  const i560 = s.indexOf("@media(max-width:560px){.grid{grid-template-columns:minmax(0,1fr)}}");
  assert.ok(i640 > 0 && i560 > i640);
});

test("shell-b quick-create: templates item is labelled as a checklist template, not an event", () => {
  const s = read("shell-b.js");
  assert.ok(!/New event from template/.test(s));
  assert.match(s, /label: "Checklist template".*href: "templates\.html"/);
});

test("404.html: .nf keeps .wrap side padding (no horizontal padding override)", () => {
  const s = read("404.html");
  const rule = s.match(/\.nf\{[^}]*\}/)[0];
  assert.ok(!/padding:48px 0/.test(rule));
});
