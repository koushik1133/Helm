// r24-automation.test.mjs - 0269: run-sheet reminders (owner picker + per-line reminder + bell tag), one Automations
// page in Control Center, the public enquiry form (/<studio>/enquiry) and the comms-dispatch e-mail lanes.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { runsheetReminderMessage, runsheetLink, enquiryReplyMessage, RUNSHEET_TX_REASON, ENQUIRY_TX_REASON } from "../supabase/functions/comms-dispatch/r24-automation.mjs";

const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const J = (x) => JSON.parse(JSON.stringify(x));   // values from the vm realm compared as plain data
const sql = r("supabase/migrations/0269_r24_automation.sql");

t("migration is additive: no drop / delete / truncate of data, ASCII only, re-run safe", () => {
  assert.ok(!/\bdrop\s+(table|column)\b/i.test(sql) && !/\btruncate\b/i.test(sql) && !/\bdelete\s+from\b/i.test(sql), "no destructive statement");
  assert.ok(/^[\x00-\x7f]*$/.test(sql), "ASCII only");
  assert.ok((sql.match(/add column if not exists/g) || []).length === 7, "7 new run-sheet columns");
  assert.match(sql, /create table if not exists public\.automation_settings/);
  assert.match(sql, /create table if not exists public\.runsheet_reminder_sends/);
  assert.match(sql, /create table if not exists public\.lead_enquiries/);
  assert.match(r("supabase/migrations/MANIFEST"), /forward  supabase\/migrations\/0269_r24_automation\.sql/);
});

t("defaults: run-sheet reminders ON at 15 / 0, enquiry form OFF", () => {
  assert.match(sql, /runsheet_enabled   boolean not null default true/);
  assert.match(sql, /runsheet_offsets   integer\[\] not null default array\[15, 0\]/);
  assert.match(sql, /enquiry_enabled    boolean not null default false/);
});

t("public RPCs are the only anon surface; tick / claim are service role", () => {
  assert.match(sql, /foreach f in array array\['public\.public_enquiry_info\(text\)', 'public\.public_enquiry_submit\(text, jsonb\)'\]/);
  assert.match(sql, /grant execute on function %s to service_role/);
  assert.match(sql, /rate_hit\('enq\.ip', v_ip, 3600, 5\)/);
  assert.match(sql, /rate_hit\('enq\.org', v_org::text, 3600, 30\)/);
  assert.match(sql, /86400, 3\) > 0/);
  assert.match(sql, /'website'/, "honeypot field");
});

