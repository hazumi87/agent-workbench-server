"""dev_gutter_attr — DEV TOOL, read-only: attribute lightmap_bake's `gutter_violations_2px` to its cause. Replays the dry-run layout with the SAME settings (give lightmap_bake's settings), then for every violating texel classifies the far neighbour: same chart / another chart of the same receiver / another receiver, and lists the worst charts. Saves nothing."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
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
    cover, pos, nrm, owner, stats, empty_tris = LB.raster(recv, atlas)
    mm = [s["mm_per_texel"] for s in stats]
    tex_m0 = max(mm) / 1000.0
    # chart id per loop
    chart_of = {}
    for ci, it in enumerate(LB.ITEMS):
        for oi, l in it["ls"]:
            chart_of[(oi, l)] = ci
    # chart id per texel: the same inclusive centre rasterisation, last writer wins (as pos does)
    chart = np.full((atlas, atlas), -1, np.int32)
    tri_key = np.full((atlas, atlas), -1, np.int64)
    tri_scale = np.zeros((atlas, atlas))
    tri_nrm = np.zeros((atlas, atlas, 3))
    for oi, o in enumerate(recv):
        me = o.data
        me.calc_loop_triangles()
        uv = me.uv_layers[LB.LM].data
        for t in me.loop_triangles:
            q = [np.array(uv[l].uv) * atlas for l in t.loops]
            den = (q[1][1] - q[2][1]) * (q[0][0] - q[2][0]) + (q[2][0] - q[1][0]) * (q[0][1] - q[2][1])
            if abs(den) < 1e-12:
                continue
            x0, x1 = int(max(0, np.floor(min(c[0] for c in q)))), int(min(atlas - 1, np.ceil(max(c[0] for c in q))))
            y0, y1 = int(max(0, np.floor(min(c[1] for c in q)))), int(min(atlas - 1, np.ceil(max(c[1] for c in q))))
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            w0 = ((q[1][1] - q[2][1]) * (xs - q[2][0]) + (q[2][0] - q[1][0]) * (ys - q[2][1])) / den
            w1 = ((q[2][1] - q[0][1]) * (xs - q[2][0]) + (q[0][0] - q[2][0]) * (ys - q[2][1])) / den
            m = (w0 >= 0) & (w1 >= 0) & ((1 - w0 - w1) >= 0)
            iy, ix = np.nonzero(m)
            chart[iy + y0, ix + x0] = chart_of.get((oi, t.loops[0]), -1)
            p3 = [np.array(o.matrix_world @ me.vertices[v_].co) for v_ in t.vertices]
            a3 = 0.5 * np.linalg.norm(np.cross(p3[1] - p3[0], p3[2] - p3[0]))
            tri_key[iy + y0, ix + x0] = oi * 10_000_000 + t.index
            tri_scale[iy + y0, ix + x0] = (np.sqrt(a3 / (abs(den) / 2.0)) if abs(den) > 1e-12 else 0.0)
            nn = np.cross(p3[1] - p3[0], p3[2] - p3[0])
            tri_nrm[iy + y0, ix + x0] = nn / max(np.linalg.norm(nn), 1e-30)
    covb = cover > 0
    viol = np.zeros(covb.shape, bool)
    cat = {"same_chart": 0, "other_chart_same_receiver": 0, "other_receiver": 0}
    far_pairs = []
    why = {"stretched_triangle": 0, "fold_between_faces": 0, "same_triangle_other": 0}
    fold_angles = []
    examples = []
    by_chart = {}
    ratio_same = []
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if not (dx or dy):
                continue
            shp = np.roll(np.roll(pos, dy, 0), dx, 1)
            shc = np.roll(np.roll(covb, dy, 0), dx, 1)
            sh_chart = np.roll(np.roll(chart, dy, 0), dx, 1)
            sh_own = np.roll(np.roll(owner, dy, 0), dx, 1)
            d3 = np.linalg.norm(shp - pos, axis=2)
            v = covb & shc & (d3 > tex_m0 * max(abs(dx), abs(dy)) * 1.6 + 1e-9)
            viol |= v
            same = v & (sh_chart == chart)
            sh_scale = np.roll(np.roll(tri_scale, dy, 0), dx, 1)
            sh_tri = np.roll(np.roll(tri_key, dy, 0), dx, 1)
            sh_n = np.roll(np.roll(tri_nrm, dy, 0), dx, 1)
            stretched = same & ((tri_scale > 1.6 * tex_m0) | (sh_scale > 1.6 * tex_m0))
            foldp = same & ~stretched & (sh_tri != tri_key)
            why["stretched_triangle"] += int(stretched.sum())
            why["fold_between_faces"] += int(foldp.sum())
            why["same_triangle_other"] += int((same & ~stretched & (sh_tri == tri_key)).sum())
            if foldp.any():
                ang = np.degrees(np.arccos(np.clip((tri_nrm[foldp] * sh_n[foldp]).sum(axis=1), -1, 1)))
                fold_angles.extend(ang.tolist())
            if len(examples) < 6 and same.any():
                yy, xx = np.nonzero(same)
                k_ = int(np.argmax(d3[same]))
                examples.append({"texel": [int(xx[k_]), int(yy[k_])], "offset": [dx, dy], "d3_mm": round(float(d3[same][k_]) * 1000, 2), "expected_mm": round(tex_m0 * max(abs(dx), abs(dy)) * 1000, 2),
                                 "local_texel_mm_here": round(float(tri_scale[yy[k_], xx[k_]]) * 1000, 2), "local_texel_mm_there": round(float(sh_scale[yy[k_], xx[k_]]) * 1000, 2), "pos_m": [round(float(c), 4) for c in pos[yy[k_], xx[k_]]],
                                 "normal_angle_deg": round(float(np.degrees(np.arccos(np.clip(float(tri_nrm[yy[k_], xx[k_]] @ sh_n[yy[k_], xx[k_]]), -1, 1)))), 1), "receiver": recv[int(owner[yy[k_], xx[k_]])].name})
            oth = v & (sh_chart != chart) & (sh_own == owner)
            orc = v & (sh_own != owner)
            cat["same_chart"] += int(same.sum())
            cat["other_chart_same_receiver"] += int(oth.sum())
            cat["other_receiver"] += int(orc.sum())
            if same.any():
                ratio_same.append(float((d3[same] / (tex_m0 * max(abs(dx), abs(dy)))).max()))
            for c_, cnt in zip(*np.unique(chart[v], return_counts=True)):
                by_chart[int(c_)] = by_chart.get(int(c_), 0) + int(cnt)
    # an isolated texel pair is counted from both sides and per offset; report distinct violating texels too
    top = sorted(by_chart.items(), key=lambda kv: -kv[1])[:15]
    rows = []
    for c_, cnt in top:
        it = LB.ITEMS[c_]
        oi = it["ls"][0][0]
        us = [recv[o_].data.uv_layers[LB.LM].data[l].uv for o_, l in it["ls"]]
        rows.append({"chart": c_, "receiver": recv[oi].name, "violation_pairs": cnt, "loops": len(it["ls"]),
                     "chart_size_texels": [round((max(u[0] for u in us) - min(u[0] for u in us)) * atlas, 1), round((max(u[1] for u in us) - min(u[1] for u in us)) * atlas, 1)]})
    per_recv = {}
    for oi, o in enumerate(recv):
        per_recv[o.name] = int((viol & (owner == oi)).sum())
    # chart rectangles that come closer than 3 texel centres (a real gutter shortfall): bounding boxes of different charts
    rects = []
    for ci, it in enumerate(LB.ITEMS):
        m = chart == ci
        if m.any():
            ys_, xs_ = np.nonzero(m)
            rects.append((ci, xs_.min(), xs_.max(), ys_.min(), ys_.max()))
    close = 0
    close_examples = []
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            a, b = rects[i], rects[j]
            gx = max(a[1] - b[2], b[1] - a[2]) - 1
            gy = max(a[3] - b[4], b[3] - a[4]) - 1
            gap = max(gx, gy)
            if gap < 2:
                close += 1
                if len(close_examples) < 8:
                    close_examples.append({"charts": [a[0], b[0]], "gap_texels": int(gap)})
    L.finish({"atlas_px": atlas, "margin_px": margin, "charts": len(LB.ITEMS), "violating_texels": int(viol.sum()), "violating_pairs_by_far_neighbour": cat,
              "violating_texels_by_receiver": per_recv, "worst_charts": rows, "same_chart_max_distance_ratio": round(max(ratio_same), 2) if ratio_same else None,
              "chart_bounding_boxes_closer_than_2_texels": close, "examples": close_examples, "tex_m0": tex_m0, "same_chart_violations_by_cause": why, "fold_normal_angle_deg": {"n": len(fold_angles), "median": round(float(np.median(fold_angles)), 1) if fold_angles else None, "p90": round(float(np.percentile(fold_angles, 90)), 1) if fold_angles else None, "max": round(float(max(fold_angles)), 1) if fold_angles else None}, "worst_examples": examples}, save=False)


L.run(main)
