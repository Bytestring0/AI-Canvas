# 雨夜・街角コンビニ — Rainy Night Corner Store (miniature 3D diorama)

A single self-contained HTML file: a small, collectible **cel-shaded diorama** of a
Japanese neighbourhood street corner on a rainy night, seen in third person. There is
no interface — no buttons, no text, no HUD. The whole page is the model: drag to spin
it, scroll or pinch to bring it closer, and watch the rain, the neon and the warm light
of the shop.

- **Model:** qwen3.8-flash (driven through DeepSeek Harness)
- **Generated:** 2026-10-17
- **Files:** `index.html` (the deliverable, ~155 KB, no dependencies), `README.md`
- **Open it:** double-click `index.html`. No build step, no npm, no network, no CDN,
  no fonts or images fetched. It also runs inside a `sandbox="allow-scripts"` iframe.

### The brief it was built to (quoted)

> 制作一个雨夜便利店街角小场景：第三人称观看整个场景，整体像一个可以自由拖拽、旋转、缩放观看的
> 微缩三维模型 / 小型景观，没有任何UI界面元素。地面为一个完整的正方形底座，所有元素都建立在底座上，
> 构图紧凑，具有小巧、精致、可收藏的模型感。风格为三渲二（cel-shading），浓厚的日式二次元动画氛围，
> 材质干净、描边清晰、色彩柔和但有夜晚霓虹层次。场景需包含：便利店招牌、玻璃橱窗、自动门、屋檐雨棚、
> 门口地垫、自动贩卖机、自行车、雨伞架、垃圾桶、路灯、电线杆、电线、路牌、街角护栏、停车位、排水沟、
> 积水路面、反光斑马线、小巷入口、空调外机、小型公告栏/海报栏。……便利店内部一定要有足够内容，
> 并且可以透过大面积玻璃窗清楚看到店内：货架、饮料柜、便当区、饭团和零食陈列、收银台、咖啡机、杂志架、
> 宣传海报、店内灯箱、冰柜、关东煮柜台、地面导视、储物柜或后场门。……画面中不要有人物。
> 基础动效：持续降雨、屋檐滴水、地面积水波纹、招牌/灯箱轻微闪烁、自动门偶尔开合、雨水沿玻璃滑落、
> 路面积水反射灯光、远处交通信号灯微弱变化。

---

## How it is made

There is **no 3D library and no WebGL** — the renderer is a small software cel-shader
written against Canvas2D, in about 3,300 lines of plain JavaScript:

