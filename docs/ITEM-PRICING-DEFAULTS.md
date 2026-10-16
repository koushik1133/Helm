# Item pricing — default rate cards (India, INR)

Migration `0086_item_specs.sql` seeds these rates for every studio **only where the studio has no
rate card yet**. A studio's own edits (Control Center → Item pricing) are never overwritten. The
same numbers live in `ITEM_SPEC.DEFAULT_RATES` (`public/store-api.js`) and `public._a86_default_rates()`.
A unit test keeps the two copies identical.

**How these numbers were set.** They are *starting points*, picked from typical 2025–26 rental
ranges for tier‑1/tier‑2 Indian cities (Hyderabad, Bengaluru, Pune, Delhi NCR). The sources were
vendor rate lists and listings on event‑rental and wedding marketplaces. Rates change a lot by
city, season (Nov–Feb wedding peak), distance and vendor tier, so each studio should review its
card before quoting. None of these numbers was scraped live. All prices are before GST; Helm adds
tax through the normal quote pricing.

| Item | Formula | Default rates | Typical market range (reasoning) |
|---|---|---|---|
| **Stage** | base + L×W(m²)×rate + max(0, H − std)×m²×height surcharge | ₹450/m², base ₹0, std height 0.6 m, ₹150 per m² per extra metre | Platform/riser stages with carpet usually rent for ₹25–60 per sq ft (₹270–650/m²). ₹450/m² is mid‑range. Raised stages (>0.6 m) need extra scaffolding/legs, which adds about 30% per extra metre. Example: 8 × 5 m = 40 m² → ₹18,000. |
| **Generator (silent DG)** | (base + kVA × rate) × days, + diesel kVA × rate × days, + operator × days | base ₹2,000/day, ₹60 per kVA per day, diesel ₹100 per kVA per day, operator ₹1,000/day | DG rent without fuel is about ₹5–7k/day (62.5 kVA), ₹8–12k (125 kVA), ₹15–20k (250 kVA) and ₹30–40k (500 kVA). The formula gives ₹5,750 / ₹9,500 / ₹17,000 / ₹32,000. Diesel: about 0.15–0.2 L per kVA‑hour at partial load × ~₹90/L × ~8 h ≈ ₹100 per kVA per day. Presets: 15 / 25 / 62.5 / 125 / 250 / 500 kVA, or a custom figure. |
| **DJ** | setup + power connection + extra speakers × rate | DJ + console ₹15,000; + 2 speakers ₹25,000; + 4 speakers ₹40,000. Power: 2‑pin ₹0, 3‑pin ₹1,500, 4‑pin/3‑phase ₹4,000. Extra speaker ₹3,000 | Wedding/sangeet DJs charge ₹15–50k for 4–5 hours depending on sound. Higher‑load connections cost more: 3‑pin earthed lines, and 3‑phase distribution boards with cabling. |
| **Lighting** | per‑unit types: qty × rate; string/truss types: runs × length(m) × rate | PAR ₹600, moving head ₹2,500, uplighter ₹500 (each); fairy/string ₹40/m, truss wash ₹800/m | PAR cans ₹400–800 each, moving heads ₹2–4k each/day, fairy lights ₹25–60 per metre, lit truss ₹600–1,200 per running metre. |
| **LED wall** | W × H (m²) × rate per m² per day × days | Indoor P3.9 ₹1,100; outdoor P4.8 ₹900; outdoor P6 ₹650 (per m² per day) | LED walls rent for about ₹60–120 per sq ft per day (₹650–1,300/m²). Finer pitch costs more. |
| **Chandelier** | qty × size rate | small ₹3,000, medium ₹6,000, large ₹12,000, grand crystal ₹25,000 | Décor vendors' chandelier hire ranges from about ₹2k for small units to ₹30k+ for large crystal pieces. |
| **Photo booth** | max(hours, minimum) × hourly rate | standard ₹2,500/h, 360° ₹5,000/h, mirror ₹4,000/h; minimum 2 h | Packages run ₹8–15k (standard) and ₹15–30k (360°) for 3–4 hours. |
| **Chocolate fountain** | size base + servings × rate | small ₹6,000, medium ₹9,000, large ₹14,000; ₹40 per serving | Fountain hire ₹5–15k plus about ₹30–60 per guest for chocolate and dippables. |
| **Chariot / entry** | trips × rate | horse (ghodi) ₹15,000, vintage car ₹12,000, flower chariot ₹20,000 per trip | Baraat horse ₹10–25k, vintage car ₹8–20k, decorated buggy/chariot ₹15–35k. |
| **Smoke effects** | units × rate | cold pyro ₹2,500, low fog ₹6,000, dry ice ₹5,000 per unit | Cold pyro ₹2–4k per unit, low‑fog/dry‑ice machine with consumables ₹4–8k. |
| **Dancers** | dancers × performances (or hours) × rate | ₹3,500 per dancer per performance; ₹1,500 per dancer per hour | Troupe dancers charge ₹2–6k per performance each. Hourly rates are used for background or ambience acts. |

