# Diagnose a lighting discrepancy

First pin the active served GLB hash and map set. A mode switch may silently restore a different model preference; compare the same geometry, pose, camera, input RGB, exposure, ambient, material mode and shadow state.

| Symptom | Useful discriminator |
|---|---|
| Light appears inside a beam | Compare active light world position, app position and diffuser geometry centre for every ID; inspect fitting contact from below and side |
| Roof glows but bulb appears off | Inspect the bound diffuser's per-frame emission and a frozen pixel sample; body emission, a halo and illumination of nearby surfaces are different effects |
| Dark metal or black doors | Check original albedo, roughness/metalness, textures and shader support before blaming normals; diffuse-only shading omits specular response |
| Red in a front/back diagnostic | Check geometric winding and outside-facing ray hits with world transforms; verify culling in the viewer |
| Real-light roof bright, bake dark | Identify the same triangle/UV, read its source channel and trace the same caster set; unshadowed live lights can illuminate legitimately occluded surfaces |
| AO seems to change direct light | Freeze state, set ambient to zero and use linear readback; screenshot subtraction can mix exposure, fog and animation |

## Faces and materials

Agreement between geometric winding and vertex normals is only internal consistency: both can point inward. Double-sided rendering hides culling failures and does not establish correct baked-side response. A white-front/red-back export is useful only with verified front-face culling and mirrored-transform handling. Back-to-back sheets can make centroid matching ambiguous; ambiguous matches are not proven flips. Check the intended exterior side of glass separately from interior sheets.

A dark painted heater may have valid transport but very low albedo. Changing albedo to compensate for an absent specular path changes the asset's material. Agree whether the problem is the material, the app's supported PBR response or display/exposure. Normal maps may be preserved on ordinary materials but omitted by a custom receiver shader. Export preservation and runtime use are separate claims.

Transparent glass, interior receivers, bulb highlights and planar/environment reflections have different roles. Record pane planes, outward faces and caster/receiver policy; a diffuse map cannot encode view-dependent reflections. Do not infer blocked transmission from a BLEND label alone.

## Trust the rendered surface, then the probe

A picker may hit a different overlapping triangle from the rendered fragment. Use a runtime UV/normal diagnostic when the predicted AO disagrees sharply at one pixel. Sample with the shader's bilinear convention, not a nearest texel approximation. Fog can leave nonzero screen colour even when AO eliminates ambient; inspect the underlying term.

A lifted ray can start outside a thin occluder. Compare the ray origin and offset against the nearest surfaces before interpreting a missed blocker. Match caster exclusions too: a ray hitting a bulb diffuser excluded by the baker is not evidence of a bake blocker.

Sparse rays do not establish a full texel average. Match the baker's footprint, filtering and exclusion rules; independent samples can explain a discrepancy without proving the exact baking kernel. Keep unresolved cases visible and request a more precise diagnostic only when the quality requirement needs it.

Record useful and obstructed cameras explicitly. A blocked close-up, saturated all-lights view or successful load cannot substantiate a precise appearance or physical-light claim.
