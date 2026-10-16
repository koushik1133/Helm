// Dashboard: a single design (shell-b-dash.*). Demos 2-7 were retired; the loader must not reference them.
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
const proto = readFileSync("public/shell-proto.js", "utf8");
const money = readFileSync("public/shell-b-money.js", "utf8");
for (const [n, src] of [["shell-proto", proto], ["money", money]]) new vm.Script(src, { filename: n });
assert.match(proto, /css\("shell-b-dash\.css"\)/, "one dashboard stylesheet");
assert.match(proto, /js\("shell-b-money\.js"\); js\("shell-b-dash\.js"\);/, "money helpers + one dashboard script");
assert.ok(!/shell-b-dash[2-9]/.test(proto), "no retired demo files referenced");
assert.ok(!/"Demo [2-9]"/.test(proto), "no demo buttons");
for (const n of [2, 3, 4, 5, 6, 7]) assert.ok(!existsSync(`public/shell-b-dash${n}.js`), `demo ${n} removed`);
assert.ok(!/"New layout"|"Old layout"|shellSwitch/.test(proto), "layout switcher removed");
assert.match(proto, /var SHELL_V = "\d+"/, "cache-versioned");
assert.match(proto, /s\.async = false/, "parallel fetch, ordered execution");
assert.match(money, /revenueBars: revenueBars/); assert.match(money, /revenueBars\(booked, collected, now, "bz-"\)/, "Business page still draws its chart");
console.log("dashboard-demo-switch: ok");
