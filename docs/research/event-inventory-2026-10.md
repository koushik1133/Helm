# Event inventory research — what is physically present at each kind of event (Oct 2026)

Purpose: ground the Helm 2D/3D builder catalogue in what décor / rental companies actually supply, with real-world sizes,
so a layout looks like the real event. Sizes are typical rental-stock sizes (vendors vary ±20%). Quantities are planning
ratios **per 100 guests** unless stated. "Builder" column = the Helm catalogue type (and variant) that represents it.

Sources (searched 2026-10-15; vendor/blog sources, so treat numbers as rules of thumb, confirm with local vendors):
- Arch shapes & sizes (round 8–10 ft tall × 6–8 ft wide; hexagon 7–9 ft × 8–10 ft; square/septagon; indoor 6–8 ft): [Alibaba Reads – guide to wedding arches](https://reads.alibaba.com/elevate-your-big-day-a-comprehensive-guide-to-wedding-arches-2), [Poppy – ceremony arch & backdrop styles](https://www.poppyflowers.com/help/articles/wedding-ceremony-arch-backdrop-styles-complete-guide), [7.2 ft square wooden arch frame listing](https://woodartsupply.com/products/s-afstar-7-2ft-square-wedding-arch-frame-wooden-balloon-floral-arch-stand-w-triangular-shaped-base-4-u-shaped-stakes-indoor-outdoor-wood-arbor-backdrop-stand-for-wedding-ceremony-party)
- Mandap styles (four pillars, South Indian with kolam / coconut fronds / brass lamps, modern white canopy, round mandap): [Manyavar – significance of the mandap](https://www.manyavar.com/en-in/blog-decoding-spiritual-significance-of-wedding-mandap.html), [Interflora – mandap décor ideas](https://www.interflora.in/blog/7-beautiful-mandap-decor-ideas-to-jazz-up-your-wedding-decoration), [Housing.com – mandap decoration](https://housing.com/news/mandap-decoration-at-home), [Lin & Jirsa – mandap tradition](https://www.linandjirsa.com/mandap-indian-wedding-tradition)
- Rental ratios (60" round per 8 guests, +10 spare chairs, 1.25 plates/guest buffet, 3–5 plates/guest cocktail): [Reservety estimator](https://reservety.com/tools/event-rental-cost-estimator.html), [Hill Country wedding checklist](https://intercom.help/hill-country-event-rentals/en/articles/15787126-wedding-rental-checklist), [Hill Country corporate checklist](https://intercom.help/hill-country-event-rentals/en/articles/15787164-corporate-event-rental-checklist), [Joy – wedding rentals 101](https://withjoy.com/blog/wedding-rentals-101)
- Remaining sizes (stages, LED, truss, AV) are standard Indian event-production stock already used in `docs/ITEM-PRICING-DEFAULTS.md`.

## 1. Weddings — Indian (ceremony, reception, sangeet, mehendi, haldi)

| Item | Typical size | Materials / looks | Qty / 100 guests | Builder |
|---|---|---|---|---|
| Mandap — four-pillar dome | 12×12 to 16×16 ft, 10–12 ft pillars + dome | carved gold/wood pillars, red/ivory drapes, marigold + rose | 1 | `mandap` (style: default) |
| Mandap — flat floral canopy | 14×14 ft | white fabric ceiling, hanging jasmine/rose strands | 1 | `mandap` style `flat` |
| Mandap — South Indian | 12×12 ft | banana-stem pillars, coconut fronds, kolam, brass kuthu vilakku | 1 | `mandap` style `south` (+ `rangoli`, `diyastand`) |
| Mandap — modern acrylic | 14×14 ft | clear acrylic/glass pillars, all-white florals | 1 | `mandap` style `glass` |
| Havan kund | 2×2 ft pit on 4×4 ft platform | copper / brick, kalash | 1 per ceremony | `havankund` (new) |
| Stage (reception) | 24–40 × 12–16 ft, 2–3 ft high | carpeted deck, skirting, steps | 1 | `stage` |
| Stage backdrop | stage width × 10–14 ft | floral frame / drapes / tufted panels / LED / carved jaali | 1 | `stagebackdrop` styles `''/drape/panel/led/jaali` |
| Couple sofa | 6–7 × 3 ft | carved gold maharaja sofa | 1 | `couplesofa` |
| Entrance gate | 14–20 ft wide × 12–16 ft tall | pillars + crown, sheer drapes, marigold strings | 1 per gate | `entrancegate` styles |
| Entrance floral arch | 8–10 ft tall, 6–14 ft wide | round, hexagon, ring/moon-gate, square, rustic wood, pillar gate, floral tunnel | 1–2 | `floralentrance` / `floralarch` styles |
| Phoolon ki chadar | 8×8 ft canopy on 4 poles | rose/jasmine sheet | 1 (bride entry) | `phoolchadar` |
| Toran / bandhanwar | door width × 1 ft drop | marigold + mango leaf | per door | `toran` |
| Aisle stands | 4–5 ft, every 6–8 ft of aisle | gold stands + bouquets | 6–10 per aisle | `aislefloral` |
| Floral pillars | 7 ft × 2.5 ft | wrapped columns | 2–4 (stage flanks) | `floralpillar` |
| Flower wall / photo wall | 8×8 ft | rose / hydrangea / greenery | 1 | `flowerwall` |
| Hanging floral ceiling | 12×12 ft zone at 10–12 ft | suspended strands + clusters | over dance floor / mandap | `hangingfloral` (new) |
| Rangoli / kolam | 4–8 ft dia | coloured powder, petals, diyas | 1–2 (entrance, mandap) | `rangoli` (new) |
| Deepam / samai stand | 5 ft brass | lit wicks | 2 | `diyastand` |
| Haldi setup | 14×10 ft | yellow platform, marigold ladis, brass urlis | 1 | `haldi` |
| Mehendi lounge | 16×12 ft | gaddis, bolsters, umbrellas, low tables | 1 | `mehendi` |
| Jhoola / swing | 8×4 ft | gold frame + flowers | 1 | `jhoola` |
| Selfie frame / neon sign | 6 ft wide | floral frame / neon on greenery | 1–2 | `selfieframe`, `neonsign` (new) |
| Welcome board | 3×2.5 ft on easel | acrylic / floral spray | 1 per entrance | `welcomeboard` |
| Round tables (60") + 8–10 chairs | 5–6 ft dia | floor-length cloth, charger plates, centrepiece | 12–13 + 10 spare chairs | `table` (seats) |
| Centrepieces | tall 4–5.5 ft / low 1 ft / lantern | candelabra + floral ball, bowl, lantern + candles | 1 per table | `centrepiece` styles `''/low/lantern`, `floral` |
| Lanterns | 1.5–3 ft | metal + glass + candles | aisle / tables / entrance | `lanterns` (new) |
| Chandeliers | 3–5 ft | crystal | 2–6 | `chandelier` |
| Fairy-light canopy | 24×24 ft | warm strands from a ring | 1 | `fairylights` |
| Uplighters | 1 ft | LED par | 8–12 | `uplight` |
| Lighting trees (T-bar) | 3 ft base, 8–10 ft | tripod + 4 par | 2–4 | `lightingtree` |
| Dance floor | 16×16 – 24×24 ft (≈ 1/3 guests × 4.5 sq ft) | parquet / LED / vinyl | 1 | `dancefloor` |
| DJ console | 8×5 ft | facade + truss | 1 | `dj` |
| Buffet line | 18×3 ft per ~100 guests | skirted, chafing dishes | 1–2 | `buffet` |
| Live counters | 8×4 ft | griddle + header | 2–4 | `livecounter` |
| Bar | 14×4 ft | — | 1 per 100 (if served) | `bar` |
| Cake / gift tables | 4×4 / 6×2.5 ft | skirted | 1 each | `caketable`, `gifttable` |
| Photo booth | 8×8 ft | backdrop + props | 1 | `photobooth` |
| Chariot / doli | 12×6 ft | white & gold | 1 | `chariot` |
| Kids zone | 20×16 ft | bouncy castle, ball pit | 1 | `kidszone` |
| Air coolers / fans | 2.5 ft | mist coolers | 1 per 25 guests (summer) | `aircooler` |

### Flower types & colour stories (now selectable as properties, not separate products)
Roses, marigold (genda), orchids, hydrangea, jasmine / mogra, carnations, lilies, mixed garden.
Palettes: blush & ivory, all-white, marigold yellow-orange (haldi), red & gold (ceremony), pastels (mehendi/day), jewel tones (sangeet), white & greenery (modern), rainbow (birthday), gold & chrome (balloons / galas).

## 2. Weddings — western ceremony + reception
Ceremony arch (round / hexagon / square / wooden arbour / moon gate), aisle runner (3–4 ft × aisle length), aisle florals or lanterns every 2–3 rows, chiavari/ghost/cross-back chairs in rows (ceremony = theatre rows, 18–24 in per chair), head table / sweetheart table, banquet (8×2.5 ft, 8–10 per) or 60"/72" rounds, cocktail tables (30" dia, 1 per 8–10 standing guests), lounge sofas, dance floor, cake table, bar, uplighting, drapery. Builder: `floralarch` styles, `redcarpet`, `aislefloral`, `lanterns`, `chiavari`, `chairrow`, `headtable`, `longtable`, `cocktail`, `lounge`, `sofa`.

## 3. Corporate / conference / product launch
Stage 24–40 × 12–16 ft; LED wall 16×9 ft (P3.9 indoor) or 2 side screens; podium/lectern 2.5×2 ft; panel seating (armchairs/sofas + coffee table on stage); layouts — theatre (≈ 8 sq ft/person), classroom (≈ 15–18 sq ft), boardroom, cabaret rounds; registration desks (1 per 150–200 guests, 8×2.5 ft); branding wall / step-and-repeat 8–20 ft; expo booths 10×10 ft; ground truss 20–40 ft spans; line arrays + FOH (8×8 ft); cocktail tables; coffee-break buffet. Builder: `stage`, `led`/`ledscreen`/`videowall`, `lectern`/`podium`, `armchair`, `seatblock`, `chairrow`, `desk`, `brandwall`, `booth`, `lighting`, `truss`, `linearray`, `foh`, `cocktail`, `buffet`.

## 4. Birthday / kids parties
Balloon arch (organic / classic spiral / ring hoop / garland over a backdrop), balloon bouquets, themed backdrop 8×8 ft, cake table, kids play (bouncy castle 15×15 ft, ball pit, slide), gift table, candy/dessert table, photo booth, neon sign, DJ + small dance floor. Builder: `balloonarch` styles + palettes, `balloonbunch`, `caketable`, `kidszone`, `gifttable`, `photobooth`, `neonsign`, `dj`, `dancefloor`.

## 5. Concerts / festivals
Main stage 40×24 ft+ with roof truss; line arrays flown or ground-stacked (2 per side), subwoofers, monitors, FOH 30–40 m from the stage, moving heads, LED video walls (IMAG screens), front-of-stage barricade with pit (1–1.5 m), crowd barricades, generators, power distros, cable ramps, green room, VIP riser, toilets (1 per 100 for 6+ hrs), first aid, food trucks. Builder: `stage`, `linearray`, `subwoofer`, `monitor`, `foh`, `movinghead`, `videowall`, `stagebarrier`, `barricade`, `generator`, `distro`, `cableramp`, `greenroom`, `viprisers`, `restroom`, `firstaid`, `truck`, `patower`.

## 6. Galas / award nights
Red carpet (4–6 ft × 30–60 ft) with stanchions, step-and-repeat 8–16 ft, trophy table, stage + LED + lectern, chandeliers, tall centrepieces, uplighting, lounge, bar. Builder: `redcarpet`, `barricade`, `brandwall`, `trophytable`, `stage`, `led`, `lectern`, `chandelier`, `centrepiece`, `uplight`, `lounge`, `bar`.

## 7. Cultural / religious (puja, satsang, griha pravesh, festivals)
Pooja platform / small stage, havan kund, rangoli / kolam, brass deepam stands, kalash, toran at doors, marigold backdrop, floor seating (gaddis/durries) or theatre rows, prasad / buffet counter, PA system. Builder: `stage`, `havankund`, `rangoli`, `diyastand`, `toran`, `stagebackdrop` (palette marigold), `mehendi` (floor seating), `seatblock`, `buffet`, `patower`.

## 8. Political rallies / public meetings
Large stage with dais, podium, flag stands, hoarding / banner frames, PA towers, LED screens, press riser, barricades, walkway, generator. Florals are denied by event rules. Builder: existing political pack.

## 9. Complete-catalogue pass (2026-10d) — gaps filled + generic basics
Every event type above now has its pieces in the builder. New products (sizes = typical rental stock, ft):
- **Generic basics** (for anything not specifically modelled): `backdrop` 10×1 (styles: plain fabric, printed flex, sequin, greenery, wooden panel, balloon wall), `floralstand` 2×2 (tall stand, urn, pedestal bowl, hoop), `decorbox` 3×3 (box, cylinder, sphere, flat cut-out), `signage` 2.5×1.5 (roll-up, standee, A-frame, directional post, digital standee, life-size cut-out), `recttable` 6×2.5 (classroom / registration, 3 seats), `chiavari` = "Chair (single)" (gold chiavari, ghost, cross-back, folding, banquet cover + sash, plastic). Existing generic `arch`, `stage`, `table`, `uplight` stay.
- **Indian wedding / mehendi / haldi / sangeet**: `varmala` 10×10 platform, `umbrellas` 8×8 hanging umbrella cluster, `doli` 6×3, `urli` 3×3, `kalash` 1.5×1.5, `gaddi` 8×8 floor seating, `pyro` cold pyro / CO2 / confetti (entries + sangeet).
- **Corporate / conference**: `projector` 12 ft fast-fold screen, `tvstand` 65" screen, `teleprompter` confidence monitor, `micstand`, `interpreter` 6×6 booth, `kiosk` self check-in, `coffee` tea/coffee station, `stanchion` rope & post.
- **Exhibitions**: `counter` 4×2 display counter, `plinth` 1.5×1.5, `stall` 10×10 (canopy or hard-top kiosk).
- **Concerts / festivals**: `stageroof` 40×24 ground-support roof, `ticketbooth` 8×6, `towerlight` mobile light tower, `watchtower` CCTV tower, `ambulance` bay, `extinguisher` fire point.
- **Religious / cultural**: `altar` 6×4 pooja altar, `kalash`, `shoerack`, `gaddi`.
- **Birthdays**: `dessert` candy / dessert table (+ existing balloon arch styles, kids zone, neon sign).
Toolbox is now organised in 13 sections (Generic basics · Stage & presentation · Screens, sound & effects · Lighting · Seating & tables · Florals & mandap · Wedding functions · Religious & cultural · Balloons, kids & party · Food & beverage · Branding, expo & registration · Crowd, security & safety · Venue & logistics); search covers names, section names and synonyms.
