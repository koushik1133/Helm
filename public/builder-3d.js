/* =========================================================================
   3D VIEW — renders the same store.items as real, modelled objects.
   One consistent chair model (instanced for scale), plus per-type models for
   stages, tables, podiums, booths, trucks, barricades, fences, etc.
   2D remains the editing surface; 3D is a live rendered preview that stays in
   sync (window.__on3DStateChange) and supports click-to-select + orbit.
   ========================================================================= */
(function(){
  // Three.js loads lazily on first 3D/Render use → the 2D builder stays fast to load
  let libsReady = false, libsPromise = null;
  // three.js r186, self-hosted (public/vendor/three-0.186.1, sha384s in scripts/three-vendor.SHA384SUMS) and loaded as ES
  // modules through public/three-boot.js, which hands back an r128-shaped namespace (THREE.OrbitControls,
  // THREE.BufferGeometryUtils, ...). Same-origin, so CSP script-src 'self' covers it - no CDN, no SRI drift.
  const THREE_BOOT='/three-boot.js?v=1';
  function ensure3DLibs(){
    if(libsReady || typeof THREE!=='undefined'){ libsReady=true; return Promise.resolve(true); }
    // memoise: concurrent activations (e.g. 3D then Render before the modules finish) share ONE load
    if(libsPromise) return libsPromise;
    libsPromise = (async()=>{
      try{
        const mod = await import(THREE_BOOT);
        window.THREE = mod.default;
        libsReady=true; return true;
      }catch(e){ console.warn('[3D] library load failed', e && e.message); libsPromise=null; return false; }  // allow a retry after failure
    })();
    return libsPromise;
  }
  // r155+ physical light units: r128's lights were π× brighter for the same number (see three-boot.js)
  const LI = ()=> (THREE.LEGACY_LIGHT_SCALE || 1);
  // r128 PointLight(decay 2) used a linear cut-off window, r155+ uses inverse-power falloff. Return the
  // r186 intensity that lights the floor point straight below the lamp (distance dRef) exactly as r128 did.
  function legacyPointIntensity(k, range, dRef, decay){
    const legacy=Math.PI*Math.pow(Math.max(0,1-dRef/range),2);
    const phys=(1/Math.max(Math.pow(dRef,decay),0.01))*Math.pow(Math.max(0,1-Math.pow(dRef/range,4)),2);
    return phys>0 ? k*legacy/phys : k;
  }
  let R, scene, camera, controls, root, chairMesh, ground, grid, edge, sun, hemi, floorW=0, floorH=0, floorCell=0, raf=null;
  const MAX_CHAIRS_3D=6000;
  let active=false, built=false, needsBuild=false, chairMap=[];
  let transform, gizmo, gltfLoader, tmode='translate', gizmoBase=null;   // 3D editing + model loading
  const modelCache={};
  let renderMode=false, envTex=null;                                     // ✦ Render (IBL) view

  const cv = document.getElementById('scene3d');
  let shadowDirty=3;                               // live-loop shadow refresh frames left (see loop())
  function markShadows(){ shadowDirty=3; }
  const stage = document.getElementById('stage3d');
  const viewport = document.querySelector('.viewport');

  const themeVar = (n,f)=>{ const v=getComputedStyle(document.body).getPropertyValue(n).trim(); return v||f; };
  const col = c => new THREE.Color(String(c||'#8a95ad').trim().replace(/^rgba\(\s*([^,]+),([^,]+),([^,]+),[^)]*\)$/i,'rgb($1,$2,$3)'));
  const P = ft => ft;                                // 1 unit = 1 foot
  // world (ft, top-left origin, y-down) → scene (x right, z toward viewer, y up)
  const sx = fx => fx - WORLD.w/2;   // read WORLD live so a custom room size centres correctly
  const sz = fy => fy - WORLD.h/2;
  // rotate a footprint offset (feet) by degrees, matching the 2D SVG rotate() convention (clockwise, y-down)
  function rotOff(ox,oy,deg){ const t=(deg||0)*Math.PI/180,c=Math.cos(t),s=Math.sin(t); return [ox*c-oy*s, ox*s+oy*c]; }

  /* ---------------- chair model (merged, instanced) ---------------- */
  function chairGeometry(){
    // chiavari / banquet chair: cushioned seat, slatted back with spindles, tapered legs + stretchers
    const parts=[];
    const box=(w,h,d,x,y,z)=>{ const g=new THREE.BoxGeometry(w,h,d); g.translate(x,y,z); parts.push(g); };
    const rod=(r1,r2,h,x,y,z,rx)=>{ const g=new THREE.CylinderGeometry(r1,r2,h,8); if(rx) g.rotateX(rx); g.translate(x,y,z); parts.push(g); };
    box(1.3,0.12,1.25, 0,1.5,0);                 // seat frame
    box(1.2,0.16,1.12, 0,1.63,-0.02);            // cushion
    const lx=0.56, lz=0.54;
    rod(0.055,0.04,1.5, lx,0.75,-lz); rod(0.055,0.04,1.5,-lx,0.75,-lz);   // front legs
    rod(0.055,0.04,3.1, lx,1.55, lz); rod(0.055,0.04,3.1,-lx,1.55, lz);   // back legs run up into the back posts
    for(const y of [2.35,2.75,3.05]) box(1.12,0.07,0.07, 0,y,lz);          // back rails
    for(const x of [-0.28,0,0.28]) rod(0.03,0.03,0.7, x,2.0,lz);           // spindles
    box(1.12,0.05,0.05, 0,0.55,-lz); box(1.12,0.05,0.05, 0,0.55,lz);      // stretchers
    box(0.05,0.05,1.08, lx,0.4,0); box(0.05,0.05,1.08,-lx,0.4,0);
    const merged = THREE.BufferGeometryUtils.mergeGeometries(parts, false);
    parts.forEach(g=>g.dispose());
    return merged;
  }

  /* ---------------- per-type furniture builders ---------------- */
  const mat = (c,opts={})=> new THREE.MeshStandardMaterial(Object.assign({color:col(c),roughness:.75,metalness:.05},opts));
  function boxMesh(w,h,d,c,opts){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat(c,opts)); m.castShadow=true; m.receiveShadow=true; return m; }

  /* ---------------- premium model kit (2026-10) ----------------
     Shared helpers for the refined décor / furniture models. Repeated parts (flowers, leaves,
     bulbs, crystals, plates, tiles) are ONE InstancedMesh each, so a dense floral arch is ~3 draw
     calls. Everything is deterministic per item id (seeded RNG), so a rebuild never "reshuffles". */
  function rng(seed){ let s=(seed>>>0)||1; return ()=>{ s^=s<<13; s>>>=0; s^=s>>>17; s^=s<<5; s>>>=0; return s/4294967296; }; }
  function seedOf(it){ const k=String((it&&it.id)||(it&&it.type)||'x'); let h=2166136261; for(let i=0;i<k.length;i++){ h^=k.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
  // one InstancedMesh for many copies of a geometry; entries {x,y,z, s|sx,sy,sz, rx,ry,rz, c}
  function instanced(geo, material, list){
    const n=list.length; if(!n){ geo.dispose(); material.dispose(); return null; }
    const im=new THREE.InstancedMesh(geo, material, n), m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler(), p=new THREE.Vector3(), s=new THREE.Vector3();
    list.forEach((o,i)=>{ e.set(o.rx||0,o.ry||0,o.rz||0); q.setFromEuler(e); p.set(o.x,o.y,o.z); const k=o.s||1; s.set(o.sx||k,o.sy||k,o.sz||k);
      m.compose(p,q,s); im.setMatrixAt(i,m); if(o.c) im.setColorAt(i,col(o.c)); });
    im.instanceMatrix.needsUpdate=true; if(im.instanceColor) im.instanceColor.needsUpdate=true; im.castShadow=true; im.receiveShadow=true; return im;
  }
  const FLOWER_TONES={
    blush:['#f6c1cc','#f29bb0','#fde2e4','#ffffff','#e86a8c','#f8d7a8'],
    marigold:['#f59e0b','#fbbf24','#ea580c','#fde68a','#f97316','#dc2626'],
    ivory:['#ffffff','#f8f1e4','#f3e3c3','#fbd9d9','#e9e2d0','#f6c1cc'],
    // décor-variant colour stories (2026-10c) — chosen per item in the inspector (properties.palette)
    redgold:['#b91c1c','#dc2626','#991b1b','#f59e0b','#fbbf24','#7f1d1d'],
    pastel:['#fbcfe8','#ddd6fe','#bfdbfe','#bbf7d0','#fef3c7','#fecdd3'],
    jewel:['#a21caf','#7e22ce','#be185d','#db2777','#6d28d9','#f59e0b'],
    whitegreen:['#ffffff','#f8fafc','#f1f5f9','#ffffff','#d9f99d','#e2e8f0'],
    rainbow:['#ef4444','#f97316','#facc15','#22c55e','#3b82f6','#a855f7'],
    goldchrome:['#d4af37','#f5d77a','#c0c0c0','#e5e7eb','#b8860b','#ffffff'] };
  // per-item variant (properties.style / flower / palette) of the model being built — set by buildPremium
  let VAR={};
  const pal=(c,tone)=>(VAR.palette&&FLOWER_TONES[VAR.palette]) ? FLOWER_TONES[VAR.palette].slice() : [c,c].concat(FLOWER_TONES[tone]||FLOWER_TONES.blush);
  // bloom size factor + leaf ratio per flower type (hydrangea = big puffy heads, jasmine = tiny buds)
  const FLOWER_KIND={ rose:[1,1], marigold:[0.8,0.6], orchid:[0.95,0.8], hydrangea:[1.35,1], jasmine:[0.45,0.4], carnation:[0.85,1], lily:[1.1,1] };
  // clustered blooms (varied sizes/colours) + flattened leaves around anchor points
  function blooms(g, anchors, o){
    const r=o.rand, P=o.pal, rMin=o.rMin||0.3, rMax=o.rMax||0.7, per=o.per||3, sp=o.spread||0.6, fl=[], lf=[];
    anchors.forEach(a=>{
      for(let k=0;k<per;k++) fl.push({x:a[0]+(r()-0.5)*sp*2, y:a[1]+(r()-0.5)*sp*2, z:a[2]+(r()-0.5)*sp*1.4, s:rMin+(rMax-rMin)*r(), c:P[(r()*P.length)|0]});
      if(o.leaves!==false) for(let k=0;k<2;k++){ const s=(0.16+0.2*r())*Math.max(0.6,Math.min(1.4,rMax/0.5));
        lf.push({x:a[0]+(r()-0.5)*sp*2.2, y:a[1]+(r()-0.5)*sp*2.2, z:a[2]+(r()-0.5)*sp*1.4, sx:s*0.8, sy:s*0.22, sz:s*1.7, rx:r()*3, ry:r()*3, rz:r()*3, c:r()<0.5?'#2f6b3a':'#4f8a4b'}); }
    });
    const kind=VAR.flower||'', mat0=()=>new THREE.MeshStandardMaterial(tx('petal',{color:0xffffff,roughness:.62,side:THREE.DoubleSide}));
    if(kind==='mixed'){ const parts=[[],[],[]]; fl.forEach((o,i)=>parts[i%3].push(o)); ['rose','hydrangea','orchid'].forEach((k,i)=>{
        parts[i].forEach(o=>{ o.s*=FLOWER_KIND[k][0]; }); const m=instanced(flowerGeo(k), mat0(), parts[i]); if(m) g.add(m); }); }
    else { const kf=FLOWER_KIND[kind]; if(kf) fl.forEach(o=>{ o.s*=kf[0]; });
      if(kind==='marigold'||kind==='jasmine') fl.forEach(o=>{ if(!VAR.palette) o.c=kind==='jasmine'?(o.s>0.2?'#ffffff':'#f8f1e4'):FLOWER_TONES.marigold[(r()*4)|0]; });
      const f=instanced(flowerGeo(kind), mat0(), fl); if(f) g.add(f); }
    const l=instanced(new THREE.SphereGeometry(1,8,5), new THREE.MeshStandardMaterial(tx('leaf',{color:0xffffff,roughness:.55})), lf); if(l) g.add(l);
  }
  // glowing bulbs (fairy lights / candles / marquee) — unlit material so they read as light sources
  function bulbs(g, pts, c, r){ const im=instanced(new THREE.SphereGeometry(r||0.12,6,4), new THREE.MeshBasicMaterial({color:col(c||'#ffe2a8')}), pts.map(p=>({x:p[0],y:p[1],z:p[2]})));
    if(im){ im.castShadow=false; g.add(im); } }
  // pleated fabric panel (sin folds along its width), double-sided
  function drapeGeo(w,h,folds,depth){ const geo=new THREE.PlaneGeometry(w,h,Math.max(8,folds*6),1), p=geo.attributes.position;
    for(let i=0;i<p.count;i++) p.setZ(i, Math.sin((p.getX(i)/w+0.5)*folds*Math.PI*2)*depth);
    geo.computeVertexNormals(); return geo; }
  function drape(w,h,c,o){ o=o||{}; const m=new THREE.Mesh(drapeGeo(w,h,Math.max(2,Math.round(w/(o.pitch||1.6))),o.depth||0.22),
    mat(c,Object.assign(tx('fabric',{side:THREE.DoubleSide,roughness:.95}),o.m||{}))); m.castShadow=true; m.receiveShadow=true; return m; }
  // a hanging fabric / rope / garland swag between two points (sagging curve)
  function swag(a,b,sag,c,rad,o){ const mid=new THREE.Vector3((a[0]+b[0])/2,(a[1]+b[1])/2-sag,(a[2]+b[2])/2);
    const curve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(a[0],a[1],a[2]),mid,new THREE.Vector3(b[0],b[1],b[2]));
    const m=new THREE.Mesh(new THREE.TubeGeometry(curve,20,rad||0.2,8,false),mat(c,Object.assign({roughness:.9},o||{}))); m.castShadow=true; return m; }
  function curvePts(a,b,sag,n){ const out=[]; for(let i=0;i<=n;i++){ const t=i/n; out.push([a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t-sag*4*t*(1-t), a[2]+(b[2]-a[2])*t]); } return out; }
  // turned profile (pillars, urns, vases, spandex covers): pts = [[radius, y], ...]
  function lathe(pts,c,o){ const m=new THREE.Mesh(new THREE.LatheGeometry(pts.map(p=>new THREE.Vector2(p[0],p[1])),24),mat(c,o)); m.castShadow=true; m.receiveShadow=true; return m; }
  const cyl=(rt,rb,h,c,o,seg)=>{ const m=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,seg||20),mat(c,o)); m.castShadow=true; m.receiveShadow=true; return m; };
  /* ---- surface realism (2026-10b): tiny procedural canvas textures, made once per page and shared
     (material.dispose() never frees a map, so the cache survives scene rebuilds). They are near-white
     greys, so the item's own colour still drives the hue: a fabric weave, wood grain, brushed metal,
     a petal (pale tip → deeper base + veins), a leaf (midrib) and a carpet pile. No DOM / no THREE
     (node tests) → null, i.e. the plain material, exactly as before. */
  const TEX={};
  function tex(kind){
    if(TEX[kind]!==undefined) return TEX[kind];
    if(typeof document==='undefined' || typeof THREE==='undefined' || typeof THREE.CanvasTexture!=='function') return null;
    let t=null;
    try{
      const S=kind==='wood'?256:128, cv=document.createElement('canvas'); cv.width=S; cv.height=S;
      const x=cv.getContext('2d'); if(!x) return (TEX[kind]=null);
      const r=rng(97+kind.length*131+kind.charCodeAt(0)), rep=[1,1];
      const lin=(x0,y0,x1,y1,st,lw)=>{ x.strokeStyle=st; x.lineWidth=lw||1; x.beginPath(); x.moveTo(x0,y0); x.lineTo(x1,y1); x.stroke(); };
      if(kind==='fabric'){ x.fillStyle='#f3f3f3'; x.fillRect(0,0,S,S);
        for(let i=0;i<S;i+=2){ lin(0,i,S,i,'rgba(0,0,0,'+(0.03+r()*0.03)+')'); lin(i,0,i,S,'rgba(255,255,255,'+(0.04+r()*0.04)+')'); }
        for(let i=0;i<500;i++){ x.fillStyle='rgba(0,0,0,'+(r()*0.05)+')'; x.fillRect(r()*S,r()*S,1,1); } rep[0]=rep[1]=5; }
      else if(kind==='wood'){ x.fillStyle='#ececec'; x.fillRect(0,0,S,S);
        for(let i=0;i<46;i++){ const y0=r()*S, a=0.05+r()*0.12, amp=1+r()*4, f=0.01+r()*0.03; x.strokeStyle='rgba(70,45,20,'+a+')'; x.lineWidth=0.6+r()*1.8; x.beginPath();
          for(let xx=0;xx<=S;xx+=8) x.lineTo(xx, y0+Math.sin(xx*f+i)*amp); x.stroke(); }
        for(let i=0;i<5;i++){ x.fillStyle='rgba(70,45,20,0.10)'; x.beginPath(); x.ellipse(r()*S,r()*S,6+r()*10,2+r()*3,0,0,Math.PI*2); x.fill(); } }
      else if(kind==='brushed'){ x.fillStyle='#efefef'; x.fillRect(0,0,S,S);
        for(let i=0;i<360;i++){ const y=r()*S; lin(0,y,S,y+(r()-0.5)*2, (r()<0.5?'rgba(0,0,0,':'rgba(255,255,255,')+(0.03+r()*0.06)+')', 0.6); } }
      else if(kind==='petal'){ const gr=x.createLinearGradient(0,0,0,S); gr.addColorStop(0,'#ffffff'); gr.addColorStop(0.55,'#f4f0f0'); gr.addColorStop(1,'#c8baba');
        x.fillStyle=gr; x.fillRect(0,0,S,S); for(let i=0;i<S;i+=3) lin(i,0,i+(r()-0.5)*6,S,'rgba(90,40,50,'+(0.03+r()*0.03)+')',0.7); }
      else if(kind==='leaf'){ const gr=x.createLinearGradient(0,0,S,0); gr.addColorStop(0,'#bdbdbd'); gr.addColorStop(0.5,'#f2f2f2'); gr.addColorStop(1,'#bdbdbd');
        x.fillStyle=gr; x.fillRect(0,0,S,S); lin(S/2,0,S/2,S,'rgba(255,255,255,0.7)',2); for(let y=6;y<S;y+=10){ lin(S/2,y,S*0.1,y-12,'rgba(255,255,255,0.25)'); lin(S/2,y,S*0.9,y-12,'rgba(255,255,255,0.25)'); } }
      else if(kind==='carpet'){ x.fillStyle='#e6e6e6'; x.fillRect(0,0,S,S);
        for(let i=0;i<2600;i++){ x.fillStyle=(r()<0.5?'rgba(0,0,0,':'rgba(255,255,255,')+(r()*0.09)+')'; x.fillRect(r()*S,r()*S,1.5,1.5); } rep[0]=rep[1]=4; }
      else return (TEX[kind]=null);
      t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=4; t.repeat.set(rep[0],rep[1]);
    }catch(_){ t=null; }
    return (TEX[kind]=t);
  }
  // material options with a texture (falls back to the plain options when textures are unavailable)
  const tx=(kind,o)=>{ const m=tex(kind); return m ? Object.assign({map:m},o||{}) : (o||{}); };
  // a layered bloom (rose / peony read): a domed centre, an inner cupped ring and an open outer ring of petals,
  // merged into one geometry so every flower is still ONE instance. Radius ≈ 1 like the old icosahedron.
  function flowerGeo(kind){
    try{
      if(kind==='marigold'||kind==='carnation'||kind==='hydrangea'){   // pompom heads: many small ruffled petals / florets on a ball
        const parts=[], n=kind==='hydrangea'?26:34, ps=kind==='hydrangea'?0.32:0.26;
        for(let i=0;i<n;i++){ const t=Math.acos(1-2*(i+0.5)/n), ph=i*2.399963, p=new THREE.SphereGeometry(ps,6,4);
          p.translate(Math.sin(t)*Math.cos(ph)*0.72, Math.cos(t)*0.72*0.85+0.1, Math.sin(t)*Math.sin(ph)*0.72); parts.push(p); }
        const m=THREE.BufferGeometryUtils.mergeGeometries(parts,false); parts.forEach(q=>q.dispose()); if(m) return m; }
      if(kind==='orchid'||kind==='lily'){   // open star of 5–6 long flat petals + a small throat
        const parts=[], n=kind==='lily'?6:5, ctr=new THREE.SphereGeometry(0.2,8,6); ctr.translate(0,0.12,0); parts.push(ctr);
        for(let i=0;i<n;i++){ const p=new THREE.SphereGeometry(0.5,8,6); p.scale(0.45,0.08,kind==='lily'?1.25:0.95); p.translate(0,0,0.55);
          p.rotateX(kind==='lily'?-0.55:-0.15); p.rotateY(i/n*Math.PI*2); parts.push(p); }
        const m=THREE.BufferGeometryUtils.mergeGeometries(parts,false); parts.forEach(q=>q.dispose()); if(m) return m; }
      if(kind==='jasmine') return new THREE.OctahedronGeometry(0.9,1);
      const parts=[], ctr=new THREE.SphereGeometry(0.42,10,8); ctr.scale(1,0.8,1); ctr.translate(0,0.18,0); parts.push(ctr);
      const ring=(n,len,tilt,lift,off)=>{ for(let i=0;i<n;i++){ const p=new THREE.SphereGeometry(0.5,8,6); p.scale(len*0.75,0.16,len); p.translate(0,0,len*0.55);
        p.rotateX(-tilt); p.rotateY(i/n*Math.PI*2+off); p.translate(0,lift,0); parts.push(p); } };
      ring(5,0.95,0.85,0.12,0); ring(7,1.15,0.35,-0.05,0.4);
      const merged=THREE.BufferGeometryUtils.mergeGeometries(parts,false); parts.forEach(q=>q.dispose());
      if(merged) return merged;
    }catch(_){}
    return new THREE.IcosahedronGeometry(1,1);
  }
  // a straight tube from A to B: a Y-up cylinder aimed with a YXZ Euler (θ = tilt from vertical, φ = heading)
  function rodAB(g,A,B,r,cc,o){ const dx=B[0]-A[0], dy=B[1]-A[1], dz=B[2]-A[2], L=Math.hypot(dx,dy,dz)||0.01, m=cyl(r,r,L,cc,o,8);
    m.position.set((A[0]+B[0])/2,(A[1]+B[1])/2,(A[2]+B[2])/2); m.rotation.order='YXZ'; m.rotation.x=Math.acos(Math.max(-1,Math.min(1,dy/L))); m.rotation.y=Math.atan2(dx,dz); g.add(m); return m; }
  // does this item get floral dressing? explicit per-item override first, then the event's rules
  // (HelmWizard.allowsGroup — e.g. a political rally stage is never dressed with flowers)
  function floralOK(it){
    const p=(it&&it.properties)||{}; if(p.plain) return false; if(p.florals) return true;
    try{ const ev=(typeof PRICING!=='undefined' && PRICING && PRICING.eventType) || '';
      const HW=typeof window!=='undefined' && window.HelmWizard;
      if(ev && HW && typeof HW.allowsGroup==='function') return HW.allowsGroup(ev,'floral'); }catch(_){}
    return true;
  }
  const GOLD={metalness:.75,roughness:.3, get map(){ return tex('brushed'); }}, CHROME={metalness:.8,roughness:.2, get map(){ return tex('brushed'); }};
  // vertical strings of marigold / jasmine ("ladi") hanging from y0 down by len
  function ladis(g, xs, z, y0, len, P, rand){ const pts=[]; xs.forEach(x=>{ for(let y=y0;y>y0-len;y-=0.42) pts.push({x:x+(rand()-0.5)*0.05,y,z,s:0.17+rand()*0.05,c:P[(rand()*P.length)|0]}); });
    const im=instanced(new THREE.IcosahedronGeometry(1,1), new THREE.MeshStandardMaterial(tx('petal',{color:0xffffff,roughness:.8})), pts); if(im) g.add(im); }
  // dressed round banquet table (floor-length cloth, charger plates, centrepiece) + ringed chairs
  function dressedRound(g, it, chairs, rad, square){
    const c=it.color, H=2.5, rand=rng(seedOf(it));
    if(square){ const cl=boxMesh(it.width,H,it.height,'#f7f4ee',{roughness:.92}); cl.position.y=H/2; g.add(cl);
      const run=boxMesh(it.width*0.32,0.03,it.height+0.1,c,{roughness:.8}); run.position.y=H+0.02; g.add(run); }
    else { const cloth=lathe([[0.01,H+0.02],[rad,H+0.02],[rad+0.05,H-0.15],[rad+0.18,0.6],[rad+0.28,0.02],[0.01,0.02]],'#f7f4ee',tx('fabric',{roughness:.92})); g.add(cloth);
      const overlay=lathe([[0.01,H+0.04],[rad*0.98,H+0.04],[rad*1.02,H-0.6],[0.01,H-0.6]],c,{roughness:.8,side:THREE.DoubleSide}); g.add(overlay); }
    const seats=Math.max(0,it.properties.seats|0), pl=[];
    for(let s=0;s<seats;s++){ const a=s/seats*Math.PI*2 - Math.PI/2; pl.push({x:Math.cos(a)*rad*0.78,y:H+0.07,z:Math.sin(a)*rad*0.78,s:1}); }
    const plates=instanced(new THREE.CylinderGeometry(0.42,0.36,0.05,16), new THREE.MeshStandardMaterial({color:col('#d9b45a'),metalness:.6,roughness:.35}), pl); if(plates) g.add(plates);
    const vase=lathe([[0.01,H],[0.28,H],[0.12,H+0.5],[0.1,H+2.2],[0.22,H+2.5],[0.01,H+2.5]],'#dfe6ee',{transparent:true,opacity:.55,roughness:.1,metalness:.1}); g.add(vase);
    const an=[]; for(let i=0;i<9;i++){ const a=i/9*Math.PI*2; an.push([Math.cos(a)*0.55, H+2.75+rand()*0.35, Math.sin(a)*0.55]); } an.push([0,H+3.1,0]);
    blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.22, rMax:.42, per:2, spread:.35});
    bulbs(g, [[0.6,H+0.12,0.2],[-0.5,H+0.12,-0.35],[0.1,H+0.12,-0.62]], '#ffd98a', 0.07);
    const tcx=it.x+it.width/2, tcy=it.y+it.height/2, trot=it.rotation||0;
    for(let s=0;s<seats;s++){ const a=s/seats*Math.PI*2 - Math.PI/2;
      const [ox,oy]=rotOff(Math.cos(a)*(rad+1.1), Math.sin(a)*(rad+1.1), trot);
      chairs.push({ x: tcx+ox, y: tcy+oy, rot: a*180/Math.PI - 90 + trot, color: it.color, id: it.id }); }
  }

  /* ---- décor variants (2026-10c): alternative frames for entrances / arches / backdrops / mandaps / centrepieces.
     Real-world sizes in ft (research: docs/research/event-inventory-2026-10.md): entrance arches 8–10 ft tall,
     hexagon 7–9 ft tall × 8–10 ft wide, moon-gate rings 7–8 ft, tunnels = 4–6 arches 2–3 ft apart. */
  const balloonPal=(c)=> (VAR.palette&&FLOWER_TONES[VAR.palette]) ? FLOWER_TONES[VAR.palette].slice() : [c,c,'#ffffff','#f9a8d4','#fde68a','#93c5fd','#c4b5fd'];
  function framePath(style,w,H){   // a polyline (x,y) in the item's plane; first/last points touch the floor
    const R=Math.max(1.5,Math.min(w/2-0.3,H/2)), P=[];
    if(style==='hexagon'){ const cy=R*0.95; for(let i=0;i<=6;i++){ const a=-Math.PI/2+i*Math.PI/3+Math.PI/2; P.push([Math.sin(a)*R*1.05, cy+Math.cos(a)*R]); } return {pts:P, closed:true, legs:[[-R*0.9,0],[R*0.9,0]]}; }
    if(style==='ring'){ const cy=R+0.4; for(let i=0;i<=40;i++){ const a=i/40*Math.PI*2; P.push([Math.cos(a)*R, cy+Math.sin(a)*R]); } return {pts:P, closed:true, legs:[[-R*0.5,0],[R*0.5,0]]}; }
    if(style==='square'){ const x=Math.max(1.2,w/2-0.3); return {pts:[[-x,0],[-x,H],[x,H],[x,0]]}; }
    const x=Math.max(1.2,w/2-0.3), L=Math.max(3,H-x*0.6);   // round-top arch
    P.push([-x,0]); for(let i=0;i<=24;i++){ const a=Math.PI*(1-i/24); P.push([Math.cos(a)*x, L+Math.sin(a)*Math.min(x,H-L+0.01)]); } P.push([x,0]); return {pts:P};
  }
  function styledFrame(g, it, style, rand){
    const t=it.type, w=it.width, d=it.height, c=it.color;
    const ENTR={floralentrance:1, floralarch:1, arch:1, entrancegate:1};
    if(ENTR[t]) return entranceVariant(g,it,style,rand,'flower');
    if(t==='balloonarch') return entranceVariant(g,it,style==='classic'?'':style,rand,style==='garland'?'garland':'balloon');
    if(t==='stagebackdrop'){
      const bh=Math.max(9,Math.min(14,w*0.45)), z=-d/2;
      const frame=boxMesh(w,bh,0.4,'#2a2a2a'); frame.position.set(0,bh/2,z+0.2); g.add(frame);
      if(style==='drape'){ const fab=drape(w*0.98,bh*0.97,'#f6f0e6',{depth:.3,pitch:.9}); fab.position.set(0,bh/2,z+0.55); g.add(fab);
        const n=Math.max(2,Math.round(w/6)); for(let i=0;i<n;i++){ const x0=-w/2+i*w/n; g.add(swag([x0,bh-0.3,z+0.9],[x0+w/n,bh-0.3,z+0.9],1.8,c,0.35)); }
        for(const s of [-1,1]){ const tb=drape(2.2,bh*0.95,c,{depth:.25,pitch:.5}); tb.position.set(s*(w/2-1.2),bh*0.48,z+1.0); g.add(tb); } }
      else if(style==='panel'){ const nx=Math.max(3,Math.round(w/3)), ny=Math.max(3,Math.round(bh/3)), L=[];
        for(let i=0;i<nx;i++) for(let j=0;j<ny;j++) L.push({x:-w/2+(i+0.5)*w/nx, y:(j+0.5)*bh/ny, z:z+0.6, sx:w/nx*0.94, sy:bh/ny*0.94, sz:0.35, c:(i+j)%2?'#f3ede2':'#efe6d6'});
        const pi=instanced(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial(tx('fabric',{color:0xffffff,roughness:.9})), L); if(pi) g.add(pi);
        const ring=new THREE.Mesh(new THREE.TorusGeometry(Math.min(bh*0.25,w*0.15),0.14,10,48),mat('#d9b45a',GOLD)); ring.position.set(0,bh*0.55,z+0.9); g.add(ring); }
      else if(style==='led'){ const fab=drape(w*0.97,bh*0.96,'#1b1b22',{depth:.12,pitch:1.2}); fab.position.set(0,bh/2,z+0.55); g.add(fab);
        const scr=boxMesh(w*0.5,bh*0.55,0.2,'#3b82f6',{emissive:col('#5b8cff'),emissiveIntensity:.6}); scr.position.set(0,bh*0.55,z+0.8); g.add(scr); }
      else if(style==='jaali'){ const fab=drape(w*0.97,bh*0.96,'#fbf6ea',{depth:.1,pitch:1.4}); fab.position.set(0,bh/2,z+0.55); g.add(fab);
        const n=Math.max(3,Math.round(w/4)), pw=w/n;
        for(let i=0;i<n;i++){ const cx=-w/2+(i+0.5)*pw, top=bh*0.85;
          for(let k=0;k<=6;k++){ const y=0.6+k*(top-0.6)/6; rodAB(g,[cx-pw*0.4,y,z+0.85],[cx+pw*0.4,y,z+0.85],0.05,'#d9b45a',GOLD); }
          for(let k=0;k<=4;k++){ const x=cx-pw*0.4+k*pw*0.2; rodAB(g,[x,0.6,z+0.85],[x,top,z+0.85],0.05,'#d9b45a',GOLD); }
          const cap=new THREE.Mesh(new THREE.TorusGeometry(pw*0.4,0.08,8,24,Math.PI),mat('#d9b45a',GOLD)); cap.position.set(cx,top,z+0.85); g.add(cap); } }
      else return false;
      if(floralOK(it) && style!=='led'){ const an=[]; for(const s of [-1,1]) for(let y=0.5;y<bh*0.5;y+=0.6) an.push([s*(w/2-0.7),y,z+1.1]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.24, rMax:.48, per:2, spread:.35}); }
      return true; }
    if(t==='centrepiece'){
      const rr=Math.min(w,d)/2;
      if(style==='low'){ g.add(lathe([[0.01,0],[rr*0.5,0],[rr*0.75,0.5],[rr*0.8,0.7],[0.01,0.7]],'#d9b45a',GOLD));
        const an=[]; for(let i=0;i<12;i++){ const a=i/12*Math.PI*2; an.push([Math.cos(a)*rr*0.55,0.85+rand()*0.2,Math.sin(a)*rr*0.55]); } an.push([0,1.1,0]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.16, rMax:.28, per:2, spread:.2}); return true; }
      if(style==='lantern'){ const fr=boxMesh(rr*0.9,2.2,rr*0.9,'#ffffff',{transparent:true,opacity:.25,roughness:.1}); fr.position.y=1.1; g.add(fr);
        for(const sx of [-1,1]) for(const sz of [-1,1]) rodAB(g,[sx*rr*0.45,0,sz*rr*0.45],[sx*rr*0.45,2.2,sz*rr*0.45],0.04,'#d9b45a',GOLD);
        const tp=new THREE.Mesh(new THREE.ConeGeometry(rr*0.7,0.6,4),mat('#d9b45a',GOLD)); tp.rotation.y=Math.PI/4; tp.position.y=2.5; g.add(tp);
        bulbs(g, [[0,0.9,0]], '#ffcf7a', 0.18);
        const an=[]; for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; an.push([Math.cos(a)*rr*0.75,0.2,Math.sin(a)*rr*0.75]); }
        blooms(g, an, {rand, pal:pal(c,'ivory'), rMin:.14, rMax:.24, per:2, spread:.15}); return true; }
      return false; }
    return false;   // mandap styles are applied inside its own case
  }
  function entranceVariant(g, it, style, rand, mode){
    const w=it.width, d=it.height, c=it.color, H=Math.max(8,Math.min(11,w*0.75)), P=mode==='flower'?pal(c,'blush'):balloonPal(c);
    const wood=style==='rustic', metal=wood?'#7a4b28':'#d9b45a', mo=wood?tx('wood',{roughness:.8}):GOLD;
    const nArch=style==='tunnel'?Math.max(4,Math.min(8,Math.round(Math.max(d,6)/2))):1;
    const depth=style==='tunnel'?Math.max(d,6):0, anchors=[];
    if(mode==='garland'){   // low garland: balloons hugging a backdrop top + one side
      const bd=boxMesh(w,7,0.3,'#f6f0e6',tx('fabric',{})); bd.position.set(0,3.5,-0.3); g.add(bd);
      for(let x=-w/2;x<=w/2;x+=0.5) anchors.push([x, 7+Math.sin(x*1.3)*0.4, 0]);
      for(let y=0.5;y<7;y+=0.5) anchors.push([-w/2+Math.sin(y)*0.3, y, 0.1]);
    } else if(style==='pillars'){
      for(const s of [-1,1]){ const x=s*(w/2-1); const p=cyl(0.9,1.0,H,'#f3ede2',tx('fabric',{roughness:.7}),18); p.position.set(x,H/2,0); g.add(p);
        const pl=boxMesh(2.4,0.6,2.4,'#d9b45a',GOLD); pl.position.set(x,0.3,0); g.add(pl);
        for(let y=0.8;y<H+0.6;y+=0.45){ const a=y*2.4; anchors.push([x+Math.cos(a)*0.95, y, Math.sin(a)*0.95]); anchors.push([x-Math.cos(a)*0.95, y, -Math.sin(a)*0.95]); }
        for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; anchors.push([x+Math.cos(a)*0.8,H+0.4,Math.sin(a)*0.8]); } }
    } else {
      const fp=framePath(style==='rustic'?'square':style==='tunnel'?'':style, w, H);
      for(let k=0;k<nArch;k++){ const z=nArch>1?-depth/2+k*depth/(nArch-1):0;
        for(let i=0;i<fp.pts.length-1;i++){ const a=fp.pts[i], b=fp.pts[i+1]; rodAB(g,[a[0],a[1],z],[b[0],b[1],z],wood?0.22:0.1,metal,mo);
          const L=Math.hypot(b[0]-a[0],b[1]-a[1]), n=Math.max(1,Math.round(L/0.45));
          for(let j=0;j<n;j++){ const t=j/n, x=a[0]+(b[0]-a[0])*t, y=a[1]+(b[1]-a[1])*t;
            // flowers: full on a tunnel / pillar gate, asymmetric "corner sweep" on modern frames; balloons: full
            const cover = mode!=='flower' || nArch>1 || (x<0 ? y>H*0.25 : y>H*0.75) || (style==='' && x<0);
            if(cover && (mode!=='flower' || rand()<0.92)) anchors.push([x,y,z]); } }
        (fp.legs||[]).forEach(([lx])=>{ const low=fp.pts.reduce((m,p)=>p[1]<m[1]?p:m,[0,99]); rodAB(g,[lx,0,z],[lx*0.6+low[0]*0.4,low[1],z],0.08,metal,mo); });
        if(fp.legs) for(const s of [-1,1]){ const ft=boxMesh(1.4,0.2,Math.max(1.2,d*0.5),'#3a3a3a'); ft.position.set(s*Math.abs(fp.legs[0][0]),0.1,z); g.add(ft); }
      }
      if(wood){ const beam=boxMesh(w+1.2,0.45,0.5,metal,mo); beam.position.set(0,H+0.2,0); g.add(beam);
        for(const s of [-1,1]){ const br=boxMesh(0.35,2.2,0.35,metal,mo); br.position.set(s*(w/2-1.2),H-0.9,0); br.rotation.z=s*0.75; g.add(br); } }
      if(nArch===1 && mode==='flower'){ const sheer=drape(Math.max(2,w-1.4),H*0.9,'#ffffff',{depth:.25,m:{transparent:true,opacity:.3}}); sheer.position.set(0,H*0.45,-0.45); g.add(sheer); }
    }
    if(mode==='flower') blooms(g, anchors, {rand, pal:P, rMin:.24, rMax:.5, per:2, spread:.32});
    else { const bl=[]; anchors.forEach(a=>{ for(let k=0;k<2;k++){ const s=0.28+rand()*0.42; bl.push({x:a[0]+(rand()-0.5)*0.8,y:a[1]+(rand()-0.5)*0.8,z:a[2]+(rand()-0.5)*0.8,sx:s,sy:s*1.12,sz:s,c:P[(rand()*P.length)|0]}); } });
      const bi=instanced(new THREE.SphereGeometry(1,14,10), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.18,metalness:VAR.palette==='goldchrome'?.7:.05}), bl); if(bi) g.add(bi); }
    return true;
  }

  /* premium builders — return true when the type was built here (else the classic switch runs) */
  function buildPremium(it, chairs, g){
    const w=it.width, d=it.height, c=it.color, rand=rng(seedOf(it));
    VAR=(it&&it.properties&&typeof it.properties==='object')?it.properties:{};
    const style=String(VAR.style||'');
    if(style && styledFrame(g, it, style, rand)) return true;
    switch(it.type){
      case 'stage': {
        const H=3;
        const deck=boxMesh(w,H-0.25,d,'#262c3a'); deck.position.y=(H-0.25)/2; g.add(deck);
        const top=boxMesh(w+0.3,0.25,d+0.3,'#4a3a2e',tx('wood',{roughness:.45})); top.position.y=H-0.12; g.add(top);
        const fr=drape(w+0.3,H-0.3,c,{depth:.12,pitch:1.1}); fr.position.set(0,(H-0.3)/2,d/2+0.25); g.add(fr);
        for(const s of [-1,1]){ const sd=drape(d+0.3,H-0.3,c,{depth:.12,pitch:1.1}); sd.rotation.y=Math.PI/2; sd.position.set(s*(w/2+0.25),(H-0.3)/2,0); g.add(sd); }
        const strip=boxMesh(w+0.3,0.08,0.08,'#ffffff',{emissive:col('#ffd98a'),emissiveIntensity:.9}); strip.position.set(0,H-0.28,d/2+0.3); g.add(strip);
        // built-in backdrop wall (skipped when a separate stage floral backdrop stands behind it — no double wall)
        const bh=Math.min(14,Math.max(8,d*0.8)), ownBack=!((it.properties||{}).nobackdrop);
        if(ownBack){
        const frame=boxMesh(w,bh,0.5,'#1b2233'); frame.position.set(0,H+bh/2,-d/2+0.25); g.add(frame);
        const fab=drape(w*0.96,bh*0.94,'#f4efe6',{depth:.2,pitch:1.4}); fab.position.set(0,H+bh/2,-d/2+0.7); g.add(fab);
        const scr=boxMesh(w*0.42,bh*0.45,0.15,'#2f6fed',{emissive:col('#2f6fed'),emissiveIntensity:.45}); scr.position.set(0,H+bh*0.6,-d/2+1.0); g.add(scr);
        const an=[]; for(const s of [-1,1]) for(let y=0;y<bh;y+=0.9) an.push([s*(w*0.48-0.4*Math.sin(y/bh*Math.PI)), H+y+0.4, -d/2+1.1]);
        for(let x=-w*0.45;x<=w*0.45;x+=0.9) an.push([x, H+0.4+rand()*0.3, -d/2+1.1]);
        if(floralOK(it)) blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.25, rMax:.55, per:2, spread:.45});   // never on a rally / conference stage
        for(const s of [-1,1]){ const tw=boxMesh(1,H+bh+2,1,'#6b7280',{metalness:.5,roughness:.4}); tw.position.set(s*(w/2-0.5),(H+bh+2)/2,-d/2+0.5); g.add(tw); }
        const tt=boxMesh(w,0.9,0.9,'#6b7280',{metalness:.5,roughness:.4}); tt.position.set(0,H+bh+1.6,-d/2+0.5); g.add(tt);
        }
        const sw=Math.min(8,w*0.25);
        for(let i=0;i<3;i++){ const sh=H*(3-i)/4, t=boxMesh(sw,sh,1.1,'#2b3142'); t.position.set(0,sh/2,d/2+0.85+i*1.1); g.add(t);
          const tr=boxMesh(sw,0.06,1.1,'#4a3a2e'); tr.position.set(0,sh+0.03,d/2+0.85+i*1.1); g.add(tr); }
        return true; }
      case 'dancefloor': {
        const T=Math.max(2,Math.min(4,Math.max(w,d)/12)), nx=Math.max(1,Math.round(w/T)), nz=Math.max(1,Math.round(d/T)), tw=w/nx, td=d/nz, L=[];
        for(let i=0;i<nx;i++) for(let j=0;j<nz;j++) L.push({x:-w/2+tw*(i+0.5), y:0.12, z:-d/2+td*(j+0.5), sx:tw*0.97, sy:0.2, sz:td*0.97, c:(i+j)%2?'#f5f6fa':c});
        const t=instanced(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.18,metalness:.25}), L); if(t) g.add(t);
        const tr=boxMesh(w+0.6,0.16,d+0.6,'#b8a06a',{metalness:.6,roughness:.35}); tr.position.y=0.06; g.add(tr);
        return true; }
      case 'table': {
        dressedRound(g, it, chairs, Math.min(w,d)/2, it.properties && it.properties.shape==='square'); return true; }
      case 'cocktail': {
        const rad=Math.min(w,d)/2, H=3.6;
        g.add(lathe([[0.01,0.02],[rad*0.75,0.02],[rad*0.3,H*0.5],[rad*0.95,H-0.06],[0.01,H-0.06]],c,{roughness:.6,side:THREE.DoubleSide}));
        const top=cyl(rad,rad,0.1,'#f7f4ee',{roughness:.5},28); top.position.y=H; g.add(top);
        const v=lathe([[0.01,H],[0.18,H],[0.08,H+0.6],[0.12,H+0.9],[0.01,H+0.9]],'#dfe6ee',{transparent:true,opacity:.6}); g.add(v);
        blooms(g, [[0,H+1.1,0]], {rand, pal:pal(c,'blush'), rMin:.14, rMax:.24, per:5, spread:.22, leaves:false});
        const seats=Math.max(0,it.properties.seats|0), tcx=it.x+it.width/2,tcy=it.y+it.height/2,trot=it.rotation||0;
        for(let s=0;s<seats;s++){ const a=s/seats*Math.PI*2 - Math.PI/2; const [ox,oy]=rotOff(Math.cos(a)*(rad+1),Math.sin(a)*(rad+1),trot);
          chairs.push({ x:tcx+ox, y:tcy+oy, rot:a*180/Math.PI-90+trot, color:it.color, id:it.id }); }
        return true; }
      case 'longtable': case 'headtable': case 'recttable': {
        const H=2.5, head=it.type==='headtable'||it.type==='recttable', plain=it.type==='recttable';
        const cl=boxMesh(w,H,d,'#f7f4ee',{roughness:.92}); cl.position.y=H/2; g.add(cl);
        const run=boxMesh(w+0.1,0.03,d*0.36,c,{roughness:.8}); run.position.y=H+0.02; g.add(run);
        if(head && !plain){ const sk=drape(w,H-0.1,c,{depth:.1,pitch:.9}); sk.position.set(0,(H-0.1)/2,d/2+0.12); g.add(sk);
          for(let i=0;i<4;i++){ const x0=-w/2+i*w/4, x1=x0+w/4; g.add(swag([x0,H-0.05,d/2+0.2],[x1,H-0.05,d/2+0.2],0.7,'#f3e3c3',0.16)); } }
        const seats=Math.max(0,it.properties.seats|0), nTop=head?seats:Math.ceil(seats/2), nBot=head?0:seats-nTop, pl=[], an=[];
        const row=(n,side)=>{ for(let i=0;i<n;i++) pl.push({x:-w/2+(i+0.5)/Math.max(1,n)*w, y:H+0.07, z:side*(d/2-0.6), s:1}); };
        row(nTop,-1); row(nBot,1);
        const pls=instanced(new THREE.CylinderGeometry(0.42,0.36,0.05,16), new THREE.MeshStandardMaterial({color:col('#d9b45a'),metalness:.6,roughness:.35}), pl); if(pls) g.add(pls);
        if(!plain){ for(let x=-w/2+1.5;x<w/2-1;x+=3) an.push([x, H+0.35, head?d*0.2:0]);
        blooms(g, an, {rand, pal:pal(c,'ivory'), rMin:.18, rMax:.34, per:3, spread:.45});
        const cand=[]; for(let x=-w/2+3;x<w/2-2;x+=3) cand.push([x, H+0.25, head?d*0.2:0]); bulbs(g, cand, '#ffd98a', 0.08); }
        const cx0=it.x+it.width/2, cy0=it.y+it.height/2, trot=it.rotation||0;
        const addRow=(n,side)=>{ for(let i=0;i<n;i++){ const lx=-w/2+(i+0.5)/Math.max(1,n)*w;
          const [ox,oy]=rotOff(lx, side*(d/2+1.1), trot);
          chairs.push({ x:cx0+ox, y:cy0+oy, rot:(side<0?180:0)+trot, color:it.color, id:it.id }); } };
        addRow(nTop,-1); addRow(nBot,+1);
        return true; }
      case 'arch': {
        const r=Math.max(1.5,Math.min(w/2-0.3,7)), L=Math.max(3,8-r*0.5);
        const arc=new THREE.Mesh(new THREE.TorusGeometry(r,0.22,10,40,Math.PI),mat(c,GOLD)); arc.position.y=L; arc.castShadow=true; g.add(arc);
        for(const s of [-1,1]){ const leg=cyl(0.22,0.22,L,c,GOLD,12); leg.position.set(s*r,L/2,0); g.add(leg);
          const base=boxMesh(1.2,0.5,Math.max(1,d),'#e9e2d0'); base.position.set(s*r,0.25,0); g.add(base); }
        const sheer=drape(2*r*0.95,L+r*0.8,'#ffffff',{depth:.25,m:{transparent:true,opacity:.45}}); sheer.position.set(0,(L+r*0.8)/2,-0.3); g.add(sheer);
        for(const s of [-1,1]) g.add(swag([s*r*0.2,L+r*0.95,0.15],[s*r,L*0.55,0.2],0.6,'#f3e3c3',0.25));
        return true; }
      case 'floral': {
        const rad=Math.min(w,d)/2;
        g.add(lathe([[0.01,0],[0.45,0],[0.25,0.25],[0.3,1.2],[0.55,1.55],[0.01,1.55]],'#d9b45a',GOLD));
        const an=[[0,2.2,0]]; for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; an.push([Math.cos(a)*rad*0.6,1.75+rand()*0.4,Math.sin(a)*rad*0.6]); }
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.22, rMax:Math.max(.3,rad*0.3), per:3, spread:Math.max(.3,rad*0.35)});
        return true; }
      case 'floralarch': {
        const r=Math.max(1.5,w/2-0.4), L=Math.max(3,9-r), an=[];
        const arc=new THREE.Mesh(new THREE.TorusGeometry(r,0.15,8,40,Math.PI),mat('#d9b45a',GOLD)); arc.position.y=L; g.add(arc);
        for(const s of [-1,1]){ const leg=cyl(0.15,0.15,L,'#d9b45a',GOLD,10); leg.position.set(s*r,L/2,0); g.add(leg);
          const pot=lathe([[0.01,0],[0.7,0],[0.9,0.9],[0.75,1.0],[0.01,1.0]],'#f3efe6',{roughness:.6}); pot.position.set(s*r,0,0); g.add(pot); }
        // dense asymmetric florals: heavy on the left shoulder + crown, lighter on the right
        for(let t=0;t<=1.0001;t+=0.035){ const a=Math.PI*(1-t), weight=t<0.55?1:0.5;
          if(rand()<weight) an.push([Math.cos(a)*r, L+Math.sin(a)*r, 0]); }
        for(let y=0.8;y<L;y+=0.7){ an.push([-r,y,0]); if(y<L*0.45) an.push([r,y,0]); }
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.25, rMax:.6, per:3, spread:.5});
        const sheer=drape(2*r*0.9,L+r*0.7,'#ffffff',{depth:.3,m:{transparent:true,opacity:.35}}); sheer.position.set(0,(L+r*0.7)/2,-0.4); g.add(sheer);
        return true; }
      case 'mandap': {
        const H=10, pw=w/2-1.2, pd=d/2-1.2, plat=0.9;
        const p1=boxMesh(w,plat*0.5,d,'#efe6d2'); p1.position.y=plat*0.25; g.add(p1);
        const p2=boxMesh(w*0.82,plat*0.5,d*0.82,'#b5302f',{roughness:.95}); p2.position.y=plat*0.75; g.add(p2);
        const corners=[[-pw,-pd],[pw,-pd],[-pw,pd],[pw,pd]];
        const mst=String(VAR.style||'');   // décor variant: '' dome · flat floral canopy · south (banana stems) · glass (acrylic)
        corners.forEach(([x,z])=>{
          if(mst==='south'){ const st=cyl(0.45,0.55,H,'#5f8f3a',tx('leaf',{roughness:.6}),14); st.position.set(x,plat+H/2,z); g.add(st);
            for(let k=0;k<5;k++){ const lf=new THREE.Mesh(new THREE.SphereGeometry(1,8,5),mat('#3f7f2c',tx('leaf',{roughness:.5}))); lf.scale.set(0.5,2.6,0.08);
              const a=k/5*Math.PI*2; lf.position.set(x+Math.cos(a)*0.9,plat+H-0.8,z+Math.sin(a)*0.9); lf.rotation.set(Math.sin(a)*0.6,a,Math.cos(a)*0.6); g.add(lf); } return; }
          const p=lathe([[0.01,0],[0.75,0],[0.75,0.6],[0.42,0.9],[0.38,H-1.4],[0.55,H-1.0],[0.7,H-0.6],[0.7,H],[0.01,H]], mst==='glass'?'#dbeafe':'#d9b45a', mst==='glass'?{transparent:true,opacity:.45,roughness:.05,metalness:.1}:GOLD); p.position.set(x,plat,z); g.add(p); });
        const beamF=boxMesh(w-1,0.7,0.6,'#d9b45a',GOLD); beamF.position.set(0,plat+H+0.35,pd); g.add(beamF);
        const beamB=beamF.clone(); beamB.material=beamF.material.clone(); beamB.position.z=-pd; g.add(beamB);
        for(const s of [-1,1]){ const b=boxMesh(0.6,0.7,d-1,'#d9b45a',GOLD); b.position.set(s*pw,plat+H+0.35,0); g.add(b); }
        const dome=new THREE.Mesh(new THREE.SphereGeometry(1,24,12,0,Math.PI*2,0,Math.PI/2),mat('#fbf3e4',{roughness:.9,side:THREE.DoubleSide}));
        dome.scale.set(pw*0.95,3.2,pd*0.95); dome.position.y=plat+H+0.7;
        if(mst==='flat'||mst==='glass'){   // flat canopy: a fabric ceiling with hanging floral strands instead of the dome
          const ceil=boxMesh(w-1,0.15,d-1,'#fbf3e4',tx('fabric',{})); ceil.position.y=plat+H+0.7; g.add(ceil);
          const hx=[]; for(let x=-pw+0.6;x<pw;x+=1.2) hx.push(x);
          for(let zz=-pd+0.8;zz<pd;zz+=1.6) ladis(g, hx, zz, plat+H+0.6, 2.4, pal(c,'ivory'), rand);
        } else { g.add(dome); const fin=cyl(0.05,0.35,1.2,'#d9b45a',GOLD,12); fin.position.y=plat+H+4.4; g.add(fin); }
        if(mst==='south') for(const s2 of [-1,1]) for(const z2 of [-1,1]) bulbs(g, [[s2*(pw-0.9),plat+1.5,z2*(pd+0.1)]], '#ffb547', 0.12);
        // tie-back curtains at each pillar + fabric swags across the front & sides
        corners.forEach(([x,z])=>{ const cu=drape(1.6,H-0.4,'#f7efe2',{depth:.18,pitch:.6,m:{transparent:true,opacity:.8}}); cu.position.set(x,plat+(H-0.4)/2+0.2,z+(z>0?0.6:-0.6)); g.add(cu); });
        g.add(swag([-pw,plat+H,pd+0.4],[pw,plat+H,pd+0.4],1.6,c,0.3));
        for(const s of [-1,1]) g.add(swag([s*pw,plat+H,-pd],[s*pw,plat+H,pd],1.4,c,0.3));
        const an=[]; corners.forEach(([x,z])=>{ for(let k=0;k<5;k++) an.push([x+(rand()-0.5)*1.4, plat+H-0.2+rand()*0.8, z+(rand()-0.5)*1.4]); for(let y=plat+0.4;y<plat+2.2;y+=0.6) an.push([x,y,z+(z>0?0.8:-0.8)]); });
        blooms(g, an, {rand, pal:pal(c,'marigold'), rMin:.25, rMax:.5, per:3, spread:.45});
        const xs=[]; for(let x=-pw+1;x<pw-0.5;x+=1.1) xs.push(x); ladis(g, xs, pd+0.2, plat+H-0.1, 3.4, FLOWER_TONES.marigold, rand);
        const kund=boxMesh(1.4,0.7,1.4,'#8a5a2b'); kund.position.y=plat+0.35+0.5; g.add(kund);
        const fire=new THREE.Mesh(new THREE.ConeGeometry(0.45,1.1,10),new THREE.MeshBasicMaterial({color:col('#ff9a3c'),transparent:true,opacity:.85})); fire.position.y=plat+1.8; g.add(fire);
        return true; }
      case 'pillar': {
        const rr=Math.min(w,d)/2;
        g.add(lathe([[0.01,0],[rr,0],[rr,0.4],[rr*0.7,0.6],[rr*0.6,6.4],[rr*0.85,6.7],[rr,7],[rr,7.2],[0.01,7.2]],'#f1e9da',{roughness:.5}));
        const an=[[0,7.8,0]]; for(let i=0;i<7;i++){ const a=i/7*Math.PI*2; an.push([Math.cos(a)*rr*0.7,7.5+rand()*0.3,Math.sin(a)*rr*0.7]); }
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.22, rMax:.42, per:3, spread:.35});
        for(let i=0;i<4;i++){ const a=i/4*Math.PI*2+0.4; const tr=cyl(0.06,0.06,2.4,'#4f8a4b',{},6); tr.position.set(Math.cos(a)*rr*0.85,6.0,Math.sin(a)*rr*0.85); tr.rotation.z=0.12; g.add(tr); }
        return true; }
      case 'drape': {
        const H=10;
        const bar=cyl(0.1,0.1,w,'#9aa3b2',CHROME,8); bar.rotation.z=Math.PI/2; bar.position.y=H; g.add(bar);
        for(let x=-w/2;x<=w/2+0.01;x+=Math.max(4,w/Math.max(1,Math.round(w/8)))){ const p=cyl(0.1,0.1,H,'#9aa3b2',CHROME,8); p.position.set(x,H/2,0); g.add(p);
          const b=boxMesh(1.4,0.1,1.4,'#6b7280',CHROME); b.position.set(x,0.05,0); g.add(b); }
        const cl=drape(w,H-0.2,c,{depth:.22,pitch:1.0}); cl.position.y=(H-0.2)/2+0.1; g.add(cl);
        const n=Math.max(1,Math.round(w/6)); for(let i=0;i<n;i++){ const x0=-w/2+i*w/n; g.add(swag([x0,H-0.1,0.25],[x0+w/n,H-0.1,0.25],1.1,'#f3e3c3',0.22)); }
        return true; }
      case 'chandelier': {
        const rad=Math.min(w,d)/2, Y=9, cr=[], bl=[];
        const rods=cyl(0.05,0.05,3,'#d9b45a',GOLD,6); rods.position.y=Y+2.5; g.add(rods);
        [[rad,Y],[rad*0.68,Y+0.7],[rad*0.38,Y+1.3]].forEach(([rr,y],ti)=>{
          const ring=new THREE.Mesh(new THREE.TorusGeometry(rr,0.08,8,32),mat('#d9b45a',GOLD)); ring.rotation.x=Math.PI/2; ring.position.y=y; g.add(ring);
          const n=Math.max(8,Math.round(rr*7));
          for(let i=0;i<n;i++){ const a=i/n*Math.PI*2; for(let k=0;k<3;k++) cr.push({x:Math.cos(a)*rr,y:y-0.25-k*0.32-(i%2)*0.18,z:Math.sin(a)*rr,s:0.11-k*0.02,ry:a});
            if(i%2===0) bl.push([Math.cos(a)*rr,y+0.2,Math.sin(a)*rr]); }
          if(ti===0) for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; g.add(swag([Math.cos(a)*rr,y,Math.sin(a)*rr],[0,Y+1.9,0],-0.2,'#d9b45a',0.03,GOLD)); }
        });
        const crystals=instanced(new THREE.OctahedronGeometry(1,0), new THREE.MeshStandardMaterial({color:col('#f4f8ff'),metalness:.3,roughness:.05,transparent:true,opacity:.85,emissive:col('#fff3d6'),emissiveIntensity:.25}), cr.map(o=>Object.assign(o,{sy:o.s*1.8,sx:o.s,sz:o.s}))); if(crystals) g.add(crystals);
        bulbs(g, bl, '#ffe2a8', 0.16);
        const drop=new THREE.Mesh(new THREE.OctahedronGeometry(0.35,0),mat('#f4f8ff',{emissive:col('#fff3d6'),emissiveIntensity:.5})); drop.scale.y=2; drop.position.y=Y-0.6; g.add(drop);
        return true; }
      case 'lounge': {
        const rug=boxMesh(w,0.05,d,c,{roughness:1,transparent:true,opacity:.55}); rug.position.y=0.03; g.add(rug);
        const sofa=(sw,sd,x,z,ry)=>{ const s=new THREE.Group();
          const base=boxMesh(sw,1.0,sd,'#f2ede4'); base.position.y=0.75; s.add(base);
          const bk=boxMesh(sw,1.5,0.5,'#f2ede4'); bk.position.set(0,1.8,-sd/2+0.25); s.add(bk);
          for(const e of [-1,1]){ const arm=boxMesh(0.5,1.1,sd,'#f2ede4'); arm.position.set(e*(sw/2-0.25),1.4,0); s.add(arm); }
          const n=Math.max(2,Math.round(sw/2.2)); for(let i=0;i<n;i++){ const cu=boxMesh(sw/n*0.82,0.9,0.3,c,{roughness:.9}); cu.position.set(-sw/2+(i+0.5)*sw/n,1.75,-sd/2+0.65); cu.rotation.x=-0.2; s.add(cu); }
          const legs=boxMesh(sw*0.95,0.25,sd*0.9,'#3a2c22'); legs.position.y=0.12; s.add(legs);
          s.position.set(x,0,z); s.rotation.y=ry; return s; };
        g.add(sofa(Math.min(w*0.62,9),2.6,0,-d/2+1.5,0));
        for(const e of [-1,1]) g.add(sofa(2.6,2.6,e*(w/2-1.6),d*0.1,-e*Math.PI/2));
        const ct=cyl(Math.min(w,d)*0.14,Math.min(w,d)*0.14,0.12,'#e9e2d0',{roughness:.3},28); ct.position.y=1.3; g.add(ct);
        const ctb=cyl(Math.min(w,d)*0.08,Math.min(w,d)*0.1,1.25,'#d9b45a',GOLD,20); ctb.position.y=0.62; g.add(ctb);
        blooms(g, [[0,1.7,0]], {rand, pal:pal(c,'ivory'), rMin:.15, rMax:.28, per:5, spread:.3});
        return true; }
      case 'bar': {
        const cz=-d*0.15, cd=d*0.5;
        const front=boxMesh(w,3.5,cd,'#2a2f3b',{roughness:.4,metalness:.3}); front.position.set(0,1.75,cz); g.add(front);
        const top=boxMesh(w+0.5,0.2,cd+0.4,'#f3f1ec',{roughness:.2}); top.position.set(0,3.6,cz); g.add(top);
        const glow=boxMesh(w,0.12,0.06,'#ffffff',{emissive:col(c),emissiveIntensity:1}); glow.position.set(0,0.4,cz+cd/2+0.04); g.add(glow);
        const back=boxMesh(w*0.95,7,0.5,'#1b1f27'); back.position.set(0,3.5,-d/2+0.25); g.add(back);
        const L=[]; for(const y of [3.4,4.9,6.4]){ const sh=boxMesh(w*0.9,0.08,0.7,'#d9b45a',GOLD); sh.position.set(0,y,-d/2+0.6); g.add(sh);
          for(let x=-w*0.43;x<w*0.43;x+=0.45) L.push({x,y:y+0.45,z:-d/2+0.6,sx:0.14,sy:0.4,sz:0.14,c:['#2f6b3a','#7a2e1f','#c9a06a','#dfe6ee','#3b4a8a'][(rand()*5)|0]}); }
        const bt=instanced(new THREE.CylinderGeometry(1,1,2,8), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.15,metalness:.2,transparent:true,opacity:.9}), L); if(bt) g.add(bt);
        return true; }
      case 'buffet': {
        const H=3;
        const ct=boxMesh(w,0.15,d,'#f7f4ee'); ct.position.y=H; g.add(ct);
        const sk=drape(w,H-0.05,c,{depth:.1,pitch:.8}); sk.position.set(0,(H-0.05)/2,d/2+0.1); g.add(sk);
        const body=boxMesh(w-0.1,H-0.05,d-0.1,'#e9e2d0'); body.position.y=(H-0.05)/2; g.add(body);
        const n=Math.max(2,Math.round(w/3.2)), pans=[], lids=[];
        for(let i=0;i<n;i++){ const x=-w/2+(i+0.5)*w/n; pans.push({x,y:H+0.35,z:0,sx:1.1,sy:0.3,sz:0.8}); lids.push({x,y:H+0.55,z:0,s:0.7,sx:1.1,sz:0.8}); }
        const pi=instanced(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:col('#c9ccd6'),...CHROME}), pans); if(pi) g.add(pi);
        const li=instanced(new THREE.SphereGeometry(1,16,8,0,Math.PI*2,0,Math.PI/2), new THREE.MeshStandardMaterial({color:col('#dfe3ea'),...CHROME}), lids); if(li) g.add(li);
        const guard=boxMesh(w*0.96,0.05,d*0.7,'#dff3ff',{transparent:true,opacity:.3,roughness:.05}); guard.position.y=H+1.9; g.add(guard);
        for(const s of [-1,1]){ const p=cyl(0.05,0.05,1.9,'#c9ccd6',CHROME,6); p.position.set(s*w*0.46,H+0.95,0); g.add(p); }
        return true; }
      case 'photobooth': {
        const bh=8, wall=boxMesh(w,bh,0.4,'#f3efe6'); wall.position.set(0,bh/2,-d/2+0.2); g.add(wall);
        const an=[]; for(let x=-w/2+0.5;x<w/2;x+=0.75) for(let y=0.6;y<bh;y+=0.75) an.push([x+(rand()-0.5)*0.2,y,-d/2+0.55]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.24, rMax:.4, per:1, spread:.15, leaves:false});
        const neon=new THREE.Mesh(new THREE.TorusGeometry(Math.min(w,bh)*0.18,0.06,8,32),new THREE.MeshBasicMaterial({color:col('#ffd1e8')})); neon.position.set(0,bh*0.62,-d/2+1.0); g.add(neon);
        const bench=boxMesh(w*0.4,1.4,1.4,'#f7f4ee'); bench.position.set(0,0.7,-d/2+1.6); g.add(bench);
        const tri=cyl(0.06,0.06,5,'#20242c',{},6); tri.position.set(0,2.5,d/2-0.8); g.add(tri);
        const ring=new THREE.Mesh(new THREE.TorusGeometry(0.8,0.1,8,28),new THREE.MeshBasicMaterial({color:col('#fffaf0')})); ring.position.set(0,5.2,d/2-0.8); g.add(ring);
        return true; }
      case 'caketable': case 'gifttable': {
        const H=2.5, round=it.type==='caketable', rad=Math.min(w,d)/2;
        if(round) g.add(lathe([[0.01,H],[rad,H],[rad+0.15,H-0.3],[rad+0.25,0.02],[0.01,0.02]],'#f7f4ee',{roughness:.92}));
        else { const cl=boxMesh(w,H,d,'#f7f4ee',{roughness:.92}); cl.position.y=H/2; g.add(cl); }
        if(round){ let y=H; [[0.95,0.9],[0.72,0.8],[0.5,0.75]].forEach(([r,h])=>{ const t=cyl(r,r,h,'#fffaf3',{roughness:.6},28); t.position.y=y+h/2; g.add(t); y+=h; });
          blooms(g, [[0.5,H+1.0,0.6],[-0.3,H+1.8,0.45],[0,H+2.5,0.1],[0.1,H+2.7,0]], {rand, pal:pal(c,'blush'), rMin:.12, rMax:.22, per:3, spread:.2}); }
        else { const L=[]; for(let i=0;i<7;i++){ const s=0.5+rand()*0.6; L.push({x:(rand()-0.5)*(w-1.2), y:H+s/2, z:(rand()-0.5)*(d-1), s, ry:rand()*1.5, c:[c,'#f3e3c3','#d9b45a','#ffffff'][i%4]}); }
          const gb=instanced(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.5}), L); if(gb) g.add(gb); }
        return true; }
      case 'redcarpet': {
        const rug=boxMesh(w,0.08,d,c,{roughness:1}); rug.position.y=0.05; g.add(rug);
        for(const s of [-1,1]){ const tr=boxMesh(0.25,0.09,d,'#d9b45a',GOLD); tr.position.set(s*(w/2-0.4),0.06,0); g.add(tr);
          const zs=[]; for(let z=-d/2+1;z<=d/2-1+0.01;z+=Math.max(4,d/Math.max(1,Math.round(d/6)))) zs.push(z);
          zs.forEach((z,i)=>{ const p=cyl(0.12,0.12,3,'#d9b45a',GOLD,10); p.position.set(s*(w/2+0.6),1.5,z); g.add(p);
            const b=cyl(0.45,0.5,0.15,'#d9b45a',GOLD,16); b.position.set(s*(w/2+0.6),0.08,z); g.add(b);
            if(i<zs.length-1) g.add(swag([s*(w/2+0.6),2.8,z],[s*(w/2+0.6),2.8,zs[i+1]],0.6,'#7a1f2b',0.08)); }); }
        return true; }
      case 'planter': {
        const rr=Math.min(w,d)/2;
        g.add(lathe([[0.01,0],[rr*0.6,0],[rr*0.85,1.4],[rr*0.95,1.6],[0.01,1.6]],'#e9e2d0',{roughness:.6}));
        const L=[]; for(let i=0;i<14;i++){ const a=rand()*Math.PI*2, h=1.8+rand()*1.6, rd=rr*0.75*(1-(h-1.8)/2.2); L.push({x:Math.cos(a)*rd,y:h,z:Math.sin(a)*rd,s:0.4+rand()*0.35,c:rand()<0.5?'#2f6b3a':'#3f7f45'}); }
        const im=instanced(new THREE.IcosahedronGeometry(1,0), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.95,flatShading:true}), L); if(im) g.add(im);
        return true; }
      case 'chiavari': {   // single chair; properties.style picks the look (gold chiavari / ghost / cross-back / folding / banquet cover / plastic)
        const st=VAR.style||'', LOOK={ ghost:['#e8f1f8',{transparent:true,opacity:.42,roughness:.05,metalness:.1}], crossback:['#8b5a2b',tx('wood',{roughness:.7})],
          folding:['#2b2b2b',{metalness:.6,roughness:.35}], banquet:['#f7f4ee',tx('fabric',{roughness:.95})], plastic:['#f5f5f5',{roughness:.35}] }[st] || [c,{roughness:.45,metalness:.35}];
        const m=new THREE.Mesh(chairGeometry(), mat(LOOK[0],LOOK[1])); m.castShadow=true; m.rotation.y=Math.PI; g.add(m);
        if(st==='banquet'){ const cov=boxMesh(1.35,1.6,0.12,'#f7f4ee',tx('fabric',{})); cov.position.set(0,2.4,-0.55); g.add(cov);
          const sash=boxMesh(1.4,0.35,0.16,c,{roughness:.7}); sash.position.set(0,2.2,-0.58); g.add(sash); }
        return true; }

      /* ---------------- new Indian-wedding / corporate products ---------------- */
      case 'phoolchadar': {   // phoolon ki chadar: a floral sheet carried on four bamboo poles over the bride
        const H=7.5, xs=[-w/2+0.3,w/2-0.3], zs=[-d/2+0.3,d/2-0.3], an=[];
        xs.forEach(x=>zs.forEach(z=>{ const p=cyl(0.1,0.12,H,'#d9b45a',GOLD,8); p.position.set(x,H/2,z); g.add(p); }));
        const sheet=boxMesh(w-0.4,0.12,d-0.4,'#fdf3e1',{roughness:.95}); sheet.position.y=H-0.2; g.add(sheet);
        for(let x=-w/2+0.6;x<w/2-0.4;x+=0.7) for(let z=-d/2+0.6;z<d/2-0.4;z+=0.7) an.push([x,H-0.05,z]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.16, rMax:.26, per:1, spread:.15, leaves:false});
        const ring=[]; for(let x=-w/2+0.5;x<w/2;x+=0.55){ ring.push(x); }
        ladis(g, ring, d/2-0.25, H-0.3, 2.2, ['#ffffff','#fde68a','#f59e0b',c], rand);
        ladis(g, ring, -d/2+0.25, H-0.3, 2.2, ['#ffffff','#fde68a','#f59e0b',c], rand);
        return true; }
      case 'jhoola': {        // decorated swing: A-frame, chains, cushioned seat, floral wrap
        const H=8.5, seatY=1.8, sw=w*0.62;
        for(const s of [-1,1]){ for(const z of [-d/2+0.3,d/2-0.3]){ const leg=cyl(0.14,0.18,H+0.3,'#d9b45a',GOLD,10); leg.position.set(s*(w/2-0.5),H/2,z*0.95); leg.rotation.x=z>0?-0.12:0.12; g.add(leg); } }
        const beam=cyl(0.18,0.18,w-0.6,'#d9b45a',GOLD,12); beam.rotation.z=Math.PI/2; beam.position.y=H; g.add(beam);
        for(const s of [-1,1]){ const ch=cyl(0.04,0.04,H-seatY-0.2,'#c9ccd6',CHROME,6); ch.position.set(s*sw*0.45,(H+seatY)/2,0); g.add(ch); }
        const seat=boxMesh(sw,0.35,d*0.45,'#8a5a2b',{roughness:.5}); seat.position.y=seatY; g.add(seat);
        const cu=boxMesh(sw*0.95,0.35,d*0.42,c,{roughness:.9}); cu.position.y=seatY+0.35; g.add(cu);
        const bk=boxMesh(sw,1.6,0.2,'#8a5a2b',{roughness:.5}); bk.position.set(0,seatY+1.0,-d*0.2); g.add(bk);
        const an=[]; for(let x=-w/2+0.6;x<w/2-0.5;x+=0.6) an.push([x,H+0.15,0]); for(let y=seatY+0.3;y<H;y+=0.7){ an.push([-sw*0.45,y,0]); an.push([sw*0.45,y,0]); }
        blooms(g, an, {rand, pal:pal(c,'marigold'), rMin:.18, rMax:.32, per:2, spread:.25});
        return true; }
      case 'haldi': {         // haldi set: low yellow platform, marigold backdrop with ladis, gaddi seating, brass urlis
        const P=0.8, plat=boxMesh(w,P,d,'#f3c623',{roughness:.9}); plat.position.y=P/2; g.add(plat);
        const bh=9, bd=boxMesh(w,bh,0.3,'#fde68a',{roughness:.95}); bd.position.set(0,P+bh/2,-d/2+0.15); g.add(bd);
        const xs=[]; for(let x=-w/2+0.4;x<w/2;x+=0.5) xs.push(x); ladis(g, xs, -d/2+0.45, P+bh-0.2, bh-0.6, FLOWER_TONES.marigold, rand);
        const an=[]; for(let x=-w/2;x<=w/2;x+=0.8) an.push([x,P+bh+0.1,-d/2+0.4]);
        blooms(g, an, {rand, pal:pal(c,'marigold'), rMin:.25, rMax:.45, per:2, spread:.3});
        const gaddi=boxMesh(w*0.4,0.5,2.6,c,{roughness:.9}); gaddi.position.set(0,P+0.25,-d/2+2.2); g.add(gaddi);
        for(const s of [-1,1]){ const bol=cyl(0.35,0.35,1.5,'#b5302f',{roughness:.9},14); bol.rotation.x=Math.PI/2; bol.position.set(s*w*0.2,P+0.85,-d/2+2.2); g.add(bol); }
        const ur=[]; for(const s of [-1,1]) ur.push({x:s*w*0.32,y:P+0.25,z:d/2-1.4,sx:1,sy:0.35,sz:1});
        const u=instanced(new THREE.SphereGeometry(1,20,10,0,Math.PI*2,Math.PI/2,Math.PI/2), new THREE.MeshStandardMaterial({color:col('#c99a3c'),...GOLD,side:THREE.DoubleSide}), ur); if(u) g.add(u);
        blooms(g, ur.map(o=>[o.x,o.y+0.05,o.z]), {rand, pal:FLOWER_TONES.marigold, rMin:.15, rMax:.25, per:6, spread:.5, leaves:false});
        return true; }
      case 'mehendi': {       // mehendi lounge: floor rug, gaddi + bolsters, low tables, umbrella canopies
        const rug=boxMesh(w,0.06,d,c,{roughness:1}); rug.position.y=0.03; g.add(rug);
        const border=boxMesh(w*0.9,0.07,d*0.9,'#2f6b3a',{roughness:1}); border.position.y=0.04; g.add(border);
        const nU=Math.max(1,Math.round(w/8)), cols=['#ec4899','#f59e0b','#10b981','#8b5cf6'];
        for(let i=0;i<nU;i++){ const x=-w/2+(i+0.5)*w/nU;
          const ga=boxMesh(Math.min(5,w/nU*0.8),0.45,2.2,'#f3e3c3',{roughness:.9}); ga.position.set(x,0.25,-d/4); g.add(ga);
          const bol=cyl(0.3,0.3,Math.min(4.5,w/nU*0.7),cols[i%4],{roughness:.9},12); bol.rotation.z=Math.PI/2; bol.position.set(x,0.75,-d/4-0.9); g.add(bol);
          const tb=boxMesh(1.6,0.9,1.6,'#8a5a2b'); tb.position.set(x,0.45,d/6); g.add(tb);
          const pole=cyl(0.06,0.06,7,'#d9b45a',GOLD,6); pole.position.set(x,3.5,d/6+1.4); g.add(pole);
          const um=new THREE.Mesh(new THREE.ConeGeometry(2.6,1.2,12,1,true),mat(cols[(i+1)%4],{side:THREE.DoubleSide,roughness:.9})); um.position.set(x,7.2,d/6+1.4); g.add(um); }
        const L=[]; for(let x=-w/2+0.5;x<w/2;x+=1.2) L.push([x,8.2,-d/2+0.3]); bulbs(g, L, '#ffd98a', 0.12);
        return true; }
      case 'selfieframe': {   // standing selfie frame with florals on the corners
        const fw=w, fh=Math.max(5,w*0.85), y0=1.0, t=0.35;
        for(const s of [-1,1]){ const v=boxMesh(t,fh,0.25,'#d9b45a',GOLD); v.position.set(s*(fw/2-t/2),y0+fh/2,0); g.add(v); }
        for(const yy of [y0,y0+fh]){ const hb=boxMesh(fw,t,0.25,'#d9b45a',GOLD); hb.position.set(0,yy,0); g.add(hb); }
        for(const s of [-1,1]){ const ft=boxMesh(0.3,y0,d*0.8,'#6b7280'); ft.position.set(s*(fw/2-0.3),y0/2,0); g.add(ft); }
        const an=[]; for(let k=0;k<6;k++){ an.push([-fw/2+0.3+k*0.25,y0+fh-0.2-k*0.1,0.1]); an.push([-fw/2+0.3,y0+fh-0.4-k*0.35,0.1]); an.push([fw/2-0.3-k*0.25,y0+0.2+k*0.08,0.1]); }
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.18, rMax:.34, per:2, spread:.2});
        const plate=boxMesh(fw*0.5,0.5,0.06,c); plate.position.set(0,y0+0.55,0.15); g.add(plate);
        return true; }
      case 'welcomeboard': {  // welcome sign on an easel with a floral spray
        const bw=Math.max(2.4,w*0.85), bh=bw*1.3;
        const board=boxMesh(bw,bh,0.12,'#fbf8f2',{roughness:.5}); board.position.set(0,2.6+bh/2-1.2,0); board.rotation.x=-0.1; g.add(board);
        const trim=boxMesh(bw+0.2,bh+0.2,0.08,'#d9b45a',GOLD); trim.position.set(0,2.6+bh/2-1.2,-0.08); trim.rotation.x=-0.1; g.add(trim);
        const band=boxMesh(bw*0.7,0.25,0.05,c); band.position.set(0,2.6+bh*0.62-1.2,0.12); band.rotation.x=-0.1; g.add(band);
        for(const s of [-1,1]){ const leg=boxMesh(0.12,5,0.12,'#d9b45a',GOLD); leg.position.set(s*bw*0.35,2.4,0.3); leg.rotation.x=0.12; g.add(leg); }
        const bl=boxMesh(0.12,5,0.12,'#d9b45a',GOLD); bl.position.set(0,2.3,-0.7); bl.rotation.x=-0.22; g.add(bl);
        const an=[]; for(let k=0;k<6;k++) an.push([-bw/2+0.1+k*0.22,2.6+bh-1.25-k*0.18,0.15]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.14, rMax:.26, per:3, spread:.2});
        return true; }
      case 'entrancegate': {  // floral entrance gate: two decorated pillars, crown beam, drapes, marigold ladis
        const H=11, pw=Math.max(1.6,Math.min(2.6,w*0.14)), an=[];
        for(const s of [-1,1]){ const x=s*(w/2-pw/2);
          const p=boxMesh(pw,H,Math.max(1.4,d*0.6),'#f3efe6',{roughness:.6}); p.position.set(x,H/2,0); g.add(p);
          const cap=boxMesh(pw+0.5,0.5,Math.max(1.4,d*0.6)+0.5,'#d9b45a',GOLD); cap.position.set(x,H+0.25,0); g.add(cap);
          const cu=drape(pw*1.2,H-1.5,'#fbf3e4',{depth:.15,pitch:.5,m:{transparent:true,opacity:.85}}); cu.position.set(x-s*pw*0.9,(H-1.5)/2,d*0.32); g.add(cu);
          for(let y=0.5;y<H;y+=0.8) an.push([x,y,d*0.32]); }
        const bw=w-pw*0.4, crown=boxMesh(bw,1.8,Math.max(1.2,d*0.5),'#f3efe6',{roughness:.6}); crown.position.y=H+1.2; g.add(crown);
        const band=boxMesh(bw*0.98,0.35,0.06,c,{roughness:.5}); band.position.set(0,H+1.2,Math.max(1.2,d*0.5)/2+0.03); g.add(band);
        const arc=new THREE.Mesh(new THREE.TorusGeometry(Math.min(3,w*0.15),0.18,8,24,Math.PI),mat('#d9b45a',GOLD)); arc.position.set(0,H+2.1,0); g.add(arc);
        for(let x=-bw/2;x<=bw/2;x+=0.75) an.push([x,H+2.15,d*0.28]);
        blooms(g, an, {rand, pal:pal(c,'marigold'), rMin:.22, rMax:.42, per:2, spread:.3});
        const xs=[]; for(let x=-w/2+pw+0.4;x<w/2-pw-0.3;x+=0.6) xs.push(x); ladis(g, xs, d*0.25, H+0.2, 3.0, FLOWER_TONES.marigold, rand);
        g.add(swag([-w/2+pw,H,d*0.3],[w/2-pw,H,d*0.3],1.8,'#fbf3e4',0.28));
        const L=[]; curvePts([-w/2+pw,H+0.3,d*0.35],[w/2-pw,H+0.3,d*0.35],0.8,24).forEach(p=>L.push(p)); bulbs(g, L, '#ffe2a8', 0.1);
        return true; }
      case 'kidszone': {      // kids play area: soft mat, inflatable bouncy castle, slide, ball pit
        const mat0=boxMesh(w,0.2,d,'#7dd3fc',{roughness:1}); mat0.position.y=0.1; g.add(mat0);
        const bw=Math.min(w*0.5,10), bd=Math.min(d*0.5,10), bx=-w/2+bw/2+0.5, bz=-d/2+bd/2+0.5;
        const bb=boxMesh(bw,1.6,bd,'#f43f5e',{roughness:.6}); bb.position.set(bx,0.9,bz); g.add(bb);
        const wallsC=['#facc15','#22c55e','#3b82f6','#a855f7'];
        [[0,-bd/2,bw,0.6],[0,bd/2,bw,0.6],[-bw/2,0,0.6,bd],[bw/2,0,0.6,bd]].forEach(([x,z,ww,dd],i)=>{ if(i===1) return; const wl=boxMesh(ww,4,dd,wallsC[i],{roughness:.6}); wl.position.set(bx+x,3.2,bz+z); g.add(wl); });
        for(const [x,z] of [[-1,-1],[1,-1],[-1,1],[1,1]]){ const t=cyl(0.7,0.7,6.5,wallsC[(x+z+4)%4],{roughness:.6},14); t.position.set(bx+x*bw/2,3.25,bz+z*bd/2); g.add(t);
          const cone=new THREE.Mesh(new THREE.ConeGeometry(0.9,1.4,14),mat('#f43f5e',{roughness:.6})); cone.position.set(bx+x*bw/2,7.2,bz+z*bd/2); g.add(cone); }
        const sx0=w/2-3, slide=boxMesh(2.2,0.25,Math.min(9,d*0.6),'#f97316',{roughness:.4}); slide.position.set(sx0,2.3,0); slide.rotation.x=-0.45; g.add(slide);
        const ladder=boxMesh(2.2,4.4,1,'#22c55e'); ladder.position.set(sx0,2.2,-Math.min(9,d*0.6)*0.45); g.add(ladder);
        const pit=cyl(Math.min(3,w*0.15),Math.min(3,w*0.15),1.2,'#3b82f6',{roughness:.7},24); pit.position.set(-w/4,0.8,d/2-Math.min(3,w*0.15)-0.6); g.add(pit);
        const balls=[]; for(let i=0;i<40;i++){ const a=rand()*Math.PI*2, rd=rand()*Math.min(3,w*0.15)*0.85; balls.push({x:-w/4+Math.cos(a)*rd,y:1.45+rand()*0.15,z:d/2-Math.min(3,w*0.15)-0.6+Math.sin(a)*rd,s:0.22,c:wallsC[i%4]}); }
        const bi=instanced(new THREE.SphereGeometry(1,8,6), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.4}), balls); if(bi) g.add(bi);
        return true; }
      case 'aircooler': {     // mist / air cooler on castors
        const bw=Math.min(w,d)*0.8, body=boxMesh(bw,4,bw*0.7,'#e5e7eb',{roughness:.5}); body.position.y=2.4; g.add(body);
        const grille=new THREE.Mesh(new THREE.CircleGeometry(bw*0.36,24),mat('#4b5563',{roughness:.6})); grille.position.set(0,3.2,bw*0.35+0.01); g.add(grille);
        const blades=new THREE.Mesh(new THREE.TorusGeometry(bw*0.3,0.05,6,20),mat('#9ca3af')); blades.position.set(0,3.2,bw*0.35+0.03); g.add(blades);
        const tank=boxMesh(bw,0.9,bw*0.7,c,{roughness:.5}); tank.position.y=0.85; g.add(tank);
        for(const [x,z] of [[-1,-1],[1,-1],[-1,1],[1,1]]){ const wh=cyl(0.15,0.15,0.2,'#1f2937',{},10); wh.rotation.z=Math.PI/2; wh.position.set(x*bw*0.4,0.18,z*bw*0.28); g.add(wh); }
        return true; }
      case 'fairylights': {   // overhead fairy-light canopy: strands radiating from a centre ring to four posts
        const H=11, top=13.5, posts=[[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]], L=[];
        posts.forEach(([x,z])=>{ const p=cyl(0.12,0.12,H,'#d9b45a',GOLD,8); p.position.set(x,H/2,z); g.add(p); });
        const n=Math.max(12,Math.round((w+d)/2));
        for(let i=0;i<n;i++){ const t=i/n, per=t*4, k=Math.floor(per), f=per-k, a=posts[k%4], b=posts[(k+1)%4];
          const ex=a[0]+(b[0]-a[0])*f, ez=a[1]+(b[1]-a[1])*f;
          curvePts([0,top,0],[ex,H,ez],1.4,Math.max(8,Math.round(Math.hypot(ex,ez)/1.2))).forEach(p=>L.push(p)); }
        bulbs(g, L, '#ffe2a8', 0.2);
        const hub=new THREE.Mesh(new THREE.TorusGeometry(0.8,0.08,6,20),mat('#d9b45a',GOLD)); hub.rotation.x=Math.PI/2; hub.position.y=top; g.add(hub);
        return true; }
      case 'livecounter': {   // live food counter: skirted counter, tawa/griddle, menu header on a canopy frame
        const H=3, body=boxMesh(w,H,d*0.6,'#f7f4ee'); body.position.set(0,H/2,d*0.15); g.add(body);
        const sk=drape(w,H-0.05,c,{depth:.1,pitch:.8}); sk.position.set(0,(H-0.05)/2,d*0.45+0.1); g.add(sk);
        const top=boxMesh(w+0.2,0.15,d*0.65,'#3a3f4a',{roughness:.3}); top.position.set(0,H+0.07,d*0.15); g.add(top);
        const tawa=cyl(0.9,0.9,0.12,'#1f2937',{metalness:.6,roughness:.4},24); tawa.position.set(-w*0.2,H+0.25,d*0.15); g.add(tawa);
        const pots=[]; for(let i=0;i<3;i++) pots.push({x:w*0.05+i*w*0.14,y:H+0.4,z:d*0.15,sx:0.55,sy:0.5,sz:0.55});
        const pi=instanced(new THREE.CylinderGeometry(1,0.85,1,16), new THREE.MeshStandardMaterial({color:col('#c9ccd6'),...CHROME}), pots); if(pi) g.add(pi);
        for(const s of [-1,1]){ const p=cyl(0.08,0.08,8,'#d9b45a',GOLD,8); p.position.set(s*(w/2-0.2),4,-d/2+0.3); g.add(p); }
        const hdr=boxMesh(w,1.4,0.15,c); hdr.position.set(0,7.6,-d/2+0.3); g.add(hdr);
        const sign=boxMesh(w*0.6,0.7,0.05,'#fbf8f2'); sign.position.set(0,7.6,-d/2+0.4); g.add(sign);
        const L=[]; for(let x=-w/2+0.3;x<w/2;x+=0.6) L.push([x,6.85,-d/2+0.35]); bulbs(g, L, '#ffe2a8', 0.09);
        return true; }
      case 'couplesofa': {    // maharaja couple sofa for the reception stage
        const sh=1.6;
        const base=boxMesh(w,sh,d*0.8,c,{roughness:.8}); base.position.set(0,sh/2+0.3,d*0.05); g.add(base);
        const back=lathe([[0.01,0],[w*0.5,0],[w*0.48,1.6],[w*0.35,2.6],[0.01,3.0]],'#d9b45a',GOLD); back.scale.z=0.12; back.position.set(0,sh+0.3,-d*0.35); g.add(back);
        const bpad=lathe([[0.01,0],[w*0.44,0],[w*0.42,1.4],[w*0.3,2.3],[0.01,2.6]],c,{roughness:.8}); bpad.scale.z=0.1; bpad.position.set(0,sh+0.4,-d*0.3); g.add(bpad);
        for(const s of [-1,1]){ const arm=cyl(0.4,0.4,d*0.8,'#d9b45a',GOLD,14); arm.rotation.x=Math.PI/2; arm.position.set(s*(w/2-0.3),sh+0.7,d*0.05); g.add(arm); }
        const cus=[]; for(const s of [-1,1]) cus.push({x:s*w*0.22,y:sh+0.75,z:-d*0.15,sx:1.1,sy:1.1,sz:0.35,c:'#f3e3c3'});
        const ci=instanced(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.9}), cus); if(ci) g.add(ci);
        const feet=boxMesh(w*0.95,0.3,d*0.7,'#d9b45a',GOLD); feet.position.set(0,0.15,d*0.05); g.add(feet);
        return true; }
      /* ---- event-aware décor + production pack (2026-10b). Real-world heights in ft. ---- */
      case 'floralentrance': {   // walk-through floral gateway: two flower-clad columns + a low arched header (~11 ft clear)
        const cw=Math.min(2.6,Math.max(1.6,w*0.17)), H=Math.max(9,Math.min(12,w*0.8)), span=w/2-cw/2, an=[];
        for(const s of [-1,1]){ const col0=boxMesh(cw,H,Math.max(1.2,d*0.6),'#efe8da',tx('fabric',{roughness:.9})); col0.position.set(s*span,H/2,0); g.add(col0);
          const plinth=boxMesh(cw+0.5,0.6,Math.max(1.6,d*0.75),'#d9b45a',GOLD); plinth.position.set(s*span,0.3,0); g.add(plinth);
          for(let y=0.9;y<H;y+=0.55) for(const zz of [d*0.32,-d*0.32]) an.push([s*span+(rand()-0.5)*cw*0.8, y, Math.sign(zz)*Math.max(0.65,d*0.32)]);
          for(let y=0.9;y<H;y+=0.7) an.push([s*(span+cw/2+0.1), y, (rand()-0.5)*d*0.5]); }
        const r=span, rise=Math.min(3,r*0.45);
        const hdr=new THREE.Mesh(new THREE.TorusGeometry(1,0.12,8,40,Math.PI),mat('#d9b45a',GOLD)); hdr.scale.set(r,rise,1); hdr.position.y=H; g.add(hdr);
        for(let t=0;t<=1.0001;t+=0.025){ const a=Math.PI*t; for(const zz of [-0.35,0.35]) an.push([Math.cos(a)*r, H+Math.sin(a)*rise, zz]); }
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.24, rMax:.48, per:2, spread:.32});
        const sheer=drape(2*span-cw,H*0.9,'#ffffff',{depth:.2,m:{transparent:true,opacity:.28}}); sheer.position.set(0,H*0.45+0.6,-d*0.35); g.add(sheer);
        return true; }
      case 'stagebackdrop': {    // full-width backdrop wall behind the stage: pleated fabric, floral frame + a gold ring motif
        const bh=Math.max(9,Math.min(14,w*0.45));
        const frame=boxMesh(w,bh,0.4,'#2a2a2a'); frame.position.set(0,bh/2,-d/2+0.2); g.add(frame);
        const fab=drape(w*0.97,bh*0.96,'#f6f0e6',{depth:.16,pitch:1.2}); fab.position.set(0,bh/2,-d/2+0.55); g.add(fab);
        const rr=Math.min(bh*0.32,w*0.18), ring=new THREE.Mesh(new THREE.TorusGeometry(rr,0.14,10,48),mat('#d9b45a',GOLD)); ring.position.set(0,bh*0.55,-d/2+0.8); g.add(ring);
        const an=[];
        for(const s of [-1,1]) for(let y=0.5;y<bh;y+=0.55) an.push([s*(w/2-0.6-Math.sin(y/bh*Math.PI)*0.6), y, -d/2+0.95]);
        for(let x=-w/2+0.8;x<=w/2-0.8;x+=0.6) an.push([x, bh-0.4-rand()*0.4, -d/2+0.95]);
        for(let x=-w/2+0.8;x<=w/2-0.8;x+=0.8) an.push([x, 0.5+rand()*0.3, -d/2+0.95]);
        for(let a=Math.PI*1.05;a<Math.PI*1.95;a+=0.12) an.push([Math.cos(a)*rr, bh*0.55+Math.sin(a)*rr, -d/2+0.95]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.24, rMax:.5, per:2, spread:.35});
        const bl=[]; for(let x=-w/2+1;x<w/2;x+=0.8) bl.push([x, bh+0.15, -d/2+0.5]); bulbs(g, bl, '#ffe2a8', 0.1);
        return true; }
      case 'flowerwall': {       // free-standing 8 ft flower wall: dense bloom grid on a boxed frame
        const bh=8;
        const panel=boxMesh(w,bh,0.5,'#2f5d34',tx('leaf',{roughness:.8})); panel.position.set(0,bh/2+0.3,0); g.add(panel);
        for(const s of [-1,1]){ const ft=boxMesh(0.5,0.3,Math.max(1.2,d),'#3a3a3a'); ft.position.set(s*(w/2-0.4),0.15,0); g.add(ft); }
        const an=[]; for(let y=0.7;y<bh+0.1;y+=0.48) for(let x=-w/2+0.35;x<=w/2-0.3;x+=0.48) an.push([x+(rand()-0.5)*0.12, y+0.3, 0.42]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.26, rMax:.36, per:1, spread:.05, leaves:false});
        return true; }
      case 'toran': {            // door-frame toran: marigold swags + hanging ladis + mango leaves on a slim frame
        const H=8, P=FLOWER_TONES.marigold;
        for(const s of [-1,1]){ const p=cyl(0.12,0.12,H,'#d9b45a',GOLD,10); p.position.set(s*(w/2-0.2),H/2,0); g.add(p);
          const ft=boxMesh(1,0.2,Math.max(1,d),'#3a3a3a'); ft.position.set(s*(w/2-0.2),0.1,0); g.add(ft); }
        const bar=cyl(0.1,0.1,w-0.2,'#d9b45a',GOLD,8); bar.rotation.z=Math.PI/2; bar.position.y=H; g.add(bar);
        const n=Math.max(2,Math.round(w/2.5)), sw=[];
        for(let i=0;i<n;i++){ const x0=-w/2+0.2+i*(w-0.4)/n; curvePts([x0,H-0.1,0.15],[x0+(w-0.4)/n,H-0.1,0.15],0.9,10).forEach(p=>sw.push({x:p[0],y:p[1],z:p[2],s:0.2+rand()*0.05,c:P[(rand()*P.length)|0]})); }
        const sm=instanced(new THREE.IcosahedronGeometry(1,1), new THREE.MeshStandardMaterial(tx('petal',{color:0xffffff,roughness:.8})), sw); if(sm) g.add(sm);
        const xs=[]; for(let x=-w/2+0.5;x<w/2-0.4;x+=0.55) xs.push(x); ladis(g, xs, 0.05, H-0.2, 2.2, P.concat(['#ffffff']), rand);
        const lv=[]; for(let x=-w/2+0.3;x<w/2-0.2;x+=0.35) lv.push({x, y:H-0.35, z:0.22, sx:0.12, sy:0.55, sz:0.03, rz:(rand()-0.5)*0.3, c:rand()<0.5?'#2f6b3a':'#3f7f3c'});
        const li=instanced(new THREE.SphereGeometry(1,8,5), new THREE.MeshStandardMaterial(tx('leaf',{color:0xffffff,roughness:.55})), lv); if(li) g.add(li);
        return true; }
      case 'floralpillar': {     // 7 ft column wrapped in a spiral of blooms, crowned and trailing greenery
        const rr=Math.min(w,d)/2, H=7;
        g.add(lathe([[0.01,0],[rr,0],[rr,0.35],[rr*0.62,0.55],[rr*0.55,H-0.4],[rr*0.8,H-0.1],[rr*0.85,H],[0.01,H]],'#f3ede2',tx('fabric',{roughness:.6})));
        const an=[]; for(let y=0.7;y<H;y+=0.32){ const a=y*2.2; an.push([Math.cos(a)*rr*0.62, y, Math.sin(a)*rr*0.62]); }
        for(let i=0;i<10;i++){ const a=i/10*Math.PI*2; an.push([Math.cos(a)*rr*0.7, H+0.25+rand()*0.35, Math.sin(a)*rr*0.7]); } an.push([0,H+0.7,0]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.24, rMax:.42, per:2, spread:.28});
        return true; }
      case 'aislefloral': {      // shepherd-style aisle stand: weighted base, slim gold stem, bowl + dome bouquet (~4.5 ft)
        const rr=Math.min(w,d)/2;
        g.add(lathe([[0.01,0],[rr*0.7,0],[rr*0.6,0.12],[0.08,0.3],[0.06,3.2],[0.35,3.45],[0.45,3.7],[0.01,3.7]],'#d9b45a',GOLD));
        const an=[[0,4.35,0]]; for(let i=0;i<9;i++){ const a=i/9*Math.PI*2; an.push([Math.cos(a)*0.45,3.9+rand()*0.25,Math.sin(a)*0.45]); }
        for(let i=0;i<4;i++){ const a=i/4*Math.PI*2+0.3; an.push([Math.cos(a)*0.5,3.4-i*0.12,Math.sin(a)*0.5]); }
        blooms(g, an, {rand, pal:pal(c,'ivory'), rMin:.18, rMax:.32, per:2, spread:.22});
        return true; }
      case 'centrepiece': {      // tall centrepiece stand: gold candelabra column + cascading floral ball + candles (~5.5 ft)
        const rr=Math.min(w,d)/2;
        g.add(lathe([[0.01,0],[rr*0.8,0],[rr*0.7,0.15],[0.12,0.45],[0.1,4.2],[0.5,4.5],[0.55,4.6],[0.01,4.6]],'#d9b45a',GOLD));
        const an=[]; for(let i=0;i<14;i++){ const a=i/14*Math.PI*2, k=rand(); an.push([Math.cos(a)*0.6*(0.6+k*0.4), 4.9+(rand()-0.3)*0.6, Math.sin(a)*0.6*(0.6+k*0.4)]); }
        for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; an.push([Math.cos(a)*0.55, 4.3-rand()*0.6, Math.sin(a)*0.55]); } an.push([0,5.4,0]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.18, rMax:.3, per:2, spread:.25});
        const cd=[]; for(let i=0;i<3;i++){ const a=i/3*Math.PI*2; cd.push([Math.cos(a)*0.9,1.0,Math.sin(a)*0.9]); }
        cd.forEach(p=>{ const cn=cyl(0.09,0.09,0.8,'#fbf6ea',{roughness:.5},10); cn.position.set(p[0],0.4,p[2]); g.add(cn); });
        bulbs(g, cd.map(p=>[p[0],0.88,p[2]]), '#ffcf7a', 0.06);
        return true; }
      case 'balloonarch': {      // organic balloon arch: clustered mixed-size latex balloons over a curved frame, weighted feet
        const r=Math.max(1.5,w/2-0.5), L=Math.max(2,7.5-r*0.5), P=balloonPal(c), bl=[];
        for(let t=0;t<=1.0001;t+=0.03){ const a=Math.PI*(1-t), bx=Math.cos(a)*r, by=L+Math.sin(a)*r;
          for(let k=0;k<3;k++){ const s=0.3+rand()*0.45; bl.push({x:bx+(rand()-0.5)*0.9, y:by+(rand()-0.5)*0.9, z:(rand()-0.5)*0.9, sx:s, sy:s*1.12, sz:s, c:P[(rand()*P.length)|0]}); } }
        for(const s of [-1,1]) for(let y=0.6;y<L;y+=0.55) for(let k=0;k<3;k++){ const q=0.3+rand()*0.4; bl.push({x:s*r+(rand()-0.5)*0.9, y:y+(rand()-0.5)*0.4, z:(rand()-0.5)*0.9, sx:q, sy:q*1.12, sz:q, c:P[(rand()*P.length)|0]}); }
        const bi=instanced(new THREE.SphereGeometry(1,14,10), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.18,metalness:.05}), bl); if(bi) g.add(bi);
        for(const s of [-1,1]){ const wt=cyl(0.5,0.6,0.35,'#2b2b2b',{roughness:.6},16); wt.position.set(s*r,0.18,0); g.add(wt); }
        return true; }
      case 'balloonbunch': {     // helium bouquet: weighted base, ribbons fanning to 7 balloons at 5–7 ft
        const P=balloonPal(c), bl=[];
        const wt=cyl(0.3,0.38,0.4,'#d9b45a',GOLD,16); wt.position.y=0.2; g.add(wt);
        for(let i=0;i<7;i++){ const a=i/7*Math.PI*2+rand()*0.4, rad=i?0.7+rand()*0.3:0, y=i?5.2+rand()*1.2:6.8, x=Math.cos(a)*rad, z=Math.sin(a)*rad, s=0.55+rand()*0.12;
          bl.push({x, y, z, sx:s, sy:s*1.15, sz:s, c:P[i%P.length]}); g.add(swag([0,0.4,0],[x,y-s*1.1,z],0.15,'#f5f5f5',0.012)); }
        const bi=instanced(new THREE.SphereGeometry(1,14,10), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.15,metalness:.08}), bl); if(bi) g.add(bi);
        return true; }
      case 'lectern': {          // solid-wood speaker lectern (~3.9 ft reading edge) with logo plate + gooseneck mic
        const W2=Math.max(1.6,w*0.8), D2=Math.max(1.2,d*0.75), wood=tx('wood',{roughness:.5});
        const plinth=boxMesh(W2+0.3,0.25,D2+0.3,'#3b2a1e',wood); plinth.position.y=0.12; g.add(plinth);
        const body=boxMesh(W2,3.4,D2,'#6b4a33',wood); body.position.y=0.25+1.7; g.add(body);
        const desk=boxMesh(W2+0.35,0.14,D2+0.3,'#5a3d2a',wood); desk.rotation.x=0.22; desk.position.set(0,3.85,0.02); g.add(desk);
        const lip=boxMesh(W2+0.35,0.12,0.06,'#3b2a1e',wood); lip.position.set(0,3.78,D2/2+0.12); g.add(lip);
        const plate=boxMesh(W2*0.62,W2*0.42,0.05,c,{metalness:.3,roughness:.4}); plate.position.set(0,2.6,D2/2+0.03); g.add(plate);
        const neck=new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(W2*0.25,3.9,-D2*0.2),new THREE.Vector3(W2*0.25,4.7,-D2*0.15),new THREE.Vector3(W2*0.12,4.85,D2*0.15)),12,0.025,6,false),mat('#1b1b1b',CHROME)); g.add(neck);
        const mic=cyl(0.05,0.035,0.28,'#111111',{roughness:.6},10); mic.rotation.x=Math.PI/2.4; mic.position.set(W2*0.12,4.85,D2*0.25); g.add(mic);
        return true; }
      case 'dais': {             // raised dais (2 ft) with carpet top, skirting, front steps, skirted table + high-back chairs facing the hall
        const ph=2, n=Math.max(1,Math.min(16,((it.properties||{}).chairs|0)||8));
        const deck=boxMesh(w,ph-0.1,d,'#2a2f3a'); deck.position.y=(ph-0.1)/2; g.add(deck);
        const top=boxMesh(w+0.1,0.1,d+0.1,'#7a1f2b',tx('carpet',{roughness:.95})); top.position.y=ph-0.05; g.add(top);
        const sk=drape(w+0.2,ph-0.15,c,{depth:.1,pitch:.8}); sk.position.set(0,(ph-0.15)/2,d/2+0.12); g.add(sk);
        for(const s of [-1,1]){ const ss=drape(d+0.2,ph-0.15,c,{depth:.1,pitch:.8}); ss.rotation.y=Math.PI/2; ss.position.set(s*(w/2+0.12),(ph-0.15)/2,0); g.add(ss); }
        for(let i=0;i<3;i++){ const sh=ph*(3-i)/3-0.05, st=boxMesh(Math.min(6,w*0.25),sh,0.9,'#2a2f3a'); st.position.set(0,sh/2,d/2+0.55+i*0.9); g.add(st);
          const tr=boxMesh(Math.min(6,w*0.25),0.06,0.9,'#7a1f2b',tx('carpet',{})); tr.position.set(0,sh+0.03,d/2+0.55+i*0.9); g.add(tr); }
        const tw=Math.min(w-1.5, n*2.6), tz=-d*0.05;
        const tcl=boxMesh(tw,2.5,2.2,'#f7f4ee',tx('fabric',{roughness:.92})); tcl.position.set(0,ph+1.25,tz); g.add(tcl);
        const run=boxMesh(tw+0.05,0.03,0.9,c,{roughness:.8}); run.position.set(0,ph+2.52,tz); g.add(run);
        const fx=Math.min(tw, w-1.5);
        for(let i=0;i<n;i++){ const x=-fx/2+(i+0.5)*fx/n, z=tz-2.2;
          const seat=boxMesh(1.7,0.45,1.6,'#5a1a22',tx('fabric',{roughness:.8})); seat.position.set(x,ph+1.55,z); g.add(seat);
          const back=boxMesh(1.7,3.0,0.35,'#5a1a22',tx('fabric',{roughness:.8})); back.position.set(x,ph+3.0,z-0.7); g.add(back);
          const crest=boxMesh(1.8,0.2,0.4,'#d9b45a',GOLD); crest.position.set(x,ph+4.55,z-0.7); g.add(crest);
          for(const s of [-1,1]){ const arm=boxMesh(0.2,0.7,1.5,'#d9b45a',GOLD); arm.position.set(x+s*0.9,ph+2.0,z); g.add(arm);
            for(const zz of [-0.65,0.65]){ const leg=cyl(0.07,0.06,1.3,'#d9b45a',GOLD,8); leg.position.set(x+s*0.72,ph+0.65,z+zz); g.add(leg); } } }
        return true; }
      case 'flagstand': {        // chrome pole (8 ft) on a weighted disc, gold finial, waving cloth flag
        const H=8, fw=Math.max(2.4,Math.min(4,w*1.5)), fh=fw*0.66;
        const base=cyl(Math.min(w,d)*0.4,Math.min(w,d)*0.45,0.25,'#2b2b2b',{metalness:.5,roughness:.4},24); base.position.y=0.12; g.add(base);
        const pole=cyl(0.06,0.07,H,'#c9ccd6',CHROME,12); pole.position.y=H/2+0.2; g.add(pole);
        const fin=new THREE.Mesh(new THREE.SphereGeometry(0.16,12,8),mat('#d9b45a',GOLD)); fin.position.y=H+0.35; g.add(fin);
        const flag=new THREE.Mesh(drapeGeo(fw,fh,2,0.18),mat(c,tx('fabric',{side:THREE.DoubleSide,roughness:.85}))); flag.position.set(fw/2+0.07,H-fh/2-0.05,0); flag.castShadow=true; g.add(flag);
        return true; }
      case 'hoarding': {         // banner hoarding on a steel scaffold: 10 ft printed face from 2 ft up, raked back props + ballast
        const bh=10, y0=2, bays=Math.max(1,Math.round(w/5)), steel=Object.assign({},CHROME,{roughness:.45});
        for(let i=0;i<=bays;i++){ const x=-w/2+i*w/bays;
          const up=cyl(0.08,0.08,y0+bh+0.4,'#8d939c',steel,8); up.position.set(x,(y0+bh+0.4)/2,-0.3); g.add(up);
          rodAB(g,[x,y0+bh*0.8,-0.3],[x,0.1,-0.3-Math.max(3,d*2)],0.07,'#8d939c',steel);   // raked back prop
          const bag=boxMesh(1.2,0.5,0.8,'#8b7a5a',{roughness:1}); bag.position.set(x,0.25,-0.3-Math.max(3,d*2)); g.add(bag); }
        for(const y of [y0, y0+bh/2, y0+bh]){ const rail=cyl(0.07,0.07,w,'#8d939c',steel,8); rail.rotation.z=Math.PI/2; rail.position.set(0,y,-0.3); g.add(rail); }
        const face=boxMesh(w,bh,0.08,'#f4f1ea',tx('fabric',{roughness:.8})); face.position.set(0,y0+bh/2,0); g.add(face);
        const band=boxMesh(w,bh*0.28,0.04,c,{roughness:.7}); band.position.set(0,y0+bh*0.2,0.07); g.add(band);
        const blk=boxMesh(w*0.5,bh*0.32,0.04,c,{roughness:.7,transparent:true,opacity:.55}); blk.position.set(-w*0.18,y0+bh*0.66,0.07); g.add(blk);
        return true; }
      case 'patower': {          // PA tower: 4-leg scaffold (14 ft) with deck, braced, line-array boxes on top + subs at the base
        const H=14, lx=w/2-0.2, lz=d/2-0.2, steel=Object.assign({},CHROME,{roughness:.45});
        for(const [x,z] of [[-lx,-lz],[lx,-lz],[-lx,lz],[lx,lz]]){ const lg=cyl(0.09,0.09,H,'#8d939c',steel,8); lg.position.set(x,H/2,z); g.add(lg);
          const jack=boxMesh(0.6,0.12,0.6,'#555555'); jack.position.set(x,0.06,z); g.add(jack); }
        for(let y=3;y<H;y+=3.5) for(const z of [-lz,lz]){ const r1=cyl(0.06,0.06,w-0.4,'#8d939c',steel,6); r1.rotation.z=Math.PI/2; r1.position.set(0,y,z); g.add(r1); }
        for(const z of [-lz,lz]) for(let y=0.5;y<H-3;y+=3.5) rodAB(g,[-lx,y,z],[lx,y+3,z],0.05,'#8d939c',steel);   // zig-zag face bracing
        const deck=boxMesh(w,0.25,d,'#4a3a2e',tx('wood',{})); deck.position.y=H; g.add(deck);
        for(let i=0;i<4;i++){ const bx=boxMesh(Math.min(3.2,w*0.8),0.95,Math.min(1.8,d*0.5),'#16181d',{roughness:.7}); bx.position.set(0,H+0.6+i*1.0,0.1+i*0.08); bx.rotation.x=-0.04*i; g.add(bx);
          const gr=boxMesh(Math.min(3.0,w*0.75),0.75,0.04,'#2b2f38',{roughness:.9}); gr.position.set(0,H+0.6+i*1.0,0.1+i*0.08+Math.min(1.8,d*0.5)/2+0.02); g.add(gr); }
        const sub=boxMesh(w*0.8,2.2,d*0.6,'#16181d',{roughness:.7}); sub.position.set(0,1.25,0); g.add(sub);
        return true; }
      case 'lightingtree': {     // lighting tree: tripod base, 2-stage telescopic pole, T-bar at ~10.5 ft carrying 2–4 LED PAR cans
        const R=Math.max(1.1,Math.min(w,d)/2-0.1), collar=2.1, top=10.5, alu={metalness:.6,roughness:.35};
        const nc=Math.max(2,Math.min(4,((it.properties||{}).cans|0)||(Math.min(w,d)>=2.6?4:2)));
        for(let i=0;i<3;i++){ const a=i/3*Math.PI*2+Math.PI/2, fx=Math.cos(a)*R, fz=Math.sin(a)*R;
          rodAB(g,[0,collar,0],[fx,0.06,fz],0.055,'#1c1c1c',alu);                                   // leg: hinge collar → rubber foot
          const ft=new THREE.Mesh(new THREE.SphereGeometry(0.09,8,6),mat('#111111',{roughness:.9})); ft.position.set(fx,0.06,fz); g.add(ft);
          rodAB(g,[0,collar-0.55,0],[fx*0.5,collar*0.5,fz*0.5],0.03,'#1c1c1c',alu); }            // brace: lower sliding collar → leg midpoint
        const sleeve=cyl(0.11,0.11,0.45,'#111111',alu,12); sleeve.position.y=collar; g.add(sleeve);
        const low=cyl(0.085,0.085,5.2,'#1c1c1c',alu,12); low.position.y=collar-0.6+2.6; g.add(low);
        const knob=cyl(0.12,0.12,0.22,'#111111',{roughness:.6},10); knob.position.y=collar-0.6+5.2; g.add(knob);
        const up=cyl(0.06,0.06,top-(collar+4.6),'#2a2a2a',alu,12); up.position.y=collar+4.6+(top-(collar+4.6))/2; g.add(up);
        const tbw=Math.max(2.6,Math.min(4.2,nc*1.0+0.6));
        const tb=cyl(0.06,0.06,tbw,'#1c1c1c',alu,10); tb.rotation.z=Math.PI/2; tb.position.y=top; g.add(tb);
        const tee=boxMesh(0.3,0.3,0.3,'#111111',alu); tee.position.y=top; g.add(tee);
        for(let i=0;i<nc;i++){ const x=-tbw/2+0.4+i*(tbw-0.8)/Math.max(1,nc-1);
          const clamp=boxMesh(0.14,0.2,0.18,'#111111',alu); clamp.position.set(x,top-0.14,0); g.add(clamp);
          const yoke=new THREE.Mesh(new THREE.TorusGeometry(0.32,0.03,6,16,Math.PI),mat('#111111',alu)); yoke.rotation.z=Math.PI; yoke.rotation.y=Math.PI/2; yoke.position.set(x,top-0.24,0); g.add(yoke);
          // can hangs under the bar, tilted 0.55 rad so its lens faces down-front (+z); the lens disc sits on its open end
          const can=cyl(0.27,0.24,0.62,'#141414',{metalness:.5,roughness:.4},16); can.position.set(x,top-0.58,0.04); can.rotation.x=-0.55; g.add(can);
          const lens=new THREE.Mesh(new THREE.CircleGeometry(0.23,16),new THREE.MeshBasicMaterial({color:col(c||'#ffd98a')})); lens.position.set(x,top-0.58-0.32*Math.cos(0.55),0.04+0.32*Math.sin(0.55)); lens.rotation.x=Math.PI/2-0.55; g.add(lens); }
        return true; }
      case 'diyastand': {        // samai / kuthu vilakku: brass lathe column, 3 tiers of oil plates with lit wicks, finial (~5 ft)
        const rr=Math.min(w,d)/2;
        g.add(lathe([[0.01,0],[rr*0.75,0],[rr*0.7,0.15],[rr*0.35,0.45],[0.1,0.7],[0.09,4.3],[0.16,4.45],[0.06,4.6],[0.14,4.9],[0.01,5.1]],'#c99a3a',GOLD));
        const fl=[];
        [[1.6,0.62,7],[2.8,0.5,6],[3.9,0.38,5]].forEach(([y,r0,n])=>{ const pl=lathe([[0.01,0],[r0,0.0],[r0+0.05,0.12],[0.01,0.08]],'#c99a3a',GOLD); pl.position.y=y; g.add(pl);
          for(let i=0;i<n;i++){ const a=i/n*Math.PI*2; fl.push([Math.cos(a)*r0*0.9, y+0.25, Math.sin(a)*r0*0.9]); } });
        bulbs(g, fl, '#ffb547', 0.06);
        fl.forEach(p=>{ const f=new THREE.Mesh(new THREE.ConeGeometry(0.045,0.2,8),new THREE.MeshBasicMaterial({color:col('#ffd27a'),transparent:true,opacity:.9})); f.position.set(p[0],p[1]+0.12,p[2]); g.add(f); });
        return true; }
      /* ---- religious + ambience pack (2026-10c) ---- */
      case 'havankund': {        // copper/brick havan kund on a low square platform: stepped pyramid pit, fire, kalash at the corners
        const R=Math.min(w,d)/2;
        const base=boxMesh(2*R,0.3,2*R,'#e8d9b5',tx('fabric',{roughness:.9})); base.position.y=0.15; g.add(base);
        [[1.3,0.45],[1.0,0.35],[0.75,0.3]].forEach(([k,h],i)=>{ const b=boxMesh(R*k,h,R*k,i%2?'#b45309':'#9a3412',{roughness:.7,metalness:.35}); b.position.y=0.3+[0.22,0.62,0.95][i]; g.add(b); });
        const fire=new THREE.Mesh(new THREE.ConeGeometry(R*0.28,1.3,10),new THREE.MeshBasicMaterial({color:col('#ff9a3c'),transparent:true,opacity:.85})); fire.position.y=1.9; g.add(fire);
        for(const sx of [-1,1]) for(const sz of [-1,1]){ const k=lathe([[0.01,0],[0.22,0.05],[0.3,0.3],[0.12,0.55],[0.18,0.65],[0.01,0.65]],'#c99a3a',GOLD); k.position.set(sx*R*0.82,0.3,sz*R*0.82); g.add(k);
          blooms(g, [[sx*R*0.82,1.05,sz*R*0.82]], {rand, pal:pal(c,'marigold'), rMin:.1, rMax:.14, per:3, spread:.1, leaves:true}); }
        return true; }
      case 'rangoli': {          // floor art: concentric coloured rings + petal ring + diya ring (flat, ~1 inch)
        const R=Math.min(w,d)/2, P=pal(c,'marigold'), L=[];
        [1,0.78,0.55,0.32].forEach((k,i)=>{ const m=new THREE.Mesh(new THREE.CylinderGeometry(R*k,R*k,0.04,48),mat(P[i%P.length],{roughness:.95})); m.position.y=0.02+i*0.01; g.add(m); });
        for(let i=0;i<12;i++){ const a=i/12*Math.PI*2; L.push({x:Math.cos(a)*R*0.66,y:0.08,z:Math.sin(a)*R*0.66,sx:R*0.14,sy:0.03,sz:R*0.06,ry:-a,c:P[(i+2)%P.length]}); }
        const pi=instanced(new THREE.SphereGeometry(1,10,6), new THREE.MeshStandardMaterial(tx('petal',{color:0xffffff,roughness:.8})), L); if(pi) g.add(pi);
        const dy=[]; for(let i=0;i<8;i++){ const a=i/8*Math.PI*2+0.2; dy.push([Math.cos(a)*R*0.92,0.12,Math.sin(a)*R*0.92]); } bulbs(g, dy, '#ffb547', 0.08);
        return true; }
      case 'lanterns': {         // cluster of three metal lanterns (1.5 / 2.2 / 3 ft) with candles
        const R=Math.min(w,d)/2;
        [[-0.4,-0.3,1.5],[0.35,-0.2,2.2],[0,0.35,3]].forEach(([x,z,h])=>{ const bx=x*R*1.6, bz=z*R*1.6, s=Math.min(0.75,R*0.5)*(0.6+h/6);
          const glass=boxMesh(s,h*0.75,s,'#fff7e0',{transparent:true,opacity:.28,roughness:.05}); glass.position.set(bx,h*0.4,bz); g.add(glass);
          for(const sx of [-1,1]) for(const sz of [-1,1]) rodAB(g,[bx+sx*s/2,0,bz+sz*s/2],[bx+sx*s/2,h*0.8,bz+sz*s/2],0.03,'#2b2b2b',{metalness:.6,roughness:.4});
          const top=new THREE.Mesh(new THREE.ConeGeometry(s*0.75,h*0.2,4),mat(c==='#ffffff'?'#2b2b2b':'#2b2b2b',{metalness:.6,roughness:.4})); top.rotation.y=Math.PI/4; top.position.set(bx,h*0.9,bz); g.add(top);
          bulbs(g, [[bx,h*0.25,bz]], (VAR.palette&&FLOWER_TONES[VAR.palette])?FLOWER_TONES[VAR.palette][0]:'#ffcf7a', 0.12); });
        return true; }
      case 'hangingfloral': {    // suspended floral ceiling: a rigging grid at ~11 ft with hanging strands and floral clusters
        const Y=11, an=[], xs=[];
        for(let x=-w/2+0.6;x<w/2;x+=1.2) xs.push(x);
        rodAB(g,[-w/2,Y,-d/2],[w/2,Y,-d/2],0.05,'#d9b45a',GOLD); rodAB(g,[-w/2,Y,d/2],[w/2,Y,d/2],0.05,'#d9b45a',GOLD);
        for(let z=-d/2+0.8;z<d/2;z+=1.6){ ladis(g, xs, z, Y, 1.6+rand()*1.6, pal(c,'ivory'), rand); }
        for(let i=0;i<Math.max(6,Math.round(w*d/10));i++) an.push([(rand()-0.5)*w*0.9, Y-0.2-rand()*0.5, (rand()-0.5)*d*0.9]);
        blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.25, rMax:.5, per:3, spread:.6});
        return true; }
      case 'neonsign': {         // neon script sign on a greenery / acrylic backing board (~7 ft high, no readable text)
        const H=7, bd=boxMesh(w,H,0.3,'#2f5d34',tx('leaf',{roughness:.8})); bd.position.set(0,H/2,0); g.add(bd);
        const nc=(VAR.palette&&FLOWER_TONES[VAR.palette])?FLOWER_TONES[VAR.palette][0]:'#ff4fd8', pts=[];
        for(let i=0;i<=40;i++){ const t=i/40; pts.push([-w*0.38+w*0.76*t, H*0.6+Math.sin(t*Math.PI*5)*H*0.08, 0.25]); }
        for(let i=0;i<pts.length-1;i++) rodAB(g,pts[i],pts[i+1],0.07,nc,{emissive:col(nc),emissiveIntensity:1.2});
        return true; }
      /* ---- complete-catalogue pack (2026-10d): generic basics + remaining event pieces. Real-world heights in ft. ---- */
      case 'backdrop': {         // generic free-standing backdrop (8 ft): frame + face whose look follows properties.style
        const H=8, z=0, st=VAR.style||'';
        for(const s of [-1,1]){ const up=cyl(0.06,0.06,H,'#9aa0aa',CHROME,8); up.position.set(s*w/2,H/2,z-0.15); g.add(up);
          const ft=boxMesh(0.25,0.08,Math.max(1.6,d*1.5),'#555555'); ft.position.set(s*w/2,0.04,z-0.15); g.add(ft); }
        const bar=cyl(0.06,0.06,w,'#9aa0aa',CHROME,8); bar.rotation.z=Math.PI/2; bar.position.set(0,H,z-0.15); g.add(bar);
        if(st==='flex'){ const f=boxMesh(w,H*0.95,0.06,'#f4f1ea',tx('fabric',{})); f.position.set(0,H*0.5,z); g.add(f);
          const band=boxMesh(w,H*0.25,0.04,c,{roughness:.7}); band.position.set(0,H*0.3,z+0.05); g.add(band); }
        else if(st==='sequin'){ const P=pal(c,'goldchrome'), L=[]; for(let x=-w/2+0.2;x<w/2;x+=0.4) for(let y=0.3;y<H;y+=0.4) L.push({x,y,z:z+0.05,sx:0.18,sy:0.18,sz:0.02,rz:(rand()-0.5)*0.6,c:P[(rand()*P.length)|0]});
          const back=boxMesh(w,H,0.05,'#8a8a8a',{metalness:.3,roughness:.5}); back.position.set(0,H/2,z-0.04); g.add(back);
          const im=instanced(new THREE.CircleGeometry(1,10), new THREE.MeshStandardMaterial({color:0xffffff,metalness:.35,roughness:.25,emissive:col('#222222'),side:THREE.DoubleSide}), L); if(im) g.add(im); }
        else if(st==='greenery'){ const f=boxMesh(w,H,0.3,'#4f8a4b',tx('leaf',{roughness:.85})); f.position.set(0,H/2,z); g.add(f);
          const L=[]; for(let i=0;i<Math.round(w*H*0.8);i++) L.push({x:(rand()-0.5)*w*0.96,y:0.2+rand()*(H-0.4),z:z+0.2,s:0.12+rand()*0.1,c:rand()<0.5?'#2f6b3a':'#4f8a4b'});
          const im=instanced(new THREE.IcosahedronGeometry(1,0), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.9,flatShading:true}), L); if(im) g.add(im); }
        else if(st==='wood'){ const n=Math.max(4,Math.round(w/0.6)); for(let i=0;i<n;i++){ const p=boxMesh(w/n*0.94,H,0.12,i%2?'#8b5a2b':'#9c6b3a',tx('wood',{roughness:.7})); p.position.set(-w/2+(i+0.5)*w/n,H/2,z); g.add(p); } }
        else if(st==='balloon'){ const P=balloonPal(c), L=[]; for(let x=-w/2+0.4;x<w/2;x+=0.7) for(let y=0.4;y<H;y+=0.7) L.push({x:x+(rand()-0.5)*0.2,y:y+(rand()-0.5)*0.2,z:z+0.2,s:0.38+rand()*0.12,c:P[(rand()*P.length)|0]});
          const im=instanced(new THREE.SphereGeometry(1,12,8), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.25}), L); if(im) g.add(im); }
        else { const f=drape(w,H*0.97,c,{depth:.15,pitch:1.0}); f.position.set(0,H*0.5,z); g.add(f); }
        return true; }
      case 'floralstand': {      // generic floral stand: tall gold stand / urn / pedestal bowl / hoop, topped with blooms
        const st=VAR.style||'', R=Math.min(w,d)/2, P=pal(c,'blush'); let top=4.2;
        if(st==='urn'){ g.add(lathe([[0.01,0],[R*0.5,0],[R*0.35,0.3],[R*0.75,1.6],[R*0.5,2.6],[R*0.7,2.9],[0.01,2.9]],'#e9e2d0',{roughness:.5})); top=3.1; }
        else if(st==='pedestal'){ g.add(lathe([[0.01,0],[R*0.6,0],[R*0.2,0.3],[R*0.15,2.6],[R*0.8,2.9],[R*0.9,3.2],[0.01,3.1]],'#ffffff',{roughness:.4})); top=3.3; }
        else if(st==='hoop'){ const base=boxMesh(R*1.4,0.15,R*0.8,'#d9b45a',GOLD); base.position.y=0.08; g.add(base);
          const ring=new THREE.Mesh(new THREE.TorusGeometry(Math.max(1.5,R*1.4),0.05,8,40),mat('#d9b45a',GOLD)); ring.position.y=Math.max(1.5,R*1.4)+0.3; g.add(ring);
          const rr=Math.max(1.5,R*1.4), an=[]; for(let a=Math.PI*0.9;a<Math.PI*1.6;a+=0.12) an.push([Math.cos(a)*rr,rr+0.3+Math.sin(a)*rr,0]);
          blooms(g, an, {rand, pal:P, rMin:.16, rMax:.3, per:2, spread:.2}); return true; }
        else { g.add(lathe([[0.01,0],[R*0.7,0],[R*0.6,0.1],[0.08,0.4],[0.06,3.8],[R*0.5,4.0],[0.01,4.1]],'#d9b45a',GOLD)); }
        const an=[]; for(let i=0;i<9;i++){ const a=i/9*Math.PI*2; an.push([Math.cos(a)*R*0.55, top+0.2+rand()*0.3, Math.sin(a)*R*0.55]); } an.push([0,top+0.6,0]);
        blooms(g, an, {rand, pal:P, rMin:.2, rMax:.36, per:2, spread:.3});
        return true; }
      case 'decorbox': {         // generic décor prop: box / cylinder / sphere / flat cut-out, in the item colour (or colour story)
        const st=VAR.style||'', cc=(VAR.palette&&FLOWER_TONES[VAR.palette])?FLOWER_TONES[VAR.palette][0]:c, h=Math.max(1.5,Math.min(4,Math.min(w,d)));
        if(st==='cylinder'){ const m=cyl(Math.min(w,d)/2,Math.min(w,d)/2,h,cc,{roughness:.5},28); m.position.y=h/2; g.add(m); }
        else if(st==='sphere'){ const r=Math.min(w,d)/2; const m=new THREE.Mesh(new THREE.SphereGeometry(r,24,16),mat(cc,{roughness:.35,metalness:.2})); m.position.y=r; m.castShadow=true; g.add(m); }
        else if(st==='cutout'){ const H=6, p=boxMesh(w,H,0.1,cc,{roughness:.6}); p.position.y=H/2; g.add(p);
          const br=boxMesh(0.1,H*0.6,Math.max(1,d),'#7a5a3a',tx('wood',{})); br.position.set(0,H*0.3,-Math.max(1,d)/2); g.add(br); }
        else { const m=boxMesh(w,h,d,cc,tx('wood',{roughness:.7})); m.position.y=h/2; g.add(m);
          const lid=boxMesh(w+0.1,0.1,d+0.1,'#3a2a1a'); lid.position.y=h; g.add(lid); }
        return true; }
      case 'signage': {          // generic sign: roll-up / standee / A-frame / directional post / digital standee / cut-out (no readable text)
        const st=VAR.style||'';
        if(st==='aframe'){ const H=3.2; for(const s of [-1,1]){ const p=boxMesh(w*0.9,H,0.06,'#f4f1ea',tx('fabric',{})); p.position.set(0,H/2,s*0.45); p.rotation.x=s*0.18; g.add(p);
            const b=boxMesh(w*0.7,H*0.3,0.02,c); b.position.set(0,H*0.6,s*0.49); b.rotation.x=s*0.18; g.add(b); } return true; }
        if(st==='direction'){ const pole=cyl(0.08,0.08,7,'#444444',CHROME,8); pole.position.y=3.5; g.add(pole);
          [[6,1],[5,-1],[4,1]].forEach(([y,s])=>{ const a=boxMesh(2.2,0.55,0.08,c,{roughness:.6}); a.position.set(s*1.1,y,0); g.add(a);
            const tip=new THREE.Mesh(new THREE.ConeGeometry(0.3,0.5,3),mat(c)); tip.rotation.z=-s*Math.PI/2; tip.position.set(s*2.45,y,0); g.add(tip); }); return true; }
        const H=st==='cutout'?6:st==='standee'?6:6.6, face=st==='digital'?'#111418':'#f4f1ea';
        const base=boxMesh(w*0.95,0.2,Math.max(0.8,d*0.6),'#2b2b2b',{metalness:.5,roughness:.4}); base.position.y=0.1; g.add(base);
        const p=boxMesh(w*0.9,H,st==='digital'?0.3:0.05,face,st==='digital'?{roughness:.3}:tx('fabric',{})); p.position.y=H/2+0.2; g.add(p);
        if(st==='digital'){ const scr=boxMesh(w*0.8,H*0.85,0.02,'#3b82f6',{emissive:col('#5b8cff'),emissiveIntensity:.7}); scr.position.set(0,H/2+0.2,0.17); g.add(scr); }
        else { const band=boxMesh(w*0.9,H*0.3,0.02,c,{roughness:.7}); band.position.set(0,H*0.65,0.04); g.add(band);
          const lb=boxMesh(w*0.6,H*0.08,0.02,'#2b2b2b'); lb.position.set(0,H*0.3,0.04); g.add(lb); }
        return true; }
      case 'stageroof': {        // ground-support roof: 4 truss towers (~24 ft), a pitched truss grid and a fabric roof skin
        const H=24, steel={metalness:.35,roughness:.5}, T=1.2;
        for(const sx of [-1,1]) for(const sz of [-1,1]){ const tw=boxMesh(T,H,T,'#b8bdc6',steel); tw.position.set(sx*(w/2-T/2),H/2,sz*(d/2-T/2)); g.add(tw);
          const bp=boxMesh(3,0.2,3,'#555555'); bp.position.set(sx*(w/2-T/2),0.1,sz*(d/2-T/2)); g.add(bp); }
        for(const sz of [-1,1]){ const b=boxMesh(w,T,T,'#9aa0aa',steel); b.position.set(0,H,sz*(d/2-T/2)); g.add(b); }
        for(const sx of [-1,1]){ const b=boxMesh(T,T,d,'#9aa0aa',steel); b.position.set(sx*(w/2-T/2),H,0); g.add(b); }
        for(let x=-w/2+w/4;x<w/2-1;x+=w/4){ const b=boxMesh(0.8,0.8,d,'#9aa0aa',steel); b.position.set(x,H,0); g.add(b); }
        const half=d/2+0.5, rise=3, L=Math.hypot(half,rise);   // gable roof skin: ridge along the width, 3 ft rise
        for(const s of [-1,1]){ const p=boxMesh(w+1,0.15,L,'#1c1f26',{roughness:.9}); p.position.set(0,H+0.6+rise/2,s*half/2); p.rotation.x=s*Math.atan2(rise,half); g.add(p); }
        const sides=[]; for(let x=-w/2+2;x<w/2-1;x+=w/6) sides.push([x,H-0.8,d/2-1]); bulbs(g, sides, '#fff3c4', 0.35);
        return true; }
      case 'varmala': {          // round raised varmala platform (1.5 ft) with carpet top, floral edge and two steps
        const R=Math.min(w,d)/2, H=1.5;
        const plat=cyl(R,R,H,'#efe6d6',tx('fabric',{roughness:.85}),40); plat.position.y=H/2; g.add(plat);
        const top=cyl(R*0.96,R*0.96,0.04,(VAR.palette&&FLOWER_TONES[VAR.palette])?FLOWER_TONES[VAR.palette][0]:'#9f1239',tx('carpet',{roughness:.95}),40); top.position.y=H+0.02; g.add(top);
        const an=[]; for(let i=0;i<36;i++){ const a=i/36*Math.PI*2; an.push([Math.cos(a)*R, H-0.1, Math.sin(a)*R]); }
        if(floralOK(it)) blooms(g, an, {rand, pal:pal(c,'blush'), rMin:.16, rMax:.28, per:1, spread:.12, leaves:false});
        for(let i=0;i<2;i++){ const st=boxMesh(R*0.6,H*(2-i)/3,1,'#efe6d6'); st.position.set(0,H*(2-i)/6,R+0.5+i); g.add(st); }
        return true; }
      case 'micstand': {         // round-base microphone stand with a boom and mic (~5 ft)
        const base=cyl(0.45,0.5,0.08,'#1c1c1c',{metalness:.5,roughness:.4},20); base.position.y=0.04; g.add(base);
        const pole=cyl(0.04,0.04,4.6,'#1c1c1c',{metalness:.6,roughness:.35},8); pole.position.y=2.3; g.add(pole);
        rodAB(g,[0,4.6,0],[0,5.0,0.9],0.03,'#1c1c1c',{metalness:.6,roughness:.35});
        const mic=cyl(0.07,0.05,0.4,'#333333',{metalness:.6,roughness:.3},10); mic.position.set(0,5.05,1.05); mic.rotation.x=1.2; g.add(mic);
        const head=new THREE.Mesh(new THREE.SphereGeometry(0.09,10,8),mat('#777777',{metalness:.7,roughness:.4})); head.position.set(0,5.12,1.2); g.add(head);
        return true; }
      case 'teleprompter': {     // confidence monitor: a low wedge with a tilted screen facing the stage
        const body=boxMesh(w,0.9,d*0.8,'#1c1c1c',{roughness:.6}); body.position.y=0.45; g.add(body);
        const scr=boxMesh(w*0.9,0.05,d*0.7,'#3b82f6',{emissive:col('#5b8cff'),emissiveIntensity:.6}); scr.position.set(0,0.95,0); scr.rotation.x=-0.5; g.add(scr);
        return true; }
      case 'projector': {        // fast-fold projection screen (4:3, ~7.5 ft) on legs, black dress kit, projector on a stand in front
        const sw=w*0.92, sh=Math.min(10,sw*0.62), y0=3;
        for(const s of [-1,1]){ const lg=cyl(0.06,0.06,y0+sh,'#2b2b2b',{metalness:.5},8); lg.position.set(s*w/2,(y0+sh)/2,0); g.add(lg);
          const ft=boxMesh(0.2,0.08,Math.max(2,d),'#2b2b2b'); ft.position.set(s*w/2,0.04,0); g.add(ft); }
        const fr=boxMesh(w,sh+0.4,0.08,'#111111'); fr.position.set(0,y0+sh/2,0); g.add(fr);
        const scr=boxMesh(sw,sh,0.04,'#f5f5f5',{emissive:col('#dfe8ff'),emissiveIntensity:.35}); scr.position.set(0,y0+sh/2,0.06); g.add(scr);
        const skirt=drape(w,y0,'#111111',{depth:.08,pitch:.8}); skirt.position.set(0,y0/2,0.02); g.add(skirt);
        return true; }
      case 'tvstand': {          // 65" TV on a floor stand (screen centre ~5 ft)
        const sw=Math.min(w*0.95,5.4), sh=sw*0.5625;
        const base=boxMesh(Math.min(w*0.7,3),0.12,Math.min(d,2),'#1c1c1c',{metalness:.5,roughness:.4}); base.position.y=0.06; g.add(base);
        const pole=boxMesh(0.25,4,0.15,'#2b2b2b',{metalness:.6}); pole.position.y=2; g.add(pole);
        const tv=boxMesh(sw,sh,0.15,'#0b0c10',{roughness:.3}); tv.position.set(0,5,0.1); g.add(tv);
        const scr=boxMesh(sw*0.96,sh*0.94,0.02,'#2f6fed',{emissive:col('#2f6fed'),emissiveIntensity:.45}); scr.position.set(0,5,0.19); g.add(scr);
        return true; }
      case 'interpreter': {      // ISO-style interpreter booth: boxed cabin (7 ft) with a front window and desk
        const H=7, wall=boxMesh(w,H,d,'#d9d6cf',tx('fabric',{roughness:.9})); wall.position.y=H/2; g.add(wall);
        const win=boxMesh(w*0.8,H*0.3,0.05,'#bcd4e6',{transparent:true,opacity:.55,roughness:.05}); win.position.set(0,H*0.55,d/2+0.03); g.add(win);
        const roofv=boxMesh(w*0.3,0.4,0.4,'#555555'); roofv.position.set(0,H+0.2,0); g.add(roofv);
        const door=boxMesh(0.06,H*0.8,d*0.5,'#a8a49b'); door.position.set(w/2+0.03,H*0.4,0); g.add(door);
        return true; }
      case 'pyro': {             // cold-spark / CO2 / confetti machine with its effect plume
        const st=VAR.style||'', R=Math.min(w,d)/2;
        const box=boxMesh(R*1.4,0.9,R*1.4,'#1c1c1c',{metalness:.4,roughness:.5}); box.position.y=0.45; g.add(box);
        if(st==='co2'){ const nz=cyl(0.1,0.14,0.5,'#888888',CHROME,10); nz.position.y=1.15; g.add(nz);
          const jet=new THREE.Mesh(new THREE.ConeGeometry(0.9,8,16,1,true),new THREE.MeshBasicMaterial({color:col('#ffffff'),transparent:true,opacity:.35,side:THREE.DoubleSide})); jet.rotation.x=Math.PI; jet.position.y=5.4; g.add(jet); }
        else if(st==='confetti'){ const tube=cyl(0.25,0.25,1.6,c,{metalness:.5},14); tube.rotation.x=-0.35; tube.position.set(0,1.5,0.2); g.add(tube);
          const P=balloonPal(c), L=[]; for(let i=0;i<60;i++) L.push({x:(rand()-0.5)*3,y:3+rand()*6,z:0.5+rand()*2,sx:0.12,sy:0.02,sz:0.08,rx:rand()*3,ry:rand()*3,c:P[(rand()*P.length)|0]});
          const im=instanced(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.5}), L); if(im) g.add(im); }
        else { const sp=[]; for(let i=0;i<70;i++){ const y=rand()*9, r=0.08+y*0.06; const a=rand()*Math.PI*2; sp.push([Math.cos(a)*r*rand(), 1+y, Math.sin(a)*r*rand()]); } bulbs(g, sp, '#ffd27a', 0.05); }
        return true; }
      case 'towerlight': {       // towable floodlight tower: trailer, mast (~25 ft) and a 4-lamp head
        const tr=boxMesh(w*0.8,1.6,d*0.5,'#f2c200',{roughness:.6}); tr.position.y=1.4; g.add(tr);
        for(const s of [-1,1]){ const wh=cyl(0.6,0.6,0.35,'#1c1c1c',{roughness:.9},16); wh.rotation.x=Math.PI/2; wh.position.set(s*w*0.25,0.6,d*0.26); g.add(wh); }
        const mast=cyl(0.15,0.2,22,'#9aa0aa',CHROME,10); mast.position.y=13; g.add(mast);
        const bar=boxMesh(4,0.2,0.2,'#555555'); bar.position.y=24; g.add(bar);
        const lamps=[]; for(const x of [-1.5,-0.5,0.5,1.5]){ const l=boxMesh(0.8,0.8,0.4,'#2b2b2b'); l.position.set(x,24.5,0.2); g.add(l); lamps.push([x,24.5,0.45]); } bulbs(g, lamps, '#ffffff', 0.3);
        return true; }
      case 'gaddi': {            // floor seating: rug + mattress gaddis with white covers + round bolsters along the edges
        const rug=boxMesh(w,0.05,d,c,tx('carpet',{roughness:.95})); rug.position.y=0.03; g.add(rug);
        const seg=(x,z,lw,ld,ry)=>{ const m=boxMesh(lw,0.5,ld,'#f7f4ee',tx('fabric',{roughness:.9})); m.position.set(x,0.3,z); m.rotation.y=ry||0; g.add(m); };
        seg(0,-d/2+0.9,w-0.4,1.6); seg(-w/2+0.9,0.4,1.6,d-2.2); seg(w/2-0.9,0.4,1.6,d-2.2);
        const bol=[]; for(let x=-w/2+1;x<w/2-0.5;x+=1.4) bol.push({x,y:0.85,z:-d/2+0.25,sx:0.3,sy:0.3,sz:0.6,ry:Math.PI/2,c:'#b91c1c'});
        const im=instanced(new THREE.CylinderGeometry(1,1,2,14).rotateX(Math.PI/2), new THREE.MeshStandardMaterial(tx('fabric',{color:0xffffff,roughness:.85})), bol); if(im) g.add(im);
        return true; }
      case 'urli': {             // wide brass urli bowl on a low stand with floating flowers + candles
        const R=Math.min(w,d)/2;
        g.add(lathe([[0.01,0],[R*0.35,0],[R*0.3,0.4],[R*0.95,0.6],[R,0.95],[R*0.9,0.95],[0.01,0.7]],'#c99a3a',GOLD));
        const wtr=cyl(R*0.88,R*0.88,0.02,'#7fb4d6',{transparent:true,opacity:.7,roughness:.05},32); wtr.position.y=0.86; g.add(wtr);
        const an=[]; for(let i=0;i<10;i++){ const a=rand()*Math.PI*2, r=rand()*R*0.75; an.push([Math.cos(a)*r,0.92,Math.sin(a)*r]); }
        blooms(g, an, {rand, pal:pal(c,'marigold'), rMin:.12, rMax:.2, per:1, spread:.05, leaves:false});
        const cn=[]; for(let i=0;i<5;i++){ const a=i/5*Math.PI*2; cn.push([Math.cos(a)*R*0.5,0.98,Math.sin(a)*R*0.5]); } bulbs(g, cn, '#ffcf7a', 0.06);
        return true; }
      case 'umbrellas': {        // mehendi / haldi umbrella cluster hanging at 8–10 ft from a light frame
        const P=balloonPal(c), n=Math.max(4,Math.min(12,Math.round(w*d/10)));
        for(const sx of [-1,1]) for(const sz of [-1,1]){ const p=cyl(0.05,0.05,10.5,'#d9b45a',GOLD,8); p.position.set(sx*w/2,5.25,sz*d/2); g.add(p); }
        for(let i=0;i<n;i++){ const x=(rand()-0.5)*w*0.85, z=(rand()-0.5)*d*0.85, y=8+rand()*2, r=1.1+rand()*0.6;
          const u=new THREE.Mesh(new THREE.ConeGeometry(r,0.7,10,1,true),mat(P[i%P.length],{side:THREE.DoubleSide,roughness:.8})); u.position.set(x,y,z); u.castShadow=true; g.add(u);
          rodAB(g,[x,y+0.35,z],[x,10.5,z],0.015,'#d9b45a',GOLD); }
        return true; }
      case 'doli': {             // doli / palki: a carved box cabin with a domed roof carried on two long poles
        const L=w, cw=Math.min(3.2,L*0.5), ch=3.4, cd=Math.min(d,2.6), y0=1.8;
        for(const s of [-1,1]){ const pole=cyl(0.1,0.1,L,'#7a4b28',tx('wood',{}),10); pole.rotation.z=Math.PI/2; pole.position.set(0,y0+0.3,s*cd*0.45); g.add(pole); }
        const box=boxMesh(cw,ch,cd,c,{roughness:.6}); box.position.y=y0+ch/2; g.add(box);
        const dome=new THREE.Mesh(new THREE.SphereGeometry(cw*0.55,16,10,0,Math.PI*2,0,Math.PI/2),mat('#d9b45a',GOLD)); dome.scale.set(1,0.7,cd/cw); dome.position.y=y0+ch; g.add(dome);
        const cur=drape(cw*0.8,ch*0.8,'#fdf3e1',{depth:.08,pitch:.4}); cur.position.set(0,y0+ch*0.45,cd/2+0.05); g.add(cur);
        for(const s of [-1,1]) for(const t of [-1,1]){ const st=boxMesh(0.25,y0,0.25,'#7a4b28',tx('wood',{})); st.position.set(s*cw*0.4,y0/2,t*cd*0.4); g.add(st); }
        if(floralOK(it)) ladis(g, [-cw*0.4,-cw*0.2,0,cw*0.2,cw*0.4], cd/2+0.15, y0+ch, 1.4, pal(c,'marigold'), rand);
        return true; }
      case 'kalash': {           // brass kalash with mango leaves and a coconut, on a small rice-filled plate
        const R=Math.min(w,d)/2;
        const plate=cyl(R*0.9,R*0.85,0.08,'#c99a3a',GOLD,24); plate.position.y=0.04; g.add(plate);
        const k=lathe([[0.01,0.08],[R*0.35,0.1],[R*0.6,0.5],[R*0.55,0.9],[R*0.25,1.15],[R*0.32,1.25],[0.01,1.25]],'#c99a3a',GOLD); g.add(k);
        const L=[]; for(let i=0;i<9;i++){ const a=i/9*Math.PI*2; L.push({x:Math.cos(a)*R*0.3,y:1.32,z:Math.sin(a)*R*0.3,sx:0.08,sy:0.02,sz:0.32,ry:-a+Math.PI/2,rx:0.5,c:'#2f6b3a'}); }
        const lf=instanced(new THREE.SphereGeometry(1,8,5), new THREE.MeshStandardMaterial(tx('leaf',{color:0xffffff,roughness:.6})), L); if(lf) g.add(lf);
        const co=new THREE.Mesh(new THREE.SphereGeometry(R*0.28,14,10),mat('#8b5a2b',{roughness:.9})); co.scale.y=1.2; co.position.y=1.5; g.add(co);
        blooms(g, [[R*0.6,0.2,0],[-R*0.6,0.2,0]], {rand, pal:pal(c,'marigold'), rMin:.08, rMax:.12, per:3, spread:.1, leaves:false});
        return true; }
      case 'altar': {            // pooja altar: 2.5 ft draped platform, a stepped back with a canopy frame and lamps
        const H=2.5;
        const plat=boxMesh(w,H,d,'#fdf3e1',tx('fabric',{roughness:.9})); plat.position.y=H/2; g.add(plat);
        const sk=drape(w,H-0.1,c,{depth:.1,pitch:.7}); sk.position.set(0,(H-0.1)/2,d/2+0.1); g.add(sk);
        const step=boxMesh(w*0.6,1,d*0.4,'#b91c1c',tx('fabric',{})); step.position.set(0,H+0.5,-d*0.25); g.add(step);
        const back=boxMesh(w*0.8,4,0.2,'#7f1d1d',tx('fabric',{})); back.position.set(0,H+2,-d/2+0.1); g.add(back);
        const arc=new THREE.Mesh(new THREE.TorusGeometry(w*0.35,0.08,8,32,Math.PI),mat('#d9b45a',GOLD)); arc.position.set(0,H+3.2,-d/2+0.3); g.add(arc);
        for(const s of [-1,1]) for(let y=0;y<3.2;y+=0.6){ const p=cyl(0.06,0.06,0.6,'#d9b45a',GOLD,8); p.position.set(s*w*0.35,H+y+0.3,-d/2+0.3); g.add(p); }
        bulbs(g, [[-w*0.3,H+0.15,d*0.3],[w*0.3,H+0.15,d*0.3],[0,H+1.1,-d*0.1]], '#ffb547', 0.08);
        if(floralOK(it)) ladis(g, [-w*0.3,-w*0.15,0,w*0.15,w*0.3], -d/2+0.4, H+3.9, 1.2, pal(c,'marigold'), rand);
        return true; }
      case 'shoerack': {         // open 3-shelf shoe rack (~3 ft)
        const H=3, steel={metalness:.5,roughness:.4};
        for(const sx of [-1,1]) for(const sz of [-1,1]){ const p=boxMesh(0.08,H,0.08,'#555555',steel); p.position.set(sx*(w/2-0.05),H/2,sz*(d/2-0.05)); g.add(p); }
        for(let i=0;i<3;i++){ const sh=boxMesh(w,0.06,d,'#8b5a2b',tx('wood',{})); sh.position.y=0.3+i*1.1; g.add(sh); }
        const sh=[]; for(let i=0;i<Math.round(w*1.5);i++) sh.push({x:-w/2+0.3+rand()*(w-0.6),y:0.42+((i%3)*1.1),z:(rand()-0.5)*d*0.5,sx:0.18,sy:0.1,sz:0.4,c:['#3a2a1a','#b91c1c','#d9b45a','#1c1c1c'][i%4]});
        const im=instanced(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.7}), sh); if(im) g.add(im);
        return true; }
      case 'dessert': case 'coffee': {   // skirted counter: dessert = tiered stands + jars; coffee = urns + cups
        const H=2.5;
        const cl=boxMesh(w,H,d,'#f7f4ee',tx('fabric',{roughness:.9})); cl.position.y=H/2; g.add(cl);
        const sk=drape(w,H-0.1,it.type==='dessert'?(VAR.palette&&FLOWER_TONES[VAR.palette]?FLOWER_TONES[VAR.palette][0]:c):'#2b2b2b',{depth:.08,pitch:.7}); sk.position.set(0,(H-0.1)/2,d/2+0.08); g.add(sk);
        if(it.type==='dessert'){ const n=Math.max(2,Math.round(w/2.5));
          for(let i=0;i<n;i++){ const x=-w/2+(i+0.5)*w/n;
            for(let k=0;k<3;k++){ const t=cyl(0.6-k*0.15,0.6-k*0.15,0.05,'#ffffff',{roughness:.3},20); t.position.set(x,H+0.25+k*0.45,0); g.add(t); }
            const P=pal(c,'pastel'), L=[]; for(let k=0;k<3;k++) for(let j=0;j<5;j++){ const a=j/5*Math.PI*2, r=0.4-k*0.12; L.push({x:x+Math.cos(a)*r,y:H+0.35+k*0.45,z:Math.sin(a)*r,s:0.09,c:P[(j+k)%P.length]}); }
            const im=instanced(new THREE.SphereGeometry(1,8,6), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.6}), L); if(im) g.add(im); } }
        else { for(const x of [-w*0.3,0,w*0.3]){ const u=cyl(0.35,0.35,1.3,'#c0c4cc',CHROME,16); u.position.set(x,H+0.65,-d*0.15); g.add(u); }
          const L=[]; for(let i=0;i<14;i++) L.push({x:-w/2+0.4+(i%7)*(w-0.8)/6,y:H+0.18,z:d*0.25+(i>6?-0.3:0),s:0.12,c:'#ffffff'});
          const im=instanced(new THREE.CylinderGeometry(1,0.8,2.6,10), new THREE.MeshStandardMaterial({color:0xffffff,roughness:.4}), L); if(im) g.add(im); }
        return true; }
      case 'stall': {            // canopy stall (10×10, 8 ft eave + peak) or a hard-top kiosk; counter at the front
        const st=VAR.style||'', H=8;
        const ctr=boxMesh(w*0.9,3.2,1.6,'#f4f1ea',tx('wood',{roughness:.7})); ctr.position.set(0,1.6,d/2-1); g.add(ctr);
        const band=boxMesh(w*0.9,0.6,0.05,c); band.position.set(0,2.6,d/2-0.18); g.add(band);
        if(st==='kiosk'){ const walls=boxMesh(w,H,0.15,'#e6e1d6'); walls.position.set(0,H/2,-d/2+0.08); g.add(walls);
          for(const s of [-1,1]){ const sd=boxMesh(0.15,H,d,'#e6e1d6'); sd.position.set(s*(w/2-0.08),H/2,0); g.add(sd); }
          const roof=boxMesh(w+0.6,0.4,d+0.6,c); roof.position.y=H+0.2; g.add(roof);
          const hdr=boxMesh(w,1.2,0.1,'#ffffff'); hdr.position.set(0,H-0.6,d/2); g.add(hdr); }
        else { for(const sx of [-1,1]) for(const sz of [-1,1]){ const p=cyl(0.07,0.07,H,'#c0c4cc',CHROME,8); p.position.set(sx*(w/2-0.1),H/2,sz*(d/2-0.1)); g.add(p); }
          const roof=new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w,d)/2,2.5,4,1,true),mat('#ffffff',{side:THREE.DoubleSide,roughness:.85})); roof.rotation.y=Math.PI/4; roof.position.y=H+1.25; g.add(roof);
          const val=boxMesh(w,0.6,0.05,c); val.position.set(0,H-0.3,d/2); g.add(val); }
        return true; }
      case 'counter': case 'kiosk': {   // display counter (3.5 ft, lit glass top) / check-in kiosk (touch screen on a pedestal)
        if(it.type==='kiosk'){ const R=Math.min(w,d)/2; const base=boxMesh(R*1.4,0.15,R*1.2,'#1c1c1c'); base.position.y=0.08; g.add(base);
          const ped=boxMesh(R*0.8,3.6,R*0.5,'#f4f1ea',{roughness:.4}); ped.position.y=1.9; g.add(ped);
          const scr=boxMesh(R*1.1,1.6,0.1,'#0b0c10'); scr.position.set(0,4.2,0.1); scr.rotation.x=-0.25; g.add(scr);
          const gl=boxMesh(R*1.0,1.4,0.02,'#3b82f6',{emissive:col('#5b8cff'),emissiveIntensity:.6}); gl.position.set(0,4.2,0.17); gl.rotation.x=-0.25; g.add(gl);
          const pr=boxMesh(R*0.6,0.25,0.3,'#2b2b2b'); pr.position.set(0,2.6,R*0.3); g.add(pr); return true; }
        const H=3.5, body=boxMesh(w,H-0.3,d,'#f4f1ea',{roughness:.4}); body.position.y=(H-0.3)/2; g.add(body);
        const band=boxMesh(w,0.5,0.03,c); band.position.set(0,H*0.6,d/2+0.02); g.add(band);
        const glass=boxMesh(w,0.3,d,'#cfe8f5',{transparent:true,opacity:.45,roughness:.05}); glass.position.y=H-0.15; g.add(glass);
        bulbs(g, [[-w*0.3,H-0.2,0],[0,H-0.2,0],[w*0.3,H-0.2,0]], '#fff3c4', 0.07);
        return true; }
      case 'plinth': {           // white display plinth (3.5 ft) with an acrylic cover
        const H=3.5, R=Math.min(w,d);
        const p=boxMesh(R,H,R,'#f7f7f5',{roughness:.35}); p.position.y=H/2; g.add(p);
        const cv=boxMesh(R*0.85,1.4,R*0.85,'#ffffff',{transparent:true,opacity:.25,roughness:.05}); cv.position.y=H+0.7; g.add(cv);
        const obj=new THREE.Mesh(new THREE.IcosahedronGeometry(R*0.2,1),mat(c,{metalness:.5,roughness:.3})); obj.position.y=H+0.45; g.add(obj);
        return true; }
      case 'ticketbooth': {      // ticket booth cabin (8 ft) with two service windows and a canopy
        const H=8, cab=boxMesh(w,H,d,'#e9e4d8',tx('wood',{roughness:.7})); cab.position.y=H/2; g.add(cab);
        for(const x of [-w*0.22,w*0.22]){ const win=boxMesh(w*0.32,H*0.3,0.05,'#bcd4e6',{transparent:true,opacity:.6,roughness:.05}); win.position.set(x,H*0.55,d/2+0.03); g.add(win);
          const sill=boxMesh(w*0.34,0.1,0.6,'#8b5a2b'); sill.position.set(x,H*0.4,d/2+0.3); g.add(sill); }
        const can=boxMesh(w+0.8,0.2,2,c); can.position.set(0,H*0.85,d/2+0.9); can.rotation.x=0.2; g.add(can);
        const roof=boxMesh(w+0.4,0.4,d+0.4,'#3a3a3a'); roof.position.y=H+0.2; g.add(roof);
        return true; }
      case 'stanchion': {        // chrome rope-and-post line every ~5 ft with a velvet rope swag
        const n=Math.max(2,Math.round(w/5)+1), xs=[]; for(let i=0;i<n;i++) xs.push(-w/2+i*w/(n-1));
        xs.forEach(x=>{ const b=cyl(0.38,0.42,0.08,'#c0c4cc',CHROME,20); b.position.set(x,0.04,0); g.add(b);
          const p=cyl(0.06,0.06,3,'#c0c4cc',CHROME,10); p.position.set(x,1.5,0); g.add(p);
          const k=new THREE.Mesh(new THREE.SphereGeometry(0.1,10,8),mat('#d9b45a',GOLD)); k.position.set(x,3.05,0); g.add(k); });
        for(let i=0;i<n-1;i++) g.add(swag([xs[i],2.9,0],[xs[i+1],2.9,0],0.7,c==='#ffffff'?'#b91c1c':'#9f1239',0.07,{roughness:.6}));
        return true; }
      case 'watchtower': {       // scaffold watch tower (~16 ft deck) with railings, roof and CCTV cameras
        const H=16, lx=w/2-0.2, lz=d/2-0.2, steel=Object.assign({},CHROME,{roughness:.45});
        for(const [x,z] of [[-lx,-lz],[lx,-lz],[-lx,lz],[lx,lz]]){ const lg=cyl(0.09,0.09,H+4,'#8d939c',steel,8); lg.position.set(x,(H+4)/2,z); g.add(lg); }
        for(let y=3;y<H;y+=4) for(const z of [-lz,lz]) rodAB(g,[-lx,y,z],[lx,y+3.5,z],0.05,'#8d939c',steel);
        const deck=boxMesh(w,0.25,d,'#4a3a2e',tx('wood',{})); deck.position.y=H; g.add(deck);
        for(const z of [-lz,lz]){ const r=cyl(0.05,0.05,w,'#8d939c',steel,6); r.rotation.z=Math.PI/2; r.position.set(0,H+3,z); g.add(r); }
        const roof=boxMesh(w+0.6,0.2,d+0.6,c); roof.position.y=H+4.1; g.add(roof);
        for(const s of [-1,1]){ const cam=boxMesh(0.35,0.3,0.7,'#f4f4f4'); cam.position.set(s*lx,H+4.4,lz); cam.rotation.x=0.3; g.add(cam); }
        return true; }
      case 'extinguisher': {     // fire point: red board with two extinguishers + a sand bucket
        const bd=boxMesh(w,4.5,0.08,'#dc2626',{roughness:.6}); bd.position.set(0,2.25,-d/2+0.05); g.add(bd);
        for(const x of [-w*0.25,w*0.2]){ const e=cyl(0.25,0.25,2,'#b91c1c',{metalness:.3,roughness:.4},16); e.position.set(x,1.05,0); g.add(e);
          const hd=boxMesh(0.2,0.3,0.2,'#1c1c1c'); hd.position.set(x,2.2,0); g.add(hd); }
        const bk=cyl(0.3,0.25,0.6,'#dc2626',{},14); bk.position.set(w*0.4,0.3,d*0.2); g.add(bk);
        return true; }
      case 'ambulance': {        // ambulance in a marked bay: white van body, red stripe, beacon
        const vl=Math.min(w*0.8,20), vw=Math.min(d*0.75,7.5);
        const bay=boxMesh(w,0.02,d,'#3a3f4a',{roughness:.95}); bay.position.y=0.01; g.add(bay);
        const body=boxMesh(vl*0.7,7,vw,'#ffffff',{roughness:.4}); body.position.set(-vl*0.15,4.2,0); g.add(body);
        const cab=boxMesh(vl*0.3,5,vw,'#ffffff',{roughness:.4}); cab.position.set(vl*0.35,3.2,0); g.add(cab);
        const ws=boxMesh(0.05,2,vw*0.9,'#2b3a4a',{roughness:.1}); ws.position.set(vl*0.5+0.03,4.4,0); g.add(ws);
        const st=boxMesh(vl,0.6,vw+0.05,'#dc2626'); st.position.set(0,3.6,0); g.add(st);
        for(const sx of [-0.3,0.35]) for(const s of [-1,1]){ const wh=cyl(1,1,0.6,'#1c1c1c',{roughness:.9},16); wh.rotation.x=Math.PI/2; wh.position.set(sx*vl,1,s*vw/2); g.add(wh); }
        const bc=boxMesh(1.5,0.4,0.6,'#3b82f6',{emissive:col('#3b82f6'),emissiveIntensity:.8}); bc.position.set(vl*0.3,5.9,0); g.add(bc);
        return true; }
      case 'trophytable': {      // skirted display table with a stepped riser and a row of gold cups
        const H=2.5;
        const tcl=boxMesh(w,H,d,'#1d1f26',tx('fabric',{roughness:.9})); tcl.position.y=H/2; g.add(tcl);
        const run=boxMesh(w+0.05,0.03,d*0.4,c,{roughness:.8}); run.position.y=H+0.02; g.add(run);
        const rise=boxMesh(w*0.7,0.5,d*0.35,'#2b2e36',tx('fabric',{})); rise.position.set(0,H+0.25,-d*0.2); g.add(rise);
        const n=Math.max(3,Math.min(9,Math.round(w/1.2)));
        for(let i=0;i<n;i++){ const x=-w/2+0.6+i*(w-1.2)/Math.max(1,n-1), back=i%2===1, sc=back?1.25:0.9;
          const cup=lathe([[0.01,0],[0.22,0],[0.22,0.12],[0.06,0.2],[0.05,0.55],[0.12,0.6],[0.3,0.85],[0.32,1.15],[0.01,1.0]],'#d9b45a',GOLD);
          cup.scale.set(sc,sc,sc); cup.position.set(x, back?H+0.5:H+0.04, back?-d*0.2:d*0.18); g.add(cup); }
        return true; }
    }
    return false;
  }


  /* ---- custom glTF/GLB model loading (Sloyd / Meshy / Tripo / HF exports) ---- */
  function requestBuild(){ if(active && !needsBuild){ needsBuild=true; requestAnimationFrame(()=>{ if(active) build(); }); } }
  function loadModel(url){
    if(modelCache[url]) return;
    modelCache[url]={loading:true};
    if(!gltfLoader) gltfLoader=new THREE.GLTFLoader();
    gltfLoader.load(url, g=>{ modelCache[url]={scene:g.scene}; requestBuild(); toast('3D model loaded'); },
      undefined, ()=>{ modelCache[url]={error:true}; toast('3D model failed to load'); });
  }
  function fitModel(m, it){
    const box=new THREE.Box3().setFromObject(m), size=new THREE.Vector3(), ctr=new THREE.Vector3();
    box.getSize(size); box.getCenter(ctr);
    const s=Math.min(it.width/(size.x||1), it.height/(size.z||1));   // fit footprint, keep aspect
    m.scale.setScalar(s);
    m.position.set(-ctr.x*s, -box.min.y*s, -ctr.z*s);               // centre on origin, base on floor
    m.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=true; } });
  }
  function buildModelGroup(it){
    const g=new THREE.Group(); const url=it.properties.model; const entry=modelCache[url];
    if(entry && entry.scene){ const m=entry.scene.clone(true); fitModel(m, it); g.add(m); }
    else { const ph=boxMesh(it.width,2,it.height,it.color,{transparent:true,opacity:.3}); ph.position.y=1; g.add(ph);
      if(!entry || entry.error===undefined) loadModel(url); }
    return g;
  }

  function buildFurniture(it, chairs){
    if(it.properties && it.properties.model){ return buildModelGroup(it); }   // custom mesh replaces the primitive
    const LINEAR_RUN={fence:1, stagebarrier:1, barricade:1};   // line objects whose rails follow the width
    // r21 political layout: a fence / barrier line drawn top-to-bottom (1 ft wide, 222 ft long) is built along its
    // long side and turned a quarter - it used to come out as a 1 ft stub (the rails only follow the width)
    if(LINEAR_RUN[it.type] && +it.height > +it.width){
      const inner=buildFurniture(Object.assign({}, it, { width: it.height, height: it.width }), chairs);
      if(!inner) return inner;
      const gl=new THREE.Group(); inner.rotation.y=Math.PI/2; gl.add(inner); return gl;
    }
    const g=new THREE.Group();
    if(buildPremium(it, chairs, g)) return g;            // refined / new models (premium kit above)
    const w=it.width, d=it.height, c=it.color;
    switch(it.type){
      case 'podium': {
        const body=new THREE.Mesh(new THREE.CylinderGeometry(w*0.55,w*0.75,3.4,6),mat(c)); body.position.y=1.7; body.castShadow=true; g.add(body);
        const top=boxMesh(w*1.4,0.25,d*1.2,'#2a3346'); top.position.y=3.5; top.rotation.x=-0.18; g.add(top);
        break; }
      case 'press': {
        const plat=boxMesh(w,2,d,'#3a4358'); plat.position.y=1; g.add(plat);
        for(const zx of [-w/2+0.4,w/2-0.4]) for(let x=-w/2+0.4;x<=w/2;x+=Math.max(2,w/6)){
          const post=boxMesh(0.12,2,0.12,c); post.position.set(x,3,zx); g.add(post);
        }
        // cameras
        for(let i=0;i<3;i++){ const cam=boxMesh(1,0.8,1.4,'#20283a'); cam.position.set(-w/3+i*(w/3),2.6,0); g.add(cam);
          const lens=new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.25,0.5,12),mat('#0d1220')); lens.rotation.x=Math.PI/2; lens.position.set(-w/3+i*(w/3),2.6,0.9); g.add(lens); }
        break; }
      case 'dj': {
        const body=boxMesh(w,3,d,'#2a3346'); body.position.y=1.5; g.add(body);
        for(const x of [-w*0.22,w*0.22]){ const deck=new THREE.Mesh(new THREE.CylinderGeometry(w*0.16,w*0.16,0.2,20),mat(c)); deck.position.set(x,3.1,0); g.add(deck); }
        break; }
      case 'barricade': {
        const seg=Math.max(1,Math.round(w/6));
        for(let i=0;i<seg;i++){ const x=-w/2+(i+0.5)*(w/seg);
          const rail=boxMesh(w/seg*0.92,0.5,0.12,c); rail.position.set(x,2.4,0); g.add(rail);
          const rail2=boxMesh(w/seg*0.92,0.5,0.12,c); rail2.position.set(x,1.2,0); g.add(rail2);
          const p1=boxMesh(0.14,3.4,0.3,'#c9ccd6'); p1.position.set(x-w/seg/2,1.7,0); g.add(p1); }
        const pe=boxMesh(0.14,3.4,0.3,'#c9ccd6'); pe.position.set(w/2,1.7,0); g.add(pe);
        break; }
      case 'fence': {
        const posts=Math.max(2,Math.round(w/8));
        for(let i=0;i<=posts;i++){ const x=-w/2+i*(w/posts); const p=boxMesh(0.16,6,0.16,'#9aa3b2'); p.position.set(x,3,0); g.add(p); }
        const mesh=boxMesh(w,5.4,0.05,'#b8c0cf'); mesh.material.transparent=true; mesh.material.opacity=0.28; mesh.position.y=3; g.add(mesh);
        break; }
      case 'booth': {
        const floor=boxMesh(w,0.1,d,'#dfe4ee'); floor.position.y=0.05; g.add(floor);
        for(const [px,pz] of [[-w/2+0.2,-d/2+0.2],[w/2-0.2,-d/2+0.2],[-w/2+0.2,d/2-0.2],[w/2-0.2,d/2-0.2]]){
          const p=boxMesh(0.18,8,0.18,'#9aa3b2'); p.position.set(px,4,pz); g.add(p); }
        const banner=boxMesh(w,1.6,0.2,c); banner.position.set(0,7.4,-d/2+0.2); g.add(banner);
        const counter=boxMesh(w*0.7,3,1.4,c); counter.position.set(0,1.5,d/2-1); g.add(counter);
        break; }
      case 'desk': {
        const counter=boxMesh(w,3,d,c); counter.position.y=1.5; g.add(counter);
        const top=boxMesh(w+0.4,0.2,d+0.4,'#e9edf6'); top.position.y=3.1; g.add(top);
        break; }
      case 'truck': {
        const body=boxMesh(w*0.66,7,d,c); body.position.set(-w*0.15,3.5,0); g.add(body);
        const cab=boxMesh(w*0.3,5,d*0.9,'#3a4358'); cab.position.set(w*0.35,2.5,0); g.add(cab);
        const awn=boxMesh(w*0.66,0.2,d+3,'#e9edf6'); awn.position.set(-w*0.15,6,0); g.add(awn);
        for(const [wx,wz] of [[-w*0.3,-d/2],[-w*0.3,d/2],[w*0.32,-d/2],[w*0.32,d/2]]){
          const wheel=new THREE.Mesh(new THREE.CylinderGeometry(1,1,0.5,16),mat('#1b2233')); wheel.rotation.x=Math.PI/2; wheel.position.set(wx,1,wz); g.add(wheel); }
        break; }
      case 'exit': {
        const ent=/entr/i.test(it.label||'');   // Entrance marker: blue sign; exits stay green
        const sign=boxMesh(w,d*0.7,0.3,ent?'#2563eb':'#18a558',{emissive:col(ent?'#1e40af':'#0d7a3f'),emissiveIntensity:.6}); sign.position.y=6; g.add(sign);
        const post=boxMesh(0.2,6,0.2,'#9aa3b2'); post.position.y=3; g.add(post);
        break; }
      case 'seatblock': case 'chairrow': {
        const rows=Math.max(1,it.properties.rows|0), cols=Math.max(1,it.properties.cols|0);
        const mx=it.width/cols, mz=it.height/rows;
        const bcx=it.x+it.width/2, bcy=it.y+it.height/2, brot=it.rotation||0;
        const cong=congestionOf(it), cc=CONG_COLORS[cong]||it.color;   // amber/red chairs when congested
        for(let r=0;r<rows;r++)for(let ci=0;ci<cols;ci++){
          const [ox,oy]=rotOff(it.x+(ci+0.5)*mx - bcx, it.y+(r+0.5)*mz - bcy, brot);  // rotate grid as a unit
          chairs.push({ x: bcx+ox, y: bcy+oy, rot: brot, color: cc, id: it.id });
        }
        return null;   // no group; chairs handled by instancer
      }
      case 'canopy': {
        const H=9;
        for(const [px,pz] of [[-w/2+1,-d/2+1],[w/2-1,-d/2+1],[-w/2+1,d/2-1],[w/2-1,d/2-1]]){
          const p=boxMesh(0.35,H,0.35,'#e6d6b8'); p.position.set(px,H/2,pz); g.add(p); }
        const roof=new THREE.Mesh(new THREE.ConeGeometry(Math.max(w,d)*0.72,4,4),mat(c,{roughness:.9}));
        roof.position.y=H+1.6; roof.rotation.y=Math.PI/4; roof.castShadow=true; g.add(roof);
        const valance=boxMesh(w,1,d,c,{transparent:true,opacity:.85}); valance.position.y=H-0.4; g.add(valance);
        const platform=boxMesh(w*0.5,0.3,d*0.5,'#d8c39a'); platform.position.y=0.15; g.add(platform);
        break; }
      case 'tent': {
        for(const [px,pz] of [[-w/2+1,-d/2+1],[w/2-1,-d/2+1],[-w/2+1,d/2-1],[w/2-1,d/2-1]]){
          const p=boxMesh(0.3,8,0.3,'#c9ccd6'); p.position.set(px,4,pz); g.add(p); }
        const roof=new THREE.Mesh(new THREE.ConeGeometry(Math.max(w,d)*0.72,6,4),mat(c,{roughness:.95,transparent:true,opacity:.9}));
        roof.position.y=11; roof.rotation.y=Math.PI/4; roof.castShadow=true; g.add(roof);
        break; }
      case 'checkpoint': {
        for(const s of [-1,1]){ const p=boxMesh(0.5,7,d,'#3a4358'); p.position.set(s*(w/2-0.25),3.5,0); g.add(p); }
        const topbar=boxMesh(w,0.6,d,c); topbar.position.y=7; g.add(topbar);
        break; }
      case 'restroom': {
        const cabins=Math.max(2,Math.round(w/4));
        for(let i=0;i<cabins;i++){ const cab=boxMesh(w/cabins*0.9,7.5,d,c); cab.position.set(-w/2+(i+0.5)*(w/cabins),3.75,0); g.add(cab); }
        break; }
      case 'ledscreen': {
        const frame=boxMesh(w,Math.max(8,w*0.4),0.4,'#1b2233'); frame.position.y=Math.max(8,w*0.4)/2+1; g.add(frame);
        const scr=boxMesh(w-1,Math.max(8,w*0.4)-1,0.2,'#2f6fed',{emissive:col('#2f6fed'),emissiveIntensity:.45});
        scr.position.set(0,Math.max(8,w*0.4)/2+1,0.2); g.add(scr);
        for(const sxx of [-1,1]){ const leg=boxMesh(0.6,1,0.6,'#6b7280'); leg.position.set(sxx*(w/2-0.5),0.5,0); g.add(leg); } break; }
      case 'truss': {
        const H=Math.max(14,w*3);
        for(const [px,pz] of [[-w/2+0.5,-d/2+0.5],[w/2-0.5,-d/2+0.5],[-w/2+0.5,d/2-0.5],[w/2-0.5,d/2-0.5]]){
          const leg=boxMesh(0.4,H,0.4,'#8a95ad'); leg.position.set(px,H/2,pz); g.add(leg); }
        for(let y=2;y<H;y+=3){ const b=boxMesh(w,0.25,0.25,'#8a95ad'); b.position.set(0,y,-d/2+0.5); g.add(b);
          const b2=boxMesh(0.25,0.25,d,'#8a95ad'); b2.position.set(-w/2+0.5,y,0); g.add(b2); } break; }
      case 'speaker': {
        const box=boxMesh(w,Math.max(5,w*1.6),d,'#1b2233'); box.position.y=Math.max(5,w*1.6)/2; g.add(box);
        for(const yy of [0.32,0.62]){ const cone=new THREE.Mesh(new THREE.CylinderGeometry(w*0.3,w*0.3,0.3,16),mat('#3a4358'));
          cone.rotation.x=Math.PI/2; cone.position.set(0,Math.max(5,w*1.6)*yy,d/2); g.add(cone); } break; }
      case 'parking': {
        const pad=boxMesh(w,0.06,d,'#3a4358',{transparent:true,opacity:.25}); pad.position.y=0.03; g.add(pad);
        for(let x=-w/2+6;x<w/2;x+=8){ const line=boxMesh(0.2,0.07,d-2,'#c9ccd6'); line.position.set(x,0.05,0); g.add(line); } break; }
      case 'firstaid': {
        const box=boxMesh(w,7,d,'#e9edf6'); box.position.y=3.5; g.add(box);
        const cv=boxMesh(w*0.4,0.3,1,'#e5484d'); cv.position.set(0,5,d/2); g.add(cv);
        const ch=boxMesh(1,0.3,1,'#e5484d'); ch.position.set(0,5,d/2); g.add(ch);
        const cv2=boxMesh(1,3,0.3,'#e5484d'); cv2.position.set(0,5,d/2+0.3); g.add(cv2);
        const ch2=boxMesh(3,1,0.3,'#e5484d'); ch2.position.set(0,5,d/2+0.3); g.add(ch2); break; }
      case 'coatcheck': {
        const counter=boxMesh(w,3.4,d,c); counter.position.y=1.7; g.add(counter);
        const rail=boxMesh(w*0.9,0.15,0.15,'#8a95ad'); rail.position.set(0,4.6,-d/4); g.add(rail); break; }
      case 'sofa': case 'loveseat': case 'armchair': case 'bench': {
        const seatH = it.type==='bench'?1.4:1.5;
        const seat=boxMesh(w,seatH,d,c); seat.position.y=seatH/2+0.3; g.add(seat);
        const legs=boxMesh(w*0.96,0.3,d*0.96,'#5b4636'); legs.position.y=0.15; g.add(legs);
        if(it.type!=='bench'){ const back=boxMesh(w,1.3,0.4,c); back.position.set(0,seatH+0.9,-d/2+0.2); g.add(back);
          for(const sxx of [-1,1]){ const arm=boxMesh(0.4,1,d,c); arm.position.set(sxx*(w/2-0.2),seatH+0.2,0); g.add(arm); } }
        break; }
      case 'coffeetable': {
        const top=boxMesh(w,0.2,d,'#c9a06a'); top.position.y=1.5; g.add(top);
        for(const [px,pz] of [[-w/2+0.4,-d/2+0.4],[w/2-0.4,-d/2+0.4],[-w/2+0.4,d/2-0.4],[w/2-0.4,d/2-0.4]]){
          const leg=boxMesh(0.15,1.5,0.15,'#8a6a44'); leg.position.set(px,0.75,pz); g.add(leg); } break; }
      case 'ottoman': {
        const o=new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w,d)/2,Math.min(w,d)/2,1.4,20),mat(c)); o.position.y=0.7; o.castShadow=true; g.add(o); break; }
      case 'fountain': {
        const rad=Math.min(w,d)/2;
        const basin=new THREE.Mesh(new THREE.CylinderGeometry(rad,rad,1.2,24),mat('#c9ccd6')); basin.position.y=0.6; g.add(basin);
        const water=new THREE.Mesh(new THREE.CylinderGeometry(rad-0.4,rad-0.4,0.2,24),mat('#5b8cff',{metalness:.3,roughness:.15})); water.position.y=1.1; g.add(water);
        const tier=new THREE.Mesh(new THREE.CylinderGeometry(rad*0.4,rad*0.5,0.4,16),mat('#c9ccd6')); tier.position.y=2; g.add(tier);
        const spout=new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.15,2,10),mat('#c9ccd6')); spout.position.y=3; g.add(spout); break; }
      case 'uplight': {
        const base=new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.6,0.5,12),mat('#20283a')); base.position.y=0.25; g.add(base);
        const beam=new THREE.Mesh(new THREE.ConeGeometry(1.6,6,16,1,true),new THREE.MeshBasicMaterial({color:col(c),transparent:true,opacity:.22,side:THREE.DoubleSide}));
        beam.position.y=3.2; g.add(beam); break; }
      case 'heater': {
        const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.2,7,10),mat('#9aa3b2')); pole.position.y=3.5; g.add(pole);
        const base=new THREE.Mesh(new THREE.CylinderGeometry(0.9,1.1,0.4,16),mat('#6b7280')); base.position.y=0.2; g.add(base);
        const top=new THREE.Mesh(new THREE.CylinderGeometry(1.4,0.6,1,16),mat(c,{emissive:col('#ff8a3a'),emissiveIntensity:.4})); top.position.y=7.3; g.add(top); break; }
      case 'easel': {
        const board=boxMesh(w,3,0.2,'#e9edf6'); board.position.set(0,3,0); board.rotation.x=-0.12; g.add(board);
        for(const sxx of [-1,1]){ const leg=boxMesh(0.15,4.5,0.15,'#8a6a44'); leg.position.set(sxx*(w/2-0.3),2.2,0.3); leg.rotation.x=0.12; g.add(leg); }
        const backleg=boxMesh(0.15,4.5,0.15,'#8a6a44'); backleg.position.set(0,2.2,-0.6); backleg.rotation.x=-0.2; g.add(backleg); break; }
      case 'barstool': {
        const H=2.4, r=Math.max(0.5,w*0.45);
        const seat=new THREE.Mesh(new THREE.CylinderGeometry(r,r,0.14,18),mat(c)); seat.position.y=H-0.15; seat.castShadow=true; g.add(seat);
        const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.12,H,10),mat('#455a64',{metalness:.5,roughness:.35})); pole.position.y=H/2; g.add(pole);
        const ring=new THREE.Mesh(new THREE.TorusGeometry(r*0.8,0.04,8,16),mat('#455a64',{metalness:.5})); ring.rotation.x=Math.PI/2; ring.position.y=0.7; g.add(ring);
        break; }
      case 'piano': {
        const bodyH=1.1, topY=2.6;
        const body=boxMesh(w*0.6,bodyH,d,c,{roughness:.25,metalness:.15}); body.position.set(-w*0.05,topY,0); g.add(body);
        const curve=new THREE.Mesh(new THREE.CylinderGeometry(d*0.5,d*0.5,bodyH,24,1,false,0,Math.PI),mat(c,{roughness:.25,metalness:.15}));
        curve.rotation.y=Math.PI/2; curve.position.set(w*0.25,topY,0); curve.castShadow=true; g.add(curve);
        const keys=boxMesh(w*0.5,0.16,0.9,'#f5f5f5'); keys.position.set(-w*0.05,topY-bodyH/2+0.12,d*0.5+0.1); g.add(keys);
        for(const [lx,lz] of [[-w*0.28,-d*0.35],[-w*0.28,d*0.35],[w*0.2,0]]){
          const leg=new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,topY-bodyH/2,8),mat('#20242c')); leg.position.set(lx,(topY-bodyH/2)/2,lz); g.add(leg); }
        const lid=boxMesh(w*0.6,0.08,d*0.9,c,{roughness:.2,metalness:.2}); lid.position.set(-w*0.05,topY+bodyH/2+0.5,-d*0.1); lid.rotation.x=-0.5; g.add(lid);
        break; }
      case 'bleacher': {
        const rows=4, rd=d/rows;
        for(let r=0;r<rows;r++){
          const bench=boxMesh(w,1.0,rd*0.95,c,{roughness:.7}); bench.position.set(0,0.6+r*1.0,-d/2+rd/2+r*rd); g.add(bench);
          const riser=boxMesh(w,r*1.0+0.6,0.12,'#8a94a6',{roughness:.6}); riser.position.set(0,(r*1.0+0.6)/2,-d/2+r*rd); g.add(riser);
        }
        break; }
      case 'linearray': {
        const boxes=6; for(let i=0;i<boxes;i++){ const cab=boxMesh(w,0.9,d*0.9,'#15181f',{roughness:.5}); cab.position.set(0,16-i*1.0,0); cab.rotation.x=0.12+i*0.02; g.add(cab); }
        const rig=new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.08,17,8),mat('#5b6472',{metalness:.6})); rig.position.set(0,8.5,-d*0.4); g.add(rig); break; }
      case 'subwoofer': {
        const cab=boxMesh(w,Math.max(2.4,w),d,'#15181f',{roughness:.5}); cab.position.y=Math.max(2.4,w)/2; g.add(cab);
        const port=new THREE.Mesh(new THREE.CylinderGeometry(w*0.28,w*0.28,0.2,20),mat('#0a0c10')); port.rotation.x=Math.PI/2; port.position.set(0,Math.max(2.4,w)/2,d*0.5); g.add(port); break; }
      case 'monitor': {
        const wedge=new THREE.Mesh(new THREE.BoxGeometry(w,1.2,d),mat('#15181f',{roughness:.5})); wedge.rotation.x=-0.5; wedge.position.y=0.7; wedge.castShadow=true; g.add(wedge); break; }
      case 'foh': {
        const desk=boxMesh(w,0.3,d*0.55,'#20242c'); desk.position.set(0,2.6,d*0.2); desk.rotation.x=-0.25; g.add(desk);
        const stand=boxMesh(w*0.9,2.5,d*0.4,c); stand.position.set(0,1.25,-d*0.1); g.add(stand); break; }
      case 'movinghead': {
        const yoke=boxMesh(0.7,0.9,0.4,'#1b1f27'); yoke.position.y=1.1; g.add(yoke);
        const head=new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.5,0.9,16),mat('#0d1016')); head.rotation.z=Math.PI/2; head.position.y=1.7; g.add(head);
        const beam=new THREE.Mesh(new THREE.CylinderGeometry(0.05,1.4,7,16,1,true),new THREE.MeshBasicMaterial({color:col(c),transparent:true,opacity:0.14,side:2}));
        beam.position.set(0,4.9,1.2); beam.rotation.x=0.25; g.add(beam); break; }
      case 'videowall': {
        const frame=boxMesh(w,Math.max(8,d),0.5,'#0a0c10'); frame.position.y=Math.max(8,d)/2+1; g.add(frame);
        const screen=new THREE.Mesh(new THREE.BoxGeometry(w*0.96,Math.max(8,d)*0.9,0.1),new THREE.MeshStandardMaterial({color:col(c),emissive:col(c),emissiveIntensity:0.5,roughness:.3}));
        screen.position.set(0,Math.max(8,d)/2+1,0.3); g.add(screen);
        for(const sx2 of [-w/2+0.3,w/2-0.3]){ const leg=boxMesh(0.4,Math.max(8,d)/2+1,0.6,'#3a4048'); leg.position.set(sx2,(Math.max(8,d)/2+1)/2,-0.3); g.add(leg);} break; }
      case 'generator': {   // V3: silent-genset container on skids, louvres, exhaust stack + kVA plate
        const p=it.properties||{}, sp=(p.spec&&typeof p.spec==='object')?p.spec:{}, kva=+(p.kva!=null?p.kva:sp.kva);
        const skid=boxMesh(w,0.4,d,'#20242c'); skid.position.y=0.2; g.add(skid);
        const body=boxMesh(w,4.6,d,c,{roughness:.6,metalness:.2}); body.position.y=2.7; g.add(body);
        for(let x=-w/2+1;x<w/2-0.5;x+=0.8){ const lv=boxMesh(0.12,2.4,0.08,'#20242c'); lv.position.set(x,2.9,d/2+0.05); g.add(lv); }
        const exhaust=new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.2,1.8,10),mat('#20242c',{metalness:.5})); exhaust.position.set(w*0.38,5.9,-d*0.25); g.add(exhaust);
        const panel=boxMesh(w*0.3,1.2,0.1,'#20242c'); panel.position.set(-w*0.3,3.4,d/2+0.06); g.add(panel);
        // rating plate (yellow, bigger for bigger sets); the "125 kVA" text itself is the name tag / legend entry
        const plate=boxMesh(Math.min(w*0.35, 1.2+(kva>0?Math.min(kva,500)/250:0)),0.9,0.06,'#f2a900'); plate.position.set(w*0.15,3.6,d/2+0.06); g.add(plate);
        break; }
      case 'lighting': {    // overhead box-truss span on two towers with par cans hanging under it
        const H=16; for(const sxx of [-1,1]){ const tw=boxMesh(1,H,1,'#8a95ad',{metalness:.5}); tw.position.set(sxx*(w/2-0.5),H/2,0); g.add(tw); }
        for(const zz of [-0.4,0.4]) for(const yy of [H-0.2,H+0.6]){ const ch=boxMesh(w,0.15,0.15,'#8a95ad',{metalness:.5}); ch.position.set(0,yy,zz); g.add(ch); }
        for(let x=-w/2+2;x<w/2-1;x+=Math.max(2.5,w/8)){ const par=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.45,0.9,12),mat('#15181f',{metalness:.4}));
          par.position.set(x,H-0.9,0.4); par.rotation.x=0.5; g.add(par);
          const glow=new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.3,0.05,12),mat(c,{emissive:col(c),emissiveIntensity:.8})); glow.position.set(x,H-1.35,0.62); glow.rotation.x=0.5; g.add(glow); }
        break; }
      case 'led': {         // LED wall on a ground-stack frame (16:9 panel)
        const sh=Math.max(6,Math.round(w*9/16)), base=2;
        const frame=boxMesh(w,sh,0.5,'#0a0c10'); frame.position.y=base+sh/2; g.add(frame);
        const scr=new THREE.Mesh(new THREE.BoxGeometry(w*0.96,sh*0.94,0.1),new THREE.MeshStandardMaterial({color:col('#2f6fed'),emissive:col('#2f6fed'),emissiveIntensity:.55,roughness:.3}));
        scr.position.set(0,base+sh/2,0.3); g.add(scr);
        for(const sxx of [-1,1]){ const leg=boxMesh(0.5,base+sh*0.6,0.5,'#3a4048'); leg.position.set(sxx*(w/2-0.6),(base+sh*0.6)/2,-0.5); g.add(leg);
          const foot=boxMesh(0.6,0.2,d+1,'#3a4048'); foot.position.set(sxx*(w/2-0.6),0.1,-0.3); g.add(foot); }
        break; }
      case 'brandwall': {   // printed step-and-repeat backdrop on feet
        const bh=8; const wall=boxMesh(w,bh,0.4,'#f4f1ea'); wall.position.y=bh/2+0.3; g.add(wall);
        const band=boxMesh(w*0.8,1.4,0.1,c); band.position.set(0,bh*0.6,0.25); g.add(band);
        for(let x=-w/2+2;x<w/2-1;x+=4){ const logo=boxMesh(1.4,0.8,0.08,c,{transparent:true,opacity:.6}); logo.position.set(x,bh*0.3,0.25); g.add(logo); }
        for(const sxx of [-1,1]){ const foot=boxMesh(0.4,0.3,d,'#6b7280'); foot.position.set(sxx*(w/2-0.5),0.15,0); g.add(foot); }
        break; }
      case 'chocolatefountain': {   // 3 stacked tiers on a skirted table
        const rad=Math.min(w,d)/2;
        const tb=new THREE.Mesh(new THREE.CylinderGeometry(rad,rad,2.6,24),mat('#f4f1ea')); tb.position.y=1.3; g.add(tb);
        [[0.7,2.8],[0.5,3.6],[0.3,4.3]].forEach(([k,y])=>{ const t=new THREE.Mesh(new THREE.CylinderGeometry(rad*k,rad*k*0.8,0.35,20),mat('#c9ccd6',{metalness:.6,roughness:.3})); t.position.y=y; g.add(t);
          const choc=new THREE.Mesh(new THREE.CylinderGeometry(rad*k*0.95,rad*k*1.05,0.6,20),mat('#5a3420',{roughness:.25})); choc.position.y=y-0.45; g.add(choc); });
        const col2=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,2,10),mat('#c9ccd6',{metalness:.6})); col2.position.y=3.6; g.add(col2);
        break; }
      case 'chariot': {     // open carriage: body, canopy, four spoked wheels
        const body=boxMesh(w*0.6,2,d*0.7,c,{roughness:.4,metalness:.3}); body.position.set(-w*0.05,2.6,0); g.add(body);
        const seat=boxMesh(w*0.25,1.6,d*0.6,'#f4f1ea'); seat.position.set(-w*0.2,4.2,0); g.add(seat);
        const canopy=new THREE.Mesh(new THREE.SphereGeometry(Math.min(w,d)*0.35,16,8,0,Math.PI*2,0,Math.PI/2),mat('#f4f1ea',{transparent:true,opacity:.9})); canopy.position.set(-w*0.1,6.4,0); g.add(canopy);
        for(const xx of [-w*0.28,w*0.18]) for(const zz of [-d/2+0.3,d/2-0.3]){ const wh=new THREE.Mesh(new THREE.TorusGeometry(Math.min(1.6,d*0.28),0.15,8,20),mat('#d9b45a',{metalness:.6,roughness:.3}));
          wh.position.set(xx,Math.min(1.6,d*0.28),zz); g.add(wh); }
        const pole=boxMesh(w*0.35,0.2,0.2,'#d9b45a'); pole.position.set(w*0.32,1.8,0); g.add(pole);
        break; }
      case 'smoke': {       // haze machine with a soft plume
        const box=boxMesh(w*0.8,0.9,d*0.5,'#15181f'); box.position.y=0.45; g.add(box);
        const plume=new THREE.Mesh(new THREE.SphereGeometry(Math.max(w,d)*0.5,12,8),new THREE.MeshBasicMaterial({color:col('#dfe3ea'),transparent:true,opacity:.25}));
        plume.position.set(w*0.4,1.6,0); plume.scale.set(1.6,0.8,1); g.add(plume);
        break; }
      case 'dancers': {     // performer group marker: low-poly figures on a marked zone
        const zone=boxMesh(w,0.06,d,c,{transparent:true,opacity:.35}); zone.position.y=0.03; g.add(zone);
        const nP=Math.max(3,Math.min(8,Math.round(w*d/16)));
        for(let i=0;i<nP;i++){ const x=-w/2+w*(i+0.5)/nP, z=(i%2?-1:1)*d*0.18;
          const bodyM=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.5,3.4,8),mat(c)); bodyM.position.set(x,1.7,z); g.add(bodyM);
          const head=new THREE.Mesh(new THREE.SphereGeometry(0.42,10,8),mat('#e8c9a8')); head.position.set(x,3.85,z); g.add(head); }
        break; }
      case 'walkway': {     // raised ramp / thrust with edge lights
        const rh=2.6; const deck=boxMesh(w,rh,d,'#3a4358'); deck.position.y=rh/2; g.add(deck);
        const top=boxMesh(w,0.12,d,c); top.position.y=rh+0.06; g.add(top);
        for(const sxx of [-1,1]) for(let z=-d/2+1;z<d/2;z+=3){ const led=boxMesh(0.2,0.2,0.6,'#ffffff',{emissive:col('#ffd98a'),emissiveIntensity:.8}); led.position.set(sxx*(w/2-0.15),rh+0.15,z); g.add(led); }
        break; }
      case 'distro': {
        const b=boxMesh(w,2.2,d,'#20242c',{metalness:.3}); b.position.y=1.1; g.add(b);
        for(const yy of [1.4,0.7]) for(const xx of [-w*0.25,0,w*0.25]){ const sock=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,0.1,12),mat(c,{emissive:col(c),emissiveIntensity:.2})); sock.rotation.x=Math.PI/2; sock.position.set(xx,yy,d*0.5); g.add(sock);} break; }
      case 'cableramp': {
        const r=new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.5,w,12,1,false,0,Math.PI),mat('#f2a900',{roughness:.7})); r.rotation.z=Math.PI/2; r.position.y=0.02; g.add(r); break; }
      case 'greenroom': case 'viprisers': {
        const isVip=it.type==='viprisers', bh=isVip?2:8.5;
        const box=boxMesh(w,bh,d,c,{roughness:.7,transparent:isVip,opacity:isVip?0.85:1}); box.position.y=bh/2; g.add(box);
        if(isVip){ const rail=new THREE.Mesh(new THREE.TorusGeometry(1,0.05,6,4),mat('#c9a06a')); } break; }
      case 'stagebarrier': {
        for(let x=-w/2+1;x<w/2;x+=3){ const p=boxMesh(2.6,3,0.5,'#7c8595',{metalness:.5,roughness:.4}); p.position.set(x,1.5,0); g.add(p);
          const foot=boxMesh(0.5,0.2,2.4,'#3a4048'); foot.position.set(x,0.1,d*0.6); g.add(foot);} break; }
      default: { const b=boxMesh(w,2.5,d,c); b.position.y=1.25; g.add(b); }
    }
    return g;
  }

  /* ---------------- label sprites ----------------
     A Map (a plain {} would resolve a "__proto__"/"constructor" label to Object.prototype),
     capped: once it outgrows LABEL_CACHE_MAX distinct labels it is flushed at the next scene
     rebuild — after clearRoot(), when no sprite clone references the cached textures any more. */
  const labelCache=new Map(), LABEL_CACHE_MAX=200;
  function flushLabelCache(){
    labelCache.forEach(spr=>{ const m=spr.material; if(m){ if(m.map) m.map.dispose(); m.dispose(); } });
    labelCache.clear();
  }
  function label(text){
    text=String(text==null?'':text).slice(0,22);
    if(labelCache.has(text)) return labelCache.get(text).clone();
    const cvs=document.createElement('canvas'); const s=2; cvs.width=256*s; cvs.height=64*s; cvs.__text=text;   // R4: capture dedupes identical labels
    const ctx=cvs.getContext('2d'); ctx.scale(s,s);
    ctx.fillStyle='rgba(20,27,46,.82)'; roundRect(ctx,0,14,256,36,8); ctx.fill();
    ctx.font='600 22px "IBM Plex Sans",sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text,128,33);
    const tex=new THREE.CanvasTexture(cvs); tex.anisotropy=4;
    const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true}));
    spr.scale.set(10,2.5,1); labelCache.set(text,spr); return spr.clone();
  }
  /* live label mode (Labels: None | Numbers | Names), remembered per browser. Name sprites are always
     built (the client capture projects them); Numbers adds badge sprites + a floating legend card. */
  let liveLabels='names';
  try{ const v=localStorage.getItem('bps.labels3d'); if(v==='none'||v==='numbers'||v==='names') liveLabels=v; }catch(_){}
  const badgeCache=new Map();
  function badgeSprite(n){
    if(badgeCache.has(n)) return badgeCache.get(n).clone();
    const cvs=document.createElement('canvas'); cvs.width=cvs.height=128;
    const ctx=cvs.getContext('2d'); window.HelmCaptureFrame.drawBadge(ctx,64,64,54,n);
    const tex=new THREE.CanvasTexture(cvs); tex.anisotropy=4;
    const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true}));
    spr.scale.set(3,3,1); spr.userData.badge=true; badgeCache.set(n,spr); return spr.clone();
  }
  function flushBadgeCache(){ badgeCache.forEach(spr=>{ const m=spr.material; if(m){ if(m.map) m.map.dispose(); m.dispose(); } }); badgeCache.clear(); }
  function renderLegendCard(legend){
    const card=document.getElementById('legend3d'); if(!card) return;
    const show=active && liveLabels==='numbers' && legend && legend.length>0;
    card.hidden=!show; if(!show) return;
    card.replaceChildren();
    const h=document.createElement('div'); h.className='lg-title'; h.textContent='Legend'; card.appendChild(h);
    const ol=document.createElement('ol'); ol.className='lg-list';
    legend.forEach(L=>{ const li=document.createElement('li'); const b=document.createElement('span'); b.className='lg-n'; b.textContent=String(L.n);
      const t=document.createElement('span'); t.className='lg-t'; t.textContent=L.name+(L.count>1?' ×'+L.count:''); li.append(b,t); ol.appendChild(li); });
    card.appendChild(ol);
  }
  /* walkthrough: temporarily hide name tags + badges at eye level without touching the saved mode */
  let labelsHidden=false, labelFocus=null;   // R49: at a walkaround stop only the subject's own name tags show
  const tagVisible=id=>(!labelsHidden && liveLabels==='names') || !!(labelFocus && labelFocus.has(id));
  function setLabelFocus(ids){ labelFocus = ids && ids.length ? new Set(ids) : null; setLabelsHidden(labelsHidden); }
  function setLabelsHidden(h){
    labelsHidden=!!h; if(!scene) return;
    scene.traverse(o=>{ if(o.userData && o.userData.nameTag) o.visible=tagVisible(o.userData.itemId);
      else if(o.userData && o.userData.badge && o.userData.itemId!=null) o.visible=!labelsHidden; });
  }
  function setLiveLabels(m){
    liveLabels=window.HelmCaptureFrame.labelMode(m);
    try{ localStorage.setItem('bps.labels3d',liveLabels); }catch(_){}
    document.querySelectorAll('#labels3d [data-l]').forEach(b=>{ const on=b.dataset.l===liveLabels; b.classList.toggle('on',on); b.setAttribute('aria-pressed',on?'true':'false'); });
    if(active) requestBuild(); else renderLegendCard(null);
  }
  function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }

  /* ---------------- scene assembly ---------------- */
  function initScene(){
    R=new THREE.WebGLRenderer({canvas:cv,antialias:true,alpha:true});   // r163+: WebGL 2 only (throws without it -> activate() falls back to 2D)
    R.setPixelRatio(Math.min(devicePixelRatio,2)); R.shadowMap.enabled=true; R.shadowMap.type=THREE.PCFShadowMap;   // PCFSoftShadowMap was removed in r180
    R.outputColorSpace=THREE.LinearSRGBColorSpace;   // r128 live view = LinearEncoding output (re-set by applyProfile)
    scene=new THREE.Scene();
    camera=new THREE.PerspectiveCamera(48,1,0.5,3000);
    camera.position.set(0,140,180);
    controls=new THREE.OrbitControls(camera,cv);
    controls.enableDamping=true; controls.dampingFactor=0.08; controls.maxPolarAngle=Math.PI/2-0.03;
    controls.minDistance=20; controls.maxDistance=700; controls.target.set(0,0,0);
    // zoom is ours (r128 OrbitControls dollies a fixed 5% per wheel EVENT: a trackpad pinch fires dozens
    // of events -> far too sensitive, mouse notches jump, no zoom-to-cursor, and it is not damped)
    controls.enableZoom=false;
    cv.addEventListener('wheel', onWheel3D, {passive:false});
    syncZoomLimits();

    hemi=new THREE.HemisphereLight(0xffffff,0x9fb0c8,0.75*LI()); scene.add(hemi);
    sun=new THREE.DirectionalLight(0xffffff,0.85*LI()); sun.position.set(70,160,60); sun.castShadow=true;
    sun.shadow.mapSize.set(2048,2048); sun.shadow.camera.near=1; sun.shadow.camera.far=600;
    scene.add(sun);
    syncFloor();

    root=new THREE.Group(); scene.add(root);

    // ---- TransformControls: drag / rotate / scale the selected object in 3D ----
    gizmo=new THREE.Object3D(); scene.add(gizmo);
    transform=new THREE.TransformControls(camera, cv); transform.setSize(1.1);
    const transformHelper=transform.getHelper();   // r169+: TransformControls is no longer an Object3D - its gizmo is the helper (traverse/add/visible go through this)
    // R62: the handles are drawn LAST (after the name tags / badges, which are depth-test-free sprites too) - the
    // tags used to paint over a small gizmo sitting at the item's base, so Move / Rotate / Scale looked dead
    transformHelper.traverse(o=>{ o.renderOrder=999; });
    transform.addEventListener('dragging-changed', e=>{ controls.enabled=!e.value;
      if(e.value){ const it=curItem(); gizmoBase = it?{x:it.x,y:it.y,width:it.width,height:it.height,cx:it.x+it.width/2,cy:it.y+it.height/2}:null; }
      else { gizmoBase=null; if(store.selectedId){ commit(); } renderAll(); } });
    transform.addEventListener('objectChange', onGizmoChange);
    setTMode(tmode); syncGizmoSnap();
    scene.add(transformHelper);

    // select on a click, not when the drag was really an orbit
    let down=null;
    cv.addEventListener('pointerdown',e=>{ down={x:e.clientX,y:e.clientY}; });
    cv.addEventListener('pointerup',e=>{ if(down && !transform.dragging && Math.hypot(e.clientX-down.x,e.clientY-down.y)<5) doPick(e); down=null; });
    cv.addEventListener('webglcontextlost',e=>{ e.preventDefault(); });          // allow the browser to restore it
    cv.addEventListener('webglcontextrestored',()=>{ try{ needsBuild=true; if(active) build(); }catch(_){} });
    built=true;
  }
  // (Re)build the ground plane, grid, floor border and shadow frustum for the CURRENT hall size.
  // They used to be built once at W×H (boot size) and went stale after a custom hall / opened layout.
  function disposeObj(o){ if(!o) return; scene.remove(o); if(o.geometry) o.geometry.dispose();
    const m=o.material; if(m){ Array.isArray(m) ? m.forEach(x=>x&&x.dispose&&x.dispose()) : (m.dispose&&m.dispose()); } }
  function syncFloor(){
    if(!scene || (floorW===WORLD.w && floorH===WORLD.h && floorCell===cellFt() && ground)) return;
    floorCell=cellFt();
    floorW=WORLD.w; floorH=WORLD.h;
    disposeObj(ground); disposeObj(grid); disposeObj(edge);
    ground=new THREE.Mesh(new THREE.PlaneGeometry(floorW+40,floorH+40),
      new THREE.MeshStandardMaterial({color:col(themeVar('--canvas','#f4f7fd')),roughness:1}));
    ground.rotation.x=-Math.PI/2; ground.position.y=-0.02; ground.receiveShadow=true; scene.add(ground);
    const gs=Math.max(floorW,floorH)+40;
    // snap/grid root cause: GridHelper(gs, gs) is centred on the hall, so with an ODD hall side its lines fell
    // half a cell off the 2D grid (and it was always 1 ft, even in metres). gridAlign picks an even cell count
    // in the active unit and shifts the helper so every line sits on the 2D grid.
    const ga=window.HelmBuilderTools ? HelmBuilderTools.gridAlign(floorW,floorH,cellFt()) : { size:gs, divisions:Math.min(gs,1200), offX:0, offZ:0 };
    grid=new THREE.GridHelper(ga.size, ga.divisions, col(themeVar('--grid-strong','#9fb4d8')), col(themeVar('--grid','#c3d1ea')));
    grid.position.set(ga.offX,0,ga.offZ);
    grid.material.opacity=0.5; grid.material.transparent=true; grid.visible=store.grid.show!==false; scene.add(grid);
    edge=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(floorW,0.1,floorH)),
      new THREE.LineBasicMaterial({color:col(themeVar('--grid-strong','#9fb4d8'))})); edge.position.y=0.05; scene.add(edge);
    if(sun){ const sc=sun.shadow.camera, hw=floorW, hh=floorH;   // same generous frustum as before (±W, ±H), now live
      sc.left=-hw; sc.right=hw; sc.top=hh; sc.bottom=-hh; sc.far=Math.max(600, Math.max(floorW,floorH)*3); sc.updateProjectionMatrix(); }
    if(camera){ camera.far=Math.max(3000, Math.max(floorW,floorH)*5); camera.updateProjectionMatrix(); }   // R49: huge halls never clip
    if(camera && controls) syncZoomLimits();
    if(R) applyProfile();                           // re-apply Render-mode material tweaks to the new ground
  }
  const curItem=()=> store.items.find(i=>i.id===store.selectedId)||null;
  function setTMode(m){ tmode=m; if(!transform) return;
    transform.setMode(m==='scale'?'scale':m==='rotate'?'rotate':'translate');
    // constrain to the floor plane: no vertical translate, yaw-only rotate, planar scale
    if(m==='rotate'){ transform.showX=false; transform.showY=true; transform.showZ=false; }
    else { transform.showX=true; transform.showY=false; transform.showZ=true; }
    document.querySelectorAll('#tools3d [data-m]').forEach(b=>{ const on=b.dataset.m===m; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on?'true':'false'); });
  }
  function syncGizmoSnap(){ if(!transform) return;
    transform.translationSnap = null;   // the item's TOP-LEFT is snapped in onGizmoChange (centre snapping put odd-sized items / odd halls off-grid)
    transform.rotationSnap = store.grid.snap ? THREE.MathUtils.degToRad(15) : null;
  }
  function updateGizmo(){
    if(!transform) return; const it=curItem();
    if(!it || !active || walkKeep || (typeof RO!=='undefined' && RO)){ transform.detach(); return; }   // R62: view-only roles get no edit handles
    gizmo.position.set(sx(it.x+it.width/2),0,sz(it.y+it.height/2));
    gizmo.rotation.set(0,-(it.rotation||0)*Math.PI/180,0); gizmo.scale.set(1,1,1);
    if(transform.object!==gizmo) transform.attach(gizmo);
  }
  function onGizmoChange(){
    markShadows();
    const it=curItem(); if(!it || !gizmoBase) return;
    if(tmode==='translate'){
      const cxft=gizmo.position.x+WORLD.w/2, cyft=gizmo.position.z+WORLD.h/2;   // live WORLD (the hall can be resized after boot)
      it.x=clamp(snapFt(cxft-it.width/2),0,WORLD.w-it.width); it.y=clamp(snapFt(cyft-it.height/2),0,WORLD.h-it.height);
    } else if(tmode==='rotate'){
      let deg=-gizmo.rotation.y*180/Math.PI; it.rotation=((Math.round(deg)%360)+360)%360;
    } else if(tmode==='scale'){
      const nw=clamp(gizmoBase.width*gizmo.scale.x,0.5,WORLD.w), nh=clamp(gizmoBase.height*gizmo.scale.z,0.5,WORLD.h);
      it.width=nw; it.height=nh; if(it.type==='table'||it.type==='cocktail'){ const d=Math.max(nw,nh); it.width=it.height=d; }
      it.x=clamp(gizmoBase.cx-it.width/2,0,WORLD.w-it.width); it.y=clamp(gizmoBase.cy-it.height/2,0,WORLD.h-it.height);
    }
    requestBuild(); if(typeof syncInspectorLive==='function') syncInspectorLive(it);
  }

  function clearRoot(){ if(!root) return; while(root.children.length){ const c=root.children.pop();
    c.traverse&&c.traverse(o=>{
      if(o.isSprite) return;                       // labels share cached geometry+material — never dispose
      if(o.geometry&&o.geometry.dispose) o.geometry.dispose();
      const m=o.material;
      if(m){ Array.isArray(m) ? m.forEach(x=>x&&x.dispose&&x.dispose()) : (m.dispose&&m.dispose()); }
    }); } }

  function build(){
    if(!built) initScene();
    markShadows();
    clearRoot(); chairMap=[]; groupById=new Map(); boundsCache=new Map();
    syncFloor();
    if(labelCache.size>LABEL_CACHE_MAX){ flushLabelCache(); flushBadgeCache(); }   // no clones are in the scene right now
    const num=window.HelmCaptureFrame.numberItems(store.items);
    const chairs=[];
    chairs.push=function(){ if(this.length>=MAX_CHAIRS_3D) return this.length; return Array.prototype.push.apply(this,arguments); };   // never build more than we can draw
    for(const it of store.items){
      const g=buildFurniture(it, chairs);
      if(g){ g.position.set(sx(it.x+it.width/2),0,sz(it.y+it.height/2)); g.rotation.y=-(it.rotation||0)*Math.PI/180;
        g.userData.itemId=it.id; root.add(g); groupById.set(it.id,g); if(roofsHidden && ROOF_T[it.type]) g.visible=false;
        if(['seatblock','chairrow'].indexOf(it.type)===-1){ const lp=label(window.HelmCaptureFrame&&HelmCaptureFrame.displayName?HelmCaptureFrame.displayName(it):it.label);
          lp.position.set(sx(it.x+it.width/2), objTopY(it)+3, sz(it.y+it.height/2)); lp.userData.itemId=it.id; lp.userData.nameTag=true; lp.visible=tagVisible(it.id); root.add(lp);
          const n=liveLabels==='numbers' ? num.byId.get(it.id) : null;
          if(n){ const bp=badgeSprite(n); bp.position.copy(lp.position); bp.userData.itemId=it.id; bp.visible=!labelsHidden; root.add(bp); } } }
    }
    renderLegendCard(liveLabels==='numbers' ? num.legend : null);
    buildChairs(chairs);
    if(!transform || !transform.dragging){ syncGizmoSnap(); updateGizmo(); }
    needsBuild=false;
  }
  // R49: one height table for the 3D build, the walkaround solids and the capture host (public/capture-frame.js ITEM_TOP)
  function objTopY(it){ return window.HelmCaptureFrame.itemTop(it); }

  function buildChairs(chairs){
    if(chairMesh){ root.remove(chairMesh); chairMesh.geometry.dispose(); chairMesh.material.dispose(); chairMesh=null; }
    const n=Math.min(chairs.length, MAX_CHAIRS_3D);
    if(!n) return;
    const geo=chairGeometry();
    chairMesh=new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({roughness:.7,metalness:.05,vertexColors:false}), n);
    chairMesh.castShadow=true; chairMesh.receiveShadow=true;
    const m=new THREE.Matrix4(), q=new THREE.Quaternion(), pos=new THREE.Vector3(), scl=new THREE.Vector3(1,1,1), e=new THREE.Euler();
    chairMap=new Array(n);
    for(let i=0;i<n;i++){ const c=chairs[i];
      e.set(0,-(c.rot||0)*Math.PI/180,0); q.setFromEuler(e);
      pos.set(sx(c.x),0,sz(c.y)); m.compose(pos,q,scl); chairMesh.setMatrixAt(i,m);
      chairMesh.setColorAt(i, col(c.color)); chairMap[i]=c.id;
    }
    chairMesh.instanceMatrix.needsUpdate=true; if(chairMesh.instanceColor) chairMesh.instanceColor.needsUpdate=true;
    root.add(chairMesh);
  }

  /* ---------------- selection ---------------- */
  let ray, ndc;   // created lazily once THREE is loaded (module parses before the 3D libs)
  function doPick(e){
    if(walkKeep) return;                           // R49: the walkaround is look-only: no click-select / move handles
    if(!ray){ ray=new THREE.Raycaster(); ndc=new THREE.Vector2(); }
    const r=cv.getBoundingClientRect(); ndc.x=((e.clientX-r.left)/r.width)*2-1; ndc.y=-((e.clientY-r.top)/r.height)*2+1;
    ray.setFromCamera(ndc,camera);
    const hits=ray.intersectObjects(root.children,true);
    for(const h of hits){
      if(h.object===chairMesh && h.instanceId!=null){ selectId(chairMap[h.instanceId]); return; }
      let o=h.object; while(o&&o.userData.itemId==null) o=o.parent;
      if(o&&o.userData.itemId!=null){ selectId(o.userData.itemId); return; }
    }
  }
  function selectId(id){ if(store.selectedId===id && store.selectedIds.length===1) return; setSelection([id]); renderAll(); /* refreshes inspector + 3D */ }

  /* ---------------- loop / resize / activation ---------------- */
  function resize(){ if(!R) return; const w=stage.clientWidth,h=stage.clientHeight; R.setSize(w,h,false); camera.aspect=w/Math.max(1,h); camera.updateProjectionMatrix(); }
  // perf (2026-10d): the sun is fixed in the world, so orbiting / zooming never changes a shadow. The live loop
  // re-renders the shadow map only for a few frames after the scene, lights or a dragged object changed
  // (shadowDirty) instead of every frame — halves the draw calls on big layouts. Every other render (captures,
  // exports) runs with autoUpdate on, exactly as before.
  function loop(){ if(!active) return; raf=requestAnimationFrame(loop);   // schedule first: a throwing frame (lost context) must not kill the loop
    try{ stepZoom(); controls.update(); walkGuardStep(); refreshSel();
      R.shadowMap.autoUpdate=false; if(shadowDirty>0 || (transform && transform.dragging)){ R.shadowMap.needsUpdate=true; if(shadowDirty>0) shadowDirty--; }
      R.render(scene,camera); }catch(e){ /* skip this frame */ }
    finally{ if(R) R.shadowMap.autoUpdate=true; } }
  let selHelper=null, selKey='';
  function refreshSel(){
    const it=store.items.find(i=>i.id===store.selectedId);
    const key = it ? it.id+':'+it.x+':'+it.y+':'+it.width+':'+it.height+':'+it.rotation+':'+it.type : '';
    if(key===selKey) return;                 // only rebuild when the selection/geometry/rotation changed
    selKey=key;
    if(selHelper){ scene.remove(selHelper); selHelper.geometry.dispose(); selHelper.material&&selHelper.material.dispose(); selHelper=null; }
    if(!it) return;
    const isSeat=['seatblock','chairrow'].indexOf(it.type)>-1;
    const hy=objTopY(it)+(isSeat?2:1);
    // rotated wireframe box that hugs the object (matches the 2D selection outline for rotated items)
    const bg=new THREE.BoxGeometry(it.width+0.8, hy, it.height+0.8);
    selHelper=new THREE.LineSegments(new THREE.EdgesGeometry(bg),
      new THREE.LineBasicMaterial({color:col(themeVar('--accent','#2f6fed'))}));
    bg.dispose();
    selHelper.position.set(sx(it.x+it.width/2), hy/2, sz(it.y+it.height/2));
    selHelper.rotation.y=-(it.rotation||0)*Math.PI/180;
    scene.add(selHelper);
  }

  /* ---- ✦ Render profile: image-based lighting + tone mapping for a realistic look ---- */
  function buildEnvTexture(){                       // a soft studio "room" captured as an env map (no external asset)
    const pmrem=new THREE.PMREMGenerator(R);
    const s=new THREE.Scene();
    const face=(hex,inten)=> new THREE.MeshBasicMaterial({color:new THREE.Color(hex).multiplyScalar(inten), side:THREE.BackSide});
    // inverted room: +x,-x,+y(warm bright ceiling),-y(dark floor),+z,-z
    const room=new THREE.Mesh(new THREE.BoxGeometry(30,16,30),
      [face('#fff3e2',1.3),face('#eaf1ff',1.1),face('#ffffff',2.6),face('#2a2622',0.5),face('#fff3e2',1.3),face('#eaf1ff',1.1)]);
    s.add(room);
    const key=new THREE.Mesh(new THREE.PlaneGeometry(10,10), new THREE.MeshBasicMaterial({color:new THREE.Color('#fff2dc').multiplyScalar(3.2)}));
    key.position.set(6,6,4); key.lookAt(0,0,0); s.add(key);
    const tex=pmrem.fromScene(s,0.35).texture;
    pmrem.dispose(); room.geometry.dispose(); key.geometry.dispose();
    return tex;
  }
  function applyProfile(){
    markShadows();
    if(!R||!scene) return;
    if(renderMode){
      try{ if(!envTex) envTex=buildEnvTexture(); scene.environment=envTex; }catch(e){ scene.environment=null; }
      R.toneMapping=THREE.ACESFilmicToneMapping; R.toneMappingExposure=1.05; R.outputColorSpace=THREE.SRGBColorSpace;
      scene.background=new THREE.Color(themeVar('--panel-2','#f2efe9'));
      scene.fog=new THREE.Fog(new THREE.Color(themeVar('--panel-2','#f2efe9')), 300, 760);
      if(ground){ ground.material.roughness=0.5; ground.material.metalness=0.15; ground.material.envMapIntensity=0.6; ground.material.needsUpdate=true; }
    } else {
      scene.environment=null; scene.background=null; scene.fog=null;
      R.toneMapping=THREE.NoToneMapping; R.outputColorSpace=THREE.LinearSRGBColorSpace;
      if(ground){ ground.material.roughness=1; ground.material.metalness=0; ground.material.needsUpdate=true; }
    }
  }
  async function activate(render){
    if(!libsReady){ toast('Loading 3D…'); const ok=await ensure3DLibs();
      if(!ok){ BPUI.toast('The 3D view couldn’t load (the 3D library is unreachable). Check your connection and try again — the 2D plan still works.',{type:'err'});
        const seg=document.getElementById('viewSeg');
        seg.querySelector('[data-v="2d"]').classList.add('on'); seg.querySelector('[data-v="'+(render?'render':'3d')+'"]').classList.remove('on'); return; } }
    renderMode=!!render;
    active=true; viewport.classList.add('is3d'); viewport.classList.toggle('isRender',renderMode); stage.hidden=false;
    try{ if(!built) initScene(); applyProfile(); build(); resize(); }
    catch(e){
      try{ if(R && !built){ R.dispose(); R=null; } }catch(_){}
      deactivate();
      const sg=document.getElementById('viewSeg');
      if(sg){ sg.querySelectorAll('button').forEach(x=>x.classList.remove('on')); const b2=sg.querySelector('[data-v="2d"]'); if(b2) b2.classList.add('on'); }
      BPUI.toast('3D view isn’t supported on this device — the 2D plan still works.',{type:'err'});
      return;
    }
    if(!raf) loop();
    if(renderMode) toast('Realistic render — image-based lighting on');
  }
  function deactivate(){ active=false; renderLegendCard(null); renderMode=false; viewport.classList.remove('is3d','isRender'); stage.hidden=true; if(transform) transform.detach(); if(raf){ cancelAnimationFrame(raf); raf=null; } }

  /* R2: "Update client images" - a clean three-quarter render of the venue for the client booklet.
     Offscreen-sized (maxW px wide, 16:9), realistic profile, no grid / gizmo / selection box;
     every touched piece of state (size, camera, profile, helpers) is restored afterwards. */
  async function capture3D(maxW, opts){
    const CF=window.HelmCaptureFrame, mode=CF.labelMode(opts && opts.labels);
    maxW=Math.max(640, Math.min(2400, Number(maxW)||1920));
    if(!libsReady){ const ok=await ensure3DLibs(); if(!ok) throw new Error('The 3D library couldn’t load'); }
    if(!built) initScene();
    syncFloor(); build();
    const W=maxW, H=Math.round(maxW*9/16), SS=2;           // render at 2x, downscale (anti-aliasing)
    const RW=mode==='numbers' ? CF.legendSplit(W).renderW : W;   // R5: numbers = 3D render on the left, legend panel on the right
    const sc=sun.shadow.camera;
    const keep={ pr:R.getPixelRatio(), size:R.getSize(new THREE.Vector2()), cam:camera.position.clone(), tgt:controls.target.clone(),
      aspect:camera.aspect, far:camera.far, render:renderMode, grid:grid?grid.visible:null, edge:edge?edge.visible:null, tr:transform?transform.getHelper().visible:null,
      sel:selHelper?selHelper.visible:null, sunI:sun.intensity, sunPos:sun.position.clone(), sunTgt:sun.target.position.clone(), sunR:sun.shadow.radius,
      sc:[sc.left,sc.right,sc.top,sc.bottom,sc.far], hemiI:hemi?hemi.intensity:null, groundCol:ground?ground.material.color.clone():null, labels:[] };
    try{
      if(grid) grid.visible=false; if(edge) edge.visible=false; if(transform){ transform.detach(); transform.getHelper().visible=false; } if(selHelper) selHelper.visible=false;
      // client look = the live interactive 3D view: same profile (NoToneMapping, linear output, no IBL,
      // same hemi 0.75 + sun 0.85, untouched material/floor colours); only the backdrop is a soft neutral
      renderMode=false; applyProfile();
      scene.background=new THREE.Color('#e9ecf2');
      // frame the union of the objects' box and the whole hall floor rectangle (so its edges are visible),
      // filled to ~88%; the ground plane is trimmed to the hall (+1ft) so the #e9ecf2 backdrop surrounds it
      const box=new THREE.Box3();
      root.traverse(o=>{ if((o.isMesh || o.isInstancedMesh) && !o.isSprite){ o.updateWorldMatrix(true,false); box.expandByObject(o); } });
      const fw=floorW||WORLD.w, fh=floorH||WORLD.h, FM=1;
      const pad=1; if(!box.isEmpty()){ box.min.x-=pad; box.min.z-=pad; box.max.x+=pad; box.max.z+=pad; }
      const ub=window.HelmCaptureFrame.unionFloor(box.isEmpty()?null:{min:box.min.toArray(),max:box.max.toArray()}, fw, fh, FM);
      if(box.isEmpty()) ub.max[1]=4;
      box.min.fromArray(ub.min); box.max.fromArray(ub.max);
      if(ground){ keep.groundScale=ground.scale.clone(); ground.scale.set((fw+2*FM)/(fw+40),(fh+2*FM)/(fh+40),1); }
      // 0095 photo render: opts.view {pos,target,fov} = an exact camera (current view / walkthrough stop);
      // opts.topDown = straight-down framing of the whole venue; default = the client 3/4 overview
      const OV=opts && opts.view && Array.isArray(opts.view.pos) && Array.isArray(opts.view.target) ? opts.view : null;
      const fr=OV ? {position:OV.pos.slice(0,3), target:OV.target.slice(0,3), distance:Math.hypot(OV.pos[0]-OV.target[0],OV.pos[1]-OV.target[1],OV.pos[2]-OV.target[2])||50}
        : window.HelmCaptureFrame.frameBox({min:ub.min,max:ub.max},
          {fovDeg:camera.fov, aspect:RW/H, fill:0.88, elevationDeg:(opts && opts.topDown) ? 89 : 38, azimuthDeg:(opts && opts.topDown) ? 0 : 35, minDist:20});
      R.setPixelRatio(1); R.setSize(RW*SS,H*SS,false);
      keep.fov=camera.fov; if(OV && isFinite(OV.fov)) camera.fov=Math.max(20,Math.min(90,+OV.fov));
      camera.aspect=RW/H; camera.position.fromArray(fr.position); camera.lookAt(fr.target[0],fr.target[1],fr.target[2]);
      camera.far=Math.max(keep.far, fr.distance*4); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      // same sun as the live view (intensity/direction unchanged); only tighten its shadow frustum
      const span=Math.max(Math.abs(box.min.x),Math.abs(box.max.x),Math.abs(box.min.z),Math.abs(box.max.z),20)+10;   // frustum is centred on the sun target (origin)
      sc.left=-span; sc.right=span; sc.top=span; sc.bottom=-span; sc.far=Math.max(keep.sc[4], span*4+200); sc.updateProjectionMatrix();
      // R5: no name tags in the client picture - every sprite is hidden and replaced by a small numbered
      // badge (same number for the same name), de-overlapped in screen space, plus a legend panel
      // composited on the right of the image (so it travels with the picture everywhere)
      const num=CF.numberItems(store.items), anchors=[], tags=[], wp=new THREE.Vector3();
      // 0083: opts.labels 'none' = no marks, 'names' = uniform name tags (de-overlapped, no legend)
      const nameOf=new Map(); store.items.forEach(it=>nameOf.set(it.id,(window.HelmCaptureFrame&&HelmCaptureFrame.displayName)?HelmCaptureFrame.displayName(it):it.label));
      root.traverse(o=>{ if(o.isSprite){ keep.labels.push([o,o.scale.clone(),o.visible]); o.visible=false;
        if(o.userData.badge || mode==='none') return;
        o.getWorldPosition(wp); const ndc=wp.clone().project(camera); if(ndc.z>1 || ndc.z<-1) return;
        const x=(ndc.x+1)/2*RW, y=(1-ndc.y)/2*H;
        if(mode==='names'){ tags.push({x, y, text:nameOf.get(o.userData.itemId)}); return; }
        const n=num.byId.get(o.userData.itemId); if(!n) return;
        anchors.push({n, x, y}); } });
      R.render(scene,camera);
      const out=document.createElement('canvas'); out.width=W; out.height=H;
      const ctx=out.getContext('2d'); ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
      ctx.drawImage(cv,0,0,RW*SS,H*SS,0,0,RW,H);              // same task as render (no preserveDrawingBuffer)
      const br=Math.round(H*0.011);                          // badge diameter ~2.2% of image height
      if(mode==='numbers'){ CF.drawBadges(ctx, CF.layoutBadges(anchors, br, {w:RW, h:H}), br);
        CF.drawLegend(ctx, num.legend, RW, 0, W-RW, H); }
      else if(mode==='names') CF.drawNameTags(ctx, tags, Math.max(11, Math.round(H*0.017)), {w:RW, h:H});
      const url=out.toDataURL('image/jpeg',0.92);
      const bin=atob(url.split(',')[1]||''), u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      const b=new Blob([u8],{type:'image/jpeg'});
      if(!b || b.size<2000) throw new Error('The 3D render came out empty');
      try{ b.labels=mode; if(mode==='numbers') b.legend=num.legend.map(L=>({n:L.n,name:L.name,count:L.count})); }catch(_){}   // R5: legend data for callers
      return b;
    } finally {
      keep.labels.forEach(([o,s,v])=>{ o.scale.copy(s); o.visible=v; });
      if(ground && keep.groundScale) ground.scale.copy(keep.groundScale);
      if(grid && keep.grid!=null) grid.visible=keep.grid; if(edge && keep.edge!=null) edge.visible=keep.edge;
      if(transform){ transform.getHelper().visible=keep.tr!==false; }
      if(selHelper && keep.sel!=null) selHelper.visible=keep.sel;
      if(ground && keep.groundCol) ground.material.color.copy(keep.groundCol);
      sun.intensity=keep.sunI; sun.position.copy(keep.sunPos); sun.target.position.copy(keep.sunTgt); sun.target.updateMatrixWorld(); sun.shadow.radius=keep.sunR;
      [sc.left,sc.right,sc.top,sc.bottom,sc.far]=keep.sc; sc.updateProjectionMatrix();
      if(hemi && keep.hemiI!=null) hemi.intensity=keep.hemiI;
      if(keep.fov!=null) camera.fov=keep.fov;
      renderMode=keep.render; applyProfile();               // restores tone mapping / background / fog
      R.setPixelRatio(keep.pr); camera.far=keep.far; camera.position.copy(keep.cam); controls.target.copy(keep.tgt); camera.aspect=keep.aspect; camera.updateProjectionMatrix();
      if(active){ resize(); updateGizmo(); controls.update(); try{ R.render(scene,camera); }catch(e){} } else R.setSize(keep.size.x,keep.size.y,false);
    }
  }
  window.__capture3D=capture3D;
  /* Walkthrough hook (public/walkthrough.js): camera get/set + Evening lighting. Evening is
     switched off around a client capture so the pictures are unaffected. */
  let evening=null;
  const EVE_DECAY=1;   // decay 1 + legacyPointIntensity() tracks r128's (1 - d/range)^2 pool shape closely across the floor
  function setEvening(on){
    markShadows();
    if(!scene) return false;
    if(on && !evening){
      evening={hemi:hemi.intensity, sun:sun.intensity, bg:scene.background, lights:[]};
      hemi.intensity=0.22*LI(); sun.intensity=0.12*LI(); scene.background=new THREE.Color('#0d1020');
      const pts=(window.HelmWalkthrough && window.HelmWalkthrough.eveningLightPoints(store.items, WORLD))||[];
      for(const p of pts){ const r=p.r||60, D=EVE_DECAY;
        const L=new THREE.PointLight(0xffc27a, legacyPointIntensity(p.k||1.1, r, Math.max(1,p.y||10), D), r, D); L.position.set(p.x,p.y,p.z); scene.add(L); evening.lights.push(L); }
    } else if(!on && evening){
      hemi.intensity=evening.hemi; sun.intensity=evening.sun; scene.background=evening.bg;
      evening.lights.forEach(L=>{ scene.remove(L); L.dispose&&L.dispose(); }); evening=null;
      if(renderMode) applyProfile();
    }
    return !!evening;
  }
  let flyKeep=null, walkKeep=null, walkGuard=null, walkGood=null, prKeep=null, roofsHidden=false, hlGroup=null, groupById=new Map(), boundsCache=new Map();
  const ROOF_T={tent:1,canopy:1,stageroof:1,umbrellas:1,fairylights:1,hangingfloral:1};
  // R49 orbit guard at a walkaround stop: a drag / wheel never takes the camera under the floor or into an object
  function walkGuardStep(){
    if(!walkGuard || !controls.enabled) return;
    const p=camera.position;
    if(walkGuard([p.x,p.y,p.z])){ walkGood={p:p.toArray(), t:controls.target.toArray()}; return; }
    if(walkGood){ camera.position.fromArray(walkGood.p); controls.target.fromArray(walkGood.t); controls.update(); }
  }
  // R49: world AABB of an item's real 3D model (+ its ring chairs), from cached geometry bounds
  function boundsOf(id){
    if(boundsCache.has(id)) return boundsCache.get(id);
    if(!groupById.size) return null;                 // not built yet: never cache a miss
    const g=groupById.get(id); let out=null;
    if(g){ const b=new THREE.Box3(), tmp=new THREE.Box3(); g.updateWorldMatrix(true,true);
      g.traverse(o=>{ if(!o.isMesh || o.isSprite || !o.geometry) return; if(!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); b.union(tmp); });
      if(chairMesh && chairMap.length){ const m=new THREE.Matrix4(), v=new THREE.Vector3();
        for(let i=0;i<chairMap.length;i++) if(chairMap[i]===id){ chairMesh.getMatrixAt(i,m); v.setFromMatrixPosition(m); b.expandByPoint(v.clone().add(new THREE.Vector3(-0.9,0,-0.9))); b.expandByPoint(v.add(new THREE.Vector3(0.9,3,0.9))); } }
      if(!b.isEmpty()) out={min:b.min.toArray(), max:b.max.toArray()}; }
    boundsCache.set(id,out); return out;
  }
  function setHighlight(ids){
    if(hlGroup){ scene.remove(hlGroup); hlGroup.traverse(o=>{ if(o.geometry) o.geometry.dispose(); if(o.material) o.material.dispose(); }); hlGroup=null; }
    if(!scene || !ids || !ids.length) return;
    hlGroup=new THREE.Group(); const want=new Set(ids); let n=0;
    for(const it of store.items){ if(!want.has(it.id) || n++>=80) continue;
      const hy=objTopY(it)+1, bg=new THREE.BoxGeometry(it.width+1.2, hy, it.height+1.2);
      const ln=new THREE.LineSegments(new THREE.EdgesGeometry(bg), new THREE.LineBasicMaterial({color:col(themeVar('--accent','#047857')), transparent:true, opacity:0.85}));
      bg.dispose(); ln.position.set(sx(it.x+it.width/2), hy/2, sz(it.y+it.height/2)); ln.rotation.y=-(it.rotation||0)*Math.PI/180; hlGroup.add(ln); }
    scene.add(hlGroup);
  }
  window.__helm3D={
    isActive:()=>active,
    getView:()=> camera&&controls ? {pos:camera.position.toArray(), target:controls.target.toArray(), minD:controls.minDistance, fov:camera.fov, aspect:camera.aspect} : null,
    setView(pos,target,minD,fov){ if(!camera||!controls) return;
      camera.position.set(pos[0],pos[1],pos[2]); controls.target.set(target[0],target[1],target[2]);
      if(fov!=null && isFinite(fov) && Math.abs(fov-camera.fov)>1e-3){ camera.fov=Math.max(20,Math.min(90,fov)); camera.updateProjectionMatrix(); }
      if(minD!=null) controls.minDistance=minD; controls.update(); },
    // walkthrough glide: pause user input and flush OrbitControls damping inertia so nothing fights the
    // tween (update() with damping off zeroes the leftover rotate / pan deltas); restored on landing.
    // R49: the glide also relaxes the orbit clamps (setView's controls.update() must never bend a flight frame)
    // and drops the pixel ratio to 1 on touch devices while moving.
    setFlying(on){ if(!controls) return;
      if(on){ zoomGoal=null; zoomAnchor=null; zoomFit=null; if(!flyKeep) flyKeep={enabled:controls.enabled, damping:controls.enableDamping, minD:controls.minDistance, maxD:controls.maxDistance, polar:controls.maxPolarAngle};
        controls.enabled=false; controls.enableDamping=false; controls.minDistance=0.5; controls.maxDistance=Infinity; controls.maxPolarAngle=Math.PI-0.05; controls.update();
        try{ if(R && !prKeep && window.matchMedia && matchMedia('(pointer: coarse)').matches){ prKeep=R.getPixelRatio(); R.setPixelRatio(1); } }catch(_){} }
      else if(flyKeep){ controls.minDistance=flyKeep.minD; controls.maxDistance=flyKeep.maxD; controls.maxPolarAngle=flyKeep.polar;
        controls.enableDamping=flyKeep.damping; controls.enabled=flyKeep.enabled; flyKeep=null; walkGood=null;
        if(R && prKeep){ R.setPixelRatio(prKeep); prKeep=null; } } },
    // R49 walkaround: the NORMAL polar limit stays (no stop looks up, so nothing snaps and nobody orbits under
    // the floor); the zoom limits are set per stop on landing; selection, gizmo and click-select are off.
    setWalkMode(on){ if(!controls) return;
      if(on){ if(!walkKeep) walkKeep={maxPolar:controls.maxPolarAngle, minD:controls.minDistance, maxD:controls.maxDistance}; if(transform) transform.detach(); }
      else if(walkKeep){ controls.maxPolarAngle=walkKeep.maxPolar; controls.minDistance=walkKeep.minD; controls.maxDistance=walkKeep.maxD; walkKeep=null; walkGuard=null; walkGood=null; syncZoomLimits(); updateGizmo(); } },
    setStopLimits(L){ if(!controls || !walkKeep || !L) return; controls.minDistance=Math.max(0.5, +L.minD||4); controls.maxDistance=Math.max(controls.minDistance+1, +L.maxD||400); },
    setWalkGuard(fn){ walkGuard=typeof fn==='function' ? fn : null; walkGood=null; },
    setRoofsHidden(on){ roofsHidden=!!on; if(!root) return; for(const it of store.items){ if(!ROOF_T[it.type]) continue; const g=groupById.get(it.id); if(g) g.visible=!roofsHidden; } },
    setHighlight, setLabelFocus, boundsOf:(id)=> (built ? boundsOf(id) : null),
    // test hook (visual walkaround harness only): the live camera + scene, independent of the three.js version
    inspect:()=> (window.__HELM_WALK_TEST__ ? {camera, scene, root, chairMesh, chairMap} : null),
    setLabelsHidden,
    setEvening, isEvening:()=>!!evening,
  };
  window.__capture3D=async function(maxW,opts){ const ev=!!evening; if(ev) setEvening(false);
    try{ return await capture3D(maxW,opts); } finally{ if(ev) setEvening(true); } };

  // public hooks
  window.__on3DStateChange=function(){ if(active && !transform?.dragging) requestBuild();
    const w=window.HelmWalkthrough && window.HelmWalkthrough._ui; if(w && w.layoutChanged) w.layoutChanged(); };   // R49: the walkaround re-plans
  window.__on3DSnapChange=function(){ syncGizmoSnap(); if(scene) syncFloor(); };
  window.__on3DGridChange=function(){ if(grid) grid.visible=store.grid.show!==false; };
  window.__is3DDragging=function(){ return !!(transform && transform.dragging); };
  /* camera pan pad: move OrbitControls target AND camera together along the ground plane,
     relative to the current heading ("up" = away from the viewer). `frac` is a fraction of the
     current viewing distance (so the step scales with zoom), capped by the venue size. */
  function pan3D(dir, frac){
    if(!active || !camera || !controls || (transform && transform.dragging)) return;
    const fwd=new THREE.Vector3().subVectors(controls.target, camera.position); fwd.y=0;
    if(fwd.lengthSq()<1e-6) fwd.set(0,0,-1); fwd.normalize();
    const right=new THREE.Vector3(-fwd.z,0,fwd.x);           // fwd × up
    const dist=camera.position.distanceTo(controls.target);
    const span=Math.max(floorW||100, floorH||100);
    const step=Math.min(dist*(frac==null?0.08:frac), span*0.5);
    const d=new THREE.Vector3();
    if(dir==='up') d.copy(fwd).multiplyScalar(step); else if(dir==='down') d.copy(fwd).multiplyScalar(-step);
    else if(dir==='right') d.copy(right).multiplyScalar(step); else if(dir==='left') d.copy(right).multiplyScalar(-step);
    else return;
    // keep the target within (a margin around) the floor so you can't get lost
    const lim=span*0.75, t=controls.target.clone().add(d);
    t.x=Math.max(-lim,Math.min(lim,t.x)); t.z=Math.max(-lim,Math.min(lim,t.z));
    d.subVectors(t, controls.target);
    controls.target.add(d); camera.position.add(d); controls.update();
  }
  function recenter3D(){
    if(!camera || !controls) return;
    const off=new THREE.Vector3().subVectors(camera.position, controls.target);
    controls.target.set(0,0,0); camera.position.copy(off); controls.update();
  }
  /* ---------------- smooth zoom (wheel / pinch / +- buttons / fit) ----------------
     A zoom sets a GOAL distance; every frame the camera closes 22% of the remaining (log) gap, so the
     distance changes monotonically with no overshoot or jumps. The dolly moves toward the point under
     the cursor (on the floor) when there is one, else toward the orbit target. Limits follow the hall. */
  let zoomGoal=null, zoomAnchor=null, zoomFit=null;
  const ZOOM_SMOOTH=0.22;
  function zoomLimits(){ const span=Math.max(floorW||WORLD.w||100, floorH||WORLD.h||100);
    return { min:Math.max(6, Math.min(20, span*0.04)), max:Math.max(400, span*2.6+60) }; }
  function syncZoomLimits(){ if(!controls || walkKeep) return; const L=zoomLimits(); controls.minDistance=L.min; controls.maxDistance=L.max; }
  const wheelScale=(e)=>{ let dy=e.deltaY; if(e.deltaMode===1) dy*=16; else if(e.deltaMode===2) dy*=400;
    dy=Math.max(-240, Math.min(240, dy));
    return Math.exp(dy*(e.ctrlKey ? 0.008 : 0.0016)); };   // ctrlKey = trackpad pinch (small deltas, many events)
  function floorPoint(cx,cy){ const r=cv.getBoundingClientRect(); if(!r.width||!r.height) return null;
    const ray=new THREE.Raycaster(); ray.setFromCamera({x:((cx-r.left)/r.width)*2-1, y:-((cy-r.top)/r.height)*2+1}, camera);
    const hit=new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0), hit) ? hit : null; }
  function zoomBy(scale, anchor){
    if(!active || !camera || !controls || !controls.enabled || (transform && transform.dragging)) return;
    const L=walkKeep ? {min:controls.minDistance, max:controls.maxDistance} : zoomLimits(), cur=zoomGoal!=null ? zoomGoal : camera.position.distanceTo(controls.target);   // R49: per-stop limits during the walkaround
    zoomGoal=Math.max(L.min, Math.min(L.max, cur*scale)); zoomFit=null;
    zoomAnchor = anchor && anchor.distanceTo(controls.target) < Math.max(floorW,floorH) ? anchor : null;
  }
  function onWheel3D(e){ if(!active || !controls || !controls.enabled) return; e.preventDefault();
    zoomBy(wheelScale(e), floorPoint(e.clientX, e.clientY)); }
  function zoomFit3D(){ if(!active||!camera||!controls) return;
    const W2=floorW||WORLD.w, H2=floorH||WORLD.h, a=camera.aspect||1.6, t=Math.tan(camera.fov*Math.PI/360);
    const d=Math.hypot(W2,H2)/2/(Math.min(t, t*a)*0.85)+4, L=zoomLimits();
    zoomFit={target:new THREE.Vector3(0,0,0)}; zoomAnchor=null; zoomGoal=Math.max(L.min, Math.min(L.max, d)); }
  function stepZoom(){
    if(zoomGoal==null || !controls) return;
    if(!controls.enabled){ zoomGoal=null; zoomAnchor=null; zoomFit=null; return; }   // a walkthrough glide took over
    const off=new THREE.Vector3().subVectors(camera.position, controls.target), d=off.length()||1;
    const lg=Math.log(zoomGoal/d), done=Math.abs(lg)<0.002;
    const s=done ? zoomGoal/d : Math.exp(lg*ZOOM_SMOOTH);
    if(zoomAnchor){ controls.target.lerp(zoomAnchor, 1-s);            // dolly toward the cursor point
    }
    else if(zoomFit){ controls.target.lerp(zoomFit.target, done?1:ZOOM_SMOOTH); }
    camera.position.copy(controls.target).add(off.multiplyScalar(s));
    if(done){ zoomGoal=null; zoomAnchor=null; zoomFit=null; }
  }
  window.__zoom3D=function(k){ if(k==='fit') zoomFit3D(); else zoomBy(+k>0 ? +k : 1, null); };
  window.__pan3D=pan3D;
  window.__recenter3D=recenter3D;

  /* ---------------- wire the transform-mode toolbar + shortcuts ---------------- */
  // R62: a mode button with nothing selected says what to do (it used to look like the button did nothing)
  const needPick=()=>{ if(active && !curItem() && typeof toast==='function') toast('Select an object first, then drag its handles'); };
  document.querySelectorAll('#tools3d [data-m]').forEach(b=>b.addEventListener('click',()=>{ setTMode(b.dataset.m); needPick(); }));
  window.addEventListener('keydown',e=>{ if(!active) return;
    if(typeof anyModalOpen==='function' && anyModalOpen()) return;
    if(/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if(e.key==='g') setTMode('translate'); else if(e.key==='t') setTMode('rotate'); else if(e.key==='y') setTMode('scale');
  });

  /* ---------------- wire the Labels toggle ---------------- */
  document.querySelectorAll('#labels3d [data-l]').forEach(b=>b.addEventListener('click',()=>setLiveLabels(b.dataset.l)));
  setLiveLabels(liveLabels);
  window.__set3DLabels=setLiveLabels;

  /* ---------------- wire the View toggle ---------------- */
  const seg=document.getElementById('viewSeg');
  seg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    seg.querySelectorAll('button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
    const v=b.dataset.v;
    if(v==='3d') activate(false); else if(v==='render') activate(true); else deactivate();
  }));
  window.addEventListener('resize',()=>{ if(active) resize(); });
})();
