"""dev_multimat — DEV fixture: one object with TWO material slots (a box whose top faces use material B and the rest material A) under an empty, plus a cylinder with two materials (side, caps), to test scene_optimize on multi-material objects."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def mat(n, c):
    m = bpy.data.materials.new(n)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = c
    return m


def main():
    L.drop_factory_objects()
    scn = bpy.context.scene
    root = bpy.data.objects.new("Site", None)
    scn.collection.objects.link(root)
    br = bpy.data.objects.new("Structure", None)
    scn.collection.objects.link(br)
    br.parent = root
    A, B = mat("mmA", (0.8, 0.2, 0.2, 1)), mat("mmB", (0.2, 0.2, 0.8, 1))
    for name, loc in (("House_Wall", (4.0, 3.0, 1.2)), ("Trunk_01", (-6.0, 2.0, 1.0)), ("Trunk_02", (6.0, -8.0, 1.0))):
        bm = bmesh.new()
        for sx in (-2.0, 2.0):  # two separate boxes in one object, one material each: the sub-bounds differ from the whole object's
            r = bmesh.ops.create_cube(bm, size=1.0)
            bmesh.ops.scale(bm, vec=Vector((1.2, 0.3, 2.4)), verts=r["verts"])
            bmesh.ops.translate(bm, vec=Vector((sx, 0, 0)), verts=r["verts"])
        bm.faces.ensure_lookup_table()
        for f in bm.faces:
            f.material_index = 1 if f.calc_center_median().x > 0 else 0
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(A)
        me.materials.append(B)
        o = bpy.data.objects.new(name, me)
        scn.collection.objects.link(o)
        o.location = loc
        o.parent = br
    L.finish({"objects": ["House_Wall", "Trunk_01", "Trunk_02"]}, save=True)


L.run(main)
