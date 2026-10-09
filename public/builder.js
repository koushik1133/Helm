/* =========================================================================
   BLUEPRINT STAGE — 2D Event Layout & Blueprint Builder
   Single-file, vanilla JS. State-driven SVG canvas with snap grid, rulers,
   drag / rotate / resize, live inspector, undo-redo, and event templates.
   =========================================================================

   STATE ARCHITECTURE
   ------------------------------------------------------------------
   store = {
     items: [ Item, ... ],          // ordered back→front (draw + z-order)
     selectedId: string | null,
     grid:  { snap:bool, show:bool, unit:'ft'|'m', sizeFt:number },
     view:  { zoom:number },        // display scale on top of PX_PER_FT
     scale: { pxPerFt:12, worldFt:{w:200,h:140} },
     past:  [ snapshot, ... ],       // undo stack  (JSON item arrays)
     future:[ snapshot, ... ]        // redo stack
   }

   Item = {
     id, type, category,
     x, y,                          // top-left, in FEET (world coords)
     width, height,                 // in FEET
     rotation,                      // degrees 0..359, about item center
     label,
     color,                         // resolved category hue (CSS var value)
     properties: {}                 // type-specific: {rows,cols}, {seats}, {glyph}...
   }
   ========================================================================= */

const PX_PER_FT = 12;
const DEFAULT_WORLD = { w: 200, h: 140 };
const WORLD = { w: 200, h: 140 };            // floor size in feet
// Capacity ceilings, loaded from Control Center (config.getPricing). Defaults keep the
// builder from being asked to render absurd counts (which used to freeze the app).
let CAPS = { guests:20000, chairs:20000, plates:20000, tables:2000, bars:200, trucks:200, booths:1000, rest:200, exits:200, hall:1000 };
const FT_PER_M = 3.280839895;

/* ---- category palette (reads live CSS vars so themes stay in sync) ---- */
const CATS = {
  structure:{ name:'Structure', varName:'--c-structure' },
  seating:  { name:'Seating',   varName:'--c-seating'   },
  av:       { name:'AV & Stage',varName:'--c-av'        },
  security: { name:'Security',  varName:'--c-security'  },
  logistics:{ name:'Logistics', varName:'--c-logistics' },
  safety:   { name:'Safety',    varName:'--c-safety'    },
  decor:    { name:'Decor',     varName:'--c-decor'     },
};
const catColor = k => getComputedStyle(document.documentElement).getPropertyValue(CATS[k].varName).trim();

/* ---- asset catalog : the toolbox + creation defaults ---- */
const ASSETS = {
  stage:      { label:'Main Stage',    category:'structure', w:40, h:16 },
  dancefloor: { label:'Dance Floor',   category:'structure', w:24, h:24 },
  podium:     { label:'Podium',        category:'av',        w:3,  h:3  },
  press:      { label:'Press Riser',   category:'av',        w:24, h:12 },
  dj:         { label:'DJ Booth',      category:'av',        w:8,  h:5  },
  chairrow:   { label:'Chair Row',     category:'seating',   w:24, h:2,  props:{rows:1, cols:12} },
  seatblock:  { label:'Seating Block', category:'seating',   w:30, h:24, props:{rows:10, cols:14} },
  table:      { label:'Round Table',   category:'seating',   w:6,  h:6,  props:{seats:8} },
  barricade:  { label:'Barricade',     category:'security',  w:30, h:2  },
  fence:      { label:'Fence Line',    category:'security',  w:40, h:1  },
  booth:      { label:'Expo Booth',    category:'logistics', w:10, h:10 },
  desk:       { label:'Reg Desk',      category:'logistics', w:8,  h:2.5},
  truck:      { label:'Food Truck',    category:'logistics', w:22, h:8  },
  exit:       { label:'Exit Zone',     category:'safety',    w:12, h:6  },
  /* ---- expanded catalog ---- */
  canopy:     { label:'Canopy',        category:'structure', w:22, h:22 },
  arch:       { label:'Arch / Backdrop',category:'structure',w:12, h:1.5},
  tent:       { label:'Tent',          category:'structure', w:30, h:24 },
  longtable:  { label:'Banquet Table', category:'seating',   w:16, h:4,  props:{seats:12} },
  headtable:  { label:'Head Table',    category:'seating',   w:18, h:3,  props:{seats:8} },
  cocktail:   { label:'Cocktail Table',category:'seating',   w:3.5,h:3.5,props:{seats:3} },
  lounge:     { label:'Lounge Set',    category:'seating',   w:12, h:9  },
  photobooth: { label:'Photo Booth',   category:'av',        w:8,  h:8  },
  checkpoint: { label:'Checkpoint',    category:'security',  w:6,  h:3  },
  bar:        { label:'Bar',           category:'logistics', w:14, h:4  },
  buffet:     { label:'Buffet Line',   category:'logistics', w:18, h:3  },
  gifttable:  { label:'Gift Table',    category:'logistics', w:6,  h:2.5},
  caketable:  { label:'Cake Table',    category:'logistics', w:4,  h:4  },
  restroom:   { label:'Restrooms',     category:'logistics', w:12, h:8  },
  /* ---- upscale pack ---- */
  ledscreen:  { label:'LED Screen',    category:'av',        w:20, h:2  },
  truss:      { label:'Truss Tower',   category:'structure', w:4,  h:4  },
  speaker:    { label:'Speaker Stack', category:'av',        w:3,  h:3  },
  coatcheck:  { label:'Coat Check',    category:'logistics', w:10, h:4  },
  firstaid:   { label:'First Aid',     category:'safety',    w:8,  h:8  },
  planter:    { label:'Greenery',      category:'structure', w:4,  h:4  },
  redcarpet:  { label:'Carpet / Aisle',category:'structure', w:6,  h:30 },
  parking:    { label:'Parking Zone',  category:'logistics', w:40, h:24 },
  /* ---- furniture + decor pack ---- */
  sofa:       { label:'Sofa',          category:'seating',   w:7,  h:3  },
  loveseat:   { label:'Loveseat',      category:'seating',   w:5,  h:3  },
  armchair:   { label:'Armchair',      category:'seating',   w:3,  h:3  },
  ottoman:    { label:'Ottoman',       category:'seating',   w:2.5,h:2.5},
  bench:      { label:'Bench',         category:'seating',   w:5,  h:1.5},
  coffeetable:{ label:'Coffee Table',  category:'seating',   w:4,  h:2.5},
  floral:     { label:'Floral Centerpiece', category:'decor',w:2.5,h:2.5},
  floralarch: { label:'Floral Arch',   category:'decor',     w:10, h:2  },
  mandap:     { label:'Decor Mandap',  category:'decor',     w:16, h:16 },
  pillar:     { label:'Decor Pillar',  category:'decor',     w:2,  h:2  },
  drape:      { label:'Pipe & Drape',  category:'decor',     w:16, h:1  },
  chandelier: { label:'Chandelier',    category:'decor',     w:4,  h:4  },
  fountain:   { label:'Fountain',      category:'decor',     w:6,  h:6  },
  uplight:    { label:'Uplight',       category:'av',        w:1,  h:1  },
  heater:     { label:'Patio Heater',  category:'logistics', w:2.5,h:2.5},
  easel:      { label:'Signage Easel', category:'logistics', w:2.5,h:2  },
  /* ---- realistic render pack (from the render reference) ---- */
  chiavari:   { label:'Chiavari Chair',category:'seating',   w:1.6,h:1.6},
  barstool:   { label:'Bar Stool',     category:'seating',   w:1.6,h:1.6},
  piano:      { label:'Grand Piano',   category:'av',        w:8,  h:6  },
  bleacher:   { label:'Bleachers',     category:'seating',   w:24, h:8  },
  /* ---- concert & live-production pack ---- */
  linearray:  { label:'Line Array',    category:'av',        w:2,  h:6  },
  subwoofer:  { label:'Subwoofer',     category:'av',        w:3,  h:3  },
  monitor:    { label:'Stage Monitor', category:'av',        w:2,  h:1.5},
  foh:        { label:'FOH Console',   category:'av',        w:8,  h:8  },
  movinghead: { label:'Moving Light',  category:'av',        w:1.5,h:1.5},
  videowall:  { label:'LED Video Wall',category:'av',        w:24, h:14 },
  generator:  { label:'Generator',     category:'logistics', w:8,  h:4  },
  distro:     { label:'Power Distro',  category:'logistics', w:3,  h:2  },
  cableramp:  { label:'Cable Ramp',    category:'logistics', w:6,  h:1  },
  greenroom:  { label:'Green Room',    category:'logistics', w:16, h:12 },
  viprisers:  { label:'VIP Riser',     category:'structure', w:16, h:10 },
  stagebarrier:{label:'Stage Barrier', category:'security',  w:30, h:1.5},
};

/* ---------------------------------------------------------------- pricing
   Live price breakdown. Chairs/seats are priced per-seat from the Control
   Centre chair rate; every other object is priced per-unit. Prices fall back
   to a sensible in-code default and can be overridden from the Control Centre
   pricing config (config.assetPrices / config.layoutBase).  All INR.        */
const CAT_BASE_PRICE = {          // per-unit fallback by category (₹)
  structure:15000, seating:2500, av:9000, security:2000,
  logistics:4000, safety:1500, decor:12000,
};
const DEFAULT_PRICES = {          // per-unit overrides for big-ticket items (₹)
  stage:45000, tent:35000, canopy:25000, mandap:75000, arch:9000, floralarch:15000,
  dancefloor:20000, redcarpet:8000, viprisers:18000, truss:6000,
  videowall:120000, ledscreen:60000, linearray:40000, subwoofer:12000, foh:20000,
  piano:30000, press:15000, dj:10000, photobooth:12000,
  bar:12000, buffet:9000, truck:25000, greenroom:8000, generator:15000, parking:10000,
  chandelier:12000, fountain:20000, mandap_decor:0,
  restroom:12000, coatcheck:5000, firstaid:4000,
};
// object types whose seats are billed via the chair rate (so we don't
// double-charge them as furniture units in the breakdown)
const SEAT_UNIT = { chiavari:1, barstool:1 };
function isSeating(it){
  const p = it.properties||{};
  return (p.rows&&p.cols) || p.seats || (SEAT_UNIT[it.type]!=null);
}
function seatCount(it){
  const p = it.properties||{};
  if(p.rows&&p.cols) return p.rows*p.cols;
  if(p.seats) return p.seats;
  return SEAT_UNIT[it.type]||0;
}
function unitPrice(type){
  if(PRICING.assetPrices && PRICING.assetPrices[type]!=null) return +PRICING.assetPrices[type];
  if(DEFAULT_PRICES[type]!=null) return DEFAULT_PRICES[type];
  const a=ASSETS[type]; return (a && CAT_BASE_PRICE[a.category]) || 3000;
}
// Past layouts are always re-priced from the CURRENT Control Center catalog:
// strip any price-like fields an old layout may carry so nothing stale can
// leak into the breakdown (pricing is computed by type from PRICING.assetPrices).
const STALE_PRICE_KEYS = ['price','unitPrice','unit_price','cost','rate','amount'];
function stripStalePrices(items){
  return (items||[]).map(it=>{
    if(!it || typeof it!=='object') return it;
    const c=Object.assign({}, it);
    STALE_PRICE_KEYS.forEach(k=>{ delete c[k]; });
    if(c.properties && typeof c.properties==='object'){
      c.properties=Object.assign({}, c.properties); STALE_PRICE_KEYS.forEach(k=>{ delete c.properties[k]; }); }
    return c;
  });
}
// true when the Control Center catalog has a live rate for this object type
function inCatalog(type, assetPrices){ return !!(assetPrices && assetPrices[type]!=null); }
// runtime pricing config (loaded from Control Centre in init)
// chairPrice/platePrice/gstPct/layoutBase/serviceChargePct/assetPrices = rates;
// menuPlatePrice/menuPackageName/guests = the current event's menu + headcount.
const PRICING = { chairPrice:200, platePrice:500, gstPct:18, layoutBase:0, serviceChargePct:0,
  assetPrices:null, eventType:null, menuPlatePrice:null, menuPackageName:null, guests:null,
  packages:[], appliedPkgId:"" };
// map a quote's event type → a default preset layout key
const EVENT_TYPE_PRESET = {
  wedding:'wedding_banquet', reception:'wedding_reception', engagement:'wedding_ceremony',
  concert:'concert_mainstage', festival:'festival_mainstage',
  conference:'conference_keynote', corporate:'product_launch', product_launch:'product_launch',
  political:'political_theatre', birthday:'birthday_party', gala:'gala_awards',
};

function inr(n){ const T=window.BPStore&&BPStore.tax; if(T && PRICING.taxCountry && T.code(PRICING.taxCountry)!=='IN') return T.money(Math.round(n||0), T.resolve(PRICING)); return '₹'+Math.round(n||0).toLocaleString('en-IN'); }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// The ONE breakdown — delegated to BPStore.pricing so the builder and the
// quote always show the identical number. Chairs + objects come from the
// layout; catering = guests × the applied menu package's per-plate price.
function priceModel(){
  // Mirror the stored quote's catering MODE so the live panel matches quoteTotal()
  // (client-provided catering = ₹0). Without this the panel always billed in-house.
  return BPStore.pricing.breakdown(
    { items: store.items, chairs: quoteChairsNow(), guests: PRICING.guests, menuPlatePrice: PRICING.menuPlatePrice,
      serviceChargePct: PRICING.serviceChargePct,
      clientCater: !!(typeof currentPricing!=="undefined" && currentPricing && currentPricing.catering && currentPricing.catering.mode === 'client') },
    PRICING);
}

// R8b: the quote's ONE chairs value (70% of guests unless typed) is the pricing source — never the
// layout's count. When the layout differs, the right panel offers "Layout has N chairs — use N for pricing?".
function layoutChairCount(){ try{ return totalSeats(); }catch(e){ return 0; } }
/* R10: the seats target for a layout auto-built on arrival. The quote's saved sizing wins; when the
   quote has none yet (fresh flow hand-off) the ?gen URL's chairs, else 70% of its guests — never the
   template's own natural seat count (that gave "101 seats" for a 105-seat Reception). */
let _autoDefaultLoaded=false;
function genTargetSeats(saved, urlChairs, urlGuests){
  const p=v=>{ const n=Math.round(+v); return v!=null && v!=='' && isFinite(n) && n>0 ? n : null; };
  return p(saved) || p(urlChairs) || (p(urlGuests) ? Math.ceil(p(urlGuests)*7/10) : null) || 0;
}
function arrivalSeats(){
  let saved=null;
  try{ if(window.HelmSizing){ const cl=currentClient||{}, pr=currentPricing||{};
    saved=HelmSizing.quoteChairs(PRICING.guests!=null && cl.guests==null ? Object.assign({}, cl, { guests: PRICING.guests }) : cl, pr, null); } }catch(e){}
  let u=null; try{ u=new URLSearchParams(location.search); }catch(e){}
  // R10 hotfix: arriving from the flow, the URL carries the flow's current seats — fresher than a
  // half-loaded quote record — so it wins; otherwise the saved quote seats, then 70% of guests.
  const fromFlow = u && u.get('from')==='flow' && u.get('chairs');
  if(fromFlow) return genTargetSeats(u.get('chairs'), null, u.get('guests')) || quoteChairsNow();
  return genTargetSeats(saved, u&&u.get('chairs'), u&&u.get('guests')) || quoteChairsNow();
}
function quoteChairsNow(){
  const lay=layoutChairCount();
  if(!window.HelmSizing) return lay;
  let cl={}, pr={}; try{ cl=currentClient||{}; pr=currentPricing||{}; }catch(e){ /* not initialised yet */ }
  const c=HelmSizing.quoteChairs(PRICING.guests!=null && cl.guests==null ? Object.assign({}, cl, { guests: PRICING.guests }) : cl, pr, lay);
  return c==null ? lay : c;
}
function syncChairsPanel(){
  const inp=$('#bChairs'); if(inp && document.activeElement!==inp) inp.value=quoteChairsNow();
  const box=$('#bChairsNote'); if(!box || !window.HelmSizing) return;
  const n=HelmSizing.layoutChairsNote(quoteChairsNow(), layoutChairCount());
  box.hidden=!n || RO; if(n){ $('#bChairsNoteTxt').textContent=n.text; box.dataset.n=String(n.n); }
}
// R9: "reset to 70%" — drop the manual flag on BOTH records so every screen re-derives from guests
async function resetQuoteChairs(){
  if(!currentQuoteId || RO) return;
  currentPricing=Object.assign({}, currentPricing||{}, { chairsManual:false });
  await persistSizing({ chairsManual:false, guests:(currentClient&&currentClient.guests!=null)?currentClient.guests:PRICING.guests });
  renderPrice(); syncChairsPanel(); syncQuotePricing();
}
async function setQuoteChairs(n){
  n=Math.round(+n);
  if(!(n>=1)){ toast(CHAIRS_MIN_MSG); try{ syncChairsPanel(); const ci=$('#bChairs'); if(ci) ci.value=quoteChairsNow(); }catch(e){} return; }
  currentPricing=Object.assign({}, currentPricing||{}, { chairs:n, chairsManual:true });
  await persistSizing({ chairs:n, chairsManual:true });
  renderPrice(); syncChairsPanel(); syncQuotePricing();
}
// Build the menu-package + guests controls ONCE (rebuilding on every render
// would steal focus from the guests field while typing).
function buildMenuControls(){
  const box=$('#pkgPanel'); if(!box) return;
  const pkgs=PRICING.packages||[];
  const opts=['<option value="">No package…</option>'].concat(
    pkgs.map(p=>`<option value="${esc(p.id)}" ${p.id===PRICING.appliedPkgId?'selected':''}>${esc(p.name)} · ${inr(p.price_per_plate)}/plate</option>`)).join('');
  box.innerHTML =
    `<label class="pfield">Menu package<select id="bPkg" ${CAN_CREATE?'':'disabled'}>${opts}</select></label>`+
    `<label class="pfield">Guests / plates <input id="bGuests" type="number" min="0" value="${PRICING.guests!=null?PRICING.guests:''}"></label>`+
    `<label class="pfield">Chairs (priced) <input id="bChairs" type="number" min="1" ${RO?'disabled':''}></label>`+
    `<p class="delta" id="bChairsNote" hidden><span id="bChairsNoteTxt"></span> <button type="button" class="tbtn" id="bChairsUse">Use layout count</button></p>`+
    `<div class="delta" id="pkgDelta"></div>`;
  const bc=$('#bChairs'); if(bc) bc.addEventListener('change',()=>{ if(bc.value!=='') setQuoteChairs(bc.value); });
  const bu=$('#bChairsUse'); if(bu) bu.addEventListener('click',()=>{ const n=+($('#bChairsNote').dataset.n||0); if(n) setQuoteChairs(n); });
  syncChairsPanel();
  const sel=$('#bPkg'); if(sel) sel.addEventListener('change',onPickPackage);
  const g=$('#bGuests'); if(g){
    g.addEventListener('input',()=>{ PRICING.guests = g.value===''?null:Math.max(0,parseInt(g.value,10)||0); renderPrice(); });
    // persist on blur so the guest count isn't lost (kept on the quote's client, where the quote screen reads it)
    g.addEventListener('change', persistGuests);
  }
}
// R8: write a sizing patch (guests / chairs / tables / hall L×B) onto the quote's client record —
// the same record the quote flow reads, so both screens show one set of numbers.
async function persistSizing(patch){
  if(!currentQuoteId || !window.HelmSizing) return;
  try{ currentClient = HelmSizing.merge(currentClient, patch);
    await BPStore.quotes.updateMeta(currentQuoteId, { client: currentClient }); }
  catch(e){ /* non-fatal */ }
}
// 0085: the venue picked in Custom Event is linked on the quote's client JSON (id + name + setting)
window.HelmBuilderVenue = {
  client: () => currentClient || {},
  async link(v){
    if(!currentQuoteId) return;
    currentClient = Object.assign({}, currentClient || {}, v
      ? { venueId: v.id, venueName: v.name, setting: v.setting === 'outdoor' ? 'outdoor' : (v.setting === 'both' ? 'both' : 'indoor') }
      : { venueId: null, venueName: null });
    try{ await BPStore.quotes.updateMeta(currentQuoteId, { client: currentClient }); }catch(e){ /* non-fatal */ }
  },
};
async function persistGuests(){
  if(!currentQuoteId || PRICING.guests==null) return;
  try{ currentClient = window.HelmSizing ? HelmSizing.merge(currentClient, { guests: PRICING.guests }) : Object.assign({}, currentClient, { guests: PRICING.guests });
    await BPStore.quotes.updateMeta(currentQuoteId, { client: currentClient }); }
  catch(e){ /* non-fatal */ }
  try{ renderPrice(); syncChairsPanel(); }catch(e){}   // R9: chairs follow guests only while not hand-set
  syncQuotePricing();
}

// Recompute the quote's STORED total from the live layout + menu + guests using
// the same money calc the confirm modal uses, and write it back — so the quotes
// list, event workspace and invoice never show a stale price. Commercial terms
// already set on the quote (discount, coupon, place-of-supply, rates) are kept.
let _syncTimer=null, _lastAutoOther=null;
function syncQuotePricing(){
  if(!currentQuoteId) return;
  clearTimeout(_syncTimer);
  _syncTimer=setTimeout(()=>{ syncQuotePricingNow(); }, 600);
}
// Runs the pricing write immediately (used by "Save & back to quote", which must not leave
// the page while a debounced write is still pending — that write would be lost).
// R9: the exact pricing object the builder writes to the quote — also what the right panel totals,
// so the panel, the flow, quotes.html, the booklet and the D8 server all price the same object.
function quotePricingNow(){
  currentPricing = currentPricing || {};
  const oi = BPStore.pricing.fromItems(store.items, PRICING.assetPrices);
  // R8b: the quote's ONE chairs value prices chairs (typed, else 70% of guests) — the layout count never overrides it
  const chairsManual = HelmSizing.isChairsManual(currentClient, currentPricing);   // R9: client flag authoritative
  const chairs = quoteChairsNow();
  const guests = PRICING.guests!=null ? PRICING.guests : chairs;
  const platePrice = PRICING.menuPlatePrice!=null ? PRICING.menuPlatePrice
                    : (currentPricing.platePrice!=null?currentPricing.platePrice:PRICING.platePrice);
  const auto = oi.objectsCost + (+PRICING.layoutBase||0);
  const hand = HelmSizing.handOther(currentPricing, _lastAutoOther);   // R9: a hand-set Décor / setup is never overwritten
  return Object.assign({}, currentPricing, {
    chairs, guests, platePrice, chairsManual,
    chairPrice: currentPricing.chairPrice!=null?currentPricing.chairPrice:PRICING.chairPrice,
    gstPct: currentPricing.gstPct!=null?currentPricing.gstPct:PRICING.gstPct,
    serviceChargePct: currentPricing.serviceChargePct!=null?currentPricing.serviceChargePct:PRICING.serviceChargePct,
    // never overwrite a hand-edited 'other': it counts as hand-edited when it no longer matches the
    // last value this builder computed (otherAuto, stored beside it, or this session's last write)
    other: hand!=null ? hand : auto,
    otherAuto: hand!=null && currentPricing.otherAuto!=null ? currentPricing.otherAuto : auto,
    catering: currentPricing.catering || { mode:'inhouse', amount:0, gstPct:PRICING.gstPct },
  // 0079: a NEW quote takes the studio's tax country/inclusive setting; a priced one keeps its own
  }, currentPricing.gstPct==null ? BPStore.tax.snapshot(BPStore.tax.resolve(PRICING)) : {});
}
async function syncQuotePricingNow(){
  if(!currentQuoteId) return false;
  clearTimeout(_syncTimer);
    try{
      // refetch the latest saved pricing (discount/coupon/rates may have changed in quotes.html since
      // this page opened) and write back conditioned on its updated_at, so nothing is clobbered
      let expectedUpdatedAt = null;
      try{ const latest = await BPStore.quotes.get(currentQuoteId);
        if(latest){ currentPricing = latest.pricing || currentPricing; expectedUpdatedAt = latest.updatedAt || null; } }catch(_){}
      const p = quotePricingNow();
      const t = BPStore.pricing.quoteTotal(p);
      const pricing = Object.assign({}, p, { computed:t, total:t.total, client: currentClient });
      await BPStore.quotes.updateMeta(currentQuoteId, { pricing }, expectedUpdatedAt);
      currentPricing = pricing; _lastAutoOther = pricing.otherAuto;
      updateQuoteBadge && updateQuoteBadge();
      return true;
    }catch(e){ /* non-fatal */ return false; }
}
async function onPickPackage(){
  const tid=$('#bPkg').value;
  const prev={ id:PRICING.appliedPkgId, plate:PRICING.menuPlatePrice, name:PRICING.menuPackageName };
  // there is no API to un-apply a package from the plan, so "No package…" can't be saved — keep the current one
  if(!tid && prev.id){ $('#bPkg').value=prev.id; toast('A package can be changed but not removed here — pick another package'); return; }
  PRICING.appliedPkgId=tid;
  const pkg=(PRICING.packages||[]).find(p=>p.id===tid);
  PRICING.menuPlatePrice = pkg ? pkg.price_per_plate : null;
  PRICING.menuPackageName = pkg ? pkg.name : null;
  // persist to the event's plan so the quote screen shows the same package + price
  if(currentQuoteId && tid){
    try{ await BPStore.menuTemplates.apply(currentQuoteId, tid); toast('Applied '+(pkg?pkg.name:'package')); }
    catch(e){ PRICING.appliedPkgId=prev.id; PRICING.menuPlatePrice=prev.plate; PRICING.menuPackageName=prev.name;
      const sel=$('#bPkg'); if(sel) sel.value=prev.id||'';
      toast('Couldn\'t apply package — price left unchanged'); renderAll(); return; }
  }
  renderAll();
  syncQuotePricing();
}

// Render the live price breakdown panel (called on every renderAll).
function renderPrice(){
  try{ syncChairsPanel(); }catch(e){}
  const box=$('#pricePanel'); if(!box) return;
  const m=priceModel();
  // R9: on a quote the panel prices the SAME object the builder saves (quotePricingNow → quoteTotal), so a
  // hand-set Décor / setup, discount, coupon or catering amount gives the same total here as everywhere else
  let qp=null, qt=null; if(currentQuoteId && window.HelmSizing){ try{ qp=quotePricingNow(); qt=BPStore.pricing.quoteTotal(qp); }catch(e){ qp=null; } }
  const otherSet = qp ? HelmSizing.handOther(currentPricing, _lastAutoOther) : null;
  if(qt){ m.subtotal=qt.subtotal; m.gst=Math.round(qt.totalGst); m.total=qt.total; m.serviceCharge=Math.round(qt.serviceCharge); m.discount=qt.discount;
    m.chairsCost=qp.chairs*qp.chairPrice; m.cateringCost=qt.cateringBucket; m.svcPct=+qp.serviceChargePct||0; m.gstPct=+qp.gstPct||0; m.taxInclusive=qt.taxInclusive; }
  let rows='';
  if(m.chairs>0)
    rows+=`<div class="prow"><span>Chairs <span class="q">${m.chairs} × ${inr(m.chairPrice)}</span></span><span class="amt">${inr(m.chairsCost)}</span></div>`;
  if(m.cateringCost>0)
    rows+=`<div class="prow"><span>Catering${PRICING.menuPackageName?' <span class="q">'+esc(PRICING.menuPackageName)+'</span>':''} <span class="q">${m.guests} × ${inr(m.platePrice)}</span></span><span class="amt">${inr(m.cateringCost)}</span></div>`;
  if(otherSet!=null){ if(otherSet>0) rows+=`<div class="prow"><span>Décor / setup <span class="q">set on quote</span></span><span class="amt">${inr(otherSet)}</span></div>`; }
  else (m.objectLines||[]).forEach(l=>{
    const label=ASSETS[l.type]?ASSETS[l.type].label:l.type;
    const flag = (PRICING.assetPrices && !inCatalog(l.type, PRICING.assetPrices)) ? ' <span class="q nocat" title="No rate for this item in Control Center — using a default price">price not in catalog</span>' : '';
    rows+=`<div class="prow"><span>${esc(label)} <span class="q">${l.qty>1?l.qty+' × '+inr(l.unit):inr(l.unit)}</span>${flag}</span><span class="amt">${inr(l.cost)}</span></div>`;
  });
  if(otherSet==null && m.layoutBase>0) rows+=`<div class="prow"><span>Layout &amp; setup</span><span class="amt">${inr(m.layoutBase)}</span></div>`;
  if(m.serviceCharge>0) rows+=`<div class="prow"><span>Service <span class="q">${m.svcPct}%</span></span><span class="amt">${inr(m.serviceCharge)}</span></div>`;
  if(!rows) rows='<div class="empty">Add items and pick a menu package to see the price build up.</div>';
  const tax = m.subtotal>0 ? `<div class="prow sub"><span>Subtotal</span><span class="amt">${inr(m.subtotal)}</span></div>`
    + (m.discount>0 ? `<div class="prow"><span>Discount</span><span class="amt">− ${inr(m.discount)}</span></div>` : '')
    + `<div class="prow"><span>${esc(BPStore.tax.resolve(PRICING).name)}${m.taxInclusive?' (included)':''} <span class="q">${m.gstPct}%</span></span><span class="amt">${inr(m.gst)}</span></div>` : '';
  box.innerHTML = rows + tax +
    `<div class="prow total"><span>Total</span><span class="amt">${inr(m.total)}</span></div>`;
  const gd=$('#bGuests'); if(gd && document.activeElement!==gd) gd.placeholder = m.chairs+' (= chairs)';
  const d=$('#pkgDelta'); if(d) d.innerHTML=`Seats in layout: <b>${esc(sumSeats(store.items))}</b> · plates billed: <b>${m.guests}</b>`;
}


/* ---------------------------------------------------------------- store */
const store = {
  items: [],
  selectedId: null,        // primary selection (drives the single-object inspector, resize/rotate, 3D)
  selectedIds: [],         // full multi-selection set
  grid: { snap:true, show:true, unit:'ft', sizeFt:1 },
  margins: { left:0, right:0, top:0, bottom:0 },   // usable-area insets in feet (Excel-style draggable guides)
  venue: { capacity: null },       // planner-set venue max, for the capacity/congestion check
  view: { zoom:1 },
  past: [], future: [],
};
let uid = 1;
/* ---- unsaved-work protection ----
   Dirty = "the document differs from the last saved/opened one". Every edit (2D, 3D gizmo, undo/redo,
   name, capacity) calls markDirty(), which compares a content signature against the saved baseline —
   so undoing back to the saved state is clean again. BPUI's tracker drives the beforeunload warning. */
const dirty = BPUI.trackDirty();
let savedSig = null;   // signature of the last saved / opened document; null = nothing saved yet → any edit is dirty
// Content signature: items + margins + venue + hall size + name. A non-custom colour is theme-derived
// (re-resolved on theme toggle), so it is left out — switching theme never makes the floor "unsaved".
function layoutSig(items, margins, venue, world, name){
  const its=(items||[]).map(it=>{ const c=Object.assign({}, it); if(!c.colorCustom) delete c.color; return c; });
  return JSON.stringify([its, margins||null, venue||null, world?[world.w,world.h]:null, String(name==null?'':name).trim()]);
}
function docSig(){ const pn=$('#projName'); return layoutSig(store.items, store.margins, store.venue, WORLD, pn?pn.value:''); }
function markDirty(){ if(savedSig!==null && docSig()===savedSig){ dirty.clean(); if(typeof clearDraft==='function' && draftReady) clearDraft(); } else { dirty.mark(); if(typeof scheduleDraft==='function') scheduleDraft(); } }
/* ---- local DRAFT (quotes only): a crash-safety copy in this browser. It is NEVER sent to the server and
   never replaces a saved version — on reload the planner is asked whether to restore it. ---- */
let draftReady=false, draftT=null;
const draftKey = id=>'bps.draft.'+userKey()+'.'+id;
function clearDraft(){ clearTimeout(draftT); try{ if(currentQuoteId) localStorage.removeItem(draftKey(currentQuoteId)); }catch{} }
function scheduleDraft(){
  if(RO || !currentQuoteId || !draftReady) return;
  clearTimeout(draftT);
  draftT=setTimeout(()=>{ try{
    const s=JSON.stringify({ savedAt:new Date().toISOString(), baseVersion:currentVersionNo, name:($('#projName').value||'').slice(0,120), data:serialize() });
    if(s.length<=2000000) localStorage.setItem(draftKey(currentQuoteId), s);
  }catch{} }, 3000);
}
function readDraft(id){ try{ const d=JSON.parse(localStorage.getItem(draftKey(id))||'null');
  return d && d.data && Array.isArray(d.data.items) ? d : null; }catch{ return null; } }
async function offerDraftRestore(){
  const d=draftToRestore; draftToRestore=null; draftReady=true;
  if(!d || RO || +d.baseVersion!==+currentVersionNo) { if(d) clearDraft(); return; }
  if(layoutSig(d.data.items,d.data.margins,d.data.venue,d.data.scale&&d.data.scale.worldFt?{w:d.data.scale.worldFt.w,h:d.data.scale.worldFt.h}:WORLD,d.name)===docSig()){ clearDraft(); return; }
  let go=false; try{ go=await BPUI.confirm('An unsaved draft of this quote from '+new Date(d.savedAt).toLocaleString()+' was found in this browser (it was never saved to the server). Restore it? Your saved versions are not changed until you press Save.',{title:'Restore unsaved draft?',okLabel:'Restore draft',cancelLabel:'Discard draft'}); }catch{}
  if(!go){ clearDraft(); return; }
  applyLayout(d.data); if(d.name) $('#projName').value=d.name;
  markDirty(); toast('Draft restored — press Save to keep it');
}
// the document now matches what's stored (just opened or saved). Pass the signature captured when the
// save STARTED so edits made while it was in flight keep the page dirty.
function setSavedBaseline(sig){ savedSig = sig==null ? docSig() : sig; if(docSig()===savedSig) dirty.clean(); else dirty.mark(); }
const nid = () => 'obj_' + (uid++).toString(36) + Date.now().toString(36).slice(-3);

/* ---- selection model (single "primary" + multi set kept in sync) ---- */
function setSelection(ids){
  const valid = ids.filter(id=>store.items.some(i=>i.id===id));
  store.selectedIds = valid;
  store.selectedId = valid.length ? valid[valid.length-1] : null;   // primary = last picked
}
function toggleSelection(id){
  const i = store.selectedIds.indexOf(id);
  if(i>=0) setSelection(store.selectedIds.filter(x=>x!==id));
  else setSelection([...store.selectedIds, id]);
}
const isSelected = id => store.selectedIds.indexOf(id)>=0;
const selectedItems = () => store.items.filter(i=>isSelected(i.id));
const clearSelection = () => setSelection([]);

