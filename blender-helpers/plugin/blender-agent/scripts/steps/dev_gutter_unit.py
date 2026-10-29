"""dev_gutter_unit — DEV TOOL: synthetic tests of lightmap_bake.gutter_diagnostics. Cases: two charts with a covered-texel distance of 1 / 2 / 4 (rings 2), one chart with a coarse local texel (the diagonal within-chart control) against the legacy rule."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: E402
import _lib as L  # noqa: E402
import lightmap_bake as LB  # noqa: E402


def legacy(chart, pos, ref_m):
    cov = chart >= 0
    viol = np.zeros(cov.shape, bool)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dx or dy:
                shp = np.roll(np.roll(pos, dy, 0), dx, 1)
                shc = np.roll(np.roll(cov, dy, 0), dx, 1)
                viol |= cov & shc & (np.linalg.norm(shp - pos, axis=2) > ref_m * max(abs(dx), abs(dy)) * 1.6 + 1e-9)
    return int(viol.sum())


def grid(n, sp):
    yy, xx = np.mgrid[0:n, 0:n]
    return np.stack([xx * sp, yy * sp, np.zeros_like(xx, float)], axis=2)


def two_charts(dist, dil):
    n = 40
    chart = np.full((n, n), -1, np.int32)
    chart[10:20, 5:15] = 0                     # chart 0: columns 5..14
    chart[10:20, 14 + dist:24 + dist] = 1      # chart 1 starts `dist` columns after chart 0's last covered column
    pos = grid(n, 0.002)
    pos[chart == 1] += np.array([0.5, 0.0, 0.0])   # another surface: far in 3D
    scale = np.full((n, n), 0.002)
    d = LB.gutter_diagnostics(chart, pos, scale, lambda c: {"receiver": f"r{c}", "first_polygon": c}, dil, 0.002)
    return {"distance_between_covered_texels": dist, "rings": dil, "cross_chart_2px": d["gutter_cross_chart_2px"], "nearest": (d["gutter_cross_chart_nearest"][0]["nearest_chebyshev_texels"] if d["gutter_cross_chart_nearest"] else None),
            "padding_overlap_texels": d["gutter_padding_overlap_texels"], "stretch_2px": d["gutter_stretch_2px"], "legacy": legacy(chart, pos, 0.002)}


def main():
    out = {"cases": [two_charts(1, 2), two_charts(2, 2), two_charts(3, 2), two_charts(4, 2), two_charts(4, 1), two_charts(5, 2)]}
    n = 40
    chart = np.full((n, n), -1, np.int32)
    chart[5:30, 5:30] = 0
    pos = grid(n, 0.0024)                    # one chart whose texels are 2.4 mm while the reference (coarsest AVERAGE) is 1.88 mm
    scale = np.full((n, n), 0.0024)
    d = LB.gutter_diagnostics(chart, pos, scale, lambda c: {"receiver": "r", "first_polygon": 0}, 2, 0.00188)
    out["diagonal_control"] = {"legacy": legacy(chart, pos, 0.00188), "cross_chart_2px": d["gutter_cross_chart_2px"], "stretch_2px": d["gutter_stretch_2px"], "padding_overlap_texels": d["gutter_padding_overlap_texels"]}
    pos2 = pos.copy()
    pos2[15:, :, 0] += 0.01                  # the same chart with a real tear (a 10 mm jump) in the middle
    d2 = LB.gutter_diagnostics(chart, pos2, scale, lambda c: {"receiver": "r", "first_polygon": 0}, 2, 0.00188)
    out["tear_control"] = {"legacy": legacy(chart, pos2, 0.00188), "stretch_2px": d2["gutter_stretch_2px"], "example": d2["gutter_stretch_examples"][:1]}
    L.finish(out, save=False)


L.run(main)
