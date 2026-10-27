// =============================================================================
// walkaround-visual.harness.mjs — R49 visual harness for the 3D walkaround (Playwright, the REAL builder page).
//
//   HELM_THREE_JS=<path to three r128 three.min.js> [PW_FROM=<a package.json whose node_modules has playwright>] \
//   [OUT=<screenshot dir>] [ONLY=<layout name>] node test/walkaround-visual.harness.mjs
//
// * Serves this repo's public/ (read-only) on 127.0.0.1:5021. EVERY non-localhost request is aborted; Supabase is
//   answered in-process by a stub (no network); three.js is preloaded from HELM_THREE_JS with the examples/js
//   stand-ins in test/fixtures/walk-three-shims.js (only defined when the build lacks them).
// * The live camera + scene come from window.__helm3D.inspect() (test-only, behind window.__HELM_WALK_TEST__),
//   so the harness does not depend on the three.js version.
// * For each layout x viewport (desktop 1440x900, phone 390x844) it starts the real walkaround and, after every
//   landing, checks the stop's SUBJECT (stop.subject item ids; the overview = every item):
//     (a) frame : all 8 corners of the real mesh box in front of the camera and inside the part of the canvas the
//                 stop card does not cover;
//     (b) fill  : the projected box spans 25-80% of the screen on its binding axis;
//     (c) seen  : >= 50% of ray samples inside the box reach it first (not occluded).
//   plus: reduced-motion auto-play advances, layout-editing keys do nothing during the tour, and a drag on the 3D
//   view pauses ("Paused — exploring"). Screenshots of every stop (subject box dashed) go to OUT.
// Exit code 1 when any check fails. Not part of `npm test` (needs Chromium + a three.js build).
// =============================================================================
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUTS, COVERAGE, OCCLUSION } from './fixtures/walk-layouts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..'), PUB = path.join(ROOT, 'public');
const OUT = process.env.OUT || path.resolve(ROOT, '..', 'walkaround-screens');
const THREE_JS = process.env.HELM_THREE_JS || path.join(ROOT, 'node_modules/three/build/three.min.js');
const PORT = 5021, BASE = `http://127.0.0.1:${PORT}`, FILL_MIN = 0.25, FILL_MAX = 0.80, VIS_MIN = 0.5;
if (!existsSync(THREE_JS)) { console.error('walkaround harness: set HELM_THREE_JS to a three r128 three.min.js (not found: ' + THREE_JS + ')'); process.exit(2); }
const req = createRequire(process.env.PW_FROM || path.join(ROOT, 'package.json'));
let chromium; try { ({ chromium } = req('playwright')); } catch (_) { ({ chromium } = req('@playwright/test')); }
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- static server (public/ only, no proxy)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const srv = http.createServer(async (rq, rs) => {
  try { let p = decodeURIComponent(new URL(rq.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    let f = path.join(PUB, p); if (!f.startsWith(PUB)) { rs.writeHead(403).end(); return; }
    let st = await stat(f).catch(() => null); if (!st && !path.extname(f)) { f += '.html'; st = await stat(f).catch(() => null); }
    if (!st || !st.isFile()) { rs.writeHead(404).end('nf'); return; }
    rs.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); rs.end(await readFile(f));
  } catch (e) { rs.writeHead(500).end(String(e)); }
});
await new Promise((ok) => srv.listen(PORT, '127.0.0.1', ok));

// ---------------------------------------------------------------- Supabase stub (answered in-process)
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const UID = 'a0000000-0000-4000-8000-0000000000a1', ORG = 'a0000000-0000-4000-8000-000000000001';
const jwt = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: UID, role: 'authenticated', aal: 'aal1', exp: 4102444800, aud: 'authenticated', email: 'planner@studio-a.test', session_id: 's1' }) + '.sig';
const user = { id: UID, aud: 'authenticated', role: 'authenticated', email: 'planner@studio-a.test', email_confirmed_at: '2026-09-01T05:00:00Z', user_metadata: { full_name: 'Test Planner' }, app_metadata: { provider: 'email', providers: ['email'] }, factors: [], created_at: '2026-09-01T05:00:00Z' };
const sess = { access_token: jwt, refresh_token: 'stub-refresh', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user };
const profile = { id: UID, role: 'admin', org_id: ORG, email: user.email, full_name: 'Test Planner', must_change_password: false, phone: '+919800000000', profile_completed_at: '2026-09-02T05:00:00Z' };
const RPC = { password_change_required: false, my_mfa_reset_info: null, is_platform_operator: false, is_platform_admin: false, mfa_lock_status: { locked: false, retry_after: 0, fails: 0 },
  current_org_id: ORG, user_role: 'admin', my_trial_org: null, profile_status: { complete: true }, my_profile_status: { complete: true } };
