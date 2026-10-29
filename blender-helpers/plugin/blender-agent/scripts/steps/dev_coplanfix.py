"""dev_coplanfix — DEV TOOL: sheet pairs with KNOWN coplanar overlap for coplanar_audit. Pair names tell the expectation:
c1 exact same plane, overlap 0.5 m2 (found); c2 0.5 mm apart, overlap 1.0 (found); c3 5 mm apart (not); c4 back to back exact, overlap 1.0 (found, opposite);
c5 edge-touching only (not); c6 tilted 0.2 deg on 0.2 m sheets (found, ~0.7 mm); c7 tilted 2 deg (not)."""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import _lib as L  # noqa: E402


def sheet(name, x0, x1, y0, y1, z, flip=False, tilt_deg=0.0):
    bm = bmesh.new()
    t = math.tan(math.radians(tilt_deg))
    vs = [bm.verts.new((x0, y0, z + (y0 - y0) * t)), bm.verts.new((x1, y0, z)), bm.verts.new((x1, y1, z + (y1 - y0) * t)), bm.verts.new((x0, y1, z + (y1 - y0) * t))]
    f = bm.faces.new(vs)
    if flip:
        bmesh.ops.reverse_faces(bm, faces=[f])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)


def main():
    L.drop_factory_objects()
    y = 0.0
    sheet("c1_a", 0, 2, y, y + 1, 0); sheet("c1_b", 1, 3, y + 0.5, y + 1.5, 0)
    y += 5
    sheet("c2_a", 0, 1, y, y + 1, 0); sheet("c2_b", 0, 1, y, y + 1, -0.0005)
    y += 5
    sheet("c3_a", 0, 1, y, y + 1, 0); sheet("c3_b", 0, 1, y, y + 1, -0.005)
    y += 5
    sheet("c4_a", 0, 1, y, y + 1, 0); sheet("c4_b", 0, 1, y, y + 1, 0, flip=True)
    y += 5
    sheet("c5_a", 0, 1, y, y + 1, 0); sheet("c5_b", 1, 2, y, y + 1, 0)
    y += 5
    sheet("c6_a", 0, 0.2, y, y + 0.2, 0); sheet("c6_b", 0, 0.2, y, y + 0.2, 0, tilt_deg=0.2)
    y += 5
    sheet("c7_a", 0, 0.2, y, y + 0.2, 0); sheet("c7_b", 0, 0.2, y, y + 0.2, 0, tilt_deg=2.0)
    L.finish({"built": [o.name for o in bpy.context.scene.objects]}, save=True)


L.run(main)
