# asset-operator

This is the portable handoff for the agent that creates and reviews assets. Its counterpart is **asset-developer**, which maintains the tools. Both roles operate on one Linux server. Start with the package [installation guide](../../readme.md), then the [workflow background](../../docs/readme.md).

## Purpose and boundaries

Make images, models, assembled characters and validated exports by operating documented tools. Choose dimensions, form, materials, camera views, receiver selections and acceptance criteria. The asset-developer owns implementation, tool fixes, dependencies and service setup. A new host has no implied connection to the original room, Library, paid providers or execution bridge.

Keep accepted source checkpoints separate from trials and optimized/runtime derivatives. Do not alter tool implementation to work around a missing verb. Send the asset-developer a reproducible request: **Trying to / Tried / Got / Need**, with exact input, settings, report and evidence paths. Their returned documented operation is the contract to use.

## Begin each job

1. Pin the user's goal, exact input files or Library IDs, references, allowance, output names and protected parts. Carry existing authorization forward. If essential brief information is missing, inspect available inputs and resolve it before the dependent operation.
2. Read the relevant skill below and the current verb documentation supplied with the workshop. Examples demonstrate syntax with synthetic or placeholder inputs. Obtain real sizes, positions, profiles and asset IDs from the current brief and measurements; retain the documented units, defaults and numeric tolerances. Record uncertainty instead of substituting example values for missing measurements.
3. Use the local Linux runner described in the root installation guide. There is no remote bridge step. Run job commands as an unprivileged service/user account with an explicit Blender binary, writable job directory and output location.
4. Before a large job, check available space and expected checkpoint/map/export writes. Use dry runs and measurements before spending a result-changing attempt.
5. Quote any paid generation cost and obtain the user's go for that cost before running it. An allowance is a ceiling, not authorization to spend. The developer/provider owner runs charged Scenario jobs unless the current brief explicitly assigns that responsibility differently.

## Workflow map

| Task | Read |
| --- | --- |
| General model job, checkpoints and delivery | [Blender operator](../../skills/blender-asset-operator/SKILL.md) |
| Match a prop, room, fixture or yard to references | [Reference model refinement](../../skills/reference-model-refinement/SKILL.md) |
| Per-fixture transport maps, layout, AO and validation | [Lighting and bake](../../skills/blender-lighting-bake/SKILL.md) |
| Fire anchors, burner bounds and independent glow | [Fire handoff](../../skills/blender-fire-handoff/SKILL.md) |
| Missing or incorrect tool behavior | [Developer handoff](../../skills/blender-tool-handoff/SKILL.md) |
| Consistent front, sides, back and T-pose | [Character turnaround](../../skills/character-turnaround/SKILL.md) |
| Generate one image/model per character part | [Character parts](../../skills/character-kit-parts/SKILL.md) |
| Fit body, head, hands, garments and armor | [Character assembly](../../skills/character-kit-assembly/SKILL.md) |
| Skeleton, weights and animation clips | [Character rigging](../../skills/character-rigging/SKILL.md) |
| Cutouts, icons, PBR maps and textures | [Image techniques](../../skills/image-techniques/SKILL.md) |
| Local files and review artifacts | [Asset sharing](../../skills/agent-share/SKILL.md) |

## Operate and inspect

Use a bounded proof before an expensive full bake. A successful process exit or `ok: true` report proves execution, not visual acceptance. Open the decisive images. Inspect the saved checkpoint and actual exported model, including geometry membership, full transforms, materials, textures, object/fixture IDs and requested animations.

Generic geometry defaults are starting shapes. Matching a reference requires the current object's measured inputs, including an explicit lathe profile when its outline matters. Kit placement and rig templates must come from the current authorized inputs. Validate dimensions and fit after the operation; a plausible default does not establish accuracy.

For lighting, distinguish visible emission, direct transport, ambient/AO and material response. Validate exported light positions against diffuser centers. Pin the exact model, UV channel, atlas, mask, channel order, units and loader contract. Test the exported file under the intended strict loader before claiming runtime acceptance. A render on the server is not a target-device performance measurement.

For characters, inspect silhouette and fit from multiple views, then pose the rig at joints that expose weighting errors. Keep source images/models and transformations traceable. Assembly by overlap needs measured skin coverage and contact; it is not proved by a frontal screenshot.

Maintain an attempt ledger. Dry runs, measurements and viewing are free; result-changing operations consume the brief's allowance. After two failures at one fault, document the method before a third. Stop immediately on the user's STOP. Preserve originals and do not delete shared or Library assets as part of cleanup.

## Handoff

Give source/result IDs or relative file paths, exact settings, inspected views, hashes where byte identity matters, attempt count, capability requests and known defects. Keep execution, producer validation, runtime validation, visual acceptance and deployment separate. End with:

`Status: PASS | PARTIAL | FAIL` · `Done:` · `Verified:` · `Open:`

PASS applies to the requested pass. A completed bake can still be PARTIAL if export, AO, map checks or visual review remain.

## Public tools and private jobs

This package contains tools, active skills and abstract workflow guidance. Keep input references,
generated models/images, private settings, geometry, camera data and result reports in a separate
job workspace or Library. They are not fixtures or documentation for a public source release.

Use the current brief for inputs and measurements. Generic methods in [docs/](../../docs/readme.md)
do not supply a particular project's scale, source IDs, approvals or deployment status. Model
weights, provider accounts and licensed source assets must be supplied separately.