const net = { stubbed: 0, blocked: new Set() };
async function stubContext(ctx) {
  await ctx.addInitScript(([s]) => {
    window.__HELM_WALK_TEST__ = true;
    window.HELM_STAGING_SUPABASE = { url: 'https://stubstubstubstubstub.supabase.co', anonKey: 'stub-anon-key' };
    try { for (const ref of ['stubstubstubstubstub', 'xizehqgeyjcfpzrdymly', 'nqltzgiwznphugcfhmbm']) localStorage.setItem('sb-' + ref + '-auth-token', JSON.stringify(s));
      for (const k of ['helm_tour_done', 'bp_seen_tour', 'helm.shellb.pin', 'helm_tour_seen_builder', 'helm_tour_seen_builder.html']) localStorage.setItem(k, '1'); } catch (e) {}
  }, [sess]);
  await ctx.addInitScript({ content: readFileSync(THREE_JS, 'utf8') });
  await ctx.addInitScript({ path: path.join(HERE, 'fixtures/walk-three-shims.js') });
  await ctx.route('**/*', async (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return r.continue();
    if (u.hostname.endsWith('.supabase.co')) {
      net.stubbed++;
      const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: H, body: '' });
      const json = (o) => r.fulfill({ status: 200, contentType: 'application/json', headers: H, body: JSON.stringify(o) });
      const p = u.pathname;
      if (p === '/auth/v1/user') return json(user);
      if (p === '/auth/v1/token') return json(sess);
      if (p.startsWith('/auth/v1/')) return json({});
      if (p.startsWith('/rest/v1/rpc/')) { const fn = p.slice(13); return json(fn in RPC ? RPC[fn] : null); }
      if (p.startsWith('/rest/v1/')) { const t = p.slice(9), one = /vnd\.pgrst\.object/.test(r.request().headers()['accept'] || '');
        if (t === 'profiles') return json(one ? profile : [profile]);
        if (t === 'organizations') { const o = { id: ORG, name: 'Studio A', slug: 'studio-a', currency: 'INR', timezone: 'Asia/Kolkata', plan: 'pro', brand: {} }; return json(one ? o : [o]); }
        return json(one ? null : []); }
      return r.abort();
    }
    net.blocked.add(u.origin); return r.abort();
  });
}

