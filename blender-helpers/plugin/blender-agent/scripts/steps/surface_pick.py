"""surface_pick — find the surface point, the nearest vertex and the UV at a place you point to: a ray from a view direction at given coordinates, or from any point along any direction. Reads only; saves no checkpoint.

For choosing landmarks (an eye corner, the nose tip) without a click: read the coordinates off a kit2_view picture (its shots are orthographic, `centre` and `size` in metres, so a pixel maps to a place) and ask what is there. The vertex ids returned index the SAME
mesh (for the posed copy `body_posed`, the body's own topology at the time pose_fit ran; if you welded or changed the topology afterwards, run pose_fit again first). Positions are millimetres in the mesh's world frame (+X left, +Y back, +Z up).

params:
  mesh    the mesh to pick on (default "body"; use "body_posed" for the posed copy in the reference frame)
  uv      the UV layer reported for the hit (default the active one)
  picks   a list of {"name": "eye_L", then ONE of
            "view": "front" | "back" | "left" | "right", "at_mm": [a, z]    a ray along the view direction: front/back look along Y at x = a; left/right look along X at y = a. A "front" ray runs +Y (from the front, -Y side) and returns the FIRST hit;
                                                                              "last": true returns the last hit instead (the far surface)
            "from_mm": [x, y, z], "dir": [dx, dy, dz]                       any ray}
Returns per pick: hit_mm, distance_mm (along the ray), normal, face, vertex (the nearest vertex of the hit triangle), vertex_mm, vertex_distance_mm, uv ([u, v] of the hit on the layer, v up), or `hit: false`.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import _lib as L  # noqa: E402

VIEW = {"front": ("x", (0, 1, 0)), "back": ("x", (0, -1, 0)), "left": ("y", (-1, 0, 0)), "right": ("y", (1, 0, 0))}  # the coordinate `at_mm[0]` sets, and the ray direction


def main():
    o = bpy.data.objects.get(L.param("mesh", "body"))
    if o is None or o.type != "MESH":
        raise RuntimeError(f"no mesh {L.param('mesh', 'body')}")
    me = o.data
    uvn = L.param("uv") or (me.uv_layers.active.name if me.uv_layers.active else None)
    M = o.matrix_world
    vs = [M @ v.co for v in me.vertices]
    me.calc_loop_triangles()
    tris = me.loop_triangles
    bvh = BVHTree.FromPolygons(vs, [tuple(t.vertices) for t in tris])
    uvd = None
    if uvn and uvn in me.uv_layers:
        uvd = np.empty(len(me.loops) * 2)
        me.uv_layers[uvn].data.foreach_get("uv", uvd)
        uvd = uvd.reshape(-1, 2)
    picks = L.param("picks") or []
    if not picks:
        raise RuntimeError('give picks: [{"name": "eye_L", "view": "front", "at_mm": [x, z]}]')
    out = []
    for p in picks:
        name = p.get("name", f"pick{len(out)}")
        if "view" in p:
            if p["view"] not in VIEW:
                raise RuntimeError(f"{name}: view must be front, back, left or right")
            axis, d = VIEW[p["view"]]
            a, z = float(p["at_mm"][0]) / 1000, float(p["at_mm"][1]) / 1000
            org = Vector((a, 0, z)) if axis == "x" else Vector((0, a, z))
            dirv = Vector(d)
            org = org - dirv * 5.0
        else:
            org = Vector([float(x) / 1000 for x in p["from_mm"]])
            dirv = Vector(p["dir"]).normalized()
        hit = bvh.ray_cast(org, dirv)
        if p.get("last") and hit[0] is not None:
            h = hit
            while True:
                nxt = bvh.ray_cast(h[0] + dirv * 1e-5, dirv)
                if nxt[0] is None:
                    break
                h = nxt
            hit = h
        if hit[0] is None:
            out.append({"name": name, "hit": False})
            continue
        loc, nrm, fi, dist = hit
        t = tris[fi]
        vid = min(t.vertices, key=lambda i: (vs[i] - loc).length)
        r = {"name": name, "hit": True, "hit_mm": [round(c * 1000, 2) for c in loc], "distance_mm": round(dist * 1000, 2), "normal": [round(c, 4) for c in nrm], "face": int(t.polygon_index),
             "vertex": int(vid), "vertex_mm": [round(c * 1000, 2) for c in vs[vid]], "vertex_distance_mm": round((vs[vid] - loc).length * 1000, 2)}
        if uvd is not None:
            a, b, c = (vs[i] for i in t.vertices)
            v0, v1, v2 = b - a, c - a, loc - a
            d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
            den = d00 * d11 - d01 * d01
            if abs(den) > 1e-18:
                w1 = (d11 * d20 - d01 * d21) / den
                w2 = (d00 * d21 - d01 * d20) / den
                u = uvd[t.loops[0]] * (1 - w1 - w2) + uvd[t.loops[1]] * w1 + uvd[t.loops[2]] * w2
                r["uv"] = [round(float(u[0]), 5), round(float(u[1]), 5)]
        out.append(r)
    L.finish({"mesh": o.name, "uv_layer": uvn, "vertices": len(me.vertices), "picks": out})


L.run(main)
