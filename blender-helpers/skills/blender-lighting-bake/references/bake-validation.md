# Bake validation and delivery

Read only for a bake/layout/AO or packaging task. Obtain the receiving owner's current contract and the developer-maintained verb documentation before executing; the sequence below describes outcomes, not an immutable command recipe.

## Freeze the contract

Record model hash, pose, receiver node/primitive IDs, casters and alpha policy, UV channel, atlas dimensions, ordered fixture IDs and padding slots. Define datatype/endian, layer/channel order, row origin/flip, units, distance clamp, falloff, radius, cutoff, albedo and `/pi` responsibility. State which maps are raw transport versus colour/material data.

For auxiliary sources, freeze IDs, parent/local/world coordinates, units and runtime controls before baking. Confirm loader support and sampler/resource strategy with the runtime owner; another RGBA layer is not automatically feasible on every device. Keep raw, wire, CPU and GPU sizes separate.

Record the calibration actually available. Sensor-voltage measurements do not establish spectral colourimetry, photopic lux or calibrated primary chromaticities.

## Establish the layout on a bounded proof

Use representative lights and difficult receivers. A dry layout result is not an audit of the exported triangle raster. Check the actual GLB under the loader's tie/edge rule as well as correspondence probes.

- Packing density can be limited by the longest thin chart, even with much of the atlas empty. Inspect chart sizes, density weights, minimum chart floors and padding before increasing resolution.
- Inclusive baker edges and top-left loader edges can disagree. Half-texel-aligned chart boundaries can expose tie-rule differences; match the rules and inspect the export rather than copying a magic width.
- Coincident faces, folded quads and duplicate UV owners are separate faults. UV-only separation or a documented tiny-fold collapse may solve them. A polygon's signed/Newell area can cancel while its component triangles have larger area: report the area convention, affected objects and lost coverage. Do not adopt a project threshold as a universal repair.
- List empty charts by surface area and location. Hidden contacts and visible trim need different decisions. Sparse atlas ownership alone is not a quality verdict.

Keep strict coverage/overlap failure distinct from a labelled debug composition run. Probe correspondence cannot prove whole-atlas ownership, nor does a clean raster prove physically accurate illumination.

## Full run, padding and AO

On the accepted layout, bake the final source list. Check every channel for finite, nonnegative values and expected nonzero receiver coverage; explicitly listed null channels remain zero. Expected dark receivers are not channel failures.

When edge-copy gutters are required, verify the actual method. Averaging neighbours can mix islands. The documented repad route copies a whole channel vector from one donor and leaves receiver/non-receiver bytes unchanged; it is directional propagation, not Euclidean nearest. Write new outputs, retain source pins, rebind and audit them. Reuse probes only while their receiver samples and geometry remain valid.

AO uses the exact receiver set, UV layout, mask and model hash. For an agreed linear u8 visibility contract, define the value for non-receivers and the treatment of padded texels explicitly. No AO or strength zero gives visibility exactly one; positive strength keeps source zero dark. The runtime applies AO only to ambient, never to direct transport or diffuser emission. A new unwrap requires compatible new AO.

## Package and verify

Pin raw files and any compressed wrappers separately; verify exact inflate length and raw hash. Hash the manifest bytes actually served, including newline differences. Bind AO to the raw GLB hash. Preserve editable source alongside the runtime derivative and verify durable Library storage and source linkage.

Compare proof/full GLB, mask and corresponding channels when claiming proof reuse. Exact agreement supports those specific checks; it does not validate a new source-count shader path.

Request bounded runtime tests: strict load, source-node positions, all-off composed atlas, isolated channels, distinct-colour addition, unchanged-input behaviour and changed batches. Freeze smoothing/input/ambient/fog when relevant. Tone-mapped screenshots are appearance evidence, not linear transport arithmetic. Label software rendering, device tests and untested cases separately. Record uploaded, integrated locally, tested and deployed as separate states; reconcile delayed notifications with final evidence before repeating work.
