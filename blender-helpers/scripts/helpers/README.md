# helpers

Small, job-independent command-line tools. They take their inputs as arguments; nothing is
hard-coded to a machine.

## gltf-audit/
Read a `.glb` directly from its accessors (not through Blender), because a mesh that looks fine
in Blender can still carry problems that only exist in the exported file.

- `glb_audit.py a.glb [b.glb ...]` — per mesh/primitive: counts, normals (finite, unit length),
  zero-area and repeated-index triangles, and edge topology twice: by index and with coincident
  positions merged (boundary edges, edges shared by more than two triangles), plus SHA-256 of each buffer.
  Needs `numpy`.
- `glb_dups.py a.glb [...]` — finds duplicate triangles (same three vertices, including opposite
  winding) and lists the non-manifold edges they cause. This is the failure that appears when a patch
  or hole-fill is exported: the file has duplicate flaps that the in-memory mesh does not.
- `glb_weld_meas.py before.glb after.glb [mesh_index]` — how many coincident vertex pairs the first file
  has, how many vertices a weld removes, and whether the second file's vertices are bit-equal to the
  first's. Needs `scipy`.
- `glb_audit_lib.py` — the shared GLB reader (`load`, `acc`).

Tested on a synthetic cube with one duplicated triangle: the duplicate and the resulting non-manifold edges are reported.
