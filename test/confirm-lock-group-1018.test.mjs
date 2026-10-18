// confirm-1018: (1) Confirm & lock pricing - coupon and discount each their own line, one rule (both off the
// subtotal, GST after), same total as the server; (2) event group "Add people" really adds team / staff /
// vendors / client (0194) and never sends anything; (3) studio pages pick up the client's approval without a
// reload; (4) "Save & back" on the workspace sub-pages. Tiny fake DOM, no browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

/* ---------------- (1) pricing ---------------- */
// the shipping engine (store-api.js _canon + quoteTotal), extracted like tests/db/pricing-parity.mjs
const storeApi = read("public/store-api.js");
function extractFn(src, startToken) {
  const i = src.indexOf(startToken); if (i < 0) throw new Error("not found: " + startToken);
  const open = src.indexOf("{", i); let depth = 0, j = open;
  for (; j < src.length; j++) { const c = src[j]; if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) { j++; break; } } }
  return src.slice(open, j);
}
const engine = {}; engine._canon = new Function("a", "return ((a)=>" + extractFn(storeApi, "_canon(a)") + ")(a)");
engine.quoteTotal = new Function("p", "const self=this; return ((p)=>{const this_=self;" +
  extractFn(storeApi, "quoteTotal(p)").replace(/^\{/, "").replace(/\}$/, "").replace(/this\._canon/g, "this_._canon") + "})(p)").bind({ _canon: (a) => engine._canon(a) });
const qs = {}; vm.createContext(qs); vm.runInContext(read("public/quote-state.js"), qs);
const PL = qs.HelmPriceLines;
ok(PL && typeof PL.discountLines === "function" && typeof PL.discountProblem === "function", "HelmPriceLines exported");

// the owner's quote 10182026-02: 42,000 chairs x 150 + decor/setup 1,10,000; 60,000 plates x 450; coupon Rs 1,000 + 5%
const owner = { chairs: 42000, chairPrice: 150, other: 110000, guests: 60000, platePrice: 450, gstPct: 18, serviceChargePct: 0,
  ...qs.HelmDiscount.pick("0", "5"), couponCode: "DEMO WELCOME BACK", coupon: { kind: "flat", value: 1000 }, catering: { mode: "inhouse", amount: 0 } };
const t = engine.quoteTotal(owner);
ok(t.subtotal === 33410000, "subtotal = chairs + decor/setup + plates");
const lines = PL.discountLines(owner, t);
ok(lines.length === 2 && lines[0].key === "coupon" && lines[1].key === "discount", "coupon and discount are two lines, coupon first");
ok(lines[0].label === "Coupon DEMO WELCOME BACK" && lines[0].amount === 1000, "coupon line names the code and takes Rs 1,000");
ok(lines[1].label === "Discount 5%" && lines[1].amount === 1670500, "5% line is 5% of the subtotal");
ok(lines[0].amount + lines[1].amount === t.discount, "the lines add up to the discount the total uses");
ok(t.total === 37451430, "GST is charged after both discounts: (33,410,000 - 1,671,500) x 1.18 = 37,451,430");
// same rule on the server (the parity case + the 0194 DB suite run the real SQL); the formula text says so
const canonSql = read("supabase/migrations/0001_pricing_authority.sql");
ok(/discount := disc_fixed \+ subtotal \* disc_pct \/ 100;/.test(canonSql) && /discount := discount \+ c_val;/.test(canonSql) && /taxed := greatest\(0, subtotal - discount\);/.test(canonSql),
  "server authority: fixed + % + coupon off the subtotal, GST on the rest");
ok(/'flat coupon \+ percent discount \(42,000 chairs \/ 60,000 plates\)'/.test(read("tests/db/pricing-parity.mjs")), "pricing parity covers the owner's case");
// cap: coupon first, then the manual discount fills what is left - lines still add up
{ const p = { other: 10000, gstPct: 18, discount: 9500, discountPct: 0, couponCode: "BIG", coupon: { kind: "flat", value: 2000 } };
  const tt = engine.quoteTotal(p), l = PL.discountLines(p, tt);
  ok(l[0].amount === 2000 && l[1].amount === 8000 && tt.discount === 10000 && tt.total === 0, "over the subtotal: capped, lines add up to the subtotal");
  ok(/Coupon \+ discount is more than the subtotal/.test((PL.discountProblem(p, tt, ["BIG"]) || {}).message || ""), "coupon + discount over the subtotal is flagged"); }
{ const p = { other: 10000, gstPct: 18, discount: 12000, discountPct: 0 }; const tt = engine.quoteTotal(p);
  ok((PL.discountProblem(p, tt, []) || {}).field === "amount", "a Rs discount over the subtotal is flagged"); }
{ const p = { other: 10000, gstPct: 18, couponCode: "OLD10", coupon: null }; const tt = engine.quoteTotal(p);
  const pb = PL.discountProblem(p, tt, ["NEW5"]); ok(pb && pb.field === "coupon" && /no longer active/.test(pb.message), "a coupon that is no longer active is flagged"); }
