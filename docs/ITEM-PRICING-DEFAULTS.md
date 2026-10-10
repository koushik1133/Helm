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
