"""kit2_mirror — mirror ONE part across a plane, in place: the same object, same name, same material, its handedness reversed (a left sandal becomes a right one). Saves a checkpoint.

Why a verb: kit2_transform refuses a negative scale. This turns the part inside out the right way: the points are reflected across the plane and the faces are re-wound, so the normals still point outward
(the report shows the signed volume stays positive). Nothing else in the scene is touched, nothing is duplicated, the shape is not changed (a mirror image of itself).

params:
  name   the part (required)
  axis   "x" (default: left/right), "y" or "z": the axis the reflection flips
  about  where the plane is: "centre" (default: the part's own bounding-box centre along that axis, so it stays where it is), "world" (the plane through 0: the character's midline for x),
         a number (metres along the axis), or the name of another object (the centre of its bounding box along the axis)
  dry_run  true = report only, change and save nothing
Returns: plane_m, centre_mm and size_mm before and after (the size does not change), signed_volume_before/after (both positive = outward normals; the sign is kept), non_manifold_edges_before/after,
tris, uv_note (a mirrored part's UVs are not mirrored with it: a texture with writing or a one-sided print shows mirrored on it).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402

AX = {"x": 0, "y": 1, "z": 2}


def signed_volume(o):
    me = o.data
    me.calc_loop_triangles()
    tri = np.array([t.vertices[:] for t in me.loop_triangles])
    V = K.verts(o)
    a, b, c = V[tri[:, 0]], V[tri[:, 1]], V[tri[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def non_manifold(o):
    from collections import Counter
    me = o.data
    me.calc_loop_triangles()
    ec = Counter()
    for p in me.polygons:
        for k in p.edge_keys:
            ec[k] += 1
    return int(sum(1 for v in ec.values() if v != 2))


def main():
    name = L.param("name")
    o = bpy.data.objects.get(name or "")
    if o is None or o.type != "MESH":
        raise RuntimeError(f"no mesh named {name}")
    axis = str(L.param("axis", "x")).lower()
    if axis not in AX:
        raise RuntimeError('axis must be "x", "y" or "z"')
    a = AX[axis]
    v0 = K.verts(o).copy()
    about = L.param("about", "centre")
    if about == "centre":
        c = float((v0.max(0)[a] + v0.min(0)[a]) / 2)
    elif about == "world":
        c = 0.0
    elif isinstance(about, (int, float)) and not isinstance(about, bool):
        c = float(about)
    elif isinstance(about, str) and bpy.data.objects.get(about) is not None and bpy.data.objects[about].type == "MESH":
        ov = K.verts(bpy.data.objects[about])
        c = float((ov.max(0)[a] + ov.min(0)[a]) / 2)
    else:
        raise RuntimeError('about must be "centre", "world", a number (metres) or the name of a mesh object')
    vol0, nm0 = signed_volume(o), non_manifold(o)
    c0, s0 = K.centre_of(v0), K.size_of(v0)
    v1 = v0.copy()
    v1[:, a] = 2 * c - v0[:, a]
    K.set_verts(o, v1, flip_faces=True)
    vol1, nm1 = signed_volume(o), non_manifold(o)
    c1, s1 = K.centre_of(K.verts(o)), K.size_of(K.verts(o))
    if vol0 > 0 and vol1 <= 0:
        K.set_verts(o, v0)
        raise RuntimeError("the mirrored part came out inside out (negative volume): nothing changed")
    dry = bool(L.param("dry_run", False))
    if dry:
        K.set_verts(o, v0)
    out = {"name": o.name, "axis": axis, "plane_m": round(c, 4), "centre_mm_before": [K.mm(x) for x in c0], "centre_mm_after": [K.mm(x) for x in c1],
           "size_mm_before": [K.mm(x) for x in s0], "size_mm_after": [K.mm(x) for x in s1], "signed_volume_before": round(vol0, 8), "signed_volume_after": round(vol1, 8),
           "non_manifold_edges_before": nm0, "non_manifold_edges_after": nm1, "tris": len(o.data.loop_triangles), "dry_run": dry,
           "uv_note": "the part's UVs are not mirrored with it: a texture with writing or a one-sided print will show mirrored on it"}
    L.finish(out, save=not dry)


L.run(main)
