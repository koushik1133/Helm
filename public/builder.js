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
// Capacity ceilings, loaded from Settings (config.getPricing). Defaults keep the
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

// r21 political layout: 10% lets FIT show a whole open ground (350 x 550 ft rally) on one screen; was 25%
const ZOOM_MIN=0.1;

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
  chiavari:   { label:'Chair (single)',category:'seating',   w:1.6,h:1.6},
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
  generator:  { label:'Generator',     category:'logistics', w:10, h:4  },
  distro:     { label:'Power Distro',  category:'logistics', w:3,  h:2  },
  cableramp:  { label:'Cable Ramp',    category:'logistics', w:6,  h:1  },
  greenroom:  { label:'Green Room',    category:'logistics', w:16, h:12 },
  viprisers:  { label:'VIP Riser',     category:'structure', w:16, h:10 },
  stagebarrier:{label:'Stage Barrier', category:'security',  w:30, h:1.5},
  /* ---- event-production pack (V3): keys match the rate-card / Adjust-popup types ----
     real-world footprints in ft: LED wall 16×9 ft screen (1.5 ft deep), 24 ft lighting truss span,
     125 kVA silent genset ≈ 10×4 ft container, 6 ft ramp, 20 ft branding wall, 3-tier fountain 4×4. */
  lighting:   { label:'Lighting Truss',     category:'av',        w:24, h:1.5 },
  led:        { label:'LED Wall',           category:'av',        w:16, h:1.5 },
  chocolatefountain:{ label:'Chocolate Fountain', category:'logistics', w:4, h:4 },
  chariot:    { label:'Wedding Chariot',    category:'decor',     w:12, h:6  },
  smoke:      { label:'Smoke Machine',      category:'av',        w:2,  h:2  },
  dancers:    { label:'Dancers',            category:'av',        w:12, h:8  },
  walkway:    { label:'Walkway / Ramp',     category:'structure', w:6,  h:24 },
  brandwall:  { label:'Branding Wall',      category:'decor',     w:20, h:1.5},
  /* ---- Indian wedding + corporate pack (2026-10): real-world footprints in ft ---- */
  entrancegate:{ label:'Entrance Gate',     category:'structure', w:16, h:4  },
  phoolchadar:{ label:'Phoolon ki Chadar',  category:'decor',     w:8,  h:8  },
  jhoola:     { label:'Swing / Jhoola',     category:'decor',     w:8,  h:4  },
  haldi:      { label:'Haldi Setup',        category:'decor',     w:14, h:10 },
  mehendi:    { label:'Mehendi Lounge',     category:'decor',     w:16, h:12 },
  selfieframe:{ label:'Selfie Frame',       category:'decor',     w:6,  h:2  },
  welcomeboard:{label:'Welcome Board',      category:'decor',     w:3,  h:2.5},
  fairylights:{ label:'Fairy Light Canopy', category:'decor',     w:24, h:24 },
  couplesofa: { label:'Couple Sofa',        category:'seating',   w:7,  h:3.5},
  livecounter:{ label:'Live Food Counter',  category:'logistics', w:8,  h:4  },
  kidszone:   { label:'Kids Zone',          category:'logistics', w:20, h:16 },
  aircooler:  { label:'Air Cooler / Fan',   category:'logistics', w:2.5,h:2.5},
  /* ---- event-aware décor + production pack (2026-10b): real-world footprints in ft.
     Florals (weddings / receptions / religious), balloons (birthdays / kids), stage & political
     infrastructure (rallies / public meetings / conferences), award-night and religious pieces.
     Tags + allowed event types live in PRODUCT_META below (window.HelmCatalog). ---- */
  floralentrance:{ label:'Entrance Floral Arch', category:'decor', w:14, h:4  },
  stagebackdrop:{ label:'Stage Floral Backdrop', category:'decor',  w:24, h:2  },
  flowerwall: { label:'Flower Wall',        category:'decor',     w:8,  h:1.5},
  toran:      { label:'Garland Toran',      category:'decor',     w:12, h:1  },
  floralpillar:{ label:'Floral Pillar',     category:'decor',     w:2.5,h:2.5},
  aislefloral:{ label:'Aisle Floral Stand', category:'decor',     w:1.5,h:1.5},
  centrepiece:{ label:'Tall Centrepiece',   category:'decor',     w:2,  h:2  },
  balloonarch:{ label:'Balloon Arch',       category:'decor',     w:10, h:2  },
  balloonbunch:{ label:'Balloon Bouquet',   category:'decor',     w:2,  h:2  },
  lectern:    { label:'Lectern',            category:'av',        w:2.5,h:2  },
  dais:       { label:'Dais with Chairs',   category:'structure', w:24, h:8,  props:{chairs:8} },
  flagstand:  { label:'Flag Stand',         category:'decor',     w:2,  h:2  },
  hoarding:   { label:'Banner / Hoarding Frame', category:'structure', w:20, h:2 },
  patower:    { label:'PA Tower',           category:'av',        w:4,  h:4  },
  lightingtree:{ label:'Lighting Tree (T-Bar)', category:'av',    w:3,  h:3  },
  diyastand:  { label:'Brass Deepam Stand', category:'decor',     w:2,  h:2  },
  trophytable:{ label:'Trophy Display',     category:'logistics', w:6,  h:2.5},
  /* ---- religious + ambience pack (2026-10c): real-world footprints in ft (see docs/research/event-inventory-2026-10.md) ---- */
  havankund:  { label:'Havan Kund',         category:'decor',     w:4,  h:4  },
  rangoli:    { label:'Rangoli / Kolam',    category:'decor',     w:6,  h:6  },
  lanterns:   { label:'Lantern Cluster',    category:'decor',     w:2,  h:2  },
  hangingfloral:{ label:'Hanging Floral Ceiling', category:'decor', w:12, h:12 },
  neonsign:   { label:'Neon Sign Wall',     category:'decor',     w:6,  h:1  },
  /* ---- complete-catalogue pack (2026-10d): generic basics + the remaining pieces for every event type.
     Real-world footprints in ft (docs/research/event-inventory-2026-10.md §9). ---- */
  backdrop:   { label:'Backdrop (generic)', category:'decor', w:10, h:1 },
  floralstand:{ label:'Floral Stand (generic)', category:'decor', w:2, h:2 },
  decorbox:   { label:'Decor Item (generic)', category:'decor', w:3, h:3 },
  signage:    { label:'Signage / Standee', category:'logistics', w:2.5, h:1.5 },
  recttable:  { label:'Rectangular Table', category:'seating', w:6, h:2.5, props:{seats:3} },
  stageroof:  { label:'Stage Roof Truss', category:'structure', w:40, h:24 },
  varmala:    { label:'Varmala Platform', category:'structure', w:10, h:10 },
  micstand:   { label:'Mic Stand', category:'av', w:1, h:1 },
  teleprompter:{ label:'Teleprompter / Confidence Monitor', category:'av', w:3, h:1.5 },
  projector:  { label:'Projector Screen', category:'av', w:12, h:2 },
  tvstand:    { label:'TV Screen on Stand', category:'av', w:4, h:2 },
  interpreter:{ label:'Interpreter Booth', category:'av', w:6, h:6 },
  pyro:       { label:'Cold Pyro / CO2 Jet', category:'av', w:1.5, h:1.5 },
  towerlight: { label:'Mobile Light Tower', category:'logistics', w:5, h:5 },
  gaddi:      { label:'Floor Seating (Gaddi)', category:'seating', w:8, h:8 },
  urli:       { label:'Flower Urli', category:'decor', w:3, h:3 },
  umbrellas:  { label:'Decor Umbrellas', category:'decor', w:8, h:8 },
  doli:       { label:'Doli / Palki', category:'decor', w:6, h:3 },
  kalash:     { label:'Kalash / Purna Kumbh', category:'decor', w:1.5, h:1.5 },
  altar:      { label:'Pooja Altar / Idol Platform', category:'decor', w:6, h:4 },
  shoerack:   { label:'Shoe Rack', category:'logistics', w:6, h:1.5 },
  dessert:    { label:'Dessert / Candy Table', category:'logistics', w:8, h:2.5 },
  coffee:     { label:'Coffee / Tea Station', category:'logistics', w:6, h:2.5 },
  stall:      { label:'Food / Merch Stall', category:'logistics', w:10, h:10 },
  counter:    { label:'Display Counter', category:'logistics', w:4, h:2 },
  plinth:     { label:'Display Plinth', category:'decor', w:1.5, h:1.5 },
  kiosk:      { label:'Check-in Kiosk', category:'logistics', w:2, h:2 },
  ticketbooth:{ label:'Ticket Booth', category:'logistics', w:8, h:6 },
  stanchion:  { label:'Stanchions (rope & post)', category:'security', w:10, h:1 },
  watchtower: { label:'Watch Tower / CCTV', category:'security', w:6, h:6 },
  extinguisher:{ label:'Fire Point', category:'safety', w:1.5, h:1 },
  ambulance:  { label:'Ambulance Bay', category:'safety', w:22, h:9 },
};

/* ---- searchable product list (window.HelmCatalog) ----
   One row per ASSETS type: { type, name, category, tags[], eventTypes[] }. eventTypes are the
   HelmWizard type keys a product suits ('*' = any event). Event rules (what each event type may
   use, and where) live in layout-wizard.js (HelmWizard.EVENT_RULES); this list only describes
   products so a search box / suggestion panel can filter them. Read-only; never priced here. */
const PRODUCT_META = {
  floral:['floral','flowers centrepiece table decor roses','wedding reception engagement birthday galadinner religious award_night'],
  floralarch:['floral','flowers arch backdrop entrance roses','wedding reception engagement galadinner religious'],
  floralentrance:['floral','entrance arch flowers gateway welcome','wedding reception engagement galadinner religious'],
  stagebackdrop:['floral','stage backdrop flowers wall behind couple','wedding reception engagement galadinner religious'],
  flowerwall:['floral','flower wall photo backdrop roses','wedding reception engagement birthday galadinner award_night'],
  toran:['floral','garland toran marigold door hanging bandhanwar','wedding engagement religious'],
  floralpillar:['floral','pillar column flowers stage entrance','wedding reception engagement galadinner religious'],
  aislefloral:['floral','aisle stand flowers walkway pathway','wedding reception engagement galadinner'],
  centrepiece:['floral','tall centrepiece table flowers candelabra','wedding reception engagement galadinner award_night'],
  phoolchadar:['floral','phoolon ki chadar flower canopy bride entry','wedding'],
  entrancegate:['floral','entrance gate flowers marigold','wedding reception engagement religious'],
  mandap:['floral','mandap wedding ceremony pillars','wedding religious'],
  pillar:['floral','decor pillar flowers','wedding reception engagement galadinner'],
  haldi:['floral','haldi marigold setup','wedding engagement'],
  mehendi:['floral','mehendi lounge','wedding engagement'],
  selfieframe:['floral','selfie frame photo','wedding reception engagement birthday'],
  balloonarch:['balloon','balloons arch birthday party kids','birthday'],
  balloonbunch:['balloon','balloons bouquet bunch helium party','birthday'],
  kidszone:['kids','kids play bouncy castle','birthday wedding reception'],
  lectern:['stage','lectern podium speech mic','political corporate product_launch conference award_night religious exhibition'],
  podium:['stage','podium speech','political corporate product_launch conference award_night'],
  dais:['stage','dais chairs vip platform guests of honour','political corporate conference award_night religious'],
  flagstand:['political','flag stand pole national party','political corporate conference'],
  hoarding:['branding','banner hoarding frame flex scaffold','political corporate product_launch exhibition concert festival'],
  patower:['av','pa tower speakers sound scaffold public address','political concert festival'],
  lightingtree:['lighting','lighting tree stand t-bar par cans tripod','*'],
  diyastand:['religious','deepam lamp diya brass inauguration','religious wedding corporate conference'],
  trophytable:['award','trophy display awards table','award_night corporate'],
  havankund:['religious','havan kund pooja fire ritual agni homam yagna','wedding religious'],
  rangoli:['religious','rangoli kolam floor art flower petals muggu','wedding religious engagement festival corporate'],
  lanterns:['decor','lanterns candles moroccan glow aisle','wedding reception engagement birthday galadinner iftar eid'],
  hangingfloral:['floral','hanging flowers ceiling installation suspended floral','wedding reception engagement galadinner'],
  neonsign:['decor','neon sign wall glow photo backdrop sangeet','wedding reception engagement birthday product_launch'],
  backdrop:['generic','backdrop wall photo backdrop step and repeat fabric flex sequin greenery generic','*'],
  floralstand:['floral','flower stand vase urn pedestal bouquet floral generic','wedding reception engagement birthday galadinner religious award_night corporate product_launch'],
  decorbox:['generic','decor prop generic item box crate cylinder sphere cutout custom other','*'],
  signage:['branding','sign signage standee roll-up rollup banner a-frame directional wayfinding cutout digital standee generic','*'],
  recttable:['seating','rectangular table classroom training trestle 6ft table generic seminar','*'],
  stageroof:['stage','stage roof ground support truss canopy concert festival rigging','concert festival political corporate product_launch award_night exhibition'],
  varmala:['wedding','varmala jaimala garland exchange rotating platform stage couple','wedding engagement'],
  micstand:['av','mic microphone stand podium speech singer','*'],
  teleprompter:['av','teleprompter confidence monitor autocue speaker screen','political corporate product_launch conference award_night'],
  projector:['av','projector screen fastfold presentation slides display','*'],
  tvstand:['av','tv television display screen stand monitor 65 inch','*'],
  interpreter:['av','interpreter translation booth simultaneous interpretation conference','corporate conference product_launch political exhibition'],
  pyro:['av','cold pyro sparkular fireworks co2 jet confetti cannon special effects sfx entry','wedding reception engagement birthday concert festival award_night product_launch corporate galadinner'],
  towerlight:['logistics','light tower mobile floodlight outdoor parking site lighting','concert festival political exhibition'],
  gaddi:['seating','floor seating gaddi bolster durrie baithak majlis mattress cushions satsang','wedding engagement religious iftar eid'],
  urli:['floral','urli brass bowl floating flowers candles water petals','wedding engagement religious reception galadinner corporate'],
  umbrellas:['wedding','umbrella chhatri parasol mehendi haldi hanging umbrellas canopy','wedding engagement birthday'],
  doli:['wedding','doli palki palanquin bride vidaai entry','wedding'],
  kalash:['religious','kalash kumbh purna kumbh coconut pot pooja brass','wedding religious engagement corporate'],
  altar:['religious','altar pooja puja idol platform deity temple mandir church','religious wedding'],
  shoerack:['logistics','shoe rack stand footwear counter temple','religious wedding iftar eid'],
  dessert:['food','dessert candy sweets mithai table cupcakes treats','*'],
  coffee:['food','coffee tea station chai beverage break hi-tea','*'],
  stall:['food','stall food stall merch merchandise canopy kiosk vendor counter','*'],
  counter:['expo','display counter showcase info desk product counter exhibition','*'],
  plinth:['expo','plinth pedestal product display podium column exhibit','*'],
  kiosk:['expo','kiosk check-in self check in badge printing registration touch screen','corporate product_launch conference exhibition award_night concert festival'],
  ticketbooth:['logistics','ticket booth box office counter entry wristband','concert festival exhibition'],
  stanchion:['security','stanchion rope post queue line velvet rope crowd control red carpet','*'],
  watchtower:['security','watch tower cctv camera security surveillance tower','political concert festival exhibition'],
  extinguisher:['safety','fire extinguisher fire point safety sand bucket','*'],
  ambulance:['safety','ambulance medical emergency bay standby','*'],
  barricade:['security','barricade crowd control','political concert festival'],
  led:['av','led wall screen','*'], press:['political','press riser media cameras','political product_launch concert'],
  brandwall:['branding','branding wall step and repeat backdrop','corporate product_launch political exhibition award_night'],
  chandelier:['decor','chandelier crystal','wedding reception galadinner award_night'],
  fairylights:['lighting','fairy lights canopy','wedding reception birthday engagement'],
};
function productCatalog(){
  return Object.entries(ASSETS).map(([type,a])=>{ const m=PRODUCT_META[type]||[];
    const tags=String((m[1]||'')+' '+a.label+' '+a.category).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
    return { type, name:a.label, category:a.category, group:m[0]||a.category, tags:[...new Set(tags)], eventTypes:(m[2]||'*').split(' ') }; });
}
if(typeof window!=='undefined') window.HelmCatalog = Object.freeze({
  list: productCatalog,
  // search('flower', 'wedding') → products whose name/tags match every word and that suit the event type
  search(q, eventType){ const words=String(q||'').toLowerCase().split(/\s+/).filter(Boolean);
    const ev=String(eventType||'').toLowerCase();
    const rules=window.HelmWizard && window.HelmWizard.allowsProduct;
    return productCatalog().filter(p=>words.every(w=>p.name.toLowerCase().includes(w)||p.tags.some(t=>t.startsWith(w)))
      && (!ev || (rules ? rules(ev, p.type) : (p.eventTypes.includes('*')||p.eventTypes.includes(ev))))); },
});

