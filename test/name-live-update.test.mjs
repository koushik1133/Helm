// name-live-update: step-1 Event type / guests / date / city edits update the quote name live and
// the client autosave persists them, even for non-bubbling input/change/blur (datalist picks,
// programmatic edits). Runs the real flow.html name + wiring code against stubbed DOM / BPStore.
import fs from "node:fs"; import vm from "node:vm"; import assert from "node:assert/strict"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const html = fs.readFileSync(new URL("../public/flow.html", import.meta.url), "utf8");
const HEN = require("../public/event-name.js"); const HelmAutosave = require("../public/flow-autosave.js");
const nameSrc = html.slice(html.indexOf("const HEN_=()=>"), html.indexOf("async function saveName"));
const a = html.indexOf("let clientEdited=false;"), b = html.indexOf("wireNameEdit();", a);
assert.ok(nameSrc.includes("function renderName") && a > 0 && b > a, "flow.html name/wiring blocks found");
const wireSrc = html.slice(a, b);
assert.match(html.slice(html.indexOf("function renderName"), html.indexOf("async function saveName")), /\$\("#title"\)/, "renderName keeps #title in step");

function el(id) { const L = {}; return { id, value: "", textContent: "", hidden: false, L, querySelector: () => null,
  addEventListener(t, f) { (L[t] = L[t] || []).push(f); },
  fire(t) { (L[t] || []).forEach((f) => f({ type: t, target: this, bubbles: false })); } }; }
async function setup(title) {
  const ids = ["c_name","c_company","c_email","c_phone","c_type","c_date","c_city","c_state","c_guests","qName","qNameHintText","qNameReset","title"];
  const D = Object.fromEntries(ids.map((i) => [i, el(i)]));
  const ev = { id: "q1", code: "10102026-01", title, eventType: "wedding", client: { guests: 200 } };
  D.c_type.value = "wedding"; D.c_guests.value = "200";
  const writes = [];
  const store = { title, eventType: "wedding", client: ev.client };
  // BPStore.updateMeta stub with the real auto-title rule (isAuto -> fromQuote)
  async function saveClient() { const patch = { client: Object.assign({}, ev.client, { guests: +D.c_guests.value || null, city: D.c_city.value || null, eventDate: D.c_date.value || null }),
      eventType: D.c_type.value.trim() || null, eventDate: D.c_date.value || null };
    if (HEN.isAuto(store.title, ev.code)) { const t = HEN.fromQuote(patch); if (t) patch.title = t; }
    writes.push(patch); Object.assign(store, patch); ev.eventType = patch.eventType; ev.client = patch.client; if (patch.title) ev.title = patch.title; return true; }
  const ctx = { ev, window: { HelmEventName: HEN }, $: (s) => D[s.slice(1)], loading: false, HelmAutosave, saveClient, store, writes, D };
  vm.createContext(ctx);
  vm.runInContext(`${nameSrc}; var AS=HelmAutosave.create({delay:20,save:{client:()=>saveClient()}}); AS.has=()=>true; (function(){ ${wireSrc} })();`, ctx);
  return ctx;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [type, code] of [["Gala dinner", "GAL_200"], ["Political rally", "POL_200"]]) {
  const c = await setup("WED_200");
  c.D.c_type.value = type; c.D.c_type.fire("input"); c.D.c_type.fire("change");
  assert.equal(c.D.qName.textContent, code, "header name updates immediately for " + type);
  assert.equal(c.D.title.textContent, code, "#title mirrors the live name");
  c.D.c_type.fire("blur"); await wait(10);
  assert.equal(c.store.eventType, type, "blur persists eventType"); assert.equal(c.store.title, code, "auto title persisted");
}
{ // debounce path (no blur), non-bubbling change only
  const c = await setup("WED_200"); c.D.c_type.value = "Gala dinner"; c.D.c_type.fire("change"); await wait(60);
  assert.equal(c.store.eventType, "Gala dinner"); assert.equal(c.writes.length, 1);
}
{ // guests / date / city
  const c = await setup("WED_200");
  c.D.c_guests.value = "350"; c.D.c_guests.fire("input"); assert.equal(c.D.qName.textContent, "WED_350");
  c.D.c_city.value = "Dubai"; c.D.c_city.fire("input"); assert.equal(c.D.qName.textContent, "WED_DXB_350");
  c.D.c_date.value = "2026-12-28"; c.D.c_date.fire("change"); assert.equal(c.D.qName.textContent, "WED_DXB_350_28DEC26");
  await wait(60); assert.equal(c.store.title, "WED_DXB_350_28DEC26"); assert.equal(c.store.client.guests, 350);
}
{ // manual name never overwritten
  const c = await setup("Sharma Wedding"); c.D.c_type.value = "Gala dinner"; c.D.c_type.fire("change"); c.D.c_type.fire("blur"); await wait(10);
  assert.equal(c.D.qName.textContent, "Sharma Wedding"); assert.equal(c.store.title, "Sharma Wedding"); assert.equal(c.store.eventType, "Gala dinner");
}
{ // blur without an edit does not write; loading suppresses saves
  const c = await setup("WED_200"); c.D.c_type.fire("blur"); await wait(40); assert.equal(c.writes.length, 0);
  c.loading = true; c.D.c_type.value = "Gala dinner"; c.D.c_type.fire("change"); await wait(40); assert.equal(c.writes.length, 0);
}
console.log("name-live-update: all checks passed");
