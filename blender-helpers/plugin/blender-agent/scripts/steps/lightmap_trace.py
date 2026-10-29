"""lightmap_trace — diagnose ONE stored map value without baking: every object a ray from a receiver point to a bulb meets (name, type, shadow flags), the same for a small ring of neighbouring points (shadow-edge test), and the stored values around that texel read from a packed bin. Saves nothing.
params: point [x, y, z] (Blender world), light (object name, e.g. "bulb_A-04.light"), object (the receiver, for its LightmapUV), bin (path), width, height, channel, layer, ring_m (default 0.05)"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402


def hits(scn, dg, org, tgt):
    d = (tgt - org)
    dist = d.length
    dirv = d / dist
    out = []
    o = org + dirv * 1e-4
    left = dist - 1e-4
    for _ in range(60):
        hit, loc, nrm, idx, ob, mw = scn.ray_cast(dg, o, dirv, distance=left)
        if not hit:
            break
        out.append({"object": ob.name, "type": ob.type, "at_m": round((loc - org).length, 3), "visible_shadow": getattr(ob, "visible_shadow", None), "hide_render": ob.hide_render, "hide_viewport": ob.hide_viewport,
                    "material": ob.active_material.name if getattr(ob, "active_material", None) else None})
        step = (loc - o).length + 1e-4
        o = loc + dirv * 1e-4
        left -= step
        if left <= 0:
            break
    return out


def main():
    scn = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    p = Vector(L.param("point"))
    lo = bpy.data.objects[L.param("light")]
    lp = lo.matrix_world.translation
    ring = float(L.param("ring_m", 0.05))
    res = {"light_at": [round(c, 4) for c in lp], "point": list(p), "distance_m": round((lp - p).length, 3)}
    res["ray_hits"] = hits(scn, dg, p + Vector((0, 0, 2e-3)), lp)
    nb = []
    for dx, dy in ((0, 0), (ring, 0), (-ring, 0), (0, ring), (0, -ring), (2 * ring, 0), (-2 * ring, 0), (0, 2 * ring), (0, -2 * ring)):
        q = p + Vector((dx, dy, 2e-3))
        h = hits(scn, dg, q, lp)
        nb.append({"offset_m": [dx, dy], "n_hits": len(h), "objects": sorted({x["object"] for x in h})[:6]})
    res["neighbours"] = nb
    res["non_mesh_objects_with_geometry"] = sorted(o.name for o in scn.objects if o.type in ("CURVE", "SURFACE", "FONT", "META", "VOLUME", "CURVES", "POINTCLOUD", "GPENCIL"))[:20]
    res["objects_hidden_in_viewport_but_render_visible"] = sorted(o.name for o in scn.objects if o.type == "MESH" and o.hide_viewport and not o.hide_render)[:20]
    res["objects_visible_shadow_off"] = sorted(o.name for o in scn.objects if o.type == "MESH" and not o.visible_shadow and not o.hide_render)[:20]
    # the baker's own ray loop, verbatim, from the same point
    caster_names = {o.name for o in scn.objects if o.type == "MESH" and not o.hide_render and o.visible_shadow}
    n0 = Vector((0, 0, 1))
    dvv = lp - p
    d0 = dvv.length
    dir0 = dvv / d0
    org0 = p + n0 * 2e-3
    left0 = d0 - 2e-3
    blocked0 = None
    trace = []
    for _ in range(12):
        hit, loc, hn, idx, ob_, mw_ = scn.ray_cast(dg, org0, dir0, distance=left0)
        if not hit:
            trace.append("miss")
            break
        trace.append([ob_.name, round((loc - org0).length, 4)])
        if ob_.name in caster_names:
            blocked0 = ob_.name
            break
        step0 = (loc - org0).length + 1e-4
        org0 = loc + dir0 * 1e-4
        left0 -= step0
        if left0 <= 0:
            break
    res["baker_style_ray"] = {"blocked_by": blocked0, "trace": trace}
    ob = bpy.data.objects[L.param("object")]
    me = ob.data
    me.calc_loop_triangles()
    uvl = me.uv_layers["LightmapUV"].data
    mw = ob.matrix_world
    best = None
    for t in me.loop_triangles:
        a, b, c = (mw @ me.vertices[v].co for v in t.vertices)
        v0, v1, v2 = b - a, c - a, p - a
        d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-14:
            continue
        bv = (d11 * d20 - d01 * d21) / den
        bw = (d00 * d21 - d01 * d20) / den
        bu = 1 - bv - bw
        n = v0.cross(v1)
        dist = abs(v2.dot(n)) / max(n.length, 1e-14)
        cost = dist if min(bu, bv, bw) >= -1e-3 else 1e9
        if best is None or cost < best[0]:
            u = bu * Vector(uvl[t.loops[0]].uv) + bv * Vector(uvl[t.loops[1]].uv) + bw * Vector(uvl[t.loops[2]].uv)
            best = (cost, u)
    if best and best[0] < 5e-3:
        W, H = int(L.param("width")), int(L.param("height"))
        tx, ty = int(best[1][0] * W), int(best[1][1] * H)  # Blender v up: texel row from the bottom
        data = np.frombuffer(open(L.resolve(L.param("bin")), "rb").read(), dtype="<f2").reshape(int(L.param("layers", 1)), H, W, 4).astype(np.float64)
        ch, ly = int(L.param("channel")), int(L.param("layer", 0))
        rows = []
        for dy in range(-3, 4):
            r = []
            for dx in range(-3, 4):
                x_, y_ = tx + dx, ty + dy
                r.append(round(float(data[ly, H - 1 - y_, x_, ch]), 5) if 0 <= x_ < W and 0 <= y_ < H else None)
            rows.append(r)
        # the texel's own footprint: world positions of its centre, corners and edge midpoints from the LightmapUV (inverse mapping), each ray-tested to the light
        casters = {o.name for o in scn.objects if o.type == "MESH" and not o.hide_render and o.visible_shadow}

        def uv_to_world(u, v):
            for t in me.loop_triangles:
                ua, ub, uc = (Vector(uvl[l].uv) for l in t.loops)
                den = (ub.y - uc.y) * (ua.x - uc.x) + (uc.x - ub.x) * (ua.y - uc.y)
                if abs(den) < 1e-14:
                    continue
                w0 = ((ub.y - uc.y) * (u - uc.x) + (uc.x - ub.x) * (v - uc.y)) / den
                w1 = ((uc.y - ua.y) * (u - uc.x) + (ua.x - uc.x) * (v - uc.y)) / den
                w2 = 1 - w0 - w1
                if min(w0, w1, w2) >= -1e-6:
                    a, b, c = (mw @ me.vertices[k].co for k in t.vertices)
                    return w0 * a + w1 * b + w2 * c, (mw.to_3x3() @ t.normal).normalized()
            return None, None
        foot = []
        for fx in (0.0, 0.5, 1.0):
            for fy in (0.0, 0.5, 1.0):
                wp, wn = uv_to_world((tx + fx) / W, (ty + fy) / H)
                if wp is None:
                    foot.append({"at": [fx, fy], "world": None})
                    continue
                h = hits(scn, dg, wp + wn * 2e-3, lp)
                foot.append({"at": [fx, fy], "world": [round(c, 3) for c in wp], "blocked_by": next((x["object"] for x in h if x["object"] in casters), None)})
        res["texel_footprint_rays"] = foot
        res["texel"] = [tx, ty]
        res["uv_blender"] = [round(best[1][0], 5), round(best[1][1], 5)]
        res["stored_7x7_rows_from_y_minus3"] = rows
        res["expected_here"] = None
    L.finish("probe done", save=False, **res)


L.run(main)
