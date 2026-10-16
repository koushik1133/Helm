/* Control Center split (preview): groups the existing cards into sub-pages with a left
 * sub-nav, a settings search, and #section deep links. Layout-only: it never changes
 * a setting, never removes an element, and never touches the `hidden` attribute that
 * the page's own JS uses for permissions. It drives the existing tab buttons. */
(function(){
  "use strict";
  var app=document.getElementById("app"); if(!app) return;
  var SECTIONS=[
    {key:"studio",   label:"Studio & billing",        pane:"pricing"},
    {key:"pricing",  label:"Pricing & packages",      pane:"pricing"},
    {key:"data",     label:"Data & import",           pane:"pricing"},
    {key:"team",     label:"Team & access",           pane:"users"},
    {key:"security", label:"Security & compliance",   pane:"users"},
    {key:"notify",   label:"Notifications & reminders",pane:"notify"},
    {key:"venues",   label:"Venues",                  pane:"venues"},
    {key:"ltemplates",label:"Layout templates",       pane:"ltemplates"}
  ];
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
  aside.innerHTML='<div class="cs-search"><label class="sr-only" for="csSearch">Search settings</label>'+
    '<input id="csSearch" type="search" placeholder="Search settings…" autocomplete="off" aria-controls="csResults">'+
    '<div id="csResults" class="cs-results" role="listbox" hidden></div></div><nav class="cs-nav" id="csNav"></nav>';
  var tabs=main.querySelector(".tabs"); if(tabs) app.appendChild(tabs);
  app.appendChild(aside); app.appendChild(main); app.classList.add("cs-on");
  var nav=aside.querySelector("#csNav"), q=aside.querySelector("#csSearch"), res=aside.querySelector("#csResults");

  function tabFor(pane){ return document.getElementById("tab-"+pane); }
  function available(s){ var t=tabFor(s.pane); return !!t && !t.hidden; }
  var current=null, wanted=null;
  function drawNav(){
    nav.textContent="";
    SECTIONS.forEach(function(s){
      if(!available(s)) return;
      var a=document.createElement("a"); a.href=SECHASH[s.key]; a.textContent=s.label; a.dataset.sec=s.key;
      if(s.key===current) a.setAttribute("aria-current","page");
      nav.appendChild(a);
    });
  }
  function show(key, opts){
    var s=BYKEY[key]; if(!s) return;
    if(!available(s)) s=BYKEY.studio, key="studio";
    current=key;
    var t=tabFor(s.pane); if(t && !t.classList.contains("active")) t.click();
    cards.forEach(function(c){ c.classList.toggle("cs-off", c.getAttribute("data-cs-sec")!==key); });
    drawNav();
    try{ localStorage.setItem("helm.cs.sec",key); }catch(e){}
    if(!(opts&&opts.noScroll)){ try{ main.scrollIntoView({block:"start"}); }catch(e){} }
  }
  nav.addEventListener("click",function(e){
    var a=e.target.closest("a[data-sec]"); if(!a) return;
    e.preventDefault(); wanted=a.dataset.sec; history.replaceState(null,"",a.getAttribute("href")); show(a.dataset.sec);
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
      b.textContent=e.text; var sm=document.createElement("small"); sm.textContent=BYKEY[e.sec].label+(e.text!==e.title?" › "+e.title:""); b.appendChild(sm);
      b.addEventListener("click",function(){ jump(e); });
      res.appendChild(b);
    });
    if(!hits.length){ var d=document.createElement("div"); d.className="cs-none"; d.textContent="No matching settings"; res.appendChild(d); }
    res.hidden=false;
  }
  function jump(e){
    res.hidden=true; q.value="";
    history.replaceState(null,"",SECHASH[e.sec]); show(e.sec,{noScroll:true});
    var el=e.el, target=el;
    if(el.tagName==="LABEL" && el.htmlFor){ var f=document.getElementById(el.htmlFor); if(f) target=f; }
    setTimeout(function(){
      try{ el.scrollIntoView({block:"center",behavior:"smooth"}); }catch(x){}
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
  document.addEventListener("keydown",function(e){ if(e.key==="/" && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||"") && !app.hidden){ e.preventDefault(); q.focus(); } });

  // tabs are revealed asynchronously by role checks: redraw the nav when that happens
  if(tabs) new MutationObserver(function(){ drawNav(); if(current && !available(BYKEY[current])) show("studio",{noScroll:true}); else if(!fromHash() && wanted && wanted!==current && available(BYKEY[wanted])) show(wanted,{noScroll:true}); })
    .observe(tabs,{subtree:true,attributes:true,attributeFilter:["hidden"]});

  var start="studio"; try{ var st=localStorage.getItem("helm.cs.sec"); if(st&&BYKEY[st]) start=st; }catch(e){}
  wanted=HASH[location.hash]||start;
  if(!fromHash()) show(start,{noScroll:true});
})();