## Rules the engine applies
- An item is priced from its spec **only** when `item.properties.spec` is set (Adjust → Apply in the
  builder). Items without a spec keep the flat catalog price, so existing quotes do not change.
- Dimensions are stored in **metres**. The builder shows metres by default and has a feet toggle
  (1 ft = 0.3048 m).
- Each item's price is rounded to whole rupees. The quote total still rounds only once at the end
  (D7).
- Bad specs fall back to the catalog price and add a note to the line:
  - zero, negative, absurd (e.g. a 1,000 m stage) or non‑numeric values give **“spec invalid”**;
  - an option with no rate on the studio's card gives **“rate not set”**.
- Rate cards accept numbers from 0 to 1,00,00,000 only, with at most one level of options. The
  client (`ratesOk`) and the server (`_a86_rates_ok`) both check this.
- Who can change rate cards is set by the access‑matrix area **“Item pricing (rate cards)”**
  (`item_pricing`). Admins always can. Editing an item's spec on a quote is controlled by quote
  edit rights.

## Flat catalog defaults for newer builder items (2026-10)

Items **without** a spec are priced per unit from the flat catalog: the studio's own price in
Control Center → Pricing → Item prices (`config.assetPrices`) if it set one, otherwise the shipped
default below. These defaults live only in code — `OBJECT_PRICE` (`public/store-api.js`),
`DEFAULT_PRICES` (`public/builder.js`) and `ITEM_CATALOG` (`public/control.html`) — and
`test/catalog-defaults.test.mjs` keeps the three identical. **No SQL is needed and nothing is
written to any studio:** a price a studio already set always wins, and a blank Control Center field
means "use the default". Admins can override any of these in Control Center.

Before this change these items fell back to a category price (e.g. LED wall → ₹9,000, the AV
category) and the builder flagged them "price not in catalog". That flag now shows only for an item
with neither a studio price nor a shipped default. Seat-type items (chair rows, seating blocks,
round/banquet/head/cocktail tables, chiavari chairs, bar stools) are billed through the chair rate,
not here. Quotes already saved keep their stored totals; an open quote is re-priced from these
defaults only when someone re-prices it.

Each default is **per placed unit, per event day, before GST**, sized for the builder's default
footprint (feet). Typical 2025–26 tier-1/tier-2 Indian rental ranges:

