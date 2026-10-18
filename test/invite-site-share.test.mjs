// 0195 "Send to client" on the Invitation Studio: UI box (invite-site-share.js), store calls,
// comms-dispatch message (invite-site.mjs) and the migration's safety rules. No network, no DB.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };
const page = read("public/invite-studio.html"), box = read("public/invite-site-share.js"), store = read("public/store-api.js");
const sql = read("supabase/migrations/0195_invite_site_share.sql"), apply = read("supabase/APPLY-0195.sql");
const disp = read("supabase/functions/comms-dispatch/index.ts");
const { inviteSiteMessage, inviteLink, INVITE_PATH } = await import("../supabase/functions/comms-dispatch/invite-site.mjs");

t("editor: Send to client box mounted under the public link, script pinned", () => {
  assert.match(page, /id="shareCard"[\s\S]*?<h2 id="shareTitle">Send to client<\/h2>[\s\S]*?id="shareHost"/);
  assert.match(page, /<script src="invite-site-share\.js\?v=\d+"><\/script>/);
  assert.match(page, /HelmInviteShare\.mount\(\$\("#shareHost"\)/);
  assert.match(page, /getLink:\(\)=>\(site&&site\.status==="published"&&site\.slug\)\?\$\("#pubLink"\)\.value:""/);
  assert.match(page, /id="copyBtn" type="button">Copy link</); assert.match(page, /id="openBtn"[^>]*>Open site</);
});
t("editor: trial asked from the server after init; photo refusals get a clear line", () => {
  assert.match(page, /BPStore\.subscription\.trial\(\)\)\.then\(t=>!!\(t&&t\.status==="trial"\)\)/);
  assert.match(page, /async function photoErr\(err\)/);
  assert.match(page, /storage is full\|too many uploads/); assert.match(page, /use \u201cAdd by URL\u201d instead/);
});
t("box: publish-first gate, trial note wording, consent text, no innerHTML, stays out of dirty tracking", () => {
  assert.match(box, /Publish first \u2014 then you can send the link to your client\./);
  assert.match(box, /Test mode \u2014 in the free trial we don't send real messages; copy the link instead\./);
  assert.match(box, /Client agreed to receive WhatsApp messages about this event/);
  assert.doesNotMatch(box, /innerHTML|insertAdjacentHTML|style=/);
  assert.match(box, /\["input", "change"\]\.forEach\(function \(t\) \{ box\.addEventListener\(t, function \(e\) \{ e\.stopPropagation\(\); \}\); \}\)/);
});

// run the box against a tiny fake DOM
function fakeDom() {
  const mk = (tag) => {
    const n = { tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, hidden: false, disabled: false, value: "", textContent: "", className: "", type: "", checked: false,
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      get firstChild() { return this.children[0] || null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return this.attrs[k]; },
      addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); },
      fire(k) { (this.listeners[k] || []).forEach((f) => f({ stopPropagation() {} })); }, focus() {} };
    return n;
  };
  return { createElement: mk, activeElement: null };
}
function find(root, pred) { if (pred(root)) return root; for (const c of root.children || []) { const f = find(c, pred); if (f) return f; } return null; }
async function mountBox({ status = "published", trial = false, sendImpl } = {}) {
  const document = fakeDom(); const calls = [];
  const ctx = { document, console, Promise, Date, setTimeout };
  ctx.window = ctx;
  ctx.BPStore = { waNumber: (r) => { const d = String(r || "").replace(/\D/g, ""); return d.length === 10 ? "91" + d : d; },
    sites: { send: (...a) => { calls.push(a); return sendImpl ? sendImpl(...a) : Promise.resolve({ status: "queued", masked: "a***@client.test" }); },
             sendLog: () => Promise.resolve([{ at: "2026-10-18T10:00:00Z", channel: "email", to: "a***@client.test", status: "pending" }]) } };
  ctx.BPUI = { guard: (b, f) => f(), toast() {} };
  vm.createContext(ctx); vm.runInContext(box, ctx);
  const host = document.createElement("div"); const site = { id: "s1", status, slug: "alice-1" };
  const api = ctx.HelmInviteShare.mount(host, { getSite: () => site, getQuote: () => ({ client: { name: "  Alice   Rao ", email: "alice@client.test", phone: "98765 43210" } }),
    getLink: () => status === "published" ? "https://www.helm.events/i/alice-1" : "", country: () => "IN", isDirty: () => false, trial: Promise.resolve(trial) });
  await new Promise((r) => setTimeout(r, 0));
  const by = (id) => find(host, (x) => x.id === id);
  return { host, api, calls, by, ctx };
}

