"""dev_exposefix — DEV TOOL: fixture for exposure_audit. ex_out (cube, outward), ex_in (cube turned inside out), ex_sheet (free sheet, +x), ex_inner (small sheet INSIDE ex_out), ex_wall (cube 6 m at x=30, outward), ex_facing (sheet 5 mm in front of the wall, its front toward the wall)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import _lib as L  # noqa: E402


def link(name, bm, flip=False):
    if flip:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    bpy.context.scene.collection.objects.link(bpy.data.objects.new(name, me))


def cube(size, x):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=size)
    bmesh.ops.translate(bm, verts=bm.verts[:], vec=(x, 0, 0))
    return bm


def sheet(x, h):
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((x, -h, -h), (x, h, -h), (x, h, h), (x, -h, h))]
    bm.faces.new(vs)
    return bm


def main():
    L.drop_factory_objects()
    link("ex_out", cube(2.0, 0))
    link("ex_in", cube(2.0, 10), flip=True)
    link("ex_sheet", sheet(20, 1.0))
    link("ex_inner", sheet(0.0, 0.3))
    link("ex_wall", cube(6.0, 30))
    link("ex_facing", sheet(30 - 3 - 0.005, 1.0))
    L.finish({"built": ["ex_out", "ex_in", "ex_sheet", "ex_inner", "ex_wall", "ex_facing"]}, save=True)


L.run(main)
