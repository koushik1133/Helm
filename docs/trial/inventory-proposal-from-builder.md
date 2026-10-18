# Inventory proposal from the 2D/3D builder (REVIEW ONLY - not loaded)

Trial data v4 (migration 0170) loaded the owner's 10 inventory items. This file lists every product in the
2D/3D builder (`public/builder.js`, `ASSETS`, 142 types) that has **no matching item yet** in the sample
master's inventory (47 items after 0170), as a proposed inventory row for the owner to tick.

**Nothing in this file is in the database.** Tick the rows you want (and change qty / rate / replacement cost);
the ticked rows can then be added to the sample master in a later migration (0171+) and published as manifest v5.

How the numbers were made:
- **Rental rate** = the builder's per-unit price `DEFAULT_PRICES[type]` (Rs, per event). Where the builder has no
  per-type price it uses its category fallback (structure 15,000, seating 2,500, AV 9,000, security 2,000,
  logistics 4,000, safety 1,500, decor 12,000) - marked "category fallback"; those usually need the owner's number.
  "+ rate card" = the item is also priced by spec from the studio's item price list (`item_rate_cards`, 0168);
  the quote then uses the rate card, not this number.
- **Suggested qty** = a typical stock for a mid-size Hyderabad planner (owner to correct).
- **Replacement cost** = an estimate (rental rate x 5-15 depending on category, rounded) - stored as
  `attributes.replacement_cost` like the existing sample items. Please replace with real purchase prices.
- Names would carry the "Demo · " prefix like every other sample inventory row.

**86 proposed items** in 7 groups.

## Stage & structures (9)

| Add? | Proposed item | Builder type | Suggested qty | Unit | Rental rate | Rate source | Replacement cost (est.) |
|---|---|---|---|---|---|---|---|
| [ ] | Demo · Truss Tower | `truss` | 8 | pcs | Rs 6,000 | builder | Rs 48,000 |
| [ ] | Demo · Greenery | `planter` | 20 | pcs | Rs 800 | builder | Rs 6,400 |
| [ ] | Demo · VIP Riser | `viprisers` | 4 | pcs | Rs 18,000 | builder | Rs 1,40,000 |
| [ ] | Demo · Walkway / Ramp | `walkway` | 10 | pcs | Rs 6,000 | builder | Rs 48,000 |
| [ ] | Demo · Entrance Gate | `entrancegate` | 1 | pcs | Rs 25,000 | builder | Rs 2,00,000 |
| [ ] | Demo · Dais with Chairs | `dais` | 1 | sets | Rs 30,000 | builder | Rs 2,40,000 |
| [ ] | Demo · Banner / Hoarding Frame | `hoarding` | 6 | pcs | Rs 12,000 | builder | Rs 96,000 |
| [ ] | Demo · Stage Roof Truss | `stageroof` | 1 | sets | Rs 60,000 | builder | Rs 4,80,000 |
| [ ] | Demo · Varmala Platform | `varmala` | 1 | pcs | Rs 25,000 | builder | Rs 2,00,000 |

## Seating & furniture (10)

| Add? | Proposed item | Builder type | Suggested qty | Unit | Rental rate | Rate source | Replacement cost (est.) |
|---|---|---|---|---|---|---|---|
| [ ] | Demo · Head Table | `headtable` | 4 | pcs | Rs 2,500 | category fallback | Rs 15,000 |
| [ ] | Demo · Sofa | `sofa` | 10 | pcs | Rs 2,500 | builder | Rs 15,000 |
| [ ] | Demo · Loveseat | `loveseat` | 10 | pcs | Rs 2,000 | builder | Rs 12,000 |
| [ ] | Demo · Armchair | `armchair` | 20 | pcs | Rs 1,200 | builder | Rs 7,200 |
| [ ] | Demo · Ottoman | `ottoman` | 30 | pcs | Rs 500 | builder | Rs 3,000 |
| [ ] | Demo · Bench | `bench` | 20 | pcs | Rs 800 | builder | Rs 4,800 |
| [ ] | Demo · Coffee Table | `coffeetable` | 15 | pcs | Rs 800 | builder | Rs 4,800 |
| [ ] | Demo · Bar Stool | `barstool` | 30 | pcs | Rs 2,500 | category fallback | Rs 15,000 |
| [ ] | Demo · Bleachers | `bleacher` | 2 | sets | Rs 15,000 | builder | Rs 90,000 |
| [ ] | Demo · Floor Seating (Gaddi) | `gaddi` | 40 | pcs | Rs 3,000 | builder | Rs 18,000 |

## Audio, video & lighting (15)