| stage | what happens |
| --- | --- |
| geometry | the scene is authored as flat polygons, polylines and cylinders (`20-geom.js`); every vertex carries a precomputed UV |
| culling | backfaces are dropped by `dot(normal, eye − centre)`; off-screen bounding boxes are skipped |
| clipping | polygons crossing the near plane are Sutherland–Hodgman clipped with UVs interpolated |
| sorting | one mixed list of faces, wires and ground light pools is depth-sorted per frame (painter's algorithm, with a per-item bias so ground decals and glass land in the right band) |
| shading | a 4-band toon ramp from a single cold key light + cool sky ambient + wet-ground bounce; interior surfaces use a separate warm preset; every surface then accumulates **additive coloured spill** from 37 point lights (signs, lamps, vending machine, the shop itself) |
| outlines | each polygon is stroked with an ink line before it is filled — the 三渲二 look |
| atmosphere | depth fog toward the night colour, additive bloom halos, projected ground pools and wobbling vertical reflections on wet asphalt, tilt-shift depth-of-field, foreground bokeh, vignette |

**Every texture is generated at load time** on offscreen canvases (`40-tex.js`): asphalt,
concrete, tactile paving, gutter grating, floor tiles, corrugated roof, wall tiles, the
fascia sign, the vending machine, shelf facings (bento / onigiri / snacks / magazines),
the drinks cooler, posters, the oden menu board, the notice board, newspaper, hazard
stripes. The signage lettering is **invented kana-like glyph strokes** drawn from a
deterministic seed, plus real Latin letters and digits — so the scene never depends on a
CJK font being installed and never shows tofu boxes.

The random seed is fixed (`20261017`), so the diorama looks identical on every reload.

## What is in the scene

- **The shop:** wrap-around glazing on two facades, sliding **automatic doors** that open
  and close on their own timer, sloped **eaved canopies** with soffit downlights, the
  lit fascia sign, a corner **blade sign**, opening-hours band, door mat, **umbrella
  stand**, two **bins**, wall-mounted **air-conditioner** outdoor unit dripping
  condensate, **notice board**, in-window posters, glass decals, CCTV dome, promo flags,
  rooftop plant boxes, water tank, antenna, parapet.
- **The interior** (bright, warm, packed, visible through the glass): three gondola runs
  with product facings and end-cap sale posters, a four-door **drinks cooler**, the
  **bento / warm-food case**, the **oden counter** with skewered pots and rising steam,
  the **register counter** with POS monitor, scanner and card reader, a **coffee machine**
  with stacked cups, a **candy & magazine rack**, **chest freezers** under the front
  window, hanging ceiling **ad banners**, strip lighting, floor **guidance markings**,
  **storage lockers**, an ATM and a **back-room door** with warm light behind it.
- **The street:** two roads meeting at a right-angle **corner turn**, kerbs, sidewalk
  slabs, tactile paving, **drainage gutters** and an inlet grate, **manhole**, painted
  give-way lines, two **reflective crossings**, **pedestrian guard rails**, bollards,
  **road signs** (stop octagon, crossing diamond, speed roundel), **utility poles** with
  cross-arms, transformer and **catenary wires** plus service drops to the buildings,
  three **street lamps** (one sodium, two cool LED), a **traffic signal** head per road
  with a full green → amber → red(+amber) cycle, two **pedestrian signals**, a **repeater
  signal** across the junction, a **vending machine** glowing blue on the pavement, a
  **bicycle rack** with three bikes (one with an umbrella in the basket, one under a
  rain cape), a bike chained in the **alley entrance**, a parked kei car in the
  **parking pad**, a red post box, a hydrant, a planter, traffic cones, a neighbouring
  building with a lit window and a flickering TV, and a back lot with roofs, AC units,
  a skip and crates.
- **No people anywhere**, as asked.

## Motion

Continuous rain with wind slant and landing splashes · ripples spreading inside the
puddles · beads gathering and falling off the eaves, the canopy edge and the AC unit ·
water droplets sliding down each window pane (with trails) · oden steam · the sign and
blade-sign flicker (a slow pulse plus rare buzz and dip) · the automatic door opening
and closing at irregular intervals · traffic and pedestrian signals cycling out of phase
· lamp shimmer · the shop's light pools and their reflections breathing on wet asphalt ·
a slow idle auto-orbit that starts after 6 seconds of stillness.

## Controls

| input | action |
| --- | --- |
| drag | orbit around the plate |
| wheel / pinch | zoom |
| shift-drag, right-drag, two-finger drag | pan |
| `←` `→` / `A` `D` | rotate · `↑` `↓` / `W` `S` tilt |
| `+` / `-` | zoom in / out |
| `Q` / `E` | slide the view sideways |
| `1` `2` `3` | curated viewpoints (corner 3/4 · eye level at the doors · over the roof and alley) |
| `R` (or `0`) | reset to the first view |
| `C` | toggle the idle auto-orbit |
| Tab, then arrows | keyboard users can reach the canvas and drive it |

The canvas carries an `aria-label` describing the scene, and there is no other chrome.

## Responsiveness, performance, accessibility

- Layout is a single full-bleed canvas; the camera distance is derived from the viewport,
  so the whole plate always fits — from 390 px phones to wide desktops.
- Three quality tiers (dpr cap, pixel budget, light sampling step, tilt-shift, rain
  particle count) are chosen from pointer type, viewport size and CPU count, then adapted
  at runtime from a rolling frame-cost average.
- `prefers-reduced-motion: reduce` is honoured, live if the setting changes: rain becomes
  a light static drizzle, drips/ripples/steam/door/sign flicker stop, the signals hold a
  fixed aspect, the auto-orbit is off and the camera settles instantly.
- No network access, no storage, no forms, no popups, no downloads, no `top` navigation,
  no audio (deliberate: sound would need autoplay or a click, both of which break the
  "no interface" rule).

## Known limits

1. **Painter's algorithm, not a z-buffer.** Coplanar and interpenetrating surfaces can
   swap order at grazing angles; the bias bands (ground, props, glass) keep the common
   cases stable, but a shelf edge crossing a mullion can occasionally flicker.
2. **One-pass shading.** Spill from the shop's lights is a per-face point-light sum, so
   light does not stop at walls: standing far to the west you can see a faint warm wash
   on the shop's own blind wall. Fog and the ink lines hide most of it.
3. **Soft body of the renderer.** Everything is quads and cylinders — no real curves, so
   bicycle wheels are 14-gon rings and the oden pots are octagons. That reads as model
   kit detail at this scale, but there are no smooth silhouettes.
4. **Invented lettering.** The kana-like shapes on the fascia and posters are stylised
   strokes, not readable Japanese. Real words are limited to Latin and digits (`24H`,
   `OPEN ALL NIGHT`, `NEW OPEN`, `50% OFF`, `COLD DRINKS`).
5. **No audio**, and no way to turn the rain sound on — see the accessibility note above.
6. **Cost.** The full scene is ~3,300 polygons and ~2,200 visible faces per frame with
   per-face light accumulation. On a GPU-composited desktop browser it holds 60 fps; on
   software rasterisation (headless CI, some VMs) it drops to 10–20 fps and the adaptive
   tier lowers resolution and particle counts to compensate.
7. **Interaction is mouse/touch/keyboard only** — no gamepad, no drag-inertia beyond the
   damped camera, and no way to save a viewpoint.

## Source layout (development only)

`index.html` is the deliverable. `build.mjs` + `src/NN-*.js` are the authoring modules
concatenated into it (`node build.mjs`), and `selftest.mjs` / `shot.mjs` are the headless
smoke test and screenshot harness. Deleting them leaves the page fully working.
