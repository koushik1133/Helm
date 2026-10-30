// r29 referral program PHASE 2 (SQL 0279): the pages call only RPCs that 0279 creates, the sign-up flow attaches the code
// once, the bell routes referral notices to /refer, /r/<code> redirects on Vercel, and the SQL stays additive (no delete /
// drop / truncate of data, every function has a pinned search_path, the APPLY file carries the migration verbatim).
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0;
const t = (name, fn) => { fn(); n++; };

const sql = read("supabase/migrations/0279_referral_program.sql");
const apply = read("supabase/APPLY-0279.sql");
const sched = read("supabase/SCHEDULE-0279.sql");
const fnNames = new Set([...sql.matchAll(/create or replace function public\.([a-z0-9_]+)\(/g)].map((m) => m[1]));

t("the APPLY file is the migration, wrapped in begin / commit, with VERIFY rows", () => {
  assert.ok(apply.includes(sql), "APPLY-0279 contains 0279 verbatim");
  assert.ok(apply.indexOf("begin;") < apply.indexOf(sql) && apply.indexOf("commit;") > apply.indexOf(sql));
  assert.match(apply, /-- VERIFY \(every row must say ok = true\)/);
  assert.match(apply, /OWNER STEPS/);
});
t("ASCII only, additive only: no delete / drop table / truncate / drop column / drop function", () => {
  for (const [f, src] of [["0279", sql], ["APPLY", apply], ["SCHEDULE", sched]]) {
    assert.doesNotMatch(src, /[^\x00-\x7f]/, f + " is ASCII");
    // r29c REF-03: the ONE allowed delete - expired hour-window rate counters (nothing about a person), in referral_tick
    const RB = /delete from public\.referral_rate_buckets where window_start < now\(\) - interval '2 hours';/g;
    assert.ok((src.match(RB) || []).length <= 1, f + ": the rate-counter cleanup appears at most once");
    const code = src.replace(RB, "").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").replace(/'[^'\n]*'/g, "''");
    assert.doesNotMatch(code, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b|\bdrop\s+column\b|\bdrop\s+function\b|\bdrop\s+schema\b/i, f + ": nothing removed");
  }
});
t("every function pins search_path; definer functions are not callable by anon unless public by design", () => {
  const bodies = sql.split(/create or replace function /).slice(1);
  for (const b of bodies) assert.match(b.slice(0, 600), /set search_path = ''/, "search_path pinned: " + b.slice(0, 40));
  const anon = [...sql.matchAll(/'public\.([a-z_]+)\([^']*\)'/g)].map((m) => m[1]);
  assert.ok(anon.length > 20);
  assert.match(sql, /array\['public\.referral_lookup\(text\)', 'public\.referral_click\(text\)'\] loop/, "only lookup + click are public");
});
t("the program starts OFF and the schedule is pg_cron-only, outside the migration", () => {
  assert.match(sql, /program_on\s+boolean not null default false/);
  assert.doesNotMatch(sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"), /cron\.schedule/, "the migration never schedules");
  assert.match(sched, /if not exists \(select 1 from pg_extension where extname = 'pg_cron'\)/);
  assert.match(sched, /cron\.schedule\('helm_referral_tick', '5 0 \* \* \*', 'select public\.referral_tick\(\)'\)/);
});
t("owner decisions are in the SQL: 14-day hold, 60 days, cap 12, held 6, frozen 6, expiry 24, write-off, never cash", () => {
  for (const re of [/hold_days\s+integer not null default 14/, /pay_within_days\s+integer not null default 60/, /cap_per_year\s+integer not null default 12/,
    /held_months\s+integer not null default 6/, /frozen_months\s+integer not null default 6/, /expiry_months\s+integer not null default 24/,
    /'written_off' else 'reversed'/, /partner_reward in \('none', 'tracking', 'months'\)/]) assert.match(sql, re);
});
t("the two money triggers never block a payment / subscription change", () => {
  for (const f of ["tg_r29_payment", "tg_r29_subscription"]) {
    const b = sql.slice(sql.indexOf("function public." + f + "()"), sql.indexOf("end $$;", sql.indexOf("function public." + f + "()")));
    assert.match(b, /exception when others then/, f + " catches errors");
    assert.match(b, /'referral\.error'/, f + " logs them");
    assert.match(b, /return null;/);
  }
  assert.match(sql, /create trigger r29_payment after insert or update of voided_at on public\.subscription_payments/);
  assert.match(sql, /create trigger r29_subscription after update of status on public\.studio_subscriptions/);
});
t("every RPC the pages call exists in 0279", () => {
  const files = ["public/store-api.js", "public/hq-referrals.js"];
  const called = new Set();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/rpc\("((?:my_referral|referral_[a-z_]+))"/g)) called.add(m[1]);
    for (const m of src.matchAll(/call\("(hq_[a-z_]+)"/g)) called.add(m[1]);
  }
  for (const c of ["my_referral", "referral_lookup", "referral_click", "referral_attach", "hq_referral_overview", "hq_referrals",
    "hq_referral_rewards", "hq_partner_codes", "hq_partner_signups", "hq_partner_code_upsert", "hq_partner_code_set_active",
    "hq_referral_decide", "hq_referral_reward_action", "hq_referral_settings_set", "hq_referral_run_tick"]) assert.ok(called.has(c), "page calls " + c);
  for (const c of called) assert.ok(fnNames.has(c), c + " is created by 0279");
});
t("store-api: referral API + the sign-up note + bell routing", () => {
  const s = read("public/store-api.js");
  assert.match(s, /referral: \{\n\s+deviceId\(\)/);
  assert.match(s, /helm_signup_ref: \{ code: String\(rf\.code\)/, "the code travels with the account (confirm in another browser)");
  assert.match(s, /p_typed: typed \|\| null, p_link: link \|\| null, p_link_at: linkAt/);
  assert.match(s, /Date\.now\(\) - lk\.at < 60 \* 864e5/, "a link counts for 60 days");
  assert.match(s, /if \(k === "trial_reminder" && d\.source === "r29_referral"\) return "refer\.html";/);
  assert.match(read("supabase/functions/comms-dispatch/deeplink.js"), /if \(k === "trial_reminder" && d\.source === "r29_referral"\) return "refer\.html";/, "WhatsApp forward deep links match the bell");
  assert.match(s, /"hq-referrals": 1/, "no studio search on the HQ page");
  const f = read("public/signup-flow.js");
  assert.equal((f.match(/B\.referral\.attachPending\(\)/g) || []).length, 2, "both the trial and the paid path attach the code once");
  for (const blk of f.split("B.referral.attachPending()").slice(0, 2)) assert.match(blk.slice(-400), /initCurrency/, "after the studio exists");
});
t("the referral device id is random, local, and shaped for the server check", () => {
  const s = read("public/store-api.js");
  const at = s.indexOf("deviceId() {"), body = s.slice(at, s.indexOf("mine: () =>", at));
  const store = {}; const win = { localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); } },
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } } };
  const fn = vm.runInNewContext("(function(global){ return {" + body + "}; })", {})(win);
  const id = fn.deviceId(); assert.match(id, /^[A-Za-z0-9_-]{8,64}$/); assert.equal(fn.deviceId(), id, "kept");
});
t("refer.js reads the server answer; the HQ page reads only hq_* RPCs behind the HQ gate", () => {
  const r = read("public/refer.js");
  assert.match(r, /S\.referral\.mine\(\)/);
  assert.match(r, /r\.program_on === false/, "program off -> coming soon");
  assert.match(r, /Only the studio owner or admin can see this/);
  const h = read("public/hq-referrals.js");
  assert.match(h, /S\.errKind\(e\)/); assert.match(h, /k === "reauth"\) return askCode\(\)/, "fresh two-step code then retry");
  assert.match(read("public/hq.html"), /data-perm="inbox\.read"[^\n]*href="\/hq-referrals"/, "HQ links the page for roles that may read it");
});
t("vercel: /r/:code -> /signup?ref=:code (strict shape, temporary)", () => {
  const v = JSON.parse(read("vercel.json"));
  const r = v.redirects.find((x) => x.source.startsWith("/r/"));
  assert.ok(r); assert.equal(r.destination, "/signup?ref=:code"); assert.equal(r.permanent, false);
  assert.equal(r.source, "/r/:code([A-Za-z0-9][A-Za-z0-9_-]{2,23})");
  assert.ok(v.redirects.indexOf(r) >= 2, "after the host canonical redirects");
  assert.ok(Buffer.byteLength(read("vercel.json")) < 204800, "vercel.json stays under 200 KB");
});
t("DB suite + MANIFEST registered", () => {
  assert.match(read("supabase/migrations/MANIFEST"), /^forward  supabase\/migrations\/0279_referral_program\.sql$/m);
  assert.match(read("scripts/db-test/run-all.sh"), /run "r29-referrals-0279" "R29-REFERRALS-0279: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r29-referrals-0279\.sql/);
});
t("terms stay a draft; no cash; write-off promise matches the server", () => {
  const terms = read("public/referral-terms.html");
  assert.match(terms, /Draft: the program is not live yet/);
  assert.match(terms, /we will not charge you for it/);
  assert.doesNotMatch(terms, /we may charge for that month/);
});
// r29c (R32 review of PR #264)
t("REF-01 the pages promise what the server gives: 8 days free, then 1 free month after the first payment", () => {
  const signup = read("public/referral-signup.js"), refer = read("public/refer.html"), referJs = read("public/refer.js");
  for (const [f, src] of [["referral-signup.js", signup], ["refer.html", refer], ["refer.js", referJs]]) {
    assert.doesNotMatch(src, /first paid month (is )?free/i, f + ": no 'first paid month free' promise");
  }
  assert.match(signup, /8 days free, then 1 free month after your first payment\./);
  assert.match(refer, /then 1 free month after their first payment/);
  assert.match(referJs, /8 days free, then 1 free month after your first payment\./);
  assert.match(read("public/login.html"), /referral-signup\.js\?v=3/); assert.match(refer, /refer\.js\?v=3/);
});
t("REF-02 / REF-03 in 0279 + APPLY-0279 + APPLY-0279b (for a database that already ran 0279)", () => {
  assert.match(sql, /if not public\._r29_rate\('at:' \|\| auth\.uid\(\)::text, 10\) then return jsonb_build_object\('ok', false, 'reason', 'rate'\); end if;/);
  assert.doesNotMatch(sql, /lk:all/);
  assert.match(sql, /delete from public\.referral_rate_buckets where window_start < now\(\) - interval '2 hours';/);
  assert.ok(apply.includes(sql), "APPLY-0279 still carries 0279 verbatim");
  const b = read("supabase/APPLY-0279b-referral-hardening.sql");
  assert.doesNotMatch(b, /[^\x00-\x7f]/, "ASCII");
  assert.match(b, /^begin;$/m); assert.match(b, /^commit;$/m); assert.match(b, /STOP 0279b:/); assert.match(b, /-- VERIFY \(every row must say ok = true\)/);
  for (const fn of ["referral_attach", "referral_lookup", "referral_tick", "referral_click", "_r29_net"]) {
    const re = (src) => { const i = src.indexOf("create or replace function public." + fn + "("); return src.slice(i, src.indexOf("end $$;", i)); };
    assert.equal(re(b), re(sql), fn + " body in 0279b = 0279");
  }
  assert.equal((b.match(/create or replace function/g) || []).length, 5, "only the 3 r29c functions + the r29d helper + referral_click");
  assert.doesNotMatch(b.replace(/delete from public\.referral_rate_buckets where window_start < now\(\) - interval '2 hours';/, ""), /\bdelete\s+from\b|\bdrop\s+(table|column|function)\b|\btruncate\b/i);
});
// r29d
t("REF-01 leftover: the funnel step and the HQ demo notes say what the server gives (free month after the first payment)", () => {
  const rules = read("public/referral-rules.js"), demo = read("public/referral-demo.js");
  assert.match(rules, /help: "Picked a plan\. They get 1 free month after their first payment\." \}/);
  for (const f of ["referral-rules.js", "referral-demo.js", "referral-signup.js", "refer.js", "refer.html", "hq-referrals.js", "hq-referrals.html", "login.html"]) {
    assert.doesNotMatch(read("public/" + f), /first (paid )?month (is )?(free|billed)|paid month is free|payment is after it/i, f + ": no 'first paid month free' wording");
  }
  assert.equal((demo.match(/note: "Renewal after the first payment billed \$0"/g) || []).length, 3);
  for (const f of ["login.html", "refer.html", "hq-referrals.html"]) {
    const src = read("public/" + f);
    assert.match(src, /\/referral-rules\.js\?v=2/, f + " loads the new rules"); assert.doesNotMatch(src, /referral-rules\.js\?v=1\b/);
    assert.match(src, /\/referral-demo-gate\.js\?v=\d+/, f + " loads the demo gate (r78: demo itself only on localhost)"); assert.doesNotMatch(src, /\/referral-demo\.js/);
  }
});
t("REF-04 per-network keys: cf-connecting-ip first, IPv6 by its /64, IPv4 unchanged; in 0279, APPLY-0279 and APPLY-0279b", () => {
  const net = (src) => { const i = src.indexOf("create or replace function public._r29_net()"); assert.ok(i > 0); return src.slice(i, src.indexOf("end $$;", i)); };
  const h = net(sql);
  assert.ok(h.indexOf("cf-connecting-ip") > 0 && h.indexOf("cf-connecting-ip") < h.indexOf("x-forwarded-for"), "Cloudflare header first");
  assert.match(h, /if family\(a\) = 6 and not \(a <<= '::ffff:0:0\/96'::inet\) then return network\(set_masklen\(a, 64\)\)::text; end if;/);
  assert.match(h, /return host\(a\);/); assert.doesNotMatch(h, /security definer/);
  for (const fn of ["referral_lookup", "referral_click"]) {
    const i = sql.indexOf("create or replace function public." + fn + "("), body = sql.slice(i, sql.indexOf("end $$;", i));
    assert.match(body, /coalesce\(public\._r29_hash\('ip', public\._r29_net\(\)\), 'none'\)/, fn + " keys by network");
    assert.doesNotMatch(body, /_hq27_client_ip/, fn);
  }
  assert.match(sql, /'public\._r29_rate\(text,integer\)', 'public\._r29_net\(\)',/, "helper in the internal-only revoke list");
  assert.ok(apply.includes(sql), "APPLY-0279 carries 0279 verbatim");
  assert.match(apply, /'09 r29d REF-04/); assert.match(apply, /'10 r29d the network helper is internal only/);
  const b = read("supabase/APPLY-0279b-referral-hardening.sql");
  assert.equal(net(b), h, "0279b helper = 0279 helper");
  assert.match(b, /revoke all on function public\._r29_net\(\) from anon/); assert.match(b, /'06 r29d REF-04/); assert.match(b, /'07 r29d/);
  for (const f of ["supabase/migrations/0279_referral_program.sql", "supabase/APPLY-0279.sql", "supabase/APPLY-0279b-referral-hardening.sql"]) {
    assert.doesNotMatch(read(f), /[^\x00-\x7f]/, f + " ASCII");
  }
});
t("r29d zero data loss: no referral key deletes on cascade (0279 + APPLY-0279 + APPLY-0279b)", () => {
  assert.doesNotMatch(sql.replace(/^--.*$/gm, "").replace(/'ON DELETE CASCADE'/g, ""), /on delete cascade/i, "0279 tables: no cascade");
  assert.match(sql, /referral_click_days \(\n  code   text not null references public\.referral_codes\(code\) on delete restrict,/);
  assert.match(sql, /studio_id uuid not null references public\.organizations\(id\) on delete restrict,/);
  const fix = /c\.contype = 'f' and c\.confdeltype = 'c' and t\.relnamespace = 'public'::regnamespace and t\.relname like 'referral\\_%'/;
  const b = read("supabase/APPLY-0279b-referral-hardening.sql");
  for (const [f, src] of [["0279", sql], ["APPLY-0279", apply], ["APPLY-0279b", b]]) {
    assert.match(src, fix, f + " converts an existing cascade key"); assert.match(src, /replace\(r\.def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'\)/, f);
  }
  assert.match(apply, /'11 r29d zero data loss/); assert.match(b, /'08 r29d zero data loss/);
});
console.log("r29-referrals-wiring: ok (" + n + " checks)");
