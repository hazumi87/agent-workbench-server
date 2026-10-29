---
name: blender-lighting-bake
description: "Prepare and validate controllable lighting assets, per-fixture transport bakes and ambient-only AO through documented Blender workshop verbs. Use for fixture alignment, bake layout/coverage, dark-surface diagnosis and exact runtime handoff. Runtime shaders and tool implementation belong to their owners."
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


# Blender lighting and bake

Use the [operator parent](../blender-asset-operator/SKILL.md) for workspace, checkpoints and current verb discovery. This workflow covers static geometry with dynamic source colours/intensities; moving geometry or lights needs a different validity assessment.

## Choose the next step

- Wrong bulb position, dark surfaces, reversed-face suspicion, or a bake/runtime disagreement: read [lighting diagnosis](references/lighting-diagnosis.md) before changing the asset.
- New layout, bake, AO, padding or delivery: read [bake validation](references/bake-validation.md).
- Visible fire and its independently controlled glow: use [blender-fire-handoff](../blender-fire-handoff/SKILL.md).

## Operate

1. Establish the exact model/checkpoint, fixed pose, receiver and caster selections, fixture IDs and current runtime contract. Preserve the user's existing authorization and explicit holds; a delayed message does not reinstate an obsolete hold.
2. Inspect one complete fixture before repetition. Validate every exported light's world position against the diffuser geometry centre, preserving per-ID emission controls even when fittings share geometry.
3. Separate visible emission, direct transport, ambient/AO and view-dependent material response. More diffuse bake channels do not supply roughness, metalness, normal maps or reflections. Verify what the receiving shader actually consumes.
4. For a new pipeline/layout, prove a bounded representative source set through the exact exported GLB and actual strict loader before the long run. Retain the accepted geometry/layout; if it changes, identify which proof results no longer apply.
5. Run the authorized full bake and compatible AO through current documented verbs. Resolve errors without weakening validation. Use the developer handoff skill for missing capabilities; do not implement tools or runtime code.
6. Deliver pinned source/model/maps and scoped evidence. Distinguish producer validation, runtime validation, visual review and deployment. Software-rendered checks are not device performance measurements.

Report the source/result, channels/units, useful views, correspondence and coverage, physical anomalies, payload pins, attempts/allowance and next owner. Finish with `Status / Done / Verified / Open`. Keep source positions, measurements and result pins in the current private job record, not in this skill.
