# demo-9 hero — options

Today the hero is type only: the headline "Run every event like clockwork", the lede, CTAs and a trust marquee over a drifting emerald mesh. The product film (`#heroVidWrap`) is `hidden` because its assets aren't there yet. The copy is strong. The weakness is that nothing above the fold shows the product, and visitors only see a product picture in the converge and morph sections.

## Option A — Product poster under the headline (recommended)
Show the existing `../mk/media/plan-to-3d-poster.webp` inside `.stage-frame` right below the CTAs, as a browser-chrome card that rises 24px and fades in on load (transform and opacity only). When the hero.webm/mp4 files exist, the same frame switches to the video. Proof above the fold, no new assets, and the emerald palette stays.

## Option B — Split hero (copy left, live plan right)
Left-aligned copy beside a cropped 2D-plan card with two floating `.gc` chips ("Quote approved", "Crew confirmed") that use the existing card styles. Feels more like a SaaS page but takes more layout work at 390px, and it duplicates the converge section further down.

## Option C — Headline that plays the 2D→3D morph
Put the three morph images (2D, 3D, render) behind a soft mask and cross-fade them on a 6s loop. Most cinematic, but it repeats the morph chapter and costs image decode on first paint, which hurts LCP.

## Recommendation
Go with A. Not implemented in this pass. It changes LCP and above-the-fold composition, so the owner should check it visually first. It needs: remove `hidden` from `#heroVidWrap`, show the poster `<img>` when there are no video sources, and add a `.hero-vid{animation:rise .9s var(--out) both .25s}` rule.
