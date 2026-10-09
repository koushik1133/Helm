/* Camera framing for the client 3D capture: given an axis-aligned bounding box of the scene's
   objects, place a perspective camera on a fixed elevated three-quarter direction so the box's
   8 PROJECTED corners span `fill` (default 0.88) of the frame on the binding axis, centred.
   Pure math (no THREE) so it is unit-testable in node. */
(function(root){
  function basis(el, az){
    const dir=[Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az)];   // target -> camera
    const f=[-dir[0],-dir[1],-dir[2]];
    let r=[-f[2],0,f[0]]; const rl=Math.hypot(r[0],r[2])||1; r=[r[0]/rl,0,r[2]/rl];
    const u=[r[1]*f[2]-r[2]*f[1], r[2]*f[0]-r[0]*f[2], r[0]*f[1]-r[1]*f[0]];
    return {dir,f,r,u};
  }
  function corners(box){ const out=[]; for(let i=0;i<8;i++) out.push([i&1?box.max[0]:box.min[0], i&2?box.max[1]:box.min[1], i&4?box.max[2]:box.min[2]]); return out; }
  // project world points for a camera at `pos` looking along basis f; returns NDC [-1,1] (x,y) per point
  function project(pts, pos, B, tanV, aspect){
    return pts.map(p=>{ const q=[p[0]-pos[0],p[1]-pos[1],p[2]-pos[2]];
      const z=q[0]*B.f[0]+q[1]*B.f[1]+q[2]*B.f[2];
      return [ (q[0]*B.r[0]+q[2]*B.r[2])/z/(tanV*aspect), (q[0]*B.u[0]+q[1]*B.u[1]+q[2]*B.u[2])/z/tanV, z ]; });
  }
  function frameBox(box, o){
    o=o||{}; const fovV=(o.fovDeg||48)*Math.PI/180, aspect=o.aspect||16/9, fill=o.fill||0.88;
    const el=(o.elevationDeg!=null?o.elevationDeg:38)*Math.PI/180, az=(o.azimuthDeg!=null?o.azimuthDeg:35)*Math.PI/180;
    const B=basis(el,az), tanV=Math.tan(fovV/2), pts=corners(box), minD=o.minDist||1;
    const c=[(box.min[0]+box.max[0])/2,(box.min[1]+box.max[1])/2,(box.min[2]+box.max[2])/2];
    // conservative start: every corner inside `fill` around the centre
    let d=0;
    for(const p0 of pts){ const p=[p0[0]-c[0],p0[1]-c[1],p0[2]-c[2]];
      const pd=p[0]*B.dir[0]+p[1]*B.dir[1]+p[2]*B.dir[2];
      const pr=Math.abs(p[0]*B.r[0]+p[2]*B.r[2]), pu=Math.abs(p[0]*B.u[0]+p[1]*B.u[1]+p[2]*B.u[2]);
      d=Math.max(d, pd+pr/(tanV*aspect*fill), pd+pu/(tanV*fill)); }
    d=Math.max(d,minD);
    // refine: perspective makes the projection lopsided, so re-centre the projected box (pan in the
    // view plane) and pull in until the binding axis spans exactly `fill` of the frame
    let t=c.slice(), ext=0;
    for(let it=0; it<60; it++){
      const pos=[t[0]+B.dir[0]*d, t[1]+B.dir[1]*d, t[2]+B.dir[2]*d];
      const P=project(pts,pos,B,tanV,aspect);
      let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
      for(const q of P){ x0=Math.min(x0,q[0]); x1=Math.max(x1,q[0]); y0=Math.min(y0,q[1]); y1=Math.max(y1,q[1]); }
      ext=Math.max((x1-x0)/2,(y1-y0)/2);
      const cx=(x0+x1)/2, cy=(y0+y1)/2;
      if(Math.abs(cx)<1e-5 && Math.abs(cy)<1e-5 && Math.abs(ext-fill)<1e-4) break;
      t=[t[0]+B.r[0]*cx*d*tanV*aspect+B.u[0]*cy*d*tanV, t[1]+B.u[1]*cy*d*tanV, t[2]+B.r[2]*cx*d*tanV*aspect+B.u[2]*cy*d*tanV];
      const nd=Math.max(minD, d*(1+(ext/fill-1)*0.9));
      if(nd===d && d===minD && Math.abs(cx)<1e-5 && Math.abs(cy)<1e-5) break;
      d=nd;
    }
    return { target:t, position:[t[0]+B.dir[0]*d, t[1]+B.dir[1]*d, t[2]+B.dir[2]*d], distance:d, dir:B.dir, extent:ext };
  }
  // NDC of the 8 corners for a given framing result (used by tests and for sanity checks)
  function projectBox(box, fr, o){ o=o||{}; const fovV=(o.fovDeg||48)*Math.PI/180;
    const B=basis((o.elevationDeg!=null?o.elevationDeg:38)*Math.PI/180,(o.azimuthDeg!=null?o.azimuthDeg:35)*Math.PI/180);
    return project(corners(box), fr.position, B, Math.tan(fovV/2), o.aspect||16/9); }
  // world height of a label so it renders at `frac` of the image height at the framed distance
  function labelWorldHeight(distance, fovDeg, frac){ return 2*distance*Math.tan((fovDeg||48)*Math.PI/360)*(frac||0.03); }
  // R4: label sprites are screen-constant in the capture. The sprite canvas is 64px tall with a 22px
  // font (cap height ~16px => 0.25 of the sprite), so a sprite at camera depth `depth` must be this
  // tall in world units for its text cap height to be `capFrac` of the image height.
  const LABEL_CAP_RATIO=0.25;
  function labelScaleForDepth(depth, fovDeg, capFrac, spriteH){
    const viewH=2*Math.max(depth,1e-3)*Math.tan((fovDeg||48)*Math.PI/360);
    return viewH*(capFrac||0.017)/LABEL_CAP_RATIO/(spriteH||2.5);
  }
  // union of the objects' box and the hall floor rectangle (y=0), so the floor edges are in frame
  function unionFloor(box, floorW, floorH, margin){
    const m=margin||0, hw=floorW/2+m, hh=floorH/2+m;
    if(!box) return {min:[-hw,0,-hh],max:[hw,0,hh]};
    return { min:[Math.min(box.min[0],-hw), Math.min(box.min[1],0), Math.min(box.min[2],-hh)],
             max:[Math.max(box.max[0], hw), Math.max(box.max[1],0), Math.max(box.max[2], hh)] };
  }
  // decide which labels to draw: drop a label whose projected box overlaps one already kept by more
  // than `maxOverlap` of its own area, and dedupe identical text closer than `dupDist` (NDC units).
  // labels: [{text, x, y, w, h}] in NDC, nearest first is best. Returns array of kept indices.
  function pickLabels(labels, o){ o=o||{}; const maxOv=o.maxOverlap!=null?o.maxOverlap:0.35, dup=o.dupDist!=null?o.dupDist:0.12;
    const kept=[];
    labels.forEach((L,i)=>{
      for(const k of kept){ const K=labels[k];
        if(K.text===L.text && Math.hypot(K.x-L.x,K.y-L.y)<dup) return;
        const ox=Math.max(0,Math.min(K.x+K.w/2,L.x+L.w/2)-Math.max(K.x-K.w/2,L.x-L.w/2));
        const oy=Math.max(0,Math.min(K.y+K.h/2,L.y+L.h/2)-Math.max(K.y-K.h/2,L.y-L.h/2));
        if(ox*oy > maxOv*L.w*L.h) return; }
      kept.push(i); });
    return kept;
  }

  /* R5: numbered markers + legend for the client captures (3D and 2D share this, so the same layout
     gets the same numbers in both pictures). items: [{id, label, x, y, width, height, type}] in
     floor feet. Each distinct name gets one number; numbers follow the first occurrence in
     back-to-front (y), left-to-right (x) order, ties by name - stable and deterministic. */
  const NO_MARKER={seatblock:1, chairrow:1};
  function legendName(s){ return String(s==null?'':s).replace(/\s+/g,' ').trim().slice(0,40); }
  function numberItems(items){
    const rows=[];
    (items||[]).forEach((it,i)=>{ if(!it || NO_MARKER[it.type]) return; const name=legendName(it.label); if(!name) return;
      rows.push({id:it.id, name, i, y:Math.round(((+it.y||0)+(+it.height||0)/2)*100)/100, x:Math.round(((+it.x||0)+(+it.width||0)/2)*100)/100}); });
    rows.sort((a,b)=>a.y-b.y || a.x-b.x || (a.name<b.name?-1:a.name>b.name?1:0) || a.i-b.i);
    const byName=new Map(), legend=[], byId=new Map();
    rows.forEach(r=>{ let L=byName.get(r.name); if(!L){ L={n:legend.length+1, name:r.name, count:0}; byName.set(r.name,L); legend.push(L); }
      L.count++; if(r.id!=null) byId.set(r.id, L.n); });
    return { legend, byId };
  }
  /* place round badges (radius r px) at their anchors without overlap: same-number badges closer than
     `dupDist` (default 2.5r) to one already shown are dropped, the rest are pushed apart by iterative
     pairwise repulsion and kept inside [0,w]x[0,h]. anchors: [{x,y,n}]. Returns [{x,y,ax,ay,n,i}]. */
  function layoutBadges(anchors, r, bounds, o){
    o=o||{}; const gap=o.gap!=null?o.gap:Math.max(1,r*0.15), dup=o.dupDist!=null?o.dupDist:2.5*r, minD=2*r+gap;
    const W=bounds&&bounds.w||Infinity, H=bounds&&bounds.h||Infinity;
    const B=[];
    (anchors||[]).forEach((a,i)=>{ if(!isFinite(a.x)||!isFinite(a.y)) return;
      if(B.some(b=>b.n===a.n && Math.hypot(b.ax-a.x,b.ay-a.y)<dup)) return;
      B.push({x:a.x, y:a.y, ax:a.x, ay:a.y, n:a.n, i}); });
    const clamp=b=>{ b.x=Math.min(Math.max(b.x,r+1),W-r-1); b.y=Math.min(Math.max(b.y,r+1),H-r-1); };
    B.forEach(clamp);
    for(let it=0; it<400; it++){
      let moved=false;
      for(let i=0;i<B.length;i++) for(let j=i+1;j<B.length;j++){
        const p=B[i], q=B[j]; let dx=q.x-p.x, dy=q.y-p.y, d=Math.hypot(dx,dy);
        if(d>=minD) continue;
        if(d<1e-6){ const ang=(i*2.399+j*0.7); dx=Math.cos(ang); dy=Math.sin(ang); d=1; } else { dx/=d; dy/=d; }
        const push=(minD-d)/2+0.01;
        p.x-=dx*push; p.y-=dy*push; q.x+=dx*push; q.y+=dy*push; clamp(p); clamp(q); moved=true; }
      if(!moved) break;
    }
    return B;
  }
  // legend panel geometry: rows of (badge + "Name ×count"), one column, or two when they would not fit.
  // Returns {cols, rowH, font, badgeR, colW, rows:[{x,y,n,text}]} relative to the panel's top-left.
  function legendLayout(legend, panelW, panelH, o){
    o=o||{}; const pad=o.pad||Math.round(panelW*0.07), titleH=o.titleH||Math.round(panelH*0.075);
    const avail=panelH-titleH-pad*1.5, n=(legend||[]).length;
    let cols=1, rowH=Math.min(Math.round(panelH*0.05), 54);
    const minRow=Math.max(16, Math.round(panelH*0.026));
    if(n*rowH>avail){ rowH=Math.max(minRow, Math.floor(avail/n)); if(n*rowH>avail){ cols=2; rowH=Math.min(Math.round(panelH*0.05), Math.max(minRow, Math.floor(avail/Math.ceil(n/2)))); } }
    const perCol=cols===1?n:Math.ceil(n/2), font=Math.max(10, Math.round(rowH*0.46)), badgeR=Math.round(rowH*0.3);
    const colW=(panelW-pad*2-(cols-1)*pad*0.5)/cols, maxRows=Math.max(1,Math.floor(avail/rowH));
    const maxChars=Math.max(4, Math.floor((colW-badgeR*2-font*0.8)/(font*0.56)));
    const rows=[];
    (legend||[]).forEach((L,k)=>{ const c=Math.floor(k/perCol), r=k%perCol; if(r>=maxRows) return;
      let t=L.name; const suf=L.count>1?' ×'+L.count:'';
      if(t.length+suf.length>maxChars) t=t.slice(0,Math.max(1,maxChars-suf.length-1))+'…';
      rows.push({x:pad+c*(colW+pad*0.5), y:titleH+pad*0.5+r*rowH, n:L.n, text:t+suf}); });
    return {cols, rowH, font, badgeR, colW, pad, titleH, rows, truncated:rows.length<n};
  }
  // canvas drawing (browser only): a dark disc, white bold number, thin white ring
  function drawBadge(ctx, x, y, r, n){
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fillStyle='#1b2236'; ctx.fill();
    ctx.lineWidth=Math.max(1.2,r*0.14); ctx.strokeStyle='#ffffff'; ctx.stroke();
    const s=String(n); ctx.fillStyle='#ffffff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='700 '+Math.round(r*(s.length>2?0.85:s.length>1?1.0:1.15))+'px system-ui,-apple-system,"Segoe UI",sans-serif';
    ctx.fillText(s, x, y+r*0.05);
  }
  function drawBadges(ctx, placed, r){
    ctx.save(); ctx.lineWidth=Math.max(1,r*0.12); ctx.strokeStyle='rgba(27,34,54,.75)';
    placed.forEach(b=>{ if(Math.hypot(b.x-b.ax,b.y-b.ay)>r*0.9){ ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(b.ax,b.ay); ctx.stroke();
      ctx.beginPath(); ctx.arc(b.ax,b.ay,Math.max(1.5,r*0.18),0,Math.PI*2); ctx.fillStyle='#1b2236'; ctx.fill(); } });
    placed.forEach(b=>drawBadge(ctx,b.x,b.y,r,b.n)); ctx.restore();
  }
  function drawLegend(ctx, legend, x0, y0, w, h){
    const Lo=legendLayout(legend, w, h);
    ctx.save(); ctx.fillStyle='#f7f8fb'; ctx.fillRect(x0,y0,w,h);
    ctx.fillStyle='#d9dde6'; ctx.fillRect(x0,y0,Math.max(1,Math.round(h*0.002)),h);
    ctx.fillStyle='#1b2236'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.font='700 '+Math.round(Lo.titleH*0.42)+'px system-ui,-apple-system,"Segoe UI",sans-serif';
    ctx.fillText('Legend', x0+Lo.pad, y0+Lo.titleH*0.6);
    Lo.rows.forEach(R=>{ drawBadge(ctx, x0+R.x+Lo.badgeR, y0+R.y+Lo.rowH/2, Lo.badgeR, R.n);
      ctx.fillStyle='#262c3a'; ctx.textAlign='left'; ctx.textBaseline='middle';
      ctx.font='500 '+Lo.font+'px system-ui,-apple-system,"Segoe UI",sans-serif';
      ctx.fillText(R.text, x0+R.x+Lo.badgeR*2+Lo.font*0.6, y0+R.y+Lo.rowH/2); });
    ctx.restore(); return Lo;
  }

  /* label modes for the client pictures + live 3D view: 'none' (plain), 'numbers' (badges + legend,
     the default and the original pictures), 'names' (small name tags, no legend). */
  const LABEL_MODES=['none','numbers','names'];
  function labelMode(v){ v=String(v==null?'':v).toLowerCase(); return LABEL_MODES.indexOf(v)>=0 ? v : 'numbers'; }
  // booklet snapshot kind for a picture ('2d'|'3d') in a label mode; numbers keeps the original kind
  function snapKind(base, mode){ base=base==='3d'?'3d':'2d'; mode=labelMode(mode); return mode==='numbers' ? base : base+'_'+mode; }
  /* name tags: one tag per anchor (same text closer than dupDist to a kept tag is dropped), each a
     w x h box centred on its anchor, pushed apart until no two boxes overlap (gap px) and kept
     inside [0,W]x[0,H]. anchors: [{x,y,text,w,h}]. Returns [{x,y,ax,ay,w,h,text}]. */
  function layoutTags(anchors, bounds, o){
    o=o||{}; const gap=o.gap!=null?o.gap:2, W=bounds&&bounds.w||Infinity, H=bounds&&bounds.h||Infinity;
    const T=[];
    (anchors||[]).forEach(a=>{ if(!a || !isFinite(a.x) || !isFinite(a.y) || !(a.w>0) || !(a.h>0)) return;
      const dup=o.dupDist!=null?o.dupDist:a.w*0.75;
      if(T.some(t=>t.text===a.text && Math.hypot(t.ax-a.x,t.ay-a.y)<dup)) return;
      T.push({x:a.x, y:a.y, ax:a.x, ay:a.y, w:a.w, h:a.h, text:String(a.text==null?'':a.text)}); });
    const clamp=t=>{ t.x=Math.min(Math.max(t.x,t.w/2+1),Math.max(t.w/2+1,W-t.w/2-1)); t.y=Math.min(Math.max(t.y,t.h/2+1),Math.max(t.h/2+1,H-t.h/2-1)); };
    T.forEach(clamp);
    for(let it=0; it<500; it++){
      let moved=false;
      for(let i=0;i<T.length;i++) for(let j=i+1;j<T.length;j++){
        const p=T[i], q=T[j];
        const ox=(p.w+q.w)/2+gap-Math.abs(q.x-p.x), oy=(p.h+q.h)/2+gap-Math.abs(q.y-p.y);
        if(ox<=0 || oy<=0) continue;
        // separate along the axis that needs the smaller move (vertical preferred for wide tags)
        if(oy<=ox){ let d=q.y-p.y; const s=d>0?1:d<0?-1:((i+j)%2?1:-1); p.y-=s*(oy/2+0.01); q.y+=s*(oy/2+0.01); }
        else { let d=q.x-p.x; const s=d>0?1:d<0?-1:((i+j)%2?1:-1); p.x-=s*(ox/2+0.01); q.x+=s*(ox/2+0.01); }
        clamp(p); clamp(q); moved=true; }
      if(!moved) break;
    }
    return T;
  }
  function tagFont(px){ return '600 '+Math.round(px)+'px system-ui,-apple-system,"Segoe UI",sans-serif'; }
  // measure + place + draw name tags (browser). anchors: [{x,y,text}]; px = font size (uniform)
  function drawNameTags(ctx, anchors, px, bounds){
    ctx.save(); ctx.font=tagFont(px);
    const padX=Math.round(px*0.5), h=Math.round(px*1.6);
    const sized=(anchors||[]).map(a=>{ const text=legendName(a.text).slice(0,28); return text ? {x:a.x, y:a.y, text, h, w:Math.ceil(ctx.measureText(text).width)+padX*2} : null; }).filter(Boolean);
    const placed=layoutTags(sized, bounds, {gap:Math.max(2,Math.round(px*0.2))});
    ctx.lineWidth=Math.max(1,px*0.08); ctx.strokeStyle='rgba(27,34,54,.6)';
    placed.forEach(t=>{ if(Math.hypot(t.x-t.ax,t.y-t.ay)>t.h*0.8){ ctx.beginPath(); ctx.moveTo(t.x,t.y); ctx.lineTo(t.ax,t.ay); ctx.stroke(); } });
    placed.forEach(t=>{ const x=t.x-t.w/2, y=t.y-t.h/2, r=Math.round(t.h*0.3);
      ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+t.w,y,x+t.w,y+t.h,r); ctx.arcTo(x+t.w,y+t.h,x,y+t.h,r); ctx.arcTo(x,y+t.h,x,y,r); ctx.arcTo(x,y,x+t.w,y,r); ctx.closePath();
      ctx.fillStyle='rgba(20,27,46,.86)'; ctx.fill();
      ctx.fillStyle='#ffffff'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(t.text, t.x, t.y+px*0.04); });
    ctx.restore(); return placed;
  }
  // final image split: render area on the left (~80%), legend panel on the right
  function legendSplit(W){ const panel=Math.round(W*0.2); return {renderW:W-panel, panelW:panel}; }
  const api={ labelMode, snapKind, LABEL_MODES, layoutTags, drawNameTags, numberItems, layoutBadges, legendLayout, drawBadge, drawBadges, drawLegend, legendSplit, frameBox, projectBox, labelWorldHeight, labelScaleForDepth, unionFloor, pickLabels, LABEL_CAP_RATIO };
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.HelmCaptureFrame=api;
})(typeof window!=='undefined'?window:globalThis);