| Type | Item | Default (₹/unit) | Reasoning |
|---|---|---|---|
| `led` | LED Wall | 18,000 | 16 × 9 ft ≈ 144 sq ft × ~₹125/sq ft/day (market ₹60–150/sq ft) |
| `lighting` | Lighting Truss | 9,600 | 24 ft × ₹400 per running ft (lit truss ₹600–1,200/m) |
| `walkway` | Walkway / Ramp | 6,000 | 6 × 24 ft ≈ 144 sq ft × ~₹40/sq ft (carpeted ramp/platform) |
| `brandwall` | Branding Wall | 9,600 | 20 × 8 ft = 160 sq ft × ₹60/sq ft (flex/backdrop + frame) |
| `podium` | Podium | 3,500 | Branded lectern with mic stand ₹2–5k/day |
| `barricade` | Barricade | 1,800 | 30 ft MS barricade section ≈ ₹60 per running ft |
| `stagebarrier` | Stage Barrier | 9,000 | 30 ft mojo/front-of-stage barrier ≈ ₹300 per running ft |
| `fence` | Fence Line | 1,500 | 40 ft temporary fence/rope line |
| `checkpoint` | Checkpoint | 3,000 | DFMD / frisking point ₹2.5–4k/day (staff extra) |
| `exit` | Exit Zone | 500 | Nominal: exit signage and marking only (zones are not rented) |
| `speaker` | Speaker Stack | 4,000 | Pair of tops on stands ₹3–5k/day |
| `monitor` | Stage Monitor | 1,500 | Wedge monitor ₹1–2k/day |
| `movinghead` | Moving Light | 2,500 | Same as the moving-head rate card (₹2–4k/day) |
| `uplight` | Uplight | 500 | Same as the uplighter rate card |
| `smoke` | Smoke Machine | 5,000 | Dry-ice/low-fog unit with consumables (₹4–8k) |
| `dancers` | Dancers | 14,000 | 4-dancer troupe × ₹3,500 per performance |
| `chocolatefountain` | Chocolate Fountain | 9,000 | Medium fountain (rate card) |
| `chariot` | Wedding Chariot | 20,000 | Flower chariot per trip (rate card) |
| `booth` | Expo Booth | 8,000 | 3 × 3 m octanorm shell ₹6–10k |
| `desk` | Reg Desk | 2,500 | Draped registration counter |
| `gifttable` | Gift Table | 1,500 | Draped table with décor |
| `caketable` | Cake Table | 1,500 | Draped table with décor |
| `heater` | Patio Heater | 2,500 | Gas patio heater incl. cylinder ₹2–3k/day |
| `easel` | Signage Easel | 500 | Easel + printed board |
| `distro` | Power Distro | 3,000 | Distribution board with cabling |
| `cableramp` | Cable Ramp | 600 | Rubber cable protector run |
| `lounge` | Lounge Set | 6,000 | Sofa + 2 chairs + coffee table |
| `sofa` / `loveseat` / `armchair` / `ottoman` | Lounge furniture | 2,500 / 2,000 / 1,200 / 500 | Event furniture hire |
| `bench` / `coffeetable` | Bench / Coffee table | 800 / 800 | Event furniture hire |
| `bleacher` | Bleachers | 15,000 | 24 ft tiered seating section |
| `floral` | Floral Centerpiece | 1,500 | Fresh-flower centrepiece ₹1–2.5k |
| `pillar` | Decor Pillar | 2,000 | Fibre/floral pillar |
| `drape` | Pipe & Drape | 2,400 | 16 ft × ₹150 per running ft |
| `planter` | Greenery | 800 | Potted plant / planter |

Items that already had a default keep it, for example `linearray` ₹40,000, `generator` ₹15,000,
`photobooth` ₹12,000, `truss` (tower) ₹6,000 and `subwoofer` ₹12,000. Truss tower and subwoofer
now also appear in Control Center so admins can override them.

## Indian wedding + corporate pack (2026-10)

| type | Item | Default ₹ | Basis |
|---|---|---|---|
| `entrancegate` | Entrance Gate | 25,000 | 16 ft floral gate: two pillars, crown, drapes, marigold strings |
| `phoolchadar` | Phoolon ki Chadar | 6,000 | Floral sheet on four poles for the bride's entry |
| `jhoola` | Swing / Jhoola | 12,000 | Decorated swing frame with floral wrap |
| `haldi` | Haldi Setup | 18,000 | Low platform, marigold backdrop, gaddi seating, urlis |
| `mehendi` | Mehendi Lounge | 15,000 | Floor rug, gaddis + bolsters, low tables, umbrellas |
| `selfieframe` | Selfie Frame | 3,500 | Standing floral photo frame |
| `welcomeboard` | Welcome Board | 2,500 | Printed welcome sign on easel with florals |
| `fairylights` | Fairy Light Canopy | 8,000 | 24 × 24 ft overhead strands + four posts |
| `couplesofa` | Couple Sofa | 8,000 | Maharaja-style stage sofa |
| `livecounter` | Live Food Counter | 7,000 | Skirted live-cooking counter with header |
| `kidszone` | Kids Zone | 15,000 | Bouncy castle, slide, ball pit, soft mat |
| `aircooler` | Air Cooler / Fan | 1,500 | Mist / air cooler per unit |

### Religious + ambience pack (2026-10c)

| Type | Name | Default (₹) | What it is |
|---|---|---|---|
| `havankund` | Havan Kund | 3,500 | Copper stepped fire pit on a 4 × 4 ft platform, kalash at the corners |
| `rangoli` | Rangoli / Kolam | 2,500 | 6 × 6 ft floor design (powder + petals) with diyas |
| `lanterns` | Lantern Cluster | 1,200 | Three metal lanterns (1.5 / 2.2 / 3 ft) with candles |
| `hangingfloral` | Hanging Floral Ceiling | 18,000 | 12 × 12 ft suspended floral strands + clusters at ~11 ft |
| `neonsign` | Neon Sign Wall | 4,000 | 6 ft neon script on a greenery board |

