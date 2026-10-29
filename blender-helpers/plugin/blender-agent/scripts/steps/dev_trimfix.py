"""dev_trimfix — DEV TOOL: fixture for face_trim. Object `beam` (UV + custom flat normals): face 0 sheet x[0,4] y[0,1]; face 1 its unchosen neighbour x[4,5] y[0,1] (shares an edge); face 2 sheet x[0,4] y[5,6]. Object `chan`: sheet x[1,3] y[-1,2] (covers the middle of face 0 across its whole width) and sheet x[1,3] y[5,5.5] (covers the lower half of the middle of face 2). Expected with faces [0,2]: planes cut 2 + 3, face 0 -> 3 sub-faces (middle removed, 2.0 m2), face 2 -> 6 (the covered one removed, 1.0 m2): removed 3.0, kept 5.0."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import mathutils  # noqa: E402
import _lib as L  # noqa: E402


def main():
    L.drop_factory_objects()
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")

    def sheet(x0, x1, y0, y1, u0, u1):
        vs = [bm.verts.new(p) for p in ((x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0))]
        f = bm.faces.new(vs)
        for lp, c in zip(f.loops, ((u0, 0), (u1, 0), (u1, 1), (u0, 1))):
            lp[uv].uv = c
    sheet(0, 4, 0, 1, 0.0, 0.5)
    sheet(4, 5, 0, 1, 0.5, 0.6)
    sheet(0, 4, 5, 6, 0.6, 1.0)
    me = bpy.data.meshes.new("beam")
    bm.to_mesh(me)
    bm.free()
    me.normals_split_custom_set([(0.0, 0.0, 1.0)] * len(me.loops))
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("beam", me))
    b = bmesh.new()
    for x0, x1, y0, y1 in ((1, 3, -1, 2), (1, 3, 5, 5.5)):
        b.faces.new([b.verts.new(p) for p in ((x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0))])
    m = bpy.data.meshes.new("chan")
    b.to_mesh(m)
    b.free()
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("chan", m))
    L.finish({"built": ["beam", "chan"]}, save=True)


L.run(main)
