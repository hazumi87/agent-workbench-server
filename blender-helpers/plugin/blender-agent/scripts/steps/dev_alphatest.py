"""dev_alphatest — does the lightmap baker's shadow test honour a material's alpha (card_proxy cut-outs)? DEV TOOL, run on a job copy only.

phase "build": from a checkpoint with a card_proxy card, keep one light (bulb_A-01.light), delete every mesh, add a 6 x 8 m receiver plane `ra_plane` at z 0, a horizontal 2 x 4 m card `ra_card` at z 1.5 with the REAL card material (its image's alpha is the cut-out) and put the light at (0, 0, 4). Next verb: lightmap_bake receivers ["ra_plane"], bulbs ["A-01"] (a real bake).
phase "check": reads the baked EXR, projects every plane texel through the light onto the card, reads the card's alpha there and compares the stored value (relative to the unblocked texels) with 1 - alpha.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402

LIGHT = (0.0, 0.0, 4.0)
ZC = 1.5
CARD = (-1.0, 1.0, -2.0, 2.0)  # x0 x1 y0 y1
PLANE = (-3.0, 3.0, -4.0, 4.0)


def build():
    card = next((o for o in bpy.context.scene.objects if o.type == "MESH" and len(o.data.polygons) == 1 and any(m and m.name.startswith("thuja") for m in o.data.materials)), None)
    if card is None:
        raise RuntimeError("no card_proxy quad found")
    mat = next(m for m in card.data.materials if m)
    uvs = [tuple(l.uv) for l in card.data.uv_layers.active.data]
    u0, v0 = min(u for u, v in uvs), min(v for u, v in uvs)
    u1, v1 = max(u for u, v in uvs), max(v for u, v in uvs)
    light = bpy.data.objects["bulb_A-01.light"]
    wm = light.matrix_world.copy()
    light.parent = None
    light.matrix_world = wm
    light.location = LIGHT
    for o in list(bpy.context.scene.objects):
        if o.type == "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    import bmesh

    def quad(name, b, z, uv):
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        vs = [bm.verts.new((x, y, z)) for x, y in ((b[0], b[2]), (b[1], b[2]), (b[1], b[3]), (b[0], b[3]))]
        f = bm.faces.new(vs)
        lay = bm.loops.layers.uv.new("UVMap")
        for lp, c in zip(f.loops, uv):
            lp[lay].uv = c
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob, me
    quad("ra_plane", PLANE, 0.0, ((0, 0), (1, 0), (1, 1), (0, 1)))
    c, me = quad("ra_card", CARD, ZC, ((u0, v0), (u1, v0), (u1, v1), (u0, v1)))
    me.materials.append(mat)
    L.finish({"card_uv_box": [u0, v0, u1, v1], "material": mat.name, "light": list(light.location)}, save=True)


def check():
    exr = L.resolve(L.param("exr"), what="exr")
    img = bpy.data.images.load(exr)
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    val = px.reshape(H, W, 4)[..., 0]
    pl = bpy.data.objects["ra_plane"]
    uvl = pl.data.uv_layers["LightmapUV"].data
    # plane is two triangles; texel (i, j) centre -> UV -> position by barycentric on the plane's own loops
    me = pl.data
    me.calc_loop_triangles()
    P = np.zeros((H, W, 3))
    have = np.zeros((H, W), bool)
    for t in me.loop_triangles:
        uv = np.array([uvl[l].uv[:] for l in t.loops])
        ps = np.array([me.vertices[me.loops[l].vertex_index].co[:] for l in t.loops])
        ys, xs = np.mgrid[0:H, 0:W]
        x, y = (xs + 0.5) / W, (ys + 0.5) / H
        a, b, c = uv
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d
        w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d
        w3 = 1 - w1 - w2
        m = (w1 >= 0) & (w2 >= 0) & (w3 >= 0) & ~have
        P[m] = w1[m][:, None] * ps[0] + w2[m][:, None] * ps[1] + w3[m][:, None] * ps[2]
        have |= m
    Lp = np.array(LIGHT)
    d = Lp - P
    dist2 = (d ** 2).sum(-1)
    ana = np.maximum(d[..., 2], 0) / np.sqrt(dist2) / np.maximum(dist2, 0.01)  # N.L / d^2 for N = +Z
    t = (Lp[2] - ZC) / np.maximum(Lp[2] - P[..., 2], 1e-9)  # fraction along light -> texel where z = ZC
    cx = Lp[0] + (P[..., 0] - Lp[0]) * t
    cy = Lp[1] + (P[..., 1] - Lp[1]) * t
    inside = (cx >= CARD[0]) & (cx <= CARD[1]) & (cy >= CARD[2]) & (cy <= CARD[3])
    card = bpy.data.objects["ra_card"]
    mat = next(m for m in card.data.materials if m)
    node = next(n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE")
    ci = node.image
    cw, ch = ci.size
    cp = np.empty(cw * ch * 4, dtype=np.float32)
    ci.pixels.foreach_get(cp)
    alpha = cp.reshape(ch, cw, 4)[..., 3]
    ub = L.param("card_uv_box")
    fu = (cx - CARD[0]) / (CARD[1] - CARD[0])
    fv = (cy - CARD[2]) / (CARD[3] - CARD[2])
    uu = ub[0] + fu * (ub[2] - ub[0])
    vv = ub[1] + fv * (ub[3] - ub[1])
    ix = np.clip((uu * cw).astype(int), 0, cw - 1)
    iy = np.clip((vv * ch).astype(int), 0, ch - 1)
    al = alpha[iy, ix]
    ok = have & (dist2 > 0)
    free = ok & ~inside
    ratio = np.where(ok, val / np.maximum(ana, 1e-12), 0)
    c0 = float(np.median(ratio[free]))
    rel = ratio / c0
    sel_hole = ok & inside & (al < 0.02)
    sel_solid = ok & inside & (al > 0.98)
    sel_mid = ok & inside & (al >= 0.02) & (al <= 0.98)

    def stat(m):
        return {"texels": int(m.sum()), "stored_relative_p10_p50_p90": [round(float(np.percentile(rel[m], q)), 3) for q in (10, 50, 90)] if m.any() else None}
    # a rectangle test: if the baker treated the card as a solid occluder, rel would be ~0 for every texel inside the footprint
    rect_like = float(np.median(rel[ok & inside])) if (ok & inside).any() else None
    corr = float(np.corrcoef((1 - al[ok & inside]), (1 - np.clip(rel[ok & inside], 0, 1.5)))[0, 1]) if (ok & inside).sum() > 10 else None
    L.finish({"unblocked_texels": int(free.sum()), "unblocked_calibration_ratio": round(c0, 6), "unblocked_relative_p10_p50_p90": [round(float(np.percentile(rel[free], q)), 3) for q in (10, 50, 90)],
              "through_transparent_card_texel(alpha<0.02)": stat(sel_hole), "behind_opaque_foliage(alpha>0.98)": stat(sel_solid), "behind_partial_alpha": stat(sel_mid),
              "median_relative_in_footprint": rect_like, "correlation_of_shadow_with_alpha": corr}, save=False)


def main():
    if L.param("phase") == "build":
        build()
    else:
        check()


L.run(main)
