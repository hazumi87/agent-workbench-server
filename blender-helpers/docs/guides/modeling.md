# Modeling and review

Start with a brief: intended result, input references, scale constraints, protected elements,
attempt budget and required exports. Keep private photos, geometry and measurements in a separate
job workspace. Record whether a dimension is supplied, measured in the model or inferred.

Select evidence by the feature it can establish. A front image can show silhouette but conceal
mounts and rear braces; video or a side view may reveal them. Correct orientation and account for
lens distortion before interpreting scale. Fit an explicitly selected subtree to a known dimension;
whole-scene bounds can contain unrelated detached objects.

Block out structure first, then make one repeated component convincing before instancing it.
Inspect contact and orientation from the direction that exposes the joint. Review all copies after
a correction; shared meshes can still have different transforms or materials.

Isolate faults with controlled comparisons. Keep camera, exposure, lighting and material mode
fixed. Separate silhouette, normals, surface ownership, material assignment and illumination.
Identify the actual hit face before covering a dark corner or changing a shared material. Read
changed-object counts: a successful process with zero affected objects may be a no-op.

Keep accepted masters and trials separate. Re-import the delivered export and inspect the same
decisive views. Check names, transforms, control IDs, materials, alpha and animation membership.
Export validity, visual acceptance and runtime performance are different claims. Report defects
and uncertainty alongside the checks that passed.

Detailed methods: [reference refinement](../../skills/reference-model-refinement/SKILL.md) and
[operator workflow](../../skills/blender-asset-operator/SKILL.md).