/* ---------------------------------------------------------------- pricing
   Live price breakdown. Chairs/seats are priced per-seat from the Control
   Centre chair rate; every other object is priced per-unit. Prices fall back
   to a sensible in-code default and can be overridden from Settings
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
  // CATALOG-DEFAULTS (2026-10): newer builder items — see docs/ITEM-PRICING-DEFAULTS.md
  led:18000, lighting:9600, walkway:6000, brandwall:9600, podium:3500, barricade:1800, stagebarrier:9000, fence:1500,
  checkpoint:3000, exit:500, speaker:4000, monitor:1500, movinghead:2500, uplight:500, smoke:5000, dancers:14000,
  chocolatefountain:9000, chariot:20000, booth:8000, desk:2500, gifttable:1500, caketable:1500, heater:2500, easel:500,
  distro:3000, cableramp:600, lounge:6000, sofa:2500, loveseat:2000, armchair:1200, ottoman:500, bench:800,
  coffeetable:800, bleacher:15000, floral:1500, pillar:2000, drape:2400, planter:800,
  entrancegate:25000, phoolchadar:6000, jhoola:12000, haldi:18000, mehendi:15000, selfieframe:3500, welcomeboard:2500,
  fairylights:8000, couplesofa:8000, livecounter:7000, kidszone:15000, aircooler:1500,
  floralentrance:30000, stagebackdrop:35000, flowerwall:12000, toran:4000, floralpillar:4500, aislefloral:1800, centrepiece:2500,
  balloonarch:6000, balloonbunch:800, lectern:4000, dais:30000, flagstand:1500, hoarding:12000, patower:15000, lightingtree:3500,
  diyastand:2500, trophytable:3000,
  havankund:3500, rangoli:2500, lanterns:1200, hangingfloral:18000, neonsign:4000,
  backdrop:6000, floralstand:1500, decorbox:2000, signage:1200, stageroof:60000, varmala:25000, micstand:500, teleprompter:6000, projector:8000, tvstand:4000, interpreter:15000, pyro:3000, towerlight:4000, gaddi:3000, urli:2500, umbrellas:5000, doli:12000, kalash:800, altar:8000, shoerack:1000, dessert:3500, coffee:3000, stall:6000, counter:2500, plinth:1000, kiosk:3000, ticketbooth:5000, stanchion:1200, watchtower:8000, extinguisher:300, ambulance:6000,
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
// Past layouts are always re-priced from the CURRENT Settings catalog:
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
// true when Settings catalog has a live rate for this object type
function inCatalog(type, assetPrices){ return !!(assetPrices && assetPrices[type]!=null); }
// runtime pricing config (loaded from Settings in init)
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
// QA-B10: the menu package a quote was priced with (pricing._packageName), matched by name; a sample
// package named "Demo · Gold — Non-veg" matches "Gold — Non-veg" (and the other way round)
function pkgNameKey(n){ return String(n==null?'':n).replace(/^\s*Demo \u00b7 /,'').replace(/\s+/g,' ').trim().toLowerCase(); }
function pkgFromQuoteName(pkgs, name){
  const k=pkgNameKey(name); if(!k) return null;
  const list=Array.isArray(pkgs)?pkgs:[];
  return list.find(p=>p && p.name===name) || list.find(p=>p && pkgNameKey(p.name)===k) || null;
}
function buildMenuControls(){
  const box=$('#pkgPanel'); if(!box) return;
  const pkgs=PRICING.packages||[];
  // QA-B27 review: "Hide amounts" never masks <option> text, so the per-plate rate is left out while amounts are hidden
  // (the selected package is pre-selected now, so its rate would otherwise sit in plain view); rebuilt on toggle below
  const hideAmt=document.documentElement.classList.contains('hb-priv-on');
  const opts=['<option value="">No package…</option>'].concat(
    pkgs.map(p=>`<option value="${esc(p.id)}" ${p.id===PRICING.appliedPkgId?'selected':''}>${esc(p.name)}${hideAmt?'':' · '+inr(p.price_per_plate)+'/plate'}</option>`)).join('');
  box.innerHTML =
    `<label class="pfield">Menu package<select id="bPkg" ${CAN_CREATE?'':'disabled'}>${opts}</select></label>`+
    `<label class="pfield">Guests / plates <input id="bGuests" type="number" min="0" value="${PRICING.guests!=null?PRICING.guests:''}" ${RO?'disabled':''}></label>`+
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
// QA-B27 review: re-label the package options when "Hide amounts" is switched (shell-b-privacy.js toggles html.hb-priv-on)
try{ let _privWas=document.documentElement.classList.contains('hb-priv-on');
  new MutationObserver(()=>{ const on=document.documentElement.classList.contains('hb-priv-on'); if(on===_privWas) return; _privWas=on;
    if($('#bPkg')){ try{ buildMenuControls(); }catch(e){} } }).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
}catch(e){}
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
  // the venue picker warns on the CURRENT layout: generator vs the venue's generator rule, DJ vs curfew, seats vs capacity
  layout: () => ({ items: (store && store.items) || [], seats: sumSeats((store && store.items) || []) }),
  async link(v){
    if(!currentQuoteId) return;
    currentClient = Object.assign({}, currentClient || {}, v
      ? { venueId: v.id, venueName: v.name, setting: v.setting === 'outdoor' ? 'outdoor' : (v.setting === 'both' ? 'both' : 'indoor'),
          // 0096: the venue's full size (ft) is kept for reference; hallLen/hallWid stay the usable area
          venueLen: (window.HelmVenues && HelmVenues.mToFt(v.length_m)) || null, venueWid: (window.HelmVenues && HelmVenues.mToFt(v.width_m)) || null }
      : { venueId: null, venueName: null });
    try{ await BPStore.quotes.updateMeta(currentQuoteId, { client: currentClient }); }catch(e){ /* non-fatal */ }
  },
  // QA-B27: the saved venue this event points at, for pre-selecting the venue pickers: the linked id when it is
  // in the list, else the venue the quote names (client.venueName / client.venue, e.g. the sample events) matched
  // by name. Read-only: nothing is linked or saved until the planner picks a venue.
  linkedId(rows){
    const c=currentClient||{}, list=Array.isArray(rows)?rows:[];
    if(c.venueId && list.some(v=>v && v.id===c.venueId)) return String(c.venueId);
    const key=n=>String(n==null?'':n).replace(/\s+/g,' ').trim().toLowerCase();
    const want=key(c.venueName||c.venue); if(!want) return c.venueId?String(c.venueId):'';
    const strip=n=>key(n).replace(/^demo \u00b7 /,'');
    const hit=list.find(v=>v && key(v.name)===want) || list.find(v=>v && strip(v.name)===strip(want));
    return hit ? String(hit.id) : (c.venueId?String(c.venueId):'');
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
    // hide-price mode: display-only flags for every screen that shows this quote's price (computed totals unchanged)
    ...(store.priceDisplay ? { priceDisplay: priceDisp() } : {}),
    // r19: the package was removed here - the saved pricing no longer names it (undefined is dropped on save)
    ...(pkgCleared ? { _packageName: undefined } : {}),
  // 0079: a NEW quote takes the studio's tax country/inclusive setting; a priced one keeps its own
  }, currentPricing.gstPct==null ? BPStore.tax.snapshot(BPStore.tax.resolve(PRICING)) : {});
}
// R112: a sent / approved quote is never re-priced silently. When the layout (or the builder's plates / package / chairs)
// would change its guests or total, the background sync writes NOTHING (it remembers the pending change) and the explicit
// saves (Save, Save & back to quote) ask: "Layout changes the quote: guests 200 -> 150, total X -> Y" -
// "Update quote (new version)" saves a new quotation version (save_quotation_version; the client must approve again) /
// "Keep quote" leaves the quote's price exactly as it is. Drafts keep the old live sync.
let _repricePending=null, _repriceTold=false;
async function syncQuotePricingNow(opts){
  if(!currentQuoteId) return false;
  clearTimeout(_syncTimer);
  const interactive = !!(opts && opts.interactive);
    try{
      // refetch the latest saved pricing (discount/coupon/rates may have changed in quotes.html since
      // this page opened) and write back conditioned on its updated_at, so nothing is clobbered
      let expectedUpdatedAt = null, latest = null;
      try{ latest = await BPStore.quotes.get(currentQuoteId);
        if(latest){ currentPricing = latest.pricing || currentPricing; expectedUpdatedAt = latest.updatedAt || null; } }catch(_){}
      const p = quotePricingNow();
      const t = BPStore.pricing.quoteTotal(p);
      // C3: never drop / change the quote's own tax snapshot (country, currency, ...) from the builder
      const pricing = BPStore.tax.preserveSnapshot(currentPricing, Object.assign({}, p, { computed:t, total:t.total, client: currentClient }));
      const G = window.HelmRepriceGuard;
      if(G && G.committed(latest || Object.assign({}, currentQuoteRow||{}, { approvalStatus: currentQuoteGuard.sent ? 'sent' : (currentQuoteGuard.approved ? 'approved' : '') }))){
        const d = G.diff(currentPricing, pricing);
        if(d.changed){
          if(!interactive){
            _repricePending = d;
            if(!_repriceTold){ _repriceTold=true;
              toast('This quote was sent to the client, so its price is not changed here until you save - you will be asked first.'); }
            return false;
          }
          const approved = !!(latest && (latest.approvalStatus==='approved' || latest.approvalStatus==='paid' || latest.status==='confirmed')) || currentQuoteGuard.approved;
          const go = await BPUI.confirm(G.message(d, inr)+' '+(approved
              ? 'Updating saves a new quotation version, and the client must approve the new price again (payments pause until then).'
              : 'Updating saves a new quotation version; send the client the updated quote afterwards.')+' Keep quote leaves the price exactly as it is.',
            { title: approved ? 'Client approval will go stale' : 'Layout changes the quote', okLabel:'Update quote (new version)', cancelLabel:'Keep quote' });
          _repricePending = null;
          if(!go){ toast('Quote kept at '+inr(d.totalFrom)+' - only the layout was saved.'); return 'kept'; }
          const r = await BPStore.quotationVersions.save(currentQuoteId, pricing);
          currentPricing = pricing; _lastAutoOther = pricing.otherAuto;
          updateQuoteBadge && updateQuoteBadge();
          toast('Quote updated - saved as '+((r&&r.label)||'a new version')+(approved?'. The client must approve the new price.':'.'));
          return true;
        }
      }
      await BPStore.quotes.updateMeta(currentQuoteId, { pricing }, expectedUpdatedAt);
      currentPricing = pricing; _lastAutoOther = pricing.otherAuto;
      updateQuoteBadge && updateQuoteBadge();
      return true;
    }catch(e){ /* non-fatal */ if(interactive) toast('Couldn\u2019t update the quote price: '+String((e&&e.message)||'please try again').slice(0,160)); return false; }
}
// r19: "No package / decide later" was picked - the quote's synced pricing drops the package name it was priced
// with (pricing._packageName), so reopening the builder does not show the old package again (QA-B10)
var pkgCleared=false;
async function onPickPackage(){
  const tid=$('#bPkg').value;
  const prev={ id:PRICING.appliedPkgId, plate:PRICING.menuPlatePrice, name:PRICING.menuPackageName };
  // r19 (0211): "No package…" un-applies the package (clear_menu_template): the plan forgets it and its plate price,
  // catering is priced at the studio's default plate price; the event's dishes are kept
  if(!tid){
    if(!prev.id && !prev.name) return;
    if(!currentQuoteId){ PRICING.appliedPkgId=''; PRICING.menuPlatePrice=null; PRICING.menuPackageName=null; renderAll(); return; }
    try{ await BPStore.menuTemplates.clear(currentQuoteId); }
    catch(e){ const sel=$('#bPkg'); if(sel) sel.value=prev.id||'';
      toast((e && e.message) ? 'Couldn\'t remove the package: '+String(e.message).slice(0,160) : 'Couldn\'t remove the package — price left unchanged'); return; }
    PRICING.appliedPkgId=''; PRICING.menuPackageName=null;
    PRICING.menuPlatePrice = PRICING.platePrice!=null ? +PRICING.platePrice : null;   // the default plate price, never the old package's
    pkgCleared=true;
    toast('No package for now — catering uses your default plate price');
    renderAll(); syncQuotePricing(); return;
  }
  pkgCleared=false;
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
    m.chairsCost=qp.chairs*qp.chairPrice; m.svcPct=+qp.serviceChargePct||0; m.gstPct=+qp.gstPct||0; m.taxInclusive=qt.taxInclusive;
    // QA-B9: the line labels show the SAME counts and unit rates the totals were priced with (the quote's own
    // chairPrice / platePrice), never the studio defaults - "450 × ₹100 = ₹20,250" read as wrong maths
    m.chairs=+qp.chairs||0; m.chairPrice=+qp.chairPrice||0; m.guests=+qp.guests||0; m.platePrice=+qp.platePrice||0;
    m.cateringCost=+qt.plateSub||0; m.cateringExtra=+qt.cateringAmt||0; }
  let rows='';
  if(m.chairs>0)
    rows+=`<div class="prow"><span>Chairs <span class="q">${m.chairs} × ${inr(m.chairPrice)}</span></span><span class="amt">${inr(m.chairsCost)}</span></div>`;
  if(m.cateringCost>0)
    rows+=`<div class="prow"><span>Catering${PRICING.menuPackageName?' <span class="q">'+esc(String(PRICING.menuPackageName).replace(/^\s*Demo \u00b7 /,''))+'</span>':''} <span class="q">${m.guests} × ${inr(m.platePrice)}</span></span><span class="amt">${inr(m.cateringCost)}</span></div>`;
  if(m.cateringExtra>0) rows+=`<div class="prow"><span>Catering <span class="q">set on quote</span></span><span class="amt">${inr(m.cateringExtra)}</span></div>`;
  if(otherSet!=null){ if(otherSet>0) rows+=`<div class="prow"><span>Décor / setup <span class="q">set on quote</span></span><span class="amt">${inr(otherSet)}</span></div>`; }
  else (m.objectLines||[]).forEach(l=>{
    const label=ASSETS[l.type]?ASSETS[l.type].label:l.type;
    // 0086: a spec-priced item reads like "Stage 8 × 5 m (40 m²) @ ₹450/m² = ₹18,000"
    if(l.spec && l.label){ rows+=`<div class="prow"><span><span class="q">${esc(l.label)}</span></span><span class="amt">${inr(l.cost)}</span></div>`; return; }
    const flag = l.note ? ' <span class="q nocat" title="This item\'s adjusted spec could not be priced from Item pricing — using the catalog price">'+esc(l.note)+'</span>'
      : (PRICING.assetPrices && !inCatalog(l.type, PRICING.assetPrices) && DEFAULT_PRICES[l.type]==null) ? ' <span class="q nocat" title="No rate for this item in Settings — using a default price">price not in catalog</span>' : '';
    rows+=`<div class="prow"><span>${esc(label)} <span class="q">${l.qty>1?l.qty+' × '+inr(l.unit):inr(l.unit)}</span>${flag}</span><span class="amt">${inr(l.cost)}</span></div>`;
  });
  if(otherSet==null && m.layoutBase>0) rows+=`<div class="prow"><span>Layout &amp; setup</span><span class="amt">${inr(m.layoutBase)}</span></div>`;
  if(m.serviceCharge>0) rows+=`<div class="prow"><span>Service <span class="q">${m.svcPct}%</span></span><span class="amt">${inr(m.serviceCharge)}</span></div>`;
  if(!rows) rows='<div class="empty">Add items and pick a menu package to see the price build up.</div>';
  const tax = m.subtotal>0 ? `<div class="prow sub"><span>Subtotal</span><span class="amt">${inr(m.subtotal)}</span></div>`
    + (m.discount>0 ? `<div class="prow"><span>Discount</span><span class="amt">− ${inr(m.discount)}</span></div>` : '')
    + `<div class="prow"><span>${esc(BPStore.tax.resolve(PRICING).name)}${m.taxInclusive?' (included)':''} <span class="q">${m.gstPct}%</span></span><span class="amt">${inr(m.gst)}</span></div>` : '';
  const pd=priceDisp(), chk=$('#hidePriceChk'); if(chk) chk.checked=pd.hidden;
  if(pd.hidden) renderManualPrice(box, pd);
  else box.innerHTML = rows + tax +
    `<div class="prow total"><span>Total</span><span class="amt">${inr(m.total)}</span></div>`;
  const gd=$('#bGuests'); if(gd && document.activeElement!==gd) gd.placeholder = m.chairs+' (= chairs)';
  const d=$('#pkgDelta'); if(d) d.innerHTML=`Seats in layout: <b>${esc(sumSeats(store.items))}</b> · plates billed: <b>${m.guests}</b>`;
}


/* ---- hide-price mode: per-item calculations hidden, the planner types ONE amount ----
   store.priceDisplay = { hidden, manualAmount } — saved in the layout doc (serialize) and in the quote's
   pricing JSON (quotePricingNow → priceDisplay). Display only: pricing.computed / total are still calculated
   (server pricing authority) so nothing downstream loses the real numbers. */
function priceDisp(x){ const T=window.HelmBuilderTools; const src=x!==undefined?x:store.priceDisplay;
  return T ? T.normPriceDisplay(src) : { hidden:!!(src&&src.hidden===true), manualAmount:null }; }
function setPriceDisplay(patch){
  store.priceDisplay = priceDisp(Object.assign({}, priceDisp(), patch));
  try{ dirty.mark(); if(typeof scheduleDraft==='function') scheduleDraft(); }catch(_){}
  syncQuotePricing();
}
function renderManualPrice(box, pd){
  const cur=box.querySelector('#manualAmt');
  if(cur && document.activeElement===cur) return;            // never rebuild under the planner's cursor
  box.textContent='';
  const wrap=document.createElement('div'); wrap.className='pmanual';
  const lb=document.createElement('label'); lb.htmlFor='manualAmt'; lb.textContent='Event price (shown instead of the breakdown)';
  const inp=document.createElement('input'); inp.type='number'; inp.id='manualAmt'; inp.min='0'; inp.step='1'; inp.inputMode='decimal';
  inp.placeholder='Enter the amount'; inp.disabled=!!RO; if(pd.manualAmount!=null) inp.value=String(pd.manualAmount);
  inp.addEventListener('change',()=>{ const v=inp.value.trim(); setPriceDisplay({ manualAmount: v==='' ? null : +v }); renderPrice(); });
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); inp.blur(); } });
  const tot=document.createElement('div'); tot.className='prow total';
  const a=document.createElement('span'); a.textContent='Total'; const b=document.createElement('span'); b.className='amt';
  b.textContent = pd.manualAmount!=null ? inr(pd.manualAmount) : '—'; tot.append(a,b);
  const note=document.createElement('div'); note.className='pnote'; note.textContent='Item-by-item prices are hidden. Untick “Hide price breakdown” to see them again.';
  wrap.append(lb, inp, note); box.append(wrap, tot);
}

/* ---------------------------------------------------------------- store */
const store = {
  items: [],
  selectedId: null,        // primary selection (drives the single-object inspector, resize/rotate, 3D)
  selectedIds: [],         // full multi-selection set
  // UAE audit: metres by default outside India / US (a saved layout's own unit still wins on load)
  grid: { snap:true, show:true, unit:(function(){ try{ const c=(typeof BPStore!=='undefined'&&BPStore.studioTax&&BPStore.studioTax().country)||'IN'; return c==='IN'||c==='US'?'ft':'m'; }catch(_){ return 'ft'; } })(), sizeFt:1 },
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
/* Save-state indicator next to the layout name: Saved ✓ / Unsaved changes / Saving… / Save failed.
   Hidden until a document baseline exists or the first edit happens. Driven by the dirty tracker. */
let saveUi='idle';
function renderSaveState(force){
  const el=document.getElementById('saveState'); if(!el) return;
  if(force) saveUi=force;
  else if(saveUi!=='saving') saveUi = dirty.isDirty() ? (saveUi==='error'?'error':'dirty') : (savedSig!==null?'saved':'idle');
  const txt={saved:'Saved ✓',dirty:'Unsaved changes',saving:'Saving…',error:'Save failed — retry'}[saveUi];
  el.hidden=!txt || RO; el.textContent=txt||''; el.dataset.state=saveUi;
  el.title = saveUi==='error' ? 'The last save did not go through. Press Save (⌘S) to try again.' : saveUi==='dirty' ? 'You have changes that are not saved yet (⌘S to save)' : '';
}
{ const m=dirty.mark.bind(dirty), c=dirty.clean.bind(dirty);
  dirty.mark=function(){ const r=m.apply(null,arguments); renderSaveState(); return r; };
  dirty.clean=function(){ const r=c.apply(null,arguments); if(saveUi==='error') saveUi='saved'; renderSaveState(); return r; }; }
let savedSig = null;   // signature of the last saved / opened document; null = nothing saved yet → any edit is dirty
// Content signature: items + margins + venue + hall size + name. A non-custom colour is theme-derived
// (re-resolved on theme toggle), so it is left out — switching theme never makes the floor "unsaved".
function layoutSig(items, margins, venue, world, name){
  const its=(items||[]).map(it=>{ const c=Object.assign({}, it); if(!c.colorCustom) delete c.color; return c; });
  return JSON.stringify([its, margins||null, venue||null, world?[world.w,world.h]:null, String(name==null?'':name).trim()]);
}
function docSig(){ const pn=$('#projName'); return layoutSig(store.items, store.margins, store.venue, WORLD, pn?pn.value:''); }
// r19 L2: what the server holds for the open quote's version on screen ({count, hash} of the canvas content, name
// excluded). null = not known / never written (a missing V1). Set only when a version is opened or saved.
let storedKey=null;
function canvasKey(sig){ const s = sig!=null ? sig : layoutSig(store.items, store.margins, store.venue, WORLD, '');
  return (window.HelmFlowLayout && HelmFlowLayout.layoutKey) ? HelmFlowLayout.layoutKey(store.items.length, s) : { count:store.items.length, hash:s }; }
function noteStoredVersion(key){ storedKey = key || canvasKey(); }
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
  let go=false; try{ go=await BPUI.confirm('An unsaved draft of this quote from '+BPStore.fmtDateTime(d.savedAt)+' was found in this browser (it was never saved to the server). Restore it? Your saved versions are not changed until you press Save.',{title:'Restore unsaved draft?',okLabel:'Restore draft',cancelLabel:'Discard draft'}); }catch{}
  if(!go){ clearDraft(); return; }
  applyLayout(d.data); if(d.name) $('#projName').value=d.name;
  // dev pass 3: a restored draft lives only in this browser - it must read "Unsaved changes" until Save,
  // even if a late load step re-baselines the page.
  draftRestored=true; markDirty(); dirty.mark(); renderSaveState('dirty'); toast('Draft restored — press Save to keep it');
}
// the document now matches what's stored (just opened or saved). Pass the signature captured when the
// save STARTED so edits made while it was in flight keep the page dirty.
let draftRestored=false;
function setSavedBaseline(sig){
  const dr = typeof draftRestored!=='undefined' && draftRestored;
  if(dr && sig==null){ dirty.mark(); renderSaveState('dirty'); return; }   // keep a restored draft "unsaved"
  if(dr && sig!=null) draftRestored=false;
  savedSig = sig==null ? docSig() : sig; if(docSig()===savedSig) dirty.clean(); else dirty.mark(); }
// r19 L2: a layout generated on arrival (?gen=1) is NOT what the server holds - keep the stored version as the
// baseline and show "Unsaved changes" (the leave-page warning applies) until Save / Save & back writes it.
function markGenUnsaved(){ if(savedSig===null) savedSig=''; dirty.mark(); renderSaveState('dirty'); }
// dev pass 3: leaving while a Save is still going to the server loses it - warn first
window.addEventListener('beforeunload', e=>{ let busy=false; try{ busy=!!saving; }catch{} if(busy){ e.preventDefault(); e.returnValue=''; return ''; } });
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
  // r20-coord: also the name / venue capacity / guests inputs, "Save & back to quote" and "Save as template"
  // (shown later by studio-templates.js, which checks B.ro() too) - a view-only role changes nothing here
  ['saveBtn','clearBtn','customBtn','importBtn','undoBtn','redoBtn','hidePriceChk','projName','capInput','bGuests','backToFlowBtn','st_saveBtn'].forEach(id=>{ const b=$('#'+id); if(b) b.disabled=true; });
  { const sb=$('#st_saveBtn'); if(sb) sb.hidden=true; }
  const tb=$('#toolbox'); if(tb){ tb.style.pointerEvents='none'; tb.style.opacity='.45';
    tb.querySelectorAll('.tool').forEach(t=>{ t.tabIndex=-1; t.setAttribute('aria-disabled','true'); }); }
  document.querySelector('.viewport').classList.add('ro');
  const bar=document.createElement('div'); bar.className='robanner';
  if(customMsg) bar.textContent=customMsg;
  else { bar.setAttribute('role','status'); bar.textContent='👁 View only — your role can view layouts but not change them.'; }
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
// a single row has no row-to-row pitch (its depth is just the chair), so only chair-to-chair spacing counts —
// otherwise every 2 ft-deep chair row the wizard places was flagged "tight" on a fresh layout
function seatPitchFt(it){ const c=Math.max(1,it.properties.cols||1), r=Math.max(1,it.properties.rows||1); return r<=1 ? it.width/c : Math.min(it.width/c, it.height/r); }
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
  if(msg){ banner.hidden=false; banner.className='capbanner '+bcls; banner.textContent=msg; banner.title=msg; } else banner.hidden=true;
}

function gridStepFt(){ return store.grid.unit==='m' ? 1/ FT_PER_M * FT_PER_M : 1; } // grid cell always 1 unit
// grid cell size in FEET for the active unit (1 ft, or 1 m expressed in ft)
function cellFt(){ return store.grid.unit==='m' ? FT_PER_M : 1; }
// snap root cause (2026-10): snapped metre values were then re-rounded to 0.1 ft by the move path (round1), so a
// 1 m cell landed at 3.3 ft / 3 m at 9.8 ft — off the drawn lines. snapTo keeps 4 decimals; posRound keeps it.
function snapFt(v){ const T=window.HelmBuilderTools; if(T) return T.snapTo(v, cellFt(), !!store.grid.snap);
  if(!store.grid.snap) return round1(v); const c=cellFt(); return Math.round(v/c)*c; }
