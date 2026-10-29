# Lighting, AO and fire preparation

Treat fixture alignment, visible emission, direct illumination, ambient/AO and specular response
as separate checks. A bright surface cannot locate a light by itself. Compare complete world
transforms and diffuser geometry, then diagnose the actual shaded surface under controlled state.

Freeze the model, pose, receiver/caster set, UV channel, atlas, source order, units and loader
sampling rules before a bake. Start with a bounded proof containing difficult receivers. Check
the exported triangle raster and whole-atlas ownership as well as sparse correspondence probes.
Coincident faces, folded triangles, edge ties and undersized charts need different remedies.

Validate finite/nonnegative channels and expected coverage. Padding must preserve receiver data
and avoid mixing unrelated islands. Bind AO to the exact layout/model; apply it to the intended
ambient term without multiplying direct light or source emission again. Preserve material maps
whose effects may be implemented outside the diffuse transport shader.

For discrepancy diagnosis, hold model, camera, exposure, input colours and shadow state fixed.
Check winding against the intended exterior, not only agreement with vertex normals. Match
probe sampling, ray offsets, exclusions and filtering to the actual renderer. Label unexplained
cases instead of treating a sampled check as exhaustive physical validation.

For fire, author an anchor, bounds, agreed extras and auxiliary glow sources. The runtime owns
the visible animated effect. Check its entire motion envelope separately from isolated glow
channels; remove accidental preview illumination. Fixed glow sources remain an approximation.

See [bake workflow](../../skills/blender-lighting-bake/SKILL.md) and
[fire handoff](../../skills/blender-fire-handoff/SKILL.md). Source positions, geometry, baked maps,
probe reports and screenshots belong to the private job, not this public guide.
