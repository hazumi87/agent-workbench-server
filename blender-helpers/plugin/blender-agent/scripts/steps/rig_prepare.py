"""rig_prepare — get a single scanned or generated character mesh ready for rig_biped: name it `body`, bake its transform, weld it, reduce it. Saves a checkpoint.

For a character that is ONE mesh (clothes included), not a kit: the imported mesh becomes the object `body` that rig_biped rigs. Automatic weights on
hundreds of thousands of triangles are very slow, so the mesh is reduced first (collapse decimation, UVs and material kept). Nothing is moved: the
transform is baked into the vertices (scale, rotation and location stay as they were in the scene).

params:
  object  name of the mesh to prepare (default: the only mesh in the scene)
  name    the new name (default "body")
  budget  triangles to reduce to (default 80000); a mesh at or under it is left as it is
  weld_mm distance under which duplicate points are merged (default 0.01)
Returns: tris before/after, checks (non-manifold edges, loose islands, largest island's share), size (m), uv/material info, notes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def island_shares(o):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    seen, sizes = set(), []
    for v0 in bm.verts:
        if v0.index in seen:
            continue
        seen.add(v0.index)
        stack, n = [v0], 0
        while stack:
            v = stack.pop()
            n += 1
            for e in v.link_edges:
                w = e.other_vert(v)
                if w.index not in seen:
                    seen.add(w.index)
                    stack.append(w)
        sizes.append(n)
    bm.free()
    sizes.sort(reverse=True)
    return sizes


def main():
    ms = L.meshes()
    nm = L.param("object")
    if nm:
        o = bpy.data.objects.get(nm)
        if o is None or o.type != "MESH":
            raise RuntimeError(f"no mesh named {nm}")
    else:
        if len(ms) != 1:
            raise RuntimeError(f"{len(ms)} meshes in the scene: name the one to prepare with `object` ({', '.join(m.name for m in ms)})")
        o = ms[0]
    new = L.param("name", "body")
    clash = bpy.data.objects.get(new)
    if clash is not None and clash is not o:
        raise RuntimeError(f"an object named {new} already exists")
    o.name = new
    o.data.name = new
    L.activate(o)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    K.weld(o, dist=float(L.param("weld_mm", 0.01)) / 1000.0)
    before, after = K.decimate(o, int(L.param("budget", 80000)))
    sizes = island_shares(o)
    v = K.verts(o)
    notes = []
    if len(sizes) > 1:
        small = sum(1 for s in sizes[1:] if s < 0.002 * sum(sizes))
        notes.append(f"{len(sizes)} separate pieces ({sizes[0]} points in the largest); {small} are tiny. Automatic weights may leave loose pieces unweighted.")
    uv = o.data.uv_layers.active
    mats = [m.name for m in o.data.materials if m]
    out = {"object": o.name, "tris_before": before, "tris_after": after, "pieces": len(sizes), "largest_piece_share_pct": round(100 * sizes[0] / sum(sizes), 2),
           "size_m": K.size_of(v), "height_m": round(float(v[:, 2].max() - v[:, 2].min()), 3), "min_z_m": round(float(v[:, 2].min()), 4), "uv": bool(uv), "materials": mats, "notes": notes}
    L.finish(out, save=True)


L.run(main)