/* ---- read-only mode (view-only RBAC roles) ---- */
let RO = false;
let layoutLoading = false;   // R4: true while an existing event's layout is being fetched
let CAN_CREATE = true;   // roles without 'create' (e.g. operations) may edit existing but not start new events
function roLockInspector(){ if(!RO) return; const box=$('#inspector'); if(!box) return;
  box.querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=true);
  box.querySelectorAll('.swatches,.aligngrid').forEach(el=>el.style.pointerEvents='none'); }
function applyReadonly(role, customMsg){
  RO = true;
  ['saveBtn','clearBtn','customBtn','importBtn','undoBtn','redoBtn'].forEach(id=>{ const b=$('#'+id); if(b) b.disabled=true; });
  const tb=$('#toolbox'); if(tb){ tb.style.pointerEvents='none'; tb.style.opacity='.45';
    tb.querySelectorAll('.tool').forEach(t=>{ t.tabIndex=-1; t.setAttribute('aria-disabled','true'); }); }
  document.querySelector('.viewport').classList.add('ro');
  const bar=document.createElement('div'); bar.className='robanner';
  if(customMsg) bar.textContent=customMsg;
  else bar.innerHTML='👁 View only — signed in as <b>'+esc(role||'viewer')+'</b>. You can view, open, and export events, but not edit them.';
  document.querySelector('header').insertAdjacentElement('afterend', bar);
}

/* -------------------------------------------------------------- helpers */
const $  = s => document.querySelector(s);
const svg = $('#svg');
const scrollEl = $('#scroll');
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const round1 = v => Math.round(v*10)/10;

/* ---- capacity & congestion model ---- */
const COMFORT_PITCH=2.2, PACKED_PITCH=1.7;                 // ft between chairs: comfortable / packed
const DESIGN_PITCH=2.4;                                     // pitch the auto-arranger designs to (always > COMFORT, so generated blocks are never flagged tight)
const CONG_COLORS=['', '#e8912d', '#e5484d'];              // 0 ok · 1 tight(amber) · 2 packed(red)
function seatPitchFt(it){ const c=Math.max(1,it.properties.cols||1), r=Math.max(1,it.properties.rows||1); return Math.min(it.width/c, it.height/r); }
function congestionOf(it){ if(it.type!=='seatblock'&&it.type!=='chairrow') return 0; const p=seatPitchFt(it); return p<PACKED_PITCH?2:p<COMFORT_PITCH?1:0; }
function totalSeats(){ return store.items.reduce((n,i)=>n+genSeats(i),0); }   // R8b: same per-item seat count the generator uses
function updateCapacityUI(){
  const meter=$('#capMeter'), lbl=$('#capLbl'), banner=$('#capBanner'); if(!meter) return;
  const seats=totalSeats(), cap=store.venue.capacity;
  let tight=0, packed=0; store.items.forEach(it=>{ const c=congestionOf(it); if(c===2)packed++; else if(c===1)tight++; });
  let cls='ok', text;
  if(cap && cap>0){ const pct=Math.round(seats/cap*100); text=`${seats} / ${cap} · ${pct}%`; cls = pct>100?'over':pct>=90?'tight':'ok'; }
  else { text=`${seats} seats`; cls = packed?'over':tight?'tight':'ok'; }
  meter.className='capmeter '+cls;
  meter.style.setProperty('--fill', (cap? Math.min(100, seats/cap*100) : 0)+'%');
  lbl.textContent=text;
  let msg='', bcls='tight';
  if(cap && seats>cap){ msg=`⚠ Over capacity — ${seats} seats vs a ${cap} limit (${Math.round(seats/cap*100)}%). Expect heavy crowding.`; bcls='over'; }
  else if(packed){ msg=`⚠ ${packed} seating block${packed>1?'s':''} packed below ${PACKED_PITCH} ft spacing — very congested.`; bcls='over'; }
  else if(cap && seats>cap*0.9){ msg=`Near capacity — ${seats} of ${cap} seats.`; bcls='tight'; }
  else if(tight){ msg=`${tight} block${tight>1?'s':''} tight (under ${COMFORT_PITCH} ft spacing).`; bcls='tight'; }
  if(msg){ banner.hidden=false; banner.className='capbanner '+bcls; banner.textContent=msg; } else banner.hidden=true;
}

function gridStepFt(){ return store.grid.unit==='m' ? 1/ FT_PER_M * FT_PER_M : 1; } // grid cell always 1 unit
// grid cell size in FEET for the active unit (1 ft, or 1 m expressed in ft)
function cellFt(){ return store.grid.unit==='m' ? FT_PER_M : 1; }
function snapFt(v){ if(!store.grid.snap) return round1(v); const c=cellFt(); return Math.round(v/c)*c; }

// unit conversion for display / inspector
const toU  = ft => store.grid.unit==='m' ? ft/FT_PER_M : ft;
const fromU= u  => store.grid.unit==='m' ? u*FT_PER_M : u;
const fmtU = ft => (Math.round(toU(ft)*100)/100).toString();
const uLabel = () => store.grid.unit==='m' ? 'm' : 'ft';

/* ===================================================================
   HISTORY  (undo / redo)
   =================================================================== */
function snapshot(){ return JSON.stringify(store.items); }
let historyBase = null;              // JSON of the last committed state (what's on screen now)
// call whenever the document is (re)established fresh — nothing to undo before this
function resetHistory(){ historyBase = snapshot(); store.past.length=0; store.future.length=0; syncHistoryButtons(); }
function commit(){
  // mutations happen BEFORE commit(); push the *previous* committed state, then rebaseline
  if(historyBase===null) historyBase = snapshot();
  else {
    store.past.push(historyBase);
    if(store.past.length>100) store.past.shift();
    store.future.length = 0;
    historyBase = snapshot();
  }
  syncHistoryButtons();
  renderState();
  markDirty();
  scheduleAutosave();
}
function isDragging(){ return !!drag || !!(window.__is3DDragging && window.__is3DDragging()); }
function undo(){
  if(isDragging()) return;
  if(!store.past.length) return;
  store.future.push(historyBase);              // current state → redo stack
  historyBase = store.past.pop();              // previous state → current
  store.items = JSON.parse(historyBase);
  ensureSelectionValid();
  syncHistoryButtons(); renderAll(); markDirty(); scheduleAutosave();
  toast('Undo');
}
function redo(){
  if(isDragging()) return;
  if(!store.future.length) return;
  store.past.push(historyBase);
  historyBase = store.future.pop();
  store.items = JSON.parse(historyBase);
  ensureSelectionValid();
  syncHistoryButtons(); renderAll(); markDirty(); scheduleAutosave();
  toast('Redo');
}
function ensureSelectionValid(){
  setSelection(store.selectedIds);   // drops any ids no longer present (e.g. after undo)
}
function syncHistoryButtons(){
  $('#undoBtn').disabled = !store.past.length;
  $('#redoBtn').disabled = !store.future.length;
}

/* ===================================================================
   ITEM CREATION
   =================================================================== */
function makeItem(type, x, y, overrides={}){
  const a = ASSETS[type];
  const it = {
    id:nid(), type, category:a.category,
    x: round1(x), y: round1(y),
    width:a.w, height:a.h, rotation:0,
    label:a.label, color:catColor(a.category),
    properties: a.props ? JSON.parse(JSON.stringify(a.props)) : {},
    ...overrides
  };
  return it;
}
// Items most events only want ONE of — adding a second is usually a slip, so we ask first.
const SINGULAR_ASSETS = new Set(['stage','dancefloor','dj','mandap','caketable','headtable','foh','videowall','piano','redcarpet','fountain']);
async function addAsset(type, atFt){
  const a = ASSETS[type];
  if(SINGULAR_ASSETS.has(type) && store.items.some(it=>it.type===type)){
    const ok = await BPUI.confirm('There’s already a '+a.label+' on this floor. Most events only need one — add another anyway?',
      {title:'Add another '+a.label+'?', okLabel:'Add another', cancelLabel:'Keep just one'});
    if(!ok) return;
  }
  const cx = atFt ? atFt.x : viewCenterFt().x;
  const cy = atFt ? atFt.y : viewCenterFt().y;
  let x = clamp(snapFt(cx - a.w/2), 0, WORLD.w-a.w);
  let y = clamp(snapFt(cy - a.h/2), 0, WORLD.h-a.h);
  const it = makeItem(type, x, y);
  store.items.push(it);
  setSelection([it.id]);
  commit(); renderAll();
  toast(a.label + ' added');
}

/* ===================================================================
   RENDER — SVG scene
   =================================================================== */
const SVGNS='http://www.w3.org/2000/svg';
function el(tag, attrs={}, kids=[]){
  const n=document.createElementNS(SVGNS,tag);
  for(const k in attrs) n.setAttribute(k, attrs[k]);
  kids.forEach(c=>n.appendChild(c));
  return n;
}

function sizeCanvas(){
  const w = WORLD.w*PX_PER_FT*store.view.zoom;
  const h = WORLD.h*PX_PER_FT*store.view.zoom;
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${WORLD.w*PX_PER_FT} ${WORLD.h*PX_PER_FT}`);
}

// The scene is rebuilt from scratch on every change, which would drop keyboard focus
// from a focused canvas item — remember it and put it back on the fresh node.
function focusedObjId(){ const a=document.activeElement; return (a && a.classList && a.classList.contains('obj') && svg.contains(a)) ? a.getAttribute('data-id') : null; }
function restoreObjFocus(id){ if(id==null) return; const n=svg.querySelector('.obj[data-id="'+CSS.escape(String(id))+'"]');
  if(n){ restoringFocus=true; try{ n.focus({preventScroll:true}); }catch(_){ } restoringFocus=false; } }
let restoringFocus=false;
// Excel-style draggable margins: shaded out-of-bounds bands, a dashed usable-area
// outline, and a thin grab strip along each margin line you can drag in/out.
function renderMargins(){
  const m = store.margins || (store.margins={left:0,right:0,top:0,bottom:0});
  const P=PX_PER_FT, W=WORLD.w*P, H=WORLD.h*P;
  const L=m.left*P, R=(WORLD.w-m.right)*P, T=m.top*P, B=(WORLD.h-m.bottom)*P;
  const z=(store.view&&store.view.zoom)||1;
  const g=el('g',{class:'margins'});
  const band=(x,y,w,h)=> el('rect',{x:x,y:y,width:Math.max(0,w),height:Math.max(0,h),fill:'var(--grid-strong)','fill-opacity':0.10,'pointer-events':'none'});
  if(m.left>0)   g.appendChild(band(0,0,L,H));
  if(m.right>0)  g.appendChild(band(R,0,W-R,H));
  if(m.top>0)    g.appendChild(band(0,0,W,T));
  if(m.bottom>0) g.appendChild(band(0,B,W,H-B));
  // usable-area outline
  g.appendChild(el('rect',{x:L,y:T,width:Math.max(0,R-L),height:Math.max(0,B-T),fill:'none',stroke:'var(--c-logistics,#2f74d0)','stroke-width':1.5/z,'stroke-dasharray':(7/z)+' '+(5/z),'pointer-events':'none'}));
  const grab=Math.max(6,14/z);   // grab-strip thickness (≈14 screen px)
  const sw=1.5/z;
  const line=(attrs)=> g.appendChild(el('line',Object.assign({stroke:'var(--c-logistics,#2f74d0)','stroke-width':sw,'pointer-events':'none'},attrs)));
  const strip=(edge,attrs,cursor)=> g.appendChild(el('rect',Object.assign({'data-margin':edge,fill:'transparent',style:'cursor:'+cursor},attrs)));
  if(!RO){
    line({x1:L,y1:0,x2:L,y2:H}); strip('left', {x:L-grab/2,y:0,width:grab,height:H},'ew-resize');
    line({x1:R,y1:0,x2:R,y2:H}); strip('right',{x:R-grab/2,y:0,width:grab,height:H},'ew-resize');
    line({x1:0,y1:T,x2:W,y2:T}); strip('top',  {x:0,y:T-grab/2,width:W,height:grab},'ns-resize');
    line({x1:0,y1:B,x2:W,y2:B}); strip('bottom',{x:0,y:B-grab/2,width:W,height:grab},'ns-resize');
    // visible pips near the ruler edge so the guides are discoverable
    const ps=Math.max(7,9/z); const pip=(x,y,w,h)=> g.appendChild(el('rect',{x:x-w/2,y:y-h/2,width:w,height:h,rx:2/z,fill:'var(--c-logistics,#2f74d0)','pointer-events':'none'}));
    pip(L,ps*1.2,ps,ps*1.7); pip(R,ps*1.2,ps,ps*1.7); pip(ps*1.2,T,ps*1.7,ps); pip(ps*1.2,B,ps*1.7,ps);
  }
  svg.appendChild(g);
}
function renderAll(){
  const refocus=focusedObjId();
  sizeCanvas();
  while(svg.firstChild) svg.removeChild(svg.firstChild);

  // --- grid ---
  const W=WORLD.w*PX_PER_FT, H=WORLD.h*PX_PER_FT;
  svg.appendChild(el('rect',{x:0,y:0,width:W,height:H,fill:'var(--canvas)'}));
  if(store.grid.show){
    const g = el('g');
    const step = cellFt();
    const minor = step*PX_PER_FT;
    // draw minor every cell, major every 10 units
    for(let f=0, n=0; f<=WORLD.w+0.001; f+=step, n++){
      const x=f*PX_PER_FT;
      g.appendChild(el('line',{x1:x,y1:0,x2:x,y2:H,
        stroke: n%10===0?'var(--grid-strong)':'var(--grid)', 'stroke-width': n%10===0?1:0.5}));
    }
    for(let f=0, n=0; f<=WORLD.h+0.001; f+=step, n++){
      const y=f*PX_PER_FT;
      g.appendChild(el('line',{x1:0,y1:y,x2:W,y2:y,
        stroke: n%10===0?'var(--grid-strong)':'var(--grid)', 'stroke-width': n%10===0?1:0.5}));
    }
    svg.appendChild(g);
  }
  // floor border
  svg.appendChild(el('rect',{x:0.5,y:0.5,width:W-1,height:H-1,fill:'none',
    stroke:'var(--grid-strong)','stroke-width':1.5}));

  // --- items ---
  store.items.forEach(it=> svg.appendChild(renderItem(it)));

  // --- draggable margins (guides + shaded out-of-bounds) ---
  renderMargins();

  // --- measurement overlay (2D "Work" mode) ---
  if(showMeasure) svg.appendChild(renderMeasurements());

  // --- selection overlay(s) + marquee ---
  appendSelectionOverlays();

  renderRulers();
  renderInspector();
  renderPrice();
  renderState();
  updateStatus();
  updateCapacityUI();
  updateEmptyState();
  restoreObjFocus(refocus);
  if(window.__on3DStateChange) window.__on3DStateChange();   // keep 3D preview in sync
}

let showMeasure = false;   // 2D "Work" measurement overlay toggle

// Build the measurement overlay: edge-to-edge clearances between neighbouring
// objects (in both directions), plus the selected object's distance to each wall.
// Labels follow the active unit (ft/m) and stay ~screen-constant across zoom.
function renderMeasurements(){
  const P = PX_PER_FT, z = store.view.zoom || 1, s = 1/z;
  const g = el('g', { class:'measure' });
  const boxes = store.items
    .filter(it => it && isFinite(it.x) && isFinite(it.y) && it.width>0 && it.height>0)
    .map(it => ({ it, l:it.x, r:it.x+it.width, t:it.y, b:it.y+it.height, cx:it.x+it.width/2, cy:it.y+it.height/2 }));
  const fmt = ft => (Math.round(toU(ft)*10)/10) + ' ' + uLabel();

  function dim(x1,y1,x2,y2, ft, cls){
    const gg = el('g', cls ? { class:cls } : {});
    gg.appendChild(el('line',{ x1:x1*P,y1:y1*P,x2:x2*P,y2:y2*P, stroke:'currentColor',
      'stroke-width':1*s, 'stroke-dasharray':(3*s)+' '+(2*s), 'stroke-opacity':.85 }));
    const horiz = Math.abs(y1-y2) < 1e-6, tk = 4*s/P;
    const ends = [[x1,y1],[x2,y2]];
    ends.forEach(([x,y]) => gg.appendChild(horiz
      ? el('line',{ x1:x*P,y1:(y-tk)*P,x2:x*P,y2:(y+tk)*P, stroke:'currentColor','stroke-width':1*s,'stroke-opacity':.85 })
      : el('line',{ x1:(x-tk)*P,y1:y*P,x2:(x+tk)*P,y2:y*P, stroke:'currentColor','stroke-width':1*s,'stroke-opacity':.85 })));
    const mx=(x1+x2)/2*P, my=(y1+y2)/2*P, txt=fmt(ft);
    const fs=11*s, wLbl=(txt.length*6.4+8)*s, hLbl=fs+4*s;
    gg.appendChild(el('rect',{ class:'mbg', x:mx-wLbl/2, y:my-hLbl/2, width:wLbl, height:hLbl, rx:3*s, 'stroke-width':.6*s }));
    const t=el('text',{ x:mx, y:my+fs*0.34, 'text-anchor':'middle', 'font-size':fs }); t.textContent=txt;
    gg.appendChild(t);
    return gg;
  }

  const EPS=0.1;
  const yOv=(a,b)=> a.t < b.b-EPS && b.t < a.b-EPS;   // share a vertical band
  const xOv=(a,b)=> a.l < b.r-EPS && b.l < a.r-EPS;   // share a horizontal band

  boxes.forEach(a=>{   // nearest neighbour to the RIGHT
    let best=null, bg=Infinity;
    boxes.forEach(b=>{ if(b===a||!yOv(a,b)) return; const gap=b.l-a.r; if(gap>EPS && gap<bg){ bg=gap; best=b; } });
    if(best){ const y=(Math.max(a.t,best.t)+Math.min(a.b,best.b))/2; g.appendChild(dim(a.r,y,best.l,y,bg)); }
  });
  boxes.forEach(a=>{   // nearest neighbour BELOW
    let best=null, bg=Infinity;
    boxes.forEach(b=>{ if(b===a||!xOv(a,b)) return; const gap=b.t-a.b; if(gap>EPS && gap<bg){ bg=gap; best=b; } });
    if(best){ const x=(Math.max(a.l,best.l)+Math.min(a.r,best.r))/2; g.appendChild(dim(x,a.b,x,best.t,bg)); }
  });

  if(store.selectedIds.length===1){   // selected object → distance from EVERY side (X & Y)
    const a=boxes.find(bx=>bx.it.id===store.selectedId);
    if(a){
      // 4 wall clearances (to the floor edges)
      if(a.l>EPS)         g.appendChild(dim(0,a.cy,a.l,a.cy,a.l,'wall'));
      if(WORLD.w-a.r>EPS) g.appendChild(dim(a.r,a.cy,WORLD.w,a.cy,WORLD.w-a.r,'wall'));
      if(a.t>EPS)         g.appendChild(dim(a.cx,0,a.cx,a.t,a.t,'wall'));
      if(WORLD.h-a.b>EPS) g.appendChild(dim(a.cx,a.b,a.cx,WORLD.h,WORLD.h-a.b,'wall'));
      // nearest neighbour on each of the four sides (full left/right/up/down spacing)
      const others=boxes.filter(b=>b!==a);
      let L=null,lg=Infinity,R=null,rg=Infinity,U=null,ug=Infinity,D=null,dg=Infinity;
      others.forEach(b=>{
        if(yOv(a,b)){ const gl=a.l-b.r; if(gl>EPS&&gl<lg){lg=gl;L=b;} const gr=b.l-a.r; if(gr>EPS&&gr<rg){rg=gr;R=b;} }
        if(xOv(a,b)){ const gu=a.t-b.b; if(gu>EPS&&gu<ug){ug=gu;U=b;} const gd=b.t-a.b; if(gd>EPS&&gd<dg){dg=gd;D=b;} }
      });
      if(L){ const y=(Math.max(a.t,L.t)+Math.min(a.b,L.b))/2; g.appendChild(dim(L.r,y,a.l,y,lg)); }
      if(R){ const y=(Math.max(a.t,R.t)+Math.min(a.b,R.b))/2; g.appendChild(dim(a.r,y,R.l,y,rg)); }
      if(U){ const x=(Math.max(a.l,U.l)+Math.min(a.r,U.r))/2; g.appendChild(dim(x,U.b,x,a.t,ug)); }
      if(D){ const x=(Math.max(a.l,D.l)+Math.min(a.r,D.r))/2; g.appendChild(dim(x,a.b,x,D.t,dg)); }
    }
  }
  return g;
}

function renderItem(it){
  const w=it.width*PX_PER_FT, h=it.height*PX_PER_FT;
  const cx=(it.x+it.width/2)*PX_PER_FT, cy=(it.y+it.height/2)*PX_PER_FT;
  const g = el('g',{ class:'obj', transform:`translate(${cx} ${cy}) rotate(${it.rotation})`, 'data-id':it.id,
    tabindex:'0', role:'button', 'aria-pressed':String(isSelected(it.id)),
    'aria-label':(it.label||'Object')+' — '+((ASSETS[it.type]&&ASSETS[it.type].label)||it.type||'object') });
  const c = it.color;
  const fillSoft = `color-mix(in srgb, ${c} 16%, var(--canvas))`;

  // invisible hitbox (a hair larger) for easy grabbing + hover ring
  g.appendChild(el('rect',{class:'hitbox', x:-w/2, y:-h/2, width:w, height:h, rx:2,
    fill:'transparent', stroke:'transparent','stroke-width':2}));

  const body = el('g',{class:'body'});

  const drawBox = (opts={})=> body.appendChild(el('rect',{
    x:-w/2,y:-h/2,width:w,height:h, rx:opts.rx??3,
    fill:opts.fill??fillSoft, stroke:c,'stroke-width':opts.sw??1.5,
    'stroke-dasharray':opts.dash??''}));

  switch(it.type){
    case 'stage': case 'dancefloor': {
      drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`, rx:3});
      if(it.type==='dancefloor'){ // checker hint
        body.appendChild(el('line',{x1:-w/2,y1:0,x2:w/2,y2:0,stroke:c,'stroke-width':.75,'stroke-opacity':.5}));
        body.appendChild(el('line',{x1:0,y1:-h/2,x2:0,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.5}));
      }
      break; }
    case 'press': case 'desk': case 'truck': case 'booth': case 'exit': {
      drawBox({});
      if(it.type==='exit'){
        body.appendChild(el('path',{d:`M ${-w/6} 0 L ${w/6} 0 M ${w/6-5} -4 L ${w/6} 0 L ${w/6-5} 4`,
          stroke:c,'stroke-width':2,fill:'none','stroke-linecap':'round','stroke-linejoin':'round'}));
      }
      break; }
    case 'podium': {
      drawBox({rx:2,fill:c});
      break; }
    case 'barricade': case 'fence': {
      drawBox({fill:'transparent',dash: it.type==='fence'?'2 3':'', sw:2});
      // hatch
      const step=8;
      for(let x=-w/2; x<w/2; x+=step)
        body.appendChild(el('line',{x1:x,y1:-h/2,x2:Math.min(x+step,w/2),y2:h/2,stroke:c,'stroke-width':1,'stroke-opacity':.7}));
      break; }
    case 'dj': { drawBox({fill:c,rx:2}); break; }
    case 'chairrow': case 'seatblock': {
      const cong=congestionOf(it), dotC=CONG_COLORS[cong]||c;   // amber/red when tight/packed
      drawBox({fill:'transparent',dash:'4 3',sw:1, ...(cong?{}:{})});
      const rows=Math.max(1, it.properties.rows|0), cols=Math.max(1, it.properties.cols|0);
      // cap drawn dots for very dense blocks (subsample but keep full coverage) — perf
      const CAP=450; let dr=rows, dc=cols;
      if(rows*cols>CAP){ const s=Math.sqrt(CAP/(rows*cols)); dr=Math.max(1,Math.round(rows*s)); dc=Math.max(1,Math.round(cols*s)); }
      const r = Math.min(w/dc, h/dr)*0.30;
      for(let ri=0;ri<dr;ri++)for(let ci=0;ci<dc;ci++){
        const px=-w/2 + (ci+0.5)/dc*w;
        const py=-h/2 + (ri+0.5)/dr*h;
        body.appendChild(el('circle',{cx:px,cy:py,r:clamp(r,1,4.2),fill:dotC,'fill-opacity':.85}));
      }
      break; }
    case 'longtable': case 'headtable': {
      drawBox({fill:fillSoft});
      const seats=Math.max(0, it.properties.seats|0);
      const oneSide = it.type==='headtable';
      const perSide = oneSide ? seats : Math.ceil(seats/2);
      const place=(n,yy)=>{ for(let i=0;i<n;i++){ const px=-w/2+(i+0.5)/n*w;
        body.appendChild(el('circle',{cx:px,cy:yy,r:clamp(Math.min(w/seats,6)*0.5,1.5,3.4),fill:c,'fill-opacity':.85})); } };
      place(perSide, -h/2-3.2);
      if(!oneSide) place(seats-perSide, h/2+3.2);
      break; }
    case 'canopy': {
      drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:2, dash:'6 4', sw:1.5});
      // draped roof diagonals + corner posts
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:w/2,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.4}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:-w/2,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.4}));
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sxx,syy])=>
        body.appendChild(el('circle',{cx:sxx*(w/2-3),cy:syy*(h/2-3),r:2.4,fill:c})));
      break; }
    case 'tent': {
      drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:-w/2,y1:h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      body.appendChild(el('line',{x1:w/2,y1:h/2,x2:0,y2:0,stroke:c,'stroke-width':1,'stroke-opacity':.5}));
      break; }
    case 'arch': {
      body.appendChild(el('path',{d:`M ${-w/2} ${h/2} Q 0 ${-h/2-6} ${w/2} ${h/2}`,fill:'none',stroke:c,'stroke-width':2.5}));
      break; }
    case 'bar': case 'buffet': {
      drawBox({fill:`color-mix(in srgb, ${c} 20%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/6,x2:w/2,y2:-h/6,stroke:c,'stroke-width':1,'stroke-opacity':.6}));
      break; }
    case 'lounge': {
      drawBox({fill:fillSoft,rx:4});
      // sofa hint
      body.appendChild(el('rect',{x:-w/2+3,y:-h/2+3,width:w-6,height:h*0.32,rx:3,fill:c,'fill-opacity':.55}));
      break; }
    case 'checkpoint': { drawBox({fill:c,rx:2}); break; }
    case 'table': case 'cocktail': {
      const rad=Math.min(w,h)/2;
      if(it.properties && it.properties.shape==='square')
        body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      else
        body.appendChild(el('circle',{cx:0,cy:0,r:rad,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      const seats=Math.max(0, it.properties.seats|0);
      for(let s=0;s<seats;s++){
        const ang=s/seats*Math.PI*2 - Math.PI/2;
        body.appendChild(el('circle',{cx:Math.cos(ang)*(rad+3.5),cy:Math.sin(ang)*(rad+3.5),r:2.6,fill:c,'fill-opacity':.85}));
      }
      break; }
    case 'ledscreen': { drawBox({fill:c,rx:1}); break; }
    case 'redcarpet': { drawBox({fill:`color-mix(in srgb, ${c} 30%, var(--canvas))`,rx:1});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2+2,x2:-w/2,y2:h/2-2,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2+2,x2:w/2,y2:h/2-2,stroke:c,'stroke-width':1.5})); break; }
    case 'planter': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/6,fill:c,'fill-opacity':.6})); break; }
    case 'truss': { drawBox({fill:'transparent',sw:1.5});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:w/2,y2:h/2,stroke:c,'stroke-width':1}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:-w/2,y2:h/2,stroke:c,'stroke-width':1})); break; }
    case 'parking': { drawBox({fill:'transparent',dash:'5 4',sw:1.5});
      for(let x=-w/2+8;x<w/2;x+=10) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.5,'stroke-opacity':.5})); break; }
    case 'firstaid': { drawBox({fill:fillSoft});
      body.appendChild(el('path',{d:`M 0 ${-h/4} V ${h/4} M ${-w/4} 0 H ${w/4}`,stroke:c,'stroke-width':2.5,'stroke-linecap':'round'})); break; }
    case 'sofa': case 'loveseat': case 'armchair': case 'bench': {
      drawBox({fill:fillSoft,rx:4});
      body.appendChild(el('rect',{x:-w/2+2,y:-h/2+2,width:w-4,height:h*0.34,rx:3,fill:c,'fill-opacity':.5})); break; }   // backrest hint
    case 'coffeetable': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`,rx:3}); break; }
    case 'ottoman': case 'floral': case 'pillar': case 'heater': case 'uplight': {
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      if(it.type==='floral') body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/4,fill:c,'fill-opacity':.6}));
      break; }
    case 'fountain': {
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/4,fill:'none',stroke:c,'stroke-width':1,'stroke-opacity':.6})); break; }
    case 'floralarch': {
      body.appendChild(el('path',{d:`M ${-w/2} ${h/2} Q 0 ${-h/2-6} ${w/2} ${h/2}`,fill:'none',stroke:c,'stroke-width':3}));
      [-w/2,0,w/2].forEach(x=>body.appendChild(el('circle',{cx:x,cy: x===0?-h/2-4:h/2-2,r:2.4,fill:c}))); break; }
    case 'mandap': {
      drawBox({fill:`color-mix(in srgb, ${c} 16%, var(--canvas))`, rx:2, dash:'6 4', sw:1.5});
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sxx,syy])=>body.appendChild(el('circle',{cx:sxx*(w/2-3),cy:syy*(h/2-3),r:2.4,fill:c})));
      body.appendChild(el('line',{x1:-w/2,y1:-h/2,x2:w/2,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.4}));
      body.appendChild(el('line',{x1:w/2,y1:-h/2,x2:-w/2,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.4})); break; }
    case 'drape': { drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`});
      for(let x=-w/2+3;x<w/2;x+=4) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.5})); break; }
    case 'chandelier': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:'none',stroke:c,'stroke-width':1.5,'stroke-dasharray':'3 2'}));
      body.appendChild(el('circle',{cx:0,cy:0,r:2.5,fill:c})); break; }
    case 'easel': { drawBox({fill:fillSoft}); break; }
    case 'chiavari': { drawBox({fill:fillSoft,rx:2});
      body.appendChild(el('line',{x1:-w/2+2,y1:-h/2+2,x2:w/2-2,y2:-h/2+2,stroke:c,'stroke-width':2})); break; }
    case 'barstool': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/5,fill:c,'fill-opacity':.5})); break; }
    case 'piano': {
      body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/4} ${-h/2} Q ${w/2} ${-h/2} ${w/2} 0 Q ${w/2} ${h/2} ${w/6} ${h/2} L ${-w/2} ${h/2} Z`,
        fill:`color-mix(in srgb, ${c} 32%, var(--canvas))`,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('rect',{x:-w/2,y:h/2-3,width:w*0.5,height:3,fill:c,'fill-opacity':.55})); break; }
    case 'bleacher': { drawBox({fill:'transparent',sw:1.5});
      for(let i=1;i<4;i++) body.appendChild(el('line',{x1:-w/2,y1:-h/2+i*(h/4),x2:w/2,y2:-h/2+i*(h/4),stroke:c,'stroke-width':1.5,'stroke-opacity':.7})); break; }
    default: drawBox({});
  }
  g.appendChild(body);

  // label (counter-rotated so it stays upright)
  const fs = clamp(Math.min(w,h)*0.16, 7, 11);
  const t = el('text',{class:'lbl', x:0, y: (it.type==='table'||it.type==='cocktail')?3:fs*0.35,
    'text-anchor':'middle','font-size':fs, transform:`rotate(${-it.rotation})`});
  t.textContent = it.label;
  g.appendChild(t);

  return g;
}

function renderSelection(it){
  const w=it.width*PX_PER_FT, h=it.height*PX_PER_FT;
  const cx=(it.x+it.width/2)*PX_PER_FT, cy=(it.y+it.height/2)*PX_PER_FT;
  const g = el('g',{transform:`translate(${cx} ${cy}) rotate(${it.rotation})`, 'data-sel':'1'});
  g.appendChild(el('rect',{class:'sel-outline', x:-w/2-2,y:-h/2-2,width:w+4,height:h+4,rx:3}));
  // corner resize handles (scale both dimensions)
  const corners=[[-1,-1],[1,-1],[1,1],[-1,1]];
  corners.forEach(([sx,sy])=>{
    g.appendChild(el('rect',{class:'handle','data-handle':'resize', x:sx*w/2-4, y:sy*h/2-4, width:8,height:8, rx:1.5}));
  });
  // edge handles → grab a side and stretch ONE dimension (extend carpets, aisles, fences, trusses)
  if(it.type!=='table' && it.type!=='cocktail'){       // round items stay circular, no edge stretch
    const edges=[[0,-1,'y','ns-resize'],[1,0,'x','ew-resize'],[0,1,'y','ns-resize'],[-1,0,'x','ew-resize']];
    edges.forEach(([sx,sy,axis,cur])=>{
      g.appendChild(el('rect',{class:'handle edge','data-handle':'resize','data-axis':axis,
        x:sx*w/2-4, y:sy*h/2-4, width:8,height:8, rx:1.5, style:'cursor:'+cur}));
    });
  }
  // rotate handle
  g.appendChild(el('line',{class:'rot-line', x1:0,y1:-h/2-2, x2:0, y2:-h/2-22}));
  g.appendChild(el('circle',{class:'rot-handle','data-handle':'rotate', cx:0, cy:-h/2-22, r:5}));
  return g;
}
// light dashed outline for members of a multi-selection (no resize/rotate handles)
function renderOutline(it){
  const w=it.width*PX_PER_FT, h=it.height*PX_PER_FT;
  const cx=(it.x+it.width/2)*PX_PER_FT, cy=(it.y+it.height/2)*PX_PER_FT;
  const g=el('g',{transform:`translate(${cx} ${cy}) rotate(${it.rotation})`,'data-selo':'1'});
  g.appendChild(el('rect',{class:'sel-outline',x:-w/2-2,y:-h/2-2,width:w+4,height:h+4,rx:3}));
  return g;
}
function renderMarquee(r){
  const x=Math.min(r.x0,r.x1)*PX_PER_FT, y=Math.min(r.y0,r.y1)*PX_PER_FT;
  const w=Math.abs(r.x1-r.x0)*PX_PER_FT, h=Math.abs(r.y1-r.y0)*PX_PER_FT;
  return el('rect',{class:'marquee',x,y,width:w,height:h});
}
function appendSelectionOverlays(){
  const n=store.selectedIds.length;
  if(n===1){ const it=selected(); if(it) svg.appendChild(renderSelection(it)); }
  else if(n>1){ selectedItems().forEach(it=>svg.appendChild(renderOutline(it))); }
  if(drag && drag.mode==='marquee' && drag.rect) svg.appendChild(renderMarquee(drag.rect));
}

