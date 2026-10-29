"""dev_testring — DEV FIXTURE, not an operator verb: builds a toy kilt (a solidified ring band with hanging tabs and a stud on each) as the object `kilt` and a cylinder `body` to wear it, to test ring/tab verbs on a job of its own."""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import _lib as L  # noqa: E402


def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    bm = bmesh.new()
    R, top, n, seg = 0.12, 0.35, 12, 96
    ring = bmesh.ops.create_cone(bm, cap_ends=False, segments=seg, radius1=R, radius2=R, depth=0.04)
    bmesh.ops.translate(bm, vec=(0, 0, top - 0.02), verts=ring["verts"])
    bm.verts.ensure_lookup_table()
    low = sorted([v for v in bm.verts if v.co.z < top - 0.03], key=lambda v: math.atan2(v.co.y, v.co.x))
    per = seg // n
    sel = []
    for i in range(n):  # 4 of every 8 bottom edges (an arc) become a tab
        arc = set(low[i * per: i * per + per // 2 + 1])
        sel += [e for e in bm.edges if e.verts[0] in arc and e.verts[1] in arc and all(v.co.z < top - 0.03 for v in e.verts)]
    ext = bmesh.ops.extrude_edge_only(bm, edges=list(set(sel)))
    nv = [x for x in ext["geom"] if isinstance(x, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, 0, -0.09), verts=nv)
    for i in range(n):  # a stud in front of each tab (a loose piece)
        a = -math.pi + 2 * math.pi * (i * per + per // 4) / seg
        s = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=0.006)
        bmesh.ops.translate(bm, vec=(0, R + 0.008, top - 0.085), verts=s["verts"])
        bmesh.ops.rotate(bm, verts=s["verts"], cent=(0, 0, 0), matrix=__import__("mathutils").Matrix.Rotation(a - math.pi / 2, 3, "Z"))
    me = bpy.data.meshes.new("kilt")
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("kilt", me)
    bpy.context.scene.collection.objects.link(o)
    L.activate(o)
    m = o.modifiers.new("solid", "SOLIDIFY")
    m.thickness, m.offset = 0.004, 0
    bpy.ops.object.modifier_apply(modifier=m.name)
    # a host to conform to: a body-like cylinder a little wider than the ring (outward normals)
    hb = bmesh.new()
    bmesh.ops.create_cone(hb, cap_ends=True, segments=96, radius1=0.126, radius2=0.126, depth=0.3)
    bmesh.ops.translate(hb, vec=(0, 0, 0.25), verts=hb.verts)
    hm = bpy.data.meshes.new("body")
    hb.to_mesh(hm)
    hb.free()
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("body", hm))
    # an open, thin shell with its normals pointing INWARD: a garment layer whose normals can't be trusted
    sb = bmesh.new()
    bmesh.ops.create_cone(sb, cap_ends=False, segments=96, radius1=0.125, radius2=0.125, depth=0.3)
    bmesh.ops.translate(sb, vec=(0, 0, 0.25), verts=sb.verts)
    bmesh.ops.reverse_faces(sb, faces=sb.faces[:])
    sm = bpy.data.meshes.new("shell")
    sb.to_mesh(sm)
    sb.free()
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("shell", sm))
    L.finish({"object": "kilt", "tris": len(me.polygons)}, save=True)


L.run(main)