| Add? | Proposed item | Builder type | Suggested qty | Unit | Rental rate | Rate source | Replacement cost (est.) |
|---|---|---|---|---|---|---|---|
| [ ] | Demo · Press Riser | `press` | 1 | pcs | Rs 15,000 | builder | Rs 1,50,000 |
| [ ] | Demo · DJ Booth | `dj` | 1 | pcs | Rs 10,000 | builder + rate card | Rs 1,00,000 |
| [ ] | Demo · Photo Booth | `photobooth` | 1 | pcs | Rs 12,000 | builder + rate card | Rs 1,20,000 |
| [ ] | Demo · Grand Piano | `piano` | 1 | pcs | Rs 30,000 | builder | Rs 4,50,000 |
| [ ] | Demo · Subwoofer | `subwoofer` | 6 | pcs | Rs 12,000 | builder | Rs 1,20,000 |
| [ ] | Demo · Stage Monitor | `monitor` | 6 | pcs | Rs 1,500 | builder | Rs 15,000 |
| [ ] | Demo · FOH Console | `foh` | 1 | sets | Rs 20,000 | builder | Rs 2,00,000 |
| [ ] | Demo · Lighting Truss | `lighting` | 4 | pcs | Rs 9,600 | builder + rate card | Rs 96,000 |
| [ ] | Demo · Smoke Machine | `smoke` | 4 | pcs | Rs 5,000 | builder + rate card | Rs 50,000 |
| [ ] | Demo · Lighting Tree (T-Bar) | `lightingtree` | 8 | pcs | Rs 3,500 | builder | Rs 35,000 |
| [ ] | Demo · Mic Stand | `micstand` | 12 | pcs | Rs 500 | builder | Rs 5,000 |
| [ ] | Demo · Teleprompter / Confidence Monitor | `teleprompter` | 2 | pcs | Rs 6,000 | builder | Rs 60,000 |
| [ ] | Demo · TV Screen on Stand | `tvstand` | 6 | pcs | Rs 4,000 | builder | Rs 40,000 |
| [ ] | Demo · Interpreter Booth | `interpreter` | 2 | pcs | Rs 15,000 | builder | Rs 1,50,000 |
| [ ] | Demo · Cold Pyro / CO2 Jet | `pyro` | 6 | pcs | Rs 3,000 | builder | Rs 30,000 |

## Decor & florals (26)

| Add? | Proposed item | Builder type | Suggested qty | Unit | Rental rate | Rate source | Replacement cost (est.) |
|---|---|---|---|---|---|---|---|
| [ ] | Demo · Floral Arch | `floralarch` | 2 | pcs | Rs 15,000 | builder | Rs 90,000 |
| [ ] | Demo · Decor Pillar | `pillar` | 12 | pcs | Rs 2,000 | builder | Rs 12,000 |
| [ ] | Demo · Pipe & Drape | `drape` | 20 | sets | Rs 2,400 | builder | Rs 14,000 |
| [ ] | Demo · Fountain | `fountain` | 1 | pcs | Rs 20,000 | builder | Rs 1,20,000 |
| [ ] | Demo · Wedding Chariot | `chariot` | 1 | pcs | Rs 20,000 | builder + rate card | Rs 1,20,000 |
| [ ] | Demo · Swing / Jhoola | `jhoola` | 1 | pcs | Rs 12,000 | builder | Rs 72,000 |
| [ ] | Demo · Haldi Setup | `haldi` | 1 | sets | Rs 18,000 | builder | Rs 1,10,000 |
| [ ] | Demo · Mehendi Lounge | `mehendi` | 1 | sets | Rs 15,000 | builder | Rs 90,000 |
| [ ] | Demo · Selfie Frame | `selfieframe` | 2 | pcs | Rs 3,500 | builder | Rs 21,000 |
| [ ] | Demo · Welcome Board | `welcomeboard` | 4 | pcs | Rs 2,500 | builder | Rs 15,000 |
| [ ] | Demo · Garland Toran | `toran` | 10 | pcs | Rs 4,000 | builder | Rs 24,000 |
| [ ] | Demo · Floral Pillar | `floralpillar` | 8 | pcs | Rs 4,500 | builder | Rs 27,000 |
| [ ] | Demo · Aisle Floral Stand | `aislefloral` | 16 | pcs | Rs 1,800 | builder | Rs 11,000 |
| [ ] | Demo · Balloon Arch | `balloonarch` | 2 | frames | Rs 6,000 | builder | Rs 36,000 |
| [ ] | Demo · Flag Stand | `flagstand` | 10 | pcs | Rs 1,500 | builder | Rs 9,000 |
| [ ] | Demo · Brass Deepam Stand | `diyastand` | 10 | pcs | Rs 2,500 | builder | Rs 15,000 |
| [ ] | Demo · Havan Kund | `havankund` | 2 | pcs | Rs 3,500 | builder | Rs 21,000 |
| [ ] | Demo · Lantern Cluster | `lanterns` | 10 | sets | Rs 1,200 | builder | Rs 7,200 |
| [ ] | Demo · Hanging Floral Ceiling | `hangingfloral` | 2 | sets | Rs 18,000 | builder | Rs 1,10,000 |
| [ ] | Demo · Neon Sign Wall | `neonsign` | 4 | pcs | Rs 4,000 | builder | Rs 24,000 |
| [ ] | Demo · Floral Stand (generic) | `floralstand` | 20 | pcs | Rs 1,500 | builder | Rs 9,000 |
| [ ] | Demo · Decor Umbrellas | `umbrellas` | 4 | sets | Rs 5,000 | builder | Rs 30,000 |
| [ ] | Demo · Doli / Palki | `doli` | 1 | pcs | Rs 12,000 | builder | Rs 72,000 |
| [ ] | Demo · Kalash / Purna Kumbh | `kalash` | 10 | pcs | Rs 800 | builder | Rs 4,800 |
| [ ] | Demo · Pooja Altar / Idol Platform | `altar` | 1 | pcs | Rs 8,000 | builder | Rs 48,000 |
| [ ] | Demo · Display Plinth | `plinth` | 10 | pcs | Rs 1,000 | builder | Rs 6,000 |

