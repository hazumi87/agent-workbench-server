"""dev_overlap_attr — DEV TOOL, read-only: replay a lightmap_bake dry-run layout with the SAME settings and attribute (a) every texel covered by more than one face: which triangles cover it, their receivers / polygons / charts, where the texel centre lies against each triangle's edges; (b) the nearest cross-chart pairs, with the final-UV chart ids. Saves nothing."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import lightmap_bake as LB  # noqa: E402


def main():
    atlas = int(L.param("atlas_px", 512))
    margin = int(L.param("margin_px", 8))
    recv = LB.pick(L.param("receivers") or [], {"MESH"})
    LB.PACKER[0] = L.param("packer", "shelf")
    LB.TIE_RULE[0] = L.param("tie_rule", "inclusive")
    LB.SPLITOV[0] = bool(L.param("split_uv_overlaps", False))
    LB.SPARSE[:] = [({"objects": r} if isinstance(r, str) else r) for r in (L.param("split_sparse_charts") or [])]
    LB.MINPX[0] = float(L.param("min_chart_px", 0))
    LB.make_uvs(recv, atlas, margin, L.param("density"), float(L.param("angle_limit_deg", 66)), float(L.param("weld_m", 0)), bool(L.param("weld_uv_only", False)))
    fold = LB.collapse_folded_polygons(recv, float(L.param("collapse_folded_polygons"))) if L.param("collapse_folded_polygons") is not None else None
    cover, pos, nrm, owner, stats, empty_tris = LB.raster(recv, atlas)
    chart, scale = LB.chart_maps(recv, atlas)
    ys, xs = np.nonzero(cover > 1)
    rows = []
    for y, x in zip(ys.tolist(), xs.tolist()):
        cx, cy = x + 0.5, y + 0.5
        hits = []
        for oi, o in enumerate(recv):
            me = o.data
            me.calc_loop_triangles()
            uv = me.uv_layers[LB.LM].data
            for t in me.loop_triangles:
                q = [np.array(uv[l].uv) * atlas for l in t.loops]
                if cx < min(c[0] for c in q) - 1 or cx > max(c[0] for c in q) + 1 or cy < min(c[1] for c in q) - 1 or cy > max(c[1] for c in q) + 1:
                    continue
                den = (q[1][1] - q[2][1]) * (q[0][0] - q[2][0]) + (q[2][0] - q[1][0]) * (q[0][1] - q[2][1])
                if abs(den) < 1e-12:
                    continue
                w0 = ((q[1][1] - q[2][1]) * (cx - q[2][0]) + (q[2][0] - q[1][0]) * (cy - q[2][1])) / den
                w1 = ((q[2][1] - q[0][1]) * (cx - q[2][0]) + (q[0][0] - q[2][0]) * (cy - q[2][1])) / den
                w2 = 1 - w0 - w1
                if min(w0, w1, w2) >= -1e-9:
                    mw = o.matrix_world
                    p3 = [mw @ me.vertices[v].co for v in t.vertices]
                    a3 = 0.5 * ((p3[1] - p3[0]).cross(p3[2] - p3[0])).length
                    hits.append({"receiver": o.name, "polygon": int(t.polygon_index), "triangle": int(t.index), "chart": int(LB_chart(chart, oi, t, recv)),
                                 "barycentric": [round(float(w0), 5), round(float(w1), 5), round(float(w2), 5)], "uv_triangle_texels": [[round(float(c[0]), 3), round(float(c[1]), 3)] for c in q],
                                 "area_m2": round(float(a3), 8), "world_m": [round(float(c), 4) for c in (p3[0] * w0 + p3[1] * w1 + p3[2] * w2)],
                                 "normal": [round(float(c), 3) for c in (mw.to_3x3() @ Vector(t.normal)).normalized()]})
        rows.append({"texel": [x, y], "cover": int(cover[y, x]), "triangles_found": len(hits), "hits": hits})
    chart_id, chart_scale = chart, scale
    polys_of = {oi: np.array([p.loop_start for p in o.data.polygons]) for oi, o in enumerate(recv)}

    def info(ci):
        oi, l0 = LB.CHART_FIRST[ci]
        return {"receiver": recv[oi].name, "first_polygon": int(np.searchsorted(polys_of[oi], l0, side="right") - 1)}
    diag = LB.gutter_diagnostics(chart_id, pos, chart_scale, info, int(L.param("dilate_px", 4)), max(s["mm_per_texel"] for s in stats) / 1000.0, max_rows=20)
    L.finish({"atlas_px": atlas, "margin_px": margin, "overlap_texels": int((cover > 1).sum()), "overlap_detail": rows,
              "cross_chart_2px": diag["gutter_cross_chart_2px"], "cross_chart_pairs": diag["gutter_cross_chart_pairs"], "cross_chart_nearest": diag["gutter_cross_chart_nearest"],
              "charts_from_final_uv": len(LB.CHART_FIRST), "folded": fold}, save=False)


def LB_chart(chart, oi, t, recv):
    # chart id of a triangle: read it from the chart map at the triangle's first covered texel is unreliable for tiny triangles; use the corner loop's id through chart_maps' table
    return LB.CHART_OF.get((oi, t.loops[0]), -1)


L.run(main)