t("comms-dispatch claims both 0269 lanes and marks every row", () => {
  const ix = r("supabase/functions/comms-dispatch/index.ts");
  assert.match(ix, /admin\.rpc\("runsheet_reminder_claim"/);
  assert.match(ix, /admin\.rpc\("runsheet_reminder_mark"/);
  assert.match(ix, /admin\.rpc\("enquiry_reply_claim"/);
  assert.match(ix, /admin\.rpc\("enquiry_reply_mark"/);
  assert.match(ix, /from "\.\/r24-automation\.mjs"/);
});

t("run-sheet reminder e-mail: plain words, link host from APP_URL only, fails closed", () => {
  const row = { id: "x", quote_id: "a0000000-0000-4000-8000-00000000da01", title: "Cake cutting", time_text: "7:30 pm", location: "Main hall",
    text: "In 15 min: Cake cutting at 7:30 pm (Main hall)", studio: "Studio A", event: "Wedding A", event_date: "20/10/2026", name: "Ravi", offset_min: 15 };
  const m = runsheetReminderMessage(row, "https://helm.events");
  assert.equal(m.subject, "Reminder: Cake cutting at 7:30 pm - Wedding A");
  assert.match(m.text, /^Hello Ravi,/);
  assert.match(m.text, /Cake cutting starts in 15 min, at 7:30 pm \(Main hall\), for Wedding A on 20\/10\/2026\./);
  assert.match(m.text, /https:\/\/helm\.events\/runsheet\.html\?quote=a0000000-0000-4000-8000-00000000da01/);
  assert.equal(runsheetReminderMessage({ ...row, offset_min: 0 }, "https://helm.events").subject.indexOf("Starting now: "), 0);
  assert.equal(runsheetReminderMessage(row, "http://evil.test").text, "", "non-https origin");
  assert.equal(runsheetReminderMessage({ ...row, quote_id: "../x" }, "https://helm.events").text, "", "bad id");
  assert.equal(runsheetReminderMessage({ ...row, time_text: "<b>" }, "https://helm.events").text, "", "bad time");
  assert.equal(runsheetLink(row, "https://helm.events/"), "https://helm.events/runsheet.html?quote=" + row.quote_id);
  assert.ok(RUNSHEET_TX_REASON.length > 10 && ENQUIRY_TX_REASON.length > 10);
});

t("enquiry reply e-mail: the studio's own words, no markup, fails closed", () => {
  const m = enquiryReplyMessage({ studio: "Studio A", text: "Namaste Priya, <b>thanks</b>" });
  assert.equal(m.subject, "Thank you for your enquiry - Studio A");
  assert.ok(!/[<>]/.test(m.text) && /Namaste Priya/.test(m.text));
  assert.equal(enquiryReplyMessage({ studio: "", text: "x" }).text, "");
  assert.equal(enquiryReplyMessage({ studio: "A", text: "" }).text, "");
});

t("runsheet page: owner picker + reminder fields + bell tag wired through runsheet-remind.js", () => {
  const h = r("public/runsheet.html");
  assert.match(h, /<script src="runsheet-remind\.js\?v=\d+"><\/script>/);
  for (const id of ["r_owner_other", "r_remWrap", "r_rem", "r_remAt", "r_remGrp", "e_owner_other", "e_remWrap", "e_rem", "e_remAt", "e_remGrp"]) assert.match(h, new RegExp('id="' + id + '"'), id);
  assert.match(h, /\.\.\.RR\.readOwner\("r"\), \.\.\.RR\.readRemind\("r"\)/);
  assert.match(h, /\.\.\.RR\.readOwner\("e"\), \.\.\.RR\.readRemind\("e"\)/);
  assert.match(h, /RR\.loadTargets\(BPStore,id\)/);
  assert.ok(!/PEOPLE_OPTS/.test(h), "old picker removed");
  assert.match(h, /id="r_add">＋ Add item<\/button>/);
});

// a tiny DOM for runsheet-remind.js
function fakeDoc() {
  const byId = {};
  const mk = (tag) => {
    const n = { tagName: tag.toUpperCase(), children: [], attrs: {}, value: "", checked: false, hidden: false, disabled: false, textContent: "", selected: false,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      setAttribute(k, v) { this.attrs[k] = v; if (k === "value") this.value = v; if (k === "id") byId[v] = this; },
      appendChild(c) { this.children.push(c); c.parentNode = this;
        const sel = (x) => x.selected ? x : x.children.map(sel).find(Boolean);
        const hit = sel(c); if (hit && this.tagName === "SELECT") this.value = hit.value; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      get firstChild() { return this.children[0] || null; },
      get options() { const out = []; const walk = (x) => x.children.forEach((c) => { if (c.tagName === "OPTION") out.push(c); else walk(c); }); walk(this); return out; },
      addEventListener() {} };
    Object.defineProperty(n, "className", { set(v) { v.split(/\s+/).forEach((c) => c && n.classList.add(c)); }, get() { return [...n.classList._s].join(" "); } });
    return n;
  };
  const doc = { createElement: mk, getElementById: (id) => byId[id] || null, _byId: byId };
  for (const id of ["r_owner", "r_owner_other", "r_remWrap", "r_rem", "r_remAt", "r_remGrp"]) { const n = mk(id === "r_owner" || id === "r_remAt" ? "select" : "input"); n.setAttribute("id", id); }
  return doc;
}

t("runsheet-remind.js: picks Team / Staff / Vendors, reads ids + reminder, shows who gets it", async () => {
  const doc = fakeDoc();
  const win = { document: doc };
  vm.runInNewContext(r("public/runsheet-remind.js"), { window: win, globalThis: win });
  const R = win.HelmRsRemind;
  assert.equal(R.offsetsText([0, 15]), "15 min before + at the start");
  assert.equal(R.offsetsText([60]), "1 hour before");
  const store = { people: { options: async () => [{ id: "c1", name: "Suresh", kind: "staff" }, { id: "v1", name: "Deccan", kind: "vendor" }] },
    automation: { settings: async () => ({ runsheet_offsets: [15, 0] }), teamOptions: async () => [{ id: "u1", name: "Ravi", role: "coordinator" }],
      runsheetTargets: async () => ({ enabled: true, items: [{ id: "i1", on: true, item_on: true, offsets: [15, 0], name: "Ravi", ways: ["bell", "email"] },
        { id: "i2", on: true, item_on: true, offsets: [15], ways: [] }, { id: "i3", on: true, item_on: true, needs_time: true, ways: ["bell"] }] }) } };
  await R.init(store);
  R.fillOwner("r", { owner: "Suresh" });
  assert.equal(doc.getElementById("r_owner").value, "staff:c1", "legacy typed name matched to the staff member");
  let o = R.readOwner("r");
  assert.deepEqual(J(o), { owner: "Suresh", owner_kind: "staff", owner_user_id: null, owner_crew_id: "c1", owner_vendor_id: null });
  doc.getElementById("r_owner").value = "user:u1";
  o = R.readOwner("r");
  assert.equal(o.owner, "Ravi"); assert.equal(o.owner_user_id, "u1"); assert.equal(o.owner_kind, "user");
  doc.getElementById("r_owner").value = "other"; doc.getElementById("r_owner_other").value = "Band";
  o = R.readOwner("r");
  assert.deepEqual(J(o), { owner: "Band", owner_kind: "other", owner_user_id: null, owner_crew_id: null, owner_vendor_id: null });
  doc.getElementById("r_rem").checked = true; doc.getElementById("r_remAt").value = "30"; doc.getElementById("r_remGrp").checked = true;
  assert.deepEqual(J(R.readRemind("r")), { remind: true, remind_offsets: [30], remind_group: true });
  doc.getElementById("r_remAt").value = "";
  assert.equal(R.readRemind("r").remind_offsets, null, "studio default");
  await R.loadTargets(store, "q1");
  assert.equal(R.tag("i1").textContent, "🔔 15 min before + at the start → Ravi (bell, e-mail)");
  assert.match(R.tag("i2").textContent, /No one to remind/);
  assert.match(R.tag("i3").textContent, /Add a start time/);
  assert.equal(R.tag("nope"), null);
});

t("runsheet-remind.js before 0269: old Staff + Vendors picker, no new fields sent", async () => {
  const doc = fakeDoc(); const win = { document: doc };
  vm.runInNewContext(r("public/runsheet-remind.js"), { window: win, globalThis: win });
  const R = win.HelmRsRemind;
  await R.init({ people: { options: async () => [{ id: "c1", name: "Suresh", kind: "staff" }] }, automation: { settings: async () => null } });
  R.fillOwner("r", null);
  doc.getElementById("r_owner").value = "staff:c1";
  assert.deepEqual(J(R.readOwner("r")), { owner: "Suresh" });
  assert.deepEqual(J(R.readRemind("r")), {});
  assert.equal(doc.getElementById("r_remWrap").hidden, true);
});

t("Control Center: Automations section + three cards + script, same hash in search", () => {
  const c = r("public/control.html"), s = r("public/control-split.js"), cat = r("public/search-catalog.js");
  for (const id of ["autoCard", "rsrCard", "enqCard"]) assert.match(c, new RegExp('<div class="card" id="' + id + '" hidden></div>'));
  assert.match(c, /<script src="automations\.js\?v=\d+"><\/script>/);
  assert.match(c, /HelmAutomations\.init\(\)/);
  assert.match(s, /\{key:"automations",group:"Communication",label:"Automations",\s*icon:"bolt",\s*hash:"#automations"/);
  assert.match(s, /if\(id==="autoCard"\|\|id==="rsrCard"\|\|id==="enqCard"\) return "automations";/);
  assert.match(cat, /key: "automations", label: "Automations",\s+hash: "#automations"/);
});

t("automations.js: every automation listed in plain words; switches call the existing settings RPCs only", async () => {
  const calls = [];
  const win = { BPStore: null };
  vm.runInNewContext(r("public/automations.js"), { window: win, document: {}, location: { origin: "https://helm.events" } });
  const A = { settings: async () => ({ runsheet_enabled: true, runsheet_offsets: [15, 0], enquiry_enabled: false }),
    save: async (p) => calls.push(["automation_settings_set", p]),
    optional: async (fn, args) => { calls.push([fn, args]); return fn.endsWith("_get") || fn === "admin_get_inbox_settings" ? null : {}; } };
  const S = { comms: { get: async () => ({ pay_enabled: false, pay_channels: [], fu_enabled: true, fu_channels: ["whatsapp"], low_stock_enabled: true }),
      set: async (p) => calls.push(["comms_settings_set", p]), reminderGet: async () => ({ days: 7 }) },
    deliveries: { settings: async () => ({ enabled: false }), saveSettings: async (p) => calls.push(["delivery_settings_set", p]) } };
  const reg = win.HelmAutomations.registry(S, A);
  const keys = reg.map((x) => x.key);
  assert.deepEqual(J(keys), ["event", "delivery", "runsheet", "pay", "overdue", "followup", "viewed", "expiry", "stock", "digest", "enquiry", "quoteLead"]);
  for (const it of reg) { assert.ok(it.name && it.what && it.where, it.key + " has plain words"); assert.ok(!/allocation|outsourc|partner|AXP/i.test(it.name + it.what + it.where), it.key + " no jargon"); }
  const by = Object.fromEntries(reg.map((x) => [x.key, x]));
  assert.deepEqual(J(by.runsheet.status(await by.runsheet.read())), { on: true, text: "15 min before + at the start" });
  assert.equal(by.overdue.status(await by.overdue.read()), null, "not installed -> Not set up yet");
  await by.pay.set(true, await by.pay.read());
  await by.followup.set(true, await by.followup.read());
  await by.delivery.set(true);
  await by.enquiry.set(true);
  await by.digest.set(false);
  await by.expiry.set(true);
  assert.deepEqual(J(calls).filter((c) => !/_get$|admin_get_/.test(c[0])), [
    ["comms_settings_set", { pay_enabled: true, pay_channels: ["email"] }],   // no channel yet -> e-mail
    ["comms_settings_set", { fu_enabled: true }],                              // keeps WhatsApp
    ["delivery_settings_set", { enabled: true }],
    ["automation_settings_set", { enquiry_enabled: true }],
    ["admin_set_inbox_settings", { p: { digest_default: "off" } }],
    ["quote_validity_settings_set", { p: { enabled: true } }]]);
  assert.equal(by.event.status({ days: 5 }).text, "Always on · 5 days before");
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(r("public/automations.js")), "DOM API only");
});

t("public enquiry page: routes, noindex, only the two public RPCs, no HTML sinks", () => {
  const v = JSON.parse(r("vercel.json"));
  assert.ok(v.rewrites.some((x) => x.source === "/([a-z0-9-]+)/enquiry" && x.destination === "/enquiry"));
  assert.match(r("server.js"), /\(dashboard\|quotes\|leads\|enquiry\|chat\|/);
  assert.match(r("public/_headers"), /\n\/:studio\/enquiry\n  X-Robots-Tag: noindex/);
  const js = r("public/enquiry.js"), html = r("public/enquiry.html");
  assert.deepEqual([...new Set([...js.matchAll(/rpc\("([a-z_]+)"/g)].map((m) => m[1]))].sort(), ["public_enquiry_info", "public_enquiry_submit"]);
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(js));
  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(html, /id="eq-website" tabindex="-1"/, "honeypot");
  assert.match(html, /id="eq-consent"/, "consent box");
  assert.ok(!/<script>/.test(html), "no inline script");
});

t("store-api: automation namespace, lead source label, bell label + links", () => {
  const api = r("public/store-api.js");
  assert.match(api, /rpc\("automation_settings_get"/);
  assert.match(api, /rpc\("runsheet_reminder_targets"/);
  assert.match(api, /vendorRequests, integrations, automation,/);
  assert.match(api, /enquiry_form: "Enquiry form"/);
  assert.match(api, /lead_new: \["📥"/);
  assert.match(api, /if \(k === "lead_new"\) return "leads\.html";/);
  assert.match(api, /k === "event_reminder" && d\.source === "0269"\) return "runsheet\.html\?quote="/);
});

for (const [name, fn] of queue) { await fn(); n++; console.log("ok -", name); }
console.log(`r24-automation: ${n} passed`);