// ---------------------------------------------------------------- in-page measurement (runs in the browser)
function measureInPage(opt) {
  const T = THREE, ins = window.__helm3D.inspect(), cam = ins.camera, scene = ins.scene, WTs = window.HelmWalkthrough._ui.state();
  const stop = WTs.stops[WTs.i], items = store.items, W = WORLD.w, H = WORLD.h;
  const targets = stop.view === 'overview' ? items : stop.key === 'entrance' ? [] : items.filter((x) => (stop.subject || []).includes(x.id));
  cam.updateMatrixWorld(true); const viewM = cam.matrixWorld.clone().invert(), projM = cam.projectionMatrix.clone();
  const cv = document.getElementById('scene3d').getBoundingClientRect(), card = document.querySelector('.wt-card').getBoundingClientRect();
  const bandBottom = -1 + 2 * Math.max(0, cv.bottom - card.top) / cv.height;   // NDC y above which the card does not cover the canvas
  const groupOf = new Map(); const meshes = [];
  for (const o of ins.root.children) if (o.userData && o.userData.itemId != null && !o.isSprite && !groupOf.has(o.userData.itemId)) groupOf.set(o.userData.itemId, o);
  ins.root.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && !o.isSprite && o.visible) { let p = o, vis = true; while (p) { if (p.visible === false) vis = false; p = p.parent; } if (vis) meshes.push(o); } });
  const footBox = (x) => { const t = (x.rotation || 0) * Math.PI / 180, cx = x.x + x.width / 2 - W / 2, cz = x.y + x.height / 2 - H / 2;
    const ex = Math.abs(x.width / 2 * Math.cos(t)) + Math.abs(x.height / 2 * Math.sin(t)), ez = Math.abs(x.width / 2 * Math.sin(t)) + Math.abs(x.height / 2 * Math.cos(t));
    return new T.Box3(new T.Vector3(cx - ex, 0, cz - ez), new T.Vector3(cx + ex, 2.6, cz + ez)); };
  const boxOf = (x) => { const g = groupOf.get(x.id), b = new T.Box3(); if (g && g.visible) b.setFromObject(g); const f = footBox(x); if (b.isEmpty()) return f;
    if (/seatblock|chairrow|table/.test(x.type)) b.union(f); return b; };
  const ownerOf = (hit) => { if (hit.object.isInstancedMesh && hit.instanceId != null && ins.chairMap) return ins.chairMap[hit.instanceId];
    let p = hit.object; while (p && !(p.userData && p.userData.itemId != null)) p = p.parent; return p ? p.userData.itemId : null; };
  const project = (p) => { const c = p.clone().applyMatrix4(viewM); const front = c.z < -cam.near; const n = c.clone().applyMatrix4(projM); return { x: n.x, y: n.y, front }; };
  const v = window.__helm3D.getView(), landErr = Math.hypot(v.pos[0] - stop.pos[0], v.pos[1] - stop.pos[1], v.pos[2] - stop.pos[2]);
  const res = { key: stop.key, title: stop.title, desc: stop.desc, i: WTs.i, n: WTs.stops.length, view: stop.view, landErr: +landErr.toFixed(3), fov: +cam.fov.toFixed(1), aspect: +cam.aspect.toFixed(3),
    cam: v.pos.map((x) => +x.toFixed(1)), targets: targets.map((x) => x.id), camY: +cam.position.y.toFixed(2) };
  res.camInside = items.filter((x) => { const g = groupOf.get(x.id); if (!g || !g.visible || /dancefloor|redcarpet|walkway|exit|arch|checkpoint|rug|carpet|aisle|tent|canopy|stageroof|umbrellas|fairylights|hangingfloral|chandelier/.test(x.type)) return false;
    return boxOf(x).expandByScalar(0.3).containsPoint(cam.position); }).map((x) => x.id);
  if (!targets.length) { res.na = true; return res; }
  const ub = new T.Box3(); targets.forEach((x) => ub.union(boxOf(x)));
  const cs = []; for (const X of [ub.min.x, ub.max.x]) for (const Y of [ub.min.y, ub.max.y]) for (const Z of [ub.min.z, ub.max.z]) cs.push(project(new T.Vector3(X, Y, Z)));
  const tol = 0.03;
  res.cornersIn = cs.filter((c) => c.front && Math.abs(c.x) <= 1 + tol && c.y <= 1 + tol && c.y >= (stop.view === 'overview' ? -1 : bandBottom) - tol).length;
  res.frame = res.cornersIn === 8;
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y); const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  res.fill = cs.some((c) => !c.front) ? Infinity : +Math.max((x1 - x0) / 2, (y1 - y0) / 2).toFixed(3);
  res.fillOk = stop.view === 'overview' ? res.fill <= 1 : res.fill >= opt.FILL_MIN && res.fill <= opt.FILL_MAX;
  // occlusion: rays to a 3x3x3 inset grid inside each target's box (up to 40 targets)
  const ids = new Set(targets.map((x) => x.id)), ray = new T.Raycaster(); ray.camera = cam; let on = 0, vis = 0; const blockers = {};
  const step = Math.max(1, Math.ceil(targets.length / 40));
  for (let k = 0; k < targets.length; k += step) { const b = boxOf(targets[k]), s = b.getSize(new T.Vector3()), mn = b.min;
    for (const fx of [0.15, 0.5, 0.85]) for (const fy of [0.15, 0.5, 0.85]) for (const fz of [0.15, 0.5, 0.85]) {
      const q = new T.Vector3(mn.x + s.x * fx, mn.y + s.y * fy, mn.z + s.z * fz), pr = project(q);
      if (!pr.front || Math.abs(pr.x) > 1 || Math.abs(pr.y) > 1) continue;
      on++; const dir = q.clone().sub(cam.position), d = dir.length(); ray.set(cam.position, dir.normalize()); ray.far = d + 0.05;
      const first = ray.intersectObjects(meshes, false).find((h) => h.distance > 0.05);
      if (!first || first.distance >= d - 0.3) { vis++; continue; }
      const own = ownerOf(first); if (own != null && ids.has(own)) { vis++; continue; }
      blockers[own || '?'] = (blockers[own || '?'] || 0) + 1; } }
  res.visFrac = on ? +(vis / on).toFixed(2) : 0; res.blockers = blockers; res.visOk = stop.view === 'overview' || (on > 0 && vis / on >= opt.VIS_MIN);
  document.querySelectorAll('.__wtbox').forEach((e) => e.remove());
  if (isFinite(res.fill)) { const d = document.createElement('div'); d.className = '__wtbox'; const good = res.frame && res.fillOk && res.visOk;
    Object.assign(d.style, { position: 'fixed', zIndex: 99999, pointerEvents: 'none', border: '2px dashed ' + (good ? '#16a34a' : '#dc2626'),
      left: cv.left + (x0 + 1) / 2 * cv.width + 'px', top: cv.top + (1 - y1) / 2 * cv.height + 'px', width: (x1 - x0) / 2 * cv.width + 'px', height: (y1 - y0) / 2 * cv.height + 'px' });
    const t = document.createElement('div'); t.className = '__wtbox'; t.textContent = `${stop.key}  frame:${res.frame ? 'ok' : 'FAIL'} fill:${res.fill} seen:${res.visFrac}`;
    Object.assign(t.style, { position: 'fixed', zIndex: 99999, left: cv.left + 8 + 'px', top: cv.top + 8 + 'px', font: '12px monospace', background: '#000c', color: '#fff', padding: '2px 6px' });
    document.body.append(d, t); }
  return res;
}

