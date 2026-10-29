"""dev_collartest — DEV FIXTURE, not an operator verb: a toy HEAD (ball + chin + neck plug, bottom ring touching the torso at z 0.55) and TORSO (oval neck stump with a sloping shoulder), Z up, face -Y, to test collar."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix  # noqa: E402
import _lib as L  # noqa: E402


def mk(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def cyl(bm, r1, r2, depth, z, sx=1.0, sy=1.0, seg=48):
    r = bmesh.ops.create_cone(bm, cap_ends=False, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=depth)
    vs = r["verts"]
    bmesh.ops.translate(bm, vec=(0, 0, z), verts=vs)
    for v in vs:
        v.co.x *= sx
        v.co.y *= sy


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    r = bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=0.11)
    bmesh.ops.translate(bm, vec=(0, 0, 0.70), verts=r["verts"])
    for v in r["verts"]:
        v.co.y *= 0.9
        if v.co.z < 0.66 and v.co.y < 0:  # a chin pushed forward and down
            v.co.y -= 0.02
            v.co.z -= 0.012
    cyl(bm, 0.05, 0.05, 0.08, 0.59, sx=1.0, sy=0.9)  # neck plug of the head: z 0.55 - 0.63
    mk("HEAD", bm)
    bm = bmesh.new()
    cyl(bm, 0.05, 0.05, 0.08, 0.51, sx=1.0, sy=0.9)  # neck stump z 0.47 - 0.55
    cyl(bm, 0.22, 0.05, 0.10, 0.42, sx=1.35, sy=0.85)  # sloping shoulders z 0.37 - 0.47
    cyl(bm, 0.22, 0.22, 0.37, 0.185, sx=1.35, sy=0.85)  # body
    mk("TORSO", bm)
    L.finish({"objects": ["HEAD", "TORSO"]}, save=True)


L.run(main)
