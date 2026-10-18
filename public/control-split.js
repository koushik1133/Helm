/* Control Center split (preview): groups the existing cards into sub-pages with a left
 * sub-nav, a universal smart settings search (settings-search-core.js), and #section deep links. Layout-only: it never changes
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
    layout:"M3 3h18v18H3zM3 9h18M9 9v12",
    lock:"M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4"
  };
  var SECTIONS=[
    {key:"general",  group:"Workspace",  label:"General",                icon:"home",  hash:"#general",       desc:"Studio name, country and tax, contact details, billing address and your client link name.", kw:"studio account organization business logo accent currency timezone gst gstin address demo trial slug control center centre admin overview"},
    {key:"billing",  group:"Workspace",  label:"Plan & billing",         icon:"card",  hash:"#billing",       desc:"Your Helm subscription, plan and invoices.", kw:"subscription plan invoice trial upgrade"},
    {key:"privacy",  group:"Workspace",  label:"Hide amounts (privacy PIN)",icon:"lock",hash:"#privacy-pin",desc:"The 4-digit PIN that shows amounts again after you hide them in front of a client. One PIN for the studio; admins change it.", kw:"privacy pin passcode hide amounts money prices mask blur present client eye unlock 0000 change pin reset pin forgot pin"},
    {key:"links",    group:"Workspace",  label:"Client links & packages",icon:"link",  hash:"#client-links",  desc:"How long client links stay open and how clients choose a package.", kw:"expire expiry auto-expire link security package flow booklet"},
    {key:"pricing",  group:"Sales",      label:"Pricing & coupons",      icon:"tag",   hash:"#pricing",       desc:"Default pricing for new quotes, rate cards, builder prices and limits, and coupons.", kw:"price tax gst vat discount rate card coupon promo capacity object service charge"},
    {key:"catalog",  group:"Sales",      label:"Menus & catalog",        icon:"menu",  hash:"#menu",          desc:"Chairs, plates, dishes and the menu packages clients pick from.", kw:"chair plate dish catering menu package standard gold premium"},
    {key:"rules",    group:"Sales",      label:"Layout rules",           icon:"grid",  hash:"#layout-rules",  desc:"What the layout generator uses for each event type.", kw:"seats guests buffet bar generator event type layout reminders"},
    {key:"data",     group:"Sales",      label:"Import & custom fields", icon:"upload",hash:"#data",          desc:"Bring catalogues and clients in from Excel, and add your own fields.", kw:"excel import xlsx csv custom field"},
    {key:"users",    group:"People",     label:"Users & invites",        icon:"users", hash:"#users",         desc:"Add teammates, change roles and send join links.", kw:"team member invite role user users details staff login people accounts add remove"},
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
  Object.assign(HASH,{"#account":"general","#studio":"general","#team":"users","#notify":"notify","#security":"links","#link-expiry":"links","#pricing-packages":"pricing","#catalog":"catalog","#event-reminders":"reminders","#client-reminders":"reminders","#payment-reminders":"reminders","#whatsapp":"reminders","#privacy":"privacy","#hide-amounts":"privacy","#pin":"privacy"});
  var OLDKEY={studio:"general",team:"users",security:"links"};
  function h3(c){ var h=c.querySelector("h3"); return h?h.textContent.trim():""; }
  function paneKey(c){ var p=c.closest("[id^='pane-']"); return p?p.id.slice(5):""; }
  function classify(c){
    var id=c.id||"", t=h3(c).toLowerCase(), pane=paneKey(c);
    if(id==="tdControl") return document.documentElement.classList.contains("helm-trial")?"billing":"general";
    if(id==="accCard"||c.querySelector("#o_name")) return "general";
    if(id==="subCard") return "billing";
    if(id==="privPinCard") return "privacy";
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
  var qi=el("input"); qi.id="csSearch"; qi.type="search"; qi.autocomplete="off";
  qi.setAttribute("aria-controls","csResults"); qi.setAttribute("aria-keyshortcuts","Control+K Meta+K /");
  qi.setAttribute("role","combobox"); qi.setAttribute("aria-autocomplete","list"); qi.setAttribute("aria-expanded","false"); qi.spellcheck=false;
  qi.placeholder="Search settings, roles, pages\u2026";
  var mac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent||"");
  var rl=el("div","cs-results"); rl.id="csResults"; rl.setAttribute("role","listbox"); rl.setAttribute("aria-label","Matching settings"); rl.hidden=true;
  var live=el("div","sr-only"); live.setAttribute("role","status"); live.setAttribute("aria-live","polite"); live.id="csLive";
  sw.appendChild(lab); sw.appendChild(el("span","cs-search-ico")); sw.appendChild(qi); sw.appendChild(el("kbd","cs-kbd",mac?"\u2318K":"Ctrl K")); sw.appendChild(rl); sw.appendChild(live);
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
  // 0173 free trial: studio set-up, client links, import, data export, notifications, reminders, photo renders and
  // the privacy PIN are fixed (html.helm-trial is set by trial-lock.js only when the server says "trial");
  // 0181: the studio's own layout templates too (the sample layouts stay usable in the builder)
  var TRIAL_OFF={general:1,links:1,data:1,compliance:1,notify:1,reminders:1,renders:1,privacy:1,ltemplates:1};
  function trial(){ return document.documentElement.classList.contains("helm-trial"); }
  function locked(k){ return trial() && !!TRIAL_OFF[k]; }
  function available(s){ if(locked(s.key)) return false; var t=tabFor(s.pane); return !!t && !t.hidden; }
  function firstOpen(){ for(var i=0;i<SECTIONS.length;i++){ if(available(SECTIONS[i])) return SECTIONS[i].key; } return "general"; }
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
    if(locked(key)){   // direct link to a section the free trial does not include
      current=key; cards.forEach(function(c){ c.classList.add("cs-off"); });
      hT.textContent=s.label; hD.textContent="Not available in the free trial.";
      main.setAttribute("data-cs-cur",key); clearTimeout(emptyTimer); emptyTimer=null;
      empty.textContent="Not available in the free trial. Your trial comes set up with sample data, so this setting is fixed. Upgrade to change it."; empty.hidden=false;
      drawNav(); return;
    }
    if(!available(s)){ key=available(BYKEY.general)?"general":firstOpen(); s=BYKEY[key]; }
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
    if(locked(current)) return;
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

  // ---- universal settings search ----
  // Smart matching lives in settings-search-core.js (window.HelmSettingsSearch): synonyms ("hide money" ->
  // Hide amounts, "gst" -> tax), typos ("whatsap", "notifcations") and word starts. It searches every setting
  // label on this page, every section, the roles in the access matrix, the user's own account items
  // (two-step sign-in, password, profile) and the related pages. ARIA combobox: arrows move, Enter opens,
  // Esc closes. The result jumps to the setting, focuses it and highlights the words that matched.
  var SSC=window.HelmSettingsSearch||null;
  var CAT=window.HelmSearchCatalog||null;
  // pages: search-catalog.js, filtered by the same gates as the sidebar (never a page this role can't open,
  // never the Integrations page while HELM_FEATURES.integrationsPage is off on live)
  var CATSEC={}; if(CAT) CAT.SECTIONS.forEach(function(x){ CATSEC[x.key]=x; });
  var PAGES=[], pagesBusy=false, pagesDone=false;
  function loadPages(){   // on first use (auth is ready by then); re-asks until the role answers
    if(pagesDone||pagesBusy||!CAT||!window.BPStore||!BPStore.auth||!BPStore.auth.user||!BPStore.auth.user()) return;
    pagesBusy=true;
    CAT.entriesFor(BPStore.auth, window.HELM_FEATURES||{}).then(function(list){
      PAGES=list.filter(function(e){ return e.kind==="page" && !/^control\.html/.test(e.href); }).map(function(e){ return {text:e.text,href:e.href,kw:e.keywords}; });
      pagesDone=true; pagesBusy=false; if(q.value.trim()) search();
    },function(){ pagesBusy=false; });
  }
  function openAcc(o){ try{ if(CAT&&CAT.openAccountItem) CAT.openAccountItem(o,window); else if(window.HelmAuthUI&&window.HelmAuthUI.openAccount) window.HelmAuthUI.openAccount(o); }catch(x){} }
  var ACCOUNT=(CAT?CAT.ACCOUNT:[]).map(function(a){ return {text:a.text,kw:a.kw,run:function(){ openAcc(a.open); }}; }); // every signed-in person, own account only
  ACCOUNT.push({text:"Hide or show amounts now",kw:"privacy hide money amounts present eye",run:function(){ if(window.HelmPrivacy&&window.HelmPrivacy.toggle) window.HelmPrivacy.toggle(); }});
  var GENERIC=/^(save|copy|cancel|close|remove|delete|edit|ok|done|yes|no|[^a-z0-9]{1,3})$/i;
  var KIND={setting:"Setting",section:"Section",role:"Role",page:"Page",account:"Your account"};
  function entries(){
    var out=[];
    cards.forEach(function(c){
      var sec=c.getAttribute("data-cs-sec"), s=BYKEY[sec]; if(!s||!available(s)) return;
      if(c.hidden && paneKey(c)!=="notify") return;   // notify-pane cards load on first open: still searchable
      var title=h3(c)||c.getAttribute("aria-label")||s.label;
      out.push({kind:"setting",el:c,card:c,text:title,sec:sec,title:title,context:s.label,keywords:s.kw});
      Array.prototype.forEach.call(c.querySelectorAll("label, h3, h4, legend, summary, .nt, .cmlbl, th[scope=row], button, [role=switch]"),function(l){
        var tx=(l.textContent||l.getAttribute("aria-label")||"").replace(/\s+/g," ").trim(); if(!tx||tx===title||tx.length>90) return;
        if(l.tagName==="BUTTON" && (l.hidden || l.closest("label") || GENERIC.test(tx))) return;   // "Save", "Copy", "×": not a setting by itself
        out.push({kind:"setting",el:l,card:c,text:tx,sec:sec,title:title,context:s.label+" "+title});
      });
    });
    if(BYKEY.access && available(BYKEY.access)) Array.prototype.forEach.call(document.querySelectorAll("#roleTabs .rtab"),function(b){
      var c=b.closest(".card"), tx=b.textContent.replace(/\s+/g," ").trim(); if(!tx) return;
      out.push({kind:"role",el:b,card:c,click:b,text:"Role: "+tx,sec:"access",title:c?h3(c):"Roles & access",context:"Roles & access",keywords:"role access permission "+(b.getAttribute("data-role")||"")});
    });
    // every section by name, description and keywords (covers rows that load on first open)
    SECTIONS.forEach(function(s){ if(!available(s)) return; out.push({kind:"section",el:null,card:null,text:s.label,sec:s.key,title:s.label,context:s.group,keywords:s.desc+" "+s.kw,alias:CATSEC[s.key]&&CATSEC[s.key].alias,boost:0.05}); });
    ACCOUNT.forEach(function(a){ out.push({kind:"account",text:a.text,context:"Your account",keywords:a.kw,run:a.run,boost:0.2}); });   // QA1026 #5: own-account items (2FA) beat cards that only share a synonym
    PAGES.forEach(function(p){ out.push({kind:"page",text:p.text,context:"Page",keywords:p.kw,href:p.href}); });
    return out;
  }
  function norm(s){ return SSC?SSC.normalize(s):String(s||"").toLowerCase().normalize("NFKD").replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim(); }
  function plainRank(v,list){   // fallback if settings-search-core.js did not load: every word must appear
    var words=norm(v).split(" ").filter(Boolean);
    return list.filter(function(e){ var hay=norm(e.text+" "+(e.context||"")+" "+(e.keywords||"")); return words.every(function(w){ return hay.indexOf(w)>=0; }); }).slice(0,25);
  }
  var hits=[], active=-1;
  function setActive(i){
    var opts=res.querySelectorAll("[role=option]"); if(!opts.length){ active=-1; q.removeAttribute("aria-activedescendant"); return; }
    active=(i+opts.length)%opts.length;
    Array.prototype.forEach.call(opts,function(o,j){ o.setAttribute("aria-selected",j===active?"true":"false"); });
    q.setAttribute("aria-activedescendant",opts[active].id);
    try{ opts[active].scrollIntoView({block:"nearest"}); }catch(x){}
  }
  function closeRes(){ res.hidden=true; q.setAttribute("aria-expanded","false"); q.removeAttribute("aria-activedescendant"); active=-1; }
  function search(){
    var v=q.value.trim(); res.textContent=""; hits=[];
    if(!v){ closeRes(); live.textContent=""; return; }
    loadPages(); var list=entries(), seen=new Set();
    var ranked=CAT?CAT.rank(v,list,SSC,60):SSC?SSC.rank(v,list,60):plainRank(v,list);
    ranked.forEach(function(e){ var k=e.kind+"|"+e.text+"|"+(e.title||e.context||""); if(!seen.has(k)&&hits.length<25){ seen.add(k); hits.push(e); } });
    hits.forEach(function(e,i){
      var b=document.createElement("div"); b.setAttribute("role","option"); b.id="csOpt"+i; b.className="cs-opt"; b.setAttribute("aria-selected","false");
      mark(b,e.text,v);
      var where=e.kind==="setting"?BYKEY[e.sec].label+(e.text!==e.title?" › "+e.title:""):e.kind==="role"?"Roles & access":e.kind==="section"?e.context:"";
      var sm=document.createElement("small"); sm.textContent=KIND[e.kind]+(where?" · "+where:""); b.appendChild(sm);
      b.addEventListener("mousedown",function(ev){ ev.preventDefault(); });   // keep focus in the box
      b.addEventListener("click",function(){ jump(e); });
      b.addEventListener("mousemove",function(){ if(active!==i) setActive(i); });
      res.appendChild(b);
    });
    if(!hits.length){ var d=document.createElement("div"); d.className="cs-none"; d.textContent="No matching settings. Try another word, e.g. “pin”, “tax” or “invite”."; res.appendChild(d); }
    res.hidden=false; q.setAttribute("aria-expanded","true");
    live.textContent=hits.length?hits.length+(hits.length===1?" result":" results")+". Use the arrow keys, then Enter.":"No matching settings.";
    if(hits.length) setActive(0); else { active=-1; q.removeAttribute("aria-activedescendant"); }
  }
  function mark(node,text,v){
    var rs=SSC?SSC.ranges(text,v):[], pos=0;
    if(!SSC){ var low=norm(text); norm(v).split(" ").forEach(function(w){ var i=w?low.indexOf(w):-1; if(i>=0) rs.push([i,i+w.length]); }); rs.sort(function(a,b){return a[0]-b[0];}); }
    rs.forEach(function(r){ if(r[0]<pos) return; node.appendChild(document.createTextNode(text.slice(pos,r[0]))); node.appendChild(el("mark",null,text.slice(r[0],r[1]))); pos=r[1]; });
    node.appendChild(document.createTextNode(text.slice(pos)));
  }
  var hasHL=typeof CSS!=="undefined" && CSS.highlights && typeof Highlight==="function";
  function clearHL(){ if(hasHL) CSS.highlights.delete("cs-hit"); }
  function highlightIn(root,words){
    if(!hasHL||!root||!words.length) return; clearHL();
    var hl=new Highlight(), tw=document.createTreeWalker(root,NodeFilter.SHOW_TEXT), n;
    while((n=tw.nextNode())){
      var t=n.nodeValue.toLowerCase();
      words.forEach(function(w){ var i=t.indexOf(w); if(i>=0){ var r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+w.length); hl.add(r); } });
    }
    CSS.highlights.set("cs-hit",hl); setTimeout(clearHL,4000);
  }
  // the words to light up inside the card: the words of the result that matched, plus what was typed
  function hitWords(e,v){
    var w=[]; (SSC?SSC.ranges(e.text,v):[]).forEach(function(r){ var x=e.text.slice(r[0],r[1]).toLowerCase(); if(x.length>1&&w.indexOf(x)<0) w.push(x); });
    norm(v).split(" ").forEach(function(x){ if(x.length>1&&w.indexOf(x)<0) w.push(x); });
    return w;
  }
  function jump(e){
    var v=q.value.trim(), words=hitWords(e,v);
    closeRes(); q.value=""; live.textContent="";
    if(e.kind==="account"){ e.run(); return; }
    if(e.kind==="page"){ location.href=e.href; return; }
    setHash(SECHASH[e.sec]); show(e.sec,{noScroll:true});
    if(!e.el){ try{ main.scrollIntoView({block:"start",behavior:"smooth"}); }catch(x){} return; }
    var node=e.el, target=node;
    if(node.tagName==="LABEL" && node.htmlFor){ var f=document.getElementById(node.htmlFor); if(f) target=f; }
    if(e.click){ try{ e.click.click(); }catch(x){} target=e.click; }
    setTimeout(function(){
      try{ node.scrollIntoView({block:"center",behavior:"smooth"}); }catch(x){}
      highlightIn(e.card,words);
      var box=e.card; if(box){ box.classList.add("cs-flash"); setTimeout(function(){ box.classList.remove("cs-flash"); },1600); }
      // keyboard users land on the setting: its field, the role tab, or the heading itself (made focusable)
      if(target===node && !e.click && !/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(node.tagName) && !node.hasAttribute("tabindex")) node.setAttribute("tabindex","-1");
      try{ target.focus({preventScroll:true}); }catch(x){}
    },60);
  }
  q.addEventListener("input",search);
  q.addEventListener("focus",function(){ loadPages(); if(q.value.trim()) search(); });
  q.addEventListener("keydown",function(e){
    var open=!res.hidden && hits.length>0;
    if(e.key==="Escape"){ if(!res.hidden){ e.preventDefault(); closeRes(); } else if(q.value){ e.preventDefault(); q.value=""; live.textContent=""; } return; }
    if(e.key==="ArrowDown"){ e.preventDefault(); if(res.hidden&&q.value.trim()) search(); else if(open) setActive(active+1); return; }
    if(e.key==="ArrowUp"){ if(open){ e.preventDefault(); setActive(active-1); } return; }
    if(e.key==="Home"&&open&&e.ctrlKey){ e.preventDefault(); setActive(0); return; }
    if(e.key==="End"&&open&&e.ctrlKey){ e.preventDefault(); setActive(hits.length-1); return; }
    if(e.key==="Enter"){ if(open){ e.preventDefault(); jump(hits[active>=0?active:0]); } return; }
    if(e.key==="Tab"){ closeRes(); }
  });
  document.addEventListener("click",function(e){ if(!aside.contains(e.target)) closeRes(); });
  /* capture phase + stopImmediatePropagation: the global studio search (studio-search.js) also binds Cmd/Ctrl+K on document and would open over the settings search */
  window.addEventListener("keydown",function(e){ if((e.metaKey||e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key==="k"||e.key==="K") && !app.hidden && !document.querySelector(".hss-ov:not([hidden])")){ e.preventDefault(); e.stopImmediatePropagation(); q.focus(); q.select(); } },true);
  document.addEventListener("keydown",function(e){ if(e.key==="/" && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||"") && !(document.activeElement&&document.activeElement.isContentEditable) && !app.hidden){ e.preventDefault(); q.focus(); } });
  // deep link from the global palette: control.html?cs=<setting text>#section -> jump to that exact field.
  // Cards load asynchronously, so retry for a few seconds until a matching entry exists.
  (function(){
    var want=""; try{ want=(new URLSearchParams(location.search).get("cs")||"").slice(0,80); }catch(x){}
    if(!want) return;
    try{ var u=new URLSearchParams(location.search); u.delete("cs"); var qs=u.toString(); history.replaceState(null,"",location.pathname+(qs?"?"+qs:"")+location.hash); }catch(x){}
    var tries=0, lw=norm(want);
    (function go(){
      var list=entries().filter(function(e){ return e.kind==="setting"||e.kind==="role"; });
      var hit=list.filter(function(e){ return e.card && !e.card.hidden && norm(e.text)===lw; })[0] || list.filter(function(e){ return e.card && !e.card.hidden && norm(e.text).indexOf(lw)===0; })[0];
      if(!hit && tries>=12){ var r=SSC?SSC.rank(want,list,1):plainRank(want,list); hit=r[0]; }
      if(hit){ q.value=want; jump(hit); return; }
      if(tries++<24) setTimeout(go,250);
    })();
  })();
  window.HelmControlSearch={ entries:entries, open:function(v){ q.value=v||""; q.focus(); search(); } };

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
  if(tabs) new MutationObserver(function(){ drawNav(); if(current && !available(BYKEY[current]) && !locked(current)) show("general",{noScroll:true}); else if(!fromHash() && wanted && wanted!==current && available(BYKEY[wanted])) show(wanted,{noScroll:true}); })
    .observe(tabs,{subtree:true,attributes:true,attributeFilter:["hidden"]});

  // free trial: the demo-data card moves next to Plan & billing (General is not part of the trial)
  function onTrial(){
    var td=document.getElementById("tdControl"); if(td) td.setAttribute("data-cs-sec","billing");
    cards.forEach(function(c){ if(c.id==="tdControl") c.setAttribute("data-cs-sec","billing"); });
    if(!fromHash()) show(locked(current)||!current?firstOpen():current,{noScroll:true});
    else drawNav();
  }
  window.addEventListener("helm:trial",onTrial);
  var start="general"; try{ var st=localStorage.getItem("helm.cs.sec"); st=OLDKEY[st]||st; if(st&&BYKEY[st]) start=st; }catch(e){}
  wanted=HASH[location.hash]||start;
  if(!fromHash()) show(start,{noScroll:true});
  if(trial()) onTrial();
})();