## Logistics & guest services (19)

| Add? | Proposed item | Builder type | Suggested qty | Unit | Rental rate | Rate source | Replacement cost (est.) |
|---|---|---|---|---|---|---|---|
| [ ] | Demo · Expo Booth | `booth` | 10 | pcs | Rs 8,000 | builder | Rs 48,000 |
| [ ] | Demo · Bar | `bar` | 2 | sets | Rs 12,000 | builder | Rs 72,000 |
| [ ] | Demo · Gift Table | `gifttable` | 2 | pcs | Rs 1,500 | builder | Rs 9,000 |
| [ ] | Demo · Cake Table | `caketable` | 2 | pcs | Rs 1,500 | builder | Rs 9,000 |
| [ ] | Demo · Patio Heater | `heater` | 10 | pcs | Rs 2,500 | builder | Rs 15,000 |
| [ ] | Demo · Signage Easel | `easel` | 10 | pcs | Rs 500 | builder | Rs 3,000 |
| [ ] | Demo · Power Distro | `distro` | 4 | pcs | Rs 3,000 | builder | Rs 18,000 |
| [ ] | Demo · Cable Ramp | `cableramp` | 20 | pcs | Rs 600 | builder | Rs 3,600 |
| [ ] | Demo · Chocolate Fountain | `chocolatefountain` | 1 | pcs | Rs 9,000 | builder + rate card | Rs 54,000 |
| [ ] | Demo · Trophy Display | `trophytable` | 2 | pcs | Rs 3,000 | builder | Rs 18,000 |
| [ ] | Demo · Signage / Standee | `signage` | 20 | pcs | Rs 1,200 | builder | Rs 7,200 |
| [ ] | Demo · Mobile Light Tower | `towerlight` | 4 | pcs | Rs 4,000 | builder | Rs 24,000 |
| [ ] | Demo · Shoe Rack | `shoerack` | 6 | pcs | Rs 1,000 | builder | Rs 6,000 |
| [ ] | Demo · Dessert / Candy Table | `dessert` | 2 | pcs | Rs 3,500 | builder | Rs 21,000 |
| [ ] | Demo · Coffee / Tea Station | `coffee` | 2 | sets | Rs 3,000 | builder | Rs 18,000 |
| [ ] | Demo · Food / Merch Stall | `stall` | 10 | pcs | Rs 6,000 | builder | Rs 36,000 |
| [ ] | Demo · Display Counter | `counter` | 6 | pcs | Rs 2,500 | builder | Rs 15,000 |
| [ ] | Demo · Check-in Kiosk | `kiosk` | 4 | pcs | Rs 3,000 | builder | Rs 18,000 |
| [ ] | Demo · Ticket Booth | `ticketbooth` | 2 | pcs | Rs 5,000 | builder | Rs 30,000 |

## Security & crowd control (6)

| Add? | Proposed item | Builder type | Suggested qty | Unit | Rental rate | Rate source | Replacement cost (est.) |
|---|---|---|---|---|---|---|---|
| [ ] | Demo · Barricade | `barricade` | 40 | pcs | Rs 1,800 | builder | Rs 11,000 |
| [ ] | Demo · Fence Line | `fence` | 60 | pcs | Rs 1,500 | builder | Rs 9,000 |
| [ ] | Demo · Checkpoint | `checkpoint` | 2 | sets | Rs 3,000 | builder | Rs 36,000 |
| [ ] | Demo · Stage Barrier | `stagebarrier` | 20 | pcs | Rs 9,000 | builder | Rs 54,000 |
| [ ] | Demo · Stanchions (rope & post) | `stanchion` | 30 | sets | Rs 1,200 | builder | Rs 7,200 |
| [ ] | Demo · Watch Tower / CCTV | `watchtower` | 2 | pcs | Rs 8,000 | builder | Rs 48,000 |

