"""dev_orientfix — DEV TOOL: fixtures with KNOWN orientation to test face_orient. Objects (expected verdict in the name):
cube_out (outward), cube_in (inward), cube_mix (mixed: 2 faces turned), plane_ds / plane_cull (open_indeterminate; double sided / culled),
mir_out (scale -1 x, mesh outward -> outward, negative_transform), mir_in (scale -1 x, mesh turned -> inward), torus_out, torus_in,
two_pieces (one object, outward cube + inward cube), cube_badnorm (outward faces, custom corner normals pointing inward), sphere_smooth (outward, smooth), split_out / split_in (cube with every edge split: 6 loose quads; closed only with weld_m)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import _lib as L  # noqa: E402

X = [0.0]


def place(ob):
    ob.location.x = X[0]
    X[0] += 3.0
    return ob


def add(name, bm, flip=False, mats=()):
    if flip:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return place(ob)


def cube(size=1.0, off=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=size)
    bmesh.ops.translate(bm, verts=bm.verts[:], vec=off)
    return bm


def main():
    L.drop_factory_objects()
    ds = bpy.data.materials.new("ds")
    ds.use_backface_culling = False
    cu = bpy.data.materials.new("cull")
    cu.use_backface_culling = True
    add("cube_out", cube())
    add("cube_in", cube(), flip=True)
    bm = cube()
    bm.faces.ensure_lookup_table()
    bmesh.ops.reverse_faces(bm, faces=[bm.faces[0], bm.faces[3]])
    add("cube_mix", bm)
    for nm, m in (("plane_ds", ds), ("plane_cull", cu)):
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=3, y_segments=3, size=1.0)
        add(nm, bm, mats=(m,))
    o = add("mir_out", cube())
    o.scale.x = -1
    o = add("mir_in", cube(), flip=True)
    o.scale.x = -1
    for nm, fl in (("torus_out", False), ("torus_in", True)):
        bpy.ops.mesh.primitive_torus_add(major_radius=1.0, minor_radius=0.3, major_segments=24, minor_segments=12)
        t = bpy.context.active_object
        t.name = nm
        if fl:
            bm = bmesh.new()
            bm.from_mesh(t.data)
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
            bm.to_mesh(t.data)
            bm.free()
        place(t)
    a = cube(1.0, (0, 0, 0))
    b = cube(0.5, (0, 0, 2))
    bmesh.ops.reverse_faces(b, faces=b.faces[:])
    mesh = bpy.data.meshes.new("two_pieces")
    bm = bmesh.new()
    for src in (a, b):
        tmp = bpy.data.meshes.new("tmp")
        src.to_mesh(tmp)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
        src.free()
    bm.to_mesh(mesh)
    bm.free()
    ob = bpy.data.objects.new("two_pieces", mesh)
    bpy.context.scene.collection.objects.link(ob)
    place(ob)
    c = add("cube_badnorm", cube())
    me = c.data
    me.normals_split_custom_set([(-l.normal[0], -l.normal[1], -l.normal[2]) for l in me.loops])
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=0.5)
    s = bpy.context.active_object
    s.name = "sphere_smooth"
    for p in s.data.polygons:
        p.use_smooth = True
    place(s)
    for nm, fl in (("split_out", False), ("split_in", True)):
        bm = cube()
        bmesh.ops.split_edges(bm, edges=bm.edges[:])
        add(nm, bm, flip=fl)
    L.finish({"built": [o.name for o in bpy.context.scene.objects]}, save=True)


L.run(main)