Décor **variants** (style / flower / colour story, chosen in the builder inspector) are visual only — they never change the price.

### Complete-catalogue pack (2026-10d) — generic basics + every remaining event type

| Type | Name | Default (₹) | Size / what it is |
|---|---|---|---|
| `backdrop` | Backdrop (generic) | 6,000 | 10 × 1 ft — a free-standing event backdrop wall |
| `floralstand` | Floral Stand (generic) | 1,500 | 2 × 2 ft — a floral arrangement on a stand |
| `decorbox` | Decor Item (generic) | 2,000 | 3 × 3 ft — a decorative prop |
| `signage` | Signage / Standee | 1,200 | 2.5 × 1.5 ft — a free-standing sign (no readable text) |
| `recttable` | Rectangular Table | chair rate | 6 × 2.5 ft — a rectangular table with a floor-length cloth |
| `stageroof` | Stage Roof Truss | 60,000 | 40 × 24 ft — a ground-support truss roof over the stage |
| `varmala` | Varmala Platform | 25,000 | 10 × 10 ft — a round raised varmala platform with floral edging |
| `micstand` | Mic Stand | 500 | 1 × 1 ft — a microphone on a black stand |
| `teleprompter` | Teleprompter / Confidence Monitor | 6,000 | 3 × 1.5 ft — a low confidence-monitor screen at the stage front |
| `projector` | Projector Screen | 8,000 | 12 × 2 ft — a large fast-fold projection screen on legs |
| `tvstand` | TV Screen on Stand | 4,000 | 4 × 2 ft — a large flat TV screen on a floor stand |
| `interpreter` | Interpreter Booth | 15,000 | 6 × 6 ft — a small sound-proof interpreter booth |
| `pyro` | Cold Pyro / CO2 Jet | 3,000 | 1.5 × 1.5 ft — a cold-spark fountain machine |
| `towerlight` | Mobile Light Tower | 4,000 | 5 × 5 ft — a towable floodlight tower |
| `gaddi` | Floor Seating (Gaddi) | 3,000 | 8 × 8 ft — floor seating with gaddis and bolsters on a rug |
| `urli` | Flower Urli | 2,500 | 3 × 3 ft — a brass urli bowl with floating flowers and candles |
| `umbrellas` | Decor Umbrellas | 5,000 | 8 × 8 ft — a cluster of bright hanging decor umbrellas |
| `doli` | Doli / Palki | 12,000 | 6 × 3 ft — a decorated doli palanquin |
| `kalash` | Kalash / Purna Kumbh | 800 | 1.5 × 1.5 ft — a brass kalash with a coconut and mango leaves |
| `altar` | Pooja Altar / Idol Platform | 8,000 | 6 × 4 ft — a raised pooja altar with a draped back |
| `shoerack` | Shoe Rack | 1,000 | 6 × 1.5 ft — a low shoe rack |
| `dessert` | Dessert / Candy Table | 3,500 | 8 × 2.5 ft — a dessert table with tiered cake stands and sweets |
| `coffee` | Coffee / Tea Station | 3,000 | 6 × 2.5 ft — a coffee and tea station with urns and cups |
| `stall` | Food / Merch Stall | 6,000 | 10 × 10 ft — a canopy stall with a counter |
| `counter` | Display Counter | 2,500 | 4 × 2 ft — a lit product display counter |
| `plinth` | Display Plinth | 1,000 | 1.5 × 1.5 ft — a white display plinth |
| `kiosk` | Check-in Kiosk | 3,000 | 2 × 2 ft — a self check-in kiosk with a touch screen |
| `ticketbooth` | Ticket Booth | 5,000 | 8 × 6 ft — a small ticket booth cabin |
| `stanchion` | Stanchions (rope & post) | 1,200 | 10 × 1 ft — a row of chrome stanchions with a velvet rope |
| `watchtower` | Watch Tower / CCTV | 8,000 | 6 × 6 ft — a scaffold watch tower with CCTV cameras |
| `extinguisher` | Fire Point | 300 | 1.5 × 1 ft — a red fire extinguisher point |
| `ambulance` | Ambulance Bay | 6,000 | 22 × 9 ft — an ambulance parked in a marked bay |
