/* Control Center split (preview): groups the existing cards into sub-pages with a left
 * sub-nav, a settings search, and #section deep links. Layout-only: it never changes
 * a setting, never removes an element, and never touches the `hidden` attribute that
 * the page's own JS uses for permissions. It drives the existing tab buttons. */
(function(){
  "use strict";
  var app=document.getElementById("app"); if(!app) return;
  var SECTIONS=[
    {key:"studio",   group:"Workspace",  label:"Studio & billing",        pane:"pricing",   desc:"Your studio profile, country and tax, subscription and invoices."},
    {key:"pricing",  group:"Workspace",  label:"Pricing & packages",      pane:"pricing",   desc:"Item prices, menu packages and the defaults new quotes start from."},
    {key:"data",     group:"Workspace",  label:"Data & import",           pane:"pricing",   desc:"Bring in catalogues and clients from Excel, and manage custom fields."},
    {key:"team",     group:"People",     label:"Team & access",           pane:"users",     desc:"Invite people, assign roles and choose what each role can see and do."},
    {key:"security", group:"People",     label:"Security & compliance",   pane:"users",     desc:"Link expiry, sign-in protection and data-protection settings."},
    {key:"notify",   group:"Operations", label:"Notifications & reminders",pane:"notify",   desc:"Who gets told about what, automatic messages and event reminders."},
    {key:"venues",   group:"Operations", label:"Venues",                  pane:"venues",    desc:"Halls and spaces you work in, with usable area and capacity."},
    {key:"ltemplates",group:"Operations",label:"Layout templates",        pane:"ltemplates",desc:"Reusable floor layouts your team can start a design from."}
  ];
  function setHash(h){ try{ history.replaceState(null,"",location.pathname+location.search+h); }catch(e){} }
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
  var BYKEY={}; SECTIONS.forEach(function(s){ BYKEY[s.key]=s; });
  // legacy + new deep links -> section (the card-level ones are scrolled by the page itself)
  var HASH={"#account":"studio","#pricing":"pricing","#menu":"pricing","#users":"team","#notifications":"notify",
            "#studio":"studio","#pricing-packages":"pricing","#data":"data","#team":"team","#security":"security",
            "#notify":"notify","#venues":"venues","#layout-templates":"ltemplates"};
  var SECHASH={studio:"#studio",pricing:"#pricing-packages",data:"#data",team:"#team",security:"#security",notify:"#notify",venues:"#venues",ltemplates:"#layout-templates"};

  function h3(c){ var h=c.querySelector("h3"); return h?h.textContent.trim():""; }
  function classify(c, pane){
    var id=c.id||"", t=h3(c).toLowerCase();
    if(pane==="pricing"){
      if(/^(accCard|tdControl|subCard)$/.test(id) || c.querySelector("#o_name")) return "studio";
      if(id==="cfCard" || /import from excel/.test(t)) return "data";
      return "pricing";
    }
    if(pane==="users"){
      if(id==="lxCard" || c.classList.contains("compliance")) return "security";
      return "team";
    }
    return pane;
  }
  var paneOf={pricing:"pane-pricing",users:"pane-users",notify:"pane-notify",venues:"pane-venues",ltemplates:"pane-ltemplates"};
  // the link auto-expire card is a security setting: move it (node + listeners intact) to the users pane
  var lx=document.getElementById("lxCard"), pu=document.getElementById("pane-users");
  if(lx && pu) pu.appendChild(lx);

  var cards=[];
  Object.keys(paneOf).forEach(function(p){
    var pane=document.getElementById(paneOf[p]); if(!pane) return;
    Array.prototype.forEach.call(pane.querySelectorAll(".card"),function(c){
      if(c.parentElement.closest(".card")) return;   // only top-level cards
      var s=classify(c,p); c.setAttribute("data-cs-sec",s); cards.push(c);
    });
  });

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
  function drawNav(){
    nav.textContent=""; msel.textContent="";
    var g=null, og=null;
    SECTIONS.forEach(function(s){
      if(!available(s)) return;
      if(s.group!==(g&&g.dataset.g)){
        g=el("div","cs-group"); g.dataset.g=s.group; g.appendChild(el("h4","cs-group-h",s.group)); nav.appendChild(g);
        og=document.createElement("optgroup"); og.label=s.group; msel.appendChild(og);
      }
      var a=el("a",null,s.label); a.href=location.pathname+SECHASH[s.key]; a.dataset.sec=s.key;
      if(s.key===current) a.setAttribute("aria-current","page");
      g.appendChild(a);
      var o=el("option",null,s.label); o.value=s.key; if(s.key===current) o.selected=true; og.appendChild(o);
    });
  }
  msel.addEventListener("change",function(){ var k=msel.value; wanted=k; setHash(SECHASH[k]); show(k); });
  function show(key, opts){
    var s=BYKEY[key]; if(!s) return;
    if(!available(s)) s=BYKEY.studio, key="studio";
    current=key;
    var t=tabFor(s.pane); if(t && !t.classList.contains("active")) t.click();
    var vis=0;
    cards.forEach(function(c){ var off=c.getAttribute("data-cs-sec")!==key; c.classList.toggle("cs-off", off); if(!off) vis++; });
    hT.textContent=s.label; hD.textContent=s.desc; empty.hidden=vis>0;
    drawNav(); clearHL();
    try{ localStorage.setItem("helm.cs.sec",key); }catch(e){}
    if(!(opts&&opts.noScroll)){ try{ main.scrollIntoView({block:"start"}); }catch(e){} }
  }
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
      var sec=c.getAttribute("data-cs-sec"), s=BYKEY[sec]; if(!s||!available(s)||c.hidden) return;
      var title=h3(c)||c.getAttribute("aria-label")||s.label;
      out.push({el:c,card:c,text:title,sec:sec,title:title});
      Array.prototype.forEach.call(c.querySelectorAll("label, h3, h4, legend"),function(l){
        var tx=l.textContent.replace(/\s+/g," ").trim(); if(!tx||tx===title||tx.length>90) return;
        out.push({el:l,card:c,text:tx,sec:sec,title:title});
      });
    });
    return out;
  }
  function norm(s){ return s.toLowerCase().normalize("NFKD").replace(/[^\w\s]/g," "); }
  function search(){
    var v=norm(q.value).trim(); res.textContent="";
    if(!v){ res.hidden=true; return; }
    var words=v.split(/\s+/), seen=new Set(), hits=[];
    entries().forEach(function(e){
      var hay=norm(e.text+" "+e.title+" "+BYKEY[e.sec].label);
      if(words.every(function(w){ return hay.indexOf(w)>=0; })){ var k=e.text+"|"+e.title; if(!seen.has(k)){ seen.add(k); hits.push(e); } }
    });
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
  if(tabs) new MutationObserver(function(){ drawNav(); if(current && !available(BYKEY[current])) show("studio",{noScroll:true}); else if(!fromHash() && wanted && wanted!==current && available(BYKEY[wanted])) show(wanted,{noScroll:true}); })
    .observe(tabs,{subtree:true,attributes:true,attributeFilter:["hidden"]});

  var start="studio"; try{ var st=localStorage.getItem("helm.cs.sec"); if(st&&BYKEY[st]) start=st; }catch(e){}
  wanted=HASH[location.hash]||start;
  if(!fromHash()) show(start,{noScroll:true});
})();