## Safety (1)

| Add? | Proposed item | Builder type | Suggested qty | Unit | Rental rate | Rate source | Replacement cost (est.) |
|---|---|---|---|---|---|---|---|
| [ ] | Demo · Fire Point | `extinguisher` | 20 | pcs | Rs 300 | builder | Rs 2,400 |

## Already covered by the sample inventory (41) - not proposed

| Builder product | Type | Covered by (inventory item, Demo · prefix) |
|---|---|---|
| Main Stage | `stage` | Stage platform 8x4 ft |
| Dance Floor | `dancefloor` | Dance floor panel 4x4 ft |
| Podium | `podium` | Lectern / Podium |
| Chair Row | `chairrow` | chairs (Chiavari / Banquet / Conference) |
| Seating Block | `seatblock` | chairs (Chiavari / Banquet / Conference) |
| Round Table | `table` | Round Table |
| Reg Desk | `desk` | Registration Desk |
| Canopy | `canopy` | Shamiana 20x20 ft |
| Arch / Backdrop | `arch` | Stage backdrop frame 24x10 ft |
| Tent | `tent` | German hangar tent 20x30 m |
| Banquet Table | `longtable` | Rectangular table 6x2.5 ft |
| Cocktail Table | `cocktail` | Cocktail table (high) |
| Lounge Set | `lounge` | Lounge sofa set (3 pc) |
| Buffet Line | `buffet` | Chafing dish (stainless) |
| LED Screen | `ledscreen` | LED Screen Panel |
| Speaker Stack | `speaker` | PA Speaker |
| Carpet / Aisle | `redcarpet` | Red carpet (30 m roll) |
| Floral Centerpiece | `floral` | Centrepiece vase set |
| Decor Mandap | `mandap` | Floral mandap set |
| Chandelier | `chandelier` | Crystal chandelier |
| Uplight | `uplight` | Uplighter (battery) |
| Chair (single) | `chiavari` | Chiavari chair (gold) / Banquet chair / Conference Chair |
| Line Array | `linearray` | Line array speaker |
| Moving Light | `movinghead` | Moving head light |
| LED Video Wall | `videowall` | LED wall panel / LED Screen Panel |
| Generator | `generator` | Generator 125 kVA |
| LED Wall | `led` | LED wall panel / LED Screen Panel |
| Branding Wall | `brandwall` | Branded Backdrop Frame |
| Fairy Light Canopy | `fairylights` | Fairy lights (10 m) |
| Couple Sofa | `couplesofa` | Maharaja sofa (stage) |
| Air Cooler / Fan | `aircooler` | Air cooler (industrial) |
| Entrance Floral Arch | `floralentrance` | Entrance arch (floral) |
| Stage Floral Backdrop | `stagebackdrop` | Stage backdrop frame 24x10 ft |
| Flower Wall | `flowerwall` | Artificial flower wall 8x8 ft |
| Tall Centrepiece | `centrepiece` | Centrepiece vase set |
| Lectern | `lectern` | Lectern / Podium |
| PA Tower | `patower` | PA Speaker |
| Backdrop (generic) | `backdrop` | Stage backdrop frame 24x10 ft |
| Rectangular Table | `recttable` | Rectangular table 6x2.5 ft |
| Projector Screen | `projector` | Projector + 10 ft screen |
| Flower Urli | `urli` | Brass urli with floating candles |

## Not stock items (15) - not proposed

Zones on the floor plan, services bought from a vendor, consumables or generic placeholders.

| Builder product | Type | Why not inventory |
|---|---|---|
| Food Truck | `truck` | food truck (vendor) |
| Exit Zone | `exit` | zone on the plan |
| Restrooms | `restroom` | mobile toilet vendor |
| Coat Check | `coatcheck` | zone / service |
| First Aid | `firstaid` | service (medical vendor) |
| Parking Zone | `parking` | zone on the plan |
| Green Room | `greenroom` | zone on the plan |
| Dancers | `dancers` | performers (vendor) |
| Phoolon ki Chadar | `phoolchadar` | fresh flowers (florist, consumable) |
| Live Food Counter | `livecounter` | catering service (caterer) |
| Kids Zone | `kidszone` | activity vendor |
| Balloon Bouquet | `balloonbunch` | balloons (consumable) |
| Rangoli / Kolam | `rangoli` | artist service / consumable |
| Decor Item (generic) | `decorbox` | generic placeholder |
| Ambulance Bay | `ambulance` | service (medical vendor) |
