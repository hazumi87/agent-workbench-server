# tile-builder

Composes a seamless background tile from transparent PNG elements. A composition JSON in, files out; an agent iterates by editing the JSON and looking at the 3×3 sheet. The Library editor (later) works over the same JSON.

    node tile.mjs <composition.json> [--out dir] [--name base] [--sheet px-per-tile]

Writes `<name>.png` (full size), `<name>-512.png`, `<name>-3x3.png` and `<name>-stats.json` (grey range, below). Run `pnpm install` once for `sharp`. Tests: `node --test test/*.test.mjs`. Example: `examples/clover.json`.

## Composition
```json
{ "w": 1024, "h": 1024, "bg": "#7a8a74",
  "light": { "angle": 315 },
  "shadow": { "distance": 14, "blur": 10, "opacity": 0.3, "color": "#000000" },
  "elements": [
    { "src": "leaf.png", "x": 130, "y": 140, "scale": 0.5, "rot": 40, "flip": "h", "z": 0,
      "tint": { "hue": 135, "sat": 0.5, "brightness": 0.8 },
      "shadow": { "distance": 6 } } ] }
```
- `bg`: a colour; omit for a transparent tile. `w`, `h` default 1024.
- `src`: a path relative to the composition file, an `http(s)` URL (a share URL), or `library:<asset id>` (the Library file; base from `TILE_LIBRARY_URL`).
- `x`, `y`: where the element's CENTRE sits, in tile px. `scale` multiplies the picture; `size` (longest side), `width` or `height` in px replace it. `rot` degrees clockwise. `flip`: `"h"`, `"v"` or `"hv"`, applied before the rotation. `opacity` 0..1. `z`: draw order, low first (ties keep list order).
- **Wrap-around:** the element is drawn again at every shift of the tile size where it still overlaps the tile, so it is seamless by construction (also for an element bigger than the tile). The shadow wraps with it.
- `tint` (alpha is never touched; order: desaturate, contrast, brightness, recolour):
  - `desaturate` 0..1: toward grey; `contrast`: multiplier around mid grey; `brightness`: multiplier on lightness (dark orca / light orca from one grey render).
  - `color` `"#rrggbb"` or `hue` 0..360 (+ `sat`, default 0.6): recolour; the element's lightness stays, hue and saturation become the colour's (W3C "color" blend), so a grey render keeps its shading.
- Shadow: `light.angle` is where the one light comes from, degrees clockwise from the top (0 above, 90 right, 315 top-left = shadow to the bottom-right). Tile-level `shadow` holds the defaults, an element's `shadow` overrides fields, `false` turns it off for that element. Fields: `distance` (px along the light direction), or explicit `dx`/`dy`; `blur` (px), `opacity`, `color`. A shadow falls on the elements below it.

## Stats (`<name>-stats.json`)
`mean_grey_pct`, `p1_grey_pct`, `p99_grey_pct`, `mean_chroma_pct`, and `tint_set_ok`: true when the tile is greyscale, its 1%–99% values lie in 35–65% grey and the mean is near 50% (Aurora's `tint` set). Hue and colour sets: ignore it.

## Publish to the Library
    node publish.mjs <composition.json> --set tint|hue|colour --category animals|biomes|objects|geometric|moods|road-signs|textures --subject <word> --density quiet|busy [--theme dark|light|any] [--parent <asset id>]

Renders the composition and uploads the full-size tile (multipart `POST <library>/assets/upload`, a transient asset like any other upload) labelled `bg tile · <set> · <category> · <subject> · <density>` (the seamless-tiles skill). The recipe is kept on the asset: `derived_op = {tool:'tile-builder', op:'compose', params:{composition}}`, and `meta.bg_tile` holds set, category, theme (the room theme it suits), subject, density, size and the grey-range stats. Prints `{id, label, url, stats, warnings}`. Warnings: a `tint` tile outside the grey range; elements from local files (re-render from the Library copy only works with `library:<id>` or URL sources). Library: `TILE_LIBRARY_URL`, default the local gateway. Favourite the keepers, and promote them, in the Library.

## Look at it behind a chat
    node shots.mjs (--tile <png> | --asset <library id> | --background <url>) [--out dir] [--name base] [--strengths 0.12,0.25] [--themes dark,light] [--color hex] [--blend soft-light]

Loads Aurora's chat test page (`http://127.0.0.1/styleguide/mockups/chat-page.html`, `--page` to change) in headless Chromium: per theme and strength a PC shot (1280 wide, tile 256 px) and a phone shot (390 wide, tile 192 px), `<name>-<pc|phone>-<theme>-<strength>.png`, plus `<name>-sheet.png`, one contact sheet. `--tile` serves a local file to the page, so a tile can be judged before it is published. The page blends the tile soft-light by default, so a low strength on a mid-grey tile is faint by design; `--blend normal --strengths 1` shows the tile itself. Chromium is launched with `--disable-features=LocalNetworkAccessChecks` (the page and the tile are on different hosts).

Not yet: the Library editor.

## Cut-outs (`cutout.mjs`)
    node cutout.mjs <in.png> <out.png> [tolerance=38]

For an element rendered alone on a plain flat background (Image Studio, "plain flat cream background"): a flood fill from the border removes every pixel close to the border's colour, with a soft one-step edge, then trims. Details inside the element in the background colour stay (they are not connected to the border), which suits flat illustrations on a matching tile `bg`. Pure pixel work, no model: use it instead of image-ops `remove_bg`, which can run the server out of memory. Raise the tolerance for a textured background, lower it if the element's own edge is eaten.
