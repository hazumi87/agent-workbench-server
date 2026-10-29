"""dev_nrm — DEV TOOL: shading normals around a world point on one object: per polygon within `radius` m: smooth flag, face normal, corner (shading) normals, custom normals present. Read-only."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def main():
    o = bpy.data.objects[L.param("object")]
    me = o.data
    P = Vector(L.param("point") or (0, 0, 0))
    rad = float(L.param("radius", 0.05))
    mw = o.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()
    rows = []
    for p in me.polygons:
        c = mw @ p.center
        if (L.param("polys") and p.index in L.param("polys")) or (not L.param("polys") and (c - P).length <= rad):
            fn = (nm @ p.normal).normalized()
            cn = [tuple(round(x, 3) for x in (nm @ me.corner_normals[li].vector).normalized()) for li in p.loop_indices]
            ang = max(float(Vector(x).angle(fn, 0)) for x in cn) * 57.2958 if cn else 0
            rows.append({"poly": p.index, "smooth": bool(p.use_smooth), "verts": len(p.vertices), "face_normal": [round(x, 3) for x in fn], "corner_normals": cn, "max_angle_face_vs_shading_deg": round(ang, 1), "centre": [round(x, 3) for x in c]})
    L.finish({"object": o.name, "has_custom_normals": me.has_custom_normals, "polygons_near": len(rows), "smooth_polygons": sum(1 for r in rows if r["smooth"])}, save=False, rows=rows[:20])


L.run(main)
