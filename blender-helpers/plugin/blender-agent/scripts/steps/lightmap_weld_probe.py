"""lightmap_weld_probe — MEASURE whether split (unwelded) vertices keep adjacent faces in separate lightmap charts. Changes nothing (saves no checkpoint). Run it on a copy.

For each selected receiver it makes two temporary copies: A as it is, B with vertices welded by POSITION (`weld_m`); both are unwrapped with the same smart-project the baker uses, and the charts are counted. The receiver itself, its UV0 and its mesh are never touched; the copies are deleted.
params:
  receivers  name globs (like lightmap_bake)   [required]
  weld_m     position tolerance (default 0.00001 = 0.01 mm)
  angle_limit_deg  chart angle (default 66)
  tiny_cm2   charts with a 3D area under this are "tiny" (default 4 = 2 x 2 cm)
Returns per receiver: faces, vertices before / after the weld, charts_as_is, charts_welded, and for the welded copy the charts split by 3D area (tiny < tiny_cm2; small to 100 cm2; large) with their area share, and by face direction (up / side / down by the normal's Z); totals; `cause` = the chart count difference (as-is minus welded).
"""
import fnmatch
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import _lib as L  # noqa: E402
import lightmap_bake as LB  # noqa: E402


def dup(o, tag, weld):
    me = o.data.copy()
    me.name = f"wp_{tag}_{o.name}"[:60]
    for u in list(me.uv_layers):
        pass
    ob = bpy.data.objects.new(me.name, me)
    ob.matrix_world = o.matrix_world
    bpy.context.scene.collection.objects.link(ob)
    if weld is not None:
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=weld)
        bm.to_mesh(me)
        bm.free()
    return ob


def charts(objs, ang):
    LB.make_uvs(objs, 8192, 1, None, ang)
    return {i: LB.CHARTS.get(i, 0) for i in range(len(objs))}, [it["ls"] for it in LB.ITEMS]


def main():
    pats = L.param("receivers")
    if not pats:
        raise RuntimeError("receivers: give name globs")
    weld = float(L.param("weld_m", 0.00001))
    ang = float(L.param("angle_limit_deg", 66))
    tiny = float(L.param("tiny_cm2", 4)) / 1e4
    src = []
    for o in sorted(bpy.context.scene.objects, key=lambda x: x.name):
        if o.type == "MESH" and "blender_agent_marker" not in o and any(fnmatch.fnmatchcase(o.name, p) for p in pats):
            src.append(o)
    if not src:
        raise RuntimeError("nothing matches")
    A = [dup(o, "a", None) for o in src]
    B = [dup(o, "b", weld) for o in src]
    ca, _ = charts(A, ang)
    cb, items_b = charts(B, ang)
    rows = []
    tot = {"faces": 0, "charts_as_is": 0, "charts_welded": 0}
    buckets = {"tiny": [0, 0.0], "small": [0, 0.0], "large": [0, 0.0]}
    dirs = {"up": [0, 0.0], "side": [0, 0.0], "down": [0, 0.0]}
    for i, o in enumerate(src):
        rows.append({"object": o.name, "faces": len(o.data.polygons), "vertices": len(o.data.vertices), "vertices_welded": len(B[i].data.vertices),
                     "charts_as_is": ca[i], "charts_welded": cb[i]})
        tot["faces"] += len(o.data.polygons)
        tot["charts_as_is"] += ca[i]
        tot["charts_welded"] += cb[i]
    for ls in items_b:
        oi = ls[0][0]
        me = B[oi].data
        l2p = {}
        for p in me.polygons:
            for li in p.loop_indices:
                l2p[li] = p.index
        polys = {l2p[l] for _, l in ls}
        a = sum(me.polygons[p].area for p in polys)
        a *= (B[oi].matrix_world.to_scale()[0] * B[oi].matrix_world.to_scale()[1]) if False else 1.0
        k = "tiny" if a < tiny else ("small" if a < 0.01 else "large")
        buckets[k][0] += 1
        buckets[k][1] += a
        nz = sum(me.polygons[p].normal.z * me.polygons[p].area for p in polys) / max(a, 1e-12)
        d = "up" if nz > 0.5 else ("down" if nz < -0.5 else "side")
        dirs[d][0] += 1
        dirs[d][1] += a
    tot_area = sum(v[1] for v in buckets.values()) or 1.0
    for ob in A + B:
        me = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(me)
    rows.sort(key=lambda r: -(r["charts_as_is"] - r["charts_welded"]))
    L.finish({"weld_m": weld, "angle_limit_deg": ang, **tot, "cause_charts_removed_by_welding": tot["charts_as_is"] - tot["charts_welded"],
              "welded_charts_by_size": {k: {"charts": v[0], "area_m2": round(v[1], 3), "area_percent": round(100 * v[1] / tot_area, 2)} for k, v in buckets.items()},
              "welded_charts_by_direction": {k: {"charts": v[0], "area_m2": round(v[1], 3)} for k, v in dirs.items()},
              "tiny_cm2": tiny * 1e4}, save=False, per_receiver=rows[:150])


L.run(main)
