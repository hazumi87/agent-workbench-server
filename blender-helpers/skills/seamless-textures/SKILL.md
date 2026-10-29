---
name: seamless-textures
description: "Measure and repair wrap seams, edge bias and repeated-pattern defects in textures before delivery."
---

# Seam audit and repair

The seam tool is `plugin/asset-platform-source/packages/tile-builder/seam.mjs`, relative to the
package root. Read its CLI and configured thresholds. `audit <tile>` reports wrap mismatch,
edge bias, broad drift and an interior-cross check; `fix` can perform a min-cut rebuild.

Compare opposite edges against ordinary neighbour differences, then inspect a repeated sheet.
Separate a discontinuous seam from a bright border, broad gradient or repeated composition
clump. Numerical thresholds support a decision; the target display scale still matters.

Use a bounded repair sequence:
1. For compatible patterned pixels, try a min-cut rebuild that moves the seam inward and chooses
   cuts through similar regions. Check the new interior as well as the original edges.
2. If source motifs are distorted, regenerate within the approved allowance and audit candidates.
3. For recognisable objects, rebuild from wrapped elements; for exact geometric patterns, use a
   procedural construction. Offset blending can suit stochastic textures without distinct motifs.

Cross-fading two motifs can leave a washed band. Flattening brightness drift cannot fix a pixel
discontinuity. A half-offset preview intentionally exposes the seam at the centre and must not
be confused with the final tile. Confirm which version the consumer actually loads.

After a repair, re-run the audit and compare at the intended size and themes. Preserve originals
and record settings, before/after measures and limitations with the private asset. Share the
repeated comparison in its review; exclude that produced image and its job report from public
tool releases. See [tile composition](../seamless-tiles/SKILL.md).
