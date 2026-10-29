---
name: seamless-tiles
description: "Build repeating decorative tiles from independent elements, then assess repetition and readability at the target UI scale."
---

# Repeating tile composition

Use generation for exploration or isolated elements, then compose with wrap-aware placement.
The tile-builder lives at `plugin/asset-platform-source/packages/tile-builder`, relative to the
package root. Its README defines the current composition schema and CLI.

Agree master/export resolution, intended CSS display size, colour/theming mode, file budget and
detail scale with the consumer. These are target-specific settings, not fixed universal values.
Avoid a prominent repeating focal point and thin details that shimmer when downscaled.

Generate one undistorted element per image with consistent flat lighting and a clean background.
Cut it out, inspect the silhouette and interior holes, and retain it privately for reuse. Prefer
one source with deliberate flips/tints over unrelated variants that drift in style.

`tile.mjs` reads a composition with canvas/background and positioned elements; elements crossing
an edge must wrap to the opposite side. Use the documented inputs for position, scale, rotation,
opacity, tint, shadow and layer order. Keep shadow direction and blur consistent across elements.
Vary spacing and orientation deliberately; check neighbouring choices across the wrap boundary
so a staggered arrangement does not become diagonal stripes.

Review a repeated sheet and the actual consumer at desktop/mobile scale in relevant themes.
Judge motifs against text and controls. If objects are too fine or dominant, change composition
scale instead of hiding the problem by changing the preview zoom. Dark-source recolouring may
need brightness adjustment as well as hue/tint.

Run [seam audit](../seamless-textures/SKILL.md) before acceptance. For stochastic surfaces,
offset blending can work; for recognisable motifs, wrapped elements or procedural geometry are
usually easier to control. Preserve the private composition recipe and input lineage with the
asset. Publish only the reusable composition tools and generic instructions in a code package.