/* ===================================================================
   RULERS  (canvas strips, redrawn on scroll / zoom)
   =================================================================== */
const rTop=$('#rulerTop'), rLeft=$('#rulerLeft');
function renderRulers(){
  const dpr=window.devicePixelRatio||1;
  const vw=scrollEl.clientWidth, vh=scrollEl.clientHeight;
  const z=store.view.zoom, ppuFt=PX_PER_FT*z;         // px per foot on screen
  const cell=cellFt();                                // feet per grid unit
  const css=getComputedStyle(document.documentElement);
  const inkc=css.getPropertyValue('--ink-3').trim();
  const linec=css.getPropertyValue('--line').trim();
  const strong=css.getPropertyValue('--grid-strong').trim();

  function prep(cv,w,h){ cv.width=w*dpr; cv.height=h*dpr; cv.style.width=w+'px'; cv.style.height=h+'px';
    const x=cv.getContext('2d'); x.setTransform(dpr,0,0,dpr,0,0); x.clearRect(0,0,w,h); return x; }

  // TOP ruler
  const ctxT=prep(rTop, vw, 26);
  ctxT.font='9px "IBM Plex Mono", monospace'; ctxT.textBaseline='alphabetic';
  const sx=scrollEl.scrollLeft;
  let unitIndex=0;
  for(let f=0; f<=WORLD.w+0.001; f+=cell, unitIndex++){
    const px=f*ppuFt - sx;
    if(px<-20||px>vw+20) continue;
    const major = unitIndex%10===0;
    ctxT.strokeStyle=major?strong:linec; ctxT.beginPath();
    ctxT.moveTo(px, major?12:18); ctxT.lineTo(px,26); ctxT.stroke();
    if(major){ ctxT.fillStyle=inkc; ctxT.fillText(Math.round(f/cell*10)/10, px+2, 10); }
  }
  // LEFT ruler
  const ctxL=prep(rLeft, 26, vh);
  ctxL.font='9px "IBM Plex Mono", monospace';
  const sy=scrollEl.scrollTop;
  unitIndex=0;
  for(let f=0; f<=WORLD.h+0.001; f+=cell, unitIndex++){
    const py=f*ppuFt - sy;
    if(py<-20||py>vh+20) continue;
    const major=unitIndex%10===0;
    ctxL.strokeStyle=major?strong:linec; ctxL.beginPath();
    ctxL.moveTo(major?12:18, py); ctxL.lineTo(26, py); ctxL.stroke();
    if(major){ ctxL.save(); ctxL.fillStyle=inkc; ctxL.translate(9, py+2); ctxL.rotate(-Math.PI/2);
      ctxL.fillText(Math.round(f/cell*10)/10, -0, 8); ctxL.restore(); }
  }
}

/* ===================================================================
   INSPECTOR
   =================================================================== */
const selected = ()=> store.items.find(i=>i.id===store.selectedId)||null;
const SWATCH_CATS=['structure','seating','av','security','logistics','safety','decor'];
// curated event-design colourway for the per-object colour picker (linens, woods, florals, metals)
const COLORWAYS=['#ffffff','#f3ede1','#e9dcc3','#c9a06a','#8a5a2b','#d4af37','#e8b4c0','#b0577a',
  '#9caf88','#3f6b52','#2f6fed','#26324f','#7c5cff','#8a1f2d','#e5484d','#e8912d','#2a2f3a','#0f766e'];
const HEXRE=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const toHexColor=(c)=>{ c=(c||'').trim(); if(HEXRE.test(c)){ if(c.length===4) c='#'+c[1]+c[1]+c[2]+c[2]+c[3]+c[3]; return c.toLowerCase(); } return '#cccccc'; };

function renderMultiInspector(box){
  const items=selectedItems(), n=items.length;
  let chairs=sumSeats(items), tables=0; items.forEach(i=>{
    if(['table','longtable','cocktail','headtable'].includes(i.type)) tables++; });
  box.innerHTML=`
    <div class="isec">
      <span class="itag" style="--tag:var(--accent)">${n} selected</span>
      <div class="coordbox" style="margin-top:10px"><span>objects</span> ${n}${tables?` &nbsp;·&nbsp; <span>tables</span> ${tables}`:''}${chairs?` &nbsp;·&nbsp; <span>seats</span> ${chairs}`:''}</div>
      <div class="imultihint">Drag any selected object to move them together. Arrows nudge · <b>R</b> rotates each · <b>⌘C/⌘V</b> copy/paste.</div>
    </div>
    <div class="isec">
      <span class="ilabel-block" id="alignLbl">Align &amp; distribute</span>
      <div class="aligngrid" role="group" aria-labelledby="alignLbl">
        <button type="button" data-a="left" title="Align left" aria-label="Align left">⇤</button><button type="button" data-a="hcenter" title="Center horizontally" aria-label="Center horizontally">⇔</button><button type="button" data-a="right" title="Align right" aria-label="Align right">⇥</button>
        <button type="button" data-a="top" title="Align top" aria-label="Align top">⤒</button><button type="button" data-a="vcenter" title="Center vertically" aria-label="Center vertically">⇕</button><button type="button" data-a="bottom" title="Align bottom" aria-label="Align bottom">⤓</button>
        <button type="button" data-a="hdist" title="Distribute across" aria-label="Distribute across">⋯</button><button type="button" data-a="vdist" title="Distribute down" aria-label="Distribute down">⋮</button>
      </div>
    </div>
    <div class="ibtns">
      <button type="button" id="m_dup">⧉ Duplicate</button>
      <button type="button" id="m_copy">⧉ Copy</button>
      <button type="button" id="m_front">↑ Bring Front</button>
      <button type="button" class="del" id="m_del">🗑 Delete</button>
    </div>`;
  box.querySelectorAll('.aligngrid button').forEach(b=>b.addEventListener('click',()=>alignSelection(b.dataset.a)));
  $('#m_dup').addEventListener('click',duplicateSelection);
  $('#m_copy').addEventListener('click',copySelection);
  $('#m_front').addEventListener('click',()=>{ const set=new Set(store.selectedIds);
    const sel=store.items.filter(i=>set.has(i.id)); store.items=store.items.filter(i=>!set.has(i.id)).concat(sel);
    commit(); renderAll(); });
  $('#m_del').addEventListener('click',deleteSelected);
  roLockInspector();
}
function alignSelection(mode){
  const items=selectedItems(); if(items.length<2) return;
  const minX=Math.min(...items.map(i=>i.x)), maxX=Math.max(...items.map(i=>i.x+i.width));
  const minY=Math.min(...items.map(i=>i.y)), maxY=Math.max(...items.map(i=>i.y+i.height));
  const cX=(minX+maxX)/2, cY=(minY+maxY)/2;
  if(mode==='left') items.forEach(i=>i.x=minX);
  else if(mode==='right') items.forEach(i=>i.x=maxX-i.width);
  else if(mode==='hcenter') items.forEach(i=>i.x=round1(cX-i.width/2));
  else if(mode==='top') items.forEach(i=>i.y=minY);
  else if(mode==='bottom') items.forEach(i=>i.y=maxY-i.height);
  else if(mode==='vcenter') items.forEach(i=>i.y=round1(cY-i.height/2));
  else if(mode==='hdist'&&items.length>2){ const s=[...items].sort((a,b)=>a.x-b.x);
    const gap=((maxX-minX)-s.reduce((t,i)=>t+i.width,0))/(s.length-1); let x=minX; s.forEach(i=>{ i.x=round1(x); x+=i.width+gap; }); }
  else if(mode==='vdist'&&items.length>2){ const s=[...items].sort((a,b)=>a.y-b.y);
    const gap=((maxY-minY)-s.reduce((t,i)=>t+i.height,0))/(s.length-1); let y=minY; s.forEach(i=>{ i.y=round1(y); y+=i.height+gap; }); }
  items.forEach(i=>{ i.x=clamp(i.x,0,WORLD.w-i.width); i.y=clamp(i.y,0,WORLD.h-i.height); });
  commit(); renderAll();
}
function renderInspector(){
  const box=$('#inspector'); const it=selected();
  if(store.selectedIds.length>1){ renderMultiInspector(box); return; }
  if(!it){
    box.innerHTML=`<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
      <p>Select an object on the floor to inspect and edit its dimensions, position, and rotation.</p>
      <p style="margin-top:10px;font-size:12px">Tip: <b>drag</b> on empty floor to marquee-select · <b>Shift-click</b> to add · <b>⌘A/⌘C/⌘V</b> select/copy/paste.</p>
    </div>`;
    return;
  }
  const u=uLabel();
  const catBadge=`<span class="itag" style="--tag:${esc(toHexColor(it.color))}">${CATS[it.category].name}</span>`;
  const typeSpec = renderTypeSpecific(it);

  box.innerHTML = `
    <div class="isec">
      ${catBadge}
      <div class="irow" style="margin-top:10px">
        <div class="ifield"><label for="f_label">Label</label><input type="text" id="f_label" value="${escapeHtml(it.label)}"></div>
      </div>
    </div>
    <div class="isec">
      <div class="irow">
        <div class="ifield"><label for="f_x">X position</label><div class="unit" data-u="${u}"><input type="number" id="f_x" step="0.5" value="${fmtU(it.x)}"></div></div>
        <div class="ifield"><label for="f_y">Y position</label><div class="unit" data-u="${u}"><input type="number" id="f_y" step="0.5" value="${fmtU(it.y)}"></div></div>
      </div>
      <div class="irow">
        <div class="ifield"><label for="f_w">Width</label><div class="unit" data-u="${u}"><input type="number" id="f_w" step="0.5" min="0.5" value="${fmtU(it.width)}"></div></div>
        <div class="ifield"><label for="f_h">Height</label><div class="unit" data-u="${u}"><input type="number" id="f_h" step="0.5" min="0.5" value="${fmtU(it.height)}"></div></div>
      </div>
      <div class="rotrow">
        <label for="f_rot">Rotate</label>
        <input type="range" id="f_rot" min="0" max="359" value="${Math.round(it.rotation)}">
        <span class="rotval" id="rotVal">${Math.round(it.rotation)}°</span>
      </div>
      ${typeSpec}
      <div class="seclabel" id="catLbl">Category</div>
      <div class="swatches" id="swatches" role="group" aria-labelledby="catLbl">
        ${SWATCH_CATS.map(k=>`<button type="button" class="sw ${it.category===k?'on':''}" data-cat="${k}" style="background:${esc(catColor(k))}" title="${CATS[k].name}" aria-label="Category: ${CATS[k].name}" aria-pressed="${it.category===k}"></button>`).join('')}
      </div>
      <div class="seclabel">Colour <span class="cn" id="colorName">${esc(toHexColor(it.color).toUpperCase())}</span></div>
      <div class="colorrow">
        <input type="color" id="f_color" value="${esc(toHexColor(it.color))}" title="Pick any colour" aria-label="Custom colour">
        <div class="palette" id="palette" role="group" aria-label="Colour palette">
          ${COLORWAYS.map(c=>`<button type="button" class="pc ${toHexColor(it.color)===c?'on':''}" data-c="${c}" style="background:${c}" title="${c}" aria-label="Colour ${c}" aria-pressed="${toHexColor(it.color)===c}"></button>`).join('')}
        </div>
      </div>
      <div class="colorbtns">
        <button type="button" id="b_color_all" title="Apply this colour to every ${esc(it.type)} on the floor">Apply to all like this</button>
        <button type="button" id="b_color_reset" title="Reset to the category colour">Reset</button>
      </div>
      <div class="coordbox">
        <span>id</span> ${esc(it.id)}<br>
        <span>area</span> ${Math.round(it.width*it.height)} ft² &nbsp; · &nbsp; <span>footprint</span> ${fmtU(it.width)}×${fmtU(it.height)} ${u}
      </div>
      <div class="modelrow">
        <label for="f_model">3D model (.glb / .gltf URL)</label>
        <div class="modelin">
          <input type="text" id="f_model" placeholder="paste a GLB from Sloyd / Meshy / Tripo…" value="${escapeHtml(it.properties&&it.properties.model?it.properties.model:'')}">
          <button type="button" id="b_model_clear" title="Remove custom model" aria-label="Remove custom model">✕</button>
        </div>
        <small>Renders in 3D View. Any glTF/GLB works — export from Sloyd, Meshy, Tripo3D, or a HF space.</small>
      </div>
    </div>
    <div class="ibtns">
      <button type="button" id="b_dup">⧉ Duplicate</button>
      <button type="button" id="b_front">↑ Bring Front</button>
      <button type="button" id="b_center">⊹ Center</button>
      <button type="button" class="del" id="b_del">🗑 Delete</button>
    </div>`;

  wireInspector(it);
}

function renderTypeSpecific(it){
  if(it.type==='seatblock'||it.type==='chairrow'){
    const seats=(it.properties.rows||1)*(it.properties.cols||1);
    const pitch=it.properties.pitch||round1(Math.min(it.width/Math.max(1,it.properties.cols||1), it.height/Math.max(1,it.properties.rows||1)));
    return `<div class="irow" style="margin-top:11px">
      <div class="ifield"><label for="f_rows">Rows</label><input type="number" id="f_rows" min="1" max="80" value="${Number(it.properties.rows)||1}"></div>
      <div class="ifield"><label for="f_cols">Cols / row</label><input type="number" id="f_cols" min="1" max="120" value="${Number(it.properties.cols)||1}"></div>
      <div class="ifield"><label for="f_seatcount">Seats</label><input type="text" id="f_seatcount" value="${Number(seats)||0}" disabled style="opacity:.7"></div>
    </div>
    <div class="fwarn" id="f_seatwarn" role="alert" hidden></div>
    <div class="irow" style="margin-top:9px">
      <div class="ifield"><label for="f_pitch">Spacing</label><div class="unit" data-u="${uLabel()}"><input type="number" id="f_pitch" step="0.1" min="1.4" value="${fmtU(pitch)}"></div></div>
      <div class="ifield" style="flex:2"><div class="pitchnote">Chairs stay equidistant — rows/cols add or remove seats, the block resizes to keep the gap.</div></div>
    </div>`;
  }
  if(it.type==='table'){
    return `<div class="irow" style="margin-top:11px">
      <div class="ifield"><label for="f_seats">Seats around</label><input type="number" id="f_seats" min="0" max="24" value="${Number(it.properties.seats)||0}"></div>
      <div class="ifield"><label for="f_dia">Diameter</label><div class="unit" data-u="${uLabel()}"><input type="number" id="f_dia" step="0.5" min="1" value="${fmtU(it.width)}"></div></div>
    </div>`;
  }
  return '';
}
// keep chairs equidistant: footprint = rows/cols × spacing, so changing a count
// adds/removes chairs and resizes the block instead of squeezing the gap.
function resizeSeatGrid(it){
  const cols=Math.max(1,it.properties.cols||1), rows=Math.max(1,it.properties.rows||1);
  let p=it.properties.pitch;
  if(!p){ p=round1(Math.min(it.width/cols, it.height/rows)); it.properties.pitch = p = clamp(p||2.4,1.4,12); }
  it.width  = clamp(cols*p, 0.5, WORLD.w);
  it.height = clamp(rows*p, 0.5, WORLD.h);
  it.x = clamp(it.x, 0, WORLD.w-it.width);
  it.y = clamp(it.y, 0, WORLD.h-it.height);
}

function wireInspector(it){
  const upd=(fn,rec)=>{ fn(); if(rec) commit(); renderAll(); };
  const live=(id,handler)=>{ const e=$('#'+id); if(!e)return;
    e.addEventListener('input',()=>handler(e.value,false));
    e.addEventListener('change',()=>handler(e.value,true)); };

  $('#f_label').addEventListener('input',e=>{ it.label=e.target.value; renderItemInPlace(it); renderState(); });
  $('#f_label').addEventListener('change',()=>commit());

  const num=(id,apply)=> live(id,(v,rec)=>{
    const n=parseFloat(v); if(isNaN(n))return;
    apply(n);
    if(rec){ commit(); renderAll(); }   // committed (blur/Enter): full sync; rebuilding the inspector is fine
    else { renderSceneOnly(); }          // live typing: update the scene but keep the focused field intact
  });

  num('f_x', n=> it.x = clamp(fromU(n),0,WORLD.w-it.width));
  num('f_y', n=> it.y = clamp(fromU(n),0,WORLD.h-it.height));
  num('f_w', n=> { it.width=clamp(fromU(n),0.5,WORLD.w); it.x=clamp(it.x,0,WORLD.w-it.width); });
  num('f_h', n=> { it.height=clamp(fromU(n),0.5,WORLD.h); it.y=clamp(it.y,0,WORLD.h-it.height); });

  const rot=$('#f_rot');
  rot.addEventListener('input',e=>{ const rv=+e.target.value; if(!isFinite(rv))return; it.rotation=rv; $('#rotVal').textContent=it.rotation+'°'; renderSceneOnly(); });
  rot.addEventListener('change',()=>{ commit(); renderAll(); });

  // Seat-grid fields validate and apply on blur/Enter (never destructively resize mid-typing,
  // never let an empty/0 value collapse the block — it just shows a warning and reverts).
  const seatWarn=$('#f_seatwarn');
  function showWarn(msg){ if(seatWarn){ seatWarn.textContent=msg; seatWarn.hidden=!msg; } }
  function seatField(id, opts, applyFn){
    const e=$('#'+id); if(!e) return;
    const parse=v=> opts.int ? parseInt(v,10) : parseFloat(v);
    const bad=v=> v.trim()==='' || isNaN(parse(v)) || parse(v)<opts.min;
    e.addEventListener('input',()=>{ showWarn(bad(e.value)?opts.msg:''); });
    const commitField=()=>{
      if(bad(e.value)){ renderInspector();                                 // revert the field to its current valid value
        const w=$('#f_seatwarn'); if(w){ w.textContent=opts.msg; w.hidden=false; } return; }  // then keep the warning visible
      const n=clamp(parse(e.value), opts.min, opts.max);
      // lock the current spacing from the pre-change geometry so row/col edits keep the gap
      if(it.properties.pitch==null) it.properties.pitch=round1(Math.min(
        it.width/Math.max(1,it.properties.cols||1), it.height/Math.max(1,it.properties.rows||1)));
      applyFn(n); resizeSeatGrid(it); showWarn(''); commit(); renderAll();
    };
    e.addEventListener('change', commitField);
    e.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); e.blur(); } });
  }
  seatField('f_rows', {min:1,max:80,int:true,msg:'Rows must be at least 1.'},   n=> it.properties.rows=n);
  seatField('f_cols', {min:1,max:120,int:true,msg:'Columns must be at least 1.'}, n=> it.properties.cols=n);
  seatField('f_pitch',{min:1.4,max:12,int:false,msg:'Spacing must be at least 1.4 ft.'}, n=> it.properties.pitch=fromU(n));
  if($('#f_seats'))num('f_seats',n=> it.properties.seats=clamp(Math.round(n),0,24));
  if($('#f_dia')) num('f_dia', n=>{ const d=clamp(fromU(n),1,WORLD.w); it.width=d; it.height=d; });

  $('#swatches').querySelectorAll('.sw').forEach(sw=>sw.addEventListener('click',()=>{
    it.category=sw.dataset.cat; it.color=catColor(it.category); it.colorCustom=false; commit(); renderAll();
  }));

  // ---- per-object colour picker (custom colour, independent of category; reflects live in 2D + 3D/Render) ----
  const paintSwatches=(hex)=>{ const cn=$('#colorName'); if(cn) cn.textContent=(hex||'').toUpperCase();
    $('#palette')&&$('#palette').querySelectorAll('.pc').forEach(pc=>{ pc.classList.toggle('on', pc.dataset.c===hex); pc.setAttribute('aria-pressed', String(pc.dataset.c===hex)); }); };
  const setColor=(hex,rec)=>{ hex=toHexColor(hex); it.color=hex; it.colorCustom=true; paintSwatches(hex);
    if(rec){ commit(); renderAll(); }
    else { renderSceneOnly(); if(window.__on3DStateChange) window.__on3DStateChange(); } };  // live in 2D + 3D
  const fcol=$('#f_color');
  if(fcol){ fcol.addEventListener('input',e=>setColor(e.target.value,false));
            fcol.addEventListener('change',e=>setColor(e.target.value,true)); }
  $('#palette')&&$('#palette').querySelectorAll('.pc').forEach(pc=>pc.addEventListener('click',()=>{
    if(fcol) fcol.value=pc.dataset.c; setColor(pc.dataset.c,true); }));
  $('#b_color_all')&&$('#b_color_all').addEventListener('click',()=>{
    const hex=it.color, t=it.type; let n=0;
    store.items.forEach(o=>{ if(o.type===t){ o.color=hex; o.colorCustom=true; n++; } });
    commit(); renderAll(); toast('Applied colour to '+n+' '+t+(n===1?'':'s'));
  });
  $('#b_color_reset')&&$('#b_color_reset').addEventListener('click',()=>{
    it.colorCustom=false; it.color=catColor(it.category); commit(); renderAll();
  });

  $('#b_dup').addEventListener('click',()=>{
    const c=JSON.parse(JSON.stringify(it));
    c.id=nid(); c.x=clamp(it.x+2,0,WORLD.w-it.width); c.y=clamp(it.y+2,0,WORLD.h-it.height);
    store.items.push(c); setSelection([c.id]); commit(); renderAll(); toast('Duplicated');
  });
  $('#b_front').addEventListener('click',()=>{
    store.items=store.items.filter(x=>x.id!==it.id); store.items.push(it); commit(); renderAll();
  });
  $('#b_center').addEventListener('click',()=>{
    it.x=snapFt(WORLD.w/2-it.width/2); it.y=snapFt(WORLD.h/2-it.height/2); commit(); renderAll();
  });
  $('#b_del').addEventListener('click',()=> deleteSelected());
  roLockInspector();

  const mf=$('#f_model');
  if(mf){
    const apply=()=>{ const v=mf.value.trim();
      if(v){ it.properties=it.properties||{}; it.properties.model=v; }
      else if(it.properties){ delete it.properties.model; }
      commit(); renderAll(); };
    mf.addEventListener('change',apply);
    mf.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); mf.blur(); } });
    $('#b_model_clear').addEventListener('click',()=>{ mf.value=''; apply(); });
  }
}
function renderItemInPlace(it){ // cheap label refresh without full rebuild
  const g=svg.querySelector(`.obj[data-id="${CSS.escape(String(it.id))}"] text.lbl`);
  if(g) g.textContent=it.label;
}
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ===================================================================
   POINTER INTERACTION — drag / resize / rotate / select
   =================================================================== */
let drag=null;
function svgPointFt(evt){
  const r=svg.getBoundingClientRect();
  const fx=(evt.clientX-r.left)/r.width*WORLD.w;
  const fy=(evt.clientY-r.top)/r.height*WORLD.h;
  return {x:fx,y:fy};
}
const clone=o=>JSON.parse(JSON.stringify(o));
svg.addEventListener('pointerdown',e=>{
  const handle=e.target.closest('[data-handle]');
  const objEl=e.target.closest('.obj');
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;

  if(RO){                                       // view-only: allow selecting/inspecting, no editing
    if(objEl){ additive ? toggleSelection(objEl.dataset.id) : setSelection([objEl.dataset.id]); renderAll(); }
    else if(store.selectedIds.length){ clearSelection(); renderAll(); }
    return;
  }
  const mh=e.target.closest('[data-margin]');   // Excel-style margin guide → drag to adjust
  if(mh){
    e.preventDefault();
    drag={mode:'margin', edge:mh.getAttribute('data-margin'), orig:{...store.margins}, moved:false};
    svg.setPointerCapture(e.pointerId); return;
  }
  if(handle){                                  // resize / rotate — single primary object only
    const it=selected(); if(!it) return;
    e.preventDefault();
    drag={mode:handle.dataset.handle, axis:handle.dataset.axis||null, id:it.id, start:svgPointFt(e), orig:clone(it), moved:false};
    svg.setPointerCapture(e.pointerId); return;
  }
  if(objEl){
    const id=objEl.dataset.id;
    if(additive){ toggleSelection(id); renderAll(); return; }   // shift/⌘-click toggles membership
    if(!isSelected(id)) setSelection([id]);                     // click a fresh object → select only it
    const p=svgPointFt(e), anchor=store.items.find(i=>i.id===id);
    drag={mode:'move', start:p, moved:false, anchorId:id, off:{x:p.x-anchor.x, y:p.y-anchor.y},
      group: selectedItems().map(it=>({id:it.id, ox:it.x, oy:it.y}))};
    svg.setPointerCapture(e.pointerId); renderAll(); return;
  }
  // empty canvas → rubber-band marquee
  const p=svgPointFt(e);
  drag={mode:'marquee', start:p, moved:false, additive, prev:store.selectedIds.slice(), rect:{x0:p.x,y0:p.y,x1:p.x,y1:p.y}};
  svg.setPointerCapture(e.pointerId);
});

let lastPointerDown=0;
svg.addEventListener('pointerdown',()=>{ lastPointerDown=Date.now(); },true);
function keyboardSelect(objEl){
  const id=objEl.getAttribute('data-id'); if(id==null) return;
  if(store.selectedIds.length===1 && store.selectedId===id) return;
  setSelection([id]); renderAll();
}
svg.addEventListener('focusin',e=>{
  if(restoringFocus || Date.now()-lastPointerDown<600) return;      // pointer clicks run their own selection logic
  const o=e.target.closest && e.target.closest('.obj'); if(o) keyboardSelect(o);
});
svg.addEventListener('keydown',e=>{
  if(e.key!=='Enter' && e.key!==' ') return;
  const o=e.target.closest && e.target.closest('.obj'); if(!o) return;
  e.preventDefault(); keyboardSelect(o);
});

svg.addEventListener('pointermove',e=>{
  const p=svgPointFt(e);
  updateStatus(p);
  if(!drag) return;

  if(drag.mode==='margin'){
    drag.moved=true; const m=store.margins, edge=drag.edge;
    if(edge==='left')        m.left   = round1(clamp(snapFt(p.x),           0, WORLD.w - m.right  - 1));
    else if(edge==='right')  m.right  = round1(clamp(snapFt(WORLD.w - p.x), 0, WORLD.w - m.left   - 1));
    else if(edge==='top')    m.top    = round1(clamp(snapFt(p.y),           0, WORLD.h - m.bottom - 1));
    else if(edge==='bottom') m.bottom = round1(clamp(snapFt(WORLD.h - p.y), 0, WORLD.h - m.top    - 1));
    renderSceneOnly(); return;
  }

  if(drag.mode==='marquee'){
    drag.moved=true;
    drag.rect.x1=clamp(p.x,0,WORLD.w); drag.rect.y1=clamp(p.y,0,WORLD.h);
    const r=drag.rect, x0=Math.min(r.x0,r.x1),x1=Math.max(r.x0,r.x1),y0=Math.min(r.y0,r.y1),y1=Math.max(r.y0,r.y1);
    const hit=store.items.filter(it=> it.x<x1 && it.x+it.width>x0 && it.y<y1 && it.y+it.height>y0).map(it=>it.id);
    setSelection(drag.additive ? Array.from(new Set([...drag.prev, ...hit])) : hit);
    renderSceneOnly(); return;
  }

  if(drag.mode==='move'){
    drag.moved=true;
    const anchor=drag.group.find(g=>g.id===drag.anchorId);
    const tx=snapFt(p.x-drag.off.x), ty=snapFt(p.y-drag.off.y);   // snapped target for the grabbed object
    let dx=tx-anchor.ox, dy=ty-anchor.oy;
    // clamp the shared delta so EVERY member stays inside the floor
    let minDx=-Infinity,maxDx=Infinity,minDy=-Infinity,maxDy=Infinity;
    drag.group.forEach(g=>{ const it=store.items.find(i=>i.id===g.id);
      minDx=Math.max(minDx,-g.ox); maxDx=Math.min(maxDx,WORLD.w-it.width-g.ox);
      minDy=Math.max(minDy,-g.oy); maxDy=Math.min(maxDy,WORLD.h-it.height-g.oy); });
    dx=clamp(dx,minDx,maxDx); dy=clamp(dy,minDy,maxDy);
    drag.group.forEach(g=>{ const it=store.items.find(i=>i.id===g.id); it.x=round1(g.ox+dx); it.y=round1(g.oy+dy); });
    renderSceneOnly(); return;
  }

  const it=store.items.find(i=>i.id===drag.id); if(!it) return;
  drag.moved=true;
  if(drag.mode==='resize'){
    const cx=drag.orig.x+drag.orig.width/2, cy=drag.orig.y+drag.orig.height/2;
    const ang=-drag.orig.rotation*Math.PI/180;
    const dx=p.x-cx, dy=p.y-cy;
    const lx=dx*Math.cos(ang)-dy*Math.sin(ang), ly=dx*Math.sin(ang)+dy*Math.cos(ang);
    let nw=snapFt(Math.abs(lx)*2), nh=snapFt(Math.abs(ly)*2);
    nw=clamp(nw,0.5,WORLD.w); nh=clamp(nh,0.5,WORLD.h);
    if(drag.axis==='x') nh=drag.orig.height;              // edge handle → lock the other dimension
    else if(drag.axis==='y') nw=drag.orig.width;
    if(it.type==='table'||it.type==='cocktail'){ const d=Math.max(nw,nh); nw=nh=d; }
    it.width=nw; it.height=nh;
    it.x=clamp(cx-nw/2,0,WORLD.w-nw); it.y=clamp(cy-nh/2,0,WORLD.h-nh);
  } else if(drag.mode==='rotate'){
    const cx=(it.x+it.width/2), cy=(it.y+it.height/2);
    let deg=Math.atan2(p.y-cy,p.x-cx)*180/Math.PI + 90; deg=(deg+360)%360;
    if(store.grid.snap) deg=Math.round(deg/15)*15%360;
    it.rotation=Math.round(deg);
  }
  renderSceneOnly();
});

function endDrag(e){
  if(!drag) return;
  const {moved,mode,additive}=drag;
  try{ svg.releasePointerCapture(e.pointerId); }catch(_){}
  if(mode==='marquee'){ if(!moved && !additive) clearSelection(); }
  else if(moved){ commit(); }
  drag=null;
  renderAll();
}
svg.addEventListener('pointerup',endDrag);
svg.addEventListener('pointercancel',endDrag);
// Double-click the ruler corner to clear all margins back to the full floor.
(function wireMarginReset(){ const c=document.getElementById('cornerUnit'); if(!c) return;
  c.title='Double-click to reset the floor margins'; c.style.cursor='pointer';
  c.addEventListener('dblclick',()=>{ if(RO) return; const m=store.margins||{};
    if(!(m.left||m.right||m.top||m.bottom)) return;
    store.margins={left:0,right:0,top:0,bottom:0}; commit(); renderAll(); toast('Margins reset'); });
})();

/* light re-render during drag (scene + rulers only, keep inspector fields stable) */
function renderSceneOnly(){
  const sel=selected(), refocus=focusedObjId();
  // rebuild only item + selection layers cheaply: full renderAll is fine at this scale
  sizeCanvas();
  while(svg.firstChild) svg.removeChild(svg.firstChild);
  const W=WORLD.w*PX_PER_FT, H=WORLD.h*PX_PER_FT;
  svg.appendChild(el('rect',{x:0,y:0,width:W,height:H,fill:'var(--canvas)'}));
  if(store.grid.show){
    const g=el('g'); const step=cellFt();
    for(let f=0,n=0;f<=WORLD.w+0.001;f+=step,n++){const x=f*PX_PER_FT;
      g.appendChild(el('line',{x1:x,y1:0,x2:x,y2:H,stroke:n%10===0?'var(--grid-strong)':'var(--grid)','stroke-width':n%10===0?1:0.5}));}
    for(let f=0,n=0;f<=WORLD.h+0.001;f+=step,n++){const y=f*PX_PER_FT;
      g.appendChild(el('line',{x1:0,y1:y,x2:W,y2:y,stroke:n%10===0?'var(--grid-strong)':'var(--grid)','stroke-width':n%10===0?1:0.5}));}
    svg.appendChild(g);
  }
  svg.appendChild(el('rect',{x:0.5,y:0.5,width:W-1,height:H-1,fill:'none',stroke:'var(--grid-strong)','stroke-width':1.5}));
  store.items.forEach(it=>svg.appendChild(renderItem(it)));
  renderMargins();
  appendSelectionOverlays();
  // live-sync a couple inspector readouts (single-selection only)
  if(sel && store.selectedIds.length===1){
    const rv=$('#rotVal'); if(rv) rv.textContent=Math.round(sel.rotation)+'°';
    const fr=$('#f_rot'); if(fr&&document.activeElement!==fr) fr.value=Math.round(sel.rotation);
    ['f_x','f_y','f_w','f_h'].forEach(id=>{ const e=$('#'+id); if(e&&document.activeElement!==e){
      const map={f_x:sel.x,f_y:sel.y,f_w:sel.width,f_h:sel.height}; e.value=fmtU(map[id]); }});
  }
  renderRulers(); updateStatus(); updateCapacityUI();
  restoreObjFocus(refocus);
}

/* ===================================================================
   STATUS / STATE PANELS
   =================================================================== */
