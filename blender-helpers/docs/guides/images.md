# Image preparation

Use explicit input lineage in the private job and preserve framing across edits that will be
layered. Inspect every selected output. A generator's plausible picture does not establish
consistent geometry, a clean alpha mask or a physically meaningful data map.

For icons, flatten lighting, separate useful line/colour layers, trace according to contrast and
inspect at the intended small display size. Share a viewBox across a set and test both light and
dark backgrounds. A transparent SVG needs explicit compositing when previewed as a bitmap.

For PBR inputs, agree canvas registration, colour space and channel conventions. Separate albedo
from baked illumination. Roughness, metalness, height, AO and normal maps serve different roles;
grey appearance alone is not evidence that a map encodes the intended quantity. Check the maps
in the consumer and disclose image-derived approximations.

Use a simple cut-out method for a suitable flat background; otherwise inspect the resource needs
of a model-based method and process under bounded memory. Inspect hair, enclosed holes and halos.

For repeated patterns, compose wrapped elements or use procedural geometry where appropriate.
Audit opposite edges, edge bias and the interior after repair. Review a repeated sheet at actual
UI scale; a mathematically seamless tile can still have an obvious repeated clump or unreadable
fine detail. Keep compositions and produced images private; publish the tools and method.

Skills: [image techniques](../../skills/image-techniques/SKILL.md),
[tile composition](../../skills/seamless-tiles/SKILL.md),
[seam repair](../../skills/seamless-textures/SKILL.md).
