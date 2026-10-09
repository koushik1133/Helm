/* Friendly wording for audit-log "update" diffs (no raw JSON for known fields).
   Pure: returns [{text}] lines; the caller escapes. Works in browser (window.AuditFormat) and node. */
(function(root){
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function inr(n){ n=Number(n); if(!isFinite(n)) return '—';
    const neg=n<0; n=Math.round(Math.abs(n)); const s=n.toLocaleString('fullwide',{useGrouping:false,maximumFractionDigits:0});
    let out=s; if(s.length>3){ const last=s.slice(-3); let rest=s.slice(0,-3); const parts=[];
      while(rest.length>2){ parts.unshift(rest.slice(-2)); rest=rest.slice(0,-2); } if(rest) parts.unshift(rest);
      out=parts.join(',')+','+last; }
    return (neg?'-':'')+'₹'+out; }
  function humanize(k){ const s=String(k||'').replace(/[_\.]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').trim().toLowerCase();
    return s ? s[0].toUpperCase()+s.slice(1) : 'Field'; }
  function title(v){ return String(v==null?'':v).replace(/[_-]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase()); }
  function trunc(v,n){ n=n||60; let s; if(v==null||v==='') return '∅';
    if(typeof v==='object'){ try{ s=JSON.stringify(v); }catch{ s='…'; } } else s=String(v);
    return s.length>n ? s.slice(0,n-1)+'…' : s; }
  function fmtDate(v){ const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(v||'')); if(!m) return trunc(v);
    return (+m[3])+' '+MONTHS[+m[2]-1]+' '+m[1]; }
  function obj(v){ if(typeof v==='string'){ try{ v=JSON.parse(v); }catch{ return null; } } return v&&typeof v==='object'&&!Array.isArray(v)?v:null; }
  function num(x){ if(x==null||x==='') return null; const n=Number(x); return isFinite(n)?n:null; }
  function total(v){ const o=obj(v); if(o) return num(o.total!=null&&o.total!==''?o.total:(o.grand_total!=null&&o.grand_total!==''?o.grand_total:o.grandTotal)); return typeof v==='number'&&isFinite(v)?v:null; }
  const CLIENT_FIELDS={name:'name',phone:'phone',email:'email',city:'city',guests:'guests',company:'company',address:'address'};
  function describe(k,o,n){
    switch(k){
      case 'pricing': { const a=total(o), b=total(n);
        if(a==null&&b==null) return 'Pricing updated';
        if(a==null) return 'Total set to '+inr(b);
        if(b==null) return 'Pricing cleared';
        return a===b ? 'Pricing details updated (total '+inr(b)+')' : 'Total '+inr(a)+' → '+inr(b); }
      case 'client': { const a=obj(o)||{}, b=obj(n)||{};
        const hadName=!!a.name;
        if(!hadName && b.name) return 'Client set to '+trunc(b.name,40);
        const changed=Object.keys(Object.assign({},a,b)).filter(f=>JSON.stringify(a[f])!==JSON.stringify(b[f]));
        if(!changed.length) return 'Client details updated';
        const labels=changed.map(f=>CLIENT_FIELDS[f]||humanize(f).toLowerCase());
        return 'Client details changed: '+labels.slice(0,5).join(', ')+(labels.length>5?' +'+(labels.length-5)+' more':''); }
      case 'lifecycle_stage': case 'stage':
        return 'Stage: '+(o?title(o):'—')+' → '+(n?title(n):'—');
      case 'status':
        return 'Status: '+(o?title(o):'—')+' → '+(n?title(n):'—');
      case 'current_version': return 'Saved version '+trunc(n,10);
      case 'event_date': return n ? (o?'Event date changed from '+fmtDate(o)+' to '+fmtDate(n):'Event date set to '+fmtDate(n)) : 'Event date cleared';
      case 'event_type': return 'Event type: '+trunc(n,60);
      default: return humanize(k)+': '+trunc(o)+' → '+trunc(n);
    }
  }
  // changed: {key:[old,new]} or {key:new}
  function describeUpdate(changed, max){
    const c=changed||{}; max=max||5; const keys=Object.keys(c);
    const lines=keys.slice(0,max).map(k=>{ const p=c[k]; const o=Array.isArray(p)&&p.length===2?p[0]:null, n=Array.isArray(p)&&p.length===2?p[1]:p;
      return { key:k, text:describe(k,o,n) }; });
    return { lines, more:Math.max(0,keys.length-max) };
  }
  const api={ describeUpdate, describe, inr, humanize, trunc, fmtDate };
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.AuditFormat=api;
})(typeof window!=='undefined'?window:globalThis);
