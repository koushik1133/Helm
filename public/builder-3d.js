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
  const loadScript = (src,integrity)=> new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; if(integrity){ s.integrity=integrity; s.crossOrigin='anonymous'; } s.onload=res; s.onerror=()=>rej(new Error('load '+src)); document.head.appendChild(s); });
  function ensure3DLibs(){
    if(libsReady || typeof THREE!=='undefined'){ libsReady=true; return Promise.resolve(true); }
    // memoise: concurrent activations (e.g. 3D then Render before scripts finish) share ONE load, never double-inject
    if(libsPromise) return libsPromise;
    libsPromise = (async()=>{
      try{
        // SRI-pinned (sha384) — CDN scripts are integrity-checked; a tampered/altered
        // file is rejected by the browser. Versions are pinned (r128 / 0.128.0).
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
          'sha384-CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu');
        await Promise.all([
          ['https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',      'sha384-wagZhIFgY4hD+7awjQjR4e2E294y6J2HSnd8eTNc15ZubTeQeVRZwhQJ+W6hnBsf'],
          ['https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TransformControls.js',   'sha384-B6xO4Jgg0u+mU5RCidCjX9gGXVfcKQqaO289hQ0Vx+dM15uhh+Bt81X49IGCFU1s'],
          ['https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/utils/BufferGeometryUtils.js',    'sha384-uODMim89BXiZh5nBix93duPujeInVvBbLHhqzNTebL4d10Kwpv21B1jYO9M3uOji'],
          ['https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',           'sha384-fljlqkjWlmSFjkESkQvm77heIZpoWmXEOzlCA7kOpGUH+95Zk0yGfQieWM2q136E'],
        ].map(([u,i])=>loadScript(u,i)));
        libsReady=true; return true;
      }catch(e){ console.warn('[3D] library load failed', e && e.message); libsPromise=null; return false; }  // allow a retry after failure
    })();
    return libsPromise;
  }
  let R, scene, camera, controls, root, chairMesh, ground, grid, edge, sun, hemi, floorW=0, floorH=0, raf=null;
  const MAX_CHAIRS_3D=6000;
  let active=false, built=false, needsBuild=false, chairMap=[];
  let transform, gizmo, gltfLoader, tmode='translate', gizmoBase=null;   // 3D editing + model loading
  const modelCache={};
  let renderMode=false, envTex=null;                                     // ✦ Render (IBL) view

  const cv = document.getElementById('scene3d');
  const stage = document.getElementById('stage3d');
  const viewport = document.querySelector('.viewport');

  const themeVar = (n,f)=>{ const v=getComputedStyle(document.body).getPropertyValue(n).trim(); return v||f; };
  const col = c => new THREE.Color((c||'#8a95ad').trim());
  const P = ft => ft;                                // 1 unit = 1 foot
  // world (ft, top-left origin, y-down) → scene (x right, z toward viewer, y up)
  const sx = fx => fx - WORLD.w/2;   // read WORLD live so a custom room size centres correctly
  const sz = fy => fy - WORLD.h/2;
  // rotate a footprint offset (feet) by degrees, matching the 2D SVG rotate() convention (clockwise, y-down)
  function rotOff(ox,oy,deg){ const t=(deg||0)*Math.PI/180,c=Math.cos(t),s=Math.sin(t); return [ox*c-oy*s, ox*s+oy*c]; }

  /* ---------------- chair model (merged, instanced) ---------------- */
  function chairGeometry(){
    const parts=[];
    const box=(w,h,d,x,y,z)=>{ const g=new THREE.BoxGeometry(w,h,d); g.translate(x,y,z); parts.push(g); };
    box(1.3,0.16,1.3, 0,1.55,0);            // seat
    box(1.3,1.35,0.16, 0,2.25,0.6);         // backrest (+z = behind sitter)
    const lx=0.55, ly=0.75, lz=0.55;
    box(0.12,1.5,0.12, lx,ly,lz); box(0.12,1.5,0.12,-lx,ly,lz);
    box(0.12,1.5,0.12, lx,ly,-lz);box(0.12,1.5,0.12,-lx,ly,-lz);
    const merged = THREE.BufferGeometryUtils.mergeBufferGeometries(parts, false);
    parts.forEach(g=>g.dispose());
    return merged;
  }

  /* ---------------- per-type furniture builders ---------------- */
  const mat = (c,opts={})=> new THREE.MeshStandardMaterial(Object.assign({color:col(c),roughness:.75,metalness:.05},opts));
  function boxMesh(w,h,d,c,opts){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat(c,opts)); m.castShadow=true; m.receiveShadow=true; return m; }

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
    const g=new THREE.Group();
    const w=it.width, d=it.height, c=it.color;
    switch(it.type){
      case 'stage': {
        const plat=boxMesh(w,3.4,d,'#3a4358'); plat.position.y=1.7; g.add(plat);
        const trim=boxMesh(w,0.5,d,c); trim.position.y=3.4; g.add(trim);
        const bh=Math.min(13,d*0.9);
        const back=boxMesh(w,bh,0.4,'#1b2233'); back.position.set(0,3.4+bh/2,-d/2+0.2); g.add(back);
        const screen=boxMesh(w*0.7,bh*0.62,0.2,'#2f6fed',{emissive:col('#2f6fed'),emissiveIntensity:.35});
        screen.position.set(0,3.4+bh*0.58,-d/2+0.5); g.add(screen);           // LED backdrop
        // front stairs + corner truss towers
        const steps=boxMesh(w*0.24,1.6,2,'#2a3346'); steps.position.set(0,0.8,d/2+1); g.add(steps);
        for(const sxx of [-1,1]){ const tower=boxMesh(1,3.4+bh+3,1,'#6b7280'); tower.position.set(sxx*(w/2-1),(3.4+bh+3)/2,-d/2+1); g.add(tower); }
        const topTruss=boxMesh(w-2,1,1,'#6b7280'); topTruss.position.set(0,3.4+bh+2.5,-d/2+1); g.add(topTruss);
        break; }
      case 'dancefloor': {
        const tiles=6, tw=w/tiles, td=d/tiles;
        for(let i=0;i<tiles;i++)for(let j=0;j<tiles;j++){
          const light=(i+j)%2===0;
          const t=boxMesh(tw,0.16,td, light?'#e9edf6':c); t.position.set(-w/2+tw*(i+0.5),0.08,-d/2+td*(j+0.5)); g.add(t);
        } break; }
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
      case 'table': {
        const rad=Math.min(w,d)/2;
        const square=it.properties && it.properties.shape==='square';
        const top = square ? boxMesh(w,0.2,d,'#c9a06a')
                           : new THREE.Mesh(new THREE.CylinderGeometry(rad,rad,0.18,28),mat('#c9a06a')); // wood-ish top
        top.position.y=2.4; top.castShadow=true; top.receiveShadow=true; g.add(top);
        const ped=new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.4,2.4,10),mat('#6b7280')); ped.position.y=1.2; ped.castShadow=true; g.add(ped);
        const base=new THREE.Mesh(new THREE.CylinderGeometry(rad*0.5,rad*0.5,0.15,16),mat('#6b7280')); base.position.y=0.08; g.add(base);
        // chairs ringed around, facing centre
        const seats=Math.max(0,it.properties.seats|0);
        const tcx=it.x+it.width/2, tcy=it.y+it.height/2, trot=it.rotation||0;
        for(let s=0;s<seats;s++){ const a=s/seats*Math.PI*2 - Math.PI/2;          // start at top (matches 2D)
          const [ox,oy]=rotOff(Math.cos(a)*(rad+1.1), Math.sin(a)*(rad+1.1), trot);
          chairs.push({ x: tcx+ox, y: tcy+oy, rot: a*180/Math.PI - 90 + trot,      // faces inward, +table rotation
            color: it.color, id: it.id }); }
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
        const sign=boxMesh(w,d*0.7,0.3,'#18a558',{emissive:col('#0d7a3f'),emissiveIntensity:.6}); sign.position.y=6; g.add(sign);
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
      case 'arch': {
        const R=Math.min(w,7);
        const arc=new THREE.Mesh(new THREE.TorusGeometry(R,0.4,10,24,Math.PI),mat(c));
        arc.position.set(0,R,0); g.add(arc);
        for(const s of [-1,1]){ const leg=boxMesh(0.5,R,0.5,c); leg.position.set(s*R,R/2,0); g.add(leg); }
        break; }
      case 'tent': {
        for(const [px,pz] of [[-w/2+1,-d/2+1],[w/2-1,-d/2+1],[-w/2+1,d/2-1],[w/2-1,d/2-1]]){
          const p=boxMesh(0.3,8,0.3,'#c9ccd6'); p.position.set(px,4,pz); g.add(p); }
        const roof=new THREE.Mesh(new THREE.ConeGeometry(Math.max(w,d)*0.72,6,4),mat(c,{roughness:.95,transparent:true,opacity:.9}));
        roof.position.y=11; roof.rotation.y=Math.PI/4; roof.castShadow=true; g.add(roof);
        break; }
      case 'longtable': case 'headtable': {
        const top=boxMesh(w,0.2,d,'#c9a06a'); top.position.y=2.4; g.add(top);
        for(const [px,pz] of [[-w/2+0.6,-d/2+0.3],[w/2-0.6,-d/2+0.3],[-w/2+0.6,d/2-0.3],[w/2-0.6,d/2-0.3]]){
          const leg=boxMesh(0.15,2.4,0.15,'#8a6a44'); leg.position.set(px,1.2,pz); g.add(leg); }
        if(it.type==='headtable'){ const cloth=boxMesh(w,2.3,0.1,'#e9edf6'); cloth.position.set(0,1.15,d/2); g.add(cloth); }
        const seats=Math.max(0,it.properties.seats|0);
        const cx0=it.x+it.width/2, cy0=it.y+it.height/2, trot=it.rotation||0;
        const oneSide=it.type==='headtable';
        const nTop=oneSide?seats:Math.ceil(seats/2), nBot=oneSide?0:seats-nTop;
        const addRow=(n,side)=>{ for(let i=0;i<n;i++){ const lx=-w/2+(i+0.5)/Math.max(1,n)*w;
          const [ox,oy]=rotOff(lx, side*(d/2+1.1), trot);
          const baseRot= side<0 ? 180 : 0;                        // face the table (+z if on -z side)
          chairs.push({ x:cx0+ox, y:cy0+oy, rot:baseRot+trot, color:it.color, id:it.id }); } };
        addRow(nTop,-1); addRow(nBot,+1);
        break; }
      case 'cocktail': {
        const rad=Math.min(w,d)/2;
        const top=new THREE.Mesh(new THREE.CylinderGeometry(rad,rad,0.12,20),mat('#e9edf6')); top.position.y=3.6; top.castShadow=true; g.add(top);
        const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.18,3.6,10),mat('#6b7280')); pole.position.y=1.8; g.add(pole);
        const base=new THREE.Mesh(new THREE.CylinderGeometry(rad*0.7,rad*0.7,0.12,16),mat('#6b7280')); base.position.y=0.06; g.add(base);
        const seats=Math.max(0,it.properties.seats|0), tcx=it.x+it.width/2,tcy=it.y+it.height/2,trot=it.rotation||0;
        for(let s=0;s<seats;s++){ const a=s/seats*Math.PI*2 - Math.PI/2;
          const [ox,oy]=rotOff(Math.cos(a)*(rad+1),Math.sin(a)*(rad+1),trot);
          chairs.push({ x:tcx+ox, y:tcy+oy, rot:a*180/Math.PI-90+trot, color:it.color, id:it.id }); }
        break; }
      case 'lounge': {
        const rug=boxMesh(w,0.06,d,c,{transparent:true,opacity:.35}); rug.position.y=0.03; g.add(rug);
        const sofa=(sw,sd,x,z,ry)=>{ const s=new THREE.Group();
          const seat=boxMesh(sw,1.3,sd,c); seat.position.y=0.75; s.add(seat);
          const bk=boxMesh(sw,1.4,0.4,c); bk.position.set(0,1.6,-sd/2+0.2); s.add(bk);
          s.position.set(x,0,z); s.rotation.y=ry; return s; };
        g.add(sofa(w*0.7,2.4,0,-d/2+1.4,0));
        g.add(sofa(2.4,w*0.5,-w/2+1.4,0.5,Math.PI/2));
        const coffee=boxMesh(w*0.28,1,d*0.3,'#c9a06a'); coffee.position.y=0.5; g.add(coffee);
        break; }
      case 'bar': {
        const counter=boxMesh(w,3.6,d*0.55,'#3a4358'); counter.position.set(0,1.8,-d*0.2); g.add(counter);
        const top=boxMesh(w+0.6,0.25,d*0.6,c); top.position.set(0,3.7,-d*0.2); g.add(top);
        const back=boxMesh(w*0.9,5,0.4,'#2a3346'); back.position.set(0,2.5,-d/2+0.2); g.add(back);
        break; }
      case 'buffet': {
        const counter=boxMesh(w,3,d,'#e9edf6'); counter.position.y=1.5; g.add(counter);
        for(let i=0;i<Math.max(2,Math.round(w/5));i++){ const dome=new THREE.Mesh(new THREE.SphereGeometry(1,12,8,0,Math.PI*2,0,Math.PI/2),mat('#b8c0cf',{metalness:.4,roughness:.3}));
          dome.position.set(-w/2+ (i+0.5)*(w/Math.max(2,Math.round(w/5))),3.1,0); g.add(dome); }
        break; }
      case 'photobooth': {
        const box=boxMesh(w,8,d,c); box.position.y=4; g.add(box);
        const curtain=boxMesh(w*0.7,6,0.2,'#2a3346'); curtain.position.set(0,3,d/2); g.add(curtain);
        break; }
      case 'checkpoint': {
        for(const s of [-1,1]){ const p=boxMesh(0.5,7,d,'#3a4358'); p.position.set(s*(w/2-0.25),3.5,0); g.add(p); }
        const topbar=boxMesh(w,0.6,d,c); topbar.position.y=7; g.add(topbar);
        break; }
      case 'restroom': {
        const cabins=Math.max(2,Math.round(w/4));
        for(let i=0;i<cabins;i++){ const cab=boxMesh(w/cabins*0.9,7.5,d,c); cab.position.set(-w/2+(i+0.5)*(w/cabins),3.75,0); g.add(cab); }
        break; }
      case 'gifttable': case 'caketable': {
        const round=it.type==='caketable';
        const top= round ? new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w,d)/2,Math.min(w,d)/2,0.2,20),mat('#e9edf6'))
                         : boxMesh(w,0.2,d,'#e9edf6');
        top.position.y=2.4; g.add(top);
        const cloth=boxMesh(w,2.4,d,c,{transparent:true,opacity:.7}); cloth.position.y=1.2; g.add(cloth);
        if(round){ const cake=new THREE.Mesh(new THREE.CylinderGeometry(0.8,1,1.2,16),mat('#ffffff')); cake.position.y=3.1; g.add(cake); }
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
      case 'redcarpet': {
        const rug=boxMesh(w,0.1,d,c); rug.position.y=0.06; g.add(rug);
        for(const sxx of [-1,1]){ for(let z=-d/2+2;z<d/2;z+=6){ const post=new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.2,3,10),mat('#c9a06a'));
          post.position.set(sxx*(w/2),1.5,z); g.add(post); } } break; }
      case 'planter': {
        const pot=new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w,d)/2,Math.min(w,d)/2*0.8,1.6,16),mat('#8a6a44')); pot.position.y=0.8; g.add(pot);
        const bush=new THREE.Mesh(new THREE.SphereGeometry(Math.min(w,d)/2*0.9,12,10),mat('#2f8f4e',{roughness:.95})); bush.position.y=2.3; bush.castShadow=true; g.add(bush); break; }
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
      case 'floral': {
        const vase=new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.7,1.6,14),mat('#c9ccd6')); vase.position.y=0.8; g.add(vase);
        const blooms=new THREE.Mesh(new THREE.SphereGeometry(Math.min(w,d)/2*0.9,14,12),mat(c,{roughness:.9})); blooms.position.y=2.3; blooms.castShadow=true; g.add(blooms); break; }
      case 'floralarch': {
        const R=Math.min(w,8);
        const arc=new THREE.Mesh(new THREE.TorusGeometry(R,0.5,12,28,Math.PI),mat(c,{roughness:.9})); arc.position.set(0,R,0); g.add(arc);
        for(const s of [-1,1]){ const leg=new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.4,R,10),mat(c,{roughness:.9})); leg.position.set(s*R,R/2,0); g.add(leg); } break; }
      case 'mandap': {
        const H=10;
        for(const [px,pz] of [[-w/2+1,-d/2+1],[w/2-1,-d/2+1],[-w/2+1,d/2-1],[w/2-1,d/2-1]]){
          const p=new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.5,H,12),mat(c,{roughness:.85})); p.position.set(px,H/2,pz); p.castShadow=true; g.add(p); }
        const canopyTop=new THREE.Mesh(new THREE.ConeGeometry(Math.max(w,d)*0.7,4,4),mat(c,{roughness:.9})); canopyTop.position.y=H+1.8; canopyTop.rotation.y=Math.PI/4; g.add(canopyTop);
        const platform=boxMesh(w*0.55,0.3,d*0.55,'#d8c39a'); platform.position.y=0.15; g.add(platform); break; }
      case 'pillar': {
        const col=new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w,d)/2*0.8,Math.min(w,d)/2,7,16),mat('#eee4d0')); col.position.y=3.5; col.castShadow=true; g.add(col);
        const cap=boxMesh(w,0.5,d,'#eee4d0'); cap.position.y=7.1; g.add(cap);
        const vase=new THREE.Mesh(new THREE.SphereGeometry(Math.min(w,d)/2,12,10),mat(c,{roughness:.9})); vase.position.y=7.8; g.add(vase); break; }
      case 'drape': {
        const bar=boxMesh(w,0.2,0.2,'#9aa3b2'); bar.position.y=10; g.add(bar);
        const cloth=boxMesh(w,10,0.15,c,{transparent:true,opacity:.9}); cloth.position.y=5; g.add(cloth);
        for(const sxx of [-1,1]){ const post=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,10,10),mat('#9aa3b2')); post.position.set(sxx*w/2,5,0); g.add(post); } break; }
      case 'chandelier': {
        const rad=Math.min(w,d)/2;
        const ring=new THREE.Mesh(new THREE.TorusGeometry(rad,0.15,10,24),mat('#d9b45a',{metalness:.6,roughness:.3})); ring.rotation.x=Math.PI/2; ring.position.y=9; g.add(ring);
        for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; const b=new THREE.Mesh(new THREE.SphereGeometry(0.35,10,8),mat('#fff6e0',{emissive:col('#ffd98a'),emissiveIntensity:.7}));
          b.position.set(Math.cos(a)*rad,8.7,Math.sin(a)*rad); g.add(b); }
        const cord=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,3,6),mat('#6b7280')); cord.position.y=11; g.add(cord); break; }
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
      case 'chiavari': {
        const seatH=1.5;
        const seat=boxMesh(w*0.9,0.18,d*0.8,c); seat.position.y=seatH; g.add(seat);
        const back=boxMesh(w*0.85,1.4,0.12,c); back.position.set(0,seatH+0.75,-d*0.32); g.add(back);
        for(const [lx,lz] of [[-w*0.35,-d*0.3],[w*0.35,-d*0.3],[-w*0.35,d*0.3],[w*0.35,d*0.3]]){
          const leg=boxMesh(0.09,seatH,0.09,c); leg.position.set(lx,seatH/2,lz); g.add(leg); }
        break; }
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
      case 'generator': {
        const body=boxMesh(w,3.2,d,c,{roughness:.6,metalness:.2}); body.position.y=1.8; g.add(body);
        const exhaust=new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.15,1.4,8),mat('#20242c',{metalness:.5})); exhaust.position.set(w*0.4,3.8,-d*0.3); g.add(exhaust);
        const panel=boxMesh(w*0.5,1.2,0.1,'#20242c'); panel.position.set(0,1.9,d*0.5); g.add(panel); break; }
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
    const cvs=document.createElement('canvas'); const s=2; cvs.width=256*s; cvs.height=64*s;
    const ctx=cvs.getContext('2d'); ctx.scale(s,s);
    ctx.fillStyle='rgba(20,27,46,.82)'; roundRect(ctx,0,14,256,36,8); ctx.fill();
    ctx.font='600 22px "IBM Plex Sans",sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text,128,33);
    const tex=new THREE.CanvasTexture(cvs); tex.anisotropy=4;
    const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true}));
    spr.scale.set(10,2.5,1); labelCache.set(text,spr); return spr.clone();
  }
  function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }

  /* ---------------- scene assembly ---------------- */
  function initScene(){
    R=new THREE.WebGLRenderer({canvas:cv,antialias:true,alpha:true});
    R.setPixelRatio(Math.min(devicePixelRatio,2)); R.shadowMap.enabled=true; R.shadowMap.type=THREE.PCFSoftShadowMap;
    scene=new THREE.Scene();
    camera=new THREE.PerspectiveCamera(48,1,0.5,3000);
    camera.position.set(0,140,180);
    controls=new THREE.OrbitControls(camera,cv);
    controls.enableDamping=true; controls.dampingFactor=0.08; controls.maxPolarAngle=Math.PI/2-0.03;
    controls.minDistance=20; controls.maxDistance=700; controls.target.set(0,0,0);

    hemi=new THREE.HemisphereLight(0xffffff,0x9fb0c8,0.75); scene.add(hemi);
    sun=new THREE.DirectionalLight(0xffffff,0.85); sun.position.set(70,160,60); sun.castShadow=true;
    sun.shadow.mapSize.set(2048,2048); sun.shadow.camera.near=1; sun.shadow.camera.far=600;
    scene.add(sun);
    syncFloor();

    root=new THREE.Group(); scene.add(root);

    // ---- TransformControls: drag / rotate / scale the selected object in 3D ----
    gizmo=new THREE.Object3D(); scene.add(gizmo);
    transform=new THREE.TransformControls(camera, cv); transform.setSize(0.85);
    transform.addEventListener('dragging-changed', e=>{ controls.enabled=!e.value;
      if(e.value){ const it=curItem(); gizmoBase = it?{x:it.x,y:it.y,width:it.width,height:it.height,cx:it.x+it.width/2,cy:it.y+it.height/2}:null; }
      else { gizmoBase=null; if(store.selectedId){ commit(); } renderAll(); } });
    transform.addEventListener('objectChange', onGizmoChange);
    setTMode(tmode); syncGizmoSnap();
    scene.add(transform);

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
    if(!scene || (floorW===WORLD.w && floorH===WORLD.h && ground)) return;
    floorW=WORLD.w; floorH=WORLD.h;
    disposeObj(ground); disposeObj(grid); disposeObj(edge);
    ground=new THREE.Mesh(new THREE.PlaneGeometry(floorW+40,floorH+40),
      new THREE.MeshStandardMaterial({color:col(themeVar('--canvas','#f4f7fd')),roughness:1}));
    ground.rotation.x=-Math.PI/2; ground.position.y=-0.02; ground.receiveShadow=true; scene.add(ground);
    const gs=Math.max(floorW,floorH)+40;
    grid=new THREE.GridHelper(gs, Math.min(gs,1200), col(themeVar('--grid-strong','#9fb4d8')), col(themeVar('--grid','#c3d1ea')));
    grid.material.opacity=0.5; grid.material.transparent=true; scene.add(grid);
    edge=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(floorW,0.1,floorH)),
      new THREE.LineBasicMaterial({color:col(themeVar('--grid-strong','#9fb4d8'))})); edge.position.y=0.05; scene.add(edge);
    if(sun){ const sc=sun.shadow.camera, hw=floorW, hh=floorH;   // same generous frustum as before (±W, ±H), now live
      sc.left=-hw; sc.right=hw; sc.top=hh; sc.bottom=-hh; sc.far=Math.max(600, Math.max(floorW,floorH)*3); sc.updateProjectionMatrix(); }
    if(camera && controls){ controls.maxDistance=Math.max(700, Math.max(floorW,floorH)*3); }
    if(R) applyProfile();                           // re-apply Render-mode material tweaks to the new ground
  }
  const curItem=()=> store.items.find(i=>i.id===store.selectedId)||null;
  function setTMode(m){ tmode=m; if(!transform) return;
    transform.setMode(m==='scale'?'scale':m==='rotate'?'rotate':'translate');
    // constrain to the floor plane: no vertical translate, yaw-only rotate, planar scale
    if(m==='rotate'){ transform.showX=false; transform.showY=true; transform.showZ=false; }
    else { transform.showX=true; transform.showY=false; transform.showZ=true; }
    document.querySelectorAll('#tools3d [data-m]').forEach(b=>b.classList.toggle('on', b.dataset.m===m));
  }
  function syncGizmoSnap(){ if(!transform) return;
    transform.translationSnap = store.grid.snap ? cellFt() : null;
    transform.rotationSnap = store.grid.snap ? THREE.MathUtils.degToRad(15) : null;
  }
  function updateGizmo(){
    if(!transform) return; const it=curItem();
    if(!it || !active){ transform.detach(); return; }
    gizmo.position.set(sx(it.x+it.width/2),0,sz(it.y+it.height/2));
    gizmo.rotation.set(0,-(it.rotation||0)*Math.PI/180,0); gizmo.scale.set(1,1,1);
    if(transform.object!==gizmo) transform.attach(gizmo);
  }
  function onGizmoChange(){
    const it=curItem(); if(!it || !gizmoBase) return;
    if(tmode==='translate'){
      const cxft=gizmo.position.x+WORLD.w/2, cyft=gizmo.position.z+WORLD.h/2;   // live WORLD (the hall can be resized after boot)
      it.x=clamp(cxft-it.width/2,0,WORLD.w-it.width); it.y=clamp(cyft-it.height/2,0,WORLD.h-it.height);
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
    clearRoot(); chairMap=[];
    syncFloor();
    if(labelCache.size>LABEL_CACHE_MAX) flushLabelCache();   // no clones are in the scene right now
    const chairs=[];
    chairs.push=function(){ if(this.length>=MAX_CHAIRS_3D) return this.length; return Array.prototype.push.apply(this,arguments); };   // never build more than we can draw
    for(const it of store.items){
      const g=buildFurniture(it, chairs);
      if(g){ g.position.set(sx(it.x+it.width/2),0,sz(it.y+it.height/2)); g.rotation.y=-(it.rotation||0)*Math.PI/180;
        g.userData.itemId=it.id; root.add(g);
        if(['seatblock','chairrow'].indexOf(it.type)===-1){ const lp=label(it.label);
          lp.position.set(sx(it.x+it.width/2), objTopY(it)+3, sz(it.y+it.height/2)); lp.userData.itemId=it.id; root.add(lp); } }
    }
    buildChairs(chairs);
    if(!transform || !transform.dragging){ syncGizmoSnap(); updateGizmo(); }
    needsBuild=false;
  }
  function objTopY(it){ const t={stage:4,press:4,dj:3.2,podium:3.6,booth:8,truck:7,exit:7,table:2.6,desk:3.2,dancefloor:.3,barricade:3.4,fence:6,
    canopy:13,tent:14,arch:8,bar:5,buffet:4,photobooth:8,checkpoint:8,restroom:8,lounge:2,longtable:3,headtable:3,cocktail:4,gifttable:3,caketable:4,
    ledscreen:10,truss:16,speaker:6,coatcheck:5,firstaid:8,planter:3.5,redcarpet:3,parking:1,
    sofa:3,loveseat:3,armchair:3,ottoman:1.6,bench:2,coffeetable:1.8,floral:3.4,floralarch:9,mandap:13,pillar:8.5,drape:10.5,chandelier:11,fountain:3.5,uplight:2,heater:8,easel:5,
    chiavari:2.5,barstool:2.6,piano:3.4,bleacher:4.5,linearray:17,subwoofer:3,monitor:1.4,foh:3,movinghead:5.2,videowall:15,generator:4,distro:2.4,cableramp:1,greenroom:8.5,viprisers:2.2,stagebarrier:3.2}; return t[it.type]||2.6; }

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
  function loop(){ if(!active) return; raf=requestAnimationFrame(loop);   // schedule first: a throwing frame (lost context) must not kill the loop
    try{ controls.update(); refreshSel(); R.render(scene,camera); }catch(e){ /* skip this frame */ } }
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
    if(!R||!scene) return;
    if(renderMode){
      try{ if(!envTex) envTex=buildEnvTexture(); scene.environment=envTex; }catch(e){ scene.environment=null; }
      R.toneMapping=THREE.ACESFilmicToneMapping; R.toneMappingExposure=1.05; R.outputEncoding=THREE.sRGBEncoding;
      scene.background=new THREE.Color(themeVar('--panel-2','#f2efe9'));
      scene.fog=new THREE.Fog(new THREE.Color(themeVar('--panel-2','#f2efe9')), 300, 760);
      if(ground){ ground.material.roughness=0.5; ground.material.metalness=0.15; ground.material.envMapIntensity=0.6; ground.material.needsUpdate=true; }
    } else {
      scene.environment=null; scene.background=null; scene.fog=null;
      R.toneMapping=THREE.NoToneMapping; R.outputEncoding=THREE.LinearEncoding;
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
  function deactivate(){ active=false; renderMode=false; viewport.classList.remove('is3d','isRender'); stage.hidden=true; if(transform) transform.detach(); if(raf){ cancelAnimationFrame(raf); raf=null; } }

  /* R2: "Update client images" - a clean three-quarter render of the venue for the client booklet.
     Offscreen-sized (maxW px wide, 16:9), realistic profile, no grid / gizmo / selection box;
     every touched piece of state (size, camera, profile, helpers) is restored afterwards. */
  async function capture3D(maxW){
    maxW=Math.max(640, Math.min(2400, Number(maxW)||1920));
    if(!libsReady){ const ok=await ensure3DLibs(); if(!ok) throw new Error('The 3D library couldn’t load'); }
    if(!built) initScene();
    syncFloor(); build();
    const W=maxW, H=Math.round(maxW*9/16), SS=2;           // render at 2x, downscale (anti-aliasing)
    const sc=sun.shadow.camera;
    const keep={ pr:R.getPixelRatio(), size:R.getSize(new THREE.Vector2()), cam:camera.position.clone(), tgt:controls.target.clone(),
      aspect:camera.aspect, far:camera.far, render:renderMode, grid:grid?grid.visible:null, edge:edge?edge.visible:null, tr:transform?transform.visible:null,
      sel:selHelper?selHelper.visible:null, sunI:sun.intensity, sunPos:sun.position.clone(), sunTgt:sun.target.position.clone(), sunR:sun.shadow.radius,
      sc:[sc.left,sc.right,sc.top,sc.bottom,sc.far], hemiI:hemi?hemi.intensity:null, groundCol:ground?ground.material.color.clone():null, labels:[] };
    try{
      if(grid) grid.visible=false; if(edge) edge.visible=false; if(transform){ transform.detach(); transform.visible=false; } if(selHelper) selHelper.visible=false;
      renderMode=true; applyProfile();
      // client look: darker backdrop + floor for contrast, no fog wash, stronger key light with soft shadows
      scene.fog=null; scene.background=new THREE.Color('#3b4354');
      if(ground) ground.material.color.multiplyScalar(0.72);
      R.toneMapping=THREE.ACESFilmicToneMapping; R.toneMappingExposure=1.0; R.outputEncoding=THREE.sRGBEncoding;
      if(hemi) hemi.intensity=0.5; sun.intensity=1.35;
      // frame the bounding box of the actual objects (labels excluded), fallback to the floor
      const box=new THREE.Box3();
      root.traverse(o=>{ if(o.isMesh || o.isInstancedMesh){ o.updateWorldMatrix(true,false); box.expandByObject(o); } });
      if(box.isEmpty()){ const hw=(floorW||WORLD.w)/2, hh=(floorH||WORLD.h)/2; box.min.set(-hw,0,-hh); box.max.set(hw,4,hh); }
      const pad=2; box.min.x-=pad; box.min.z-=pad; box.max.x+=pad; box.max.z+=pad; box.min.y=Math.min(box.min.y,0);
      const fr=window.HelmCaptureFrame.frameBox({min:box.min.toArray(),max:box.max.toArray()},
        {fovDeg:camera.fov, aspect:W/H, fill:0.85, elevationDeg:38, azimuthDeg:35, minDist:20});
      R.setPixelRatio(1); R.setSize(W*SS,H*SS,false);
      camera.aspect=W/H; camera.position.fromArray(fr.position); camera.lookAt(fr.target[0],fr.target[1],fr.target[2]);
      camera.far=Math.max(keep.far, fr.distance*4); camera.updateProjectionMatrix();
      // key light from the front-left, shadow frustum hugging the objects (crisper shadows)
      const span=Math.max(box.max.x-box.min.x, box.max.z-box.min.z, 20);
      sun.target.position.fromArray(fr.target); sun.target.updateMatrixWorld();
      sun.position.set(fr.target[0]-span*0.45, span*1.1+40, fr.target[2]+span*0.6);
      sc.left=-span; sc.right=span; sc.top=span; sc.bottom=-span; sc.far=span*4+200; sc.updateProjectionMatrix(); sun.shadow.radius=3;
      // readable labels: scale with the framed size
      const ls=Math.max(1, Math.min(2.6, span/110));
      root.traverse(o=>{ if(o.isSprite){ keep.labels.push([o,o.scale.clone()]); o.scale.multiplyScalar(ls); } });
      R.render(scene,camera);
      const out=document.createElement('canvas'); out.width=W; out.height=H;
      const ctx=out.getContext('2d'); ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
      ctx.drawImage(cv,0,0,W*SS,H*SS,0,0,W,H);                // same task as render (no preserveDrawingBuffer)
      const url=out.toDataURL('image/jpeg',0.92);
      const bin=atob(url.split(',')[1]||''), u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      const b=new Blob([u8],{type:'image/jpeg'});
      if(!b || b.size<2000) throw new Error('The 3D render came out empty');
      return b;
    } finally {
      keep.labels.forEach(([o,s])=>o.scale.copy(s));
      if(grid && keep.grid!=null) grid.visible=keep.grid; if(edge && keep.edge!=null) edge.visible=keep.edge;
      if(transform){ transform.visible=keep.tr!==false; }
      if(selHelper && keep.sel!=null) selHelper.visible=keep.sel;
      if(ground && keep.groundCol) ground.material.color.copy(keep.groundCol);
      sun.intensity=keep.sunI; sun.position.copy(keep.sunPos); sun.target.position.copy(keep.sunTgt); sun.target.updateMatrixWorld(); sun.shadow.radius=keep.sunR;
      [sc.left,sc.right,sc.top,sc.bottom,sc.far]=keep.sc; sc.updateProjectionMatrix();
      if(hemi && keep.hemiI!=null) hemi.intensity=keep.hemiI;
      renderMode=keep.render; applyProfile();               // restores tone mapping / background / fog
      R.setPixelRatio(keep.pr); camera.far=keep.far; camera.position.copy(keep.cam); controls.target.copy(keep.tgt); camera.aspect=keep.aspect; camera.updateProjectionMatrix();
      if(active){ resize(); updateGizmo(); controls.update(); try{ R.render(scene,camera); }catch(e){} } else R.setSize(keep.size.x,keep.size.y,false);
    }
  }
  window.__capture3D=capture3D;

  // public hooks
  window.__on3DStateChange=function(){ if(active && !transform?.dragging) requestBuild(); };
  window.__on3DSnapChange=function(){ syncGizmoSnap(); };
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
  window.__pan3D=pan3D;
  window.__recenter3D=recenter3D;

  /* ---------------- wire the transform-mode toolbar + shortcuts ---------------- */
  document.querySelectorAll('#tools3d [data-m]').forEach(b=>b.addEventListener('click',()=>setTMode(b.dataset.m)));
  window.addEventListener('keydown',e=>{ if(!active) return;
    if(typeof anyModalOpen==='function' && anyModalOpen()) return;
    if(/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if(e.key==='g') setTMode('translate'); else if(e.key==='t') setTMode('rotate'); else if(e.key==='y') setTMode('scale');
  });

  /* ---------------- wire the View toggle ---------------- */
  const seg=document.getElementById('viewSeg');
  seg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    seg.querySelectorAll('button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
    const v=b.dataset.v;
    if(v==='3d') activate(false); else if(v==='render') activate(true); else deactivate();
  }));
  window.addEventListener('resize',()=>{ if(active) resize(); });
})();
