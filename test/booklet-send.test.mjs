// 0200 "Send to client" in the Share booklet dialog: the shared box (invite-site-share.js) with booklet
// adapters (booklet-share.js), store calls, comms-dispatch message (booklet-link.mjs), migration safety.
// No network, no DB, nothing is ever sent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };
const bk = read("public/booklet-share.js"), box = read("public/invite-site-share.js"), store = read("public/store-api.js");
const sql = read("supabase/migrations/0200_booklet_send.sql"), apply = read("supabase/APPLY-0200.sql"), man = read("supabase/migrations/MANIFEST");
const disp = read("supabase/functions/comms-dispatch/index.ts"), mailer = read("supabase/functions/client-mailer/index.ts");
const ems = read("public/email-send.js");
const { bookletMessage, bookletLink, BOOKLET_PATH } = await import("../supabase/functions/comms-dispatch/booklet-link.mjs");
const TOK = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

await t("dialog: shared Send to client box under the live link, booklet adapters, scripts pinned", () => {
  assert.match(bk, /mountSend\(box, quoteId, cur, url\);/);
  assert.match(bk, /S2C = global\.HelmSendToClient;/);
  assert.match(bk, /send: \(ch, to, optIn, consent\) => st\.booklet\.send\(quoteId, ch, to, optIn, consent\)/);
  assert.match(bk, /sendLog: \(\) => st\.booklet\.sendLog\(quoteId\)/);
  assert.match(bk, /gateText: "This booklet link has expired/);
  assert.match(bk, /const live = !cur\.expired && !!cur\.token;/);
  assert.doesNotMatch(bk, /innerHTML|insertAdjacentHTML/);
  for (const p of ["public/event.html", "public/client.html"]) assert.match(read(p), /<script src="invite-site-share\.js\?v=\d+"><\/script><script src="booklet-share\.js\?v=\d+"><\/script>/, p);
  assert.match(box, /window\.HelmSendToClient = window\.HelmInviteShare;/);
});
await t("preview text = what the server queues", () => {
  const ctx = { document: { querySelector: () => null }, console }; ctx.window = ctx; vm.createContext(ctx); vm.runInContext(bk, ctx);
  const B = ctx.HelmBookletShare;
  assert.equal(B.sendText({ client: { name: "  Asha   K " } }, "Sparkle Events", "https://www.helm.events/sparkle/booklet/" + TOK, "2026-11-17T18:29:59Z"),
    "Hi Asha K, here is your event booklet from Sparkle Events: https://www.helm.events/sparkle/booklet/" + TOK + " (valid until 17 Nov 2026)");
  assert.equal(B.sendText(null, "", "L", null), "Hi there, here is your event booklet from your event planner: L");
  assert.match(sql, /'Hi ' \|\| v_name \|\| ', here is your event booklet from ' \|\| v_studio \|\| ':'/);
  assert.match(sql, /to_char\(b\.expires_at at time zone 'Asia\/Kolkata', 'FMDD Mon YYYY'\)/);
});
await t("store: booklet.send / sendLog -> booklet_send RPCs", () => {
  assert.match(store, /send: \(quoteId, channel, to, optIn, consentText\) => rpc\("booklet_send", \{ p_quote: quoteId/);
  assert.match(store, /sendLog: \(quoteId\) => \(supa \? rpc\("booklet_send_log"/);
  assert.match(store, /case "booklet\.link_sent":/); assert.match(store, /booklet_link: \["📖"/);
});
await t("dispatcher: fixed greeting + APP_URL + path from the claim; anything odd -> empty (skipped)", () => {
  const ok = { body: "Hi Asha, here is your event booklet from Sparkle:", studio: "Sparkle", valid_until: "17 Nov 2026", link_path: "sparkle/booklet/" + TOK };
  assert.deepEqual(bookletMessage(ok, "https://www.helm.events"), { subject: "Your event booklet from Sparkle",
    text: "Hi Asha, here is your event booklet from Sparkle: https://www.helm.events/sparkle/booklet/" + TOK + " (valid until 17 Nov 2026)" });
  assert.equal(bookletLink({ link_path: "booklet?t=" + TOK }, "https://x.helm.events/"), "https://x.helm.events/booklet?t=" + TOK);
  for (const bad of [{ ...ok, link_path: "https://evil.test/x" }, { ...ok, link_path: "sparkle/booklet/not-a-token" }, { ...ok, link_path: undefined },
                     { ...ok, body: "Click here: http://evil" }, { ...ok, body: "" }])
    assert.equal(bookletMessage(bad, "https://www.helm.events").text, "", JSON.stringify(bad));
  assert.equal(bookletMessage(ok, "http://insecure.test").text, "");
  assert.equal(bookletMessage({ ...ok, valid_until: "<b>" }, "https://www.helm.events").text.includes("valid until"), false);
  assert.ok(BOOKLET_PATH.test("booklet?t=" + TOK));
  assert.match(disp, /if \(purpose === "booklet_link"\) return bookletMessage\(payload, origin\);/);
  assert.match(disp, /purpose === "invite_site" \|\| purpose === "booklet_link" \? "client_link"/);   // 0165 transactional footer
});
await t("migration: additive, idempotent, ASCII, token never stored, trial skip, manifest + APPLY verbatim + VERIFY", () => {
  assert.doesNotMatch(sql, /[^\x00-\x7f]/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bdrop\s+(table|function|trigger|index|column)\b|\bdelete\s+from\b|\btruncate\b/i);
  assert.match(sql, /comms_outbox_claim__pre0200/); assert.match(sql, /if to_regprocedure\('public\.comms_outbox_claim__pre0200\(integer\)'\) is null then/);
  assert.match(sql, /'payload', r\.payload \|\| jsonb_build_object\('link_path', v_path\)/);
  assert.doesNotMatch(sql.slice(sql.indexOf("insert into public.comms_outbox("), sql.indexOf("on conflict (dedupe_key)")), /token|link_path/);
  assert.match(sql, /v_blocked := public\._sample_outbound_blocked\(v_org, v_to\);/);
  assert.match(sql, /and not public\._sample_outbound_blocked\(r\.org_id, r\.recipient\)/);
  assert.match(sql, /if not \('booklet_link' = any \(v_vals\)\)/);
  assert.match(man, /forward  supabase\/migrations\/0200_booklet_send\.sql/);
  assert.ok(apply.includes(sql.trim()), "APPLY-0200 carries the migration verbatim");
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /-- VERIFY/);
});
await t("client-mailer (older Email booklet button): free trial -> test_mode, nothing sent", () => {
  assert.ok(mailer.indexOf("outboundBlocked(admin") > 0 && mailer.indexOf("outboundBlocked(admin") < mailer.indexOf("await sendMail("));
  assert.match(mailer, /status: "test_mode"/);
  assert.match(ems, /st === "test_mode"\) return TEST_MODE/); assert.match(ems, /if \(trial\) \{ btn\.disabled = false; btn\.textContent = SIM_LABEL;/);   // R114: preview, never sent
});

// run the shared box with the booklet adapters against a tiny fake DOM
function fakeDom() {
  const mk = (tag) => ({ tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, hidden: false, disabled: false, value: "", textContent: "", className: "", type: "", checked: false,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    get firstChild() { return this.children[0] || null; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); },
    fire(k) { (this.listeners[k] || []).forEach((f) => f({ stopPropagation() {} })); }, focus() {} });
  return { createElement: mk, activeElement: null };
}
function find(root, pred) { if (pred(root)) return root; for (const c of root.children || []) { const f = find(c, pred); if (f) return f; } return null; }
async function mountBooklet({ live = true, trial = false, answer = { status: "queued", masked: "a***@client.test" } } = {}) {
  const document = fakeDom(); const calls = [];
  const ctx = { document, console, Promise, Date, setTimeout }; ctx.window = ctx;
  ctx.BPStore = { waNumber: (r) => { const d = String(r || "").replace(/\D/g, ""); return d.length === 10 ? "91" + d : d; } };   // no sites API: adapters only
  ctx.BPUI = { guard: (b, f) => f(), toast() {} };
  vm.createContext(ctx); vm.runInContext(box, ctx);
  const host = document.createElement("div");
  const api = ctx.HelmSendToClient.mount(host, { ready: () => live, getLink: () => (live ? "https://www.helm.events/s/booklet/" + TOK : ""),
    getQuote: () => ({ client: { name: "Asha", email: "asha@client.test", phone: "98765 43210" } }), country: () => "IN",
    message: (q, link) => "Hi Asha, here is your event booklet from S: " + link, gateText: "This booklet link has expired — create a new link to send it.",
    logKey: () => "q1", send: (...a) => { calls.push(a); return Promise.resolve(answer); },
    sendLog: () => Promise.resolve([{ at: "2026-10-18T10:00:00Z", channel: "email", to: "a***@client.test", status: "sent" }]), trial: Promise.resolve(trial) });
  await new Promise((r) => setTimeout(r, 0));
  const by = (id) => find(host, (x) => x.id === id);
  return { api, calls, by, host };
}
await t("box + booklet adapters: prefilled e-mail, preview, send via adapter, log shown", async () => {
  const { calls, by } = await mountBooklet();
  assert.equal(by("ishTo").value, "asha@client.test");
  assert.match(by("ishPreview").textContent, /^Hi Asha, here is your event booklet from S: https:\/\/www\.helm\.events\/s\/booklet\//);
  assert.equal(by("ishGate").hidden, true); assert.equal(by("ishSend").disabled, false);
  by("ishSend").fire("click"); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls[0].slice(0, 3), ["email", "asha@client.test", false]);
  assert.match(by("ishMsg").textContent, /^Queued/);
  assert.equal(by("ishLog").children.length, 1);
});
await t("box + booklet adapters: WhatsApp sends the E.164 number with the opt-in tick", async () => {
  const { calls, by } = await mountBooklet();
  by("ishCh_email").checked = false; by("ishCh_whatsapp").checked = true; by("ishCh_whatsapp").fire("change");
  assert.equal(by("ishTo").value, "+919876543210");
  by("ishOpt").checked = true;
  by("ishSend").fire("click"); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls[0].slice(0, 3), ["whatsapp", "+919876543210", true]);
});
await t("box + booklet adapters: expired link -> gate with reason, send off; trial -> test mode note", async () => {
  const a = await mountBooklet({ live: false });
  assert.equal(a.by("ishGate").hidden, false); assert.match(a.by("ishGate").textContent, /expired/); assert.equal(a.by("ishSend").disabled, true);
  const b = await mountBooklet({ trial: true, answer: { status: "skipped", reason: "free_trial" } });
  // R114 (0323): a trial is a simulation - Preview, the server is never asked to send
  assert.equal(b.by("ishTrial").hidden, false); assert.match(b.by("ishTrial").textContent, /^Trial simulation \u2014 nothing is sent to your client\./);
  assert.match(b.by("ishSend").textContent, /^Preview \(trial/);
  b.by("ishSend").fire("click"); await new Promise((r) => setTimeout(r, 0));
  assert.match(b.by("ishMsg").textContent, /^Preview only .*nothing was sent to your client/);
  if (b.calls) assert.equal(b.calls.length, 0, "nothing sent");
});
console.log("booklet-send: " + n + " passed");