function updateStatus(p){
  const it=selected();
  // live counts — chairs (theatre seats + table seats), tables, guests capacity
  // R10: seats = every seat on the floor (rows×cols, table seats, sofas/benches/lounges…) — the same
  // count the generator makes exact (sumSeats), so the status bar never disagrees with the quote's N.
  let chairs=sumSeats(store.items), tables=0;
  store.items.forEach(i=>{ if(i.type==='table'||i.type==='longtable'||i.type==='cocktail'||i.type==='headtable') tables++; });
  let s = `<b>${store.items.length}</b> objects · <b>${chairs}</b> seats`;
  if(tables) s += ` · <b>${tables}</b> tables`;
  if(store.selectedIds.length>1) s += ` · <b>${store.selectedIds.length}</b> selected`;
  else if(it) s += ` · sel <b>${esc(it.label)}</b> @ ${fmtU(it.x)},${fmtU(it.y)} ${uLabel()} · ${Math.round(it.rotation)}°`;
  if(p) s += ` &nbsp; ⌖ ${round1(toU(p.x))}, ${round1(toU(p.y))}`;
  $('#status').innerHTML=s;
}
// live-refresh inspector fields while the 3D gizmo drags (no full rebuild)
function syncInspectorLive(it){
  const sel=selected(); if(!it || !sel || sel.id!==it.id) return;
  const set=(id,val)=>{ const e=$('#'+id); if(e&&document.activeElement!==e) e.value=val; };
  set('f_x',fmtU(it.x)); set('f_y',fmtU(it.y)); set('f_w',fmtU(it.width)); set('f_h',fmtU(it.height));
  const fr=$('#f_rot'); if(fr&&document.activeElement!==fr) fr.value=Math.round(it.rotation);
  const rv=$('#rotVal'); if(rv) rv.textContent=Math.round(it.rotation)+'°';
  updateStatus();
}
function renderState(){
  const compact = {
    items: store.items.map(i=>({id:i.id,type:i.type,category:i.category,
      x:round1(i.x),y:round1(i.y),width:i.width,height:i.height,rotation:i.rotation,
      label:i.label, ...(Object.keys(i.properties).length?{properties:i.properties}:{})})),
    selectedId: store.selectedId,
    grid: store.grid,
    view: store.view,
    scale: { pxPerFt:PX_PER_FT, worldFt:WORLD },
    history: { past:store.past.length, future:store.future.length }
  };
  const pre=$('#stateJson');
  if($('#stateDetails').open) pre.textContent=JSON.stringify(compact,null,1);
}

/* ===================================================================
   TEMPLATES
   =================================================================== */
const TEMPLATES = {
  /* =============== POLITICAL / RALLY =============== */
  political_theatre(){                 // ~576 seats
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('stage', cx-20, 8));
    it.push(makeItem('podium', cx-1.5, 18, {label:'Podium'}));
    it.push(makeItem('barricade', cx-30, 30, {width:60, label:'Security Buffer'}));
    it.push(makeItem('press', cx-12, 40, {label:'Press Riser'}));
    const bW=38,bH=28,aisle=8, lX=cx-aisle/2-bW, rX=cx+aisle/2, topY=60, botY=60+bH+6;
    it.push(makeItem('seatblock', lX, topY, {width:bW,height:bH,properties:{rows:9,cols:16},label:'Section A'}));
    it.push(makeItem('seatblock', rX, topY, {width:bW,height:bH,properties:{rows:9,cols:16},label:'Section B'}));
    it.push(makeItem('seatblock', lX, botY, {width:bW,height:bH,properties:{rows:9,cols:16},label:'Section C'}));
    it.push(makeItem('seatblock', rX, botY, {width:bW,height:bH,properties:{rows:9,cols:16},label:'Section D'}));
    it.push(makeItem('checkpoint', 8, WORLD.h-16, {label:'Entry'}));
    it.push(makeItem('checkpoint', WORLD.w-14, WORLD.h-16, {label:'Entry'}));
    it.push(makeItem('exit', 6, WORLD.h-8, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-8, {label:'Exit'}));
    return it;
  },
  political_townhall(){                 // ~224 seats
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('stage', cx-14, 8, {width:28,height:12,label:'Stage'}));
    it.push(makeItem('podium', cx-1.5, 16, {label:'Podium'}));
    it.push(makeItem('press', cx+22, 8, {width:16,height:8,label:'Press'}));
    it.push(makeItem('desk', 10, 22, {label:'Check-in'}));
    let n=1;
    for(let r=0;r<4;r++)for(let c=0;c<7;c++) it.push(makeItem('table', 20+c*24, 34+r*24, {label:'T'+(n++)}));
    it.push(makeItem('checkpoint', 8, WORLD.h-14, {label:'Entry'}));
    it.push(makeItem('exit', 6, WORLD.h-8, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-8, {label:'Exit'}));
    return it;
  },
  political_arena(){                    // ~748 seats
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('fence', 4, 4, {width:WORLD.w-8, label:'Perimeter'}));
    it.push(makeItem('stage', cx-24, 8, {width:48,height:16,label:'Main Stage'}));
    it.push(makeItem('podium', cx-1.5, 20, {label:'Podium'}));
    it.push(makeItem('barricade', cx-32, 28, {width:64, label:'Front Buffer'}));
    it.push(makeItem('press', cx-12, 36, {label:'Press Riser'}));
    it.push(makeItem('seatblock', cx-30, 52, {width:60,height:34,properties:{rows:11,cols:24},label:'Center Stand'}));
    it.push(makeItem('seatblock', 8, 44, {width:28,height:66,properties:{rows:21,cols:11},label:'Left Stand'}));
    it.push(makeItem('seatblock', WORLD.w-36, 44, {width:28,height:66,properties:{rows:21,cols:11},label:'Right Stand'}));
    it.push(makeItem('checkpoint', cx-3, WORLD.h-14, {label:'Gate'}));
    it.push(makeItem('exit', 6, WORLD.h-9, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-9, {label:'Exit'}));
    return it;
  },
  /* =============== CONFERENCE & EXPO =============== */
  conference_expo(){                    // 32 booths
    const it=[], cx=WORLD.w/2;
    for(let i=0;i<5;i++) it.push(makeItem('desk', 12+i*20, 8, {label:'Reg '+(i+1)}));
    let n=1;
    for(let r=0;r<4;r++)for(let c=0;c<8;c++) it.push(makeItem('booth', 16+c*22, 26+r*22, {label:'B'+(n++)}));
    it.push(makeItem('lounge', 12, WORLD.h-20, {label:'Lounge'}));
    it.push(makeItem('lounge', WORLD.w-26, WORLD.h-20, {label:'Lounge'}));
    it.push(makeItem('restroom', cx-6, WORLD.h-12, {label:'Restrooms'}));
    it.push(makeItem('checkpoint', cx-3, 6, {label:'Entry'}));
    it.push(makeItem('exit', 6, WORLD.h-8, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-8, {label:'Exit'}));
    return it;
  },
  conference_keynote(){                 // ~928 seats
    const it=[], cx=WORLD.w/2, bW=44,bH=30;
    it.push(makeItem('stage', cx-24, 6, {width:48,height:14,label:'Keynote Stage'}));
    it.push(makeItem('podium', cx-1.5, 15, {label:'Podium'}));
    it.push(makeItem('press', cx+26, 6, {width:16,height:8,label:'Press'}));
    it.push(makeItem('seatblock', cx-bW/2, 34, {width:bW,height:bH,properties:{rows:10,cols:20},label:'Center Front'}));
    it.push(makeItem('seatblock', cx-bW/2, 34+bH+6, {width:bW,height:bH,properties:{rows:10,cols:20},label:'Center Rear'}));
    it.push(makeItem('seatblock', 8, 34, {width:30,height:bH*2+6,properties:{rows:22,cols:12},label:'Left Wing'}));
    it.push(makeItem('seatblock', WORLD.w-38, 34, {width:30,height:bH*2+6,properties:{rows:22,cols:12},label:'Right Wing'}));
    it.push(makeItem('desk', 12, WORLD.h-12, {label:'Check-in'}));
    it.push(makeItem('exit', 6, WORLD.h-8, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-8, {label:'Exit'}));
    return it;
  },
  conference_classroom(){               // 15 tables · 180 seats
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('stage', cx-12, 6, {width:24,height:10,label:'Front'}));
    it.push(makeItem('podium', cx-1.5, 12, {label:'Podium'}));
    it.push(makeItem('desk', 10, 8, {label:'Check-in'}));
    it.push(makeItem('booth', WORLD.w-24, 8, {label:'AV'}));
    for(let r=0;r<5;r++)for(let c=0;c<3;c++)
      it.push(makeItem('longtable', 18+c*58, 26+r*20, {label:'Row '+String.fromCharCode(65+r)+(c+1),properties:{seats:12}}));
    it.push(makeItem('exit', 6, WORLD.h-8, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-8, {label:'Exit'}));
    return it;
  },
  /* =============== WEDDING & GALA (non-religious) =============== */
  wedding_ceremony(){                   // ~392 guest seats · canopy ceremony
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('canopy', cx-11, 8, {label:'Ceremony Canopy'}));
    it.push(makeItem('arch', cx-6, 32, {label:'Backdrop'}));
    const bW=40,bH=26,aisle=10, lX=cx-aisle/2-bW, rX=cx+aisle/2;
    it.push(makeItem('seatblock', lX, 44, {width:bW,height:bH,properties:{rows:7,cols:14},label:'Guests L'}));
    it.push(makeItem('seatblock', rX, 44, {width:bW,height:bH,properties:{rows:7,cols:14},label:'Guests R'}));
    it.push(makeItem('seatblock', lX, 44+bH+6, {width:bW,height:bH,properties:{rows:7,cols:14},label:'Guests L2'}));
    it.push(makeItem('seatblock', rX, 44+bH+6, {width:bW,height:bH,properties:{rows:7,cols:14},label:'Guests R2'}));
    it.push(makeItem('gifttable', 12, 46, {label:'Gifts'}));
    it.push(makeItem('exit', 6, WORLD.h-8, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-8, {label:'Exit'}));
    return it;
  },
  wedding_banquet(){                    // head table + ~24 round tables
    const it=[], cx=WORLD.w/2, cy=WORLD.h/2;
    it.push(makeItem('headtable', cx-9, 8, {label:'Head Table',properties:{seats:10}}));
    it.push(makeItem('dancefloor', cx-12, cy-6, {width:24,height:22,label:'Dance Floor'}));
    it.push(makeItem('dj', cx-4, cy-18, {label:'DJ'}));
    it.push(makeItem('caketable', 12, 30, {label:'Cake'}));
    it.push(makeItem('bar', WORLD.w-20, WORLD.h-14, {width:16,label:'Bar'}));
    let n=1;
    for(let r=0;r<4;r++)for(let c=0;c<7;c++){
      const tx=18+c*26, ty=30+r*24;
      if(tx>cx-22 && tx<cx+14 && ty>cy-14 && ty<cy+20) continue;   // clear the dance floor
      it.push(makeItem('table', tx, ty, {label:'T'+(n++)}));
    }
    it.push(makeItem('exit', 6, WORLD.h-8, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-8, {label:'Exit'}));
    return it;
  },
  wedding_reception(){                  // dance floor · mixed seating · bars · lounge
    const it=[], cx=WORLD.w/2, cy=WORLD.h/2;
    it.push(makeItem('dancefloor', cx-14, cy-12, {width:28,height:26,label:'Dance Floor'}));
    it.push(makeItem('dj', cx-4, cy-24, {label:'DJ'}));
    const N=10, R=46;
    for(let i=0;i<N;i++){ const a=i/N*Math.PI*2;
      it.push(makeItem('table', cx+Math.cos(a)*R-3, cy+Math.sin(a)*R*0.6-3, {label:'T'+(i+1)})); }
    [[16,16],[WORLD.w-20,16],[16,WORLD.h-20],[WORLD.w-20,WORLD.h-20]].forEach((s,i)=>
      it.push(makeItem('cocktail', s[0], s[1], {label:'Highboy '+(i+1)})));
    it.push(makeItem('bar', 10, cy-2, {label:'Bar'}));
    it.push(makeItem('bar', WORLD.w-24, cy-2, {label:'Bar'}));
    it.push(makeItem('buffet', cx-9, WORLD.h-12, {label:'Buffet'}));
    it.push(makeItem('lounge', cx-6, 8, {label:'Lounge'}));
    it.push(makeItem('caketable', 22, 32, {label:'Cake'}));
    it.push(makeItem('gifttable', WORLD.w-28, 32, {label:'Gifts'}));
    it.push(makeItem('photobooth', cx+28, WORLD.h-18, {label:'Photo Booth'}));
    it.push(makeItem('exit', 6, WORLD.h-8, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-8, {label:'Exit'}));
    return it;
  },
  /* =============== OUTDOOR FESTIVAL =============== */
  festival_mainstage(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('fence', 4, 4, {width:WORLD.w-8, label:'Perimeter'}));
    it.push(makeItem('fence', 4, WORLD.h-5, {width:WORLD.w-8, label:'Perimeter'}));
    it.push(makeItem('stage', cx-28, 8, {width:56,height:20,label:'Main Stage'}));
    it.push(makeItem('barricade', cx-32, 32, {width:64,label:'Front Barrier'}));
    it.push(makeItem('press', cx-12, 40, {label:'Press'}));
    it.push(makeItem('bar', 20, 60, {label:'Bar'}));
    it.push(makeItem('bar', WORLD.w-34, 60, {label:'Bar'}));
    it.push(makeItem('restroom', 14, WORLD.h-48, {label:'Restrooms'}));
    for(let i=0;i<4;i++) it.push(makeItem('truck', 12+i*46, WORLD.h-30, {label:'Food '+(i+1)}));
    it.push(makeItem('checkpoint', cx-3, WORLD.h-11, {label:'Gate'}));
    it.push(makeItem('exit', 6, WORLD.h/2-3, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h/2-3, {label:'Exit'}));
    return it;
  },
  festival_multistage(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('fence', 4, 4, {width:WORLD.w-8, label:'Perimeter'}));
    it.push(makeItem('fence', 4, WORLD.h-5, {width:WORLD.w-8, label:'Perimeter'}));
    it.push(makeItem('stage', cx-24, 8, {width:48,height:16,label:'Main Stage'}));
    it.push(makeItem('barricade', cx-26, 28, {width:52,label:'Barrier'}));
    it.push(makeItem('stage', cx-18, WORLD.h-24, {width:36,height:14,label:'Second Stage'}));
    it.push(makeItem('barricade', cx-20, WORLD.h-30, {width:40,label:'Barrier'}));
    for(let i=0;i<3;i++) it.push(makeItem('tent', 16+i*56, 40, {label:'Vendor '+(i+1)}));
    for(let i=0;i<3;i++) it.push(makeItem('truck', 24+i*50, 74, {label:'Food '+(i+1)}));
    it.push(makeItem('bar', WORLD.w-40, 74, {label:'Bar'}));
    it.push(makeItem('lounge', 20, 96, {label:'Lounge'}));
    it.push(makeItem('restroom', WORLD.w-26, 96, {label:'Restrooms'}));
    it.push(makeItem('checkpoint', 8, 64, {label:'Gate'}));
    it.push(makeItem('exit', 6, WORLD.h/2-3, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h/2-3, {label:'Exit'}));
    return it;
  },
  festival_market(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('fence', 4, 4, {width:WORLD.w-8, label:'Perimeter'}));
    it.push(makeItem('stage', cx-12, 6, {width:24,height:10,label:'Stage'}));
    let n=1;
    for(let r=0;r<3;r++)for(let c=0;c<7;c++) it.push(makeItem('booth', 16+c*24, 24+r*22, {label:'Stall '+(n++)}));
    for(let i=0;i<3;i++) it.push(makeItem('truck', 24+i*50, WORLD.h-34, {label:'Food '+(i+1)}));
    it.push(makeItem('buffet', 20, WORLD.h-16, {label:'Buffet'}));
    it.push(makeItem('bar', WORLD.w-40, WORLD.h-16, {label:'Bar'}));
    it.push(makeItem('lounge', cx-6, WORLD.h-26, {label:'Lounge'}));
    for(let i=0;i<3;i++) it.push(makeItem('cocktail', 64+i*16, WORLD.h-26, {label:'Highboy '+(i+1)}));
    it.push(makeItem('restroom', WORLD.w-26, 20, {label:'Restrooms'}));
    it.push(makeItem('checkpoint', 8, WORLD.h-12, {label:'Gate'}));
    it.push(makeItem('exit', 6, WORLD.h/2-3, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h/2-3, {label:'Exit'}));
    return it;
  },
  /* =============== CONCERT / LIVE MUSIC =============== */
  concert_mainstage(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('stage', cx-26, 8, {width:52,height:18,label:'Main Stage'}));
    it.push(makeItem('videowall', cx-12, 6, {width:24,height:12,label:'LED Wall'}));
    it.push(makeItem('linearray', cx-32, 12, {label:'PA L'}));
    it.push(makeItem('linearray', cx+30, 12, {label:'PA R'}));
    it.push(makeItem('subwoofer', cx-28, 27, {label:'Subs L'}));
    it.push(makeItem('subwoofer', cx+25, 27, {label:'Subs R'}));
    for(let i=0;i<4;i++) it.push(makeItem('movinghead', cx-18+i*12, 9, {label:'Mover '+(i+1)}));
    for(let i=0;i<3;i++) it.push(makeItem('monitor', cx-12+i*12, 22, {label:'Wedge '+(i+1)}));
    it.push(makeItem('stagebarrier', cx-30, 31, {width:60, label:'Front Barrier'}));
    it.push(makeItem('foh', cx-4, WORLD.h-40, {label:'FOH Control'}));
    it.push(makeItem('seatblock', 8, 48, {width:24,height:58,properties:{rows:19,cols:9},label:'Left Stand'}));
    it.push(makeItem('seatblock', WORLD.w-32, 48, {width:24,height:58,properties:{rows:19,cols:9},label:'Right Stand'}));
    it.push(makeItem('viprisers', cx-8, WORLD.h-58, {label:'VIP Riser'}));
    it.push(makeItem('greenroom', 8, 8, {label:'Green Room'}));
    it.push(makeItem('generator', WORLD.w-24, 8, {label:'Generator'}));
    it.push(makeItem('checkpoint', cx-3, WORLD.h-13, {label:'Entry'}));
    it.push(makeItem('exit', 6, WORLD.h-9, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-9, {label:'Exit'}));
    return it;
  },
  concert_club(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('stage', cx-16, 8, {width:32,height:12,label:'Stage'}));
    it.push(makeItem('dj', cx-4, 12, {label:'DJ Booth'}));
    it.push(makeItem('linearray', cx-20, 10, {label:'PA L'})); it.push(makeItem('linearray', cx+18, 10, {label:'PA R'}));
    it.push(makeItem('dancefloor', cx-16, 34, {width:32,height:28,label:'Dance Floor'}));
    for(let i=0;i<4;i++) it.push(makeItem('movinghead', cx-15+i*10, 9, {label:'FX '+(i+1)}));
    it.push(makeItem('bar', 12, WORLD.h-18, {width:18,label:'Bar'}));
    for(let i=0;i<4;i++) it.push(makeItem('cocktail', WORLD.w-60+i*14, WORLD.h-24, {label:'Highboy '+(i+1)}));
    it.push(makeItem('lounge', WORLD.w-26, 30, {label:'VIP Lounge'}));
    it.push(makeItem('checkpoint', 8, WORLD.h-12, {label:'Entry'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-9, {label:'Exit'}));
    return it;
  },
  /* =============== GALA / AWARDS / BANQUET =============== */
  gala_awards(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('stage', cx-18, 8, {width:36,height:12,label:'Stage'}));
    it.push(makeItem('podium', cx-1.5, 16, {label:'Podium'}));
    it.push(makeItem('videowall', cx-10, 6, {width:20,height:10,label:'LED Wall'}));
    it.push(makeItem('redcarpet', cx-3, 24, {width:6,height:26,label:'Red Carpet'}));
    it.push(makeItem('dancefloor', cx-10, WORLD.h-34, {width:20,height:20,label:'Dance Floor'}));
    let n=1; for(let r=0;r<3;r++)for(let c=0;c<6;c++) it.push(makeItem('table', 22+c*26, 54+r*24, {label:'T'+(n++)}));
    it.push(makeItem('bar', 12, WORLD.h-16, {label:'Bar'}));
    it.push(makeItem('buffet', WORLD.w-30, WORLD.h-16, {label:'Buffet'}));
    it.push(makeItem('chandelier', cx-2, 40, {label:'Chandelier'}));
    it.push(makeItem('coatcheck', 10, 24, {label:'Coat Check'}));
    it.push(makeItem('exit', 6, WORLD.h-9, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-9, {label:'Exit'}));
    return it;
  },
  /* =============== BIRTHDAY / PRIVATE PARTY =============== */
  birthday_party(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('arch', cx-6, 8, {width:12,label:'Backdrop'}));
    it.push(makeItem('dj', cx-3, 16, {label:'DJ'}));
    it.push(makeItem('dancefloor', cx-9, 30, {width:18,height:16,label:'Dance Floor'}));
    it.push(makeItem('caketable', cx-2, 52, {label:'Cake'}));
    let n=1; for(let r=0;r<2;r++)for(let c=0;c<5;c++) it.push(makeItem('table', 24+c*28, 66+r*24, {label:'T'+(n++)}));
    it.push(makeItem('buffet', 14, WORLD.h-16, {label:'Buffet'}));
    it.push(makeItem('bar', WORLD.w-28, WORLD.h-16, {label:'Bar'}));
    it.push(makeItem('photobooth', WORLD.w-24, 20, {label:'Photo Booth'}));
    it.push(makeItem('gifttable', 14, 20, {label:'Gifts'}));
    it.push(makeItem('exit', 6, WORLD.h-9, {label:'Exit'}));
    return it;
  },
  /* =============== PRODUCT LAUNCH =============== */
  product_launch(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('stage', cx-20, 8, {width:40,height:14,label:'Reveal Stage'}));
    it.push(makeItem('videowall', cx-14, 5, {width:28,height:12,label:'LED Wall'}));
    it.push(makeItem('linearray', cx-24, 11, {label:'PA L'})); it.push(makeItem('linearray', cx+22, 11, {label:'PA R'}));
    for(let i=0;i<3;i++) it.push(makeItem('pillar', cx-16+i*16, 28, {label:'Product '+(i+1)}));
    it.push(makeItem('desk', 12, 20, {label:'Registration'}));
    it.push(makeItem('photobooth', WORLD.w-24, 20, {label:'Media Wall'}));
    it.push(makeItem('seatblock', 20, 44, {width:WORLD.w-40,height:34,properties:{rows:8,cols:26},label:'Audience'}));
    it.push(makeItem('lounge', 14, WORLD.h-20, {label:'VIP Lounge'}));
    it.push(makeItem('bar', WORLD.w-30, WORLD.h-16, {label:'Canapé Bar'}));
    it.push(makeItem('exit', 6, WORLD.h-9, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-9, {label:'Exit'}));
    return it;
  },
  /* =============== SPORTS =============== */
  sports_stadium(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('fence', 4, 4, {width:WORLD.w-8, label:'Perimeter'}));
    it.push(makeItem('dancefloor', cx-30, 40, {width:60,height:60,label:'Field of Play'}));
    it.push(makeItem('bleacher', 8, 40, {width:20,height:60,label:'West Stand'}));
    it.push(makeItem('bleacher', WORLD.w-28, 40, {width:20,height:60,label:'East Stand'}));
    it.push(makeItem('videowall', cx-12, 8, {width:24,height:12,label:'Scoreboard'}));
    it.push(makeItem('linearray', 20, 20, {label:'PA L'})); it.push(makeItem('linearray', WORLD.w-22, 20, {label:'PA R'}));
    it.push(makeItem('firstaid', cx-4, WORLD.h-16, {label:'Medical'}));
    it.push(makeItem('viprisers', cx-8, 24, {label:'Commentary'}));
    it.push(makeItem('checkpoint', 8, WORLD.h-13, {label:'Gate'}));
    it.push(makeItem('exit', 6, WORLD.h-9, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-9, {label:'Exit'}));
    return it;
  },
  /* aliases kept for the default boot state / older saved links */
  get political(){ return this.political_theatre; },
  get conference(){ return this.conference_expo; },
  get wedding(){ return this.wedding_banquet; },
  get festival(){ return this.festival_mainstage; },
  get concert(){ return this.concert_mainstage; }
};
const MAX_ITEMS=3000, MAX_BLOCK_SEATS=5000, MAX_IMPORT_BYTES=5*1024*1024, MAX_CAPACITY=100000;
// keep every object fully inside the floor bounds
function clampItem(it){
  const a = ASSETS[it.type] || {};
  const num=(v,d)=>{ v=+v; return isFinite(v)?v:d; };   // coerce; fall back so a missing field can't produce NaN
  it.width  = clamp(num(it.width,  a.w||6), 0.5, WORLD.w);
  it.height = clamp(num(it.height, a.h||6), 0.5, WORLD.h);
  it.x = clamp(num(it.x,0), 0, WORLD.w-it.width);
  it.y = clamp(num(it.y,0), 0, WORLD.h-it.height);
  it.rotation = num(it.rotation,0);
  return it;
}
// coerce untrusted (imported / stored) item fields: numeric seat props (a string `seats` would be
// string-concatenated into seat counts rendered via innerHTML), string type/label/id/color, and no
// Object.prototype keys (e.g. "__proto__") used as a type/category lookup key.
function sanitizeItem(it){
  if(!it.properties || typeof it.properties!=='object') it.properties={};
  ['rows','cols','seats','pitch'].forEach(k=>{ if(it.properties[k]!=null){ const v=+it.properties[k]; it.properties[k]=isFinite(v)?clamp(v,0,1000):0; } });
  // a block is rows x cols seats: cap the product so one hostile/typo'd item can't mean 1,000,000 chairs
  { const r=it.properties.rows, c=it.properties.cols;
    if(r>0 && c>0 && r*c>MAX_BLOCK_SEATS) it.properties.cols = Math.max(1, Math.floor(MAX_BLOCK_SEATS/r)); }
  if(it.properties.model!=null && typeof it.properties.model!=='string') delete it.properties.model;
  if(typeof it.type!=='string' || it.type in Object.prototype) it.type='unknown';
  if(!it.category || !Object.prototype.hasOwnProperty.call(CATS, it.category)) it.category='structure';
  if(typeof it.label!=='string') it.label = it.label==null ? '' : String(it.label);
  if(typeof it.color!=='string') it.color = catColor(it.category);
  it.id = it.id ? String(it.id) : nid();
  return it;
}
// imported / legacy files can repeat an id — selection, 3D picking and edits key on it, so re-issue duplicates
function dedupeIds(items){
  const seen=new Set();
  items.forEach(it=>{ while(seen.has(it.id)) it.id=nid(); seen.add(it.id); });
  return items;
}
// only accept well-typed grid settings from untrusted JSON (unit/snap/show); sizeFt is derived
function sanitizeGrid(g){
  const out={ ...store.grid };
  if(!g || typeof g!=='object') return out;
  if(g.unit==='ft' || g.unit==='m') out.unit=g.unit;
  if(typeof g.snap==='boolean') out.snap=g.snap;
  if(typeof g.show==='boolean') out.show=g.show;
  out.sizeFt = out.unit==='m' ? FT_PER_M : 1;
  return out;
}
function sanitizeVenue(v){
  const out={ ...store.venue };
  if(!v || typeof v!=='object') return out;
  if(v.capacity===null) out.capacity=null;
  else if(v.capacity!=null){ const c=+v.capacity; out.capacity = (isFinite(c)&&c>0) ? Math.min(Math.round(c),100000) : null; }
  if(v.setting==='indoor' || v.setting==='outdoor') out.setting=v.setting;
  if(v.room && typeof v.room==='object' && isFinite(+v.room.w) && isFinite(+v.room.h)) out.room={ w:clamp(Math.round(+v.room.w),20,1000), h:clamp(Math.round(+v.room.h),20,1000) };
  return out;
}
function loadItems(items, name){
  store.items = dedupeIds(items.filter(it=>it && typeof it==='object').map(it=>clampItem(sanitizeItem(it))));
  setSelection([]); currentLayoutId=null;
  // only auto-name a still-unnamed project; keep a generated date-name or a user's own name
  if(name){ const pn=$('#projName'); if(pn && (!pn.value.trim() || pn.value.trim()==='Untitled layout')) pn.value=name; }
  commit(); renderAll(); fitView();
}
function loadTemplate(key){
  if(!key){ return; }
  const lbl=document.querySelector('#preset option[value="'+key+'"]').textContent;
  // R8b: an open quote's seats value is the exact seating total for preset templates too
  const tItems=TEMPLATES[key](); const N=currentQuoteId ? quoteChairsNow() : 0;
  if(N>0){ const nat=sumSeats(tItems); exactSeats(tItems, N); const w=seatFitWarning(N, nat, null, PRICING.eventType); if(w) setTimeout(()=>BPUI.toast('⚠ '+w,{type:'err'}),50); }
  loadItems(tItems, lbl);
  toast(lbl + ' loaded');
}

/* ===================================================================
   CUSTOM EVENT GENERATOR — procedural, deterministic (no external AI)
   Reads optional inputs (guests, tables, add-ons) and produces a few
   layout variants that fit the 200×140 floor, keeping every count.
   =================================================================== */
function countSeats(items){
  let tables=0;
  items.forEach(i=>{ if(i.type==='table'||i.type==='longtable'||i.type==='cocktail'||i.type==='headtable') tables++; });
  return {chairs:sumSeats(items), tables};   // R10: all seating, same as the generator's exact count
}
/* R8b: the quote's seats value N is the EXACT total seating a generated layout gets. Seats are counted
   per item (rows×cols, properties.seats, single-seat units). Excess: trailing seating (bottom-right
   first) is dropped / its last table or row filled partially. Shortfall: tables gain seats round-robin,
   else the biggest block is packed denser inside its own rect (the caller warns about the hall size).
   Partial rows are split inside the original rect, so nothing new overlaps or leaves the hall. */
// every seat on the floor counts toward N (owner rule) — lounge furniture without a seats property uses these
const FLOOR_SEATS = { sofa:3, loveseat:2, armchair:1, ottoman:1, bench:2, lounge:4 };
function genSeats(it){ const p=it.properties||{}; if(p.rows&&p.cols) return p.rows*p.cols; if(p.seats) return +p.seats||0; return SEAT_UNIT[it.type]||FLOOR_SEATS[it.type]||0; }
function sumSeats(items){ return items.reduce((n,it)=>n+genSeats(it),0); }
function setBlockSeats(items, it, T){
  const p=it.properties||{}, c=Math.max(1,+p.cols||1), idx=items.indexOf(it);
  if(T<=0){ items.splice(idx,1); return; }
  const full=Math.floor(T/c), rem=T%c;
  if(!full){ it.properties={...p, rows:1, cols:rem}; it.width=Math.round(it.width*rem/c*10)/10; return; }
  const strips=full+(rem?1:0), rowH=it.height/strips;
  it.properties={...p, rows:full, cols:c}; it.height=rowH*full;
  if(rem) items.splice(idx+1,0,makeItem('chairrow', it.x, it.y, {y:it.y+it.height+0.02, width:it.width*rem/c, height:Math.max(0.1,rowH-0.04),
    rotation:it.rotation||0, properties:{rows:1, cols:rem}, label:(it.label||'Seating')+' · last row'}));
}
let _packFit=null;   // R9: set by exactSeats' tiny-hall fallback — {fit} or {fit:false, free sq ft}
function exactSeats(items, N){
  N=Math.round(+N||0); if(!(N>0)) return items;
  let S=sumSeats(items);
  if(S>N){
    const order=items.filter(it=>genSeats(it)>0).sort((a,b)=>(b.y+b.height)-(a.y+a.height) || b.x-a.x);
    for(const it of order){
      const ex=S-N; if(ex<=0) break;
      const n=genSeats(it);
      if(n<=ex){ items.splice(items.indexOf(it),1); S-=n; continue; }
      const p=it.properties||{};
      if(p.rows&&p.cols) setBlockSeats(items, it, n-ex);
      else if(p.seats) it.properties={...p, seats:n-ex};
      else { items.splice(items.indexOf(it),1); S-=n; continue; }
      S=N;
    }
  }
  S=sumSeats(items);
  if(S<N){
    let d=N-S;
    const tabs=items.filter(it=>{ const p=it.properties||{}; return p.seats && !(p.rows&&p.cols); });
    const blocks=items.filter(it=>{ const p=it.properties||{}; return p.rows&&p.cols; }).sort((a,b)=>genSeats(b)-genSeats(a));
    if(blocks.length) setBlockSeats(items, blocks[0], genSeats(blocks[0])+d);
    else if(tabs.length){ for(let i=0;d>0;i=(i+1)%tabs.length,d--) tabs[i].properties={...tabs[i].properties, seats:(+tabs[i].properties.seats||0)+1}; }
    else { // no seating survived (tiny hall): pack all N into the largest free spot found
      const taken=items.filter(it=>!GEN_OVERLAY.has(it.type)).map(genRect);
      let spot=null;
      // R9: first look for a free spot that holds all N at the comfortable pitch — if one exists the seats
      // genuinely fit (no warning); otherwise record the free area really left for seating, for the message
      const P=DESIGN_PITCH, comfy=[];
      for(const cols of [Math.ceil(Math.sqrt(N*2)), Math.ceil(Math.sqrt(N)), N, Math.ceil(N/2), 1]){
        const c=Math.max(1,Math.min(N,cols)), w=c*P, h=Math.ceil(N/c)*P; if(w<=WORLD.w && h<=WORLD.h) comfy.push([w,h]); }
      for(const [w,h] of comfy){
        for(let y=0;!spot && y+h<=WORLD.h;y+=1) for(let x=0;!spot && x+w<=WORLD.w;x+=1){ const r={x,y,w,h}; if(!taken.some(t=>rectsHit(r,t,0.5))) spot=r; }
        if(spot) break; }
      _packFit = spot ? { fit:true } : { fit:false, free:0 };
      if(!spot) for(const [w,h] of [[Math.min(40,WORLD.w-4),Math.min(20,WORLD.h-4)],[20,8],[12,5],[6,2.4],[3,2]]){
        for(let y=0;!spot && y+h<=WORLD.h;y+=1) for(let x=0;!spot && x+w<=WORLD.w;x+=1){ const r={x,y,w,h}; if(!taken.some(t=>rectsHit(r,t,0.5))) spot=r; }
        if(spot) break; }
      if(!_packFit.fit && spot) _packFit.free=Math.round(spot.w*spot.h);
      spot=spot||{x:2,y:Math.max(0,WORLD.h-4),w:Math.max(2,WORLD.w-4),h:2};
      const cols=Math.max(1,Math.min(N,Math.floor(spot.w/DESIGN_PITCH)||1)), rows=Math.ceil(N/cols);
      const b=makeItem('seatblock', spot.x, spot.y, {width:spot.w, height:spot.h, properties:{rows, cols}, label:'Seating'}); items.push(b); setBlockSeats(items, b, d); }
  }
  return items;
}
// R8b: the honest hall-size warning when N seats exceed what the template fits at its density
// R10: the old estimate scaled the hall by the template's own seat count (hall×N÷natural → "105 seats need
// ~12,728 sq ft" in a 4,000 sq ft hall that rankTemplates said fits 150). The need is now the same capacity
// model as the recommendations (seats × comfortable sq ft per seat); a hall that big never warns.
const SEAT_SQFT_FALLBACK=6;
function seatSqftFor(type){ try{ if(window.HelmSizing && HelmSizing.seatSqft) return HelmSizing.seatSqft(type); }catch(e){} return SEAT_SQFT_FALLBACK; }
function seatFitWarning(N, natural, free, type){
  N=Math.round(+N||0); if(!(N>0) || !(natural<N)) return '';
  const hall=Math.round(WORLD.w*WORLD.h), needArea=Math.ceil(N*seatSqftFor(type));
  if(hall>=needArea) return '';
  // R9: nothing of the template's own seating fit (tiny hall) — the old area maths said "need ~116 sq ft;
  // hall is 400" (need < hall), which read as if it fitted. Say plainly that the hall is too small.
  if(!(natural>0) && free>0) return N.toLocaleString('en-IN')+' seats need ~'+Math.ceil(N*DESIGN_PITCH*DESIGN_PITCH).toLocaleString('en-IN')+' sq ft at '+DESIGN_PITCH+' ft spacing; the seating area left after the stage, dance floor, buffet & bars is ~'+free.toLocaleString('en-IN')+' sq ft';
  if(!(natural>0)) return N.toLocaleString('en-IN')+' seats don\u2019t fit this template in a '+hall.toLocaleString('en-IN')+' sq ft hall \u2014 enlarge the hall or pick another template';
  const need=needArea;
  return N.toLocaleString('en-IN')+' seats need ~'+need.toLocaleString('en-IN')+' sq ft; hall is '+hall.toLocaleString('en-IN')+' sq ft';
}
function tally(items, type){ return items.filter(i=>i.type===type).length; }

