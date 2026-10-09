/* Camera framing for the client 3D capture: given an axis-aligned bounding box of the scene's
   objects, place a perspective camera on a fixed elevated three-quarter direction so the box
   fills `fill` (e.g. 0.85) of the frame. Pure math (no THREE) so it is unit-testable in node. */
(function(root){
  function frameBox(box, o){
    o=o||{}; const fovV=(o.fovDeg||48)*Math.PI/180, aspect=o.aspect||16/9, fill=o.fill||0.85;
    const el=(o.elevationDeg!=null?o.elevationDeg:38)*Math.PI/180, az=(o.azimuthDeg!=null?o.azimuthDeg:35)*Math.PI/180;
    const c=[(box.min[0]+box.max[0])/2,(box.min[1]+box.max[1])/2,(box.min[2]+box.max[2])/2];
    // unit vector from target towards the camera (front-right, raised)
    const dir=[Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az)];
    // camera basis: forward = -dir; right = forward x up(0,1,0); up = right x forward
    const f=[-dir[0],-dir[1],-dir[2]];
    let r=[-f[2],0,f[0]]; const rl=Math.hypot(r[0],r[2])||1; r=[r[0]/rl,0,r[2]/rl];
    const u=[r[1]*f[2]-r[2]*f[1], r[2]*f[0]-r[0]*f[2], r[0]*f[1]-r[1]*f[0]];
    const tanV=Math.tan(fovV/2)*fill, tanH=Math.tan(fovV/2)*aspect*fill;
    let d=0;
    for(let i=0;i<8;i++){
      const p=[(i&1?box.max[0]:box.min[0])-c[0],(i&2?box.max[1]:box.min[1])-c[1],(i&4?box.max[2]:box.min[2])-c[2]];
      const pd=p[0]*dir[0]+p[1]*dir[1]+p[2]*dir[2];        // toward camera → closer
      const pr=Math.abs(p[0]*r[0]+p[2]*r[2]), pu=Math.abs(p[0]*u[0]+p[1]*u[1]+p[2]*u[2]);
      d=Math.max(d, pd+pr/tanH, pd+pu/tanV);
    }
    d=Math.max(d, o.minDist||1);
    return { target:c, position:[c[0]+dir[0]*d, c[1]+dir[1]*d, c[2]+dir[2]*d], distance:d, dir };
  }
  const api={ frameBox };
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.HelmCaptureFrame=api;
})(typeof window!=='undefined'?window:globalThis);
