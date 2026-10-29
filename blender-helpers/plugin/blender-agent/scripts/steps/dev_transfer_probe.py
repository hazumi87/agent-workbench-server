"""dev_transfer_probe — DEV TOOL, read-only: weld ONE receiver the way weld_uv_only does and compare polygon by polygon: for the polygons listed in `polygons`, where are the welded polygons that touch their corners? Saves nothing."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import _lib as L  # noqa: E402


def main():
    o = bpy.data.objects[L.param("receiver")]
    weld_m = float(L.param("weld_m", 1e-5))
    me = o.data.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    q = max(weld_m * 4.0, 1e-6)
    groups = {}
    for f in bm.faces:
        groups.setdefault(tuple(sorted((round(v.co.x / q), round(v.co.y / q), round(v.co.z / q)) for v in f.verts)), []).append(f)
    keep_apart = set()
    for g in groups.values():
        for f in g[1:]:
            for v in f.verts:
                keep_apart.add(v)
    nv0, nf0 = len(bm.verts), len(bm.faces)
    bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if v not in keep_apart], dist=weld_m)
    bm.to_mesh(me)
    bm.free()
    a = o.data
    rows = []
    for pi in L.param("polygons"):
        pa = a.polygons[pi]
        corners = [a.vertices[a.loops[la].vertex_index].co.copy() for la in pa.loop_indices]
        touching = []
        for pb in me.polygons:
            vb = [me.vertices[me.loops[lb].vertex_index].co for lb in pb.loop_indices]
            hit = sum(1 for c in corners if min((c - w).length for w in vb) <= 1e-4)
            if hit:
                touching.append({"polygon": pb.index, "corners_hit": hit, "corners": pb.loop_total, "area": round(pb.area, 9), "centre": [round(x, 5) for x in pb.center]})
        rows.append({"polygon": pi, "centre": [round(x, 5) for x in pa.center], "area": round(pa.area, 9), "corners": [[round(x, 5) for x in c] for c in corners], "welded_polygons_touching": touching[:6]})
    L.finish({"vertices": [nv0, len(me.vertices)], "polygons": [nf0, len(me.polygons)], "rows": rows}, save=False)


L.run(main)
