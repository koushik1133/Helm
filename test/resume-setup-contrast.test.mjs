// "Resume setup" CTA must be on-accent ink on accent fill in every shell-b theme (not the link colour).
import { readFileSync } from "node:fs"; import assert from "node:assert/strict";
const js = readFileSync(new URL("../public/onboarding-wizard.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/shell-b-style.css", import.meta.url), "utf8");
assert.match(js, /a\.className = "ob-cta"; a\.textContent = "Resume setup"/);
assert.match(js, /\.ob-nudge a\.ob-cta\{[^}]*color:var\(--hb-acc-ink,var\(--accent-ink,#fff\)\)/);
assert.doesNotMatch(js, /\.ob-nudge a\{[^}]*color:#fff/);
assert.match(css, /main a:not\(\.btn\):not\(\.ob-cta\):not\(\[class\*="nav"\]\)/);
assert.match(css, /\.card a:not\(\.btn\):not\(\.ob-cta\):not\(\.hd-btn\) \{ color/);
assert.match(css, /html\[data-shell="b"\] a\.ob-cta \{ background: var\(--hb-acc\); color: var\(--hb-acc-ink\); \}/);
console.log("resume-setup-contrast: ok");

// Studio theme link-colour rule must skip the Resume setup button
assert.match(readFileSync(new URL("../public/shell-b-theme-studio.css", import.meta.url), "utf8"), /data-hb-theme="studio"\] a:not\(\.btn\)[^{]*:not\(\.ob-cta\)/);
