/* Control Center split (preview): groups the existing cards into sub-pages with a left
 * sub-nav, a settings search, and #section deep links. Layout-only: it never changes
 * a setting, never removes an element, and never touches the `hidden` attribute that
 * the page's own JS uses for permissions. It drives the existing tab buttons. */
(function(){
  "use strict";
  var app=document.getElementById("app"); if(!app) return;
  // icon paths (24x24, stroke) drawn with the DOM API, no HTML strings
  var IC={
    home:"M3 11l9-7 9 7M5 10v10h14V10",
    card:"M3 6h18v12H3zM3 10h18",
    link:"M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1",
    tag:"M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
    menu:"M4 6h16M4 12h16M4 18h10",
    grid:"M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    upload:"M12 16V4M7 9l5-5 5 5M4 20h16",
    users:"M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6",
    key:"M15 7a4 4 0 1 1-3.9 5H3v4h3v-2h3v-2h2.1A4 4 0 0 1 15 7z",
    shield:"M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
    bell:"M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0",
    clock:"M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
    image:"M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01",
    pin:"M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    layout:"M3 3h18v18H3zM3 9h18M9 9v12"
  };
  var SECTIONS=[
    {key:"general",  group:"Workspace",  label:"General",                icon:"home",  hash:"#general",       desc:"Studio name, country and tax, contact details, billing address and your client link name.", kw:"studio account organization business logo accent currency timezone gst gstin address demo trial slug"},
    {key:"billing",  group:"Workspace",  label:"Plan & billing",         icon:"card",  hash:"#billing",       desc:"Your Helm subscription, plan and invoices.", kw:"subscription plan invoice trial upgrade"},
    {key:"links",    group:"Workspace",  label:"Client links & packages",icon:"link",  hash:"#client-links",  desc:"How long client links stay open and how clients choose a package.", kw:"expire expiry auto-expire link security package flow booklet"},
    {key:"pricing",  group:"Sales",      label:"Pricing & coupons",      icon:"tag",   hash:"#pricing",       desc:"Default pricing for new quotes, rate cards, builder prices and limits, and coupons.", kw:"price tax discount rate card coupon capacity object"},
    {key:"catalog",  group:"Sales",      label:"Menus & catalog",        icon:"menu",  hash:"#menu",          desc:"Chairs, plates, dishes and the menu packages clients pick from.", kw:"chair plate dish catering menu package standard gold premium"},
    {key:"rules",    group:"Sales",      label:"Layout rules",           icon:"grid",  hash:"#layout-rules",  desc:"What the layout generator uses for each event type.", kw:"seats guests buffet bar generator event type layout reminders"},
    {key:"data",     group:"Sales",      label:"Import & custom fields", icon:"upload",hash:"#data",          desc:"Bring catalogues and clients in from Excel, and add your own fields.", kw:"excel import xlsx csv custom field"},
    {key:"users",    group:"People",     label:"Users & invites",        icon:"users", hash:"#users",         desc:"Add teammates, change roles and send join links.", kw:"team member invite role user add remove"},
    {key:"access",   group:"People",     label:"Roles & access",         icon:"key",   hash:"#access",        desc:"Choose what each role can see and edit.", kw:"access matrix permission role view edit rbac"},
    {key:"compliance",group:"People",    label:"Data & compliance",      icon:"shield",hash:"#compliance",    desc:"Download a portable archive of your studio's data.", kw:"gdpr dpdp export archive download privacy security"},
    {key:"notify",   group:"Communication",label:"Notifications",        icon:"bell",  hash:"#notifications", desc:"Who on the team hears about what, in the bell and by text or e-mail, plus per-person overrides.", kw:"bell notification sms email override mute alert"},
    {key:"reminders",group:"Communication",label:"Reminders & client messages",icon:"clock",hash:"#reminders",desc:"Event reminders for the team, payment reminders and follow-ups for clients, stock warnings and WhatsApp forwarding.", kw:"event reminder payment reminder client follow-up follow up whatsapp inventory stock automatic message"},
    {key:"renders",  group:"Communication",label:"Photo renders",        icon:"image", hash:"#renders",       desc:"Monthly limits for photo-realistic renders from the builder.", kw:"render photo quota image"},
    {key:"venues",   group:"Operations", label:"Venues",                 icon:"pin",   hash:"#venues",        desc:"Halls and spaces you work in, with usable area and capacity.", kw:"venue hall space"},
    {key:"ltemplates",group:"Operations",label:"Layout templates",       icon:"layout",hash:"#layout-templates",desc:"Reusable floor layouts your team can start a design from.", kw:"template floor layout"}
  ];
  function setHash(h){ try{ history.replaceState(null,"",location.pathname+location.search+h); }catch(e){} }
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
  var BYKEY={}, SECHASH={}, HASH={}; SECTIONS.forEach(function(x){ BYKEY[x.key]=x; SECHASH[x.key]=x.hash; HASH[x.hash]=x.key; });
  // legacy deep links (dashboard checklist, old bookmarks) -> section
  Object.assign(HASH,{"#account":"general","#studio":"general","#team":"users","#notify":"notify","#security":"links","#link-expiry":"links","#pricing-packages":"pricing","#catalog":"catalog","#event-reminders":"reminders","#client-reminders":"reminders","#payment-reminders":"reminders","#whatsapp":"reminders"});
  var OLDKEY={studio:"general",team:"users",security:"links"};
  function h3(c){ var h=c.querySelector("h3"); return h?h.textContent.trim():""; }
  function paneKey(c){ var p=c.closest("[id^='pane-']"); return p?p.id.slice(5):""; }
  function classify(c){
    var id=c.id||"", t=h3(c).toLowerCase(), pane=paneKey(c);
    if(id==="accCard"||id==="tdControl"||c.querySelector("#o_name")) return "general";
    if(id==="subCard") return "billing";
    if(id==="lxCard"||id==="pkgFlowCard") return "links";
    if(id==="menuCard"||/chair types|plate types|dishes catalog/.test(t)) return "catalog";
    if(/default layout rules/.test(t)) return "rules";
    if(id==="cfCard"||/import from excel/.test(t)) return "data";
    if(c.classList.contains("compliance")) return "compliance";
    if(/^access control/.test(t)) return "access";
    if(id==="evrCard"||id==="commsCard") return "reminders";
    if(id==="prCard") return "renders";
    if(pane==="users") return "users";
    if(pane==="notify") return "notify";
    if(pane==="venues"||pane==="ltemplates") return pane;
    return "pricing";
  }
  var PANES=["pricing","users","notify","venues","ltemplates"], paneEls=[];
  var cards=[];
  function collect(){
    var added=false;
    paneEls.forEach(function(pane){
      Array.prototype.forEach.call(pane.querySelectorAll(".card"),function(c){
        if(c.parentElement.closest(".card")||cards.indexOf(c)>=0) return;
        var s=classify(c); c.setAttribute("data-cs-sec",s); BYKEY[s].pane=BYKEY[s].pane||paneKey(c); cards.push(c); added=true;
      });
    });
    return added;
  }
  PANES.forEach(function(p){ var e=document.getElementById("pane-"+p); if(e) paneEls.push(e); });
  collect();
  // a section's pane is where its cards live (fallbacks for sections whose cards arrive later)
  SECTIONS.forEach(function(x){ if(!x.pane) x.pane=({reminders:"notify",renders:"notify",notify:"notify",users:"users",access:"users",compliance:"users",venues:"venues",ltemplates:"ltemplates"})[x.key]||"pricing"; });

  // ---- layout: aside + main wrapper (moves nodes; ids/listeners intact) ----
  var main=document.createElement("div"); main.className="cs-main";
  while(app.firstChild) main.appendChild(app.firstChild);
  var aside=document.createElement("aside"); aside.className="cs-aside"; aside.setAttribute("aria-label","Settings sections");
  var sw=el("div","cs-search"), lab=el("label","sr-only","Search settings"); lab.htmlFor="csSearch";
  var qi=el("input"); qi.id="csSearch"; qi.type="search"; qi.placeholder="Search settings"; qi.autocomplete="off";
  qi.setAttribute("aria-controls","csResults"); qi.setAttribute("aria-keyshortcuts","Control+K Meta+K /");
  var mac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent||"");
  var rl=el("div","cs-results"); rl.id="csResults"; rl.setAttribute("role","listbox"); rl.hidden=true;
  sw.appendChild(lab); sw.appendChild(el("span","cs-search-ico")); sw.appendChild(qi); sw.appendChild(el("kbd","cs-kbd",mac?"\u2318K":"Ctrl K")); sw.appendChild(rl);
  var mlab=el("label","sr-only","Settings section"); mlab.htmlFor="csMnav";
  var msel=el("select","cs-mnav"); msel.id="csMnav";
  var nv=el("nav","cs-nav"); nv.id="csNav"; nv.setAttribute("aria-label","Settings");
  aside.appendChild(sw); aside.appendChild(mlab); aside.appendChild(msel); aside.appendChild(nv);
  // page header, empty state and unsaved-changes bar live in the main column
  var head=el("div","cs-head"), hT=el("h2",null,""), hD=el("p",null,""); head.appendChild(hT); head.appendChild(hD);
  main.insertBefore(head, main.firstChild);
  var empty=el("div","cs-empty","Nothing to set here for your role."); empty.hidden=true; main.appendChild(empty);
  var bar=el("div","cs-savebar"); bar.hidden=true; bar.setAttribute("role","status");
  var barTxt=el("span"), bDis=el("button","cs-ghost","Dismiss"), bGo=el("button","cs-primary","Go to Save");
  bDis.type="button"; bGo.type="button";
  bar.appendChild(el("i","cs-dot")); bar.appendChild(barTxt); bar.appendChild(bDis); bar.appendChild(bGo); main.appendChild(bar);
  var tabs=main.querySelector(".tabs"); if(tabs) app.appendChild(tabs);
  app.appendChild(aside); app.appendChild(main); app.classList.add("cs-on");
  var nav=aside.querySelector("#csNav"), q=aside.querySelector("#csSearch"), res=aside.querySelector("#csResults");

  function tabFor(pane){ return document.getElementById("tab-"+pane); }
  function available(s){ var t=tabFor(s.pane); return !!t && !t.hidden; }
  var current=null, wanted=null;
  var SVGNS="http://www.w3.org/2000/svg";
  function icon(name){
    var sv=document.createElementNS(SVGNS,"svg"); sv.setAttribute("viewBox","0 0 24 24"); sv.setAttribute("aria-hidden","true"); sv.setAttribute("class","cs-ico");
    var pa=document.createElementNS(SVGNS,"path"); pa.setAttribute("d",IC[name]||IC.home); sv.appendChild(pa); return sv;
  }
  function drawNav(){
    nav.textContent=""; msel.textContent="";
    var g=null, og=null;
    SECTIONS.forEach(function(s){
      if(!available(s)) return;
      if(s.group!==(g&&g.dataset.g)){
        g=el("div","cs-group"); g.dataset.g=s.group; g.appendChild(el("h4","cs-group-h",s.group)); nav.appendChild(g);
        og=document.createElement("optgroup"); og.label=s.group; msel.appendChild(og);
      }
      var a=el("a"); a.appendChild(icon(s.icon)); a.appendChild(el("span",null,s.label)); a.href=location.pathname+SECHASH[s.key]; a.dataset.sec=s.key;
      if(s.key===current) a.setAttribute("aria-current","page");
      g.appendChild(a);
      var o=el("option",null,s.label); o.value=s.key; if(s.key===current) o.selected=true; og.appendChild(o);
    });
  }
  msel.addEventListener("change",function(){ var k=msel.value; wanted=k; setHash(SECHASH[k]); show(k); });
  function show(key, opts){
    var s=BYKEY[key]; if(!s) return;
    if(!available(s)) s=BYKEY.general, key="general";
    if(current!==key){ clearTimeout(emptyTimer); emptyTimer=null; }
    current=key;
    var t=tabFor(s.pane); if(t && !t.classList.contains("active")) t.click();
    cards.forEach(function(c){ c.classList.toggle("cs-off", c.getAttribute("data-cs-sec")!==key); });
    hT.textContent=s.label; hD.textContent=s.desc; main.setAttribute("data-cs-cur",key); refreshEmpty();
    drawNav(); clearHL();
    try{ localStorage.setItem("helm.cs.sec",key); }catch(e){}
    if(!(opts&&opts.noScroll)){ try{ main.scrollIntoView({block:"start"}); }catch(e){} }
  }
  // empty state: every card of this section is hidden (role-gated, or still loading)
  var emptyTimer=null;
  function setText(n,t){ if(n.textContent!==t) n.textContent=t; }
  function refreshEmpty(){
    var vis=cards.some(function(c){ return c.getAttribute("data-cs-sec")===current && !c.hidden; });
    if(empty.hidden!==vis) empty.hidden=vis;
    if(vis){ clearTimeout(emptyTimer); emptyTimer=null; return; }
    if(emptyTimer) return;
    setText(empty,"Loading\u2026");
    emptyTimer=setTimeout(function(){ setText(empty,"Nothing to set here yet. This section opens for studio admins, or once your studio has this feature switched on."); },4000);
  }
  // cards added later (event reminders, demo card...) or revealed by their own scripts
  new MutationObserver(function(muts){
    var add=collect();
    if(add && current) cards.forEach(function(c){ c.classList.toggle("cs-off", c.getAttribute("data-cs-sec")!==current); });
    if(current) refreshEmpty();
  }).observe(app,{subtree:true,childList:true,attributes:true,attributeFilter:["hidden"]});
  nav.addEventListener("click",function(e){
    var a=e.target.closest("a[data-sec]"); if(!a) return;
    e.preventDefault(); wanted=a.dataset.sec; setHash(SECHASH[a.dataset.sec]); show(a.dataset.sec);
  });
  function fromHash(){ var k=HASH[location.hash]; if(k){ show(k,{noScroll:true}); return true; } return false; }
  window.addEventListener("hashchange",fromHash);

  // ---- settings search ----
  function entries(){
    var out=[];
    cards.forEach(function(c){
      var sec=c.getAttribute("data-cs-sec"), s=BYKEY[sec]; if(!s||!available(s)) return;
      if(c.hidden && paneKey(c)!=="notify") return;   // notify-pane cards load on first open: still searchable
      var title=h3(c)||c.getAttribute("aria-label")||s.label;
      out.push({el:c,card:c,text:title,sec:sec,title:title});
      Array.prototype.forEach.call(c.querySelectorAll("label, h3, h4, legend, summary, .nt, .cmlbl, th[scope=row]"),function(l){
        var tx=l.textContent.replace(/\s+/g," ").trim(); if(!tx||tx===title||tx.length>90) return;
        out.push({el:l,card:c,text:tx,sec:sec,title:title});
      });
    });
    // every section by name, description and keywords (covers rows that load on first open)
    SECTIONS.forEach(function(s){ if(!available(s)) return; out.push({el:null,card:null,text:s.label,sec:s.key,title:s.label,extra:s.desc+" "+s.kw}); });
    return out;
  }
  function norm(s){ return s.toLowerCase().normalize("NFKD").replace(/[^\w\s]/g," "); }
  function search(){
    var v=norm(q.value).trim(); res.textContent="";
    if(!v){ res.hidden=true; return; }
    var words=v.split(/\s+/), seen=new Set(), hits=[];
    entries().forEach(function(e){
      var hay=norm(e.text+" "+e.title+" "+BYKEY[e.sec].label+" "+(e.extra||""));
      if(words.every(function(w){ return hay.indexOf(w)>=0; })){ var k=e.text+"|"+e.title; if(!seen.has(k)){ seen.add(k); hits.push(e); } }
    });
    function score(e){ var t=norm(e.text), ti=norm(e.title); return (t.indexOf(v)===0?0:t.indexOf(v)>0?1:ti.indexOf(v)>=0?2:3)+(e.extra?0.5:0)+(e.el===e.card&&e.card?-0.25:0); }
    hits.forEach(function(e,i){ e._s=score(e); e._i=i; });
    hits.sort(function(a,b){ return a._s-b._s || a._i-b._i; });
    hits.slice(0,25).forEach(function(e){
      var b=document.createElement("button"); b.type="button"; b.setAttribute("role","option");
      mark(b,e.text,words); var sm=document.createElement("small"); sm.textContent=BYKEY[e.sec].label+(e.text!==e.title?" › "+e.title:""); b.appendChild(sm);
      b.addEventListener("click",function(){ jump(e); });
      res.appendChild(b);
    });
    if(!hits.length){ var d=document.createElement("div"); d.className="cs-none"; d.textContent="No matching settings"; res.appendChild(d); }
    res.hidden=false;
  }
  function mark(node,text,words){
    var low=norm(text), ranges=[];
    words.forEach(function(w){ var i=low.indexOf(w); if(i>=0) ranges.push([i,i+w.length]); });
    ranges.sort(function(a,b){return a[0]-b[0];}); var pos=0;
    ranges.forEach(function(r){ if(r[0]<pos) return; node.appendChild(document.createTextNode(text.slice(pos,r[0]))); node.appendChild(el("mark",null,text.slice(r[0],r[1]))); pos=r[1]; });
    node.appendChild(document.createTextNode(text.slice(pos)));
  }
  var hasHL=typeof CSS!=="undefined" && CSS.highlights && typeof Highlight==="function";
  function clearHL(){ if(hasHL) CSS.highlights.delete("cs-hit"); }
  function highlightIn(root,words){
    if(!hasHL||!words.length) return; clearHL();
    var hl=new Highlight(), tw=document.createTreeWalker(root,NodeFilter.SHOW_TEXT), n;
    while((n=tw.nextNode())){
      var t=n.nodeValue.toLowerCase();
      words.forEach(function(w){ var i=t.indexOf(w); if(i>=0){ var r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+w.length); hl.add(r); } });
    }
    CSS.highlights.set("cs-hit",hl); setTimeout(clearHL,4000);
  }
  function jump(e){
    var words=norm(q.value).trim().split(/\s+/).filter(Boolean);
    res.hidden=true; q.value="";
    setHash(SECHASH[e.sec]); show(e.sec,{noScroll:true});
    if(!e.el){ try{ main.scrollIntoView({block:"start",behavior:"smooth"}); }catch(x){} return; }
    var el=e.el, target=el;
    if(el.tagName==="LABEL" && el.htmlFor){ var f=document.getElementById(el.htmlFor); if(f) target=f; }
    setTimeout(function(){
      try{ el.scrollIntoView({block:"center",behavior:"smooth"}); }catch(x){}
      highlightIn(e.card,words);
      var box=e.card; box.classList.add("cs-flash"); setTimeout(function(){ box.classList.remove("cs-flash"); },1600);
      if(target!==el && target.focus){ try{ target.focus({preventScroll:true}); }catch(x){} }
    },60);
  }
  q.addEventListener("input",search);
  q.addEventListener("keydown",function(e){
    if(e.key==="Escape"){ q.value=""; res.hidden=true; }
    if(e.key==="Enter"){ var b=res.querySelector("button"); if(b){ e.preventDefault(); b.click(); } }
    if(e.key==="ArrowDown"){ var f=res.querySelector("button"); if(f){ e.preventDefault(); f.focus(); } }
  });
  res.addEventListener("keydown",function(e){
    var b=document.activeElement; if(!b||b.parentElement!==res) return;
    if(e.key==="ArrowDown"&&b.nextElementSibling){ e.preventDefault(); b.nextElementSibling.focus(); }
    if(e.key==="ArrowUp"){ e.preventDefault(); (b.previousElementSibling||q).focus(); }
  });
  document.addEventListener("click",function(e){ if(!aside.contains(e.target)) res.hidden=true; });
  document.addEventListener("keydown",function(e){ if((e.metaKey||e.ctrlKey) && (e.key==="k"||e.key==="K") && !app.hidden){ e.preventDefault(); q.focus(); q.select(); } });
  document.addEventListener("keydown",function(e){ if(e.key==="/" && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||"") && !app.hidden){ e.preventDefault(); q.focus(); } });

  // ---- unsaved-changes bar: shows only after the user edits a field in a card ----
  var dirty=null;
  function cardOf(t){ var c=t&&t.closest&&t.closest("[data-cs-sec]"); return c&&cards.indexOf(c)>=0?c:null; }
  function saveBtn(c){ var bs=c.querySelectorAll("button"); for(var i=0;i<bs.length;i++){ if(/^\s*save\b/i.test(bs[i].textContent)&&!bs[i].hidden) return bs[i]; } return null; }
  function onEdit(e){
    if(!e.isTrusted) return; var t=e.target; if(!t||!/INPUT|SELECT|TEXTAREA/.test(t.tagName)||t===q||t===msel) return;
    var c=cardOf(t); if(!c||!saveBtn(c)) return;
    dirty=c; barTxt.textContent="Unsaved changes in "+(h3(c)||"this section"); bar.hidden=false;
  }
  main.addEventListener("input",onEdit); main.addEventListener("change",onEdit);
  main.addEventListener("click",function(e){ var b=e.target.closest&&e.target.closest("button"); if(b&&dirty&&dirty.contains(b)&&/^\s*save\b/i.test(b.textContent)){ dirty=null; bar.hidden=true; } });
  bDis.addEventListener("click",function(){ dirty=null; bar.hidden=true; });
  bGo.addEventListener("click",function(){ if(!dirty) return; var b=saveBtn(dirty); if(!b) return;
    if(dirty.classList.contains("cs-off")) show(dirty.getAttribute("data-cs-sec"),{noScroll:true});
    try{ b.scrollIntoView({block:"center",behavior:"smooth"}); }catch(x){} try{ b.focus({preventScroll:true}); }catch(x){}
    dirty.classList.add("cs-flash"); var d=dirty; setTimeout(function(){ d.classList.remove("cs-flash"); },1600); });

  // tabs are revealed asynchronously by role checks: redraw the nav when that happens
  if(tabs) new MutationObserver(function(){ drawNav(); if(current && !available(BYKEY[current])) show("general",{noScroll:true}); else if(!fromHash() && wanted && wanted!==current && available(BYKEY[wanted])) show(wanted,{noScroll:true}); })
    .observe(tabs,{subtree:true,attributes:true,attributeFilter:["hidden"]});

  var start="general"; try{ var st=localStorage.getItem("helm.cs.sec"); st=OLDKEY[st]||st; if(st&&BYKEY[st]) start=st; }catch(e){}
  wanted=HASH[location.hash]||start;
  if(!fromHash()) show(start,{noScroll:true});
})();
