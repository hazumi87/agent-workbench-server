"""dev_jigtest — DEV FIXTURE, not an operator verb: builds three toy parts with a blue jig painted in their albedo, to test jig_find: `disc_part` (a cylinder whose top cap is blue), `ellipse_part` (the same, stretched), `stump_part` (a cylinder with a blue stump on top). params: blue [r, g, b] 0-255 (default [40, 120, 245])."""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402

N = 512


def make(name, kind, offset):
    bm = bmesh.new()
    head_blue = set()
    bm.loops.layers.uv.verify()
    if kind == "head":
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=True, segments=32, radius1=0.09, radius2=0.12, depth=0.2, calc_uvs=True)
        bm.faces.ensure_lookup_table()
        head_blue = {f.index for f in bm.faces if f.normal.z < -0.9}
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=__import__("mathutils").Matrix.Rotation(math.radians(25), 3, "X"), verts=bm.verts)
    else:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=True, segments=32, radius1=0.15, radius2=0.15, depth=0.4, calc_uvs=True)
    if kind == "stump":
        r = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=True, segments=24, radius1=0.04, radius2=0.04, depth=0.04, calc_uvs=True)
        bmesh.ops.translate(bm, vec=(0, 0, 0.22), verts=r["verts"])
    if kind == "ellipse":
        bmesh.ops.scale(bm, vec=(1.6, 1.0, 1.0), verts=bm.verts)
    uvl = bm.loops.layers.uv.verify()
    img = np.full((N, N, 4), 0.55, np.float32)
    img[..., 3] = 1.0
    blue = np.array([40, 120, 245]) / 255.0
    bm.faces.ensure_lookup_table()
    G = int(math.ceil(math.sqrt(len(bm.faces))))
    cell = 1.0 / G
    for f in bm.faces:
        # every face gets its own cell of the sheet (a toy UV layout without overlaps)
        k = f.index
        ci, cj = k % G, k // G
        n = f.normal
        t = (f.verts[1].co - f.verts[0].co).normalized()
        bvec = n.cross(t)
        loc = [((v.co - f.verts[0].co).dot(t), (v.co - f.verts[0].co).dot(bvec)) for v in f.verts]
        xs, ys = [q[0] for q in loc], [q[1] for q in loc]
        sc = max(max(xs) - min(xs), max(ys) - min(ys), 1e-9)
        for lp, q in zip(f.loops, loc):
            lp[uvl].uv = ((ci + 0.1 + 0.8 * (q[0] - min(xs)) / sc) * cell, (cj + 0.1 + 0.8 * (q[1] - min(ys)) / sc) * cell)
    for f in bm.faces:
        c = f.calc_center_median()
        hit = False
        if kind in ("disc", "ellipse") and f.normal.z > 0.9 and c.z > 0.19:
            hit = True
        if kind == "head" and f.index in head_blue:
            hit = True
        if kind == "stump" and c.z > 0.2 and abs(c.x) < 0.045 and abs(c.y) < 0.045:
            hit = True
        if hit:
            uv = [lp[uvl].uv for lp in f.loops]
            for i in range(1, len(uv) - 1):
                a, b, cc = np.array(uv[0]) * N, np.array(uv[i]) * N, np.array(uv[i + 1]) * N
                x0, x1 = int(max(0, min(a[0], b[0], cc[0]))), int(min(N - 1, max(a[0], b[0], cc[0])))
                y0, y1 = int(max(0, min(a[1], b[1], cc[1]))), int(min(N - 1, max(a[1], b[1], cc[1])))
                for y in range(y0, y1 + 1):
                    for x in range(x0, x1 + 1):
                        p = np.array([x + 0.5, y + 0.5])
                        d = (b[1] - cc[1]) * (a[0] - cc[0]) + (cc[0] - b[0]) * (a[1] - cc[1])
                        if abs(d) < 1e-9:
                            continue
                        l1 = ((b[1] - cc[1]) * (p[0] - cc[0]) + (cc[0] - b[0]) * (p[1] - cc[1])) / d
                        l2 = ((cc[1] - a[1]) * (p[0] - cc[0]) + (a[0] - cc[0]) * (p[1] - cc[1])) / d
                        if l1 >= 0 and l2 >= 0 and 1 - l1 - l2 >= 0:
                            img[y, x, :3] = blue
    bmesh.ops.translate(bm, vec=offset, verts=bm.verts)  # baked into the mesh: the object stays at the identity transform, like a kit2_part part
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    im = bpy.data.images.new(name + "-albedo", N, N, alpha=False)
    im.pixels.foreach_set(img.ravel())
    im.pack()  # a generated image is lost when the checkpoint is saved unless it is packed
    mat = bpy.data.materials.new(name + "-mat")
    mat.use_nodes = True
    b = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    t = mat.node_tree.nodes.new("ShaderNodeTexImage")
    t.image = im
    mat.node_tree.links.new(t.outputs["Color"], b.inputs["Base Color"])
    me.materials.append(mat)
    return ob


def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    make("disc_part", "disc", (0, 0, 0.5))
    make("ellipse_part", "ellipse", (1.0, 0, 0.5))
    make("stump_part", "stump", (2.0, 0, 0.5))
    make("head_part", "head", (4.0, 0.5, 1.0))
    L.finish({"objects": ["disc_part", "ellipse_part", "stump_part", "head_part"]}, save=True)


L.run(main)