const posRound = v => store.grid.snap ? Math.round(v*1e4)/1e4 : round1(v);

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
  specSyncAll();   // 0086: a resized stage keeps its spec (and price) in step with its footprint
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
// R72: a freshly-dropped sofa/lounge should open INTO the room (toward the stage, conventionally the top
// of the plan), not have its back to it. rotation 180 = the seat faces "north" (-z) in the 3D model's
// convention. NEW placements only: this is applied at the drop sites (addAsset / sandbox add), never in
// makeItem, so loaded/saved layouts and hand-tuned templates keep their own stored rotation untouched.
const NEW_ITEM_FACING = { sofa:180, loveseat:180, armchair:180, lounge:180 };
// Items most events only want ONE of — adding a second is usually a slip, so we ask first.
const SINGULAR_ASSETS = new Set(['stage','dancefloor','dj','mandap','caketable','headtable','foh','videowall','piano','redcarpet','fountain']);
async function addAsset(type, atFt, opts){
  const a = ASSETS[type], lbl = opts && opts.label;
  if(SINGULAR_ASSETS.has(type) && store.items.some(it=>it.type===type)){
    const ok = await BPUI.confirm('There’s already a '+a.label+' on this floor. Most events only need one — add another anyway?',
      {title:'Add another '+a.label+'?', okLabel:'Add another', cancelLabel:'Keep just one'});
    if(!ok) return;
  }
  const cx = atFt ? atFt.x : viewCenterFt().x;
  const cy = atFt ? atFt.y : viewCenterFt().y;
  let x = clamp(snapFt(cx - a.w/2), 0, WORLD.w-a.w);
  let y = clamp(snapFt(cy - a.h/2), 0, WORLD.h-a.h);
  // the Entrance marker gets its own blue (exits stay green); still editable in the Inspector
  const it = makeItem(type, x, y, lbl ? Object.assign({label:lbl}, type==='exit' && /entr/i.test(lbl) ? {color:'#2563eb', colorCustom:true} : {}) : undefined);
  if(NEW_ITEM_FACING[type]!=null) it.rotation = NEW_ITEM_FACING[type];   // R72: new sofa/lounge faces into the room
  store.items.push(it);
  setSelection([it.id]);
  commit(); renderAll();
  toast((lbl || a.label) + ' added');
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
  // selection handles are zoom-compensated — redraw just the overlay so they keep their on-screen size
  try{ if(store.selectedIds && store.selectedIds.length===1 && !drag){ svg.querySelectorAll('[data-sel]').forEach(g=>g.remove()); const it=selected(); if(it) svg.appendChild(renderSelection(it)); } }catch(_){ /* called once during boot before drag/selection exist */ }
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
// r19: the 2D paint order = the 3D one - floor coverings (carpet, aisle runner, dance floor, walkway, anything
// spread over half the hall) lie under everything else; the rest keeps its saved order (Bring Front still works)
function drawOrder2D(items, world){ const T=window.HelmBuilderTools; return (T && T.drawOrder) ? T.drawOrder(items, world||WORLD) : items.slice(); }
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

  // --- items --- (r19: floor coverings first, so a full-hall carpet never hides the stage / screens above it)
  drawOrder2D(store.items).forEach(it=> svg.appendChild(renderItem(it)));

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
    .map(it => {   // measure the footprint as drawn: a rotated item's axis-aligned box (a 90° riser is h wide, not w)
      const cx=it.x+it.width/2, cy=it.y+it.height/2, a=((+it.rotation||0)%180)*Math.PI/180;
      const c=Math.abs(Math.cos(a)), sn=Math.abs(Math.sin(a)), hw=(it.width*c+it.height*sn)/2, hh=(it.width*sn+it.height*c)/2;
      const r2=v=>Math.round(v*100)/100;
      return { it, l:r2(cx-hw), r:r2(cx+hw), t:r2(cy-hh), b:r2(cy+hh), cx, cy };
    });
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
      // offsets from the hall's centre axes (dashed centre lines) + an X / Y readout from the origin
      const T=window.HelmBuilderTools, o=T ? T.offsets({ x:a.l, y:a.t, width:a.r-a.l, height:a.b-a.t }, WORLD) : null;
      if(o){
        const ax=el('g',{ class:'axis' });
        ax.appendChild(el('line',{ x1:WORLD.w/2*P, y1:0, x2:WORLD.w/2*P, y2:WORLD.h*P, stroke:'currentColor','stroke-width':1*s,'stroke-dasharray':(8*s)+' '+(5*s),'stroke-opacity':.5 }));
        ax.appendChild(el('line',{ x1:0, y1:WORLD.h/2*P, x2:WORLD.w*P, y2:WORLD.h/2*P, stroke:'currentColor','stroke-width':1*s,'stroke-dasharray':(8*s)+' '+(5*s),'stroke-opacity':.5 }));
        g.appendChild(ax);
        if(Math.abs(o.fromCentreX)>EPS) g.appendChild(dim(WORLD.w/2, a.cy, a.cx, a.cy, Math.abs(o.fromCentreX), 'axis'));
        if(Math.abs(o.fromCentreY)>EPS) g.appendChild(dim(a.cx, WORLD.h/2, a.cx, a.cy, Math.abs(o.fromCentreY), 'axis'));
        tag(a.l, a.t, 'X '+fmt(o.x)+' · Y '+fmt(o.y), 'origin');
      }
    }
  } else if(store.selectedIds.length===0 && boxes.length && boxes.length<=30){
    // nothing selected: every object's offset to its NEAREST wall on each axis (X and Y)
    const T=window.HelmBuilderTools;
    if(T) boxes.forEach(a=>{ const o=T.offsets({ x:a.l, y:a.t, width:a.r-a.l, height:a.b-a.t }, WORLD);
      if(o.nearestX.gap>EPS){ const x2=o.nearestX.side==='left'?0:WORLD.w; g.appendChild(dim(Math.min(x2, o.nearestX.side==='left'?a.l:a.r), a.cy, Math.max(x2, o.nearestX.side==='left'?a.l:a.r), a.cy, o.nearestX.gap, 'wall')); }
      if(o.nearestY.gap>EPS){ const y2=o.nearestY.side==='top'?0:WORLD.h; g.appendChild(dim(a.cx, Math.min(y2, o.nearestY.side==='top'?a.t:a.b), a.cx, Math.max(y2, o.nearestY.side==='top'?a.t:a.b), o.nearestY.gap, 'wall')); }
    });
  }
  // origin (0,0) marker — every X / Y offset is measured from this corner
  { const og=el('g',{ class:'origin' }), r=5*s;
    og.appendChild(el('circle',{ cx:0, cy:0, r, fill:'currentColor', 'fill-opacity':.85 }));
    g.appendChild(og); tag(0, 0, '0,0 '+uLabel(), 'origin', true); }
  return g;
  // small text chip anchored at a plan point (ft); inside=true nudges it into the floor from the corner
  function tag(xFt, yFt, txt, cls, inside){
    const fs=11*s, wLbl=(txt.length*6.4+8)*s, hLbl=fs+4*s, gx=xFt*P+(inside?wLbl/2+6*s:wLbl/2), gy=yFt*P-(inside?-hLbl:hLbl/2+4*s);
    const gg=el('g',{ class:cls||'' });
    gg.appendChild(el('rect',{ class:'mbg', x:gx-wLbl/2, y:gy-hLbl/2, width:wLbl, height:hLbl, rx:3*s, 'stroke-width':.6*s }));
    const t=el('text',{ x:gx, y:gy+fs*0.34, 'text-anchor':'middle', 'font-size':fs }); t.textContent=txt; gg.appendChild(t);
    g.appendChild(gg);
  }
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
      if(it.type==='dancefloor'){ // parquet / LED checker
        const n=Math.max(2,Math.min(8,Math.round(Math.max(w,h)/(4*PX_PER_FT)))), tw=w/n, th=h/n;
        for(let i=0;i<n;i++) for(let j=0;j<n;j++) if((i+j)%2) body.appendChild(el('rect',{x:-w/2+i*tw,y:-h/2+j*th,width:tw,height:th,fill:c,'fill-opacity':.22}));
      } else {    // stage: backdrop band (rear), skirting edge (front) + centre steps
        body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h*0.12,10),fill:c,'fill-opacity':.55}));
        body.appendChild(el('line',{x1:-w/2+3,y1:h/2-2.5,x2:w/2-3,y2:h/2-2.5,stroke:c,'stroke-width':1,'stroke-dasharray':'2 2'}));
        const sw=Math.min(8*PX_PER_FT,w*0.25);
        for(let i=1;i<=3;i++) body.appendChild(el('line',{x1:-sw/2,y1:h/2+i*3.4,x2:sw/2,y2:h/2+i*3.4,stroke:c,'stroke-width':1,'stroke-opacity':.75}));
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
      body.appendChild(el('circle',{cx:0,cy:0,r:rad*0.78,fill:'none',stroke:c,'stroke-width':.6,'stroke-opacity':.45}));   // cloth / plate ring
      if(it.type==='table') body.appendChild(el('circle',{cx:0,cy:0,r:Math.max(2,rad*0.18),fill:c,'fill-opacity':.45}));   // centrepiece
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
      if(it.type==='floral' || it.type==='pillar'){ const R=Math.min(w,h)/2;
        for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.45,cy:Math.sin(a)*R*0.45,r:R*0.28,fill:c,'fill-opacity':.45})); }
        body.appendChild(el('circle',{cx:0,cy:0,r:R*0.22,fill:c,'fill-opacity':.85})); }
      break; }
    case 'fountain': {
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/4,fill:'none',stroke:c,'stroke-width':1,'stroke-opacity':.6})); break; }
    case 'floralarch': {
      body.appendChild(el('path',{d:`M ${-w/2+3} ${h/2} Q 0 ${-h/2-6} ${w/2-3} ${h/2}`,fill:'none',stroke:c,'stroke-width':1.5,'stroke-opacity':.6}));
      for(let i=0;i<=10;i++){ const t=i/10, x=(1-t)*(1-t)*(-w/2+3)+t*t*(w/2-3), y=(1-t)*(1-t)*(h/2)+2*t*(1-t)*(-h/2-6)+t*t*(h/2);
        if(t<=0.6 || i%2===0) body.appendChild(el('circle',{cx:x,cy:y,r:t<=0.6?2.6:1.8,fill:c,'fill-opacity':i%3?0.6:0.9})); }
      [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx*(w/2-3)-3,y:h/2-3,width:6,height:6,rx:1.5,fill:fillSoft,stroke:c,'stroke-width':1}))); break; }
    case 'mandap': {
      drawBox({fill:`color-mix(in srgb, ${c} 16%, var(--canvas))`, rx:2, dash:'6 4', sw:1.5});
      body.appendChild(el('rect',{x:-w*0.41,y:-h*0.41,width:w*0.82,height:h*0.82,rx:2,fill:c,'fill-opacity':.12,stroke:c,'stroke-width':.75,'stroke-opacity':.5}));
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sxx,syy])=>{ const px=sxx*(w/2-1.2*PX_PER_FT), py=syy*(h/2-1.2*PX_PER_FT);
        body.appendChild(el('circle',{cx:px,cy:py,r:Math.max(3,0.75*PX_PER_FT),fill:c,'fill-opacity':.8}));
        body.appendChild(el('circle',{cx:px,cy:py,r:Math.max(5,1.3*PX_PER_FT),fill:'none',stroke:c,'stroke-width':.75,'stroke-opacity':.6})); });
      body.appendChild(el('ellipse',{cx:0,cy:0,rx:w*0.36,ry:h*0.36,fill:'none',stroke:c,'stroke-width':.75,'stroke-dasharray':'3 3','stroke-opacity':.55}));   // canopy dome
      body.appendChild(el('rect',{x:-0.7*PX_PER_FT,y:-0.7*PX_PER_FT,width:1.4*PX_PER_FT,height:1.4*PX_PER_FT,fill:c,'fill-opacity':.55,rx:1})); break; }
    case 'drape': { drawBox({fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`});
      for(let x=-w/2+3;x<w/2;x+=4) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.75,'stroke-opacity':.5})); break; }
    case 'chandelier': { const R=Math.min(w,h)/2;
      [1,0.68,0.38].forEach(k=>body.appendChild(el('circle',{cx:0,cy:0,r:R*k,fill:'none',stroke:c,'stroke-width':k===1?1.5:.8,'stroke-opacity':k===1?1:.6})));
      for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R,cy:Math.sin(a)*R,r:1.6,fill:c})); }
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
    /* ---- V3 event-production pack ---- */
    case 'lighting': { drawBox({fill:'transparent',sw:1.2});      // truss span with par cans hanging under it
      { const nz=Math.max(2,Math.floor(w/8)), s=w/nz; body.appendChild(el('path',{d:Array.from({length:nz},(_,i)=>{ const x=-w/2+i*s; return `M ${x} ${-h/2} L ${x+s/2} ${h/2} L ${x+s} ${-h/2}`; }).join(' '),fill:'none',stroke:c,'stroke-width':1,'stroke-opacity':.7})); }   // V3 fix: Array.from's map gets no 3rd arg
      for(let x=-w/2+6;x<w/2-2;x+=Math.max(8,w/6)) body.appendChild(el('circle',{cx:x,cy:0,r:Math.min(3,h/2+1),fill:c})); break; }
    case 'led': case 'brandwall': { drawBox({fill:it.type==='led'?`color-mix(in srgb, ${c} 45%, var(--canvas))`:fillSoft, rx:1});
      if(it.type==='led') for(let x=-w/2+w/8;x<w/2;x+=w/8) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':.6,'stroke-opacity':.6}));
      else body.appendChild(el('line',{x1:-w/2+3,y1:0,x2:w/2-3,y2:0,stroke:c,'stroke-width':1,'stroke-dasharray':'4 3'})); break; }
    case 'chocolatefountain': { body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)/2,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      [0.34,0.18].forEach(k=>body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)*k,fill:'none',stroke:c,'stroke-width':1}))); break; }
    case 'chariot': { drawBox({fill:fillSoft, rx:Math.min(w,h)*0.4});
      [-1,1].forEach(sxx=>[-1,1].forEach(syy=>body.appendChild(el('circle',{cx:sxx*(w/2-w*0.18),cy:syy*h/2,r:Math.min(h*0.22,8),fill:'none',stroke:c,'stroke-width':1.5})))); break; }
    case 'smoke': { body.appendChild(el('rect',{x:-w/2,y:-h/4,width:w*0.7,height:h/2,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M ${w*0.2} 0 q ${w*0.15} ${-h*0.3} ${w*0.3} 0`,fill:'none',stroke:c,'stroke-width':1.2,'stroke-opacity':.7})); break; }
    case 'dancers': { drawBox({fill:'transparent',dash:'5 3',sw:1.2});
      for(let i=0;i<5;i++){ const x=-w/2+w*(i+0.5)/5, y=(i%2?-1:1)*h*0.15; body.appendChild(el('circle',{cx:x,cy:y,r:Math.min(4,h*0.12),fill:c,'fill-opacity':.7})); } break; }
    case 'generator': { drawBox({fill:fillSoft, rx:1});
      body.appendChild(el('path',{d:`M ${w*0.08} ${-h*0.32} L ${-w*0.06} ${h*0.04} L ${w*0.04} ${h*0.04} L ${-w*0.08} ${h*0.32}`,fill:'none',stroke:c,'stroke-width':1.5})); break; }
    case 'walkway': { drawBox({fill:`color-mix(in srgb, ${c} 24%, var(--canvas))`, rx:1});
      body.appendChild(el('line',{x1:0,y1:-h/2+2,x2:0,y2:h/2-2,stroke:c,'stroke-width':1,'stroke-dasharray':'6 4'})); break; }
    /* ---- Indian wedding + corporate pack (2026-10) ---- */
    case 'entrancegate': { const pw=Math.max(1.6,Math.min(2.6,it.width*0.14))*PX_PER_FT;
      body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:h,rx:2,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'4 3','stroke-opacity':.6}));
      [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx>0?w/2-pw:-w/2,y:-h/2,width:pw,height:h,rx:2,fill:fillSoft,stroke:c,'stroke-width':1.5})));
      for(let x=-w/2+pw+4;x<w/2-pw-2;x+=6) body.appendChild(el('circle',{cx:x,cy:0,r:1.7,fill:c,'fill-opacity':.75}));
      break; }
    case 'phoolchadar': { drawBox({fill:fillSoft,rx:2});
      [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*(w/2-3),cy:sy*(h/2-3),r:2.4,fill:c})));
      for(let x=-w/2+8;x<w/2-4;x+=8) for(let y=-h/2+8;y<h/2-4;y+=8) body.appendChild(el('circle',{cx:x,cy:y,r:2,fill:c,'fill-opacity':.45}));
      break; }
    case 'jhoola': { drawBox({fill:'transparent',dash:'4 3',sw:1});
      body.appendChild(el('line',{x1:-w/2+4,y1:0,x2:w/2-4,y2:0,stroke:c,'stroke-width':2}));
      body.appendChild(el('rect',{x:-w*0.31,y:-h*0.22,width:w*0.62,height:h*0.44,rx:3,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      [-1,1].forEach(sx=>body.appendChild(el('circle',{cx:sx*(w/2-4),cy:0,r:2.6,fill:c}))); break; }
    case 'haldi': case 'mehendi': { drawBox({fill:`color-mix(in srgb, ${c} 20%, var(--canvas))`,rx:3});
      body.appendChild(el('rect',{x:-w/2,y:-h/2,width:w,height:Math.min(h*0.1,8),fill:c,'fill-opacity':.6}));   // backdrop / rear edge
      if(it.type==='haldi'){ body.appendChild(el('rect',{x:-w*0.2,y:-h/2+h*0.14,width:w*0.4,height:h*0.24,rx:3,fill:c,'fill-opacity':.45}));
        [-1,1].forEach(sx=>body.appendChild(el('circle',{cx:sx*w*0.32,cy:h/2-h*0.16,r:Math.min(w,h)*0.07,fill:'none',stroke:c,'stroke-width':1.2}))); }
      else { const n=Math.max(1,Math.round(it.width/8));
        for(let i=0;i<n;i++){ const x=-w/2+(i+0.5)*w/n; body.appendChild(el('circle',{cx:x,cy:h*0.12,r:Math.min(w/n,h)*0.32,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'3 2'}));
          body.appendChild(el('rect',{x:x-w/n*0.35,y:-h/4-6,width:w/n*0.7,height:8,rx:3,fill:c,'fill-opacity':.5})); } }
      break; }
    case 'selfieframe': case 'welcomeboard': { drawBox({fill:fillSoft,rx:1});
      body.appendChild(el('rect',{x:-w/2+2,y:-h/2+2,width:w-4,height:h-4,fill:'none',stroke:c,'stroke-width':.8,'stroke-opacity':.6}));
      [[-1,-1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*(w/2-2),cy:sy*(h/2-2),r:2.6,fill:c,'fill-opacity':.8}))); break; }
    case 'fairylights': { drawBox({fill:'transparent',dash:'2 4',sw:1});
      for(let i=0;i<16;i++){ const a=i/16*Math.PI*2, k=Math.min(Math.abs(1/Math.cos(a)),Math.abs(1/Math.sin(a)));
        body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*k*w/2,y2:Math.sin(a)*k*h/2,stroke:c,'stroke-width':.7,'stroke-opacity':.55,'stroke-dasharray':'1 3'})); }
      body.appendChild(el('circle',{cx:0,cy:0,r:3,fill:c})); break; }
    case 'couplesofa': { drawBox({fill:fillSoft,rx:Math.min(w,h)*0.3});
      body.appendChild(el('path',{d:`M ${-w/2+2} ${-h/2+h*0.4} Q 0 ${-h/2-4} ${w/2-2} ${-h/2+h*0.4}`,fill:'none',stroke:c,'stroke-width':2.2}));
      body.appendChild(el('line',{x1:0,y1:-h/2+h*0.3,x2:0,y2:h/2-2,stroke:c,'stroke-width':.6,'stroke-opacity':.5})); break; }
    case 'livecounter': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`});
      body.appendChild(el('line',{x1:-w/2,y1:-h/2+3,x2:w/2,y2:-h/2+3,stroke:c,'stroke-width':2}));
      body.appendChild(el('circle',{cx:-w*0.2,cy:h*0.1,r:Math.min(w,h)*0.18,fill:'none',stroke:c,'stroke-width':1.2})); break; }
    case 'kidszone': { drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`,rx:6,dash:'6 3'});
      body.appendChild(el('rect',{x:-w/2+6,y:-h/2+6,width:w*0.45,height:h*0.45,rx:3,fill:c,'fill-opacity':.3,stroke:c,'stroke-width':1}));
      body.appendChild(el('circle',{cx:-w/4,cy:h/4,r:Math.min(w,h)*0.12,fill:'none',stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M ${w/2-3*PX_PER_FT} ${-h*0.3} L ${w/2-3*PX_PER_FT} ${h*0.3}`,stroke:c,'stroke-width':4,'stroke-opacity':.45,'stroke-linecap':'round'})); break; }
    case 'aircooler': { drawBox({fill:fillSoft,rx:3});
      body.appendChild(el('circle',{cx:0,cy:0,r:Math.min(w,h)*0.32,fill:'none',stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M 0 0 L ${Math.min(w,h)*0.28} ${-Math.min(w,h)*0.1} M 0 0 L ${-Math.min(w,h)*0.05} ${Math.min(w,h)*0.28} M 0 0 L ${-Math.min(w,h)*0.24} ${-Math.min(w,h)*0.16}`,stroke:c,'stroke-width':1.2,'stroke-linecap':'round'})); break; }
    /* ---- event-aware décor + production pack (2026-10b) ---- */
    case 'floralentrance': case 'stagebackdrop': case 'flowerwall': case 'toran': {   // florals along a frame / wall line
      drawBox({fill:it.type==='toran'?'transparent':fillSoft, rx:1, sw:it.type==='toran'?0.8:1.5, dash:it.type==='toran'?'3 2':''});
      const step=it.type==='flowerwall'?5:7, R=Math.max(1.4,Math.min(3,h*0.32));
      for(let x=-w/2+step/2;x<w/2;x+=step) body.appendChild(el('circle',{cx:x,cy:it.type==='toran'?h*0.15:0,r:R,fill:c,'fill-opacity':(Math.round(x)%3)?0.55:0.9}));
      if(it.type==='floralentrance') [-1,1].forEach(sx=>body.appendChild(el('rect',{x:sx>0?w/2-2.4*PX_PER_FT:-w/2,y:-h/2,width:2.4*PX_PER_FT,height:h,rx:2,fill:c,'fill-opacity':.35,stroke:c,'stroke-width':1})));
      break; }
    case 'floralpillar': case 'aislefloral': case 'centrepiece': case 'balloonbunch': case 'diyastand': {
      const R=Math.min(w,h)/2, n=it.type==='balloonbunch'?5:it.type==='diyastand'?5:7;
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.5}));
      for(let i=0;i<n;i++){ const a=i/n*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.5,cy:Math.sin(a)*R*0.5,r:R*(it.type==='diyastand'?0.14:0.3),fill:c,'fill-opacity':.6})); }
      body.appendChild(el('circle',{cx:0,cy:0,r:R*0.2,fill:c})); break; }
    case 'balloonarch': {
      for(let i=0;i<=14;i++){ const t=i/14, x=-w/2+3+(w-6)*t, y=h/2-(h+8)*Math.sin(t*Math.PI)*0.6;
        body.appendChild(el('circle',{cx:x,cy:y,r:Math.max(2,Math.min(4,h*0.3)),fill:c,'fill-opacity':i%2?0.5:0.85})); }
      break; }
    case 'lectern': { drawBox({fill:`color-mix(in srgb, ${c} 26%, var(--canvas))`, rx:2});
      body.appendChild(el('line',{x1:-w/2+2,y1:h/2-3,x2:w/2-2,y2:h/2-3,stroke:c,'stroke-width':1.5}));
      body.appendChild(el('circle',{cx:0,cy:-h*0.15,r:1.6,fill:c})); break; }
    case 'dais': { drawBox({fill:`color-mix(in srgb, ${c} 16%, var(--canvas))`, rx:1});
      body.appendChild(el('rect',{x:-w*0.4,y:-h*0.05,width:w*0.8,height:h*0.22,rx:1,fill:c,'fill-opacity':.35}));   // table
      { const n=Math.max(1,Math.min(16,(it.properties&&it.properties.chairs)|0||8));
        for(let i=0;i<n;i++) body.appendChild(el('rect',{x:-w*0.4+(i+0.5)*(w*0.8/n)-2.5,y:-h*0.32,width:5,height:5,rx:1,fill:c,'fill-opacity':.85})); }
      break; }
    case 'flagstand': { const R=Math.min(w,h)/2;
      body.appendChild(el('circle',{cx:0,cy:0,r:R*0.6,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('path',{d:`M 0 0 L ${R} ${-R*0.5} L ${R} ${R*0.2} Z`,fill:c,'fill-opacity':.7})); break; }
    case 'hoarding': { drawBox({fill:fillSoft, rx:0});
      for(let x=-w/2;x<=w/2+0.1;x+=w/4) body.appendChild(el('line',{x1:x,y1:-h/2,x2:x,y2:h/2,stroke:c,'stroke-width':1}));
      body.appendChild(el('line',{x1:-w/2,y1:0,x2:w/2,y2:0,stroke:c,'stroke-width':.8,'stroke-dasharray':'4 3'})); break; }
    case 'patower': { drawBox({fill:'transparent',sw:1.2});
      body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.8,'stroke-opacity':.6}));
      body.appendChild(el('rect',{x:-w*0.3,y:-h*0.3,width:w*0.6,height:h*0.6,rx:1,fill:c,'fill-opacity':.7})); break; }
    case 'lightingtree': { const R=Math.min(w,h)/2;
      [0,120,240].forEach(d=>{ const a=(d-90)*Math.PI/180; body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*R,y2:Math.sin(a)*R,stroke:c,'stroke-width':1.2})); });
      body.appendChild(el('line',{x1:-R,y1:0,x2:R,y2:0,stroke:c,'stroke-width':2}));
      [-0.75,-0.25,0.25,0.75].forEach(k=>body.appendChild(el('circle',{cx:k*R,cy:0,r:Math.max(1.4,R*0.16),fill:c})));
      break; }
    case 'trophytable': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:1});
      for(let i=0;i<5;i++){ const x=-w/2+(i+0.5)*w/5; body.appendChild(el('path',{d:`M ${x-2} ${-2} h 4 l -1 3 h -2 Z`,fill:c,'fill-opacity':.8})); }
      break; }
    case 'havankund': { const R=Math.min(w,h)/2;
      body.appendChild(el('rect',{x:-R,y:-R,width:2*R,height:2*R,fill:`color-mix(in srgb, ${c} 22%, var(--canvas))`,stroke:c,'stroke-width':1.2}));
      body.appendChild(el('rect',{x:-R*0.55,y:-R*0.55,width:R*1.1,height:R*1.1,fill:'#ff9a3c','fill-opacity':.75}));
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('circle',{cx:sx*R*0.8,cy:sy*R*0.8,r:Math.max(1,R*0.1),fill:c}))); break; }
    case 'rangoli': { const R=Math.min(w,h)/2;
      for(let k=0;k<3;k++) body.appendChild(el('circle',{cx:0,cy:0,r:R*(1-k*0.3),fill:'none',stroke:c,'stroke-width':1.2,'stroke-opacity':1-k*0.2}));
      for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('ellipse',{cx:Math.cos(a)*R*0.55,cy:Math.sin(a)*R*0.55,rx:R*0.22,ry:R*0.1,transform:`rotate(${i*45} ${Math.cos(a)*R*0.55} ${Math.sin(a)*R*0.55})`,fill:c,'fill-opacity':.55})); }
      break; }
    case 'lanterns': { const R=Math.min(w,h)/2;
      [[-0.4,-0.3,0.45],[0.35,-0.25,0.35],[0,0.35,0.5]].forEach(([x,y,r])=>{ body.appendChild(el('rect',{x:x*R*2-r*R,y:y*R*2-r*R,width:2*r*R,height:2*r*R,rx:1,fill:'#ffd98a','fill-opacity':.6,stroke:c,'stroke-width':1})); }); break; }
    case 'hangingfloral': { drawBox({fill:'transparent',sw:1,dash:'4 3'});
      for(let i=0;i<7;i++) for(let j=0;j<7;j++){ if((i+j)%2) continue; body.appendChild(el('circle',{cx:-w/2+(i+0.5)*w/7,cy:-h/2+(j+0.5)*h/7,r:Math.max(1.5,Math.min(w,h)/20),fill:c,'fill-opacity':.6})); }
      break; }
    case 'neonsign': { drawBox({fill:`color-mix(in srgb, ${c} 14%, var(--canvas))`, rx:1});
      body.appendChild(el('path',{d:`M ${-w*0.35} 0 q ${w*0.12} ${-h*0.6} ${w*0.24} 0 t ${w*0.24} 0 t ${w*0.22} 0`,fill:'none',stroke:'#ff4fd8','stroke-width':2})); break; }
    /* ---- complete-catalogue pack (2026-10d) ---- */
    case 'backdrop': case 'projector': case 'teleprompter': { drawBox({fill:`color-mix(in srgb, ${c} 20%, var(--canvas))`, rx:1});
      if(it.type!=='backdrop') body.appendChild(el('rect',{x:-w*0.42,y:-h*0.25,width:w*0.84,height:h*0.5,fill:'#9fb6ff','fill-opacity':.6}));
      else for(let i=1;i<4;i++) body.appendChild(el('line',{x1:-w/2+i*w/4,y1:-h/2,x2:-w/2+i*w/4,y2:h/2,stroke:c,'stroke-width':.6,'stroke-opacity':.5}));
      break; }
    case 'floralstand': case 'urli': case 'kalash': case 'plinth': case 'micstand': case 'pyro': case 'extinguisher': { const R=Math.min(w,h)/2;
      const ring=it.type==='urli'||it.type==='kalash';
      body.appendChild(el(it.type==='plinth'||it.type==='extinguisher'?'rect':'circle', it.type==='plinth'||it.type==='extinguisher'
        ? {x:-w/2,y:-h/2,width:w,height:h,rx:1,fill:it.type==='extinguisher'?'#dc2626':fillSoft,'fill-opacity':it.type==='extinguisher'?.7:1,stroke:c,'stroke-width':1.2}
        : {cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.2}));
      if(ring) body.appendChild(el('circle',{cx:0,cy:0,r:R*0.55,fill:c,'fill-opacity':.45}));
      else if(it.type==='floralstand') for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.5,cy:Math.sin(a)*R*0.5,r:R*0.28,fill:c,'fill-opacity':.55})); }
      else if(it.type==='pyro') for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; body.appendChild(el('line',{x1:0,y1:0,x2:Math.cos(a)*R,y2:Math.sin(a)*R,stroke:'#f59e0b','stroke-width':1})); }
      else if(it.type==='micstand') body.appendChild(el('circle',{cx:0,cy:0,r:R*0.3,fill:c}));
      break; }
    case 'decorbox': case 'signage': case 'counter': case 'kiosk': case 'shoerack': case 'tvstand': { drawBox({fill:fillSoft, rx:it.type==='decorbox'?3:1});
      if(it.type==='decorbox') body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.7,'stroke-opacity':.5}));
      else if(it.type==='shoerack') for(let i=1;i<6;i++) body.appendChild(el('line',{x1:-w/2+i*w/6,y1:-h/2,x2:-w/2+i*w/6,y2:h/2,stroke:c,'stroke-width':.6}));
      else body.appendChild(el('rect',{x:-w*0.35,y:-h*0.3,width:w*0.7,height:h*0.25,fill:c,'fill-opacity':.5}));
      break; }
    case 'recttable': {
      drawBox({fill:fillSoft, rx:1});
      const n=Math.max(0,Math.min(12,it.properties.seats|0));
      for(let i=0;i<n;i++) body.appendChild(el('circle',{cx:-w/2+(i+0.5)/n*w,cy:h/2+3.2,r:clamp(Math.min(w/Math.max(1,n),6)*0.5,1.5,3.4),fill:c,'fill-opacity':.85}));
      break; }
    case 'stageroof': case 'interpreter': case 'ticketbooth': case 'watchtower': case 'towerlight': case 'stall': {
      drawBox({fill:it.type==='stageroof'?'transparent':fillSoft, rx:1, dash:it.type==='stageroof'?'6 4':''});
      const k=Math.min(w,h)*0.12;
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sy])=>body.appendChild(el('rect',{x:sx*(w/2-k)-k/2,y:sy*(h/2-k)-k/2,width:k,height:k,fill:c,'fill-opacity':.8})));
      if(it.type==='stageroof'||it.type==='watchtower') body.appendChild(el('path',{d:`M ${-w/2} ${-h/2} L ${w/2} ${h/2} M ${w/2} ${-h/2} L ${-w/2} ${h/2}`,stroke:c,'stroke-width':.7,'stroke-opacity':.45}));
      break; }
    case 'varmala': case 'umbrellas': case 'gaddi': { const R=Math.min(w,h)/2;
      if(it.type==='gaddi'){ drawBox({fill:fillSoft, rx:2});
        [[-1,0],[1,0],[0,-1],[0,1]].forEach(([sx,sy])=>body.appendChild(el('rect',{x:sx? sx*(w/2-w*0.08)-w*0.05 : -w*0.4, y:sy? sy*(h/2-h*0.08)-h*0.05 : -h*0.4, width:sx? w*0.1 : w*0.8, height:sy? h*0.1 : h*0.8, rx:2, fill:c,'fill-opacity':.45}))); break; }
      body.appendChild(el('circle',{cx:0,cy:0,r:R,fill:fillSoft,stroke:c,'stroke-width':1.3}));
      if(it.type==='umbrellas') for(let i=0;i<5;i++){ const a=i/5*Math.PI*2; body.appendChild(el('circle',{cx:Math.cos(a)*R*0.55,cy:Math.sin(a)*R*0.55,r:R*0.3,fill:c,'fill-opacity':.35,stroke:c,'stroke-width':.8})); }
      else body.appendChild(el('circle',{cx:0,cy:0,r:R*0.75,fill:'none',stroke:c,'stroke-width':1,'stroke-dasharray':'3 2'}));
      break; }
    case 'doli': case 'altar': case 'dessert': case 'coffee': { drawBox({fill:`color-mix(in srgb, ${c} 18%, var(--canvas))`, rx:1});
      if(it.type==='doli') body.appendChild(el('line',{x1:-w/2-4,y1:0,x2:w/2+4,y2:0,stroke:c,'stroke-width':1.6}));
      else for(let i=0;i<3;i++) body.appendChild(el('circle',{cx:-w/3+i*w/3,cy:0,r:Math.max(1.5,Math.min(w/8,h*0.3)),fill:c,'fill-opacity':.5}));
      break; }
    case 'stanchion': { drawBox({fill:'transparent', sw:0.01});
      const n=Math.max(2,Math.round(w/(5*PX_PER_FT))+1);
      body.appendChild(el('line',{x1:-w/2,y1:0,x2:w/2,y2:0,stroke:'#b91c1c','stroke-width':1.6}));
      for(let i=0;i<n;i++) body.appendChild(el('circle',{cx:-w/2+i*w/(n-1),cy:0,r:Math.max(1.6,h*0.3),fill:c}));
      break; }
    case 'ambulance': { drawBox({fill:'transparent', dash:'6 4'});
      body.appendChild(el('rect',{x:-w*0.38,y:-h*0.3,width:w*0.76,height:h*0.6,rx:2,fill:'#ffffff','fill-opacity':.85,stroke:c,'stroke-width':1}));
      body.appendChild(el('path',{d:`M ${-h*0.12} 0 h ${h*0.24} M 0 ${-h*0.12} v ${h*0.24}`,stroke:'#dc2626','stroke-width':2}));
      break; }
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
  // handles are drawn in world px, so divide by zoom to keep them a constant ~8 px on screen — at the 37% fit
  // zoom they were ~3 px and the rotate knob sat on top of the top edge handle (drag resized instead of rotating)
  const k=1/Math.max(0.05, (store.view&&store.view.zoom)||1), hs=8*k, hh=hs/2;
  const g = el('g',{transform:`translate(${cx} ${cy}) rotate(${it.rotation})`, 'data-sel':'1'});
  g.appendChild(el('rect',{class:'sel-outline', x:-w/2-2,y:-h/2-2,width:w+4,height:h+4,rx:3}));
  // corner resize handles (scale both dimensions)
  const corners=[[-1,-1],[1,-1],[1,1],[-1,1]];
  corners.forEach(([sx,sy])=>{
    g.appendChild(el('rect',{class:'handle','data-handle':'resize', x:sx*w/2-hh, y:sy*h/2-hh, width:hs,height:hs, rx:1.5*k}));
  });
  // edge handles → grab a side and stretch ONE dimension (extend carpets, aisles, fences, trusses)
  if(it.type!=='table' && it.type!=='cocktail'){       // round items stay circular, no edge stretch
    const edges=[[0,-1,'y','ns-resize'],[1,0,'x','ew-resize'],[0,1,'y','ns-resize'],[-1,0,'x','ew-resize']];
    edges.forEach(([sx,sy,axis,cur])=>{
      g.appendChild(el('rect',{class:'handle edge','data-handle':'resize','data-axis':axis,
        x:sx*w/2-hh, y:sy*h/2-hh, width:hs,height:hs, rx:1.5*k, style:'cursor:'+cur}));
    });
  }
  // rotate handle
  g.appendChild(el('line',{class:'rot-line', x1:0,y1:-h/2-2, x2:0, y2:-h/2-22*k}));
  g.appendChild(el('circle',{class:'rot-handle','data-handle':'rotate', cx:0, cy:-h/2-22*k, r:5*k}));
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
  if(!vw||!vh) return;                                // 2D plan hidden (3D view / fullscreen in 3D): keep the last strips, a ResizeObserver redraws once it is shown
  const z=store.view.zoom, ppuFt=PX_PER_FT*z;         // px per foot on screen
  const cell=cellFt();                                // feet per grid unit
  const css=getComputedStyle(document.documentElement);
  const inkc=css.getPropertyValue('--ink-3').trim();
  const linec=css.getPropertyValue('--line').trim();
  const strong=css.getPropertyValue('--grid-strong').trim();
  // r21: zoomed far out (a 550 ft rally ground at 10%) the numbers every 10 units ran into each other and the
  // 1-unit ticks merged into a bar: number every 10 / 20 / 50 / 100... units so they stay >= 30 px apart, and
  // skip the small ticks closer than 3 px. At the usual zoom levels nothing changes (every 10th, every tick).
  const labEvery=10*([1,2,5,10,20,50].find(k=>10*k*cell*ppuFt>=30)||100), tickOk=cell*ppuFt>=3;

  function prep(cv,w,h){ cv.width=w*dpr; cv.height=h*dpr; cv.style.width=w+'px'; cv.style.height=h+'px';
    const x=cv.getContext('2d'); x.setTransform(dpr,0,0,dpr,0,0); x.clearRect(0,0,w,h); return x; }

  // TOP ruler
  const ctxT=prep(rTop, vw, 26);
  ctxT.font='9px "IBM Plex Mono", monospace'; ctxT.textBaseline='alphabetic';
  const off=svgOff();                                 // r22: the floor may be centred in the plan area
  const sx=scrollEl.scrollLeft-off.x;
  let unitIndex=0;
  for(let f=0; f<=WORLD.w+0.001; f+=cell, unitIndex++){
    const px=f*ppuFt - sx;
    if(px<-20||px>vw+20) continue;
    const major = unitIndex%10===0;
    if(!major && !tickOk) continue;
    ctxT.strokeStyle=major?strong:linec; ctxT.beginPath();
    ctxT.moveTo(px, major?12:18); ctxT.lineTo(px,26); ctxT.stroke();
    if(major && unitIndex%labEvery===0){ ctxT.fillStyle=inkc; ctxT.fillText(Math.round(f/cell*10)/10, px+2, 10); }
  }
  // LEFT ruler
  const ctxL=prep(rLeft, 26, vh);
  ctxL.font='9px "IBM Plex Mono", monospace';
  const sy=scrollEl.scrollTop-off.y;
  unitIndex=0;
  for(let f=0; f<=WORLD.h+0.001; f+=cell, unitIndex++){
    const py=f*ppuFt - sy;
    if(py<-20||py>vh+20) continue;
    const major=unitIndex%10===0;
    if(!major && !tickOk) continue;
    ctxL.strokeStyle=major?strong:linec; ctxL.beginPath();
    ctxL.moveTo(major?12:18, py); ctxL.lineTo(26, py); ctxL.stroke();
    if(major && unitIndex%labEvery===0){ ctxL.save(); ctxL.fillStyle=inkc; ctxL.translate(9, py+2); ctxL.rotate(-Math.PI/2);
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
    if(['table','longtable','cocktail','headtable','recttable'].includes(i.type)) tables++; });
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
  variantMount(it, box);      // 2026-10c décor variants: style / flower / palette (VARIANTS block at the end of this file)
  specAdjustMount(it, box);   // 0086 item specs: "Adjust" section (ITEM-SPEC ADJUST block at the end of this file)
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
    drag.group.forEach(g=>{ const it=store.items.find(i=>i.id===g.id); it.x=posRound(g.ox+dx); it.y=posRound(g.oy+dy); });
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
  drawOrder2D(store.items).forEach(it=>svg.appendChild(renderItem(it)));
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
    it.push(makeItem('stage', cx-20, 8, {properties:{plain:true}}));
    it.push(makeItem('podium', cx-1.5, 18, {label:'Podium'}));
    it.push(makeItem('flagstand', cx-23, 9, {label:'Flag L'}));
    it.push(makeItem('flagstand', cx+21, 9, {label:'Flag R'}));
    it.push(makeItem('patower', cx-29, 10, {label:'PA Tower L'}));
    it.push(makeItem('patower', cx+25, 10, {label:'PA Tower R'}));
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
    it.push(makeItem('stage', cx-14, 8, {properties:{plain:true}, width:28,height:12,label:'Stage'}));
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
    it.push(makeItem('stage', cx-24, 8, {properties:{plain:true}, width:48,height:16,label:'Main Stage'}));
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
    it.push(makeItem('stage', cx-24, 6, {properties:{plain:true}, width:48,height:14,label:'Keynote Stage'}));
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
    it.push(makeItem('stage', cx-12, 6, {properties:{plain:true}, width:24,height:10,label:'Front'}));
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
    it.push(makeItem('stage', cx-28, 8, {properties:{plain:true}, width:56,height:20,label:'Main Stage'}));
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
    it.push(makeItem('stage', cx-24, 8, {properties:{plain:true}, width:48,height:16,label:'Main Stage'}));
    it.push(makeItem('barricade', cx-26, 28, {width:52,label:'Barrier'}));
    it.push(makeItem('stage', cx-18, WORLD.h-24, {properties:{plain:true}, width:36,height:14,label:'Second Stage'}));
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
    it.push(makeItem('stage', cx-12, 6, {properties:{plain:true}, width:24,height:10,label:'Stage'}));
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
    it.push(makeItem('stage', cx-26, 8, {properties:{plain:true}, width:52,height:18,label:'Main Stage'}));
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
    it.push(makeItem('stage', cx-16, 8, {properties:{plain:true}, width:32,height:12,label:'Stage'}));
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
    it.push(makeItem('trophytable', cx+21, 12, {label:'Trophies'}));
    it.push(makeItem('lightingtree', cx-23, 9, {label:'Lighting Tree L'}));
    it.push(makeItem('lightingtree', cx+28, 9, {label:'Lighting Tree R'}));
    it.push(makeItem('coatcheck', 10, 24, {label:'Coat Check'}));
    it.push(makeItem('exit', 6, WORLD.h-9, {label:'Exit'}));
    it.push(makeItem('exit', WORLD.w-18, WORLD.h-9, {label:'Exit'}));
    return it;
  },
  /* =============== BIRTHDAY / PRIVATE PARTY =============== */
  birthday_party(){
    const it=[], cx=WORLD.w/2;
    it.push(makeItem('balloonarch', cx-6, 8, {width:12,label:'Balloon Backdrop'}));   // birthdays get balloons, not a floral arch
    it.push(makeItem('balloonbunch', cx-10, 8, {label:'Balloons'}));
    it.push(makeItem('balloonbunch', cx+8, 8, {label:'Balloons'}));
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
    it.push(makeItem('stage', cx-20, 8, {properties:{plain:true}, width:40,height:14,label:'Reveal Stage'}));
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
/* load-fit.js: warn before loading a layout bigger than the current hall (Fit / Use the layout's size / Cancel) */
function lfAsk(sz){   // → 'ok' (fits) | 'fit' | 'size' | 'cancel'
  const LF=window.HelmLoadFit; if(!LF || !sz) return Promise.resolve('ok');
  const hall={w:WORLD.w,h:WORLD.h}; if(!LF.compare(sz,hall).any) return Promise.resolve('ok');
  return LF.ask(sz, hall, store.grid.unit, (CAPS&&CAPS.hall)||1000);
}
function lfUseSize(sz){
  const t=window.HelmLoadFit.targetHall(sz,(CAPS&&CAPS.hall)||1000);
  WORLD.w=t.w; WORLD.h=t.h; store.venue=store.venue||{}; store.venue.room={w:WORLD.w,h:WORLD.h};
  updateDimsLabel(); sizeCanvas();
  setTimeout(()=>BPUI.toast('Venue size changed to '+WORLD.w+' × '+WORLD.h+' ft'+(t.capped?' (the most your plan allows)':''),{type:'info'}),60);
}
function lfNote(before, opts){ if(window.HelmLoadFit) window.HelmLoadFit.note(before, store.items, ids=>{ setSelection(ids); renderAll(); }, opts); }
async function loadTemplate(key){
  if(!key){ return; }
  // r20: one load per pick (shared with studio-templates.js apply): a newer pick makes any pending load stale
  const tplSeq=window.__helmTplLoad=(window.__helmTplLoad||0)+1;
  // 0096: the studio's own templates ("st:<id>") are fitted to this hall + exact seats by studio-templates.js
  // trial "From past events" entries reuse the Past events reference loader
  if(String(key).indexOf('ref:')===0){ const r=$('#refEvents'); if(r){ r.value=String(key).slice(4); window.__refSkipConfirm=true; try{ r.dispatchEvent(new Event('change')); }finally{ window.__refSkipConfirm=false; } } return; }
  if(String(key).indexOf('st:')===0){ if(window.HelmStudioTemplates) window.HelmStudioTemplates.apply(String(key).slice(3)); return; }
  const lbl=document.querySelector('#preset option[value="'+key+'"]').textContent;
  // R8b: an open quote's seats value is the exact seating total for preset templates too
  const tItems=TEMPLATES[key]();
  const fitChoice=await lfAsk(window.HelmLoadFit && window.HelmLoadFit.size(tItems)); if(fitChoice==='cancel' || window.__helmTplLoad!==tplSeq) return;
  if(fitChoice==='size') lfUseSize(window.HelmLoadFit.size(tItems));
  const N=currentQuoteId ? quoteChairsNow() : 0;
  let natSeats=0, fullItems=null;
  if(N>0){ const nat=natSeats=sumSeats(tItems); if(nat>N) fullItems=JSON.parse(JSON.stringify(tItems)); exactSeats(tItems, N); const w=seatFitWarning(N, nat, null, PRICING.eventType); if(w) setTimeout(()=>BPUI.toast('⚠ '+w,{type:'err'}),50); }
  const lfBefore=fitChoice==='fit' ? JSON.parse(JSON.stringify(tItems)) : null;
  loadItems(tItems, lbl);
  toast(lbl + ' loaded');
  if(lfBefore) lfNote(lfBefore, {clamp:true});
  seatsFittedNotice(N, natSeats, fullItems, tplSeq);
}
/* r22 (live QA): an open quote trims a bigger template's seating to the quote's chairs (R8b: "Political rally -
   5,000 seats" on a 120-guest quote loaded 120 seats) - that stays, but it is SAID after the load, with a one-off
   "Use the template's 5,000 seats" that puts the template's full seating on the floor for this load. The quote's
   guest count is not changed (nothing is saved until Save). seq: a newer template pick makes the button stale. */
function seatsFittedNotice(N, nat, full, seq){
  N=Math.round(+N||0); nat=Math.round(+nat||0);
  if(!(N>0) || !(nat>N) || !Array.isArray(full) || !full.length) return;
  const n=v=>v.toLocaleString('en-IN');
  try{ BPUI.toast('Seats fitted to your quote\u2019s '+n(N)+' guests (the template has '+n(nat)+').', { type:'info', timeout:14000,
    action:{ label:'Use the template\u2019s '+n(nat)+' seats', onClick:()=>{
      if(RO || (seq!=null && window.__helmTplLoad!==seq)) return;
      loadItems(full, null); try{ renderPrice(); }catch(_){}
      toast('Using the template\u2019s '+n(sumSeats(store.items))+' seats - your quote\u2019s guest count is unchanged');
    } } }); }catch(_){}
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
    else if(tabs.length){
      // QA-B27: top up the round tables only to their own seats-per-table (the largest table = the generator's
      // spt); a table is never given 20 chairs. Whatever is left is packed as a seat block below.
      const cap=Math.max(...tabs.map(t=>+t.properties.seats||0));
      for(const t of tabs){ if(d<=0) break; const add=Math.min(d, Math.max(0, cap-(+t.properties.seats||0))); if(add>0){ t.properties={...t.properties, seats:(+t.properties.seats||0)+add}; d-=add; } }
    }
    if(d>0 && !blocks.length){ // no seating survived (tiny hall) or the tables are full: pack the remaining d into the largest free spot found
      N=d;   // from here on N = the seats still to place
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

/* ===================================================================
   V3 EVENT-TYPE DEFAULTS — the validated item set each event family gets on arrival (and as the
   "Standard … setup" recommendation in Custom Event). Built for the CURRENT hall (WORLD): stage and
   screens scale to it, every item is kept inside, the collision pass removes overlaps, and the seats
   are EXACTLY N (exactSeats). Required types are asserted in test/v3-event-defaults.test.mjs.
   =================================================================== */
const EVENT_FAMILY = {
  wedding:'wedding', reception:'wedding', engagement:'wedding', sangeet:'wedding', birthday:'wedding', anniversary:'wedding', gala:'wedding',
  political:'political', rally:'political', 'public meeting':'political', public_meeting:'political',
  corporate:'corporate', product_launch:'corporate', 'product launch':'corporate', conference:'corporate', seminar:'corporate', expo:'corporate',
  concert:'concert', festival:'concert', 'live music':'concert',
};
const EVENT_DEFAULT_REQUIRED = {
  wedding:   ['stage','buffet','redcarpet','dancefloor','dj','floralarch','chandelier','photobooth'],
  political: ['stage','linearray','generator','led','lighting','podium','walkway','brandwall','barricade'],
  corporate: ['stage','linearray','led','lighting','podium','brandwall','desk'],
  concert:   ['stage','dancefloor','walkway','dj','lighting','led','linearray','barricade','generator'],
};
const EVENT_DEFAULT_NAME = { wedding:'Standard wedding setup', political:'Standard rally setup', corporate:'Standard corporate / launch setup', concert:'Standard concert setup' };
function eventFamily(type){ const k=String(type||'').toLowerCase().trim(); return EVENT_FAMILY[k] || EVENT_FAMILY[k.replace(/\s+/g,'_')] || null; }
// V-spread: the zones are laid out against the WHOLE hall — stage centred on the front wall, a seating
// zone from just past the stage/walkway/standing area to ~12% short of the back wall (full width minus
// side aisles), seats at comfortable spacing CENTRED in that zone (never stretched), a centre aisle on
// the walkway line, exits at the back corners (+ a side emergency exit in long halls), generator /
// registration tucked in a back corner beside an exit, wedding buffet + photo booth on the side walls.
function eventDefaultItems(fam, o){
  o=o||{}; const it=[], W=WORLD.w, H=WORLD.h, cx=W/2, N=o.guests!=null?o.guests:0;
  const sc=(v,lo,hi)=>Math.round(clamp(v,lo,hi)*2)/2;
  // place an item so its DRAWN rect (after rotation) starts at rx,ry
  const put=(t, rx, ry, ov)=>{ ov=ov||{}; const a=ASSETS[t], w=ov.width!=null?ov.width:a.w, h=ov.height!=null?ov.height:a.h, rot=ov.rotation||0;
    const q=(((rot%180)+180)%180), sw=(q>45&&q<135)?h:w, sh=(q>45&&q<135)?w:h;
    const m=makeItem(t, rx+sw/2-w/2, ry+sh/2-h/2, ov); it.push(m); return m; };
  const sw=sc(W*0.3,12,60), sh=sc(H*0.14,6,20);
  const ledW=sc(W*0.1,6,20), brand=fam==='political'||fam==='corporate';
  let y=1;
  if(brand){ it.push(makeItem('brandwall', cx-Math.min(sw,ledW*2)/2, y, {width:Math.min(sw,ledW*2), label:'Branding Wall'})); y+=3; }
  if(fam!=='wedding'){ it.push(makeItem('lighting', cx-sw/2, y, {width:sw, label:'Lighting Truss'})); y+=3; }
  else { it.push(makeItem('floralarch', cx-sc(sw*0.4,6,12)/2, y, {width:sc(sw*0.4,6,12), label:'Floral Backdrop'})); y+=4; }
  const sy=y; it.push(makeItem('stage', cx-sw/2, sy, {width:sw, height:sh, label:'Stage', properties:fam==='wedding'?{}:{plain:true}}));   // no flowers on a rally / corporate / concert stage (3D)
  if(fam!=='wedding'){
    it.push(makeItem('podium', cx-1.5, sy+sh*0.6, {label:'Podium'}));
    it.push(makeItem('led', cx-sw/2-ledW-4, sy+1, {width:ledW, label:'LED Screen L'}));
    it.push(makeItem('led', cx+sw/2+4, sy+1, {width:ledW, label:'LED Screen R'}));
    it.push(makeItem('linearray', cx-sw/2-2.5, sy+sh-6, {label:'Sound L'}));
    it.push(makeItem('linearray', cx+sw/2+0.5, sy+sh-6, {label:'Sound R'}));
  }
  let top=sy+sh+2;
  if(fam==='concert'){ it.push(makeItem('dj', cx+sw/2+4, sy+4, {label:'DJ Console'}));
    it.push(makeItem('smoke', cx-sw/2-4, sy+sh-2.5, {label:'Smoke Machine'})); }
  if(fam==='political'||fam==='concert'){
    const wl=sc(H*(fam==='concert'?0.1:0.14),5,30);
    it.push(makeItem('walkway', cx-2, top, {width:4, height:wl, label:fam==='concert'?'Thrust Ramp':'Walkway'}));
    const bw=sc((W-16)/2-6, 4, 40);
    it.push(makeItem('barricade', cx-4-bw, top+1, {width:bw, label:'Barricade L'}));
    it.push(makeItem('barricade', cx+4, top+1, {width:bw, label:'Barricade R'}));
    top+=(fam==='concert'?wl:4)+2;
  }
  if(fam==='concert'){ const dw=sc(W*0.45,10,80), dh=sc(H*0.16,8,40);
    it.push(makeItem('dancefloor', cx-dw/2, top, {width:dw, height:dh, label:'Standing Zone'})); top+=dh+2; }
  if(fam==='wedding'){
    it.push(makeItem('dj', cx+sw/2+3, sy+1, {label:'DJ'}));
    it.push(makeItem('chandelier', cx-sw/2-7, sy+1, {label:'Chandelier'}));
    // dance floor between the stage and the tables, sized to the crowd
    const df=Math.round(clamp(Math.sqrt(Math.max(1,N||80)*2.5), 12, 24)), ds=Math.max(8, Math.min(df, Math.round(W*0.3), Math.round((H-top)*0.3)));
    it.push(makeItem('dancefloor', cx-ds/2, top, {width:ds, height:ds, label:'Dance Floor'})); top+=ds+2;
  }
  // back wall: exits in both back corners; long halls also get a side emergency exit
  const ex=ASSETS.exit;
  put('exit', 1, H-ex.h-1, {label:'Exit'}); put('exit', W-ex.w-1, H-ex.h-1, {label:'Exit'});
  const sideExit=H>150;
  if(sideExit) put('exit', 1, Math.round(H*0.55), {rotation:90, label:'Emergency Exit'});
  // back corner service pieces beside the exits (outside the seating zone)
  if(fam==='political'||fam==='concert'){ const g=ASSETS.generator; put('generator', ex.w+3, H-g.h-1, {label:'Generator'}); }
  if(fam==='corporate'){ const d=ASSETS.desk; put('desk', W-ex.w-3-d.w, H-d.h-1, {label:'Registration'}); }
  // wedding services on the side walls (buffet right, photo booth left), aisle carpet from the back entrance
  const sideM=fam==='wedding' ? 9 : (sideExit?10:8);
  const back=Math.max(9, Math.round(H*0.12));
  const zTop=top+2, zBot=Math.max(zTop+6, H-back), zH=zBot-zTop;
  if(fam==='wedding'){
    const b=ASSETS.buffet; put('buffet', W-b.h-2, clamp(zTop, 2, Math.max(2,H-back-b.w)), {rotation:90, label:'Buffet'});
    const pb=ASSETS.photobooth; put('photobooth', 2, clamp(zTop, 2, Math.max(2,H-ex.h-3-pb.h)), {label:'Photo Booth'});
    put('redcarpet', cx-2, zTop, {width:4, height:Math.max(4,H-1-zTop), label:'Aisle Carpet'});
  }
  const aisle=8, sideW=(W-2*sideM-aisle)/2;          // one side of the centre aisle
  if(fam==='wedding'){
    const T=ASSETS.table.w, spt=8, want=Math.ceil((N||80)/spt), half=Math.ceil(want/2);
    const taken=it.filter(i=>!GEN_OVERLAY.has(i.type)).map(genRect);
    let cells=[];
    for(const [pitch, zb] of [[10, zBot], [8, zBot], [8, H-2]]){   // tiny halls: use the floor between the back exits too
      const zH=zb-zTop, maxC=Math.max(1, Math.floor((sideW-T)/pitch)+1), maxR=Math.max(1, Math.floor((zH-T)/pitch)+1);
      let cols=clamp(Math.ceil(Math.sqrt(half*sideW/Math.max(1,zH))), 1, maxC), rows=Math.ceil(half/cols);
      if(rows>maxR){ cols=maxC; rows=Math.min(maxR, Math.ceil(half/cols)); }
      const bh=(rows-1)*pitch+T, y0=zTop+Math.max(0,(zH-bh)/2), out=[];
      for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) for(const s of [-1,1]){
        const x = s<0 ? cx-aisle/2-T-c*pitch : cx+aisle/2+c*pitch, rr={x, y:y0+r*pitch, w:T, h:T};
        if(rr.x<sideM-1e-6 || rr.x+T>W-sideM+1e-6 || rr.y+T>H-2) continue;
        if(!taken.some(t=>rectsHit(rr,t,1.5))) out.push(rr); }
      if(out.length>cells.length) cells=out;
      if(cells.length>=want) break;
    }
    const n=Math.min(want, cells.length), even=n===want && n>0, base=even?Math.floor((N||80)/n):0, extra=even?(N||80)%n:0;
    let left=N||80;
    cells.slice(0,n).forEach((r,i)=>{ const seats=even ? base+(i<extra?1:0) : Math.min(spt,left); left-=seats;
      it.push(makeItem('table', r.x, r.y, {properties:{seats},label:'T'+(i+1)})); });
  } else {
    // theatre: two blocks either side of the centre aisle, 2.4 ft seats, 3 ft rows when the zone allows
    const P=DESIGN_PITCH, maxC=Math.max(4, Math.floor(sideW/P));
    const half=Math.ceil((N>0?N:Math.round(2*maxC*Math.floor(zH/3)*0.7))/2);
    let cols=clamp(Math.ceil(Math.sqrt(half*(sideW/Math.max(1,zH))*(3/P))), 4, maxC), rows=Math.ceil(half/cols), rp=3;
    if(rows*rp>zH){ cols=maxC; rows=Math.ceil(half/cols); if(rows*3>zH){ rp=P; rows=Math.max(1, Math.min(rows, Math.floor(zH/P))); } }
    const bw=cols*P, bh=rows*rp, by=Math.max(zTop, Math.min(zBot-bh, (zTop+H)/2-bh/2));   // centred on the floor behind the front zone, clear of the back band
    it.push(makeItem('seatblock', cx-aisle/2-bw, by, {width:bw,height:bh,properties:{rows,cols},label:'Left Seating'}));
    it.push(makeItem('seatblock', cx+aisle/2, by, {width:bw,height:bh,properties:{rows,cols},label:'Right Seating'}));
  }
  return it;
}
// the finished default: clamp → no overlaps → exactly N seats; required pieces re-checked by the tests
function buildEventDefault(fam, N){
  const it=eventDefaultItems(fam, {guests:N>0?N:null});
  it.forEach(clampItem); resolveOverlaps(it); if(N>0) exactSeats(it, N);
  return it;
}

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
  const spt=o.spt||8, margin=10;
  // QA-B27: tables = ceil(seats ÷ the form's seats per table). The 9 ft grid used to cap the count silently
  // (420 chairs at 8 → 21 tables of 20 seats); the pitch now tightens to 8 ft (as the
  // banquet rounds do) before giving up any table, and exactSeats never pushes a table past its seats (the rest goes in a block).
  const want = o.tables!=null ? o.tables : (o.guests?Math.ceil(o.guests/spt):null);
  const grid=c=>{ const cols=Math.max(1,Math.floor((WORLD.w-2*margin)/c)), rowsAvail=Math.max(1,Math.floor((bottomY-topY)/c)); return { cell:c, cols, rowsAvail, capacity:cols*rowsAvail }; };
  let g=grid(9); if(want!=null && g.capacity<want) g=grid(8);   // same floor as seatBanquetRounds: never tighter than 8 ft
  const { cell, cols, rowsAvail, capacity } = g;
  let tables = want!=null ? want : Math.min(capacity, Math.round(capacity*0.7));
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
    finish(it,'Custom mix','Your exact selections — drop & edit freely'); }

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
  // V3: the validated event-type default (same set the builder drops in on arrival)
  { const fam = typeof eventFamily==='function' ? eventFamily(o.type) : null;
    if(fam){ const it=eventDefaultItems(fam, o); finish(it, EVENT_DEFAULT_NAME[fam], 'Every standard item for this event type, scaled to the hall'); } }

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
function updateDimsLabel(){ const el=$('#dimsLabel'); if(!el) return;
  // 0096: the floor is the USABLE area; show the venue's full size alongside when it differs
  let vref=''; try{ const c=currentClient||{}; if(+c.venueLen>0 && +c.venueWid>0 && (+c.venueLen!==WORLD.w || +c.venueWid!==WORLD.h)) vref=` · venue ${+c.venueLen} × ${+c.venueWid} ft`; }catch(e){}
  const full = `${WORLD.w} × ${WORLD.h} ft${vref} · ${PX_PER_FT} px/ft${store.venue&&store.venue.setting==='outdoor'?' · outdoor':''}`;
  // compact hall-size chip in the toolbar; the full detail (venue size, scale, outdoor) is in its tooltip
  // the chip follows the active unit (it stayed in ft after switching to metres); the tooltip keeps the exact ft
  const u=store.grid.unit==='m', dU=v=>u ? (Math.round(v/FT_PER_M*10)/10) : v;
  el.textContent = `${dU(WORLD.w)} × ${dU(WORLD.h)} ${u?'m':'ft'}${vref?' usable':''}`; el.title = 'Hall size · '+full; }
function runCustomGenerate(){
  const o=readCustomForm();
  // Enforce Settings capacity ceilings so generation stays fast and honest
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
// Settings value, and resize the floor the moment the hall size is typed.
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
  try{ prefillCustomForm(); wireSizingForm(); renderRecommendations(); }catch(e){}
  // QA-B27: the venue picker re-reads the quote's venue on every open (the wizard's "Classic" button opens this
  // dialog without the #customBtn click the picker listens to, so the linked venue was never pre-selected)
  try{ if(!wasOpen && window.HelmVenuePicker && HelmVenuePicker.where==='builder') HelmVenuePicker.sync(); }catch(e){} }
/* R8: the Custom Event dialog is prefilled from the quote (guests, chairs, tables, hall, type) and
   keeps chairs = 70% of guests / tables = chairs ÷ seats-per-table until the user types their own. */
const CE_TYPE = { wedding:'wedding', reception:'reception', engagement:'wedding', gala:'wedding', cocktail:'wedding', birthday:'wedding',
  concert:'concert', festival:'festival', political:'political', rally:'political',
  conference:'conference', corporate:'product_launch', expo:'conference', product_launch:'product_launch', 'product launch':'product_launch' };
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
  { const fam=eventFamily(PRICING.eventType||o.type);   // V3: the event type's standard set leads the recommendations
    if(fam) recs.unshift({ label:EVENT_DEFAULT_NAME[fam], variant:EVENT_DEFAULT_NAME[fam], opts:{ type:({wedding:'wedding',political:'political',corporate:'product_launch',concert:'concert'})[fam] },
      why:['Includes: '+EVENT_DEFAULT_REQUIRED[fam].map(t=>(ASSETS[t]&&ASSETS[t].label)||t).join(', ')] }); }
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
/* Toolbox sections (2026-10d): what a planner looks for, not the 7 pricing/colour categories. Every ASSETS
   type sits in exactly one section (anything new and unlisted lands in "More"); the item keeps its category
   colour. Generic basics come first so anything not specifically modelled can still be placed. */
const TOOLBOX_SECTIONS = [
  ['Generic basics', ['arch','backdrop','floralstand','decorbox','signage','recttable','chiavari','planter']],
  ['Stage & presentation', ['stage','stageroof','dais','viprisers','walkway','dancefloor','varmala','podium','lectern','micstand','teleprompter','press']],
  ['Screens, sound & effects', ['led','ledscreen','videowall','projector','tvstand','speaker','linearray','subwoofer','monitor','patower','foh','dj','piano','interpreter','smoke','pyro','dancers']],
  ['Lighting', ['uplight','lighting','lightingtree','movinghead','truss','chandelier','fairylights','lanterns','towerlight']],
  ['Seating & tables', ['table','longtable','headtable','cocktail','chairrow','seatblock','bleacher','barstool','sofa','loveseat','couplesofa','armchair','ottoman','bench','coffeetable','lounge','gaddi']],
  ['Florals & mandap', ['mandap','floralarch','floralentrance','entrancegate','stagebackdrop','flowerwall','hangingfloral','floralpillar','aislefloral','centrepiece','floral','phoolchadar','toran','pillar','urli','fountain']],
  ['Wedding functions', ['haldi','mehendi','umbrellas','jhoola','doli','chariot','selfieframe','welcomeboard','photobooth','neonsign']],
  ['Religious & cultural', ['havankund','kalash','altar','rangoli','diyastand','shoerack']],
  ['Balloons, kids & party', ['balloonarch','balloonbunch','kidszone','caketable','dessert','gifttable']],
  ['Food & beverage', ['buffet','livecounter','bar','coffee','chocolatefountain','truck','stall']],
  ['Branding, expo & registration', ['brandwall','hoarding','flagstand','booth','counter','plinth','desk','kiosk','easel','trophytable']],
  ['Crowd, security & safety', ['barricade','stagebarrier','fence','stanchion','checkpoint','watchtower','exit','firstaid','extinguisher','ambulance']],
  ['Venue & logistics', ['tent','canopy','drape','redcarpet','parking','restroom','coatcheck','greenroom','generator','distro','cableramp','heater','aircooler','ticketbooth']],
];
function toolboxSections(){
  const seen=new Set(), out=TOOLBOX_SECTIONS.map(([name,types])=>[name, types.filter(t=>ASSETS[t] && !seen.has(t) && seen.add(t))]);
  const rest=Object.keys(ASSETS).filter(t=>!seen.has(t)); if(rest.length) out.push(['More', rest]);
  return out.filter(([,types])=>types.length);
}
if(typeof window!=='undefined') window.HelmToolboxSections = toolboxSections;
// search words (PRODUCT_META tags) + the toolbox section name ride on each ASSETS entry so the product search
// (builder-tools.js searchAssets) finds every item by what planners type ("kalash", "uplighter", "photo booth")
toolboxSections().forEach(([name,types])=>types.forEach(t=>{ ASSETS[t].section=name; const m=PRODUCT_META[t]; if(m) ASSETS[t].tags=m[1]; }));
/* Toolbox "most used" view (2026-10): new planners see the 20 everyday items first; "Show all tools" reveals the
   rest (remembered per browser). The product search still finds every item (CSS shows rare tiles while searching). */
const COMMON_TOOLS = new Set(['stage','dancefloor','table','longtable','headtable','chairrow','seatblock','buffet','bar','mandap',
  'backdrop','arch','photobooth','dj','speaker','lighting','exit','caketable','sofa','floralstand']);
const TB_ALL_KEY='helm.builder.toolsAll';
function tbAllPref(v){ try{ if(v===undefined) return localStorage.getItem(TB_ALL_KEY)==='1'; localStorage.setItem(TB_ALL_KEY, v?'1':'0'); }catch(e){ return false; } }
function buildToolbox(){
  const host=$('#toolbox');
  while(host.firstChild) host.removeChild(host.firstChild);
  host.classList.toggle('tb-compact', !tbAllPref());
  const mk=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
  const glyphNode=type=>{ const t=document.createElement('template'); t.innerHTML=assetGlyph(type); return t.content; };   // static SVG markup from assetGlyph (no data)
  toolboxSections().forEach(([name,types])=>{
    const sec=mk('div','cat'), h=mk('h3'), dot=mk('span','dot'), first=ASSETS[types[0]];
    if(!types.some(t=>COMMON_TOOLS.has(t))) sec.classList.add('tb-rare');
    dot.style.background=catColor(first.category); h.append(dot, document.createTextNode(name)); sec.appendChild(h);
    const grid=mk('div','tools'); sec.appendChild(grid);
    types.flatMap(type=>type==='exit'?[[type,'Entrance'],[type,null]]:[[type,null]]).forEach(([type,vl])=>{
      const a=ASSETS[type], t=mk('div','tool'), lbl=vl||a.label;
      t.draggable=true; t.setAttribute('role','button'); t.tabIndex=RO?-1:0; if(RO) t.setAttribute('aria-disabled','true');
      if(!COMMON_TOOLS.has(type)) t.classList.add('tb-rare');
      t.dataset.type=type; if(vl) t.dataset.label=vl; t.setAttribute('aria-label','Add '+lbl); t.title=lbl;
      t.style.color=catColor(a.category);
      t.appendChild(glyphNode(vl?'entrance':type)); const sp=mk('span',null,lbl); sp.style.color='var(--ink)'; t.appendChild(sp);
      grid.appendChild(t); });
    host.appendChild(sec);
  });
  const more=mk('button','tbtn tb-more'); more.type='button';
  const paintMore=()=>{ const c=host.classList.contains('tb-compact'); more.textContent=c?'Show all tools':'Show most used only'; more.setAttribute('aria-expanded', String(!c)); };
  more.addEventListener('click',()=>{ host.classList.toggle('tb-compact'); tbAllPref(!host.classList.contains('tb-compact')); paintMore(); });
  paintMore(); host.appendChild(more);
  host.querySelectorAll('.tool').forEach(t=>{
    t.addEventListener('click',()=>{
      const ty=t.dataset.type;
      if(ty==='seatblock'||ty==='chairrow') openArrangeModal('chairs');   // pick a chair grid
      else if(ty==='table') openArrangeModal('tables');                   // pick a table grid + shape
      else addAsset(ty, null, t.dataset.label ? {label:t.dataset.label} : undefined);
      closeDrawers();
    });
    // keyboard: Enter / Space drops the asset at the centre of the visible canvas (same path as a drop)
    t.addEventListener('keydown',e=>{
      if(e.key!=='Enter' && e.key!==' ') return;
      e.preventDefault();
      if(RO) return;
      const ty=t.dataset.type; if(!ASSETS[ty]) return;
      addAsset(ty, null, t.dataset.label ? {label:t.dataset.label} : undefined);
      closeDrawers(true);
    });
    t.addEventListener('dragstart',e=>{ e.dataTransfer.setData('type',t.dataset.type); e.dataTransfer.setData('label',t.dataset.label||''); e.dataTransfer.effectAllowed='copy'; });
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
    case 'entrance': return wrap('<rect x="4" y="4" width="18" height="12" rx="1"/><path d="M17 10h-6M13 7l-3 3 3 3"/>');
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
    case 'linearray': return wrap('<path d="M9 3h8l-1 3H10zM10 6.5h6l-1 3h-4zM11 10h4l-.5 3h-3zM11.5 13.5h3l-.3 3h-2.4z"/>');
    case 'lighting': return wrap('<path d="M3 5h20M3 8h20M3 5l3 3 3-3 3 3 3-3 3 3 3-3 2 2"/><path d="M7 8v3M13 8v3M19 8v3"/><circle cx="7" cy="13" r="1.6"/><circle cx="13" cy="13" r="1.6"/><circle cx="19" cy="13" r="1.6"/>');
    case 'led': return wrap('<rect x="3" y="4" width="20" height="11" rx="1"/><path d="M8 4v11M13 4v11M18 4v11M3 9.5h20M10 18h6M13 15v3"/>');
    case 'chocolatefountain': return wrap('<path d="M7 17h12M9 17l1-4h6l1 4M11 13l1-4h2l1 4M12.5 9V5"/><circle cx="13" cy="4" r="1"/>');
    case 'chariot': return wrap('<path d="M5 12h14l2-5h-4M5 12l-1-4h5"/><circle cx="8" cy="15" r="2.4"/><circle cx="17" cy="15" r="2.4"/>');
    case 'smoke': return wrap('<rect x="3" y="10" width="10" height="6" rx="1"/><path d="M13 12h2M16 11c2-1 2-3 4-3M16 14c2 0 3-2 5-1"/>');
    case 'dancers': return wrap('<circle cx="8" cy="5" r="1.6"/><circle cx="18" cy="5" r="1.6"/><path d="M8 7v5l-2 5M8 12l2 5M5 9l3-1 3 2M18 7v5l-2 5M18 12l2 5M15 10l3-2 3 1"/>');
    case 'walkway': return wrap('<path d="M9 3h8l3 14H6z"/><path d="M13 5v2M13 9v2M13 13v2"/>');
    case 'brandwall': return wrap('<rect x="3" y="5" width="20" height="9" rx="1"/><path d="M7 9h12M9 11.5h8M6 14v3M20 14v3"/>');
    case 'generator': return wrap('<rect x="3" y="6" width="20" height="10" rx="1"/><path d="M14 8l-3 4h4l-3 4"/><path d="M6 6V4"/>');
    case 'entrancegate': return wrap('<rect x="3" y="5" width="4" height="12"/><rect x="19" y="5" width="4" height="12"/><path d="M3 5c3-3 17-3 20 0M9 7v3M13 7v4M17 7v3"/>');
    case 'phoolchadar': return wrap('<path d="M4 6h18M5 6v11M21 6v11"/><path d="M5 8c3 2 13 2 16 0"/><circle cx="9" cy="10" r="1"/><circle cx="13" cy="10.5" r="1"/><circle cx="17" cy="10" r="1"/>');
    case 'jhoola': return wrap('<path d="M3 17L6 3h14l3 14M9 3v9M17 3v9"/><rect x="8" y="12" width="10" height="2.5" rx="1"/>');
    case 'haldi': return wrap('<rect x="3" y="3" width="20" height="5" rx="1"/><path d="M6 8v4M10 8v5M14 8v4M18 8v5"/><path d="M5 17h16"/><circle cx="8" cy="15" r="1.4"/><circle cx="18" cy="15" r="1.4"/>');
    case 'mehendi': return wrap('<path d="M5 9l4-5 4 5zM13 9l4-5 4 5z"/><path d="M9 9v6M17 9v6M3 17h20"/>');
    case 'selfieframe': return wrap('<rect x="5" y="3" width="16" height="13" rx="1"/><circle cx="7" cy="5" r="1.4"/><circle cx="19" cy="14" r="1.4"/><path d="M7 16v2M19 16v2"/>');
    case 'welcomeboard': return wrap('<rect x="7" y="3" width="12" height="10" rx="1"/><path d="M10 7h6M10 9.5h6M9 13l-2 5M17 13l2 5"/>');
    case 'fairylights': return wrap('<path d="M3 4h20M3 4c3 4 7 4 10 0c3 4 7 4 10 0"/><circle cx="6" cy="7" r=".9"/><circle cx="10" cy="7" r=".9"/><circle cx="16" cy="7" r=".9"/><circle cx="20" cy="7" r=".9"/><path d="M5 4v13M21 4v13"/>');
    case 'couplesofa': return wrap('<path d="M5 15V9c0-4 16-4 16 0v6"/><path d="M3 15h20v2H3zM13 7v8"/>');
    case 'livecounter': return wrap('<rect x="4" y="10" width="18" height="6" rx="1"/><path d="M4 4h18M5 4v6M21 4v6"/><ellipse cx="10" cy="10" rx="3" ry="1"/>');
    case 'kidszone': return wrap('<path d="M4 17V9l3-3 3 3v8M4 17h18M14 7l7 10"/><circle cx="17" cy="15" r="1.2"/>');
    case 'aircooler': return wrap('<rect x="7" y="3" width="12" height="14" rx="2"/><circle cx="13" cy="9" r="3.5"/><path d="M13 9l2-1.5M13 9l-1 2.5"/>');
    case 'floralentrance': return wrap('<path d="M4 17V8a9 5 0 0 1 18 0v9"/><circle cx="4" cy="9" r="1.3"/><circle cx="7" cy="5" r="1.3"/><circle cx="13" cy="3.5" r="1.3"/><circle cx="19" cy="5" r="1.3"/><circle cx="22" cy="9" r="1.3"/>');
    case 'stagebackdrop': return wrap('<rect x="3" y="3" width="20" height="11" rx="1"/><circle cx="6" cy="6" r="1.4"/><circle cx="20" cy="6" r="1.4"/><circle cx="8" cy="11" r="1.2"/><circle cx="18" cy="11" r="1.2"/><path d="M2 17h22"/>');
    case 'flowerwall': return wrap('<rect x="5" y="2" width="16" height="15" rx="1"/><circle cx="9" cy="6" r="1.5"/><circle cx="14" cy="6" r="1.5"/><circle cx="18" cy="9" r="1.5"/><circle cx="10" cy="11" r="1.5"/><circle cx="15" cy="13" r="1.5"/>');
    case 'toran': return wrap('<path d="M3 4h20"/><path d="M3 4c3 4 6 4 10 0c3 4 7 4 10 0"/><path d="M6 6v5M10 7v7M13 4v8M16 7v7M20 6v5"/>');
    case 'floralpillar': return wrap('<rect x="10" y="7" width="6" height="10" rx="1"/><circle cx="11" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="13" cy="3" r="1.6"/><path d="M8 17h10"/>');
    case 'aislefloral': return wrap('<path d="M13 8v9M10 17h6"/><circle cx="13" cy="5" r="2.2"/><circle cx="10" cy="7" r="1.4"/><circle cx="16" cy="7" r="1.4"/>');
    case 'centrepiece': return wrap('<path d="M13 9v6M9 17h8M11 15h4"/><circle cx="13" cy="5" r="2"/><circle cx="9.5" cy="6.5" r="1.6"/><circle cx="16.5" cy="6.5" r="1.6"/>');
    case 'balloonarch': return wrap('<path d="M4 17C4 6 22 6 22 17"/><circle cx="5" cy="13" r="1.8"/><circle cx="8" cy="8" r="1.8"/><circle cx="13" cy="6" r="1.8"/><circle cx="18" cy="8" r="1.8"/><circle cx="21" cy="13" r="1.8"/>');
    case 'balloonbunch': return wrap('<ellipse cx="10" cy="6" rx="2.6" ry="3.2"/><ellipse cx="16" cy="6" rx="2.6" ry="3.2"/><ellipse cx="13" cy="9" rx="2.6" ry="3.2"/><path d="M10 9l3 8M16 9l-3 8M13 12v5"/>');
    case 'lectern': return wrap('<path d="M7 5h12l-2 3H9z"/><path d="M10 8l-1 9h8l-1-9"/><path d="M15 5l2-3"/>');
    case 'dais': return wrap('<rect x="2" y="12" width="22" height="5" rx="1"/><rect x="5" y="9" width="16" height="2.5"/><path d="M7 9V5M11 9V5M15 9V5M19 9V5"/>');
    case 'flagstand': return wrap('<path d="M10 18V2"/><path d="M10 3h10l-2 3 2 3H10"/><path d="M7 18h6"/>');
    case 'hoarding': return wrap('<rect x="3" y="3" width="20" height="9"/><path d="M6 12v6M20 12v6M3 18h20M8 12l-2 6M18 12l2 6"/>');
    case 'patower': return wrap('<path d="M7 18L9 2h8l2 16M8 10h10"/><rect x="10" y="3" width="6" height="4" rx=".5"/><rect x="10" y="11" width="6" height="4" rx=".5"/>');
    case 'lightingtree': return wrap('<path d="M13 4v10M13 14l-5 4M13 14l5 4M13 14v4"/><path d="M6 4h14"/><path d="M7 4v2M11 4v2M15 4v2M19 4v2"/><circle cx="7" cy="7" r="1"/><circle cx="11" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="19" cy="7" r="1"/>');
    case 'diyastand': return wrap('<path d="M13 6v11M9 17h8M10 8h6M11 12h4"/><path d="M13 2c1 1.5 1 2.5 0 3.5c-1-1-1-2 0-3.5z"/>');
    case 'havankund': return wrap('<rect x="5" y="9" width="16" height="8"/><path d="M13 3c-2 2-2 4 0 6 2-2 2-4 0-6z"/>');
    case 'rangoli': return wrap('<circle cx="13" cy="10" r="7"/><circle cx="13" cy="10" r="3"/><path d="M13 3v14M6 10h14"/>');
    case 'lanterns': return wrap('<rect x="5" y="6" width="6" height="9" rx="1"/><rect x="14" y="4" width="7" height="11" rx="1"/><path d="M8 3v3M17.5 1v3"/>');
    case 'hangingfloral': return wrap('<path d="M3 3h20M7 3v6M13 3v9M19 3v5"/><circle cx="7" cy="11" r="2"/><circle cx="13" cy="14" r="2"/><circle cx="19" cy="10" r="2"/>');
    case 'neonsign': return wrap('<rect x="3" y="4" width="20" height="12" rx="2"/><path d="M7 12c2-4 3-4 4 0s2 4 4 0 3-4 4 0"/>');
    case 'backdrop': return wrap('<rect x="3" y="3" width="20" height="12" rx="1"/><path d="M6 15v3M20 15v3"/>');
    case 'floralstand': return wrap('<circle cx="13" cy="6" r="3.5"/><path d="M13 9.5V17M10 17h6"/>');
    case 'decorbox': return wrap('<path d="M5 7l8-4 8 4v8l-8 4-8-4z"/><path d="M5 7l8 4 8-4M13 11v8"/>');
    case 'signage': return wrap('<rect x="8" y="2" width="10" height="13" rx="1"/><path d="M13 15v3M9 18h8"/>');
    case 'recttable': return wrap('<rect x="4" y="6" width="18" height="6" rx="1"/><circle cx="8" cy="15" r="1.2"/><circle cx="13" cy="15" r="1.2"/><circle cx="18" cy="15" r="1.2"/>');
    case 'stageroof': return wrap('<path d="M3 6h20M4 6v11M22 6v11M3 6l5-3h10l5 3"/><rect x="6" y="12" width="14" height="5"/>');
    case 'varmala': return wrap('<ellipse cx="13" cy="13" rx="9" ry="4"/><path d="M9 9c2 3 6 3 8 0"/>');
    case 'micstand': return wrap('<circle cx="13" cy="4" r="2"/><path d="M13 6v10M9 17h8"/>');
    case 'teleprompter': return wrap('<path d="M6 16l3-8h8l3 8z"/><path d="M10 11h6"/>');
    case 'projector': return wrap('<rect x="3" y="3" width="20" height="11"/><path d="M5 14l-1 4M21 14l1 4"/>');
    case 'tvstand': return wrap('<rect x="5" y="3" width="16" height="10" rx="1"/><path d="M13 13v4M9 17h8"/>');
    case 'interpreter': return wrap('<rect x="5" y="4" width="16" height="12" rx="1"/><path d="M9 8h8"/><circle cx="13" cy="12" r="1.5"/>');
    case 'pyro': return wrap('<path d="M10 17h6l-1-3h-4z"/><path d="M13 13V4M10 6l3-3 3 3M8 9l2 2M18 9l-2 2"/>');
    case 'towerlight': return wrap('<path d="M13 5v12M9 17h8"/><rect x="8" y="2" width="10" height="4"/>');
    case 'gaddi': return wrap('<rect x="3" y="5" width="20" height="10" rx="2"/><path d="M3 9h20"/><circle cx="7" cy="7" r="1"/><circle cx="19" cy="7" r="1"/>');
    case 'urli': return wrap('<path d="M4 10h18a9 6 0 0 1-18 0z"/><circle cx="10" cy="9" r="1.3"/><circle cx="16" cy="9" r="1.3"/>');
    case 'umbrellas': return wrap('<path d="M4 9a9 6 0 0 1 18 0z"/><path d="M13 9v8a2 2 0 0 1-3 0"/>');
    case 'doli': return wrap('<rect x="8" y="6" width="10" height="9" rx="1"/><path d="M8 6l5-3 5 3M2 11h22"/>');
    case 'kalash': return wrap('<path d="M9 9h8l1 4-3 4h-4l-3-4z"/><circle cx="13" cy="6" r="2.5"/><path d="M9 7l-2-2M17 7l2-2"/>');
    case 'altar': return wrap('<rect x="5" y="9" width="16" height="8"/><rect x="9" y="3" width="8" height="6" rx="1"/>');
    case 'shoerack': return wrap('<rect x="4" y="5" width="18" height="11"/><path d="M4 9h18M4 13h18"/>');
    case 'dessert': return wrap('<rect x="3" y="12" width="20" height="5" rx="1"/><path d="M7 12V9h4v3M15 12V6h4v6"/>');
    case 'coffee': return wrap('<rect x="3" y="12" width="20" height="5" rx="1"/><rect x="7" y="5" width="5" height="7" rx="1"/><path d="M16 9h3v3h-3z"/>');
    case 'stall': return wrap('<path d="M3 8h20l-2-4H5z"/><path d="M5 8v9M21 8v9M5 12h16"/>');
    case 'counter': return wrap('<rect x="5" y="7" width="16" height="9" rx="1"/><path d="M5 10h16"/>');
    case 'plinth': return wrap('<rect x="9" y="7" width="8" height="10"/><path d="M8 7h10M11 4h4v3h-4z"/>');
    case 'kiosk': return wrap('<rect x="9" y="3" width="8" height="8" rx="1"/><path d="M13 11v6M10 17h6"/>');
    case 'ticketbooth': return wrap('<rect x="5" y="5" width="16" height="12" rx="1"/><path d="M5 5l8-3 8 3M9 10h8"/>');
    case 'stanchion': return wrap('<path d="M5 6v11M21 6v11M5 8q8 5 16 0"/><path d="M3 17h4M19 17h4"/>');
    case 'watchtower': return wrap('<path d="M8 17l2-10h6l2 10M9 12h8"/><rect x="8" y="3" width="10" height="4"/>');
    case 'extinguisher': return wrap('<rect x="10" y="6" width="6" height="11" rx="2"/><path d="M13 6V3h3"/>');
    case 'ambulance': return wrap('<rect x="3" y="6" width="15" height="9" rx="1"/><path d="M18 9h3l2 3v3h-5z"/><path d="M10 8v5M7.5 10.5h5"/><circle cx="8" cy="16" r="1.5"/><circle cx="19" cy="16" r="1.5"/>');
    case 'trophytable': return wrap('<rect x="3" y="12" width="20" height="5" rx="1"/><path d="M9 4h6v3a3 3 0 0 1-6 0zM12 10v2M10 12h4"/>');
    default: return toolIcon();
  }
}

/* drag-drop from toolbox onto canvas */
scrollEl.addEventListener('dragover',e=>{ e.preventDefault(); e.dataTransfer.dropEffect='copy'; });
scrollEl.addEventListener('drop',e=>{
  e.preventDefault();
  if(RO) return;
  const type=e.dataTransfer.getData('type'); if(!type||!ASSETS[type])return;
  const vl=e.dataTransfer.getData('label'); addAsset(type, svgPointFt(e), vl ? {label:vl} : undefined);
});

/* ===================================================================
   VIEW: zoom / fit / pan-center
   =================================================================== */
// r22: where the floor starts inside the scroll area's content (it is centred while smaller than the plan area)
function svgOff(){
  try{ const a=svg.getBoundingClientRect(), b=scrollEl.getBoundingClientRect();
    return { x:a.left-b.left-scrollEl.clientLeft+scrollEl.scrollLeft, y:a.top-b.top-scrollEl.clientTop+scrollEl.scrollTop }; }
  catch(_){ return {x:0,y:0}; }
}
function viewCenterFt(){
  const o=svgOff();
  const cx=(scrollEl.scrollLeft-o.x+scrollEl.clientWidth/2)/(PX_PER_FT*store.view.zoom);
  const cy=(scrollEl.scrollTop-o.y+scrollEl.clientHeight/2)/(PX_PER_FT*store.view.zoom);
  return {x:clamp(cx,0,WORLD.w), y:clamp(cy,0,WORLD.h)};
}
let viewAtFit=true;   // still showing the "fit" zoom (no manual zoom since the last fit)
function setZoom(z, anchor){
  viewAtFit=false;
  const old=store.view.zoom;
  z=clamp(z,ZOOM_MIN,3);
  const a=anchor||{x:scrollEl.scrollLeft+scrollEl.clientWidth/2, y:scrollEl.scrollTop+scrollEl.clientHeight/2};
  const o0=svgOff(), fx=(a.x-o0.x)/old, fy=(a.y-o0.y)/old;   // in base-px world coords (r22: minus the centring offset)
  store.view.zoom=z;
  sizeCanvas();
  const o1=svgOff();
  scrollEl.scrollLeft=fx*z+o1.x-(anchor?anchor.sx:scrollEl.clientWidth/2);
  scrollEl.scrollTop =fy*z+o1.y-(anchor?anchor.sy:scrollEl.clientHeight/2);
  $('#zoomLbl').textContent=Math.round(z*100)+'%';
  renderRulers();
}
function fitView(){
  const pad=40;
  const zx=(scrollEl.clientWidth-pad)/(WORLD.w*PX_PER_FT);
  const zy=(scrollEl.clientHeight-pad)/(WORLD.h*PX_PER_FT);
  store.view.zoom=clamp(Math.min(zx,zy),ZOOM_MIN,3);
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
/* r19: the view controls sit in a dock under the plan. The pan arrows open on demand (✥) and the dock folds away
   to one "⊕ View" button; both choices are remembered per browser (a convenience only - storage may be off). */
(function wireViewDock(){
  const vp=document.querySelector('.viewport'), pad=$('#navPad'), tgl=$('#navPadToggle'), hide=$('#dockHide'), show=$('#dockShow');
  if(!vp || !pad || !tgl || !hide || !show) return;
  const KEY='bps.viewDock';
  let st={}; try{ st=JSON.parse(localStorage.getItem(KEY)||'{}')||{}; }catch(_){ st={}; }
  const keep=()=>{ try{ localStorage.setItem(KEY, JSON.stringify({pad:!!st.pad, min:!!st.min})); }catch(_){} };
  const refit=()=>{ try{ window.dispatchEvent(new Event('resize')); }catch(_){} try{ if(viewAtFit && !is3DActive()) fitView(); }catch(_){} };
  function setPad(on){ st.pad=!!on; pad.hidden=!on; tgl.setAttribute('aria-expanded', String(!!on));
    tgl.setAttribute('aria-label', on?'Hide the pan arrows':'Show the pan arrows'); }
  function setMin(on, focus){ st.min=!!on; vp.classList.toggle('dock-min', !!on); refit();
    if(focus){ try{ (on?show:hide).focus({preventScroll:true}); }catch(_){} } }
  tgl.addEventListener('click',()=>{ setPad(pad.hidden); keep(); });
  hide.addEventListener('click',()=>{ setMin(true, true); keep(); });
  show.addEventListener('click',()=>{ setMin(false, true); keep(); });
  ['pointerdown','mousedown','touchstart','dblclick','wheel'].forEach(t=>[tgl,hide,show].forEach(b=>b.addEventListener(t,e=>e.stopPropagation(),{passive:true})));
  setPad(!!st.pad); setMin(!!st.min, false);
})();

// in 3D the same buttons drive the 3D camera (smooth dolly / fit) instead of the hidden 2D canvas
const in3D=()=>!!(window.__helm3D && window.__helm3D.isActive && window.__helm3D.isActive() && window.__zoom3D);
$('#zoomIn').addEventListener('click',()=>{ if(in3D()) window.__zoom3D(1/1.25); else setZoom(store.view.zoom*1.2); });
$('#zoomOut').addEventListener('click',()=>{ if(in3D()) window.__zoom3D(1.25); else setZoom(store.view.zoom/1.2); });
$('#zoomFit').addEventListener('click',()=>{ if(in3D()) window.__zoom3D('fit'); else fitView(); });
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
  if(store.items.length && !window.__refSkipConfirm && !(await BPUI.confirm('Load the layout from "'+label+'" onto the canvas? This replaces the current objects (you can Undo).',{title:'Replace the floor?',okLabel:'Load layout'}))){ e.target.value=''; return; }
  try{
    const q=await BPStore.quotes.get(qid);
    const ver=await BPStore.quotes.getVersion(qid, q.currentVersion);
    const items=(ver && ver.data && ver.data.items)||[];
    if(!items.length){ toast('That event has no saved layout.'); e.target.value=''; return; }
    const lfSz=window.HelmLoadFit && window.HelmLoadFit.size(ver.data);
    const fitChoice=await lfAsk(lfSz); if(fitChoice==='cancel'){ e.target.value=''; return; }
    if(fitChoice==='size') lfUseSize(lfSz);
    const lfBefore=fitChoice==='fit' ? JSON.parse(JSON.stringify(items)) : null;
    loadItems(stripStalePrices(items), 'Ref: '+(q.code||'past event'));
    if(lfBefore) lfNote(lfBefore, {clamp:true});
    toast('Loaded layout from '+(q.code||'past event')+' · Prices updated to current rates');
  }catch(err){ toast('Could not load that layout'); }
  e.target.value='';
});
function setUnit(u){
  store.grid.unit = (u==='m') ? 'm' : 'ft';     // allowlisted
  store.grid.sizeFt=cellFt();
  $('#cornerUnit').textContent=uLabel();
  if(typeof updateDimsLabel==='function') updateDimsLabel();
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
(function wireHidePrice(){ const c=document.getElementById('hidePriceChk'); if(!c) return;
  c.addEventListener('change',()=>{ setPriceDisplay({ hidden: c.checked }); renderPrice(); });
})();
const GRID_PREF_KEY='helm.builder.gridPref';
function saveGridPref(){ try{ localStorage.setItem(GRID_PREF_KEY, JSON.stringify({snap:!!store.grid.snap, show:!!store.grid.show})); }catch(_){} }
function readGridPref(){ try{ const g=JSON.parse(localStorage.getItem(GRID_PREF_KEY)||'null'); return g&&typeof g==='object'?g:null; }catch(_){ return null; } }
(function(){ const g=readGridPref(); if(g){ if(typeof g.snap==='boolean') store.grid.snap=g.snap; if(typeof g.show==='boolean') store.grid.show=g.show; $('#snapBtn').classList.toggle('on',store.grid.snap); $('#gridBtn').classList.toggle('on',store.grid.show); } })();
$('#snapBtn').addEventListener('click',()=>{ store.grid.snap=!store.grid.snap; $('#snapBtn').classList.toggle('on',store.grid.snap); saveGridPref(); if(window.__on3DSnapChange) window.__on3DSnapChange(); });
$('#gridBtn').addEventListener('click',()=>{ store.grid.show=!store.grid.show; $('#gridBtn').classList.toggle('on',store.grid.show); saveGridPref(); renderAll(); if(window.__on3DGridChange) window.__on3DGridChange(); });
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
  // r20: H = home (the dashboard), the same key as the app pages. Never while typing (inputs, selects, text areas,
  // editable text), with a modifier key or during the 3D walkthrough. Unsaved changes still ask first (beforeunload).
  if((e.key==='h'||e.key==='H') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing && !e.repeat){
    const t=e.target||document.activeElement, ae=document.activeElement;
    const isTyping=n=>!!(n && ((n.tagName && /INPUT|SELECT|TEXTAREA/.test(n.tagName)) || n.isContentEditable));
    if(!isTyping(t) && !isTyping(ae) && !document.body.classList.contains('wt-on')){ e.preventDefault(); location.href='/dashboard.html'; return; }
  }
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
  // studio-templates.js template edit (?tplEdit=<id>): "loading" shows the loading state, "edit"/"error" never the blank-floor prompt
  const tpl=window.__helmTplEdit, tplMode=tpl&&tpl.mode, tplLoading=tplMode==='loading';
  es.hidden = layoutLoading || tplLoading || tplMode==='edit' || tplMode==='error' || RO || threeD || (store.items && store.items.length>0);
  const ld=$('#layoutLoading'); if(ld) ld.hidden = !(layoutLoading || (tplLoading && !threeD));
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
    ...(store.priceDisplay ? { priceDisplay: priceDisp() } : {}),     // hide-price mode travels with the layout
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
  if(data.priceDisplay && typeof data.priceDisplay==='object') store.priceDisplay = priceDisp(data.priceDisplay);
  if(data.grid){ const keep={snap:store.grid.snap, show:store.grid.show};
    // snap / grid are the PLANNER's tool toggles, not part of the plan: an opened layout (saved with Snap off,
    // or an old file) used to switch Snap off silently — "snap works sometimes". Only the unit comes from the file.
    store.grid = Object.assign(sanitizeGrid(data.grid), keep); syncGridUI(); if(window.__on3DSnapChange) window.__on3DSnapChange(); if(window.__on3DGridChange) window.__on3DGridChange(); }
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
  saving=true; renderSaveState('saving');
  const sig = docSig();                        // edits made while this save is in flight keep the page dirty
  const sentKey = canvasKey();                 // r19 L2: the content this save writes
  const name = ($('#projName').value || 'Untitled event').trim().slice(0,120);
  const data = serialize();
  const btn=$('#saveBtn'); if(btn){ btn.disabled=true; if(silent) btn.textContent='⏳ Saving…'; }
  try{
    if(currentQuoteId){
      // primary flow: every save is a new VERSION of the open quote
      const fromNo = currentVersionNo, fromOlder = isViewingOlder();
      const label = (opts && opts.label) || (fromOlder ? 'Based on V'+fromNo : null);
      if(currentQuoteGuard.closed){ if(!silent) await BPUI.alert('This event is closed, so its layout can’t be changed.',{title:'Event closed'}); return false; }
      // R112: a sent / approved quote: a silent (auto) save never writes; an explicit save stores the layout version and
      // then asks before the quote's price changes (syncQuotePricingNow interactive) - never re-priced silently
      if((currentQuoteGuard.sent || currentQuoteGuard.approved) && silent) return false;
      if(name) { try{ await BPStore.quotes.updateMeta(currentQuoteId, { title:name }); }catch{} }
      const v = await BPStore.quotes.addVersion(currentQuoteId, label, data, store.items.length);
      currentVersionNo = v.version_no || v.versionNo;
      noteStoredVersion(sentKey);              // r19 L2: the server now holds exactly this content
      noteSavedVersion(v, label);
      refreshVersionsSoon(true);                // re-read the server list (names, teammates' saves)
      clearDraft();
      updateQuoteBadge();
      // keep the stored quote total in step with the layout; R112: a sent / approved quote asks first (never silent)
      if(!silent && (currentQuoteGuard.sent || currentQuoteGuard.approved || _repricePending)){ if(!(opts && opts.noReprice)) await syncQuotePricingNow({ interactive:true }); }
      else syncQuotePricing();
      setTimeout(()=>{ autoCaptureIfStale(); }, 400);   // R2: keep the client booklet images in step
      if(silent){ if(btn){ btn.textContent='✓ v'+currentVersionNo; clearTimeout(saveBtnT); saveBtnT=setTimeout(()=>{ btn.innerHTML='💾 Save'; },1500); } }
      else toast(fromOlder ? 'Saved as V'+currentVersionNo+' (new latest) — V'+fromNo+' is unchanged' : 'Saved V'+currentVersionNo);
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
    saveUi='saved';
    setSavedBaseline(sig);
    return true;
  }catch(e){ if(btn) btn.innerHTML='💾 Save'; saveUi='error'; renderSaveState('error');
    if(!silent) BPUI.toast(BPUI.friendlyError(e,{action:'save the layout'}),{type:'err'});
    else toast('Autosave failed — press Save to retry');
    return false; }
  finally{ saving=false; if(btn) btn.disabled=false; if(saveUi==='saving'){ saveUi='dirty'; renderSaveState(); } }
}
function updateQuoteBadge(){
  { const cb=document.getElementById('clientImgBtn'); if(cb){ cb.hidden=!clientImagesSupported(); syncClientImgTrial(); } }
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
  // QA-B27: the save time in the STUDIO's time zone + locale (BPStore.fmtStudioDate), never the viewer's browser clock
  if(v.createdAt){ const d=new Date(v.createdAt); if(!isNaN(d)){ const f={day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'};
    let t=''; try{ if(typeof BPStore!=='undefined' && BPStore.fmtStudioDate) t=BPStore.fmtStudioDate(v.createdAt,{fmt:f}); }catch(e){ t=''; }
    parts.push(t || d.toLocaleString(undefined,f)); } }
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
  drawOrder2D(items, {w, h}).forEach(it=>{
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
  noteStoredVersion();                     // r19 L2: this version is what the server holds
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
  chip.hidden=true; return;   // Design studio hidden for now (owner, 2026-10-11) - remove this line to bring the chip back
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
        <small>${esc(l.objectCount)} objects · ${l.updatedAt?esc(BPStore.fmtDateTime(l.updatedAt)):'—'}</small></div>
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
      const lfSz=window.HelmLoadFit && full.data && window.HelmLoadFit.size(full.data);
      const fitChoice=await lfAsk(lfSz); if(fitChoice==='cancel') return;
      let openData=full.data;
      if(fitChoice==='fit' || fitChoice==='size'){   // keep (fit) or set (size, capped) the hall instead of the saved one
        if(fitChoice==='size') lfUseSize(lfSz);
        const room={w:WORLD.w,h:WORLD.h};
        openData={ ...full.data, scale:{ ...(full.data.scale||{}), worldFt:room }, venue:{ ...(full.data.venue||{}), room } };
      }
      applyLayout(openData); currentLayoutId=id;
      if(fitChoice==='fit') lfNote(full.data.items, {clamp:true});
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
  setSelection([]); if(o.clean){ store.grid.show=false; showMeasure=!!o.measure; } renderAll();  // hide handles (0095: o.measure keeps the measurement overlay)
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
  if(o.clean) clone.querySelectorAll(o.measure ? '.margins' : '.margins,.measure').forEach(n=>n.remove());
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

/* ---- 0095: photo-realistic render bridge (photo-render-ui.js) ----
   Read-only view of what the photo dialog needs; the image model runs server-side only. */
window.__helmPhotoCtx = function(){
  return {
    quoteId: currentQuoteId, readOnly: !!RO, frozen: !!(currentQuoteGuard && currentQuoteGuard.frozen),
    supported: clientImagesSupported(), items: store.items.slice(), world: { w: WORLD.w, h: WORLD.h },
    eventType: PRICING.eventType || '', guests: PRICING.guests, setting: (store.venue && store.venue.setting) || 'indoor',
    country: PRICING.taxCountry || '', eventDate: PRICING.eventDate || '', title: ($('#projName') && $('#projName').value) || '',
    // render context (data only; never shown as text in the photo)
    client: currentClient || {}, menuPackage: PRICING.menuPackageName || '', venueSettingSet: !!(store.venue && store.venue.setting),
    planBlob: (o) => planBlob(o),
    // the builder tab can be older than the flow's last save: re-read the quote's event type / date / guests
    refreshMeta: async () => {
      if(!currentQuoteId || !BPStore.quotes || !BPStore.quotes.get) return null;
      const q=await BPStore.quotes.get(currentQuoteId); if(!q) return null;
      PRICING.eventType = q.eventType || null; PRICING.eventDate = q.eventDate || PRICING.eventDate || null;
      const c=window.__helmPhotoCtx(); c.client = Object.assign({}, currentClient || {}, q.client || {});   // read-only copy; never written back
      if(c.guests==null && c.client.guests!=null) c.guests = +c.client.guests;
      return c;
    },
  };
};
/* ---- R2 + 0083: client booklet images (real 2D plan + 3D render) ----
   Each picture in two styles: 'labels' (numbered badges + legend, the approved look) and
   'plain' (the model without labels). Stored IN THE DATABASE via BPStore.booklet.putImage
   (JPEG ~0.85, <= 1600 px wide); the booklet link shows the newest ones. */
// r20: "Client images" is a paid-plan feature: hidden in the free trial (builder.css), with the tooltip / click guard as a fallback
function builderInTrial(){ try{ if(window.HelmTrialLock && HelmTrialLock.isTrial && HelmTrialLock.isTrial()) return true; return document.documentElement.classList.contains('helm-trial'); }catch(_){ return false; } }
function syncClientImgTrial(){
  const cb=document.getElementById('clientImgBtn'); if(!cb) return;
  if(!cb.dataset.paidTitle) cb.dataset.paidTitle=cb.title||'';
  const off=builderInTrial();
  if(off){ cb.setAttribute('aria-disabled','true'); cb.title='Available on a paid plan'; cb.classList.add('trial-off'); }
  else if(cb.classList.contains('trial-off')){ cb.removeAttribute('aria-disabled'); cb.title=cb.dataset.paidTitle; cb.classList.remove('trial-off'); }
}
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
  // unchanged layout → no phantom version; just go back (the flow still re-checks the price).
  // r19 L2: "unchanged" = same as the version STORED on the server (object count + content hash), not just
  // "no edit since the page opened" - a default layout generated on arrival is new and must be written.
  const need = !RO && (window.HelmFlowLayout && HelmFlowLayout.needsVersion
    ? HelmFlowLayout.needsVersion(storedKey, canvasKey(), dirty.isDirty()) : dirty.isDirty());
  const ok = !need ? true : await saveLayout(false, { noReprice:true });
  if(!ok) return;                               // save refused/failed: stay, the error is already shown
  if(need && window.HelmFlowLayout && HelmFlowLayout.needsVersion && HelmFlowLayout.needsVersion(storedKey, canvasKey(), false)){
    BPUI.toast('The layout was not saved yet — press Save & back to quote again.',{type:'err'}); return; }   // only leave once the version exists
  // R112: one pricing write, asked first on a sent / approved quote ("Update quote (new version)" / "Keep quote")
  if(!RO) await syncQuotePricingNow({ interactive:true });   // the flow page re-checks and saves the quotation too
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
/* toolbar menus (Layout ▾ / View ▾ / Share ▾): aria-expanded, Esc closes + returns focus, ↑↓/Home/End move,
   outside click closes, picking a button item closes. Items injected later (walkthrough / fullscreen / studio templates) work too. */
(function(){
  const wraps=[...document.querySelectorAll('header .tmenu')];
  const items=pop=>[...pop.querySelectorAll('button,select,input,a[href]')].filter(x=>!x.disabled && !x.hidden && x.offsetParent!==null);
  function close(w,focus){ const b=w.querySelector('.tmenu-btn'), p=w.querySelector('.tmenu-pop'); if(p.hidden) return;
    p.hidden=true; b.setAttribute('aria-expanded','false'); w.classList.remove('open'); if(focus) b.focus(); }
  function open(w,first){ wraps.forEach(o=>{ if(o!==w) close(o,false); });
    const b=w.querySelector('.tmenu-btn'), p=w.querySelector('.tmenu-pop'); const hb=document.querySelector('header').getBoundingClientRect(); p.style.setProperty('--tm-top', Math.round(hb.bottom+4)+'px'); p.hidden=false; b.setAttribute('aria-expanded','true'); w.classList.add('open');
    if(first){ const f=items(p); if(f.length) (first==='last'?f[f.length-1]:f[0]).focus(); } }
  wraps.forEach(w=>{
    const b=w.querySelector('.tmenu-btn'), p=w.querySelector('.tmenu-pop');
    b.addEventListener('click',e=>{ if(p.hidden) open(w, e.detail===0 ? 'first' : null); else close(w,false); });
    b.addEventListener('keydown',e=>{ if(e.key==='ArrowDown'){ e.preventDefault(); open(w,'first'); } else if(e.key==='ArrowUp'){ e.preventDefault(); open(w,'last'); } });
    p.addEventListener('keydown',e=>{
      if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(w,true); return; }
      if(e.target.tagName==='SELECT' || e.target.tagName==='INPUT') { if(e.key!=='Tab') return; }
      const f=items(p), i=f.indexOf(document.activeElement);
      if(e.key==='ArrowDown'){ e.preventDefault(); f[(i+1)%f.length]?.focus(); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); f[(i-1+f.length)%f.length]?.focus(); }
      else if(e.key==='Home'){ e.preventDefault(); f[0]?.focus(); }
      else if(e.key==='End'){ e.preventDefault(); f[f.length-1]?.focus(); }
      else if(e.key==='Tab'){ close(w,false); }
    });
    // picking an action closes the menu (selects close once a choice is made)
    p.addEventListener('click',e=>{ const t=e.target.closest('button'); if(t && p.contains(t)) close(w,false); });
    p.addEventListener('change',e=>{ if(e.target.tagName==='SELECT') close(w,true); });
  });
  document.addEventListener('click',e=>{ wraps.forEach(w=>{ if(!w.contains(e.target)) close(w,false); }); });
  document.addEventListener('keydown',e=>{ if(e.key!=='Escape') return; const w=wraps.find(x=>x.classList.contains('open')); if(w){ e.preventDefault(); close(w,true); } });
  window.__toolbarMenus={ open:(id)=>{ const w=document.getElementById(id); if(w) open(w,'first'); }, closeAll:()=>wraps.forEach(w=>close(w,false)) };
})();
/* keep the "? Tour" pill inside the canvas control stack so it never sits on top of the zoom / pan controls */
(function(){ const stack=$('#fabStack'); if(!stack || !window.MutationObserver) return;
  const grab=()=>{ const f=document.querySelector('body > .htour-fab'); if(f){ f.classList.add('in-stack'); stack.append(f); } };
  grab(); new MutationObserver(grab).observe(document.body,{childList:true});
})();
$('#loadModal').addEventListener('click',e=>{ if(e.target.id==='loadModal') closeLoadModal(); });
$('#exportBtn').addEventListener('click',()=>{ BPUI.guard($('#exportBtn'), exportPNG,{busyLabel:'Exporting…'}).catch(()=>{}); });
$('#clientImgBtn').addEventListener('click',()=>{
  if(builderInTrial()){ syncClientImgTrial(); BPUI.toast('Client images are available on a paid plan.',{type:'info'}); return; }   // r20: off in the free trial
  BPUI.guard($('#clientImgBtn'), ()=>captureClientImages(false),{busyLabel:'Capturing…'}).catch(()=>{});
});
// r20: free trial = html.helm-trial (trial-lock.js after the server answers; trial-early.js from the cached flag).
// The button is hidden there (CSS), its click says "available on a paid plan"; already-saved client images are never touched.
(function watchClientImgTrial(){
  syncClientImgTrial();
  try{ window.addEventListener('helm:trial', syncClientImgTrial); }catch(_){}
  try{ new MutationObserver(syncClientImgTrial).observe(document.documentElement,{attributes:true, attributeFilter:['class']}); }catch(_){}
})();
$('#jsonBtn').addEventListener('click',()=>{ BPUI.guard($('#jsonBtn'), async()=>exportJSON()).catch(()=>{}); });
$('#importBtn').addEventListener('click',async()=>{
  if(!(await BPUI.confirmDiscard(dirty,{message:'You have unsaved changes on this floor. Importing a file will replace them.'}))) return;
  $('#importFile').click();
});
$('#importFile').addEventListener('change',e=>{ const f=e.target.files[0]; e.target.value='';
  if(f) BPUI.guard($('#importBtn'), ()=>importJSON(f),{busyLabel:'Importing…'}).catch(()=>{}); });
/* dark mode is OFF for now (window.HELM_DARK_MODE !== true): the light/dark button is hidden; store-api.js keeps the page light */
if(window.HELM_DARK_MODE===true) $('#themeBtn').addEventListener('click',toggleTheme); else { const tb=$('#themeBtn'); if(tb){ tb.hidden=true; tb.style.display='none'; } }
$('#projName').addEventListener('keydown',e=>{ if(e.key==='Enter') e.target.blur(); });
$('#projName').addEventListener('input',()=>markDirty());
$('#capInput').addEventListener('input',e=>{ const v=parseInt(e.target.value,10); store.venue.capacity = (isFinite(v)&&v>0)?Math.min(v,MAX_CAPACITY):null; if(store.venue.capacity!==v && isFinite(v) && v>0) e.target.value=store.venue.capacity; updateCapacityUI(); markDirty(); });
$('#capInput').addEventListener('change',()=>{ if(currentLayoutId) scheduleAutosave(); });
// R11: layout-wizard.js takes #customBtn / #es_custom first (requirements wizard); this classic dialog stays
// reachable from the wizard's "Classic templates…" button and the ?gen=1 flow arrival.
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
  if(params.get('debug')==='1' && $('#stateDetails')) $('#stateDetails').hidden=false;   // developer panel (raw state JSON) only with ?debug=1
  const evId=params.get('id'), evName=params.get('event'), isNew=params.get('new')==='1';
  const quoteId=await HelmUrl.get('quote', params.get('quote')), openVer=params.get('v');
  store.items = (isNew||quoteId) ? [] : TEMPLATES.political();   // blank for a new event/quote, else a working default
  if(quoteId || evId) setLayoutLoading(true);         // neutral loading state until the saved layout arrives
  if(evName){ const pn=$('#projName'); if(pn) pn.value=evName; }
  resetHistory();                                     // establish the initial undo baseline
  renderAll();
  fitView();
  window.addEventListener('resize',()=>{ renderRulers(); });
  // the plan's box also changes without a window resize (3D -> 2D switch, pseudo-fullscreen exit): redraw the rulers then too
  // r22 (live QA 375): ...and re-fit while the view is still the untouched "fit" - on a phone the plan area settled to
  // its final size only after the first fit (toolbar rows / banners drawn late), which left the floor shifted
  let fitBox='';
  if(window.ResizeObserver){ try{ new ResizeObserver(()=>{
    const box=scrollEl.clientWidth+'x'+scrollEl.clientHeight;
    if(box!==fitBox && scrollEl.clientWidth>0 && scrollEl.clientHeight>0 && viewAtFit && !is3DActive()){ fitBox=box; requestAnimationFrame(()=>{ try{ if(viewAtFit && !is3DActive()) fitView(); }catch(_){} }); return; }
    renderRulers(); }).observe(scrollEl); }catch(_){} }
  await initStore();
  initPanelToggles();   // after initStore so the saved state is per signed-in user
  // load pricing rates from Settings (fallbacks stay if unavailable)
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
    // QA1017: editable follows the has_area matrix (what add_quote_version enforces), not the fixed ROLE_CAPS list
    const editable = (await BPStore.auth.canEditArea('layouts')) || (await BPStore.auth.canEditArea('quotes'));
    CAN_CREATE = await BPStore.auth.can('create');
    if(!editable) applyReadonly(await BPStore.auth.role());
  }
  await renderAccountChip();
  if(quoteId){
    try{
      const q=await BPStore.quotes.get(quoteId);
      currentQuoteId=q.id; currentQuoteCode=q.code; currentClient=q.client||{}; currentPricing=q.pricing||{};
      if(currentPricing.priceDisplay && typeof currentPricing.priceDisplay==='object') store.priceDisplay=priceDisp(currentPricing.priceDisplay);
      { const bb=$('#backToFlowBtn'); if(bb && params.get('from')==='flow') bb.hidden=false; }
      currentQuoteGuard = { approved: q.status==='confirmed' || q.approvalStatus==='approved' || q.approvalStatus==='paid', sent: q.approvalStatus==='sent', closed: q.lifecycleStage==='closed', frozen: q.lifecycleStage==='closed' || q.status==='cancelled' || !!q.archivedAt || !!q.deletedAt };
      const pn=$('#projName'); if(pn) pn.value=quoteDisplayName(q);
      currentQuoteRow=q; renderNameHint();
      try{ if(window.HelmTrail) HelmTrail.setCurrent({title:[q.code,q.title].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' '),kind:'builder',href:'builder.html?quote='+encodeURIComponent(q.id),recordHref:'event.html?id='+encodeURIComponent(q.id)}); }catch(e){}
      const verNo = (openVer && /^\d{1,6}$/.test(String(openVer)) && +openVer>0) ? parseInt(openVer,10) : q.currentVersion;   // ignore junk like v=abc
      // QA-B8: a quote whose V1 row was never written (current_version 1, no version rows at all) opens as an
      // empty V1 instead of locking. Nothing can be overwritten: add_quote_version numbers from max(version_no)+1,
      // so the first save simply becomes V1. Any other missing / unreadable version still locks (catch below).
      const _noVersionRows = !(q.versions||[]).length && +verNo===1 && (+q.currentVersion||1)===1;
      const ver = _noVersionRows ? { versionNo:1, data:{ items:[] }, missing:true } : await BPStore.quotes.getVersion(q.id, verNo);
      currentVersionNo = ver.versionNo;
      PRICING.eventType = q.eventType || null;
      PRICING.eventDate = q.eventDate || null;   // photo render: season from the event date
      // pull the event's guest count + applied menu package so the price is synced
      // R112: the plates the QUOTE is priced with (pricing.guests, the flow's "Plates" field) win; the client head count is
      // only the fallback for a quote that never stored one. Client-first re-priced a 200-plate quote at 150 on layout save.
      { const pl = window.HelmRepriceGuard ? HelmRepriceGuard.platesFor(q.client, currentPricing)
          : (currentPricing.guests!=null ? +currentPricing.guests : (q.client && q.client.guests!=null ? +q.client.guests : null));
        if(pl!=null) PRICING.guests = +pl; }
      try{
        const plan = await BPStore.plan.get(q.id);
        if(plan){
          if(plan.menu_plate_price!=null) PRICING.menuPlatePrice = +plan.menu_plate_price;
          if(plan.menu_template) PRICING.menuPackageName = plan.menu_template;
          const match=(PRICING.packages||[]).find(p=>p.name===plan.menu_template);
          if(match) PRICING.appliedPkgId = match.id;
          // qmodal-1018: the builder re-writes the quote's pricing on its own (every layout save), so it must never
          // silently move the plate rate to the package's list price (that would undo a price agreed with the client).
          // It keeps the plan's applied-at price, except when the quote was already re-priced at the package's
          // CURRENT price (the Confirm / Re-price dialog) - then that saved price stays and the two screens agree.
          if(match && currentPricing && currentPricing.platePrice!=null && currentPricing.platePrice!=="" && match.price_per_plate!=null
             && +currentPricing.platePrice === +match.price_per_plate) PRICING.menuPlatePrice = +match.price_per_plate;
        }
      }catch{}
      // QA-B10: the event plan has no package but the quote was priced with one (pricing._packageName, e.g. the
      // sample events) -> show that package as selected. Display only: the plate rate stays the quote's own
      // platePrice (menuPlatePrice is left unset), so opening the builder never re-prices anything.
      if(!PRICING.menuPackageName && currentPricing && currentPricing._packageName){
        const pk=pkgFromQuoteName(PRICING.packages, currentPricing._packageName);
        PRICING.menuPackageName = pk ? pk.name : String(currentPricing._packageName);
        if(pk && !PRICING.appliedPkgId) PRICING.appliedPkgId = pk.id;
      }
      buildMenuControls();
      // unreadable version data must lock the builder (catch below), never be shown as an empty floor to save over
      if(!ver || !ver.data || !Array.isArray(ver.data.items)) throw new Error('version data unreadable');
      draftToRestore = readDraft(q.id);
      applyLayout(ver.data);                  // also restores hall size / margins / capacity of an empty version
      storedKey = ver.missing ? null : canvasKey();   // r19 L2: what the server holds (a never-written V1 = unknown)
      // PP1028 #2: never silently drop priced default decor onto a quote that is already priced or locked
      // (confirmed / sent / approved) - that re-priced a locked ₹67,968 quote to ₹2,23,728 on save.
      // Those quotes open on a blank floor; the Templates menu / ?gen=1 stay the explicit way to add a default.
      const _ppPriced = +((q.pricing&&(q.pricing.total||q.pricing.grandTotal||q.pricing.subtotal))||q.total||0) > 0;
      const _ppAllowAuto = (typeof HelmBuilderAutoDefault==='function') ? HelmBuilderAutoDefault(q, _ppPriced, params.get('gen')==='1') : (params.get('gen')==='1' || (!_ppPriced && !currentQuoteGuard.approved && !currentQuoteGuard.sent));
      if(!ver.data.items.length && ver.versionNo===1 && +q.currentVersion===1 && !_ppAllowAuto && !CAPTURE_HOST){
        toast('No layout saved yet — blank floor. Use Templates to start from a default layout.'); }
      if(_ppAllowAuto && !ver.data.items.length && ver.versionNo===1 && +q.currentVersion===1){
        // Brand-new (never-edited) quote → drop in the default layout for this event type so the
        // client immediately sees the standard package (chairs, mandap, stage…). Only ever for v1.
        const presetKey = EVENT_TYPE_PRESET[(q.eventType||'').toLowerCase()];
        const fam=eventFamily(q.eventType);
        if((fam || (presetKey && TEMPLATES[presetKey])) && !CAPTURE_HOST){
          // V3: wedding / political / corporate / concert families get the validated item set scaled to this hall
          // Vfix: size the floor to the quote's hall (flow / linked venue) — or the ?gen URL's len/wid — BEFORE
          // building, so a 262×164 ft venue isn't laid out in the default 200×140 ft room.
          { const cl=(q.client&&typeof q.client==='object')?q.client:{}; let u=null; try{ u=new URLSearchParams(location.search); }catch(_){}
            const pick=(a,b)=>{ const n=+a; if(isFinite(n)&&n>0) return n; const m=+b; return isFinite(m)&&m>0?m:null; };
            const hl=pick(cl.hallLen, u&&u.get('len')), hw=pick(cl.hallWid, u&&u.get('wid')), maxFt=(CAPS&&CAPS.hall)||1000;
            if(hl&&hw){ WORLD.w=clamp(Math.round(hl),20,maxFt); WORLD.h=clamp(Math.round(hw),20,maxFt);
              store.venue=store.venue||{}; store.venue.room={ w:WORLD.w, h:WORLD.h };
              if(cl.setting==='outdoor'||cl.setting==='indoor') store.venue.setting=cl.setting;
              if(typeof updateDimsLabel==='function') updateDimsLabel(); } }
          const N=arrivalSeats();
          store.items = fam ? buildEventDefault(fam, N) : TEMPLATES[presetKey]();
          if(N>0) exactSeats(store.items, N);   // R8b/R10: exactly the quote's (or flow's) seats
          _autoDefaultLoaded=true;
          toast('Loaded a default '+(q.eventType||'')+' layout — not saved yet, press Save to keep it');
          // r19 L2: "Generate default layout" (?gen=1) makes a NEW layout - it is unsaved until a version is
          // written (never "Saved ✓"; Save / Save & back write it).
          // r20 (live QA): the quiet default for a brand-new quote is not stored either (V1 is still the empty floor the
          // quote page counts as 0 objects): it also reads "Unsaved changes" + the leave-page warning until Save /
          // Save & back writes it. Nothing is written by itself.
          resetHistory(); markGenUnsaved(); renderAll();
        }
      }
      versionsList = q.versions || [];
      latestVersionNo = Math.max(+q.currentVersion||0, ...versionsList.map(v=>+v.versionNo||0)) || currentVersionNo;
      updateQuoteBadge();
      refreshVersions();                     // adds who-saved names; non-blocking
      watchVersions();                       // live: versions saved on another device / tab
      if(q.status==='confirmed'){ const b=$('#quoteBadge'); if(b) b.classList.add('confirmed'); }
      toast('Opened '+q.code+' · V'+currentVersionNo);
      // r22 (live QA): "Restore unsaved draft?" opened while "Loading event…" was still on screen (~1s, both at once) -
      // the layout is in by now, so the loading state ends first and the question comes after it
      if(!CAPTURE_HOST && layoutLoading) setLayoutLoading(false);
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
  scheduleBuilderTour(); // r19: first visit only - the mini tour of the toolbar (tour.js), once nothing else is open
  // Guided default-layout generation from the flow: ?gen=1&type=&guests=&len=&wid=
  if(params.get('gen')==='1' && CAN_CREATE!==false){
    // R10: the default layout auto-built on arrival carries EXACTLY the flow's seats (all seating counted)
    if(_autoDefaultLoaded){ const N=arrivalSeats(); if(N>0 && sumSeats(store.items)!==N){ exactSeats(store.items, N); resetHistory(); markGenUnsaved(); renderAll(); } }
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
        // R97: optional keys (stored only when a studio changed them from the built-in value; absent = unchanged)
        if(rule.seatsPerTable!=null) setV('c_spt', rule.seatsPerTable);
        if(rule.aisleFt!=null) setV('c_aisle', rule.aisleFt);
        if(rule.exits!=null) setV('c_exits', rule.exits);
        if(rule.headTable!=null) setChk('c_head', rule.headTable);
        if(rule.canopy!=null) setChk('c_canopy', rule.canopy);
        if(rule.lounge!=null) setChk('c_lounge', rule.lounge);
        if(!_autoDefaultLoaded) toast('Applied "'+(rawType||ct)+'" default rules');
      }
    }catch(e){}
    // r19 L2: the default layout is already on the floor - do not pop the "Custom event builder" window over it
    // (it is still one click away under Layout ▾). Only when no default could be built does the window open.
    if(_autoDefaultLoaded){ toast('Default layout ready — press Save & back to quote to keep it'); }
    else {
      openCustomModal();
      try{ runCustomGenerate(); }catch(e){}
      toast('Pick a generated layout to start — then tweak it freely');
    }
  }
}
/* r19: the builder's first-run mini tour (tour.js STEPS["builder.html"]: every toolbar control in screen order;
   a step whose control is hidden for this person / studio / screen is skipped by the engine). It starts by itself
   ONCE per browser - tour.js marks it seen when it ends or is skipped; "? Tour" replays it any time. Never for a
   read-only viewer, the headless capture host or a phone-width screen, and only once no dialog / walkthrough /
   other tour is open (it waits a little, then gives up for this visit). */
const BUILDER_TOUR_SEEN='helm_tour_seen_builder';
function builderTourBusy(){
  if(document.querySelector('.htour, .bpui-overlay, .modal:not([hidden]), body.wt-on, body.fs-on')) return true;
  return Array.prototype.some.call(document.querySelectorAll('[aria-modal="true"]'), m=>!m.hidden && !m.closest('[hidden]') && m.getClientRects().length>0);
}
function scheduleBuilderTour(){
  if(RO || CAPTURE_HOST || !window.HelmTour || !HelmTour.hasSteps) return;
  if(window.matchMedia && matchMedia('(max-width:720px)').matches) return;
  try{ if(localStorage.getItem(BUILDER_TOUR_SEEN)) return; }catch(_){ return; }   // no storage: never nag on every visit
  let tries=0;
  const attempt=function(){
    if(++tries>40) return;
    if(layoutLoading || builderTourBusy()){ setTimeout(attempt, 1500); return; }
    try{ if(localStorage.getItem(BUILDER_TOUR_SEEN)) return; }catch(_){ return; }
    try{ HelmTour.start(); }catch(_){}
  };
  setTimeout(attempt, 900);   // let the late controls (walkthrough, privacy eye, templates) mount first
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

/* ===================== ITEM-SPEC ADJUST: BEGIN (0086 — owned by the item-spec/pricing work) =====================
   Selecting a DJ, generator, stage, lighting, LED wall, chandelier, photo booth, chocolate fountain, chariot,
   smoke effect or dancers shows an "Adjust" section in the inspector: spec fields (dropdowns / numbers,
   dimensions in metres by default with a ft toggle), a live price preview from the studio's Item pricing
   rate cards (BPStore.pricing.ITEM_SPEC), and Apply. The spec is stored on item.properties.spec, so the
   price flows through pricing.fromItems -> objectsCost -> pricing.other (the server D8 total prices it).
   A stage's length x width IS its footprint: editing either resizes the other. Built with the DOM API. */
function specApi(){ return (window.BPStore && BPStore.pricing && BPStore.pricing.ITEM_SPEC) || null; }
function specSyncAll(){
  const S=specApi(); if(!S || !store || !store.items) return;
  store.items.forEach(it=>{ const sp=it.properties&&it.properties.spec;
    // only when the footprint really changed (resize / clamp): re-rounding an unchanged stage to the cm would
    // move the price away from the Adjust preview (26.25 ft typed -> 8.001 m -> 8.00 m = a different total)
    if(it.type==='stage' && sp && typeof sp==='object'){
      if(!(Math.abs(it.width-(+sp.lengthM)/S.FT)<0.01)) sp.lengthM=Math.round(it.width*S.FT*100)/100;
      if(!(Math.abs(it.height-(+sp.widthM)/S.FT)<0.01)) sp.widthM=Math.round(it.height*S.FT*100)/100; } });
}
function specAdjustMount(it, box){
  const S=specApi(); if(!S || !box || !it || S.TYPES.indexOf(it.type)<0) return;
  const mk=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
  const rates=BPStore.pricing.currentItemRates()[it.type]||null;
  const saved=it.properties&&it.properties.spec&&typeof it.properties.spec==='object'?it.properties.spec:null;
  const draft=Object.assign({}, S.defaultSpec(it.type, it)||{}, saved||{});
  let unit=draft.unit==='ft'?'ft':'m';
  const sec=mk('div','isec specadj'); sec.setAttribute('aria-label','Adjust item specification');
  const head=mk('div','seclabel', saved?'Adjust (priced by spec)':'Adjust — price by spec'); sec.appendChild(head);
  const form=mk('div'); sec.appendChild(form);
  const prev=mk('div','pitchnote'); prev.setAttribute('aria-live','polite'); sec.appendChild(prev);
  const btns=mk('div','colorbtns'); const apply=mk('button',null,'Apply'); apply.type='button';
  const clr=mk('button',null,'Use flat catalog price'); clr.type='button'; clr.hidden=!saved;
  btns.appendChild(apply); btns.appendChild(clr); sec.appendChild(btns);
  const optKeys=(o)=>o&&typeof o==='object'?Object.keys(o):[];
  const row=()=>{ const r=mk('div','irow'); r.style.marginTop='8px'; form.appendChild(r); return r; };
  const fieldWrap=(r,id,label)=>{ const f=mk('div','ifield'); const l=mk('label',null,label); l.htmlFor=id; f.appendChild(l); r.appendChild(f); return f; };
  function sel(r,key,label,opts){ const id='sp_'+key, f=fieldWrap(r,id,label), s=mk('select'); s.id=id;
    opts.forEach(k=>{ const o=mk('option',null,S.label(k)); o.value=k; if(String(draft[key])===k) o.selected=true; s.appendChild(o); });
    if(!opts.length){ const o=mk('option',null,'rate not set'); o.value=''; s.appendChild(o); }
    if(draft[key]==null||opts.indexOf(String(draft[key]))<0) draft[key]=opts[0]||'';
    s.addEventListener('change',()=>{ draft[key]=s.value; preview(); }); f.appendChild(s); }
  function numf(r,key,label,o){ o=o||{}; const id='sp_'+key, f=fieldWrap(r,id,label+(o.dim?' ('+unit+')':'')), i=mk('input'); i.id=id; i.type='number';
    i.min=String(o.min!=null?o.min:0); if(o.max!=null) i.max=String(o.max); i.step=String(o.step||'any');
    const v=draft[key]; i.value=v==null||v===''?'':String(o.dim?Math.round(S.fromM(+v,unit)*100)/100:v);
    if(o.list){ const dl=mk('datalist'); dl.id=id+'_l'; o.list.forEach(x=>{ const op=mk('option'); op.value=String(x); dl.appendChild(op); }); f.appendChild(dl); i.setAttribute('list',dl.id); }
    i.addEventListener('input',()=>{ const raw=i.value.trim(); draft[key]= raw===''?null:(o.dim?S.toM(raw,unit):Number(raw)); preview(); });
    f.appendChild(i); }
  function chk(r,key,label){ const id='sp_'+key, f=fieldWrap(r,id,label), c=mk('input'); c.id=id; c.type='checkbox'; c.checked=!!draft[key];
    c.addEventListener('change',()=>{ draft[key]=c.checked; preview(); }); f.appendChild(c); }
  function build(){
    while(form.firstChild) form.removeChild(form.firstChild);
    const rr=rates||{};
    switch(it.type){
      case 'stage': { const r0=row(), f=fieldWrap(r0,'sp_unit','Units'), s=mk('select'); s.id='sp_unit';
          [['m','metres'],['ft','feet']].forEach(([v,t])=>{ const o=mk('option',null,t); o.value=v; if(v===unit) o.selected=true; s.appendChild(o); });
          s.addEventListener('change',()=>{ unit=s.value; draft.unit=unit; build(); preview(); }); f.appendChild(s);
          const r=row(); numf(r,'lengthM','Length',{dim:1,min:0.5,step:0.1}); numf(r,'widthM','Width',{dim:1,min:0.5,step:0.1});
          numf(row(),'heightM','Height',{dim:1,min:0,step:0.1}); break; }
      case 'generator': { const r=row(); numf(r,'kva','Capacity (kVA)',{min:1,list:S.KVA_PRESETS}); numf(r,'days','Days',{min:1,step:1});
          const r2=row(); chk(r2,'diesel','Diesel included'); chk(r2,'operator','Operator'); break; }
      case 'dj': { const r=row(); sel(r,'setup','Setup',optKeys(rr.setup)); sel(r,'power','Power connection',optKeys(rr.power));
          numf(row(),'extraSpeakers','Extra speakers',{min:0,step:1}); break; }
      case 'lighting': { const r=row(); sel(r,'kind','Type',optKeys(rr.each).concat(optKeys(rr.perM))); numf(r,'qty','Quantity / runs',{min:1,step:1});
          numf(row(),'lengthM','Length per run (m, string / truss)',{min:0.5,step:0.5}); break; }
      case 'led': { sel(row(),'pitch','Screen type',optKeys(rr.perSqMDay)); const r=row(); numf(r,'widthM','Width (m)',{min:0.5,step:0.5}); numf(r,'heightM','Height (m)',{min:0.5,step:0.5});
          numf(row(),'days','Days',{min:1,step:1}); break; }
      case 'chandelier': { const r=row(); sel(r,'size','Size / type',optKeys(rr.each)); numf(r,'qty','Quantity',{min:1,step:1}); break; }
      case 'photobooth': { const r=row(); sel(r,'kind','Booth type',optKeys(rr.perHour)); numf(r,'hours','Hours',{min:1,step:0.5}); break; }
      case 'chocolatefountain': { const r=row(); sel(r,'size','Size',optKeys(rr.base)); numf(r,'servings','Servings',{min:0,step:10}); break; }
      case 'chariot': { const r=row(); sel(r,'kind','Chariot',optKeys(rr.perTrip)); numf(r,'trips','Trips',{min:1,step:1}); break; }
      case 'smoke': { const r=row(); sel(r,'kind','Effect',optKeys(rr.perUnit)); numf(r,'units','Units',{min:1,step:1}); break; }
      case 'dancers': { const r=row(); numf(r,'count','Dancers',{min:1,step:1}); sel(r,'basis','Charged',['show','hour']); numf(row(),'qty',draft.basis==='hour'?'Hours':'Performances',{min:1,step:1}); break; }
    }
  }
  function preview(){
    if(!rates){ prev.textContent='Rate not set for this item in Settings → Item pricing — the flat catalog price applies.'; apply.disabled=true; return; }
    try{ const r=S.compute(it.type, draft, rates); prev.textContent=r.label; apply.disabled=!!RO; }
    catch(e){ prev.textContent=(e&&e.rateNotSet?'Rate not set — ':'Check the values: ')+((e&&e.message)||e); apply.disabled=true; }
  }
  apply.addEventListener('click',()=>{
    if(RO) return;
    try{ S.compute(it.type, draft, rates); }catch(e){ preview(); return; }
    const spec=Object.assign({}, draft); if(it.type==='stage') spec.unit=unit;
    it.properties=it.properties||{}; it.properties.spec=spec;
    if(it.type==='stage'){   // the stage's footprint follows its length x width (world units are feet)
      it.width=clamp(spec.lengthM/S.FT,0.5,WORLD.w); it.height=clamp(spec.widthM/S.FT,0.5,WORLD.h);
      it.x=clamp(it.x,0,WORLD.w-it.width); it.y=clamp(it.y,0,WORLD.h-it.height);
      if(it.width<spec.lengthM/S.FT-0.01 || it.height<spec.widthM/S.FT-0.01) toast('Stage trimmed to fit the hall — its size and price follow the hall');
    }
    commit(); renderAll();
  });
  clr.addEventListener('click',()=>{ if(RO) return; if(it.properties) delete it.properties.spec; commit(); renderAll(); });
  build(); preview();
  if(RO){ sec.querySelectorAll('input,select,button').forEach(e=>{ e.disabled=true; }); }
  const ibtns=box.querySelector('.ibtns'); if(ibtns) box.insertBefore(sec, ibtns); else box.appendChild(sec);
}
/* ===================== ITEM-SPEC ADJUST: END ===================== */

/* Quote NAME in the builder: an automatic title (code / blank / TYPE_CITY_GUESTS_DATE) shows the
   computed auto name; typing your own makes it custom (never auto-overwritten). Saving writes the
   shown name (fill-only for old quotes whose title was the code). */
var currentQuoteRow=null;
function quoteDisplayName(q){ const H=window.HelmEventName; return (H&&H.displayName)?H.displayName(q):(q.title||q.code); }
function renderNameHint(){
  const h=document.getElementById('projNameHint'), pn=document.getElementById('projName'); if(!h||!pn) return;
  const H=window.HelmEventName; if(!currentQuoteId||!H){ h.hidden=true; return; }
  h.hidden=false;
  const auto=H.isAuto(pn.value, currentQuoteCode);
  const t=document.getElementById('projNameHintText'); if(t) t.textContent=auto?H.HINT:'Custom name';
  const r=document.getElementById('projNameReset'); if(r) r.hidden=auto;
}
(function(){
  const pn=document.getElementById('projName'); if(!pn) return;
  pn.addEventListener('input',renderNameHint);
  pn.addEventListener('blur',()=>{ const H=window.HelmEventName; if(currentQuoteId&&H&&!pn.value.trim()&&currentQuoteRow){ pn.value=H.fromQuote(currentQuoteRow)||currentQuoteCode||''; renderNameHint(); } });
  pn.addEventListener('keydown',e=>{ if(e.key==='Escape'&&currentQuoteRow){ pn.value=quoteDisplayName(currentQuoteRow); renderNameHint(); pn.blur(); } });
  const r=document.getElementById('projNameReset');
  if(r) r.addEventListener('click',()=>{ const H=window.HelmEventName; if(!H||!currentQuoteRow) return; pn.value=H.fromQuote(currentQuoteRow)||currentQuoteCode||''; markDirty(); renderNameHint(); });
})();
/* Public /try sandbox only (try.js defines a read-only window.HELM_SANDBOX=true before this
   script). A tiny API so the sandbox can load its demo floor and drop a few items — no-op elsewhere. */
if(window.HELM_SANDBOX===true && !window.__helmSandbox) window.__helmSandbox = Object.freeze({
  load(spec, hall){
    if(hall && hall.w>0 && hall.h>0){ WORLD.w=hall.w; WORLD.h=hall.h; store.venue=store.venue||{}; store.venue.room={w:WORLD.w,h:WORLD.h}; updateDimsLabel(); sizeCanvas(); }
    loadItems((spec||[]).filter(s=>s && ASSETS[s.t]).map(s=>makeItem(s.t, s.x, s.y, s.o||{})), '');
  },
  add(type, o){
    if(!ASSETS[type]) return null;
    const a=ASSETS[type], it=makeItem(type, WORLD.w/2-a.w/2, WORLD.h/2-a.h/2, (o&&typeof o.color==='string')?{color:o.color,colorCustom:true}:{});
    if(NEW_ITEM_FACING[type]!=null) it.rotation = NEW_ITEM_FACING[type];   // R72: new sofa/lounge faces into the room
    store.items.push(clampItem(it)); setSelection([it.id]); commit(); renderAll(); return it.id;
  },
  rotate(){ const sel=selectedItems(); if(!sel.length) return false; sel.forEach(it=>it.rotation=(it.rotation+15)%360); commit(); renderAll(); return true; },
  measure(on){ if(!!on!==showMeasure) $('#measureBtn').click(); },
  unit(u){ setUnit(u); },
  fit(){ fitView(); }
});

/* ===================== DÉCOR VARIANTS: BEGIN (2026-10c) =====================
   One product, many looks: instead of hundreds of near-identical catalogue rows, a décor item carries
   optional properties chosen in the inspector — style (frame / backdrop / mandap shape), flower (bloom
   type) and palette (colour story). They are purely visual: the 3D model (builder-3d.js) and the photo
   render prompt (photo-render-prompt.js) read them; the PRICE never changes with them (the server D8
   total prices by type), so a variant can never move a quote total. Built with the DOM API (CSP-safe).
   Research: docs/research/event-inventory-2026-10.md */
const VARIANT_OPTS = {
  flower: [['','Default mix'],['rose','Roses'],['marigold','Marigold (genda)'],['orchid','Orchids'],['hydrangea','Hydrangea'],
    ['jasmine','Jasmine / mogra'],['carnation','Carnations'],['lily','Lilies'],['mixed','Mixed garden']],
  palette: [['','Item colour'],['blush','Blush & ivory'],['ivory','All white / ivory'],['marigold','Marigold yellow-orange'],['redgold','Red & gold'],
    ['pastel','Pastels'],['jewel','Jewel tones (magenta / purple)'],['whitegreen','White & greenery'],['rainbow','Rainbow / multicolour'],['goldchrome','Gold & chrome']],
};
const ENTRANCE_STYLES=[['','Classic round-top'],['hexagon','Hexagon metal frame'],['ring','Round ring / moon gate'],['square','Square frame'],
  ['rustic','Rustic wooden arbour'],['pillars','Pillar gate (no header)'],['tunnel','Floral tunnel (walk-through)']];
const VARIANT_STYLES = {
  floralentrance: ENTRANCE_STYLES, floralarch: ENTRANCE_STYLES, arch: ENTRANCE_STYLES,
  entrancegate: [['','Traditional pillars + crown'],['hexagon','Hexagon metal frame'],['ring','Round ring / moon gate'],['rustic','Rustic wooden arbour'],['tunnel','Floral tunnel (walk-through)']],
  balloonarch: [['','Organic arch'],['classic','Classic spiral arch'],['ring','Balloon ring / hoop'],['garland','Low garland (backdrop top)']],
  stagebackdrop: [['','Floral frame on fabric'],['drape','Draped fabric swags'],['panel','Tufted panels'],['led','LED screen centre'],['jaali','Carved jaali screen']],
  mandap: [['','Dome canopy (four pillar)'],['flat','Flat floral canopy'],['south','South Indian (banana-stem pillars)'],['glass','Modern acrylic pillars']],
  centrepiece: [['','Tall candelabra'],['low','Low bowl arrangement'],['lantern','Lantern + candles']],
  // complete-catalogue pack (2026-10d): generic items take a look instead of being separate products
  chiavari: [['','Gold chiavari'],['ghost','Ghost (clear acrylic)'],['crossback','Wooden cross-back'],['folding','Folding chair'],['banquet','Banquet chair with cover + sash'],['plastic','Plastic (outdoor)']],
  backdrop: [['','Plain fabric'],['flex','Printed flex on frame'],['sequin','Sequin / shimmer wall'],['greenery','Greenery (boxwood) wall'],['wood','Wooden panel wall'],['balloon','Balloon wall']],
  floralstand: [['','Tall gold stand'],['urn','Urn / vase'],['pedestal','Pedestal bowl'],['hoop','Floral hoop']],
  decorbox: [['','Box / crate'],['cylinder','Cylinder plinth'],['sphere','Sphere / globe'],['cutout','Flat cut-out panel']],
  signage: [['','Roll-up banner'],['standee','Foam-board standee'],['aframe','A-frame sign'],['direction','Directional post'],['digital','Digital standee screen'],['cutout','Life-size cut-out']],
  pyro: [['','Cold pyro (sparkular)'],['co2','CO2 jet'],['confetti','Confetti cannon']],
  stall: [['','Canopy stall'],['kiosk','Hard-top kiosk']],
};
const VARIANT_FLORAL = new Set(['floral','floralarch','floralentrance','stagebackdrop','flowerwall','toran','floralpillar','aislefloral','centrepiece',
  'phoolchadar','entrancegate','mandap','pillar','haldi','selfieframe','hangingfloral','arch','floralstand','urli','kalash','doli','varmala','altar','jhoola']);
const VARIANT_PALETTE = new Set([...VARIANT_FLORAL, 'balloonarch','balloonbunch','lanterns','neonsign','fairylights','backdrop','decorbox','umbrellas','dessert']);
function variantFields(type){ const f=[]; if(VARIANT_STYLES[type]) f.push(['style','Style',VARIANT_STYLES[type]]);
  if(VARIANT_FLORAL.has(type)) f.push(['flower','Flowers',VARIANT_OPTS.flower]);
  if(VARIANT_PALETTE.has(type)) f.push(['palette','Colour story',VARIANT_OPTS.palette]); return f; }
if(typeof window!=='undefined') window.HelmVariants = Object.freeze({ fields: variantFields, STYLES: VARIANT_STYLES, OPTS: VARIANT_OPTS });
function variantMount(it, box){
  const fields=variantFields(it.type); if(!fields.length || !box) return;
  const mk=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
  const sec=mk('div','isec variants'); sec.setAttribute('aria-label','Décor variant');
  sec.appendChild(mk('div','seclabel','Look & variant'));
  const r=mk('div','irow'); sec.appendChild(r);
  fields.forEach(([key,label,opts])=>{ const id='vr_'+key, f=mk('div','ifield'), l=mk('label',null,label), s=mk('select'); l.htmlFor=id; s.id=id;
    const cur=String((it.properties&&it.properties[key])||'');
    opts.forEach(([v,t])=>{ const o=mk('option',null,t); o.value=v; if(v===cur) o.selected=true; s.appendChild(o); });
    s.addEventListener('change',()=>{ if(RO) return; it.properties=it.properties||{};
      if(s.value) it.properties[key]=s.value; else delete it.properties[key]; commit(); renderAll(); });
    if(RO) s.disabled=true; f.appendChild(l); f.appendChild(s); r.appendChild(f); });
  sec.appendChild(mk('div','pitchnote','Changes the look in 3D and in the photo render. The price stays the catalogue price for this item.'));
  const ibtns=box.querySelector('.ibtns'); if(ibtns) box.insertBefore(sec, ibtns); else box.appendChild(sec);
}
/* ===================== DÉCOR VARIANTS: END ===================== */
