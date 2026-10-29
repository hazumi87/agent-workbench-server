---
name: blender-asset-operator
description: "Operate Asset Studio's Blender workshop through documented verbs: scope a 3D asset job, preserve checkpoints, review exports and hand assets to the Library or runtime owner. Routes reference modelling, lighting/bakes, fire preparation and tool-capability requests to focused children. Character workflows retain their specialist skills. Does not implement Blender tools or runtime code."
---

> Portable Linux edition. Read the [installation guide](../../readme.md) and [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md). Inputs and outputs belong to the current private job; this package supplies methods and tools.


# Blender Asset Operator

This is the operator entrypoint and short guide. Load only the child or resource needed for the current step; do not load the whole tree or project history.

## Route the work

| Work | Read next |
|---|---|
| Reconstruct or refine a real prop, furniture, room or outdoor scene from photos/video | Child [reference-model-refinement](../reference-model-refinement/SKILL.md) |
| A documented verb is missing, ambiguous, failing or produces a wrong result | Child [blender-tool-handoff](../blender-tool-handoff/SKILL.md) |
| Workspace, export, optimized derivative, Library/source filing | [Delivery and workspace](references/delivery-and-workspace.md) |
| Controllable fixtures, transport bakes, AO or lighting discrepancies | Child [blender-lighting-bake](../blender-lighting-bake/SKILL.md) |
| Fire-pit/burner anchors, animated-flame preparation and baked fire glow | Child [blender-fire-handoff](../blender-fire-handoff/SKILL.md) |
| Character parts, assembly, turnaround or rigging | Existing `character-kit-parts`, `character-kit-assembly`, `character-turnaround` or `character-rigging`, as applicable |
| Texture/image preparation or shared references | Existing `image-techniques` or `agent-share` |

Original modelling from a design brief uses that brief's form/style criteria and the documented verbs. It does not automatically become environment replication or character work.

## Start and operate

1. Pin the brief, exact input/checkpoint, requested change, references, allowance, protected elements, output names and explicit holds. Reconcile a delayed notification with completed work before rerunning it. Read only authorized records and the addressed thread.
2. Read the packaged [verb reference](../../plugin/blender-agent/docs/OPERATOR-VERBS.md) and the local invocation in [readme.md](../../readme.md). Confirm the asset-developer's current contract when the installed tool changes. Never guess names or types from a historical recipe.
3. Keep the accepted master and substantial trials separate. Before creating a large job, ask the developer to arrange its workspace, supplying the job name before the first step; then verify the first checkpoint destination. Keep approved modelling, baking and deployment scopes distinct.
4. Run documented verbs with explicit settings. Inspect errors, changed-object counts and the saved result; process success alone is insufficient. Open decisive images before claiming visual acceptance. The operator chooses shape and placement; the developer supplies capability.
5. Verify the actual export before delivery. Keep editable source, optimized derivatives and runtime map sets distinguishable. Report observed, measured, inferred and unverified facts separately.

## Finish the pass

Record source/result checkpoint and asset IDs, inspected views, checks and their scope, attempts against allowance, capability requests, remaining defects and next owner. Dry runs, measurements and looking are free; result-changing runs consume the brief's allowance. Record refused/failed calls too. After two failed attempts at one fault, document the method before a third.

End with `Status: PASS | PARTIAL | FAIL` · `Done:` · `Verified:` · `Open:`. PASS applies to the requested pass, not every possible future use.

The developer's separate entrypoint is [blender-dev](../../skills/blender-dev/SKILL.md). Exchange the request/result contract; do not load its implementation workflow to operate assets. General background: [modeling workflow](../../docs/guides/modeling.md).
