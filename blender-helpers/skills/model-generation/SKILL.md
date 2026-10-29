---
name: model-generation
description: "Prepare and quote image-to-3D generation, inspect consistent input views and hand the resulting mesh to Blender."
---

# Image-to-3D model generation

Use [character turnaround](../character-turnaround/SKILL.md) or
[part preparation](../character-kit-parts/SKILL.md) for inputs. Inspect the generated model before
[assembly](../character-kit-assembly/SKILL.md) or [rigging](../character-rigging/SKILL.md).

The optional Scenario CLI is `plugin/asset-platform-source/packages/scenario/scenario.mjs`,
relative to the package root. Read its current usage and configured credential mechanism.
Use `models` to inspect available models and input labels, `quote` for the exact inputs/settings,
then `run` only with the user's approval of that priced operation. An allowance is a ceiling,
not automatic authorization to spend it. Never print credentials or commit local key files.

Model names, prices, concurrency limits and accepted parameters change. Query them instead of
copying a historical result. Confirm whether the selected model accepts one image or explicitly
labelled front/back/left/right views, PBR textures, target face count and the requested output type.

Inputs need a clean silhouette, one subject per view, matching canvas/scale, consistent clothing
and handedness, and useful limb/finger separation for the intended rig. Inspect transparency;
do not remove an already-correct background. A flat background can be sufficient when the
provider accepts it. Fused detail may need a separate part rather than destructive mesh surgery.

Inspect the returned GLB for background fragments, fused limbs, thickness, proportions,
materials and likeness. Texture edits cannot correct a structural shape fault. Preserve the
original and hand off the selected source plus settings and observed limitations in the private
job record. Report the approved quote, actual charge, output ID/size and inspected views there;
do not include those records or generated assets in a public tooling release.
