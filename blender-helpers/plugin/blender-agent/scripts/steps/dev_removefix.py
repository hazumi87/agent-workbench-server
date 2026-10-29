"""dev_removefix — DEV TOOL: fixture for face_remove. Object `dup` (faces in order): 0 sheet [0,1]x[0,1]; 1 its exact duplicate (other UVs); 2 sheet x[0,2] y[5,6]; 3 sheet x[0,1] y[5,6] (covers half of 2); 4 sheet y[10,11]; 5 the same sheet turned over (back to back with 4). Object `dup` also carries CUSTOM split normals (face_remove must keep the survivors' corner normals). Objects `tgt` (a sheet at y 20) and `cov` (a larger sheet over it)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import _lib as L  # noqa: E402


def main():
    L.drop_factory_objects()
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")

    def sheet(x0, x1, y0, y1, flip=False, uvoff=0.0):
        vs = [bm.verts.new(p) for p in ((x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0))]
        f = bm.faces.new(vs)
        for lp, c in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            lp[uv].uv = (c[0] * 0.5 + uvoff, c[1] * 0.5)
        if flip:
            bmesh.ops.reverse_faces(bm, faces=[f])
    sheet(0, 1, 0, 1)
    sheet(0, 1, 0, 1, uvoff=0.5)
    sheet(0, 2, 5, 6)
    sheet(0, 1, 5, 6)
    sheet(0, 1, 10, 11)
    sheet(0, 1, 10, 11, flip=True)
    me = bpy.data.meshes.new("dup")
    bm.to_mesh(me)
    bm.free()
    import mathutils
    me.normals_split_custom_set([tuple(mathutils.Vector((0.1 * (i % 5), 0.05, 1.0)).normalized()) for i in range(len(me.loops))])
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("dup", me))
    for nm, x0, x1 in (("tgt", 0, 1), ("cov", -1, 2)):
        b = bmesh.new()
        vs = [b.verts.new(p) for p in ((x0, 20, 0), (x1, 20, 0), (x1, 21, 0), (x0, 21, 0))]
        b.faces.new(vs)
        if nm == 'tgt':
            b.faces.new([b.verts.new(q) for q in ((0, 30, 0), (1, 30, 0), (1, 31, 0), (0, 31, 0))])
        m = bpy.data.meshes.new(nm)
        b.to_mesh(m)
        b.free()
        bpy.context.scene.collection.objects.link(bpy.data.objects.new(nm, m))
    L.finish({"built": ["dup", "tgt", "cov"]}, save=True)


L.run(main)