// ---------------------------------------------------------------- driver
const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = { at: new Date().toISOString(), thresholds: { FILL_MIN, FILL_MAX, VIS_MIN }, runs: [], extra: {} };
const fails = [];
async function openBuilder(viewport, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport, deviceScaleFactor: 1, reducedMotion: 'no-preference' }, opts || {}));
  await stubContext(ctx);
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(BASE + '/builder.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof applyLayout === 'function' && typeof renderAll === 'function' && window.HelmWalkthrough && window.HelmWalkthrough._ui && window.__helm3D, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  if (!/builder/.test(page.url())) throw new Error('not on the builder: ' + page.url());
  return { ctx, page, errs };
}
async function load(page, L) {
  await page.evaluate(([items, hall]) => { applyLayout({ items: JSON.parse(JSON.stringify(items)), scale: { worldFt: hall } }); renderAll(); }, [L.items, L.hall]);
  await page.evaluate(() => { document.querySelectorAll('.modal, .bpui-overlay').forEach((m) => { if (m.hidden === false) m.hidden = true; }); });
}
const landed = (page) => page.waitForFunction(() => { const s = window.HelmWalkthrough._ui.state(); if (!s) return false; const v = window.__helm3D.getView(), p = s.stops[s.i].pos;
  const ok = Math.hypot(v.pos[0] - p[0], v.pos[1] - p[1], v.pos[2] - p[2]) < 0.05; window.__wtLand = ok ? (window.__wtLand || 0) + 1 : 0; return window.__wtLand > 3; }, null, { timeout: 30000, polling: 'raf' });

