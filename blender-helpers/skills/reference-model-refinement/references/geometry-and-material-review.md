# Isolate geometry, shading and material faults

Load when a model looks wrong despite a successful verb, especially bands, seams, protrusions or a local edit affecting other objects.

| Symptom | First isolation | Acceptance |
|---|---|---|
| Hard bands on a rounded cushion | Same geometry/camera with documented smooth shading | Bands clear without unrelated silhouette change |
| Dark corner on trim | Identify actual hit face, joint and material slot | Clean joint in detail view; glazing preserved |
| Metal through an arm or chair back | Trace support endpoints from rear and side | Ends meet intended frame joints, all counterparts checked |
| Pillow appears embedded | Check hard arm clearance separately from soft seat/back contact | Intentional soft contact only, both close and context views |
| Unrelated objects recoloured | Inspect material sharing and selection | Local edit uses a distinct material; other users preserved |
| Report contradicts image | Pin input/output and compare like quantities/world spaces | Explained discrepancy; no unexamined failed check |

Do not hide a bad joint under an extra cap or texture. The operator may need a developer capability, but the request should name the observable defect and protected elements. Use a real source copy when a fixture cannot reproduce it.

Keep matched cameras, lighting, exposure, material mode, resolution and samples for before/after. A camera inside a leaf card or obscured by furniture is not evidence of broken topology. Change the camera, identify the rejected view, then assess the model.

Check whether the final operation overrode an earlier setting. A wrapper can override a builder's shading flag; compare the saved result under explicit shading settings before changing mesh density. This supports testing the saved result, not permanently prescribing more subdivisions or a specific cushion recipe.

Check returned counts before interpreting images: zero copies, an unmatched name/glob or a partial parent assignment can return without achieving the request. Preserve the exact settings/error for the developer rather than trying successive guessed schemas.

For a repeated asset, prove one exemplar and then review all placements for orientation, contact and controls. Shared geometry does not require shared dynamic material state. Reimport the exported derivative at the same decisive camera; batching can introduce an appearance problem absent from the master.

Use evidence vocabulary precisely: opened/observed, measured with method, inferred, unverified. A sampled ray or sector envelope is not an exhaustive penetration test; a report correction is not automatically a geometry correction.