// place the "front" zone (stage/canopy/dance/head table) and return the y where seating may begin
function frontZone(items, o){
  const cx=WORLD.w/2; let top=8;
  if(o.canopy){ items.push(makeItem('canopy', cx-11, 8, {label:'Ceremony Canopy'}));
    items.push(makeItem('arch', cx-6, 32, {label:'Backdrop'})); top=44; }
  else if(o.stage){ // R10: the stage scales with the hall — at most ~30% of its width, ~18% of its depth
    const sw=Math.min(o.type==='festival'?56:44, Math.max(12, Math.round(WORLD.w*0.3)));
    const sh=Math.min(16, Math.max(8, Math.round(WORLD.h*0.18))), sy=Math.min(8, Math.max(2, Math.round(WORLD.h*0.06)));
    items.push(makeItem('stage', cx-sw/2, sy, {width:sw,height:sh,label:'Stage'}));
    items.push(makeItem('podium', cx-1.5, sy+sh*0.625, {label:'Podium'}));
    if(o.press) items.push(makeItem('press', cx+sw/2-2, sy, {width:16,height:8,label:'Press'}));
    top=sy+sh+6;
    if(o.type==='political'||o.type==='festival'){ items.push(makeItem('barricade', cx-30, top, {width:60,label:'Buffer'})); top+=6; }
  }
  if(o.head){ items.push(makeItem('headtable', cx-9, top, {label:'Head Table',properties:{seats:10}})); top+=8; }
  return top+4;
}
// support / logistics flowed along the lower band, wrapping into lanes so nothing stacks
function supportZone(items, o){
  const laneBottom=WORLD.h-6, lo=22, hi=WORLD.w-22;   // keep clear of the corner exits
  const flow=[];
  for(let i=0;i<(o.bars||0);i++)   flow.push(['bar','Bar '+(i+1)]);
  for(let i=0;i<(o.trucks||0);i++) flow.push(['truck','Food '+(i+1)]);
  if(o.buffet)                     flow.push(['buffet','Buffet']);
  for(let i=0;i<(o.rest||0);i++)   flow.push(['restroom','Restrooms']);
  let lx=lo, lane=0;
  const pitch=flow.reduce((m,f)=>Math.max(m, ASSETS[f[0]].h), 0)+3;   // lane spacing = tallest piece + walkway
  flow.forEach(([type,label])=>{ const a=ASSETS[type];
    if(lx+a.w>hi){ lx=lo; lane++; }                    // wrap to the next lane up
    items.push(makeItem(type, lx, Math.max(4, laneBottom-a.h-lane*pitch), {label}));
    lx += a.w+4;
  });
  if(o.fence){ items.push(makeItem('fence',4,4,{width:WORLD.w-8,label:'Perimeter'}));
    items.push(makeItem('fence',4,WORLD.h-5,{width:WORLD.w-8,label:'Perimeter'})); }
  const exits=o.exits!=null?o.exits:2;
  for(let i=0;i<exits;i++){ const left=i%2===0;
    items.push(makeItem('exit', left?6:WORLD.w-18, Math.max(6, WORLD.h-9-Math.floor(i/2)*10), {label:'Exit'})); }
}

// ---- seating strategies fill [topY .. bottomY] and honour guest target ----
// bottomY = just above the support band (bars/buffet/trucks/restrooms lanes + exits) that
// supportZone() will lay down for these options, with a 1.5 ft walkway (fix #5).
function seatBottom(o){
  const tmp=[]; supportZone(tmp, o); let b=WORLD.h-16;
  tmp.forEach(i=>{ if(i.type!=='fence') b=Math.min(b, i.y-1.5); });
  return b;
}
function seatTheatre(items, o, topY){
  const bottomY=seatBottom(o);
  const cx=WORLD.w/2, aisle=o.aisle||8, margin=8;
  const colW=(WORLD.w-2*margin-aisle)/2, regionH=Math.max(12, bottomY-topY);
  const cols=Math.max(4, Math.floor(colW/DESIGN_PITCH));    // walkable column pitch — never below comfort
  const rowsCap=Math.max(1, Math.floor(regionH/DESIGN_PITCH));
  const guests=o.guests!=null?o.guests:(2*cols*rowsCap);
  let rows=clamp(Math.ceil(guests/(2*cols)),1,rowsCap);
  const bH=Math.min(regionH, rows*DESIGN_PITCH);            // row pitch = DESIGN_PITCH, so blocks read "comfortable"
  items.push(makeItem('seatblock', margin, topY, {width:colW,height:bH,properties:{rows,cols},label:'Left Seating'}));
  items.push(makeItem('seatblock', cx+aisle/2, topY, {width:colW,height:bH,properties:{rows,cols},label:'Right Seating'}));
}
function seatRounds(items, o, topY, mixed){
  const bottomY=seatBottom(o);
  const spt=o.spt||8, margin=10, cell=9;
  const cols=Math.max(1,Math.floor((WORLD.w-2*margin)/cell));
  const rowsAvail=Math.max(1,Math.floor((bottomY-topY)/cell));
  const capacity=cols*rowsAvail;
  let tables = o.tables!=null ? o.tables : (o.guests?Math.ceil(o.guests/spt):Math.min(capacity, Math.round(capacity*0.7)));
  tables=Math.min(tables, capacity);
  const dance=o.dance; const dcx=WORLD.w/2, dcy=(topY+bottomY)/2;
  if(dance){ items.push(makeItem('dancefloor', dcx-12, dcy-11, {width:24,height:22,label:'Dance Floor'}));
    items.push(makeItem('dj', dcx-4, dcy-20, {label:'DJ'})); }
  // gather usable cells (excluding the dance floor), then place the round tables the
  // guest target needs; in mixed mode add a few highboys as accents in leftover cells.
  const cells=[];
  for(let r=0;r<rowsAvail;r++)for(let c=0;c<cols;c++){
    const tx=margin+c*cell, ty=topY+r*cell;
    if(dance && tx>dcx-20 && tx<dcx+14 && ty>dcy-16 && ty<dcy+18) continue;
    cells.push([tx,ty]);
  }
  let i=0, n=1;
  for(; i<cells.length && n<=tables; i++){ const [tx,ty]=cells[i];
    items.push(makeItem('table', tx, ty, {properties:{seats:spt},label:'T'+n})); n++; }
  if(mixed){ let hb=0; for(; i<cells.length && hb<8; i++,hb++){ const [tx,ty]=cells[i];
    items.push(makeItem('cocktail', tx+2, ty+2, {label:'Highboy '+(hb+1)})); } }
}
/* R10: banquet seating — a dance floor sized to the crowd in front of the stage, then ROUND TABLES of
   spt (8) for exactly ceil(N/spt) tables (last one partial), spread evenly over the free floor at a
   comfortable 10 ft table pitch and never over the stage, dance floor, buffet, bars or exits. Only when
   the free floor genuinely can't hold them does the pitch tighten (to 8 ft); exactSeats tops up the rest. */
function seatBanquetRounds(items, o, topY){
  const N=o.guests!=null?o.guests:0, spt=o.spt||8;
  const df=Math.round(clamp(Math.sqrt(Math.max(1,N)*2.5), 12, 24)), dside=Math.min(df, Math.round(WORLD.w*0.3), Math.round((WORLD.h-topY)*0.4));
  const dcx=WORLD.w/2;
  if(dside>=8){ items.push(makeItem('dancefloor', dcx-dside/2, topY, {width:dside,height:dside,label:'Dance Floor'})); }
  const taken=items.filter(it=>!GEN_OVERLAY.has(it.type)).map(genRect);
  const need=N>0 ? Math.ceil(N/spt) : 0, T=ASSETS.table.w;
  const cellsAt=(pitch)=>{ const out=[], m=Math.max(2,(pitch-T)/2+1);
    for(let y=Math.max(2,topY-dside*0); y+T<=WORLD.h-2; y+=pitch) for(let x=m; x+T<=WORLD.w-m+1e-6; x+=pitch){
      const r={x,y,w:T,h:T}; if(!taken.some(t=>rectsHit(r,t,1.5))) out.push([x,y]); }
    return out; };
  let cells=cellsAt(10); if(cells.length<need) { const c8=cellsAt(8); if(c8.length>cells.length) cells=c8; }
  const n=Math.min(need, cells.length); if(!n) return;
  // spread: take evenly spaced cells rather than packing the first rows
  const pick=[]; for(let i=0;i<n;i++) pick.push(cells[Math.floor(i*cells.length/n)]);
  // R10: when every table fits, spread the seats evenly (105 → 7×8 + 7×7) instead of a near-empty
  // last table (13×8 + 1×1 looked odd to clients). Otherwise fill tables of spt; the caller packs the rest.
  const even=n===need && n>0, base=even?Math.floor(N/n):0, extra=even?N%n:0;
  let left=N;
  pick.forEach(([x,y],i)=>{ const seats=even ? base+(i<extra?1:0) : Math.min(spt, left); left-=seats;
    items.push(makeItem('table', x, y, {properties:{seats},label:'T'+(i+1)})); });
}
function seatBanquetLong(items, o, topY){
  const bottomY=seatBottom(o), margin=12, cellW=46, cellH=18;
  const cols=Math.max(1,Math.floor((WORLD.w-2*margin+cellW-16)/cellW));
  const rows=Math.max(1,Math.floor((bottomY-topY)/cellH));
  const need=o.guests!=null?Math.ceil(o.guests/12):cols*rows;
  let placed=0;
  for(let r=0;r<rows && placed<need;r++)for(let c=0;c<cols && placed<need;c++){
    items.push(makeItem('longtable', margin+c*cellW, topY+r*cellH, {properties:{seats:12},label:'Table '+(placed+1)})); placed++;
  }
}
function boothGrid(items, o, topY){
  const margin=16, cell=22, cols=Math.max(1,Math.floor((WORLD.w-2*margin+2)/cell));
  const rows=Math.max(1,Math.floor((seatBottom(o)-topY)/cell));
  const need=o.booths!=null?o.booths:cols*rows; let n=1,placed=0;
  for(let r=0;r<rows && placed<need;r++)for(let c=0;c<cols && placed<need;c++){
    items.push(makeItem('booth', margin+c*cell, topY+r*cell, {label:'B'+(n++)})); placed++;
  }
}

// perimeter seating — long tables arranged around an open centre.
// hollow=false → U-shape (front edge left open toward the stage/screen);
// hollow=true  → hollow square (closed ring). Seats counted via properties.seats.
function seatPerimeter(items, o, topY, hollow){
  const margin=16, bottomY=seatBottom(o);
  const a=ASSETS.longtable, tw=a.w, th=a.h, gap=4;
  const left=margin, right=WORLD.w-margin, top=topY+4, bot=bottomY;
  let n=0;
  const addH=(y)=>{ for(let x=left; x+tw<=right-th; x+=tw+gap){
    items.push(makeItem('longtable', x, y, {properties:{seats:12},label:'Table '+(++n)})); } };
  const addV=()=>{ for(let y=top+th+gap; y+tw<=bot-th; y+=tw+gap){
    items.push(makeItem('longtable', left, y, {rotation:90,properties:{seats:12},label:'Table '+(++n)}));
    items.push(makeItem('longtable', right-th, y, {rotation:90,properties:{seats:12},label:'Table '+(++n)})); } };
  if(hollow) addH(top);          // closed front edge for a hollow square
  addV();                        // left + right runs (rotated)
  addH(bot-th);                  // base of the U / bottom of the square
}
// cocktail / standing reception — mostly highboys with a few lounge clusters
function seatCocktail(items, o, topY){
  const bottomY=seatBottom(o), margin=12, cell=10;
  const cols=Math.max(1,Math.floor((WORLD.w-2*margin)/cell));
  const rows=Math.max(1,Math.floor((bottomY-topY)/cell));
  const capacity=Math.max(1,cols*rows);
  const need = o.guests!=null ? Math.min(capacity, Math.ceil(o.guests/3)) : Math.round(capacity*0.6);
  let placed=0, hb=0;
  for(let r=0;r<rows && placed<need;r++)for(let c=0;c<cols && placed<need;c++){
    if((r*cols+c)%12===5) items.push(makeItem('lounge', margin+c*cell, topY+r*cell, {label:'Lounge'}));
    else items.push(makeItem('cocktail', margin+c*cell+2, topY+r*cell+2, {label:'Highboy '+(++hb)}));
    placed++;
  }
}
// half-rounds theatre hybrid — front dinner rounds, rear theatre seat blocks
function seatHalfRoundsTheatre(items, o, topY){
  const bottomY=seatBottom(o), mid=topY+(bottomY-topY)*0.5;
  const spt=o.spt||8, margin=10, cell=9;
  const cols=Math.max(1,Math.floor((WORLD.w-2*margin)/cell));
  const rowsF=Math.max(1,Math.floor(Math.max(0,mid-topY)/cell));
  let n=1;
  for(let r=0;r<rowsF;r++)for(let c=0;c<cols;c++){
    items.push(makeItem('table', margin+c*cell, topY+r*cell, {properties:{seats:spt},label:'T'+(n++)})); }
  const aisle=o.aisle||8, m2=8;
  const colW=(WORLD.w-2*m2-aisle)/2, regionH=Math.max(12, bottomY-mid);
  const tcols=Math.max(4, Math.floor(colW/DESIGN_PITCH));
  const rows=Math.max(1, Math.floor(regionH/DESIGN_PITCH));
  const bH=Math.min(regionH, rows*DESIGN_PITCH);
  items.push(makeItem('seatblock', m2, mid, {width:colW,height:bH,properties:{rows,cols:tcols},label:'Rear Left'}));
  items.push(makeItem('seatblock', WORLD.w/2+aisle/2, mid, {width:colW,height:bH,properties:{rows,cols:tcols},label:'Rear Right'}));
}

// ---- collision pass for generated layouts (fix #5): nothing overlaps -------------------
// Rect of an item as drawn (rotation is about the centre; 90/270 swap width/height).
function genRect(it){
  const w=+it.width||0, h=+it.height||0, r=((+it.rotation||0)%180+180)%180;
  const sw = (r>45 && r<135) ? h : w, sh = (r>45 && r<135) ? w : h;
  const cx=(+it.x||0)+w/2, cy=(+it.y||0)+h/2;
  return { x:cx-sw/2, y:cy-sh/2, w:sw, h:sh };
}
function rectsHit(a,b,gap){ gap=gap||0;
  return a.x < b.x+b.w+gap && b.x < a.x+a.w+gap && a.y < b.y+b.h+gap && b.y < a.y+a.h+gap; }
// Types allowed to sit on/over others: boundary lines and the podium (it stands ON the stage).
const GEN_OVERLAY = new Set(['fence','podium']);
const GEN_SEATING = new Set(['seatblock','table','longtable','cocktail','lounge','booth','chairrow']);
// Deterministic: fixed items (stage, dance floor, exits, bars, buffet…) are placed first in their
// generated order and RELOCATED to the nearest free spot if they collide; seating then yields to
// them with a 1.5 ft walkway — a seat block is shortened (fewer rows), a table that still collides
// is left out (the capacity check then reports any shortfall honestly). Seats never stack.
function resolveOverlaps(items){
  const W=WORLD.w, H=WORLD.h, AISLE=1.5;
  const fixed=[], seats=[], overlay=[];
  items.forEach(it=>{ (GEN_OVERLAY.has(it.type)?overlay:GEN_SEATING.has(it.type)?seats:fixed).push(it); });
  const placed=[];                        // rects of accepted fixed items
  const free=(r)=>r.x>=0 && r.y>=0 && r.x+r.w<=W+1e-6 && r.y+r.h<=H+1e-6 && !placed.some(p=>rectsHit(r,p,0.5));
  const outFixed=[];
  fixed.forEach(it=>{
    let r=genRect(it);
    if(!free(r)){
      const step=Math.max(1, Math.ceil(Math.max(W,H)/120)), dx0=it.x, dy0=it.y;
      let best=null, bd=Infinity;
      for(let y=0;y+r.h<=H;y+=step) for(let x=0;x+r.w<=W;x+=step){
        const d=Math.abs(x-r.x)+Math.abs(y-r.y); if(d>=bd) continue;
        const c={x,y,w:r.w,h:r.h}; if(free(c)){ best=c; bd=d; }
      }
      if(!best) return;                    // no room anywhere in this hall → leave it out
      it.x=round1(dx0+(best.x-r.x)); it.y=round1(dy0+(best.y-r.y)); r=genRect(it);
      if(!free(r)) return;
    }
    placed.push(r); outFixed.push(it);
  });
  const seatRects=[], outSeats=[];
  seats.forEach(it=>{
    const hits=()=>{ const r=genRect(it); return placed.some(p=>rectsHit(r,p,AISLE)) || seatRects.some(p=>rectsHit(r,p,0)); };
    if(hits() && it.type==='seatblock' && !(+it.rotation)){
      // shorten from the bottom until clear of whatever is below/inside it
      const pitch=DESIGN_PITCH, cols=(it.properties&&it.properties.cols)||1;
      let rows=(it.properties&&it.properties.rows)||Math.floor(it.height/pitch);
      while(rows>=1 && hits()){ rows--; it.height=Math.round(rows*pitch*10)/10; }
      if(rows<1) return;
      it.properties={...(it.properties||{}), rows, cols};
    }
    if(hits()) return;
    seatRects.push(genRect(it)); outSeats.push(it);
  });
  items.length=0; outFixed.forEach(i=>items.push(i)); outSeats.forEach(i=>items.push(i)); overlay.forEach(i=>items.push(i));
  return items;
}

function generateVariants(oIn){
  const o = {...oIn};
  // R9: only a real positive whole number is a seat target — '', 0, negatives, NaN, 'abc' mean "not set"
  // (they used to leak into the strategies and give 0 / odd seat counts); decimals round.
  const seatN=v=>{ if(v==null||v==='') return null; const n=Math.round(+v); return isFinite(n)&&n>0 ? n : null; };
  o.guests=seatN(o.guests); o.chairs=seatN(o.chairs);
  if(o.chairs!=null) o.guests = o.chairs;   // an explicit chair count drives the seating target
  const variants=[];
  const base=()=>{ const it=[]; return it; };
  const target = o.guests!=null ? o.guests : null;   // R8b: the quote's seats value — exact total seating
  const finish=(it,name,desc)=>{ it.forEach(clampItem); resolveOverlaps(it); let natural=sumSeats(it), free=null;
    if(target>0){ _packFit=null; exactSeats(it, target);
      // R9: the template's own zones held no seats, but all N fit comfortably in the space left → it fits
      if(_packFit){ if(_packFit.fit) natural=target; else free=_packFit.free; } }
    const c=countSeats(it);
    variants.push({name, desc, items:it.map(i=>({...i})),
      counts:{chairs:sumSeats(it), natural, free, tables:c.tables, tables_round:tally(it,'table'), booths:tally(it,'booth'),
        bars:tally(it,'bar'), trucks:tally(it,'truck'), exits:tally(it,'exit'), objects:it.length}}); };

  if(o.type==='conference' && (o.booths||0)>0){
    const a=base(); const t1=frontZone(a,{...o,stage:true}); boothGrid(a,o,t1); supportZone(a,o); finish(a,'Expo hall','Registration + booth grid');
  }
  // Variant 1 — Theatre rows
  { const it=base(); const t=frontZone(it,o); seatTheatre(it,o,t); supportZone(it,o); finish(it,'Theatre rows','Rows facing the stage — max capacity'); }
  // Variant 2 — Round tables (+ dance if wedding/gala)
  { const it=base(); const o2={...o, dance:o.dance||o.type==='wedding'||o.type==='reception'}; const t=frontZone(it,o2); seatRounds(it,o2,t,false); supportZone(it,o2); finish(it,'Round tables','Banquet rounds — seated dinner'); }
  // Variant 3 — Mixed reception OR banquet long tables
  if(o.type==='conference'){ const it=base(); const t=frontZone(it,o); seatBanquetLong(it,o,t); supportZone(it,o); finish(it,'Classroom','Long tables in rows'); }
  else { const it=base(); const o3={...o, dance:true}; const t=frontZone(it,o3); seatRounds(it,o3,t,true);
    if(o.lounge) it.push(makeItem('lounge', 8, 8, {label:'Lounge'})); supportZone(it,o3); finish(it,'Mixed reception','Rounds + highboys + dance floor'); }
  // Variant 4 — Custom mix: honours EXACTLY the toggles/counts you set, then fully editable on the floor
  { const it=base(); const t=frontZone(it,o);
    const useRounds = (o.spt!=null) || o.type==='wedding' || o.type==='reception';
    if((o.booths||0)>0) boothGrid(it,o,t);
    else if(useRounds) seatRounds(it,{...o,dance:o.dance},t,!!o.lounge);
    else seatTheatre(it,o,t);
    if(o.lounge) it.push(makeItem('lounge', 8, 8, {label:'Lounge'}));
    supportZone(it,o);
    finish(it,'Custom mix','Your exact selections — drop &amp; edit freely'); }

  // ---- Additional layout rules (additive; reuse the strategies above) ----
  const isConf = (o.type==='conference'||o.type==='corporate'||o.type==='product_launch');
  // U-shape boardroom & Hollow square — perimeter tables around an open centre
  if(isConf){
    { const it=base(); const t=frontZone(it,{...o,stage:true}); seatPerimeter(it,o,t,false); supportZone(it,o);
      finish(it,'U-shape boardroom','Tables around an open centre, open toward the screen'); }
    { const it=base(); const t=frontZone(it,{...o,stage:true}); seatPerimeter(it,o,t,true); supportZone(it,o);
      finish(it,'Hollow square','Closed ring of tables around an open centre'); }
  }
  // Banquet + stage + dance — weddings, galas, receptions
  if(o.type==='wedding'||o.type==='gala'||o.type==='reception'){
    const it=base(); const o5={...o,stage:true}; const t=frontZone(it,o5); supportZone(it,o5);
    seatBanquetRounds(it,o5,t);
    finish(it,'Banquet + stage + dance','Long banquet tables with a stage & dance floor');
  }
  // Cabaret / crescent rounds — rounds set back from an open front facing the stage
  if(!isConf){ const it=base(); const o6={...o, stage:o.stage!==false}; const t=frontZone(it,o6);
    const bY=seatBottom(o6), openTop=t+Math.max(0,(bY-t))/3;
    seatRounds(it,o6,openTop,false); supportZone(it,o6);
    finish(it,'Cabaret / crescent rounds','Rounds set back from an open front facing the stage'); }
  // Cocktail / standing reception — highboys + lounges, minimal fixed seating
  { const it=base(); const t=frontZone(it,o); seatCocktail(it,o,t); supportZone(it,o);
    finish(it,'Cocktail reception','Standing highboys & lounge clusters — mingling flow'); }
  // Half-rounds theatre hybrid — front dinner rounds, rear theatre rows
  if(!isConf){ const it=base(); const t=frontZone(it,o); seatHalfRoundsTheatre(it,o,t); supportZone(it,o);
    finish(it,'Half-rounds + theatre','Front dinner rounds with rear theatre seating'); }

  return variants;
}

// R9: a chairs value must be a whole number ≥ 1 (empty = 70% of guests). 0 is rejected with a clear message.
const CHAIRS_MIN_MSG='Chairs must be at least 1 — clear the field to use 70% of guests.';
function chairsOk(v){ if(v===0){ toast(CHAIRS_MIN_MSG); return false; } return true; }
function readCustomForm(){
  const num=id=>{ const v=$('#'+id).value.trim(); return v===''?null:Math.max(0,parseInt(v,10)||0); };
  return { type:$('#c_type').value, setting:$('#c_setting').value,
    len:num('c_len'), wid:num('c_wid'),
    guests:num('c_guests'), chairs:num('c_chairs'), tables:num('c_tables'), spt:num('c_spt'), aisle:num('c_aisle'),
    bars:num('c_bars'), trucks:num('c_trucks'), booths:num('c_booths'), rest:num('c_rest'), exits:num('c_exits'),
    stage:$('#c_stage').checked, canopy:$('#c_canopy').checked, dance:$('#c_dance').checked, head:$('#c_head').checked,
    buffet:$('#c_buffet').checked, lounge:$('#c_lounge').checked, press:$('#c_press').checked, fence:$('#c_fence').checked };
}
// size the floor to the entered hall + record the venue setting (indoor/outdoor)
function applyRoomFromForm(o){
  // hall length & breadth are physical dimensions — must be > 0 when supplied (blank = keep current)
  const lenRaw=$('#c_len').value.trim(), widRaw=$('#c_wid').value.trim();
  const maxFt = (CAPS&&CAPS.hall)||1000;
  if(lenRaw!==''){ const r=BPStore.validate.dimension(lenRaw,{field:'Hall length'}); if(!r.ok){ BPUI.alert('Hall length must be greater than 0.',{title:'Check the hall size'}); return false; } WORLD.w = clamp(r.value, 20, maxFt); }
  if(widRaw!==''){ const r=BPStore.validate.dimension(widRaw,{field:'Hall breadth'}); if(!r.ok){ BPUI.alert('Hall breadth must be greater than 0.',{title:'Check the hall size'}); return false; } WORLD.h = clamp(r.value, 20, maxFt); }
  store.venue = store.venue || {};
  store.venue.room = { w:WORLD.w, h:WORLD.h };
  store.venue.setting = o.setting || store.venue.setting || 'indoor';
  updateDimsLabel();
}
function updateDimsLabel(){ const el=$('#dimsLabel'); if(el) el.textContent = `${WORLD.w} × ${WORLD.h} ft · ${PX_PER_FT} px/ft${store.venue&&store.venue.setting==='outdoor'?' · outdoor':''}`; }
function runCustomGenerate(){
  const o=readCustomForm();
  // Enforce the Control-Center capacity ceilings so generation stays fast and honest
  // even if a field wasn't blurred (the blur clamp hadn't run yet).
  o.guests=clampCap(o.guests,CAPS.guests); o.chairs=clampCap(o.chairs,CAPS.chairs); o.tables=clampCap(o.tables,CAPS.tables);
  if(!chairsOk(o.chairs)) return;   // R9: 0 chairs is rejected (min 1), never a silent "natural seats" layout
  o.bars=clampCap(o.bars,CAPS.bars); o.trucks=clampCap(o.trucks,CAPS.trucks); o.booths=clampCap(o.booths,CAPS.booths);
  o.rest=clampCap(o.rest,CAPS.rest); o.exits=clampCap(o.exits,CAPS.exits);
  if(applyRoomFromForm(o)===false) return;               // invalid hall dimension → abort (message already shown)
  sizeCanvas(); renderAll(); fitView();                  // open/redraw the floor at the entered hall size
  const variants=generateVariants(o).map(v=>({...v, items:v.items.map(clampItem)}));
  const host=$('#c_results');
  // Honest capacity check: if the hall physically can't seat the headcount at a walkable pitch, say so.
  let fitNote='';
  if(o.guests){
    const target=o.chairs!=null?o.chairs:o.guests;
    const bestCap=Math.max(0,...variants.map(v=>v.counts.natural||0));
    const bestFree=Math.max(0,...variants.map(v=>v.counts.free||0));
    const warn=seatFitWarning(target, bestCap, bestFree, PRICING.eventType||o.type);
    if(warn){
      fitNote=`<div style="grid-column:1/-1;background:color-mix(in srgb,var(--c-logistics) 12%,var(--panel));border:1px solid color-mix(in srgb,var(--c-logistics) 45%,var(--line));border-radius:9px;padding:10px 12px;font-size:12px;color:var(--ink);line-height:1.5">
        ⚠ ${esc(warn)}. Every layout below still places all ${esc(String(target))} seats, packed tighter than the comfortable ${DESIGN_PITCH} ft spacing — enlarge the hall or reduce the seats.</div>`;
    }
  }
  host.innerHTML = fitNote + variants.map((v,idx)=>{
    const c=v.counts;
    const rows=[['Chairs',c.chairs],['Round tables',c.tables_round],['Booths',c.booths],['Bars',c.bars],['Food/stalls',c.trucks],['Exits',c.exits],['Objects',c.objects]]
      .filter(r=>r[1]>0 || r[0]==='Chairs' || r[0]==='Objects')
      .map(r=>`<span class="stat"><span>${r[0]}</span><b>${r[1]}</b></span>`).join('');
    return `<button type="button" class="ccard" data-idx="${idx}" aria-label="Use layout: ${esc(v.name)}"><span class="ch">${esc(v.name)}</span><span class="cp">${esc(v.desc)}</span>${rows}<span class="use">Use this layout →</span></button>`;
  }).join('');
  host.querySelectorAll('.ccard').forEach(card=>card.addEventListener('click',()=>{
    const v=variants[+card.dataset.idx];
    loadItems(v.items, 'Custom · '+v.name);
    // one headcount: the "Expected guests" from the generator also becomes the plates/guests for pricing
    if(o.guests!=null){ PRICING.guests=o.guests; const g=$('#bGuests'); if(g) g.value=o.guests; }
    persistSizing(sizingPatch(o)).then(()=>{ if(o.guests!=null) persistGuests(); });
    closeCustomModal();
    renderPrice();
    toast(v.name+' · '+v.counts.chairs+' chairs, '+v.counts.objects+' objects');
  }));
}
const clampCap=(v,max)=> (v==null?null:Math.min(v, max));
// Show a live red "Maximum is N" note under each capped field, set its max to the
// Control-Center value, and resize the floor the moment the hall size is typed.
function applyCapHints(){
  const map=[['c_guests','guests'],['c_chairs','chairs'],['c_tables','tables'],['c_bars','bars'],
    ['c_trucks','trucks'],['c_booths','booths'],['c_rest','rest'],['c_exits','exits'],['c_len','hall'],['c_wid','hall']];
  map.forEach(([id,key])=>{ const el=$('#'+id); if(!el) return; const max=CAPS[key];
    if(max!=null&&isFinite(max)) el.setAttribute('max', String(max));
    let hint=el.parentNode&&el.parentNode.querySelector('.caphint');
    if(!hint && el.parentNode){ hint=document.createElement('small'); hint.className='caphint'; hint.hidden=true;
      hint.style.cssText='display:block;color:var(--danger,#c0362c);font-size:11px;font-weight:600;margin-top:3px';
      el.parentNode.appendChild(hint); }
    const check=()=>{ if(!hint) return; const n=parseFloat(el.value);
      const over=el.value!=='' && isFinite(n) && max!=null && n>max;
      hint.hidden=!over; if(over) hint.textContent='Maximum is '+Number(max).toLocaleString('en-IN')+'.'; };
    el.addEventListener('input',check); check();
  });
  // Entering the hall length/breadth opens/resizes the floor immediately (on blur/Enter),
  // so the canvas reflects the dimensions before any layout is generated or chosen.
  ['c_len','c_wid'].forEach(id=>{ const el=$('#'+id); if(!el||el.dataset.resizeWired) return; el.dataset.resizeWired='1';
    el.addEventListener('change',()=>{ try{ if(applyRoomFromForm(readCustomForm())===false) return; sizeCanvas(); renderAll(); fitView(); }catch(e){} });
  });
}
function openCustomModal(){ const wasOpen=!$('#customModal').hidden; $('#customModal').hidden=false;
  if(!wasOpen) _ceFresh=true;   // R9: re-read the quote's sizing each time it opens (never mid-edit) $('#c_results').innerHTML=''; try{ applyCapHints(); }catch(e){}
  try{ prefillCustomForm(); wireSizingForm(); renderRecommendations(); }catch(e){} }
/* R8: the Custom Event dialog is prefilled from the quote (guests, chairs, tables, hall, type) and
   keeps chairs = 70% of guests / tables = chairs ÷ seats-per-table until the user types their own. */
const CE_TYPE = { wedding:'wedding', reception:'reception', engagement:'wedding', gala:'wedding', cocktail:'wedding', birthday:'wedding',
  concert:'concert', festival:'festival', political:'political', rally:'political',
  conference:'conference', corporate:'conference', expo:'conference', product_launch:'conference' };