const layouts = [...LAYOUTS, ...[COVERAGE[0], COVERAGE[2], COVERAGE[3], OCCLUSION[1], OCCLUSION[2]].map(([name, items, hall]) => ({ name, items, hall }))];
for (const [vpName, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  for (const L of layouts) {
    if (process.env.ONLY && process.env.ONLY !== L.name) continue;
    if (vpName === 'phone' && !LAYOUTS.includes(L)) continue;   // phone: the 3 harness layouts
    const { ctx, page, errs } = await openBuilder(vp, vpName === 'phone' ? { isMobile: true, hasTouch: true } : null);
    await load(page, L);
    await page.evaluate(() => window.HelmWalkthrough._ui.start());
    await page.waitForFunction(() => window.__helm3D.isActive() && window.HelmWalkthrough._ui.state() && window.__helm3D.inspect(), null, { timeout: 30000 });
    await page.evaluate(() => window.HelmWalkthrough._ui.setAuto(false));
    const n = await page.evaluate(() => window.HelmWalkthrough._ui.state().stops.length), rows = [];
    for (let k = 0; k < n; k++) {
      if (k > 0) await page.evaluate((j) => window.HelmWalkthrough._ui.go(j), k);
      await landed(page).catch(() => {}); await page.waitForTimeout(150);
      const r = await page.evaluate(measureInPage, { FILL_MIN, FILL_MAX, VIS_MIN });
      const shot = `${vpName}-${L.name}-${String(k + 1).padStart(2, '0')}-${r.key}.png`.replace(/[^A-Za-z0-9._-]+/g, '_');
      await page.screenshot({ path: path.join(OUT, shot) }); r.shot = shot; rows.push(r);
      const bad = r.na ? [] : [!r.frame && 'frame ' + r.cornersIn + '/8', !r.fillOk && 'fill ' + r.fill, !r.visOk && 'seen ' + r.visFrac].filter(Boolean);
      if (r.landErr > 0.05) bad.push('did not land (' + r.landErr + ')');
      if (r.camInside.length) bad.push('camera inside ' + r.camInside.join(','));
      if (r.camY < 1) bad.push('camera under the floor');
      if (bad.length) fails.push(`${vpName} ${L.name} #${k + 1} ${r.key}: ${bad.join('; ')}`);
    }
    const covered = new Set(rows.flatMap((r) => r.targets || []));
    const missed = L.items.filter((x) => !covered.has(x.id) && !rows.some((r) => r.view === 'overview')).map((x) => x.id);
    report.runs.push({ viewport: vpName, layout: L.name, items: L.items.length, stops: rows, missed, pageErrors: errs });
    if (errs.length) fails.push(`${vpName} ${L.name}: page errors ${errs.join(' | ').slice(0, 300)}`);
    await page.evaluate(() => window.HelmWalkthrough._ui.exit()); await ctx.close();
  }
}
// ---- reduced motion: auto-play still advances (M6), cuts instead of flying
{
  const { ctx, page } = await openBuilder({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await load(page, LAYOUTS[0]);
  await page.evaluate(() => window.HelmWalkthrough._ui.start());
  await page.waitForFunction(() => window.HelmWalkthrough._ui.state(), null, { timeout: 30000 });
  await page.waitForTimeout(6500);
  const i = await page.evaluate(() => window.HelmWalkthrough._ui.state().i);
  report.extra.reducedMotionStopAfter6s = i; if (!(i >= 1)) fails.push('reduced motion: auto-play did not advance (stop ' + i + ')');
  // ---- key blocking: even with an item selected, Delete / arrows / r / d / Cmd+D change nothing during the tour
  const before = await page.evaluate(() => { setSelection([store.items[0].id]); return JSON.stringify(store.items.map((x) => [x.id, x.x, x.y, x.rotation])); });
  for (const k of ['Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'r', 'd', 'Meta+d', 'Control+d']) await page.keyboard.press(k);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.stringify(store.items.map((x) => [x.id, x.x, x.y, x.rotation])));
  report.extra.keysBlocked = before === after; if (before !== after) fails.push('layout changed by keys during the tour');
  // ---- a drag on the 3D view pauses the tour
  const box = await page.locator('#scene3d').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 3, { steps: 4 }); await page.mouse.up();
  const ex = await page.evaluate(() => ({ s: window.HelmWalkthrough._ui.state().exploring, t: document.querySelector('.wt-status').textContent }));
  report.extra.dragPauses = ex; if (!ex.s || !/exploring/.test(ex.t)) fails.push('drag on the 3D view did not pause the tour');
  await page.screenshot({ path: path.join(OUT, 'desktop-paused-exploring.png') });
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  report.extra.escExits = await page.evaluate(() => window.HelmWalkthrough._ui.state() === null);
  if (!report.extra.escExits) fails.push('Esc did not exit');
  await ctx.close();
}
await browser.close(); srv.close();

// ---------------------------------------------------------------- summary
for (const R of report.runs) {
  const m = R.stops.filter((s) => !s.na), bad = m.filter((s) => !s.frame || !s.fillOk || !s.visOk);
  console.log(`${R.viewport.padEnd(7)} ${R.layout.padEnd(28)} ${String(R.items).padStart(4)} items ${String(R.stops.length).padStart(3)} stops  measured ${m.length}  failing ${bad.length}`);
}
report.network = { stubbed: net.stubbed, blocked: [...net.blocked] }; report.fails = fails;
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, (k, v) => (v === Infinity ? 'Infinity' : v), 1));
console.log(`network: ${net.stubbed} Supabase calls answered in-process; blocked origins: ${[...net.blocked].join(', ') || 'none'}`);
console.log(`extra: ${JSON.stringify(report.extra)}`);
if (fails.length) { console.log('\nFAILURES:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log(`walkaround visual harness: every stop framed, 25-80% of the screen, unoccluded. Screenshots in ${OUT}`);
