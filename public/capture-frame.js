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
  const api={ frameBox, projectBox, labelWorldHeight };
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.HelmCaptureFrame=api;
})(typeof window!=='undefined'?window:globalThis);
