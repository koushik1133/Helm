# Event background image prompts (photo, 16:9, >=1920x1080, export .webp <350KB)
Common: photorealistic, cinematic, shallow depth of field, no text, no logos, no brand banners, faces softly blurred, leave calm negative space on the left for headline overlay.

- wedding.webp — Elegant evening wedding reception in a grand ballroom; round tables in white linen, tall white-rose and eucalyptus centerpieces, warm string lights and candles, guests softly blurred dancing in background, warm bokeh.
- corporate.webp — Modern corporate conference hall; seated audience facing a stage with a speaker and a large blank glowing screen, cool blue plus warm stage light, documentary style.
- birthday.webp — Joyful indoor birthday party; pastel balloons, tiered cake with lit candles on a dessert table, confetti, friends celebrating blurred, warm golden light.
- concert.webp — Outdoor music festival at dusk; crowd with raised hands silhouetted against a bright stage, colored light beams and haze, confetti in the air.
- gala.webp — Black-tie awards gala ballroom; dramatic stage lighting, gold and deep emerald accents, crystal chandeliers, guests at tables blurred, gold trophies in foreground.
- cultural.webp — Cultural/religious festival ceremony courtyard; marigold garlands, oil lamps and lanterns, colorful fabric canopies, families in traditional attire blurred, warm evening light, respectful documentary tone.

Convert: cwebp -q 72 -resize 1920 0 in.png -o name.webp
