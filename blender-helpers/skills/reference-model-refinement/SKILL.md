---
name: reference-model-refinement
description: "Reconstruct or refine non-character props, furniture, fixtures, rooms and outdoor scenes from supplied photos, video, measurements and existing models using documented Blender workshop verbs. Use for inaccurate scale, construction, mounting, repeated details, material assignment or scene placement. Includes reference selection and matched-view review; excludes character workflows, generic original concept modelling, tool implementation and automatic baking."
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


# Reference Model Refinement

Use with the brief/checkpoint rules in the parent [blender-asset-operator](../blender-asset-operator/SKILL.md). Choose physical form and placement here; request a missing capability through [blender-tool-handoff](../blender-tool-handoff/SKILL.md). Never write a Blender script to bridge a gap.

## Refine in evidence-led passes

1. **Choose a small reference set.** Open the supplied evidence with `agent-share`. Use a video contact sheet to locate useful moments, then inspect full-size frames/crops for the actual joint or silhouette. Record filename, timestamp/crop, orientation and what each view establishes. Product photos establish shape; site views establish installed angle and placement. Load [Reference and scale](references/reference-and-scale.md) when extracting evidence, fitting imports or interpreting lens metadata.
2. **Establish scale and axes.** Use a known dimension on the relevant subtree, not whole-file bounds containing detached objects. Distinguish user measurements, dimensions measured in the model and photo estimates. Evaluate full world transforms. Do not treat a lens specification as a solved camera or a fisheye view as ordinary perspective.
3. **Match construction before surface detail.** Read front, side and rear where available: silhouette, frame, joints, support endpoints, mounting face and ground contact. Count repeated elements explicitly. Use a plan/top view for grids, spacing and orientation. A material or texture cannot repair an incorrect joint or proportion.
4. **Make one representative unit work.** Build one fixture, chair or foliage patch and inspect it before repeating. Use shared geometry where appropriate while keeping per-instance controls required by the runtime. After finding one protrusion or misplaced pillow, check every repeated/symmetric counterpart. Intended soft contact is different from a hard frame penetrating upholstery.
5. **Change one cause at a time.** Compare saved cameras with the same lighting, exposure, material mode, resolution and sampling. Separate geometry from shading/normals, material assignment and illumination. Check the tool's affected-object counts. For bands, dark seams or edits affecting unrelated objects, load [Geometry and material review](references/geometry-and-material-review.md).
6. **Review close and in context.** Open a decisive detail view plus a normal viewing-distance view; add rear/side/top only where they answer a question. Reject obstructed or inside-geometry cameras. For vegetation, pavers or soil, load [Foliage and ground](references/foliage-and-ground.md). Make several passes when requested, with a specific observation motivating each pass rather than cosmetic reruns.
7. **Accept and hand back.** Inspect the source and the actual exported file at useful matching views using the parent's [delivery checks](../blender-asset-operator/references/delivery-and-workspace.md). Describe the concrete correction, references used, what remains approximate and the next owner. A modelling pass does not release a bake hold.

## Decide when another pass is warranted

Continue for an unresolved requested feature, contradictory evidence, visible construction/scale error, wrong selection, or export regression. Once the relevant views and checks pass, deliver; do not broaden testing or increase geometry without a remaining concern. If a measurement tool contradicts the image, preserve the evidence and request its interpretation instead of either silently ignoring it or rebuilding the whole model.

Use the current verb contract for settings. Relevant tool families include `scene_append`, `blockout`, `scene_tree`, `material_solid`, `shade_smooth` and instance/export operations; this list is navigation, not a stable schema or instruction to run all of them.
