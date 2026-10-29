"""cleanup — make the one mesh sane: transforms applied, doubles merged, loose
geometry and (optionally) tiny floating parts removed, normals outward,
scaled to a target height, origin at the floor (GLB contract v0 with Mesh Studio).

params:
  merge_distance   metres, default 0.0001
  min_part_ratio   drop connected parts with fewer verts than this fraction of the
                   largest part (0 = keep all; default 0)
  target_height_m  uniform rescale so the mesh is this tall (optional)
  origin           "feet" (default): bbox min z -> 0, bbox centre x/y -> 0
                   "base": same maths, for a bust's cut plane
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import _lib as L  # noqa: E402


def parts(bm):
    """Connected components as lists of verts."""
    seen, out = set(), []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, comp = [v], []
        seen.add(v.index)
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for e in cur.link_edges:
                w = e.other_vert(cur)
                if w.index not in seen:
                    seen.add(w.index)
                    stack.append(w)
        out.append(comp)
    return out


def main():
    ms = L.meshes()
    if len(ms) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for o in ms:
            o.select_set(True)
        bpy.context.view_layer.objects.active = ms[0]
        bpy.ops.object.join()
    mesh = L.the_mesh()
    L.activate(mesh)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    tris_before = L.tris(mesh)

    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    verts_before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=float(L.param("merge_distance", 0.0001)))
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.verts.index_update()
    comps = parts(bm)
    ratio = float(L.param("min_part_ratio", 0))
    dropped = 0
    if ratio > 0 and comps:
        biggest = max(len(c) for c in comps)
        small = [v for c in comps if len(c) < ratio * biggest for v in c]
        dropped = sum(1 for c in comps if len(c) < ratio * biggest)
        bmesh.ops.delete(bm, geom=small, context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
    bm.to_mesh(mesh.data)
    bm.free()
    mesh.data.update()

    lo, hi = L.world_bbox([mesh])
    height = hi.z - lo.z
    target = L.param("target_height_m")
    s = float(target) / height if target else 1.0
    centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    mesh.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation(-centre))
    mesh.data.update()

    L.finish({
        "mesh": mesh.name, "tris_before": tris_before, "tris": L.tris(mesh),
        "verts_before": verts_before, "verts": len(mesh.data.vertices),
        "parts": len(comps), "parts_dropped": dropped, "non_manifold_edges": non_manifold,
        "scale": round(s, 5), "dims": L.dims([mesh]),
    }, save=True)


L.run(main)
