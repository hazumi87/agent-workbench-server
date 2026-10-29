---
name: blender-fire-handoff
description: "Prepare a Blender fire-pit or burner asset for runtime animated flames and independently controlled baked glow. Use for flame anchors, burner bounds, auxiliary emitter layout and fire-only acceptance. The operator supplies assets and evidence; the runtime owner builds the flame shader."
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


# Blender fire preparation and handoff

Keep the fire's visible shape, illumination and material response separate. Flame cards may glow without illuminating the table; baked glow may work with the visible flame effect disabled. Neither supplies view-dependent reflections.

1. Inspect supplied photos/video for the burner footprint, rock bed, lip or wind guard, flame roots and height. Label measured model dimensions versus visual estimates; still photos do not establish flicker speed. Preserve accepted pit geometry/materials unless the brief requests changes.
2. Read [fire contract and acceptance](references/fire-contract.md). Agree the runtime coordinate frame, anchor, bounds, validation markers and metadata. Use documented scene/node-extra/export verbs; verify the written GLB, not just the Blender empty.
3. If glow is requested, agree source count, positions, units, channel order and independent controls before baking. Use [blender-lighting-bake](../blender-lighting-bake/SKILL.md) for the representative proof, full transport/AO and exact file handoff. Do not bake a visible emissive flame into the per-source transport unless that is explicitly part of the agreed method.
4. Give the runtime owner the context GLB, anchor/bounds evidence, references and limitations. They own procedural animation, specular, reflection and deployment work. An unavailable verb goes to the Blender developer through [blender-tool-handoff](../blender-tool-handoff/SKILL.md).
5. Review visible-flame motion separately from fire-only illumination. Inspect side, oblique and top views; freeze or disable preview lights for diagnostic comparisons. Carry accepted speed/height choices into the final handoff.

Report exact source/export pins, named nodes, local/world frame, burner and flame bounds, baked source order, reviewed views, unresolved sampling/look limits and receiving owner. End with `Status / Done / Verified / Open`; local integration is not deployment. Choose source count and dimensions for the current burner; this package contains no real-scene example.