const tests = [];
tests.push(["box: published - prefilled from the quote, preview is the fixed message, Send enabled", async () => {
  const { by } = await mountBox();
  assert.equal(by("ishTo").value, "alice@client.test");
  assert.equal(by("ishPreview").textContent, "Hi Alice Rao, here is your invitation website: https://www.helm.events/i/alice-1");
  assert.equal(by("ishSend").disabled, false); assert.equal(by("ishGate").hidden, true); assert.equal(by("ishTrial").hidden, true);
}]);
tests.push(["box: not published - Publish first shown, Send disabled", async () => {
  const { by } = await mountBox({ status: "draft" });
  assert.equal(by("ishGate").hidden, false); assert.equal(by("ishSend").disabled, true);
}]);
tests.push(["box: WhatsApp - quote mobile as E.164, opt-in tick sent, edited address used", async () => {
  const { by, calls } = await mountBox();
  const wa = by("ishCh_whatsapp"); by("ishCh_email").checked = false; wa.checked = true; wa.fire("change");
  assert.equal(by("ishTo").value, "+919876543210");
  by("ishOpt").checked = true;
  by("ishTo").value = "+91 90000 11111"; by("ishTo").fire("input");
  by("ishSend").fire("click"); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls[0].slice(0, 4), ["s1", "whatsapp", "+919000011111", true]);
  assert.match(by("ishMsg").textContent, /^Queued .* on WhatsApp/);
}]);
tests.push(["box: free trial - test-mode note + skipped answer explained", async () => {
  const { by } = await mountBox({ trial: true, sendImpl: () => Promise.resolve({ status: "skipped", reason: "free_trial" }) });
  assert.equal(by("ishTrial").hidden, false); assert.match(by("ishSend").textContent, /\(test mode\)$/);
  by("ishSend").fire("click"); await new Promise((r) => setTimeout(r, 0));
  assert.equal(by("ishMsg").textContent, "Test mode: nothing was sent (free trial). Use Copy link to share it yourself.");
}]);
tests.push(["box: server refusal wording shown as-is (opt-in / caps)", async () => {
  const err = Object.assign(new Error("This invitation was sent 10 times today - try again tomorrow."), { code: "HL429" });
  const { by } = await mountBox({ sendImpl: () => Promise.reject(err) });
  by("ishSend").fire("click"); await new Promise((r) => setTimeout(r, 0));
  assert.equal(by("ishMsg").textContent, err.message);
}]);

t("store: send / sendLog call the 0195 RPCs; activity + audit labels", () => {
  assert.match(store, /send: \(siteId, channel, to, optIn, consentText\) => rpc\("event_site_send", \{ p_site: siteId/);
  assert.match(store, /sendLog: \(siteId\) => \(supa \? rpc\("event_site_send_log"/);
  assert.match(store, /case "event_site\.link_sent":/); assert.match(store, /invite_site_link: \["/);
  assert.match(store, /if \(k === "invite_site_link"\) return "invite-studio\.html\?quote=" \+ enc\(q\);/);
});
t("dispatcher: invite_site message = fixed greeting + APP_URL + path; anything odd -> empty (skipped)", () => {
  const ok = inviteSiteMessage({ body: "Hi Alice, here is your invitation website:", link_path: "studio-a/invite/alice-and-sam-1a2b", studio: "Studio A" }, "https://www.helm.events/");
  assert.equal(ok.text, "Hi Alice, here is your invitation website: https://www.helm.events/studio-a/invite/alice-and-sam-1a2b");
  assert.equal(ok.subject, "Your invitation website from Studio A");
  assert.equal(inviteLink({ link_path: "i/abc-1" }, "https://staging.example.com"), "https://staging.example.com/i/abc-1");
  for (const p of ["https://evil.example/x", "i/../x", "//evil/i/x", "i/a b", "Studio/invite/x", "i/"]) assert.equal(inviteLink({ link_path: p }, "https://www.helm.events"), "", p);
  assert.equal(inviteLink({ link_path: "i/x" }, "http://www.helm.events"), "");
  assert.equal(inviteSiteMessage({ body: "Buy cheap stuff", link_path: "i/x" }, "https://www.helm.events").text, "");
  assert.equal(inviteSiteMessage({ text: "old shape", link_path: "i/x" }, "https://www.helm.events").text, "");
  assert.ok(INVITE_PATH.test("i/a"));
  assert.match(disp, /if \(purpose === "invite_site"\) return inviteSiteMessage\(payload, origin\);/);
  assert.match(disp, /txFooter\(purpose === "invite_site"(?: \|\| purpose === "booklet_link")? \? "client_link" : "pay_reminder"/);
});
t("migration: server-side rules (published, quotes EDIT, trial skip via 0166, opt-in, STOP, caps, no URL stored)", () => {
  assert.match(sql, /has_area\('quotes', 'edit'\)/);
  assert.match(sql, /s\.status is distinct from 'published'/);
  assert.match(sql, /public\._sample_outbound_blocked\(v_org, v_to\)/);
  assert.match(sql, /public\._wa_opted_out\(v_to, v_org\)/);
  assert.match(sql, /wa_proposal_optins/); assert.match(sql, /errcode = 'HL429'/);
  assert.match(sql, /'link_path', v_path/); assert.doesNotMatch(sql, /'text',\s*v_body/);
  assert.match(sql, /rename to comms_outbox_claim__pre0195/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b/i);
  assert.ok(/^[\x00-\x7F]*$/.test(sql), "ASCII only"); assert.ok(/^[\x00-\x7F]*$/.test(apply), "APPLY ASCII only");
  assert.match(apply, /-- VERIFY/); assert.match(read("supabase/migrations/MANIFEST"), /forward\s+supabase\/migrations\/0195_invite_site_share\.sql/);
});

for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } }
console.log("invite-site-share: " + n + " passed");
