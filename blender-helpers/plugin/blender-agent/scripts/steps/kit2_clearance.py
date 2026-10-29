"""kit2_clearance — how close two parts come to each other (buckler to head, belt to kilt, kilt to body). Read-only: saves nothing.

For each pair, samples the surface of `a` and measures the distance to the surface of `b` (and the other way round), signed: negative =
a point of `a` lies INSIDE `b` (overlap), positive = clear. Reports the smallest gap, where it is, and how much of `a` is inside `b`.

params:
  pairs    list of [a, b] object names (required), e.g. [["buckler_L","body"],["belt","kilt"]]
  samples  surface points per direction (default 3000)
  min_gap_mm  optional: a pair whose smallest signed gap (a to b, or b to a) is below this is listed in `below_min_gap` (e.g. 0 = any overlap)
Returns per pair: a_to_b and b_to_a: min_gap_mm (signed), p5_mm, median_mm, at_mm (the point on the first object where the minimum is, with the
nearest point on the other), inside_pct (share of the sampled points that are inside the other object), deepest_inside_mm.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import _lib as L  # noqa: E402
import kit2_common as K  # noqa: E402


def one_way(src, dst_bvh, n):
    v = K.sample(K.verts(src), n) if len(K.verts(src)) > n else K.verts(src)
    d = K.surf_signed(dst_bvh, v)
    i = int(np.argmin(d))
    loc = dst_bvh.find_nearest(Vector(v[i]))[0]
    inside = d < 0
    return {"min_gap_mm": K.mm(d[i]), "p5_mm": K.mm(np.percentile(d, 5)), "median_mm": K.mm(np.median(d)),
            "at_mm": {"on_first": [K.mm(x) for x in v[i]], "nearest_on_other": [K.mm(x) for x in loc]},
            "inside_pct": round(float(inside.mean() * 100), 1), "deepest_inside_mm": K.mm(-d.min()) if inside.any() else 0.0}


def main():
    pairs = L.param("pairs")
    if not pairs or not all(isinstance(p, list) and len(p) == 2 for p in pairs):
        raise RuntimeError('pairs must be a list of [a, b] object names, e.g. [["belt","kilt"]]')
    n = int(L.param("samples", 3000))
    out = {}
    low = []
    thr = L.param("min_gap_mm")
    for a, b in pairs:
        for nm in (a, b):
            if nm not in bpy.data.objects:
                raise RuntimeError(f"no object named {nm}")
        oa, ob = bpy.data.objects[a], bpy.data.objects[b]
        r = {"a_to_b": one_way(oa, K.bvh_of(ob), n), "b_to_a": one_way(ob, K.bvh_of(oa), n)}
        r["min_gap_mm"] = min(r["a_to_b"]["min_gap_mm"], r["b_to_a"]["min_gap_mm"])
        out[f"{a} | {b}"] = r
        if thr is not None and r["min_gap_mm"] < float(thr):
            low.append(f"{a} | {b}")
    L.finish({"pairs": out, "below_min_gap": low if thr is not None else None}, save=False)


L.run(main)