ok(PL.discountProblem({ discountPct: "120" }, { subtotal: 100 }, []).message === "Discount % can't be more than 100.", "discount % over 100 refused");
ok(PL.discountProblem({ discount: 0, discountPct: 5, couponCode: "A", coupon: { kind: "percent", value: 10 } }, { subtotal: 1000 }, ["a"]) === null, "valid coupon + % is fine (code match ignores case)");
{ const p = { other: 1000, gstPct: 18, couponCode: "P10", coupon: { kind: "percent", value: 10 } }; const l = PL.discountLines(p, engine.quoteTotal(p));
  ok(l.length === 1 && l[0].label === "Coupon P10 (10%)" && l[0].amount === 100, "percent coupon line"); }

// the modal: own lines, clear labels, the rule on screen, a no-longer-active coupon kept visible + blocking
const qh = read("public/quotes.html");
ok(/HelmPriceLines\.discountLines\(p, t\)\.map\(l=>`<div class="r cm-disc"/.test(qh), "Confirm & lock shows each discount line");
ok(qh.indexOf("dLines+") > qh.indexOf('<span>Subtotal</span>') && qh.indexOf("taxRows+", qh.indexOf("dLines+")) > qh.indexOf("dLines+"), "order: subtotal, discounts, taxable value, then tax");
ok(/Taxable value \(after discounts\)/.test(qh), "taxable value line");
ok(/Décor, equipment &amp; setup fee \(from the layout\)/.test(qh) && !/\+ other \$\{inr\(p\.other\)\}/.test(qh), "'other' is labelled as decor, equipment & setup fee");
ok(/Extra catering charge ₹ \(on top of the plates\)/.test(qh) && /<span>Extra catering charge<\/span>/.test(qh), "extra catering charge labelled in the field and the breakdown");
ok(/id="discRule">How discounts work: the coupon and the discount both come off the subtotal/.test(qh), "the rule is written under the fields");
ok(/data-inactive="1">\$\{esc\(savedCode\)\} \(no longer active\)/.test(qh) && /pb\.field==="coupon"\?\$\("#p_coupon"\)/.test(qh), "saved inactive coupon stays visible and blocks the save");
ok(/\["p_camount","Extra catering charge","money"\]/.test(qh), "extra catering charge validated inline (no negatives)");
ok(/HelmPriceLines\.discountLines\(p,t\)/.test(read("public/flow.html")), "quote flow shows the same discount lines");

/* ---------------- fake DOM ---------------- */
function makeDom() {
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.ls = {}; this.hidden = false; this.className = ""; this._t = ""; this.value = ""; this.checked = false; this.disabled = false; this.type = ""; this.parentNode = null;
      this.classList = { add: (c) => { if (!this.className.split(" ").includes(c)) this.className = (this.className + " " + c).trim(); }, remove: (c) => { this.className = this.className.split(" ").filter((x) => x && x !== c).join(" "); }, contains: (c) => this.className.split(" ").includes(c) }; }
    set id(v) { this.attrs.id = v; } get id() { return this.attrs.id || ""; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
    set textContent(v) { this._t = String(v); this.children = []; } get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
    addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
    async fire(t) { const e = { type: t, target: this, preventDefault() {} }; for (const f of this.ls[t] || []) await f(e); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); }
    all() { return this.children.flatMap((c) => [c, ...c.all()]); }
    querySelector(q) { return this.querySelectorAll(q)[0] || null; }
    querySelectorAll(q) { if (q[0] === "#") return this.all().filter((e) => e.id === q.slice(1)); if (q === "input:checked") return this.all().filter((e) => e.tagName === "INPUT" && e.checked); if (q === "input") return this.all().filter((e) => e.tagName === "INPUT"); return []; }
    focus() {}
  }
  const body = new El("body"); const docLs = {};
  const document = { body, createElement: (t) => new El(t), addEventListener: (t, f) => { (docLs[t] = docLs[t] || []).push(f); }, removeEventListener() {}, visibilityState: "visible",
    querySelector: (q) => body.querySelector(q) };
  return { El, body, document };
}

/* ---------------- (2) event group: add people ---------------- */
const picker = read("public/event-group-picker.js");
function pickerCtx(over) {
  const { body, document } = makeDom(); const calls = { create: [], add: [], toast: [] };
  const cx = { document, console, setTimeout: (f) => f(), Set, Promise, Array, Object, String, JSON, location: { href: "quotes.html" } };
  cx.window = cx;
  cx.BPUI = { guard: (el, fn) => fn(), toast: (m, o) => calls.toast.push(m), friendlyError: (e) => String(e && e.message || e), isMissingFunction: (e) => !!(e && e.code === "PGRST202") };
  cx.BPStore = Object.assign({
    auth: { user: () => ({ id: "me" }), admin: { roleLabel: (r) => r } },
    chat: { me: async () => ({ id: "me" }), displayName: (p) => p.full_name, paintAvatars() {},
      roster: async () => [{ id: "me", full_name: "Uma Owner", role: "owner" }, { id: "u2", full_name: "Kiran Admin", role: "admin" }, { id: "u3", full_name: "Sita Sales", role: "sales" }],
      eventGroups: { create: async (q, ids) => { calls.create.push([q, ids]); return "conv-1"; }, index: async () => ({ q1: { conversation_id: "conv-1", is_member: true } }),
        addPeople: async (c, people) => { calls.add.push([c, people]); return { users: 1, contacts: 3, skipped: 0, trial: true, messages_sent: 0 }; },
        contacts: async () => [{ id: "k1", kind: "vendor", ref_id: "v1", name: "Lotus Caterers" }] } },
    staff: { list: async () => [{ id: "s1", name: "Ravi Decor", role: "Decor lead", active: true }, { id: "s2", name: "Kiran (login)", profile_id: "u2", active: true }, { id: "s3", name: "Old helper", active: false }],
      forEvent: async () => [{ crew_id: "s1", name: "Ravi Decor" }] },
    vendors: { list: async () => [{ id: "v1", name: "Lotus Caterers", category: "Catering", active: true }, { id: "v2", name: "Bloom Florists", category: "Flowers", active: true }] },
    bookings: { list: async () => [{ vendor_id: "v1" }] },
    quotes: { get: async () => ({ id: "q1", client: { name: "Uma Rao" } }) },
  }, over || {});
  vm.createContext(cx); vm.runInContext(picker, cx);
  return { cx, body, calls };
}
{ const { cx, body, calls } = pickerCtx();
  await cx.HelmEventGroupPicker.open({ id: "q1", code: "10182026-02", status: "confirmed", client: { name: "Uma Rao" } }, { canEdit: true });
  const list = body.querySelector("#egp_list"), boxes = list.querySelectorAll("input");
  const vals = boxes.map((i) => i.value);
  ok(vals.includes("user:u2") && vals.includes("user:u3") && !vals.includes("user:me"), "team lists teammates, not me");
  ok(vals.includes("staff:s1") && !vals.includes("staff:s2") && !vals.includes("staff:s3"), "staff listed (login-linked staff shown once, as a teammate; inactive hidden)");
  ok(vals.includes("vendor:v1") && vals.includes("vendor:v2") && vals.includes("client:"), "vendors and the client listed");
  ok(/Team \(signs in to Helm\)StaffVendorsClient/.test(list.all().filter((e) => e.className === "egp-sec").map((e) => e.textContent).join("")), "grouped into Team / Staff / Vendors / Client");
  const checked = list.querySelectorAll("input:checked").map((i) => i.value).sort();
  ok(JSON.stringify(checked) === JSON.stringify(["staff:s1", "user:u2"]), "pre-ticked: admins + the staff on this event");
  ok(/Helm sends them nothing - no WhatsApp, SMS or e-mail/.test(body.querySelector("#egp_note").textContent), "says nothing is sent");
  boxes.forEach((i) => { if (i.value === "vendor:v1" || i.value === "client:") i.checked = true; });
  await body.querySelector("#egp_create").fire("click");
  ok(calls.create.length === 1 && JSON.stringify(calls.create[0][1]) === '["u2"]', "create gets the teammates");
  const sent = calls.add[0] && calls.add[0][1];
  ok(calls.add.length === 1 && calls.add[0][0] === "conv-1" && sent.length === 4
     && sent.some((p) => p.kind === "staff" && p.id === "s1") && sent.some((p) => p.kind === "vendor" && p.id === "v1") && sent.some((p) => p.kind === "client" && !("id" in p)), "then addPeople gets everyone ticked");
  ok(/Added 1 teammate and 3 contacts .* Free trial: no WhatsApp message is sent/.test(calls.toast.join(" ")), "toast: who was added + no WhatsApp in the trial");
  ok(cx.location.href === "chat.html?c=conv-1", "opens the group chat"); }
// the group already existed (create returns it): the picks are still added (used to be dropped silently)
{ const { cx, body, calls } = pickerCtx();
  cx.BPStore.chat.eventGroups.create = async () => "conv-old"; cx.BPStore.chat.eventGroups.index = async () => ({ q1: { conversation_id: "conv-old", is_member: true } });
  await cx.HelmEventGroupPicker.open({ id: "q1", code: "X", status: "confirmed" }, { canEdit: true });
  await body.querySelector("#egp_create").fire("click");
  ok(calls.add.length === 1 && calls.add[0][0] === "conv-old", "existing group: people still added to it"); }
// add mode (chat): current members + contacts are not offered again
{ const { cx, body, calls } = pickerCtx(); let done = 0;
  await cx.HelmEventGroupPicker.open({ id: "q1", code: "X", status: "confirmed" }, { canEdit: true, mode: "add", conversationId: "conv-1", memberIds: ["u2"], onDone: () => done++ });
  const vals = body.querySelector("#egp_list").querySelectorAll("input").map((i) => i.value);
  ok(!vals.includes("user:u2") && !vals.includes("vendor:v1") && vals.includes("vendor:v2"), "add mode hides who is already in the group");
  body.querySelector("#egp_list").querySelectorAll("input").forEach((i) => { if (i.value === "vendor:v2") i.checked = true; });
  await body.querySelector("#egp_create").fire("click");
  ok(calls.create.length === 0 && calls.add.length === 1 && done === 1, "add mode: addPeople only, then refresh"); }
// store + server contract
ok(/async addPeople\(convId, people\)[\s\S]*?rpc\("event_group_add_people", \{ p_conversation: convId, p_people: list \}\)/.test(storeApi), "store: addPeople -> event_group_add_people");
ok(/from\("chat_group_contacts"\)\.select\("id,kind,ref_id,name,created_at"\)/.test(storeApi), "store: contacts read (name only, no phone)");
const mig = read("supabase/migrations/0194_event_group_people.sql");
ok(!/[^\x00-\x7F]/.test(mig), "0194 is ASCII");
ok(/create table if not exists public\.chat_group_contacts/.test(mig) && !/drop table|delete from|truncate/i.test(mig), "0194 additive (no drop / delete)");
ok(!/\bphone\b\s+text|\bemail\b\s+text/.test(mig), "0194 keeps no phone / e-mail");
ok(/'messages_sent', 0/.test(mig) && !/outbox|notify|whatsapp_send/i.test(mig.replace(/^--.*$/gm, "")), "0194 sends nothing");
ok(/forward  supabase\/migrations\/0194_event_group_people\.sql/.test(read("supabase/migrations/MANIFEST")), "0194 in MANIFEST");
ok(/run "event-group-people-0194"/.test(read("scripts/db-test/run-all.sh")), "0194 DB suite registered");
const chat = read("public/chat.html");
ok(/event-group-picker\.js\?v=\d+/.test(chat) && /function peopleModal\(\)/.test(chat) && /thread\.contacts=await BPStore\.chat\.eventGroups\.contacts\(c\.id\)/.test(chat), "chat: Add people + People in this group + contacts in the header");
ok(/HelmEventGroupPicker\.open\(q,\{canEdit, onDone/.test(qh), "quotes uses the shared picker");

/* ---------------- (3) approval watch ---------------- */
{ const { document } = makeDom(); const toasts = []; let changes = 0; const timers = [];
  const cx = { document, console, setInterval: (f) => { timers.push(f); return 1; }, clearInterval() {}, addEventListener() {}, removeEventListener() {}, Date, Promise };
  cx.window = cx; cx.BPUI = { toast: (m) => toasts.push(m) };
  vm.createContext(cx); vm.runInContext(read("public/approval-watch.js"), cx);
  const W = cx.HelmApprovalWatch;
  ok(JSON.stringify(W.pending([{ id: "a", approvalStatus: "sent" }, { id: "b", approvalStatus: "approved" }, { id: "c", status: "cancelled" }, { id: "d" }])) === '["a","d"]', "only quotes still waiting are polled");
  const page = { a: { status: "quote", approvalStatus: "sent" } };
  let server = [{ id: "a", code: "10182026-02", status: "quote", approvalStatus: "sent" }]; let asked = 0;
  const w = W.start({ ids: () => ["a"], known: (id) => page[id], fetch: async () => { asked++; return server; }, onChange: () => { changes++; } });
  await w.check(); ok(asked === 1 && changes === 0 && toasts.length === 0, "no change -> nothing happens");
  server = [{ id: "a", code: "10182026-02", status: "confirmed", approvalStatus: "approved" }];
  await new Promise((r) => setTimeout(r, 5)); await w.check();
  ok(changes === 1 && toasts[0] === "Client approved: 10182026-02.", "client approved -> toast + the page refreshes");
  document.visibilityState = "hidden"; const before = asked; await w.check(); ok(asked === before, "hidden tab: no polling");
  ok(timers.length === 1, "one ~15 s timer"); }
ok(/approval-watch\.js\?v=\d+/.test(qh) && /HelmApprovalWatch\.start\(\{/.test(qh), "quotes list watches approvals");
ok(/approval-watch\.js\?v=\d+/.test(read("public/event.html")) && /startApprovalWatch\(\);/.test(read("public/event.html")), "event workspace watches approvals");
ok(/approval-watch\.js\?v=\d+/.test(read("public/flow.html")) && /if\(!unsaved\(\) && !loading\)/.test(read("public/flow.html")), "quote flow watches approvals (keeps unsaved edits)");
ok(/async approvalStates\(ids\)[\s\S]*?select\("id,code,status,approval_status,updated_at"\)/.test(storeApi), "lean approval read");

/* ---------------- (4) Save & back ---------------- */
{ const { El, body, document } = makeDom(); const cx = { document, console, location: { href: "plan.html" } }; cx.window = cx; cx.BPUI = { allowUnload() { cx.unload = 1; } };
  vm.createContext(cx); vm.runInContext(read("public/save-back.js"), cx);
  const SB = cx.HelmSaveBack;
  ok(SB.label("https://x/event.html?id=1") === "Save & back to event" && SB.label("quotes.html") === "Save & back to quotes" && SB.label("/flow?quote=1") === "Save & back to quote", "label follows where Back goes");
  const foot = new El("div"), save = new El("button"), msg = new El("span"), back = new El("a");
  save.id = "v_save"; msg.id = "v_msg"; back.id = "backLink"; back.setAttribute("href", "event.html?id=1"); back.href = "https://helm/event.html?id=1";
  foot.appendChild(msg); foot.appendChild(save); body.appendChild(foot); body.appendChild(back);
  let result = "err";
  const b = SB.add({ button: save, msg, back, run: async () => { msg.className = result; } });
  ok(b && foot.children[2] === b && b.textContent === "Save & back to event", "button sits right after Save");
  await b.fire("click"); ok(cx.location.href === "plan.html", "failed save stays on the page");
  result = "ok"; await b.fire("click"); ok(cx.location.href === "https://helm/event.html?id=1" && cx.unload === 1, "saved -> back to the event");
  save.hidden = true; save.disabled = true; }
for (const [pg, btns] of [["plan", ["#v_save", "#p_save"]], ["discovery", ["#d_save"]], ["proposal", ["#p_save"]], ["closure", ["#c_save"]]]) {
  const h = read("public/" + pg + ".html");
  ok(/save-back\.js\?v=\d+/.test(h) && btns.every((s) => h.includes('HelmSaveBack.add({ button:"' + s + '"')), pg + ": Save & back wired");
}
console.log(`confirm-lock-group-1018: ${n} checks passed`);