let ceChairsManual=false, ceTablesManual=false, _ceFresh=true;
function prefillCustomForm(){
  // R9: on every (re)open the dialog shows the quote's CURRENT sizing — guests, chairs (incl. a hand
  // edit made in the right panel / flow), tables = ceil(chairs ÷ seats-per-table) unless typed, hall
  // L×B. Saved values win over ?gen URL params; only values the quote doesn't have are left alone.
  const fresh=_ceFresh; _ceFresh=false;
  let cl={}, pr={}; try{ cl=currentClient||{}; pr=currentPricing||{}; }catch(e){}
  const sz=HelmSizing.dialogSizing(cl, pr, store.venue&&store.venue.room, PRICING.guests, +$('#c_spt').value||null);
  const fill=(id,v)=>{ const el=$('#'+id); if(el && (fresh || el.value==='') && v!=null && v!=='') el.value=v; };
  fill('c_guests', sz.guests); fill('c_len', sz.len); fill('c_wid', sz.wid);
  if(fresh){ ceChairsManual=sz.chairsManual; ceTablesManual=sz.tablesManual; }
  if(currentQuoteId) fill('c_chairs', quoteChairsNow()); else fill('c_chairs', sz.chairsManual ? sz.chairs : HelmSizing.defaultChairs(+$('#c_guests').value||sz.guests));
  fill('c_tables', sz.tablesManual ? sz.tables : HelmSizing.defaultTables(+$('#c_chairs').value||null, +$('#c_spt').value||null));
  const t=CE_TYPE[String(PRICING.eventType||'').toLowerCase()], sel=$('#c_type');
  if(t && sel && !sel.dataset.touched && [...sel.options].some(o=>o.value===t)) sel.value=t;
  syncCeChairsUi();
}
function syncCeChairsUi(){ const r=$('#c_chairsReset'); if(r) r.hidden=!ceChairsManual; }
function ceAutoFill(){
  const g=$('#c_guests').value===''?null:+$('#c_guests').value;
  if(!ceChairsManual){ const c=HelmSizing.defaultChairs(g); $('#c_chairs').value=c==null?'':c; }
  if(!ceTablesManual){ const tb=HelmSizing.defaultTables($('#c_chairs').value===''?null:+$('#c_chairs').value, +$('#c_spt').value||null); $('#c_tables').value=tb==null?'':tb; }
  syncCeChairsUi(); renderRecommendations();
}
function wireSizingForm(){
  const m=$('#customModal'); if(!m || m.dataset.sizingWired) return; m.dataset.sizingWired='1';
  $('#c_guests').addEventListener('input',ceAutoFill);
  $('#c_spt').addEventListener('input',ceAutoFill);
  $('#c_chairs').addEventListener('input',()=>{ ceChairsManual=$('#c_chairs').value!==''; ceAutoFill(); });
  // R9: a chairs value typed here is the quote's chairs — write it back (quote + right panel #bChairs)
  $('#c_chairs').addEventListener('change',()=>{ const v=$('#c_chairs').value; if(v!=='' && +v>=1 && currentQuoteId && !RO) setQuoteChairs(v); });   // R10: 0 is rejected at generate time, never saved
  $('#c_tables').addEventListener('input',()=>{ ceTablesManual=$('#c_tables').value!==''; renderRecommendations(); });
  ['c_len','c_wid'].forEach(id=>$('#'+id).addEventListener('input',renderRecommendations));
  $('#c_type').addEventListener('change',()=>{ $('#c_type').dataset.touched='1'; renderRecommendations(); });
  $('#c_chairsReset').addEventListener('click',e=>{ e.preventDefault(); ceChairsManual=false; ceAutoFill(); resetQuoteChairs(); });
}
function sizingPatch(o){
  const p={ chairsManual:ceChairsManual, tablesManual:ceTablesManual };
  if(o.guests!=null) p.guests=o.guests;
  if(o.chairs!=null) p.chairs=o.chairs;
  if(o.tables!=null) p.tables=o.tables;
  if(o.len) p.hallLen=o.len; if(o.wid) p.hallWid=o.wid;
  return p;
}
function renderRecommendations(){
  const host=$('#c_recs'); if(!host || !window.HelmSizing) return;
  const o=readCustomForm();
  const recs=HelmSizing.rankTemplates({ type:PRICING.eventType||o.type, guests:o.guests, chairs:o.chairs, len:o.len||WORLD.w, wid:o.wid||WORLD.h }, null, 3);
  host.innerHTML = recs.map((r,idx)=>`<button type="button" class="ccard" data-rec="${idx}" aria-label="Use template: ${esc(r.label)}"><span class="ch">${esc(r.label)}</span>`+
    r.why.map(w=>`<span class="cp">${esc(w)}</span>`).join('')+`<span class="use">Use with my numbers →</span></button>`).join('');
  host.querySelectorAll('[data-rec]').forEach(b=>b.addEventListener('click',()=>applyRecommendation(recs[+b.dataset.rec])));
}
// one-click apply: build the recommended style from the USER's guests/chairs/tables/hall (never the preset's fixed counts)
function applyRecommendation(rec){
  if(!rec) return;
  const o=Object.assign(readCustomForm(), rec.opts||{});
  o.guests=clampCap(o.guests,CAPS.guests); o.chairs=clampCap(o.chairs,CAPS.chairs); o.tables=clampCap(o.tables,CAPS.tables);
  if(!chairsOk(o.chairs)) return;   // R9: 0 chairs is rejected (min 1), never a silent "natural seats" layout
  if(applyRoomFromForm(o)===false) return;
  sizeCanvas();
  const variants=generateVariants(o).map(v=>({...v, items:v.items.map(clampItem)}));
  const v=variants.find(x=>x.name===rec.variant) || variants[0]; if(!v) return;
  loadItems(v.items, 'Template · '+rec.label);
  { const w=seatFitWarning(o.chairs!=null?o.chairs:o.guests, v.counts.natural, v.counts.free, PRICING.eventType||o.type); if(w) BPUI.toast('⚠ '+w+' — all seats placed, packed tight.',{type:'err'}); }
  if(o.guests!=null){ PRICING.guests=o.guests; const g=$('#bGuests'); if(g) g.value=o.guests; }
  persistSizing(sizingPatch(o)).then(()=>{ if(o.guests!=null) persistGuests(); });
  closeCustomModal(); renderAll(); fitView(); renderPrice();
  toast(rec.label+' · '+v.counts.chairs+' chairs');
}
function closeCustomModal(){ $('#customModal').hidden=true; }

/* ===================================================================
   ARRANGEMENT PICKER — count → rows × cols layout options with previews
   =================================================================== */
let arrMode='chairs';   // 'chairs' | 'tables'
// exact divisor pairs + a couple of near-square fallbacks; sorted square→elongated, capped
function layoutOptions(n){
  n=Math.max(1,Math.min(4000,Math.floor(n)||1));
  const seen=new Set(), opts=[];
  const add=(rows,cols,exact)=>{ const k=rows+'x'+cols; if(seen.has(k))return; seen.add(k);
    opts.push({rows,cols,total:rows*cols,exact}); };
  for(let c=1;c<=n;c++) if(n%c===0) add(n/c, c, true);           // every exact factor pair (both orientations)
  if(opts.length<4){                                             // prime-ish → offer filled grids ≥ n
    const s=Math.round(Math.sqrt(n));
    for(let c=Math.max(1,s-1); c<=s+2; c++){ const rows=Math.ceil(n/c); add(rows,c,rows*c===n); }
  }
  const target=WORLD.w/WORLD.h;                                 // prefer floor-ish aspect first
  opts.sort((a,b)=>Math.abs((a.cols/a.rows)-target)-Math.abs((b.cols/b.rows)-target));
  return opts.slice(0,12);
}
function arrPreview(rows,cols){
  const W=118,H=64,pad=6;
  const dc=Math.min(cols,18), dr=Math.min(rows,12);            // cap drawn dots
  const gw=W-2*pad, gh=H-2*pad, r=Math.max(1.1,Math.min(gw/dc,gh/dr)*0.28);
  let dots='';
  for(let i=0;i<dr;i++)for(let j=0;j<dc;j++){
    const x=pad+(j+0.5)/dc*gw, y=pad+(i+0.5)/dr*gh;
    dots+=`<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}"><rect class="plate" x="1" y="1" width="${W-2}" height="${H-2}" rx="4"/>${dots}</svg>`;
}
function tablePreview(rows,cols,shape){
  const W=118,H=64,pad=8, dc=Math.min(cols,8), dr=Math.min(rows,5);
  const gw=W-2*pad, gh=H-2*pad, s=Math.max(3,Math.min(gw/dc,gh/dr)*0.34);
  let g='';
  for(let i=0;i<dr;i++)for(let j=0;j<dc;j++){ const x=pad+(j+0.5)/dc*gw, y=pad+(i+0.5)/dr*gh;
    g+= shape==='square' ? `<rect class="dot" x="${(x-s).toFixed(1)}" y="${(y-s).toFixed(1)}" width="${(s*2).toFixed(1)}" height="${(s*2).toFixed(1)}" rx="1"/>`
                         : `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.toFixed(1)}"/>`; }
  return `<svg viewBox="0 0 ${W} ${H}"><rect class="plate" x="1" y="1" width="${W-2}" height="${H-2}" rx="4"/>${g}</svg>`;
}
function renderArrOptions(){
  const host=$('#arrOptions');
  const cntChk=BPStore.validate.count($('#arrCount').value,{allowZero:false,max:4000,field:arrMode==='tables'?'Tables':'Chairs'});
  if(!cntChk.ok){ host.innerHTML='<p class="arrerr" role="alert">'+esc(cntChk.error)+'</p>'; return; }
  const n=cntChk.value;
  const opts=layoutOptions(n);
  const shape=arrMode==='tables' ? ($('#arrShape').querySelector('.on').dataset.s) : null;
  host.innerHTML = opts.map((o,idx)=>{
    const pv = arrMode==='tables' ? tablePreview(o.rows,o.cols,shape) : arrPreview(o.rows,o.cols);
    const unit = arrMode==='tables' ? 'tables' : 'chairs';
    const note = o.exact ? `= ${o.total} ${unit}` : `≈ ${n} (${o.total} cells)`;
    return `<button type="button" class="aopt" data-idx="${idx}" title="${o.rows} rows × ${o.cols} cols" aria-label="${o.rows} rows by ${o.cols} columns, ${note}">${pv}
      <b>${o.rows} × ${o.cols}</b><small>${note}</small></button>`;
  }).join('');
  host.querySelectorAll('.aopt').forEach(card=>card.addEventListener('click',()=>applyArrangement(opts[+card.dataset.idx])));
}
function openArrangeModal(mode){
  arrMode=mode;
  $('#arrangeModal').hidden=false;
  $('#arrTitle').textContent = mode==='tables' ? 'Add tables' : 'Add seating';
  $('#arrCountLabel').childNodes[0].nodeValue = mode==='tables' ? 'How many tables?' : 'How many chairs?';
  $('#arrShapeWrap').hidden = mode!=='tables';
  $('#arrSeatsWrap').hidden = mode!=='tables';
  $('#arrCount').value = mode==='tables' ? 12 : 100;
  renderArrOptions();
}
function closeArrangeModal(){ $('#arrangeModal').hidden=true; }
function applyArrangement(o){
  if(arrMode==='chairs'){
    // one seating block on a uniform grid → chairs equidistant at `pitch` ft
    const pitch=2.4;
    const w=clamp(o.cols*pitch, 2, WORLD.w-4), h=clamp(o.rows*pitch, 2, WORLD.h-4);
    const x=clamp(WORLD.w/2-w/2,0,WORLD.w-w), y=clamp(WORLD.h/2-h/2,0,WORLD.h-h);
    const it=makeItem('seatblock', x, y, {width:w,height:h,properties:{rows:o.rows,cols:o.cols,pitch},
      label:`Seating ${o.rows}×${o.cols}`});
    store.items.push(it); setSelection([it.id]); commit(); renderAll();
    toast(`Added ${o.rows}×${o.cols} = ${o.total} chairs`);
  } else {
    const shape=$('#arrShape').querySelector('.on').dataset.s;
    const seatsChk=BPStore.validate.num($('#arrSeats').value,{min:2,max:16,integer:true});
    if(!seatsChk.ok){ BPUI.toast('Seats per table '+seatsChk.error,{type:'err'}); return; }
    const seats=seatsChk.value;
    const cellW=(WORLD.w-16)/o.cols, cellH=(WORLD.h-16)/o.rows;
    const dia=clamp(Math.min(cellW,cellH)-4, 3, 12);            // table size to fit the grid
    let n=1;
    for(let r=0;r<o.rows;r++)for(let c=0;c<o.cols;c++){
      const x=8+c*cellW+(cellW-dia)/2, y=8+r*cellH+(cellH-dia)/2;
      store.items.push(makeItem('table', x, y, {width:dia,height:dia,
        properties:{seats, shape}, label:'T'+(n++)}));
    }
    setSelection([]); commit(); renderAll(); fitView();
    toast(`Added ${o.total} ${shape} tables (${seats} seats each)`);
  }
  closeArrangeModal();
}

/* ===================================================================
   TOOLBOX UI
   =================================================================== */
function toolIcon(cat){
  const c='currentColor';
  return `<svg viewBox="0 0 26 20" fill="none" stroke="${c}" stroke-width="1.4"><rect x="3" y="3" width="20" height="14" rx="2"/></svg>`;
}
function buildToolbox(){
  const host=$('#toolbox');
  const byCat={};
  Object.entries(ASSETS).forEach(([type,a])=>{ (byCat[a.category]=byCat[a.category]||[]).push([type,a]); });
  host.innerHTML = SWATCH_CATS.map(cat=>{
    const items=byCat[cat]||[];
    return `<div class="cat">
      <h3><span class="dot" style="background:${catColor(cat)}"></span>${CATS[cat].name}</h3>
      <div class="tools">
        ${items.map(([type,a])=>`<div class="tool" draggable="true" role="button" tabindex="${RO?'-1':'0'}"${RO?' aria-disabled="true"':''} data-type="${type}" style="color:${catColor(cat)}" aria-label="Add ${a.label}">
          ${assetGlyph(type)}<span style="color:var(--ink)">${a.label}</span></div>`).join('')}
      </div></div>`;
  }).join('');
  host.querySelectorAll('.tool').forEach(t=>{
    t.addEventListener('click',()=>{
      const ty=t.dataset.type;
      if(ty==='seatblock'||ty==='chairrow') openArrangeModal('chairs');   // pick a chair grid
      else if(ty==='table') openArrangeModal('tables');                   // pick a table grid + shape
      else addAsset(ty);
      closeDrawers();
    });
    // keyboard: Enter / Space drops the asset at the centre of the visible canvas (same path as a drop)
    t.addEventListener('keydown',e=>{
      if(e.key!=='Enter' && e.key!==' ') return;
      e.preventDefault();
      if(RO) return;
      const ty=t.dataset.type; if(!ASSETS[ty]) return;
      addAsset(ty);
      closeDrawers(true);
    });
    t.addEventListener('dragstart',e=>{ e.dataTransfer.setData('type',t.dataset.type); e.dataTransfer.effectAllowed='copy'; });
  });
}
function assetGlyph(type){
  const c='currentColor';
  const wrap=inner=>`<svg viewBox="0 0 26 20" fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  switch(type){
    case 'stage': return wrap('<rect x="3" y="5" width="20" height="10" rx="1.5"/><path d="M3 15l3 3M23 15l-3 3"/>');
    case 'dancefloor': return wrap('<rect x="5" y="3" width="16" height="14" rx="1"/><path d="M13 3v14M5 10h16"/>');
    case 'podium': return wrap('<rect x="9" y="4" width="8" height="12" rx="1"/><path d="M11 8h4"/>');
    case 'press': return wrap('<rect x="4" y="6" width="18" height="9" rx="1"/><circle cx="9" cy="4" r="1.4"/><circle cx="17" cy="4" r="1.4"/>');
    case 'dj': return wrap('<rect x="4" y="6" width="18" height="9" rx="1"/><circle cx="10" cy="10.5" r="2"/><circle cx="16" cy="10.5" r="2"/>');
    case 'chairrow': return wrap('<circle cx="6" cy="10" r="1.7"/><circle cx="11" cy="10" r="1.7"/><circle cx="16" cy="10" r="1.7"/><circle cx="21" cy="10" r="1.7"/>');
    case 'seatblock': return wrap('<circle cx="7" cy="6" r="1.4"/><circle cx="13" cy="6" r="1.4"/><circle cx="19" cy="6" r="1.4"/><circle cx="7" cy="11" r="1.4"/><circle cx="13" cy="11" r="1.4"/><circle cx="19" cy="11" r="1.4"/>');
    case 'table': return wrap('<circle cx="13" cy="10" r="6"/><circle cx="13" cy="3" r="1.2"/><circle cx="20" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/><circle cx="13" cy="17" r="1.2"/>');
    case 'barricade': return wrap('<rect x="3" y="7" width="20" height="6"/><path d="M4 7l4 6M9 7l4 6M14 7l4 6M19 7l3 5"/>');
    case 'fence': return wrap('<path d="M3 14V6M9 14V6M15 14V6M21 14V6M3 8h18M3 12h18"/>');
    case 'booth': return wrap('<rect x="5" y="4" width="16" height="12" rx="1"/><path d="M5 8h16"/>');
    case 'desk': return wrap('<rect x="4" y="7" width="18" height="6" rx="1"/><path d="M8 13v3M18 13v3"/>');
    case 'truck': return wrap('<rect x="3" y="6" width="13" height="8" rx="1"/><path d="M16 9h4l2 3v2h-6z"/><circle cx="8" cy="16" r="1.6"/><circle cx="19" cy="16" r="1.6"/>');
    case 'exit': return wrap('<rect x="4" y="4" width="18" height="12" rx="1"/><path d="M9 10h6M13 7l3 3-3 3"/>');
    case 'canopy': return wrap('<path d="M4 8h18M6 8v9M20 8v9M4 8l3-4h12l3 4"/>');
    case 'arch': return wrap('<path d="M4 16V11a9 9 0 0 1 18 0v5"/>');
    case 'tent': return wrap('<path d="M13 3L3 16h20zM13 3v13"/>');
    case 'longtable': return wrap('<rect x="4" y="8" width="18" height="4" rx="1"/><circle cx="7" cy="5" r="1.1"/><circle cx="13" cy="5" r="1.1"/><circle cx="19" cy="5" r="1.1"/><circle cx="7" cy="15" r="1.1"/><circle cx="13" cy="15" r="1.1"/><circle cx="19" cy="15" r="1.1"/>');
    case 'headtable': return wrap('<rect x="4" y="9" width="18" height="4" rx="1"/><circle cx="7" cy="5" r="1.1"/><circle cx="13" cy="5" r="1.1"/><circle cx="19" cy="5" r="1.1"/>');
    case 'cocktail': return wrap('<circle cx="13" cy="8" r="4"/><path d="M13 12v5M10 17h6"/>');
    case 'lounge': return wrap('<rect x="4" y="8" width="18" height="7" rx="2"/><path d="M4 11h18M8 8V6h10v2"/>');
    case 'photobooth': return wrap('<rect x="5" y="4" width="16" height="12" rx="1"/><circle cx="13" cy="10" r="3"/>');
    case 'checkpoint': return wrap('<rect x="6" y="4" width="14" height="12" rx="1"/><path d="M10 10l2 2 4-4"/>');
    case 'bar': return wrap('<rect x="4" y="9" width="18" height="5" rx="1"/><path d="M4 9l3-4h12l3 4"/>');
    case 'buffet': return wrap('<rect x="4" y="8" width="18" height="6" rx="1"/><path d="M8 8V5M14 8V5M20 8V5"/>');
    case 'gifttable': return wrap('<rect x="6" y="8" width="14" height="8" rx="1"/><path d="M6 11h14M13 8v8"/>');
    case 'caketable': return wrap('<circle cx="13" cy="10" r="5"/><path d="M13 5v10"/>');
    case 'restroom': return wrap('<rect x="4" y="4" width="18" height="12" rx="1"/><path d="M13 4v12M9 8v4M17 8v4"/>');
    case 'ledscreen': return wrap('<rect x="3" y="5" width="20" height="10" rx="1"/><path d="M6 8h14M6 11h14"/>');
    case 'truss': return wrap('<path d="M7 4v12M19 4v12M7 4l12 12M19 4L7 16M7 8h12M7 12h12"/>');
    case 'speaker': return wrap('<rect x="8" y="3" width="10" height="14" rx="1"/><circle cx="13" cy="12" r="2.5"/><circle cx="13" cy="6" r="1"/>');
    case 'coatcheck': return wrap('<path d="M13 4a2 2 0 0 1 2 2c0 2-2 2-2 3M5 16h16M8 16v-3h10v3"/>');
    case 'firstaid': return wrap('<rect x="4" y="4" width="18" height="12" rx="2"/><path d="M13 7v6M10 10h6"/>');
    case 'planter': return wrap('<path d="M13 14c-4 0-6-3-6-6 4 0 6 3 6 6zM13 14c4 0 6-3 6-6-4 0-6 3-6 6zM13 8v8"/>');
    case 'redcarpet': return wrap('<rect x="8" y="3" width="10" height="14" rx="1"/><path d="M8 7h10M8 11h10"/>');
    case 'parking': return wrap('<rect x="4" y="4" width="18" height="12" rx="1"/><path d="M10 13V7h3a2 2 0 0 1 0 4h-3"/>');
    case 'sofa': return wrap('<path d="M4 10V8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2"/><rect x="3" y="10" width="20" height="5" rx="1.5"/><path d="M6 15v2M20 15v2"/>');
    case 'loveseat': return wrap('<path d="M5 10V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/><rect x="4" y="10" width="18" height="5" rx="1.5"/><path d="M13 10v5"/>');
    case 'armchair': return wrap('<path d="M7 10V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/><rect x="6" y="10" width="14" height="5" rx="1.5"/><path d="M8 15v2M18 15v2"/>');
    case 'ottoman': return wrap('<rect x="6" y="8" width="14" height="7" rx="2"/><path d="M6 11h14"/>');
    case 'bench': return wrap('<rect x="3" y="8" width="20" height="4" rx="1"/><path d="M6 12v4M20 12v4"/>');
    case 'coffeetable': return wrap('<rect x="4" y="7" width="18" height="5" rx="1"/><path d="M7 12v4M19 12v4"/>');
    case 'floral': return wrap('<circle cx="13" cy="7" r="2.5"/><circle cx="8" cy="10" r="2.2"/><circle cx="18" cy="10" r="2.2"/><path d="M13 9v7M9 16h8"/>');
    case 'floralarch': return wrap('<path d="M4 16V11a9 9 0 0 1 18 0v5"/><circle cx="6" cy="8" r="1.4"/><circle cx="13" cy="3.5" r="1.4"/><circle cx="20" cy="8" r="1.4"/>');
    case 'mandap': return wrap('<path d="M4 8h18M6 8v9M20 8v9M4 8l3-4h12l3 4"/><path d="M9 17c0-2 1.5-3 4-3s4 1 4 3"/>');
    case 'pillar': return wrap('<rect x="10" y="4" width="6" height="12" rx="1"/><path d="M8 4h10M8 16h10"/>');
    case 'drape': return wrap('<path d="M4 4h18M6 4c0 5-1 8-1 12M11 4c0 5 1 8 1 12M17 4c0 5-1 8-1 12M21 4c0 5-1 8-1 12"/>');
    case 'chandelier': return wrap('<path d="M13 3v4M7 12a6 6 0 0 1 12 0M7 12v2M13 12v2M19 12v2"/><circle cx="13" cy="9" r="1.4"/>');
    case 'fountain': return wrap('<circle cx="13" cy="12" r="7"/><path d="M13 5v4M11 8l2-3 2 3"/><path d="M8 12h10"/>');
    case 'uplight': return wrap('<path d="M9 16h8l-1.5-6h-5z"/><path d="M13 10V4M10 6l3-2 3 2"/>');
    case 'heater': return wrap('<circle cx="13" cy="6" r="3"/><path d="M13 9v7M9 16h8"/>');
    case 'easel': return wrap('<rect x="7" y="4" width="12" height="8" rx="1"/><path d="M8 12l-2 5M18 12l2 5M9 15h8"/>');
    case 'chiavari': return wrap('<path d="M9 4h8M10 4v12M16 4v12M8 16h10M11 8h4M11 11h4"/>');
    case 'barstool': return wrap('<circle cx="13" cy="7" r="4"/><path d="M13 11v7M9 14h8M10 18h6"/>');
    case 'piano': return wrap('<path d="M4 6h11a5 5 0 0 1 0 10H4z"/><path d="M4 12h9M7 6v6M10 6v6"/>');
    case 'bleacher': return wrap('<path d="M3 16h18M5 16v-3h14v3M7 13v-3h10v3M9 10V7h6v3"/>');
    default: return toolIcon();
  }
}

/* drag-drop from toolbox onto canvas */
scrollEl.addEventListener('dragover',e=>{ e.preventDefault(); e.dataTransfer.dropEffect='copy'; });
scrollEl.addEventListener('drop',e=>{
  e.preventDefault();
  if(RO) return;
  const type=e.dataTransfer.getData('type'); if(!type||!ASSETS[type])return;
  addAsset(type, svgPointFt(e));
});

/* ===================================================================
   VIEW: zoom / fit / pan-center
   =================================================================== */
function viewCenterFt(){
  const cx=(scrollEl.scrollLeft+scrollEl.clientWidth/2)/(PX_PER_FT*store.view.zoom);
  const cy=(scrollEl.scrollTop+scrollEl.clientHeight/2)/(PX_PER_FT*store.view.zoom);
  return {x:clamp(cx,0,WORLD.w), y:clamp(cy,0,WORLD.h)};
}
let viewAtFit=true;   // still showing the "fit" zoom (no manual zoom since the last fit)
function setZoom(z, anchor){
  viewAtFit=false;
  const old=store.view.zoom;
  z=clamp(z,0.25,3);
  const a=anchor||{x:scrollEl.scrollLeft+scrollEl.clientWidth/2, y:scrollEl.scrollTop+scrollEl.clientHeight/2};
  const fx=a.x/old, fy=a.y/old;                 // in base-px world coords
  store.view.zoom=z;
  sizeCanvas();
  scrollEl.scrollLeft=fx*z-(anchor?anchor.sx:scrollEl.clientWidth/2);
  scrollEl.scrollTop =fy*z-(anchor?anchor.sy:scrollEl.clientHeight/2);
  $('#zoomLbl').textContent=Math.round(z*100)+'%';
  renderRulers();
}
function fitView(){
  const pad=40;
  const zx=(scrollEl.clientWidth-pad)/(WORLD.w*PX_PER_FT);
  const zy=(scrollEl.clientHeight-pad)/(WORLD.h*PX_PER_FT);
  store.view.zoom=clamp(Math.min(zx,zy),0.25,3);
  viewAtFit=true;
  sizeCanvas();
  $('#zoomLbl').textContent=Math.round(store.view.zoom*100)+'%';
  scrollEl.scrollLeft=(svg.width.baseVal.value-scrollEl.clientWidth)/2;
  scrollEl.scrollTop=0;
  renderRulers();
}
/* ---- camera pan pad (2D: scroll offset · 3D: delegated to builder-3d.js) ---- */
const PAN_DIRS={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]};
function is3DActive(){ const st=$('#stage3d'); return !!(st && !st.hidden); }
// pan the 2D viewport by `frac` of the visible area (step scales with what you see, i.e. with zoom)
function pan2D(dir, frac){
  const v=PAN_DIRS[dir]; if(!v) return;
  const f=(frac==null?0.15:frac);
  scrollEl.scrollLeft += v[0]*scrollEl.clientWidth*f;
  scrollEl.scrollTop  += v[1]*scrollEl.clientHeight*f;
  renderRulers();
}
function panViewStep(dir, mult){
  if(is3DActive() && typeof window.__pan3D==='function') window.__pan3D(dir, 0.08*(mult||1));
  else pan2D(dir, 0.15*(mult||1));
}
function recenterView(){
  if(is3DActive() && typeof window.__recenter3D==='function') window.__recenter3D();
  else fitView();
}
(function wireNavPad(){
  const pad=$('#navPad'); if(!pad) return;
  // keep pointer/mouse/touch/wheel events off the canvas (no marquee, drag or gizmo underneath)
  ['pointerdown','mousedown','touchstart','click','dblclick','wheel','contextmenu'].forEach(t=>pad.addEventListener(t,e=>e.stopPropagation(),{passive:t!=='contextmenu'&&t!=='wheel'?true:false}));
  let raf=null, held=null, last=0;
  const stop=()=>{ held=null; if(raf){ cancelAnimationFrame(raf); raf=null; } };
  const tick=ts=>{ if(!held) return;
    const dt=Math.min(64, ts-(last||ts)); last=ts;
    // continuous: ~60% of a view per second (2D) / proportional in 3D
    if(is3DActive() && typeof window.__pan3D==='function') window.__pan3D(held, 0.35*dt/1000);
    else pan2D(held, 0.6*dt/1000);
    raf=requestAnimationFrame(tick); };
  pad.querySelectorAll('button[data-pan]').forEach(b=>{
    const dir=b.dataset.pan;
    if(dir==='center'){ b.addEventListener('click',()=>recenterView()); return; }
    b.addEventListener('pointerdown',e=>{
      if(e.button!==undefined && e.button!==0) return;
      panViewStep(dir,1);                       // immediate step on press
      stop(); held=dir; last=0;
      try{ b.setPointerCapture(e.pointerId); }catch{}
      const reduce=window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if(!reduce) setTimeout(()=>{ if(held===dir && !raf) raf=requestAnimationFrame(tick); }, 250);
    });
    ['pointerup','pointercancel','lostpointercapture','pointerleave'].forEach(t=>b.addEventListener(t,stop));
    b.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); e.stopPropagation(); panViewStep(dir,1); } });
  });
  window.addEventListener('blur',stop);
})();
window.__builderPan={pan2D, panViewStep, recenterView};

$('#zoomIn').addEventListener('click',()=>setZoom(store.view.zoom*1.2));
$('#zoomOut').addEventListener('click',()=>setZoom(store.view.zoom/1.2));
$('#zoomFit').addEventListener('click',()=>fitView());
scrollEl.addEventListener('scroll',renderRulers,{passive:true});
scrollEl.addEventListener('wheel',e=>{
  if(!(e.ctrlKey||e.metaKey))return;
  e.preventDefault();
  const r=scrollEl.getBoundingClientRect();
  const sx=e.clientX-r.left, sy=e.clientY-r.top;
  const anchor={x:scrollEl.scrollLeft+sx, y:scrollEl.scrollTop+sy, sx, sy};
  setZoom(store.view.zoom*(e.deltaY<0?1.12:1/1.12), anchor);
},{passive:false});

/* ===================================================================
   HEADER CONTROLS
   =================================================================== */
$('#preset').addEventListener('change',async e=>{
  const v=e.target.value;
  if(RO){ e.target.value=''; return; }
  if(!v){ return; }
  if(store.items.length && !(await BPUI.confirm('Load this template? It replaces the current floor (you can Undo).',{title:'Replace the floor?',okLabel:'Load template'}))){ e.target.value=''; return; }
  loadTemplate(v);
  e.target.value='';
});
/* ---- collapsible side panels: arrow tab at the panel edge, state per user ---- */
function initPanelToggles(){
  const key=()=>'bps.panels.'+((()=>{ try{ const u=BPStore.auth.user(); return u&&u.id?String(u.id):'anon'; }catch{ return 'anon'; } })());
  let st={}; try{ st=JSON.parse(localStorage.getItem(key())||'{}')||{}; }catch{ st={}; }
  const defs=[
    { btn:'#leftToggle',  panel:'#leftPanel',  side:'l', name:'asset toolbox' },
    { btn:'#rightToggle', panel:'#rightPanel', side:'r', name:'price & inspector panel' },
  ];
  // after a panel slides, re-fit the 2D plan to the new canvas size unless the user zoomed by hand
  const kick=()=>{ try{ window.dispatchEvent(new Event('resize')); }catch{} try{ if(viewAtFit && !is3DActive()) fitView(); }catch{} };
  const apply=(d, collapsed, animate)=>{
    const b=$(d.btn), p=$(d.panel); if(!b||!p) return;
    p.classList.toggle('collapsed', collapsed);
    b.setAttribute('aria-expanded', String(!collapsed));
    const label=(collapsed?'Expand ':'Collapse ')+d.name;
    b.setAttribute('aria-label', label); b.title=label;
    // left: ‹ open / › closed — right is mirrored
    b.textContent = d.side==='l' ? (collapsed?'›':'‹') : (collapsed?'‹':'›');
    if(!animate) kick();
  };
  defs.forEach(d=>{
    const b=$(d.btn), p=$(d.panel); if(!b||!p) return;
    apply(d, !!st[d.side], false);
    p.addEventListener('transitionend', e=>{ if(e.target===p && e.propertyName==='width') kick(); });
    b.addEventListener('click', ()=>{
      const collapsed=!p.classList.contains('collapsed');
      apply(d, collapsed, true);
      st[d.side]=collapsed; try{ localStorage.setItem(key(), JSON.stringify(st)); }catch{}
      setTimeout(kick, 260);   // fallback if transitions are disabled
    });
  });
}

/* ---- Past-events reference browser: load a previous event's saved layout ---- */
async function populateRefEvents(){
  const sel=$('#refEvents'); if(!sel) return;
  let qs=[]; try{ qs=await BPStore.quotes.list(); }catch{ return; }
  const others=(qs||[]).filter(q=>q.id!==currentQuoteId);
  others.sort((a,b)=>String(b.event_date||b.updated_at||'').localeCompare(String(a.event_date||a.updated_at||'')));
  const isClosed=(q)=> q.lifecycle_stage==='closed' || q.status==='cancelled';
  const closed=others.filter(isClosed), active=others.filter(q=>!isClosed(q));
  const opt=(q)=>{ const cl=(q.client&&q.client.name)||''; const d=(q.event_date||'').slice(0,10);
    return `<option value="${esc(q.id)}">${esc(q.code||'event')}${cl?' · '+esc(cl):''}${d?' · '+esc(d):''}</option>`; };
  let html='<option value="">Reference a past layout…</option>';
  if(closed.length) html+='<optgroup label="Completed / closed">'+closed.map(opt).join('')+'</optgroup>';
  if(active.length) html+='<optgroup label="Other events">'+active.map(opt).join('')+'</optgroup>';
  sel.innerHTML=html;
}
$('#refEvents').addEventListener('change', async (e)=>{
  const qid=e.target.value; if(!qid) return;
  if(RO){ e.target.value=''; toast('Read-only — cannot load a layout here'); return; }
  const label=e.target.options[e.target.selectedIndex].textContent;
  if(store.items.length && !(await BPUI.confirm('Load the layout from "'+label+'" onto the canvas? This replaces the current objects (you can Undo).',{title:'Replace the floor?',okLabel:'Load layout'}))){ e.target.value=''; return; }
  try{
    const q=await BPStore.quotes.get(qid);
    const ver=await BPStore.quotes.getVersion(qid, q.currentVersion);
    const items=(ver && ver.data && ver.data.items)||[];
    if(!items.length){ toast('That event has no saved layout.'); e.target.value=''; return; }
    loadItems(stripStalePrices(items), 'Ref: '+(q.code||'past event'));
    toast('Loaded layout from '+(q.code||'past event')+' · Prices updated to current rates');
  }catch(err){ toast('Could not load that layout'); }
  e.target.value='';
});
function setUnit(u){
  store.grid.unit = (u==='m') ? 'm' : 'ft';     // allowlisted
  store.grid.sizeFt=cellFt();
  $('#cornerUnit').textContent=uLabel();
  const sel=$('#unitSel'); if(sel && sel.value!==store.grid.unit) sel.value=store.grid.unit;
  renderAll();
}
$('#unitSel').addEventListener('change',e=>setUnit(e.target.value));
$('#measureBtn').addEventListener('click',()=>{
  showMeasure=!showMeasure;
  $('#measureBtn').classList.toggle('on', showMeasure);
  // measurements are a 2D-plan tool — pop back to 2D if we're in 3D/Render
  if(showMeasure){ const b2d=document.querySelector('#viewSeg [data-v="2d"]'); if(b2d && !b2d.classList.contains('on')) b2d.click(); }
  renderAll();
});
$('#snapBtn').addEventListener('click',()=>{ store.grid.snap=!store.grid.snap; $('#snapBtn').classList.toggle('on',store.grid.snap); if(window.__on3DSnapChange) window.__on3DSnapChange(); });
$('#gridBtn').addEventListener('click',()=>{ store.grid.show=!store.grid.show; $('#gridBtn').classList.toggle('on',store.grid.show); renderAll(); });
$('#undoBtn').addEventListener('click',undo);
$('#redoBtn').addEventListener('click',redo);
$('#clearBtn').addEventListener('click',async()=>{
  if(!store.items.length) return;
  if(await BPUI.confirm('Remove every object from the floor? You can Undo this.',{title:'Clear the floor?',okLabel:'Clear floor',danger:true})){ store.items=[]; setSelection([]); commit(); renderAll(); toast('Floor cleared'); }
});
$('#stateDetails').addEventListener('toggle',()=>{ if($('#stateDetails').open) renderState(); });

function deleteSelected(){
  if(!store.selectedIds.length) return;
  const set=new Set(store.selectedIds), n=set.size;
  store.items=store.items.filter(i=>!set.has(i.id));
  setSelection([]); commit(); renderAll(); toast(n>1?`Deleted ${n} objects`:'Deleted');
}

/* ---- clipboard + group operations ---- */
let clipboard=[];
// per-user key: a shared browser must never paste the previous account's objects; size-capped
const userKey = ()=>{ try{ const u=BPStore.auth.user(); return u&&u.id ? String(u.id) : 'anon'; }catch{ return 'anon'; } };
const clipKey = ()=>'bps.clip.'+userKey();
const readClip = ()=>{ try{ const v=JSON.parse(localStorage.getItem(clipKey())||'[]'); return Array.isArray(v)?v.slice(0,500):[]; }catch{ return []; } };
const writeClip = v=>{ clipboard=v.slice(0,500); try{ const s=JSON.stringify(clipboard); if(s.length<=1000000) localStorage.setItem(clipKey(), s); localStorage.removeItem('bps.clip'); }catch{} };
function copySelection(){ const items=selectedItems(); if(!items.length) return; writeClip(items.map(clone)); toast(`Copied ${items.length}`); }
function placeCopies(src, msg){
  if(!src.length) return; const off=cellFt()*2, ids=[];
  // paste relative to the group's own top-left so multi-object shape is preserved
  src.filter(s=>s && typeof s==='object').forEach(s=>{ const c=sanitizeItem(clone(s)); c.id=nid(); clampItem(c);
    c.x=clamp(round1((c.x||0)+off),0,WORLD.w-c.width); c.y=clamp(round1((c.y||0)+off),0,WORLD.h-c.height);
    if(c.category&&CATS[c.category]&&!c.colorCustom) c.color=catColor(c.category);
    store.items.push(c); ids.push(c.id); });
  setSelection(ids); commit(); renderAll(); toast(`${msg} ${ids.length}`);
}
function pasteClipboard(){ placeCopies(clipboard.length?clipboard:readClip(), 'Pasted'); }
function duplicateSelection(){ placeCopies(selectedItems().map(clone), 'Duplicated'); }
function nudgeSelection(dx,dy){
  const items=selectedItems(); if(!items.length) return;
  let mnx=-Infinity,mxx=Infinity,mny=-Infinity,mxy=Infinity;
  items.forEach(it=>{ mnx=Math.max(mnx,-it.x); mxx=Math.min(mxx,WORLD.w-it.width-it.x);
    mny=Math.max(mny,-it.y); mxy=Math.min(mxy,WORLD.h-it.height-it.y); });
  dx=clamp(dx,mnx,mxx); dy=clamp(dy,mny,mxy);
  items.forEach(it=>{ it.x=round1(it.x+dx); it.y=round1(it.y+dy); });
  commit(); renderAll();
}

/* keyboard */
const anyModalOpen=()=>!!document.querySelector('.modal:not([hidden]), .bpui-overlay');
window.addEventListener('keydown',e=>{
  // a dialog owns the keyboard (BPUI handles Escape / focus trap) — never nudge/delete the floor behind it
  if(anyModalOpen()) return;
  if(e.key==='Escape' && drawersOpen()){ closeDrawers(true); return; }
  const mod=e.metaKey||e.ctrlKey;
  const typing=/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if(RO){                                       // view-only: only select-all / copy / escape
    if(typing) return;
    if(mod&&e.key.toLowerCase()==='a'){ e.preventDefault(); setSelection(store.items.map(i=>i.id)); renderAll(); }
    else if(mod&&e.key.toLowerCase()==='c'){ e.preventDefault(); copySelection(); }
    else if(e.key==='Escape'&&store.selectedIds.length){ clearSelection(); renderAll(); }
    return;
  }
  if(mod&&e.key.toLowerCase()==='s'){ e.preventDefault(); guardedSave(); return; }
  if(mod&&!typing&&e.key.toLowerCase()==='z'){ e.preventDefault(); e.shiftKey?redo():undo(); return; }  // let native undo work inside text fields
  if(mod&&!typing&&e.key.toLowerCase()==='y'){ e.preventDefault(); redo(); return; }
  if(typing) return;
  if(mod&&e.key.toLowerCase()==='a'){ e.preventDefault(); setSelection(store.items.map(i=>i.id)); renderAll(); return; }
  if(mod&&e.key.toLowerCase()==='c'){ e.preventDefault(); copySelection(); return; }
  if(mod&&e.key.toLowerCase()==='v'){ e.preventDefault(); pasteClipboard(); return; }
  if(mod&&e.key.toLowerCase()==='d'){ e.preventDefault(); duplicateSelection(); return; }
  if((e.key==='Delete'||e.key==='Backspace')&&store.selectedIds.length){ e.preventDefault(); deleteSelected(); return; }
  if(e.key==='Escape'&&store.selectedIds.length){ clearSelection(); renderAll(); return; }
  if(!store.selectedIds.length){
    const d={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'}[e.key];
    if(d && e.shiftKey){ e.preventDefault(); panViewStep(d, 1); }
    return;
  }
  if(mod||e.altKey) return;                       // Cmd/Ctrl/Alt combos (e.g. Cmd+R reload) are not r/d shortcuts
  const step=e.shiftKey?cellFt()*5:cellFt();
  if(e.key==='ArrowLeft'){ e.preventDefault(); nudgeSelection(-step,0); }
  else if(e.key==='ArrowRight'){ e.preventDefault(); nudgeSelection(step,0); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); nudgeSelection(0,-step); }
  else if(e.key==='ArrowDown'){ e.preventDefault(); nudgeSelection(0,step); }
  else if(e.key.toLowerCase()==='r'){ selectedItems().forEach(it=>it.rotation=(it.rotation+15)%360); commit(); renderAll(); }
  else if(e.key.toLowerCase()==='d'){ duplicateSelection(); }
});

/* toast */
let toastT;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),1600); }

/* empty-floor start guide (shown when an event has no objects, 2D plan only) */
function updateEmptyState(){
  const es=$('#emptyState'); if(!es) return;
  const threeD = $('#stage3d') && !$('#stage3d').hidden;
  es.hidden = layoutLoading || RO || threeD || (store.items && store.items.length>0);
  const ld=$('#layoutLoading'); if(ld) ld.hidden = !layoutLoading;
}
/* R4: while an existing event's quote/layout is being fetched, show a neutral loading state —
   never the blank-floor prompt or "Untitled event" (they flashed for 1-2s before the layout arrived). */
function setLayoutLoading(on){
  layoutLoading=!!on;
  const pn=$('#projName');
  if(pn){ if(on){ pn.dataset.ph=pn.placeholder||''; pn.value=''; pn.placeholder='Loading…'; } else if(pn.dataset.ph!=null){ pn.placeholder=pn.dataset.ph; delete pn.dataset.ph; if(!pn.value) pn.value='Untitled event'; } }
  updateEmptyState();
}
// clean template picker built from the #preset dropdown's optgroups
function openTemplatePicker(){
  const preset=$('#preset'), body=$('#tplBody'); if(!preset||!body) return;
  let html='';
  preset.querySelectorAll('optgroup').forEach(g=>{
    html+=`<div class="tpl-group">${g.label}</div><div class="tpl-grid">`;
    g.querySelectorAll('option').forEach(o=>{ if(o.value) html+=`<button type="button" class="tpl-card" data-k="${escapeHtml(o.value)}">${escapeHtml(o.textContent)}</button>`; });
    html+='</div>';
  });
  body.innerHTML=html;
  body.querySelectorAll('.tpl-card').forEach(c=>c.addEventListener('click',async()=>{
    closeTemplatePicker();
    if(store.items.length && !(await BPUI.confirm('Load this template? It replaces the current floor (you can Undo).',{title:'Replace the floor?',okLabel:'Load template'}))) return;
    loadTemplate(c.dataset.k); const es=$('#emptyState'); if(es) es.hidden=true;
  }));
  $('#tplModal').hidden=false;
}
function closeTemplatePicker(){ const m=$('#tplModal'); if(m) m.hidden=true; }
(function wireEmptyState(){
  const t=$('#es_template'), c=$('#es_custom'), b=$('#es_blank');
  if(t) t.addEventListener('click',openTemplatePicker);
  if(c) c.addEventListener('click',()=>{ if(typeof openCustomModal==='function') openCustomModal(); });
  if(b) b.addEventListener('click',()=>{ const es=$('#emptyState'); if(es) es.hidden=true; });
  const tc=$('#tplClose'); if(tc) tc.addEventListener('click',closeTemplatePicker);
  const tm=$('#tplModal'); if(tm) tm.addEventListener('click',e=>{ if(e.target.id==='tplModal') closeTemplatePicker(); });
})();

/* ===================================================================
   PERSISTENCE  — REST backend with graceful localStorage fallback
   =================================================================== */
let currentLayoutId = null;       // id of the open layout (legacy layouts tier)
let currentQuoteId = null;        // id of the open QUOTE (primary flow) — save appends a version
let currentQuoteCode = null;      // the quote's MMDDYYYY-NN code (for the header readout)
let currentVersionNo = null;      // which version is loaded (for the header readout)
let currentClient = {};           // the open quote's client object (so we can persist guests without clobbering it)
let currentQuoteGuard = { approved:false, closed:false }, _staleAck=false;
let currentPricing = {};          // the open quote's saved pricing inputs (discount/coupon/rates) — refreshed, not clobbered

function sanitizeMargins(m){
  m = m || {}; const w=WORLD.w, h=WORLD.h;
  const n=(v)=> (isFinite(+v)&&+v>=0) ? +v : 0;
  let left=n(m.left), right=n(m.right), top=n(m.top), bottom=n(m.bottom);
  if(left+right  > w-1){ left=Math.min(left,w-1); right=Math.min(right, Math.max(0,w-1-left)); }
  if(top+bottom > h-1){ top=Math.min(top,h-1);  bottom=Math.min(bottom, Math.max(0,h-1-top)); }
  return { left:round1(left), right:round1(right), top:round1(top), bottom:round1(bottom) };
}
function serialize(){
  return { items: JSON.parse(JSON.stringify(store.items)),
    grid: { ...store.grid }, margins: { ...(store.margins||{left:0,right:0,top:0,bottom:0}) },
    venue: JSON.parse(JSON.stringify(store.venue||{})),
    scale:{ pxPerFt:PX_PER_FT, worldFt:{ w:WORLD.w, h:WORLD.h } },   // copy, not a live reference
    savedAt: new Date().toISOString() };
}
function applyLayout(data){
  if(!data || !Array.isArray(data.items)) return;
  // start from defaults so a legacy/partial document never inherits the previous hall size or capacity
  WORLD.w = DEFAULT_WORLD.w; WORLD.h = DEFAULT_WORLD.h; store.venue = { capacity:null };
  // restore the saved hall size FIRST so items clamp to the right room
  const rf = (data.scale && data.scale.worldFt) || (data.venue && data.venue.room);
  if(rf && rf.w && rf.h && isFinite(rf.w) && isFinite(rf.h)){ WORLD.w = clamp(Math.round(rf.w),20,1000); WORLD.h = clamp(Math.round(rf.h),20,1000); }
  if(data.items.length>MAX_ITEMS) toast('This layout has '+data.items.length+' objects — only the first '+MAX_ITEMS+' were loaded');
  store.items = JSON.parse(JSON.stringify(data.items.slice(0,MAX_ITEMS))).filter(it=>it && typeof it==='object');
  // normalise externally-authored / legacy JSON so a missing field can't crash the render
  store.items.forEach(it=>{
    sanitizeItem(it);                    // properties / category / type / label / id
    // keep a saved custom colour; otherwise (or if it's not a valid hex) derive from the category
    if(!it.colorCustom || !HEXRE.test(it.color.trim())) it.color = catColor(it.category);
    clampItem(it);                       // coerce geometry so a malformed/legacy item can't render NaN
  });
  dedupeIds(store.items);
  if(data.grid){ store.grid = sanitizeGrid(data.grid); syncGridUI(); }
  store.margins = sanitizeMargins(data.margins);   // restore draggable margins (0s if none saved)
  if(data.venue){ store.venue = sanitizeVenue(data.venue); }
  updateDimsLabel();
  const ci=$('#capInput'); if(ci) ci.value = store.venue.capacity!=null ? store.venue.capacity : '';
  setSelection([]); resetHistory();          // opened doc is the clean baseline — nothing to undo before it
  setSavedBaseline();
  renderAll(); fitView();
}
function syncGridUI(){
  $('#cornerUnit').textContent = uLabel();
  $('#unitSel').value = store.grid.unit==='m' ? 'm' : 'ft';
  $('#snapBtn').classList.toggle('on', store.grid.snap);
  $('#gridBtn').classList.toggle('on', store.grid.show);
}

/* ---- storage: delegated to BPStore (Supabase → Node API → localStorage) ---- */
const MODE_LABEL = { supabase:'Supabase', server:'Server', local:'Local' };
function setConn(mode){                       // no on-screen indicator any more — keep the storage mode as a tooltip on the account menu
  const label=MODE_LABEL[mode]||mode; const m=$('#acctMenu');
  if(m) m.title = 'Storage: '+label + (mode==='local'?' (this browser only)':'');
}
async function initStore(){ await BPStore.init(); setConn(BPStore.mode()); }
async function renderAccountChip(){
  const el=$('#acct'); if(!el) return; const menu=$('#acctMenu');
  if(!BPStore.auth.enabled() || !BPStore.auth.user()){ if(menu) menu.hidden=true; return; }
  if(menu) menu.hidden=false;
  const role=await BPStore.auth.role(), email=BPStore.auth.user().email;
  el.innerHTML=`<span class="role">${escapeHtml(role||'')}</span><span class="acct-email">${escapeHtml(email||'')}</span><button type="button" id="signOutBtn">Sign out</button>`;
  $('#signOutBtn').addEventListener('click', async ()=>{ await BPStore.auth.signOut(); location.replace('/login'); });
}

// Save via the button / ⌘S is double-submit guarded (the button is disabled while it runs).
function guardedSave(){ return BPUI.guard($('#saveBtn'), ()=>saveLayout(false)).catch(()=>{}); }
let saving=false;
// → true when the layout was stored. With a quote open, EVERY save appends a new version (never an
// overwrite) — also when an older version is on screen; opts.label is the version's note.
async function saveLayout(silent, opts){
  if(RO){ if(!silent) toast('View only — you can’t save'); return false; }
  if(!currentQuoteId && !currentLayoutId && !CAN_CREATE){ if(!silent) toast('Your role can edit existing events, not create new ones'); return false; }
  if(saving) return false;                    // in-flight lock: a second Save/⌘S before the first resolves must not create a duplicate
  saving=true;
  const sig = docSig();                        // edits made while this save is in flight keep the page dirty
  const name = ($('#projName').value || 'Untitled event').trim().slice(0,120);
  const data = serialize();
  const btn=$('#saveBtn'); if(btn){ btn.disabled=true; if(silent) btn.textContent='⏳ Saving…'; }
  try{
    if(currentQuoteId){
      // primary flow: every save is a new VERSION of the open quote
      const fromNo = currentVersionNo, fromOlder = isViewingOlder();
      const label = (opts && opts.label) || (fromOlder ? 'Based on V'+fromNo : null);
      if(currentQuoteGuard.closed){ if(!silent) await BPUI.alert('This event is closed, so its layout can’t be changed.',{title:'Event closed'}); return false; }
      if(currentQuoteGuard.approved && !_staleAck){
        if(silent) return false;
        const go = await BPUI.confirm('This quote is already confirmed/approved. Saving a new layout re-prices it, so the client’s approval will go stale and they will need to approve again (payments pause until then). Save anyway?',{title:'Client approval will go stale',okLabel:'Save and re-price'});
        if(!go) return false;
        _staleAck=true;
      }
      if(name) { try{ await BPStore.quotes.updateMeta(currentQuoteId, { title:name }); }catch{} }
      const v = await BPStore.quotes.addVersion(currentQuoteId, label, data, store.items.length);
      currentVersionNo = v.version_no || v.versionNo;
      noteSavedVersion(v, label);
      refreshVersionsSoon(true);                // re-read the server list (names, teammates' saves)
      clearDraft();
      updateQuoteBadge();
      syncQuotePricing();                       // keep the stored quote total in step with the layout
      setTimeout(()=>{ autoCaptureIfStale(); }, 400);   // R2: keep the client booklet images in step
      if(silent){ if(btn){ btn.textContent='✓ v'+currentVersionNo; clearTimeout(saveBtnT); saveBtnT=setTimeout(()=>{ btn.innerHTML='💾 Save'; },1500); } }
      else toast(fromOlder ? 'Saved as V'+currentVersionNo+' (new latest) — V'+fromNo+' is unchanged' : 'Saved version '+currentVersionNo);
    } else {
      const isLocalId = currentLayoutId && String(currentLayoutId).startsWith('local_');
      const saved = (!currentLayoutId || (isLocalId && BPStore.mode()!=='local'))
        ? await BPStore.create(name, data)
        : await BPStore.update(currentLayoutId, { name, data });
      if(isLocalId && saved.id!==currentLayoutId) { try{ await BPStore.remove(currentLayoutId); }catch{} }
      currentLayoutId = saved.id;
      if(silent){ if(btn){ btn.textContent='✓ Saved'; clearTimeout(saveBtnT); saveBtnT=setTimeout(()=>{ btn.innerHTML='💾 Save'; },1500); } }
      else toast('Saved “'+saved.name+'”');
    }
    setConn(BPStore.mode());
    setSavedBaseline(sig);
    return true;
  }catch(e){ if(btn) btn.innerHTML='💾 Save';
    if(!silent) BPUI.toast(BPUI.friendlyError(e,{action:'save the layout'}),{type:'err'});
    else toast('Autosave failed — press Save to retry');
    return false; }
  finally{ saving=false; if(btn) btn.disabled=false; }
}
function updateQuoteBadge(){
  { const cb=document.getElementById('clientImgBtn'); if(cb) cb.hidden=!clientImagesSupported(); }
  const el=$('#quoteBadge'); if(!el) return;
  if(currentQuoteId && currentQuoteCode){ el.hidden=false; el.textContent=quoteBadgeText(); }
  else el.hidden=true;
  renderVersionUI();
  updateDesignChip();
}
// the version dropdown shows the version, so the badge then carries just the quote code
function quoteBadgeText(){ const sel=$('#verSel'); return currentQuoteCode + (sel && !sel.hidden ? '' : ' · v'+(currentVersionNo||1)); }

/* ===================================================================
   LAYOUT VERSIONS — a dropdown of every saved version of the open quote
   (version · date/time · who · note). Picking one only LOADS it into the
   editor: no saved version and no current_version pointer is touched.
   Saving — from any version — appends a NEW version (history is append-only).
   =================================================================== */
let versionsList = [];        // [{versionNo,label,createdAt,createdBy,objectCount}] newest first
let latestVersionNo = null;   // highest saved version_no of the open quote
let versionNames = null;      // user id → display name, for "who saved" (best-effort)
let myUserId = null;
let verBusy = false;          // a switch is in progress (dropdown locked)
function isViewingOlder(){ return !!(currentQuoteId && currentVersionNo && latestVersionNo && currentVersionNo<latestVersionNo); }
function versionOptionLabel(v, latestNo, names, meId){
  const parts=['V'+v.versionNo+(v.versionNo===latestNo?' (latest)':'')];
  if(v.createdAt){ const d=new Date(v.createdAt); if(!isNaN(d)) parts.push(d.toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})); }
  if(v.createdBy){ const who = (meId && v.createdBy===meId) ? 'you' : (names && names[v.createdBy]); if(who) parts.push(who); }
  const note=String(v.label||'').replace(/\s+/g,' ').trim();
  if(note) parts.push('“'+(note.length>40 ? note.slice(0,39)+'…' : note)+'”');
  return parts.join(' · ');
}
async function loadVersionNames(){
  if(versionNames) return versionNames;
  const names={};
  try{ const u=BPStore.auth && BPStore.auth.user && BPStore.auth.user(); if(u && u.id) myUserId=u.id; }catch{}
  try{ (await BPStore.chat.roster() || []).forEach(p=>{ if(p && p.id) names[p.id]=BPStore.chat.displayName(p); }); }catch{}
  versionNames=names; return names;
}
async function refreshVersions(){
  if(!currentQuoteId){ versionsList=[]; renderVersionUI(); return; }
  try{ versionsList = await BPStore.quotes.versions(currentQuoteId) || []; }catch{ /* keep what we had */ }
  latestVersionNo = Math.max(latestVersionNo||0, ...versionsList.map(v=>+v.versionNo||0)) || currentVersionNo;
  if(versionsList.some(v=>v.createdBy)) await loadVersionNames();
  updateQuoteBadge();
}
// Live version list (R3): the list used to be read once when the quote opened, so a version
// saved on another device / tab never appeared (and "latest" stayed wrong) until a reload.
// Now it re-reads the server when the dropdown is opened, when the tab comes back into view,
// after every save, and on realtime inserts into quote_versions (0077 publication).
let verSub=null, verRefreshAt=0, verRefreshT=null;
function refreshVersionsSoon(force){
  if(!currentQuoteId) return;
  const now=Date.now(); if(!force && now-verRefreshAt<3000) return;
  verRefreshAt=now; clearTimeout(verRefreshT);
  verRefreshT=setTimeout(async()=>{
    const before=latestVersionNo||0;
    await refreshVersions();
    if((latestVersionNo||0)>before && before && currentVersionNo<latestVersionNo && !verBusy)
      BPUI.toast('V'+latestVersionNo+' was just saved by a teammate — pick it from the version list to view it.',{type:'info'});
  }, force?0:150);
}
function watchVersions(){
  if(verSub){ try{ verSub.unsubscribe(); }catch{} verSub=null; }
  if(!currentQuoteId || !BPStore.quotes.subscribeVersions) return;
  verSub=BPStore.quotes.subscribeVersions(currentQuoteId, kind=>{ if(kind==='layout') refreshVersionsSoon(true); });
}
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') refreshVersionsSoon(false); });
window.addEventListener('pageshow',e=>{ if(e.persisted) refreshVersionsSoon(true); });
// a save just appended version v — reflect it without another round trip
function noteSavedVersion(v, label){
  const no = currentVersionNo;
  latestVersionNo = Math.max(latestVersionNo||0, no);
  if(!versionsList.some(x=>x.versionNo===no))
    versionsList.unshift({ versionNo:no, label:(v && v.label) || label || null, objectCount:store.items.length,
      createdAt:(v && (v.created_at||v.createdAt)) || new Date().toISOString(), createdBy:(v && (v.created_by||v.createdBy)) || myUserId || null });
  setVersionInUrl(no);
}
function setVersionInUrl(no){
  try{ const u=new URL(location.href);
    if(!no || no===latestVersionNo) u.searchParams.delete('v'); else u.searchParams.set('v', String(no));
    history.replaceState(history.state, '', u.pathname+u.search+u.hash); }catch{}
}
function renderVersionUI(){
  const sel=$('#verSel'), banner=$('#verBanner'); if(!sel) return;
  const show = !!currentQuoteId && versionsList.length>0;
  sel.hidden = !show;
  if(show){
    const list=versionsList.slice().sort((a,b)=>b.versionNo-a.versionNo);
    if(currentVersionNo && !list.some(v=>v.versionNo===currentVersionNo)) list.unshift({ versionNo:currentVersionNo });
    const labels=list.map(v=>v.versionNo+'|'+versionOptionLabel(v, latestVersionNo, versionNames, myUserId));
    const sig=labels.join('\n');
    if(sel.__sig!==sig){                     // unchanged list → leave the (possibly open) native picker alone
      sel.__sig=sig; sel.textContent='';
      labels.forEach(l=>{ const i=l.indexOf('|'), o=document.createElement('option'); o.value=l.slice(0,i);
        o.textContent=l.slice(i+1); sel.appendChild(o); });
    }
    sel.value=String(currentVersionNo||'');
    sel.disabled = verBusy;
  }
  const older = show && isViewingOlder();
  if(banner){
    banner.hidden = !older;
    if(older){
      $('#verBannerTxt').textContent='Viewing V'+currentVersionNo+' (older) — the latest is V'+latestVersionNo+'. Saving creates a new version; history is never overwritten.';
      const rb=$('#verRestoreBtn'); if(rb) rb.hidden=RO;
    }
  }
  const qb=$('#quoteBadge'); if(qb && !qb.hidden) qb.textContent=quoteBadgeText();
}
// Small static picture of a layout for the switch dialog — built with DOM nodes (no HTML strings).
function drawLayoutThumb(host, data){
  if(!host) return; host.textContent='';
  const wf=data && data.scale && data.scale.worldFt;
  const w=(wf && +wf.w>0) ? +wf.w : WORLD.w, h=(wf && +wf.h>0) ? +wf.h : WORLD.h;
  const items=(data && Array.isArray(data.items)) ? data.items : [];
  const s=el('svg',{ viewBox:`0 0 ${w} ${h}`, preserveAspectRatio:'xMidYMid meet', role:'img',
    'aria-label':items.length+' object'+(items.length===1?'':'s') });
  const floor=el('rect',{ x:0, y:0, width:w, height:h, 'stroke-width':Math.max(w,h)/150 });
  floor.style.fill='var(--panel)'; floor.style.stroke='var(--line)'; s.appendChild(floor);
  items.forEach(it=>{
    if(!it || typeof it!=='object') return;
    const x=+it.x, y=+it.y, iw=Math.max(.5,+it.width), ih=Math.max(.5,+it.height), r=+it.rotation||0;
    if(![x,y,iw,ih,r].every(Number.isFinite)) return;
    const c=String(it.color||'').trim();   // same rule as the canvas: custom colour, else the category colour
    const fill = (it.colorCustom && HEXRE.test(c)) ? c : CATS[it.category] ? catColor(it.category) : HEXRE.test(c) ? c : '#8a93a8';
    s.appendChild(el('rect',{ x, y, width:iw, height:ih, rx:Math.min(iw,ih)*.12, fill, 'fill-opacity':.8,
      transform:`rotate(${r} ${x+iw/2} ${y+ih/2})` }));
  });
  if(!items.length){ const t=el('text',{ x:w/2, y:h/2, 'text-anchor':'middle', 'dominant-baseline':'middle', 'font-size':Math.max(w,h)/14 });
    t.style.fill='var(--ink-3)'; t.textContent='Empty floor'; s.appendChild(t); }
  host.appendChild(s);
}
// "unsaved changes — what now?" → Promise<'save'|'discard'|'cancel'>. Esc / ✕ / backdrop = cancel.
function askVersionSwitch(o){ return new Promise(resolve=>{
  const m=$('#verModal'); if(!m){ resolve('cancel'); return; }
  $('#verModalDesc').textContent='You have unsaved changes'+(o.fromNo?' on V'+o.fromNo:'')+'. What should happen to them before V'+o.toNo+' opens? Saved versions are never overwritten.';
  $('#verCapCur').textContent='Your unsaved canvas';
  $('#verCapTgt').textContent='V'+o.toNo+' (saved)';
  drawLayoutThumb($('#verThumbCur'), o.current);
  drawLayoutThumb($('#verThumbTgt'), o.target);
  let done=false;
  const finish=v=>{ if(done) return; done=true; m.hidden=true;
    m.removeEventListener('click',onClick); m.removeEventListener('keydown',onKey); resolve(v); };
  const onClick=e=>{ if(e.target===m) return finish('cancel');
    const b=e.target.closest && e.target.closest('[data-choice],[data-close]'); if(b) finish(b.getAttribute('data-choice')||'cancel'); };
  const onKey=e=>{ if(e.key==='Escape'||e.key==='Esc'){ e.preventDefault(); finish('cancel'); } };
  m.addEventListener('click',onClick); m.addEventListener('keydown',onKey);
  m.hidden=false;
  const first=m.querySelector('[data-choice="save"]'); if(first){ first.hidden=RO; try{ first.focus(); }catch{} }
}); }
// The switch flow itself — pure, with every effect injected (test/builder-versions.test.mjs drives it with stubs).
function createVersionController(d){
  let busy=false;
  async function switchTo(no){
    no=parseInt(no,10);
    if(!(no>0) || busy || no===d.currentNo() || d.isDragging()){ d.sync(busy); return 'noop'; }
    busy=true; d.sync(true);
    try{
      let target;
      try{ target=await d.fetchVersion(no); }
      catch(e){ d.notify('Couldn’t open V'+no+' — it may no longer exist.'); return 'error'; }
      if(!(target && target.data && Array.isArray(target.data.items))){ d.notify('V'+no+' has unreadable data, so it can’t be opened.'); return 'error'; }
      const data=target.data;
      if(d.isDirty()){
        const choice=await d.ask({ fromNo:d.currentNo(), toNo:no, current:d.currentData(), target:data });
        if(choice==='save'){ if(!(await d.save())) return 'save-failed'; }
        else if(choice!=='discard') return 'cancel';
      }
      d.load(no, data);
      return 'switched';
    } finally { busy=false; d.sync(false); }
  }
  return { switchTo, isBusy:()=>busy };
}
function loadVersionIntoEditor(no, data){
  applyLayout(data);                       // resets undo history + makes this version the clean baseline
  currentVersionNo=no;
  setVersionInUrl(no);
  updateQuoteBadge();
  toast(no===latestVersionNo ? 'Back to the latest version (V'+no+')' : 'Viewing V'+no+' — saved versions stay unchanged');
}
const versionCtl = createVersionController({
  currentNo: ()=>currentVersionNo,
  isDirty: ()=>dirty.isDirty(),
  isDragging: ()=>isDragging(),
  currentData: ()=>serialize(),
  fetchVersion: no=>BPStore.quotes.getVersion(currentQuoteId, no),
  ask: askVersionSwitch,
  save: ()=>saveLayout(false),
  load: loadVersionIntoEditor,
  notify: msg=>BPUI.toast(msg,{type:'err'}),
  sync: b=>{ verBusy=!!b; renderVersionUI(); },
});
// after a switch / cancel the dropdown is re-enabled; hand focus back to it if the dialog or banner took it away
function switchVersion(no){
  return versionCtl.switchTo(no).then(r=>{ const s=$('#verSel'), a=document.activeElement;
    if(s && !s.hidden && (!a || a===document.body || a.disabled || a.closest('[hidden]'))) { try{ s.focus(); }catch{} }
    return r; });
}
$('#verSel').addEventListener('change',e=>{ switchVersion(e.target.value); });
['focus','mousedown','touchstart'].forEach(ev=>$('#verSel').addEventListener(ev,()=>refreshVersionsSoon(false),{passive:true}));
$('#verLatestBtn').addEventListener('click',()=>{ if(latestVersionNo) switchVersion(latestVersionNo); });
$('#verRestoreBtn').addEventListener('click',()=>{
  const from=currentVersionNo;
  BPUI.guard($('#verRestoreBtn'), ()=>saveLayout(false,{ label:'Restored from V'+from })).catch(()=>{});
});
// Build 1 — show the current design stage (if any) with a link to the Design Studio. Best-effort.
async function updateDesignChip(){
  const chip=$('#designChip'); if(!chip) return;
  if(!currentQuoteId || !(BPStore.design && BPStore.auth && BPStore.auth.enabled && BPStore.auth.enabled())){ chip.hidden=true; return; }
  try{
    const rec=await BPStore.design.get(currentQuoteId);
    if(!rec || rec.state===null){ chip.hidden=true; return; }
    chip.hidden=false;
    chip.textContent='🎨 '+(BPStore.design.LABEL[rec.state]||rec.state);
    chip.href='design.html?quote='+encodeURIComponent(currentQuoteId);
  }catch(e){ chip.hidden=true; }
}
/* debounced autosave — only once a layout already has an id (after first manual save/open) */
let autosaveT=null, saveBtnT=null;
function scheduleAutosave(){
  if(RO || !currentLayoutId) return;
  clearTimeout(autosaveT);
  autosaveT=setTimeout(()=>saveLayout(true), 2500);
}
// resilient wrappers — Supabase mode surfaces errors (RLS/network) as throws; degrade gracefully
async function listLayouts(){ try{ return await BPStore.list(); }catch(e){ toast('Could not load events'); return []; } }
async function getLayout(id){ try{ return await BPStore.get(id); }catch(e){ return null; } }
async function deleteLayout(id){ try{ await BPStore.remove(id); return true; }catch(e){ BPUI.toast(BPUI.friendlyError(e,{action:'delete the layout'}),{type:'err'}); return false; } }

async function openLoadModal(){
  $('#loadModal').hidden=false;
  const host=$('#loadList');
  host.innerHTML='<div class="empty pad26">Loading…</div>';
  const list = await listLayouts();
  if(!list.length){ host.innerHTML='<div class="empty pad30"><p>No saved layouts yet.<br>Build a floor and hit <b>Save</b>.</p></div>'; return; }
  list.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
  host.innerHTML = list.map(l=>`
    <div class="lrow" data-id="${esc(l.id)}">
      <div class="li"><b>${escapeHtml(l.name)}</b>
        <small>${esc(l.objectCount)} objects · ${l.updatedAt?new Date(l.updatedAt).toLocaleString():'—'}</small></div>
      <div class="la">
        <button type="button" data-act="open" aria-label="Open ${escapeHtml(l.name)}">Open</button>
        <button type="button" class="del" data-act="del" aria-label="Delete ${escapeHtml(l.name)}">Delete</button>
      </div>
    </div>`).join('');
  host.querySelectorAll('.lrow').forEach(row=>{
    const id=row.dataset.id;
    const openB=row.querySelector('[data-act="open"]'), delB=row.querySelector('[data-act="del"]');
    openB.addEventListener('click',()=>BPUI.guard(openB, async()=>{
      if(!(await BPUI.confirmDiscard(dirty,{message:'You have unsaved changes on this floor. Opening another layout will discard them.'}))) return;
      const full=await getLayout(id);
      if(!full){ BPUI.toast('Couldn’t open that layout — it may have been deleted.',{type:'err'}); return; }
      applyLayout(full.data); currentLayoutId=id;
      $('#projName').value=full.name; setSavedBaseline(); closeLoadModal(); toast('Opened “'+full.name+'”');
    }).catch(()=>{}));
    delB.addEventListener('click',()=>BPUI.guard(delB, async()=>{
      const nm=row.querySelector('b').textContent;
      if(!(await BPUI.confirm('Delete “'+nm+'”? This can’t be undone.',{title:'Delete layout?',danger:true}))) return;
      if(!await deleteLayout(id)) return;
      if(currentLayoutId===id){ currentLayoutId=null; savedSig=null; if(store.items.length) markDirty(); }
      BPUI.toast('Deleted “'+nm+'”',{type:'ok'});
      openLoadModal();
    }).catch(()=>{}));
  });
}
function closeLoadModal(){ $('#loadModal').hidden=true; }

/* ---- export : JSON + PNG ---- */
function download(name, blob){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function exportJSON(){
  const name = ($('#projName').value||'layout').trim().replace(/[^\w.-]+/g,'_');
  download(name+'.json', new Blob([JSON.stringify(serialize(),null,2)],{type:'application/json'}));
  toast('JSON downloaded');
}
/* clone the live SVG, resolve every CSS-variable / color-mix paint to a concrete
   value from getComputedStyle so the standalone raster matches the screen. */
/* render the plan SVG to a PNG blob. o.clean (client images): no grid, margins, measurements or
   selection — only the hall and its objects; o.maxW caps the raster width. State is restored. */
function planBlob(o){ o=o||{}; return new Promise(resolve=>{
  const wasSel=store.selectedIds.slice(), wasGrid=store.grid.show, wasMeasure=showMeasure;
  setSelection([]); if(o.clean){ store.grid.show=false; showMeasure=false; } renderAll();  // hide handles
  const live=svg, clone=live.cloneNode(true);
  const liveNodes=live.querySelectorAll('*'), cloneNodes=clone.querySelectorAll('*');
  for(let i=0;i<liveNodes.length;i++){
    const cs=getComputedStyle(liveNodes[i]), cn=cloneNodes[i];
    ['fill','stroke'].forEach(p=>{ const v=cs.getPropertyValue(p); if(v&&v!=='none') cn.setAttribute(p,v); });
    const sw=cs.getPropertyValue('stroke-width'); if(sw) cn.setAttribute('stroke-width',sw);
    const da=cs.getPropertyValue('stroke-dasharray'); if(da&&da!=='none') cn.setAttribute('stroke-dasharray',da);
    if(cn.tagName==='text'){ cn.setAttribute('font-family',cs.fontFamily);
      cn.setAttribute('font-size',cs.fontSize); cn.setAttribute('font-weight',cs.fontWeight);
      cn.removeAttribute('stroke'); }
  }
  if(o.clean) clone.querySelectorAll('.margins,.measure').forEach(n=>n.remove());
  const CF=o.clean && window.HelmCaptureFrame;              // R5: client plan = numbered badges + legend (same numbers as 3D)
  const LM=CF ? CF.labelMode(o.labels) : 'numbers';         // 0083: o.labels 'none' | 'numbers' (default) | 'names'
  if(CF) clone.querySelectorAll('text.lbl').forEach(n=>n.remove());
  const restore=()=>{ store.grid.show=wasGrid; showMeasure=wasMeasure; setSelection(wasSel); renderAll(); };
  const W=WORLD.w*PX_PER_FT, H=WORLD.h*PX_PER_FT, S=o.maxW ? Math.min(4, o.maxW/W, 4096/H) : 2;   // R9: cap the tall side at 4096 px (iOS Safari canvas limits)
  clone.setAttribute('width',W*S); clone.setAttribute('height',H*S);
  clone.insertBefore(el('rect',{x:0,y:0,width:W,height:H,
    fill:(getComputedStyle(document.body).getPropertyValue('--canvas').trim()||'#fff')}), clone.firstChild);
  // strip XML-illegal control chars (e.g. from an imported label) — they make the SVG image fail to decode
  const svgStr=new XMLSerializer().serializeToString(clone).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
  const img=new Image();
  img.onload=()=>{
    const pw=Math.round(W*S), ph=Math.round(H*S), panel=CF && LM==='numbers' ? Math.round(pw*0.25) : 0;
    const cv=document.createElement('canvas'); cv.width=pw+panel; cv.height=ph;
    const ctx=cv.getContext('2d');
    ctx.fillStyle=(getComputedStyle(document.body).getPropertyValue('--canvas').trim()||'#fff');
    ctx.fillRect(0,0,cv.width,cv.height); ctx.drawImage(img,0,0,pw,ph);
    if(CF && LM==='names'){ const tags=store.items.filter(it=>['seatblock','chairrow'].indexOf(it.type)===-1)
        .map(it=>({text:it.label, x:(it.x+it.width/2)*PX_PER_FT*S, y:(it.y+it.height/2)*PX_PER_FT*S}));
      CF.drawNameTags(ctx, tags, Math.max(10,Math.round(ph*0.016)), {w:pw, h:ph}); }
    if(CF && LM==='numbers'){ const num=CF.numberItems(store.items), br=Math.max(6,Math.round(ph*0.011));
      const anchors=store.items.filter(it=>num.byId.has(it.id)).map(it=>({n:num.byId.get(it.id), x:(it.x+it.width/2)*PX_PER_FT*S, y:(it.y+it.height/2)*PX_PER_FT*S}));
      CF.drawBadges(ctx, CF.layoutBadges(anchors, br, {w:pw, h:ph}), br);
      CF.drawLegend(ctx, num.legend, pw, 0, panel, ph); }
    restore(); cv.toBlob(b=>resolve(b||null),'image/png');
  };
  img.onerror=()=>{ restore(); resolve(null); };
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svgStr);
}); }
async function exportPNG(){
  const b=await planBlob();
  if(!b){ BPUI.toast('PNG export failed',{type:'err'}); return; }
  const name=($('#projName').value||'layout').trim().replace(/[^\w.-]+/g,'_');
  download(name+'.png', b); toast('PNG downloaded');
}

/* ---- R2 + 0083: client booklet images (real 2D plan + 3D render) ----
   Each picture in two styles: 'labels' (numbered badges + legend, the approved look) and
   'plain' (the model without labels). Stored IN THE DATABASE via BPStore.booklet.putImage
   (JPEG ~0.85, <= 1600 px wide); the booklet link shows the newest ones. */
function clientImagesSupported(){ return !!(currentQuoteId && !RO && BPStore.mode && BPStore.mode()==='supabase' && BPStore.booklet && BPStore.booklet.putImage); }
let clientImgBusy=null, captureProgressHook=null, lastCaptureResults=null;
// R8b: capture.html (generated from builder.html, the ONLY framable page — frame-ancestors 'self')
// runs this builder headless inside a hidden same-origin iframe from the share checklist.
const CAPTURE_HOST = !!document.querySelector('meta[name="helm-capture"]') && window.parent!==window;
function captureHostMessage(quoteId, m){ return Object.assign({ quoteId:String(quoteId||'') }, m); }
async function runCaptureHost(){
  const qid=currentQuoteId || new URLSearchParams(location.search).get('quote') || '';
  // targetOrigin = our own origin: only a same-origin parent (the share card) can ever receive this
  const post=m=>{ try{ window.parent.postMessage(captureHostMessage(qid, m), location.origin); }catch(e){} };
  if(!currentQuoteId){ post({type:'helm-capture-done', ok:false, error:'That event could not be opened'}); return; }
  if(!store.items.length){ post({type:'helm-capture-done', ok:true, empty:true, results:{}}); return; }
  // R9: R4-E — never write pictures for a closed / cancelled / archived event
  if(currentQuoteGuard && currentQuoteGuard.frozen){ post({type:'helm-capture-done', ok:false, code:'frozen', error:'This event is closed, so its pictures can’t be updated'}); return; }
  if(!clientImagesSupported()){ post({type:'helm-capture-done', ok:false, code:'readonly', error:'You can’t update the pictures for this event'}); return; }
  captureProgressHook=step=>post({type:'helm-capture-progress', step});
  let ok=false; try{ ok=await captureClientImages(true); }catch(e){ ok=false; }
  post({type:'helm-capture-done', ok:!!ok, results:lastCaptureResults||{}, error: ok ? null : 'The pictures could not be saved'});
}   // R8: the in-flight capture promise (a second click / auto-capture waits for it)
// capture style -> label mode used by planBlob / capture3D
const CLIENT_IMG_STYLES=[['labels','numbers'],['plain','none']];
function captureClientImages(silent){
  if(!clientImagesSupported() || !store.items.length) return Promise.resolve(false);
  if(clientImgBusy) return clientImgBusy;
  clientImgBusy=captureClientImagesRun(silent).finally(()=>{ clientImgBusy=null; });
  return clientImgBusy;
}
async function captureClientImagesRun(silent){
  // R4-E: pin the quote / version / layout the capture started on — if any changes while the
  // (slow) renders run, the pictures no longer match that quote's saved layout: never upload them.
  const qid=currentQuoteId, vno=currentVersionNo, sig=docSig();
  const moved=()=> currentQuoteId!==qid || currentVersionNo!==vno || docSig()!==sig;
  const say=(m,o)=>{ if(!silent) toast(m,o); };
  const why=e=>String((e && e.message) || e || 'failed').slice(0,120);
  const res={}, p2={}, p3={};   // R8: per-picture result: true | reason
  try{
    say('Capturing 2D…');
    for(const [v,m] of CLIENT_IMG_STYLES){
      try{ const b=await planBlob({clean:true, maxW:1600, labels:m}); if(b) p2[v]=b; else res['2d_'+v]='couldn’t draw the floor plan'; }
      catch(e){ res['2d_'+v]=why(e); }
    }
    try{ if(captureProgressHook) captureProgressHook('2d'); }catch(e){}
    say('Capturing 3D…');
    for(const [v,m] of CLIENT_IMG_STYLES){
      // R8: capture3D initialises the 3D scene offscreen when the 3D view was never opened; one retry
      for(let a=0;a<2 && !p3[v];a++){
        try{ if(!window.__capture3D) throw new Error('3D view not loaded'); const b=await window.__capture3D(1600,{labels:m}); if(b) p3[v]=b; else res['3d_'+v]='3D render was empty'; }
        catch(e){ res['3d_'+v]=why(e); }
      }
      if(moved()) break;
    }
    if(moved()){ if(!silent) BPUI.toast('The layout changed while capturing — press “Update client images” again.',{type:'err'}); return false; }
    try{ if(captureProgressHook) captureProgressHook('3d'); }catch(e){}
    say('Uploading client images…');
    for(const [v] of CLIENT_IMG_STYLES) for(const [k,pics] of [['2d',p2],['3d',p3]]){
      if(!pics[v]) continue;
      if(moved()){ res[k+'_'+v]='layout changed'; continue; }
      try{ await BPStore.booklet.putImage(qid,k,v,pics[v]); res[k+'_'+v]=true; }
      catch(e){ res[k+'_'+v]=(BPUI.friendlyError ? BPUI.friendlyError(e,{action:'save the picture'}) : why(e)); }
    }
    lastCaptureResults=res;
    const sum=window.HelmCaptureFrame && HelmCaptureFrame.captureSummary ? HelmCaptureFrame.captureSummary(res) : {ok:false, saved:[], message:'Client images updated'};
    if(!silent) BPUI.toast(sum.message,{type:sum.ok?'ok':'err'});
    else if(!sum.ok) console.warn('client image capture:', sum.message);
    return sum.saved.length>0;
  }catch(e){ if(!silent) BPUI.toast(BPUI.friendlyError(e,{action:'update the client images'}),{type:'err'}); return false; }
}
// after a save (or on open): recapture when a booklet link is live and its images are missing / older than the latest version
async function autoCaptureIfStale(){
  if(!clientImagesSupported() || !store.items.length || isViewingOlder() || docSig()!==savedSig) return;   // only the saved latest version
  if(currentQuoteGuard.frozen) return;   // R4-E: no background writes for closed / cancelled / archived events
  const qid=currentQuoteId;
  try{
    const cur=await BPStore.booklet.current(qid);
    if(!cur || !cur.token || cur.revoked_at) return;
    const info=await BPStore.booklet.imageInfo(qid)||{};
    const vs=await BPStore.quotes.versions(qid)||[];
    const latest=vs.reduce((m,v)=>{ const t=Date.parse(v.createdAt||v.created_at||''); return isFinite(t)&&t>m?t:m; },0);
    const old=(k,v)=>{ const t=info[k] && info[k][v]; return !t || !(Date.parse(t)>=latest); };
    // R4-E: the checks above were async — re-verify we are still on that quote's saved latest version
    if(currentQuoteId!==qid || isViewingOlder() || docSig()!==savedSig) return;
    if(['2d','3d'].some(k=>old(k,'labels') || old(k,'plain'))) await captureClientImages(true);
  }catch(e){ /* best effort */ }
}
function importJSON(file){ return new Promise(resolve=>{
  const bad=()=>{ BPUI.toast('That file isn’t a valid layout JSON.',{type:'err'}); resolve(false); };
  if(file && file.size>MAX_IMPORT_BYTES){ BPUI.toast('That file is too large to import (limit '+Math.round(MAX_IMPORT_BYTES/1048576)+' MB).',{type:'err'}); resolve(false); return; }
  const fr=new FileReader();
  fr.onload=()=>{ try{ const d=JSON.parse(fr.result);
    const src=d&&typeof d==='object'?(Array.isArray(d.items)?d:(d.data||d)):null;
    if(!src || typeof src!=='object' || !Array.isArray(src.items)){ bad(); return; }
    applyLayout(src); currentLayoutId=null;
    if(!currentQuoteId) $('#projName').value=(file.name||'Imported').replace(/\.json$/i,'').slice(0,120);   // an open quote keeps its own title
    toast('Imported');
    savedSig=null; markDirty();                    // an import is unsaved until the user saves it
    resolve(true); }
    catch{ bad(); } };
  fr.onerror=bad;
  fr.readAsText(file);
}); }

/* ---- theme toggle ---- */
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';
  const next=cur==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',next);
  try{ localStorage.setItem('bps.theme',next); }catch{}
  // category colors are CSS-var driven; re-resolve them on theme change, but leave custom colours alone
  store.items.forEach(it=>{ if(it.category&&CATS[it.category]&&!it.colorCustom) it.color=catColor(it.category); });
  buildToolbox(); renderAll();
}

/* ---- wire project action buttons ---- */
$('#saveBtn').addEventListener('click',()=>guardedSave());
// Opened from the quote flow (?from=flow): "Save & back to quote" saves a new layout version,
// writes the re-priced total now (not debounced), then returns to the same quote's quotation step.
// Browser Back keeps the normal unsaved-changes guard (BPUI tracker / beforeunload).
async function saveAndBackToFlow(){
  if(!currentQuoteId) return;
  // unchanged layout → no phantom version; just go back (the flow still re-checks the price)
  const ok = (RO || !dirty.isDirty()) ? true : await saveLayout(false);
  if(!ok) return;                               // save refused/failed: stay, the error is already shown
  if(!RO) await syncQuotePricingNow();          // the flow page re-checks and saves the quotation too
  location.href = HelmFlowLayout.returnUrl(currentQuoteId);
}
(function(){ const b=$('#backToFlowBtn'); if(!b) return;
  b.addEventListener('click',()=>{ BPUI.guard(b, saveAndBackToFlow, {busyLabel:'Saving…'}).catch(()=>{}); }); })();
$('#loadBtn').addEventListener('click',openLoadModal);
$('#loadClose').addEventListener('click',closeLoadModal);
/* ---- toolbox hint (dismissible) + shortcuts dialog ---- */
(function wireHint(){
  const KEY='bps.toolHintHidden', hint=$('#toolHint'), re=$('#shortcutsBtn2');
  let hidden=false; try{ hidden=localStorage.getItem(KEY)==='1'; }catch{}
  const apply=()=>{ if(hint) hint.hidden=hidden; if(re) re.hidden=!hidden; };
  apply();
  $('#hintClose')?.addEventListener('click',()=>{ hidden=true; try{ localStorage.setItem(KEY,'1'); }catch{} apply(); re?.focus(); });
  const modal=$('#shortcutsModal'); let opener=null;
  const open=e=>{ opener=e && e.currentTarget; modal.hidden=false; $('#scClose').focus(); };
  const close=()=>{ modal.hidden=true; if(opener && opener.focus) opener.focus(); };
  $('#shortcutsBtn')?.addEventListener('click',open);
  re?.addEventListener('click',open);
  $('#scClose').addEventListener('click',close);
  modal.addEventListener('click',e=>{ if(e.target===modal) close(); });
  modal.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
  window.__openShortcuts=open;
})();
/* header dropdown menus (<details>): close on outside click / Escape / after picking an item */
document.querySelectorAll('header details.hmenu').forEach(d=>{
  d.querySelectorAll('.hmenu-pop .tbtn').forEach(b=>b.addEventListener('click',()=>{ d.open=false; }));
});
document.addEventListener('click',e=>{ document.querySelectorAll('header details.hmenu[open]').forEach(d=>{ if(!d.contains(e.target)) d.open=false; }); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') document.querySelectorAll('header details.hmenu[open]').forEach(d=>{ d.open=false; d.querySelector('summary')?.focus(); }); });
$('#loadModal').addEventListener('click',e=>{ if(e.target.id==='loadModal') closeLoadModal(); });
$('#exportBtn').addEventListener('click',()=>{ BPUI.guard($('#exportBtn'), exportPNG,{busyLabel:'Exporting…'}).catch(()=>{}); });
$('#clientImgBtn').addEventListener('click',()=>{ BPUI.guard($('#clientImgBtn'), ()=>captureClientImages(false),{busyLabel:'Capturing…'}).catch(()=>{}); });
$('#jsonBtn').addEventListener('click',()=>{ BPUI.guard($('#jsonBtn'), async()=>exportJSON()).catch(()=>{}); });
$('#importBtn').addEventListener('click',async()=>{
  if(!(await BPUI.confirmDiscard(dirty,{message:'You have unsaved changes on this floor. Importing a file will replace them.'}))) return;
  $('#importFile').click();
});
$('#importFile').addEventListener('change',e=>{ const f=e.target.files[0]; e.target.value='';
  if(f) BPUI.guard($('#importBtn'), ()=>importJSON(f),{busyLabel:'Importing…'}).catch(()=>{}); });
$('#themeBtn').addEventListener('click',toggleTheme);
$('#projName').addEventListener('keydown',e=>{ if(e.key==='Enter') e.target.blur(); });
$('#projName').addEventListener('input',()=>markDirty());
$('#capInput').addEventListener('input',e=>{ const v=parseInt(e.target.value,10); store.venue.capacity = (isFinite(v)&&v>0)?Math.min(v,MAX_CAPACITY):null; if(store.venue.capacity!==v && isFinite(v) && v>0) e.target.value=store.venue.capacity; updateCapacityUI(); markDirty(); });
$('#capInput').addEventListener('change',()=>{ if(currentLayoutId) scheduleAutosave(); });
$('#customBtn').addEventListener('click',openCustomModal);
$('#customClose').addEventListener('click',closeCustomModal);
$('#customModal').addEventListener('click',e=>{ if(e.target.id==='customModal') closeCustomModal(); });
$('#c_generate').addEventListener('click',runCustomGenerate);
$('#arrClose').addEventListener('click',closeArrangeModal);
$('#arrangeModal').addEventListener('click',e=>{ if(e.target.id==='arrangeModal') closeArrangeModal(); });
$('#arrCount').addEventListener('input',renderArrOptions);
$('#arrSeats').addEventListener('input',renderArrOptions);
$('#arrShape').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
  $('#arrShape').querySelectorAll('button').forEach(x=>{ x.classList.remove('on'); x.setAttribute('aria-pressed','false'); }); b.classList.add('on'); b.setAttribute('aria-pressed','true'); renderArrOptions(); }));

/* ===================================================================
   BOOT
   =================================================================== */
let draftToRestore=null;
async function init(){
  buildToolbox();
  $('#cornerUnit').textContent=uLabel();
  const params=new URLSearchParams(location.search);
  const evId=params.get('id'), evName=params.get('event'), isNew=params.get('new')==='1';
  const quoteId=await HelmUrl.get('quote', params.get('quote')), openVer=params.get('v');
  store.items = (isNew||quoteId) ? [] : TEMPLATES.political();   // blank for a new event/quote, else a working default
  if(quoteId || evId) setLayoutLoading(true);         // neutral loading state until the saved layout arrives
  if(evName){ const pn=$('#projName'); if(pn) pn.value=evName; }
  resetHistory();                                     // establish the initial undo baseline
  renderAll();
  fitView();
  window.addEventListener('resize',()=>{ renderRulers(); });
  await initStore();
  initPanelToggles();   // after initStore so the saved state is per signed-in user
  // load pricing rates from the Control Centre (fallbacks stay if unavailable)
  try{
    const pc = await BPStore.config.getPricing();
    if(pc){
      if(pc.chairPrice!=null) PRICING.chairPrice=+pc.chairPrice;
      if(pc.platePrice!=null) PRICING.platePrice=+pc.platePrice;
      if(pc.gstPct!=null)     PRICING.gstPct=+pc.gstPct;
      // 0079: studio tax country / inclusive prices (labels + the inclusive money rule)
      ['taxCountry','taxName','currency'].forEach(k=>{ if(pc[k]!=null) PRICING[k]=pc[k]; });
      if(String(pc.taxInclusive).toLowerCase()==='true') PRICING.taxInclusive=true;
      if(pc.layoutBase!=null) PRICING.layoutBase=+pc.layoutBase;
      if(pc.serviceChargePct!=null) PRICING.serviceChargePct=+pc.serviceChargePct;
      if(pc.assetPrices)      PRICING.assetPrices=pc.assetPrices;
      CAPS = { guests:+pc.maxGuests||CAPS.guests, chairs:+pc.maxChairs||CAPS.chairs, plates:+pc.maxPlates||CAPS.plates,
        tables:+pc.maxRoundTables||CAPS.tables, bars:(pc.maxBars!=null?+pc.maxBars:CAPS.bars), trucks:(pc.maxFoodTrucks!=null?+pc.maxFoodTrucks:CAPS.trucks),
        booths:(pc.maxExpoBooths!=null?+pc.maxExpoBooths:CAPS.booths), rest:(pc.maxRestrooms!=null?+pc.maxRestrooms:CAPS.rest),
        exits:(pc.maxExits!=null?+pc.maxExits:CAPS.exits), hall:+pc.maxHallFt||CAPS.hall };
    }
  }catch{}
  try{ applyCapHints(); }catch(e){}
  try{ PRICING.packages = await BPStore.menuTemplates.list(); }catch{ PRICING.packages=[]; }
  buildMenuControls();
  renderPrice();
  // Auth gate: if Supabase enforces login and nobody's signed in → go to the sign-in page
  if(BPStore.auth.enabled() && BPStore.auth.required() && !BPStore.auth.user()){
    // R9: the capture host must answer (not navigate the hidden iframe to /login and hang 60s)
    if(CAPTURE_HOST){ try{ window.parent.postMessage({type:'helm-capture-done', quoteId:String(params.get('quote')||''), ok:false, code:'signin', error:'Please sign in again'}, location.origin); }catch(e){} return; }
    location.replace('/login?next='+encodeURIComponent('builder'+location.search)); return;
  }
  // Role gate: view-only roles (crew/client) get a read-only builder; capture create capability
  if(BPStore.auth.enabled() && BPStore.auth.user()){
    const editable = await BPStore.auth.can('edit');
    CAN_CREATE = await BPStore.auth.can('create');
    if(!editable) applyReadonly(await BPStore.auth.role());
  }
  await renderAccountChip();
  if(quoteId){
    try{
      const q=await BPStore.quotes.get(quoteId);
      currentQuoteId=q.id; currentQuoteCode=q.code; currentClient=q.client||{}; currentPricing=q.pricing||{};
      { const bb=$('#backToFlowBtn'); if(bb && params.get('from')==='flow') bb.hidden=false; }
      currentQuoteGuard = { approved: q.status==='confirmed' || (q.approvalStatus && q.approvalStatus!=='none'), closed: q.lifecycleStage==='closed', frozen: q.lifecycleStage==='closed' || q.status==='cancelled' || !!q.archivedAt || !!q.deletedAt };
      const pn=$('#projName'); if(pn) pn.value=q.title||q.code;
      try{ if(window.HelmTrail) HelmTrail.setCurrent({title:[q.code,q.title].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' '),kind:'builder',href:'builder.html?quote='+encodeURIComponent(q.id),recordHref:'event.html?id='+encodeURIComponent(q.id)}); }catch(e){}
      const verNo = (openVer && /^\d{1,6}$/.test(String(openVer)) && +openVer>0) ? parseInt(openVer,10) : q.currentVersion;   // ignore junk like v=abc
      const ver = await BPStore.quotes.getVersion(q.id, verNo);
      currentVersionNo = ver.versionNo;
      PRICING.eventType = q.eventType || null;
      // pull the event's guest count + applied menu package so the price is synced
      if(q.client && q.client.guests!=null) PRICING.guests = +q.client.guests;
      else if(currentPricing.guests!=null) PRICING.guests = +currentPricing.guests;   // set in the Confirm modal
      try{
        const plan = await BPStore.plan.get(q.id);
        if(plan){
          if(plan.menu_plate_price!=null) PRICING.menuPlatePrice = +plan.menu_plate_price;
          if(plan.menu_template) PRICING.menuPackageName = plan.menu_template;
          const match=(PRICING.packages||[]).find(p=>p.name===plan.menu_template);
          if(match) PRICING.appliedPkgId = match.id;
        }
      }catch{}
      buildMenuControls();
      // unreadable version data must lock the builder (catch below), never be shown as an empty floor to save over
      if(!ver || !ver.data || !Array.isArray(ver.data.items)) throw new Error('version data unreadable');
      draftToRestore = readDraft(q.id);
      applyLayout(ver.data);                  // also restores hall size / margins / capacity of an empty version
      if(!ver.data.items.length && ver.versionNo===1 && +q.currentVersion===1){
        // Brand-new (never-edited) quote → drop in the default layout for this event type so the
        // client immediately sees the standard package (chairs, mandap, stage…). Only ever for v1.
        const presetKey = EVENT_TYPE_PRESET[(q.eventType||'').toLowerCase()];
        if(presetKey && TEMPLATES[presetKey] && !CAPTURE_HOST){
          store.items = TEMPLATES[presetKey]();
          { const N=arrivalSeats(); if(N>0) exactSeats(store.items, N); }   // R8b/R10: exactly the quote's (or flow's) seats
          _autoDefaultLoaded=true;
          toast('Loaded default '+(q.eventType||'')+' layout');
          resetHistory(); setSavedBaseline(); renderAll();
        }
      }
      versionsList = q.versions || [];
      latestVersionNo = Math.max(+q.currentVersion||0, ...versionsList.map(v=>+v.versionNo||0)) || currentVersionNo;
      updateQuoteBadge();
      refreshVersions();                     // adds who-saved names; non-blocking
      watchVersions();                       // live: versions saved on another device / tab
      if(q.status==='confirmed'){ const b=$('#quoteBadge'); if(b) b.classList.add('confirmed'); }
      toast('Opened '+q.code+' · v'+currentVersionNo);
      if(!CAPTURE_HOST){ await offerDraftRestore();
        setTimeout(()=>{ autoCaptureIfStale(); }, 2500); }   // R2: refresh stale client booklet images
    }catch(e){
      // The quote didn't fully load: unbind it and lock the builder so a Save can never write an
      // empty layout over a real quote (which would also zero its pricing).
      currentQuoteId=null; currentQuoteCode=null; currentVersionNo=null; currentClient={}; currentPricing={};
      try{ applyReadonly('viewer','🔒 Editing is locked — that quote or version could not be opened. Reload the page to try again; nothing was changed.'); }catch{}
      toast('Could not open that quote — editing is locked so nothing gets overwritten');
    }
  } else if(evId){
    try{ const full=await getLayout(evId);
      if(full){ applyLayout(full.data); currentLayoutId=full.id;
        const pn=$('#projName'); if(pn) pn.value=full.name; setSavedBaseline(); toast('Opened “'+full.name+'”'); } }
    catch{ toast('Could not open that event'); }
  }
  if(layoutLoading) setLayoutLoading(false); if(CAPTURE_HOST){ runCaptureHost(); return; }   // blank-floor prompt only if the loaded layout truly has no items; R8b: headless picture capture
  populateRefEvents();   // fill the "Past events" reference picker
  // Guided default-layout generation from the flow: ?gen=1&type=&guests=&len=&wid=
  if(params.get('gen')==='1' && CAN_CREATE!==false){
    // R10: the default layout auto-built on arrival carries EXACTLY the flow's seats (all seating counted)
    if(_autoDefaultLoaded){ const N=arrivalSeats(); if(N>0 && sumSeats(store.items)!==N){ exactSeats(store.items, N); resetHistory(); setSavedBaseline(); renderAll(); } }
    // R10: one event-type map for the flow arrival and the dialog prefill (Reception stays Reception)
    const rawType=(params.get('type')||'').toLowerCase().trim();   // R10 hotfix: declared here (it went missing in R10)
    const ct=CE_TYPE[rawType]||'wedding';
    const setV=(id,v)=>{ const el=$('#'+id); if(el&&v!=null&&v!=='') el.value=v; };
    const setChk=(id,v)=>{ const el=$('#'+id); if(el) el.checked=!!v; };
    const sel=$('#c_type'); if(sel && [...sel.options].some(o=>o.value===ct)) sel.value=ct;
    const guests=+params.get('guests')||0;
    setV('c_guests', params.get('guests')); setV('c_len', params.get('len')); setV('c_wid', params.get('wid'));
    if(params.get('chairs')){ setV('c_chairs', params.get('chairs')); }   // R8: the quote's chairs (70% default or hand-set) drive the generator
    if(guests && PRICING.guests==null){ PRICING.guests=guests; const g=$('#bGuests'); if(g) g.value=guests; }   // R9: a saved guest count beats the URL
    // apply the admin-configured layout rule for this event type (seats/guest, buffet, bars, components)
    try{
      const rule = await BPStore.layoutRules.get(rawType) || await BPStore.layoutRules.get(ct);
      if(rule){
        if(rule.seatsPerGuest!=null && guests && !params.get('chairs')) setV('c_chairs', Math.round(guests*(+rule.seatsPerGuest)));
        if(rule.bars!=null) setV('c_bars', rule.bars);
        if(rule.buffetPer!=null && guests) setChk('c_buffet', guests>=(+rule.buffetPer));
        if(rule.stage!=null) setChk('c_stage', rule.stage);
        if(rule.dancefloor!=null) setChk('c_dance', rule.dancefloor);
        toast('Applied "'+(rawType||ct)+'" default rules');
      }
    }catch(e){}
    openCustomModal();
    try{ runCustomGenerate(); }catch(e){}
    toast('Pick a generated layout to start — then tweak it freely');
  }
}
/* ===================================================================
   MOBILE DRAWERS (≤720px) — the toolbox and inspector overlay the canvas.
   Toggled from the toolbar; close on Escape, on an outside tap, or after
   dropping an asset. On wider screens they are ordinary side panels.
   =================================================================== */
const DRAWER_MQ = window.matchMedia('(max-width:720px)');
const DRAWERS = [ { btn:'#toolsToggle', panel:'#leftPanel' }, { btn:'#inspToggle', panel:'#rightPanel' } ];
function drawersOpen(){ return DRAWER_MQ.matches && DRAWERS.some(d=>$(d.panel).classList.contains('open')); }
function setDrawer(d, open, focusBack){
  const p=$(d.panel), b=$(d.btn); if(!p||!b) return;
  const was=p.classList.contains('open');
  p.classList.toggle('open', !!open); b.setAttribute('aria-expanded', String(!!open));
  if(open && !was){ const f=p.querySelector('.tool,button,input,select,[tabindex="0"]'); if(f) setTimeout(()=>{ try{ f.focus({preventScroll:true}); }catch(_){} },0); }
  if(!open && was && focusBack && p.contains(document.activeElement)) b.focus();
}
function closeDrawers(focusBack){ if(!DRAWER_MQ.matches) return; DRAWERS.forEach(d=>setDrawer(d,false,focusBack)); }
DRAWERS.forEach((d,i)=>{
  $(d.btn).addEventListener('click',()=>{
    const open=!$(d.panel).classList.contains('open');
    setDrawer(DRAWERS[1-i], false);                 // one drawer at a time
    setDrawer(d, open);
  });
});
// outside tap closes an open drawer (taps inside a drawer, on its toggle, or in a dialog don't)
document.addEventListener('pointerdown',e=>{
  if(!drawersOpen()) return;
  const t=e.target;
  if(t.closest('#leftPanel,#rightPanel,.drawer-btns,.modal,.bpui-overlay,[data-bpui]')) return;
  closeDrawers(false);
},true);
// leaving the mobile layout resets the drawers to plain side panels
const onDrawerMq=()=>{ if(!DRAWER_MQ.matches) DRAWERS.forEach(d=>setDrawer(d,false)); fitView(); };
if(DRAWER_MQ.addEventListener) DRAWER_MQ.addEventListener('change',onDrawerMq); else if(DRAWER_MQ.addListener) DRAWER_MQ.addListener(onDrawerMq);

BPUI.boot(init);
